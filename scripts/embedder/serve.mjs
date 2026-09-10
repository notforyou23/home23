#!/usr/bin/env node
/**
 * home23-embedder — owned recipe only. Not an Ollama drop-in. No Host wiring.
 * Process name is documented as home23-embedder; Host does not register it yet.
 */
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureArtifacts } from './artifacts.mjs';
import { createQueue, embedOwned, loadOwnedExtractor } from './infer.mjs';
import {
  EXPECTED_DIM,
  isOwnedModelId,
  OWNED_PROFILE,
  OWNED_RECIPE_ID,
  ownedProfile,
} from './recipe.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const HEALTH_PATH = '/ready';
const FORBIDDEN_PORTS = new Set([11435]);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function logEvent(event, fields = {}) {
  // Never log prompt/input/document/conversation text.
  console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') out.port = argv[++i];
    else if (arg === '--bind') out.bind = argv[++i];
    else if (arg === '--cache') out.cache = argv[++i];
  }
  return out;
}

function resolveListen({ port, bind }) {
  const listenPort = Number.parseInt(port ?? process.env.HOME23_EMBEDDER_PORT ?? '', 10);
  const listenBind = bind ?? process.env.HOME23_EMBEDDER_BIND ?? '127.0.0.1';
  if (!Number.isInteger(listenPort) || listenPort < 20000 || listenPort > 60999) {
    throw new Error('HOME23_EMBEDDER_PORT must be an integer in 20000-60999');
  }
  if (FORBIDDEN_PORTS.has(listenPort)) throw new Error('port 11435 is not the Host embedder port');
  if (listenBind !== '127.0.0.1') throw new Error('HOME23_EMBEDDER_BIND must be 127.0.0.1');
  return { port: listenPort, bind: listenBind };
}

function hostAllowed(header, port) {
  if (typeof header !== 'string' || !header.trim()) return false;
  const [name, hostPort] = header.trim().toLowerCase().split(':');
  if (!LOOPBACK_HOSTS.has(name)) return false;
  if (hostPort && Number(hostPort) !== port) return false;
  return true;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, code) {
  const status = {
    too_short: 400,
    recipe_mismatch: 400,
    dimension_mismatch: 422,
    bad_artifact: 422,
    timeout: 408,
    cancelled: 409,
    unavailable: 503,
  }[code] ?? 503;
  sendJson(res, status, { error: { code } });
}

async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const error = new Error('unavailable');
      error.code = 'unavailable';
      throw error;
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function finiteVector(vec) {
  return Array.isArray(vec)
    && vec.length === EXPECTED_DIM
    && vec.every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function createEmbedderServer({ embed, artifactDigests, port, bind = '127.0.0.1', queueMax = 32 }) {
  const queue = createQueue({ concurrency: 1, maxWaiting: queueMax });
  let warm = false;
  let lastError = null;

  async function encodeOne(text, { timeoutMs, priority }) {
    if (typeof text !== 'string') return { ok: false, code: 'unavailable' };
    try {
      const embedding = await queue.enqueue(() => embed(text), { timeoutMs, priority });
      if (!finiteVector(embedding)) return { ok: false, code: 'dimension_mismatch' };
      warm = true;
      lastError = null;
      return { ok: true, embedding };
    } catch (error) {
      const code = error.code && ['timeout', 'cancelled', 'unavailable', 'bad_artifact'].includes(error.code)
        ? error.code
        : 'unavailable';
      lastError = code;
      return { ok: false, code };
    }
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.headers.origin) {
        sendJson(res, 403, { error: { code: 'unavailable' } });
        return;
      }
      if (!hostAllowed(req.headers.host, port)) {
        sendJson(res, 403, { error: { code: 'unavailable' } });
        return;
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);

      if (req.method === 'GET' && url.pathname === '/api/tags') {
        sendJson(res, 200, { models: [{ name: OWNED_PROFILE }] });
        return;
      }

      if (req.method === 'GET' && url.pathname === HEALTH_PATH) {
        const body = {
          recipeId: OWNED_RECIPE_ID,
          profileId: OWNED_PROFILE,
          dimension: EXPECTED_DIM,
          artifactDigests,
          warm,
          protocols: ['ollama-native', 'openai-compatible'],
          pid: process.pid,
          lastError,
        };
        sendJson(res, warm ? 200 : 503, body);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/embeddings') {
        const body = await readJson(req);
        if (!isOwnedModelId(body.model)) {
          sendError(res, 'recipe_mismatch');
          return;
        }
        if (typeof body.prompt !== 'string') {
          sendError(res, 'unavailable');
          return;
        }
        if (body.prompt.trim().length < 8) {
          sendError(res, 'too_short');
          return;
        }
        const result = await encodeOne(body.prompt, { timeoutMs: 1500, priority: 2 });
        if (!result.ok) {
          sendError(res, result.code);
          return;
        }
        sendJson(res, 200, { embedding: result.embedding });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
        const body = await readJson(req);
        if (!isOwnedModelId(body.model)) {
          sendError(res, 'recipe_mismatch');
          return;
        }
        const inputs = typeof body.input === 'string' ? [body.input]
          : Array.isArray(body.input) ? body.input : null;
        if (!inputs || inputs.length === 0 || inputs.length > 2048 || inputs.some((item) => typeof item !== 'string')) {
          sendError(res, 'unavailable');
          return;
        }
        const priority = inputs.length > 1 ? 0 : 1;
        const data = [];
        for (let index = 0; index < inputs.length; index += 1) {
          const result = await encodeOne(inputs[index], { timeoutMs: 30_000, priority });
          if (!result.ok) {
            sendError(res, result.code);
            return;
          }
          data.push({ index, embedding: result.embedding });
        }
        sendJson(res, 200, { data });
        return;
      }

      sendJson(res, 404, { error: { code: 'unavailable' } });
    } catch {
      sendError(res, 'unavailable');
    }
  });

  return {
    server,
    markWarm() { warm = true; },
    listen() {
      return new Promise((resolve) => {
        server.listen(port, bind, () => resolve({ port, bind }));
      });
    },
    close() {
      return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

export async function startOwnedEmbedder(options = {}) {
  const args = parseArgs(options.argv ?? process.argv.slice(2));
  const { port, bind } = resolveListen({ port: args.port ?? options.port, bind: args.bind ?? options.bind });
  const rawCache = args.cache ?? options.cache ?? process.env.HOME23_EMBEDDER_CACHE;
  if (typeof rawCache !== 'string' || !rawCache.trim()) {
    throw new Error('HOME23_EMBEDDER_CACHE is required and must be an explicit directory');
  }
  const cacheDir = resolve(rawCache);
  const queueMax = Number.parseInt(process.env.HOME23_EMBEDDER_QUEUE_MAX ?? '32', 10);
  const artifacts = await ensureArtifacts(cacheDir, { fetchIfMissing: options.fetchIfMissing !== false });
  if (!artifacts.ok) {
    logEvent('artifacts-failed', { code: artifacts.code });
    throw Object.assign(new Error(artifacts.code), { code: artifacts.code });
  }
  logEvent('artifacts-verified', { recipeId: OWNED_RECIPE_ID, files: Object.keys(artifacts.artifactDigests).length });
  const extractor = options.embed ? null : await loadOwnedExtractor(cacheDir);
  const embed = options.embed ?? ((text) => embedOwned(extractor, text));
  const service = createEmbedderServer({
    embed,
    artifactDigests: artifacts.artifactDigests,
    port,
    bind,
    queueMax: Number.isInteger(queueMax) ? queueMax : 32,
  });
  await service.listen();
  const warmup = await embed(options.warmupText ?? 'The library opens at nine.');
  if (!Array.isArray(warmup) || warmup.length !== EXPECTED_DIM) {
    await service.close();
    throw Object.assign(new Error('bad_artifact'), { code: 'bad_artifact' });
  }
  service.markWarm();
  logEvent('warm', { recipeId: OWNED_RECIPE_ID, dimension: EXPECTED_DIM, port, healthPath: HEALTH_PATH });
  return {
    ...service,
    port,
    bind,
    recipeId: OWNED_RECIPE_ID,
    cacheDir,
    async close() {
      await service.close();
      try { await extractor?.dispose?.(); } catch { /* native teardown is best-effort */ }
    },
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  startOwnedEmbedder().catch((error) => {
    logEvent('fatal', { code: error.code ?? 'unavailable' });
    process.exit(1);
  });
}

void here;
void ownedProfile;
