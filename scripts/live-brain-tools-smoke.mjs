#!/usr/bin/env node

import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  appendJsonlReceipt,
  booleanFlag,
  canonicalDirectory,
  canonicalReceiptRow,
  failCli,
  hashFile,
  integer,
  isInsideOrEqual,
  isMain,
  numberValue,
  one,
  parseCli,
  readBoundedFile,
  readJson,
  receiptContext,
  sha256Bytes,
  sleep,
  typedError,
  writeJsonReceipt,
} from './lib/brain-acceptance-common.mjs';

export const QUERY_WAIT_MS = 90 * 60 * 1000;
export const PGS_WAIT_MS = 6 * 60 * 60 * 1000;
export const PGS_LARGE_MIN_NODES = 100_000;
export const NEGATIVE_TARGET_CODES = Object.freeze([
  'target_not_found',
  'target_not_available',
  'target_mismatch',
  'target_ambiguous',
  'access_denied',
]);
export const SCENARIOS = Object.freeze([
  'discover-canary', 'own', 'direct-query', 'sibling', 'completed-research',
  'completed-research-compile', 'canonical-export', 'pgs', 'large-pgs-isolated',
  'graph', 'negative-targets', 'detach-reattach', 'cancel', 'restart-reconcile',
  'zero-result', 'synthesis-reconnect', 'mcp-parity', 'mcp-unavailable',
  'verify-receipts',
]);
const TERMINAL = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
const PROVIDER_OPERATION_TYPES = new Set(['query', 'pgs', 'research_compile', 'synthesis']);
const PROVIDER_TERMINAL_IDENTITIES = new Map([
  ['query', { phase: 'query', providerCallId: 'query' }],
  ['research_compile', { phase: 'research_compile', providerCallId: 'research_compile' }],
  ['synthesis', { phase: 'synthesis', providerCallId: 'synthesis' }],
]);
const ISOLATED_CONTROLLED_PGS_PAIR = Object.freeze({
  provider: 'controlled',
  model: 'controlled-pgs',
});
const PROVIDER_TERMINAL_OUTCOMES = new Set([
  'complete', 'partial', 'failed', 'cancelled', 'aborted',
]);
const ACTIVITY_TYPES = new Set([
  'progress', 'progress_update', 'token', 'token_estimate',
  'phase', 'terminal', 'state', 'heartbeat', 'provider_selected',
  'provider_activity', 'provider_call_terminal', 'result_ready',
  'source_pin_attached', 'worker_assigned',
]);
const SWEEP_RECEIPT_MAX_COUNT = 10_000;
const SWEEP_EXCERPT_CHARACTERS = 512;
const MAX_TOOL_RESULT_BYTES = 16 * 1024 * 1024;
const MAX_HTTP_JSON_BYTES = 2 * 1024 * 1024;
const MAX_MCP_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 32 * 1024 * 1024;
const MAX_RECEIPT_ROWS = 100_000;
const MAX_ARTIFACT_MANIFEST_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACT_FILES = 50_000;
const MAX_IDENTITY_OPERATIONS = 10_000;
const MAX_RESULT_ARTIFACT_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ACTIVITY_EVENTS = 100_000;
const MAX_ACTIVITY_EVENT_BYTES = 64 * 1024;
const MAX_ACTIVITY_RETAINED_BYTES = 32 * 1024 * 1024;
const MAX_METRIC_SAMPLES_PER_ROLE = 256;
const MAX_SOURCE_FILES_PER_BRAIN = 10_000;
const MAX_SOURCE_FILE_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 16 * 1024 * 1024 * 1024;
const MEMORY_GROWTH_LIMIT_MIB = 256;
const METRIC_SEMANTICS = Object.freeze({
  v8HeapUsedBytes: 'request-time-sample',
  rssBytes: 'request-time-sample',
  processMaxRssBytes: 'process-lifetime-high-water',
});
const require = createRequire(import.meta.url);
const { canonicalJson } = require('../shared/brain-operations/canonical-json.cjs');

export async function loadProductionModules() {
  try {
    const [client, brainTools, researchTools] = await Promise.all([
      import('../dist/agent/brain-operations/client.js'),
      import('../dist/agent/tools/brain.js'),
      import('../dist/agent/tools/research.js'),
    ]);
    if (typeof client.BrainOperationsClient !== 'function'
        || typeof brainTools.brainQueryTool?.execute !== 'function'
        || typeof researchTools.compileBrainTool?.execute !== 'function') {
      throw new Error('built brain tools incomplete');
    }
    return { ...client, ...brainTools, ...researchTools };
  } catch (error) {
    throw typedError('built_brain_tools_unavailable', 'Run npm run build before live smoke', { cause: error });
  }
}

function targetSelector(values) {
  const agent = one(values, 'target-agent');
  const brainId = one(values, 'target-brain');
  if (agent && brainId) throw typedError('target_mismatch');
  return agent ? { agent } : brainId ? { brainId } : undefined;
}

function exactPair(values, key) {
  const raw = one(values, key);
  if (!raw) return undefined;
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4 * 1024) {
    throw typedError('provider_pair_invalid', key);
  }
  let pair;
  try { pair = JSON.parse(raw); } catch (error) { throw typedError('provider_pair_invalid', key, { cause: error }); }
  if (!pair || Array.isArray(pair) || typeof pair !== 'object'
      || Object.keys(pair).sort().join(',') !== 'model,provider'
      || typeof pair.provider !== 'string' || !pair.provider
      || typeof pair.model !== 'string' || !pair.model) {
    throw typedError('provider_pair_invalid', key);
  }
  return pair;
}

function toolContext(client, callerAgent, signal) {
  return {
    turnRuntime: {
      turnId: `acceptance-${Date.now()}`,
      abortController: new AbortController(),
      signal,
      brainOperations: client,
      onOperationActivity() {},
    },
    brainOperations: client,
    agentName: callerAgent,
  };
}

async function runTool(tool, input, client, callerAgent, signal) {
  const result = await tool.execute(input, toolContext(client, callerAgent, signal));
  if (result?.is_error) {
    throw typedError(result.metadata?.code || 'brain_tool_failed', result.content || 'brain tool failed', {
      toolResult: result,
    });
  }
  return result;
}

function parseToolJson(result, label) {
  const prefix = `${label}\n`;
  if (typeof result?.content !== 'string' || !result.content.startsWith(prefix)) {
    throw typedError('brain_tool_result_invalid', label);
  }
  if (Buffer.byteLength(result.content, 'utf8') > MAX_TOOL_RESULT_BYTES) {
    throw typedError('brain_tool_result_too_large', label);
  }
  let value;
  try { value = JSON.parse(result.content.slice(prefix.length)); } catch (error) {
    throw typedError('brain_tool_result_invalid', label, { cause: error });
  }
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw typedError('brain_tool_result_invalid', label);
  }
  return value;
}

function evidenceRevision(evidence) {
  const candidates = [
    evidence?.revision,
    evidence?.sourceRevision,
    evidence?.deltaWatermark?.revision,
    evidence?.baseWatermark?.revision,
    evidence?.identity?.revision,
  ];
  const selected = candidates.find((value) => Number.isSafeInteger(Number(value)));
  return selected === undefined ? null : Number(selected);
}

function resultProjection(result) {
  const answer = typeof result?.answer === 'string' ? result.answer : null;
  const sweepOutputs = Array.isArray(result?.sweepOutputs) ? result.sweepOutputs : null;
  if (sweepOutputs && sweepOutputs.length > SWEEP_RECEIPT_MAX_COUNT) {
    throw typedError('pgs_receipt_too_large');
  }
  const projectedSweeps = sweepOutputs?.map((sweep) => {
    if (!sweep || typeof sweep !== 'object' || Array.isArray(sweep)
        || !['workUnitId', 'partitionId', 'provider', 'model', 'output']
          .every((key) => typeof sweep[key] === 'string' && sweep[key].trim())) {
      throw typedError('pgs_receipt_invalid');
    }
    const output = sweep.output;
    return {
      workUnitId: sweep.workUnitId,
      partitionId: sweep.partitionId,
      provider: sweep.provider,
      model: sweep.model,
      outputBytes: Buffer.byteLength(output, 'utf8'),
      outputSha256: sha256Bytes(Buffer.from(output)),
      outputExcerpt: output.slice(0, SWEEP_EXCERPT_CHARACTERS),
    };
  }) ?? null;
  const pgs = result?.metadata?.pgs;
  const metadata = pgs && typeof pgs === 'object' && !Array.isArray(pgs)
    ? {
      pgs: {
        successfulSweeps: Number.isSafeInteger(pgs.successfulSweeps)
          ? pgs.successfulSweeps : null,
        retryablePartitions: Array.isArray(pgs.retryablePartitions)
          ? pgs.retryablePartitions.map(String).slice(0, SWEEP_RECEIPT_MAX_COUNT) : [],
      },
    }
    : null;
  return {
    answerPresent: Boolean(answer && answer.trim()),
    answerBytes: answer ? Buffer.byteLength(answer, 'utf8') : 0,
    answerSha256: answer ? sha256Bytes(Buffer.from(answer)) : null,
    sweepOutputCount: sweepOutputs?.length ?? null,
    sweepOutputs: projectedSweeps,
    metadata,
  };
}

async function protectedTerminal(client, operationId, signal) {
  const status = await client.inspectOperation(operationId, 'status', signal);
  if (!status || !TERMINAL.has(status.state)) {
    throw typedError('operation_not_terminal', JSON.stringify({
      operationId,
      state: status?.state ?? null,
      attachmentState: status?.attachmentState ?? null,
    }));
  }
  const terminal = await client.inspectOperation(operationId, 'result', signal);
  if (!terminal || !TERMINAL.has(terminal.state)) throw typedError('operation_not_terminal');
  return terminal;
}

function authorityFields(context, values, baseUrl) {
  if (context.authority === 'live') {
    if (!baseUrl) throw typedError('base_url_required');
    return { authorizedEndpoint: baseUrl, isolatedStore: null };
  }
  const store = one(values, 'isolated-store') || one(values, 'isolated-fixture');
  if (!store) throw typedError('isolated_store_required');
  return { authorizedEndpoint: null, isolatedStore: path.resolve(store) };
}

function activityEventSequence(activity) {
  const value = activity?.eventSequence ?? activity?.sequence;
  return Number.isSafeInteger(value) ? value : null;
}

function canonicalActivityPayload(activity) {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(activity);
    delete descriptors.observedAttachments;
    const payload = Object.create(Object.getPrototypeOf(activity));
    Object.defineProperties(payload, descriptors);
    const encoded = canonicalJson(payload);
    return {
      bytes: Buffer.byteLength(encoded, 'utf8'),
      encoded,
      value: JSON.parse(encoded),
    };
  } catch (error) {
    throw typedError('operation_event_invalid', 'operation activity is not canonical JSON', {
      cause: error,
    });
  }
}

export function createActivityCollector({
  maxEvents = MAX_ACTIVITY_EVENTS,
  maxEventBytes = MAX_ACTIVITY_EVENT_BYTES,
  maxRetainedBytes = MAX_ACTIVITY_RETAINED_BYTES,
} = {}) {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1
      || !Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1
      || !Number.isSafeInteger(maxRetainedBytes) || maxRetainedBytes < 1) {
    throw typedError('operation_activity_limit_invalid');
  }
  const events = [];
  const byIdentity = new Map();
  const canonicalPayloads = new Map();
  const observationsByAttachment = new Map();
  const duplicateDeliveriesByOperation = new Map();
  let duplicateDeliveries = 0;
  let retainedBytes = 0;

  function add(activity, attachment = 'primary') {
    const sequence = activityEventSequence(activity);
    if (typeof attachment !== 'string' || !attachment
        || typeof activity?.operationId !== 'string' || !activity.operationId
        || sequence === null || !ACTIVITY_TYPES.has(activity.type)) {
      throw typedError('operation_event_invalid');
    }
    const identity = `${activity.operationId}\0${sequence}`;
    if (Number.isSafeInteger(activity.eventSequence)
        && Number.isSafeInteger(activity.sequence)
        && activity.eventSequence !== activity.sequence) {
      throw typedError(
        byIdentity.has(identity) ? 'operation_event_identity_conflict' : 'operation_event_invalid',
        identity,
      );
    }
    const payload = canonicalActivityPayload(activity);
    if (payload.bytes > maxEventBytes) {
      throw typedError('operation_activity_event_too_large');
    }
    const existing = byIdentity.get(identity);
    if (existing) {
      if (canonicalPayloads.get(identity) !== payload.encoded) {
        throw typedError('operation_event_identity_conflict', identity);
      }
      duplicateDeliveries += 1;
      duplicateDeliveriesByOperation.set(
        activity.operationId,
        (duplicateDeliveriesByOperation.get(activity.operationId) || 0) + 1,
      );
      if (!existing.observedAttachments.includes(attachment)) {
        existing.observedAttachments.push(attachment);
        existing.observedAttachments.sort();
      }
    } else {
      if (events.length >= maxEvents) throw typedError('operation_activity_limit_exceeded');
      if (retainedBytes + payload.bytes > maxRetainedBytes) {
        throw typedError('operation_activity_bytes_exceeded');
      }
      const captured = {
        ...payload.value,
        eventSequence: sequence,
        observedAttachments: [attachment],
      };
      byIdentity.set(identity, captured);
      canonicalPayloads.set(identity, payload.encoded);
      events.push(captured);
      retainedBytes += payload.bytes;
    }
    const attachmentObservations = observationsByAttachment.get(attachment) || new Map();
    attachmentObservations.set(
      activity.operationId,
      (attachmentObservations.get(activity.operationId) || 0) + 1,
    );
    observationsByAttachment.set(attachment, attachmentObservations);
  }

  return Object.freeze({
    events,
    listener(attachment) {
      return (activity) => add(activity, attachment);
    },
    add,
    summary(operationId = null) {
      const selected = operationId
        ? events.filter((event) => event.operationId === operationId)
        : events;
      return {
        uniqueEvents: selected.length,
        duplicateDeliveries: operationId
          ? duplicateDeliveriesByOperation.get(operationId) || 0
          : duplicateDeliveries,
        attachments: [...observationsByAttachment.entries()]
          .map(([attachment, byOperation]) => ({
            attachment,
            observations: operationId
              ? byOperation.get(operationId) || 0
              : [...byOperation.values()].reduce((total, value) => total + value, 0),
          }))
          .filter((entry) => entry.observations > 0)
          .sort((left, right) => left.attachment.localeCompare(right.attachment)),
      };
    },
  });
}

function terminalResultProviderPair(terminal) {
  const source = terminal?.operationType === 'query'
    ? terminal?.result?.metadata
    : ['research_compile', 'synthesis'].includes(terminal?.operationType)
      ? terminal?.result
      : null;
  if (!source || typeof source.provider !== 'string' || !source.provider.trim()
      || typeof source.model !== 'string' || !source.model.trim()) {
    return null;
  }
  return { provider: source.provider, model: source.model };
}

function providerTerminalEventValid(evidence, terminal, { retained = false } = {}) {
  const structurallyValid = evidence
    && (retained
      ? evidence.evidenceSource === 'durable-operation-store'
      : evidence.type === 'provider_call_terminal')
    && evidence.operationId === terminal.operationId
    && Number.isSafeInteger(evidence.eventSequence)
    && typeof evidence.phase === 'string' && Boolean(evidence.phase.trim())
    && typeof evidence.provider === 'string' && Boolean(evidence.provider.trim())
    && typeof evidence.model === 'string' && Boolean(evidence.model.trim())
    && typeof evidence.providerCallId === 'string' && Boolean(evidence.providerCallId.trim())
    && (evidence.workUnitId === undefined
      || (typeof evidence.workUnitId === 'string' && Boolean(evidence.workUnitId.trim())))
    && (evidence.partitionId === undefined
      || (typeof evidence.partitionId === 'string' && Boolean(evidence.partitionId.trim())))
    && PROVIDER_TERMINAL_OUTCOMES.has(evidence.outcome);
  if (!structurallyValid) return false;
  const expectedIdentity = PROVIDER_TERMINAL_IDENTITIES.get(terminal.operationType);
  if (!expectedIdentity) return true;
  const expectedPair = terminalResultProviderPair(terminal);
  return expectedPair !== null
    && evidence.phase === expectedIdentity.phase
    && evidence.providerCallId === expectedIdentity.providerCallId
    && expectedPair.provider === evidence.provider
    && expectedPair.model === evidence.model;
}

function dedupeProviderTerminalEvents(events) {
  const byCall = new Map();
  const bySequence = new Map();
  const unique = [];
  for (const event of events) {
    const signature = JSON.stringify({
      operationId: event.operationId,
      eventSequence: event.eventSequence,
      phase: event.phase,
      provider: event.provider,
      model: event.model,
      providerCallId: event.providerCallId,
      outcome: event.outcome,
      workUnitId: event.workUnitId ?? null,
      partitionId: event.partitionId ?? null,
    });
    const priorCall = byCall.get(event.providerCallId);
    const priorSequence = bySequence.get(event.eventSequence);
    if ((priorCall !== undefined && priorCall !== signature)
        || (priorSequence !== undefined && priorSequence !== signature)) {
      return null;
    }
    if (priorCall === signature) continue;
    byCall.set(event.providerCallId, signature);
    bySequence.set(event.eventSequence, signature);
    unique.push(event);
  }
  return unique;
}

function pgsProviderTerminalCoverage(terminal, events, synthesisPair) {
  const sweeps = terminal.result?.sweepOutputs;
  const successfulSweeps = terminal.result?.metadata?.pgs?.successfulSweeps;
  if (!Array.isArray(sweeps) || sweeps.length === 0
      || !Number.isSafeInteger(successfulSweeps)
      || successfulSweeps !== sweeps.length) {
    return false;
  }
  const workUnitPartitions = new Map();
  for (const sweep of sweeps) {
    if (!sweep || typeof sweep.workUnitId !== 'string' || !sweep.workUnitId
        || typeof sweep.partitionId !== 'string' || !sweep.partitionId
        || workUnitPartitions.has(sweep.workUnitId)) {
      return false;
    }
    workUnitPartitions.set(sweep.workUnitId, sweep.partitionId);
  }
  const sweepsCovered = sweeps.every((sweep) => sweep
    && typeof sweep.workUnitId === 'string' && sweep.workUnitId
    && typeof sweep.partitionId === 'string' && sweep.partitionId
    && typeof sweep.provider === 'string' && sweep.provider
    && typeof sweep.model === 'string' && sweep.model
    && events.some((event) => event.phase === 'pgs_sweep'
      && event.outcome === 'complete'
      && event.providerCallId === `pgs:${sweep.workUnitId}`
      && event.workUnitId === sweep.workUnitId
      && event.partitionId === sweep.partitionId
      && event.provider === sweep.provider
      && event.model === sweep.model));
  if (!sweepsCovered) return false;
  const answerComplete = typeof terminal.result?.answer === 'string'
    && Boolean(terminal.result.answer.trim());
  return synthesisPair
    && typeof synthesisPair.provider === 'string' && Boolean(synthesisPair.provider.trim())
    && typeof synthesisPair.model === 'string' && Boolean(synthesisPair.model.trim())
    && events.some((event) => event.phase === 'pgs_synthesis'
    && event.providerCallId === 'pgs:synthesis'
    && event.provider === synthesisPair.provider
    && event.model === synthesisPair.model
    && (answerComplete ? event.outcome === 'complete' : event.outcome === 'failed'));
}

function providerTerminalProof(terminal, activityLog, retainedEvidence, {
  pgsSynthesisPair = null,
} = {}) {
  const streamedRaw = activityLog.filter((activity) =>
    activity?.operationId === terminal.operationId
      && activity?.type === 'provider_call_terminal');
  if (streamedRaw.some((event) => !providerTerminalEventValid(event, terminal))) {
    return { validated: false, source: null };
  }
  const retainedProvided = retainedEvidence !== null && retainedEvidence !== undefined;
  if (retainedProvided && !providerTerminalEventValid(retainedEvidence, terminal, { retained: true })) {
    return { validated: false, source: null };
  }
  const coversTerminal = (events) => {
    let covered = events.length > 0;
    if (terminal.state === 'complete') {
      covered = covered && events.some((event) => event.outcome === 'complete');
    }
    if (terminal.operationType === 'pgs') {
      covered = covered && pgsProviderTerminalCoverage(terminal, events, pgsSynthesisPair);
    }
    return covered;
  };
  const retainedEvents = retainedProvided ? [retainedEvidence] : [];
  const streamedEvents = dedupeProviderTerminalEvents(streamedRaw);
  const uniqueRetainedEvents = dedupeProviderTerminalEvents(retainedEvents);
  const combinedEvents = dedupeProviderTerminalEvents([...streamedRaw, ...retainedEvents]);
  if (streamedEvents === null || uniqueRetainedEvents === null || combinedEvents === null) {
    return { validated: false, source: null };
  }
  const streamedValidated = coversTerminal(streamedEvents);
  const retainedValidated = coversTerminal(uniqueRetainedEvents);
  const combinedValidated = coversTerminal(combinedEvents);
  return {
    validated: combinedValidated,
    source: streamedValidated ? 'operation-stream'
      : retainedValidated ? 'durable-operation-store'
        : combinedValidated ? 'operation-stream+durable-operation-store'
          : null,
  };
}

function terminalReceipt({
  context, values, baseUrl, callerAgent, scenario, terminal, activityLog = [], extras = {},
  retainedProviderTerminalEvidence = null,
}) {
  const pgsSynthesisPair = terminal.operationType === 'pgs'
    ? exactPair(values, 'pgs-synth-selection')
    : null;
  const providerProof = PROVIDER_OPERATION_TYPES.has(terminal.operationType)
    ? providerTerminalProof(terminal, activityLog, retainedProviderTerminalEvidence, {
        pgsSynthesisPair,
      })
    : null;
  const providerTerminalValidated = providerProof?.validated ?? null;
  if (PROVIDER_OPERATION_TYPES.has(terminal.operationType)
      && ['complete', 'partial'].includes(terminal.state)
      && providerTerminalValidated !== true) {
    throw typedError('provider_terminal_unproven', JSON.stringify({
      operationId: terminal.operationId,
      operationType: terminal.operationType,
      observedActivity: activityLog
        .filter((activity) => activity?.operationId === terminal.operationId)
        .map((activity) => ({ type: activity.type, eventSequence: activity.eventSequence })),
    }));
  }
  if (typeof terminal.lastProgressAt !== 'string'
      || !Number.isFinite(Date.parse(terminal.lastProgressAt))) {
    throw typedError('operation_progress_timestamp_missing');
  }
  return {
    helper: 'live-brain-tools-smoke',
    scenario,
    receiptKind: 'operation-terminal',
    operationId: terminal.operationId,
    operationType: terminal.operationType,
    state: terminal.state,
    protectedResultRead: true,
    requesterAgent: callerAgent,
    ...authorityFields(context, values, baseUrl),
    target: terminal.target,
    resultHandle: terminal.resultHandle,
    resultArtifact: terminal.resultArtifact,
    sourcePinDescriptor: terminal.sourcePinDescriptor ?? null,
    sourcePinDigest: terminal.sourcePinDigest ?? null,
    sourceEvidence: terminal.sourceEvidence,
    sourceHealth: terminal.sourceEvidence?.sourceHealth ?? null,
    matchOutcome: terminal.sourceEvidence?.matchOutcome ?? null,
    sourceRevision: evidenceRevision(terminal.sourceEvidence),
    authoritativeNodeCount: Number.isSafeInteger(
      Number(terminal.sourceEvidence?.authoritativeTotals?.nodes),
    ) ? Number(terminal.sourceEvidence.authoritativeTotals.nodes) : null,
    providerTerminalValidated,
    providerTerminalEvidenceSource: PROVIDER_OPERATION_TYPES.has(terminal.operationType)
      ? providerProof.source
      : null,
    lastProgressAt: terminal.lastProgressAt,
    error: terminal.error,
    result: resultProjection(terminal.result),
    ...extras,
  };
}

async function ensureFreshOutput(file) {
  try {
    await fsp.lstat(file);
    throw typedError('receipt_output_exists', file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readLastReceipt(file) {
  const rows = await readReceiptRows(file);
  return rows.at(-1);
}

function parseReceiptDocument(text) {
  const trimmed = text.trim();
  if (!trimmed) throw typedError('receipt_invalid');
  try {
    const document = JSON.parse(trimmed);
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw typedError('receipt_invalid');
    }
    return [document];
  } catch (error) {
    if (error?.code === 'receipt_invalid') throw error;
  }
  const rows = [];
  let offset = 0;
  while (offset <= trimmed.length) {
    const newline = trimmed.indexOf('\n', offset);
    const end = newline === -1 ? trimmed.length : newline;
    const line = trimmed.slice(offset, end).trim();
    offset = newline === -1 ? trimmed.length + 1 : newline + 1;
    if (!line) continue;
    if (rows.length >= MAX_RECEIPT_ROWS) throw typedError('receipt_row_limit_exceeded');
    let row;
    try { row = JSON.parse(line); } catch (error) {
      throw typedError('receipt_invalid', 'receipt contains invalid JSON', { cause: error });
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw typedError('receipt_invalid');
    }
    rows.push(row);
  }
  if (rows.length === 0) throw typedError('receipt_invalid');
  return rows;
}

export async function readReceiptRows(file, { verifyArtifact = true } = {}) {
  const text = await readBoundedFile(file, {
    maxBytes: MAX_RECEIPT_BYTES,
    encoding: 'utf8',
    errorCode: 'receipt_invalid',
    requireSingleLink: true,
  });
  return parseReceiptDocument(text).map((row) => {
    if (verifyArtifact) {
      const { artifactSha256, ...core } = row;
      if (typeof artifactSha256 !== 'string'
          || artifactSha256 !== sha256Bytes(Buffer.from(JSON.stringify(core)))) {
        throw typedError('receipt_artifact_hash_mismatch');
      }
    }
    return row;
  });
}

async function canaryFromReceipt(values, context, callerAgent) {
  const file = one(values, 'canary-receipt', { required: true });
  const receipt = await readLastReceipt(path.resolve(file));
  if (!receipt.query || !receipt.nodeId || !Number.isSafeInteger(receipt.sourceRevision)
      || !['healthy', 'degraded'].includes(receipt.sourceHealth)
      || receipt.scenario !== 'discover-canary'
      || typeof receipt.selectedBrain !== 'string' || !receipt.selectedBrain
      || receipt.receiptRunId !== context.receiptRunId
      || receipt.authority !== context.authority
      || receipt.requesterAgent !== callerAgent) {
    throw typedError('canary_receipt_invalid');
  }
  try { assertPositiveSourceEvidence(receipt.sourceEvidence); }
  catch { throw typedError('canary_receipt_invalid'); }
  return receipt;
}

function assertPositiveSourceEvidence(evidence) {
  const authoritativeNodes = evidence?.authoritativeTotals?.nodes;
  const returnedNodes = evidence?.returnedTotals?.nodes;
  const exactPositive = evidence?.matchOutcome === 'matches'
    && Number.isSafeInteger(authoritativeNodes) && authoritativeNodes > 0
    && Number.isSafeInteger(returnedNodes) && returnedNodes > 0
    && returnedNodes <= authoritativeNodes;
  if (exactPositive && evidence?.sourceHealth === 'healthy') return;
  if (exactPositive && evidence?.sourceHealth === 'degraded'
      && evidence.freshness === 'unknown') {
    return;
  }
  throw typedError('source_evidence_not_useful');
}

function assertTerminalBrainIdentity(terminal, expectedBrain = null, errorCode = 'brain_target_mismatch') {
  const targetBrain = terminal?.target?.brainId;
  const evidenceBrain = terminal?.sourceEvidence?.selectedBrain;
  if (typeof targetBrain !== 'string' || !targetBrain
      || typeof evidenceBrain !== 'string' || !evidenceBrain
      || targetBrain !== evidenceBrain
      || (expectedBrain !== null && (typeof expectedBrain !== 'string'
        || !expectedBrain || targetBrain !== expectedBrain))) {
    throw typedError(errorCode);
  }
  return targetBrain;
}

function assertCompleteTerminal(terminal, {
  expectedBrain = null,
  targetErrorCode = 'brain_target_mismatch',
  sourcePolicy = 'positive',
} = {}) {
  if (terminal?.state !== 'complete') throw typedError('operation_success_required');
  if (sourcePolicy === 'healthy' && terminal?.sourceEvidence?.sourceHealth !== 'healthy') {
    throw typedError('source_health_unhealthy');
  }
  if (sourcePolicy === 'positive') assertPositiveSourceEvidence(terminal?.sourceEvidence);
  return assertTerminalBrainIdentity(terminal, expectedBrain, targetErrorCode);
}

function assertCanaryEvidence(terminal, canary) {
  const revision = evidenceRevision(terminal?.sourceEvidence);
  if (revision !== canary.sourceRevision) {
    throw typedError('canary_source_revision_mismatch');
  }
  assertTerminalBrainIdentity(terminal, canary?.selectedBrain, 'canary_target_mismatch');
  assertPositiveSourceEvidence(terminal?.sourceEvidence);
}

function nonemptyAnswer(result) {
  const answer = result?.answer ?? result?.text ?? result?.content;
  return typeof answer === 'string' && Boolean(answer.trim());
}

function usefulPgsResult(terminal) {
  if (terminal?.state === 'complete') return nonemptyAnswer(terminal.result);
  const sweeps = terminal?.result?.sweepOutputs;
  const successfulSweeps = terminal?.result?.metadata?.pgs?.successfulSweeps;
  return terminal?.state === 'partial'
    && Array.isArray(sweeps) && sweeps.length > 0
    && Number.isSafeInteger(successfulSweeps)
    && successfulSweeps === sweeps.length
    && sweeps.every((sweep) => sweep
      && typeof sweep.output === 'string' && Boolean(sweep.output.trim()));
}

function usefulProtectedResult(terminal) {
  if (terminal?.operationType === 'pgs') return usefulPgsResult(terminal);
  if (terminal?.operationType === 'research_compile') {
    return terminal.state === 'complete'
      && typeof terminal.result?.relativePath === 'string'
      && Boolean(terminal.result.relativePath.trim());
  }
  return terminal?.state === 'complete' && nonemptyAnswer(terminal?.result);
}

function assertCanaryBoundUsefulResult(terminal, canary) {
  const revision = evidenceRevision(terminal?.sourceEvidence);
  assertTerminalBrainIdentity(terminal, canary?.selectedBrain, 'canary_target_mismatch');
  if (revision !== canary.sourceRevision) throw typedError('canary_source_revision_mismatch');
  assertPositiveSourceEvidence(terminal?.sourceEvidence);
  if (!usefulProtectedResult(terminal)) throw typedError('operation_success_required');
}

function nodesFromGraph(value) {
  if (Array.isArray(value?.nodes)) return value.nodes;
  if (Array.isArray(value?.graph?.nodes)) return value.graph.nodes;
  return [];
}

function edgesFromGraph(value) {
  if (Array.isArray(value?.edges)) return value.edges;
  if (Array.isArray(value?.graph?.edges)) return value.graph.edges;
  return [];
}

function resultsFromSearch(value) {
  return Array.isArray(value?.results) ? value.results : [];
}

function deriveCanaryQuery(node) {
  const concept = typeof node?.concept === 'string' ? node.concept.trim() : '';
  const tokens = concept.split(/\s+/).filter((token) => token.length >= 5 && token.length <= 64);
  const query = tokens.slice(0, 4).join(' ') || String(node?.id || '').trim();
  if (!query) throw typedError('canary_unavailable');
  return query.slice(0, 256);
}

async function awaitShortResult(client, initial, signal) {
  if (!initial?.operationId || !['queued', 'running'].includes(initial.state)) return initial;
  await client.resumeOperation(initial.operationId, signal);
  const terminal = await protectedTerminal(client, initial.operationId, signal);
  if (!['complete', 'partial'].includes(terminal.state) || !terminal.result) {
    throw typedError(terminal.error?.code || 'brain_operation_failed');
  }
  return {
    ...terminal.result,
    operationId: terminal.operationId,
    state: terminal.state,
    attachmentState: terminal.attachmentState,
    resultHandle: terminal.resultHandle,
    resultArtifact: terminal.resultArtifact,
    sourceEvidence: terminal.sourceEvidence,
  };
}

async function discoverCanary({ client, selector, signal }) {
  const target = await client.resolveTarget(selector);
  if (typeof target?.id !== 'string' || !target.id
      || typeof target?.ownerAgent !== 'string' || !target.ownerAgent) {
    throw typedError('canary_target_invalid');
  }
  const graph = await awaitShortResult(
    client,
    await client.graph({
      ...(selector ? { target: selector } : {}), nodeLimit: 100, edgeLimit: 1,
    }, signal),
    signal,
  );
  const candidates = nodesFromGraph(graph).filter((node) => node?.id != null);
  for (const node of candidates) {
    const query = deriveCanaryQuery(node);
    const search = await awaitShortResult(
      client,
      await client.search({ ...(selector ? { target: selector } : {}), query, topK: 20 }, signal),
      signal,
    );
    const match = resultsFromSearch(search).find((result) => String(result.id) === String(node.id));
    const revision = evidenceRevision(search.sourceEvidence);
    if (match && Number.isSafeInteger(revision)) {
      try {
        assertPositiveSourceEvidence(search.sourceEvidence);
        return { target, graph, search, query, nodeId: String(node.id), sourceRevision: revision };
      } catch { /* try another exact positive canary */ }
    }
  }
  throw typedError('canary_unavailable');
}

export async function readResponseBytesBounded(response, {
  maxBytes = MAX_HTTP_JSON_BYTES,
  errorCode = 'http_response_invalid',
} = {}) {
  if (!response || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw typedError(errorCode);
  }
  const cancelSafely = async (target) => {
    try { await target?.cancel?.(); } catch { /* cancellation is best-effort */ }
  };
  const declared = response.headers?.get?.('content-length');
  if (declared !== null && declared !== undefined && declared !== '') {
    const contentLength = Number(declared);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      await cancelSafely(response.body);
      throw typedError(errorCode, 'response body exceeds bounded reader');
    }
  }
  if (!response.body) return Buffer.alloc(0);
  let reader;
  try {
    reader = response.body.getReader();
  } catch (error) {
    throw typedError(errorCode, 'response body is not a readable byte stream', { cause: error });
  }
  if (!reader || typeof reader.read !== 'function'
      || typeof reader.cancel !== 'function'
      || typeof reader.releaseLock !== 'function') {
    await cancelSafely(reader);
    throw typedError(errorCode, 'response body is not a readable byte stream');
  }
  const chunks = [];
  let total = 0;
  let chunkCount = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        throw typedError(errorCode, 'response body yielded a non-byte chunk');
      }
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      total += chunk.length;
      chunkCount += 1;
      if (total > maxBytes || chunkCount > 100_000) {
        await cancelSafely(reader);
        throw typedError(errorCode, 'response body exceeds bounded reader');
      }
      if (chunk.length > 0) chunks.push(chunk);
    }
  } catch (error) {
    await cancelSafely(reader);
    if (error?.code === errorCode) throw error;
    throw typedError(errorCode, 'response body read failed', { cause: error });
  } finally {
    try { reader.releaseLock(); } catch { /* stream already released by cancellation */ }
  }
  return Buffer.concat(chunks, total);
}

export async function readResponseJsonBounded(response, options = {}) {
  const errorCode = options.errorCode || 'http_response_invalid';
  const bytes = await readResponseBytesBounded(response, options);
  if (bytes.length === 0) return null;
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw typedError(errorCode, 'response contains invalid JSON', { cause: error });
  }
}

async function fetchJson(url, init = {}, fetchImpl = fetch, timeoutMs = 30_000) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  let body;
  try {
    body = await readResponseJsonBounded(response, {
      maxBytes: MAX_HTTP_JSON_BYTES,
      errorCode: 'http_response_invalid',
    });
  } catch (error) {
    if (response.ok) throw error;
    body = null;
  }
  if (!response.ok) {
    throw typedError(body?.error?.code || 'http_request_failed', body?.error?.message || `HTTP ${response.status}`, {
      status: response.status, body,
    });
  }
  return body;
}

export async function discoverHealthyModels(baseUrl, fetchImpl = fetch) {
  const requests = ['direct-query', 'pgs-sweep', 'pgs-synthesis']
    .map((purpose) => ({ purpose }));
  const probes = [];
  for (const request of requests) {
    const probe = await fetchJson(`${baseUrl}/api/providers/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(request),
    }, fetchImpl, 120_000);
    if (probe?.healthy !== true || probe?.terminalReceived !== true
        || probe?.purpose !== request.purpose
        || !probe?.requestedPair?.provider || !probe?.requestedPair?.model
        || probe?.pair?.provider !== probe.requestedPair.provider
        || probe?.pair?.model !== probe.requestedPair.model
        || probe?.observedPair?.provider !== probe.requestedPair.provider
        || probe?.observedPair?.model !== probe.requestedPair.model) {
      throw typedError('no_healthy_provider');
    }
    probes.push({
      purpose: request.purpose,
      pair: probe.requestedPair,
      healthy: true,
      terminalReceived: true,
      latency: probe.latency ?? null,
      timestamp: probe.timestamp ?? null,
    });
  }
  const pairFor = (purpose) => probes.find((probe) => probe.purpose === purpose)?.pair;
  return {
    modelSelection: pairFor('direct-query'),
    pgsSweep: pairFor('pgs-sweep'),
    pgsSynth: pairFor('pgs-synthesis'),
    probes,
  };
}

async function mcpCall(baseUrl, name, args, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: `acceptance-${Date.now()}`,
      method: 'tools/call', params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const textBody = (await readResponseBytesBounded(response, {
    maxBytes: MAX_MCP_RESPONSE_BYTES,
    errorCode: 'mcp_result_invalid',
  })).toString('utf8');
  let body = null;
  try {
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      let messages = 0;
      let offset = 0;
      while (offset <= textBody.length) {
        const newline = textBody.indexOf('\n', offset);
        const end = newline === -1 ? textBody.length : newline;
        const line = textBody.slice(offset, end);
        offset = newline === -1 ? textBody.length + 1 : newline + 1;
        if (!line.startsWith('data: ')) continue;
        messages += 1;
        if (messages > 10_000) throw typedError('mcp_result_invalid');
        const message = JSON.parse(line.slice(6));
        if (message?.result || message?.error) body = message;
      }
    } else {
      body = textBody ? JSON.parse(textBody) : null;
    }
  } catch (error) {
    throw typedError('mcp_result_invalid', 'MCP returned an invalid protocol response', {
      cause: error,
    });
  }
  if (!response.ok) {
    throw typedError(
      body?.error?.code || 'mcp_failed',
      body?.error?.message || `MCP failed with HTTP ${response.status}`,
      { status: response.status },
    );
  }
  if (body?.error) throw typedError(body.error.code || 'mcp_failed', body.error.message || 'MCP failed');
  const text = body?.result?.content?.find((entry) => entry?.type === 'text')?.text;
  if (typeof text !== 'string') throw typedError('mcp_result_invalid');
  try { return JSON.parse(text); } catch (error) { throw typedError('mcp_result_invalid', text.slice(0, 256), { cause: error }); }
}

async function verifyMcpParity({ client, baseUrl, canary, signal, fetchImpl = fetch }) {
  const dashboard = await client.search({ query: canary.query, topK: 20 }, signal);
  const mcp = await mcpCall(baseUrl, 'query_memory', { query: canary.query, limit: 20 }, fetchImpl);
  const mcpEvidence = mcp.evidence || mcp.sourceEvidence;
  const dashboardIds = new Set(resultsFromSearch(dashboard).map((result) => String(result.id)));
  const mcpIds = new Set(resultsFromSearch(mcp).map((result) => String(result.id)));
  if (!dashboardIds.has(canary.nodeId) || !mcpIds.has(canary.nodeId)) throw typedError('mcp_canary_mismatch');
  const dashboardRevision = evidenceRevision(dashboard.sourceEvidence);
  const mcpRevision = evidenceRevision(mcpEvidence);
  if (dashboardRevision !== canary.sourceRevision || mcpRevision !== canary.sourceRevision) {
    throw typedError('mcp_source_revision_mismatch');
  }
  try {
    assertPositiveSourceEvidence(dashboard.sourceEvidence);
    assertPositiveSourceEvidence(mcpEvidence);
  } catch { throw typedError('mcp_source_evidence_not_useful'); }
  if (typeof canary.selectedBrain !== 'string' || !canary.selectedBrain
      || dashboard.sourceEvidence?.selectedBrain !== canary.selectedBrain
      || mcpEvidence?.selectedBrain !== canary.selectedBrain) {
    throw typedError('mcp_target_mismatch', JSON.stringify({
      canary: canary.selectedBrain ?? null,
      dashboard: dashboard.sourceEvidence?.selectedBrain ?? null,
      mcp: mcpEvidence?.selectedBrain ?? null,
    }));
  }
  return { dashboard, mcp, nodeId: canary.nodeId, sourceRevision: canary.sourceRevision };
}

async function validateUnavailableMcp({ baseUrl, expectedReasons, fetchImpl = fetch }) {
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/api/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (expectedReasons.includes('mcp_unreachable')) return { reason: 'mcp_unreachable' };
    throw error;
  }
  const body = await readResponseJsonBounded(response, {
    maxBytes: 256 * 1024,
    errorCode: 'mcp_result_invalid',
  }).catch(() => null);
  const reason = body?.mcp?.reason;
  if (response.ok || !expectedReasons.includes(reason)) throw typedError('mcp_unavailability_mismatch');
  return { reason, status: response.status };
}

export async function flushActivity(context, output, activities, callerAgent, scenario, authority) {
  if (!output) return;
  if (!Array.isArray(activities) || activities.length > MAX_ACTIVITY_EVENTS) {
    throw typedError('operation_activity_limit_exceeded');
  }
  await ensureFreshOutput(output);
  const previousByOperation = new Map();
  const seen = new Set();
  const ordered = [...activities].sort((left, right) => {
    const operation = String(left?.operationId || '').localeCompare(String(right?.operationId || ''));
    return operation || Number(activityEventSequence(left)) - Number(activityEventSequence(right));
  });
  for (const activity of ordered) {
    const previous = previousByOperation.get(activity.operationId) ?? -1;
    const sequence = activityEventSequence(activity);
    const identity = `${activity.operationId}\0${sequence}`;
    if (typeof activity.operationId !== 'string' || !activity.operationId
        || !ACTIVITY_TYPES.has(activity.type)
        || sequence === null || sequence <= previous || seen.has(identity)) {
      throw typedError('operation_event_out_of_order');
    }
    seen.add(identity);
    previousByOperation.set(activity.operationId, sequence);
    await appendJsonlReceipt(context, output, {
      helper: 'live-brain-tools-smoke',
      scenario,
      receiptKind: 'operation-event',
      requesterAgent: callerAgent,
      operationId: activity.operationId,
      type: activity.type,
      eventSequence: sequence,
      streamAttachments: Array.isArray(activity.observedAttachments)
        ? [...new Set(activity.observedAttachments.map(String))].sort()
        : [],
      state: activity.state,
      phase: activity.phase,
      eventUpdatedAt: activity.updatedAt,
      lastProviderActivityAt: activity.lastProviderActivityAt,
      lastProgressAt: activity.lastProgressAt,
      protectedResultRead: false,
      eventAuthority: authority,
    });
  }
}

async function canonicalExportScenario({ modules, client, values, context, callerAgent, signal }) {
  const receiptPath = path.resolve(one(values, 'operation-receipt', { required: true }));
  const rows = await readReceiptRows(receiptPath);
  const terminals = rows.filter((row) => row.receiptKind === 'operation-terminal');
  if (terminals.length !== 1) throw typedError('operation_receipt_invalid');
  const source = terminals[0];
  if (!source.operationId || source.receiptRunId !== context.receiptRunId
      || source.authority !== context.authority || source.requesterAgent !== callerAgent
      || source.protectedResultRead !== true) throw typedError('operation_receipt_invalid');
  const result = await runTool(modules.brainQueryExportTool, {
    operationId: source.operationId,
    ...(source.resultHandle ? { resultHandle: source.resultHandle } : {}),
    format: one(values, 'format', { defaultValue: 'markdown' }),
  }, client, callerAgent, signal);
  const exportResult = parseToolJson(result, 'brain_query_export');
  if (exportResult.sourceOperationId !== source.operationId
      || exportResult.canonicalEvidence !== true
      || typeof exportResult.exportHandle !== 'string' || !exportResult.exportHandle
      || typeof exportResult.relativePath !== 'string' || !exportResult.relativePath
      || typeof exportResult.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(exportResult.sha256)
      || !Number.isSafeInteger(exportResult.bytes) || exportResult.bytes < 0) {
    throw typedError('canonical_export_invalid');
  }
  return {
    helper: 'live-brain-tools-smoke', scenario: 'canonical-export', receiptKind: 'export',
    operationId: source.operationId, sourceReceipt: receiptPath,
    protectedResultRead: true, exportResult,
  };
}

async function lifecycleStart(client, values, signal) {
  const query = one(values, 'query', { defaultValue: 'controlled lifecycle acceptance canary' });
  const modelSelection = exactPair(values, 'model-selection');
  return client.start('query', { query, mode: 'quick', ...(modelSelection ? { modelSelection } : {}) }, signal);
}

function negativeCatalogPlan(catalog, callerAgent, code) {
  const brains = Array.isArray(catalog?.brains) ? catalog.brains : [];
  const resident = brains.filter((brain) => brain?.kind === 'resident'
    && brain.lifecycle === 'resident');
  if (code === 'target_not_found') {
    return { method: 'resolveTarget', input: { brainId: 'brain-negative-target-missing' } };
  }
  if (code === 'target_not_available') {
    const unavailable = brains.find((brain) => !((brain?.kind === 'resident'
      && brain.lifecycle === 'resident')
      || (brain?.kind === 'research' && brain.lifecycle === 'completed')));
    return unavailable
      ? { method: 'resolveTarget', input: { brainId: unavailable.id } }
      : null;
  }
  if (code === 'target_mismatch') {
    const counts = new Map();
    for (const brain of resident) {
      counts.set(brain.ownerAgent, (counts.get(brain.ownerAgent) || 0) + 1);
    }
    const byAgent = resident.find((brain) => counts.get(brain.ownerAgent) === 1);
    const byId = resident.find((brain) => brain.id !== byAgent?.id);
    return byAgent && byId
      ? {
          method: 'resolveTarget',
          input: { agent: byAgent.ownerAgent, brainId: byId.id },
        }
      : null;
  }
  if (code === 'target_ambiguous') {
    const counts = new Map();
    for (const brain of resident) {
      counts.set(brain.ownerAgent, (counts.get(brain.ownerAgent) || 0) + 1);
    }
    const ambiguous = resident.find((brain) => counts.get(brain.ownerAgent) > 1);
    return ambiguous
      ? { method: 'resolveTarget', input: { agent: ambiguous.ownerAgent } }
      : null;
  }
  if (code === 'access_denied') {
    const readOnly = brains.find((brain) => ((brain?.kind === 'resident'
      && brain.lifecycle === 'resident')
      || (brain?.kind === 'research' && brain.lifecycle === 'completed'))
      && brain.ownerAgent !== callerAgent);
    return readOnly
      ? {
          method: 'probeAccessDenied',
          input: {
            target: { brainId: readOnly.id },
          },
        }
      : null;
  }
  return null;
}

async function attemptNegativeCode(source, callerAgent, code, signal) {
  const providerEvidence = async () => {
    if (typeof source.client.providerEvidence === 'function') {
      const evidence = await source.client.providerEvidence();
      if (!evidence || !Number.isSafeInteger(evidence.providerCalls)
          || evidence.providerCalls < 0) {
        throw typedError('negative_target_provider_evidence_invalid');
      }
      return { ...evidence };
    }
    const calls = source.client.providerCalls;
    return Number.isSafeInteger(calls) && calls >= 0
      ? { evidenceSource: 'instrumented-client-counter', providerCalls: calls }
      : null;
  };
  const providerBefore = await providerEvidence();
  const catalog = await source.client.getCatalog({ forceRefresh: true, signal });
  const plan = negativeCatalogPlan(catalog, callerAgent, code);
  if (!plan || typeof source.client[plan.method] !== 'function') return null;
  try {
    await source.client[plan.method](plan.input, signal);
    const providerAfter = await providerEvidence();
    if (providerBefore && providerAfter
        && providerAfter.providerCalls !== providerBefore.providerCalls) {
      throw typedError('negative_target_provider_boundary_crossed', code);
    }
  } catch (error) {
    const providerAfter = await providerEvidence();
    const providerCallDelta = providerBefore && providerAfter
      ? providerAfter.providerCalls - providerBefore.providerCalls
      : null;
    if (providerCallDelta !== null && providerCallDelta !== 0) {
      throw typedError('negative_target_provider_boundary_crossed', code);
    }
    if (error?.code !== code) return null;
    return {
      code,
      source: source.source,
      authority: source.authority,
      route: plan.method === 'probeAccessDenied'
        ? 'controlled-production-route-authority'
        : 'BrainOperationsClient.resolveTarget',
      providerFree: providerCallDelta === 0 ? true : null,
      providerBoundaryEvidence: providerBefore && providerAfter ? {
        before: providerBefore,
        after: providerAfter,
        providerCallDelta,
      } : null,
    };
  }
  return null;
}

export async function collectNegativeTargetCoverage({
  client,
  controlledClient = null,
  callerAgent,
  expectedCodes,
  signal = null,
  primaryAuthority = 'live',
} = {}) {
  if (!Array.isArray(expectedCodes)
      || expectedCodes.length !== NEGATIVE_TARGET_CODES.length
      || new Set(expectedCodes).size !== NEGATIVE_TARGET_CODES.length
      || NEGATIVE_TARGET_CODES.some((code) => !expectedCodes.includes(code))) {
    throw typedError('negative_target_expected_codes_invalid');
  }
  if (!client || typeof client.getCatalog !== 'function'
      || typeof callerAgent !== 'string' || !callerAgent) {
    throw typedError('negative_target_client_invalid');
  }
  const sources = [{
    client,
    source: client.source || 'live-client',
    authority: primaryAuthority,
  }];
  if (controlledClient) {
    sources.push({
      client: controlledClient,
      source: controlledClient.source || 'controlled-production-client',
      authority: 'isolated-controlled',
    });
  }
  const coverage = [];
  for (const code of NEGATIVE_TARGET_CODES) {
    let result = null;
    let unproven = null;
    for (const source of sources) {
      const attempted = await attemptNegativeCode(source, callerAgent, code, signal);
      if (!attempted) continue;
      if (attempted.providerFree === true
          && attempted.providerBoundaryEvidence?.providerCallDelta === 0) {
        result = attempted;
        break;
      }
      unproven ||= attempted;
    }
    if (!result) {
      if (unproven) throw typedError('negative_target_provider_evidence_incomplete', code);
      throw typedError('negative_target_coverage_failed', code);
    }
    coverage.push(result);
  }
  const measuredProviderDeltas = coverage
    .map((entry) => entry.providerBoundaryEvidence?.providerCallDelta)
    .filter((value) => Number.isSafeInteger(value));
  return {
    expectedCodes: [...NEGATIVE_TARGET_CODES],
    observedCodes: coverage.map((entry) => entry.code),
    providerCallsObserved: measuredProviderDeltas.length === coverage.length
      ? measuredProviderDeltas.reduce((total, value) => total + value, 0)
      : null,
    providerEvidenceComplete: measuredProviderDeltas.length === coverage.length,
    coverage,
  };
}

function controlledNegativeBoundaries(root) {
  return [
    { kind: 'brain', path: root },
    { kind: 'run', path: root },
    { kind: 'pgs', path: path.join(root, 'pgs-sessions') },
    { kind: 'session', path: path.join(root, 'sessions') },
    { kind: 'cache', path: path.join(root, 'cache') },
    { kind: 'export', path: path.join(root, 'exports') },
    { kind: 'agency', path: path.join(root, 'agency') },
  ];
}

export function createControlledNegativeTargetClient({ Client, callerAgent } = {}) {
  if (typeof Client !== 'function' || typeof callerAgent !== 'string' || !callerAgent) {
    throw typedError('negative_target_client_invalid');
  }
  const { resolveCanonicalTarget } = require('../cosmo23/server/lib/brain-registry.js');
  const { authorizeBrainOperation } = require('../shared/brain-operations/authority.cjs');
  const entry = ({ id, ownerAgent, kind = 'resident', lifecycle = 'resident' }) => {
    const canonicalRoot = `/controlled-negative/${id}`;
    return {
      id,
      ownerAgent,
      displayName: id,
      kind,
      lifecycle,
      canonicalRoot,
      sourceType: 'controlled-production-fixture',
      nodeCount: 1,
      modifiedAt: '2026-07-11T00:00:00.000Z',
      route: `/controlled-negative/api/${id}`,
      mutationBoundaries: controlledNegativeBoundaries(canonicalRoot),
    };
  };
  const catalog = Object.freeze({
    catalogRevision: 'controlled-negative-v1',
    brains: Object.freeze([
      entry({ id: 'brain-controlled-owner', ownerAgent: callerAgent }),
      entry({ id: 'brain-controlled-sibling', ownerAgent: 'controlled-sibling' }),
      entry({
        id: 'brain-controlled-unavailable', ownerAgent: 'controlled-unavailable',
        kind: 'research', lifecycle: 'active',
      }),
      entry({ id: 'brain-controlled-ambiguous-a', ownerAgent: 'controlled-ambiguous' }),
      entry({ id: 'brain-controlled-ambiguous-b', ownerAgent: 'controlled-ambiguous' }),
    ]),
  });
  const response = (status, body) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
  let providerCalls = 0;
  let operationRequests = 0;
  let authorizationDenials = 0;
  const fetchImpl = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/home23/api/brain-operations/catalog') return response(200, catalog);
    if (pathname === '/home23/api/brain-operations' && init.method === 'POST') {
      operationRequests += 1;
      try {
        const body = JSON.parse(String(init.body || '{}'));
        const selected = resolveCanonicalTarget(catalog, callerAgent, body.target || {});
        const accessMode = selected.kind === 'resident'
          && selected.lifecycle === 'resident'
          && selected.ownerAgent === callerAgent ? 'own' : 'read-only';
        authorizeBrainOperation({
          requesterAgent: callerAgent,
          operationType: body.operationType,
          target: {
            domain: 'brain',
            brainId: selected.id,
            canonicalRoot: selected.canonicalRoot,
            accessMode,
            ownerAgent: selected.ownerAgent,
            displayName: selected.displayName,
            kind: selected.kind,
            lifecycle: selected.lifecycle,
            catalogRevision: catalog.catalogRevision,
            route: selected.route,
            mutationBoundaries: selected.mutationBoundaries,
          },
        });
        providerCalls += 1;
        return response(500, { error: { code: 'negative_probe_unexpected_success' } });
      } catch (error) {
        if (error?.code === 'access_denied') authorizationDenials += 1;
        return response(error?.code === 'access_denied' ? 403 : 400, {
          error: {
            code: error?.code || 'negative_probe_failed',
            message: error?.message || 'negative probe failed',
            retryable: false,
          },
        });
      }
    }
    return response(404, { error: { code: 'route_not_found' } });
  };
  const production = new Client({
    baseUrl: 'http://controlled-negative.invalid',
    callerAgent,
    fetchImpl,
    statusReadMs: 1_000,
  });
  return Object.freeze({
    source: 'controlled-production-client',
    getCatalog: production.getCatalog.bind(production),
    resolveTarget: production.resolveTarget.bind(production),
    async probeAccessDenied(request, signal) {
      const responseValue = await fetchImpl('http://controlled-negative.invalid/home23/api/brain-operations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          operationType: 'synthesis',
          requestId: 'negative-target-acceptance',
          target: request?.target,
          parameters: {
            trigger: 'negative-target-acceptance',
            reason: 'prove authorization rejects before provider work',
          },
        }),
        signal,
      });
      const body = await readResponseJsonBounded(responseValue, {
        maxBytes: 256 * 1024,
        errorCode: 'negative_probe_response_invalid',
      });
      if (!responseValue.ok || body?.error) {
        throw typedError(
          body?.error?.code || 'negative_probe_failed',
          body?.error?.message || 'negative probe failed',
        );
      }
      return body;
    },
    providerEvidence() {
      return {
        evidenceSource: 'controlled-production-route-counters',
        providerCalls,
        operationRequests,
        authorizationDenials,
      };
    },
  });
}

const IDENTITY_GROUP_NAMES = Object.freeze([
  'jerryLive', 'forrestLive', 'isolatedControlled',
]);
const IDENTITY_MANIFEST_KEYS = Object.freeze([
  'schemaVersion', 'receiptRunId', 'authorities', 'auditRoot', 'createdAt', 'groups',
]);
const IDENTITY_ENTRY_KEYS = Object.freeze([
  'operationId', 'authority', 'requesterAgent', 'receipt',
  'isolatedStore', 'authorizedEndpoint',
]);

function exactIdentityKeys(value, expected) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw typedError('identity_manifest_invalid');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== expected.length
      || keys.some((key) => typeof key !== 'string' || !expected.includes(key))) {
    throw typedError('identity_manifest_invalid');
  }
  return value;
}

function strictIsoTimestamp(value) {
  const milliseconds = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function assertProtectedReadback(terminal, receipt, result) {
  const fields = [
    'operationId', 'operationType', 'state', 'target', 'resultHandle', 'resultArtifact',
    'sourcePinDescriptor', 'sourcePinDigest', 'sourceEvidence', 'error',
  ];
  for (const field of fields) {
    const actual = Object.hasOwn(terminal, field) ? terminal[field] : null;
    const expected = Object.hasOwn(receipt, field) ? receipt[field] : null;
    if (!isDeepStrictEqual(actual, expected)) {
      throw typedError('protected_readback_mismatch', field);
    }
  }
  if (!isDeepStrictEqual(resultProjection(result), receipt.result)) {
    throw typedError('protected_readback_mismatch', 'result');
  }
}

async function verifyArtifactStream(opened, expected) {
  if (!opened || !isDeepStrictEqual(opened.metadata, expected)
      || !opened.stream || typeof opened.stream[Symbol.asyncIterator] !== 'function') {
    throw typedError('protected_readback_mismatch', 'resultArtifact');
  }
  if (!Number.isSafeInteger(expected?.bytes) || expected.bytes < 0
      || expected.bytes > MAX_RESULT_ARTIFACT_BYTES
      || typeof expected.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expected.sha256)) {
    throw typedError('result_artifact_bound_invalid');
  }
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of opened.stream) {
    if (!(chunk instanceof Uint8Array)) throw typedError('result_artifact_chunk_invalid');
    bytes += chunk.byteLength;
    if (bytes > expected.bytes || bytes > MAX_RESULT_ARTIFACT_BYTES) {
      throw typedError('result_artifact_too_large');
    }
    hash.update(chunk);
  }
  if (bytes !== expected.bytes || hash.digest('hex') !== expected.sha256) {
    throw typedError('protected_readback_mismatch', 'resultArtifact');
  }
}

function wrongRequesterFor(requesterAgent) {
  return requesterAgent === 'wrong-requester' ? 'other-requester' : 'wrong-requester';
}

async function collectReceiptOperationInventory(root, excluded) {
  const operations = new Map();
  for (const file of await collectArtifactFiles(root, excluded)) {
    const rows = await artifactRows(file.absolute);
    const canonical = rows.some((row) => Object.hasOwn(row, 'artifactSha256'));
    if (!canonical) continue;
    if (rows.some((row) => !Object.hasOwn(row, 'artifactSha256'))) {
      throw typedError('artifact_receipt_mixed', file.relative);
    }
    for (const row of await readReceiptRows(file.absolute)) {
      if (typeof row.operationId !== 'string' || !row.operationId) continue;
      const current = operations.get(row.operationId) || {
        terminalCount: 0,
        paths: new Set(),
      };
      if (row.receiptKind === 'operation-terminal') current.terminalCount += 1;
      current.paths.add(file.relative);
      operations.set(row.operationId, current);
    }
  }
  return operations;
}

function cosmoAuthorityEndpoints(baseUrl, operationId) {
  let parsed;
  try { parsed = new URL(baseUrl); }
  catch (error) {
    throw typedError('cosmo_base_url_invalid', 'COSMO base URL is invalid', { cause: error });
  }
  const loopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'http:' || !loopback || parsed.username || parsed.password
      || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw typedError('cosmo_base_url_invalid');
  }
  const root = `${parsed.origin}/api/internal/brain-operations/${operationId}`;
  return [
    { action: 'status', endpoint: `${root}/status`, method: 'GET' },
    { action: 'result', endpoint: `${root}/result`, method: 'GET' },
    { action: 'cancel', endpoint: `${root}/cancel`, method: 'POST' },
  ];
}

export async function proveCosmoAuthorityRejection({
  baseUrl,
  operationId,
  signal,
  fetchImpl,
  timeoutMs = 10_000,
}) {
  const endpoints = cosmoAuthorityEndpoints(baseUrl, operationId);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw typedError('cosmo_authority_rejection_unproven');
  }
  const probes = [];
  for (const probe of endpoints) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    let response;
    let body;
    try {
      response = await fetchImpl(probe.endpoint, {
        method: probe.method,
        headers: {
          accept: 'application/json',
          ...(probe.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(probe.method === 'POST' ? { body: '{}' } : {}),
        redirect: 'error',
        signal: requestSignal,
      });
      body = await readResponseJsonBounded(response, {
        maxBytes: 256 * 1024,
        errorCode: 'cosmo_authority_rejection_unproven',
      });
    } catch (error) {
      if (error?.code === 'cosmo_authority_rejection_unproven') throw error;
      throw typedError('cosmo_authority_rejection_unproven', probe.action, { cause: error });
    }
    if (response.ok || response.status !== 401 || body?.success !== false
        || body?.error?.code !== 'capability_invalid') {
      throw typedError('cosmo_authority_rejection_unproven', probe.action);
    }
    probes.push({
      action: probe.action,
      endpoint: probe.endpoint,
      method: probe.method,
      status: response.status,
      code: body.error.code,
    });
  }
  return {
    operationId,
    probes,
  };
}

export async function verifyReceiptManifest({
  manifestPath,
  modules,
  context,
  values,
  callerAgent,
  signal,
  clientFactory = null,
  storeReaderFactory = null,
  fetchImpl = fetch,
}) {
  const manifest = exactIdentityKeys(await readJson(manifestPath), IDENTITY_MANIFEST_KEYS);
  const manifestRealPath = await fsp.realpath(manifestPath);
  if (manifest.schemaVersion !== 1
      || manifest.receiptRunId !== context.receiptRunId
      || !Array.isArray(manifest.authorities)
      || manifest.authorities.length !== 2
      || [...manifest.authorities].sort().join(',') !== 'isolated-controlled,live'
      || manifest.auditRoot !== context.receiptRunDir
      || path.dirname(manifestRealPath) !== context.receiptRunDir
      || !strictIsoTimestamp(manifest.createdAt)) {
    throw typedError('identity_manifest_invalid');
  }
  const auditRoot = await canonicalDirectory(manifest.auditRoot, 'identity manifest audit root');
  if (auditRoot.path !== context.receiptRunDir) throw typedError('identity_manifest_invalid');
  exactIdentityKeys(manifest.groups, IDENTITY_GROUP_NAMES);
  for (const groupName of IDENTITY_GROUP_NAMES) {
    if (!Array.isArray(manifest.groups[groupName]) || manifest.groups[groupName].length === 0) {
      throw typedError('identity_manifest_invalid');
    }
  }
  const identityOperationCount = IDENTITY_GROUP_NAMES.reduce(
    (total, groupName) => total + manifest.groups[groupName].length,
    0,
  );
  if (!Number.isSafeInteger(identityOperationCount)
      || identityOperationCount > MAX_IDENTITY_OPERATIONS) {
    throw typedError('identity_manifest_invalid');
  }

  const jerryBaseUrl = one(values, 'base-url', { required: true });
  const forrestBaseUrl = one(values, 'forrest-base-url', { required: true });
  const cosmoBaseUrl = one(values, 'cosmo-base-url', { required: true });
  if (typeof jerryBaseUrl !== 'string' || typeof forrestBaseUrl !== 'string'
      || typeof cosmoBaseUrl !== 'string'
      || jerryBaseUrl === forrestBaseUrl || callerAgent !== 'jerry') {
    throw typedError('identity_manifest_invalid');
  }
  const makeClient = clientFactory || ((options) => {
    if (typeof modules?.BrainOperationsClient !== 'function') {
      throw typedError('built_brain_tools_unavailable');
    }
    return new modules.BrainOperationsClient({
      ...options,
      queryWaitMs: QUERY_WAIT_MS,
      pgsWaitMs: PGS_WAIT_MS,
    });
  });
  const makeStoreReader = storeReaderFactory || ((options) => {
    const { createBrainOperationStoreReader } = require(
      '../engine/src/dashboard/brain-operations/store-reader.js'
    );
    return createBrainOperationStoreReader(options);
  });

  const observed = [];
  const seenOperations = new Set();
  const liveEntries = { jerryLive: [], forrestLive: [] };
  const isolatedWrongRequesterReads = [];
  for (const groupName of IDENTITY_GROUP_NAMES) {
    for (const rawEntry of manifest.groups[groupName]) {
      const entry = exactIdentityKeys(rawEntry, IDENTITY_ENTRY_KEYS);
      if (!/^brop_[A-Za-z0-9_-]{32}$/.test(entry.operationId)
          || typeof entry.requesterAgent !== 'string' || !entry.requesterAgent
          || typeof entry.receipt !== 'string' || !entry.receipt
          || path.isAbsolute(entry.receipt)
          || path.normalize(entry.receipt) !== entry.receipt
          || seenOperations.has(entry.operationId)) {
        throw typedError('identity_manifest_invalid');
      }
      seenOperations.add(entry.operationId);
      const receiptPath = path.resolve(context.receiptRunDir, entry.receipt);
      if (!isInsideOrEqual(context.receiptRunDir, receiptPath)
          || await fsp.realpath(receiptPath) !== receiptPath) {
        throw typedError('identity_manifest_invalid');
      }
      const rows = await readReceiptRows(receiptPath);
      const terminals = rows.filter((row) => row.operationId === entry.operationId
        && row.receiptKind === 'operation-terminal');
      if (terminals.length !== 1
          || rows.some((row) => row.receiptKind === 'operation-terminal'
            && row.operationId !== entry.operationId)) {
        throw typedError('receipt_terminal_duplicate');
      }
      const receipt = terminals[0];
      if (!TERMINAL.has(receipt.state)
          || receipt.protectedResultRead !== true
          || receipt.receiptRunId !== context.receiptRunId
          || receipt.operationId !== entry.operationId
          || receipt.authority !== entry.authority
          || receipt.requesterAgent !== entry.requesterAgent) {
        throw typedError('identity_manifest_mismatch');
      }
      for (const row of rows.filter((candidate) => candidate.operationId === entry.operationId)) {
        if (row.receiptRunId !== receipt.receiptRunId
            || row.authority !== receipt.authority
            || row.requesterAgent !== receipt.requesterAgent
            || (Object.hasOwn(row, 'authorizedEndpoint')
              && row.authorizedEndpoint !== receipt.authorizedEndpoint)
            || (Object.hasOwn(row, 'isolatedStore')
              && row.isolatedStore !== receipt.isolatedStore)) {
          throw typedError('receipt_identity_conflict');
        }
      }

      if (groupName === 'jerryLive' || groupName === 'forrestLive') {
        const expectedRequester = groupName === 'jerryLive' ? 'jerry' : 'forrest';
        const expectedEndpoint = groupName === 'jerryLive' ? jerryBaseUrl : forrestBaseUrl;
        if (entry.authority !== 'live'
            || entry.requesterAgent !== expectedRequester
            || entry.authorizedEndpoint !== expectedEndpoint
            || entry.isolatedStore !== null
            || receipt.authorizedEndpoint !== expectedEndpoint
            || receipt.isolatedStore !== null) {
          throw typedError('identity_manifest_mismatch');
        }
        const client = makeClient({
          baseUrl: expectedEndpoint,
          callerAgent: expectedRequester,
        });
        const terminal = await protectedTerminal(client, entry.operationId, signal);
        assertProtectedReadback(terminal, receipt, terminal.result);
        liveEntries[groupName].push(entry);
        observed.push({
          group: groupName,
          operationId: entry.operationId,
          state: receipt.state,
          readback: 'live-protected-result',
        });
        continue;
      }

      if (entry.authority !== 'isolated-controlled'
          || entry.authorizedEndpoint !== null
          || receipt.authorizedEndpoint !== null
          || typeof entry.isolatedStore !== 'string'
          || receipt.isolatedStore !== entry.isolatedStore) {
        throw typedError('identity_manifest_mismatch');
      }
      const storeRoot = await canonicalDirectory(entry.isolatedStore, 'isolated operation store');
      if (storeRoot.path !== entry.isolatedStore
          || isInsideOrEqual(context.receiptRunDir, storeRoot.path)
          || isInsideOrEqual(storeRoot.path, context.receiptRunDir)) {
        throw typedError('identity_manifest_mismatch');
      }
      const reader = makeStoreReader({
        operationsRoot: storeRoot.path,
        expectedRequester: entry.requesterAgent,
      });
      const record = await reader.getAuthorized(entry.operationId);
      if (!TERMINAL.has(record.state)) throw typedError('protected_readback_mismatch');
      let result = null;
      if (record.resultArtifact?.mediaType === 'application/x-ndjson') {
        const opened = await reader.openResultArtifactAuthorized(
          entry.operationId,
          record.resultHandle || undefined,
        );
        await verifyArtifactStream(opened, record.resultArtifact);
      } else if (record.result !== null || record.resultHandle !== null) {
        result = await reader.getResultAuthorized(
          entry.operationId,
          record.resultHandle || undefined,
        );
      }
      assertProtectedReadback(record, receipt, result);
      const wrongRequester = wrongRequesterFor(entry.requesterAgent);
      const wrongReader = makeStoreReader({
        operationsRoot: storeRoot.path,
        expectedRequester: wrongRequester,
        liveStore: reader.store,
      });
      let wrongCode = null;
      try { await wrongReader.getAuthorized(entry.operationId); }
      catch (error) { wrongCode = error?.code || null; }
      if (wrongCode !== 'access_denied') throw typedError('wrong_requester_read_succeeded');
      isolatedWrongRequesterReads.push({
        operationId: entry.operationId,
        requesterAgent: wrongRequester,
        code: wrongCode,
      });
      observed.push({
        group: groupName,
        operationId: entry.operationId,
        state: receipt.state,
        readback: 'isolated-production-store-reader',
      });
    }
  }

  const inventory = await collectReceiptOperationInventory(
    context.receiptRunDir,
    new Set([manifestRealPath]),
  );
  for (const [operationId, item] of inventory) {
    if (!seenOperations.has(operationId)) {
      throw typedError('identity_manifest_unlisted_operation', operationId);
    }
    if (item.terminalCount !== 1) throw typedError('receipt_terminal_duplicate', operationId);
  }
  for (const operationId of seenOperations) {
    if (!inventory.has(operationId)) throw typedError('identity_manifest_mismatch', operationId);
  }

  const wrongRequesterReads = [];
  for (const [groupName, entries] of Object.entries(liveEntries)) {
    const wrongEndpoint = groupName === 'jerryLive' ? forrestBaseUrl : jerryBaseUrl;
    const wrongRequester = groupName === 'jerryLive' ? 'forrest' : 'jerry';
    for (const entry of entries) {
      const wrongClient = makeClient({ baseUrl: wrongEndpoint, callerAgent: wrongRequester });
      let code = null;
      try { await wrongClient.inspectOperation(entry.operationId, 'result', signal); }
      catch (error) { code = error?.code || null; }
      if (!['access_denied', 'operation_not_found', 'result_not_found'].includes(code)) {
        throw typedError('wrong_requester_read_succeeded');
      }
      wrongRequesterReads.push({
        operationId: entry.operationId,
        viaRequester: wrongRequester,
        viaEndpoint: wrongEndpoint,
        code,
      });
    }
  }
  const cosmoAuthorityRejection = await proveCosmoAuthorityRejection({
    baseUrl: cosmoBaseUrl,
    operationId: liveEntries.jerryLive[0].operationId,
    signal,
    fetchImpl,
  });
  return {
    ok: true,
    observed,
    wrongRequesterReads,
    isolatedWrongRequesterReads,
    cosmoAuthorityRejection,
  };
}

function artifactAuthority(relativePath, context) {
  const [top] = relativePath.split(path.sep);
  if (top === 'live') return 'live';
  if (top === 'isolated-controlled') return 'isolated-controlled';
  return context.authority;
}

async function artifactRows(file) {
  const extension = path.extname(file).toLowerCase();
  if (!['.json', '.jsonl', '.ndjson'].includes(extension)) return [];
  const text = await readBoundedFile(file, {
    maxBytes: MAX_RECEIPT_BYTES,
    encoding: 'utf8',
    errorCode: 'artifact_json_invalid',
    requireSingleLink: true,
  });
  try { return parseReceiptDocument(text); }
  catch (error) {
    throw typedError('artifact_json_invalid', `invalid JSON artifact: ${file}`, { cause: error });
  }
}

async function collectArtifactFiles(root, excluded) {
  const files = [];
  let entries = 0;
  async function walk(directory) {
    const before = await fsp.lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw typedError('artifact_tree_invalid');
    const names = [];
    const handle = await fsp.opendir(directory);
    try {
      for await (const entry of handle) {
        names.push(entry.name);
        entries += 1;
        if (entries > MAX_ARTIFACT_FILES) throw typedError('artifact_file_limit_exceeded');
      }
    } finally {
      await handle.close().catch(() => {});
    }
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const stat = await fsp.lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) throw typedError('artifact_symlink_refused', relative);
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile() && !excluded.has(absolute)) {
        if (files.length >= MAX_ARTIFACT_FILES) throw typedError('artifact_file_limit_exceeded');
        files.push({ absolute, relative });
      }
      else if (!stat.isFile()) throw typedError('artifact_tree_invalid', relative);
    }
    const after = await fsp.lstat(directory, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw typedError('artifact_tree_changed_concurrently');
    }
  }
  await walk(root);
  return files.sort((left, right) => left.relative.localeCompare(right.relative));
}

export async function buildArtifactManifest({ smokeRoot, output, context } = {}) {
  const root = await canonicalDirectory(smokeRoot, 'smoke root');
  if (root.path !== context.receiptRunDir) throw typedError('smoke_root_mismatch');
  const manifestPath = path.resolve(output);
  if (!isInsideOrEqual(root.path, manifestPath) || manifestPath === root.path) {
    throw typedError('output_path_invalid');
  }
  const digestPath = path.join(
    path.dirname(manifestPath),
    `${path.basename(manifestPath, path.extname(manifestPath))}.sha256`,
  );
  await ensureFreshOutput(manifestPath);
  await ensureFreshOutput(digestPath);
  const artifacts = [];
  let terminalOperations = 0;
  for (const file of await collectArtifactFiles(root.path, new Set([manifestPath, digestPath]))) {
    const authority = artifactAuthority(file.relative, context);
    const rows = await artifactRows(file.absolute);
    const looksCanonical = rows.some((row) => Object.hasOwn(row, 'artifactSha256'));
    if (looksCanonical && rows.some((row) => !Object.hasOwn(row, 'artifactSha256'))) {
      throw typedError('artifact_receipt_mixed', file.relative);
    }
    if (looksCanonical) {
      const canonicalRows = await readReceiptRows(file.absolute);
      if (canonicalRows.some((row) => row.receiptRunId !== context.receiptRunId
          || row.authority !== authority)) {
        throw typedError('artifact_authority_mismatch', file.relative);
      }
      terminalOperations += canonicalRows.filter((row) => row.receiptKind === 'operation-terminal'
        && typeof row.operationId === 'string' && row.operationId).length;
    } else {
      for (const row of rows) {
        if (Object.hasOwn(row, 'receiptRunId') && row.receiptRunId !== context.receiptRunId) {
          throw typedError('artifact_run_id_mismatch', file.relative);
        }
        if (Object.hasOwn(row, 'authority') && row.authority !== authority) {
          throw typedError('artifact_authority_mismatch', file.relative);
        }
      }
    }
    const hashed = await hashFile(file.absolute);
    artifacts.push({
      path: file.relative,
      kind: looksCanonical ? 'receipt' : 'raw',
      receiptRunId: context.receiptRunId,
      authority,
      size: hashed.physicalSize,
      sha256: hashed.sha256,
      dev: hashed.dev,
      ino: hashed.ino,
      nlink: Number((await fsp.lstat(file.absolute, { bigint: true })).nlink),
      mtimeNs: hashed.mtimeNs,
      ctimeNs: hashed.ctimeNs,
    });
  }
  if (terminalOperations === 0) throw typedError('operation_inventory_empty');
  const row = await writeJsonReceipt(context, manifestPath, {
    helper: 'live-brain-tools-smoke',
    scenario: 'verify-receipts',
    receiptKind: 'artifact-manifest',
    schemaVersion: 1,
    auditRoot: root.path,
    authorities: [...new Set(artifacts.map((entry) => entry.authority))].sort(),
    artifacts,
  });
  const manifestHash = await hashFile(manifestPath, { maxBytes: MAX_ARTIFACT_MANIFEST_BYTES });
  const digest = manifestHash.sha256;
  const temporary = `${digestPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${digest}  ${path.basename(manifestPath)}\n`, {
    mode: 0o600, flag: 'wx',
  });
  try {
    await fsp.link(temporary, digestPath);
  } catch (error) {
    if (error.code === 'EEXIST') throw typedError('receipt_output_exists', digestPath);
    throw error;
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
  return row;
}

export async function verifyArtifactManifest({ manifestPath, context } = {}) {
  const manifestFile = path.resolve(manifestPath);
  if (!isInsideOrEqual(context.receiptRunDir, manifestFile)) {
    throw typedError('artifact_manifest_invalid');
  }
  const digestPath = path.join(
    path.dirname(manifestFile),
    `${path.basename(manifestFile, path.extname(manifestFile))}.sha256`,
  );
  const [manifestBytes, digestBytes] = await Promise.all([
    readBoundedFile(manifestFile, {
      maxBytes: MAX_ARTIFACT_MANIFEST_BYTES,
      errorCode: 'artifact_manifest_invalid',
      requireSingleLink: true,
    }),
    readBoundedFile(digestPath, {
      maxBytes: 1024,
      errorCode: 'artifact_manifest_invalid',
      requireSingleLink: true,
    }),
  ]).catch((error) => {
    throw typedError('artifact_manifest_invalid', 'artifact manifest unavailable', { cause: error });
  });
  const digestMatch = /^([a-f0-9]{64})  ([^\r\n]+)\n?$/.exec(digestBytes.toString('utf8'));
  if (!digestMatch || digestMatch[2] !== path.basename(manifestFile)
      || digestMatch[1] !== sha256Bytes(manifestBytes)) {
    throw typedError('artifact_manifest_digest_mismatch');
  }
  const manifestRows = await readReceiptRows(manifestFile);
  if (manifestRows.length !== 1) throw typedError('artifact_manifest_invalid');
  const manifest = manifestRows[0];
  if (manifest.receiptKind !== 'artifact-manifest'
      || manifest.receiptRunId !== context.receiptRunId
      || manifest.authority !== context.authority
      || manifest.auditRoot !== context.receiptRunDir
      || !Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw typedError('artifact_manifest_invalid');
  }
  const excluded = new Set([manifestFile, digestPath]);
  const actualFiles = await collectArtifactFiles(context.receiptRunDir, excluded);
  const actualPaths = actualFiles.map((entry) => entry.relative);
  const expectedPaths = manifest.artifacts.map((entry) => entry.path);
  if (new Set(expectedPaths).size !== expectedPaths.length
      || JSON.stringify(actualPaths) !== JSON.stringify([...expectedPaths].sort())) {
    throw typedError('artifact_path_set_mismatch');
  }
  let terminalOperations = 0;
  for (const entry of manifest.artifacts) {
    if (!entry || typeof entry.path !== 'string'
        || entry.receiptRunId !== context.receiptRunId
        || !['live', 'isolated-controlled'].includes(entry.authority)
        || !['receipt', 'raw'].includes(entry.kind)
        || !/^[a-f0-9]{64}$/.test(entry.sha256)
        || typeof entry.dev !== 'string' || typeof entry.ino !== 'string'
        || !Number.isSafeInteger(entry.nlink) || entry.nlink !== 1) {
      throw typedError('artifact_manifest_invalid');
    }
    const absolute = path.join(context.receiptRunDir, entry.path);
    if (!isInsideOrEqual(context.receiptRunDir, absolute)) throw typedError('artifact_manifest_invalid');
    const hashed = await hashFile(absolute);
    const stat = await fsp.lstat(absolute, { bigint: true });
    if (hashed.sha256 !== entry.sha256 || hashed.physicalSize !== entry.size
        || hashed.dev !== entry.dev || hashed.ino !== entry.ino
        || hashed.mtimeNs !== entry.mtimeNs || hashed.ctimeNs !== entry.ctimeNs
        || Number(stat.nlink) !== entry.nlink) {
      throw typedError('artifact_identity_mismatch', entry.path);
    }
    const expectedAuthority = artifactAuthority(entry.path, context);
    if (entry.authority !== expectedAuthority) throw typedError('artifact_authority_mismatch');
    const rows = await artifactRows(absolute);
    const looksCanonical = rows.some((row) => Object.hasOwn(row, 'artifactSha256'));
    if ((entry.kind === 'receipt') !== looksCanonical) throw typedError('artifact_manifest_invalid');
    if (looksCanonical) {
      const canonicalRows = await readReceiptRows(absolute);
      if (canonicalRows.some((row) => row.receiptRunId !== context.receiptRunId
          || row.authority !== entry.authority)) {
        throw typedError('artifact_authority_mismatch');
      }
      terminalOperations += canonicalRows.filter((row) => row.receiptKind === 'operation-terminal'
        && typeof row.operationId === 'string' && row.operationId).length;
    } else {
      for (const row of rows) {
        if ((Object.hasOwn(row, 'receiptRunId') && row.receiptRunId !== context.receiptRunId)
            || (Object.hasOwn(row, 'authority') && row.authority !== entry.authority)) {
          throw typedError('artifact_authority_mismatch');
        }
      }
    }
  }
  if (terminalOperations === 0) throw typedError('operation_inventory_empty');
  return {
    ok: true,
    artifactCount: manifest.artifacts.length,
    operationCount: terminalOperations,
    manifestSha256: digestMatch[1],
  };
}

export async function executeScenario({
  scenario,
  modules,
  client,
  values,
  context,
  baseUrl,
  callerAgent,
  signal,
  fetchImpl = fetch,
  activityLog = [],
  controlledNegativeClient = null,
  canaryOverride = null,
} = {}) {
  const selector = targetSelector(values);
  if (scenario === 'discover-canary') {
    const discovered = await discoverCanary({ client, selector, signal });
    const terminal = await protectedTerminal(client, discovered.search.operationId, signal);
    assertCompleteTerminal(terminal, {
      expectedBrain: discovered.target?.id,
      targetErrorCode: 'canary_target_mismatch',
    });
    if (evidenceRevision(terminal.sourceEvidence) !== discovered.sourceRevision) {
      throw typedError('canary_source_revision_mismatch');
    }
    return terminalReceipt({
      context, values, baseUrl, callerAgent, scenario, terminal, activityLog,
      extras: {
        query: discovered.query,
        nodeId: discovered.nodeId,
        sourceRevision: discovered.sourceRevision,
        sourceHealth: terminal.sourceEvidence.sourceHealth,
        selectedBrain: discovered.target.id,
        selectedAgent: discovered.target.ownerAgent,
      },
    });
  }
  if (scenario === 'canonical-export') {
    return canonicalExportScenario({ modules, client, values, context, callerAgent, signal });
  }
  if (scenario === 'mcp-parity') {
    const canary = await canaryFromReceipt(values, context, callerAgent);
    const parity = await verifyMcpParity({ client, baseUrl, canary, signal, fetchImpl });
    const terminal = await protectedTerminal(client, parity.dashboard.operationId, signal);
    assertCompleteTerminal(terminal, {
      expectedBrain: canary.selectedBrain,
      targetErrorCode: 'mcp_target_mismatch',
    });
    assertCanaryEvidence(terminal, canary);
    return terminalReceipt({ context, values, baseUrl, callerAgent, scenario, terminal, activityLog, extras: {
      mcpParity: true, nodeId: parity.nodeId, sourceRevision: parity.sourceRevision,
    } });
  }
  if (scenario === 'mcp-unavailable') {
    const expectedReasons = String(one(values, 'expect-reason', { required: true })).split(',');
    return {
      helper: 'live-brain-tools-smoke', scenario, receiptKind: 'typed-unavailability',
      protectedResultRead: false, requesterAgent: callerAgent,
      ...authorityFields(context, values, baseUrl),
      ...(await validateUnavailableMcp({ baseUrl, expectedReasons, fetchImpl })),
    };
  }
  if (scenario === 'zero-result') {
    const query = one(values, 'query', { required: true });
    const search = await client.search({ query, topK: 100 }, signal);
    const terminal = await protectedTerminal(client, search.operationId, signal);
    const selectedBrain = assertCompleteTerminal(terminal, {
      targetErrorCode: 'zero_result_target_mismatch',
      sourcePolicy: 'healthy',
    });
    const evidence = terminal.sourceEvidence || {};
    if (search.sourceEvidence?.selectedBrain !== selectedBrain
        || resultsFromSearch(search).length !== 0 || evidence.sourceHealth !== 'healthy'
        || evidence.matchOutcome !== 'no_match'
        || evidence.completeCoverage !== true
        || Number(evidence.authoritativeTotals?.nodes ?? evidence.authoritativeTotal) <= 0) {
      throw typedError('zero_result_not_proven', JSON.stringify({
        resultCount: resultsFromSearch(search).length,
        selectedBrain,
        resultSelectedBrain: search.sourceEvidence?.selectedBrain ?? null,
        sourceHealth: evidence.sourceHealth ?? null,
        matchOutcome: evidence.matchOutcome ?? null,
        completeCoverage: evidence.completeCoverage ?? null,
        authoritativeTotal: evidence.authoritativeTotals?.nodes
          ?? evidence.authoritativeTotal
          ?? null,
      }));
    }
    return terminalReceipt({ context, values, baseUrl, callerAgent, scenario, terminal, activityLog, extras: {
      sourceHealth: evidence.sourceHealth,
      matchOutcome: evidence.matchOutcome,
      completeCoverage: evidence.completeCoverage,
      authoritativeTotal: evidence.authoritativeTotals?.nodes ?? evidence.authoritativeTotal,
    } });
  }
  if (scenario === 'graph') {
    const nodeLimit = integer(values, 'node-limit', { defaultValue: 250, min: 1, max: 2000 });
    const edgeLimit = integer(values, 'edge-limit', { defaultValue: Math.min(nodeLimit * 4, 8000), min: 1, max: 8000 });
    const graph = await client.graph({ ...(selector ? { target: selector } : {}), nodeLimit, edgeLimit }, signal);
    const terminal = await protectedTerminal(client, graph.operationId, signal);
    assertCompleteTerminal(terminal, {
      expectedBrain: selector?.brainId ?? null,
      targetErrorCode: 'graph_target_mismatch',
    });
    const actualReturnedTotals = {
      nodes: nodesFromGraph(graph).length,
      edges: edgesFromGraph(graph).length,
    };
    const returnedTotals = terminal.sourceEvidence?.returnedTotals || actualReturnedTotals;
    const authoritativeTotals = terminal.sourceEvidence?.authoritativeTotals;
    const returnedNodes = Number(returnedTotals?.nodes);
    const returnedEdges = Number(returnedTotals?.edges);
    const authoritativeNodes = Number(authoritativeTotals?.nodes);
    const authoritativeEdges = Number(authoritativeTotals?.edges);
    if (returnedNodes !== actualReturnedTotals.nodes || returnedEdges !== actualReturnedTotals.edges
        || !Number.isSafeInteger(returnedNodes) || returnedNodes < 1 || returnedNodes > nodeLimit
        || !Number.isSafeInteger(returnedEdges) || returnedEdges < 0 || returnedEdges > edgeLimit
        || !Number.isSafeInteger(authoritativeNodes) || authoritativeNodes < returnedNodes
        || !Number.isSafeInteger(authoritativeEdges) || authoritativeEdges < returnedEdges) {
      throw typedError('graph_result_invalid');
    }
    return terminalReceipt({ context, values, baseUrl, callerAgent, scenario, terminal, activityLog, extras: {
      returnedTotals,
      authoritativeTotals,
      limits: { nodeLimit, edgeLimit },
    } });
  }
  if (scenario === 'negative-targets') {
    const expected = String(one(values, 'expect-codes', { required: true }))
      .split(',').map((code) => code.trim()).filter(Boolean);
    const controlled = controlledNegativeClient || createControlledNegativeTargetClient({
      Client: modules.BrainOperationsClient,
      callerAgent,
    });
    const coverage = await collectNegativeTargetCoverage({
      client,
      controlledClient: controlled,
      callerAgent,
      expectedCodes: expected,
      signal,
      primaryAuthority: context.authority,
    });
    return {
      helper: 'live-brain-tools-smoke', scenario, receiptKind: 'authority-negative',
      requesterAgent: callerAgent, protectedResultRead: false,
      ...coverage,
      ...authorityFields(context, values, baseUrl),
    };
  }
  if (scenario === 'detach-reattach') {
    const initial = await lifecycleStart(client, values, signal);
    const controller = new AbortController();
    controller.abort(Object.assign(new Error('transport_disconnect'), { code: 'transport_disconnect' }));
    const detached = await client.wait(initial.operationId, {
      operationType: initial.operationType, initial, signal: controller.signal, waitMs: QUERY_WAIT_MS,
    });
    if (detached.attachmentState !== 'detached' || !['queued', 'running'].includes(detached.state)) {
      throw typedError('detach_not_observed');
    }
    const reattached = await client.resumeOperation(initial.operationId, signal);
    const terminal = await protectedTerminal(client, initial.operationId, signal);
    return terminalReceipt({ context, values, baseUrl, callerAgent, scenario, terminal, activityLog, extras: {
      detachedState: detached.state, reattachedTerminal: TERMINAL.has(reattached.state),
    } });
  }
  if (scenario === 'cancel') {
    const initial = await lifecycleStart(client, values, signal);
    await client.cancel(initial.operationId, signal);
    const terminal = await protectedTerminal(client, initial.operationId, signal);
    if (terminal.state !== 'cancelled') throw typedError('cancel_not_terminal');
    const providerAbortEvent = activityLog.find((activity) =>
      activity?.operationId === initial.operationId
        && activity?.type === 'provider_call_terminal'
        && ['cancelled', 'aborted'].includes(activity?.outcome));
    const resultEvidence = terminal.result?.providerAbortObserved === true;
    return terminalReceipt({ context, values, baseUrl, callerAgent, scenario, terminal, activityLog, extras: {
      providerAbortObserved: Boolean(providerAbortEvent || resultEvidence),
      providerAbortEvidence: providerAbortEvent ? {
        evidenceSource: 'operation-stream',
        eventSequence: activityEventSequence(providerAbortEvent),
        outcome: providerAbortEvent.outcome,
      } : resultEvidence ? {
        evidenceSource: 'protected-operation-result',
        providerAbortObserved: true,
      } : null,
    } });
  }
  if (scenario === 'restart-reconcile') {
    const operationId = one(values, 'operation-id');
    if (!operationId) throw typedError('operation_id_required', 'restart-reconcile requires an operation created before coordinator restart');
    const status = await client.getOperation(operationId, signal);
    const terminal = TERMINAL.has(status.state) ? await protectedTerminal(client, operationId, signal) : status;
    return {
      helper: 'live-brain-tools-smoke', scenario,
      receiptKind: TERMINAL.has(terminal.state) ? 'operation-terminal' : 'operation-event',
      operationId, operationType: status.operationType, state: status.state,
      requesterAgent: callerAgent, protectedResultRead: TERMINAL.has(terminal.state),
      storeReloaded: true, reconciledState: status.state,
      ...authorityFields(context, values, baseUrl),
    };
  }
  if (scenario === 'synthesis-reconnect') {
    const operation = await client.synthesize({ trigger: 'acceptance', reason: one(values, 'reason', { defaultValue: 'controlled synthesis reconnect acceptance' }) }, signal);
    const terminal = TERMINAL.has(operation.state)
      ? await protectedTerminal(client, operation.operationId, signal)
      : await client.reattachSynthesis(operation.operationId, signal);
    const protectedRead = await protectedTerminal(client, operation.operationId, signal);
    return terminalReceipt({ context, values, baseUrl, callerAgent, scenario, terminal: protectedRead, activityLog, extras: {
      reattachedTerminal: TERMINAL.has(terminal.state),
      generationMarker: protectedRead.result?.generationMarker ?? null,
    } });
  }
  if (scenario === 'verify-receipts') {
    return {
      helper: 'live-brain-tools-smoke', scenario, receiptKind: 'receipt-verification',
      protectedResultRead: true,
      ...(await verifyReceiptManifest({
        manifestPath: path.resolve(one(values, 'identity-manifest', { required: true })),
        modules, context, values, callerAgent, signal, fetchImpl,
      })),
    };
  }

  if (scenario === 'completed-research-compile') {
    const canary = await canaryFromReceipt(values, context, callerAgent);
    const brainId = selector?.brainId;
    if (!brainId) throw typedError('target_brain_required');
    const toolResult = await runTool(modules.compileBrainTool, {
      brainId,
      focus: one(values, 'focus', {
        defaultValue: `Compile the authoritative canary evidence for the exact query: ${canary.query}`,
      }),
    }, client, callerAgent, signal);
    const operationId = toolResult.metadata?.operationId;
    if (!operationId) throw typedError('operation_id_missing');
    const terminal = await protectedTerminal(client, operationId, signal);
    assertCanaryBoundUsefulResult(terminal, canary, activityLog);
    return terminalReceipt({ context, values, baseUrl, callerAgent, scenario, terminal, activityLog });
  }

  if (['own', 'direct-query', 'sibling', 'completed-research', 'pgs', 'large-pgs-isolated'].includes(scenario)) {
    const canary = scenario === 'large-pgs-isolated' && canaryOverride
      ? canaryOverride
      : await canaryFromReceipt(values, context, callerAgent);
    if (!canary?.query || !canary?.nodeId
        || !Number.isSafeInteger(canary?.sourceRevision)
        || !['healthy', 'degraded'].includes(canary?.sourceHealth)) {
      throw typedError('canary_receipt_invalid');
    }
    if (scenario === 'large-pgs-isolated') {
      if (context.authority !== 'isolated-controlled' || !booleanFlag(values, 'controlled-provider', false)) {
        throw typedError('controlled_provider_scope_invalid');
      }
      const fixture = await canonicalDirectory(path.resolve(one(values, 'isolated-fixture', { required: true })), 'isolated fixture');
      const syntheticNodes = integer(values, 'synthetic-nodes', { required: true, min: PGS_LARGE_MIN_NODES });
      const syntheticEdges = integer(values, 'synthetic-edges', { required: true, min: syntheticNodes });
      if (!baseUrl) throw typedError('isolated_fixture_endpoint_required');
      values['isolated-store'] ||= path.join(fixture.path, 'operations');
    }
    const pgs = scenario === 'pgs' || scenario === 'large-pgs-isolated';
    const queryInput = {
      query: canary.query,
      ...(selector ? { target: selector } : {}),
      ...(pgs ? {
        enablePGS: true,
        pgsMode: 'fresh',
        pgsLevel: 'full',
        ...(exactPair(values, 'pgs-sweep-selection') ? { pgsSweep: exactPair(values, 'pgs-sweep-selection') } : {}),
        ...(exactPair(values, 'pgs-synth-selection') ? { pgsSynth: exactPair(values, 'pgs-synth-selection') } : {}),
      } : {
        mode: one(values, 'mode', { defaultValue: 'quick' }),
        ...(exactPair(values, 'model-selection') ? { modelSelection: exactPair(values, 'model-selection') } : {}),
      }),
    };
    if (scenario === 'own') {
      await runTool(modules.brainSearchTool, { query: canary.query, limit: 20 }, client, callerAgent, signal);
      await runTool(modules.brainStatusTool, {}, client, callerAgent, signal);
      await runTool(modules.brainMemoryGraphTool, { topN: 25 }, client, callerAgent, signal);
    }
    const toolResult = await runTool(modules.brainQueryTool, queryInput, client, callerAgent, signal);
    const operationId = toolResult.metadata?.operationId;
    if (!operationId) throw typedError('operation_id_missing');
    const terminal = await protectedTerminal(client, operationId, signal);
    assertCanaryBoundUsefulResult(terminal, canary, activityLog);
    const requiredNodes = integer(values, 'require-authoritative-nodes', { min: 1 });
    const authoritativeNodes = Number(terminal.sourceEvidence?.authoritativeTotals?.nodes);
    if (scenario === 'pgs' && (requiredNodes === undefined
        || requiredNodes < PGS_LARGE_MIN_NODES || authoritativeNodes < PGS_LARGE_MIN_NODES)) {
      throw typedError('authoritative_size_gate_failed');
    }
    if (requiredNodes !== undefined && authoritativeNodes < requiredNodes) throw typedError('authoritative_size_gate_failed');
    if (scenario === 'large-pgs-isolated') {
      const authoritativeEdges = Number(terminal.sourceEvidence?.authoritativeTotals?.edges);
      const syntheticNodes = integer(values, 'synthetic-nodes', { required: true, min: PGS_LARGE_MIN_NODES });
      const syntheticEdges = integer(values, 'synthetic-edges', { required: true, min: syntheticNodes });
      if (authoritativeNodes !== syntheticNodes || authoritativeEdges !== syntheticEdges) {
        throw typedError('synthetic_source_mismatch');
      }
    }
    return terminalReceipt({ context, values, baseUrl, callerAgent, scenario, terminal, activityLog, extras: {
      canaryNodeId: canary.nodeId,
      canarySourceRevision: canary.sourceRevision,
      authoritativeNodes: Number.isFinite(authoritativeNodes) ? authoritativeNodes : null,
      liveProviderLargePgsGatePassed: scenario === 'pgs' && authoritativeNodes >= PGS_LARGE_MIN_NODES,
      controlledProvider: booleanFlag(values, 'controlled-provider', false),
    } });
  }
  throw typedError('scenario_not_implemented', scenario);
}

const ISOLATED_LIFECYCLE_SCENARIOS = new Set([
  'detach-reattach',
  'cancel',
  'restart-reconcile',
  'synthesis-reconnect',
]);
const ISOLATED_AUTO_LAUNCH_SCENARIOS = new Set([
  ...ISOLATED_LIFECYCLE_SCENARIOS,
  'large-pgs-isolated',
]);

async function waitForOperationState(client, operationId, expected, signal, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    const current = await client.getOperation(operationId, signal);
    if (expected.has(current.state)) return current;
    if (TERMINAL.has(current.state)) throw typedError('isolated_lifecycle_terminal_early');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw typedError('isolated_lifecycle_state_timeout');
}

async function waitForProviderStart(
  fixture,
  role,
  baseline,
  signal,
  timeoutMs = 10_000,
) {
  if (!['cosmo', 'dashboard'].includes(role)) throw typedError('isolated_fixture_role_invalid');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    const telemetry = await fixture.telemetry();
    if (Number(telemetry[role]?.providerStarts) > baseline) return telemetry;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw typedError('isolated_provider_start_timeout');
}

async function resumeIsolatedOperationToTerminal(client, operationId, signal, timeoutMs = 10_000) {
  const initialResume = await client.resumeOperation(operationId, signal);
  if (TERMINAL.has(initialResume.state)) {
    return { initialResume, terminal: initialResume, statusPolls: 0 };
  }
  const deadline = Date.now() + timeoutMs;
  let statusPolls = 0;
  let status = initialResume;
  while (!TERMINAL.has(status.state) && Date.now() < deadline) {
    await sleep(25, signal);
    status = await client.getOperation(operationId, signal);
    statusPolls += 1;
  }
  if (!TERMINAL.has(status.state)) {
    throw typedError('reattach_not_terminal', JSON.stringify({
      resumed: initialResume.state,
      attachmentState: initialResume.attachmentState ?? null,
      lastStatus: status.state,
      statusPolls,
    }));
  }
  const terminal = await client.resumeOperation(operationId, signal);
  if (!TERMINAL.has(terminal.state)) {
    throw typedError('reattach_not_terminal', JSON.stringify({
      resumed: initialResume.state,
      attachmentState: initialResume.attachmentState ?? null,
      lastStatus: status.state,
      finalResume: terminal.state,
      statusPolls,
    }));
  }
  return { initialResume, terminal, statusPolls };
}

async function readAttachmentEvidence(fixture, operationId) {
  const { BrainOperationStore } = require(
    '../engine/src/dashboard/brain-operations/operation-store.js'
  );
  const store = new BrainOperationStore({
    root: fixture.operationsRoot,
    requesterAgent: fixture.agent,
  });
  const directory = path.join(fixture.operationsRoot, 'operations', operationId, 'attachments');
  const names = [];
  const handle = await fsp.opendir(directory);
  try {
    for await (const entry of handle) {
      if (!entry.name.endsWith('.json')) continue;
      names.push(entry.name);
      if (names.length > 10_000) throw typedError('isolated_attachment_evidence_invalid');
    }
  } finally {
    await handle.close().catch(() => {});
  }
  names.sort();
  const rows = [];
  for (const name of names) {
    const attachmentId = name.slice(0, -'.json'.length);
    const row = await store.getAttachment(operationId, attachmentId);
    if (row.operationId !== operationId || row.requesterAgent !== fixture.agent
        || !['attached', 'detached', 'closed'].includes(row.state)) {
      throw typedError('isolated_attachment_evidence_invalid');
    }
    rows.push(row);
  }
  return {
    total: rows.length,
    attached: rows.filter((row) => row.state === 'attached').length,
    detached: rows.filter((row) => row.state === 'detached').length,
    closed: rows.filter((row) => row.state === 'closed').length,
    attachmentIds: rows.map((row) => row.attachmentId),
    entries: rows.map((row) => ({
      attachmentId: row.attachmentId,
      state: row.state,
      reason: row.reason,
    })),
  };
}

function attachmentEvidenceEntry(evidence, attachmentId) {
  return evidence.entries.find((entry) => entry.attachmentId === attachmentId) ?? null;
}

function assertAttachmentEvidenceShape(evidence) {
  if (!evidence || evidence.total !== 2
      || !Array.isArray(evidence.attachmentIds) || evidence.attachmentIds.length !== 2
      || new Set(evidence.attachmentIds).size !== 2
      || !Array.isArray(evidence.entries) || evidence.entries.length !== 2
      || evidence.attached + evidence.detached + evidence.closed !== 2
      || evidence.entries.some((entry) => !entry
        || !evidence.attachmentIds.includes(entry.attachmentId)
        || !['attached', 'detached', 'closed'].includes(entry.state))) {
    throw typedError('surviving_attachment_evidence_invalid');
  }
  const counted = {
    attached: evidence.entries.filter((entry) => entry.state === 'attached').length,
    detached: evidence.entries.filter((entry) => entry.state === 'detached').length,
    closed: evidence.entries.filter((entry) => entry.state === 'closed').length,
  };
  if (counted.attached !== evidence.attached
      || counted.detached !== evidence.detached
      || counted.closed !== evidence.closed) {
    throw typedError('surviving_attachment_evidence_invalid');
  }
}

export async function waitForSurvivingAttachmentClosure({
  initialEvidence,
  readEvidence,
  signal = null,
  timeoutMs = 10_000,
  pollMs = 25,
  now = Date.now,
  wait = sleep,
  deadlineWait = sleep,
} = {}) {
  if (typeof readEvidence !== 'function' || typeof now !== 'function'
      || typeof wait !== 'function' || typeof deadlineWait !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || !Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw typedError('surviving_attachment_wait_invalid');
  }
  assertAttachmentEvidenceShape(initialEvidence);
  const detachedEntry = initialEvidence.entries.find((entry) => entry.state === 'detached');
  const survivorEntry = initialEvidence.entries.find((entry) => entry.state === 'attached');
  if (initialEvidence.attached !== 1 || initialEvidence.detached !== 1
      || initialEvidence.closed !== 0
      || !['caller_abort', 'transport_disconnect'].includes(detachedEntry?.reason)
      || survivorEntry?.reason !== null) {
    throw typedError('surviving_attachment_evidence_invalid');
  }
  const expectedIds = [...initialEvidence.attachmentIds];
  const deadline = now() + timeoutMs;
  let lastEvidence = initialEvidence;
  const deadlineController = new AbortController();
  const releasedDeadline = typedError('surviving_attachment_deadline_released');
  const never = new Promise(() => {});
  let removeCallerAbort = () => {};
  const callerAbort = signal ? new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    removeCallerAbort = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  }) : never;
  const timeout = Promise.resolve(deadlineWait(
    Math.max(1, timeoutMs),
    deadlineController.signal,
  )).then(() => {
    throw typedError('surviving_attachment_not_proven', JSON.stringify(lastEvidence));
  }).catch((error) => {
    if (deadlineController.signal.aborted && error === deadlineController.signal.reason) return never;
    throw error;
  });
  const beforeDeadline = (promise) => Promise.race([callerAbort, timeout, promise]);
  try {
    while (now() < deadline) {
      if (signal?.aborted) throw signal.reason;
      const evidence = await beforeDeadline(Promise.resolve().then(readEvidence));
      if (signal?.aborted) throw signal.reason;
      if (now() >= deadline) {
        throw typedError('surviving_attachment_not_proven', JSON.stringify(lastEvidence));
      }
      assertAttachmentEvidenceShape(evidence);
      if (!isDeepStrictEqual(evidence.attachmentIds, expectedIds)) {
        throw typedError('surviving_attachment_evidence_invalid');
      }
      const detached = attachmentEvidenceEntry(evidence, detachedEntry.attachmentId);
      const survivor = attachmentEvidenceEntry(evidence, survivorEntry.attachmentId);
      if (detached?.state !== 'detached' || detached.reason !== detachedEntry.reason
          || !survivor
          || (survivor.state === 'attached' && survivor.reason !== null)
          || (survivor.state === 'closed' && survivor.reason !== 'operation_terminal')
          || !['attached', 'closed'].includes(survivor.state)) {
        throw typedError('surviving_attachment_evidence_invalid');
      }
      lastEvidence = evidence;
      if (evidence.total === 2 && evidence.attached === 0
          && evidence.detached === 1 && evidence.closed === 1
          && survivor.state === 'closed') {
        return evidence;
      }
      if (now() >= deadline) break;
      await beforeDeadline(wait(pollMs, signal));
    }
    throw typedError('surviving_attachment_not_proven', JSON.stringify(lastEvidence));
  } finally {
    removeCallerAbort();
    deadlineController.abort(releasedDeadline);
  }
}

async function readRetainedProviderTerminalEvidence(fixture, operationId) {
  const { BrainOperationStore } = require(
    '../engine/src/dashboard/brain-operations/operation-store.js'
  );
  const store = new BrainOperationStore({
    root: fixture.operationsRoot,
    requesterAgent: fixture.agent,
  });
  const events = await store.readEvents(operationId, 0);
  const terminals = events.filter((event) => event.type === 'provider_call_terminal');
  if (terminals.length !== 1) throw typedError('provider_terminal_store_evidence_invalid');
  const [event] = terminals;
  if (event.operationId !== operationId
      || event.provider !== 'controlled'
      || event.model !== 'controlled-synthesis'
      || event.providerCallId !== 'synthesis'
      || event.phase !== 'synthesis'
      || event.outcome !== 'complete'
      || !Number.isSafeInteger(event.sequence)) {
    throw typedError('provider_terminal_store_evidence_invalid');
  }
  return {
    evidenceSource: 'durable-operation-store',
    operationId,
    eventSequence: event.sequence,
    phase: event.phase,
    provider: event.provider,
    model: event.model,
    providerCallId: event.providerCallId,
    outcome: event.outcome,
  };
}

async function readIsolatedOperationDiagnostics(fixture) {
  const { BrainOperationStore } = require(
    '../engine/src/dashboard/brain-operations/operation-store.js'
  );
  const store = new BrainOperationStore({
    root: fixture.operationsRoot,
    requesterAgent: fixture.agent,
  });
  return (await store.list()).map((record) => ({
    operationId: record.operationId,
    operationType: record.operationType,
    state: record.state,
    phase: record.phase,
    error: record.error,
  }));
}

function sourceRootDescriptors({ fixture = null, fixtureRoot = null, agent = null } = {}) {
  if (fixture?.sources) {
    return ['own', 'sibling', 'research'].map((role) => ({
      role,
      brainDir: fixture.sources[role]?.brainDir,
    }));
  }
  if (typeof fixtureRoot !== 'string' || typeof agent !== 'string' || !agent) {
    throw typedError('isolated_source_integrity_configuration_invalid');
  }
  return [
    { role: 'own', brainDir: path.join(fixtureRoot, 'instances', agent, 'brain') },
    { role: 'sibling', brainDir: path.join(fixtureRoot, 'instances', `${agent}-sibling`, 'brain') },
    {
      role: 'research',
      brainDir: path.join(
        fixtureRoot,
        'instances',
        agent,
        'workspace',
        'research',
        'runs',
        'completed-fixture-run',
      ),
    },
  ];
}

async function hashFixtureBrainSource(role, brainDir) {
  if (!['own', 'sibling', 'research'].includes(role) || typeof brainDir !== 'string') {
    throw typedError('isolated_source_integrity_configuration_invalid');
  }
  const root = await canonicalDirectory(path.resolve(brainDir), `${role} fixture source`);
  const manifestPath = path.join(root.path, 'memory-manifest.json');
  const manifest = await readJson(manifestPath, { maxBytes: 1024 * 1024 });
  const selectedFiles = [
    manifest?.activeBase?.nodes?.file,
    manifest?.activeBase?.edges?.file,
    manifest?.activeDelta?.file,
  ];
  if (selectedFiles.some((name) => typeof name !== 'string' || !name
      || /[\\/\0]/.test(name)
      || path.basename(name) !== name || path.normalize(name) !== name)) {
    throw typedError('isolated_source_manifest_invalid', role);
  }
  const required = new Set([
    'memory-manifest.json',
    'brain-snapshot.json',
    ...selectedFiles,
  ]);
  const files = [];
  let totalBytes = 0;
  let totalEntries = 0;

  async function walk(directory) {
    const before = await fsp.lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw typedError('isolated_source_tree_invalid', role);
    }
    const directoryHandle = await fsp.opendir(directory);
    const names = [];
    try {
      for await (const entry of directoryHandle) {
        names.push(entry.name);
        totalEntries += 1;
        if (totalEntries > MAX_SOURCE_FILES_PER_BRAIN) {
          throw typedError('isolated_source_file_limit_exceeded', role);
        }
      }
    } finally {
      await directoryHandle.close().catch(() => {});
    }
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root.path, absolute);
      const stat = await fsp.lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) throw typedError('isolated_source_symlink_refused', relative);
      if (stat.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!stat.isFile()) throw typedError('isolated_source_tree_invalid', relative);
      if (relative === 'brain-state.json') continue;
      if (files.length >= MAX_SOURCE_FILES_PER_BRAIN) {
        throw typedError('isolated_source_file_limit_exceeded', role);
      }
      const canonical = await fsp.realpath(absolute);
      if (!isInsideOrEqual(root.path, canonical) || canonical !== absolute) {
        throw typedError('isolated_source_path_invalid', relative);
      }
      const hashed = await hashFile(absolute, { maxBytes: MAX_SOURCE_FILE_BYTES });
      totalBytes += hashed.physicalSize;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_SOURCE_TOTAL_BYTES) {
        throw typedError('isolated_source_byte_limit_exceeded', role);
      }
      files.push({
        path: relative,
        size: hashed.physicalSize,
        sha256: hashed.sha256,
        dev: hashed.dev,
        ino: hashed.ino,
        mtimeNs: hashed.mtimeNs,
        ctimeNs: hashed.ctimeNs,
      });
    }
    const after = await fsp.lstat(directory, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw typedError('isolated_source_changed_concurrently', role);
    }
  }

  await walk(root.path);
  files.sort((left, right) => left.path.localeCompare(right.path));
  const observed = new Set(files.map((file) => file.path));
  if ([...required].some((name) => !observed.has(name))) {
    throw typedError('isolated_source_manifest_invalid', role);
  }
  return {
    role,
    brainDir: root.path,
    rootDev: root.dev,
    rootIno: root.ino,
    manifestGeneration: manifest.generation ?? null,
    manifestRevision: Number.isSafeInteger(manifest.currentRevision)
      ? manifest.currentRevision
      : null,
    excludedMutableFiles: ['brain-state.json'],
    totalBytes,
    files,
  };
}

export async function captureFixtureSourceIntegrity(options = {}) {
  const descriptors = sourceRootDescriptors(options);
  const sources = [];
  for (const descriptor of descriptors) {
    sources.push(await hashFixtureBrainSource(descriptor.role, descriptor.brainDir));
  }
  return {
    schemaVersion: 1,
    sources,
  };
}

export async function verifyFixtureSourceIntegrity(before, options = {}) {
  const after = await captureFixtureSourceIntegrity(options);
  if (!isDeepStrictEqual(before, after)) {
    throw typedError(
      'isolated_source_identity_or_hash_drift',
      'isolated source identity or byte hash changed during acceptance',
      { before, after },
    );
  }
  return {
    unchanged: true,
    before,
    after,
  };
}

function isolatedFixtureReceipt(fixture, stopped, sourceIntegrity) {
  const stoppedPids = [stopped?.dashboard?.pid, stopped?.cosmo?.pid, stopped?.mcp?.pid]
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (stopped?.dashboard?.exited !== true || stopped?.cosmo?.exited !== true
      || stopped?.mcp?.exited !== true
      || stoppedPids.length !== 3 || new Set(stoppedPids).size !== 3
      || stopped?.retainedStore !== fixture.operationsRoot) {
    throw typedError('isolated_fixture_shutdown_unproven');
  }
  return {
    root: fixture.fixtureRoot,
    basename: fixture.owner.basename,
    dev: fixture.owner.dev,
    ino: fixture.owner.ino,
    pids: { ...fixture.pids },
    ports: { ...fixture.ports },
    stoppedPids,
    retainedStore: stopped.retainedStore,
    sourceHashes: { ...fixture.source.sourceHashes },
    sourceIntegrity,
  };
}

export function createBoundedMetricAccumulator({
  role,
  expectedPid,
  maxRetainedSamples = MAX_METRIC_SAMPLES_PER_ROLE,
} = {}) {
  if (typeof role !== 'string' || !role
      || !Number.isSafeInteger(expectedPid) || expectedPid < 1
      || !Number.isSafeInteger(maxRetainedSamples) || maxRetainedSamples < 8) {
    throw typedError('isolated_fixture_metric_accumulator_invalid');
  }
  const retained = [];
  let retentionStride = 1;
  let observedSamples = 0;
  let baseline = null;
  let last = null;
  let maxV8HeapUsedMiB = -Infinity;
  let maxSampledRssMiB = -Infinity;
  let maxProcessRssMiB = -Infinity;
  let minRestartCount = Infinity;
  let maxRestartCount = -Infinity;
  let pidChanged = false;

  function retain(row, force = false) {
    if (!force && observedSamples > 1 && observedSamples % retentionStride !== 0) return;
    if (retained.at(-1)?.updatedAt === row.updatedAt) {
      retained[retained.length - 1] = row;
      return;
    }
    if (retained.length >= maxRetainedSamples) {
      const compacted = [retained[0]];
      for (let index = 2; index < retained.length - 1; index += 2) {
        compacted.push(retained[index]);
      }
      compacted.push(retained.at(-1));
      retained.splice(0, retained.length, ...compacted);
      retentionStride *= 2;
    }
    retained.push(row);
  }

  return Object.freeze({
    add(row, { forceRetain = false } = {}) {
      if (!row || row.role !== role || row.pid !== expectedPid
          || !Number.isSafeInteger(row.restartCount) || row.restartCount < 0
          || !Number.isFinite(row.v8HeapUsedMiB) || row.v8HeapUsedMiB < 0
          || !Number.isFinite(row.rssMiB) || row.rssMiB <= 0
          || !Number.isFinite(row.processMaxRssMiB)
          || row.processMaxRssMiB < row.rssMiB
          || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) {
        throw typedError('isolated_fixture_metric_invalid', role);
      }
      if (last?.updatedAt === row.updatedAt) return false;
      if (last && Date.parse(row.updatedAt) < Date.parse(last.updatedAt)) {
        throw typedError('isolated_fixture_metric_timestamp_regressed', role);
      }
      if (last && row.processMaxRssMiB < last.processMaxRssMiB) {
        throw typedError('rss_high_water_regressed', role);
      }
      const captured = { ...row };
      observedSamples += 1;
      baseline ||= captured;
      last = captured;
      pidChanged ||= captured.pid !== expectedPid;
      maxV8HeapUsedMiB = Math.max(maxV8HeapUsedMiB, captured.v8HeapUsedMiB);
      maxSampledRssMiB = Math.max(maxSampledRssMiB, captured.rssMiB);
      maxProcessRssMiB = Math.max(maxProcessRssMiB, captured.processMaxRssMiB);
      minRestartCount = Math.min(minRestartCount, captured.restartCount);
      maxRestartCount = Math.max(maxRestartCount, captured.restartCount);
      retain(captured, forceRetain);
      return true;
    },
    summary() {
      if (!baseline || !last || observedSamples < 3) {
        throw typedError('isolated_fixture_metric_insufficient', role);
      }
      const maxSampledV8HeapGrowthMiB = maxV8HeapUsedMiB - baseline.v8HeapUsedMiB;
      const maxSampledRssGrowthMiB = maxSampledRssMiB - baseline.rssMiB;
      const processMaxRssGrowthMiB = maxProcessRssMiB - baseline.processMaxRssMiB;
      return {
        name: role,
        pid: expectedPid,
        observedSamples,
        retainedSamples: retained.length,
        retentionStride,
        samples: retained.map((row) => ({ ...row })),
        baselineV8HeapUsedMiB: baseline.v8HeapUsedMiB,
        maxSampledV8HeapUsedMiB: maxV8HeapUsedMiB,
        maxSampledV8HeapGrowthMiB,
        baselineRssMiB: baseline.rssMiB,
        maxSampledRssMiB,
        maxSampledRssGrowthMiB,
        baselineProcessMaxRssMiB: baseline.processMaxRssMiB,
        finalProcessMaxRssMiB: maxProcessRssMiB,
        processMaxRssGrowthMiB,
        baselineHeapMiB: baseline.v8HeapUsedMiB,
        peakHeapMiB: maxV8HeapUsedMiB,
        heapGrowthMiB: maxSampledV8HeapGrowthMiB,
        peakRssMiB: maxSampledRssMiB,
        processMaxRssMiB: maxProcessRssMiB,
        pidChanged,
        restartDelta: maxRestartCount - minRestartCount,
        metricFresh: true,
      };
    },
  });
}

export function startIsolatedMetricSampler(fixture, {
  intervalMs = 100,
  initialFreshWaitMs = 10_000,
  finalFreshWaitMs = 30_000,
  signal = null,
  monotonicNow = () => performance.now(),
  wallNow = Date.now,
  wait = sleep,
  deadlineWait = sleep,
  readMetricFile = (file) => readJson(file, { maxBytes: 1024 * 1024 }),
} = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1
      || !Number.isSafeInteger(initialFreshWaitMs) || initialFreshWaitMs < 1
      || !Number.isSafeInteger(finalFreshWaitMs) || finalFreshWaitMs < 1
      || (signal !== null && !(signal instanceof AbortSignal))
      || typeof monotonicNow !== 'function' || typeof wallNow !== 'function'
      || typeof wait !== 'function' || typeof deadlineWait !== 'function'
      || typeof readMetricFile !== 'function') {
    throw typedError('isolated_fixture_metric_sampler_invalid');
  }
  const roles = ['dashboard', 'cosmo'];
  const accumulators = new Map(roles.map((role) => [role, createBoundedMetricAccumulator({
    role,
    expectedPid: fixture.pids[role],
  })]));
  const samplerController = new AbortController();
  const lastAcceptedUpdatedAtMs = new Map(roles.map((role) => [role, -Infinity]));
  let failure = null;
  let staleCaptureCount = 0;
  let settleReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    settleReady = resolve;
    rejectReady = reject;
  });

  async function readMetric(role, retrySignal) {
    let lastError = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        return await readMetricFile(fixture.metrics[role]);
      } catch (error) {
        lastError = error;
        if (error?.code !== 'json_file_invalid' || attempt === 7) break;
        await wait(5, retrySignal);
      }
    }
    throw lastError;
  }

  async function capture({
    forceRetain = false,
    waitForFreshMs = 0,
    deadlineMs = waitForFreshMs > 0 ? monotonicNow() + waitForFreshMs : null,
    requireAdvance = false,
    bounded = (promise) => promise,
  } = {}) {
    const captured = new Map();
    const captureSignal = forceRetain ? signal : samplerController.signal;
    const throwIfUnavailable = (role) => {
      if (signal?.aborted) throw signal.reason || typedError('acceptance_interrupted');
      if (!forceRetain && samplerController.signal.aborted) {
        throw samplerController.signal.reason || typedError('metric_sampler_stopped');
      }
      if (deadlineMs !== null && monotonicNow() >= deadlineMs) {
        throw typedError('isolated_fixture_metric_stale', role);
      }
    };
    for (const role of roles) {
      let metric;
      let capturedAtMs;
      let updatedAtMs;
      while (true) {
        throwIfUnavailable(role);
        metric = await bounded(readMetric(role, captureSignal));
        throwIfUnavailable(role);
        capturedAtMs = wallNow();
        updatedAtMs = Date.parse(metric.updatedAt);
        if (metric.schemaVersion !== 2 || metric.role !== role
            || metric.pid !== fixture.pids[role]
            || metric.restartCount !== 0
            || JSON.stringify(metric.semantics) !== JSON.stringify(METRIC_SEMANTICS)
            || !Number.isFinite(updatedAtMs)) {
          throw typedError('isolated_fixture_metric_invalid', role);
        }
        const fresh = updatedAtMs <= capturedAtMs + 1_000
          && capturedAtMs - updatedAtMs <= 5_000;
        const advancing = updatedAtMs > lastAcceptedUpdatedAtMs.get(role);
        if (fresh && (!requireAdvance || advancing)) break;
        staleCaptureCount += 1;
        const remainingMs = deadlineMs === null ? 50 : deadlineMs - monotonicNow();
        if (remainingMs <= 0) {
          throw typedError('isolated_fixture_metric_stale', role);
        }
        await bounded(wait(Math.min(50, remainingMs), captureSignal));
      }
      const added = accumulators.get(role).add({
        role,
        capturedAt: new Date(capturedAtMs).toISOString(),
        updatedAt: metric.updatedAt,
        pid: metric.pid,
        restartCount: metric.restartCount,
        v8HeapUsedMiB: metric.v8HeapUsedMiB,
        rssMiB: metric.rssMiB,
        processMaxRssMiB: metric.processMaxRssMiB,
      }, { forceRetain });
      if (requireAdvance && !added) {
        throw typedError('isolated_fixture_metric_not_advancing', role);
      }
      if (added) lastAcceptedUpdatedAtMs.set(role, updatedAtMs);
      captured.set(role, Object.freeze({ updatedAt: metric.updatedAt, updatedAtMs, added }));
    }
    return captured;
  }

  const task = (async () => {
    try {
      await capture({ waitForFreshMs: initialFreshWaitMs });
      settleReady();
    } catch (error) {
      failure ||= error;
      rejectReady(error);
      return;
    }
    while (!samplerController.signal.aborted) {
      try {
        await wait(intervalMs, samplerController.signal);
        await capture();
      } catch (error) {
        if (samplerController.signal.aborted) break;
        if (error?.code === 'isolated_fixture_metric_stale') continue;
        failure ||= error;
        break;
      }
    }
  })();

  return Object.freeze({
    ready,
    async stop() {
      samplerController.abort(typedError('metric_sampler_stopped'));
      await task;
      if (failure) throw failure;
      if (signal?.aborted) throw signal.reason || typedError('acceptance_interrupted');
      const finalDeadlineMs = monotonicNow() + finalFreshWaitMs;
      const deadlineController = new AbortController();
      const releasedDeadline = typedError('isolated_fixture_metric_deadline_released');
      const never = new Promise(() => {});
      let removeCallerAbort = () => {};
      const callerAbort = signal ? new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason || typedError('acceptance_interrupted'));
        signal.addEventListener('abort', abort, { once: true });
        removeCallerAbort = () => signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
      }) : never;
      const timeout = Promise.resolve()
        .then(() => deadlineWait(finalFreshWaitMs, deadlineController.signal))
        .then(() => {
          throw typedError('isolated_fixture_metric_stale', 'final');
        })
        .catch((error) => {
          if (deadlineController.signal.aborted
              && error === deadlineController.signal.reason) return never;
          throw error;
        });
      timeout.catch(() => {});
      const bounded = (promise) => Promise.race([callerAbort, timeout, promise]);
      const finalSamples = Object.fromEntries(roles.map((role) => [role, []]));
      try {
        for (let index = 0; index < 3; index += 1) {
          const captured = await capture({
            forceRetain: true,
            deadlineMs: finalDeadlineMs,
            requireAdvance: true,
            bounded,
          });
          for (const role of roles) {
            finalSamples[role].push(captured.get(role).updatedAt);
          }
          if (index < 2) {
            const remainingMs = finalDeadlineMs - monotonicNow();
            if (remainingMs <= 0) throw typedError('isolated_fixture_metric_stale', 'final');
            await bounded(wait(Math.min(Math.max(50, intervalMs), remainingMs), signal));
          }
        }
      } catch (error) {
        failure ||= error;
      } finally {
        removeCallerAbort();
        deadlineController.abort(releasedDeadline);
      }
      if (failure) throw failure;
      const targets = roles.map((role) => accumulators.get(role).summary());
      if (targets.some((target) => target.pidChanged || target.restartDelta !== 0
          || target.maxSampledV8HeapGrowthMiB > MEMORY_GROWTH_LIMIT_MIB
          || target.maxSampledRssGrowthMiB > MEMORY_GROWTH_LIMIT_MIB
          || target.processMaxRssGrowthMiB > MEMORY_GROWTH_LIMIT_MIB)) {
        throw typedError('isolated_fixture_metric_gate_failed');
      }
      return {
        metric: 'runtime-memory-evidence-v2',
        semantics: {
          sampledV8Heap: 'discrete request-time observations; not a continuous heap high-water',
          sampledRss: 'discrete request-time observations',
          processMaxRss: 'process-lifetime OS high-water; captures spikes between requests',
        },
        maxHeapGrowthMiB: MEMORY_GROWTH_LIMIT_MIB,
        maxRssGrowthMiB: MEMORY_GROWTH_LIMIT_MIB,
        staleCaptureCount,
        finalSamples,
        maxProcessMaxRssGrowthMiB: MEMORY_GROWTH_LIMIT_MIB,
        maxRetainedSamplesPerRole: MAX_METRIC_SAMPLES_PER_ROLE,
        targets,
      };
    },
  });
}

async function executeIsolatedLifecycleScenario({
  scenario,
  modules,
  fixture,
  client,
  clientOptions,
  values,
  context,
  callerAgent,
  signal,
  activities,
  activityCollector = null,
}) {
  const synthesis = scenario === 'synthesis-reconnect';
  const telemetryBefore = await fixture.telemetry();
  let initial;
  try {
    initial = synthesis
      ? await client.start('synthesis', {
          trigger: 'acceptance',
          reason: 'controlled synthesis coordinator reconnect acceptance',
        }, signal)
      : await client.start('query', {
          query: `controlled lifecycle ${scenario} acceptance`,
          mode: 'quick',
        }, signal);
  } catch (error) {
    if (synthesis) {
      error.message = `${error.message}: ${JSON.stringify(
        await readIsolatedOperationDiagnostics(fixture),
      )}`;
    }
    throw error;
  }
  const running = await waitForOperationState(
    client, initial.operationId, new Set(['running']), signal,
  );
  const providerRole = synthesis ? 'dashboard' : 'cosmo';
  const providerStartsBefore = Number(telemetryBefore[providerRole]?.providerStarts || 0);
  const providerStartedTelemetry = await waitForProviderStart(
    fixture,
    providerRole,
    providerStartsBefore,
    signal,
  );

  if (synthesis) {
    const restartsBefore = Number(telemetryBefore.dashboard?.coordinatorRestarts || 0);
    const restarted = await fixture.restartCoordinator();
    if (restarted.coordinatorRestarts !== restartsBefore + 1) {
      throw typedError('coordinator_restart_not_observed');
    }
    const restartedClient = new modules.BrainOperationsClient({
      ...clientOptions,
      ...(activityCollector
        ? { onActivity: activityCollector.listener('synthesis-reconnect') }
        : {}),
    });
    const reconciled = await restartedClient.getOperation(initial.operationId, signal);
    if (!['running', 'complete'].includes(reconciled.state)) {
      throw typedError('synthesis_restart_reconcile_invalid');
    }
    let reattached = reconciled;
    let reattachAttempts = 0;
    const detachedStates = [];
    const reconnectDeadline = Date.now() + 10_000;
    while (!TERMINAL.has(reattached.state) && Date.now() < reconnectDeadline) {
      reattachAttempts += 1;
      reattached = await restartedClient.reattachSynthesis(initial.operationId, signal);
      if (!TERMINAL.has(reattached.state)) {
        detachedStates.push({
          state: reattached.state,
          attachmentState: reattached.attachmentState ?? null,
        });
        await sleep(25, signal);
      }
    }
    if (!TERMINAL.has(reattached.state)) {
      throw typedError('reattach_not_terminal', JSON.stringify({
        reconciled: reconciled.state,
        reattachAttempts,
        detachedStates,
      }));
    }
    const terminal = await protectedTerminal(restartedClient, initial.operationId, signal);
    const providerTerminalStoreEvidence = await readRetainedProviderTerminalEvidence(
      fixture,
      initial.operationId,
    );
    const telemetryAfter = await fixture.telemetry();
    if (Number(telemetryAfter.dashboard?.coordinatorRestarts) !== restartsBefore + 1
        || Number(telemetryAfter.dashboard?.synthesisStarts) < 1) {
      throw typedError('synthesis_restart_evidence_invalid');
    }
    return terminalReceipt({
      context, values, baseUrl: fixture.baseUrl, callerAgent, scenario, terminal,
      activityLog: activities,
      retainedProviderTerminalEvidence: providerTerminalStoreEvidence,
      extras: {
        coordinatorRestarted: true,
        coordinatorRestartsBefore: restartsBefore,
        coordinatorRestartsAfter: telemetryAfter.dashboard.coordinatorRestarts,
        storeReloaded: true,
        reconciledState: reconciled.state,
        reattachedTerminal: true,
        reattachAttempts,
        detachedStates,
        providerTerminalStoreEvidence,
        activityAttachments: activityCollector?.summary(initial.operationId) ?? null,
        generationMarker: terminal.result?.generationMarker ?? null,
      },
    });
  }

  if (scenario === 'detach-reattach') {
    const survivorClient = new modules.BrainOperationsClient({
      ...clientOptions,
      ...(activityCollector ? { onActivity: activityCollector.listener('survivor') } : {}),
    });
    const controller = new AbortController();
    const detachedPromise = client.wait(initial.operationId, {
      operationType: initial.operationType,
      initial: running,
      signal: controller.signal,
      waitMs: QUERY_WAIT_MS,
    });
    const survivorPromise = survivorClient.wait(initial.operationId, {
      operationType: initial.operationType,
      initial: running,
      signal,
      waitMs: QUERY_WAIT_MS,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    controller.abort(Object.assign(new Error('transport_disconnect'), {
      code: 'transport_disconnect',
    }));
    const detached = await detachedPromise;
    if (detached.attachmentState !== 'detached' || detached.state !== 'running') {
      throw typedError('detach_not_observed');
    }
    const concurrentAttachments = await readAttachmentEvidence(fixture, initial.operationId);
    if (concurrentAttachments.total !== 2
        || concurrentAttachments.detached !== 1
        || concurrentAttachments.attached !== 1) {
      throw typedError('two_attachment_detach_not_proven');
    }
    const survived = await survivorPromise;
    const reattachment = await resumeIsolatedOperationToTerminal(
      client,
      initial.operationId,
      signal,
    );
    const terminal = await protectedTerminal(survivorClient, initial.operationId, signal);
    const terminalAttachments = await waitForSurvivingAttachmentClosure({
      initialEvidence: concurrentAttachments,
      readEvidence: () => readAttachmentEvidence(fixture, initial.operationId),
      signal,
    });
    return terminalReceipt({
      context, values, baseUrl: fixture.baseUrl, callerAgent, scenario, terminal,
      activityLog: activities,
      extras: {
        detachedState: detached.state,
        survivorWaitState: survived.state,
        survivorWaitAttachment: survived.attachmentState,
        reattachInitialState: reattachment.initialResume.state,
        reattachStatusPolls: reattachment.statusPolls,
        reattachedTerminal: true,
        concurrentAttachments,
        terminalAttachments,
        activityAttachments: activityCollector?.summary(initial.operationId) ?? null,
      },
    });
  }

  if (scenario === 'cancel') {
    const abortsBefore = Number((await fixture.telemetry()).cosmo?.providerAborts || 0);
    await client.cancel(initial.operationId, signal);
    const terminal = await protectedTerminal(client, initial.operationId, signal);
    const abortsAfter = Number((await fixture.telemetry()).cosmo?.providerAborts || 0);
    const providerStartsAfter = Number(providerStartedTelemetry.cosmo?.providerStarts || 0);
    const providerAbortDelta = abortsAfter - abortsBefore;
    if (terminal.state !== 'cancelled' || providerAbortDelta !== 1
        || providerStartsAfter <= providerStartsBefore) {
      throw typedError('cancel_not_terminal');
    }
    return terminalReceipt({
      context, values, baseUrl: fixture.baseUrl, callerAgent, scenario, terminal,
      activityLog: activities,
      extras: {
        providerAbortObserved: providerAbortDelta === 1,
        providerAbortEvidence: {
          evidenceSource: 'isolated-provider-telemetry',
          providerRole: 'cosmo',
          providerStartsBefore,
          providerStartsAfter,
          providerAbortsBefore: abortsBefore,
          providerAbortsAfter: abortsAfter,
          providerAbortDelta,
        },
        activityAttachments: activityCollector?.summary(initial.operationId) ?? null,
      },
    });
  }

  const dashboardPidBeforeRestart = fixture.pids.dashboard;
  const stoppedDashboard = await fixture.restartDashboard();
  if (stoppedDashboard.pid !== dashboardPidBeforeRestart || stoppedDashboard.exited !== true) {
    throw typedError('isolated_fixture_restart_unproven');
  }
  const restartedClient = new modules.BrainOperationsClient({
    ...clientOptions,
    baseUrl: fixture.baseUrl,
    ...(activityCollector ? { onActivity: activityCollector.listener('restart-reconcile') } : {}),
  });
  const reconciled = await restartedClient.getOperation(initial.operationId, signal);
  if (!['running', 'interrupted'].includes(reconciled.state)) {
    throw typedError('restart_reconcile_invalid');
  }
  const reattachment = TERMINAL.has(reconciled.state)
    ? {
        initialResume: reconciled,
        terminal: await protectedTerminal(restartedClient, initial.operationId, signal),
        statusPolls: 0,
      }
    : await resumeIsolatedOperationToTerminal(
        restartedClient,
        initial.operationId,
        signal,
      );
  const protectedRead = await protectedTerminal(restartedClient, initial.operationId, signal);
  return terminalReceipt({
    context, values, baseUrl: fixture.baseUrl, callerAgent, scenario,
    terminal: protectedRead, activityLog: activities,
    extras: {
      dashboardRestarted: true,
      dashboardPidBeforeRestart,
      dashboardPidAfterRestart: fixture.pids.dashboard,
      storeReloaded: true,
      reconciledState: reconciled.state,
      reattachInitialState: reattachment.initialResume.state,
      reattachStatusPolls: reattachment.statusPolls,
      reattachedTerminal: TERMINAL.has(reattachment.terminal.state),
      activityAttachments: activityCollector?.summary(initial.operationId) ?? null,
    },
  });
}

async function promiseWithDeadline(promise, timeoutMs, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(typedError(code)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function forceStopOwnedFixtureChildren(fixture, timeoutMs = 2_000) {
  const exits = [];
  for (const role of ['dashboard', 'cosmo', 'mcp']) {
    const child = fixture?.children?.[role];
    const expectedPid = fixture?.pids?.[role];
    if (!child || child.pid !== expectedPid || !Number.isSafeInteger(expectedPid) || expectedPid < 1) {
      throw typedError('isolated_fixture_cleanup_ownership_invalid', role);
    }
    if (child.exitCode !== null || child.signalCode) continue;
    exits.push(new Promise((resolve) => child.once('exit', resolve)));
    child.kill('SIGKILL');
  }
  if (exits.length > 0) {
    await promiseWithDeadline(
      Promise.all(exits),
      timeoutMs,
      'isolated_fixture_force_cleanup_timeout',
    );
  }
}

export function createBoundedFixtureCleanup({
  fixture,
  stopFixture,
  controller,
  signalTarget = process,
  timeoutMs = 20_000,
  forceTimeoutMs = 2_000,
} = {}) {
  if (!fixture || typeof stopFixture !== 'function'
      || !(controller instanceof AbortController)
      || !signalTarget || typeof signalTarget.once !== 'function'
      || typeof signalTarget.removeListener !== 'function'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1
      || !Number.isSafeInteger(forceTimeoutMs) || forceTimeoutMs < 1) {
    throw typedError('isolated_fixture_cleanup_invalid');
  }
  let cleanupPromise = null;
  let signalReceived = null;
  const cleanup = () => {
    cleanupPromise ||= (async () => {
      try {
        return await promiseWithDeadline(
          Promise.resolve().then(() => stopFixture(fixture)),
          timeoutMs,
          'isolated_fixture_cleanup_timeout',
        );
      } catch (error) {
        await forceStopOwnedFixtureChildren(fixture, forceTimeoutMs).catch((forceError) => {
          error.forceCleanupError = forceError;
        });
        throw error;
      }
    })();
    return cleanupPromise;
  };
  const onSignal = (signal) => {
    signalReceived ||= signal;
    const exitCode = signal === 'SIGINT' ? 130 : 143;
    if (!controller.signal.aborted) {
      controller.abort(typedError('acceptance_interrupted', signal, { signal, exitCode }));
    }
    void cleanup().catch(() => {});
  };
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  signalTarget.once('SIGINT', onSigint);
  signalTarget.once('SIGTERM', onSigterm);
  return Object.freeze({
    cleanup,
    dispose() {
      signalTarget.removeListener('SIGINT', onSigint);
      signalTarget.removeListener('SIGTERM', onSigterm);
    },
    get signalReceived() { return signalReceived; },
  });
}

export function createClientOptions({ baseUrl, callerAgent, values, onActivity, fetchImpl }) {
  return {
    baseUrl,
    callerAgent,
    ...(fetchImpl ? { fetchImpl } : {}),
    queryWaitMs: integer(values, 'query-wait-ms', { defaultValue: QUERY_WAIT_MS, min: 1 }),
    pgsWaitMs: integer(values, 'pgs-wait-ms', { defaultValue: PGS_WAIT_MS, min: 1 }),
    shortWaitMs: integer(values, 'short-wait-ms', { defaultValue: 5 * 60_000, min: 1 }),
    onActivity,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseCli(argv);
  const context = await receiptContext(values, env);
  let baseUrl = one(values, 'base-url');
  if (booleanFlag(values, 'controlled-provider', false)
      && (context.authority !== 'isolated-controlled' || !one(values, 'isolated-fixture'))) {
    throw typedError('controlled_provider_scope_invalid');
  }
  if (booleanFlag(values, 'list-healthy-models', false)) {
    if (!baseUrl) throw typedError('base_url_required');
    const payload = {
      helper: 'live-brain-tools-smoke', scenario: 'list-healthy-models',
      receiptKind: 'provider-probe', protectedResultRead: false,
      ...(await discoverHealthyModels(baseUrl)),
    };
    const output = one(values, 'output');
    const row = output
      ? await writeJsonReceipt(context, path.resolve(output), payload)
      : canonicalReceiptRow(context, payload);
    if (!output) process.stdout.write(`${JSON.stringify(row)}\n`);
    return row;
  }
  const scenario = one(values, 'scenario', { required: true });
  if (!SCENARIOS.includes(scenario)) throw typedError('scenario_invalid');
  if (baseUrl && booleanFlag(values, 'controlled-provider', false)
      && ISOLATED_LIFECYCLE_SCENARIOS.has(scenario)) {
    throw typedError('isolated_fixture_endpoint_override_refused');
  }
  const buildArtifactManifestRequested = scenario === 'verify-receipts'
    && booleanFlag(values, 'build-artifact-manifest', false);
  const verifyArtifactManifestRequested = scenario === 'verify-receipts'
    && booleanFlag(values, 'verify-artifact-manifest', false);
  if (buildArtifactManifestRequested && verifyArtifactManifestRequested) {
    throw typedError('artifact_manifest_mode_conflict');
  }
  if (verifyArtifactManifestRequested) {
    if (one(values, 'output')) throw typedError('artifact_manifest_verification_read_only');
    const verified = await verifyArtifactManifest({
      manifestPath: path.resolve(one(values, 'artifact-manifest', { required: true })),
      context,
    });
    const row = canonicalReceiptRow(context, {
      helper: 'live-brain-tools-smoke',
      scenario,
      receiptKind: 'artifact-manifest-verification',
      protectedResultRead: false,
      ...verified,
    });
    process.stdout.write(`${JSON.stringify(row)}\n`);
    return row;
  }
  if (buildArtifactManifestRequested) {
    return buildArtifactManifest({
      smokeRoot: path.resolve(one(values, 'smoke-root', { required: true })),
      output: path.resolve(one(values, 'output', { required: true })),
      context,
    });
  }
  const isolatedAutoLaunch = !baseUrl && ISOLATED_AUTO_LAUNCH_SCENARIOS.has(scenario);
  if (isolatedAutoLaunch && (context.authority !== 'isolated-controlled'
      || !booleanFlag(values, 'controlled-provider', false)
      || !one(values, 'isolated-fixture'))) {
    throw typedError('controlled_provider_scope_invalid');
  }
  if (!baseUrl && !isolatedAutoLaunch && !['verify-receipts'].includes(scenario)) {
    throw typedError('base_url_required');
  }
  if (one(values, 'heap-output') && !isolatedAutoLaunch) {
    throw typedError('isolated_fixture_heap_scope_invalid');
  }
  const fixtureAgent = one(values, 'fixture-agent');
  const callerAgent = one(values, 'caller-agent', {
    defaultValue: context.authority === 'isolated-controlled'
      ? (fixtureAgent || 'acceptance-fixture')
      : undefined,
  });
  if (!callerAgent || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(callerAgent)) {
    throw typedError('caller_agent_invalid');
  }
  if (isolatedAutoLaunch && fixtureAgent && fixtureAgent !== callerAgent) {
    throw typedError('isolated_fixture_requester_mismatch');
  }
  const modules = await loadProductionModules();
  const activityCollector = createActivityCollector();
  const activities = activityCollector.events;
  const controller = new AbortController();
  let fixture = null;
  let stopIsolatedFixture = null;
  let cleanupOwner = null;
  let metricSampler = null;
  let heapEvidence = null;
  let sourceIntegrityOptions = null;
  let sourceIntegrityBefore = null;
  let sourceIntegrity = null;
  let row;
  let stopped = null;
  try {
    if (isolatedAutoLaunch) {
      const fixtureModule = await import('./lib/isolated-brain-fixture.mjs');
      stopIsolatedFixture = fixtureModule.stopIsolatedFixture;
      const largePgs = scenario === 'large-pgs-isolated';
      if (largePgs) {
        const controlledPair = JSON.stringify(ISOLATED_CONTROLLED_PGS_PAIR);
        values['pgs-sweep-selection'] ||= controlledPair;
        values['pgs-synth-selection'] ||= controlledPair;
      }
      fixture = await fixtureModule.startIsolatedFixture({
        fixtureRoot: path.resolve(one(values, 'isolated-fixture', { required: true })),
        context,
        agent: callerAgent,
        nodeCount: largePgs
          ? integer(values, 'synthetic-nodes', { required: true, min: PGS_LARGE_MIN_NODES })
          : 2,
        edgeCount: largePgs
          ? integer(values, 'synthetic-edges', {
              required: true,
              min: integer(values, 'synthetic-nodes', {
                required: true,
                min: PGS_LARGE_MIN_NODES,
              }),
            })
          : 1,
        operationDelayMs: integer(values, 'fixture-operation-delay-ms', {
          defaultValue: 100, min: 0, max: 60_000,
        }),
      });
      cleanupOwner = createBoundedFixtureCleanup({
        fixture,
        stopFixture: stopIsolatedFixture,
        controller,
      });
      const suppliedStore = one(values, 'isolated-store');
      if (suppliedStore && path.resolve(suppliedStore) !== fixture.operationsRoot) {
        throw typedError('isolated_store_mismatch');
      }
      values['isolated-store'] = fixture.operationsRoot;
      baseUrl = fixture.baseUrl;
      sourceIntegrityOptions = { fixture };
      if (one(values, 'heap-output')) {
        metricSampler = startIsolatedMetricSampler(fixture, { signal: controller.signal });
        await metricSampler.ready;
      }
    } else if (context.authority === 'isolated-controlled'
        && booleanFlag(values, 'controlled-provider', false)
        && one(values, 'isolated-fixture')) {
      const fixtureRoot = await canonicalDirectory(
        path.resolve(one(values, 'isolated-fixture', { required: true })),
        'isolated fixture',
      );
      sourceIntegrityOptions = { fixtureRoot: fixtureRoot.path, agent: callerAgent };
    }
    if (sourceIntegrityOptions) {
      sourceIntegrityBefore = await captureFixtureSourceIntegrity(sourceIntegrityOptions);
    }
    const clientOptions = createClientOptions({
      baseUrl, callerAgent, values,
      onActivity: activityCollector.listener('primary'),
    });
    const client = new modules.BrainOperationsClient(clientOptions);
    row = fixture && ISOLATED_LIFECYCLE_SCENARIOS.has(scenario)
      ? await executeIsolatedLifecycleScenario({
          scenario, modules, fixture, client, clientOptions, values, context, callerAgent,
          signal: controller.signal, activities, activityCollector,
        })
      : await executeScenario({
          scenario, modules, client, values, context, baseUrl, callerAgent,
          signal: controller.signal, activityLog: activities,
          canaryOverride: fixture?.canary || null,
        });
  } finally {
    let finalizationError = null;
    try {
      if (metricSampler) heapEvidence = await metricSampler.stop();
    } catch (error) {
      finalizationError ||= error;
    }
    try {
      if (cleanupOwner) stopped = await cleanupOwner.cleanup();
    } catch (error) {
      finalizationError ||= error;
    } finally {
      cleanupOwner?.dispose();
    }
    try {
      if (sourceIntegrityBefore && sourceIntegrityOptions) {
        sourceIntegrity = await verifyFixtureSourceIntegrity(
          sourceIntegrityBefore,
          sourceIntegrityOptions,
        );
      }
    } catch (error) {
      finalizationError ||= error;
    }
    if (finalizationError) {
      if (controller.signal.reason?.code === 'acceptance_interrupted') {
        controller.signal.reason.finalizationError = finalizationError;
        throw controller.signal.reason;
      }
      throw finalizationError;
    }
  }
  row = {
    ...row,
    activityAttachments: activityCollector.summary(row?.operationId || null),
    ...(sourceIntegrity ? { isolatedSourceIntegrity: sourceIntegrity } : {}),
  };
  if (fixture) {
    row = {
      ...row,
      isolatedFixture: isolatedFixtureReceipt(fixture, stopped, sourceIntegrity),
    };
  }
  const heapOutputRaw = one(values, 'heap-output');
  if (heapOutputRaw) {
    if (!heapEvidence || !fixture) throw typedError('isolated_fixture_metric_unavailable');
    await writeJsonReceipt(context, path.resolve(heapOutputRaw), {
      helper: 'live-brain-tools-smoke',
      scenario,
      receiptKind: 'isolated-process-memory',
      protectedResultRead: false,
      requesterAgent: callerAgent,
      authorizedEndpoint: null,
      isolatedStore: fixture.operationsRoot,
      isolatedPids: { dashboard: fixture.pids.dashboard, cosmo: fixture.pids.cosmo },
      ...heapEvidence,
    });
  }
  const sseOutputRaw = one(values, 'sse-output');
  if (sseOutputRaw) await flushActivity(
    context, path.resolve(sseOutputRaw), activities, callerAgent, scenario, context.authority,
  );
  const output = path.resolve(one(values, 'output', { required: true }));
  await ensureFreshOutput(output);
  if (scenario === 'discover-canary') return writeJsonReceipt(context, output, row);
  return appendJsonlReceipt(context, output, row);
}

if (isMain(import.meta.url)) main().catch(failCli);
