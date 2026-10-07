import assert from "node:assert/strict";
import { test } from "node:test";
import { ChangeNow, GatewayError, UpstreamError } from "../src/changenow.mts";
import { MIN_AMOUNT_CACHE_MS, UPSTREAM_CALLS_PER_SECOND } from "../src/config.mts";
import { CallLimiter } from "../src/limiter.mts";

const KEY = "test-key-of-the-relay";

interface Sent {
  url: string;
  init: RequestInit;
}

/** A fetch that answers every call with [answer] and keeps what the client sent. */
function fakeFetch(answer: () => Response): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return answer();
  }) as typeof fetch;
  return { fetchImpl, sent };
}

/** A clock that the test moves by hand. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1_000_000;
  return { now: () => time, advance: (ms) => (time += ms) };
}

const minimum = (): Response => Response.json({ minAmount: 0.0041 });

test("follows no redirect and sends the key in a header", async () => {
  const { fetchImpl, sent } = fakeFetch(minimum);
  await new ChangeNow(KEY, { fetchImpl }).minAmount("eth");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.redirect, "error");
  assert.equal((sent[0].init.headers as Record<string, string>)["x-changenow-api-key"], KEY);
});

test("keeps the minimum of each asset for a while, so that a burst of quotes asks ChangeNOW once", async () => {
  const time = clock();
  const { fetchImpl, sent } = fakeFetch(minimum);
  const changenow = new ChangeNow(KEY, { fetchImpl, now: time.now });
  assert.equal(await changenow.minAmount("eth"), 0.0041);
  assert.equal(await changenow.minAmount("eth"), 0.0041);
  assert.equal(sent.length, 1);
  await changenow.minAmount("usdg");
  assert.equal(sent.length, 2, "each asset has its own minimum");
  time.advance(MIN_AMOUNT_CACHE_MS);
  await changenow.minAmount("eth");
  assert.equal(sent.length, 3, "an old minimum is asked for again");
});

test("stops calling ChangeNOW above the budget of its key, and calls again once the budget refills", async () => {
  const time = clock();
  const { fetchImpl, sent } = fakeFetch(() => Response.json({ estimatedAmount: 0.02 }));
  const changenow = new ChangeNow(KEY, { fetchImpl, now: time.now });
  for (let call = 0; call < UPSTREAM_CALLS_PER_SECOND; call++) await changenow.estimate("eth", "0.01");
  await assert.rejects(changenow.estimate("eth", "0.01"), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(sent.length, UPSTREAM_CALLS_PER_SECOND, "the call over the budget never reaches ChangeNOW");
  time.advance(1000);
  await changenow.estimate("eth", "0.01");
  assert.equal(sent.length, UPSTREAM_CALLS_PER_SECOND + 1);
});

test("turns a missing or unreadable answer into an error of the relay", async () => {
  const silent = new ChangeNow(KEY, {
    fetchImpl: (async () => {
      throw new TypeError("redirect mode is set to error");
    }) as typeof fetch,
  });
  await assert.rejects(
    silent.minAmount("eth"),
    (error: unknown) => error instanceof GatewayError && error.status === 504,
  );
  const broken = new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new Error("the connection closed"));
      },
    }),
  );
  const unreadable = new ChangeNow(
    KEY,
    fakeFetch(() => broken),
  );
  await assert.rejects(
    unreadable.minAmount("eth"),
    (error: unknown) => error instanceof GatewayError && error.status === 502,
  );
  const notAnObject = new ChangeNow(
    KEY,
    fakeFetch(() => Response.json([1, 2])),
  );
  await assert.rejects(
    notAnObject.minAmount("eth"),
    (error: unknown) => error instanceof GatewayError && error.status === 502,
  );
});

test("keeps the status and the text of an error answer of ChangeNOW", async () => {
  const refusing = new ChangeNow(
    KEY,
    fakeFetch(() => Response.json({ message: "Amount is less than minimal" }, { status: 400 })),
  );
  await assert.rejects(refusing.minAmount("eth"), (error: unknown) => {
    assert.ok(error instanceof UpstreamError);
    assert.equal(error.status, 400);
    assert.equal(error.message, "Amount is less than minimal");
    return true;
  });
});

test("reads the coins, the networks, and the flow of a created exchange when ChangeNOW gives them", async () => {
  const answer = {
    id: "9f4e2c71b03ad1",
    fromAmount: 0.1,
    toAmount: 51.2,
    payinAddress: "48PFnHrr8bVGx463yo8SMXGZUp7PyYPgwZJR4MnpgjKCDXpw3XvK6UTbarKkpwaPbPSYSdJ4rozjZjGxr2t3qVP4B4DzzVs",
    payoutAddress: "0x7a3fc0e1b9d24a6c58e0f3b1d9a7c4e2f6b8d015",
    fromCurrency: "xmr",
    fromNetwork: "xmr",
    toCurrency: "usdg",
    toNetwork: "hood",
    flow: "fixed-rate",
  };
  const created = await new ChangeNow(
    KEY,
    fakeFetch(() => Response.json(answer)),
  ).createPay(
    "usdg",
    "fixed",
    "0.1",
    "0x7a3fC0e1b9D24A6c58E0f3B1d9a7C4e2F6b8D015",
    "883z7Wmbd5nhoH6xQxLzgniNhN6jqdvxFiza4rMdErWA1XW1TCL1tqrCwWFwhG1QkuL17RRHP45J33y6u4sH8Rfa7kryRza",
    "rate-id-of-the-test",
  );
  assert.equal(created.toCurrency, "usdg");
  assert.equal(created.flow, "fixed-rate");
  const withoutFlow: Record<string, unknown> = { ...answer };
  delete withoutFlow.flow;
  const sparse = await new ChangeNow(
    KEY,
    fakeFetch(() => Response.json(withoutFlow)),
  ).create(
    "eth",
    "0.01",
    "883z7Wmbd5nhoH6xQxLzgniNhN6jqdvxFiza4rMdErWA1XW1TCL1tqrCwWFwhG1QkuL17RRHP45J33y6u4sH8Rfa7kryRza",
    null,
  );
  assert.equal(sparse.flow, null);
});

test("the limiter refills at its rate and never holds more than one second of calls", () => {
  const time = clock();
  const limiter = new CallLimiter(2, time.now);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false);
  time.advance(500);
  assert.equal(limiter.take(), true, "half a second gives one call back");
  assert.equal(limiter.take(), false);
  time.advance(60_000);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), true);
  assert.equal(limiter.take(), false, "a long quiet time gives at most the calls of one second");
  assert.throws(() => new CallLimiter(0));
});
