// The calls of the relay to Blockscout, the explorer of Robinhood Chain, for the privacy scan of an address in the
// app: what the public history of the address shows. CHECKED 7 Oct 2026 on eth.blockscout.com, which runs the same
// software: the shapes of /api/v2/addresses/{hash}, its counters, transactions, token transfers, and tokens, and of the
// actions txlist and tokentx of the API in the style of Etherscan. Blockscout v12.0.0 of 6 Oct 2026 removed the
// parameter limit of the token transfers, so the relay reads the first page of each list, which holds 50 items.
import {
  BLOCKSCOUT_BASE_URL,
  BLOCKSCOUT_CALLS_PER_SECOND,
  BLOCKSCOUT_SLOT_WAIT_MS,
  ROBINHOOD_CHAIN_ID,
  SCAN_CACHE_ENTRIES,
  SCAN_CACHE_MS,
  UPSTREAM_TIMEOUT_MS,
} from "./config.mts";
import { GatewayError } from "./changenow.mts";
import { objectOrNull, stringOrNull, type Json } from "./json.mts";
import { CallLimiter } from "./limiter.mts";

/** One side of a transfer, with the name that the explorer gives it, if any. */
export interface ChainParty {
  address: string;
  label: string | null;
  isContract: boolean;
}

/** A coin of Robinhood Chain other than ETH, as ERC-20. */
export interface ChainToken {
  symbol: string;
  address: string;
  decimals: number;
}

/** A transfer of ETH, with [token] null, or of a token. [value] counts the smallest unit of the coin. */
export interface ChainTransfer {
  hash: string;
  from: ChainParty;
  to: ChainParty | null;
  value: string;
  token: ChainToken | null;
  time: string;
}

/** A token that the address holds. */
export interface ChainHolding {
  token: ChainToken;
  value: string;
}

/** What the public history of an address on Robinhood Chain shows. The lists start with the newest. */
export interface ChainScan {
  address: string;
  isContract: boolean;
  balanceWei: string;
  transactionCount: number;
  tokenTransferCount: number;
  firstTransaction: ChainTransfer | null;
  firstTokenTransfer: ChainTransfer | null;
  transactions: ChainTransfer[];
  tokenTransfers: ChainTransfer[];
  holdings: ChainHolding[];
}

export interface ChainScanner {
  scan(address: string): Promise<ChainScan>;
}

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
  };
}

/** An answer of the explorer that says that it has no such address. */
class NotFound extends Error {}

function count(value: unknown): number {
  const number = typeof value === "number" ? value : Number(stringOrNull(value) ?? NaN);
  return Number.isInteger(number) && number >= 0 ? number : 0;
}

function labelOf(party: Json): string | null {
  const tags = Array.isArray(party.public_tags) ? party.public_tags : [];
  const tag = tags.map((item) => objectOrNull(item)).find((item) => item !== null);
  return (
    stringOrNull(party.name) ??
    stringOrNull(party.ens_domain_name) ??
    stringOrNull(tag?.display_name) ??
    stringOrNull(tag?.label) ??
    null
  );
}

function partyOf(value: unknown): ChainParty | null {
  const party = objectOrNull(value);
  const address = stringOrNull(party?.hash);
  if (party === null || address === null) return null;
  return { address, label: labelOf(party), isContract: party.is_contract === true };
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

/** The first row of an answer in the style of Etherscan, of txlist or tokentx, as a transfer without names. */
function etherscanRowOf(data: Json, withToken: boolean): ChainTransfer | null {
  const rows = Array.isArray(data.result) ? data.result : [];
  const row = objectOrNull(rows[0]);
  const hash = stringOrNull(row?.hash);
  const from = stringOrNull(row?.from);
  const seconds = Number(stringOrNull(row?.timeStamp) ?? NaN);
  if (row === null || hash === null || from === null || !Number.isFinite(seconds)) return null;
  const to = stringOrNull(row.to);
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
    from: { address: from, label: null, isContract: false },
    to: to === null ? null : { address: to, label: null, isContract: false },
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

export class Blockscout implements ChainScanner {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #limiter: CallLimiter;
  readonly #cache = new Map<string, { at: number; scan: ChainScan }>();

  constructor(apiKey: string, { fetchImpl = fetch, now = Date.now, sleep }: BlockscoutOptions = {}) {
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#limiter = new CallLimiter(BLOCKSCOUT_CALLS_PER_SECOND, now);
  }

  /** The public history of [address]. A second scan within [SCAN_CACHE_MS] spends no call. */
  async scan(address: string): Promise<ChainScan> {
    const key = address.toLowerCase();
    const cached = this.#cache.get(key);
    if (cached !== undefined && this.#now() - cached.at < SCAN_CACHE_MS) return cached.scan;
    const scan = await this.#read(address);
    this.#cache.delete(key);
    this.#cache.set(key, { at: this.#now(), scan });
    if (this.#cache.size > SCAN_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
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
    const counters = await call(`${rest}/counters`);
    const transactions = itemsOf(await call(`${rest}/transactions`))
      .map(transactionOf)
      .filter((item): item is ChainTransfer => item !== null);
    const tokenTransfers = itemsOf(await call(`${rest}/token-transfers?type=ERC-20`))
      .map(tokenTransferOf)
      .filter((item): item is ChainTransfer => item !== null);
    const holdings = itemsOf(await call(`${rest}/tokens?type=ERC-20`)).flatMap((value) => {
      const item = objectOrNull(value);
      const token = tokenOf(item?.token);
      const amount = stringOrNull(item?.value);
      return token === null || amount === null ? [] : [{ token, value: amount }];
    });
    const oldest = (action: string) =>
      `/v2/api?chain_id=${ROBINHOOD_CHAIN_ID}&module=account&action=${action}&address=${address}&sort=asc&page=1&offset=1`;
    const firstTransaction = etherscanRowOf(await call(oldest("txlist")), false);
    const firstTokenTransfer = etherscanRowOf(await call(oldest("tokentx")), true);
    const labels = new Map<string, ChainParty>();
    for (const transfer of [...transactions, ...tokenTransfers]) {
      for (const party of [transfer.from, transfer.to]) {
        if (party !== null && (party.label !== null || party.isContract))
          labels.set(party.address.toLowerCase(), party);
      }
    }
    return {
      address: stringOrNull(info.hash) ?? address,
      isContract: info.is_contract === true,
      balanceWei: stringOrNull(info.coin_balance) ?? "0",
      transactionCount: count(counters.transactions_count),
      tokenTransferCount: count(counters.token_transfers_count),
      firstTransaction: named(firstTransaction, labels),
      firstTokenTransfer: named(firstTokenTransfer, labels),
      transactions,
      tokenTransfers,
      holdings,
    };
  }

  /** Waits for a slot of the budget of calls, and answers that the relay is busy when none comes in time. */
  async #slot(): Promise<void> {
    const until = this.#now() + BLOCKSCOUT_SLOT_WAIT_MS;
    const pause = Math.ceil(1000 / BLOCKSCOUT_CALLS_PER_SECOND);
    while (!this.#limiter.take()) {
      if (this.#now() >= until) throw new GatewayError(503, "The scan is busy. Try again in a moment.");
      await this.#sleep(pause);
    }
  }

  async #call(path: string): Promise<Json> {
    await this.#slot();
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
    if (response.status === 404) throw new NotFound();
    if (response.status === 401 || response.status === 402 || response.status === 403) {
      throw new GatewayError(502, "The relay cannot use Blockscout right now.");
    }
    if (response.status === 429) throw new GatewayError(503, "Blockscout is busy. Try again in a minute.");
    if (!response.ok) throw new GatewayError(502, "Blockscout failed.");
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
