// The HTTP interface of the relay for the app. It holds the API keys of the exchangers, so that no key ever sits in the
// app, and it forwards only the calls of the bridge, with checked input: receive, a coin on Robinhood Chain into XMR,
// and pay, an amount of a coin of origin, XMR on Monero, STRK on Starknet, or ZEC on Zcash (from 13 Oct 2026), into a coin for an
// address on Robinhood Chain at a fixed or a floating rate. It also holds the key of Blockscout for the privacy scan
// of an address on Robinhood Chain, so that the explorer sees the relay and not the user. It writes no log of a
// request: no amount, no address, and no id leaves it except toward an exchanger or Blockscout and back to the app.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { EVM_ADDRESS_PATTERN, type ChainScanner } from "./scan.mts";
import {
  CHAIN_ASSET_NAMES,
  FROM_ASSET_DECIMALS,
  FROM_ASSET_LABELS,
  FROM_ASSET_NAMES,
  GatewayError,
  PAY_RATE_NAMES,
  PROVIDER_IDS,
  UpstreamError,
  type ChainAsset,
  type CreatedExchange,
  type Exchanger,
  type FromAsset,
  type PairNames,
  type PayExchanger,
  type PayRate,
  type ProviderId,
} from "./exchanger.mts";
import { isStarknetAddress, sameStarknetAddress } from "./starknet.mts";
import { isZcashTransparentAddress } from "./zcash.mts";
import {
  AMOUNT_MATCH_TOLERANCE,
  MAX_BODY_BYTES,
  MAX_FORWARDED_MESSAGE_CHARS,
  SWAP_TOKENS_REQUIRED,
  checkOrigin,
} from "./config.mts";
import {
  CREATION_KEY_HEADER,
  CreationKeyInvalid,
  CreationKeyReused,
  CreationKeysFull,
  type CreationKeys,
} from "./creations.mts";
import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  SIGNATURE_V2_HEADER,
  readNonce,
  requestHash,
  type AnswerSigner,
} from "./signing.mts";
import { SWAP_TOKEN_HEADER, type SwapTokens } from "./tokens.mts";

/** The parts of the relay: the exchanger, the scanner of addresses when the relay has a key for one, the read tokens
 * of swaps, the creations under the keys of the app, the signer of the answers, and the origins of the web app. */
export interface RelayParts {
  /** ChangeNOW: the exchanger of receive, and of pay when the app names no other provider. */
  exchanger: Exchanger;
  /** SimpleSwap, the second exchanger of pay, or null when the relay has no key for it. */
  simpleswap: PayExchanger | null;
  /** The 1Click API of NEAR Intents, the exchanger of Starknet and Zcash, or null in a relay without it (the tests). */
  oneclick: PayExchanger | null;
  scanner: ChainScanner | null;
  tokens: SwapTokens;
  creations: CreationKeys;
  signer: AnswerSigner;
  /** The origins of the web app, which the relay answers from a browser; none keeps every web page out. */
  allowedOrigins: readonly string[];
}

/** An amount as the app writes it: digits, and at most 18 decimals after a point. */
const AMOUNT_PATTERN = /^\d{1,9}(\.\d{1,18})?$/;

/**
 * A standard address or a subaddress of the Monero mainnet: 95 characters of base58, starting with 4 or 8. The app
 * checks the checksum itself; the relay only keeps text of another shape away from ChangeNOW.
 */
const MONERO_ADDRESS_PATTERN = /^[48][1-9A-HJ-NP-Za-km-z]{94}$/;

/** A deposit address of ChangeNOW for XMR: a standard address or a subaddress of mainnet, or an integrated address. */
const MONERO_DEPOSIT_PATTERN = /^(?:[48][1-9A-HJ-NP-Za-km-z]{94}|4[1-9A-HJ-NP-Za-km-z]{105})$/;

/**
 * An id of an exchange, such as 3a2360771439a3 at ChangeNOW or pch7l7kd1v2mzh1 at SimpleSwap, whose rate ids hold "_"
 * as well, or the deposit address of a swap at 1Click, which is how 1Click names a swap: 0x and up to 64 hex digits on
 * Starknet, or 35 characters of base58 on Zcash.
 * A created exchange with an id of another form is refused before the app gets a token for it (R-08 of the scan of
 * 12 Oct 2026), so that a swap the app holds can always be read.
 */
const EXCHANGE_ID_PATTERN = /^[0-9a-zA-Z_-]{6,128}$/;

/** The id of a fixed rate at ChangeNOW: base64 text, a few hundred characters long. */
const RATE_ID_PATTERN = /^[A-Za-z0-9+/=_-]{8,1024}$/;

const SWAP_PATH = /^\/v1\/swaps\/([^/]+)$/;

/** The only type of body that the relay reads. A browser cannot send it to another site without asking first. */
const JSON_MEDIA_TYPE = "application/json";

/** The answers of an exchanger that refuse the request itself; their text tells the user what to change. */
const REFUSAL_STATUSES = new Set([400, 404, 422]);

/**
 * What a browser asks before a request of the web app, and what it may read of the answer: the headers that the app
 * sends, and the signatures of the answer, which a browser keeps from a page unless the relay names them.
 */
const REQUEST_HEADERS_ALLOWED = ["content-type", NONCE_HEADER, CREATION_KEY_HEADER, SWAP_TOKEN_HEADER].join(", ");
const ANSWER_HEADERS_EXPOSED = [SIGNATURE_HEADER, SIGNATURE_V2_HEADER].join(", ");
const METHODS_ALLOWED = "GET, POST";

/** A browser keeps the answer to its question about a request this long, in seconds. */
const PREFLIGHT_MAX_AGE_S = 600;

/** The text of a refusal of a web page. */
const PAGE_REFUSED = "The relay answers the Kranox app only.";

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The headers of the signatures of an answer with [status] and the text [body]. */
type Signatures = (status: number, body: string) => Record<string, string>;

/** Sends [body] as JSON with its [signatures], and, to the web app at [origin], with the headers that let it read. */
function send(
  response: ServerResponse,
  status: number,
  body: unknown,
  signatures: Signatures,
  origin: string | null,
): void {
  const text = JSON.stringify(body);
  // Every answer depends on the origin of the request, so every answer says so, whether a cache keeps it or not.
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    vary: "origin",
    ...signatures(status, text),
    ...(origin === null ? {} : corsHeaders(origin)),
  });
  response.end(text);
}

/** The headers that let the web app at [origin] read an answer, with the signatures of the answer among them. */
function corsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-expose-headers": ANSWER_HEADERS_EXPOSED,
  };
}

/** Answers the question of a browser about a request of the web app at [origin]: what it may send. */
function preflight(response: ServerResponse, origin: string): void {
  response.writeHead(204, {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": METHODS_ALLOWED,
    "access-control-allow-headers": REQUEST_HEADERS_ALLOWED,
    "access-control-max-age": String(PREFLIGHT_MAX_AGE_S),
    "cache-control": "no-store",
    vary: "origin",
  });
  response.end();
}

/**
 * The signatures of the answers to [request] with [nonce]: the first form, and the second once the relay has the
 * hash of the body of the request. A request without a nonce, from an app before 0.3.1, which checks no signature,
 * gets none, so that the relay signs nothing over an empty nonce (relay O-004 of the second security review).
 */
function signatures(
  signer: AnswerSigner,
  request: IncomingMessage,
  nonce: string,
  hash: () => string | null,
): Signatures {
  return (status, body) => {
    if (nonce === "") return {};
    const headers: Record<string, string> = { [SIGNATURE_HEADER]: signer.sign(nonce, body) };
    const requestHash = hash();
    if (requestHash !== null) {
      const method = request.method ?? "GET";
      const target = request.url ?? "/";
      headers[SIGNATURE_V2_HEADER] = signer.signAnswer({ nonce, method, target, requestHash, status, body });
    }
    return headers;
  };
}

function readAsset(value: unknown): ChainAsset {
  const asset = CHAIN_ASSET_NAMES.find((name) => name === value);
  if (asset !== undefined) return asset;
  throw new RequestError(400, `The asset must be one of: ${CHAIN_ASSET_NAMES.join(", ")}.`);
}

function readRate(value: unknown): PayRate {
  const rate = PAY_RATE_NAMES.find((name) => name === value);
  if (rate !== undefined) return rate;
  throw new RequestError(400, `The rate must be one of: ${PAY_RATE_NAMES.join(", ")}.`);
}

/**
 * The exchanger of pay that the app names, or ChangeNOW when the request has no provider at all, as the Mac app sends
 * it. An empty or null provider is a fault of a client, not a choice, and gets a refusal (R-04 of the scan of 12 Oct
 * 2026).
 */
function readProvider(parts: RelayParts, value: unknown): { id: ProviderId; exchanger: PayExchanger } {
  if (value === undefined) return { id: "changenow", exchanger: parts.exchanger };
  const id = PROVIDER_IDS.find((name) => name === value);
  if (id === undefined) throw new RequestError(400, `The provider must be one of: ${PROVIDER_IDS.join(", ")}.`);
  if (id === "changenow") return { id, exchanger: parts.exchanger };
  if (id === "oneclick") {
    if (parts.oneclick === null) throw new RequestError(503, "The relay has no NEAR Intents yet.");
    return { id, exchanger: parts.oneclick };
  }
  if (parts.simpleswap === null) throw new RequestError(503, "The relay has no key for SimpleSwap yet.");
  return { id, exchanger: parts.simpleswap };
}

/**
 * The coin of origin of a payment, or XMR when the request names none, as the Mac app sends it. An empty or null one
 * is a fault of a client, not a choice.
 */
function readFrom(value: unknown): FromAsset {
  if (value === undefined) return "xmr";
  const from = FROM_ASSET_NAMES.find((name) => name === value);
  if (from !== undefined) return from;
  throw new RequestError(400, `The coin of origin (from) must be one of: ${FROM_ASSET_NAMES.join(", ")}.`);
}

/**
 * The coin of origin of a quote or a creation: the one named, or XMR when the amount comes as xmrAmount, as the Mac
 * app writes it, and nothing else: an amount under the name of every coin without a coin names none (R-19 of the
 * scan of 13 Oct 2026).
 */
function readFromOfAmount(from: unknown, xmrAmount: unknown): FromAsset {
  if (from === undefined && (xmrAmount === undefined || xmrAmount === null)) {
    throw new RequestError(400, `The coin of origin (from) must be one of: ${FROM_ASSET_NAMES.join(", ")}.`);
  }
  return readFrom(from);
}

/** How many decimals [amount] writes after its point. */
function decimalsOf(amount: string): number {
  const point = amount.indexOf(".");
  return point < 0 ? 0 : amount.length - point - 1;
}

/** Refuses a pair that [exchanger] does not serve before any call reaches it: a coin of origin or a rate not its own. */
function checkServes(exchanger: PayExchanger, from: FromAsset, rate: PayRate): void {
  if (!exchanger.origins.includes(from)) {
    throw new RequestError(422, `${exchanger.name} does not take ${FROM_ASSET_LABELS[from]}.`);
  }
  if (!exchanger.rates.includes(rate)) throw new RequestError(422, `${exchanger.name} has no ${rate} rate.`);
}

function readAmount(value: unknown): string {
  if (typeof value !== "string" || !AMOUNT_PATTERN.test(value) || Number(value) <= 0) {
    throw new RequestError(400, "The amount must be a number above zero, with a point for decimals.");
  }
  return value;
}

/**
 * The amount of the coin of origin of a request: fromAmount, or xmrAmount as the Mac app writes an amount of XMR. An
 * amount of another coin under the name of XMR is a fault of a client, and so are two amounts that differ.
 */
function readFromAmount(from: FromAsset, fromAmount: unknown, xmrAmount: unknown): string {
  let amount: string;
  if (xmrAmount === undefined || xmrAmount === null) {
    amount = readAmount(fromAmount);
  } else {
    if (from !== "xmr") {
      throw new RequestError(400, "xmrAmount is an amount of XMR; an amount of another coin goes in fromAmount.");
    }
    if (fromAmount !== undefined && fromAmount !== null && fromAmount !== xmrAmount) {
      throw new RequestError(400, "fromAmount and xmrAmount differ; send one of them.");
    }
    amount = readAmount(xmrAmount);
  }
  // A coin holds only so many decimals: more would be a number the chain cannot carry (R-21).
  const decimals = FROM_ASSET_DECIMALS[from];
  if (decimalsOf(amount) > decimals) {
    throw new RequestError(400, `An amount of ${FROM_ASSET_LABELS[from]} has at most ${decimals} decimals.`);
  }
  return amount;
}

/**
 * An answer of pay with, for XMR, the names of its amounts that the Mac app reads (xmrAmount, minXmr, maxXmr) beside
 * the names that hold for every coin of origin (fromAmount, minFrom, maxFrom).
 */
function withXmrNames(from: FromAsset, body: Record<string, unknown>): Record<string, unknown> {
  if (from !== "xmr") return body;
  const names: Record<string, unknown> = {};
  if ("fromAmount" in body) names.xmrAmount = body.fromAmount;
  if ("minFrom" in body) names.minXmr = body.minFrom;
  if ("maxFrom" in body) names.maxXmr = body.maxFrom;
  return { ...body, ...names };
}

/**
 * The origin of the web app of Kranox when the request comes from it, or null for the Mac app, which sends JSON and
 * no header of a browser. A browser adds Origin or Sec-Fetch-Site to a request from a page, and a page that posts
 * plain text needs no permission first, so the relay refuses every page but the web app at the origins of its
 * settings: no other web page can make its visitors create exchanges under the key of the relay.
 */
function pageOrigin(request: IncomingMessage, allowedOrigins: readonly string[]): string | null {
  const origin = header(request, "origin");
  if (origin !== undefined) {
    if (allowedOrigins.includes(origin)) return origin;
    throw new RequestError(403, PAGE_REFUSED);
  }
  if (request.headers["sec-fetch-site"] !== undefined) throw new RequestError(403, PAGE_REFUSED);
  return null;
}

function requireJson(request: IncomingMessage): void {
  const mediaType = (request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) {
    throw new RequestError(415, `The request body must have the type ${JSON_MEDIA_TYPE}.`);
  }
}

function amountsMatch(sent: string, answered: number): boolean {
  const expected = Number(sent);
  return Math.abs(expected - answered) <= AMOUNT_MATCH_TOLERANCE * Math.max(Math.abs(expected), Math.abs(answered));
}

/** A name that the exchanger left out passes; a name that it gave must be the one of the request. */
function nameMatches(answered: string | null, expected: string): boolean {
  return answered === null || answered.toLowerCase() === expected.toLowerCase();
}

/** Whether a created exchange carries the names of the pair of its request, as the exchanger gives them. */
function pairMatches(created: CreatedExchange, names: PairNames): boolean {
  return (
    nameMatches(created.fromCurrency, names.from.currency) &&
    nameMatches(created.fromNetwork, names.from.network) &&
    nameMatches(created.toCurrency, names.to.currency) &&
    nameMatches(created.toNetwork, names.to.network) &&
    nameMatches(created.flow, names.flow)
  );
}

/**
 * Whether the exchanger recorded the refund address of the request: the same one, compared by [same], or none when
 * the request named none.
 */
function refundMatches(
  created: CreatedExchange,
  requested: string | null,
  same: (a: string, b: string) => boolean,
): boolean {
  // The answer of v2 carries the refund address that the request specified (CHECKED 10 Oct 2026, the API
  // documentation of ChangeNOW: "Refund address (if you specified it)"), so one that it leaves out is no match: the app
  // would promise a refund that ChangeNOW never recorded (the sharp-edges scan of 10 Oct 2026). An empty one is none.
  const recorded = recordedRefund(created);
  return requested === null ? recorded === null : recorded !== null && same(recorded, requested);
}

/** The refund address that the exchanger recorded for a swap, which the relay hands the app to compare (wallet O-003). */
function recordedRefund(created: CreatedExchange): string | null {
  return created.refundAddress || null;
}

const sameText = (a: string, b: string): boolean => a === b;

/** Two addresses on Robinhood Chain: the same in any case of their hex digits. */
const sameEvmAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The addresses of each chain of origin: whether a text is one that a refund can go to, with the words of a refusal;
 * whether a text is one that a deposit can go to; and whether two name the same account. The app checks the checksum
 * of a Monero address itself; the relay keeps text of another shape away from the exchangers.
 */
const ORIGIN_ADDRESSES: Record<
  FromAsset,
  {
    isRefund: (text: string) => boolean;
    refundWords: string;
    isDeposit: (text: string) => boolean;
    depositWords: string;
    same: (a: string, b: string) => boolean;
  }
> = {
  xmr: {
    isRefund: (text) => MONERO_ADDRESS_PATTERN.test(text),
    refundWords: "a Monero mainnet address",
    isDeposit: (text) => MONERO_DEPOSIT_PATTERN.test(text),
    depositWords: "a Monero mainnet address",
    same: sameText,
  },
  strk: {
    isRefund: isStarknetAddress,
    refundWords: "a Starknet account address: 0x and up to 64 hex digits, not an address of an EVM chain",
    isDeposit: isStarknetAddress,
    depositWords: "a Starknet address",
    same: sameStarknetAddress,
  },
  // The exchangers take and pay ZEC at transparent addresses alone; a shielded one would take no refund.
  zec: {
    isRefund: isZcashTransparentAddress,
    refundWords: "a transparent Zcash address: 35 characters that start with t1 or t3",
    isDeposit: isZcashTransparentAddress,
    depositWords: "a transparent Zcash address",
    same: sameText,
  },
};

/** Why an exchange of receive differs from its request, or null when it matches. */
function receiveMismatch(
  exchanger: Exchanger,
  created: CreatedExchange,
  asset: ChainAsset,
  amount: string,
  address: string,
  refundAddress: string | null,
): string | null {
  const name = exchanger.name;
  if (!EVM_ADDRESS_PATTERN.test(created.payinAddress)) {
    return `${name} gave a deposit address that is not a Robinhood Chain address.`;
  }
  if (created.payoutAddress !== address) return `${name} made the exchange for another Monero address.`;
  if (!refundMatches(created, refundAddress, sameEvmAddress)) {
    return `${name} made the exchange with another refund address.`;
  }
  if (!amountsMatch(amount, created.fromAmount)) return `${name} made the exchange for another amount.`;
  if (!pairMatches(created, exchanger.receiveNames(asset)))
    return `${name} made the exchange for another pair of coins.`;
  return null;
}

/** Why an exchange of pay differs from its request, or null when it matches. */
function payMismatch(
  exchanger: PayExchanger,
  created: CreatedExchange,
  from: FromAsset,
  asset: ChainAsset,
  rate: PayRate,
  fromAmount: string,
  address: string,
  refundAddress: string,
): string | null {
  const name = exchanger.name;
  const origin = ORIGIN_ADDRESSES[from];
  if (!origin.isDeposit(created.payinAddress)) {
    return `${name} gave a deposit address that is not ${origin.depositWords}.`;
  }
  if (!sameEvmAddress(created.payoutAddress, address)) return `${name} made the exchange for another recipient.`;
  if (!refundMatches(created, refundAddress, origin.same)) {
    return `${name} made the exchange with another refund address.`;
  }
  if (!amountsMatch(fromAmount, created.fromAmount)) {
    return `${name} made the exchange for another amount of ${FROM_ASSET_LABELS[from]}.`;
  }
  if (!pairMatches(created, exchanger.payNames(from, asset, rate)))
    return `${name} made the exchange for another pair of coins.`;
  return null;
}

/**
 * Refuses an exchange that [exchanger] made other than the request, or with an id of a form the relay cannot read
 * back, with its id, so that support can find it.
 */
function checkCreated(exchanger: PayExchanger, created: CreatedExchange, mismatch: string | null): void {
  if (mismatch !== null) throw new GatewayError(502, mismatch, created.id);
  if (!EXCHANGE_ID_PATTERN.test(created.id)) {
    throw new GatewayError(502, `${exchanger.name} gave an id of a form the relay does not take.`, created.id);
  }
}

/** One header of the request as text, or undefined when the request has none. */
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** The bytes of the body of a request; a request without a body has none. */
async function readRaw(request: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, "The request is too large.");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function parseBody(raw: Buffer): Record<string, unknown> {
  try {
    const data: unknown = JSON.parse(raw.toString("utf8"));
    if (typeof data === "object" && data !== null && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // Falls through to the error below.
  }
  throw new RequestError(400, "The request body must be a JSON object.");
}

async function quote(exchanger: Exchanger, url: URL): Promise<unknown> {
  const asset = readAsset(url.searchParams.get("asset"));
  const amount = readAmount(url.searchParams.get("amount"));
  const minAmount = await exchanger.minAmount(asset);
  // Below the minimum ChangeNOW refuses an estimate, so the app gets the minimum alone.
  if (Number(amount) < minAmount) {
    return { asset, amount, minAmount, estimatedXmr: null, speedMinutes: null, warning: null };
  }
  const estimate = await exchanger.estimate(asset, amount);
  return {
    asset,
    amount,
    minAmount,
    estimatedXmr: estimate.amount,
    speedMinutes: estimate.speedMinutes,
    warning: estimate.warning,
  };
}

async function createSwap(parts: RelayParts, request: IncomingMessage, raw: Buffer): Promise<unknown> {
  const body = parseBody(raw);
  const asset = readAsset(body.asset);
  const amount = readAmount(body.amount);
  if (typeof body.address !== "string" || !MONERO_ADDRESS_PATTERN.test(body.address)) {
    throw new RequestError(400, "The address must be a Monero mainnet address.");
  }
  let refundAddress: string | null = null;
  if (body.refundAddress !== undefined && body.refundAddress !== null && body.refundAddress !== "") {
    if (typeof body.refundAddress !== "string" || !EVM_ADDRESS_PATTERN.test(body.refundAddress)) {
      throw new RequestError(400, "The refund address must be a Robinhood Chain address: 0x and 40 hex digits.");
    }
    refundAddress = body.refundAddress;
  }
  const address = body.address;
  const fields = { route: "receive", asset, amount, address, refundAddress };
  return parts.creations.run(header(request, CREATION_KEY_HEADER), fields, async () => {
    const created = await parts.exchanger.create(asset, amount, address, refundAddress);
    // The app shows the deposit address as a code and the amount as "Send exactly", so the relay passes on only an
    // exchange of the coin and the amount of the request, into the subaddress of the request.
    checkCreated(
      parts.exchanger,
      created,
      receiveMismatch(parts.exchanger, created, asset, amount, address, refundAddress),
    );
    // The app compares the refund address that ChangeNOW recorded with the one that it sent (wallet O-003 of the second
    // security review).
    return {
      id: created.id,
      asset,
      amount: created.fromAmount,
      estimatedXmr: created.toAmount,
      depositAddress: created.payinAddress,
      payoutAddress: created.payoutAddress,
      refundAddress: recordedRefund(created),
      readToken: parts.tokens.issue(created.id, "changenow"),
    };
  });
}

async function payRange(parts: RelayParts, url: URL): Promise<unknown> {
  const { id: provider, exchanger } = readProvider(parts, url.searchParams.get("provider") ?? undefined);
  const from = readFrom(url.searchParams.get("from") ?? undefined);
  const asset = readAsset(url.searchParams.get("asset"));
  const rate = readRate(url.searchParams.get("rate"));
  checkServes(exchanger, from, rate);
  const range = await exchanger.payRange(from, asset, rate);
  return withXmrNames(from, { provider, from, asset, rate, minFrom: range.minFrom, maxFrom: range.maxFrom });
}

async function payQuote(parts: RelayParts, url: URL): Promise<unknown> {
  const { id: provider, exchanger } = readProvider(parts, url.searchParams.get("provider") ?? undefined);
  const xmrAmountParam = url.searchParams.get("xmrAmount") ?? undefined;
  const from = readFromOfAmount(url.searchParams.get("from") ?? undefined, xmrAmountParam);
  const asset = readAsset(url.searchParams.get("asset"));
  const rate = readRate(url.searchParams.get("rate"));
  const fromAmount = readFromAmount(from, url.searchParams.get("fromAmount") ?? undefined, xmrAmountParam);
  checkServes(exchanger, from, rate);
  const estimate = await exchanger.payEstimate(from, asset, rate, fromAmount);
  // An amount outside the range of the rate gets no estimate; the app shows the range of the coin of origin instead.
  if ("limit" in estimate) {
    return withXmrNames(from, {
      provider,
      from,
      asset,
      rate,
      fromAmount,
      amount: null,
      rateId: null,
      validUntil: null,
      warning: null,
      depositFee: null,
      withdrawalFee: null,
      speedMinutes: null,
      limit: estimate.limit,
      minFrom: estimate.minFrom,
      maxFrom: estimate.maxFrom,
    });
  }
  return withXmrNames(from, {
    provider,
    from,
    asset,
    rate,
    fromAmount,
    amount: estimate.amount,
    rateId: estimate.rateId,
    validUntil: estimate.validUntil,
    warning: estimate.warning,
    depositFee: estimate.depositFee,
    withdrawalFee: estimate.withdrawalFee,
    speedMinutes: estimate.speedMinutes,
    limit: null,
    minFrom: null,
    maxFrom: null,
  });
}

async function createPay(parts: RelayParts, request: IncomingMessage, url: URL, raw: Buffer): Promise<unknown> {
  // The provider of a creation stands in the body, with the rest of the request, and nowhere else (R-04).
  if (url.searchParams.has("provider")) {
    throw new RequestError(400, "The provider of a creation goes in the body of the request, not in its query.");
  }
  const body = parseBody(raw);
  const { id: provider, exchanger } = readProvider(parts, body.provider);
  const from = readFromOfAmount(body.from, body.xmrAmount);
  const asset = readAsset(body.asset);
  const rate = readRate(body.rate);
  const fromAmount = readFromAmount(from, body.fromAmount, body.xmrAmount);
  checkServes(exchanger, from, rate);
  const address = body.address;
  if (typeof address !== "string" || !EVM_ADDRESS_PATTERN.test(address)) {
    throw new RequestError(400, "The address must be a Robinhood Chain address: 0x and 40 hex digits.");
  }
  const origin = ORIGIN_ADDRESSES[from];
  if (typeof body.refundAddress !== "string" || !origin.isRefund(body.refundAddress)) {
    throw new RequestError(400, `The refund address must be ${origin.refundWords}.`);
  }
  // A fixed rate needs the id of its rate; a floating rate has none.
  let rateId: string | null = null;
  if (rate === "fixed") {
    if (typeof body.rateId !== "string" || !RATE_ID_PATTERN.test(body.rateId)) {
      throw new RequestError(400, "The rate id has the wrong form.");
    }
    rateId = body.rateId;
  } else if (body.rateId !== undefined && body.rateId !== null) {
    throw new RequestError(400, "A floating rate takes no rate id.");
  }
  const refundAddress = body.refundAddress;
  const fields = { route: "pay", provider, from, asset, rate, fromAmount, address, refundAddress, rateId };
  return parts.creations.run(header(request, CREATION_KEY_HEADER), fields, async () => {
    const created = await exchanger.createPay(from, asset, rate, fromAmount, address, refundAddress, rateId);
    // The app sends the coins to the deposit address and trusts the recipient, so the relay passes on nothing else.
    checkCreated(
      exchanger,
      created,
      payMismatch(exchanger, created, from, asset, rate, fromAmount, address, refundAddress),
    );
    // The app compares the refund address that the exchanger recorded with the one that it sent (wallet O-003 of the
    // second security review).
    return withXmrNames(from, {
      id: created.id,
      provider,
      from,
      asset,
      amount: created.toAmount,
      fromAmount: created.fromAmount,
      depositAddress: created.payinAddress,
      payoutAddress: created.payoutAddress,
      refundAddress: recordedRefund(created),
      // The time to send, when the exchanger names one at the creation, so that the app shows it at once (R-25).
      validUntil: created.validUntil,
      readToken: parts.tokens.issue(created.id, provider),
    });
  });
}

/**
 * Lets a read of a swap pass when it carries the token of the swap, or, while the older apps run, no token at all; a
 * token of another swap never passes.
 */
function checkSwapToken(parts: RelayParts, request: IncomingMessage, id: string, provider: ProviderId): void {
  const token = header(request, SWAP_TOKEN_HEADER);
  if (token === undefined) {
    if (SWAP_TOKENS_REQUIRED) throw new RequestError(401, "The read of a swap needs its token.");
    return;
  }
  if (!parts.tokens.matches(id, provider, token)) {
    throw new RequestError(403, "The token does not belong to this swap.");
  }
}

async function readSwap(parts: RelayParts, request: IncomingMessage, url: URL, id: string): Promise<unknown> {
  const { id: provider, exchanger } = readProvider(parts, url.searchParams.get("provider") ?? undefined);
  if (!EXCHANGE_ID_PATTERN.test(id)) throw new RequestError(400, "The swap id has the wrong form.");
  checkSwapToken(parts, request, id, provider);
  const status = await exchanger.status(id);
  // Each step of a swap carries its own facts: the deposit hash, the coin that is expected and then sent with its
  // hash, and, when the swap goes wrong, the refund with its amount and hash. The relay passes on only what the app
  // shows, and no address: the app knows its own refund address. The id lets the app compare the state with the swap
  // that it asked for.
  return {
    id,
    provider,
    status: status.status,
    expectedOut: status.expectedAmountTo,
    amountOut: status.amountTo,
    depositHash: status.payinHash,
    payoutHash: status.payoutHash,
    refundHash: status.refundHash,
    refundAmount: status.refundAmount,
    updatedAt: status.updatedAt,
    validUntil: status.validUntil,
  };
}

/**
 * Answers whether the relay can use its keys: one call to ChangeNOW, which the cache of the minimum keeps rare, and
 * one check of each other exchanger that has one, which their caches keep rare too (R-11 of the scan of 12 Oct 2026).
 */
async function ready(parts: RelayParts): Promise<unknown> {
  await parts.exchanger.minAmount("eth");
  for (const exchanger of [parts.simpleswap, parts.oneclick]) {
    if (exchanger?.ready !== undefined) await exchanger.ready();
  }
  return { ok: true };
}

/** The public history of an address on Robinhood Chain, for the privacy scan of the app. */
async function scanAddress(scanner: ChainScanner | null, url: URL): Promise<unknown> {
  if (scanner === null) throw new GatewayError(503, "The relay cannot scan addresses yet.");
  const address = url.searchParams.get("address") ?? "";
  if (!EVM_ADDRESS_PATTERN.test(address)) {
    throw new RequestError(400, "The address must be 0x and 40 hexadecimal digits.");
  }
  return scanner.scan(address);
}

async function route(parts: RelayParts, request: IncomingMessage, raw: Buffer): Promise<[number, unknown]> {
  const { exchanger, scanner } = parts;
  const url = new URL(request.url ?? "/", "http://relay");
  const method = request.method ?? "GET";
  if (method === "POST") requireJson(request);
  if (method === "GET" && url.pathname === "/health") return [200, { ok: true }];
  if (method === "GET" && url.pathname === "/ready") return [200, await ready(parts)];
  if (method === "GET" && url.pathname === "/v1/receive/quote") return [200, await quote(exchanger, url)];
  if (method === "POST" && url.pathname === "/v1/receive/swaps") return [201, await createSwap(parts, request, raw)];
  if (method === "GET" && url.pathname === "/v1/pay/range") return [200, await payRange(parts, url)];
  if (method === "GET" && url.pathname === "/v1/pay/quote") return [200, await payQuote(parts, url)];
  if (method === "POST" && url.pathname === "/v1/pay/swaps") return [201, await createPay(parts, request, url, raw)];
  if (method === "GET" && url.pathname === "/v1/scan/robinhood") return [200, await scanAddress(scanner, url)];
  const swap = SWAP_PATH.exec(url.pathname);
  if (method === "GET" && swap) return [200, await readSwap(parts, request, url, decodeURIComponent(swap[1]))];
  throw new RequestError(404, "The relay has no such route.");
}

/** The code points of ASCII control characters: 0 to 31, and 127. */
function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/** Text of an exchanger for the app: one line, without control characters, cut short. */
function forwarded(message: string): string {
  const line = Array.from(message, (char) => (isControl(char) ? " " : char))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  return line.length > MAX_FORWARDED_MESSAGE_CHARS ? `${line.slice(0, MAX_FORWARDED_MESSAGE_CHARS - 1)}…` : line;
}

/**
 * What the app learns of an error answer of an exchanger. A refusal of the request, such as an amount below the
 * minimum, reaches it as a refusal with the text of the exchanger. A refused key, a spent budget of calls, and a
 * failure of the exchanger reach it with a fixed text of the relay, so that no message about the account of Kranox
 * leaves the relay.
 */
function upstreamAnswer(error: UpstreamError): [number, string] {
  if (REFUSAL_STATUSES.has(error.status)) return [422, forwarded(error.message)];
  if (error.status === 429) return [503, `${error.service} is busy. Try again in a minute.`];
  if (error.status === 401 || error.status === 403) return [502, `The relay cannot use ${error.service} right now.`];
  return [502, `${error.service} failed.`];
}

/** The status and the body that answer a failure of a request. */
function failure(error: unknown): [number, unknown] {
  if (error instanceof RequestError) return [error.status, { error: error.message }];
  if (error instanceof CreationKeyInvalid) return [400, { error: error.message }];
  if (error instanceof CreationKeyReused) return [422, { error: error.message }];
  if (error instanceof CreationKeysFull) return [503, { error: error.message }];
  if (error instanceof GatewayError) return [error.status, { error: error.message, exchangeId: error.exchangeId }];
  if (error instanceof UpstreamError) {
    const [status, message] = upstreamAnswer(error);
    return [status, { error: message }];
  }
  return [500, { error: "The relay failed." }];
}

/** The relay of the bridge. Throws at once for an origin of the web app that is not one as a browser sends it. */
export function createRelay(parts: RelayParts): Server {
  const allowedOrigins = parts.allowedOrigins.map((origin) => checkOrigin(origin, "The origins of the web app"));
  return createServer((request, response) => {
    const nonce = readNonce(header(request, NONCE_HEADER));
    let hash: string | null = null;
    let origin: string | null = null;
    const signed = signatures(parts.signer, request, nonce, () => hash);
    const answer = (status: number, body: unknown) => send(response, status, body, signed, origin);
    const fail = (error: unknown) => {
      const [status, body] = failure(error);
      answer(status, body);
    };
    try {
      origin = pageOrigin(request, allowedOrigins);
    } catch (error) {
      fail(error);
      return;
    }
    // A browser asks about a request of the web app before it sends it. Nobody else asks.
    if (request.method === "OPTIONS") {
      if (origin === null) fail(new RequestError(404, "The relay has no such route."));
      else preflight(response, origin);
      return;
    }
    // A request of the web app carries a nonce, so that every answer to a page is signed. The apps before 0.3.1,
    // which send no nonce, send no origin either.
    if (origin !== null && nonce === "") {
      fail(new RequestError(400, "A request of the web app needs its nonce."));
      return;
    }
    readRaw(request)
      .then((raw) => {
        hash = requestHash(raw);
        return route(parts, request, raw);
      })
      .then(([status, body]) => answer(status, body), fail);
  });
}
