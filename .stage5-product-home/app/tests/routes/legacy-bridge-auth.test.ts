import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { createLegacyBridgeAuthMiddleware } from '../../src/routes/legacy-bridge-auth.js';
import { createRegisterDeviceHandler } from '../../src/routes/device.js';
import { createTestAuthService, mutation } from '../coordination/auth/test-context.js';
import { TestAuthRepository } from '../coordination/auth/test-repository.js';

function invoke(input: {
  authorization?: string;
  queryToken?: string;
  status?: number;
  receipt?: object;
  staticToken?: string;
}) {
  let nextCalled = false;
  let responseStatus = 200;
  let responseBody: unknown;
  let forwardedAuthorization: string | undefined;
  const request = {
    headers: { authorization: input.authorization },
    query: input.queryToken ? { token: input.queryToken } : {},
    get(name: string) { return name.toLowerCase() === 'authorization' ? this.headers.authorization : undefined; },
  } as unknown as Request;
  const response = {
    status(value: number) { responseStatus = value; return this; },
    json(value: unknown) { responseBody = value; return this; },
  } as unknown as Response;
  const middleware = createLegacyBridgeAuthMiddleware({
    staticToken: input.staticToken ?? 'legacy-master',
    coordinationOrigin: 'http://127.0.0.1:7346',
    fetchImpl: async (_url, init) => {
      forwardedAuthorization = (init?.headers as Record<string, string>).Authorization;
      return new Response(JSON.stringify(input.receipt ?? {
        ok: true,
        scopes: ['legacy-bridge:access'],
      }), { status: input.status ?? 200, headers: { 'content-type': 'application/json' } });
    },
  });
  return Promise.resolve(middleware(request, response, (() => { nextCalled = true; }) as NextFunction))
    .then(() => ({ nextCalled, responseStatus, responseBody, forwardedAuthorization, rewritten: request.headers.authorization }));
}

test('scoped coordinator session is checked online then translated for legacy route compatibility', async () => {
  const result = await invoke({ authorization: 'Bearer scoped-device-session' });
  assert.equal(result.nextCalled, true);
  assert.equal(result.forwardedAuthorization, 'Bearer scoped-device-session');
  assert.equal(result.rewritten, 'Bearer legacy-master');
});

test('revoked coordinator session is rejected and never reaches a legacy route', async () => {
  const result = await invoke({ authorization: 'Bearer revoked-device-session', status: 401 });
  assert.equal(result.nextCalled, false);
  assert.equal(result.responseStatus, 401);
});

test('product or Canary session without legacy scope is rejected', async () => {
  const result = await invoke({
    authorization: 'Bearer connected-agents-product-session',
    receipt: { ok: true, scopes: ['product:read', 'message:send'] },
  });
  assert.equal(result.nextCalled, false);
  assert.equal(result.responseStatus, 401);
});

test('configured static bridge bearer remains compatible during migration', async () => {
  const result = await invoke({ authorization: 'Bearer legacy-master' });
  assert.equal(result.nextCalled, true);
  assert.equal(result.forwardedAuthorization, undefined);
});

test('one-use enrollment reaches protected routes and registration, then refresh rotation revokes the old session', async (t) => {
  let now = new Date('2026-08-30T12:00:00.000Z');
  const service = createTestAuthService({
    repository: new TestAuthRepository(),
    keyMaterial: Buffer.alloc(32, 0x71),
    now: () => now,
  });
  const issued = await service.issuePairing({
    deviceName: 'Production Home23',
    operator: { authenticated: true, network: 'loopback' },
    mutation: mutation('route-issue'),
  });
  const paired = await service.redeemPairing({
    pairingSessionId: issued.pairingSession.id,
    pairingCode: issued.pairingCode,
    network: 'vpn',
    device: { platform: 'ios', name: 'Production Home23 iPhone', appBuild: '1.10 (30)' },
    credentialProfile: 'legacy_bridge',
    mutation: mutation('route-redeem'),
  });

  const app = express();
  app.use(express.json());
  const auth = createLegacyBridgeAuthMiddleware({
    staticToken: 'legacy-master',
    coordinationOrigin: 'http://127.0.0.1:7346',
    fetchImpl: async (_url, init) => {
      const authorization = (init?.headers as Record<string, string>).Authorization;
      try {
        const identity = await service.validateAccessToken({
          accessToken: authorization.replace(/^Bearer /, ''),
          network: 'loopback',
          requiredScopes: ['legacy-bridge:access'],
        });
        return new Response(JSON.stringify({ ok: true, scopes: identity.scopes }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      } catch {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
    },
  });
  app.use(['/api/chat', '/api/device/register'], auth);
  for (const path of ['/api/chat/turn', '/api/chat/history', '/api/chat/conversations', '/api/chat/models', '/api/chat/stream', '/api/chat/media']) {
    const method = path === '/api/chat/turn' ? 'post' : 'get';
    app[method](path, (_request, response) => response.json({ ok: true, path }));
  }
  const registered: unknown[] = [];
  app.post('/api/device/register', createRegisterDeviceHandler({
    agentName: 'jerry',
    token: 'legacy-master',
    registry: {
      register(value: unknown) { registered.push(value); return { ...(value as object), chat_ids: [], last_seen_at: '2026-08-30T12:00:00Z' }; },
    } as never,
  }));
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test listener unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  for (const path of ['/api/chat/turn', '/api/chat/history', '/api/chat/conversations', '/api/chat/models', '/api/chat/stream', '/api/chat/media']) {
    const response = await fetch(`${origin}${path}`, {
      method: path === '/api/chat/turn' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${paired.accessToken}`, 'Content-Type': 'application/json' },
      body: path === '/api/chat/turn' ? '{}' : undefined,
    });
    assert.equal(response.status, 200, path);
  }
  const registration = await fetch(`${origin}/api/device/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${paired.accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_token: 'a'.repeat(64), agent_id: 'jerry', chat_ids: [], bundle_id: 'com.regina6.home23', env: 'production' }),
  });
  assert.equal(registration.status, 200);
  assert.equal(registered.length, 1);

  now = new Date('2026-08-30T12:05:00.000Z');
  const rotated = await service.refreshSession({
    refreshToken: paired.refreshToken,
    network: 'vpn',
    mutation: mutation('route-refresh'),
  });
  const stale = await fetch(`${origin}/api/chat/models`, {
    headers: { Authorization: `Bearer ${paired.accessToken}` },
  });
  assert.equal(stale.status, 401);
  const recovered = await fetch(`${origin}/api/chat/models`, {
    headers: { Authorization: `Bearer ${rotated.accessToken}` },
  });
  assert.equal(recovered.status, 200);
});
