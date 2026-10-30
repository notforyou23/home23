import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { judgePm2, localProbeRoster, probeLocalHome, readPm2Apps } from '../bin/organ-probes.js';

const require = createRequire(import.meta.url);
const { generateEcosystem } = require('../../cli/lib/generate-ecosystem.js');
const { productDefinitions, ownedProcessNames } = require('../../cli/lib/product-host.js');
const { productEnvironment, productRoleEnvironment } = require('../../cli/lib/product-environment.js');

function hostState(home: string, continuationServices: unknown[] = []) {
  const instance = join(home, 'app/instances/milo');
  mkdirSync(instance, { recursive: true });
  if (!existsSync(join(instance, 'config.yaml'))) writeFileSync(join(instance, 'config.yaml'), JSON.stringify({ substrate: { enabled: true } }));
  const state = { schema: 'home23.host.v2', homeRoot: home, profile: { name: 'milo' }, encoderRequired: false,
    ports: { coordination: 24010, engine: 24011, dashboard: 24012, mcp: 24013, bridge: 24014, evobrew: 24015, observatory: 24016 },
    continuationServices };
  writeFileSync(join(home, '.home23-host.json'), JSON.stringify(state), { mode: 0o600 });
  return state;
}

function definition(home: string, name: string, env: Record<string, string> = {}, script = 'engine/src/index.js') {
  const root = join(home, 'app');
  return { name, script: relative(root, join(home, 'bin/node')), cwd: root, args: [join(root, script)],
    min_uptime: 100, env: productRoleEnvironment(home, env) };
}

function observed(app: ReturnType<typeof definition>, pid = 100) {
  return { name: app.name, pid, pm2_env: { ...app.env, status: 'online', pm_exec_path: resolve(app.cwd, app.script),
    pm_cwd: app.cwd, args: app.args, min_uptime: app.min_uptime } };
}

test('product substrate polling reaches its installed supervisor without creating a user PM2 home', t => {
  const root = mkdtempSync(join(tmpdir(), 'home23-product-organ-client-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'app'), marker = join(root, 'plain-pm2-called');
  mkdirSync(join(app, 'cli/lib'), { recursive: true });
  writeFileSync(join(app, 'package.json'), '{"type":"module"}');
  writeFileSync(join(app, 'cli/lib/product-supervisor.js'), `
    export async function productSupervisorCommand(home, args) {
      if (home !== ${JSON.stringify(root)} || args[0] !== 'jlist') throw new Error('wrong route');
      return { stdout: JSON.stringify([{ name: 'home23-milo', pm2_env: { status: 'online' } }]) };
    }
  `);
  writeFileSync(join(root, 'pm2'), `#!/bin/sh\n: > '${marker}'\nexit 88\n`, { mode: 0o755 });
  const keys = ['HOME23_PRODUCT_HOST', 'HOME23_ROOT', 'HOME', 'PATH', 'PM2_HOME'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  Object.assign(process.env, { HOME23_PRODUCT_HOST: 'true', HOME23_ROOT: app, HOME: join(root, 'runtime/user'), PATH: root });
  delete process.env.PM2_HOME;
  assert.deepEqual(readPm2Apps(), [{ name: 'home23-milo', pm2_env: { status: 'online' } }]);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(join(root, 'runtime/user/.pm2')), false);
});

test('installed probes follow only the declared local resident and report real chain/PM2 failures', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-probe-')));
  const root = join(home, 'app');
  try {
    mkdirSync(join(home, 'runtime'));
    hostState(home);
    const stateDir = join(root, 'instances', 'milo', 'substrate', 'seed-01');
    const conversations = join(root, 'instances', 'milo', 'conversations');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(conversations, { recursive: true });
    writeFileSync(join(stateDir, 'seed-ledger.jsonl'), JSON.stringify({ issuedAt: new Date().toISOString(), category: 'transition', payload: {} }) + '\n');
    const apps = [
      definition(home, 'home23-milo', { HOME23_AGENT: 'milo', HOME23_CONVERSATIONS_DIR: conversations }),
      definition(home, 'home23-milo-seed', { HOME23_AGENT: 'milo', SEED_STATE_DIR: stateDir, SEED_LOBE: '' }, 'substrate/bin/seed-runner.ts'),
      definition(home, 'home23-milo-shipper', { SHIPPER_CONVERSATIONS_DIR: conversations, SHIPPER_STREAM_PATH: join(stateDir, '..', 'conversation-stream.jsonl') }, 'substrate/bin/conversation-shipper.ts'),
    ];
    writeFileSync(join(home, 'runtime', 'ecosystem.config.json'), JSON.stringify({ apps }), { mode: 0o600 });
    writeFileSync(join(root, 'ecosystem.config.cjs'), 'throw new Error("the general generator inventory is not the submitted Host plan");\n');
    const roster = localProbeRoster(root);
    assert.deepEqual(roster.engines, ['home23-milo']);
    assert.deepEqual(roster.seeds, [{ name: 'milo-seed', stateDir, agent: 'milo', hasLobe: false }]);
    assert.equal(roster.feeds[0]?.agent, 'milo');
    let reads = 0;
    const results = probeLocalHome(root, () => {
      reads++;
      return [{ name: 'home23-milo', pm2_env: { status: 'online' } }];
    });
    assert.equal(reads, 1, 'one private PM2 read, with no SSH or ambient inventory fallback');
    assert.ok(results.find(result => result.organ === 'milo-seed-chain')?.ok);
    assert.equal(results.find(result => result.organ === 'pm2:milo-seed')?.ok, false);
    assert.equal(results.some(result => /jerry|forrest|bobby|pi|retired|seed-thought/.test(result.organ)), false);
    rmSync(join(stateDir, 'seed-ledger.jsonl'));
    assert.equal(probeLocalHome(root, () => []).find(result => result.organ === 'milo-seed-chain')?.ok, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('unreadable installed inventory reports the failure without falling back to developer home or PM2', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-probe-missing-')));
  const root = join(home, 'app');
  try {
    mkdirSync(root);
    writeFileSync(join(root, 'ecosystem.config.cjs'), 'throw new Error("must not fall back to the general generated inventory");\n');
    const result = probeLocalHome(root, () => { throw new Error('must not inspect an unrelated daemon'); });
    assert.equal(result[0]?.organ, 'inventory');
    assert.equal(result[0]?.ok, false);
    mkdirSync(join(home, 'runtime'));
    hostState(home);
    for (const invalid of [{}, { apps: [] }, { apps: [{ name: 'unknown' }] }]) {
      writeFileSync(join(home, 'runtime', 'ecosystem.config.json'), JSON.stringify(invalid), { mode: 0o600 });
      assert.match(probeLocalHome(root)[0]?.why ?? '', /no valid submitted process plan/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('generated Host monitoring includes configured MCP and substrate services but excludes optional Chrome', () => {
  // macOS temporary paths may begin with /var, a symlink to /private/var.
  // The product correctly rejects symlinked home ancestors; use a real fixture.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-generated-probe-')));
  const root = join(home, 'app');
  try {
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'instances', 'milo'), { recursive: true });
    mkdirSync(join(home, 'runtime'));
    hostState(home);
    writeFileSync(join(root, 'config', 'home.yaml'), JSON.stringify({ home: { primaryAgent: 'milo' }, substrate: { observatory: {} } }));
    writeFileSync(join(root, 'instances', 'milo', 'config.yaml'), JSON.stringify({ agent: { displayName: 'Milo' }, ports: { engine: 24001, dashboard: 24002, mcp: 24003, bridge: 24004 }, substrate: { enabled: true } }));
    const generated = generateEcosystem(root, { quiet: true });
    const module = { exports: {} as { apps: Array<{ name: string }> } };
    runInNewContext(generated.ecosystemSource, { require, module, process: { env: productEnvironment(home) } });
    const generalNames = module.exports.apps.map(app => app.name);
    assert.ok(generalNames.includes('home23-chrome-cdp'));
    assert.ok(generalNames.includes('home23-milo-mcp'));
    const submitted = productDefinitions(module.exports.apps, home, 'milo');
    writeFileSync(join(home, 'runtime', 'ecosystem.config.json'), JSON.stringify({ apps: submitted }), { mode: 0o600 });
    const roster = localProbeRoster(root);
    assert.deepEqual(roster.expected, ownedProcessNames('milo', { home23Root: home }));
    assert.equal(roster.expected.includes('home23-chrome-cdp'), false);
    for (const required of ['home23-milo-mcp', 'home23-milo-seed', 'home23-milo-shipper', 'home23-seed-observatory']) {
      assert.ok(roster.expected.includes(required), `${required} is configured and owned by this Host`);
    }
    assert.equal(roster.feeds[0]?.agent, 'milo');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('installed roster includes a declared continuation and probes its exact binding without a name-prefix exception', t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-continuing-probe-'))), root = join(home, 'app');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'runtime'), { recursive: true }); mkdirSync(root);
  const service = { name: 'music-desk', executable: join(home, 'bin/node'), cwd: join(home, 'continuing/music'),
    args: [join(home, 'continuing/music/server.js')], env: { APP_FLAVOR: 'desk' }, stateRoots: [join(home, 'continuing/music')], startOnHomeStart: true };
  hostState(home, [service]);
  const continuation = { name: service.name, script: relative(service.cwd, service.executable), cwd: service.cwd,
    args: service.args, min_uptime: 100, env: productRoleEnvironment(home, service.env) };
  const apps = [definition(home, 'home23-milo', { HOME23_AGENT: 'milo' }), continuation];
  writeFileSync(join(home, 'runtime/ecosystem.config.json'), JSON.stringify({ apps }), { mode: 0o600 });
  const roster = localProbeRoster(root);
  assert.deepEqual(roster.expected, ['home23-milo', 'music-desk']);
  const result = probeLocalHome(root, () => apps.map(app => observed(app)));
  assert.equal(result.find(row => row.organ === 'pm2:music-desk')?.ok, true, 'a correctly owned continuation is monitored');
  assert.equal(result.some(row => row.organ === 'inventory'), false, 'valid continuation must not disable every function probe');
  assert.equal(probeLocalHome(root, () => [observed(apps[0]!)]).find(row => row.organ === 'pm2:music-desk')?.ok, false);
  for (const change of [
    { pm_exec_path: '/another/node' }, { pm_cwd: '/another/home' }, { args: ['/another/script.js'] }, { APP_FLAVOR: 'another' },
  ]) {
    const rows = apps.map(app => observed(app)); Object.assign(rows[1]!.pm2_env, change);
    assert.equal(probeLocalHome(root, () => rows).find(row => row.organ === 'pm2:music-desk')?.ok, false, JSON.stringify(change));
  }
});

test('installed plan refuses undeclared, duplicate and unowned bindings before reading the supervisor', t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-invalid-binding-probe-'))), root = join(home, 'app');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'runtime'), { recursive: true }); mkdirSync(root);
  hostState(home);
  const app = definition(home, 'home23-milo', { HOME23_AGENT: 'milo' });
  const plans = [
    [app, { ...app, name: 'music-desk' }],
    [app, { ...app }],
    [{ ...app, script: '/another/node' }],
    [{ ...app, cwd: '/another/home' }],
    [{ ...app, args: ['/another/script.js'] }],
    [{ ...app, name: 'home23-not-declared' }],
  ];
  for (const apps of plans) {
    writeFileSync(join(home, 'runtime/ecosystem.config.json'), JSON.stringify({ apps }), { mode: 0o600 });
    let supervisorReads = 0;
    const result = probeLocalHome(root, () => { supervisorReads++; return []; });
    assert.equal(result[0]?.organ, 'inventory', JSON.stringify(apps));
    assert.equal(result[0]?.ok, false);
    assert.equal(supervisorReads, 0, 'invalid inventory cannot inspect PM2');
  }
});

test('installed process judgment cannot turn online names into ownership evidence', t => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-observed-binding-probe-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'app'));
  const app = definition(home, 'home23-milo', { HOME23_AGENT: 'milo' });
  const names = [app.name];
  assert.equal(judgePm2([observed(app)], names, [app])[0]?.ok, true);
  for (const change of [{ pm_exec_path: '/another/node' }, { pm_cwd: '/another/home' }, { args: [] }, { HOME23_AGENT: 'other' }]) {
    const row = observed(app); Object.assign(row.pm2_env, change);
    assert.equal(judgePm2([row], names, [app])[0]?.ok, false, JSON.stringify(change));
  }
  assert.equal(judgePm2([{ ...observed(app), owned: false }], names, [app])[0]?.ok, false);
  assert.equal(judgePm2([observed(app), observed(app, 101)], names, [app])[0]?.ok, false, 'duplicate names are ambiguous');
});
