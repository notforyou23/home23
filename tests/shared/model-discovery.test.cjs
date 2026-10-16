'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const yaml = require('js-yaml');
const { createModelDiscovery, MAX_AGE_MS, normalizeProviderModel } = require('../../shared/model-discovery.cjs');
const { responsesReasoning } = require('../../shared/responses-reasoning.cjs');
function fixture(t, { providers = { anthropic: { defaultModels: ['saved-old'] } }, aliases = {}, fetchImpl, ...options } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-model-discovery-'));
  const home = { providers, chat: { defaultProvider: Object.keys(providers)[0], defaultModel: 'saved-old' }, models: { aliases } };
  fs.mkdirSync(path.join(root, 'config')); fs.writeFileSync(path.join(root, 'config/home.yaml'), yaml.dump(home));
  const secrets = { providers: Object.fromEntries(Object.keys(providers).filter(p => p !== 'ollama-local').map(p => [p, { apiKey: `fixture-${p}-key` }])) };
  fs.writeFileSync(path.join(root, 'config/secrets.yaml'), yaml.dump(secrets));
  const service = createModelDiscovery({ home23Root: root, autoStart: false, env: {}, fetchImpl, ...options });
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
