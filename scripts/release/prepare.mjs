#!/usr/bin/env node
// Offline preparation only. Never changes a release pointer or invokes PM2.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const forbidden = p => /^(instances|\.git|runtime|logs)(\/|$)/.test(p) || /^(ecosystem\.config\.cjs|config\/(home|targets|secrets)\.yaml|config\/(agents|cron-jobs)\.json)$/.test(p);
const sourceRepositories = new Set(['home23', 'home23-apple']);
export function relativeFile(p) {
  if (typeof p !== 'string' || !p || path.isAbsolute(p) || p.includes('\\') || p.split('/').some(x => !x || x === '.' || x === '..') || forbidden(p)) throw new Error('Unsafe release input path');
  return p;
}
export function inventory(root) {
  root = fs.realpathSync(root);
  const rows = [];
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir).sort()) {
      const rel = prefix + name, file = path.join(dir, name), stat = fs.lstatSync(file);
      if (stat.isDirectory()) { walk(file, rel + '/'); continue; }
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        if (!inside(root, fs.realpathSync(file))) throw new Error(`Release symlink escapes root: ${rel}`);
        rows.push({ path: rel, type: 'link', target });
      } else if (stat.isFile()) {
        rows.push({ path: rel, type: 'file', executable: !!(stat.mode & 0o111), bytes: stat.size, sha256: hash(fs.readFileSync(file)) });
      } else throw new Error(`Unsupported release entry: ${rel}`);
    }
  }
  walk(root);
  return { format: 'home23-artifact-v1', digest: hash(JSON.stringify(rows)), rows };
}
function json(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function regular(root, rel) {
  const file = path.join(root, relativeFile(rel));
  if (!inside(root, fs.realpathSync(file)) || !fs.lstatSync(file).isFile()) throw new Error(`Input is not a contained regular file: ${rel}`);
  return fs.readFileSync(file);
}
function sourceIdentity(source, sourceCommit) {
  const sourceBranch = execFileSync('git', ['branch', '--show-current'], { cwd: source, encoding: 'utf8' }).trim() || null;
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: source, encoding: 'utf8' }).trim();
  const dirtyState = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], { cwd: source, encoding: 'utf8' });
  const candidate = path.basename(path.dirname(common));
  const sourceRepo = sourceRepositories.has(candidate) ? candidate : null;
  const missing = [sourceRepo ? null : 'repository', sourceBranch ? null : 'branch'].filter(Boolean);
  return { provenance: { sourceCommit, sourceRepo, sourceBranch, sourceDirty: dirtyState.length > 0,
    sourceProvenance: missing.length ? `Source ${missing.join(' and ')} unavailable during preparation` : 'captured from prepared base and source checkout' },
    checkoutState: { common, sourceBranch, dirtyState } };
}
export function prepare({ baseline, source, baseRef, files, output }) {
  baseline = fs.realpathSync(baseline); source = fs.realpathSync(source);
  const parent = fs.realpathSync(path.dirname(path.resolve(output)));
  output = path.join(parent, path.basename(output));
  if ([baseline, source].some(root => inside(root, output) || inside(output, root))) throw new Error('Output must be outside source and baseline');
  if (!Array.isArray(files) || !files.length || new Set(files).size !== files.length) throw new Error('Explicit unique files required');
  files.forEach(relativeFile);
  const base = execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd: source, encoding: 'utf8' }).trim();
  const sourceState = sourceIdentity(source, base);
  const before = inventory(baseline);
  if (before.rows.some(row => forbidden(row.path))) throw new Error('Baseline contains installation state');
  // Capture selected input bytes before materializing anything. Untracked files
  // are intentional only when named. No broad dirty-worktree overlay.
  const inputs = files.map(rel => {
    const feature = regular(source, rel);
    const old = spawnSync('git', ['show', `${base}:${rel}`], { cwd: source, maxBuffer: 32 * 1024 * 1024 });
    if (old.error) throw old.error;
    const tracked = spawnSync('git', ['cat-file', '-e', `${base}:${rel}`], { cwd: source });
    if (old.status !== 0 && tracked.status === 0) throw new Error(`Cannot read base: ${rel}`);
    const deployed = fs.existsSync(path.join(baseline, rel)) ? regular(baseline, rel) : null;
    if (feature.includes(0) || old.status === 0 && old.stdout.includes(0) || deployed?.includes(0)) throw new Error(`Text merge only: ${rel}`);
    return { rel, feature, base: old.status === 0 ? old.stdout : null, deployed };
  });
  fs.mkdirSync(output, { mode: 0o700 }); // Existing output, including symlinks, fails.
  const candidate = path.join(output, 'candidate'), evidence = path.join(output, 'inputs');
  fs.mkdirSync(evidence);
  fs.cpSync(baseline, candidate, { recursive: true, dereference: false, verbatimSymlinks: true });
  // Baseline packages may be immutable. Only the independent copy is writable.
  function writable(dir) { fs.chmodSync(dir, fs.statSync(dir).mode | 0o700); for (const n of fs.readdirSync(dir)) { const f = path.join(dir,n), s = fs.lstatSync(f); if(s.isDirectory()) writable(f); else if(s.isFile()) fs.chmodSync(f,s.mode | 0o600); } }
  writable(candidate);
  if (inventory(candidate).digest !== before.digest) throw new Error('Copied baseline differs');
  const changes = [];
  for (const input of inputs) {
    const { rel, feature, base: original, deployed } = input;
    const key = hash(rel), prefix = path.join(evidence, key);
    fs.writeFileSync(prefix + '.feature', feature);
    if (original) fs.writeFileSync(prefix + '.base', original);
    if (deployed) fs.writeFileSync(prefix + '.deployed', deployed);
    let merged, status;
    if (deployed?.equals(feature)) { merged = deployed; status = 'unchanged'; }
    else if (original && feature.equals(original)) { merged = deployed; status = 'preserve-deployed'; }
    else if (!deployed && !original || deployed && original && deployed.equals(original)) { merged = feature; status = 'applied'; }
    else if (deployed && original) {
      const result = spawnSync('git', ['merge-file','-p','--diff3',prefix+'.deployed',prefix+'.base',prefix+'.feature'], { maxBuffer: 32*1024*1024 });
      if (result.error || result.status === null || result.status < 0 || result.status > 127) throw new Error(`Merge failed: ${rel}`);
      merged = result.stdout;
      status = result.status === 0 ? 'merged' : 'conflict';
      if (status === 'conflict') fs.writeFileSync(prefix + '.conflict', merged);
    } else { status = 'conflict'; }
    // Conflicts leave the deployed file intact; evidence retains both inputs.
    if (status !== 'conflict' && merged) {
      const target = path.join(candidate,rel);
      fs.mkdirSync(path.dirname(target),{recursive:true});
      if (!inside(candidate,fs.realpathSync(path.dirname(target)))) throw new Error('Candidate parent escaped');
      fs.writeFileSync(target, merged);
    }
    changes.push({ path:rel, status, evidence:key, base:original ? hash(original):null, source:hash(feature), deployed:deployed ? hash(deployed):null });
  }
  if (inventory(baseline).digest !== before.digest || inputs.some(i => !regular(source,i.rel).equals(i.feature))
      || JSON.stringify(sourceIdentity(source, base).checkoutState) !== JSON.stringify(sourceState.checkoutState)) {
    throw new Error('Inputs changed during preparation; discard candidate');
  }
  const report = { schemaVersion:1, preparedAt:new Date().toISOString(), baseline, source, base, ...sourceState.provenance,
    candidate, baselineDigest:before.digest, changes, activationReady:false };
  json(path.join(output,'baseline.json'),before);
  json(path.join(output,'prepared.json'),report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [mode, input] = process.argv.slice(2);
    if (mode === 'inventory' && input) { console.log(JSON.stringify(inventory(input),null,2)); }
    else if(mode === 'prepare' && input) { const r=prepare(JSON.parse(fs.readFileSync(input,'utf8'))); console.log(JSON.stringify({ candidate:r.candidate, conflicts:r.changes.filter(c=>c.status==='conflict').map(c=>c.path), activationReady:false },null,2)); }
    else throw new Error('Usage: prepare.mjs inventory ROOT | prepare PLAN.json');
  } catch(error) { console.error(error.message); process.exitCode=1; }
}
