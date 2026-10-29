import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryObjectStore } from '../../src/agent/memory-objects.js';
import { TriggerIndex } from '../../src/agent/trigger-index.js';

test('a long-lived trigger index sees external durable promotion and supersession without a restart', t => {
  const dir = mkdtempSync(join(tmpdir(), 'trigger-freshness-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'memory-objects.json');
  writeFileSync(path, JSON.stringify({ objects: [] }));
  const store = new MemoryObjectStore(dir);
  const index = new TriggerIndex();
  index.loadFrom(store);
  const evaluate = () => index.evaluate('Tell me about the Atlas', { isFirstTurn: false }, undefined, undefined, () => null);
  assert.equal(evaluate().length, 0);
  const memory = { memory_id: 'mo_truck', lifecycle_layer: 'durable', status: 'approved', title: 'Atlas',
    triggers: [{ trigger_type: 'keyword', condition: 'Atlas' }] };
  writeFileSync(path, JSON.stringify({ objects: [memory] }));
  assert.equal(evaluate()[0]?.memoryId, 'mo_truck');
  writeFileSync(path, JSON.stringify({ objects: [{ ...memory, superseded_by: ['mo_new'] }] }));
  assert.equal(evaluate().length, 0, 'retired memory must stop firing in the same process');
  writeFileSync(path, '{broken');
  assert.equal(evaluate().length, 0, 'unreadable current data cannot reactivate a cached retired memory');
});

test('initial corrupt memory does not prevent construction of a resident trigger reader', t => {
  const dir = mkdtempSync(join(tmpdir(), 'trigger-corrupt-start-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'memory-objects.json'), '{torn');
  const index = new TriggerIndex();
  assert.doesNotThrow(() => index.loadFrom(new MemoryObjectStore(dir)));
  assert.deepEqual(index.evaluate('Atlas', { isFirstTurn: true }, undefined, undefined, () => null), []);
});
