/** One home-scoped schema-preserving update. The journal and recovery Node live outside app/. */
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, copyFileSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statfsSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { absoluteHome, privateDirectory, productEnvironment, readPrivateJSON } from './product-environment.js';
import { acquireInstallLock, PRODUCT_STATE_PATHS, readProductManifest, verifyProductPayload } from './product-payload.js';
import { inspectProductInstallation } from './product-update-preview.js';
import { adoptVerifiedStage, stageLockPath, stageProductPayload } from './product-update-stage.js';
import { candidateCoordinationSchema, hashFile, inspectCoordinationDatabase, inspectUpdateInventory, isProductStatePath, isRebuildableStatePath } from './product-update-inventory.js';

const executeFile = promisify(execFile);
const SCHEMA = 'home23.product-update.v1';
const INSTALL_SCHEMA = 'home23.product-install.v1';
const BUSY = new Set(['online', 'launching', 'errored', 'stopping']);
const RANK = { claimed: 0, quiesced: 1, checkpointed: 2, retained: 3, applying: 4, selected: 5, verifying: 6, writers_admitted: 7, accepted: 8, committed: 9, aborted: 9, rolled_back: 9, recovery_required: 9 };
const LIB_FILES = ['product-environment.js', 'product-payload.js', 'product-update-preview.js', 'product-update-plan.js', 'product-update-inventory.js', 'product-update-stage.js', 'product-update-apply.js', 'product-update-recover.mjs'];
const DATABASE = 'app/instances/.house/coordination/home23-coordination.sqlite3';
const CHECKPOINT_COPIES = 4;
// Home state and every directory above it stay in place during a version switch.
// Everything else in a package is software and moves as whole subtrees.
const MIXED_DIRECTORIES = new Set(['', ...PRODUCT_STATE_PATHS.flatMap(({ path, type }) => path.split('/').slice(0, type === 'directory' ? undefined : -1)
  .map((_, index, parts) => parts.slice(0, index + 1).join('/')))]);
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
/** Set-aside software trees are garbage once a result is durable. Removing tens of
 * thousands of files must not hold the update open, so it continues detached. */
function releaseDiscarded(updateDirectory, dependencies) {
  let names = [];
  try { names = readdirSync(updateDirectory).filter(name => name.startsWith('discarded-')); } catch { return; }
  if (!names.length) return;
  const paths = names.map(name => join(updateDirectory, name));
  if (dependencies.removeDiscarded) { dependencies.removeDiscarded(paths); return; }
  const child = spawn('/bin/rm', ['-rf', '--', ...paths], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
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
    // Pre-admission sameIdentity checked every saved state file while writers
    // were stopped. Once they run, conversations, cron ownership, Work,
    // settings, credentials, and workspace files may legitimately change.
    // Keep only immutable Seed birth identity and the receipted ledger prefix.
    if (!relative.includes('/substrate/') ||
      !(relative.endsWith('/birth-receipt.json') || relative.endsWith('.jsonl'))) continue;
    const currentPath = join(home, relative);
    if (!exists(currentPath) || lstatSync(currentPath).isSymbolicLink()) return false;
    if (relative.endsWith('/birth-receipt.json')) {
      if (hashFile(currentPath) !== digest) return false;
      continue;
    }
    let prefix = journal.substratePrefixes?.[relative];
    if (journal.stateRetention === 'in_place') {
      if (!prefix || prefix.sha256 !== digest || !Number.isSafeInteger(prefix.bytes) || prefix.bytes < 0) return false;
    } else {
      // Older checkpointed journals recorded the digest but kept the
      // prefix length only in their copied file. Verify that old copy.
      const previousPath = join(checkpointRoot, relative);
      if (!exists(previousPath)) return false;
      try {
        safeCheckpointDirectory(checkpointRoot, dirname(relative));
        prefix = await checkpointFingerprint(previousPath);
      } catch { return false; }
      if (prefix.sha256 !== digest) return false;
    }
    try {
      if ((await checkpointFingerprint(currentPath, { source: true, bytes: prefix.bytes })).sha256 !== digest) return false;
    } catch { return false; }
  }
  const host = hostIdentity(home), saved = journal.hostIdentity;
  if (!host || !saved || host.homeRoot !== saved.homeRoot || host.encoderRequired !== saved.encoderRequired) return false;
  if (JSON.stringify(host.profile) !== JSON.stringify(saved.profile)) return false;
  if (host.desiredRunning !== (journal.desiredRunning === true)) return false;
  // The admitted Core owns database integrity and readiness. A second external
  // quick_check can block its live SQLite connection during cold startup.
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
async function defaultStatus(home) {
  const { runHostAction } = await import(pathToFileURL(join(home, 'app/cli/lib/product-host.js')).href);
  return runHostAction('status', { homeRoot: home });
}
function startObservation(result, error) {
  const status = typeof result?.status === 'string' && /^[a-z_]{1,40}$/.test(result.status) ? result.status : null;
  const code = result?.error?.code || error?.code;
  const errorCode = typeof code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(code) ? code : null;
  const maskedReady = status === 'recovery_required' && errorCode === 'update_recovery_required' && result?.readiness?.ready === true;
  const startOk = !error && (result?.ok !== false || maskedReady) &&
    (result?.readiness?.ready === true || status === 'ready' || status === null);
  return { startOk, startStatus: startOk ? 'ready' : status, startErrorCode: startOk ? null : errorCode };
}
function candidateStatusKind(result) {
  const processes = Array.isArray(result?.processes) ? result.processes : [];
  const missingOwned = Array.isArray(result?.readiness?.issues) && result.readiness.issues.some(issue =>
    typeof issue === 'string' && issue.endsWith(' is not running from this installation.'));
  const failed = missingOwned || processes.some(row => row?.owned === false || !['online', 'launching'].includes(row?.status));
  const masked = result?.status === 'recovery_required' && result?.error?.code === 'update_recovery_required';
  if (processes.length && !failed && (result?.ok !== false || masked) && (result?.readiness?.ready === true || result?.status === 'ready')) return 'ready';
  if (processes.length && !failed && (result?.ok !== false || masked) && result?.readiness?.recoveryRequired !== true &&
      (result?.status === 'starting' || (result?.readiness?.ready === false && processes.some(row => row.status === 'online' || row.status === 'launching')))) return 'starting';
  return 'failed';
}
function healthyAdmittedWriters(rows, writerNames) {
  const known = new Set(writerNames || []);
  const owned = Array.isArray(rows) ? rows.filter(row => known.has(row.name)) : [];
  return owned.length > 0 && owned.every(row => ['online', 'launching'].includes(row.status)) &&
    !rows.some(row => BUSY.has(row.status) && !known.has(row.name));
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
function spaceFor(home, dependencies) {
  // Both software versions already occupy this volume: the current home and
  // the completed stage. Selection renames their units; it does not duplicate
  // the installed tree. Lived state remains in place; only SQLite is copied.
  // Include uncheckpointed WAL pages, which VACUUM may fold into the backup.
  const database = join(home, DATABASE);
  const checkpoint = [database, `${database}-wal`].reduce((bytes, file) =>
    bytes + (exists(file) ? BigInt(lstatSync(file).size) : 0n), 0n);
  const space = (dependencies.statfs || statfsSync)(dirname(home), dependencies.statfs ? undefined : { bigint: true });
  return space.bavail * space.bsize >= checkpoint + 64n * 1024n * 1024n;
}
function durableCopy(source, destination, mode) {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o755 });
  const temporary = `${destination}.${randomUUID()}.next`;
  copyFileSync(source, temporary, constants.COPYFILE_FICLONE);
  chmodSync(temporary, mode);
  // The checkpoint retains source modes, including read-only 0400 files.
  // fsync accepts a read descriptor; reopening for write would fail here.
  const fd = openSync(temporary, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, destination);
}
function regularCheckpointFile(file, { source = false } = {}) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (!source && stat.nlink !== 1)) throw new Error(`Unsafe checkpoint file: ${file}`);
  return stat;
}
function safeCheckpointDirectory(root, relative = '', create = false) {
  let directory = root;
  if (!lstatSync(directory).isDirectory()) throw new Error(`Unsafe checkpoint directory: ${directory}`);
  for (const part of relative.split('/').filter(Boolean)) {
    directory = join(directory, part);
    if (!exists(directory) && create) mkdirSync(directory, { mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error(`Unsafe checkpoint directory: ${directory}`);
  }
  return directory;
}
async function checkpointFingerprint(file, { source = false, bytes = null } = {}) {
  const descriptor = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await descriptor.stat();
    if (!stat.isFile() || (!source && stat.nlink !== 1)) throw new Error(`Unsafe checkpoint file: ${file}`);
    const length = bytes ?? stat.size;
    if (!Number.isSafeInteger(length) || length < 0 || stat.size < length) throw new Error(`Checkpoint prefix is unavailable: ${file}`);
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, length)));
    for (let position = 0; position < length;) {
      const { bytesRead } = await descriptor.read(buffer, 0, Math.min(buffer.length, length - position), position);
      if (!bytesRead) throw new Error(`Checkpoint file changed while hashing: ${file}`);
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await descriptor.stat();
    if (after.dev !== stat.dev || after.ino !== stat.ino || (after.mode & 0o777) !== (stat.mode & 0o777) ||
        (bytes === null ? after.size !== stat.size : after.size < length)) {
      throw new Error(`Checkpoint file changed while hashing: ${file}`);
    }
    return { sha256: digest.digest('hex'), bytes: length, mode: stat.mode & 0o777, dev: stat.dev, ino: stat.ino };
  } finally { await descriptor.close(); }
}
async function checkpointStateFile(home, relative, beforeCopy) {
  const source = join(home, relative);
  // Inventory authenticates approved source parent links. The source leaf is
  // regular and read twice; no lived state is copied or modified.
  regularCheckpointFile(source, { source: true });
  if (beforeCopy) await beforeCopy(relative);
  const before = await checkpointFingerprint(source, { source: true });
  const after = await checkpointFingerprint(source, { source: true });
  if (before.sha256 !== after.sha256 || before.bytes !== after.bytes || before.mode !== after.mode ||
      before.dev !== after.dev || before.ino !== after.ino) throw new Error(`State changed while checkpointing ${relative}.`);
  return { sha256: before.sha256, bytes: before.bytes };
}
async function checkpointPool(items, operation) {
  let next = 0;
  let failure = null;
  const results = new Array(items.length);
  const workers = Array.from({ length: Math.min(CHECKPOINT_COPIES, items.length) }, async () => {
    for (;;) {
      if (failure) return;
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await operation(items[index]); }
      catch (error) { failure ||= error; return; }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}
function payloadMatchesAt(entries, rootOf) {
  for (const entry of entries) {
    const file = join(rootOf(entry), entry.path);
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
async function writeCheckpoint(home, updateDirectory, _journalId, { beforeCopy, expectedSchemaVersion } = {}) {
  safeCheckpointDirectory(updateDirectory);
  const checkpoint = join(updateDirectory, 'checkpoint');
  // A quiesced journal may contain a partial copied checkpoint from the old
  // controller. Leave those files and its marker untouched on resume.
  if (!exists(checkpoint)) mkdirSync(checkpoint, { mode: 0o700 });
  safeCheckpointDirectory(checkpoint);
  const files = identityFiles(home).filter(relative => relative !== DATABASE);
  const fingerprints = await checkpointPool(files, relative => checkpointStateFile(home, relative, beforeCopy));
  if (JSON.stringify(identityFiles(home).filter(relative => relative !== DATABASE)) !== JSON.stringify(files)) {
    throw new Error('Checkpoint state inventory changed during fingerprinting.');
  }
  const hashes = Object.fromEntries(files.map((relative, index) => [relative, fingerprints[index].sha256]));
  const substratePrefixes = Object.fromEntries(files.flatMap((relative, index) => relative.includes('/substrate/') && relative.endsWith('.jsonl')
    ? [[relative, { bytes: fingerprints[index].bytes, sha256: fingerprints[index].sha256 }]] : []));
  let database = { present: false };
  const destination = join(checkpoint, 'coordination.sqlite3');
  if (exists(destination)) { regularCheckpointFile(destination); rmSync(destination); }
  if (exists(join(home, DATABASE))) {
    const { DatabaseSync } = await import('node:sqlite');
    const source = new DatabaseSync(join(home, DATABASE));
    try { source.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`); }
    finally { source.close(); }
    const copy = new DatabaseSync(destination, { readOnly: true });
    try {
      const integrity = copy.prepare('PRAGMA integrity_check').get().integrity_check;
      const version = Number(copy.prepare('PRAGMA user_version').get().user_version);
      if (integrity !== 'ok' || version !== expectedSchemaVersion) throw new Error('Coordination checkpoint failed integrity or version verification.');
      database = { present: true, version, integrity, sha256: hashFile(destination) };
    } finally { copy.close(); }
    hashes[DATABASE] = hashFile(join(home, DATABASE));
  }
  fsyncDirectory(checkpoint);
  return { hashes, database, stateRetention: 'in_place', substratePrefixes };
}
/** Maximal software subtrees and loose files of a package. Each switches with one rename. */
export function softwareUnits(manifest) {
  const units = new Set();
  for (const entry of manifest.files) {
    if (isProductStatePath(entry.path) || MIXED_DIRECTORIES.has(entry.path)) continue;
    const parts = entry.path.split('/');
    let length = 1;
    while (MIXED_DIRECTORIES.has(parts.slice(0, length).join('/'))) length += 1;
    units.add(parts.slice(0, length).join('/'));
  }
  return [...units].sort();
}
function unitOf(relative) {
  const parts = relative.split('/');
  let length = 1;
  while (MIXED_DIRECTORIES.has(parts.slice(0, length).join('/'))) length += 1;
  return parts.slice(0, length).join('/');
}
function fsyncParents(root, units) {
  for (const directory of new Set(units.map(unit => dirname(join(root, unit))))) if (exists(directory)) fsyncDirectory(directory);
}
function renameUnit(from, to) {
  mkdirSync(dirname(to), { recursive: true, mode: 0o755 });
  renameSync(from, to);
}
/** Prepares previous/ to receive the installed software whole. An earlier update's
 * previous version is set aside by one rename; nothing is copied per file. */
function retainPrevious(home, updateDirectory, manifest) {
  const previous = join(updateDirectory, 'previous');
  if (exists(previous)) renameSync(previous, join(updateDirectory, `discarded-previous-${randomUUID()}`));
  mkdirSync(previous, { recursive: true, mode: 0o700 });
  for (const unit of softwareUnits(manifest)) mkdirSync(dirname(join(previous, unit)), { recursive: true, mode: 0o755 });
  durableCopy(join(home, 'manifest.json'), join(previous, 'manifest.json'), 0o644);
  durableCopy(join(home, '.home23-install.json'), join(previous, '.home23-install.json'), 0o600);
  fsyncParents(previous, softwareUnits(manifest));
  fsyncDirectory(previous);
  fsyncDirectory(updateDirectory);
}
/** Switches software by moving whole units: installed units into previous/, then
 * staged units into the home. Each pass is idempotent from any interrupted state
 * and made durable before the next begins. Home state never moves. */
function applyPackage(home, staged, previousManifest, manifest) {
  const previous = join(updateDirectoryFor(home), 'previous');
  const outgoing = softwareUnits(previousManifest), incoming = softwareUnits(manifest);
  const moving = new Set(incoming);
  for (const unit of outgoing) {
    const installed = exists(join(home, unit)), retained = exists(join(previous, unit));
    if (installed && !retained) renameUnit(join(home, unit), join(previous, unit));
    else if (!retained || (installed && (!moving.has(unit) || exists(join(staged, unit))))) {
      throw new Error(`The version switch cannot place ${unit}. Nothing more was moved.`);
    }
  }
  fsyncParents(home, outgoing);
  fsyncParents(previous, outgoing);
  for (const unit of incoming) {
    const waiting = exists(join(staged, unit)), selected = exists(join(home, unit));
    if (waiting && !selected) renameUnit(join(staged, unit), join(home, unit));
    else if (waiting || !selected) throw new Error(`The version switch cannot place ${unit}. Nothing more was moved.`);
  }
  fsyncParents(staged, incoming);
  fsyncParents(home, incoming);
  for (const entry of manifest.files.filter(item => item.type === 'directory' && MIXED_DIRECTORIES.has(item.path))) {
    mkdirSync(join(home, entry.path), { recursive: true, mode: entry.mode });
    chmodSync(join(home, entry.path), entry.mode);
  }
  for (const entry of manifest.files.filter(item => item.type === 'file' && isProductStatePath(item.path))) {
    // Packaged .gitkeep markers keep empty state directories in the manifest.
    // They must not replace a home's real files or abort selection.
    const destination = join(home, entry.path);
    if (entry.path.endsWith('/.gitkeep') && !exists(destination)) durableCopy(join(staged, entry.path), destination, entry.mode);
    else if (!entry.path.endsWith('/.gitkeep')) throw new Error(`Candidate contains home state: ${entry.path}`);
  }
  durableCopy(join(staged, 'manifest.json'), join(home, 'manifest.json'), 0o644);
  durableJSON(join(home, '.home23-install.json'), { schema: INSTALL_SCHEMA, status: 'installed', homeRoot: home, appRoot: join(home, 'app'),
    nodePath: join(home, 'bin', 'node'), pm2Path: join(home, 'tools', 'node_modules', 'pm2', 'bin', 'pm2'),
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit, replayed: false });
  fsyncDirectory(home);
  // The finish step verifies every selected byte before any writer is admitted,
  // and a mismatch there restores the previous units.
  return manifest;
}
/** The switch in reverse. Candidate units are set aside whole and the retained
 * previous units move back. Resumes from any interrupted restore. */
function restorePrevious(home, updateDirectory, previousManifest, candidateManifest, verify, setAside) {
  const previous = join(updateDirectory, 'previous');
  const returning = softwareUnits(previousManifest), leaving = softwareUnits(candidateManifest);
  const retained = new Set(returning.filter(unit => exists(join(previous, unit))));
  // Verify the previous version where it is now: still in previous/, or already back home.
  const units = previousManifest.files.filter(entry => !isProductStatePath(entry.path) && !MIXED_DIRECTORIES.has(entry.path));
  if (!payloadMatchesAt(units, entry => (retained.has(unitOf(entry.path)) ? previous : home))) {
    throw Object.assign(new Error('Retained previous software no longer matches its manifest.'), { code: 'rollback_unverified' });
  }
  const back = new Set(returning);
  for (const unit of leaving) {
    // A unit already restored from previous/ is the previous version, not the candidate.
    if (exists(join(home, unit)) && (!back.has(unit) || retained.has(unit))) renameUnit(join(home, unit), join(setAside, unit));
  }
  fsyncParents(home, leaving);
  fsyncParents(setAside, leaving);
  for (const unit of retained) {
    if (exists(join(home, unit))) throw new Error(`Rollback cannot place ${unit}. Nothing more was moved.`);
    renameUnit(join(previous, unit), join(home, unit));
  }
  fsyncParents(previous, [...retained]);
  fsyncParents(home, returning);
  for (const entry of previousManifest.files.filter(item => item.type === 'directory' && MIXED_DIRECTORIES.has(item.path))) {
    mkdirSync(join(home, entry.path), { recursive: true, mode: entry.mode });
    chmodSync(join(home, entry.path), entry.mode);
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
/** The candidate manifest pinned when the switch began. A partly moved stage cannot
 * be re-verified as a tree, so its manifest is checked by the recorded digest. */
function candidateManifest(journal) {
  const file = join(journal.stagedPayload, 'manifest.json');
  if (!journal.stagedManifestSha256) return readProductManifest(journal.stagedPayload);
  if (hashFile(file) !== journal.stagedManifestSha256) throw new Error('The staged candidate manifest changed during the switch.');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.packageId !== journal.toPackageId) throw new Error('The staged candidate changed identity.');
  return manifest;
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
    // The selected tree was fully verified before these writers were admitted.
    // On a reviewed reused stage, read its self-validating manifest instead of
    // rescanning every package byte while the live home is answering requests.
    const admittedReuse = journal.reuseVerifiedStage === true && journal.writersAdmitted === true
      && journal.acceptedWork === true;
    const manifest = admittedReuse ? readProductManifest(home) : verify(home, { allowRuntimeState: true });
    if (manifest.packageId !== journal.toPackageId) issues.push('The running tree is not the selected package.');
    const receipt = readPrivateJSON(join(home, '.home23-install.json'));
    if (receipt?.packageId !== journal.toPackageId || receipt?.nodePath !== join(home, 'bin', 'node')
      || (admittedReuse && (receipt?.status !== 'installed' || receipt?.homeRoot !== home
        || receipt?.appRoot !== join(home, 'app') || receipt?.pm2Path !== join(home, 'tools/node_modules/pm2/bin/pm2')))) {
      issues.push('The installation receipt does not name the selected package.');
    }
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
    // A busy preflight can admit an owned writer without reading the version.
    // Once that writer stops, pin the inspected, reviewed version before copying
    // state. Only older journals with no version field imply v20.
    let expectedSchemaVersion = Object.hasOwn(journal, 'coordinationSchemaVersion')
      ? journal.coordinationSchemaVersion : 20;
    if (database.busy) {
      return { done: deferred(home, 'database_busy', 'The coordination database remains busy after owned writers stopped. Resume when it can be inspected.', journal) };
    }
    const candidateSchema = expectedSchemaVersion === null ? candidateCoordinationSchema(candidateManifest(journal)) : null;
    if ((expectedSchemaVersion === null && (!database.present || !database.compatible || candidateSchema === null
        || database.version > candidateSchema))
      || (database.present && (!database.compatible || (expectedSchemaVersion !== null && database.version !== expectedSchemaVersion)))) {
      journal = await commitPhase(file, { ...journal, phase: 'aborted', reasons: [{ code: 'unsupported_data_version', message: 'The stored schema changed after the preflight. Package files were not replaced.' }] }, dependencies);
      return { done: publicResult(journal) };
    }
    if (expectedSchemaVersion === null) {
      expectedSchemaVersion = database.version;
      journal = await commitPhase(file, { ...journal, coordinationSchemaVersion: expectedSchemaVersion }, dependencies);
    }
    const checkpoint = await (dependencies.writeCheckpoint || writeCheckpoint)(home, updateDirectoryFor(home), journal.id,
      { beforeCopy: dependencies.checkpointBeforeCopy, expectedSchemaVersion });
    journal = await commitPhase(file, { ...journal, phase: 'checkpointed', identity: checkpoint.hashes, canonical: canonicalFrom(checkpoint.hashes), hostIdentity: hostIdentity(home), checkpointDatabase: checkpoint.database,
      stateRetention: checkpoint.stateRetention || 'copied', substratePrefixes: checkpoint.substratePrefixes || {} }, dependencies);
  }
  if (rank() < RANK.retained) {
    const installed = readProductManifest(home);
    if (installed.packageId !== journal.fromPackageId) {
      journal = await commitPhase(file, { ...journal, phase: 'recovery_required', reasons: [{ code: 'baseline_changed', message: 'The installed package changed before selection. Automatic recovery stopped.' }] }, dependencies);
      return { done: publicResult(journal) };
    }
    // A normal Host install already has a verified stage and a bound installed
    // receipt. The old software itself is retained, and rollback verifies it
    // before use. Unstaged installs still check every installed byte here.
    if (!journal.reuseVerifiedStage &&
        verify(home, { allowRuntimeState: true, fresh: journal.stoppedForUpdate === true }).packageId !== installed.packageId) {
      throw new Error('Installed software does not match its manifest. Nothing was moved.');
    }
    await (dependencies.retainPrevious || retainPrevious)(home, updateDirectoryFor(home), installed);
    journal = await commitPhase(file, { ...journal, phase: 'retained', retention: 'switch' }, dependencies);
  }
  if (rank() < RANK.selected && journal.retention !== 'switch') {
    // A copy-based journal from an earlier updater keeps its own retained controller.
    throw Object.assign(new Error('This update was started by an earlier updater. Resume it with the controller retained beside its journal.'), { code: 'update_controller_mismatch' });
  }
  if (rank() < RANK.applying) {
    // A Host stage was fully checked before its receipt became staged and has
    // stayed under its lock. The selected home is fully checked before Start;
    // a non-cooperating edit to the stage causes rollback while writers are fenced.
    if (!journal.reuseVerifiedStage && verify(journal.stagedPayload, { fresh: true }).packageId !== journal.toPackageId) {
      throw new Error('The staged candidate changed identity.');
    }
    journal = await commitPhase(file, { ...journal, phase: 'applying', stagedManifestSha256: hashFile(join(journal.stagedPayload, 'manifest.json')) }, dependencies);
  }
  if (rank() < RANK.selected) {
    applyPackage(home, journal.stagedPayload, previousManifest(home), candidateManifest(journal));
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
      if (dependencies.restorePrevious) dependencies.restorePrevious(home, updateDirectoryFor(home), previousManifest(home), candidateManifest(journal));
      else restorePrevious(home, updateDirectoryFor(home), previousManifest(home), candidateManifest(journal), verify, join(updateDirectoryFor(home), `discarded-candidate-${journal.id}`));
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
    releaseDiscarded(updateDirectoryFor(home), dependencies);
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
    let started = null, startError = null;
    try { started = await (dependencies.start || defaultStart)(home, journal); }
    catch (error) { startError = error; }
    journal = await commitPhase(file, { ...journal, candidateStarted: true,
      ...startObservation(started, startError), phase: 'writers_admitted' }, dependencies);
  }
  let identityPreserved = journal.writersAdmitted ? await sameCanonical(home, journal) : sameIdentity(home, journal.identity);
  if (journal.writersAdmitted && !identityPreserved) {
    await fence();
    identityPreserved = await sameCanonical(home, journal);
    if (identityPreserved && journal.desiredRunning && !(await busy())) {
      let started = null, startError = null;
      try { started = await (dependencies.start || defaultStart)(home, journal); }
      catch (error) { startError = error; }
      journal = await commitPhase(file, { ...journal, candidateStarted: true,
        ...startObservation(started, startError), phase: 'writers_admitted' }, dependencies);
    }
  }
  let behavior = dependencies.verifyBehavior ? await dependencies.verifyBehavior({ home, journal, identityPreserved }) : defaultBehavior({ home, journal, identityPreserved, verify });
  if (journal.desiredRunning && journal.writersAdmitted && journal.startOk === false && identityPreserved) {
    // A cold home can outlive Start's readiness wait. Check its current status
    // without restarting or fencing healthy, still-warming writers.
    const withoutStartFailure = dependencies.verifyBehavior ? behavior :
      defaultBehavior({ home, journal: { ...journal, startOk: true }, identityPreserved, verify });
    if (withoutStartFailure.ok) {
      let current = null, statusUnavailable = false;
      try { current = await (dependencies.status || defaultStatus)(home, journal); }
      catch { statusUnavailable = true; }
      const maskedStatusFailure = current?.ok === false && current?.status === 'recovery_required' &&
        current?.error?.code === 'update_recovery_required' && !current?.readiness && !current?.processes;
      const kind = statusUnavailable || !current || maskedStatusFailure ? 'unavailable' : candidateStatusKind(current);
      if (kind === 'ready') {
        journal = await commitPhase(file, { ...journal, startOk: true, startStatus: 'ready', startErrorCode: null }, dependencies);
        behavior = withoutStartFailure;
      } else if (kind === 'starting' && await busy()) {
        return deferred(home, 'candidate_starting', 'This home is still starting. Its services remain running; resume the update after it becomes ready.', journal);
      } else if (kind === 'unavailable' && healthyAdmittedWriters(await list(home), journal.writerNames)) {
        return deferred(home, 'candidate_starting', 'This home is running but readiness could not be checked yet. Resume the update after it becomes ready.', journal);
      }
    }
  }
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
  releaseDiscarded(updateDirectoryFor(home), dependencies);
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

async function openTransaction({ home, candidate, staging, admit, reuseVerifiedStage = false }, dependencies, verify) {
  // A completed Stage already checked the candidate. Its Install still checks
  // the selected tree before admitting writers. Avoid rereading every byte of
  // the previous software here; rollback verifies that retained copy if used.
  const installation = inspectProductInstallation(home, { verifyFiles: !reuseVerifiedStage });
  if (installation.layout !== 'product') return refuse(home, installation.reasons.length ? installation.reasons : [{ code: 'unsupported_layout', message: 'The current home is not an owned product installation.' }]);
  if (reuseVerifiedStage && installation.reasons.length) return refuse(home, installation.reasons);
  if (installation.reasons.some(item => item.code !== 'modified_installation')) return refuse(home, installation.reasons);
  let candidateManifest;
  try { candidateManifest = reuseVerifiedStage ? readProductManifest(candidate) : verify(candidate); }
  catch { return refuse(home, [{ code: 'candidate_integrity_failed', message: 'The candidate package failed its integrity checks.' }]); }
  const installed = readProductManifest(home);
  if (installed.packageId === candidateManifest.packageId) return refuse(home, [{ code: 'same_package', message: 'The candidate is the package already installed.' }]);
  const inventory = await (dependencies.inspectUpdateInventory || inspectUpdateInventory)(home, { installed, candidate: candidateManifest,
    scanSoftware: !reuseVerifiedStage, databaseCheck: 'fingerprint' });
  const blocking = inventory.reasons.filter(item => item.code !== 'database_busy');
  if (blocking.length) return refuse(home, blocking);
  if (!reuseVerifiedStage) {
    try { verify(home, { allowRuntimeState: true }); }
    catch { return refuse(home, [{ code: 'modified_installation', message: 'A declared installed file, mode, link, or layout has changed.' }]); }
  }
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
  if (!spaceFor(home, dependencies)) return refuse(home, [{ code: 'insufficient_space', message: 'Not enough free space for the verified checkpoint and 64 MiB of headroom.' }]);
  let releaseStage = null;
  try {
    let staged;
    if (reuseVerifiedStage) {
      // Hold the existing stage lock for the whole apply so download/retry cannot rewrite it.
      releaseStage = acquireInstallLock(stageLockPath(staging));
      staged = adoptVerifiedStage({ homeRoot: home, staging, verifyProductPayload: verify, trustStagedReceipt: true });
    } else {
      staged = stageProductPayload({ homeRoot: home, candidatePayload: candidate, staging, verifyProductPayload: verify });
    }
    if ((reuseVerifiedStage ? readProductManifest(staged.payloadPath) : verify(staged.payloadPath)).packageId !== candidateManifest.packageId) {
      return refuse(home, [{ code: 'candidate_integrity_failed', message: 'The staged candidate changed identity.' }]);
    }
    if (new Set([home, dirname(home), staged.payloadPath].map(path => lstatSync(path).dev)).size !== 1) {
      return refuse(home, [{ code: 'staging_other_volume', message: 'The staged candidate must be on the same volume as the home so software can switch in place. Nothing was changed.' }]);
    }
    const updateDirectory = updateDirectoryFor(home);
    mkdirSync(updateDirectory, { recursive: true, mode: 0o700 });
    installController(updateDirectory);
    const journal = await commitPhase(journalPath(home), { schema: SCHEMA, id: randomUUID(), homeRoot: home, staging, stagedPayload: staged.payloadPath,
      fromPackageId: installed.packageId, toPackageId: candidateManifest.packageId, fromSourceCommit: installed.sourceCommit,
      toSourceCommit: candidateManifest.sourceCommit, desiredRunning: inventory.desiredRunning, admit: admit === true,
      writerNames: inventory.writers, coordinationSchemaVersion: inventory.databaseInspection.version,
      ownerToken: randomUUID(), phase: 'claimed', acceptedWork: false, candidateStarted: false,
      networkInstall: false, reuseVerifiedStage: reuseVerifiedStage === true, createdAt: new Date().toISOString() }, dependencies);
    return await runTransaction(journal, dependencies, verify);
  } finally {
    if (releaseStage) releaseStage();
  }
}

async function locked(home, dependencies, body) {
  const releaseUpdate = acquireInstallLock(`${updateDirectoryFor(home)}.lock`);
  try { return await body(); }
  finally { releaseUpdate(); }
}
async function withReusedStageLock(journal, verify, body) {
  let releaseStage = null;
  try {
    // Only phases before selection still use the reused stage. Terminal replay and
    // post-selection/admission work use previous/ or the installed tree.
    const needsVerifiedStage = journal?.reuseVerifiedStage === true
      && typeof journal.staging === 'string'
      && Object.hasOwn(RANK, journal.phase)
      && RANK[journal.phase] < RANK.selected;
    if (needsVerifiedStage) {
      releaseStage = acquireInstallLock(stageLockPath(journal.staging));
      // From applying on, the switch has begun moving staged units into the home,
      // so the stage is partial by design and selection verifies the home instead.
      if (RANK[journal.phase] < RANK.applying) {
        try {
          if ((journal.reuseVerifiedStage ? readProductManifest(journal.stagedPayload) : verify(journal.stagedPayload)).packageId !== journal.toPackageId) {
            return refuse(journal.homeRoot, [{ code: 'candidate_integrity_failed', message: 'The staged candidate changed identity.' }]);
          }
        } catch {
          return refuse(journal.homeRoot, [{ code: 'candidate_integrity_failed', message: 'The staged candidate is missing or no longer verifies.' }]);
        }
      }
    }
    return await body();
  } finally {
    if (releaseStage) releaseStage();
  }
}
export async function resumeProductUpdate({ homeRoot } = {}, dependencies = {}) {
  const home = absoluteHome(homeRoot);
  const verify = payloadVerifyFrom(dependencies);
  return locked(home, dependencies, async () => {
    const journal = readUpdateJournal(home);
    if (!journal) return refuse(home, [{ code: 'update_not_found', message: 'This home has no update journal to resume.' }]);
    return withReusedStageLock(journal, verify, () => runTransaction(journal, dependencies, verify));
  });
}
export async function applyProductUpdate({ homeRoot, candidatePayload, staging, admit = false, reuseVerifiedStage = false } = {}, dependencies = {}) {
  const home = absoluteHome(homeRoot);
  if (typeof candidatePayload !== 'string' || typeof staging !== 'string') throw new Error('Choose absolute candidate and staging directories.');
  const candidate = absoluteHome(candidatePayload), stageRoot = absoluteHome(staging), updateDirectory = updateDirectoryFor(home);
  if (reuseVerifiedStage) {
    if (candidate !== join(stageRoot, 'payload')) {
      throw new Error('reuseVerifiedStage requires the candidate to be the staging payload directory.');
    }
    for (const [left, right] of [[home, stageRoot], [home, updateDirectory], [stageRoot, updateDirectory]]) {
      if (inside(left, right) || inside(right, left)) throw new Error('Home, staging, and the update journal must be separate directories.');
    }
  } else {
    for (const [left, right] of [[home, candidate], [home, stageRoot], [candidate, stageRoot], [home, updateDirectory]]) {
      if (inside(left, right) || inside(right, left)) throw new Error('Home, candidate, staging, and the update journal must be separate directories.');
    }
  }
  const verify = payloadVerifyFrom(dependencies);
  return locked(home, dependencies, async () => {
    const existing = exists(journalPath(home)) ? readUpdateJournal(home) : null;
    let candidateId = null;
    try { candidateId = (reuseVerifiedStage ? readProductManifest(candidate) : verify(candidate)).packageId; }
    catch { return refuse(home, [{ code: 'candidate_integrity_failed', message: 'The candidate package failed its integrity checks.' }]); }
    if (existing && !['committed', 'rolled_back', 'aborted'].includes(existing.phase)) {
      if (existing.toPackageId !== candidateId) return refuse(home, [{ code: 'update_in_progress', message: 'An unfinished update belongs to another candidate. Resume that journal before starting a different one.' }]);
      return withReusedStageLock(existing, verify, () => runTransaction(existing, dependencies, verify));
    }
    if (existing?.phase === 'committed' && existing.toPackageId === candidateId) return publicResult(existing, { replayed: true });
    if (existing) archiveJournal(journalPath(home), existing);
    return openTransaction({ home, candidate, staging: stageRoot, admit, reuseVerifiedStage: reuseVerifiedStage === true }, dependencies, verify);
  });
}
