/** A home-scoped foreground PM2 service, owned by the user's launchd domain. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { absoluteHome, privateJSON, productEnvironment, readPrivateJSON } from './product-environment.js';
import { acquireInstallLock, readProductManifest } from './product-payload.js';
import { writerStopOrder } from './product-update-inventory.js';

const SELF = fileURLToPath(import.meta.url);
const fail = (code, message) => Object.assign(new Error(message), { code });
const ambiguous = message => fail('host_supervisor_ambiguous', message);
const RUNTIME_FIELDS = ['pm_id', 'status', 'pm_uptime', 'created_at', 'restart_time', 'unstable_restarts', 'exit_code', 'prev_restart_delay',
  'restart_task', '_tree_pids', 'axm_actions', 'axm_monitor', 'axm_options', 'axm_dynamic', 'vizion_running', 'versioning', 'unique_id'];
function registrationDefinition(row) {
  const env = structuredClone(row.pm2_env);
  for (const key of RUNTIME_FIELDS) delete env[key];
  if (env.env) {
    delete env.env.unique_id;
    // PM2 mirrors this computed status into env and coerces its string value
    // during stopped-record prepare. It is runtime metadata, not desired config.
    delete env.env.vizion_running;
  }
  // prepare's stopped standalone path represents one record without a replica
  // count. Duplicate names/multi-instance registrations are never admitted.
  if (env.instances === undefined) env.instances = 1;
  // PM2 stop writes watch=false when the original record omitted it.
  if (env.watch === undefined) env.watch = false;
  const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
  return JSON.stringify(sorted(env));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function durablePrivateJSON(file, value) {
  privateJSON(file, value);
  for (const path of [file, dirname(file)]) {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}
const alive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const execute = (file, args, options = {}) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 10000, maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr })); else resolve({ stdout, stderr });
  });
});

export function supervisorSocketListening(path, timeoutMs = 2000) {
  return new Promise(resolve => {
    const socket = connect(path);
    const timer = setTimeout(() => done(null), timeoutMs);
    const done = value => { clearTimeout(timer); socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', error => done(['ENOENT', 'ENOTDIR', 'ECONNREFUSED', 'ENOTSOCK', 'EINVAL'].includes(error.code) ? false : null));
  });
}

export function productSupervisorPlan(homeRoot) {
  homeRoot = absoluteHome(homeRoot);
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || uid <= 0) throw ambiguous('A resident supervisor requires a non-root owner account.');
  const env = productEnvironment(homeRoot);
  const label = `com.home23.resident.${createHash('sha256').update(homeRoot).digest('hex').slice(0, 32)}`;
  const domain = `gui/${uid}`;
  return { homeRoot, uid, label, domain, service: `${domain}/${label}`, env,
    node: join(homeRoot, 'bin/node'), module: join(homeRoot, 'app/cli/lib/product-supervisor.js'),
    daemon: join(homeRoot, 'tools/node_modules/pm2/lib/Daemon.js'),
    claim: join(env.PM2_HOME, 'supervisor-launchd.json'), plist: join(env.PM2_HOME, 'supervisor-launchd.plist'),
    owner: join(env.PM2_HOME, 'supervisor-owner.json'), migration: join(env.PM2_HOME, 'supervisor-migration.json') };
}
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function supervisorPlist(plan, token) {
  const str = value => `<string>${xml(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>
<key>Label</key>${str(plan.label)}
<key>ProgramArguments</key><array>${[plan.node, plan.module, '--resident-daemon', plan.homeRoot, token].map(str).join('')}</array>
<key>WorkingDirectory</key>${str(join(plan.homeRoot, 'app'))}
<key>EnvironmentVariables</key><dict>${Object.entries(plan.env).map(([k, v]) => `<key>${xml(k)}</key>${str(v)}`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>
<key>ProcessType</key><string>Interactive</string><key>Umask</key><integer>63</integer>
<key>ExitTimeOut</key><integer>240</integer>
<key>StandardOutPath</key>${str(join(plan.env.PM2_HOME, 'pm2.log'))}
<key>StandardErrorPath</key>${str(join(plan.env.PM2_HOME, 'pm2.log'))}
</dict></plist>\n`;
}
function claimFor(plan) {
  const claim = readPrivateJSON(plan.claim);
  if (!claim) return null;
  if (existsSync(plan.plist)) {
    const stat = lstatSync(plan.plist);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== plan.uid || (stat.mode & 0o077)) throw ambiguous('The supervisor plist must be an owner-private regular file.');
  }
  if (claim.schema !== 'home23.supervisor.launchd.v1' || claim.homeRoot !== plan.homeRoot || claim.service !== plan.service ||
      !/^[a-f0-9-]{36}$/.test(claim.token || '') || (existsSync(plan.plist) && readFileSync(plan.plist, 'utf8') !== supervisorPlist(plan, claim.token))) {
    throw ambiguous('This home has a conflicting supervisor ownership claim. No service was changed.');
  }
  return claim;
}
function pidFor(plan) {
  try {
    const raw = readFileSync(join(plan.env.PM2_HOME, 'pm2.pid'), 'utf8').trim();
    if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw ambiguous('The private supervisor PID is invalid.');
    return Number(raw);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function loaded(plan, deps) {
  let stdout;
  try { ({ stdout } = await (deps.execute || execute)('/bin/launchctl', ['list', plan.label])); }
  catch (error) { if ([3, 113].includes(error.code)) return { loaded: false, pid: null }; throw ambiguous('Cannot inspect the home-specific launchd service.'); }
  // list's per-job dictionary reports the job PID. Read only top-level fields;
  // unknown output fails closed. Do not parse print's diagnostic-only format.
  const labels = [...String(stdout).matchAll(/^\t"Label" = "([^"\n]+)";$/gm)];
  const pids = [...String(stdout).matchAll(/^\t"PID" = ([1-9][0-9]*);$/gm)];
  if (labels.length !== 1 || labels[0][1] !== plan.label || pids.length > 1 ||
      (pids.length && !Number.isSafeInteger(Number(pids[0][1])))) throw ambiguous('The launchd job PID could not be verified.');
  return { loaded: true, pid: pids.length ? Number(pids[0][1]) : null };
}
async function identity(plan, pid, deps) {
  if (deps.identity) return deps.identity(plan, pid);
  const exec = deps.execute || execute;
  const { stdout: birth } = await exec('/bin/ps', ['-p', String(pid), '-o', 'uid=,lstart=']);
  if (!birth.trim().startsWith(`${plan.uid} `)) throw ambiguous('The supervisor PID belongs to a different owner.');
  const { stdout: files } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fn']);
  let executable = plan.node;
  if (!files.split('\n').includes(`n${plan.node}`)) {
    const updateRoot = join(dirname(plan.homeRoot), `.${basename(plan.homeRoot)}.home23-update`);
    executable = join(updateRoot, 'previous/bin/node');
    if (!files.split('\n').includes(`n${executable}`)) throw ambiguous('The supervisor PID is not this home\'s current or admitted retained Node executable.');
    const journal = readPrivateJSON(join(updateRoot, 'journal.json'));
    const snapshot = journal?.supervisorAdmission;
    if (journal?.schema !== 'home23.product-update.v1' || journal.homeRoot !== plan.homeRoot ||
        !['selected', 'verifying'].includes(journal.phase) || journal.candidateStarted !== false || journal.acceptedWork === true ||
        !journal.ownerToken || snapshot?.expectedPid !== pid || snapshot.generation !== birth.trim()) {
      throw ambiguous('The retained supervisor executable has no current pre-writer update admission.');
    }
    const previous = join(updateRoot, 'previous');
    const manifest = readProductManifest(previous), receipt = readPrivateJSON(join(previous, '.home23-install.json'));
    const node = manifest.files.find(entry => entry.path === 'bin/node' && entry.type === 'file');
    const stat = lstatSync(executable);
    if (!node || manifest.packageId !== journal.fromPackageId || receipt?.packageId !== journal.fromPackageId ||
        !stat.isFile() || stat.isSymbolicLink() || stat.uid !== plan.uid || stat.size !== node.size ||
        createHash('sha256').update(readFileSync(executable)).digest('hex') !== node.sha256) {
      throw ambiguous('The retained supervisor executable differs from the admitted previous package.');
    }
  }
  const { stdout: sockets } = await exec('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-U', '-Fn']);
  const names = sockets.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1).replace(/^\/private\/tmp\//, '/tmp/'));
  if (![plan.env.PM2_DAEMON_RPC_PORT, plan.env.PM2_DAEMON_PUB_PORT].every(path => names.includes(path))) throw ambiguous('The supervisor PID does not own this home\'s canonical sockets.');
  return { generation: birth.trim(), executable };
}

/** Metadata and socket inspection only. It never creates a daemon or loads a job. */
export async function inspectProductSupervisor(homeRoot, deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') return { ownership: 'not_required' };
  const plan = productSupervisorPlan(homeRoot), claim = claimFor(plan);
  const listening = deps.listening || supervisorSocketListening;
  const canonical = await listening(plan.env.PM2_DAEMON_RPC_PORT);
  if (canonical === null || await listening(join(plan.env.PM2_HOME, 'rpc.sock')) !== false) throw ambiguous('A private supervisor socket is ambiguous or noncanonical.');
  const pid = pidFor(plan), isAlive = deps.alive || alive;
  const job = await loaded(plan, deps), jobLoaded = job.loaded;
  if (!canonical) {
    if (pid && isAlive(pid)) {
      const owner = readPrivateJSON(plan.owner);
      if (!claim || !jobLoaded || job.pid !== pid || owner?.token !== claim.token || owner?.pid !== pid) throw ambiguous('A supervisor PID is still alive without its canonical socket.');
    }
    if (jobLoaded && !claim) throw ambiguous('An unclaimed launchd service already uses this home\'s label.');
    return { ownership: jobLoaded ? 'starting' : 'absent', plan, pid };
  }
  if (!pid || !isAlive(pid) || await listening(plan.env.PM2_DAEMON_PUB_PORT) !== true) throw ambiguous('The answering supervisor has no verifiable PID and socket pair.');
  const proof = await identity(plan, pid, deps);
  const generation = typeof proof === 'string' ? proof : proof.generation;
  const executable = typeof proof === 'string' ? plan.node : proof.executable;
  const owner = readPrivateJSON(plan.owner);
  if (jobLoaded && job.pid === pid && (await loaded(plan, deps)).pid === pid && claim && owner?.schema === 'home23.supervisor.owner.v1' && owner.token === claim.token &&
      owner.homeRoot === plan.homeRoot && owner.pid === pid && owner.parentPid === 1) {
    return { ownership: 'launchd', plan, pid, jobPid: job.pid, generation, executable };
  }
  if (jobLoaded) throw ambiguous('A launchd service and an unowned supervisor conflict.');
  return { ownership: 'legacy', plan, pid, generation, executable };
}

/** Explicit Start only. Existing unowned daemons require admitted migration. */
export async function ensureProductSupervisor(homeRoot, deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') return { ownership: 'not_required' };
  const plan = productSupervisorPlan(homeRoot);
  productEnvironment(homeRoot, { prepare: true });
  const unlock = acquireInstallLock(join(plan.env.PM2_HOME, '.supervisor-ownership.lock'));
  try {
    let status = await inspectProductSupervisor(homeRoot, deps);
    if (status.ownership === 'launchd' && status.executable === plan.node) return status;
    if (status.ownership === 'launchd') throw fail('host_supervisor_adoption_required', 'The admitted update must hand off the supervisor to the selected Node binary before Start.');
    if (status.ownership === 'legacy') throw fail('host_supervisor_adoption_required', 'This home\'s supervisor needs an admitted update to establish background ownership.');
    for (const file of [plan.node, plan.module, plan.daemon]) if (!existsSync(file)) throw ambiguous('The packaged resident supervisor is incomplete.');
    let claim = claimFor(plan);
    if (!claim) {
      claim = { schema: 'home23.supervisor.launchd.v1', homeRoot: plan.homeRoot, service: plan.service, token: randomUUID() };
      privateJSON(plan.claim, claim);
    }
    if (!existsSync(plan.plist)) writeFileSync(plan.plist, supervisorPlist(plan, claim.token), { mode: 0o600, flag: 'wx' });
    const exec = deps.execute || execute;
    if (status.ownership === 'absent') await exec('/bin/launchctl', ['bootstrap', plan.domain, plan.plist]);
    else await exec('/bin/launchctl', ['kickstart', plan.service]); // Never -k: no existing PID is killed.
    const deadline = Date.now() + Math.min(deps.timeoutMs ?? 15000, 30000);
    do {
      status = await inspectProductSupervisor(homeRoot, deps);
      if (status.ownership === 'launchd') return status;
      await (deps.sleep || sleep)(deps.pollMs ?? 100);
    } while (Date.now() < deadline);
    throw fail('host_supervisor_start_pending', 'The home-specific launchd supervisor has not finished starting. Its claim is preserved.');
  } finally { unlock(); }
}

/** The client guard makes a lost daemon connection fail instead of auto-spawning. */
export async function productSupervisorCommand(homeRoot, args, deps = {}) {
  if (!Array.isArray(args) || !['jlist', 'start', 'restart', 'stop', 'delete'].includes(args[0]) || args.includes('all') || args.includes('--no-daemon')) throw ambiguous('Unsupported home supervisor command.');
  const plan = productSupervisorPlan(homeRoot);
  // PM2's constructor creates directories before connecting. Admit only an
  // already prepared private home, including for read-only jlist.
  for (const file of [join(plan.homeRoot, 'runtime'), plan.env.HOME, plan.env.PM2_HOME, plan.env.TMPDIR]) {
    let stat; try { stat = lstatSync(file); } catch { throw ambiguous('The private supervisor runtime is not prepared.'); }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== plan.uid || (stat.mode & 0o077)) throw ambiguous('The private supervisor runtime is not owner-private.');
  }
  try { return await (deps.execute || execute)(plan.node, [SELF, '--resident-client', plan.homeRoot, ...args], {
    cwd: join(plan.homeRoot, 'app'), env: productEnvironment(plan.homeRoot, deps.environmentOptions),
    timeout: args[0] === 'stop' ? 240000 : 45000, maxBuffer: 8 * 1024 * 1024,
  }); } catch (error) {
    if (error.code === 75) throw ambiguous('The private supervisor connection was lost. This client did not create a daemon.');
    throw error;
  }
}

/** Only a matching, pre-writer-admission update token authorizes legacy adoption.
 * registrations are the full pre-quiescence PM2 rows, not a names-only inventory.
 * Return pausedNames so the coordinator can preserve paused roles during Start. */
export async function adoptProductSupervisor(homeRoot, admission, deps = {}) {
  if ((deps.platform || process.platform) !== 'darwin') return { ownership: 'not_required' };
  const plan = productSupervisorPlan(homeRoot);
  const journalFile = join(dirname(plan.homeRoot), `.${basename(plan.homeRoot)}.home23-update/journal.json`);
  const admit = () => {
    const journal = readPrivateJSON(journalFile);
    if (!journal || journal.id !== admission?.updateId || !admission?.updateOwnerToken || journal.ownerToken !== admission.updateOwnerToken || journal.homeRoot !== plan.homeRoot ||
        !['selected', 'verifying'].includes(journal.phase) || journal.candidateStarted !== false || journal.acceptedWork === true) {
      throw fail('host_supervisor_admission_required', 'Supervisor adoption requires the current update\'s pre-writer admission.');
    }
    return journal;
  };
  const journal = admit();
  if (admission.updateId !== journal.id) throw fail('host_supervisor_admission_required', 'The registration snapshot belongs to another update.');
  const state = readPrivateJSON(join(plan.homeRoot, '.home23-host.json'));
  const { ownedProcessNamesForState, safeProcesses } = await import('./product-host.js');
  const names = ownedProcessNamesForState(state), owned = rows => Array.isArray(rows) && new Set(rows.map(r => r.name)).size === rows.length &&
    safeProcesses(rows, homeRoot, names, state.continuationServices || []).every(r => r.owned && ['online', 'stopped', 'errored'].includes(r.status)) && rows.every(r => names.includes(r.name));
  if (!owned(admission.registrations)) throw ambiguous('The admitted supervisor registrations contain unowned or ambiguous roles.');
  const command = deps.command || ((args) => productSupervisorCommand(homeRoot, args));
  const list = async () => JSON.parse((await command(['jlist', '--silent'])).stdout);
  const match = (a, b) => registrationDefinition(a) === registrationDefinition(b);
  const unlock = acquireInstallLock(join(plan.env.PM2_HOME, '.supervisor-migration.lock'));
  try {
    let status = await inspectProductSupervisor(homeRoot, deps);
    let saved = readPrivateJSON(plan.migration);
    if ((!saved || saved.updateId !== journal.id) && status.ownership === 'launchd') {
      if (status.pid !== admission.expectedPid || status.generation !== admission.generation) throw ambiguous('The independent supervisor generation changed after admission.');
      const rows = await list();
      if (!owned(rows) || rows.length !== admission.registrations.length || rows.some(r => r.pm2_env.status !== 'stopped' || r.pid > 0 || !admission.registrations.some(s => s.name === r.name && match(r, s)))) throw ambiguous('The independent supervisor was not quiesced with its admitted registrations.');
    }
    if (saved && saved.updateId !== journal.id) {
      if (saved.schema !== 'home23.supervisor.migration.v1' || saved.homeRoot !== homeRoot || saved.phase !== 'registered' || !owned(saved.registrations)) throw ambiguous('Another update has an unfinished or invalid supervisor migration.');
      const archive = join(plan.env.PM2_HOME, `supervisor-migration.${createHash('sha256').update(saved.updateId).digest('hex').slice(0, 32)}.json`);
      if (existsSync(archive)) throw ambiguous('The prior migration archive already exists; preserve and inspect both receipts.');
      renameSync(plan.migration, archive);
      saved = null;
    }
    if (status.ownership === 'launchd' && status.executable === plan.node && !saved) {
      return { ownership: 'launchd', updateId: journal.id, pid: status.pid, pausedNames: admission.registrations.filter(r => ['stopped', 'errored'].includes(r.pm2_env.status)).map(r => r.name) };
    }
    if (!saved) {
      if (!['legacy', 'launchd'].includes(status.ownership) || status.pid !== admission.expectedPid || status.generation !== admission.generation) throw ambiguous('The admitted supervisor generation changed before handoff.');
      const rows = await list();
      if (!owned(rows) || rows.length !== admission.registrations.length || rows.some(r => !admission.registrations.some(s => s.name === r.name && match(r, s)))) throw ambiguous('Supervisor registrations changed after update admission.');
      saved = { schema: 'home23.supervisor.migration.v1', homeRoot, updateId: journal.id, oldPid: status.pid, generation: status.generation,
        phase: 'captured', registrations: admission.registrations, pausedNames: admission.registrations.filter(r => ['stopped', 'errored'].includes(r.pm2_env.status)).map(r => r.name) };
      durablePrivateJSON(plan.migration, saved);
    }
    if (saved.phase === 'captured') {
      if (['legacy', 'launchd'].includes(status.ownership)) {
        if (status.pid !== saved.oldPid || status.generation !== saved.generation) throw ambiguous('The legacy supervisor generation changed.');
        for (const name of writerStopOrder(saved.registrations.map(r => r.name))) { admit(); await command(['stop', name, '--silent']); }
        const rows = await list();
        if (!owned(rows) || rows.length !== saved.registrations.length || rows.some(r => r.pm2_env.status !== 'stopped' || !saved.registrations.some(s => s.name === r.name && match(r, s)))) throw ambiguous('Owned roles did not quiesce with their saved registrations.');
        admit(); status = await inspectProductSupervisor(homeRoot, deps);
        if (status.pid !== saved.oldPid || status.generation !== saved.generation) throw ambiguous('The supervisor generation changed before shutdown.');
        (deps.signal || process.kill)(status.pid, 'SIGINT'); // Exact validated PID; never SIGKILL or a group.
        const deadline = Date.now() + Math.min(deps.shutdownTimeoutMs ?? 30000, 240000);
        while ((deps.alive || alive)(saved.oldPid) && Date.now() < deadline) await (deps.sleep || sleep)(deps.pollMs ?? 100);
        if ((deps.alive || alive)(saved.oldPid)) throw fail('host_supervisor_shutdown_pending', 'The old supervisor has not exited. No replacement daemon was created.');
      } else if (!['absent', 'starting'].includes(status.ownership) || (deps.alive || alive)(saved.oldPid)) throw ambiguous('The retained migration no longer matches the old supervisor.');
      saved = { ...saved, phase: 'old_exited' }; durablePrivateJSON(plan.migration, saved);
    }
    admit();
    status = await ensureProductSupervisor(homeRoot, deps);
    let current = await list();
    if (!owned(current) || current.some(r => r.pm2_env.status !== 'stopped' || r.pid > 0 || !saved.registrations.some(s => s.name === r.name && match(r, s)))) throw ambiguous('The current supervisor has unadmitted or changed registrations.');
    if (current.length !== saved.registrations.length) {
      await (deps.restore || restoreRegistrations)(homeRoot, saved.registrations);
      const rows = await list();
      if (!owned(rows) || rows.length !== saved.registrations.length || rows.some(r => r.pm2_env.status !== 'stopped' || !saved.registrations.some(s => s.name === r.name && match(r, s)))) throw ambiguous('Restored registrations do not match the captured supervisor.');
    }
    if (saved.phase !== 'registered' || saved.pid !== status.pid) { saved = { ...saved, phase: 'registered', pid: status.pid }; durablePrivateJSON(plan.migration, saved); }
    return { ownership: 'launchd', updateId: saved.updateId, pid: status.pid, previousPid: saved.oldPid, pausedNames: saved.pausedNames, snapshotPath: plan.migration };
  } finally { unlock(); }
}

function forbidClientSpawn(require) {
  const Client = require('./lib/Client.js');
  Client.prototype.launchDaemon = function(opts, cb) {
    // PM2's CLI can ignore its connection callback's error. End this isolated
    // client immediately rather than leaving timers alive or entering a retry.
    console.error('host_supervisor_unavailable: this client cannot create a daemon.');
    process.exit(75);
  };
  return Client;
}
async function restoreRegistrations(homeRoot, rows) {
  const plan = productSupervisorPlan(homeRoot);
  const file = join(plan.env.PM2_HOME, 'supervisor-register.json');
  privateJSON(file, rows);
  await execute(plan.node, [SELF, '--resident-register', homeRoot, file], { cwd: join(homeRoot, 'app'), env: plan.env, timeout: 45000 });
}
async function worker() {
  const [mode, homeRoot, value, ...rest] = process.argv.slice(2);
  if (!['--resident-daemon', '--resident-client', '--resident-register'].includes(mode)) return;
  const plan = productSupervisorPlan(homeRoot);
  for (const [key, expected] of Object.entries(plan.env)) if (process.env[key] !== expected && !key.startsWith('HOME23_EMBEDDER')) throw ambiguous('Resident worker environment differs from this home.');
  const require = createRequire(join(homeRoot, 'tools/node_modules/pm2/package.json'));
  if (mode === '--resident-daemon') {
    const claim = claimFor(plan);
    if (!claim || value !== claim.token || process.ppid !== 1) throw ambiguous('Only launchd may create the resident daemon.');
    privateJSON(plan.owner, { schema: 'home23.supervisor.owner.v1', homeRoot, token: value, pid: process.pid, parentPid: process.ppid });
    const Daemon = require('./lib/Daemon.js');
    process.title = `Home23 resident supervisor (${homeRoot})`;
    new Daemon().start(); // Foreground: no PM2 client daemonization.
  } else if (mode === '--resident-client') {
    forbidClientSpawn(require);
    process.argv = [process.execPath, join(homeRoot, 'tools/node_modules/pm2/bin/pm2'), value, ...rest];
    require('./bin/pm2');
  } else {
    const rows = readPrivateJSON(value), Client = forbidClientSpawn(require), client = new Client({ pm2_home: plan.env.PM2_HOME });
    await new Promise((resolve, reject) => client.start(err => err ? reject(err) : resolve()));
    const current = await new Promise((resolve, reject) => client.executeRemote('getMonitorData', {}, (e, data) => e ? reject(e) : resolve(data)));
    for (const row of rows) {
      const existing = current.find(r => r.name === row.name);
      if (existing) continue; // Parent validates the complete inventory after registration.
      const env = structuredClone(row.pm2_env);
      delete env.pm_id;
      // PM2 prepare's standalone stopped-record path registers without running
      // it and retains autostart. Setting autostart=false would make a later
      // ordinary restart silently remain stopped. Duplicate-name instances
      // were refused at admission; each record represents one process.
      delete env.instances;
      env.status = 'stopped';
      await new Promise((resolve, reject) => client.executeRemote('prepare', env, (e, data) => e ? reject(e) : resolve(data)));
    }
    await new Promise(resolve => client.close(resolve));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) worker().catch(error => { console.error(error.code || 'host_supervisor_failed', error.message); process.exit(1); });
