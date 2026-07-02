'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertPm2AgentIdentity,
  validatePm2AgentIdentity,
  pm2AgentFromName,
  parsePm2JlistOutput,
} = require('../../scripts/lib/pm2-agent-identity-guard.cjs');

const ROOT = '/Users/jtr/_JTR23_/release/home23';

test('derives the owning agent from PM2 triplet names', () => {
  assert.equal(pm2AgentFromName('home23-jerry'), 'jerry');
  assert.equal(pm2AgentFromName('home23-jerry-dash'), 'jerry');
  assert.equal(pm2AgentFromName('home23-forrest-harness'), 'forrest');
  assert.equal(pm2AgentFromName('home23-cosmo23'), 'cosmo23');
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
