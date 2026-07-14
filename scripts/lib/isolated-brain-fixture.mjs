#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  constants as fsConstants,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCanonicalDirectoryIdentity,
  assertReceiptContextDirectoryIdentity,
  canonicalDirectory,
  hashFile,
  isInsideOrEqual,
  receiptContext,
  sha256Bytes,
  sleep,
  typedError,
} from './brain-acceptance-common.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const { canonicalJson } = require('../../shared/brain-operations/canonical-json.cjs');
const {
  OPERATION_AUTHORITY,
  authorizeBrainOperation,
} = require('../../shared/brain-operations/authority.cjs');
const {
  BrainOperationCoordinator,
} = require('../../engine/src/dashboard/brain-operations/coordinator.js');
const {
  BrainOperationStore,
} = require('../../engine/src/dashboard/brain-operations/operation-store.js');
const {
  BrainOperationWorkerAdapter,
} = require('../../engine/src/dashboard/brain-operations/worker-adapter.js');
const {
  createCosmoBrainOperationWorkerClient,
} = require('../../engine/src/dashboard/brain-operations/cosmo-worker-client.js');
const {
  createBrainOperationStoreReader,
} = require('../../engine/src/dashboard/brain-operations/store-reader.js');
const {
  createBrainOperationExporter,
} = require('../../engine/src/dashboard/brain-operations/exporter.js');
const {
  createBrainOperationsRouter,
} = require('../../engine/src/dashboard/brain-operations/router.js');
const {
  createSourceOperationExecutors,
} = require('../../engine/src/dashboard/brain-operations/source-executors.js');
const {
  createDashboardSynthesisOperationRuntime,
} = require('../../engine/src/dashboard/brain-operations/synthesis-operation-runtime.js');
const {
  registerSynthesisCompatibilityRoutes,
} = require('../../engine/src/dashboard/brain-operations/synthesis-compatibility-routes.js');
const {
  createBrainSourceService,
} = require('../../engine/src/dashboard/brain-source-api.js');
const {
  createMcpProxyRouter,
} = require('../../engine/src/dashboard/mcp-proxy-router.js');
const {
  buildMcpUnavailableEnvelope,
  probeMcpAvailability,
} = require('../../engine/src/dashboard/mcp-availability.js');
const {
  createMemorySearchService,
} = require('../../engine/src/dashboard/memory-search.js');
const {
  startMcpHttpServer,
} = require('../../engine/mcp/http-server.js');
const {
  createBrainProviderClientRegistry,
} = require('../../cosmo23/lib/brain-provider-client-registry.js');
const {
  createCosmoBrainOperationRuntime,
} = require('../../cosmo23/server/lib/brain-operation-runtime.js');
const {
  createResearchCompileProviderAdapter,
} = require('../../cosmo23/server/lib/research-compile-provider-adapter.js');
const {
  createResearchOperationExecutors,
} = require('../../cosmo23/server/lib/research-operation-executors.js');
const {
  readPinnedIntelligence,
} = require('../../cosmo23/server/lib/research-pinned-source-reader.js');
const {
  createRequesterOutputWriter,
} = require('../../cosmo23/server/lib/research-requester-output-writer.js');
const {
  createBrainOperationRoutes,
} = require('../../cosmo23/server/lib/brain-operation-routes.js');
const {
  getModelCapabilities,
} = require('../../cosmo23/server/config/model-catalog.js');
const {
  requireCompleteProviderResult,
} = require('../../cosmo23/lib/provider-completion.js');
const {
  createMemorySourcePinProvider,
  createOperationScratchQuota,
  openMemorySource,
  readManifest,
  writeJsonlGzAtomic,
  writeManifestAtomic,
} = require('../../shared/memory-source');
const {
  createMemoryTools,
} = require('../../shared/memory-source/mcp-tools.cjs');
const {
  createMcpReadinessController,
  createSnapshotScalarStateReader,
} = require('../../shared/memory-source/mcp-http-runtime.cjs');

const CHILD_READY_TIMEOUT_MS = 30_000;
const CHILD_STOP_TIMEOUT_MS = 10_000;
const FIXTURE_HTTP_RESPONSE_MAX_BYTES = 1024 * 1024;
const FIXTURE_OWNER_MAX_BYTES = 16 * 1024;
const FIXTURE_CONFIG_MAX_BYTES = 256 * 1024;
const FIXTURE_KEY_MAX_BYTES = 1024;
const FIXTURE_READY_MAX_BYTES = 64 * 1024;
const FIXTURE_OWNER_FILE = 'fixture-owner.json';
const PRODUCTION_OPERATION_DELAY_MS = 3_000;
const CHILD_INHERITED_ENV_ALLOWLIST = Object.freeze([
  'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'TZ',
  '__CF_USER_TEXT_ENCODING',
]);
const CHILD_BINDING_ENV_KEYS = Object.freeze([
  'HOME23_ISOLATED_FIXTURE_CHILD',
  'HOME23_ISOLATED_FIXTURE_CONFIG',
  'HOME23_ISOLATED_FIXTURE_CONFIG_DEV',
  'HOME23_ISOLATED_FIXTURE_CONFIG_INO',
  'HOME23_ISOLATED_FIXTURE_CONFIG_SHA256',
  'HOME23_ISOLATED_FIXTURE_KEY_DEV',
  'HOME23_ISOLATED_FIXTURE_KEY_INO',
  'HOME23_ISOLATED_FIXTURE_KEY_SHA256',
  'HOME23_ISOLATED_FIXTURE_LAUNCHER_PID',
  'HOME23_ISOLATED_FIXTURE_OWNER_DEV',
  'HOME23_ISOLATED_FIXTURE_OWNER_INO',
  'HOME23_ISOLATED_FIXTURE_OWNER_SHA256',
  'HOME23_ISOLATED_FIXTURE_ROOT',
  'HOME23_ISOLATED_FIXTURE_ROOT_DEV',
  'HOME23_ISOLATED_FIXTURE_ROOT_INO',
  'HOME23_ISOLATED_FIXTURE_START_TOKEN',
  'NODE_PATH',
]);
const FIXTURE_OWNER_FIELDS = Object.freeze([
  'schemaVersion', 'receiptRunId', 'authority', 'implementationCommit',
  'hostname', 'receiptStartedAt', 'canonicalRoot', 'basename', 'dev', 'ino',
  'createdAt', 'provenanceSeal',
]);
const INTERNAL_ROLE = new Set(['cosmo', 'dashboard', 'mcp']);
const OWNED_CHILDREN = new WeakMap();
const FIXTURE_MUTATION_AUTHORITIES = new WeakMap();
const ISOLATED_FIXTURE_AUTHORITIES = new WeakMap();
const TEST_DELAY_SEAMS = new WeakMap();
const CONTROLLED_OPERATION_CONTEXT = new AsyncLocalStorage();
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function derivePrimaryCheckoutRoot() {
  try {
    const dotGit = path.join(REPOSITORY_ROOT, '.git');
    const dotGitStat = lstatSync(dotGit);
    if (dotGitStat.isDirectory() && !dotGitStat.isSymbolicLink()) {
      return realpathSync(REPOSITORY_ROOT);
    }
    if (!dotGitStat.isFile() || dotGitStat.isSymbolicLink() || dotGitStat.size > 4_096) {
      return null;
    }
    const pointer = readFileSync(dotGit, 'utf8').trim();
    const gitdir = /^gitdir:\s*(.+)$/.exec(pointer)?.[1];
    if (!gitdir) return null;
    const worktreeGitDir = realpathSync(path.resolve(REPOSITORY_ROOT, gitdir));
    const commonFile = path.join(worktreeGitDir, 'commondir');
    const commonStat = lstatSync(commonFile);
    if (!commonStat.isFile() || commonStat.isSymbolicLink() || commonStat.size > 4_096) {
      return null;
    }
    const commonPointer = readFileSync(commonFile, 'utf8').trim();
    if (!commonPointer) return null;
    const commonGitDir = realpathSync(path.resolve(worktreeGitDir, commonPointer));
    if (path.basename(commonGitDir) !== '.git') return null;
    const primaryRoot = realpathSync(path.dirname(commonGitDir));
    return realpathSync(path.join(primaryRoot, '.git')) === commonGitDir
      ? primaryRoot
      : null;
  } catch {
    return null;
  }
}

const PRIMARY_CHECKOUT_ROOT = derivePrimaryCheckoutRoot();
const CONTROLLED_PROVIDER = 'controlled';
const CONTROLLED_QUERY_MODEL = 'controlled-query';
const CONTROLLED_PGS_MODEL = 'controlled-pgs';
const CONTROLLED_SYNTHESIS_MODEL = 'controlled-synthesis';
const PGS_LEVEL_FRACTIONS = Object.freeze({
  skim: 0.10,
  sample: 0.25,
  deep: 0.50,
  full: 1,
});
const CONTROLLED_DELAY_ACTION_MAX = 512;
const METRIC_SEMANTICS = Object.freeze({
  v8HeapUsedBytes: 'request-time-sample',
  rssBytes: 'request-time-sample',
  processMaxRssBytes: 'process-lifetime-high-water',
});
let observedProcessMaxRssMiB = 0;

function exactKeys(value, expected) {
  return value && !Array.isArray(value) && typeof value === 'object'
    && Reflect.ownKeys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function identityDescriptor(file, stat, bytes) {
  return Object.freeze({
    path: file,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    uid: stat.uid.toString(),
    mode: Number(stat.mode & 0o777n),
    nlink: stat.nlink.toString(),
    sha256: sha256Bytes(bytes),
  });
}

function sameIdentityDescriptor(actual, expected) {
  return actual && expected
    && actual.path === expected.path
    && actual.dev === expected.dev
    && actual.ino === expected.ino
    && actual.size === expected.size
    && actual.uid === expected.uid
    && actual.mode === expected.mode
    && actual.nlink === expected.nlink
    && actual.sha256 === expected.sha256;
}

async function readIdentityFile(file, {
  maxBytes,
  errorCode,
  expected = null,
} = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1
      || typeof errorCode !== 'string' || !errorCode) {
    throw typedError(errorCode || 'isolated_fixture_identity_invalid');
  }
  let handle;
  try {
    const before = await fsp.lstat(file, { bigint: true });
    const uid = currentUid();
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
        || before.size < 1n || before.size > BigInt(maxBytes)
        || Number(before.mode & 0o777n) !== 0o600
        || (uid !== null && before.uid !== BigInt(uid))) {
      throw typedError(errorCode);
    }
    handle = await fsp.open(
      file,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink()
        || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.mtimeNs !== before.mtimeNs
        || opened.ctimeNs !== before.ctimeNs || opened.nlink !== 1n
        || Number(opened.mode & 0o777n) !== 0o600
        || (uid !== null && opened.uid !== BigInt(uid))) {
      throw typedError(errorCode);
    }
    const size = Number(opened.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(bytes, offset, size - offset, offset);
      if (bytesRead === 0) throw typedError(errorCode);
      offset += bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    const { bytesRead: overflowBytes } = await handle.read(overflowProbe, 0, 1, size);
    const after = await handle.stat({ bigint: true });
    const namedAfter = await fsp.lstat(file, { bigint: true });
    if (overflowBytes !== 0
        || after.dev !== opened.dev || after.ino !== opened.ino
        || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs
        || after.ctimeNs !== opened.ctimeNs || after.nlink !== 1n
        || namedAfter.dev !== opened.dev || namedAfter.ino !== opened.ino
        || namedAfter.size !== opened.size || namedAfter.mtimeNs !== opened.mtimeNs
        || namedAfter.ctimeNs !== opened.ctimeNs || namedAfter.nlink !== 1n
        || Number(namedAfter.mode & 0o777n) !== 0o600
        || (uid !== null && namedAfter.uid !== BigInt(uid))) {
      throw typedError(errorCode);
    }
    const binding = identityDescriptor(file, opened, bytes);
    if (expected && !sameIdentityDescriptor(binding, expected)) {
      throw typedError(errorCode);
    }
    return Object.freeze({ bytes, binding });
  } catch (error) {
    if (error?.code === errorCode) throw error;
    throw typedError(errorCode, undefined, { cause: error });
  } finally {
    await handle?.close();
  }
}

async function writeIdentityFile(file, bytes, {
  maxBytes,
  errorCode,
} = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > maxBytes) {
    throw typedError(errorCode);
  }
  let handle;
  try {
    handle = await fsp.open(
      file,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    await handle.chmod(0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (error?.code === errorCode) throw error;
    throw typedError(errorCode, undefined, { cause: error });
  } finally {
    await handle?.close();
  }
  await syncDirectory(path.dirname(file));
  return readIdentityFile(file, { maxBytes, errorCode });
}

async function writeIdentityJson(file, value, options) {
  return writeIdentityFile(file, Buffer.from(`${canonicalJson(value)}\n`, 'utf8'), options);
}

function parseIdentityJson(record, errorCode) {
  try {
    const value = JSON.parse(record.bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw typedError(errorCode);
    }
    return value;
  } catch (error) {
    if (error?.code === errorCode) throw error;
    throw typedError(errorCode, undefined, { cause: error });
  }
}

function rootIdentityDescriptor(directory) {
  return Object.freeze({
    path: directory.path,
    dev: directory.dev,
    ino: directory.ino,
  });
}

function sameRootIdentity(actual, expected) {
  return actual && expected
    && actual.path === expected.path
    && actual.dev === expected.dev
    && actual.ino === expected.ino;
}

async function assertExternalFixtureRoot(fixture, receiptRunDir) {
  await assertCanonicalDirectoryIdentity(fixture, 'isolated fixture');
  if (!PRIMARY_CHECKOUT_ROOT) {
    throw typedError('isolated_fixture_live_root_authority_unavailable');
  }
  if (isInsideOrEqual(REPOSITORY_ROOT, fixture.path)
      || isInsideOrEqual(fixture.path, REPOSITORY_ROOT)
      || isInsideOrEqual(PRIMARY_CHECKOUT_ROOT, fixture.path)
      || isInsideOrEqual(fixture.path, PRIMARY_CHECKOUT_ROOT)) {
    throw typedError('isolated_fixture_live_root_refused');
  }
  if (typeof receiptRunDir === 'string'
      && (isInsideOrEqual(receiptRunDir, fixture.path)
        || isInsideOrEqual(fixture.path, receiptRunDir))) {
    throw typedError('isolated_fixture_receipt_overlap');
  }
  const stat = await fsp.lstat(fixture.path, { bigint: true });
  const uid = currentUid();
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev.toString() !== fixture.dev || stat.ino.toString() !== fixture.ino
      || Number(stat.mode & 0o777n) !== 0o700
      || (uid !== null && stat.uid !== BigInt(uid))) {
    throw typedError('isolated_fixture_ownership_mismatch');
  }
  return fixture;
}

export function createIsolatedFixtureTestDelaySeam({ operationDelayMs } = {}) {
  if (!Number.isSafeInteger(operationDelayMs) || operationDelayMs < 0
      || operationDelayMs >= PRODUCTION_OPERATION_DELAY_MS) {
    throw typedError('isolated_fixture_test_delay_invalid');
  }
  const seam = Object.freeze({ kind: 'isolated-fixture-test-delay' });
  TEST_DELAY_SEAMS.set(seam, operationDelayMs);
  return seam;
}

function fixtureOwnerPayload(fixture, context, createdAt) {
  return {
    schemaVersion: 2,
    receiptRunId: context.receiptRunId,
    authority: context.authority,
    implementationCommit: context.implementationCommit ?? null,
    hostname: context.hostname ?? null,
    receiptStartedAt: context.startedAt ?? null,
    canonicalRoot: fixture.path,
    basename: path.basename(fixture.path),
    dev: fixture.dev,
    ino: fixture.ino,
    createdAt,
  };
}

function sealFixtureOwner(payload) {
  return `sha256:${createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex')}`;
}

export async function readBoundedFixtureJsonResponse(response, {
  maxBytes = FIXTURE_HTTP_RESPONSE_MAX_BYTES,
} = {}) {
  if (!response || !response.body || typeof response.body.getReader !== 'function'
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1
      || maxBytes > FIXTURE_HTTP_RESPONSE_MAX_BYTES) {
    throw typedError('fixture_response_invalid');
  }
  const advertised = response.headers?.get?.('content-length');
  if (advertised !== null && advertised !== undefined && advertised !== '') {
    const length = Number(advertised);
    if (!Number.isSafeInteger(length) || length < 0 || length > maxBytes) {
      await response.body.cancel().catch(() => {});
      throw typedError('fixture_response_too_large');
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw typedError('fixture_response_invalid');
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw typedError('fixture_response_too_large');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch (error) {
    if (error?.code === 'fixture_response_too_large') throw error;
    throw typedError('fixture_response_invalid', 'fixture response is not valid JSON', { cause: error });
  }
}

function boundaries(root, kind = 'resident') {
  const brainRoot = kind === 'research' ? path.join(root, 'brain') : root;
  return [
    { kind: 'brain', path: brainRoot },
    { kind: 'run', path: root },
    { kind: 'pgs', path: path.join(root, 'pgs-sessions') },
    { kind: 'session', path: path.join(root, 'sessions') },
    { kind: 'cache', path: path.join(root, 'cache') },
    { kind: 'export', path: path.join(root, 'exports') },
    { kind: 'agency', path: path.join(root, 'agency') },
  ];
}

function catalogFor(config) {
  const entry = ({
    id,
    ownerAgent,
    displayName,
    kind = 'resident',
    lifecycle = 'resident',
    canonicalRoot = config.brainDir,
    nodeCount = config.nodeCount,
    edgeCount = config.edgeCount,
  }) => ({
    id,
    displayName,
    ownerAgent,
    kind,
    lifecycle,
    canonicalRoot,
    sourceType: 'memory-manifest',
    nodeCount,
    edgeCount,
    modifiedAt: config.createdAt,
    route: `/api/brain/${id}`,
    mutationBoundaries: boundaries(canonicalRoot, kind),
  });
  return {
    catalogRevision: config.catalogRevision,
    brains: [
      entry({ id: config.brainId, ownerAgent: config.agent, displayName: config.agent }),
      entry({
        id: `${config.brainId}-sibling`,
        ownerAgent: `${config.agent}-sibling`,
        displayName: `${config.agent} sibling`,
        canonicalRoot: config.siblingBrainDir,
        nodeCount: config.siblingNodeCount,
        edgeCount: config.siblingEdgeCount,
      }),
      entry({
        id: `${config.brainId}-research-completed`,
        ownerAgent: `${config.agent}-research`,
        displayName: `${config.agent} completed research`,
        kind: 'research',
        lifecycle: 'completed',
        canonicalRoot: config.researchBrainDir,
        nodeCount: config.researchNodeCount,
        edgeCount: config.researchEdgeCount,
      }),
      entry({
        id: `${config.brainId}-unavailable`,
        ownerAgent: `${config.agent}-unavailable`,
        displayName: `${config.agent} unavailable`,
        kind: 'research',
        lifecycle: 'active',
      }),
      entry({
        id: `${config.brainId}-ambiguous-a`,
        ownerAgent: `${config.agent}-ambiguous`,
        displayName: `${config.agent} ambiguous A`,
      }),
      entry({
        id: `${config.brainId}-ambiguous-b`,
        ownerAgent: `${config.agent}-ambiguous`,
        displayName: `${config.agent} ambiguous B`,
      }),
    ],
  };
}

function controlledModel(id) {
  return {
    id,
    kind: 'chat',
    contextWindowTokens: 32 * 1024 * 1024,
    maxOutputTokens: 512,
    providerStallMs: 900_000,
    transport: 'responses',
  };
}

function controlledCatalog() {
  return {
    version: 1,
    providers: {
      [CONTROLLED_PROVIDER]: {
        label: 'Isolated controlled provider',
        executionDefaults: {
          maxOutputTokens: 512,
          contextWindowTokens: 128_000,
          providerStallMs: 900_000,
          transport: 'responses',
        },
        models: [
          controlledModel(CONTROLLED_QUERY_MODEL),
          controlledModel(CONTROLLED_PGS_MODEL),
          controlledModel(CONTROLLED_SYNTHESIS_MODEL),
        ],
      },
    },
    defaults: {},
  };
}

function resolveTarget(catalog, requesterAgent, selector = {}) {
  if (!selector || Array.isArray(selector) || typeof selector !== 'object'
      || Object.keys(selector).some((key) => !['agent', 'brainId'].includes(key))) {
    throw typedError('invalid_request');
  }
  const byAgent = selector.agent
    ? catalog.brains.filter((entry) => entry.ownerAgent === selector.agent) : [];
  const byId = selector.brainId
    ? catalog.brains.filter((entry) => entry.id === selector.brainId) : [];
  if (byAgent.length > 1 || byId.length > 1) throw typedError('target_ambiguous');
  if (byAgent[0] && byId[0] && byAgent[0].id !== byId[0].id) {
    throw typedError('target_mismatch');
  }
  if ((selector.agent !== undefined && byAgent.length === 0)
      || (selector.brainId !== undefined && byId.length === 0)) {
    throw typedError('target_not_found');
  }
  const target = byAgent[0] || byId[0]
    || catalog.brains.find((entry) => entry.ownerAgent === requesterAgent);
  if (!target) throw typedError('target_not_found');
  if (!['resident', 'completed'].includes(target.lifecycle)) throw typedError('target_not_available');
  return target;
}

async function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fsp.rename(temporary, file);
}

export function createSerializedMetricPublisher({
  publish,
  intervalMs = 50,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  onError = () => {},
}) {
  let stopped = false;
  let queued = false;
  let activeWrite = null;

  const drain = async () => {
    while (queued && !stopped) {
      queued = false;
      try {
        await publish();
      } catch (error) {
        try {
          onError(error);
        } catch {
          // Metric publication is best-effort and must not crash fixture children.
        }
      }
    }
  };

  const beginDrain = () => {
    const current = drain();
    activeWrite = current;
    current.finally(() => {
      if (activeWrite !== current) return;
      activeWrite = null;
      if (queued && !stopped) beginDrain();
    });
    return current;
  };

  const request = () => {
    if (stopped) return activeWrite || Promise.resolve();
    queued = true;
    return activeWrite || beginDrain();
  };

  const timer = setIntervalImpl(() => {
    request();
  }, intervalMs);
  timer?.unref?.();

  const stop = async () => {
    if (!stopped) {
      stopped = true;
      queued = false;
      clearIntervalImpl(timer);
    }
    const current = activeWrite;
    if (current) await current;
  };

  return Object.freeze({ request, stop });
}

async function writeMetrics(file, role, restartCount = 0, telemetry = {}) {
  const memory = process.memoryUsage();
  const rssMiB = memory.rss / (1024 * 1024);
  const resourceMaxRssMiB = process.resourceUsage().maxRSS / 1024;
  observedProcessMaxRssMiB = Math.max(
    observedProcessMaxRssMiB,
    rssMiB,
    resourceMaxRssMiB,
  );
  await writeJsonAtomic(file, {
    schemaVersion: 2,
    role,
    pid: process.pid,
    restartCount,
    v8HeapUsedMiB: memory.heapUsed / (1024 * 1024),
    rssMiB,
    processMaxRssMiB: observedProcessMaxRssMiB,
    semantics: METRIC_SEMANTICS,
    providerStarts: telemetry.providerStarts ?? 0,
    providerCompletions: telemetry.providerCompletions ?? 0,
    providerAborts: telemetry.providerAborts ?? 0,
    synthesisStarts: telemetry.synthesisStarts ?? 0,
    coordinatorRestarts: telemetry.coordinatorRestarts ?? 0,
    updatedAt: new Date().toISOString(),
  });
}

export function waitForControlledDelay(ms, signal, telemetry, {
  nowNs = () => process.hrtime.bigint(),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!Number.isSafeInteger(ms) || ms < 0
      || !telemetry || !Number.isSafeInteger(telemetry.providerAborts)
      || telemetry.providerAborts < 0
      || typeof nowNs !== 'function'
      || typeof setTimeoutImpl !== 'function'
      || typeof clearTimeoutImpl !== 'function') {
    throw typedError('isolated_fixture_delay_invalid');
  }
  const startedNs = nowNs();
  if (typeof startedNs !== 'bigint' || startedNs < 0n) {
    throw typedError('isolated_fixture_delay_clock_invalid');
  }
  const targetNs = startedNs + (BigInt(ms) * 1_000_000n);
  return new Promise((resolve, reject) => {
    let timer = null;
    let settled = false;
    let aborted = null;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) {
        clearTimeoutImpl(timer);
        timer = null;
      }
      if (aborted) signal?.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    };
    if (signal?.aborted) {
      telemetry.providerAborts += 1;
      finish(signal.reason);
      return;
    }
    aborted = () => {
      telemetry.providerAborts += 1;
      finish(signal.reason);
    };
    const schedule = (delay) => {
      timer = setTimeoutImpl(onTimer, delay);
    };
    const onTimer = () => {
      timer = null;
      let currentNs;
      try {
        currentNs = nowNs();
      } catch (error) {
        finish(typedError('isolated_fixture_delay_clock_invalid', undefined, { cause: error }));
        return;
      }
      if (typeof currentNs !== 'bigint' || currentNs < startedNs) {
        finish(typedError('isolated_fixture_delay_clock_invalid'));
        return;
      }
      const remainingNs = targetNs - currentNs;
      if (remainingNs <= 0n) {
        finish();
        return;
      }
      const remainingMs = Number((remainingNs + 999_999n) / 1_000_000n);
      schedule(Math.max(1, remainingMs));
    };
    signal?.addEventListener('abort', aborted, { once: true });
    try {
      schedule(ms);
    } catch (error) {
      finish(error);
    }
  });
}

function controlledProviderActionIdentity(model, options = {}) {
  const instructions = String(options.instructions || '');
  const input = String(options.input || '');
  if (model === CONTROLLED_SYNTHESIS_MODEL) {
    return { phase: 'synthesis', providerCallId: 'synthesis' };
  }
  if (model === CONTROLLED_PGS_MODEL) {
    if (/Synthesize the pinned PGS findings/.test(instructions)) {
      return { phase: 'pgs_synthesis', providerCallId: 'pgs:synthesis' };
    }
    const workUnitId = /Pinned work unit ([^:\n]+)/.exec(input)?.[1];
    if (!workUnitId || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,251}$/.test(workUnitId)) {
      throw typedError('isolated_fixture_provider_identity_invalid');
    }
    return { phase: 'pgs_sweep', providerCallId: `pgs:${workUnitId}` };
  }
  if (/Compile the supplied pinned Home23 research evidence/.test(instructions)) {
    return { phase: 'research_compile', providerCallId: 'research_compile' };
  }
  if (/The first answer did not satisfy the selected long-answer contract\./.test(instructions)) {
    return { phase: 'query', providerCallId: 'query-expand' };
  }
  return { phase: 'query', providerCallId: 'query' };
}

function controlledOperationId() {
  const operationId = CONTROLLED_OPERATION_CONTEXT.getStore()?.operationId;
  if (typeof operationId !== 'string' || !/^brop_[A-Za-z0-9_-]{32}$/.test(operationId)) {
    throw typedError('isolated_fixture_provider_identity_invalid');
  }
  return operationId;
}

function operationIdFromScratchDirectory(scratchDir) {
  if (typeof scratchDir !== 'string' || !path.isAbsolute(scratchDir)
      || path.basename(scratchDir) !== 'scratch') {
    throw typedError('isolated_fixture_provider_identity_invalid');
  }
  const operationId = path.basename(path.dirname(scratchDir));
  if (!/^brop_[A-Za-z0-9_-]{32}$/.test(operationId)) {
    throw typedError('isolated_fixture_provider_identity_invalid');
  }
  return operationId;
}

function controlledProviderClient(config, telemetry, model) {
  return Object.freeze({
    providerId: CONTROLLED_PROVIDER,
    async generate(options = {}) {
      telemetry.providerStarts += 1;
      telemetry.models[model] = (telemetry.models[model] || 0) + 1;
      telemetry.lastProviderStartedAt = new Date().toISOString();
      const delayStartedAt = telemetry.lastProviderStartedAt;
      const delayStartedNs = process.hrtime.bigint();
      const requestedDelay = config.operationDelayMs;
      const actionIdentity = controlledProviderActionIdentity(model, options);
      const operationId = controlledOperationId();
      if (telemetry.providerDelayActions.length >= CONTROLLED_DELAY_ACTION_MAX) {
        throw typedError('isolated_fixture_provider_action_limit');
      }
      telemetry.providerDelayStarts += 1;
      const delayAction = {
        operationId,
        ...actionIdentity,
        provider: CONTROLLED_PROVIDER,
        model,
        configuredDelayMs: config.configuredOperationDelayMs,
        effectiveDelayMs: requestedDelay,
        testOnlyDelay: config.testOnlyDelay,
        startedAt: delayStartedAt,
        completedAt: null,
        elapsedMs: null,
        actionProven: false,
        outcome: 'running',
      };
      telemetry.providerDelayActions.push(delayAction);
      telemetry.lastProviderDelay = { ...delayAction };
      options.onProviderActivity?.({
        type: 'controlled_provider_started',
        at: telemetry.lastProviderStartedAt,
        configuredDelayMs: config.configuredOperationDelayMs,
        effectiveDelayMs: requestedDelay,
        testOnlyDelay: config.testOnlyDelay,
      });
      try {
        await waitForControlledDelay(requestedDelay, options.signal, telemetry);
      } catch (error) {
        const completedAt = new Date().toISOString();
        Object.assign(delayAction, {
          completedAt,
          elapsedMs: Number(process.hrtime.bigint() - delayStartedNs) / 1_000_000,
          outcome: 'aborted',
        });
        telemetry.lastProviderDelay = { ...delayAction };
        throw error;
      }
      const delayCompletedAt = new Date().toISOString();
      const elapsedMs = Number(process.hrtime.bigint() - delayStartedNs) / 1_000_000;
      telemetry.providerDelayCompletions += 1;
      Object.assign(delayAction, {
        completedAt: delayCompletedAt,
        elapsedMs,
        actionProven: elapsedMs >= requestedDelay,
        outcome: 'complete',
      });
      telemetry.lastProviderDelay = { ...delayAction };
      options.onProviderActivity?.({
        type: 'controlled_provider_progress',
        at: delayCompletedAt,
        configuredDelayMs: config.configuredOperationDelayMs,
        effectiveDelayMs: requestedDelay,
        elapsedMs,
        delayActionProven: elapsedMs >= requestedDelay,
        testOnlyDelay: config.testOnlyDelay,
      });
      let content;
      let finishReason = 'completed';
      if (model === CONTROLLED_SYNTHESIS_MODEL) {
        telemetry.synthesisStarts += 1;
        content = JSON.stringify({
          selfUnderstanding: {
            summary: 'The isolated brain contains an authoritative generated canary.',
            currentObsessions: ['authoritative isolated canary'],
            relationship: 'This controlled brain belongs to its isolated requester.',
          },
          consolidatedInsights: [{
            title: 'Pinned canary retained',
            excerpt: 'The production synthesis worker read the pinned generated source.',
            source: 'isolated fixture',
            themes: ['canary'],
          }],
          recentActivity: ['Production synthesis completed through the controlled boundary.'],
        });
      } else if (model === CONTROLLED_PGS_MODEL
          && /Synthesize the pinned PGS findings/.test(String(options.instructions || ''))
          && config.pgsSynthesisIncomplete === true) {
        content = 'controlled PGS synthesis intentionally incomplete';
        finishReason = 'length';
      } else if (model === CONTROLLED_PGS_MODEL) {
        const workUnit = /Pinned work unit ([^:\n]+)/.exec(String(options.input || ''))?.[1]
          || 'unknown-work-unit';
        content = `controlled pinned finding for ${workUnit}`;
      } else {
        content = 'controlled durable query result from the production pinned query executor';
      }
      telemetry.providerCompletions += 1;
      return {
        content,
        terminalReceived: true,
        finishReason,
        hadError: false,
        provider: CONTROLLED_PROVIDER,
        model,
      };
    },
  });
}

function createControlledRegistry(config, telemetry) {
  return createBrainProviderClientRegistry({
    catalog: controlledCatalog(),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    pairFactories: {
      [CONTROLLED_PROVIDER]: ({ model }) => controlledProviderClient(config, telemetry, model),
    },
  });
}

function freshTelemetry() {
  return {
    providerStarts: 0,
    providerCompletions: 0,
    providerAborts: 0,
    providerDelayStarts: 0,
    providerDelayCompletions: 0,
    providerDelayActions: [],
    lastProviderDelay: null,
    synthesisStarts: 0,
    models: {},
    coordinatorRestarts: 0,
    lastProviderStartedAt: null,
  };
}

function childReadyPayload(config, role, port) {
  return {
    schemaVersion: 2,
    role,
    pid: process.pid,
    launcherPid: config.launcherPid,
    port,
    startToken: config.startToken,
    metricsPath: config.metricsFile,
    fixtureRootIdentity: config.fixtureRootIdentity,
    configIdentity: config.configIdentity,
    capabilityKeyIdentity: config.capabilityKeyIdentity,
    fixtureOwnerIdentity: config.fixtureOwnerIdentity,
    receiptProvenance: config.receiptProvenance,
    configuredOperationDelayMs: config.configuredOperationDelayMs,
    effectiveOperationDelayMs: config.operationDelayMs,
    testOnlyDelay: config.testOnlyDelay,
    environmentKeys: Object.keys(process.env).sort(),
  };
}

async function publishChildReady(config, role, port) {
  await writeIdentityJson(config.readyFile, childReadyPayload(config, role, port), {
    maxBytes: FIXTURE_READY_MAX_BYTES,
    errorCode: 'isolated_child_ready_invalid',
  });
}

function unavailableResearchProcessManager() {
  const unavailable = async () => { throw typedError('fixture_research_process_unavailable'); };
  return Object.freeze({
    createOwnedRun: unavailable,
    start: unavailable,
    continue: unavailable,
    stopAndWait: unavailable,
    watch: unavailable,
  });
}

async function runCosmoChild(config) {
  const { QueryEngine } = require('../../cosmo23/lib/query-engine.js');
  const telemetry = freshTelemetry();
  const modelCatalog = controlledCatalog();
  const providerRegistry = createControlledRegistry(config, telemetry);
  const queryEngine = new QueryEngine({
    operationMode: true,
    providerRegistry,
    modelCatalog,
  });
  const executeEnhancedQuery = queryEngine.executeEnhancedQuery.bind(queryEngine);
  queryEngine.executeEnhancedQuery = async (query, options = {}) => {
    options.reportEvent?.({
      type: 'progress',
      phase: options.enablePGS === true ? 'pgs' : 'query',
      message: 'Controlled fixture entered the production pinned query executor',
    });
    const operationId = operationIdFromScratchDirectory(options.scratchDir);
    return CONTROLLED_OPERATION_CONTEXT.run(
      Object.freeze({ operationId }),
      () => executeEnhancedQuery(query, options),
    );
  };
  const compileSectionWithProvider = createResearchCompileProviderAdapter({
    resolveConfiguredPair: async () => ({
      provider: CONTROLLED_PROVIDER,
      model: CONTROLLED_QUERY_MODEL,
    }),
    getExactProviderClient: (provider, model) => providerRegistry.getExact(provider, model),
    requireCompleteProviderResult,
    getModelCapabilities: (provider, model) => getModelCapabilities(
      modelCatalog,
      provider,
      model,
    ),
  });
  const researchExecutors = createResearchOperationExecutors({
    processManager: unavailableResearchProcessManager(),
    resolveOwnedRun: async () => null,
    readPinnedIntelligence,
    createRequesterOutputWriter: (request) => createRequesterOutputWriter({
      home23Root: config.fixtureRoot,
      ...request,
    }),
    compileSectionWithProvider,
  });
  const extraExecutors = new Map([
    ['research_compile', researchExecutors.get('research_compile')],
    ['research_intelligence', researchExecutors.get('research_intelligence')],
  ]);
  const catalog = catalogFor(config);
  const runtime = createCosmoBrainOperationRuntime({
    home23Root: config.fixtureRoot,
    capabilityKey: config.capabilityKey,
    buildCatalog: async () => catalog,
    resolveCanonicalTarget: resolveTarget,
    modelCatalog,
    providerRegistry,
    queryEngine,
    extraExecutors,
  });
  const app = express();
  app.get('/health', (_request, response) => response.json({
    ok: true, role: 'cosmo', pid: process.pid,
  }));
  app.get('/telemetry', (_request, response) => response.json({ ...telemetry, pid: process.pid }));
  app.get('/fixture/operations/:operationId', (request, response) => {
    const record = runtime.worker.records.get(request.params.operationId);
    if (!record) return response.status(404).json({ error: { code: 'worker_not_found' } });
    return response.json({
      operationId: record.operationId,
      operationType: record.operationType,
      state: record.state,
      phase: record.phase,
      eventSequence: record.eventSequence,
      events: structuredClone(record.events),
    });
  });
  app.use(createBrainOperationRoutes({ worker: runtime.worker }));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw typedError('fixture_listener_failed');
  await writeMetrics(config.metricsFile, 'cosmo', 0, telemetry);
  const metrics = createSerializedMetricPublisher({
    publish: () => writeMetrics(config.metricsFile, 'cosmo', 0, telemetry),
  });
  const shutdown = async () => {
    await metrics.stop();
    await runtime.worker.stop().catch(() => {});
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await publishChildReady(config, 'cosmo', address.port);
}

async function runMcpChild(config) {
  const catalog = catalogFor(config);
  const readScalarState = createSnapshotScalarStateReader({ brainDir: config.brainDir });
  const memoryTools = createMemoryTools({
    brainDir: config.brainDir,
    home23Root: config.fixtureRoot,
    requesterAgent: config.agent,
    readScalarState,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    resolveTargetContext: async () => Object.freeze({
      catalogRevision: catalog.catalogRevision,
      accessMode: 'own',
      target: Object.freeze(resolveTarget(catalog, config.agent, {})),
    }),
  });
  const readiness = createMcpReadinessController({
    memoryTools,
    retryMs: 50,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await readiness.refresh();
  const server = startMcpHttpServer({
    port: 0,
    host: '127.0.0.1',
    log: false,
    memoryTools,
    readScalarState,
    readRecentThoughts: async () => [],
    readiness,
  });
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw typedError('fixture_listener_failed');
  await writeMetrics(config.metricsFile, 'mcp');
  const metrics = createSerializedMetricPublisher({
    publish: () => writeMetrics(config.metricsFile, 'mcp', 0),
  });
  const shutdown = async () => {
    await metrics.stop();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await publishChildReady(config, 'mcp', address.port);
}

async function runDashboardChild(config) {
  const telemetry = freshTelemetry();
  const catalog = catalogFor(config);
  const modelCatalog = controlledCatalog();
  const providerRegistry = createControlledRegistry(config, telemetry);
  const operationsRoot = config.operationsRoot;
  const remoteWorker = createCosmoBrainOperationWorkerClient({
    baseUrl: config.cosmoBaseUrl,
    sourceOperationTypes: ['query', 'pgs', 'research_compile', 'research_intelligence'],
  });
  const worker = new BrainOperationWorkerAdapter({
    remoteWorker,
    supportsSourceOperations: true,
    sourceOperationTypes: [
      'search', 'status', 'graph', 'graph_export', 'query', 'pgs', 'synthesis',
      'research_compile', 'research_intelligence',
    ],
  });
  const brainSourceService = createBrainSourceService({
    brainDir: config.brainDir,
    home23Root: config.fixtureRoot,
    requesterAgent: config.agent,
    resolveTargetContext: async () => coordinator.resolveTargetContext({}),
  });
  const searchService = createMemorySearchService({
    brainDir: config.brainDir,
    home23Root: config.fixtureRoot,
    requesterAgent: config.agent,
    resolveTargetContext: async () => coordinator.resolveTargetContext({}),
    embedQuery: async (query) => /authoritative isolated/i.test(String(query || ''))
      ? [1, 0]
      : [0, 1],
    loadAnn: async () => null,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  for (const [operationType, executor] of createSourceOperationExecutors({
    searchService,
    brainSourceService,
    graphExportExecutor: async () => { throw typedError('executor_unavailable'); },
  })) worker.registerLocalExecutor(operationType, executor);

  let coordinator = null;
  let active = null;
  const settingsStore = {
    async read() {
      return {
        version: 'fixture-v1',
        data: {
          synthesis: {
            provider: CONTROLLED_PROVIDER,
            model: CONTROLLED_SYNTHESIS_MODEL,
            intervalHours: 4,
          },
        },
      };
    },
    async update() { throw typedError('settings_changed'); },
  };
  const synthesisRuntime = createDashboardSynthesisOperationRuntime({
    brainDir: config.brainDir,
    workspacePath: config.workspacePath,
    homeConfig: {
      synthesis: {
        provider: CONTROLLED_PROVIDER,
        model: CONTROLLED_SYNTHESIS_MODEL,
        intervalHours: 4,
      },
    },
    catalog: modelCatalog,
    providerRegistry,
    settingsStore,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    startOperation: ({ trigger }) => coordinator.start({
      requestId: `fixture-synthesis-${Date.now()}-${randomUUID()}`,
      operationType: 'synthesis',
      target: undefined,
      parameters: { trigger },
    }),
  });
  await synthesisRuntime.settled;
  worker.registerLocalExecutor('synthesis', (context) => {
    const operationId = context?.operationId;
    if (typeof operationId !== 'string' || !/^brop_[A-Za-z0-9_-]{32}$/.test(operationId)) {
      throw typedError('isolated_fixture_provider_identity_invalid');
    }
    return CONTROLLED_OPERATION_CONTEXT.run(
      Object.freeze({ operationId }),
      () => synthesisRuntime.executor(context),
    );
  });

  async function buildCoordinator() {
    const store = new BrainOperationStore({ root: operationsRoot, requesterAgent: config.agent });
    const reader = createBrainOperationStoreReader({
      operationsRoot, expectedRequester: config.agent, liveStore: store,
    });
    const exporter = createBrainOperationExporter({
      home23Root: config.fixtureRoot, requesterAgent: config.agent, reader,
    });
    const productionSourcePins = createMemorySourcePinProvider({
      home23Root: config.fixtureRoot,
      requesterAgent: config.agent,
    });
    const sourcePins = Object.freeze({
      pin: productionSourcePins.pin,
      releaseOperationPins: productionSourcePins.releaseOperationPins,
      async openPinnedSource(descriptor, expectations) {
        const exactOperationRoot = await fsp.realpath(expectations.operationRoot);
        if (expectations.scratchQuota?.operationRoot !== exactOperationRoot) {
          throw typedError('fixture_scratch_quota_root_mismatch', JSON.stringify({
            expected: exactOperationRoot,
            actual: expectations.scratchQuota?.operationRoot ?? null,
          }));
        }
        try {
          return await productionSourcePins.openPinnedSource(descriptor, expectations);
        } catch (error) {
          if (error?.message === 'scratch quota for exact operation root required') {
            const derived = path.join(
              config.fixtureRoot, 'instances', config.agent, 'runtime',
              'brain-operations', expectations.operationId,
            );
            throw typedError(error.code || 'invalid_request', JSON.stringify({
              providerOperationRoot: derived,
              providerOperationRootRealpath: await fsp.realpath(derived).catch(() => null),
              expectedOperationRoot: exactOperationRoot,
              scratchQuotaOperationRoot: expectations.scratchQuota?.operationRoot ?? null,
            }));
          }
          throw error;
        }
      },
    });
    const next = new BrainOperationCoordinator({
      requesterAgent: config.agent,
      store,
      buildCanonicalCatalog: async () => catalog,
      resolveCanonicalTarget: resolveTarget,
      operationAuthority: OPERATION_AUTHORITY,
      authorizeBrainOperation,
      worker,
      sourcePins,
      scratchQuotaFactory: createOperationScratchQuota,
      operationModelResolver: async ({ operationType, requestParameters }) => {
        if (operationType === 'synthesis') {
          return synthesisRuntime.resolveParameters({ operationType, requestParameters });
        }
        if (operationType === 'query') {
          return {
            ...requestParameters,
            modelSelection: requestParameters.modelSelection || {
              provider: CONTROLLED_PROVIDER,
              model: CONTROLLED_QUERY_MODEL,
            },
          };
        }
        if (operationType === 'pgs') {
          const sweepFraction = PGS_LEVEL_FRACTIONS[requestParameters.pgsLevel || 'full'];
          if (sweepFraction === undefined) {
            throw typedError('invalid_request', 'pgsLevel is invalid');
          }
          return {
            ...requestParameters,
            pgsConfig: { sweepFraction },
            pgsSweep: requestParameters.pgsSweep || {
              provider: CONTROLLED_PROVIDER,
              model: CONTROLLED_PGS_MODEL,
            },
            pgsSynth: requestParameters.pgsSynth || {
              provider: CONTROLLED_PROVIDER,
              model: CONTROLLED_PGS_MODEL,
            },
          };
        }
        return requestParameters;
      },
      capabilityKey: config.capabilityKey,
      exporter,
      readSynthesisState: synthesisRuntime.readState,
      limits: { stopTimeoutMs: 5_000 },
    });
    await next.reconcile();
    const compatibilityRouter = express.Router();
    registerSynthesisCompatibilityRoutes({
      app: compatibilityRouter,
      requesterAgent: config.agent,
      synthesisRuntime,
      coordinator: next,
      store,
    });
    return {
      coordinator: next,
      store,
      reader,
      exporter,
      compatibilityRouter,
      router: createBrainOperationsRouter({
        requesterAgent: config.agent,
        coordinator: next,
        reader,
        exporter,
        buildCatalog: async () => catalog,
        providerReadiness: () => ({
          ready: true, status: 'ready', code: null, retryable: false, migrated: false,
        }),
      }).router,
    };
  }

  active = await buildCoordinator();
  coordinator = active.coordinator;
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use(createMcpProxyRouter({
    port: config.mcpPort,
    isEnabled: () => true,
    probeAvailability: probeMcpAvailability,
    buildUnavailableEnvelope: buildMcpUnavailableEnvelope,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  }));
  app.get('/health', (_request, response) => response.json({
    ok: true, role: 'dashboard', pid: process.pid,
  }));
  app.get('/telemetry', (_request, response) => response.json({ ...telemetry, pid: process.pid }));
  app.post('/fixture/restart-coordinator', async (_request, response) => {
    try {
      const previous = active;
      await previous.coordinator.stop();
      active = await buildCoordinator();
      coordinator = active.coordinator;
      telemetry.coordinatorRestarts += 1;
      response.json({ ok: true, coordinatorRestarts: telemetry.coordinatorRestarts });
    } catch (error) {
      response.status(500).json({ error: { code: error.code || 'fixture_restart_failed' } });
    }
  });
  app.use((request, response, next) =>
    active.compatibilityRouter(request, response, next));
  app.use('/home23/api/brain-operations', (request, response, next) =>
    active.router(request, response, next));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw typedError('fixture_listener_failed');
  await writeMetrics(config.metricsFile, 'dashboard', 0, telemetry);
  const metrics = createSerializedMetricPublisher({
    publish: () => writeMetrics(
      config.metricsFile, 'dashboard', telemetry.coordinatorRestarts, telemetry,
    ),
  });
  const shutdown = async () => {
    await metrics.stop();
    await active.coordinator.stop().catch(() => {});
    await worker.stop().catch(() => {});
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await publishChildReady(config, 'dashboard', address.port);
}

async function* generatedRecords(count, create) {
  for (let index = 0; index < count; index += 1) {
    yield create(index);
    if (index > 0 && index % 10_000 === 0) await new Promise((resolve) => setImmediate(resolve));
  }
}

async function writeGzipJsonl(file, count, create) {
  const existing = await fsp.lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) throw typedError('isolated_fixture_source_incomplete');
  const written = await writeJsonlGzAtomic(file, generatedRecords(count, create), { level: 1 });
  if (written.count !== count) throw typedError('isolated_fixture_source_mismatch');
  return hashFile(file);
}

function initialSynthesisState() {
  const state = {
    generatedAt: '2026-07-10T00:00:00.000Z',
    generationMarker: `generation-1-${'0'.repeat(24)}`,
    operationId: `brop_${'0'.repeat(32)}`,
    trigger: 'fixture-bootstrap',
    sourceRevision: 1,
    provider: CONTROLLED_PROVIDER,
    model: CONTROLLED_SYNTHESIS_MODEL,
    durationMs: 0,
    brainStats: { nodes: 0, edges: 0, clusters: 0, documentsCompiled: 0 },
    selfUnderstanding: {
      summary: 'Initial isolated fixture state.', currentObsessions: [], relationship: '',
    },
    consolidatedInsights: [],
    knowledgeIndex: '',
    recentActivity: [],
  };
  return {
    ...state,
    brainStateSha256: `sha256:${createHash('sha256').update(canonicalJson(state)).digest('hex')}`,
  };
}

async function writeFixtureFile(file, value) {
  try {
    await fsp.writeFile(file, value, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}

async function prepareSyntheticSource(
  mutationAuthority,
  fixtureRoot,
  agent,
  nodeCount,
  edgeCount,
  options = {},
) {
  const brainDir = options.brainDir
    || path.join(fixtureRoot, 'instances', agent, 'brain');
  const workspacePath = options.workspacePath
    || path.join(fixtureRoot, 'instances', agent, 'workspace');
  const generation = options.generation || 'isolated-g1';
  const canaryConcept = options.canaryConcept
    || 'authoritative isolated own canary production pinned source';
  await ensureOwnedFixtureDirectory(mutationAuthority, brainDir);
  await ensureOwnedFixtureDirectory(mutationAuthority, workspacePath);
  const nodesFile = path.join(brainDir, 'memory-nodes.base-1.jsonl.gz');
  const edgesFile = path.join(brainDir, 'memory-edges.base-1.jsonl.gz');
  const deltaFile = path.join(brainDir, 'memory-delta.e1.jsonl');
  const snapshotFile = path.join(brainDir, 'brain-snapshot.json');
  const stateFile = path.join(brainDir, 'brain-state.json');
  let nodesHash;
  let edgesHash;
  const existingManifest = await readManifest(brainDir);
  if (existingManifest) {
    if (existingManifest.summary.nodeCount !== nodeCount
        || existingManifest.summary.edgeCount !== edgeCount
        || existingManifest.generation !== generation
        || existingManifest.currentRevision !== 1) {
      throw typedError('isolated_fixture_source_mismatch');
    }
    [nodesHash, edgesHash] = await Promise.all([hashFile(nodesFile), hashFile(edgesFile)]);
  } else {
    [nodesHash, edgesHash] = await Promise.all([
      writeGzipJsonl(nodesFile, nodeCount, (index) => ({
        id: index + 1,
        concept: index === 0
          ? canaryConcept
          : `isolated generated evidence node ${index + 1}`,
        tag: index === 0 ? 'canary' : 'generated',
        cluster: Math.floor(index / 250),
        clusterId: `cluster-${Math.floor(index / 250)}`,
        embedding: [1, 0],
      })),
      writeGzipJsonl(edgesFile, edgeCount, (index) => ({
        source: (index % nodeCount) + 1,
        target: ((index + 1) % nodeCount) + 1,
        weight: 0.5,
        type: 'associative',
      })),
    ]);
    await fsp.writeFile(deltaFile, '', { mode: 0o600, flag: 'wx' });
    await writeManifestAtomic(brainDir, {
      formatVersion: 1,
      generation,
      baseRevision: 1,
      currentRevision: 1,
      activeDeltaEpoch: 'e1',
      activeBase: {
        nodes: {
          file: path.basename(nodesFile), count: nodeCount, bytes: nodesHash.physicalSize,
        },
        edges: {
          file: path.basename(edgesFile), count: edgeCount, bytes: edgesHash.physicalSize,
        },
      },
      activeDelta: {
        epoch: 'e1', file: path.basename(deltaFile),
        fromRevision: 2, toRevision: 1, count: 0, committedBytes: 0,
      },
      ann: { indexFile: null, metaFile: null, builtFromRevision: 1 },
      summary: {
        nodeCount,
        edgeCount,
        clusterCount: Math.ceil(nodeCount / 250),
      },
    });
  }
  await writeFixtureFile(snapshotFile, `${JSON.stringify({
    nodeCount, edgeCount, currentRevision: 1, generation,
    savedAt: '2026-07-10T00:00:00.000Z',
  })}\n`);
  await writeFixtureFile(stateFile, `${canonicalJson(initialSynthesisState())}\n`);
  await Promise.all([
    writeFixtureFile(path.join(workspacePath, 'SOUL.md'), '# Isolated Fixture\nProduction canary identity.\n'),
    writeFixtureFile(path.join(workspacePath, 'MISSION.md'), '# Mission\nProve pinned brain operations.\n'),
    writeFixtureFile(path.join(workspacePath, 'BRAIN_INDEX.md'), '# authoritative isolated canary\n'),
  ]);
  const manifestHash = await hashFile(path.join(brainDir, 'memory-manifest.json'));
  return {
    brainDir, workspacePath, nodesFile, edgesFile, deltaFile, stateFile,
    nodesBytes: nodesHash.physicalSize, edgesBytes: edgesHash.physicalSize,
    sourceHashes: {
      manifest: manifestHash.sha256,
      nodes: nodesHash.sha256,
      edges: edgesHash.sha256,
    },
  };
}

async function discoverPreparedCanary(source, brainId) {
  const opened = await openMemorySource(source.brainDir);
  let iterator = null;
  try {
    const evidence = opened.getEvidence();
    iterator = opened.iterateNodes()[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done || first.value?.id === undefined
        || typeof first.value?.concept !== 'string'
        || evidence.sourceHealth !== 'healthy'
        || !Number.isSafeInteger(opened.revision)) {
      throw typedError('isolated_fixture_canary_unavailable');
    }
    const tokens = first.value.concept.trim().split(/\s+/)
      .filter((token) => token.length >= 5 && token.length <= 64);
    const query = tokens.slice(0, 4).join(' ');
    if (!query) throw typedError('isolated_fixture_canary_unavailable');
    return Object.freeze({
      query,
      nodeId: String(first.value.id),
      sourceRevision: opened.revision,
      sourceHealth: 'healthy',
      selectedBrain: brainId,
      discoveryRoute: 'production-memory-source-reader',
    });
  } finally {
    await iterator?.return?.();
    await opened.close();
  }
}

async function waitReady(file, child, timeoutMs = CHILD_READY_TIMEOUT_MS) {
  const ownership = OWNED_CHILDREN.get(child);
  if (!ownership) throw typedError('isolated_child_not_owned');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw typedError('isolated_child_exited', `${path.basename(file)} exited ${child.exitCode}`);
    }
    try {
      const record = await readIdentityFile(file, {
        maxBytes: FIXTURE_READY_MAX_BYTES,
        errorCode: 'isolated_child_ready_invalid',
      });
      const ready = parseIdentityJson(record, 'isolated_child_ready_invalid');
      if (ready.pid !== child.pid || ready.role !== ownership.role
          || ready.startToken !== ownership.startToken
          || ready.launcherPid !== process.pid
          || !Number.isSafeInteger(ready.port) || ready.port < 1
          || !sameRootIdentity(ready.fixtureRootIdentity, ownership.fixtureRootIdentity)
          || !sameIdentityDescriptor(ready.configIdentity, ownership.configBinding)
          || !sameIdentityDescriptor(ready.capabilityKeyIdentity, ownership.capabilityKeyBinding)
          || !sameIdentityDescriptor(ready.fixtureOwnerIdentity, ownership.fixtureOwnerBinding)
          || canonicalJson(ready.receiptProvenance) !== canonicalJson(ownership.receiptProvenance)
          || ready.configuredOperationDelayMs !== ownership.configuredOperationDelayMs
          || ready.effectiveOperationDelayMs !== ownership.effectiveOperationDelayMs
          || ready.testOnlyDelay !== ownership.testOnlyDelay
          || canonicalJson(ready.environmentKeys) !== canonicalJson(ownership.environmentKeys)) {
        throw typedError('isolated_child_identity_mismatch');
      }
      ownership.readyBinding = record.binding;
      ownership.readyPayload = Object.freeze(ready);
      return ready;
    } catch (error) {
      if (error?.code !== 'isolated_child_ready_invalid') throw error;
    }
    await sleep(25);
  }
  throw typedError('isolated_child_ready_timeout');
}

function knownDependencyPaths() {
  const nodePaths = [
    path.join(REPOSITORY_ROOT, 'node_modules'),
    path.join(REPOSITORY_ROOT, 'cosmo23', 'node_modules'),
  ];
  const dotGit = path.join(REPOSITORY_ROOT, '.git');
  try {
    const pointer = readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (match) {
      const gitDirectory = path.resolve(REPOSITORY_ROOT, match[1]);
      const checkoutRoot = path.dirname(path.resolve(gitDirectory, '../..'));
      nodePaths.push(
        path.join(checkoutRoot, 'node_modules'),
        path.join(checkoutRoot, 'cosmo23', 'node_modules'),
      );
    }
  } catch { /* normal checkout has a .git directory */ }
  return [...new Set(nodePaths
    .filter((entry) => entry && existsSync(entry))
    .map((entry) => path.resolve(entry)))];
}

function createChildEnvironment(config, configBinding) {
  const childEnv = Object.create(null);
  for (const key of CHILD_INHERITED_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length <= 32_768) childEnv[key] = value;
  }
  const dependencies = knownDependencyPaths();
  if (dependencies.length === 0) throw typedError('isolated_child_dependencies_unavailable');
  Object.assign(childEnv, {
    HOME23_ISOLATED_FIXTURE_CHILD: '1',
    HOME23_ISOLATED_FIXTURE_CONFIG: configBinding.path,
    HOME23_ISOLATED_FIXTURE_CONFIG_DEV: configBinding.dev,
    HOME23_ISOLATED_FIXTURE_CONFIG_INO: configBinding.ino,
    HOME23_ISOLATED_FIXTURE_CONFIG_SHA256: configBinding.sha256,
    HOME23_ISOLATED_FIXTURE_KEY_DEV: config.capabilityKeyIdentity.dev,
    HOME23_ISOLATED_FIXTURE_KEY_INO: config.capabilityKeyIdentity.ino,
    HOME23_ISOLATED_FIXTURE_KEY_SHA256: config.capabilityKeyIdentity.sha256,
    HOME23_ISOLATED_FIXTURE_LAUNCHER_PID: String(process.pid),
    HOME23_ISOLATED_FIXTURE_OWNER_DEV: config.fixtureOwnerIdentity.dev,
    HOME23_ISOLATED_FIXTURE_OWNER_INO: config.fixtureOwnerIdentity.ino,
    HOME23_ISOLATED_FIXTURE_OWNER_SHA256: config.fixtureOwnerIdentity.sha256,
    HOME23_ISOLATED_FIXTURE_ROOT: config.fixtureRootIdentity.path,
    HOME23_ISOLATED_FIXTURE_ROOT_DEV: config.fixtureRootIdentity.dev,
    HOME23_ISOLATED_FIXTURE_ROOT_INO: config.fixtureRootIdentity.ino,
    HOME23_ISOLATED_FIXTURE_START_TOKEN: config.startToken,
    NODE_PATH: dependencies.join(path.delimiter),
  });
  return childEnv;
}

async function spawnChild(configBinding, role) {
  const configRecord = await readIdentityFile(configBinding.path, {
    maxBytes: FIXTURE_CONFIG_MAX_BYTES,
    errorCode: 'isolated_child_config_identity_mismatch',
    expected: configBinding,
  });
  const childConfig = parseIdentityJson(configRecord, 'isolated_child_config_identity_mismatch');
  if (childConfig.role !== role || typeof childConfig.startToken !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(childConfig.startToken)
      || childConfig.launcherPid !== process.pid) {
    throw typedError('isolated_child_invocation_invalid');
  }
  const childEnv = createChildEnvironment(childConfig, configBinding);
  const environmentKeys = Object.keys(childEnv).sort();
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url), '--internal-role', role, '--config', configBinding.path,
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: childEnv,
  });
  OWNED_CHILDREN.set(child, {
    pid: child.pid,
    role,
    startToken: childConfig.startToken,
    configBinding,
    fixtureRootIdentity: childConfig.fixtureRootIdentity,
    fixtureOwnerBinding: childConfig.fixtureOwnerIdentity,
    capabilityKeyBinding: childConfig.capabilityKeyIdentity,
    receiptProvenance: childConfig.receiptProvenance,
    configuredOperationDelayMs: childConfig.configuredOperationDelayMs,
    effectiveOperationDelayMs: childConfig.operationDelayMs,
    testOnlyDelay: childConfig.testOnlyDelay,
    environmentKeys,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
  child.fixtureStderr = () => stderr;
  return child;
}

function childShutdownEvidence(child, role, expectedPid, {
  code = child?.exitCode ?? null,
  signal = child?.signalCode ?? null,
  forcedKill = false,
  terminationRequested = false,
  signalDeliveryObserved = false,
} = {}) {
  const cleanExit = terminationRequested === true && signalDeliveryObserved === true
    && code === 0 && signal === null && forcedKill === false;
  let outcome = 'crashed';
  if (cleanExit) outcome = 'clean-exit';
  else if (forcedKill) outcome = 'forced-kill';
  else if (!child) outcome = 'missing';
  else if (terminationRequested === false && code === 0 && signal === null) {
    outcome = 'exited-before-stop';
  }
  return Object.freeze({
    role,
    pid: child?.pid ?? null,
    expectedPid,
    code,
    signal,
    exited: true,
    cleanExit,
    forcedKill,
    terminationRequested,
    signalDeliveryObserved,
    outcome,
  });
}

async function stopChild(child, role, expectedPid) {
  if (!child) {
    return childShutdownEvidence(child, role, expectedPid, {
      code: null,
      signal: null,
    });
  }
  const ownership = OWNED_CHILDREN.get(child);
  if (!ownership || ownership.pid !== child.pid
      || ownership.role !== role || child.pid !== expectedPid
      || !Number.isSafeInteger(child.pid) || child.pid < 1
      || !Number.isSafeInteger(expectedPid) || expectedPid < 1) {
    throw typedError('isolated_child_not_owned');
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return childShutdownEvidence(child, role, expectedPid);
  }
  const completed = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  const signalDeliveryObserved = child.kill('SIGTERM');
  const timeout = Symbol('timeout');
  let timeoutHandle;
  const timedOut = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(timeout), CHILD_STOP_TIMEOUT_MS);
    timeoutHandle.unref?.();
  });
  let result;
  try {
    result = await Promise.race([completed, timedOut]);
  } finally {
    clearTimeout(timeoutHandle);
  }
  let forcedKill = false;
  if (result === timeout) {
    forcedKill = true;
    child.kill('SIGKILL');
    result = await completed;
  }
  return childShutdownEvidence(child, role, expectedPid, {
    code: result.code,
    signal: result.signal,
    forcedKill,
    terminationRequested: true,
    signalDeliveryObserved,
  });
}

async function readFixtureOwner(ownerFile) {
  try {
    const record = await readIdentityFile(ownerFile, {
      maxBytes: FIXTURE_OWNER_MAX_BYTES,
      errorCode: 'isolated_fixture_ownership_mismatch',
    });
    return Object.freeze({
      ...record,
      value: parseIdentityJson(record, 'isolated_fixture_ownership_mismatch'),
    });
  } catch (error) {
    if (error?.cause?.code === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectory(directory) {
  const handle = await fsp.open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeCreatedOwner(ownerFile, identity) {
  const current = await fsp.lstat(ownerFile, { bigint: true }).catch(() => null);
  if (current && current.dev === identity.dev && current.ino === identity.ino) {
    await fsp.unlink(ownerFile).catch(() => {});
  }
}

async function assertFixtureOwnership(fixture, context, { allowCreate = true } = {}) {
  const stat = await fsp.lstat(fixture.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev.toString() !== fixture.dev || stat.ino.toString() !== fixture.ino) {
    throw typedError('isolated_fixture_ownership_mismatch');
  }
  const ownerFile = path.join(fixture.path, FIXTURE_OWNER_FILE);
  let ownerRecord = await readFixtureOwner(ownerFile);
  if (!ownerRecord) {
    if (!allowCreate) throw typedError('isolated_fixture_ownership_mismatch');
    const entries = await fsp.readdir(fixture.path);
    if (entries.length !== 0) throw typedError('isolated_fixture_ownerless_nonempty');
    const payload = fixtureOwnerPayload(fixture, context, new Date().toISOString());
    const owner = { ...payload, provenanceSeal: sealFixtureOwner(payload) };
    let created = null;
    try {
      created = await writeIdentityJson(ownerFile, owner, {
        maxBytes: FIXTURE_OWNER_MAX_BYTES,
        errorCode: 'isolated_fixture_ownership_mismatch',
      });
    } catch (error) {
      throw error;
    }
    const publishedEntries = await fsp.readdir(fixture.path);
    if (publishedEntries.length !== 1 || publishedEntries[0] !== FIXTURE_OWNER_FILE) {
      await removeCreatedOwner(ownerFile, {
        dev: BigInt(created.binding.dev),
        ino: BigInt(created.binding.ino),
      });
      throw typedError('isolated_fixture_ownerless_nonempty');
    }
    await syncDirectory(fixture.path);
    ownerRecord = Object.freeze({
      ...created,
      value: owner,
    });
  }
  const owner = ownerRecord.value;
  if (!exactKeys(owner, FIXTURE_OWNER_FIELDS)
      || typeof owner.createdAt !== 'string'
      || !Number.isFinite(Date.parse(owner.createdAt))
      || (owner.implementationCommit !== null
        && (typeof owner.implementationCommit !== 'string'
          || Buffer.byteLength(owner.implementationCommit, 'utf8') > 128))
      || (owner.hostname !== null
        && (typeof owner.hostname !== 'string'
          || Buffer.byteLength(owner.hostname, 'utf8') > 255))
      || (owner.receiptStartedAt !== null
        && (typeof owner.receiptStartedAt !== 'string'
          || !Number.isFinite(Date.parse(owner.receiptStartedAt))))
      || typeof owner.provenanceSeal !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(owner.provenanceSeal)) {
    throw typedError('isolated_fixture_ownership_mismatch');
  }
  const expected = fixtureOwnerPayload(fixture, context, owner.createdAt);
  const actual = { ...owner };
  delete actual.provenanceSeal;
  if (canonicalJson(actual) !== canonicalJson(expected)
      || owner.provenanceSeal !== sealFixtureOwner(expected)) {
    throw typedError('isolated_fixture_ownership_mismatch');
  }
  return Object.freeze({ owner: Object.freeze(owner), binding: ownerRecord.binding });
}

function createFixtureMutationAuthority(fixture, context, ownerBinding) {
  const authority = Object.freeze({ kind: 'isolated-fixture-mutation-authority' });
  FIXTURE_MUTATION_AUTHORITIES.set(authority, Object.freeze({
    fixture,
    context,
    ownerBinding,
  }));
  return authority;
}

async function assertFixtureMutationAuthority(authority) {
  const binding = FIXTURE_MUTATION_AUTHORITIES.get(authority);
  if (!binding) throw typedError('isolated_fixture_path_invalid');
  await assertReceiptContextDirectoryIdentity(binding.context);
  await assertExternalFixtureRoot(binding.fixture, binding.context.receiptRunDir);
  const ownerState = await assertFixtureOwnership(binding.fixture, binding.context, {
    allowCreate: false,
  });
  if (!sameIdentityDescriptor(ownerState.binding, binding.ownerBinding)) {
    throw typedError('isolated_fixture_ownership_mismatch');
  }
  return binding;
}

async function assertExactOwnedDirectory(directory, fixture, errorCode) {
  try {
    const before = await fsp.lstat(directory, { bigint: true });
    const canonical = await fsp.realpath(directory);
    const after = await fsp.lstat(directory, { bigint: true });
    const uid = currentUid();
    if (!before.isDirectory() || before.isSymbolicLink()
        || !after.isDirectory() || after.isSymbolicLink()
        || canonical !== directory || !isInsideOrEqual(fixture.path, canonical)
        || before.dev !== after.dev || before.ino !== after.ino
        || Number(before.mode & 0o777n) !== 0o700
        || Number(after.mode & 0o777n) !== 0o700
        || (uid !== null && (before.uid !== BigInt(uid) || after.uid !== BigInt(uid)))) {
      throw typedError(errorCode);
    }
    return Object.freeze({
      path: directory,
      dev: before.dev.toString(),
      ino: before.ino.toString(),
      mode: 0o700,
      ...(uid === null ? {} : { uid: String(uid) }),
    });
  } catch (error) {
    if (error?.code === errorCode) throw error;
    throw typedError(errorCode, undefined, { cause: error });
  }
}

async function ensureOwnedFixtureDirectory(authority, candidate) {
  const binding = await assertFixtureMutationAuthority(authority);
  const { fixture } = binding;
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)
      || path.normalize(candidate) !== candidate || candidate === fixture.path
      || !isInsideOrEqual(fixture.path, candidate)) {
    throw typedError('isolated_fixture_path_invalid');
  }
  const relative = path.relative(fixture.path, candidate);
  let current = fixture.path;
  await assertExactOwnedDirectory(current, fixture, 'isolated_fixture_path_invalid');
  for (const component of relative.split(path.sep).filter(Boolean)) {
    await assertFixtureMutationAuthority(authority);
    await assertExactOwnedDirectory(current, fixture, 'isolated_fixture_path_invalid');
    const next = path.join(current, component);
    let stat;
    try {
      stat = await fsp.lstat(next, { bigint: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw typedError('isolated_fixture_path_invalid', undefined, { cause: error });
      }
    }
    if (!stat) {
      try {
        await fsp.mkdir(next, { mode: 0o700 });
      } catch (error) {
        if (error?.code !== 'EEXIST') {
          throw typedError('isolated_fixture_path_invalid', undefined, { cause: error });
        }
      }
      await syncDirectory(current);
    }
    await assertExactOwnedDirectory(next, fixture, 'isolated_fixture_path_invalid');
    await assertFixtureMutationAuthority(authority);
    current = next;
  }
  return assertExactOwnedDirectory(current, fixture, 'isolated_fixture_path_invalid');
}

async function revalidateFixtureSecurityBindings({
  context,
  fixture,
  ownerBinding,
  capabilityKeyBinding,
  configBindings,
  readyBindings,
  configErrorCodes = Object.create(null),
} = {}) {
  const assertOwner = async () => {
    const ownerState = await assertFixtureOwnership(fixture, context, { allowCreate: false });
    if (!sameIdentityDescriptor(ownerState.binding, ownerBinding)) {
      throw typedError('isolated_fixture_ownership_mismatch');
    }
  };
  const assertAuthorityAndRoot = async () => {
    await assertReceiptContextDirectoryIdentity(context);
    await assertExternalFixtureRoot(fixture, context.receiptRunDir);
    await assertOwner();
  };
  if (!capabilityKeyBinding || !configBindings || !readyBindings) {
    throw typedError('isolated_fixture_identity_invalid');
  }
  const configEntries = Object.entries(configBindings);
  const readyEntries = Object.entries(readyBindings);
  if (configEntries.length !== 3 || readyEntries.length !== 3
      || new Set(configEntries.map(([role]) => role)).size !== 3
      || new Set(readyEntries.map(([role]) => role)).size !== 3
      || !['dashboard', 'cosmo', 'mcp'].every((role) =>
        Object.hasOwn(configBindings, role) && Object.hasOwn(readyBindings, role))) {
    throw typedError('isolated_fixture_identity_invalid');
  }
  await assertAuthorityAndRoot();
  await Promise.all([
    readIdentityFile(capabilityKeyBinding.path, {
      maxBytes: FIXTURE_KEY_MAX_BYTES,
      errorCode: 'isolated_fixture_capability_identity_invalid',
      expected: capabilityKeyBinding,
    }),
    ...configEntries.map(([role, binding]) => readIdentityFile(binding.path, {
      maxBytes: FIXTURE_CONFIG_MAX_BYTES,
      errorCode: configErrorCodes[role] || 'isolated_fixture_config_identity_invalid',
      expected: binding,
    })),
    ...readyEntries.map(([, binding]) => readIdentityFile(binding.path, {
      maxBytes: FIXTURE_READY_MAX_BYTES,
      errorCode: 'isolated_child_ready_invalid',
      expected: binding,
    })),
  ]);
  await assertAuthorityAndRoot();
}

export async function startIsolatedFixture({
  fixtureRoot,
  context,
  agent = 'acceptance-fixture',
  nodeCount = 2,
  edgeCount = 1,
  operationDelayMs = PRODUCTION_OPERATION_DELAY_MS,
  testDelaySeam = null,
  pgsSynthesisIncomplete = false,
} = {}) {
  await assertReceiptContextDirectoryIdentity(context);
  if (context?.authority !== 'isolated-controlled') throw typedError('isolated_fixture_authority_required');
  const testDelay = testDelaySeam === null ? null : TEST_DELAY_SEAMS.get(testDelaySeam);
  if (testDelaySeam !== null && testDelay === undefined) {
    throw typedError('isolated_fixture_test_delay_invalid');
  }
  if (operationDelayMs !== PRODUCTION_OPERATION_DELAY_MS) {
    throw typedError('isolated_fixture_production_delay_required');
  }
  const effectiveOperationDelayMs = testDelay ?? operationDelayMs;
  if (typeof agent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(agent)
      || !Number.isSafeInteger(nodeCount) || nodeCount < 1 || nodeCount > 2_000_000
      || !Number.isSafeInteger(edgeCount) || edgeCount < 0 || edgeCount > 8_000_000
      || typeof pgsSynthesisIncomplete !== 'boolean') {
    throw typedError('isolated_fixture_configuration_invalid');
  }
  const fixture = await canonicalDirectory(fixtureRoot, 'isolated fixture');
  await assertExternalFixtureRoot(fixture, context.receiptRunDir);
  const ownerState = await assertFixtureOwnership(fixture, context);
  const owner = ownerState.owner;
  const mutationAuthority = createFixtureMutationAuthority(
    fixture,
    context,
    ownerState.binding,
  );
  const source = await prepareSyntheticSource(
    mutationAuthority,
    fixture.path,
    agent,
    nodeCount,
    edgeCount,
    { canaryConcept: 'authoritative isolated own canary production pinned source' },
  );
  const siblingSource = await prepareSyntheticSource(
    mutationAuthority,
    fixture.path,
    `${agent}-sibling`,
    nodeCount,
    edgeCount,
    {
      generation: 'isolated-sibling-g1',
      canaryConcept: 'authoritative isolated sibling canary production pinned source',
    },
  );
  const researchRoot = path.join(
    fixture.path,
    'instances',
    agent,
    'workspace',
    'research',
    'runs',
    'completed-fixture-run',
  );
  const researchSource = await prepareSyntheticSource(
    mutationAuthority,
    fixture.path,
    agent,
    nodeCount,
    edgeCount,
    {
      brainDir: researchRoot,
      workspacePath: source.workspacePath,
      generation: 'isolated-research-g1',
      canaryConcept: 'authoritative isolated completed research canary production pinned source',
    },
  );
  const brainId = `brain-${agent}`;
  const canary = await discoverPreparedCanary(source, brainId);
  const runtime = path.join(fixture.path, 'runtime', 'isolated-fixture');
  await ensureOwnedFixtureDirectory(mutationAuthority, runtime);
  const token = randomUUID();
  const capabilityKeyFile = path.join(runtime, `capability-${token}.key`);
  const capabilityKey = createHash('sha256')
    .update(`${fixture.path}\0${context.receiptRunId}\0${randomUUID()}`)
    .digest('hex');
  const capabilityKeyRecord = await writeIdentityFile(
    capabilityKeyFile,
    Buffer.from(`${capabilityKey}\n`, 'utf8'),
    {
      maxBytes: FIXTURE_KEY_MAX_BYTES,
      errorCode: 'isolated_fixture_capability_identity_invalid',
    },
  );
  const operationsRoot = path.join(
    fixture.path, 'instances', agent, 'runtime', 'brain-operations',
  );
  await ensureOwnedFixtureDirectory(mutationAuthority, operationsRoot);
  const receiptProvenance = Object.freeze({
    receiptRunDir: context.receiptRunDir,
    receiptRunId: context.receiptRunId,
    authority: context.authority,
    implementationCommit: context.implementationCommit,
    hostname: context.hostname,
    startedAt: context.startedAt,
  });
  const childInheritedEnvironmentKeys = CHILD_INHERITED_ENV_ALLOWLIST
    .filter((key) => typeof process.env[key] === 'string' && process.env[key].length <= 32_768);
  const baseConfig = {
    fixtureRoot: fixture.path,
    fixtureRootIdentity: rootIdentityDescriptor(fixture),
    fixtureOwnerIdentity: ownerState.binding,
    receiptProvenance,
    launcherPid: process.pid,
    childInheritedEnvironmentKeys,
    agent,
    brainId,
    ...source,
    siblingBrainDir: siblingSource.brainDir,
    siblingNodeCount: nodeCount,
    siblingEdgeCount: edgeCount,
    researchBrainDir: researchSource.brainDir,
    researchNodeCount: nodeCount,
    researchEdgeCount: edgeCount,
    nodeCount,
    edgeCount,
    sourceRevision: 1,
    generation: 'isolated-g1',
    catalogRevision: sha256Bytes(Buffer.from(`${fixture.path}:${nodeCount}:${edgeCount}`)),
    createdAt: owner.createdAt,
    configuredOperationDelayMs: PRODUCTION_OPERATION_DELAY_MS,
    operationDelayMs: effectiveOperationDelayMs,
    testOnlyDelay: testDelay !== null,
    pgsSynthesisIncomplete,
    startToken: token,
    capabilityKeyFile,
    capabilityKeyIdentity: capabilityKeyRecord.binding,
    operationsRoot,
  };
  const cosmoConfigFile = path.join(runtime, `cosmo-${token}.json`);
  const cosmoReady = path.join(runtime, `cosmo-${token}.ready.json`);
  const cosmoMetrics = path.join(runtime, `cosmo-${token}.metrics.json`);
  const cosmoConfigRecord = await writeIdentityJson(cosmoConfigFile, {
    ...baseConfig,
    role: 'cosmo',
    readyFile: cosmoReady,
    metricsFile: cosmoMetrics,
  }, {
    maxBytes: FIXTURE_CONFIG_MAX_BYTES,
    errorCode: 'isolated_fixture_config_identity_invalid',
  });
  let cosmo = null;
  let mcp = null;
  let dashboard = null;
  let mcpConfigRecord = null;
  let dashboardConfigRecord = null;
  try {
    cosmo = await spawnChild(cosmoConfigRecord.binding, 'cosmo');
    const cosmoIdentity = await waitReady(cosmoReady, cosmo);
    const mcpConfigFile = path.join(runtime, `mcp-${token}.json`);
    const mcpReady = path.join(runtime, `mcp-${token}.ready.json`);
    const mcpMetrics = path.join(runtime, `mcp-${token}.metrics.json`);
    mcpConfigRecord = await writeIdentityJson(mcpConfigFile, {
      ...baseConfig, role: 'mcp', readyFile: mcpReady, metricsFile: mcpMetrics,
    }, {
      maxBytes: FIXTURE_CONFIG_MAX_BYTES,
      errorCode: 'isolated_fixture_config_identity_invalid',
    });
    mcp = await spawnChild(mcpConfigRecord.binding, 'mcp');
    const mcpIdentity = await waitReady(mcpReady, mcp);
    const dashboardConfigFile = path.join(runtime, `dashboard-${token}.json`);
    const dashboardReady = path.join(runtime, `dashboard-${token}.ready.json`);
    const dashboardMetrics = path.join(runtime, `dashboard-${token}.metrics.json`);
    dashboardConfigRecord = await writeIdentityJson(dashboardConfigFile, {
      ...baseConfig,
      role: 'dashboard',
      readyFile: dashboardReady,
      metricsFile: dashboardMetrics,
      cosmoBaseUrl: `http://127.0.0.1:${cosmoIdentity.port}`,
      mcpPort: mcpIdentity.port,
    }, {
      maxBytes: FIXTURE_CONFIG_MAX_BYTES,
      errorCode: 'isolated_fixture_config_identity_invalid',
    });
    dashboard = await spawnChild(dashboardConfigRecord.binding, 'dashboard');
    const dashboardIdentity = await waitReady(dashboardReady, dashboard);
    const configBindings = Object.freeze({
      dashboard: dashboardConfigRecord.binding,
      cosmo: cosmoConfigRecord.binding,
      mcp: mcpConfigRecord.binding,
    });
    let readyBindings = Object.freeze({
      dashboard: OWNED_CHILDREN.get(dashboard).readyBinding,
      cosmo: OWNED_CHILDREN.get(cosmo).readyBinding,
      mcp: OWNED_CHILDREN.get(mcp).readyBinding,
    });
    let environmentBindings = Object.freeze({
      dashboard: Object.freeze([...OWNED_CHILDREN.get(dashboard).environmentKeys]),
      cosmo: Object.freeze([...OWNED_CHILDREN.get(cosmo).environmentKeys]),
      mcp: Object.freeze([...OWNED_CHILDREN.get(mcp).environmentKeys]),
    });
    let controlledChildren = Object.freeze({ dashboard, cosmo, mcp });
    let controlledPids = Object.freeze({
      dashboard: dashboard.pid,
      cosmo: cosmo.pid,
      mcp: mcp.pid,
    });
    const securityBindings = Object.freeze({
      fixtureRoot: rootIdentityDescriptor(fixture),
      owner: ownerState.binding,
      capabilityKey: capabilityKeyRecord.binding,
      configs: configBindings,
      get ready() { return readyBindings; },
    });
    await revalidateFixtureSecurityBindings({
      context,
      fixture,
      ownerBinding: ownerState.binding,
      capabilityKeyBinding: capabilityKeyRecord.binding,
      configBindings,
      readyBindings,
    });
    const result = {
      fixtureRoot: fixture.path,
      owner,
      receiptProvenance,
      launcherPid: process.pid,
      startToken: token,
      source,
      canary,
      sources: {
        own: source,
        sibling: siblingSource,
        research: researchSource,
      },
      nodeCount,
      edgeCount,
      agent,
      brainId: baseConfig.brainId,
      sourceRevision: 1,
      generation: baseConfig.generation,
      operationsRoot: baseConfig.operationsRoot,
      baseUrl: `http://127.0.0.1:${dashboardIdentity.port}`,
      cosmoBaseUrl: `http://127.0.0.1:${cosmoIdentity.port}`,
      mcpBaseUrl: `http://127.0.0.1:${mcpIdentity.port}`,
      ports: {
        dashboard: dashboardIdentity.port,
        cosmo: cosmoIdentity.port,
        mcp: mcpIdentity.port,
      },
      pids: { ...controlledPids },
      metrics: { dashboard: dashboardMetrics, cosmo: cosmoMetrics, mcp: mcpMetrics },
      children: { ...controlledChildren },
      runtimeRoot: runtime,
      capabilityKeyFile,
      configuredOperationDelayMs: PRODUCTION_OPERATION_DELAY_MS,
      effectiveOperationDelayMs,
      testOnlyOperationDelay: testDelay !== null,
      operationDelayEvidence: null,
      get childEnvironmentKeys() { return environmentBindings; },
      securityBindings,
      cosmoConfigFile,
      mcpConfigFile,
      dashboardConfigFile,
      async restartDashboard({ readyTimeoutMs = CHILD_READY_TIMEOUT_MS } = {}) {
        if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 25
            || readyTimeoutMs > CHILD_READY_TIMEOUT_MS) {
          throw typedError('isolated_fixture_configuration_invalid');
        }
        await revalidateFixtureSecurityBindings({
          context,
          fixture,
          ownerBinding: ownerState.binding,
          capabilityKeyBinding: capabilityKeyRecord.binding,
          configBindings,
          readyBindings,
          configErrorCodes: { dashboard: 'isolated_child_config_identity_mismatch' },
        });
        const stopped = await stopChild(
          this.children.dashboard,
          'dashboard',
          this.pids.dashboard,
        );
        if (stopped.cleanExit !== true) {
          throw typedError('isolated_fixture_shutdown_unproven');
        }
        await fsp.rm(dashboardReady, { force: true });
        const next = await spawnChild(dashboardConfigRecord.binding, 'dashboard');
        let ready;
        try {
          ready = await waitReady(dashboardReady, next, readyTimeoutMs);
        } catch (error) {
          try {
            await stopChild(next, 'dashboard', next.pid);
          } catch (cleanupError) {
            throw typedError('isolated_child_cleanup_failed', undefined, {
              cause: error,
              cleanupCause: cleanupError,
              childPid: next.pid,
            });
          }
          throw error;
        }
        this.children.dashboard = next;
        this.pids.dashboard = next.pid;
        controlledChildren = Object.freeze({ ...controlledChildren, dashboard: next });
        controlledPids = Object.freeze({ ...controlledPids, dashboard: next.pid });
        this.ports.dashboard = ready.port;
        this.baseUrl = `http://127.0.0.1:${ready.port}`;
        environmentBindings = Object.freeze({
          ...environmentBindings,
          dashboard: Object.freeze([...OWNED_CHILDREN.get(next).environmentKeys]),
        });
        readyBindings = Object.freeze({
          ...readyBindings,
          dashboard: OWNED_CHILDREN.get(next).readyBinding,
        });
        await revalidateFixtureSecurityBindings({
          context,
          fixture,
          ownerBinding: ownerState.binding,
          capabilityKeyBinding: capabilityKeyRecord.binding,
          configBindings,
          readyBindings,
        });
        return stopped;
      },
      async restartCoordinator() {
        const response = await fetch(`${this.baseUrl}/fixture/restart-coordinator`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const value = await readBoundedFixtureJsonResponse(response);
        if (!response.ok || value?.ok !== true) {
          throw typedError(value?.error?.code || 'fixture_restart_failed');
        }
        return value;
      },
      async telemetry() {
        const signal = AbortSignal.timeout(2_000);
        const [dashboardResponse, cosmoResponse] = await Promise.all([
          fetch(`${this.baseUrl}/telemetry`, { signal }),
          fetch(`${this.cosmoBaseUrl}/telemetry`, { signal }),
        ]);
        return {
          dashboard: await readBoundedFixtureJsonResponse(dashboardResponse),
          cosmo: await readBoundedFixtureJsonResponse(cosmoResponse),
        };
      },
      async operationTelemetry(operationId) {
        const response = await fetch(
          `${this.cosmoBaseUrl}/fixture/operations/${encodeURIComponent(operationId)}`,
        );
        const value = await readBoundedFixtureJsonResponse(response);
        if (!response.ok) throw typedError(value?.error?.code || 'fixture_telemetry_failed');
        return value;
      },
    };
    ISOLATED_FIXTURE_AUTHORITIES.set(result, Object.freeze({
      context,
      fixture,
      ownerBinding: ownerState.binding,
      capabilityKeyBinding: capabilityKeyRecord.binding,
      configBindings,
      receiptProvenance,
      launcherPid: process.pid,
      startToken: token,
      getReadyBindings: () => readyBindings,
      getEnvironmentBindings: () => environmentBindings,
      getControlledChildren: () => controlledChildren,
      getControlledPids: () => controlledPids,
    }));
    return result;
  } catch (error) {
    await Promise.all([
      stopChild(dashboard, 'dashboard', dashboard?.pid ?? null),
      stopChild(mcp, 'mcp', mcp?.pid ?? null),
      stopChild(cosmo, 'cosmo', cosmo?.pid ?? null),
    ]);
    error.fixtureStderr = {
      dashboard: dashboard?.fixtureStderr?.() || '',
      mcp: mcp?.fixtureStderr?.() || '',
      cosmo: cosmo?.fixtureStderr?.() || '',
    };
    throw error;
  }
}

function frozenIdentityMap(bindings) {
  return Object.freeze(Object.fromEntries(Object.entries(bindings).map(([role, binding]) => [
    role,
    Object.freeze({ ...binding }),
  ])));
}

async function finalFixtureSecurityEvidence(fixture) {
  const authority = ISOLATED_FIXTURE_AUTHORITIES.get(fixture);
  if (!authority) throw typedError('isolated_fixture_security_unproven');
  const readyBindings = authority.getReadyBindings();
  const environmentBindings = authority.getEnvironmentBindings();
  const controlledChildren = authority.getControlledChildren();
  const controlledPids = authority.getControlledPids();
  await revalidateFixtureSecurityBindings({
    context: authority.context,
    fixture: authority.fixture,
    ownerBinding: authority.ownerBinding,
    capabilityKeyBinding: authority.capabilityKeyBinding,
    configBindings: authority.configBindings,
    readyBindings,
  });
  const currentOwner = await assertFixtureOwnership(authority.fixture, authority.context, {
    allowCreate: false,
  });
  const expectedSecurityBindings = {
    fixtureRoot: rootIdentityDescriptor(authority.fixture),
    owner: authority.ownerBinding,
    capabilityKey: authority.capabilityKeyBinding,
    configs: authority.configBindings,
    ready: readyBindings,
  };
  if (!sameIdentityDescriptor(currentOwner.binding, authority.ownerBinding)
      || canonicalJson(fixture.owner) !== canonicalJson(currentOwner.owner)
      || canonicalJson(fixture.receiptProvenance) !== canonicalJson(authority.receiptProvenance)
      || fixture.launcherPid !== authority.launcherPid
      || fixture.startToken !== authority.startToken
      || canonicalJson({
        fixtureRoot: fixture.securityBindings?.fixtureRoot,
        owner: fixture.securityBindings?.owner,
        capabilityKey: fixture.securityBindings?.capabilityKey,
        configs: fixture.securityBindings?.configs,
        ready: fixture.securityBindings?.ready,
      }) !== canonicalJson(expectedSecurityBindings)
      || canonicalJson(fixture.childEnvironmentKeys) !== canonicalJson(environmentBindings)) {
    throw typedError('isolated_fixture_security_unproven');
  }
  for (const role of ['dashboard', 'cosmo', 'mcp']) {
    const child = controlledChildren[role];
    const ownership = OWNED_CHILDREN.get(child);
    const environmentKeys = environmentBindings[role];
    if (!ownership || ownership.role !== role || ownership.pid !== child?.pid
        || controlledPids[role] !== child?.pid
        || fixture.children?.[role] !== child || fixture.pids?.[role] !== child?.pid
        || ownership.startToken !== authority.startToken
        || !sameIdentityDescriptor(ownership.configBinding, authority.configBindings[role])
        || !sameIdentityDescriptor(ownership.capabilityKeyBinding, authority.capabilityKeyBinding)
        || !sameIdentityDescriptor(ownership.fixtureOwnerBinding, authority.ownerBinding)
        || !sameIdentityDescriptor(ownership.readyBinding, readyBindings[role])
        || canonicalJson(ownership.receiptProvenance)
          !== canonicalJson(authority.receiptProvenance)
        || canonicalJson(ownership.environmentKeys) !== canonicalJson(environmentKeys)
        || canonicalJson(ownership.readyPayload?.environmentKeys) !== canonicalJson(environmentKeys)
        || ownership.readyPayload?.pid !== child.pid
        || ownership.readyPayload?.role !== role
        || ownership.readyPayload?.port !== fixture.ports?.[role]
        || ownership.readyPayload?.startToken !== authority.startToken
        || ownership.readyPayload?.launcherPid !== authority.launcherPid) {
      throw typedError('isolated_fixture_security_unproven');
    }
  }
  return Object.freeze({
    ownerProvenance: Object.freeze({ ...currentOwner.owner }),
    receiptProvenance: Object.freeze({ ...authority.receiptProvenance }),
    launcherPid: authority.launcherPid,
    startToken: authority.startToken,
    securityBindings: Object.freeze({
      fixtureRoot: Object.freeze({ ...expectedSecurityBindings.fixtureRoot }),
      owner: Object.freeze({ ...expectedSecurityBindings.owner }),
      capabilityKey: Object.freeze({ ...expectedSecurityBindings.capabilityKey }),
      configs: frozenIdentityMap(expectedSecurityBindings.configs),
      ready: frozenIdentityMap(expectedSecurityBindings.ready),
    }),
    childEnvironmentKeys: Object.freeze(Object.fromEntries(
      Object.entries(environmentBindings).map(([role, keys]) => [role, Object.freeze([...keys])]),
    )),
  });
}

export async function stopIsolatedFixture(fixture) {
  let telemetry = null;
  try {
    telemetry = await fixture?.telemetry?.();
  } catch {
    // Shutdown remains bounded even when a child failed before telemetry capture.
  }
  if (fixture && telemetry) {
    const roleEvidence = (role) => ({
      providerStarts: Number(telemetry[role]?.providerStarts || 0),
      providerAborts: Number(telemetry[role]?.providerAborts || 0),
      providerDelayStarts: Number(telemetry[role]?.providerDelayStarts || 0),
      providerDelayCompletions: Number(telemetry[role]?.providerDelayCompletions || 0),
      actions: Array.isArray(telemetry[role]?.providerDelayActions)
        ? telemetry[role].providerDelayActions.map((action) => ({ ...action }))
        : null,
    });
    const roles = {
      cosmo: roleEvidence('cosmo'),
      dashboard: roleEvidence('dashboard'),
    };
    fixture.operationDelayEvidence = {
      schemaVersion: 2,
      configuredDelayMs: fixture.configuredOperationDelayMs,
      effectiveDelayMs: fixture.effectiveOperationDelayMs,
      testOnlyDelay: fixture.testOnlyOperationDelay,
      capturedBeforeStop: true,
      roles,
    };
  }
  const stopAuthority = ISOLATED_FIXTURE_AUTHORITIES.get(fixture);
  const controlledChildren = stopAuthority?.getControlledChildren?.() ?? fixture?.children;
  const controlledPids = stopAuthority?.getControlledPids?.() ?? fixture?.pids;
  const roleStops = await Promise.allSettled([
    stopChild(controlledChildren?.dashboard, 'dashboard', controlledPids?.dashboard ?? null),
    stopChild(controlledChildren?.cosmo, 'cosmo', controlledPids?.cosmo ?? null),
    stopChild(controlledChildren?.mcp, 'mcp', controlledPids?.mcp ?? null),
  ]);
  const stopFailure = roleStops.find((entry) => entry.status === 'rejected');
  if (stopFailure) throw stopFailure.reason;
  const [dashboard, cosmo, mcp] = roleStops.map((entry) => entry.value);
  let securityEvidence = null;
  let securityError = null;
  try {
    securityEvidence = await finalFixtureSecurityEvidence(fixture);
  } catch (error) {
    securityError = error;
  }
  const stopped = Object.freeze({
    dashboard,
    cosmo,
    mcp,
    retainedStore: fixture?.operationsRoot ?? null,
    securityEvidence,
  });
  if (securityError) {
    throw typedError('isolated_fixture_security_unproven', undefined, {
      cause: securityError,
      stopped,
    });
  }
  return stopped;
}

function requireExactEnvironment(config, configBinding) {
  if (!Array.isArray(config.childInheritedEnvironmentKeys)
      || config.childInheritedEnvironmentKeys.some((key) =>
        typeof key !== 'string' || !CHILD_INHERITED_ENV_ALLOWLIST.includes(key))) {
    throw typedError('isolated_child_environment_invalid');
  }
  const expectedKeys = [...new Set([
    ...config.childInheritedEnvironmentKeys,
    ...CHILD_BINDING_ENV_KEYS,
  ])].sort();
  const actualKeys = Object.keys(process.env).sort();
  if (canonicalJson(actualKeys) !== canonicalJson(expectedKeys)
      || process.env.HOME23_ISOLATED_FIXTURE_CHILD !== '1'
      || process.env.HOME23_ISOLATED_FIXTURE_CONFIG !== configBinding.path
      || process.env.HOME23_ISOLATED_FIXTURE_CONFIG_DEV !== configBinding.dev
      || process.env.HOME23_ISOLATED_FIXTURE_CONFIG_INO !== configBinding.ino
      || process.env.HOME23_ISOLATED_FIXTURE_CONFIG_SHA256 !== configBinding.sha256
      || process.env.HOME23_ISOLATED_FIXTURE_KEY_DEV !== config.capabilityKeyIdentity.dev
      || process.env.HOME23_ISOLATED_FIXTURE_KEY_INO !== config.capabilityKeyIdentity.ino
      || process.env.HOME23_ISOLATED_FIXTURE_KEY_SHA256 !== config.capabilityKeyIdentity.sha256
      || process.env.HOME23_ISOLATED_FIXTURE_LAUNCHER_PID !== String(config.launcherPid)
      || process.env.HOME23_ISOLATED_FIXTURE_OWNER_DEV !== config.fixtureOwnerIdentity.dev
      || process.env.HOME23_ISOLATED_FIXTURE_OWNER_INO !== config.fixtureOwnerIdentity.ino
      || process.env.HOME23_ISOLATED_FIXTURE_OWNER_SHA256 !== config.fixtureOwnerIdentity.sha256
      || process.env.HOME23_ISOLATED_FIXTURE_ROOT !== config.fixtureRootIdentity.path
      || process.env.HOME23_ISOLATED_FIXTURE_ROOT_DEV !== config.fixtureRootIdentity.dev
      || process.env.HOME23_ISOLATED_FIXTURE_ROOT_INO !== config.fixtureRootIdentity.ino
      || process.env.HOME23_ISOLATED_FIXTURE_START_TOKEN !== config.startToken
      || process.env.NODE_PATH !== knownDependencyPaths().join(path.delimiter)) {
    throw typedError('isolated_child_environment_invalid', undefined, {
      actualKeys,
      expectedKeys,
      nodePathMatches: process.env.NODE_PATH === knownDependencyPaths().join(path.delimiter),
    });
  }
  return actualKeys;
}

async function assertFixtureDescendantPath(root, candidate, label, { existing = false } = {}) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)
      || path.normalize(candidate) !== candidate || !isInsideOrEqual(root, candidate)
      || candidate === root) {
    throw typedError('isolated_child_path_invalid', `${label} escapes the fixture root`);
  }
  if (existing) {
    let canonical;
    try {
      canonical = await fsp.realpath(candidate);
    } catch (error) {
      throw typedError('isolated_child_path_invalid', `${label} is unavailable`, { cause: error });
    }
    if (canonical !== candidate || !isInsideOrEqual(root, canonical)) {
      throw typedError('isolated_child_path_invalid', `${label} is not canonical`);
    }
    return candidate;
  }
  let parent = path.dirname(candidate);
  while (parent !== root) {
    try {
      const canonicalParent = await fsp.realpath(parent);
      if (canonicalParent !== parent || !isInsideOrEqual(root, canonicalParent)) {
        throw typedError('isolated_child_path_invalid', `${label} parent is not canonical`);
      }
      return candidate;
    } catch (error) {
      if (error?.code === 'isolated_child_path_invalid') throw error;
      if (error?.code !== 'ENOENT') {
        throw typedError('isolated_child_path_invalid', `${label} parent is unavailable`, {
          cause: error,
        });
      }
      const next = path.dirname(parent);
      if (next === parent || !isInsideOrEqual(root, next)) {
        throw typedError('isolated_child_path_invalid', `${label} parent escapes the fixture root`);
      }
      parent = next;
    }
  }
  return candidate;
}

async function validateChildFixtureConfig(config, configRecord) {
  if (!config || typeof config !== 'object' || Array.isArray(config)
      || !INTERNAL_ROLE.has(config.role)
      || typeof config.startToken !== 'string' || !/^[0-9a-f-]{36}$/i.test(config.startToken)
      || !Number.isSafeInteger(config.launcherPid) || config.launcherPid < 1
      || !sameRootIdentity(config.fixtureRootIdentity, {
        path: config.fixtureRoot,
        dev: config.fixtureRootIdentity?.dev,
        ino: config.fixtureRootIdentity?.ino,
      })) {
    throw typedError('isolated_child_invocation_invalid');
  }
  const fixture = await canonicalDirectory(config.fixtureRoot, 'isolated fixture');
  await assertExternalFixtureRoot(fixture, config.receiptProvenance?.receiptRunDir);
  if (!sameRootIdentity(rootIdentityDescriptor(fixture), config.fixtureRootIdentity)) {
    throw typedError('isolated_child_identity_mismatch');
  }
  if (config.launcherPid !== process.ppid) {
    throw typedError('isolated_child_launcher_identity_mismatch');
  }
  const childContext = await receiptContext({
    'receipt-run-dir': config.receiptProvenance?.receiptRunDir,
    'receipt-run-id': config.receiptProvenance?.receiptRunId,
    authority: config.receiptProvenance?.authority,
    'implementation-commit': config.receiptProvenance?.implementationCommit,
  }, Object.create(null), {
    implementationCommit: config.receiptProvenance?.implementationCommit,
    startedAt: config.receiptProvenance?.startedAt,
  });
  await assertReceiptContextDirectoryIdentity(childContext);
  const expectedProvenance = {
    receiptRunDir: childContext.receiptRunDir,
    receiptRunId: childContext.receiptRunId,
    authority: childContext.authority,
    implementationCommit: childContext.implementationCommit,
    hostname: childContext.hostname,
    startedAt: childContext.startedAt,
  };
  if (canonicalJson(config.receiptProvenance) !== canonicalJson(expectedProvenance)) {
    throw typedError('isolated_child_receipt_provenance_mismatch');
  }
  const existingPaths = [
    ['brainDir', config.brainDir],
    ['workspacePath', config.workspacePath],
    ['nodesFile', config.nodesFile],
    ['edgesFile', config.edgesFile],
    ['deltaFile', config.deltaFile],
    ['stateFile', config.stateFile],
    ['siblingBrainDir', config.siblingBrainDir],
    ['researchBrainDir', config.researchBrainDir],
    ['capabilityKeyFile', config.capabilityKeyFile],
  ];
  const outputPaths = [
    ['readyFile', config.readyFile],
    ['metricsFile', config.metricsFile],
    ['operationsRoot', config.operationsRoot],
  ];
  for (const [label, candidate] of existingPaths) {
    await assertFixtureDescendantPath(fixture.path, candidate, label, { existing: true });
  }
  for (const [label, candidate] of outputPaths) {
    await assertFixtureDescendantPath(fixture.path, candidate, label);
  }
  const configPath = configRecord.binding.path;
  await assertFixtureDescendantPath(fixture.path, configPath, 'configFile', { existing: true });
  if (config.fixtureOwnerIdentity?.path !== path.join(fixture.path, FIXTURE_OWNER_FILE)
      || config.capabilityKeyIdentity?.path !== config.capabilityKeyFile) {
    throw typedError('isolated_child_identity_mismatch');
  }
  const ownerState = await assertFixtureOwnership(fixture, childContext, { allowCreate: false });
  if (!sameIdentityDescriptor(ownerState.binding, config.fixtureOwnerIdentity)) {
    throw typedError('isolated_child_identity_mismatch');
  }
  const keyRecord = await readIdentityFile(config.capabilityKeyFile, {
    maxBytes: FIXTURE_KEY_MAX_BYTES,
    errorCode: 'isolated_child_invocation_invalid',
    expected: config.capabilityKeyIdentity,
  });
  const capabilityKey = keyRecord.bytes.toString('utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(capabilityKey)) {
    throw typedError('isolated_child_invocation_invalid');
  }
  const environmentKeys = requireExactEnvironment(config, configRecord.binding);
  await assertReceiptContextDirectoryIdentity(childContext);
  await assertExternalFixtureRoot(fixture, childContext.receiptRunDir);
  await readIdentityFile(configRecord.binding.path, {
    maxBytes: FIXTURE_CONFIG_MAX_BYTES,
    errorCode: 'isolated_child_config_identity_mismatch',
    expected: configRecord.binding,
  });
  await readIdentityFile(config.capabilityKeyFile, {
    maxBytes: FIXTURE_KEY_MAX_BYTES,
    errorCode: 'isolated_child_invocation_invalid',
    expected: config.capabilityKeyIdentity,
  });
  const finalOwnerState = await assertFixtureOwnership(fixture, childContext, {
    allowCreate: false,
  });
  if (!sameIdentityDescriptor(finalOwnerState.binding, config.fixtureOwnerIdentity)) {
    throw typedError('isolated_child_identity_mismatch');
  }
  return Object.freeze({
    fixture,
    childContext,
    capabilityKey,
    environmentKeys,
  });
}

async function internalMain(argv) {
  const roleIndex = argv.indexOf('--internal-role');
  const configIndex = argv.indexOf('--config');
  const role = roleIndex >= 0 ? argv[roleIndex + 1] : null;
  const configFile = configIndex >= 0 ? argv[configIndex + 1] : null;
  if (!INTERNAL_ROLE.has(role) || !configFile || process.env.HOME23_ISOLATED_FIXTURE_CHILD !== '1') {
    throw typedError('isolated_child_invocation_invalid');
  }
  const resolvedConfig = path.resolve(configFile);
  const configRecord = await readIdentityFile(resolvedConfig, {
    maxBytes: FIXTURE_CONFIG_MAX_BYTES,
    errorCode: 'isolated_child_invocation_invalid',
  });
  const config = parseIdentityJson(configRecord, 'isolated_child_invocation_invalid');
  if (config.role !== role || Object.hasOwn(config, 'capabilityKey')
      || typeof config.capabilityKeyFile !== 'string') {
    throw typedError('isolated_child_invocation_invalid');
  }
  const validated = await validateChildFixtureConfig(config, configRecord);
  config.capabilityKey = validated.capabilityKey;
  config.configIdentity = configRecord.binding;
  if (role === 'cosmo') return runCosmoChild(config);
  if (role === 'mcp') return runMcpChild(config);
  return runDashboardChild(config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  internalMain(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({
      code: error.code || 'isolated_child_failed',
      message: error.message,
      ...(Array.isArray(error.actualKeys) ? { actualKeys: error.actualKeys } : {}),
      ...(Array.isArray(error.expectedKeys) ? { expectedKeys: error.expectedKeys } : {}),
      ...(typeof error.nodePathMatches === 'boolean'
        ? { nodePathMatches: error.nodePathMatches }
        : {}),
    })}\n`);
    process.exit(1);
  });
}
