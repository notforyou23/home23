#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canonicalDirectory,
  hashFile,
  isInsideOrEqual,
  readJson,
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
const INTERNAL_ROLE = new Set(['cosmo', 'dashboard', 'mcp']);
const OWNED_CHILDREN = new WeakMap();
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CONTROLLED_PROVIDER = 'controlled';
const CONTROLLED_QUERY_MODEL = 'controlled-query';
const CONTROLLED_PGS_MODEL = 'controlled-pgs';
const CONTROLLED_SYNTHESIS_MODEL = 'controlled-synthesis';
const METRIC_SEMANTICS = Object.freeze({
  v8HeapUsedBytes: 'request-time-sample',
  rssBytes: 'request-time-sample',
  processMaxRssBytes: 'process-lifetime-high-water',
});
let observedProcessMaxRssMiB = 0;

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
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fsp.rename(temporary, file);
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

function waitControlled(ms, signal, telemetry) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      telemetry.providerAborts += 1;
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(done, ms);
    const aborted = () => {
      clearTimeout(timer);
      telemetry.providerAborts += 1;
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    };
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function controlledProviderClient(config, telemetry, model) {
  return Object.freeze({
    providerId: CONTROLLED_PROVIDER,
    async generate(options = {}) {
      telemetry.providerStarts += 1;
      telemetry.models[model] = (telemetry.models[model] || 0) + 1;
      telemetry.lastProviderStartedAt = new Date().toISOString();
      options.onProviderActivity?.({
        type: 'controlled_provider_started',
        at: telemetry.lastProviderStartedAt,
      });
      const requestedDelay = model === CONTROLLED_SYNTHESIS_MODEL
        || /controlled lifecycle|detach|cancel|restart/i.test(String(options.input || ''))
        ? Math.max(config.operationDelayMs, 750)
        : config.operationDelayMs;
      await waitControlled(requestedDelay, options.signal, telemetry);
      options.onProviderActivity?.({
        type: 'controlled_provider_progress',
        at: new Date().toISOString(),
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
    synthesisStarts: 0,
    models: {},
    coordinatorRestarts: 0,
    lastProviderStartedAt: null,
  };
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
    return executeEnhancedQuery(query, options);
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
  await writeJsonAtomic(config.readyFile, {
    role: 'cosmo', pid: process.pid, port: address.port,
    startToken: config.startToken, metricsPath: config.metricsFile,
  });
  const metrics = setInterval(() => writeMetrics(
    config.metricsFile, 'cosmo', 0, telemetry,
  ).catch(() => {}), 50);
  const shutdown = async () => {
    clearInterval(metrics);
    await runtime.worker.stop().catch(() => {});
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
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
  await writeJsonAtomic(config.readyFile, {
    role: 'mcp', pid: process.pid, port: address.port,
    startToken: config.startToken, metricsPath: config.metricsFile,
  });
  const metrics = setInterval(() => writeMetrics(
    config.metricsFile, 'mcp', 0,
  ).catch(() => {}), 50);
  const shutdown = async () => {
    clearInterval(metrics);
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function runDashboardChild(config) {
  const telemetry = freshTelemetry();
  const catalog = catalogFor(config);
  const modelCatalog = controlledCatalog();
  const providerRegistry = createControlledRegistry(config, telemetry);
  const operationsRoot = config.operationsRoot;
  await fsp.mkdir(operationsRoot, { recursive: true, mode: 0o700 });
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
  worker.registerLocalExecutor('synthesis', synthesisRuntime.executor);

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
          return {
            ...requestParameters,
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
      limits: { stopTimeoutMs: 250 },
    });
    await next.reconcile();
    return {
      coordinator: next,
      store,
      reader,
      exporter,
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
  app.use('/home23/api/brain-operations', (request, response, next) =>
    active.router(request, response, next));
  registerSynthesisCompatibilityRoutes({
    app,
    requesterAgent: config.agent,
    synthesisRuntime,
    coordinator: active.coordinator,
    store: active.store,
  });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw typedError('fixture_listener_failed');
  await writeMetrics(config.metricsFile, 'dashboard', 0, telemetry);
  await writeJsonAtomic(config.readyFile, {
    role: 'dashboard', pid: process.pid, port: address.port,
    startToken: config.startToken, metricsPath: config.metricsFile,
  });
  const metrics = setInterval(() => writeMetrics(
    config.metricsFile, 'dashboard', telemetry.coordinatorRestarts, telemetry,
  ).catch(() => {}), 50);
  const shutdown = async () => {
    clearInterval(metrics);
    await active.coordinator.stop().catch(() => {});
    await worker.stop().catch(() => {});
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
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

async function prepareSyntheticSource(fixtureRoot, agent, nodeCount, edgeCount, options = {}) {
  const brainDir = options.brainDir
    || path.join(fixtureRoot, 'instances', agent, 'brain');
  const workspacePath = options.workspacePath
    || path.join(fixtureRoot, 'instances', agent, 'workspace');
  const generation = options.generation || 'isolated-g1';
  const canaryConcept = options.canaryConcept
    || 'authoritative isolated own canary production pinned source';
  await fsp.mkdir(brainDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(workspacePath, { recursive: true, mode: 0o700 });
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
      const ready = await readJson(file);
      if (ready.pid !== child.pid || ready.role !== ownership.role
          || ready.startToken !== ownership.startToken
          || !Number.isSafeInteger(ready.port) || ready.port < 1) {
        throw typedError('isolated_child_identity_mismatch');
      }
      return ready;
    } catch (error) {
      if (!['ENOENT', 'json_file_invalid'].includes(error.code)) throw error;
    }
    await sleep(25);
  }
  throw typedError('isolated_child_ready_timeout');
}

function spawnChild(configFile, role) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const nodePaths = [
    path.join(repositoryRoot, 'node_modules'),
    path.join(repositoryRoot, 'cosmo23', 'node_modules'),
  ];
  const dotGit = path.join(repositoryRoot, '.git');
  try {
    const pointer = readFileSync(dotGit, 'utf8').trim();
    const match = /^gitdir:\s*(.+)$/.exec(pointer);
    if (match) {
      const gitDirectory = path.resolve(repositoryRoot, match[1]);
      const checkoutRoot = path.dirname(path.resolve(gitDirectory, '../..'));
      nodePaths.push(
        path.join(checkoutRoot, 'node_modules'),
        path.join(checkoutRoot, 'cosmo23', 'node_modules'),
      );
    }
  } catch { /* normal checkout has a .git directory */ }
  if (process.env.NODE_PATH) nodePaths.push(...process.env.NODE_PATH.split(path.delimiter));
  const childConfig = JSON.parse(readFileSync(configFile, 'utf8'));
  if (childConfig.role !== role || typeof childConfig.startToken !== 'string'
      || !/^[0-9a-f-]{36}$/i.test(childConfig.startToken)) {
    throw typedError('isolated_child_invocation_invalid');
  }
  const childEnv = {
    ...process.env,
    HOME23_ISOLATED_FIXTURE_CHILD: '1',
    NODE_PATH: [...new Set(nodePaths.filter((entry) => entry && existsSync(entry)))]
      .join(path.delimiter),
  };
  delete childEnv.SYNTHESIS_LLM_PROVIDER;
  delete childEnv.SYNTHESIS_LLM_MODEL;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--internal-role', role, '--config', configFile], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: childEnv,
  });
  OWNED_CHILDREN.set(child, {
    pid: child.pid,
    role,
    startToken: childConfig.startToken,
    configFile,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-64 * 1024); });
  child.fixtureStderr = () => stderr;
  return child;
}

async function stopChild(child) {
  if (!child) return { pid: null, signal: null, exited: true };
  const ownership = OWNED_CHILDREN.get(child);
  if (!ownership || ownership.pid !== child.pid
      || !Number.isSafeInteger(child.pid) || child.pid < 1) {
    throw typedError('isolated_child_not_owned');
  }
  if (child.exitCode !== null) return { pid: child.pid, signal: null, exited: true };
  const completed = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const timeout = Symbol('timeout');
  let result = await Promise.race([completed, sleep(CHILD_STOP_TIMEOUT_MS).then(() => timeout)]);
  if (result === timeout) {
    child.kill('SIGKILL');
    result = await completed;
  }
  return { pid: child.pid, signal: result.signal, code: result.code, exited: true };
}

async function assertFixtureOwnership(fixture, context) {
  const stat = await fsp.lstat(fixture.path, { bigint: true });
  const ownerFile = path.join(fixture.path, 'fixture-owner.json');
  let owner = await readJson(ownerFile).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!owner) {
    owner = {
      schemaVersion: 1,
      receiptRunId: context.receiptRunId,
      authority: context.authority,
      basename: path.basename(fixture.path),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      createdAt: new Date().toISOString(),
    };
    await fsp.writeFile(ownerFile, `${JSON.stringify(owner, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  }
  if (owner.receiptRunId !== context.receiptRunId || owner.authority !== 'isolated-controlled'
      || owner.basename !== path.basename(fixture.path)
      || owner.dev !== stat.dev.toString() || owner.ino !== stat.ino.toString()) {
    throw typedError('isolated_fixture_ownership_mismatch');
  }
  return owner;
}

export async function startIsolatedFixture({
  fixtureRoot,
  context,
  agent = 'acceptance-fixture',
  nodeCount = 2,
  edgeCount = 1,
  operationDelayMs = 100,
  pgsSynthesisIncomplete = false,
} = {}) {
  if (context?.authority !== 'isolated-controlled') throw typedError('isolated_fixture_authority_required');
  if (typeof agent !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(agent)
      || !Number.isSafeInteger(nodeCount) || nodeCount < 1 || nodeCount > 2_000_000
      || !Number.isSafeInteger(edgeCount) || edgeCount < 0 || edgeCount > 8_000_000
      || !Number.isSafeInteger(operationDelayMs) || operationDelayMs < 0
      || operationDelayMs > 60_000
      || typeof pgsSynthesisIncomplete !== 'boolean') {
    throw typedError('isolated_fixture_configuration_invalid');
  }
  const fixture = await canonicalDirectory(fixtureRoot, 'isolated fixture');
  if (isInsideOrEqual(REPOSITORY_ROOT, fixture.path)
      || isInsideOrEqual(fixture.path, REPOSITORY_ROOT)) {
    throw typedError('isolated_fixture_live_root_refused');
  }
  if (isInsideOrEqual(context.receiptRunDir, fixture.path)
      || isInsideOrEqual(fixture.path, context.receiptRunDir)) {
    throw typedError('isolated_fixture_receipt_overlap');
  }
  const owner = await assertFixtureOwnership(fixture, context);
  const source = await prepareSyntheticSource(
    fixture.path,
    agent,
    nodeCount,
    edgeCount,
    { canaryConcept: 'authoritative isolated own canary production pinned source' },
  );
  const siblingSource = await prepareSyntheticSource(
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
  await fsp.mkdir(runtime, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const capabilityKeyFile = path.join(runtime, `capability-${token}.key`);
  const capabilityKey = createHash('sha256')
    .update(`${fixture.path}\0${context.receiptRunId}\0${randomUUID()}`)
    .digest('hex');
  await fsp.writeFile(capabilityKeyFile, `${capabilityKey}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  const baseConfig = {
    fixtureRoot: fixture.path,
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
    operationDelayMs,
    pgsSynthesisIncomplete,
    startToken: token,
    capabilityKeyFile,
    operationsRoot: path.join(fixture.path, 'instances', agent, 'runtime', 'brain-operations'),
  };
  const cosmoConfigFile = path.join(runtime, `cosmo-${token}.json`);
  const cosmoReady = path.join(runtime, `cosmo-${token}.ready.json`);
  const cosmoMetrics = path.join(runtime, `cosmo-${token}.metrics.json`);
  await writeJsonAtomic(cosmoConfigFile, {
    ...baseConfig, role: 'cosmo', readyFile: cosmoReady, metricsFile: cosmoMetrics,
  });
  const cosmo = spawnChild(cosmoConfigFile, 'cosmo');
  let mcp = null;
  let dashboard = null;
  try {
    const cosmoIdentity = await waitReady(cosmoReady, cosmo);
    const mcpConfigFile = path.join(runtime, `mcp-${token}.json`);
    const mcpReady = path.join(runtime, `mcp-${token}.ready.json`);
    const mcpMetrics = path.join(runtime, `mcp-${token}.metrics.json`);
    await writeJsonAtomic(mcpConfigFile, {
      ...baseConfig, role: 'mcp', readyFile: mcpReady, metricsFile: mcpMetrics,
    });
    mcp = spawnChild(mcpConfigFile, 'mcp');
    const mcpIdentity = await waitReady(mcpReady, mcp);
    const dashboardConfigFile = path.join(runtime, `dashboard-${token}.json`);
    const dashboardReady = path.join(runtime, `dashboard-${token}.ready.json`);
    const dashboardMetrics = path.join(runtime, `dashboard-${token}.metrics.json`);
    await writeJsonAtomic(dashboardConfigFile, {
      ...baseConfig,
      role: 'dashboard',
      readyFile: dashboardReady,
      metricsFile: dashboardMetrics,
      cosmoBaseUrl: `http://127.0.0.1:${cosmoIdentity.port}`,
      mcpPort: mcpIdentity.port,
    });
    dashboard = spawnChild(dashboardConfigFile, 'dashboard');
    const dashboardIdentity = await waitReady(dashboardReady, dashboard);
    return {
      fixtureRoot: fixture.path,
      owner,
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
      pids: { dashboard: dashboard.pid, cosmo: cosmo.pid, mcp: mcp.pid },
      metrics: { dashboard: dashboardMetrics, cosmo: cosmoMetrics, mcp: mcpMetrics },
      children: { dashboard, cosmo, mcp },
      runtimeRoot: runtime,
      capabilityKeyFile,
      cosmoConfigFile,
      mcpConfigFile,
      dashboardConfigFile,
      async restartDashboard() {
        const stopped = await stopChild(this.children.dashboard);
        await fsp.rm(dashboardReady, { force: true });
        const next = spawnChild(dashboardConfigFile, 'dashboard');
        const ready = await waitReady(dashboardReady, next);
        this.children.dashboard = next;
        this.pids.dashboard = next.pid;
        this.ports.dashboard = ready.port;
        this.baseUrl = `http://127.0.0.1:${ready.port}`;
        return stopped;
      },
      async restartCoordinator() {
        const response = await fetch(`${this.baseUrl}/fixture/restart-coordinator`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        const value = await response.json();
        if (!response.ok || value?.ok !== true) {
          throw typedError(value?.error?.code || 'fixture_restart_failed');
        }
        return value;
      },
      async telemetry() {
        const [dashboardResponse, cosmoResponse] = await Promise.all([
          fetch(`${this.baseUrl}/telemetry`),
          fetch(`${this.cosmoBaseUrl}/telemetry`),
        ]);
        return {
          dashboard: await dashboardResponse.json(),
          cosmo: await cosmoResponse.json(),
        };
      },
      async operationTelemetry(operationId) {
        const response = await fetch(
          `${this.cosmoBaseUrl}/fixture/operations/${encodeURIComponent(operationId)}`,
        );
        const value = await response.json();
        if (!response.ok) throw typedError(value?.error?.code || 'fixture_telemetry_failed');
        return value;
      },
    };
  } catch (error) {
    await Promise.all([stopChild(dashboard), stopChild(mcp), stopChild(cosmo)]);
    error.fixtureStderr = {
      dashboard: dashboard?.fixtureStderr?.() || '',
      mcp: mcp?.fixtureStderr?.() || '',
      cosmo: cosmo.fixtureStderr?.() || '',
    };
    throw error;
  }
}

export async function stopIsolatedFixture(fixture) {
  const [dashboard, cosmo, mcp] = await Promise.all([
    stopChild(fixture?.children?.dashboard),
    stopChild(fixture?.children?.cosmo),
    stopChild(fixture?.children?.mcp),
  ]);
  return { dashboard, cosmo, mcp, retainedStore: fixture.operationsRoot };
}

async function internalMain(argv) {
  const roleIndex = argv.indexOf('--internal-role');
  const configIndex = argv.indexOf('--config');
  const role = roleIndex >= 0 ? argv[roleIndex + 1] : null;
  const configFile = configIndex >= 0 ? argv[configIndex + 1] : null;
  if (!INTERNAL_ROLE.has(role) || !configFile || process.env.HOME23_ISOLATED_FIXTURE_CHILD !== '1') {
    throw typedError('isolated_child_invocation_invalid');
  }
  const config = await readJson(path.resolve(configFile));
  if (config.role !== role || Object.hasOwn(config, 'capabilityKey')
      || typeof config.capabilityKeyFile !== 'string') {
    throw typedError('isolated_child_invocation_invalid');
  }
  const keyFile = path.resolve(config.capabilityKeyFile);
  if (!isInsideOrEqual(config.fixtureRoot, keyFile)
      || await fsp.realpath(keyFile) !== keyFile) {
    throw typedError('isolated_child_invocation_invalid');
  }
  const before = await fsp.lstat(keyFile, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || Number(before.mode & 0o777n) !== 0o600) {
    throw typedError('isolated_child_invocation_invalid');
  }
  const capabilityKey = (await fsp.readFile(keyFile, 'utf8')).trim();
  const after = await fsp.lstat(keyFile, { bigint: true });
  if (!/^[a-f0-9]{64}$/.test(capabilityKey)
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs) {
    throw typedError('isolated_child_invocation_invalid');
  }
  config.capabilityKey = capabilityKey;
  if (role === 'cosmo') return runCosmoChild(config);
  if (role === 'mcp') return runMcpChild(config);
  return runDashboardChild(config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  internalMain(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${JSON.stringify({ code: error.code || 'isolated_child_failed', message: error.message })}\n`);
    process.exit(1);
  });
}
