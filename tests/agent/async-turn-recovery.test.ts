import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, appendFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationHistory } from '../../src/agent/history.js';
import { TurnStore } from '../../src/chat/turn-store.js';

const pending = (turn_id: string, chat_id = 'chat') => ({ type: 'turn', turn_id, chat_id, status: 'pending', role: 'assistant', started_at: '2020-01-01T00:00:00.000Z' });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'async-recovery-'));
  const history = new ConversationHistory(dir, 400_000, 'test');
  return { dir, history, store: new TurnStore(history), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('large journal recovery serves timers during scan and preserves canonical identity and last sequence', async () => {
  const f = fixture();
  try {
    const chat = 'coordination:legacy';
    f.history.appendRecord(chat, pending('old', chat));
    const filler = JSON.stringify({ role: 'user', content: 'x'.repeat(8000) }) + '\n';
    appendFileSync(join(f.dir, 'test__coordination_legacy.jsonl'), filler.repeat(2000));
    f.history.appendRecord(chat, { type: 'event', turn_id: 'old', seq: 7, kind: 'status', data: {}, ts: new Date().toISOString() });
    let beats = 0;
    const timer = setInterval(() => beats++, 1);
    const result = await f.store.sweepOrphansAsync(chat, 1, () => false);
    clearInterval(timer);
    assert.ok(beats > 1, `timer ran ${beats} times during 16MB scan`);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.chat_id, chat);
    assert.equal(result[0]!.last_seq, 7);
    assert.equal(f.store.pendingTurns(chat).length, 0);
  } finally { f.close(); }
});

test('completion appended during async scan invalidates stale snapshot', async () => {
  const f = fixture();
  try {
    f.history.appendRecord('chat', pending('old'));
    appendFileSync(join(f.dir, 'test__chat.jsonl'), (JSON.stringify({ content: 'x'.repeat(8000) }) + '\n').repeat(1000));
    const scan = f.store.sweepOrphansAsync('chat', 1, () => false);
    setTimeout(() => f.store.writeEnd('chat', 'old', 'complete', { last_seq: 3 }), 0);
    assert.deepEqual(await scan, []);
    assert.equal(f.store.finalEnvelope('chat', 'old')?.status, 'complete');
  } finally { f.close(); }
});

test('preservation guard is evaluated after scan and protects newly active and coordinated turns', async () => {
  const f = fixture();
  try {
    f.history.appendRecord('chat', pending('active'));
    f.history.appendRecord('chat', { ...pending('coordinated'), coordination_origin: { kind: 'coordination', workId: 'wrk_test' } });
    let active = false;
    const scan = f.store.sweepOrphansAsync('chat', 1, t => active || t.coordination_origin?.kind === 'coordination');
    active = true;
    assert.deepEqual(await scan, []);
    assert.equal(f.store.pendingTurns('chat').length, 2);
  } finally { f.close(); }
});

test('oversized and unterminated records conservatively defer recovery without truncating history', async () => {
  for (const suffix of ['{"unfinished":', JSON.stringify({ content: 'x'.repeat(1100000) }) + '\n']) {
    const f = fixture();
    try {
      f.history.appendRecord('chat', pending('old'));
      appendFileSync(join(f.dir, 'test__chat.jsonl'), suffix);
      assert.deepEqual(await f.store.sweepOrphansAsync('chat', 1, () => false), []);
      assert.equal(f.store.pendingTurns('chat').length, 1);
    } finally { f.close(); }
  }
});

test('AgentLoop coalesces overlapping sweeps and can sweep again after completion', async () => {
  const { AgentLoop } = await import('../../src/agent/loop.js');
  let scans = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const receiver = {
    recoverySweep: null,
    history: { async listChatIdsForRecovery() { scans++; await gate; return []; } },
  } as unknown as InstanceType<typeof AgentLoop>;
  const first = AgentLoop.prototype.recoverStaleTurnsAsync.call(receiver);
  const overlapping = AgentLoop.prototype.recoverStaleTurnsAsync.call(receiver);
  assert.equal(first, overlapping);
  release();
  assert.deepEqual(await first, []);
  await AgentLoop.prototype.recoverStaleTurnsAsync.call(receiver);
  assert.equal(scans, 2);
});


test('replaced journal cannot authorize an orphan and terminal append batches remain bounded', async () => {
  const f = fixture();
  try {
    f.history.appendRecord('chat', pending('old'));
    const commit = await f.history.scanForRecovery('chat', () => {});
    renameSync(join(f.dir, 'test__chat.jsonl'), join(f.dir, 'saved.jsonl'));
    f.history.appendRecord('chat', pending('new'));
    let called = false;
    assert.equal(commit?.(() => { called = true; }), false);
    assert.equal(called, false);
    for (let i = 0; i < 40; i++) f.history.appendRecord('chat', pending(`batch-${i}`));
    assert.equal((await f.store.sweepOrphansAsync('chat', 1, () => false)).length, 32);
    assert.equal(f.store.pendingTurns('chat').length, 9);
    assert.equal((await f.store.sweepOrphansAsync('chat', 1, () => false)).length, 9);
  } finally { f.close(); }
});

test('malformed complete records fail closed and diagnostics contain only bounded reason codes', async () => {
  const cases = [
    { suffix: '{"private":broken}\n', reason: 'malformed_record' },
    { suffix: '{"private":', reason: 'incomplete_record' },
    { suffix: JSON.stringify({ private: 'x'.repeat(1100000) }) + '\n', reason: 'record_too_large' },
  ];
  for (const { suffix, reason } of cases) {
    const f = fixture();
    try {
      f.history.appendRecord('chat', pending('old'));
      appendFileSync(join(f.dir, 'test__chat.jsonl'), suffix);
      const reasons: string[] = [];
      assert.deepEqual(await f.store.sweepOrphansAsync('chat', 1, () => false, value => reasons.push(value)), []);
      assert.deepEqual(reasons, [reason]);
      assert.equal(f.store.pendingTurns('chat').length, 1);
    } finally { f.close(); }
  }
});

test('invalid metadata and mismatched chat identity cannot authorize a write to another journal', async () => {
  for (const record of [{ ...pending('old'), chat_id: 'elsewhere' }, { ...pending('old'), turn_id: 'x'.repeat(300) }, { ...pending('old'), started_at: {} }]) {
    const f = fixture();
    try {
      f.history.appendRecord('chat', record);
      const reasons: string[] = [];
      assert.deepEqual(await f.store.sweepOrphansAsync('chat', 1, () => false, r => reasons.push(r)), []);
      assert.deepEqual(reasons, ['invalid_turn_metadata']);
      assert.equal(f.history.loadRaw('elsewhere').length, 0);
    } finally { f.close(); }
  }
});

test('shutdown and terminal overrides protect a turn after asynchronous scan starts', async () => {
  const { AgentLoop } = await import('../../src/agent/loop.js');
  for (const stopped of [true, false]) {
    const f = fixture();
    try {
      f.history.appendRecord('chat', pending('old'));
      const receiver = Object.create(AgentLoop.prototype) as InstanceType<typeof AgentLoop>;
      Object.assign(receiver, { history: f.history, turnStore: f.store, recoverySweep: null, recoveryStopped: false, activeTurnIds: new Map(), terminalTurnOverrides: new Map() });
      const scan = receiver.recoverStaleTurnsAsync(1);
      if (stopped) receiver.stopRecoverySweep();
      else (receiver as any).terminalTurnOverrides.set((receiver as any).turnKey('chat', 'old'), { status: 'stopped' });
      assert.deepEqual(await scan, []);
      assert.equal(f.store.pendingTurns('chat').length, 1);
    } finally { f.close(); }
  }
});

test('recovery inventory excludes rotated archives that cannot round-trip to their stored filename', async () => {
  const f = fixture();
  try {
    f.history.appendRecord('coordination:live', pending('old', 'coordination:live'));
    appendFileSync(join(f.dir, 'test__coordination_live.2026-09-05.jsonl'), '{}\n');
    appendFileSync(join(f.dir, 'other__chat.jsonl'), '{}\n');
    assert.deepEqual(await f.history.listChatIdsForRecovery(), ['coordination_live']);
  } finally { f.close(); }
});
