const assert = require('assert');
const test = require('node:test');

function futureJwt() {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, sub: 'acct-test' })).toString('base64url');
  return `${header}.${payload}.signature`;
}

function loadFresh() {
  // Isolate from the developer's real config/secrets.yaml: these tests
  // exercise the env floor, so the resolver must find no secrets file.
  process.env.HOME23_SECRETS_PATH = '/nonexistent/home23-test-secrets.yaml';
  for (const key of Object.keys(require.cache)) {
    if (key.includes('/engine/src/services/openai-codex-oauth-engine.js')
      || key.includes('/engine/src/core/provider-credentials.js')) {
      delete require.cache[key];
    }
  }
  return require('../../../engine/src/services/openai-codex-oauth-engine');
}

test('openai-codex credentials use OAuth token and ignore OPENAI_API_KEY', () => {
  const oldEnv = { ...process.env };
  try {
    const token = futureJwt();
    process.env.OPENAI_CODEX_AUTH_TOKEN = token;
    process.env.OPENAI_API_KEY = 'sk-should-not-be-used';

    const { getOpenAICodexCredentials } = loadFresh();
    const credentials = getOpenAICodexCredentials();

    assert.equal(credentials.apiKey, token);
    assert.equal(credentials.authMode, 'oauth');
    assert.equal(credentials.isOAuth, true);
  } finally {
    process.env = oldEnv;
  }
});

test('openai-codex fails closed instead of falling back to OPENAI_API_KEY', () => {
  const oldEnv = { ...process.env };
  try {
    delete process.env.OPENAI_CODEX_AUTH_TOKEN;
    process.env.OPENAI_API_KEY = 'sk-should-not-be-used';

    const { getOpenAICodexCredentials } = loadFresh();

    assert.throws(
      () => getOpenAICodexCredentials(),
      /Refusing to use OPENAI_API_KEY for openai-codex/
    );
  } finally {
    process.env = oldEnv;
  }
});

test('openai-codex rejects API-key shaped values in the OAuth slot', () => {
  const oldEnv = { ...process.env };
  try {
    process.env.OPENAI_CODEX_AUTH_TOKEN = 'sk-not-oauth';

    const { getOpenAICodexCredentials } = loadFresh();

    assert.throws(
      () => getOpenAICodexCredentials(),
      /not an OpenAI OAuth JWT/
    );
  } finally {
    process.env = oldEnv;
  }
});

test('openai-codex moves system and developer messages into instructions', async () => {
  const oldEnv = { ...process.env };
  const oldFetch = global.fetch;
  let captured = null;

  try {
    process.env.OPENAI_CODEX_AUTH_TOKEN = futureJwt();
    global.fetch = async (url, options = {}) => {
      captured = {
        url,
        body: JSON.parse(options.body),
      };
      return {
        ok: true,
        body: {
          getReader() {
            const chunks = [
              Buffer.from('data: {"type":"response.output_text.delta","delta":"ok"}\n\n'),
              Buffer.from('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n'),
            ];
            let index = 0;
            return {
              async read() {
                if (index >= chunks.length) return { done: true };
                return { done: false, value: chunks[index++] };
              },
            };
          },
        },
      };
    };

    const { OpenAICodexClient } = loadFresh();
    const client = new OpenAICodexClient({}, { info() {} });

    await client.generate({
      model: 'gpt-6.1-sol',
      reasoningEffort: 'high',
      instructions: 'Base instruction.',
      messages: [
        { role: 'system', content: 'System instruction.' },
        { role: 'developer', content: 'Developer instruction.' },
        { role: 'user', content: 'Hello.' },
      ],
    });

    assert.equal(captured.url, 'https://chatgpt.com/backend-api/codex/responses');
    assert.match(captured.body.instructions, /Base instruction/);
    assert.match(captured.body.instructions, /System instruction/);
    assert.match(captured.body.instructions, /Developer instruction/);
    assert.deepEqual(captured.body.reasoning, { effort: 'high', summary: 'auto' });
    assert.deepEqual(captured.body.input.map(item => item.role), ['user']);
  } finally {
    process.env = oldEnv;
    global.fetch = oldFetch;
  }
});

test('openai-codex cancellation prevents an auth-looking failure from refreshing and retrying', async () => {
  const oldEnv = { ...process.env };
  const controller = new AbortController();
  const reason = new Error('401 unauthorized after PGS expiry');
  let calls = 0;
  try {
    process.env.OPENAI_CODEX_AUTH_TOKEN = futureJwt();
    const { OpenAICodexClient } = loadFresh();
    const client = new OpenAICodexClient();
    client._generateAttempt = async () => {
      calls++;
      controller.abort(reason);
      throw reason;
    };
    await assert.rejects(client.generate({ query: 'Connect material', signal: controller.signal }), error => error === reason);
    assert.equal(calls, 1);
  } finally {
    process.env = oldEnv;
  }
});

async function withStream(events, run, { heldOpen = false } = {}) {
  const oldEnv = { ...process.env }, oldFetch = global.fetch;
  const log = [], state = { reads: 0, cancelled: 0, released: 0 };
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('fixture stream deadline')), 250);
  state.signal = controller.signal;
  try {
    process.env.OPENAI_CODEX_AUTH_TOKEN = futureJwt();
    const chunks = events.map(event => Buffer.isBuffer(event) ? event : Buffer.from('data: ' + JSON.stringify(event) + '\n\n'));
    global.fetch = async () => ({ ok: true, body: { getReader() { return {
      async read() {
        state.reads++;
        if (chunks.length) return { done: false, value: chunks.shift() };
        return heldOpen ? new Promise(() => {}) : { done: true };
      },
      cancel() { state.cancelled++; return new Promise(() => {}); },
      releaseLock() { state.released++; },
    }; } } });
    const { OpenAICodexClient } = loadFresh();
    const client = new OpenAICodexClient({}, { info(message, metadata) { log.push({ message, metadata }); } });
    await run(client, state, log);
  } finally {
    clearTimeout(deadline);
    process.env = oldEnv; global.fetch = oldFetch;
  }
}

test('completed Codex response settles without waiting for EOF or slow stream cancellation', async () => {
  await withStream([
    { type: 'response.output_text.delta', delta: 'grounded connection' },
    { type: 'response.completed', response: { usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16 } } },
    { type: 'response.output_text.delta', delta: ' must not be consumed after completion' },
  ], async (client, state) => {
    const result = await client.generate({ model: 'gpt-6.1-sol', reasoningEffort: 'high', query: 'Connect private material', signal: state.signal });
    assert.equal(result.content, 'grounded connection');
    assert.deepEqual(result.usage, { input_tokens: 11, output_tokens: 5, total_tokens: 16 });
    assert.equal(state.reads, 2);
    assert.equal(state.cancelled, 1);
    assert.equal(state.released, 1);
  }, { heldOpen: true });
});

test('Codex incomplete terminal rejects partial text without waiting for EOF', async () => {
  await withStream([
    { type: 'response.output_text.delta', delta: 'partial connection' },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
  ], async (client, state) => {
    await assert.rejects(client.generate({ model: 'gpt-6.1-sol', query: 'Connect material', signal: state.signal }), /response incomplete.*max_output_tokens/);
    assert.equal(state.reads, 2);
    assert.equal(state.cancelled, 1);
  }, { heldOpen: true });
});

test('Codex EOF without a completed terminal cannot promote partial text or reasoning', async () => {
  await withStream([
    { type: 'response.reasoning_summary_text.delta', delta: 'private reasoning' },
    { type: 'response.output_text.delta', delta: 'partial answer' },
  ], async client => {
    await assert.rejects(client.generate({ model: 'gpt-6.1-sol', query: 'Connect material' }), /stream ended before response.completed/);
  });
});

test('fragmented CRLF terminal preserves the final answer and logs only bounded response metadata', async () => {
  const event = { type: 'response.completed', response: {
    output: [{ type: 'message', content: [{ type: 'output_text', text: 'music → learning' }] }],
    usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
  } };
  const wire = Buffer.from(JSON.stringify(event, null, 1).split('\n').map(line => 'data: ' + line).join('\r\n') + '\r\n\r\n');
  const split = wire.indexOf(Buffer.from('→')) + 1;
  await withStream([wire.subarray(0, split), wire.subarray(split, split + 1), wire.subarray(split + 1)], async (client, state, log) => {
    const result = await client.generate({ model: 'gpt-6.1-sol', reasoningEffort: 'high', query: 'private source material', signal: state.signal });
    assert.equal(result.content, 'music → learning');
    assert.equal(state.reads, 3);
    const request = log.find(row => row.message === '[OpenAI-Codex] Request').metadata;
    const settled = log.find(row => row.message === '[OpenAI-Codex] Response settled').metadata;
    assert.equal(settled.requestId, request.requestId);
    assert.equal(settled.reasoningEffort, 'high');
    assert.equal(settled.outcome, 'completed');
    assert.equal(settled.terminalEvent, 'response.completed');
    assert.equal(settled.eventsReceived, 1);
    assert.deepEqual(settled.usage, event.response.usage);
    for (const key of ['headersMs', 'firstEventMs', 'firstTextMs', 'terminalMs', 'durationMs']) assert.ok(Number.isSafeInteger(settled[key]) && settled[key] >= 0, key);
    assert.ok(settled.firstEventMs >= settled.headersMs && settled.terminalMs >= settled.firstEventMs);
    assert.ok(!JSON.stringify(log).includes('private source material'));
    assert.ok(!JSON.stringify(log).includes(process.env.OPENAI_CODEX_AUTH_TOKEN));
  }, { heldOpen: true });
});

async function withFetch(fetch, run) {
  const oldEnv = { ...process.env }, oldFetch = global.fetch;
  const log = [];
  try {
    process.env.OPENAI_CODEX_AUTH_TOKEN = futureJwt();
    global.fetch = fetch;
    const { OpenAICodexClient } = loadFresh();
    const client = new OpenAICodexClient({}, { info(message, metadata) { log.push({ message, metadata }); } });
    await run(client, log);
  } finally {
    process.env = oldEnv;
    global.fetch = oldFetch;
  }
}

function onlySettlement(log) {
  const requests = log.filter(row => row.message === '[OpenAI-Codex] Request');
  const settlements = log.filter(row => row.message === '[OpenAI-Codex] Response settled');
  assert.equal(requests.length, 1);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].metadata.requestId, requests[0].metadata.requestId);
  return settlements[0].metadata;
}

test('Codex fetch, HTTP and body failures each settle once without exposing private failure data', async t => {
  const cases = [
    { name: 'fetch rejects', headers: false, error: /private fetch failure/, fetch: async () => { throw new Error('private fetch failure'); } },
    { name: 'HTTP rejects', headers: true, error: /OpenAI Codex 500/, fetch: async () => ({ ok: false, status: 500, text: async () => 'private HTTP failure' }) },
    { name: 'HTTP error body rejects', headers: true, error: /OpenAI Codex 500/, fetch: async () => ({ ok: false, status: 500, text: async () => { throw new Error('private body failure'); } }) },
    { name: 'body is missing', headers: true, error: /response missing body/, fetch: async () => ({ ok: true, body: null }) },
    { name: 'body reader rejects', headers: true, error: /private reader failure/, fetch: async () => ({ ok: true, body: { getReader() { throw new Error('private reader failure'); } } }) },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await withFetch(fixture.fetch, async (client, log) => {
        await assert.rejects(client.generate({ query: 'private source material' }), fixture.error);
        const settled = onlySettlement(log);
        assert.equal(settled.outcome, 'failed');
        if (fixture.headers) assert.ok(Number.isSafeInteger(settled.headersMs) && settled.headersMs >= 0);
        else assert.equal(settled.headersMs, null);
        for (const key of ['firstEventMs', 'firstTextMs', 'terminalMs', 'terminalEvent', 'usage']) assert.equal(settled[key], null, key);
        assert.equal(settled.eventsReceived, 0);
        assert.ok(Number.isSafeInteger(settled.durationMs) && settled.durationMs >= 0);
        assert.ok(!JSON.stringify(log).includes('private'));
        assert.ok(!JSON.stringify(log).includes(process.env.OPENAI_CODEX_AUTH_TOKEN));
      });
    });
  }
});

test('Codex cancellation before headers or during an HTTP error body settles once and cannot retry', async t => {
  for (const stage of ['fetch', 'HTTP body']) {
    await t.test(stage, async () => {
      const controller = new AbortController();
      const reason = new Error('401 private cancellation reason');
      let reachedStage;
      const started = new Promise(resolve => { reachedStage = resolve; });
      let fetches = 0;
      await withFetch(async (_url, options) => {
        fetches++;
        assert.equal(options.signal, controller.signal);
        if (stage === 'fetch') {
          reachedStage();
          return new Promise(() => {});
        }
        return { ok: false, status: 401, text() { reachedStage(); return new Promise(() => {}); } };
      }, async (client, log) => {
        const pending = client.generate({ query: 'private source material', signal: controller.signal });
        await started;
        controller.abort(reason);
        await assert.rejects(pending, error => error === reason);
        assert.equal(fetches, 1);
        const settled = onlySettlement(log);
        assert.equal(settled.outcome, 'cancelled');
        if (stage === 'fetch') assert.equal(settled.headersMs, null);
        else assert.ok(Number.isSafeInteger(settled.headersMs) && settled.headersMs >= 0);
        for (const key of ['firstEventMs', 'firstTextMs', 'terminalMs', 'terminalEvent', 'usage']) assert.equal(settled[key], null, key);
        assert.equal(settled.eventsReceived, 0);
        assert.ok(!JSON.stringify(log).includes('private'));
      });
    });
  }
});

test('Codex auth failure retains exactly one retry with a settlement for each attempt', async () => {
  let fetches = 0;
  await withFetch(async () => {
    fetches++;
    return { ok: false, status: 401, text: async () => 'unauthorized' };
  }, async (client, log) => {
    await assert.rejects(client.generate({ query: 'Connect material' }), /OpenAI Codex 401/);
    assert.equal(fetches, 2);
    const requestIds = log.filter(row => row.message === '[OpenAI-Codex] Request').map(row => row.metadata.requestId);
    const settlements = log.filter(row => row.message === '[OpenAI-Codex] Response settled').map(row => row.metadata);
    assert.equal(requestIds.length, 2);
    assert.notEqual(requestIds[0], requestIds[1]);
    assert.deepEqual(settlements.map(row => row.requestId), requestIds);
    assert.deepEqual(settlements.map(row => row.outcome), ['failed', 'failed']);
  });
});

test('Codex usage logs admit only known nonnegative safe integer token counts', async t => {
  const privateUsage = 'private provider usage material';
  const cases = [
    { name: 'extra and nested fields', usage: {
      input_tokens: 7, output_tokens: 3, total_tokens: 10,
      input_tokens_details: { cached_tokens: 5, material: privateUsage },
      output_tokens_details: { reasoning_tokens: 2, material: privateUsage },
      material: privateUsage.repeat(500),
    }, expected: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } },
    { name: 'invalid known fields', usage: {
      input_tokens: privateUsage, output_tokens: { material: privateUsage }, total_tokens: -1,
    }, expected: null },
    { name: 'fractional or unsafe fields', usage: {
      input_tokens: 1.5, output_tokens: Number.MAX_SAFE_INTEGER + 1, total_tokens: 0,
    }, expected: { total_tokens: 0 } },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await withStream([{ type: 'response.completed', response: {
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'grounded connection' }] }],
        usage: fixture.usage,
      } }], async (client, state, log) => {
        const result = await client.generate({ query: 'Connect material', signal: state.signal });
        assert.equal(result.content, 'grounded connection');
        const settled = onlySettlement(log);
        assert.equal(settled.outcome, 'completed');
        assert.deepEqual(settled.usage, fixture.expected);
        assert.ok(!JSON.stringify(log).includes(privateUsage));
        assert.ok(!JSON.stringify(log).includes('tokens_details'));
        assert.ok(JSON.stringify(settled.usage).length < 100);
      }, { heldOpen: true });
    });
  }
});
