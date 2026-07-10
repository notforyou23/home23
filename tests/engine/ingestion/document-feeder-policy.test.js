import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DocumentFeeder } = require('../../../engine/src/ingestion/document-feeder');

function makeFeeder(config = {}, logs = []) {
  return new DocumentFeeder({
    memory: { embed: async () => null },
    config,
    logger: {
      info: (message, meta) => logs.push({ level: 'info', message, meta }),
      warn: (message, meta) => logs.push({ level: 'warn', message, meta }),
      debug: () => {},
      error: (message, meta) => logs.push({ level: 'error', message, meta }),
    },
  });
}

test('document feeder applies configured exclude globs outside chokidar', () => {
  const feeder = makeFeeder({
    excludePatterns: [
      '**/health_jtr/raw_ingest/**',
      '**/health_jtr/ledgers/*.jsonl',
    ],
  });

  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/health_jtr/raw_ingest/healthkit_2026.json'),
    true
  );
  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/health_jtr/ledgers/daily_metrics.jsonl'),
    true
  );
  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/health_jtr/ledgers/pressure_correlation.json'),
    false
  );
});

test('document feeder ignores volatile cron status snapshots by default', () => {
  const feeder = makeFeeder();

  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/instances/jerry/workspace/cron/status.md'),
    true
  );
  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/instances/jerry/workspace/cron/catalog.json'),
    true
  );
  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/instances/jerry/workspace/cron/README.md'),
    false
  );
});

test('document feeder ignores legacy volatile active snapshots but ingests live durable session transcripts', () => {
  const feeder = makeFeeder();

  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/instances/jerry/workspace/sessions/active-dashboard-jerry-1778341794681.md'),
    true
  );
  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/instances/jerry/workspace/sessions/session-live-dashboard-jerry-1778341794681.md'),
    false
  );
  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/instances/jerry/workspace/sessions/session-2026-05-09T16-12-55.md'),
    false
  );
  assert.equal(
    feeder._shouldIgnorePath('/tmp/home23/instances/jerry/workspace/sessions/backfill-dashboard-jerry-1776275538903.md'),
    false
  );
});

test('document feeder skips oversized files before reading or compiling', async () => {
  const logs = [];
  const feeder = makeFeeder({ maxFileBytes: 5 }, logs);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-feeder-'));
  const filePath = path.join(dir, 'large.txt');
  fs.writeFileSync(filePath, '0123456789', 'utf8');

  await feeder._processFile(filePath, 'tmp');

  assert.equal(logs.some(entry => entry.message === 'Skipping file above feeder maxFileBytes'), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('document feeder ignores duplicate in-flight processing for same file', async () => {
  const feeder = makeFeeder();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-feeder-'));
  const filePath = path.join(dir, 'doc.md');
  fs.writeFileSync(filePath, 'hello world', 'utf8');
  feeder._processingFiles.add(path.resolve(filePath));

  await feeder._processFile(filePath, 'tmp');

  assert.equal(feeder._processingFiles.has(path.resolve(filePath)), true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('document feeder records deterministic conversion failures until file content changes', async () => {
  const feeder = makeFeeder();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-feeder-'));
  const filePath = path.join(dir, 'broken.pdf');
  fs.writeFileSync(filePath, 'not a real pdf', 'utf8');

  let recordedHash = null;
  let convertCalls = 0;
  const quarantined = [];

  feeder.manifest = {
    isStale: async (_filePath, fullHash) => fullHash !== recordedHash,
    trackQuarantined: async (_filePath, label, fullHash, validation) => {
      recordedHash = fullHash;
      quarantined.push({ label, fullHash, validation });
    },
  };
  feeder.converter = {
    isNativeText: () => false,
    isConvertible: () => true,
    convertDetailed: async () => {
      convertCalls += 1;
      return {
        ok: false,
        status: 'conversion_failed',
        retryable: false,
        error: 'invalid pdf syntax',
      };
    },
  };

  await feeder._processFile(filePath, 'tmp');
  await feeder._processFile(filePath, 'tmp');

  assert.equal(convertCalls, 1);
  assert.equal(quarantined.length, 1);
  assert.equal(quarantined[0].validation.status, 'conversion_failed');

  fs.writeFileSync(filePath, 'changed bad pdf', 'utf8');
  await feeder._processFile(filePath, 'tmp');

  assert.equal(convertCalls, 2);
  assert.equal(quarantined.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('document feeder does not quarantine retryable converter outages', async () => {
  const feeder = makeFeeder();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-feeder-'));
  const filePath = path.join(dir, 'retry.pdf');
  fs.writeFileSync(filePath, 'pdf bytes', 'utf8');

  let convertCalls = 0;
  let quarantineCalls = 0;
  feeder.manifest = {
    isStale: async () => true,
    trackQuarantined: async () => {
      quarantineCalls += 1;
    },
  };
  feeder.converter = {
    isNativeText: () => false,
    isConvertible: () => true,
    convertDetailed: async () => {
      convertCalls += 1;
      return { ok: false, status: 'converter_unavailable', retryable: true };
    },
  };

  await feeder._processFile(filePath, 'tmp');
  await feeder._processFile(filePath, 'tmp');

  assert.equal(convertCalls, 2);
  assert.equal(quarantineCalls, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('document feeder watcher leaves existing files to the explicit startup scan', () => {
  const feeder = makeFeeder();

  assert.equal(feeder._watcherOptions().ignoreInitial, true);
});

test('document feeder rejects compile jobs when pending queue is full', async () => {
  const logs = [];
  const feeder = makeFeeder({ compiler: { maxConcurrent: 1, maxQueue: 1 } }, logs);
  feeder.compiler = {
    compile: () => new Promise(() => {}),
  };

  feeder._queueCompile('active', { filePath: 'active.md' }).catch(() => {});
  const queued = feeder._queueCompile('queued', { filePath: 'queued.md' });
  await assert.rejects(
    () => feeder._queueCompile('overflow', { filePath: 'overflow.md' }),
    { code: 'FEEDER_COMPILE_QUEUE_FULL' }
  );

  assert.equal(feeder._compileActive, 1);
  assert.equal(feeder._compileQueue.length, 1);
  assert.equal(logs.some(entry => entry.message === 'Document compiler queue full, falling back to raw text'), true);
  queued.catch(() => {});
});

test('document feeder opens compiler circuit after repeated failures', async () => {
  const logs = [];
  const feeder = makeFeeder({
    compiler: {
      circuitFailures: 2,
      circuitCooldownMs: 10_000,
    },
  }, logs);
  feeder.compiler = {
    compile: async () => {
      throw new Error('provider unavailable');
    },
  };

  await assert.rejects(() => feeder._queueCompile('a', { filePath: 'a.md' }), /provider unavailable/);
  await assert.rejects(() => feeder._queueCompile('b', { filePath: 'b.md' }), /provider unavailable/);
  await assert.rejects(
    () => feeder._queueCompile('c', { filePath: 'c.md' }),
    { code: 'FEEDER_COMPILER_CIRCUIT_OPEN' }
  );

  assert.equal(feeder._isCompileCircuitOpen(), true);
  assert.equal(logs.some(entry => entry.message === 'Document compiler circuit opened after repeated failures'), true);
});

test('document feeder status exposes compile queue and circuit state', async () => {
  const feeder = makeFeeder({
    compiler: {
      model: 'MiniMax-M3',
      maxConcurrent: 2,
      maxQueue: 3,
      circuitCooldownMs: 1234,
    },
  });
  feeder._started = true;
  feeder.manifest = { getStats: () => ({ fileCount: 0, nodeCount: 0, pendingCount: 0 }) };
  feeder.converter = { available: false };
  feeder._compileQueue.push({ text: 'queued' });
  feeder._compileActive = 1;
  feeder._compileFailureCount = 4;
  feeder._compileCircuitOpenUntil = Date.now() + 1234;

  const status = await feeder.getStatus();

  assert.deepEqual(status.compiler.queue, {
    queued: 1,
    active: 1,
    maxConcurrent: 2,
    maxQueued: 3,
  });
  assert.equal(status.compiler.model, 'MiniMax-M3');
  assert.equal(status.compiler.circuit.open, true);
  assert.equal(status.compiler.circuit.failureCount, 4);
  assert.equal(status.compiler.circuit.cooldownMs, 1234);
});
