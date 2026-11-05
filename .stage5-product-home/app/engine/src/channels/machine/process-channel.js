/**
 * ProcessChannel — top process CPU sampler.
 *
 * Complements machine.cpu loadavg telemetry with attribution: when the host is
 * contended, this channel records the highest CPU consumers so repair policies
 * can distinguish "load exists" from "which process caused it".
 */

'use strict';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PollChannel } from '../base/poll-channel.js';
import { ChannelClass, makeObservation } from '../contract.js';
import topology from '../../system/home23-process-topology.js';

const execFileAsync = promisify(execFile);
const { annotateHome23ProcessList } = topology;

function normalizePm2RestartCount(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function parsePsRows(stdout) {
  return String(stdout || '')
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+(\d+)\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
      if (!match) return null;
      const [, pid, ppid, cpuPct, memPct, rssKb, elapsed, command] = match;
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        cpuPct: Number(cpuPct),
        memPct: Number(memPct),
        rssBytes: Number(rssKb) * 1024,
        elapsed,
        command,
      };
    })
    .filter((p) => p && Number.isFinite(p.pid) && Number.isFinite(p.cpuPct));
}

function parsePsOutput(stdout, topN) {
  return parsePsRows(stdout)
    .sort((a, b) => b.cpuPct - a.cpuPct)
    .slice(0, topN);
}

async function defaultSample({ topN = 15 } = {}) {
  const at = new Date().toISOString();
  const { stdout } = await execFileAsync('ps', [
    '-axo',
    'pid=,ppid=,pcpu=,pmem=,rss=,etime=,command=',
    '-r',
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024 });

  const rows = parsePsRows(stdout);
  const pm2ByPid = await readPm2ByPid();
  const enrich = (process) => ({
    ...process,
    ...(pm2ByPid.get(process.pid) || {}),
  });
  const processes = annotateHome23ProcessList(rows
    .slice()
    .sort((a, b) => b.cpuPct - a.cpuPct)
    .slice(0, topN)
    .map(enrich));
  const memoryProcesses = annotateHome23ProcessList(rows
    .slice()
    .sort((a, b) => b.rssBytes - a.rssBytes)
    .slice(0, topN)
    .map(enrich));
  return {
    at,
    topN,
    processCount: processes.length,
    topCpuPct: processes[0]?.cpuPct ?? 0,
    totalCpuPctTopN: +processes.reduce((sum, p) => sum + (p.cpuPct || 0), 0).toFixed(1),
    topRssBytes: memoryProcesses[0]?.rssBytes ?? 0,
    totalRssBytesTopN: memoryProcesses.reduce((sum, p) => sum + (p.rssBytes || 0), 0),
    processes,
    memoryProcesses,
  };
}

async function readPm2ByPid() {
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const list = JSON.parse(stdout);
    const byPid = new Map();
    for (const proc of Array.isArray(list) ? list : []) {
      const pid = Number(proc.pid || 0);
      if (!pid) continue;
      byPid.set(pid, {
        pm2Name: proc.name || null,
        pm2Status: proc.pm2_env?.status || null,
        restarts: normalizePm2RestartCount(proc.pm2_env?.restart_time),
        pm2CpuPct: Number(proc.monit?.cpu || 0),
        pm2RssBytes: Number(proc.monit?.memory || 0) || null,
        script: proc.pm2_env?.pm_exec_path || null,
      });
    }
    return byPid;
  } catch {
    return new Map();
  }
}

export class ProcessChannel extends PollChannel {
  constructor({
    intervalMs = 60 * 1000,
    sample = defaultSample,
    topN = 15,
    hotProcessThreshold = 50,
    id = 'machine.process',
  } = {}) {
    super({ id, class: ChannelClass.MACHINE, intervalMs });
    this.sample = sample;
    this.topN = topN;
    this.hotProcessThreshold = hotProcessThreshold;
  }

  async poll() {
    const sample = await this.sample({ topN: this.topN });
    return [{
      ...sample,
      processes: annotateHome23ProcessList(sample?.processes || []),
      memoryProcesses: annotateHome23ProcessList(sample?.memoryProcesses || []),
    }];
  }

  parse(raw) { return { payload: raw, sourceRef: `process:${raw.at}`, producedAt: raw.at }; }

  verify(parsed) {
    return makeObservation({
      channelId: this.id,
      sourceRef: parsed.sourceRef,
      payload: parsed.payload,
      flag: 'COLLECTED',
      confidence: 0.95,
      producedAt: parsed.producedAt,
      verifierId: 'os:ps-top-cpu',
    });
  }

  crystallize(obs) {
    const topCpuPct = Number(obs.payload?.topCpuPct || 0);
    if (topCpuPct < this.hotProcessThreshold) return null;
    return {
      method: 'sensor_primary',
      type: 'observation',
      topic: 'process-cpu',
      tags: ['machine', 'process', 'cpu', 'top-consumer'],
    };
  }
}

export const _test = { parsePsOutput, parsePsRows, readPm2ByPid, normalizePm2RestartCount };
