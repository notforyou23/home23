import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const serverSource = fs.readFileSync(new URL('../../../engine/src/dashboard/server.js', import.meta.url), 'utf8');
const start = serverSource.indexOf('    const pickSearchParameters =');
const end = serverSource.indexOf('    // ── Synthesis Agent API ──', start);
assert.ok(start >= 0 && end > start, 'production memory-search route boundary missing');

// Run the production route registration against a fake app and search service.
// Importing the full dashboard would initialize unrelated runtime dependencies.
function searchRoutes() {
  const routes = new Map();
  const calls = [];
  const signal = new AbortController().signal;
  const context = vm.createContext({
    app: {
      post(route, handler) { routes.set(`POST ${route}`, handler); },
      get(route, handler) { routes.set(`GET ${route}`, handler); },
    },
    memorySearchService: {
      async search(request) {
        calls.push(request);
        return { results: [{ id: 'fixture-hit' }], evidence: { sourceHealth: 'healthy' } };
      },
    },
    requestAbortController: () => ({ signal }),
    sendMemorySearchError: (_response, error) => { throw error; },
  });
  vm.runInContext(serverSource.slice(start, end), context);
  return {
    calls,
    signal,
    async dispatch(method, request) {
      const response = {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
      };
      await routes.get(`${method} /api/memory/search`)(request, response);
      return response;
    },
  };
}

test('dashboard POST leaves omitted semantic thresholds to the configured search service', async () => {
  const fixture = searchRoutes();
  const response = await fixture.dispatch('POST', { body: { query: 'owner conversation', mode: 'context' } });
  assert.equal(response.statusCode, 200);
  assert.equal(fixture.calls.length, 1);
  const request = fixture.calls[0];
  assert.equal(request.query, 'owner conversation');
  assert.equal(request.topK, 10);
  assert.equal(request.minSimilarity, undefined);
  assert.equal(request.noiseFloor, undefined);
  assert.equal(request.mode, 'context');
  assert.equal(request.signal, fixture.signal);
});

test('dashboard POST preserves explicit semantic thresholds, including zero', async () => {
  const fixture = searchRoutes();
  await fixture.dispatch('POST', { body: {
    q: 'owner conversation', limit: 4, minSimilarity: 0, noiseFloor: 0,
    tag: 'owner_conversation', exhaustive: true,
  } });
  const request = fixture.calls[0];
  assert.equal(request.query, 'owner conversation');
  assert.equal(request.topK, 4);
  assert.equal(request.minSimilarity, 0);
  assert.equal(request.noiseFloor, 0);
  assert.equal(request.tag, 'owner_conversation');
  assert.equal(request.exhaustive, true);
});

test('dashboard GET retains its legacy similarity default without forcing a noise floor', async () => {
  const fixture = searchRoutes();
  await fixture.dispatch('GET', { query: { search: 'owner conversation' } });
  assert.equal(fixture.calls.length, 1);
  const request = fixture.calls[0];
  assert.equal(request.query, 'owner conversation');
  assert.equal(request.topK, 10);
  assert.equal(request.minSimilarity, 0.1);
  assert.equal(request.noiseFloor, undefined);
});

test('dashboard GET forwards explicit similarity and noise floor values', async () => {
  const fixture = searchRoutes();
  await fixture.dispatch('GET', { query: {
    query: 'owner conversation', topK: '4', minSimilarity: '0', noiseFloor: '0',
  } });
  const request = fixture.calls[0];
  assert.equal(request.topK, 4);
  assert.equal(request.minSimilarity, 0);
  assert.equal(request.noiseFloor, 0);
});
