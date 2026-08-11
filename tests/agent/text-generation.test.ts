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

test('openai-codex retries once without max_output_tokens when the endpoint rejects the cap (400 and 503)', async () => {
  for (const rejectStatus of [400, 503]) {
    const prevFetch = globalThis.fetch;
    const encoder = new TextEncoder();
    const bodies: Array<Record<string, unknown>> = [];

    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        return new Response('{"detail":"Unsupported parameter: max_output_tokens"}', { status: rejectStatus });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    try {
      const text = await generateText({
        provider: 'openai-codex',
        model: 'gpt-5.6-terra',
        prompt: 'probe',
        maxTokens: 450,
        codexCredentialsProvider: async () => ({
          accessToken: 'access-test', refreshToken: 'refresh-test',
          expires: Date.now() + 60_000, accountId: 'acct-test',
        }),
      });
      assert.equal(text, 'ok', `status ${rejectStatus}: retry produced the text`);
      assert.equal(bodies.length, 2, `status ${rejectStatus}: exactly one retry`);
      assert.equal(bodies[0]!['max_output_tokens'], 450, `status ${rejectStatus}: first attempt sent the cap`);
      assert.ok(!('max_output_tokens' in bodies[1]!), `status ${rejectStatus}: retry dropped the cap`);
    } finally {
      globalThis.fetch = prevFetch;
    }
  }
});

// ─── provider-credentials: read-at-use resolution (the token-rotation fix) ───

import { writeFileSync as writeCredFile, mkdtempSync as mkCredTmp, rmSync as rmCredDir } from 'node:fs';
import { tmpdir as credTmpdir } from 'node:os';
import { join as joinCred } from 'node:path';
import { resolveProviderKey, freshProviderKey, isAuthError, _resetCredentialCache } from '../../src/agent/provider-credentials.js';

test('a managed OAuth token resolves FRESH from secrets.yaml over stale configured/env values', (t) => {
  const dir = mkCredTmp(joinCred(credTmpdir(), 'creds-'));
  t.after(() => { rmCredDir(dir, { recursive: true, force: true }); delete process.env.HOME23_SECRETS_PATH; delete process.env.ANTHROPIC_AUTH_TOKEN; _resetCredentialCache(); });
  const secretsPath = joinCred(dir, 'secrets.yaml');
  writeCredFile(secretsPath, 'providers:\n  anthropic:\n    apiKey: sk-ant-oat01-FRESH\n');
  process.env.HOME23_SECRETS_PATH = secretsPath;
  process.env.ANTHROPIC_AUTH_TOKEN = 'sk-ant-oat01-STALE-ENV';
  _resetCredentialCache();

  assert.equal(resolveProviderKey('anthropic', 'sk-ant-oat01-STALE-CONFIGURED'), 'sk-ant-oat01-FRESH', 'file beats stale configured OAuth token');
  assert.equal(resolveProviderKey('anthropic'), 'sk-ant-oat01-FRESH', 'file beats stale env');

  // Rotation is a file write: force sees the new value with no restart.
  writeCredFile(secretsPath, 'providers:\n  anthropic:\n    apiKey: sk-ant-oat01-ROTATED\n');
  assert.equal(resolveProviderKey('anthropic', undefined, true), 'sk-ant-oat01-ROTATED', 'force re-read sees the rotation immediately');
});

test('a static (non-OAuth) configured key is a deliberate pin and stays respected', (t) => {
  const dir = mkCredTmp(joinCred(credTmpdir(), 'creds-'));
  t.after(() => { rmCredDir(dir, { recursive: true, force: true }); delete process.env.HOME23_SECRETS_PATH; _resetCredentialCache(); });
  const secretsPath = joinCred(dir, 'secrets.yaml');
  writeCredFile(secretsPath, 'providers:\n  anthropic:\n    apiKey: sk-ant-oat01-FRESH\n  openai:\n    apiKey: sk-proj-FILEKEY\n');
  process.env.HOME23_SECRETS_PATH = secretsPath;
  _resetCredentialCache();

  assert.equal(resolveProviderKey('anthropic', 'sk-ant-api03-PINNED'), 'sk-ant-api03-PINNED', 'static anthropic key pinned');
  assert.equal(resolveProviderKey('openai', 'sk-proj-PINNED'), 'sk-proj-PINNED', 'static openai key pinned');
  assert.equal(resolveProviderKey('openai'), 'sk-proj-FILEKEY', 'unpinned falls to file');
});

test('no secrets file → env floor holds; nothing throws (credential-free hosts)', (t) => {
  t.after(() => { delete process.env.HOME23_SECRETS_PATH; delete process.env.XAI_API_KEY; _resetCredentialCache(); });
  process.env.HOME23_SECRETS_PATH = '/nonexistent/secrets.yaml';
  process.env.XAI_API_KEY = 'xai-ENVONLY';
  _resetCredentialCache();
  assert.equal(freshProviderKey('xai'), '', 'missing file reads as empty, never throws');
  assert.equal(resolveProviderKey('xai'), 'xai-ENVONLY', 'env floor serves');
});

test('isAuthError matches the real revocation shapes and nothing else', () => {
  assert.equal(isAuthError({ status: 401 }), true);
  assert.equal(isAuthError(new Error('error=401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}')), true);
  assert.equal(isAuthError(new Error('anthropic HTTP 500: overloaded')), false);
  assert.equal(isAuthError(new Error('ollama-cloud HTTP 429: slow down')), false);
});

test('isAuthError matches OpenAI\'s literal invalid_api_key code, not just the spaced prose', () => {
  // OpenAI returns the machine code with underscores; the prose form appears
  // in other providers' bodies. Both are the same revocation, and missing the
  // underscore form costs the fresh-credential retry that would recover it.
  assert.equal(isAuthError(new Error('{"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}')), true);
  assert.equal(isAuthError(new Error('Invalid API key')), true);
  assert.equal(isAuthError(new Error('invalid-api-key')), true);
});
