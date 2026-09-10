#!/usr/bin/env node
/** Full installed-runtime proof. All home data is created under a new output
 * directory. Model/embedding replies are local fixtures, never owner accounts.
 * This is deliberately separate from unit tests: it launches the shipped stack.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyInstalledHome({ payloadPath, outputPath, resumeInstall = false }) {
  payloadPath = resolve(payloadPath); outputPath = resolve(outputPath);
  const homeRoot = join(outputPath, 'Home');
  if (resumeInstall) {
    // This switch only recovers an interrupted copy, before a resident is born.
    // The installer still validates the exact package and owns its copy lock.
    const stat = lstatSync(outputPath);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o077), 'Recovery output must be an owned private directory');
    const claim = JSON.parse(readFileSync(join(outputPath, '.Home.home23-install.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(payloadPath, 'manifest.json'), 'utf8'));
    assert.equal(claim.schema, 'home23.product-install.v1');
    assert.equal(claim.homeRoot, homeRoot);
    assert.equal(claim.packageId, manifest.packageId);
    assert.ok(!existsSync(homeRoot), 'Recovery is only allowed before installation activation; retain an existing home for inspection');
  } else {
    mkdirSync(outputPath, { recursive: false, mode: 0o700 }); // never reuse somebody else's home
  }
  const receipts = [];
  const record = (step, result) => {
    receipts.push({ step, at: new Date().toISOString(), ...result });
    writeFileSync(join(outputPath, 'verification.json'), JSON.stringify({
      schema: 'home23.product-install-verification.v1',
      model: 'local fixture; no paid provider or owner credentials', homeRoot, receipts,
    }, null, 2) + '\n', { mode: 0o600 });
    console.error(`[installed-home] ${step}`);
  };
  let installed = false;
  let started = false;
  let failure;
  let calls = 0;
  let embeddingCalls = 0;
  const answer = 'This independent home is running from its installed package.';
  const model = createServer(async (request, response) => {
    let raw = '';
    for await (const part of request) {
      raw += part;
      if (raw.length > 8 * 1024 * 1024) { response.writeHead(413); response.end(); return; }
    }
    const body = raw ? JSON.parse(raw) : {};
    response.setHeader('content-type', 'application/json');
    if (request.url?.includes('embed')) {
      embeddingCalls++;
      const vector = Array.from({ length: 768 }, (_, index) => index === 0 ? 1 : 0);
      response.end(JSON.stringify({ embedding: vector, embeddings: [vector], data: [{ embedding: vector, index: 0 }], model: body.model }));
    } else if (request.url?.endsWith('/tags')) {
      response.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'nomic-embed-text' }] }));
    } else {
      calls++;
      if (body.stream && request.url?.includes('/chat/completions')) {
        response.setHeader('content-type', 'text/event-stream');
        const chunk = { id: 'chatcmpl-fixture', object: 'chat.completion.chunk', model: body.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }] };
        const done = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } };
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`);
        return;
      }
      if (body.stream) response.setHeader('content-type', 'application/x-ndjson');
      response.end(JSON.stringify({ model: body.model, done: true,
        message: { role: 'assistant', content: answer }, response: answer,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }, prompt_eval_count: 10, eval_count: 10,
      }) + '\n');
    }
  });
  await new Promise((accept, reject) => { model.once('error', reject); model.listen(0, '127.0.0.1', accept); });
  const modelURL = `http://127.0.0.1:${model.address().port}`;
  const command = async (action, input) => {
    const runtime = installed ? homeRoot : payloadPath;
    const args = [join(runtime, 'app/scripts/product/host.mjs'), action, '--home', homeRoot];
    if (action === 'install') args.push('--payload', payloadPath);
    const env = { PATH: `${join(runtime, 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: outputPath, TMPDIR: '/private/tmp', LANG: 'en_US.UTF-8' };
    const result = await new Promise((accept, reject) => {
      const child = spawn(join(runtime, 'bin/node'), args, { env, stdio: ['pipe', 'pipe', 'pipe'], cwd: runtime });
      let stdout = '', stderr = '';
      // Copying and hashing the complete runtime can exceed five minutes on
      // external disks. Keep this bounded, and report a timeout as a timeout.
      const timeoutMs = action === 'install' ? 900_000 : 300_000;
      let timedOut = false;
      const deadline = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) child.kill('SIGTERM'); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-100_000); });
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('close', code => {
        clearTimeout(deadline);
        writeFileSync(join(outputPath, `${receipts.length}-${action}.log`), stderr, { mode: 0o600 });
        if (timedOut) { reject(new Error(`${action} timed out after ${timeoutMs / 1000}s; retained recovery state at ${homeRoot}`)); return; }
        let value;
        try { value = JSON.parse(stdout.trim()); } catch { reject(new Error(`${action} returned invalid JSON (exit ${code}); see its log`)); return; }
        if (code !== 0 || value.ok === false) reject(new Error(`${action}: ${value.error?.message || value.error || value.message || `exit ${code}`}`));
        else accept(value);
      });
      child.stdin.end(input ? JSON.stringify(input) : '');
    });
    return result;
  };
  const startAndWait = async step => {
    let live = await command('start');
    const deadline = Date.now() + 180_000;
    while (live.status === 'starting' && Date.now() < deadline) {
      await new Promise(accept => setTimeout(accept, 2_000));
      live = await command('status');
    }
    record(step, live);
    assert.equal(live.status, 'ready', `Installed home did not become ready; inspect ${step} receipt`);
    return live;
  };
  try {
    record('begin', { payloadPath, resumedInstall: resumeInstall });
    record('install', await command('install')); installed = true;
    const profile = { name: 'milo', displayName: 'Milo', ownerName: 'Product fixture',
      homeName: 'Independent product fixture', purpose: 'Exercise a newly installed home.',
      provider: 'ollama-local', model: 'qwen2.5:7b', timezone: 'UTC' };
    record('create', await command('create', { profile, credential: { provider: 'ollama-local', baseUrl: modelURL } }));
    // Chat stays on the local fixture. The owned encoder endpoint is independent
    // of that chat URL. Do not retarget embeddings at the fixture.
    const require = createRequire(join(homeRoot, 'app/package.json'));
    const yaml = require('js-yaml');
    const configPath = join(homeRoot, 'app/config/home.yaml');
    const config = yaml.load(readFileSync(configPath, 'utf8'));
    config.providers['ollama-local'].baseUrl = modelURL;
    writeFileSync(configPath, yaml.dump(config), { mode: 0o600 });
    const created = JSON.parse(readFileSync(join(homeRoot, '.home23-host.json'), 'utf8'));
    if (created.encoderRequired === true) {
      const { embedderCacheDir } = await import('../../cli/lib/product-environment.js');
      const cacheSource = process.env.HOME23_EMBEDDER_CACHE_SOURCE
        || resolve(join(homeRoot, '..', '..', '..', '.home23-worktrees', 'owned-embedder-encoder-stage1', 'scripts', 'embedder-experiment', '.cache'));
      const cache = embedderCacheDir(homeRoot);
      if (existsSync(join(cacheSource, 'nomic-ai/nomic-embed-text-v1.5/onnx/model.onnx'))) {
        mkdirSync(cache, { recursive: true, mode: 0o700 });
        const { cpSync } = await import('node:fs');
        cpSync(cacheSource, cache, { recursive: true });
        record('semantic-prepare', await command('semantic-prepare'));
        const prepUntil = Date.now() + 180_000;
        let prep = await command('status');
        while (Date.now() < prepUntil && !['ready', 'failed'].includes(prep.semantic?.phase)) {
          await new Promise(accept => setTimeout(accept, 2000));
          prep = await command('status');
        }
        record('semantic-prepare-status', prep);
        assert.equal(prep.semantic?.phase, 'ready', 'Owned semantic preparation must finish before Start admits writers');
      } else {
        record('semantic-unverified', { reason: 'No Stage 1 cache; not starting writers against an unprepared owned encoder.' });
        throw new Error('Owned encoder cache is missing; Stage 4 real /ready was not verified in this payload proof');
      }
    }
    const birthPath = join(homeRoot, 'app/instances/milo/substrate/seed-01/birth-receipt.json');
    const birth = JSON.parse(readFileSync(birthPath, 'utf8'));
    started = true; // also stop a partially admitted start
    const live = await startAndWait('start');
    const origin = live.connection.localURL;
    const request = async (path, body, token) => {
      const response = await fetch(`${origin}${path}`, { method: body ? 'POST' : 'GET',
        headers: { ...(body ? { 'content-type': 'application/json', 'idempotency-key': randomUUID() } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
      const value = await response.json();
      assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(value)}`);
      return value;
    };
    const session = await request('/api/v1/pairing/sessions', { deviceName: 'Installed product fixture' });
    const paired = await request(`/api/v1/pairing/sessions/${session.pairingSession.id}/redeem`, {
      pairingCode: session.pairingCode, device: { name: 'Installed product fixture', platform: 'macos', appBuild: 'fixture' } });
    const bootstrap = await request('/api/v1/bootstrap', null, paired.accessToken);
    assert.equal(bootstrap.snapshot.bots.length, 1);
    assert.equal(bootstrap.snapshot.bots[0].name, 'Milo');
    assert.equal(bootstrap.snapshot.bots[0].availability, 'available');
    const journal = JSON.parse(readFileSync(join(homeRoot, 'app/instances/.house/creation.json'), 'utf8'));
    const channelId = journal.receipt.coordination.channelId;
    // Canonical IDs use UUIDv7. Use the installed implementation itself.
    const { generateCoordinationId } = await import(pathToFileURL(join(homeRoot, 'app/dist/coordination/ids/index.js')));
    await request(`/api/v1/channels/${channelId}/messages`, { messageId: generateCoordinationId('message'),
      clientMessageId: randomUUID(), text: 'Confirm this home can answer through the installed resident.',
      attachmentIds: [], mentions: [], replyToMessageId: null }, paired.accessToken);
    let messages = [];
    const until = Date.now() + 90_000;
    do {
      messages = (await request(`/api/v1/channels/${channelId}/messages`, null, paired.accessToken)).messages;
      if (messages.some(message => message.kind === 'result' && message.text === answer)) break;
      await new Promise(accept => setTimeout(accept, 500));
    } while (Date.now() < until);
    assert.ok(messages.some(message => message.kind === 'result' && message.text === answer), 'Installed resident must persist its model answer');
    assert.ok(calls > 0);
    record('pair-and-answer', { home: bootstrap.home, answer, modelCalls: calls, embeddingCalls });
    record('stop', await command('stop')); started = false;
    record('stopped-status', await command('status'));
    started = true;
    await startAndWait('restart');
    const after = await request('/api/v1/bootstrap', null, paired.accessToken);
    assert.deepEqual(after.home, bootstrap.home);
    assert.equal(JSON.parse(readFileSync(birthPath, 'utf8')).seedId, birth.seedId);
    assert.ok((await request(`/api/v1/channels/${channelId}/messages`, null, paired.accessToken)).messages.some(message => message.text === answer));
    record('persistent-home', { homeId: after.home.id, seedId: birth.seedId, conversationPreserved: true, pairingPreserved: true });
  } catch (error) {
    failure = error;
    record('failed', { error: error.message, recoveryHome: homeRoot });
    throw error;
  } finally {
    try {
      if (started) {
        try { record('final-stop', await command('stop')); }
        catch (error) {
          record('stop-failed', { error: error.message, recoveryHome: homeRoot });
          if (!failure) throw error;
        }
      }
    } finally {
      model.closeAllConnections();
      await new Promise(accept => model.close(accept));
    }
  }
  record('complete', { status: 'passed', installedHomeRetained: true, running: false });
  return { ok: true, outputPath, homeRoot, model: 'local fixture', running: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [payloadPath, outputPath, option] = process.argv.slice(2);
  if (!payloadPath || !outputPath || (option && option !== '--resume-install')) throw new Error('Usage: verify-install.mjs PAYLOAD NEW_OUTPUT_DIRECTORY [--resume-install]');
  try { console.log(JSON.stringify(await verifyInstalledHome({ payloadPath, outputPath, resumeInstall: option === '--resume-install' }), null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
