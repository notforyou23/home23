import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryIngest, applyChannelCap, CHANNEL_CAPS } from '../../../engine/src/channels/memory-ingest.cjs';
import { makeTraceId } from '../../../engine/src/channels/contract.js';

test('CHANNEL_CAPS has the six channel-class methods', () => {
  for (const k of ['sensor_primary', 'sensor_derived', 'build_event', 'work_event', 'neighbor_gossip', 'zero_context_audit']) {
    assert.ok(typeof CHANNEL_CAPS[k] === 'number', `missing cap: ${k}`);
  }
});

test('applyChannelCap clamps confidence at the cap', () => {
  assert.equal(applyChannelCap('neighbor_gossip', 0.95), 0.70);
  assert.equal(applyChannelCap('build_event', 0.5), 0.5);
  assert.equal(applyChannelCap('unknown_method', 0.99), 0.99);
});

test('MemoryIngest.writeFromObservation creates a full MemoryObject and a receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const obs = {
    channelId: 'build.git',
    sourceRef: 'git:abc1234',
    receivedAt: '2026-04-21T15:00:00Z',
    producedAt: '2026-04-21T15:00:00Z',
    flag: 'COLLECTED',
    confidence: 0.99,
    payload: { sha: 'abc1234', subject: 'feat: thing' },
    verifierId: 'git:log',
  };
  const draft = { method: 'build_event', type: 'observation', topic: 'git', tags: ['build', 'git'] };
  const mo = await ingest.writeFromObservation(obs, draft);
  assert.ok(mo.memory_id);
  assert.equal(mo.type, 'observation');
  assert.equal(mo.confidence.score, 0.9); // capped at build_event cap
  assert.equal(mo.provenance.generation_method, 'build_event');
  assert.ok(mo.provenance.source_refs.includes('git:abc1234'));
  assert.ok(existsSync(join(dir, 'memory-objects.json')));
  assert.ok(existsSync(join(dir, 'crystallization-receipts.jsonl')));
  const raw = JSON.parse(readFileSync(join(dir, 'memory-objects.json'), 'utf8'));
  assert.equal(raw.objects.length, 1);
  assert.equal(raw.objects[0].provenance.trace_id, makeTraceId('build.git', 'git:abc1234'));
  assert.ok(raw.objects[0].provenance.source_refs.includes(makeTraceId('build.git', 'git:abc1234')));
  const receiptLines = readFileSync(join(dir, 'crystallization-receipts.jsonl'), 'utf8').trim().split('\n');
  assert.equal(receiptLines.length, 1);
  const r = JSON.parse(receiptLines[0]);
  assert.equal(r.traceId, makeTraceId('build.git', 'git:abc1234'));
  assert.equal(r.channelId, 'build.git');
  assert.equal(r.memoryObjectId, mo.memory_id);
});

test('MemoryIngest dedupes by {channelId, sourceRef} — same ref updates not duplicates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-dedupe-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const obs = {
    channelId: 'build.git', sourceRef: 'git:same', receivedAt: '2026-04-21T00:00:00Z',
    producedAt: '2026-04-21T00:00:00Z', flag: 'COLLECTED', confidence: 0.9, payload: { sha: 'same' },
  };
  const draft = { method: 'build_event', type: 'observation', topic: 'git', tags: [] };
  const first = await ingest.writeFromObservation(obs, draft);
  const second = await ingest.writeFromObservation(obs, draft);
  assert.equal(first.memory_id, second.memory_id);
  const raw = JSON.parse(readFileSync(join(dir, 'memory-objects.json'), 'utf8'));
  assert.equal(raw.objects.length, 1);
});

test('MemoryIngest caps zero-context audit confidence hard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-zc-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const obs = {
    channelId: 'domain.weather', sourceRef: 'weather:zero:t0', receivedAt: 't', producedAt: 't',
    flag: 'ZERO_CONTEXT', confidence: 0.9, payload: { __zeroContext: true },
  };
  const mo = await ingest.writeFromObservation(obs, { method: 'zero_context_audit', type: 'observation', topic: 'weather', tags: [] });
  assert.ok(mo.confidence.score <= 0.2);
});

test('MemoryIngest preserves cross-agent origin on memory object and receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-origin-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const obs = {
    channelId: 'neighbor.forrest',
    sourceRef: 'neighbor:forrest:2026-04-24T12:00:00Z',
    receivedAt: '2026-04-24T12:00:01Z',
    producedAt: '2026-04-24T12:00:00Z',
    flag: 'UNCERTIFIED',
    confidence: 0.7,
    payload: { agent: 'forrest', snapshotAt: '2026-04-24T12:00:00Z' },
    origin: {
      agent: 'forrest',
      peerName: 'forrest',
      peerSource: 'remote',
      url: 'http://forrest.local/__state/public.json',
      snapshotAt: '2026-04-24T12:00:00Z',
      protocol: 'home23-neighbor-state',
      protocolVersion: 1,
    },
  };
  const draft = {
    method: 'neighbor_gossip',
    type: 'observation',
    topic: 'neighbor-state',
    tags: ['neighbor', 'forrest', 'agent:forrest'],
  };

  const mo = await ingest.writeFromObservation(obs, draft);
  assert.equal(mo.provenance.origin.agent, 'forrest');
  assert.equal(mo.provenance.origin.peerSource, 'remote');
  assert.ok(mo.provenance.source_refs.includes('agent:forrest'));

  const receipt = JSON.parse(readFileSync(join(dir, 'crystallization-receipts.jsonl'), 'utf8').trim());
  assert.equal(receipt.origin.agent, 'forrest');
  assert.equal(receipt.origin.protocol, 'home23-neighbor-state');
});

test('MemoryIngest serializes concurrent bus writes through one process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-concurrent-'));
  const warnings = [];
  const ingest = new MemoryIngest({
    brainDir: dir,
    logger: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      error() {},
      info() {},
      debug() {},
    },
  });
  const draft = { method: 'build_event', type: 'observation', topic: 'test', tags: ['test'] };
  const obs = (i) => ({
    channelId: 'test.concurrent',
    sourceRef: `ref-${i}`,
    receivedAt: '2026-05-04T00:00:00Z',
    producedAt: '2026-05-04T00:00:00Z',
    flag: 'COLLECTED',
    confidence: 0.9,
    payload: { i },
  });

  const results = await Promise.allSettled(
    Array.from({ length: 80 }, (_, i) => ingest.writeFromObservation(obs(i), draft))
  );

  assert.equal(results.filter(r => r.status === 'rejected').length, 0);
  assert.equal(warnings.filter(w => w.includes('Lock file is already being held')).length, 0);
  const raw = JSON.parse(readFileSync(join(dir, 'memory-objects.json'), 'utf8'));
  assert.equal(raw.objects.length, 80);
});
