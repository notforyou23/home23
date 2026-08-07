import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedgerTailAdapter, mapHarnessCategory } from '../src/adapters/event-ledger-tail.js';
import { SeedRunner } from '../src/runner.js';
import { EchoLobe } from '../src/lobe.js';

function makeDir(t: { after(fn: () => void): void }, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `substrate-${label}-`));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harnessLine(i: number, eventType = 'RetrievalExecuted', ts = `2026-08-07T10:${String(i).padStart(2, '0')}:00.000Z`): string {
  return JSON.stringify({
    event_id: `he_${i}`,
    event_type: eventType,
    thread_id: `thread:${i % 3}`,
    session_id: 'sess:fixture',
    object_id: `obj:${i}`,
    timestamp: ts,
  });
}

function writeFixture(dir: string, lines: string[]): string {
  const path = join(dir, 'event-ledger.jsonl');
  writeFileSync(path, lines.map((l) => `${l}\n`).join(''), 'utf-8');
  return path;
}

test('category mapping: corrections, consequences, interpretations, observations', () => {
  assert.equal(mapHarnessCategory('MemoryChallenged'), 'correction');
  assert.equal(mapHarnessCategory('TriggerRejected'), 'correction');
  assert.equal(mapHarnessCategory('BreakdownDiagnosed'), 'correction');
  assert.equal(mapHarnessCategory('OutcomeObserved'), 'consequence');
  assert.equal(mapHarnessCategory('MemoryActedOn'), 'consequence');
  assert.equal(mapHarnessCategory('StateDeltaRecorded'), 'interpretation');
  assert.equal(mapHarnessCategory('UncertaintyRecorded'), 'interpretation');
  assert.equal(mapHarnessCategory('event_ledger.heartbeat'), 'observation');
  assert.equal(mapHarnessCategory('SessionStarted'), 'observation');
});

test('adapter pulls, maps, and NEVER writes the source', (t) => {
  const srcDir = makeDir(t, 'adp-src');
  const stateDir = makeDir(t, 'adp-state');
  const sourcePath = writeFixture(srcDir, [harnessLine(0), harnessLine(1, 'MemoryChallenged'), harnessLine(2, 'OutcomeObserved')]);
  const before = readFileSync(sourcePath, 'utf-8');

  const adapter = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, fromEnd: false });
  const events = adapter.pullSync();

  assert.equal(events.length, 3);
  assert.equal(events[0]?.eventId, 'he_0');
  assert.equal(events[1]?.category, 'correction');
  assert.equal(events[2]?.category, 'consequence');
  assert.equal(events[0]?.sourceAuthority, 'home23.event-ledger');
  assert.ok((events[0]?.endOffset ?? 0) > 0);

  assert.equal(readFileSync(sourcePath, 'utf-8'), before, 'source must be byte-identical after pulls');
});

test('cursor advances only on commit, persists across adapter instances', (t) => {
  const srcDir = makeDir(t, 'cur-src');
  const stateDir = makeDir(t, 'cur-state');
  const sourcePath = writeFixture(srcDir, [harnessLine(0), harnessLine(1)]);

  const a1 = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, fromEnd: false });
  const batch1 = a1.pullSync();
  assert.equal(batch1.length, 2);
  // No commit: a new instance re-delivers from the start (at-least-once).
  const a2 = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, fromEnd: false });
  assert.equal(a2.pullSync().length, 2, 'uncommitted events must be re-delivered');

  a2.commit(batch1[0]?.endOffset ?? 0);
  const a3 = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, fromEnd: false });
  const batch3 = a3.pullSync();
  assert.equal(batch3.length, 1, 'committed events must not be re-delivered');
  assert.equal(batch3[0]?.eventId, 'he_1');
});

test('torn tail is never consumed; completing the line delivers it', (t) => {
  const srcDir = makeDir(t, 'torn-src');
  const stateDir = makeDir(t, 'torn-state');
  const sourcePath = join(srcDir, 'event-ledger.jsonl');
  writeFileSync(sourcePath, `${harnessLine(0)}\n{"event_id":"he_torn","event_ty`, 'utf-8');

  const adapter = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, fromEnd: false });
  const first = adapter.pullSync();
  assert.equal(first.length, 1, 'only the complete line is delivered');
  adapter.commit(first[0]?.endOffset ?? 0);

  // Writer finishes the torn line.
  appendFileSync(sourcePath, `pe":"SessionStarted","timestamp":"2026-08-07T11:00:00.000Z"}\n`, 'utf-8');
  const second = adapter.pullSync();
  assert.equal(second.length, 1, 'the completed line is delivered');
  assert.equal(second[0]?.eventId, 'he_torn');
});

test('fromEnd skips history; only NEW events arrive', (t) => {
  const srcDir = makeDir(t, 'end-src');
  const stateDir = makeDir(t, 'end-state');
  const sourcePath = writeFixture(srcDir, [harnessLine(0), harnessLine(1)]);

  const adapter = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir });
  assert.equal(adapter.pullSync().length, 0, 'history is skipped');
  appendFileSync(sourcePath, `${harnessLine(7, 'MemoryChallenged', '2026-08-07T12:00:00.000Z')}\n`, 'utf-8');
  const fresh = adapter.pullSync();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]?.eventId, 'he_7');
});

test('RUNNER: live-shaped flow — transitions, workspace, lobe, checkpoint, stop, exact resume', async (t) => {
  const srcDir = makeDir(t, 'run-src');
  const stateDir = makeDir(t, 'run-state');
  // 10 corrections: enough pressure for a workspace admission at cadence 8.
  const sourcePath = writeFixture(
    srcDir,
    Array.from({ length: 10 }, (_, i) => harnessLine(i, 'MemoryChallenged')),
  );

  const lines: string[] = [];
  const runner = new SeedRunner({
    stateDir,
    sourcePath,
    fromEnd: false,
    workspaceEveryN: 8,
    checkpointEveryN: 6,
    lobe: new EchoLobe(),
    log: (l) => lines.push(l),
  });
  runner.start();
  const report = await runner.tick();

  assert.equal(report.pulled, 10);
  assert.equal(report.transitioned, 10);
  assert.ok(report.checkpoints >= 1, 'cadence checkpoint happened');
  assert.equal(report.workspaceOutcomes.length, 1, 'workspace cycle at cadence 8');
  assert.equal(report.workspaceOutcomes[0], 'workspace', 'sustained corrections must admit');
  assert.equal(report.lobeRecruitments, 1, 'admission recruited the lobe');

  const stateBefore = runner.seedProcess.getState();
  assert.ok(stateBefore.transitionCount >= 10);
  runner.stop();

  // New events arrive while the runner is down.
  appendFileSync(sourcePath, `${harnessLine(20, 'OutcomeObserved', '2026-08-07T13:00:00.000Z')}\n`, 'utf-8');

  // Restart: restore + cursor continuation, no re-ingestion.
  const runner2 = new SeedRunner({ stateDir, sourcePath, fromEnd: false, log: (l) => lines.push(l) });
  runner2.start();
  const resumed = runner2.seedProcess.getState();
  assert.equal(resumed.transitionCount, stateBefore.transitionCount, 'restore resumes the exact counters');

  const report2 = await runner2.tick();
  assert.equal(report2.pulled, 1, 'only the event that arrived while down is delivered');
  assert.equal(report2.transitioned, 1);
  const after = runner2.seedProcess.getState();
  assert.equal(after.transitionCount, stateBefore.transitionCount + 1, 'the trajectory continues causally, not from scratch');
  runner2.stop();

  assert.ok(lines.some((l) => l.startsWith('restored seed')), 'second start must be a restore, not an initialize');
});
