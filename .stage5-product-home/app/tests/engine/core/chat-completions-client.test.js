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
