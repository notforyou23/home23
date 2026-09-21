/**
 * LiveProblemsChannel — polls brain/live-problems.json and emits an
 * observation whenever a problem's lifecycle changes (state, remediation step
 * or escalation). updatedAt moves on every verifier check, so keying on it
 * archived one snapshot per check: 133k records for 1.2k real transitions.
 * Crystallizes each transition as a work_event so the brain sees its own
 * problem lifecycle.
 */

'use strict';

import { readFileSync, existsSync } from 'node:fs';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class LiveProblemsChannel extends PollChannel {
  constructor({ path, intervalMs = 30 * 1000, id = 'work.live-problems' }) {
    super({ id, class: ChannelClass.WORK, intervalMs });
    this.path = path;
    this._seen = new Map();
    this._primed = false;
  }

  async poll() {
    if (!existsSync(this.path)) return [];
    let data;
    try { data = JSON.parse(readFileSync(this.path, 'utf8')); } catch { return []; }
    const problems = Array.isArray(data?.problems) ? data.problems : [];
    const out = [];
    for (const p of problems) {
      const key = p.id || `${p.state}:${p.firstSeenAt}`;
      const lifecycle = JSON.stringify([p.state ?? null, p.stepIndex ?? null, Boolean(p.escalated)]);
      const prev = this._seen.get(key);
      if (prev !== lifecycle) {
        this._seen.set(key, lifecycle);
        if (this._primed) out.push(p);
      }
    }
    this._primed = true;
    return out;
  }

  parse(raw) {
    return {
      payload: raw,
      sourceRef: `live-problem:${raw.id || 'anon'}:${raw.updatedAt || raw.openedAt || raw.firstSeenAt}`,
      producedAt: raw.updatedAt || raw.openedAt || raw.firstSeenAt || new Date().toISOString(),
    };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'live-problems:poll',
    });
  }

  crystallize(obs) {
    const tags = ['work', 'live-problem'];
    if (obs.payload.state) tags.push(obs.payload.state);
    return { method: 'work_event', type: 'observation', topic: 'live-problem', tags };
  }
}
