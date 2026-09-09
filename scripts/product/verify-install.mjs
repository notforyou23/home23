#!/usr/bin/env node
/** Full installed-runtime proof. All home data is created under a new output
 * directory. Model/embedding replies are local fixtures, never owner accounts.
 * This is deliberately separate from unit tests: it launches the shipped stack.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function verifyInstalledHome({ payloadPath, outputPath }) {
  payloadPath = resolve(payloadPath); outputPath = resolve(outputPath);
  mkdirSync(outputPath, { recursive: false, mode: 0o700 }); // never reuse somebody else's home
  const homeRoot = join(outputPath, 'Home');
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
      response.end(JSON.stringify({ model: body.model, done: true,
        message: { role: 'assistant', content: answer }, response: answer,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: answer } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 }, prompt_eval_count: 10, eval_count: 10,
      }));
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
      const deadline = setTimeout(() => child.kill('SIGTERM'), 300_000);
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) child.kill('SIGTERM'); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-100_000); });
      child.once('error', error => { clearTimeout(deadline); reject(error); });
      child.once('close', code => {
        clearTimeout(deadline);
        writeFileSync(join(outputPath, `${receipts.length}-${action}.log`), stderr, { mode: 0o600 });
        let value;
        try { value = JSON.parse(stdout.trim()); } catch { reject(new Error(`${action} returned invalid JSON (exit ${code}); see its log`)); return; }
        if (code !== 0 || value.ok === false) reject(new Error(`${action}: ${value.error?.message || value.error || value.message || `exit ${code}`}`));
        else accept(value);
      });
      child.stdin.end(input ? JSON.stringify(input) : '');
    });
    return result;
  };
  try {
    record('install', await command('install')); installed = true;
    const profile = { name: 'milo', displayName: 'Milo', ownerName: 'Product fixture',
      homeName: 'Independent product fixture', purpose: 'Exercise a newly installed home.',
      provider: 'ollama-local', model: 'qwen2.5:7b', timezone: 'UTC' };
    record('create', await command('create', { profile, credential: { provider: 'ollama-local', baseUrl: modelURL } }));
    // Keep every optional embedding path inside this fixture as well. This is
    // test configuration in our new installation, never the user's home.
    const require = createRequire(join(homeRoot, 'app/package.json'));
    const yaml = require('js-yaml');
    const configPath = join(homeRoot, 'app/config/home.yaml');
    const config = yaml.load(readFileSync(configPath, 'utf8'));
    config.providers['ollama-local'].baseUrl = modelURL;
    config.embeddings = { providers: [{ provider: 'ollama-local', model: 'nomic-embed-text', dimensions: 768, endpoint: `${modelURL}/api/embeddings` }] };
    config.substrate = { ...config.substrate, embedding: { endpoint: `${modelURL}/api/embeddings`, model: 'nomic-embed-text' } };
    writeFileSync(configPath, yaml.dump(config), { mode: 0o600 });
    const birthPath = join(homeRoot, 'app/instances/milo/substrate/seed-01/birth-receipt.json');
    const birth = JSON.parse(readFileSync(birthPath, 'utf8'));
    started = true; // also stop a partially admitted start
    const live = await command('start');
    assert.equal(live.status, 'ready');
    record('start', live);
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
    record('restart', await command('start'));
    const after = await request('/api/v1/bootstrap', null, paired.accessToken);
    assert.deepEqual(after.home, bootstrap.home);
    assert.equal(JSON.parse(readFileSync(birthPath, 'utf8')).seedId, birth.seedId);
    assert.ok((await request(`/api/v1/channels/${channelId}/messages`, null, paired.accessToken)).messages.some(message => message.text === answer));
    record('persistent-home', { homeId: after.home.id, seedId: birth.seedId, conversationPreserved: true, pairingPreserved: true });
  } finally {
    if (started) {
      try { record('final-stop', await command('stop')); }
      catch (error) { record('stop-failed', { error: error.message, recoveryHome: homeRoot }); throw error; }
    }
    model.closeAllConnections();
    await new Promise(accept => model.close(accept));
  }
  record('complete', { status: 'passed', installedHomeRetained: true, running: false });
  return { ok: true, outputPath, homeRoot, model: 'local fixture', running: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [payloadPath, outputPath] = process.argv.slice(2);
  if (!payloadPath || !outputPath) throw new Error('Usage: verify-install.mjs PAYLOAD NEW_OUTPUT_DIRECTORY');
  try { console.log(JSON.stringify(await verifyInstalledHome({ payloadPath, outputPath }), null, 2)); }
  catch (error) { console.error(error.stack); process.exitCode = 1; }
}
