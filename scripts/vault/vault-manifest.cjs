'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TYPES } = require('./vault-paths.cjs');

const MANIFEST_SCHEMA = 'home23.vault-manifest.v1';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TYPE_SET = new Set(TYPES);

// This manifest is the ONLY record of where ~39,000 documents came from.
// Task 5 seeds HashIndex straight from it (`index.seed(entry.sha256,
// entry.origins)`), and seed() throws on anything that isn't a real digest --
// so a corrupt entry written here doesn't fail here, it fails later, in a
// different module, mid-run, far from its cause. Validate everything now.
class VaultManifest {
  constructor(manifestPath) {
    this.path = manifestPath;
    this.entries = {};
    if (fs.existsSync(manifestPath)) {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      // A manifest from a different/older schema, or a hand-edited one, must
      // not load silently -- Task 5 seeds provenance from this file, and a
      // shape mismatch there is exactly the kind of quiet corruption this
      // project exists to stop.
      if (raw.schema !== MANIFEST_SCHEMA) {
        throw new Error(
          `VaultManifest: refusing to load ${manifestPath} -- schema is ` +
          `${JSON.stringify(raw.schema)}, expected ${JSON.stringify(MANIFEST_SCHEMA)}. ` +
          `Loading a manifest under a different schema without a migration ` +
          `would seed provenance from data this code was never checked against.`
        );
      }
      this.entries = raw.entries || {};
    }
  }

  // Records that `vaultPath` holds this content, with every origin it came
  // from. Loud, specific validation on every field: a bad value written here
  // becomes a silent-loss bug somewhere else.
  record({ vaultPath, sha256, type, origins, bytes }) {
    if (typeof vaultPath !== 'string' || vaultPath === '') {
      throw new TypeError(`VaultManifest.record: vaultPath must be a non-empty string, got ${JSON.stringify(vaultPath)}`);
    }
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw new TypeError(`VaultManifest.record(${vaultPath}): sha256 must be a lowercase sha256 hex digest, got ${JSON.stringify(sha256)}`);
    }
    if (!TYPE_SET.has(type)) {
      throw new TypeError(`VaultManifest.record(${vaultPath}): type must be one of ${TYPES.join(', ')}, got ${JSON.stringify(type)}`);
    }
    if (!Array.isArray(origins) || origins.length === 0) {
      throw new TypeError(`VaultManifest.record(${vaultPath}): origins must be a non-empty array, got ${JSON.stringify(origins)}`);
    }
    for (const o of origins) {
      if (typeof o !== 'string' || o === '') {
        throw new TypeError(`VaultManifest.record(${vaultPath}): every origin must be a non-empty string, got ${JSON.stringify(o)}`);
      }
    }
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new TypeError(`VaultManifest.record(${vaultPath}): bytes must be a non-negative integer, got ${JSON.stringify(bytes)}`);
    }

    const existing = this.entries[vaultPath];
    if (existing) {
      // Same vaultPath, different content: two distinct files were routed to
      // one vault slot. Keeping the first and dropping the second silently
      // would be exactly the class of loss this project exists to end.
      if (existing.sha256 !== sha256) {
        throw new Error(
          `VaultManifest.record: collision at vaultPath ${JSON.stringify(vaultPath)} -- ` +
          `already recorded with sha256 ${existing.sha256} (origins: ${existing.origins.join(', ')}), ` +
          `now given a different content sha256 ${sha256} (origin: ${origins.join(', ')}). ` +
          `Two different contents cannot share one vault path.`
        );
      }
      if (existing.type !== type) {
        throw new Error(
          `VaultManifest.record: type mismatch at vaultPath ${JSON.stringify(vaultPath)} -- ` +
          `already recorded as type ${JSON.stringify(existing.type)}, now given ${JSON.stringify(type)}. ` +
          `Same content, same vault path, disagreeing classification means the router is broken.`
        );
      }
      for (const o of origins) {
        if (!existing.origins.includes(o)) existing.origins.push(o);
      }
      return this.get(vaultPath);
    }

    this.entries[vaultPath] = {
      sha256,
      type,
      origins: [...origins],
      bytes,
      consolidatedAt: new Date().toISOString(),
    };
    return this.get(vaultPath);
  }

  // Returns a defensive copy. HashIndex.origins() had exactly this bug: a
  // caller mutating the returned object must never corrupt internal state.
  get(vaultPath) {
    const e = this.entries[vaultPath];
    if (!e) return undefined;
    return { ...e, origins: e.origins.slice() };
  }

  // Write-temp-then-rename. This file is the only record of provenance for
  // ~39,000 documents; a crash or full disk mid-write must never leave a
  // truncated manifest on top of a good one. rename() is atomic on the same
  // filesystem, so a failure here leaves the prior manifest untouched.
  save() {
    const dir = path.dirname(this.path);
    fs.mkdirSync(dir, { recursive: true });
    const body = { schema: MANIFEST_SCHEMA, savedAt: new Date().toISOString(), entries: this.entries };
    const tmpPath = path.join(dir, `.${path.basename(this.path)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
    fs.writeFileSync(tmpPath, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
    try {
      fs.renameSync(tmpPath, this.path);
    } catch (err) {
      fs.rmSync(tmpPath, { force: true });
      throw err;
    }
  }
}

module.exports = { VaultManifest, MANIFEST_SCHEMA };
