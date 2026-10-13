// The transparent addresses of Zcash, the chain of ZEC, from 13 Oct 2026: the base58check of Bitcoin with the prefix
// of Zcash, a public key hash (t1, the bytes 0x1CB8) or a script hash (t3, the bytes 0x1CBD), 20 bytes of hash and a
// checksum of 4 bytes of a double SHA-256 (CHECKED 13 Oct 2026, the protocol of Zcash, section "Transparent
// Addresses"). The exchangers of the relay take and pay ZEC at transparent addresses alone: 1Click says "transparent
// addresses only" (its page of the chains), and a shielded or unified address (zs1, u1) takes no refund here.
import { createHash } from "node:crypto";

/** The alphabet of base58, without 0, O, I, and l. */
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** The bytes of an address: two of the prefix, twenty of the hash, four of the checksum. */
const PREFIX_BYTES = 2;
const HASH_BYTES = 20;
const CHECKSUM_BYTES = 4;
const ADDRESS_BYTES = PREFIX_BYTES + HASH_BYTES + CHECKSUM_BYTES;

/** The prefixes of the mainnet: a public key hash (t1…) and a script hash (t3…). */
const PREFIXES = [
  [0x1c, 0xb8],
  [0x1c, 0xbd],
] as const;

/** A transparent address is 35 characters of base58 that start with t1 or t3. */
export const ZCASH_TRANSPARENT_PATTERN = /^t[13][1-9A-HJ-NP-Za-km-z]{33}$/;

/** The bytes of [text] in base58, or null for text that is not base58. */
export function decodeBase58(text: string): Uint8Array | null {
  let value = 0n;
  for (const char of text) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value % 256n));
    value /= 256n;
  }
  for (const char of text) {
    if (char !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

/** Whether [text] is a transparent address of the Zcash mainnet: its shape, its prefix, and its checksum. */
export function isZcashTransparentAddress(text: string): boolean {
  if (!ZCASH_TRANSPARENT_PATTERN.test(text)) return false;
  const bytes = decodeBase58(text);
  if (bytes === null || bytes.length !== ADDRESS_BYTES) return false;
  const body = bytes.subarray(0, PREFIX_BYTES + HASH_BYTES);
  const checksum = bytes.subarray(PREFIX_BYTES + HASH_BYTES);
  const expected = sha256(sha256(body)).subarray(0, CHECKSUM_BYTES);
  if (!expected.equals(Buffer.from(checksum))) return false;
  return PREFIXES.some(([first, second]) => body[0] === first && body[1] === second);
}
