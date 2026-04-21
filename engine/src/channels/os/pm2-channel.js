/**
 * Pm2Channel — polls `pm2 jlist` and emits an observation when a process's
 * status or restart_time changes. Seeds baseline on first poll (no flood).
 */

'use strict';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execP = promisify(exec);

async function defaultList() {
  try {
    const { stdout } = await execP('pm2 jlist');
    return JSON.parse(stdout);
  } catch { return []; }
}

export class Pm2Channel extends PollChannel {
  constructor({ intervalMs = 30 * 1000, listProcesses = defaultList, id = 'os.pm2' } = {}) {
    super({ id, class: ChannelClass.OS, intervalMs });
    this.listProcesses = listProcesses;
    this._seen = new Map();
    this._primed = false;
  }

  async poll() {
    const list = (await this.listProcesses()) || [];
    const out = [];
    for (const p of list) {
      const name = p.name;
      const status = p.pm2_env?.status;
      const restartCount = p.pm2_env?.restart_time ?? 0;
      const prev = this._seen.get(name);
      const changed = !prev || prev.status !== status || prev.restartCount !== restartCount;
      if (changed) {
        this._seen.set(name, { status, restartCount });
        if (this._primed) {
          out.push({ name, status, restartCount, prevStatus: prev?.status, prevRestartCount: prev?.restartCount, at: new Date().toISOString() });
        }
      }
    }
    this._primed = true;
    return out;
  }

  parse(raw) {
    return { payload: raw, sourceRef: `pm2:${raw.name}:${raw.status}:${raw.restartCount}`, producedAt: raw.at };
  }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'pm2:jlist',
    });
  }

  crystallize(obs) {
    return { method: 'work_event', type: 'observation', topic: 'pm2-process', tags: ['os', 'pm2', obs.payload.status] };
  }
}
