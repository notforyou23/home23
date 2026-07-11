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

const PINNED_SWEEP_CONCURRENCY = 2;
const MAX_GENERATED_WORK_UNIT_ID_BYTES = 256;
const SWEEP_INSTRUCTIONS = 'Analyze only this pinned PGS work unit. Return evidence-backed findings and explicit absences.';
const SYNTHESIS_INSTRUCTIONS = 'Synthesize the pinned PGS findings into a direct answer. Preserve absences and cite work-unit IDs.';

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

function buildSynthesisInput(query, sweepOutputs, maximumBytes) {
  const parts = [`Original query: ${query}\n\nPinned PGS sweep outputs:\n`];
  let bytes = utf8Bytes(parts[0]);
  if (bytes > maximumBytes) {
    throw typed('result_too_large', 'PGS synthesis scaffold exceeds the provider input byte limit');
  }
  for (const row of sweepOutputs) {
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

function canReturnUsefulSynthesisPartial(error) {
  if (error instanceof ProviderCompletionError) return true;
  if (!error?.code) return true;
  return error.code === 'result_too_large'
    || error.code === 'model_capability_invalid'
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

async function runPinnedOperation(engine, options = {}) {
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
  if (!pgsConfig || typeof pgsConfig !== 'object' || Array.isArray(pgsConfig)
      || Object.keys(pgsConfig).some(key => key !== 'sweepFraction')) {
    throw typed('invalid_request', 'PGS configuration is invalid');
  }
  const sweepFraction = pgsConfig.sweepFraction === undefined ? 1 : pgsConfig.sweepFraction;
  if (typeof sweepFraction !== 'number' || !Number.isFinite(sweepFraction)
      || sweepFraction <= 0 || sweepFraction > 1) {
    throw typed('invalid_request', 'PGS sweepFraction must be in (0,1]');
  }
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
      sourcePin, scratchDir, scratchQuota, pgsSweep: sweepPair, signal, limits: storeLimits,
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
  } catch (error) {
    try {
      store?.close();
    } finally {
      closeScratchBoundary(receiptBoundary);
    }
    throw error;
  }
  const validateCompletion = engine.requireCompleteProviderResult || requireCompleteProviderResult;
  const attemptId = `attempt-${randomUUID()}`;
  const pending = store.snapshotPendingWorkUnits({ attemptId, limit: limits.maxSelectedWorkUnits });
  const selectedCount = pending.length ? Math.max(1, Math.ceil(pending.length * sweepFraction)) : 0;
  const selected = pending.slice(0, selectedCount);
  const uncommitted = [];

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
        onChunk: phase === 'pgs_synthesis' ? onChunk : null,
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

  async function sweep(workUnitId) {
    throwIfAborted(signal);
    store.beginWorkUnitAttempt(workUnitId, {
      attemptId, provider: sweepPair.provider, model: sweepPair.model,
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

  try {
    for (let offset = 0; offset < selected.length; offset += concurrency) {
      throwIfAborted(signal);
      const ids = selected.slice(offset, offset + concurrency);
      const settled = await Promise.allSettled(ids.map(sweep));
      settled.forEach(row => { if (row.status === 'fulfilled') uncommitted.push(row.value); });
      if (signal?.aborted) {
        if (uncommitted.length) await store.commitSuccessfulSweeps(uncommitted);
        uncommitted.length = 0;
        throw signal.reason;
      }
      if (uncommitted.length) await store.commitSuccessfulSweeps(uncommitted);
      uncommitted.length = 0;
      const fatal = settled.find(row => row.status === 'rejected' && row.reason?.retryable === false);
      if (fatal) throw fatal.reason;
      settled.forEach((row, index) => {
        if (row.status === 'rejected') store.recordRetryableFailure(ids[index], row.reason);
      });
    }

    throwIfAborted(signal);
    const durableSweeps = store.listSuccessfulSweeps();
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
    const pendingWorkUnits = store.countPendingWorkUnits();
    const metadata = { pgs: {
      successfulSweeps: sweepOutputs.length,
      retryablePartitions: store.listRetryablePartitions(),
      sweepFraction,
      selectedWorkUnits: selected.length,
      pendingWorkUnits,
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
    try {
      const synthesisInput = buildSynthesisInput(
        query,
        sweepOutputs,
        synthInputBudget.inputBudgetBytes - utf8Bytes(SYNTHESIS_INSTRUCTIONS),
      );
      const completion = await providerCall({
        phase: 'pgs_synthesis', pair: synthPair, capabilities: synthCapabilities,
        client: synthClient, id: 'pgs:synthesis', work: null,
        instructions: SYNTHESIS_INSTRUCTIONS,
        input: synthesisInput,
        maxInputBytes: limits.maxSynthesisInputBytes,
        maxOutputBytes: limits.maxSynthesisOutputBytes,
      });
      answer = String(completion.content || '').trim();
      if (!answer) throw typed('provider_incomplete', 'PGS synthesis returned no content', true);
      assertBytes(answer, limits.maxSynthesisOutputBytes, 'PGS synthesis output');
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!sweepOutputs.length || !canReturnUsefulSynthesisPartial(error)) throw error;
      assertBytes(baseResult, limits.maxResultBytes, 'PGS result');
      return {
        state: 'partial', result: baseResult, error: normalizeFailure(error),
        resultArtifact: null, sourceEvidence,
      };
    }
    const partial = pendingWorkUnits > 0;
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
        message: 'Some PGS work remains pending and retryable',
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
    store.close();
    closeScratchBoundary(receiptBoundary);
  }
}

module.exports = {
  runPinnedOperation,
};
