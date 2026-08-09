import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as NetServer } from 'node:net';
import express from 'express';
import { startBridgeWithRecovery } from '../../src/routes/evobrew-bridge.js';

function holdPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const holder: NetServer = createServer();
    holder.once('error', reject);
    holder.listen(0, () => {
      const address = holder.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no address'));
        return;
      }
      resolve({
        port: address.port,
        release: () => new Promise((done) => holder.close(() => done())),
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, deadlineMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > deadlineMs) throw new Error('waitFor deadline exceeded');
    await sleep(10);
  }
}

test('startBridgeWithRecovery binds immediately when the port is free', async () => {
  const { port, release } = await holdPort();
  await release();

  const handle = await startBridgeWithRecovery(express(), port, { log: () => {} });
  try {
    assert.equal(handle.isDegraded(), false);
    assert.ok(handle.getServer(), 'server must be present');
  } finally {
    await handle.stop();
  }
});

test('startBridgeWithRecovery retries EADDRINUSE and recovers within the quick phase', async () => {
  const { port, release } = await holdPort();
  const logs: string[] = [];

  const releaseSoon = (async () => {
    await sleep(30);
    await release();
  })();

  const handle = await startBridgeWithRecovery(express(), port, {
    quickAttempts: 5,
    quickDelayMs: 20,
    log: (msg) => logs.push(msg),
    diagnose: async () => 'holder: test',
  });
  await releaseSoon;
  try {
    assert.equal(handle.isDegraded(), false);
    assert.ok(handle.getServer());
    assert.ok(logs.some((l) => l.includes('holder: test')), 'diagnosis must be logged');
  } finally {
    await handle.stop();
  }
});

test('startBridgeWithRecovery enters degraded mode, keeps retrying, and self-heals', async () => {
  const { port, release } = await holdPort();
  const logs: string[] = [];

  const handle = await startBridgeWithRecovery(express(), port, {
    quickAttempts: 2,
    quickDelayMs: 15,
    backgroundRetryMs: 40,
    log: (msg) => logs.push(msg),
    diagnose: async () => 'holder: test',
  });
  try {
    assert.equal(handle.isDegraded(), true, 'must report degraded while the port is held');
    assert.equal(handle.getServer(), null);

    await release();
    await waitFor(() => !handle.isDegraded(), 2000);
    assert.ok(handle.getServer(), 'server must be bound after the holder releases');
    assert.ok(
      logs.some((l) => l.toLowerCase().includes('degraded')),
      'entering degraded mode must be reported',
    );
  } finally {
    await handle.stop();
  }
});

test('startBridgeWithRecovery stop() cancels background retries while degraded', async () => {
  const { port, release } = await holdPort();

  const handle = await startBridgeWithRecovery(express(), port, {
    quickAttempts: 1,
    quickDelayMs: 10,
    backgroundRetryMs: 30,
    log: () => {},
    diagnose: async () => '',
  });
  assert.equal(handle.isDegraded(), true);
  await handle.stop();
  await release();
  await sleep(90);
  assert.equal(handle.getServer(), null, 'stopped handle must not bind after stop()');
});

test('startBridgeWithRecovery rejects non-EADDRINUSE errors immediately', async () => {
  await assert.rejects(
    () => startBridgeWithRecovery(express(), 0.5 as number, { log: () => {} }),
    (err: NodeJS.ErrnoException) => err.code === 'bridge_port_invalid',
  );
});
