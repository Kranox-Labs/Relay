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
// "Out of min amount" with the range. From 13 Oct 2026 pay also takes STRK: CHECKED 13 Oct 2026 with the key of
// Kranox, Starknet is the network "strk" (the network "starknet" answers "Currency strk is not supported"), and STRK
// into USDG on Robinhood Chain ranges from 18.88 STRK at the floating rate and from 110.06 to 9142.31 at the fixed one.
// ZEC is "zec" on the network "zec": into USDG from 0.0234 ZEC at the floating rate and from 0.0183 to 0.66 at the
// fixed one, 1 ZEC at 1192.47 USDG with a deposit fee of 0.01 ZEC (CHECKED 13 Oct 2026, the same key). The way out,
// from 13 Oct 2026, is the pair of receive for any of the three coins at the standard flow: CHECKED 13 Oct 2026 with
// the same key, USDG on "hood" into XMR from 12.27, into ZEC from 28.10, and into STRK from 1.65; ETH into XMR from
// 0.0044, into ZEC from 0.0107, and into STRK from 0.00018; no top; "10-60" minutes; a deposit fee of about 0.7 USDG.
import { CHANGENOW_BASE_URL, MIN_AMOUNT_CACHE_MS, UPSTREAM_CALLS_PER_SECOND, UPSTREAM_TIMEOUT_MS } from "./config.mts";
import {
  FROM_ASSET_NAMES,
  GatewayError,
  PAY_RATE_NAMES,
  UpstreamError,
  type ChainAsset,
  type CreatedExchange,
  type Estimate,
  type ExchangeStatus,
  type Exchanger,
  type FromAsset,
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

/** The coins of origin of pay, with their names in v2 of the API: XMR on Monero, STRK on Starknet, and ZEC on Zcash. */
export const FROM_SIDES: Record<FromAsset, Side> = {
  xmr: { currency: "xmr", network: "xmr" },
  strk: { currency: "strk", network: "strk" },
  zec: { currency: "zec", network: "zec" },
};

const XMR: Side = FROM_SIDES.xmr;

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
    minFrom: numberOrNull(range.minAmount),
    maxFrom: numberOrNull(range.maxAmount),
  };
}

/** The pair of the way out in a query of v2: a coin on Robinhood Chain into a coin of a private chain, at the floating rate. */
function outPair(asset: ChainAsset, to: FromAsset): Record<string, string> {
  const from = CHAIN_ASSETS[asset];
  const destination = FROM_SIDES[to];
  return {
    fromCurrency: from.currency,
    fromNetwork: from.network,
    toCurrency: destination.currency,
    toNetwork: destination.network,
    flow: STANDARD_FLOW,
  };
}

/** The pair of receive in a query of v2: a coin on Robinhood Chain into XMR, at the floating rate. */
function receivePair(asset: ChainAsset): Record<string, string> {
  return outPair(asset, "xmr");
}

/** What a ChangeNow takes besides its key. The tests pass a fake fetch and a clock of their own. */
export interface ChangeNowOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class ChangeNow implements Exchanger {
  readonly name = CHANGENOW_NAME;
  readonly origins: readonly FromAsset[] = FROM_ASSET_NAMES;
  readonly rates: readonly PayRate[] = PAY_RATE_NAMES;
  readonly destinations: readonly FromAsset[] = FROM_ASSET_NAMES;
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

  async payRange(from: FromAsset, asset: ChainAsset, rate: PayRate): Promise<PayRange> {
    const origin = FROM_SIDES[from];
    const to = CHAIN_ASSETS[asset];
    const query = new URLSearchParams({
      fromCurrency: origin.currency,
      fromNetwork: origin.network,
      toCurrency: to.currency,
      toNetwork: to.network,
      flow: PAY_RATES[rate],
    });
    const data = await this.#call(`/v2/exchange/range?${query}`);
    return { minFrom: requireNumber(data, "minAmount"), maxFrom: numberOrNull(data.maxAmount) };
  }

  async payEstimate(
    from: FromAsset,
    asset: ChainAsset,
    rate: PayRate,
    fromAmount: string,
  ): Promise<PayEstimate | PayOutOfRange> {
    const origin = FROM_SIDES[from];
    const to = CHAIN_ASSETS[asset];
    const query = new URLSearchParams({
      fromCurrency: origin.currency,
      fromNetwork: origin.network,
      toCurrency: to.currency,
      toNetwork: to.network,
      fromAmount,
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
    from: FromAsset,
    asset: ChainAsset,
    rate: PayRate,
    fromAmount: string,
    address: string,
    refundAddress: string,
    rateId: string | null,
  ): Promise<CreatedExchange> {
    const origin = FROM_SIDES[from];
    const to = CHAIN_ASSETS[asset];
    const body: Json = {
      fromCurrency: origin.currency,
      fromNetwork: origin.network,
      toCurrency: to.currency,
      toNetwork: to.network,
      fromAmount,
      address,
      refundAddress,
      flow: PAY_RATES[rate],
      type: DIRECT_TYPE,
    };
    if (rateId !== null) body.rateId = rateId;
    return this.#created(await this.#call("/v2/exchange", { method: "POST", body: JSON.stringify(body) }));
  }

  payNames(from: FromAsset, asset: ChainAsset, rate: PayRate): PairNames {
    return { from: FROM_SIDES[from], to: CHAIN_ASSETS[asset], flow: PAY_RATES[rate] };
  }

  receiveNames(asset: ChainAsset): PairNames {
    return { from: CHAIN_ASSETS[asset], to: XMR, flow: STANDARD_FLOW };
  }

  async outRange(asset: ChainAsset, to: FromAsset): Promise<PayRange> {
    const data = await this.#call(`/v2/exchange/range?${new URLSearchParams(outPair(asset, to))}`);
    return { minFrom: requireNumber(data, "minAmount"), maxFrom: numberOrNull(data.maxAmount) };
  }

  async outEstimate(asset: ChainAsset, to: FromAsset, fromAmount: string): Promise<PayEstimate | PayOutOfRange> {
    const query = new URLSearchParams({ ...outPair(asset, to), fromAmount, type: DIRECT_TYPE });
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
      rateId: null,
      validUntil: stringOrNull(data.validUntil),
      warning: stringOrNull(data.warningMessage),
      depositFee: numberOrNull(data.depositFee),
      withdrawalFee: numberOrNull(data.withdrawalFee),
      speedMinutes: stringOrNull(data.transactionSpeedForecast),
    };
  }

  async createOut(
    asset: ChainAsset,
    to: FromAsset,
    fromAmount: string,
    address: string,
    refundAddress: string,
  ): Promise<CreatedExchange> {
    const body: Json = { ...outPair(asset, to), fromAmount, address, refundAddress, type: DIRECT_TYPE };
    return this.#created(await this.#call("/v2/exchange", { method: "POST", body: JSON.stringify(body) }));
  }

  outNames(asset: ChainAsset, to: FromAsset): PairNames {
    return { from: CHAIN_ASSETS[asset], to: FROM_SIDES[to], flow: STANDARD_FLOW };
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
      validUntil: stringOrNull(data.validUntil),
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
