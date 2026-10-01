import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { CompactionManager } from '../../src/agent/compaction.js';
import { TurnStore } from '../../src/chat/turn-store.js';
import { brainSearchTool } from '../../src/agent/tools/brain.js';
import { createSeededToolRegistry } from '../../src/agent/tools/index.js';
import { generateCoordinationId } from '../../src/coordination/ids/index.js';
import type { CoordinationTurnOrigin } from '../../src/agent/types.js';
import { deferred } from '../helpers/manual-clock.js';

function sse(events: Record<string, unknown>[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}
const final = () => sse([{ type: 'response.output_text.delta', delta: 'Known answer.' },
  { type: 'response.completed', response: { status: 'completed' } }]);

function fixture(t: TestContext, budget = 400_000) {
  const root = mkdtempSync(join(tmpdir(), 'responsive-turn-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'PERSONAL.md'), 'OWNER-RELATIONSHIP: lifelong collaborator.');
  writeFileSync(join(workspace, 'NOW.md'), 'CARRIED-STATE: current project and open commitment.');
  const history = new ConversationHistory(join(root, 'conversations'), budget, 'test');
  const origin: CoordinationTurnOrigin = { kind: 'coordination', workId: generateCoordinationId('work'),
    attemptId: generateCoordinationId('attempt'), leaseId: generateCoordinationId('lease'),
    holderPrincipalId: generateCoordinationId('bot'), holderInstanceId: 'fixture-resident',
    authorityReference: 'resident:jerry', fencingToken: 1, channelId: generateCoordinationId('channel'),
    originMessageId: generateCoordinationId('message'), roundId: null };
  const chatId = `coordination:${origin.channelId}:${origin.workId}`;
  const ready = deferred<Record<string, unknown>>();
  const searchStarted = deferred<void>();
  let searchSignal: AbortSignal | undefined;
  let automaticCalls = 0;
  let explicitCalls = 0;
  const operations = {
    withActivityHandler() { return this; },
    async searchContext(_request: unknown, signal: AbortSignal) {
      automaticCalls++; searchSignal = signal; searchStarted.resolve(); return ready.promise;
    },
    async search(request: { query: string }, signal: AbortSignal) {
      explicitCalls++; assert.equal(signal.aborted, false); assert.equal(request.query, 'previous agreement');
      return { results: [{ concept: 'VERIFIED-EXPLICIT-RECALL: use the agreed curriculum.', similarity: 0.99 }],
        sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches', completeness: 'complete' } };
    },
  };
  const registry = createSeededToolRegistry([brainSearchTool]);
  const compaction = new CompactionManager({ client: {} as never, memory: {} as never, history,
    provider: 'openai-codex', model: 'gpt-6.1-sol', config: { reserveChars: 1000 } });
  const agent = new AgentLoop({ apiKey: 'fixture', model: 'gpt-6.1-sol', provider: 'openai-codex',
    registry, history, compaction, maxTokens: 256,
    contextManager: { getSystemPrompt: () => 'DURABLE-IDENTITY: Jerry is a continuous individual.',
      getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    toolContext: { brainOperations: operations } as never, workspacePath: workspace });
  (agent as any).codexCredentialsProvider = async () => ({ accessToken: 'fixture', refreshToken: 'fixture',
    expires: Date.now() + 60000, accountId: 'fixture' });
  (agent as any).relationshipLedger.retrieveForContext = () => ({ text: 'RELATIONSHIP-CONTINUITY: shared history.', entries: [{ id: 'fixture' }] });
  (agent as any).relationshipLedger.markSurfaced = () => undefined;
  const requests: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return final(); }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; rmSync(root, { recursive: true, force: true }); });
  return { agent, history, origin, chatId, ready, searchStarted, requests,
    automaticCalls: () => automaticCalls, explicitCalls: () => explicitCalls, searchSignal: () => searchSignal };
}

const backfill = () => [{ messageId: generateCoordinationId('message'), sequence: 1, role: 'user' as const,
  text: 'PREVIOUS-AGREEMENT: keep the owner constraint.', createdAt: '2026-09-30T20:00:00.000Z' }];

test('native conversation reaches its first provider request while recall is pending, retaining continuity and selected cortex', async t => {
  const f = fixture(t);
  const startedAt = performance.now();
  const run = await f.agent.runWithTurn(f.chatId, 'Answer my current question.', { coordinationOrigin: f.origin,
    contextPurpose: 'conversation', historyBackfill: backfill(), effort: 'max',
    modelOverride: { provider: 'openai-codex', model: 'gpt-6-astra' } });
  await run.response;
  assert.ok(performance.now() - startedAt < 1500, 'an unresolved 8s lookup must not hold this turn');
  assert.equal(f.automaticCalls(), 1);
  const request = f.requests[0];
  for (const expected of ['DURABLE-IDENTITY', 'OWNER-RELATIONSHIP', 'CARRIED-STATE', 'RELATIONSHIP-CONTINUITY', 'PREVIOUS-AGREEMENT']) assert.ok(request.instructions.includes(expected), expected);
  assert.match(request.instructions, /AUTOMATIC RECALL: pending/);
  assert.match(request.instructions, /neither a memory absence result nor a brain health result/);
  assert.equal(request.model, 'gpt-6-astra');
  assert.equal(request.reasoning.effort, 'max');
  assert.equal(f.agent.getModel(), 'gpt-6.1-sol');
  assert.equal(new TurnStore(f.history).startEnvelope(f.chatId, run.turnId)?.context_purpose, 'conversation');
  assert.ok(request.tools.some((tool: any) => tool.name === 'brain_search'));
  assert.equal(f.searchSignal()?.aborted, true, 'finishing the turn cancels the optional lookup');
});

test('pending enrichment does not replace deliberate brain_search or its authoritative tool receipt', async t => {
  const f = fixture(t);
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)); f.requests.push(body);
    if (f.requests.length === 1) return sse([
      { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'recall-1', name: 'brain_search', arguments: JSON.stringify({ query: 'previous agreement' }) } },
      { type: 'response.completed', response: { status: 'completed' } },
    ]);
    assert.match(JSON.stringify(body.input), /VERIFIED-EXPLICIT-RECALL/);
    return final();
  }) as typeof fetch;
  const run = await f.agent.runWithTurn(f.chatId, 'Recall our previous agreement.', { coordinationOrigin: f.origin, contextPurpose: 'conversation' });
  await run.response;
  assert.equal(f.explicitCalls(), 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.searchSignal()?.aborted, true);
});

for (const purpose of ['work', undefined] as const) {
  test(`scheduled or unknown canonical purpose (${purpose}) waits for the original brain result`, async t => {
    const f = fixture(t);
    const run = await f.agent.runWithTurn(f.chatId, 'Advance the curriculum.', { coordinationOrigin: f.origin, contextPurpose: purpose });
    await f.searchStarted.promise;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.requests.length, 0);
    f.ready.resolve({ results: [{ concept: 'FULL-WORK-CONTEXT', similarity: 0.9 }], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'matches' } });
    await run.response;
    assert.match(f.requests[0].instructions, /FULL-WORK-CONTEXT/);
    assert.doesNotMatch(f.requests[0].instructions, /AUTOMATIC RECALL: pending/);
  });
}

test('isolated retrieval evaluation bypasses both automatic recall and relationship enrichment', async t => {
  const f = fixture(t);
  const run = await f.agent.runWithTurn(f.chatId, 'Isolated retrieval: use brain_search.', { coordinationOrigin: f.origin, contextPurpose: 'conversation' });
  await run.response;
  assert.equal(f.automaticCalls(), 0);
  assert.match(f.requests[0].instructions, /RETRIEVAL EVAL/);
  assert.doesNotMatch(f.requests[0].instructions, /AUTOMATIC RECALL|RELATIONSHIP-CONTINUITY/);
});

test('large canonical backfill is budgeted before a provider call; protected history is retained on refusal', async t => {
  const f = fixture(t, 4000);
  const historyBackfill = [{ ...backfill()[0]!, text: 'PROTECTED-EARLIER-INSTRUCTION '.repeat(2000) }];
  const run = await f.agent.runWithTurn(f.chatId, 'CURRENT-REQUEST', { coordinationOrigin: f.origin,
    contextPurpose: 'conversation', historyBackfill });
  await assert.rejects(run.response, (error: any) => error.code === 'context_pressure');
  assert.equal(f.requests.length, 0);
  assert.match(JSON.stringify(f.history.load(f.chatId)), /CURRENT-REQUEST/);
  assert.equal(f.searchSignal()?.aborted, true);
});

test('owner cancellation during the short foreground wait never reaches the provider or publishes late cues', async t => {
  const f = fixture(t);
  const run = await f.agent.runWithTurn(f.chatId, 'Answer after recall.', { coordinationOrigin: f.origin, contextPurpose: 'conversation' });
  await f.searchStarted.promise;
  const rejected = assert.rejects(run.response, /operator_stop|aborted|stop/i);
  f.agent.stop(f.chatId, run.turnId);
  await rejected;
  f.ready.resolve({ results: [{ concept: 'LATE-AFTER-CANCELLATION', similarity: 0.9 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 0);
  assert.equal(f.searchSignal()?.aborted, true);
  assert.equal(new TurnStore(f.history).finalEnvelope(f.chatId, run.turnId)?.status, 'stopped');
});
