/** One home-scoped schema-preserving update. The journal and recovery Node live outside app/. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, symlinkSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { absoluteHome, privateDirectory, productEnvironment, readPrivateJSON } from './product-environment.js';
import { acquireInstallLock, PRODUCT_STATE_PATHS, readProductManifest, verifyProductPayload } from './product-payload.js';
import { inspectProductInstallation } from './product-update.js';
import { stageProductPayload } from './product-update-stage.js';
import { hashFile, inspectCoordinationDatabase, inspectUpdateInventory, isProductStatePath, isRebuildableStatePath, SUPPORTED_COORDINATION_SCHEMA } from './product-update-inventory.js';

const executeFile = promisify(execFile);
const SCHEMA = 'home23.product-update.v1';
const INSTALL_SCHEMA = 'home23.product-install.v1';
const BUSY = new Set(['online', 'launching', 'errored', 'stopping']);
const RANK = { claimed: 0, quiesced: 1, checkpointed: 2, retained: 3, applying: 4, selected: 5, verifying: 6, writers_admitted: 7, accepted: 8, committed: 9, aborted: 9, rolled_back: 9, recovery_required: 9 };
const LIB_FILES = ['product-environment.js', 'product-payload.js', 'product-update.js', 'product-update-plan.js', 'product-update-inventory.js', 'product-update-stage.js', 'product-update-apply.js', 'product-update-recover.mjs'];
const DATABASE = 'app/instances/.house/coordination/home23-coordination.sqlite3';
const libDirectory = dirname(fileURLToPath(import.meta.url));
const exists = file => { try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const inside = (parent, child) => child === parent || child.startsWith(parent + sep);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Reuse a verify result only until the next fresh check. Fresh checks run after mutation. */
function createPayloadVerifySession(verifyImpl, { enabled = true } = {}) {
  const cache = new Map();
  return function verifyCached(payloadPath, options = {}) {
    const allowRuntimeState = options.allowRuntimeState === true;
    const rest = { allowRuntimeState };
    if (!enabled || options.fresh === true) {
      const manifest = verifyImpl(payloadPath, rest);
      if (enabled) cache.set(`${resolve(payloadPath)}\0${allowRuntimeState ? '1' : '0'}`, manifest);
      return manifest;
    }
    const cacheKey = `${resolve(payloadPath)}\0${allowRuntimeState ? '1' : '0'}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);
    const manifest = verifyImpl(payloadPath, rest);
    cache.set(cacheKey, manifest);
    return manifest;
  };
}
function payloadVerifyFrom(dependencies = {}) {
  return createPayloadVerifySession(dependencies.verifyProductPayload || verifyProductPayload, {
    enabled: dependencies.reusePayloadVerify !== false,
  });
}

export function updateDirectoryFor(homeRoot) {
  const root = absoluteHome(homeRoot);
  return join(dirname(root), `.${basename(root)}.home23-update`);
}
function journalPath(homeRoot) { return join(updateDirectoryFor(homeRoot), 'journal.json'); }
/** Paths for the retained external controller kept beside the journal. */
export function retainedUpdateController(homeRoot) {
  const updateDirectory = updateDirectoryFor(homeRoot);
  return {
    updateDirectory,
    journalPath: journalPath(homeRoot),
    nodePath: join(updateDirectory, 'controller', 'node'),
    recoverEntryPath: join(updateDirectory, 'controller', 'lib', 'product-update-recover.mjs'),
  };
}
function fsyncDirectory(directory) {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableJSON(file, value) {
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeSync(fd, `${JSON.stringify(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, file);
  fsyncDirectory(directory);
}
export function readUpdateJournal(homeRoot) {
  const file = journalPath(homeRoot);
  if (!exists(file)) return null;
  const journal = readPrivateJSON(file);
  const root = absoluteHome(homeRoot);
  if (!journal || journal.schema !== SCHEMA || journal.homeRoot !== root || !Object.hasOwn(RANK, journal.phase)) {
    throw Object.assign(new Error('The update journal is unreadable or belongs to another home.'), { code: 'update_journal_invalid' });
  }
  return journal;
}
/** Normal Start must wait. The update owner may start only after selection, with the journal token. */
export function updateBlocksStart(journal, token) {
  if (!journal || ['committed', 'rolled_back', 'aborted'].includes(journal.phase)) return false;
  return !(token && token === journal.ownerToken && ['selected', 'verifying', 'writers_admitted', 'accepted', 'recovery_required'].includes(journal.phase));
}
function publicResult(journal, extras = {}) {
  const deferred = extras.deferred === true;
  return {
    ok: journal.phase === 'committed' || deferred, status: deferred ? 'deferred' : journal.phase, homeRoot: journal.homeRoot,
    fromPackageId: journal.fromPackageId, toPackageId: journal.toPackageId, desiredRunning: journal.desiredRunning === true,
    resumedRunning: journal.phase === 'committed' && journal.desiredRunning === true && journal.candidateStarted === true,
    acceptedWork: journal.acceptedWork === true, publisherTrust: 'unverified', networkInstall: false, distribution: 'local-untrusted',
    canInstall: false, stateMigration: 'schema_preserving_only', identityPreserved: journal.identityPreserved !== false,
    replayed: extras.replayed === true, recoveryRequired: journal.phase === 'recovery_required',
    runningRestored: journal.runningRestored === true,
    admission: deferred ? 'wait' : undefined, reasons: extras.reasons || journal.reasons || [],
  };
}
function deferred(home, code, message, journal = {}) {
  return { ...publicResult({ ...journal, phase: journal.phase || 'claimed', homeRoot: home }, { deferred: true }), reasons: [{ code, message }] };
}
async function commitPhase(file, journal, dependencies) {
  const next = { ...journal, updatedAt: new Date().toISOString() };
  delete next.startResult;
  durableJSON(file, next);
  if (dependencies.afterPhase) await dependencies.afterPhase(next);
  const interrupt = dependencies.interruptAfter || process.env.HOME23_UPDATE_INTERRUPT_AFTER || '';
  if (interrupt && interrupt === next.phase) process.kill(process.pid, 'SIGKILL');
  return next;
}
function archiveJournal(file, journal) {
  if (exists(file)) renameSync(file, `${file}.${journal.phase}.${journal.id}`);
}
function installController(updateDirectory) {
  const lib = join(updateDirectory, 'controller', 'lib');
  mkdirSync(lib, { recursive: true, mode: 0o700 });
  if (resolve(libDirectory) !== resolve(lib)) {
    for (const name of LIB_FILES) {
      const destination = join(lib, name);
      if (exists(destination)) unlinkSync(destination);
      copyFileSync(join(libDirectory, name), destination, constants.COPYFILE_FICLONE);
      chmodSync(destination, 0o644);
    }
  }
  const nodeDestination = join(updateDirectory, 'controller', 'node');
  if (!exists(nodeDestination)) {
    copyFileSync(realpathSync(process.execPath), nodeDestination, constants.COPYFILE_FICLONE);
    chmodSync(nodeDestination, 0o755);
  }
  fsyncDirectory(join(updateDirectory, 'controller'));
}
function identityFiles(home) {
  const files = new Set();
  function visit(relative) {
    if (!relative || isRebuildableStatePath(relative) || relative === '.home23-install.json' || relative.startsWith('runtime/')) return;
    const absolute = join(home, relative);
    if (!exists(absolute)) return;
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute)) visit(`${relative}/${name}`);
      return;
    }
    if (stat.isFile() && isProductStatePath(relative) && !relative.endsWith('-wal') && !relative.endsWith('-shm')) files.add(relative);
  }
  for (const entry of PRODUCT_STATE_PATHS) visit(entry.path);
  return [...files].sort();
}
function identityMap(home) {
  return Object.fromEntries(identityFiles(home).map(relative => [relative, hashFile(join(home, relative))]));
}
function sameIdentity(home, expected) {
  const current = identityMap(home);
  const keys = Object.keys(expected || {});
  return keys.length === Object.keys(current).length && keys.every(key => current[key] === expected[key]);
}
function isCanonicalState(relative) {
  return relative !== '.home23-host.json' && relative !== 'app/ecosystem.config.cjs' && relative !== DATABASE
    && !relative.endsWith('-wal') && !relative.endsWith('-shm') && !relative.includes('/.house/coordination/');
}
function canonicalFrom(hashes) {
  return Object.fromEntries(Object.entries(hashes || {}).filter(([relative]) => isCanonicalState(relative)));
}
function hostIdentity(home) {
  const state = readPrivateJSON(join(home, '.home23-host.json'));
  if (!state) return null;
  return { homeRoot: state.homeRoot, profile: state.profile, encoderRequired: state.encoderRequired === true, desiredRunning: state.desiredRunning === true };
}
async function sameCanonical(home, journal) {
  const expected = journal.canonical || {};
  const checkpointRoot = join(updateDirectoryFor(home), 'checkpoint', 'state');
  for (const [relative, digest] of Object.entries(expected)) {
    if (relative.includes('/brain/') || relative.includes('/logs/') || relative.includes('/cron-runs/')) continue;
    if (relative.endsWith('/checkpoints/CHECKPOINT_INDEX.json')) continue;
    const currentPath = join(home, relative);
    if (!exists(currentPath) || lstatSync(currentPath).isSymbolicLink()) return false;
    if (relative.includes('/substrate/')) {
      if (relative.endsWith('/birth-receipt.json')) {
        if (hashFile(currentPath) !== digest) return false;
      } else if (relative.endsWith('.jsonl')) {
        const previousPath = join(checkpointRoot, relative);
        if (!exists(previousPath)) return false;
        const previous = readFileSync(previousPath);
        const current = readFileSync(currentPath);
        if (current.length < previous.length || !current.subarray(0, previous.length).equals(previous)) return false;
      }
      continue;
    }
    if (hashFile(currentPath) !== digest) return false;
  }
  const host = hostIdentity(home), saved = journal.hostIdentity;
  if (!host || !saved || host.homeRoot !== saved.homeRoot || host.encoderRequired !== saved.encoderRequired) return false;
  if (JSON.stringify(host.profile) !== JSON.stringify(saved.profile)) return false;
  if (host.desiredRunning !== (journal.desiredRunning === true)) return false;
  if (journal.checkpointDatabase?.present) {
    const database = await inspectCoordinationDatabase(join(home, DATABASE));
    if (!database.compatible || database.version !== journal.checkpointDatabase.version) return false;
  }
  return true;
}
async function defaultListProcesses(home) {
  const node = join(home, 'bin', 'node'), pm2 = join(home, 'tools', 'node_modules', 'pm2', 'bin', 'pm2');
  if (!exists(node) || !exists(pm2)) return [];
  try {
    const { stdout } = await executeFile(node, [pm2, 'jlist', '--silent'], { cwd: join(home, 'app'), env: productEnvironment(home), timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
    if (!String(stdout || '').trim()) return [];
    const rows = JSON.parse(stdout);
    if (!Array.isArray(rows)) throw new Error('invalid inventory');
    return rows.map(row => ({ name: row.name, status: row.pm2_env?.status || 'unknown' }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw Object.assign(new Error('Home process inventory is unavailable. No package files were changed.'), { code: 'process_inventory_unavailable' });
  }
}
async function defaultQuiesce(home, names) {
  const node = join(home, 'bin', 'node'), pm2 = join(home, 'tools', 'node_modules', 'pm2', 'bin', 'pm2'), env = productEnvironment(home);
  for (const name of [...names].reverse()) {
    try { await executeFile(node, [pm2, 'stop', name, '--silent'], { cwd: join(home, 'app'), env, timeout: 240000, maxBuffer: 8 * 1024 * 1024 }); }
    catch { /* An absent name is not a running writer. */ }
  }
  return defaultListProcesses(home);
}
async function defaultStart(home, journal) {
  const { runHostAction } = await import(pathToFileURL(join(home, 'app/cli/lib/product-host.js')).href);
  return runHostAction('start', { homeRoot: home, input: { updateOwnerToken: journal.ownerToken } });
}
async function defaultAcquireHostLock(home, owner) {
  const runtime = privateDirectory(join(home, 'runtime'));
  const lockPath = join(runtime, '.host.lock'), markerPath = join(runtime, '.home23-update-lock.json');
  const claim = () => { mkdirSync(lockPath); durableJSON(markerPath, { pid: process.pid, id: owner.id }); };
  try { claim(); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let marker = null;
    try { marker = readPrivateJSON(markerPath); } catch { marker = null; }
    const fresh = Date.now() - lstatSync(lockPath).mtimeMs < 180000;
    if ((marker && alive(marker.pid) && marker.pid !== process.pid) || (!marker && fresh)) return null;
    rmSync(lockPath, { recursive: true, force: true });
    claim();
  }
  const timer = setInterval(() => { try { utimesSync(lockPath, new Date(), new Date()); } catch { /* The lock is already gone. */ } }, 20000);
  timer.unref();
  return () => { clearInterval(timer); rmSync(lockPath, { recursive: true, force: true }); rmSync(markerPath, { force: true }); };
}
function spaceFor(home, manifest, dependencies) {
  const software = manifest.files.filter(entry => entry.type === 'file').reduce((sum, entry) => sum + BigInt(entry.size), 0n);
  const checkpoint = identityFiles(home).reduce((sum, relative) => sum + BigInt(lstatSync(join(home, relative)).size), 0n);
  const space = (dependencies.statfs || statfsSync)(dirname(home), dependencies.statfs ? undefined : { bigint: true });
  return space.bavail * space.bsize >= software + checkpoint + 64n * 1024n * 1024n;
}
function durableCopy(source, destination, mode) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  const temporary = `${destination}.${randomUUID()}.next`;
  copyFileSync(source, temporary, constants.COPYFILE_FICLONE);
  chmodSync(temporary, mode);
  const fd = openSync(temporary, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, destination);
}
function payloadMatches(root, manifest) {
  for (const entry of manifest.files) {
    const file = join(root, entry.path);
    if (!exists(file)) return false;
    if (entry.type === 'directory') {
      const stat = lstatSync(file);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== entry.mode) return false;
    } else if (entry.type === 'symlink') {
      if (!lstatSync(file).isSymbolicLink() || readlinkSync(file) !== entry.target) return false;
    } else if (hashFile(file) !== entry.sha256 || (lstatSync(file).mode & 0o777) !== entry.mode) return false;
  }
  return true;
}
async function writeCheckpoint(home, updateDirectory) {
  const checkpoint = join(updateDirectory, 'checkpoint');
  rmSync(checkpoint, { recursive: true, force: true });
  mkdirSync(checkpoint, { recursive: true, mode: 0o700 });
  const hashes = {};
  for (const relative of identityFiles(home)) {
    if (relative === DATABASE) continue;
    const source = join(home, relative), before = hashFile(source), destination = join(checkpoint, 'state', relative);
    durableCopy(source, destination, lstatSync(source).mode & 0o777);
    if (hashFile(source) !== before || hashFile(destination) !== before) throw new Error(`State changed while checkpointing ${relative}.`);
    hashes[relative] = before;
  }
  let database = { present: false };
  if (exists(join(home, DATABASE))) {
    const destination = join(checkpoint, 'coordination.sqlite3');
    const { DatabaseSync } = await import('node:sqlite');
    const source = new DatabaseSync(join(home, DATABASE));
    try { source.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); }
    finally { source.close(); }
    const copy = new DatabaseSync(destination, { readOnly: true });
    try {
      const integrity = copy.prepare('PRAGMA integrity_check').get().integrity_check;
      const version = Number(copy.prepare('PRAGMA user_version').get().user_version);
      if (integrity !== 'ok' || version !== SUPPORTED_COORDINATION_SCHEMA) throw new Error('Coordination checkpoint failed integrity or version verification.');
      database = { present: true, version, integrity, sha256: hashFile(destination) };
    } finally { copy.close(); }
    hashes[DATABASE] = hashFile(join(home, DATABASE));
  }
  fsyncDirectory(checkpoint);
  return { hashes, database };
}
function retainPrevious(home, updateDirectory, manifest) {
  const previous = join(updateDirectory, 'previous');
  rmSync(previous, { recursive: true, force: true });
  mkdirSync(previous, { recursive: true, mode: 0o700 });
  for (const entry of manifest.files) {
    if (entry.type === 'directory') { mkdirSync(join(previous, entry.path), { recursive: true, mode: entry.mode }); continue; }
    if (entry.type === 'symlink') { symlinkSync(entry.target, join(previous, entry.path)); continue; }
    durableCopy(join(home, entry.path), join(previous, entry.path), entry.mode);
  }
  durableCopy(join(home, 'manifest.json'), join(previous, 'manifest.json'), 0o644);
  durableCopy(join(home, '.home23-install.json'), join(previous, '.home23-install.json'), 0o600);
  if (!payloadMatches(previous, manifest)) throw new Error('Retained previous software does not match the installed manifest.');
  fsyncDirectory(previous);
}
function applyPackage(home, staged, previousManifest, verify) {
  const manifest = verify(staged, { fresh: true });
  const nextPaths = new Set(manifest.files.map(entry => entry.path));
  for (const entry of manifest.files.filter(item => item.type === 'directory').sort((left, right) => left.path.split('/').length - right.path.split('/').length)) {
    if (isProductStatePath(entry.path)) continue;
    mkdirSync(join(home, entry.path), { recursive: true, mode: entry.mode });
    chmodSync(join(home, entry.path), entry.mode);
  }
  for (const entry of manifest.files.filter(item => item.type === 'file')) {
    const destination = join(home, entry.path);
    if (isProductStatePath(entry.path)) {
      // Packaged .gitkeep markers keep empty state directories in the manifest.
      // They must not replace a home's real files or abort selection.
      if (entry.path.endsWith('/.gitkeep') && !exists(destination)) durableCopy(join(staged, entry.path), destination, entry.mode);
      else if (!entry.path.endsWith('/.gitkeep')) throw new Error(`Candidate contains home state: ${entry.path}`);
      continue;
    }
    if (exists(destination) && lstatSync(destination).isFile() && hashFile(destination) === entry.sha256 && (lstatSync(destination).mode & 0o777) === entry.mode) continue;
    durableCopy(join(staged, entry.path), destination, entry.mode);
  }
  for (const entry of manifest.files.filter(item => item.type === 'symlink')) {
    const destination = join(home, entry.path);
    if (exists(destination) && lstatSync(destination).isSymbolicLink() && readlinkSync(destination) === entry.target) continue;
    if (exists(destination)) unlinkSync(destination);
    symlinkSync(entry.target, destination);
  }
  for (const entry of previousManifest.files.filter(item => item.type === 'file' && !nextPaths.has(item.path) && !isProductStatePath(item.path))) {
    const destination = join(home, entry.path);
    if (exists(destination) && lstatSync(destination).isFile()) unlinkSync(destination);
  }
  durableCopy(join(staged, 'manifest.json'), join(home, 'manifest.json'), 0o644);
  durableJSON(join(home, '.home23-install.json'), { schema: INSTALL_SCHEMA, status: 'installed', homeRoot: home, appRoot: join(home, 'app'),
    nodePath: join(home, 'bin', 'node'), pm2Path: join(home, 'tools', 'node_modules', 'pm2', 'bin', 'pm2'),
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit, replayed: false });
  fsyncDirectory(home);
  if (verify(home, { allowRuntimeState: true, fresh: true }).packageId !== manifest.packageId) throw new Error('Selected package does not match the staged candidate.');
  return manifest;
}
function restorePrevious(home, updateDirectory, previousManifest, candidateManifest, verify) {
  const previous = join(updateDirectory, 'previous');
  if (!payloadMatches(previous, previousManifest)) throw Object.assign(new Error('Retained previous software no longer matches its manifest.'), { code: 'rollback_unverified' });
  const previousPaths = new Set(previousManifest.files.map(entry => entry.path));
  for (const relative of candidateManifest.files.map(entry => entry.path)) {
    if (previousPaths.has(relative) || isProductStatePath(relative)) continue;
    const destination = join(home, relative);
    if (exists(destination) && lstatSync(destination).isFile()) unlinkSync(destination);
  }
  for (const entry of previousManifest.files) {
    if (isProductStatePath(entry.path)) continue;
    if (entry.type === 'directory') { mkdirSync(join(home, entry.path), { recursive: true, mode: entry.mode }); chmodSync(join(home, entry.path), entry.mode); continue; }
    if (entry.type === 'symlink') {
      const destination = join(home, entry.path);
      if (exists(destination)) unlinkSync(destination);
      symlinkSync(entry.target, destination);
      continue;
    }
    durableCopy(join(previous, entry.path), join(home, entry.path), entry.mode);
  }
  durableCopy(join(previous, 'manifest.json'), join(home, 'manifest.json'), 0o644);
  durableCopy(join(previous, '.home23-install.json'), join(home, '.home23-install.json'), 0o600);
  fsyncDirectory(home);
  if (verify(home, { allowRuntimeState: true, fresh: true }).packageId !== previousManifest.packageId) throw new Error('Rollback did not restore the previous package.');
}
function classifyProcesses(processes, names) {
  const known = new Set(names);
  const busy = processes.filter(row => BUSY.has(row.status));
  return { busy, unknown: busy.filter(row => !known.has(row.name)) };
}
function previousManifest(home) {
  return JSON.parse(readFileSync(join(updateDirectoryFor(home), 'previous', 'manifest.json'), 'utf8'));
}
function refuse(home, reasons) {
  return { ok: false, status: 'refused', homeRoot: home, canInstall: false, publisherTrust: 'unverified', networkInstall: false, distribution: 'local-untrusted', stateMigration: 'schema_preserving_only', reasons };
}
function defaultBehavior({ home, journal, identityPreserved, verify }) {
  const issues = [];
  try {
    if (verify(home, { allowRuntimeState: true, fresh: true }).packageId !== journal.toPackageId) issues.push('The running tree is not the selected package.');
    const receipt = readPrivateJSON(join(home, '.home23-install.json'));
    if (receipt?.packageId !== journal.toPackageId || receipt?.nodePath !== join(home, 'bin', 'node')) issues.push('The installation receipt does not name the selected package.');
  } catch { issues.push('The selected installation no longer verifies.'); }
  if (!identityPreserved) issues.push(journal.writersAdmitted ? 'Canonical home identity changed after the candidate started.' : 'Home identity files changed during the update.');
  if (journal.desiredRunning && journal.startOk === false) issues.push('Candidate start failed.');
  if (process.env.HOME23_UPDATE_VERIFY_RESULT === 'fail') issues.push('Candidate health was forced to fail.');
  if (!journal.writersAdmitted && journal.identity?.[DATABASE] && exists(join(home, DATABASE)) && hashFile(join(home, DATABASE)) !== journal.identity[DATABASE]) issues.push('The coordination database changed after the checkpoint.');
  return { ok: issues.length === 0, issues };
}

async function mutate(journal, dependencies, verify) {
  const file = journalPath(journal.homeRoot), home = journal.homeRoot;
  const rank = () => RANK[journal.phase];
  const names = journal.writerNames || [];
  if (rank() < RANK.quiesced) {
    let processes = await (dependencies.listProcesses || defaultListProcesses)(home);
    let classified = classifyProcesses(processes, names);
    if (classified.unknown.length) return { done: deferred(home, 'unknown_writer', 'An unexpected process is using this home. Wait for it to exit before updating.', journal) };
    if (classified.busy.length) {
      if (!journal.admit) return { done: deferred(home, 'busy', 'This home is still working. Retry when it is quiet, or explicitly admit maintenance. Nothing was forced to stop.', journal) };
      processes = await (dependencies.quiesce || defaultQuiesce)(home, names);
      classified = classifyProcesses(processes, names);
      if (classified.busy.length) return { done: deferred(home, 'busy', 'Writers are still active after a graceful stop. Wait and resume. They were not force-killed.', journal) };
      journal.stoppedForUpdate = true;
    }
    journal = await commitPhase(file, { ...journal, phase: 'quiesced' }, dependencies);
  }
  if (rank() < RANK.checkpointed) {
    const database = exists(join(home, DATABASE)) ? await inspectCoordinationDatabase(join(home, DATABASE)) : { present: false, compatible: true };
    if (database.present && !database.compatible) {
      journal = await commitPhase(file, { ...journal, phase: 'aborted', reasons: [{ code: 'unsupported_data_version', message: 'The stored schema changed after the preflight. Package files were not replaced.' }] }, dependencies);
      return { done: publicResult(journal) };
    }
    const checkpoint = await (dependencies.writeCheckpoint || writeCheckpoint)(home, updateDirectoryFor(home));
    journal = await commitPhase(file, { ...journal, phase: 'checkpointed', identity: checkpoint.hashes, canonical: canonicalFrom(checkpoint.hashes), hostIdentity: hostIdentity(home), checkpointDatabase: checkpoint.database }, dependencies);
  }
  if (rank() < RANK.retained) {
    const installed = readProductManifest(home);
    if (installed.packageId !== journal.fromPackageId) {
      journal = await commitPhase(file, { ...journal, phase: 'recovery_required', reasons: [{ code: 'baseline_changed', message: 'The installed package changed before selection. Automatic recovery stopped.' }] }, dependencies);
      return { done: publicResult(journal) };
    }
    (dependencies.retainPrevious || retainPrevious)(home, updateDirectoryFor(home), installed);
    journal = await commitPhase(file, { ...journal, phase: 'retained' }, dependencies);
  }
  if (rank() < RANK.applying) journal = await commitPhase(file, { ...journal, phase: 'applying' }, dependencies);
  if (rank() < RANK.selected) {
    applyPackage(home, journal.stagedPayload, previousManifest(home), verify);
    journal = await commitPhase(file, { ...journal, phase: 'selected', acceptedWork: false }, dependencies);
  }
  return { journal };
}
async function finish(journal, dependencies, verify) {
  const file = journalPath(journal.homeRoot), home = journal.homeRoot;
  if (['committed', 'rolled_back', 'aborted'].includes(journal.phase)) return publicResult(journal, { replayed: true });
  if (journal.phase === 'recovery_required' && !journal.writersAdmitted) return publicResult(journal, { replayed: true });
  const list = dependencies.listProcesses || defaultListProcesses;
  const busy = async () => classifyProcesses(await list(home), journal.writerNames || []).busy.length > 0;
  const fence = async () => {
    if (!(await busy())) return true;
    await (dependencies.quiesce || defaultQuiesce)(home, journal.writerNames || []);
    return !(await busy());
  };
  async function rollback(reason) {
    if (journal.writersAdmitted || journal.acceptedWork || !(await fence())) {
      journal = await commitPhase(file, { ...journal, phase: 'recovery_required', reasons: [{ code: 'recovery_required', message: 'Software was not restored because writers were admitted or could not be fenced. The data snapshot was not restored.' }] }, dependencies);
      return publicResult(journal);
    }
    try {
      if (dependencies.restorePrevious) dependencies.restorePrevious(home, updateDirectoryFor(home), previousManifest(home), readProductManifest(journal.stagedPayload));
      else restorePrevious(home, updateDirectoryFor(home), previousManifest(home), readProductManifest(journal.stagedPayload), verify);
    }
    catch (error) {
      journal = await commitPhase(file, { ...journal, phase: 'recovery_required', reasons: [{ code: 'recovery_required', message: `No safe automatic rollback is available (${error.message}). Home state was not replaced from the checkpoint.` }] }, dependencies);
      return publicResult(journal);
    }
    const preserved = sameIdentity(home, journal.identity);
    let restoredRunning = false;
    if (journal.desiredRunning) {
      try { restoredRunning = (await (dependencies.start || defaultStart)(home, journal))?.ok !== false; }
      catch { restoredRunning = false; }
      if (!restoredRunning) {
        journal = await commitPhase(file, { ...journal, phase: 'recovery_required', identityPreserved: preserved, reasons: [{ code: 'recovery_required', message: 'Previous software was restored, but the home did not return to its desired running state.' }] }, dependencies);
        return publicResult(journal);
      }
    }
    journal = await commitPhase(file, { ...journal, phase: 'rolled_back', identityPreserved: preserved, runningRestored: restoredRunning, reasons: [{ code: 'candidate_unhealthy', message: reason }] }, dependencies);
    return publicResult(journal);
  }
  if (!journal.writersAdmitted && !journal.acceptedWork) {
    const release = await (dependencies.acquireHostLock || defaultAcquireHostLock)(home, journal);
    if (release === null) return deferred(home, 'busy', 'Another lifecycle operation holds this home.', journal);
    let rollbackReason = null;
    try {
      if (await busy()) {
        journal = await commitPhase(file, { ...journal, phase: 'recovery_required', reasons: [{ code: 'recovery_required', message: 'Writers are active before the candidate was admitted. They were not replaced or force-killed.' }] }, dependencies);
        return publicResult(journal);
      }
      if (!sameIdentity(home, journal.identity)) {
        journal = await commitPhase(file, { ...journal, phase: 'recovery_required', identityPreserved: false, reasons: [{ code: 'recovery_required', message: 'Quiesced home identity changed before writers were admitted. Software and the data snapshot were not restored.' }] }, dependencies);
        return publicResult(journal);
      }
      let packageOk = true;
      try { if (verify(home, { allowRuntimeState: true, fresh: true }).packageId !== journal.toPackageId) packageOk = false; }
      catch { packageOk = false; }
      if (!packageOk) rollbackReason = 'The selected package did not verify while writers were still fenced.';
      else if (journal.desiredRunning) journal = await commitPhase(file, { ...journal, writersAdmitted: true, acceptedWork: true, phase: 'writers_admitted' }, dependencies);
    } finally { if (release) await release(); }
    if (rollbackReason) return rollback(rollbackReason);
    if (['recovery_required', 'rolled_back'].includes(journal.phase)) return publicResult(journal);
  }
  if (journal.desiredRunning && !(await busy())) {
    // The installed Host allows this owner token only for an admitted phase.
    // Persist that phase before Start so the gate and the journal agree.
    journal = await commitPhase(file, { ...journal, writersAdmitted: true, acceptedWork: true, phase: 'writers_admitted' }, dependencies);
    let startOk = false;
    try { startOk = (await (dependencies.start || defaultStart)(home, journal))?.ok !== false; }
    catch { startOk = false; }
    journal = await commitPhase(file, { ...journal, candidateStarted: true, startOk, phase: 'writers_admitted' }, dependencies);
  }
  let identityPreserved = journal.writersAdmitted ? await sameCanonical(home, journal) : sameIdentity(home, journal.identity);
  if (journal.writersAdmitted && !identityPreserved) {
    await fence();
    identityPreserved = await sameCanonical(home, journal);
    if (identityPreserved && journal.desiredRunning && !(await busy())) {
      try { journal.startOk = (await (dependencies.start || defaultStart)(home, journal))?.ok !== false; }
      catch { journal.startOk = false; }
      journal = await commitPhase(file, { ...journal, candidateStarted: true, startOk: journal.startOk, phase: 'writers_admitted' }, dependencies);
    }
  }
  const behavior = dependencies.verifyBehavior ? await dependencies.verifyBehavior({ home, journal, identityPreserved }) : defaultBehavior({ home, journal, identityPreserved, verify });
  if (!behavior.ok || !identityPreserved) {
    if (journal.writersAdmitted || journal.acceptedWork) {
      const fenced = await fence();
      journal = await commitPhase(file, { ...journal, phase: 'recovery_required', identityPreserved, reasons: [{ code: 'recovery_required', message: fenced ? 'The candidate started and a later check failed. Writers were fenced. Previous software and the data snapshot were not restored.' : 'The candidate started and writers could not be fenced. Previous software and the data snapshot were not restored.' }] }, dependencies);
      return publicResult(journal);
    }
    return rollback(behavior.issues?.[0] || 'The candidate did not become healthy. Previous software was restored and home state was left in place.');
  }
  if (RANK[journal.phase] < RANK.accepted) journal = await commitPhase(file, { ...journal, phase: 'accepted', acceptedWork: true, identityPreserved }, dependencies);
  journal = await commitPhase(file, { ...journal, phase: 'committed', acceptedWork: true, writersAdmitted: journal.writersAdmitted === true, identityPreserved }, dependencies);
  return publicResult(journal);
}
async function runTransaction(journal, dependencies, verify) {
  if (['committed', 'rolled_back', 'aborted'].includes(journal.phase)) return publicResult(journal, { replayed: true });
  if (journal.phase === 'recovery_required' && !journal.writersAdmitted) return publicResult(journal, { replayed: true });
  let releaseHost = async () => {};
  if (RANK[journal.phase] < RANK.verifying) {
    const acquired = await (dependencies.acquireHostLock || defaultAcquireHostLock)(journal.homeRoot, journal);
    if (acquired === null) return deferred(journal.homeRoot, 'busy', 'Another lifecycle operation holds this home.', journal);
    releaseHost = acquired;
    try {
      const mutated = await mutate(journal, dependencies, verify);
      if (mutated.done) return mutated.done;
      journal = mutated.journal;
    } finally { await releaseHost(); }
  } else journal = readUpdateJournal(journal.homeRoot);
  if (['aborted', 'rolled_back'].includes(journal.phase) || (journal.phase === 'recovery_required' && !journal.writersAdmitted)) return publicResult(journal);
  return finish(journal, dependencies, verify);
}

async function openTransaction({ home, candidate, staging, admit }, dependencies, verify) {
  const installation = inspectProductInstallation(home);
  if (installation.layout !== 'product') return refuse(home, installation.reasons.length ? installation.reasons : [{ code: 'unsupported_layout', message: 'The current home is not an owned product installation.' }]);
  if (installation.reasons.some(item => item.code !== 'modified_installation')) return refuse(home, installation.reasons);
  let candidateManifest;
  try { candidateManifest = verify(candidate); }
  catch { return refuse(home, [{ code: 'candidate_integrity_failed', message: 'The candidate package failed its integrity checks.' }]); }
  const installed = readProductManifest(home);
  if (installed.packageId === candidateManifest.packageId) return refuse(home, [{ code: 'same_package', message: 'The candidate is the package already installed.' }]);
  const inventory = await inspectUpdateInventory(home, { installed, candidate: candidateManifest });
  const blocking = inventory.reasons.filter(item => item.code !== 'database_busy');
  if (blocking.length) return refuse(home, blocking);
  try { verify(home, { allowRuntimeState: true }); }
  catch { return refuse(home, [{ code: 'modified_installation', message: 'A declared installed file, mode, link, or layout has changed.' }]); }
  let processes;
  try { processes = await (dependencies.listProcesses || defaultListProcesses)(home); }
  catch (error) { return refuse(home, [{ code: error.code || 'process_inventory_unavailable', message: error.message }]); }
  const classified = classifyProcesses(processes, inventory.writers);
  if (classified.unknown.length) return deferred(home, 'unknown_writer', 'An unexpected process is using this home. Wait for it to exit before updating.');
  if ((classified.busy.length || inventory.reasons.some(item => item.code === 'database_busy')) && !admit) {
    return deferred(home, 'busy', 'This home is still working. Stage can continue, but installation waits until work is quiet or maintenance is explicitly admitted.', { desiredRunning: inventory.desiredRunning });
  }
  if (inventory.reasons.some(item => item.code === 'database_busy') && !classified.busy.length) {
    return deferred(home, 'database_busy', 'The coordination database is busy and no owned writer explains it. Wait, then retry. Nothing was changed.');
  }
  if (!spaceFor(home, installed, dependencies)) return refuse(home, [{ code: 'insufficient_space', message: 'Not enough free space for the previous software, the verified checkpoint, and 64 MiB of headroom.' }]);
  const staged = stageProductPayload({ homeRoot: home, candidatePayload: candidate, staging, verifyProductPayload: verify });
  if (verify(staged.payloadPath).packageId !== candidateManifest.packageId) return refuse(home, [{ code: 'candidate_integrity_failed', message: 'The staged candidate changed identity.' }]);
  const updateDirectory = updateDirectoryFor(home);
  mkdirSync(updateDirectory, { recursive: true, mode: 0o700 });
  installController(updateDirectory);
  const journal = await commitPhase(journalPath(home), { schema: SCHEMA, id: randomUUID(), homeRoot: home, staging, stagedPayload: staged.payloadPath,
    fromPackageId: installed.packageId, toPackageId: candidateManifest.packageId, fromSourceCommit: installed.sourceCommit,
    toSourceCommit: candidateManifest.sourceCommit, desiredRunning: inventory.desiredRunning, admit: admit === true,
    writerNames: inventory.writers, ownerToken: randomUUID(), phase: 'claimed', acceptedWork: false, candidateStarted: false,
    networkInstall: false, createdAt: new Date().toISOString() }, dependencies);
  return runTransaction(journal, dependencies, verify);
}

async function locked(home, dependencies, body) {
  const releaseUpdate = acquireInstallLock(`${updateDirectoryFor(home)}.lock`);
  try { return await body(); }
  finally { releaseUpdate(); }
}
export async function resumeProductUpdate({ homeRoot } = {}, dependencies = {}) {
  const home = absoluteHome(homeRoot);
  const verify = payloadVerifyFrom(dependencies);
  return locked(home, dependencies, async () => {
    const journal = readUpdateJournal(home);
    if (!journal) return refuse(home, [{ code: 'update_not_found', message: 'This home has no update journal to resume.' }]);
    return runTransaction(journal, dependencies, verify);
  });
}
export async function applyProductUpdate({ homeRoot, candidatePayload, staging, admit = false } = {}, dependencies = {}) {
  const home = absoluteHome(homeRoot);
  if (typeof candidatePayload !== 'string' || typeof staging !== 'string') throw new Error('Choose absolute candidate and staging directories.');
  const candidate = absoluteHome(candidatePayload), stageRoot = absoluteHome(staging), updateDirectory = updateDirectoryFor(home);
  for (const [left, right] of [[home, candidate], [home, stageRoot], [candidate, stageRoot], [home, updateDirectory]]) {
    if (inside(left, right) || inside(right, left)) throw new Error('Home, candidate, staging, and the update journal must be separate directories.');
  }
  const verify = payloadVerifyFrom(dependencies);
  return locked(home, dependencies, async () => {
    const existing = exists(journalPath(home)) ? readUpdateJournal(home) : null;
    let candidateId = null;
    try { candidateId = verify(candidate).packageId; }
    catch { return refuse(home, [{ code: 'candidate_integrity_failed', message: 'The candidate package failed its integrity checks.' }]); }
    if (existing && !['committed', 'rolled_back', 'aborted'].includes(existing.phase)) {
      if (existing.toPackageId !== candidateId) return refuse(home, [{ code: 'update_in_progress', message: 'An unfinished update belongs to another candidate. Resume that journal before starting a different one.' }]);
      return runTransaction(existing, dependencies, verify);
    }
    if (existing?.phase === 'committed' && existing.toPackageId === candidateId) return publicResult(existing, { replayed: true });
    if (existing) archiveJournal(journalPath(home), existing);
    return openTransaction({ home, candidate, staging: stageRoot, admit }, dependencies, verify);
  });
}
