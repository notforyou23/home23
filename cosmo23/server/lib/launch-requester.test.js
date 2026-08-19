const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  resolveLaunchRequester,
  startProcessesForRun,
} = require('../index');

const COSMO_ROOT = path.resolve(__dirname, '..', '..');

test('Cosmo desk launch stamps its own exact requester', () => {
  const appSource = fs.readFileSync(path.join(COSMO_ROOT, 'public', 'app.js'), 'utf8');

  assert.match(appSource, /requesterAgent:\s*COSMO_DESK_REQUESTER/);
  assert.equal(resolveLaunchRequester(
    { topic: 'desk topic', requesterAgent: 'cosmo' },
    {},
  ), 'cosmo');
});

test('topic-only launch defaults to Cosmo and starts against the living root', async (t) => {
  const priorHome23Agent = process.env.HOME23_AGENT;
  const priorCosmoOwnerAgent = process.env.COSMO_OWNER_AGENT;
  delete process.env.HOME23_AGENT;
  delete process.env.COSMO_OWNER_AGENT;
  t.after(() => {
    if (priorHome23Agent === undefined) delete process.env.HOME23_AGENT;
    else process.env.HOME23_AGENT = priorHome23Agent;
    if (priorCosmoOwnerAgent === undefined) delete process.env.COSMO_OWNER_AGENT;
    else process.env.COSMO_OWNER_AGENT = priorCosmoOwnerAgent;
  });

  const requesterAgent = resolveLaunchRequester({ topic: 'desk topic' }, {});
  const launches = [];
  const manager = {
    startMCPServer: async (_port, env) => launches.push({ ...env }),
    startMainDashboard: async (_port, env) => launches.push({ ...env }),
    startCOSMO: async (env) => launches.push({ ...env }),
    stopAll: async () => {},
  };

  assert.equal(requesterAgent, 'cosmo');
  await assert.doesNotReject(
    startProcessesForRun('/runs/desk-topic', requesterAgent, manager),
  );
  assert.equal(launches.length, 3);
  for (const env of launches) {
    assert.equal(env.HOME23_AGENT, 'cosmo');
    assert.equal(env.COSMO_WORKSPACE_PATH, COSMO_ROOT);
  }
});

test('Cosmo requester launches with the living Cosmo root as its workspace', async () => {
  const launches = [];
  const manager = {
    startMCPServer: async (_port, env) => launches.push({ ...env }),
    startMainDashboard: async (_port, env) => launches.push({ ...env }),
    startCOSMO: async (env) => launches.push({ ...env }),
    stopAll: async () => {},
  };

  await startProcessesForRun('/runs/desk-topic', 'cosmo', manager);

  assert.equal(launches.length, 3);
  for (const env of launches) {
    assert.equal(env.HOME23_AGENT, 'cosmo');
    assert.equal(env.COSMO_WORKSPACE_PATH, COSMO_ROOT);
    assert.equal(env.COSMO_RUNTIME_DIR, '/runs/desk-topic');
  }
});

test('real Home23 launch identities and workspaces remain exact', async () => {
  assert.equal(resolveLaunchRequester(
    { requesterAgent: 'cosmo', owner: 'forrest', agentName: 'jerry' },
    { requesterAgent: 'jerry' },
  ), 'jerry');
  assert.equal(resolveLaunchRequester({ owner: 'forrest' }, {}), 'forrest');
  assert.equal(resolveLaunchRequester({ agentName: 'jerry' }, {}), 'jerry');

  const launches = [];
  const manager = {
    startMCPServer: async (_port, env) => launches.push({ ...env }),
    startMainDashboard: async (_port, env) => launches.push({ ...env }),
    startCOSMO: async (env) => launches.push({ ...env }),
    stopAll: async () => {},
  };

  await startProcessesForRun('/runs/owned-topic', 'forrest', manager);

  for (const env of launches) {
    assert.equal(env.HOME23_AGENT, 'forrest');
    assert.equal(
      env.COSMO_WORKSPACE_PATH,
      path.resolve(COSMO_ROOT, '..', 'instances', 'forrest', 'workspace'),
    );
    assert.equal(env.COSMO_RUNTIME_DIR, '/runs/owned-topic');
  }
});
