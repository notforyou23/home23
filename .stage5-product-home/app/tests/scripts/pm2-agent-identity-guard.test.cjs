'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const {
  assertPm2AgentIdentity,
  validatePm2AgentIdentity,
  pm2AgentFromName,
  parsePm2ProcessName,
  parsePm2JlistOutput,
} = require('../../scripts/lib/pm2-agent-identity-guard.cjs');

const ROOT = '/Users/jtr/_JTR23_/release/home23';

test('derives the owning agent from PM2 triplet names', () => {
  assert.equal(pm2AgentFromName('home23-jerry'), 'jerry');
  assert.equal(pm2AgentFromName('home23-jerry-dash'), 'jerry');
  assert.equal(pm2AgentFromName('home23-forrest-harness'), 'forrest');
  assert.equal(pm2AgentFromName('home23-cosmo23'), 'cosmo23');
});

test('derives the owning agent from conditional mcp and seed process names', () => {
  assert.equal(pm2AgentFromName('home23-jerry-mcp'), 'jerry');
  assert.equal(pm2AgentFromName('home23-jerry-seed'), 'jerry');
  assert.deepEqual(parsePm2ProcessName('home23-jerry-seed'), { agent: 'jerry', suffix: 'seed' });
  assert.deepEqual(parsePm2ProcessName('home23-forrest-mcp'), { agent: 'forrest', suffix: 'mcp' });
  assert.deepEqual(parsePm2ProcessName('home23-jerry'), { agent: 'jerry', suffix: '' });
});

test('accepts a seed runner row with its suffixed INSTANCE_ID and no port env', () => {
  const result = validatePm2AgentIdentity({
    root: ROOT,
    pid: 4321,
    pm2List: [{ name: 'home23-jerry-seed', pid: 4321 }],
    env: {
      HOME23_AGENT: 'jerry',
      INSTANCE_ID: 'home23-jerry-seed',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.expectedAgent, 'jerry');
  assert.deepEqual(result.mismatches, []);
});

test('refuses a seed runner row carrying another agent env', () => {
  assert.throws(
    () => assertPm2AgentIdentity({
      root: ROOT,
      pid: 4321,
      pm2List: [{ name: 'home23-jerry-seed', pid: 4321 }],
      env: {
        HOME23_AGENT: 'forrest',
        INSTANCE_ID: 'home23-forrest-seed',
      },
    }),
    /refusing startup for home23-jerry-seed.*HOME23_AGENT=forrest expected jerry/
  );
});

test('accepts the engine of an agent whose name ends in a role suffix', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-guard-'));
  try {
    mkdirSync(join(root, 'instances', 'alice-seed'), { recursive: true });
    writeFileSync(
      join(root, 'instances', 'alice-seed', 'config.yaml'),
      'ports:\n  engine: 5021\n  dashboard: 5022\n  mcp: 5023\n',
    );

    // home23-alice-seed here is agent alice-seed's ENGINE, not a seed runner
    // of agent alice — its own env must pass the guard.
    const result = validatePm2AgentIdentity({
      root,
      pid: 777,
      pm2List: [{ name: 'home23-alice-seed', pid: 777 }],
      env: {
        HOME23_AGENT: 'alice-seed',
        INSTANCE_ID: 'home23-alice-seed',
        DASHBOARD_PORT: '5022',
        COSMO_DASHBOARD_PORT: '5022',
        REALTIME_PORT: '5021',
        MCP_HTTP_PORT: '5023',
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.expectedAgent, 'alice-seed');

    // Env matching neither reading is still refused.
    const wrong = validatePm2AgentIdentity({
      root,
      pid: 777,
      pm2List: [{ name: 'home23-alice-seed', pid: 777 }],
      env: {
        HOME23_AGENT: 'forrest',
        INSTANCE_ID: 'home23-forrest',
      },
    });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.expectedAgent, 'alice-seed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to start when a Jerry PM2 row carries Forrest env', () => {
  assert.throws(
    () => assertPm2AgentIdentity({
      root: ROOT,
      pid: 1234,
      pm2List: [{ name: 'home23-jerry', pid: 1234 }],
      env: {
        HOME23_AGENT: 'forrest',
        INSTANCE_ID: 'home23-forrest',
        DASHBOARD_PORT: '5012',
        COSMO_DASHBOARD_PORT: '5012',
        REALTIME_PORT: '5011',
        MCP_HTTP_PORT: '5013',
      },
    }),
    /refusing startup for home23-jerry.*HOME23_AGENT=forrest expected jerry/
  );
});

test('accepts a Jerry PM2 row with Jerry env and ports', () => {
  const result = validatePm2AgentIdentity({
    root: ROOT,
    pid: 1234,
    pm2List: [{ name: 'home23-jerry', pid: 1234 }],
    env: {
      HOME23_AGENT: 'jerry',
      INSTANCE_ID: 'home23-jerry',
      DASHBOARD_PORT: '5002',
      COSMO_DASHBOARD_PORT: '5002',
      REALTIME_PORT: '5001',
      MCP_HTTP_PORT: '5003',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.mismatches, []);
});

test('skips non-PM2 local runs', () => {
  const result = validatePm2AgentIdentity({
    root: ROOT,
    pid: 1234,
    pm2List: [],
    env: {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
});

test('parses PM2 jlist JSON after daemon startup chatter', () => {
  const parsed = parsePm2JlistOutput('[PM2] Spawning PM2 daemon\n[{"name":"home23-jerry","pid":1234}]\n');

  assert.deepEqual(parsed, [{ name: 'home23-jerry', pid: 1234 }]);
});
