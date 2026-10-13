/** Explicit encoder transition for an installed home. Never runs a PM2 CLI. */
import { existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join, relative, resolve } from 'node:path';
import yaml from 'js-yaml';
import { absoluteHome, embedderCacheDir, privateJSON, productEnvironment, readPrivateJSON } from './product-environment.js';
import { acquireHostLock, readMoveFence } from './product-backup.js';
import { ensureProductSupervisor, productSupervisorCommand, supervisorSocketListening } from './product-supervisor.js';
import { OWNED_EMBEDDER_PROCESS, OWNED_PROFILE_ID, OWNED_RECIPE_HASH, probeOwnedReady } from './product-embedder.js';
import { hostResidentNames, readHostState } from './product-host.js';

const SCHEMA = 'home23.semantic-enable.v1';
const journalPath = root => join(root, 'runtime/semantic-enable.json');
const statePath = root => join(root, '.home23-host.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code, message) { throw Object.assign(new Error(message), { code }); }

function regularFile(path) {
  for (let current = path; current !== resolve(current, '..'); current = resolve(current, '..')) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) fail('host_semantic_unsafe_path', 'Semantic configuration paths must not contain symbolic links.');
  }
  if (!existsSync(path) || !lstatSync(path).isFile()) fail('host_semantic_config_missing', 'The installed home or resident configuration is missing.');
}
function atomicText(path, text) {
  regularFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: lstatSync(path).mode & 0o777, flag: 'wx' });
  renameSync(temporary, path);
}
function readJournal(root) {
  const journal = readPrivateJSON(journalPath(root));
  if (journal && (journal.schema !== SCHEMA || journal.homeRoot !== root || !Array.isArray(journal.files)
    || !['preparing', 'warming', 'configuring', 'enabled', 'disabling', 'disabled', 'rollback_required'].includes(journal.phase)
    || new Set(journal.files.map(file => file?.path)).size !== journal.files.length
    || !['.home23-host.json', 'app/config/home.yaml', 'runtime/semantic-prep.json'].every(path => journal.files.some(file => file?.path === path))
    || !Number.isInteger(journal.port) || journal.port < 20000 || journal.port > 60999)) {
    fail('host_semantic_journal_invalid', 'Semantic rollback metadata is invalid or belongs to another home.');
  }
  if (journal) for (const file of journal.files) {
    if (![ '.home23-host.json', 'app/config/home.yaml', 'runtime/semantic-prep.json' ].includes(file.path)
      && !/^app\/instances\/[a-z][a-z0-9-]{0,62}\/config\.yaml$/.test(file.path)) {
      fail('host_semantic_journal_invalid', 'Semantic rollback metadata contains an unsupported path.');
    }
    if (typeof file.before !== 'string' && file.before !== null || typeof file.after !== 'string')
      fail('host_semantic_journal_invalid', 'Semantic rollback metadata is incomplete.');
  }
  return journal;
}
function currentText(root, file) {
  const path = join(root, file.path);
  if (!existsSync(path)) return null;
  regularFile(path);
  return readFileSync(path, 'utf8');
}
const encoderStateKeys = ['schema', 'encoderRequired', 'ports', 'semanticExtension'];
function sameSnapshot(file, current, expected) {
  if (current === expected) return true;
  if (file.path !== '.home23-host.json' || current === null || expected === null) return false;
  try {
    const a = JSON.parse(current), b = JSON.parse(expected);
    return encoderStateKeys.every(key => JSON.stringify(a[key]) === JSON.stringify(b[key]));
  } catch { return false; }
}
function assertUnchanged(root, journal, { allowBefore = false } = {}) {
  for (const file of journal.files) {
    const current = currentText(root, file);
    if (!sameSnapshot(file, current, file.after) && !(allowBefore && sameSnapshot(file, current, file.before)))
      fail('host_semantic_config_changed', 'Semantic configuration changed since enable. Restore or reconcile those edits before disabling.');
  }
}

/** Reserve only the new port: existing resident ports can already be bound. */
export async function reserveSemanticPort(port, callback) {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, done);
  });
  try { return await callback(); }
  finally { await new Promise(done => server.close(done)); }
}
async function allocatePort(state, deps) {
  const used = new Set(Object.values(state.ports || {}));
  for (const resident of Object.values(state.residentMap || {})) for (const port of Object.values(resident.ports || {})) used.add(port);
  for (const ports of Object.values(state.networkBindings?.residents || {})) for (const port of Object.values(ports)) used.add(port);
  const reserve = deps.reservePort || reserveSemanticPort;
  const first = deps.firstPort ?? 20000 + Math.floor(Math.random() * 41000);
  for (let offset = 0; offset < 41000; offset++) {
    const port = 20000 + ((first - 20000 + offset) % 41000);
    if (used.has(port)) continue;
    try { await reserve(port, async () => {}); return port; }
    catch (error) { if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error; }
  }
  fail('host_semantic_ports_unavailable', 'No unused local embedder port is available.');
}

function definition(root, port) {
  const cwd = join(root, 'app');
  return { name: OWNED_EMBEDDER_PROCESS, script: relative(cwd, join(root, 'bin/node')), interpreter: 'none',
    cwd, args: [join(cwd, 'scripts/embedder/serve.mjs')], node_args: [],
    autostart: true, autorestart: true, min_uptime: 100, exp_backoff_restart_delay: 2000,
    env: productEnvironment(root, { encoderRequired: true, embedderPort: port }) };
}
function ownedEncoder(row, root, port) {
  const env = row?.pm2_env;
  return row?.name === OWNED_EMBEDDER_PROCESS && env?.pm_exec_path === join(root, 'bin/node')
    && env.pm_cwd === join(root, 'app') && JSON.stringify(env.args) === JSON.stringify([join(root, 'app/scripts/embedder/serve.mjs')])
    && String(env.HOME23_EMBEDDER_PORT) === String(port) && env.HOME23_EMBEDDER_CACHE === embedderCacheDir(root);
}
async function inventory(root, deps) {
  if (!deps.supervisorCommand) {
    const env = productEnvironment(root);
    const listening = deps.supervisorListening || supervisorSocketListening;
    const present = await listening(env.PM2_DAEMON_RPC_PORT);
    if (present === false && await listening(join(env.PM2_HOME, 'rpc.sock')) === false) return [];
    if (present !== true) fail('host_supervisor_ambiguous', 'The private product supervisor is unavailable or has an unexpected binding.');
  }
  let rows;
  try { rows = JSON.parse((await (deps.supervisorCommand || productSupervisorCommand)(root, ['jlist', '--silent'])).stdout); }
  catch { fail('host_supervisor_ambiguous', 'The product supervisor inventory could not be read.'); }
  if (!Array.isArray(rows) || new Set(rows.map(row => row.name)).size !== rows.length)
    fail('host_supervisor_ambiguous', 'The product supervisor returned an invalid inventory.');
  return rows;
}
function stoppedWriters(state, rows) {
  if (state.desiredRunning === true || rows.some(row => row.name !== OWNED_EMBEDDER_PROCESS
    && (row.pid > 0 || !['stopped', 'errored'].includes(row.pm2_env?.status))))
    fail('host_semantic_writers_active', 'Stop this home and its writers before changing its encoder.');
}
function configurationFiles(root, state, port) {
  const embedding = { provider: 'owned-onnx', model: OWNED_PROFILE_ID, dimensions: 768,
    baseUrl: `http://127.0.0.1:${port}/v1`, recipeId: OWNED_RECIPE_HASH, fallback: 'none' };
  const paths = ['app/config/home.yaml', ...hostResidentNames(state).map(name => `app/instances/${name}/config.yaml`)];
  return paths.map(path => {
    regularFile(join(root, path));
    const before = readFileSync(join(root, path), 'utf8');
    let config;
    try { config = yaml.load(before) || {}; }
    catch { fail('host_semantic_config_invalid', 'The installed home or resident YAML configuration could not be parsed.'); }
    if (typeof config !== 'object' || Array.isArray(config)) fail('host_semantic_config_invalid', 'Semantic configuration must be a YAML mapping.');
    config.architecture = { ...config.architecture, memory: { ...config.architecture?.memory, embedding } };
    if (path === paths[0]) {
      config.embedder = { owned: true, port, bind: '127.0.0.1' };
      config.embeddings = { ...config.embeddings, providers: [{ provider: 'home23-owned', model: OWNED_PROFILE_ID,
        dimensions: 768, endpoint: `http://127.0.0.1:${port}/api/embeddings`, recipeId: OWNED_RECIPE_HASH }] };
      // Seed history retains its recipe. Changing memory graphs does not migrate Seed.
    }
    return { path, before, after: yaml.dump(config) };
  });
}
async function ready(root, journal, deps) {
  const probe = deps.probe || probeOwnedReady;
  const deadline = Date.now() + (deps.timeoutMs ?? 120000);
  do {
    const result = await probe(journal.port);
    if (result.warm === true && result.recipeId === OWNED_RECIPE_HASH && result.dimension === 768) {
      const row = (await inventory(root, deps)).find(row => row.name === OWNED_EMBEDDER_PROCESS);
      if (!ownedEncoder(row, root, journal.port) || row.pm2_env.status !== 'online'
        || (Number.isInteger(result.pid) ? result.pid !== row.pid : !deps.probe))
        fail('host_supervisor_ambiguous', 'The ready encoder does not match its supervised process.');
      return result;
    }
    if (Date.now() >= deadline) break;
    await (deps.sleep || sleep)(deps.pollMs ?? 250);
  } while (Date.now() <= deadline);
  fail('host_encoder_not_ready', 'The owned embedder did not become ready with the expected recipe and 768 dimensions. Run semantic-disable to roll back, then retry enable.');
}
async function removeEncoder(root, journal, deps) {
  const rows = await inventory(root, deps);
  const row = rows.find(row => row.name === OWNED_EMBEDDER_PROCESS);
  if (row) {
    if (!ownedEncoder(row, root, journal.port)) fail('host_supervisor_ambiguous', 'The embedder registration differs from this home. No process was stopped.');
    const command = deps.supervisorCommand || productSupervisorCommand;
    await command(root, ['stop', OWNED_EMBEDDER_PROCESS, '--silent']);
    await command(root, ['delete', OWNED_EMBEDDER_PROCESS, '--silent']);
  }
  if ((await (deps.probe || probeOwnedReady)(journal.port)).warm)
    fail('host_encoder_still_warm', 'The owned encoder is still answering after disable. Rollback metadata was retained.');
}
async function restore(root, journal, deps) {
  assertUnchanged(root, journal, { allowBefore: journal.phase !== 'enabled' });
  stoppedWriters(readPrivateJSON(statePath(root)), await inventory(root, deps));
  journal.phase = 'disabling';
  privateJSON(journalPath(root), journal);
  await removeEncoder(root, journal, deps);
  for (const file of [...journal.files].reverse()) {
    const path = join(root, file.path);
    if (file.before === null) { if (existsSync(path)) { regularFile(path); unlinkSync(path); } }
    else if (file.path === '.home23-host.json' && currentText(root, file) !== file.after && currentText(root, file) !== file.before) {
      const current = JSON.parse(currentText(root, file)), before = JSON.parse(file.before);
      for (const key of encoderStateKeys) {
        if (Object.hasOwn(before, key)) current[key] = before[key];
        else delete current[key];
      }
      atomicText(path, JSON.stringify(current, null, 2) + '\n');
    } else atomicText(path, file.before);
  }
  privateJSON(journalPath(root), { ...journal, phase: 'disabled', disabledAt: new Date().toISOString() });
}

export async function runSemanticAction(action, { homeRoot, dryRun = false }, deps = {}) {
  deps = { ...deps, ensureSupervisor: deps.ensureSupervisor || deps.ensureProductSupervisor, probe: deps.probe || deps.probeOwnedReady };
  const root = absoluteHome(homeRoot);
  if (!['semantic-enable', 'semantic-disable'].includes(action)) fail('host_semantic_action_invalid', 'Unknown semantic action.');
  if (readMoveFence(root)) fail('move_source_fenced', 'This home is fenced after a move. Use its destination.');
  // Dry-run performs no filesystem writes, downloads, or supervisor mutations.
  let state = readHostState(root);
  const plannedState = JSON.stringify(state);
  if (!state || state.phase === 'creating') fail('host_semantic_home_missing', 'Finish preparing the existing home before enabling its encoder.');
  if (!hostResidentNames(state).length) fail('host_semantic_home_missing', 'The existing home has no configured residents.');
  let journal = readJournal(root);
  if (action === 'semantic-disable' && (!journal || journal.phase === 'disabled')) return { ok: true, status: 'disabled', homeRoot: root, dryRun };
  if (action === 'semantic-enable' && journal && !['enabled', 'disabled'].includes(journal.phase))
    fail('host_semantic_rollback_required', 'An interrupted semantic enable needs semantic-disable before retrying.');
  if (action === 'semantic-enable' && state.encoderRequired === true && journal?.phase !== 'enabled')
    fail('host_semantic_already_configured', 'This home already has an encoder. Semantic enable only transitions existing homes without one.');
  const port = journal && journal.phase !== 'disabled' ? journal.port : await allocatePort(state, deps);
  const files = action === 'semantic-enable' && journal?.phase !== 'enabled' ? configurationFiles(root, state, port) : journal.files;
  if (journal?.phase === 'enabled') assertUnchanged(root, journal);
  if (dryRun) return { ok: true, status: 'planned', dryRun: true, homeRoot: root, port,
    provider: OWNED_PROFILE_ID, recipeId: OWNED_RECIPE_HASH, files: files.map(file => file.path),
    requiresStoppedWriters: true, brainMigrationRequired: true };
  const lock = acquireHostLock(root);
  if (!lock) fail('host_lifecycle_busy', 'Another lifecycle operation holds this home.');
  try {
    // Re-read under the shared lifecycle lock before any mutation.
    state = readHostState(root);
    if (JSON.stringify(state) !== plannedState) fail('host_semantic_config_changed', 'The home state changed during planning. Retry.');
    if (JSON.stringify(readJournal(root)) !== JSON.stringify(journal)) fail('host_semantic_config_changed', 'Semantic enable metadata changed during planning. Retry.');
    for (const file of files) if (!sameSnapshot(file, currentText(root, file), journal?.phase === 'enabled' ? file.after : file.before)
      && !(action === 'semantic-disable' && sameSnapshot(file, currentText(root, file), file.after)))
      fail('host_semantic_config_changed', 'Semantic configuration changed during planning. Retry.');
    const rows = await inventory(root, deps);
    stoppedWriters(state, rows);
    if (action === 'semantic-disable') { await restore(root, journal, deps); return { ok: true, status: 'disabled', homeRoot: root, port }; }
    const row = rows.find(row => row.name === OWNED_EMBEDDER_PROCESS);
    if (row && (journal?.phase !== 'enabled' || !ownedEncoder(row, root, port)))
      fail('host_supervisor_ambiguous', 'An existing embedder registration was not created by this semantic enable.');
    if (journal?.phase === 'enabled') {
      if (!row || row.pm2_env?.status !== 'online') {
        await (deps.ensureSupervisor || ensureProductSupervisor)(root);
        const config = join(root, 'runtime/semantic-ecosystem.json');
        privateJSON(config, { apps: [definition(root, port)] });
        await (deps.reservePort || reserveSemanticPort)(port, async () => {});
        await (deps.supervisorCommand || productSupervisorCommand)(root, [row ? 'restart' : 'start', row ? OWNED_EMBEDDER_PROCESS : config, '--silent']);
      }
      await ready(root, journal, deps);
      return { ok: true, status: 'enabled', homeRoot: root, port, alreadyEnabled: true, semanticReady: true };
    }
    productEnvironment(root, { prepare: true, encoderRequired: true, embedderPort: port });
    const nextState = { ...state, schema: 'home23.host.v2', encoderRequired: true, ports: { ...state.ports, embedder: port },
      semanticExtension: { schema: 'home23.semantic-extension.v1', port, recipeId: OWNED_RECIPE_HASH } };
    const prep = { schema: 'home23.semantic-prep.v1', homeRoot: root, handle: randomUUID(), phase: 'ready', port,
      workerPid: 0, recipeId: OWNED_RECIPE_HASH, updatedAt: new Date().toISOString() };
    const prepFile = { path: 'runtime/semantic-prep.json', before: existsSync(join(root, 'runtime/semantic-prep.json')) ? readFileSync(join(root, 'runtime/semantic-prep.json'), 'utf8') : null,
      after: JSON.stringify(prep, null, 2) + '\n' };
    journal = { schema: SCHEMA, homeRoot: root, port, phase: 'preparing', files: [...files, prepFile,
      { path: '.home23-host.json', before: readFileSync(statePath(root), 'utf8'), after: JSON.stringify(nextState, null, 2) + '\n' }] };
    privateJSON(journalPath(root), journal);
    try {
      const artifacts = await (deps.ensureArtifacts || (await import('../../scripts/embedder/artifacts.mjs')).ensureArtifacts)(embedderCacheDir(root), { fetchIfMissing: true });
      if (!artifacts.ok) fail('host_semantic_artifacts_failed', 'The owned model download or digest verification failed. Retry enable after rollback.');
      await (deps.ensureSupervisor || ensureProductSupervisor)(root);
      const config = join(root, 'runtime/semantic-ecosystem.json');
      privateJSON(config, { apps: [definition(root, port)] });
      journal.phase = 'warming'; privateJSON(journalPath(root), journal);
      // Recheck the port immediately before handing its binding to the service.
      await (deps.reservePort || reserveSemanticPort)(port, async () => {});
      await (deps.supervisorCommand || productSupervisorCommand)(root, ['start', config, '--silent']);
      const checked = await ready(root, journal, deps);
      for (const file of journal.files) if (!sameSnapshot(file, currentText(root, file), file.before))
        fail('host_semantic_config_changed', 'Semantic configuration changed during model preparation. Keep writers stopped and reconcile those edits before disabling.');
      prep.artifactDigests = checked.artifactDigests || artifacts.artifactDigests;
      prepFile.after = JSON.stringify(prep, null, 2) + '\n';
      journal.files.find(file => file.path === prepFile.path).after = prepFile.after;
      // Save final expected bytes before installing them for crash recovery.
      journal.phase = 'configuring'; privateJSON(journalPath(root), journal);
      for (const file of journal.files) {
        if (file.path === prepFile.path) privateJSON(join(root, file.path), prep);
        else atomicText(join(root, file.path), file.after);
      }
      journal.phase = 'enabled'; privateJSON(journalPath(root), journal);
      return { ok: true, status: 'enabled', homeRoot: root, port, provider: OWNED_PROFILE_ID,
        recipeId: OWNED_RECIPE_HASH, semanticReady: true, brainMigrationRequired: true };
    } catch (error) {
      try { await restore(root, journal, deps); }
      catch { journal.phase = 'rollback_required'; privateJSON(journalPath(root), journal);
        fail('host_semantic_rollback_required', 'Semantic enable failed and rollback could not finish. Keep writers stopped and run semantic-disable.'); }
      const knownError = typeof error?.code === 'string' && error.code.startsWith('host_');
      fail(knownError ? error.code : 'host_semantic_enable_failed',
        knownError ? error.message : 'Semantic enable failed. The prior configuration was restored; retry enable.');
    }
  } finally { lock.release(); }
}
