#!/usr/bin/env node
// Read-only workspace inventory. No fetch, checkout, config mutation or state repair.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { status as releaseStatus, pointerProvenance } from '../release/status.mjs';
import { loadLandReceipts } from './land-receipt.mjs';

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
function readEvidenceJSON(file, label) {
  try { return { value:JSON.parse(fs.readFileSync(file, 'utf8')), error:null }; }
  catch (error) {
    if (error.code === 'ENOENT') return { value:null, error:`${label} does not exist` };
    if (error instanceof SyntaxError) return { value:null, error:`${label} is invalid JSON` };
    return { value:null, error:`${label} is unreadable: ${error.code || error.message}` };
  }
}
function sourceComparison(provenance, repositories) {
  if (!provenance.sourceCommit) return { available:false, lines:null,
    reason:provenance.sourceProvenance || 'source provenance is unknown' };
  const root = provenance.sourceRepo === 'home23' ? repositories.backend
    : provenance.sourceRepo === 'home23-apple' ? repositories.apple : null;
  if (!root) return { available:false, lines:null, reason:'recorded source repository is unavailable' };
  if (git(root, ['cat-file', '-e', `${provenance.sourceCommit}^{commit}`], true) === null) {
    return { available:false, lines:null, reason:`cannot verify the recorded source commit in ${provenance.sourceRepo}` };
  }
  const output = git(root, ['log', '--oneline', `${provenance.sourceCommit}..HEAD`], true);
  if (output === null) return { available:false, lines:null, reason:'Git history comparison failed' };
  return { available:true, lines:output ? output.split('\n') : [], reason:null };
}
function backendSource(active, repositories) {
  let provenance;
  try { provenance = pointerProvenance(active); }
  catch (error) {
    provenance = { sourceCommit:null, sourceRepo:null, sourceBranch:null, sourceDirty:null, preparedAt:null,
      sourceProvenance:`invalid active release source provenance: ${error.message}` };
  }
  return { commit:provenance.sourceCommit, repo:provenance.sourceRepo, branch:provenance.sourceBranch,
    dirty:provenance.sourceDirty, preparedAt:provenance.preparedAt, provenance:provenance.sourceProvenance,
    commitsNotRunning:sourceComparison(provenance, repositories) };
}
function ledgerStatus(backend) {
  try {
    return { available:true, undeployed:loadLandReceipts(path.join(backend, 'state/land-receipts.jsonl')).filter(receipt => !receipt.deployed), error:null };
  } catch (error) { return { available:false, undeployed:null, error:error.message }; }
}
export function workspaceStatus({ backend, apple, installation, runtime = false }) {
  const repositoryPaths = { backend, apple };
  const result = { observedAt: new Date().toISOString(), repositories: { backend: repository(backend), apple: repository(apple) },
    selected: null, runtime: null, landReceipts: ledgerStatus(backend), concerns: [],
    limits: ['Remote comparisons use locally stored refs; no network fetch is performed.',
      'An installation record is not physical device acceptance. This command never changes source, state or services.'] };
  if (installation) {
    const house = path.join(installation, 'instances/.house');
    const activeRecord = readEvidenceJSON(path.join(house, 'coordination/active-release.json'), 'active release record');
    const phoneRecord = readEvidenceJSON(path.join(house, 'home23-ios.json'), 'phone installation record');
    const authorityRecord = readEvidenceJSON(path.join(house, 'source-authority.json'), 'source authority record');
    const activeValue = activeRecord.value;
    const active = activeValue && typeof activeValue === 'object' && !Array.isArray(activeValue)
      && [1, 2].includes(activeValue.schemaVersion) && /^[a-f0-9]{40}$/.test(activeValue.releaseId || '') ? activeValue : null;
    const phone = phoneRecord.value, authority = authorityRecord.value;
    const activeError = active ? null : activeRecord.error ?? 'active release record has unsupported schemaVersion or no valid releaseId';
    const phoneError = phone ? null : phoneRecord.error ?? 'phone installation record contains no selection';
    result.selected = { installation, backendRelease: active?.releaseId ?? null,
      backendReleaseError: activeError,
      backendSource: active ? backendSource(active, repositoryPaths) : null,
      phone: phone ? { build: phone.installedBuild, source: phone.sourceRoot, receipt: phone.receipt ?? null, evidence: 'installation record' } : null };
    if (!active) result.concerns.push(`Backend release selection is unavailable: ${activeError}.`);
    if (!phone) result.concerns.push(`Phone installation record is unavailable: ${phoneError}.`);
    if (!authority && authorityRecord.error && !authorityRecord.error.endsWith('does not exist')) result.concerns.push(`Source authority is unavailable: ${authorityRecord.error}.`);
    if (authority && active && authority.deployedReleaseId !== active.releaseId)
      result.concerns.push('The source reconciliation baseline predates the selected release; review newer receipts before preparing another release.');
    if (phone?.sourceRoot && path.resolve(phone.sourceRoot) !== path.resolve(apple))
      result.concerns.push('The phone source selection differs from the Apple repository being inspected.');
    if (runtime) {
      try {
        const value = releaseStatus(installation);
        result.runtime = { releaseId: value.releaseId, sourceCommit:value.sourceCommit, sourceProvenance:value.sourceProvenance,
          bindingsAgree: value.ok, problems: value.problems,
          processes: value.processes.map(p => ({ name: p.name, running: p.running.map(r => ({ pid: r.pid, status: r.status, script: r.script })) })) };
      } catch (error) {
        result.runtime = { error:`managed runtime inspection unavailable: ${error.message}`, bindingsAgree:null, problems:[], processes:[] };
        result.concerns.push(result.runtime.error);
      }
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
    const source = value.selected.backendSource;
    if (value.selected.backendReleaseError) lines.push(`Deployed source: unavailable: ${value.selected.backendReleaseError}`);
    else if (!source?.commit) lines.push(`Deployed source: unknown${source?.provenance ? ` (${source.provenance})` : ''}`);
    else {
      lines.push(`Deployed source: ${source.repo} ${source.commit} (${source.branch}; source ${source.dirty ? 'dirty' : 'clean'}; prepared ${source.preparedAt})`);
      if (source.commitsNotRunning.available) {
        lines.push(`Source commits not running: ${source.commitsNotRunning.lines.length}`,
          ...source.commitsNotRunning.lines.map(line => `- ${line}`));
      } else lines.push(`Source commits not running: unavailable: ${source.commitsNotRunning.reason}`);
    }
  }
  if (value.runtime?.error) lines.push(`Managed runtime bindings: unavailable: ${value.runtime.error}`);
  else if (value.runtime) lines.push(`Managed runtime bindings: ${value.runtime.bindingsAgree ? 'agree' : 'NEED REVIEW'}`);
  if (value.landReceipts.available) lines.push('', `Undeployed land receipts: ${value.landReceipts.undeployed.length}`,
    ...value.landReceipts.undeployed.map(receipt => `- ${receipt.commit} ${receipt.repo}/${receipt.branch}: ${receipt.summary} [${receipt.surfaces.join(', ')}]`));
  else lines.push('', `Undeployed land receipts: ledger unavailable: ${value.landReceipts.error}`);
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
    if (Object.values(result.repositories).some(r => r.error) || result.runtime?.bindingsAgree === false || result.runtime?.error) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
