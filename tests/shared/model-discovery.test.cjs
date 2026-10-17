'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { createModelDiscovery, MAX_AGE_MS, normalizeProviderModel } = require('../../shared/model-discovery.cjs');
const { responsesReasoning } = require('../../shared/responses-reasoning.cjs');
const { createCodexCatalogVersionDetector } = require('../../shared/cli-binary.cjs');
function fixture(t, { providers = { anthropic: { defaultModels: ['saved-old'] } }, aliases = {}, fetchImpl, ...options } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-model-discovery-'));
  const home = { providers, chat: { defaultProvider: Object.keys(providers)[0], defaultModel: 'saved-old' }, models: { aliases } };
  fs.mkdirSync(path.join(root, 'config')); fs.writeFileSync(path.join(root, 'config/home.yaml'), yaml.dump(home));
  const secrets = { providers: Object.fromEntries(Object.keys(providers).filter(p => p !== 'ollama-local').map(p => [p, { apiKey: `fixture-${p}-key` }])) };
  fs.writeFileSync(path.join(root, 'config/secrets.yaml'), yaml.dump(secrets));
  const service = createModelDiscovery({ home23Root: root, autoStart: false, env: {}, fetchImpl,
    codexVersionDetector: () => ({ version: '0.162.0', fingerprint: 'fixture', errorCode: null }),
    codexRegistryFetchImpl: async () => new Response(JSON.stringify({ name: '@openai/codex', version: '0.162.0' })), ...options });
  t.after(() => { service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, home, service, secrets, saveSecrets() { fs.writeFileSync(path.join(root, 'config/secrets.yaml'), yaml.dump(secrets)); } };
}
const response = body => ({ ok: true, json: async () => body });
const claude = id => ({ id, type: 'model', capabilities: { thinking: { types: { adaptive: { supported: true } } }, effort: { supported: true, low: { supported: true }, high: { supported: true }, future: { supported: true } } } });

test('complete paginated snapshot replaces defaults, preserves custom routing, and retains saved unavailable selections', async t => {
  const urls = [];
  const f = fixture(t, { aliases: { mine: { provider: 'anthropic', model: 'new-one' }, saved: { provider: 'anthropic', model: 'saved-old' } }, fetchImpl: async url => {
    urls.push(url); return response(url.includes('after_id=') ? { data: [claude('new-two')], has_more: false } : { data: [claude('new-one')], has_more: true, last_id: 'new-one' });
  } });
  const original = fs.readFileSync(path.join(f.root, 'config/home.yaml'), 'utf8');
  await f.service.refreshAll(); const state = f.service.snapshot();
  assert.equal(urls.length, 2); assert.match(urls[1], /after_id=new-one/);
  assert.deepEqual(state.models.map(row => row.id), ['new-one', 'new-two']);
  assert.equal(state.aliases.mine.provider, 'anthropic'); assert.equal(state.aliases.saved, undefined);
  assert(state.unavailableSelections.some(row => row.model === 'saved-old'));
  assert.deepEqual(state.models[0].reasoningEffortOptions, ['low', 'high', 'future']);
  assert.deepEqual(state.models[0].reasoningEfforts, ['low', 'high']);
  assert.equal(fs.readFileSync(path.join(f.root, 'config/home.yaml'), 'utf8'), original);
  const disk = fs.readFileSync(f.service.cachePath, 'utf8'); assert(!disk.includes('fixture-anthropic-key')); assert(!disk.includes('authorization'));
});

test('partial pagination, network, and auth errors retain the complete previous snapshot as stale', async t => {
  let mode = 'ok'; let time = 1_000_000;
  const f = fixture(t, { now: () => time, fetchImpl: async url => {
    if (mode === 'auth') return { ok: false, status: 401 };
    if (mode === 'network') throw new Error('fixture secret must not leak');
    if (mode === 'partial') { if (url.includes('after_id')) throw new Error('failed page'); return response({ data: [claude('partial')], has_more: true, last_id: 'partial' }); }
    return response({ data: [claude('keep')] });
  } });
  await f.service.refreshAll();
  for (mode of ['partial', 'network', 'auth']) {
    time += MAX_AGE_MS; await f.service.refreshAll(); const state = f.service.snapshot({ refreshAutomatically: false });
    assert.deepEqual(state.models.map(r => r.id), ['keep']); assert.equal(state.discovery.providers.anthropic.state, 'stale');
    assert(!JSON.stringify(state).includes('fixture secret'));
  }
});

test('successful omission retires an option; auth/config identity changes never reuse the former account snapshot', async t => {
  let listed = ['first', 'retire'];
  const f = fixture(t, { fetchImpl: async () => response({ data: listed.map(claude) }) });
  await f.service.refreshAll(); listed = ['first']; await f.service.refreshAll({ force: true });
  assert.deepEqual(f.service.snapshot().models.map(r => r.id), ['first']);
  f.secrets.providers.anthropic.apiKey = 'different-account-key'; f.saveSecrets();
  const state = f.service.snapshot({ refreshAutomatically: false });
  assert(!state.models.some(row => row.id === 'first')); assert.equal(state.discovery.providers.anthropic.state, 'loading');
  await f.service.refreshAll(); assert.equal(f.service.snapshot().models[0].id, 'first');
  f.home.providers.anthropic.baseUrl = 'https://other.example'; fs.writeFileSync(path.join(f.root, 'config/home.yaml'), yaml.dump(f.home));
  assert(!f.service.snapshot({ refreshAutomatically: false }).models.some(row => row.id === 'first'));
});

test('concurrent reads coalesce discovery and disk readers observe a refreshed revision without restarting', async t => {
  let release; let count = 0;
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { fetchImpl: async () => { count++; await blocked; return response({ data: [claude('hot')] }); } });
  const before = f.service.snapshot().discovery.revision;
  for (let i = 0; i < 25; i++) f.service.snapshot();
  const done = f.service.refreshAll(); assert.equal(count, 1); release(); await done;
  assert.notEqual(f.service.snapshot().discovery.revision, before);
  const reader = createModelDiscovery({ home23Root: f.root, env: {}, autoStart: false, fetchImpl: () => { throw Error('unexpected request'); } }); t.after(() => reader.close());
  assert.equal(reader.snapshot({ refreshAutomatically: false }).models[0].id, 'hot');
});

test('Codex metadata admits future reasoning models and keeps exact providers distinct', async t => {
  const f = fixture(t, { providers: { 'openai-codex': {}, openai: {}, xai: {}, minimax: {} }, fetchImpl: async url => {
    if (url.includes('codex')) return response({ models: [{ slug: 'future-model', supported_in_api: true, visibility: 'list', supported_reasoning_levels: [{ effort: 'ultra' }, { effort: 'low' }], default_reasoning_level: 'ultra' }] });
    if (url.includes('x.ai')) return response({ models: [{ id: 'future-model', input_modalities: ['text'], output_modalities: ['text'] }] });
    return response({ data: [{ id: url.includes('minimax') ? 'MiniMax-M99' : 'gpt-99' }, { id: 'text-embedding-99' }] });
  } });
  await f.service.refreshAll(); const state = f.service.snapshot();
  assert.deepEqual(responsesReasoning('future-model', 'ultra'), { effort: 'ultra', summary: 'auto' });
  assert.throws(() => responsesReasoning('future-model', 'medium'), /Unsupported/);
  assert.equal(state.aliases['xai/future-model'].provider, 'xai');
  assert.equal(state.aliases['openai-codex/future-model'].provider, 'openai-codex');
  assert(!state.models.some(row => row.id.includes('embedding')));
  assert.equal(state.discovery.providers.openai.unclassifiedCount, 1);
});

test('configured Codex binary version refreshes catalog immediately and retains only same-account stale rows', async t => {
  const requests = []; let fail = false;
  const f = fixture(t, { providers: { 'openai-codex': {} }, codexVersionDetector: createCodexCatalogVersionDetector({ env: {} }), fetchImpl: async url => {
    requests.push(url); if (fail) throw Error('network unavailable');
    const current = url.includes('client_version=0.163.0');
    return response({ models: [{ slug: current ? 'gpt-6.1-sol' : 'previous-catalog-model', visibility: 'list', supported_in_api: true,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], default_reasoning_level: 'ultra' }] });
  } });
  const bin = path.join(f.root, 'configured-codex');
  const writeVersion = version => fs.writeFileSync(bin, `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`, { mode: 0o700 });
  writeVersion('0.162.0');
  f.home.acp = { backends: { codex: { bin } } };
  f.home.chat = { defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol' };
  const save = () => fs.writeFileSync(path.join(f.root, 'config/home.yaml'), yaml.dump(f.home)); save();
  await f.service.refreshAll();
  assert.match(requests[0], /client_version=0\.162\.0(?:&|$)/);
  assert.equal(f.service.snapshot({ refreshAutomatically: false }).models[0].id, 'previous-catalog-model');
  writeVersion('0.163.0'); fail = true;
  await f.service.refreshAll(); // No clock advance and no force: binary changes bypass the old TTL.
  assert.match(requests[1], /client_version=0\.163\.0(?:&|$)/);
  let state = f.service.snapshot({ refreshAutomatically: false });
  assert.equal(state.models[0].id, 'previous-catalog-model');
  assert.equal(state.discovery.providers['openai-codex'].state, 'stale');
  fail = false; await f.service.refreshAll({ force: true }); state = f.service.snapshot({ refreshAutomatically: false });
  assert.deepEqual(state.models.map(row => row.id), ['gpt-6.1-sol']);
  assert.deepEqual(state.models[0].reasoningEffortOptions, ['low', 'ultra']);
  assert.deepEqual(responsesReasoning('gpt-6.1-sol', 'ultra'), { effort: 'ultra', summary: 'auto' });
  assert.equal(state.unavailableSelections.length, 0);
  assert.equal(f.home.chat.defaultModel, 'gpt-6.1-sol');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "not a version\\n"\n', { mode: 0o700 }); fail = true;
  await f.service.refreshAll(); state = f.service.snapshot({ refreshAutomatically: false });
  assert.equal(state.models[0].id, 'gpt-6.1-sol');
  assert.equal(state.discovery.providers['openai-codex'].state, 'stale');
  assert.equal(state.discovery.providers['openai-codex'].errorCode, 'model_discovery_unavailable');
  f.secrets.providers['openai-codex'].apiKey = 'different-account'; f.saveSecrets();
  state = f.service.snapshot({ refreshAutomatically: false });
  assert.equal(state.models.length, 0, 'a failed detector must never expose the former account catalog');
});

test('official stable version hints coalesce, persist and refresh at catalog cadence without becoming model authority', async t => {
  let time = 1_000_000; let registryVersion = '0.162.0'; let registryCalls = 0; let fail = false; const requests = [];
  const f = fixture(t, { providers: { 'openai-codex': {} }, now: () => time,
    codexRegistryFetchImpl: async () => { registryCalls++; if (fail) throw Error('registry down'); return new Response(JSON.stringify({ name: '@openai/codex', version: registryVersion })); },
    fetchImpl: async url => {
      requests.push(url); return response({ models: [{ slug: url.includes('0.163.0') ? 'gpt-6.1-sol' : 'previous-catalog-model',
        visibility: 'list', supported_in_api: true, supported_reasoning_levels: [{ effort: 'ultra' }] }] });
    } });
  await Promise.all([f.service.refreshAll(), f.service.refreshAll(), f.service.refreshAll()]);
  assert.equal(registryCalls, 1); assert.equal(requests.length, 1);
  registryVersion = '0.163.0'; time += MAX_AGE_MS;
  await f.service.refreshAll();
  assert.equal(registryCalls, 2); assert.match(requests[1], /client_version=0\.163\.0/);
  assert.deepEqual(f.service.snapshot({ refreshAutomatically: false }).models.map(row => row.id), ['gpt-6.1-sol']);
  fail = true; time += MAX_AGE_MS; await f.service.refreshAll();
  assert.match(requests[2], /client_version=0\.163\.0/, 'registry failure retains the last stable hint');
  const disk = JSON.parse(fs.readFileSync(f.service.cachePath)); assert.equal(disk.codexVersionHint.version, '0.163.0');
  const reader = createModelDiscovery({ home23Root: f.root, env: {}, autoStart: false,
    codexVersionDetector: () => ({ version: '0.162.0', fingerprint: 'fixture', errorCode: null }),
    codexRegistryFetchImpl: async () => { assert.fail('fresh persisted hint must not refetch'); },
    now: () => time, fetchImpl: async () => { assert.fail('fresh catalog must not refetch'); } });
  t.after(() => reader.close());
  assert.equal(reader.snapshot({ refreshAutomatically: false }).models[0].id, 'gpt-6.1-sol');
});

test('a broken optional CLI does not block authenticated discovery using the official compatibility version', async t => {
  const requests = [];
  const f = fixture(t, { providers: { 'openai-codex': {} },
    codexVersionDetector: () => ({ version: '0.162.0', fingerprint: 'broken-cli', errorCode: 'model_discovery_client_version' }),
    codexRegistryFetchImpl: async () => new Response(JSON.stringify({ name: '@openai/codex', version: '0.163.0' })),
    fetchImpl: async url => { requests.push(url); return response({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list',
      supported_in_api: true, supported_reasoning_levels: [{ effort: 'ultra' }] }] }); } });
  await f.service.refreshAll(); const state = f.service.snapshot({ refreshAutomatically: false });
  assert.match(requests[0], /client_version=0\.163\.0/);
  assert.equal(state.discovery.providers['openai-codex'].state, 'fresh');
  assert.equal(state.models[0].id, 'gpt-6.1-sol'); assert.deepEqual(state.models[0].reasoningEffortOptions, ['ultra']);
});

test('a pre-versioned Codex snapshot stays stale until a complete current authenticated response replaces it', async t => {
  const f = fixture(t, { providers: { 'openai-codex': {} }, fetchImpl: async () => response({ models: [{ slug: 'previous-catalog-model', visibility: 'list' }] }) });
  await f.service.refreshAll(); f.service.close();
  const disk = JSON.parse(fs.readFileSync(f.service.cachePath));
  delete disk.codexVersionHint;
  for (const key of ['catalogIdentity', 'catalogVersion', 'attemptedCatalogIdentity']) delete disk.providers['openai-codex'][key];
  fs.writeFileSync(f.service.cachePath, JSON.stringify(disk));
  let fail = true; let calls = 0;
  const reader = createModelDiscovery({ home23Root: f.root, env: {}, autoStart: false,
    codexVersionDetector: () => ({ version: '0.162.0', fingerprint: 'fixture', errorCode: null }),
    codexRegistryFetchImpl: async () => new Response(JSON.stringify({ name: '@openai/codex', version: '0.162.0' })),
    fetchImpl: async url => { calls++; assert.match(url, /client_version=0\.162\.0/); if (fail) throw Error('network unavailable');
      return response({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list', supported_reasoning_levels: [{ effort: 'ultra' }] }] }); } });
  t.after(() => reader.close());
  assert.equal(reader.snapshot({ refreshAutomatically: false }).discovery.providers['openai-codex'].state, 'stale');
  await reader.refreshAll(); assert.equal(calls, 1);
  assert.equal(reader.snapshot({ refreshAutomatically: false }).models[0].id, 'previous-catalog-model');
  fail = false; await reader.refreshAll({ force: true });
  assert.deepEqual(reader.snapshot({ refreshAutomatically: false }).models.map(row => row.id), ['gpt-6.1-sol']);
});

test('Ollama reads only installed/hosted tags and show metadata; non-chat models are not advertised', async t => {
  const calls = [];
  const f = fixture(t, { providers: { 'ollama-local': {}, 'ollama-cloud': {} }, fetchImpl: async (url, init) => {
    calls.push({ url, method: init.method });
    if (url.endsWith('/api/tags')) return response({ models: [{ name: 'chat' }, { name: 'embedding' }] });
    return response(JSON.parse(init.body).model === 'chat' ? { capabilities: ['completion', 'tools'], thinking: { values: [false, 'high'], default: 'high' } } : { capabilities: ['embedding'] });
  } });
  await f.service.refreshAll(); const state = f.service.snapshot();
  assert.equal(state.models.length, 2); assert(state.models.every(row => row.model === 'chat'));
  assert(calls.every(call => /\/api\/(tags|show)$/.test(call.url))); assert(!calls.some(call => /pull/.test(call.url)));
  assert.deepEqual(state.models[0].reasoningEffortOptions, ['none', 'high']);
});

test('unknown modalities and retired provider records are retained only as diagnostics', () => {
  assert.equal(normalizeProviderModel('xai', { id: 'audio', output_modalities: ['audio'], input_modalities: ['text'] }).eligible, false);
  assert.equal(normalizeProviderModel('anthropic', { id: 'old', type: 'model', lifecycle: 'retired' }), null);
  assert.equal(normalizeProviderModel('openai', { id: 'gpt-3.5-turbo-instruct' }).eligible, false);
  assert.equal(normalizeProviderModel('openai', { id: 'gpt-unverified-family' }).eligible, false);
  assert.equal(normalizeProviderModel('anthropic', { ...claude('new'), max_tokens: 8192 }).maxOutputTokens, 8192);
});

test('identity-only discovery preserves unknown reasoning and configured alias effort without inventing none', async t => {
  const f = fixture(t, { providers: { openai: { defaultModels: ['gpt-99'] }, xai: {} }, aliases: { saved: { provider: 'openai', model: 'gpt-99', reasoningEffort: 'high' } }, fetchImpl: async url => response(url.includes('x.ai')
    ? { models: [{ id: 'grok-future', input_modalities: ['text'], output_modalities: ['text'] }] }
    : { data: [{ id: 'gpt-99' }] }) });
  await f.service.refreshAll(); const state = f.service.snapshot();
  assert(state.models.every(row => row.reasoningCapabilitiesKnown === false));
  assert(state.models.every(row => row.reasoningEffortOptions.length === 0 && row.defaultReasoningEffortOption === null));
  assert.equal(state.aliases['openai/gpt-99'].reasoningEffort, undefined);
  assert.equal(state.aliases.saved.reasoningEffort, 'high');
  assert.equal(state.aliases['xai/grok-future'].reasoningEffort, undefined);
});

test('provider defaults do not pin saved or generated aliases and agent scoped overrides survive refresh', async t => {
  const f = fixture(t, { aliases: { saved: { provider: 'anthropic', model: 'house-model' } }, fetchImpl: async () => response({ data: [claude('house-model'), claude('agent-model')] }) });
  await f.service.refreshAll();
  const agentConfig = { chat: { reasoningEffort: 'high' }, models: { aliases: { saved: { model: 'agent-model', reasoningEffort: 'high' }, private: { provider: 'anthropic', model: 'house-model' } } } };
  const state = f.service.snapshot({ agentConfig });
  assert.equal(state.aliases.saved.model, 'agent-model'); assert.equal(state.aliases.saved.reasoningEffort, 'high');
  assert.equal(Object.hasOwn(state.aliases.private, 'reasoningEffort'), false);
  assert.equal(Object.hasOwn(state.aliases['anthropic/house-model'], 'reasoningEffort'), false);
  assert.equal(f.service.snapshot().aliases.saved.model, 'house-model');
});

test('invalid settings during pending refresh retain stale data without an unhandled rejection or config overwrite', async t => {
  const unhandled = []; const listener = error => unhandled.push(error); process.on('unhandledRejection', listener); t.after(() => process.off('unhandledRejection', listener));
  let release; let block = false;
  const f = fixture(t, { fetchImpl: async () => { if (block) await new Promise(resolve => { release = resolve; }); return response({ data: [claude('saved')] }); } });
  await f.service.refreshAll(); block = true;
  const pending = f.service.refreshAll({ force: true });
  f.service.snapshot();
  const target = path.join(f.root, 'config/secrets.yaml'); fs.writeFileSync(target, 'providers: [broken:'); release();
  await assert.rejects(pending); // The explicit caller receives the config error; automatic refresh consumes it.
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(unhandled, []);
  assert.equal(fs.readFileSync(target, 'utf8'), 'providers: [broken:');
  fs.writeFileSync(target, yaml.dump(f.secrets));
  const state = f.service.snapshot({ refreshAutomatically: false });
  assert.equal(state.models[0].model, 'saved'); assert.equal(state.discovery.providers.anthropic.state, 'stale');
});

test('an older failed account refresh cannot clobber a newer success during a torn settings read', async t => {
  let mode = 'initial'; let release; let started;
  const pendingStarted = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { fetchImpl: async () => {
    if (mode === 'blocked-old-account') { started(); await new Promise(resolve => { release = resolve; }); throw Error('old request failed'); }
    return response({ data: [claude(mode === 'initial' ? 'old-account-model' : 'new-account-model')] });
  } });
  await f.service.refreshAll(); mode = 'blocked-old-account'; const older = f.service.refreshAll({ force: true }); await pendingStarted;
  f.secrets.providers.anthropic.apiKey = 'new-account-key'; f.saveSecrets(); mode = 'new-account';
  await f.service.refreshAll(); assert.equal(f.service.snapshot({ refreshAutomatically: false }).models[0].id, 'new-account-model');
  fs.writeFileSync(path.join(f.root, 'config/secrets.yaml'), 'providers: [broken:'); release();
  await assert.rejects(older); f.saveSecrets();
  assert.deepEqual(f.service.snapshot({ refreshAutomatically: false }).models.map(row => row.id), ['new-account-model']);
});

test('resident background cadence refreshes an expired catalog without another client read', async t => {
  let time = 1_000_000; let calls = 0; let observed;
  const changed = new Promise(resolve => { observed = resolve; });
  const f = fixture(t, { now: () => time, autoStart: true, intervalMs: 10, fetchImpl: async () => {
    calls++; if (calls === 2) observed(); return response({ data: [claude(calls === 1 ? 'before' : 'after')] });
  } });
  await f.service.refreshAll(); time += MAX_AGE_MS + 1;
  await Promise.race([changed, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('background discovery did not run')), 1000); timer.unref(); })]);
  await f.service.refreshAll();
  assert.equal(f.service.snapshot({ refreshAutomatically: false }).models[0].id, 'after');
  assert.equal(calls, 2);
});
