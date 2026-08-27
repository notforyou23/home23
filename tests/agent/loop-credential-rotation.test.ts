/**
 * AgentLoop must not hold a credential frozen at construction.
 *
 * Until 2026-08-11 it did: the Anthropic client was built once in the
 * constructor and rebuilt only on an explicit provider switch, so a running
 * harness could not see a rotated token at all — the OAuth poller had to
 * restart the process to deliver one. That restart was the last routine
 * credential restart in the house, and this is what removes the need for it.
 *
 * These tests drive the REAL loop and read the bearer token off the wire.
 * They deliberately fail every request with 400, which the Anthropic SDK does
 * not retry internally (it retries 408/409/429/5xx only), so the fetch count
 * is exactly the number of attempts the loop made — no SSE fixture needed to
 * prove which credential each attempt carried.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { _resetCredentialCache } from '../../src/agent/provider-credentials.js';

function makeAnthropicAgent(root: string): AgentLoop {
  mkdirSync(join(root, 'workspace'), { recursive: true });
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const registry = {
    getAnthropicTools: () => [],
    getOpenAITools: () => [],
    get: () => undefined,
    execute: async () => ({ content: '' }),
  };
  const contextManager = {
    getSystemPrompt: () => 'You are a test agent.',
    getPromptSourceInfo: () => ({ loadedFiles: [] }),
  };
  return new AgentLoop({
    apiKey: '',
    model: 'claude-sonnet-4-7',
    provider: 'anthropic',
    registry: registry as never,
    contextManager: contextManager as never,
    history,
    toolContext: {} as never,
    workspacePath: join(root, 'workspace'),
  });
}

function writeSecrets(path: string, token: string): void {
  writeFileSync(path, `providers:\n  anthropic:\n    apiKey: ${token}\n`);
}

/** Bearer token of each outbound Anthropic request, in order. */
function captureBearers(bearers: string[], status = 400): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const h = new Headers(init?.headers as HeadersInit);
    bearers.push(h.get('authorization') ?? h.get('x-api-key') ?? '(none)');
    return new Response('{"type":"error","error":{"message":"stub"}}', {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/**
 * The Anthropic SDK captures globalThis.fetch at CONSTRUCTION, so the stub has
 * to be installed before the agent is built — hence a factory rather than a
 * ready-made agent. Getting this wrong makes the tests hit the real API.
 */
async function withAgent(
  fn: (ctx: { makeAgent: () => AgentLoop; secretsPath: string }) => Promise<void>,
): Promise<void> {
  const root = join(tmpdir(), `loop-cred-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const secretsPath = join(root, 'secrets.yaml');
  mkdirSync(root, { recursive: true });
  const prevSecrets = process.env.HOME23_SECRETS_PATH;
  const prevAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const prevAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const prevFetch = globalThis.fetch;
  process.env.HOME23_SECRETS_PATH = secretsPath;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    writeSecrets(secretsPath, 'sk-ant-oat01-GEN1');
    _resetCredentialCache();
    await fn({ makeAgent: () => makeAnthropicAgent(root), secretsPath });
  } finally {
    globalThis.fetch = prevFetch;
    if (prevSecrets === undefined) delete process.env.HOME23_SECRETS_PATH;
    else process.env.HOME23_SECRETS_PATH = prevSecrets;
    if (prevAnthropicAuthToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = prevAnthropicAuthToken;
    if (prevAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropicApiKey;
    _resetCredentialCache();
    rmSync(root, { recursive: true, force: true });
  }
}

test('a rotated token reaches a RUNNING loop on the next turn, with no restart', async () => {
  await withAgent(async ({ makeAgent, secretsPath }) => {
    const bearers: string[] = [];
    globalThis.fetch = captureBearers(bearers);
    const agent = makeAgent();

    const first = await agent.runWithTurn('chat-1', 'hello');
    await assert.rejects(first.response);
    assert.equal(bearers[0], 'Bearer sk-ant-oat01-GEN1', 'turn 1 uses the boot credential');

    // The mirror rotates secrets.yaml under the running process.
    writeSecrets(secretsPath, 'sk-ant-oat01-GEN2');
    _resetCredentialCache(); // stands in for the 15s cache window elapsing

    const second = await agent.runWithTurn('chat-1', 'hello again');
    await assert.rejects(second.response);
    assert.equal(bearers[bearers.length - 1], 'Bearer sk-ant-oat01-GEN2',
      'turn 2 picked up the rotation without a process restart');
  });
});

test('an auth failure spends exactly one forced retry, and the retry carries the new token', async () => {
  await withAgent(async ({ makeAgent, secretsPath }) => {
    const bearers: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const h = new Headers(init?.headers as HeadersInit);
      bearers.push(h.get('authorization') ?? '(none)');
      if (bearers.length === 1) {
        // The rotation lands while this request is failing: only the forced
        // re-read can see it, because the cache window has not elapsed.
        writeSecrets(secretsPath, 'sk-ant-oat01-ROTATED');
        return new Response('{"type":"error","error":{"type":"authentication_error","message":"revoked"}}',
          { status: 401, headers: { 'content-type': 'application/json' } });
      }
      // 400 is not retried by the SDK, so the count stays honest.
      return new Response('{"type":"error","error":{"message":"stub"}}',
        { status: 400, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const agent = makeAgent();

    const { response } = await agent.runWithTurn('chat-1', 'hello');
    await assert.rejects(response);

    assert.equal(bearers.length, 2, 'exactly one retry — never a loop');
    assert.equal(bearers[0], 'Bearer sk-ant-oat01-GEN1');
    assert.equal(bearers[1], 'Bearer sk-ant-oat01-ROTATED',
      'the retry used the freshly re-read token, not the revoked one');
  });
});

test('a non-auth failure does not spend the credential retry', async () => {
  await withAgent(async ({ makeAgent }) => {
    const bearers: string[] = [];
    globalThis.fetch = captureBearers(bearers, 400);
    const agent = makeAgent();

    const { response } = await agent.runWithTurn('chat-1', 'hello');
    await assert.rejects(response);
    assert.equal(bearers.length, 1, 'a 400 is not an auth failure');
  });
});

test('an empty resolution keeps the working client — stale beats none', async () => {
  await withAgent(async ({ makeAgent, secretsPath }) => {
    const bearers: string[] = [];
    globalThis.fetch = captureBearers(bearers);
    const agent = makeAgent();

    await assert.rejects((await agent.runWithTurn('chat-1', 'one')).response);
    assert.equal(bearers[0], 'Bearer sk-ant-oat01-GEN1');

    // secrets.yaml becomes unreadable mid-run (and no env floor is set).
    rmSync(secretsPath, { force: true });
    _resetCredentialCache();

    // Watch the log too, not just the wire. Keeping the old client is also
    // what happens if the loop TRIES to rebuild and the SDK rejects the empty
    // credential — the outcome looks identical on the wire, so without this
    // the explicit empty-resolution guard would be untested (verified: it
    // survives a mutation that removes it). A rebuild attempt is audible.
    const prevWarn = console.warn;
    const prevLog = console.log;
    const noise: string[] = [];
    console.warn = (...a: unknown[]) => { noise.push(String(a[0])); };
    console.log = (...a: unknown[]) => { noise.push(String(a[0])); };
    try {
      await assert.rejects((await agent.runWithTurn('chat-1', 'two')).response);
    } finally {
      console.warn = prevWarn;
      console.log = prevLog;
    }

    assert.equal(bearers[bearers.length - 1], 'Bearer sk-ant-oat01-GEN1',
      'the loop kept the credential it had rather than dropping to none');
    assert.equal(noise.some(l => l.includes('credential rebuild failed')), false,
      'no rebuild was even attempted — the guard returned before constructing');
    assert.equal(noise.some(l => l.includes('credential rotated')), false,
      'and nothing was reported as a rotation');
  });
});
