import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCodexResponse } from '../../src/agent/codex-fetch.js';
import { nativeChessTool } from '../../src/agent/tools/channels.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { createSeededToolRegistry } from '../../src/agent/tools/index.js';

const network = (code = 'ECONNRESET') => new TypeError('secret request body token URL', {
  cause: new AggregateError([Object.assign(new Error('secret nested credentials'), { code })], 'secret aggregate'),
});
const request = (signal = new AbortController().signal) => ({ method: 'POST', body: '{"exact":"body"}', headers: { Authorization: 'secret' }, signal });
async function withFetch(stub: typeof fetch, run: () => Promise<void>) {
  const saved = globalThis.fetch; globalThis.fetch = stub;
  try { await run(); } finally { globalThis.fetch = saved; }
}
const successful = () => new Response('data: {"type":"response.output_text.delta","delta":"Done."}\n\ndata: {"type":"response.output_text.done","text":"Done."}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

test('pre-response transient failure retries once with identical body, headers and original signal', async () => {
  const seen: RequestInit[] = [];
  await withFetch((async (_url, init) => { seen.push(init!); if (seen.length === 1) throw network(); return new Response('ok'); }) as typeof fetch, async () => {
    const input = request();
    assert.equal(await (await fetchCodexResponse('https://example.invalid', input)).text(), 'ok');
    assert.equal(seen.length, 2);
    assert.equal(seen[0], seen[1]);
    assert.equal(seen[1]?.signal, input.signal);
    assert.equal(seen[1]?.body, input.body);
    assert.equal(new Headers(seen[1]?.headers).get('Authorization'), 'secret');
  });
});

test('exhaustion diagnoses safe allowlisted cause codes and never retries unknown or certificate failures', async () => {
  for (const [error, attempts] of [[network(), 2], [network('SECRET_TOKEN'), 1], [network('CERT_HAS_EXPIRED'), 1], [new TypeError('secret fetch failed'), 1]] as const) {
    let calls = 0;
    await withFetch((async () => { calls++; throw error; }) as typeof fetch, async () => {
      await assert.rejects(fetchCodexResponse('https://example.invalid', request()), failure => {
        assert.match((failure as Error).message, /codex transport failure/);
        assert.doesNotMatch((failure as Error).message, /secret|SECRET_TOKEN|https:|Authorization/);
        return true;
      });
      assert.equal(calls, attempts);
    });
  }
});

test('abort before fetch or during retry delay does not issue another request', async () => {
  for (const preAborted of [true, false]) {
    const controller = new AbortController(); let calls = 0;
    if (preAborted) controller.abort();
    await withFetch((async () => { calls++; setTimeout(() => controller.abort(), 10); throw network(); }) as typeof fetch, async () => {
      await assert.rejects(fetchCodexResponse('https://example.invalid', request(controller.signal)));
      assert.equal(calls, preAborted ? 0 : 1);
    });
  }
  let calls = 0;
  await withFetch((async () => { calls++; throw network(); }) as typeof fetch, async () => {
    await assert.rejects(fetchCodexResponse('https://example.invalid', request(AbortSignal.timeout(15))));
    assert.equal(calls, 1);
  });
});

test('HTTP responses and partial stream failures are never retried', async () => {
  for (const status of [401, 403, 429, 500]) {
    let calls = 0;
    await withFetch((async () => { calls++; return new Response('denied', { status }); }) as typeof fetch, async () => {
      assert.equal((await fetchCodexResponse('https://example.invalid', request())).status, status);
      assert.equal(calls, 1);
    });
  }
  let calls = 0;
  await withFetch((async () => { calls++; let first = true; return new Response(new ReadableStream({ pull(controller) { if (first) { first = false; controller.enqueue(new TextEncoder().encode('partial')); } else controller.error(network()); } })); }) as typeof fetch, async () => {
    const response = await fetchCodexResponse('https://example.invalid', request());
    const reader = response.body!.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'partial');
    await assert.rejects(reader.read()); assert.equal(calls, 1);
  });
});

function makeAgent(root: string, tools: unknown[] = [], model = 'gpt-5.6-sol') {
  mkdirSync(join(root, 'workspace'));
  const agent = new AgentLoop({ apiKey: 'test-key', model, provider: 'openai-codex',
    registry: { getAnthropicTools: () => [], getOpenAITools: () => tools, get: () => undefined, execute: async () => assert.fail('no tool replay') } as never,
    contextManager: { getSystemPrompt: () => 'Test.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    history: new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent'), toolContext: {} as never, workspacePath: join(root, 'workspace'),
  });
  (agent as any).codexCredentialsProvider = async () => ({ accessToken: 'test-token', refreshToken: 'test-refresh', expires: Date.now() + 3_600_000, accountId: 'test-account' });
  return agent;
}

for (const terminalOnly of [false, true]) test(`Codex replays complete reasoning and function items across tool rounds (${terminalOnly ? 'terminal' : 'stream'})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-reasoning-continuity-'));
  const requests: any[] = []; let writes = 0;
  const output = (round: number) => [
    { type: 'reasoning', id: `rs_${round}`, summary: [{ type: 'summary_text', text: `Verified step ${round}` }],
      encrypted_content: `opaque-state-${round}`, status: 'completed' },
    { type: 'function_call', id: `fc_${round}`, call_id: `call_${round}`, name: 'record_step', arguments: '{}', status: 'completed' },
  ];
  try {
    await withFetch((async (_url, init) => {
      const body = JSON.parse(String(init!.body)); requests.push(body);
      const round = requests.length;
      assert.equal(body.store, false);
      for (let prior = 1; prior < round; prior++) {
        const items = body.input;
        assert.deepEqual(items.filter((x: any) => x.id === `rs_${prior}`), [output(prior)[0]]);
        assert.deepEqual(items.filter((x: any) => x.call_id === `call_${prior}` && x.type === 'function_call'), [output(prior)[1]]);
        const index = items.findIndex((x: any) => x.id === `rs_${prior}`);
        assert.equal(items[index + 1].id, `fc_${prior}`);
        assert.deepEqual(items[index + 2], { type: 'function_call_output', call_id: `call_${prior}`, output: `receipt-${prior}` });
      }
      if (round > 1) assert.ok(body.include?.includes('reasoning.encrypted_content'));
      if (round === 3) return successful();
      const events = terminalOnly ? [] : output(round).map(item => ({ type: 'response.output_item.done', item }));
      events.push({ type: 'response.completed', response: { status: 'completed', output: output(round) } } as any);
      return new Response(events.map(x => 'data: ' + JSON.stringify(x) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch, async () => {
      const agent = makeAgent(root, [], 'gpt-6.1-sol');
      (agent as any).registry = createSeededToolRegistry([{ name: 'record_step', description: 'Record one checked step.', input_schema: { type: 'object', properties: {} },
        async execute() { return { content: `receipt-${++writes}` }; },
      }]);
      const run = await agent.runWithTurn('continuity', 'Complete two steps and confirm.');
      assert.equal((await run.response).text, 'Done.');
      assert.equal(writes, 2); assert.equal(requests.length, 3);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex never replays opaque reasoning from a failed overloaded attempt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-failed-reasoning-')); let requests = 0; let writes = 0;
  try {
    await withFetch((async (_url, init) => {
      const body = JSON.parse(String(init!.body)); requests++;
      assert.doesNotMatch(JSON.stringify(body.input), /failed-opaque-state/);
      if (requests === 1) return overloaded([{ type: 'response.output_item.done',
        item: { type: 'reasoning', id: 'rs_failed', summary: [], encrypted_content: 'failed-opaque-state' } }]);
      if (requests === 2) return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
        { type: 'reasoning', id: 'rs_good', summary: [], encrypted_content: 'good-opaque-state' },
        { type: 'function_call', call_id: 'good-call', name: 'record_step', arguments: '{}' },
      ] } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
      assert.match(JSON.stringify(body.input), /good-opaque-state/); return successful();
    }) as typeof fetch, async () => {
      const agent = makeAgent(root, [], 'gpt-6.1-sol');
      (agent as any).registry = createSeededToolRegistry([{ name: 'record_step', description: 'Record one checked step.', input_schema: { type: 'object', properties: {} },
        async execute() { writes++; return { content: 'verified receipt' }; },
      }]);
      const run = await agent.runWithTurn('failed-attempt', 'Complete the verified step.');
      assert.equal((await run.response).text, 'Done.'); assert.equal(writes, 1); assert.equal(requests, 3);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('actual Codex loop retries pre-response transport, preserves reasoning fallback and durable sanitized failure', async () => {
  for (const scenario of ['retry', 'reasoning', 'exhausted'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'codex-fetch-route-')); const bodies: any[] = [];
    try {
      await withFetch((async (_url, init) => {
        bodies.push(JSON.parse(init!.body as string));
        if (scenario === 'exhausted' || bodies.length === 1) throw network();
        if (scenario === 'reasoning' && bodies.length === 2) return new Response('reasoning summary unsupported', { status: 400 });
        return successful();
      }) as typeof fetch, async () => {
        const agent = makeAgent(root);
        const run = await agent.runWithTurn('chat-test', 'Give one answer.', { effort: 'medium' });
        if (scenario === 'exhausted') {
          await assert.rejects(run.response, /Error calling gpt-5.6-sol: codex transport failure.*ECONNRESET/);
          const persisted = readFileSync(join(root, 'conversations', 'test-agent__chat-test.jsonl'), 'utf8');
          assert.match(persisted, /"status":"error"/);
          assert.match(persisted, /ECONNRESET/);
          assert.doesNotMatch(persisted, /secret request|secret nested|Authorization|test-token/);
          assert.equal(bodies.length, 2);
        } else {
          assert.equal((await run.response).text, 'Done.');
          assert.deepEqual(bodies[0], bodies[1]);
          assert.equal(bodies.length, scenario === 'reasoning' ? 3 : 2);
          if (scenario === 'reasoning') { assert.ok(bodies[1].reasoning); assert.equal(bodies[2].reasoning, undefined); }
        }
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('actual Codex loop refreshes the exact rejected credential once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-auth-refresh-route-'));
  const providerCalls: Array<{ force: boolean; stale?: string }> = [];
  const authorizations: string[] = [];
  try {
    await withFetch((async (_url, init) => {
      const authorization = new Headers(init?.headers).get('authorization') || '';
      authorizations.push(authorization);
      if (authorizations.length === 1) return new Response('revoked', { status: 401 });
      return successful();
    }) as typeof fetch, async () => {
      const agent = makeAgent(root);
      (agent as any).codexCredentialsProvider = async (
        _signal?: AbortSignal,
        force = false,
        stale?: string,
      ) => {
        providerCalls.push({ force, ...(stale ? { stale } : {}) });
        return {
          accessToken: force ? 'rotated-token' : 'rejected-token',
          refreshToken: 'refresh-token',
          expires: Date.now() + 3_600_000,
          accountId: 'test-account',
        };
      };
      const run = await agent.runWithTurn('chat-auth-refresh', 'Give one answer.');
      assert.equal((await run.response).text, 'Done.');
    });
    assert.deepEqual(providerCalls, [
      { force: false },
      { force: true, stale: 'rejected-token' },
    ]);
    assert.deepEqual(authorizations, ['Bearer rejected-token', 'Bearer rotated-token']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function overloaded(events: Record<string, unknown>[] = []): Response {
  return new Response([...events, { type: 'response.failed', response: {
    status: 'failed', error: { code: 'server_is_overloaded', message: 'Busy, try later.' },
  } }].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

for (const scenario of ['http', 'stream', 'exhausted'] as const) test(`Codex overload ${scenario} recovery is bounded and preserves the exact request`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-overload-')); const requests: string[] = [];
  try {
    await withFetch((async (_url, init) => {
      requests.push(String(init!.body));
      if (scenario !== 'exhausted' && requests.length > 1) return successful();
      return scenario === 'http' ? Response.json({ error: { code: 'server_is_overloaded', message: 'Busy.' } }, { status: 503 }) : overloaded();
    }) as typeof fetch, async () => {
      const run = await makeAgent(root, [], 'gpt-6.1-sol').runWithTurn('overload', 'Finish this unit.', { effort: 'high' });
      if (scenario === 'exhausted') await assert.rejects(run.response, /server_is_overloaded/);
      else assert.equal((await run.response).text, 'Done.');
      assert.equal(requests.length, scenario === 'exhausted' ? 3 : 2);
      assert.ok(requests.every(body => body === requests[0]));
      assert.equal(JSON.parse(requests[0]).model, 'gpt-6.1-sol');
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const staged of ['answer', 'tool', 'arguments'] as const) test(`Codex overload after staged ${staged} does not replay output or tools`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-overload-staged-')); let requests = 0;
  const event = staged === 'answer' ? { type: 'response.output_text.delta', delta: 'Partial answer.' }
    : staged === 'arguments' ? { type: 'response.function_call_arguments.delta', delta: '{' }
      : { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'never', name: 'write_file', arguments: '{}' } };
  try {
    await withFetch((async () => { requests++; return overloaded([event]); }) as typeof fetch, async () => {
      const run = await makeAgent(root).runWithTurn('partial', 'Finish this unit.');
      await assert.rejects(run.response, /server_is_overloaded/);
      assert.equal(requests, 1);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex overload recovery after a completed tool keeps its receipt and executes that tool once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-overload-tool-')); const requests: any[] = []; let writes = 0;
  try {
    await withFetch((async (_url, init) => {
      requests.push(JSON.parse(String(init!.body)));
      if (requests.length === 1) return new Response('data: '+JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
        { type: 'function_call', call_id: 'write-one', name: 'save_unit', arguments: '{}' },
      ] } })+'\n\n', { headers: { 'content-type': 'text/event-stream' } });
      if (requests.length === 2) return overloaded();
      return successful();
    }) as typeof fetch, async () => {
      const agent = makeAgent(root);
      (agent as any).registry = createSeededToolRegistry([{ name: 'save_unit', description: 'Save the checked unit.', input_schema: { type: 'object', properties: {} },
        async execute() { writes++; writeFileSync(join(root, 'workspace/unit.md'), 'Checked source and bounded conclusion.', { flag: 'wx' });
          return { content: 'unit saved; verified receipt 123' }; },
      }]);
      const run = await agent.runWithTurn('unit', 'Save the unit and confirm its receipt.');
      assert.equal((await run.response).text, 'Done.');
      assert.equal(writes, 1);
      assert.equal(readFileSync(join(root, 'workspace/unit.md'), 'utf8'), 'Checked source and bounded conclusion.');
      assert.equal(requests.length, 3);
      assert.deepEqual(requests[1], requests[2]);
      assert.match(JSON.stringify(requests[2].input), /unit saved; verified receipt 123/);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('stopping during Codex overload backoff does not send another request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-overload-abort-')); let requests = 0;
  try {
    await withFetch((async () => { requests++; return overloaded(); }) as typeof fetch, async () => {
      const agent = makeAgent(root);
      const run = await agent.runWithTurn('abort-retry', 'Finish this unit.', { onEvent: event => {
        if (event.type === 'status' && event.status === 'provider_retry') agent.stop('abort-retry');
      } });
      await run.response.catch(() => undefined);
      assert.equal(requests, 1);
      const final = readFileSync(join(root, 'conversations/test-agent__abort-retry.jsonl'), 'utf8').trim().split('\n')
        .map(line => JSON.parse(line)).filter(row => row.type === 'turn' && row.turn_id === run.turnId).at(-1);
      assert.equal(final.status, 'stopped');
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex overload retry allowance belongs to the whole turn across tool rounds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-overload-budget-')); let requests = 0; let completedTools = 0;
  try {
    await withFetch((async () => {
      requests++;
      if (requests === 2 || requests === 4) return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [
        { type: 'function_call', call_id: `receipt-${requests}`, name: 'record_step', arguments: '{}' },
      ] } }) + '\n\n', { headers: { 'content-type': 'text/event-stream' } });
      return overloaded();
    }) as typeof fetch, async () => {
      const agent = makeAgent(root, [], 'gpt-6.1-sol');
      (agent as any).registry = createSeededToolRegistry([{ name: 'record_step', description: 'Record one checked step.', input_schema: { type: 'object', properties: {} },
        async execute() { completedTools++; return { content: `checked receipt ${completedTools}` }; },
      }]);
      const run = await agent.runWithTurn('turn-budget', 'Continue the checked steps.');
      await assert.rejects(run.response, /server_is_overloaded/);
      assert.equal(requests, 5, 'a later tool round must not receive a fresh retry allowance');
      assert.equal(completedTools, 2, 'each completed tool remains executed exactly once');
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('Codex overload retry releases an open failed stream without waiting on its cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-overload-stream-cleanup-')); let requests = 0; let cancelled = 0;
  try {
    await withFetch((async () => {
      if (++requests > 1) return successful();
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({
          type: 'response.failed', response: { error: { code: 'server_is_overloaded' } },
        }) + '\n\n')); },
        cancel() { cancelled++; return new Promise(() => {}); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch, async () => {
      const run = await makeAgent(root, [], 'gpt-6.1-sol').runWithTurn('stream-cleanup', 'Finish the checked step.');
      assert.equal((await run.response).text, 'Done.');
      assert.equal(requests, 2);
      assert.equal(cancelled, 1);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Exercise the actual request boundary, not a copied schema converter.
test('Codex request preserves optional Chess fields instead of defaulting to strict normalization', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-chess-optional-'));
  let sent: any;
  try {
    await withFetch((async (_url, init) => { sent = JSON.parse(init!.body as string); return successful(); }) as typeof fetch, async () => {
      const agent = makeAgent(root, [{ type: 'function', function: { name: nativeChessTool.name, description: nativeChessTool.description, parameters: nativeChessTool.input_schema } }]);
      const run = await agent.runWithTurn('chess-schema', 'Play one move.');
      await run.response;
    });
    const tool = sent.tools.find((item: any) => item.name === 'native_chess');
    assert.equal(tool.strict, false);
    assert.deepEqual(tool.parameters.required, ['operation']);
    assert.deepEqual(tool.parameters.properties.promotion.enum, ['q', 'r', 'b', 'n', null]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
