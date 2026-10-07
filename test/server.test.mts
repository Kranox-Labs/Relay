import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { UpstreamError, type ChainAsset, type Exchanger, type PayRate } from "../src/changenow.mts";
import { createRelay } from "../src/server.mts";

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
  async minAmount(asset: ChainAsset) {
    calls.push(["min", asset]);
    if (minAmountFails) throw new UpstreamError(401, "Invalid api key: the account of Kranox is suspended");
    return 0.004;
  },
  async estimate(asset: ChainAsset, amount: string) {
    calls.push(["estimate", asset, amount]);
    return { amount: 0.0271, speedMinutes: "10-60", warning: null };
  },
  async create(asset: ChainAsset, amount: string, address: string, refundAddress: string | null) {
    calls.push(["create", asset, amount, address, refundAddress]);
    if (amount === "0.001") throw new UpstreamError(400, "Amount is less than minimal");
    // Four amounts stand for faults of ChangeNOW: another payout address, a deposit address that is not on Robinhood
    // Chain, another amount, and another pair of coins.
    return {
      id: "3a2360771439a3",
      fromAmount: amount === "0.0088" ? 0.0089 : Number(amount),
      toAmount: 0.0271,
      payinAddress: amount === "0.0077" ? "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" : CHAIN_DEPOSIT,
      payoutAddress: amount === "0.0066" ? XMR_DEPOSIT : address,
      ...RECEIVE_PAIR,
      fromCurrency: amount === "0.0099" ? "btc" : asset,
    };
  },
  // The ranges and the estimates of 6 Oct 2026: a fixed rate from 0.0227 XMR with a top, a floating one from 0.0119.
  async payRange(asset: ChainAsset, rate: PayRate) {
    calls.push(["payRange", asset, rate]);
    return rate === "fixed" ? { minXmr: 0.02267982, maxXmr: 1.451521737121 } : { minXmr: 0.0118679, maxXmr: null };
  },
  async payEstimate(asset: ChainAsset, rate: PayRate, xmrAmount: string) {
    calls.push(["payEstimate", asset, rate, xmrAmount]);
    if (xmrAmount === "0.01") return { limit: "below" as const, minXmr: 0.0227, maxXmr: 1.4505 };
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
    asset: ChainAsset,
    rate: PayRate,
    xmrAmount: string,
    address: string,
    refundAddress: string,
    rateId: string | null,
  ) {
    calls.push(["createPay", asset, rate, xmrAmount, address, refundAddress, rateId]);
    // Four amounts stand for faults of ChangeNOW: a deposit address that is not a Monero one, another recipient,
    // another amount of XMR, and another flow.
    return {
      id: "9f4e2c71b03ad1",
      fromAmount: xmrAmount === "0.88" ? 0.89 : Number(xmrAmount),
      toAmount: 51.229932,
      payinAddress: xmrAmount === "0.66" ? "0xnotmonero" : XMR_DEPOSIT,
      payoutAddress: xmrAmount === "0.77" ? REFUND_ADDRESS : address.toLowerCase(),
      fromCurrency: "xmr",
      fromNetwork: "xmr",
      toCurrency: asset,
      toNetwork: "hood",
      // ChangeNOW leaves out the flow of a floating payment here, which the relay lets pass.
      flow: xmrAmount === "0.99" ? "standard" : rate === "fixed" ? "fixed-rate" : null,
    };
  },
  async status(id: string) {
    calls.push(["status", id]);
    // Some ids stand for error answers of ChangeNOW.
    const refusal = STATUS_REFUSALS[id];
    if (refusal !== undefined) throw new UpstreamError(refusal[0], refusal[1]);
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

const relay = createRelay(fake);
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
  assert.deepEqual(calls, [["create", "eth", "0.0055", MAINNET_SUBADDRESS, REFUND_ADDRESS]]);
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
  ]) {
    const [status, body] = await json("/v1/receive/swaps", post({ asset: "eth", amount, address: MAINNET_SUBADDRESS }));
    assert.equal(status, 502, amount);
    assert.match(String(body.error), new RegExp(reason), amount);
    assert.equal(body.exchangeId, "3a2360771439a3", amount);
  }
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
    "payoutHash",
    "refundAddress",
    "refundAmount",
    "refundHash",
    "status",
    "updatedAt",
    "validUntil",
  ]);
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
  assert.deepEqual(body, { asset: "eth", rate: "fixed", minXmr: 0.02267982, maxXmr: 1.451521737121 });
  const [, floating] = await json("/v1/pay/range?asset=eth&rate=floating");
  assert.deepEqual(floating, { asset: "eth", rate: "floating", minXmr: 0.0118679, maxXmr: null });
  for (const query of ["asset=btc&rate=fixed", "asset=eth", "asset=eth&rate=best"]) {
    const [bad] = await json(`/v1/pay/range?${query}`);
    assert.equal(bad, 400, query);
  }
});

test("quotes the coin that an amount of XMR buys at a fixed rate, with the fees of ChangeNOW", async () => {
  const [status, body] = await json("/v1/pay/quote?asset=usdg&rate=fixed&xmrAmount=0.1");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    asset: "usdg",
    rate: "fixed",
    xmrAmount: "0.1",
    amount: 51.229932,
    rateId: RATE_ID,
    validUntil: "2026-10-06T03:07:28.793Z",
    warning: null,
    depositFee: 0.006,
    withdrawalFee: 0.7370513,
    speedMinutes: null,
    limit: null,
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
    asset: "usdg",
    amount: 51.229932,
    xmrAmount: 0.1,
    depositAddress: XMR_DEPOSIT,
    payoutAddress: RECIPIENT.toLowerCase(),
  });
  assert.deepEqual(calls, [["createPay", "usdg", "fixed", "0.1", RECIPIENT, MAINNET_SUBADDRESS, RATE_ID]]);
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
  assert.deepEqual(calls, [["createPay", "eth", "floating", "0.015", RECIPIENT, MAINNET_SUBADDRESS, null]]);
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
