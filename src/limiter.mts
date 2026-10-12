// A token bucket that keeps the calls of the relay to an exchanger below the budget of its key, for all users together.
// nginx limits each client; this limit holds when many clients call at once.

export class CallLimiter {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;
  #tokens: number;
  #updatedAt: number;

  /** Allows [calls] calls in a window of [windowMs] (a second by default), and a burst of as many after a quiet window. */
  constructor(calls: number, now: () => number = Date.now, windowMs = 1000) {
    if (!Number.isFinite(calls) || calls < 1) {
      throw new Error("The calls of the limiter must be a number of one or more.");
    }
    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new Error("The window of the limiter must be a number of milliseconds above zero.");
    }
    this.#capacity = calls;
    this.#refillPerMs = calls / windowMs;
    this.#now = now;
    this.#tokens = calls;
    this.#updatedAt = now();
  }

  /** Takes one call from the budget. Returns false when the budget of this moment is spent. */
  take(): boolean {
    const now = this.#now();
    this.#tokens = Math.min(this.#capacity, this.#tokens + (now - this.#updatedAt) * this.#refillPerMs);
    this.#updatedAt = now;
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }
}
