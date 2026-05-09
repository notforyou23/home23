import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.OPENAI_API_KEY ||= 'test-key';
const { DashboardServer } = require('../../../engine/src/dashboard/server');

test('dashboard agenda fallback reads and appends status transitions from agenda.jsonl', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-agenda-fallback-'));
  try {
    fs.writeFileSync(path.join(dir, 'agenda.jsonl'), [
      JSON.stringify({ type: 'add', id: 'ag-1', record: { id: 'ag-1', status: 'surfaced', content: 'Check thing', createdAt: '2026-05-09T12:00:00.000Z' } }),
      JSON.stringify({ type: 'add', id: 'ag-2', record: { id: 'ag-2', status: 'candidate', content: 'Other thing', createdAt: '2026-05-09T12:01:00.000Z' } }),
    ].join('\n') + '\n');

    const server = Object.create(DashboardServer.prototype);
    const before = await server.getAgendaCountsForDir(dir);
    assert.equal(before.surfaced, 1);
    assert.equal(before.candidate, 1);

    const result = await server.appendAgendaStatusForDir(dir, 'ag-1', {
      status: 'stale',
      note: 'dismissed in test',
      actor: 'test',
    });
    const after = await server.getAgendaCountsForDir(dir);
    const rows = fs.readFileSync(path.join(dir, 'agenda.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

    assert.equal(result.ok, true);
    assert.equal(result.degraded, true);
    assert.equal(after.stale, 1);
    assert.equal(after.surfaced, 0);
    assert.equal(rows.at(-1).type, 'status');
    assert.equal(rows.at(-1).actor, 'test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dashboard agenda fallback counts and updates beyond the default list window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-agenda-fallback-window-'));
  try {
    const rows = [];
    for (let i = 0; i < 110; i += 1) {
      rows.push(JSON.stringify({
        type: 'add',
        id: `ag-stale-${i}`,
        record: {
          id: `ag-stale-${i}`,
          status: 'stale',
          content: 'Resolved item',
          createdAt: `2026-05-09T13:${String(i % 60).padStart(2, '0')}:00.000Z`,
          updatedAt: `2026-05-09T13:${String(i % 60).padStart(2, '0')}:00.000Z`,
        },
      }));
    }
    rows.unshift(JSON.stringify({
      type: 'add',
      id: 'ag-old-surfaced',
      record: {
        id: 'ag-old-surfaced',
        status: 'surfaced',
        content: 'Old active item',
        createdAt: '2026-05-01T12:00:00.000Z',
        updatedAt: '2026-05-01T12:00:00.000Z',
      },
    }));
    fs.writeFileSync(path.join(dir, 'agenda.jsonl'), rows.join('\n') + '\n');

    const server = Object.create(DashboardServer.prototype);
    const before = await server.getAgendaCountsForDir(dir);
    const result = await server.appendAgendaStatusForDir(dir, 'ag-old-surfaced', {
      status: 'stale',
      note: 'staled old active row',
      actor: 'test',
    });
    const after = await server.getAgendaCountsForDir(dir);

    assert.equal(before.surfaced, 1);
    assert.equal(before.stale, 110);
    assert.equal(result.ok, true);
    assert.equal(after.surfaced, 0);
    assert.equal(after.stale, 111);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
