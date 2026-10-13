// The calls of the relay to SimpleSwap, the second exchanger of pay, from 12 Oct 2026. CHECKED 12 Oct 2026 with the
// key of Kranox, sources the Postman collection of the API (api.simpleswap.io/docs) and its answers: v3 takes the key
// in the header x-api-key only; XMR is "xmr" on the network "xmr", and ETH and USDG on Robinhood Chain are "eth" and
// "usdg" on the network "robinhood", at a fixed and at a floating rate. /v3/ranges gives the range in XMR as text
// (the top null for a floating rate), /v3/estimates the amount with the id and the time of a fixed rate, and an
// amount outside the range answers 422 "Amount does not fall within the range. Min: …, max: …". An exchange has the
// deposit address in addressFrom, the amount of the coin of origin in amountFrom and again in expectedAmount (the
// deposit that SimpleSwap expects), the coin that arrives in amountTo, an estimate while the exchange waits and the
// fact at the end, and the hashes in txFrom and txTo (CHECKED 13 Oct 2026 on the first real exchange, 0.1 ZEC at a
// floating rate: amountFrom "0.1", expectedAmount "0.1", amountTo "107.647781", status "waiting"; until then the
// relay read expectedAmount as the coin that arrives, R-38 of the scan of that day). The key allows 50 calls in a
// window (the headers x-ratelimit-limit and x-ratelimit-reset, about a minute apart), so the relay keeps the ranges
// for a while and stays under it. The way out, from 13 Oct 2026, is the same pair the other way round at the floating
// rate: CHECKED 13 Oct 2026 with the key, from the network "robinhood" USDG into XMR from 12.52 and into ZEC from
// 28.67, ETH into XMR from 0.0045 and into ZEC from 0.0109; v3 lists no STRK ("Failed to find currency 'strk_strk'").
import {
  SIMPLESWAP_BASE_URL,
  SIMPLESWAP_CALLS_PER_MINUTE,
  SIMPLESWAP_ESTIMATE_CACHE_ENTRIES,
  SIMPLESWAP_ESTIMATE_CACHE_MS,
  SIMPLESWAP_RANGE_CACHE_MS,
  UPSTREAM_TIMEOUT_MS,
} from "./config.mts";
import {
  GatewayError,
  PAY_RATE_NAMES,
  UpstreamError,
  type ChainAsset,
  type CreatedExchange,
  type ExchangeStatus,
  type FromAsset,
  type PairNames,
  type PayEstimate,
  type PayExchanger,
  type PayOutOfRange,
  type PayRange,
  type PayRate,
  type Side,
} from "./exchanger.mts";
import { objectOrNull, stringOrNull, type Json } from "./json.mts";
import { CallLimiter } from "./limiter.mts";

export const SIMPLESWAP_NAME = "SimpleSwap";

/** The coins on Robinhood Chain in the names of v3. */
const CHAIN_SIDES: Record<ChainAsset, Side> = {
  eth: { currency: "eth", network: "robinhood" },
  usdg: { currency: "usdg", network: "robinhood" },
};

const XMR: Side = { currency: "xmr", network: "xmr" };

/**
 * The coins of the private chains that the relay sends through SimpleSwap, in and out: XMR, and ZEC on the network
 * "zec" (CHECKED 13 Oct 2026 with the key: into USDG on Robinhood Chain from 0.0238 ZEC at the floating rate and from
 * 0.0187 to 0.66 at the fixed one). CHECKED 13 Oct 2026: v3 lists no STRK.
 */
const FROM_SIDES: Partial<Record<FromAsset, Side>> = { xmr: XMR, zec: { currency: "zec", network: "zec" } };

/** The side of origin of [from], or a refusal for a coin the relay does not send through SimpleSwap. */
function fromSide(from: FromAsset): Side {
  const side = FROM_SIDES[from];
  if (side === undefined) throw new GatewayError(502, `${SIMPLESWAP_NAME} does not take ${from.toUpperCase()}.`);
  return side;
}

/** The type of an exchange as v3 names it, which is the rate of pay. */
const RATE_TYPES: Record<PayRate, string> = { fixed: "fixed", floating: "floating" };

const MS_PER_MINUTE = 60_000;

/** The states of an exchange at SimpleSwap that the app knows; every one of them is a state of the app as well. */
const KNOWN_STATES = new Set([
  "waiting",
  "confirming",
  "exchanging",
  "sending",
  "finished",
  "failed",
  "refunded",
  "verifying",
  "expired",
]);

/** The range in the text of a refusal, such as "Min: 0.0246948222, max: 1.495551411224" or "max: null". */
const RANGE_TEXT = /min:\s*([\d.]+),\s*max:\s*([\d.]+|null)/i;

/** What a SimpleSwap takes besides its key. The tests pass a fake fetch and a clock of their own. */
export interface SimpleSwapOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function pairQuery(from: FromAsset, asset: ChainAsset, rate: PayRate): Record<string, string> {
  const origin = fromSide(from);
  const to = CHAIN_SIDES[asset];
  return {
    tickerFrom: origin.currency,
    networkFrom: origin.network,
    tickerTo: to.currency,
    networkTo: to.network,
    fixed: String(rate === "fixed"),
  };
}

/** The query of a pair of the way out: a coin on Robinhood Chain into a coin of a private chain, at the floating rate. */
function outQuery(asset: ChainAsset, to: FromAsset): Record<string, string> {
  const from = CHAIN_SIDES[asset];
  const destination = fromSide(to);
  return {
    tickerFrom: from.currency,
    networkFrom: from.network,
    tickerTo: destination.currency,
    networkTo: destination.network,
    fixed: "false",
  };
}

/** A number that v3 writes as text, such as "0.0246892632". */
function requireAmount(data: Json, field: string): number {
  const value = amountOrNull(data[field]);
  if (value === null) throw new GatewayError(502, `${SIMPLESWAP_NAME} answered without the number ${field}.`);
  return value;
}

function amountOrNull(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requireString(data: Json, field: string): string {
  const value = stringOrNull(data[field]);
  if (value === null) throw new GatewayError(502, `${SIMPLESWAP_NAME} answered without the text ${field}.`);
  return value;
}

/** The range of an amount that SimpleSwap refused, from the text of its refusal, with the side the amount fell on. */
function outOfRange(error: UpstreamError, fromAmount: string): PayOutOfRange | null {
  if (error.status !== 422) return null;
  const match = RANGE_TEXT.exec(error.message);
  if (match === null) return null;
  const minFrom = amountOrNull(match[1]);
  const maxFrom = match[2] === "null" ? null : amountOrNull(match[2]);
  if (minFrom === null) return null;
  // The side comes from the facts of the range alone; a refusal whose range holds the amount stays a refusal, with
  // its text (R-07 of the scan of 12 Oct 2026).
  const amount = Number(fromAmount);
  if (amount < minFrom) return { limit: "below", minFrom, maxFrom };
  if (maxFrom !== null && amount > maxFrom) return { limit: "above", minFrom, maxFrom };
  return null;
}

export class SimpleSwap implements PayExchanger {
  readonly name = SIMPLESWAP_NAME;
  // The coins of origin come from the one table of their sides, so that none can be left out of the other (R-34).
  readonly origins: readonly FromAsset[] = Object.keys(FROM_SIDES) as FromAsset[];
  readonly rates: readonly PayRate[] = PAY_RATE_NAMES;
  readonly destinations: readonly FromAsset[] = Object.keys(FROM_SIDES) as FromAsset[];
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #limiter: CallLimiter;
  readonly #ranges = new Map<string, { value: PayRange; at: number }>();
  readonly #estimates = new Map<string, { value: PayEstimate | PayOutOfRange; at: number }>();

  constructor(apiKey: string, { fetchImpl = fetch, now = Date.now }: SimpleSwapOptions = {}) {
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#limiter = new CallLimiter(SIMPLESWAP_CALLS_PER_MINUTE, now, MS_PER_MINUTE);
  }

  /**
   * One range of each coin of origin, which the cache keeps rare, shows that SimpleSwap takes the key of the relay
   * and still lists the coin (R-11 of the scan of 12 Oct 2026, R-34 of 13 Oct 2026).
   */
  async ready(): Promise<void> {
    for (const from of this.origins) await this.payRange(from, "eth", "fixed");
    for (const to of this.destinations) await this.outRange("usdg", to);
  }

  async payRange(from: FromAsset, asset: ChainAsset, rate: PayRate): Promise<PayRange> {
    const key = `${from}:${asset}:${rate}`;
    const kept = this.#ranges.get(key);
    if (kept !== undefined && this.#now() - kept.at < SIMPLESWAP_RANGE_CACHE_MS) return kept.value;
    const data = await this.#call(`/v3/ranges?${new URLSearchParams(pairQuery(from, asset, rate))}`);
    const value = { minFrom: requireAmount(data, "min"), maxFrom: amountOrNull(data.max) };
    this.#ranges.set(key, { value, at: this.#now() });
    return value;
  }

  async payEstimate(
    from: FromAsset,
    asset: ChainAsset,
    rate: PayRate,
    fromAmount: string,
  ): Promise<PayEstimate | PayOutOfRange> {
    // The same quote asked again within a few seconds, as the pages of the app do, costs one call of the budget
    // (R-01 of the scan of 12 Oct 2026). A fixed rate holds for about two minutes, so a quote this young is still good.
    const key = `${from}:${asset}:${rate}:${fromAmount}`;
    const kept = this.#estimates.get(key);
    if (kept !== undefined && this.#now() - kept.at < SIMPLESWAP_ESTIMATE_CACHE_MS) return kept.value;
    const value = await this.#askEstimate(pairQuery(from, asset, rate), rate, fromAmount);
    if (this.#estimates.size >= SIMPLESWAP_ESTIMATE_CACHE_ENTRIES) this.#estimates.clear();
    this.#estimates.set(key, { value, at: this.#now() });
    return value;
  }

  async outRange(asset: ChainAsset, to: FromAsset): Promise<PayRange> {
    const key = `out:${asset}:${to}`;
    const kept = this.#ranges.get(key);
    if (kept !== undefined && this.#now() - kept.at < SIMPLESWAP_RANGE_CACHE_MS) return kept.value;
    const data = await this.#call(`/v3/ranges?${new URLSearchParams(outQuery(asset, to))}`);
    const value = { minFrom: requireAmount(data, "min"), maxFrom: amountOrNull(data.max) };
    this.#ranges.set(key, { value, at: this.#now() });
    return value;
  }

  async outEstimate(asset: ChainAsset, to: FromAsset, fromAmount: string): Promise<PayEstimate | PayOutOfRange> {
    const key = `out:${asset}:${to}:${fromAmount}`;
    const kept = this.#estimates.get(key);
    if (kept !== undefined && this.#now() - kept.at < SIMPLESWAP_ESTIMATE_CACHE_MS) return kept.value;
    const value = await this.#askEstimate(outQuery(asset, to), "floating", fromAmount);
    if (this.#estimates.size >= SIMPLESWAP_ESTIMATE_CACHE_ENTRIES) this.#estimates.clear();
    this.#estimates.set(key, { value, at: this.#now() });
    return value;
  }

  /** One estimate of v3 for the [pair] at [rate], or the range when the amount falls outside it. */
  async #askEstimate(
    pair: Record<string, string>,
    rate: PayRate,
    fromAmount: string,
  ): Promise<PayEstimate | PayOutOfRange> {
    const query = new URLSearchParams({ ...pair, amount: fromAmount });
    let data: Json;
    try {
      data = await this.#call(`/v3/estimates?${query}`);
    } catch (error) {
      const range = error instanceof UpstreamError ? outOfRange(error, fromAmount) : null;
      if (range !== null) return range;
      throw error;
    }
    return {
      amount: requireAmount(data, "estimatedAmount"),
      rateId: rate === "fixed" ? requireString(data, "rateId") : null,
      validUntil: rate === "fixed" ? stringOrNull(data.validUntil) : null,
      // SimpleSwap gives no warning, no fees apart from the rate, and no forecast of the time.
      warning: null,
      depositFee: null,
      withdrawalFee: null,
      speedMinutes: null,
    };
  }

  async createPay(
    from: FromAsset,
    asset: ChainAsset,
    rate: PayRate,
    fromAmount: string,
    address: string,
    refundAddress: string,
    rateId: string | null,
  ): Promise<CreatedExchange> {
    const origin = fromSide(from);
    const to = CHAIN_SIDES[asset];
    const body: Json = {
      tickerFrom: origin.currency,
      networkFrom: origin.network,
      tickerTo: to.currency,
      networkTo: to.network,
      amount: fromAmount,
      addressTo: address,
      fixed: rate === "fixed",
      userRefundAddress: refundAddress,
    };
    if (rateId !== null) body.rateId = rateId;
    return this.#created(await this.#call("/v3/exchanges", { method: "POST", body: JSON.stringify(body) }));
  }

  payNames(from: FromAsset, asset: ChainAsset, rate: PayRate): PairNames {
    return { from: fromSide(from), to: CHAIN_SIDES[asset], flow: RATE_TYPES[rate] };
  }

  async createOut(
    asset: ChainAsset,
    to: FromAsset,
    fromAmount: string,
    address: string,
    refundAddress: string,
  ): Promise<CreatedExchange> {
    const from = CHAIN_SIDES[asset];
    const destination = fromSide(to);
    const body: Json = {
      tickerFrom: from.currency,
      networkFrom: from.network,
      tickerTo: destination.currency,
      networkTo: destination.network,
      amount: fromAmount,
      addressTo: address,
      fixed: false,
      userRefundAddress: refundAddress,
    };
    return this.#created(await this.#call("/v3/exchanges", { method: "POST", body: JSON.stringify(body) }));
  }

  outNames(asset: ChainAsset, to: FromAsset): PairNames {
    return { from: CHAIN_SIDES[asset], to: fromSide(to), flow: RATE_TYPES.floating };
  }

  /** An exchange as v3 answers its creation. */
  #created(data: Json): CreatedExchange {
    // The coin that arrives is amountTo, an estimate while the exchange runs and the fact once it is done; expectedAmount
    // is the deposit that SimpleSwap expects, in the coin of origin (R-38).
    const toAmount = amountOrNull(data.amountTo);
    if (toAmount === null) throw new GatewayError(502, `${SIMPLESWAP_NAME} answered without the amount that arrives.`);
    return {
      id: requireString(data, "id"),
      fromAmount: requireAmount(data, "amountFrom"),
      toAmount,
      payinAddress: requireString(data, "addressFrom"),
      payoutAddress: requireString(data, "addressTo"),
      refundAddress: stringOrNull(data.userRefundAddress),
      // The names of the pair are required here: an answer without them would pass the check of the pair for any pair
      // (R-05 of the scan of 12 Oct 2026).
      fromCurrency: requireString(data, "tickerFrom"),
      fromNetwork: requireString(data, "networkFrom"),
      toCurrency: requireString(data, "tickerTo"),
      toNetwork: requireString(data, "networkTo"),
      flow: requireString(data, "type"),
      validUntil: stringOrNull(data.validUntil),
    };
  }

  async status(id: string): Promise<ExchangeStatus> {
    const data = await this.#call(`/v3/exchanges/${encodeURIComponent(id)}`);
    const status = requireString(data, "status");
    // A state that the app does not know would show as a swap in an unknown state; the relay says so instead.
    if (!KNOWN_STATES.has(status)) throw new GatewayError(502, `${SIMPLESWAP_NAME} answered with an unknown state.`);
    // One field, amountTo, carries the coin that arrives: an estimate until the exchange is done, then the fact (R-38).
    const amountTo = amountOrNull(data.amountTo);
    return {
      status,
      amountTo: status === "finished" ? amountTo : null,
      expectedAmountTo: amountTo,
      payinHash: stringOrNull(data.txFrom),
      payoutHash: stringOrNull(data.txTo),
      refundAddress: stringOrNull(data.userRefundAddress),
      // NOT CHECKED: v3 names no hash and no amount of a refund in its documentation.
      refundHash: null,
      refundAmount: null,
      updatedAt: stringOrNull(data.updatedAt),
      validUntil: stringOrNull(data.validUntil),
    };
  }

  /** One call to v3: the fields of its result, or the error of the answer. */
  async #call(path: string, init: { method?: string; body?: string } = {}): Promise<Json> {
    if (!this.#limiter.take()) throw new GatewayError(503, "The relay is busy. Try again in a moment.");
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${SIMPLESWAP_BASE_URL}${path}`, {
        method: init.method ?? "GET",
        body: init.body,
        headers: { accept: "application/json", "content-type": "application/json", "x-api-key": this.#apiKey },
        // A redirect would carry the key and the body to another host, so the relay follows none.
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      throw new GatewayError(504, `${SIMPLESWAP_NAME} did not answer.`);
    }
    try {
      text = await response.text();
    } catch {
      throw new GatewayError(502, `The answer of ${SIMPLESWAP_NAME} could not be read.`);
    }
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      // A refusal of the gateway in front of SimpleSwap may come as plain text.
    }
    const fields = objectOrNull(data);
    if (!response.ok) {
      const message =
        stringOrNull(fields?.message) ?? stringOrNull(fields?.error) ?? (text.trim() || response.statusText);
      throw new UpstreamError(response.status, message, SIMPLESWAP_NAME, fields);
    }
    const result = objectOrNull(fields?.result);
    if (result === null) throw new GatewayError(502, `${SIMPLESWAP_NAME} answered with something other than a result.`);
    return result;
  }
}

/** Whether [value] is a number as v3 writes it, for the tests of the readers. */
export const readsAmount = amountOrNull;
