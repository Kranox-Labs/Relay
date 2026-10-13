import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SIMPLESWAP_CALLS_PER_MINUTE,
  SIMPLESWAP_ESTIMATE_CACHE_MS,
  SIMPLESWAP_RANGE_CACHE_MS,
} from "../src/config.mts";
import { GatewayError, UpstreamError } from "../src/exchanger.mts";
import { SimpleSwap } from "../src/simpleswap.mts";

const KEY = "test-key-of-simpleswap";
const RECIPIENT = "0x7a3fC0e1b9D24A6c58E0f3B1d9a7C4e2F6b8D015";
const REFUND = "883z7Wmbd5nhoH6xQxLzgniNhN6jqdvxFiza4rMdErWA1XW1TCL1tqrCwWFwhG1QkuL17RRHP45J33y6u4sH8Rfa7kryRza";
const DEPOSIT = "48PFnHrr8bVGx463yo8SMXGZUp7PyYPgwZJR4MnpgjKCDXpw3XvK6UTbarKkpwaPbPSYSdJ4rozjZjGxr2t3qVP4B4DzzVs";

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

function clock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1_000_000;
  return { now: () => time, advance: (ms) => (time += ms) };
}

/** An answer of v3: the result in its envelope, as the API writes it. */
const result = (value: unknown): Response => Response.json({ traceId: "trace", result: value });

/** A refusal of v3, as the API writes it. */
const refusal = (status: number, message: string): Response =>
  Response.json({ code: status, error: "Unprocessable Entity", traceId: "trace", message }, { status });

test("sends the key in a header only, follows no redirect, and reads the result of the envelope", async () => {
  const { fetchImpl, sent } = fakeFetch(() => result({ min: "0.0246892632", max: "1.495230709567" }));
  const range = await new SimpleSwap(KEY, { fetchImpl }).payRange("xmr", "usdg", "fixed");
  assert.deepEqual(range, { minFrom: 0.0246892632, maxFrom: 1.495230709567 });
  assert.equal(sent.length, 1);
  const url = new URL(sent[0].url);
  assert.equal(url.pathname, "/v3/ranges");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    tickerFrom: "xmr",
    networkFrom: "xmr",
    tickerTo: "usdg",
    networkTo: "robinhood",
    fixed: "true",
  });
  assert.ok(!sent[0].url.includes(KEY), "the key stays out of the URL");
  assert.equal((sent[0].init.headers as Record<string, string>)["x-api-key"], KEY);
  assert.equal(sent[0].init.redirect, "error");
});

test("takes a floating range without a top, and keeps a range for a while", async () => {
  const time = clock();
  const { fetchImpl, sent } = fakeFetch(() => result({ min: "0.0143601108", max: null }));
  const simpleswap = new SimpleSwap(KEY, { fetchImpl, now: time.now });
  assert.deepEqual(await simpleswap.payRange("xmr", "eth", "floating"), { minFrom: 0.0143601108, maxFrom: null });
  await simpleswap.payRange("xmr", "eth", "floating");
  assert.equal(sent.length, 1, "the second range of the same pair comes from memory");
  await simpleswap.payRange("xmr", "usdg", "floating");
  assert.equal(sent.length, 2, "each pair has its own range");
  time.advance(SIMPLESWAP_RANGE_CACHE_MS);
  await simpleswap.payRange("xmr", "eth", "floating");
  assert.equal(sent.length, 3, "an old range is asked for again");
});

test("estimates at a fixed rate with its id and its time, and at a floating rate without them", async () => {
  const { fetchImpl, sent } = fakeFetch((call) =>
    call.url.includes("fixed=true")
      ? result({
          estimatedAmount: "47.953709",
          rateId: "xmp4w9f3x2cy0tug8ju_rs97tvfcp15d",
          validUntil: "2026-10-12T11:51:43.473Z",
        })
      : result({ estimatedAmount: "48.159582", rateId: null, validUntil: null }),
  );
  const simpleswap = new SimpleSwap(KEY, { fetchImpl });
  assert.deepEqual(await simpleswap.payEstimate("xmr", "usdg", "fixed", "0.1"), {
    amount: 47.953709,
    rateId: "xmp4w9f3x2cy0tug8ju_rs97tvfcp15d",
    validUntil: "2026-10-12T11:51:43.473Z",
    warning: null,
    depositFee: null,
    withdrawalFee: null,
    speedMinutes: null,
  });
  const floating = await simpleswap.payEstimate("xmr", "usdg", "floating", "0.1");
  assert.ok(!("limit" in floating));
  assert.equal(floating.amount, 48.159582);
  assert.equal(floating.rateId, null);
  const url = new URL(sent[0].url);
  assert.equal(url.pathname, "/v3/estimates");
  assert.equal(url.searchParams.get("amount"), "0.1");
});

test("turns a refusal of an amount into the range of the rate, on the side the amount fell", async () => {
  const { fetchImpl } = fakeFetch(() =>
    refusal(422, "Amount does not fall within the range. Min: 0.0246948222, max: 1.495551411224"),
  );
  const simpleswap = new SimpleSwap(KEY, { fetchImpl });
  assert.deepEqual(await simpleswap.payEstimate("xmr", "usdg", "fixed", "0.001"), {
    limit: "below",
    minFrom: 0.0246948222,
    maxFrom: 1.495551411224,
  });
  assert.deepEqual(await simpleswap.payEstimate("xmr", "usdg", "fixed", "50"), {
    limit: "above",
    minFrom: 0.0246948222,
    maxFrom: 1.495551411224,
  });
  const floating = fakeFetch(() => refusal(422, "Amount does not fall within the range. Min: 0.0143601108, max: null"));
  assert.deepEqual(await new SimpleSwap(KEY, floating).payEstimate("xmr", "usdg", "floating", "0.001"), {
    limit: "below",
    minFrom: 0.0143601108,
    maxFrom: null,
  });
  // A refusal without a range stays a refusal, with its text.
  const other = fakeFetch(() => refusal(422, "Pair is not available"));
  await assert.rejects(new SimpleSwap(KEY, other).payEstimate("xmr", "usdg", "fixed", "0.1"), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 422);
    assert.equal(error.service, "SimpleSwap");
    assert.equal(error.message, "Pair is not available");
    return true;
  });
});

test("creates an exchange with the names of v3 and reads back what the relay checks", async () => {
  const { fetchImpl, sent } = fakeFetch(() =>
    result({
      id: "pch7l7kd1v2mzh1",
      type: "fixed",
      tickerFrom: "xmr",
      networkFrom: "xmr",
      tickerTo: "usdg",
      networkTo: "robinhood",
      amountFrom: "0.1",
      expectedAmount: "0.1",
      amountTo: "47.953709",
      addressFrom: DEPOSIT,
      addressTo: RECIPIENT,
      userRefundAddress: REFUND,
      status: "waiting",
    }),
  );
  const simpleswap = new SimpleSwap(KEY, { fetchImpl });
  const created = await simpleswap.createPay("xmr", "usdg", "fixed", "0.1", RECIPIENT, REFUND, "rate-id-1");
  assert.deepEqual(created, {
    id: "pch7l7kd1v2mzh1",
    fromAmount: 0.1,
    toAmount: 47.953709,
    payinAddress: DEPOSIT,
    payoutAddress: RECIPIENT,
    refundAddress: REFUND,
    fromCurrency: "xmr",
    fromNetwork: "xmr",
    toCurrency: "usdg",
    toNetwork: "robinhood",
    flow: "fixed",
    validUntil: null,
  });
  assert.equal(sent[0].init.method, "POST");
  assert.equal(new URL(sent[0].url).pathname, "/v3/exchanges");
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), {
    tickerFrom: "xmr",
    networkFrom: "xmr",
    tickerTo: "usdg",
    networkTo: "robinhood",
    amount: "0.1",
    addressTo: RECIPIENT,
    fixed: true,
    userRefundAddress: REFUND,
    rateId: "rate-id-1",
  });
  assert.deepEqual(simpleswap.payNames("xmr", "usdg", "fixed"), {
    from: { currency: "xmr", network: "xmr" },
    to: { currency: "usdg", network: "robinhood" },
    flow: "fixed",
  });
  const floating = fakeFetch(() =>
    result({
      id: "x",
      amountFrom: "1",
      amountTo: "2",
      addressFrom: DEPOSIT,
      addressTo: RECIPIENT,
      tickerFrom: "xmr",
      networkFrom: "xmr",
      tickerTo: "eth",
      networkTo: "robinhood",
      type: "floating",
    }),
  );
  const made = await new SimpleSwap(KEY, floating).createPay("xmr", "eth", "floating", "1", RECIPIENT, REFUND, null);
  assert.equal(made.toAmount, 2, "the coin that arrives is amountTo");
  const withoutAmountTo = fakeFetch(() =>
    result({
      id: "x",
      amountFrom: "1",
      expectedAmount: "1",
      amountTo: null,
      addressFrom: DEPOSIT,
      addressTo: RECIPIENT,
      tickerFrom: "xmr",
      networkFrom: "xmr",
      tickerTo: "eth",
      networkTo: "robinhood",
      type: "floating",
    }),
  );
  await assert.rejects(
    new SimpleSwap(KEY, withoutAmountTo).createPay("xmr", "eth", "floating", "1", RECIPIENT, REFUND, null),
    /without the amount that arrives/,
    "expectedAmount is the deposit, never the coin that arrives (R-38)",
  );
  assert.equal("rateId" in JSON.parse(String(floating.sent[0].init.body)), false, "a floating rate sends no rate id");
});

test("reads the state of an exchange in the words of the app, and refuses a state it does not know", async () => {
  const { fetchImpl, sent } = fakeFetch((call) =>
    call.url.endsWith("/odd")
      ? result({ id: "odd", status: "something-new" })
      : result({
          id: "pch7l7kd1v2mzh1",
          status: "exchanging",
          amountTo: "47.953709",
          expectedAmount: "0.1",
          txFrom: "deposit-hash",
          txTo: null,
          userRefundAddress: REFUND,
          updatedAt: "2026-10-12T11:55:00.000Z",
          validUntil: "2026-10-12T12:20:00.000Z",
        }),
  );
  const simpleswap = new SimpleSwap(KEY, { fetchImpl });
  assert.deepEqual(await simpleswap.status("pch7l7kd1v2mzh1"), {
    status: "exchanging",
    amountTo: null,
    expectedAmountTo: 47.953709,
    payinHash: "deposit-hash",
    payoutHash: null,
    refundAddress: REFUND,
    refundHash: null,
    refundAmount: null,
    updatedAt: "2026-10-12T11:55:00.000Z",
    validUntil: "2026-10-12T12:20:00.000Z",
  });
  assert.equal(new URL(sent[0].url).pathname, "/v3/exchanges/pch7l7kd1v2mzh1");
  await assert.rejects(simpleswap.status("odd"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 502);
    assert.match(error.message, /unknown state/);
    return true;
  });
});

test("stops calling SimpleSwap above the budget of its key in a minute, and calls again as it refills", async () => {
  const time = clock();
  const { fetchImpl, sent } = fakeFetch(() => result({ estimatedAmount: "1", rateId: null, validUntil: null }));
  const simpleswap = new SimpleSwap(KEY, { fetchImpl, now: time.now });
  // Each call asks another amount, so that none comes from the cache of quotes.
  for (let call = 0; call < SIMPLESWAP_CALLS_PER_MINUTE; call++) {
    await simpleswap.payEstimate("xmr", "eth", "floating", String(call + 1));
  }
  await assert.rejects(simpleswap.payEstimate("xmr", "eth", "floating", "0.5"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(sent.length, SIMPLESWAP_CALLS_PER_MINUTE, "the call over the budget never reaches SimpleSwap");
  time.advance(60_000 / SIMPLESWAP_CALLS_PER_MINUTE);
  await simpleswap.payEstimate("xmr", "eth", "floating", "0.5");
  assert.equal(sent.length, SIMPLESWAP_CALLS_PER_MINUTE + 1);
});

test("answers a refused key and a failure of SimpleSwap with the status of the answer and its service", async () => {
  const { fetchImpl } = fakeFetch(() =>
    Response.json({ code: 401, error: "Unauthorized", message: "Wrong api key" }, { status: 401 }),
  );
  await assert.rejects(new SimpleSwap(KEY, { fetchImpl }).payRange("xmr", "eth", "fixed"), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 401);
    assert.equal(error.service, "SimpleSwap");
    return true;
  });
  const down = fakeFetch(() => {
    throw new Error("connection refused");
  });
  await assert.rejects(new SimpleSwap(KEY, down).payRange("xmr", "eth", "fixed"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 504);
    return true;
  });
  const odd = fakeFetch(() => Response.json({ traceId: "trace" }));
  await assert.rejects(new SimpleSwap(KEY, odd).payRange("xmr", "eth", "fixed"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 502);
    return true;
  });
});

test("refuses a created exchange without the names of its pair, so that the check of the pair never passes empty (R-05)", async () => {
  const { fetchImpl } = fakeFetch(() =>
    result({
      id: "x",
      amountFrom: "1",
      amountTo: "2",
      addressFrom: DEPOSIT,
      addressTo: RECIPIENT,
      type: "fixed",
    }),
  );
  await assert.rejects(
    new SimpleSwap(KEY, { fetchImpl }).createPay("xmr", "eth", "fixed", "1", RECIPIENT, REFUND, "r"),
    (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.status, 502);
      assert.match(error.message, /tickerFrom/);
      return true;
    },
  );
});

test("keeps a refusal whose range holds the amount as a refusal, with its text (R-07)", async () => {
  const { fetchImpl } = fakeFetch(() =>
    refusal(422, "Amount does not fall within the range. Min: 0.0246948222, max: 1.495551411224"),
  );
  await assert.rejects(
    new SimpleSwap(KEY, { fetchImpl }).payEstimate("xmr", "usdg", "fixed", "0.5"),
    (error: unknown) => {
      assert.ok(error instanceof UpstreamError);
      assert.equal(error.status, 422);
      return true;
    },
  );
  const noTop = fakeFetch(() => refusal(422, "Amount does not fall within the range. Min: 0.0143601108, max: null"));
  await assert.rejects(new SimpleSwap(KEY, noTop).payEstimate("xmr", "usdg", "floating", "5"), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    return true;
  });
});

test("keeps a quote for a few seconds, so that the pages of the app spend one call on it (R-01)", async () => {
  const time = clock();
  const { fetchImpl, sent } = fakeFetch(() => result({ estimatedAmount: "48.1", rateId: null, validUntil: null }));
  const simpleswap = new SimpleSwap(KEY, { fetchImpl, now: time.now });
  await simpleswap.payEstimate("xmr", "usdg", "floating", "0.1");
  await simpleswap.payEstimate("xmr", "usdg", "floating", "0.1");
  assert.equal(sent.length, 1, "the same quote again comes from memory");
  await simpleswap.payEstimate("xmr", "usdg", "floating", "0.2");
  assert.equal(sent.length, 2, "another amount is its own quote");
  time.advance(SIMPLESWAP_ESTIMATE_CACHE_MS);
  await simpleswap.payEstimate("xmr", "usdg", "floating", "0.1");
  assert.equal(sent.length, 3, "an old quote is asked for again");
});

test("takes XMR and ZEC, and says so for another coin before any call", async () => {
  const { fetchImpl, sent } = fakeFetch(() => result({ min: "0.02383414", max: null }));
  const simpleswap = new SimpleSwap(KEY, { fetchImpl });
  assert.deepEqual(simpleswap.origins, ["xmr", "zec"]);
  assert.deepEqual(await simpleswap.payRange("zec", "usdg", "floating"), { minFrom: 0.02383414, maxFrom: null });
  assert.equal(new URL(sent[0].url).searchParams.get("tickerFrom"), "zec");
  assert.equal(new URL(sent[0].url).searchParams.get("networkFrom"), "zec");
  sent.length = 0;
  await assert.rejects(simpleswap.payRange("strk", "usdg", "floating"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.match(error.message, /does not take STRK/);
    return true;
  });
  assert.equal(sent.length, 0);
});

test("serves the way out from the network robinhood at the floating rate, with the refund to Robinhood Chain", async () => {
  const time = clock();
  const ZEC_ADDRESS = "t1URu8q83ibd8sgDoW3VnJoPjUusRz97h8J";
  const { fetchImpl, sent } = fakeFetch((call) => {
    const path = new URL(call.url).pathname;
    if (path === "/v3/ranges") return result({ min: "12.5201022", max: null });
    if (path === "/v3/estimates") {
      return new URL(call.url).searchParams.get("amount") === "20"
        ? refusal(422, "Amount does not fall within the range. Min: 28.66650126, max: null")
        : result({ estimatedAmount: "0.0249" });
    }
    return result({
      id: "o7k2m9x1qzr4w5t",
      type: "floating",
      tickerFrom: "eth",
      networkFrom: "robinhood",
      tickerTo: "zec",
      networkTo: "zec",
      amountFrom: "0.02",
      expectedAmount: "0.02",
      amountTo: "0.0409",
      addressFrom: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
      addressTo: ZEC_ADDRESS,
      userRefundAddress: RECIPIENT,
      status: "waiting",
      validUntil: null,
    });
  });
  const simpleswap = new SimpleSwap(KEY, { fetchImpl, now: time.now });
  assert.deepEqual(simpleswap.destinations, ["xmr", "zec"]);
  assert.deepEqual(await simpleswap.outRange("usdg", "xmr"), { minFrom: 12.5201022, maxFrom: null });
  assert.deepEqual(Object.fromEntries(new URL(sent[0].url).searchParams), {
    tickerFrom: "usdg",
    networkFrom: "robinhood",
    tickerTo: "xmr",
    networkTo: "xmr",
    fixed: "false",
  });
  await simpleswap.outRange("usdg", "xmr");
  await simpleswap.payRange("xmr", "usdg", "floating");
  assert.equal(sent.length, 2, "the range out and the range in of the same coins are two ranges, each kept a while");
  assert.deepEqual(await simpleswap.outEstimate("usdg", "zec", "30"), {
    amount: 0.0249,
    rateId: null,
    validUntil: null,
    warning: null,
    depositFee: null,
    withdrawalFee: null,
    speedMinutes: null,
  });
  assert.equal(new URL(sent[2].url).searchParams.get("amount"), "30");
  assert.equal(new URL(sent[2].url).searchParams.get("tickerTo"), "zec");
  assert.deepEqual(await simpleswap.outEstimate("usdg", "zec", "20"), {
    limit: "below",
    minFrom: 28.66650126,
    maxFrom: null,
  });
  const created = await simpleswap.createOut("eth", "zec", "0.02", ZEC_ADDRESS, RECIPIENT);
  assert.deepEqual(JSON.parse(String(sent[4].init.body)), {
    tickerFrom: "eth",
    networkFrom: "robinhood",
    tickerTo: "zec",
    networkTo: "zec",
    amount: "0.02",
    addressTo: ZEC_ADDRESS,
    fixed: false,
    userRefundAddress: RECIPIENT,
  });
  assert.deepEqual(created, {
    id: "o7k2m9x1qzr4w5t",
    fromAmount: 0.02,
    toAmount: 0.0409,
    payinAddress: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
    payoutAddress: ZEC_ADDRESS,
    refundAddress: RECIPIENT,
    fromCurrency: "eth",
    fromNetwork: "robinhood",
    toCurrency: "zec",
    toNetwork: "zec",
    flow: "floating",
    validUntil: null,
  });
  assert.deepEqual(simpleswap.outNames("eth", "zec"), {
    from: { currency: "eth", network: "robinhood" },
    to: { currency: "zec", network: "zec" },
    flow: "floating",
  });
  await assert.rejects(simpleswap.outRange("usdg", "strk"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.match(error.message, /does not take STRK/);
    return true;
  });
  assert.equal(sent.length, 5);
});
