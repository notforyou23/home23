import test from 'node:test';
import assert from 'node:assert/strict';
import { generateText } from '../../src/agent/text-generation.js';

const credentials = async () => ({ accessToken: 'fixture-access', refreshToken: 'fixture-refresh',
  expires: Date.now() + 60_000, accountId: 'fixture-account' });
function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), { status: 200 });
}
const codex = { provider: 'openai-codex', model: 'gpt-5.6', prompt: 'fixture', requireComplete: true,
  maxOutputChars: 100, codexCredentialsProvider: credentials };

test('strict Codex returns authoritative completed text, real activity and measured usage', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async () => sse([
    { type: 'response.reasoning_summary_text.delta', delta: 'considering' },
    { type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 7 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'actual completed reply' }] }] } },
  ])) as typeof fetch;
  const activity: number[] = []; const usage = { tokensIn: 0, tokensOut: 0 };
  assert.equal(await generateText({ ...codex, onProviderActivity: sequence => activity.push(sequence), usageSink: usage }), 'actual completed reply');
  assert.deepEqual(activity, [1, 2, 3]); assert.deepEqual(usage, { tokensIn: 11, tokensOut: 7 });
});

for (const [label, events] of [
  ['EOF', [{ type: 'response.output_text.delta', delta: 'looks complete' }]],
  ['failed terminal', [{ type: 'response.failed', response: { status: 'failed' } }]],
  ['incomplete terminal', [{ type: 'response.incomplete', response: { status: 'incomplete' } }]],
  ['invalid completion', [{ type: 'response.completed', response: { status: 'in_progress' } }]],
  ['tool output', [{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', name: 'send' }] } }]],
] as const) test(`strict Codex refuses ${label}`, async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async () => sse([...events])) as typeof fetch;
  await assert.rejects(generateText(codex), { code: 'provider_incomplete' });
});

test('strict Codex caps output before another event and cancels its stream', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let cancelled = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(101) })}\n\n`)); },
    cancel() { cancelled = true; },
  }))) as typeof fetch;
  await assert.rejects(generateText(codex), { code: 'provider_output_limit' });
  assert.equal(cancelled, true);
});

test('strict malformed SSE rejects while the legacy extraction path remains best effort', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = (async () => new Response('data: {broken}\n\ndata: {"type":"response.output_text.delta","delta":"legacy"}\n\n')) as typeof fetch;
  await assert.rejects(generateText(codex), { code: 'provider_incomplete' });
  assert.equal(await generateText({ ...codex, requireComplete: false }), 'legacy');
});

test('strict OpenAI refuses length termination, accepts stop and preserves configured endpoint/key', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let reason = 'length'; let calls = 0;
  globalThis.fetch = (async (url, options) => {
    calls++; assert.equal(url, 'https://configured.test/v1/chat/completions');
    assert.equal((options?.headers as Record<string, string>).Authorization, 'Bearer fixture-static');
    return Response.json({ choices: [{ finish_reason: reason, message: { content: 'full text' } }],
      usage: { prompt_tokens: 13, completion_tokens: 4 } });
  }) as typeof fetch;
  const options = { provider: 'openai', model: 'gpt-5', baseURL: 'https://configured.test/v1', apiKey: 'fixture-static',
    prompt: 'fixture', requireComplete: true, maxOutputChars: 20 };
  await assert.rejects(generateText(options), { code: 'provider_incomplete' });
  reason = 'stop'; assert.equal(await generateText(options), 'full text'); assert.equal(calls, 2);
});

test('strict Ollama applies token cap and requires actual done/stop outcome', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let done = false;
  globalThis.fetch = (async (_url, options) => {
    assert.equal(JSON.parse(String(options?.body)).options.num_predict, 321);
    return Response.json({ message: { content: 'complete answer' }, done, done_reason: 'stop' });
  }) as typeof fetch;
  const options = { provider: 'ollama-local', model: 'fixture', prompt: 'fixture', requireComplete: true, maxTokens: 321 };
  await assert.rejects(generateText(options), { code: 'provider_incomplete' });
  done = true; assert.equal(await generateText(options), 'complete answer');
});

test('strict Anthropic streams real activity and rejects truncated terminal text', async () => {
  let stop = 'max_tokens'; let aborted = 0; const activity: number[] = [];
  const client = { messages: { stream() { return {
    async *[Symbol.asyncIterator]() { yield { type: 'message_start' }; yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'text' } }; },
    finalMessage: async () => ({ stop_reason: stop, content: [{ type: 'text', text: 'text' }], usage: { input_tokens: 5, output_tokens: 2 } }),
    abort() { aborted++; },
  }; } } };
  const options = { provider: 'anthropic', model: 'claude-fixture', prompt: 'fixture', client: client as never,
    requireComplete: true, onProviderActivity: (sequence: number) => activity.push(sequence) };
  await assert.rejects(generateText(options), { code: 'provider_incomplete' });
  stop = 'end_turn'; assert.equal(await generateText(options), 'text');
  assert.deepEqual(activity, [1, 2, 1, 2]); assert.equal(aborted, 2);
});
