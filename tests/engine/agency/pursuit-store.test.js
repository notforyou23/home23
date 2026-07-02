import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PursuitStore } from '../../../engine/src/agency/pursuit-store.js';

test('PursuitStore lists recent inbox rows without loading the whole ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-pursuit-store-'));
  const store = new PursuitStore({ brainDir: dir, agentName: 'jerry' });
  for (let i = 0; i < 40; i += 1) {
    store.appendInbox({ id: `inbox-${i}`, summary: `entry ${i}` });
  }

  const rows = store.listInbox({ limit: 5 });

  assert.deepEqual(rows.map((row) => row.id), ['inbox-39', 'inbox-38', 'inbox-37', 'inbox-36', 'inbox-35']);
});
