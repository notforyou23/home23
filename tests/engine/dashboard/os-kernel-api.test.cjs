'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { mountOsKernelApi, buildRemediatorCtx } = require('../../../engine/src/dashboard/os-kernel-api.js');
const { OsKernelStore } = require('../../../engine/src/os-kernel/store.js');
const { createFromFuseNotify } = require('../../../engine/src/os-kernel/operator-intents.js');

test('mountOsKernelApi exports and serves state snapshot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-kernel-api-'));
  const store = new OsKernelStore({ brainDir: dir });
  createFromFuseNotify(store, {
    problemId: 'jerry_harness_online',
    agent: 'jerry',
    title: 'Harness down',
    why: 'Verifier failing',
    evidence: 'pm2 offline',
    checklist: ['Restart harness'],
    safeAction: { id: 'restart_pm2', label: 'Restart harness', args: { name: 'home23-jerry-harness' } },
  });

  const app = express();
  app.use(express.json());
  mountOsKernelApi(app, {
    getBrainDir: () => dir,
    getAgentContext: () => ({ agentName: 'jerry', runtimeDir: dir, bridgePort: 5004 }),
    loadLiveProblems: () => ({ problems: [] }),
  });

  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/api/os-kernel/state?agent=jerry`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.available, true);
    assert.equal(body.agent, 'jerry');
    assert.equal(body.snapshot.needsYou.length, 1);
    assert.equal(body.activeGoalCount, 0);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildRemediatorCtx uses agent runtime paths', () => {
  const ctx = buildRemediatorCtx({
    agentName: 'forrest',
    runtimeDir: '/tmp/forrest/brain',
    bridgePort: 5014,
  });
  assert.equal(ctx.brainDir, '/tmp/forrest/brain');
  assert.equal(ctx.agentName, 'forrest');
  assert.match(ctx.harnessNotifyUrl, /5014/);
});
