// A token bucket that keeps the calls of the relay to ChangeNOW below the budget of its key, for all users together.
// nginx limits each client; this limit holds when many clients call at once.

export class CallLimiter {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: () => number;
  #tokens: number;
  #updatedAt: number;

  /** Allows [callsPerSecond] calls in a second, and a burst of as many when the relay was quiet. */
  constructor(callsPerSecond: number, now: () => number = Date.now) {
    if (!Number.isFinite(callsPerSecond) || callsPerSecond <= 0) {
      throw new Error("The calls per second of the limiter must be a number above zero.");
    }
    this.#capacity = callsPerSecond;
    this.#refillPerMs = callsPerSecond / 1000;
    this.#now = now;
    this.#tokens = callsPerSecond;
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
