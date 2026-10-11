/**
 * LiveProblemsChannel — polls brain/live-problems.json and emits an
 * observation whenever a problem's lifecycle changes (state, remediation step
 * or escalation), plus periodic unchanged-state heartbeats. updatedAt moves
 * on every verifier check, so keying on it
 * archived one snapshot per check: 133k records for 1.2k real transitions.
 * Crystallizes each transition as a work_event so the brain sees its own
 * problem lifecycle.
 */

'use strict';

import { readFileSync, existsSync } from 'node:fs';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';
import observationPolicy from '../../../../shared/channel-observation-policy.cjs';

const { normalizeLiveProblemPolicy, shouldWriteLiveProblem, rememberLiveProblem, liveProblemObservedAt } = observationPolicy;

function problemKey(problem) {
  return problem.id || `${problem.state}:${problem.firstSeenAt}`;
}

function lifecycleSignature(problem) {
  return JSON.stringify([problem.state ?? null, problem.stepIndex ?? null, Boolean(problem.escalated)]);
}

export class LiveProblemsChannel extends PollChannel {
  constructor({ path, intervalMs = 30 * 1000, id = 'work.live-problems', heartbeatMs, maxEntries }) {
    super({ id, class: ChannelClass.WORK, intervalMs });
    this.path = path;
    this._seen = new Map();
    this._liveProblemPolicy = normalizeLiveProblemPolicy({
      liveProblemsHeartbeatMs: heartbeatMs,
      liveProblemsMaxEntries: maxEntries,
    });
    this._primed = false;
  }

  async poll() {
    if (!existsSync(this.path)) return [];
    let data;
    try { data = JSON.parse(readFileSync(this.path, 'utf8')); } catch { return []; }
    const problems = Array.isArray(data?.problems) ? data.problems : [];
    const present = new Set(problems.map(problemKey));
    for (const key of this._seen.keys()) {
      if (!present.has(key)) this._seen.delete(key);
    }
    const out = [];
    const now = Date.now();
    for (const p of problems) {
      const key = problemKey(p);
      const lifecycle = lifecycleSignature(p);
      const state = { key, signature: lifecycle };
      if (shouldWriteLiveProblem(this._seen, state, this._liveProblemPolicy, now)) {
        rememberLiveProblem(this._seen, state, this._liveProblemPolicy, now);
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
    const observation = makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'live-problems:poll',
    });
    const seen = this._seen.get(problemKey(parsed.payload));
    if (seen?.signature === lifecycleSignature(parsed.payload)) {
      seen.persistedAt = liveProblemObservedAt(observation);
    }
    return observation;
  }

  crystallize(obs) {
    const tags = ['work', 'live-problem'];
    if (obs.payload.state) tags.push(obs.payload.state);
    return { method: 'work_event', type: 'observation', topic: 'live-problem', tags };
  }
}
