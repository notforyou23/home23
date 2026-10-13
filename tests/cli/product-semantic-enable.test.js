import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import { runSemanticAction } from '../../cli/lib/product-semantic-enable.js';
import { readHostState, runHostAction } from '../../cli/lib/product-host.js';
import { execFileSync } from 'node:child_process';
import { OWNED_PROFILE_ID, OWNED_RECIPE_HASH } from '../../cli/lib/product-embedder.js';
import { privateJSON, readPrivateJSON, socketRootFor } from '../../cli/lib/product-environment.js';
import { isRebuildableStatePath } from '../../cli/lib/product-update-inventory.js';

function fixture(t, { sealed = false } = {}) {
  const homeRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-enable-unit-')));
  t.after(() => {
    fs.rmSync(homeRoot, { force: true, recursive: true });
    fs.rmSync(socketRootFor(homeRoot), { force: true, recursive: true });
  });
  for (const directory of ['runtime', 'app/config', 'app/instances/jerry', 'app/instances/forrest', 'app/scripts/embedder', 'bin']) {
    fs.mkdirSync(path.join(homeRoot, directory), { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(path.join(homeRoot, 'bin/node'), 'fixture executable\n', { mode: 0o700 });
  fs.writeFileSync(path.join(homeRoot, 'app/scripts/embedder/serve.mjs'), '// synthetic fixture\n', { mode: 0o600 });
  const ports = { coordination: 20000, engine: 20001, dashboard: 20002, mcp: 20003, bridge: 20004, evobrew: 20005, observatory: 20006 };
  const residents = {
    jerry: { engine: 20001, dashboard: 20002, mcp: 20003, bridge: 20004 },
    forrest: { engine: 20007, dashboard: 20008, mcp: 20009, bridge: 20010 },
  };
  const state = {
    schema: 'home23.host.v2', homeRoot, encoderRequired: false, ports,
    phase: 'stopped', desiredRunning: false,
    profile: { name: 'jerry', provider: 'ollama-local', model: 'fixture' },
    residentMap: Object.fromEntries(Object.entries(residents).map(([name, residentPorts]) => [name, { ports: residentPorts }])),
  };
  if (sealed) {
    state.networkBindings = { schema: 'home23.adoption-network-bindings.v1', shared: { ...ports }, residents, evidence: {} };
    privateJSON(path.join(homeRoot, 'runtime/adoption-preservation.json'), {
      schema: 'home23.adoption-preservation-receipt.v1', networkBindings: state.networkBindings,
      continuationServices: [], links: [],
    });
  }
  privateJSON(path.join(homeRoot, '.home23-host.json'), state);
  const homePath = path.join(homeRoot, 'app/config/home.yaml');
  fs.writeFileSync(homePath, '# Keep the adopted encoder until its copied brain is selected.\nhome:\n  primaryAgent: jerry\nembeddings:\n  providers:\n    - provider: ollama-local\n      model: nomic-embed-text\n      dimensions: 768\n      endpoint: http://127.0.0.1:11434/api/embeddings\narchitecture:\n  memory:\n    embedding:\n      provider: ollama\n      model: nomic-embed-text\n      dimensions: 768\n      baseUrl: http://127.0.0.1:11434/v1\n', { mode: 0o600 });
  fs.appendFileSync(homePath, 'substrate:\n  embedding:\n    endpoint: http://127.0.0.1:11434/api/embeddings\n    model: nomic-embed-text\n');
  const instancePaths = Object.entries(residents).map(([name, residentPorts]) => {
    const file = path.join(homeRoot, 'app/instances', name, 'config.yaml');
    fs.writeFileSync(file, yaml.dump({ name, ports: residentPorts, architecture: { memory: { embedding: {
      provider: 'ollama', model: 'nomic-embed-text', dimensions: 768, baseUrl: 'http://127.0.0.1:11434/v1',
    } } } }), { mode: 0o600 });
    return file;
  });
  return { homeRoot, state, homePath, instancePaths };
}

function installationReceipt(root) {
  const required = ['bin/node', 'app/cli/home23.js', 'app/cli/lib/product-payload.js', 'app/scripts/product/host.mjs', 'tools/node_modules/pm2/bin/pm2'];
  const parents = new Set();
  for (const file of required) for (let parent = path.posix.dirname(file); parent !== '.'; parent = path.posix.dirname(parent)) parents.add(parent);
  const body = { schema: 'home23.product-payload.v1', sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch,
    nodeVersion: 'v22.19.0', createdAt: new Date().toISOString(), files: [
      ...[...parents].map(path => ({ path, type: 'directory', mode: 0o755 })),
      ...required.map(path => ({ path, type: 'file', mode: path === 'bin/node' ? 0o755 : 0o644, size: 0,
        sha256: createHash('sha256').update('').digest('hex') })) ] };
  const packageId = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ ...body, packageId }));
  privateJSON(path.join(root, '.home23-install.json'), { schema: 'home23.product-install.v1', status: 'installed', homeRoot: root,
    appRoot: path.join(root, 'app'), packageId, nodePath: path.join(root, 'bin/node'), pm2Path: path.join(root, 'tools/node_modules/pm2/bin/pm2') });
}

test('Host dispatch supports semantic enable and disable with fake supervisor dependencies', async t => {
  const { homeRoot } = fixture(t, { sealed: true });
  installationReceipt(homeRoot);
  const { deps } = fakes(homeRoot);
  const planned = await runHostAction('semantic-enable', { homeRoot, input: { dryRun: true } }, deps);
  assert.equal(planned.status, 'planned');
  assert.equal((await runHostAction('semantic-enable', { homeRoot }, deps)).status, 'enabled');
  assert.equal((await runHostAction('semantic-disable', { homeRoot }, deps)).status, 'disabled');
});

test('host.mjs accepts semantic-disable dry-run without contacting a supervisor or changing the home', async t => {
  const { homeRoot } = fixture(t, { sealed: true });
  installationReceipt(homeRoot);
  await runSemanticAction('semantic-enable', { homeRoot }, fakes(homeRoot).deps);
  const before = treeSnapshot(homeRoot);
  const output = execFileSync(process.execPath, [path.resolve('scripts/product/host.mjs'), 'semantic-disable', '--home', homeRoot, '--dry-run'],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(JSON.parse(output).status, 'planned');
  assert.deepEqual(treeSnapshot(homeRoot), before);
});

test('host.mjs rejects dry-run on unrelated actions', t => {
  const { homeRoot } = fixture(t);
  assert.throws(() => execFileSync(process.execPath, [path.resolve('scripts/product/host.mjs'), 'stop', '--home', homeRoot, '--dry-run'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } }), error => {
      assert.match(error.stdout, /dry-run is only supported/); return error.status === 1;
    });
});

test('semantic-disable resumes a partial disable before permitting Host start', async t => {
  const { homeRoot } = fixture(t, { sealed: true });
  installationReceipt(homeRoot);
  const { deps } = fakes(homeRoot);
  await runSemanticAction('semantic-enable', { homeRoot }, deps);
  const journalFile = path.join(homeRoot, 'runtime/semantic-enable.json');
  const journal = readPrivateJSON(journalFile);
  journal.phase = 'disabling';
  privateJSON(journalFile, journal);
  const state = journal.files.find(file => file.path === '.home23-host.json');
  fs.writeFileSync(path.join(homeRoot, state.path), state.before, { mode: 0o600 });
  const refusal = await runHostAction('start', { homeRoot }, deps);
  assert.equal(refusal.error.code, 'host_semantic_rollback_required');
  assert.equal((await runSemanticAction('semantic-disable', { homeRoot }, deps)).status, 'disabled');
  assert.equal(readHostState(homeRoot).encoderRequired, false);
});

test('a supervisor command exit error produces a clear failure and restores original configuration', async t => {
  const { homeRoot, homePath } = fixture(t);
  const before = fileSnapshot(homePath), { deps } = fakes(homeRoot);
  const command = deps.supervisorCommand;
  deps.supervisorCommand = async (root, args) => {
    if (args[0] === 'start') throw Object.assign(new Error('untrusted subprocess details'), { code: 1 });
    return command(root, args);
  };
  await assert.rejects(runSemanticAction('semantic-enable', { homeRoot }, deps), error => {
    assert.equal(error.code, 'host_semantic_enable_failed');
    assert.match(error.message, /prior configuration was restored/);
    assert.doesNotMatch(error.message, /untrusted/); return true;
  });
  assertPreserved(homePath, before);
  assert.equal(readHostState(homeRoot).encoderRequired, false);
});

test('a warm response with a different recipe cannot enable the owned provider', async t => {
  const { homeRoot, homePath } = fixture(t);
  const before = fileSnapshot(homePath), { deps, rows } = fakes(homeRoot);
  deps.probe = async () => rows.some(row => row.pm2_env.status === 'online')
    ? { warm: true, recipeId: 'wrong-recipe', dimension: 768 } : { warm: false };
  await assert.rejects(runSemanticAction('semantic-enable', { homeRoot }, deps), { code: 'host_encoder_not_ready' });
  assertPreserved(homePath, before);
  assert.equal(rows.length, 0);
});

test('readiness must belong to the supervised encoder process', async t => {
  const { homeRoot } = fixture(t), { deps, rows } = fakes(homeRoot);
  deps.probe = async () => rows.some(row => row.pm2_env.status === 'online')
    ? { warm: true, recipeId: OWNED_RECIPE_HASH, dimension: 768, pid: 18001 } : { warm: false };
  await assert.rejects(runSemanticAction('semantic-enable', { homeRoot }, deps), { code: 'host_supervisor_ambiguous' });
  assert.equal(rows.length, 0);
  assert.equal(readHostState(homeRoot).encoderRequired, false);
});

test('configuration changed while the model prepares is preserved and requires reconciliation', async t => {
  const { homeRoot, homePath } = fixture(t), { deps } = fakes(homeRoot);
  const changed = '# Later operator edit\nhome:\n  purpose: preserve this update\n';
  const prepare = deps.ensureArtifacts;
  deps.ensureArtifacts = async (...args) => {
    fs.writeFileSync(homePath, changed);
    return prepare(...args);
  };
  await assert.rejects(runSemanticAction('semantic-enable', { homeRoot }, deps), { code: 'host_semantic_rollback_required' });
  assert.equal(fs.readFileSync(homePath, 'utf8'), changed);
  assert.equal(readHostState(homeRoot).encoderRequired, false);
  assert.equal(readPrivateJSON(path.join(homeRoot, 'runtime/semantic-enable.json')).phase, 'rollback_required');
});

test('semantic process definitions can be rebuilt while rollback snapshots remain preserved state', () => {
  assert.equal(isRebuildableStatePath('runtime/semantic-ecosystem.json'), true);
  assert.equal(isRebuildableStatePath('runtime/semantic-enable.json'), false);
});

test('invalid configuration fails without exposing its contents or starting the encoder', async t => {
  const { homeRoot, homePath } = fixture(t), { deps, calls } = fakes(homeRoot);
  fs.writeFileSync(homePath, 'private-fixture-content: [unterminated');
  await assert.rejects(runSemanticAction('semantic-enable', { homeRoot }, deps), error => {
    assert.equal(error.code, 'host_semantic_config_invalid');
    assert.doesNotMatch(error.message, /private-fixture-content/); return true;
  });
  assert.equal(calls.some(call => call[0] === 'start' || call[0] === 'artifacts'), false);
});

function fileSnapshot(file) {
  return { bytes: fs.readFileSync(file), mode: fs.statSync(file).mode & 0o777 };
}

function assertPreserved(file, before) {
  assert.deepEqual(fs.readFileSync(file), before.bytes, `${path.basename(file)} contents changed`);
  assert.equal(fs.statSync(file).mode & 0o777, before.mode, `${path.basename(file)} permissions changed`);
}

function treeSnapshot(root) {
  const records = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = fs.lstatSync(file), relative = path.relative(root, file);
      records.push([relative, stat.isDirectory() ? 'directory' : 'file', stat.mode & 0o777,
        stat.isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null]);
      if (stat.isDirectory()) visit(file);
    }
  }
  visit(root);
  return records;
}

function fakes(homeRoot, options = {}) {
  const rows = options.rows || [];
  const calls = [];
  const deps = {
    firstPort: 20000,
    timeoutMs: 0,
    pollMs: 0,
    sleep: async () => {},
    ensureSupervisor: async root => { assert.equal(root, homeRoot); calls.push(['ensure']); },
    reservePort: async (port, callback) => { calls.push(['reserve', port]); return callback(); },
    ensureArtifacts: async (cacheDir, artifactOptions) => {
      assert.equal(cacheDir, path.join(homeRoot, 'runtime/embedder-cache'));
      assert.equal(artifactOptions.fetchIfMissing, true);
      calls.push(['artifacts']);
      return { ok: true, artifactDigests: { model: 'a'.repeat(64) } };
    },
    probe: async port => {
      calls.push(['probe', port]);
      return options.ready === false || !rows.some(row => row.name === 'home23-embedder' && row.pm2_env?.status === 'online') ? { ok: false, warm: false }
        : { ok: true, warm: true, recipeId: OWNED_RECIPE_HASH, dimension: 768 };
    },
    supervisorCommand: async (root, args) => {
      assert.equal(root, homeRoot);
      calls.push([...args]);
      if (args[0] === 'jlist') return { stdout: JSON.stringify(rows) };
      if (args[0] === 'start') {
        const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
        const selected = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
        for (const app of config.apps.filter(app => !selected || app.name === selected)) {
          assert.equal(app.name, 'home23-embedder', 'enable must not start residents');
          rows.push({ name: app.name, pid: 9001, pm2_env: {
            ...app.env, env: app.env, status: 'online', pm_cwd: app.cwd,
            pm_exec_path: path.resolve(app.cwd, app.script), args: app.args,
            min_uptime: app.min_uptime, exp_backoff_restart_delay: app.exp_backoff_restart_delay,
          } });
        }
      } else if (args[0] === 'delete') {
        for (let index = rows.length - 1; index >= 0; index--) if (rows[index].name === args[1]) rows.splice(index, 1);
      } else if (args[0] === 'stop') {
        for (const row of rows) if (row.name === args[1]) { row.pm2_env.status = 'stopped'; row.pid = 0; }
      } else if (args[0] === 'restart') {
        for (const row of rows) if (row.name === args[1]) { row.pm2_env.status = 'online'; row.pid = 9001; }
      } else {
        assert.fail(`Unexpected supervisor command: ${args[0]}`);
      }
      return { stdout: '' };
    },
  };
  return { deps, calls, rows };
}

test('semantic-enable dry-run plans an adopted home without changing files or preparing artifacts', async t => {
  const f = fixture(t, { sealed: true });
  const before = treeSnapshot(f.homeRoot), fake = fakes(f.homeRoot);
  const result = await runSemanticAction('semantic-enable', { homeRoot: f.homeRoot, dryRun: true }, fake.deps);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'planned');
  assert.equal(result.dryRun, true);
  assert.equal(result.port, 20011);
  assert.deepEqual(treeSnapshot(f.homeRoot), before);
  assert.equal(fake.calls.some(call => ['ensure', 'artifacts', 'probe', 'start', 'restart', 'stop', 'delete'].includes(call[0])), false);
});

test('semantic-enable allocates beyond every resident port, configures each engine, and preserves sealed adoption bindings', async t => {
  const f = fixture(t, { sealed: true }), fake = fakes(f.homeRoot);
  const receiptPath = path.join(f.homeRoot, 'runtime/adoption-preservation.json');
  const receipt = fileSnapshot(receiptPath);
  const seedConfig = yaml.load(fs.readFileSync(f.homePath, 'utf8')).substrate.embedding;
  const result = await runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'enabled');
  assert.equal(result.port, 20011);
  const state = readHostState(f.homeRoot);
  assert.equal(state.encoderRequired, true);
  assert.equal(state.ports.embedder, result.port);
  assert.deepEqual(state.networkBindings, f.state.networkBindings);
  assert.equal(state.semanticExtension.schema, 'home23.semantic-extension.v1');
  assert.equal(state.semanticExtension.port, result.port);
  assert.equal(state.semanticExtension.recipeId, OWNED_RECIPE_HASH);
  assertPreserved(receiptPath, receipt);
  assert.deepEqual(yaml.load(fs.readFileSync(f.homePath, 'utf8')).substrate.embedding, seedConfig,
    'enabling the brain provider must preserve the Seed encoder contract');
  for (const file of [f.homePath, ...f.instancePaths]) {
    const config = yaml.load(fs.readFileSync(file, 'utf8'));
    assert.equal(config.architecture.memory.embedding.provider, 'owned-onnx');
    assert.equal(config.architecture.memory.embedding.model, OWNED_PROFILE_ID);
    assert.equal(config.architecture.memory.embedding.dimensions, 768);
    assert.equal(config.architecture.memory.embedding.baseUrl, `http://127.0.0.1:${result.port}/v1`);
    assert.equal(config.architecture.memory.embedding.fallback, 'none');
  }
  const artifacts = fake.calls.findIndex(call => call[0] === 'artifacts');
  const start = fake.calls.findIndex(call => call[0] === 'start');
  const probe = fake.calls.findIndex(call => call[0] === 'probe');
  assert.ok(artifacts >= 0 && start > artifacts && probe > start);
  assert.deepEqual(fake.rows.map(row => row.name), ['home23-embedder']);
});

test('semantic-enable retries a busy port without replacing the adopted port plan', async t => {
  const f = fixture(t), fake = fakes(f.homeRoot);
  const busyPort = 30000, attempted = [];
  fake.deps.reservePort = async (port, callback) => {
    attempted.push(port);
    if (port === busyPort) throw Object.assign(new Error('Synthetic occupied port'), { code: 'EADDRINUSE' });
    return callback();
  };
  fake.deps.firstPort = busyPort;
  const result = await runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps);
  assert.equal(result.port, busyPort + 1);
  assert.deepEqual(attempted.slice(0, 2), [busyPort, busyPort + 1]);
  assert.deepEqual(Object.fromEntries(Object.entries(readHostState(f.homeRoot).ports).filter(([key]) => key !== 'embedder')), f.state.ports);
});

test('semantic-enable is idempotent and retains the same warm registration and port', async t => {
  const f = fixture(t), fake = fakes(f.homeRoot);
  const first = await runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps);
  const state = fs.readFileSync(path.join(f.homeRoot, '.home23-host.json'));
  const config = fs.readFileSync(f.homePath);
  const second = await runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps);
  assert.equal(second.ok, true);
  assert.equal(second.port, first.port);
  assert.equal(fake.calls.filter(call => call[0] === 'start').length, 1);
  assert.equal(fake.calls.filter(call => call[0] === 'artifacts').length, 1);
  assert.equal(fake.rows.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(f.homeRoot, '.home23-host.json')), state);
  assert.deepEqual(fs.readFileSync(f.homePath), config);
});

test('failed readiness restores the previous Host state and engine configuration and deletes the new process', async t => {
  const f = fixture(t, { sealed: true }), fake = fakes(f.homeRoot, { ready: false });
  const files = [path.join(f.homeRoot, '.home23-host.json'), f.homePath, ...f.instancePaths,
    path.join(f.homeRoot, 'runtime/adoption-preservation.json')];
  const before = files.map(fileSnapshot);
  await assert.rejects(runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps), /ready|readiness/i);
  files.forEach((file, index) => assertPreserved(file, before[index]));
  assert.equal(fake.rows.length, 0);
  assert.ok(fake.calls.some(call => call[0] === 'delete' && call[1] === 'home23-embedder'));
  assert.equal(readHostState(f.homeRoot).encoderRequired, false);
});

test('artifact failure prevents process registration and preserves the adopted state', async t => {
  const f = fixture(t), fake = fakes(f.homeRoot);
  const before = fileSnapshot(path.join(f.homeRoot, '.home23-host.json'));
  fake.deps.ensureArtifacts = async () => ({ ok: false, code: 'bad_artifact' });
  await assert.rejects(runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps), /artifact|model|verif/i);
  assertPreserved(path.join(f.homeRoot, '.home23-host.json'), before);
  assert.equal(fake.calls.some(call => call[0] === 'start'), false);
});

test('semantic-disable restores original configuration and bindings and is idempotent', async t => {
  const f = fixture(t, { sealed: true }), fake = fakes(f.homeRoot);
  const files = [path.join(f.homeRoot, '.home23-host.json'), f.homePath, ...f.instancePaths,
    path.join(f.homeRoot, 'runtime/adoption-preservation.json')];
  const before = files.map(fileSnapshot);
  await runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps);
  const result = await runSemanticAction('semantic-disable', { homeRoot: f.homeRoot }, fake.deps);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'disabled');
  files.forEach((file, index) => assertPreserved(file, before[index]));
  assert.equal(fake.rows.length, 0);
  const deletes = fake.calls.filter(call => call[0] === 'delete').length;
  const repeated = await runSemanticAction('semantic-disable', { homeRoot: f.homeRoot }, fake.deps);
  assert.equal(repeated.ok, true);
  assert.equal(fake.calls.filter(call => call[0] === 'delete').length, deletes);
});

test('semantic-disable dry-run preserves enabled configuration and registration', async t => {
  const f = fixture(t), fake = fakes(f.homeRoot);
  await runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps);
  const before = treeSnapshot(f.homeRoot), callCount = fake.calls.length;
  const result = await runSemanticAction('semantic-disable', { homeRoot: f.homeRoot, dryRun: true }, fake.deps);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'planned');
  assert.deepEqual(treeSnapshot(f.homeRoot), before);
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.calls.slice(callCount).some(call => ['start', 'stop', 'delete', 'restart'].includes(call[0])), false);
});

test('semantic-disable refuses to overwrite configuration changed after enable', async t => {
  const f = fixture(t), fake = fakes(f.homeRoot);
  await runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps);
  fs.appendFileSync(f.instancePaths[1], '\n# owner changed this configuration\n');
  const before = treeSnapshot(f.homeRoot), callCount = fake.calls.length;
  await assert.rejects(runSemanticAction('semantic-disable', { homeRoot: f.homeRoot }, fake.deps), /changed|differs/i);
  assert.deepEqual(treeSnapshot(f.homeRoot), before);
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.calls.slice(callCount).some(call => ['stop', 'delete'].includes(call[0])), false);
});

test('semantic-enable refuses an active resident writer before changing state or starting the encoder', async t => {
  const f = fixture(t);
  const fake = fakes(f.homeRoot, { rows: [{ name: 'home23-jerry', pid: 9002, pm2_env: {
    status: 'online', pm_cwd: path.join(f.homeRoot, 'app'), pm_exec_path: path.join(f.homeRoot, 'bin/node'),
    args: [path.join(f.homeRoot, 'app/engine/src/cli.js')],
  } }] });
  const before = treeSnapshot(f.homeRoot);
  await assert.rejects(runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps), /stop|running|writer/i);
  assert.deepEqual(treeSnapshot(f.homeRoot), before);
  assert.equal(fake.calls.some(call => ['ensure', 'artifacts', 'start', 'stop', 'delete'].includes(call[0])), false);
});

test('semantic-disable recovers an interrupted enable with a mixture of original and applied configuration files', async t => {
  const f = fixture(t, { sealed: true }), fake = fakes(f.homeRoot);
  const files = [path.join(f.homeRoot, '.home23-host.json'), f.homePath, ...f.instancePaths,
    path.join(f.homeRoot, 'runtime/adoption-preservation.json')];
  const before = files.map(fileSnapshot);
  await runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps);
  const journalPath = path.join(f.homeRoot, 'runtime/semantic-enable.json');
  const journal = readPrivateJSON(journalPath);
  // A crash during configuration can leave each journaled file on either side.
  for (const relative of ['app/instances/forrest/config.yaml', '.home23-host.json', 'runtime/semantic-prep.json']) {
    const record = journal.files.find(file => file.path === relative);
    if (record.before === null) fs.unlinkSync(path.join(f.homeRoot, relative));
    else fs.writeFileSync(path.join(f.homeRoot, relative), record.before, { mode: 0o600 });
  }
  privateJSON(journalPath, { ...journal, phase: 'configuring' });
  const result = await runSemanticAction('semantic-disable', { homeRoot: f.homeRoot }, fake.deps);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'disabled');
  files.forEach((file, index) => assertPreserved(file, before[index]));
  assert.equal(fake.rows.length, 0);
  assert.equal(fs.existsSync(path.join(f.homeRoot, 'runtime/semantic-prep.json')), false);
});

test('ordinary Start and Stop lifecycle changes do not block idempotence or disable and remain preserved', async t => {
  const f = fixture(t, { sealed: true }), fake = fakes(f.homeRoot);
  await runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps);
  const stateFile = path.join(f.homeRoot, '.home23-host.json');
  const enabled = readHostState(f.homeRoot);
  const startedAt = '2026-10-13T12:00:00.000Z', stoppedAt = '2026-10-13T12:01:00.000Z';
  // These are the normal durable Host writes, without starting any real writer.
  privateJSON(stateFile, { ...enabled, phase: 'ready', desiredRunning: true, startedAt });
  privateJSON(stateFile, { ...readHostState(f.homeRoot), phase: 'stopped', desiredRunning: false, stoppedAt });
  const repeated = await runSemanticAction('semantic-enable', { homeRoot: f.homeRoot }, fake.deps);
  assert.equal(repeated.ok, true);
  assert.equal(fake.calls.filter(call => call[0] === 'start').length, 1);
  const result = await runSemanticAction('semantic-disable', { homeRoot: f.homeRoot }, fake.deps);
  assert.equal(result.ok, true);
  const restored = readHostState(f.homeRoot);
  assert.equal(restored.encoderRequired, false);
  assert.equal(restored.phase, 'stopped');
  assert.equal(restored.desiredRunning, false);
  assert.equal(restored.startedAt, startedAt);
  assert.equal(restored.stoppedAt, stoppedAt);
  assert.deepEqual(restored.ports, f.state.ports);
  assert.equal(restored.semanticExtension, undefined);
});
