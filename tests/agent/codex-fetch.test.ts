import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCodexResponse } from '../../src/agent/codex-fetch.js';
import { nativeChessTool } from '../../src/agent/tools/channels.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';

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

function makeAgent(root: string, tools: unknown[] = []) {
  mkdirSync(join(root, 'workspace'));
  const agent = new AgentLoop({ apiKey: 'test-key', model: 'gpt-5.6-sol', provider: 'openai-codex',
    registry: { getAnthropicTools: () => [], getOpenAITools: () => tools, get: () => undefined, execute: async () => assert.fail('no tool replay') } as never,
    contextManager: { getSystemPrompt: () => 'Test.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    history: new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent'), toolContext: {} as never, workspacePath: join(root, 'workspace'),
  });
  (agent as any).codexCredentialsProvider = async () => ({ accessToken: 'test-token', refreshToken: 'test-refresh', expires: Date.now() + 3_600_000, accountId: 'test-account' });
  return agent;
}

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
