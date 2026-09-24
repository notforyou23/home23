import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryManager } from '../../src/agent/memory.js';
import { DefaultCompactionHooks } from '../../src/agent/compaction-hooks.js';
import lockfile from 'proper-lockfile';

test('memory extraction retries a brief engine lock and saves the object', async () => {
  const root = join(tmpdir(), `home23-memory-locked-extract-${Date.now()}`);
  const workspace = join(root, 'workspace');
  const brain = join(root, 'brain');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(brain, { recursive: true });
  const file = join(brain, 'memory-objects.json');
  writeFileSync(file, '{"objects":[]}');
  const release = lockfile.lockSync(file);
  const unlockTimer = setTimeout(release, 80);
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OLLAMA_CLOUD_API_KEY;
  process.env.OLLAMA_CLOUD_API_KEY = 'test-ollama-key';
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: { content: JSON.stringify({
    type: 'procedure', title: 'Preserve this memory', statement: 'The engine and harness share memory.',
    domain: 'ops', before: '', after: 'Both writers retain updates.', why: 'Shared writer lock.',
    trigger_keywords: 'memory', applies_to: 'home23', priority: 'high',
  }) } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const manager = new MemoryManager({ client: {} as never, model: 'kimi-k2.6',
      provider: 'ollama-cloud', workspacePath: workspace });
    await manager.extractAndSave('chat-locked', [
      { role: 'user', content: 'Remember the shared writer.' },
      { role: 'assistant', content: 'I will.' },
      { role: 'user', content: 'Preserve this memory.' },
      { role: 'assistant', content: 'Saved.' },
    ], 'kimi-k2.6', 'ollama-cloud');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).objects[0].title, 'Preserve this memory');
  } finally {
    clearTimeout(unlockTimer);
    try { release(); } catch { /* The timer may have released it already. */ }
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  }
});

test('memory extraction reports an unsaved object when engine lock persists', async () => {
  const root = join(tmpdir(), `home23-memory-busy-extract-${Date.now()}`);
  const workspace = join(root, 'workspace');
  const brain = join(root, 'brain');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(brain, { recursive: true });
  const file = join(brain, 'memory-objects.json');
  writeFileSync(file, '{"objects":[]}');
  const release = lockfile.lockSync(file);
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OLLAMA_CLOUD_API_KEY;
  const previousLog = console.log;
  const previousWarn = console.warn;
  const logs: string[] = [];
  const warnings: string[] = [];
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
  process.env.OLLAMA_CLOUD_API_KEY = 'test-ollama-key';
  globalThis.fetch = (async () => new Response(JSON.stringify({ message: { content: JSON.stringify({
    type: 'procedure', title: 'Busy memory', statement: 'Must not claim saved.', domain: 'ops',
    before: '', after: 'Save when possible.', why: 'Engine lock.', trigger_keywords: 'busy',
    applies_to: 'home23', priority: 'high',
  }) } }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const manager = new MemoryManager({ client: {} as never, model: 'kimi-k2.6',
      provider: 'ollama-cloud', workspacePath: workspace });
    await manager.extractAndSave('chat-busy', [
      { role: 'user', content: 'Remember this.' }, { role: 'assistant', content: 'Okay.' },
      { role: 'user', content: 'Did you save it?' }, { role: 'assistant', content: 'Checking.' },
    ], 'kimi-k2.6', 'ollama-cloud');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).objects.length, 0);
    assert.ok(warnings.some(line => line.includes('were not saved for chat-busy')));
    assert.ok(!logs.some(line => line.includes('Extracted and saved')));
  } finally {
    release();
    globalThis.fetch = previousFetch;
    console.log = previousLog;
    console.warn = previousWarn;
    if (previousKey === undefined) delete process.env.OLLAMA_CLOUD_API_KEY;
    else process.env.OLLAMA_CLOUD_API_KEY = previousKey;
    rmSync(root, { recursive: true, force: true });
  }
});

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

for (const failure of [false, true]) test(`compaction preserves late constraints and original history on failure=${failure}`, async () => {
  const { CompactionManager } = await import('../../src/agent/compaction.js');
  const requests: string[] = [];
  const writes: unknown[] = [];
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OLLAMA_CLOUD_API_KEY;
  process.env.OLLAMA_CLOUD_API_KEY = 'test-key';
  const marker = 'USER LIMIT: only edit /tmp/owned.ts; do not deploy; retain cj_exact_123.';
  const messages = [
    { role: 'user' as const, content: 'Context '.repeat(5000) + marker },
    { role: 'assistant' as const, content: 'Proposed plan only; no files changed.' },
    { role: 'user' as const, content: 'Correction: stop the deployment and finish only the local check.' },
    { role: 'assistant' as const, content: 'Current reply.' },
  ];
  globalThis.fetch = (async (_url, init) => {
    requests.push(String(init?.body));
    return Response.json({ message: { content: failure ? '' : 'Local check pending; no deployment authorized. Handle cj_exact_123.' } });
  }) as typeof fetch;
  try {
    const manager = new CompactionManager({
      client: {} as never, provider: 'ollama-cloud', model: 'kimi-k2.6',
      history: { estimateChars: (items: unknown[]) => JSON.stringify(items).length, compact: (_id: string, records: unknown) => writes.push(records) } as never,
      memory: {} as never,
      hooks: { preCompaction: async () => ({ extractedLearnings: false }), postCompaction: async () => ({ recoveryBundle: null }) },
      config: { keepRecentMessages: 2 },
    });
    const result = await manager.compact('test', messages);
    if (failure) {
      assert.equal(result.result.compacted, false);
      assert.deepEqual(result.messages, messages);
      assert.equal(writes.length, 0, 'failed summarization must not rewrite history');
    } else {
      assert.equal(result.result.compacted, true);
      assert.equal(writes.length, 1);
      assert.ok(requests.some(request => request.includes(marker)), 'constraint after character 500 must reach summarizer');
      assert.ok(result.messages.some(message => String(message.content).includes('Correction: stop the deployment')));
      assert.ok(requests.length >= 3, 'all segments reach summarization and chronological combination');
      assert.equal(result.messages.at(-1)?.content, 'Current reply.');
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OLLAMA_CLOUD_API_KEY; else process.env.OLLAMA_CLOUD_API_KEY = previousKey;
  }
});
