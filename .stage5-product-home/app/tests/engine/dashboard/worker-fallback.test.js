import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DashboardServer } = require('../../../engine/src/dashboard/server.js');

function makeServer(root) {
  const server = Object.create(DashboardServer.prototype);
  server.getHome23Root = () => root;
  return server;
}

function writeWorker(root, name = 'systems') {
  const workerRoot = path.join(root, 'instances', 'workers', name);
  fs.mkdirSync(path.join(workerRoot, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(workerRoot, 'worker.yaml'), [
    'kind: worker',
    `name: ${name}`,
    'displayName: Systems',
    'ownerAgent: jerry',
    'class: ops',
    'purpose: Diagnose Home23 systems',
    '',
  ].join('\n'));
  return workerRoot;
}

test('dashboard worker fallback lists worker runs from disk when connector is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-dashboard-worker-fallback-'));
  try {
    const workerRoot = writeWorker(root);
    const runRoot = path.join(workerRoot, 'runs', 'wr_20260510T010203Z_systems_abcd');
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(path.join(runRoot, 'receipt.json'), JSON.stringify({
      schema: 'home23.worker-run.v1',
      runId: 'wr_20260510T010203Z_systems_abcd',
      worker: 'systems',
      ownerAgent: 'jerry',
      requestedBy: 'good-life',
      requester: 'home23-dashboard',
      source: { type: 'good-life-agenda', id: 'ag-1' },
      status: 'no_change',
      verifierStatus: 'pass',
      startedAt: '2026-05-10T01:02:03.000Z',
      finishedAt: '2026-05-10T01:03:03.000Z',
      summary: 'checked current operator path',
      actions: [],
      evidence: [],
      artifacts: [],
      memoryCandidates: [],
    }));

    const server = makeServer(root);
    const fallback = server.readWorkerConnectorFallback({
      method: 'GET',
      connectorPath: '/api/workers/runs',
      query: new URLSearchParams(),
      target: { agentName: 'jerry' },
      error: new Error('connect ECONNREFUSED 127.0.0.1:5004'),
    });

    assert.equal(fallback.ok, true);
    assert.equal(fallback.degraded, true);
    assert.equal(fallback.source, 'dashboard-worker-disk-fallback');
    assert.equal(fallback.runs.length, 1);
    assert.equal(fallback.runs[0].runId, 'wr_20260510T010203Z_systems_abcd');
    assert.equal(fallback.runs[0].requestedBy, 'good-life');
    assert.equal(fallback.runs[0].verifierStatus, 'pass');
    assert.match(fallback.connectorError, /ECONNREFUSED/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dashboard worker fallback filters run summaries by ownerAgent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-dashboard-worker-filter-'));
  try {
    const workerRoot = writeWorker(root);
    for (const [runId, ownerAgent] of [
      ['wr_jerry', 'jerry'],
      ['wr_forrest', 'forrest'],
    ]) {
      const runRoot = path.join(workerRoot, 'runs', runId);
      fs.mkdirSync(runRoot, { recursive: true });
      fs.writeFileSync(path.join(runRoot, 'receipt.json'), JSON.stringify({
        schema: 'home23.worker-run.v1',
        runId,
        worker: 'systems',
        ownerAgent,
        requestedBy: 'api',
        status: 'no_change',
        verifierStatus: 'pass',
        startedAt: '2026-05-10T01:02:03.000Z',
        finishedAt: ownerAgent === 'jerry' ? '2026-05-10T01:03:03.000Z' : '2026-05-10T01:04:03.000Z',
        summary: `${ownerAgent} check`,
        actions: [],
        evidence: [],
        artifacts: [],
        memoryCandidates: [],
      }));
    }

    const server = makeServer(root);
    const fallback = server.readWorkerConnectorFallback({
      method: 'GET',
      connectorPath: '/api/workers/runs',
      query: new URLSearchParams('ownerAgent=forrest'),
      target: { agentName: 'jerry' },
      error: new Error('timeout'),
    });

    assert.deepEqual(fallback.runs.map((run) => run.ownerAgent), ['forrest']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('dashboard worker fallback exposes worker list and receipts for read-only routes only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-dashboard-worker-readonly-'));
  try {
    const workerRoot = writeWorker(root);
    const runRoot = path.join(workerRoot, 'runs', 'wr_receipt');
    fs.mkdirSync(runRoot, { recursive: true });
    fs.writeFileSync(path.join(runRoot, 'receipt.json'), JSON.stringify({
      schema: 'home23.worker-run.v1',
      runId: 'wr_receipt',
      worker: 'systems',
      ownerAgent: 'jerry',
      requestedBy: 'api',
      status: 'fixed',
      verifierStatus: 'pass',
      startedAt: '2026-05-10T01:02:03.000Z',
      finishedAt: '2026-05-10T01:03:03.000Z',
      summary: 'fixed issue',
      actions: [],
      evidence: [],
      artifacts: [],
      memoryCandidates: [],
    }));

    const server = makeServer(root);
    const base = {
      query: new URLSearchParams(),
      target: { agentName: 'jerry' },
      error: new Error('connect failed'),
    };
    const workers = server.readWorkerConnectorFallback({ ...base, method: 'GET', connectorPath: '/api/workers' });
    const receipt = server.readWorkerConnectorFallback({ ...base, method: 'GET', connectorPath: '/api/workers/runs/wr_receipt/receipt' });
    const post = server.readWorkerConnectorFallback({ ...base, method: 'POST', connectorPath: '/api/workers/systems/runs' });

    assert.equal(workers.workers[0].name, 'systems');
    assert.equal(receipt.runId, 'wr_receipt');
    assert.equal(receipt.summary, 'fixed issue');
    assert.equal(post, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
