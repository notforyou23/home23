#!/usr/bin/env node
/** Independent product-home harness restart queue. No shell/command payloads. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const terminal = new Set(['succeeded', 'failed', 'expired', 'interrupted', 'cancelled']);
const digest = value => createHash('sha256').update(value).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function maintenancePaths(home) {
  if (!path.isAbsolute(home) || path.resolve(home) !== home || home === '/' || fs.realpathSync(home) !== home) throw new Error('Choose a real absolute product home');
  const dir = path.join(home, 'runtime/maintenance');
  return { home, dir, queue: path.join(dir, 'requests'), installed: path.join(dir, 'installed.json'), policy: path.join(dir, 'policy.json') };
}
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const s = fs.lstatSync(dir);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077)) throw new Error('Maintenance directory must be owner-private');
}
function write(file, value) {
  if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw new Error('Unsafe maintenance file');
  const temp = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
async function locked(home, operation) {
  const p = maintenancePaths(home); privateDir(p.dir); privateDir(p.queue);
  const db = new DatabaseSync(path.join(p.dir, 'queue-lock.sqlite3'));
  try {
    db.exec('CREATE TABLE IF NOT EXISTS lock (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE');
    return await operation(p);
  } finally { db.close(); }
}
function policy(p) {
  const v = read(p.policy);
  if (v.enabled !== true || v.allowHarnessRestart !== true || !Array.isArray(v.residents)) throw new Error('Harness maintenance policy is not enabled');
  return v;
}
function packageId(home) {
  const v = read(path.join(home, '.home23-install.json'));
  if (v.status !== 'installed' || v.homeRoot !== home || !/^[a-f0-9]{64}$/.test(v.packageId)) throw new Error('Product installation is unavailable');
  return v.packageId;
}
function requests(p) {
  return fs.readdirSync(p.queue).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => read(path.join(p.queue, n)));
}
async function modules(home) {
  const load = relative => import(pathToFileURL(path.join(home, 'app', relative)).href);
  return { ...(await load('cli/lib/product-supervisor.js')), ...(await load('cli/lib/product-backup.js')),
    ...(await load('cli/lib/product-environment.js')), ...(await load('scripts/release/rebind.mjs')),
    ...(await load('scripts/release/supervisor.mjs')) };
}
export function checkedTarget(home, resident, rows) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(resident || '')) throw new Error('Invalid resident');
  const name = `home23-${resident}-harness`, matches = rows.filter(r => r.name === name), row = matches[0], e = row?.pm2_env;
  if (matches.length !== 1 || e.status !== 'online' || !row.pid || e.pm_exec_path !== path.join(home, 'bin/node')
    || e.pm_cwd !== path.join(home, 'app') || !Array.isArray(e.args) || e.args.at(-1) !== path.join(home, 'app/dist/home.js')
    || e.HOME23_AGENT !== resident) throw new Error('Resident registration is not uniquely aligned and online');
  return row;
}
function binding(row) {
  const e = row.pm2_env;
  return digest(JSON.stringify({ script: e.pm_exec_path, cwd: e.pm_cwd, args: e.args, interpreter: e.exec_interpreter, env: e.env }));
}
export function validateRestartRequest(r, selectedPackage, now = Date.now()) {
  if (r.action !== 'restart-harness' || !/^[a-f0-9-]{36}$/.test(r.id || '') || !/^[a-z][a-z0-9-]{0,62}$/.test(r.resident || '')
    || r.packageId !== selectedPackage || !/^[a-f0-9]{64}$/.test(r.binding || '')
    || typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 1000
    || ![r.createdAt,r.notBefore,r.expiresAt].every(Number.isFinite) || r.createdAt > now + 5000
    || r.notBefore < r.createdAt + 30000 || r.expiresAt <= r.notBefore || r.expiresAt - r.createdAt > 86400000) throw new Error('Invalid or stale-package request');
  if (now >= r.expiresAt) throw new Error('Restart request expired');
}
export async function requestRestart(home, resident, reason, deps = {}) {
  return locked(home, async p => {
    const allowed = policy(p); if (!allowed.residents.includes(resident)) throw new Error('Resident is outside maintenance policy');
    const m = deps.modules || await modules(home);
    const rows = JSON.parse((await m.productSupervisorInventory(home)).stdout), target = checkedTarget(home, resident, rows), selected = packageId(home);
    const now = deps.now?.() ?? Date.now();
    const r = { id: randomUUID(), action: 'restart-harness', resident, reason, packageId: selected, binding: binding(target),
      createdAt: now, notBefore: now + 30000, expiresAt: now + 86400000, state: 'queued' };
    validateRestartRequest(r, selected, now);
    const prior = requests(p).find(r => !terminal.has(r.state) && r.resident === resident && r.packageId === selected);
    if (prior) return prior;
    write(path.join(p.queue, r.id + '.json'), r); return r;
  });
}
async function lease(home, row, id, method = 'POST') {
  const token = row.pm2_env.BRIDGE_TOKEN;
  const port = Number(row.pm2_env.BRIDGE_PORT);
  if (!token || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Resident maintenance bridge is unavailable');
  const response = await fetch(`http://127.0.0.1:${port}/api/maintenance/lease`, { method, signal: AbortSignal.timeout(5000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id }) });
  if (!response.ok) throw new Error(`Resident maintenance admission refused (${response.status})`);
  return response.json();
}
async function ready(home, row, resident) {
  const load = relative => import(pathToFileURL(path.join(home, 'app/dist', relative)).href);
  const { loadCoordinationRuntimeConfig } = await load('coordination/app/runtime-config.js');
  const { createResidentCredential } = await load('coordination/resident-protocol/index.js');
  const { ResidentUdsClient } = await load('coordination/transport/uds/index.js');
  const { ResidentUdsAgentPort } = await load('coordination-adapter/index.js');
  const { generateCoordinationId } = await load('coordination/ids/index.js');
  const r = loadCoordinationRuntimeConfig(row.pm2_env).residents[resident];
  if (!r) throw new Error('Resident Home23 binding is unavailable');
  const key = Buffer.from(r.key, 'hex');
  const credential = createResidentCredential({ residentSlug: resident, role: 'resident', instanceId: r.clientInstanceId, keyVersion: r.keyVersion, rootKey: key }); key.fill(0);
  const agent = new ResidentUdsAgentPort({ client: new ResidentUdsClient({ socketPath: r.socketPath, serverInstanceId: r.serverInstanceId, credential }), residentSlug: resident });
  try { await agent.modelCatalog({ requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation') }); }
  finally { await agent.close(); }
}
export async function processQueue(home, deps = {}) {
  return locked(home, async p => {
    const allowed = policy(p), m = deps.modules || await modules(home), now = deps.now?.() ?? Date.now();
    for (const r of requests(p)) {
      if (terminal.has(r.state)) continue;
      const file = path.join(p.queue, r.id + '.json');
      if (r.state === 'running') { write(file, { ...r, state: 'interrupted', error: 'Worker interrupted; inspect receipt before requesting another restart' }); continue; }
      try { validateRestartRequest(r, packageId(home), now); if (!allowed.residents.includes(r.resident)) throw new Error('Policy no longer permits resident'); }
      catch (error) { write(file, { ...r, state: now >= r.expiresAt ? 'expired' : 'failed', error: error.message }); continue; }
      if (now < r.notBefore) continue;
      const lastFile = path.join(p.dir, `last-${r.resident}.json`);
      const pending = reason => { r.state = 'waiting'; r.waitingFor = reason; write(file, r); };
      if (fs.existsSync(lastFile) && now - read(lastFile).at < 3600000) { pending('restart cooldown'); continue; }
      const hostLock = m.acquireHostLock(home);
      if (!hostLock) { pending('home lifecycle operation'); continue; }
      let row, fenced = false, releaseWriters;
      try {
        const host = read(path.join(home, '.home23-host.json'));
        if (host.desiredRunning !== true) { pending('home is not intended to run'); continue; }
        releaseWriters = m.acquireSupervisorLock(path.join(home, 'app/instances/.house/maintenance'), DatabaseSync,
          { purpose: 'product-maintenance', writers: [`home23-${r.resident}-harness`] });
        if ((await m.inspectProductSupervisor(home)).ownership !== 'launchd') throw new Error('Product supervisor ownership is unavailable');
        let rows = JSON.parse((await m.productSupervisorInventory(home)).stdout);
        row = checkedTarget(home, r.resident, rows);
        m.assertIndependent([row.pid]);
        if (binding(row) !== r.binding || packageId(home) !== r.packageId) throw new Error('Requested runtime binding changed');
        const admission = await (deps.lease || lease)(home, row, r.id); fenced = true;
        if (admission.lease?.id !== r.id || !admission.active || !['runs', 'work', 'coding'].every(key => admission.active[key] === 0) || admission.lease.expiresAt < Date.now() + 45000) {
          pending('resident has active turns, Work or coding jobs'); continue;
        }
        // Re-read while turn admission is fenced and the lifecycle locks are held.
        rows = JSON.parse((await m.productSupervisorInventory(home)).stdout);
        if (checkedTarget(home,r.resident,rows).pid !== row.pid || packageId(home) !== r.packageId || binding(checkedTarget(home,r.resident,rows)) !== r.binding) throw new Error('Runtime changed before restart');
        r.state = 'running'; delete r.waitingFor; r.beforePid = row.pid; r.startedAt = new Date(now).toISOString();
        write(file, r); write(lastFile, { at: now, requestId: r.id });
        try { await m.productSupervisorCommand(home, ['restart', row.name, '--silent']); }
        catch { throw new Error('Restart command failed or response was lost; no automatic retry'); }
        const deadline = Date.now() + 45000;
        let success = false;
        do {
          rows = JSON.parse((await m.productSupervisorInventory(home)).stdout);
          try {
            const after = checkedTarget(home,r.resident,rows);
            if (after.pid === row.pid || binding(after) !== r.binding || packageId(home) !== r.packageId) throw new Error('Runtime not ready');
            await (deps.ready || ready)(home, rows.find(r=>r.name==='home23-coordination'), r.resident);
            r.afterPid = after.pid; r.signedHome23Ready = true; success = true; break;
          } catch { if (Date.now() >= deadline) break; await (deps.wait || wait)(1000); }
        } while (Date.now() < deadline);
        if (!success) throw new Error('Restart did not establish a new aligned PID and signed Home23 readiness');
        r.state = 'succeeded'; r.finishedAt = new Date().toISOString(); write(file, r);
      } catch (error) {
        if (r.state === 'running') { r.state = 'failed'; r.error = error.message; r.finishedAt = new Date().toISOString(); write(file, r); }
        else pending(error.message);
      } finally {
        if (fenced && row) { try { await (deps.lease || lease)(home,row,r.id,'DELETE'); } catch { /* Expiry also releases the lease after a lost worker. */ } }
        releaseWriters?.(); hostLock.release();
      }
    }
  });
}
export async function installMaintenance(home, residents, deps = {}) {
  const m = deps.modules || await modules(home), p = maintenancePaths(home);
  const rows = JSON.parse((await m.productSupervisorInventory(home)).stdout);
  m.assertIndependent(rows.filter(r=>r.pid).map(r=>r.pid));
  if ((await m.inspectProductSupervisor(home)).ownership !== 'launchd') throw new Error('Product supervisor is not launchd-owned');
  const code = fs.readFileSync(SELF), hash = digest(code), entry = path.join(p.dir, 'controllers', hash, 'maintenance.mjs');
  return locked(home, async p => {
    const hostLock = m.acquireHostLock(home); if (!hostLock) throw new Error('Another home lifecycle operation is active');
    try {
      for (const resident of residents) checkedTarget(home,resident,rows);
      if (!residents.length || new Set(residents).size !== residents.length) throw new Error('Choose unique installed residents');
      if (requests(p).some(r=>!terminal.has(r.state))) throw new Error('Finish pending maintenance before installing its controller');
      privateDir(path.dirname(entry));
      if (!fs.existsSync(entry)) fs.writeFileSync(entry, code, { mode: 0o600, flag: 'wx' });
      if (digest(fs.readFileSync(entry)) !== hash) throw new Error('Installed controller hash differs');
      const service = { name: 'home23-maintenance', executable: path.join(home,'bin/node'), args: [entry,'serve',home], cwd: path.join(home,'app'),
        env: {}, stateRoots: [p.dir], startOnHomeStart: true };
      const stateFile = path.join(home,'.home23-host.json'), state = read(stateFile);
      if (state.continuationServices?.some(s=>s.name===service.name && JSON.stringify(s)!==JSON.stringify(service))) throw new Error('Another maintenance controller is already configured');
      state.continuationServices = [...(state.continuationServices||[]).filter(s=>s.name!==service.name),service];
      m.privateJSON(stateFile,state);
      write(p.policy, { enabled:true, allowHarnessRestart:true, residents });
      const config = path.join(p.dir,'ecosystem.config.json');
      write(config,{ apps:[{name:service.name, script:path.relative(service.cwd,service.executable), interpreter:'none', args:service.args, cwd:service.cwd,
        env:m.productRoleEnvironment(home,m.productEnvironment(home)), autorestart:true, min_uptime:100, exp_backoff_restart_delay:2000, kill_timeout:60000, filter_env:['PM2_']}] });
      if (!rows.some(r=>r.name===service.name)) await m.productSupervisorCommand(home,['start',config,'--only',service.name,'--silent']);
      write(p.installed,{ schema:'home23.product-maintenance.v1', homeRoot:home, entry, sha256:hash, service:service.name });
      return { installed:true, entry, service:service.name };
    } finally { hostLock.release(); }
  });
}
export async function main(args = process.argv.slice(2)) {
  const [action,home,...rest] = args, p = maintenancePaths(home);
  if (action==='install' && rest.length) return installMaintenance(home,rest);
  if (action==='request' && rest.length===2) return requestRestart(home,rest[0],rest[1]);
  if (action==='status' && rest.length<=1) return fs.existsSync(p.queue) ? requests(p).filter(r=>!rest[0]||r.id===rest[0]).sort((a,b)=>b.createdAt-a.createdAt).slice(0,20) : [];
  if (action==='cancel' && /^[a-f0-9-]{36}$/.test(rest[0]||'')) return locked(home,p=>{
    const file=path.join(p.queue,rest[0]+'.json'), r=read(file); if(!terminal.has(r.state)){if(r.state==='running')throw new Error('Cannot cancel an executing restart');r.state='cancelled';write(file,r);}return r;
  });
  if (action==='serve' && !rest.length) {
    let stopping=false; process.on('SIGTERM',()=>{stopping=true});process.on('SIGINT',()=>{stopping=true});
    while(!stopping){try{await processQueue(home);write(path.join(p.dir,'worker-status.json'),{checkedAt:new Date().toISOString(),pid:process.pid});}catch(error){console.error('Maintenance waiting:',error.message);}await wait(2000);}return;
  }
  throw new Error('Usage: maintenance.mjs install HOME RESIDENT... | request HOME RESIDENT REASON | status HOME [ID] | cancel HOME ID | serve HOME');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().then(r=>{if(r!==undefined)console.log(JSON.stringify(r,null,2))}).catch(e=>{console.error(e.message);process.exitCode=1});
