// The calls of the relay to Alchemy for the privacy scan of an address on Robinhood Chain, and to the metadata service
// of Blockscout for the public names of the addresses around it. config.mts holds the facts that a call of 7 Oct 2026
// checked. Alchemy has no count of the transfers of an address and no internal transfers on this network, so the scan
// counts the transactions that the address sent and the token transfers that it read, and a reader of the first funding,
// Blockscout, adds the internal transfers to it.
import {
  ALCHEMY_CALLS_PER_SECOND,
  ALCHEMY_URL,
  METADATA_MAX_ADDRESSES,
  SCAN_FUNDING_ROWS,
  SCAN_RECENT_TRANSFERS,
  UPSTREAM_TIMEOUT_MS,
} from "./config.mts";
import { GatewayError } from "./changenow.mts";
import { objectOrNull, stringOrNull, type Json } from "./json.mts";
import { CallLimiter } from "./limiter.mts";
import { readNames } from "./names.mts";
import {
  bringsValue,
  EVM_ADDRESS_PATTERN,
  oldestOf,
  ScanCache,
  settledFunding,
  sleepFor,
  takeSlot,
  type ChainHolding,
  type ChainParty,
  type ChainScan,
  type ChainScanner,
  type ChainToken,
  type ChainTransfer,
  type Funding,
  type FundingReader,
} from "./scan.mts";

export interface AlchemyOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Reads the first funding from every kind of transfer in, since Alchemy cannot read internal transfers here. */
  funding?: FundingReader;
}

/** The two kinds of transfer that Alchemy serves on Robinhood Chain: ETH, and tokens of ERC-20. */
const ETH = "external";
const TOKENS = "erc20";

/** A hex number of JSON-RPC as a decimal string, or null. */
function hexToDecimal(value: unknown): string | null {
  const text = stringOrNull(value);
  if (text === null || !/^0x[0-9a-fA-F]+$/.test(text)) return null;
  return BigInt(text).toString();
}

/** A transfer of alchemy_getAssetTransfers, without names; the scan adds them. */
function transferOf(value: unknown): ChainTransfer | null {
  const item = objectOrNull(value);
  const hash = stringOrNull(item?.hash);
  const from = stringOrNull(item?.from);
  const to = stringOrNull(item?.to);
  const raw = objectOrNull(item?.rawContract);
  const amount = hexToDecimal(raw?.value);
  const time = stringOrNull(objectOrNull(item?.metadata)?.blockTimestamp);
  if (item === null || hash === null || from === null || amount === null || time === null) return null;
  // The parties go on to the metadata service, so a transfer counts only with real addresses (relay O-006 of the
  // second security review).
  if (!EVM_ADDRESS_PATTERN.test(from) || (to !== null && !EVM_ADDRESS_PATTERN.test(to))) return null;
  let token: ChainToken | null = null;
  if (item.category === TOKENS) {
    const contract = stringOrNull(raw?.address);
    const decimals = Number(hexToDecimal(raw?.decimal) ?? NaN);
    if (contract === null || !Number.isInteger(decimals)) return null;
    token = { symbol: stringOrNull(item.asset) ?? "?", address: contract, decimals };
  } else if (item.category !== ETH) {
    return null;
  }
  return {
    hash,
    from: { address: from, label: null, labelSource: null, isContract: false },
    to: to === null ? null : { address: to, label: null, labelSource: null, isContract: false },
    value: amount,
    token,
    time,
  };
}

function newestFirst(a: ChainTransfer, b: ChainTransfer): number {
  return Date.parse(b.time) - Date.parse(a.time);
}

/** The transfers once each, by their hash and their token, the newest first, at most [SCAN_RECENT_TRANSFERS]. */
function merged(...lists: ChainTransfer[][]): ChainTransfer[] {
  const seen = new Set<string>();
  return lists
    .flat()
    .filter((transfer) => seen.add(`${transfer.hash.toLowerCase()}/${transfer.token?.address.toLowerCase()}`))
    .sort(newestFirst)
    .slice(0, SCAN_RECENT_TRANSFERS);
}

export class Alchemy implements ChainScanner {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #limiter: CallLimiter;
  readonly #cache: ScanCache;
  readonly #funding: FundingReader | null;

  constructor(apiKey: string, { fetchImpl = fetch, now = Date.now, sleep = sleepFor, funding }: AlchemyOptions = {}) {
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#sleep = sleep;
    this.#limiter = new CallLimiter(ALCHEMY_CALLS_PER_SECOND, now);
    this.#cache = new ScanCache(now);
    this.#funding = funding ?? null;
  }

  /** The public history of [address]. A second scan within the time of the cache spends no call. */
  async scan(address: string): Promise<ChainScan> {
    const cached = this.#cache.get(address);
    if (cached !== null) return cached;
    const scan = await this.#read(address);
    this.#cache.set(address, scan);
    return scan;
  }

  async #read(address: string): Promise<ChainScan> {
    const transfers = (side: "fromAddress" | "toAddress", category: string[], order: "asc" | "desc", count: number) =>
      this.#call("alchemy_getAssetTransfers", [
        {
          fromBlock: "0x0",
          toBlock: "latest",
          [side]: address,
          category,
          order,
          maxCount: `0x${count.toString(16)}`,
          withMetadata: true,
          excludeZeroValue: false,
        },
      ]).then((result) =>
        (Array.isArray(objectOrNull(result)?.transfers) ? (objectOrNull(result)?.transfers as unknown[]) : [])
          .map(transferOf)
          .filter((item): item is ChainTransfer => item !== null),
      );
    const [balance, code, sent, firstEth, firstToken, outgoing, incoming, balances] = await Promise.all([
      this.#call("eth_getBalance", [address, "latest"]),
      this.#call("eth_getCode", [address, "latest"]),
      this.#call("eth_getTransactionCount", [address, "latest"]),
      transfers("toAddress", [ETH], "asc", SCAN_FUNDING_ROWS),
      transfers("toAddress", [TOKENS], "asc", SCAN_FUNDING_ROWS),
      transfers("fromAddress", [ETH, TOKENS], "desc", SCAN_RECENT_TRANSFERS),
      transfers("toAddress", [ETH, TOKENS], "desc", SCAN_RECENT_TRANSFERS),
      this.#call("alchemy_getTokenBalances", [address, "erc20"]),
    ]);
    const isEth = (transfer: ChainTransfer) => transfer.token === null;
    const isToken = (transfer: ChainTransfer) => transfer.token !== null;
    const ethTransfers = merged(outgoing.filter(isEth), incoming.filter(isEth));
    const tokenTransfers = merged(outgoing.filter(isToken), incoming.filter(isToken));
    // Alchemy names a token in its transfers only, so a holding takes the symbol of a transfer of the same token.
    const tokens = new Map<string, ChainToken>();
    for (const transfer of [...tokenTransfers, ...firstToken]) {
      if (transfer.token !== null) tokens.set(transfer.token.address.toLowerCase(), transfer.token);
    }
    const holdings: ChainHolding[] = [];
    const rows = objectOrNull(balances)?.tokenBalances;
    for (const row of Array.isArray(rows) ? rows : []) {
      const item = objectOrNull(row);
      const token = tokens.get(stringOrNull(item?.contractAddress)?.toLowerCase() ?? "");
      const value = hexToDecimal(item?.tokenBalance);
      if (token !== undefined && value !== null && value !== "0") holdings.push({ token, value });
    }
    // Alchemy reads no internal transfer here, so its first funding stays unsure without a reader that does.
    const known = [...firstEth, ...firstToken].filter((transfer) => bringsValue(transfer, address));
    const unsure: Funding = { transfer: oldestOf(known), sure: false };
    const funding =
      this.#funding === null ? unsure : await this.#funding.funding(address, known).catch((): Funding => unsure);
    const scan: ChainScan = {
      address,
      isContract: (stringOrNull(code) ?? "0x") !== "0x",
      balanceWei: hexToDecimal(balance) ?? "0",
      transactionCount: Number(hexToDecimal(sent) ?? 0),
      tokenTransferCount: tokenTransfers.length,
      firstTransaction: firstEth[0] ?? null,
      firstTokenTransfer: firstToken[0] ?? null,
      transactions: ethTransfers,
      tokenTransfers,
      holdings,
      firstFunding: funding.transfer,
      fundingSure: funding.sure,
    };
    const settled = settledFunding(funding, scan);
    return this.#named({ ...scan, firstFunding: settled.transfer, fundingSure: settled.sure });
  }

  /**
   * Gives the parties of [scan] the public names that the metadata service of Blockscout knows, and keeps a name that
   * a party has already, such as the name of a contract that the reader of the first funding gave. Without an answer
   * the scan goes out without new names, because the names add to the scan and the rest of it stands.
   */
  async #named(scan: ChainScan): Promise<ChainScan> {
    const all = [
      scan.firstTransaction,
      scan.firstTokenTransfer,
      scan.firstFunding,
      ...scan.transactions,
      ...scan.tokenTransfers,
    ];
    const addresses = [
      ...new Set(
        all
          .flatMap((transfer) => [transfer?.from.address, transfer?.to?.address])
          .filter(
            (address): address is string =>
              address !== undefined && address.toLowerCase() !== scan.address.toLowerCase(),
          ),
      ),
    ].slice(0, METADATA_MAX_ADDRESSES);
    if (addresses.length === 0) return scan;
    let names: Map<string, string>;
    try {
      names = await readNames(this.#fetch, addresses);
    } catch {
      return scan;
    }
    // A name of the metadata service is a tag of type name.
    const named = (party: ChainParty): ChainParty => {
      const tag = names.get(party.address.toLowerCase());
      return tag === undefined ? party : { ...party, label: tag, labelSource: "tag" };
    };
    const name = (transfer: ChainTransfer): ChainTransfer => ({
      ...transfer,
      from: named(transfer.from),
      to: transfer.to === null ? null : named(transfer.to),
    });
    return {
      ...scan,
      firstTransaction: scan.firstTransaction && name(scan.firstTransaction),
      firstTokenTransfer: scan.firstTokenTransfer && name(scan.firstTokenTransfer),
      firstFunding: scan.firstFunding && name(scan.firstFunding),
      transactions: scan.transactions.map(name),
      tokenTransfers: scan.tokenTransfers.map(name),
    };
  }

  async #call(method: string, params: unknown[]): Promise<unknown> {
    await takeSlot(this.#limiter, ALCHEMY_CALLS_PER_SECOND, this.#now, this.#sleep);
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(ALCHEMY_URL, {
        method: "POST",
        // The key goes in a header, so that it never stands in a URL.
        headers: { "content-type": "application/json", authorization: `Bearer ${this.#apiKey}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        // A redirect would carry the key to another host, so the relay follows none.
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      throw new GatewayError(504, "Alchemy did not answer.");
    }
    try {
      text = await response.text();
    } catch {
      throw new GatewayError(502, "The answer of Alchemy could not be read.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new GatewayError(502, "The relay cannot use Alchemy right now.");
    }
    if (response.status === 429) throw new GatewayError(503, "Alchemy is busy. Try again in a minute.");
    if (!response.ok) throw new GatewayError(502, "Alchemy failed.");
    let data: Json | null;
    try {
      data = objectOrNull(JSON.parse(text));
    } catch {
      throw new GatewayError(502, "Alchemy answered with something other than JSON.");
    }
    if (data === null || data.error !== undefined || !("result" in data))
      throw new GatewayError(502, "Alchemy failed.");
    return data.result;
  }
}
