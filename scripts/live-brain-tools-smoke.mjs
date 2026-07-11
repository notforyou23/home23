#!/usr/bin/env node

import fsp from 'node:fs/promises';
import path from 'node:path';
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
  readJson,
  receiptContext,
  sha256Bytes,
  typedError,
  writeJsonReceipt,
} from './lib/brain-acceptance-common.mjs';

export const QUERY_WAIT_MS = 90 * 60 * 1000;
export const PGS_WAIT_MS = 6 * 60 * 60 * 1000;
export const PGS_LARGE_MIN_NODES = 100_000;
export const SCENARIOS = Object.freeze([
  'discover-canary', 'own', 'direct-query', 'sibling', 'completed-research',
  'completed-research-compile', 'canonical-export', 'pgs', 'large-pgs-isolated',
  'graph', 'negative-targets', 'detach-reattach', 'cancel', 'restart-reconcile',
  'zero-result', 'synthesis-reconnect', 'mcp-parity', 'mcp-unavailable',
  'verify-receipts',
]);
const TERMINAL = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
const PROVIDER_OPERATION_TYPES = new Set(['query', 'pgs', 'research_compile', 'synthesis']);
const ACTIVITY_TYPES = new Set([
  'progress', 'progress_update', 'token', 'token_estimate',
  'phase', 'terminal', 'state', 'heartbeat', 'provider_selected',
  'provider_activity', 'provider_call_terminal', 'result_ready',
  'source_pin_attached', 'worker_assigned',
]);
const SWEEP_RECEIPT_MAX_COUNT = 10_000;
const SWEEP_EXCERPT_CHARACTERS = 512;

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

function terminalReceipt({
  context, values, baseUrl, callerAgent, scenario, terminal, activityLog = [], extras = {},
}) {
  const providerTerminalValidated = PROVIDER_OPERATION_TYPES.has(terminal.operationType)
    ? activityLog.some((activity) => activity?.operationId === terminal.operationId
      && activity?.type === 'provider_call_terminal')
    : null;
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
    error: terminal.error,
    result: resultProjection(terminal.result),
    ...extras,
  };
}

async function ensureFreshOutput(file) {
  try {
    const stat = await fsp.lstat(file);
    if (stat.size > 0) throw typedError('receipt_output_exists', file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readLastReceipt(file) {
  const rows = await readReceiptRows(file);
  return rows.at(-1);
}

export async function readReceiptRows(file, { verifyArtifact = true } = {}) {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024) {
    throw typedError('receipt_invalid');
  }
  const text = await fsp.readFile(file, 'utf8');
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length === 0) throw typedError('receipt_invalid');
  return lines.map((line) => {
    let row;
    try { row = JSON.parse(line); } catch (error) {
      throw typedError('receipt_invalid', 'receipt contains invalid JSON', { cause: error });
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw typedError('receipt_invalid');
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
      || receipt.sourceHealth !== 'healthy' || receipt.scenario !== 'discover-canary'
      || receipt.receiptRunId !== context.receiptRunId
      || receipt.authority !== context.authority
      || receipt.requesterAgent !== callerAgent) {
    throw typedError('canary_receipt_invalid');
  }
  return receipt;
}

function assertCanaryEvidence(terminal, canary) {
  const revision = evidenceRevision(terminal?.sourceEvidence);
  if (terminal?.sourceEvidence?.sourceHealth !== 'healthy'
      || revision !== canary.sourceRevision) {
    throw typedError('canary_source_revision_mismatch');
  }
  const selectedBrain = terminal.target?.brainId ?? terminal.sourceEvidence?.selectedBrain;
  if (canary.selectedBrain && selectedBrain && selectedBrain !== canary.selectedBrain) {
    throw typedError('canary_target_mismatch');
  }
}

function nodesFromGraph(value) {
  if (Array.isArray(value?.nodes)) return value.nodes;
  if (Array.isArray(value?.graph?.nodes)) return value.graph.nodes;
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

async function discoverCanary({ client, selector, signal }) {
  const target = await client.resolveTarget(selector);
  const graph = await client.graph({ ...(selector ? { target: selector } : {}), nodeLimit: 100, edgeLimit: 1 }, signal);
  const candidates = nodesFromGraph(graph).filter((node) => node?.id != null);
  for (const node of candidates) {
    const query = deriveCanaryQuery(node);
    const search = await client.search({ ...(selector ? { target: selector } : {}), query, topK: 20 }, signal);
    const match = resultsFromSearch(search).find((result) => String(result.id) === String(node.id));
    const revision = evidenceRevision(search.sourceEvidence);
    if (match && Number.isSafeInteger(revision) && search.sourceEvidence?.sourceHealth === 'healthy') {
      return { target, graph, search, query, nodeId: String(node.id), sourceRevision: revision };
    }
  }
  throw typedError('canary_unavailable');
}

async function fetchJson(url, init = {}, fetchImpl = fetch, timeoutMs = 30_000) {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    throw typedError(body?.error?.code || 'http_request_failed', body?.error?.message || `HTTP ${response.status}`, {
      status: response.status, body,
    });
  }
  return body;
}

function selectHealthyPair(modelId, models, healthyProviders) {
  const matches = models.filter((model) => model?.id === modelId && healthyProviders.has(model.provider));
  if (matches.length === 0) throw typedError('no_healthy_provider');
  const exact = matches.sort((left, right) => left.provider.localeCompare(right.provider))[0];
  return { provider: exact.provider, model: exact.id };
}

export async function discoverHealthyModels(baseUrl, fetchImpl = fetch) {
  const [catalogPayload, statusPayload] = await Promise.all([
    fetchJson(`${baseUrl}/api/models/catalog`, {}, fetchImpl, 120_000),
    fetchJson(`${baseUrl}/api/providers/status`, {}, fetchImpl, 120_000),
  ]);
  const healthy = new Set((statusPayload.providers || [])
    .filter((provider) => provider?.healthy === true).map((provider) => provider.provider));
  const models = catalogPayload.models || [];
  const defaults = catalogPayload.defaults || catalogPayload.catalog?.defaults || {};
  if (healthy.size === 0) throw typedError('no_healthy_provider');
  const modelSelection = selectHealthyPair(defaults.queryModel, models, healthy);
  const pgsSweep = selectHealthyPair(defaults.pgsSweepModel, models, healthy);
  const pgsSynth = modelSelection;
  return {
    modelSelection,
    pgsSweep,
    pgsSynth,
    probes: (statusPayload.providers || []).map((provider) => ({
      provider: provider.provider,
      healthy: provider.healthy === true,
      latency: provider.latency ?? null,
      timestamp: provider.timestamp ?? null,
    })),
  };
}

async function mcpCall(baseUrl, name, args, fetchImpl = fetch) {
  const body = await fetchJson(`${baseUrl}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `acceptance-${Date.now()}`, method: 'tools/call', params: { name, arguments: args } }),
  }, fetchImpl);
  if (body?.error) throw typedError(body.error.code || 'mcp_failed', body.error.message || 'MCP failed');
  const text = body?.result?.content?.find((entry) => entry?.type === 'text')?.text;
  if (typeof text !== 'string') throw typedError('mcp_result_invalid');
  try { return JSON.parse(text); } catch (error) { throw typedError('mcp_result_invalid', text.slice(0, 256), { cause: error }); }
}

async function verifyMcpParity({ client, baseUrl, canary, signal, fetchImpl = fetch }) {
  const dashboard = await client.search({ query: canary.query, topK: 20 }, signal);
  const mcp = await mcpCall(baseUrl, 'query_memory', { query: canary.query, limit: 20 }, fetchImpl);
  const dashboardIds = new Set(resultsFromSearch(dashboard).map((result) => String(result.id)));
  const mcpIds = new Set(resultsFromSearch(mcp).map((result) => String(result.id)));
  if (!dashboardIds.has(canary.nodeId) || !mcpIds.has(canary.nodeId)) throw typedError('mcp_canary_mismatch');
  const dashboardRevision = evidenceRevision(dashboard.sourceEvidence);
  const mcpRevision = evidenceRevision(mcp.evidence || mcp.sourceEvidence);
  if (dashboardRevision !== canary.sourceRevision || mcpRevision !== canary.sourceRevision
      || dashboard.sourceEvidence?.sourceHealth !== 'healthy'
      || (mcp.evidence || mcp.sourceEvidence)?.sourceHealth !== 'healthy') {
    throw typedError('mcp_source_revision_mismatch');
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
  const body = await response.json().catch(() => null);
  const reason = body?.mcp?.reason;
  if (response.ok || !expectedReasons.includes(reason)) throw typedError('mcp_unavailability_mismatch');
  return { reason, status: response.status };
}

export async function flushActivity(context, output, activities, callerAgent, scenario, authority) {
  if (!output) return;
  await ensureFreshOutput(output);
  const previousByOperation = new Map();
  for (const activity of activities) {
    const previous = previousByOperation.get(activity.operationId) ?? -1;
    if (typeof activity.operationId !== 'string' || !activity.operationId
        || !ACTIVITY_TYPES.has(activity.type)
        || !Number.isSafeInteger(activity.eventSequence)
        || activity.eventSequence <= previous) {
      throw typedError('operation_event_out_of_order');
    }
    previousByOperation.set(activity.operationId, activity.eventSequence);
    await appendJsonlReceipt(context, output, {
      helper: 'live-brain-tools-smoke',
      scenario,
      receiptKind: 'operation-event',
      requesterAgent: callerAgent,
      operationId: activity.operationId,
      type: activity.type,
      eventSequence: activity.eventSequence,
      state: activity.state,
      phase: activity.phase,
      eventUpdatedAt: activity.updatedAt,
      lastProviderActivityAt: activity.lastProviderActivityAt,
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
  return {
    helper: 'live-brain-tools-smoke', scenario: 'canonical-export', receiptKind: 'export',
    operationId: source.operationId, sourceReceipt: receiptPath,
    protectedResultRead: true, exportResult: result.metadata || null,
  };
}

async function lifecycleStart(client, values, signal) {
  const query = one(values, 'query', { defaultValue: 'controlled lifecycle acceptance canary' });
  const modelSelection = exactPair(values, 'model-selection');
  return client.start('query', { query, mode: 'quick', ...(modelSelection ? { modelSelection } : {}) }, signal);
}

export async function verifyReceiptManifest({
  manifestPath, modules, context, values, callerAgent, signal,
}) {
  const manifest = await readJson(manifestPath);
  const groups = manifest?.groups || {};
  const observed = [];
  const seenOperations = new Set();
  for (const [groupName, entries] of Object.entries(groups)) {
    if (!Array.isArray(entries)) throw typedError('identity_manifest_invalid');
    for (const entry of entries) {
      if (!entry?.operationId || !entry?.receipt) throw typedError('identity_manifest_invalid');
      if (seenOperations.has(entry.operationId)) throw typedError('receipt_terminal_duplicate');
      seenOperations.add(entry.operationId);
      const receiptPath = path.resolve(path.dirname(manifestPath), entry.receipt);
      const relative = path.relative(path.dirname(manifestPath), receiptPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)
          || !isInsideOrEqual(context.receiptRunDir, receiptPath)) {
        throw typedError('identity_manifest_invalid');
      }
      const rows = await readReceiptRows(receiptPath);
      const terminals = rows.filter((row) => row?.operationId === entry.operationId
        && row?.receiptKind === 'operation-terminal');
      if (terminals.length !== 1) throw typedError('receipt_terminal_duplicate');
      const receipt = terminals[0];
      if (rows.some((row) => row?.receiptKind === 'operation-terminal'
          && row?.operationId !== entry.operationId)
          || receipt.operationId !== entry.operationId
          || receipt.protectedResultRead !== true
          || receipt.receiptRunId !== context.receiptRunId
          || receipt.authority !== entry.authority
          || receipt.requesterAgent !== entry.requesterAgent) {
        throw typedError('identity_manifest_mismatch');
      }
      for (const row of rows.filter((candidate) => candidate.operationId === entry.operationId)) {
        if (row.receiptRunId !== receipt.receiptRunId || row.authority !== receipt.authority
            || row.requesterAgent !== receipt.requesterAgent
            || (Object.hasOwn(row, 'authorizedEndpoint')
              && row.authorizedEndpoint !== receipt.authorizedEndpoint)
            || (Object.hasOwn(row, 'isolatedStore')
              && row.isolatedStore !== receipt.isolatedStore)) {
          throw typedError('receipt_identity_conflict');
        }
      }
      if (entry.authority === 'live') {
        const baseUrl = entry.authorizedEndpoint;
        if (!baseUrl || receipt.authorizedEndpoint !== baseUrl || receipt.isolatedStore !== null) {
          throw typedError('identity_manifest_mismatch');
        }
        const Client = modules.BrainOperationsClient;
        const client = new Client({ baseUrl, callerAgent: entry.requesterAgent, queryWaitMs: QUERY_WAIT_MS, pgsWaitMs: PGS_WAIT_MS });
        const terminal = await protectedTerminal(client, entry.operationId, signal);
        if (terminal.state !== receipt.state) throw typedError('protected_readback_mismatch');
      } else if (!entry.isolatedStore || receipt.isolatedStore !== entry.isolatedStore
          || receipt.authorizedEndpoint !== null) {
        throw typedError('identity_manifest_mismatch');
      }
      observed.push({ group: groupName, operationId: entry.operationId, state: receipt.state });
    }
  }
  return { ok: true, observed };
}

function artifactAuthority(relativePath, context) {
  const [top] = relativePath.split(path.sep);
  if (top === 'live') return 'live';
  if (top === 'isolated-controlled') return 'isolated-controlled';
  return context.authority;
}

async function artifactRows(file) {
  const text = await fsp.readFile(file, 'utf8');
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return [];
  const rows = [];
  for (const line of lines) {
    try { rows.push(JSON.parse(line)); }
    catch { return []; }
  }
  return rows.every((row) => row && typeof row === 'object' && !Array.isArray(row)) ? rows : [];
}

async function collectArtifactFiles(root, excluded) {
  const files = [];
  async function walk(directory) {
    const before = await fsp.lstat(directory, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw typedError('artifact_tree_invalid');
    const names = (await fsp.readdir(directory)).sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const stat = await fsp.lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) throw typedError('artifact_symlink_refused', relative);
      if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile() && !excluded.has(absolute)) files.push({ absolute, relative });
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
      authority,
      size: hashed.physicalSize,
      sha256: hashed.sha256,
    });
  }
  const row = await writeJsonReceipt(context, manifestPath, {
    helper: 'live-brain-tools-smoke',
    scenario: 'verify-receipts',
    receiptKind: 'artifact-manifest',
    schemaVersion: 1,
    auditRoot: root.path,
    authorities: [...new Set(artifacts.map((entry) => entry.authority))].sort(),
    artifacts,
  });
  const manifestBytes = await fsp.readFile(manifestPath);
  const digest = sha256Bytes(manifestBytes);
  const temporary = `${digestPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${digest}  ${path.basename(manifestPath)}\n`, {
    mode: 0o600, flag: 'wx',
  });
  await fsp.rename(temporary, digestPath);
  return row;
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
} = {}) {
  const selector = targetSelector(values);
  if (scenario === 'discover-canary') {
    const discovered = await discoverCanary({ client, selector, signal });
    const terminal = await protectedTerminal(client, discovered.search.operationId, signal);
    if (terminal.sourceEvidence?.sourceHealth !== 'healthy'
        || evidenceRevision(terminal.sourceEvidence) !== discovered.sourceRevision) {
      throw typedError('canary_source_revision_mismatch');
    }
    return terminalReceipt({
      context, values, baseUrl, callerAgent, scenario, terminal, activityLog,
      extras: {
        query: discovered.query,
        nodeId: discovered.nodeId,
        sourceRevision: discovered.sourceRevision,
        sourceHealth: 'healthy',
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
    const evidence = terminal.sourceEvidence || {};
    if (resultsFromSearch(search).length !== 0 || evidence.sourceHealth !== 'healthy'
        || evidence.matchOutcome !== 'no_match'
        || evidence.completeCoverage !== true
        || Number(evidence.authoritativeTotals?.nodes ?? evidence.authoritativeTotal) <= 0) {
      throw typedError('zero_result_not_proven');
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
    return terminalReceipt({ context, values, baseUrl, callerAgent, scenario, terminal, activityLog, extras: {
      returnedTotals: terminal.sourceEvidence?.returnedTotals || {
        nodes: nodesFromGraph(graph).length, edges: Array.isArray(graph.edges) ? graph.edges.length : 0,
      },
      authoritativeTotals: terminal.sourceEvidence?.authoritativeTotals || null,
      limits: { nodeLimit, edgeLimit },
    } });
  }
  if (scenario === 'negative-targets') {
    const expected = String(one(values, 'expect-codes', { required: true })).split(',').filter(Boolean);
    const catalog = await client.getCatalog({ forceRefresh: true, signal });
    const observed = new Set();
    const attempts = [
      () => client.resolveTarget({ agent: `missing-${Date.now()}` }),
      () => client.resolveTarget({ brainId: `missing-${Date.now()}` }),
    ];
    const unavailable = catalog.brains.find((brain) => !((brain.kind === 'resident' && brain.lifecycle === 'resident')
      || (brain.kind === 'research' && brain.lifecycle === 'completed')));
    if (unavailable) attempts.push(() => client.resolveTarget({ brainId: unavailable.id }));
    for (const attempt of attempts) {
      try { await attempt(); } catch (error) { observed.add(error.code || error.message); }
    }
    if (!expected.every((code) => observed.has(code))) {
      throw typedError('negative_target_coverage_failed');
    }
    return {
      helper: 'live-brain-tools-smoke', scenario, receiptKind: 'authority-negative',
      requesterAgent: callerAgent, protectedResultRead: false,
      expectedCodes: expected, observedCodes: [...observed].sort(),
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
    return terminalReceipt({ context, values, baseUrl, callerAgent, scenario, terminal, activityLog, extras: {
      providerAbortObserved: terminal.error?.code === 'cancelled'
        || terminal.result?.providerAbortObserved === true,
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
        modules, context, values, callerAgent, signal,
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
    assertCanaryEvidence(terminal, canary);
    return terminalReceipt({ context, values, baseUrl, callerAgent, scenario, terminal, activityLog });
  }

  if (['own', 'direct-query', 'sibling', 'completed-research', 'pgs', 'large-pgs-isolated'].includes(scenario)) {
    const canary = await canaryFromReceipt(values, context, callerAgent);
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
      mode: one(values, 'mode', { defaultValue: 'quick' }),
      ...(pgs ? {
        enablePGS: true,
        pgsMode: 'full',
        pgsConfig: { sweepFraction: numberValue(values, 'sweep-fraction', { defaultValue: 0.1, min: 0, max: 1, exclusiveMin: true }) },
        ...(exactPair(values, 'pgs-sweep-selection') ? { pgsSweep: exactPair(values, 'pgs-sweep-selection') } : {}),
        ...(exactPair(values, 'pgs-synth-selection') ? { pgsSynth: exactPair(values, 'pgs-synth-selection') } : {}),
      } : {
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
    assertCanaryEvidence(terminal, canary);
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
  const baseUrl = one(values, 'base-url');
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
  if (scenario === 'verify-receipts' && booleanFlag(values, 'build-artifact-manifest', false)) {
    return buildArtifactManifest({
      smokeRoot: path.resolve(one(values, 'smoke-root', { required: true })),
      output: path.resolve(one(values, 'output', { required: true })),
      context,
    });
  }
  if (!baseUrl && !['verify-receipts'].includes(scenario)) throw typedError('base_url_required');
  const callerAgent = one(values, 'caller-agent', {
    defaultValue: context.authority === 'isolated-controlled' ? 'acceptance-fixture' : undefined,
  });
  if (!callerAgent || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(callerAgent)) {
    throw typedError('caller_agent_invalid');
  }
  const modules = await loadProductionModules();
  const activities = [];
  const client = new modules.BrainOperationsClient(createClientOptions({
    baseUrl,
    callerAgent,
    values,
    onActivity: (activity) => activities.push(activity),
  }));
  const controller = new AbortController();
  const row = await executeScenario({
    scenario, modules, client, values, context, baseUrl, callerAgent,
    signal: controller.signal, activityLog: activities,
  });
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
