import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ONECLICK_DEADLINE_MS,
  ONECLICK_ESTIMATES_PER_SECOND,
  ONECLICK_ESTIMATE_CACHE_MS,
  ONECLICK_MIN_FROM,
  ONECLICK_STATUS_CACHE_MS,
  ONECLICK_TOKENS_CACHE_MS,
} from "../src/config.mts";
import { GatewayError, UpstreamError } from "../src/exchanger.mts";
import { OneClick, fromBaseUnits, toBaseUnits } from "../src/oneclick.mts";
import { isStarknetAddress } from "../src/starknet.mts";
import { isZcashTransparentAddress } from "../src/zcash.mts";

const KEY = "test-jwt-of-near-intents";
// The recipient in the checksum case of EIP-55, which 1Click refuses, and as the relay sends it.
const RECIPIENT = "0x7a3fC0e1b9D24A6c58E0f3B1d9a7C4e2F6b8D015";
const RECIPIENT_LOWER = RECIPIENT.toLowerCase();
// The refund address on Starknet and the deposit address of a swap, both of the usual length.
const REFUND = "0x04a3f9c1b2e7d8a5c6f0e1d2c3b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f70";
const DEPOSIT = "0x01d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2";
const STRK = "nep141:starknet.omft.near";
const USDG = "nep141:hood-0x5fc5360d0400a0fd4f2af552add042d716f1d168.omft.near";
const ETH = "nep141:hood.omft.near";

interface Sent {
  url: string;
  init: RequestInit;
}

/** A fetch that answers every call with [answer] and keeps what the client sent. */
function fakeFetch(answer: (sent: Sent) => Response): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    sent.push(call);
    return answer(call);
  }) as typeof fetch;
  return { fetchImpl, sent };
}

function clock(start = Date.parse("2026-10-13T03:10:00.000Z")): { now: () => number; advance: (ms: number) => void } {
  let time = start;
  return { now: () => time, advance: (ms) => (time += ms) };
}

const body = (sent: Sent): Record<string, unknown> => JSON.parse(String(sent.init.body)) as Record<string, unknown>;

/** The answer of 1Click to a quote of 1000 STRK into USDG, as it came on 13 Oct 2026, with the request echoed. */
function quoteAnswer(request: Record<string, unknown>, quote: Record<string, unknown> = {}): Response {
  return Response.json(
    {
      quote: {
        amountIn: "1000000000000000000000",
        amountInFormatted: "1000.0",
        amountInUsd: "85.914",
        minAmountIn: "1000000000000000000000",
        amountOut: "86131039",
        amountOutFormatted: "86.131039",
        amountOutUsd: "85.914",
        minAmountOut: "85269728",
        timeEstimate: 26,
        refundFee: "434464885069261258",
        withdrawFee: "75000",
        ...quote,
      },
      quoteRequest: { ...request, confidentiality: "public", insured: false },
      signature: "ed25519:2gWsB3qoGXksCzgvo68Tg6Qr3dfRT7p4iCmxTjRF5cgEx9wUJtSdsq3YZnENmQnx3qBXXgkqiAJwz3WRyX21YEQB",
      timestamp: "2026-10-13T03:10:22.063Z",
      correlationId: "330dd4c2-297f-42dd-8880-06abd86a07d1",
    },
    { status: 201 },
  );
}

/** A refusal of 1Click, as it writes one. */
const refusal = (status: number, message: string): Response =>
  Response.json(
    { message, correlationId: "b2434cd1", timestamp: "2026-10-13T03:09:25.249Z", path: "/v0/quote" },
    { status },
  );

/**
 * The state of a swap at 1Click, as GET /v0/status writes it: the deadline of the request is the time to send, and the
 * deadline of the quote, three days later, the time the address stops taking anything.
 */
function statusAnswer(
  status: string,
  details: Record<string, unknown> = {},
  deadline: string | null = "2026-10-13T03:30:00.000Z",
): Response {
  return Response.json({
    correlationId: "550e8400",
    quoteResponse: {
      quote: { amountOutFormatted: "86.131039", depositAddress: DEPOSIT, deadline: "2026-10-16T03:30:00.000Z" },
      quoteRequest: { refundTo: REFUND, recipient: RECIPIENT_LOWER, ...(deadline === null ? {} : { deadline }) },
    },
    status,
    updatedAt: "2026-10-13T03:12:00.000Z",
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [],
      ...details,
    },
  });
}

const deposited = { originChainTxHashes: [{ hash: "0xdeposit", explorerUrl: "https://x" }] };

test("writes amounts in base units and reads them back", () => {
  assert.equal(toBaseUnits("1000", 18), "1000000000000000000000");
  assert.equal(toBaseUnits("12.5", 18), "12500000000000000000");
  assert.equal(toBaseUnits("0.000001", 6), "1");
  assert.equal(toBaseUnits("0.5", 6), "500000");
  assert.throws(() => toBaseUnits("0.0000001", 6), RangeError, "more decimals than the coin has");
  assert.throws(() => toBaseUnits("1e3", 18), RangeError);
  assert.throws(() => toBaseUnits("1.2.3", 18), RangeError, "a third part is no part of a number (R-21)");
  assert.equal(fromBaseUnits("75000", 6), 0.075);
  assert.equal(fromBaseUnits("10000000000000", 18), 0.00001);
  assert.equal(fromBaseUnits("0.5", 6), null);
  assert.equal(fromBaseUnits(75000, 6), null);
});

test("names its range without a call, and refuses an amount below the minimum of the relay without one", async () => {
  const { fetchImpl, sent } = fakeFetch(() => refusal(500, "never asked"));
  const oneclick = new OneClick(KEY, { fetchImpl });
  assert.deepEqual(oneclick.origins, ["strk", "zec"]);
  assert.deepEqual(await oneclick.payRange("strk", "usdg", "floating"), {
    minFrom: ONECLICK_MIN_FROM.strk,
    maxFrom: null,
  });
  assert.deepEqual(await oneclick.payEstimate("strk", "usdg", "floating", "5"), {
    limit: "below",
    minFrom: ONECLICK_MIN_FROM.strk,
    maxFrom: null,
  });
  assert.equal(sent.length, 0, "no call reaches 1Click");
  await assert.rejects(oneclick.payRange("xmr", "usdg", "floating"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.match(error.message, /does not take XMR/);
    return true;
  });
  await assert.rejects(oneclick.payRange("strk", "usdg", "fixed"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.match(error.message, /no fixed rate/);
    return true;
  });
});

test("estimates with a dry quote in base units, the key in a header only, and no redirect", async () => {
  const time = clock();
  const { fetchImpl, sent } = fakeFetch((call) => quoteAnswer(body(call)));
  const oneclick = new OneClick(KEY, { fetchImpl, now: time.now });
  const estimate = await oneclick.payEstimate("strk", "usdg", "floating", "1000");
  assert.deepEqual(estimate, {
    amount: 86.131039,
    rateId: null,
    validUntil: null,
    warning: null,
    depositFee: null,
    withdrawalFee: 0.075,
    speedMinutes: "1",
  });
  assert.equal(sent.length, 1);
  assert.equal(new URL(sent[0].url).pathname, "/v0/quote");
  assert.equal(sent[0].init.method, "POST");
  assert.equal(sent[0].init.redirect, "error");
  const headers = sent[0].init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${KEY}`);
  assert.ok(!sent[0].url.includes(KEY), "the key stays out of the URL");
  const request = body(sent[0]);
  assert.equal(request.dry, true);
  assert.equal(request.swapType, "EXACT_INPUT");
  assert.equal(request.originAsset, STRK);
  assert.equal(request.destinationAsset, USDG);
  assert.equal(request.amount, "1000000000000000000000");
  assert.equal(request.depositType, "ORIGIN_CHAIN");
  assert.equal(request.refundType, "ORIGIN_CHAIN");
  assert.equal(request.recipientType, "DESTINATION_CHAIN");
  assert.equal(request.referral, "kranox");
  assert.equal(request.deadline, new Date(time.now() + ONECLICK_DEADLINE_MS).toISOString());
  assert.ok(!String(request.recipient).includes(RECIPIENT_LOWER), "a dry quote names no address of a user");
  // Without a key, no header of a key goes out; an empty key is no key either (R-26).
  for (const key of [null, ""]) {
    const without = fakeFetch((call) => quoteAnswer(body(call)));
    await new OneClick(key, without).payEstimate("strk", "eth", "floating", "1000");
    assert.equal("authorization" in (without.sent[0].init.headers as Record<string, string>), false);
    assert.equal(body(without.sent[0]).destinationAsset, ETH);
  }
});

test("takes ZEC at a transparent address, with its minimum and its minutes", async () => {
  const { fetchImpl, sent } = fakeFetch((call) =>
    quoteAnswer(body(call), {
      amountIn: "500000",
      amountInFormatted: "0.005",
      amountOut: "6040294",
      amountOutFormatted: "6.040294",
      timeEstimate: 454,
      refundFee: "32000",
    }),
  );
  const oneclick = new OneClick(KEY, { fetchImpl });
  assert.deepEqual(await oneclick.payRange("zec", "usdg", "floating"), {
    minFrom: ONECLICK_MIN_FROM.zec,
    maxFrom: null,
  });
  assert.deepEqual(await oneclick.payEstimate("zec", "usdg", "floating", "0.001"), {
    limit: "below",
    minFrom: ONECLICK_MIN_FROM.zec,
    maxFrom: null,
  });
  const estimate = await oneclick.payEstimate("zec", "usdg", "floating", "0.005");
  assert.ok(!("limit" in estimate));
  assert.equal(estimate.amount, 6.040294);
  assert.equal(estimate.speedMinutes, "8", "454 seconds, rounded up");
  assert.equal(body(sent[0]).originAsset, "nep141:zec.omft.near");
  assert.equal(body(sent[0]).amount, "500000", "0.005 ZEC in its 8 decimals");
  assert.match(String(body(sent[0]).refundTo), /^t1/, "the refund address of a dry quote is one of Zcash");
  // The floor of the bridge of 1Click, in base units, reads as the least that goes through (R-29).
  const floored = fakeFetch(() => refusal(400, "Amount is too low for bridge, try at least 600000"));
  assert.deepEqual(await new OneClick(KEY, floored).payEstimate("zec", "usdg", "floating", "0.005"), {
    limit: "below",
    minFrom: 0.006,
    maxFrom: null,
  });
  const otherRefusal = fakeFetch(() => refusal(400, "recipient is not valid"));
  await assert.rejects(new OneClick(KEY, otherRefusal).payEstimate("zec", "usdg", "floating", "0.005"), UpstreamError);
  assert.deepEqual(oneclick.payNames("zec", "eth", "floating"), {
    from: { currency: "nep141:zec.omft.near", network: "zec" },
    to: { currency: ETH, network: "hood" },
    flow: "EXACT_INPUT",
  });
});

test("quotes dry with a refund address of the chain that belongs to nobody, and makes no swap for it (R-30)", async () => {
  const checks = { strk: isStarknetAddress, zec: isZcashTransparentAddress } as const;
  for (const [from, amount] of [
    ["strk", "1000"],
    ["zec", "0.1"],
  ] as const) {
    const { fetchImpl, sent } = fakeFetch((call) => quoteAnswer(body(call), { depositAddress: DEPOSIT }));
    const oneclick = new OneClick(KEY, { fetchImpl });
    await oneclick.payEstimate(from, "usdg", "floating", amount);
    const refundTo = String(body(sent[0]).refundTo);
    assert.equal(checks[from](refundTo), true, `${from}: the placeholder is an address of its chain`);
    await assert.rejects(
      oneclick.createPay(from, "usdg", "floating", amount, RECIPIENT, refundTo, null),
      /addresses of a dry quote/,
      from,
    );
    assert.equal(sent.length, 1, `${from}: no swap is made for the placeholder`);
  }
});

test("keeps a quote for a few seconds, so that the pages of the app spend one call on it", async () => {
  const time = clock();
  const { fetchImpl, sent } = fakeFetch((call) => quoteAnswer(body(call)));
  const oneclick = new OneClick(KEY, { fetchImpl, now: time.now });
  await oneclick.payEstimate("strk", "usdg", "floating", "1000");
  await oneclick.payEstimate("strk", "usdg", "floating", "1000");
  assert.equal(sent.length, 1, "the same quote again comes from memory");
  await oneclick.payEstimate("strk", "usdg", "floating", "2000");
  assert.equal(sent.length, 2, "another amount is its own quote");
  time.advance(ONECLICK_ESTIMATE_CACHE_MS);
  await oneclick.payEstimate("strk", "usdg", "floating", "1000");
  assert.equal(sent.length, 3, "an old quote is asked for again");
});

test("makes a swap with a real quote, the recipient in lowercase, and the deposit address as its id", async () => {
  const time = clock();
  const { fetchImpl, sent } = fakeFetch((call) =>
    quoteAnswer(body(call), { depositAddress: DEPOSIT, deadline: "2026-10-16T03:30:00.000Z" }),
  );
  const oneclick = new OneClick(KEY, { fetchImpl, now: time.now });
  const created = await oneclick.createPay("strk", "usdg", "floating", "1000", RECIPIENT, REFUND, null);
  assert.deepEqual(created, {
    id: DEPOSIT,
    fromAmount: 1000,
    toAmount: 86.131039,
    payinAddress: DEPOSIT,
    payoutAddress: RECIPIENT_LOWER,
    refundAddress: REFUND,
    fromCurrency: STRK,
    fromNetwork: null,
    toCurrency: USDG,
    toNetwork: null,
    flow: "EXACT_INPUT",
    // The time to send is the deadline of the request, not the deadline of the quote three days later (R-25).
    validUntil: new Date(time.now() + ONECLICK_DEADLINE_MS).toISOString(),
  });
  const request = body(sent[0]);
  assert.equal(request.dry, false);
  assert.equal(request.recipient, RECIPIENT_LOWER);
  assert.equal(request.refundTo, REFUND);
  assert.deepEqual(oneclick.payNames("strk", "usdg", "floating"), {
    from: { currency: STRK, network: "starknet" },
    to: { currency: USDG, network: "hood" },
    flow: "EXACT_INPUT",
  });
});

test("refuses a swap of another kind, amount, or time, one whose deposit needs a memo, and a rate by an id", async () => {
  // The echo of the request must match what was sent, field by field: a deposit into an account of NEAR Intents, a
  // real quote marked dry, another amount in base units, another deadline, another recipient (R-17, R-22).
  for (const [field, value] of [
    ["depositType", "INTENTS"],
    ["dry", true],
    ["amount", "999000000000000000000"],
    ["deadline", "2026-10-16T03:30:00.000Z"],
    ["recipient", RECIPIENT],
  ] as const) {
    const odd = fakeFetch((call) => quoteAnswer({ ...body(call), [field]: value }, { depositAddress: DEPOSIT }));
    await assert.rejects(
      new OneClick(KEY, odd).createPay("strk", "usdg", "floating", "1000", RECIPIENT, REFUND, null),
      (error: unknown) => {
        assert.ok(error instanceof GatewayError);
        assert.equal(error.status, 502);
        assert.match(error.message, new RegExp(`another request \\(${field}\\)`));
        assert.equal(error.exchangeId, DEPOSIT, "the deposit address names the swap for support");
        return true;
      },
      field,
    );
  }
  const otherIn = fakeFetch((call) =>
    quoteAnswer(body(call), { depositAddress: DEPOSIT, amountIn: "999000000000000000000" }),
  );
  await assert.rejects(
    new OneClick(KEY, otherIn).createPay("strk", "usdg", "floating", "1000", RECIPIENT, REFUND, null),
    /another amount in/,
  );
  const memo = fakeFetch((call) => quoteAnswer(body(call), { depositAddress: DEPOSIT, depositMemo: "1111111" }));
  await assert.rejects(
    new OneClick(KEY, memo).createPay("strk", "usdg", "floating", "1000", RECIPIENT, REFUND, null),
    (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.match(error.message, /memo/);
      assert.equal(error.exchangeId, DEPOSIT);
      return true;
    },
  );
  const { fetchImpl, sent } = fakeFetch((call) => quoteAnswer(body(call), { depositAddress: DEPOSIT }));
  await assert.rejects(
    new OneClick(KEY, { fetchImpl }).createPay("strk", "usdg", "floating", "1000", RECIPIENT, REFUND, "rate-id"),
    /no rate by an id/,
  );
  // The addresses of a dry quote belong to nobody: no swap for them, and no call (R-22).
  await assert.rejects(
    new OneClick(KEY, { fetchImpl }).createPay(
      "strk",
      "usdg",
      "floating",
      "1000",
      "0x1111111111111111111111111111111111111111",
      REFUND,
      null,
    ),
    /addresses of a dry quote/,
  );
  assert.equal(sent.length, 0, "no swap is made for a rate id or for the addresses of a dry quote");
  const noAddress = fakeFetch((call) => quoteAnswer(body(call)));
  await assert.rejects(
    new OneClick(KEY, noAddress).createPay("strk", "usdg", "floating", "1000", RECIPIENT, REFUND, null),
    /depositAddress/,
  );
});

test("reads the state of a swap by its deposit address, in the words of the app", async () => {
  const time = clock(Date.parse("2026-10-13T03:12:00.000Z"));
  let state: Response = statusAnswer("PENDING_DEPOSIT");
  const { fetchImpl, sent } = fakeFetch(() => state);
  const oneclick = new OneClick(KEY, { fetchImpl, now: time.now });
  // Each read comes once the state kept from the last ran out, as the app reads every 15 seconds, so that each read
  // reaches 1Click and the budget of a second never runs out here.
  const read = () => {
    time.advance(ONECLICK_STATUS_CACHE_MS + 1000);
    return oneclick.status(DEPOSIT);
  };
  assert.deepEqual(await read(), {
    status: "waiting",
    amountTo: null,
    expectedAmountTo: 86.131039,
    payinHash: null,
    payoutHash: null,
    refundAddress: REFUND,
    refundHash: null,
    refundAmount: null,
    updatedAt: "2026-10-13T03:12:00.000Z",
    validUntil: "2026-10-13T03:30:00.000Z",
  });
  const url = new URL(sent[0].url);
  assert.equal(url.pathname, "/v0/status");
  assert.equal(url.searchParams.get("depositAddress"), DEPOSIT);
  assert.equal(sent[0].init.method, "GET");
  state = statusAnswer("KNOWN_DEPOSIT_TX", deposited);
  const confirming = await read();
  assert.equal(confirming.status, "confirming");
  assert.equal(confirming.payinHash, "0xdeposit");
  state = statusAnswer("PROCESSING");
  assert.equal((await read()).status, "exchanging");
  state = statusAnswer("SUCCESS", {
    amountOutFormatted: "86.0",
    ...deposited,
    destinationChainTxHashes: [{ hash: "0xpayout", explorerUrl: "https://y" }],
  });
  const done = await read();
  assert.equal(done.status, "finished");
  assert.equal(done.amountTo, 86);
  assert.equal(done.payoutHash, "0xpayout");
  state = statusAnswer("REFUNDED", { refundedAmountFormatted: "999.5", refundReason: "PARTIAL_DEPOSIT" });
  const refunded = await read();
  assert.equal(refunded.status, "refunded");
  assert.equal(refunded.refundAmount, 999.5);
  state = statusAnswer("FAILED");
  assert.equal((await read()).status, "failed");
  // A part of the deposit arrived: 1Click holds it and refunds it at the deadline, so the app shows it as confirming,
  // never the box to send again, and never that time ran out (R-14).
  state = statusAnswer("INCOMPLETE_DEPOSIT", { originChainTxHashes: [{ hash: "0xpart", explorerUrl: "https://x" }] });
  const partial = await read();
  assert.equal(partial.status, "confirming");
  assert.equal(partial.payinHash, "0xpart");
  // A deposit address that waits past its deadline takes no deposit any more: the app must say that time ran out.
  state = statusAnswer("PENDING_DEPOSIT");
  time.advance(30 * 60_000);
  assert.equal((await read()).status, "expired");
  state = statusAnswer("PENDING_DEPOSIT", deposited);
  assert.equal((await read()).status, "waiting", "but not while a deposit is in (R-14)");
  state = statusAnswer("INCOMPLETE_DEPOSIT", deposited);
  assert.equal((await read()).status, "confirming", "nor for a part of the deposit, past the deadline");
  // Without the deadline of the request the relay names no time to send and never says that it ran out (R-18).
  state = statusAnswer("PENDING_DEPOSIT", {}, null);
  const noDeadline = await read();
  assert.equal(noDeadline.status, "waiting");
  assert.equal(noDeadline.validUntil, null);
  // A state named like a member of Object.prototype is no state (R-16), nor is one the app does not know.
  for (const odd of ["constructor", "__proto__", "SOMETHING_NEW"]) {
    state = statusAnswer(odd);
    await assert.rejects(
      read(),
      (error: unknown) => {
        assert.ok(error instanceof GatewayError);
        assert.match(error.message, /unknown state/);
        return true;
      },
      odd,
    );
  }
  state = refusal(404, "Deposit address not found");
  await assert.rejects(read(), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 404);
    assert.equal(error.service, "NEAR Intents");
    return true;
  });
});

test("keeps the state of a swap for a few seconds, so that several pages of one swap spend one call (R-15)", async () => {
  const time = clock();
  const { fetchImpl, sent } = fakeFetch(() => statusAnswer("PENDING_DEPOSIT"));
  const oneclick = new OneClick(KEY, { fetchImpl, now: time.now });
  await oneclick.status(DEPOSIT);
  await oneclick.status(DEPOSIT);
  assert.equal(sent.length, 1, "the same swap again comes from memory");
  await oneclick.status(REFUND);
  assert.equal(sent.length, 2, "another swap is its own read");
  time.advance(ONECLICK_STATUS_CACHE_MS);
  await oneclick.status(DEPOSIT);
  assert.equal(sent.length, 3, "an old state is read again");
});

test("checks the token list for /ready, and with a key one dry quote of the minimum, and says when a coin is gone", async () => {
  const time = clock();
  const tokens = [
    { assetId: STRK, symbol: "STRK", blockchain: "starknet", decimals: 18 },
    { assetId: USDG, symbol: "USDG", blockchain: "hood", decimals: 6 },
    { assetId: ETH, symbol: "ETH", blockchain: "hood", decimals: 18 },
    { assetId: "nep141:zec.omft.near", symbol: "ZEC", blockchain: "zec", decimals: 8 },
  ];
  let list: unknown = tokens;
  const { fetchImpl, sent } = fakeFetch((call) =>
    new URL(call.url).pathname === "/v0/tokens" ? Response.json(list) : quoteAnswer(body(call)),
  );
  const oneclick = new OneClick(KEY, { fetchImpl, now: time.now });
  await oneclick.ready();
  assert.equal(new URL(sent[0].url).pathname, "/v0/tokens");
  // With a partner key, one dry quote of the minimum of each coin shows that 1Click takes the key (R-23) and that the
  // floor of its bridge lies under the minimum of the relay (R-29).
  assert.equal(new URL(sent[1].url).pathname, "/v0/quote");
  assert.equal(body(sent[1]).dry, true);
  assert.equal(body(sent[1]).amount, toBaseUnits(String(ONECLICK_MIN_FROM.strk), 18));
  assert.equal(body(sent[2]).originAsset, "nep141:zec.omft.near");
  assert.equal(body(sent[2]).amount, toBaseUnits(String(ONECLICK_MIN_FROM.zec), 8));
  await oneclick.ready();
  assert.equal(sent.length, 3, "the check runs once in a while");
  // A floor of the bridge above the minimum of the relay fails the check.
  const floored = fakeFetch((call) =>
    new URL(call.url).pathname === "/v0/tokens"
      ? Response.json(tokens)
      : body(call).originAsset === "nep141:zec.omft.near"
        ? refusal(400, "Amount is too low for bridge, try at least 600000")
        : quoteAnswer(body(call)),
  );
  await assert.rejects(new OneClick(KEY, floored).ready(), /ZEC from 0.006, above the minimum/);
  time.advance(ONECLICK_TOKENS_CACHE_MS);
  list = tokens.filter((token) => token.symbol !== "USDG");
  await assert.rejects(oneclick.ready(), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.match(error.message, /USDG on hood/);
    return true;
  });
  // A failed check is not kept, so each try reads the list again, a second apart for the budget of the second.
  time.advance(1000);
  list = tokens.map((token) => (token.symbol === "STRK" ? { ...token, decimals: 6 } : token));
  await assert.rejects(oneclick.ready(), /STRK on starknet/);
  time.advance(1000);
  list = { not: "a list" };
  await assert.rejects(oneclick.ready(), /tokens/);
  // Without a key, the token list alone.
  const keyless = fakeFetch(() => Response.json(tokens));
  await new OneClick(null, keyless).ready();
  assert.equal(keyless.sent.length, 1);
});

test("stops the estimates above their budget of a second, while a read and a swap keep their own (R-15)", async () => {
  const time = clock();
  const { fetchImpl, sent } = fakeFetch((call) =>
    new URL(call.url).pathname === "/v0/status"
      ? statusAnswer("PENDING_DEPOSIT")
      : quoteAnswer(body(call), { depositAddress: DEPOSIT }),
  );
  const oneclick = new OneClick(KEY, { fetchImpl, now: time.now });
  for (let call = 0; call < ONECLICK_ESTIMATES_PER_SECOND; call++) {
    await oneclick.payEstimate("strk", "usdg", "floating", String(100 + call));
  }
  await assert.rejects(oneclick.payEstimate("strk", "usdg", "floating", "500"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(sent.length, ONECLICK_ESTIMATES_PER_SECOND, "the estimate over the budget never reaches 1Click");
  assert.equal((await oneclick.status(DEPOSIT)).status, "waiting", "a read has its own budget");
  const created = await oneclick.createPay("strk", "usdg", "floating", "1000", RECIPIENT, REFUND, null);
  assert.equal(created.id, DEPOSIT, "a swap has its own budget");
  time.advance(1000 / ONECLICK_ESTIMATES_PER_SECOND);
  await oneclick.payEstimate("strk", "usdg", "floating", "500");
  assert.equal(sent.length, ONECLICK_ESTIMATES_PER_SECOND + 3);
});

test("answers a refusal, a refused key, and a failure of 1Click with the status of the answer and its service", async () => {
  const bad = fakeFetch(() => refusal(400, "recipient is not valid"));
  await assert.rejects(new OneClick(KEY, bad).payEstimate("strk", "usdg", "floating", "1000"), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 400);
    assert.equal(error.message, "recipient is not valid");
    assert.equal(error.service, "NEAR Intents");
    return true;
  });
  const unauthorized = fakeFetch(() => refusal(401, "User authentication is required for confidential intent quotes"));
  await assert.rejects(
    new OneClick(null, unauthorized).payEstimate("strk", "usdg", "floating", "1000"),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.status, 401);
      return true;
    },
  );
  const down = fakeFetch(() => {
    throw new Error("connection refused");
  });
  await assert.rejects(new OneClick(KEY, down).payEstimate("strk", "usdg", "floating", "1000"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 504);
    return true;
  });
  const odd = fakeFetch(() => Response.json([1, 2, 3]));
  await assert.rejects(new OneClick(KEY, odd).payEstimate("strk", "usdg", "floating", "1000"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 502);
    return true;
  });
  const text = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
  await assert.rejects(new OneClick(KEY, text).payEstimate("strk", "usdg", "floating", "1000"), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 502);
    assert.equal(error.message, "<html>bad gateway</html>");
    return true;
  });
  // A refusal of a field comes as a list of lines, which the relay joins; JSON without a message gives a fixed text,
  // never the body (R-20).
  const list = fakeFetch(() =>
    Response.json({ message: ["amount must be a string", "recipient is not valid"], statusCode: 400 }, { status: 400 }),
  );
  await assert.rejects(new OneClick(KEY, list).payEstimate("strk", "usdg", "floating", "1000"), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.message, "amount must be a string; recipient is not valid");
    return true;
  });
  const bare = fakeFetch(() => Response.json({ correlationId: "x", path: "/v0/quote" }, { status: 400 }));
  await assert.rejects(new OneClick(KEY, bare).payEstimate("strk", "usdg", "floating", "1000"), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.doesNotMatch(error.message, /correlationId/);
    return true;
  });
});
