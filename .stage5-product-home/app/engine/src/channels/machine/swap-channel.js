/**
 * SwapChannel — macOS swap/vm_stat sampler.
 *
 * Complements machine.memory with pressure attribution that os.freemem() cannot
 * provide: swap usage, compressor occupancy, and swapin/swapout counters.
 */

'use strict';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const execFileAsync = promisify(execFile);

function parseSwapUsage(stdout) {
  const raw = String(stdout || '').trim();
  const match = /total = ([0-9.]+)M\s+used = ([0-9.]+)M\s+free = ([0-9.]+)M/i.exec(raw);
  if (!match) return { raw };
  const totalMb = Number(match[1]);
  const usedMb = Number(match[2]);
  const freeMb = Number(match[3]);
  return {
    raw,
    totalMb,
    usedMb,
    freeMb,
    usedPct: totalMb > 0 ? +((usedMb / totalMb) * 100).toFixed(1) : null,
  };
}

function parseVmStat(stdout) {
  const raw = String(stdout || '');
  const pageSize = Number(raw.match(/page size of (\d+) bytes/i)?.[1] || 0) || null;
  const get = (label) => {
    const match = raw.match(new RegExp(`${label}:\\s+([0-9.]+)\\.?`, 'i'));
    return match ? Number(match[1]) : null;
  };
  return {
    pageSize,
    pagesFree: get('Pages free'),
    pagesActive: get('Pages active'),
    pagesInactive: get('Pages inactive'),
    pagesWiredDown: get('Pages wired down'),
    pagesOccupiedByCompressor: get('Pages occupied by compressor'),
    swapins: get('Swapins'),
    swapouts: get('Swapouts'),
    pageins: get('Pageins'),
    pageouts: get('Pageouts'),
  };
}

async function defaultSample() {
  const at = new Date().toISOString();
  const [swapResult, vmResult] = await Promise.allSettled([
    execFileAsync('sysctl', ['vm.swapusage'], { encoding: 'utf8', timeout: 5000, maxBuffer: 128 * 1024 }),
    execFileAsync('vm_stat', [], { encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024 }),
  ]);

  const swap = swapResult.status === 'fulfilled'
    ? parseSwapUsage(swapResult.value.stdout)
    : { error: swapResult.reason?.message || String(swapResult.reason) };
  const vm = vmResult.status === 'fulfilled'
    ? parseVmStat(vmResult.value.stdout)
    : { error: vmResult.reason?.message || String(vmResult.reason) };

  return { at, swap, vm };
}

export class SwapChannel extends PollChannel {
  constructor({
    intervalMs = 60 * 1000,
    sample = defaultSample,
    highSwapThresholdPct = 70,
    id = 'machine.swap',
  } = {}) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.sample = sample;
    this.highSwapThresholdPct = highSwapThresholdPct;
  }

  async poll() { return [await this.sample()]; }

  parse(raw) { return { payload: raw, sourceRef: `swap:${raw.at}`, producedAt: raw.at }; }

  verify(parsed) {
    return makeObservation({
      channelId: this.id,
      sourceRef: parsed.sourceRef,
      payload: parsed.payload,
      flag: 'COLLECTED',
      confidence: parsed.payload?.swap?.error ? 0.45 : 0.95,
      producedAt: parsed.producedAt,
      verifierId: 'os:vm-swapusage',
    });
  }

  crystallize(obs) {
    const usedPct = Number(obs.payload?.swap?.usedPct ?? 0);
    if (usedPct < this.highSwapThresholdPct) return null;
    return {
      method: 'sensor_primary',
      type: 'observation',
      topic: 'swap-pressure',
      tags: ['machine', 'swap', 'memory-pressure'],
    };
  }
}

export const _test = { parseSwapUsage, parseVmStat };
