#!/usr/bin/env node
/**
 * Live Memory/attention probe against the isolated Host TEST home.
 * Does not create a home. Does not use verify-embedder-stage5.mjs as proof.
 * Reads Host receipt + home config/ports, talks to that home's encoder.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import yaml from 'js-yaml';
import { probeOwnedReady } from '../../cli/lib/product-embedder.js';
import { productEnvironment, readPrivateJSON } from '../../cli/lib/product-environment.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const contract = require('../../shared/semantic-encoder-contract.cjs');
const seedEmbedding = require('../../shared/seed-embedding-config.cjs');

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, '../..');
const DEFAULT_RECEIPT = join(sourceRoot, '.stage5-host-home/host-receipt.json');
const DEFAULT_OUT = join(sourceRoot, '.stage5-host-home/memory-receipt.json');
const OWNED_HASH = contract.OWNED_EMBEDDING_RECIPE_ID;
const OWNED_PROFILE = contract.OWNED_EMBEDDING_PROFILE;
const HYDROLOGIC = [
  'The hydrologic cycle is the continuous movement of H2O on, above, and below Earth crust.',
  'Solar energy drives vapor from seas into the sky. That vapor cools and gathers as condensed droplets.',
  'Gravity later returns the liquid as storms. Some soaks underground and refills porous rock; some travels downhill in channels.',
].join(' ');
const GRANITE = [
  'Granite crystallizes slowly from magma deep underground.',
  'Coarse quartz and feldspar grains lock together as the melt cools over millennia.',
  'Weathering later exposes these plutons at the surface as durable ridges.',
].join(' ');
const PARAPHRASE = 'How does sunshine lift moisture that later falls as weather and replenishes hidden reservoirs?';
const LONG_TURN = 'abcdefghijklmnopqrstuvwxyz';

function parseArgs(argv) {
  const out = { receipt: DEFAULT_RECEIPT, output: DEFAULT_OUT, waitSec: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--receipt') out.receipt = resolve(argv[++i]);
    else if (arg === '--output') out.output = resolve(argv[++i]);
    else if (arg === '--wait') out.waitSec = Number.parseInt(argv[++i], 10) || 0;
  }
  return out;
}

function logger() {
  return { info() {}, warn() {}, debug() {}, error() {} };
}

function readJsonIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function writeReceipt(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function portOpen(port) {
  if (!Number.isInteger(port)) return false;
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = ok => {
      socket.removeAllListeners();
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(ok);
    };
    socket.setTimeout(800);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function resolveHomeRoot(hostReceipt, receiptPath) {
  const candidates = [
    hostReceipt?.homeRoot,
    hostReceipt?.home,
    hostReceipt?.root,
    hostReceipt?.state?.homeRoot,
    hostReceipt?.host?.homeRoot,
  ].filter(value => typeof value === 'string' && isAbsolute(value));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, '.home23-host.json')) || existsSync(join(candidate, 'app'))) {
      return candidate;
    }
  }
  const sibling = join(dirname(receiptPath), 'Home');
  if (existsSync(join(sibling, '.home23-host.json'))) return sibling;
  if (existsSync(join(dirname(receiptPath), '.home23-host.json'))) return dirname(receiptPath);
  const productHome = join(dirname(receiptPath), '..', '.stage5-product-home');
  if (existsSync(join(productHome, '.home23-host.json'))) return resolve(productHome);
  return candidates[0] || null;
}

function resolvePorts(hostReceipt, hostState) {
  return hostReceipt?.ports || hostReceipt?.state?.ports || hostState?.ports || {};
}

function resolveResidentName(hostReceipt, hostState, homeYaml) {
  const name = hostReceipt?.profile?.name
    || hostState?.profile?.name
    || hostState?.birth?.name
    || homeYaml?.home?.primaryAgent;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

function recipeFieldsFromEnv(env = {}) {
  return {
    SEED_EMBED_RECIPE_ID: typeof env.SEED_EMBED_RECIPE_ID === 'string' ? env.SEED_EMBED_RECIPE_ID : null,
    EMBEDDING_RECIPE_ID: typeof env.EMBEDDING_RECIPE_ID === 'string' ? env.EMBEDDING_RECIPE_ID : null,
    SEED_EMBED_MODEL: typeof env.SEED_EMBED_MODEL === 'string' ? env.SEED_EMBED_MODEL : null,
    EMBEDDING_MODEL: typeof env.EMBEDDING_MODEL === 'string' ? env.EMBEDDING_MODEL : null,
  };
}

async function liveProcessRecipeEnv(homeRoot, embedderPort) {
  const pm2 = join(homeRoot, 'tools/node_modules/pm2/bin/pm2');
  if (!existsSync(pm2)) return { available: false, reason: 'pm2-not-installed' };
  try {
    const env = productEnvironment(homeRoot, { encoderRequired: true, embedderPort });
    const { stdout } = await execFileAsync(pm2, ['jlist'], { env, timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) return { available: false, reason: 'pm2-jlist-invalid' };
    return {
      available: true,
      processes: rows.map(row => ({
        name: row.name,
        status: row.pm2_env?.status || 'unknown',
        pid: row.pid || 0,
        ...recipeFieldsFromEnv(row.pm2_env?.env || {}),
      })),
    };
  } catch (error) {
    return { available: false, reason: error.code || error.message };
  }
}

function inspectBirth(homeRoot, hostState, residentName) {
  const birthFromHost = hostState?.birth && typeof hostState.birth === 'object' ? hostState.birth : null;
  const namedReceipt = residentName
    ? join(homeRoot, 'app/instances', residentName, 'substrate/seed-01/birth-receipt.json')
    : null;
  const instancesDir = join(homeRoot, 'app/instances');
  let birthReceipt = null;
  let birthReceiptPath = null;
  const explicit = typeof birthFromHost?.receiptPath === 'string' ? birthFromHost.receiptPath : null;
  if (explicit && existsSync(explicit) && !explicit.endsWith('/')) {
    birthReceiptPath = explicit;
    birthReceipt = readJsonIfPresent(explicit);
  } else if (namedReceipt && existsSync(namedReceipt)) {
    birthReceiptPath = namedReceipt;
    birthReceipt = readJsonIfPresent(namedReceipt);
  } else if (existsSync(instancesDir)) {
    for (const name of readdirSync(instancesDir).filter(entry => !entry.startsWith('.'))) {
      const candidate = join(instancesDir, name, 'substrate/seed-01/birth-receipt.json');
      if (existsSync(candidate)) {
        birthReceiptPath = candidate;
        birthReceipt = readJsonIfPresent(candidate);
        break;
      }
    }
  }
  const modelInvocations = birthReceipt?.modelInvocations
    ?? birthFromHost?.modelInvocations
    ?? birthFromHost?.receipt?.modelInvocations
    ?? birthFromHost?.seed?.modelInvocations;
  const runtimeStarted = birthReceipt?.runtimeStarted
    ?? birthFromHost?.runtimeStarted
    ?? birthFromHost?.seed?.runtimeStarted;
  return {
    found: Boolean(birthReceipt || birthFromHost),
    schema: birthReceipt?.schema || birthFromHost?.seed?.schema || null,
    seedId: birthReceipt?.seedId || birthFromHost?.seedId || birthFromHost?.seed?.seedId || null,
    modelInvocations: Number.isInteger(modelInvocations) ? modelInvocations : null,
    runtimeStarted: runtimeStarted === undefined ? null : runtimeStarted,
    hostPhase: hostState?.phase || null,
    pass: modelInvocations === 0,
  };
}

function applyHostRecipeEnv({ seedEnv, embedding }) {
  if (seedEnv.SEED_EMBED_ENDPOINT) process.env.SEED_EMBED_ENDPOINT = seedEnv.SEED_EMBED_ENDPOINT;
  if (seedEnv.SEED_EMBED_MODEL) process.env.SEED_EMBED_MODEL = seedEnv.SEED_EMBED_MODEL;
  if (seedEnv.SEED_EMBED_RECIPE_ID) process.env.SEED_EMBED_RECIPE_ID = seedEnv.SEED_EMBED_RECIPE_ID;
  if (embedding.recipeId) process.env.EMBEDDING_RECIPE_ID = embedding.recipeId;
  if (embedding.model) process.env.EMBEDDING_MODEL = embedding.model;
  if (embedding.baseURL) process.env.EMBEDDING_BASE_URL = embedding.baseURL;
  process.env.EMBEDDING_PROVIDER = embedding.provider || 'home23-owned';
  process.env.EMBEDDING_DIMENSIONS = '768';
  process.env.EMBEDDING_API_KEY = 'owned';
}

function hostEmbeddingClient(port, model) {
  return {
    embeddings: {
      async create({ input }) {
        const payload = Array.isArray(input) ? input : [input];
        const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            host: `127.0.0.1:${port}`,
          },
          body: JSON.stringify({ model, input: payload }),
          signal: AbortSignal.timeout(15000),
        });
        const body = await response.json();
        if (!response.ok) {
          const error = new Error(`owned encoder embeddings ${response.status}`);
          error.body = body;
          throw error;
        }
        return body;
      },
    },
  };
}

function vectorPreview(vector) {
  if (!vector) return null;
  const values = Array.from(vector);
  return { dim: values.length, finite: values.every(Number.isFinite), head4: values.slice(0, 4) };
}

async function probeStampAndQuery({ embedderPort, model }) {
  const { NetworkMemory } = require('../../engine/src/memory/network-memory.js');
  const memory = new NetworkMemory({
    embedding: { model, dimensions: 768, recipeId: process.env.EMBEDDING_RECIPE_ID || OWNED_HASH },
    smallWorld: {},
    spreading: { bridgeTraversalFactor: 0.2, maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8 },
  }, logger(), { getEmbeddingClient: () => hostEmbeddingClient(embedderPort, model) });
  memory.tokenizer = null;

  const hydro = await memory.addNode({ concept: HYDROLOGIC, tag: 'document' });
  const granite = await memory.addNode({ concept: GRANITE, tag: 'document' });
  memory.importGraphChanges({
    nodes: [{ id: 99, concept: 'unstamped granite-shaped distractor for recipe refuse', embedding: granite.embedding }],
  });
  const imported = memory.nodes.get(99);
  const queryHash = memory.activeMemoryRecipe().hash;
  const hydroRecipe = memory.nodeEmbeddingRecipeId(hydro);
  const graniteRecipe = memory.nodeEmbeddingRecipeId(granite);
  const importedRecipe = memory.nodeEmbeddingRecipeId(imported);
  const comparableOwned = memory.embeddingsComparable(hydro.embedding, granite.embedding, queryHash, hydroRecipe);
  const refuseUnstamped = memory.embeddingsComparable(hydro.embedding, imported.embedding, queryHash, importedRecipe) === false;
  const refuseCross = memory.embeddingsComparable(hydro.embedding, granite.embedding, queryHash, contract.LEGACY_EMBEDDING_RECIPE_ID) === false;
  const connectionsSkipUnstamped = memory.findInitialConnections(hydro, hydro.id).every(row => row.id !== 99);
  const productQuery = await memory.query(PARAPHRASE, 5, { markAccess: false });
  const queriedUnstamped = productQuery.some(row => row.id === 99);
  const topLooksHydrologic = String(productQuery[0]?.concept || '').includes('hydrologic');
  const stamped = [hydro, granite].every(node => (
    node.embedding_recipe_id === OWNED_HASH
    && node.embedding_encoder === OWNED_PROFILE
    && (Array.isArray(node.embedding) || ArrayBuffer.isView(node.embedding))
    && node.embedding.length === 768
  ));
  return {
    pass: stamped && queryHash === OWNED_HASH && comparableOwned && refuseUnstamped && refuseCross
      && connectionsSkipUnstamped && !queriedUnstamped && topLooksHydrologic,
    activeRecipeHash: queryHash,
    hydro: {
      id: hydro.id,
      recipeId: hydroRecipe,
      encoder: hydro.embedding_encoder || null,
      embedding: vectorPreview(hydro.embedding),
    },
    granite: {
      id: granite.id,
      recipeId: graniteRecipe,
      encoder: granite.embedding_encoder || null,
      embedding: vectorPreview(granite.embedding),
    },
    importedUnstamped: {
      id: 99,
      recipeId: importedRecipe,
      encoder: imported?.embedding_encoder || null,
    },
    query: {
      refuseUnstamped,
      refuseCrossRecipe: refuseCross,
      comparableOwnedPair: comparableOwned,
      connectionsSkipUnstamped,
      queriedUnstamped,
      topLooksHydrologic,
      topPreview: String(productQuery[0]?.concept || '').slice(0, 80),
    },
  };
}

function inspectLiveContactStream(homeRoot, residentName) {
  if (!residentName) return { available: false };
  const streamPath = join(homeRoot, 'app/instances', residentName, 'substrate/conversation-stream.jsonl');
  if (!existsSync(streamPath)) return { available: false, streamPath: null };
  const lines = readFileSync(streamPath, 'utf8').split('\n').filter(Boolean);
  const parsed = lines.map(line => JSON.parse(line));
  const stampedOwned = parsed.filter(row => row.semantic_recipe_id === OWNED_HASH && row.semantic_encoder === OWNED_PROFILE);
  const unknown = parsed.filter(row => !Object.hasOwn(row, 'semantic_recipe_id'));
  return {
    available: true,
    lineCount: parsed.length,
    stampedOwnedCount: stampedOwned.length,
    unknownCount: unknown.length,
    newest: parsed.length ? {
      semantic_recipe_id: parsed[parsed.length - 1].semantic_recipe_id || null,
      semantic_encoder: parsed[parsed.length - 1].semantic_encoder || null,
      semantic_absence: parsed[parsed.length - 1].semantic_absence || null,
      vectorDim: Array.isArray(parsed[parsed.length - 1].semantic_vector) ? parsed[parsed.length - 1].semantic_vector.length : 0,
    } : null,
    pass: stampedOwned.length > 0 && stampedOwned.every(row => Array.isArray(row.semantic_vector) && row.semantic_vector.length === 16),
  };
}

async function probeContact(scratchDir) {
  rmSync(scratchDir, { recursive: true, force: true });
  const conversationsDir = join(scratchDir, 'conversations');
  const streamPath = join(scratchDir, 'seed-contact-stream.jsonl');
  const cursorPath = join(scratchDir, 'seed-contact-cursor.json');
  mkdirSync(conversationsDir, { recursive: true, mode: 0o700 });
  const oldLine = JSON.stringify({
    ts: '2026-08-09T14:00:00.000Z',
    role: 'user',
    text: 'should I do the sauna tonight?',
    session: 'legacy',
    contactId: 'legacy-old-contact',
    sourceRef: 'legacy.conversation:old',
    voice: 'jtr',
    semantic_vector: Array.from({ length: 16 }, () => 0.1),
  });
  writeFileSync(streamPath, `${oldLine}\n`, { mode: 0o600 });
  writeFileSync(join(conversationsDir, 'milo__ios_chat.jsonl'), `${JSON.stringify({
    role: 'user',
    content: 'Please remember the public hydrologic cycle note imported for the isolated test home.',
    ts: '2026-09-10T23:10:00.000Z',
  })}\n`, { mode: 0o600 });
  const { tsImport } = await import('tsx/esm/api');
  const { embedTextSync } = await tsImport('../../src/substrate/embed-at-contact.ts', import.meta.url);
  const { createConversationShipper } = await tsImport('../../substrate/src/conversation-shipper.ts', import.meta.url);
  const shipper = createConversationShipper({
    conversationsDir,
    streamPath,
    cursorPath,
    backfillBytes: 4096,
    maxAgeDays: 30,
    embed: embedTextSync,
  });
  const shipped = shipper.pass(Date.now());
  const lines = readFileSync(streamPath, 'utf8').split('\n').filter(Boolean);
  const newest = JSON.parse(lines[1] || '{}');
  const historyUntouched = lines[0] === oldLine && !Object.hasOwn(JSON.parse(lines[0]), 'semantic_recipe_id');
  const stampedOwned = newest.semantic_recipe_id === OWNED_HASH
    && newest.semantic_encoder === OWNED_PROFILE
    && Array.isArray(newest.semantic_vector)
    && newest.semantic_vector.length === 16
    && newest.semantic_absence === undefined;
  return {
    pass: shipped === 1 && historyUntouched && stampedOwned,
    shipped,
    historyUntouched,
    newest: {
      semantic_recipe_id: newest.semantic_recipe_id || null,
      semantic_encoder: newest.semantic_encoder || null,
      semantic_absence: newest.semantic_absence || null,
      vectorDim: Array.isArray(newest.semantic_vector) ? newest.semantic_vector.length : 0,
    },
    oldLineSha256: createHash('sha256').update(lines[0] || '').digest('hex'),
  };
}

async function probeAttention() {
  const { tsImport } = await import('tsx/esm/api');
  const attention = await tsImport('../../src/substrate/encoder-attention-policy.ts', import.meta.url);
  const match = await tsImport('../../src/substrate/semantic-match.ts', import.meta.url);
  match.resetSemanticMatchCache();
  const recipeId = attention.activeAttentionRecipeId();
  const policy = attention.resolveAttentionPolicy(recipeId);
  const score = match.semanticMatchScore(LONG_TURN, LONG_TURN, () => Array(768).fill(0.01));
  const pairAdmit = attention.admitsPairScore(0.99, policy);
  const poolAdmit = attention.admitsPoolScore(0.99, 0.1, policy);
  const borrowedFloor = policy.matchFloor === 0.6 || policy.matchMargin === 0.12;
  return {
    pass: recipeId === OWNED_HASH
      && policy.matchFloor === null
      && policy.matchMargin === null
      && policy.canSemanticGate === false
      && score === null
      && pairAdmit === false
      && poolAdmit === false
      && borrowedFloor === false,
    activeAttentionRecipeId: recipeId,
    policy: {
      profileId: policy.profileId,
      matchFloor: policy.matchFloor,
      matchMargin: policy.matchMargin,
      minMatchableAlnum: policy.minMatchableAlnum,
      canSemanticGate: policy.canSemanticGate,
    },
    semanticMatchScore: score,
    admitsPairAt099: pairAdmit,
    admitsPoolAt099: poolAdmit,
    borrowedLegacyCal: borrowedFloor,
  };
}

function homeReady({ hostState, ready, engineOpen }) {
  const desired = hostState?.desiredRunning === true || hostState?.phase === 'running';
  return ready?.warm === true && ready?.recipeId === OWNED_HASH && (engineOpen || desired || ready.warm);
}

export async function probeStage5Memory({
  receiptPath = DEFAULT_RECEIPT,
  outputPath = DEFAULT_OUT,
} = {}) {
  const startedAt = new Date().toISOString();
  const productHomeState = resolve(sourceRoot, '.stage5-product-home/.home23-host.json');
  const resolvedReceiptPath = existsSync(receiptPath) ? receiptPath
    : (existsSync(productHomeState) ? productHomeState : receiptPath);
  const hostReceipt = existsSync(resolvedReceiptPath) ? readJsonIfPresent(resolvedReceiptPath) : null;
  if (!hostReceipt) {
    const receipt = {
      schema: 'home23.embedder-stage5-memory.v1',
      ok: false,
      ran: false,
      reason: 'Host home not ready',
      hostReceiptPath: receiptPath,
      startedAt,
    };
    writeReceipt(outputPath, receipt);
    return receipt;
  }
  const homeRoot = resolveHomeRoot(hostReceipt, resolvedReceiptPath);
  const hostState = homeRoot ? readPrivateJSON(join(homeRoot, '.home23-host.json')) : null;
  const ports = resolvePorts(hostReceipt, hostState);
  const homeYamlPath = homeRoot ? join(homeRoot, 'app/config/home.yaml') : null;
  const homeYaml = homeYamlPath && existsSync(homeYamlPath) ? yaml.load(readFileSync(homeYamlPath, 'utf8')) || {} : {};
  const seedEnv = seedEmbedding.resolveSeedEmbeddingEnv(homeYaml);
  const selected = Array.isArray(homeYaml.embeddings?.providers)
    ? homeYaml.embeddings.providers.find(row => row?.provider && row?.model)
    : null;
  const embedding = {
    provider: selected?.provider || null,
    model: selected?.model || homeYaml.substrate?.embedding?.model || null,
    recipeId: selected?.recipeId || homeYaml.substrate?.embedding?.recipeId || seedEnv.SEED_EMBED_RECIPE_ID || null,
    baseURL: selected?.endpoint
      ? String(selected.endpoint).replace(/\/api\/embeddings\/?$/, '/v1')
      : (Number.isInteger(ports.embedder) ? `http://127.0.0.1:${ports.embedder}/v1` : null),
  };
  const ready = Number.isInteger(ports.embedder) ? await probeOwnedReady(ports.embedder, { timeoutMs: 4000 }) : { ok: false, warm: false };
  const engineOpen = await portOpen(ports.engine);
  const running = homeReady({ hostState, ready, engineOpen });
  const receipt = {
    schema: 'home23.embedder-stage5-memory.v1',
    kind: 'isolated-host-test-home',
    ran: false,
    ok: false,
    startedAt,
    hostReceiptPath: resolvedReceiptPath,
    expectedHostReceiptPath: receiptPath,
    hostPhase: hostState?.phase || hostReceipt?.phase || null,
    encoderRequired: hostState?.encoderRequired === true,
    ports: {
      embedder: ports.embedder || null,
      engine: ports.engine || null,
    },
    ready: {
      warm: ready.warm === true,
      recipeId: ready.recipeId || null,
      dimension: ready.dimension || null,
    },
    engineOpen,
    running,
    configRecipe: {
      seed: recipeFieldsFromEnv(seedEnv),
      embedding,
    },
  };
  if (!homeRoot || !hostState || !running || ready.warm !== true) {
    receipt.reason = 'Host home not ready';
    writeReceipt(outputPath, receipt);
    return receipt;
  }

  applyHostRecipeEnv({ seedEnv, embedding });
  const liveEnv = await liveProcessRecipeEnv(homeRoot, ports.embedder);
  receipt.liveProcessRecipes = {
    available: liveEnv.available === true,
    reason: liveEnv.reason || null,
    processes: (liveEnv.processes || []).map(row => ({
      name: row.name,
      status: row.status,
      SEED_EMBED_RECIPE_ID: row.SEED_EMBED_RECIPE_ID,
      EMBEDDING_RECIPE_ID: row.EMBEDDING_RECIPE_ID,
    })),
  };

  const scratchDir = join(dirname(outputPath), 'memory-probe-scratch');
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const stamp = await probeStampAndQuery({
    embedderPort: ports.embedder,
    model: embedding.model || OWNED_PROFILE,
  });
  const residentName = resolveResidentName(hostReceipt, hostState, homeYaml);
  const contact = await probeContact(scratchDir);
  contact.liveHostStream = inspectLiveContactStream(homeRoot, residentName);
  const attention = await probeAttention();
  const birth = inspectBirth(homeRoot, hostState, residentName);
  const semanticPrep = readPrivateJSON(join(homeRoot, 'runtime/semantic-prep.json'));
  receipt.ran = true;
  receipt.stamp = stamp;
  receipt.query = stamp.query;
  receipt.contact = contact;
  receipt.attention = attention;
  receipt.birth = {
    ...birth,
    semanticPrepPhase: semanticPrep?.phase || null,
    semanticPrepRecipeId: semanticPrep?.recipeId || null,
    throughPrepare: birth.pass === true && birth.modelInvocations === 0,
  };
  receipt.ok = stamp.pass === true
    && contact.pass === true
    && attention.pass === true
    && birth.pass === true;
  receipt.finishedAt = new Date().toISOString();
  writeReceipt(outputPath, receipt);
  return receipt;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + Math.max(0, args.waitSec) * 1000;
  let result;
  for (;;) {
    result = await probeStage5Memory({ receiptPath: args.receipt, outputPath: args.output });
    if (result.ran || Date.now() >= deadline) break;
    await sleep(60_000);
  }
  console.log(JSON.stringify({
    ok: result.ok === true,
    ran: result.ran === true,
    reason: result.reason || null,
    outputPath: args.output,
    stamp: result.stamp?.pass ?? null,
    query: result.query ? {
      refuseUnstamped: result.query.refuseUnstamped,
      refuseCrossRecipe: result.query.refuseCrossRecipe,
    } : null,
    contact: result.contact?.pass ?? null,
    attention: result.attention?.pass ?? null,
    birth: result.birth?.pass ?? null,
  }, null, 2));
  if (!result.ran) process.exitCode = 2;
  else if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
  });
}
