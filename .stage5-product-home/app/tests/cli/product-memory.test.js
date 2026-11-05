import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import yaml from 'js-yaml';
import { inspectProductMemory } from '../../cli/lib/product-memory.js';

test('Host detects its configured local embedding model and exposes its absence without dropping text memory', async t => {
  const root = mkdtempSync(join(tmpdir(), 'h23-memory-status-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let present = true, requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.url, '/api/tags');
    assert.equal(request.headers.authorization, undefined);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ models: present ? [{ name: 'nomic-embed-text:latest' }] : [] }));
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  t.after(() => { server.closeAllConnections(); return new Promise(accept => server.close(accept)); });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/embeddings`;
  mkdirSync(join(root, 'app/config'), { recursive: true });
  writeFileSync(join(root, 'app/config/home.yaml'), yaml.dump({
    embeddings: { providers: [{ provider: 'ollama-local', model: 'nomic-embed-text', endpoint }] },
    substrate: { embedding: { endpoint, model: 'nomic-embed-text' } },
  }));
  assert.deepEqual(await inspectProductMemory(root), { semanticStatus: 'model_detected', seedSemanticStatus: 'model_detected', warnings: [] });
  assert.equal(requests, 1, 'engine and Seed with the same dependency share the bounded probe');
  present = false;
  const unavailable = await inspectProductMemory(root);
  assert.equal(unavailable.semanticStatus, 'not_detected');
  assert.match(unavailable.warnings[0], /text memory are retained/);
});

test('owned encoder readiness uses GET /ready and never treats /api/tags as warm', async t => {
  const root = mkdtempSync(join(tmpdir(), 'h23-memory-owned-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recipeId = '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9';
  let warm = false;
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    if (request.url === '/ready') {
      response.writeHead(warm ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ recipeId, dimension: 768, warm, protocols: ['ollama-native', 'openai-compatible'] }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models: [{ name: 'owned-nomic-v1.5-onnx-fp32-mean-noprefix' }] }));
  });
  await new Promise(accept => server.listen(0, '127.0.0.1', accept));
  t.after(() => { server.closeAllConnections(); return new Promise(accept => server.close(accept)); });
  const port = server.address().port;
  const endpoint = `http://127.0.0.1:${port}/api/embeddings`;
  mkdirSync(join(root, 'app/config'), { recursive: true });
  writeFileSync(join(root, 'app/config/home.yaml'), yaml.dump({
    embedder: { owned: true, port },
    embeddings: { providers: [{ provider: 'home23-owned', model: 'owned-nomic-v1.5-onnx-fp32-mean-noprefix', endpoint }] },
    substrate: { embedding: { endpoint, model: 'owned-nomic-v1.5-onnx-fp32-mean-noprefix' } },
  }));
  const cold = await inspectProductMemory(root);
  assert.equal(cold.semanticStatus, 'not_detected');
  assert.ok(seen.includes('/ready'));
  assert.equal(seen.includes('/api/tags'), false);
  warm = true;
  const live = await inspectProductMemory(root);
  assert.equal(live.semanticStatus, 'ready');
  assert.equal(live.seedSemanticStatus, 'ready');
});
