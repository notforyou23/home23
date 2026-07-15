'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const {
  captureOperationScratchBoundary,
  closeScratchBoundary,
  ensureExactScratchChild,
  openPinnedPGSStore,
  lowerLimits,
  verifyScratchBoundary,
  COVERAGE_LEVELS,
  COVERAGE_SELECTION_POLICY_VERSION,
  QUERY_NORMALIZATION_VERSION,
  SWEEP_PROMPT_CONTRACT_VERSION,
} = require('./pinned-store');
const {
  ProviderCompletionError,
  assertProviderResultIdentity,
  requireCompleteProviderResult,
} = require('../../lib/provider-completion');
const {
  assertProviderInputWithinBudget,
  resolveProviderInputBudget,
} = require('../../lib/provider-input-budget');
const { getModelCapabilities } = require('../../server/config/model-catalog');

// Keep this internal so callers cannot override the resource boundary. Four
// concurrent bounded work units preserve the read-only/memory limits while
// leaving enough headroom for durable commits and synthesis inside the
// wait-aware large-graph acceptance window.
const PINNED_SWEEP_CONCURRENCY = 4;
const MAX_GENERATED_WORK_UNIT_ID_BYTES = 256;
const SWEEP_INSTRUCTIONS = 'Analyze only this pinned PGS work unit. Return evidence-backed findings and explicit absences.';
const SYNTHESIS_INSTRUCTIONS = 'Synthesize the pinned PGS findings into a direct answer. Preserve absences and cite work-unit IDs.';
const SYNTHESIS_REDUCTION_INSTRUCTIONS = 'Reduce this bounded shard of pinned PGS findings. Preserve substantive evidence, explicit absences, contradictions, and every cited work-unit ID for final synthesis.';
const SYNTHESIS_REDUCTION_TRUNCATION_MARKER = '\n[PGS intermediate reduction truncated at byte limit]';

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

function exactPair(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== 'model\0provider') {
    throw typed('provider_model_mismatch', `${label} requires an exact provider/model pair`);
  }
  const provider = typeof value.provider === 'string' ? value.provider.trim() : '';
  const model = typeof value.model === 'string' ? value.model.trim() : '';
  if (!provider || !model || provider.length > 256 || model.length > 256) {
    throw typed('provider_model_mismatch', `${label} requires an exact provider/model pair`);
  }
  return Object.freeze({ provider, model });
}

function resolveScopeRequest(options, pgsConfig) {
  if (!pgsConfig || typeof pgsConfig !== 'object' || Array.isArray(pgsConfig)
      || Object.keys(pgsConfig).some(key => key !== 'sweepFraction')) {
    throw typed('invalid_request', 'PGS configuration is invalid');
  }
  const sweepFraction = pgsConfig.sweepFraction === undefined ? 1 : pgsConfig.sweepFraction;
  const derivedLevel = Object.entries(COVERAGE_LEVELS)
    .find(([, fraction]) => fraction === sweepFraction)?.[0];
  const coverageLevel = options.pgsLevel === undefined ? derivedLevel : options.pgsLevel;
  if (!Object.hasOwn(COVERAGE_LEVELS, coverageLevel)
      || COVERAGE_LEVELS[coverageLevel] !== sweepFraction) {
    throw typed('invalid_request', 'PGS level does not match its derived coverage fraction');
  }
  const mode = options.pgsMode === undefined
    ? (options.targetPartitionIds === undefined ? 'fresh' : 'targeted')
    : options.pgsMode;
  if (!['fresh', 'continue', 'targeted'].includes(mode)) {
    throw typed('invalid_request', 'PGS mode is invalid');
  }
  if (mode === 'targeted') {
    if (!Array.isArray(options.targetPartitionIds)) {
      throw typed('invalid_request', 'Targeted PGS requires partition IDs');
    }
  } else if (options.targetPartitionIds !== undefined) {
    throw typed('invalid_request', 'PGS target partition IDs require targeted mode');
  }
  return Object.freeze({
    mode,
    coverageLevel,
    coverageFraction: sweepFraction,
    targetPartitionIds: mode === 'targeted' ? options.targetPartitionIds : undefined,
  });
}

function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
}

function assertBytes(value, maximum, label) {
  if (utf8Bytes(value) > maximum) throw typed('result_too_large', `${label} exceeds the byte limit`);
}

function providerEventType(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 128)
    : 'provider_event';
}

function providerEventAt(value) {
  return typeof value === 'string' && value.length <= 128 ? value : null;
}

function buildWorkInput(query, work, maximumBytes) {
  const parts = [`Query: ${query}\n\nPinned work unit ${work.workUnitId}:\n`];
  let bytes = utf8Bytes(parts[0]);
  if (bytes > maximumBytes) {
    throw typed('result_too_large', 'PGS sweep scaffold exceeds the provider input byte limit');
  }
  const append = (prefix, record, required) => {
    let json;
    try { json = JSON.stringify(record); } catch { json = null; }
    if (typeof json !== 'string') {
      throw typed('source_invalid', 'PGS work-unit record is not serializable');
    }
    const text = `${prefix}${json}\n`;
    const textBytes = utf8Bytes(text);
    if (bytes + textBytes > maximumBytes) {
      if (required) {
        throw typed('result_too_large', 'PGS work unit exceeds the provider input byte limit');
      }
      return false;
    }
    parts.push(text);
    bytes += textBytes;
    return true;
  };
  for (const node of work.nodes) append('NODE ', node, true);
  for (const edge of work.edges) if (!append('EDGE ', edge, false)) break;
  return parts.join('');
}

function synthesisScaffold(query, level, final) {
  return `Original query: ${query}\n\nPinned PGS ${
    final ? 'findings for final synthesis' : `findings for reduction level ${level}`
  }:\n`;
}

function buildSynthesisInput(query, synthesisItems, maximumBytes, { level = 1, final = true } = {}) {
  const parts = [synthesisScaffold(query, level, final)];
  let bytes = utf8Bytes(parts[0]);
  if (bytes > maximumBytes) {
    throw typed('result_too_large', 'PGS synthesis scaffold exceeds the provider input byte limit');
  }
  for (const row of synthesisItems) {
    let json;
    try { json = JSON.stringify(row); } catch { json = null; }
    if (typeof json !== 'string') {
      throw typed('pgs_projection_invalid', 'PGS synthesis row is not serializable');
    }
    const text = `${json}\n`;
    bytes += utf8Bytes(text);
    if (bytes > maximumBytes) {
      throw typed('result_too_large', 'PGS synthesis input exceeds the provider input byte limit');
    }
    parts.push(text);
  }
  return parts.join('');
}

function splitSynthesisRow(row, maximumBytes) {
  const serialized = JSON.stringify(row);
  if (utf8Bytes(`${serialized}\n`) <= maximumBytes) return [row];
  if (typeof row.output !== 'string') {
    throw typed('result_too_large', 'PGS synthesis item exceeds the provider input byte limit');
  }
  const encoded = Buffer.from(row.output, 'utf8');
  const fragments = [];
  let offset = 0;
  while (offset < encoded.length) {
    let low = offset + 1;
    let high = encoded.length;
    let acceptedEnd = offset;
    while (low <= high) {
      let end = Math.floor((low + high) / 2);
      if (end < encoded.length) {
        while (end > offset && (encoded[end] & 0xC0) === 0x80) end -= 1;
      }
      let minimumCandidate = false;
      if (end === offset) {
        end = offset + 1;
        while (end < encoded.length && (encoded[end] & 0xC0) === 0x80) end += 1;
        minimumCandidate = end > high;
      }
      const candidate = {
        ...row,
        fragmentIndex: Number.MAX_SAFE_INTEGER,
        fragmentCount: Number.MAX_SAFE_INTEGER,
        output: encoded.subarray(offset, end).toString('utf8'),
      };
      if (utf8Bytes(`${JSON.stringify(candidate)}\n`) <= maximumBytes) {
        acceptedEnd = end;
        low = end + 1;
      } else {
        high = end - 1;
      }
      if (minimumCandidate) break;
    }
    if (acceptedEnd === offset) {
      throw typed('result_too_large', 'PGS synthesis item metadata exceeds the provider input byte limit');
    }
    fragments.push(encoded.subarray(offset, acceptedEnd).toString('utf8'));
    offset = acceptedEnd;
  }
  return fragments.map((output, index) => ({
    ...row,
    fragmentIndex: index + 1,
    fragmentCount: fragments.length,
    output,
  }));
}

function packSynthesisBatches(query, items, maximumBytes, { level, final }) {
  const scaffold = synthesisScaffold(query, level, final);
  const scaffoldBytes = utf8Bytes(scaffold);
  if (scaffoldBytes >= maximumBytes) {
    throw typed('result_too_large', 'PGS synthesis scaffold exceeds the provider input byte limit');
  }
  const maximumRowBytes = maximumBytes - scaffoldBytes;
  const expanded = items.flatMap(row => splitSynthesisRow(row, maximumRowBytes));
  const batches = [];
  let current = [];
  let currentBytes = scaffoldBytes;
  for (const row of expanded) {
    const rowBytes = utf8Bytes(`${JSON.stringify(row)}\n`);
    if (current.length && currentBytes + rowBytes > maximumBytes) {
      batches.push(current);
      current = [];
      currentBytes = scaffoldBytes;
    }
    if (currentBytes + rowBytes > maximumBytes) {
      throw typed('result_too_large', 'PGS synthesis item exceeds the provider input byte limit');
    }
    current.push(row);
    currentBytes += rowBytes;
  }
  if (current.length) batches.push(current);
  return batches;
}

function encodedSynthesisItemBytes(items) {
  let total = 0;
  for (const row of items) {
    const bytes = utf8Bytes(`${JSON.stringify(row)}\n`);
    if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(total + bytes)) {
      throw typed('result_too_large', 'PGS synthesis encoded byte accounting overflowed');
    }
    total += bytes;
  }
  return total;
}

function resolveIntermediateOutputBytes(maximumInputBytes, maximumOutputBytes) {
  const targetEncodedRowBytes = Math.floor(maximumInputBytes / 4);
  const rowOverheadBytes = utf8Bytes(`${JSON.stringify({
    kind: 'synthesis-shard',
    level: Number.MAX_SAFE_INTEGER,
    shard: Number.MAX_SAFE_INTEGER,
    output: '',
  })}\n`);
  // JSON control escapes can expand one decoded UTF-8 byte to six ASCII bytes
  // (for example NUL becomes "\\u0000"). Cap the provider's decoded output so
  // every possible encoded shard still occupies at most one quarter of the
  // following level's exact input budget.
  const jsonSafeOutputBytes = Math.floor((targetEncodedRowBytes - rowOverheadBytes) / 6);
  return Math.min(maximumOutputBytes, jsonSafeOutputBytes);
}

function truncateIntermediateOutput(value, maximumBytes) {
  const originalBytes = utf8Bytes(value);
  if (originalBytes <= maximumBytes) {
    return { output: value, originalBytes, retainedBytes: originalBytes, truncated: false };
  }
  const markerBytes = utf8Bytes(SYNTHESIS_REDUCTION_TRUNCATION_MARKER);
  const contentBytes = maximumBytes - markerBytes;
  if (contentBytes <= 0) {
    throw typed('result_too_large', 'PGS synthesis reduction leaves no truncation content budget');
  }
  const encoded = Buffer.from(value, 'utf8');
  let end = Math.min(contentBytes, encoded.length);
  while (end > 0 && end < encoded.length && (encoded[end] & 0xC0) === 0x80) end -= 1;
  if (end <= 0) {
    throw typed('result_too_large', 'PGS synthesis reduction cannot retain valid UTF-8 content');
  }
  const output = `${encoded.subarray(0, end).toString('utf8')}${
    SYNTHESIS_REDUCTION_TRUNCATION_MARKER
  }`;
  const retainedBytes = utf8Bytes(output);
  if (retainedBytes > maximumBytes) {
    throw typed('result_too_large', 'PGS synthesis reduction truncation exceeded its byte limit');
  }
  return { output, originalBytes, retainedBytes, truncated: true };
}

function canReturnUsefulSynthesisPartial(error) {
  if (error instanceof ProviderCompletionError) return true;
  if (!error?.code) return true;
  return error.code === 'result_too_large'
    || error.code === 'model_capability_invalid'
    || error.code === 'pgs_synthesis_nonconvergent'
    || String(error.code).startsWith('provider_');
}

function normalizeFailure(error) {
  return {
    code: String(error?.code || 'provider_failed').slice(0, 128),
    message: String(error?.message || 'Provider failed').slice(0, 4096),
    retryable: error?.retryable !== false,
  };
}

function sameIdentity(stat, expected) {
  return Boolean(stat && expected && stat.dev === expected.dev && stat.ino === expected.ino);
}

function receiptPathError(message, cause) {
  const error = typed('invalid_request', message);
  if (cause) error.cause = cause;
  return error;
}

async function optionalLstat(filePath) {
  return fsp.lstat(filePath, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function assertExactReceiptFile(filePath, identity, boundary, { size } = {}) {
  await verifyScratchBoundary(boundary);
  let stat;
  try {
    stat = await fsp.lstat(filePath, { bigint: true });
  } catch (error) {
    throw receiptPathError('PGS receipt artifact is unavailable', error);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n
      || !sameIdentity(stat, identity)
      || (size !== undefined && stat.size !== BigInt(size))) {
    throw receiptPathError('PGS receipt artifact identity changed');
  }
  return stat;
}

async function removeExactReceiptFile(filePath, identity, boundary) {
  await verifyScratchBoundary(boundary);
  const stat = await optionalLstat(filePath);
  if (stat === null) return false;
  if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, identity)) {
    throw receiptPathError('PGS receipt cleanup identity changed');
  }
  const latest = await fsp.lstat(filePath, { bigint: true });
  if (!latest.isFile() || latest.isSymbolicLink() || !sameIdentity(latest, identity)) {
    throw receiptPathError('PGS receipt cleanup identity changed');
  }
  await fsp.unlink(filePath);
  await verifyScratchBoundary(boundary);
  return true;
}

async function verifyReceiptReadback(filePath, identity, bytes, boundary) {
  await assertExactReceiptFile(filePath, identity, boundary, { size: bytes.length });
  let handle;
  try {
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size !== BigInt(bytes.length)
        || !sameIdentity(opened, identity)) {
      throw receiptPathError('PGS receipt readback identity changed');
    }
    const expected = createHash('sha256').update(bytes).digest('hex');
    const actual = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, bytes.length - offset), offset);
      if (bytesRead <= 0) throw receiptPathError('PGS receipt readback ended early');
      actual.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (actual.digest('hex') !== expected) {
      throw receiptPathError('PGS receipt readback content changed');
    }
  } finally {
    await handle?.close().catch(() => {});
  }
  await assertExactReceiptFile(filePath, identity, boundary, { size: bytes.length });
}

async function writeSuccessReceipt({
  engine, attemptId, result, signal, scratchQuota,
  receiptBoundary, receiptDirectory,
}) {
  throwIfAborted(signal);
  const scratchCapture = receiptBoundary.directories[1];
  const directory = receiptDirectory || await ensureExactScratchChild(
    receiptBoundary,
    scratchCapture,
    'pgs-receipts',
  );
  const root = directory.path;
  const destination = path.join(root, `${attemptId}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify({
    version: 1,
    attemptId,
    completedAt: new Date(engine.operationClock.now()).toISOString(),
    result,
  })}\n`, 'utf8');
  let handle = null;
  let temporaryIdentity = null;
  let temporaryPresent = false;
  let destinationPublished = false;
  try {
    await verifyScratchBoundary(receiptBoundary);
    if (await optionalLstat(destination) !== null) {
      throw receiptPathError('PGS receipt already exists');
    }
    if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
      throw receiptPathError('PGS receipt requires no-follow file creation');
    }
    handle = await fsp.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | fs.constants.O_NOFOLLOW,
      0o600,
    );
    temporaryPresent = true;
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw receiptPathError('PGS receipt temporary is not a private regular file');
    }
    temporaryIdentity = Object.freeze({ dev: opened.dev, ino: opened.ino });
    await assertExactReceiptFile(temporary, temporaryIdentity, receiptBoundary, { size: 0 });
    await handle.writeFile(bytes);
    await handle.sync();
    await assertExactReceiptFile(temporary, temporaryIdentity, receiptBoundary, { size: bytes.length });
    await scratchQuota.reconcile();
    throwIfAborted(signal);
    await verifyScratchBoundary(receiptBoundary);
    if (await optionalLstat(destination) !== null) {
      throw receiptPathError('PGS receipt appeared before publication');
    }
    await handle.close();
    handle = null;
    await fsp.link(temporary, destination);
    destinationPublished = true;
    await fsp.unlink(temporary);
    temporaryPresent = false;
    await assertExactReceiptFile(destination, temporaryIdentity, receiptBoundary, { size: bytes.length });
    fs.fsyncSync(directory.fd);
    await verifyReceiptReadback(destination, temporaryIdentity, bytes, receiptBoundary);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (temporaryIdentity) {
      if (destinationPublished) {
        await removeExactReceiptFile(destination, temporaryIdentity, receiptBoundary).catch(() => {});
      }
      if (temporaryPresent) {
        await removeExactReceiptFile(temporary, temporaryIdentity, receiptBoundary).catch(() => {});
      }
      try { fs.fsyncSync(directory.fd); } catch {}
      await scratchQuota.reconcile().catch(() => {});
    }
    if (signal?.aborted) throw signal.reason;
    if (error?.code === 'invalid_request') throw error;
    throw error;
  }
}

async function runPinnedOperationCore(engine, options = {}) {
  const {
    sourcePin,
    scratchDir,
    scratchQuota,
    query,
    signal = null,
    reportEvent = null,
    onChunk = null,
    pgsConfig = {},
  } = options;
  throwIfAborted(signal);
  if (typeof query !== 'string' || !query.trim()) throw typed('invalid_request', 'PGS query is required');
  if (!sourcePin) throw typed('source_pin_required', 'PGS source pin is required');
  if (options.allowActions === true || options.mutationPolicy === 'write'
      || (options.accessMode && options.accessMode !== 'read-only')) {
    throw typed('access_denied', 'PGS operation is read-only');
  }
  const scopeRequest = resolveScopeRequest(options, pgsConfig);
  const sweepFraction = scopeRequest.coverageFraction;
  const concurrency = PINNED_SWEEP_CONCURRENCY;
  const limits = lowerLimits(options.limits || {});
  const sweepPair = exactPair(options.pgsSweep, 'pgsSweep');
  const synthPair = exactPair(options.pgsSynth, 'pgsSynth');
  const catalog = options.modelCatalog || engine.modelCatalog;
  const registry = options.providerRegistry || engine.providerRegistry;
  if (!catalog?.providers || !registry || typeof registry.get !== 'function') {
    throw typed('provider_unavailable', 'PGS provider registry is unavailable', true);
  }
  const sweepCapabilities = getModelCapabilities(catalog, sweepPair.provider, sweepPair.model);
  const synthCapabilities = getModelCapabilities(catalog, synthPair.provider, synthPair.model);
  const sweepInputBudget = resolveProviderInputBudget(sweepCapabilities, {
    maxInputBytes: limits.maxContextCharsPerWorkUnit,
    label: 'PGS sweep input',
  });
  const synthInputBudget = resolveProviderInputBudget(synthCapabilities, {
    maxInputBytes: limits.maxSynthesisInputBytes,
    label: 'PGS synthesis input',
  });
  const maximumWorkUnitScaffold = `Query: ${query}\n\nPinned work unit ${
    'w'.repeat(MAX_GENERATED_WORK_UNIT_ID_BYTES)
  }:\n`;
  const sweepRecordBudget = sweepInputBudget.inputBudgetBytes
    - utf8Bytes(SWEEP_INSTRUCTIONS)
    - utf8Bytes(maximumWorkUnitScaffold)
    - (limits.maxNodesPerWorkUnit * utf8Bytes('NODE \n'));
  if (!Number.isSafeInteger(sweepRecordBudget) || sweepRecordBudget <= 0) {
    throw typed('result_too_large', 'PGS sweep input leaves no work-unit record budget');
  }
  const storeLimits = Object.freeze({
    ...limits,
    // The store groups exact serialized node bytes. Lowering this boundary
    // ensures every persisted unit leaves room for instructions, the current
    // query, the longest generated work-unit ID, and every NODE separator.
    maxContextCharsPerWorkUnit: Math.min(
      limits.maxContextCharsPerWorkUnit,
      sweepRecordBudget,
    ),
  });
  const sweepClient = registry.get(sweepPair.provider, sweepPair.model);
  const synthClient = registry.get(synthPair.provider, synthPair.model);
  for (const [pair, client, label] of [
    [sweepPair, sweepClient, 'sweep'], [synthPair, synthClient, 'synthesis'],
  ]) {
    if (typeof client?.generate !== 'function') {
      throw typed('provider_unavailable', `PGS ${label} provider is unavailable`, true);
    }
    if (client.providerId !== pair.provider) {
      throw typed('provider_model_mismatch', `PGS ${label} provider identity mismatch`);
    }
  }
  const emit = event => {
    if (typeof reportEvent === 'function') reportEvent(Object.freeze(event));
  };
  emit({
    type: 'progress',
    phase: 'pgs_projection',
    stage: 'projection_started',
  });
  const receiptBoundary = await captureOperationScratchBoundary(scratchDir, scratchQuota);
  let receiptDirectory;
  let store;
  let sourceEvidence;
  try {
    receiptDirectory = await ensureExactScratchChild(
      receiptBoundary,
      receiptBoundary.directories[1],
      'pgs-receipts',
      { create: false },
    );
    store = await (engine.openPinnedPGSStore || openPinnedPGSStore)({
      sourcePin, scratchDir, scratchQuota, pgsSweep: sweepPair, query, signal, limits: storeLimits,
      sessionStorage: options.sessionStorage,
      queryNormalizationVersion: QUERY_NORMALIZATION_VERSION,
      sweepPromptContractVersion: SWEEP_PROMPT_CONTRACT_VERSION,
      coverageSelectionPolicyVersion: COVERAGE_SELECTION_POLICY_VERSION,
      statfsImpl: options.statfsImpl, clock: engine.operationClock,
    });
    const returnedTotals = {
      nodes: store.stats?.nodeCount,
      edges: store.stats?.edgeCount,
    };
    if (!Number.isSafeInteger(returnedTotals.nodes) || returnedTotals.nodes < 0
        || !Number.isSafeInteger(returnedTotals.edges) || returnedTotals.edges < 0) {
      throw typed('pgs_projection_invalid', 'PGS projection source totals are invalid');
    }
    sourceEvidence = typeof sourcePin.getEvidence === 'function'
      ? sourcePin.getEvidence({
        route: 'pinned-pgs',
        returnedTotals,
        completeCoverage: true,
      })
      : sourcePin.evidence || null;
    emit({
      type: 'progress',
      phase: 'pgs_projection',
      stage: 'projection_complete',
      nodeCount: returnedTotals.nodes,
      edgeCount: returnedTotals.edges,
      workUnitCount: store.stats?.workUnitCount,
    });
  } catch (error) {
    try {
      store?.close();
    } finally {
      closeScratchBoundary(receiptBoundary);
    }
    throw error;
  }
  const uncommitted = [];
  try {
    const validateCompletion = engine.requireCompleteProviderResult || requireCompleteProviderResult;
    const attemptId = `attempt-${randomUUID()}`;
    const scopeAtStart = store.planScope({
      attemptId,
      coverageLevel: scopeRequest.coverageLevel,
      coverageFraction: scopeRequest.coverageFraction,
      ...(scopeRequest.targetPartitionIds === undefined
        ? {}
        : { targetPartitionIds: scopeRequest.targetPartitionIds }),
    });
    const selected = [];

  async function providerCall({
    phase,
    pair,
    capabilities,
    client,
    id,
    work,
    instructions,
    input,
    maxInputBytes,
    maxOutputBytes,
    streamChunks = false,
  }) {
    const context = work ? { workUnitId: work.workUnitId, partitionId: work.partitionId } : {};
    const inputMeasurement = assertProviderInputWithinBudget({
      capabilities,
      maxInputBytes,
      instructions,
      input,
      label: phase === 'pgs_synthesis' ? 'PGS synthesis input' : 'PGS sweep input',
    });
    emit({
      type: 'provider_selected', phase, provider: pair.provider, model: pair.model,
      providerStallMs: capabilities.providerStallMs, providerCallId: id,
      providerInputBytes: inputMeasurement.totalInputBytes,
      providerInputBudgetBytes: inputMeasurement.inputBudgetBytes,
      ...context,
    });
    let outcome = 'failed';
    try {
      const raw = await client.generate({
        provider: pair.provider,
        model: pair.model,
        instructions,
        input,
        maxOutputTokens: capabilities.maxOutputTokens,
        maxOutputBytes,
        signal,
        onChunk: streamChunks ? onChunk : null,
        onProviderActivity(child = {}) {
          throwIfAborted(signal);
          emit({
            type: 'provider_activity', phase, provider: pair.provider, model: pair.model,
            providerCallId: id, ...context,
            childEventType: providerEventType(child.type),
            providerEventAt: providerEventAt(child.at),
          });
        },
      });
      throwIfAborted(signal);
      const complete = validateCompletion(raw);
      assertProviderResultIdentity(complete, pair.provider, pair.model);
      throwIfAborted(signal);
      outcome = 'complete';
      return complete;
    } catch (error) {
      if (signal?.aborted) {
        outcome = 'cancelled';
        throw signal.reason;
      }
      throw error;
    } finally {
      emit({
        type: 'provider_call_terminal', phase, provider: pair.provider, model: pair.model,
        providerCallId: id, ...context, outcome,
      });
    }
  }

  async function sweep(workUnitId, workAttemptId) {
    throwIfAborted(signal);
    store.beginWorkUnitAttempt(workUnitId, {
      attemptId: workAttemptId, provider: sweepPair.provider, model: sweepPair.model,
      startedAt: new Date(engine.operationClock.now()).toISOString(),
    });
    const work = store.loadWorkUnit(workUnitId, { signal });
    const completion = await providerCall({
      phase: 'pgs_sweep', pair: sweepPair, capabilities: sweepCapabilities,
      client: sweepClient, id: `pgs:${workUnitId}`, work,
      instructions: SWEEP_INSTRUCTIONS,
      input: buildWorkInput(
        query,
        work,
        sweepInputBudget.inputBudgetBytes - utf8Bytes(SWEEP_INSTRUCTIONS),
      ),
      maxInputBytes: limits.maxContextCharsPerWorkUnit,
      maxOutputBytes: limits.maxSweepOutputBytes,
    });
    const output = String(completion.content || '').trim();
    if (!output) throw typed('provider_incomplete', 'PGS sweep returned no content', true);
    assertBytes(output, limits.maxSweepOutputBytes, 'PGS sweep output');
    return { workUnitId, output };
  }

    let batchIndex = 0;
    const failedWorkUnits = new Set();
    const settledFailedWorkUnits = new Set();
    const retryableWorkUnits = new Set();
    let afterWorkUnitId;
    while (true) {
      throwIfAborted(signal);
      const workAttemptId = batchIndex === 0
        ? attemptId
        : `${attemptId}-batch-${String(batchIndex).padStart(4, '0')}`;
      if (batchIndex > 0) {
        store.planScope({
          attemptId: workAttemptId,
          coverageLevel: scopeRequest.coverageLevel,
          coverageFraction: scopeRequest.coverageFraction,
          ...(scopeRequest.targetPartitionIds === undefined
            ? {}
            : { targetPartitionIds: scopeRequest.targetPartitionIds }),
        });
      }
      const pendingBatch = store.snapshotPendingWorkUnits({
        attemptId: workAttemptId,
        limit: limits.maxSelectedWorkUnits,
        ...(afterWorkUnitId === undefined ? {} : { afterWorkUnitId }),
      });
      const batch = pendingBatch.filter(id => !failedWorkUnits.has(id));
      if (!batch.length) break;
      afterWorkUnitId = pendingBatch.at(-1);
      selected.push(...batch);
      emit({
        type: 'progress',
        phase: 'pgs_sweep',
        stage: 'work_selected',
        selectedWorkUnits: batch.length,
        selectedWorkUnitsTotal: scopeAtStart.scopeSuccessfulWorkUnits + selected.length,
        candidateWorkUnits: store.countScopePendingWorkUnits(workAttemptId),
        pendingWorkUnits: store.countPendingWorkUnits(),
        batchIndex,
      });

      for (let offset = 0; offset < batch.length; offset += concurrency) {
        throwIfAborted(signal);
        const ids = batch.slice(offset, offset + concurrency);
        const settled = await Promise.allSettled(ids.map(id => sweep(id, workAttemptId)));
        settled.forEach(row => { if (row.status === 'fulfilled') uncommitted.push(row.value); });
        if (signal?.aborted) {
          if (uncommitted.length) await store.commitSuccessfulSweeps(uncommitted);
          uncommitted.length = 0;
          throw signal.reason;
        }
        if (uncommitted.length) await store.commitSuccessfulSweeps(uncommitted);
        uncommitted.length = 0;
        settled.forEach((row, index) => {
          if (row.status === 'rejected') {
            const workUnitId = ids[index];
            settledFailedWorkUnits.add(workUnitId);
            if (row.reason?.retryable !== false) {
              failedWorkUnits.add(workUnitId);
              retryableWorkUnits.add(workUnitId);
              store.recordRetryableFailure(workUnitId, row.reason);
            }
          }
        });
        // HOME23 PATCH — publish batch progress only after successful outputs
        // and retryable failures are durable. Counters are derived from the
        // selected scope, never the unrelated global-pending total.
        const settledScope = store.getScopeSummary(attemptId);
        const successful = settledScope.scopeSuccessfulWorkUnits;
        const failed = settledFailedWorkUnits.size;
        const completed = successful + failed;
        const selectedTotal = scopeAtStart.scopeSuccessfulWorkUnits + selected.length;
        emit({
          type: 'progress',
          phase: 'pgs_sweep',
          stage: 'sweep_batch_complete',
          selected: selectedTotal,
          completed,
          successful,
          failed,
          reused: scopeAtStart.scopeSuccessfulWorkUnits,
          pending: selectedTotal - completed,
          retryable: retryableWorkUnits.size,
          total: settledScope.scopeWorkUnits,
        });
        const fatal = settled.find(row =>
          row.status === 'rejected' && row.reason?.retryable === false);
        if (fatal) throw fatal.reason;
      }
      batchIndex += 1;
    }

    throwIfAborted(signal);
    const durableSweeps = store.listSuccessfulSweeps({ attemptId });
    const sweepOutputs = durableSweeps.map(row => ({
      workUnitId: row.workUnitId,
      partitionId: row.partitionId,
      provider: row.provider,
      model: row.model,
      output: row.output,
    }));
    let outputBytes = 0;
    for (const row of sweepOutputs) {
      assertBytes(row.output, limits.maxSweepOutputBytes, 'PGS sweep output');
      outputBytes += utf8Bytes(row.output);
      if (outputBytes > limits.maxTotalSweepOutputBytes) {
        throw typed('result_too_large', 'PGS sweep outputs exceed the aggregate byte limit');
      }
    }
    const scopeSummary = store.getScopeSummary(attemptId);
    const pendingWorkUnits = scopeSummary.globalPendingWorkUnits;
    emit({
      type: 'progress',
      phase: 'pgs_sweep',
      stage: 'sweep_complete',
      successfulSweeps: sweepOutputs.length,
      pendingWorkUnits,
    });
    const metadata = { pgs: {
      successfulSweeps: sweepOutputs.length,
      retryablePartitions: store.listRetryablePartitions({ attemptId }),
      pgsMode: scopeRequest.mode,
      coverageLevel: scopeRequest.coverageLevel,
      coverageFraction: scopeRequest.coverageFraction,
      targetPartitionIds: scopeSummary.targetPartitionIds,
      sweepFraction,
      selectedWorkUnits: selected.length,
      pendingWorkUnits,
      reusedWorkUnits: scopeAtStart.scopeSuccessfulWorkUnits,
      newWorkUnits: scopeSummary.scopeSuccessfulWorkUnits
        - scopeAtStart.scopeSuccessfulWorkUnits,
      scopeWorkUnits: scopeSummary.scopeWorkUnits,
      scopeSuccessfulWorkUnits: scopeSummary.scopeSuccessfulWorkUnits,
      scopePendingWorkUnits: scopeSummary.scopePendingWorkUnits,
      scopeComplete: scopeSummary.scopeComplete,
      globalCoveredWorkUnits: scopeSummary.globalCoveredWorkUnits,
      globalPendingWorkUnits: scopeSummary.globalPendingWorkUnits,
      fullCoverage: scopeSummary.fullCoverage,
      sourceTotals: {
        nodes: store.stats.nodeCount,
        edges: store.stats.edgeCount,
        workUnits: store.stats.workUnitCount,
      },
    } };
    const baseResult = { answer: null, sweepOutputs, metadata, sourceEvidence };
    if (store.stats.workUnitCount === 0) {
      return {
        state: 'failed', result: baseResult,
        error: {
          code: 'source_empty',
          message: 'Pinned PGS source contains no eligible work units',
          retryable: false,
        },
        resultArtifact: null, sourceEvidence,
      };
    }
    if (!sweepOutputs.length && selected.length) {
      return {
        state: 'failed', result: baseResult,
        error: { code: 'pgs_all_failed', message: 'All selected PGS work failed', retryable: true },
        resultArtifact: null, sourceEvidence,
      };
    }

    let answer;
    let synthesisStats = null;
    try {
      emit({
        type: 'progress',
        phase: 'pgs_synthesis',
        stage: 'synthesis_started',
        sweepOutputs: sweepOutputs.length,
      });
      const finalMaximumInputBytes = synthInputBudget.inputBudgetBytes
        - utf8Bytes(SYNTHESIS_INSTRUCTIONS);
      const reductionMaximumInputBytes = synthInputBudget.inputBudgetBytes
        - utf8Bytes(SYNTHESIS_REDUCTION_INSTRUCTIONS);
      const intermediateOutputBytes = resolveIntermediateOutputBytes(
        reductionMaximumInputBytes,
        limits.maxSynthesisOutputBytes,
      );
      if (finalMaximumInputBytes <= 0 || reductionMaximumInputBytes <= 0
          || intermediateOutputBytes <= 0) {
        throw typed('model_capability_invalid', 'PGS synthesis model leaves no hierarchical input budget');
      }
      let synthesisItems = sweepOutputs;
      let level = 1;
      let providerCalls = 0;
      let hierarchical = false;
      let providerCallCeiling = null;
      let intermediateEncodedBytes = 0;
      let truncatedReductionOutputs = 0;
      let truncatedReductionBytes = 0;
      const initialEncodedBytes = encodedSynthesisItemBytes(synthesisItems);
      const intermediateEncodedByteCeiling = Math.min(
        limits.maxResultBytes,
        Math.max(1_024, initialEncodedBytes * 2),
      );
      const assertProviderCallAvailable = () => {
        if (providerCalls >= providerCallCeiling) {
          throw typed(
            'pgs_synthesis_nonconvergent',
            'PGS hierarchical synthesis exceeded its provider call ceiling',
          );
        }
      };
      while (true) {
        if (level > 64) {
          throw typed('result_too_large', 'PGS hierarchical synthesis did not converge');
        }
        const finalBatches = packSynthesisBatches(
          query,
          synthesisItems,
          finalMaximumInputBytes,
          { level, final: true },
        );
        if (providerCallCeiling === null) {
          providerCallCeiling = Math.min(
            2_048,
            Math.max(8, (finalBatches.length * 2) + 8),
          );
        }
        if (finalBatches.length === 1) {
          const synthesisInput = buildSynthesisInput(
            query,
            finalBatches[0],
            finalMaximumInputBytes,
            { level, final: true },
          );
          assertProviderCallAvailable();
          const completion = await providerCall({
            phase: 'pgs_synthesis', pair: synthPair, capabilities: synthCapabilities,
            client: synthClient, id: 'pgs:synthesis', work: null,
            instructions: SYNTHESIS_INSTRUCTIONS,
            input: synthesisInput,
            maxInputBytes: limits.maxSynthesisInputBytes,
            maxOutputBytes: limits.maxSynthesisOutputBytes,
            streamChunks: true,
          });
          providerCalls += 1;
          answer = String(completion.content || '').trim();
          if (!answer) throw typed('provider_incomplete', 'PGS synthesis returned no content', true);
          assertBytes(answer, limits.maxSynthesisOutputBytes, 'PGS synthesis output');
          synthesisStats = Object.freeze({
            hierarchical,
            inputSweeps: sweepOutputs.length,
            providerCalls,
            levels: level,
            providerCallCeiling,
            intermediateEncodedBytes,
            intermediateEncodedByteCeiling,
            truncatedReductionOutputs,
            truncatedReductionBytes,
          });
          break;
        }

        hierarchical = true;
        const reductionBatches = packSynthesisBatches(
          query,
          synthesisItems,
          reductionMaximumInputBytes,
          { level, final: false },
        );
        const reductionInputEncodedBytes = encodedSynthesisItemBytes(reductionBatches.flat());
        emit({
          type: 'progress',
          phase: 'pgs_synthesis',
          stage: 'synthesis_reduction_started',
          level,
          inputItems: synthesisItems.length,
          batches: reductionBatches.length,
        });
        const reducedItems = [];
        for (let batchIndex = 0; batchIndex < reductionBatches.length; batchIndex += 1) {
          throwIfAborted(signal);
          const input = buildSynthesisInput(
            query,
            reductionBatches[batchIndex],
            reductionMaximumInputBytes,
            { level, final: false },
          );
          assertProviderCallAvailable();
          const completion = await providerCall({
            phase: 'pgs_synthesis', pair: synthPair, capabilities: synthCapabilities,
            client: synthClient,
            id: `pgs:synthesis:reduce:${level}:${String(batchIndex).padStart(4, '0')}`,
            work: null,
            instructions: SYNTHESIS_REDUCTION_INSTRUCTIONS,
            input,
            maxInputBytes: limits.maxSynthesisInputBytes,
            maxOutputBytes: limits.maxSynthesisOutputBytes,
          });
          providerCalls += 1;
          const providerOutput = String(completion.content || '').trim();
          if (!providerOutput) throw typed('provider_incomplete', 'PGS synthesis reduction returned no content', true);
          const boundedOutput = truncateIntermediateOutput(providerOutput, intermediateOutputBytes);
          const output = boundedOutput.output;
          if (boundedOutput.truncated) {
            truncatedReductionOutputs += 1;
            truncatedReductionBytes += boundedOutput.originalBytes - boundedOutput.retainedBytes;
            emit({
              type: 'progress',
              phase: 'pgs_synthesis',
              stage: 'synthesis_reduction_truncated',
              level,
              batch: batchIndex + 1,
              providerCallId: `pgs:synthesis:reduce:${level}:${String(batchIndex).padStart(4, '0')}`,
              originalBytes: boundedOutput.originalBytes,
              retainedBytes: boundedOutput.retainedBytes,
            });
          }
          assertBytes(output, intermediateOutputBytes, 'PGS synthesis reduction output');
          reducedItems.push({
            kind: 'synthesis-shard',
            level,
            shard: batchIndex + 1,
            output,
          });
          // HOME23 PATCH — the batch is complete only after the validated,
          // bounded shard has entered the next synthesis level's input set.
          emit({
            type: 'progress',
            phase: 'pgs_synthesis',
            stage: 'synthesis_batch_complete',
            level,
            batch: batchIndex + 1,
            batches: reductionBatches.length,
          });
        }
        const reducedEncodedBytes = encodedSynthesisItemBytes(reducedItems);
        if (reducedEncodedBytes >= reductionInputEncodedBytes) {
          throw typed(
            'pgs_synthesis_nonconvergent',
            'PGS hierarchical synthesis did not strictly reduce encoded bytes',
          );
        }
        intermediateEncodedBytes += reducedEncodedBytes;
        if (!Number.isSafeInteger(intermediateEncodedBytes)
            || intermediateEncodedBytes > intermediateEncodedByteCeiling) {
          throw typed(
            'result_too_large',
            'PGS hierarchical synthesis exceeded its aggregate intermediate byte limit',
          );
        }
        emit({
          type: 'progress',
          phase: 'pgs_synthesis',
          stage: 'synthesis_reduction_complete',
          level,
          outputItems: reducedItems.length,
        });
        synthesisItems = reducedItems;
        level += 1;
      }
      emit({
        type: 'progress',
        phase: 'pgs_synthesis',
        stage: 'synthesis_complete',
        answerBytes: utf8Bytes(answer),
        ...synthesisStats,
      });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!sweepOutputs.length || !canReturnUsefulSynthesisPartial(error)) throw error;
      assertBytes(baseResult, limits.maxResultBytes, 'PGS result');
      return {
        state: 'partial', result: baseResult, error: normalizeFailure(error),
        resultArtifact: null, sourceEvidence,
      };
    }
    const partial = !scopeSummary.scopeComplete;
    metadata.pgs.synthesis = synthesisStats;
    const result = { ...baseResult, answer };
    assertBytes(result, limits.maxResultBytes, 'PGS result');
    if (!partial) {
      await writeSuccessReceipt({
        engine, attemptId, result, signal, scratchQuota,
        receiptBoundary, receiptDirectory,
      });
    }
    return {
      state: partial ? 'partial' : 'complete',
      result,
      error: partial ? {
        code: 'pgs_partitions_incomplete',
        message: 'Some work in the requested PGS scope remains pending and retryable',
        retryable: true,
      } : null,
      resultArtifact: null,
      sourceEvidence,
    };
  } catch (error) {
    if (signal?.aborted || error === signal?.reason) {
      if (uncommitted.length) await store.commitSuccessfulSweeps(uncommitted);
      uncommitted.length = 0;
      throw signal.reason;
    }
    throw error;
  } finally {
    try {
      store.close();
    } finally {
      closeScratchBoundary(receiptBoundary);
    }
  }
}

async function runPinnedOperation(engine, options = {}) {
  const sessionStorage = options.sessionStorage;
  let closeStarted = false;
  try {
    return await runPinnedOperationCore(engine, options);
  } finally {
    if (sessionStorage && typeof sessionStorage.close === 'function' && !closeStarted) {
      closeStarted = true;
      await sessionStorage.close();
    }
  }
}

module.exports = {
  runPinnedOperation,
};
