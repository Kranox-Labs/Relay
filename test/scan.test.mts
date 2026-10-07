import assert from "node:assert/strict";
import { test } from "node:test";
import { GatewayError } from "../src/changenow.mts";
import { SCAN_SOURCE_PAUSE_MS } from "../src/config.mts";
import { FallbackScanner, type ChainScan, type ChainScanner } from "../src/scan.mts";

const ADDRESS = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

/** A source that answers with its own scan, or fails with [failure] while it is set. */
function source(name: string): ChainScanner & { calls: number; failure: Error | null } {
  return {
    calls: 0,
    failure: null,
    async scan(address: string) {
      this.calls += 1;
      if (this.failure !== null) throw this.failure;
      return { address, balanceWei: name } as ChainScan;
    },
  };
}

function clock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1_000_000;
  return { now: () => time, advance: (ms) => (time += ms) };
}

test("asks the first source, and the next one only when it fails", async () => {
  const alchemy = source("alchemy");
  const blockscout = source("blockscout");
  const scanner = new FallbackScanner([alchemy, blockscout]);
  assert.equal((await scanner.scan(ADDRESS)).balanceWei, "alchemy");
  assert.equal(blockscout.calls, 0);
});

test("a spent budget sends the scans to the next source, and the first one rests for a while", async () => {
  const time = clock();
  const alchemy = source("alchemy");
  const blockscout = source("blockscout");
  const scanner = new FallbackScanner([alchemy, blockscout], time.now);
  alchemy.failure = new GatewayError(503, "Alchemy is busy. Try again in a minute.");
  assert.equal((await scanner.scan(ADDRESS)).balanceWei, "blockscout");
  assert.equal((await scanner.scan(ADDRESS)).balanceWei, "blockscout");
  assert.equal(alchemy.calls, 1, "a resting source gets no call");
  alchemy.failure = null;
  time.advance(SCAN_SOURCE_PAUSE_MS);
  assert.equal((await scanner.scan(ADDRESS)).balanceWei, "alchemy");
});

test("when every source fails, the last failure reaches the app, and a later scan still tries", async () => {
  const time = clock();
  const alchemy = source("alchemy");
  const blockscout = source("blockscout");
  const scanner = new FallbackScanner([alchemy, blockscout], time.now);
  alchemy.failure = new GatewayError(503, "Alchemy is busy. Try again in a minute.");
  blockscout.failure = new GatewayError(502, "The relay cannot use Blockscout right now.");
  await assert.rejects(scanner.scan(ADDRESS), (error: unknown) => {
    assert.ok(error instanceof GatewayError);
    assert.equal(error.status, 502);
    return true;
  });
  blockscout.failure = null;
  assert.equal((await scanner.scan(ADDRESS)).balanceWei, "blockscout", "both rest, so both are asked again");
});

test("a fault that is not a failure of a source reaches the app at once", async () => {
  const alchemy = source("alchemy");
  const blockscout = source("blockscout");
  alchemy.failure = new TypeError("a fault of the code");
  await assert.rejects(new FallbackScanner([alchemy, blockscout]).scan(ADDRESS), TypeError);
  assert.equal(blockscout.calls, 0);
});
