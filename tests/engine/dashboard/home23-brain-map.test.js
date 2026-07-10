import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';

const source = await fsp.readFile(new URL('../../../engine/src/dashboard/home23-brain-map.js', import.meta.url), 'utf8');

test('installed brain map requests bounded graph limits and never full graph', () => {
  assert.match(source, /\/home23\/api\/brain\/graph\?nodeLimit=2000&edgeLimit=8000/);
  assert.doesNotMatch(source, /limit=2500/);
  assert.doesNotMatch(source, /edgeLimit=10000/);
  assert.doesNotMatch(source, /full=1/);
});

test('brain map accepts compatibility success and meta aliases', () => {
  assert.match(source, /!data\.success/);
  assert.match(source, /data\.meta/);
  assert.match(source, /data\.nodes/);
  assert.match(source, /data\.edges/);
});
