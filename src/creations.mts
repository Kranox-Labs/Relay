// The creations of exchanges under the key that the app sends with each, for a few minutes, so that a second try of
// the same request after a lost answer gets the exchange of the first try instead of a second exchange (K-14 of the
// security review of 0.2.0). The relay holds them in memory only: a restart forgets them, and no file holds them.
import { createHash } from "node:crypto";

/** The name of the header that carries the key of a creation, after the draft of the IETF for HTTP. */
export const CREATION_KEY_HEADER = "idempotency-key";

/** A key of the app: 16 to 128 letters, digits, dashes, or underscores. */
const CREATION_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** The key came with another request than the one that it first came with. */
export class CreationKeyReused extends Error {}

/** The key has the wrong form. */
export class CreationKeyInvalid extends Error {}

/** The relay holds as many live keys as it can; a new key waits until one runs out. */
export class CreationKeysFull extends Error {}

interface Creation {
  fingerprint: string;
  expiresAt: number;
  result: Promise<unknown>;
}

export class CreationKeys {
  readonly #lifetimeMs: number;
  readonly #capacity: number;
  readonly #now: () => number;
  readonly #creations = new Map<string, Creation>();

  constructor(lifetimeMs: number, capacity: number, now: () => number = Date.now) {
    this.#lifetimeMs = lifetimeMs;
    this.#capacity = capacity;
    this.#now = now;
  }

  /**
   * Runs [create] once for [key] and [request]: a second call with the same key and the same request gets the result
   * of the first, also while the first still runs. A failed creation is forgotten, so that a second try runs again.
   * Without a key, [create] runs each time. When the relay holds as many live keys as it can, a new key is refused
   * and no live key goes, so that a flood of keys never makes a second exchange for the retry of a user (relay O-008
   * of the second security review).
   */
  async run(key: string | undefined, request: unknown, create: () => Promise<unknown>): Promise<unknown> {
    if (key === undefined) return create();
    if (!CREATION_KEY_PATTERN.test(key)) throw new CreationKeyInvalid("The idempotency key has the wrong form.");
    this.#forgetExpired();
    const fingerprint = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const known = this.#creations.get(key);
    if (known !== undefined) {
      if (known.fingerprint !== fingerprint) {
        throw new CreationKeyReused("The idempotency key belongs to another request.");
      }
      return known.result;
    }
    if (this.#creations.size >= this.#capacity) {
      throw new CreationKeysFull("The relay is busy. Try again in a moment.");
    }
    const result = create();
    this.#creations.set(key, { fingerprint, expiresAt: this.#now() + this.#lifetimeMs, result });
    try {
      return await result;
    } catch (error) {
      if (this.#creations.get(key)?.result === result) this.#creations.delete(key);
      throw error;
    }
  }

  #forgetExpired(): void {
    const now = this.#now();
    for (const [key, creation] of this.#creations) {
      if (creation.expiresAt <= now) this.#creations.delete(key);
    }
  }
}
