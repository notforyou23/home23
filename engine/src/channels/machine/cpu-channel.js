/**
 * CpuChannel — loadavg sampler. Crystallizes only when normalized load
 * (load1 / cpuCount) reaches the saturation threshold.
 */

'use strict';

import os from 'node:os';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const DEFAULT_SATURATION_RATIO_THRESHOLD = 0.8;

async function defaultSample() {
  return {
    loadAvg: os.loadavg(),
    cpuCount: os.cpus().length,
    uptimeSec: os.uptime(),
    at: new Date().toISOString(),
  };
}

export class CpuChannel extends PollChannel {
  constructor({
    intervalMs = 30 * 1000,
    sample = defaultSample,
    saturationRatioThreshold,
    spikeThreshold,
    id = 'machine.cpu',
  } = {}) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.sample = sample;
    const configuredThreshold = saturationRatioThreshold ?? spikeThreshold;
    const numericThreshold = Number(configuredThreshold);
    this.saturationRatioThreshold = configuredThreshold == null
      || !Number.isFinite(numericThreshold)
      || numericThreshold < 0
      ? DEFAULT_SATURATION_RATIO_THRESHOLD
      : numericThreshold;
    // Deprecated compatibility alias; thresholds are normalized ratios.
    this.spikeThreshold = this.saturationRatioThreshold;
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
    const load1 = Number(Array.isArray(obs?.payload?.loadAvg) ? obs.payload.loadAvg[0] : Number.NaN);
    const cpuCount = Number(obs?.payload?.cpuCount);
    if (!Number.isFinite(load1) || load1 < 0 || !Number.isFinite(cpuCount) || cpuCount <= 0) return null;
    const loadPerCpu = load1 / cpuCount;
    if (loadPerCpu < this.saturationRatioThreshold) return null;
    return { method: 'sensor_primary', type: 'observation', topic: 'cpu', tags: ['machine', 'cpu', 'load-spike'] };
  }
}
