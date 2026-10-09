// The settings of the relay. This module is the only one that reads the environment; it checks every variable at
// startup and stops with a clear error when one is missing. The API key is read from a file and is never printed.
import { readFileSync } from "node:fs";

export interface RelayConfig {
  host: string;
  port: number;
  changenowApiKey: string;
  /** The key of the PRO API of Blockscout for the scan of an address, or null when the relay has none. */
  blockscoutApiKey: string | null;
  /** The key of Alchemy for the scan of an address, or null when the relay has none. The relay prefers it. */
  alchemyApiKey: string | null;
  /** The secret of the read tokens of swaps, which the server makes once and which never leaves it. */
  swapTokenKey: string;
  /** The private key that signs every answer, as PEM text. */
  answerSigningKey: string;
}

/** The API of ChangeNOW. v1 serves the minimum and the estimate with a standard key; v2 makes and reads exchanges. */
export const CHANGENOW_BASE_URL = "https://api.changenow.io";

/** A call to ChangeNOW that takes longer than this fails, so that the app does not wait without end. */
export const UPSTREAM_TIMEOUT_MS = 20_000;

/** The relay reads at most this many bytes of a request body. A request of the app is far smaller. */
export const MAX_BODY_BYTES = 4096;

/**
 * The relay makes at most this many calls to ChangeNOW in a second, for all users together. ChangeNOW takes 30 calls a
 * second for one key (CHECKED 5 Oct 2026, its API documentation), so the relay stays below it and answers 503 instead.
 */
export const UPSTREAM_CALLS_PER_SECOND = 20;

/** The relay keeps the minimum of receive for this long, so that a burst of quotes asks ChangeNOW once. */
export const MIN_AMOUNT_CACHE_MS = 60_000;

/** A refusal of ChangeNOW reaches the app with at most this many characters of its text. */
export const MAX_FORWARDED_MESSAGE_CHARS = 200;

/**
 * Two amounts match when they differ by less than this share of the larger one. ChangeNOW answers with a number for
 * the amount that the app sent as text, so the relay compares the two as numbers.
 */
export const AMOUNT_MATCH_TOLERANCE = 1e-9;

/**
 * The PRO API of Blockscout, the explorer of Robinhood Chain, which the privacy scan of an address in the app reads.
 * CHECKED 7 Oct 2026, docs.blockscout.com/devs/pro-api-responses-and-routes: the REST API of a chain answers at
 * https://api.blockscout.com/{chain id}/api/v2 and the API in the style of Etherscan at https://api.blockscout.com/v2/api,
 * and the key goes in the header authorization; the explorer robinhoodchain.blockscout.com answers a script with a
 * challenge of Cloudflare, so the relay uses this API.
 */
export const BLOCKSCOUT_BASE_URL = "https://api.blockscout.com";

/** Robinhood Chain. CHECKED 7 Oct 2026: eth_chainId of https://rpc.mainnet.chain.robinhood.com answers 0x1237. */
export const ROBINHOOD_CHAIN_ID = 4663;

/**
 * The free plan of the PRO API allows 5 calls in each window of one second (CHECKED 7 Oct 2026: the headers
 * x-ratelimit-limit 5 and x-ratelimit-reset in milliseconds) and 100,000 credits a day, of which a call of the REST
 * API spent 20 (x-credits-remaining went from 99,700 to 99,680). A burst of the limiter and the refill of the next
 * window stay below the limit most of the time; a refusal waits for the next window once.
 */
export const BLOCKSCOUT_CALLS_PER_SECOND = 3;

/** A refusal for the rate waits at most this long for the next window before its one retry. */
export const BLOCKSCOUT_RETRY_WAIT_MS = 1_500;

/** A call of a scan waits at most this long for a free slot of the budget before the relay answers that it is busy. */
export const SCAN_SLOT_WAIT_MS = 3_000;

/**
 * The endpoint of Alchemy for Robinhood Chain, which the relay prefers for the scan of an address. CHECKED 7 Oct 2026
 * with the key of Kranox: eth_chainId answers 0x1237 with the key in the header authorization;
 * alchemy_getAssetTransfers serves the categories external and erc20 on this network, oldest or newest first, with the
 * time of each block, and refuses internal ("The 'internal' category is not supported for this network");
 * alchemy_getTokenBalances answers.
 */
export const ALCHEMY_URL = "https://robinhood-mainnet.g.alchemy.com/v2";

/** The relay makes at most this many calls to Alchemy in a second; a scan makes eight. */
export const ALCHEMY_CALLS_PER_SECOND = 10;

/**
 * The metadata service of Blockscout, which gives the public names of addresses without a key. CHECKED 7 Oct 2026:
 * /api/v1/metadata?addresses=…&chainId=… answers the tags of each address, and a tag of tagType "name" names it, such
 * as "Binance: Hot Wallet" on Ethereum. The relay asks it for the names around a scan of Alchemy, which has none.
 */
export const METADATA_URL = "https://metadata.services.blockscout.com/api/v1/metadata";

/** The relay asks the names of at most this many addresses of one scan. */
export const METADATA_MAX_ADDRESSES = 50;

/**
 * After a source of the scan fails, the relay skips it for this long and asks the next one, so that a spent budget of
 * Alchemy sends the scans to Blockscout without a failed call before each of them.
 */
export const SCAN_SOURCE_PAUSE_MS = 10 * 60_000;

/** A scan reads at most this many recent transfers in each direction. */
export const SCAN_RECENT_TRANSFERS = 50;

/** The relay keeps the scan of an address for this long, so that a second look spends no call. */
export const SCAN_CACHE_MS = 10 * 60_000;

/** The relay keeps at most this many scans at once, and forgets the oldest first. */
export const SCAN_CACHE_ENTRIES = 200;

/**
 * Whether a read of a swap needs its read token. The apps up to 0.3.0 send none, so a read without a token passes
 * while they run; a token that a read carries must belong to the swap. Set it to true once a main release that sends
 * tokens is out and the older apps are gone (K-18 of the security review of 0.2.0).
 */
export const SWAP_TOKENS_REQUIRED = false;

/**
 * The relay keeps the creation of an exchange under the key that the app sends with it this long, and at most this
 * many at once, so that a second try after a lost answer gets the same exchange (K-14 of the security review of 0.2.0).
 * A full store refuses new keys and keeps the live ones (relay O-008 of the second security review). The budget of
 * ChangeNOW calls makes at most 20 a second, 12,000 in the lifetime of a key, so 20,000 entries never fill with real
 * exchanges; a failed creation leaves at once. An entry holds a hash and the answer of a creation, under 1 KB.
 */
export const CREATION_KEY_MS = 10 * 60_000;
export const CREATION_KEY_ENTRIES = 20_000;

const HIGHEST_PORT = 65_535;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`The environment variable ${name} is missing. .env.example lists the variables of the relay.`);
  }
  return value;
}

/** Reads a key from the file that the variable [name] names: one line, and nothing else. */
function readKey(name: string, service: string): string {
  const keyFile = required(name);
  let key: string;
  try {
    key = readFileSync(keyFile, "utf8").trim();
  } catch {
    // The message names the variable and never its value: a key pasted into the variable by mistake stays unprinted.
    throw new Error(`The key file named by ${name} cannot be read. The variable must hold its path.`);
  }
  if (!key || /\s/.test(key)) {
    throw new Error(`The key file must hold the API key of ${service} on one line, and nothing else.`);
  }
  return key;
}

/** Reads a private key as PEM text from the file that the variable [name] names. */
function readPem(name: string): string {
  const keyFile = required(name);
  let pem: string;
  try {
    pem = readFileSync(keyFile, "utf8").trim();
  } catch {
    throw new Error(`The key file named by ${name} cannot be read. The variable must hold its path.`);
  }
  if (!pem.startsWith("-----BEGIN PRIVATE KEY-----") || !pem.endsWith("-----END PRIVATE KEY-----")) {
    throw new Error(`The key file named by ${name} must hold one private key as PEM text.`);
  }
  return pem;
}

export function loadConfig(): RelayConfig {
  const port = Number(required("RELAY_PORT"));
  if (!Number.isInteger(port) || port < 1 || port > HIGHEST_PORT) {
    throw new Error(`RELAY_PORT must be a whole number from 1 to ${HIGHEST_PORT}.`);
  }
  const changenowApiKey = readKey("CHANGENOW_API_KEY_FILE", "ChangeNOW");
  // The scan of an address is optional: without the variable, its route answers that the relay cannot scan yet.
  const blockscoutApiKey = process.env.BLOCKSCOUT_API_KEY_FILE?.trim()
    ? readKey("BLOCKSCOUT_API_KEY_FILE", "Blockscout")
    : null;
  const alchemyApiKey = process.env.ALCHEMY_API_KEY_FILE?.trim() ? readKey("ALCHEMY_API_KEY_FILE", "Alchemy") : null;
  const swapTokenKey = readKey("SWAP_TOKEN_KEY_FILE", "the read tokens of swaps");
  const answerSigningKey = readPem("ANSWER_SIGNING_KEY_FILE");
  return {
    host: required("RELAY_HOST"),
    port,
    changenowApiKey,
    blockscoutApiKey,
    alchemyApiKey,
    swapTokenKey,
    answerSigningKey,
  };
}
