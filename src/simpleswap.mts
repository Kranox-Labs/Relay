// The calls of the relay to SimpleSwap, the second exchanger of pay, from 12 Oct 2026. CHECKED 12 Oct 2026 with the
// key of Kranox, sources the Postman collection of the API (api.simpleswap.io/docs) and its answers: v3 takes the key
// in the header x-api-key only; XMR is "xmr" on the network "xmr", and ETH and USDG on Robinhood Chain are "eth" and
// "usdg" on the network "robinhood", at a fixed and at a floating rate. /v3/ranges gives the range in XMR as text
// (the top null for a floating rate), /v3/estimates the amount with the id and the time of a fixed rate, and an
// amount outside the range answers 422 "Amount does not fall within the range. Min: …, max: …". An exchange has the
// deposit address in addressFrom, the amount of XMR in amountFrom, the coin in expectedAmount at first and amountTo
// at the end, and the hashes in txFrom and txTo. The key allows 50 calls in a window (the headers x-ratelimit-limit
// and x-ratelimit-reset, about a minute apart), so the relay keeps the ranges for a while and stays under it.
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
  UpstreamError,
  type ChainAsset,
  type CreatedExchange,
  type ExchangeStatus,
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

function pairQuery(asset: ChainAsset, rate: PayRate): Record<string, string> {
  const to = CHAIN_SIDES[asset];
  return {
    tickerFrom: XMR.currency,
    networkFrom: XMR.network,
    tickerTo: to.currency,
    networkTo: to.network,
    fixed: String(rate === "fixed"),
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
function outOfRange(error: UpstreamError, xmrAmount: string): PayOutOfRange | null {
  if (error.status !== 422) return null;
  const match = RANGE_TEXT.exec(error.message);
  if (match === null) return null;
  const minXmr = amountOrNull(match[1]);
  const maxXmr = match[2] === "null" ? null : amountOrNull(match[2]);
  if (minXmr === null) return null;
  // The side comes from the facts of the range alone; a refusal whose range holds the amount stays a refusal, with
  // its text (R-07 of the scan of 12 Oct 2026).
  const amount = Number(xmrAmount);
  if (amount < minXmr) return { limit: "below", minXmr, maxXmr };
  if (maxXmr !== null && amount > maxXmr) return { limit: "above", minXmr, maxXmr };
  return null;
}

export class SimpleSwap implements PayExchanger {
  readonly name = SIMPLESWAP_NAME;
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

  async payRange(asset: ChainAsset, rate: PayRate): Promise<PayRange> {
    const key = `${asset}:${rate}`;
    const kept = this.#ranges.get(key);
    if (kept !== undefined && this.#now() - kept.at < SIMPLESWAP_RANGE_CACHE_MS) return kept.value;
    const data = await this.#call(`/v3/ranges?${new URLSearchParams(pairQuery(asset, rate))}`);
    const value = { minXmr: requireAmount(data, "min"), maxXmr: amountOrNull(data.max) };
    this.#ranges.set(key, { value, at: this.#now() });
    return value;
  }

  async payEstimate(asset: ChainAsset, rate: PayRate, xmrAmount: string): Promise<PayEstimate | PayOutOfRange> {
    // The same quote asked again within a few seconds, as the pages of the app do, costs one call of the budget
    // (R-01 of the scan of 12 Oct 2026). A fixed rate holds for about two minutes, so a quote this young is still good.
    const key = `${asset}:${rate}:${xmrAmount}`;
    const kept = this.#estimates.get(key);
    if (kept !== undefined && this.#now() - kept.at < SIMPLESWAP_ESTIMATE_CACHE_MS) return kept.value;
    const value = await this.#askEstimate(asset, rate, xmrAmount);
    if (this.#estimates.size >= SIMPLESWAP_ESTIMATE_CACHE_ENTRIES) this.#estimates.clear();
    this.#estimates.set(key, { value, at: this.#now() });
    return value;
  }

  async #askEstimate(asset: ChainAsset, rate: PayRate, xmrAmount: string): Promise<PayEstimate | PayOutOfRange> {
    const query = new URLSearchParams({ ...pairQuery(asset, rate), amount: xmrAmount });
    let data: Json;
    try {
      data = await this.#call(`/v3/estimates?${query}`);
    } catch (error) {
      const range = error instanceof UpstreamError ? outOfRange(error, xmrAmount) : null;
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
    asset: ChainAsset,
    rate: PayRate,
    xmrAmount: string,
    address: string,
    refundAddress: string,
    rateId: string | null,
  ): Promise<CreatedExchange> {
    const to = CHAIN_SIDES[asset];
    const body: Json = {
      tickerFrom: XMR.currency,
      networkFrom: XMR.network,
      tickerTo: to.currency,
      networkTo: to.network,
      amount: xmrAmount,
      addressTo: address,
      fixed: rate === "fixed",
      userRefundAddress: refundAddress,
    };
    if (rateId !== null) body.rateId = rateId;
    const data = await this.#call("/v3/exchanges", { method: "POST", body: JSON.stringify(body) });
    // The coin that arrives is expectedAmount while the exchange runs, and amountTo once it is done.
    const toAmount = amountOrNull(data.expectedAmount) ?? amountOrNull(data.amountTo);
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
    };
  }

  payNames(asset: ChainAsset, rate: PayRate): PairNames {
    return { from: XMR, to: CHAIN_SIDES[asset], flow: RATE_TYPES[rate] };
  }

  async status(id: string): Promise<ExchangeStatus> {
    const data = await this.#call(`/v3/exchanges/${encodeURIComponent(id)}`);
    const status = requireString(data, "status");
    // A state that the app does not know would show as a swap in an unknown state; the relay says so instead.
    if (!KNOWN_STATES.has(status)) throw new GatewayError(502, `${SIMPLESWAP_NAME} answered with an unknown state.`);
    return {
      status,
      amountTo: amountOrNull(data.amountTo),
      expectedAmountTo: amountOrNull(data.expectedAmount),
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
