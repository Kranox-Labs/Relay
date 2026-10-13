import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import {
  UpstreamError,
  type ChainAsset,
  type Exchanger,
  type FromAsset,
  type PayExchanger,
  type PayRate,
} from "../src/exchanger.mts";
import { CreationKeys } from "../src/creations.mts";
import { createRelay } from "../src/server.mts";
import { AnswerSigner, answerMessage, requestHash } from "../src/signing.mts";
import { SwapTokens } from "../src/tokens.mts";

// A Monero mainnet subaddress of a throwaway wallet, as in apps/wallet/test/core/address_test.dart.
const MAINNET_SUBADDRESS =
  "883z7Wmbd5nhoH6xQxLzgniNhN6jqdvxFiza4rMdErWA1XW1TCL1tqrCwWFwhG1QkuL17RRHP45J33y6u4sH8Rfa7kryRza";
const REFUND_ADDRESS = "0x57f31ad4b64095347F87eDB1675566DAfF5EC886";

// A recipient on Robinhood Chain for pay, and a sample id of a fixed rate.
const RECIPIENT = "0x7a3fC0e1b9D24A6c58E0f3B1d9a7C4e2F6b8D015";
const RATE_ID =
  "afnwAXCTl4vnyNNHHdc8DcZTYsxi7u72bPx6ylUb0b7c+s8ieEkbx8ga45z/WMyuv7atwKA7qHNdBB49tGMJ5t3dWZ02V8dq1064==";

// A deposit address of ChangeNOW for XMR in the sample: a mainnet address of a throwaway wallet, as in
// apps/wallet/test/core/address_test.dart.
const XMR_DEPOSIT = "48PFnHrr8bVGx463yo8SMXGZUp7PyYPgwZJR4MnpgjKCDXpw3XvK6UTbarKkpwaPbPSYSdJ4rozjZjGxr2t3qVP4B4DzzVs";

// A deposit address of ChangeNOW on Robinhood Chain for receive.
const CHAIN_DEPOSIT = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";

// A refund address on Starknet of a throwaway wallet, and a deposit address of a swap of STRK, both of the usual length.
const STRK_REFUND = "0x04a3f9c1b2e7d8a5c6f0e1d2c3b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f70";
const STRK_DEPOSIT = "0x01d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2";
const STRK_ASSET = "nep141:starknet.omft.near";

// A transparent refund address of Zcash and a transparent deposit address of a swap of ZEC, made for the tests.
const ZEC_REFUND = "t1URu8q83ibd8sgDoW3VnJoPjUusRz97h8J";
const ZEC_DEPOSIT = "t3S5pQGfcc3VC7ZyrC59bQwrnHco6q5Jzck";
const ZEC_ASSET = "nep141:zec.omft.near";
const HOOD_ASSETS: Record<ChainAsset, string> = {
  eth: "nep141:hood.omft.near",
  usdg: "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near",
};

// The origin of the web app of Kranox in the test, which the relay answers from a browser.
const APP_ORIGIN = "https://app.example";

const RECEIVE_PAIR = { fromNetwork: "hood", toCurrency: "xmr", toNetwork: "xmr", flow: "standard" };

const calls: unknown[][] = [];

// Some tests make the minimum of ChangeNOW fail, to see what the check of the key answers.
let minAmountFails = false;

const STATUS_REFUSALS: Record<string, [number, string]> = {
  notfound0001: [404, "Exchange not found"],
  badkey000001: [401, "Invalid api key: the account of Kranox is suspended"],
  spentbudget1: [429, "Too many requests for this key"],
  brokenupstr1: [500, "Internal error at host 10.0.0.12"],
  longrefusal1: [400, `Bad request:\n${"x".repeat(500)}`],
};

const fake: Exchanger = {
  name: "ChangeNOW",
  origins: ["xmr", "strk", "zec"],
  rates: ["fixed", "floating"],
  payNames(from: FromAsset, asset: ChainAsset, rate: PayRate) {
    return {
      from: { currency: from, network: from },
      to: { currency: asset, network: "hood" },
      flow: rate === "fixed" ? "fixed-rate" : "standard",
    };
  },
  receiveNames(asset: ChainAsset) {
    return { from: { currency: asset, network: "hood" }, to: { currency: "xmr", network: "xmr" }, flow: "standard" };
  },
  async minAmount(asset: ChainAsset) {
    calls.push(["min", asset]);
    if (minAmountFails)
      throw new UpstreamError(401, "Invalid api key: the account of Kranox is suspended", "ChangeNOW");
    return 0.004;
  },
  async estimate(asset: ChainAsset, amount: string) {
    calls.push(["estimate", asset, amount]);
    return { amount: 0.0271, speedMinutes: "10-60", warning: null };
  },
  async create(asset: ChainAsset, amount: string, address: string, refundAddress: string | null) {
    calls.push(["create", asset, amount, address, refundAddress]);
    if (amount === "0.001") throw new UpstreamError(400, "Amount is less than minimal", "ChangeNOW");
    // Seven amounts stand for faults of ChangeNOW: another payout address, a deposit address that is not on Robinhood
    // Chain, another amount, another pair of coins, another refund address, a refund address left out, and one that
    // the request never named. A last one records the refund address in lowercase, as ChangeNOW may.
    return {
      id: "3a2360771439a3",
      fromAmount: amount === "0.0088" ? 0.0089 : Number(amount),
      toAmount: 0.0271,
      payinAddress: amount === "0.0077" ? "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" : CHAIN_DEPOSIT,
      payoutAddress: amount === "0.0066" ? XMR_DEPOSIT : address,
      refundAddress:
        amount === "0.0044"
          ? RECIPIENT
          : amount === "0.0033"
            ? null
            : amount === "0.0011"
              ? RECIPIENT
              : amount === "0.0022"
                ? (refundAddress?.toLowerCase() ?? null)
                : refundAddress,
      ...RECEIVE_PAIR,
      fromCurrency: amount === "0.0099" ? "btc" : asset,
      validUntil: null,
    };
  },
  // The ranges and the estimates of 6 Oct 2026: a fixed rate from 0.0227 XMR with a top, a floating one from 0.0119;
  // and of 13 Oct 2026 for STRK: a fixed rate from 110.06 to 9142.31, a floating one from 18.88.
  async payRange(from: FromAsset, asset: ChainAsset, rate: PayRate) {
    calls.push(["payRange", from, asset, rate]);
    if (from === "strk") {
      return rate === "fixed"
        ? { minFrom: 110.0639398, maxFrom: 9142.3132312 }
        : { minFrom: 18.8802983, maxFrom: null };
    }
    return rate === "fixed" ? { minFrom: 0.02267982, maxFrom: 1.451521737121 } : { minFrom: 0.0118679, maxFrom: null };
  },
  async payEstimate(from: FromAsset, asset: ChainAsset, rate: PayRate, xmrAmount: string) {
    calls.push(["payEstimate", from, asset, rate, xmrAmount]);
    if (from === "strk") {
      return {
        amount: 83.542896,
        rateId: null,
        validUntil: null,
        warning: null,
        depositFee: 0.104006,
        withdrawalFee: 0.7370513,
        speedMinutes: "10-60",
      };
    }
    if (xmrAmount === "0.01") return { limit: "below" as const, minFrom: 0.0227, maxFrom: 1.4505 };
    const fees = { depositFee: 0.006, withdrawalFee: 0.7370513 };
    return rate === "fixed"
      ? {
          amount: 51.229932,
          rateId: RATE_ID,
          validUntil: "2026-10-06T03:07:28.793Z",
          warning: null,
          ...fees,
          speedMinutes: null,
        }
      : { amount: 4.270318, rateId: null, validUntil: null, warning: null, ...fees, speedMinutes: "10-60" };
  },
  async createPay(
    from: FromAsset,
    asset: ChainAsset,
    rate: PayRate,
    xmrAmount: string,
    address: string,
    refundAddress: string,
    rateId: string | null,
  ) {
    calls.push(["createPay", from, asset, rate, xmrAmount, address, refundAddress, rateId]);
    // Five amounts stand for faults of ChangeNOW: a deposit address that is not a Monero one, another recipient,
    // another amount of XMR, another flow, and another refund address. For STRK, 66 stands for a deposit address
    // that is not one of Starknet, and 55 for a refund address of another account; the refund address comes back
    // without its leading zero, as the same account.
    const deposit = from === "strk" ? STRK_DEPOSIT : from === "zec" ? ZEC_DEPOSIT : XMR_DEPOSIT;
    const otherDeposit = from === "strk" ? XMR_DEPOSIT : "0xnotmonero";
    const recordedRefund = from === "strk" ? `0x${refundAddress.slice(3)}` : refundAddress;
    return {
      id: "9f4e2c71b03ad1",
      fromAmount: xmrAmount === "0.88" ? 0.89 : Number(xmrAmount),
      toAmount: 51.229932,
      payinAddress: xmrAmount === "0.66" || xmrAmount === "66" ? otherDeposit : deposit,
      payoutAddress: xmrAmount === "0.77" ? REFUND_ADDRESS : address.toLowerCase(),
      refundAddress: xmrAmount === "0.55" ? XMR_DEPOSIT : xmrAmount === "55" ? STRK_DEPOSIT : recordedRefund,
      fromCurrency: from,
      fromNetwork: from,
      toCurrency: asset,
      toNetwork: "hood",
      // ChangeNOW leaves out the flow of a floating payment here, which the relay lets pass.
      flow: xmrAmount === "0.99" ? "standard" : rate === "fixed" ? "fixed-rate" : null,
      validUntil: null,
    };
  },
  async status(id: string) {
    calls.push(["status", id]);
    // Some ids stand for error answers of ChangeNOW.
    const refusal = STATUS_REFUSALS[id];
    if (refusal !== undefined) throw new UpstreamError(refusal[0], refusal[1], "ChangeNOW");
    return {
      status: "exchanging",
      amountTo: null,
      expectedAmountTo: 0.0271,
      payinHash: "0xhash",
      payoutHash: null,
      refundAddress: null,
      refundHash: null,
      refundAmount: null,
      updatedAt: "2026-10-05T08:12:08.673Z",
      validUntil: null,
    };
  },
};

// The second exchanger of pay in the test: SimpleSwap, with its own names and no fees. A deposit address of XMR as above.
const simpleCalls: unknown[][] = [];
const fakeSimple: PayExchanger = {
  name: "SimpleSwap",
  origins: ["xmr", "zec"],
  rates: ["fixed", "floating"],
  async ready() {
    simpleCalls.push(["ready"]);
  },
  payNames(from: FromAsset, asset: ChainAsset, rate: PayRate) {
    return { from: { currency: from, network: from }, to: { currency: asset, network: "robinhood" }, flow: rate };
  },
  async payRange(from: FromAsset, asset: ChainAsset, rate: PayRate) {
    simpleCalls.push(["payRange", from, asset, rate]);
    return rate === "fixed"
      ? { minFrom: 0.0246892632, maxFrom: 1.495230709567 }
      : { minFrom: 0.0143601108, maxFrom: null };
  },
  async payEstimate(from: FromAsset, asset: ChainAsset, rate: PayRate, xmrAmount: string) {
    simpleCalls.push(["payEstimate", from, asset, rate, xmrAmount]);
    return {
      amount: 47.953709,
      rateId: rate === "fixed" ? "xmp4w9f3x2cy0tug8ju_rs97tvfcp15d" : null,
      validUntil: rate === "fixed" ? "2026-10-12T11:51:43.473Z" : null,
      warning: null,
      depositFee: null,
      withdrawalFee: null,
      speedMinutes: null,
    };
  },
  async createPay(
    from: FromAsset,
    asset: ChainAsset,
    rate: PayRate,
    xmrAmount: string,
    address: string,
    refundAddress: string,
    rateId: string | null,
  ) {
    simpleCalls.push(["createPay", from, asset, rate, xmrAmount, address, refundAddress, rateId]);
    // One amount stands for an id of a form the relay cannot read back.
    return {
      id: xmrAmount === "0.44" ? "bad id!" : "pch7l7kd1v2mzh1",
      fromAmount: Number(xmrAmount),
      toAmount: 47.953709,
      payinAddress: from === "zec" ? ZEC_DEPOSIT : XMR_DEPOSIT,
      payoutAddress: address,
      refundAddress,
      fromCurrency: from,
      fromNetwork: from,
      toCurrency: asset,
      toNetwork: "robinhood",
      flow: rate,
      validUntil: null,
    };
  },
  async status(id: string) {
    simpleCalls.push(["status", id]);
    return {
      status: "waiting",
      amountTo: null,
      expectedAmountTo: 47.953709,
      payinHash: null,
      payoutHash: null,
      refundAddress: null,
      refundHash: null,
      refundAmount: null,
      updatedAt: "2026-10-12T11:50:00.000Z",
      validUntil: "2026-10-12T12:20:00.000Z",
    };
  },
};

// The exchanger of Starknet and Zcash in the test: the 1Click API of NEAR Intents, which takes STRK and ZEC at a floating rate alone,
// names a swap by its deposit address, and names the coins by their asset ids.
const oneCalls: unknown[][] = [];
const fakeOneClick: PayExchanger = {
  name: "NEAR Intents",
  origins: ["strk", "zec"],
  rates: ["floating"],
  async ready() {
    oneCalls.push(["ready"]);
  },
  payNames(from: FromAsset, asset: ChainAsset) {
    return {
      from: from === "zec" ? { currency: ZEC_ASSET, network: "zec" } : { currency: STRK_ASSET, network: "starknet" },
      to: { currency: HOOD_ASSETS[asset], network: "hood" },
      flow: "EXACT_INPUT",
    };
  },
  async payRange(from: FromAsset, asset: ChainAsset, rate: PayRate) {
    oneCalls.push(["payRange", from, asset, rate]);
    return { minFrom: 20, maxFrom: null };
  },
  async payEstimate(from: FromAsset, asset: ChainAsset, rate: PayRate, fromAmount: string) {
    oneCalls.push(["payEstimate", from, asset, rate, fromAmount]);
    if (fromAmount === "5") return { limit: "below" as const, minFrom: 20, maxFrom: null };
    return {
      amount: 86.131039,
      rateId: null,
      validUntil: null,
      warning: null,
      depositFee: null,
      withdrawalFee: 0.075,
      speedMinutes: "1",
    };
  },
  async createPay(
    from: FromAsset,
    asset: ChainAsset,
    rate: PayRate,
    fromAmount: string,
    address: string,
    refundAddress: string,
    rateId: string | null,
  ) {
    oneCalls.push(["createPay", from, asset, rate, fromAmount, address, refundAddress, rateId]);
    // Four amounts stand for faults of 1Click: a deposit address that is not one of Starknet, another recipient,
    // another coin on Robinhood Chain, and another refund address.
    const deposit = from === "zec" ? ZEC_DEPOSIT : STRK_DEPOSIT;
    return {
      id: deposit,
      fromAmount: Number(fromAmount),
      toAmount: 86.131039,
      payinAddress: fromAmount === "66" ? XMR_DEPOSIT : deposit,
      payoutAddress: fromAmount === "77" ? REFUND_ADDRESS.toLowerCase() : address.toLowerCase(),
      refundAddress: fromAmount === "55" ? STRK_DEPOSIT : refundAddress,
      fromCurrency: from === "zec" ? ZEC_ASSET : STRK_ASSET,
      fromNetwork: null,
      toCurrency: fromAmount === "99" ? HOOD_ASSETS[asset === "usdg" ? "eth" : "usdg"] : HOOD_ASSETS[asset],
      toNetwork: null,
      flow: "EXACT_INPUT",
      validUntil: "2026-10-13T03:30:00.000Z",
    };
  },
  async status(id: string) {
    oneCalls.push(["status", id]);
    return {
      status: "waiting",
      amountTo: null,
      expectedAmountTo: 86.131039,
      payinHash: null,
      payoutHash: null,
      refundAddress: STRK_REFUND,
      refundHash: null,
      refundAmount: null,
      updatedAt: "2026-10-13T03:12:00.000Z",
      validUntil: "2026-10-13T03:30:00.000Z",
    };
  },
};

const tokens = new SwapTokens("a secret of the test");
const signingKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const relay = createRelay({
  exchanger: fake,
  simpleswap: fakeSimple,
  oneclick: fakeOneClick,
  scanner: null,
  tokens,
  creations: new CreationKeys(60_000, 100),
  signer: new AnswerSigner(signingKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
  allowedOrigins: [APP_ORIGIN],
});
let base = "";

before(async () => {
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(relay.address() as AddressInfo).port}`;
});

after(() => relay.close());

async function json(path: string, init?: RequestInit): Promise<[number, Record<string, unknown>]> {
  const response = await fetch(`${base}${path}`, init);
  return [response.status, (await response.json()) as Record<string, unknown>];
}

function post(body: unknown): RequestInit {
  return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** Whether [signature] signs [text] under the key of the relay of the test. */
function signedBy(text: string, signature: string | null): boolean {
  return (
    signature !== null &&
    verify(
      "sha256",
      Buffer.from(text, "utf8"),
      { key: signingKeys.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64"),
    )
  );
}

test("quotes an amount above the minimum with an estimate", async () => {
  const [status, body] = await json("/v1/receive/quote?asset=eth&amount=0.0055");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    asset: "eth",
    amount: "0.0055",
    minAmount: 0.004,
    estimatedXmr: 0.0271,
    speedMinutes: "10-60",
    warning: null,
  });
});

test("quotes an amount below the minimum without asking for an estimate", async () => {
  calls.length = 0;
  const [status, body] = await json("/v1/receive/quote?asset=usdg&amount=0.001");
  assert.equal(status, 200);
  assert.equal(body.estimatedXmr, null);
  assert.deepEqual(calls, [["min", "usdg"]]);
});

test("rejects an unknown asset and an amount of the wrong form", async () => {
  for (const query of ["asset=btc&amount=1", "asset=eth&amount=-1", "asset=eth&amount=0", "asset=eth&amount=1e3"]) {
    const [status] = await json(`/v1/receive/quote?${query}`);
    assert.equal(status, 400, query);
  }
});

test("makes a swap to a Monero mainnet address, with an optional refund address", async () => {
  calls.length = 0;
  const [status, body] = await json(
    "/v1/receive/swaps",
    post({ asset: "eth", amount: "0.0055", address: MAINNET_SUBADDRESS, refundAddress: REFUND_ADDRESS }),
  );
  assert.equal(status, 201);
  assert.equal(body.depositAddress, CHAIN_DEPOSIT);
  assert.equal(body.payoutAddress, MAINNET_SUBADDRESS);
  assert.equal(body.refundAddress, REFUND_ADDRESS, "the app compares it with the one that it sent");
  assert.equal(body.readToken, tokens.issue("3a2360771439a3", "changenow"));
  assert.deepEqual(calls, [["create", "eth", "0.0055", MAINNET_SUBADDRESS, REFUND_ADDRESS]]);
  const [, withoutRefund] = await json(
    "/v1/receive/swaps",
    post({ asset: "eth", amount: "0.0055", address: MAINNET_SUBADDRESS }),
  );
  assert.equal(withoutRefund.refundAddress, null);
});

test("refuses a swap to an address of another network or with a bad refund address", async () => {
  const stagenet = "7" + MAINNET_SUBADDRESS.slice(1);
  const [badAddress] = await json("/v1/receive/swaps", post({ asset: "eth", amount: "0.0055", address: stagenet }));
  assert.equal(badAddress, 400);
  const [badRefund] = await json(
    "/v1/receive/swaps",
    post({ asset: "eth", amount: "0.0055", address: MAINNET_SUBADDRESS, refundAddress: "0x123" }),
  );
  assert.equal(badRefund, 400);
  const [notJson] = await json("/v1/receive/swaps", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "nope",
  });
  assert.equal(notJson, 400);
});

test("passes on no swap that ChangeNOW made other than the request, and names its id", async () => {
  for (const [amount, reason] of [
    ["0.0066", "another Monero address"],
    ["0.0077", "not a Robinhood Chain address"],
    ["0.0088", "another amount"],
    ["0.0099", "another pair of coins"],
    ["0.0044", "another refund address"],
    ["0.0033", "another refund address"],
  ]) {
    const request = { asset: "eth", amount, address: MAINNET_SUBADDRESS, refundAddress: REFUND_ADDRESS };
    const [status, body] = await json("/v1/receive/swaps", post(request));
    assert.equal(status, 502, amount);
    assert.match(String(body.error), new RegExp(reason), amount);
    assert.equal(body.exchangeId, "3a2360771439a3", amount);
  }
});

test("answers the refund address that ChangeNOW recorded, and none that the request never named", async () => {
  const [status, body] = await json(
    "/v1/receive/swaps",
    post({ asset: "eth", amount: "0.0022", address: MAINNET_SUBADDRESS, refundAddress: REFUND_ADDRESS }),
  );
  assert.equal(status, 201);
  assert.equal(body.refundAddress, REFUND_ADDRESS.toLowerCase(), "the app compares what ChangeNOW keeps");
  const [unasked, unaskedBody] = await json(
    "/v1/receive/swaps",
    post({ asset: "eth", amount: "0.0011", address: MAINNET_SUBADDRESS }),
  );
  assert.equal(unasked, 502);
  assert.match(String(unaskedBody.error), /another refund address/);
});

test("refuses a request from a web page", async () => {
  calls.length = 0;
  const [fromPage] = await json("/v1/receive/swaps", {
    ...post({ asset: "eth", amount: "0.0055", address: MAINNET_SUBADDRESS }),
    headers: { "content-type": "application/json", origin: "https://evil.example" },
  });
  assert.equal(fromPage, 403);
  const [fetchMetadata] = await json("/v1/receive/quote?asset=eth&amount=0.0055", {
    headers: { "sec-fetch-site": "cross-site" },
  });
  assert.equal(fetchMetadata, 403);
  assert.deepEqual(calls, [], "no call reaches ChangeNOW");
});

test("answers the question of a browser about a request of the web app, and nobody else's", async () => {
  const asked = await fetch(`${base}/v1/pay/swaps`, {
    method: "OPTIONS",
    headers: { origin: APP_ORIGIN, "access-control-request-method": "POST" },
  });
  assert.equal(asked.status, 204);
  assert.equal(asked.headers.get("access-control-allow-origin"), APP_ORIGIN);
  assert.equal(asked.headers.get("access-control-allow-methods"), "GET, POST");
  assert.equal(
    asked.headers.get("access-control-allow-headers"),
    "content-type, kranox-nonce, idempotency-key, kranox-swap-token",
  );
  assert.equal(asked.headers.get("vary"), "origin");
  const otherPage = await fetch(`${base}/v1/pay/swaps`, {
    method: "OPTIONS",
    headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
  });
  assert.equal(otherPage.status, 403);
  assert.equal(otherPage.headers.get("access-control-allow-origin"), null);
  const nobody = await fetch(`${base}/v1/pay/swaps`, { method: "OPTIONS" });
  assert.equal(nobody.status, 404);
});

test("answers a refused page without the headers of the web app, and needs a nonce from the web app", async () => {
  calls.length = 0;
  const refused = await fetch(`${base}/v1/pay/range?asset=eth&rate=fixed`, {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("access-control-allow-origin"), null);
  assert.equal(refused.headers.get("access-control-expose-headers"), null);
  assert.equal(refused.headers.get("vary"), "origin");
  const withoutNonce = await fetch(`${base}/v1/pay/range?asset=eth&rate=fixed`, { headers: { origin: APP_ORIGIN } });
  assert.equal(withoutNonce.status, 400);
  assert.match(((await withoutNonce.json()) as { error: string }).error, /needs its nonce/);
  const shortNonce = await fetch(`${base}/v1/pay/range?asset=eth&rate=fixed`, {
    headers: { origin: APP_ORIGIN, "kranox-nonce": "short" },
  });
  assert.equal(shortNonce.status, 400);
  assert.deepEqual(calls, [], "no call reaches ChangeNOW");
});

test("refuses an origin of the web app that no browser sends, before it listens", () => {
  const parts = {
    exchanger: fake,
    simpleswap: null,
    oneclick: null,
    scanner: null,
    tokens,
    creations: new CreationKeys(60_000, 100),
    signer: new AnswerSigner(signingKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
  };
  for (const origins of [["null"], ["http://app.example"], ["https://app.example/"], ["https://APP.example"]]) {
    assert.throws(() => createRelay({ ...parts, allowedOrigins: origins }), /origins of the web app/, origins.join());
  }
});

test("matches the origin of the web app exactly", async () => {
  calls.length = 0;
  // A page in a sandbox or after a redirect sends the origin "null"; others differ in case, port, or scheme only.
  for (const origin of [
    "null",
    "https://APP.example",
    "https://app.example:443",
    "http://app.example",
    "https://app.example.evil",
  ]) {
    const [status] = await json("/v1/pay/range?asset=eth&rate=fixed", { headers: { origin } });
    assert.equal(status, 403, origin);
  }
  assert.deepEqual(calls, [], "no call reaches ChangeNOW");
});

test("lets the web app read an answer with its signatures, and keeps other pages out", async () => {
  calls.length = 0;
  const nonce = "nonce-of-the-web-app-1";
  const target = "/v1/pay/range?asset=eth&rate=fixed";
  const response = await fetch(`${base}${target}`, { headers: { origin: APP_ORIGIN, "kranox-nonce": nonce } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), APP_ORIGIN);
  assert.equal(response.headers.get("access-control-expose-headers"), "kranox-signature, kranox-signature-v2");
  assert.equal(response.headers.get("vary"), "origin");
  const body = await response.text();
  const message = answerMessage({
    nonce,
    method: "GET",
    target,
    requestHash: requestHash(Buffer.alloc(0)),
    status: 200,
    body,
  });
  assert.ok(signedBy(message, response.headers.get("kranox-signature-v2")), "the answer carries its signature");
  const created = await fetch(`${base}/v1/pay/swaps`, {
    ...post({ asset: "eth", rate: "floating", xmrAmount: "0.5", address: RECIPIENT, refundAddress: XMR_DEPOSIT }),
    headers: {
      "content-type": "application/json",
      origin: APP_ORIGIN,
      "kranox-nonce": "nonce-of-the-web-app-2",
      "idempotency-key": "web-app-creation-0001",
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("access-control-allow-origin"), APP_ORIGIN);
  const [otherPage] = await json("/v1/pay/range?asset=eth&rate=fixed", {
    headers: { origin: "https://evil.example" },
  });
  assert.equal(otherPage, 403);
  assert.deepEqual(calls, [
    ["payRange", "xmr", "eth", "fixed"],
    ["createPay", "xmr", "eth", "floating", "0.5", RECIPIENT, XMR_DEPOSIT, null],
  ]);
});

test("takes a body only as JSON, as the app sends it", async () => {
  calls.length = 0;
  const body = JSON.stringify({ asset: "eth", amount: "0.0055", address: MAINNET_SUBADDRESS });
  const [plainText] = await json("/v1/receive/swaps", { method: "POST", body });
  assert.equal(plainText, 415, "a string body goes out as text/plain");
  const [form] = await json("/v1/receive/swaps", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  assert.equal(form, 415);
  assert.deepEqual(calls, [], "no call reaches ChangeNOW");
  // The app sends application/json with a charset, as dart:io writes it.
  const [fromApp] = await json("/v1/receive/swaps", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body,
  });
  assert.equal(fromApp, 201);
});

test("passes a refusal of ChangeNOW on to the app", async () => {
  const [status, body] = await json(
    "/v1/receive/swaps",
    post({ asset: "eth", amount: "0.001", address: MAINNET_SUBADDRESS }),
  );
  assert.equal(status, 422);
  assert.equal(body.error, "Amount is less than minimal");
});

test("reads the state of a swap, without its addresses", async () => {
  const [status, body] = await json("/v1/swaps/3a2360771439a3");
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), [
    "amountOut",
    "depositHash",
    "expectedOut",
    "id",
    "payoutHash",
    "provider",
    "refundAmount",
    "refundHash",
    "status",
    "updatedAt",
    "validUntil",
  ]);
  assert.equal(body.id, "3a2360771439a3", "the app compares it with the swap that it asked for");
  assert.equal(body.status, "exchanging");
  assert.equal(body.expectedOut, 0.0271);
  assert.equal(body.amountOut, null);
  assert.equal(body.depositHash, "0xhash");
  assert.equal(body.refundHash, null);
  assert.equal(body.updatedAt, "2026-10-05T08:12:08.673Z");
  const [badId] = await json("/v1/swaps/..%2Fsecret");
  assert.equal(badId, 400);
});

test("gives the range of one payment at each rate, in XMR", async () => {
  const [status, body] = await json("/v1/pay/range?asset=eth&rate=fixed");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    provider: "changenow",
    from: "xmr",
    asset: "eth",
    rate: "fixed",
    minFrom: 0.02267982,
    maxFrom: 1.451521737121,
    minXmr: 0.02267982,
    maxXmr: 1.451521737121,
  });
  const [, floating] = await json("/v1/pay/range?asset=eth&rate=floating");
  assert.deepEqual(floating, {
    provider: "changenow",
    from: "xmr",
    asset: "eth",
    rate: "floating",
    minFrom: 0.0118679,
    maxFrom: null,
    minXmr: 0.0118679,
    maxXmr: null,
  });
  for (const query of ["asset=btc&rate=fixed", "asset=eth", "asset=eth&rate=best"]) {
    const [bad] = await json(`/v1/pay/range?${query}`);
    assert.equal(bad, 400, query);
  }
});

test("quotes the coin that an amount of XMR buys at a fixed rate, with the fees of ChangeNOW", async () => {
  const [status, body] = await json("/v1/pay/quote?asset=usdg&rate=fixed&xmrAmount=0.1");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    provider: "changenow",
    from: "xmr",
    asset: "usdg",
    rate: "fixed",
    fromAmount: "0.1",
    xmrAmount: "0.1",
    amount: 51.229932,
    rateId: RATE_ID,
    validUntil: "2026-10-06T03:07:28.793Z",
    warning: null,
    depositFee: 0.006,
    withdrawalFee: 0.7370513,
    speedMinutes: null,
    limit: null,
    minFrom: null,
    maxFrom: null,
    minXmr: null,
    maxXmr: null,
  });
});

test("quotes a floating rate without a rate id", async () => {
  const [status, body] = await json("/v1/pay/quote?asset=usdg&rate=floating&xmrAmount=0.015");
  assert.equal(status, 200);
  assert.equal(body.amount, 4.270318);
  assert.equal(body.rateId, null);
  assert.equal(body.validUntil, null);
  assert.equal(body.speedMinutes, "10-60");
});

test("quotes a payment outside the range of the fixed rate with that range", async () => {
  const [status, body] = await json("/v1/pay/quote?asset=eth&rate=fixed&xmrAmount=0.01");
  assert.equal(status, 200);
  assert.equal(body.amount, null);
  assert.equal(body.rateId, null);
  assert.equal(body.limit, "below");
  assert.equal(body.minXmr, 0.0227);
  assert.equal(body.maxXmr, 1.4505);
  const [missing] = await json("/v1/pay/quote?asset=eth&rate=fixed&amount=80");
  assert.equal(missing, 400, "the input of pay is an amount of XMR");
  const [noRate] = await json("/v1/pay/quote?asset=eth&xmrAmount=0.1");
  assert.equal(noRate, 400, "the rate is the choice of the user");
});

test("makes a payment to an address on Robinhood Chain, with a refund to this wallet", async () => {
  calls.length = 0;
  const [status, body] = await json(
    "/v1/pay/swaps",
    post({
      asset: "usdg",
      rate: "fixed",
      xmrAmount: "0.1",
      address: RECIPIENT,
      refundAddress: MAINNET_SUBADDRESS,
      rateId: RATE_ID,
    }),
  );
  assert.equal(status, 201);
  assert.deepEqual(body, {
    id: "9f4e2c71b03ad1",
    provider: "changenow",
    from: "xmr",
    asset: "usdg",
    amount: 51.229932,
    fromAmount: 0.1,
    xmrAmount: 0.1,
    depositAddress: XMR_DEPOSIT,
    payoutAddress: RECIPIENT.toLowerCase(),
    refundAddress: MAINNET_SUBADDRESS,
    validUntil: null,
    readToken: tokens.issue("9f4e2c71b03ad1", "changenow"),
  });
  assert.deepEqual(calls, [["createPay", "xmr", "usdg", "fixed", "0.1", RECIPIENT, MAINNET_SUBADDRESS, RATE_ID]]);
});

test("makes a payment at a floating rate without a rate id", async () => {
  calls.length = 0;
  const floating = {
    asset: "eth",
    rate: "floating",
    xmrAmount: "0.015",
    address: RECIPIENT,
    refundAddress: MAINNET_SUBADDRESS,
  };
  const [status] = await json("/v1/pay/swaps", post(floating));
  assert.equal(status, 201);
  assert.deepEqual(calls, [["createPay", "xmr", "eth", "floating", "0.015", RECIPIENT, MAINNET_SUBADDRESS, null]]);
  const [withRate] = await json("/v1/pay/swaps", post({ ...floating, rateId: RATE_ID }));
  assert.equal(withRate, 400, "a floating rate takes no rate id");
});

test("refuses a payment with a bad recipient, refund address, or rate id", async () => {
  const good = {
    asset: "eth",
    rate: "fixed",
    xmrAmount: "0.03",
    address: RECIPIENT,
    refundAddress: MAINNET_SUBADDRESS,
    rateId: RATE_ID,
  };
  for (const bad of [
    { rate: "best" },
    { rateId: undefined },
    { address: "0x123" },
    { address: MAINNET_SUBADDRESS },
    { refundAddress: "7" + MAINNET_SUBADDRESS.slice(1) },
    { refundAddress: undefined },
    { rateId: "short" },
    { rateId: "has spaces in it" },
  ]) {
    const [status] = await json("/v1/pay/swaps", post({ ...good, ...bad }));
    assert.equal(status, 400, JSON.stringify(bad));
  }
});

test("passes on no payment that ChangeNOW made other than the request, and names its id", async () => {
  const good = { asset: "usdg", rate: "fixed", address: RECIPIENT, refundAddress: MAINNET_SUBADDRESS, rateId: RATE_ID };
  for (const [xmrAmount, reason] of [
    ["0.66", "not a Monero mainnet address"],
    ["0.77", "another recipient"],
    ["0.88", "another amount of XMR"],
    ["0.99", "another pair of coins"],
    ["0.55", "another refund address"],
  ]) {
    const [status, body] = await json("/v1/pay/swaps", post({ ...good, xmrAmount }));
    assert.equal(status, 502, xmrAmount);
    assert.match(String(body.error), new RegExp(reason), xmrAmount);
    assert.equal(body.exchangeId, "9f4e2c71b03ad1", xmrAmount);
  }
});

test("passes a refusal of ChangeNOW on in one short line, and nothing about the account of Kranox", async () => {
  const [notFound, notFoundBody] = await json("/v1/swaps/notfound0001");
  assert.equal(notFound, 422);
  assert.equal(notFoundBody.error, "Exchange not found");
  const [long, longBody] = await json("/v1/swaps/longrefusal1");
  assert.equal(long, 422);
  assert.equal(String(longBody.error).length, 200);
  assert.doesNotMatch(String(longBody.error), /\n/);
  for (const [id, status, text] of [
    ["badkey000001", 502, "The relay cannot use ChangeNOW right now."],
    ["spentbudget1", 503, "ChangeNOW is busy. Try again in a minute."],
    ["brokenupstr1", 502, "ChangeNOW failed."],
  ] as const) {
    const [answer, body] = await json(`/v1/swaps/${id}`);
    assert.equal(answer, status, id);
    assert.equal(body.error, text, id);
  }
});

test("answers whether it can use its key", async () => {
  const [ready, body] = await json("/ready");
  assert.equal(ready, 200);
  assert.deepEqual(body, { ok: true });
  minAmountFails = true;
  try {
    const [refused, refusedBody] = await json("/ready");
    assert.equal(refused, 502);
    assert.equal(refusedBody.error, "The relay cannot use ChangeNOW right now.");
  } finally {
    minAmountFails = false;
  }
});

test("answers an unknown route with 404", async () => {
  const [status] = await json("/v1/nothing");
  assert.equal(status, 404);
});

test("reads a swap with its token, refuses the token of another swap, and lets the older apps read without one", async () => {
  const id = "3a2360771439a3";
  const withToken = await json(`/v1/swaps/${id}`, { headers: { "kranox-swap-token": tokens.issue(id, "changenow") } });
  assert.equal(withToken[0], 200);
  const otherToken = await json(`/v1/swaps/${id}`, {
    headers: { "kranox-swap-token": tokens.issue("9f4e2c71b03ad1", "changenow") },
  });
  assert.deepEqual(otherToken, [403, { error: "The token does not belong to this swap." }]);
  const madeUp = await json(`/v1/swaps/${id}`, { headers: { "kranox-swap-token": "not-a-token" } });
  assert.equal(madeUp[0], 403);
  const withoutToken = await json(`/v1/swaps/${id}`);
  assert.equal(withoutToken[0], 200, "the apps up to 0.3.0 send no token");
});

test("makes one exchange for a key, also when the app tries again after a lost answer", async () => {
  calls.length = 0;
  const payment = {
    asset: "usdg",
    rate: "floating",
    xmrAmount: "0.2",
    address: RECIPIENT,
    refundAddress: MAINNET_SUBADDRESS,
  };
  const keyed = (body: unknown, key: string): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
  const key = "c0ffee00c0ffee00c0ffee00c0ffee00";
  const [first, second] = await Promise.all([
    json("/v1/pay/swaps", keyed(payment, key)),
    json("/v1/pay/swaps", keyed(payment, key)),
  ]);
  const [third] = await Promise.all([json("/v1/pay/swaps", keyed(payment, key))]);
  assert.equal(first[0], 201);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal(calls.filter((call) => call[0] === "createPay").length, 1, "one exchange at ChangeNOW");

  const otherBody = await json("/v1/pay/swaps", keyed({ ...payment, xmrAmount: "0.3" }, key));
  assert.deepEqual(otherBody, [422, { error: "The idempotency key belongs to another request." }]);
  const badKey = await json("/v1/pay/swaps", keyed(payment, "short"));
  assert.deepEqual(badKey, [400, { error: "The idempotency key has the wrong form." }]);

  // A refused creation is forgotten, so that a second try with the same key asks ChangeNOW again.
  calls.length = 0;
  const tooSmall = { asset: "eth", amount: "0.001", address: MAINNET_SUBADDRESS };
  const refusedKey = "refused0refused0refused0";
  assert.equal((await json("/v1/receive/swaps", keyed(tooSmall, refusedKey)))[0], 422);
  assert.equal((await json("/v1/receive/swaps", keyed(tooSmall, refusedKey)))[0], 422);
  assert.equal(calls.filter((call) => call[0] === "create").length, 2);
});

test("signs each answer, also a refusal, over the nonce of its request and its body (K-10)", async () => {
  const nonce = "n0nce0f7hetest00";
  for (const path of ["/health", "/v1/swaps/3a2360771439a3", "/v1/no-such-route"]) {
    const response = await fetch(`${base}${path}`, { headers: { "kranox-nonce": nonce } });
    const text = await response.text();
    const signature = response.headers.get("kranox-signature");
    assert.equal(signedBy(`${nonce}\n${text}`, signature), true, path);
    assert.equal(signedBy(`another0nonce000\n${text}`, signature), false, `${path}: an old answer for a new request`);
    assert.equal(signedBy(`${nonce}\n${text} `, signature), false, `${path}: a changed body`);
  }
});

test("signs each answer also over its request and its status (wallet O-003 and relay O-004)", async () => {
  const nonce = "n0nce0f7hetest01";
  const requestBody = JSON.stringify({ asset: "eth", amount: "0.0055", address: MAINNET_SUBADDRESS });
  const exchanges: [string, RequestInit, string][] = [
    ["/v1/swaps/3a2360771439a3", {}, ""],
    ["/v1/receive/quote?asset=eth&amount=0.0055", {}, ""],
    ["/v1/no-such-route", {}, ""],
    ["/v1/receive/swaps", post(JSON.parse(requestBody)), requestBody],
    ["/v1/receive/swaps", post({ asset: "btc" }), JSON.stringify({ asset: "btc" })],
  ];
  for (const [target, init, sent] of exchanges) {
    const response = await fetch(`${base}${target}`, { ...init, headers: { ...init.headers, "kranox-nonce": nonce } });
    const body = await response.text();
    const signature = response.headers.get("kranox-signature-v2");
    const answer = {
      nonce,
      method: init.method ?? "GET",
      target,
      requestHash: requestHash(Buffer.from(sent, "utf8")),
      status: response.status,
      body,
    };
    assert.equal(signedBy(answerMessage(answer), signature), true, target);
    for (const [field, value] of [
      ["nonce", "another0nonce000"],
      ["method", answer.method === "GET" ? "POST" : "GET"],
      ["target", "/v1/swaps/9f4e2c71b03ad1"],
      ["requestHash", requestHash(Buffer.from(`${sent} `, "utf8"))],
      ["status", answer.status + 1],
      ["body", `${body} `],
    ] as const) {
      assert.equal(signedBy(answerMessage({ ...answer, [field]: value }), signature), false, `${target}: ${field}`);
    }
    assert.equal(signedBy(`${nonce}\n${body}`, signature), false, `${target}: not a signature of the first form`);
  }
});

test("signs nothing for a request without a nonce, as from an app before 0.3.1 (relay O-004)", async () => {
  const withoutNonce: Record<string, string>[] = [{}, { "kranox-nonce": "short" }];
  for (const headers of withoutNonce) {
    const response = await fetch(`${base}/health`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("kranox-signature"), null);
    assert.equal(response.headers.get("kranox-signature-v2"), null);
  }
});

test("signs no text whose fields could shift: a nonce of another form, or a line break before the body", () => {
  const signer = new AnswerSigner(signingKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  const answer = {
    nonce: "00112233445566778899aabbccddeeff",
    method: "GET",
    target: "/health",
    requestHash: requestHash(Buffer.alloc(0)),
    status: 200,
    body: "{}",
  };
  assert.doesNotThrow(() => signer.signAnswer(answer));
  for (const nonce of ["", "kranox/answer/2", "00112233445566778899aabbccddeeff\nGET"]) {
    assert.throws(() => signer.sign(nonce, "{}"), /nonce/, JSON.stringify(nonce));
    assert.throws(() => signer.signAnswer({ ...answer, nonce }), /nonce/, JSON.stringify(nonce));
  }
  for (const [field, value] of [
    ["method", "GET\n/health"],
    ["target", "/health\r\n"],
    ["requestHash", "nothex"],
    ["status", 2000],
  ] as const) {
    assert.throws(() => signer.signAnswer({ ...answer, [field]: value }), /wrong form/, field);
  }
});

test("writes the text of a signature of the second form as the app reads it", () => {
  // The same text is in apps/wallet/test/bridge/relay_client_test.dart; both sides must agree on it.
  const text = answerMessage({
    nonce: "00112233445566778899aabbccddeeff",
    method: "POST",
    target: "/v1/pay/swaps?x=1",
    requestHash: requestHash(Buffer.from('{"a":1}', "utf8")),
    status: 201,
    body: '{"id":"9f4e2c71b03ad1"}',
  });
  assert.equal(
    text,
    [
      "kranox/answer/2",
      "00112233445566778899aabbccddeeff",
      "POST",
      "/v1/pay/swaps?x=1",
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
      "201",
      '{"id":"9f4e2c71b03ad1"}',
    ].join("\n"),
  );
});

test("serves pay through SimpleSwap when the app names it, and through ChangeNOW when it names none", async () => {
  calls.length = 0;
  simpleCalls.length = 0;
  const [status, body] = await json("/v1/pay/range?provider=simpleswap&asset=usdg&rate=fixed");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    provider: "simpleswap",
    from: "xmr",
    asset: "usdg",
    rate: "fixed",
    minFrom: 0.0246892632,
    maxFrom: 1.495230709567,
    minXmr: 0.0246892632,
    maxXmr: 1.495230709567,
  });
  const [, quote] = await json("/v1/pay/quote?provider=simpleswap&asset=usdg&rate=floating&xmrAmount=0.1");
  assert.equal(quote.provider, "simpleswap");
  assert.equal(quote.amount, 47.953709);
  assert.equal(quote.rateId, null);
  const [, named] = await json("/v1/pay/range?provider=changenow&asset=eth&rate=fixed");
  assert.equal(named.provider, "changenow");
  assert.deepEqual(simpleCalls, [
    ["payRange", "xmr", "usdg", "fixed"],
    ["payEstimate", "xmr", "usdg", "floating", "0.1"],
  ]);
  assert.deepEqual(calls, [["payRange", "xmr", "eth", "fixed"]]);
  const [unknown, unknownBody] = await json("/v1/pay/range?provider=kraken&asset=eth&rate=fixed");
  assert.equal(unknown, 400);
  assert.match(String(unknownBody.error), /changenow, simpleswap/);
});

test("makes a payment through SimpleSwap, checks it against its own names, and reads it back from there", async () => {
  simpleCalls.length = 0;
  const [status, body] = await json(
    "/v1/pay/swaps",
    post({
      provider: "simpleswap",
      asset: "usdg",
      rate: "fixed",
      xmrAmount: "0.1",
      address: RECIPIENT,
      refundAddress: MAINNET_SUBADDRESS,
      rateId: "xmp4w9f3x2cy0tug8ju_rs97tvfcp15d",
    }),
  );
  assert.equal(status, 201);
  assert.deepEqual(body, {
    id: "pch7l7kd1v2mzh1",
    provider: "simpleswap",
    from: "xmr",
    asset: "usdg",
    amount: 47.953709,
    fromAmount: 0.1,
    xmrAmount: 0.1,
    depositAddress: XMR_DEPOSIT,
    payoutAddress: RECIPIENT,
    refundAddress: MAINNET_SUBADDRESS,
    validUntil: null,
    readToken: tokens.issue("pch7l7kd1v2mzh1", "simpleswap"),
  });
  const [read, state] = await json("/v1/swaps/pch7l7kd1v2mzh1?provider=simpleswap", {
    headers: { "kranox-swap-token": tokens.issue("pch7l7kd1v2mzh1", "simpleswap") },
  });
  assert.equal(read, 200);
  assert.equal(state.provider, "simpleswap");
  assert.equal(state.status, "waiting");
  assert.deepEqual(simpleCalls, [
    ["createPay", "xmr", "usdg", "fixed", "0.1", RECIPIENT, MAINNET_SUBADDRESS, "xmp4w9f3x2cy0tug8ju_rs97tvfcp15d"],
    ["status", "pch7l7kd1v2mzh1"],
  ]);
});

test("answers that SimpleSwap is not there when the relay has no key for it", async () => {
  const relayWithout = createRelay({
    exchanger: fake,
    simpleswap: null,
    oneclick: null,
    scanner: null,
    tokens,
    creations: new CreationKeys(60_000, 10),
    signer: new AnswerSigner(signingKeys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()),
    allowedOrigins: [],
  });
  await new Promise<void>((resolve) => relayWithout.listen(0, "127.0.0.1", resolve));
  const port = (relayWithout.address() as AddressInfo).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/pay/range?provider=simpleswap&asset=eth&rate=fixed`);
    assert.equal(response.status, 503);
    assert.match(String(((await response.json()) as Record<string, unknown>).error), /no key for SimpleSwap/);
    const changenow = await fetch(`http://127.0.0.1:${port}/v1/pay/range?asset=eth&rate=fixed`);
    assert.equal(changenow.status, 200, "ChangeNOW still answers");
  } finally {
    relayWithout.close();
  }
});

test("takes the provider of a creation from the body alone, and refuses an empty or null one (R-04)", async () => {
  const good = {
    asset: "eth",
    rate: "floating",
    xmrAmount: "0.015",
    address: RECIPIENT,
    refundAddress: MAINNET_SUBADDRESS,
  };
  for (const provider of [null, ""]) {
    const [status, body] = await json("/v1/pay/swaps", post({ ...good, provider }));
    assert.equal(status, 400, String(provider));
    assert.match(String(body.error), /changenow, simpleswap/);
  }
  const [inQuery, queryBody] = await json("/v1/pay/swaps?provider=simpleswap", post(good));
  assert.equal(inQuery, 400);
  assert.match(String(queryBody.error), /body of the request/);
  const [emptyRange] = await json("/v1/pay/range?provider=&asset=eth&rate=fixed");
  assert.equal(emptyRange, 400, "an empty provider in a query is no choice either");
});

test("binds the read token of a swap to its exchanger (R-03)", async () => {
  const id = "pch7l7kd1v2mzh1";
  const simple = tokens.issue(id, "simpleswap");
  const [right] = await json(`/v1/swaps/${id}?provider=simpleswap`, { headers: { "kranox-swap-token": simple } });
  assert.equal(right, 200);
  const [wrongProvider] = await json(`/v1/swaps/${id}?provider=changenow`, {
    headers: { "kranox-swap-token": simple },
  });
  assert.equal(wrongProvider, 403, "the token of a swap at SimpleSwap reads nothing at ChangeNOW");
  const [otherToken] = await json(`/v1/swaps/${id}?provider=simpleswap`, {
    headers: { "kranox-swap-token": tokens.issue(id, "changenow") },
  });
  assert.equal(otherToken, 403);
});

test("refuses a created exchange whose id the relay could not read back, and names it (R-08)", async () => {
  simpleCalls.length = 0;
  const [status, body] = await json(
    "/v1/pay/swaps",
    post({
      provider: "simpleswap",
      asset: "eth",
      rate: "floating",
      xmrAmount: "0.44",
      address: RECIPIENT,
      refundAddress: MAINNET_SUBADDRESS,
    }),
  );
  assert.equal(status, 502);
  assert.match(String(body.error), /SimpleSwap gave an id of a form/);
  assert.equal(body.exchangeId, "bad id!");
  const [read] = await json("/v1/swaps/pch7l7kd1v2mzh1?provider=simpleswap");
  assert.equal(read, 200, "an id with letters and digits of either exchanger reads");
  const [underscore] = await json("/v1/swaps/ab_cd-ef12?provider=simpleswap");
  assert.notEqual(underscore, 400, "an id with _ or - has the right form");
});

test("checks the key of SimpleSwap and the coins of NEAR Intents too when it is ready (R-11)", async () => {
  calls.length = 0;
  simpleCalls.length = 0;
  oneCalls.length = 0;
  const [status] = await json("/ready");
  assert.equal(status, 200);
  assert.deepEqual(calls, [["min", "eth"]]);
  assert.deepEqual(simpleCalls, [["ready"]]);
  assert.deepEqual(oneCalls, [["ready"]]);
});

test("serves STRK from Starknet through NEAR Intents and ChangeNOW, in the names of every coin of origin", async () => {
  calls.length = 0;
  oneCalls.length = 0;
  const [status, body] = await json("/v1/pay/range?provider=oneclick&from=strk&asset=usdg&rate=floating");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    provider: "oneclick",
    from: "strk",
    asset: "usdg",
    rate: "floating",
    minFrom: 20,
    maxFrom: null,
  });
  const [, changenow] = await json("/v1/pay/range?provider=changenow&from=strk&asset=usdg&rate=fixed");
  assert.deepEqual(changenow, {
    provider: "changenow",
    from: "strk",
    asset: "usdg",
    rate: "fixed",
    minFrom: 110.0639398,
    maxFrom: 9142.3132312,
  });
  const [, quote] = await json("/v1/pay/quote?provider=oneclick&from=strk&asset=usdg&rate=floating&fromAmount=1000");
  assert.deepEqual(quote, {
    provider: "oneclick",
    from: "strk",
    asset: "usdg",
    rate: "floating",
    fromAmount: "1000",
    amount: 86.131039,
    rateId: null,
    validUntil: null,
    warning: null,
    depositFee: null,
    withdrawalFee: 0.075,
    speedMinutes: "1",
    limit: null,
    minFrom: null,
    maxFrom: null,
  });
  const [, below] = await json("/v1/pay/quote?provider=oneclick&from=strk&asset=usdg&rate=floating&fromAmount=5");
  assert.equal(below.amount, null);
  assert.equal(below.limit, "below");
  assert.equal(below.minFrom, 20);
  assert.equal("minXmr" in below, false, "no name of XMR for another coin");
  const [, viaChangenow] = await json(
    "/v1/pay/quote?provider=changenow&from=strk&asset=usdg&rate=floating&fromAmount=1000",
  );
  assert.equal(viaChangenow.amount, 83.542896);
  assert.deepEqual(oneCalls, [
    ["payRange", "strk", "usdg", "floating"],
    ["payEstimate", "strk", "usdg", "floating", "1000"],
    ["payEstimate", "strk", "usdg", "floating", "5"],
  ]);
  assert.deepEqual(calls, [
    ["payRange", "strk", "usdg", "fixed"],
    ["payEstimate", "strk", "usdg", "floating", "1000"],
  ]);
});

test("makes a swap of STRK through NEAR Intents, with its deposit address as its id, and reads it back", async () => {
  oneCalls.length = 0;
  const [status, body] = await json(
    "/v1/pay/swaps",
    post({
      provider: "oneclick",
      from: "strk",
      asset: "usdg",
      rate: "floating",
      fromAmount: "1000",
      address: RECIPIENT,
      refundAddress: STRK_REFUND,
    }),
  );
  assert.equal(status, 201);
  assert.deepEqual(body, {
    id: STRK_DEPOSIT,
    provider: "oneclick",
    from: "strk",
    asset: "usdg",
    amount: 86.131039,
    fromAmount: 1000,
    depositAddress: STRK_DEPOSIT,
    payoutAddress: RECIPIENT.toLowerCase(),
    refundAddress: STRK_REFUND,
    validUntil: "2026-10-13T03:30:00.000Z",
    readToken: tokens.issue(STRK_DEPOSIT, "oneclick"),
  });
  const [read, state] = await json(`/v1/swaps/${STRK_DEPOSIT}?provider=oneclick`, {
    headers: { "kranox-swap-token": tokens.issue(STRK_DEPOSIT, "oneclick") },
  });
  assert.equal(read, 200);
  assert.equal(state.provider, "oneclick");
  assert.equal(state.status, "waiting");
  assert.equal(state.validUntil, "2026-10-13T03:30:00.000Z");
  const [otherToken] = await json(`/v1/swaps/${STRK_DEPOSIT}?provider=oneclick`, {
    headers: { "kranox-swap-token": tokens.issue(STRK_DEPOSIT, "changenow") },
  });
  assert.equal(otherToken, 403);
  assert.deepEqual(oneCalls, [
    ["createPay", "strk", "usdg", "floating", "1000", RECIPIENT, STRK_REFUND, null],
    ["status", STRK_DEPOSIT],
  ]); // A swap that 1Click made other than the request never reaches the app (R-28).
  for (const [fromAmount, reason] of [
    ["66", "not a Starknet address"],
    ["77", "another recipient"],
    ["99", "another pair of coins"],
    ["55", "another refund address"],
  ]) {
    const [failed, failedBody] = await json(
      "/v1/pay/swaps",
      post({
        provider: "oneclick",
        from: "strk",
        asset: "usdg",
        rate: "floating",
        fromAmount,
        address: RECIPIENT,
        refundAddress: STRK_REFUND,
      }),
    );
    assert.equal(failed, 502, fromAmount);
    assert.match(String(failedBody.error), new RegExp(reason), fromAmount);
    assert.equal(failedBody.exchangeId, STRK_DEPOSIT, fromAmount);
  }
});

test("makes a swap of STRK through ChangeNOW, and takes the refund address as the same account without its zero", async () => {
  calls.length = 0;
  const [status, body] = await json(
    "/v1/pay/swaps",
    post({
      provider: "changenow",
      from: "strk",
      asset: "eth",
      rate: "floating",
      fromAmount: "100",
      address: RECIPIENT,
      refundAddress: STRK_REFUND,
    }),
  );
  assert.equal(status, 201);
  assert.equal(body.from, "strk");
  assert.equal(body.depositAddress, STRK_DEPOSIT);
  assert.equal(body.refundAddress, `0x${STRK_REFUND.slice(3)}`, "the app compares what ChangeNOW keeps, by its value");
  assert.equal("xmrAmount" in body, false);
  assert.deepEqual(calls, [["createPay", "strk", "eth", "floating", "100", RECIPIENT, STRK_REFUND, null]]);
  for (const [fromAmount, reason] of [
    ["66", "not a Starknet address"],
    ["55", "another refund address"],
  ]) {
    const [failed, failedBody] = await json(
      "/v1/pay/swaps",
      post({
        provider: "changenow",
        from: "strk",
        asset: "eth",
        rate: "floating",
        fromAmount,
        address: RECIPIENT,
        refundAddress: STRK_REFUND,
      }),
    );
    assert.equal(failed, 502, fromAmount);
    assert.match(String(failedBody.error), new RegExp(reason), fromAmount);
  }
});

test("refuses a pair that an exchanger does not serve, and the names of XMR for another coin", async () => {
  calls.length = 0;
  simpleCalls.length = 0;
  oneCalls.length = 0;
  const [simple, simpleBody] = await json("/v1/pay/range?provider=simpleswap&from=strk&asset=usdg&rate=fixed");
  assert.equal(simple, 422);
  assert.match(String(simpleBody.error), /SimpleSwap does not take STRK/);
  const [fixed, fixedBody] = await json("/v1/pay/range?provider=oneclick&from=strk&asset=usdg&rate=fixed");
  assert.equal(fixed, 422);
  assert.match(String(fixedBody.error), /NEAR Intents has no fixed rate/);
  const [xmrAtOneclick] = await json("/v1/pay/range?provider=oneclick&asset=usdg&rate=floating");
  assert.equal(xmrAtOneclick, 422, "no coin of origin means XMR, which NEAR Intents does not take");
  const [badFrom, badFromBody] = await json("/v1/pay/range?from=btc&asset=usdg&rate=fixed");
  assert.equal(badFrom, 400);
  assert.match(String(badFromBody.error), /xmr, strk/);
  const [emptyFrom] = await json("/v1/pay/range?from=&asset=usdg&rate=fixed");
  assert.equal(emptyFrom, 400);
  const [xmrName, xmrNameBody] = await json(
    "/v1/pay/quote?provider=oneclick&from=strk&asset=usdg&rate=floating&xmrAmount=1000",
  );
  assert.equal(xmrName, 400);
  assert.match(String(xmrNameBody.error), /fromAmount/);
  const [twoAmounts] = await json("/v1/pay/quote?asset=usdg&rate=fixed&xmrAmount=0.1&fromAmount=0.2");
  assert.equal(twoAmounts, 400, "two amounts that differ");
  const [sameAmounts] = await json("/v1/pay/quote?asset=usdg&rate=fixed&xmrAmount=0.1&fromAmount=0.1");
  assert.equal(sameAmounts, 200, "the same amount under both names");
  // The name of every coin without a coin names none; only xmrAmount means XMR by itself (R-19).
  const [nameless, namelessBody] = await json("/v1/pay/quote?asset=usdg&rate=fixed&fromAmount=0.1");
  assert.equal(nameless, 400);
  assert.match(String(namelessBody.error), /coin of origin/);
  const [namelessCreation] = await json(
    "/v1/pay/swaps",
    post({ asset: "usdg", rate: "floating", fromAmount: "0.2", address: RECIPIENT, refundAddress: MAINNET_SUBADDRESS }),
  );
  assert.equal(namelessCreation, 400);
  // A coin holds only so many decimals (R-21): XMR twelve, STRK eighteen.
  const [tooFine, tooFineBody] = await json("/v1/pay/quote?asset=usdg&rate=fixed&xmrAmount=0.1234567890123");
  assert.equal(tooFine, 400);
  assert.match(String(tooFineBody.error), /at most 12 decimals/);
  const [fine] = await json("/v1/pay/quote?asset=usdg&rate=fixed&xmrAmount=0.123456789012");
  assert.equal(fine, 200);
  const [noAmount] = await json("/v1/pay/quote?provider=oneclick&from=strk&asset=usdg&rate=floating");
  assert.equal(noAmount, 400);
  assert.deepEqual(simpleCalls, []);
  assert.deepEqual(oneCalls, []);
  assert.deepEqual(calls, [
    ["payEstimate", "xmr", "usdg", "fixed", "0.1"],
    ["payEstimate", "xmr", "usdg", "fixed", "0.123456789012"],
  ]);
});

test("refuses a refund address that is not one of Starknet for STRK, and keeps the one of Monero for XMR", async () => {
  const good = {
    provider: "oneclick",
    from: "strk",
    asset: "usdg",
    rate: "floating",
    fromAmount: "1000",
    address: RECIPIENT,
    refundAddress: STRK_REFUND,
  };
  for (const refundAddress of [
    MAINNET_SUBADDRESS,
    STRK_REFUND.slice(2),
    `0x${"f".repeat(64)}`,
    `0x${"1".repeat(65)}`,
    "0x0",
    "0x1",
    // The address of the wallet on Robinhood Chain, which stands right under the field of the app (R-13).
    RECIPIENT,
    RECIPIENT.toLowerCase(),
    "",
    undefined,
  ]) {
    const [status, body] = await json("/v1/pay/swaps", post({ ...good, refundAddress }));
    assert.equal(status, 400, String(refundAddress));
    assert.match(String(body.error), /Starknet account address/);
  }
  const [xmrWithStrk, xmrBody] = await json(
    "/v1/pay/swaps",
    post({ asset: "usdg", rate: "floating", xmrAmount: "0.1", address: RECIPIENT, refundAddress: STRK_REFUND }),
  );
  assert.equal(xmrWithStrk, 400);
  assert.match(String(xmrBody.error), /Monero mainnet address/);
  const [withRateId] = await json("/v1/pay/swaps", post({ ...good, rateId: RATE_ID }));
  assert.equal(withRateId, 400, "a floating rate takes no rate id");
});

test("tells the coin of origin apart in the key of a creation", async () => {
  calls.length = 0;
  const keyed = (body: unknown, key: string): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
  const key = "origin0origin0origin0origin0";
  const payment = { asset: "usdg", rate: "floating", address: RECIPIENT, refundAddress: MAINNET_SUBADDRESS };
  const [first] = await json("/v1/pay/swaps", keyed({ ...payment, xmrAmount: "0.2" }, key));
  assert.equal(first, 201);
  const [again] = await json("/v1/pay/swaps", keyed({ ...payment, from: "xmr", fromAmount: "0.2" }, key));
  assert.equal(again, 201, "XMR named with the new names is the same request as XMR as the Mac app sends it");
  const [other] = await json(
    "/v1/pay/swaps",
    keyed({ ...payment, from: "strk", fromAmount: "0.2", refundAddress: STRK_REFUND }, key),
  );
  assert.equal(other, 422, "another coin of origin is another request");
  assert.equal(calls.filter((call) => call[0] === "createPay").length, 1);
});

test("serves ZEC through all three exchangers, at transparent addresses alone", async () => {
  calls.length = 0;
  simpleCalls.length = 0;
  oneCalls.length = 0;
  for (const provider of ["changenow", "simpleswap", "oneclick"] as const) {
    const [status, body] = await json(`/v1/pay/range?provider=${provider}&from=zec&asset=usdg&rate=floating`);
    assert.equal(status, 200, provider);
    assert.equal(body.from, "zec");
    assert.equal("minXmr" in body, false);
  }
  const [simple, simpleBody] = await json(
    "/v1/pay/swaps",
    post({
      provider: "simpleswap",
      from: "zec",
      asset: "usdg",
      rate: "floating",
      fromAmount: "0.1",
      address: RECIPIENT,
      refundAddress: ZEC_REFUND,
    }),
  );
  assert.equal(simple, 201);
  assert.equal(simpleBody.depositAddress, ZEC_DEPOSIT);
  assert.equal(simpleBody.refundAddress, ZEC_REFUND);
  const [one, oneBody] = await json(
    "/v1/pay/swaps",
    post({
      provider: "oneclick",
      from: "zec",
      asset: "eth",
      rate: "floating",
      fromAmount: "0.005",
      address: RECIPIENT,
      refundAddress: ZEC_REFUND,
    }),
  );
  assert.equal(one, 201);
  assert.equal(oneBody.id, ZEC_DEPOSIT, "the deposit address names the swap at 1Click");
  assert.equal(oneBody.readToken, tokens.issue(ZEC_DEPOSIT, "oneclick"));
  const [read] = await json(`/v1/swaps/${ZEC_DEPOSIT}?provider=oneclick`, {
    headers: { "kranox-swap-token": tokens.issue(ZEC_DEPOSIT, "oneclick") },
  });
  assert.equal(read, 200);
  // A refund can only go to a transparent address: a shielded one, a unified one, one with a wrong checksum, and the
  // addresses of the other chains are refused before any call.
  const changed = `${ZEC_REFUND.slice(0, 20)}${ZEC_REFUND[20] === "a" ? "b" : "a"}${ZEC_REFUND.slice(21)}`;
  for (const refundAddress of [
    "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8f3g2d4kv4v9q0jfgcm3vhk3wm6ajqmp8",
    "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpjkmh6xfyau7zh33ac",
    changed,
    MAINNET_SUBADDRESS,
    STRK_REFUND,
  ]) {
    const [status, body] = await json(
      "/v1/pay/swaps",
      post({
        provider: "changenow",
        from: "zec",
        asset: "usdg",
        rate: "floating",
        fromAmount: "0.1",
        address: RECIPIENT,
        refundAddress,
      }),
    );
    assert.equal(status, 400, refundAddress);
    assert.match(String(body.error), /transparent Zcash address/);
  }
  const [tooFine, tooFineBody] = await json("/v1/pay/quote?from=zec&asset=usdg&rate=floating&fromAmount=0.123456789");
  assert.equal(tooFine, 400);
  assert.match(String(tooFineBody.error), /at most 8 decimals/);
  // ZEC through ChangeNOW: a swap as asked, and none whose deposit address is not transparent or whose refund address
  // differs (R-32).
  calls.length = 0;
  const [viaChangenow, viaChangenowBody] = await json(
    "/v1/pay/swaps",
    post({
      provider: "changenow",
      from: "zec",
      asset: "usdg",
      rate: "fixed",
      fromAmount: "0.1",
      address: RECIPIENT,
      refundAddress: ZEC_REFUND,
      rateId: RATE_ID,
    }),
  );
  assert.equal(viaChangenow, 201);
  assert.equal(viaChangenowBody.depositAddress, ZEC_DEPOSIT);
  for (const [fromAmount, reason] of [
    ["66", "not a transparent Zcash address"],
    ["55", "another refund address"],
  ]) {
    const [failed, failedBody] = await json(
      "/v1/pay/swaps",
      post({
        provider: "changenow",
        from: "zec",
        asset: "usdg",
        rate: "floating",
        fromAmount,
        address: RECIPIENT,
        refundAddress: ZEC_REFUND,
      }),
    );
    assert.equal(failed, 502, fromAmount);
    assert.match(String(failedBody.error), new RegExp(reason), fromAmount);
    assert.equal(failedBody.exchangeId, "9f4e2c71b03ad1", fromAmount);
  }
  assert.equal(calls.filter((call) => call[0] === "createPay").length, 3);
  const [strkAtSimple] = await json("/v1/pay/range?provider=simpleswap&from=strk&asset=usdg&rate=floating");
  assert.equal(strkAtSimple, 422, "SimpleSwap still takes no STRK");
  assert.deepEqual(oneCalls, [
    ["payRange", "zec", "usdg", "floating"],
    ["createPay", "zec", "eth", "floating", "0.005", RECIPIENT, ZEC_REFUND, null],
    ["status", ZEC_DEPOSIT],
  ]);
});
