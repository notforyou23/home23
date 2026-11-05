import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgendaChannel } from '../../../../engine/src/channels/work/agenda-channel.js';

test('AgendaChannel parses nested record shape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agenda-'));
  const path = join(dir, 'agenda.jsonl');
  writeFileSync(path, '');
  const ch = new AgendaChannel({ path });
  await ch.start();
  const line = JSON.stringify({
    type: 'add', id: 'ag-1',
    record: { id: 'ag-1', content: 'Fix the thing', kind: 'decision', topicTags: ['build'], createdAt: '2026-04-21T00:00:00Z' },
  });
  appendFileSync(path, line + '\n');
  const out = [];
  for await (const p of ch.source()) { out.push(ch.verify(p)); if (out.length >= 1) break; }
  await ch.stop();
  assert.equal(out[0].payload.id, 'ag-1');
  assert.equal(out[0].payload.kind, 'decision');
  const d = ch.crystallize(out[0]);
  assert.ok(d.tags.includes('decision'));
  assert.ok(d.tags.includes('build'));
});
