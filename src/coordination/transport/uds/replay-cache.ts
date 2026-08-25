export class NonceReplayCache {
  readonly #entries = new Map<string, number>();
  readonly #maxEntries: number;

  constructor(maxEntries = 10_000) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive safe integer");
    }
    this.#maxEntries = maxEntries;
  }

  consume(scope: string, nonce: string, expiresAtMs: number, nowMs = Date.now()): boolean {
    for (const [key, expiry] of this.#entries) {
      if (expiry < nowMs) this.#entries.delete(key);
    }
    const key = `${scope}:${nonce}`;
    if (this.#entries.has(key) || this.#entries.size >= this.#maxEntries) return false;
    this.#entries.set(key, expiresAtMs);
    return true;
  }
}
