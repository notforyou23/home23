import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { createTrackedAgentRunner } from '../../src/agent/turn-entrypoint.js';
import { createSeededToolRegistry } from '../../src/agent/tools/index.js';
import { spawnAgentTool, JOINED_RESULT_MAX_CHARS, WORKING_THREAD_RESULT_MAX_CHARS } from '../../src/agent/tools/subagent.js';
import { taskContextTool } from '../../src/agent/tools/task-context.js';
import { executeAndFormatTool } from '../../src/agent/tool-result.js';
import type { ToolContext } from '../../src/agent/types.js';
import { appendDelegationInstruction, buildDelegationHandoff, captureDelegationSnapshot } from '../../src/agent/delegation-handoff.js';
import { executePlannedTool } from '../../src/agent/tool-result.js';

function completeEvidence(history: ConversationHistory, chatId: string, id: string): string {
  const parts: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = history.taskContext.read(chatId, id, offset, 16000);
    parts.push(page.text); offset = page.nextOffset;
  }
  return parts.join('');
}

test('oversize request, working summary and steering remain recoverable across nested handoffs with honest provenance', async t => {
  const root = mkdtempSync(join(tmpdir(), 'delegation-nested-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = new ConversationHistory(join(root, 'history'), 400000, 'test');
  const ctx = { chatId: 'cron-parent', workspacePath: root, projectRoot: root, conversationHistory: history } as ToolContext;
  const original = 'CRON-INPUT: ' + 'context '.repeat(1500) + ' LATEST-CORRECTION';
  const summary = 'Model working notes. '.repeat(500) + ' FULL-SUMMARY-END';
  ctx.delegationSnapshot = captureDelegationSnapshot(ctx, original, 'FRESH-BOUNDED-WORKSPACE-MAP');
  appendDelegationInstruction(ctx, 'Do not revive the completed search.');
  appendDelegationInstruction(ctx, 'Current steering. '.repeat(500) + ' COMPLETE-STEERING-END');
  assert.equal(ctx.delegationSnapshot.requestSource, 'parent_turn_input', 'cron input never becomes authenticated owner direction');
  assert.ok(ctx.delegationSnapshot.parentRequest.length < 2500);
  assert.match(ctx.delegationSnapshot.parentRequest, /LATEST-CORRECTION/);
  assert.equal(completeEvidence(history, ctx.chatId, ctx.delegationSnapshot.requestEvidenceId!), original);
  const child = buildDelegationHandoff(ctx, { context_summary: summary }, 'child');
  assert.equal(child.needsTaskContext, true);
  assert.match(child.block, /not new authorization/);
  assert.match(child.block, /parent_turn_input/);
  assert.match(child.block, /Do not revive the completed search/);
  assert.match(child.block, /COMPLETE-STEERING-END/);
  assert.match(child.block, /FULL-SUMMARY-END/);
  const firstId = child.snapshot!.requestEvidenceId!;
  assert.notEqual(firstId, ctx.delegationSnapshot.requestEvidenceId);
  assert.equal(JSON.parse(completeEvidence(history, 'child', firstId)).text, original);
  const childCtx = { ...ctx, chatId: 'child', delegationSnapshot: child.snapshot } as ToolContext;
  const ownChildId = history.taskContext.save('child', 'tool', 'CHILD-OWN-TOOL-RESULT');
  const ownRead = await taskContextTool.execute({ action: 'read', id: ownChildId }, childCtx);
  assert.match(ownRead.content, /CHILD-OWN-TOOL-RESULT/);
  assert.equal(ownRead.is_error, undefined);
  const ownNote = await taskContextTool.execute({ action: 'note', key: 'next', text: 'Verify the remaining step.', source_ids: [ownChildId] }, childCtx);
  assert.equal(ownNote.is_error, undefined);
  const grandchild = buildDelegationHandoff(childCtx, { evidence_refs: [ownChildId] }, 'grandchild');
  assert.notEqual(grandchild.snapshot!.requestEvidenceId, firstId);
  assert.equal(grandchild.snapshot!.sourceChatId, 'cron-parent');
  assert.match(grandchild.block, /LATEST-CORRECTION/);
  assert.match(grandchild.block, /Do not revive the completed search/);
  assert.equal((grandchild.block.match(/\[DELEGATION HANDOFF/g) ?? []).length, 1);
  assert.match(completeEvidence(history, 'grandchild', grandchild.snapshot!.requestEvidenceId!), /CRON-INPUT/);
  assert.throws(() => history.taskContext.read('grandchild', firstId), /not available/);
});

test('authenticated message provenance requires actual authenticatedUserMessage metadata', t => {
  const root = mkdtempSync(join(tmpdir(), 'delegation-authored-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = { chatId: 'chat', workspacePath: root, projectRoot: root,
    authenticatedUserMessage: { chatId: 'chat', messageRef: 'turn:user', text: 'Authenticated current correction.' } } as ToolContext;
  const snapshot = captureDelegationSnapshot(ctx, 'Model-authored task input.', 'map');
  assert.equal(snapshot.requestSource, 'authenticated_parent_message');
  assert.equal(snapshot.parentRequest, 'Authenticated current correction.');
});

test('actual tracked specialist receives fresh parent map/request and explicit evidence in its own scope', async t => {
  const root = mkdtempSync(join(tmpdir(), 'delegation-continuity-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'NOW.md'), 'CURRENT-WORKSPACE-MAP: preserve the established home.');
  const history = new ConversationHistory(join(root, 'history'), 400000, 'test');
  const parentChatId = 'worker:parent';
  const evidence = 'ORIGINAL-SELECTED-EVIDENCE: ' + 'complete detail '.repeat(2000) + ' EXACT-END';
  const parentId = history.taskContext.save(parentChatId, 'tool', evidence);
  const unrelated = history.taskContext.save('unrelated-chat', 'tool', 'UNRELATED-PRIVATE-EVIDENCE');
  assert.throws(() => history.taskContext.read('unrelated-child', parentId), /not available/);
  const registry = createSeededToolRegistry([spawnAgentTool, taskContextTool]);
  const brainOperations = { withActivityHandler() { return this; }, async searchContext() { return { results: [] }; } };
  const ctx = { workspacePath: workspace, projectRoot: root, agentName: 'test',
    conversationHistory: history, brainOperations, subAgentTracker: { active: 0, maxConcurrent: 3, queue: [] },
    contextManager: { getSystemPrompt: () => 'Stable resident identity.', getPromptSourceInfo: () => ({ loadedFiles: [] }) },
  } as unknown as ToolContext;
  const agent = new AgentLoop({ apiKey: 'test-key', model: 'gpt-test', provider: 'openai', maxTokens: 128,
    registry, history, contextManager: ctx.contextManager as never, toolContext: ctx, workspacePath: workspace,
    situationalAwareness: { bootstrap: { reads: ['NOW.md'] } },
  });
  const delegatedChats: string[] = [];
  const trackedRunner = createTrackedAgentRunner(agent);
  ctx.runAgentLoop = (...args) => { delegatedChats.push(args[3].chatId); return trackedRunner(...args); };
  const priorFetch = globalThis.fetch;
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  t.after(() => {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    rmSync(root, { recursive: true, force: true });
  });
  const requests: any[] = [];
  globalThis.fetch = (async (url, init) => {
    if (/localhost|127\.0\.0\.1/.test(String(url))) return new Response('{}', { status: 503 });
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    const firstUser = body.messages.find((item: any) => item.role === 'user')?.content ?? '';
    if (String(firstUser).startsWith('Latest parent request:')) {
      if (body.messages.some((item: any) => item.role === 'tool')) return Response.json({ choices: [{ message: { role: 'assistant', content: 'Parent done.' } }] });
      return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{
        id: 'spawn', type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({
          task: 'Inspect the selected evidence.', task_kind: 'analysis', mode: 'joined', evidence_refs: [parentId],
          context_summary: 'Parent working summary: inspect complete evidence before deciding.',
        }) },
      }] } }] });
    }
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'Specialist done.' } }] });
  }) as typeof fetch;
  await (await agent.runWithTurn(parentChatId, 'Latest parent request: the earlier search finished; repair the present issue.')).response;
  const childRequest = requests.find(body => String(body.messages.find((item: any) => item.role === 'user')?.content).startsWith('Inspect the selected evidence.'));
  assert.ok(childRequest);
  const system = childRequest.messages[0].content;
  assert.match(system, /Latest parent request: the earlier search finished/);
  assert.match(system, /CURRENT-WORKSPACE-MAP/);
  assert.match(system, /Parent working summary/);
  const childChatId = delegatedChats.find(id => id.startsWith(`subagent:${parentChatId}:`))!;
  assert.ok(childChatId);
  assert.deepEqual(childRequest.tools.map((tool: any) => tool.function.name), ['task_context']);
  const imported = history.taskContext.search(childChatId, 'ORIGINAL-SELECTED-EVIDENCE').matches;
  assert.equal(imported.length, 1);
  assert.notEqual(imported[0]!.id, parentId, 'child IDs bind imported provenance rather than borrowing a parent selector');
  const parts: string[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const page = history.taskContext.read(childChatId, imported[0]!.id, offset, 16000);
    parts.push(page.text); offset = page.nextOffset;
  }
  const importedText = parts.join('');
  assert.match(importedText, /EXACT-END/);
  assert.match(importedText, new RegExp(parentId));
  assert.match(importedText, /worker:parent/);
  assert.throws(() => history.taskContext.read(childChatId, unrelated), /not available/);
  assert.throws(() => history.taskContext.read(childChatId, parentId), /not available/);
});

for (const limit of [JOINED_RESULT_MAX_CHARS, WORKING_THREAD_RESULT_MAX_CHARS]) {
  test(`a joined result beyond former ${limit} limit succeeds and retains its complete original`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'delegation-long-result-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const history = new ConversationHistory(join(root, 'history'), 400000, 'test');
    const exact = 'Original specialist evidence '.repeat(Math.ceil((limit + 1000) / 29)) + ' END-OF-COMPLETE-RESULT';
    const ctx = { chatId: 'worker:parent', workspacePath: root, projectRoot: root,
      conversationHistory: history, subAgentTracker: { active: 0, maxConcurrent: 3, queue: [] },
      contextManager: { getSystemPrompt: () => 'identity' },
      ...(limit === WORKING_THREAD_RESULT_MAX_CHARS ? { coordinationWorkDestination: { parentWorkId: 'wrk_root' } } : {}),
      runAgentLoop: async () => ({ text: exact, model: 'test', toolCallCount: 0, durationMs: 1 }),
    } as unknown as ToolContext;
    const registry = createSeededToolRegistry([spawnAgentTool, taskContextTool]);
    const rendered = await executeAndFormatTool({ registry, name: 'spawn_agent', toolCallId: 'spawn-long',
      input: { task: 'Investigate completely.', task_kind: 'analysis', mode: 'joined' }, context: ctx, modelLimit: 4000, eventLimit: 4000 });
    assert.equal(rendered.success, true);
    assert.equal(rendered.result.content, exact);
    assert.equal(rendered.result.is_error, undefined);
    assert.ok(rendered.result.contextEvidenceId);
    assert.match(rendered.modelContent, /Retained task evidence/);
    const retained = history.taskContext.search(ctx.chatId, 'END-OF-COMPLETE-RESULT').matches;
    assert.ok(retained.length > 0);
  });
}

test('Working Thread owner synthesis receives an explicit long-result recovery path and complete original', async t => {
  const root = mkdtempSync(join(tmpdir(), 'owner-synthesis-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = new ConversationHistory(join(root, 'history'), 400000, 'test');
  const exact = 'Confirmed original evidence. '.repeat(1300) + ' CRUCIAL-TAIL-CORRECTION';
  const registry = createSeededToolRegistry([{
    name: 'local_review', description: 'Return complete evidence', input_schema: { type: 'object' },
    async execute() { return { content: exact }; },
  }]);
  let supplied = '';
  const context = { agentName: 'test', chatId: 'work-attempt', workspacePath: root, projectRoot: root,
    conversationHistory: history,
    runAgentLoop: async (_system, message, _tools, ctx, options) => {
      supplied = message;
      assert.deepEqual(options!.registry!.getAnthropicTools().map(tool => tool.name), ['task_context']);
      assert.match(message, /preview|TRUNCATED|truncated/);
      const id = message.match(/Complete original retained as (ctx_[a-f0-9]{64})/)![1]!;
      const raw = completeEvidence(history, ctx.chatId, id);
      assert.equal(JSON.parse(raw).content, exact);
      const lookup = await options!.registry!.execute('task_context', { action: 'read', id, offset: raw.indexOf('CRUCIAL-TAIL-CORRECTION') - 10, limit: 100 }, ctx);
      assert.match(lookup.content, /CRUCIAL-TAIL-CORRECTION/);
      return { text: 'The review remains unfinished; the tail records the correction.', model: 'test', toolCallCount: 1, durationMs: 1 };
    },
  } as ToolContext;
  const destination = { kind: 'coordination' as const, parentWorkId: 'wrk_root', channelId: 'chn_root', conversationId: 'cnv_root',
    originMessageId: 'msg_root', attemptId: 'att_root', leaseId: 'lse_root', fencingToken: 1, targetPrincipalId: 'bot_test',
    residentBinding: 'test', residentInstanceId: 'resident-test', authorityReference: 'resident:test' };
  const result = await executePlannedTool({ registry, name: 'local_review', toolCallId: 'call-review', canonicalArgs: {},
    context, destination, attemptChatId: context.chatId, abortController: new AbortController(), onEvent() {} });
  assert.match(result.text, /unfinished/);
  assert.match(supplied, /Read omitted material when it can change the result/);
});

test('promoted specialist remaps only selected parent evidence into the Working Thread before dispatch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'promoted-specialist-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = new ConversationHistory(join(root, 'history'), 400000, 'test');
  const selectedId = history.taskContext.save('owner-foreground', 'tool', 'SELECTED-PARENT-EVIDENCE-END');
  const unrelatedId = history.taskContext.save('unrelated-chat', 'tool', 'UNRELATED-PRIVATE-TEXT');
  let childChatId = '';
  let childSystem = '';
  const context = { agentName: 'test', chatId: 'owner-foreground', workspacePath: root, projectRoot: root,
    conversationHistory: history, subAgentTracker: { active: 0, maxConcurrent: 3, queue: [] },
    contextManager: { getSystemPrompt: () => 'Static identity' },
    runAgentLoop: async (system, _message, _tools, ctx) => {
      if (system) { childChatId = ctx.chatId; childSystem = system; }
      return { text: 'The selected review is finished.', model: 'test', toolCallCount: 0, durationMs: 1 };
    },
  } as ToolContext;
  const original = 'Current parent request. '.repeat(200) + ' CURRENT-REQUEST-END';
  context.delegationSnapshot = captureDelegationSnapshot(context, original, 'FRESH-MAP');
  const originalRequestId = context.delegationSnapshot.requestEvidenceId!;
  const registry = createSeededToolRegistry([spawnAgentTool, taskContextTool]);
  const destination = { kind: 'coordination' as const, parentWorkId: 'wrk_root', channelId: 'chn_root', conversationId: 'cnv_root',
    originMessageId: 'msg_root', attemptId: 'att_root', leaseId: 'lse_root', fencingToken: 1, targetPrincipalId: 'bot_test',
    residentBinding: 'test', residentInstanceId: 'resident-test', authorityReference: 'resident:test' };
  const canonicalArgs = { task: 'Inspect selected evidence.', task_kind: 'analysis', mode: 'joined', evidence_refs: [selectedId] };
  const result = await executePlannedTool({ registry, name: 'spawn_agent', toolCallId: 'call-review', canonicalArgs,
    context, destination, attemptChatId: 'work-attempt', abortController: new AbortController(), onEvent() {} });
  assert.equal(result.text, 'The selected review is finished.');
  assert.match(childSystem, /CURRENT-REQUEST-END/);
  assert.match(childSystem, /FRESH-MAP/);
  assert.ok(history.taskContext.search('work-attempt', 'SELECTED-PARENT-EVIDENCE-END').matches.length);
  assert.ok(history.taskContext.search(childChatId, 'SELECTED-PARENT-EVIDENCE-END').matches.length);
  assert.throws(() => history.taskContext.read('work-attempt', selectedId), /not available/);
  assert.throws(() => history.taskContext.read(childChatId, selectedId), /not available/);
  assert.throws(() => history.taskContext.read(childChatId, originalRequestId), /not available/);
  assert.throws(() => history.taskContext.read(childChatId, unrelatedId), /not available/);
  assert.deepEqual(canonicalArgs.evidence_refs, [selectedId], 'the planned canonical arguments remain immutable');
});
