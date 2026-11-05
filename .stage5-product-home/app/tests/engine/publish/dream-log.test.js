import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DreamLogPublisher } from '../../../engine/src/publish/dream-log.js';

test('DreamLogPublisher only writes on critic-keep verdict', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dl-'));
  const pub = new DreamLogPublisher({ outDir: dir, ledger: { record: async () => {} } });
  await pub.onCriticVerdict({ verdict: 'discard', creative: { text: 't' } });
  assert.equal(readdirSync(dir).length, 0);
  await pub.onCriticVerdict({ verdict: 'keep', creative: { title: 'moon', text: 'poem' } });
  assert.equal(readdirSync(dir).length, 1);
});
