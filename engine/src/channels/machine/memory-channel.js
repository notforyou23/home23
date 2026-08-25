/**
 * MemoryChannel — free/total sampler. Crystallizes only when freePct
 * drops below threshold (default: 10%).
 */

'use strict';

import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execFileAsync = promisify(execFile);

function parseMemoryPressure(stdout) {
  const raw = String(stdout || '');
  const freeMatch = /System-wide memory free percentage:\s*([0-9]+(?:\.[0-9]+)?)%/i.exec(raw);
  if (!freeMatch) return null;

  const freePct = Number(freeMatch[1]);
  if (!Number.isFinite(freePct) || freePct < 0 || freePct > 100) return null;

  const totalMatch = /The system has\s+([0-9]+)\s*\(/i.exec(raw);
  const totalBytes = totalMatch ? Number(totalMatch[1]) : null;
  return {
    source: 'memory_pressure -Q',
    freePct,
    totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : null,
  };
}

async function defaultSampleDarwinPressure() {
  try {
    const { stdout } = await execFileAsync('memory_pressure', ['-Q'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 128 * 1024,
    });
    return parseMemoryPressure(stdout);
  } catch {
    return null;
  }
}

export class MemoryChannel extends PollChannel {
  constructor({
    intervalMs = 30 * 1000,
    lowFreePctThreshold = 10,
    id = 'machine.memory',
    platform = os.platform(),
    sampleDarwinPressure = defaultSampleDarwinPressure,
  } = {}) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.lowFreePctThreshold = lowFreePctThreshold;
    this.platform = platform;
    this.sampleDarwinPressure = sampleDarwinPressure;
  }

  async poll() {
    const total = os.totalmem();
    const free = os.freemem();
    const freePct = Math.round((free / total) * 1000) / 10;
    const memoryPressure = this.platform === 'darwin'
      ? await this.sampleDarwinPressure()
      : null;
    return [{
      total,
      free,
      freePct,
      rawTotal: total,
      rawFree: free,
      rawFreePct: freePct,
      ...(memoryPressure ? {
        memoryPressure,
        pressureFreePct: memoryPressure.freePct,
        pressureTotalBytes: memoryPressure.totalBytes,
      } : {}),
      at: new Date().toISOString(),
    }];
  }

  parse(raw) { return { payload: raw, sourceRef: `mem:${raw.at}`, producedAt: raw.at }; }

  verify(parsed) {
    return makeObservation({
      channelId: this.id, sourceRef: parsed.sourceRef, payload: parsed.payload,
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'os:meminfo',
    });
  }

  crystallize(obs) {
    const freePct = obs.payload.pressureFreePct ?? obs.payload.rawFreePct ?? obs.payload.freePct;
    if (freePct == null) return null;
    if (freePct >= this.lowFreePctThreshold) return null;
    return { method: 'sensor_primary', type: 'observation', topic: 'memory', tags: ['machine', 'memory', 'low-free'] };
  }
}

export const _test = { parseMemoryPressure };
