'use strict';

/**
 * Ecology journal — append-only, hash-chained record of the research run's
 * cognitive transitions (questions, expeditions, decisions, sleep, promotion,
 * settle). Chaos is durably journaled; authority happens at promotion.
 *
 * This is the run's process journal, not the Brain. Nothing here is canonical
 * knowledge; promoted cognition goes through the promotion gate.
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const GENESIS_HASH = 'ecology-genesis';

function entryHash(prevHash, payload) {
  return crypto.createHash('sha256')
    .update(String(prevHash))
    .update(JSON.stringify(payload))
    .digest('hex');
}

class EcologyJournal {
  constructor(runtimePath, logger = console) {
    this.dir = path.join(runtimePath, 'ecology');
    this.file = path.join(this.dir, 'journal.jsonl');
    this.logger = logger;
    this.seq = 0;
    this.tailHash = GENESIS_HASH;
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return;
    await fsp.mkdir(this.dir, { recursive: true });
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]);
        this.seq = Number(last.seq) || lines.length;
        this.tailHash = last.hash || GENESIS_HASH;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        this.logger?.warn?.('Ecology journal unreadable — starting a fresh chain segment', {
          error: err.message
        });
      }
    }
    this._loaded = true;
  }

  async append(type, data = {}) {
    await this.load();
    this.seq += 1;
    const payload = { seq: this.seq, at: Date.now(), type, data };
    const hash = entryHash(this.tailHash, payload);
    const entry = { ...payload, prevHash: this.tailHash, hash };
    await fsp.appendFile(this.file, `${JSON.stringify(entry)}\n`);
    this.tailHash = hash;
    return entry;
  }

  appendSync(type, data = {}) {
    // Used only on shutdown paths where awaiting is unsafe.
    this.seq += 1;
    const payload = { seq: this.seq, at: Date.now(), type, data };
    const hash = entryHash(this.tailHash, payload);
    const entry = { ...payload, prevHash: this.tailHash, hash };
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
      this.tailHash = hash;
    } catch { /* journal loss is logged by callers; never throws on shutdown */ }
    return entry;
  }

  async readAll() {
    await this.load();
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      return raw.trim().split('\n').filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
    } catch {
      return [];
    }
  }
}

module.exports = { EcologyJournal, GENESIS_HASH, entryHash };
