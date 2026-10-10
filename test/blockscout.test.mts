import { generateKeyPairSync } from "node:crypto";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Blockscout } from "../src/blockscout.mts";
import { GatewayError, type Exchanger } from "../src/changenow.mts";
import { BLOCKSCOUT_CALLS_PER_SECOND, METADATA_URL, SCAN_CACHE_MS } from "../src/config.mts";
import type { ChainScan, ChainScanner } from "../src/scan.mts";
import { createRelay } from "../src/server.mts";
import { CreationKeys } from "../src/creations.mts";
import { AnswerSigner } from "../src/signing.mts";
import { SwapTokens } from "../src/tokens.mts";

const KEY = "proapi_test_key_of_the_relay";

// An address on Robinhood Chain from the examples of EIP-55, and two others that it deals with.
const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const FUNDER = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const SHOP = "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB";
const USDG = "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984";
// A contract that sends ETH to many addresses at once, which funded [ADDRESS] first through an internal transfer.
const DISPERSE = "0x52908400098527886E0F7030069857D2E4169EE7";

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
  [`/4663/api/v2/addresses/${SHOP}`, party(SHOP, { name: "Coffee Shop", is_contract: true })],
  [
    `/4663/api/v2/addresses/${DISPERSE}`,
    { hash: DISPERSE, name: "Disperse", is_contract: true, public_tags: [], ens_domain_name: null },
  ],
  // The internal transfers before txlist, whose path starts the same way. The explorer of Robinhood Chain answers
  // every range with the status 2 for its internal transfers that it has not yet processed.
  [
    "/v2/api?chain_id=4663&module=account&action=txlistinternal",
    {
      status: "2",
      message: "Some internal transactions within this block range have not yet been processed",
      result: [
        {
          transactionHash: "0xfailed",
          from: SHOP.toLowerCase(),
          to: ADDRESS.toLowerCase(),
          value: "9000",
          timeStamp: "1790668800",
          isError: "1",
        },
        {
          transactionHash: "0xempty",
          from: SHOP.toLowerCase(),
          to: ADDRESS.toLowerCase(),
          value: "0",
          timeStamp: "1790700000",
          isError: "0",
        },
        {
          transactionHash: "0xinternal",
          from: DISPERSE.toLowerCase(),
          to: ADDRESS.toLowerCase(),
          value: "1000000000000000",
          timeStamp: "1790755200",
          isError: "0",
        },
      ],
    },
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

/**
 * A fetch that answers as the explorer and its metadata service, or with [status] for every call when the test gives
 * one. [failing] starts the paths that fail with 500, and [names] are the tags of type name of the metadata service.
 */
function explorer(
  status?: number,
  { failing = [], names = {} }: { failing?: string[]; names?: Record<string, string> } = {},
): { fetchImpl: typeof fetch; sent: Sent[] } {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const text = String(url);
    sent.push({ url: text, init: init ?? {} });
    if (text.startsWith(METADATA_URL)) {
      if (failing.includes(METADATA_URL)) return new Response("{}", { status: 500 });
      return Response.json({
        addresses: Object.fromEntries(
          Object.entries(names).map(([address, name]) => [
            address.toLowerCase(),
            { tags: [{ name, tagType: "name" }] },
          ]),
        ),
      });
    }
    if (status !== undefined) return new Response("{}", { status });
    // The explorer reads an address in any case of its letters.
    const path = text.replace("https://api.blockscout.com", "").toLowerCase();
    if (failing.some((start) => path.startsWith(start.toLowerCase()))) return new Response("{}", { status: 500 });
    const answer = ANSWERS.find(([start]) => path.startsWith(start.toLowerCase()));
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
  const explorerCalls = sent.filter((call) => call.url.startsWith("https://api.blockscout.com"));
  assert.equal(explorerCalls.length, 9, "seven lists and the name of the sender of the first funding");
  for (const call of explorerCalls) {
    assert.equal(call.init.redirect, "error");
    assert.equal((call.init.headers as Record<string, string>).authorization, `Bearer ${KEY}`);
    assert.ok(!call.url.includes(KEY), "the key stays out of every URL");
  }
  // The metadata service is another host, which needs no key, so the key of the explorer never goes there.
  const metadataCalls = sent.filter((call) => call.url.startsWith(METADATA_URL));
  assert.equal(metadataCalls.length, 1);
  assert.equal(metadataCalls[0].init.redirect, "error");
  assert.equal(metadataCalls[0].init.headers, undefined);
  assert.ok(!metadataCalls[0].url.includes(KEY));
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
  // The first funding: the oldest transfer of value in, here the ETH that a contract sent, named as the explorer names
  // the contract; a failed transfer and one of nothing fund nothing.
  assert.equal(scan.firstFunding?.hash, "0xinternal");
  assert.deepEqual(scan.firstFunding?.from, { address: DISPERSE.toLowerCase(), label: "Disperse", isContract: true });
  assert.equal(scan.firstFunding?.time, "2026-09-30T08:00:00.000Z");
  assert.equal(scan.fundingSure, true);
});

test("a tag of the metadata service names the first funder before the explorer does", async () => {
  const { fetchImpl } = explorer(undefined, { names: { [DISPERSE]: "Disperse: Airdrops" } });
  const time = clock();
  const scan = await new Blockscout(KEY, { fetchImpl, now: time.now, sleep: time.sleep }).scan(ADDRESS);
  assert.equal(scan.firstFunding?.from.label, "Disperse: Airdrops");
  assert.equal(scan.fundingSure, true);
});

test("a failed list of internal transfers, or a failed name, leaves the first funding unsure and the scan whole", async () => {
  for (const failing of [
    ["/v2/api?chain_id=4663&module=account&action=txlistinternal"],
    [`/4663/api/v2/addresses/${DISPERSE}`],
    [METADATA_URL],
  ]) {
    const { fetchImpl } = explorer(undefined, { failing });
    const time = clock();
    const scan = await new Blockscout(KEY, { fetchImpl, now: time.now, sleep: time.sleep }).scan(ADDRESS);
    assert.equal(scan.fundingSure, false, failing.join());
    assert.equal(scan.transactionCount, 12, "the rest of the scan stands");
    assert.ok(scan.firstFunding !== null, "the oldest transfer in that the relay could read");
  }
  // Without the internal transfers, the oldest one in is the ETH of the exchange.
  const { fetchImpl } = explorer(undefined, {
    failing: ["/v2/api?chain_id=4663&module=account&action=txlistinternal"],
  });
  const scan = await new Blockscout(KEY, { fetchImpl }).scan(ADDRESS);
  assert.equal(scan.firstFunding?.hash, "0xtx1");
});

test("reads the first funding for another source, with the transfers in that it already found", async () => {
  const { fetchImpl, sent } = explorer();
  const time = clock();
  const blockscout = new Blockscout(KEY, { fetchImpl, now: time.now, sleep: time.sleep });
  const older = {
    hash: "0xolder",
    from: { address: SHOP, label: null, isContract: false },
    to: { address: ADDRESS, label: null, isContract: false },
    value: "7",
    token: null,
    time: "2026-08-01T08:00:00.000Z",
  };
  const funding = await blockscout.funding(ADDRESS, [older]);
  assert.equal(funding.transfer?.hash, "0xolder", "a known transfer in that came earlier wins");
  assert.equal(funding.transfer?.from.label, "Coffee Shop", "the explorer names the sender of the other source");
  assert.equal(funding.sure, true);
  const withoutKnown = await blockscout.funding(ADDRESS, []);
  assert.equal(withoutKnown.transfer?.hash, "0xinternal");
  assert.ok(
    sent.every((call) => !call.url.includes("/counters")),
    "the first funding reads the oldest rows and the name of the sender alone",
  );
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
    const time = clock();
    await assert.rejects(
      new Blockscout(KEY, { fetchImpl, now: time.now, sleep: time.sleep }).scan(ADDRESS),
      (error: unknown) => {
        assert.ok(error instanceof GatewayError);
        assert.equal(error.status, expected, String(status));
        assert.ok(!error.message.includes(KEY));
        return true;
      },
    );
  }
});

test("keeps a scan for a while, so that a second look spends no call", async () => {
  const { fetchImpl, sent } = explorer();
  const time = clock();
  const blockscout = new Blockscout(KEY, { fetchImpl, now: time.now, sleep: time.sleep });
  await blockscout.scan(ADDRESS);
  const calls = sent.length;
  await blockscout.scan(ADDRESS.toLowerCase());
  assert.equal(sent.length, calls);
  time.advance(SCAN_CACHE_MS);
  await blockscout.scan(ADDRESS);
  assert.equal(sent.length, calls * 2);
});

test("waits for its budget of calls instead of passing it", async () => {
  const { fetchImpl } = explorer();
  const time = clock();
  const start = time.now();
  await new Blockscout(KEY, { fetchImpl, now: time.now, sleep: time.sleep }).scan(ADDRESS);
  // Nine calls at three a second: the burst takes three, and the other six wait for the budget.
  assert.ok(time.now() - start >= ((9 - BLOCKSCOUT_CALLS_PER_SECOND) * 1000) / BLOCKSCOUT_CALLS_PER_SECOND - 1);
});

/** The relay with a scanner that answers from a list, and nothing behind its routes of the bridge. */
async function relayWith(scanner: ChainScanner | null): Promise<{ base: string; close: () => void }> {
  const relay = createRelay({
    exchanger: {} as Exchanger,
    scanner,
    tokens: new SwapTokens("a secret of the test"),
    creations: new CreationKeys(60_000, 10),
    signer: new AnswerSigner(
      generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    ),
  });
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

test("a refusal for the rate waits for the window that the explorer names and tries once more", async () => {
  const time = clock();
  let refusals = 1;
  const waits: number[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    if (refusals > 0) {
      refusals -= 1;
      return new Response("{}", { status: 429, headers: { "x-ratelimit-reset": "400" } });
    }
    return explorer().fetchImpl(url, init);
  }) as typeof fetch;
  const sleep = async (ms: number) => {
    waits.push(ms);
    time.advance(ms);
  };
  const scan = await new Blockscout(KEY, { fetchImpl, now: time.now, sleep }).scan(ADDRESS);
  assert.equal(scan.transactionCount, 12);
  assert.equal(waits[0], 400, "the wait that the header names");
  refusals = 2;
  await assert.rejects(new Blockscout(KEY, { fetchImpl, now: time.now, sleep }).scan(ADDRESS), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 503);
    return true;
  });
});
