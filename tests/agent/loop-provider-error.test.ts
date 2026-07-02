import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';

function makeAgent(root: string, opts: { model?: string; provider?: string } = {}): AgentLoop {
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
  return new AgentLoop({
    apiKey: 'test-key',
    model: opts.model ?? 'gpt-5.5',
    provider: opts.provider ?? 'openai',
    registry: registry as any,
    contextManager: contextManager as any,
    history,
    toolContext: {} as any,
    workspacePath: join(root, 'workspace'),
  });
}

test('non-Claude provider errors produce terminal error envelopes, not success-looking completions', async () => {
  const root = join(tmpdir(), `loop-provider-error-${Date.now()}`);
  const prevFetch = globalThis.fetch;
  const prevOpenAIKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';
  globalThis.fetch = (async () => new Response('bad model', { status: 400 })) as typeof fetch;

  try {
    const agent = makeAgent(root);
    const { response } = await agent.runWithTurn('chat-1', 'hello');
    await assert.rejects(response, /Error calling gpt-5\.5: openai HTTP 400/);

    const jsonl = readFileSync(join(root, 'conversations', 'test-agent__chat-1.jsonl'), 'utf-8');
    assert.match(jsonl, /"provider":"openai"/);
    assert.match(jsonl, /"status":"error"/);
    assert.match(jsonl, /"last_seq":0/);
    assert.match(jsonl, /"error_code":"provider_error"/);
    assert.match(jsonl, /"error_message":"Error calling gpt-5\.5: openai HTTP 400/);
    assert.match(jsonl, /Error calling gpt-5\.5/);
    assert.doesNotMatch(jsonl, /"status":"complete"/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenAIKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Anthropic SDK errors produce terminal error envelopes', async () => {
  const root = join(tmpdir(), `loop-provider-anthropic-error-${Date.now()}`);

  try {
    const agent = makeAgent(root, { model: 'claude-sonnet-test', provider: 'anthropic' });
    (agent as any).client = {
      messages: {
        stream: () => {
          throw new Error('anthropic HTTP 529 overloaded');
        },
      },
    };

    const { response } = await agent.runWithTurn('chat-anthropic', 'hello');
    await assert.rejects(response, /anthropic HTTP 529 overloaded/);

    const jsonl = readFileSync(join(root, 'conversations', 'test-agent__chat-anthropic.jsonl'), 'utf-8');
    assert.match(jsonl, /"provider":"anthropic"/);
    assert.match(jsonl, /"model":"claude-sonnet-test"/);
    assert.match(jsonl, /"status":"error"/);
    assert.match(jsonl, /"error_code":"provider_error"/);
    assert.match(jsonl, /"error_message":"anthropic HTTP 529 overloaded"/);
    assert.doesNotMatch(jsonl, /"status":"complete"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenAI-Codex provider errors produce terminal error envelopes without real credentials', async () => {
  const root = join(tmpdir(), `loop-provider-codex-error-${Date.now()}`);
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('codex down', { status: 502 })) as typeof fetch;

  try {
    const agent = makeAgent(root, { model: 'gpt-5.5', provider: 'openai-codex' });
    (agent as any).codexCredentialsProvider = async () => ({
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expires: Date.now() + 60 * 60 * 1000,
      accountId: 'acct-test',
    });

    const { response } = await agent.runWithTurn('chat-codex', 'hello');
    await assert.rejects(response, /Error calling gpt-5\.5: codex HTTP 502: codex down/);

    const jsonl = readFileSync(join(root, 'conversations', 'test-agent__chat-codex.jsonl'), 'utf-8');
    assert.match(jsonl, /"provider":"openai-codex"/);
    assert.match(jsonl, /"status":"error"/);
    assert.match(jsonl, /"error_code":"provider_error"/);
    assert.match(jsonl, /"error_message":"Error calling gpt-5\.5: codex HTTP 502: codex down"/);
    assert.doesNotMatch(jsonl, /"status":"complete"/);
  } finally {
    globalThis.fetch = prevFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown fallback provider errors produce terminal error envelopes', async () => {
  const root = join(tmpdir(), `loop-provider-unknown-error-${Date.now()}`);

  try {
    const agent = makeAgent(root, { model: 'local-experimental', provider: 'unknown-provider' });
    const { response } = await agent.runWithTurn('chat-unknown', 'hello');
    await assert.rejects(response, /Error calling local-experimental: Unknown provider: unknown-provider/);

    const jsonl = readFileSync(join(root, 'conversations', 'test-agent__chat-unknown.jsonl'), 'utf-8');
    assert.match(jsonl, /"provider":"unknown-provider"/);
    assert.match(jsonl, /"status":"error"/);
    assert.match(jsonl, /"error_code":"provider_error"/);
    assert.match(jsonl, /"error_message":"Error calling local-experimental: Unknown provider: unknown-provider"/);
    assert.doesNotMatch(jsonl, /"status":"complete"/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AgentLoop treats provider-prefixed Claude Opus 4.8 as sampling-deprecated', () => {
  const source = readFileSync(join(process.cwd(), 'src/agent/loop.ts'), 'utf-8');

  assert.match(source, /function isAnthropicSamplingDeprecatedModel/);
  assert.match(source, /\(\?:\[\^\/\]\+\\\/\)\?claude-opus-4-8/);
});
