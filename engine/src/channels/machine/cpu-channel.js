/**
 * CpuChannel — CPU-capacity sampler. Load average is retained as useful
 * context, but saturation requires contemporaneous utilization and scheduler
 * pressure evidence.
 */

'use strict';

import os from 'node:os';
import { execFile as nodeExecFile } from 'node:child_process';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';

const DEFAULT_SATURATION_RATIO_THRESHOLD = 0.8;
const DEFAULT_BUSY_PCT_THRESHOLD = 80;
const DEFAULT_BUSY_CORE_FRACTION = 0.75;
const PS_TIMEOUT_MS = 2_000;
const PS_MAX_BUFFER_BYTES = 512 * 1024;
const TOP_PROCESS_LIMIT = 8;

function roundPct(value) {
  return Math.round(value * 10) / 10;
}

function cpuTimes(cpus) {
  return cpus.map((cpu) => ({ ...cpu.times }));
}

function utilizationFromDeltas(previous, current, sampleWindowMs) {
  if (!Array.isArray(previous) || previous.length === 0 || previous.length !== current.length) {
    return {
      available: false,
      source: 'os.cpus-delta',
      unavailableReason: 'previous-sample-unavailable',
      sampleWindowMs,
      aggregate: null,
      perCore: [],
    };
  }

  const perCore = [];
  let aggregateIdle = 0;
  let aggregateTotal = 0;

  for (let index = 0; index < current.length; index += 1) {
    const before = previous[index];
    const after = current[index];
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    let totalDelta = 0;
    for (const key of keys) totalDelta += Number(after[key] || 0) - Number(before[key] || 0);
    const idleDelta = Number(after.idle || 0) - Number(before.idle || 0);
    if (!Number.isFinite(totalDelta) || totalDelta <= 0 || idleDelta < 0 || idleDelta > totalDelta) {
      return {
        available: false,
        source: 'os.cpus-delta',
        unavailableReason: 'invalid-counter-delta',
        sampleWindowMs,
        aggregate: null,
        perCore: [],
      };
    }
    aggregateIdle += idleDelta;
    aggregateTotal += totalDelta;
    perCore.push({
      index,
      busyPct: roundPct(((totalDelta - idleDelta) / totalDelta) * 100),
      idlePct: roundPct((idleDelta / totalDelta) * 100),
    });
  }

  return {
    available: true,
    source: 'os.cpus-delta',
    sampleWindowMs,
    aggregate: {
      busyPct: roundPct(((aggregateTotal - aggregateIdle) / aggregateTotal) * 100),
      idlePct: roundPct((aggregateIdle / aggregateTotal) * 100),
    },
    perCore,
  };
}

export function parsePsSnapshot(stdout, cpuCount) {
  const processes = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+([\d.,]+)\s+(.+?)\s*$/);
    if (!match) continue;
    const cpuPct = Number(match[4].replace(',', '.'));
    processes.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      state: match[3],
      cpuPct: Number.isFinite(cpuPct) ? cpuPct : 0,
      command: match[5],
    });
  }

  const runnableProcesses = processes.filter((process) => process.state.startsWith('R')).length;
  const uninterruptibleProcesses = processes.filter((process) => /^[UD]/.test(process.state)).length;
  return {
    scheduler: {
      available: true,
      source: 'ps-process-states',
      runnableProcesses,
      // macOS does not expose a Linux-style run-queue length here. The count
      // of processes observed in R state is the bounded, honest proxy.
      runQueueProxy: runnableProcesses,
      blockedProcesses: uninterruptibleProcesses,
      uninterruptibleProcesses,
      cpuCapacity: cpuCount,
    },
    topCpuProcesses: processes
      .sort((a, b) => b.cpuPct - a.cpuPct || a.pid - b.pid)
      .slice(0, TOP_PROCESS_LIMIT),
  };
}

function execFileBounded(execFileFn, file, args) {
  return new Promise((resolve, reject) => {
    execFileFn(file, args, {
      encoding: 'utf8',
      timeout: PS_TIMEOUT_MS,
      maxBuffer: PS_MAX_BUFFER_BYTES,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function sampleProcesses(execFileFn, cpuCount) {
  try {
    const stdout = await execFileBounded(execFileFn, 'ps', [
      '-axo', 'pid=,ppid=,state=,%cpu=,comm=',
    ]);
    return parsePsSnapshot(stdout, cpuCount);
  } catch (error) {
    return {
      scheduler: {
        available: false,
        source: 'ps-process-states',
        unavailableReason: error?.code || error?.message || 'sample-unavailable',
        runnableProcesses: null,
        runQueueProxy: null,
        blockedProcesses: null,
        uninterruptibleProcesses: null,
        cpuCapacity: cpuCount,
      },
      topCpuProcesses: [],
    };
  }
}

export function createDefaultCpuSampler({
  osModule = os,
  execFileFn = nodeExecFile,
  now = () => Date.now(),
} = {}) {
  let previousTimes = cpuTimes(osModule.cpus());
  let previousAtMs = now();

  return async function defaultSample() {
    const currentCpus = osModule.cpus();
    const sampledAtMs = now();
    const cpuCount = currentCpus.length;
    const processSamplePromise = sampleProcesses(execFileFn, cpuCount);
    const currentTimes = cpuTimes(currentCpus);
    const cpuUtilization = utilizationFromDeltas(
      previousTimes,
      currentTimes,
      Math.max(0, sampledAtMs - previousAtMs),
    );
    previousTimes = currentTimes;
    previousAtMs = sampledAtMs;
    const processSample = await processSamplePromise;

    return {
      loadAvg: osModule.loadavg(),
      cpuCount,
      uptimeSec: osModule.uptime(),
      cpuUtilization,
      scheduler: processSample.scheduler,
      topCpuProcesses: processSample.topCpuProcesses,
      // os.cpus() does not expose an iowait counter on macOS. Do not infer
      // one from idle or load average.
      iowait: null,
      iowaitAvailable: false,
      at: new Date(sampledAtMs).toISOString(),
    };
  };
}

function hasCapacitySaturationEvidence(payload, {
  busyPctThreshold = DEFAULT_BUSY_PCT_THRESHOLD,
  busyCoreFraction = DEFAULT_BUSY_CORE_FRACTION,
} = {}) {
  const cpuCount = Number(payload?.cpuCount);
  const utilization = payload?.cpuUtilization;
  const aggregateBusyPct = Number(utilization?.aggregate?.busyPct);
  const aggregateIdlePct = Number(utilization?.aggregate?.idlePct);
  const perCore = Array.isArray(utilization?.perCore) ? utilization.perCore : [];
  const runnableProcesses = Number(payload?.scheduler?.runnableProcesses);
  const utilizationAvailable = utilization?.available === true;
  const schedulerAvailable = payload?.scheduler?.available === true;

  if (!Number.isFinite(cpuCount) || cpuCount <= 0
    || !utilizationAvailable || !schedulerAvailable
    || !Number.isFinite(aggregateBusyPct) || !Number.isFinite(aggregateIdlePct)
    || perCore.length < cpuCount || !Number.isFinite(runnableProcesses)) return false;

  const busyCores = perCore.filter((core) => Number(core?.busyPct) >= busyPctThreshold).length;
  return aggregateBusyPct >= busyPctThreshold
    && aggregateIdlePct <= (100 - busyPctThreshold)
    && busyCores >= Math.ceil(cpuCount * busyCoreFraction)
    && runnableProcesses > 0;
}

export class CpuChannel extends PollChannel {
  constructor({
    intervalMs = 30 * 1000,
    sample,
    samplerDependencies,
    saturationRatioThreshold,
    spikeThreshold,
    id = 'machine.cpu',
  } = {}) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.sample = sample || createDefaultCpuSampler(samplerDependencies);
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
      flag: 'COLLECTED', confidence: 0.95, producedAt: parsed.producedAt, verifierId: 'os:cpu-capacity',
    });
  }

  crystallize(obs) {
    const payload = obs?.payload;
    const load1 = Number(Array.isArray(payload?.loadAvg) ? payload.loadAvg[0] : Number.NaN);
    const cpuCount = Number(payload?.cpuCount);
    if (!Number.isFinite(load1) || load1 < 0 || !Number.isFinite(cpuCount) || cpuCount <= 0) return null;
    const loadPerCpu = load1 / cpuCount;
    if (loadPerCpu < this.saturationRatioThreshold || !hasCapacitySaturationEvidence(payload)) return null;
    return {
      method: 'sensor_primary',
      type: 'observation',
      topic: 'cpu',
      tags: ['machine', 'cpu', 'load-spike', 'capacity-saturated'],
    };
  }
}
