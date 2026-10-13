import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ZCASH_TRANSPARENT_PATTERN, decodeBase58, isZcashTransparentAddress } from "../src/zcash.mts";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** The base58 of [bytes], for the vectors of the test. */
function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let text = "";
  while (value > 0n) {
    text = ALPHABET[Number(value % 58n)] + text;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    text = `1${text}`;
  }
  return text;
}

/** An address of the shape of Zcash with a right checksum over [prefix] and twenty zero bytes of hash. */
function addressWithPrefix(prefix: readonly number[]): string {
  const body = Buffer.concat([Buffer.from(prefix), Buffer.alloc(20)]);
  const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();
  return encodeBase58(Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]));
}

// Two transparent addresses of the Zcash mainnet made for the tests, a public key hash (t1) and a script hash (t3),
// from hashes of made-up text: nobody holds their keys.
const T1 = "t1URu8q83ibd8sgDoW3VnJoPjUusRz97h8J";
const T3 = "t3S5pQGfcc3VC7ZyrC59bQwrnHco6q5Jzck";

test("decodes base58 with its leading zeros", () => {
  assert.deepEqual(decodeBase58("1"), Uint8Array.from([0]));
  assert.deepEqual(decodeBase58("2"), Uint8Array.from([1]));
  assert.deepEqual(decodeBase58("11z"), Uint8Array.from([0, 0, 57]));
  assert.equal(decodeBase58("0"), null, "0 is no character of base58");
  assert.equal(decodeBase58("t1l"), null, "nor is l");
  assert.equal(decodeBase58(T1)?.length, 26);
});

test("takes a transparent address of the mainnet with its checksum, t1 or t3", () => {
  assert.equal(isZcashTransparentAddress(T1), true);
  assert.equal(isZcashTransparentAddress(T3), true);
});

test("refuses an address with one wrong character, of another form, or of a shielded pool", () => {
  const changed = `${T1.slice(0, 20)}${T1[20] === "a" ? "b" : "a"}${T1.slice(21)}`;
  assert.equal(isZcashTransparentAddress(changed), false, "the checksum catches one wrong character");
  assert.equal(isZcashTransparentAddress(T1.slice(0, 34)), false, "too short");
  assert.equal(isZcashTransparentAddress(`${T1}1`), false, "too long");
  assert.equal(isZcashTransparentAddress(`t2${T1.slice(2)}`), false, "t2 is no prefix of the mainnet");
  assert.equal(isZcashTransparentAddress("tmEsp4oaowYsncsXMGHsb6TA6s8Qop7bZwa"), false, "a testnet address");
  assert.equal(isZcashTransparentAddress("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2"), false, "a Bitcoin address");
  assert.equal(
    isZcashTransparentAddress("zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8f3g2d4kv4v9q0jfgcm3vhk3wm6ajqmp8"),
    false,
    "a shielded address of Sapling",
  );
  assert.equal(
    isZcashTransparentAddress(
      "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpjkmh6xfyau7zh33ac",
    ),
    false,
    "a unified address",
  );
  assert.equal(isZcashTransparentAddress(""), false);
});

test("refuses an address of the right shape and checksum whose prefix is not one of the mainnet (R-31)", () => {
  // The bytes 0x1CB9 lie between the prefixes of t1 (0x1CB8) and t3 (0x1CBD), and still write as t1…: only the check
  // of the prefix refuses such an address.
  const between = addressWithPrefix([0x1c, 0xb9]);
  assert.match(between, ZCASH_TRANSPARENT_PATTERN, "the vector has the shape of an address");
  assert.equal(isZcashTransparentAddress(between), false);
  for (const prefix of [
    [0x1c, 0xb8],
    [0x1c, 0xbd],
  ]) {
    assert.equal(isZcashTransparentAddress(addressWithPrefix(prefix)), true, prefix.join(","));
  }
});
