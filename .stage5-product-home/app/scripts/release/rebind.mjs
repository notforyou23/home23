#!/usr/bin/env node
// Re-register only managed executables whose saved definitions are verified.
// This is the restart phase of an operator cutover, not a deployment planner.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { status } from './status.mjs';

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

export function inspect(plan) {
  const current = status(plan.root);
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
  return { current, blockers, commands: restartCommands(plan.root, current.processes.map(p => p.name)) };
}

export async function rebind(plan, execute = false) {
  const inspection = inspect(plan);
  if (!execute) return { ...inspection, executed: false };
  if (inspection.blockers.length) throw new Error(inspection.blockers.join('; '));
  if (!plan.receipt || fs.existsSync(plan.receipt)) throw new Error('A new receipt path is required');
  const receipt = { startedAt: new Date().toISOString(), before: inspection.current, commands: [], ok: false };
  fs.writeFileSync(plan.receipt, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try {
    for (const args of inspection.commands) {
      execFileSync('pm2', args, { stdio: 'pipe', timeout: 60000 });
      receipt.commands.push(args);
      fs.writeFileSync(plan.receipt, JSON.stringify(receipt, null, 2) + '\n');
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      receipt.after = status(plan.root); // Call export; never accept empty CLI output.
      if (receipt.after.ok) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!receipt.after?.ok) throw new Error('Managed executable/cwd/runtime readback failed');
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
