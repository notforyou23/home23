import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatCompletionsClient } = require('../../../engine/src/core/chat-completions-client.js');

function makeClient({ supportsStreaming = true, requestTimeoutMs = 25, create }) {
  const client = new ChatCompletionsClient({
    baseURL: 'https://example.test/v1',
    apiKey: 'test-key',
    defaultModel: 'test-model',
    supportsStreaming,
    requestTimeoutMs,
  }, {
    info() {},
    warn() {},
    error() {},
    debug() {},
  });
  client.client = {
    baseURL: 'https://example.test/v1',
    chat: {
      completions: { create },
    },
  };
  return client;
}

async function expectRejectsBeforeTestTimeout(promise) {
  const result = await Promise.race([
    promise.then(
      () => ({ status: 'resolved' }),
      (error) => ({ status: 'rejected', error })
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'test-timeout' }), 150)),
  ]);

  assert.equal(result.status, 'rejected');
  assert.match(result.error.message, /timed out|aborted/i);
}

test('non-streaming chat completions request times out before engine cycle watchdog', async () => {
  const client = makeClient({
    supportsStreaming: false,
    create: () => new Promise(() => {}),
  });

  await expectRejectsBeforeTestTimeout(client.generate({
    messages: [{ role: 'user', content: 'hello' }],
  }));
});

test('streaming chat completions stalls time out while waiting for chunks', async () => {
  async function* stalledStream() {
    await new Promise(() => {});
  }

  const client = makeClient({
    supportsStreaming: true,
    create: async () => stalledStream(),
  });

  await expectRejectsBeforeTestTimeout(client.generate({
    messages: [{ role: 'user', content: 'hello' }],
  }));
});

test('streaming chat completions use a fresh timeout after the stream opens', async () => {
  async function* delayedHealthyStream() {
    await new Promise((resolve) => setTimeout(resolve, 8));
    yield { choices: [{ delta: { content: 'ok' } }] };
  }

  const client = makeClient({
    supportsStreaming: true,
    requestTimeoutMs: 25,
    create: async () => {
      await new Promise((resolve) => setTimeout(resolve, 24));
      return delayedHealthyStream();
    },
  });

  const result = await client.generate({
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(result.content, 'ok');
  assert.equal(result.hadError, false);
});

test('typed tool messages retain arguments, IDs and complete bounded results', () => {
  const client = makeClient({ create: async () => ({}) });
  const toolCalls = [{ id: 'call_exact', type: 'function', function: { name: 'read', arguments: '{"path":"owned.txt"}' } }];
  const result = 'x'.repeat(6000);
  const messages = client.transformInputToMessages({ messages: [
    { role: 'assistant', content: null, tool_calls: toolCalls },
    { role: 'tool', tool_call_id: 'call_exact', content: result },
    { role: 'tool', tool_call_id: 'call_empty', content: '' },
  ] });
  assert.deepEqual(messages[1], { role: 'assistant', content: null, tool_calls: toolCalls });
  assert.equal(messages[2].tool_call_id, 'call_exact');
  assert.equal(messages[2].content, result);
  assert.equal(messages[3].content, '');
  assert.throws(() => client.transformInputToMessages({ messages: [{ role: 'tool', content: result }] }), /tool_call_id/);
});

test('caller cancellation removes queued requests and cancels active requests without retry', async () => {
  let calls = 0;
  const signals = [];
  const client = makeClient({ supportsStreaming: false, requestTimeoutMs: 1000,
    create: async (_payload, request) => { calls++; signals.push(request.signal); await new Promise(() => {}); } });
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  const promises = controllers.map(controller => client.generate({ input: 'bounded request', signal: controller.signal }));
  const outcomes = promises.map(promise => promise.then(() => null, error => error));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2, 'third request remains in the per-endpoint queue');
  const queuedReason = new Error('queued cancellation');
  controllers[2].abort(queuedReason);
  assert.equal(await outcomes[2], queuedReason);
  assert.equal(calls, 2);
  controllers[0].abort(new Error('active cancellation'));
  controllers[1].abort(new Error('active cancellation'));
  await Promise.all(outcomes);
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(calls, 2);
});

test('stream cancellation stops consumption and releases the concurrency slot', async () => {
  const controller = new AbortController();
  let cancelled = false;
  const client = makeClient({ requestTimeoutMs: 1000, create: async () => ({
    [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => { cancelled = true; return { done: true }; } }; },
  }) });
  const result = client.generate({ input: 'hello', signal: controller.signal }).then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve));
  const reason = new Error('stop stream'); controller.abort(reason);
  assert.equal(await result, reason);
  assert.equal(cancelled, true);
});

test('canonical Ollama engine calls use bounded native transport and preserve tool history', async t => {
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  const requests = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body); requests.push({ url: String(url), body });
    if (String(url).endsWith('/api/show')) return Response.json({ capabilities: ['completion', 'tools', 'thinking'], model_info: { 'general.architecture': 'fixture', 'fixture.context_length': 8192 } });
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'Native result.' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 4 })+'\n', { headers: { 'content-type': 'application/x-ndjson' } });
  };
  const client = new ChatCompletionsClient({ baseURL: 'http://127.0.0.1:11434/v1', apiKey: 'not-needed', localInference: { contextTokens: 8192, maxOutputTokens: 512, localOnly: true } });
  const result = await client.generate({ localProvider: 'ollama-local', model: 'fixture-local', maxTokens: 1000, reasoning: { effort: 'none' },
    messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'prior-call', type: 'function', function: { name: 'read_file', arguments: '{"path":"notes.txt"}' } }] },
      { role: 'tool', tool_call_id: 'prior-call', content: 'A complete result' }, { role: 'user', content: 'Explain it.' }],
  });
  const chat = requests.find(request => request.url.endsWith('/api/chat'));
  assert.ok(chat);
  assert.equal(chat.body.options.num_ctx, 8192);
  assert.equal(chat.body.options.num_predict, 512);
  assert.equal(chat.body.think, false);
  assert.deepEqual(chat.body.messages[1].tool_calls[0].function.arguments, { path: 'notes.txt' });
  assert.equal(chat.body.messages[2].tool_name, 'read_file');
  assert.equal(chat.body.messages[2].content, 'A complete result');
  assert.equal(result.content, 'Native result.');
  assert.equal(result.hadError, false);
});

test('native ID-less tool calls gain stable IDs and replay with their exact result on the next request', async t => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  const chats = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/api/show')) return Response.json({ capabilities: ['completion', 'tools'] });
    chats.push(JSON.parse(init.body));
    const message = chats.length === 1
      ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: 'exact.txt' } } }] }
      : { role: 'assistant', content: 'I used the returned evidence.' };
    return new Response(JSON.stringify({ message, done: true, done_reason: 'stop' })+'\n');
  };
  const client = new ChatCompletionsClient({ baseURL: 'http://127.0.0.1:11434', apiKey: 'not-needed' });
  const first = await client.generate({ localProvider: 'ollama-local', model: 'id-fixture', input: 'Read the file.',
    tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] });
  assert.match(first.output[0].id, /^local-call-/);
  assert.equal(first.output[0].call_id, first.output[0].id);
  const call = first.output[0];
  await client.generate({ localProvider: 'ollama-local', model: 'id-fixture', input: [
    call, { type: 'function_call_output', call_id: call.call_id, output: 'Exact returned evidence.' },
  ] });
  const replay = chats[1].messages;
  assert.equal(replay[1].tool_calls[0].id, call.id);
  assert.deepEqual(replay[1].tool_calls[0].function.arguments, { path: 'exact.txt' });
  assert.equal(replay[2].tool_name, 'read_file');
  assert.equal(replay[2].content, 'Exact returned evidence.');
});
