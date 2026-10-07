// The HTTP interface of the relay for the app. It holds the API key of ChangeNOW, so that the key never sits in the
// app, and it forwards only the calls of the bridge, with checked input: receive, a coin on Robinhood Chain into XMR,
// and pay, an amount of XMR into a coin for an address on Robinhood Chain at a fixed rate. It writes no log of a request: no
// amount, no address, and no id leaves it except toward ChangeNOW and back to the app.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  CHAIN_ASSETS,
  GatewayError,
  PAY_RATES,
  UpstreamError,
  type ChainAsset,
  type CreatedExchange,
  type Exchanger,
  type PayRate,
} from "./changenow.mts";
import { AMOUNT_MATCH_TOLERANCE, MAX_BODY_BYTES, MAX_FORWARDED_MESSAGE_CHARS } from "./config.mts";

/** An amount as the app writes it: digits, and at most 18 decimals after a point. */
const AMOUNT_PATTERN = /^\d{1,9}(\.\d{1,18})?$/;

/**
 * A standard address or a subaddress of the Monero mainnet: 95 characters of base58, starting with 4 or 8. The app
 * checks the checksum itself; the relay only keeps text of another shape away from ChangeNOW.
 */
const MONERO_ADDRESS_PATTERN = /^[48][1-9A-HJ-NP-Za-km-z]{94}$/;

/** A deposit address of ChangeNOW for XMR: a standard address or a subaddress of mainnet, or an integrated address. */
const MONERO_DEPOSIT_PATTERN = /^(?:[48][1-9A-HJ-NP-Za-km-z]{94}|4[1-9A-HJ-NP-Za-km-z]{105})$/;

/** An address on Robinhood Chain, an EVM chain: 0x and 40 hex digits. */
const EVM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** An id of an exchange at ChangeNOW, such as 3a2360771439a3. */
const EXCHANGE_ID_PATTERN = /^[0-9a-zA-Z]{6,64}$/;

/** The id of a fixed rate at ChangeNOW: base64 text, a few hundred characters long. */
const RATE_ID_PATTERN = /^[A-Za-z0-9+/=_-]{8,1024}$/;

const SWAP_PATH = /^\/v1\/swaps\/([^/]+)$/;

/** The only type of body that the relay reads. A browser cannot send it to another site without asking first. */
const JSON_MEDIA_TYPE = "application/json";

/** The answers of ChangeNOW that refuse the request itself; their text tells the user what to change. */
const REFUSAL_STATUSES = new Set([400, 404, 422]);

/** The coin of Monero in the names of v2, for the checks of a created exchange. */
const XMR_NAME = "xmr";

class RequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(text);
}

function readAsset(value: unknown): ChainAsset {
  if (typeof value === "string" && Object.hasOwn(CHAIN_ASSETS, value)) return value as ChainAsset;
  throw new RequestError(400, `The asset must be one of: ${Object.keys(CHAIN_ASSETS).join(", ")}.`);
}

function readRate(value: unknown): PayRate {
  if (typeof value === "string" && Object.hasOwn(PAY_RATES, value)) return value as PayRate;
  throw new RequestError(400, `The rate must be one of: ${Object.keys(PAY_RATES).join(", ")}.`);
}

function readAmount(value: unknown): string {
  if (typeof value !== "string" || !AMOUNT_PATTERN.test(value) || Number(value) <= 0) {
    throw new RequestError(400, "The amount must be a number above zero, with a point for decimals.");
  }
  return value;
}

/**
 * The relay answers the Kranox app only, which sends JSON and no header of a browser. A browser adds Origin or
 * Sec-Fetch-Site to a request from a page, and a page that posts plain text needs no permission first, so the relay
 * refuses both: no web page can make its visitors create exchanges under the key of the relay.
 */
function refuseBrowsers(request: IncomingMessage): void {
  if (request.headers.origin !== undefined || request.headers["sec-fetch-site"] !== undefined) {
    throw new RequestError(403, "The relay answers the Kranox app only.");
  }
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

/** A name that ChangeNOW left out passes; a name that it gave must be the one of the request. */
function nameMatches(answered: string | null, expected: string): boolean {
  return answered === null || answered.toLowerCase() === expected;
}

interface Side {
  currency: string;
  network: string;
}

const XMR_SIDE: Side = { currency: XMR_NAME, network: XMR_NAME };

function pairMatches(created: CreatedExchange, from: Side, to: Side, flow: string): boolean {
  return (
    nameMatches(created.fromCurrency, from.currency) &&
    nameMatches(created.fromNetwork, from.network) &&
    nameMatches(created.toCurrency, to.currency) &&
    nameMatches(created.toNetwork, to.network) &&
    nameMatches(created.flow, flow)
  );
}

/** Why an exchange of receive differs from its request, or null when it matches. */
function receiveMismatch(created: CreatedExchange, asset: ChainAsset, amount: string, address: string): string | null {
  if (!EVM_ADDRESS_PATTERN.test(created.payinAddress)) {
    return "ChangeNOW gave a deposit address that is not a Robinhood Chain address.";
  }
  if (created.payoutAddress !== address) return "ChangeNOW made the exchange for another Monero address.";
  if (!amountsMatch(amount, created.fromAmount)) return "ChangeNOW made the exchange for another amount.";
  if (!pairMatches(created, CHAIN_ASSETS[asset], XMR_SIDE, PAY_RATES.floating)) {
    return "ChangeNOW made the exchange for another pair of coins.";
  }
  return null;
}

/** Why an exchange of pay differs from its request, or null when it matches. */
function payMismatch(
  created: CreatedExchange,
  asset: ChainAsset,
  rate: PayRate,
  xmrAmount: string,
  address: string,
): string | null {
  if (!MONERO_DEPOSIT_PATTERN.test(created.payinAddress)) {
    return "ChangeNOW gave a deposit address that is not a Monero mainnet address.";
  }
  if (created.payoutAddress.toLowerCase() !== address.toLowerCase()) {
    return "ChangeNOW made the exchange for another recipient.";
  }
  if (!amountsMatch(xmrAmount, created.fromAmount)) return "ChangeNOW made the exchange for another amount of XMR.";
  if (!pairMatches(created, XMR_SIDE, CHAIN_ASSETS[asset], PAY_RATES[rate])) {
    return "ChangeNOW made the exchange for another pair of coins.";
  }
  return null;
}

/** Refuses an exchange that ChangeNOW made other than the request, with its id, so that support can find it. */
function checkCreated(created: CreatedExchange, mismatch: string | null): void {
  if (mismatch !== null) throw new GatewayError(502, mismatch, created.id);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, "The request is too large.");
    chunks.push(chunk as Buffer);
  }
  try {
    const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

async function createSwap(exchanger: Exchanger, request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
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
  const created = await exchanger.create(asset, amount, body.address, refundAddress);
  // The app shows the deposit address as a code and the amount as "Send exactly", so the relay passes on only an
  // exchange of the coin and the amount of the request, into the subaddress of the request.
  checkCreated(created, receiveMismatch(created, asset, amount, body.address));
  return {
    id: created.id,
    asset,
    amount: created.fromAmount,
    estimatedXmr: created.toAmount,
    depositAddress: created.payinAddress,
    payoutAddress: created.payoutAddress,
  };
}

async function payRange(exchanger: Exchanger, url: URL): Promise<unknown> {
  const asset = readAsset(url.searchParams.get("asset"));
  const rate = readRate(url.searchParams.get("rate"));
  const range = await exchanger.payRange(asset, rate);
  return { asset, rate, minXmr: range.minXmr, maxXmr: range.maxXmr };
}

async function payQuote(exchanger: Exchanger, url: URL): Promise<unknown> {
  const asset = readAsset(url.searchParams.get("asset"));
  const rate = readRate(url.searchParams.get("rate"));
  const xmrAmount = readAmount(url.searchParams.get("xmrAmount"));
  const estimate = await exchanger.payEstimate(asset, rate, xmrAmount);
  // An amount outside the range of the rate gets no estimate; the app shows the range in XMR instead.
  if ("limit" in estimate) {
    return {
      asset,
      rate,
      xmrAmount,
      amount: null,
      rateId: null,
      validUntil: null,
      warning: null,
      depositFee: null,
      withdrawalFee: null,
      speedMinutes: null,
      limit: estimate.limit,
      minXmr: estimate.minXmr,
      maxXmr: estimate.maxXmr,
    };
  }
  return {
    asset,
    rate,
    xmrAmount,
    amount: estimate.amount,
    rateId: estimate.rateId,
    validUntil: estimate.validUntil,
    warning: estimate.warning,
    depositFee: estimate.depositFee,
    withdrawalFee: estimate.withdrawalFee,
    speedMinutes: estimate.speedMinutes,
    limit: null,
    minXmr: null,
    maxXmr: null,
  };
}

async function createPay(exchanger: Exchanger, request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  const asset = readAsset(body.asset);
  const rate = readRate(body.rate);
  const xmrAmount = readAmount(body.xmrAmount);
  const address = body.address;
  if (typeof address !== "string" || !EVM_ADDRESS_PATTERN.test(address)) {
    throw new RequestError(400, "The address must be a Robinhood Chain address: 0x and 40 hex digits.");
  }
  if (typeof body.refundAddress !== "string" || !MONERO_ADDRESS_PATTERN.test(body.refundAddress)) {
    throw new RequestError(400, "The refund address must be a Monero mainnet address.");
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
  const created = await exchanger.createPay(asset, rate, xmrAmount, address, body.refundAddress, rateId);
  // The app sends XMR to the deposit address and trusts the recipient, so the relay passes on nothing else.
  checkCreated(created, payMismatch(created, asset, rate, xmrAmount, address));
  return {
    id: created.id,
    asset,
    amount: created.toAmount,
    xmrAmount: created.fromAmount,
    depositAddress: created.payinAddress,
    payoutAddress: created.payoutAddress,
  };
}

async function readSwap(exchanger: Exchanger, id: string): Promise<unknown> {
  if (!EXCHANGE_ID_PATTERN.test(id)) throw new RequestError(400, "The swap id has the wrong form.");
  const status = await exchanger.status(id);
  // Each step of a swap carries its own facts: the deposit hash, the coin that is expected and then sent with its
  // hash, and, when the swap goes wrong, the refund with its amount, address, and hash. An id alone reads these, so
  // the relay passes on only what the app shows, and no deposit or payout address.
  return {
    status: status.status,
    expectedOut: status.expectedAmountTo,
    amountOut: status.amountTo,
    depositHash: status.payinHash,
    payoutHash: status.payoutHash,
    refundAddress: status.refundAddress,
    refundHash: status.refundHash,
    refundAmount: status.refundAmount,
    updatedAt: status.updatedAt,
    validUntil: status.validUntil,
  };
}

/** Answers whether the relay can use its key: one call to ChangeNOW, which the cache of the minimum keeps rare. */
async function ready(exchanger: Exchanger): Promise<unknown> {
  await exchanger.minAmount("eth");
  return { ok: true };
}

async function route(exchanger: Exchanger, request: IncomingMessage): Promise<[number, unknown]> {
  const url = new URL(request.url ?? "/", "http://relay");
  const method = request.method ?? "GET";
  refuseBrowsers(request);
  if (method === "POST") requireJson(request);
  if (method === "GET" && url.pathname === "/health") return [200, { ok: true }];
  if (method === "GET" && url.pathname === "/ready") return [200, await ready(exchanger)];
  if (method === "GET" && url.pathname === "/v1/receive/quote") return [200, await quote(exchanger, url)];
  if (method === "POST" && url.pathname === "/v1/receive/swaps") return [201, await createSwap(exchanger, request)];
  if (method === "GET" && url.pathname === "/v1/pay/range") return [200, await payRange(exchanger, url)];
  if (method === "GET" && url.pathname === "/v1/pay/quote") return [200, await payQuote(exchanger, url)];
  if (method === "POST" && url.pathname === "/v1/pay/swaps") return [201, await createPay(exchanger, request)];
  const swap = SWAP_PATH.exec(url.pathname);
  if (method === "GET" && swap) return [200, await readSwap(exchanger, decodeURIComponent(swap[1]))];
  throw new RequestError(404, "The relay has no such route.");
}

/** The code points of ASCII control characters: 0 to 31, and 127. */
function isControl(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/** Text of ChangeNOW for the app: one line, without control characters, cut short. */
function forwarded(message: string): string {
  const line = Array.from(message, (char) => (isControl(char) ? " " : char))
    .join("")
    .replace(/ {2,}/g, " ")
    .trim();
  return line.length > MAX_FORWARDED_MESSAGE_CHARS ? `${line.slice(0, MAX_FORWARDED_MESSAGE_CHARS - 1)}…` : line;
}

/**
 * What the app learns of an error answer of ChangeNOW. A refusal of the request, such as an amount below the minimum,
 * reaches it as a refusal with the text of ChangeNOW. A refused key, a spent budget of calls, and a failure of
 * ChangeNOW reach it with a fixed text of the relay, so that no message about the account of Kranox leaves the relay.
 */
function upstreamAnswer(error: UpstreamError): [number, string] {
  if (REFUSAL_STATUSES.has(error.status)) return [422, forwarded(error.message)];
  if (error.status === 429) return [503, "ChangeNOW is busy. Try again in a minute."];
  if (error.status === 401 || error.status === 403) return [502, "The relay cannot use ChangeNOW right now."];
  return [502, "ChangeNOW failed."];
}

export function createRelay(exchanger: Exchanger): Server {
  return createServer((request, response) => {
    route(exchanger, request).then(
      ([status, body]) => send(response, status, body),
      (error: unknown) => {
        if (error instanceof RequestError) {
          send(response, error.status, { error: error.message });
        } else if (error instanceof GatewayError) {
          send(response, error.status, { error: error.message, exchangeId: error.exchangeId });
        } else if (error instanceof UpstreamError) {
          const [status, message] = upstreamAnswer(error);
          send(response, status, { error: message });
        } else {
          send(response, 500, { error: "The relay failed." });
        }
      },
    );
  });
}
