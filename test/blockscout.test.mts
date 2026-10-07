import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Blockscout } from "../src/blockscout.mts";
import { GatewayError, type Exchanger } from "../src/changenow.mts";
import { BLOCKSCOUT_CALLS_PER_SECOND, SCAN_CACHE_MS } from "../src/config.mts";
import type { ChainScan, ChainScanner } from "../src/scan.mts";
import { createRelay } from "../src/server.mts";

const KEY = "proapi_test_key_of_the_relay";

// An address on Robinhood Chain from the examples of EIP-55, and two others that it deals with.
const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const FUNDER = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const SHOP = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
const USDG = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";

function party(hash: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { hash, name: null, ens_domain_name: null, public_tags: [], is_contract: false, ...extra };
}

/** The answers of the explorer for [ADDRESS], keyed by the start of the path. */
const ANSWERS: [string, unknown][] = [
  [
    `/4663/api/v2/addresses/${ADDRESS}/counters`,
    { transactions_count: "12", token_transfers_count: "30", gas_usage_count: "1", validations_count: "0" },
  ],
  [
    `/4663/api/v2/addresses/${ADDRESS}/transactions`,
    {
      items: [
        {
          hash: "0xtx2",
          from: party(ADDRESS),
          to: party(SHOP, { name: "Coffee Shop", is_contract: true }),
          value: "1000",
          timestamp: "2026-10-06T10:00:00.000000Z",
        },
        {
          hash: "0xtx1",
          from: party(FUNDER, { public_tags: [{ display_name: "Big Exchange 1" }] }),
          to: party(ADDRESS),
          value: "5000000000000000",
          timestamp: "2026-10-01T08:00:00.000000Z",
        },
        { hash: "0xcreation", from: party(ADDRESS), to: null, value: "0", timestamp: "2026-10-05T08:00:00.000000Z" },
        { hash: "0xbroken" },
      ],
      next_page_params: { block_number: 1 },
    },
  ],
  [
    `/4663/api/v2/addresses/${ADDRESS}/token-transfers`,
    {
      items: [
        {
          transaction_hash: "0xtoken1",
          from: party(ADDRESS),
          to: party(SHOP),
          token: { symbol: "USDG", address_hash: USDG, decimals: "6", type: "ERC-20" },
          total: { decimals: "6", value: "25000000" },
          timestamp: "2026-10-06T11:00:00.000000Z",
        },
      ],
      next_page_params: null,
    },
  ],
  [
    `/4663/api/v2/addresses/${ADDRESS}/tokens`,
    { items: [{ token: { symbol: "USDG", address_hash: USDG, decimals: "6" }, value: "75000000" }] },
  ],
  [
    `/4663/api/v2/addresses/${ADDRESS}`,
    { hash: ADDRESS, is_contract: false, coin_balance: "4000000000000000", public_tags: [] },
  ],
  [
    "/v2/api?chain_id=4663&module=account&action=txlist",
    {
      status: "1",
      result: [
        {
          hash: "0xtx1",
          from: FUNDER.toLowerCase(),
          to: ADDRESS.toLowerCase(),
          value: "5000000000000000",
          timeStamp: "1790841600",
        },
      ],
    },
  ],
  [
    "/v2/api?chain_id=4663&module=account&action=tokentx",
    {
      status: "1",
      result: [
        {
          hash: "0xtoken0",
          from: SHOP.toLowerCase(),
          to: ADDRESS.toLowerCase(),
          value: "100000000",
          timeStamp: "1790928000",
          tokenSymbol: "USDG",
          tokenDecimal: "6",
          contractAddress: USDG.toLowerCase(),
        },
      ],
    },
  ],
];

interface Sent {
  url: string;
  init: RequestInit;
}

/** A fetch that answers as the explorer, or with [status] for every call when the test gives one. */
function explorer(status?: number): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url);
    sent.push({ url: text, init: init ?? {} });
    if (status !== undefined) return new Response("{}", { status });
    const path = text.replace("https://api.blockscout.com", "");
    const answer = ANSWERS.find(([start]) => path.startsWith(start));
    return answer === undefined ? new Response("{}", { status: 500 }) : Response.json(answer[1]);
  }) as typeof fetch;
  return { fetchImpl, sent };
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

test("reads the public history of an address, with the key in a header and never in a URL", async () => {
  const { fetchImpl, sent } = explorer();
  const time = clock();
  const scan = await new Blockscout(KEY, { fetchImpl, now: time.now, sleep: time.sleep }).scan(ADDRESS);
  assert.equal(sent.length, 7);
  for (const call of sent) {
    assert.equal(call.init.redirect, "error");
    assert.equal((call.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
    assert.ok(!call.url.includes(KEY), "the key stays out of every URL");
  }
  assert.equal(scan.address, ADDRESS);
  assert.equal(scan.balanceWei, "4000000000000000");
  assert.equal(scan.transactionCount, 12);
  assert.equal(scan.tokenTransferCount, 30);
  assert.deepEqual(
    scan.transactions.map((item) => item.hash),
    ["0xtx2", "0xtx1", "0xcreation"],
    "an item without its fields drops out",
  );
  assert.equal(scan.transactions[2].to, null, "a contract creation has no recipient");
  assert.deepEqual(scan.transactions[0].to, { address: SHOP, label: "Coffee Shop", isContract: true });
  assert.deepEqual(scan.tokenTransfers[0].token, { symbol: "USDG", address: USDG, decimals: 6 });
  assert.equal(scan.tokenTransfers[0].value, "25000000");
  assert.deepEqual(scan.holdings, [{ token: { symbol: "USDG", address: USDG, decimals: 6 }, value: "75000000" }]);
  // The oldest transaction comes without names, and takes the name that the newer list knows.
  assert.equal(scan.firstTransaction?.hash, "0xtx1");
  assert.equal(scan.firstTransaction?.from.label, "Big Exchange 1");
  assert.equal(scan.firstTransaction?.time, "2026-10-01T08:00:00.000Z");
  assert.equal(scan.firstTokenTransfer?.token?.symbol, "USDG");
  assert.equal(scan.firstTokenTransfer?.from.label, "Coffee Shop");
});

test("an address that the explorer never saw is an empty scan after one call", async () => {
  const { fetchImpl, sent } = explorer(404);
  const scan = await new Blockscout(KEY, { fetchImpl }).scan(ADDRESS);
  assert.equal(sent.length, 1);
  assert.equal(scan.transactionCount, 0);
  assert.deepEqual(scan.transactions, []);
  assert.equal(scan.firstTransaction, null);
});

test("a refused key or a spent budget reaches the app with a fixed text", async () => {
  for (const [status, expected] of [
    [401, 502],
    [402, 502],
    [403, 502],
    [429, 503],
    [500, 502],
  ] as const) {
    const { fetchImpl } = explorer(status);
    await assert.rejects(new Blockscout(KEY, { fetchImpl }).scan(ADDRESS), (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.status, expected, String(status));
      assert.ok(!error.message.includes(KEY));
      return true;
    });
  }
});

test("keeps a scan for a while, so that a second look spends no call", async () => {
  const { fetchImpl, sent } = explorer();
  const time = clock();
  const blockscout = new Blockscout(KEY, { fetchImpl, now: time.now, sleep: time.sleep });
  await blockscout.scan(ADDRESS);
  await blockscout.scan(ADDRESS.toLowerCase());
  assert.equal(sent.length, 7);
  time.advance(SCAN_CACHE_MS);
  await blockscout.scan(ADDRESS);
  assert.equal(sent.length, 14);
});

test("waits for its budget of calls instead of passing it", async () => {
  const { fetchImpl } = explorer();
  const time = clock();
  const start = time.now();
  await new Blockscout(KEY, { fetchImpl, now: time.now, sleep: time.sleep }).scan(ADDRESS);
  // Seven calls at four a second: the burst takes four, and the other three wait for the budget.
  assert.ok(time.now() - start >= ((7 - BLOCKSCOUT_CALLS_PER_SECOND) * 1000) / BLOCKSCOUT_CALLS_PER_SECOND - 1);
});

/** The relay with a scanner that answers from a list, and nothing behind its routes of the bridge. */
async function relayWith(scanner: ChainScanner | null): Promise<{ base: string; close: () => void }> {
  const relay = createRelay({} as Exchanger, scanner);
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(relay.address() as AddressInfo).port}`, close: () => relay.close() };
}

test("the scan route checks the address and answers with the scan", async () => {
  const scanned: string[] = [];
  const scan = { address: ADDRESS, transactionCount: 3 } as ChainScan;
  const { base, close } = await relayWith({
    async scan(address) {
      scanned.push(address);
      return scan;
    },
  });
  try {
    const good = await fetch(`${base}/v1/scan/robinhood?address=${ADDRESS}`);
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), scan);
    for (const address of ["", "0x123", `${ADDRESS}00`, "5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"]) {
      const bad = await fetch(`${base}/v1/scan/robinhood?address=${address}`);
      assert.equal(bad.status, 400, address);
    }
    const browser = await fetch(`${base}/v1/scan/robinhood?address=${ADDRESS}`, {
      headers: { origin: "https://example.com" },
    });
    assert.equal(browser.status, 403);
    assert.deepEqual(scanned, [ADDRESS]);
  } finally {
    close();
  }
});

test("without a key of Blockscout, the scan route says that the relay cannot scan yet", async () => {
  const { base, close } = await relayWith(null);
  try {
    const response = await fetch(`${base}/v1/scan/robinhood?address=${ADDRESS}`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "The relay cannot scan addresses yet.", exchangeId: null });
  } finally {
    close();
  }
});
