// The calls of the relay to Blockscout, the explorer of Robinhood Chain, for the privacy scan of an address in the
// app: what the public history of the address shows. CHECKED 7 Oct 2026 on eth.blockscout.com, which runs the same
// software: the shapes of /api/v2/addresses/{hash}, its counters, transactions, token transfers, and tokens, and of the
// actions txlist and tokentx of the API in the style of Etherscan. Blockscout v12.0.0 of 6 Oct 2026 removed the
// parameter limit of the token transfers, so the relay reads the first page of each list, which holds 50 items.
// CHECKED 10 Oct 2026 on the PRO API for Robinhood Chain: the action txlistinternal answers the transfers that
// contracts made, each row with transactionHash in place of hash, and with the status 2 and the message "Some internal
// transactions within this block range have not yet been processed" for every range, old ones too; an address answers
// the name of its verified contract in name, such as "Disperse".
import {
  BLOCKSCOUT_BASE_URL,
  BLOCKSCOUT_CALLS_PER_SECOND,
  BLOCKSCOUT_RETRY_WAIT_MS,
  ROBINHOOD_CHAIN_ID,
  SCAN_FUNDING_ROWS,
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
  type ChainParty,
  type ChainScan,
  type ChainScanner,
  type ChainToken,
  type ChainTransfer,
  type Funding,
  type FundingReader,
} from "./scan.mts";

export interface BlockscoutOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** An address that the explorer has never seen: no transfer in or out. */
function emptyScan(address: string): ChainScan {
  return {
    address,
    isContract: false,
    balanceWei: "0",
    transactionCount: 0,
    tokenTransferCount: 0,
    firstTransaction: null,
    firstTokenTransfer: null,
    transactions: [],
    tokenTransfers: [],
    holdings: [],
    firstFunding: null,
    // The explorer has never seen the address, which says nothing for sure of a transfer that it missed.
    fundingSure: false,
  };
}

/** An answer of the explorer that says that it has no such address. */
class NotFound extends Error {}

/** An answer of the explorer, read before the client decides what it means. */
interface Answer {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

function count(value: unknown): number {
  const number = typeof value === "number" ? value : Number(stringOrNull(value) ?? NaN);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

/**
 * The public name of a party of the explorer and where it comes from: a public tag first, which the explorer keeps,
 * then the name of the explorer, which is the name of the code for a verified contract, then a domain.
 */
function labelOf(party: Json): Pick<ChainParty, "label" | "labelSource"> {
  const tags = Array.isArray(party.public_tags) ? party.public_tags : [];
  const tag = tags.map((item) => objectOrNull(item)).find((item) => item !== null);
  const tagName = stringOrNull(tag?.display_name) ?? stringOrNull(tag?.label);
  if (tagName !== null) return { label: tagName, labelSource: "tag" };
  const name = stringOrNull(party.name);
  if (name !== null) return { label: name, labelSource: party.is_contract === true ? "contract" : "tag" };
  const domain = stringOrNull(party.ens_domain_name);
  if (domain !== null) return { label: domain, labelSource: "domain" };
  return { label: null, labelSource: null };
}

function partyOf(value: unknown): ChainParty | null {
  const party = objectOrNull(value);
  const address = stringOrNull(party?.hash);
  if (party === null || address === null) return null;
  return { address, ...labelOf(party), isContract: party.is_contract === true };
}

function tokenOf(value: unknown): ChainToken | null {
  const token = objectOrNull(value);
  const symbol = stringOrNull(token?.symbol);
  const address = stringOrNull(token?.address_hash) ?? stringOrNull(token?.address);
  const decimals = Number(stringOrNull(token?.decimals) ?? NaN);
  if (symbol === null || address === null || !Number.isInteger(decimals)) return null;
  return { symbol, address, decimals };
}

/** A transaction of the REST API; a contract creation has no recipient. */
function transactionOf(value: unknown): ChainTransfer | null {
  const item = objectOrNull(value);
  const hash = stringOrNull(item?.hash);
  const from = partyOf(item?.from);
  const time = stringOrNull(item?.timestamp);
  if (item === null || hash === null || from === null || time === null) return null;
  return { hash, from, to: partyOf(item.to), value: stringOrNull(item.value) ?? "0", token: null, time };
}

/** A token transfer of the REST API, of an ERC-20 token. */
function tokenTransferOf(value: unknown): ChainTransfer | null {
  const item = objectOrNull(value);
  const hash = stringOrNull(item?.transaction_hash);
  const from = partyOf(item?.from);
  const to = partyOf(item?.to);
  const token = tokenOf(item?.token);
  const amount = stringOrNull(objectOrNull(item?.total)?.value);
  const time = stringOrNull(item?.timestamp);
  if (hash === null || from === null || to === null || token === null || amount === null || time === null) return null;
  return { hash, from, to, value: amount, token, time };
}

/** The rows of an answer in the style of Etherscan, and whether the answer holds every one of them. */
interface Rows {
  rows: ChainTransfer[];
  complete: boolean;
}

/**
 * The rows of an answer in the style of Etherscan, of txlist, txlistinternal, or tokentx, the oldest first, as
 * transfers without names. A failed row moved nothing, so it drops out. The API answers a failure inside a 200, with a
 * text in place of the rows, and a row that does not read may hide a transfer in: either leaves the list incomplete
 * (the sharp-edges scan of 10 Oct 2026).
 */
function etherscanRowsOf(data: Json, withToken: boolean): Rows {
  if (!Array.isArray(data.result)) return { rows: [], complete: false };
  const rows: ChainTransfer[] = [];
  let complete = true;
  for (const value of data.result) {
    if (objectOrNull(value)?.isError === "1") continue;
    const row = etherscanRowOf(value, withToken);
    if (row === null) complete = false;
    else rows.push(row);
  }
  return { rows, complete };
}

/**
 * A row in the style of Etherscan as a transfer without names; an internal row names its transaction transactionHash.
 * Its parties must be addresses, since the sender of a first funding goes into the path of a call with the key.
 */
function etherscanRowOf(value: unknown, withToken: boolean): ChainTransfer | null {
  const row = objectOrNull(value);
  const hash = stringOrNull(row?.hash) ?? stringOrNull(row?.transactionHash);
  const from = stringOrNull(row?.from);
  const seconds = Number(stringOrNull(row?.timeStamp) ?? NaN);
  if (row === null || hash === null || from === null || !Number.isFinite(seconds)) return null;
  if (!EVM_ADDRESS_PATTERN.test(from)) return null;
  // A contract creation names no recipient: an empty text, or none.
  const to = stringOrNull(row.to) || null;
  if (to !== null && !EVM_ADDRESS_PATTERN.test(to)) return null;
  const decimals = Number(stringOrNull(row.tokenDecimal) ?? NaN);
  const symbol = stringOrNull(row.tokenSymbol);
  const contract = stringOrNull(row.contractAddress);
  const token =
    withToken && symbol !== null && contract !== null && Number.isInteger(decimals)
      ? { symbol, address: contract, decimals }
      : null;
  if (withToken && token === null) return null;
  return {
    hash,
    from: { address: from, label: null, labelSource: null, isContract: false },
    to: to === null ? null : { address: to, label: null, labelSource: null, isContract: false },
    value: stringOrNull(row.value) ?? "0",
    token,
    time: new Date(seconds * 1000).toISOString(),
  };
}

function itemsOf(data: Json): unknown[] {
  return Array.isArray(data.items) ? data.items : [];
}

/** Gives the parties of [transfer] the names that the newer lists know, since the API of Etherscan gives none. */
function named(transfer: ChainTransfer | null, labels: Map<string, ChainParty>): ChainTransfer | null {
  if (transfer === null) return null;
  const known = (party: ChainParty) => labels.get(party.address.toLowerCase()) ?? party;
  return { ...transfer, from: known(transfer.from), to: transfer.to === null ? null : known(transfer.to) };
}

/** The path of the oldest rows of [action] for [address], in the style of Etherscan. */
function oldestPath(address: string, action: string): string {
  const query = new URLSearchParams({
    chain_id: String(ROBINHOOD_CHAIN_ID),
    module: "account",
    action,
    address,
    sort: "asc",
    page: "1",
    offset: String(SCAN_FUNDING_ROWS),
  });
  return `/v2/api?${query}`;
}

export class Blockscout implements ChainScanner, FundingReader {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #limiter: CallLimiter;
  readonly #cache: ScanCache;

  constructor(apiKey: string, { fetchImpl = fetch, now = Date.now, sleep = sleepFor }: BlockscoutOptions = {}) {
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#sleep = sleep;
    this.#limiter = new CallLimiter(BLOCKSCOUT_CALLS_PER_SECOND, now);
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
    const rest = `/${ROBINHOOD_CHAIN_ID}/api/v2/addresses/${address}`;
    let info: Json;
    try {
      info = await this.#call(rest);
    } catch (error) {
      if (error instanceof NotFound) return emptyScan(address);
      throw error;
    }
    // Once the explorer knows the address, a missing list is a fault of the explorer.
    const call = (path: string) =>
      this.#call(path).catch((error: unknown) => {
        if (error instanceof NotFound) throw new GatewayError(502, "Blockscout failed.");
        throw error;
      });
    // The seven lists go out at once, each after its slot of the budget, because the explorer takes seconds a call. A
    // failed list of internal transfers leaves the first funding unsure, and the rest of the scan stands.
    const [
      counters,
      transactionPage,
      tokenTransferPage,
      tokenPage,
      oldestTransactions,
      oldestTokenTransfers,
      internal,
    ] = await Promise.all([
      call(`${rest}/counters`),
      call(`${rest}/transactions`),
      call(`${rest}/token-transfers?type=ERC-20`),
      call(`${rest}/tokens?type=ERC-20`),
      call(oldestPath(address, "txlist")),
      call(oldestPath(address, "tokentx")),
      call(oldestPath(address, "txlistinternal")).catch(() => null),
    ]);
    const transactions = itemsOf(transactionPage)
      .map(transactionOf)
      .filter((item): item is ChainTransfer => item !== null);
    const tokenTransfers = itemsOf(tokenTransferPage)
      .map(tokenTransferOf)
      .filter((item): item is ChainTransfer => item !== null);
    const holdings = itemsOf(tokenPage).flatMap((value) => {
      const item = objectOrNull(value);
      const token = tokenOf(item?.token);
      const amount = stringOrNull(item?.value);
      return token === null || amount === null ? [] : [{ token, value: amount }];
    });
    const oldTransactions = etherscanRowsOf(oldestTransactions, false);
    const oldTokenTransfers = etherscanRowsOf(oldestTokenTransfers, true);
    const oldInternal = internal === null ? null : etherscanRowsOf(internal, false);
    const firstTransaction = oldTransactions.rows[0] ?? null;
    const firstTokenTransfer = oldTokenTransfers.rows[0] ?? null;
    const funding = await this.#fundingOf(
      address,
      [...oldTransactions.rows, ...oldTokenTransfers.rows, ...(oldInternal?.rows ?? [])],
      oldTransactions.complete && oldTokenTransfers.complete && oldInternal !== null && oldInternal.complete,
    );
    const labels = new Map<string, ChainParty>();
    for (const transfer of [...transactions, ...tokenTransfers]) {
      for (const party of [transfer.from, transfer.to]) {
        if (party !== null && (party.label !== null || party.isContract))
          labels.set(party.address.toLowerCase(), party);
      }
    }
    const scan = {
      address: stringOrNull(info.hash) ?? address,
      isContract: info.is_contract === true,
      balanceWei: stringOrNull(info.coin_balance) ?? "0",
      // The explorer fills its counters later for a new address, so a count is at least the items that it listed.
      transactionCount: Math.max(count(counters.transactions_count), transactions.length),
      tokenTransferCount: Math.max(count(counters.token_transfers_count), tokenTransfers.length),
      firstTransaction: named(firstTransaction, labels),
      firstTokenTransfer: named(firstTokenTransfer, labels),
      transactions,
      tokenTransfers,
      holdings,
    };
    const settled = settledFunding(funding, scan);
    return { ...scan, firstFunding: settled.transfer, fundingSure: settled.sure };
  }

  /**
   * The first funding of [address] from the oldest transfers of every kind, with [known] transfers in of another
   * source, such as Alchemy, which cannot read internal transfers. A list that fails leaves it unsure.
   */
  async funding(address: string, known: ChainTransfer[]): Promise<Funding> {
    const read = (action: string, withToken: boolean) =>
      this.#call(oldestPath(address, action)).then(
        (data) => etherscanRowsOf(data, withToken),
        () => null,
      );
    const lists = await Promise.all([read("txlist", false), read("tokentx", true), read("txlistinternal", false)]);
    return this.#fundingOf(
      address,
      [...known, ...lists.flatMap((list) => list?.rows ?? [])],
      lists.every((list) => list !== null && list.complete),
    );
  }

  /**
   * The oldest of [transfers] that brought something of value into [address], with the public name of its sender;
   * sure when every list was [complete] and both names answered.
   */
  async #fundingOf(address: string, transfers: ChainTransfer[], complete: boolean): Promise<Funding> {
    const first = oldestOf(transfers.filter((transfer) => bringsValue(transfer, address)));
    if (first === null) return { transfer: null, sure: complete };
    const sender = await this.#sender(first.from);
    return { transfer: { ...first, from: sender.party }, sure: complete && sender.sure };
  }

  /**
   * [party] with its public name: a tag of type name of the metadata service, such as the hot wallet of an exchange, or
   * else what the explorer names it, such as a verified contract, a domain, or a public tag; and whether it is a
   * contract. Sure when both answered.
   */
  async #sender(party: ChainParty): Promise<{ party: ChainParty; sure: boolean }> {
    const [info, names] = await Promise.all([
      this.#call(`/${ROBINHOOD_CHAIN_ID}/api/v2/addresses/${encodeURIComponent(party.address)}`).then(
        (data) => partyOf(data),
        // An address that the explorer never saw has no name there, and that is an answer.
        (error: unknown) => (error instanceof NotFound ? { ...party, label: null, labelSource: null } : null),
      ),
      readNames(this.#fetch, [party.address]).catch(() => null),
    ]);
    const tag = names?.get(party.address.toLowerCase());
    const { label, labelSource } =
      tag === undefined
        ? { label: info?.label ?? null, labelSource: info?.labelSource ?? null }
        : { label: tag, labelSource: "tag" as const };
    return {
      party: { address: party.address, label, labelSource, isContract: info?.isContract ?? party.isContract },
      sure: info !== null && names !== null,
    };
  }

  /** A call, and one more after the time that the explorer names when it refuses the first one for the rate. */
  async #call(path: string): Promise<Json> {
    const first = await this.#once(path);
    if (first.status !== 429) return this.#fields(first);
    const reset = Number(first.headers.get("x-ratelimit-reset") ?? NaN);
    const wait =
      Number.isFinite(reset) && reset >= 0 ? Math.min(reset, BLOCKSCOUT_RETRY_WAIT_MS) : BLOCKSCOUT_RETRY_WAIT_MS;
    await this.#sleep(wait);
    return this.#fields(await this.#once(path));
  }

  async #once(path: string): Promise<Answer> {
    await takeSlot(this.#limiter, BLOCKSCOUT_CALLS_PER_SECOND, this.#now, this.#sleep);
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${BLOCKSCOUT_BASE_URL}${path}`, {
        // The key goes in a header, so that it never stands in a URL.
        headers: { accept: "application/json", authorization: `Bearer ${this.#apiKey}` },
        // A redirect would carry the key to another host, so the relay follows none.
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      throw new GatewayError(504, "Blockscout did not answer.");
    }
    try {
      text = await response.text();
    } catch {
      throw new GatewayError(502, "The answer of Blockscout could not be read.");
    }
    return { status: response.status, ok: response.ok, headers: response.headers, text };
  }

  /** The fields of an answer, or the failure that it stands for. */
  #fields({ status, ok, text }: Answer): Json {
    if (status === 404) throw new NotFound();
    if (status === 401 || status === 402 || status === 403) {
      throw new GatewayError(502, "The relay cannot use Blockscout right now.");
    }
    if (status === 429) throw new GatewayError(503, "Blockscout is busy. Try again in a minute.");
    if (!ok) throw new GatewayError(502, "Blockscout failed.");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new GatewayError(502, "Blockscout answered with something other than JSON.");
    }
    const fields = objectOrNull(data);
    if (fields === null) throw new GatewayError(502, "Blockscout answered with something other than an object.");
    return fields;
  }
}
