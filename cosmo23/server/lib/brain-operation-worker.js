'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { promises: fsp } = fs;
const path = require('node:path');

const {
  OPERATION_AUTHORITY,
  authorizeBrainOperation,
} = require('../../../shared/brain-operations/authority.cjs');
const {
  canonicalJson,
  canonicalSha256,
} = require('../../../shared/brain-operations/canonical-json.cjs');
const {
  verifyCapability,
} = require('../../../shared/brain-operations/capability.cjs');
const {
  classifyMatchOutcome,
  createEvidence,
  createOperationScratchQuota,
  durableBrainOperationRoot,
  sourceDescriptorDigest,
} = require('../../../shared/memory-source');
const {
  createDurableOperationLockCapability,
} = require('../../../shared/memory-source/durable-lock-authority.cjs');
const { CapabilityNonceStore } = require('./capability-nonce-store');
const { boundedJsonStringify } = require('../../lib/bounded-json');
const {
  PGS_OPERATION_LIMITS,
  QUERY_OPERATION_LIMITS,
} = require('../../lib/brain-operation-limits');
const {
  createPgsSessionAuthority,
  SESSION_ID_PATTERN: PGS_SESSION_ID_PATTERN,
} = require('../../../engine/src/dashboard/brain-operations/pgs-session-authority.js');

const WORKER_EVENT_MAX_COUNT = 4096;
const WORKER_EVENT_MAX_BYTES = 8 * 1024 * 1024;
const WORKER_RESULT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const OBSERVED_TERMINAL_RETENTION_MS = 10 * 60 * 1000;
const UNREAD_TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_ACTIVE_PROVIDER_CALLS = 4096;
const MAX_PARAMETERS_BYTES = 64 * 1024;
const MAX_CONTROL_OBJECT_BYTES = 64 * 1024;
const MAX_TOMBSTONES = 100_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const PROVIDER_ACTIVITY_PUBLISH_INTERVAL_MS = 10_000;
const CAPABILITY_FIELDS = Object.freeze([
  'requesterAgent', 'targetDomain', 'targetBrainId', 'targetRunId',
  'targetRequesterAgent', 'canonicalRoot', 'accessMode', 'operationType',
  'operationId', 'sourcePinDigest', 'issuedAt', 'expiresAt', 'nonce',
]);

const OPERATION_ID_PATTERN = /^brop_[A-Za-z0-9_-]{32}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;
const TERMINAL_STATES = new Set([
  'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);
const RESULT_STATES = new Set(TERMINAL_STATES);
const EXECUTOR_EVENT_TYPES = new Set([
  'heartbeat', 'phase', 'progress', 'progress_update', 'provider_activity',
  'provider_call_terminal', 'provider_selected', 'token', 'token_estimate',
]);
const PROVIDER_EVENT_TYPES = new Set([
  'provider_selected', 'provider_activity', 'provider_call_terminal',
]);
const NOISY_EVENT_TYPES = new Set([
  'heartbeat', 'progress', 'progress_update', 'token', 'token_estimate',
]);
const FORBIDDEN_PARAMETER_KEYS = new Set([
  'accessMode', 'brainId', 'canonicalRoot', 'capability', 'capabilityToken',
  'lifecycle', 'lockRoot', 'operationControl', 'operationId', 'operationPath',
  'operationRoot', 'outputFile', 'outputPath', 'owner', 'ownerAgent', 'policy',
  'projectionRoot', 'requester', 'requesterAgent', 'resultArtifact', 'runOwner',
  'runOwnerAgent', 'scratchDir', 'scratchPath', 'sourcePinDescriptor',
  'sourcePinDigest', 'target', 'writeScope', 'writes',
]);
const FORBIDDEN_EVENT_KEYS = new Set([
  ...FORBIDDEN_PARAMETER_KEYS,
  'catalogRevision', 'mutationBoundaries', 'route', 'runId', 'runState',
  'selectedAgent', 'selectedBrain', 'targetBrainId', 'targetDomain',
  'targetRequesterAgent', 'targetRunId',
]);

function workerError(code, message = code, options = {}) {
  const error = new Error(message, options.cause ? { cause: options.cause } : undefined);
  error.code = code;
  if (options.retryable !== undefined) error.retryable = options.retryable === true;
  if (options.statusCode) error.statusCode = options.statusCode;
  return error;
}

function resultLimitForOperation(operationType) {
  if (operationType === 'query') return QUERY_OPERATION_LIMITS.maxResultBytes;
  if (operationType === 'pgs') return PGS_OPERATION_LIMITS.maxResultBytes;
  return MAX_CONTROL_OBJECT_BYTES;
}

function clone(value, code = 'invalid_request') {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw workerError(code, code, { cause: error });
  }
}

function exactKeys(value, expected, code = 'invalid_request') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw workerError(code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
      || actual.some((key, index) => key !== wanted[index])) {
    throw workerError(code);
  }
}

function assertIdentifier(value, code = 'invalid_request') {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)
      || value === '.' || value === '..') {
    throw workerError(code);
  }
  return value;
}

function assertOperationId(value) {
  if (typeof value !== 'string' || !OPERATION_ID_PATTERN.test(value)) {
    throw workerError('operation_id_invalid');
  }
  return value;
}

function assertCanonicalAbsolutePath(value, code = 'invalid_request') {
  if (typeof value !== 'string' || !path.isAbsolute(value)
      || path.normalize(value) !== value || value.includes('\0')
      || Buffer.byteLength(value, 'utf8') > 4096
      || /[\u0000-\u001f\u007f]/.test(value)) {
    throw workerError(code);
  }
  return value;
}

function assertSafeNonnegative(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw workerError(code);
}

function assertBoundedString(value, code, maxBytes = 256) {
  if (typeof value !== 'string' || value.length === 0
      || Buffer.byteLength(value, 'utf8') > maxBytes || value.includes('\0')) {
    throw workerError(code);
  }
  return value;
}

function assertGeneratedBasename(value, code) {
  assertBoundedString(value, code);
  if (path.isAbsolute(value) || path.basename(value) !== value
      || value === '.' || value === '..' || value.includes('/') || value.includes('\\')) {
    throw workerError(code);
  }
}

function constantTimeEqualHex(left, right) {
  if (!SHA256_PATTERN.test(left) || !SHA256_PATTERN.test(right)) return false;
  const a = Buffer.from(left.slice('sha256:'.length), 'hex');
  const b = Buffer.from(right.slice('sha256:'.length), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function containsForbiddenKey(value, forbidden) {
  if (Array.isArray(value)) return value.some((entry) => containsForbiddenKey(entry, forbidden));
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) =>
    forbidden.has(key) || containsForbiddenKey(child, forbidden));
}

function validateSourceDescriptor(rawDescriptor, canonicalRoot, digest) {
  const code = 'source_pin_invalid';
  const descriptor = clone(rawDescriptor, code);
  exactKeys(descriptor, [
    'version', 'canonicalRoot', 'generation', 'baseRevision', 'cutoffRevision',
    'activeBase', 'activeDelta', 'summary',
  ], code);
  if (descriptor.version !== 1 || descriptor.canonicalRoot !== canonicalRoot) {
    throw workerError(code);
  }
  assertCanonicalAbsolutePath(descriptor.canonicalRoot, code);
  assertIdentifier(descriptor.generation, code);
  assertSafeNonnegative(descriptor.baseRevision, code);
  assertSafeNonnegative(descriptor.cutoffRevision, code);
  if (descriptor.cutoffRevision < descriptor.baseRevision
      || descriptor.baseRevision >= Number.MAX_SAFE_INTEGER) throw workerError(code);

  exactKeys(descriptor.activeBase, ['nodes', 'edges'], code);
  for (const kind of ['nodes', 'edges']) {
    const entry = descriptor.activeBase[kind];
    exactKeys(entry, ['file', 'count', 'bytes'], code);
    assertGeneratedBasename(entry.file, code);
    assertSafeNonnegative(entry.count, code);
    assertSafeNonnegative(entry.bytes, code);
  }

  exactKeys(descriptor.activeDelta, [
    'epoch', 'file', 'fromRevision', 'toRevision', 'count', 'committedBytes',
  ], code);
  assertIdentifier(descriptor.activeDelta.epoch, code);
  assertGeneratedBasename(descriptor.activeDelta.file, code);
  for (const field of ['fromRevision', 'toRevision', 'count', 'committedBytes']) {
    assertSafeNonnegative(descriptor.activeDelta[field], code);
  }
  if (descriptor.activeDelta.fromRevision !== descriptor.baseRevision + 1
      || descriptor.activeDelta.toRevision !== descriptor.cutoffRevision
      || descriptor.activeDelta.count !== descriptor.cutoffRevision - descriptor.baseRevision) {
    throw workerError(code);
  }
  exactKeys(descriptor.summary, ['nodeCount', 'edgeCount', 'clusterCount'], code);
  for (const field of ['nodeCount', 'edgeCount', 'clusterCount']) {
    assertSafeNonnegative(descriptor.summary[field], code);
  }
  if (!constantTimeEqualHex(digest, sourceDescriptorDigest(descriptor))) {
    throw workerError(code);
  }
  return Object.freeze(descriptor);
}

function createProcessPinIdentity({ pid = process.pid, processStartIdentity }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof processStartIdentity !== 'string'
      || processStartIdentity.length === 0
      || Buffer.byteLength(processStartIdentity, 'utf8') > 4096) {
    throw workerError('source_unavailable', 'process pin identity unavailable', {
      retryable: true,
    });
  }
  const digest = crypto.createHash('sha256')
    .update(String(pid)).update('\0').update(processStartIdentity)
    .digest('hex').slice(0, 20);
  return `cosmo-${pid}-${digest}`;
}

function operationRootFromScratch(derivedScratchDir) {
  if (typeof derivedScratchDir !== 'string' || !path.isAbsolute(derivedScratchDir)
      || path.basename(derivedScratchDir) !== 'scratch'
      || path.basename(path.dirname(derivedScratchDir)) === '') {
    throw workerError('invalid_request', 'invalid operation scratch directory', {
      retryable: false,
    });
  }
  return path.dirname(derivedScratchDir);
}

function peekCapabilityClaims(token) {
  try {
    const parts = typeof token === 'string' ? token.split('.') : [];
    if (parts.length !== 2 || !parts[0] || !parts[1]
        || !/^[A-Za-z0-9_-]+$/.test(parts[0])) throw new Error('invalid token');
    const bytes = Buffer.from(parts[0], 'base64url');
    if (bytes.toString('base64url') !== parts[0]) throw new Error('noncanonical payload');
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw workerError('capability_invalid', 'capability_invalid', { cause: error });
  }
}

function capabilityBindings(request) {
  const target = request.target;
  return {
    requesterAgent: request.requesterAgent,
    targetDomain: target.domain,
    targetBrainId: target.domain === 'brain' ? target.brainId : null,
    targetRunId: target.domain === 'owned-run' ? target.runId : null,
    targetRequesterAgent: target.domain === 'requester' ? target.requesterAgent : null,
    canonicalRoot: target.domain === 'requester' ? null : target.canonicalRoot,
    accessMode: target.domain === 'brain' ? target.accessMode : 'own',
    operationType: request.operationType,
    operationId: request.operationId,
    sourcePinDigest: request.sourcePinDigest,
  };
}

function requestFingerprint(request) {
  try {
    return canonicalSha256({
      requesterAgent: request.requesterAgent,
      target: request.target,
      accessMode: request.target.domain === 'brain' ? request.target.accessMode : 'own',
      operationType: request.operationType,
      sourcePinDigest: request.sourcePinDigest,
      parameters: request.parameters,
      operationControl: request.operationControl,
    });
  } catch (error) {
    throw workerError('invalid_request', 'invalid_request', { cause: error });
  }
}

function pgsSessionBinding(request) {
  const parameters = request.parameters;
  if (typeof parameters.query !== 'string' || !parameters.query.trim()
      || !parameters.pgsSweep || typeof parameters.pgsSweep.provider !== 'string'
      || typeof parameters.pgsSweep.model !== 'string') {
    throw workerError('invalid_request');
  }
  const canonicalQuery = parameters.query;
  return Object.freeze({
    schemaVersion: 3,
    canonicalQuery,
    queryDigest: crypto.createHash('sha256').update(canonicalQuery, 'utf8').digest('hex'),
    queryNormalizationVersion: 1,
    sourceDescriptorDigest: request.sourcePinDigest,
    sourceRevision: request.sourcePinDescriptor.cutoffRevision,
    sweepProvider: parameters.pgsSweep.provider,
    sweepModel: parameters.pgsSweep.model,
    operationLimits: PGS_OPERATION_LIMITS,
    sweepPromptContractVersion: 1,
    coverageSelectionPolicyVersion: 1,
  });
}

function isPgsContinuation(request) {
  return request.operationType === 'pgs'
    && typeof request.parameters.pgsSessionId === 'string'
    && typeof request.parameters.continueFromOperationId === 'string';
}

function createPgsSessionProjectionSource(request) {
  // HOME23 PATCH 62 — The retained database is the continuation's immutable
  // graph projection. This facade can report its authority but cannot rebuild it.
  const descriptor = request.sourcePinDescriptor;
  const summary = descriptor.summary;
  const authoritativeTotals = Object.freeze({
    nodes: summary.nodeCount,
    edges: summary.edgeCount,
  });
  const getEvidence = (input = {}) => {
    const returnedTotals = input.returnedTotals || { nodes: 0, edges: 0 };
    const completeCoverage = input.completeCoverage === true;
    const filteredTotal = Number.isSafeInteger(input.filteredTotal) && input.filteredTotal >= 0
      ? input.filteredTotal
      : 0;
    return createEvidence({
      selectedAgent: input.selectedAgent ?? request.target.ownerAgent ?? null,
      selectedBrain: input.selectedBrain ?? request.target.brainId ?? null,
      route: input.route || request.target.route || 'brain-operation-worker',
      implementation: 'manifest-v1-session-projection',
      identity: {
        requesterAgent: request.requesterAgent,
        targetAgent: request.target.ownerAgent ?? null,
        brainId: request.target.brainId ?? null,
        canonicalRoot: descriptor.canonicalRoot,
        catalogRevision: request.target.catalogRevision ?? null,
        kind: request.target.kind ?? null,
        sourceType: request.target.sourceType ?? null,
        accessMode: request.target.accessMode,
        operationId: request.operationId,
      },
      baseRevision: descriptor.baseRevision,
      baseFile: descriptor.activeBase.nodes.file,
      deltaRevision: descriptor.cutoffRevision,
      deltaEpoch: descriptor.activeDelta.epoch,
      deltaApplied: descriptor.activeDelta.count,
      annBuiltFromRevision: null,
      annFresh: false,
      filters: input.filters || {},
      limits: input.limits || {},
      authoritativeTotals,
      returnedTotals,
      completeCoverage,
      filteredTotal,
      mutationBoundaries: request.target.mutationBoundaries || [],
      sourceHealth: 'healthy',
      matchOutcome: classifyMatchOutcome({
        sourceHealth: 'healthy',
        authoritativeTotal: authoritativeTotals.nodes,
        returnedTotal: returnedTotals.nodes,
        filteredTotal,
        completeCoverage,
      }),
      freshness: 'known',
    });
  };
  const projectionRequired = async function* projectionRequired() {
    throw workerError(
      'session_projection_required',
      'PGS continuation must reuse its retained session projection',
      { retryable: false },
    );
  };
  return Object.freeze({
    descriptor,
    revision: descriptor.cutoffRevision,
    evidence: getEvidence(),
    getEvidence,
    async summarize() { return { ...summary }; },
    iterateNodes: projectionRequired,
    iterateEdges: projectionRequired,
    async release() {},
  });
}

function continuationSessionStorage(storage) {
  // HOME23 PATCH 62 — Capability narrowing is explicit and survives every
  // adapter boundary down to the pinned store.
  return Object.freeze({
    databasePath: storage.databasePath,
    quotaMaxBytes: storage.quotaMaxBytes,
    reuseOnly: true,
    verify: (...args) => storage.verify(...args),
    reconcileQuota: (...args) => storage.reconcileQuota(...args),
    markProjectionUsable: (...args) => storage.markProjectionUsable(...args),
    close: (...args) => storage.close(...args),
  });
}

function eventBytes(event) {
  return Buffer.byteLength(`${canonicalJson(event)}\n`, 'utf8');
}

function normalizeExecutorError(error) {
  const code = typeof error?.code === 'string' && IDENTIFIER_PATTERN.test(error.code)
    ? error.code
    : 'executor_failed';
  const message = String(error?.message || code).slice(0, 4096);
  return { code, message, retryable: error?.retryable === true };
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

class BrainOperationWorker {
  constructor(options = {}) {
    if (!options || Array.isArray(options) || typeof options !== 'object') {
      throw workerError('worker_configuration_invalid');
    }
    if (typeof options.home23Root !== 'string' || !path.isAbsolute(options.home23Root)
        || typeof options.resolveTarget !== 'function'
        || !options.sourcePins || typeof options.sourcePins.openPinnedSource !== 'function') {
      throw workerError('worker_configuration_invalid');
    }
    this.home23Root = fs.realpathSync(options.home23Root);
    this.capabilityKey = options.capabilityKey;
    this.resolveTarget = options.resolveTarget;
    this.sourcePins = options.sourcePins;
    this.scratchQuotaFactory = options.scratchQuotaFactory || createOperationScratchQuota;
    if (typeof this.scratchQuotaFactory !== 'function') {
      throw workerError('worker_configuration_invalid');
    }
    this.pgsSessionAuthorityFactory = options.pgsSessionAuthorityFactory
      || ((authorityOptions) => createPgsSessionAuthority(authorityOptions));
    if (typeof this.pgsSessionAuthorityFactory !== 'function') {
      throw workerError('worker_configuration_invalid');
    }
    this.pgsSessionAuthorities = new Map();
    this.operationAuthority = OPERATION_AUTHORITY;
    this.authorizeBrainOperation = options.authorizeBrainOperation || authorizeBrainOperation;
    if (this.authorizeBrainOperation !== authorizeBrainOperation
        && typeof this.authorizeBrainOperation !== 'function') {
      throw workerError('worker_configuration_invalid');
    }
    if (!(options.executors instanceof Map)) throw workerError('worker_configuration_invalid');
    this.executors = new Map();
    for (const [operationType, executor] of options.executors) {
      assertIdentifier(operationType, 'worker_configuration_invalid');
      if (typeof executor !== 'function' || this.executors.has(operationType)) {
        throw workerError('worker_configuration_invalid');
      }
      this.executors.set(operationType, executor);
    }
    this.now = typeof options.clock?.now === 'function' ? options.clock.now : Date.now;
    this.monotonicNow = typeof options.clock?.monotonicNow === 'function'
      ? options.clock.monotonicNow
      : this.now;
    const timers = options.timers || globalThis;
    if (typeof timers.setTimeout !== 'function' || typeof timers.clearTimeout !== 'function') {
      throw workerError('worker_configuration_invalid');
    }
    this.setTimeout = (callback, delay) => timers.setTimeout(callback, delay);
    this.clearTimeout = (timer) => timers.clearTimeout(timer);
    const processStartIdentity = options.processStartIdentity
      || `${process.pid}:${Math.floor(Date.now() - process.uptime() * 1000)}`;
    this.processIdentity = options.processIdentity || createProcessPinIdentity({
      pid: process.pid,
      processStartIdentity,
    });
    assertIdentifier(this.processIdentity, 'worker_configuration_invalid');
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes;
    this.nonceStore = options.nonceStore || new CapabilityNonceStore({ now: this.now });
    if (typeof this.nonceStore.consume !== 'function') throw workerError('worker_configuration_invalid');
    this.records = new Map();
    this.pendingStarts = new Map();
    this.tombstones = new Map();
    this.startLocks = new Map();
    this.inflightStarts = new Set();
    this.stopped = false;
  }

  async _pgsSessionAuthority(requesterAgent) {
    let pending = this.pgsSessionAuthorities.get(requesterAgent);
    if (!pending) {
      pending = Promise.resolve(this.pgsSessionAuthorityFactory({
        agentRuntimeRoot: path.join(
          this.home23Root, 'instances', requesterAgent, 'runtime',
        ),
        agentId: requesterAgent,
        clock: this.now,
      }));
      this.pgsSessionAuthorities.set(requesterAgent, pending);
    }
    try {
      const authority = await pending;
      if (!authority || typeof authority.createSession !== 'function'
          || typeof authority.continueSession !== 'function'
          || typeof authority.openSessionStorage !== 'function') {
        throw workerError('worker_configuration_invalid');
      }
      return authority;
    } catch (error) {
      if (this.pgsSessionAuthorities.get(requesterAgent) === pending) {
        this.pgsSessionAuthorities.delete(requesterAgent);
      }
      throw error;
    }
  }

  _normalizeRequest(pathOperationId, rawRequest) {
    assertOperationId(pathOperationId);
    const request = clone(rawRequest, 'invalid_request');
    exactKeys(request, [
      'operationId', 'operationType', 'requesterAgent', 'target', 'parameters',
      'operationControl', 'sourcePinDescriptor', 'sourcePinDigest',
    ]);
    if (request.operationId !== pathOperationId) throw workerError('invalid_request');
    assertOperationId(request.operationId);
    assertIdentifier(request.operationType);
    assertIdentifier(request.requesterAgent);
    if (!request.target || Array.isArray(request.target) || typeof request.target !== 'object') {
      throw workerError('invalid_request');
    }
    if (!request.parameters || Array.isArray(request.parameters)
        || typeof request.parameters !== 'object'
        || Buffer.byteLength(canonicalJson(request.parameters), 'utf8') > MAX_PARAMETERS_BYTES
        || containsForbiddenKey(request.parameters, FORBIDDEN_PARAMETER_KEYS)) {
      throw workerError('invalid_request');
    }
    exactKeys(request.operationControl, ['hardDeadlineAt']);
    const hardDeadline = Date.parse(request.operationControl.hardDeadlineAt);
    if (!Number.isFinite(hardDeadline)
        || new Date(hardDeadline).toISOString() !== request.operationControl.hardDeadlineAt) {
      throw workerError('invalid_request');
    }
    if (request.operationType === 'graph_export') {
      exactKeys(request.parameters, ['format']);
      if (request.parameters.format !== 'jsonl') throw workerError('invalid_request');
    }
    const policy = this.operationAuthority[request.operationType];
    if (!policy) return request;
    if (policy.requiresSourcePin) {
      if (request.sourcePinDescriptor === null || request.sourcePinDigest === null) {
        throw workerError('invalid_request');
      }
      request.sourcePinDescriptor = validateSourceDescriptor(
        request.sourcePinDescriptor,
        request.target.canonicalRoot,
        request.sourcePinDigest,
      );
    } else if (request.sourcePinDescriptor !== null || request.sourcePinDigest !== null) {
      throw workerError('invalid_request');
    }
    return request;
  }

  _assertDeadlineOpen(request) {
    const now = this.now();
    if (!Number.isFinite(now)) throw workerError('worker_clock_invalid');
    const hardDeadlineAt = Date.parse(request.operationControl.hardDeadlineAt);
    if (hardDeadlineAt <= now) {
      throw workerError('operation_timeout', 'operation hard deadline elapsed', {
        retryable: false,
        statusCode: 504,
      });
    }
    return hardDeadlineAt;
  }

  _armHardDeadline(controllerOrControllers, hardDeadlineAt) {
    const controllers = Array.isArray(controllerOrControllers)
      ? controllerOrControllers
      : [controllerOrControllers];
    let timer = null;
    let active = true;
    const abortAtDeadline = () => {
      timer = null;
      if (!active || controllers.every((controller) => controller.signal.aborted)) return;
      const now = this.now();
      if (!Number.isFinite(now)) {
        for (const controller of controllers) {
          if (!controller.signal.aborted) controller.abort(workerError('worker_clock_invalid'));
        }
        return;
      }
      const remaining = hardDeadlineAt - now;
      if (remaining > 0) {
        timer = this.setTimeout(abortAtDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS));
        timer?.unref?.();
        return;
      }
      for (const controller of controllers) {
        if (!controller.signal.aborted) {
          controller.abort(workerError('operation_timeout', 'operation hard deadline elapsed', {
            retryable: false,
            statusCode: 504,
          }));
        }
      }
    };
    const remaining = hardDeadlineAt - this.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      abortAtDeadline();
    } else {
      timer = this.setTimeout(abortAtDeadline, Math.min(remaining, MAX_TIMER_DELAY_MS));
      timer?.unref?.();
    }
    return () => {
      if (!active) return;
      active = false;
      if (timer !== null) this.clearTimeout(timer);
      timer = null;
    };
  }

  _verifyCapabilityForPath(capability, operationId) {
    assertOperationId(operationId);
    const now = this.now();
    if (!Number.isFinite(now)) throw workerError('capability_invalid');
    const untrusted = peekCapabilityClaims(capability);
    const expected = Object.fromEntries(
      CAPABILITY_FIELDS.map((field) => [field, untrusted?.[field]]),
    );
    expected.operationId = operationId;
    const claims = verifyCapability(this.capabilityKey, capability, {
      ...expected,
      now,
    });
    this.nonceStore.consume({
      nonce: claims.nonce,
      operationId: claims.operationId,
      expiresAt: claims.expiresAt,
    });
    return claims;
  }

  _assertCapabilityMatchesRequest(claims, request) {
    const bindings = capabilityBindings(request);
    for (const [field, expected] of Object.entries(bindings)) {
      if (claims[field] !== expected) throw workerError('capability_mismatch');
    }
    return claims;
  }

  _verifyCapability(capability, request) {
    return this._assertCapabilityMatchesRequest(
      this._verifyCapabilityForPath(capability, request.operationId),
      request,
    );
  }

  async _resolveAndAuthorize(request) {
    const rawTarget = await this.resolveTarget({
      requesterAgent: request.requesterAgent,
      operationType: request.operationType,
      target: clone(request.target),
    });
    const resolvedTarget = clone(rawTarget, 'access_denied');
    const resolvedPolicy = this.authorizeBrainOperation({
      requesterAgent: request.requesterAgent,
      operationType: request.operationType,
      target: resolvedTarget,
    });
    if (resolvedPolicy !== this.operationAuthority[request.operationType]) {
      throw workerError('worker_configuration_invalid');
    }

    let target = resolvedTarget;
    if (resolvedTarget.domain === 'brain' && request.target.domain === 'brain') {
      // The dashboard and COSMO intentionally build catalogs with different
      // scopes. Preserve the dashboard's durable snapshot revision while
      // requiring every target-scoped authority field to match COSMO's fresh
      // resolution. Source freshness remains bound by the source-pin digest.
      target = {
        ...resolvedTarget,
        catalogRevision: request.target.catalogRevision,
      };
    }
    if (canonicalJson(target) !== canonicalJson(request.target)) throw workerError('access_denied');
    const policy = this.authorizeBrainOperation({
      requesterAgent: request.requesterAgent,
      operationType: request.operationType,
      target,
    });
    if (policy !== this.operationAuthority[request.operationType]) {
      throw workerError('worker_configuration_invalid');
    }
    return { target: Object.freeze(target), policy };
  }

  _awaitWithAbort(promise, signal) {
    if (!(signal instanceof AbortSignal)) return Promise.resolve(promise);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', aborted);
        handler(value);
      };
      const aborted = () => finish(reject, signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      Promise.resolve(promise).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  async _withStartLock(operationId, callback, signal = null) {
    const prior = this.startLocks.get(operationId) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const current = prior.catch(() => {}).then(() => gate);
    this.startLocks.set(operationId, current);
    void current.then(() => {
      if (this.startLocks.get(operationId) === current) this.startLocks.delete(operationId);
    });
    try {
      await this._awaitWithAbort(prior.catch(() => {}), signal);
      if (signal?.aborted) throw signal.reason;
      return await callback();
    } finally {
      release();
    }
  }

  _addTombstone(operationId) {
    this.tombstones.delete(operationId);
    this.tombstones.set(operationId, this.now());
    while (this.tombstones.size > MAX_TOMBSTONES) {
      this.tombstones.delete(this.tombstones.keys().next().value);
    }
  }

  _gc() {
    const now = this.now();
    if (!Number.isFinite(now)) throw workerError('worker_clock_invalid');
    for (const [operationId, record] of this.records) {
      if (!TERMINAL_STATES.has(record.state) || !Number.isFinite(record.terminalAt)) continue;
      const expiresAt = record.resultObservedAt === null
        ? record.terminalAt + UNREAD_TERMINAL_RETENTION_MS
        : record.resultObservedAt + OBSERVED_TERMINAL_RETENTION_MS;
      if (now < expiresAt) continue;
      record.controller = null;
      record.context = null;
      record.clearDeadline?.();
      record.clearDeadline = null;
      record.result = null;
      record.events.length = 0;
      record.eventBytes = 0;
      record.eventByteSizes.clear();
      record.activeProviderCalls.clear();
      record.waiters.clear();
      this.records.delete(operationId);
      this._addTombstone(operationId);
    }
  }

  _recordOrThrow(operationId) {
    assertOperationId(operationId);
    this._gc();
    const record = this.records.get(operationId);
    if (!record) throw workerError('worker_not_found');
    return record;
  }

  _authenticateExisting(operationId, capability) {
    const claims = this._verifyCapabilityForPath(capability, operationId);
    const record = this._recordOrThrow(operationId);
    this._assertCapabilityMatchesRequest(claims, record.request);
    return record;
  }

  _publicRecord(record) {
    const monotonic = this.monotonicNow();
    if (!Number.isFinite(monotonic)) throw workerError('worker_clock_invalid');
    const activeProviderCalls = [...record.activeProviderCalls.values()]
      .map((call) => ({
        providerCallId: call.providerCallId,
        providerStallMs: call.providerStallMs,
        idleMs: Math.max(0, monotonic - call.lastActivityAt),
      }))
      .sort((left, right) => left.providerCallId.localeCompare(right.providerCallId));
    return Object.freeze({
      reference: record.reference,
      operationId: record.operationId,
      operationType: record.operationType,
      state: record.state,
      phase: record.phase,
      eventSequence: record.eventSequence,
      activeProviderCalls: Object.freeze(activeProviderCalls),
      pgsSession: record.pgsSessionMetadata || null,
    });
  }

  _createPendingStart(request, fingerprint) {
    const hardDeadlineAt = this._assertDeadlineOpen(request);
    const controller = new AbortController();
    const cleanupController = new AbortController();
    const clearDeadline = this._armHardDeadline(controller, hardDeadlineAt);
    let workerIdBytes;
    try {
      workerIdBytes = this.randomBytes(18);
    } catch (error) {
      clearDeadline();
      throw workerError('worker_configuration_invalid', 'worker identity unavailable', { cause: error });
    }
    if (!Buffer.isBuffer(workerIdBytes) || workerIdBytes.length !== 18) {
      clearDeadline();
      throw workerError('worker_configuration_invalid');
    }
    return {
      reference: Object.freeze({
        version: 1,
        workerId: `cosmo-${workerIdBytes.toString('base64url')}`,
        workerType: 'cosmo',
        operationType: request.operationType,
      }),
      operationId: request.operationId,
      operationType: request.operationType,
      request,
      fingerprint,
      state: 'running',
      phase: 'preparing',
      eventSequence: 0,
      activeProviderCalls: new Map(),
      events: [],
      eventBytes: 0,
      eventByteSizes: new Map(),
      waiters: new Set(),
      result: null,
      pgsSessionMetadata: null,
      controller,
      cleanupController,
      context: null,
      sourcePin: null,
      scratchQuota: null,
      scratchDir: null,
      releasePromise: null,
      runPromise: null,
      settled: null,
      terminalAt: null,
      resultObservedAt: null,
      clearDeadline,
    };
  }

  _publishCancelledPendingStart(pending) {
    pending.request = Object.freeze(pending.request);
    pending.state = 'cancelled';
    pending.phase = 'terminal';
    pending.result = Object.freeze({
      state: 'cancelled',
      result: null,
      resultArtifact: null,
      error: null,
      sourceEvidence: null,
    });
    pending.terminalAt = this.now();
    pending.clearDeadline = null;
    pending.eventSequence += 1;
    this._pushEvent(pending, Object.freeze({
      type: 'terminal',
      operationId: pending.operationId,
      eventSequence: pending.eventSequence,
      state: pending.state,
      at: new Date(pending.terminalAt).toISOString(),
    }));
    pending.runPromise = Promise.resolve();
    this.records.set(pending.operationId, pending);
    this._notify(pending);
    return pending;
  }

  _notify(record) {
    const waiters = [...record.waiters];
    record.waiters.clear();
    for (const wake of waiters) wake();
  }

  _removeEvent(record, index) {
    const [removed] = record.events.splice(index, 1);
    if (!removed) return;
    const bytes = record.eventByteSizes.get(removed.eventSequence) || 0;
    record.eventByteSizes.delete(removed.eventSequence);
    record.eventBytes = Math.max(0, record.eventBytes - bytes);
  }

  _compactEvents(record) {
    while (record.events.length > WORKER_EVENT_MAX_COUNT
        || record.eventBytes > WORKER_EVENT_MAX_BYTES) {
      const overBytes = record.eventBytes > WORKER_EVENT_MAX_BYTES;
      let index = overBytes
        ? record.events.findLastIndex((event) => NOISY_EVENT_TYPES.has(event.type))
        : record.events.findIndex((event) => NOISY_EVENT_TYPES.has(event.type));
      if (index < 0) {
        index = record.events.findIndex((event, candidate) =>
          event.type === 'phase'
          && record.events.slice(candidate + 1).some((later) => later.type === 'phase'));
      }
      if (index < 0) index = record.events.findIndex((event) => event.type !== 'terminal');
      if (index < 0) index = 0;
      this._removeEvent(record, index);
    }
  }

  _pushEvent(record, event) {
    const bytes = eventBytes(event);
    record.events.push(event);
    record.eventByteSizes.set(event.eventSequence, bytes);
    record.eventBytes += bytes;
    this._compactEvents(record);
  }

  _reportEvent(record, rawEvent) {
    if (TERMINAL_STATES.has(record.state)) throw workerError('worker_terminal');
    const event = clone(rawEvent, 'worker_event_invalid');
    if (!event || Array.isArray(event) || typeof event !== 'object'
        || !EXECUTOR_EVENT_TYPES.has(event.type)
        || Object.hasOwn(event, 'operationId')
        || Object.hasOwn(event, 'eventSequence')
        || Object.hasOwn(event, 'sequence')
        || Object.hasOwn(event, 'state')
        || containsForbiddenKey(event, FORBIDDEN_EVENT_KEYS)) {
      throw workerError('worker_event_invalid');
    }
    if (event.type === 'phase') assertIdentifier(event.phase, 'worker_event_invalid');
    const monotonic = this.monotonicNow();
    if (!Number.isFinite(monotonic)) throw workerError('worker_clock_invalid');
    if (PROVIDER_EVENT_TYPES.has(event.type)) {
      assertIdentifier(event.providerCallId, 'worker_event_invalid');
      const current = record.activeProviderCalls.get(event.providerCallId);
      if (event.type === 'provider_selected') {
        if (!Number.isSafeInteger(event.providerStallMs) || event.providerStallMs <= 0
            || current || record.activeProviderCalls.size >= MAX_ACTIVE_PROVIDER_CALLS) {
          throw workerError('provider_contract_invalid');
        }
        record.activeProviderCalls.set(event.providerCallId, {
          providerCallId: event.providerCallId,
          providerStallMs: event.providerStallMs,
          lastActivityAt: monotonic,
          lastPublishedActivityAt: null,
          lastPublishedActivitySignature: null,
        });
      } else if (!current) {
        throw workerError('provider_contract_invalid');
      } else if (event.type === 'provider_activity') {
        current.lastActivityAt = monotonic;
        const signature = `${event.providerEventType ?? ''}\u0000${event.childEventType ?? ''}`;
        if (current.lastPublishedActivitySignature === signature
            && current.lastPublishedActivityAt !== null
            && monotonic - current.lastPublishedActivityAt
              < PROVIDER_ACTIVITY_PUBLISH_INTERVAL_MS) return null;
        current.lastPublishedActivityAt = monotonic;
        current.lastPublishedActivitySignature = signature;
      } else {
        record.activeProviderCalls.delete(event.providerCallId);
      }
    }
    record.eventSequence += 1;
    const normalized = Object.freeze({
      ...event,
      operationId: record.operationId,
      eventSequence: record.eventSequence,
      at: new Date(this.now()).toISOString(),
    });
    if (normalized.type === 'phase') record.phase = normalized.phase;
    this._pushEvent(record, normalized);
    this._notify(record);
    return normalized;
  }

  async _validateArtifact(record, rawArtifact) {
    const artifact = clone(rawArtifact, 'worker_result_invalid');
    exactKeys(artifact, [
      'scratchPath', 'mediaType', 'contentEncoding', 'bytes', 'sha256',
    ], 'worker_result_invalid');
    if (record.operationType !== 'graph_export'
        || canonicalJson(record.request.parameters) !== canonicalJson({ format: 'jsonl' })
        || artifact.mediaType !== 'application/x-ndjson'
        || artifact.contentEncoding !== 'identity'
        || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0
        || artifact.bytes > WORKER_RESULT_ARTIFACT_MAX_BYTES
        || typeof artifact.sha256 !== 'string' || !SHA256_HEX_PATTERN.test(artifact.sha256)) {
      throw workerError('worker_result_invalid');
    }
    assertCanonicalAbsolutePath(artifact.scratchPath, 'worker_result_invalid');
    const lexicalRelative = path.relative(record.scratchDir, artifact.scratchPath);
    if (!lexicalRelative || lexicalRelative === '..' || lexicalRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(lexicalRelative)) throw workerError('worker_result_invalid');
    let stat;
    let realScratch;
    let realArtifact;
    try {
      [stat, realScratch, realArtifact] = await Promise.all([
        fsp.lstat(artifact.scratchPath),
        fsp.realpath(record.scratchDir),
        fsp.realpath(artifact.scratchPath),
      ]);
    } catch (error) {
      throw workerError('worker_result_invalid', 'worker_result_invalid', { cause: error });
    }
    const realRelative = path.relative(realScratch, realArtifact);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== artifact.bytes
        || !realRelative || realRelative === '..' || realRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(realRelative)
        || await hashFile(realArtifact) !== artifact.sha256) {
      throw workerError('worker_result_invalid');
    }
    return Object.freeze(artifact);
  }

  async _validateResult(record, rawEnvelope) {
    const resultLimit = resultLimitForOperation(record.operationType);
    let envelope;
    try {
      const encoded = boundedJsonStringify(rawEnvelope, {
        maxBytes: resultLimit + (3 * MAX_CONTROL_OBJECT_BYTES),
        label: 'Worker result envelope',
      }).json;
      envelope = JSON.parse(encoded);
    } catch (error) {
      throw workerError('worker_result_invalid', 'worker_result_invalid', { cause: error });
    }
    if (!Object.hasOwn(envelope, 'resultArtifact')) envelope.resultArtifact = null;
    exactKeys(envelope, ['state', 'result', 'resultArtifact', 'error', 'sourceEvidence'],
      'worker_result_invalid');
    if (!RESULT_STATES.has(envelope.state)) throw workerError('worker_result_invalid');
    for (const [field, value] of [
      ['result', envelope.result],
      ['error', envelope.error],
      ['sourceEvidence', envelope.sourceEvidence],
    ]) {
      if (value !== null && (!value || Array.isArray(value) || typeof value !== 'object')) {
        throw workerError('worker_result_invalid');
      }
      const maximum = field === 'result' ? resultLimit : MAX_CONTROL_OBJECT_BYTES;
      if (value !== null
          && Buffer.byteLength(canonicalJson(value), 'utf8') > maximum) {
        throw workerError('worker_result_invalid');
      }
      if (field === 'error' && value !== null) {
        if (typeof value.code !== 'string' || typeof value.message !== 'string'
            || typeof value.retryable !== 'boolean') throw workerError('worker_result_invalid');
      }
    }
    if (envelope.resultArtifact !== null) {
      if (envelope.result !== null) throw workerError('worker_result_invalid');
      envelope.resultArtifact = await this._validateArtifact(record, envelope.resultArtifact);
    }
    return Object.freeze(envelope);
  }

  _releaseOnce(record) {
    if (!record.releasePromise) {
      record.releasePromise = (async () => {
        const sourcePin = record.sourcePin;
        const scratchQuota = record.scratchQuota;
        const pgsSessionStorage = record.pgsSession?.sessionStorage || null;
        record.sourcePin = null;
        record.scratchQuota = null;
        record.pgsSession = null;
        try {
          await sourcePin?.release?.();
        } finally {
          try {
            await pgsSessionStorage?.close?.();
          } finally {
            await scratchQuota?.close?.();
          }
        }
      })();
    }
    return record.releasePromise;
  }

  async _run(record, executor) {
    let envelope;
    try {
      const executorParameters = clone(record.request.parameters);
      delete executorParameters.pgsSessionId;
      const raw = await executor({
        operationId: record.operationId,
        operationType: record.operationType,
        requesterAgent: record.request.requesterAgent,
        target: clone(record.request.target),
        parameters: executorParameters,
        scratchDir: record.scratchDir,
        scratchQuota: record.scratchQuota,
        signal: record.controller.signal,
        sourcePin: record.sourcePin,
        ...(record.pgsSession ? { pgsSession: record.pgsSession } : {}),
        reportEvent: (event) => this._reportEvent(record, event),
      });
      if (record.controller.signal.aborted) throw record.controller.signal.reason;
      envelope = await this._validateResult(record, raw);
      if (record.activeProviderCalls.size > 0) {
        throw workerError('provider_contract_invalid');
      }
    } catch (error) {
      if (record.controller.signal.aborted) {
        const reason = record.controller.signal.reason;
        if (reason?.code === 'operation_timeout' || reason?.code === 'worker_clock_invalid') {
          envelope = Object.freeze({
            state: 'failed',
            result: null,
            resultArtifact: null,
            error: normalizeExecutorError(reason),
            sourceEvidence: null,
          });
        } else {
          const interrupted = reason?.code === 'worker_stopped';
          envelope = Object.freeze({
            state: interrupted ? 'interrupted' : 'cancelled',
            result: null,
            resultArtifact: null,
            error: null,
            sourceEvidence: null,
          });
        }
      } else {
        envelope = Object.freeze({
          state: 'failed',
          result: null,
          resultArtifact: null,
          error: normalizeExecutorError(error),
          sourceEvidence: null,
        });
      }
    }
    record.activeProviderCalls.clear();
    record.phase = 'cleanup';
    try {
      await this._releaseOnce(record);
    } catch (error) {
      const cleanupReason = record.cleanupController?.signal.aborted
        ? record.cleanupController.signal.reason
        : error;
      envelope = cleanupReason?.code === 'operation_timeout'
        ? Object.freeze({
          state: 'failed',
          result: null,
          resultArtifact: null,
          error: normalizeExecutorError(cleanupReason),
          sourceEvidence: null,
        })
        : Object.freeze({
          state: 'interrupted',
          result: null,
          resultArtifact: null,
          error: Object.freeze({
            code: 'source_cleanup_failed',
            message: 'Source cleanup failed before terminal publication',
            retryable: true,
          }),
          sourceEvidence: null,
        });
    } finally {
      record.clearDeadline?.();
      record.clearDeadline = null;
    }
    record.result = envelope;
    record.state = envelope.state;
    record.phase = 'terminal';
    record.terminalAt = this.now();
    record.eventSequence += 1;
    this._pushEvent(record, Object.freeze({
      type: 'terminal',
      operationId: record.operationId,
      eventSequence: record.eventSequence,
      state: record.state,
      at: new Date(this.now()).toISOString(),
    }));
    this._notify(record);
    record.context = null;
  }

  async _prepareScratch(request) {
    const operationRoot = durableBrainOperationRoot(
      this.home23Root,
      request.requesterAgent,
      request.operationId,
    );
    let current = this.home23Root;
    const homeStat = await fsp.lstat(current);
    if (!homeStat.isDirectory() || homeStat.isSymbolicLink()
        || await fsp.realpath(current) !== current) {
      throw workerError('invalid_request');
    }
    for (const segment of [
      'instances', request.requesterAgent, 'runtime', 'brain-operations',
      'operations', request.operationId, 'scratch',
    ]) {
      const next = path.join(current, segment);
      const parentStat = await fsp.lstat(current);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
          || await fsp.realpath(current) !== current) {
        throw workerError('invalid_request');
      }
      let stat = await fsp.lstat(next).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (stat === null) {
        await fsp.mkdir(next, { recursive: false, mode: 0o700 }).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
        stat = await fsp.lstat(next);
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()
          || await fsp.realpath(next) !== next) {
        throw workerError('invalid_request');
      }
      current = next;
    }
    const scratchDir = current;
    if (operationRootFromScratch(scratchDir) !== operationRoot) {
      throw workerError('invalid_request');
    }
    return { operationRoot, scratchDir };
  }

  async _createRecord(request, policy, executor, pending) {
    const {
      controller,
      cleanupController,
      clearDeadline,
    } = pending;
    const throwIfAborted = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    let scratchQuota = null;
    let sourcePin = null;
    let pgsSession = null;
    let pgsSessionAuthority = null;
    let pgsWorkerHandle = null;
    let cleanupPromise = null;
    const cleanupUnpublished = () => {
      cleanupPromise ||= (async () => {
        try {
          await sourcePin?.release?.();
        } finally {
          try {
            if (pgsSession?.sessionStorage) {
              await pgsSession.sessionStorage.close();
            } else if (pgsWorkerHandle && pgsSessionAuthority) {
              // HOME23 PATCH 61 — only a fresh lineage that never opened usable
              // storage may be discarded; continuations retain their database.
              if (pgsWorkerHandle.sourceOperationId === null
                  && typeof pgsSessionAuthority.discardUnusableSession === 'function') {
                await pgsSessionAuthority.discardUnusableSession(pgsWorkerHandle);
              } else {
                await pgsSessionAuthority.releaseLease?.(pgsWorkerHandle);
              }
            }
          } finally {
            try {
              await scratchQuota?.close?.();
            } finally {
              clearDeadline();
            }
          }
        }
      })();
      return cleanupPromise;
    };
    try {
      const { operationRoot, scratchDir } = await this._prepareScratch(request);
      throwIfAborted();
      if (this.stopped) throw workerError('worker_stopped');
      if (policy.requiresSourcePin) {
        scratchQuota = await this.scratchQuotaFactory({
          operationId: request.operationId,
          operationRoot,
          scratchDir,
          signal: controller.signal,
        });
        if (!scratchQuota || typeof scratchQuota.close !== 'function') {
          throw workerError('source_unavailable');
        }
        throwIfAborted();
        if (this.stopped) throw workerError('worker_stopped');
        if (!isPgsContinuation(request)) {
          sourcePin = await this.sourcePins.openPinnedSource(
            request.sourcePinDescriptor,
            {
              expectedCanonicalRoot: request.target.canonicalRoot,
              expectedRevision: request.sourcePinDescriptor.cutoffRevision,
              expectedDigest: request.sourcePinDigest,
              operationId: request.operationId,
              operationType: request.operationType,
              requesterAgent: request.requesterAgent,
              operationRoot,
              lockRoot: path.join(this.home23Root, 'runtime', 'brain-source-locks'),
              processIdentity: this.processIdentity,
              scratchQuota,
              identity: capabilityBindings(request),
              signal: controller.signal,
            },
            createDurableOperationLockCapability({
              hardDeadlineAt: request.operationControl.hardDeadlineAt,
              signal: controller.signal,
              cleanupSignal: cleanupController.signal,
            }),
          );
          throwIfAborted();
          if (!sourcePin || typeof sourcePin.release !== 'function'
              || !Number.isSafeInteger(sourcePin.revision)
              || sourcePin.revision !== request.sourcePinDescriptor.cutoffRevision
              || !sourcePin.descriptor
              || !constantTimeEqualHex(
                request.sourcePinDigest,
                sourceDescriptorDigest(sourcePin.descriptor),
              )) {
            throw workerError('source_changed');
          }
        }
        if (this.stopped) throw workerError('worker_stopped');
      }
      if (this.stopped) throw workerError('worker_stopped');
      if (request.operationType === 'pgs') {
        pgsSessionAuthority = await this._pgsSessionAuthority(request.requesterAgent);
        await pgsSessionAuthority.cleanupExpired?.();
        const binding = pgsSessionBinding(request);
        const requestedSessionId = request.parameters.pgsSessionId;
        let selected;
        if (requestedSessionId === undefined) {
          selected = await pgsSessionAuthority.createSession({
            ownerAgent: request.requesterAgent,
            operationId: request.operationId,
            binding,
          });
        } else {
          if (typeof requestedSessionId !== 'string'
              || !PGS_SESSION_ID_PATTERN.test(requestedSessionId)
              || typeof request.parameters.continueFromOperationId !== 'string') {
            throw workerError('invalid_request');
          }
          selected = await pgsSessionAuthority.continueSession({
            sessionId: requestedSessionId,
            ownerAgent: request.requesterAgent,
            sourceOperationId: request.parameters.continueFromOperationId,
            operationId: request.operationId,
            binding,
          });
        }
        pgsWorkerHandle = selected.workerHandle;
        let sessionStorage = await pgsSessionAuthority.openSessionStorage(
          selected.workerHandle,
          { ownerAgent: request.requesterAgent, operationId: request.operationId },
        );
        if (requestedSessionId !== undefined) {
          sessionStorage = continuationSessionStorage(sessionStorage);
          sourcePin = createPgsSessionProjectionSource(request);
        }
        pgsSession = Object.freeze({
          sessionId: selected.sessionId,
          continuableUntil: selected.continuableUntil,
          sourceOperationId: request.parameters.continueFromOperationId || null,
          sessionStorage,
        });
        pending.pgsSessionMetadata = Object.freeze({
          sessionId: selected.sessionId,
          continuableUntil: selected.continuableUntil,
          sourceOperationId: request.parameters.continueFromOperationId || null,
        });
      }
      if (this.stopped) throw workerError('worker_stopped');
      const record = pending;
      record.phase = 'executing';
      record.sourcePin = sourcePin;
      record.scratchQuota = scratchQuota;
      record.scratchDir = scratchDir;
      record.pgsSession = pgsSession;
      this.records.set(request.operationId, record);
      record.runPromise = Promise.resolve().then(() => this._run(record, executor));
      return record;
    } catch (error) {
      let cleanupError = null;
      try {
        await cleanupUnpublished();
      } catch (cause) {
        cleanupError = cause;
      }
      pending.clearDeadline = null;
      if (cleanupError) {
        throw workerError('source_cleanup_failed', 'pending source cleanup failed', {
          cause: cleanupError,
          retryable: true,
        });
      }
      if (controller.signal.aborted
          && controller.signal.reason?.code === 'operation_cancelled') {
        return this._publishCancelledPendingStart(pending);
      }
      throw error;
    }
  }

  async _runPrestart(pending) {
    const { request, controller } = pending;
    try {
      const { target, policy } = await this._awaitWithAbort(
        Promise.resolve().then(() => this._resolveAndAuthorize(request)),
        controller.signal,
      );
      if (controller.signal.aborted) throw controller.signal.reason;
      if (this.stopped) throw workerError('worker_stopped');
      this._assertDeadlineOpen(request);
      request.target = target;
      if (requestFingerprint(request) !== pending.fingerprint) {
        throw workerError('access_denied');
      }
      pending.request = Object.freeze(request);
      return await this._withStartLock(request.operationId, async () => {
        if (controller.signal.aborted) throw controller.signal.reason;
        this._gc();
        const existing = this.records.get(request.operationId);
        if (existing) {
          if (existing.fingerprint !== pending.fingerprint) {
            throw workerError('worker_operation_conflict');
          }
          pending.clearDeadline?.();
          pending.clearDeadline = null;
          return existing;
        }
        if (this.tombstones.has(request.operationId)) throw workerError('worker_not_found');
        if (this.stopped) throw workerError('worker_stopped');
        this._assertDeadlineOpen(request);
        const executor = this.executors.get(request.operationType);
        if (!executor) throw workerError('executor_unavailable');
        pending.phase = 'preparing';
        return this._createRecord(request, policy, executor, pending);
      }, controller.signal);
    } catch (error) {
      pending.clearDeadline?.();
      pending.clearDeadline = null;
      if (error?.code === 'source_cleanup_failed') throw error;
      if (controller.signal.aborted
          && controller.signal.reason?.code === 'operation_cancelled') {
        return this.records.get(request.operationId)
          || this._publishCancelledPendingStart(pending);
      }
      if (controller.signal.aborted) throw controller.signal.reason;
      throw error;
    } finally {
      if (this.pendingStarts.get(request.operationId) === pending) {
        this.pendingStarts.delete(request.operationId);
      }
    }
  }

  async _startInternal(operationId, capability, rawRequest) {
    if (this.stopped) throw workerError('worker_stopped');
    this._gc();
    const request = this._normalizeRequest(operationId, rawRequest);
    this._verifyCapability(capability, request);
    this._assertDeadlineOpen(request);
    const fingerprint = requestFingerprint(request);
    this._gc();
    const existing = this.records.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw workerError('worker_operation_conflict');
      return this._publicRecord(existing);
    }
    if (this.tombstones.has(operationId)) throw workerError('worker_not_found');
    const joined = this.pendingStarts.get(operationId);
    if (joined) {
      if (joined.fingerprint !== fingerprint) throw workerError('worker_operation_conflict');
      return this._publicRecord(await joined.settled);
    }
    const pending = this._createPendingStart(request, fingerprint);
    this.pendingStarts.set(operationId, pending);
    pending.settled = this._runPrestart(pending);
    return this._publicRecord(await pending.settled);
  }

  start(operationId, capability, rawRequest) {
    if (this.stopped) return Promise.reject(workerError('worker_stopped'));
    const pending = this._startInternal(operationId, capability, rawRequest);
    this.inflightStarts.add(pending);
    return pending.finally(() => this.inflightStarts.delete(pending));
  }

  async status(operationId, capability) {
    const record = this._authenticateExisting(operationId, capability);
    return this._publicRecord(record);
  }

  async *events(operationId, capability, input = {}) {
    const record = this._authenticateExisting(operationId, capability);
    if (!input || !Number.isSafeInteger(input.afterSequence) || input.afterSequence < 0
        || !(input.signal instanceof AbortSignal)) {
      throw workerError('worker_event_cursor_invalid');
    }
    let cursor = input.afterSequence;
    while (!input.signal.aborted) {
      const event = record.events.find((candidate) => candidate.eventSequence > cursor);
      if (record.eventSequence > cursor
          && (!event || event.eventSequence > cursor + 1)) {
        const oldestSequence = cursor + 1;
        const latestSequence = event
          ? event.eventSequence - 1
          : record.eventSequence;
        yield Object.freeze({
          type: 'event_gap',
          operationId,
          eventSequence: latestSequence,
          oldestSequence,
          latestSequence,
          currentStatus: this._publicRecord(record),
        });
        cursor = latestSequence;
        continue;
      }
      if (event) {
        cursor = event.eventSequence;
        yield clone(event, 'worker_event_invalid');
        continue;
      }
      if (TERMINAL_STATES.has(record.state)) return;
      await new Promise((resolve) => {
        const wake = () => {
          record.waiters.delete(wake);
          input.signal.removeEventListener('abort', wake);
          resolve();
        };
        record.waiters.add(wake);
        input.signal.addEventListener('abort', wake, { once: true });
      });
    }
  }

  async result(operationId, capability) {
    const record = this._authenticateExisting(operationId, capability);
    if (!record.result) throw workerError('worker_result_unavailable');
    if (record.resultObservedAt === null) record.resultObservedAt = this.now();
    return clone(record.result, 'worker_result_invalid');
  }

  async cancel(operationId, capability) {
    const claims = this._verifyCapabilityForPath(capability, operationId);
    this._gc();
    let record = this.records.get(operationId);
    const pending = record ? null : this.pendingStarts.get(operationId);
    if (!record && !pending) {
      this._recordOrThrow(operationId);
    }
    this._assertCapabilityMatchesRequest(claims, (record || pending).request);
    if (pending) {
      if (!pending.controller.signal.aborted) {
        pending.controller.abort(workerError('operation_cancelled'));
      }
      await pending.settled;
      record = this.records.get(operationId) || pending;
      return this._publicRecord(record);
    }
    if (!TERMINAL_STATES.has(record.state) && !record.controller.signal.aborted) {
      record.controller.abort(workerError('operation_cancelled'));
      this._notify(record);
    }
    return this._publicRecord(record);
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    for (const pending of this.pendingStarts.values()) {
      if (!pending.controller.signal.aborted) {
        pending.controller.abort(workerError('worker_stopped'));
      }
    }
    for (const record of this.records.values()) {
      if (!TERMINAL_STATES.has(record.state) && !record.controller.signal.aborted) {
        record.controller.abort(workerError('worker_stopped'));
      }
      if (!TERMINAL_STATES.has(record.state)
          && !record.cleanupController?.signal.aborted) {
        record.cleanupController.abort(workerError('worker_stopped'));
      }
      record.clearDeadline?.();
      record.clearDeadline = null;
      this._notify(record);
    }
    const startSettlements = await Promise.allSettled([...this.inflightStarts]);
    await Promise.allSettled([...this.records.values()]
      .map((record) => record.runPromise)
      .filter(Boolean));
    // HOME23 PATCH 61 — drain every autonomous PGS retention janitor on shutdown.
    const authoritySettlements = await Promise.allSettled(
      [...this.pgsSessionAuthorities.values()].map(async (pending) => {
        const authority = await pending;
        await authority.stop?.();
      }),
    );
    this.pgsSessionAuthorities.clear();
    const cleanupFailure = startSettlements.find((settlement) =>
      settlement.status === 'rejected'
      && settlement.reason?.code === 'source_cleanup_failed');
    if (cleanupFailure) throw cleanupFailure.reason;
    const authorityFailure = authoritySettlements.find(
      (settlement) => settlement.status === 'rejected',
    );
    if (authorityFailure) throw authorityFailure.reason;
  }
}

module.exports = {
  BrainOperationWorker,
  MAX_ACTIVE_PROVIDER_CALLS,
  OBSERVED_TERMINAL_RETENTION_MS,
  UNREAD_TERMINAL_RETENTION_MS,
  WORKER_EVENT_MAX_BYTES,
  WORKER_EVENT_MAX_COUNT,
  WORKER_RESULT_ARTIFACT_MAX_BYTES,
  createProcessPinIdentity,
  operationRootFromScratch,
  validateSourceDescriptor,
  workerError,
};
