'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileDurableSync, fsyncDirectorySync } = require('../utils/durable-write');

/** Local delivery intents survive an unavailable harness. The harness still
 * owns channel delivery/deduplication; these files make no delivery claim. */
class OwnerOutreachOutbox {
  constructor(brainDir, transport, { policy = null } = {}) {
    if (!brainDir) throw new Error('owner outreach durable directory unavailable');
    this.dir = path.join(brainDir, 'owner-outreach-pending');
    this.heldDir = path.join(brainDir, 'owner-outreach-held');
    this.transport = transport;
    this.policy = policy;
    this.inFlight = new Map();
    this.retryCursor = 0;
  }

  async send(request, attentionIntent = null) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${crypto.createHash('sha256').update(request.deliveryId).digest('hex')}.json`);
    if (!fs.existsSync(file)) {
      if (fs.readdirSync(this.dir).length >= 100) throw new Error('owner outreach pending queue full');
      // A promised intent is saved before its attention reservation. Recovery
      // can finish admission after a crash here without losing that intent.
      writeFileDurableSync(file, JSON.stringify({ schema: 'home23.owner-outreach-pending.v2', request, attentionIntent }), { mode: 0o600, strictDirectorySync: true });
    } else {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (JSON.stringify(previous.request) !== JSON.stringify(request)
        || JSON.stringify(previous.attentionIntent || null) !== JSON.stringify(attentionIntent)) throw new Error('owner outreach delivery ID conflicts with pending content');
    }
    return this._deliver(file);
  }

  async retry() {
    if (!fs.existsSync(this.dir)) return [];
    const names = fs.readdirSync(this.dir).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    if (!names.length) return [];
    const start = this.retryCursor % names.length;
    const count = Math.min(3, names.length);
    this.retryCursor = (start + count) % names.length;
    // Round-robin prevents a permanently invalid early request from starving
    // later contact. Independent delivery IDs can retry concurrently.
    return Promise.all(Array.from({ length: count }, (_, i) =>
      this._deliver(path.join(this.dir, names[(start + i) % names.length]))));
  }

  async _deliver(file) {
    if (this.inFlight.has(file)) return this.inFlight.get(file);
    const pending = (async () => {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!['home23.owner-outreach-pending.v1', 'home23.owner-outreach-pending.v2'].includes(entry.schema) || !entry.request?.deliveryId) throw new Error('invalid owner outreach pending record');
      try {
        let attentionDecision = null;
        if (this.policy) {
          attentionDecision = this.policy.reserve(entry.attentionIntent, entry.request);
          if (!attentionDecision.allow) {
            // Keep ungrounded legacy and definitively suppressed content for
            // inspection without allowing it to fill the retry queue. State
            // read/write failures throw instead and remain recoverably pending.
            const held = path.join(this.heldDir, path.basename(file));
            writeFileDurableSync(held, JSON.stringify({ schema: 'home23.owner-outreach-held.v1',
              heldAt: new Date().toISOString(), attentionDecision, entry }), { mode: 0o600, strictDirectorySync: true });
            fs.unlinkSync(file);
            fsyncDirectorySync(this.dir, { strict: true });
            return { status: 'suppressed', deliveryId: entry.request.deliveryId,
              detail: attentionDecision.reason, attentionDecision, durableState: 'held', notification: 'not_confirmed' };
          }
        }
        const result = await this.transport(entry.request);
        if (!['committed', 'queued'].includes(result?.status)) throw new Error('harness did not accept owner outreach');
        // An uncertain completion keeps the original file and delivery ID.
        // The receiving harness supplies delivery idempotency on retry.
        if (this.policy) this.policy.complete(entry.request.deliveryId, result);
        fs.unlinkSync(file);
        fsyncDirectorySync(this.dir, { strict: true });
        return { ...result, deliveryId: entry.request.deliveryId, ...(attentionDecision ? { attentionDecision } : {}) };
      } catch (error) {
        return { status: 'pending', deliveryId: entry.request.deliveryId, transport: 'not_accepted', notification: 'not_confirmed', detail: String(error.message || error).slice(0, 500) };
      }
    })();
    this.inFlight.set(file, pending);
    try { return await pending; } finally { this.inFlight.delete(file); }
  }
}

module.exports = { OwnerOutreachOutbox };
