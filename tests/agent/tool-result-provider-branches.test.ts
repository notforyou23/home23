import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';

const TOOL_NAME = 'typed_failure_tool';
const PROVIDERS = [
  'openai-codex',
  'xai',
  'openai',
  'ollama-cloud',
  'anthropic',
  'minimax',
] as const;

function sse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function finalAnthropicMessage(provider: string, content: Array<Record<string, unknown>>) {
  return {
    id: `${provider}-message`,
    type: 'message',
    role: 'assistant',
    model: `${provider}-model`,
    content,
    stop_reason: content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function messageStream(message: Record<string, unknown>) {
  return {
    async *[Symbol.asyncIterator]() {},
    async finalMessage() { return message; },
  };
}

function makeBrainOperations() {
  const base = {
    withActivityHandler(onActivity: (activity: unknown) => void) {
      return Object.freeze({ ...base, onActivity });
    },
  };
  return base;
}

async function runProvider(provider: typeof PROVIDERS[number]): Promise<{
  toolEvents: Array<Record<string, unknown>>;
  contexts: Array<Record<string, unknown>>;
  providerRequests: Array<Record<string, unknown>>;
  nativeToolResult: unknown;
}> {
  const root = join(tmpdir(), `tool-result-${provider}-${process.pid}-${Math.random()}`);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const contexts: Array<Record<string, unknown>> = [];
  const providerRequests: Array<Record<string, unknown>> = [];
  const toolEvents: Array<Record<string, unknown>> = [];
  const tool = {
    name: TOOL_NAME,
    description: 'returns one typed failure',
    input_schema: { type: 'object', properties: {} },
    execute: async (_input: Record<string, unknown>, context: Record<string, unknown>) => {
      contexts.push(context);
      return { content: 'typed failure', is_error: true };
    },
  };
  const registry = {
    getAnthropicTools: () => [{
      name: TOOL_NAME,
      description: tool.description,
      input_schema: tool.input_schema,
    }],
    getOpenAITools: () => [{
      type: 'function',
      function: {
        name: TOOL_NAME,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }],
    get: (name: string) => name === TOOL_NAME ? tool : undefined,
    execute: async (name: string, input: Record<string, unknown>, context: Record<string, unknown>) => {
      assert.equal(name, TOOL_NAME);
      return tool.execute(input, context);
    },
  };
  const contextManager = {
    getSystemPrompt: () => 'You are a test agent.',
    getPromptSourceInfo: () => ({ loadedFiles: [] }),
  };
  const model = provider === 'anthropic' ? 'claude-test'
    : provider === 'minimax' ? 'MiniMax-test'
      : provider === 'xai' ? 'grok-test'
        : provider === 'ollama-cloud' ? 'ollama-test'
          : 'gpt-5.5';
  const agent = new AgentLoop({
    apiKey: 'test-key',
    model,
    provider,
    registry: registry as never,
    contextManager: contextManager as never,
    history,
    toolContext: {
      brainOperations: makeBrainOperations(),
      turnRuntime: null,
    } as never,
    workspacePath: join(root, 'workspace'),
  });

  const originalFetch = globalThis.fetch;
  const envKeys = ['OPENAI_API_KEY', 'OLLAMA_CLOUD_API_KEY', 'XAI_API_KEY'] as const;
  const priorEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) process.env[key] = 'test-key';
  let providerCall = 0;
  let nativeToolResult: unknown = null;

  try {
    if (provider === 'openai-codex') {
      (agent as never as { codexCredentialsProvider: () => Promise<Record<string, unknown>> })
        .codexCredentialsProvider = async () => ({
          accessToken: 'test-token', refreshToken: 'refresh', expires: Date.now() + 60_000,
          accountId: 'acct-test',
        });
    }

    if (provider === 'anthropic' || provider === 'minimax') {
      let sdkCall = 0;
      (agent as never as { client: Record<string, unknown> }).client = {
        messages: {
          stream(request: Record<string, unknown>) {
            providerRequests.push(structuredClone(request));
            sdkCall += 1;
            if (sdkCall === 1) {
              return messageStream(finalAnthropicMessage(provider, [{
                type: 'tool_use', id: 'tool-1', name: TOOL_NAME, input: {},
              }]));
            }
            const messages = request.messages as Array<Record<string, unknown>>;
            const last = messages.at(-1) as { content?: Array<Record<string, unknown>> };
            nativeToolResult = last.content?.find(block => block.type === 'tool_result');
            return messageStream(finalAnthropicMessage(provider, [{ type: 'text', text: 'done' }]));
          },
        },
      };
    }

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL
        ? String(input)
        : input.url);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        return new Response('{}', { status: 503 });
      }
      if (provider === 'ollama-cloud' && url.pathname === '/api/show') {
        return Response.json({ capabilities: ['tools'] });
      }
      providerCall += 1;
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      providerRequests.push(body);

      if (provider === 'openai-codex') {
        if (providerCall === 1) return sse([{
          type: 'response.output_item.done',
          item: { type: 'function_call', call_id: 'call-1', name: TOOL_NAME, arguments: '{}' },
        }]);
        const items = body.input as Array<Record<string, unknown>>;
        nativeToolResult = items.find(item => item.type === 'function_call_output');
        return sse([{ type: 'response.output_text.done', text: 'done' }]);
      }
      if (provider === 'xai') {
        if (providerCall === 1) return sse([
          { type: 'response.created', response: { id: 'xai-response-1' } },
          { type: 'response.output_item.done', item: {
            type: 'function_call', call_id: 'call-1', name: TOOL_NAME, arguments: '{}',
          } },
        ]);
        const items = body.input as Array<Record<string, unknown>>;
        nativeToolResult = items.find(item => item.type === 'function_call_output');
        return sse([{ type: 'response.output_text.done', text: 'done' }]);
      }

      const toolCall = {
        id: 'call-1',
        type: 'function',
        function: { name: TOOL_NAME, arguments: '{}' },
      };
      if (provider === 'openai') {
        if (providerCall === 1) {
          return Response.json({ choices: [{ message: {
            role: 'assistant', content: null, tool_calls: [toolCall],
          } }] });
        }
        const messages = body.messages as Array<Record<string, unknown>>;
        nativeToolResult = messages.find(message => message.role === 'tool');
        return Response.json({ choices: [{ message: { role: 'assistant', content: 'done' } }] });
      }
      if (provider === 'ollama-cloud') {
        if (providerCall === 1) {
          return Response.json({ message: {
            role: 'assistant', content: null, tool_calls: [toolCall],
          } });
        }
        const messages = body.messages as Array<Record<string, unknown>>;
        nativeToolResult = messages.find(message => message.role === 'tool');
        return Response.json({ message: { role: 'assistant', content: 'done' } });
      }
      throw new Error(`unexpected real provider request: ${url}`);
    }) as typeof fetch;

    const started = await agent.runWithTurn(`chat-${provider}`, 'run the failure tool', {
      firstTokenTimeoutMs: 60_000,
      inactivityMs: 60_000,
      hardDurationMs: 120_000,
      onEvent: event => {
        if (event.type === 'tool_result') toolEvents.push(event as unknown as Record<string, unknown>);
      },
    });
    const result = await started.response;
    assert.equal(result.text, 'done');
    return { toolEvents, contexts, providerRequests, nativeToolResult };
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of envKeys) {
      const prior = priorEnv[key];
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test('provider branch fixture enumerates the complete configured loop branch set', () => {
  assert.deepEqual([...PROVIDERS].sort(), [
    'anthropic', 'minimax', 'ollama-cloud', 'openai', 'openai-codex', 'xai',
  ]);
});

for (const provider of PROVIDERS) {
  test(`${provider} carries truthful typed tool failure through its native continuation`, async () => {
    const result = await runProvider(provider);
    assert.equal(result.contexts.length, 1);
    assert.ok(result.contexts[0]?.turnRuntime);
    assert.deepEqual(result.toolEvents.map(event => event.success), [false]);
    assert.match(JSON.stringify(result.nativeToolResult), /typed failure/);
    if (provider === 'anthropic' || provider === 'minimax') {
      assert.equal((result.nativeToolResult as { is_error?: boolean }).is_error, true);
    }
  });
}
