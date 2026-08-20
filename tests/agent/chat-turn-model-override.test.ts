import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
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
    model: 'gpt-default',
    provider: 'openai',
    registry: registry as any,
    contextManager: contextManager as any,
    history,
    toolContext: {} as any,
    workspacePath: join(root, 'workspace'),
  });
  return { agent, history };
}

test('per-turn model override does not mutate configured default while the turn is active', async () => {
  const root = join(tmpdir(), `chat-turn-model-override-${Date.now()}`);
  const { agent, history } = makeAgent(root);
  let releaseRun: (() => void) | null = null;
  let response: Promise<unknown> | null = null;

  try {
    (agent as any).run = async () => {
      await new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      return {
        text: 'done',
        model: 'gpt-selected',
        toolCallCount: 0,
        durationMs: 1,
      };
    };

    const started = await agent.runWithTurn('override-chat', 'hello', {
      modelOverride: { model: 'gpt-selected', provider: 'openai' },
    });
    response = started.response;

    assert.equal(agent.getModel(), 'gpt-default');
    assert.equal(agent.getProvider(), 'openai');

    const activeStatus = new TurnStore(history).statusForTurn('override-chat', started.turnId, {
      active: true,
      defaultModel: agent.getModel(),
      defaultProvider: agent.getProvider(),
    });
    assert.equal(activeStatus?.model, 'gpt-selected');
    assert.equal(activeStatus?.runtime_model.model, 'gpt-selected');
    assert.equal(activeStatus?.configured_default.model, 'gpt-default');

    releaseRun?.();
    const result = await response;
    assert.equal((result as { model?: string }).model, 'gpt-selected');
    assert.equal(agent.getModel(), 'gpt-default');
    assert.equal(agent.getProvider(), 'openai');
  } finally {
    releaseRun?.();
    if (response) await response.catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
});

test('AgentLoop Codex OAuth GPT-5.6 turn sends Responses reasoning effort', async () => {
  const root = join(tmpdir(), `chat-turn-reasoning-effort-${Date.now()}`);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const registry = {
    getAnthropicTools: () => [],
    getOpenAITools: () => [],
    get: () => undefined,
    execute: async () => ({ content: '' }),
  };
  const agent = new AgentLoop({
    apiKey: '',
    model: 'gpt-5.6-terra',
    provider: 'openai-codex',
    registry: registry as any,
    contextManager: {
      getSystemPrompt: () => 'You are a test agent.',
      getPromptSourceInfo: () => ({ loadedFiles: [] }),
    } as any,
    history,
    toolContext: {} as any,
    workspacePath: join(root, 'workspace'),
  });
  const previousFetch = globalThis.fetch;
  let body: Record<string, unknown> | undefined;

  globalThis.fetch = (async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  try {
    (agent as any).codexCredentialsProvider = async () => ({
      accessToken: 'access-test',
      refreshToken: 'refresh-test',
      expires: Date.now() + 60_000,
      accountId: 'acct-test',
    });
    const started = await agent.runWithTurn('reasoning-chat', 'hello', { effort: 'xhigh' });
    await started.response;
    assert.deepEqual(body?.reasoning, { effort: 'xhigh' });
    assert.equal(Object.hasOwn(body ?? {}, 'reasoning_effort'), false);
  } finally {
    globalThis.fetch = previousFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
