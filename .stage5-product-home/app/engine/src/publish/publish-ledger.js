/**
 * PublishLedger — tracks publication cadence per target + detects
 * starvation (targets that haven't published within their floor).
 */

'use strict';

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class PublishLedger {
  constructor({ path, starvationFloor = {} }) {
    if (!path) throw new Error('PublishLedger requires path');
    this.path = path;
    this.starvationFloor = starvationFloor;
    this._entries = this._load();
  }

  _load() {
    if (!existsSync(this.path)) return [];
    try {
      return readFileSync(this.path, 'utf8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    } catch { return []; }
  }

  async record({ target, artifact, at = Date.now() }) {
    try { mkdirSync(dirname(this.path), { recursive: true }); } catch {}
    const row = { target, artifact, at };
    this._entries.push(row);
    appendFileSync(this.path, JSON.stringify(row) + '\n');
  }

  lastAt(target) {
    for (let i = this._entries.length - 1; i >= 0; i -= 1) {
      if (this._entries[i].target === target) return this._entries[i].at;
    }
    return null;
  }

  listStarving({ now = Date.now() } = {}) {
    const starving = [];
    for (const [target, maxQuietMs] of Object.entries(this.starvationFloor)) {
      const last = this.lastAt(target);
      // A missing receipt is not starvation yet: a fresh process may not have
      // reached this publisher's first eligible cadence. Only measure quiet
      // time after the target has published at least once; otherwise a restart
      // turns normal startup latency into a false alarm.
      if (last !== null && (now - last) > maxQuietMs) starving.push(target);
    }
    return starving;
  }
}

export function parseStarvationFloor(config = {}, { activeTargets = null } = {}) {
  const out = {};
  const active = activeTargets ? new Set(activeTargets) : null;
  for (const [target, value] of Object.entries(config || {})) {
    if (active && !active.has(target)) continue;
    const match = /^(\d+)\s*(s|m|h|d)$/i.exec(String(value).trim());
    if (!match) continue;
    out[target] = parseInt(match[1], 10) * {
      s: 1000,
      m: 60_000,
      h: 3600_000,
      d: 86400_000,
    }[match[2].toLowerCase()];
  }
  return out;
}

export function publishTargetsForCognitionMode(cognitionMode) {
  // Workspace/dream publishers are wired through ThinkingMachine cycle hooks.
  // In legacy_roles mode they can exist as objects, but they will not receive
  // cycle events, so treating them as starvation targets creates false alarms.
  return cognitionMode === 'thinking_machine' ? ['workspace_insights', 'dream_log'] : [];
}
