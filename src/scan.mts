// The scan of an address on Robinhood Chain: what the app gets, whatever source the relay reads, and the parts that
// every source shares, the cache of scans and the wait for a slot of the budget of calls.
import { GatewayError } from "./changenow.mts";
import { SCAN_CACHE_ENTRIES, SCAN_CACHE_MS, SCAN_SLOT_WAIT_MS, SCAN_SOURCE_PAUSE_MS } from "./config.mts";
import type { CallLimiter } from "./limiter.mts";

/** One side of a transfer, with the public name of the address, if any. */
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

/**
 * What the public history of an address on Robinhood Chain shows. The lists start with the newest. The counts are at
 * least what the source gives: a source without a full count gives the transfers that it read.
 */
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

/** The newest scans, so that a second look at an address within [SCAN_CACHE_MS] spends no call. */
export class ScanCache {
  readonly #now: () => number;
  readonly #scans = new Map<string, { at: number; scan: ChainScan }>();

  constructor(now: () => number) {
    this.#now = now;
  }

  get(address: string): ChainScan | null {
    const cached = this.#scans.get(address.toLowerCase());
    return cached !== undefined && this.#now() - cached.at < SCAN_CACHE_MS ? cached.scan : null;
  }

  /** Keeps [scan], and forgets the oldest scan past [SCAN_CACHE_ENTRIES]. */
  set(address: string, scan: ChainScan): void {
    const key = address.toLowerCase();
    this.#scans.delete(key);
    this.#scans.set(key, { at: this.#now(), scan });
    if (this.#scans.size > SCAN_CACHE_ENTRIES) {
      const oldest = this.#scans.keys().next().value;
      if (oldest !== undefined) this.#scans.delete(oldest);
    }
  }
}

/**
 * Waits for a slot of [limiter], [callsPerSecond] wide, and answers that the scan is busy when none comes within
 * [SCAN_SLOT_WAIT_MS].
 */
export async function takeSlot(
  limiter: CallLimiter,
  callsPerSecond: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const until = now() + SCAN_SLOT_WAIT_MS;
  const pause = Math.ceil(1000 / callsPerSecond);
  while (!limiter.take()) {
    if (now() >= until) throw new GatewayError(503, "The scan is busy. Try again in a moment.");
    await sleep(pause);
  }
}

/**
 * Several sources of the scan in the order of preference. A source that fails with a [GatewayError], such as a spent
 * budget, a refused key, or no answer, rests for [SCAN_SOURCE_PAUSE_MS], and the scan asks the next one. When every
 * source fails, the last failure reaches the app.
 */
export class FallbackScanner implements ChainScanner {
  readonly #sources: ChainScanner[];
  readonly #now: () => number;
  readonly #restingUntil = new Map<ChainScanner, number>();

  constructor(sources: ChainScanner[], now: () => number = Date.now) {
    if (sources.length === 0) throw new Error("A scanner needs at least one source.");
    this.#sources = sources;
    this.#now = now;
  }

  async scan(address: string): Promise<ChainScan> {
    // A source at rest still answers when every source rests, so that a scan never fails without a call.
    const awake = this.#sources.filter((source) => (this.#restingUntil.get(source) ?? 0) <= this.#now());
    const order = awake.length > 0 ? awake : this.#sources;
    let failure: GatewayError | null = null;
    for (const source of order) {
      try {
        return await source.scan(address);
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        this.#restingUntil.set(source, this.#now() + SCAN_SOURCE_PAUSE_MS);
        failure = error;
      }
    }
    throw failure ?? new GatewayError(502, "The scan failed.");
  }
}

/** A real pause, for the sources outside the tests. */
export const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
