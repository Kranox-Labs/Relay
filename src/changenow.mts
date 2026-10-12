// The calls of the relay to ChangeNOW. CHECKED 5 Oct 2026, sources the Postman collection of the API
// (documenter.getpostman.com/view/8180765/SVfTPnM8) and the public currency list: ETH and USDG on Robinhood Chain are
// "eth" and "usdg" on the network "hood" in v2. Every call uses v2, which takes the key in a header only: until 9 Oct
// 2026 receive asked v1 for the minimum and the estimate, which also carried the key in the query string (relay O-005
// of the second security review); now it asks v2 for the range and the estimate of its pair at the floating rate, as
// pay does. NOT CHECKED against ChangeNOW for receive yet: the test of the release checks a quote. Pay: CHECKED 6 Oct 2026, the key
// of Kranox gets the fixed-rate estimate of the coin that an amount of XMR buys ("direct"), and an amount outside the
// range of the fixed rate answers 400 with that range in XMR. On 6 Oct 2026 the owner asked for the amount of XMR as
// the input of pay; the first take of 5 Oct 2026 asked for the amount that the recipient gets ("reverse"). The same
// day the owner asked to let the user choose the floating rate as well (flow "standard"): CHECKED 6 Oct 2026, its
// minimum is about half of the fixed one, it has no top, it gives no rate id, and below its minimum it answers 400
// "Out of min amount" with the range.
import { CHANGENOW_BASE_URL, MIN_AMOUNT_CACHE_MS, UPSTREAM_CALLS_PER_SECOND, UPSTREAM_TIMEOUT_MS } from "./config.mts";
import {
  GatewayError,
  UpstreamError,
  type ChainAsset,
  type CreatedExchange,
  type Estimate,
  type ExchangeStatus,
  type Exchanger,
  type PairNames,
  type PayEstimate,
  type PayOutOfRange,
  type PayRange,
  type PayRate,
  type Side,
} from "./exchanger.mts";
import { numberOrNull, objectOrNull, stringOrNull, type Json } from "./json.mts";
import { CallLimiter } from "./limiter.mts";

export const CHANGENOW_NAME = "ChangeNOW";

/** The coins on Robinhood Chain that the bridge takes in and pays out, with their names in v2 of the API. */
export const CHAIN_ASSETS: Record<ChainAsset, Side> = {
  eth: { currency: "eth", network: "hood" },
  usdg: { currency: "usdg", network: "hood" },
};

const XMR: Side = { currency: "xmr", network: "xmr" };

/** The flow with a floating rate: the amount of XMR follows the market until the deposit arrives. */
const STANDARD_FLOW = "standard";

/** The flow with a fixed rate: the exchanger holds the rate of the estimate, so the recipient gets the exact amount. */
const FIXED_RATE_FLOW = "fixed-rate";

/** The rates of pay that the user chooses from, with the flow of ChangeNOW of each. */
export const PAY_RATES: Record<PayRate, string> = { fixed: FIXED_RATE_FLOW, floating: STANDARD_FLOW };

/** An estimate from the amount that goes in. */
const DIRECT_TYPE = "direct";

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

/** The pair of receive in a query of v2: a coin on Robinhood Chain into XMR, at the floating rate. */
function receivePair(asset: ChainAsset): Record<string, string> {
  const from = CHAIN_ASSETS[asset];
  return {
    fromCurrency: from.currency,
    fromNetwork: from.network,
    toCurrency: XMR.currency,
    toNetwork: XMR.network,
    flow: STANDARD_FLOW,
  };
}

/** What a ChangeNow takes besides its key. The tests pass a fake fetch and a clock of their own. */
export interface ChangeNowOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class ChangeNow implements Exchanger {
  readonly name = CHANGENOW_NAME;
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
    const data = await this.#call(`/v2/exchange/range?${new URLSearchParams(receivePair(asset))}`);
    const value = requireNumber(data, "minAmount");
    this.#minAmounts.set(asset, { value, at: this.#now() });
    return value;
  }

  async estimate(asset: ChainAsset, amount: string): Promise<Estimate> {
    const query = new URLSearchParams({ ...receivePair(asset), fromAmount: amount, type: DIRECT_TYPE });
    const data = await this.#call(`/v2/exchange/estimated-amount?${query}`);
    return {
      amount: requireNumber(data, "toAmount"),
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

  payNames(asset: ChainAsset, rate: PayRate): PairNames {
    return { from: XMR, to: CHAIN_ASSETS[asset], flow: PAY_RATES[rate] };
  }

  receiveNames(asset: ChainAsset): PairNames {
    return { from: CHAIN_ASSETS[asset], to: XMR, flow: STANDARD_FLOW };
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
      refundAddress: stringOrNull(data.refundAddress),
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
      throw new UpstreamError(response.status, message, CHANGENOW_NAME, fields);
    }
    if (fields === null) throw new GatewayError(502, "ChangeNOW answered with something other than an object.");
    return fields;
  }
}
