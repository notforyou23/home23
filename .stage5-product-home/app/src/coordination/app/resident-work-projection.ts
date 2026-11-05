import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { M11Database } from '../work/types.js';
import { createResidentAssignments } from './resident-assignments.js';

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
      assignments: assignments.list(bot.id, true, 1000) });
    if (existsSync(path) && readFileSync(path, 'utf8') === value) continue;
    const temp = `${path}.next`;
    writeFileSync(temp, value, { mode: 0o600 });
    const fd = openSync(temp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const parent = openSync(directory, 'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
}
