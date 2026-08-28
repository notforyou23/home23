import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
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

function messageStream(
  message: Record<string, unknown>,
  events: Array<Record<string, unknown>> = [],
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
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
  thinkingEvents: Array<Record<string, unknown>>;
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
  const thinkingEvents: Array<Record<string, unknown>> = [];
  const tool = {
    name: TOOL_NAME,
    description: 'returns one typed failure',
    input_schema: {
      type: 'object',
      properties: {
        operationId: { type: 'string' },
        query: { type: 'string' },
      },
      oneOf: [
        {
          type: 'object',
          required: ['operationId'],
          allOf: [{ oneOf: [{ required: ['operationId'] }, { not: { required: ['query'] } }] }],
        },
        { type: 'object', required: ['query'] },
      ],
    },
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
              }]), provider === 'anthropic' ? [
                {
                  type: 'content_block_delta',
                  delta: { type: 'thinking_delta', thinking: 'Checking the local tool first. ' },
                },
                {
                  type: 'content_block_delta',
                  delta: { type: 'thinking_delta', thinking: 'Then I will report the typed failure honestly.' },
                },
              ] : []);
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
        if (providerCall === 1) return sse([
          { type: 'response.reasoning_summary_text.delta', delta: 'Need the tool.' },
          { type: 'response.reasoning_summary_text.done', text: 'Need the tool.' },
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', call_id: 'call-1', name: TOOL_NAME, arguments: '{}' },
          },
        ]);
        const items = body.input as Array<Record<string, unknown>>;
        nativeToolResult = items.find(item => item.type === 'function_call_output');
        return sse([{ type: 'response.output_text.done', text: 'done' }]);
      }
      if (provider === 'xai') {
        if (providerCall === 1) return sse([
          { type: 'response.created', response: { id: 'xai-response-1' } },
          { type: 'response.output_item.done', item: {
            type: 'web_search_call', status: 'failed', query: 'test query',
            error: { message: 'server search failed' },
          } },
          { type: 'response.output_item.done', item: {
            type: 'function_call', call_id: 'call-1', name: TOOL_NAME, arguments: '{}',
          } },
          { type: 'response.completed', response: { id: 'xai-response-1', status: 'completed' } },
        ]);
        const items = body.input as Array<Record<string, unknown>>;
        nativeToolResult = items.find(item => item.type === 'function_call_output');
        return sse([
          { type: 'response.output_text.done', text: 'done' },
          { type: 'response.completed', response: { id: 'xai-response-2', status: 'completed' } },
        ]);
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
        if (event.type === 'thinking') thinkingEvents.push(event as unknown as Record<string, unknown>);
      },
    });
    const result = await started.response;
    assert.equal(result.text, 'done');
    return { toolEvents, thinkingEvents, contexts, providerRequests, nativeToolResult };
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
    assert.deepEqual(
      result.toolEvents.map(event => event.success),
      provider === 'xai' ? [false, false] : [false],
    );
    if (provider === 'xai') {
      assert.match(String(result.toolEvents[0]?.result), /failed/i);
    }
    assert.match(JSON.stringify(result.nativeToolResult), /typed failure/);
    if (provider === 'anthropic' || provider === 'minimax') {
      assert.equal((result.nativeToolResult as { is_error?: boolean }).is_error, true);
    }
  });
}

test('openai-codex requests a reasoning summary and emits thinking events', async () => {
  const result = await runProvider('openai-codex');
  assert.deepEqual(result.providerRequests[0]?.reasoning, { effort: 'medium', summary: 'auto' });
  assert.equal(result.thinkingEvents.map(event => event.content).join(''), 'Need the tool.');
});

test('anthropic enables extended thinking for default effort', async () => {
  const result = await runProvider('anthropic');
  assert.deepEqual(result.providerRequests[0]?.thinking, { type: 'enabled', budget_tokens: 8000 });
  assert.equal(result.providerRequests[0]?.temperature, 1);
  assert.equal(
    result.thinkingEvents.map(event => event.content).join(''),
    'Checking the local tool first. Then I will report the typed failure honestly.',
  );
});

test('minimax does not enable anthropic extended thinking', async () => {
  const result = await runProvider('minimax');
  assert.equal(result.providerRequests[0]?.thinking, undefined);
});

test('xAI receives an object-root schema without unsupported composition keywords', async () => {
  const result = await runProvider('xai');
  const tools = result.providerRequests[0]?.tools as Array<Record<string, unknown>>;
  const localTool = tools.find(tool => tool.name === TOOL_NAME)!;
  const schema = localTool.parameters as Record<string, unknown>;
  assert.equal(schema.type, 'object');
  const serialized = JSON.stringify(schema);
  for (const keyword of ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else']) {
    assert.doesNotMatch(serialized, new RegExp(`"${keyword}"`));
  }
});

const GROK_ZDR_TOOL = 'lookup_local_fact';

async function runGrokZdrScenario(rejectPreviousResponseId: boolean): Promise<{
  resultText: string;
  requests: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  persistedEvents: Array<Record<string, unknown>>;
  terminalRecord: Record<string, unknown>;
}> {
  const root = join(tmpdir(), `grok-zdr-${process.pid}-${Math.random()}`);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const requests: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const tool = {
    name: GROK_ZDR_TOOL,
    description: 'Look up one local fact',
    input_schema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
    },
    execute: async () => ({ content: 'local result for ZDR' }),
  };
  const registry = {
    getAnthropicTools: () => [{
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }],
    getOpenAITools: () => [{
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }],
    get: (name: string) => name === tool.name ? tool : undefined,
    execute: async (name: string) => {
      assert.equal(name, tool.name);
      return tool.execute();
    },
  };
  const agent = new AgentLoop({
    apiKey: 'test-key',
    model: 'grok-test',
    provider: 'xai',
    registry: registry as never,
    contextManager: {
      getSystemPrompt: () => 'You are a test agent.',
      getPromptSourceInfo: () => ({ loadedFiles: [] }),
    } as never,
    history,
    toolContext: {
      brainOperations: makeBrainOperations(),
      turnRuntime: null,
    } as never,
    workspacePath: join(root, 'workspace'),
  });

  const originalFetch = globalThis.fetch;
  const previousXaiKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'test-key';
  let xaiCall = 0;
  const chatId = `chat-grok-zdr-${rejectPreviousResponseId ? 'strict' : 'events'}`;

  try {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' || input instanceof URL
        ? String(input)
        : input.url);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        return new Response('{}', { status: 503 });
      }
      assert.equal(url.href, 'https://api.x.ai/v1/responses');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(structuredClone(body));
      xaiCall += 1;

      if (xaiCall === 1) {
        return sse([
          { type: 'response.created', response: { id: 'xai-response-zdr-1' } },
          { type: 'response.reasoning_text.delta', delta: 'Need' },
          { type: 'response.reasoning_text.delta', delta: ' the' },
          { type: 'response.reasoning_text.delta', delta: ' local' },
          { type: 'response.reasoning_text.delta', delta: ' result.' },
          { type: 'response.reasoning_text.done', text: 'Need the local result.' },
          { type: 'response.reasoning_summary_text.delta', delta: '**Need the local result**' },
          { type: 'response.reasoning_summary_text.done', text: '**Need the local result**' },
          {
            type: 'response.output_item.done',
            item: {
              type: 'reasoning',
              id: 'reasoning-1',
              encrypted_content: 'opaque-reasoning-1',
            },
          },
          {
            type: 'response.output_item.done',
            item: {
              type: 'function_call',
              id: 'function-call-1',
              status: 'completed',
              call_id: 'call-1',
              name: GROK_ZDR_TOOL,
              arguments: '{"topic":"zdr"}',
            },
          },
          { type: 'response.completed', response: { id: 'xai-response-zdr-1', status: 'completed' } },
        ]);
      }

      if (rejectPreviousResponseId && Object.hasOwn(body, 'previous_response_id')) {
        return new Response(
          'Previous response cannot be used for this organization due to Zero Data Retention',
          { status: 404 },
        );
      }

      return sse([
        { type: 'response.reasoning_text.delta', delta: 'Use' },
        { type: 'response.reasoning_text.delta', delta: ' that' },
        { type: 'response.reasoning_text.delta', delta: ' result.' },
        { type: 'response.reasoning_text.done', text: 'Use that result.' },
        { type: 'response.reasoning_summary_text.delta', delta: '**Use that result**' },
        { type: 'response.reasoning_summary_text.done', text: '**Use that result**' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'reasoning',
            id: 'reasoning-2',
            encrypted_content: 'opaque-reasoning-2',
          },
        },
        { type: 'response.output_text.delta', delta: 'Final ' },
        { type: 'response.output_text.delta', delta: 'answer.' },
        { type: 'response.output_text.done', text: 'Final answer.' },
        { type: 'response.completed', response: { id: 'xai-response-zdr-2', status: 'completed' } },
      ]);
    }) as typeof fetch;

    const started = await agent.runWithTurn(chatId, 'Use the local lookup', {
      firstTokenTimeoutMs: 60_000,
      inactivityMs: 60_000,
      hardDurationMs: 120_000,
      onEvent: event => events.push(event as unknown as Record<string, unknown>),
    });
    const result = await started.response;
    const records = readFileSync(
      join(root, 'conversations', `test-agent__${chatId}.jsonl`),
      'utf8',
    ).trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
    const persistedEvents = records.filter(record => record.type === 'event');
    const terminalRecord = records.findLast(record =>
      record.type === 'turn' && record.status === 'complete')!;
    return {
      resultText: result.text,
      requests,
      events,
      persistedEvents,
      terminalRecord,
    };
  } finally {
    globalThis.fetch = originalFetch;
    if (previousXaiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousXaiKey;
    rmSync(root, { recursive: true, force: true });
  }
}

test('xAI Grok continues a local tool call statelessly under ZDR', async () => {
  const result = await runGrokZdrScenario(true);
  assert.equal(result.resultText, 'Final answer.');
  assert.equal(result.requests.length, 2);
  for (const request of result.requests) {
    assert.equal(Object.hasOwn(request, 'previous_response_id'), false);
    assert.deepEqual(request.include, ['reasoning.encrypted_content']);
  }

  const initialInput = result.requests[0]!.input as Array<Record<string, unknown>>;
  const followupInput = result.requests[1]!.input as Array<Record<string, unknown>>;
  assert.deepEqual(followupInput.slice(0, initialInput.length), initialInput);
  assert.deepEqual(followupInput.slice(initialInput.length), [
    {
      type: 'reasoning',
      id: 'reasoning-1',
      encrypted_content: 'opaque-reasoning-1',
    },
    {
      type: 'function_call',
      id: 'function-call-1',
      status: 'completed',
      call_id: 'call-1',
      name: GROK_ZDR_TOOL,
      arguments: '{"topic":"zdr"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'local result for ZDR',
    },
  ]);
});

test('xAI Grok preserves both reasoning channels and stable tool/result identity in order', async () => {
  const result = await runGrokZdrScenario(false);
  const full = result.events.filter(event => event.type === 'thinking'
      && event.provenance === 'provider_verbatim_reasoning')
    .map(event => event.content).join('');
  const summaries = result.events.filter(event => event.type === 'thinking'
      && event.provenance === 'provider_reasoning_summary')
    .map(event => event.content).join('');
  assert.equal(full, 'Need the local result.Use that result.');
  assert.equal(summaries, '**Need the local result****Use that result**');
  const toolStart = result.events.find(event => event.type === 'tool_start')!;
  const toolResult = result.events.find(event => event.type === 'tool_result')!;
  assert.equal(toolStart.toolCallId, 'call-1');
  assert.equal(toolResult.toolCallId, toolStart.toolCallId);
  assert.equal(toolResult.exactResult, 'local result for ZDR');
  assert.deepEqual(toolStart.args, { topic: 'zdr' });

  const responseChunks = result.events
    .filter(event => event.type === 'response_chunk')
    .map(event => event.chunk);
  assert.equal(responseChunks.join(''), result.resultText);
  assert.ok(
    result.events.findIndex(event => event.type === 'response_chunk')
      > result.events.findIndex(event => event.type === 'tool_result'),
  );
  assert.deepEqual(
    result.persistedEvents.map(event => event.seq),
    result.persistedEvents.map((_, index) => index + 1),
  );
  assert.equal(result.terminalRecord.last_seq, result.persistedEvents.length);
});

type GrokTerminalCase = 'completed' | 'failed' | 'incomplete' | 'eof';

async function runGrokTerminalCase(terminalCase: GrokTerminalCase): Promise<{
  resultText: string | null;
  error: Error | null;
  requestCount: number;
  toolExecutions: number;
  responseChunks: string[];
  records: Array<Record<string, unknown>>;
}> {
  const root = join(tmpdir(), `grok-terminal-${terminalCase}-${process.pid}-${Math.random()}`);
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  let toolExecutions = 0;
  const tool = {
    name: GROK_ZDR_TOOL,
    description: 'Look up one local fact',
    input_schema: {
      type: 'object',
      properties: { topic: { type: 'string' } },
      required: ['topic'],
    },
    execute: async () => {
      toolExecutions += 1;
      return { content: 'local result that must not run' };
    },
  };
  const registry = {
    getAnthropicTools: () => [],
    getOpenAITools: () => [{
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }],
    get: (name: string) => name === tool.name ? tool : undefined,
    execute: async (name: string) => {
      assert.equal(name, tool.name);
      return tool.execute();
    },
  };
  const agent = new AgentLoop({
    apiKey: 'test-key',
    model: 'grok-test',
    provider: 'xai',
    registry: registry as never,
    contextManager: {
      getSystemPrompt: () => 'You are a test agent.',
      getPromptSourceInfo: () => ({ loadedFiles: [] }),
    } as never,
    history,
    toolContext: {
      brainOperations: makeBrainOperations(),
      turnRuntime: null,
    } as never,
    workspacePath: join(root, 'workspace'),
  });

  const originalFetch = globalThis.fetch;
  const previousXaiKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'test-key';
  let requestCount = 0;
  const responseChunks: string[] = [];
  const chatId = `chat-grok-terminal-${terminalCase}`;

  try {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL
        ? String(input)
        : input.url);
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
        return new Response('{}', { status: 503 });
      }
      assert.equal(url.href, 'https://api.x.ai/v1/responses');
      requestCount += 1;

      if (requestCount > 1) {
        return sse([
          { type: 'response.output_text.delta', delta: 'unsafe retry answer' },
          { type: 'response.output_text.done', text: 'unsafe retry answer' },
          { type: 'response.completed', response: { id: 'xai-unsafe-retry', status: 'completed' } },
        ]);
      }

      if (terminalCase === 'completed') {
        return sse([
          { type: 'response.created', response: { id: 'xai-completed' } },
          { type: 'response.output_text.delta', delta: 'Complete answer.' },
          { type: 'response.output_text.done', text: 'Complete answer.' },
          { type: 'response.completed', response: { id: 'xai-completed', status: 'completed' } },
        ]);
      }

      const events: Array<Record<string, unknown>> = [
        { type: 'response.created', response: { id: `xai-${terminalCase}` } },
        { type: 'response.output_text.delta', delta: 'Partial output.' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            id: 'function-call-terminal',
            status: 'completed',
            call_id: 'call-terminal',
            name: GROK_ZDR_TOOL,
            arguments: '{"topic":"terminal"}',
          },
        },
      ];
      if (terminalCase === 'failed') {
        events.push({
          type: 'response.failed',
          response: {
            id: 'xai-failed',
            status: 'failed',
            error: { code: 'server_error', message: 'upstream exploded' },
          },
        });
      } else if (terminalCase === 'incomplete') {
        events.push({
          type: 'response.incomplete',
          response: {
            id: 'xai-incomplete',
            status: 'incomplete',
            incomplete_details: { reason: 'max_output_tokens' },
          },
        });
      }
      return sse(events);
    }) as typeof fetch;

    const started = await agent.runWithTurn(chatId, 'Give me a terminal response', {
      firstTokenTimeoutMs: 60_000,
      inactivityMs: 60_000,
      hardDurationMs: 120_000,
      onEvent: event => {
        if (event.type === 'response_chunk') responseChunks.push(event.chunk);
      },
    });
    let resultText: string | null = null;
    let error: Error | null = null;
    try {
      resultText = (await started.response).text;
    } catch (caught) {
      error = caught instanceof Error ? caught : new Error(String(caught));
    }
    return {
      resultText,
      error,
      requestCount,
      toolExecutions,
      responseChunks,
      records: history.loadRaw(chatId) as Array<Record<string, unknown>>,
    };
  } finally {
    globalThis.fetch = originalFetch;
    if (previousXaiKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousXaiKey;
    rmSync(root, { recursive: true, force: true });
  }
}

test('xAI Grok accepts output only after response.completed', async () => {
  const result = await runGrokTerminalCase('completed');
  assert.equal(result.error, null);
  assert.equal(result.resultText, 'Complete answer.');
  assert.equal(result.requestCount, 1);
  assert.equal(result.toolExecutions, 0);
  assert.deepEqual(result.responseChunks, ['Complete answer.']);
  assert.equal(result.records.findLast(record => record.type === 'turn')?.status, 'complete');
  assert.ok(result.records.some(record =>
    record.role === 'assistant' && record.content === 'Complete answer.' && !Object.hasOwn(record, 'type')));
});

for (const terminalCase of ['failed', 'incomplete', 'eof'] as const) {
  test(`xAI Grok rejects partial output on ${terminalCase} before executing tools`, async () => {
    const result = await runGrokTerminalCase(terminalCase);
    assert.equal(result.resultText, null);
    assert.ok(result.error);
    if (terminalCase === 'failed') {
      assert.match(result.error.message, /xai responses failed.*server_error.*upstream exploded/i);
    } else if (terminalCase === 'incomplete') {
      assert.match(result.error.message, /xai responses incomplete.*max_output_tokens/i);
    } else {
      assert.match(result.error.message, /xai responses stream ended before response\.completed/i);
    }
    assert.equal(result.requestCount, 1);
    assert.equal(result.toolExecutions, 0);
    assert.deepEqual(result.responseChunks, ['Partial output.']);
    assert.equal(result.records.findLast(record => record.type === 'turn')?.status, 'error');
    assert.equal(result.records.some(record => record.type === 'turn' && record.status === 'complete'), false);
    assert.equal(result.records.some(record =>
      record.role === 'assistant' && !Object.hasOwn(record, 'type')), false);
  });
}
