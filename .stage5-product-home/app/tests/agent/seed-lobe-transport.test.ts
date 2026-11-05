import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeedLobeTransport } from '../../src/substrate/lobe-transport.js';
import { _resetCredentialCache } from '../../src/agent/provider-credentials.js';

function home(t: { after(fn: () => void): void }, providers: Record<string, unknown>, secrets: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'home23-seed-provider-'));
  mkdirSync(join(root, 'config'));
  const previousRoot = process.env.HOME23_ROOT;
  const previousSecrets = process.env.HOME23_SECRETS_PATH;
  const previousFetch = globalThis.fetch;
  process.env.HOME23_ROOT = root;
  process.env.HOME23_SECRETS_PATH = join(root, 'config', 'secrets.yaml');
  writeFileSync(join(root, 'config', 'home.yaml'), JSON.stringify({ providers }));
  writeFileSync(join(root, 'config', 'secrets.yaml'), JSON.stringify({ providers: secrets }));
  _resetCredentialCache();
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousRoot === undefined) delete process.env.HOME23_ROOT;
    else process.env.HOME23_ROOT = previousRoot;
    if (previousSecrets === undefined) delete process.env.HOME23_SECRETS_PATH;
    else process.env.HOME23_SECRETS_PATH = previousSecrets;
    _resetCredentialCache();
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function anthropicResponse() {
  return new Response(JSON.stringify({
    id: 'msg_fixture', type: 'message', role: 'assistant', model: 'MiniMax-M3',
    content: [{ type: 'text', text: '{"estimates":[]}' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 19, output_tokens: 8 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('a local Seed lobe uses the selected keyless Ollama endpoint and records actual usage', async (t) => {
  home(t, { 'ollama-local': { baseUrl: 'http://local-llm.invalid:11434/gateway/v1/' } });
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    const request = new Request(url, init);
    assert.equal(request.url, 'http://local-llm.invalid:11434/gateway/api/chat');
    assert.equal(request.headers.get('authorization'), null);
    const body = await request.json() as { model: string; messages: Array<{ content: string }>; stream: boolean };
    assert.equal(body.model, 'gpt-local');
    assert.equal(body.messages[0]?.content, 'Consider my garden.');
    assert.equal(body.stream, false);
    return new Response(JSON.stringify({ message: { content: '{"estimates":[]}' }, prompt_eval_count: 31, eval_count: 12 }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await createSeedLobeTransport({ provider: 'ollama-local', model: 'gpt-local' })('Consider my garden.');
  assert.equal(calls, 1);
  assert.equal(result.modelReceipt.provider, 'ollama-local', 'the explicit selected provider wins over model inference');
  assert.equal(result.modelReceipt.tokensIn, 31);
  assert.equal(result.modelReceipt.tokensOut, 12);
});

test('MiniMax Seed uses its configured endpoint and owning home credential through the real SDK', async (t) => {
  home(t, { minimax: { baseUrl: 'https://minimax-proxy.invalid/anthropic' } }, { minimax: { apiKey: 'fixture-minimax-secret' } });
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    const request = new Request(url, init);
    assert.equal(request.url, 'https://minimax-proxy.invalid/anthropic/v1/messages');
    assert.equal(request.headers.get('x-api-key'), 'fixture-minimax-secret');
    const body = await request.json() as { model: string; max_tokens: number };
    assert.equal(body.model, 'MiniMax-M3');
    assert.equal(body.max_tokens, 8192);
    return anthropicResponse();
  };
  const result = await createSeedLobeTransport({ provider: 'minimax', model: 'MiniMax-M3' })('Consider my work.');
  assert.equal(calls, 1);
  assert.equal(result.modelReceipt.provider, 'minimax');
  assert.equal(result.modelReceipt.tokensIn, 19);
  assert.equal(result.modelReceipt.tokensOut, 8);
  assert.doesNotMatch(JSON.stringify(result), /fixture-minimax-secret/);
});

test('MiniMax without an explicit endpoint never sends its key to Anthropic', async (t) => {
  home(t, {}, { minimax: { apiKey: 'fixture-minimax-secret' } });
  globalThis.fetch = async (url, init) => {
    assert.equal(new Request(url, init).url, 'https://api.minimax.io/anthropic/v1/messages');
    return anthropicResponse();
  };
  const result = await createSeedLobeTransport({ model: 'MiniMax-M3' })('Consider my work.');
  assert.equal(result.modelReceipt.provider, 'minimax');
});

test('a running cloud lobe follows endpoint and credential changes in its owning home', async (t) => {
  const root = home(t, { 'ollama-cloud': { baseUrl: 'https://first-cloud.invalid/v1' } }, { 'ollama-cloud': { apiKey: 'fixture-first-key' } });
  const calls: Array<{ url: string; authorization: string | null }> = [];
  globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    calls.push({ url: request.url, authorization: request.headers.get('authorization') });
    return new Response(JSON.stringify({ message: { content: '{"estimates":[]}' } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const transport = createSeedLobeTransport({ provider: 'ollama-cloud', model: 'kimi-k3:cloud' });
  await transport('First reflection.');
  writeFileSync(join(root, 'config', 'home.yaml'), JSON.stringify({ providers: { 'ollama-cloud': { baseUrl: 'https://second-cloud.invalid/v1' } } }));
  writeFileSync(join(root, 'config', 'secrets.yaml'), JSON.stringify({ providers: { 'ollama-cloud': { apiKey: 'fixture-second-key' } } }));
  await transport('Second reflection.');
  assert.deepEqual(calls, [
    { url: 'https://first-cloud.invalid/api/chat', authorization: 'Bearer fixture-first-key' },
    { url: 'https://second-cloud.invalid/api/chat', authorization: 'Bearer fixture-second-key' },
  ]);
});

test('OpenAI Seed transport preserves its selected endpoint, model and response accounting', async (t) => {
  home(t, { openai: { baseUrl: 'https://openai-proxy.invalid/v1' } }, { openai: { apiKey: 'fixture-openai-key' } });
  globalThis.fetch = async (url, init) => {
    const request = new Request(url, init);
    assert.equal(request.url, 'https://openai-proxy.invalid/v1/chat/completions');
    assert.equal(request.headers.get('authorization'), 'Bearer fixture-openai-key');
    assert.equal((await request.json() as { model: string }).model, 'gpt-5.4-mini');
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"estimates":[]}' } }], usage: { prompt_tokens: 11, completion_tokens: 5 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await createSeedLobeTransport({ provider: 'openai', model: 'gpt-5.4-mini' })('Consider my work.');
  assert.equal(result.modelReceipt.tokensIn, 11);
  assert.equal(result.modelReceipt.tokensOut, 5);
});
