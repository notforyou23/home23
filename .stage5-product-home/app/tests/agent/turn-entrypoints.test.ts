import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTrackedTurn } from '../../src/agent/turn-entrypoint.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { createSeededToolRegistry } from '../../src/agent/tools/index.js';
import type { TurnRuntimeContext } from '../../src/agent/types.js';

test('executeTrackedTurn awaits the runWithTurn response and never calls raw run', async () => {
  let rawRunCalls = 0;
  const agent = {
    run: async () => {
      rawRunCalls += 1;
      throw new Error('raw run forbidden');
    },
    runWithTurn: async () => ({
      turnId: 'turn-1',
      response: Promise.resolve({
        text: 'done',
        model: 'test',
        toolCallCount: 0,
        durationMs: 1,
      }),
    }),
  };
  const result = await executeTrackedTurn(agent as never, 'chat-1', 'hello');
  assert.equal(result.turnId, 'turn-1');
  assert.equal(result.response.text, 'done');
  assert.equal(rawRunCalls, 0);
});

test('executeTrackedTurn forwards media, events, and both lease durations', async () => {
  let captured: Record<string, unknown> | null = null;
  const onEvent = () => {};
  const media = [{ type: 'image' as const, path: '/tmp/example.png' }];
  const agent = {
    runWithTurn: async (chatId: string, userText: string, options: Record<string, unknown>) => {
      captured = { chatId, userText, ...options };
      return {
        turnId: 'turn-2',
        response: Promise.resolve({
          text: 'done', model: 'test', toolCallCount: 0, durationMs: 1,
        }),
      };
    },
  };
  await executeTrackedTurn(agent as never, 'chat-2', 'hello again', {
    media,
    onEvent,
    inactivityMs: 45_000,
    hardDurationMs: 90_000,
  });
  assert.deepEqual(captured, {
    chatId: 'chat-2',
    userText: 'hello again',
    media,
    onEvent,
    inactivityMs: 45_000,
    hardDurationMs: 90_000,
  });
});

test('executeTrackedTurn forwards a per-turn reasoning effort', async () => {
  let captured: Record<string, unknown> | null = null;
  const agent = {
    runWithTurn: async (_chatId: string, _userText: string, options: Record<string, unknown>) => {
      captured = options;
      return {
        turnId: 'turn-effort',
        response: Promise.resolve({ text: 'done', model: 'test', toolCallCount: 0, durationMs: 1 }),
      };
    },
  };

  await executeTrackedTurn(agent as never, 'chat-effort', 'hello', { effort: 'high' } as never);
  assert.equal(captured?.effort, 'high');
});

test('executeTrackedTurn forwards a per-turn registry override and never calls raw run', async () => {
  const registry = createSeededToolRegistry([]);
  let rawRunCalls = 0;
  let captured: Record<string, unknown> | null = null;
  const agent = {
    run: async () => {
      rawRunCalls += 1;
      throw new Error('raw run forbidden');
    },
    runWithTurn: async (_chatId: string, _userText: string, options: Record<string, unknown>) => {
      captured = options;
      return {
        turnId: 'turn-3',
        response: Promise.resolve({
          text: 'done', model: 'test', toolCallCount: 0, durationMs: 1,
        }),
      };
    },
  };
  await executeTrackedTurn(agent as never, 'worker:systems:wr_1', 'use granted tools', { registry });
  assert.equal(rawRunCalls, 0);
  assert.equal(captured?.registry, registry);
});

test('executeTrackedTurn preserves canonical Working Thread context for nested turns', async () => {
  let captured: Record<string, unknown> | null = null;
  const destination = {
    kind: 'coordination' as const, parentWorkId: 'wrk_root', channelId: 'chn_root',
    conversationId: 'cnv_root', originMessageId: 'msg_root', attemptId: 'att_root',
    leaseId: 'lse_root', fencingToken: 1, targetPrincipalId: 'bot_jerry',
    residentBinding: 'jerry', residentInstanceId: 'resident-1', authorityReference: 'resident:jerry',
  };
  const agent = {
    runWithTurn: async (_chatId: string, _userText: string, options: Record<string, unknown>) => {
      captured = options;
      return {
        turnId: 'turn-nested',
        response: Promise.resolve({ text: 'done', model: 'test', toolCallCount: 0, durationMs: 1 }),
      };
    },
  };

  await executeTrackedTurn(agent as never, 'subagent:coordination:root:child', 'nested', {
    parentWorkId: destination.parentWorkId,
    coordinationWorkDestination: destination,
  });
  assert.equal(captured?.parentWorkId, destination.parentWorkId);
  assert.deepEqual(captured?.coordinationWorkDestination, destination);
});

test('runWithTurn freezes a per-turn registry override without mutating the shared registry', async () => {
  const root = join(tmpdir(), `turn-registry-override-${process.pid}-${Math.random()}`);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const shared = {
    getAnthropicTools: () => [],
    getOpenAITools: () => [],
    get: () => undefined,
    execute: async () => ({ content: 'shared' }),
  };
  const override = createSeededToolRegistry([]);
  let capturedRuntime: TurnRuntimeContext | null = null;
  const agent = new AgentLoop({
    apiKey: 'test-key',
    model: 'gpt-default',
    provider: 'openai',
    registry: shared as never,
    contextManager: {
      getSystemPrompt: () => 'You are a test agent.',
      getPromptSourceInfo: () => ({ loadedFiles: [] }),
    } as never,
    history,
    toolContext: {} as never,
    workspacePath: join(root, 'workspace'),
  });

  try {
    (agent as unknown as { run: AgentLoop['run'] }).run = async (
      _chatId,
      _userText,
      _media,
      _onEvent,
      _runtime,
      turnRuntime,
    ) => {
      capturedRuntime = turnRuntime ?? null;
      return { text: 'done', model: 'gpt-default', toolCallCount: 0, durationMs: 1 };
    };

    const started = await agent.runWithTurn('worker:systems:wr_1', 'hello', { registry: override });
    await started.response;

    assert.equal(capturedRuntime?.registry, override);
    assert.equal((agent as unknown as { registry: unknown }).registry, shared);
    assert.throws(() => {
      (capturedRuntime as { registry?: unknown }).registry = shared;
    });
    assert.equal(capturedRuntime?.registry, override);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runWithTurn awaits durable-start handoff after persistence and before resident execution', async () => {
  const root = join(tmpdir(), `turn-durable-handoff-${process.pid}-${Math.random()}`);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const order: string[] = [];
  const agent = new AgentLoop({
    apiKey: 'test-key', model: 'gpt-default', provider: 'openai',
    registry: createSeededToolRegistry([]),
    contextManager: { getSystemPrompt: () => 'test', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    history, toolContext: {} as never, workspacePath: join(root, 'workspace'),
  });
  try {
    (agent as unknown as { run: AgentLoop['run'] }).run = async () => {
      order.push('run');
      return { text: 'done', model: 'test', toolCallCount: 0, durationMs: 1 };
    };
    const started = await agent.runWithTurn('coordination:test', 'visible instruction', {
      onDurableStart: ({ turnId }) => {
        const persisted = history.loadRaw('coordination:test') as Array<{ turn_id?: string; status?: string }>;
        assert.ok(persisted.some(record => record.turn_id === turnId && record.status === 'pending'));
        order.push('handoff');
      },
    });
    await started.response;
    assert.deepEqual(order, ['handoff', 'run']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tracked canonical cron cancellation stops the exact child and waits for its settlement', async () => {
  const controller = new AbortController();
  let finish!: (value: any) => void;
  const response = new Promise<any>(resolve => { finish = resolve; });
  const stops: unknown[] = [];
  const agent = { runWithTurn: async () => ({ turnId: 'cron-child', response }),
    stop: (chatId: string, turnId: string) => { stops.push([chatId, turnId]); } };
  let settled = false;
  const pending = executeTrackedTurn(agent as never, 'cron-exact', 'check', { signal: controller.signal })
    .finally(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(stops, [['cron-exact', 'cron-child']]);
  assert.equal(settled, false);
  finish({ text: '', model: 'fake', toolCallCount: 0, durationMs: 1, terminalStatus: 'stopped' });
  await pending;
  assert.equal(settled, true);
});
