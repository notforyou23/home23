import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const settingsSource = fs.readFileSync(new URL('../../../engine/src/dashboard/home23-settings.js', import.meta.url), 'utf8');
const apiSource = fs.readFileSync(new URL('../../../engine/src/dashboard/home23-settings-api.js', import.meta.url), 'utf8');
const PROFILE = 'owned-nomic-v1.5-onnx-fp32-mean-noprefix';
const plain = value => JSON.parse(JSON.stringify(value));

function sourceBetween(source, start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `production source boundary missing: ${start}`);
  return source.slice(from, to);
}

// Evaluate only the production methods under test. Never import the dashboard,
// start a router/server, load credentials, execute a child process, or use fetch.
const primaryProviderSource = sourceBetween(apiSource,
  '  function getPrimaryEmbeddingProvider(', '\n  function countMemoryNode(');

function providerRuntime(home) {
  let secretReads = 0;
  const context = vm.createContext({
    loadHomeConfig: () => home,
    loadSecrets: () => { secretReads++; throw new Error('credential loading is forbidden in this fake'); },
  });
  vm.runInContext(primaryProviderSource, context);
  return { context, secretReads: () => secretReads };
}

test('owned embedding readiness accepts catalog and memory-provider ids without reading credentials', () => {
  for (const provider of ['home23-owned', 'owned-onnx']) {
    const home = { embeddings: { providers: [{ provider, model: PROFILE, dimensions: 768,
      endpoint: 'http://127.0.0.1:24005/api/embeddings', recipeId: 'reviewed-owned-recipe' }] } };
    const runtime = providerRuntime(home);
    const result = vm.runInContext('getPrimaryEmbeddingProvider()', runtime.context);
    assert.equal(result.configured, true);
    assert.equal(result.status, 'semantic_configured');
    assert.equal(result.needsKey, false);
    assert.equal(result.recipeId, 'reviewed-owned-recipe');
    assert.equal(result.provider, provider);
    assert.equal(runtime.secretReads(), 0);
  }
});

test('remote embedding readiness still requires credentials; local and absent providers do not', () => {
  const runtime = providerRuntime({});
  runtime.context.home = { embeddings: { providers: [{ provider: 'openai', model: 'text-embedding-3-small' }] } };
  runtime.context.emptyCredentials = { providers: {} };
  const remote = vm.runInContext('getPrimaryEmbeddingProvider(home, emptyCredentials)', runtime.context);
  assert.equal(remote.configured, false);
  assert.equal(remote.needsKey, true);
  runtime.context.home.embeddings.providers[0] = { provider: 'ollama-local', model: 'nomic-embed-text' };
  assert.equal(vm.runInContext('getPrimaryEmbeddingProvider(home)', runtime.context).configured, true);
  assert.equal(vm.runInContext('getPrimaryEmbeddingProvider()', runtime.context).configured, false);
  assert.equal(runtime.secretReads(), 0);
});

function fakeResponse() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = plain(body); return this; } };
}

test('owned embedding backfill reaches the current engine without credentials or filesystem access', async () => {
  const runtime = providerRuntime({ embeddings: { providers: [{ provider: 'home23-owned', model: PROFILE, dimensions: 768 }] } });
  const regenerated = [];
  const orchestrator = {
    memory: { nodes: new Map([['old', { id: 'old', embedding: [1] }], ['missing', { id: 'missing' }]]) },
    async _regenerateEmbeddingsInBackground(ids) { regenerated.push(ids); },
  };
  let handler;
  Object.assign(runtime.context, {
    router: { post(_path, callback) { handler = callback; } },
    resolveRequestedAgent: () => 'jerry', getCurrentDashboardAgent: () => 'jerry',
    getOrchestrator: () => orchestrator, console: { warn() {} },
    fs: new Proxy({}, { get() { throw new Error('filesystem access is forbidden in this fake'); } }),
  });
  vm.runInContext(sourceBetween(apiSource,
    "  router.post('/memory/backfill-embeddings'", '\n\n  // ── Task 2:'), runtime.context);
  const response = fakeResponse();
  await handler({ body: { agent: 'jerry' }, query: {} }, response);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.mode, 'live');
  assert.equal(response.body.queued, true);
  assert.deepEqual(plain(regenerated), [['missing']]);
  assert.equal(runtime.secretReads(), 0);
});

function systemApiRuntime(home) {
  let handler, saved, regenerations = 0;
  const context = vm.createContext({
    router: { put(_path, callback) { handler = callback; } },
    getHomeConfigPath: () => '/fake/home.yaml', loadYaml: () => plain(home),
    saveYaml: (_path, value) => { saved = plain(value); }, evobrewAvailable: () => false,
    regenerateEcosystem: () => { regenerations++; }, regenerateEvobrewConfig: () => {},
  });
  vm.runInContext(sourceBetween(apiSource, "  router.put('/system'", '\n\n  // ── Skills'), context);
  return { save(embeddings) { const response = fakeResponse(); handler({ body: { embeddings } }, response); return response; },
    saved: () => saved, regenerations: () => regenerations };
}

test('system save preserves owned recipe and provider metadata across edits and row reorder', () => {
  const owned = { provider: 'home23-owned', model: PROFILE, dimensions: 768,
    endpoint: 'http://127.0.0.1:24005/api/embeddings', recipeId: 'owned-recipe', provenance: { owner: 'Host' } };
  const local = { provider: 'ollama-local', model: 'nomic-embed-text', dimensions: 768, recipeId: 'legacy-recipe' };
  const runtime = systemApiRuntime({ embeddings: { providers: [owned, local], migrationPolicy: 'explicit' } });
  const response = runtime.save({ providers: [local, { provider: owned.provider, model: owned.model, dimensions: 768 }] });
  assert.equal(response.statusCode, 200);
  const saved = runtime.saved().embeddings;
  assert.equal(saved.migrationPolicy, 'explicit');
  assert.equal(saved.providers[1].recipeId, 'owned-recipe');
  assert.deepEqual(saved.providers[1].provenance, { owner: 'Host' });
  assert.equal(saved.providers[1].endpoint, undefined, 'editable endpoint may be cleared');
  assert.equal(runtime.regenerations(), 1);
});

test('system save does not transfer an old recipe to a changed provider identity', () => {
  const runtime = systemApiRuntime({ embeddings: { providers: [{ provider: 'home23-owned', model: PROFILE,
    dimensions: 768, recipeId: 'owned-recipe' }] } });
  assert.equal(runtime.save({ providers: [{ provider: 'ollama-local', model: 'nomic-embed-text', dimensions: 768 }] }).statusCode, 200);
  assert.equal(runtime.saved().embeddings.providers[0].recipeId, undefined);
});

test('invalid system provider lists are rejected before persistence or regeneration', () => {
  const runtime = systemApiRuntime({});
  assert.equal(runtime.save({ providers: 'invalid' }).statusCode, 400);
  assert.equal(runtime.saved(), undefined);
  assert.equal(runtime.regenerations(), 0);
});

function browserRuntime() {
  let rows = [], posted;
  const elements = new Map();
  const decode = value => value.replace(/&(amp|lt|gt|quot|#39);/g,
    (_match, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[name]));
  function controls(html) {
    const fields = new Map();
    for (const match of html.matchAll(/<input[^>]*\b(data-emb-[a-z]+)[^>]*\bvalue="([^"]*)"/g)) {
      fields.set(`[${match[1]}]`, { value: decode(match[2]) });
    }
    const options = [...html.matchAll(/<option value="([^"]+)"\s*([^>]*)>/g)];
    fields.set('[data-emb-provider]', { value: (options.find(match => match[2].includes('selected')) || options[0])?.[1] });
    return fields;
  }
  function element() {
    let html = '', fields = new Map();
    const el = { value: '', style: {}, textContent: '',
      parentElement: { querySelector: () => ({ textContent: '' }), appendChild() {} },
      setAttribute() {}, querySelector(selector) { return fields.get(selector) || null; },
      querySelectorAll: () => rows, appendChild(row) { rows.push(row); },
      remove() { rows = rows.filter(row => row !== el); } };
    Object.defineProperty(el, 'innerHTML', { configurable: true, get: () => html, set(value) { html = value; fields = controls(value); } });
    return el;
  }
  const embList = element();
  let listHtml = '';
  Object.defineProperty(embList, 'innerHTML', { get: () => listHtml, set(value) {
    listHtml = value;
    rows = value.split(/<div class="h23s-provider-card"[^>]*\bdata-emb-entry>/).slice(1).map(html => {
      const row = element(); row.innerHTML = html; return row;
    });
  } });
  elements.set('embeddings-list', embList);
  const context = vm.createContext({
    API: '/fake/settings', setupReadinessData: null, renderMemoryReadiness() {},
    loadSetupReadiness: async () => null, setTimeout() {}, console,
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      querySelectorAll: () => rows, createElement: () => element() },
    fetch: async (_url, options) => { posted = JSON.parse(options.body); return { json: async () => ({ ok: true }) }; },
  });
  vm.runInContext(sourceBetween(settingsSource, '// ── System ──', '\nasync function backfillEmbeddings()'), context);
  vm.runInContext(sourceBetween(settingsSource, 'function escapeHtml(', '\nfunction feederAgentUrl('), context);
  return { render(data) { context.data = data; vm.runInContext('renderSystem(data)', context); },
    save: () => vm.runInContext('saveSystem()', context), posted: () => posted,
    rows: () => rows, add: () => elements.get('btn-add-embedding').onclick(), html: () => listHtml };
}

test('settings render/save keeps the owned provider selected and preserves recipe metadata', async () => {
  for (const provider of ['home23-owned', 'owned-onnx']) {
    const browser = browserRuntime();
    const owned = { provider, model: PROFILE, dimensions: 768, endpoint: 'http://127.0.0.1:24005/api/embeddings',
      recipeId: 'owned-recipe', provenance: { owner: 'Host' } };
    browser.render({ embeddings: { providers: [owned] } });
    assert.equal(browser.rows()[0].querySelector('[data-emb-provider]').value, provider);
    await browser.save();
    assert.deepEqual(browser.posted().embeddings.providers, [owned]);
    browser.add();
    browser.rows()[1].querySelector('[data-emb-provider]').value = 'home23-owned';
    browser.rows()[1].querySelector('[data-emb-model]').value = PROFILE;
    assert.match(browser.html(), /Home23 Owned ONNX/);
  }
});

test('removing a provider row preserves the surviving owned recipe and a changed identity discards it', async () => {
  const browser = browserRuntime();
  browser.render({ embeddings: { providers: [
    { provider: 'ollama-local', model: 'nomic-embed-text', dimensions: 768, recipeId: 'legacy-recipe' },
    { provider: 'home23-owned', model: PROFILE, dimensions: 768, recipeId: 'owned-recipe' },
  ] } });
  browser.rows()[0].remove();
  await browser.save();
  assert.equal(browser.posted().embeddings.providers[0].recipeId, 'owned-recipe');
  browser.rows()[0].querySelector('[data-emb-model]').value = 'different-model';
  await browser.save();
  assert.equal(browser.posted().embeddings.providers[0].recipeId, undefined);
});
