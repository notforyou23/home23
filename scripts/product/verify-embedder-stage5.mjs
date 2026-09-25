#!/usr/bin/env node
/** Isolated Stage 5 milestone checks. New output directory only.
 * Never touches release/home23, the default Host home, or existing homes.
 * Chat e2e is unverified unless credentials were supplied for this work. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { choosePortPlan, embedderCacheDir, privateJSON } from '../../cli/lib/product-environment.js';
import { OWNED_RECIPE_HASH, beginSemanticPrepare, probeOwnedReady, reconcileSemanticPrep } from '../../cli/lib/product-embedder.js';
import { OWNED_PROFILE_ID } from '../../cli/lib/product-embedder.js';
import { installProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';
import { ownedProcessNames, productDefinitions, runHostAction } from '../../cli/lib/product-host.js';
import { prepareSeedBirth } from '../../cli/lib/seed-birth.js';

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, '../..');
const DEFAULT_CACHE = resolve(sourceRoot, '../owned-embedder-encoder-stage1/scripts/embedder-experiment/.cache');
const require = createRequire(import.meta.url);
const contract = require('../../shared/semantic-encoder-contract.cjs');

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

function installMinimalHome(homeRoot) {
  const payload = join(dirname(homeRoot), 'payload');
  for (const [file, content] of Object.entries({
    'bin/node': 'node',
    'app/cli/home23.js': '',
    'app/cli/lib/product-payload.js': '',
    'app/scripts/product/host.mjs': '',
    'app/scripts/embedder/serve.mjs': '',
    'app/dist/home.js': '',
    'tools/node_modules/pm2/bin/pm2': '',
  })) {
    mkdirSync(dirname(join(payload, file)), { recursive: true, mode: 0o755 });
    writeFileSync(join(payload, file), content, { mode: file === 'bin/node' ? 0o755 : 0o644 });
  }
  writeProductManifest(payload, {
    sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.2',
  });
  installProductPayload({ payloadPath: payload, homeRoot });
}

function sharedTokens(a, b) {
  const words = text => new Set(String(text).toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4));
  const left = words(a);
  const right = words(b);
  return [...left].filter(word => right.has(word));
}

function cosine(a, b) {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    left += a[i] * a[i];
    right += b[i] * b[i];
  }
  return dot / (Math.sqrt(left) * Math.sqrt(right) || 1);
}

function snapshotDir(dir) {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => {
      const parent = entry.parentPath ?? entry.path;
      const file = join(parent, entry.name);
      return [file.slice(dir.length), createHash('sha256').update(readFileSync(file)).digest('hex')];
    }));
}

function logger() {
  return {
    info() {},
    warn() {},
    debug() {},
    error(message, meta) { console.error(JSON.stringify({ level: 'error', message, meta })); },
  };
}

export async function verifyEmbedderStage5({
  outputPath,
  cacheSource = process.env.HOME23_EMBEDDER_CACHE_SOURCE || DEFAULT_CACHE,
} = {}) {
  outputPath = resolve(outputPath);
  mkdirSync(outputPath, { recursive: false, mode: 0o700 });
  const homeRoot = join(outputPath, 'Home');
  installMinimalHome(homeRoot);
  const ports = await choosePortPlan({ encoderRequired: true });
  const profile = { name: 'milo', provider: 'ollama-local', model: 'llama3.2', ownerName: 'StageFive' };
  const state = {
    schema: 'home23.host.v2', homeRoot, ports, encoderRequired: true, phase: 'prepared', desiredRunning: false,
    profile, birth: null,
  };
  privateJSON(join(homeRoot, '.home23-host.json'), state);
  const cache = embedderCacheDir(homeRoot);
  if (cache !== join(homeRoot, 'runtime', 'embedder-cache') || cache.includes('/release/home23')) {
    throw new Error('Stage 5 cache must be this TEST home runtime directory.');
  }
  const receipt = {
    schema: 'home23.embedder-stage5-verification.v1',
    kind: 'isolated-test-home',
    homeRoot,
    cache,
    realEncoder: false,
    chatE2e: { status: 'unverified', reason: 'Chat-provider credentials were not supplied for this work.' },
    calibration: {
      ownedMatchFloor: contract.resolveAttentionPolicy(contract.OWNED_EMBEDDING_PROFILE).matchFloor,
      invented: false,
    },
    steps: [],
  };
  const record = (step, extra = {}) => {
    receipt.steps.push({ step, at: new Date().toISOString(), ...extra });
    writeFileSync(join(outputPath, 'verification.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  };

  const modelOnnx = join(cacheSource, 'nomic-ai/nomic-embed-text-v1.5/onnx/model.onnx');
  if (!existsSync(modelOnnx)) {
    record('unverified', { reason: 'Stage 1 encoder cache is not present; real GET /ready was not run.' });
    receipt.ok = false;
    receipt.unverified = true;
    writeFileSync(join(outputPath, 'verification.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return { ok: false, unverified: true, outputPath, homeRoot };
  }
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  cpSync(cacheSource, cache, { recursive: true });
  record('cache-copied', { source: cacheSource, dest: cache, fixture: false, real: true });

  const birthRoot = join(homeRoot, 'app');
  const firstBirth = await prepareSeedBirth(birthRoot, {
    name: profile.name,
    ownerName: profile.ownerName,
    purpose: 'Isolated Stage 5 owned-embedder verification. No personal facts.',
    provider: profile.provider,
    model: profile.model,
  });
  const birthBytes = snapshotDir(firstBirth.stateDir);
  const retryBirth = await prepareSeedBirth(birthRoot, {
    name: profile.name,
    ownerName: profile.ownerName,
    purpose: 'Isolated Stage 5 owned-embedder verification. No personal facts.',
    provider: profile.provider,
    model: profile.model,
  });
  const birthRetryBytes = snapshotDir(retryBirth.stateDir);
  assert.equal(firstBirth.receipt.modelInvocations, 0);
  assert.equal(retryBirth.receipt.modelInvocations, 0);
  assert.deepEqual(retryBirth.receipt, firstBirth.receipt);
  assert.deepEqual(birthRetryBytes, birthBytes);
  state.birth = { seedId: firstBirth.receipt.seedId, stateDir: firstBirth.receipt.stateDir, modelInvocations: firstBirth.receipt.modelInvocations };
  privateJSON(join(homeRoot, '.home23-host.json'), state);
  record('seed-birth', {
    real: true,
    seedId: firstBirth.receipt.seedId,
    modelInvocations: firstBirth.receipt.modelInvocations,
    runtimeStarted: firstBirth.receipt.runtimeStarted,
    retryByteIdentical: true,
    encoderSideEffects: false,
  });

  const importDir = join(homeRoot, 'runtime', 'import');
  mkdirSync(importDir, { recursive: true, mode: 0o700 });
  const hydrologicPath = join(importDir, 'usgs-style-hydrologic-cycle.txt');
  const granitePath = join(importDir, 'usgs-style-granite.txt');
  writeFileSync(hydrologicPath, `${HYDROLOGIC}\n`, { mode: 0o600 });
  writeFileSync(granitePath, `${GRANITE}\n`, { mode: 0o600 });
  record('documents-written', {
    hydrologicPath,
    granitePath,
    paraphrase: PARAPHRASE,
    sharedTokensWithTarget: sharedTokens(HYDROLOGIC, PARAPHRASE),
    source: 'original public-domain educational prose (USGS-style facts; not personal)',
  });

  const prep = beginSemanticPrepare(homeRoot, state, { nodePath: process.execPath });
  record('semantic-prepare', { handle: prep.handle, phase: prep.phase });
  const until = Date.now() + 180_000;
  let current = reconcileSemanticPrep(homeRoot);
  while (Date.now() < until && !['ready', 'failed'].includes(current?.phase)) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    current = reconcileSemanticPrep(homeRoot);
  }
  record('semantic-prepare-status', current || {});
  if (current?.phase !== 'ready') {
    receipt.ok = false;
    writeFileSync(join(outputPath, 'verification.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    return { ok: false, outputPath, homeRoot, phase: current?.phase, error: current?.error };
  }

  const servePath = join(sourceRoot, 'scripts/embedder/serve.mjs');
  let embedder;
  const pm2Stopped = new Set();
  const embedderRow = () => ({
    name: 'home23-embedder',
    pid: embedder?.pid || 0,
    pm2_env: {
      status: pm2Stopped.has('home23-embedder') || !embedder || embedder.killed || embedder.exitCode !== null
        ? 'stopped'
        : 'online',
      pm_cwd: join(homeRoot, 'app'),
      pm_exec_path: join(homeRoot, 'bin/node'),
      args: [join(homeRoot, 'app/scripts/embedder/serve.mjs')],
    },
  });
  const stopEmbedder = async () => {
    if (!embedder || embedder.killed) {
      embedder = undefined;
      return;
    }
    try { embedder.kill('SIGTERM'); } catch { /* already gone */ }
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { embedder.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, 2000);
      embedder.once('close', () => { clearTimeout(timer); resolve(); });
    });
    embedder = undefined;
  };
  const spawnEmbedder = () => {
    embedder = spawn(process.execPath, [servePath, '--port', String(ports.embedder), '--bind', '127.0.0.1', '--cache', cache], {
      cwd: sourceRoot,
      env: {
        ...process.env,
        HOME23_EMBEDDER_PORT: String(ports.embedder),
        HOME23_EMBEDDER_BIND: '127.0.0.1',
        HOME23_EMBEDDER_CACHE: cache,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  const execute = async (_node, args) => {
    if (args?.[1] === 'jlist') {
      if (!embedder) return { stdout: '[]' };
      return { stdout: JSON.stringify([embedderRow()]) };
    }
    if ((args?.[1] === 'start' || args?.[1] === 'restart') && String(args.includes('home23-embedder') ? 'home23-embedder' : args[2] || '').includes('embedder')) {
      if (args?.[1] === 'restart') await stopEmbedder();
      pm2Stopped.delete('home23-embedder');
      spawnEmbedder();
      return { stdout: '' };
    }
    if (args?.[1] === 'delete' && String(args[2] || '').includes('embedder')) {
      // PM2 delete ends the process and drops its record; Start re-registers a changed definition this way.
      await stopEmbedder();
      pm2Stopped.delete('home23-embedder');
      return { stdout: '' };
    }
    if (args?.[1] === 'stop' && String(args[2] || '').includes('embedder')) {
      // PM2 stop is a no-op leak. Host must SIGTERM the /ready pid so /ready is not left warm.
      pm2Stopped.add('home23-embedder');
      return { stdout: '' };
    }
    return { stdout: '' };
  };
  const apps = ownedProcessNames('milo', { encoderRequired: true }).map(name => ({
    name,
    script: name === 'home23-embedder' ? 'scripts/embedder/serve.mjs' : 'dist/home.js',
    cwd: join(homeRoot, 'app'),
    env: {},
    args: [],
  }));
  const hostDeps = {
    execute,
    definitions: () => productDefinitions(apps, homeRoot, 'milo', { encoderRequired: true, embedderPort: ports.embedder }),
    probeReadiness: async (_root, liveState) => {
      const ready = await probeOwnedReady(liveState.ports.embedder, { timeoutMs: 2000 });
      return { ready: ready.warm === true && ready.recipeId === OWNED_RECIPE_HASH, issues: ready.warm ? [] : ['owned encoder not warm'], memory: {} };
    },
    readinessWaitMs: 5000,
  };

  const startEncoder = async (label) => {
    const started = await runHostAction('start', { homeRoot }, hostDeps);
    const ready = await probeOwnedReady(ports.embedder, { timeoutMs: 4000 });
    record(label, { host: { ok: started.ok, status: started.status, error: started.error, encoderRequired: started.encoderRequired }, ready });
    assert.equal(ready.warm, true);
    assert.equal(ready.recipeId, OWNED_RECIPE_HASH);
    assert.equal(ready.dimension, 768);
    receipt.realEncoder = true;
    return ready;
  };

  try {
    const firstReady = await startEncoder('host-start-ready');
    assert.equal(firstReady.recipeId, '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9');

    process.env.EMBEDDING_BASE_URL = `http://127.0.0.1:${ports.embedder}/v1`;
    process.env.EMBEDDING_API_KEY = 'owned';
    process.env.EMBEDDING_MODEL = OWNED_PROFILE_ID;
    process.env.EMBEDDING_DIMENSIONS = '768';
    process.env.EMBEDDING_PROVIDER = 'home23-owned';
    delete process.env.EMBEDDING_RECIPE_ID;
    process.env.SEED_EMBED_ENDPOINT = `http://127.0.0.1:${ports.embedder}/api/embeddings`;
    process.env.SEED_EMBED_MODEL = OWNED_PROFILE_ID;
    process.env.SEED_EMBED_RECIPE_ID = OWNED_RECIPE_HASH;

    const { NetworkMemory } = require('../../engine/src/memory/network-memory.js');
    const { DocumentFeeder } = require('../../engine/src/ingestion/document-feeder.js');
    const memory = new NetworkMemory({
      embedding: { model: OWNED_PROFILE_ID, dimensions: 768 },
      smallWorld: {},
      spreading: { bridgeTraversalFactor: 0.2, maxDepth: 2, activationThreshold: 0.01, decayFactor: 0.8 },
    }, logger());
    memory.tokenizer = null;
    const runPath = join(homeRoot, 'runtime', 'engine-run');
    mkdirSync(runPath, { recursive: true, mode: 0o700 });
    const feeder = new DocumentFeeder({
      memory,
      config: { compiler: { enabled: false }, maintenanceMode: true },
      logger: logger(),
    });
    let importPath = 'document-feeder.ingestFile';
    try {
      await feeder.start(runPath);
      await feeder.ingestFile(hydrologicPath, 'public-usgs-style');
      await feeder.ingestFile(granitePath, 'public-usgs-style');
    } catch (error) {
      importPath = `document-feeder-failed:${error.message}; fallback NetworkMemory.addNode`;
      await memory.addNode({ concept: HYDROLOGIC, tag: 'document', metadata: { sourcePath: hydrologicPath } });
      await memory.addNode({ concept: GRANITE, tag: 'document', metadata: { sourcePath: granitePath } });
    }

    const nodes = [...memory.nodes.values()].map(node => ({
      id: node.id,
      tag: node.tag,
      conceptPreview: String(node.concept || '').slice(0, 80),
      dim: Array.isArray(node.embedding) || ArrayBuffer.isView(node.embedding) ? node.embedding.length : 0,
      embeddingStatus: node.embedding_status,
      recipeId: node.embedding_recipe_id || null,
      head4: node.embedding ? Array.from(node.embedding).slice(0, 4) : null,
    }));
    const queryVector = await memory.embed(PARAPHRASE);
    assert.ok(Array.isArray(queryVector) || ArrayBuffer.isView(queryVector));
    assert.equal(queryVector.length, 768);
    assert.ok(Array.from(queryVector).every(n => Number.isFinite(n)));
    const ranked = [...memory.nodes.values()]
      .filter(node => node.embedding && node.embedding.length === 768)
      .map(node => ({
        id: node.id,
        conceptPreview: String(node.concept || '').slice(0, 80),
        cosine: cosine(Array.from(queryVector), Array.from(node.embedding)),
        looksHydrologic: String(node.concept || '').includes('hydrologic'),
      }))
      .sort((a, b) => b.cosine - a.cosine);
    const productQuery = await memory.query(PARAPHRASE, 5, { markAccess: false });
    const keywordOnly = memory.queryByKeyword(PARAPHRASE, 5, { markAccess: false });
    const top = ranked[0];
    const stampedOwnedNodes = nodes.filter(node => node.dim === 768).every(node => node.recipeId === OWNED_RECIPE_HASH);
    const retrievalPass = Boolean(top?.looksHydrologic) && typeof top?.cosine === 'number' && top.cosine > (ranked.find(row => !row.looksHydrologic)?.cosine ?? 0) && stampedOwnedNodes;
    record('document-retrieval', {
      fixture: false,
      real: true,
      importPath,
      nodeCount: memory.nodes.size,
      nodes,
      query: PARAPHRASE,
      queryDim: queryVector.length,
      queryHead4: Array.from(queryVector).slice(0, 4),
      cosineRanking: ranked,
      productQueryTop: productQuery.slice(0, 3).map(node => ({
        id: node.id,
        conceptPreview: String(node.concept || '').slice(0, 80),
        similarity: node.similarity,
        retrievalScore: node.retrievalScore,
      })),
      keywordOnlyTop: keywordOnly.slice(0, 3).map(node => ({
        id: node.id,
        conceptPreview: String(node.concept || '').slice(0, 80),
        similarity: node.similarity,
      })),
      sharedTokensWithTarget: sharedTokens(HYDROLOGIC, PARAPHRASE),
      pass: retrievalPass,
      note: 'New NetworkMemory nodes persist embedding_recipe_id as the owned hash. Imported history is not backfilled. Query uses the same name↔hash resolver.',
    });
    assert.equal(retrievalPass, true, 'paraphrase did not retrieve the imported hydrologic document by cosine');

    const conversationsDir = join(homeRoot, 'runtime', 'conversations');
    mkdirSync(conversationsDir, { recursive: true, mode: 0o700 });
    const streamPath = join(homeRoot, 'runtime', 'seed-contact-stream.jsonl');
    const cursorPath = join(homeRoot, 'runtime', 'seed-contact-cursor.json');
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
      content: 'Please remember the public hydrologic cycle note we imported for the isolated test home.',
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
    const shipped = shipper.pass(Date.parse('2026-09-10T23:10:01.000Z'));
    const lines = readFileSync(streamPath, 'utf8').split('\n').filter(Boolean);
    const newest = JSON.parse(lines[1] || '{}');
    const historyUntouched = lines[0] === oldLine && !Object.hasOwn(JSON.parse(lines[0]), 'semantic_recipe_id');
    const stampedOwned = newest.semantic_recipe_id === OWNED_RECIPE_HASH
      && newest.semantic_encoder === contract.OWNED_EMBEDDING_PROFILE
      && Array.isArray(newest.semantic_vector)
      && newest.semantic_vector.length === 16
      && newest.semantic_absence === undefined;
    record('semantic-contact', {
      fixture: false,
      real: Boolean(stampedOwned),
      shipped,
      historyUntouched,
      newest: {
        contactPreview: String(newest.text || '').slice(0, 80),
        semantic_recipe_id: newest.semantic_recipe_id,
        semantic_encoder: newest.semantic_encoder,
        semantic_absence: newest.semantic_absence || null,
        vectorDim: Array.isArray(newest.semantic_vector) ? newest.semantic_vector.length : 0,
      },
      pass: shipped === 1 && historyUntouched && stampedOwned,
    });
    assert.equal(shipped, 1);
    assert.equal(historyUntouched, true);
    assert.equal(stampedOwned, true);

    const identityBefore = {
      host: JSON.parse(readFileSync(join(homeRoot, '.home23-host.json'), 'utf8')),
      birth: firstBirth.receipt,
      birthFiles: snapshotDir(firstBirth.stateDir),
      contactSha: createHash('sha256').update(readFileSync(streamPath)).digest('hex'),
    };

    const stopped = await runHostAction('stop', { homeRoot }, hostDeps);
    const afterStop = await probeOwnedReady(ports.embedder, { timeoutMs: 800 });
    record('host-stop', {
      ok: stopped.ok,
      status: stopped.status,
      desiredRunning: stopped.desiredRunning,
      afterStopWarm: afterStop.warm,
      leftoverListen: afterStop.warm === true,
      exitCode: embedder?.exitCode ?? null,
      signal: embedder?.signalCode ?? null,
    });
    assert.equal(afterStop.warm, false);
    assert.equal(afterStop.ok, false);
    assert.equal(stopped.desiredRunning, false);

    const secondReady = await startEncoder('host-restart-ready');
    assert.equal(secondReady.recipeId, firstReady.recipeId);
    assert.equal(secondReady.dimension, 768);
    const birthAfter = await prepareSeedBirth(birthRoot, {
      name: profile.name,
      ownerName: profile.ownerName,
      purpose: 'Isolated Stage 5 owned-embedder verification. No personal facts.',
      provider: profile.provider,
      model: profile.model,
    });
    const identityAfter = {
      host: JSON.parse(readFileSync(join(homeRoot, '.home23-host.json'), 'utf8')),
      birth: birthAfter.receipt,
      birthFiles: snapshotDir(birthAfter.stateDir),
      contactSha: createHash('sha256').update(readFileSync(streamPath)).digest('hex'),
    };
    const restartPass = identityAfter.birth.seedId === identityBefore.birth.seedId
      && identityAfter.contactSha === identityBefore.contactSha
      && JSON.stringify(identityAfter.birthFiles) === JSON.stringify(identityBefore.birthFiles)
      && identityAfter.host.encoderRequired === true
      && identityAfter.host.schema === 'home23.host.v2';
    record('restart-continuity', {
      real: true,
      recipeId: secondReady.recipeId,
      warm: secondReady.warm,
      seedId: identityAfter.birth.seedId,
      contactUnchanged: identityAfter.contactSha === identityBefore.contactSha,
      birthUnchanged: JSON.stringify(identityAfter.birthFiles) === JSON.stringify(identityBefore.birthFiles),
      pass: restartPass,
    });
    assert.equal(restartPass, true);

    const finalStop = await runHostAction('stop', { homeRoot }, hostDeps);
    record('host-final-stop', { ok: finalStop.ok, desiredRunning: finalStop.desiredRunning });

    receipt.ok = true;
    receipt.checks = {
      ownedEncoderReady: { status: 'pass', kind: 'real' },
      documentRetrieval: { status: retrievalPass ? 'pass' : 'fail', kind: 'real' },
      semanticContact: { status: stampedOwned ? 'pass' : 'fail', kind: 'real' },
      restartContinuity: { status: restartPass ? 'pass' : 'fail', kind: 'real' },
      chatE2e: { status: 'unverified', kind: 'blocked', dependency: 'chat-provider credentials' },
    };
    writeFileSync(join(outputPath, 'verification.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    return { ok: true, realEncoder: true, outputPath, homeRoot, recipeId: OWNED_RECIPE_HASH, port: ports.embedder, checks: receipt.checks };
  } finally {
    await stopEmbedder();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error('Usage: verify-embedder-stage5.mjs NEW_OUTPUT_DIRECTORY');
  try { console.log(JSON.stringify(await verifyEmbedderStage5({ outputPath }), null, 2)); }
  catch (error) {
    console.error(error.stack);
    process.exit(1);
  }
}
