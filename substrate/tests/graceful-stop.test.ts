import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeedRunner } from '../src/runner.js';
import { EventLedgerTailAdapter } from '../src/adapters/event-ledger-tail.js';
import { EchoLobe, type LobeAdapter } from '../src/lobe.js';

test('stop during recruitment finishes one event, commits its cursor, and restarts strictly', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'seed-graceful-stop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const sourcePath = join(root, 'events.jsonl');
  writeFileSync(sourcePath, Array.from({ length: 16 }, (_, i) => JSON.stringify({
    event_id: `he_${i}`,
    event_type: 'MemoryChallenged',
    thread_id: `thread:${i % 3}`,
    session_id: 'session:graceful',
    object_id: `object:${i}`,
    timestamp: `2026-08-07T10:${String(i).padStart(2, '0')}:00.000Z`,
  })).join('\n') + '\n');

  let releaseRecruitment!: () => void;
  const pending = new Promise<void>((resolve) => { releaseRecruitment = resolve; });
  let enteredRecruitment!: () => void;
  const entered = new Promise<void>((resolve) => { enteredRecruitment = resolve; });
  const echo = new EchoLobe();
  let recruited = 0;
  const lobe: LobeAdapter = {
    id: echo.id, modelId: echo.modelId, provider: echo.provider,
    async invoke(packet) {
      recruited++;
      enteredRecruitment();
      await pending;
      return echo.invoke(packet);
    },
  };
  const runner = new SeedRunner({ stateDir, sourcePath, fromEnd: false,
    workspaceEveryN: 8, lobeMinIntervalMs: 0, lobe });
  const run = runner.run();
  await entered;
  runner.requestStop();
  releaseRecruitment();
  await run;

  assert.equal(recruited, 1, 'stop must not start another recruitment');
  const records = readFileSync(join(stateDir, 'seed-ledger.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.filter((record) => record.category === 'transition').length, 8,
    'stop must not begin the next source event');
  assert.equal(records.at(-1)?.category, 'stop', 'normal final checkpoint and stop receipt complete');
  const adapter = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, fromEnd: false });
  assert.equal(adapter.pullSync().length, 8, 'only the unprocessed suffix remains after cursor commit');

  const resumed = new SeedRunner({ stateDir, sourcePath, fromEnd: false });
  resumed.start(); // strict checkpoint-covers-tail restore, not permissive replay
  assert.equal(resumed.seedProcess.getState().transitionCount, 8);
  assert.equal((await resumed.tick()).transitioned, 8);
  resumed.stop();
});
