import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';
import { TurnStore } from '../../src/chat/turn-store.js';
import { providerReasoningParameters, resolveConfiguredReasoningEffort } from '../../src/agent/reasoning-effort.js';

const { registerModelCapabilities, modelCapabilities } = createRequire(import.meta.url)('../../shared/responses-reasoning.cjs');
const { normalizeProviderModel, createModelDiscovery } = createRequire(import.meta.url)('../../shared/model-discovery.cjs');
const cloudCases = [
  { model: 'deepseek-v4.1-flash', options: ['none', 'low', 'high', 'max'], defaultEffort: 'high' },
  { model: 'deepseek-v4.1-flash:1017', options: ['none', 'low', 'high', 'max'], defaultEffort: 'high' },
  { model: 'glm-5.3', options: ['low', 'high', 'max'], defaultEffort: 'max' },
];
const capabilities = (row: typeof cloudCases[number]) => normalizeProviderModel('ollama-cloud', {
  name: row.model, capabilities: ['completion', 'tools'],
  thinking: { values: row.options.map(value => value === 'none' ? false : value), default: row.defaultEffort },
});

for (const row of cloudCases) test(`${row.model} resolves only an unsupported inherited house effort`, () => {
  const caps = capabilities(row);
  assert.equal(resolveConfiguredReasoningEffort(row.model, 'medium', undefined, 'ollama-cloud', caps), row.defaultEffort);
  assert.equal(resolveConfiguredReasoningEffort(row.model, undefined, undefined, 'ollama-cloud', caps), row.defaultEffort);
  assert.equal(resolveConfiguredReasoningEffort(row.model, 'low', undefined, 'ollama-cloud', caps), 'low');
  assert.equal(resolveConfiguredReasoningEffort(row.model, 'medium', { [row.model]: 'low' }, 'ollama-cloud', caps), 'low');
  const explicitPin = resolveConfiguredReasoningEffort(row.model, 'high', { [row.model]: 'medium' }, 'ollama-cloud', caps);
  assert.equal(explicitPin, 'medium');
  assert.throws(() => providerReasoningParameters('ollama-cloud', row.model, explicitPin, caps), /medium is unavailable/);
});

test('unknown, non-reasoning and malformed capability defaults do not authorize a guessed fallback', () => {
  const base = capabilities(cloudCases[2]!);
  for (const caps of [null, { ...base, reasoningCapabilitiesKnown: false }, { ...base, reasoningCapabilitiesKnown: undefined },
    { ...base, reasoningTransport: null }, { ...base, reasoningTransport: 'garbage' },
    { ...base, defaultReasoningEffortAdvertised: false }, { ...base, defaultReasoningEffortAdvertised: undefined },
    { ...base, defaultReasoningEffortOption: null }, { ...base, defaultReasoningEffortOption: 'unadvertised' },
    { ...base, reasoningEffortOptions: null }]) {
    assert.equal(resolveConfiguredReasoningEffort('fixture-model', 'medium', undefined, 'ollama-cloud', caps), 'medium');
  }
  assert.equal(resolveConfiguredReasoningEffort('fixture-unknown', 'medium', undefined, 'fixture-unknown'), 'medium');
  assert.equal(resolveConfiguredReasoningEffort('gpt-6.1-terra', 'ultra'), 'ultra');
});

test('only Ollama Cloud adapts inherited effort; other providers retain their existing setting', () => {
  for (const provider of ['ollama-local', 'openai', 'openai-codex', 'anthropic', 'xai', 'minimax', undefined]) {
    assert.equal(resolveConfiguredReasoningEffort('fixture-model', 'medium', undefined, provider, capabilities(cloudCases[2]!)), 'medium');
  }
});

test('discovery distinguishes an advertised default from a synthesized catalog default', () => {
  for (const rawDefault of [undefined, 'medium', 'invalid!', false]) {
    const caps = normalizeProviderModel('ollama-cloud', { name: 'fixture-no-default', capabilities: ['completion', 'tools'],
      thinking: { values: ['low', 'high', 'max'], ...(rawDefault === undefined ? {} : { default: rawDefault }) } });
    assert.equal(caps.defaultReasoningEffortOption, 'low', 'The existing catalog display default remains available');
    assert.equal(caps.defaultReasoningEffortAdvertised, false);
    assert.equal(resolveConfiguredReasoningEffort(caps.model, 'medium', undefined, 'ollama-cloud', caps), 'medium');
  }
  for (const row of cloudCases) assert.equal(capabilities(row).defaultReasoningEffortAdvertised, true);
});

test('legacy cached defaults cannot authorize fallback until supported metadata refreshes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'home23-legacy-effort-cache-'));
  const services: Array<{ close(): void }> = [];
  t.after(() => { for (const service of services) service.close(); rmSync(root, { recursive: true, force: true }); });
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config/home.yaml'), JSON.stringify({ providers: { 'ollama-cloud': { apiKey: 'fixture-key' } } }));
  let time = 1_000_000;
  const options = { home23Root: root, autoStart: false, env: {}, now: () => time,
    fetchImpl: async (url: string) => new Response(JSON.stringify(url.endsWith('/api/tags')
      ? { models: [{ name: 'glm-5.3' }] }
      : { capabilities: ['completion', 'tools'], thinking: { values: ['low', 'high', 'max'], default: 'max' } })) };
  const service = createModelDiscovery(options); services.push(service);
  await service.refreshAll({ force: true }); service.close();
  const cached = JSON.parse(readFileSync(service.cachePath, 'utf8'));
  delete cached.providers['ollama-cloud'].models[0].defaultReasoningEffortAdvertised;
  writeFileSync(service.cachePath, JSON.stringify(cached));
  const reader = createModelDiscovery(options); services.push(reader);
  const legacy = reader.snapshot({ refreshAutomatically: false }).models[0];
  assert.equal(legacy.defaultReasoningEffortOption, 'max');
  assert.equal(legacy.defaultReasoningEffortAdvertised, undefined);
  assert.equal(resolveConfiguredReasoningEffort(legacy.model, 'medium', undefined, 'ollama-cloud'), 'medium');
  time += 1_000;
  const fresh = (await reader.refreshAll({ force: true })).models[0];
  assert.equal(fresh.defaultReasoningEffortAdvertised, true);
  assert.equal(resolveConfiguredReasoningEffort(fresh.model, 'medium', undefined, 'ollama-cloud'), 'max');
});

test('target resolution preserves a current explicit choice without carrying it into a different model', () => {
  registerModelCapabilities('ollama-cloud', cloudCases[0]!.model, capabilities(cloudCases[0]!));
  const current = { model: 'gpt-6.1-terra', provider: 'openai-codex', reasoningEffort: 'medium',
    currentModelReasoningEffort: 'ultra', modelReasoningEfforts: {} } as unknown as AgentLoop;
  assert.equal(AgentLoop.prototype.getReasoningEffort.call(current), 'ultra');
  assert.equal(AgentLoop.prototype.getReasoningEffort.call(current, { model: cloudCases[0]!.model, provider: 'ollama-cloud' }), 'high');
  assert.equal(AgentLoop.prototype.getReasoningEffort.call(current, { model: cloudCases[0]!.model, provider: 'ollama-cloud', reasoningEffort: 'medium' }), 'medium');
});

const turnCases = [
  ...cloudCases.map(row => ({ ...row, label: 'omitted effort', expected: row.defaultEffort })),
  { ...cloudCases[2]!, label: 'explicit supported effort', effort: 'low', expected: 'low' },
  { ...cloudCases[2]!, label: 'explicit unsupported effort', effort: 'medium', expected: null },
  { ...cloudCases[2]!, label: 'explicit unsupported alias pin', aliasEffort: 'medium', expected: null },
  { ...cloudCases[2]!, label: 'explicit unsupported per-model pin', configuredEffort: 'medium', expected: null },
  { ...cloudCases[2]!, label: 'current model inherited effort', current: true, expected: 'max' },
  { ...cloudCases[2]!, label: 'current model explicit unsupported effort', current: true, currentEffort: 'medium', expected: null },
  { ...cloudCases[2]!, label: 'captured capability snapshot', mutateCatalog: true, expected: 'max' },
  { ...cloudCases[2]!, label: 'provider entitlement error remains visible', providerStatus: 402, expected: 'max' },
];

for (const row of turnCases) test(`normal ${row.model} turn: ${row.label}`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'home23-inherited-effort-'));
  const priorFetch = globalThis.fetch, priorRoot = process.env.HOME23_ROOT, priorSecrets = process.env.HOME23_SECRETS_PATH;
  t.after(() => {
    globalThis.fetch = priorFetch;
    if (priorRoot === undefined) delete process.env.HOME23_ROOT; else process.env.HOME23_ROOT = priorRoot;
    if (priorSecrets === undefined) delete process.env.HOME23_SECRETS_PATH; else process.env.HOME23_SECRETS_PATH = priorSecrets;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.HOME23_ROOT = root; delete process.env.HOME23_SECRETS_PATH;
  mkdirSync(join(root, 'config')); mkdirSync(join(root, 'workspace'));
  writeFileSync(join(root, 'config/home.yaml'), JSON.stringify({ providers: {
    'ollama-cloud': { baseUrl: 'https://fixture-cloud.test/v1', apiKey: 'fixture-cloud-key' },
  } }));
  registerModelCapabilities('ollama-cloud', row.model, capabilities(row));
  const history = new ConversationHistory(join(root, 'conversations'), 400_000, 'test-agent');
  const agent = new AgentLoop({ apiKey: 'fixture', model: 'gpt-default', provider: 'openai',
    reasoningEffort: 'medium',
    modelReasoningEfforts: 'configuredEffort' in row ? { [row.model]: row.configuredEffort } : {},
    registry: { getAnthropicTools: () => [], getOpenAITools: () => {
      if ('mutateCatalog' in row) registerModelCapabilities('ollama-cloud', row.model, {
        ...capabilities(row), reasoningEffortOptions: ['low'], defaultReasoningEffortOption: 'low', thinkingValues: ['low'],
      });
      return [];
    }, get: () => undefined,
      execute: async () => assert.fail('No tool should execute') } as never,
    contextManager: { getSystemPrompt: () => 'Test agent.', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    history, toolContext: {} as never, workspacePath: join(root, 'workspace'),
  });
  agent.setProviderMap({ 'ollama-cloud': { apiKey: 'fixture-cloud-key', baseURL: 'https://fixture-cloud.test/v1' } });
  if ('current' in row) agent.setModel(row.model, 'ollama-cloud', 'currentEffort' in row ? row.currentEffort : undefined);
  const inferenceBodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-cloud-key');
    if (String(url) === 'https://fixture-cloud.test/api/show') {
      return new Response(JSON.stringify({ capabilities: ['completion', 'tools'] }), { status: 200 });
    }
    assert.equal(url, 'https://fixture-cloud.test/api/chat');
    inferenceBodies.push(JSON.parse(String(init?.body)));
    if ('providerStatus' in row) return new Response('fixture model requires usage entitlement', { status: row.providerStatus });
    return new Response(JSON.stringify({ message: { role: 'assistant', content: 'done' } }), { status: 200 });
  }) as typeof fetch;
  const started = await agent.runWithTurn('fixture-owner-chat', 'Hello.', {
    ...(!('current' in row) ? { modelOverride: { model: row.model, provider: 'ollama-cloud',
      ...('aliasEffort' in row ? { reasoningEffort: row.aliasEffort } : {}) } } : {}),
    ...('effort' in row ? { effort: row.effort } : {}),
  });
  if ('providerStatus' in row) {
    await assert.rejects(started.response, /ollama-cloud HTTP 402: fixture model requires usage entitlement/);
    assert.equal(inferenceBodies.length, 1);
    assert.equal(inferenceBodies[0]!.think, row.expected);
  } else if (row.expected === null) {
    await assert.rejects(started.response, /Reasoning effort medium is unavailable/);
    assert.equal(inferenceBodies.length, 0, 'An explicit invalid effort must fail before model inference');
  } else {
    assert.equal((await started.response).text, 'done');
    assert.equal(inferenceBodies.length, 1);
    assert.equal(inferenceBodies[0]!.think, row.expected);
    assert.equal(new TurnStore(history).statusForTurn('fixture-owner-chat', started.turnId)?.runtime_model.reasoning_effort, row.expected);
    if ('mutateCatalog' in row) assert.equal(modelCapabilities('ollama-cloud', row.model).defaultReasoningEffortOption, 'low');
  }
  assert.equal(agent.getModel(), 'current' in row ? row.model : 'gpt-default', 'A per-turn override must not change configured model');
});
