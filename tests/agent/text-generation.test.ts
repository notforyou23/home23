import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, inferTextGenerationProvider } from '../../src/agent/text-generation.js';

test('text generation honors explicit agent provider over model-name inference', () => {
  assert.equal(inferTextGenerationProvider('gpt-5.5', 'openai-codex'), 'openai-codex');
  assert.equal(inferTextGenerationProvider('gpt-5.5', 'openai'), 'openai');
});

test('Anthropic-compatible text generation combines the exact caller cancellation signal', async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const client = {
    messages: {
      create: async (_params: unknown, options?: { signal?: AbortSignal }) => {
        requestSignal = options?.signal;
        return { content: [{ type: 'text', text: 'summary' }] };
      },
    },
  };

  const text = await generateText({
    provider: 'anthropic',
    model: 'claude-test',
    client: client as never,
    prompt: 'summarize',
    signal: controller.signal,
  });
  controller.abort(new Error('turn cancelled'));

  assert.equal(text, 'summary');
  assert.equal(requestSignal?.aborted, true);
});

test('ollama-cloud text generation uses the agent model and API', async () => {
  const prevFetch = globalThis.fetch;
  const prevKey = process.env.OLLAMA_CLOUD_API_KEY;
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  process.env.OLLAMA_CLOUD_API_KEY = 'test-ollama-key';

  globalThis.fetch = (async (url, init) => {
    assert.equal(url, 'https://ollama.com/api/chat');
    requestSignal = init?.signal as AbortSignal;
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
      signal: controller.signal,
    });
    controller.abort(new Error('turn cancelled'));
    assert.equal(text, 'compact summary');
    assert.equal(requestSignal?.aborted, true);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = prevKey;
  }
});

test('openai gpt-5 text generation uses max_completion_tokens', async () => {
  const prevFetch = globalThis.fetch;
  const prevKey = process.env.OPENAI_API_KEY;
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  process.env.OPENAI_API_KEY = 'test-openai-key';

  globalThis.fetch = (async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    requestSignal = init?.signal as AbortSignal;
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
      signal: controller.signal,
    });
    controller.abort(new Error('turn cancelled'));
    assert.equal(text, 'memory json');
    assert.equal(requestSignal?.aborted, true);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  }
});

test('openai-codex text generation uses OAuth credentials and SSE output', async () => {
  const prevFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  const controller = new AbortController();
  let credentialSignal: AbortSignal | undefined;
  let requestSignal: AbortSignal | undefined;

  globalThis.fetch = (async (url, init) => {
    assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
    requestSignal = init?.signal as AbortSignal;
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
      signal: controller.signal,
      codexCredentialsProvider: async (signal?: AbortSignal) => {
        credentialSignal = signal;
        return {
          accessToken: 'access-test',
          refreshToken: 'refresh-test',
          expires: Date.now() + 60_000,
          accountId: 'acct-test',
        };
      },
    });
    controller.abort(new Error('turn cancelled'));
    assert.equal(text, 'hello memory');
    assert.equal(credentialSignal, controller.signal);
    assert.equal(requestSignal?.aborted, true);
  } finally {
    globalThis.fetch = prevFetch;
  }
});
