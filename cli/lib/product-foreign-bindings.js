/**
 * Read-only detector for other supervisors on this machine that still name a Home23 home root:
 * the owner's global PM2 daemon dump and launchd agents in the user's Library. After a move,
 * such registrations keep writing into the retired tree. This module only reports them; it
 * never edits, reloads or deletes a registration.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';

export const FOREIGN_BINDINGS_SCHEMA = 'home23.foreign-bindings.v1';

/** PM2 dump app fields that carry paths, in report order. `env` values are the inherited environment. */
const PM2_FIELDS = ['pm_cwd', 'cwd', 'pm_exec_path', 'args', 'node_args', 'env', 'pm_out_log_path', 'pm_err_log_path', 'pm_pid_path'];
/** launchd job keys that carry paths, in report order. */
const LAUNCHD_FIELDS = ['Program', 'ProgramArguments', 'WorkingDirectory', 'EnvironmentVariables', 'StandardInPath', 'StandardOutPath', 'StandardErrorPath', 'WatchPaths', 'QueueDirectories'];
const SOURCE_LABELS = { pm2: 'PM2 app', launchd: 'launchd agent' };
/** Characters that may delimit a path inside a shell line or KEY=value string. */
const BOUNDARY = /[\s"'=:;,&|()<>]/;

const inside = (root, target) => target === root || target.startsWith(root + sep);

function normalizedRoot(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || resolve(value) === sep) {
    throw new TypeError(`Foreign binding detection needs an absolute ${label}.`);
  }
  return resolve(value);
}

/** True when `value` is `root`, a path inside it, or a shell/KEY=value string naming either. */
export function namesRoot(value, root) {
  for (let at = value.indexOf(root); at !== -1; at = value.indexOf(root, at + 1)) {
    const before = at === 0 ? '' : value[at - 1];
    const after = value[at + root.length] ?? '';
    if ((before === '' || BOUNDARY.test(before)) && (after === '' || after === sep || BOUNDARY.test(after))) return true;
  }
  return false;
}

function collect(field, value, roots, references, meta) {
  if (typeof value === 'string') {
    const root = roots.find(candidate => namesRoot(value, candidate));
    if (root) references.push({ ...meta, field, value, root });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collect(`${field}[${index}]`, item, roots, references, meta));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collect(`${field}.${key}`, item, roots, references, meta);
  }
}

const decodeEntities = text => text.replace(/&(quot|amp|lt|gt|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (match, entity) => {
  if (entity === 'quot') return '"';
  if (entity === 'amp') return '&';
  if (entity === 'lt') return '<';
  if (entity === 'gt') return '>';
  if (entity === 'apos') return "'";
  const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
  return Number.isFinite(code) ? String.fromCodePoint(code) : match;
});
const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([A-Za-z]+)\s*>|<([A-Za-z]+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;

/** Strict decoder for the XML property-list subset launchd jobs use. Throws on malformed input. */
export function parsePlist(text) {
  const tokens = [];
  for (const match of text.matchAll(TOKEN)) {
    if (match[1]) tokens.push({ close: match[1] });
    else if (match[2]) tokens.push({ open: match[2], empty: match[3] === '/' });
    else if (match[4] !== undefined && match[4].trim()) tokens.push({ text: match[4] });
  }
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const expectClose = name => {
    const token = next();
    if (!token || token.close !== name) throw new Error(`Property list is missing </${name}>.`);
  };
  const textOf = name => {
    const token = peek();
    if (token?.text === undefined) { expectClose(name); return ''; }
    at += 1;
    expectClose(name);
    return decodeEntities(token.text);
  };
  function value() {
    const token = next();
    if (!token?.open) throw new Error('Property list value expected.');
    const { open: name, empty } = token;
    if (name === 'true' || name === 'false') {
      if (!empty) expectClose(name);
      return name === 'true';
    }
    if (name === 'dict') {
      const dict = {};
      if (empty) return dict;
      while (peek()?.open === 'key') {
        at += 1;
        dict[textOf('key')] = value();
      }
      expectClose('dict');
      return dict;
    }
    if (name === 'array') {
      const list = [];
      if (empty) return list;
      while (peek()?.open) list.push(value());
      expectClose('array');
      return list;
    }
    if (name === 'string' || name === 'date' || name === 'data') return empty ? '' : textOf(name);
    if (name === 'integer' || name === 'real') {
      const number = Number((empty ? '' : textOf(name)).trim());
      if (!Number.isFinite(number)) throw new Error(`Property list <${name}> is not a number.`);
      return number;
    }
    throw new Error(`Property list element <${name}> is not supported.`);
  }
  const root = next();
  if (root?.open !== 'plist' || root.empty) throw new Error('Not a property list.');
  const result = value();
  expectClose('plist');
  if (at !== tokens.length) throw new Error('Property list has trailing content.');
  return result;
}

/** Reads an XML or (on macOS, via plutil to stdout) binary property list without modifying it. */
export function readPlist(file) {
  let bytes = readFileSync(file);
  if (bytes.subarray(0, 6).toString('latin1') === 'bplist') {
    if (process.platform !== 'darwin') throw new Error('Binary property lists can only be read on macOS.');
    bytes = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', file], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
  }
  return parsePlist(bytes.toString('utf8'));
}

function scanPm2Dump(file, roots, report) {
  let apps;
  try {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return;
    report.scanned.pm2Dump = file;
    apps = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    report.unreadable.push(file);
    return;
  }
  if (!Array.isArray(apps)) {
    report.unreadable.push(file);
    return;
  }
  apps.forEach((app, index) => {
    if (!app || typeof app !== 'object' || Array.isArray(app)) return;
    const name = typeof app.name === 'string' && app.name ? app.name : `#${index}`;
    for (const field of PM2_FIELDS) {
      if (field in app) collect(field, app[field], roots, report.references, { source: 'pm2', name, file });
    }
  });
}

function scanLaunchAgents(directory, roots, report) {
  let entries;
  try {
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return;
    report.scanned.launchAgents = directory;
    entries = readdirSync(directory).filter(entry => entry.endsWith('.plist')).sort();
  } catch {
    report.unreadable.push(directory);
    return;
  }
  for (const entry of entries) {
    const file = join(directory, entry);
    let agent;
    try { agent = readPlist(file); }
    catch { report.unreadable.push(file); continue; }
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) { report.unreadable.push(file); continue; }
    const name = typeof agent.Label === 'string' && agent.Label ? agent.Label : basename(entry, '.plist');
    for (const field of LAUNCHD_FIELDS) {
      if (field in agent) collect(field, agent[field], roots, report.references, { source: 'launchd', name, file });
    }
  }
}

/** One owner-facing warning per registration and root, listing the fields that still name it. */
export function foreignBindingWarnings(references) {
  const groups = new Map();
  for (const reference of references) {
    const key = `${reference.source}\0${reference.name}\0${reference.root}`;
    if (!groups.has(key)) groups.set(key, { ...reference, fields: [] });
    groups.get(key).fields.push(reference.field);
  }
  return [...groups.values()].map(group => `${SOURCE_LABELS[group.source] || group.source} "${group.name}" in ${group.file} still references ${group.root} through ${group.fields.join(', ')}. Home23 did not change it; it keeps using that path until you re-register or remove it.`);
}

/**
 * Scans the user's global PM2 dump and launchd agents for references to `homeRoot` and,
 * when given, `previousRoot`. Read-only. `homeDirectory` overrides $HOME (tests); when it
 * is given, the global PM2 home is `<homeDirectory>/.pm2` unless `pm2Home` says otherwise.
 * Otherwise $PM2_HOME is honoured unless it names the home's own supervisor, in which case
 * `~/.pm2` is the global daemon. Anything inside a scanned root belongs to the home and is
 * never reported as foreign.
 */
export function detectForeignBindings({ homeRoot, previousRoot = null, homeDirectory, pm2Home, environment = process.env } = {}) {
  const roots = [normalizedRoot(homeRoot, 'home root')];
  if (previousRoot !== null && previousRoot !== undefined) {
    const previous = normalizedRoot(previousRoot, 'previous home root');
    if (!roots.includes(previous)) roots.push(previous);
  }
  const explicitHome = typeof homeDirectory === 'string' && homeDirectory;
  const userHome = resolve(explicitHome || environment.HOME || homedir());
  const report = { schema: FOREIGN_BINDINGS_SCHEMA, roots, scanned: { pm2Dump: null, launchAgents: null }, references: [], unreadable: [], warnings: [] };
  const foreign = directory => !roots.some(root => inside(root, directory));

  const pm2Candidates = pm2Home ? [pm2Home] : [explicitHome ? null : environment.PM2_HOME, join(userHome, '.pm2')];
  const pm2Directory = pm2Candidates.filter(candidate => typeof candidate === 'string' && candidate).map(candidate => resolve(candidate)).find(foreign);
  if (pm2Directory) scanPm2Dump(join(pm2Directory, 'dump.pm2'), roots, report);

  const agents = join(userHome, 'Library', 'LaunchAgents');
  if (foreign(agents)) scanLaunchAgents(agents, roots, report);

  report.warnings = foreignBindingWarnings(report.references);
  return report;
}
