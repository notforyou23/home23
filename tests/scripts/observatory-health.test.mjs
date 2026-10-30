import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { productRoleEnvironment } from '../../cli/lib/product-environment.js';
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
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'observatory-host-')));
  const root = join(directory, 'app');
  const commands = join(directory, 'commands.log');
  const stateDir = join(root, 'instances', 'milo', 'substrate', 'seed-01');
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(directory, 'runtime'));
  mkdirSync(join(root, 'cli/lib'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'instances/milo/config.yaml'), 'substrate:\n  enabled: true\n');
  writeFileSync(join(directory, '.home23-host.json'), JSON.stringify({ schema: 'home23.host.v2', homeRoot: directory, profile: { name: 'milo' }, encoderRequired: false,
    ports: { coordination: 24010, engine: 24011, dashboard: 24012, mcp: 24013, bridge: 24014, evobrew: 24015, observatory: 24016 }, continuationServices: [] }), { mode: 0o600 });
  const definition = (name, env, script = 'engine/src/index.js') => ({ name, script: relative(root, join(directory, 'bin/node')), cwd: root, args: [join(root, script)], min_uptime: 100, env: productRoleEnvironment(directory, env) });
  const apps = [
    definition('home23-milo', { HOME23_AGENT: 'milo' }),
    definition('home23-milo-seed', { HOME23_AGENT: 'milo', SEED_STATE_DIR: stateDir }, 'substrate/bin/seed-runner.ts'),
    definition('home23-milo-shipper', { SHIPPER_STREAM_PATH: join(stateDir, '..', 'conversation-stream.jsonl') }, 'substrate/bin/conversation-shipper.ts'),
  ];
  writeFileSync(join(directory, 'runtime', 'ecosystem.config.json'), JSON.stringify({ apps }), { mode: 0o600 });
  const observed = apps.map(app => ({ name: app.name, pid: 100, pm2_env: { ...app.env, status: 'online', min_uptime: app.min_uptime, pm_exec_path: resolve(app.cwd, app.script), pm_cwd: app.cwd, args: app.args } }));
  writeFileSync(join(root, 'cli/lib/product-supervisor.js'), `import { appendFileSync } from 'node:fs';
    export async function productSupervisorCommand(home, args) {
      if (home !== ${JSON.stringify(directory)} || JSON.stringify(args) !== '["jlist"]') throw new Error('Unexpected supervisor control request');
      appendFileSync(${JSON.stringify(commands)}, 'jlist\\n');
      return { stdout: ${JSON.stringify(JSON.stringify(observed))} };
    }`);
  // Any accidental ambient PM2 or SSH path is recorded, and must fail the test.
  for (const command of ['pm2', 'ssh']) writeFileSync(join(directory, command), `#!/bin/sh\nprintf '%s\\n' ${command} >> '${commands}'\nexit 88\n`, { mode: 0o700 });
  const child = spawn(process.execPath, ['--import', 'tsx', 'substrate/bin/seed-observatory.ts'], {
    cwd: new URL('../../', import.meta.url),
    env: { PATH: `${directory}:/usr/bin:/bin`, HOME23_PRODUCT_HOST: 'true', HOME23_ROOT: root,
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
    assert.equal(readFileSync(commands, 'utf8'), 'jlist\n');
    const html = await (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })).text();
    assert.match(html, /milo-shipper/);
    assert.doesNotMatch(html, /jerry convo|forrest convo|bobby mirror/);
    assert.doesNotMatch(readFileSync(commands, 'utf8'), /ssh|pm2/);
    assert.doesNotMatch(html, /RUNTIME BINDING DIFFERS|pm2 unreadable/);
  } finally {
    clearTimeout(timer);
    child.kill('SIGKILL');
    await exited;
    rmSync(directory, { recursive: true, force: true });
  }
});
