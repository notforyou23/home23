/** Verified, installation-local product payloads. No npm, PM2 or network effects. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const PRODUCT_PAYLOAD_SCHEMA = 'home23.product-payload.v1';
const INSTALL_SCHEMA = 'home23.product-install.v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const has = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function atomicJSON(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
function safePath(relative) {
  return typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !relative.includes('\0') &&
    !path.posix.isAbsolute(relative) && relative.split('/').every(part => part && part !== '.' && part !== '..');
}
function realDirectory(directory) {
  // Refuse symlink ancestors too: the ownership boundary must remain where the
  // operator selected it, rather than following an existing installation link.
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    if (has(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a real directory: ${current}`);
    }
    if (path.dirname(current) === current) break;
  }
}
function assertLink(root, relative, target) {
  if (typeof target !== 'string' || !target || path.isAbsolute(target) || target.includes('\0') ||
      !inside(root, path.resolve(root, path.dirname(relative), target))) {
    throw new Error(`Payload symlink escapes its root: ${relative}`);
  }
  const file = path.join(root, relative);
  if (has(file)) {
    let resolved;
    try { resolved = fs.realpathSync(file); } catch { throw new Error(`Payload symlink target is missing: ${relative}`); }
    if (!inside(root, resolved)) throw new Error(`Payload symlink escapes its root: ${relative}`);
  }
}
function entryAt(root, relative) {
  const file = path.join(root, relative), stat = fs.lstatSync(file), mode = stat.mode & 0o7777;
  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(file); assertLink(root, relative, target);
    return { path: relative, type: 'symlink', target };
  }
  if (stat.isDirectory()) {
    if (mode !== 0o755) throw new Error(`Unexpected directory mode: ${relative}`);
    return { path: relative, type: 'directory', mode };
  }
  if (!stat.isFile() || ![0o644, 0o755].includes(mode)) throw new Error(`Unexpected payload file or mode: ${relative}`);
  return { path: relative, type: 'file', mode, size: stat.size, sha256: hash(fs.readFileSync(file)) };
}
export function inventoryProductPayload(root) {
  root = path.resolve(root); realDirectory(root);
  const files = [];
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative === 'manifest.json') continue;
      if (!safePath(relative)) throw new Error(`Invalid payload path: ${relative}`);
      const entry = entryAt(root, relative); files.push(entry);
      if (entry.type === 'directory') visit(path.join(root, relative), relative);
    }
  }
  visit(root);
  return files;
}
function manifestDigest(manifest) {
  const { packageId, ...body } = manifest;
  return hash(JSON.stringify(body));
}
export function writeProductManifest(root, metadata) {
  const manifest = { schema: PRODUCT_PAYLOAD_SCHEMA, sourceCommit: metadata.sourceCommit,
    platform: metadata.platform, arch: metadata.arch, nodeVersion: metadata.nodeVersion,
    createdAt: new Date().toISOString(), files: inventoryProductPayload(root) };
  manifest.packageId = manifestDigest(manifest);
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o644, flag: 'wx' });
  return manifest;
}
export function readProductManifest(payloadPath) {
  realDirectory(payloadPath);
  const manifestFile = path.join(payloadPath, 'manifest.json');
  if (!fs.lstatSync(manifestFile).isFile()) throw new Error('Product manifest must be a regular file');
  const manifest = json(manifestFile);
  if (manifest.schema !== PRODUCT_PAYLOAD_SCHEMA || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit || '') ||
      !Array.isArray(manifest.files) || manifest.files.length === 0 ||
      !/^v22\./.test(manifest.nodeVersion || '') || !['darwin', 'linux'].includes(manifest.platform) ||
      !['arm64', 'x64'].includes(manifest.arch) || manifest.packageId !== manifestDigest(manifest)) {
    throw new Error('Invalid or changed Home23 product manifest');
  }
  const paths = new Set();
  for (const entry of manifest.files) {
    if (!safePath(entry.path) || paths.has(entry.path) || entry.path === 'manifest.json') throw new Error('Invalid or duplicate product file path');
    paths.add(entry.path);
    if (entry.type === 'file') {
      if (![0o644, 0o755].includes(entry.mode) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 || '')) throw new Error(`Invalid product file: ${entry.path}`);
    } else if (entry.type === 'directory') {
      if (entry.mode !== 0o755) throw new Error(`Invalid product directory: ${entry.path}`);
    } else if (entry.type === 'symlink') assertLink(path.resolve(payloadPath), entry.path, entry.target);
    else throw new Error(`Unknown product entry type: ${entry.path}`);
  }
  const entries = new Map(manifest.files.map(entry => [entry.path, entry]));
  for (const entry of manifest.files) {
    for (let parent = path.posix.dirname(entry.path); parent !== '.'; parent = path.posix.dirname(parent)) {
      if (entries.get(parent)?.type !== 'directory') throw new Error(`Missing or unsafe product parent: ${entry.path}`);
    }
  }
  for (const required of ['bin/node', 'app/cli/home23.js', 'app/cli/lib/product-payload.js', 'app/scripts/product/host.mjs', 'tools/node_modules/pm2/bin/pm2']) {
    if (!manifest.files.some(item => item.path === required && item.type === 'file')) throw new Error(`Product payload is incomplete: ${required}`);
  }
  if (manifest.files.find(item => item.path === 'bin/node').mode !== 0o755) throw new Error('Product Node is not executable');
  return manifest;
}
/** Installed-file allowances, not a complete backup inventory. Rebinding these
 * two metadata files requires the future activation transaction. */
export const PRODUCT_STATE_PATHS = Object.freeze([
  ...['.home23-install.json', '.home23-host.json',
    ...['home.yaml', 'targets.yaml', 'secrets.yaml', 'agents.json', 'cron-jobs.json'].map(name => `app/config/${name}`),
    'app/ecosystem.config.cjs', 'app/.home23-state.json',
    ...['.evobrew-config.json', 'config.json', 'runtime-state.json', 'model-catalog-cache.json'].map(name => `app/evobrew/${name}`),
  ].map(path => Object.freeze({ path, type: 'file', role: ['.home23-install.json', 'app/ecosystem.config.cjs'].includes(path) ? 'rebind' : 'preserve',
    // Preserve the pre-existing Evobrew prefix allowance. Inspection still
    // reports a directory at one of these file paths as a type mismatch.
    ...(path.startsWith('app/evobrew/') ? { allowDescendants: true } : {}),
  })),
  ...['runtime', 'app/instances', 'app/logs', 'app/runtime',
    ...['.evobrew-workspaces', 'conversations', 'snapshots'].map(name => `app/evobrew/${name}`),
    ...['runtime', 'logs', 'runs', 'data', 'artifacts', 'outputs', 'backups', '.backups'].map(name => `app/engine/${name}`),
  ].map(path => Object.freeze({ path, type: 'directory', role: 'preserve' })),
]);
function isLocalState(relative) {
  return PRODUCT_STATE_PATHS.some(entry => relative === entry.path ||
    ((entry.type === 'directory' || entry.allowDescendants) && relative.startsWith(entry.path + '/')));
}
export function verifyProductPayload(payloadPath, { allowRuntimeState = false } = {}) {
  const root = path.resolve(payloadPath), manifest = readProductManifest(root);
  if (manifest.platform !== process.platform || manifest.arch !== process.arch) throw new Error(`This package requires ${manifest.platform}/${manifest.arch}; this machine is ${process.platform}/${process.arch}`);
  // Establish every parent directory before reading file bytes. A reordered
  // manifest must not let an unexpected parent symlink redirect hashing or
  // copying outside the payload before its directory entry is checked.
  const directories = manifest.files.filter(entry => entry.type === 'directory').sort((left, right) => left.path.split('/').length - right.path.split('/').length);
  for (const expected of [...directories, ...manifest.files.filter(entry => entry.type !== 'directory')]) {
    const actual = entryAt(root, expected.path);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Product file changed: ${expected.path}`);
  }
  const expectedPaths = new Set(manifest.files.map(entry => entry.path));
  function checkExtra(directory, prefix = '') {
    for (const name of fs.readdirSync(directory)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      if (relative === 'manifest.json') continue;
      if (!expectedPaths.has(relative)) {
        if (allowRuntimeState && isLocalState(relative)) continue;
        throw new Error(`Unexpected product file: ${relative}`);
      }
      if (fs.lstatSync(path.join(root, relative)).isDirectory()) checkExtra(path.join(root, relative), relative);
    }
  }
  checkExtra(root);
  if (!allowRuntimeState && manifest.files.some(entry => entry.type !== 'directory' && !entry.path.endsWith('/.gitkeep') && isLocalState(entry.path))) throw new Error('A product payload cannot contain installation state');
  return manifest;
}
function installationReceipt(homeRoot, manifest, replayed) {
  return { schema: INSTALL_SCHEMA, status: 'installed', homeRoot, appRoot: path.join(homeRoot, 'app'),
    nodePath: path.join(homeRoot, 'bin', 'node'), pm2Path: path.join(homeRoot, 'tools', 'node_modules', 'pm2', 'bin', 'pm2'),
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit, replayed };
}
export function acquireInstallLock(lockPath) {
  const owner = { pid: process.pid, id: randomUUID() };
  const candidate = `${lockPath}.${owner.id}.tmp`;
  const contents = JSON.stringify(owner);
  fs.writeFileSync(candidate, contents, { mode: 0o600, flag: 'wx' });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        // Linking fully written contents prevents a crash from leaving a
        // claimed but empty lock that no subsequent installer can identify.
        fs.linkSync(candidate, lockPath);
        return () => { if (fs.readFileSync(lockPath, 'utf8') === contents) fs.unlinkSync(lockPath); };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (!fs.lstatSync(lockPath).isFile()) throw new Error('Unsafe installation lock');
        const raw = fs.readFileSync(lockPath, 'utf8');
        let previous; try { previous = JSON.parse(raw); } catch { throw new Error('Installation lock is incomplete; inspect before retrying'); }
        if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('Invalid installation lock');
        try { process.kill(previous.pid, 0); throw new Error('Home23 installation is already in progress'); }
        catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
        if (fs.readFileSync(lockPath, 'utf8') === raw) fs.unlinkSync(lockPath);
      }
    }
    throw new Error('Another installer is recovering this installation; retry shortly');
  } finally { fs.unlinkSync(candidate); }
}

/** Installs only an absent or exactly owned product directory. Resume preserves
 * the same claim and never overwrites a running home's state. Hashes detect
 * damaged files; they are not a publisher signature or a trust decision. */
export function installProductPayload({ payloadPath, homeRoot }) {
  payloadPath = path.resolve(payloadPath); homeRoot = path.resolve(homeRoot);
  realDirectory(homeRoot);
  if (inside(payloadPath, homeRoot) || inside(homeRoot, payloadPath)) throw new Error('Payload and installation must be separate directories');
  const manifest = verifyProductPayload(payloadPath);
  const parent = path.dirname(homeRoot), name = path.basename(homeRoot);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const claimPath = path.join(parent, `.${name}.home23-install.json`);
  const lockPath = path.join(parent, `.${name}.home23-install.lock`);
  const releaseLock = acquireInstallLock(lockPath);
  try {
    if (has(homeRoot)) {
      const receiptFile = path.join(homeRoot, '.home23-install.json');
      if (!has(receiptFile) || !fs.lstatSync(receiptFile).isFile()) throw new Error('Refusing to adopt an existing directory as a Home23 installation');
      const receipt = json(receiptFile);
      if (receipt.schema !== INSTALL_SCHEMA || receipt.status !== 'installed' || receipt.homeRoot !== homeRoot || receipt.packageId !== manifest.packageId) throw new Error('Existing Home23 installation belongs to another package or location');
      verifyProductPayload(homeRoot, { allowRuntimeState: true });
      return installationReceipt(homeRoot, manifest, true);
    }
    let claim;
    if (has(claimPath)) {
      if (!fs.lstatSync(claimPath).isFile()) throw new Error('Unsafe installation claim');
      claim = json(claimPath);
      if (claim.schema !== INSTALL_SCHEMA || claim.homeRoot !== homeRoot || claim.packageId !== manifest.packageId || !/^[a-f0-9-]{36}$/.test(claim.id)) throw new Error('An interrupted installation belongs to another package or location');
    } else {
      claim = { schema: INSTALL_SCHEMA, id: randomUUID(), homeRoot, packageId: manifest.packageId, status: 'copying' };
      atomicJSON(claimPath, claim);
    }
    const staging = path.join(parent, `.${name}.home23-stage-${claim.id}`);
    realDirectory(staging); fs.mkdirSync(staging, { recursive: true, mode: 0o700 }); fs.chmodSync(staging, 0o700);
    const stagedReceipt = path.join(staging, '.home23-install.json');
    if (has(stagedReceipt)) {
      const prior = fs.lstatSync(stagedReceipt).isFile() && json(stagedReceipt);
      if (prior?.schema !== INSTALL_SCHEMA || prior.packageId !== manifest.packageId || prior.homeRoot !== homeRoot) throw new Error('Interrupted installation receipt changed');
      fs.unlinkSync(stagedReceipt);
    }
    for (const entry of manifest.files) {
      const source = path.join(payloadPath, entry.path), destination = path.join(staging, entry.path);
      if (entry.type === 'directory') { realDirectory(destination); fs.mkdirSync(destination, { recursive: true, mode: entry.mode }); fs.chmodSync(destination, entry.mode); continue; }
      realDirectory(path.dirname(destination));
      if (has(destination)) {
        if (entry.type === 'symlink' && fs.lstatSync(destination).isSymbolicLink() && fs.readlinkSync(destination) === entry.target) continue;
        if (JSON.stringify(entryAt(staging, entry.path)) !== JSON.stringify(entry)) throw new Error(`Interrupted install file changed: ${entry.path}`);
        continue;
      }
      if (entry.type === 'symlink') fs.symlinkSync(entry.target, destination);
      else {
        const temporary = `${destination}.home23-copy`;
        if (has(temporary)) { if (!fs.lstatSync(temporary).isFile()) throw new Error('Unsafe interrupted copy'); fs.unlinkSync(temporary); }
        fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE);
        fs.chmodSync(temporary, entry.mode); fs.renameSync(temporary, destination);
      }
    }
    fs.copyFileSync(path.join(payloadPath, 'manifest.json'), path.join(staging, 'manifest.json'));
    verifyProductPayload(staging);
    const receipt = installationReceipt(homeRoot, manifest, false);
    atomicJSON(path.join(staging, '.home23-install.json'), receipt);
    if (has(homeRoot)) throw new Error('Installation destination appeared during preparation');
    fs.renameSync(staging, homeRoot);
    atomicJSON(claimPath, { ...claim, status: 'installed' });
    return receipt;
  } finally {
    releaseLock();
  }
}
