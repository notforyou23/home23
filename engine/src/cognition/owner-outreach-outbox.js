'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeFileDurableSync } = require('../utils/durable-write');

/** Local delivery intents survive an unavailable harness. The harness still
 * owns channel delivery/deduplication; these files make no delivery claim. */
class OwnerOutreachOutbox {
  constructor(brainDir, transport) {
    if (!brainDir) throw new Error('owner outreach durable directory unavailable');
    this.dir = path.join(brainDir, 'owner-outreach-pending');
    this.transport = transport;
    this.inFlight = new Map();
    this.retryCursor = 0;
  }

  async send(request) {
    fs.mkdirSync(this.dir, { recursive: true });
    const file = path.join(this.dir, `${crypto.createHash('sha256').update(request.deliveryId).digest('hex')}.json`);
    if (!fs.existsSync(file)) {
      if (fs.readdirSync(this.dir).length >= 100) throw new Error('owner outreach pending queue full');
      writeFileDurableSync(file, JSON.stringify({ schema: 'home23.owner-outreach-pending.v1', request }));
    } else {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw new Error('owner outreach delivery ID conflicts with pending content');
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
      if (entry.schema !== 'home23.owner-outreach-pending.v1' || !entry.request?.deliveryId) throw new Error('invalid owner outreach pending record');
      try {
        const result = await this.transport(entry.request);
        if (!['committed', 'queued'].includes(result?.status)) throw new Error('harness did not accept owner outreach');
        fs.unlinkSync(file);
        return { ...result, deliveryId: entry.request.deliveryId };
      } catch (error) {
        return { status: 'pending', deliveryId: entry.request.deliveryId, transport: 'not_accepted', notification: 'not_confirmed', detail: String(error.message || error).slice(0, 500) };
      }
    })();
    this.inFlight.set(file, pending);
    try { return await pending; } finally { this.inFlight.delete(file); }
  }
}

module.exports = { OwnerOutreachOutbox };
