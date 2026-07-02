import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const HEALTH_API = '/Users/jtr/_JTR23_/release/home23/instances/forrest/workspace/scripts/health-api.py';

function readHealthApi(t) {
  if (!existsSync(HEALTH_API)) {
    t.skip(`live Forrest health API script is not present: ${HEALTH_API}`);
  }
  return readFileSync(HEALTH_API, 'utf8');
}

test('Forrest health API appends JSONL through fsync and read-back verification', (t) => {
  const source = readHealthApi(t);

  assert.match(source, /import os/);
  assert.match(source, /def append_jsonl_durable\(/);
  assert.match(source, /os\.fsync\(f\.fileno\(\)\)/);
  assert.match(source, /verify_tail_jsonl\(/);
  assert.doesNotMatch(source, /append_jsonl\(SUBJECTIVE_STATE_LEDGER, entry\)/);
});
