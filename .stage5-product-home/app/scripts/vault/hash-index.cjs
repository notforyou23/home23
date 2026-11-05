'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const SHA256_HEX = /^[0-9a-f]{64}$/;

// Throws on unreadable input. LOAD-BEARING: returning a falsy hash instead
// would make every unreadable file share one index key, so N distinct
// documents would look like duplicates of one -- copying 1 and losing N-1.
// Do not wrap this in a try/catch that softens the error.
function hashFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Rejects anything that is not a lowercase sha256 hex digest. Uppercase is
// rejected rather than normalised: the same content under two cases would
// split into two buckets and be copied twice with provenance divided. A hash
// that isn't lowercase hex came from somewhere we don't understand.
function assertHash(hash, fn) {
  if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) {
    throw new TypeError(`HashIndex.${fn}: not a sha256 hex digest: ${JSON.stringify(hash)}`);
  }
}

// Dedup is EXACT content match only (jtr, 2026-07-15). A lightly-edited
// variant is a different document and is kept.
class HashIndex {
  constructor() {
    this._origins = new Map();
  }

  // Records that `originPath` holds this content. Returns { firstSighting }.
  // NAMED FOR ITS SIDE EFFECT: this WRITES. A query verb with a hidden write is
  // how a defensive "just check" call silently forges an origin and flips the
  // answer to duplicate -- which makes the walker skip a real file.
  recordSighting(hash, originPath) {
    assertHash(hash, 'recordSighting');
    if (typeof originPath !== 'string' || originPath === '') {
      throw new TypeError(`HashIndex.recordSighting: origin must be a non-empty path, got ${JSON.stringify(originPath)}`);
    }
    const existing = this._origins.get(hash);
    if (!existing) {
      this._origins.set(hash, [originPath]);
      return { firstSighting: true };
    }
    existing.push(originPath);
    return { firstSighting: false };
  }

  // Read-only. Safe to call anywhere.
  has(hash) {
    assertHash(hash, 'has');
    return this._origins.has(hash);
  }

  // Seed the FULL origin list from a prior run's manifest. recordSighting takes
  // one origin, so seeding through it would silently drop origins[1..n] on every
  // re-run -- destroying provenance the first run correctly captured.
  seed(hash, originPaths) {
    assertHash(hash, 'seed');
    if (!Array.isArray(originPaths) || originPaths.length === 0) {
      throw new TypeError(`HashIndex.seed: originPaths must be a non-empty array, got ${JSON.stringify(originPaths)}`);
    }
    for (const o of originPaths) {
      if (typeof o !== 'string' || o === '') {
        throw new TypeError(`HashIndex.seed: origin must be a non-empty path, got ${JSON.stringify(o)}`);
      }
    }
    this._origins.set(hash, [...originPaths]);
  }

  origins(hash) {
    // Return a copy: provenance is the entire point of this index, so a
    // caller mutating the returned array must never corrupt internal state.
    const existing = this._origins.get(hash);
    return existing ? existing.slice() : [];
  }

  hashes() {
    return Array.from(this._origins.keys());
  }
}

module.exports = { hashFile, HashIndex };
