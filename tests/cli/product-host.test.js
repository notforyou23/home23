import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { choosePortPlan, privateJSON, productEnvironment, providerEndpoint, socketRootFor, withReservedPorts } from '../../cli/lib/product-environment.js';
import { ownedProcessNames, probeReadiness, productDefinitions, runHostAction, safeProcesses } from '../../cli/lib/product-host.js';
import { writeProductManifest, installProductPayload } from '../../cli/lib/product-payload.js';

function home(t, { birth = false } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-unit-')));
  const payload = path.join(base, 'payload'), homeRoot = path.join(base, 'home');
  t.after(() => { fs.rmSync(base, { force: true, recursive: true }); fs.rmSync(socketRootFor(homeRoot), { force: true, recursive: true }); });
  for (const [file, content] of Object.entries({ 'bin/node': 'node', 'app/cli/home23.js': '', 'app/cli/lib/product-payload.js': '', 'app/scripts/product/host.mjs': '', 'tools/node_modules/pm2/bin/pm2': '' })) {
    fs.mkdirSync(path.dirname(path.join(payload, file)), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(payload, file), content, { mode: file === 'bin/node' ? 0o755 : 0o644 });
  }
  if (birth) {
    fs.mkdirSync(path.join(payload, 'app/config'), { recursive: true, mode: 0o755 });
    for (const file of ['home.yaml', 'targets.yaml', 'cron-jobs.json']) fs.copyFileSync(new URL(`../../config/${file}.example`, import.meta.url), path.join(payload, 'app/config', `${file}.example`));
    fs.cpSync(new URL('../../cli/templates', import.meta.url), path.join(payload, 'app/cli/templates'), { recursive: true });
  }
  writeProductManifest(payload, { sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.2' });
  installProductPayload({ payloadPath: payload, homeRoot });
  return homeRoot;
}
async function prepared(t) {
  const homeRoot = home(t), ports = await choosePortPlan();
  const state = { schema: 'home23.host.v1', homeRoot, ports, profile: { name: 'milo', provider: 'ollama-local', model: 'fixture' }, phase: 'prepared', desiredRunning: false, birth: { home: { id: 'home-fixture' }, coordination: { botId: 'bot-fixture' } } };
  privateJSON(path.join(homeRoot, '.home23-host.json'), state);
  return { homeRoot, state };
}
function definitions(homeRoot) { return ownedProcessNames('milo').map(name => ({ name, script: 'dist/home.js', cwd: path.join(homeRoot, 'app'), env: {}, node_args: '--expose-gc', args: [] })); }
function row(homeRoot, name, status = 'online') { return { name, pid: 123, pm2_env: { status, pm_cwd: path.join(homeRoot, 'app'), pm_exec_path: path.join(homeRoot, 'bin/node'), args: [path.join(homeRoot, 'app/dist/home.js')] } }; }

test('environment removes host credentials and PM2 metadata and uses short private sockets', t => {
  const homeRoot = home(t);
  const env = productEnvironment(homeRoot, { prepare: true });
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.pm_id, undefined);
  assert.equal(env.PM2_HOME, path.join(homeRoot, 'runtime/pm2'));
  assert.notEqual(env.HOME, os.homedir());
  assert.ok(env.PM2_DAEMON_RPC_PORT.length < 100);
  assert.equal(fs.statSync(env.TMPDIR).mode & 0o777, 0o700);
  fs.rmSync(env.TMPDIR, { recursive: true }); fs.symlinkSync(homeRoot, env.TMPDIR);
  assert.throws(() => productEnvironment(homeRoot, { prepare: true }), /private/);
  fs.unlinkSync(env.TMPDIR);
});

test('complete persisted port plans refuse occupied ports and do not use historical defaults', async () => {
  const plan = await choosePortPlan();
  assert.equal(new Set(Object.values(plan)).size, 7);
  assert.ok(Object.values(plan).every(port => port >= 20000));
  await withReservedPorts(plan, async () => assert.rejects(withReservedPorts(plan, async () => {}), { code: 'EADDRINUSE' }));
  await withReservedPorts(plan, async () => {});
});

test('model endpoint excludes credentials and unsupported transports', () => {
  assert.equal(providerEndpoint('http://127.0.0.1:45000/'), 'http://127.0.0.1:45000');
  assert.throws(() => providerEndpoint('https://owner:key@example.com'), /credentials/);
  assert.throws(() => providerEndpoint('file:///tmp/model'), /HTTP/);
});

test('definitions pin absolute bundled Node, keep only owned services, and retain bounded recovery', t => {
  const homeRoot = home(t);
  const result = productDefinitions([...definitions(homeRoot), { name: 'home23-screenlogic' }], homeRoot, 'milo');
  assert.equal(result.length, 8);
  assert.ok(result.every(app => app.interpreter === 'none' && app.script === path.join(homeRoot, 'bin/node') && app.autorestart && app.max_restarts === 5));
  assert.ok(result.every(app => app.args.includes(path.join(homeRoot, 'app/dist/home.js'))));
  const rows = safeProcesses([row(homeRoot, 'home23-milo'), row('/some/other/home', 'home23-milo-dash')], homeRoot, ownedProcessNames('milo'));
  assert.equal(rows[0].owned, true); assert.equal(rows[1].owned, false);
  assert.throws(() => productDefinitions([{ ...definitions(homeRoot)[0], script: '/usr/bin/env' }], homeRoot, 'milo'), /escapes/);
});

test('an online supervisor without signed resident availability cannot report ready', async t => {
  const { homeRoot, state } = await prepared(t);
  productEnvironment(homeRoot, { prepare: true });
  privateJSON(path.join(homeRoot, 'runtime/host-session.json'), { accessToken: 'fixture', refreshToken: 'fixture', accessExpiresAt: new Date(Date.now() + 3600000).toISOString() });
  const processes = safeProcesses(ownedProcessNames('milo').map(name => row(homeRoot, name)), homeRoot, ownedProcessNames('milo'));
  let availability = 'offline';
  const request = async url => url.endsWith('/capabilities') ? { pairingAvailable: true, capabilities: { bootstrap: true, messageSubmission: true } }
    : url.endsWith('/bootstrap') ? { home: { id: 'home-fixture' }, snapshot: { bots: [{ id: 'bot-fixture', availability, conversationId: 'conversation-fixture' }] } }
    : url.endsWith('/process.json') ? { pid: 123 } : { ok: true };
  assert.equal((await probeReadiness(homeRoot, state, processes, { request })).ready, false);
  availability = 'available';
  assert.equal((await probeReadiness(homeRoot, state, processes, { request })).ready, true);
  availability = 'busy';
  assert.equal((await probeReadiness(homeRoot, state, processes, { request })).ready, true);
});

test('explicit stop is exact, durable, preserves data, and unexpected processes are untouched', async t => {
  const { homeRoot, state } = await prepared(t);
  const rows = ownedProcessNames('milo').map(name => row(homeRoot, name));
  const calls = [];
  const execute = async (_node, args) => {
    calls.push(args.slice(1));
    if (args[1] === 'jlist') return { stdout: JSON.stringify(rows) };
    if (args[1] === 'stop') rows.find(row => row.name === args[2]).pm2_env.status = 'stopped';
    return { stdout: '' };
  };
  const result = await runHostAction('stop', { homeRoot }, { execute });
  assert.equal(result.status, 'stopped'); assert.equal(result.desiredRunning, false);
  assert.equal(calls.filter(args => args[0] === 'stop').length, 8);
  assert.ok(calls.every(args => !args.includes('all')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(homeRoot, '.home23-host.json'))).birth.home.id, state.birth.home.id);
  rows.push(row(homeRoot, 'someone-else'));
  await assert.rejects(runHostAction('stop', { homeRoot }, { execute }), /unexpected/);
  assert.equal(calls.filter(args => args[0] === 'stop').length, 8);
});

test('start persists intent and returns starting until readiness succeeds', async t => {
  const { homeRoot } = await prepared(t), rows = [], calls = [];
  const execute = async (_node, args) => {
    calls.push(args.slice(1));
    if (args[1] === 'jlist') return { stdout: JSON.stringify(rows) };
    if (args[1] === 'start') rows.push(row(homeRoot, args[args.indexOf('--only') + 1]));
    return { stdout: '' };
  };
  const result = await runHostAction('start', { homeRoot }, { execute, definitions: () => productDefinitions(definitions(homeRoot), homeRoot, 'milo'), readinessWaitMs: 0, probeReadiness: async () => ({ ready: false, issues: ['waiting for signed resident'] }) });
  assert.equal(result.status, 'starting'); assert.equal(result.desiredRunning, true);
  assert.equal(calls.filter(args => args[0] === 'start').length, 8);
});

test('fake or redirected installation receipts are refused before process control', async t => {
  const homeRoot = home(t);
  const receipt = JSON.parse(fs.readFileSync(path.join(homeRoot, '.home23-install.json')));
  privateJSON(path.join(homeRoot, '.home23-install.json'), { ...receipt, appRoot: '/elsewhere' });
  await assert.rejects(runHostAction('status', { homeRoot }), /receipt/);
});

test('native protocol catalog returns actual provider models and never loads parent credentials', t => {
  const homeRoot = path.join(home(t), 'never-created');
  const result = JSON.parse(execFileSync(process.execPath, ['scripts/product/host.mjs', 'catalog', '--home', homeRoot], { cwd: path.resolve(import.meta.dirname, '../..'), env: { ...process.env, OPENAI_API_KEY: 'parent-secret-must-not-appear' }, encoding: 'utf8' }));
  assert.ok(result.providers.some(provider => provider.id === 'ollama-local' && provider.models.length));
  assert.ok(!result.providers.some(provider => provider.models.some(model => model.id === 'text-embedding-3-small')));
  assert.ok(!JSON.stringify(result).includes('parent-secret')); assert.equal(fs.existsSync(homeRoot), false);
});

async function authFixture(t) {
  const { homeRoot, state } = await prepared(t);
  productEnvironment(homeRoot, { prepare: true });
  const { tsImport } = await import('tsx/esm/api');
  const { TestAuthRepository } = await tsImport('../coordination/auth/test-repository.ts', import.meta.url);
  const { createAuthService } = await import('../../dist/coordination/auth/index.js');
  const { generateCoordinationId } = await import('../../dist/coordination/ids/index.js');
  const repository = new TestAuthRepository();
  let at = new Date();
  const mutation = key => ({ idempotencyKey: key.length < 16 ? `host-fixture-${key}` : key, requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation') });
  const service = createAuthService({ repository, keyMaterial: Buffer.alloc(32, 0x72), now: () => at,
    admissionVerifier: { verifyLocalOperator: () => ({ allowed: true, network: 'loopback', rateLimitKey: 'host-test-operator' }), verifyClient: () => ({ allowed: true, network: 'loopback', rateLimitKey: 'host-test-client' }) } });
  const calls = [];
  const loseNext = new Set();
  const request = async (url, options = {}) => {
    const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : {}, key = options.headers?.['idempotency-key'];
    calls.push({ route, key, body });
    try {
      let result;
      if (route.endsWith('/capabilities')) result = { pairingAvailable: true, capabilities: { bootstrap: true, messageSubmission: true } };
      else if (route === '/api/v1/pairing/sessions') result = await service.issuePairing({ ...body, operator: {}, mutation: mutation(key) });
      else if (route.endsWith('/redeem')) result = await service.redeemPairing({ ...body, pairingSessionId: route.split('/').at(-2), network: 'loopback', mutation: mutation(key) });
      else if (route.endsWith('/refresh')) result = await service.refreshSession({ ...body, network: 'loopback', mutation: mutation(key) });
      else if (route.endsWith('/bootstrap')) {
        await service.validateAccessToken({ accessToken: options.headers.authorization.slice(7), network: 'loopback', requiredScopes: ['product:read'] });
        result = { home: { id: state.birth.home.id }, snapshot: { bots: [{ id: state.birth.coordination.botId, availability: 'available', conversationId: 'conversation-fixture' }] } };
      } else result = route.endsWith('/process.json') ? { pid: 123 } : { ok: true };
      const stage = route.endsWith('/redeem') ? 'redeem' : route.endsWith('/refresh') ? 'refresh' : route === '/api/v1/pairing/sessions' ? 'issue' : '';
      if (loseNext.delete(stage)) throw new Error('simulated response lost after server commit');
      return result;
    } catch (error) {
      if (error.reasonCode) { error.code = error.reasonCode; error.status = error.httpStatus; }
      throw error;
    }
  };
  const processes = safeProcesses(ownedProcessNames('milo').map(name => row(homeRoot, name)), homeRoot, ownedProcessNames('milo'));
  const sessionPath = path.join(homeRoot, 'runtime/host-session.json');
  const readSession = () => JSON.parse(fs.readFileSync(sessionPath));
  const probe = createSession => probeReadiness(homeRoot, state, processes, { createSession, request });
  const expireLocalAccess = () => privateJSON(sessionPath, { ...readSession(), accessExpiresAt: new Date(0).toISOString() });
  return { homeRoot, state, repository, service, calls, loseNext, probe, readSession, expireLocalAccess, mutation,
    advance: ms => { at = new Date(at.getTime() + ms); } };
}

test('refresh retries reuse the durable key and token after an actual server commit loses its response', async t => {
  const f = await authFixture(t);
  assert.equal((await f.probe(true)).ready, true);
  f.expireLocalAccess(); f.loseNext.add('refresh');
  assert.equal((await f.probe(false)).ready, false);
  const pending = f.readSession().pending;
  assert.equal(pending.kind, 'refresh');
  assert.equal((await f.probe(true)).ready, true);
  const refreshes = f.calls.filter(call => call.route.endsWith('/refresh'));
  assert.equal(refreshes.length, 2);
  assert.equal(refreshes[0].key, pending.idempotencyKey); assert.equal(refreshes[1].key, pending.idempotencyKey);
  assert.equal(refreshes[0].body.refreshToken, refreshes[1].body.refreshToken);
  assert.equal(f.readSession().pending, undefined);
  assert.equal(f.repository.devices.size, 1);
  assert.ok([...f.repository.refreshTokens.values()].every(token => token.state !== 'revoked'));
});

test('initial issue and redemption replay their saved keys after lost responses without duplicate devices', async t => {
  const f = await authFixture(t);
  f.loseNext.add('issue');
  assert.equal((await f.probe(true)).ready, false);
  const firstPending = f.readSession().pending;
  assert.equal((await f.probe(false)).recoveryRequired, true);
  assert.equal(f.repository.pairings.size, 1);
  f.loseNext.add('redeem');
  assert.equal((await f.probe(true)).ready, false);
  assert.equal(f.repository.devices.size, 1);
  assert.equal((await f.probe(true)).ready, true);
  const issues = f.calls.filter(call => call.route === '/api/v1/pairing/sessions');
  const redeems = f.calls.filter(call => call.route.endsWith('/redeem'));
  assert.equal(issues.length, 2); assert.ok(issues.every(call => call.key === firstPending.issueKey));
  assert.equal(redeems.length, 2); assert.ok(redeems.every(call => call.key === firstPending.redeemKey));
  assert.equal(f.repository.devices.size, 1);
});

test('expired or revoked Host sessions require explicit Start recovery and leave other devices intact', async t => {
  for (const failure of ['expired', 'revoked']) {
    await t.test(failure, async t => {
      const f = await authFixture(t);
      assert.equal((await f.probe(true)).ready, true);
      const otherPair = await f.service.issuePairing({ deviceName: 'Owner phone', operator: {}, mutation: f.mutation('other-issue') });
      const other = await f.service.redeemPairing({ pairingSessionId: otherPair.pairingSession.id, pairingCode: otherPair.pairingCode,
        device: { platform: 'ios', name: 'Owner phone', appBuild: '1' }, network: 'loopback', mutation: f.mutation('other-redeem') });
      if (failure === 'revoked') await f.service.revokeCurrentSession({ accessToken: f.readSession().accessToken, network: 'loopback', mutation: f.mutation('revoke-host') });
      else { f.advance(31 * 86400000); f.expireLocalAccess(); }
      const result = await f.probe(false);
      assert.equal(result.ready, false); assert.equal(result.recoveryRequired, true);
      assert.equal(f.repository.devices.size, 2);
      assert.equal((await f.probe(true)).ready, true);
      assert.equal(f.repository.devices.size, 3);
      assert.equal(f.repository.devices.get(other.device.id).status, 'active');
      assert.equal(f.readSession().recoveryRequired, undefined);
    });
  }
});

test('custom local Host model passes real canonical home creation and retains its model alias', async t => {
  const homeRoot = home(t, { birth: true });
  const result = await runHostAction('create', { homeRoot, input: { profile: { name: 'milo', ownerName: 'Alex', provider: 'ollama-local', model: 'family-local-model:custom', timezone: 'UTC' }, credential: { provider: 'ollama-local', baseUrl: 'http://127.0.0.1:45000/v1/' } } });
  assert.equal(result.status, 'prepared');
  const { default: yaml } = await import('js-yaml');
  const config = yaml.load(fs.readFileSync(path.join(homeRoot, 'app/config/home.yaml'), 'utf8'));
  assert.equal(config.providers['ollama-local'].baseUrl, 'http://127.0.0.1:45000');
  assert.deepEqual(config.models.aliases['host-resident'], { provider: 'ollama-local', model: 'family-local-model:custom' });
  assert.deepEqual(config.embeddings.providers, [{ provider: 'ollama-local', model: 'nomic-embed-text', dimensions: 768, endpoint: 'http://127.0.0.1:45000/api/embeddings' }]);
  assert.deepEqual(config.substrate.embedding, { endpoint: 'http://127.0.0.1:45000/api/embeddings', model: 'nomic-embed-text' });
  const resident = yaml.load(fs.readFileSync(path.join(homeRoot, 'app/instances/milo/config.yaml'), 'utf8'));
  assert.equal(resident.chat.defaultModel, 'family-local-model:custom');
  assert.ok(fs.existsSync(path.join(homeRoot, 'app/instances/milo/substrate/seed-01/birth-receipt.json')));
});
