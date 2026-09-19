import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { createSeededToolRegistry } from '../../src/agent/tools/index.js';
import { steerQueue } from '../../src/agent/steer-queue.js';

const TOOL_NAME = 'noop_tool';
const CHAT_ID = `steer-loop-${process.pid}-${Date.now()}`;

test('queued steer appears on the next iteration and leaves the current model call unchanged', async () => {
  const root = join(tmpdir(), `steer-loop-${process.pid}-${Math.random()}`);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const tool = {
    name: TOOL_NAME,
    description: 'holds the first tool-round so steer can queue',
    input_schema: { type: 'object', properties: {} },
    execute: async () => {
      steerQueue.enqueue(CHAT_ID, 'use the workspace instead');
      return { content: 'tool done' };
    },
  };
  const agent = new AgentLoop({
    apiKey: 'test-key',
    model: 'gpt-5.5',
    provider: 'openai',
    registry: {
      getAnthropicTools: () => [{ name: TOOL_NAME, description: tool.description, input_schema: tool.input_schema }],
      getOpenAITools: () => [{
        type: 'function',
        function: { name: TOOL_NAME, description: tool.description, parameters: tool.input_schema },
      }],
      get: (name: string) => name === TOOL_NAME ? tool : undefined,
      execute: async (name: string, input: Record<string, unknown>, context: Record<string, unknown>) => {
        assert.equal(name, TOOL_NAME);
        return tool.execute();
      },
    } as never,
    contextManager: {
      getSystemPrompt: () => 'You are a test agent.',
      getPromptSourceInfo: () => ({ loadedFiles: [] }),
    } as never,
    history,
    toolContext: {
      brainOperations: {
        withActivityHandler() { return this; },
      },
      turnRuntime: null,
    } as never,
    workspacePath: join(root, 'workspace'),
  });

  const requests: Array<Array<Record<string, unknown>>> = [];
  const originalFetch = globalThis.fetch;
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let providerCall = 0;

  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        return new Response('{}', { status: 503 });
      }
      providerCall += 1;
      const body = init?.body ? JSON.parse(String(init.body)) as { messages?: Array<Record<string, unknown>> } : {};
      requests.push(body.messages ?? []);
      if (providerCall === 1) {
        return Response.json({
          choices: [{
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call-1', type: 'function', function: { name: TOOL_NAME, arguments: '{}' } }],
            },
          }],
        });
      }
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    }) as typeof fetch;

    const started = await agent.runWithTurn(CHAT_ID, 'start the tool', {
      firstTokenTimeoutMs: 60_000,
      inactivityMs: 60_000,
      hardDurationMs: 120_000,
    });
    const result = await started.response;
    assert.equal(result.text, 'done');
    assert.equal(requests.length, 2);

    const first = JSON.stringify(requests[0]);
    assert.doesNotMatch(first, /Operator steer/);
    assert.doesNotMatch(first, /use the workspace instead/);

    const secondUsers = (requests[1] ?? []).filter((message) => message.role === 'user');
    const steer = secondUsers.find((message) => String(message.content).includes('[Operator steer]'));
    assert.ok(steer, 'second iteration should include the drained steer note');
    assert.match(String(steer.content), /use the workspace instead/);

    const persisted = history.load(CHAT_ID);
    assert.ok(persisted.some((record) => record.role === 'user' && String(record.content).includes('[Operator steer]')));
  } finally {
    globalThis.fetch = originalFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = priorKey;
    rmSync(root, { recursive: true, force: true });
  }
});


for (const applied of [true, false]) test(`exact steer produces durable ${applied ? 'applied' : 'not_applied'} receipt in its real turn`, async () => {
  const root = join(tmpdir(), `exact-steer-loop-${process.pid}-${Math.random()}`);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const agent = new AgentLoop({
    apiKey: 'test-key', model: 'gpt-5.5', provider: 'openai', registry: createSeededToolRegistry([{
      name: 'verify_note', description: 'a harmless second model round', input_schema: { type: 'object', properties: {} },
      execute: async () => ({ content: 'checked' }),
    }]),
    contextManager: { getSystemPrompt: () => 'Test.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    history, toolContext: { brainOperations: { withActivityHandler() { return this; } }, turnRuntime: null } as never,
    workspacePath: join(root, 'workspace'),
  });
  const priorFetch = globalThis.fetch;
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  let turnId = '';
  const inputs: unknown[] = [];
  const request = () => ({ chatId: 'shared', turnId, idempotencyKey: 'exact-steer', text: 'only this turn' });
  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return new Response('{}', { status: 503 });
      inputs.push(JSON.parse(String(init?.body)));
      if (!applied) assert.equal(agent.steerExecution(request()).status, 'queued');
      if (applied && inputs.length === 1) return Response.json({ choices: [{ message: {
        role: 'assistant', content: null, tool_calls: [{ id: 'verify-1', type: 'function', function: { name: 'verify_note', arguments: '{}' } }],
      } }] });
      return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
    }) as typeof fetch;
    const started = await agent.runWithTurn('shared', 'begin', { onDurableStart: start => {
      turnId = start.turnId;
      if (applied) {
        assert.equal(agent.steerExecution(request()).status, 'queued');
        assert.equal(agent.steerExecution(request()).status, 'queued');
      }
    } });
    await started.response;
    const serialized = JSON.stringify(inputs);
    assert.equal(serialized.includes('only this turn'), applied);
    assert.equal(inputs.length, applied ? 2 : 1);
    if (applied) for (const input of inputs) assert.equal(JSON.stringify(input).split('only this turn').length - 1, 1);
    const raw = history.loadRaw('shared') as Array<any>;
    const receipts = raw.filter(row => row.kind === 'status' && row.data.status === 'execution_control');
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].data.controlStatus, applied ? 'applied' : 'not_applied');
    assert.equal('message' in receipts[0].data, false);
    assert.ok(raw.indexOf(receipts[0]) < raw.findIndex(row => row.type === 'turn' && row.status === 'complete'));
    assert.equal(agent.steerExecution(request()).status, applied ? 'applied' : 'not_applied');
    assert.equal(JSON.stringify(history.load('shared')).includes('only this turn'), false);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    rmSync(root, { recursive: true, force: true });
  }
});
