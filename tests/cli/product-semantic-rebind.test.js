import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  assertSemanticEnableSettled, rebindSemanticEnableRecords, scanHomeReferences, validateSemanticPortExtension,
} from '../../cli/lib/product-backup.js';
import { runSemanticAction } from '../../cli/lib/product-semantic-enable.js';
import { privateJSON, readPrivateJSON } from '../../cli/lib/product-environment.js';
import { OWNED_PROFILE_ID, OWNED_RECIPE_HASH } from '../../cli/lib/product-embedder.js';

const ports = base => ({ coordination: base, engine: base + 1, dashboard: base + 2, mcp: base + 3,
  bridge: base + 4, evobrew: base + 5, observatory: base + 6 });
const residentPorts = base => ({ jerry: { engine: base, dashboard: base + 1, mcp: base + 2, bridge: base + 3 },
  forrest: { engine: base + 4, dashboard: base + 5, mcp: base + 6, bridge: base + 7 } });
const extension = port => ({ schema: 'home23.semantic-extension.v1', port, recipeId: OWNED_RECIPE_HASH });
const encode = value => JSON.stringify(value, null, 2) + '\n';
const legacy = { provider: 'ollama', model: 'nomic-embed-text', dimensions: 768, baseUrl: 'http://127.0.0.1:11434/v1' };
const owned = port => ({ provider: 'owned-onnx', model: OWNED_PROFILE_ID, dimensions: 768,
  baseUrl: `http://127.0.0.1:${port}/v1`, recipeId: OWNED_RECIPE_HASH, fallback: 'none' });

function fixture(t, { phase = 'enabled', seed = 'legacy' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-rebind-unit-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'old home'), destination = path.join(root, 'new home');
  fs.mkdirSync(source, { mode: 0o700 });
  for (const directory of ['runtime', 'app/config', 'app/instances/jerry/brain', 'app/instances/forrest', 'bin'])
    fs.mkdirSync(path.join(destination, directory), { recursive: true, mode: 0o700 });
  const oldShared = ports(21000), oldPorts = { ...oldShared, embedder: 21020 };
  const newPorts = { ...ports(31000), embedder: 31020 }, residents = residentPorts(22000), newResidents = residentPorts(32000);
  const beforeHost = { schema: 'home23.host.v2', homeRoot: source, encoderRequired: false, ports: oldShared,
    desiredRunning: false, phase: 'stopped', profile: { name: 'jerry', provider: 'ollama-local', model: 'fixture' },
    residentMap: Object.fromEntries(Object.entries(residents).map(([name, ports]) => [name, { ports }])) };
  const afterHost = { ...beforeHost, encoderRequired: true, ports: oldPorts, semanticExtension: extension(oldPorts.embedder) };
  const seedConfig = seed === 'owned'
    ? { model: OWNED_PROFILE_ID, recipeId: OWNED_RECIPE_HASH, endpoint: `http://127.0.0.1:${oldPorts.embedder}/api/embeddings` }
    : seed === 'old-port'
      ? { model: 'existing-custom-encoder', endpoint: `http://127.0.0.1:${oldPorts.embedder}/api/embeddings` }
      : { model: 'nomic-embed-text', endpoint: 'http://127.0.0.1:11434/api/embeddings' };
  const beforeHome = { home: { primaryAgent: 'jerry' }, coordination: { socketDirectory: '/tmp/previous-home', publicApi: { port: oldPorts.coordination } },
    substrate: { embedding: seedConfig }, architecture: { memory: { decay: { baseFactor: 0.995 }, embedding: legacy } },
    workspace: path.join(source, 'app/instances/jerry/workspace') };
  const afterHome = { ...beforeHome, embedder: { owned: true, port: oldPorts.embedder },
    embeddings: { providers: [{ provider: 'home23-owned', model: OWNED_PROFILE_ID, dimensions: 768,
      endpoint: `http://127.0.0.1:${oldPorts.embedder}/api/embeddings`, recipeId: OWNED_RECIPE_HASH }] },
    architecture: { memory: { ...beforeHome.architecture.memory, embedding: owned(oldPorts.embedder) } } };
  const prep = { schema: 'home23.semantic-prep.v1', homeRoot: source, phase: 'ready', port: oldPorts.embedder,
    recipeId: OWNED_RECIPE_HASH, workerPid: 0, cacheDir: path.join(source, 'runtime/embedder-cache'),
    workerArgv: [path.join(source, 'bin/node'), path.join(source, 'app/scripts/product/semantic-prepare-worker.mjs'), '--home', source] };
  const files = [
    { path: 'app/config/home.yaml', before: yaml.dump(beforeHome), after: yaml.dump(afterHome) },
    ...Object.entries(residents).map(([name, ports]) => {
      const before = { name, ports, system: { instanceRoot: path.join(source, 'app/instances', name) },
        architecture: { memory: { embedding: legacy } } };
      const after = { ...before, architecture: { memory: { embedding: owned(oldPorts.embedder) } } };
      return { path: `app/instances/${name}/config.yaml`, before: yaml.dump(before), after: yaml.dump(after) };
    }),
    { path: 'runtime/semantic-prep.json', before: null, after: encode(prep) },
    { path: '.home23-host.json', before: encode(beforeHost), after: encode(afterHost) },
  ];
  for (const file of files) {
    const text = phase === 'disabled' ? file.before : file.after;
    if (text !== null) fs.writeFileSync(path.join(destination, file.path), text, { mode: 0o600 });
  }
  const journal = { schema: 'home23.semantic-enable.v1', homeRoot: source, port: oldPorts.embedder, phase, files };
  privateJSON(path.join(destination, 'runtime/semantic-enable.json'), journal);
  privateJSON(path.join(destination, 'runtime/semantic-ecosystem.json'), { apps: [{ name: 'home23-embedder',
    script: '../bin/node', interpreter: 'none', cwd: path.join(source, 'app'), args: [path.join(source, 'app/scripts/embedder/serve.mjs')],
    env: { HOME: path.join(source, 'runtime/user'), HOME23_ROOT: path.join(source, 'app'),
      HOME23_EMBEDDER_PORT: String(oldPorts.embedder), HOME23_EMBEDDER_CACHE: path.join(source, 'runtime/embedder-cache') } }] });
  const brainFile = path.join(destination, 'app/instances/jerry/brain/state.json');
  fs.writeFileSync(brainFile, '{"memory":{"nodes":[],"edges":[],"metadata":{"embedderId":"ollama:nomic-embed-text:768"}}}\n');
  return { root, source, destination, oldShared, oldPorts, newPorts, residents, newResidents, beforeHost, afterHost, journal, brainFile };
}

test('sealed adoption bindings admit only a verified separate owned port extension', () => {
  const shared = ports(21000), residents = residentPorts(22000), port = 23000;
  const host = { schema: 'home23.host.v2', encoderRequired: true, ports: { ...shared, embedder: port }, semanticExtension: extension(port),
    residentMap: Object.fromEntries(Object.entries(residents).map(([name, ports]) => [name, { ports }])),
    networkBindings: { schema: 'home23.adoption-network-bindings.v1', shared, residents } };
  const original = encode(host.networkBindings);
  assert.equal(validateSemanticPortExtension(host), port);
  assert.equal(encode(host.networkBindings), original);
  for (const change of [
    state => { delete state.semanticExtension; },
    state => { state.semanticExtension.recipeId = 'unreviewed-recipe'; },
    state => { state.semanticExtension.port = 11435; state.ports.embedder = 11435; },
    state => { state.semanticExtension.port = 22000; state.ports.embedder = 22000; },
    state => { state.ports.engine += 1; },
    state => { state.semanticExtension.unreviewed = true; },
  ]) {
    const changed = structuredClone(host); change(changed);
    assert.throws(() => validateSemanticPortExtension(changed), { code: 'move_rebind_incomplete' });
  }
});

test('rebind renews owned rollback snapshots and definition while retaining the adopted Seed encoder', async t => {
  const f = fixture(t);
  const brain = fs.readFileSync(f.brainFile);
  await rebindSemanticEnableRecords(f.source, f.destination, f.oldPorts, f.newPorts, { residentPorts: f.newResidents });
  const rebound = readPrivateJSON(path.join(f.destination, 'runtime/semantic-enable.json'));
  assert.equal(rebound.homeRoot, f.destination); assert.equal(rebound.port, f.newPorts.embedder);
  for (const file of rebound.files) assert.equal(file.after, fs.readFileSync(path.join(f.destination, file.path), 'utf8'));
  const baseline = JSON.parse(rebound.files.find(file => file.path === '.home23-host.json').before);
  assert.equal(baseline.homeRoot, f.destination); assert.equal(baseline.encoderRequired, false);
  assert.equal(baseline.semanticExtension, undefined); assert.equal(baseline.ports.embedder, undefined);
  assert.equal(baseline.ports.coordination, f.newPorts.coordination);
  assert.deepEqual(baseline.residentMap.forrest.ports, f.newResidents.forrest);
  const active = readPrivateJSON(path.join(f.destination, '.home23-host.json'));
  assert.equal(active.semanticExtension.port, f.newPorts.embedder); validateSemanticPortExtension(active);
  const home = yaml.load(fs.readFileSync(path.join(f.destination, 'app/config/home.yaml'), 'utf8'));
  assert.equal(home.architecture.memory.embedding.baseUrl, `http://127.0.0.1:${f.newPorts.embedder}/v1`);
  assert.equal(home.substrate.embedding.endpoint, 'http://127.0.0.1:11434/api/embeddings');
  assert.equal(home.substrate.embedding.model, 'nomic-embed-text');
  const before = yaml.load(rebound.files.find(file => file.path === 'app/config/home.yaml').before);
  assert.deepEqual(before.architecture.memory.embedding, legacy);
  const definition = readPrivateJSON(path.join(f.destination, 'runtime/semantic-ecosystem.json')).apps[0];
  assert.equal(definition.cwd, path.join(f.destination, 'app'));
  assert.deepEqual(definition.args, [path.join(f.destination, 'app/scripts/embedder/serve.mjs')]);
  assert.equal(definition.env.HOME23_EMBEDDER_PORT, String(f.newPorts.embedder));
  assert.equal(definition.env.HOME23_EMBEDDER_CACHE, path.join(f.destination, 'runtime/embedder-cache'));
  assert.deepEqual(scanHomeReferences(f.destination, f.source), []);
  assert.deepEqual(fs.readFileSync(f.brainFile), brain);
  const bytes = fs.readFileSync(path.join(f.destination, 'runtime/semantic-enable.json'));
  await rebindSemanticEnableRecords(f.source, f.destination, f.oldPorts, f.newPorts, { residentPorts: f.newResidents });
  assert.deepEqual(fs.readFileSync(path.join(f.destination, 'runtime/semantic-enable.json')), bytes);
  // The actual disable path consumes the rebound snapshots with fake service inspection only.
  await runSemanticAction('semantic-disable', { homeRoot: f.destination }, {
    supervisorCommand: async () => ({ stdout: '[]' }), probe: async () => ({ warm: false }),
  });
  const disabled = readPrivateJSON(path.join(f.destination, '.home23-host.json'));
  assert.equal(disabled.homeRoot, f.destination); assert.equal(disabled.encoderRequired, false);
  assert.equal(disabled.ports.embedder, undefined); assert.equal(disabled.semanticExtension, undefined);
  assert.deepEqual(yaml.load(fs.readFileSync(path.join(f.destination, 'app/config/home.yaml'), 'utf8')).architecture.memory.embedding, legacy);
  assert.equal(fs.existsSync(path.join(f.destination, 'runtime/semantic-prep.json')), false);
});

test('owned Seed recipes and actual previous owned endpoints follow the embedder port', async t => {
  for (const seed of ['owned', 'old-port']) {
    const f = fixture(t, { seed });
    await rebindSemanticEnableRecords(f.source, f.destination, f.oldPorts, f.newPorts, { residentPorts: f.newResidents });
    const home = yaml.load(fs.readFileSync(path.join(f.destination, 'app/config/home.yaml'), 'utf8'));
    assert.equal(home.substrate.embedding.endpoint, `http://127.0.0.1:${f.newPorts.embedder}/api/embeddings`);
    assert.equal(home.substrate.embedding.model, seed === 'owned' ? OWNED_PROFILE_ID : 'existing-custom-encoder');
  }
});

test('an owned target port overlapping an old engine port is assigned after generic port rewriting', async t => {
  const f = fixture(t, { seed: 'old-port' });
  const newPorts = { ...f.newPorts, embedder: f.oldPorts.engine };
  await rebindSemanticEnableRecords(f.source, f.destination, f.oldPorts, newPorts, { residentPorts: f.newResidents });
  const journal = readPrivateJSON(path.join(f.destination, 'runtime/semantic-enable.json'));
  const expected = `http://127.0.0.1:${newPorts.embedder}`;
  const home = yaml.load(fs.readFileSync(path.join(f.destination, 'app/config/home.yaml'), 'utf8'));
  assert.equal(home.architecture.memory.embedding.baseUrl, `${expected}/v1`);
  assert.equal(home.substrate.embedding.endpoint, `${expected}/api/embeddings`);
  assert.equal(home.embeddings.providers[0].endpoint, `${expected}/api/embeddings`);
  for (const name of ['jerry', 'forrest']) {
    const instance = yaml.load(fs.readFileSync(path.join(f.destination, `app/instances/${name}/config.yaml`), 'utf8'));
    assert.equal(instance.architecture.memory.embedding.baseUrl, `${expected}/v1`);
  }
  for (const file of journal.files.filter(file => file.path.endsWith('.yaml'))) {
    assert.equal(yaml.load(file.after).architecture.memory.embedding.baseUrl, `${expected}/v1`);
  }
  assert.equal(journal.port, newPorts.embedder);
});

test('disabled semantic journals keep rebound rollback history without requiring a new owned port', async t => {
  const f = fixture(t, { phase: 'disabled' });
  const newPorts = ports(31000);
  await rebindSemanticEnableRecords(f.source, f.destination, f.oldPorts, newPorts, { residentPorts: f.newResidents });
  const rebound = readPrivateJSON(path.join(f.destination, 'runtime/semantic-enable.json'));
  assert.equal(rebound.phase, 'disabled'); assert.equal(rebound.homeRoot, f.destination);
  assert.equal(readPrivateJSON(path.join(f.destination, '.home23-host.json')).encoderRequired, false);
  assert.equal(fs.existsSync(path.join(f.destination, 'runtime/semantic-prep.json')), false);
  assert.deepEqual(scanHomeReferences(f.destination, f.source), []);
});

test('disabled rollback history permits later owner settings and retains them during rebind', async t => {
  const f = fixture(t, { phase: 'disabled' });
  const homeFile = path.join(f.destination, 'app/config/home.yaml');
  const config = yaml.load(fs.readFileSync(homeFile, 'utf8'));
  config.home.purpose = 'A later owner decision';
  config.home.timezone = 'America/Chicago';
  fs.writeFileSync(homeFile, yaml.dump(config), { mode: 0o600 });
  const newPorts = { ...ports(31000), engine: f.oldPorts.dashboard };
  await rebindSemanticEnableRecords(f.source, f.destination, f.oldPorts, newPorts, { residentPorts: f.newResidents });
  const moved = yaml.load(fs.readFileSync(homeFile, 'utf8'));
  assert.equal(moved.home.purpose, 'A later owner decision');
  assert.equal(moved.home.timezone, 'America/Chicago');
  assert.deepEqual(moved.architecture.memory.embedding, legacy);
  const journal = readPrivateJSON(path.join(f.destination, 'runtime/semantic-enable.json'));
  assert.equal(journal.phase, 'disabled');
  const historical = yaml.load(journal.files.find(file => file.path === 'app/config/home.yaml').before);
  assert.equal(historical.home.purpose, undefined);
  assert.equal(historical.home.timezone, undefined);
  // Model the outer configuration rebind completing before journal renewal.
  // Its target engine URL also equals an old dashboard port and must stay put.
  moved.ownerService = { endpoint: `http://127.0.0.1:${newPorts.engine}/v1` };
  fs.writeFileSync(homeFile, yaml.dump(moved), { mode: 0o600 });
  await rebindSemanticEnableRecords(f.source, f.destination, f.oldPorts, newPorts,
    { residentPorts: f.newResidents, configurationRebound: true });
  assert.equal(yaml.load(fs.readFileSync(homeFile, 'utf8')).ownerService.endpoint, moved.ownerService.endpoint);
  assert.deepEqual(scanHomeReferences(f.destination, f.source), []);
});

test('pending semantic transitions refuse planning without modifying any configuration', async t => {
  for (const phase of ['preparing', 'warming', 'configuring', 'disabling', 'rollback_required']) {
    const f = fixture(t, { phase });
    const bytes = fs.readFileSync(path.join(f.destination, 'runtime/semantic-enable.json'));
    assert.throws(() => assertSemanticEnableSettled(f.destination), { code: 'move_semantic_transition_pending' });
    await assert.rejects(rebindSemanticEnableRecords(f.source, f.destination, f.oldPorts, f.newPorts), { code: 'move_semantic_transition_pending' });
    assert.deepEqual(fs.readFileSync(path.join(f.destination, 'runtime/semantic-enable.json')), bytes);
    assert.equal(readPrivateJSON(path.join(f.destination, '.home23-host.json')).homeRoot, f.source);
  }
});

test('journal renewal refuses configuration drift and unsupported snapshot paths', async t => {
  const f = fixture(t);
  const journalFile = path.join(f.destination, 'runtime/semantic-enable.json'), hostFile = path.join(f.destination, '.home23-host.json');
  const journal = fs.readFileSync(journalFile), host = fs.readFileSync(hostFile);
  fs.appendFileSync(path.join(f.destination, 'app/config/home.yaml'), '\nownerAdded: retain-this-edit\n');
  await assert.rejects(rebindSemanticEnableRecords(f.source, f.destination, f.oldPorts, f.newPorts), /changed since its rollback snapshot/);
  assert.deepEqual(fs.readFileSync(journalFile), journal); assert.deepEqual(fs.readFileSync(hostFile), host);
  const bad = structuredClone(f.journal);
  bad.files.push({ path: 'app/config/secrets.yaml', before: null, after: '{}' });
  privateJSON(journalFile, bad);
  assert.throws(() => assertSemanticEnableSettled(f.destination), /invalid snapshot/);
});
