/**
 * GhChannel — polls `gh pr list` and emits an observation when a PR's
 * updatedAt changes. Crystallizes PR state changes as build_event.
 */

'use strict';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execP = promisify(exec);

export class GhChannel extends PollChannel {
  constructor({ intervalMs = 5 * 60 * 1000, repo } = {}) {
    super({ id: 'build.gh', class: ChannelClass.BUILD, intervalMs });
    this.repo = repo || null;
    this._seen = new Map();
  }

  async poll() {
    let stdout;
    try {
      const cmd = 'gh pr list --json number,title,state,updatedAt,author' + (this.repo ? ` --repo ${this.repo}` : '');
      ({ stdout } = await execP(cmd));
    } catch { return []; }
    const items = this._parsePrList(stdout);
    const out = [];
    for (const it of items) {
      const last = this._seen.get(it.number);
      if (last !== it.updatedAt) {
        this._seen.set(it.number, it.updatedAt);
        if (last !== undefined) out.push(it); // skip first-seen so we don't flood on startup
      }
    }
    return out;
  }

  _parsePrList(stdout) {
    try { return JSON.parse(stdout); } catch { return []; }
  }

  parse(raw) {
    return { payload: raw, sourceRef: `gh:pr:${raw.number}:${raw.updatedAt}`, producedAt: raw.updatedAt };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.9, producedAt: parsed.producedAt, verifierId: 'gh:pr-list',
    });
  }

  crystallize(obs) {
    return { method: 'build_event', type: 'observation', topic: 'pr', tags: ['build', 'gh', 'pr', obs.payload.state] };
  }
}
