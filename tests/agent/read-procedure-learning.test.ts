import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { executeAndFormatTool, executePlannedTool } from '../../src/agent/tool-result.js';
import { readFileTool, listFilesTool } from '../../src/agent/tools/files.js';
import { ToolRegistry } from '../../src/agent/tools/index.js';
import { SeedProcess } from '../../substrate/src/seed.js';
import { EventLedgerTailAdapter } from '../../substrate/src/adapters/event-ledger-tail.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import type { ToolContext, AgentEvent } from '../../src/agent/types.js';
const { readSeedLearning } = createRequire(import.meta.url)('../../shared/seed-learning.cjs');
const { flushActionFeedback } = createRequire(import.meta.url)('../../engine/src/cognition/action-feedback.js');

function fixture(t: { after(fn: () => void): void }) {
  const instanceDir = realpathSync(mkdtempSync(join(tmpdir(), 'read-procedure-')));
  t.after(() => rmSync(instanceDir, { recursive: true, force: true }));
  const brain = join(instanceDir, 'brain'), workspace = join(instanceDir, 'workspace'), seedDir = join(instanceDir, 'substrate', 'seed-01');
  mkdirSync(brain); mkdirSync(workspace); writeFileSync(join(brain, 'event-ledger.jsonl'), '');
  let seed = SeedProcess.initialize(seedDir); seed.checkpoint();
  const adapter = new EventLedgerTailAdapter({ sourcePath: join(brain, 'event-ledger.jsonl'), cursorDir: join(instanceDir, 'cursor'), fromEnd: false });
  let executions = 0, turn = 0; const events: AgentEvent[] = [];
  const registry = new ToolRegistry();
  for (const tool of [readFileTool, listFilesTool]) registry.register({ ...tool, async execute(input, context) {
    executions++; return tool.execute(input, context);
  } });
  const context = () => ({ instanceDir, workspacePath: workspace, projectRoot: instanceDir, seedStateDir: seedDir,
    shellFsAuthority: { machineAccess: false, roots: [instanceDir] }, chatId: 'coordination:owner', agentName: 'fixture',
    turnRuntime: { turnId: `turn-${++turn}`, abortController: new AbortController() } } as ToolContext);
  const invoke = (name = 'read_file', input: Record<string, unknown> = { path: 'missing.txt' }, ctx = context()) => executeAndFormatTool({
    registry, name, toolCallId: `call-${turn}`, input, context: ctx, onEvent: event => events.push(event), modelLimit: 4000, eventLimit: 4000 });
  const assimilate = () => { for (const event of adapter.pullSync()) { seed.transition(event); adapter.commit(event.endOffset); }
    seed.checkpoint(); seed = SeedProcess.restore(seedDir); return readSeedLearning(seedDir); };
  const receipts = () => existsSync(join(brain, 'actions.jsonl')) ? readFileSync(join(brain, 'actions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  const age = () => { seed.transition({ eventId: 'fixture-later-time', category: 'observation', sourceAuthority: 'home23.event-ledger', sourceRef: 'fixture:clock',
    producedAt: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(), payload: { learningVersion: 2 } }); seed.checkpoint(); seed = SeedProcess.restore(seedDir); };
  return { instanceDir, brain, workspace, seedDir, registry, context, invoke, assimilate, receipts, age, events, executions: () => executions };
}

test('an actual failed read teaches restored Seed and the next unchanged-source read is deferred by that lesson', async t => {
  const f = fixture(t); const first = await f.invoke(); assert.equal(first.success, false); assert.match(first.result.content, /File not found:/);
  const learned = f.assimilate(); assert.equal(learned.lessons.length, 1, 'the real read error must create its own execution lesson');
  assert.equal(learned.lessons[0].value, -0.25);
  const second = await f.invoke(); assert.equal(second.result.readProcedure?.admission, 'deferred');
  assert.equal(second.success, false); assert.equal(f.executions(), 1, 'the later method decision must change actual invocation');
  assert.deepEqual(second.result.readProcedure?.lessonIds, [learned.lessons[0].lessonId]);
  assert.equal(second.result.readProcedure?.counterfactual?.suppress, false, 'only omitting the matching contribution changes the decision');
  assert.equal(f.receipts().at(-1).executionAttempted, false);
  f.assimilate(); assert.equal(readSeedLearning(f.seedDir).lessons.length, 1, 'deferral must not earn another failure credit');
  assert.ok(f.events.some(event => event.type === 'tool_result' && event.readProcedure?.admission === 'deferred'));
});

test('identical source metadata without an applied Seed lesson cannot suppress another read', async t => {
  const f = fixture(t); await f.invoke(); const next = await f.invoke();
  assert.equal(f.executions(), 2); assert.notEqual(next.result.readProcedure?.admission, 'deferred');
});

test('a changed source epoch permits real recovery without deleting prior experience', async t => {
  const f = fixture(t); await f.invoke(); f.assimilate(); const original = readFileSync(join(f.seedDir, 'seed-ledger.jsonl'), 'utf8');
  writeFileSync(join(f.workspace, 'missing.txt'), 'Available current evidence.');
  const recovered = await f.invoke(); assert.equal(recovered.success, true); assert.match(recovered.modelContent, /Available current evidence/);
  assert.equal(f.executions(), 2); const snapshot = f.assimilate(); assert.equal(snapshot.lessons.filter((lesson: any) => lesson.value > 0).length, 1);
  assert.ok(readFileSync(join(f.seedDir, 'seed-ledger.jsonl'), 'utf8').startsWith(original));
});

test('authenticated explicit same-method/path retry and runtime critical recovery bypass deferral', async t => {
  const f = fixture(t); await f.invoke(); f.assimilate();
  const owner = f.context(); owner.authenticatedUserMessage = { chatId: owner.chatId, messageRef: 'owner-current-message', text: 'Retry read_file on missing.txt.' };
  assert.equal((await f.invoke('read_file', { path: 'missing.txt' }, owner)).result.readProcedure?.admission, 'owner_retry');
  const critical = f.context(); critical.readProcedureControl = { criticalRecovery: true };
  assert.equal((await f.invoke('read_file', { path: 'missing.txt' }, critical)).result.readProcedure?.admission, 'critical_recovery');
  assert.equal(f.executions(), 3);
});

test('another target and another read procedure do not inherit a failed file lesson', async t => {
  const f = fixture(t); await f.invoke(); f.assimilate(); writeFileSync(join(f.workspace, 'other.txt'), 'Other evidence.');
  assert.equal((await f.invoke('read_file', { path: 'other.txt' })).success, true);
  assert.equal((await f.invoke('list_files', { pattern: '*.txt', cwd: f.workspace })).success, true);
  assert.equal(f.executions(), 3);
});

test('authority refusals, malformed arguments, private paths and same-name custom tools never become empirical file lessons', async t => {
  const f = fixture(t); const outside = mkdtempSync(join(tmpdir(), 'outside-read-procedure-')); t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'evidence.txt'), 'Outside authority.'); writeFileSync(join(f.workspace, 'secrets.yaml'), 'private fixture data');
  await f.invoke('read_file', { path: join(outside, 'evidence.txt') });
  await f.invoke('read_file', { path: 'missing.txt', limit: -1 });
  await f.invoke('read_file', { path: 'secrets.yaml' });
  f.registry.register({ name: 'read_file', description: 'different implementation', input_schema: {}, async execute() { return { content: 'fake failure', is_error: true }; } });
  await f.invoke(); assert.equal(f.receipts().length, 0); assert.equal(f.assimilate().lessons.length, 0);
});

test('existing inspection wrappers and generic restricted-chat refusals stay outside procedure learning', async t => {
  const f = fixture(t); const ctx = f.context(); ctx.chatId = 'inspection:restricted';
  const result = await f.invoke('read_file', { path: 'missing.txt' }, ctx);
  assert.equal(result.success, false); assert.equal(f.executions(), 0); assert.equal(f.receipts().length, 0);
});

test('an unavailable projection retains the original intent/outcome for retry without rerunning the read', async t => {
  const f = fixture(t); rmSync(join(f.brain, 'event-ledger.jsonl')); mkdirSync(join(f.brain, 'event-ledger.jsonl'));
  await f.invoke(); assert.equal(f.executions(), 1); assert.equal(f.receipts().length, 2);
  rmSync(join(f.brain, 'event-ledger.jsonl'), { recursive: true }); writeFileSync(join(f.brain, 'event-ledger.jsonl'), '');
  flushActionFeedback(f.brain); const snapshot = f.assimilate(); assert.equal(snapshot.lessons.length, 1);
  await f.invoke(); assert.equal(f.executions(), 1, 'projection retry must not rerun the IO, and restored learning now gates it');
});

test('learning receipts contain hashes and safe codes, not private path or result text', async t => {
  const f = fixture(t); await f.invoke('read_file', { path: 'sensitive-personal-evidence.txt' });
  const rows = f.receipts(); assert.equal(rows.length, 2);
  const text = JSON.stringify(rows); assert.doesNotMatch(text, /sensitive-personal-evidence|File not found/);
  assert.equal(text.includes(f.instanceDir), false);
  assert.match(text, /resourceHash|sourceEpoch/);
});

test('planned tool execution uses the same prospective procedure receipts before a later normal gate', async t => {
  const f = fixture(t); const ctx = f.context();
  const destination = { parentWorkId: 'wrk_fixture', attemptId: 'attempt', leaseId: 'lease', targetPrincipalId: 'bot_fixture',
    residentInstanceId: 'fixture', authorityReference: 'owner-authority', fencingToken: 1, channelId: 'channel', originMessageId: 'message', conversationId: 'conversation' };
  await assert.rejects(executePlannedTool({ registry: f.registry, name: 'read_file', toolCallId: 'planned-missing', canonicalArgs: { path: 'missing.txt' },
    context: ctx, destination: destination as never, attemptChatId: 'planned:fixture', abortController: new AbortController(), onEvent: event => f.events.push(event) }), /not found/i);
  assert.equal(f.assimilate().lessons.length, 1); await f.invoke(); assert.equal(f.executions(), 1);
  await assert.rejects(executePlannedTool({ registry: f.registry, name: 'read_file', toolCallId: 'planned-retry', canonicalArgs: { path: 'missing.txt' },
    context: f.context(), destination: destination as never, attemptChatId: 'planned:fixture', abortController: new AbortController(), onEvent: () => {} }), /not found/i);
  assert.equal(f.executions(), 2, 'exact planned method remains owed; flexible next-method gates must not cancel it');
  assert.equal(f.receipts().at(-1).readProcedure.admission, 'planned_method');
});

test('private aliases and credential basenames remain readable but never generate learning identities', async t => {
  const f = fixture(t);
  for (const name of ['secrets.yaml', '.env', '.env.local', 'id_rsa', 'id_ed25519', 'ordinary.key']) {
    writeFileSync(join(f.workspace, name), 'private fixture');
    assert.equal((await f.invoke('read_file', { path: name })).success, true);
  }
  symlinkSync(join(f.workspace, 'secrets.yaml'), join(f.workspace, 'neutral-alias.txt'));
  assert.equal((await f.invoke('read_file', { path: 'neutral-alias.txt' })).success, true);
  assert.equal(f.receipts().length, 0);
});

test('source changes during invocation and unstructured registry errors earn no empirical credit', async t => {
  const f = fixture(t);
  const actual = f.registry.execute.bind(f.registry);
  f.registry.execute = async (name, args, ctx) => {
    const result = await actual(name, args, ctx); writeFileSync(join(f.workspace, 'missing.txt'), 'now exists'); return result;
  };
  await f.invoke(); assert.equal(f.receipts().at(-1).executionAttempted, true);
  assert.equal(f.receipts().at(-1).status, 'unknown'); assert.equal(f.assimilate().lessons.length, 0);
  f.registry.execute = async () => { throw new Error('unattributable private exception'); };
  await assert.rejects(f.invoke(), /unattributable private exception/);
  assert.equal(f.receipts().at(-1).executionAttempted, true); assert.equal(f.assimilate().lessons.length, 0);
  assert.equal(JSON.stringify(f.receipts()).includes('unattributable private exception'), false);
});

test('ordinary owner retry wording bypasses only the exact authenticated current method and path', async t => {
  const f = fixture(t); await f.invoke(); f.assimilate();
  const ctx = f.context(); ctx.authenticatedUserMessage = { chatId: ctx.chatId, messageRef: 'owner', text: 'Read missing.txt again.' };
  assert.equal((await f.invoke('read_file', { path: 'missing.txt' }, ctx)).result.readProcedure?.admission, 'owner_retry');
  ctx.authenticatedUserMessage.text = 'Read missing.txt again. Do not change anything else.';
  assert.equal((await f.invoke('read_file', { path: 'missing.txt' }, ctx)).result.readProcedure?.admission, 'owner_retry');
  for (const text of ['Do not read missing.txt again.', 'Read missing.txt.bak again.', 'Read another.txt again.']) {
    const next = f.context(); next.authenticatedUserMessage = { chatId: next.chatId, messageRef: 'owner', text };
    assert.equal((await f.invoke('read_file', { path: 'missing.txt', retry: true }, next)).result.readProcedure?.admission, 'deferred');
  }
  assert.equal(f.executions(), 3);
});

test('empty valid listings stay successful; genuine missing listing directories teach a separate method', async t => {
  const f = fixture(t);
  assert.equal((await f.invoke('list_files', { pattern: '*.absent', cwd: f.workspace })).success, true);
  assert.equal((await f.invoke('list_files', { pattern: '*', cwd: join(f.workspace, 'missing-dir') })).success, false);
  const snapshot = f.assimilate(); assert.equal(snapshot.lessons.filter((l: any) => l.value < 0).length, 1);
  assert.equal((await f.invoke('list_files', { pattern: '*', cwd: join(f.workspace, 'missing-dir') })).result.readProcedure?.admission, 'deferred');
});

test('the bounded read-learning cohort preserves owner capacity even before Seed assimilates the pending witnesses', async t => {
  const f = fixture(t);
  for (let index = 0; index < 17; index++) {
    const result = await f.invoke('read_file', { path: `unavailable-${index}.txt` });
    assert.equal(result.result.readProcedure?.learningEligibility, index < 16 ? 'eligible' : 'capacity');
  }
  assert.equal(f.executions(), 17, 'capacity never cancels owed reads');
  const excluded = f.receipts().at(-1);
  assert.equal(excluded.phase, 'observation_outcome'); assert.equal(excluded.executionAttempted, true);
  assert.equal(readFileSync(join(f.brain, 'event-ledger.jsonl'), 'utf8').includes(excluded.executionId), false,
    'capacity observations must not fall into legacy consequence teaching');
  const snapshot = f.assimilate(); assert.equal(snapshot.lessons.length, 16);
  const deferred = await f.invoke('read_file', { path: 'unavailable-0.txt' });
  assert.equal(deferred.result.readProcedure?.admission, 'deferred');
  const ctx = f.context(); ctx.authenticatedUserMessage = { chatId: ctx.chatId, messageRef: 'owner', text: 'Read unavailable-0.txt again.' };
  const retried = await f.invoke('read_file', { path: 'unavailable-0.txt' }, ctx);
  assert.equal(retried.result.readProcedure?.learningEligibility, 'eligible', 'an existing exact target can still revise its lesson');
  assert.equal(f.assimilate().lessons.filter((lesson: any) => lesson.active !== false).length, 16);
  f.age(); assert.equal(readSeedLearning(f.seedDir).lessons.filter((lesson: any) => lesson.active !== false).length, 0);
  const later = await f.invoke('read_file', { path: 'new-target-after-real-retirement.txt' });
  assert.equal(later.result.readProcedure?.learningEligibility, 'eligible', 'committed progress and retired active lessons release reservations; the bound is not a lifetime cap');
  assert.equal(f.assimilate().lessons.filter((lesson: any) => lesson.active !== false).length, 1);
});

test('a neutral deferral after consumed feedback cannot permanently block reservation recycling', async t => {
  const f = fixture(t);
  for (let i = 0; i < 16; i++) await f.invoke('read_file', { path: `neutral-cap-${i}.txt` });
  f.assimilate();
  assert.equal((await f.invoke('read_file', { path: 'neutral-cap-0.txt' })).result.readProcedure?.admission, 'deferred');
  f.assimilate(); f.age();
  const next = await f.invoke('read_file', { path: 'a-new-real-target.txt' });
  assert.equal(next.result.readProcedure?.learningEligibility, 'eligible');
  assert.equal(f.assimilate().lessons.filter((lesson: any) => lesson.active !== false).length, 1);
});

for (const provider of ['openai-codex', 'xai', 'openai', 'ollama-cloud', 'anthropic', 'minimax'] as const) {
  test(`${provider} records a real read error, completes an honest turn, and changes the next native tool decision`, async t => {
    const f = fixture(t);
    const keys = ['OPENAI_API_KEY', 'OLLAMA_CLOUD_API_KEY', 'XAI_API_KEY', 'HOME23_ROOT'];
    const prior = new Map(keys.map(key => [key, process.env[key]])); const oldFetch = globalThis.fetch;
    for (const key of keys) process.env[key] = key === 'HOME23_ROOT' ? f.instanceDir : 'fixture-key';
    t.after(() => { globalThis.fetch = oldFetch; for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
    const history = new ConversationHistory(join(f.instanceDir, 'conversations'), 100_000, 'fixture');
    const brainOperations = { withActivityHandler() { return this; } };
    const model = provider === 'anthropic' ? 'claude-fixture' : provider === 'minimax' ? 'MiniMax-fixture' : provider === 'xai' ? 'grok-fixture' : 'gpt-fixture';
    const agent = new AgentLoop({ apiKey: 'fixture-key', provider, model, registry: f.registry, history,
      contextManager: { getSystemPrompt: () => 'Report missing evidence honestly.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
      toolContext: { ...f.context(), brainOperations } as never, workspacePath: f.workspace });
    (agent as any).codexCredentialsProvider = async () => ({ accessToken: 'fixture-token', refreshToken: 'fixture-refresh', expires: Date.now() + 60_000, accountId: 'fixture' });
    const args = { path: 'missing.txt' }; let requests = 0;
    const sse = (events: unknown[]) => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    (agent as any).client = { messages: { stream() {
      const tool = ++requests % 2 === 1;
      const message = { id: 'fixture', type: 'message', role: 'assistant', model, stop_reason: tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 10 },
        content: tool ? [{ type: 'tool_use', id: 'read-call', name: 'read_file', input: args }] : [{ type: 'text', text: 'The requested evidence is unavailable.' }] };
      return { async *[Symbol.asyncIterator]() {}, async finalMessage() { return message; } };
    } } };
    globalThis.fetch = (async (url, init) => {
      if (/localhost|127\.0\.0\.1/.test(String(url))) return new Response('{}', { status: 503 });
      if (String(url).includes('/api/show')) return Response.json({ capabilities: ['tools'] });
      const tool = ++requests % 2 === 1;
      if (provider === 'openai-codex' || provider === 'xai') return sse([
        ...(tool ? [{ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'read-call', name: 'read_file', arguments: JSON.stringify(args) } }]
          : [{ type: 'response.output_text.done', text: 'The requested evidence is unavailable.' }]),
        { type: 'response.completed', response: { status: 'completed' } },
      ]);
      const message = tool ? { role: 'assistant', content: null, tool_calls: [{ id: 'read-call', type: 'function', function: { name: 'read_file', arguments: JSON.stringify(args) } }] }
        : { role: 'assistant', content: 'The requested evidence is unavailable.' };
      return Response.json(provider === 'ollama-cloud' ? { message } : { choices: [{ message }] });
    }) as typeof fetch;
    const events: AgentEvent[] = [];
    const run = async () => (await agent.runWithTurn('fixture', 'Check the existing receipt availability.', { onEvent: event => events.push(event) })).response;
    assert.match((await run()).text, /unavailable/); assert.equal(f.executions(), 1);
    const learned = f.assimilate(); assert.equal(learned.lessons.length, 1); assert.equal(learned.lessons[0].value, -0.25);
    assert.match((await run()).text, /unavailable/); assert.equal(f.executions(), 1, 'actual provider continuation must use the learned method gate');
    const resultEvents = events.filter(event => event.type === 'tool_result');
    assert.equal(resultEvents.length, 2); assert.equal(resultEvents[1]?.success, false);
    assert.equal(resultEvents[1]?.readProcedure?.admission, 'deferred');
    const journal = history.loadRaw('fixture') as any[];
    assert.equal(journal.filter(row => row.type === 'turn' && row.status === 'complete').length, 2, 'honest completed conversations do not erase failed read outcomes');
    assert.ok(journal.some(row => row.type === 'event' && row.data?.readProcedure?.admission === 'deferred'), 'actual native journal retains the causal next-method choice');
  });
}
