/**
 * DiskChannel — df-based mount monitor. Crystallizes only when usagePct
 * exceeds threshold (default: 85%).
 */

'use strict';

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execP = promisify(exec);

export class DiskChannel extends PollChannel {
  constructor({ intervalMs = 5 * 60 * 1000, highUsagePctThreshold = 85, mount = '/', id = 'machine.disk' } = {}) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.highUsagePctThreshold = highUsagePctThreshold;
    this.mount = mount;
  }

  async poll() {
    try {
      const { stdout } = await execP(`df -kP ${this.mount}`);
      const parts = stdout.trim().split('\n').slice(-1)[0].split(/\s+/);
      const usagePct = parseInt(parts[4], 10);
      if (Number.isNaN(usagePct)) return [];
      return [{ mount: this.mount, usagePct, at: new Date().toISOString() }];
    } catch { return []; }
  }

  parse(raw) { return { payload: raw, sourceRef: `disk:${raw.mount}:${raw.at}`, producedAt: raw.at }; }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'df:posix',
    });
  }

  crystallize(obs) {
    if (obs.payload.usagePct < this.highUsagePctThreshold) return null;
    return { method: 'sensor_primary', type: 'observation', topic: 'disk', tags: ['machine', 'disk', 'high-usage'] };
  }
}
