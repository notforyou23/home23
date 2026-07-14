import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import express from 'express';
import { DeviceRegistry } from '../../src/push/device-registry.js';
import { ApnsPusher } from '../../src/push/apns-pusher.js';
import { createRegisterDeviceHandler } from '../../src/routes/device.js';

const require = createRequire(import.meta.url);

const DEVICE_TOKEN = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const INSTALLATION_ID = 'ios-installation-00000001';
const OPERATION_ID = `brop_${'a'.repeat(32)}`;
const ROUTE_ID = `qroute_${'b'.repeat(32)}`;

async function postJson(
  app: express.Express,
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return await new Promise<{ status: number; body: any }>((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const address = server.address() as { port: number };
        const response = await fetch(`http://127.0.0.1:${address.port}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(body),
        });
        resolve({ status: response.status, body: await response.json() });
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

test('APNs registration binds Query notification capability to the stable installation id', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const filePath = join(root, 'device-registry.json');
    const registry = new DeviceRegistry(filePath);
    const registered = registry.register({
      device_token: DEVICE_TOKEN,
      bundle_id: 'com.regina6.home23',
      env: 'sandbox',
      chat_ids: ['trusted-chat'],
      agent_id: 'jerry',
      installation_id: INSTALLATION_ID,
      query_notifications: true,
    } as any);

    assert.equal((registered as any).installation_id, INSTALLATION_ID);
    assert.equal((registered as any).query_notifications, true);
    assert.deepEqual((registry as any).lookupQueryNotificationDevices(
      [INSTALLATION_ID], 'jerry',
    ).map((device: any) => device.device_token), [DEVICE_TOKEN]);

    const persisted = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(persisted.devices[0].installation_id, INSTALLATION_ID);
    assert.equal(persisted.devices[0].query_notifications, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('APNs token rotation leaves one Query-capable row across bundle changes', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const registry = new DeviceRegistry(join(root, 'device-registry.json'));
    registry.register({
      device_token: DEVICE_TOKEN,
      bundle_id: 'com.regina6.home23',
      env: 'sandbox',
      chat_ids: ['trusted-chat'],
      agent_id: 'jerry',
      installation_id: INSTALLATION_ID,
      query_notifications: true,
    });
    const replacement = 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
    registry.register({
      device_token: replacement,
      bundle_id: 'com.regina6.home23.next',
      env: 'sandbox',
      chat_ids: ['trusted-chat'],
      agent_id: 'jerry',
      installation_id: INSTALLATION_ID,
      query_notifications: true,
    });

    const capable = registry.lookupQueryNotificationDevices([INSTALLATION_ID], 'jerry');
    assert.deepEqual(capable.map(device => device.device_token), [replacement]);
    const old = registry.list().find(device => device.device_token === DEVICE_TOKEN);
    assert.deepEqual(old?.chat_ids, ['trusted-chat']);
    assert.notEqual(old?.query_notifications, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('removing the last Chat subscription preserves an independent Query-capable row', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const registry = new DeviceRegistry(join(root, 'device-registry.json'));
    registry.register({
      device_token: DEVICE_TOKEN,
      bundle_id: 'com.regina6.home23',
      env: 'sandbox',
      chat_ids: ['trusted-chat'],
      agent_id: 'jerry',
      installation_id: INSTALLATION_ID,
      query_notifications: true,
    });
    const result = registry.unregisterChats(
      DEVICE_TOKEN, 'com.regina6.home23', ['trusted-chat'],
    );
    assert.equal(result.device_removed, false);
    assert.deepEqual(result.remaining_chat_ids, []);
    assert.deepEqual(registry.lookupQueryNotificationDevices(
      [INSTALLATION_ID], 'jerry',
    ).map(device => device.device_token), [DEVICE_TOKEN]);
    assert.equal(registry.unregister(DEVICE_TOKEN, 'com.regina6.home23'), true);
    assert.deepEqual(registry.list(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('device registration only enables Query notification capability with a stable installation id', () => {
  const calls: any[] = [];
  const handler = createRegisterDeviceHandler({
    agentName: 'jerry',
    registry: { register(input: any) { calls.push(input); return {
      ...input,
      registered_at: '2026-07-13T12:00:00.000Z',
      last_seen_at: '2026-07-13T12:00:00.000Z',
    }; } } as any,
  });
  const response = () => {
    const state: any = { statusCode: 200, body: null };
    state.status = (code: number) => { state.statusCode = code; return state; };
    state.json = (body: any) => { state.body = body; return state; };
    return state;
  };

  const missing = response();
  handler({ body: {
    device_token: DEVICE_TOKEN,
    agent_id: 'jerry',
    chat_ids: ['trusted-chat'],
    bundle_id: 'com.regina6.home23',
    env: 'sandbox',
    query_notifications: true,
  }, headers: {} } as any, missing);
  assert.equal(missing.statusCode, 400);
  assert.equal(calls.length, 0);

  const valid = response();
  handler({ body: {
    device_token: DEVICE_TOKEN,
    agent_id: 'jerry',
    chat_ids: ['trusted-chat'],
    bundle_id: 'com.regina6.home23',
    env: 'sandbox',
    installation_id: INSTALLATION_ID,
    query_notifications: true,
  }, headers: {} } as any, valid);
  assert.equal(valid.statusCode, 200);
  assert.equal(calls[0].installation_id, INSTALLATION_ID);
  assert.equal(calls[0].query_notifications, true);

  const legacyNull = response();
  handler({ body: {
    device_token: DEVICE_TOKEN,
    agent_id: 'jerry',
    chat_ids: ['trusted-chat'],
    bundle_id: 'com.regina6.home23',
    env: 'sandbox',
    installation_id: null,
    query_notifications: null,
  }, headers: {} } as any, legacyNull);
  assert.equal(legacyNull.statusCode, 200);
  assert.equal(calls[1].installation_id, undefined);
  assert.equal(calls[1].query_notifications, undefined);
});

test('Query terminal APNs payload is generic, exact-device scoped, and durable-deduplicated', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const filePath = join(root, 'device-registry.json');
    const registry = new DeviceRegistry(filePath);
    registry.register({
      device_token: DEVICE_TOKEN,
      bundle_id: 'com.regina6.home23',
      env: 'sandbox',
      chat_ids: ['trusted-chat'],
      agent_id: 'jerry',
      installation_id: INSTALLATION_ID,
      query_notifications: true,
    });
    registry.register({
      device_token: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      bundle_id: 'com.regina6.home23',
      env: 'sandbox',
      chat_ids: ['other-chat'],
      agent_id: 'jerry',
      installation_id: 'ios-installation-00000002',
      query_notifications: true,
    });
    const sends: any[] = [];
    const client = {
      async send(deviceToken: string, payload: unknown, env: string) {
        sends.push({ deviceToken, payload, env });
        return { status: 200, apnsId: 'apns-1' };
      },
    };
    const pusher = new ApnsPusher(client as any, registry, 'jerry');
    const input = {
      operationId: OPERATION_ID,
      state: 'complete' as const,
      routeId: ROUTE_ID,
      generation: 4,
      deviceIds: [INSTALLATION_ID],
    };
    const first = await (pusher as any).notifyQueryTerminal(input);
    const replay = await (new ApnsPusher(client as any,
      new DeviceRegistry(filePath), 'jerry') as any).notifyQueryTerminal(input);

    assert.equal(sends.length, 1);
    assert.equal(sends[0].deviceToken, DEVICE_TOKEN);
    assert.deepEqual(sends[0].payload, {
      aps: {
        alert: { title: 'Jerry', body: "Jerry's Query is ready." },
        'mutable-content': 1,
        sound: 'default',
      },
      kind: 'query_operation',
      operationId: OPERATION_ID,
      state: 'complete',
      agent: 'jerry',
      routeId: ROUTE_ID,
      generation: 4,
    });
    const serialized = JSON.stringify(sends[0].payload);
    for (const forbidden of ['question', 'answer', 'provider', 'source', 'path']) {
      assert.equal(serialized.includes(forbidden), false);
    }
    assert.deepEqual(first, replay);
    assert.deepEqual(first.delivered, [INSTALLATION_ID]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent duplicate terminal callbacks share one APNs attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const registry = new DeviceRegistry(join(root, 'device-registry.json'));
    registry.register({
      device_token: DEVICE_TOKEN, bundle_id: 'com.regina6.home23', env: 'sandbox',
      chat_ids: [], agent_id: 'jerry', installation_id: INSTALLATION_ID,
      query_notifications: true,
    });
    let sends = 0;
    const pusher = new ApnsPusher({ async send() {
      sends += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { status: 200 };
    } } as any, registry, 'jerry');
    const input = { operationId: OPERATION_ID, state: 'complete' as const,
      routeId: ROUTE_ID, generation: 9, deviceIds: [INSTALLATION_ID] };
    const [left, right] = await Promise.all([
      pusher.notifyQueryTerminal(input), pusher.notifyQueryTerminal(input),
    ]);
    assert.equal(sends, 1);
    assert.deepEqual(left, right);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unrelated terminal routes share one pusher-level APNs concurrency bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const registry = new DeviceRegistry(join(root, 'device-registry.json'));
    const deviceIds = Array.from({ length: 6 }, (_, index) =>
      `ios-installation-${String(index + 1).padStart(8, '0')}`);
    for (const [index, installationId] of deviceIds.entries()) {
      registry.register({
        device_token: String(index + 1).repeat(64),
        bundle_id: 'com.regina6.home23',
        env: 'sandbox',
        chat_ids: [],
        agent_id: 'jerry',
        installation_id: installationId,
        query_notifications: true,
      });
    }
    let active = 0;
    let maxActive = 0;
    let sends = 0;
    const pusher = new ApnsPusher({ async send() {
      sends += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 20));
      active -= 1;
      return { status: 200 };
    } } as any, registry, 'jerry', {
      queryMaxConcurrency: 2,
    } as any);

    await Promise.all([
      pusher.notifyQueryTerminal({
        operationId: OPERATION_ID,
        state: 'complete',
        routeId: `qroute_${'c'.repeat(32)}`,
        generation: 1,
        deviceIds: deviceIds.slice(0, 3),
      }),
      pusher.notifyQueryTerminal({
        operationId: `brop_${'d'.repeat(32)}`,
        state: 'partial',
        routeId: `qroute_${'e'.repeat(32)}`,
        generation: 1,
        deviceIds: deviceIds.slice(3),
      }),
    ]);

    assert.equal(sends, 6);
    assert.equal(maxActive, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hung APNs work is aborted and releases the bounded in-flight dedupe promise', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const registry = new DeviceRegistry(join(root, 'device-registry.json'));
    registry.register({
      device_token: DEVICE_TOKEN, bundle_id: 'com.regina6.home23', env: 'sandbox',
      chat_ids: [], agent_id: 'jerry', installation_id: INSTALLATION_ID,
      query_notifications: true,
    });
    let observedSignal: AbortSignal | undefined;
    const client = { async send(
      _token: string, _payload: unknown, _env: string, options?: { signal?: AbortSignal },
    ) {
      observedSignal = options?.signal;
      return await new Promise<never>(() => {});
    } };
    const pusher = new ApnsPusher(client as any, registry, 'jerry', {
      queryTimeoutMs: 20,
    } as any);
    const started = Date.now();
    const receipt = await Promise.race([
      pusher.notifyQueryTerminal({
        operationId: OPERATION_ID, state: 'complete', routeId: ROUTE_ID,
        generation: 11, deviceIds: [INSTALLATION_ID],
      }),
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('Query APNs deadline did not settle')), 250,
      )),
    ]);
    assert.ok(Date.now() - started < 250);
    assert.equal(observedSignal?.aborted, true);
    assert.deepEqual(receipt.failed, [{ deviceId: INSTALLATION_ID, retryable: true }]);
    assert.equal((pusher as any).queryDeliveries.size, 0);
    assert.equal(registry.queryNotificationReceiptSnapshot()[0]?.error_code, 'apns_timeout');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('failed Query delivery is durable and replay retries the same route generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const filePath = join(root, 'device-registry.json');
    const registry = new DeviceRegistry(filePath);
    registry.register({
      device_token: DEVICE_TOKEN,
      bundle_id: 'com.regina6.home23',
      env: 'sandbox',
      chat_ids: [],
      agent_id: 'jerry',
      installation_id: INSTALLATION_ID,
      query_notifications: true,
    });
    let attempts = 0;
    const client = { async send() {
      attempts += 1;
      return attempts === 1 ? { status: 500 } : { status: 200 };
    } };
    const input = {
      operationId: OPERATION_ID,
      state: 'partial' as const,
      routeId: ROUTE_ID,
      generation: 7,
      deviceIds: [INSTALLATION_ID],
    };
    const first = await new ApnsPusher(client as any, registry, 'jerry').notifyQueryTerminal(input);
    assert.deepEqual(first.failed, [{ deviceId: INSTALLATION_ID, retryable: true }]);
    assert.equal(registry.queryNotificationReceiptSnapshot()[0]?.state, 'failed');
    assert.equal(registry.queryNotificationReceiptSnapshot()[0]?.attempts, 1);

    const secondRegistry = new DeviceRegistry(filePath);
    const second = await new ApnsPusher(client as any, secondRegistry, 'jerry')
      .notifyQueryTerminal(input);
    assert.deepEqual(second.delivered, [INSTALLATION_ID]);
    assert.equal(secondRegistry.queryNotificationReceiptSnapshot()[0]?.attempts, 2);
    assert.equal(secondRegistry.queryNotificationReceiptSnapshot()[0]?.route_id, ROUTE_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pending receipt survives a crash-before-send and is retried after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const filePath = join(root, 'device-registry.json');
    const registry = new DeviceRegistry(filePath);
    registry.register({
      device_token: DEVICE_TOKEN,
      bundle_id: 'com.regina6.home23',
      env: 'sandbox',
      chat_ids: [],
      agent_id: 'jerry',
      installation_id: INSTALLATION_ID,
      query_notifications: true,
    });
    registry.beginQueryNotificationDelivery({
      routeId: ROUTE_ID,
      operationId: OPERATION_ID,
      deviceId: INSTALLATION_ID,
      generation: 2,
      terminalState: 'complete',
    });
    let sends = 0;
    const restarted = new DeviceRegistry(filePath);
    const result = await new ApnsPusher({ async send() {
      sends += 1;
      return { status: 200 };
    } } as any, restarted, 'jerry').notifyQueryTerminal({
      operationId: OPERATION_ID,
      state: 'complete',
      routeId: ROUTE_ID,
      generation: 2,
      deviceIds: [INSTALLATION_ID],
    });
    assert.equal(sends, 1);
    assert.deepEqual(result.delivered, [INSTALLATION_ID]);
    assert.equal(restarted.queryNotificationReceiptSnapshot()[0]?.attempts, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('APNs 410 invalidates the token and records a non-retryable receipt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const registry = new DeviceRegistry(join(root, 'device-registry.json'));
    registry.register({
      device_token: DEVICE_TOKEN,
      bundle_id: 'com.regina6.home23',
      env: 'sandbox',
      chat_ids: ['trusted-chat'],
      agent_id: 'jerry',
      installation_id: INSTALLATION_ID,
      query_notifications: true,
    });
    const receipt = await new ApnsPusher({ async send() { return { status: 410 }; } } as any,
      registry, 'jerry').notifyQueryTerminal({
      operationId: OPERATION_ID,
      state: 'failed',
      routeId: ROUTE_ID,
      generation: 3,
      deviceIds: [INSTALLATION_ID],
    });
    assert.deepEqual(receipt.failed, [{ deviceId: INSTALLATION_ID, retryable: false }]);
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.queryNotificationReceiptSnapshot()[0]?.error_code, 'device_invalid');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delivery receipt retention is hard-bounded without pruning pending recovery truth', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    let now = Date.parse('2026-07-13T12:00:00.000Z');
    const registry = new DeviceRegistry(join(root, 'device-registry.json'), {
      now: () => now,
      maxDeliveryReceipts: 2,
      maxFileBytes: 128 * 1024,
    } as any);
    registry.register({
      device_token: DEVICE_TOKEN, bundle_id: 'com.regina6.home23', env: 'sandbox',
      chat_ids: [], agent_id: 'jerry', installation_id: INSTALLATION_ID,
      query_notifications: true,
    });
    const begin = (letter: string, generation: number) => registry.beginQueryNotificationDelivery({
      routeId: `qroute_${letter.repeat(32)}`,
      operationId: `brop_${letter.repeat(32)}`,
      deviceId: INSTALLATION_ID,
      generation,
      terminalState: 'complete',
    });
    begin('a', 1);
    registry.finishQueryNotificationDelivery({
      routeId: `qroute_${'a'.repeat(32)}`, deviceId: INSTALLATION_ID,
      generation: 1, state: 'delivered',
    });
    now += 1_000;
    begin('b', 2);
    now += 1_000;
    begin('c', 3);
    assert.deepEqual(registry.queryNotificationReceiptSnapshot().map(row => row.route_id), [
      `qroute_${'b'.repeat(32)}`, `qroute_${'c'.repeat(32)}`,
    ]);
    assert.throws(() => begin('d', 4), { code: 'device_registry_capacity_exceeded' });

    assert.throws(() => new DeviceRegistry(join(root, 'device-registry.json'), {
      maxDeliveryReceipts: 1,
    } as any).queryNotificationReceiptSnapshot(), { code: 'device_registry_corrupt' });

    const oversized = join(root, 'oversized.json');
    writeFileSync(oversized, 'x'.repeat(1025));
    assert.throws(() => new DeviceRegistry(oversized, {
      maxFileBytes: 1024,
    } as any).list(), { code: 'device_registry_corrupt' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('delivery receipts use bounded per-route files instead of rewriting the device registry', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const filePath = join(root, 'device-registry.json');
    const registry = new DeviceRegistry(filePath, {
      maxDeliveryReceipts: 256,
      maxFileBytes: 128 * 1024,
    } as any);
    registry.register({
      device_token: DEVICE_TOKEN, bundle_id: 'com.regina6.home23', env: 'sandbox',
      chat_ids: [], agent_id: 'jerry', installation_id: INSTALLATION_ID,
      query_notifications: true,
    });
    const baseline = readFileSync(filePath, 'utf8');
    for (let index = 0; index < 128; index += 1) {
      const suffix = index.toString(36).padStart(32, '0');
      registry.beginQueryNotificationDelivery({
        routeId: `qroute_${suffix}`,
        operationId: `brop_${suffix}`,
        deviceId: INSTALLATION_ID,
        generation: 1,
        terminalState: 'complete',
      });
    }
    const after = readFileSync(filePath, 'utf8');
    assert.equal(after, baseline);
    assert.equal(registry.queryNotificationReceiptSnapshot().length, 128);
    const serializedReceipts = JSON.stringify(registry.queryNotificationReceiptSnapshot());
    assert.ok(Buffer.byteLength(serializedReceipts) < 128 * 4 * 1024);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipt recovery removes only owned crash temp files and rejects foreign entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const filePath = join(root, 'device-registry.json');
    const registry = new DeviceRegistry(filePath);
    registry.beginQueryNotificationDelivery({
      routeId: ROUTE_ID, operationId: OPERATION_ID, deviceId: INSTALLATION_ID,
      generation: 1, terminalState: 'complete',
    });
    const directory = `${filePath}.query-delivery-receipts`;
    const [receiptName] = readdirSync(directory);
    const crashTemp = join(directory, `.${receiptName}.999.${'a'.repeat(16)}.tmp`);
    writeFileSync(crashTemp, '{"partial":true}');

    const reopened = new DeviceRegistry(filePath);
    assert.equal(reopened.queryNotificationReceiptSnapshot().length, 1);
    assert.equal(existsSync(crashTemp), false);

    writeFileSync(join(directory, 'foreign-file'), 'do not delete');
    assert.throws(
      () => new DeviceRegistry(filePath).queryNotificationReceiptSnapshot(),
      { code: 'device_registry_corrupt' },
    );
    assert.equal(existsSync(join(directory, 'foreign-file')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('receipt reads and writes reject a symlinked receipt parent directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-query-push-'));
  try {
    const writeBase = join(root, 'write-registry.json');
    const writeTarget = join(root, 'write-target');
    mkdirSync(writeTarget);
    symlinkSync(writeTarget, `${writeBase}.query-delivery-receipts`, 'dir');
    const writeRegistry = new DeviceRegistry(writeBase);
    assert.throws(() => writeRegistry.beginQueryNotificationDelivery({
      routeId: ROUTE_ID, operationId: OPERATION_ID, deviceId: INSTALLATION_ID,
      generation: 1, terminalState: 'complete',
    }), { code: 'device_registry_corrupt' });
    assert.deepEqual(readdirSync(writeTarget), []);

    const readBase = join(root, 'read-registry.json');
    const readRegistry = new DeviceRegistry(readBase);
    readRegistry.beginQueryNotificationDelivery({
      routeId: ROUTE_ID, operationId: OPERATION_ID, deviceId: INSTALLATION_ID,
      generation: 2, terminalState: 'complete',
    });
    const readDirectory = `${readBase}.query-delivery-receipts`;
    const readTarget = join(root, 'read-target');
    renameSync(readDirectory, readTarget);
    symlinkSync(readTarget, readDirectory, 'dir');
    assert.throws(() => new DeviceRegistry(readBase).beginQueryNotificationDelivery({
      routeId: ROUTE_ID, operationId: OPERATION_ID, deviceId: INSTALLATION_ID,
      generation: 2, terminalState: 'complete',
    }), { code: 'device_registry_corrupt' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('terminal notification harness route fails closed and returns only bounded receipts', async () => {
  const {
    createQueryNotificationJsonParser,
    createQueryTerminalNotificationHandler,
  } = await import('../../src/routes/query-notifications.js');
  const calls: any[] = [];
  const pusher = { async notifyQueryTerminal(input: any) {
    calls.push(input);
    return {
      operationId: input.operationId,
      routeId: input.routeId,
      generation: input.generation,
      delivered: input.deviceIds,
      failed: [],
      pending: [],
    };
  } };
  const body = {
    operationId: OPERATION_ID,
    state: 'complete',
    agent: 'jerry',
    routeId: ROUTE_ID,
    generation: 4,
    deviceIds: [INSTALLATION_ID],
  };

  const unavailable = express();
  unavailable.post('/api/query-notifications/terminal', createQueryNotificationJsonParser(),
    createQueryTerminalNotificationHandler({ agentName: 'jerry', pusher } as any));
  assert.equal((await postJson(unavailable, '/api/query-notifications/terminal', body)).status, 503);

  const app = express();
  app.post('/api/query-notifications/terminal', createQueryNotificationJsonParser(),
    createQueryTerminalNotificationHandler({
      agentName: 'jerry', bridgeToken: 'bridge-token-configured', pusher,
    } as any));
  assert.equal((await postJson(app, '/api/query-notifications/terminal', body)).status, 401);
  const wrongAgent = await postJson(app, '/api/query-notifications/terminal', {
    ...body, agent: 'forrest',
  }, { authorization: 'Bearer bridge-token-configured' });
  assert.equal(wrongAgent.status, 400);
  const nonterminal = await postJson(app, '/api/query-notifications/terminal', {
    ...body, state: 'running',
  }, { authorization: 'Bearer bridge-token-configured' });
  assert.equal(nonterminal.status, 400);

  const accepted = await postJson(app, '/api/query-notifications/terminal', body, {
    authorization: 'Bearer bridge-token-configured',
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, {
    ok: true,
    operationId: OPERATION_ID,
    routeId: ROUTE_ID,
    generation: 4,
    delivered: [INSTALLATION_ID],
    failed: [],
    pending: [],
  });
  assert.deepEqual(calls, [{
    operationId: OPERATION_ID,
    state: 'complete',
    routeId: ROUTE_ID,
    generation: 4,
    deviceIds: [INSTALLATION_ID],
  }]);
});

test('harness mounts the bounded protected terminal route before broad Chat parsing', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'home.ts'), 'utf8');
  const route = source.indexOf("'/api/query-notifications/terminal'");
  const broad = source.indexOf("bridgeApp.use(express.json({ limit: '90mb' }))");
  assert.notEqual(route, -1);
  assert.notEqual(broad, -1);
  assert.equal(route < broad, true);
  assert.match(source, /createQueryTerminalNotificationHandler\(\{[\s\S]{0,400}bridgeToken:[\s\S]{0,400}pusher:/);
});

test('published device contract binds Query capability to installation identity', () => {
  const root = process.cwd();
  const schema = JSON.parse(readFileSync(join(root, 'contracts/schemas/device.schema.json'), 'utf8'));
  const request = JSON.parse(readFileSync(join(root, 'contracts/fixtures/device-register-request.json'), 'utf8'));
  const response = JSON.parse(readFileSync(join(root, 'contracts/fixtures/device-register-response.json'), 'utf8'));
  const registry = JSON.parse(readFileSync(join(root, 'contracts/fixtures/device-registry.json'), 'utf8'));
  assert.equal(request.installation_id, INSTALLATION_ID);
  assert.equal(request.query_notifications, true);
  assert.equal(response.installation_id, INSTALLATION_ID);
  assert.equal(response.query_notifications, true);
  assert.equal(registry.devices[0].installation_id, INSTALLATION_ID);
  assert.equal(registry.devices[0].query_notifications, true);
  assert.ok(schema.$defs.registerRequest.properties.installation_id);
  assert.ok(schema.$defs.registerRequest.properties.query_notifications);
  const { createContractValidator } = require('../contracts/contract-validator.cjs');
  const manifest = JSON.parse(readFileSync(join(root, 'contracts/manifest.json'), 'utf8'));
  const entry = manifest.entries.find((candidate: any) => candidate.id === 'device-register-request');
  const invalid = createContractValidator(root).validateValue(entry, {
    ...request,
    installation_id: null,
    query_notifications: true,
  });
  assert.equal(invalid.valid, false);
});
