'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateLocalOllama, getLocalInferencePolicy, normalizeLocalInferencePolicy,
  assertLocalOllamaTarget, ollamaModelContextTokens } = require('../../shared/local-inference.cjs');

const encoder = new TextEncoder();
const metadata = { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen', 'qwen.context_length': 32768 } };
const options = { baseURL: 'http://127.0.0.1:11434/v1', model: 'local-fixture', messages: [{ role: 'user', content: 'hello' }], maxTokens: 512,
  localInference: { contextTokens: 8192, maxOutputTokens: 1024, localOnly: true } };
const final = (content = 'complete') => ({ message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 12, eval_count: 4 });
const ndjson = events => new Response(events.map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
function mock(t, chat, show = metadata) {
  const previous = globalThis.fetch; const requests = [];
  t.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = async (url, init) => {
    requests.push({ url, ...init, body: JSON.parse(init.body) });
    return url.endsWith('/api/show') ? Response.json(show) : typeof chat === 'function' ? chat(url, init) : ndjson(chat);
  };
  return requests;
}

test('local policy distinguishes operational limits and loads only configured inference fields', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'config'));
  fs.writeFileSync(path.join(root, 'config', 'home.yaml'), 'providers:\n  ollama-local:\n    inference:\n      contextTokens: 8192\n      maxOutputTokens: 512\n      localOnly: true\n');
  assert.deepEqual(getLocalInferencePolicy({}, root), { contextTokens: 8192, maxOutputTokens: 512, keepAlive: '5m', localOnly: true });
  assert.equal(getLocalInferencePolicy({ maxOutputTokens: 128 }, root).maxOutputTokens, 128);
  assert.throws(() => normalizeLocalInferencePolicy({ contextTokens: 1024, maxOutputTokens: 2048 }), { code: 'local_inference_config_invalid' });
  assert.throws(() => normalizeLocalInferencePolicy({ keepAlive: -1 }), { code: 'local_inference_config_invalid' });
  assert.equal(ollamaModelContextTokens(metadata), 32768);
  assert.equal(ollamaModelContextTokens({ model_info: { 'unrelated.context_length': 1000000 } }), null);
});

test('local request preserves explicit endpoint auth, typed tools, budgets, streaming and measured usage', async t => {
  const calls = mock(t, [{ message: { role: 'assistant', content: 'one ', thinking: 'consider ' }, done: false },
    { message: { role: 'assistant', content: 'two', thinking: 'it' }, done: false }, final('')]);
  const chunks = []; const activity = [];
  const result = await generateLocalOllama({ ...options, maxTokens: 3000, apiKey: 'fixture-key', reasoningParameters: { think: true },
    tools: [{ type: 'function', function: { name: 'inspect' } }], onChunk: value => chunks.push(value), onProviderActivity: n => activity.push(n) });
  assert.equal(calls.length, 2); assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/show');
  assert.equal(calls[1].headers.Authorization, 'Bearer fixture-key'); assert.equal(calls[1].redirect, 'error');
  assert.deepEqual(calls[1].body.options, { num_ctx: 8192, num_predict: 1024 });
  assert.equal(calls[1].body.stream, true); assert.equal(calls[1].body.think, true);
  assert.equal(calls[1].body.truncate, false); assert.equal(calls[1].body.shift, false);
  assert.deepEqual(chunks, ['one ', 'two']); assert.deepEqual(activity, [1, 2, 3]);
  assert.equal(result.message.content, 'one two'); assert.equal(result.message.thinking, 'consider it');
  assert.deepEqual(result.usage, { tokensIn: 12, tokensOut: 4 });
});

test('default output ceiling preserves existing structured callers while explicit smaller profiles still cap them', async t => {
  assert.equal(normalizeLocalInferencePolicy().maxOutputTokens, 8192);
  const calls = mock(t, [final()]);
  await generateLocalOllama({ ...options, localInference: { contextTokens: 32768 }, maxTokens: 8192 });
  assert.equal(calls[1].body.options.num_predict, 8192);
  await generateLocalOllama({ ...options, localInference: { contextTokens: 32768 }, maxTokens: 6000 });
  assert.equal(calls[3].body.options.num_predict, 6000);
  await generateLocalOllama({ ...options, localInference: { contextTokens: 8192, maxOutputTokens: 512 }, maxTokens: 8192 });
  assert.equal(calls[5].body.options.num_predict, 512);
});

test('native complete tool call is returned intact only after stop terminal', async t => {
  const tool = { id: 'stable-call', type: 'function', function: { index: 0, name: 'inspect', arguments: { path: '/fixture', nested: { value: 7 } } } };
  mock(t, [{ message: { tool_calls: [tool] }, done: false }, final('')]);
  const result = await generateLocalOllama(options);
  assert.deepEqual(result.message.tool_calls, [tool]);
});

for (const [label, events, code = 'provider_incomplete'] of [
  ['EOF after content', [{ message: { content: 'partial' }, done: false }]],
  ['length termination', [{ ...final('partial'), done_reason: 'length' }]],
  ['empty completion', [final('')]],
  ['provider error', [{ error: 'private server detail', done: true }]],
  ['malformed arguments', [{ ...final(''), message: { tool_calls: [{ function: { name: 'inspect', arguments: '{not-json' } }] } }], 'provider_invalid_tool_call'],
  ['array arguments', [{ ...final(''), message: { tool_calls: [{ function: { name: 'inspect', arguments: [] } }] } }], 'provider_invalid_tool_call'],
  ['repeated call id', [{ ...final(''), message: { tool_calls: [1, 2].map(() => ({ id: 'same', function: { name: 'inspect', arguments: {} } })) } }], 'provider_invalid_tool_call'],
  ['remote response', [{ ...final(), remote_host: 'https://ollama.com' }], 'local_inference_remote_model'],
]) test(`local inference refuses ${label}`, async t => {
  mock(t, events); await assert.rejects(generateLocalOllama(options), { code });
});

test('cloud tags are refused before a request and remote aliases before generation', async t => {
  const calls = mock(t, [final()], { ...metadata, remote_model: 'remote', remote_host: 'https://ollama.com' });
  await assert.rejects(generateLocalOllama({ ...options, model: 'deepseek:cloud' }), { code: 'local_inference_remote_model' });
  assert.equal(calls.length, 0);
  await assert.rejects(generateLocalOllama({ ...options, model: 'innocent-alias' }), { code: 'local_inference_remote_model' });
  assert.equal(calls.length, 1); assert.ok(calls[0].url.endsWith('/api/show'));
});

test('explicit local-only mode refuses external endpoints while configured LAN usage remains possible', () => {
  assert.throws(() => assertLocalOllamaTarget('https://example.test/v1', 'fixture', {}, true), { code: 'local_inference_endpoint_refused' });
  assert.equal(assertLocalOllamaTarget('http://192.168.1.4:11434/v1', 'fixture'), 'http://192.168.1.4:11434');
  assert.throws(() => assertLocalOllamaTarget('http://user:secret@localhost:11434', 'fixture'), { code: 'local_inference_endpoint_invalid' });
});

test('model capabilities reject unsupported tools and images before generation', async t => {
  const calls = mock(t, [final()], { capabilities: ['completion'] });
  await assert.rejects(generateLocalOllama({ ...options, tools: [{ type: 'function' }] }), { code: 'local_inference_tools_unsupported' });
  await assert.rejects(generateLocalOllama({ ...options, messages: [{ role: 'user', content: 'look', images: ['fixture'] }] }), { code: 'local_inference_images_unsupported' });
  assert.ok(calls.every(call => call.url.endsWith('/api/show')));
});

test('output overflow cancels the stream and releases admission for the next request', async t => {
  let cancelled = false; let count = 0;
  mock(t, () => ++count === 1 ? new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(JSON.stringify({ message: { content: 'too long' }, done: false }) + '\n'));
  }, cancel() { cancelled = true; } })) : ndjson([final('ok')]));
  await assert.rejects(generateLocalOllama({ ...options, maxOutputChars: 2 }), { code: 'provider_output_limit' });
  assert.equal(cancelled, true); assert.equal((await generateLocalOllama(options)).message.content, 'ok');
});

test('queued cancellation makes no request and active cancellation releases its reader', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; }); let cancelled = false;
  const calls = mock(t, () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(JSON.stringify({ message: { content: 'partial' }, done: false }) + '\n')); started();
  }, cancel() { cancelled = true; } })));
  const active = new AbortController(); const queued = new AbortController();
  const first = generateLocalOllama({ ...options, signal: active.signal }); await ready;
  const second = generateLocalOllama({ ...options, signal: queued.signal }); queued.abort(new Error('queued stopped'));
  await assert.rejects(second, /queued stopped/); assert.equal(calls.length, 2);
  active.abort(new Error('active stopped')); await assert.rejects(first, /active stopped/); assert.equal(cancelled, true);
});

test('JSON terminal fallback still requires complete metadata and stop status', async t => {
  mock(t, () => Response.json(final('json reply')));
  assert.equal((await generateLocalOllama(options)).message.content, 'json reply');
});

test('runtime-version and unavailable-model failures have distinct bounded diagnostics', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; }); let status = 412;
  globalThis.fetch = async () => new Response('secret upstream detail', { status });
  await assert.rejects(generateLocalOllama(options), error => error.code === 'local_inference_runtime_incompatible' && !error.message.includes('secret'));
  status = 404; await assert.rejects(generateLocalOllama(options), { code: 'local_inference_model_unavailable' });
});

for (const callback of ['onChunk', 'onProviderActivity']) test(`cancellation inside terminal ${callback} cannot return success`, async t => {
  mock(t, [final('terminal text')]);
  const controller = new AbortController();
  await assert.rejects(generateLocalOllama({ ...options, signal: controller.signal,
    [callback]: () => controller.abort(new Error('terminal cancelled')) }), /terminal cancelled/);
});

test('fresh local metadata honors explicit none even when the catalog has no reasoning parameters', async t => {
  const calls = mock(t, [final()], { ...metadata, capabilities: ['completion', 'thinking'], thinking: { values: [false, true] } });
  await generateLocalOllama({ ...options, reasoningEffort: 'none', reasoningParameters: {} });
  assert.equal(calls[1].body.think, false);
  await generateLocalOllama({ ...options, reasoningEffort: 'high', reasoningParameters: { think: false } });
  assert.equal(calls[3].body.think, false, 'explicit native parameter keeps priority');
});

test('fresh local metadata supports boolean thinking and validates named thinking levels', async t => {
  const show = { ...metadata, capabilities: ['completion', 'thinking'], thinking: { values: [false, 'low', 'high'] } };
  const calls = mock(t, [final()], show);
  await generateLocalOllama({ ...options, reasoningEffort: 'low' });
  assert.equal(calls[1].body.think, 'low');
  await assert.rejects(generateLocalOllama({ ...options, reasoningEffort: 'ultra' }), { code: 'local_inference_reasoning_unsupported' });
  assert.equal(calls.length, 3, 'unsupported reasoning is refused before generation');
});
