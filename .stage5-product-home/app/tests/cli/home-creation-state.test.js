import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import creationState from '../../shared/home-creation-state.cjs';
import { runStart } from '../../cli/lib/pm2-commands.js';

const { assertHomeCreationReady } = creationState;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'home23-start-readiness-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('legacy installations need no new receipt and a prepared creation can start', (t) => {
  const root = fixture(t);
  assert.doesNotThrow(() => assertHomeCreationReady(root));
  assert.deepEqual(readdirSync(root), [], 'readiness never prepares state as a side effect');
  mkdirSync(join(root, 'instances', '.house'), { recursive: true });
  writeFileSync(join(root, 'instances', '.house', 'creation.json'), '{"status":"prepared"}\n');
  assert.doesNotThrow(() => assertHomeCreationReady(root));
});

test('named and all-agent starts refuse partial or unreadable creation before build or startup', async (t) => {
  const root = fixture(t);
  mkdirSync(join(root, 'instances', '.house'), { recursive: true });
  const receiptPath = join(root, 'instances', '.house', 'creation.json');
  for (const raw of ['{"status":"preparing"}', '{"status":"failed"}', '{broken', '{}']) {
    writeFileSync(receiptPath, raw);
    for (const name of ['river', undefined]) {
      await assert.rejects(runStart(root, name), (error) => error.code === 'home_creation_incomplete'
        && /Resume setup/.test(error.message));
    }
    assert.equal(readFileSync(receiptPath, 'utf8'), raw, 'the failed start never repairs or changes the receipt');
  }
});
