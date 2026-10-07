// The settings of the relay. This module is the only one that reads the environment; it checks every variable at
// startup and stops with a clear error when one is missing. The API key is read from a file and is never printed.
import { readFileSync } from "node:fs";

export interface RelayConfig {
  host: string;
  port: number;
  changenowApiKey: string;
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

const HIGHEST_PORT = 65_535;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`The environment variable ${name} is missing. .env.example lists the variables of the relay.`);
  }
  return value;
}

export function loadConfig(): RelayConfig {
  const port = Number(required("RELAY_PORT"));
  if (!Number.isInteger(port) || port < 1 || port > HIGHEST_PORT) {
    throw new Error(`RELAY_PORT must be a whole number from 1 to ${HIGHEST_PORT}.`);
  }
  const keyFile = required("CHANGENOW_API_KEY_FILE");
  let changenowApiKey: string;
  try {
    changenowApiKey = readFileSync(keyFile, "utf8").trim();
  } catch {
    // The message names the variable and never its value: a key pasted into the variable by mistake stays unprinted.
    throw new Error("The key file named by CHANGENOW_API_KEY_FILE cannot be read. The variable must hold its path.");
  }
  if (!changenowApiKey || /\s/.test(changenowApiKey)) {
    throw new Error("The key file must hold the API key of ChangeNOW on one line, and nothing else.");
  }
  return { host: required("RELAY_HOST"), port, changenowApiKey };
}
