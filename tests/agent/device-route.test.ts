import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createRegisterDeviceHandler, createUnregisterDeviceHandler, createListDevicesHandler } from '../../src/routes/device.js';
import type { DeviceRegistration } from '../../src/push/types.js';

class MemoryDeviceRegistry {
  devices: DeviceRegistration[] = [];

  register(input: {
    device_token: string;
    bundle_id: string;
    env: 'sandbox' | 'production';
    chat_ids: string[];
    agent_id?: string;
    platform?: string;
    app_build?: string | number;
    contract_version?: string;
    capabilities_hash?: string;
  }): DeviceRegistration {
    const now = '2026-06-26T15:00:00.000Z';
    const key = `${input.bundle_id}::${input.device_token}`;
    const existing = this.devices.find(device => `${device.bundle_id}::${device.device_token}` === key);
    if (existing) {
      existing.chat_ids = Array.from(new Set([...existing.chat_ids, ...input.chat_ids]));
      existing.last_seen_at = now;
      existing.env = input.env;
      existing.agent_id = input.agent_id ?? existing.agent_id;
      existing.platform = input.platform ?? existing.platform;
      existing.app_build = input.app_build ?? existing.app_build;
      existing.contract_version = input.contract_version ?? existing.contract_version;
      existing.capabilities_hash = input.capabilities_hash ?? existing.capabilities_hash;
      return existing;
    }
    const record: DeviceRegistration = {
      device_token: input.device_token,
      chat_ids: input.chat_ids,
      registered_at: now,
      last_seen_at: now,
      bundle_id: input.bundle_id,
      env: input.env,
      agent_id: input.agent_id,
      platform: input.platform,
      app_build: input.app_build,
      contract_version: input.contract_version,
      capabilities_hash: input.capabilities_hash,
    };
    this.devices = [...this.devices, record];
    return record;
  }

  unregister(deviceToken: string, bundleId: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter(device => !(device.device_token === deviceToken && device.bundle_id === bundleId));
    return this.devices.length !== before;
  }

  unregisterChats(deviceToken: string, bundleId: string, chatIds: string[]) {
    const idx = this.devices.findIndex(device => device.device_token === deviceToken && device.bundle_id === bundleId);
    if (idx < 0) {
      return {
        found: false,
        device_removed: false,
        removed_chat_ids: [],
        remaining_chat_ids: [],
        updated_at: null,
      };
    }
    const record = this.devices[idx]!;
    const removeSet = new Set(chatIds);
    const removed_chat_ids = record.chat_ids.filter(chatId => removeSet.has(chatId));
    const remaining_chat_ids = record.chat_ids.filter(chatId => !removeSet.has(chatId));
    if (remaining_chat_ids.length === 0) {
      this.devices.splice(idx, 1);
    } else {
      record.chat_ids = remaining_chat_ids;
      record.last_seen_at = '2026-06-26T15:00:00.000Z';
    }
    return {
      found: true,
      device_removed: remaining_chat_ids.length === 0,
      removed_chat_ids,
      remaining_chat_ids,
      updated_at: '2026-06-26T15:00:00.000Z',
    };
  }

  list(): DeviceRegistration[] {
    return this.devices;
  }
}

async function postJson(app: express.Express, route: string, body: unknown) {
  return await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        server.close();
        resolve({ status: res.status, body: json });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

async function deleteJson(app: express.Express, route: string, body: unknown) {
  return await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}${route}`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json();
        server.close();
        resolve({ status: res.status, body: json });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

async function getJson(app: express.Express, route: string, headers: Record<string, string> = {}) {
  return await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as { port: number }).port;
        const res = await fetch(`http://127.0.0.1:${port}${route}`, { headers });
        const json = await res.json();
        server.close();
        resolve({ status: res.status, body: json });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

test('device registration returns an agent-scoped contract receipt', async () => {
  const registry = new MemoryDeviceRegistry();
  const app = express();
  app.use(express.json());
  app.post('/api/device/register', createRegisterDeviceHandler({ agentName: 'jerry', registry: registry as any }));
  app.get('/api/device/registry', createListDevicesHandler({ agentName: 'jerry', registry: registry as any }));

  const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const res = await postJson(app, '/api/device/register', {
    device_token: token,
    agent_id: 'jerry',
    chat_ids: ['ios_contract_smoke'],
    bundle_id: 'com.regina6.home23',
    env: 'sandbox',
    platform: 'ios',
    app_build: '1',
    contract_version: '2026.06.26',
    capabilities_hash: 'sha256:test',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.agent_id, 'jerry');
  assert.deepEqual(res.body.registered_chat_ids, ['ios_contract_smoke']);
  assert.equal(res.body.device.agent_id, 'jerry');
  assert.equal(res.body.device.platform, 'ios');

  const list = await getJson(app, '/api/device/registry');
  assert.equal(list.status, 200);
  assert.equal(list.body.devices[0].agent_id, 'jerry');
  assert.equal(list.body.devices[0].updated_at, '2026-06-26T15:00:00.000Z');
});

test('device registration rejects mismatched agent ids', async () => {
  const registry = new MemoryDeviceRegistry();
  const app = express();
  app.use(express.json());
  app.post('/api/device/register', createRegisterDeviceHandler({ agentName: 'jerry', registry: registry as any }));

  const res = await postJson(app, '/api/device/register', {
    device_token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    agent_id: 'forrest',
    chat_ids: ['ios_contract_smoke'],
    bundle_id: 'com.regina6.home23',
    env: 'sandbox',
  });

  assert.equal(res.status, 400);
  assert.match(res.body.error, /agent_id must match/);
});

test('device unregister can remove selected chat subscriptions without deleting the device', async () => {
  const registry = new MemoryDeviceRegistry();
  const app = express();
  app.use(express.json());
  app.post('/api/device/register', createRegisterDeviceHandler({ agentName: 'jerry', registry: registry as any }));
  app.delete('/api/device/register', createUnregisterDeviceHandler({ agentName: 'jerry', registry: registry as any }));
  app.get('/api/device/registry', createListDevicesHandler({ agentName: 'jerry', registry: registry as any }));

  const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const baseBody = {
    device_token: token,
    agent_id: 'jerry',
    chat_ids: ['chat-a', 'chat-b'],
    bundle_id: 'com.regina6.home23',
    env: 'sandbox',
  };

  assert.equal((await postJson(app, '/api/device/register', baseBody)).status, 200);

  const res = await deleteJson(app, '/api/device/register', {
    device_token: token,
    bundle_id: 'com.regina6.home23',
    chat_ids: ['chat-a'],
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.agent_id, 'jerry');
  assert.equal(res.body.unregistered, false);
  assert.deepEqual(res.body.removed_chat_ids, ['chat-a']);
  assert.deepEqual(res.body.remaining_chat_ids, ['chat-b']);

  const list = await getJson(app, '/api/device/registry');
  assert.deepEqual(list.body.devices[0].chat_ids, ['chat-b']);
});

test('device unregister removes the device when the last chat subscription is removed', async () => {
  const registry = new MemoryDeviceRegistry();
  const app = express();
  app.use(express.json());
  app.post('/api/device/register', createRegisterDeviceHandler({ agentName: 'jerry', registry: registry as any }));
  app.delete('/api/device/register', createUnregisterDeviceHandler({ agentName: 'jerry', registry: registry as any }));
  app.get('/api/device/registry', createListDevicesHandler({ agentName: 'jerry', registry: registry as any }));

  const token = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
  assert.equal((await postJson(app, '/api/device/register', {
    device_token: token,
    agent_id: 'jerry',
    chat_ids: ['only-chat'],
    bundle_id: 'com.regina6.home23',
    env: 'sandbox',
  })).status, 200);

  const res = await deleteJson(app, '/api/device/register', {
    device_token: token,
    bundle_id: 'com.regina6.home23',
    chat_ids: ['only-chat'],
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.unregistered, true);
  assert.equal(res.body.device_unregistered, true);
  assert.deepEqual(res.body.removed_chat_ids, ['only-chat']);
  assert.deepEqual(res.body.remaining_chat_ids, []);

  const list = await getJson(app, '/api/device/registry');
  assert.deepEqual(list.body.devices, []);
});

test('device unregister without chat_ids preserves whole-device removal behavior', async () => {
  const registry = new MemoryDeviceRegistry();
  const app = express();
  app.use(express.json());
  app.post('/api/device/register', createRegisterDeviceHandler({ agentName: 'jerry', registry: registry as any }));
  app.delete('/api/device/register', createUnregisterDeviceHandler({ agentName: 'jerry', registry: registry as any }));

  const token = 'fedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcbafedcba';
  assert.equal((await postJson(app, '/api/device/register', {
    device_token: token,
    agent_id: 'jerry',
    chat_ids: ['chat-a', 'chat-b'],
    bundle_id: 'com.regina6.home23',
    env: 'sandbox',
  })).status, 200);

  const res = await deleteJson(app, '/api/device/register', {
    device_token: token,
    bundle_id: 'com.regina6.home23',
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.unregistered, true);
  assert.deepEqual(registry.devices, []);
});

test('device registry diagnostics require bridge auth when configured', async () => {
  const registry = new MemoryDeviceRegistry();
  const app = express();
  app.use(express.json());
  app.get('/api/device/registry', createListDevicesHandler({
    agentName: 'jerry',
    registry: registry as any,
    token: 'secret-token',
  }));

  const unauthorized = await getJson(app, '/api/device/registry');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.body.error, 'Unauthorized');

  const authorized = await getJson(app, '/api/device/registry', { authorization: 'Bearer secret-token' });
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.body.devices, []);
});
