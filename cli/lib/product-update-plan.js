/** Conservative update evidence: no state contents, database opens or candidate execution. */
import { lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, parse, relative, sep } from 'node:path';
import { absoluteHome } from './product-environment.js';
import { PRODUCT_STATE_PATHS } from './product-payload.js';

function pathStatus(root, entry) {
  const target = join(root, entry.path), start = parse(target).root;
  const parts = relative(start, target).split(sep);
  let current = start;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { return error.code === 'ENOENT' ? 'absent' : error.code === 'ENOTDIR' ? 'type_mismatch' : 'unreadable'; }
    if (stat.isSymbolicLink()) return 'linked';
    const expected = i === parts.length - 1 ? entry.type : 'directory';
    if (!(expected === 'directory' ? stat.isDirectory() : stat.isFile())) return 'type_mismatch';
  }
  return 'present';
}

export function inspectStatePreservation(homeRoot) {
  const root = absoluteHome(homeRoot);
  const paths = PRODUCT_STATE_PATHS.map(entry => ({ ...entry, status: pathStatus(root, entry) }));
  const codes = { linked: 'linked_state_path', type_mismatch: 'state_type_mismatch', unreadable: 'state_path_unreadable' };
  return { schema: 'home23.product-preservation.v1', scope: 'declared_state_roots', complete: false,
    externalReferences: 'uninspected', checkpoint: 'not_taken', paths,
    issues: paths.filter(entry => codes[entry.status]).map(entry => ({ code: codes[entry.status], path: entry.path })) };
}

function contractGroup(current, candidate, prefix, required, additional) {
  const entries = manifest => (manifest.files || []).filter(entry => entry.type === 'file' && entry.path.startsWith(prefix))
    .map(entry => [entry.path, entry.mode, entry.sha256]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const left = entries(current), right = entries(candidate);
  const complete = rows => rows.some(row => row[0] === prefix + required) && rows.some(row => additional(row[0].slice(prefix.length)));
  const fingerprint = rows => rows.length ? createHash('sha256').update(JSON.stringify(rows)).digest('hex') : null;
  const currentFingerprint = fingerprint(left), candidateFingerprint = fingerprint(right);
  const before = new Map(left.map(row => [row[0], JSON.stringify(row)])), after = new Map(right.map(row => [row[0], JSON.stringify(row)]));
  const changedPaths = [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path)).sort();
  return { status: !complete(left) || !complete(right) ? 'unavailable' : changedPaths.length ? 'changed' : 'unchanged',
    currentFingerprint, candidateFingerprint, changedPaths };
}

/** The caller verifies package manifests/files first. Byte equality describes
 * packaged schema assets; it does not inspect the actual home database version. */
export function compareUpdateContracts(currentManifest, candidateManifest) {
  return { schema: 'home23.product-compatibility.v1', complete: false,
    homeDatabaseVersion: 'uninspected', otherStateFormats: 'unverified', groups: {
      coordinationMigrations: contractGroup(currentManifest, candidateManifest, 'app/dist/coordination/migrations/', 'index.js', name => /^\d{4}-.+\.js$/.test(name)),
      coordinationContracts: contractGroup(currentManifest, candidateManifest, 'app/dist/coordination/contracts/v1/', 'pack-manifest.json', name => name !== 'pack-manifest.json'),
    } };
}
