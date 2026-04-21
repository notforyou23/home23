/**
 * CpuChannel — loadavg sampler. Crystallizes only on spikes
 * (load1 >= threshold) to avoid flooding with routine samples.
 */

'use strict';

import os from 'node:os';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

async function defaultSample() {
  return {
    loadAvg: os.loadavg(),
    cpuCount: os.cpus().length,
    uptimeSec: os.uptime(),
    at: new Date().toISOString(),
  };
}

export class CpuChannel extends PollChannel {
  constructor({ intervalMs = 30 * 1000, sample = defaultSample, spikeThreshold = 2.0, id = 'machine.cpu' } = {}) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.sample = sample;
    this.spikeThreshold = spikeThreshold;
  }

  async poll() { return [await this.sample()]; }

  parse(raw) { return { payload: raw, sourceRef: `cpu:${raw.at}`, producedAt: raw.at }; }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'os:loadavg',
    });
  }

  crystallize(obs) {
    const load1 = Array.isArray(obs.payload.loadAvg) ? obs.payload.loadAvg[0] : null;
    if (load1 == null || load1 < this.spikeThreshold) return null;
    return { method: 'sensor_primary', type: 'observation', topic: 'cpu', tags: ['machine', 'cpu', 'load-spike'] };
  }
}
