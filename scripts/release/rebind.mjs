#!/usr/bin/env node
// Re-register only managed executables whose saved definitions are verified.
// This is the restart phase of an operator cutover, not a deployment planner.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pointerProvenance, status } from './status.mjs';

const RELEASE_ID = /^[a-f0-9]{40}$/;
const SOURCE_COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SOURCE_REPOSITORIES = new Set(['home23', 'home23-apple']);
const PROVENANCE_KEYS = ['sourceCommit', 'sourceRepo', 'sourceBranch', 'sourceDirty', 'preparedAt', 'sourceProvenance'];

function unknownProvenance(reason) {
  return { sourceCommit: null, sourceRepo: null, sourceBranch: null, sourceDirty: null, preparedAt: null, sourceProvenance: reason };
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) && date.toISOString() === value;
}

function artifactInventory(root) {
  root = fs.realpathSync(root);
  const rows = [];
  const walk = (directory, prefix = '') => {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix + name, file = path.join(directory, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file, relative + '/');
      else if (stat.isSymbolicLink()) {
        const resolved = fs.realpathSync(file);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error(`Release symlink escapes root: ${relative}`);
        rows.push({ path:relative, type:'link', target:fs.readlinkSync(file) });
      } else if (stat.isFile()) {
        rows.push({ path:relative, type:'file', executable:!!(stat.mode & 0o111), bytes:stat.size,
          sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
      } else throw new Error(`Unsupported release entry: ${relative}`);
    }
  };
  walk(root);
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
}

function checkedArtifactEvidence(prepared, verificationReceipt, releaseRoot, releaseId) {
  let verification;
  try { verification = JSON.parse(fs.readFileSync(verificationReceipt, 'utf8')); }
  catch { throw new Error('Verification receipt was unavailable or invalid'); }
  if (verification.schemaVersion !== 1 || verification.ok !== true || verification.artifactUnchanged !== true
      || verification.activationReady !== false || !SHA256.test(verification.candidateDigest || '')
      || !SHA256.test(verification.baselineDigest || '') || !Array.isArray(verification.checks) || !verification.checks.length) {
    throw new Error('Verification receipt did not record complete passing artifact evidence');
  }
  if (verification.candidate !== prepared.candidate || verification.baseline !== prepared.baseline
      || verification.baselineDigest !== prepared.baselineDigest || verification.candidateDigest.slice(0, 40) !== releaseId) {
    throw new Error('Prepared artifact verification did not match the selected release');
  }
  for (const [index, check] of verification.checks.entries()) {
    const log = path.join(path.dirname(verificationReceipt), `check-${index + 1}.log`);
    let digest;
    try { digest = createHash('sha256').update(fs.readFileSync(log)).digest('hex'); }
    catch { throw new Error('Verification check log was unavailable'); }
    if (check?.exitCode !== 0 || check.error || !SHA256.test(check.logSha256 || '') || digest !== check.logSha256) {
      throw new Error('Verification check receipt changed or did not pass');
    }
  }
  let candidateDigest, baselineDigest, installedDigest;
  try {
    candidateDigest = artifactInventory(prepared.candidate);
    baselineDigest = artifactInventory(prepared.baseline);
    installedDigest = artifactInventory(releaseRoot);
  } catch (error) { throw new Error(`Cannot verify selected release contents: ${error.message}`); }
  if (candidateDigest !== verification.candidateDigest || baselineDigest !== verification.baselineDigest
      || installedDigest !== verification.candidateDigest) {
    throw new Error('Verified candidate, baseline, or selected release contents changed');
  }
  return verification.candidateDigest;
}

function preparedProvenance(preparation, verificationReceipt, releaseRoot, releaseId, unavailableReason = null) {
  if (!preparation && !verificationReceipt) {
    const reason = typeof unavailableReason === 'string' && unavailableReason.trim() === unavailableReason
      && unavailableReason.length && !/[\r\n]/.test(unavailableReason) ? unavailableReason : null;
    return unknownProvenance(reason || 'rebind plan did not provide prepared source provenance evidence');
  }
  if (!preparation || !verificationReceipt) throw new Error('Both preparation and verificationReceipt are required for source provenance');
  let prepared;
  try { prepared = JSON.parse(fs.readFileSync(path.join(preparation, 'prepared.json'), 'utf8')); }
  catch { throw new Error('prepared.json was unavailable or invalid'); }
  checkedArtifactEvidence(prepared, verificationReceipt, releaseRoot, releaseId);
  if (prepared.schemaVersion !== 1 || prepared.sourceCommit !== prepared.base || !SOURCE_COMMIT.test(prepared.sourceCommit || '')
      || !SOURCE_REPOSITORIES.has(prepared.sourceRepo) || typeof prepared.sourceBranch !== 'string'
      || !prepared.sourceBranch.trim() || typeof prepared.sourceDirty !== 'boolean' || !isIsoTimestamp(prepared.preparedAt)) {
    return unknownProvenance('prepared.json did not contain complete recorded source provenance');
  }
  return { sourceCommit: prepared.sourceCommit, sourceRepo: prepared.sourceRepo, sourceBranch: prepared.sourceBranch,
    sourceDirty: prepared.sourceDirty, preparedAt: prepared.preparedAt,
    sourceProvenance: 'prepared artifact verification matched selected release' };
}

function atomicPointerWrite(file, expected, value, mode, beforeRename = null) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.next`);
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  try {
    const descriptor = fs.openSync(temporary, 'wx', mode);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    beforeRename?.();
    if (!expected.equals(fs.readFileSync(file))) throw new Error('Release pointer changed before provenance could be recorded');
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    if (!bytes.equals(fs.readFileSync(file))) throw new Error('Release provenance readback failed');
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function withPointerWriteLock(root, operation) {
  const directory = path.join(root, 'instances/.house/maintenance');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const Database = createRequire(path.join(root, 'package.json'))('better-sqlite3');
  const database = new Database(path.join(directory, 'active-release-pointer-write.lock.sqlite3'), { timeout: 10_000 });
  try {
    database.exec('CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY)');
    database.exec('BEGIN EXCLUSIVE');
    return operation();
  } finally {
    if (database.inTransaction) database.exec('ROLLBACK');
    database.close();
  }
}

function readActivePointer(root) {
  const pointerFile = path.join(root, 'instances/.house/coordination/active-release.json');
  const stat = fs.lstatSync(pointerFile);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Active release pointer must be a regular file');
  const raw = fs.readFileSync(pointerFile);
  let pointer;
  try { pointer = JSON.parse(raw); }
  catch { throw new Error('Invalid managed release pointer'); }
  if (![1, 2].includes(pointer.schemaVersion) || !RELEASE_ID.test(pointer.releaseId || '')) throw new Error('Invalid managed release pointer');
  return { pointerFile, stat, raw, pointer };
}

export function plannedActiveReleaseProvenance({ root, releaseId, preparation = null, verificationReceipt = null,
  sourceProvenanceUnavailable = null }) {
  root = fs.realpathSync(root);
  if (!RELEASE_ID.test(releaseId || '')) throw new Error('Invalid selected releaseId');
  const { pointer } = readActivePointer(root);
  if (pointer.releaseId !== releaseId) throw new Error('Provenance annotation does not select a release');
  const releaseRoot = fs.realpathSync(path.join(root, 'instances/.house/coordination/releases', releaseId));
  if (PROVENANCE_KEYS.some(key => Object.hasOwn(pointer, key))) return pointerProvenance(pointer);
  return preparedProvenance(preparation, verificationReceipt, releaseRoot, releaseId, sourceProvenanceUnavailable);
}

export function assertActiveReleaseProvenancePlan({ root, releaseId, preparation = null, verificationReceipt = null,
  sourceProvenanceUnavailable = null }) {
  root = fs.realpathSync(root);
  const { pointer } = readActivePointer(root);
  if (pointer.releaseId !== releaseId) throw new Error('Provenance annotation does not select a release');
  if (PROVENANCE_KEYS.some(key => Object.hasOwn(pointer, key))) return pointerProvenance(pointer);
  if (!preparation && !verificationReceipt && !(typeof sourceProvenanceUnavailable === 'string'
      && sourceProvenanceUnavailable.trim() === sourceProvenanceUnavailable && sourceProvenanceUnavailable.length
      && !/[\r\n]/.test(sourceProvenanceUnavailable))) {
    throw new Error('Rebind plan must provide preparation and verificationReceipt, or an explicit sourceProvenanceUnavailable reason');
  }
  const releaseRoot = fs.realpathSync(path.join(root, 'instances/.house/coordination/releases', releaseId));
  return preparedProvenance(preparation, verificationReceipt, releaseRoot, releaseId, sourceProvenanceUnavailable);
}

export function writeActiveReleaseProvenance(options) {
  const root = fs.realpathSync(options.root);
  return withPointerWriteLock(root, () => {
    const { pointerFile, stat, raw, pointer } = readActivePointer(root);
    if (pointer.releaseId !== options.releaseId) throw new Error('Provenance annotation does not select a release');
    const releaseRoot = fs.realpathSync(path.join(root, 'instances/.house/coordination/releases', options.releaseId));
    const alreadyRecorded = PROVENANCE_KEYS.some(key => Object.hasOwn(pointer, key));
    const provenance = alreadyRecorded
      ? pointerProvenance(pointer)
      : assertActiveReleaseProvenancePlan(options);
    const next = { ...pointer, ...Object.fromEntries(PROVENANCE_KEYS.map(key => [key, provenance[key]])) };
    if (!raw.equals(Buffer.from(JSON.stringify(next, null, 2) + '\n'))) {
      const recheck = alreadyRecorded ? null : () => {
        const current = preparedProvenance(options.preparation, options.verificationReceipt, releaseRoot, options.releaseId,
          options.sourceProvenanceUnavailable);
        if (JSON.stringify(current) !== JSON.stringify(provenance)) throw new Error('Source provenance evidence changed before pointer write');
      };
      atomicPointerWrite(pointerFile, raw, next, stat.mode & 0o777, recheck);
    }
    return next;
  });
}

export function assertIndependent(targetPids, pid = process.pid, parentOf = id =>
  Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(id)], { encoding: 'utf8' }).trim())) {
  const seen = new Set();
  while (pid > 1) {
    if (targetPids.includes(pid)) throw new Error('Refusing managed restart from a target process descendant; use an independent operator terminal after this coding job completes');
    if (seen.has(pid)) throw new Error('Cannot establish process ancestry');
    seen.add(pid);
    pid = parentOf(pid);
    if (!Number.isInteger(pid) || pid < 1) throw new Error('Cannot establish process ancestry');
  }
}

export function restartCommands(root, names) {
  return names.flatMap(name => {
    if (!['home23-coordination', 'home23-jerry-harness', 'home23-forrest-harness'].includes(name)) throw new Error('Unmanaged process in restart plan');
    const config = name === 'home23-coordination'
      ? path.join(root, 'instances/.house/coordination/ecosystem.config.cjs')
      : path.join(root, 'ecosystem.config.cjs');
    // PM2 start/restart on existing names can retain pm_exec_path. A scoped
    // delete followed by start resolves the new script from the saved config.
    return [['delete', name], ['start', config, '--only', name, '--update-env']];
  });
}

export function inspect(plan, getStatus = status) {
  const current = getStatus(plan.root);
  if (current.releaseId !== plan.releaseId) throw new Error('Selected release changed');
  for (const row of current.processes) {
    if (row.saved.length !== 1 || row.running.length !== 1 || !row.running[0].pid) throw new Error('Expected one saved and running process');
  }
  if (current.problems.some(p => !p.includes(': running '))) throw new Error('Saved launcher definitions are not ready: ' + current.problems.join('; '));
  if (JSON.stringify(current.processes.map(p => ({ name: p.name, ...p.running[0] }))) !== JSON.stringify(plan.expectedRunning)) throw new Error('Running process observations changed; inspect and prepare a new plan');
  const blockers = [];
  try { assertIndependent(current.processes.map(p => p.running[0].pid)); } catch (e) { blockers.push(e.message); }
  const roots = ['jerry', 'forrest', 'grokbot'].map(slug => path.join(plan.root, 'instances', slug));
  const helpers = path.join(plan.root, 'instances/.house/bots');
  if (fs.existsSync(helpers)) for (const entry of fs.readdirSync(helpers, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('bot_')) roots.push(path.join(helpers, entry.name));
  }
  for (const agentRoot of roots) {
    const jobs = path.join(agentRoot, 'coding-jobs');
    if (!fs.existsSync(jobs)) continue;
    for (const name of fs.readdirSync(jobs)) {
      const file = path.join(jobs, name, 'job.json');
      if (!fs.existsSync(file)) continue;
      const job = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) blockers.push(`Nonterminal coding job ${job.id}: ${job.status}`);
    }
  }
  const plannedProvenance = plannedActiveReleaseProvenance({ root: plan.root, releaseId: plan.releaseId,
    preparation: plan.preparation, verificationReceipt: plan.verificationReceipt,
    sourceProvenanceUnavailable: plan.sourceProvenanceUnavailable });
  return { current, blockers, plannedProvenance, commands: restartCommands(plan.root, current.processes.map(p => p.name)) };
}

export async function rebind(plan, execute = false, dependencies = {}) {
  const getStatus = dependencies.getStatus ?? status;
  const inspectPlan = dependencies.inspectPlan ?? (value => inspect(value, getStatus));
  const runCommand = dependencies.runCommand ?? execFileSync;
  const wait = dependencies.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const attempts = dependencies.attempts ?? 30;
  const writeProvenance = dependencies.writeProvenance ?? writeActiveReleaseProvenance;
  const validateProvenancePlan = dependencies.validateProvenancePlan ?? assertActiveReleaseProvenancePlan;
  const inspection = inspectPlan(plan);
  const plannedProvenance = validateProvenancePlan(plan);
  if (!execute) return { ...inspection, plannedProvenance, executed: false };
  if (inspection.blockers.length) throw new Error(inspection.blockers.join('; '));
  if (!plan.receipt || fs.existsSync(plan.receipt)) throw new Error('A new receipt path is required');
  const receipt = { startedAt: new Date().toISOString(), before: inspection.current,
    plannedSourceProvenance: plannedProvenance, commands: [], runtimeRebound: false,
    provenanceRecorded: false, ok: false };
  fs.writeFileSync(plan.receipt, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    for (const args of inspection.commands) {
      runCommand('pm2', args, { stdio: 'pipe', timeout: 60000 });
      receipt.commands.push(args);
      fs.writeFileSync(plan.receipt, JSON.stringify(receipt, null, 2) + '\n');
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      receipt.after = getStatus(plan.root); // Call export; never accept empty CLI output.
      if (receipt.after.ok && receipt.after.releaseId === plan.releaseId) break;
      if (attempt + 1 < attempts) await wait(1000);
    }
    if (!receipt.after?.ok || receipt.after.releaseId !== plan.releaseId) throw new Error('Managed executable/cwd/runtime readback failed');
    receipt.runtimeRebound = true;
    fs.writeFileSync(plan.receipt, JSON.stringify(receipt, null, 2) + '\n');
    const releaseRecord = writeProvenance({ root: plan.root, releaseId: plan.releaseId,
      preparation: plan.preparation, verificationReceipt: plan.verificationReceipt,
      sourceProvenanceUnavailable: plan.sourceProvenanceUnavailable });
    receipt.sourceProvenance = Object.fromEntries(PROVENANCE_KEYS.map(key => [key, releaseRecord[key]]));
    receipt.provenanceRecorded = true;
    receipt.ok = true;
    return receipt;
  } catch (e) { receipt.error = e.message; throw e; }
  finally { receipt.finishedAt = new Date().toISOString(); fs.writeFileSync(plan.receipt, JSON.stringify(receipt, null, 2) + '\n'); }
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const [mode, file] = process.argv.slice(2);
    if (!['check', 'execute'].includes(mode) || !file) throw new Error('Usage: rebind.mjs check|execute PLAN.json');
    const result = await rebind(JSON.parse(fs.readFileSync(file, 'utf8')), mode === 'execute');
    console.log(JSON.stringify(result, null, 2));
    if (result.blockers?.length) process.exitCode = 1;
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
