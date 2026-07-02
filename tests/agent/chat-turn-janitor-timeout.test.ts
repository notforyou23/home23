import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { TurnStore } from '../../src/chat/turn-store.js';

function makeAgent(root: string): { agent: AgentLoop; history: ConversationHistory } {
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
  const agent = new AgentLoop({
    apiKey: 'test-key',
    model: 'gpt-5.5',
    provider: 'openai',
    registry: registry as any,
    contextManager: contextManager as any,
    history,
    toolContext: {} as any,
    workspacePath: join(root, 'workspace'),
  });
  return { agent, history };
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

test('runWithTurn emits awaiting_model before first token and writes terminal timeout envelope', async () => {
  const root = join(tmpdir(), `chat-turn-timeout-${Date.now()}`);
  const { agent, history } = makeAgent(root);
  let response: Promise<unknown> | null = null;

  try {
    (agent as any).run = async (chatId: string) => {
      const ac = new AbortController();
      (agent as any).activeRuns.set(chatId, ac);
      await new Promise((_resolve, reject) => {
        ac.signal.addEventListener('abort', () => reject(ac.signal.reason || new Error('aborted')));
      });
      throw new Error('unreachable');
    };

    const started = await agent.runWithTurn('slow-chat', 'hello', {
      firstTokenTimeoutMs: 10,
      maxDurationMs: 30,
    } as any);
    response = started.response;

    await new Promise((resolve) => setTimeout(resolve, 20));
    const waiting = new TurnStore(history).statusForTurn('slow-chat', 't_missing', { active: true });
    assert.equal(waiting, null, 'sanity check exact turn lookup is required');
    const rawBeforeTimeout = readFileSync(join(root, 'conversations', 'test-agent__slow-chat.jsonl'), 'utf-8');
    assert.match(rawBeforeTimeout, /"kind":"status"/);
    assert.match(rawBeforeTimeout, /"status":"awaiting_model"/);

    await assert.rejects(response, /turn timeout after 30ms/);
    const jsonl = readFileSync(join(root, 'conversations', 'test-agent__slow-chat.jsonl'), 'utf-8');
    assert.match(jsonl, /"status":"timeout"/);
    assert.match(jsonl, /"error_code":"turn_timeout"/);
    assert.match(jsonl, /"first_token_deadline_at"/);
  } finally {
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('operator-stopped run that returns normally still writes terminal stopped envelope', async () => {
  const root = join(tmpdir(), `chat-turn-operator-stop-${Date.now()}`);
  const { agent, history } = makeAgent(root);
  let response: Promise<unknown> | null = null;

  try {
    (agent as any).run = async (chatId: string) => {
      const ac = new AbortController();
      (agent as any).activeRuns.set(chatId, ac);
      await new Promise<void>((resolve) => {
        ac.signal.addEventListener('abort', () => resolve(), { once: true });
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
