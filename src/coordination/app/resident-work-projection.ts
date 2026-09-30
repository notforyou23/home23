import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { M11Database } from '../work/types.js';
import { createResidentAssignments } from './resident-assignments.js';
import type { ResidentInitiationAdmission } from './resident-initiations.js';

const PROJECTION_EVENT_KINDS = new Set([
  'work', 'message', 'resident_assignment', 'resident_outcome', 'work_thread_presentation', 'resident_initiation_work', 'resident_initiation_stop',
]);

function initiativeProvenance(database: M11Database, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return rows;
  const admitted = new Map(database.readAll<{ id: string; payload: string }>(`SELECT ids.value AS id,e.payload_json AS payload
    FROM json_each(?) ids JOIN events e ON e.aggregate_kind='resident_initiation_work' AND e.aggregate_id=ids.value AND e.aggregate_version=1`,
    JSON.stringify(rows.map(row => row.id))).map(row => [row.id, JSON.parse(row.payload) as ResidentInitiationAdmission]));
  return rows.map(row => {
    const value = admitted.get(String(row.id));
    if (!value) return row;
    const { originalRequest: _, assignmentState, ...rest } = row;
    return { ...rest, origin: 'resident_initiative', purpose: value.request.purpose,
      residentMove: value.request.nextMove, initiative: value.request,
      ...(value.request.purpose === 'action' ? { assignmentState } : {}) };
  });
}

/** Read only the event primary key and kind. A quiet house avoids rereading
 * historical Work and message bodies; a busy journal yields between pages. */
export async function residentWorkProjectionChangesSince(database: M11Database, after: number) {
  let cursor = after;
  while (true) {
    const rows = database.readAll<{ sequence: number; kind: string }>(
      'SELECT sequence,aggregate_kind AS kind FROM events NOT INDEXED WHERE sequence>? ORDER BY sequence LIMIT 128', cursor);
    for (const row of rows) {
      cursor = row.sequence;
      if (PROJECTION_EVENT_KINDS.has(row.kind)) return { changed: true, cursor };
    }
    if (rows.length < 128) return { changed: false, cursor };
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/** A derived observation for the existing private agency, never a second Work
 * writer. Only real changes rewrite the snapshot; a clock is not progress. */
export function projectResidentWork(database: M11Database, directory: string, residents: readonly string[]) {
  const assignments = createResidentAssignments(database);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const resident of residents) {
    if (!/^[a-z][a-z0-9-]*$/.test(resident)) throw new Error('Invalid work resident');
    const bot = database.readOne<{ id: string }>('SELECT principal_id AS id FROM bots WHERE resident_binding=?', resident);
    if (!bot) continue;
    const path = join(directory, `${resident}.work.json`);
    const value = JSON.stringify({ schema: 'home23.resident.work.v1', resident,
      assignments: initiativeProvenance(database, assignments.listForProjection(bot.id)) });
    writeSnapshot(directory, path, value);
  }
}

/** Build the complete observation in small indexed pages, yielding to HTTP
 * requests between reads. Publish only after every page succeeds. */
export async function projectResidentWorkIncrementally(database: M11Database, directory: string,
  residents: readonly string[]) {
  const assignments = createResidentAssignments(database);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const resident of residents) {
    await new Promise<void>(resolve => setImmediate(resolve));
    if (!/^[a-z][a-z0-9-]*$/.test(resident)) throw new Error('Invalid work resident');
    const bot = database.readOne<{ id: string }>('SELECT principal_id AS id FROM bots WHERE resident_binding=?', resident);
    if (!bot) continue;
    const snapshot: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    let cursor: { createdAt: string; id: string } | null = null;
    let remaining = 1000;
    while (remaining > 0) {
      await new Promise<void>(resolve => setImmediate(resolve));
      const page = assignments.listForProjectionPage(bot.id, cursor, remaining);
      for (const assignment of page.assignments) {
        const id = String(assignment.id);
        if (!seen.has(id)) { seen.add(id); snapshot.push(assignment); }
      }
      remaining -= page.candidateCount;
      if (page.scannedCount < 16) break;
      cursor = page.cursor;
    }
    const path = join(directory, `${resident}.work.json`);
    writeSnapshot(directory, path, JSON.stringify({ schema: 'home23.resident.work.v1', resident, assignments: initiativeProvenance(database, snapshot) }));
  }
}

function writeSnapshot(directory: string, path: string, value: string) {
  if (existsSync(path) && readFileSync(path, 'utf8') === value) return;
  const temp = `${path}.next`;
  writeFileSync(temp, value, { mode: 0o600 });
  const fd = openSync(temp, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, path);
  const parent = openSync(directory, 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}
