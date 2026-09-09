#!/usr/bin/env node
// Read-only workspace inventory. No fetch, checkout, config mutation or state repair.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { status as releaseStatus } from '../release/status.mjs';

function git(root, args, optional = false) {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd();
  } catch (error) {
    if (optional) return null;
    throw new Error(`Cannot inspect Git repository ${root}: ${error.code || error.status || 'failed'}`);
  }
}
function difference(root, ref) {
  const value = git(root, ['rev-list', '--left-right', '--count', `HEAD...${ref}`], true);
  if (value === null) return null;
  const [localOnly, remoteOnly] = value.split(/\s+/).map(Number);
  return { ref, localOnly, remoteOnly };
}
function repository(root) {
  try {
    const upstream = git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], true);
    const changed = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
    const origin = git(root, ['remote', 'get-url', 'origin'], true);
    // Do not print URL credentials if a local remote was configured with them.
    const remote = origin?.replace(/(https?:\/\/)[^/@]+@/i, '$1').split(/[?#]/)[0] ?? null;
    return { root, head: git(root, ['rev-parse', 'HEAD']), branch: git(root, ['branch', '--show-current']) || '(detached)',
      remote, changedFiles: changed ? changed.split('\n') : [],
      upstream: upstream ? difference(root, upstream) : null, main: difference(root, 'origin/main'),
      worktreeCount: (git(root, ['worktree', 'list', '--porcelain']).match(/^worktree /gm) || []).length };
  } catch (error) { return { root, error: error.message }; }
}
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error(`Cannot read ${file}`); }
}
export function workspaceStatus({ backend, apple, installation, runtime = false }) {
  const result = { observedAt: new Date().toISOString(), repositories: { backend: repository(backend), apple: repository(apple) },
    selected: null, runtime: null, concerns: [],
    limits: ['Remote comparisons use locally stored refs; no network fetch is performed.',
      'An installation record is not physical device acceptance. This command never changes source, state or services.'] };
  if (installation) {
    const house = path.join(installation, 'instances/.house');
    const active = readJSON(path.join(house, 'coordination/active-release.json'));
    const phone = readJSON(path.join(house, 'home23-ios.json'));
    const authority = readJSON(path.join(house, 'source-authority.json'));
    result.selected = { installation, backendRelease: active?.releaseId ?? null,
      phone: phone ? { build: phone.installedBuild, source: phone.sourceRoot, receipt: phone.receipt ?? null, evidence: 'installation record' } : null };
    if (!active) result.concerns.push('Backend release selection is unavailable.');
    if (!phone) result.concerns.push('Phone installation record is unavailable.');
    if (authority && active && authority.deployedReleaseId !== active.releaseId)
      result.concerns.push('The source reconciliation baseline predates the selected release; review newer receipts before preparing another release.');
    if (phone?.sourceRoot && path.resolve(phone.sourceRoot) !== path.resolve(apple))
      result.concerns.push('The phone source selection differs from the Apple repository being inspected.');
    if (runtime) {
      const value = releaseStatus(installation);
      result.runtime = { releaseId: value.releaseId, bindingsAgree: value.ok, problems: value.problems,
        processes: value.processes.map(p => ({ name: p.name, running: p.running.map(r => ({ pid: r.pid, status: r.status, script: r.script })) })) };
    }
  } else if (runtime) throw new Error('--runtime requires --installation');
  for (const [name, repo] of Object.entries(result.repositories)) {
    if (repo.error) result.concerns.push(`${name}: ${repo.error}`);
    else if (repo.changedFiles.length) result.concerns.push(`${name}: preserve ${repo.changedFiles.length} existing changed/untracked entries.`);
  }
  return result;
}
export function formatStatus(value) {
  const lines = ['Home23 Development', `Observed: ${value.observedAt}`, ''];
  for (const [name, repo] of Object.entries(value.repositories)) {
    lines.push(`${name}: ${repo.root}`);
    if (repo.error) { lines.push(`  UNAVAILABLE: ${repo.error}`); continue; }
    lines.push(`  ${repo.branch} @ ${repo.head.slice(0, 10)}; ${repo.changedFiles.length} working changes; ${repo.worktreeCount} worktrees`);
    lines.push(repo.upstream ? `  ${repo.upstream.ref}: ${repo.upstream.localOnly} local-only / ${repo.upstream.remoteOnly} remote-only commits` : '  No upstream comparison available');
    if (repo.main) lines.push(`  origin/main: ${repo.main.localOnly} local-only / ${repo.main.remoteOnly} remote-only commits`);
  }
  if (value.selected) {
    lines.push('', `Selected backend: ${value.selected.backendRelease ?? 'unknown'}`,
      `Phone build: ${value.selected.phone?.build ?? 'unknown'} (installation record)`,
      `Phone receipt: ${value.selected.phone?.receipt ?? 'unavailable'}`);
  }
  if (value.runtime) lines.push(`Managed runtime bindings: ${value.runtime.bindingsAgree ? 'agree' : 'NEED REVIEW'}`);
  if (value.concerns.length) lines.push('', 'Review:', ...value.concerns.map(x => `- ${x}`));
  lines.push('', ...value.limits);
  return lines.join('\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const options = { backend, apple: path.resolve(backend, '../home23-apple') };
    let json = false;
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--json') json = true;
      else if (arg === '--runtime') options.runtime = true;
      else if (['--installation', '--backend', '--apple'].includes(arg)) {
        const value = process.argv[++i];
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
        options[arg.slice(2)] = path.resolve(value);
      } else throw new Error(`Unknown argument ${arg}`);
    }
    const result = workspaceStatus(options);
    console.log(json ? JSON.stringify(result, null, 2) : formatStatus(result));
    if (Object.values(result.repositories).some(r => r.error) || result.runtime?.bindingsAgree === false) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
