import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildGoodLifeSnapshot } = require('../../../engine/src/good-life/snapshot.js');

test('Good Life snapshot excludes its own diagnostic live-problems from viability counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-snapshot-'));
  try {
    writeFileSync(join(dir, 'live-problems.json'), JSON.stringify({
      problems: [
        {
          id: 'agenda_ag-good-life',
          state: 'open',
          claim: 'Agenda action: Diagnose Good Life repair drift using instances/jerry/brain/good-life-state.json',
        },
        {
          id: 'agenda_ag-real',
          state: 'open',
          claim: 'Agenda action: Check what process started around the CPU signal',
        },
      ],
    }));

    const snapshot = buildGoodLifeSnapshot({ runtimeRoot: dir });
    assert.equal(snapshot.liveProblems.open, 1);
    assert.equal(snapshot.liveProblems.total, 1);
    assert.equal(snapshot.liveProblems.goodLifeDiagnostics, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Good Life agenda summary counts latest item status, not raw JSONL events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-good-life-agenda-'));
  try {
    const rows = [
      { type: 'add', id: 'ag-1', record: { status: 'candidate', content: 'first' } },
      { type: 'status', id: 'ag-1', status: 'stale' },
      { type: 'add', id: 'ag-2', record: { status: 'candidate', content: 'second' } },
      { type: 'status', id: 'ag-2', status: 'surfaced' },
      { type: 'add', id: 'ag-3', record: { status: 'candidate', content: 'third' } },
      { type: 'status', id: 'ag-3', status: 'acted_on' },
      { type: 'add', id: 'ag-4', record: { status: 'candidate', content: 'fourth' } },
    ];
    writeFileSync(join(dir, 'agenda.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    const snapshot = buildGoodLifeSnapshot({ runtimeRoot: dir });
    assert.equal(snapshot.agenda.pending, 2);
    assert.equal(snapshot.agenda.candidate, 1);
    assert.equal(snapshot.agenda.surfaced, 1);
    assert.equal(snapshot.agenda.stale, 1);
    assert.equal(snapshot.agenda.actedOn, 1);
    assert.equal(snapshot.agenda.sampled, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
