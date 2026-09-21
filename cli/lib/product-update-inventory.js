/** Classifies a Host v1 home for a schema-preserving update. No package writes. */
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { absoluteHome, readPrivateJSON, socketRootFor } from './product-environment.js';
import { PRODUCT_STATE_PATHS } from './product-payload.js';
import { compareUpdateContracts } from './product-update-plan.js';

export const SUPPORTED_COORDINATION_SCHEMA = 20;
export const SUPPORTED_COORDINATION_SCHEMA_CHECKSUM = 'cb80ab7b2c52920dab0ef5434dd9c62fad2e3a6efacabde76e6934b84e5006ec';
export const SUPPORTED_COORDINATION_MIGRATION_CHECKSUM = 'c5d7aad734c6516b629b0879a815f51bdb32ea1c33d2001209fc7c008c60a436';
const RECIPE_ASSET = 'app/scripts/embedder/schema/recipes.json';
const COORDINATION_DATABASE = 'app/instances/.house/coordination/home23-coordination.sqlite3';
const SCAN_FILES = ['.home23-host.json', 'app/.home23-state.json', 'app/config/home.yaml', 'app/config/targets.yaml', 'app/config/agents.json', 'app/config/secrets.yaml'];
const REBUILDABLE_PREFIXES = ['app/logs/', 'app/engine/logs/', 'app/engine/runtime/', 'runtime/pm2/', 'runtime/embedder-cache/', 'runtime/user/', 'runtime/.host.lock/'];

export function isProductStatePath(relative) {
  return PRODUCT_STATE_PATHS.some(entry => relative === entry.path ||
    ((entry.type === 'directory' || entry.allowDescendants) && relative.startsWith(`${entry.path}/`)));
}
function containsState(relative) {
  return isProductStatePath(relative) || PRODUCT_STATE_PATHS.some(entry => entry.path.startsWith(`${relative}/`));
}
export function isRebuildableStatePath(relative) {
  return REBUILDABLE_PREFIXES.some(prefix => relative === prefix.slice(0, -1) || relative.startsWith(prefix));
}
/** Keep this list aligned with product-host ownedProcessNames. */
export function ownedWriterNames(name, { encoderRequired = false } = {}) {
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(name || '')) return null;
  const names = ['home23-coordination', `home23-${name}`, `home23-${name}-dash`, `home23-${name}-harness`, `home23-${name}-seed`, `home23-${name}-shipper`, 'home23-seed-observatory', 'home23-evobrew'];
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
    const compatible = integrity === 'ok' && version === SUPPORTED_COORDINATION_SCHEMA && recorded === version &&
      row?.checksum === SUPPORTED_COORDINATION_MIGRATION_CHECKSUM && meta?.value === SUPPORTED_COORDINATION_SCHEMA_CHECKSUM;
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
export async function inspectUpdateInventory(homeRoot, { installed, candidate } = {}) {
  const root = absoluteHome(homeRoot);
  const reasons = [];
  const unknown = [];
  const manifestPaths = new Set((installed?.files || []).map(entry => entry.path));
  function visit(relative) {
    const absolute = join(root, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      if (isProductStatePath(relative)) {
        let target = '';
        try { target = readlinkSync(absolute); }
        catch { reasons.push(reason('state_path_unreadable', `State link ${relative} could not be read.`, { path: relative })); return; }
        const resolved = resolve(dirname(absolute), target);
        const insideHome = resolved === root || resolved.startsWith(root + sep);
        if (!insideHome) reasons.push(reason('linked_state_path', `State path ${relative} points outside this home. Keep the real directory in place before updating.`, { path: relative }));
      } else if (!manifestPaths.has(relative)) {
        reasons.push(reason('unknown_state', `Unclassified path ${relative} is a link.`, { path: relative }));
      }
      return;
    }
    if (stat.isDirectory()) {
      if (!manifestPaths.has(relative) && !containsState(relative) && relative !== '') unknown.push(relative);
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
  for (const path of unknown) reasons.push(reason('unknown_state', `Unclassified path ${path} is not package software or a known home-state root. Classify it before updating.`, { path }));
  const state = exists(join(root, '.home23-host.json')) ? readPrivateJSON(join(root, '.home23-host.json')) : null;
  const created = Boolean(state);
  const writerNames = created ? ownedWriterNames(state.profile?.name, { encoderRequired: state.encoderRequired === true }) : [];
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
    const text = readFileSync(file, 'utf8');
    for (const token of absoluteTokens(text)) {
      if (!allowedExternal(root, token) && !refersToHome(text, root, token)) external.push({ path: relative, target: relative.endsWith('secrets.yaml') ? '[redacted]' : token });
    }
  }
  for (const item of external) reasons.push(reason('external_reference', `External path in ${item.path} is not part of this home. Reconnect or remove it before a software update.`, { path: item.path }));
  let database = { present: false, compatible: !created };
  if (exists(join(root, COORDINATION_DATABASE))) database = await inspectCoordinationDatabase(join(root, COORDINATION_DATABASE));
  else if (created) reasons.push(reason('database_missing', 'This created home has no coordination database. A schema-preserving update cannot invent one.'));
  if (database.busy) reasons.push(reason('database_busy', 'The coordination database is busy. Wait until writers finish, then retry.'));
  else if (database.unreadable) reasons.push(reason('database_unreadable', 'The coordination database could not be inspected. No files were changed.'));
  else if (database.present && !database.compatible) reasons.push(reason('unsupported_data_version', `Stored coordination schema ${database.version ?? 'unknown'} is outside the supported schema-preserving version ${SUPPORTED_COORDINATION_SCHEMA}. This update does not migrate data.`));
  if (installed && candidate) {
    const contracts = compareUpdateContracts(installed, candidate);
    if (contracts.groups.coordinationMigrations.status !== 'unchanged' || contracts.groups.coordinationContracts.status !== 'unchanged') {
      reasons.push(reason('schema_assets_changed', 'Packaged coordination migrations or contracts differ. Refusing rather than migrating stored data.'));
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
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
