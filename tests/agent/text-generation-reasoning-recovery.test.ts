import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from '../../src/agent/text-generation.js';

const options = {
  provider: 'openai-codex', model: 'gpt-6-astra', reasoningEffort: 'ultra' as const,
  system: 'Return a bounded conversational proposal.', prompt: 'ordinary owner conversation',
  maxTokens: 6000, requireComplete: true, maxOutputChars: 28_000,
  codexCredentialsProvider: async () => ({ accessToken: 'access-test', refreshToken: 'refresh-test',
    expires: Date.now() + 60_000, accountId: 'acct-test' }),
};
const proposal = '{"schema":"home23.conversation-proposal.v1","route":"ordinary_loop"}';

function completed(text = proposal): Response {
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
    status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 123, output_tokens: 45 },
  } })}\n\ndata: [DONE]\n\n`, { status: 200 });
}

test('accepted ultra requests keep the requested reasoning configuration', async (t) => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); return completed();
  }) as typeof fetch;
  assert.equal(await generateText(options), proposal);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0]!.reasoning, { effort: 'ultra', summary: 'auto' });
});

test('a rejected ultra setting recovers a complete conversational proposal and measured usage', async (t) => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const bodies: Record<string, unknown>[] = [];
  const signals: AbortSignal[] = [];
  const usage = { tokensIn: 0, tokensOut: 0 };
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body))); signals.push(init!.signal!);
    return bodies.length === 1
      ? new Response('{"detail":"Unsupported reasoning effort: ultra"}', { status: 400 })
      : completed();
  }) as typeof fetch;
  assert.equal(await generateText({ ...options, usageSink: usage }), proposal);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0]!.reasoning, { effort: 'ultra', summary: 'auto' });
  assert.equal(Object.hasOwn(bodies[1]!, 'reasoning'), false);
  assert.equal(bodies[1]!.max_output_tokens, 6000);
  assert.deepEqual(bodies[1]!.input, bodies[0]!.input);
  assert.equal(bodies[1]!.instructions, bodies[0]!.instructions);
  assert.equal(signals[0], signals[1], 'recovery shares the original request deadline');
  assert.deepEqual(usage, { tokensIn: 123, tokensOut: 45 });
});

for (const order of [['max_output_tokens', 'reasoning.summary'], ['reasoning.summary', 'max_output_tokens']]) {
  test(`parameter recovery handles rejection order ${order.join(' then ')}`, async (t) => {
    const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      const field = order[bodies.length - 1];
      return field ? new Response(JSON.stringify({ detail: `Unsupported parameter: ${field}` }), { status: 503 })
        : completed();
    }) as typeof fetch;
    assert.equal(await generateText(options), proposal);
    assert.equal(bodies.length, 3);
    assert.equal(Object.hasOwn(bodies[1]!, order[0] === 'max_output_tokens' ? 'max_output_tokens' : 'reasoning'), false);
    assert.equal(Object.hasOwn(bodies[2]!, 'max_output_tokens'), false);
    assert.equal(Object.hasOwn(bodies[2]!, 'reasoning'), false);
  });
}

test('a repeated reasoning rejection is bounded and does not disclose the error body', async (t) => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++; return new Response('reasoning rejected; private upstream diagnostic access-SECRET', { status: 400 });
  }) as typeof fetch;
  await assert.rejects(generateText(options), error => {
    assert.match((error as Error).message, /codex HTTP 400/);
    assert.doesNotMatch((error as Error).message, /SECRET|private upstream|reasoning rejected/);
    return true;
  });
  assert.equal(attempts, 2);
});

test('an unrelated HTTP error does not trigger parameter recovery or expose the response body', async (t) => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++; return new Response('private upstream diagnostic access-SECRET', { status: 502 });
  }) as typeof fetch;
  await assert.rejects(generateText(options), error => {
    assert.match((error as Error).message, /codex HTTP 502/);
    assert.doesNotMatch((error as Error).message, /SECRET|private upstream/);
    return true;
  });
  assert.equal(attempts, 1);
});

test('cancellation after a reasoning rejection prevents the recovery request', async (t) => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const controller = new AbortController(); const cancelled = new Error('owner cancelled');
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++; controller.abort(cancelled);
    return new Response('{"detail":"Unsupported reasoning effort: ultra"}', { status: 400 });
  }) as typeof fetch;
  await assert.rejects(generateText({ ...options, signal: controller.signal }), error => error === cancelled);
  assert.equal(attempts, 1);
});

test('reasoning and cap recovery share the existing single credential-refresh budget', async (t) => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  const credentialCalls: boolean[] = []; const rejectedTokens: Array<string | undefined> = [];
  const requests: Array<{ body: Record<string, unknown>; authorization: string }> = [];
  globalThis.fetch = (async (_url, init) => {
    requests.push({ body: JSON.parse(String(init?.body)),
      authorization: (init?.headers as Record<string, string>).Authorization });
    switch (requests.length) {
      case 1: return new Response('revoked', { status: 401 });
      case 2: return new Response('Unsupported reasoning effort: ultra', { status: 400 });
      case 3: return new Response('Unsupported parameter: max_output_tokens', { status: 503 });
      default: return completed();
    }
  }) as typeof fetch;
  assert.equal(await generateText({ ...options,
    codexCredentialsProvider: async (_signal, force, staleAccessToken) => {
      credentialCalls.push(force === true); rejectedTokens.push(staleAccessToken);
      return { accessToken: force ? 'access-refreshed' : 'access-original', refreshToken: 'refresh-test',
        expires: Date.now() + 60_000, accountId: 'acct-test' };
    },
  }), proposal);
  assert.equal(requests.length, 4, 'one auth retry plus each optional parameter once');
  assert.deepEqual(credentialCalls, [false, true]);
  assert.deepEqual(rejectedTokens, [undefined, 'access-original']);
  assert.deepEqual(requests.map(request => request.authorization),
    ['Bearer access-original', 'Bearer access-refreshed', 'Bearer access-refreshed', 'Bearer access-refreshed']);
  assert.deepEqual(requests[1]!.body.reasoning, { effort: 'ultra', summary: 'auto' });
  assert.equal(Object.hasOwn(requests[2]!.body, 'reasoning'), false);
  assert.equal(requests[2]!.body.max_output_tokens, 6000);
  assert.equal(Object.hasOwn(requests[3]!.body, 'max_output_tokens'), false);
});

test('an exhausted auth failure mentioning reasoning cannot spend parameter retries', async (t) => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts++; return new Response('reasoning access denied', { status: 401 });
  }) as typeof fetch;
  await assert.rejects(generateText(options), { code: 'provider_http_error', status: 401 });
  assert.equal(attempts, 2);
});

test('recovery preserves strict completion and output bounds', async (t) => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; });
  for (const failure of ['incomplete', 'oversized']) {
    let attempts = 0;
    globalThis.fetch = (async () => {
      if (++attempts === 1) return new Response('{"detail":"Unsupported reasoning effort: ultra"}', { status: 400 });
      return failure === 'incomplete'
        ? new Response('data: {"type":"response.output_text.delta","delta":"partial"}\n\ndata: [DONE]\n\n')
        : completed('x'.repeat(100));
    }) as typeof fetch;
    await assert.rejects(generateText({ ...options, maxOutputChars: 80 }), {
      code: failure === 'incomplete' ? 'provider_incomplete' : 'provider_output_limit',
    });
    assert.equal(attempts, 2);
  }
});
