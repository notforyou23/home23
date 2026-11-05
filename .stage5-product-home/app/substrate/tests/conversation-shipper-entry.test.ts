/**
 * THE SHIPPER THAT EXITED THE MOMENT IT WAS SUPERVISED (2026-08-13).
 *
 * The shipper carries a guard so that `import { shippableTurn }` from the
 * probe does not start a SECOND writer on one stream. The guard asked
 * `process.argv[1]?.endsWith('conversation-shipper.ts')`.
 *
 * That question is only answerable when a human runs the file. Under PM2 fork
 * mode argv[1] is PM2's own `ProcessContainerFork.js` and the real entry point
 * lives in `pm_exec_path` — so the supervised shipper read itself as an
 * import, never called main(), never opened a timer, and exited 0 in about
 * three seconds. PM2 restarted it, forever: 3,939 restarts, both agents,
 * ~3.2 hours of conversation unshipped, and NOT ONE line of log to say so,
 * because the startup banner lives inside the main() that never ran.
 *
 * A silent clean exit is the worst failure this house can have — `pm2 list`
 * says "online", the log says nothing, and the life-feed is simply gone.
 *
 * These tests pin both halves of the guard: it must RUN when the process is
 * the shipper (however it was launched), and must STAY QUIET on import.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SHIPPER = resolve(import.meta.dirname, '../bin/conversation-shipper.ts');

interface RunResult { alive: boolean; code: number | null; stdout: string; stderr: string }

/** Launch a shipper-ish process and observe it for `observeMs`. */
function observe(
  argv1: string,
  env: Record<string, string>,
  observeMs: number,
): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'shipper-entry-'));
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', argv1],
    {
      env: {
        ...process.env,
        SHIPPER_CONVERSATIONS_DIR: dir,
        SHIPPER_STREAM_PATH: join(dir, 'stream.jsonl'),
        SHIPPER_CURSOR_PATH: join(dir, 'cursor.json'),
        SHIPPER_BACKFILL_BYTES: '0',
        SHIPPER_POLL_MS: '30000',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
  child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

  return new Promise<RunResult>((res) => {
    let exited = false;
    let code: number | null = null;
    child.on('exit', (c) => { exited = true; code = c; });
    setTimeout(() => {
      const alive = !exited;
      if (alive) child.kill('SIGKILL');
      res({ alive, code, stdout, stderr });
    }, observeMs);
  });
}

test('shipper launched directly runs and stays resident', async () => {
  const r = await observe(SHIPPER, {}, 6000);
  assert.equal(r.alive, true, `shipper exited (code ${r.code}); stderr: ${r.stderr}`);
  assert.match(r.stdout, /\[conversation-shipper\]/);
});

test('shipper launched the way PM2 launches it runs and stays resident', async () => {
  // PM2 fork mode: argv[1] is ProcessContainerFork.js, which imports the real
  // entry named in pm_exec_path. This is the shape that restart-looped.
  const dir = mkdtempSync(join(tmpdir(), 'shipper-fork-'));
  const fork = join(dir, 'ProcessContainerFork.js');
  writeFileSync(fork, `import(${JSON.stringify(SHIPPER)});\n`, 'utf-8');

  const r = await observe(fork, { pm_exec_path: SHIPPER }, 8000);
  assert.equal(
    r.alive,
    true,
    `shipper exited under PM2-shaped launch (code ${r.code}) — this is the ` +
    `silent restart-loop: online in pm2, nothing shipped, no log. stderr: ${r.stderr}`,
  );
  assert.match(r.stdout, /\[conversation-shipper\]/);
});

test('importing the module starts NO shipper', async () => {
  // Today the shared `shippableTurn` lives in src/conversation-turn.ts and
  // nothing imports this module at all. The guard stays anyway: the day
  // someone does import it, an import must not silently become a second
  // writer appending to one stream — the fork this house forbids everywhere.
  const dir = mkdtempSync(join(tmpdir(), 'shipper-import-'));
  const importer = join(dir, 'probe-like.ts');
  writeFileSync(
    importer,
    `import ${JSON.stringify(SHIPPER)};\n` +
    `console.log('IMPORTED');\n`,
    'utf-8',
  );

  const r = await observe(importer, {}, 6000);
  assert.equal(r.alive, false, 'importer stayed resident — a second shipper was started on import');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /IMPORTED/);
  assert.doesNotMatch(r.stdout, /\[conversation-shipper\] dir=/, 'main() ran on import');
});
