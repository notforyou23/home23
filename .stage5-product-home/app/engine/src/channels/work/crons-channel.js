/**
 * CronsChannel — polls conversations/cron-jobs.json and emits a fire
 * observation when a job's lastFiredAt advances. Skips the initial
 * seeding poll so startup doesn't flood.
 */

'use strict';

import { readFileSync, existsSync } from 'node:fs';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class CronsChannel extends PollChannel {
  constructor({ path, intervalMs = 60 * 1000, id = 'work.crons' }) {
    super({ id, class: ChannelClass.WORK, intervalMs });
    this.path = path;
    this._seen = new Map();
    this._primed = false;
  }

  async poll() {
    if (!existsSync(this.path)) return [];
    let data;
    try { data = JSON.parse(readFileSync(this.path, 'utf8')); } catch { return []; }
    const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
    const out = [];
    for (const j of jobs) {
      const last = this._seen.get(j.id);
      if (last !== j.lastFiredAt) {
        this._seen.set(j.id, j.lastFiredAt);
        if (this._primed) out.push(j);
      }
    }
    this._primed = true;
    return out;
  }

  parse(raw) {
    return { payload: raw, sourceRef: `cron:${raw.id}:${raw.lastFiredAt}`, producedAt: raw.lastFiredAt || new Date().toISOString() };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'crons:poll',
    });
  }

  crystallize(obs) {
    return { method: 'work_event', type: 'observation', topic: 'cron-fire', tags: ['work', 'cron', obs.payload.id] };
  }
}
