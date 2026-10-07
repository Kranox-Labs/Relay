import assert from "node:assert/strict";
import { test } from "node:test";
import { Alchemy } from "../src/alchemy.mts";
import { GatewayError } from "../src/changenow.mts";
import { ALCHEMY_URL, METADATA_URL, SCAN_CACHE_MS } from "../src/config.mts";

const KEY = "alchemy_test_key_of_the_relay";

// The scanned address, from the examples of EIP-55, and the addresses around it.
const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const EXCHANGE = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";
const SHOP = "0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const OTHER_TOKEN = "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984";

function eth(hash: string, from: string, to: string, value: string, time: string): Record<string, unknown> {
  return {
    hash,
    from,
    to,
    category: "external",
    asset: "ETH",
    value: 0.001,
    rawContract: { value, address: null, decimal: "0x12" },
    metadata: { blockTimestamp: time },
  };
}

function usdg(hash: string, from: string, to: string, value: string, time: string): Record<string, unknown> {
  return {
    hash,
    from,
    to,
    category: "erc20",
    asset: "USDG",
    value: 25,
    rawContract: { value, address: USDG, decimal: "0x6" },
    metadata: { blockTimestamp: time },
  };
}

interface Asked {
  url: string;
  init: RequestInit;
  method: string | null;
  params: Record<string, unknown> | null;
}

/** The answers of Alchemy and of the metadata service, or [status] for every call to Alchemy when the test gives one. */
function sources(options: { status?: number; rpcError?: boolean; metadataStatus?: number } = {}): {
  fetchImpl: typeof fetch;
  asked: Asked[];
} {
  const asked: Asked[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    const params = Array.isArray(body?.params) ? body.params : [];
    const first = typeof params[0] === "object" && params[0] !== null ? (params[0] as Record<string, unknown>) : null;
    asked.push({ url: text, init: init ?? {}, method: (body?.method as string) ?? null, params: first });
    if (text.startsWith(METADATA_URL)) {
      if (options.metadataStatus !== undefined) return new Response("{}", { status: options.metadataStatus });
      return Response.json({
        addresses: {
          [EXCHANGE]: {
            tags: [
              { name: "EXCHANGE", tagType: "generic" },
              { name: "Big Exchange", tagType: "name" },
            ],
          },
        },
      });
    }
    if (options.status !== undefined) return new Response("{}", { status: options.status });
    if (options.rpcError) return Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no" } });
    const result = (() => {
      switch (body?.method) {
        case "eth_getBalance":
          return "0x2386f26fc10000";
        case "eth_getCode":
          return "0x";
        case "eth_getTransactionCount":
          return "0x7";
        case "alchemy_getTokenBalances":
          return {
            address: ADDRESS,
            tokenBalances: [
              { contractAddress: USDG, tokenBalance: "0x4c4b40" },
              { contractAddress: OTHER_TOKEN, tokenBalance: "0x10" },
              { contractAddress: USDG.replace("5fc5", "0000"), tokenBalance: "0x0" },
            ],
          };
        case "alchemy_getAssetTransfers": {
          const category = first?.category as string[];
          const ascending = first?.order === "asc";
          if (ascending && category.join() === "external") {
            return {
              transfers: [
                eth("0xfund", EXCHANGE, ADDRESS.toLowerCase(), "0x2386f26fc10000", "2026-10-01T08:00:00.000Z"),
              ],
            };
          }
          if (ascending && category.join() === "erc20") {
            return {
              transfers: [usdg("0xfirsttoken", SHOP, ADDRESS.toLowerCase(), "0x989680", "2026-10-02T08:00:00.000Z")],
            };
          }
          if (first?.fromAddress !== undefined) {
            return {
              transfers: [
                eth("0xpaid", ADDRESS.toLowerCase(), SHOP, "0x1", "2026-10-05T08:00:00.000Z"),
                usdg("0xspent", ADDRESS.toLowerCase(), SHOP, "0x17d7840", "2026-10-06T08:00:00.000Z"),
                { hash: "0xbroken", category: "erc20" },
              ],
            };
          }
          return {
            transfers: [
              eth("0xfund", EXCHANGE, ADDRESS.toLowerCase(), "0x2386f26fc10000", "2026-10-01T08:00:00.000Z"),
              usdg("0xfirsttoken", SHOP, ADDRESS.toLowerCase(), "0x989680", "2026-10-02T08:00:00.000Z"),
            ],
          };
        }
        default:
          return null;
      }
    })();
    return Response.json({ jsonrpc: "2.0", id: 1, result });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

/** A clock that the test moves by hand, and a sleep that moves it. */
function clock(): { now: () => number; advance: (ms: number) => void; sleep: (ms: number) => Promise<void> } {
  let time = 1_000_000;
  return {
    now: () => time,
    advance: (ms) => (time += ms),
    sleep: async (ms) => {
      time += ms;
    },
  };
}

test("scans an address through Alchemy, with the key in a header and never in a URL or a body", async () => {
  const { fetchImpl, asked } = sources();
  const time = clock();
  const scan = await new Alchemy(KEY, { fetchImpl, now: time.now, sleep: time.sleep }).scan(ADDRESS);
  const rpc = asked.filter((call) => call.url === ALCHEMY_URL);
  assert.equal(rpc.length, 8);
  for (const call of asked) {
    assert.equal(call.init.redirect, "error");
    assert.ok(!call.url.includes(KEY));
    assert.ok(!String(call.init.body ?? "").includes(KEY));
  }
  for (const call of rpc) {
    assert.equal((call.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
  }
  assert.equal(scan.address, ADDRESS);
  assert.equal(scan.isContract, false);
  assert.equal(scan.balanceWei, "10000000000000000");
  assert.equal(scan.transactionCount, 7, "the transactions that the address sent");
  assert.deepEqual(
    scan.transactions.map((transfer) => transfer.hash),
    ["0xpaid", "0xfund"],
    "the ETH transfers, the newest first",
  );
  assert.deepEqual(
    scan.tokenTransfers.map((transfer) => transfer.hash),
    ["0xspent", "0xfirsttoken"],
    "the token transfers, the newest first, without the broken one",
  );
  assert.equal(scan.tokenTransferCount, 2);
  assert.deepEqual(scan.tokenTransfers[0].token, { symbol: "USDG", address: USDG, decimals: 6 });
  assert.equal(scan.tokenTransfers[0].value, "25000000");
  assert.equal(scan.firstTransaction?.hash, "0xfund");
  assert.equal(scan.firstTokenTransfer?.hash, "0xfirsttoken");
  // A holding needs the symbol of a transfer of its token; a token without one, or without a balance, stays out.
  assert.deepEqual(scan.holdings, [{ token: { symbol: "USDG", address: USDG, decimals: 6 }, value: "5000000" }]);
});

test("names the addresses around a scan from the metadata service, and goes on without names when it fails", async () => {
  const named = await new Alchemy(KEY, { fetchImpl: sources().fetchImpl }).scan(ADDRESS);
  assert.equal(named.firstTransaction?.from.label, "Big Exchange", "the tag of type name, not the generic one");
  assert.equal(named.transactions[0].to?.label, null);
  const metadata = sources({ metadataStatus: 500 });
  const plain = await new Alchemy(KEY, { fetchImpl: metadata.fetchImpl }).scan(ADDRESS);
  assert.equal(plain.firstTransaction?.from.label, null);
  assert.equal(plain.transactions.length, 2);
  const lookup = metadata.asked.find((call) => call.url.startsWith(METADATA_URL));
  assert.ok(lookup?.url.includes("chainId=4663"));
  assert.ok(!lookup?.url.toLowerCase().includes(ADDRESS.toLowerCase()), "the scanned address itself is not asked");
});

test("a refused key, a spent budget, or an error of Alchemy reaches the app with a fixed text", async () => {
  for (const [options, expected] of [
    [{ status: 401 }, 502],
    [{ status: 403 }, 502],
    [{ status: 429 }, 503],
    [{ status: 500 }, 502],
    [{ rpcError: true }, 502],
  ] as const) {
    await assert.rejects(
      new Alchemy(KEY, { fetchImpl: sources(options).fetchImpl }).scan(ADDRESS),
      (error: unknown) => {
        assert.ok(error instanceof GatewayError);
        assert.equal(error.status, expected, JSON.stringify(options));
        assert.ok(!error.message.includes(KEY));
        return true;
      },
    );
  }
});

test("keeps a scan for a while, so that a second look spends no call", async () => {
  const { fetchImpl, asked } = sources();
  const time = clock();
  const alchemy = new Alchemy(KEY, { fetchImpl, now: time.now, sleep: time.sleep });
  await alchemy.scan(ADDRESS);
  const calls = asked.length;
  await alchemy.scan(ADDRESS.toLowerCase());
  assert.equal(asked.length, calls);
  time.advance(SCAN_CACHE_MS);
  await alchemy.scan(ADDRESS);
  assert.equal(asked.length, calls * 2);
});
