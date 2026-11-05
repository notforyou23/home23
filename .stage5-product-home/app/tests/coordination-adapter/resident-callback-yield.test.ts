import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ResidentCoordinationAdapter } from '../../src/coordination-adapter/resident-adapter.js';
import type { ResidentAgentPort, ResidentCoordinationPort, ResidentWorkRequest } from '../../src/coordination-adapter/types.js';
import { openCoordinationDatabase } from '../../src/coordination/db/index.js';
import { SqliteCommunicationEventRepository } from '../../src/coordination/communications/index.js';

const UUID = '0198d95f-6c00-7000-8000-000000000777';
const id = (prefix: string) => `${prefix}_${UUID}`;
const AT = '2026-09-04T00:00:00.000Z';

async function fixture(t: test.TestContext, revoke?: 'stale' | 'cancelled', completed = false) {
  const directory = mkdtempSync(join(tmpdir(), 'resident-callback-yield-'));
  const database = openCoordinationDatabase({ path: join(directory, 'coordination.sqlite3') });
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  const repository = new SqliteCommunicationEventRepository(database);
  let emit!: Parameters<ResidentAgentPort['runWithTurn']>[2]['onEvent'];
  let resolveResponse!: (value: { text: string; model: string; toolCallCount: number; durationMs: number }) => void;
  const response = new Promise<{ text: string; model: string; toolCallCount: number; durationMs: number }>(resolve => { resolveResponse = resolve; });
  let revoked = false;
  let fenceChecks = 0;
  let reasoningCount = 0;
  let terminalCount = 0;
  const coordination: ResidentCoordinationPort = {
    assertCurrent(binding) { assert.equal(binding.fencingToken, 1); fenceChecks++; if (revoked) throw new Error('stale_fence'); },
    cancellationState() { return revoked && revoke === 'cancelled' ? { timestamp: AT } : null; },
    assertCompleted(binding) { assert(completed); assert.equal(binding.fencingToken, 1); fenceChecks++; if (revoked) throw new Error('stale_fence'); },
    accept() {}, start() {}, reattach() {}, revoke() {},
    terminalize({ receipt }) { terminalCount++; return { receipt }; },
  };
  const agent: ResidentAgentPort = {
    async runWithTurn(chatId, _text, options) {
      await options.onDurableStart({ turnId: 'fixture-turn', chatId, persistedAt: AT });
      emit = options.onEvent;
      return { turnId: 'fixture-turn', response };
    },
    stop() { return { stopped: true }; },
  };
  const adapter = new ResidentCoordinationAdapter(agent, coordination, () => new Date(AT), {
    append(input) {
      const result = repository.append(input);
      if (completed && input.event.terminal) terminalCount++;
      if (input.event.kind === 'reasoning' && ++reasoningCount === 1 && revoke) {
        setImmediate(() => { revoked = true; });
      }
      return result;
    },
  });
  const request: ResidentWorkRequest = {
    chatId: 'fixture-chat', instruction: 'Fixture only', requestId: id('req'), correlationId: id('cor'),
    origin: { kind: 'coordination', workId: id('wrk'), attemptId: id('att'), leaseId: id('lse'),
      holderPrincipalId: id('bot'), holderInstanceId: 'fixture-resident', authorityReference: 'resident:fixture',
      fencingToken: 1, channelId: id('chn'), originMessageId: id('msg'), roundId: null },
    turnSelection: { modelAlias: null, reasoningEffort: null },
    communication: { conversationId: id('cnv'), responseMessageId: id('msg'), actor: { principalId: id('bot'), displayName: 'Fixture', kind: 'resident_bot' } },
  };
  const run = completed ? await adapter.recoverCompleted(request) : await adapter.execute(request);
  return {
    run,
    queue(count: number) {
      for (let i = 1; i <= count; i++) emit({ turnId: 'fixture-turn', sequence: i,
        occurredAt: new Date(Date.parse(AT) + i).toISOString(), provider: 'fixture', model: 'fixture', reasoningEffort: null,
        event: { type: 'thinking', content: `fixture_${i}`, provenance: 'provider_verbatim_reasoning', sourceEventType: 'response.reasoning_text.delta' } });
      resolveResponse({ text: 'fixture final', model: 'fixture', toolCallCount: 0, durationMs: 1 });
    },
    counts: () => ({ fenceChecks, reasoningCount, terminalCount }),
    events: () => database.readAll<{ payload: string }>("SELECT payload_json AS payload FROM events WHERE type = 'communication.recorded' ORDER BY sequence")
      .map(row => JSON.parse(row.payload).communication),
  };
}

for (const completed of [false, true]) {
test(`${completed ? 'completed recovery' : 'running replay'}: 855 durable FULL-SQLite writes allow HTTP progress before terminal and preserve event order`, async t => {
  const f = await fixture(t, undefined, completed);
  let received!: () => void;
  const arrived = new Promise<void>(resolve => { received = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let observed: ReturnType<typeof f.counts> | undefined;
  const server = http.createServer(async (_request, response) => {
    received(); await gate;
    setImmediate(() => { observed = f.counts(); response.end('{}'); });
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address(); assert(address && typeof address !== 'string');
  const response = fetch(`http://127.0.0.1:${address.port}/fixture`).then(value => value.text());
  await arrived;
  release(); f.queue(855);
  const receipt = await f.run.receipt;
  await response;
  assert(observed);
  assert.equal(observed.terminalCount, 0);
  assert(observed.reasoningCount < 855, 'HTTP must progress while canonical events remain queued');
  assert.equal(receipt.status, 'succeeded');
  const events = f.events();
  assert.deepEqual(events.filter(event => event.kind === 'reasoning').map(event => event.payload.text), Array.from({ length: 855 }, (_, index) => `fixture_${index + 1}`));
  assert.equal(events.at(-1).terminal, true);
  assert.equal(events.at(-1).parentEventId, events.filter(event => event.kind === 'reasoning').at(-1).eventId);
  assert.equal(f.counts().terminalCount, 1);
  assert(f.counts().fenceChecks >= 855);
});
}

for (const revoke of ['stale', 'cancelled'] as const) {
  test(`${revoke} fence is observed after yielding before another event append`, async t => {
    const f = await fixture(t, revoke);
    f.queue(32);
    if (revoke === 'stale') {
      await assert.rejects(f.run.receipt, /stale_fence/);
      assert.equal(f.counts().terminalCount, 0);
    } else {
      assert.equal((await f.run.receipt).status, 'cancelled');
      assert.equal(f.counts().terminalCount, 1);
      const events = f.events();
      const terminal = events.at(-1);
      assert.equal(terminal.terminal, true);
      const committedReasoning = events.filter(event => event.kind === 'reasoning');
      assert.equal(terminal.parentEventId, committedReasoning.at(-1).eventId);
      assert(events.slice(0, -1).some(event => event.eventId === terminal.parentEventId));
    }
    assert.equal(f.counts().reasoningCount, 1);
    assert.deepEqual(f.events().filter(event => event.kind === 'reasoning').map(event => event.payload.text), ['fixture_1']);
  });
}
