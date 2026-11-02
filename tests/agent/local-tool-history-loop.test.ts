import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { ToolRegistry } from '../../src/agent/tools/index.js';

type Provider = 'openai' | 'openai-codex' | 'xai' | 'ollama-cloud' | 'ollama-local';
const resultText = 'first line\n' + 'x'.repeat(2400) + '\nlast line beyond the old summary cutoff';
const input = { path: 'sample.txt', offset: 7 };
function sse(items: Array<Record<string, unknown>>): Response {
  return new Response(items.map(item => `data: ${JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
function ndjson(items: Array<Record<string, unknown>>): Response {
  return new Response(items.map(item => JSON.stringify(item) + '\n').join(''), { headers: { 'content-type': 'application/x-ndjson' } });
}

async function fixture(provider: Provider, mode: 'replay' | 'malformed' | 'cancel' = 'replay') {
  const root = mkdtempSync(join(tmpdir(), 'home23-local-history-'));
  mkdirSync(join(root, 'workspace'));
  const priorFetch = globalThis.fetch;
  const env = ['HOME23_ROOT', 'OPENAI_API_KEY', 'XAI_API_KEY', 'OLLAMA_CLOUD_API_KEY', 'LOCAL_LLM_BASE_URL'];
  const previous = env.map(key => process.env[key]);
  process.env.HOME23_ROOT = root;
  process.env.OPENAI_API_KEY = process.env.XAI_API_KEY = process.env.OLLAMA_CLOUD_API_KEY = 'fixture';
  process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434';
  const history = new ConversationHistory(join(root, 'conversations'), 100_000, 'fixture');
  const registry = new ToolRegistry();
  const requests: any[] = [];
  const events: any[] = [];
  let executions = 0;
  let calls = 0;
  let agent: AgentLoop;
  registry.register({ name: 'read_fixture', description: 'Read one fixed source.', input_schema: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' } }, required: ['path', 'offset'] },
    execute: async args => {
      executions++;
      assert.deepEqual(args, input);
      if (mode === 'cancel') agent.stop('fixture');
      return { content: resultText, is_error: true };
    } });
  agent = new AgentLoop({ apiKey: 'fixture', model: provider.startsWith('ollama') ? 'fixture-local:latest' : provider === 'xai' ? 'grok-fixture' : 'gpt-fixture', provider, registry, history,
    ...(provider === 'ollama-local' ? { reasoningEffort: 'none' as const } : {}),
    workspacePath: join(root, 'workspace'), contextManager: { getSystemPrompt: () => 'Use the available evidence.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    toolContext: { brainOperations: { withActivityHandler() { return this; } } } as never });
  (agent as any).codexCredentialsProvider = async () => ({ accessToken: 'fixture', accountId: 'fixture' });
  globalThis.fetch = (async (url, options) => {
    const address = String(url);
    if (address.endsWith('/api/show')) return Response.json({ capabilities: ['completion', 'tools', 'thinking'], thinking: { values: [false, true] }, details: { family: 'fixture' }, model_info: { 'fixture.context_length': 32768 } });
    if (address.endsWith('/api/tags')) return Response.json({ models: [{ name: 'fixture-local:latest', digest: 'fixture-digest', size: 1000 }] });
    if (!/\/chat\/completions$|\/api\/chat$|\/responses$/.test(address)) return Response.json({}, { status: 503 });
    const body = JSON.parse(String(options?.body));
    if (provider === 'ollama-local') assert.equal(body.think, false, 'explicit none survives an empty reasoning catalog');
    requests.push(body);
    calls++;
    const toolCalls = [{ ...(provider === 'ollama-local' ? {} : { id: 'call-1' }), type: 'function', function: { name: 'read_fixture', arguments: provider.startsWith('ollama') ? input : JSON.stringify(input) } }];
    if (mode === 'cancel') toolCalls.push({ id: 'call-after-stop', type: 'function', function: { name: 'read_fixture', arguments: input } });
    if (mode === 'malformed') toolCalls.push({ id: 'call-bad', type: 'function', function: { name: 'read_fixture', arguments: '{broken' as any } });
    if (provider === 'openai-codex' || provider === 'xai') return sse([
      ...(calls === 1 ? toolCalls.map(call => ({ type: 'response.output_item.done', item: { type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments } }))
        : [{ type: 'response.output_text.delta', delta: 'Complete.' }]),
      { type: 'response.completed', response: { status: 'completed' } },
    ]);
    const message = { role: 'assistant', content: calls === 1 ? 'Checking the source.' : 'Complete.', ...(calls === 1 ? { tool_calls: toolCalls } : {}) };
    if (provider === 'ollama-local') return ndjson([{ message, done: false }, { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 30, eval_count: 10 }]);
    if (provider === 'ollama-cloud') return Response.json({ message, done: true, done_reason: 'stop' });
    return Response.json({ choices: [{ message, finish_reason: calls === 1 ? 'tool_calls' : 'stop' }] });
  }) as typeof fetch;
  try {
    const started = await agent.runWithTurn('fixture', 'Read the fixed source.', { onEvent: event => events.push(event) });
    if (mode === 'malformed') {
      await assert.rejects(started.response, { code: 'provider_invalid_tool_call' });
      assert.equal(executions, 0);
      return;
    }
    if (mode === 'cancel') {
      await started.response.catch(() => {});
      const records = history.load('fixture');
      const results = records.flatMap(record => 'content' in record && Array.isArray(record.content) ? record.content.filter(block => block.type === 'tool_result') : []);
      assert.equal(executions, 1);
      const cancelled = results.find(block => block.type === 'tool_result' && block.tool_use_id === 'call-after-stop');
      assert.ok(cancelled?.type === 'tool_result');
      assert.equal(cancelled.is_error, true);
      assert.equal(cancelled.content, 'Interrupted by /stop');
      const raw = history.loadRaw('fixture') as Array<Record<string, unknown>>;
      assert.equal(raw.findLast(record => record.type === 'turn')?.status, 'stopped');
      return;
    }
    assert.equal((await started.response).text, 'Complete.');
    const records = history.load('fixture');
    const blocks = records.flatMap(record => 'content' in record && Array.isArray(record.content) ? record.content : []);
    const savedCall = blocks.find(block => block.type === 'tool_use');
    const savedResult = blocks.find(block => block.type === 'tool_result');
    assert.ok(savedCall?.type === 'tool_use');
    assert.ok(savedResult?.type === 'tool_result');
    assert.deepEqual(savedCall.input, input);
    assert.equal(savedResult.tool_use_id, savedCall.id);
    assert.equal(savedResult.is_error, true);
    assert.match(savedResult.content, /last line beyond the old summary cutoff/);
    assert.equal(events.find(event => event.type === 'tool_start').toolCallId, savedCall.id);
    const followupIndex = requests.length;
    assert.equal((await (await agent.runWithTurn('fixture', 'What did that request contain?')).response).text, 'Complete.');
    const followup = requests[followupIndex];
    const replay = followup.messages ?? followup.input;
    assert.match(JSON.stringify(replay), /last line beyond the old summary cutoff/);
    if (provider === 'openai-codex' || provider === 'xai') {
      const call = replay.find((item: any) => item.type === 'function_call');
      const result = replay.find((item: any) => item.type === 'function_call_output');
      assert.equal(call.call_id, result.call_id);
      assert.deepEqual(JSON.parse(call.arguments), input);
    } else {
      const call = replay.find((item: any) => item.tool_calls)?.tool_calls[0];
      const result = replay.find((item: any) => item.role === 'tool');
      assert.equal(call.id, result.tool_call_id);
      assert.deepEqual(typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments, input);
      if (provider.startsWith('ollama')) assert.equal(result.tool_name, 'read_fixture');
    }
    assert.equal(executions, 1, 'history replay must not execute a previous action');
  } finally {
    globalThis.fetch = priorFetch;
    env.forEach((key, i) => previous[i] === undefined ? delete process.env[key] : process.env[key] = previous[i]);
    rmSync(root, { recursive: true, force: true });
  }
}

for (const provider of ['openai', 'openai-codex', 'xai', 'ollama-cloud', 'ollama-local'] as const) {
  test(`${provider} next turn receives typed prior calls, arguments, and complete bounded results`, () => fixture(provider));
  test(`${provider} rejects a malformed batch before executing its first valid tool`, () => fixture(provider, 'malformed'));
}
test('local tool cancellation retains an observable interrupted outcome', () => fixture('ollama-local', 'cancel'));
