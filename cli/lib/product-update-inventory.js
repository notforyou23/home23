/** Classifies a Host v1 home for a schema-preserving update. No package writes. */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { absoluteHome, readPrivateJSON, socketRootFor } from './product-environment.js';
import { PRODUCT_STATE_PATHS, isProductStatePath } from './product-payload.js';
import { compareUpdateContracts } from './product-update-plan.js';

export const SUPPORTED_COORDINATION_SCHEMA = 21;
export const SUPPORTED_COORDINATION_SCHEMA_CHECKSUM = 'ed59b3cd5a64230ee04d6adb92abe713dc2cdabe8af5721d67c167485a7ba5af';
export const SUPPORTED_COORDINATION_MIGRATION_CHECKSUM = 'b231fa7def776d8c69c2ff2d601ad29d2bf4643ed8ea33140a474359ef88c0e8';
export const SUPPORTED_COORDINATION_SCHEMAS = Object.freeze({
  20: Object.freeze({ schemaChecksum: 'cb80ab7b2c52920dab0ef5434dd9c62fad2e3a6efacabde76e6934b84e5006ec',
    migrationChecksum: 'c5d7aad734c6516b629b0879a815f51bdb32ea1c33d2001209fc7c008c60a436' }),
  21: Object.freeze({ schemaChecksum: SUPPORTED_COORDINATION_SCHEMA_CHECKSUM,
    migrationChecksum: SUPPORTED_COORDINATION_MIGRATION_CHECKSUM }),
});
const MIGRATIONS_PREFIX = 'app/dist/coordination/migrations/';
const V21_MIGRATION = `${MIGRATIONS_PREFIX}0021-notification-recovery-order.js`;
const V21_INDEX = `${MIGRATIONS_PREFIX}index.js`;
// Reviewed compiled assets from the immutable v21 migration source. The rest of
// the migration tree must still match the installed package byte for byte.
const V21_ASSET_SHA256 = Object.freeze({
  [V21_MIGRATION]: '71239e12d1d0164cc5e3b0f395664fc56da906b04627f9c743b8240bbf3004ff',
  [V21_INDEX]: 'd436d6b3cbea64c10127e59f27babc1a6783e62ae386bf4dc8990d84c71e6f90',
});
// TypeScript emits these declarations and maps alongside the two reviewed JS
// files. They are not executable migrations, but pin their exact signed v21
// bytes so another generated change cannot be mistaken for this transition.
const V21_GENERATED_SHA256 = Object.freeze({
  [`${MIGRATIONS_PREFIX}index.d.ts`]: '753b762758943371621b43542a137664e4e111cc75eb311927da2183297a9f81',
  [`${MIGRATIONS_PREFIX}index.d.ts.map`]: '2396ec75a0f10b47cbbebec1aeff7bad20b8fa13bc8ed1fa9309f7c5f7d1f67b',
  [`${MIGRATIONS_PREFIX}index.js.map`]: '3772dfcd06076ea0961c80dbfcdf433abe60b23c2612c4250efb2d4d59474383',
  [`${MIGRATIONS_PREFIX}0021-notification-recovery-order.d.ts`]: '743c3e0e0a76767dc23533fd63b18d3c51eddac768a8bf7a8deeb5cf39ae4156',
  [`${MIGRATIONS_PREFIX}0021-notification-recovery-order.d.ts.map`]: 'd8f85d2a1faffa962260fba6adf1de6e77f62a64a4a556ba3e9eadecde0f015e',
  [`${MIGRATIONS_PREFIX}0021-notification-recovery-order.js.map`]: 'c062d5d7137f0c92c1917b8f6931ea5adb872c9f8f83ef368b504ad32b8d80c0',
});
const V20_GENERATED_SHA256 = Object.freeze({
  [`${MIGRATIONS_PREFIX}index.d.ts`]: 'c8e332800f31c42b786e5b6425fca534eaa413fa3ffea76e057aa599a05c2cbc',
  [`${MIGRATIONS_PREFIX}index.d.ts.map`]: '17337d0decf4ede4a160ebbf85504535c4c123453aa10b895048c9d7491301ca',
  [`${MIGRATIONS_PREFIX}index.js.map`]: 'c521b789c6d991a9ce3bcf540735aabff0f9b80641a5033ec159f32262deea35',
});
function reviewedV21Migration(installed, candidate, group) {
  if (group.status !== 'changed') return false;
  const before = new Map(installed.files.map(entry => [entry.path, entry]));
  const after = new Map(candidate.files.map(entry => [entry.path, entry]));
  const generated = Object.keys(V21_GENERATED_SHA256).filter(path => before.has(path) || after.has(path));
  if (generated.length !== 0 && generated.length !== Object.keys(V21_GENERATED_SHA256).length) return false;
  const expectedPaths = [...Object.keys(V21_ASSET_SHA256), ...generated];
  if (group.changedPaths.length !== expectedPaths.length ||
      group.changedPaths.some(path => !expectedPaths.includes(path))) return false;
  if (before.has(V21_MIGRATION) || !before.has(V21_INDEX)) return false;
  return Object.entries({ ...V21_ASSET_SHA256, ...generated.length ? V21_GENERATED_SHA256 : {} }).every(([path, sha256]) =>
    after.get(path)?.type === 'file' && after.get(path)?.mode === 0o644 && after.get(path)?.sha256 === sha256) &&
    Object.entries(generated.length ? V20_GENERATED_SHA256 : {}).every(([path, sha256]) =>
      before.get(path)?.type === 'file' && before.get(path)?.mode === 0o644 && before.get(path)?.sha256 === sha256) &&
    generated.filter(path => path.includes('/0021-')).every(path => !before.has(path));
}
export function candidateCoordinationSchema(candidate) {
  const files = new Map(candidate.files.map(entry => [entry.path, entry]));
  if (!files.has(V21_MIGRATION)) return 20;
  return Object.entries(V21_ASSET_SHA256).every(([path, sha256]) =>
    files.get(path)?.type === 'file' && files.get(path)?.mode === 0o644 && files.get(path)?.sha256 === sha256) ? 21 : null;
}
const RECIPE_ASSET = 'app/scripts/embedder/schema/recipes.json';
const COORDINATION_DATABASE = 'app/instances/.house/coordination/home23-coordination.sqlite3';
const COORDINATION_SOCKET = 'app/instances/.house/coordination/coord.sock';
const PM2_SOCKETS = new Set(['runtime/pm2/pub.sock', 'runtime/pm2/rpc.sock']);
const CHROME_SINGLETON_SOCKET = 'runtime/user/.home23/chrome-cdp/SingletonSocket';
const CHROME_SOCKET_TARGET = /^\/var\/folders\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/T\/com\.google\.Chrome\.[A-Za-z0-9_-]+\/SingletonSocket$/;
const SCAN_FILES = ['.home23-host.json', 'app/.home23-state.json', 'app/config/home.yaml', 'app/config/targets.yaml', 'app/config/agents.json', 'app/config/secrets.yaml'];
const ADOPTED_LINK_RECEIPT = 'runtime/adoption-preservation.json';
const REBUILDABLE_PREFIXES = ['app/logs/', 'app/engine/logs/', 'app/engine/runtime/', 'runtime/pm2/', 'runtime/embedder-cache/', 'runtime/user/', 'runtime/.host.lock/'];

export { isProductStatePath };
function containsState(relative) {
  return isProductStatePath(relative) || PRODUCT_STATE_PATHS.some(entry => entry.path.startsWith(`${relative}/`));
}
export function isRebuildableStatePath(relative) {
  return REBUILDABLE_PREFIXES.some(prefix => relative === prefix.slice(0, -1) || relative.startsWith(prefix));
}
/** Reserved Host writer names, including optional agent roles. Never trust
 * arbitrary processNames from a saved Host record as stop authority. */
export function ownedWriterNames(name, { encoderRequired = false } = {}) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name || '')) return null;
  const base = `home23-${name}`;
  const names = ['home23-coordination', base, `${base}-dash`, `${base}-mcp`, `${base}-harness`,
    `${base}-seed`, `${base}-shipper`, `${base}-house-sense`, 'home23-seed-observatory', 'home23-evobrew'];
  if (encoderRequired) names.push('home23-embedder');
  return names;
}

const reason = (code, message, extra = {}) => ({ code, message, ...extra });
const exists = file => { try { lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

function allowedExternal(home, token) {
  const socket = socketRootFor(home);
  const roots = [home, socket];
  if (socket.startsWith('/tmp/')) roots.push(`/private${socket}`);
  if (socket.startsWith('/private/tmp/')) roots.push(socket.replace(/^\/private/, ''));
  return roots.some(root => token === root || token.startsWith(`${root}${sep}`) || token.startsWith(`${root}/`));
}
function absoluteTokens(text) {
  const found = [];
  const pattern = /(?:^|[\s"'=:])(\/[A-Za-z0-9._~@+-][^\s"'<>|]*)/g;
  for (const match of text.matchAll(pattern)) found.push(match[1].replace(/[,}]+$/, ''));
  return found;
}
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** YAML folds paths at spaces, so a token may be only the first fragment of this home. */
function refersToHome(text, home, token) {
  if (token === home || token.startsWith(`${home}/`)) return true;
  const boundary = home[token.length];
  if (!home.startsWith(token) || (boundary !== undefined && boundary !== ' ' && boundary !== '/')) return false;
  return new RegExp(escapeRegex(home).replaceAll(' ', '\\s+')).test(text);
}
function recipeIds(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return Object.values(parsed.profiles || {}).map(profile => profile.recipeId).filter(Boolean);
}
/** The coordinator replaces this particular internal pointer after each curation. */
function reviewedRotatingInsight(root, relative, target, approved) {
  if (approved.kind !== 'retain-link' ||
      !/^app\/instances\/[a-z][a-z0-9-]{0,62}\/brain\/coordinator\/insights_curated_LATEST\.md$/.test(relative) ||
      !/^insights_curated_cycle_\d+_\d{4}-\d{2}-\d{2}\.md$/.test(target)) return false;
  const parent = dirname(join(root, relative));
  const file = resolve(parent, target);
  // Do not let an authority originally reviewed outside this directory turn
  // into a freely rotating internal pointer.
  if (dirname(file) !== parent || dirname(resolve(parent, approved.target)) !== parent) return false;
  try {
    const realRoot = realpathSync(root), realParent = realpathSync(parent);
    if (!realParent.startsWith(`${realRoot}${sep}`)) return false;
    const stat = lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink() && dirname(realpathSync(file)) === realParent;
  } catch { return false; }
}

export async function inspectCoordinationDatabase(file) {
  if (!exists(file)) return { present: false, compatible: false };
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch (error) { return { present: true, compatible: false, unreadable: true, message: error.message }; }
  let database;
  try { database = new DatabaseSync(file, { readOnly: true }); }
  catch (error) {
    const busy = /busy|locked/i.test(String(error.message));
    return { present: true, compatible: false, busy, unreadable: !busy, message: error.message };
  }
  try {
    const version = Number(database.prepare('PRAGMA user_version').get().user_version);
    const integrity = database.prepare('PRAGMA quick_check').get().quick_check;
    const migrations = database.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'").get();
    if (!migrations) return { present: true, version, compatible: false, integrity };
    const row = database.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
    const meta = database.prepare("SELECT value FROM kernel_meta WHERE key = 'schema.checksum'").get();
    const recorded = Number(row?.version ?? 0);
    const expected = SUPPORTED_COORDINATION_SCHEMAS[version];
    const compatible = integrity === 'ok' && expected !== undefined && recorded === version &&
      row?.checksum === expected.migrationChecksum && meta?.value === expected.schemaChecksum;
    return { present: true, version, recorded, checksum: meta?.value || null, integrity, compatible };
  } catch (error) {
    const busy = /busy|locked/i.test(String(error.message));
    return { present: true, compatible: false, busy, unreadable: !busy, message: error.message };
  } finally { database.close(); }
}

/**
 * Read-only inventory. Unknown files, links, external paths and unsupported
 * schema versions are reasons to refuse before any package byte changes.
 */
export async function inspectUpdateInventory(homeRoot, { installed, candidate, scanSoftware = true } = {}) {
  const root = absoluteHome(homeRoot);
  const reasons = [];
  const unknown = [];
  let adoptedLinks = new Map();
  let adoptedReferences = new Set();
  let adoptedContinuation = null;
  let adoptedNetwork = null;
  const adoptedReceipt = join(root, ADOPTED_LINK_RECEIPT);
  if (exists(adoptedReceipt)) {
    try {
      const receipt = readPrivateJSON(adoptedReceipt);
      if (receipt?.schema !== 'home23.adoption-preservation-receipt.v1' || !Array.isArray(receipt.links)) throw new Error();
      adoptedLinks = new Map(receipt.links.map(link => {
        if (!isProductStatePath(link.path) || typeof link.target !== 'string' || !link.target ||
          !['retain-link', 'historical-link', 'retain-authority'].includes(link.kind)) throw new Error();
        return [link.path, link];
      }));
      if (adoptedLinks.size !== receipt.links.length) throw new Error();
      if (receipt.continuationServices !== undefined) {
        if (!Array.isArray(receipt.continuationServices)) throw new Error();
        adoptedContinuation = receipt.continuationServices.map(service => ({ name: service.name, ...service.run }));
      }
      adoptedNetwork = receipt.networkBindings || null;
      if (receipt.externalReferences !== undefined) {
        if (!Array.isArray(receipt.externalReferences)) throw new Error();
        adoptedReferences = new Set(receipt.externalReferences.map(reference => {
          if (!SCAN_FILES.includes(reference.path) || typeof reference.target !== 'string' || !reference.target.startsWith('/')) throw new Error();
          return `${reference.path}\0${reference.target}`;
        }));
        if (adoptedReferences.size !== receipt.externalReferences.length) throw new Error();
      }
    } catch {
      reasons.push(reason('adoption_receipt_invalid', 'The adopted state-link receipt is unreadable.'));
    }
  }
  const manifestEntries = new Map((installed?.files || []).map(entry => [entry.path, entry]));
  const manifestPaths = new Set(manifestEntries.keys());
  function visit(relative) {
    const absolute = join(root, relative);
    const stat = lstatSync(absolute);
    const declared = manifestEntries.get(relative);
    if (relative === COORDINATION_SOCKET || PM2_SOCKETS.has(relative)) {
      // A live UDS is a rebuildable coordinator endpoint, never a backup file.
      // Other types at this exact path and sockets anywhere else still refuse.
      if (!stat.isSocket() || declared) reasons.push(reason('unknown_state', `Coordination endpoint ${relative} is not an owned runtime socket.`, { path: relative }));
      return;
    }
    if (relative === CHROME_SINGLETON_SOCKET) {
      // Chrome owns this live pointer into macOS's per-user temporary socket.
      // Never follow it or accept another kind of external state link here.
      const target = stat.isSymbolicLink() ? readlinkSync(absolute) : '';
      if (declared || !CHROME_SOCKET_TARGET.test(target))
        reasons.push(reason('linked_state_path', `Chrome endpoint ${relative} is not an owned temporary socket link.`, { path: relative }));
      return;
    }
    if (!scanSoftware && declared && (
      (stat.isDirectory() && declared.type !== 'directory') ||
      (stat.isFile() && declared.type !== 'file') ||
      (stat.isSymbolicLink() && declared.type !== 'symlink')
    )) reasons.push(reason('modified_installation', `Package path ${relative} changed type.`, { path: relative }));
    if (stat.isSymbolicLink()) {
      if (isProductStatePath(relative)) {
        let target = '';
        try { target = readlinkSync(absolute); }
        catch { reasons.push(reason('state_path_unreadable', `State link ${relative} could not be read.`, { path: relative })); return; }
        const resolved = resolve(dirname(absolute), target);
        const insideHome = resolved === root || resolved.startsWith(root + sep);
        const approved = adoptedLinks.get(relative);
        if (approved) {
          if (approved.target !== target && !reviewedRotatingInsight(root, relative, target, approved))
            reasons.push(reason('linked_state_changed', `Reviewed state link ${relative} changed.`, { path: relative }));
          else if (approved.kind === 'retain-authority' && !exists(resolved)) reasons.push(reason('retained_authority_missing', `External authority for ${relative} is unavailable. Restore or reconnect it before updating.`, { path: relative }));
          else adoptedLinks.delete(relative);
        } else if (!insideHome) reasons.push(reason('linked_state_path', `State path ${relative} points outside this home. Keep the real directory in place before updating.`, { path: relative }));
      } else if (!manifestPaths.has(relative)) {
        reasons.push(reason('unknown_state', `Unclassified path ${relative} is a link.`, { path: relative }));
      }
      return;
    }
    if (stat.isDirectory()) {
      if (!manifestPaths.has(relative) && !containsState(relative) && relative !== '') unknown.push(relative);
      // During Install from a claimed Stage, software moves as whole subtrees.
      // Visit state-bearing paths and unknown top-level paths, but do not walk
      // thousands of dependency files that will be replaced by that switch.
      if (!scanSoftware && !containsState(relative)) return;
      for (const name of readdirSync(absolute).sort()) visit(relative ? `${relative}/${name}` : name);
      return;
    }
    if (!stat.isFile()) {
      reasons.push(reason('unknown_state', `Unclassified path ${relative} is not a regular file.`, { path: relative }));
      return;
    }
    if (relative !== 'manifest.json' && !manifestPaths.has(relative) && !isProductStatePath(relative)) unknown.push(relative);
  }
  if (exists(root)) for (const name of readdirSync(root).sort()) visit(name);
  for (const path of adoptedLinks.keys()) reasons.push(reason('linked_state_missing', `Reviewed state link ${path} is missing.`, { path }));
  for (const path of unknown) reasons.push(reason('unknown_state', `Unclassified path ${path} is not package software or a known home-state root. Classify it before updating.`, { path }));
  const state = exists(join(root, '.home23-host.json')) ? readPrivateJSON(join(root, '.home23-host.json')) : null;
  const continuing = state?.continuationServices || [];
  if (continuing.length && (!adoptedContinuation || JSON.stringify(continuing) !== JSON.stringify(adoptedContinuation))) {
    reasons.push(reason('continuation_receipt_mismatch', 'Continuing service bindings differ from the sealed adoption receipt.'));
  }
  if (JSON.stringify(state?.networkBindings || null) !== JSON.stringify(adoptedNetwork)
    || (adoptedNetwork && (JSON.stringify(state?.ports) !== JSON.stringify(adoptedNetwork.shared)
      || Object.keys(state?.residentMap || {}).sort().join('|') !== Object.keys(adoptedNetwork.residents || {}).sort().join('|')
      || Object.entries(adoptedNetwork.residents || {}).some(([name, ports]) =>
        JSON.stringify(state?.residentMap?.[name]?.ports || null) !== JSON.stringify(ports))))) {
    reasons.push(reason('network_binding_receipt_mismatch', 'Continuing-home ports differ from their sealed adoption receipt.'));
  }
  const created = Boolean(state);
  const residentNames = created && state.residentMap && typeof state.residentMap === 'object' && !Array.isArray(state.residentMap)
    ? Object.keys(state.residentMap) : created ? [state.profile?.name] : [];
  const writerSets = residentNames.map(name => ownedWriterNames(name, { encoderRequired: state.encoderRequired === true }));
  const continuation = state?.continuationServices || [];
  const validContinuation = Array.isArray(continuation) && continuation.every(service =>
    service && /^[a-z][a-z0-9-]{0,62}$/.test(service.name || ''))
    && new Set(continuation.map(service => service.name)).size === continuation.length;
  const writerNames = writerSets.some(names => !names) || !residentNames.length || !validContinuation
    ? null : [...new Set([...writerSets.flat(), ...continuation.map(service => service.name)])];
  if (created && !writerNames) reasons.push(reason('invalid_resident', 'The saved resident name cannot be mapped to owned writers.'));
  const external = [];
  for (const relative of SCAN_FILES) {
    const file = join(root, relative);
    if (!exists(file)) continue;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    if (stat.size > 1_000_000) {
      reasons.push(reason('state_uninspected', `Config file ${relative} is too large to classify external paths.`, { path: relative }));
      continue;
    }
    const text = relative === '.home23-host.json' && continuing.length && adoptedContinuation
      && JSON.stringify(continuing) === JSON.stringify(adoptedContinuation)
      ? JSON.stringify({ ...state, continuationServices: undefined })
      : readFileSync(file, 'utf8');
    for (const token of absoluteTokens(text)) {
      if (!allowedExternal(root, token) && !refersToHome(text, root, token)
        && !adoptedReferences.has(`${relative}\0${token}`)) external.push({ path: relative, target: relative.endsWith('secrets.yaml') ? '[redacted]' : token });
    }
  }
  for (const item of external) reasons.push(reason('external_reference', `External path in ${item.path} is not part of this home. Reconnect or remove it before a software update.`, { path: item.path }));
  let database = { present: false, compatible: !created };
  if (exists(join(root, COORDINATION_DATABASE))) database = await inspectCoordinationDatabase(join(root, COORDINATION_DATABASE));
  else if (created) reasons.push(reason('database_missing', 'This created home has no coordination database. A schema-preserving update cannot invent one.'));
  if (database.busy) reasons.push(reason('database_busy', 'The coordination database is busy. Wait until writers finish, then retry.'));
  else if (database.unreadable) reasons.push(reason('database_unreadable', 'The coordination database could not be inspected. No files were changed.'));
  else if (database.present && !database.compatible) reasons.push(reason('unsupported_data_version', `Stored coordination schema ${database.version ?? 'unknown'} does not match a reviewed v20 or v21 schema fingerprint.`));
  if (installed && candidate) {
    const contracts = compareUpdateContracts(installed, candidate);
    const targetSchema = candidateCoordinationSchema(candidate);
    if (targetSchema === null || (database.present && database.compatible && database.version > targetSchema)) {
      reasons.push(reason('schema_assets_changed', 'The candidate package cannot run the stored coordination schema.'));
    }
    if ((contracts.groups.coordinationMigrations.status !== 'unchanged' &&
         !reviewedV21Migration(installed, candidate, contracts.groups.coordinationMigrations)) ||
        contracts.groups.coordinationContracts.status !== 'unchanged') {
      reasons.push(reason('schema_assets_changed', 'Packaged coordination migrations or contracts differ from the reviewed v20 to v21 transition.'));
    }
    const left = installed.files.find(entry => entry.path === RECIPE_ASSET);
    const right = candidate.files.find(entry => entry.path === RECIPE_ASSET);
    if (Boolean(left) !== Boolean(right) || (left && right && (left.sha256 !== right.sha256 || left.mode !== right.mode))) {
      reasons.push(reason('encoder_recipe_changed', 'The packaged encoder recipe changed. Software update will not retarget embeddings.'));
    }
    const homeYaml = join(root, 'app/config/home.yaml');
    if (exists(homeYaml) && lstatSync(homeYaml).isFile()) {
      const configured = [...readFileSync(homeYaml, 'utf8').matchAll(/recipeId:\s*([A-Za-z0-9._:-]+)/g)].map(match => match[1]);
      if (configured.length) {
        const packaged = left ? recipeIds(join(root, RECIPE_ASSET)) : [];
        if (configured.some(id => !packaged.includes(id))) reasons.push(reason('encoder_mismatch', 'The home encoder recipe is not the packaged owned recipe. It was left unchanged and the update was refused.'));
      }
    }
  }
  return {
    schema: 'home23.product-update-inventory.v1', scope: 'host_v1_schema_preserving', complete: reasons.length === 0,
    writers: writerNames || [], database: COORDINATION_DATABASE, databaseInspection: { present: database.present, version: database.version ?? null, compatible: database.compatible === true },
    desiredRunning: state?.desiredRunning === true, created, resident: state?.profile?.name || null, encoderRequired: state?.encoderRequired === true,
    reasons,
  };
}

export function hashFile(file) {
  const digest = createHash('sha256');
  const descriptor = openSync(file, 'r');
  try {
    // Lived state files can exceed Node's whole-file Buffer limit.
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, fstatSync(descriptor).size)));
    for (;;) {
      const bytes = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      digest.update(buffer.subarray(0, bytes));
    }
    return digest.digest('hex');
  } finally { closeSync(descriptor); }
}
