import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  JOINED_RESULT_MAX_CHARS,
  spawnAgentTool,
} from '../../../src/agent/tools/subagent.js';
import { createSeededToolRegistry } from '../../../src/agent/tools/index.js';
import { executeAndFormatTool } from '../../../src/agent/tool-result.js';
import type { ToolContext, AgentResponse, ToolDefinition } from '../../../src/agent/types.js';

interface Captured {
  ctx: ToolContext | null;
  message: string;
  tools: unknown[];
  options: unknown;
  loopCalls: number;
  appends: Array<{ chatId: string; records: unknown[] }>;
  delivered: Promise<void>;
}

function makeCtx(parentChatId: string): { ctx: ToolContext; captured: Captured } {
  let resolveDelivered!: () => void;
  const captured: Captured = {
    ctx: null,
    message: '',
    tools: [],
    options: undefined,
    loopCalls: 0,
    appends: [],
    delivered: new Promise<void>((resolve) => { resolveDelivered = resolve; }),
  };

  const response: AgentResponse = { text: 'sub result', model: 'test', toolCallCount: 0, durationMs: 1 };

  const ctx = {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: '/tmp/home23',
    enginePort: 5001,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: null,
    workspacePath: '/tmp/home23/instances/jerry/workspace',
    tempDir: '/tmp/home23/.tmp',
    contextManager: {
      getSystemPrompt: () => 'system prompt',
      getPromptSourceInfo: () => ({ generatedAt: '', totalSections: 0, loadedFiles: [] }),
      invalidate: () => undefined
    },
    subAgentTracker: { active: 0, maxConcurrent: 3, queue: [] },
    chatId: parentChatId,
    telegramAdapter: null,
    runAgentLoop: async (_sys: string, message: string, tools: unknown[], subCtx: ToolContext, options?: unknown) => {
      captured.loopCalls++;
      captured.ctx = subCtx;
      captured.message = message;
      captured.tools = tools;
      captured.options = options;
      return response;
    },
    conversationHistory: {
      append(chatId: string, records: unknown[]) {
        captured.appends.push({ chatId, records });
        resolveDelivered();
      },
    },
  } as unknown as ToolContext;

  return { ctx, captured };
}

test('noncanonical spawn_agent without a mode remains detached', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  const result = await spawnAgentTool.execute({ task: 'audit the scheduler' }, ctx);
  assert.match(result.content, /Sub-agent spawned/);

  await captured.delivered;

  assert.ok(captured.ctx, 'runAgentLoop received a ctx');
  const subChatId = captured.ctx!.chatId;
  assert.ok(subChatId.startsWith('subagent:parent-chat:'), `sub chat id has the subagent prefix (got ${subChatId})`);
  assert.notEqual(subChatId, 'parent-chat');
  assert.match(subChatId, /^subagent:parent-chat:[0-9a-f]{4}$/);

  assert.equal(captured.appends.length, 1, 'exactly one history append');
  assert.equal(captured.appends[0].chatId, 'parent-chat', 'history append targets the parent chat id');
  const record = captured.appends[0].records[0] as { role: string; content: string };
  assert.equal(record.role, 'assistant');
  assert.match(record.content, /Sub-agent complete/);
  assert.match(record.content, /sub result/);
});

test('canonical Connected Agents spawn_agent without a mode joins the current answer', async () => {
  const { ctx, captured } = makeCtx('coordination:cnv_jerry:work_123');

  const result = await spawnAgentTool.execute({ task: 'inspect one detail' }, ctx);

  assert.equal(result.content, 'sub result');
  assert.equal(result.is_error, undefined);
  assert.equal(captured.loopCalls, 1);
  assert.match(captured.ctx!.chatId, /^subagent:coordination:cnv_jerry:work_123:[0-9a-f]{32}$/);
  assert.match(captured.message, /Joined specialist output contract/);
  assert.equal(captured.appends.length, 0, 'joined result returns inline instead of creating a transcript receipt');
});

test('canonical Connected Agents explicit detached mode captures exact durable destination', async () => {
  const { ctx, captured } = makeCtx('coordination:cnv_forrest:work_456');
  const creates: unknown[] = [];
  const terminal: unknown[] = [];
  let resolveTerminal!: () => void;
  const terminalFired = new Promise<void>((resolve) => { resolveTerminal = resolve; });
  (ctx as { turnRuntime?: unknown }).turnRuntime = {
    turnId: 'coord-work_456',
    coordinationOrigin: {
      kind: 'coordination', workId: 'work_456', attemptId: 'att_1', leaseId: 'lea_1',
      holderPrincipalId: 'bot_forrest', holderInstanceId: 'resident-forrest-1',
      authorityReference: 'resident:forrest', fencingToken: 1,
      channelId: 'cnv_forrest', originMessageId: 'msg_owner_1', roundId: null,
    },
    coordinationDelivery: {
      conversationId: 'conversation_forrest', targetPrincipalId: 'bot_forrest',
      targetDisplayName: 'Forrest', targetKind: 'resident_bot',
    },
  };
  ctx.parentWorkId = 'work_456';
  ctx.agentName = 'forrest';
  (ctx as { workRegistry?: unknown }).workRegistry = {
    create: (input: unknown) => { creates.push(input); return { workId: 'aw_detached', originChatId: ctx.chatId }; },
    complete: () => ({}),
  };
  (ctx as { onWorkTerminal?: unknown }).onWorkTerminal = (_workId: string, result: unknown) => {
    terminal.push(result);
    resolveTerminal();
  };

  const result = await spawnAgentTool.execute({ task: 'background this', mode: 'detached' }, ctx);
  await terminalFired;

  assert.equal(result.is_error, undefined);
  assert.match(result.content, /aw_detached/);
  assert.equal(captured.loopCalls, 1);
  assert.equal(captured.appends.length, 0);
  assert.deepEqual(creates, [{
    kind: 'subagent', originChatId: 'coordination:cnv_forrest:work_456',
    originTurnId: 'coord-work_456', parentWorkId: 'work_456',
    coordinationDestination: {
      kind: 'coordination', parentWorkId: 'work_456', channelId: 'cnv_forrest',
      conversationId: 'conversation_forrest', originMessageId: 'msg_owner_1',
      targetPrincipalId: 'bot_forrest', residentBinding: 'forrest',
      residentInstanceId: 'resident-forrest-1', authorityReference: 'resident:forrest',
    },
    deliveryMode: 'detached', label: 'background this',
    resultHandle: {
      type: 'subagent_chat',
      chatId: (creates[0] as { resultHandle: { chatId: string } }).resultHandle.chatId,
    },
  }]);
  assert.deepEqual(terminal, [{
    receiptText: '[Sub-agent complete] background this\n\nsub result',
    resultText: 'sub result',
  }]);
  assert.equal(ctx.subAgentTracker.active, 0);
});

test('spawn_agent isolated:false preserves the legacy shared-chat behavior', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  const result = await spawnAgentTool.execute({ task: 'quick check', mode: 'detached', isolated: false }, ctx);
  assert.match(result.content, /Sub-agent spawned/);

  await captured.delivered;

  assert.equal(captured.ctx!.chatId, 'parent-chat', 'sub-agent runs under the parent chat id');
  assert.equal(captured.appends[0].chatId, 'parent-chat');
});

test('spawn_agent threads a model override through to the loop runner', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  await spawnAgentTool.execute({ task: 'model check', model: 'claude-opus-4-8' }, ctx);
  await captured.delivered;

  assert.deepEqual(captured.options, { modelOverride: { model: 'claude-opus-4-8', provider: 'anthropic' } });
});

test('spawn_agent passes a valid effort to the sub-agent turn', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  await spawnAgentTool.execute({ task: 'effort check', effort: 'high' }, ctx);
  await captured.delivered;

  assert.deepEqual(captured.options, { effort: 'high' });
});

test('spawn_agent rejects invalid effort before claiming or dispatching work', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  const result = await spawnAgentTool.execute({ task: 'invalid effort', effort: 'ultra' }, ctx);

  assert.equal(result.is_error, true);
  assert.match(result.content, /effort/i);
  assert.match(result.content, /none, low, medium, high, xhigh, max/);
  assert.equal(captured.loopCalls, 0);
  assert.equal(ctx.subAgentTracker.active, 0);
});

test('spawn_agent resolves configured model aliases before dispatching the sub-agent', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  (ctx as ToolContext & { modelAliases: Record<string, { provider: string; model: string }> }).modelAliases = {
    sonnet: { provider: 'anthropic', model: 'claude-sonnet-4-7' },
  };

  await spawnAgentTool.execute({ task: 'model check', model: 'sonnet' }, ctx);
  await captured.delivered;

  assert.deepEqual(captured.options, {
    modelOverride: { model: 'claude-sonnet-4-7', provider: 'anthropic' },
  });
});

test('spawn_agent rejects an unresolvable model override before claiming or dispatching work', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  let workCreates = 0;
  (ctx as ToolContext & { workRegistry: NonNullable<ToolContext['workRegistry']> }).workRegistry = {
    create: () => {
      workCreates++;
      return { workId: 'aw_should_not_exist', originChatId: 'parent-chat' };
    },
    complete: () => ({}),
  };

  const result = await spawnAgentTool.execute({ task: 'model check', model: 'not-a-known-model' }, ctx);

  assert.equal(result.is_error, true);
  assert.match(result.content, /model override/i);
  assert.doesNotMatch(result.content, /Sub-agent spawned/);
  assert.equal(workCreates, 0, 'does not create an async-work record');
  assert.equal(captured.loopCalls, 0, 'does not invoke the sub-agent loop');
  assert.equal(captured.ctx, null, 'does not claim a sub-agent context');
  assert.equal(ctx.subAgentTracker.active, 0, 'does not increment the active sub-agent tracker');
});

test('spawn_agent passes no options when no model is requested', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  await spawnAgentTool.execute({ task: 'no model' }, ctx);
  await captured.delivered;

  assert.equal(captured.options, undefined);
});

// ─── Step 31: async-work registration ───────────────────────────

test('spawn_agent registers async work, surfaces the work id, and reports via onWorkTerminal', async () => {
  const { ctx, captured } = makeCtx('ios_abc_jerry_x_ff');
  const created: unknown[] = [];
  const completed: Array<{ workId: string; status: string }> = [];
  const terminal: Array<{ workId: string; result: unknown }> = [];
  let resolveTerminal!: () => void;
  const terminalFired = new Promise<void>((resolve) => { resolveTerminal = resolve; });
  (ctx as { workRegistry?: unknown }).workRegistry = {
    create: (input: unknown) => { created.push(input); return { workId: 'aw_test_0001', originChatId: 'ios_abc_jerry_x_ff' }; },
    complete: (workId: string, status: string) => { completed.push({ workId, status }); return {}; },
  };
  (ctx as { onWorkTerminal?: unknown }).onWorkTerminal = (workId: string, result: unknown) => {
    terminal.push({ workId, result });
    resolveTerminal();
  };

  const result = await spawnAgentTool.execute({ task: 'do a thing' }, ctx);
  assert.ok(result.content.includes('aw_test_0001'), `work id surfaced (got: ${result.content})`);

  await terminalFired;
  assert.equal(created.length, 1);
  const input = created[0] as { kind: string; originChatId: string; resultHandle: { type: string; chatId: string } };
  assert.equal(input.kind, 'subagent');
  assert.equal(input.originChatId, 'ios_abc_jerry_x_ff');
  assert.match(input.resultHandle.chatId, /^subagent:ios_abc_jerry_x_ff:[0-9a-f]{4}$/);
  assert.deepEqual(completed, [{ workId: 'aw_test_0001', status: 'completed' }]);
  assert.equal(terminal[0]?.workId, 'aw_test_0001');
  assert.match((terminal[0]!.result as { receiptText: string }).receiptText, /Sub-agent complete/);
  assert.equal((terminal[0]!.result as { resultText: string }).resultText, 'sub result');
  // pipeline owns history delivery — no direct parent append in registry mode
  assert.equal(captured.appends.length, 0);
});

test('sub-agent context carries parentWorkId so nested work links to it', async () => {
  const { ctx, captured } = makeCtx('ios_abc_jerry_x_ff');
  let resolveTerminal!: () => void;
  const terminalFired = new Promise<void>((resolve) => { resolveTerminal = resolve; });
  (ctx as { workRegistry?: unknown }).workRegistry = {
    create: () => ({ workId: 'aw_test_0002', originChatId: 'ios_abc_jerry_x_ff' }),
    complete: () => ({}),
  };
  (ctx as { onWorkTerminal?: unknown }).onWorkTerminal = () => { resolveTerminal(); };

  await spawnAgentTool.execute({ task: 'nested' }, ctx);
  await terminalFired;
  assert.equal((captured.ctx as { parentWorkId?: string } | null)?.parentWorkId, 'aw_test_0002');
});

test('spawn_agent failure completes the work record as failed', async () => {
  const { ctx } = makeCtx('12345');
  (ctx as { runAgentLoop?: unknown }).runAgentLoop = async () => { throw new Error('boom'); };
  const completed: Array<{ status: string; error?: string }> = [];
  let resolveTerminal!: () => void;
  const terminalFired = new Promise<void>((resolve) => { resolveTerminal = resolve; });
  (ctx as { workRegistry?: unknown }).workRegistry = {
    create: () => ({ workId: 'aw_test_0003', originChatId: '12345' }),
    complete: (_id: string, status: string, error?: string) => { completed.push({ status, error }); return {}; },
  };
  (ctx as { onWorkTerminal?: unknown }).onWorkTerminal = () => { resolveTerminal(); };

  await spawnAgentTool.execute({ task: 'will fail' }, ctx);
  await terminalFired;
  assert.deepEqual(completed, [{ status: 'failed', error: 'boom' }]);
});

test('joined specialist waits, stays isolated and restricted, then returns its exact result once', async () => {
  const { ctx, captured } = makeCtx('ios_parent');
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let settled = false;
  const events: Array<{ type: string; result?: string; success?: boolean }> = [];
  const completed: Array<{ status: string; error?: string }> = [];
  let terminalCalls = 0;
  const media = [{ type: 'image' as const, path: '/tmp/result.png' }];

  (ctx as { onEvent?: unknown }).onEvent = (event: { type: string; result?: string; success?: boolean }) => {
    events.push(event);
  };
  (ctx as { workRegistry?: unknown }).workRegistry = {
    create: () => ({ workId: 'aw_joined', originChatId: 'ios_parent' }),
    completeInline: (_id: string, status: string, error?: string) => {
      completed.push({ status, ...(error ? { error } : {}) });
      return {};
    },
  };
  (ctx as { onWorkTerminal?: unknown }).onWorkTerminal = () => { terminalCalls++; };
  (ctx as { runAgentLoop?: unknown }).runAgentLoop = async (
    _sys: string,
    message: string,
    tools: unknown[],
    subCtx: ToolContext,
    options?: unknown,
  ) => {
    captured.loopCalls++;
    captured.ctx = subCtx;
    captured.message = message;
    captured.tools = tools;
    captured.options = options;
    await gate;
    return { text: 'verbatim specialist result', media, model: 'test', toolCallCount: 0, durationMs: 1 };
  };

  const pending = spawnAgentTool.execute({ task: 'inspect this', mode: 'joined' }, ctx)
    .finally(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'joined tool call remains open while the specialist works');
  release();
  const result = await pending;

  assert.equal(result.content, 'verbatim specialist result');
  assert.deepEqual(result.media, media);
  assert.match(captured.ctx!.chatId, /^subagent:ios_parent:[0-9a-f]{32}$/);
  assert.match(captured.message, /no longer than 3000 characters/);
  assert.deepEqual(captured.tools, []);
  const registry = (captured.options as { registry: { size: number; get(name: string): unknown } }).registry;
  assert.equal(registry.size, 0, 'an empty grant remains an explicit empty registry');
  assert.equal(registry.get('shell'), undefined);
  assert.deepEqual(events.map((event) => event.type), ['subagent_start', 'subagent_result']);
  assert.deepEqual(events.at(-1), {
    type: 'subagent_result',
    subagentId: 'aw_joined',
    task: 'inspect this',
    result: 'verbatim specialist result',
    success: true,
    parentToolCallId: undefined,
    sourceEventType: 'runtime.subagent_completed',
  });
  assert.deepEqual(completed, [{ status: 'completed' }]);
  assert.equal(terminalCalls, 0, 'joined results never enter detached delivery');
  assert.equal(captured.appends.length, 0, 'joined results never append a second assistant message');
  assert.equal(ctx.subAgentTracker.active, 0);
});

test('joined specialist receives only its explicit capability groups', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  const configuredFiles = new Map<string, ToolDefinition>();
  for (const name of ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files']) {
    configuredFiles.set(name, {
      name,
      description: `configured ${name}`,
      input_schema: { type: 'object' },
      execute: async () => ({ content: name }),
    });
  }
  ctx.restrictedToolSource = { get: (name) => configuredFiles.get(name) };
  const result = await spawnAgentTool.execute({
    task: 'read the source',
    mode: 'joined',
    tool_grants: ['files'],
  }, ctx);

  assert.equal(result.content, 'sub result');
  const names = captured.tools.map((tool) => (tool as { name: string }).name);
  assert.deepEqual(names, ['read_file', 'write_file', 'edit_file', 'list_files', 'search_files']);
  const registry = (captured.options as { registry: { size: number; get(name: string): unknown } }).registry;
  assert.equal(registry.size, 5);
  assert.ok(registry.get('read_file'));
  assert.equal(registry.get('shell'), undefined);
  assert.equal(registry.get('spawn_agent'), undefined);
});

test('joined specialist reports failure without detached or history delivery', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  const events: Array<{ type: string; success?: boolean; result?: string }> = [];
  const completed: Array<{ status: string; error?: string }> = [];
  let terminalCalls = 0;
  (ctx as { onEvent?: unknown }).onEvent = (event: { type: string; success?: boolean; result?: string }) => events.push(event);
  (ctx as { runAgentLoop?: unknown }).runAgentLoop = async () => { throw new Error('specialist broke'); };
  (ctx as { workRegistry?: unknown }).workRegistry = {
    create: () => ({ workId: 'aw_failed_joined', originChatId: 'parent-chat' }),
    completeInline: (_id: string, status: string, error?: string) => { completed.push({ status, error }); return {}; },
  };
  (ctx as { onWorkTerminal?: unknown }).onWorkTerminal = () => { terminalCalls++; };

  const result = await spawnAgentTool.execute({ task: 'fail honestly', mode: 'joined' }, ctx);

  assert.equal(result.is_error, true);
  assert.equal(result.content, 'Sub-agent failed: specialist broke');
  assert.deepEqual(events.map((event) => event.type), ['subagent_start', 'subagent_result']);
  assert.equal(events.at(-1)?.success, false);
  assert.equal(events.at(-1)?.result, 'Error: specialist broke');
  assert.deepEqual(completed, [{ status: 'failed', error: 'specialist broke' }]);
  assert.equal(terminalCalls, 0);
  assert.equal(captured.appends.length, 0);
});

test('joined specialist propagates parent cancellation to its exact child work', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  const controller = new AbortController();
  const cancelledWork: string[] = [];
  const completed: Array<{ status: string; error?: string }> = [];
  const events: Array<{ type: string; success?: boolean; result?: string }> = [];
  let rejectRun!: (error: Error) => void;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });

  (ctx as { abortSignal?: AbortSignal }).abortSignal = controller.signal;
  (ctx as { onEvent?: unknown }).onEvent = (event: { type: string; success?: boolean; result?: string }) => events.push(event);
  (ctx as { workRegistry?: unknown }).workRegistry = {
    create: () => ({ workId: 'aw_cancel_joined', originChatId: 'parent-chat' }),
    completeInline: (_id: string, status: string, error?: string) => { completed.push({ status, error }); return {}; },
  };
  (ctx as { requestWorkCancel?: unknown }).requestWorkCancel = (workId: string) => {
    cancelledWork.push(workId);
    const error = Object.assign(new Error('operator_stop'), { code: 'operator_stop' });
    rejectRun(error);
    return { status: 'accepted', work: {} };
  };
  (ctx as { runAgentLoop?: unknown }).runAgentLoop = async () => new Promise((_resolve, reject) => {
    rejectRun = reject;
    markStarted();
  });

  const pending = spawnAgentTool.execute({ task: 'stop with parent', mode: 'joined' }, ctx);
  await started;
  controller.abort(Object.assign(new Error('operator_stop'), { code: 'operator_stop' }));
  const result = await pending;

  assert.equal(result.is_error, true);
  assert.equal(result.content, 'Sub-agent cancelled: operator_stop');
  assert.deepEqual(cancelledWork, ['aw_cancel_joined']);
  assert.deepEqual(completed, [{ status: 'cancelled', error: 'operator_stop' }]);
  assert.deepEqual(events.map((event) => event.type), ['subagent_start', 'subagent_result']);
  assert.equal(events.at(-1)?.success, false);
  assert.equal(events.at(-1)?.result, 'Cancelled: operator_stop');
  assert.equal(captured.appends.length, 0);
  assert.equal(ctx.subAgentTracker.active, 0);
});

test('joined web grant reuses the exact configured resident web definitions', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  const configuredBrowse: ToolDefinition = {
    name: 'web_browse', description: 'configured browse', input_schema: {},
    execute: async () => ({ content: 'browse' }),
  };
  const configuredSearch: ToolDefinition = {
    name: 'web_search', description: 'configured private search', input_schema: {},
    execute: async () => ({ content: 'search' }),
  };
  const configured = new Map([
    ['web_browse', configuredBrowse],
    ['web_search', configuredSearch],
  ]);
  ctx.restrictedToolSource = { get: (name) => configured.get(name) };

  const result = await spawnAgentTool.execute({
    task: 'research one fact', mode: 'joined', tool_grants: ['web'],
  }, ctx);

  assert.equal(result.content, 'sub result');
  assert.deepEqual(captured.tools, [configuredBrowse, configuredSearch]);
});

test('joined result remains complete through the real parent display boundary', async () => {
  const { ctx, captured } = makeCtx('parent-chat');
  const exact = 'z'.repeat(JOINED_RESULT_MAX_CHARS);
  (ctx as { runAgentLoop?: unknown }).runAgentLoop = async (
    _sys: string,
    message: string,
    tools: unknown[],
    subCtx: ToolContext,
    options?: unknown,
  ) => {
    captured.message = message;
    captured.tools = tools;
    captured.ctx = subCtx;
    captured.options = options;
    return { text: exact, model: 'test', toolCallCount: 0, durationMs: 1 };
  };
  const rendered = await executeAndFormatTool({
    registry: createSeededToolRegistry([spawnAgentTool]),
    name: 'spawn_agent',
    toolCallId: 'call-joined',
    input: { task: 'concise answer', mode: 'joined' },
    context: ctx,
    modelLimit: 4_000,
    eventLimit: 4_000,
  });

  assert.equal(rendered.result.content, exact);
  assert.equal(rendered.modelContent, exact);
  assert.equal(rendered.eventContent, exact);
  assert.doesNotMatch(rendered.modelContent, /OUTPUT TRUNCATED/);

  (ctx as { runAgentLoop?: unknown }).runAgentLoop = async () => ({
    text: 'z'.repeat(JOINED_RESULT_MAX_CHARS + 1),
    model: 'test', toolCallCount: 0, durationMs: 1,
  });
  const oversized = await executeAndFormatTool({
    registry: createSeededToolRegistry([spawnAgentTool]),
    name: 'spawn_agent',
    toolCallId: 'call-joined-oversized',
    input: { task: 'concise answer', mode: 'joined' },
    context: ctx,
    modelLimit: 4_000,
    eventLimit: 4_000,
  });
  assert.equal(oversized.success, false);
  assert.equal(oversized.result.is_error, true);
  assert.match(oversized.modelContent, /exceeded 3000 characters/);
  assert.doesNotMatch(oversized.modelContent, /OUTPUT TRUNCATED/);
});

test('prompt construction failure creates no Work or start event in either mode', async () => {
  for (const mode of ['joined', 'detached'] as const) {
    const { ctx, captured } = makeCtx('parent-chat');
    let creates = 0;
    const events: unknown[] = [];
    ctx.contextManager.getSystemPrompt = () => { throw new Error('identity unavailable'); };
    (ctx as { workRegistry?: unknown }).workRegistry = {
      create: () => { creates++; return { workId: 'should-not-exist', originChatId: 'parent-chat' }; },
    };
    (ctx as { onEvent?: unknown }).onEvent = (event: unknown) => events.push(event);

    const result = await spawnAgentTool.execute({ task: 'never starts', mode }, ctx);

    assert.equal(result.is_error, true);
    assert.match(result.content, /Unable to prepare sub-agent context/);
    assert.equal(creates, 0);
    assert.deepEqual(events, []);
    assert.equal(captured.loopCalls, 0);
  }
});
