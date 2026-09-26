// H23-003: brain_search reads the persisted memory manifest, never live
// memory, and a feeder commit reached it only when a cognitive cycle finished
// a save. These tests drive the real feeder, NetworkMemory, saveState and
// memory persistence with no executeCycle and no restart, and search the brain
// the way brain_search does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'openai') return class OpenAI {};
  if (request === 'dotenv') return { config() {} };
  if (request === 'tiktoken') return { encoding_for_model: () => ({ encode: () => [], free() {} }) };
  if (request.endsWith('/core/openai-client') || request === '../core/openai-client') {
    return { getOpenAIClient: () => null, getEmbeddingClient: () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
};
const { NetworkMemory } = require('../../../engine/src/memory/network-memory.js');
Module._load = originalLoad;
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');
const persistence = require('../../../engine/src/core/memory-persistence.js');
const { PersistenceScheduler } = require('../../../engine/src/core/persistence-scheduler.js');
const { DocumentFeeder } = require('../../../engine/src/ingestion/document-feeder.js');
const { createMemorySearchService } = require('../../../engine/src/dashboard/memory-search.js');
const { createMemoryDeltaOverlayCache } = require('../../../engine/src/dashboard/memory-delta-overlay-cache.js');
const { runVerifier } = require('../../../engine/src/live-problems/verifiers.js');
const { openMemorySource, readManifest, rewriteMemoryBase } = require('../../../shared/memory-source');

const CANARY = 'amber-kestrel-7429';
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

async function waitFor(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

// A small resident home: a brain with two older memories, its engine state
// shell, the scheduler as the orchestrator wires it, and a started feeder.
async function createHome(t) {
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-feeder-freshness-'));
  const brainDir = path.join(home23Root, 'instances', 'coz', 'brain');
  const docs = path.join(home23Root, 'documents');
  await fsp.mkdir(brainDir, { recursive: true });
  await fsp.mkdir(docs, { recursive: true });
  const older = [0, 1].map((index) => ({ id: `older-${index}`, concept: `unrelated mineral specimen ${index}`, embedding: [0, 1] }));
  await rewriteMemoryBase(brainDir, {
    nodes: older, edges: [], summary: { nodeCount: 2, edgeCount: 0, clusterCount: 0 },
  }, { lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') });

  const memory = new NetworkMemory({
    embedding: {},
    coordinator: {},
    smallWorld: { maxBridgesPerNode: 40 },
    spreading: { maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8 },
    hebbian: { enabled: false, reinforcementStrength: 0.1 },
    decay: { baseFactor: 0.95, minimumWeight: 0.01, decayInterval: 300, exemptTags: [] },
  }, quiet);
  memory.tokenizer = null;
  const loaded = await persistence.loadMemoryRevision(brainDir, { home23Root });
  memory.importGraphChanges({ nodes: loaded.nodes, edges: loaded.edges });
  memory.markPersistenceClean();

  const orchestrator = Object.create(Orchestrator.prototype);
  Object.assign(orchestrator, {
    logger: quiet, memory, logsDir: brainDir, home23Root, config: { persistence: {} },
    cycleCount: 12, journal: [], lastSummarization: 0, reasoningHistory: [], webSearchCount: 0,
    goals: { export: () => ({ active: [], completed: [], archived: [] }) },
    roles: { getRoles: () => [] },
    reflection: { export: () => ({}) },
    oscillator: { getStats: () => ({}) },
    stateModulator: { getState: () => ({ mode: 'active' }) },
    sleepSession: { active: false, startCycle: 0, consolidationRun: false, noticePassRun: false },
  });
  // Orchestrator wiring, with test-sized delays; no cycle ever runs here.
  orchestrator.persistenceScheduler = new PersistenceScheduler({
    isDirty: () => memory.hasPersistenceChanges(),
    isSaving: () => Boolean(orchestrator._saveStatePromise),
    save: () => orchestrator.saveState(),
    logger: quiet,
    tickMs: 100,
    requestDelayMs: 25,
    minIntervalMs: 25,
  });
  orchestrator.feeder = new DocumentFeeder({
    memory,
    config: { compiler: { enabled: false }, missingPathRetrySeconds: 3600, flush: { intervalSeconds: 3600 } },
    logger: quiet,
    embeddingFn: async (text) => (text.includes(CANARY) ? [1, 0] : [0, 1]),
    onCommitted: () => orchestrator.persistenceScheduler.request('feeder'),
  });
  await orchestrator.feeder.start(brainDir);
  orchestrator.persistenceScheduler.start();
  t.after(async () => {
    orchestrator.persistenceScheduler.stop();
    await orchestrator.feeder.shutdown();
    await orchestrator._saveStatePromise?.catch(() => {});
    // saveState's background backup rotation may still be writing here.
    await fsp.rm(home23Root, { recursive: true, force: true, maxRetries: 5 });
  });
  const canaryFile = path.join(docs, 'field-notes.md');
  await fsp.writeFile(canaryFile, `# Field notes\n\nThe ${CANARY} canary nests above the orchard gate.\n`);
  return { home23Root, brainDir, memory, orchestrator, canaryFile };
}

async function searchBrain(brainDir, query) {
  const source = await openMemorySource(brainDir);
  const cacheRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-freshness-search-cache-'));
  const service = createMemorySearchService({
    brainDir,
    embedQuery: async () => [1, 0],
    loadAnn: async () => null,
    deltaOverlayCache: createMemoryDeltaOverlayCache({ cacheRoot }),
    logger: { warn() {} },
  });
  try {
    const result = await service.search({
      sourcePin: source,
      identity: { operationId: 'freshness-search', requesterAgent: 'coz', brainId: 'coz' },
      query,
      topK: 5,
      minSimilarity: 0.1,
      noiseFloor: 0.1,
    });
    return result.results.some((row) => String(row.concept || '').includes(CANARY));
  } finally {
    await source.close();
    await fsp.rm(cacheRoot, { recursive: true, force: true });
  }
}

test('a feeder commit becomes searchable through the scheduler, with no cycle and no restart', async (t) => {
  const { brainDir, memory, orchestrator, canaryFile } = await createHome(t);
  const scheduler = orchestrator.persistenceScheduler;
  const revisionBefore = (await readManifest(brainDir)).currentRevision;
  let requests = 0;
  const request = scheduler.request.bind(scheduler);
  // Hold the save until the unsaved state has been searched.
  scheduler.request = (reason) => { requests += 1; };

  await orchestrator.feeder.ingestFile(canaryFile, 'notes');
  assert.equal(requests, 1, 'the feeder commit asked for a save');
  assert.ok([...memory.nodes.values()].some((node) => node.concept.includes(CANARY)), 'live memory has it');
  assert.equal(await searchBrain(brainDir, CANARY), false, 'search reads saved memory only');
  assert.equal(orchestrator.getPersistenceFreshness().dirty, true);

  const committedAt = Date.now();
  scheduler.request = request;
  scheduler.request('feeder');
  assert.equal(await waitFor(() => scheduler.status().lastPersistedAt !== null), true, 'the scheduler saved');
  const durableMs = Date.parse(scheduler.status().lastPersistedAt) - committedAt;
  assert.ok(durableMs < 60_000, `durable ${durableMs} ms after the commit`);
  assert.equal(await searchBrain(brainDir, CANARY), true, 'brain search finds the document');

  const manifest = await readManifest(brainDir);
  assert.ok(manifest.currentRevision > revisionBefore, 'the persisted revision advanced');
  const freshness = orchestrator.getPersistenceFreshness();
  assert.equal(freshness.dirty, false);
  assert.equal(freshness.persistedRevision, manifest.currentRevision);
  assert.equal(freshness.consecutiveRefusals, 0);
  assert.equal(freshness.lastFlushNodes, 1);
  assert.ok(Date.parse(freshness.lastFlushAt) <= Date.parse(freshness.lastPersistedAt));
  assert.equal(freshness.lastSaveResult.memoryRevision, manifest.currentRevision);
  const alarm = await runVerifier(
    { type: 'brain_persistence_fresh', args: { maxDirtyMinutes: 10, maxConsecutiveRefusals: 3 } },
    { persistenceFreshness: () => orchestrator.getPersistenceFreshness() },
  );
  assert.equal(alarm.ok, true);
});

test('a failing memory writer keeps the document unsearchable and reports a stale, refused save', async (t) => {
  const original = persistence.persistMemoryRevision;
  persistence.persistMemoryRevision = async () => { throw new Error('memory writer failed'); };
  t.after(() => { persistence.persistMemoryRevision = original; });
  const { brainDir, orchestrator, canaryFile } = await createHome(t);
  const scheduler = orchestrator.persistenceScheduler;

  await orchestrator.feeder.ingestFile(canaryFile, 'notes');
  assert.equal(await waitFor(() => scheduler.status().consecutiveRefusals >= 1), true);
  const freshness = orchestrator.getPersistenceFreshness();
  // This two-node brain still saves its state inline, but not the memory
  // source that search reads: a refusal, not a clean success.
  assert.equal(orchestrator.lastSaveResult.saved, true);
  assert.equal(orchestrator.lastSaveResult.sidecars, 'inline');
  assert.equal(freshness.searchStale, true);
  assert.equal(freshness.dirty, true);
  assert.equal(freshness.lastPersistedAt, null);
  assert.equal(freshness.lastSaveResult.searchStale, true);
  assert.ok(freshness.nextSaveNotBefore, 'the scheduler backs off');
  assert.equal(await searchBrain(brainDir, CANARY), false);
  const alarm = await runVerifier(
    { type: 'brain_persistence_fresh', args: { maxDirtyMinutes: 10, maxConsecutiveRefusals: 1 } },
    { persistenceFreshness: () => orchestrator.getPersistenceFreshness() },
  );
  assert.equal(alarm.ok, false);
  assert.match(alarm.detail, /did not persist memory \(saved inline, memory source not updated\)/);
});
