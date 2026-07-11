#!/usr/bin/env node

import { execFile as execFileCallback, spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  failCli,
  integer,
  isMain,
  one,
  parseCli,
  readJson,
  receiptContext,
  repeated,
  sleep,
  typedError,
  writeJsonReceipt,
} from './lib/brain-acceptance-common.mjs';

const execFile = promisify(execFileCallback);

export function parseTarget(value) {
  if (typeof value !== 'string') throw typedError('target_invalid');
  const split = value.indexOf('=');
  if (split <= 0) throw typedError('target_invalid');
  const name = value.slice(0, split);
  const specification = value.slice(split + 1);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw typedError('target_invalid');
  if (specification.startsWith('pm2:')) {
    const processName = specification.slice(4);
    if (!processName || /[\0\r\n]/.test(processName)) throw typedError('target_invalid');
    return Object.freeze({ name, kind: 'pm2', processName });
  }
  if (specification.startsWith('pid+metrics:')) {
    const match = /^pid\+metrics:(\d+):(.+)$/.exec(specification);
    if (!match || !path.isAbsolute(match[2]) || path.normalize(match[2]) !== match[2]) {
      throw typedError('target_invalid');
    }
    return Object.freeze({ name, kind: 'pid+metrics', pid: Number(match[1]), metricsPath: match[2] });
  }
  throw typedError('target_invalid');
}

function heapFromPm2(row) {
  const metric = row?.pm2_env?.axm_monitor?.['Used Heap Size'];
  const value = Number(metric?.value);
  if (!Number.isFinite(value) || value < 0 || metric?.unit !== 'MiB') {
    throw typedError('heap_metric_unavailable', `V8 heap metric unavailable for ${row?.name || 'process'}`);
  }
  return value;
}

export function createDefaultSampleProvider() {
  const lastMetric = new Map();
  return async function sample(targets, now = Date.now()) {
    let pm2Rows = null;
    if (targets.some((target) => target.kind === 'pm2')) {
      const { stdout } = await execFile('pm2', ['jlist'], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      pm2Rows = JSON.parse(stdout);
      if (!Array.isArray(pm2Rows)) throw typedError('pm2_sample_invalid');
    }
    const output = [];
    for (const target of targets) {
      if (target.kind === 'pm2') {
        const matches = pm2Rows.filter((row) => row?.name === target.processName);
        if (matches.length !== 1) throw typedError(matches.length ? 'pm2_duplicate_process' : 'pm2_process_missing');
        const row = matches[0];
        const heapUsedMiB = heapFromPm2(row);
        const fingerprint = `${row.pid}:${row.pm2_env?.restart_time}:${heapUsedMiB}`;
        const prior = lastMetric.get(target.name);
        const metricUpdatedAt = prior?.fingerprint === fingerprint ? prior.metricUpdatedAt : now;
        lastMetric.set(target.name, { fingerprint, metricUpdatedAt });
        output.push({
          name: target.name,
          pid: Number(row.pid),
          restartCount: Number(row.pm2_env?.restart_time || 0),
          heapUsedMiB,
          metricUpdatedAt,
          observedAt: now,
          metricSource: 'pm2-axm-v8-change-observed',
        });
      } else {
        const document = await readJson(target.metricsPath, { maxBytes: 1024 * 1024 });
        const pid = Number(document.pid);
        const restartCount = Number(document.restartCount || 0);
        const heapUsedMiB = Number(document.heapUsedMiB);
        const metricUpdatedAt = Date.parse(document.updatedAt);
        if (pid !== target.pid || !Number.isSafeInteger(pid) || pid < 1
            || !Number.isSafeInteger(restartCount) || restartCount < 0
            || !Number.isFinite(heapUsedMiB) || heapUsedMiB < 0
            || !Number.isFinite(metricUpdatedAt)) {
          throw typedError('metrics_document_invalid');
        }
        output.push({
          name: target.name, pid, restartCount, heapUsedMiB, metricUpdatedAt,
          observedAt: now, metricSource: 'isolated-metrics-document',
        });
      }
    }
    return output;
  };
}

function assertSampleSet(samples, targets) {
  if (!Array.isArray(samples) || samples.length !== targets.length) throw typedError('sample_invalid');
  const byName = new Map();
  for (const sample of samples) {
    if (!sample || byName.has(sample.name)) throw typedError('sample_invalid');
    byName.set(sample.name, sample);
  }
  if (targets.some((target) => !byName.has(target.name))) throw typedError('sample_invalid');
  return byName;
}

export function summarizeSamples({ targets, baseline, samples, commandStartedAt, maxMetricAgeMs, maxHeapGrowthMiB }) {
  const baselineByName = assertSampleSet(baseline, targets);
  const sampleMaps = samples.map((set) => assertSampleSet(set, targets));
  const summaries = [];
  for (const target of targets) {
    const first = baselineByName.get(target.name);
    const rows = sampleMaps.map((set) => set.get(target.name));
    const inWindow = rows.filter((row) => row.metricUpdatedAt >= commandStartedAt
      && row.observedAt - row.metricUpdatedAt >= 0
      && row.observedAt - row.metricUpdatedAt <= maxMetricAgeMs);
    let priorTimestamp = -Infinity;
    const advancing = inWindow.filter((row) => {
      if (row.metricUpdatedAt <= priorTimestamp) return false;
      priorTimestamp = row.metricUpdatedAt;
      return true;
    });
    const peakHeapMiB = Math.max(first.heapUsedMiB, ...rows.map((row) => row.heapUsedMiB));
    const heapGrowthMiB = peakHeapMiB - first.heapUsedMiB;
    const pidChanged = rows.some((row) => row.pid !== first.pid);
    const restartDelta = Math.max(0, ...rows.map((row) => row.restartCount - first.restartCount));
    const metricFresh = advancing.length >= 2;
    const summary = {
      name: target.name,
      target: target.kind === 'pm2' ? `pm2:${target.processName}` : `pid+metrics:${target.pid}`,
      pid: first.pid,
      baselineHeapMiB: first.heapUsedMiB,
      peakHeapMiB,
      heapGrowthMiB,
      baselineRestartCount: first.restartCount,
      restartDelta,
      pidChanged,
      metricFresh,
      samples: [first, ...rows],
    };
    if (pidChanged) throw typedError('pid_replaced', target.name, { summary });
    if (restartDelta !== 0) throw typedError('process_restarted', target.name, { summary });
    if (!metricFresh) throw typedError('metric_stale', target.name, { summary });
    if (heapGrowthMiB > maxHeapGrowthMiB) throw typedError('heap_growth_exceeded', target.name, { summary });
    summaries.push(summary);
  }
  return summaries;
}

function launchCommand(command, options = {}) {
  if (!Array.isArray(command) || command.length === 0) throw typedError('command_required');
  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    stdio: options.stdio || 'inherit',
    shell: false,
  });
  let running = true;
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      running = false;
      resolve({ code, signal });
    });
  });
  return { child, completed, isRunning: () => running };
}

export async function sampleProcessMemory({
  targets,
  command,
  intervalMs = 250,
  maxMetricAgeMs = 5000,
  maxHeapGrowthMiB = 256,
  sampleProvider = createDefaultSampleProvider(),
  commandLauncher = launchCommand,
  now = Date.now,
} = {}) {
  if (!Array.isArray(targets) || targets.length < 2 || new Set(targets.map((target) => target.name)).size !== targets.length) {
    throw typedError('targets_invalid', 'at least two unique targets are required');
  }
  const baseline = await sampleProvider(targets, now());
  const commandStartedAt = now();
  const launched = commandLauncher(command);
  const samples = [];
  while (launched.isRunning()) {
    await sleep(intervalMs);
    if (!launched.isRunning()) break;
    samples.push(await sampleProvider(targets, now()));
  }
  const commandResult = await launched.completed;
  if (commandResult.code !== 0) {
    throw typedError('sampled_command_failed', `command exited ${commandResult.code ?? commandResult.signal}`, {
      commandResult,
    });
  }
  const commandCompletedAt = now();
  const summaries = summarizeSamples({
    targets, baseline, samples, commandStartedAt, maxMetricAgeMs, maxHeapGrowthMiB,
  });
  return {
    ok: true,
    metric: 'v8-used-heap-mib',
    intervalMs,
    maxMetricAgeMs,
    maxHeapGrowthMiB,
    command,
    commandStartedAt: new Date(commandStartedAt).toISOString(),
    commandCompletedAt: new Date(commandCompletedAt).toISOString(),
    targets: summaries,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values, command } = parseCli(argv);
  const context = await receiptContext(values, env);
  const metric = one(values, 'metric', { defaultValue: 'v8-used-heap-mib' });
  if (metric !== 'v8-used-heap-mib') throw typedError('metric_invalid');
  const targets = repeated(values, 'target').map(parseTarget);
  const result = await sampleProcessMemory({
    targets,
    command,
    intervalMs: integer(values, 'interval-ms', { defaultValue: 250, min: 50, max: 60_000 }),
    maxMetricAgeMs: integer(values, 'max-metric-age-ms', { defaultValue: 5000, min: 100, max: 300_000 }),
    maxHeapGrowthMiB: integer(values, 'max-heap-growth-mib', { defaultValue: 256, min: 1, max: 1_000_000 }),
  });
  return writeJsonReceipt(
    context,
    path.resolve(one(values, 'output', { required: true })),
    { helper: 'sample-process-memory', ...result },
  );
}

if (isMain(import.meta.url)) main().catch(failCli);
