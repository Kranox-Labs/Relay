// The calls of the relay to ChangeNOW. CHECKED 5 Oct 2026, sources the Postman collection of the API
// (documenter.getpostman.com/view/8180765/SVfTPnM8) and the public currency list: ETH and USDG on Robinhood Chain are
// "ethhood" and "usdghood" in v1, and "eth" and "usdg" on the network "hood" in v2. Receive asks v1 for the minimum
// and the estimate, which take a standard key, and v2 for the exchange. Pay uses v2 only: CHECKED 6 Oct 2026, the key
// of Kranox gets the fixed-rate estimate of the coin that an amount of XMR buys ("direct"), and an amount outside the
// range of the fixed rate answers 400 with that range in XMR. On 6 Oct 2026 the owner asked for the amount of XMR as
// the input of pay; the first take of 5 Oct 2026 asked for the amount that the recipient gets ("reverse"). The same
// day the owner asked to let the user choose the floating rate as well (flow "standard"): CHECKED 6 Oct 2026, its
// minimum is about half of the fixed one, it has no top, it gives no rate id, and below its minimum it answers 400
// "Out of min amount" with the range.
import { CHANGENOW_BASE_URL, MIN_AMOUNT_CACHE_MS, UPSTREAM_CALLS_PER_SECOND, UPSTREAM_TIMEOUT_MS } from "./config.mts";
import { numberOrNull, objectOrNull, stringOrNull, type Json } from "./json.mts";
import { CallLimiter } from "./limiter.mts";

/** The coins on Robinhood Chain that the bridge takes in and pays out, with their names in the two versions of the API. */
export const CHAIN_ASSETS = {
  eth: { legacyTicker: "ethhood", currency: "eth", network: "hood" },
  usdg: { legacyTicker: "usdghood", currency: "usdg", network: "hood" },
} as const;

export type ChainAsset = keyof typeof CHAIN_ASSETS;

const XMR = { legacyTicker: "xmr", currency: "xmr", network: "xmr" } as const;

/** The flow with a floating rate: the amount of XMR follows the market until the deposit arrives. */
const STANDARD_FLOW = "standard";

/** The flow with a fixed rate: the exchanger holds the rate of the estimate, so the recipient gets the exact amount. */
const FIXED_RATE_FLOW = "fixed-rate";

/** The rates of pay that the user chooses from, with the flow of ChangeNOW of each. */
export const PAY_RATES = { fixed: FIXED_RATE_FLOW, floating: STANDARD_FLOW } as const;

export type PayRate = keyof typeof PAY_RATES;

/** An estimate from the amount that goes in. */
const DIRECT_TYPE = "direct";

export interface Estimate {
  amount: number;
  /** Minutes, as "min-max", or null. */
  speedMinutes: string | null;
  warning: string | null;
}

/**
 * The coin that an amount of XMR buys, after the fees of ChangeNOW: the fee of the deposit in XMR and the fee of the
 * payout in the coin. A fixed rate gives the id of the rate and the time until which it holds; a floating rate gives
 * neither, but the minutes that a swap usually takes.
 */
export interface PayEstimate {
  amount: number;
  rateId: string | null;
  validUntil: string | null;
  warning: string | null;
  depositFee: number | null;
  withdrawalFee: number | null;
  speedMinutes: string | null;
}

/** The range of one payment at a rate, in XMR. ChangeNOW gives no top for a floating rate. */
export interface PayRange {
  minXmr: number;
  maxXmr: number | null;
}

/** An amount that the rate does not take: below or above its range, which ChangeNOW gives in XMR. */
export interface PayOutOfRange {
  limit: "below" | "above";
  minXmr: number | null;
  maxXmr: number | null;
}

/**
 * An exchange that ChangeNOW made. The currencies, the networks, and the flow come as ChangeNOW names them, or null
 * when its answer leaves them out (NOT CHECKED: whether every answer of POST /v2/exchange carries them).
 */
export interface CreatedExchange {
  id: string;
  fromAmount: number;
  toAmount: number;
  payinAddress: string;
  payoutAddress: string;
  fromCurrency: string | null;
  fromNetwork: string | null;
  toCurrency: string | null;
  toNetwork: string | null;
  flow: string | null;
}

/** The state of an exchange: only the facts that the app shows. */
export interface ExchangeStatus {
  status: string;
  amountTo: number | null;
  expectedAmountTo: number | null;
  payinHash: string | null;
  payoutHash: string | null;
  refundAddress: string | null;
  refundHash: string | null;
  refundAmount: number | null;
  /** A time in ISO 8601, as ChangeNOW gives it. */
  updatedAt: string | null;
  /** The time until which a fixed rate waits for the deposit; null for a floating rate. */
  validUntil: string | null;
}

/** What the relay needs from ChangeNOW. The tests answer with a fake. */
export interface Exchanger {
  minAmount(asset: ChainAsset): Promise<number>;
  estimate(asset: ChainAsset, amount: string): Promise<Estimate>;
  create(asset: ChainAsset, amount: string, address: string, refundAddress: string | null): Promise<CreatedExchange>;
  /** The range of the XMR of one payment into [asset] at [rate]. */
  payRange(asset: ChainAsset, rate: PayRate): Promise<PayRange>;
  /** The amount of [asset] on Robinhood Chain that [xmrAmount] of XMR buys at [rate]. */
  payEstimate(asset: ChainAsset, rate: PayRate, xmrAmount: string): Promise<PayEstimate | PayOutOfRange>;
  /**
   * An exchange of [xmrAmount] of XMR into [asset] for [address] at [rate]: a fixed rate holds the rate of [rateId],
   * a floating rate takes none.
   */
  createPay(
    asset: ChainAsset,
    rate: PayRate,
    xmrAmount: string,
    address: string,
    refundAddress: string,
    rateId: string | null,
  ): Promise<CreatedExchange>;
  status(id: string): Promise<ExchangeStatus>;
}

/**
 * An answer of ChangeNOW with an error status, such as a refusal of an amount below the minimum. The message is the
 * text of ChangeNOW; the server decides how much of it reaches the app.
 */
export class UpstreamError extends Error {
  readonly status: number;

  /** The fields of the answer, when ChangeNOW answered with an object, such as the range of an amount. */
  readonly details: Json | null;

  constructor(status: number, message: string, details: Json | null = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/**
 * A call to ChangeNOW that gave the relay no usable answer: no answer in time, an answer that it cannot read, an answer
 * that fails a check of the relay, or a call over the budget of the key. The message is the text of the relay.
 */
export class GatewayError extends Error {
  readonly status: 502 | 503 | 504;

  /** The id of the exchange when ChangeNOW made one before a check failed, so that support can find it. */
  readonly exchangeId: string | null;

  constructor(status: 502 | 503 | 504, message: string, exchangeId: string | null = null) {
    super(message);
    this.status = status;
    this.exchangeId = exchangeId;
  }
}

function requireNumber(data: Json, field: string): number {
  const value = numberOrNull(data[field]);
  if (value === null) throw new GatewayError(502, `ChangeNOW answered without the number ${field}.`);
  return value;
}

function requireString(data: Json, field: string): string {
  const value = stringOrNull(data[field]);
  if (value === null) throw new GatewayError(502, `ChangeNOW answered without the text ${field}.`);
  return value;
}

/** The range of an amount that ChangeNOW refused, from the payload of its refusal. */
function outOfRange(error: UpstreamError): PayOutOfRange | null {
  if (error.status !== 400) return null;
  const range = objectOrNull(objectOrNull(error.details?.payload)?.range);
  if (range === null) return null;
  return {
    limit: /max/i.test(error.message) ? "above" : "below",
    minXmr: numberOrNull(range.minAmount),
    maxXmr: numberOrNull(range.maxAmount),
  };
}

/** What a ChangeNow takes besides its key. The tests pass a fake fetch and a clock of their own. */
export interface ChangeNowOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class ChangeNow implements Exchanger {
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #limiter: CallLimiter;
  readonly #minAmounts = new Map<ChainAsset, { value: number; at: number }>();

  constructor(apiKey: string, { fetchImpl = fetch, now = Date.now }: ChangeNowOptions = {}) {
    this.#apiKey = apiKey;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#limiter = new CallLimiter(UPSTREAM_CALLS_PER_SECOND, now);
  }

  async minAmount(asset: ChainAsset): Promise<number> {
    const kept = this.#minAmounts.get(asset);
    if (kept !== undefined && this.#now() - kept.at < MIN_AMOUNT_CACHE_MS) return kept.value;
    const pair = `${CHAIN_ASSETS[asset].legacyTicker}_${XMR.legacyTicker}`;
    const data = await this.#call(`/v1/min-amount/${pair}?api_key=${encodeURIComponent(this.#apiKey)}`);
    const value = requireNumber(data, "minAmount");
    this.#minAmounts.set(asset, { value, at: this.#now() });
    return value;
  }

  async estimate(asset: ChainAsset, amount: string): Promise<Estimate> {
    const pair = `${CHAIN_ASSETS[asset].legacyTicker}_${XMR.legacyTicker}`;
    const data = await this.#call(`/v1/exchange-amount/${amount}/${pair}?api_key=${encodeURIComponent(this.#apiKey)}`);
    return {
      amount: requireNumber(data, "estimatedAmount"),
      speedMinutes: stringOrNull(data.transactionSpeedForecast),
      warning: stringOrNull(data.warningMessage),
    };
  }

  async create(
    asset: ChainAsset,
    amount: string,
    address: string,
    refundAddress: string | null,
  ): Promise<CreatedExchange> {
    const from = CHAIN_ASSETS[asset];
    const body: Json = {
      fromCurrency: from.currency,
      fromNetwork: from.network,
      toCurrency: XMR.currency,
      toNetwork: XMR.network,
      fromAmount: amount,
      address,
      flow: STANDARD_FLOW,
    };
    if (refundAddress !== null) body.refundAddress = refundAddress;
    return this.#created(await this.#call("/v2/exchange", { method: "POST", body: JSON.stringify(body) }));
  }

  async payRange(asset: ChainAsset, rate: PayRate): Promise<PayRange> {
    const to = CHAIN_ASSETS[asset];
    const query = new URLSearchParams({
      fromCurrency: XMR.currency,
      fromNetwork: XMR.network,
      toCurrency: to.currency,
      toNetwork: to.network,
      flow: PAY_RATES[rate],
    });
    const data = await this.#call(`/v2/exchange/range?${query}`);
    return { minXmr: requireNumber(data, "minAmount"), maxXmr: numberOrNull(data.maxAmount) };
  }

  async payEstimate(asset: ChainAsset, rate: PayRate, xmrAmount: string): Promise<PayEstimate | PayOutOfRange> {
    const to = CHAIN_ASSETS[asset];
    const query = new URLSearchParams({
      fromCurrency: XMR.currency,
      fromNetwork: XMR.network,
      toCurrency: to.currency,
      toNetwork: to.network,
      fromAmount: xmrAmount,
      type: DIRECT_TYPE,
      flow: PAY_RATES[rate],
    });
    let data: Json;
    try {
      data = await this.#call(`/v2/exchange/estimated-amount?${query}`);
    } catch (error) {
      const range = error instanceof UpstreamError ? outOfRange(error) : null;
      if (range !== null) return range;
      throw error;
    }
    return {
      amount: requireNumber(data, "toAmount"),
      rateId: rate === "fixed" ? requireString(data, "rateId") : null,
      validUntil: stringOrNull(data.validUntil),
      warning: stringOrNull(data.warningMessage),
      depositFee: numberOrNull(data.depositFee),
      withdrawalFee: numberOrNull(data.withdrawalFee),
      speedMinutes: stringOrNull(data.transactionSpeedForecast),
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
    const to = CHAIN_ASSETS[asset];
    const body: Json = {
      fromCurrency: XMR.currency,
      fromNetwork: XMR.network,
      toCurrency: to.currency,
      toNetwork: to.network,
      fromAmount: xmrAmount,
      address,
      refundAddress,
      flow: PAY_RATES[rate],
      type: DIRECT_TYPE,
    };
    if (rateId !== null) body.rateId = rateId;
    return this.#created(await this.#call("/v2/exchange", { method: "POST", body: JSON.stringify(body) }));
  }

  async status(id: string): Promise<ExchangeStatus> {
    const data = await this.#call(`/v2/exchange/by-id?id=${encodeURIComponent(id)}`);
    return {
      status: requireString(data, "status"),
      amountTo: numberOrNull(data.amountTo),
      expectedAmountTo: numberOrNull(data.expectedAmountTo),
      payinHash: stringOrNull(data.payinHash),
      payoutHash: stringOrNull(data.payoutHash),
      refundAddress: stringOrNull(data.refundAddress),
      refundHash: stringOrNull(data.refundHash),
      refundAmount: numberOrNull(data.refundAmount),
      updatedAt: stringOrNull(data.updatedAt),
      validUntil: stringOrNull(data.validUntil),
    };
  }

  #created(data: Json): CreatedExchange {
    return {
      id: requireString(data, "id"),
      fromAmount: requireNumber(data, "fromAmount"),
      toAmount: requireNumber(data, "toAmount"),
      payinAddress: requireString(data, "payinAddress"),
      payoutAddress: requireString(data, "payoutAddress"),
      fromCurrency: stringOrNull(data.fromCurrency),
      fromNetwork: stringOrNull(data.fromNetwork),
      toCurrency: stringOrNull(data.toCurrency),
      toNetwork: stringOrNull(data.toNetwork),
      flow: stringOrNull(data.flow),
    };
  }

  async #call(path: string, init: { method?: string; body?: string } = {}): Promise<Json> {
    if (!this.#limiter.take()) throw new GatewayError(503, "The relay is busy. Try again in a moment.");
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${CHANGENOW_BASE_URL}${path}`, {
        method: init.method ?? "GET",
        body: init.body,
        headers: { "content-type": "application/json", "x-changenow-api-key": this.#apiKey },
        // A redirect would carry the key and the body to another host, so the relay follows none.
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch {
      throw new GatewayError(504, "ChangeNOW did not answer.");
    }
    try {
      text = await response.text();
    } catch {
      throw new GatewayError(502, "The answer of ChangeNOW could not be read.");
    }
    let data: unknown = null;
    try {
      data = JSON.parse(text);
    } catch {
      // ChangeNOW answers some refusals, such as a missing key, as plain text.
    }
    const fields = objectOrNull(data);
    if (!response.ok) {
      const message =
        stringOrNull(fields?.message) ?? stringOrNull(fields?.error) ?? (text.trim() || response.statusText);
      throw new UpstreamError(response.status, message, fields);
    }
    if (fields === null) throw new GatewayError(502, "ChangeNOW answered with something other than an object.");
    return fields;
  }
}
