// The calls of the relay to the 1Click API of NEAR Intents, the exchanger of Starknet and Zcash from 13 Oct 2026. CHECKED 13 Oct
// 2026, sources the OpenAPI file of the API (1click.chaindefuser.com/docs/v0/openapi.yaml), its documentation
// (docs.near-intents.org), and its answers: a quote is one POST /v0/quote, dry for an estimate and real for a swap,
// and a real one holds the deposit address on the chain of origin and the time until which it takes a deposit; the state of a
// swap comes from GET /v0/status by that deposit address, so the address is the id of the swap at the relay. Amounts
// go in base units as text (STRK has 18 decimals) and come back formatted as well. A recipient in the checksum case
// of EIP-55 answered 400 "recipient is not valid" and a lowercase one passed, so the relay writes it in lowercase. A
// partner key, a JWT from partners.near-intents.org, is optional: without it 1Click adds 0.25% to every swap and
// refuses the confidential modes; with it, the key goes in the header authorization and nowhere else. 1Click names no
// minimum (1 STRK quoted too, 0.011 USDG after the withdraw fee of 0.075 USDG), so the relay sets one of its own. A
// quote answers in seconds and the swap settles in about half a minute (timeEstimate 26). The deadline of a request
// is the time after which a deposit is refunded instead of swapped; the deadline of the quote lies three days later,
// when the address stops taking anything (CHECKED 13 Oct 2026: a request with a deadline 20 minutes ahead answered a
// quote with a deadline 3 days and 20 minutes ahead). A deposit below the amount of the quote is held and refunded at
// the deadline (its documentation of EXACT_INPUT); NOT CHECKED: what 1Click does with a second deposit on top of it.
import {
  ONECLICK_BASE_URL,
  ONECLICK_CREATIONS_PER_SECOND,
  ONECLICK_DEADLINE_MS,
  ONECLICK_ESTIMATES_PER_SECOND,
  ONECLICK_ESTIMATE_CACHE_ENTRIES,
  ONECLICK_ESTIMATE_CACHE_MS,
  ONECLICK_MIN_FROM,
  ONECLICK_QUOTE_WAIT_MS,
  ONECLICK_READS_PER_SECOND,
  ONECLICK_REFERRAL,
  ONECLICK_SLIPPAGE_BPS,
  ONECLICK_STATUS_CACHE_ENTRIES,
  ONECLICK_STATUS_CACHE_MS,
  ONECLICK_TOKENS_CACHE_MS,
  UPSTREAM_TIMEOUT_MS,
} from "./config.mts";
import {
  GatewayError,
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
} from "./exchanger.mts";
import { numberOrNull, objectOrNull, stringOrNull, type Json } from "./json.mts";
import { CallLimiter } from "./limiter.mts";

export const ONECLICK_NAME = "NEAR Intents";

/** A coin as the token list of 1Click names it: its asset id, its symbol, its chain, and its decimals. */
interface Token {
  id: string;
  symbol: string;
  blockchain: string;
  decimals: number;
}

/**
 * The coins of origin that the relay takes in through 1Click (CHECKED 13 Oct 2026, GET /v0/tokens). ZEC moves at
 * transparent addresses alone (its page of the chains), takes about eight minutes (timeEstimate 454), and has a floor
 * of its bridge: 0.001 ZEC answered "Amount is too low for bridge, try at least 132000" (0.00132 ZEC).
 */
const ORIGINS: Partial<Record<FromAsset, Token>> = {
  strk: { id: "nep141:starknet.omft.near", symbol: "STRK", blockchain: "starknet", decimals: 18 },
  zec: { id: "nep141:zec.omft.near", symbol: "ZEC", blockchain: "zec", decimals: 8 },
};

/** The names of those coins, from the one table above, so that no second list can leave one out (R-24). */
const ORIGIN_NAMES = Object.keys(ORIGINS) as FromAsset[];

/** The coins on Robinhood Chain, the chain "hood" of 1Click (CHECKED 13 Oct 2026, GET /v0/tokens). */
const CHAIN_TOKENS: Record<ChainAsset, Token> = {
  eth: { id: "nep141:hood.omft.near", symbol: "ETH", blockchain: "hood", decimals: 18 },
  usdg: {
    id: "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near",
    symbol: "USDG",
    blockchain: "hood",
    decimals: 6,
  },
};

/** The kind of swap: the amount that goes in is exact, and what comes out may move within the slippage. */
const SWAP_TYPE = "EXACT_INPUT";

/** The deposit, the refund, and the payout all happen on the chains themselves, never inside an account of NEAR. */
const DEPOSIT_TYPE = "ORIGIN_CHAIN";
const REFUND_TYPE = "ORIGIN_CHAIN";
const RECIPIENT_TYPE = "DESTINATION_CHAIN";

/**
 * The addresses of a dry quote, which makes nothing and pays nobody: an address of the right shape of each chain that
 * belongs to nobody, the refund one by coin of origin, since 1Click checks it against the chain (CHECKED 13 Oct 2026:
 * a Starknet address as refundTo of a quote of ZEC answers 400 "refundTo is not valid"). The one of Starknet is made
 * up, digit by digit; the one of Zcash is the public key hash RIPEMD-160(SHA-256("kranox zec dry quote, nobody holds
 * this")) with the prefix t1 and its checksum, so nobody holds its key (R-35 of the scan of 13 Oct 2026). The pages
 * ask for an estimate before the user names a wallet or a refund address. A real swap with either of them is refused
 * (R-22 of the scan of 13 Oct 2026), and the tests pin both as addresses of their chains (R-30).
 */
const DRY_RECIPIENT = "0x1111111111111111111111111111111111111111";
const DRY_REFUNDS: Partial<Record<FromAsset, string>> = {
  strk: "0x02b7c9e1f3a5d7b9c1e3f5a7b9d1e3f5a7b9c1d3e5f7a9b1c3d5e7f9b1d3e5f7",
  zec: "t1YXzfrDh5Nq3yVrGGz69mhUX9z8nuuoS1L",
};

/**
 * The floor of the bridge of 1Click, in a refusal of an amount, in base units: "Amount is too low for bridge, try at
 * least 132000" (CHECKED 13 Oct 2026 for 0.001 ZEC). The relay reads it as the least that goes through, so that the
 * app shows a range rather than the words of 1Click (R-29). NOT CHECKED: whether the floor moves with the price.
 */
const BRIDGE_FLOOR = /try at least (\d+)/i;

/**
 * The fields of a real quote that must come back as they were sent: a swap of another kind, amount, address, or time
 * than the one asked is no swap for the app. 1Click echoes the request in quoteRequest.
 */
const ECHOED_FIELDS = [
  "dry",
  "swapType",
  "originAsset",
  "depositType",
  "destinationAsset",
  "amount",
  "refundTo",
  "refundType",
  "recipient",
  "recipientType",
  "deadline",
] as const;

/**
 * The states of a swap at 1Click, each with the state of the app that it shows as: a Map, so that no name of
 * Object.prototype passes as a state (R-16 of the scan of 13 Oct 2026).
 */
const STATES = new Map<string, string>([
  ["PENDING_DEPOSIT", "waiting"],
  // A deposit arrived and 1Click waits for its confirmations.
  ["KNOWN_DEPOSIT_TX", "confirming"],
  // A deposit arrived that is less than the amount of the quote: 1Click holds it and refunds it at the deadline. The
  // app shows it as confirming, so that the box to send goes away and the refund shows when it comes; it never shows
  // the box again or says that time ran out while 1Click holds the coins (R-14 of the scan of 13 Oct 2026).
  ["INCOMPLETE_DEPOSIT", "confirming"],
  ["PROCESSING", "exchanging"],
  ["SUCCESS", "finished"],
  ["REFUNDED", "refunded"],
  ["FAILED", "failed"],
]);

/** The state of a quote whose deadline passed without a deposit, in the words of the app. */
const EXPIRED = "expired";

/** What a OneClick takes besides its key. The tests pass a fake fetch and a clock of their own. */
export interface OneClickOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** [amount], digits with a point for decimals, as a whole number of base units of a coin with [decimals] decimals. */
export function toBaseUnits(amount: string, decimals: number): string {
  const parts = amount.split(".");
  const [whole, fraction = ""] = parts;
  if (
    parts.length > 2 ||
    whole === undefined ||
    !/^\d+$/.test(whole) ||
    !/^\d*$/.test(fraction) ||
    fraction.length > decimals
  ) {
    throw new RangeError(`The amount ${amount} is not a number with at most ${decimals} decimals.`);
  }
  return BigInt(`${whole}${fraction.padEnd(decimals, "0")}`).toString();
}

/** A whole number of base units of a coin with [decimals] decimals, as the number of coins; null for other text. */
export function fromBaseUnits(text: unknown, decimals: number): number | null {
  if (typeof text !== "string" || !/^\d+$/.test(text)) return null;
  return Number(text) / 10 ** decimals;
}

/** A number that 1Click writes as text, such as "86.131039"; null for other text. */
function amountOrNull(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function requireAmount(data: Json, field: string): number {
  const value = amountOrNull(data[field]);
  if (value === null) throw new GatewayError(502, `${ONECLICK_NAME} answered without the number ${field}.`);
  return value;
}

function requireString(data: Json, field: string): string {
  const value = stringOrNull(data[field]);
  if (value === null) throw new GatewayError(502, `${ONECLICK_NAME} answered without the text ${field}.`);
  return value;
}

function requireObject(data: Json, field: string): Json {
  const value = objectOrNull(data[field]);
  if (value === null) throw new GatewayError(502, `${ONECLICK_NAME} answered without ${field}.`);
  return value;
}

/** The hashes of a list of transactions of 1Click, such as the deposits on the chain of origin. */
function hashesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const hash = stringOrNull(objectOrNull(item)?.hash);
    return hash === null ? [] : [hash];
  });
}

/** The minutes that a swap takes, from the seconds of 1Click, at least one. */
function minutesOf(seconds: unknown): string | null {
  const value = numberOrNull(seconds);
  return value === null ? null : String(Math.max(1, Math.ceil(value / 60)));
}

/**
 * The text of a refusal of 1Click: its message, one string or a list of them, as the framework behind it writes a
 * refusal of a field; then its error; then [fallback]. Never the whole body, which is no sentence (R-20).
 */
function refusalText(fields: Json | null, fallback: string): string {
  const message = fields?.message;
  if (typeof message === "string" && message !== "") return message;
  if (Array.isArray(message)) {
    const lines = message.filter((line): line is string => typeof line === "string" && line !== "");
    if (lines.length > 0) return lines.join("; ");
  }
  return stringOrNull(fields?.error) ?? fallback;
}

export class OneClick implements PayExchanger {
  readonly name = ONECLICK_NAME;
  readonly origins: readonly FromAsset[] = ORIGIN_NAMES;
  // A quote of 1Click moves within its slippage, which the app calls a floating rate; no rate id holds it.
  readonly rates: readonly PayRate[] = ["floating"];
  readonly #apiKey: string | null;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  // Three budgets of calls, so that a flood of estimates or of reads never starves a creation (R-15).
  readonly #estimateBudget: CallLimiter;
  readonly #readBudget: CallLimiter;
  readonly #creationBudget: CallLimiter;
  // The check of /ready: the token list and one dry quote of the minimum of each coin, apart from the other budgets.
  readonly #readyBudget: CallLimiter;
  readonly #estimates = new Map<string, { value: PayEstimate | PayOutOfRange; at: number }>();
  readonly #states = new Map<string, { value: ExchangeStatus; at: number }>();
  #checkedAt: number | null = null;

  constructor(apiKey: string | null, { fetchImpl = fetch, now = Date.now }: OneClickOptions = {}) {
    // An empty key is no key: nothing goes in the header then (R-26).
    this.#apiKey = apiKey === null || apiKey === "" ? null : apiKey;
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#estimateBudget = new CallLimiter(ONECLICK_ESTIMATES_PER_SECOND, now);
    this.#readBudget = new CallLimiter(ONECLICK_READS_PER_SECOND, now);
    this.#creationBudget = new CallLimiter(ONECLICK_CREATIONS_PER_SECOND, now);
    this.#readyBudget = new CallLimiter(ORIGIN_NAMES.length + 1, now);
    // Every coin of origin needs a minimum above zero, seen here rather than at the first quote (R-24).
    for (const from of ORIGIN_NAMES) {
      const minimum = ONECLICK_MIN_FROM[from];
      if (minimum === undefined || !(minimum > 0)) {
        throw new Error(`The minimum of ${from.toUpperCase()} at ${ONECLICK_NAME} must be a number above zero.`);
      }
      if (DRY_REFUNDS[from] === undefined) {
        throw new Error(
          `The dry quote of ${from.toUpperCase()} at ${ONECLICK_NAME} needs a refund address of its chain.`,
        );
      }
    }
  }

  async payRange(from: FromAsset, asset: ChainAsset, rate: PayRate): Promise<PayRange> {
    this.#pair(from, asset, rate);
    return { minFrom: this.#minimum(from), maxFrom: null };
  }

  async payEstimate(
    from: FromAsset,
    asset: ChainAsset,
    rate: PayRate,
    fromAmount: string,
  ): Promise<PayEstimate | PayOutOfRange> {
    const [origin, to] = this.#pair(from, asset, rate);
    const minimum = this.#minimum(from);
    // Below the minimum of the relay no quote is asked: 1Click would quote, with a fee that eats the amount.
    if (Number(fromAmount) < minimum) return { limit: "below", minFrom: minimum, maxFrom: null };
    // The same quote asked again within a few seconds, as the pages of the app do, costs one call.
    const key = `${from}:${asset}:${rate}:${fromAmount}`;
    const kept = this.#estimates.get(key);
    if (kept !== undefined && this.#now() - kept.at < ONECLICK_ESTIMATE_CACHE_MS) return kept.value;
    const value = await this.#estimate(from, origin, to, fromAmount);
    if (this.#estimates.size >= ONECLICK_ESTIMATE_CACHE_ENTRIES) this.#estimates.clear();
    this.#estimates.set(key, { value, at: this.#now() });
    return value;
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
    const [origin, to] = this.#pair(from, asset, rate);
    if (rateId !== null) throw new GatewayError(502, `${ONECLICK_NAME} holds no rate by an id.`);
    // 1Click refused a recipient in the checksum case of EIP-55 (CHECKED 13 Oct 2026); the chain reads any case.
    const recipient = address.toLowerCase();
    // The addresses of a dry quote belong to nobody: a swap for them would pay nobody (R-22).
    if (recipient === DRY_RECIPIENT || refundAddress === this.#dryRefund(from)) {
      throw new GatewayError(502, `${ONECLICK_NAME} cannot make a swap for the addresses of a dry quote.`);
    }
    const { answer, sent } = await this.#quote(false, origin, to, fromAmount, recipient, refundAddress);
    const quote = requireObject(answer, "quote");
    const request = requireObject(answer, "quoteRequest");
    const depositAddress = requireString(quote, "depositAddress");
    // The answer carries the request back. A swap of another kind, amount, address, or time than the one asked, such
    // as a deposit into an account of NEAR Intents instead of an address on Starknet, is no swap for the app; the
    // amount is compared in base units, exactly, so that what the user sends is what 1Click expects (R-17).
    for (const field of ECHOED_FIELDS) {
      if (request[field] !== sent[field]) {
        throw new GatewayError(502, `${ONECLICK_NAME} made a swap for another request (${field}).`, depositAddress);
      }
    }
    if (quote.amountIn !== sent.amount) {
      throw new GatewayError(502, `${ONECLICK_NAME} made a swap for another amount in.`, depositAddress);
    }
    // A deposit that needs a memo beside its address would be lost without it; the app shows an address alone.
    if (stringOrNull(quote.depositMemo) !== null) {
      throw new GatewayError(502, `${ONECLICK_NAME} made a swap whose deposit needs a memo.`, depositAddress);
    }
    return {
      id: depositAddress,
      // The amount in is the one sent, checked in base units above, in the number of the request.
      fromAmount: Number(fromAmount),
      toAmount: requireAmount(quote, "amountOutFormatted"),
      payinAddress: depositAddress,
      payoutAddress: requireString(request, "recipient"),
      refundAddress: stringOrNull(request.refundTo),
      // The names of the pair are the asset ids of 1Click, which name the chain as well; it names no network apart.
      fromCurrency: requireString(request, "originAsset"),
      fromNetwork: null,
      toCurrency: requireString(request, "destinationAsset"),
      toNetwork: null,
      flow: requireString(request, "swapType"),
      // The time to send: the deadline of the request, after which a deposit is refunded instead of swapped.
      validUntil: requireString(request, "deadline"),
    };
  }

  payNames(from: FromAsset, asset: ChainAsset, rate: PayRate): PairNames {
    const [origin, to] = this.#pair(from, asset, rate);
    return {
      from: { currency: origin.id, network: origin.blockchain },
      to: { currency: to.id, network: to.blockchain },
      flow: SWAP_TYPE,
    };
  }

  async status(id: string): Promise<ExchangeStatus> {
    // The same swap read again within a few seconds, as several pages of the app may, costs one call (R-15).
    const kept = this.#states.get(id);
    if (kept !== undefined && this.#now() - kept.at < ONECLICK_STATUS_CACHE_MS) return kept.value;
    const value = await this.#readStatus(id);
    if (this.#states.size >= ONECLICK_STATUS_CACHE_ENTRIES) this.#states.clear();
    this.#states.set(id, { value, at: this.#now() });
    return value;
  }

  /**
   * Reads the token list of 1Click and checks that it still carries every coin that the relay names, and, with a
   * partner key, asks one dry quote of the minimum of each coin, which shows that 1Click takes the key (R-23) and
   * that the floor of its bridge lies under the minimum of the relay (R-29). Both now and then.
   */
  async ready(): Promise<void> {
    if (this.#checkedAt !== null && this.#now() - this.#checkedAt < ONECLICK_TOKENS_CACHE_MS) return;
    const data = await this.#call("/v0/tokens", {}, this.#readyBudget);
    if (!Array.isArray(data)) {
      throw new GatewayError(502, `${ONECLICK_NAME} answered with something other than its tokens.`);
    }
    const listed = new Map<string, Json>();
    for (const item of data) {
      const token = objectOrNull(item);
      const id = stringOrNull(token?.assetId);
      if (token !== null && id !== null) listed.set(id, token);
    }
    for (const token of [...Object.values(ORIGINS), ...Object.values(CHAIN_TOKENS)]) {
      const found = listed.get(token.id);
      if (
        found === undefined ||
        found.symbol !== token.symbol ||
        found.blockchain !== token.blockchain ||
        found.decimals !== token.decimals
      ) {
        throw new GatewayError(
          502,
          `${ONECLICK_NAME} no longer lists ${token.symbol} on ${token.blockchain} as the relay knows it.`,
        );
      }
    }
    if (this.#apiKey !== null) {
      for (const from of ORIGIN_NAMES) {
        const origin = ORIGINS[from];
        if (origin === undefined) continue;
        const amount = this.#minimum(from).toFixed(origin.decimals);
        const estimate = await this.#estimate(from, origin, CHAIN_TOKENS.usdg, amount, this.#readyBudget);
        if ("limit" in estimate) {
          throw new GatewayError(
            502,
            `${ONECLICK_NAME} takes ${origin.symbol} from ${String(estimate.minFrom)}, above the minimum of the relay.`,
          );
        }
      }
    }
    this.#checkedAt = this.#now();
  }

  /** The tokens of a pair, or a refusal when the relay has no name of the coin of origin at 1Click or the rate is not served. */
  #pair(from: FromAsset, asset: ChainAsset, rate: PayRate): [Token, Token] {
    const origin = ORIGINS[from];
    if (origin === undefined) throw new GatewayError(502, `${ONECLICK_NAME} does not take ${from.toUpperCase()}.`);
    if (!this.rates.includes(rate)) throw new GatewayError(502, `${ONECLICK_NAME} has no ${rate} rate.`);
    return [origin, CHAIN_TOKENS[asset]];
  }

  #minimum(from: FromAsset): number {
    const minimum = ONECLICK_MIN_FROM[from];
    if (minimum === undefined) throw new GatewayError(502, `${ONECLICK_NAME} does not take ${from.toUpperCase()}.`);
    return minimum;
  }

  /** The refund address of a dry quote of [from], which belongs to nobody. */
  #dryRefund(from: FromAsset): string {
    const address = DRY_REFUNDS[from];
    if (address === undefined) throw new GatewayError(502, `${ONECLICK_NAME} does not take ${from.toUpperCase()}.`);
    return address;
  }

  /** One dry quote, read as an estimate, or the floor of the bridge when 1Click refuses the amount as too low (R-29). */
  async #estimate(
    from: FromAsset,
    origin: Token,
    to: Token,
    fromAmount: string,
    budget: CallLimiter = this.#estimateBudget,
  ): Promise<PayEstimate | PayOutOfRange> {
    const refundTo = this.#dryRefund(from);
    let answer: Json;
    try {
      ({ answer } = await this.#quote(true, origin, to, fromAmount, DRY_RECIPIENT, refundTo, budget));
    } catch (error) {
      const floor =
        error instanceof UpstreamError && error.status === 400
          ? fromBaseUnits(BRIDGE_FLOOR.exec(error.message)?.[1], origin.decimals)
          : null;
      if (floor === null) throw error;
      return { limit: "below", minFrom: Math.max(floor, this.#minimum(from)), maxFrom: null };
    }
    const quote = requireObject(answer, "quote");
    return {
      amount: requireAmount(quote, "amountOutFormatted"),
      rateId: null,
      validUntil: null,
      warning: null,
      depositFee: null,
      withdrawalFee: fromBaseUnits(quote.withdrawFee, to.decimals),
      speedMinutes: minutesOf(quote.timeEstimate),
    };
  }

  async #readStatus(id: string): Promise<ExchangeStatus> {
    const query = new URLSearchParams({ depositAddress: id });
    const data = objectOrNull(await this.#call(`/v0/status?${query}`, {}, this.#readBudget));
    if (data === null) throw new GatewayError(502, `${ONECLICK_NAME} answered with something other than an object.`);
    const state = requireString(data, "status");
    const known = STATES.get(state);
    // A state that the app does not know would show as a swap in an unknown state; the relay says so instead.
    if (known === undefined) throw new GatewayError(502, `${ONECLICK_NAME} answered with an unknown state.`);
    const quoteResponse = objectOrNull(data.quoteResponse);
    const quote = objectOrNull(quoteResponse?.quote);
    const request = objectOrNull(quoteResponse?.quoteRequest);
    const details = objectOrNull(data.swapDetails);
    const deposits = hashesOf(details?.originChainTxHashes);
    // The time to send is the deadline of the request alone; the deadline of the quote means another thing, so an
    // answer without the first names no time (R-18). Past it 1Click keeps saying that it waits, so the app must say
    // that the time ran out, so that nobody sends to a swap that no longer swaps; but never while a deposit is in,
    // which 1Click holds and refunds (R-14).
    const deadline = stringOrNull(request?.deadline);
    const deadlineAt = deadline === null ? null : Date.parse(deadline);
    const ranOut =
      known === "waiting" &&
      deposits.length === 0 &&
      deadlineAt !== null &&
      Number.isFinite(deadlineAt) &&
      deadlineAt <= this.#now();
    return {
      status: ranOut ? EXPIRED : known,
      amountTo: known === "finished" ? amountOrNull(details?.amountOutFormatted) : null,
      expectedAmountTo: amountOrNull(quote?.amountOutFormatted),
      payinHash: deposits[0] ?? null,
      payoutHash: hashesOf(details?.destinationChainTxHashes)[0] ?? null,
      refundAddress: stringOrNull(request?.refundTo),
      // NOT CHECKED: which transaction of the chain of origin 1Click lists for a refund.
      refundHash: null,
      refundAmount: known === "refunded" ? amountOrNull(details?.refundedAmountFormatted) : null,
      updatedAt: stringOrNull(data.updatedAt),
      validUntil: deadline,
    };
  }

  /** One quote: dry for an estimate, real for a swap. The fields of the answer with the body sent, or the error of 1Click. */
  async #quote(
    dry: boolean,
    origin: Token,
    to: Token,
    fromAmount: string,
    recipient: string,
    refundTo: string,
    budget: CallLimiter = dry ? this.#estimateBudget : this.#creationBudget,
  ): Promise<{ answer: Json; sent: Json }> {
    const sent: Json = {
      dry,
      swapType: SWAP_TYPE,
      slippageTolerance: ONECLICK_SLIPPAGE_BPS,
      originAsset: origin.id,
      depositType: DEPOSIT_TYPE,
      destinationAsset: to.id,
      amount: toBaseUnits(fromAmount, origin.decimals),
      refundTo,
      refundType: REFUND_TYPE,
      recipient,
      recipientType: RECIPIENT_TYPE,
      deadline: new Date(this.#now() + ONECLICK_DEADLINE_MS).toISOString(),
      referral: ONECLICK_REFERRAL,
      quoteWaitingTimeMs: ONECLICK_QUOTE_WAIT_MS,
    };
    const answer = objectOrNull(await this.#call("/v0/quote", { method: "POST", body: JSON.stringify(sent) }, budget));
    if (answer === null) throw new GatewayError(502, `${ONECLICK_NAME} answered with something other than an object.`);
    return { answer, sent };
  }

  /** One call to the API out of [budget]: the JSON of its answer, or the error of the answer. */
  async #call(path: string, init: { method?: string; body?: string }, budget: CallLimiter): Promise<unknown> {
    if (!budget.take()) throw new GatewayError(503, "The relay is busy. Try again in a moment.");
    const headers: Record<string, string> = { accept: "application/json", "content-type": "application/json" };
    if (this.#apiKey !== null) headers.authorization = `Bearer ${this.#apiKey}`;
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${ONECLICK_BASE_URL}${path}`, {
        method: init.method ?? "GET",
        body: init.body,
        headers,
        // A redirect would carry the key and the body to another host, so the relay follows none.
        redirect: "error",
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS + ONECLICK_QUOTE_WAIT_MS),
      });
    } catch {
      throw new GatewayError(504, `${ONECLICK_NAME} did not answer.`);
    }
    try {
      text = await response.text();
    } catch {
      throw new GatewayError(502, `The answer of ${ONECLICK_NAME} could not be read.`);
    }
    let data: unknown = null;
    let parsed = false;
    try {
      data = JSON.parse(text);
      parsed = true;
    } catch {
      // A refusal of the gateway in front of 1Click may come as plain text.
    }
    if (!response.ok) {
      const fields = objectOrNull(data);
      // Text that parsed as JSON is no sentence for the user; plain text of a gateway may be.
      const fallback = parsed
        ? response.statusText || `HTTP ${String(response.status)}`
        : text.trim() || response.statusText;
      throw new UpstreamError(response.status, refusalText(fields, fallback), ONECLICK_NAME, fields);
    }
    return data;
  }
}
