/**
 * MemoryChannel — free/total sampler. Crystallizes only when freePct
 * drops below threshold (default: 10%).
 */

'use strict';

import os from 'node:os';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

export class MemoryChannel extends PollChannel {
  constructor({ intervalMs = 30 * 1000, lowFreePctThreshold = 10, id = 'machine.memory' } = {}) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.lowFreePctThreshold = lowFreePctThreshold;
  }

  async poll() {
    const total = os.totalmem();
    const free = os.freemem();
    const freePct = Math.round((free / total) * 1000) / 10;
    return [{ total, free, freePct, at: new Date().toISOString() }];
  }

  parse(raw) { return { payload: raw, sourceRef: `mem:${raw.at}`, producedAt: raw.at }; }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'os:meminfo',
    });
  }

  crystallize(obs) {
    if (obs.payload.freePct == null) return null;
    if (obs.payload.freePct >= this.lowFreePctThreshold) return null;
    return { method: 'sensor_primary', type: 'observation', topic: 'memory', tags: ['machine', 'memory', 'low-free'] };
  }
}
