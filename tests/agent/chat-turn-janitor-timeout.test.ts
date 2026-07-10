import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { TurnStore } from '../../src/chat/turn-store.js';
import type { ToolContext, TurnRuntimeContext } from '../../src/agent/types.js';

function makeBrainOperations() {
  const base = {
    withActivityHandler(onActivity: (activity: unknown) => void) {
      return Object.freeze({
        ...base,
        activityHandler: onActivity,
      });
    },
  };
  return base;
}

function makeAgent(root: string): {
  agent: AgentLoop;
  history: ConversationHistory;
  toolContext: ToolContext;
} {
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const registry = {
    getAnthropicTools: () => [],
    getOpenAITools: () => [],
    get: () => undefined,
    execute: async () => ({ content: '' }),
  };
  const contextManager = {
    getSystemPrompt: () => 'You are a test agent.',
    getPromptSourceInfo: () => ({ loadedFiles: [] }),
  };
  const toolContext = {
    brainOperations: makeBrainOperations(),
    turnRuntime: null,
  } as unknown as ToolContext;
  const agent = new AgentLoop({
    apiKey: 'test-key',
    model: 'gpt-5.5',
    provider: 'openai',
    registry: registry as any,
    contextManager: contextManager as any,
    history,
    toolContext,
    workspacePath: join(root, 'workspace'),
  });
  return { agent, history, toolContext };
}

class ManualClock {
  nowMs = 1_000;
  tasks = new Map<number, { at: number; fn: () => void }>();
  nextId = 1;
  now = (): number => this.nowMs;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.nowMs + ms, fn });
    return id;
  };
  clearTimeout = (id: number): void => { this.tasks.delete(id); };
  advance(ms: number): void {
    this.nowMs += ms;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.nowMs)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (due.length === 0) return;
      for (const [id, task] of due) {
        if (!this.tasks.delete(id)) continue;
        task.fn();
      }
    }
  }
}

function installManualClock(agent: AgentLoop): ManualClock {
  const clock = new ManualClock();
  (agent as any).turnTiming = {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  return clock;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test('recoverStaleTurns orphans stale pending turns across chats and skips the active turn', () => {
  const root = join(tmpdir(), `chat-turn-janitor-${Date.now()}`);
  const { agent, history } = makeAgent(root);
  const staleStartedAt = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const freshStartedAt = new Date().toISOString();

  try {
    history.appendRecord('stale-chat', {
      type: 'turn',
      turn_id: 't-stale',
      chat_id: 'stale-chat',
      status: 'pending',
      role: 'assistant',
      started_at: staleStartedAt,
    });
    history.appendRecord('active-chat', {
      type: 'turn',
      turn_id: 't-active',
      chat_id: 'active-chat',
      status: 'pending',
      role: 'assistant',
      started_at: staleStartedAt,
    });
    history.appendRecord('fresh-chat', {
      type: 'turn',
      turn_id: 't-fresh',
      chat_id: 'fresh-chat',
      status: 'pending',
      role: 'assistant',
      started_at: freshStartedAt,
    });
    (agent as any).activeTurnIds.set('active-chat', 't-active');

    const recovered = agent.recoverStaleTurns(10 * 60 * 1000);

    assert.deepEqual(recovered, [{ chatId: 'stale-chat', turnId: 't-stale' }]);
    assert.equal(new TurnStore(history).pendingTurns('stale-chat').length, 0);
    assert.equal(new TurnStore(history).pendingTurns('active-chat').length, 1);
    assert.equal(new TurnStore(history).pendingTurns('fresh-chat').length, 1);
    const jsonl = readFileSync(join(root, 'conversations', 'test-agent__stale-chat.jsonl'), 'utf-8');
    assert.match(jsonl, /"status":"orphaned"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runWithTurn emits awaiting_model and aborts its exact controller on inactivity', async () => {
  const root = join(tmpdir(), `chat-turn-timeout-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  const clock = installManualClock(agent);
  let response: Promise<unknown> | null = null;
  let capturedRuntime: TurnRuntimeContext | null = null;

  try {
    (agent as any).run = async (
      _chatId: string,
      _userText: string,
      _media: unknown,
      _onEvent: unknown,
      _modelRuntime: unknown,
      turnRuntime: TurnRuntimeContext,
    ) => {
      capturedRuntime = turnRuntime;
      await new Promise((_resolve, reject) => {
        turnRuntime.signal.addEventListener(
          'abort',
          () => reject(turnRuntime.signal.reason || new Error('aborted')),
          { once: true },
        );
      });
      throw new Error('unreachable');
    };

    const started = await agent.runWithTurn('slow-chat', 'hello', {
      firstTokenTimeoutMs: 10,
      inactivityMs: 30,
      hardDurationMs: 100,
    } as any);
    response = started.response;
    response.catch(() => {});
    await flushMicrotasks();
    assert.ok(capturedRuntime);

    clock.advance(20);
    await flushMicrotasks();
    const waiting = new TurnStore(history).statusForTurn('slow-chat', 't_missing', { active: true });
    assert.equal(waiting, null, 'sanity check exact turn lookup is required');
    const rawBeforeTimeout = readFileSync(join(root, 'conversations', 'test-agent__slow-chat.jsonl'), 'utf-8');
    assert.match(rawBeforeTimeout, /"kind":"status"/);
    assert.match(rawBeforeTimeout, /"status":"awaiting_model"/);

    clock.advance(10);
    await assert.rejects(response, /turn inactivity timeout after 30ms/);
    assert.equal(capturedRuntime!.signal.aborted, true);
    assert.equal((agent as any).activeRuns.has('slow-chat'), false);
    const jsonl = readFileSync(join(root, 'conversations', 'test-agent__slow-chat.jsonl'), 'utf-8');
    assert.match(jsonl, /"status":"timeout"/);
    assert.match(jsonl, /"error_code":"turn_timeout"/);
    assert.match(jsonl, /"first_token_deadline_at"/);
    assert.match(jsonl, /"activity_deadline_at"/);
    assert.match(jsonl, /"hard_deadline_at"/);
  } finally {
    if (capturedRuntime && !capturedRuntime.signal.aborted) {
      capturedRuntime.abortController.abort(new Error('test cleanup'));
    }
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('verified operation activity renews inactivity but duplicate sequence does not', async () => {
  const root = join(tmpdir(), `chat-turn-activity-${process.pid}-${Math.random()}`);
  const { agent, history, toolContext } = makeAgent(root);
  const clock = installManualClock(agent);
  let capturedRuntime: TurnRuntimeContext | null = null;
  let response: Promise<unknown> | null = null;

  try {
    (agent as any).run = async (
      _chatId: string,
      _userText: string,
      _media: unknown,
      _onEvent: unknown,
      _modelRuntime: unknown,
      turnRuntime: TurnRuntimeContext,
    ) => {
      capturedRuntime = turnRuntime;
      await new Promise((_resolve, reject) => {
        turnRuntime.signal.addEventListener('abort', () => reject(turnRuntime.signal.reason), {
          once: true,
        });
      });
    };

    const started = await agent.runWithTurn('activity-chat', 'hello', {
      inactivityMs: 15,
      hardDurationMs: 60,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    response.catch(() => {});
    await flushMicrotasks();
    assert.ok(capturedRuntime);
    assert.equal(toolContext.turnRuntime, null);

    clock.advance(10);
    capturedRuntime!.onOperationActivity({
      source: 'brain_operation', operationId: 'op-long', sequence: 1,
      state: 'running', phase: 'sweep', updatedAt: new Date().toISOString(),
      lastProviderActivityAt: null,
    });
    clock.advance(10);
    await flushMicrotasks();
    const activeStatus = new TurnStore(history).statusForTurn(
      'activity-chat',
      started.turnId,
      { active: true },
    );
    assert.equal(new TurnStore(history).pendingTurns('activity-chat').length, 1);
    assert.equal(new Date(activeStatus!.deadline_at!).getTime(), 1_025);
    assert.equal(new Date(activeStatus!.activity_deadline_at!).getTime(), 1_025);
    assert.equal(new Date(activeStatus!.hard_deadline_at!).getTime(), 1_060);

    capturedRuntime!.onOperationActivity({
      source: 'brain_operation', operationId: 'op-long', sequence: 1,
      state: 'running', phase: 'duplicate', updatedAt: new Date().toISOString(),
      lastProviderActivityAt: null,
    });
    clock.advance(5);
    await assert.rejects(response, /turn inactivity timeout after 15ms/);
    const jsonl = readFileSync(
      join(root, 'conversations', 'test-agent__activity-chat.jsonl'),
      'utf8',
    );
    assert.equal((jsonl.match(/brain_operation_active/g) || []).length, 1);
    assert.match(jsonl, /"error_code":"turn_timeout"/);
    const finalStatus = new TurnStore(history).statusForTurn('activity-chat', started.turnId);
    assert.equal(new Date(finalStatus!.activity_deadline_at!).getTime(), 1_025);
  } finally {
    if (capturedRuntime && !capturedRuntime.signal.aborted) {
      capturedRuntime.abortController.abort(new Error('test cleanup'));
    }
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent turns receive isolated controller, signal, client, and activity lease', async () => {
  const root = join(tmpdir(), `chat-turn-concurrent-${process.pid}-${Math.random()}`);
  const { agent, toolContext } = makeAgent(root);
  const clock = installManualClock(agent);
  const runtimes = new Map<string, TurnRuntimeContext>();
  const responses: Promise<unknown>[] = [];

  try {
    (agent as any).run = async (
      chatId: string,
      _userText: string,
      _media: unknown,
      _onEvent: unknown,
      _modelRuntime: unknown,
      turnRuntime: TurnRuntimeContext,
    ) => {
      runtimes.set(chatId, turnRuntime);
      assert.equal(toolContext.turnRuntime, null);
      await new Promise((_resolve, reject) => {
        turnRuntime.signal.addEventListener('abort', () => reject(turnRuntime.signal.reason), {
          once: true,
        });
      });
    };
    const left = await agent.runWithTurn('chat-left', 'left', {
      inactivityMs: 10, hardDurationMs: 100, firstTokenTimeoutMs: 1_000,
    });
    const right = await agent.runWithTurn('chat-right', 'right', {
      inactivityMs: 10, hardDurationMs: 100, firstTokenTimeoutMs: 1_000,
    });
    responses.push(left.response, right.response);
    left.response.catch(() => {});
    right.response.catch(() => {});
    await flushMicrotasks();

    const leftRuntime = runtimes.get('chat-left')!;
    const rightRuntime = runtimes.get('chat-right')!;
    assert.ok(leftRuntime);
    assert.ok(rightRuntime);
    assert.notEqual(leftRuntime.turnId, rightRuntime.turnId);
    assert.notEqual(leftRuntime.abortController, rightRuntime.abortController);
    assert.notEqual(leftRuntime.signal, rightRuntime.signal);
    assert.notEqual(leftRuntime.brainOperations, rightRuntime.brainOperations);
    assert.equal(toolContext.turnRuntime, null);

    clock.advance(8);
    leftRuntime.onOperationActivity({
      source: 'brain_operation', operationId: 'op-left', sequence: 1,
      state: 'running', phase: 'provider', updatedAt: new Date().toISOString(),
      lastProviderActivityAt: null,
    });
    clock.advance(3);
    await flushMicrotasks();
    assert.equal(rightRuntime.signal.aborted, true);
    assert.equal(leftRuntime.signal.aborted, false);
    await assert.rejects(right.response, /turn inactivity timeout after 10ms/);

    clock.advance(7);
    await assert.rejects(left.response, /turn inactivity timeout after 10ms/);
    assert.equal(leftRuntime.signal.aborted, true);
  } finally {
    await Promise.all(responses.map(promise => promise.catch(() => {})));
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid lease options fail before a pending turn or active-run entry is created', async () => {
  const root = join(tmpdir(), `chat-turn-invalid-lease-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  try {
    await assert.rejects(
      agent.runWithTurn('invalid-lease-chat', 'hello', {
        inactivityMs: 0,
        hardDurationMs: 100,
      }),
      /invalid turn deadline/,
    );
    assert.equal((agent as any).activeRuns.has('invalid-lease-chat'), false);
    assert.equal((agent as any).activeTurnIds.has('invalid-lease-chat'), false);
    assert.equal(new TurnStore(history).pendingTurns('invalid-lease-chat').length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('operator stop cannot be overwritten by a lease deadline while shutdown unwinds', async t => {
  const root = join(tmpdir(), `chat-turn-stop-race-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  const clock = installManualClock(t);
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let response: Promise<unknown> | null = null;
  try {
    (agent as any).run = async (
      _chatId: string,
      _userText: string,
      _media: unknown,
      _onEvent: unknown,
      _modelRuntime: unknown,
      turnRuntime: TurnRuntimeContext,
    ) => {
      await new Promise<void>(resolve => {
        turnRuntime.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      await released;
      return {
        text: 'Stopped after cleanup.', model: 'gpt-5.5', toolCallCount: 0, durationMs: 1,
      };
    };
    const started = await agent.runWithTurn('stop-race-chat', 'hello', {
      inactivityMs: 10,
      hardDurationMs: 100,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    const stopped = agent.stop('stop-race-chat', started.turnId);
    assert.equal(stopped.stopped, true);
    clock.advance(20);
    release();
    await response;
    const status = new TurnStore(history).statusForTurn('stop-race-chat', started.turnId);
    assert.equal(status?.status, 'stopped');
    assert.equal(status?.stop_reason, 'operator_stop');
    assert.equal(status?.error_code, null);
  } finally {
    release?.();
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('immutable hard deadline uses the distinct terminal code', async t => {
  const root = join(tmpdir(), `chat-turn-hard-timeout-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  const clock = installManualClock(t);
  let response: Promise<unknown> | null = null;
  let capturedRuntime: TurnRuntimeContext | null = null;
  try {
    (agent as any).run = async (
      _chatId: string,
      _userText: string,
      _media: unknown,
      _onEvent: unknown,
      _modelRuntime: unknown,
      turnRuntime: TurnRuntimeContext,
    ) => {
      capturedRuntime = turnRuntime;
      await new Promise((_resolve, reject) => {
        turnRuntime.signal.addEventListener('abort', () => reject(turnRuntime.signal.reason), {
          once: true,
        });
      });
    };
    const started = await agent.runWithTurn('hard-timeout-chat', 'hello', {
      inactivityMs: 100,
      hardDurationMs: 30,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    response.catch(() => {});
    await flushMicrotasks();
    clock.advance(30);
    await assert.rejects(response, /turn hard timeout after 30ms/);
    assert.equal(capturedRuntime!.signal.aborted, true);
    const status = new TurnStore(history).statusForTurn('hard-timeout-chat', started.turnId);
    assert.equal(status?.status, 'timeout');
    assert.equal(status?.stop_reason, 'turn_hard_timeout');
    assert.equal(status?.error_code, 'turn_hard_timeout');
  } finally {
    if (capturedRuntime && !capturedRuntime.signal.aborted) {
      capturedRuntime.abortController.abort(new Error('test cleanup'));
    }
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('operator-stopped run that returns normally still writes terminal stopped envelope', async () => {
  const root = join(tmpdir(), `chat-turn-operator-stop-${Date.now()}`);
  const { agent, history } = makeAgent(root);
  let response: Promise<unknown> | null = null;

  try {
    (agent as any).run = async (
      _chatId: string,
      _userText: string,
      _media: unknown,
      _onEvent: unknown,
      _modelRuntime: unknown,
      turnRuntime: TurnRuntimeContext,
    ) => {
      await new Promise<void>((resolve) => {
        turnRuntime.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return {
        text: 'Stopped. (1 tool call, 0.1s)',
        model: 'gpt-5.5',
        toolCallCount: 1,
        durationMs: 100,
      };
    };

    const started = await agent.runWithTurn('stop-chat', 'hello');
    response = started.response;

    const stopped = agent.stop('stop-chat', started.turnId);
    assert.equal(stopped.stopped, true);
    await response;

    const status = new TurnStore(history).statusForTurn('stop-chat', started.turnId);
    assert.equal(status?.status, 'stopped');
    assert.equal(status?.stop_reason, 'operator_stop');
    assert.equal(status?.active, false);
    assert.equal(new TurnStore(history).pendingTurns('stop-chat').length, 0);
  } finally {
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
