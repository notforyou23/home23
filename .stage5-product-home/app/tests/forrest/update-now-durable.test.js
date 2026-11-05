import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

function readLiveScript(path, t) {
  if (!existsSync(path)) {
    t.skip(`live instance script is not present in this checkout: ${path}`);
  }
  return readFileSync(path, 'utf8');
}

test('Forrest NOW refresh uses atomic fsync write instead of direct write_text', (t) => {
  const source = readLiveScript('/Users/jtr/_JTR23_/release/home23/instances/forrest/workspace/scripts/update_now.py', t);

  assert.match(source, /def atomic_write_text\(/);
  assert.match(source, /os\.fsync\(f\.fileno\(\)\)/);
  assert.match(source, /os\.replace\(tmp, path\)/);
  assert.doesNotMatch(source, /OUT\.write_text\(/);
});

test('Jerry NOW refresh uses atomic fsync write instead of direct write_text', (t) => {
  const source = readLiveScript('/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/scripts/update_now.py', t);

  assert.match(source, /def atomic_write_text\(/);
  assert.match(source, /os\.fsync\(f\.fileno\(\)\)/);
  assert.match(source, /os\.replace\(tmp, path\)/);
  assert.doesNotMatch(source, /OUT\.write_text\(/);
});
