// The scan of an address on Robinhood Chain: what the app gets, whatever source the relay reads, and the parts that
// every source shares, the cache of scans and the wait for a slot of the budget of calls.
import { GatewayError } from "./changenow.mts";
import { SCAN_CACHE_ENTRIES, SCAN_CACHE_MS, SCAN_SLOT_WAIT_MS, SCAN_SOURCE_PAUSE_MS } from "./config.mts";
import type { CallLimiter } from "./limiter.mts";

/** An address on Robinhood Chain, an EVM chain: 0x and 40 hex digits. */
export const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/**
 * Where the public name of an address comes from: a tag of the explorer or of its metadata service, such as the hot
 * wallet of an exchange; the name of a verified contract, which says what its code does, not who calls it; or a
 * domain, which the owner of the address chose and nobody checked. The app words each one in its own way (the
 * sharp-edges scan of 10 Oct 2026).
 */
export type LabelSource = "tag" | "contract" | "domain";

/** One side of a transfer, with the public name of the address, if any, and where that name comes from. */
export interface ChainParty {
  address: string;
  label: string | null;
  labelSource: LabelSource | null;
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
  /**
   * The oldest transfer of value into the address that the relay found: of ETH, of ETH that a contract sent (an
   * internal transfer), or of a token, with the public name of its sender and whether that sender is a contract. Null
   * when it found none. From 10 Oct 2026: the oldest transaction and token transfer above may go out, and miss the
   * internal transfers, so the app reads the first funding from here.
   */
  firstFunding: ChainTransfer | null;
  /**
   * Whether the relay read every kind of transfer in and the name of the sender of [firstFunding]. A source that cannot
   * read internal transfers, or a call that failed, leaves it unsure. The explorer of Robinhood Chain still misses some
   * internal transfers everywhere, which the app tells the user.
   */
  fundingSure: boolean;
}

export interface ChainScanner {
  scan(address: string): Promise<ChainScan>;
}

/** The oldest transfer of value into an address that a reader found, and whether it read every kind of transfer in. */
export interface Funding {
  transfer: ChainTransfer | null;
  sure: boolean;
}

/**
 * Reads the first funding of an address from every kind of transfer in, so that the scan of a source that cannot read
 * them all, such as Alchemy without internal transfers, can rely on it. [known] holds transfers in that the source of
 * the scan found already.
 */
export interface FundingReader {
  funding(address: string, known: ChainTransfer[]): Promise<Funding>;
}

/** Whether [transfer] brought something of value into [address]: a transfer of nothing, such as a fake, funds nothing. */
export function bringsValue(transfer: ChainTransfer, address: string): boolean {
  return (
    transfer.to !== null &&
    transfer.to.address.toLowerCase() === address.toLowerCase() &&
    /^[0-9]+$/.test(transfer.value) &&
    BigInt(transfer.value) > 0n
  );
}

/** The oldest of [transfers], or null without any. A transfer without a time that reads is no candidate. */
export function oldestOf(transfers: ChainTransfer[]): ChainTransfer | null {
  let oldest: ChainTransfer | null = null;
  for (const transfer of transfers) {
    const time = Date.parse(transfer.time);
    if (!Number.isFinite(time)) continue;
    if (oldest === null || time < Date.parse(oldest.time)) oldest = transfer;
  }
  return oldest;
}

/**
 * [funding] as far as a scan may claim it. No transfer in that the relay found is sure only for an address that shows
 * nothing: one that holds coins or sent anything got something in first, which the explorer then missed, as it still
 * misses some internal transfers (the sharp-edges scan of 10 Oct 2026).
 */
export function settledFunding(
  funding: Funding,
  scan: Pick<ChainScan, "balanceWei" | "transactionCount" | "tokenTransferCount" | "holdings">,
): Funding {
  if (funding.transfer !== null || !funding.sure) return funding;
  const balance = /^[0-9]+$/.test(scan.balanceWei) ? BigInt(scan.balanceWei) : 0n;
  const shows = balance > 0n || scan.transactionCount > 0 || scan.tokenTransferCount > 0 || scan.holdings.length > 0;
  return shows ? { transfer: null, sure: false } : funding;
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
