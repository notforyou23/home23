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

const RUNTIME_METRICS_ENDPOINTS = Object.freeze({
  'home23-jerry-dash': 'http://127.0.0.1:5002/home23/api/internal/runtime-metrics',
  'home23-forrest-dash': 'http://127.0.0.1:5012/home23/api/internal/runtime-metrics',
  'home23-cosmo23': 'http://127.0.0.1:43210/api/internal/runtime-metrics',
});

export function runtimeMetricsUrlForProcess(processName) {
  const endpoint = RUNTIME_METRICS_ENDPOINTS[processName];
  if (!endpoint) throw typedError('runtime_metrics_target_unsupported', processName);
  return endpoint;
}

async function defaultListPm2Processes() {
  const { stdout } = await execFile('pm2', ['jlist'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const rows = JSON.parse(stdout);
  if (!Array.isArray(rows)) throw typedError('pm2_sample_invalid');
  return rows;
}

async function readRuntimeMetrics(target, row, fetchImpl, observedAt) {
  const endpoint = runtimeMetricsUrlForProcess(target.processName);
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw typedError('runtime_metrics_unavailable', target.processName, { cause: error });
  }
  const document = await response.json().catch((error) => {
    throw typedError('runtime_metrics_invalid', target.processName, { cause: error });
  });
  const pid = Number(document?.pid);
  const heapUsedBytes = Number(document?.heapUsedBytes);
  const metricUpdatedAt = Date.parse(document?.sampledAt);
  const expectedRole = target.processName === 'home23-cosmo23' ? 'cosmo' : 'dashboard';
  if (!response.ok || document?.schemaVersion !== 1 || document?.role !== expectedRole
      || pid !== Number(row.pid) || !Number.isSafeInteger(pid) || pid < 1
      || !Number.isSafeInteger(heapUsedBytes) || heapUsedBytes < 0
      || !Number.isFinite(metricUpdatedAt) || metricUpdatedAt > observedAt + 1_000) {
    throw typedError('runtime_metrics_invalid', target.processName);
  }
  return {
    pid,
    heapUsedMiB: heapUsedBytes / (1024 * 1024),
    metricUpdatedAt,
  };
}

export function createDefaultSampleProvider({
  listPm2Processes = defaultListPm2Processes,
  fetchImpl = fetch,
} = {}) {
  return async function sample(targets, now = Date.now()) {
    let pm2Rows = null;
    if (targets.some((target) => target.kind === 'pm2')) {
      pm2Rows = await listPm2Processes();
      if (!Array.isArray(pm2Rows)) throw typedError('pm2_sample_invalid');
    }
    const output = [];
    for (const target of targets) {
      if (target.kind === 'pm2') {
        const matches = pm2Rows.filter((row) => row?.name === target.processName);
        if (matches.length !== 1) throw typedError(matches.length ? 'pm2_duplicate_process' : 'pm2_process_missing');
        const row = matches[0];
        const runtime = await readRuntimeMetrics(target, row, fetchImpl, now);
        output.push({
          name: target.name,
          pid: runtime.pid,
          restartCount: Number(row.pm2_env?.restart_time || 0),
          heapUsedMiB: runtime.heapUsedMiB,
          metricUpdatedAt: runtime.metricUpdatedAt,
          metricTimestampAuthoritative: true,
          observedAt: now,
          metricSource: 'loopback-runtime-v8-request',
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
          metricTimestampAuthoritative: true,
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
    if ([first, ...rows].some((row) => row.metricTimestampAuthoritative !== true)) {
      throw typedError('metric_timestamp_untrusted', target.name);
    }
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
    const restartDeltas = rows.map((row) => row.restartCount - first.restartCount);
    const restartChanged = restartDeltas.some((delta) => delta !== 0);
    const restartDelta = restartDeltas.length ? Math.max(...restartDeltas) : 0;
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
    if (restartChanged) throw typedError('process_restarted', target.name, { summary });
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
  const finalSample = await sampleProvider(targets, commandCompletedAt);
  samples.push(finalSample.map((row) => ({ ...row, postCommand: true })));
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
