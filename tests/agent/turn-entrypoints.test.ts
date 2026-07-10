import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTrackedTurn } from '../../src/agent/turn-entrypoint.js';

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
