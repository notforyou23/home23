'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { openPinnedPGSStore, lowerLimits } = require('./pinned-store');
const {
  ProviderCompletionError,
  requireCompleteProviderResult,
} = require('../../lib/provider-completion');
const { getModelCapabilities } = require('../../server/config/model-catalog');

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

function buildWorkInput(query, work, maximumChars) {
  const parts = [`Query: ${query}\n\nPinned work unit ${work.workUnitId}:\n`];
  let chars = parts[0].length;
  const append = (prefix, record) => {
    const text = `${prefix}${JSON.stringify(record)}\n`;
    if (chars + text.length > maximumChars) return false;
    parts.push(text);
    chars += text.length;
    return true;
  };
  for (const node of work.nodes) if (!append('NODE ', node)) break;
  for (const edge of work.edges) if (!append('EDGE ', edge)) break;
  return parts.join('');
}

function normalizeFailure(error) {
  return {
    code: String(error?.code || 'provider_failed').slice(0, 128),
    message: String(error?.message || 'Provider failed').slice(0, 4096),
    retryable: error?.retryable !== false,
  };
}

async function writeSuccessReceipt({ engine, scratchDir, attemptId, result, signal, scratchQuota }) {
  throwIfAborted(signal);
  const root = path.join(scratchDir, 'pgs-receipts');
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  const destination = path.join(root, `${attemptId}.json`);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const bytes = Buffer.from(`${JSON.stringify({
    version: 1,
    attemptId,
    completedAt: new Date(engine.operationClock.now()).toISOString(),
    result,
  })}\n`, 'utf8');
  let handle;
  try {
    handle = await fsp.open(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await scratchQuota.reconcile();
    throwIfAborted(signal);
    await fsp.rename(temporary, destination);
    const directory = await fsp.open(root, fs.constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    if (signal?.aborted) throw signal.reason;
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
      || Object.keys(pgsConfig).some(key => !['maxConcurrentSweeps', 'sweepFraction'].includes(key))) {
    throw typed('invalid_request', 'PGS configuration is invalid');
  }
  const sweepFraction = pgsConfig.sweepFraction === undefined ? 1 : pgsConfig.sweepFraction;
  if (typeof sweepFraction !== 'number' || !Number.isFinite(sweepFraction)
      || sweepFraction <= 0 || sweepFraction > 1) {
    throw typed('invalid_request', 'PGS sweepFraction must be in (0,1]');
  }
  const concurrency = pgsConfig.maxConcurrentSweeps === undefined
    ? 2
    : pgsConfig.maxConcurrentSweeps;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) {
    throw typed('invalid_request', 'PGS concurrency must be between 1 and 4');
  }
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
  const sweepClient = registry.get(sweepPair.provider, sweepPair.model);
  const synthClient = registry.get(synthPair.provider, synthPair.model);
  for (const [pair, client, label] of [
    [sweepPair, sweepClient, 'sweep'], [synthPair, synthClient, 'synthesis'],
  ]) {
    if (typeof client?.generate !== 'function') {
      throw typed('provider_unavailable', `PGS ${label} provider is unavailable`, true);
    }
    if (client.providerId && client.providerId !== pair.provider) {
      throw typed('provider_model_mismatch', `PGS ${label} provider identity mismatch`);
    }
  }
  const emit = event => {
    if (typeof reportEvent === 'function') reportEvent(Object.freeze(event));
  };
  const sourceEvidence = typeof sourcePin.getEvidence === 'function'
    ? sourcePin.getEvidence({ route: 'pinned-pgs' })
    : sourcePin.evidence || null;
  const store = await (engine.openPinnedPGSStore || openPinnedPGSStore)({
    sourcePin, scratchDir, scratchQuota, pgsSweep: sweepPair, signal, limits,
    statfsImpl: options.statfsImpl, clock: engine.operationClock,
  });
  const validateCompletion = engine.requireCompleteProviderResult || requireCompleteProviderResult;
  const attemptId = `attempt-${randomUUID()}`;
  const pending = store.snapshotPendingWorkUnits({ attemptId, limit: limits.maxSelectedWorkUnits });
  const selectedCount = pending.length ? Math.max(1, Math.ceil(pending.length * sweepFraction)) : 0;
  const selected = pending.slice(0, selectedCount);
  const uncommitted = [];

  async function providerCall({ phase, pair, capabilities, client, id, work, instructions, input }) {
    const context = work ? { workUnitId: work.workUnitId, partitionId: work.partitionId } : {};
    emit({
      type: 'provider_selected', phase, provider: pair.provider, model: pair.model,
      providerStallMs: capabilities.providerStallMs, providerCallId: id, ...context,
    });
    let outcome = 'failed';
    try {
      const raw = await client.generate({
        provider: pair.provider,
        model: pair.model,
        instructions,
        input,
        maxOutputTokens: capabilities.maxOutputTokens,
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
      instructions: 'Analyze only this pinned PGS work unit. Return evidence-backed findings and explicit absences.',
      input: buildWorkInput(query, work, limits.maxContextCharsPerWorkUnit),
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
        if (uncommitted.length) store.commitSuccessfulSweeps(uncommitted);
        uncommitted.length = 0;
        throw signal.reason;
      }
      if (uncommitted.length) store.commitSuccessfulSweeps(uncommitted);
      uncommitted.length = 0;
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
    } };
    const baseResult = { answer: null, sweepOutputs, metadata, sourceEvidence };
    if (!sweepOutputs.length && selected.length) {
      return {
        state: 'failed', result: baseResult,
        error: { code: 'pgs_all_failed', message: 'All selected PGS work failed', retryable: true },
        resultArtifact: null, sourceEvidence,
      };
    }

    const inputParts = [`Original query: ${query}\n\nPinned PGS sweep outputs:\n`];
    let inputBytes = utf8Bytes(inputParts[0]);
    for (const row of sweepOutputs) {
      const text = `${JSON.stringify(row)}\n`;
      inputBytes += utf8Bytes(text);
      if (inputBytes > limits.maxSynthesisInputBytes) {
        throw typed('result_too_large', 'PGS synthesis input exceeds the byte limit');
      }
      inputParts.push(text);
    }
    try {
      const completion = await providerCall({
        phase: 'pgs_synthesis', pair: synthPair, capabilities: synthCapabilities,
        client: synthClient, id: 'pgs:synthesis', work: null,
        instructions: 'Synthesize the pinned PGS findings into a direct answer. Preserve absences and cite work-unit IDs.',
        input: inputParts.join(''),
      });
      const answer = String(completion.content || '').trim();
      assertBytes(answer, limits.maxSynthesisOutputBytes, 'PGS synthesis output');
      const partial = pendingWorkUnits > 0;
      const result = { ...baseResult, answer };
      assertBytes(result, limits.maxResultBytes, 'PGS result');
      if (!partial) {
        await writeSuccessReceipt({ engine, scratchDir, attemptId, result, signal, scratchQuota });
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
      if (signal?.aborted) throw signal.reason;
      if (!(error instanceof ProviderCompletionError)) throw error;
      if (!sweepOutputs.length) throw error;
      assertBytes(baseResult, limits.maxResultBytes, 'PGS result');
      return {
        state: 'partial', result: baseResult, error: normalizeFailure(error),
        resultArtifact: null, sourceEvidence,
      };
    }
  } catch (error) {
    if (signal?.aborted || error === signal?.reason) {
      if (uncommitted.length) store.commitSuccessfulSweeps(uncommitted);
      uncommitted.length = 0;
      throw signal.reason;
    }
    throw error;
  } finally {
    store.close();
  }
}

module.exports = {
  runPinnedOperation,
};
