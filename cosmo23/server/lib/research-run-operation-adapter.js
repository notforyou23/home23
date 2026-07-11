'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const AGENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RUN_STATES = new Set([
  'starting', 'active', 'paused', 'failed', 'completed', 'stopping', 'stopped',
]);
const CONTINUABLE_STATES = new Set(['paused', 'failed', 'completed']);
const STOPPABLE_STATES = new Set(['starting', 'active', 'stopping']);
const LAUNCH_OPTION_KEYS = new Set([
  'topic', 'context', 'cycles', 'explorationMode', 'analysisDepth', 'maxConcurrent',
  'primaryModel', 'primaryProvider', 'fastModel', 'fastProvider',
  'strategicModel', 'strategicProvider',
]);
const CONTINUE_OPTION_KEYS = new Set([
  'context', 'cycles', 'primaryModel', 'primaryProvider',
]);
const TRUSTED_LAUNCH_DEFAULTS = Object.freeze({
  enableWebSearch: true,
  enableCodingAgents: false,
  enableAgentRouting: true,
  enableMemoryGovernance: true,
});
const WATCH_FILTERS = new Set(['all', 'errors', 'progress', 'cycles']);
const MAX_WATCH_LIMIT = 1_000;
const MAX_LOG_RING_ENTRIES = 1_500;

function operationError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  error.retryable = options.retryable === true;
  if (options.statusCode) error.statusCode = options.statusCode;
  if (options.cause !== undefined) error.cause = options.cause;
  return error;
}

function invalid(message) {
  return operationError('invalid_request', message, { statusCode: 400 });
}

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
}

function assertExactKeys(value, allowed, label) {
  assertPlainObject(value, label);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw invalid(`${label} contains unsupported fields: ${unknown.sort().join(', ')}`);
  }
}

function assertIdentifier(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value) || value === '*' || value === '.') {
    throw invalid(`Invalid ${label}`);
  }
  return value;
}

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function lstatOrNull(target) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function throwIfAborted(signal) {
  if (!signal) return;
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    throw signal.reason || new DOMException('The operation was aborted', 'AbortError');
  }
}

async function waitWithSignal(milliseconds, signal) {
  throwIfAborted(signal);
  if (milliseconds <= 0) {
    await new Promise((resolve) => setImmediate(resolve));
    throwIfAborted(signal);
    return;
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener?.('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', aborted);
      reject(signal.reason || new DOMException('The operation was aborted', 'AbortError'));
    }
    signal?.addEventListener?.('abort', aborted, { once: true });
  });
}

async function awaitWithSignal(value, signal) {
  throwIfAborted(signal);
  const promise = Promise.resolve(value);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.('abort', aborted);
      callback(result);
    };
    const aborted = () => finish(
      reject,
      signal.reason || new DOMException('The operation was aborted', 'AbortError'),
    );
    signal.addEventListener?.('abort', aborted, { once: true });
    promise.then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

function normalizeClock(clock) {
  if (typeof clock === 'function') return clock;
  if (clock && typeof clock.now === 'function') return () => clock.now();
  return () => new Date();
}

function processNames(status) {
  if (!status || !Array.isArray(status.running)) return [];
  return status.running
    .filter((entry) => entry && entry.killed !== true && typeof entry.name === 'string')
    .map((entry) => entry.name);
}

function childrenAreDown(status) {
  return status && status.count === 0 && processNames(status).length === 0;
}

function matchesFilter(entry, filter) {
  if (filter === 'all') return true;
  const level = String(entry?.level || '').toLowerCase();
  const message = String(entry?.message || '');
  if (filter === 'errors') {
    return level === 'error' || /\b(error|failed|exception|fatal|timeout)\b/i.test(message);
  }
  if (filter === 'cycles') return /\bcycle(?:s)?\b/i.test(message);
  return /\b(progress|cycle|started|starting|completed|stopping|stopped|failed|error|warning)\b/i.test(message);
}

/**
 * HOME23 PATCH 50 — Durable owner-scoped adapter between brain operations and
 * COSMO's existing launcher/process APIs. It deliberately accepts only the
 * real RunManager/ProcessManager surface; launcher preparation remains in
 * server/index.js so HTTP and operation launches share one implementation.
 */
function createResearchRunOperationAdapter(options) {
  assertPlainObject(options, 'adapter options');
  const {
    home23Root,
    runManager,
    processManager,
    launchPreparedResearch,
    getActiveContext,
    setActiveContext,
    loadCanonicalRunMetadata,
    writeCanonicalRunMetadataAtomic,
    resolveRequesterWorkspace = ({ requesterAgent }) =>
      path.join(home23Root, 'instances', requesterAgent, 'workspace'),
    stopPollIntervalMs = 100,
    stopWaitTimeoutMs = 190_000,
  } = options;

  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)) {
    throw invalid('home23Root must be absolute');
  }
  if (!runManager || typeof runManager.createRun !== 'function') {
    throw invalid('runManager.createRun is required');
  }
  for (const method of ['startMCPServer', 'startMainDashboard', 'startCOSMO', 'stopAll', 'getStatus', 'getLogs']) {
    if (!processManager || typeof processManager[method] !== 'function') {
      throw invalid(`processManager.${method} is required`);
    }
  }
  for (const [name, fn] of Object.entries({
    launchPreparedResearch,
    getActiveContext,
    setActiveContext,
    loadCanonicalRunMetadata,
    writeCanonicalRunMetadataAtomic,
    resolveRequesterWorkspace,
  })) {
    if (typeof fn !== 'function') throw invalid(`${name} is required`);
  }
  if (!Number.isFinite(stopPollIntervalMs) || stopPollIntervalMs < 0
      || !Number.isFinite(stopWaitTimeoutMs) || stopWaitTimeoutMs <= 0) {
    throw invalid('Invalid stop wait bounds');
  }

  const root = path.resolve(home23Root);
  const nowValue = normalizeClock(options.clock);
  const locations = new Map();
  const locks = new Set();
  const logRings = new Map();
  let launchingRunId = null;

  function nowIso() {
    const value = nowValue();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw invalid('Clock returned an invalid timestamp');
    return date.toISOString();
  }

  async function assertSafeDirectoryTree(directory, boundary, missingCode = 'target_not_found') {
    const absolute = path.resolve(directory);
    const absoluteBoundary = path.resolve(boundary);
    if (!isWithin(absoluteBoundary, absolute)) {
      throw operationError('run_path_escape', 'Research run path escaped its requester workspace');
    }

    const relative = path.relative(absoluteBoundary, absolute);
    const components = [absoluteBoundary];
    if (relative) {
      let current = absoluteBoundary;
      for (const segment of relative.split(path.sep)) {
        current = path.join(current, segment);
        components.push(current);
      }
    }

    for (const component of components) {
      const stat = await lstatOrNull(component);
      if (!stat) {
        throw operationError(missingCode, `Research run path does not exist: ${component}`, {
          statusCode: 404,
        });
      }
      if (stat.isSymbolicLink()) {
        throw operationError('run_path_symlink', `Research run path contains a symlink: ${component}`);
      }
      if (!stat.isDirectory()) {
        throw operationError('run_path_invalid', `Research run path component is not a directory: ${component}`);
      }
    }

    const [real, realBoundary] = await Promise.all([
      fs.realpath(absolute),
      fs.realpath(absoluteBoundary),
    ]);
    const expectedReal = path.resolve(realBoundary, relative || '.');
    if (real !== expectedReal || !isWithin(realBoundary, real)) {
      throw operationError('run_path_escape', 'Research run realpath escaped its requester workspace');
    }
    return absolute;
  }

  async function requesterPaths(requesterAgent, { createRunsRoot = false } = {}) {
    assertIdentifier(requesterAgent, AGENT_PATTERN, 'requester agent');
    const expectedWorkspace = path.join(root, 'instances', requesterAgent, 'workspace');
    const suppliedWorkspace = path.resolve(await resolveRequesterWorkspace({
      home23Root: root,
      requesterAgent,
    }));
    if (suppliedWorkspace !== expectedWorkspace) {
      throw operationError('run_path_escape', 'Requester workspace resolver returned a noncanonical path');
    }

    await assertSafeDirectoryTree(expectedWorkspace, root);
    const runsRoot = path.join(expectedWorkspace, 'research-runs');
    const existing = await lstatOrNull(runsRoot);
    if (existing?.isSymbolicLink()) {
      throw operationError('run_path_symlink', 'Requester research-runs directory is a symlink');
    }
    if (existing && !existing.isDirectory()) {
      throw operationError('run_path_invalid', 'Requester research-runs path is not a directory');
    }
    if (!existing && createRunsRoot) {
      await fs.mkdir(runsRoot, { recursive: true });
    }
    if (existing || createRunsRoot) {
      await assertSafeDirectoryTree(runsRoot, expectedWorkspace);
    }
    return { workspace: expectedWorkspace, runsRoot };
  }

  function rememberLocation(runId, ownerAgent, canonicalRoot, operationId) {
    const existing = locations.get(runId);
    if (existing && (existing.ownerAgent !== ownerAgent || existing.canonicalRoot !== canonicalRoot
        || (operationId && existing.operationId && existing.operationId !== operationId))) {
      throw operationError('run_owner_ambiguous', `Research run identity is ambiguous: ${runId}`);
    }
    locations.set(runId, {
      ownerAgent,
      canonicalRoot,
      operationId: operationId || existing?.operationId,
    });
  }

  async function validateRunRoot(runId, ownerAgent, canonicalRoot) {
    const { runsRoot } = await requesterPaths(ownerAgent);
    const expected = path.join(runsRoot, runId);
    if (path.resolve(canonicalRoot) !== expected) {
      throw operationError('run_path_escape', 'Canonical research run root does not match owner identity');
    }
    await assertSafeDirectoryTree(expected, runsRoot);
    return expected;
  }

  function verifyRecordIdentity(record, expected) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw operationError('run_metadata_invalid', 'Canonical research run metadata is missing or malformed');
    }
    if (record.runId !== expected.runId) {
      throw operationError('run_identity_mismatch', 'Canonical run ID does not match the selected run');
    }
    if (typeof record.ownerAgent !== 'string' || !record.ownerAgent.trim()) {
      throw operationError('run_owner_ambiguous', 'Canonical research run owner is missing');
    }
    if (record.ownerAgent !== expected.ownerAgent) {
      throw operationError('access_denied', 'Research run belongs to another requester', { statusCode: 403 });
    }
    if (record.canonicalRoot !== expected.canonicalRoot) {
      throw operationError('run_identity_mismatch', 'Canonical research run root changed');
    }
    if (!OPERATION_ID_PATTERN.test(String(record.operationId || ''))) {
      throw operationError('run_metadata_invalid', 'Canonical research operation ID is missing or malformed');
    }
    if (expected.operationId && record.operationId !== expected.operationId) {
      throw operationError('run_identity_mismatch', 'Canonical research operation ID changed');
    }
    if (!RUN_STATES.has(record.state)) {
      throw operationError('run_metadata_invalid', `Unknown canonical research run state: ${record.state}`);
    }
    return record;
  }

  async function loadAt(location, runId, { allowMissing = false } = {}) {
    await validateRunRoot(runId, location.ownerAgent, location.canonicalRoot);
    let record;
    try {
      record = await loadCanonicalRunMetadata(location.canonicalRoot);
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return null;
      throw error;
    }
    if (record == null && allowMissing) return null;
    return verifyRecordIdentity(record, { runId, ...location });
  }

  async function knownRecord(runId) {
    assertIdentifier(runId, RUN_ID_PATTERN, 'research runId');
    const location = locations.get(runId);
    if (!location) {
      throw operationError('target_not_found', `Unknown research run: ${runId}`, { statusCode: 404 });
    }
    return loadAt(location, runId);
  }

  async function writeAndReload(current, next) {
    for (const field of ['runId', 'ownerAgent', 'operationId', 'canonicalRoot']) {
      if (next[field] !== current[field]) {
        throw operationError('run_identity_mismatch', `Canonical research run identity changed: ${field}`);
      }
    }
    await writeCanonicalRunMetadataAtomic(current.canonicalRoot, clone(next));
    const loaded = await loadCanonicalRunMetadata(current.canonicalRoot);
    const verified = verifyRecordIdentity(loaded, {
      runId: current.runId,
      ownerAgent: current.ownerAgent,
      canonicalRoot: current.canonicalRoot,
      operationId: current.operationId,
    });
    if (verified.state !== next.state) {
      throw operationError('run_metadata_stale', 'Canonical research run transition was not durably persisted');
    }
    rememberLocation(verified.runId, verified.ownerAgent, verified.canonicalRoot, verified.operationId);
    return verified;
  }

  function acquire(runId) {
    if (locks.has(runId)) {
      throw operationError('run_state_conflict', `Research run is already changing state: ${runId}`, {
        retryable: true,
        statusCode: 409,
      });
    }
    locks.add(runId);
    return () => locks.delete(runId);
  }

  async function withRunLock(runId, action) {
    assertIdentifier(runId, RUN_ID_PATTERN, 'research runId');
    const release = acquire(runId);
    try {
      return await action();
    } finally {
      release();
    }
  }

  async function withLaunchSlot(runId, action) {
    const active = getActiveContext();
    if (launchingRunId || active) {
      const occupiedBy = launchingRunId || active?.runName || 'unknown';
      throw operationError('run_state_conflict', `COSMO launch slot is occupied by ${occupiedBy}`, {
        retryable: true,
        statusCode: 409,
      });
    }
    launchingRunId = runId;
    try {
      return await action();
    } finally {
      if (launchingRunId === runId) launchingRunId = null;
    }
  }

  function stateConflict(record, expected) {
    return operationError(
      'run_state_conflict',
      `Research run ${record.runId} is ${record.state}; expected ${[...expected].join('|')}`,
      { retryable: true, statusCode: 409 },
    );
  }

  async function markFailed(record, code, cause) {
    const current = await knownRecord(record.runId);
    if (current.state !== 'starting' && current.state !== 'active') return current;
    const at = nowIso();
    return writeAndReload(current, {
      ...current,
      state: 'failed',
      failedAt: at,
      updatedAt: at,
      error: {
        code,
        message: String(cause?.message || cause || code),
        retryable: true,
      },
    });
  }

  async function runPrepared(record, { signal, isContinuation }) {
    throwIfAborted(signal);
    const effectiveLaunchOptions = {
      ...(record.parameters || {}),
      ...TRUSTED_LAUNCH_DEFAULTS,
      runName: record.runId,
      runRoot: record.canonicalRoot,
      owner: record.ownerAgent,
    };
    let current = await writeAndReload(record, {
      ...record,
      effectiveLaunchOptions,
      updatedAt: nowIso(),
    });
    throwIfAborted(signal);

    const brainId = crypto.createHash('sha1').update(record.canonicalRoot).digest('hex').slice(0, 16);
    const brain = {
      id: brainId,
      routeKey: brainId,
      name: record.runId,
      path: record.canonicalRoot,
      sourceType: 'local',
      sourceLabel: 'Local',
      topic: effectiveLaunchOptions.topic || record.topic || record.runId,
      hasState: isContinuation === true,
      cycleCount: 0,
    };

    let launchResult;
    try {
      launchResult = await launchPreparedResearch(brain, effectiveLaunchOptions, {
        headers: {}, secure: false, hostname: 'localhost',
      });
      throwIfAborted(signal);
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      await markFailed(current, 'research_launch_failed', error);
      throw operationError('research_launch_failed', `Research launch failed: ${error.message}`, {
        retryable: true,
        cause: error,
      });
    }

    const active = getActiveContext();
    const activeMatches = active
      && active.runName === record.runId
      && typeof active.runPath === 'string'
      && path.resolve(active.runPath) === record.canonicalRoot;
    if (!activeMatches) {
      const error = operationError('research_launch_failed', 'Prepared launcher did not activate the exact research run');
      await markFailed(current, error.code, error);
      throw error;
    }

    const status = processManager.getStatus();
    if (!processNames(status).includes('cosmo-main')) {
      const error = operationError('research_process_exit', 'COSMO engine exited during research launch', {
        retryable: true,
      });
      await markFailed(current, error.code, error);
      throw error;
    }

    current = await knownRecord(record.runId);
    if (current.state !== 'starting') throw stateConflict(current, new Set(['starting']));
    const startedAt = nowIso();
    current = await writeAndReload(current, {
      ...current,
      state: 'active',
      startedAt,
      updatedAt: startedAt,
      error: null,
      launchResult: {
        runName: launchResult?.runName || record.runId,
        brainId: launchResult?.brainId || brainId,
      },
    });
    logRings.set(record.runId, { logs: [], cursor: 0, total: 0 });
    return {
      ...clone(launchResult || {}),
      runId: current.runId,
      ownerAgent: current.ownerAgent,
      state: current.state,
      canonicalRoot: current.canonicalRoot,
      startedAt: current.startedAt,
    };
  }

  async function createOwnedRun(input) {
    assertExactKeys(input, new Set([
      'runId', 'ownerAgent', 'operationId', 'topic', 'parameters',
    ]), 'createOwnedRun input');
    const runId = assertIdentifier(input.runId, RUN_ID_PATTERN, 'research runId');
    const ownerAgent = assertIdentifier(input.ownerAgent, AGENT_PATTERN, 'owner agent');
    const derivedOperationId = runId.startsWith('research-') ? runId.slice('research-'.length) : null;
    const operationId = assertIdentifier(
      input.operationId === undefined ? derivedOperationId : input.operationId,
      OPERATION_ID_PATTERN,
      'operation ID',
    );
    if (input.operationId !== undefined && derivedOperationId
        && OPERATION_ID_PATTERN.test(derivedOperationId) && operationId !== derivedOperationId) {
      throw operationError('run_identity_mismatch', 'Research run ID and operation ID do not match');
    }
    if (typeof input.topic !== 'string' || !input.topic.trim() || input.topic.length > 12_000) {
      throw invalid('Research topic is required and must be bounded');
    }
    const parameters = input.parameters == null ? { topic: input.topic } : clone(input.parameters);
    assertExactKeys(parameters, LAUNCH_OPTION_KEYS, 'research launch parameters');
    if (parameters.topic !== undefined && parameters.topic !== input.topic) {
      throw invalid('Research topic identity does not match launch parameters');
    }
    parameters.topic = input.topic;

    return withRunLock(runId, async () => {
      const { runsRoot } = await requesterPaths(ownerAgent, { createRunsRoot: true });
      const canonicalRoot = path.join(runsRoot, runId);
      if (await lstatOrNull(canonicalRoot)) {
        throw operationError('run_state_conflict', `Research run already exists: ${runId}`, {
          statusCode: 409,
        });
      }

      const created = await runManager.createRun(runId, {
        runPath: canonicalRoot,
        owner: ownerAgent,
        topic: input.topic,
      });
      if (!created?.success) {
        throw operationError('research_run_create_failed', created?.error || 'Run manager failed to create research run', {
          retryable: true,
        });
      }
      if (path.resolve(created.path || '') !== canonicalRoot) {
        throw operationError('run_path_escape', 'Run manager returned a noncanonical research run root');
      }
      await validateRunRoot(runId, ownerAgent, canonicalRoot);
      rememberLocation(runId, ownerAgent, canonicalRoot, operationId);

      const createdAt = nowIso();
      const record = {
        version: 1,
        runId,
        ownerAgent,
        operationId,
        canonicalRoot,
        topic: input.topic,
        parameters,
        state: 'starting',
        createdAt,
        updatedAt: createdAt,
      };
      await writeCanonicalRunMetadataAtomic(canonicalRoot, clone(record));
      const loaded = await loadCanonicalRunMetadata(canonicalRoot);
      return clone(verifyRecordIdentity(loaded, { runId, ownerAgent, canonicalRoot, operationId }));
    });
  }

  async function start(runId, options = {}) {
    assertExactKeys(options, new Set(['signal']), 'start options');
    return withRunLock(runId, async () => {
      const record = await knownRecord(runId);
      if (record.state !== 'starting') throw stateConflict(record, new Set(['starting']));
      return withLaunchSlot(runId,
        () => runPrepared(record, { signal: options.signal, isContinuation: false }));
    });
  }

  async function continueRun(runId, overrides = {}, options = {}) {
    assertExactKeys(overrides, CONTINUE_OPTION_KEYS, 'research continuation overrides');
    assertExactKeys(options, new Set(['signal']), 'continue options');
    return withRunLock(runId, async () => {
      let record = await knownRecord(runId);
      if (!CONTINUABLE_STATES.has(record.state)) throw stateConflict(record, CONTINUABLE_STATES);
      return withLaunchSlot(runId, async () => {
        throwIfAborted(options.signal);
        const continuedAt = nowIso();
        record = await writeAndReload(record, {
          ...record,
          state: 'starting',
          parameters: { ...(record.parameters || {}), ...clone(overrides) },
          continuationOverrides: clone(overrides),
          continuationStartedAt: continuedAt,
          updatedAt: continuedAt,
          error: null,
        });
        throwIfAborted(options.signal);
        return runPrepared(record, { signal: options.signal, isContinuation: true });
      });
    });
  }

  async function stopAndWait(runId, options = {}) {
    assertExactKeys(options, new Set(['signal']), 'stop options');
    return withRunLock(runId, async () => {
      let record = await knownRecord(runId);
      if (!STOPPABLE_STATES.has(record.state)) throw stateConflict(record, STOPPABLE_STATES);
      const active = getActiveContext();
      if (!active || active.runName !== record.runId || typeof active.runPath !== 'string'
          || path.resolve(active.runPath) !== record.canonicalRoot) {
        throw operationError('run_state_conflict', 'Selected research run is not the exact active context', {
          retryable: true,
          statusCode: 409,
        });
      }
      throwIfAborted(options.signal);

      if (record.state !== 'stopping') {
        const stoppingAt = nowIso();
        record = await writeAndReload(record, {
          ...record,
          state: 'stopping',
          stoppingAt,
          updatedAt: stoppingAt,
        });
      }

      throwIfAborted(options.signal);
      try {
        await awaitWithSignal(processManager.stopAll(), options.signal);
      } catch (error) {
        if (error?.name === 'AbortError' || options.signal?.aborted) throw error;
        throw operationError('research_stop_failed', `Research stop failed: ${error.message}`, {
          retryable: true,
          cause: error,
        });
      }
      throwIfAborted(options.signal);

      const deadline = Date.now() + stopWaitTimeoutMs;
      let status;
      do {
        throwIfAborted(options.signal);
        status = processManager.getStatus();
        if (childrenAreDown(status)) break;
        if (Date.now() >= deadline) {
          throw operationError('research_stop_timeout', 'Timed out waiting for COSMO child processes to stop', {
            retryable: true,
          });
        }
        await waitWithSignal(stopPollIntervalMs, options.signal);
      } while (true);
      throwIfAborted(options.signal);

      record = await knownRecord(runId);
      if (record.state !== 'stopping') throw stateConflict(record, new Set(['stopping']));
      const stoppedAt = nowIso();
      record = await writeAndReload(record, {
        ...record,
        state: 'stopped',
        stoppedAt,
        updatedAt: stoppedAt,
      });
      setActiveContext(null);
      return {
        runId: record.runId,
        ownerAgent: record.ownerAgent,
        state: record.state,
        stoppedAt: record.stoppedAt,
        terminal: true,
        processStatus: clone(status),
      };
    });
  }

  async function captureActiveLogs(record) {
    const active = getActiveContext();
    if (!active || active.runName !== record.runId || typeof active.runPath !== 'string'
        || path.resolve(active.runPath) !== record.canonicalRoot) {
      return;
    }
    const ring = logRings.get(record.runId) || { logs: [], cursor: 0, total: 0 };
    const payload = processManager.getLogs({ after: ring.cursor, limit: MAX_WATCH_LIMIT });
    const byId = new Map(ring.logs.map((entry) => [entry.id, entry]));
    for (const entry of Array.isArray(payload?.logs) ? payload.logs : []) {
      if (Number.isSafeInteger(entry?.id) && entry.id > 0) byId.set(entry.id, clone(entry));
    }
    const logs = [...byId.values()]
      .sort((left, right) => left.id - right.id)
      .slice(-MAX_LOG_RING_ENTRIES);
    const cursor = Number.isSafeInteger(payload?.cursor) && payload.cursor >= ring.cursor
      ? payload.cursor
      : (logs.at(-1)?.id || ring.cursor);
    logRings.set(record.runId, {
      logs,
      cursor,
      total: Math.max(
        ring.total,
        logs.length,
        Number.isSafeInteger(payload?.total) && payload.total >= 0 ? payload.total : 0,
      ),
    });
  }

  async function refreshActiveProcessFailure(record) {
    if (record.state !== 'active') return record;
    const active = getActiveContext();
    if (!active || active.runName !== record.runId || typeof active.runPath !== 'string'
        || path.resolve(active.runPath) !== record.canonicalRoot) {
      return record;
    }
    const status = processManager.getStatus();
    if (processNames(status).includes('cosmo-main')) return record;
    if (locks.has(record.runId)) return knownRecord(record.runId);
    try {
      return await withRunLock(record.runId, async () => {
        const current = await knownRecord(record.runId);
        if (current.state !== 'active') return current;
        return markFailed(current, 'research_process_exit',
          operationError('research_process_exit', 'COSMO engine exited while the research run was active', {
            retryable: true,
          }));
      });
    } catch (error) {
      if (error?.code === 'run_state_conflict') return knownRecord(record.runId);
      throw error;
    }
  }

  async function watch(runId, options = {}) {
    assertExactKeys(options, new Set(['after', 'limit', 'filter']), 'watch options');
    const after = options.after === undefined ? 0 : options.after;
    const limit = options.limit === undefined ? 50 : options.limit;
    const filter = options.filter === undefined ? 'all' : options.filter;
    if (!Number.isSafeInteger(after) || after < 0) throw invalid('Watch cursor must be a nonnegative integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WATCH_LIMIT) {
      throw invalid(`Watch limit must be between 1 and ${MAX_WATCH_LIMIT}`);
    }
    if (!WATCH_FILTERS.has(filter)) throw invalid('Unknown research watch filter');

    let record = await knownRecord(runId);
    await captureActiveLogs(record);
    record = await refreshActiveProcessFailure(record);
    const ring = logRings.get(runId) || { logs: [], cursor: 0, total: 0 };
    const matching = ring.logs
      .filter((entry) => entry.id > after && matchesFilter(entry, filter));
    const logs = matching.slice(0, limit).map(clone);
    const cursor = matching.length > logs.length
      ? logs.at(-1).id
      : Math.max(after, ring.cursor);
    return {
      runId: record.runId,
      ownerAgent: record.ownerAgent,
      state: record.state,
      error: clone(record.error || null),
      logs,
      cursor,
      latest: cursor,
      total: ring.total,
      filter,
    };
  }

  async function resolveOwnedRun(selector) {
    assertExactKeys(selector, new Set(['runId', 'requesterAgent']), 'research run selector');
    if (Object.keys(selector).length !== 2) {
      throw invalid('Exact research runId and requesterAgent are required');
    }
    const runId = assertIdentifier(selector.runId, RUN_ID_PATTERN, 'research runId');
    const requesterAgent = assertIdentifier(selector.requesterAgent, AGENT_PATTERN, 'requester agent');
    const { runsRoot } = await requesterPaths(requesterAgent);
    const canonicalRoot = path.join(runsRoot, runId);
    const stat = await lstatOrNull(canonicalRoot);
    if (!stat) return null;
    if (stat.isSymbolicLink()) {
      throw operationError('run_path_symlink', 'Canonical research run root is a symlink');
    }
    const existing = locations.get(runId);
    rememberLocation(runId, requesterAgent, canonicalRoot);
    const record = await loadAt({
      ownerAgent: requesterAgent,
      canonicalRoot,
      operationId: existing?.operationId,
    }, runId);
    rememberLocation(runId, requesterAgent, canonicalRoot, record.operationId);
    return clone(record);
  }

  return Object.freeze({
    createOwnedRun,
    start,
    continue: continueRun,
    stopAndWait,
    watch,
    resolveOwnedRun,
  });
}

module.exports = {
  createResearchRunOperationAdapter,
};
