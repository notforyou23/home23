import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, inferTextGenerationProvider } from '../../src/agent/text-generation.js';

test('text generation honors explicit agent provider over model-name inference', () => {
  assert.equal(inferTextGenerationProvider('gpt-5.5', 'openai-codex'), 'openai-codex');
  assert.equal(inferTextGenerationProvider('gpt-5.5', 'openai'), 'openai');
});

test('ollama-cloud text generation uses the agent model and API', async () => {
  const prevFetch = globalThis.fetch;
  const prevKey = process.env.OLLAMA_CLOUD_API_KEY;
  process.env.OLLAMA_CLOUD_API_KEY = 'test-ollama-key';

  globalThis.fetch = (async (url, init) => {
    assert.equal(url, 'https://ollama.com/api/chat');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.model, 'kimi-k2.6');
    assert.deepEqual(body.messages.map((m: { role: string }) => m.role), ['system', 'user']);
    return new Response(JSON.stringify({ message: { content: 'compact summary' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const text = await generateText({
      provider: 'ollama-cloud',
      model: 'kimi-k2.6',
      system: 'system prompt',
      prompt: 'summarize',
    });
    assert.equal(text, 'compact summary');
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = prevKey;
  }
});

test('openai gpt-5 text generation uses max_completion_tokens', async () => {
  const prevFetch = globalThis.fetch;
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-openai-key';

  globalThis.fetch = (async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.model, 'gpt-5.4-mini');
    assert.equal(body.max_completion_tokens, 321);
    assert.equal(body.max_tokens, undefined);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'memory json' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const text = await generateText({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      prompt: 'extract memory',
      maxTokens: 321,
    });
    assert.equal(text, 'memory json');
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  }
});

test('openai-codex text generation uses OAuth credentials and SSE output', async () => {
  const prevFetch = globalThis.fetch;
  const encoder = new TextEncoder();

  globalThis.fetch = (async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    const headers = init?.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer access-test');
    assert.equal(headers['chatgpt-account-id'], 'acct-test');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":" memory"}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  try {
    const text = await generateText({
      provider: 'openai-codex',
      model: 'gpt-5.5',
      prompt: 'extract',
      codexCredentialsProvider: async () => ({
        accessToken: 'access-test',
        refreshToken: 'refresh-test',
        expires: Date.now() + 60_000,
        accountId: 'acct-test',
      }),
    });
    assert.equal(text, 'hello memory');
  } finally {
    globalThis.fetch = prevFetch;
  }
});
