import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';

function makeAgent(root: string): AgentLoop {
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
  return new AgentLoop({
    apiKey: 'test-key',
    model: 'gpt-5.5',
    provider: 'openai',
    registry: registry as any,
    contextManager: contextManager as any,
    history,
    toolContext: {} as any,
    workspacePath: join(root, 'workspace'),
  });
}

test('non-Claude provider errors are visible turn events, not silent complete turns', async () => {
  const root = join(tmpdir(), `loop-provider-error-${Date.now()}`);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const prevFetch = globalThis.fetch;
  const prevOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  globalThis.fetch = (async () => new Response('bad model', { status: 400 })) as typeof fetch;

  try {
    const agent = makeAgent(root);
    const { response } = await agent.runWithTurn('chat-1', 'hello');
    const result = await response;

    assert.match(result.text, /Error calling gpt-5\.5: openai HTTP 400/);
    const jsonl = readFileSync(join(root, 'conversations', 'test-agent__chat-1.jsonl'), 'utf-8');
    assert.match(jsonl, /"kind":"response_chunk"/);
    assert.match(jsonl, /"last_seq":1/);
    assert.match(jsonl, /Error calling gpt-5\.5/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAIKey;
    rmSync(root, { recursive: true, force: true });
  }
});
