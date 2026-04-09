/**
 * Session management with pluggable storage.
 *
 * Tracks PGS query state across continuations — which partitions
 * have been searched, what mode was used, etc.
 */

class MemoryStorage {
  constructor() {
    this.store = new Map();
  }

  async read(key) {
    return this.store.get(key) || null;
  }

  async write(key, data) {
    this.store.set(key, data);
  }
}

class SessionManager {
  constructor(storage) {
    this.storage = storage || new MemoryStorage();
  }

  async load(sessionId = 'default') {
    try {
      const data = await this.storage.read(`session:${sessionId}`);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  }

  async save(sessionId = 'default', data) {
    try {
      await this.storage.write(`session:${sessionId}`, JSON.stringify(data));
    } catch (err) {
      // Non-fatal: log but don't throw
    }
  }
}

module.exports = { MemoryStorage, SessionManager };
