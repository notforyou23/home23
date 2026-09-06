#!/usr/bin/env node
// Read-only source selection and preservation check. Never builds or activates.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function sourceStatus(installationRoot) {
  const root = fs.realpathSync(installationRoot);
  const manifestPath = path.join(root, 'instances/.house/source-authority.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported source authority format');
  const active = JSON.parse(fs.readFileSync(path.join(root, 'instances/.house/coordination/active-release.json'), 'utf8'));
  const apple = JSON.parse(fs.readFileSync(path.join(root, 'instances/.house/home23-ios.json'), 'utf8'));
  const problems = [];
  if (active.releaseId !== manifest.deployedReleaseId) problems.push('Deployed backend changed; reconcile its source before using this baseline.');
  if (fs.realpathSync(apple.sourceRoot) !== fs.realpathSync(manifest.development.apple)) problems.push('Apple source selection differs from the maintained source.');
  if (apple.contractSHA256 !== manifest.appleContractSHA256) problems.push('Apple persistence contract changed; reconcile its source and acceptance.');
  const sourceChanges = {};
  for (const [component, directory] of Object.entries({ ...manifest.development, ...(manifest.liveSourceManifest ? { installation: root } : {}) })) {
    if (!fs.statSync(directory).isDirectory()) throw new Error(`Missing ${component} source`);
    const baseline = JSON.parse(fs.readFileSync(component === 'installation' ? manifest.liveSourceManifest : manifest.sourceManifests[component], 'utf8'));
    sourceChanges[component] = baseline.filter(row => {
      if (!row.path || path.isAbsolute(row.path) || row.path.split('/').some(p => p === '..' || p === '')) throw new Error('Unsafe source manifest path');
      const file = path.join(directory, row.path);
      try {
        if (row.deleted) return fs.existsSync(file);
        if (row.symlink !== undefined) return !fs.lstatSync(file).isSymbolicLink() || fs.readlinkSync(file) !== row.symlink;
        return createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== row.sha256;
      } catch (error) { if (error.code === 'ENOENT') return !row.deleted; throw error; }
    }).map(row => row.path);
  }
  return {
    ok: problems.length === 0,
    installationRoot: root,
    development: manifest.development,
    deployedReleaseId: active.releaseId,
    installedAppleBuild: apple.installedBuild,
    preservation: manifest.preservation,
    problems,
    changesSinceReconciledBaseline: sourceChanges,
    limits: ['Source checks do not prove runtime or physical-phone acceptance.', 'Additional untracked files are reported by git status, not this baseline comparison.'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = sourceStatus(process.argv[2] || process.cwd());
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
