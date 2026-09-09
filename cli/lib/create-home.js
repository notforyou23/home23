/** Shared, restartable first-home preparation used by browser and CLI setup. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import lockfile from 'proper-lockfile';
import secretsStore from '../../shared/home23-secrets.cjs';
import { runAgentCreate } from './agent-create.js';
import { prepareSeedBirth } from './seed-birth.js';
import { prepareFreshEngineConfig } from './fresh-engine-config.js';
import { generateEcosystem } from './generate-ecosystem.js';
import { ensureBrainOperationsCapabilityKey } from './brain-operations-capability.js';

const require = createRequire(import.meta.url);
const { buildHome23ModelAuthority } = require('../../engine/src/dashboard/home23-model-catalog.js');

const SCHEMA = 'home23.create-home.v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function readYaml(file) {
  const value = existsSync(file) ? yaml.load(readFileSync(file, 'utf8')) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid configuration: ${file}`);
  return value;
}
function atomicWrite(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, file);
}
function realDirectory(file) {
  if (existsSync(file) && (lstatSync(file).isSymbolicLink() || !lstatSync(file).isDirectory())) {
    throw new Error(`Home creation requires a real directory: ${file}`);
  }
}
function profileFrom(input) {
  const text = (key, fallback = '', limit = 4096) => {
    const value = input[key] ?? fallback;
    if (typeof value !== 'string' || value.length > limit || value.includes('\0')) throw new Error(`Invalid ${key}`);
    return value.trim();
  };
  const name = text('name', '', 63);
  if (!/^[a-z][a-z0-9-]*$/.test(name) || name.startsWith('bot-')) throw new Error('Choose a resident name starting with a lowercase letter, followed by letters, numbers and hyphens; bot- is reserved for helpers');
  if (['coordination', 'evobrew', 'screenlogic', 'seed-observatory', 'chrome-cdp'].includes(name)) throw new Error('That resident name is reserved for a Home23 service');
  const ownerName = text('ownerName', '', 256);
  const provider = text('provider', '', 128);
  const model = text('model', '', 256);
  if (!ownerName || !provider || !model) throw new Error('Owner name, provider and model are required');
  const timezone = text('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', 128);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { throw new Error('Choose a valid timezone'); }
  const facts = Array.isArray(input.personalFacts) ? input.personalFacts.join('\n') : text('personalFacts', '', 32000);
  const ingestPaths = input.ingestPaths ?? [];
  if (!(typeof ingestPaths === 'string' || Array.isArray(ingestPaths))) throw new Error('ingestPaths must be paths or a list');
  return {
    name, displayName: text('displayName', name[0].toUpperCase() + name.slice(1), 128), ownerName,
    homeName: text('homeName', `${ownerName}'s Home23`, 256),
    purpose: text('purpose', `Help ${ownerName} organize work, remember important context, and keep projects moving.`, 512),
    personalFacts: facts, ingestPaths, timezone, ownerTelegramId: text('ownerTelegramId', '', 128), provider, model,
  };
}

export function homeCreationJournalPath(root) { return join(root, 'instances', '.house', 'creation.json'); }

/**
 * Prepares state only: no package installs, model calls, PM2 or network effects.
 * The journal owns only a brand-new home. Retries use the same profile; existing
 * installations without this claim are never adopted. Credentials are excluded
 * from the journal and returned receipt. `prepared` never means running.
 */
export async function createHome(root, input = {}, options = {}) {
  root = resolve(root);
  const profile = profileFrom(input);
  buildHome23ModelAuthority({ homeConfig: readYaml(join(root, 'config', 'home.yaml')),
    agentConfig: { chat: { defaultProvider: profile.provider, defaultModel: profile.model } } });
  const fingerprint = digest(profile);
  const houseDir = join(root, 'instances', '.house');
  const coordinationDir = join(houseDir, 'coordination');
  const journalPath = homeCreationJournalPath(root);
  const instanceDir = join(root, 'instances', profile.name);
  for (const directory of [root, join(root, 'instances'), houseDir, coordinationDir, instanceDir, join(root, 'config')]) realDirectory(directory);
  if (existsSync(join(coordinationDir, 'active-release.json'))) throw new Error('Home creation cannot run on an active managed installation');
  // Resolve implementation before claiming or writing a new home. init must
  // build both code and contract assets before this operation can run.
  let provisionFreshHouse, uuidV7;
  try {
    ({ provisionFreshHouse } = await import('../../dist/coordination/operations/index.js'));
    ({ uuidV7 } = await import('../../dist/coordination/ids/index.js'));
  } catch (cause) { throw new Error('Home creation needs a complete build. Run npm run build, then retry.', { cause }); }
  mkdirSync(houseDir, { recursive: true, mode: 0o700 });
  const release = await lockfile.lock(houseDir, { realpath: false, lockfilePath: join(houseDir, '.creation.lock'), stale: 120000, retries: { retries: 20, minTimeout: 100, maxTimeout: 500 } });
  try {
    let journal = existsSync(journalPath) ? JSON.parse(readFileSync(journalPath, 'utf8')) : null;
    if (journal && (journal.schema !== SCHEMA || journal.fingerprint !== fingerprint)) throw new Error('This home already has a different creation request. Resume with the original profile.');
    if (!journal) {
      const home = readYaml(join(root, 'config', 'home.yaml'));
      const existing = readdirSync(join(root, 'instances')).filter(name => !name.startsWith('.'));
      if (existing.length || home.home?.primaryAgent || home.coordination?.process?.enabled || existsSync(join(coordinationDir, 'home23-coordination.sqlite3'))) {
        throw new Error('Home creation is only for a new installation; existing residents and home state are preserved.');
      }
      journal = { schema: SCHEMA, fingerprint, profile, home: { id: `home_${uuidV7()}`, name: profile.homeName }, status: 'preparing', startedAt: new Date().toISOString() };
      atomicWrite(journalPath, JSON.stringify(journal, null, 2) + '\n');
    }
    const seed = await prepareSeedBirth(root, profile);
    // A completed retry verifies the lineage but never rewrites lived config,
    // rotates credentials, or regenerates a running installation's processes.
    if (journal.status === 'prepared') {
      if (!existsSync(join(instanceDir, 'config.yaml')) || !existsSync(join(coordinationDir, 'home23-coordination.sqlite3'))) {
        throw new Error('Prepared home files are missing; restore the home before resuming setup.');
      }
      return { ...journal.receipt, replayed: true };
    }
    const checkpoint = async step => {
      journal.step = step;
      atomicWrite(journalPath, JSON.stringify(journal, null, 2) + '\n');
      await options.afterStep?.(step); // bounded failure injection in integration tests
    };
    const agent = await runAgentCreate(root, profile.name, {
      profile: { ...profile, botToken: input.botToken || '' }, prepareOnly: true, resumePrepared: true,
    });
    const agentConfigPath = join(instanceDir, 'config.yaml');
    const agentConfig = readYaml(agentConfigPath);
    const engine = prepareFreshEngineConfig(root, profile);
    agentConfig.system.engineConfig = engine.engineConfigPath;
    agentConfig.engine = { thought: profile.model, consolidation: profile.model, dreaming: profile.model };
    agentConfig.substrate = seed.substrate;
    atomicWrite(agentConfigPath, yaml.dump(agentConfig, { lineWidth: 120 }));
    await checkpoint('resident-and-seed');
    await ensureBrainOperationsCapabilityKey(root);
    await secretsStore.updateHome23Secrets(root, secrets => {
      secrets.coordination ||= {};
      secrets.coordination.capabilityToken ||= randomBytes(32).toString('hex');
      secrets.coordination.residents ||= {};
      if (!Object.hasOwn(secrets.coordination.residents, profile.name)) {
        secrets.coordination.residents[profile.name] = { keyVersion: 1, key: randomBytes(32).toString('hex') };
      }
      return { changed: true };
    });
    mkdirSync(coordinationDir, { recursive: true, mode: 0o700 });
    const coordination = await provisionFreshHouse({ databasePath: join(coordinationDir, 'home23-coordination.sqlite3'), home: journal.home,
      resident: { slug: profile.name, name: profile.displayName, purpose: profile.purpose } });
    await checkpoint('canonical-home');
    const configPath = join(root, 'config', 'home.yaml');
    const home = readYaml(configPath);
    home.home = { ...home.home, id: journal.home.id, name: journal.home.name, primaryAgent: profile.name };
    home.query = { ...home.query, defaultProvider: profile.provider, defaultModel: profile.model,
      pgsSweepProvider: profile.provider, pgsSweepModel: profile.model,
      pgsSynthProvider: profile.provider, pgsSynthModel: profile.model };
    home.coordination = { ...home.coordination, homeId: journal.home.id, homeName: journal.home.name,
      primaryResident: profile.name, residentSlugs: [profile.name], process: { enabled: true },
      publicApi: { enabled: true, port: 7346 }, activity: { enabled: true }, attachments: { enabled: true },
      flags: { ...home.coordination?.flags, [`coordination.resident.${profile.name}.enabled`]: true,
        'coordination.channels.enabled': true, 'coordination.search.canonical': true,
        'coordination.apple.mac_cutover': true, 'coordination.apple.iphone_cutover': true,
        'coordination.bot_lifecycle.enabled': true },
    };
    atomicWrite(configPath, yaml.dump(home, { lineWidth: 120 }));
    generateEcosystem(root);
    await checkpoint('launch-config');
    const receipt = { schema: SCHEMA, status: 'prepared', home: journal.home,
      agent: { name: profile.name, displayName: profile.displayName, purpose: profile.purpose, ports: agent.ports, personalFacts: agentConfig.agent.owner.facts || [], ingestPaths: agent.ingestPaths, isPrimary: true },
      seed: seed.receipt, coordination,
      connection: { localURL: 'http://127.0.0.1:7346', access: 'loopback; remote devices require a trusted HTTPS or VPN transport', pairing: 'owner pairing code' },
      next: { command: `node cli/home23.js start ${profile.name}` }, replayed: false };
    journal.status = 'prepared'; journal.receipt = receipt; journal.completedAt = new Date().toISOString();
    atomicWrite(journalPath, JSON.stringify(journal, null, 2) + '\n');
    return receipt;
  } finally { await release(); }
}
