import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createWorkerHandlers } from '../../src/workers/connector.js';

test('worker handlers list workers through injected dependencies', async () => {
  const handlers = createWorkerHandlers({
    projectRoot: '/tmp/home23',
    listWorkers: () => [{ name: 'systems', displayName: 'Systems', ownerAgent: 'jerry', class: 'ops', purpose: 'Diagnose' }],
    listTemplates: () => [],
    runWorker: async () => { throw new Error('not used'); },
    readRunReceipt: async () => { throw new Error('not used'); }
  });

  const result = await handlers.listWorkers();
  assert.equal(result.workers[0].name, 'systems');
});

test('worker handlers start a run through injected runner', async () => {
  const handlers = createWorkerHandlers({
    projectRoot: '/tmp/home23',
    listWorkers: () => [],
    listTemplates: () => [],
    runWorker: async request => ({
      runId: 'wr_1',
      runPath: '/tmp/home23/instances/workers/systems/runs/wr_1',
      receipt: {
        schema: 'home23.worker-run.v1',
        runId: 'wr_1',
        worker: 'systems',
        ownerAgent: 'jerry',
        requestedBy: request.requestedBy,
        startedAt: '2026-05-02T00:00:00.000Z',
        finishedAt: '2026-05-02T00:01:00.000Z',
        status: 'no_change',
        verifierStatus: 'pass',
        summary: request.prompt,
        actions: [],
        evidence: [],
        artifacts: [],
        memoryCandidates: []
      }
    }),
    readRunReceipt: async () => { throw new Error('not used'); }
  });

  const result = await handlers.startRun('systems', { prompt: 'check host', requestedBy: 'api' });
  assert.equal(result.runId, 'wr_1');
  assert.equal(result.receipt.summary, 'check host');
});

test('worker handlers promote memory candidates for an existing receipt', async () => {
  const handlers = createWorkerHandlers({
    projectRoot: '/tmp/home23',
    listWorkers: () => [],
    listTemplates: () => [],
    runWorker: async () => { throw new Error('not used'); },
    readRunReceipt: async () => ({
      schema: 'home23.worker-run.v1',
      runId: 'wr_1',
      worker: 'systems',
      ownerAgent: 'jerry',
      requestedBy: 'api',
      startedAt: '2026-05-02T00:00:00.000Z',
      finishedAt: '2026-05-02T00:01:00.000Z',
      status: 'no_change',
      verifierStatus: 'pass',
      summary: 'checked',
      actions: [],
      evidence: [],
      artifacts: [],
      memoryCandidates: [{ text: 'Use scoped PM2 checks first.', confidence: 0.9 }]
    })
  });

  const result = await handlers.promoteMemory('wr_1');
  assert.equal(result.runId, 'wr_1');
  assert.equal(result.candidates, 1);
  assert.equal(result.status, 'ready_for_memory_curator');
});

test('worker handlers preserve receipt source in run summaries', async () => {
  const root = path.join(tmpdir(), `home23-worker-connector-${process.pid}-${Date.now()}`);
  try {
    const workerRoot = path.join(root, 'instances', 'workers', 'systems');
    const runRoot = path.join(workerRoot, 'runs', 'wr_good_life');
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(path.join(workerRoot, 'worker.yaml'), [
      'kind: worker',
      'name: systems',
      'displayName: Systems',
      'ownerAgent: jerry',
      'class: ops',
      'purpose: Diagnose host issues',
      '',
    ].join('\n'));
    writeFileSync(path.join(runRoot, 'receipt.json'), `${JSON.stringify({
      schema: 'home23.worker-run.v1',
      runId: 'wr_good_life',
      worker: 'systems',
      ownerAgent: 'forrest',
      requestedBy: 'good-life',
      requester: 'home23-dashboard',
      startedAt: '2026-05-09T15:00:00.000Z',
      finishedAt: '2026-05-09T15:01:00.000Z',
      status: 'no_change',
      verifierStatus: 'pass',
      summary: 'checked stale Good Life agenda',
      actions: [],
      evidence: [],
      artifacts: [],
      memoryCandidates: [],
      source: { type: 'good-life-agenda', id: 'ag-123', url: '/api/agenda/ag-123' },
    }, null, 2)}\n`);

    const handlers = createWorkerHandlers({
      projectRoot: root,
      listWorkers: () => [],
      listTemplates: () => [],
      runWorker: async () => { throw new Error('not used'); },
    });

    const result = await handlers.listRuns();
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].requestedBy, 'good-life');
    assert.equal(result.runs[0].requester, 'home23-dashboard');
    assert.deepEqual(result.runs[0].source, { type: 'good-life-agenda', id: 'ag-123', url: '/api/agenda/ag-123' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker handlers mark old receiptless runs as stale instead of running', async () => {
  const root = path.join(tmpdir(), `home23-worker-connector-stale-${process.pid}-${Date.now()}`);
  try {
    const workerRoot = path.join(root, 'instances', 'workers', 'systems');
    const runRoot = path.join(workerRoot, 'runs', 'wr_20200101T000000Z_systems_dead');
    mkdirSync(runRoot, { recursive: true });
    writeFileSync(path.join(workerRoot, 'worker.yaml'), [
      'kind: worker',
      'name: systems',
      'displayName: Systems',
      'ownerAgent: jerry',
      'class: ops',
      'purpose: Diagnose host issues',
      '',
    ].join('\n'));
    writeFileSync(path.join(runRoot, 'input.md'), 'diagnose host\n');

    const handlers = createWorkerHandlers({
      projectRoot: root,
      listWorkers: () => [],
      listTemplates: () => [],
      runWorker: async () => { throw new Error('not used'); },
    });

    const result = await handlers.listRuns();
    assert.equal(result.runs.length, 1);
    assert.equal(result.runs[0].status, 'stale');
    assert.equal(result.runs[0].stale, true);
    assert.equal(result.runs[0].startedAt, '2020-01-01T00:00:00.000Z');
    assert.match(result.runs[0].summary || '', /No worker receipt found/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worker handlers can filter run summaries by owner agent', async () => {
  const root = path.join(tmpdir(), `home23-worker-connector-owner-${process.pid}-${Date.now()}`);
  try {
    const workerRoot = path.join(root, 'instances', 'workers', 'systems');
    mkdirSync(path.join(workerRoot, 'runs', 'wr_jerry'), { recursive: true });
    mkdirSync(path.join(workerRoot, 'runs', 'wr_forrest'), { recursive: true });
    writeFileSync(path.join(workerRoot, 'worker.yaml'), [
      'kind: worker',
      'name: systems',
      'displayName: Systems',
      'ownerAgent: jerry',
      'class: ops',
      'purpose: Diagnose host issues',
      '',
    ].join('\n'));
    for (const [runId, ownerAgent] of [['wr_jerry', 'jerry'], ['wr_forrest', 'forrest']]) {
      writeFileSync(path.join(workerRoot, 'runs', runId, 'receipt.json'), `${JSON.stringify({
        schema: 'home23.worker-run.v1',
        runId,
        worker: 'systems',
        ownerAgent,
        requestedBy: 'api',
        startedAt: '2026-05-09T15:00:00.000Z',
        finishedAt: ownerAgent === 'jerry' ? '2026-05-09T15:01:00.000Z' : '2026-05-09T15:02:00.000Z',
        status: 'no_change',
        verifierStatus: 'pass',
        summary: `${ownerAgent} check`,
        actions: [],
        evidence: [],
        artifacts: [],
        memoryCandidates: [],
      }, null, 2)}\n`);
    }

    const handlers = createWorkerHandlers({
      projectRoot: root,
      listWorkers: () => [],
      listTemplates: () => [],
      runWorker: async () => { throw new Error('not used'); },
    });

    const allRuns = await handlers.listRuns();
    const forrestRuns = await handlers.listRuns({ ownerAgent: 'forrest' });
    assert.deepEqual(allRuns.runs.map(run => run.ownerAgent).sort(), ['forrest', 'jerry']);
    assert.equal(forrestRuns.runs.length, 1);
    assert.equal(forrestRuns.runs[0].runId, 'wr_forrest');
    assert.equal(forrestRuns.runs[0].ownerAgent, 'forrest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
