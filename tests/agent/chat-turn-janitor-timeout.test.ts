import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { TurnStore } from '../../src/chat/turn-store.js';
import type { ToolContext, TurnRuntimeContext } from '../../src/agent/types.js';
import { ManualClock, deferred, flushMicrotasks } from '../helpers/manual-clock.js';

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

function installManualClock(agent: AgentLoop): ManualClock {
  const clock = new ManualClock();
  clock.nowMs = 1_000;
  (agent as any).turnTiming = {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  };
  return clock;
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
    (agent as any).activeTurnIds.set('active-chat', new Set(['t-active']));

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

test('same-chat turns retain exact controller ownership and chat-level running state', async () => {
  const root = join(tmpdir(), `chat-turn-same-chat-${process.pid}-${Math.random()}`);
  const { agent } = makeAgent(root);
  const runtimes = new Map<string, TurnRuntimeContext>();
  const responses: Promise<unknown>[] = [];

  try {
    (agent as any).run = async (
      _chatId: string,
      _userText: string,
      _media: unknown,
      _onEvent: unknown,
      _modelRuntime: unknown,
      turnRuntime: TurnRuntimeContext,
    ) => {
      runtimes.set(turnRuntime.turnId, turnRuntime);
      await new Promise((_resolve, reject) => {
        turnRuntime.signal.addEventListener('abort', () => reject(turnRuntime.signal.reason), {
          once: true,
        });
      });
    };

    const parent = await agent.runWithTurn('shared-chat', 'parent', {
      inactivityMs: 1_000, hardDurationMs: 2_000, firstTokenTimeoutMs: 1_500,
    });
    const subagent = await agent.runWithTurn('shared-chat', 'subagent', {
      inactivityMs: 1_000, hardDurationMs: 2_000, firstTokenTimeoutMs: 1_500,
    });
    responses.push(parent.response, subagent.response);
    parent.response.catch(() => {});
    subagent.response.catch(() => {});
    await flushMicrotasks();

    const parentRuntime = runtimes.get(parent.turnId)!;
    const subagentRuntime = runtimes.get(subagent.turnId)!;
    assert.ok(parentRuntime);
    assert.ok(subagentRuntime);
    assert.equal(agent.isRunning('shared-chat'), true);

    const parentStop = agent.stop('shared-chat', parent.turnId);
    assert.equal(parentStop.stopped, true);
    assert.deepEqual(parentStop.turnIds, [parent.turnId]);
    assert.equal(parentRuntime.signal.aborted, true);
    assert.equal(subagentRuntime.signal.aborted, false);
    await assert.rejects(parent.response, /operator_stop/);
    assert.equal(agent.isRunning('shared-chat'), true,
      'the remaining same-chat turn must stay discoverable and stoppable');

    const chatStop = agent.stop('shared-chat');
    assert.equal(chatStop.stopped, true);
    assert.deepEqual(chatStop.turnIds, [subagent.turnId]);
    assert.equal(subagentRuntime.signal.aborted, true);
    await assert.rejects(subagent.response, /operator_stop/);
    assert.equal(agent.isRunning('shared-chat'), false);
  } finally {
    for (const runtime of runtimes.values()) {
      if (!runtime.signal.aborted) runtime.abortController.abort(new Error('test cleanup'));
    }
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

test('oversized first-token deadline is rejected before any timer is scheduled', async () => {
  const root = join(tmpdir(), `chat-turn-oversized-timer-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  let schedulerCalls = 0;
  (agent as any).turnTiming = {
    now: () => 1_000,
    setTimeout: (): never => {
      schedulerCalls++;
      throw new Error('scheduler must not be invoked');
    },
    clearTimeout: () => {},
  };

  try {
    await assert.rejects(
      agent.runWithTurn('oversized-timer-chat', 'hello', {
        inactivityMs: 100,
        hardDurationMs: 200,
        firstTokenTimeoutMs: 2_147_483_648,
      }),
      /invalid turn deadline/,
    );
    assert.equal(schedulerCalls, 0);
    assert.equal(new TurnStore(history).pendingTurns('oversized-timer-chat').length, 0);
    assert.equal(agent.isRunning('oversized-timer-chat'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('timer setup failure leaves no pending turn, active ownership, or armed timer', async () => {
  const root = join(tmpdir(), `chat-turn-timer-setup-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  const timers = new Set<number>();
  let timerCalls = 0;
  let nextId = 1;
  (agent as any).turnTiming = {
    now: () => 1_000,
    setTimeout: (_fn: () => void, _ms: number): number => {
      timerCalls++;
      if (timerCalls === 3) throw new Error('scheduler rejected timer');
      const id = nextId++;
      timers.add(id);
      return id;
    },
    clearTimeout: (id: number): void => { timers.delete(id); },
  };

  try {
    await assert.rejects(
      agent.runWithTurn('timer-setup-chat', 'hello', {
        inactivityMs: 100,
        hardDurationMs: 200,
        firstTokenTimeoutMs: 150,
      }),
      /scheduler rejected timer/,
    );
    assert.equal(new TurnStore(history).pendingTurns('timer-setup-chat').length, 0);
    assert.equal(agent.isRunning('timer-setup-chat'), false);
    assert.equal((agent as any).activeTurnIds.has('timer-setup-chat'), false);
    assert.equal(timers.size, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('operator stop cannot be overwritten by a lease deadline while shutdown unwinds', async () => {
  const root = join(tmpdir(), `chat-turn-stop-race-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  const clock = installManualClock(agent);
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

test('a hard deadline cannot be downgraded by a later operator stop', async () => {
  const root = join(tmpdir(), `chat-turn-deadline-stop-race-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  const clock = installManualClock(agent);
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
        text: 'Late normal result.', model: 'gpt-5.5', toolCallCount: 0, durationMs: 30,
      };
    };

    const started = await agent.runWithTurn('deadline-stop-race-chat', 'hello', {
      inactivityMs: 100,
      hardDurationMs: 30,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    response.catch(() => {});
    await flushMicrotasks();

    clock.advance(30);
    const stopped = agent.stop('deadline-stop-race-chat', started.turnId);
    assert.equal(stopped.stopped, true);
    release();

    await assert.rejects(response, /turn hard timeout after 30ms/);
    const status = new TurnStore(history).statusForTurn(
      'deadline-stop-race-chat', started.turnId,
    );
    assert.equal(status?.status, 'timeout');
    assert.equal(status?.stop_reason, 'turn_hard_timeout');
    assert.equal(status?.error_code, 'turn_hard_timeout');
  } finally {
    release?.();
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenAI transport receives the exact turn cancellation signal', async () => {
  const root = join(tmpdir(), `chat-turn-provider-signal-${process.pid}-${Math.random()}`);
  const { agent } = makeAgent(root);
  const clock = installManualClock(agent);
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const providerStarted = deferred<void>();
  let providerSignal: AbortSignal | null = null;
  let rejectProvider: ((reason?: unknown) => void) | null = null;
  let response: Promise<unknown> | null = null;

  try {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).includes('api.openai.com')) {
        return new Response('{}', { status: 503 });
      }
      providerSignal = init?.signal as AbortSignal;
      providerStarted.resolve();
      return await new Promise<Response>((_resolve, reject) => {
        rejectProvider = reject;
        const rejectForAbort = (): void => reject(providerSignal!.reason);
        if (providerSignal.aborted) rejectForAbort();
        else providerSignal.addEventListener('abort', rejectForAbort, { once: true });
      });
    }) as typeof fetch;

    const started = await agent.runWithTurn('provider-signal-chat', 'hello', {
      inactivityMs: 100,
      hardDurationMs: 30,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    response.catch(() => {});
    await providerStarted.promise;
    assert.ok(providerSignal, 'provider fetch should have started');

    clock.advance(30);

    assert.equal(providerSignal!.aborted, true,
      'the active provider request must abort with the exact turn');
    await assert.rejects(response, /turn hard timeout after 30ms/);
  } finally {
    rejectProvider?.(new Error('test cleanup'));
    if (response) await response.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalApiKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Ollama capability probe and chat transport receive exact turn cancellation', async () => {
  const root = join(tmpdir(), `chat-turn-ollama-signal-${process.pid}-${Math.random()}`);
  const { agent } = makeAgent(root);
  const clock = installManualClock(agent);
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OLLAMA_CLOUD_API_KEY;
  const signals = new Map<string, AbortSignal>();
  const rejecters: Array<(reason?: unknown) => void> = [];
  const chatStarted = deferred<void>();
  let response: Promise<unknown> | null = null;

  try {
    process.env.OLLAMA_CLOUD_API_KEY = 'test-ollama-key';
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('ollama.com/api/')) {
        return new Response('{}', { status: 503 });
      }
      const route = url.endsWith('/api/show') ? 'show' : 'chat';
      const signal = init?.signal as AbortSignal;
      signals.set(route, signal);
      if (route === 'show') {
        return new Response(JSON.stringify({ capabilities: ['tools'] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      chatStarted.resolve();
      return await new Promise<Response>((_resolve, reject) => {
        rejecters.push(reject);
        const rejectForAbort = (): void => reject(signal.reason);
        if (signal.aborted) rejectForAbort();
        else signal.addEventListener('abort', rejectForAbort, { once: true });
      });
    }) as typeof fetch;

    const started = await agent.runWithTurn('ollama-provider-signal-chat', 'hello', {
      modelOverride: {
        model: `ollama-signal-${process.pid}-${Math.random()}`,
        provider: 'ollama-cloud',
      },
      inactivityMs: 100,
      hardDurationMs: 30,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    response.catch(() => {});
    await chatStarted.promise;
    assert.ok(signals.has('show'), 'Ollama capability probe should have started');
    assert.ok(signals.has('chat'), 'Ollama chat request should have started');

    clock.advance(30);

    assert.equal(signals.get('show')?.aborted, true);
    assert.equal(signals.get('chat')?.aborted, true);
    await assert.rejects(response, /turn hard timeout after 30ms/);
  } finally {
    for (const reject of rejecters) reject(new Error('test cleanup'));
    if (response) await response.catch(() => {});
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = originalApiKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test('hard-timed-out run cannot resolve as a normal successful response', async () => {
  const root = join(tmpdir(), `chat-turn-hard-normal-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  const clock = installManualClock(agent);
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
      return {
        text: 'Stopped normally.', model: 'gpt-5.5', toolCallCount: 0, durationMs: 30,
      };
    };

    const started = await agent.runWithTurn('hard-normal-chat', 'hello', {
      inactivityMs: 100,
      hardDurationMs: 30,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    response.catch(() => {});
    await flushMicrotasks();
    clock.advance(30);

    await assert.rejects(response, /turn hard timeout after 30ms/);
    const status = new TurnStore(history).statusForTurn('hard-normal-chat', started.turnId);
    assert.equal(status?.status, 'timeout');
    assert.equal(status?.stop_reason, 'turn_hard_timeout');
  } finally {
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('completion enforces the immutable hard deadline when timer delivery is delayed', async () => {
  const root = join(tmpdir(), `chat-turn-delayed-hard-timer-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  const clock = installManualClock(agent);
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let response: Promise<unknown> | null = null;

  try {
    (agent as any).run = async () => {
      await released;
      return {
        text: 'Late success.', model: 'gpt-5.5', toolCallCount: 0, durationMs: 31,
      };
    };

    const started = await agent.runWithTurn('delayed-hard-timer-chat', 'hello', {
      inactivityMs: 100,
      hardDurationMs: 30,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    response.catch(() => {});
    await flushMicrotasks();

    // Move beyond the immutable deadline without delivering queued timers.
    clock.nowMs += 31;
    release();

    await assert.rejects(response, /turn hard timeout after 30ms/);
    const status = new TurnStore(history).statusForTurn(
      'delayed-hard-timer-chat', started.turnId,
    );
    assert.equal(status?.status, 'timeout');
    assert.equal(status?.stop_reason, 'turn_hard_timeout');
    assert.equal(status?.error_code, 'turn_hard_timeout');
  } finally {
    release?.();
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('completion enforces the renewed inactivity deadline when timer delivery is delayed', async () => {
  const root = join(tmpdir(), `chat-turn-delayed-activity-timer-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  const clock = installManualClock(agent);
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
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
      await released;
      return {
        text: 'Late success.', model: 'gpt-5.5', toolCallCount: 0, durationMs: 41,
      };
    };

    const started = await agent.runWithTurn('delayed-activity-timer-chat', 'hello', {
      inactivityMs: 30,
      hardDurationMs: 100,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    response.catch(() => {});
    await flushMicrotasks();
    assert.ok(capturedRuntime);

    // Renew once, then move beyond only the renewed inactivity deadline without
    // delivering either the cleared original timer or its replacement.
    clock.nowMs += 10;
    capturedRuntime!.onOperationActivity({
      source: 'brain_operation',
      operationId: 'op-renewed',
      sequence: 1,
      state: 'running',
      phase: 'provider',
      updatedAt: new Date().toISOString(),
      lastProviderActivityAt: null,
    });
    assert.equal(capturedRuntime!.signal.aborted, false);
    clock.nowMs += 31;
    release();

    await assert.rejects(response, /turn inactivity timeout after 30ms/);
    const status = new TurnStore(history).statusForTurn(
      'delayed-activity-timer-chat', started.turnId,
    );
    assert.equal(status?.status, 'timeout');
    assert.equal(status?.stop_reason, 'turn_timeout');
    assert.equal(status?.error_code, 'turn_timeout');
    assert.equal(new Date(status!.activity_deadline_at!).getTime(), 1_040);
    assert.equal(new Date(status!.hard_deadline_at!).getTime(), 1_100);
  } finally {
    release?.();
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('immutable hard deadline uses the distinct terminal code', async () => {
  const root = join(tmpdir(), `chat-turn-hard-timeout-${process.pid}-${Math.random()}`);
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

test('pending Codex credentials receive the exact turn signal and settle on hard cancellation', async () => {
  const root = join(tmpdir(), `chat-turn-codex-credentials-signal-${process.pid}-${Math.random()}`);
  const { agent } = makeAgent(root);
  const clock = installManualClock(agent);
  const originalFetch = globalThis.fetch;
  const credentialsStarted = deferred<void>();
  let credentialCalls = 0;
  let credentialSignal: AbortSignal | undefined;
  let finishCredentials: (() => void) | null = null;
  let response: Promise<unknown> | null = null;
  let responseSettled = false;

  try {
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    (agent as any).codexCredentialsProvider = (signal?: AbortSignal) => {
      credentialCalls++;
      credentialSignal = signal;
      credentialsStarted.resolve();
      return new Promise((resolve, reject) => {
        finishCredentials = () => resolve(null);
        if (!signal) return;
        const rejectForAbort = (): void => reject(signal.reason);
        if (signal.aborted) rejectForAbort();
        else signal.addEventListener('abort', rejectForAbort, { once: true });
      });
    };

    const started = await agent.runWithTurn('codex-credentials-signal-chat', 'hello', {
      modelOverride: { model: 'gpt-5.5', provider: 'openai-codex' },
      inactivityMs: 100,
      hardDurationMs: 30,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    response.then(
      () => { responseSettled = true; },
      () => { responseSettled = true; },
    );
    response.catch(() => {});
    await credentialsStarted.promise;
    assert.equal(credentialCalls, 1);

    const controller = (agent as any).activeRuns
      .get('codex-credentials-signal-chat')?.get(started.turnId) as AbortController | undefined;
    assert.ok(controller);
    clock.advance(30);
    for (let i = 0; i < 20 && !responseSettled; i++) await Promise.resolve();

    assert.equal(credentialSignal, controller.signal);
    assert.equal(credentialSignal?.aborted, true);
    assert.equal(responseSettled, true, 'hard cancellation must not wait for credential refresh');
    await assert.rejects(response, /turn hard timeout after 30ms/);
  } finally {
    finishCredentials?.();
    if (response) await response.catch(() => {});
    globalThis.fetch = originalFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('pending compaction receives the exact turn signal and settles on hard cancellation', async () => {
  const root = join(tmpdir(), `chat-turn-compaction-signal-${process.pid}-${Math.random()}`);
  const { agent } = makeAgent(root);
  const clock = installManualClock(agent);
  let compactCalls = 0;
  let compactSignal: AbortSignal | undefined;
  const compactionStarted = deferred<void>();
  let finishCompaction: (() => void) | null = null;
  let response: Promise<unknown> | null = null;
  let responseSettled = false;

  (agent as any).compaction = {
    needsCompaction: () => true,
    compact: (
      _chatId: string,
      _records: unknown[],
      _model: string,
      _provider: string,
      signal?: AbortSignal,
    ) => {
      compactCalls++;
      compactSignal = signal;
      compactionStarted.resolve();
      return new Promise((resolve, reject) => {
        finishCompaction = () => resolve({
          messages: [],
          result: {
            compacted: false,
            reason: 'review cleanup',
            tokensBefore: 0,
            tokensAfter: 0,
          },
        });
        if (!signal) return;
        const rejectForAbort = (): void => reject(signal.reason);
        if (signal.aborted) rejectForAbort();
        else signal.addEventListener('abort', rejectForAbort, { once: true });
      });
    },
  };

  try {
    const started = await agent.runWithTurn('compaction-signal-chat', 'hello', {
      inactivityMs: 100,
      hardDurationMs: 30,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    response.then(
      () => { responseSettled = true; },
      () => { responseSettled = true; },
    );
    response.catch(() => {});
    await compactionStarted.promise;
    assert.equal(compactCalls, 1);

    const controller = (agent as any).activeRuns
      .get('compaction-signal-chat')?.get(started.turnId) as AbortController | undefined;
    assert.ok(controller);
    clock.advance(30);
    for (let i = 0; i < 20 && !responseSettled; i++) await Promise.resolve();

    assert.equal(compactSignal, controller.signal);
    assert.equal(compactSignal?.aborted, true);
    assert.equal(responseSettled, true, 'hard cancellation must not wait for compaction');
    await assert.rejects(response, /turn hard timeout after 30ms/);
  } finally {
    finishCompaction?.();
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
