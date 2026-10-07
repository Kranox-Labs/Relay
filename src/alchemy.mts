// The calls of the relay to Alchemy for the privacy scan of an address on Robinhood Chain, and to the metadata service
// of Blockscout for the public names of the addresses around it. config.mts holds the facts that a call of 7 Oct 2026
// checked. Alchemy has no count of the transfers of an address and no internal transfers on this network, so the scan
// counts the transactions that the address sent and the token transfers that it read.
import {
  ALCHEMY_CALLS_PER_SECOND,
  ALCHEMY_URL,
  METADATA_MAX_ADDRESSES,
  METADATA_URL,
  ROBINHOOD_CHAIN_ID,
  SCAN_RECENT_TRANSFERS,
  UPSTREAM_TIMEOUT_MS,
} from "./config.mts";
import { GatewayError } from "./changenow.mts";
import { objectOrNull, stringOrNull, type Json } from "./json.mts";
import { CallLimiter } from "./limiter.mts";
import {
  ScanCache,
  sleepFor,
  takeSlot,
  type ChainHolding,
  type ChainScan,
  type ChainScanner,
  type ChainToken,
  type ChainTransfer,
} from "./scan.mts";

export interface AlchemyOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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
    from: { address: from, label: null, isContract: false },
    to: to === null ? null : { address: to, label: null, isContract: false },
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

  constructor(apiKey: string, { fetchImpl = fetch, now = Date.now, sleep = sleepFor }: AlchemyOptions = {}) {
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#sleep = sleep;
    this.#limiter = new CallLimiter(ALCHEMY_CALLS_PER_SECOND, now);
    this.#cache = new ScanCache(now);
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
      transfers("toAddress", [ETH], "asc", 1),
      transfers("toAddress", [TOKENS], "asc", 1),
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
    };
    return this.#named(scan);
  }

  /**
   * Gives the parties of [scan] the public names that the metadata service of Blockscout knows. Without an answer the
   * scan goes out without names, because the names add to the scan and the rest of it stands.
   */
  async #named(scan: ChainScan): Promise<ChainScan> {
    const all = [scan.firstTransaction, scan.firstTokenTransfer, ...scan.transactions, ...scan.tokenTransfers];
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
      names = await this.#names(addresses);
    } catch {
      return scan;
    }
    const label = (address: string) => names.get(address.toLowerCase()) ?? null;
    const name = (transfer: ChainTransfer): ChainTransfer => ({
      ...transfer,
      from: { ...transfer.from, label: label(transfer.from.address) },
      to: transfer.to === null ? null : { ...transfer.to, label: label(transfer.to.address) },
    });
    return {
      ...scan,
      firstTransaction: scan.firstTransaction && name(scan.firstTransaction),
      firstTokenTransfer: scan.firstTokenTransfer && name(scan.firstTokenTransfer),
      transactions: scan.transactions.map(name),
      tokenTransfers: scan.tokenTransfers.map(name),
    };
  }

  /** The tag of type "name" of each of [addresses] that has one, by the lowercase address. */
  async #names(addresses: string[]): Promise<Map<string, string>> {
    const url = `${METADATA_URL}?addresses=${addresses.join(",")}&chainId=${ROBINHOOD_CHAIN_ID}`;
    const response = await this.#fetch(url, { redirect: "error", signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    if (!response.ok) throw new Error("The metadata service failed.");
    const known = objectOrNull(objectOrNull(await response.json())?.addresses) ?? {};
    const names = new Map<string, string>();
    for (const [address, value] of Object.entries(known)) {
      const tags = objectOrNull(value)?.tags;
      const tag = (Array.isArray(tags) ? tags : [])
        .map((item) => objectOrNull(item))
        .find((item) => item?.tagType === "name" && stringOrNull(item.name) !== null);
      const name = stringOrNull(tag?.name);
      if (name !== null) names.set(address.toLowerCase(), name);
    }
    return names;
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
