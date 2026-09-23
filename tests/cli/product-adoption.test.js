import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { projectFencedCoordination, readFencedCoordination } from '../../cli/lib/product-adoption.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');

test('fenced adoption projects effective coordination into supported config and preserves other grants', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-coordination-adopt-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), destination = path.join(root, 'destination');
  const app = path.join(destination, 'app');
  fs.mkdirSync(path.join(source, 'instances/.house/coordination'), { recursive: true });
  fs.mkdirSync(path.join(app, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'AuthKey.p8'), 'synthetic key\n');
  const env = {
    HOME23_ROOT: source, HOME23_COORDINATION_HOST: '127.0.0.1', HOME23_COORDINATION_PORT: '7346',
    HOME23_COORDINATION_ENABLED: 'true', HOME23_COORDINATION_PUBLIC_API_ENABLED: 'true',
    HOME23_COORDINATION_ATTACHMENTS_ENABLED: 'true', HOME23_COORDINATION_PUSH_ENABLED: 'true',
    HOME23_COORDINATION_CAPABILITY_TOKEN: 'synthetic-capability',
    HOME23_COORDINATION_APNS_TEAM_ID: 'ABCDEFGHIJ', HOME23_COORDINATION_APNS_KEY_ID: '1234567890',
    HOME23_COORDINATION_APNS_KEY_PATH: path.join(root, 'AuthKey.p8'),
    HOME23_COORDINATION_APNS_BUNDLE_ID: 'com.example.home23', HOME23_COORDINATION_APNS_DEFAULT_ENV: 'production',
  };
  for (const name of ['JERRY', 'FORREST']) {
    env[`HOME23_COORDINATION_RESIDENT_${name}_KEY`] = `synthetic-${name}`;
    env[`HOME23_COORDINATION_RESIDENT_${name}_KEY_VERSION`] = '4';
  }
  for (const [name, value] of Object.entries({
    RESIDENT_JERRY_ENABLED: true, RESIDENT_FORREST_ENABLED: true, CHANNELS_ENABLED: true,
    SEARCH_CANONICAL: false, IMPORT_SHADOW_ENABLED: false, APPLE_MAC_CUTOVER: false,
    APPLE_IPHONE_CUTOVER: true, BOT_LIFECYCLE_ENABLED: true, COMPACTION_ENABLED: false,
  })) env[`HOME23_COORDINATION_${name}`] = String(value);
  fs.writeFileSync(path.join(source, 'instances/.house/coordination/ecosystem.fenced-metadata.json'),
    JSON.stringify({ schema: 'home23.fenced-coordination-export.v1', apps: [{ name: 'home23-coordination', script: '/usr/bin/false', env }] }),
    { mode: 0o600 });
  fs.writeFileSync(path.join(destination, '.home23-host.json'), JSON.stringify({ homeRoot: destination,
    birth: { home: { id: 'home-test', name: 'Family' } }, ports: { coordination: 7346 } }));
  fs.writeFileSync(path.join(app, 'config/home.yaml'), yaml.dump({ home: { primaryAgent: 'jerry' },
    coordination: { socketDirectory: path.join(source, 'old-sockets') }, extra: 'keep' }));
  fs.writeFileSync(path.join(app, 'config/secrets.yaml'), yaml.dump({ provider: { anthropic: 'keep' },
    brainOperations: { capabilityKey: 'a'.repeat(64) } }), { mode: 0o600 });
  const fenced = readFencedCoordination(source);
  assert.equal(await projectFencedCoordination(destination, fenced), true);
  const home = yaml.load(fs.readFileSync(path.join(app, 'config/home.yaml'), 'utf8'));
  const secrets = yaml.load(fs.readFileSync(path.join(app, 'config/secrets.yaml'), 'utf8'));
  assert.equal(home.extra, 'keep');
  assert.equal(home.coordination.process.enabled, true);
  assert.equal(home.coordination.publicApi.port, 7346);
  assert.equal(home.coordination.flags['coordination.apple.iphone_cutover'], true);
  assert.equal(home.coordination.socketDirectory, undefined);
  assert.equal(secrets.provider.anthropic, 'keep');
  assert.equal(secrets.brainOperations.capabilityKey, 'a'.repeat(64));
  assert.equal(secrets.coordination.residents.forrest.keyVersion, 4);
  assert.equal(secrets.apns.key_path, path.join(root, 'AuthKey.p8'));
  assert.equal(await projectFencedCoordination(destination, fenced), true);
  assert.equal(readFencedCoordination(path.join(root, 'ordinary')), null);
});
