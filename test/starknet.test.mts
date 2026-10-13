import assert from "node:assert/strict";
import { test } from "node:test";
import { STARK_PRIME, STARKNET_ACCOUNT_FLOOR, isStarknetAddress, sameStarknetAddress } from "../src/starknet.mts";

// An address of Starknet of the usual length, 64 hex digits after 0x, as a wallet writes one.
const ADDRESS = "0x04a3f9c1b2e7d8a5c6f0e1d2c3b4a5968778695a4b3c2d1e0f1a2b3c4d5e6f70";

test("takes an address of Starknet: 0x, up to 64 hex digits, a value above zero and below the prime", () => {
  assert.equal(isStarknetAddress(ADDRESS), true);
  assert.equal(isStarknetAddress("0x1"), false, "a system address of Starknet is no account");
  assert.equal(isStarknetAddress(`0x${STARKNET_ACCOUNT_FLOOR.toString(16)}`), true, "the first value of an account");
  assert.equal(isStarknetAddress(`0x${(STARKNET_ACCOUNT_FLOOR - 1n).toString(16)}`), false, "below the floor");
  assert.equal(isStarknetAddress("0x7A3Fc0E1b9D24a6C58E0F3B1d9A7C4e2F6B8D015"), false, "an address of an EVM chain");
  assert.equal(
    isStarknetAddress("0x0000000000000000000000007a3fc0e1b9d24a6c58e0f3b1d9a7c4e2f6b8d015"),
    false,
    "the same, padded",
  );
  assert.equal(isStarknetAddress(ADDRESS.toUpperCase().replace("0X", "0x")), true, "the case of the digits is free");
  assert.equal(isStarknetAddress(`0x${(STARK_PRIME - 1n).toString(16)}`), true, "the last value below the prime");
  assert.equal(isStarknetAddress(`0x${STARK_PRIME.toString(16)}`), false, "the prime itself is no field element");
  assert.equal(isStarknetAddress("0x0"), false, "zero names no account");
  assert.equal(isStarknetAddress(`0x${"f".repeat(64)}`), false, "above the prime");
  assert.equal(isStarknetAddress(`0x${"1".repeat(65)}`), false, "too long");
  assert.equal(isStarknetAddress("0x"), false);
  assert.equal(isStarknetAddress(ADDRESS.slice(2)), false, "without 0x");
  assert.equal(isStarknetAddress("0xg1"), false, "not hex");
  assert.equal(isStarknetAddress(""), false);
});

test("two addresses are the same by their value, whatever their leading zeros and their case", () => {
  assert.equal(sameStarknetAddress(ADDRESS, ADDRESS), true);
  assert.equal(sameStarknetAddress(ADDRESS, `0x${ADDRESS.slice(3)}`), true, "without its leading zero");
  assert.equal(sameStarknetAddress(ADDRESS, ADDRESS.toUpperCase().replace("0X", "0x")), true);
  assert.equal(sameStarknetAddress(ADDRESS, `0x${ADDRESS.slice(3, -1)}1`), false, "one digit differs");
  assert.equal(sameStarknetAddress("0x0", "0x0"), false, "no address is the same as no address");
  assert.equal(sameStarknetAddress("0x1", "0x1"), false, "nor is a system address");
});
