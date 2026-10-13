// The addresses of Starknet, the chain of STRK, from 13 Oct 2026: a field element below the prime of Stark, written as
// 0x and up to 64 hex digits (CHECKED 13 Oct 2026, docs.near-intents.org, "Chain support": a 251-bit hexadecimal
// address starting with 0x). One address can be written with or without leading zeros and in either case of its
// digits, so two are the same when their values are.

/** The prime of the field of Starknet: 2^251 + 17 * 2^192 + 1. */
export const STARK_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

/**
 * The least value of an address of an account of Starknet. An account address is the hash of the class, the salt, and
 * the constructor, a value spread over the 251 bits of the field; the chance that one fits in 160 bits is 2^-91. A
 * value that does fit is an address of an EVM chain, such as the one of the wallet on Robinhood Chain pasted by
 * mistake, or one of the few system addresses of Starknet (0x1, 0x2), which no refund can reach: all of them are
 * refused (D-17 of the scan of 13 Oct 2026).
 */
export const STARKNET_ACCOUNT_FLOOR = 1n << 160n;

/** The shape of an address: 0x and 1 to 64 hex digits. Its value must also lie above the floor and below the prime. */
export const STARKNET_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{1,64}$/;

/** Whether [text] is an address of an account of Starknet: the shape above, and a value from the floor to the prime. */
export function isStarknetAddress(text: string): boolean {
  if (!STARKNET_ADDRESS_PATTERN.test(text)) return false;
  const value = BigInt(text);
  return value >= STARKNET_ACCOUNT_FLOOR && value < STARK_PRIME;
}

/** Whether two addresses of Starknet name the same account, whatever their leading zeros and the case of their digits. */
export function sameStarknetAddress(a: string, b: string): boolean {
  return isStarknetAddress(a) && isStarknetAddress(b) && BigInt(a) === BigInt(b);
}
