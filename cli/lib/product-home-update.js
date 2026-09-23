/** Durable, owner-requested whole-product updates. HTTP only passes actions, never paths. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { absoluteHome, privateDirectory, readPrivateJSON, productEnvironment } from './product-environment.js';
import { promisify } from 'node:util';

const SCHEMA = 'home23.home-update.v1';
const ACTIONS = new Set(['check', 'update', 'resume', 'recover']);
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const library = dirname(fileURLToPath(import.meta.url));
const now = () => new Date().toISOString();
const executeFile = promisify(execFile);
const alive = pid => { if (!Number.isInteger(pid) || pid < 1) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const fail = (code, message) => Object.assign(new Error(message), { code });
const homePaths = homeRoot => ({ directory: join(homeRoot, 'runtime/home-update'), registration: join(homeRoot, 'runtime/home-update/application.json') });
function save(path, value) {
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw fail('update_state_invalid', 'Update state is not a regular file.');
  const temporary = `${path}.${randomUUID()}.tmp`, fd = openSync(temporary, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const dir = openSync(dirname(path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
}
function installedHome(homeRoot) {
  const root = absoluteHome(homeRoot), receipt = readPrivateJSON(join(root, '.home23-install.json'));
  if (receipt?.schema !== 'home23.product-install.v1' || receipt.status !== 'installed' || receipt.homeRoot !== root || receipt.appRoot !== join(root, 'app')) {
    throw fail('home_update_unavailable', 'This home needs to finish connecting to Home23 updates on its Mac.');
  }
  return { root, receipt, ...homePaths(root) };
}
function registration(home) {
  const value = readPrivateJSON(home.registration);
  if (value?.schema !== 'home23.product-application.v1' || value.homeRoot !== home.root || typeof value.applicationPath !== 'string') return null;
  return value;
}
function loadOperation(home, id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw fail('update_state_invalid', 'The saved update cannot be read.');
  const operation = readPrivateJSON(join(home.directory, `${id}.json`));
  if (!operation || operation.schema !== SCHEMA || operation.id !== id || operation.homeRoot !== home.root) throw fail('update_state_invalid', 'The saved update belongs to another home.');
  return operation;
}
function latestOperation(home) {
  const latest = readPrivateJSON(join(home.directory, 'latest.json'));
  return latest ? loadOperation(home, latest.id) : null;
}
function publicOperation(operation) {
  if (!operation) return null;
  const interrupted = !TERMINAL.has(operation.phase) && !alive(operation.pid)
    && Date.now() - Date.parse(operation.updatedAt) > 30_000;
  return { id: operation.id, action: operation.action, phase: interrupted ? 'interrupted' : operation.phase,
    progress: operation.progress ?? null, message: interrupted ? 'The update was interrupted. Resume to continue safely.' : operation.message,
    startedAt: operation.startedAt, updatedAt: operation.updatedAt,
    canResume: interrupted || ['failed', 'interrupted'].includes(operation.phase) };
}
function releaseView(release) {
  return release ? { version: release.version ?? 'Home23', build: release.appBuild ?? release.build ?? null, packageId: release.packageId ?? null } : null;
}
function projectStatus(home, operation, clientBuild) {
  const visible = publicOperation(operation), registered = registration(home);
  const offered = operation?.release ?? null;
  const minimumClientBuild = offered?.compatibility?.minimumClientBuild ?? operation?.check?.minimumClientBuild ?? 1;
  const appUpdateRequired = Number.isInteger(clientBuild) && clientBuild < minimumClientBuild;
  const compatible = operation?.check?.status !== 'incompatible' && !appUpdateRequired;
  let state = operation?.check?.status === 'current' ? 'upToDate' : operation?.check?.status ?? 'idle';
  let message = operation?.message ?? 'Check for a Home23 update.';
  let allowedActions = ['check'];
  if (!registered) { state = 'unavailable'; message = 'Open Home23 on the Mac running your home to finish connecting updates.'; allowedActions = []; }
  else if (visible && !TERMINAL.has(visible.phase)) { state = 'running'; allowedActions = []; message = visible.message; }
  else if (visible?.canResume) { state = 'failed'; allowedActions = ['resume', 'recover']; message = visible.message; }
  else if (state === 'available' && compatible) allowedActions.push('update');
  if (appUpdateRequired && state !== 'running') { state = 'incompatible'; allowedActions = allowedActions.filter(action => action === 'check'); message = 'Update Home23 on this device before updating your home.'; }
  if (operation?.phase === 'completed' && operation.action !== 'check' && operation.runtimeCompleted && operation.applicationCompleted) {
    state = 'upToDate'; message = operation.message; allowedActions = ['check'];
  }
  return { state, installedRelease: { version: registered?.version ?? home.receipt.version ?? 'Home23', build: registered?.build ?? null, packageId: home.receipt.packageId },
    availableRelease: state === 'upToDate' ? null : releaseView(offered), compatibility: { isCompatible: compatible, minimumClientBuild, appUpdateRequired,
      message: appUpdateRequired ? 'Update this device first. Other compatible family devices can update later.' : null },
    appDeliveryURL: offered?.appDeliveryURL ?? operation?.check?.appDeliveryURL ?? null,
    operation: visible, allowedActions, message, checkedAt: operation?.checkedAt ?? null };
}
export function homeUpdateStatus({ homeRoot, clientBuild } = {}) {
  try { const home = installedHome(homeRoot); return projectStatus(home, latestOperation(home), clientBuild); }
  catch (error) {
    return { state: 'unavailable', installedRelease: null, availableRelease: null,
      compatibility: { isCompatible: false, minimumClientBuild: 1, appUpdateRequired: false, message: null },
      appDeliveryURL: null, operation: null, allowedActions: [], checkedAt: null,
      message: error.code === 'home_update_unavailable' ? error.message : 'Home23 update status could not be read. Open Home23 on your Mac for recovery.' };
  }
}
/** Called only by the local embedded helper after installation/selection. */
export function registerProductApplication({ homeRoot, applicationPath } = {}) {
  const home = installedHome(homeRoot);
  if (typeof applicationPath !== 'string' || basename(applicationPath) !== 'Home23.app'
      || resolve(applicationPath) !== realpathSync(applicationPath) || !lstatSync(applicationPath).isDirectory()) {
    throw fail('application_invalid', 'Choose the installed Home23 application.');
  }
  const info = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(applicationPath, 'Contents/Info.plist')], { encoding: 'utf8' }));
  const helper = join(applicationPath, 'Contents/Library/LoginItems/Home23Host.app');
  if (info.CFBundleIdentifier !== 'com.regina6.home23.mac' || !existsSync(helper)) throw fail('application_invalid', 'The application is missing its Home23 background helper.');
  privateDirectory(home.directory);
  save(home.registration, { schema: 'home23.product-application.v1', homeRoot: home.root, applicationPath,
    version: info.CFBundleShortVersionString, build: Number(info.CFBundleVersion) || null, registeredAt: now() });
  return homeUpdateStatus({ homeRoot });
}
async function withAdmission(home, callback) {
  privateDirectory(home.directory);
  const lock = join(home.directory, 'admission.lock');
  for (let attempt = 0; attempt < 50; attempt++) {
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const stat = lstatSync(lock);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw fail('update_state_invalid', 'Update admission is unavailable.');
      const owner = readPrivateJSON(join(lock, 'owner.json'));
      if (owner && !alive(owner.pid) || !owner && Date.now() - stat.mtimeMs > 30_000) { rmSync(lock, { recursive: true }); continue; }
      await new Promise(resolve => setTimeout(resolve, 100)); continue;
    }
    try { save(join(lock, 'owner.json'), { pid: process.pid }); return await callback(); }
    finally { rmSync(lock, { recursive: true }); }
  }
  throw fail('home_update_busy', 'Another Home23 update request is being handled. Try again.');
}
/** Retain just the controller's local import graph and Node, outside replaced software. */
function retainExecutor(home, operation) {
  const directory = join(home.directory, `executor-${operation.id}-${operation.attempt}`);
  privateDirectory(directory);
  const copied = new Set();
  function copyModule(name) {
    if (copied.has(name)) return;
    if (!/^[\w.-]+\.(js|mjs)$/.test(name)) throw fail('controller_invalid', 'Update controller dependency is invalid.');
    copied.add(name);
    const source = join(library, name), content = readFileSync(source, 'utf8');
    copyFileSync(source, join(directory, name), constants.COPYFILE_FICLONE);
    for (const match of content.matchAll(/(?:from\s*|import\s*\(\s*)['"]\.\/([^'"]+)['"]/g)) copyModule(match[1]);
  }
  copyModule('product-home-update-worker.mjs');
  // The runtime updater retains this entry by name when it checkpoints; it is
  // deliberately not imported during an ordinary check.
  copyModule('product-update-recover.mjs');
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}\n', { mode: 0o600, flag: 'wx' });
  // Core may have been launched by a development interpreter. Retain the
  // installation's portable Node, never an ambient Homebrew-linked executable.
  const installedNode = join(home.root, 'bin/node');
  if (!lstatSync(installedNode).isFile() || lstatSync(installedNode).isSymbolicLink()) throw fail('runtime_invalid', 'The installed Home23 runtime is unavailable.');
  copyFileSync(installedNode, join(directory, 'node'), constants.COPYFILE_FICLONE);
  chmodSync(join(directory, 'node'), 0o700);
  return directory;
}
export async function requestHomeUpdate({ homeRoot, action, idempotencyKey, principalId, clientBuild } = {}, dependencies = {}) {
  if (!ACTIONS.has(action) || typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200
      || typeof principalId !== 'string' || !principalId || !Number.isSafeInteger(clientBuild) || clientBuild < 1) {
    throw fail('request_invalid', 'The Home23 update request is invalid.');
  }
  const home = installedHome(homeRoot);
  return withAdmission(home, async () => {
    if (!registration(home)) throw fail('home_update_unavailable', 'Open Home23 on the Mac running your home to finish connecting updates.');
    const key = createHash('sha256').update(`${principalId}\0${idempotencyKey}`).digest('hex');
    const receiptPath = join(home.directory, `request-${key}.json`), prior = readPrivateJSON(receiptPath);
    if (prior) {
      if (prior.action !== action || prior.clientBuild !== (clientBuild ?? null)) throw fail('idempotency_conflict', 'This request key already belongs to a different update action.');
      return projectStatus(home, loadOperation(home, prior.id), clientBuild);
    }
    let operation = latestOperation(home);
    const status = projectStatus(home, operation, clientBuild);
    if (!status.allowedActions.includes(action)) throw fail('home_update_busy', status.message);
    if (action === 'resume' || action === 'recover') {
      if (!operation || alive(operation.pid)) throw fail('home_update_busy', 'The previous update is still running.');
      operation = { ...operation, runAction: action, clientBuild: clientBuild ?? operation.clientBuild, attempt: operation.attempt + 1, phase: 'queued', pid: null, updatedAt: now(), message: 'Resuming Home23 update.' };
    } else {
      operation = { schema: SCHEMA, id: randomUUID(), homeRoot: home.root, action, runAction: action, attempt: 1,
        clientBuild: clientBuild ?? null, phase: 'queued', progress: null, pid: null, startedAt: now(), updatedAt: now(),
        message: action === 'check' ? 'Checking for updates…' : 'Preparing your Home23 update…',
        release: action === 'update' ? operation?.release : null };
    }
    save(join(home.directory, `${operation.id}.json`), operation);
    save(join(home.directory, 'latest.json'), { id: operation.id });
    save(receiptPath, { id: operation.id, action, clientBuild: clientBuild ?? null });
    try {
      if (dependencies.launch) await dependencies.launch(operation, home);
      else {
        const executor = retainExecutor(home, operation);
        const child = spawn(join(executor, 'node'), [join(executor, 'product-home-update-worker.mjs'), home.root, operation.id],
          { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' } });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        const latest = loadOperation(home, operation.id);
        save(join(home.directory, `${operation.id}.json`), { ...latest, pid: child.pid, executor });
        child.unref();
      }
    } catch (error) {
      operation = { ...loadOperation(home, operation.id), phase: 'failed', updatedAt: now(), message: 'The update could not start. Resume to try again.', errorCode: error.code ?? 'launch_failed' };
      save(join(home.directory, `${operation.id}.json`), operation);
    }
    return projectStatus(home, loadOperation(home, operation.id), clientBuild);
  });
}

/** Entry in a retained detached process. No dependency on the API lifetime or app bundle. */
export async function runHomeUpdateOperation({ homeRoot, operationId } = {}, dependencies = {}) {
  const home = installedHome(homeRoot);
  // Admission holds the durable launch receipt before the worker may update it.
  await withAdmission(home, async () => {});
  let operation = loadOperation(home, operationId);
  if (TERMINAL.has(operation.phase)) return;
  const registered = registration(home);
  if (!registered) throw fail('application_unavailable', 'Home23 application registration is missing.');
  const persist = patch => { operation = { ...operation, ...patch, updatedAt: now(), pid: process.pid }; save(join(home.directory, `${operation.id}.json`), operation); };
  try {
    const channel = dependencies.channel ?? await import('./product-release-channel.js');
    const updater = dependencies.updater ?? await import('./product-update-apply.js');
    const appUpdater = dependencies.appUpdater ?? await import('./product-app-update.js');
    const options = { homeRoot: home.root, installedAppPath: registered.applicationPath };
    if (operation.action === 'check') {
      persist({ phase: 'checking', message: 'Checking for updates…' });
      const checked = await channel.checkConfiguredRelease(options);
      persist({ phase: 'completed', check: checked, release: checked.release ?? null, checkedAt: now(),
        message: checked.status === 'current' ? 'Home23 is up to date.' : checked.status === 'available' ? 'A Home23 update is available.'
          : checked.status === 'incompatible' ? 'This release is not compatible with this home yet.' : 'Updates could not be checked. Try again later.' });
      return;
    }
    let prepared = operation.prepared;
    if (!prepared) {
      persist({ phase: 'downloading', message: 'Downloading Home23. Your home is still available.' });
      const delivery = privateDirectory(join(dirname(home.root), `.${basename(home.root)}.home23-delivery`));
      prepared = await channel.prepareConfiguredRelease({ ...options,
        staging: join(delivery, `stage-${operation.id}`), downloadDirectory: join(delivery, `download-${operation.id}`),
        onProgress: progress => persist({ progress: progress.bytesTotal > 0 ? Math.min(1, progress.bytesCopied / progress.bytesTotal) : null }) });
      persist({ prepared, release: prepared.release, progress: null, phase: 'preparing', message: 'The download is ready. Preparing your home update.' });
    }
    const minimum = prepared.release?.compatibility?.minimumClientBuild ?? 1;
    if (operation.clientBuild < minimum) throw fail('app_update_required', 'Update Home23 on this device before updating your home.');
    if (!operation.runtimeCompleted) {
      persist({ phase: 'updating', message: 'Updating your home. Home23 will reconnect automatically.' });
      const journal = updater.readUpdateJournal(home.root);
      const result = journal && !['committed', 'rolled_back', 'aborted'].includes(journal.phase)
        ? await updater.resumeProductUpdate({ homeRoot: home.root })
        : readPrivateJSON(join(home.root, '.home23-install.json'))?.packageId === prepared.packageId
          ? { ok: true, status: 'committed' }
          : await updater.applyProductUpdate({ homeRoot: home.root, candidatePayload: prepared.candidatePayload, staging: prepared.staging,
            reuseVerifiedStage: true, admit: true });
      if (!result.ok || result.status !== 'committed') throw fail('update_incomplete', 'The home update needs recovery before it can finish.');
      persist({ runtimeCompleted: true });
    }
    if (!operation.applicationCompleted) {
      persist({ phase: 'updating', message: 'Updating the Home23 application on your Mac.' });
      const result = await appUpdater.applyPreparedMacApplication({ installedAppPath: prepared.installedAppPath,
        preparedAppPath: prepared.preparedAppPath, lifecyclePath: prepared.lifecyclePath, release: prepared.release, relaunch: true });
      if (result.status !== 'reopened') throw fail('application_incomplete', 'The home updated; the Mac application still needs to finish updating.');
      persist({ applicationCompleted: true });
      save(home.registration, { ...registered, version: prepared.release.version, build: prepared.appBuild, updatedAt: now() });
    }
    persist({ phase: 'reconnecting', message: 'Reconnecting to your home…' });
    const verify = dependencies.verifyReady ?? verifyHomeReady;
    const readiness = await verify(home.root, prepared.packageId);
    persist({ phase: 'completed', progress: 1, message: readiness?.running === false
      ? 'Home23 is updated. Your home remains stopped.' : 'Home23 is updated and your home is ready.' });
  } catch (error) {
    persist({ phase: 'failed', errorCode: error.code ?? 'update_failed', message: operation.runtimeCompleted
      ? 'Your home software is updated. Resume to finish the Mac application and reconnect.'
      : 'The update could not finish. Resume or recover to return your home to service.' });
  }
}
async function verifyHomeReady(homeRoot, packageId) {
  const receipt = readPrivateJSON(join(homeRoot, '.home23-install.json'));
  if (receipt?.packageId !== packageId) throw fail('update_identity_mismatch', 'The running home release needs verification.');
  // Shipped status validates executable/cwd ownership for every resident and
  // authenticates bootstrap against the preserved home/bot identity.
  const { stdout } = await executeFile(join(homeRoot, 'bin/node'),
    [join(homeRoot, 'app/scripts/product/host.mjs'), 'status', '--home', homeRoot],
    { env: productEnvironment(homeRoot), timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
  const status = JSON.parse(stdout);
  if (status.desiredRunning === false && ['stopped', 'prepared', 'installed'].includes(status.status)) return { running: false };
  if (status.status !== 'ready' || !status.processes?.length || status.processes.some(row => !row.owned || row.status !== 'online')) {
    throw fail('home_unreachable', 'Your home is still reconnecting.');
  }
  return { running: true };
}
