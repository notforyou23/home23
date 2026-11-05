/**
 * WorkerRunsChannel polls owner brain worker-runs.jsonl and emits work events
 * when a worker receipt changes. Raw transcripts stay in worker run folders.
 */

import { existsSync, readFileSync } from 'node:fs';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class WorkerRunsChannel extends PollChannel {
  constructor({ path, intervalMs = 30 * 1000, id = 'work.worker-runs' }) {
    super({ id, class: ChannelClass.WORK, intervalMs });
    this.path = path;
    this._seen = new Map();
    this._primed = false;
  }

  async poll() {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    const out = [];
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const key = record.runId;
      if (!key) continue;
      const updatedAt = record.finishedAt || record.updatedAt || record.startedAt || '';
      const stateKey = `${updatedAt}:${record.status || ''}:${record.verifierStatus || ''}`;
      if (this._seen.get(key) !== stateKey) {
        this._seen.set(key, stateKey);
        if (this._primed) out.push(record);
      }
    }
    this._primed = true;
    return out;
  }

  parse(raw) {
    return {
      payload: raw,
      sourceRef: `worker-run:${raw.runId}`,
      producedAt: raw.finishedAt || raw.updatedAt || raw.startedAt || new Date().toISOString(),
    };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id,
      sourceRef: parsed.sourceRef,
      payload: parsed.payload,
      flag: 'COLLECTED',
      confidence: parsed.payload.verifierStatus === 'pass' ? 0.95 : 0.8,
      producedAt: parsed.producedAt,
      verifierId: 'worker-runs:jsonl',
    });
  }

  crystallize(obs) {
    const tags = ['work', 'worker-run'];
    if (obs.payload.worker) tags.push(obs.payload.worker);
    if (obs.payload.status) tags.push(obs.payload.status);
    return { method: 'work_event', type: 'observation', topic: 'worker-run', tags };
  }
}
