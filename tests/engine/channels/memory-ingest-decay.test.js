import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryIngest } from '../../../engine/src/channels/memory-ingest.js';

async function seedWithTag(ingest, tag, ageMs) {
  const obs = {
    channelId: 'test.src',
    sourceRef: `ref-${tag}-${ageMs}`,
    receivedAt: new Date(Date.now() - ageMs).toISOString(),
    producedAt: new Date(Date.now() - ageMs).toISOString(),
    flag: 'COLLECTED', confidence: 0.9, payload: { t: tag },
  };
  const draft = { method: 'build_event', type: 'observation', topic: 'test', tags: [tag] };
  return ingest.writeFromObservation(obs, draft);
}

test('applyDecay reduces confidence of tag-matched objects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mid-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  await seedWithTag(ingest, 'warning', 0);
  // Manipulate created_at to 96h ago so decay has something to work on
  const path = join(dir, 'memory-objects.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.objects[0].created_at = new Date(Date.now() - 96 * 3600 * 1000).toISOString();
  const fs = await import('node:fs');
  fs.writeFileSync(path, JSON.stringify(raw));

  const updated = await ingest.applyDecay({ now: Date.now(), rules: { warning: { halfLifeMs: 48 * 3600 * 1000 } } });
  assert.equal(updated.length, 1);
  // 96h / 48h = 2 half-lives → factor = 0.25 → 0.9 * 0.25 = 0.225
  assert.ok(updated[0].confidence.score < 0.3);
  assert.ok(updated[0].last_decayed_at);
});

test('applyDecay ignores objects without matching tags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mid2-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  await seedWithTag(ingest, 'unrelated', 0);
  const path = join(dir, 'memory-objects.json');
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  raw.objects[0].created_at = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
  const fs = await import('node:fs');
  fs.writeFileSync(path, JSON.stringify(raw));
  const updated = await ingest.applyDecay({ now: Date.now(), rules: { warning: { halfLifeMs: 48 * 3600 * 1000 } } });
  assert.equal(updated.length, 0);
});

test('applyDecay returns empty when no rules given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mid3-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  await seedWithTag(ingest, 'warning', 0);
  const r = await ingest.applyDecay({ rules: {} });
  assert.deepEqual(r, []);
});
