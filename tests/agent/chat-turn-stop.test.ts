import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTurnStopHandler } from '../../src/routes/chat-turn.js';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { TurnStore } from '../../src/chat/turn-store.js';
import { turnBus } from '../../src/chat/turn-bus.js';
import type { ToolContext, TurnRuntimeContext } from '../../src/agent/types.js';
import { ManualClock, deferred, flushMicrotasks } from '../helpers/manual-clock.js';

function makeHistory(records: Record<string, unknown[]> = {}) {
  return {
    loadRaw(chatId: string) {
      return records[chatId] ?? [];
    },
    appendRecord(chatId: string, record: unknown) {
      if (!records[chatId]) records[chatId] = [];
      records[chatId]!.push(record as Record<string, unknown>);
    },
  };
}

function makeAgent(root: string): { agent: AgentLoop; history: ConversationHistory } {
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const brainOperations = {
    withActivityHandler() { return brainOperations; },
  };
  const agent = new AgentLoop({
    apiKey: 'test-key',
    model: 'gpt-5.5',
    provider: 'openai',
    registry: {
      getAnthropicTools: () => [],
      getOpenAITools: () => [],
      get: () => undefined,
      execute: async () => ({ content: '' }),
    } as any,
    contextManager: {
      getSystemPrompt: () => 'You are a test agent.',
      getPromptSourceInfo: () => ({ loadedFiles: [] }),
    } as any,
    history,
    toolContext: {
      brainOperations,
      turnRuntime: null,
    } as unknown as ToolContext,
    workspacePath: join(root, 'workspace'),
  });
  return { agent, history };
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

async function postJson(app: express.Express, path: string, body: unknown): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      try {
        const port = (server.address() as any).port;
        const res = await fetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        server.close();
        resolve({ status: res.status, body: json });
      } catch (err) {
        server.close();
        reject(err);
      }
    });
  });
}

test('stop-turn honors turn_id and writes terminal stopped envelope', async () => {
  const records = {
    c1: [
      {
        type: 'turn',
        turn_id: 't1',
        chat_id: 'c1',
        status: 'pending',
        role: 'assistant',
        started_at: '2026-06-26T14:28:00.000Z',
      },
      {
        type: 'event',
        turn_id: 't1',
        seq: 2,
        ts: '2026-06-26T14:28:02.000Z',
        kind: 'response_chunk',
        data: { type: 'response_chunk', chunk: 'partial' },
      },
    ],
  };
  const stoppedArgs: any[] = [];
  const app = express();
  app.use(express.json());
  app.post('/api/chat/stop-turn', createTurnStopHandler({
    agentName: 'jerry',
    agent: {
      stop: (chatId: string, turnId?: string) => {
        stoppedArgs.push([chatId, turnId]);
        return { stopped: true, chatIds: [chatId], turnId };
      },
    } as any,
    history: makeHistory(records) as any,
  }));

  const res = await postJson(app, '/api/chat/stop-turn', { chatId: 'c1', turn_id: 't1' });

  assert.equal(res.status, 200);
  assert.equal(res.body.stopped, true);
  assert.deepEqual(stoppedArgs, [['c1', 't1']]);
  const final = records.c1[records.c1.length - 1] as any;
  assert.equal(final.type, 'turn');
  assert.equal(final.turn_id, 't1');
  assert.equal(final.status, 'stopped');
  assert.equal(final.last_seq, 2);
  assert.equal(final.stop_reason, 'operator_stop');
});

test('stop-turn rejects unknown requested turn_id without stopping chat', async () => {
  const records = {
    c1: [
      {
        type: 'turn',
        turn_id: 't1',
        chat_id: 'c1',
        status: 'pending',
        role: 'assistant',
        started_at: '2026-06-26T14:28:00.000Z',
      },
    ],
  };
  let stopCalls = 0;
  const app = express();
  app.use(express.json());
  app.post('/api/chat/stop-turn', createTurnStopHandler({
    agentName: 'jerry',
    agent: {
      stop: () => {
        stopCalls++;
        return { stopped: true, chatIds: ['c1'] };
      },
    } as any,
    history: makeHistory(records) as any,
  }));

  const res = await postJson(app, '/api/chat/stop-turn', { chatId: 'c1', turn_id: 'missing' });

  assert.equal(res.status, 404);
  assert.equal(stopCalls, 0);
  assert.equal(records.c1.length, 1);
});

test('stop-turn rejects mismatched active turn without terminalizing requested pending turn', async () => {
  const records = {
    c1: [
      {
        type: 'turn',
        turn_id: 't1',
        chat_id: 'c1',
        status: 'pending',
        role: 'assistant',
        started_at: '2026-06-26T14:28:00.000Z',
      },
    ],
  };
  const app = express();
  app.use(express.json());
  app.post('/api/chat/stop-turn', createTurnStopHandler({
    agentName: 'jerry',
    agent: {
      stop: (_chatId: string, _turnId?: string) => {
        return { stopped: false, chatIds: [], activeTurnId: 't2' };
      },
    } as any,
    history: makeHistory(records) as any,
  }));

  const res = await postJson(app, '/api/chat/stop-turn', { chatId: 'c1', turn_id: 't1' });

  assert.equal(res.status, 409);
  assert.equal(res.body.activeTurnId, 't2');
  assert.equal(records.c1.length, 1, 'requested turn must remain pending until a truthful recovery decision');
});

test('stop-turn publishes the timeout that already won while the run is still unwinding', async () => {
  const root = join(tmpdir(), `chat-turn-stop-timeout-race-${process.pid}-${Math.random()}`);
  const { agent, history } = makeAgent(root);
  const clock = installManualClock(agent);
  const unwind = deferred<void>();
  const publicRecords: Array<Record<string, unknown>> = [];
  let response: Promise<unknown> | null = null;
  let unsubscribe = (): void => {};

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
        const resolveForAbort = (): void => resolve();
        if (turnRuntime.signal.aborted) resolveForAbort();
        else turnRuntime.signal.addEventListener('abort', resolveForAbort, { once: true });
      });
      await unwind.promise;
      return {
        text: 'Late normal result.', model: 'gpt-5.5', toolCallCount: 0, durationMs: 30,
      };
    };

    const started = await agent.runWithTurn('timeout-race-chat', 'hello', {
      inactivityMs: 100,
      hardDurationMs: 30,
      firstTokenTimeoutMs: 1_000,
    });
    response = started.response;
    response.catch(() => {});
    await flushMicrotasks();
    unsubscribe = turnBus.subscribe('timeout-race-chat', started.turnId, record => {
      publicRecords.push(record as unknown as Record<string, unknown>);
    });

    clock.advance(30);
    await flushMicrotasks();
    const store = new TurnStore(history);
    assert.equal(store.finalEnvelope('timeout-race-chat', started.turnId), null,
      'the run must still be between timeout selection and eventual persistence');

    const app = express();
    app.use(express.json());
    app.post('/api/chat/stop-turn', createTurnStopHandler({
      agentName: 'jerry',
      agent,
      history,
    }));
    const res = await postJson(app, '/api/chat/stop-turn', {
      chatId: 'timeout-race-chat',
      turn_id: started.turnId,
    });

    assert.equal(res.status, 200);
    const immediate = publicRecords.find(record => record.type === 'turn') as any;
    assert.ok(immediate, 'the route must publish an immediate terminal envelope');
    assert.equal(immediate.status, 'timeout');
    assert.equal(immediate.stop_reason, 'turn_hard_timeout');
    assert.equal(immediate.error_code, 'turn_hard_timeout');

    unwind.resolve();
    await assert.rejects(response, /turn hard timeout after 30ms/);
    const eventual = store.finalEnvelope('timeout-race-chat', started.turnId);
    assert.equal(eventual?.status, immediate.status);
    assert.equal(eventual?.stop_reason, immediate.stop_reason);
    assert.equal(eventual?.error_code, immediate.error_code);
    const turnRecords = history.loadRaw('timeout-race-chat')
      .filter((record: any) => record.type === 'turn'
        && record.turn_id === started.turnId && record.status !== 'pending');
    assert.equal(turnRecords.length, 1, 'stop route and loop must share one terminal envelope');
    const eventsAfterTerminal = history.loadRaw('timeout-race-chat')
      .filter((record: any) => record.type === 'event'
        && record.turn_id === started.turnId && record.seq > immediate.last_seq);
    assert.equal(eventsAfterTerminal.length, 0);
  } finally {
    unsubscribe();
    unwind.resolve();
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});
