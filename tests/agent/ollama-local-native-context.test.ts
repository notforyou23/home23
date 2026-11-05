import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';

test('ollama-local uses native /api/chat with a 32k context so injected memory is not truncated', async () => {
  const root = join(tmpdir(), `ollama-local-native-ctx-${Date.now()}`);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const agent = new AgentLoop({
    apiKey: 'unused',
    model: 'llama3.2:3b',
    provider: 'ollama-local',
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
    toolContext: {} as never,
    workspacePath: join(root, 'workspace'),
  });

  const prevFetch = globalThis.fetch;
  const prevBase = process.env.LOCAL_LLM_BASE_URL;
  process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434/v1';
  const seen: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
    seen.push({ url, body });
    return new Response(JSON.stringify({
      message: { role: 'assistant', content: 'pong' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const { response } = await agent.runWithTurn('chat-native-ctx', 'hello');
    assert.equal((await response).text, 'pong');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'http://127.0.0.1:11434/api/chat');
    assert.equal((seen[0].body.options as { num_ctx?: number } | undefined)?.num_ctx, 32768);
    assert.equal(seen[0].body.stream, false);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevBase === undefined) delete process.env.LOCAL_LLM_BASE_URL;
    else process.env.LOCAL_LLM_BASE_URL = prevBase;
    rmSync(root, { recursive: true, force: true });
  }
});
