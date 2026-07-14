#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const TERMINAL_OPERATION_STATES = new Set([
  'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);
const SUCCESS_OPERATION_STATES = new Set(['complete', 'partial']);
const TERMINAL_TURN_STATES = new Set([
  'complete', 'error', 'stopped', 'timeout', 'orphaned',
]);
const OPERATION_ID = /^brop_[A-Za-z0-9_-]{32}$/;
const REQUEST_ID = /^qreq_[A-Za-z0-9_-]{32}$/;
const CREDENTIAL_ID = /^qncred_[A-Za-z0-9_-]{32}$/;
const INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const SAFE_LEVELS = new Set(['skim', 'sample', 'deep', 'full']);
const SECRET_KEY = /(?:authorization|cookie|token|secret|password|api[_-]?key)/i;
const DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_PROGRESS_SAMPLES = 512;
const MAX_SSE_EVENTS = 256;
const MAX_SSE_FRAME_BYTES = 64 * 1024;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const Ajv2020 = require('ajv/dist/2020');
const QUERY_NOTEBOOK_SCHEMA = JSON.parse(readFileSync(
  path.join(REPO_ROOT, 'contracts/schemas/query-notebook.schema.json'), 'utf8',
));
const projectionAjv = new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true });
projectionAjv.addSchema(QUERY_NOTEBOOK_SCHEMA, QUERY_NOTEBOOK_SCHEMA.$id);
const projectionValidators = new Map();
const PROGRESS_STAGES = [
  'queued', 'preparing_source', 'selecting_work', 'sweeping', 'synthesizing',
  'finalizing', 'terminal',
];
const PROGRESS_COUNTERS = [
  'sourceNodes', 'sourceEdges', 'candidateWorkUnits', 'selected', 'completed',
  'successful', 'failed', 'reused', 'pending', 'retryable', 'total',
  'synthesisLevel', 'synthesisBatch', 'synthesisBatches',
];
const CUMULATIVE_COUNTERS = [
  'sourceNodes', 'sourceEdges', 'candidateWorkUnits', 'selected', 'completed',
  'successful', 'failed', 'reused', 'retryable', 'total',
];

export const HELP = `Usage:
  node scripts/verify-query-notebook-live.mjs \\
    --agent <agent> \\
    --dashboard-url <selected-agent-dashboard> \\
    --output <receipt.json>

Authentication (never written to the receipt):
  Set HOME23_QUERY_BRIDGE_TOKEN, HOME23_BRIDGE_TOKEN, or BRIDGE_TOKEN; or pass
  --bridge-token-file <0600 nonsymlink file>. Do not put a token on the command line.

Route discovery:
  --harness-url <url>                 Optional; otherwise discovered from the dashboard.
  --wrong-agent-dashboard-url <url>   Optional; otherwise discovered from Settings agents.

Exact live-catalog model overrides (provider and model must be supplied together):
  --direct-provider <id> --direct-model <id>
  --sweep-provider <id>  --sweep-model <id>
  --synth-provider <id>  --synth-model <id>

Long-operation controls:
  --pgs-level skim|sample|deep|full   Default: sample
  --poll-ms <ms>                      Default: 5000
  --direct-hard-timeout-ms <ms>       Default: 7200000
  --direct-stall-timeout-ms <ms>      Default: 1800000
  --pgs-hard-timeout-ms <ms>          Default: 28800000
  --pgs-stall-timeout-ms <ms>         Default: 7200000
  --chat-hard-timeout-ms <ms>         Default: 5400000
  --chat-stall-timeout-ms <ms>        Default: 1200000

The verifier performs real provider operations. It does not restart processes.
`;

function errorWithCode(code, message = code, fields = {}) {
  return Object.assign(new Error(message), { code, ...fields });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function normalizeGitCommit(value) {
  const commit = String(value).trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw errorWithCode('implementation_commit_invalid');
  return commit;
}

function implementationCommit() {
  try {
    return normalizeGitCommit(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch (cause) {
    if (cause?.code === 'implementation_commit_invalid') throw cause;
    throw errorWithCode('implementation_commit_unavailable', 'could not resolve exact implementation commit', { cause });
  }
}

function canonicalUrl(value, label) {
  let url;
  try { url = new URL(value); } catch (cause) {
    throw errorWithCode('url_invalid', `${label} must be an absolute HTTP URL`, { cause });
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw errorWithCode('url_invalid', `${label} must be an HTTP origin without credentials or a path`);
  }
  return url.origin;
}

function integerOption(raw, name, fallback, minimum, maximum) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw errorWithCode('invalid_argument', `--${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function completePair(values, providerKey, modelKey) {
  const provider = values[providerKey];
  const model = values[modelKey];
  if ((provider === undefined) !== (model === undefined)) {
    throw errorWithCode('model_pair_invalid', `--${providerKey} and --${modelKey} must be supplied together`);
  }
  if (provider === undefined) return undefined;
  if (typeof provider !== 'string' || !provider || provider.length > 256
      || typeof model !== 'string' || !model || model.length > 256) {
    throw errorWithCode('model_pair_invalid');
  }
  return { provider, model };
}

function parseArgv(argv) {
  const values = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') { values.help = true; continue; }
    if (!token.startsWith('--') || token === '--') throw errorWithCode('invalid_argument', `unexpected argument ${token}`);
    const equals = token.indexOf('=');
    const key = token.slice(2, equals < 0 ? undefined : equals);
    let value;
    if (equals >= 0) value = token.slice(equals + 1);
    else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw errorWithCode('invalid_argument', `--${key} requires a value`);
      }
      index += 1;
    }
    if (Object.hasOwn(values, key)) throw errorWithCode('duplicate_argument', `duplicate --${key}`);
    values[key] = value;
  }
  return values;
}

export function parseOptions(argv = process.argv.slice(2), env = process.env) {
  const values = parseArgv(argv);
  if (values.help) return { help: true };
  const allowed = new Set([
    'agent', 'dashboard-url', 'harness-url', 'wrong-agent-dashboard-url', 'output',
    'bridge-token-file', 'direct-provider', 'direct-model', 'sweep-provider',
    'sweep-model', 'synth-provider', 'synth-model', 'direct-mode', 'pgs-level',
    'direct-question', 'pgs-question', 'poll-ms', 'http-timeout-ms',
    'direct-hard-timeout-ms', 'direct-stall-timeout-ms', 'pgs-hard-timeout-ms',
    'pgs-stall-timeout-ms', 'chat-hard-timeout-ms', 'chat-stall-timeout-ms',
    'sse-observe-ms', 'max-result-bytes', 'max-receipt-bytes',
  ]);
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) throw errorWithCode('invalid_argument', `unknown --${key}`);
  }
  const agent = values.agent;
  if (typeof agent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/.test(agent)) {
    throw errorWithCode('missing_argument', '--agent is required and must be a safe agent identifier');
  }
  if (typeof values['dashboard-url'] !== 'string') throw errorWithCode('missing_argument', '--dashboard-url is required');
  if (typeof values.output !== 'string' || !values.output || values.output.includes('\0')) {
    throw errorWithCode('missing_argument', '--output is required');
  }
  const dashboardUrl = canonicalUrl(values['dashboard-url'], 'dashboard URL');
  const harnessUrl = values['harness-url'] === undefined
    ? undefined : canonicalUrl(values['harness-url'], 'harness URL');
  const wrongAgentDashboardUrl = values['wrong-agent-dashboard-url'] === undefined
    ? undefined : canonicalUrl(values['wrong-agent-dashboard-url'], 'wrong-agent dashboard URL');
  if (harnessUrl && harnessUrl === dashboardUrl) throw errorWithCode('route_owner_collision');
  if (wrongAgentDashboardUrl && wrongAgentDashboardUrl === dashboardUrl) {
    throw errorWithCode('route_owner_collision');
  }
  const pgsLevel = values['pgs-level'] ?? 'sample';
  if (!SAFE_LEVELS.has(pgsLevel)) throw errorWithCode('invalid_argument', '--pgs-level is invalid');
  const envTokens = [
    env.HOME23_QUERY_BRIDGE_TOKEN, env.HOME23_BRIDGE_TOKEN, env.BRIDGE_TOKEN,
  ].filter((value) => typeof value === 'string' && value);
  if (new Set(envTokens).size > 1) throw errorWithCode('bridge_token_conflict');
  return {
    agent,
    dashboardUrl,
    harnessUrl,
    wrongAgentDashboardUrl,
    output: path.resolve(values.output),
    bridgeTokenFile: values['bridge-token-file'] === undefined
      ? undefined : path.resolve(values['bridge-token-file']),
    bridgeToken: envTokens[0],
    modelOverrides: {
      direct: completePair(values, 'direct-provider', 'direct-model'),
      sweep: completePair(values, 'sweep-provider', 'sweep-model'),
      synthesis: completePair(values, 'synth-provider', 'synth-model'),
    },
    directMode: values['direct-mode'],
    pgsLevel,
    directQuestion: values['direct-question']
      ?? 'Home23 live acceptance: identify one current durable brain fact and its evidence.',
    pgsQuestion: values['pgs-question']
      ?? 'Home23 live acceptance: synthesize the durable brain themes and identify remaining coverage.',
    pollMs: integerOption(values['poll-ms'], 'poll-ms', 5_000, 250, 60_000),
    httpTimeoutMs: integerOption(values['http-timeout-ms'], 'http-timeout-ms', 30_000, 1_000, 300_000),
    directHardTimeoutMs: integerOption(values['direct-hard-timeout-ms'], 'direct-hard-timeout-ms', 2 * 60 * 60_000, 1_000, 24 * 60 * 60_000),
    directStallTimeoutMs: integerOption(values['direct-stall-timeout-ms'], 'direct-stall-timeout-ms', 30 * 60_000, 1_000, 8 * 60 * 60_000),
    pgsHardTimeoutMs: integerOption(values['pgs-hard-timeout-ms'], 'pgs-hard-timeout-ms', 8 * 60 * 60_000, 1_000, 24 * 60 * 60_000),
    pgsStallTimeoutMs: integerOption(values['pgs-stall-timeout-ms'], 'pgs-stall-timeout-ms', 2 * 60 * 60_000, 1_000, 8 * 60 * 60_000),
    chatHardTimeoutMs: integerOption(values['chat-hard-timeout-ms'], 'chat-hard-timeout-ms', 90 * 60_000, 1_000, 8 * 60 * 60_000),
    chatStallTimeoutMs: integerOption(values['chat-stall-timeout-ms'], 'chat-stall-timeout-ms', 20 * 60_000, 1_000, 4 * 60 * 60_000),
    sseObserveMs: integerOption(values['sse-observe-ms'], 'sse-observe-ms', 30_000, 1_000, 300_000),
    maxResultBytes: integerOption(values['max-result-bytes'], 'max-result-bytes', DEFAULT_MAX_RESULT_BYTES, 1_024, 16 * 1024 * 1024),
    maxReceiptBytes: integerOption(values['max-receipt-bytes'], 'max-receipt-bytes', DEFAULT_MAX_RECEIPT_BYTES, 16 * 1024, 16 * 1024 * 1024),
  };
}

function catalogPair(catalog, pair, label) {
  if (!pair || typeof pair.provider !== 'string' || typeof pair.model !== 'string') {
    throw errorWithCode('catalog_model_pair_unavailable', `${label} provider/model pair is absent`);
  }
  const match = catalog.models.some((entry) => (
    entry?.provider === pair.provider && (entry?.id ?? entry?.model) === pair.model
  ));
  if (!match) {
    throw errorWithCode('catalog_model_pair_unavailable', `${label} pair is not selectable in the live catalog`);
  }
  return pair;
}

export function resolveModelPlan(catalog, overrides = {}) {
  if (!catalog || catalog.available !== true || !Array.isArray(catalog.models)) {
    throw errorWithCode('catalog_unavailable');
  }
  const defaults = catalog.defaults ?? {};
  return {
    direct: catalogPair(catalog, overrides.direct ?? {
      provider: defaults.provider, model: defaults.model,
    }, 'direct'),
    sweep: catalogPair(catalog, overrides.sweep ?? {
      provider: defaults.pgsSweepProvider, model: defaults.pgsSweepModel,
    }, 'PGS sweep'),
    synthesis: catalogPair(catalog, overrides.synthesis ?? {
      provider: defaults.pgsSynthProvider, model: defaults.pgsSynthModel,
    }, 'PGS synthesis'),
  };
}

async function boundedResponseText(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw errorWithCode('response_too_large');
  if (!response.body) return '';
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw errorWithCode('response_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function requestJson(url, {
  fetchImpl = fetch,
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 30_000,
  maxBytes = DEFAULT_MAX_JSON_BYTES,
  expectedStatuses,
} = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: { accept: 'application/json', ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await boundedResponseText(response, maxBytes);
  let value = null;
  try { value = text ? JSON.parse(text) : null; } catch (cause) {
    throw errorWithCode('response_json_invalid', 'response was not valid JSON', { cause, status: response.status });
  }
  if (expectedStatuses) {
    if (!expectedStatuses.includes(response.status)) {
      throw errorWithCode('unexpected_http_status', `expected ${expectedStatuses.join('/')} but received ${response.status}`, { status: response.status });
    }
  } else if (!response.ok) {
    const code = typeof value?.error?.code === 'string' ? value.error.code
      : typeof value?.error === 'string' ? value.error : 'http_request_failed';
    throw errorWithCode(code, `${code} (HTTP ${response.status})`, { status: response.status });
  }
  return { response, value, text };
}

function operationIdFromStart(value) {
  if (!value || !OPERATION_ID.test(value.operationId)
      || value.detached !== true || value.attachmentState !== 'detached') {
    throw errorWithCode('detached_start_invalid');
  }
  return value.operationId;
}

export async function replayDetachedStart({
  fetchImpl = fetch, url, body, requestId, timeoutMs = 30_000,
}) {
  if (!REQUEST_ID.test(requestId)) throw errorWithCode('request_id_invalid');
  const serialized = JSON.stringify(body);
  const headers = {
    'content-type': 'application/json',
    'x-home23-query-request-id': requestId,
    prefer: 'respond-async',
  };
  const start = async () => requestJson(url, {
    fetchImpl, method: 'POST', headers, body: serialized, timeoutMs,
    expectedStatuses: [202],
  });
  const first = await start();
  const replay = await start();
  const firstId = operationIdFromStart(first.value);
  const replayId = operationIdFromStart(replay.value);
  if (firstId !== replayId) throw errorWithCode('idempotency_replay_diverged');
  return {
    operationId: firstId,
    requestId,
    requestBytes: Buffer.byteLength(serialized),
    requestSha256: sha256(serialized),
    responses: [first.response.status, replay.response.status],
  };
}

export function validatePublicProjection(definition, value) {
  if (!Object.hasOwn(QUERY_NOTEBOOK_SCHEMA.$defs, definition)) {
    throw errorWithCode('public_projection_invalid');
  }
  let validate = projectionValidators.get(definition);
  if (!validate) {
    validate = projectionAjv.compile({
      $ref: `${QUERY_NOTEBOOK_SCHEMA.$id}#/$defs/${definition}`,
    });
    projectionValidators.set(definition, validate);
  }
  if (!validate(value)) throw errorWithCode('public_projection_invalid');
  return value;
}

function assertProgressSnapshot(progress) {
  if (!progress || typeof progress !== 'object' || Array.isArray(progress)) {
    throw errorWithCode('progress_snapshot_invalid');
  }
  if (progress.version !== undefined && progress.version !== 1) {
    throw errorWithCode('progress_snapshot_invalid');
  }
  if (progress.stage !== undefined && !PROGRESS_STAGES.includes(progress.stage)) {
    throw errorWithCode('progress_snapshot_invalid');
  }
  if (progress.eventSequence !== undefined
      && (!Number.isSafeInteger(progress.eventSequence) || progress.eventSequence < 0)) {
    throw errorWithCode('progress_snapshot_invalid');
  }
  for (const key of PROGRESS_COUNTERS) {
    if (progress[key] !== undefined
        && (!Number.isSafeInteger(progress[key]) || progress[key] < 0)) {
      throw errorWithCode('progress_snapshot_invalid');
    }
  }
  for (const key of ['lastProviderActivityAt', 'lastProgressAt']) {
    if (progress[key] !== undefined && !Number.isFinite(Date.parse(progress[key]))) {
      throw errorWithCode('progress_snapshot_invalid');
    }
  }
  const { selected, completed, successful, failed, reused, pending, retryable,
    total, synthesisBatch, synthesisBatches } = progress;
  if (reused !== undefined && successful !== undefined && reused > successful) {
    throw errorWithCode('progress_snapshot_invalid');
  }
  if (retryable !== undefined && failed !== undefined && retryable > failed) {
    throw errorWithCode('progress_snapshot_invalid');
  }
  if (completed !== undefined && successful !== undefined && failed !== undefined
      && completed !== successful + failed) throw errorWithCode('progress_snapshot_invalid');
  if (selected !== undefined && completed !== undefined && pending !== undefined
      && selected !== completed + pending) throw errorWithCode('progress_snapshot_invalid');
  if (total !== undefined && selected !== undefined && total < selected) {
    throw errorWithCode('progress_snapshot_invalid');
  }
  if (synthesisBatch !== undefined && synthesisBatches !== undefined
      && synthesisBatch > synthesisBatches) throw errorWithCode('progress_snapshot_invalid');
  return progress;
}

function progressProjection(status) {
  const progress = status?.progress && typeof status.progress === 'object' ? status.progress : {};
  assertProgressSnapshot(progress);
  const projection = {
    executionState: status?.executionState ?? status?.status ?? null,
    eventSequence: Number.isSafeInteger(progress.eventSequence)
      ? progress.eventSequence : Number.isSafeInteger(status?.last_seq) ? status.last_seq : null,
  };
  for (const key of [
    'version', 'stage', 'sourceNodes', 'sourceEdges', 'candidateWorkUnits', 'selected',
    'completed', 'successful', 'failed', 'reused', 'pending', 'retryable', 'total',
    'synthesisLevel', 'synthesisBatch', 'synthesisBatches',
    'lastProviderActivityAt', 'lastProgressAt',
  ]) {
    if (progress[key] !== undefined) projection[key] = progress[key];
  }
  for (const key of ['updatedAt', 'updated_at', 'last_event_at']) {
    if (status?.[key] !== undefined) projection[key] = status[key];
  }
  return projection;
}

function activityFingerprint(sample) {
  const durableActivity = {};
  for (const key of [
    'executionState', 'eventSequence', 'stage', 'sourceNodes', 'sourceEdges',
    'candidateWorkUnits', 'selected', 'completed', 'successful', 'failed',
    'reused', 'pending', 'retryable', 'total', 'synthesisLevel',
    'synthesisBatch', 'synthesisBatches', 'lastProviderActivityAt',
    'lastProgressAt',
  ]) {
    if (sample[key] !== undefined) durableActivity[key] = sample[key];
  }
  return JSON.stringify(durableActivity);
}

function assertMonotonic(previous, next) {
  if (!previous) return;
  if (Number.isSafeInteger(previous.eventSequence) && Number.isSafeInteger(next.eventSequence)
      && next.eventSequence < previous.eventSequence) throw errorWithCode('progress_not_monotonic');
  const previousStage = PROGRESS_STAGES.indexOf(previous.stage);
  const nextStage = PROGRESS_STAGES.indexOf(next.stage);
  if (previousStage >= 0 && nextStage >= 0 && nextStage < previousStage) {
    throw errorWithCode('progress_not_monotonic');
  }
  const allowCandidateReplacement = previousStage >= 0
    && previousStage < PROGRESS_STAGES.indexOf('selecting_work')
    && next.stage === 'selecting_work';
  for (const key of CUMULATIVE_COUNTERS) {
    if (key === 'candidateWorkUnits' && allowCandidateReplacement) continue;
    if (Number.isSafeInteger(previous[key]) && Number.isSafeInteger(next[key])
        && next[key] < previous[key]) throw errorWithCode('progress_not_monotonic');
  }
  if (Number.isSafeInteger(previous.pending) && Number.isSafeInteger(next.pending)
      && next.pending > previous.pending) {
    const selectedDelta = Number.isSafeInteger(previous.selected) && Number.isSafeInteger(next.selected)
      ? next.selected - previous.selected : 0;
    const pendingDelta = next.pending - previous.pending;
    if (selectedDelta < pendingDelta) throw errorWithCode('progress_not_monotonic');
  }
  if (Number.isSafeInteger(previous.synthesisLevel)
      && Number.isSafeInteger(next.synthesisLevel)
      && next.synthesisLevel < previous.synthesisLevel) {
    throw errorWithCode('progress_not_monotonic');
  }
  const synthesisLevelAdvanced = Number.isSafeInteger(previous.synthesisLevel)
    && Number.isSafeInteger(next.synthesisLevel)
    && next.synthesisLevel > previous.synthesisLevel;
  if (!synthesisLevelAdvanced) {
    for (const key of ['synthesisBatch', 'synthesisBatches']) {
      if (Number.isSafeInteger(previous[key]) && Number.isSafeInteger(next[key])
          && next[key] < previous[key]) throw errorWithCode('progress_not_monotonic');
    }
  }
  for (const key of ['lastProviderActivityAt', 'lastProgressAt']) {
    if (previous[key] !== undefined && next[key] !== undefined
        && Date.parse(next[key]) < Date.parse(previous[key])) {
      throw errorWithCode('progress_not_monotonic');
    }
  }
}

export async function waitForTerminal({
  readStatus,
  terminalStates = TERMINAL_OPERATION_STATES,
  successStates,
  now = Date.now,
  sleepImpl = delay,
  pollIntervalMs,
  hardTimeoutMs,
  stallTimeoutMs,
  onSample = () => {},
}) {
  const startedAt = now();
  let lastActivityAt = startedAt;
  let previous = null;
  let fingerprint = null;
  while (true) {
    const status = await readStatus();
    if (!status || typeof status !== 'object') throw errorWithCode('status_invalid');
    const sample = progressProjection(status);
    assertMonotonic(previous, sample);
    const nextFingerprint = activityFingerprint(sample);
    if (fingerprint !== nextFingerprint) {
      lastActivityAt = now();
      fingerprint = nextFingerprint;
    }
    previous = sample;
    onSample(sample);
    const state = status.executionState ?? status.status;
    if (terminalStates.has(state)) {
      if (successStates && !successStates.has(state)) {
        throw errorWithCode('terminal_operation_failed', `terminal state ${state}`, { terminalStatus: status });
      }
      return status;
    }
    const current = now();
    if (current - startedAt >= hardTimeoutMs) throw errorWithCode('operation_hard_timeout');
    if (current - lastActivityAt >= stallTimeoutMs) throw errorWithCode('operation_stalled');
    await sleepImpl(Math.min(
      pollIntervalMs,
      Math.max(1, hardTimeoutMs - (current - startedAt)),
      Math.max(1, stallTimeoutMs - (current - lastActivityAt)),
    ));
  }
}

async function waitForProgressAdvance({
  readStatus, afterSequence, now = Date.now, sleepImpl = delay, pollIntervalMs,
  hardTimeoutMs, stallTimeoutMs,
}) {
  const startedAt = now();
  let lastActivityAt = startedAt;
  let previous = null;
  let fingerprint = null;
  while (true) {
    const status = await readStatus();
    const sample = progressProjection(status);
    assertMonotonic(previous, sample);
    const nextFingerprint = activityFingerprint(sample);
    if (nextFingerprint !== fingerprint) {
      lastActivityAt = now();
      fingerprint = nextFingerprint;
    }
    previous = sample;
    if (Number.isSafeInteger(sample.eventSequence) && sample.eventSequence > afterSequence) {
      return status;
    }
    const current = now();
    if (current - startedAt >= hardTimeoutMs) throw errorWithCode('sse_reconnect_advance_timeout');
    if (current - lastActivityAt >= stallTimeoutMs) throw errorWithCode('operation_stalled');
    await sleepImpl(Math.min(
      pollIntervalMs,
      Math.max(1, hardTimeoutMs - (current - startedAt)),
      Math.max(1, stallTimeoutMs - (current - lastActivityAt)),
    ));
  }
}

export function recordBoundedSample(samples, sample, limit = MAX_PROGRESS_SAMPLES) {
  if (!Array.isArray(samples) || !Number.isSafeInteger(limit) || limit < 1) {
    throw errorWithCode('sample_buffer_invalid');
  }
  if (samples.length < limit) samples.push(sample);
  else samples[limit - 1] = sample;
  return samples;
}

export function createProgressReporter({
  kind, operationId, emit = () => {}, now = Date.now, heartbeatMs = 60_000,
}) {
  let lastFingerprint = null;
  let lastEmittedAt = -Infinity;
  return (progress) => {
    const current = now();
    const fingerprint = activityFingerprint(progress);
    if (fingerprint === lastFingerprint && current - lastEmittedAt < heartbeatMs) return;
    lastFingerprint = fingerprint;
    lastEmittedAt = current;
    emit({ type: 'operation_progress', kind, operationId, observedAt: new Date(current).toISOString(), progress });
  };
}

export async function consumeNotebookFrames({ frames, readStatus, afterSequence = 0 }) {
  const recoveries = [];
  let gapObserved = false;
  let cursor = afterSequence;
  for await (const frame of frames) {
    const sequence = Number(frame?.data?.eventSequence ?? frame?.id);
    if (!Number.isSafeInteger(sequence) || sequence < cursor) throw errorWithCode('event_sequence_invalid');
    if (frame.event === 'gap' || frame.data?.type === 'gap') {
      gapObserved = true;
      const current = await readStatus();
      const authoritativeSequence = current?.progress?.eventSequence;
      if (!Number.isSafeInteger(authoritativeSequence) || authoritativeSequence < sequence) {
        throw errorWithCode('gap_recovery_invalid');
      }
      recoveries.push({ gapSequence: sequence, authoritativeSequence });
      cursor = authoritativeSequence;
      continue;
    }
    cursor = Math.max(cursor, sequence);
  }
  return { gapObserved, afterSequence: cursor, recoveries };
}

function frameSequence(frame) {
  const sequence = frame?.data?.eventSequence ?? frame?.id;
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
}

function validateStreamFrame(frame) {
  if (!frame?.data || typeof frame.data !== 'object') throw errorWithCode('event_stream_invalid');
  validatePublicProjection('queryStreamEvent', frame.data);
  if (frame.event !== frame.data.type || frameSequence(frame) !== frame.data.eventSequence) {
    throw errorWithCode('event_stream_invalid');
  }
  return frame;
}

export function proveMeaningfulReconnect(firstFrames, reconnectFrames, requestedAfter = 0) {
  const sequences = (frames) => frames.map((frame) => {
    validateStreamFrame(frame);
    return frameSequence(frame);
  });
  const first = sequences(firstFrames);
  const reconnect = sequences(reconnectFrames);
  const detachedAtSequence = Math.max(requestedAfter, ...first);
  const reconnectedAtSequence = Math.max(requestedAfter, ...reconnect);
  if (detachedAtSequence <= requestedAfter || reconnectedAtSequence <= detachedAtSequence) {
    throw errorWithCode('sse_reconnect_not_advanced');
  }
  return { detachedAtSequence, reconnectedAtSequence };
}

export async function proveServerGapFrames({ frames, requestedAfter = 0, readStatus }) {
  for (const frame of frames) validateStreamFrame(frame);
  const gap = frames.find((frame) => frame.data.type === 'gap');
  if (!gap) throw errorWithCode('server_gap_not_observed');
  const { fromSequence, toSequence } = gap.data;
  if (fromSequence !== requestedAfter + 1 || toSequence < fromSequence) {
    throw errorWithCode('server_gap_invalid');
  }
  const status = await readStatus();
  const progress = assertProgressSnapshot(status?.progress);
  if (!Number.isSafeInteger(progress.eventSequence) || progress.eventSequence < toSequence) {
    throw errorWithCode('gap_recovery_invalid');
  }
  return { fromSequence, toSequence, authoritativeSequence: progress.eventSequence };
}

export function proveGapRecoveryFrames(frames, gapEvidence) {
  if (!Array.isArray(frames) || frames.length === 0) throw errorWithCode('gap_recovery_invalid');
  const sequences = frames.map((frame) => {
    validateStreamFrame(frame);
    return frameSequence(frame);
  });
  const recoveredAtSequence = Math.max(gapEvidence.toSequence, ...sequences);
  if (recoveredAtSequence < gapEvidence.authoritativeSequence) {
    throw errorWithCode('gap_recovery_invalid');
  }
  return { requestedAfter: gapEvidence.toSequence, recoveredAtSequence };
}

function samePair(actual, expected) {
  return actual?.provider === expected?.provider && actual?.model === expected?.model;
}

export function assertPgsAcceptance(status, result, expected) {
  validatePublicProjection('queryNotebookStatus', status);
  validatePublicProjection('queryNotebookResult', result);
  const progress = assertProgressSnapshot(status.progress);
  const coverage = result.coverage;
  const statusCoverage = status.coverage;
  if (status.operationId !== result.operationId || status.requestKind !== 'pgs'
      || status.configuration?.pgsLevel !== expected.level
      || coverage?.coverageLevel !== expected.level
      || statusCoverage?.coverageLevel !== expected.level
      || !samePair(status.configuration?.sweepModel, expected.sweep)
      || !samePair(status.configuration?.synthesisModel, expected.synthesis)
      || (status.executionState !== 'complete' && status.executionState !== 'partial')
      || progress.stage !== 'terminal'
      || !Number.isSafeInteger(progress.selected) || progress.selected < 1
      || !Number.isSafeInteger(progress.completed) || progress.completed < 1
      || !Number.isSafeInteger(progress.successful) || progress.successful < 1
      || !Number.isFinite(Date.parse(progress.lastProviderActivityAt))
      || !Number.isSafeInteger(coverage?.selectedWorkUnits) || coverage.selectedWorkUnits < 1
      || !Number.isSafeInteger(coverage?.successfulSweeps) || coverage.successfulSweeps < 1
      || statusCoverage.selectedWorkUnits !== coverage.selectedWorkUnits
      || statusCoverage.successfulSweeps !== coverage.successfulSweeps
      || statusCoverage.reusedWorkUnits !== coverage.reusedWorkUnits) {
    throw errorWithCode('pgs_execution_unproven');
  }
  return {
    requestKind: status.requestKind,
    requestedLevel: expected.level,
    pgsMode: status.configuration.pgsMode,
    sweep: status.configuration.sweepModel,
    synthesis: status.configuration.synthesisModel,
    progress: {
      selected: progress.selected,
      completed: progress.completed,
      successful: progress.successful,
      failed: progress.failed,
      reused: progress.reused,
      lastProviderActivityAt: progress.lastProviderActivityAt,
    },
    coverage: {
      selectedWorkUnits: coverage.selectedWorkUnits,
      successfulSweeps: coverage.successfulSweeps,
      reusedWorkUnits: coverage.reusedWorkUnits,
    },
  };
}

export function redactForReceipt(value) {
  const seen = new WeakSet();
  const visit = (entry, key = '') => {
    if (SECRET_KEY.test(key)) return '[REDACTED]';
    if (typeof entry === 'string') return entry.length > 4_096 ? `${entry.slice(0, 4_096)}…` : entry;
    if (entry === null || typeof entry !== 'object') return entry;
    if (seen.has(entry)) return '[CIRCULAR]';
    seen.add(entry);
    if (Array.isArray(entry)) return entry.slice(0, 512).map((item) => visit(item));
    const projected = {};
    for (const [nestedKey, nested] of Object.entries(entry).slice(0, 512)) {
      projected[nestedKey] = visit(nested, nestedKey);
    }
    return projected;
  };
  return visit(value);
}

export function encodeReceipt(value, maxBytes = DEFAULT_MAX_RECEIPT_BYTES) {
  const encoded = `${JSON.stringify(redactForReceipt(value), null, 2)}\n`;
  if (Buffer.byteLength(encoded) > maxBytes) throw errorWithCode('receipt_too_large');
  return encoded;
}

export function safeErrorForReceipt(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'verification_failed',
    ...(Number.isInteger(error?.status) ? { httpStatus: error.status } : {}),
  };
}

function deviceHeaders(credential) {
  return {
    authorization: `Bearer ${credential.token}`,
    'x-home23-device-id': credential.credentialId,
  };
}

function queryRequestId() {
  return `qreq_${randomBytes(24).toString('base64url')}`;
}

function route(base, pathname) {
  return new URL(pathname, `${base}/`).toString();
}

async function loadBridgeToken(options) {
  if (options.bridgeToken && options.bridgeTokenFile) throw errorWithCode('bridge_token_conflict');
  if (options.bridgeToken) return options.bridgeToken;
  if (!options.bridgeTokenFile) throw errorWithCode('bridge_token_missing');
  const before = await fsp.lstat(options.bridgeTokenFile);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
      || before.size < 1 || before.size > 4_096
      || (before.mode & 0o077) !== 0) throw errorWithCode('bridge_token_file_unsafe');
  const token = (await fsp.readFile(options.bridgeTokenFile, 'utf8')).trim();
  const after = await fsp.lstat(options.bridgeTokenFile);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || !token || /\s/u.test(token)) throw errorWithCode('bridge_token_file_unsafe');
  return token;
}

export async function writeReceipt(outputPath, receipt, maxBytes) {
  const parent = path.dirname(outputPath);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fsp.lstat(parent);
  const canonicalParent = await fsp.realpath(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw errorWithCode('receipt_parent_unsafe');
  }
  const canonicalOutput = path.join(canonicalParent, path.basename(outputPath));
  const existing = await fsp.lstat(canonicalOutput).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw errorWithCode('receipt_output_unsafe');
  }
  const encoded = encodeReceipt(receipt, maxBytes);
  const temporary = path.join(parent, `.${path.basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    const handle = await fsp.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
    await fsp.rename(temporary, canonicalOutput);
    const directory = await fsp.open(parent, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

async function discoverRoutes(options) {
  let harnessUrl = options.harnessUrl;
  if (!harnessUrl) {
    const config = await requestJson(route(
      options.dashboardUrl,
      `/home23/api/chat/config/${encodeURIComponent(options.agent)}`,
    ), { timeoutMs: options.httpTimeoutMs });
    if (config.value?.agentName !== options.agent
        || !Number.isSafeInteger(config.value?.bridgePort)) throw errorWithCode('harness_route_unavailable');
    const dashboard = new URL(options.dashboardUrl);
    harnessUrl = `${dashboard.protocol}//${dashboard.hostname}:${config.value.bridgePort}`;
  }
  harnessUrl = canonicalUrl(harnessUrl, 'harness URL');
  if (harnessUrl === options.dashboardUrl) throw errorWithCode('route_owner_collision');

  let wrongAgentDashboardUrl = options.wrongAgentDashboardUrl;
  let wrongAgent = null;
  if (!wrongAgentDashboardUrl) {
    const inventory = await requestJson(route(options.dashboardUrl, '/home23/api/settings/agents'), {
      timeoutMs: options.httpTimeoutMs,
    });
    const other = inventory.value?.agents?.find((entry) => (
      entry?.name !== options.agent && Number.isSafeInteger(entry?.ports?.dashboard)
    ));
    if (!other) throw errorWithCode('wrong_agent_route_unavailable');
    const dashboard = new URL(options.dashboardUrl);
    wrongAgent = other.name;
    wrongAgentDashboardUrl = `${dashboard.protocol}//${dashboard.hostname}:${other.ports.dashboard}`;
  }
  wrongAgentDashboardUrl = canonicalUrl(wrongAgentDashboardUrl, 'wrong-agent dashboard URL');
  if (wrongAgentDashboardUrl === options.dashboardUrl || wrongAgentDashboardUrl === harnessUrl) {
    throw errorWithCode('route_owner_collision');
  }
  return { harnessUrl, wrongAgentDashboardUrl, wrongAgent };
}

async function enrollCredential({ options, harnessUrl, bridgeToken, installationId }) {
  const enrollment = await requestJson(route(harnessUrl, '/api/device/query-credential'), {
    method: 'POST',
    headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ installationId, agent: options.agent }),
    timeoutMs: options.httpTimeoutMs,
  });
  const value = enrollment.value;
  validatePublicProjection('queryNotebookDeviceCredential', value);
  if (!CREDENTIAL_ID.test(value?.credentialId) || typeof value?.token !== 'string'
      || !value.token || !Number.isSafeInteger(value?.generation) || value.generation < 1
      || !Number.isFinite(Date.parse(value?.expiresAt))) throw errorWithCode('credential_enrollment_invalid');
  return value;
}

export function validateRouteIdentities(expectedAgent, selectedCatalog, wrongCatalog) {
  if (selectedCatalog?.agent !== expectedAgent) throw errorWithCode('selected_agent_route_invalid');
  if (typeof wrongCatalog?.agent !== 'string' || !wrongCatalog.agent
      || wrongCatalog.agent === expectedAgent) throw errorWithCode('wrong_agent_route_invalid');
  return { selectedAgent: expectedAgent, wrongAgent: wrongCatalog.agent };
}

async function assertAuthenticationBoundaries({ options, routes, credential }) {
  const notebook = '/home23/api/query/notebook?limit=1';
  const [selectedCatalog, wrongCatalog] = await Promise.all([
    requestJson(route(options.dashboardUrl, '/home23/api/query/catalog'), {
      timeoutMs: options.httpTimeoutMs,
    }),
    requestJson(route(routes.wrongAgentDashboardUrl, '/home23/api/query/catalog'), {
      timeoutMs: options.httpTimeoutMs,
    }),
  ]);
  const identities = validateRouteIdentities(
    options.agent, selectedCatalog.value, wrongCatalog.value,
  );
  const missing = await requestJson(route(options.dashboardUrl, notebook), {
    timeoutMs: options.httpTimeoutMs, expectedStatuses: [401],
  });
  const wrongDevice = await requestJson(route(options.dashboardUrl, notebook), {
    headers: {
      authorization: `Bearer ${credential.token}`,
      'x-home23-device-id': `qncred_${'X'.repeat(32)}`,
    },
    timeoutMs: options.httpTimeoutMs, expectedStatuses: [401],
  });
  const wrongAgent = await requestJson(route(routes.wrongAgentDashboardUrl, notebook), {
    headers: deviceHeaders(credential), timeoutMs: options.httpTimeoutMs,
    expectedStatuses: [401, 403],
  });
  return {
    missingCredential: missing.response.status,
    wrongDevice: wrongDevice.response.status,
    wrongAgent: wrongAgent.response.status,
    selectedAgent: identities.selectedAgent,
    wrongAgentIdentity: identities.wrongAgent,
    wrongAgentRoute: routes.wrongAgentDashboardUrl,
  };
}

async function statusReader(options, credential, operationId) {
  const result = await requestJson(route(
    options.dashboardUrl,
    `/home23/api/query/operations/${encodeURIComponent(operationId)}`,
  ), { headers: deviceHeaders(credential), timeoutMs: options.httpTimeoutMs });
  validatePublicProjection('queryNotebookStatus', result.value);
  if (result.value?.operationId !== operationId || result.value?.requesterAgent !== options.agent) {
    throw errorWithCode('operation_status_invalid');
  }
  return result.value;
}

async function runAndWait({ options, credential, body, waitKind, checks }) {
  const requestId = queryRequestId();
  const startAt = Date.now();
  const started = await replayDetachedStart({
    url: route(options.dashboardUrl, '/home23/api/query/run'),
    body,
    requestId,
    timeoutMs: options.httpTimeoutMs,
  });
  const progress = [];
  const isPgs = waitKind === 'pgs';
  const report = createProgressReporter({
    kind: waitKind, operationId: started.operationId, emit: options.onEvent,
  });
  const terminal = await waitForTerminal({
    readStatus: () => statusReader(options, credential, started.operationId),
    pollIntervalMs: options.pollMs,
    hardTimeoutMs: isPgs ? options.pgsHardTimeoutMs : options.directHardTimeoutMs,
    stallTimeoutMs: isPgs ? options.pgsStallTimeoutMs : options.directStallTimeoutMs,
    successStates: SUCCESS_OPERATION_STATES,
    onSample(sample) { recordBoundedSample(progress, sample); report(sample); },
  });
  checks.push({
    id: `${waitKind}-terminal`, status: 'passed', durationMs: Date.now() - startAt,
    detail: { operationId: started.operationId, terminalState: terminal.executionState },
  });
  return { ...started, terminal, durationMs: Date.now() - startAt, progress };
}

async function getProtectedResult(options, credential, operationId) {
  await requestJson(route(
    options.dashboardUrl,
    `/home23/api/query/operations/${encodeURIComponent(operationId)}/result`,
  ), { timeoutMs: options.httpTimeoutMs, expectedStatuses: [401] });
  const response = await requestJson(route(
    options.dashboardUrl,
    `/home23/api/query/operations/${encodeURIComponent(operationId)}/result`,
  ), {
    headers: deviceHeaders(credential), timeoutMs: options.httpTimeoutMs,
    maxBytes: options.maxResultBytes,
  });
  validatePublicProjection('queryNotebookResult', response.value);
  if (response.value?.operationId !== operationId
      || typeof response.value?.answer !== 'string' || !response.value.answer.trim()) {
    throw errorWithCode('protected_result_invalid');
  }
  return {
    value: response.value,
    receipt: {
      operationId,
      bytes: Buffer.byteLength(response.text),
      sha256: sha256(response.text),
      answerBytes: Buffer.byteLength(response.value.answer),
      answerSha256: sha256(response.value.answer),
      resultVersion: response.value.resultVersion,
      coverage: response.value.coverage,
      actionKinds: response.value.actions?.map((entry) => entry.kind) ?? [],
    },
  };
}

async function subscribeNotification(options, credential, operationId) {
  const response = await requestJson(route(
    options.dashboardUrl,
    `/home23/api/query/operations/${encodeURIComponent(operationId)}/notifications`,
  ), {
    method: 'POST', headers: { ...deviceHeaders(credential), 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }), timeoutMs: options.httpTimeoutMs,
  });
  validatePublicProjection('queryNotebookNotificationResponse', response.value);
  if (response.value?.operationId !== operationId || response.value?.subscribed !== true
      || typeof response.value?.routeId !== 'string') throw errorWithCode('notification_subscription_invalid');
  const status = await statusReader(options, credential, operationId);
  if (status.notification?.subscribed !== true) {
    throw errorWithCode('notification_subscription_invalid');
  }
  return response.value;
}

async function continueSweep({ options, credential, sourceResult, checks }) {
  const action = sourceResult.actions?.find((entry) => entry?.kind === 'continueSweep');
  if (!action || typeof action.token !== 'string') throw errorWithCode('continuation_unavailable');
  const requestId = queryRequestId();
  const body = { kind: 'continueSweep', actionToken: action.token, requestId };
  const response = await requestJson(route(
    options.dashboardUrl,
    `/home23/api/query/operations/${encodeURIComponent(sourceResult.operationId)}/actions`,
  ), {
    method: 'POST', headers: { ...deviceHeaders(credential), 'content-type': 'application/json' },
    body: JSON.stringify(body), timeoutMs: options.httpTimeoutMs, expectedStatuses: [202],
  });
  validatePublicProjection('queryNotebookActionResponse', response.value);
  if (!OPERATION_ID.test(response.value?.operationId) || response.value?.requestKind !== 'pgs') {
    throw errorWithCode('continuation_start_invalid');
  }
  const progress = [];
  const report = createProgressReporter({
    kind: 'continuation', operationId: response.value.operationId, emit: options.onEvent,
  });
  const terminal = await waitForTerminal({
    readStatus: () => statusReader(options, credential, response.value.operationId),
    pollIntervalMs: options.pollMs,
    hardTimeoutMs: options.pgsHardTimeoutMs,
    stallTimeoutMs: options.pgsStallTimeoutMs,
    successStates: SUCCESS_OPERATION_STATES,
    onSample(sample) { recordBoundedSample(progress, sample); report(sample); },
  });
  const result = await getProtectedResult(options, credential, response.value.operationId);
  if (!Number.isSafeInteger(result.value?.coverage?.reusedWorkUnits)
      || result.value.coverage.reusedWorkUnits < 1) throw errorWithCode('continuation_reuse_unproven');
  checks.push({ id: 'continuation-reuse', status: 'passed', detail: {
    operationId: response.value.operationId,
    sourceOperationId: sourceResult.operationId,
    reusedWorkUnits: result.value.coverage.reusedWorkUnits,
  } });
  return {
    operationId: response.value.operationId,
    requestId,
    terminalState: terminal.executionState,
    progress,
    result: result.receipt,
  };
}

function parseSseBlock(block) {
  let event = 'message';
  let id = null;
  const data = [];
  for (const line of block.split(/\r?\n/u)) {
    if (!line || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /u, '');
    if (field === 'event') event = value;
    else if (field === 'id') id = /^\d+$/u.test(value) ? Number(value) : value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  const joined = data.join('\n');
  if (joined === '[DONE]') return { event: 'done', id, data: '[DONE]' };
  let parsed;
  try { parsed = JSON.parse(joined); } catch (cause) {
    throw errorWithCode('event_stream_invalid', 'SSE data was not JSON', { cause });
  }
  return { event, id, data: parsed };
}

export async function readSseFrames(response, {
  signal, maxEvents = MAX_SSE_EVENTS, stopWhen = () => false,
} = {}) {
  const frames = [];
  if (!response.body) throw errorWithCode('event_stream_invalid');
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) break;
      pending += decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(pending) > MAX_SSE_FRAME_BYTES * 2) throw errorWithCode('event_frame_too_large');
      while (true) {
        const match = /\r?\n\r?\n/u.exec(pending);
        if (!match) break;
        const block = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        if (Buffer.byteLength(block) > MAX_SSE_FRAME_BYTES) throw errorWithCode('event_frame_too_large');
        const frame = parseSseBlock(block);
        if (frame) frames.push(frame);
        if (frames.length >= maxEvents || frame?.event === 'done' || stopWhen(frame)) return frames;
      }
    }
  } catch (error) {
    if (!signal?.aborted && error?.name !== 'AbortError') throw error;
  }
  return frames;
}

async function observeNotebookSse(
  options, credential, operationId, afterSequence, maxEvents = 2, stopWhen = () => false,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.sseObserveMs);
  timer.unref?.();
  try {
    const url = new URL(route(
      options.dashboardUrl,
      `/home23/api/query/operations/${encodeURIComponent(operationId)}/events`,
    ));
    url.searchParams.set('after', String(afterSequence));
    url.searchParams.set('attachmentId', `acceptance-${randomUUID()}`);
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', ...deviceHeaders(credential) },
      signal: controller.signal,
    });
    if (!response.ok || !String(response.headers.get('content-type')).startsWith('text/event-stream')) {
      throw errorWithCode('event_stream_unavailable', `SSE returned HTTP ${response.status}`);
    }
    return await readSseFrames(response, { signal: controller.signal, maxEvents, stopWhen });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function verifyWebSession(options, bridgeToken) {
  const origin = options.dashboardUrl;
  const exchange = await requestJson(route(origin, '/home23/api/query/session'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      origin,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
    timeoutMs: options.httpTimeoutMs,
  });
  validatePublicProjection('queryNotebookWebSession', exchange.value);
  const cookie = exchange.response.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie || !/^home23_query_session=/u.test(cookie)) throw errorWithCode('web_session_invalid');
  const notebook = await requestJson(route(origin, '/home23/api/query/notebook?limit=1'), {
    headers: { cookie }, timeoutMs: options.httpTimeoutMs,
  });
  validatePublicProjection('queryNotebookPage', notebook.value);
  return { status: exchange.response.status, expiresAt: exchange.value?.expiresAt,
    notebookItems: notebook.value?.items?.length ?? null };
}

async function verifyBrainToolTurn(options, harnessUrl, bridgeToken) {
  const chatId = `query-notebook-acceptance-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const startedAt = Date.now();
  const started = await requestJson(route(harnessUrl, '/api/chat/turn'), {
    method: 'POST',
    headers: { authorization: `Bearer ${bridgeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      chatId,
      message: 'Read-only acceptance check: call brain_status exactly once for your own brain. Then briefly confirm whether it returned structured status. Do not mutate memory and do not call any other brain tool.',
    }),
    timeoutMs: options.httpTimeoutMs,
  });
  if (typeof started.value?.turn_id !== 'string' || !started.value.turn_id) {
    throw errorWithCode('brain_tool_turn_start_invalid');
  }
  const report = createProgressReporter({
    kind: 'brain-tool-turn', operationId: started.value.turn_id, emit: options.onEvent,
  });
  const samples = [];
  const status = await waitForTerminal({
    readStatus: async () => (await requestJson(route(
      harnessUrl,
      `/api/chat/turn-status?chatId=${encodeURIComponent(chatId)}&turn_id=${encodeURIComponent(started.value.turn_id)}`,
    ), { headers: { authorization: `Bearer ${bridgeToken}` }, timeoutMs: options.httpTimeoutMs })).value,
    terminalStates: TERMINAL_TURN_STATES,
    successStates: new Set(['complete']),
    pollIntervalMs: options.pollMs,
    hardTimeoutMs: options.chatHardTimeoutMs,
    stallTimeoutMs: options.chatStallTimeoutMs,
    onSample(sample) { recordBoundedSample(samples, sample); report(sample); },
  });
  const stream = await fetch(route(
    harnessUrl,
    `/api/chat/stream?chatId=${encodeURIComponent(chatId)}&turn_id=${encodeURIComponent(started.value.turn_id)}&cursor=-1`,
  ), { headers: { authorization: `Bearer ${bridgeToken}` }, signal: AbortSignal.timeout(options.httpTimeoutMs) });
  if (!stream.ok) throw errorWithCode('brain_tool_turn_stream_invalid');
  const frames = await readSseFrames(stream, { maxEvents: MAX_SSE_EVENTS });
  const events = frames.map((frame) => frame.data).filter((value) => value && typeof value === 'object');
  const start = events.find((event) => event.kind === 'tool_start' && event.data?.tool === 'brain_status');
  const result = events.find((event) => event.kind === 'tool_result'
    && event.data?.tool === 'brain_status' && event.data?.success === true);
  if (!start || !result) throw errorWithCode('brain_tool_turn_unproven');
  return {
    turnId: started.value.turn_id,
    status: status.status,
    durationMs: Date.now() - startedAt,
    provider: status.provider,
    model: status.model,
    tool: 'brain_status',
    toolSucceeded: true,
    eventCount: events.length,
    progress: samples,
  };
}

function requestBody({ options, catalog, models, kind }) {
  if (!catalog.selectedBrain?.id) throw errorWithCode('selected_brain_unavailable');
  if (kind === 'direct') return {
    agent: options.agent,
    brainId: catalog.selectedBrain.id,
    query: options.directQuestion,
    enablePGS: false,
    mode: options.directMode ?? catalog.defaults?.mode ?? 'full',
    modelSelection: models.direct,
  };
  return {
    agent: options.agent,
    brainId: catalog.selectedBrain.id,
    query: options.pgsQuestion,
    enablePGS: true,
    pgsMode: 'fresh',
    pgsLevel: options.pgsLevel,
    pgsSweep: models.sweep,
    pgsSynth: models.synthesis,
  };
}

export async function runVerifier(options) {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const checks = [];
  const commit = implementationCommit();
  options.onEvent?.({ type: 'verification_phase', phase: 'discovering-routes', observedAt: new Date().toISOString() });
  const bridgeToken = await loadBridgeToken(options);
  const routes = await discoverRoutes(options);
  checks.push({ id: 'route-owner-separation', status: 'passed', detail: {
    dashboardUrl: options.dashboardUrl,
    harnessUrl: routes.harnessUrl,
    wrongAgentDashboardUrl: routes.wrongAgentDashboardUrl,
  } });

  const catalogResponse = await requestJson(route(options.dashboardUrl, '/home23/api/query/catalog'), {
    timeoutMs: options.httpTimeoutMs,
  });
  const catalog = catalogResponse.value;
  if (catalog?.agent !== options.agent || catalog?.available !== true) throw errorWithCode('catalog_unavailable');
  const models = resolveModelPlan(catalog, options.modelOverrides);
  options.onEvent?.({ type: 'verification_phase', phase: 'catalog-resolved', observedAt: new Date().toISOString(), models });
  checks.push({ id: 'catalog-exact-models', status: 'passed', detail: models });

  const installationId = `acceptance-${options.agent}-${randomBytes(16).toString('hex')}`;
  if (!INSTALLATION_ID.test(installationId)) throw errorWithCode('installation_id_invalid');
  const credential = await enrollCredential({
    options, harnessUrl: routes.harnessUrl, bridgeToken, installationId,
  });
  const authBoundaries = await assertAuthenticationBoundaries({ options, routes, credential });
  options.onEvent?.({ type: 'verification_phase', phase: 'credential-boundaries-passed', observedAt: new Date().toISOString() });
  checks.push({ id: 'credential-boundaries', status: 'passed', detail: authBoundaries });

  const direct = await runAndWait({
    options, credential,
    body: requestBody({ options, catalog, models, kind: 'direct' }),
    waitKind: 'direct', checks,
  });
  const directResult = await getProtectedResult(options, credential, direct.operationId);
  checks.push({ id: 'direct-protected-result', status: 'passed', detail: directResult.receipt });

  const pgsStartedAt = Date.now();
  const pgsStart = await replayDetachedStart({
    url: route(options.dashboardUrl, '/home23/api/query/run'),
    body: requestBody({ options, catalog, models, kind: 'pgs' }),
    requestId: queryRequestId(), timeoutMs: options.httpTimeoutMs,
  });
  const notification = await subscribeNotification(options, credential, pgsStart.operationId);
  const firstFrames = await observeNotebookSse(options, credential, pgsStart.operationId, 0, 2);
  for (const frame of firstFrames) validateStreamFrame(frame);
  const detachedAtSequence = Math.max(0, ...firstFrames.map(frameSequence));
  if (detachedAtSequence < 1) throw errorWithCode('sse_reconnect_not_advanced');
  await waitForProgressAdvance({
    readStatus: () => statusReader(options, credential, pgsStart.operationId),
    afterSequence: detachedAtSequence,
    pollIntervalMs: options.pollMs,
    hardTimeoutMs: options.pgsHardTimeoutMs,
    stallTimeoutMs: options.pgsStallTimeoutMs,
  });
  const reconnectFrames = await observeNotebookSse(
    options, credential, pgsStart.operationId, detachedAtSequence, 2,
  );
  const reconnect = proveMeaningfulReconnect(firstFrames, reconnectFrames, 0);

  const pgsProgress = [];
  const pgsReport = createProgressReporter({
    kind: 'pgs', operationId: pgsStart.operationId, emit: options.onEvent,
  });
  const pgsTerminal = await waitForTerminal({
    readStatus: () => statusReader(options, credential, pgsStart.operationId),
    pollIntervalMs: options.pollMs,
    hardTimeoutMs: options.pgsHardTimeoutMs,
    stallTimeoutMs: options.pgsStallTimeoutMs,
    successStates: SUCCESS_OPERATION_STATES,
    onSample(sample) { recordBoundedSample(pgsProgress, sample); pgsReport(sample); },
  });
  const pgsDurationMs = Date.now() - pgsStartedAt;
  const pgsResult = await getProtectedResult(options, credential, pgsStart.operationId);
  const pgsEvidence = assertPgsAcceptance(pgsTerminal, pgsResult.value, {
    level: options.pgsLevel,
    sweep: models.sweep,
    synthesis: models.synthesis,
  });
  checks.push({ id: 'pgs-protected-result', status: 'passed', durationMs: pgsDurationMs,
    detail: { ...pgsResult.receipt, pgsEvidence } });

  const gapFrames = await observeNotebookSse(
    options, credential, pgsStart.operationId, 0, MAX_SSE_EVENTS,
    (frame) => frame?.data?.type === 'gap' || frame?.data?.type === 'terminal',
  );
  const gap = await proveServerGapFrames({
    frames: gapFrames,
    requestedAfter: 0,
    readStatus: () => statusReader(options, credential, pgsStart.operationId),
  });
  const recoveryFrames = await observeNotebookSse(
    options, credential, pgsStart.operationId, gap.toSequence, 2,
  );
  const recovery = proveGapRecoveryFrames(recoveryFrames, gap);
  checks.push({ id: 'sse-detach-reconnect-gap-recovery', status: 'passed', detail: {
    ...reconnect,
    serverGap: gap,
    recovery,
  } });
  const continuation = await continueSweep({ options, credential, sourceResult: pgsResult.value, checks });

  const forbidden = await requestJson(route(
    options.dashboardUrl,
    `/home23/api/query/operations/${encodeURIComponent(pgsStart.operationId)}?canonicalRoot=forbidden`,
  ), { headers: deviceHeaders(credential), timeoutMs: options.httpTimeoutMs, expectedStatuses: [400] });
  checks.push({ id: 'forbidden-field-rejection', status: 'passed', detail: { status: forbidden.response.status } });

  const web = await verifyWebSession(options, bridgeToken);
  checks.push({ id: 'same-origin-web-query', status: 'passed', detail: web });
  const brainTool = await verifyBrainToolTurn(options, routes.harnessUrl, bridgeToken);
  checks.push({ id: 'selected-agent-brain-tool', status: 'passed', detail: {
    turnId: brainTool.turnId, status: brainTool.status, durationMs: brainTool.durationMs,
    provider: brainTool.provider, model: brainTool.model, tool: brainTool.tool,
    toolSucceeded: brainTool.toolSucceeded,
  } });

  return {
    schemaVersion: 1,
    status: 'passed',
    implementationCommit: commit,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    agent: options.agent,
    routes: {
      dashboard: options.dashboardUrl,
      harness: routes.harnessUrl,
      wrongAgentDashboard: routes.wrongAgentDashboardUrl,
    },
    models,
    credential: {
      credentialId: credential.credentialId,
      generation: credential.generation,
      expiresAt: credential.expiresAt,
      installationIdSha256: sha256(installationId),
    },
    operations: {
      direct: {
        operationId: direct.operationId,
        requestId: direct.requestId,
        requestBytes: direct.requestBytes,
        requestSha256: direct.requestSha256,
        replayStatuses: direct.responses,
        terminalState: direct.terminal.executionState,
        durationMs: direct.durationMs,
        progress: direct.progress,
        result: directResult.receipt,
      },
      pgs: {
        operationId: pgsStart.operationId,
        requestId: pgsStart.requestId,
        requestBytes: pgsStart.requestBytes,
        requestSha256: pgsStart.requestSha256,
        replayStatuses: pgsStart.responses,
        terminalState: pgsTerminal.executionState,
        durationMs: pgsDurationMs,
        progress: pgsProgress,
        result: pgsResult.receipt,
        acceptance: pgsEvidence,
        notification: {
          subscribed: notification.subscribed,
          routeId: notification.routeId,
          deliveryState: notification.deliveryState,
          exactCredentialId: credential.credentialId,
        },
        sse: {
          detachedAtSequence: reconnect.detachedAtSequence,
          reconnectedAtSequence: reconnect.reconnectedAtSequence,
          serverGap: gap,
          recovery,
        },
      },
      continuation,
    },
    compatibility: { web, brainTool },
    checks,
  };
}

async function main() {
  let options;
  let receipt;
  let exitCode = 0;
  const startedAt = new Date().toISOString();
  try {
    options = parseOptions();
    if (options.help) { process.stdout.write(HELP); return; }
    receipt = await runVerifier({
      ...options,
      onEvent(event) {
        process.stderr.write(`${JSON.stringify(redactForReceipt(event))}\n`);
      },
    });
  } catch (error) {
    exitCode = 1;
    receipt = {
      schemaVersion: 1,
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      agent: options?.agent ?? null,
      error: safeErrorForReceipt(error),
    };
  }
  if (options?.output) {
    try { await writeReceipt(options.output, receipt, options.maxReceiptBytes); }
    catch (error) {
      exitCode = 1;
      process.stderr.write(`${JSON.stringify({ status: 'failed', error: safeErrorForReceipt(error) })}\n`);
    }
  }
  process.stdout.write(`${JSON.stringify(redactForReceipt({
    status: receipt.status,
    output: options?.output ?? null,
    error: receipt.error ?? null,
  }))}\n`);
  process.exitCode = exitCode;
}

const mainPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (mainPath && fileURLToPath(import.meta.url) === mainPath) await main();
