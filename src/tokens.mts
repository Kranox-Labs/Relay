// The read token of a swap: an HMAC of its exchange id under a secret that never leaves the server, so that only the
// app that made a swap reads its state through the relay (K-18 of the security review of 0.2.0). The relay keeps no
// list of tokens: it makes the token of an id again whenever it checks one. From 12 Oct 2026 the token of a swap at
// another exchanger than ChangeNOW names that exchanger too, so that a token reads one swap at one exchanger and not
// the same id at the other (R-03 of the scan of 12 Oct 2026); the tokens of ChangeNOW keep their first form, so that
// the apps that hold one go on reading.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderId } from "./exchanger.mts";

/** The name of the header that carries the token of a swap to the relay. */
export const SWAP_TOKEN_HEADER = "kranox-swap-token";

export class SwapTokens {
  readonly #secret: string;

  constructor(secret: string) {
    if (secret.length === 0) throw new Error("The secret of the read tokens of swaps must not be empty.");
    this.#secret = secret;
  }

  /** The token of the swap [id] at [provider]. */
  issue(id: string, provider: ProviderId): string {
    const message = provider === "changenow" ? `kranox-swap:${id}` : `kranox-swap:${provider}:${id}`;
    return createHmac("sha256", this.#secret).update(message).digest("base64url");
  }

  /** Whether [token] belongs to the swap [id] at [provider], compared in a time that does not depend on the text. */
  matches(id: string, provider: ProviderId, token: string): boolean {
    const expected = Buffer.from(this.issue(id, provider));
    const given = Buffer.from(token);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
