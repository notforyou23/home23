/**
 * MemoryChannel — free/total sampler. Crystallizes only when freePct
 * drops below threshold (default: 10%).
 */

'use strict';

import os from 'node:os';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execFileAsync = promisify(execFile);
const DARWIN_PRESSURE_METRIC = 'system-wide-memory-free-percentage';
const DARWIN_PRESSURE_SOURCE = 'memory_pressure -Q';

function percentage(part, total) {
  return Math.round((part / total) * 1000) / 10;
}

function parseLinuxMeminfo(input) {
  const raw = String(input || '');
  const availableMatch = /^MemAvailable:\s*([0-9]+)\s+kB\s*$/m.exec(raw);
  if (!availableMatch) return null;

  const availableBytes = Number(availableMatch[1]) * 1024;
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) return null;

  return {
    source: '/proc/meminfo:MemAvailable',
    availableBytes,
  };
}

function defaultSampleRawMemory() {
  return { total: os.totalmem(), free: os.freemem() };
}

function defaultReadLinuxMeminfo() {
  return readFile('/proc/meminfo', 'utf8');
}

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
    sampleRawMemory = defaultSampleRawMemory,
    readLinuxMeminfo = defaultReadLinuxMeminfo,
    sampleDarwinPressure = defaultSampleDarwinPressure,
  } = {}) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.lowFreePctThreshold = lowFreePctThreshold;
    this.platform = platform;
    this.sampleRawMemory = sampleRawMemory;
    this.readLinuxMeminfo = readLinuxMeminfo;
    this.sampleDarwinPressure = sampleDarwinPressure;
  }

  async poll() {
    const { total: rawTotal, free: rawFree } = await this.sampleRawMemory();
    const rawFreePct = percentage(rawFree, rawTotal);
    let linuxAvailable = null;
    if (this.platform === 'linux') {
      try {
        linuxAvailable = parseLinuxMeminfo(await this.readLinuxMeminfo());
      } catch {
        linuxAvailable = null;
      }
    }

    const useLinuxAvailable = linuxAvailable != null
      && Number.isFinite(rawTotal)
      && rawTotal > 0
      && linuxAvailable.availableBytes <= rawTotal;
    const total = rawTotal;
    const free = useLinuxAvailable ? linuxAvailable.availableBytes : rawFree;
    const freePct = percentage(free, total);
    const sampledDarwinPressure = this.platform === 'darwin'
      ? await this.sampleDarwinPressure()
      : null;
    const memoryPressure = this.platform === 'darwin'
      ? (sampledDarwinPressure ? {
        ...sampledDarwinPressure,
        metric: DARWIN_PRESSURE_METRIC,
        source: sampledDarwinPressure.source || DARWIN_PRESSURE_SOURCE,
        available: true,
      } : {
        metric: DARWIN_PRESSURE_METRIC,
        source: DARWIN_PRESSURE_SOURCE,
        available: false,
        unavailableReason: 'sample-unavailable',
      })
      : (useLinuxAvailable ? {
        source: linuxAvailable.source,
        freePct,
        freeBytes: free,
        totalBytes: total,
      } : null);
    return [{
      total,
      free,
      freePct,
      rawTotal,
      rawFree,
      rawFreePct,
      ...(memoryPressure ? {
        memoryPressure,
        ...(memoryPressure.available !== false ? {
          pressureFreePct: memoryPressure.freePct,
          pressureTotalBytes: memoryPressure.totalBytes,
        } : {}),
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
    const freePct = this.platform === 'darwin'
      ? (obs.payload.pressureFreePct ?? obs.payload.memoryPressure?.freePct)
      : (obs.payload.pressureFreePct ?? obs.payload.rawFreePct ?? obs.payload.freePct);
    if (freePct == null) return null;
    if (freePct >= this.lowFreePctThreshold) return null;
    return { method: 'sensor_primary', type: 'observation', topic: 'memory', tags: ['machine', 'memory', 'low-free'] };
  }
}

export const _test = { parseLinuxMeminfo, parseMemoryPressure };
