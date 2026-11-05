import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PublishLedger } from '../../../engine/src/publish/publish-ledger.js';
import {
  WorkspaceInsightsPublisher,
  createWorkspaceInsightsStarvationMonitor,
  attemptWorkspaceInsightsStartupCatchUp,
} from '../../../engine/src/publish/workspace-insights.js';

const silentLogger = { info() {}, warn() {} };

test('WorkspaceInsightsPublisher only writes on cadence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi-'));
  const pub = new WorkspaceInsightsPublisher({
    outDir: dir,
    cadenceCycles: 3,
    selectCluster: () => ({ topic: 'test', observations: [], summary: 's' }),
    ledger: { record: async () => {} },
    logger: silentLogger,
  });
  await pub.onCycle({ cycleIndex: 1 });
  assert.equal(readdirSync(dir).length, 0);
  await pub.onCycle({ cycleIndex: 3 });
  assert.equal(readdirSync(dir).length, 1);
});

test('WorkspaceInsightsPublisher skips when no cluster available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi2-'));
  const pub = new WorkspaceInsightsPublisher({
    outDir: dir, cadenceCycles: 1,
    selectCluster: () => null, ledger: { record: async () => {} },
    logger: silentLogger,
  });
  assert.equal(await pub.onCycle({ cycleIndex: 1 }), null);
  assert.equal(readdirSync(dir).length, 0);
});

test('workspace-insights startup catch-up force publishes when the ledger is starving', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi3-'));
  const ledger = new PublishLedger({
    path: join(dir, 'publish-ledger.jsonl'),
    starvationFloor: { workspace_insights: 6 * 3600 * 1000 },
  });
  const staleAt = 10_000;
  const now = staleAt + (7 * 3600 * 1000);
  await ledger.record({ target: 'workspace_insights', artifact: 'old.md', at: staleAt });
  const outDir = join(dir, 'insights');
  const pub = new WorkspaceInsightsPublisher({
    outDir,
    cadenceCycles: 50,
    selectCluster: () => ({ topic: 'test', observations: [], summary: 's' }),
    ledger,
    logger: silentLogger,
  });

  const result = await attemptWorkspaceInsightsStartupCatchUp({
    ledger,
    publisher: pub,
    now,
    logger: silentLogger,
  });

  assert.equal(typeof result, 'string');
  assert.equal(readdirSync(outDir).length, 1);
  assert.ok(ledger.lastAt('workspace_insights') > staleAt);
  assert.deepEqual(ledger.listStarving({ now }), []);
});

test('workspace-insights startup catch-up does not write a receipt when no cluster is available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi4-'));
  const ledger = new PublishLedger({
    path: join(dir, 'publish-ledger.jsonl'),
    starvationFloor: { workspace_insights: 6 * 3600 * 1000 },
  });
  const staleAt = 20_000;
  const now = staleAt + (7 * 3600 * 1000);
  await ledger.record({ target: 'workspace_insights', artifact: 'old.md', at: staleAt });
  const outDir = join(dir, 'insights');
  const pub = new WorkspaceInsightsPublisher({
    outDir,
    cadenceCycles: 50,
    selectCluster: () => null,
    ledger,
    logger: silentLogger,
  });

  const result = await attemptWorkspaceInsightsStartupCatchUp({
    ledger,
    publisher: pub,
    now,
    logger: silentLogger,
  });

  assert.equal(result, null);
  assert.equal(existsSync(outDir), false);
  assert.equal(ledger.lastAt('workspace_insights'), staleAt);
  assert.ok(ledger.listStarving({ now }).includes('workspace_insights'));
});

test('workspace-insights starvation monitor catches up workspace targets and leaves other starving targets reportable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi5-'));
  const ledger = new PublishLedger({
    path: join(dir, 'publish-ledger.jsonl'),
    starvationFloor: {
      workspace_insights: 6 * 3600 * 1000,
      dream_log: 6 * 3600 * 1000,
    },
  });
  const staleAt = 30_000;
  const now = staleAt + (7 * 3600 * 1000);
  await ledger.record({ target: 'workspace_insights', artifact: 'old-workspace.md', at: staleAt });
  await ledger.record({ target: 'dream_log', artifact: 'old-dream.md', at: staleAt });

  const publisher = new WorkspaceInsightsPublisher({
    outDir: join(dir, 'insights'),
    cadenceCycles: 50,
    selectCluster: () => ({ topic: 'test', observations: [], summary: 's' }),
    ledger,
    logger: silentLogger,
  });
  const monitor = createWorkspaceInsightsStarvationMonitor({
    ledger,
    publisher,
    logger: silentLogger,
    now: () => now,
  });

  const starving = await monitor();

  assert.deepEqual(starving, ['dream_log']);
  assert.ok(!ledger.listStarving({ now }).includes('workspace_insights'));
  assert.ok(ledger.listStarving({ now }).includes('dream_log'));
});

test('workspace-insights starvation monitor leaves workspace target starving when no cluster is available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi6-'));
  const ledger = new PublishLedger({
    path: join(dir, 'publish-ledger.jsonl'),
    starvationFloor: { workspace_insights: 6 * 3600 * 1000 },
  });
  const staleAt = 40_000;
  const now = staleAt + (7 * 3600 * 1000);
  await ledger.record({ target: 'workspace_insights', artifact: 'old-workspace.md', at: staleAt });

  const publisher = new WorkspaceInsightsPublisher({
    outDir: join(dir, 'insights'),
    cadenceCycles: 50,
    selectCluster: () => null,
    ledger,
    logger: silentLogger,
  });
  const monitor = createWorkspaceInsightsStarvationMonitor({
    ledger,
    publisher,
    logger: silentLogger,
    now: () => now,
  });

  const starving = await monitor();

  assert.deepEqual(starving, ['workspace_insights']);
  assert.equal(ledger.lastAt('workspace_insights'), staleAt);
});

test('workspace-insights starvation monitor collapses concurrent catch-up attempts into a single forced publish', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wi7-'));
  const ledger = new PublishLedger({
    path: join(dir, 'publish-ledger.jsonl'),
    starvationFloor: { workspace_insights: 6 * 3600 * 1000 },
  });
  const staleAt = 50_000;
  const now = staleAt + (7 * 3600 * 1000);
  await ledger.record({ target: 'workspace_insights', artifact: 'old-workspace.md', at: staleAt });

  let publishCalls = 0;
  let releasePublish = null;
  const publishBlocked = new Promise((resolve) => {
    releasePublish = resolve;
  });
  const publisher = {
    async forcePublish() {
      publishCalls += 1;
      await publishBlocked;
      await ledger.record({ target: 'workspace_insights', artifact: `catch-up-${publishCalls}.md`, at: now });
      return `catch-up-${publishCalls}.md`;
    },
  };
  const monitor = createWorkspaceInsightsStarvationMonitor({
    ledger,
    publisher,
    logger: silentLogger,
    now: () => now,
  });

  const first = monitor();
  const second = monitor();
  releasePublish();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(publishCalls, 1);
  assert.deepEqual(firstResult, []);
  assert.deepEqual(secondResult, []);
  assert.equal(ledger.lastAt('workspace_insights'), now);
});
