import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import Database from 'better-sqlite3';
import type { M11Database } from '../work/types.js';
import { createResidentAssignments } from './resident-assignments.js';

const PROJECTION_EVENT_KINDS = new Set([
  'work', 'message', 'resident_assignment', 'resident_outcome', 'work_thread_presentation',
]);

const WORKER_KIND = 'home23.resident-work-projection.v1';
type ProjectionWorkerInput = { kind: typeof WORKER_KIND; databasePath: string; directory: string; residents: string[] };

/** Projection queries use synchronous SQLite. Run them on a read-only connection
 * in a worker so even an unexpectedly slow indexed lookup cannot stall HTTP. */
export async function projectResidentWorkInWorker(databasePath: string, directory: string,
  residents: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: WORKER_KIND, databasePath, directory, residents: [...residents] } satisfies ProjectionWorkerInput,
      execArgv: [],
    });
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new Error('Resident Work projection exceeded 120 seconds'));
    }, 120_000);
    timeout.unref();
    worker.once('message', (message: { ok: boolean; error?: string }) => {
      settled = true;
      clearTimeout(timeout);
      if (message.ok) resolve();
      else reject(new Error(message.error ?? 'Resident Work projection failed'));
    });
    worker.once('error', error => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } });
    worker.once('exit', code => {
      if (!settled) { settled = true; clearTimeout(timeout);
        reject(new Error(`Resident Work projection worker exited with code ${code}`)); }
    });
  });
}

if (!isMainThread && (workerData as ProjectionWorkerInput | undefined)?.kind === WORKER_KIND) {
  const input = workerData as ProjectionWorkerInput;
  void (async () => {
    const connection = new Database(input.databasePath, { readonly: true, fileMustExist: true, timeout: 0 });
    try {
      const database = {
        readOne: <T>(sql: string, ...parameters: Array<string | number | bigint | Buffer | null>): T | undefined =>
          connection.prepare(sql).get(...parameters) as T | undefined,
        readAll: <T>(sql: string, ...parameters: Array<string | number | bigint | Buffer | null>): T[] =>
          connection.prepare(sql).all(...parameters) as T[],
      } as M11Database;
      await projectResidentWorkIncrementally(database, input.directory, input.residents);
      parentPort?.postMessage({ ok: true });
    } finally { connection.close(); }
  })().catch(error => parentPort?.postMessage({ ok: false, error: String(error) }));
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
      assignments: assignments.listForProjection(bot.id) });
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
    writeSnapshot(directory, path, JSON.stringify({ schema: 'home23.resident.work.v1', resident, assignments: snapshot }));
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
