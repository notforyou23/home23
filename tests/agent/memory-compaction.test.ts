import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryManager } from '../../src/agent/memory.js';
import { DefaultCompactionHooks } from '../../src/agent/compaction-hooks.js';

test('conversation memory extraction uses non-Claude agent defaults', async () => {
  const root = join(tmpdir(), `home23-memory-extract-${Date.now()}`);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });

  const prevFetch = globalThis.fetch;
  const prevKey = process.env.OLLAMA_CLOUD_API_KEY;
  process.env.OLLAMA_CLOUD_API_KEY = 'test-ollama-key';

  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body || '{}'));
    assert.equal(body.model, 'kimi-k2.6');
    return new Response(JSON.stringify({
      message: {
        content: JSON.stringify({
          type: 'procedure',
          title: 'Use agent defaults for memory',
          statement: 'Conversation compaction and extraction should use the agent default model.',
          domain: 'doctrine',
          before: 'Extraction assumed Claude.',
          after: 'Extraction follows the configured agent provider.',
          why: 'Fresh installs may use Ollama Cloud, OpenAI Codex, or another provider.',
          trigger_keywords: 'memory,compaction,provider',
          applies_to: 'home23',
          priority: 'high',
        }),
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const memory = new MemoryManager({
      client: {} as never,
      model: 'kimi-k2.6',
      provider: 'ollama-cloud',
      workspacePath: workspace,
    });
    await memory.extractAndSave('chat-1', [
      { role: 'user', content: 'Use agent defaults for all memory work.' },
      { role: 'assistant', content: 'I will route extraction through the configured provider.' },
      { role: 'user', content: 'Make this durable.' },
      { role: 'assistant', content: 'Recorded as doctrine.' },
    ], 'kimi-k2.6', 'ollama-cloud');

    const objects = JSON.parse(readFileSync(join(root, 'brain', 'memory-objects.json'), 'utf-8'));
    assert.equal(objects.objects.length, 1);
    assert.equal(objects.objects[0].title, 'Use agent defaults for memory');
    assert.equal(objects.objects[0].provenance.generation_method, 'conversation');
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = prevKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test('model extraction keeps corrections narrative without an exact claim-to-message binding', async () => {
  const root = join(tmpdir(), `home23-memory-correction-${Date.now()}`);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const prevFetch = globalThis.fetch;
  const prevKey = process.env.OLLAMA_CLOUD_API_KEY;
  process.env.OLLAMA_CLOUD_API_KEY = 'test-ollama-key';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    message: { content: JSON.stringify({
      type: 'correction', title: 'Engine is stopped', statement: 'The engine is stopped.',
      domain: 'ops', before: 'Engine was reported online.', after: 'Engine is stopped.',
      why: 'The operator corrected the report.', trigger_keywords: 'engine,status',
      applies_to: 'home23', priority: 'high',
    }) },
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

  try {
    const memory = new MemoryManager({
      client: {} as never, model: 'kimi-k2.6', provider: 'ollama-cloud', workspacePath: workspace,
    });
    await memory.extractAndSave('chat-1', [
      { role: 'user', content: 'What is the engine status?' },
      { role: 'assistant', content: 'It is online.' },
      { role: 'user', content: 'Actually, that is wrong. The engine is stopped.' },
      { role: 'assistant', content: 'Understood.' },
    ], 'kimi-k2.6', 'ollama-cloud');

    const stored = JSON.parse(readFileSync(join(root, 'brain', 'memory-objects.json'), 'utf8'));
    assert.equal(stored.objects[0].actor, 'extraction');
    assert.equal(stored.objects[0].provenance.node_profile.authorityClass, 'narrative');
    assert.deepEqual(stored.objects[0].provenance.source_refs, []);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = prevKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test('pre-compaction hook does not skip non-Claude providers', async () => {
  const hook = new DefaultCompactionHooks();
  let seenProvider = '';

  const result = await hook.preCompaction({
    chatId: 'chat-2',
    olderMessages: [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ],
    currentModel: 'kimi-k2.6',
    currentProvider: 'ollama-cloud',
    memory: {
      preCompactionExtract: async (_chatId: string, _messages: unknown, _model: string, provider: string) => {
        seenProvider = provider;
        return 'DECISIONS MADE\n- Use agent defaults.';
      },
    } as never,
  });

  assert.equal(result.extractedLearnings, true);
  assert.equal(seenProvider, 'ollama-cloud');
});
