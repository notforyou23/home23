import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import type { ToolContext, TurnRuntimeContext } from '../../src/agent/types.js';

function makeAgent(root: string): AgentLoop {
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  return new AgentLoop({
    apiKey: 'test-key',
    model: 'gpt-5.5',
    provider: 'openai',
    registry: {
      getAnthropicTools: () => [],
      getOpenAITools: () => [],
      get: () => undefined,
      execute: async () => ({ content: '' }),
    } as never,
    contextManager: {
      getSystemPrompt: () => 'You are a test agent.',
      getPromptSourceInfo: () => ({ loadedFiles: [] }),
    } as never,
    history,
    toolContext: { brainOperations: { searchContext: async () => ({ results: [] }) }, turnRuntime: null } as unknown as ToolContext,
    workspacePath: join(root, 'workspace'),
  });
}

test('coordination Work on the same chatId does not hold the conversation speaking lock', async () => {
  const root = join(tmpdir(), `fg-speaking-lock-${process.pid}-${Math.random()}`);
  const agent = makeAgent(root);
  const responses: Promise<unknown>[] = [];
  try {
    (agent as AgentLoop & { run: AgentLoop['run'] }).run = async (
      _chatId,
      _userText,
      _media,
      _onEvent,
      _runtime,
      turnRuntime?: TurnRuntimeContext,
    ) => {
      await new Promise((_resolve, reject) => {
        turnRuntime?.signal.addEventListener('abort', () => reject(turnRuntime.signal.reason), { once: true });
      });
      return { text: 'done', model: 'test', toolCallCount: 0, durationMs: 1 };
    };

    const work = await agent.runWithTurn('ios_chat', 'background assignment', {
      inactivityMs: 5_000,
      hardDurationMs: 10_000,
      firstTokenTimeoutMs: 5_000,
      coordinationOrigin: {
        kind: 'coordination',
        workId: 'work_w1',
        attemptId: 'attempt_1',
        leaseId: 'lease_1',
        holderPrincipalId: 'principal_jerry',
        holderInstanceId: 'resident:jerry',
        authorityReference: 'resident:jerry',
        fencingToken: 1,
        channelId: 'channel_1',
        originMessageId: 'message_1',
        roundId: null,
      },
    });
    responses.push(work.response.catch(() => {}));
    await Promise.resolve();

    assert.equal(agent.isRunning('ios_chat'), false, 'Work must not set isRunning(chatId)');
    assert.equal(agent.getActiveRuns().includes('ios_chat'), true, 'Work remains stoppable');

    const speaking = await agent.runWithTurn('ios_chat', 'M2 unrelated question', {
      inactivityMs: 5_000,
      hardDurationMs: 10_000,
      firstTokenTimeoutMs: 5_000,
    });
    responses.push(speaking.response.catch(() => {}));
    await Promise.resolve();

    assert.equal(agent.isRunning('ios_chat'), true, 'foreground speaking turn may start while Work is active');
    const stoppedWork = agent.stop('ios_chat', work.turnId);
    assert.equal(stoppedWork.stopped, true);
    assert.equal(agent.isRunning('ios_chat'), true, 'stopping Work must not clear the speaking lock');
    agent.stop('ios_chat', speaking.turnId);
    assert.equal(agent.isRunning('ios_chat'), false);
  } finally {
    agent.stop('ios_chat');
    await Promise.all(responses);
    rmSync(root, { recursive: true, force: true });
  }
});
