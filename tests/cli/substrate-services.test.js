/**
 * The substrate's auxiliary processes must be GENERATED, not started by hand.
 *
 * Six of them were running outside ecosystem.config.cjs on 2026-08-11
 * (seed-observatory, two conversation shippers, house-sense, the bobby lobe
 * broker, and the bobby house-stream shipper). Consequences: PM2 default log
 * paths for two of them, nothing recreated by `home23 start`, and no record if
 * PM2 ever loses them — the exact failure that silenced forrest's engine logs
 * on 2026-08-09.
 *
 * Everything machine-specific stays in config (and the scripts themselves live
 * under instances/, which is gitignored) so the public repo keeps no Pi
 * addresses, SSH keys, or dated field-trip paths.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

import { generateEcosystem } from '../../cli/lib/generate-ecosystem.js';

const require = createRequire(import.meta.url);
const TEST_NODE_MODULES = dirname(dirname(require.resolve('js-yaml/package.json')));

/** @param {{ home?: object, substrate?: object|null }} opts */
function makeInstall(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'home23-substrate-services-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'instances', 'jerry'), { recursive: true });
  symlinkSync(TEST_NODE_MODULES, join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'config', 'home.yaml'), yaml.dump({
    home: { primaryAgent: 'jerry' },
    providers: { openai: { defaultModels: ['gpt-test'] } },
    chat: { defaultProvider: 'openai', defaultModel: 'gpt-test' },
    ...(opts.home ?? {}),
  }), 'utf8');
  writeFileSync(join(root, 'config', 'secrets.yaml'), yaml.dump({
    providers: {},
    bridge: { token: 'bridge-token-should-not-leak' },
    cosmo23: { encryptionKey: 'not-a-real-secret' },
  }), 'utf8');
  writeFileSync(join(root, 'instances', 'jerry', 'config.yaml'), yaml.dump({
    agent: { displayName: 'jerry' },
    ports: { engine: 5001, dashboard: 5002, mcp: 5003 },
    ...(opts.substrate === null ? {} : { substrate: opts.substrate ?? { enabled: true } }),
  }), 'utf8');
  generateEcosystem(root);
  return root;
}

function loadApps(root) {
  const config = require(join(root, 'ecosystem.config.cjs'));
  return config.apps;
}

test('the observatory is generated when an agent runs a seed', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = loadApps(root).find((a) => a.name === 'home23-seed-observatory');

  assert.ok(app, 'seed-observatory must be emitted for a substrate install');
  assert.match(app.script, /substrate\/bin\/seed-observatory\.ts$/);
  assert.equal(app.node_args, '--import tsx', 'it is TypeScript, run through tsx');
  // The 2026-08-09 forrest incident: a hand-started process lands on PM2's
  // default log paths and its output becomes invisible to the verifiers.
  assert.match(app.out_file, /logs\/observatory-out\.log$/);
  assert.match(app.error_file, /logs\/observatory-err\.log$/);
});

test('a house with no seeds emits no observatory', (t) => {
  const root = makeInstall({ substrate: { enabled: false } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(loadApps(root).find((a) => a.name === 'home23-seed-observatory'), undefined,
    'nothing to watch means nothing to run');
});

test('the observatory watches every seed-running agent, derived not hand-listed', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = loadApps(root).find((a) => a.name === 'home23-seed-observatory');

  const individuals = JSON.parse(app.env.OBSERVATORY_INDIVIDUALS);
  const jerry = individuals.find((i) => i.name === 'jerry-seed');
  assert.ok(jerry, 'a substrate-enabled agent appears without being listed by hand');
  assert.match(jerry.stateDir, /instances\/jerry\/substrate\/seed-01$/);
});

test('individuals that are not agents (a remote mirror, an archived seed) come from config', (t) => {
  // bobby lives on a Pi and is mirrored locally; clay is neither an agent nor
  // running. Neither is derivable, so both must be declarable.
  const root = makeInstall({
    home: {
      substrate: {
        observatory: {
          port: 5150,
          extraIndividuals: [
            { name: 'bobby', stateDir: 'instances/bobby/seed-01-mirror' },
            { name: 'clay', stateDir: 'instances/clay/seed-01', note: 'archived' },
          ],
        },
      },
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = loadApps(root).find((a) => a.name === 'home23-seed-observatory');

  assert.equal(app.env.OBSERVATORY_PORT, '5150', 'port is configurable');
  const individuals = JSON.parse(app.env.OBSERVATORY_INDIVIDUALS);
  const names = individuals.map((i) => i.name).sort();
  assert.deepEqual(names, ['bobby', 'clay', 'jerry-seed'], 'derived + declared, together');
  const bobby = individuals.find((i) => i.name === 'bobby');
  assert.ok(bobby.stateDir.startsWith('/'), 'relative config paths resolve against the install root');
  assert.equal(individuals.find((i) => i.name === 'clay').note, 'archived', 'optional fields survive');
});

test('the observatory defaults to port 5050 and is granted no secrets it does not read', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = loadApps(root).find((a) => a.name === 'home23-seed-observatory');

  assert.equal(app.env.OBSERVATORY_PORT, '5050');
  // It reads OBSERVATORY_* and ORGAN_SENTINEL_* only. The hand-started process
  // carried HOME23_BRIDGE_TOKEN it never read — the same over-grant class as
  // the brain-operations capability key. Do not reproduce it.
  assert.equal(app.env.HOME23_BRIDGE_TOKEN, undefined, 'no bridge token');
  assert.equal(app.env.HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY, undefined, 'no capability key');
  assert.ok(app.filter_env.includes('HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY'),
    'and inherited copies are filtered out too');
});

test('declared substrate shippers are generated, with nothing machine-specific in the repo', (t) => {
  const root = makeInstall({
    home: {
      substrate: {
        shippers: [
          { name: 'bobby-house-shipper', script: 'instances/jerry/substrate/ship.sh', interpreter: 'bash' },
        ],
      },
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = loadApps(root).find((a) => a.name === 'home23-bobby-house-shipper');

  assert.ok(app, 'a declared shipper is emitted');
  assert.match(app.script, /instances\/jerry\/substrate\/ship\.sh$/);
  assert.equal(app.interpreter, 'bash');
  assert.match(app.out_file, /logs\/bobby-house-shipper-out\.log$/);
  assert.equal(app.autorestart, true, 'a shipper that dies must come back');
});

test('no shippers declared, none emitted', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Declared shippers only. The per-agent conversation shipper below is
  // derived from substrate.enabled and is a different thing entirely.
  assert.equal(loadApps(root).some((a) => a.name === 'home23-bobby-house-shipper'), false);
});

// ── the remaining four: per-agent feeds, and brokers for remote residents ──

test('a seed-running agent gets its conversation shipper, writing exactly what the seed reads', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = loadApps(root);
  const shipper = apps.find((a) => a.name === 'home23-jerry-shipper');
  const seed = apps.find((a) => a.name === 'home23-jerry-seed');

  assert.ok(shipper, 'a seed with no conversation feed is a seed that starves');
  assert.match(shipper.script, /substrate\/bin\/conversation-shipper\.ts$/);
  assert.equal(shipper.node_args, '--import tsx');
  assert.match(shipper.env.SHIPPER_CONVERSATIONS_DIR, /instances\/jerry\/conversations$/);
  // The writer and the reader must be the same path. Deriving both from one
  // place is what makes them impossible to drift apart.
  assert.equal(shipper.env.SHIPPER_STREAM_PATH, seed.env.SEED_CONVERSATION_SOURCE,
    'shipper writes precisely the stream the seed consumes');
  assert.equal(shipper.env.SHIPPER_BACKFILL_BYTES, '524288', 'default backfill');
});

test('no seed, no shipper', (t) => {
  const root = makeInstall({ substrate: { enabled: false } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(loadApps(root).find((a) => a.name === 'home23-jerry-shipper'), undefined);
});

test('house-sense is opt-in per agent and feeds the seed its house stream', (t) => {
  const root = makeInstall({ substrate: { enabled: true, houseSense: true } });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const apps = loadApps(root);
  const sense = apps.find((a) => a.name === 'home23-jerry-house-sense');
  const seed = apps.find((a) => a.name === 'home23-jerry-seed');

  assert.ok(sense, 'declared houseSense emits the sensor');
  assert.match(sense.script, /substrate\/bin\/house-sense\.ts$/);
  assert.equal(sense.env.SHIPPER_STREAM_PATH, seed.env.SEED_HOUSE_SOURCE,
    'house sensor writes precisely the stream the seed consumes');
});

test('house-sense stays off unless asked for', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(loadApps(root).find((a) => a.name === 'home23-jerry-house-sense'), undefined,
    'a seed-running agent does not automatically sense the house');
});

test('a declared broker carries a remote resident, with the address only in config', (t) => {
  const root = makeInstall({
    home: {
      substrate: {
        brokers: [{
          name: 'bobby',
          sshHost: '10.0.0.9',
          remoteDir: '/home/jtr/bobby/lobe-exchange',
          model: 'claude-haiku-4-5',
          intervalMs: 20000,
          stateDest: 'instances/bobby/seed-01-mirror',
          stateRemote: '/home/jtr/bobby/seed-01',
        }],
      },
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = loadApps(root).find((a) => a.name === 'home23-bobby-broker');

  assert.ok(app, 'a declared broker is emitted');
  assert.match(app.script, /substrate\/bin\/lobe-broker\.ts$/);
  assert.equal(app.node_args, '--import tsx');
  assert.equal(app.env.BROKER_SSH_HOST, '10.0.0.9');
  assert.equal(app.env.BROKER_REMOTE_DIR, '/home/jtr/bobby/lobe-exchange');
  assert.equal(app.env.BROKER_MODEL, 'claude-haiku-4-5');
  assert.equal(app.env.BROKER_INTERVAL_MS, '20000');
  assert.match(app.env.BROKER_STATE_DEST, /instances\/bobby\/seed-01-mirror$/);
  assert.ok(app.env.BROKER_STATE_DEST.startsWith('/'), 'local dest resolves against the install');
  assert.equal(app.env.BROKER_STATE_REMOTE, '/home/jtr/bobby/seed-01', 'remote path stays verbatim');
});

test('no brokers declared, none emitted', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(loadApps(root).some((a) => /broker/.test(a.name)), false);
});
