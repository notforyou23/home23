/**
 * GitChannel — polls `git log` and emits a COLLECTED observation per
 * new commit. Crystallizes each commit as a build_event MemoryObject.
 */

'use strict';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execP = promisify(exec);

export class GitChannel extends PollChannel {
  constructor({ repoPath, intervalMs = 60 * 1000, watchBranches = ['main'] }) {
    super({ id: 'build.git', class: ChannelClass.BUILD, intervalMs });
    this.repoPath = repoPath;
    this.watchBranches = watchBranches;
    this._lastSha = null;
  }

  async poll() {
    const fmt = '--pretty=format:%h|%cI|%an|%s';
    const range = this._lastSha ? `${this._lastSha}..HEAD` : '-10';
    let stdout;
    try { ({ stdout } = await execP(`git log ${fmt} ${range}`, { cwd: this.repoPath })); }
    catch { return []; }
    const entries = this._parseLogOutput(stdout);
    if (entries.length) this._lastSha = entries[0].sha;
    return entries;
  }

  _parseLogOutput(stdout) {
    const out = [];
    for (const line of (stdout || '').split('\n')) {
      const parts = line.split('|');
      if (parts.length < 4) continue;
      const [sha, committed_at, author, ...rest] = parts;
      out.push({ sha, committed_at, author, subject: rest.join('|') });
    }
    return out;
  }

  parse(raw) {
    return { payload: raw, sourceRef: `git:${raw.sha}`, producedAt: raw.committed_at };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'git:log',
    });
  }

  crystallize() {
    return { method: 'build_event', type: 'observation', topic: 'git', tags: ['build', 'git', 'commit'] };
  }
}
