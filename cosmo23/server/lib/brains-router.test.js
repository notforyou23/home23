const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createBrainsRouter } = require('./brains-router');
const {
  listBrains,
  resolveBrainBySelector,
  importReferenceBrain
} = require('./brain-registry');
const {
  getSnapshotsDir,
  loadContinuationSnapshots
} = require('./continuation-state');

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-brains-router-'));
}

async function writeRunMetadata(runPath, overrides = {}) {
  await fs.mkdir(runPath, { recursive: true });
  await fs.writeFile(path.join(runPath, 'run-metadata.json'), JSON.stringify({
    explorationMode: 'guided',
    effectiveExecutionMode: 'guided-exclusive',
    researchDomain: 'Jerry Garcia Health',
    researchContext: 'Initial context',
    maxCycles: '80',
    reviewPeriod: 20,
    maxConcurrent: 4,
    enableWebSearch: true,
    primaryProvider: 'openai',
    primaryModel: 'gpt-5.2',
    fastProvider: 'openai',
    fastModel: 'gpt-5-mini',
    strategicProvider: 'openai',
    strategicModel: 'gpt-5.2',
    ...overrides
  }, null, 2));

  await fs.writeFile(path.join(runPath, 'metadata.json'), JSON.stringify({
    runName: path.basename(runPath),
    topic: overrides.topic || 'Jerry Garcia Health',
    context: overrides.context || 'Initial context',
    cycles: 80,
    maxConcurrent: 4,
    enableExperimental: false,
    primaryProvider: 'openai',
    primaryModel: 'gpt-5.2',
    fastProvider: 'openai',
    fastModel: 'gpt-5-mini',
    strategicProvider: 'openai',
    strategicModel: 'gpt-5.2'
  }, null, 2));
}

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('GET /api/brains/:brainId returns continuation detail for the selected run', async () => {
  const root = await makeTempDir();
  const localRunsPath = path.join(root, 'runs');
  const runPath = path.join(localRunsPath, 'jobhealth2');
  await writeRunMetadata(runPath);

  const app = express();
  app.use(express.json());
  app.use(createBrainsRouter({
    getRunsOptions: async () => ({
      localRunsPath,
      referenceRunsPaths: [],
      activeRunPath: null
    }),
    getActiveContext: () => null,
    listBrains,
    resolveBrainBySelector,
    launchResearch: async () => {
      throw new Error('launch should not be called');
    }
  }));

  await withServer(app, async baseUrl => {
    const brainsResponse = await fetch(`${baseUrl}/api/brains`);
    const brainsPayload = await brainsResponse.json();
    const brainId = brainsPayload.brains[0].routeKey;

    const response = await fetch(`${baseUrl}/api/brains/${brainId}`);
    assert.equal(response.status, 200);
    const payload = await response.json();

    assert.equal(payload.brain.name, 'jobhealth2');
    assert.equal(payload.initialSettings.topic, 'Jerry Garcia Health');
    assert.equal(payload.effectiveContinueSettings.maxConcurrent, 4);
    assert.equal(payload.latestSnapshot, null);
    assert.deepEqual(payload.snapshots, []);
  });
});

test('POST /api/continue/:brainId merges latest snapshot settings and writes a new snapshot after launch', async () => {
  const root = await makeTempDir();
  const localRunsPath = path.join(root, 'runs');
  const runPath = path.join(localRunsPath, 'jobhealth2');
  await writeRunMetadata(runPath);

  const launchedPayloads = [];
  const app = express();
  app.use(express.json());
  app.use(createBrainsRouter({
    getRunsOptions: async () => ({
      localRunsPath,
      referenceRunsPaths: [],
      activeRunPath: null
    }),
    getActiveContext: () => null,
    listBrains,
    resolveBrainBySelector,
    launchResearch: async payload => {
      launchedPayloads.push(payload);
      const brain = await resolveBrainBySelector(payload.brainId, {
        localRunsPath,
        referenceRunsPaths: [],
        activeRunPath: null
      });
      return {
        success: true,
        runName: brain.name,
        brainId: brain.routeKey,
        brainPath: brain.path,
        wsUrl: 'ws://example.test',
        dashboardUrl: 'http://example.test/dashboard'
      };
    }
  }));

  await withServer(app, async baseUrl => {
    const brainsPayload = await (await fetch(`${baseUrl}/api/brains`)).json();
    const brainId = brainsPayload.brains[0].routeKey;

    const firstResponse = await fetch(`${baseUrl}/api/continue/${brainId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: 'First continuation context',
        maxConcurrent: 6
      })
    });
    assert.equal(firstResponse.status, 200);

    const secondResponse = await fetch(`${baseUrl}/api/continue/${brainId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        maxConcurrent: 8
      })
    });
    assert.equal(secondResponse.status, 200);

    assert.equal(launchedPayloads[0].context, 'First continuation context');
    assert.equal(launchedPayloads[0].maxConcurrent, 6);
    assert.equal(launchedPayloads[1].context, 'First continuation context');
    assert.equal(launchedPayloads[1].maxConcurrent, 8);

    const snapshots = await loadContinuationSnapshots(runPath);
    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].baseSnapshotId, snapshots[1].id);
    assert.deepEqual(snapshots[0].changedFields, ['maxConcurrent']);

    const initialSnapshotContent = JSON.parse(
      await fs.readFile(path.join(getSnapshotsDir(runPath), 'initial-launch.json'), 'utf8')
    );
    assert.equal(initialSnapshotContent.settings.context, 'Initial context');
  });
});

test('POST /api/continue/:brainId imports reference brains before creating local snapshots', async () => {
  const root = await makeTempDir();
  const localRunsPath = path.join(root, 'runs');
  const referenceRunsPath = path.join(root, 'reference-runs');
  const referenceRunPath = path.join(referenceRunsPath, 'reference-brain');
  await writeRunMetadata(referenceRunPath, {
    topic: 'Reference topic',
    context: 'Reference context'
  });

  const app = express();
  app.use(express.json());
  app.use(createBrainsRouter({
    getRunsOptions: async () => ({
      localRunsPath,
      referenceRunsPaths: [referenceRunsPath],
      activeRunPath: null
    }),
    getActiveContext: () => null,
    listBrains,
    resolveBrainBySelector,
    launchResearch: async payload => {
      const selected = await resolveBrainBySelector(payload.brainId, {
        localRunsPath,
        referenceRunsPaths: [referenceRunsPath],
        activeRunPath: null
      });
      const localBrain = selected.sourceType === 'reference'
        ? await importReferenceBrain(selected, localRunsPath)
        : selected;
      return {
        success: true,
        runName: localBrain.name,
        brainId: localBrain.routeKey,
        brainPath: localBrain.path,
        wsUrl: 'ws://example.test',
        dashboardUrl: 'http://example.test/dashboard'
      };
    }
  }));

  await withServer(app, async baseUrl => {
    const brainsPayload = await (await fetch(`${baseUrl}/api/brains`)).json();
    const referenceBrain = brainsPayload.brains.find(brain => brain.sourceType === 'reference');
    assert.ok(referenceBrain, 'expected a reference brain');

    const response = await fetch(`${baseUrl}/api/continue/${referenceBrain.routeKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: 'Imported continuation context'
      })
    });
    assert.equal(response.status, 200);

    const localEntries = await fs.readdir(localRunsPath);
    assert.equal(localEntries.length, 1);
    const importedRunPath = path.join(localRunsPath, localEntries[0]);

    const importedSnapshots = await loadContinuationSnapshots(importedRunPath);
    assert.equal(importedSnapshots.length, 1);
    assert.equal(importedSnapshots[0].sourceType, 'reference');
    assert.equal(importedSnapshots[0].settings.context, 'Imported continuation context');

    const referenceSnapshotDir = path.join(referenceRunPath, 'continuation-snapshots');
    await assert.rejects(fs.access(referenceSnapshotDir));
  });
});
