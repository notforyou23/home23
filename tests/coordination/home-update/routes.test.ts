import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoordinationApplication, disabledCoordinationFeatureFlags } from '../../../src/coordination/app/index.js';
import { createCoordinationHttpServer } from '../../../src/coordination/http/index.js';
import { AuthError } from '../../../src/coordination/auth/index.js';

const principal = { principalId: 'user_owner' as const, deviceId: 'device-owner', sessionId: 'session-owner', scopes: ['product:read', 'message:send'] as const };
const flags = { ...disabledCoordinationFeatureFlags(), 'coordination.process.enabled': true, 'coordination.public_api.enabled': true };

test('home updates require real owner auth, mutation scopes and idempotency; reject arbitrary commands and paths', async t => {
  let requests = 0;
  const application = createCoordinationApplication({ flags, services: {
    auth: { validateAccessToken: async ({ accessToken, requiredScopes }) => {
      if (accessToken !== 'owner-token') throw new AuthError('access_invalid');
      assert.ok(requiredScopes?.includes('product:read'));
      if (requiredScopes?.length === 2) assert.ok(requiredScopes.includes('message:send'));
      return principal;
    } },
    homeUpdate: {
      status: async build => ({ state: 'unavailable', build, message: 'No release could be reached.' }),
      request: async (input, context) => { requests++; assert.equal(context.principalId, 'user_owner');
        assert.equal(input.idempotencyKey, 'home-update-test-key');
        return { operation: { id: 'persistent-operation', phase: 'queued' } };
      },
    },
  } });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const { origin } = await server.start();
  const url = `${origin}/api/v1/home-update`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { authorization: 'Bearer wrong-token' } })).status, 401);
  const headers = { authorization: 'Bearer owner-token', 'content-type': 'application/json', 'idempotency-key': 'home-update-test-key' };
  const status = await fetch(`${url}?clientBuild=180`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json() as any).state, 'unavailable');
  assert.equal(status.headers.get('cache-control'), 'private, no-store');
  const noKey = await fetch(url, { method: 'POST', headers: { authorization: headers.authorization, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'update' }) });
  assert.equal(noKey.status, 400);
  for (const body of [{ action: 'shell' }, { action: 'update' }, { action: 'update', homeRoot: '/tmp/another-home' }, { action: 'update', clientBuild: -1 }]) {
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })).status, 400);
  }
  assert.equal(requests, 0);
  const accepted = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ action: 'update', clientBuild: 180 }) });
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json() as any).operation.phase, 'queued');
  assert.equal(requests, 1);
});

test('disabled public API does not admit home update actions', async t => {
  const application = createCoordinationApplication({ flags: disabledCoordinationFeatureFlags(), services: {
    auth: { validateAccessToken: async () => principal }, homeUpdate: { status: async () => assert.fail(), request: async () => assert.fail() },
  } });
  const server = createCoordinationHttpServer({ application, port: 0 });
  t.after(() => server.drain());
  const { origin } = await server.start();
  assert.equal((await fetch(`${origin}/api/v1/home-update`, { headers: { authorization: 'Bearer owner-token' } })).status, 503);
});
