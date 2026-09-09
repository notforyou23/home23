import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import vm from 'node:vm';
import { probe } from '../../scripts/lib/observatory-deadman.mjs';

const source = readFileSync(new URL('../../substrate/bin/seed-observatory.ts', import.meta.url), 'utf8');

test('the actual health route answers HTTP without any composition/probe dependencies', async () => {
  // Execute the production health branch with ONLY req/res in scope. Any
  // dependency access throws; all normal routes remain outside this fixture.
  const branch = source.match(/    if \(req.url === '\/healthz'\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(branch);
  const handle = vm.runInNewContext(`(req, res) => { ${branch} }`);
  const server = createServer(handle);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    assert.equal(await probe(`http://127.0.0.1:${server.address().port}/healthz`), true);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok\n');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally { await new Promise((done) => server.close(done)); }
});

test('real observatory serves health locally before any sentinel timer can run', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-health-'));
  // Abort before the production sentinel's first 5s tick: no PM2, remote
  // probes, live Seed state, or notification URL is used by this process.
  const child = spawn(process.execPath, ['--import', 'tsx', 'substrate/bin/seed-observatory.ts'], {
    cwd: new URL('../../', import.meta.url),
    env: { PATH: process.env.PATH, OBSERVATORY_PORT: '0',
      OBSERVATORY_INDIVIDUALS: JSON.stringify([{ name: 'fixture', stateDir: directory }]) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 4_000);
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', (data) => {
        const match = String(data).match(/on :(\d+)/);
        if (match) resolve(Number(match[1]));
      });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`observatory exited before ready: ${stderr}`)));
    });
    assert.notEqual(port, 0);
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'ok\n');
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});


test('deadman rejects an error, wrong success body, redirect, and closed listener', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/error') res.writeHead(503).end('ok\n');
    else if (req.url === '/redirect') res.writeHead(302, { location: '/healthz' }).end();
    else res.end('expensive dashboard html');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ['/error', '/redirect', '/wrong']) assert.equal(await probe(base + path), false);
  } finally { await new Promise((done) => server.close(done)); }
  assert.equal(await probe(base + '/healthz'), false);
});

test('Host observatory runs its actual sentinel without probing another home or SSH', { timeout: 12_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'observatory-host-'));
  const commands = join(directory, 'commands.log');
  const stateDir = join(directory, 'instances', 'milo', 'substrate', 'seed-01');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(directory, 'pm2'), '#!/bin/sh\nprintf "%s\\n" pm2 >> "$PROBE_COMMAND_LOG"\nprintf "%s\\n" "[]"\n', { mode: 0o700 });
  writeFileSync(join(directory, 'ssh'), '#!/bin/sh\nprintf "%s\\n" ssh >> "$PROBE_COMMAND_LOG"\nexit 1\n', { mode: 0o700 });
  writeFileSync(join(directory, 'ecosystem.config.cjs'), `module.exports = ${JSON.stringify({ apps: [
    { name: 'home23-milo', env: { HOME23_AGENT: 'milo' } },
    { name: 'home23-milo-seed', env: { HOME23_AGENT: 'milo', SEED_STATE_DIR: stateDir } },
    { name: 'home23-milo-shipper', env: { SHIPPER_STREAM_PATH: join(stateDir, '..', 'conversation-stream.jsonl') } },
  ] })};\n`);
  const child = spawn(process.execPath, ['--import', 'tsx', 'substrate/bin/seed-observatory.ts'], {
    cwd: new URL('../../', import.meta.url),
    env: { PATH: `${directory}:/usr/bin:/bin`, HOME23_PRODUCT_HOST: 'true', HOME23_ROOT: directory,
      PROBE_COMMAND_LOG: commands, OBSERVATORY_PORT: '0',
      OBSERVATORY_INDIVIDUALS: JSON.stringify([{ name: 'milo-seed', stateDir }]) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  try {
    const port = await new Promise((resolve, reject) => {
      child.stdout.on('data', data => { const match = String(data).match(/on :(\d+)/); if (match) resolve(Number(match[1])); });
      child.once('error', reject);
      child.once('exit', () => reject(new Error(`observatory exited before ready: ${stderr}`)));
    });
    // Wait for the production five-second sentinel tick, not a test-only path.
    const deadline = Date.now() + 7_000;
    while (!existsSync(commands) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(readFileSync(commands, 'utf8'), 'pm2\n');
    const html = await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).text();
    assert.match(html, /milo-shipper/);
    assert.doesNotMatch(html, /jerry convo|forrest convo|bobby mirror/);
    assert.doesNotMatch(readFileSync(commands, 'utf8'), /ssh/);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
