#!/usr/bin/env node
/** Isolated Host Stage 4 proof. New output directory only. Never touches
 * release/home23 or the default Host home. Real /ready when a cache is copied. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { choosePortPlan, embedderCacheDir, privateJSON } from '../../cli/lib/product-environment.js';
import { OWNED_RECIPE_HASH, beginSemanticPrepare, probeOwnedReady, reconcileSemanticPrep } from '../../cli/lib/product-embedder.js';
import { installProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';
import { ownedProcessNames, productDefinitions, runHostAction } from '../../cli/lib/product-host.js';

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, '../..');
const DEFAULT_CACHE = resolve(sourceRoot, '../owned-embedder-encoder-stage1/scripts/embedder-experiment/.cache');

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

export async function verifyEmbedderHost({ outputPath, cacheSource = process.env.HOME23_EMBEDDER_CACHE_SOURCE || DEFAULT_CACHE }) {
  outputPath = resolve(outputPath);
  mkdirSync(outputPath, { recursive: false, mode: 0o700 });
  const homeRoot = join(outputPath, 'Home');
  installMinimalHome(homeRoot);
  const ports = await choosePortPlan({ encoderRequired: true });
  const state = {
    schema: 'home23.host.v2', homeRoot, ports, encoderRequired: true, phase: 'prepared', desiredRunning: false,
    profile: { name: 'milo', provider: 'openai', model: 'gpt-4.1' },
    birth: { home: { id: 'home-stage4-test' }, coordination: { botId: 'bot-stage4-test' } },
  };
  privateJSON(join(homeRoot, '.home23-host.json'), state);
  const cache = embedderCacheDir(homeRoot);
  const receipt = { schema: 'home23.embedder-host-verification.v1', homeRoot, cache, realEncoder: false, steps: [] };
  const record = (step, extra = {}) => {
    receipt.steps.push({ step, at: new Date().toISOString(), ...extra });
    writeFileSync(join(outputPath, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  };

  if (!existsSync(join(cacheSource, 'nomic-ai/nomic-embed-text-v1.5/onnx/model.onnx'))) {
    record('unverified', { reason: 'Stage 1 encoder cache is not present; real GET /ready was not run.' });
    writeFileSync(join(outputPath, 'verification.json'), JSON.stringify({ ...receipt, ok: false, unverified: true }, null, 2) + '\n');
    return { ok: false, unverified: true, outputPath, homeRoot };
  }
  mkdirSync(cache, { recursive: true, mode: 0o700 });
  cpSync(cacheSource, cache, { recursive: true });
  record('cache-copied', { source: cacheSource, dest: cache });

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
    return { ok: false, outputPath, homeRoot, phase: current?.phase, error: current?.error };
  }

  const servePath = join(sourceRoot, 'scripts/embedder/serve.mjs');
  let embedder;
  const embedderRow = () => ({
    name: 'home23-embedder',
    pid: embedder?.pid || 0,
    pm2_env: {
      status: embedder && !embedder.killed ? 'online' : 'stopped',
      pm_cwd: join(homeRoot, 'app'),
      pm_exec_path: join(homeRoot, 'bin/node'),
      args: [join(homeRoot, 'app/scripts/embedder/serve.mjs')],
    },
  });
  const stopEmbedder = async () => {
    if (!embedder || embedder.killed) return;
    try { embedder.kill('SIGTERM'); } catch { /* already gone */ }
    await new Promise(resolve => {
      const timer = setTimeout(() => {
        try { embedder.kill('SIGKILL'); } catch { /* already gone */ }
        resolve();
      }, 2000);
      embedder.once('close', () => { clearTimeout(timer); resolve(); });
    });
  };
  const execute = async (_node, args) => {
    if (args?.[1] === 'jlist') {
      if (!embedder) return { stdout: '[]' };
      return { stdout: JSON.stringify([embedderRow()]) };
    }
    if (args?.[1] === 'start' && args.includes('home23-embedder')) {
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
      return { stdout: '' };
    }
    if (args?.[1] === 'stop' && String(args[2] || '').includes('embedder')) {
      await stopEmbedder();
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
  try {
    const started = await runHostAction('start', { homeRoot }, hostDeps);
    record('host-start', { ok: started.ok, status: started.status, error: started.error, encoderRequired: started.encoderRequired });
    const ready = await probeOwnedReady(ports.embedder, { timeoutMs: 2000 });
    record('ready', ready);
    assert.equal(ready.warm, true);
    assert.equal(ready.recipeId, OWNED_RECIPE_HASH);
    assert.equal(ready.dimension, 768);
    receipt.realEncoder = true;

    const stopped = await runHostAction('stop', { homeRoot }, hostDeps);
    record('host-stop', { ok: stopped.ok, status: stopped.status, desiredRunning: stopped.desiredRunning });
    record('stop-exit', {
      exitCode: embedder?.exitCode ?? null,
      signal: embedder?.signalCode ?? null,
      acceptedAbort: embedder?.exitCode === 134 || embedder?.signalCode === 'SIGABRT' || embedder?.exitCode === 0 || embedder?.exitCode === null,
    });
    const after = await probeOwnedReady(ports.embedder, { timeoutMs: 800 });
    record('reconcile', { warmAfterStop: after.warm === true, desiredRunning: stopped.desiredRunning === true });
    assert.equal(after.warm, false);
    assert.equal(stopped.desiredRunning, false);
    receipt.ok = true;
    writeFileSync(join(outputPath, 'verification.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    return { ok: true, realEncoder: true, outputPath, homeRoot, recipeId: OWNED_RECIPE_HASH, port: ports.embedder };
  } finally {
    await stopEmbedder();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outputPath = process.argv[2];
  if (!outputPath) throw new Error('Usage: verify-embedder-host.mjs NEW_OUTPUT_DIRECTORY');
  try { console.log(JSON.stringify(await verifyEmbedderHost({ outputPath }), null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
