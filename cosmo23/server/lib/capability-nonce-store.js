'use strict';

function nonceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

class CapabilityNonceStore {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.maxEntries = Number.isSafeInteger(options.maxEntries) && options.maxEntries > 0
      ? options.maxEntries
      : 100_000;
    this.entries = new Map();
  }

  consume(record) {
    const now = this.now();
    if (!Number.isFinite(now)
        || !record || typeof record !== 'object' || Array.isArray(record)
        || typeof record.nonce !== 'string' || !record.nonce.trim()
        || typeof record.operationId !== 'string' || !record.operationId.trim()
        || !Number.isFinite(record.expiresAt)) {
      throw nonceError('capability_invalid');
    }
    if (record.expiresAt <= now) throw nonceError('capability_expired');

    for (const [nonce, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(nonce);
    }
    if (this.entries.has(record.nonce)) throw nonceError('capability_replay');
    if (this.entries.size >= this.maxEntries) throw nonceError('capability_nonce_capacity');
    this.entries.set(record.nonce, {
      operationId: record.operationId,
      expiresAt: record.expiresAt,
    });
    return true;
  }
}

module.exports = { CapabilityNonceStore };
