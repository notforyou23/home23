import assert from 'node:assert/strict';
import test from 'node:test';
import { residentWorkProjectionChangesSince } from '../../../src/coordination/app/resident-work-projection.js';
import type { M11Database } from '../../../src/coordination/work/types.js';

function journal(kinds: string[]) {
  const events = kinds.map((kind, index) => ({ sequence: index + 1, kind }));
  const calls: number[] = [];
  const database = {
    readAll(_sql: string, after: number) {
      calls.push(after);
      return events.filter(event => event.sequence > after).slice(0, 128);
    },
  } as unknown as M11Database;
  return { database, calls };
}

test('resident Work projection skips a quiet or unrelated journal', async () => {
  const empty = journal([]);
  assert.deepEqual(await residentWorkProjectionChangesSince(empty.database, 0), { changed: false, cursor: 0 });
  const unrelated = journal(Array(300).fill('device_notification'));
  assert.deepEqual(await residentWorkProjectionChangesSince(unrelated.database, 0), { changed: false, cursor: 300 });
  assert.deepEqual(unrelated.calls, [0, 128, 256]);
});

test('resident Work projection refreshes after a changed Work or assignment event', async () => {
  const work = journal([...Array(180).fill('device_notification'), 'work']);
  assert.deepEqual(await residentWorkProjectionChangesSince(work.database, 0), { changed: true, cursor: 181 });
  assert.deepEqual(work.calls, [0, 128]);
  const assignment = journal(['resident_assignment']);
  assert.deepEqual(await residentWorkProjectionChangesSince(assignment.database, 0), { changed: true, cursor: 1 });
});
