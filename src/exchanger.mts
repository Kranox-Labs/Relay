// What the relay needs from an exchanger, in one shape for all of them: ChangeNOW serves receive and pay, from 12 Oct
// 2026 SimpleSwap serves pay as a second provider of the web app, and from 13 Oct 2026 the 1Click API of NEAR Intents
// serves pay from Starknet. Pay takes a coin of a chain of origin, XMR on Monero or STRK on Starknet, into a coin on
// Robinhood Chain; the server checks every created exchange against its request with the names that each exchanger
// gives.
import type { Json } from "./json.mts";

/** The coins on Robinhood Chain that the bridge takes in and pays out, in the names of the relay. */
export type ChainAsset = "eth" | "usdg";

export const CHAIN_ASSET_NAMES: readonly ChainAsset[] = ["eth", "usdg"];

/** The coins that pay takes in, in the names of the relay: XMR on Monero, and STRK on Starknet from 13 Oct 2026. */
export type FromAsset = "xmr" | "strk";

export const FROM_ASSET_NAMES: readonly FromAsset[] = ["xmr", "strk"];

/** The coins of origin as the app and the user name them. */
export const FROM_ASSET_LABELS: Record<FromAsset, string> = { xmr: "XMR", strk: "STRK" };

/** The decimals of each coin of origin: an amount with more would be a number the chain cannot hold (R-21). */
export const FROM_ASSET_DECIMALS: Record<FromAsset, number> = { xmr: 12, strk: 18 };

/** The rates of pay that the user chooses from. */
export type PayRate = "fixed" | "floating";

export const PAY_RATE_NAMES: readonly PayRate[] = ["fixed", "floating"];

/** The exchangers of pay, in the names of the relay and of the app. */
export type ProviderId = "changenow" | "simpleswap" | "oneclick";

export const PROVIDER_IDS: readonly ProviderId[] = ["changenow", "simpleswap", "oneclick"];

export interface Estimate {
  amount: number;
  /** Minutes, as "min-max", or null. */
  speedMinutes: string | null;
  warning: string | null;
}

/**
 * The coin that an amount of the coin of origin buys, after the fees of the exchanger. A fixed rate gives the id of the
 * rate and the time until which it holds; a floating rate gives neither, but may give the minutes that a swap usually
 * takes.
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

/** The range of one payment at a rate, in the coin of origin. A floating rate may have no top. */
export interface PayRange {
  minFrom: number;
  maxFrom: number | null;
}

/** An amount that the rate does not take: below or above its range, which the exchanger gives in the coin of origin. */
export interface PayOutOfRange {
  limit: "below" | "above";
  minFrom: number | null;
  maxFrom: number | null;
}

/**
 * An exchange that an exchanger made. The currencies, the networks, and the flow come as the exchanger names them, or
 * null when its answer leaves them out; the server compares them with the names of [PairNames].
 */
export interface CreatedExchange {
  id: string;
  fromAmount: number;
  toAmount: number;
  payinAddress: string;
  payoutAddress: string;
  /** The refund address, or null when the answer of the exchanger leaves it out. */
  refundAddress: string | null;
  fromCurrency: string | null;
  fromNetwork: string | null;
  toCurrency: string | null;
  toNetwork: string | null;
  flow: string | null;
  /** The time until which the exchange takes its deposit, when the exchanger names one at the creation (R-25). */
  validUntil: string | null;
}

/** The state of an exchange: only the facts that the app shows, in the words of the app. */
export interface ExchangeStatus {
  status: string;
  amountTo: number | null;
  expectedAmountTo: number | null;
  payinHash: string | null;
  payoutHash: string | null;
  refundAddress: string | null;
  refundHash: string | null;
  refundAmount: number | null;
  /** A time in ISO 8601, as the exchanger gives it. */
  updatedAt: string | null;
  /** The time until which a fixed rate, or the deposit address of a swap, waits for the deposit; null without one. */
  validUntil: string | null;
}

/** One side of a pair, as the exchanger names it. */
export interface Side {
  currency: string;
  network: string;
}

/** The names of a pair and of its flow at the exchanger, for the check of a created exchange. */
export interface PairNames {
  from: Side;
  to: Side;
  flow: string;
}

/** What the relay needs from an exchanger of pay: an amount of a coin of origin into a coin on Robinhood Chain. */
export interface PayExchanger {
  /** The name of the exchanger as the app and the user see it. */
  readonly name: string;
  /** The coins of origin that the exchanger takes in. The server refuses the others before any call. */
  readonly origins: readonly FromAsset[];
  /** The rates that the exchanger serves. The server refuses the others before any call. */
  readonly rates: readonly PayRate[];
  /** The range of the amount of [from] of one payment into [asset] at [rate]. */
  payRange(from: FromAsset, asset: ChainAsset, rate: PayRate): Promise<PayRange>;
  /** The amount of [asset] on Robinhood Chain that [fromAmount] of [from] buys at [rate]. */
  payEstimate(
    from: FromAsset,
    asset: ChainAsset,
    rate: PayRate,
    fromAmount: string,
  ): Promise<PayEstimate | PayOutOfRange>;
  /**
   * An exchange of [fromAmount] of [from] into [asset] for [address] at [rate]: a fixed rate holds the rate of
   * [rateId], a floating rate takes none.
   */
  createPay(
    from: FromAsset,
    asset: ChainAsset,
    rate: PayRate,
    fromAmount: string,
    address: string,
    refundAddress: string,
    rateId: string | null,
  ): Promise<CreatedExchange>;
  /** The names of the pair of a payment of [from] into [asset] at [rate], as the exchanger gives them in a created exchange. */
  payNames(from: FromAsset, asset: ChainAsset, rate: PayRate): PairNames;
  status(id: string): Promise<ExchangeStatus>;
  /**
   * One cheap call that shows that the exchanger answers the relay, for the route /ready, when the exchanger has one;
   * it throws when the exchanger refuses the relay or has stopped listing a coin.
   */
  ready?(): Promise<void>;
}

/** What the relay needs from the exchanger of receive and of the Mac app: ChangeNOW. The tests answer with a fake. */
export interface Exchanger extends PayExchanger {
  minAmount(asset: ChainAsset): Promise<number>;
  estimate(asset: ChainAsset, amount: string): Promise<Estimate>;
  create(asset: ChainAsset, amount: string, address: string, refundAddress: string | null): Promise<CreatedExchange>;
  /** The names of the pair of receive from [asset], as the exchanger gives them in a created exchange. */
  receiveNames(asset: ChainAsset): PairNames;
}

/**
 * An answer of an exchanger with an error status, such as a refusal of an amount below the minimum. The message is
 * the text of the exchanger; the server decides how much of it reaches the app. [service] names the exchanger.
 */
export class UpstreamError extends Error {
  readonly status: number;
  readonly service: string;

  /** The fields of the answer, when the exchanger answered with an object, such as the range of an amount. */
  readonly details: Json | null;

  constructor(status: number, message: string, service: string, details: Json | null = null) {
    super(message);
    this.status = status;
    this.service = service;
    this.details = details;
  }
}

/**
 * A call to an exchanger that gave the relay no usable answer: no answer in time, an answer that it cannot read, an
 * answer that fails a check of the relay, or a call over the budget of the key. The message is the text of the relay.
 */
export class GatewayError extends Error {
  readonly status: 502 | 503 | 504;

  /** The id of the exchange when the exchanger made one before a check failed, so that support can find it. */
  readonly exchangeId: string | null;

  constructor(status: 502 | 503 | 504, message: string, exchangeId: string | null = null) {
    super(message);
    this.status = status;
    this.exchangeId = exchangeId;
  }
}
