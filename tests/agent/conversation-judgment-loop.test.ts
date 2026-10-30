import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { CompactionManager, type CompactionConfig } from '../../src/agent/compaction.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { TurnStore } from '../../src/chat/turn-store.js';
import { generateCoordinationId } from '../../src/coordination/ids/index.js';
import { SeedProcess } from '../../substrate/src/seed.js';
import { readSeedLearning } from '../../src/substrate/learning-state.js';
import type { CoordinationTurnOrigin } from '../../src/agent/types.js';

const candidate = { schema: 'home23.conversation-proposal.v1', route: 'conversation', situation: 'sharing', feedback: [], candidates: [
  { id: 'direct', reply: 'That sounds like an afternoon you can keep returning to.',
    axes: { engagement: 'acknowledge', initiative: 'stay_with', continuity: 'present_only', depth: 'brief' } },
  { id: 'question', reply: 'What part of the afternoon stays with you most?',
    axes: { engagement: 'explore', initiative: 'ask_followup', continuity: 'present_only', depth: 'brief' } },
] };

function response(text: string) {
  return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n`
    + `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 17, output_tokens: 12 } } })}\n\n`);
}

function fixture(t: TestContext, ownerText = 'I spent the afternoon by the water.', options: { system?: string; budget?: number; maxTokens?: number; compactionPolicy?: Partial<CompactionConfig> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'conversation-loop-'));
  const priorRoot = process.env.HOME23_ROOT; process.env.HOME23_ROOT = root;
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; if (priorRoot === undefined) delete process.env.HOME23_ROOT; else process.env.HOME23_ROOT = priorRoot;
    rmSync(root, { recursive: true, force: true }); });
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const seedDir = join(root, 'substrate', 'seed-01'); const seed = SeedProcess.initialize(seedDir); seed.checkpoint();
  assert.equal(readSeedLearning(seedDir).available, true);
  const history = new ConversationHistory(join(root, 'conversations'), options.budget ?? 400_000, 'fixture');
  const origin: CoordinationTurnOrigin = { kind: 'coordination', workId: generateCoordinationId('work'),
    attemptId: generateCoordinationId('attempt'), leaseId: generateCoordinationId('lease'),
    holderPrincipalId: generateCoordinationId('bot'), holderInstanceId: 'fixture-resident', authorityReference: 'resident:fixture',
    fencingToken: 1, channelId: generateCoordinationId('channel'), originMessageId: generateCoordinationId('message'), roundId: null };
  const contactPath = join(root, 'contacts.jsonl');
  writeFileSync(contactPath, JSON.stringify({ schema: 'home23.resident.contact.v1', messageId: origin.originMessageId,
    channelId: origin.channelId, session: `coordination:${origin.channelId}`, channelKind: 'direct', role: 'user', voice: 'jtr',
    actor: { kind: 'owner', principalId: 'owner-fixture' }, content: ownerText,
    sourceRef: `coordination.message:${origin.originMessageId}`, contactId: `message:${origin.originMessageId}`,
    sourceSequence: 1, ts: new Date().toISOString() }) + '\n');
  const brainOperations = { withActivityHandler() { return this; }, searchContext: async () => ({ results: [],
    sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_match' } }) };
  const agent = new AgentLoop({ apiKey: 'fixture', model: 'gpt-6.1-sol', provider: 'openai-codex',
    ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
    ...(options.compactionPolicy ? { compaction: new CompactionManager({ client: {} as never, history, memory: {} as never, config: options.compactionPolicy }) } : {}),
    registry: { getAnthropicTools: () => [{ name: 'fixture_noop', description: 'Fixture tool', input_schema: { type: 'object', properties: {} } }],
      getOpenAITools: () => [{ type: 'function', function: { name: 'fixture_noop', description: 'Fixture tool', parameters: { type: 'object', properties: {} } } }],
      get: () => undefined } as never,
    history, contextManager: { getSystemPrompt: () => options.system ?? 'Resident identity. Reply honestly.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    toolContext: { brainOperations, projectRoot: root, workspacePath: workspace, agentName: 'fixture', ownerConversationContactPath: contactPath,
      coordinationChannelOperation: async ({ args }: any) => args.operation === 'project_context' ? { available: false }
        : { registry: 'canonical', work: [], ownerContact: { messageId: origin.originMessageId, text: ownerText,
          channelId: origin.channelId, channelKind: 'direct', channelSequence: 1, createdAt: new Date().toISOString() } } } as never,
    workspacePath: workspace });
  (agent as any).codexCredentialsProvider = async () => ({ accessToken: 'fixture', refreshToken: 'fixture', expires: Date.now() + 60_000, accountId: 'fixture' });
  const requests: any[] = [];
  globalThis.fetch = (async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return response(JSON.stringify(candidate)); }) as typeof fetch;
  return { agent, origin, history, root, requests, chatId: `coord-${origin.workId}`, contactPath };
}

test('native authenticated conversation delivers only selected candidate and records completion after terminal success', async t => {
  const f = fixture(t); const chunks: string[] = [];
  const run = await f.agent.runWithTurn(f.chatId, 'Routing envelope. Answer the latest owner contact.', {
    coordinationOrigin: f.origin, contextPurpose: 'conversation',
    coordinationDelivery: { conversationId: 'conversation-fixture', targetKind: 'owner', targetPrincipalId: 'owner-fixture', targetDisplayName: 'Owner' },
    onEvent: event => { if (event.type === 'response_chunk') chunks.push(event.chunk); },
  });
  const result = await run.response;
  assert.equal(result.text, candidate.candidates[0]!.reply); assert.equal(result.terminalStatus, 'complete');
  assert.deepEqual(chunks, [candidate.candidates[0]!.reply]); assert.equal(f.requests.length, 1);
  const prompt = JSON.stringify(f.requests[0].input);
  assert.match(prompt, /I spent the afternoon by the water/); assert.match(prompt, /authenticatedOwnerText/);
  assert.equal(f.requests[0].tools, undefined, 'candidate proposal cannot invoke tools');
  assert.equal(new TurnStore(f.history).finalEnvelope(f.chatId, run.turnId)?.status, 'complete');
  const rows = readFileSync(join(f.root, 'brain', 'event-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const selected = rows.find(row => row.event_type === 'ConversationReplySelected');
  const completion = rows.find(row => row.event_type === 'ConversationReplyCompleted');
  assert.ok(selected); assert.ok(completion); assert.equal(completion.payload.selectionId, selected.payload.selectionId);
  assert.equal(completion.payload.canonicalDelivery, 'requires_contact_join');
  assert.equal(rows.filter(row => row.event_type === 'LearningDecisionObserved' && row.actor === 'conversation').length, 4);
  assert.ok(f.history.load(f.chatId).some(row => 'role' in row && row.role === 'assistant' && row.content === result.text));
  assert.ok(!f.history.load(f.chatId).some(row => 'role' in row && typeof row.content === 'string' && row.content.includes('conversation-proposal.v1')));
});

test('explicit requested work retains ordinary provider path with no conversational selection', async t => {
  const f = fixture(t, 'Please read the project report.');
  globalThis.fetch = (async (_url, init) => { f.requests.push(JSON.parse(String(init?.body))); return response('Ordinary tool-capable response.'); }) as typeof fetch;
  const run = await f.agent.runWithTurn(f.chatId, 'Routing envelope.', { coordinationOrigin: f.origin, contextPurpose: 'conversation' });
  assert.equal((await run.response).text, 'Ordinary tool-capable response.'); assert.equal(f.requests.length, 1);
  assert.ok(Array.isArray(f.requests[0].tools));
  const events = readFileSync(join(f.root, 'brain', 'event-ledger.jsonl'), 'utf8');
  assert.doesNotMatch(events, /ConversationReplySelected/);
  assert.match(events, /explicit_action_requested/);
});

test('malformed proposal falls through to ordinary loop and never publishes draft JSON', async t => {
  const f = fixture(t); let calls = 0; const chunks: string[] = [];
  globalThis.fetch = (async (_url, init) => { f.requests.push(JSON.parse(String(init?.body))); return response(++calls === 1 ? '{not valid' : 'Ordinary final reply.'); }) as typeof fetch;
  const run = await f.agent.runWithTurn(f.chatId, 'Routing envelope.', { coordinationOrigin: f.origin, contextPurpose: 'conversation',
    onEvent: event => { if (event.type === 'response_chunk') chunks.push(event.chunk); } });
  assert.equal((await run.response).text, 'Ordinary final reply.'); assert.equal(calls, 2);
  assert.deepEqual(chunks, ['Ordinary final reply.']);
  assert.doesNotMatch(readFileSync(join(f.root, 'brain', 'event-ledger.jsonl'), 'utf8'), /ConversationReplyCompleted/);
});

test('canonical direct metadata permits first conversation before projection; group contact retains ordinary loop', async t => {
  const f = fixture(t);
  writeFileSync(f.contactPath, '');
  const first = await f.agent.runWithTurn(f.chatId, 'Routing envelope.', { coordinationOrigin: f.origin, contextPurpose: 'conversation' });
  assert.equal((await first.response).text, candidate.candidates[0]!.reply);
  (f.agent as any).toolContext.coordinationChannelOperation = async ({ args }: any) => args.operation === 'project_context'
    ? { available: false } : { registry: 'canonical', work: [], ownerContact: { messageId: f.origin.originMessageId,
      text: 'I spent the afternoon by the water.', channelId: f.origin.channelId, channelKind: 'group' } };
  globalThis.fetch = (async (_url, init) => { f.requests.push(JSON.parse(String(init?.body))); return response('Ordinary group reply.'); }) as typeof fetch;
  const second = await f.agent.runWithTurn(f.chatId, 'Routing envelope.', { coordinationOrigin: f.origin, contextPurpose: 'conversation' });
  assert.equal((await second.response).text, 'Ordinary group reply.');
  const rows = readFileSync(join(f.root, 'brain', 'event-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.filter(row => row.event_type === 'ConversationReplySelected').length, 1);
});

test('owner stop after selected chunk cannot mint completed conversational experience', async t => {
  const f = fixture(t); const turnId = 'conduct-stop-during-delivery';
  const run = await f.agent.runWithTurn(f.chatId, 'Routing envelope.', { turnId, coordinationOrigin: f.origin, contextPurpose: 'conversation',
    onEvent: event => { if (event.type === 'response_chunk') f.agent.stop(f.chatId, turnId); } });
  const result = await run.response;
  assert.equal(result.terminalStatus, 'stopped');
  const events = readFileSync(join(f.root, 'brain', 'event-ledger.jsonl'), 'utf8');
  assert.match(events, /ConversationReplySelected/); assert.doesNotMatch(events, /ConversationReplyCompleted/);
  assert.equal(new TurnStore(f.history).finalEnvelope(f.chatId, turnId)?.status, 'stopped');
});

// The live home arrived with a 147k–157k-character system context. The former
// independent 120k ceiling bypassed the new route before emitting any evidence.
for (const configured of [false, true]) test(`native conversation with lived-size system context reaches the selector inside its ${configured ? 'configured' : 'default'} budget`, async t => {
  const system = 'Resident context already admitted by the normal loop. '.repeat(3_100);
  assert.ok(system.length > 150_000);
  const f = fixture(t, 'I spent the afternoon by the water.', { system,
    ...(configured ? { compactionPolicy: { modelContextTokens: { 'openai-codex/gpt-6.1-sol': 200_000 } } } : {}) });
  const run = await f.agent.runWithTurn(f.chatId, 'Routing envelope.', { coordinationOrigin: f.origin, contextPurpose: 'conversation' });
  const result = await run.response;
  assert.equal(result.text, candidate.candidates[0]!.reply);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].tools, undefined);
  assert.equal(f.requests[0].instructions.includes(system), true, 'full admitted system context reaches proposer');
  const events = readFileSync(join(f.root, 'brain', 'event-ledger.jsonl'), 'utf8');
  assert.match(events, /ConversationReplySelected/);
  assert.match(events, /ConversationReplyCompleted/);
});

test('proposal reserves its own output against the configured model budget and reports ordinary fallback', async t => {
  const f = fixture(t, 'I spent the afternoon by the water.', { system: 'c'.repeat(100_000), maxTokens: 1_000,
    compactionPolicy: { reserveChars: 1_000, modelContextTokens: { 'openai-codex/gpt-6.1-sol': 40_000 } } });
  globalThis.fetch = (async (_url, init) => {
    const request = JSON.parse(String(init?.body)); f.requests.push(request);
    assert.ok(Array.isArray(request.tools), 'over-budget proposal must not reach provider');
    return response('Ordinary response within the original request budget.');
  }) as typeof fetch;
  const run = await f.agent.runWithTurn(f.chatId, 'Routing envelope.', { coordinationOrigin: f.origin, contextPurpose: 'conversation' });
  assert.equal((await run.response).text, 'Ordinary response within the original request budget.');
  assert.equal(f.requests.length, 1);
  const events = readFileSync(join(f.root, 'brain', 'event-ledger.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const decline = events.find(row => row.event_type === 'ConversationProposalDeferred');
  assert.equal(decline.payload.reason, 'request_exceeds_context_budget');
  assert.equal(decline.payload.budgetSource, 'configured_context_policy');
  assert.ok(decline.payload.requestBudgetChars < 95_000, 'model cap retains tools, 6000 output tokens and reserve');
  assert.ok(decline.payload.requestChars > decline.payload.requestBudgetChars);
  assert.ok(!events.some(row => row.event_type === 'ConversationReplySelected'));
});
