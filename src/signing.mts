// The signature of each answer of the relay, so that the app trusts an answer only from the relay itself: an
// interception of the connection, such as a company proxy with its own certificate, cannot name its own deposit
// address (K-10 of the security review of 0.2.0). The key is ECDSA on P-256; the app holds its public key.
//
// An answer carries two signatures. The first covers the nonce of the request and the body of the answer; the apps
// 0.3.1 check it. The second also covers the method, the path with its query, a hash of the body of the request, and
// the status, so that a signed answer answers only the request that the app sent (wallet O-003 and relay O-004 of
// the second security review); later apps check it. The first goes when the apps 0.3.1 are gone.
import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";

/** The headers of the nonce of a request and of the two signatures of its answer. */
export const NONCE_HEADER = "kranox-nonce";
export const SIGNATURE_HEADER = "kranox-signature";
export const SIGNATURE_V2_HEADER = "kranox-signature-v2";

/** A nonce of the app: 16 to 64 letters, digits, dashes, or underscores. */
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

/** The curve of the key, by its name in OpenSSL. */
const CURVE = "prime256v1";

/**
 * The first line of the text of a signature of the second form. A nonce holds no slash, so the text of the first
 * form, which starts with the nonce, never reads as one of the second.
 */
const ANSWER_V2 = "kranox/answer/2";

/** What a signature of the second form binds: the request with its nonce, and the answer. */
export interface SignedAnswer {
  nonce: string;
  method: string;
  /** The path of the request with its query, as the relay got it. */
  target: string;
  /** The SHA-256 of the body of the request, in hex; a request without a body has the hash of no bytes. */
  requestHash: string;
  status: number;
  body: string;
}

/**
 * The text that a signature of the second form covers: one field on each line, and the body of the answer last. No
 * field before the body may hold a line break, or two answers could share a text (the sharp-edges scan of 10 Oct
 * 2026), so a field of another form is a fault of the relay.
 */
export function answerMessage(answer: SignedAnswer): string {
  const { nonce, method, target, requestHash, status, body } = answer;
  const formed =
    !/[\r\n]/.test(method) &&
    !/[\r\n]/.test(target) &&
    /^[0-9a-f]{64}$/.test(requestHash) &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599;
  if (!formed) throw new Error("An answer to sign has a field of the wrong form.");
  return [ANSWER_V2, signedNonce(nonce), method, target, requestHash, String(status), body].join("\n");
}

/**
 * [nonce] as a signature takes it: in the form of the app only. Its form holds no line break and no slash, so a text
 * of the first form never reads as one of the second, and the relay signs nothing over an empty nonce (relay O-004).
 */
function signedNonce(nonce: string): string {
  if (!NONCE_PATTERN.test(nonce)) throw new Error("A nonce to sign does not have the form of the app.");
  return nonce;
}

/** The SHA-256 of the body of a request, in hex. */
export function requestHash(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

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

  /** The signature of the first form, in base64, of [body] for the request with [nonce]. */
  sign(nonce: string, body: string): string {
    return this.#sign(`${signedNonce(nonce)}\n${body}`);
  }

  /** The signature of the second form, in base64, of an answer to its request. */
  signAnswer(answer: SignedAnswer): string {
    return this.#sign(answerMessage(answer));
  }

  /** The signature of [text] as UTF-8: 64 bytes of r and s, in base64. */
  #sign(text: string): string {
    const message = Buffer.from(text, "utf8");
    return sign("sha256", message, { key: this.#key, dsaEncoding: "ieee-p1363" }).toString("base64");
  }
}

/** The nonce of a request: its text when it has the form of the app, otherwise empty, as from an app before 0.3.1. */
export function readNonce(value: string | undefined): string {
  return value !== undefined && NONCE_PATTERN.test(value) ? value : "";
}
