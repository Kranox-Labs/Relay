// The signature of each answer of the relay, so that the app trusts an answer only from the relay itself: an
// interception of the connection, such as a company proxy with its own certificate, cannot name its own deposit
// address (K-10 of the security review of 0.2.0). The key is ECDSA on P-256; the app holds its public key. The
// signature covers the nonce of the request and the body of the answer, so that an old answer cannot answer a new
// request.
import { createPrivateKey, sign, type KeyObject } from "node:crypto";

/** The headers of the nonce of a request and of the signature of its answer. */
export const NONCE_HEADER = "kranox-nonce";
export const SIGNATURE_HEADER = "kranox-signature";

/** A nonce of the app: 16 to 64 letters, digits, dashes, or underscores. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The curve of the key, by its name in OpenSSL. */
const CURVE = "prime256v1";

export class AnswerSigner {
  readonly #key: KeyObject;

  /** Takes the private key as PEM text. */
  constructor(pem: string) {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== CURVE) {
      throw new Error("The signing key of the relay must be an EC key on the curve P-256.");
    }
    this.#key = key;
  }

  /** The signature, in base64, of [body] for the request with [nonce]: 64 bytes of r and s. */
  sign(nonce: string, body: string): string {
    const message = Buffer.from(`${nonce}\n${body}`, "utf8");
    return sign("sha256", message, { key: this.#key, dsaEncoding: "ieee-p1363" }).toString("base64");
  }
}

/** The nonce of a request: its text when it has the form of the app, otherwise empty, as from an app before 0.3.1. */
export function readNonce(value: string | undefined): string {
  return value !== undefined && NONCE_PATTERN.test(value) ? value : "";
}
