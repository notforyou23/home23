const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeBrainMetadataToSettings,
  normalizeUiSettings,
  mergeContinuationPayload,
  getChangedFields,
  getBrainContinuationState,
  ensureInitialLaunchSnapshot,
  writeContinuationSnapshot
} = require('./continuation-state');

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-continuation-state-'));
}

test('normalizeBrainMetadataToSettings maps runtime metadata into UI form settings', () => {
  const settings = normalizeBrainMetadataToSettings({
    brain: {
      name: 'jgbhealth',
      topic: 'Jerry Garcia Health'
    },
    runtimeMetadata: {
      explorationMode: 'guided',
      executionMode: 'strict',
      effectiveExecutionMode: 'guided-exclusive',
      researchDomain: 'Jerry Garcia Health',
      researchContext: 'Primary sources first',
      depth: 'deep',
      maxCycles: '120',
      maxRuntimeMinutes: 45,
      reviewPeriod: 12,
      maxConcurrent: 6,
      enableWebSearch: true,
      enableSleep: false,
      enableCodingAgents: false,
      enableIntrospection: true,
      enableAgentRouting: false,
      enableRecursiveMode: false,
      enableMemoryGovernance: true,
      enableFrontier: true,
      enableIDEFirst: true,
      enableDirectAction: true,
      enableStabilization: true,
      enableConsolidationMode: false,
      enableExperimental: true,
      primaryProvider: 'openai',
      primaryModel: 'gpt-5.2',
      fastProvider: 'openai',
      fastModel: 'gpt-5-mini',
      strategicProvider: 'anthropic',
      strategicModel: 'claude-sonnet-4-6',
      localLlmBaseUrl: 'http://localhost:11434/v1',
      searxngUrl: 'http://localhost:8888'
    },
    webMetadata: {
      topic: '',
      context: '',
      cycles: 80
    }
  });

  assert.equal(settings.topic, 'Jerry Garcia Health');
  assert.equal(settings.context, 'Primary sources first');
  assert.equal(settings.runName, 'jgbhealth');
  assert.equal(settings.executionMode, 'guided-exclusive');
  assert.equal(settings.analysisDepth, 'deep');
  assert.equal(settings.cycles, 80);
  assert.equal(settings.maxRuntimeMinutes, 45);
  assert.equal(settings.maxConcurrent, 6);
  assert.equal(settings.enableSleep, false);
  assert.equal(settings.enableDirectAction, true);
  assert.equal(settings.primaryModel, 'gpt-5.2');
  assert.equal(settings.strategicProvider, 'anthropic');
});

test('mergeContinuationPayload preserves base settings and route param wins', () => {
  const base = normalizeUiSettings({
    topic: 'Original',
    runName: 'jobhealth2',
    cycles: 80,
    maxConcurrent: 4,
    enableExperimental: false,
    strategicModel: 'gpt-5.2'
  });

  const merged = mergeContinuationPayload(base, {
    topic: '',
    maxConcurrent: 7,
    enableExperimental: true
  }, 'brain-123');

  assert.equal(merged.topic, '');
  assert.equal(merged.runName, 'jobhealth2');
  assert.equal(merged.maxConcurrent, 7);
  assert.equal(merged.enableExperimental, true);
  assert.equal(merged.strategicModel, 'gpt-5.2');
  assert.equal(merged.brainId, 'brain-123');
});

test('getChangedFields reports only fields modified from the continuation base', () => {
  const base = normalizeUiSettings({
    topic: 'Original',
    maxConcurrent: 4,
    enableExperimental: false,
    primaryModel: 'gpt-5.2'
  });
  const next = normalizeUiSettings({
    ...base,
    topic: 'Updated',
    enableExperimental: true
  });

  assert.deepEqual(getChangedFields(base, next), ['topic', 'enableExperimental']);
});

test('getBrainContinuationState picks the latest continuation snapshot as the effective base', async () => {
  const runPath = await makeTempDir();
  await fs.writeFile(path.join(runPath, 'run-metadata.json'), JSON.stringify({
    explorationMode: 'guided',
    effectiveExecutionMode: 'guided-exclusive',
    researchDomain: 'Jerry Garcia Health',
    researchContext: 'Base context',
    maxCycles: '80'
  }, null, 2));
  await fs.writeFile(path.join(runPath, 'metadata.json'), JSON.stringify({
    runName: 'jobhealth2',
    cycles: 80,
    enableExperimental: false
  }, null, 2));

  await ensureInitialLaunchSnapshot(runPath, {
    brainId: 'brain-local',
    runName: 'jobhealth2',
    sourceType: 'local',
    settings: {
      topic: 'Jerry Garcia Health',
      context: 'Base context',
      runName: 'jobhealth2',
      cycles: 80
    }
  });

  await writeContinuationSnapshot(runPath, {
    createdAt: '2026-03-14T17:06:01.454Z',
    brainId: 'brain-local',
    runName: 'jobhealth2',
    sourceType: 'local',
    settings: {
      topic: 'Jerry Garcia Health',
      context: 'Continuation context',
      runName: 'jobhealth2',
      cycles: 100
    },
    changedFields: ['context', 'cycles'],
    baseSnapshotId: null
  });

  await writeContinuationSnapshot(runPath, {
    createdAt: '2026-03-14T18:10:05.222Z',
    brainId: 'brain-local',
    runName: 'jobhealth2',
    sourceType: 'local',
    settings: {
      topic: 'Jerry Garcia Health',
      context: 'Latest continuation context',
      runName: 'jobhealth2',
      cycles: 120
    },
    changedFields: ['context', 'cycles'],
    baseSnapshotId: '20260314T170601454Z'
  });

  const state = await getBrainContinuationState({
    id: 'brain-local',
    routeKey: 'brain-local',
    name: 'jobhealth2',
    path: runPath,
    sourceType: 'local',
    topic: 'Jerry Garcia Health'
  });

  assert.equal(state.initialSettings.topic, 'Jerry Garcia Health');
  assert.equal(state.snapshotCount, 2);
  assert.equal(state.lastSnapshotAt, '2026-03-14T18:10:05.222Z');
  assert.equal(state.latestSnapshot.id, '20260314T181005222Z');
  assert.equal(state.effectiveContinueSettings.context, 'Latest continuation context');
  assert.equal(state.effectiveContinueSettings.cycles, 120);
});
