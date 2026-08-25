import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
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
