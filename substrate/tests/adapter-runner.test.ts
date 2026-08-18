import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLedgerTailAdapter, mapHarnessCategory } from '../src/adapters/event-ledger-tail.js';
import { SeedRunner } from '../src/runner.js';
import { EchoLobe } from '../src/lobe.js';
import { TEST_ANATOMY } from './named-anatomy.js';

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
    anatomy: TEST_ANATOMY,
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

// ─── Post-review fixes ───────────────────────────────────────────────────────

test('REVIEW FIX: oversized line larger than the read window is delivered, not a silent stall', (t) => {
  const srcDir = makeDir(t, 'big-src');
  const stateDir = makeDir(t, 'big-state');
  const sourcePath = join(srcDir, 'event-ledger.jsonl');
  const bigPayload = 'x'.repeat(2048);
  const bigLine = JSON.stringify({ event_id: 'he_big', event_type: 'OutcomeObserved', object_id: bigPayload, timestamp: '2026-08-07T12:00:00.000Z' });
  writeFileSync(sourcePath, `${bigLine}\n${harnessLine(1)}\n`, 'utf-8');

  const adapter = new EventLedgerTailAdapter({
    sourcePath, cursorDir: stateDir, fromEnd: false,
    readWindowBytes: 256, oversizedLineMax: 8192,
  });
  const first = adapter.pullSync();
  assert.equal(first.length, 1, 'the oversized-but-bounded line must be delivered via exact read');
  assert.equal(first[0]?.eventId, 'he_big');
  adapter.commit(first[0]?.endOffset ?? 0);
  const second = adapter.pullSync();
  assert.equal(second[0]?.eventId, 'he_1', 'the normal line after it flows normally');
});

test('REVIEW FIX: line beyond the hard cap is SKIPPED durably with a count — never an infinite stall', (t) => {
  const srcDir = makeDir(t, 'cap-src');
  const stateDir = makeDir(t, 'cap-state');
  const sourcePath = join(srcDir, 'event-ledger.jsonl');
  const monster = JSON.stringify({ event_id: 'he_monster', event_type: 'OutcomeObserved', object_id: 'y'.repeat(4096), timestamp: '2026-08-07T12:00:00.000Z' });
  writeFileSync(sourcePath, `${monster}\n${harnessLine(2)}\n`, 'utf-8');

  const logs: string[] = [];
  const adapter = new EventLedgerTailAdapter({
    sourcePath, cursorDir: stateDir, fromEnd: false,
    readWindowBytes: 256, oversizedLineMax: 1024, log: (l) => logs.push(l),
  });
  const first = adapter.pullSync();
  assert.equal(first.length, 0, 'monster line yields nothing');
  assert.equal(adapter.oversizedSkipCount, 1, 'but the skip is counted');
  assert.ok(logs.some((l) => l.includes('SKIPPED')), 'and logged');
  const second = adapter.pullSync();
  assert.equal(second.length, 1, 'the adapter moved past it — liveness preserved');
  assert.equal(second[0]?.eventId, 'he_2');
});

test('REVIEW FIX: a window of pure garbage lines advances the cursor instead of stalling', (t) => {
  const srcDir = makeDir(t, 'junk-src');
  const stateDir = makeDir(t, 'junk-state');
  const sourcePath = join(srcDir, 'event-ledger.jsonl');
  writeFileSync(sourcePath, 'not json\nalso not json\n{"no_timestamp":true}\n' + `${harnessLine(3)}\n`, 'utf-8');

  const adapter = new EventLedgerTailAdapter({
    sourcePath, cursorDir: stateDir, fromEnd: false, readWindowBytes: 40,
  });
  let delivered: string | undefined;
  for (let i = 0; i < 6 && delivered === undefined; i++) {
    const batch = adapter.pullSync();
    if (batch.length > 0) delivered = batch[0]?.eventId;
  }
  assert.equal(delivered, 'he_3', 'garbage is consumed and the real event arrives');
});

test('REVIEW FIX: getState() dispositions are copy-on-read — no unreceipted mutation path into D', (t) => {
  const srcDir = makeDir(t, 'disp-src');
  const stateDir = makeDir(t, 'disp-state');
  writeFixture(srcDir, [harnessLine(0)]);
  const runner = new SeedRunner({ stateDir, sourcePath: join(srcDir, 'event-ledger.jsonl'), fromEnd: false, anatomy: TEST_ANATOMY });
  runner.start();
  const seed = runner.seedProcess;

  const leaked = seed.getState();
  leaked.dispositions.globalWakeThreshold = 0;
  leaked.dispositions.quietTimeEnabled = true;

  const fresh = seed.getState();
  assert.equal(fresh.dispositions.globalWakeThreshold, 0.3, 'threshold unchanged — the returned object was a copy');
  assert.equal(fresh.dispositions.quietTimeEnabled, false);
  runner.stop();
});

// ─── Multi-source reality spine (teaching streams) ───────────────────────────

function relLine(i: number, type: string, ts: string): string {
  return JSON.stringify({
    event_id: `rel_evt_${i}`,
    event_type: 'entry_added',
    entry_id: `rel_entry_${i}`,
    agent: 'jerry',
    ts,
    payload: { type, actor: 'agent', method: 'agent_note' },
  });
}

function workerLine(i: number, status: string, finishedAt: string): string {
  return JSON.stringify({
    schema: 'home23.worker-run-memory.v1',
    runId: `wr_test_${i}`,
    worker: 'parity',
    status,
    verifierStatus: 'unknown',
    startedAt: finishedAt,
    finishedAt,
    summary: 'fixture',
  });
}

test('relationship mapper: corrections are corrections, threads are observations', (t) => {
  const srcDir = makeDir(t, 'rel-src');
  const stateDir = makeDir(t, 'rel-state');
  const sourcePath = join(srcDir, 'relationship-ledger.events.jsonl');
  writeFileSync(sourcePath, `${relLine(0, 'correction', '2026-08-07T10:00:00.000Z')}\n${relLine(1, 'thread', '2026-08-07T10:01:00.000Z')}\n`, 'utf-8');

  const adapter = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, sourceType: 'relationship-ledger', fromEnd: false });
  const events = adapter.pullSync();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.category, 'correction');
  assert.match(events[0]?.sourceRef ?? '', /^relationship\.correction:/);
  assert.equal(events[1]?.category, 'observation');
});

test('worker-runs mapper: failures/blocked teach, successes corroborate', (t) => {
  const srcDir = makeDir(t, 'wr-src');
  const stateDir = makeDir(t, 'wr-state');
  const sourcePath = join(srcDir, 'worker-runs.jsonl');
  writeFileSync(sourcePath, `${workerLine(0, 'blocked', '2026-08-07T10:00:00.000Z')}\n${workerLine(1, 'success', '2026-08-07T10:01:00.000Z')}\n`, 'utf-8');

  const adapter = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, sourceType: 'worker-runs', fromEnd: false });
  const events = adapter.pullSync();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.category, 'correction', 'a blocked run is reality pushing back');
  assert.equal(events[1]?.category, 'consequence');
  assert.match(events[0]?.sourceRef ?? '', /^worker\.parity:/);
});

test('worker-runs mapper speaks the LIVE stream vocabulary: fixed/no_change corroborate, failed/blocked teach', (t) => {
  // The 2026-08-08 diet bug: the success list missed the live statuses
  // entirely — 41 'fixed' runs in one window all taught as corrections and
  // both live seeds' consequence-role cells starved structurally.
  const srcDir = makeDir(t, 'wrv-src');
  const stateDir = makeDir(t, 'wrv-state');
  const sourcePath = join(srcDir, 'worker-runs.jsonl');
  writeFileSync(sourcePath, [
    workerLine(0, 'fixed', '2026-08-08T10:00:00.000Z'),
    workerLine(1, 'no_change', '2026-08-08T10:01:00.000Z'),
    workerLine(2, 'failed', '2026-08-08T10:02:00.000Z'),
    workerLine(3, 'blocked', '2026-08-08T10:03:00.000Z'),
  ].join('\n') + '\n', 'utf-8');

  const adapter = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, sourceType: 'worker-runs', fromEnd: false });
  const events = adapter.pullSync();
  assert.equal(events.length, 4);
  assert.equal(events[0]?.category, 'consequence', 'fixed = the house acted and it held');
  assert.equal(events[1]?.category, 'consequence', 'no_change = the house checked and all was well');
  assert.equal(events[2]?.category, 'correction', 'failed = reality pushing back');
  assert.equal(events[3]?.category, 'correction', 'blocked = reality pushing back');
});

test('MULTI-SOURCE: streams merge in event-time order, cursors stay independent, and a relationship correction TEACHES', async (t) => {
  const srcDir = makeDir(t, 'multi-src');
  const stateDir = makeDir(t, 'multi-state');
  const harnessPath = writeFixture(srcDir, [harnessLine(0, 'RetrievalExecuted', '2026-08-07T10:00:30.000Z')]);
  const relPath = join(srcDir, 'rel.jsonl');
  writeFileSync(relPath, `${relLine(0, 'correction', '2026-08-07T10:00:00.000Z')}\n${relLine(1, 'correction', '2026-08-07T10:01:00.000Z')}\n`, 'utf-8');
  const wrPath = join(srcDir, 'wr.jsonl');
  writeFileSync(wrPath, `${workerLine(0, 'blocked', '2026-08-07T10:00:45.000Z')}\n`, 'utf-8');

  const order: string[] = [];
  const runner = new SeedRunner({
    stateDir,
    sourcePath: harnessPath,
    fromEnd: false,
    anatomy: TEST_ANATOMY,
    extraSources: [
      { sourcePath: relPath, sourceType: 'relationship-ledger', id: 'relationship' },
      { sourcePath: wrPath, sourceType: 'worker-runs', id: 'worker-runs' },
    ],
    log: (l) => { const m = l.match(/ref=(\S+)/); if (m?.[1] !== undefined) order.push(m[1]); },
  });
  runner.start();
  const report = await runner.tick();

  assert.equal(report.pulled, 4);
  assert.equal(report.transitioned, 4);
  assert.deepEqual(order.map((r) => r.split(':')[0]), [
    'relationship.correction',   // 10:00:00
    'RetrievalExecuted',         // 10:00:30
    'worker.parity',             // 10:00:45
    'relationship.correction',   // 10:01:00
  ], 'events from all sources must interleave in event-time order');

  assert.ok(
    runner.seedProcess.getState().developmentMagnitude > 0,
    'relationship corrections and worker failures must produce receipted development',
  );
  runner.stop();

  // Restart: every cursor independent and durable — nothing re-delivered.
  const runner2 = new SeedRunner({
    stateDir,
    sourcePath: harnessPath,
    fromEnd: false,
    extraSources: [
      { sourcePath: relPath, sourceType: 'relationship-ledger', id: 'relationship' },
      { sourcePath: wrPath, sourceType: 'worker-runs', id: 'worker-runs' },
    ],
  });
  runner2.start();
  const report2 = await runner2.tick();
  assert.equal(report2.pulled, 0, 'all three cursors must have committed independently');
  runner2.stop();
});

test('MECHANICAL FORK GUARD: a second runner on the same stateDir refuses; stale locks are taken over', (t) => {
  // clay's stillbirth (2026-08-08): two runners interleaved appends and
  // forked the chain. The fail-closed restore caught the damage; this lock
  // prevents it from ever being writable in the first place.
  const srcDir = makeDir(t, 'lock-src');
  const stateDir = makeDir(t, 'lock-state');
  const sourcePath = writeFixture(srcDir, [harnessLine(0, 'RetrievalExecuted', '2026-08-08T16:00:00.000Z')]);

  const first = new SeedRunner({ stateDir, sourcePath, fromEnd: false, anatomy: TEST_ANATOMY });
  first.start();

  const second = new SeedRunner({ stateDir, sourcePath, fromEnd: false });
  assert.throws(() => second.start(), /HELD by live runner|never two live instances/,
    'a second writer must refuse loudly');

  first.stop();
  // Lock released on stop — a successor may now start.
  const third = new SeedRunner({ stateDir, sourcePath, fromEnd: false });
  third.start();
  third.stop();

  // Stale lock (dead pid) is taken over, not fatal.
  writeFileSync(join(stateDir, '.runner.lock'), '999999', 'utf-8');
  const fourth = new SeedRunner({ stateDir, sourcePath, fromEnd: false });
  fourth.start();
  fourth.stop();
});

test('empty state dir without named anatomy refuses birth and leaves no lock', (t) => {
  const srcDir = makeDir(t, 'birth-src');
  const stateDir = makeDir(t, 'birth-state');
  const sourcePath = writeFixture(srcDir, [harnessLine(0)]);
  const runner = new SeedRunner({ stateDir, sourcePath, fromEnd: false });
  assert.throws(() => runner.start(), /SEED_ANATOMY|refusing to invent a person/);
  assert.equal(existsSync(join(stateDir, '.runner.lock')), false, 'a refused birth must not hold the one-life lock');
});

test('conversation mapper: both voices observed, words + meaning ride the event', (t) => {
  const srcDir = makeDir(t, 'conv-src');
  const stateDir = makeDir(t, 'conv-state');
  const sourcePath = join(srcDir, 'conversation-stream.jsonl');
  const vec = Array.from({ length: 16 }, () => 0.1);
  writeFileSync(sourcePath, [
    JSON.stringify({ ts: '2026-08-09T14:00:00.000Z', role: 'user', text: 'should I do the sauna tonight?', session: 's1', semantic_vector: vec }),
    JSON.stringify({ ts: '2026-08-09T14:00:30.000Z', role: 'assistant', text: 'Skip the heroics — HRV is depleted', session: 's1' }),
  ].join('\n') + '\n', 'utf-8');

  const adapter = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, sourceType: 'conversation-stream', fromEnd: false });
  const events = adapter.pullSync();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.category, 'observation');
  assert.match(events[0]?.sourceRef ?? '', /^conversation\.jtr:/);
  assert.equal(events[0]?.payload['head'], 'should I do the sauna tonight?');
  assert.equal(events[0]?.semanticVector?.length, 16, 'perceived meaning rides the event');
  assert.match(events[1]?.sourceRef ?? '', /^conversation\.self:/, 'agent-generic self voice');
});

test('house mapper: home transitions arrive as observed contact with words', (t) => {
  const srcDir = makeDir(t, 'house-src');
  const stateDir = makeDir(t, 'house-state');
  const sourcePath = join(srcDir, 'house-stream.jsonl');
  writeFileSync(sourcePath, [
    JSON.stringify({ ts: '2026-08-09T15:00:00.000Z', entity: 'cover.garage_1', from: 'closed', to: 'open', text: 'Garage 1 opened' }),
    JSON.stringify({ ts: '2026-08-09T15:01:00.000Z', entity: 'media_player.althea_kitchen', from: 'idle', to: 'playing', text: 'Althea - Kitchen playing "Ripple" — Grateful Dead' }),
  ].join('\n') + '\n', 'utf-8');

  const adapter = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, sourceType: 'house-stream', fromEnd: false });
  const events = adapter.pullSync();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.category, 'observation');
  assert.equal(events[0]?.sourceRef, 'house.cover:cover.garage_1');
  assert.equal(events[0]?.payload['head'], 'Garage 1 opened');
  assert.equal(events[1]?.payload['head'], 'Althea - Kitchen playing "Ripple" — Grateful Dead');
});

test('dream mapper: the individual\'s own dreams enter the diet at birth — head + T1 content hash', (t) => {
  const srcDir = makeDir(t, 'dream-src');
  const stateDir = makeDir(t, 'dream-state');
  const sourcePath = join(srcDir, 'dream-events.jsonl');
  const sha = 'a'.repeat(64);
  writeFileSync(sourcePath, [
    JSON.stringify({ ts: '2026-08-11T11:38:28.279Z', dreamId: 'dream_cycle15572_1', cycle: 15572, model: 'MiniMax-M3', head: 'The kitchen hummed with a song that wasn\'t a song', contentSha256: sha, contentLength: 3408 }),
    JSON.stringify({ ts: '2026-08-11T11:38:41.786Z', dreamId: 'dream_bad_sha', head: 'x', contentSha256: 'not-a-hash' }),
    JSON.stringify({ ts: '2026-08-11T11:38:42.000Z', dreamId: 'dream_no_head', contentSha256: sha }),
  ].join('\n') + '\n', 'utf-8');

  const adapter = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, sourceType: 'dream-stream', fromEnd: false });
  const events = adapter.pullSync();
  assert.equal(events.length, 1, 'malformed receipts (bad sha, no head) are refused — a T1 claim must be well-formed');
  assert.equal(events[0]?.category, 'interpretation', 'a dream is the mind\'s own reading of the day');
  assert.equal(events[0]?.sourceRef, 'dream:dream_cycle15572_1');
  assert.equal(events[0]?.payload['contentSha256'], sha, 'the content hash rides to the chain — the prose is T1 from birth');
  assert.equal(events[0]?.payload['head'], 'The kitchen hummed with a song that wasn\'t a song');
  assert.equal(events[0]?.producedAt, '2026-08-11T11:38:28.279Z');
});

test("the machine's heartbeat is not diet: event_ledger.heartbeat lines are filtered", (t) => {
  const srcDir = makeDir(t, 'hb-src');
  const stateDir = makeDir(t, 'hb-state');
  const sourcePath = join(srcDir, 'event-ledger.jsonl');
  writeFileSync(sourcePath, [
    JSON.stringify({ event_id: 'hb1', event_type: 'event_ledger.heartbeat', timestamp: '2026-08-10T10:00:00.000Z', payload: {} }),
    JSON.stringify({ event_id: 'real1', event_type: 'SessionStarted', session_id: 's', timestamp: '2026-08-10T10:01:00.000Z', payload: {} }),
  ].join('\n') + '\n', 'utf-8');
  const adapter = new EventLedgerTailAdapter({ sourcePath, cursorDir: stateDir, fromEnd: false });
  const events = adapter.pullSync();
  assert.equal(events.length, 1, 'the pulse stays in the ledger, out of the diet');
  assert.equal(events[0]?.eventId, 'real1');
});
