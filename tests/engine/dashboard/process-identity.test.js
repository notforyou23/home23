import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const {
  PROCESS_IDENTITY_ROUTE,
  buildDashboardProcessIdentity,
  registerProcessIdentityRoute,
} = require('../../../engine/src/dashboard/server.js');
const { runVerifier } = require('../../../engine/src/live-problems/verifiers.js');

// Fields the identity document is allowed to expose. The route is
// unauthenticated, so this list is the contract: adding anything here is a
// deliberate decision, and anything carrying a path, secret, or config value
// does not belong.
const ALLOWED_KEYS = [
  'ok', 'service', 'pid', 'ppid', 'port', 'agent',
  'instanceId', 'pm2Name', 'pm2Id', 'startedAt', 'uptimeSec',
];

async function listenIdentityApp(server) {
  const app = express();
  registerProcessIdentityRoute(app, server);
  const httpServer = http.createServer(app);
  await new Promise(resolve => httpServer.listen(0, '127.0.0.1', resolve));
  return { httpServer, port: httpServer.address().port };
}

test('identity payload reports this process and nothing sensitive', () => {
  const identity = buildDashboardProcessIdentity({ port: 5002 });

  assert.equal(identity.pid, process.pid);
  assert.equal(identity.service, 'home23-dashboard');
  assert.equal(identity.port, 5002);
  assert.equal(typeof identity.startedAt, 'string');
  assert.ok(Number.isFinite(Date.parse(identity.startedAt)));
  assert.ok(identity.uptimeSec >= 0);

  assert.deepEqual(Object.keys(identity).sort(), [...ALLOWED_KEYS].sort());
  const serialized = JSON.stringify(identity);
  assert.equal(/\/(Users|home|tmp)\//.test(serialized), false, 'identity must not leak filesystem paths');
  assert.equal(/token|secret|key|password/i.test(serialized), false, 'identity must not leak credentials');
});

test('GET /home23/process.json serves the live pid as JSON', async () => {
  const { httpServer, port } = await listenIdentityApp({ port: 5002 });
  try {
    const res = await fetch(`http://127.0.0.1:${port}${PROCESS_IDENTITY_ROUTE}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'no-store');

    const body = await res.json();
    assert.equal(body.pid, process.pid);
    assert.equal(body.ok, true);
    assert.equal(body.service, 'home23-dashboard');
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
  }
});

test('pm2_port_owner reads the real dashboard route and gates on pid identity', async () => {
  const { httpServer, port } = await listenIdentityApp({ port: 5002 });
  const childCommands = [];
  const pm2Only = (pid) => (command, args) => {
    childCommands.push([command, ...(args || [])].join(' '));
    if (command !== 'pm2') throw new Error(`forbidden child process: ${command}`);
    return JSON.stringify([{ name: 'home23-jerry-dash', pid, pm2_env: { status: 'online' } }]);
  };

  try {
    const owned = await runVerifier({
      type: 'pm2_port_owner',
      args: { name: 'home23-jerry-dash', port: String(port), timeoutMs: 2000 },
    }, { execFileSync: pm2Only(process.pid) });

    assert.equal(owned.ok, true);
    assert.equal(owned.observed.listenerPid, process.pid);
    assert.equal(owned.observed.listenerService, 'home23-dashboard');

    const stale = await runVerifier({
      type: 'pm2_port_owner',
      args: { name: 'home23-jerry-dash', port: String(port), timeoutMs: 2000 },
    }, { execFileSync: pm2Only(process.pid + 1) });

    assert.equal(stale.ok, false);
    assert.match(stale.detail, new RegExp(`stale pid ${process.pid}`));

    // The whole point of the change: pid identity is settled without lsof.
    assert.deepEqual([...new Set(childCommands)], ['pm2 jlist']);
  } finally {
    await new Promise(resolve => httpServer.close(resolve));
  }
});
