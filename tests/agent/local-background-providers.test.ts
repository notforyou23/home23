import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { CompactionManager } from '../../src/agent/compaction.js';
import { PromoterWorker, resolvePromoterModel } from '../../src/workers/promoter.js';
import type { TextGenerationOptions } from '../../src/agent/text-generation.js';

test('home startup preserves existing cloud output allowance and honors explicit local budgets', () => {
  const source = readFileSync(new URL('../../src/home.ts', import.meta.url), 'utf8');
  const wiring = source.match(/  const agent = new AgentLoop\(\{[\s\S]*?\n  \}\);/)?.[0];
  assert.ok(wiring, 'actual home AgentLoop wiring must be present');
  for (const [provider, configured, expected] of [
    ['openai-codex', 4096, 8192], ['anthropic', 4096, 8192],
    ['ollama-cloud', 4096, 8192], ['ollama-local', 512, 512],
    ['ollama-local', undefined, 8192],
  ] as const) {
    const actual = runInNewContext(`${wiring}\nagent.options.maxTokens`, {
      AgentLoop: class { constructor(public options: unknown) {} },
      authToken: '', startupBaseURL: undefined, startupModel: 'fixture', startupProvider: provider,
      config: { chat: { maxTokens: configured } }, CACHE_DIAGNOSTICS_ENABLED: false,
      registry: {}, contextManager: {}, history: {}, toolContext: {}, workspacePath: '/fixture', compaction: {},
    });
    assert.equal(actual, expected, provider);
  }
});

test('compaction follows a cloud-to-local model switch without retaining cloud endpoint or client', async () => {
  const requests: TextGenerationOptions[] = [];
  const writes: unknown[] = [];
  const manager = new CompactionManager({
    client: { marker: 'old-cloud-client' } as never, provider: 'openai', model: 'gpt-old', apiKey: 'old-key', baseURL: 'https://cloud.invalid/v1',
    history: { budget: 100000, estimateChars: (items: unknown[]) => JSON.stringify(items).length,
      compact: (_chat: string, messages: unknown) => writes.push(messages) } as never,
    memory: {} as never, config: { keepRecentMessages: 2 },
    hooks: { preCompaction: async () => ({ extractedLearnings: false }), postCompaction: async () => ({ recoveryBundle: null }) },
    resolveProviderConfig: provider => provider === 'ollama-local' ? { apiKey: '', baseURL: 'http://127.0.0.1:11434' } : {},
    generate: async request => { requests.push(request); return 'Earlier constraint: keep the original evidence.'; },
  });
  const messages = [{ role: 'user' as const, content: 'Keep original evidence. '.repeat(200) }, { role: 'assistant' as const, content: 'Understood.' },
    { role: 'user' as const, content: 'Continue locally.' }, { role: 'assistant' as const, content: 'Continuing.' }];
  const result = await manager.compact('test', messages, 'local-fixture', 'ollama-local');
  assert.equal(result.result.compacted, true);
  assert.equal(writes.length, 1);
  assert.equal(requests[0]?.provider, 'ollama-local');
  assert.equal(requests[0]?.model, 'local-fixture');
  assert.equal(requests[0]?.baseURL, 'http://127.0.0.1:11434');
  assert.equal(requests[0]?.apiKey, '');
  assert.equal(requests[0]?.client, undefined);
});

test('promoter follows local selection and honors explicit model binding', () => {
  assert.deepEqual(resolvePromoterModel(undefined, { provider: 'ollama-local', model: 'local-fixture' }), { provider: 'ollama-local', model: 'local-fixture' });
  assert.deepEqual(resolvePromoterModel(undefined, { provider: 'openai', model: 'gpt-fixture' }), { provider: 'anthropic', model: 'claude-haiku-4-5' });
  assert.deepEqual(resolvePromoterModel({ model: 'specialist' }, { provider: 'ollama-local', model: 'chat-fixture' },
    { specialist: { provider: 'ollama-local', model: 'classifier-fixture' } }), { provider: 'ollama-local', model: 'classifier-fixture' });
  assert.throws(() => resolvePromoterModel({ model: 'unknown' }, { provider: 'ollama-local', model: 'chat' }), /Unknown promoter/);
});

test('promoter classification uses the injected generation boundary with completion and output bounds', async t => {
  const brain = mkdtempSync(join(tmpdir(), 'home23-promoter-local-'));
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; rmSync(brain, { recursive: true, force: true }); });
  globalThis.fetch = (async () => Response.json({ promptText: '' })) as typeof fetch;
  writeFileSync(join(brain, 'notifications.jsonl'), JSON.stringify({ id: 'note-1', message: 'This concern cannot be verified automatically.', source: 'fixture', ts: new Date().toISOString() })+'\n');
  const requests: TextGenerationOptions[] = [];
  const promoter = new PromoterWorker({ brainDir: brain, dashboardBaseUrl: 'http://fixture.invalid', model: 'local-fixture',
    generate: async request => { requests.push(request); return '{"verifiable":false,"reason":"No objective check"}'; },
    logger: { info() {}, warn() {}, error() {} },
  });
  await promoter.tick();
  promoter.stop();
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.requireComplete, true);
  assert.equal(requests[0]?.maxTokens, 600);
  assert.equal(JSON.parse(readFileSync(join(brain, 'promoter-state.json'), 'utf8')).processed['note-1'].outcome, 'unverifiable');
});
