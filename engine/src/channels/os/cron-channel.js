/**
 * CronChannel — polls `crontab -l` and emits an observation when the
 * crontab content hash changes. Skips the initial seeding poll.
 */

'use strict';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execP = promisify(exec);

export class CronChannel extends PollChannel {
  constructor({ intervalMs = 5 * 60 * 1000, id = 'os.cron' } = {}) {
    super({ id, class: ChannelClass.OS, intervalMs });
    this._lastHash = null;
  }

  async poll() {
    let stdout = '';
    try { ({ stdout } = await execP('crontab -l')); } catch { stdout = ''; }
    const hash = createHash('sha1').update(stdout).digest('hex');
    if (this._lastHash === hash) return [];
    const prev = this._lastHash;
    this._lastHash = hash;
    return prev === null ? [] : [{ hash, content: stdout, at: new Date().toISOString() }];
  }

  parse(raw) { return { payload: raw, sourceRef: `cron:${raw.hash}`, producedAt: raw.at }; }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'crontab:list',
    });
  }

  crystallize() {
    return { method: 'work_event', type: 'observation', topic: 'cron-change', tags: ['os', 'cron', 'changed'] };
  }
}
