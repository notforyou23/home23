/** Carry a fenced legacy coordinator's effective settings into the supported home config. */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join } from 'node:path';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const { readHome23Secrets, updateHome23Secrets } = require('../../shared/home23-secrets.cjs');
const FLAGS = {
  'coordination.resident.jerry.enabled': 'HOME23_COORDINATION_RESIDENT_JERRY_ENABLED',
  'coordination.resident.forrest.enabled': 'HOME23_COORDINATION_RESIDENT_FORREST_ENABLED',
  'coordination.channels.enabled': 'HOME23_COORDINATION_CHANNELS_ENABLED',
  'coordination.search.canonical': 'HOME23_COORDINATION_SEARCH_CANONICAL',
  'coordination.import.shadow_enabled': 'HOME23_COORDINATION_IMPORT_SHADOW_ENABLED',
  'coordination.apple.mac_cutover': 'HOME23_COORDINATION_APPLE_MAC_CUTOVER',
  'coordination.apple.iphone_cutover': 'HOME23_COORDINATION_APPLE_IPHONE_CUTOVER',
  'coordination.bot_lifecycle.enabled': 'HOME23_COORDINATION_BOT_LIFECYCLE_ENABLED',
  'coordination.compaction.enabled': 'HOME23_COORDINATION_COMPACTION_ENABLED',
};
const requiredBoolean = (env, key) => {
  if (env[key] !== 'true' && env[key] !== 'false') throw new Error(`Fenced coordination metadata has invalid ${key}.`);
  return env[key] === 'true';
};
const regular = file => {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Fenced coordination metadata is not a regular file.');
  return readFileSync(file);
};

/** Null means ordinary config-owned coordination; no legacy projection is needed. */
export function readFencedCoordination(source) {
  const file = join(source, 'instances/.house/coordination/ecosystem.fenced-metadata.json');
  if (!existsSync(file)) return null;
  if ((lstatSync(file).mode & 0o077) !== 0) throw new Error('Fenced coordination metadata is not private.');
  const data = JSON.parse(regular(file));
  if (data?.schema !== 'home23.fenced-coordination-export.v1' || data.apps?.length !== 1
    || data.apps[0]?.name !== 'home23-coordination' || data.apps[0]?.script !== '/usr/bin/false') {
    throw new Error('Fenced coordination metadata has an unsupported authority.');
  }
  const env = data.apps[0].env;
  if (!env || env.HOME23_ROOT !== source || env.HOME23_COORDINATION_HOST !== '127.0.0.1') {
    throw new Error('Fenced coordination metadata belongs to another home.');
  }
  for (const key of ['HOME23_COORDINATION_ENABLED', 'HOME23_COORDINATION_PUBLIC_API_ENABLED',
    'HOME23_COORDINATION_ATTACHMENTS_ENABLED', 'HOME23_COORDINATION_PUSH_ENABLED', ...Object.values(FLAGS)]) {
    requiredBoolean(env, key);
  }
  if (!/^\d{1,5}$/.test(env.HOME23_COORDINATION_PORT || '')
    || !env.HOME23_COORDINATION_CAPABILITY_TOKEN) throw new Error('Fenced coordination metadata has no valid binding.');
  for (const name of ['JERRY', 'FORREST']) {
    const version = Number(env[`HOME23_COORDINATION_RESIDENT_${name}_KEY_VERSION`]);
    if (!env[`HOME23_COORDINATION_RESIDENT_${name}_KEY`] || !Number.isSafeInteger(version) || version < 1) {
      throw new Error('Fenced coordination metadata is missing a resident credential.');
    }
  }
  const apns = {
    team_id: env.HOME23_COORDINATION_APNS_TEAM_ID,
    key_id: env.HOME23_COORDINATION_APNS_KEY_ID,
    key_path: env.HOME23_COORDINATION_APNS_KEY_PATH,
    bundle_id: env.HOME23_COORDINATION_APNS_BUNDLE_ID,
    default_env: env.HOME23_COORDINATION_APNS_DEFAULT_ENV,
  };
  if (requiredBoolean(env, 'HOME23_COORDINATION_PUSH_ENABLED')
    && (!/^[A-Z0-9]{10}$/.test(apns.team_id) || !/^[A-Z0-9]{10}$/.test(apns.key_id)
      || !isAbsolute(apns.key_path || '') || !existsSync(apns.key_path)
      || !lstatSync(apns.key_path).isFile()
      || !/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/.test(apns.bundle_id)
      || !['sandbox', 'production'].includes(apns.default_env))) {
    throw new Error('Fenced coordination APNs binding is unavailable.');
  }
  return { env, apns };
}

function atomicHomeYaml(file, previous, next) {
  if (!readFileSync(file).equals(previous)) throw new Error('Adopted home configuration changed before coordination projection.');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, yaml.dump(next, { lineWidth: 120, noRefs: true }), { flag: 'wx', mode: 0o600 });
    const fd = openSync(temporary, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    if (!readFileSync(file).equals(previous)) throw new Error('Adopted home configuration changed before coordination commit.');
    renameSync(temporary, file);
    const dir = openSync(dirname(file), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/** Idempotent on a rebind-phase retry. Mutates only destination's supported YAML. */
export async function projectFencedCoordination(destination, fenced) {
  if (!fenced) return false;
  const app = join(destination, 'app');
  const host = JSON.parse(readFileSync(join(destination, '.home23-host.json'), 'utf8'));
  const { env, apns } = fenced;
  if (host.homeRoot !== destination || !host.birth?.home?.id || !host.birth?.home?.name
    || String(host.ports?.coordination) !== env.HOME23_COORDINATION_PORT) {
    throw new Error('Adopted Host identity differs from fenced coordination binding.');
  }
  const homeFile = join(app, 'config/home.yaml');
  const previous = regular(homeFile);
  const home = yaml.load(previous.toString('utf8'));
  if (!home || typeof home !== 'object' || Array.isArray(home)) throw new Error('Adopted home configuration is invalid.');
  const old = home.coordination && typeof home.coordination === 'object' ? home.coordination : {};
  const next = { ...home, coordination: {
    ...old, homeId: host.birth.home.id, homeName: host.birth.home.name,
    primaryResident: home.home?.primaryAgent, residentSlugs: ['jerry', 'forrest'],
    process: { ...old.process, enabled: requiredBoolean(env, 'HOME23_COORDINATION_ENABLED') },
    publicApi: { ...old.publicApi, enabled: requiredBoolean(env, 'HOME23_COORDINATION_PUBLIC_API_ENABLED'), port: host.ports.coordination },
    attachments: { ...old.attachments, enabled: requiredBoolean(env, 'HOME23_COORDINATION_ATTACHMENTS_ENABLED') },
    push: { ...old.push, enabled: requiredBoolean(env, 'HOME23_COORDINATION_PUSH_ENABLED') },
    ...(env.HOME23_COORDINATION_ACTIVITY_ENABLED === undefined ? {} : {
      activity: { ...old.activity, enabled: requiredBoolean(env, 'HOME23_COORDINATION_ACTIVITY_ENABLED') },
    }),
    flags: { ...old.flags, ...Object.fromEntries(Object.entries(FLAGS).map(([key, value]) => [key, requiredBoolean(env, value)])) },
  } };
  // The generator derives a fresh, shared internal socket layout. Do not
  // carry the old source's socketDirectory into the adopted home.
  delete next.coordination.socketDirectory;
  await updateHome23Secrets(app, secrets => {
    secrets.coordination ||= {};
    secrets.coordination.capabilityToken = env.HOME23_COORDINATION_CAPABILITY_TOKEN;
    secrets.coordination.residents ||= {};
    for (const name of ['jerry', 'forrest']) {
      secrets.coordination.residents[name] = {
        ...secrets.coordination.residents[name],
        key: env[`HOME23_COORDINATION_RESIDENT_${name.toUpperCase()}_KEY`],
        keyVersion: Number(env[`HOME23_COORDINATION_RESIDENT_${name.toUpperCase()}_KEY_VERSION`]),
      };
    }
    secrets.apns = { ...secrets.apns, ...apns };
    return { changed: true };
  });
  atomicHomeYaml(homeFile, previous, next);
  const actualHome = yaml.load(regular(homeFile).toString('utf8'));
  const actualSecrets = await readHome23Secrets(app);
  if (JSON.stringify(actualHome.coordination) !== JSON.stringify(next.coordination)
    || actualSecrets.coordination?.capabilityToken !== env.HOME23_COORDINATION_CAPABILITY_TOKEN
    || ['jerry', 'forrest'].some(name => actualSecrets.coordination?.residents?.[name]?.key
      !== env[`HOME23_COORDINATION_RESIDENT_${name.toUpperCase()}_KEY`])
    || Object.entries(apns).some(([key, value]) => actualSecrets.apns?.[key] !== value)) {
    throw new Error('Adopted coordination configuration readback differs.');
  }
  return true;
}
