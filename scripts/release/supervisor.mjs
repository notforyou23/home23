#!/usr/bin/env node
// Independent, fixed-scope managed restart worker. No arbitrary command payloads.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { status } from './status.mjs';
import { inspect, restartCommands, assertIndependent } from './rebind.mjs';
// Never pass PM2's own name/args/pm_id metadata into a nested PM2 launcher.
export function operatorEnvironment(environment = process.env) {
  return Object.fromEntries(['HOME', 'PATH', 'USER', 'LOGNAME', 'TMPDIR', 'PM2_HOME'].filter(key => environment[key] !== undefined).map(key => [key, environment[key]]));
}
const pm2 = (args, options = {}) => execFileSync('pm2', args, { ...options, env: operatorEnvironment() });
const terminal = new Set(['succeeded', 'failed', 'expired', 'interrupted']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  const temp = file + '.next';
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
};
export function validateRequest(request, releaseId, now = Date.now()) {
  if (request.action !== 'restart-managed' || !/^[a-f0-9-]{36}$/.test(request.id || '') ||
      request.releaseId !== releaseId || typeof request.reason !== 'string' || !request.reason.trim() || request.reason.length > 1000 ||
      !Number.isFinite(request.createdAt) || !Number.isFinite(request.notBefore) || !Number.isFinite(request.expiresAt) ||
      request.notBefore < request.createdAt || request.expiresAt <= request.notBefore || request.expiresAt - request.createdAt > 86400000 ||
      request.createdAt > now + 5000) throw new Error('Invalid or stale-release restart request');
  if (now >= request.expiresAt) throw new Error('Restart request expired');
}
function directory(root) { return path.join(root, 'instances/.house/maintenance'); }
function policy(root) {
  const value = read(path.join(directory(root), 'policy.json'));
  if (value.enabled !== true || value.allowManagedRestart !== true) throw new Error('Managed restart policy is not enabled');
  return value;
}
export function requestRestart(root, reason, getStatus = status) {
  policy(root);
  const current = getStatus(root);
  if (!current.ok) throw new Error('Release definitions or services are unhealthy; inspect before requesting restart');
  const dir = directory(root), queue = path.join(dir, 'requests');
  fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(queue).filter(n => n.endsWith('.json'))) {
    const pending = read(path.join(queue, name));
    if (!terminal.has(pending.state) && pending.releaseId === current.releaseId) return pending;
  }
  const now = Date.now();
  const request = { id: randomUUID(), action: 'restart-managed', releaseId: current.releaseId,
    reason, createdAt: now, notBefore: now + 30000, expiresAt: now + 86400000, state: 'queued' };
  validateRequest(request, current.releaseId, now);
  // Publish only complete requests; worker never reads temporary files.
  write(path.join(queue, request.id + '.json'), request);
  return request;
}
async function readiness(root, release) {
  const rows = JSON.parse(pm2(['jlist'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const core = rows.find(p => p.name === 'home23-coordination');
  const load = relative => import(pathToFileURL(path.join(release, 'dist', relative)).href);
  const { loadCoordinationRuntimeConfig } = await load('coordination/app/runtime-config.js');
  const { createResidentCredential } = await load('coordination/resident-protocol/index.js');
  const { ResidentUdsClient } = await load('coordination/transport/uds/index.js');
  const { ResidentUdsAgentPort } = await load('coordination-adapter/index.js');
  const { generateCoordinationId } = await load('coordination/ids/index.js');
  const config = loadCoordinationRuntimeConfig(core.pm2_env), residents = [];
  for (const [slug, r] of Object.entries(config.residents)) {
    const key = Buffer.from(r.key, 'hex');
    const credential = createResidentCredential({ residentSlug: slug, role: 'resident', instanceId: r.clientInstanceId, keyVersion: r.keyVersion, rootKey: key });
    key.fill(0);
    const agent = new ResidentUdsAgentPort({ client: new ResidentUdsClient({ socketPath: r.socketPath, serverInstanceId: r.serverInstanceId, credential }), residentSlug: slug });
    try { await agent.modelCatalog({ requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation') }); residents.push(slug); }
    finally { await agent.close(); }
  }
  const response = await fetch(`http://${config.host === '::1' ? '[::1]' : config.host}:${config.port}/api/v1/bootstrap`, { signal: AbortSignal.timeout(10000) });
  if (![200, 401].includes(response.status)) throw new Error('Coordinator HTTP readiness failed');
  return { signedResidents: residents, httpListening: true };
}
// An operator may select a verified new package before calling this operation.
// The resident queue deliberately only restarts the already selected release.
export async function restartManaged(root, receiptFile) {
  const initial = status(root);
  if (!initial.ok) throw new Error('Managed release is not aligned and online');
  const inspection = inspect({ root, releaseId: initial.releaseId, expectedRunning: initial.processes.map(p => ({ name: p.name, ...p.running[0] })) });
  if (inspection.blockers.length) throw new Error(inspection.blockers.join('; '));
  if (fs.existsSync(receiptFile)) throw new Error('Restart receipt already exists');
  const rows = JSON.parse(pm2(['jlist'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
  const core = rows.find(p => p.name === 'home23-coordination');
  const names = initial.processes.map(p => p.name);
  assertIndependent(initial.processes.map(p => p.running[0].pid));
  if (core.pm2_env.autorestart !== false) throw new Error('Coordinator must use explicit supervised restart');
  const pointerFile = path.join(root, 'instances/.house/coordination/active-release.json');
  const pointer = fs.readFileSync(pointerFile);
  const definitions = [path.join(root, 'ecosystem.config.cjs'), path.join(root, 'instances/.house/coordination/ecosystem.config.cjs')];
  const hashes = definitions.map(file => createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  const assertDefinitions = () => definitions.forEach((file, index) => {
    if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hashes[index]) throw new Error('Saved launcher changed during restart');
  });
  const receipt = { startedAt: new Date().toISOString(), releaseId: initial.releaseId, state: 'draining', commands: [] };
  write(receiptFile, receipt);
  let coreExited = false;
  try {
    // Graceful drain fences new work and waits for current requests. Never SIGKILL.
    process.kill(core.pid, 'SIGINT');
    for (let i = 0; i < 900; i++) {
      try { process.kill(core.pid, 0); } catch (e) { if (e.code === 'ESRCH') { coreExited = true; break; } throw e; }
      await sleep(1000);
    }
    if (!coreExited) throw new Error('Coordinator drain exceeded 15 minutes; no forced termination');
    pm2(['stop', 'home23-coordination'], { stdio: 'pipe', timeout: 60000 });
    const require = createRequire(path.join(root, 'package.json')), Database = require('better-sqlite3');
    const db = new Database(path.join(root, 'instances/.house/coordination/home23-coordination.sqlite3'), { readonly: true, fileMustExist: true });
    try {
      const active = db.prepare("SELECT id,state FROM works WHERE state IN ('queued','leased','running','cancelling')").all();
      if (active.length) throw new Error('Nonterminal Work remains after drain; restarting original Core to resume it');
      await db.backup(receiptFile + '.sqlite3');
      const backup = new Database(receiptFile + '.sqlite3', { readonly: true });
      try { if (backup.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Backup integrity failed'); }
      finally { backup.close(); }
      receipt.backupIntegrity = 'ok';
    } finally { db.close(); }
    if (!pointer.equals(fs.readFileSync(pointerFile))) throw new Error('Release pointer changed during drain');
    // Start Core last so resident sockets are established first.
    for (const args of restartCommands(root, [...names.filter(n => n !== 'home23-coordination'), 'home23-coordination'])) {
      assertDefinitions();
      if (!pointer.equals(fs.readFileSync(pointerFile))) throw new Error('Release pointer changed during restart');
      receipt.commands.push({ args, state: 'starting' }); write(receiptFile, receipt);
      pm2(args, { stdio: 'pipe', timeout: 240000 });
      receipt.commands.at(-1).state = 'done'; write(receiptFile, receipt);
    }
    let lastError;
    for (let i = 0; i < 30; i++) {
      try {
        const current = status(root);
        if (!current.ok || current.releaseId !== initial.releaseId) throw new Error('Managed bindings not ready');
        receipt.readiness = await readiness(root, path.dirname(path.dirname(path.dirname(current.processes[0].expectedScript))));
        lastError = null; break;
      } catch (e) { lastError = e; await sleep(2000); }
    }
    if (lastError) throw lastError;
    receipt.state = 'succeeded';
  } catch (e) {
    receipt.state = 'failed'; receipt.error = e.message;
    // Before any harness replacement, restore exactly the stopped Core registration.
    // Never restore database snapshots or retry ambiguous mutations.
    if (coreExited && !receipt.commands.length && pointer.equals(fs.readFileSync(pointerFile))) {
      try { pm2(['restart', 'home23-coordination'], { stdio: 'pipe', timeout: 60000 }); receipt.coreResumed = true; }
      catch (recovery) { receipt.recoveryError = recovery.message; }
    }
    throw e;
  } finally { receipt.finishedAt = new Date().toISOString(); write(receiptFile, receipt); }
  return receipt;
}
// A separate tiny SQLite file supplies an OS-released exclusive lock. It is
// unrelated to the coordinator database and survives reboot without stale PID locks.
export function acquireSupervisorLock(dir, Database) {
  const db = new Database(path.join(dir, 'supervisor-lock.sqlite3'), {timeout:0});
  try {
    db.exec('CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY)');
    db.exec('BEGIN EXCLUSIVE');
  } catch (e) { db.close(); throw new Error('Another maintenance supervisor owns the service lock: ' + e.message); }
  return () => { db.exec('ROLLBACK'); db.close(); };
}
export async function serve(root) {
  const dir = directory(root), queue = path.join(dir, 'requests');
  fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'supervisor.lock');
  const require = createRequire(path.join(root, 'package.json'));
  const releaseLock = acquireSupervisorLock(dir, require('better-sqlite3'));
  fs.writeFileSync(lock, String(process.pid), {mode:0o600});
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  try {
    while (!stopping) {
      policy(root);
      for (const name of fs.readdirSync(queue).filter(n => /^[a-f0-9-]{36}\.json$/.test(n))) {
        const file = path.join(queue, name), request = read(file);
        if (terminal.has(request.state)) continue;
        if (request.state === 'running') { request.state = 'interrupted'; request.error = 'Previous execution interrupted; inspect receipt before another restart'; write(file, request); continue; }
        try { validateRequest(request, status(root).releaseId); }
        catch (e) { request.state = Date.now() >= request.expiresAt ? 'expired' : 'failed'; request.error = e.message; write(file, request); continue; }
        if (Date.now() < request.notBefore) continue;
        const last = path.join(dir, 'last-start.json');
        if (fs.existsSync(last) && Date.now() - read(last).at < 3600000) continue;
        const current = status(root);
        const check = inspect({ root, releaseId: current.releaseId, expectedRunning: current.processes.map(p => ({ name: p.name, ...p.running[0] })) });
        if (check.blockers.length) { request.state = 'waiting'; request.waitingFor = check.blockers; write(file, request); continue; }
        request.state = 'running'; delete request.waitingFor;
        request.receipt = path.join(dir, request.id + '-receipt.json'); write(file, request); write(last, { at: Date.now(), id: request.id });
        try { await restartManaged(root, request.receipt); request.state = 'succeeded'; }
        catch (e) { request.state = 'failed'; request.error = e.message; }
        request.finishedAt = new Date().toISOString(); write(file, request);
      }
      await sleep(5000);
    }
  } finally { fs.unlinkSync(lock); releaseLock(); }
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [mode, root, ...rest] = process.argv.slice(2);
  try {
    if (!root || !path.isAbsolute(root)) throw new Error('An absolute installation root is required');
    if (mode === 'request') console.log(JSON.stringify(requestRestart(root, rest.join(' ')), null, 2));
    else if (mode === 'status') {
      const queue = path.join(directory(root), 'requests');
      console.log(JSON.stringify(fs.existsSync(queue) ? fs.readdirSync(queue).filter(n => n.endsWith('.json')).map(n => read(path.join(queue, n))) : [], null, 2));
    } else if (mode === 'serve') await serve(root);
    else throw new Error('Usage: supervisor.mjs request|status|serve INSTALLATION_ROOT [reason]');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
