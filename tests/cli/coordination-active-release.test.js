import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

import { generateEcosystem } from '../../cli/lib/generate-ecosystem.js';

const require = createRequire(import.meta.url);
const TEST_NODE_MODULES = dirname(dirname(require.resolve('js-yaml/package.json')));
const RESOLVER = join(
  import.meta.dirname,
  '..',
  '..',
  'cli',
  'lib',
  'coordination-active-release.cjs',
);
const RELEASE_ID = 'a'.repeat(40);
const PREDECESSOR_ID = 'b'.repeat(40);
const JERRY_KEY = 'c'.repeat(64);
const FORREST_KEY = 'e'.repeat(64);

function makeInstall({
  pointer,
  pointerResidents,
  includeForrestKey = true,
  forrestKey = FORREST_KEY,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'home23-coordination-active-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'cli', 'lib'), { recursive: true });
  symlinkSync(TEST_NODE_MODULES, join(root, 'node_modules'), 'dir');
  symlinkSync(RESOLVER, join(root, 'cli', 'lib', 'coordination-active-release.cjs'));
  writeFileSync(join(root, 'config', 'home.yaml'), yaml.dump({
    home: { primaryAgent: 'jerry' },
  }));
  writeFileSync(join(root, 'config', 'secrets.yaml'), yaml.dump({ providers: {} }));

  for (const [name, base] of [['jerry', 5000], ['forrest', 5100], ['grokbot', 5200]]) {
    mkdirSync(join(root, 'instances', name), { recursive: true });
    writeFileSync(join(root, 'instances', name, 'config.yaml'), yaml.dump({
      agent: { displayName: name },
      ports: {
        engine: base + 1,
        dashboard: base + 2,
        mcp: base + 3,
        bridge: base + 4,
      },
    }));
  }

  const runtime = join(root, 'instances', '.house', 'coordination');
  const release = join(runtime, 'releases', RELEASE_ID);
  for (const relative of [
    'scripts/coordination/run.mjs',
    'dist/coordination/resident-protocol/index.js',
    'dist/coordination-adapter/index.js',
  ]) {
    const target = join(release, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, '// fixture\n');
  }
  writeFileSync(join(runtime, 'runtime-secrets.json'), JSON.stringify({
    capabilityToken: 'd'.repeat(64),
    residentJerryKey: JERRY_KEY,
    ...(includeForrestKey ? { residentForrestKey: forrestKey } : {}),
  }), { mode: 0o600 });
  chmodSync(join(runtime, 'runtime-secrets.json'), 0o600);
  writeFileSync(join(runtime, 'active-release.json'), JSON.stringify(pointer ?? {
    schemaVersion: 2,
    releaseId: RELEASE_ID,
    predecessorReleaseId: PREDECESSOR_ID,
    residents: pointerResidents ?? {
      jerry: { keyVersion: 1 },
      forrest: { keyVersion: 2 },
    },
  }), { mode: 0o600 });
  return root;
}

test('active release grants distinct reviewed credentials to Jerry and Forrest harnesses', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  generateEcosystem(root, { quiet: true });
  const generatedPath = join(root, 'ecosystem.config.cjs');
  const source = readFileSync(generatedPath, 'utf8');
  const apps = require(generatedPath).apps;
  const jerry = apps.find((app) => app.name === 'home23-jerry-harness');
  const forrest = apps.find((app) => app.name === 'home23-forrest-harness');
  const grokbot = apps.find((app) => app.name === 'home23-grokbot-harness');

  for (const [harness, key, version, slug] of [
    [jerry, JERRY_KEY, '1', 'jerry'],
    [forrest, FORREST_KEY, '2', 'forrest'],
  ]) {
    assert.equal(harness.env.HOME23_COORDINATION_RESIDENT_ENABLED, 'true');
    assert.equal(
      harness.env.HOME23_COORDINATION_RESIDENT_RUNTIME_ROOT,
      join(root, 'instances', '.house', 'coordination', 'releases', RELEASE_ID),
    );
    assert.equal(harness.env.HOME23_COORDINATION_RESIDENT_KEY, key);
    assert.equal(harness.env.HOME23_COORDINATION_RESIDENT_KEY_VERSION, version);
    assert.match(harness.env.HOME23_COORDINATION_RESIDENT_SOCKET_PATH, new RegExp(`resident-${slug}\\.sock$`));
    assert.ok(Buffer.byteLength(harness.env.HOME23_COORDINATION_RESIDENT_SOCKET_PATH) <= 103);
  }
  assert.notEqual(
    jerry.env.HOME23_COORDINATION_RESIDENT_KEY,
    forrest.env.HOME23_COORDINATION_RESIDENT_KEY,
  );
  assert.deepEqual(
    Object.keys(grokbot.env).filter((key) => key.startsWith('HOME23_COORDINATION_')),
    [],
  );
  assert.equal(source.includes(JERRY_KEY), false, 'generated config must not copy Jerry secret');
  assert.equal(source.includes(FORREST_KEY), false, 'generated config must not copy Forrest secret');
});

test('active release fails closed when runtime secrets are exposed', (t) => {
  const root = makeInstall();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  chmodSync(join(root, 'instances', '.house', 'coordination', 'runtime-secrets.json'), 0o644);
  generateEcosystem(root, { quiet: true });
  assert.throws(
    () => require(join(root, 'ecosystem.config.cjs')),
    /must not be accessible to group or other users/,
  );
});

test('active release fails closed when a reviewed resident key is absent', (t) => {
  const root = makeInstall({ includeForrestKey: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  generateEcosystem(root, { quiet: true });
  assert.throws(
    () => require(join(root, 'ecosystem.config.cjs')),
    /Forrest resident key must contain exactly 32 bytes of hex/,
  );
});

test('active release rejects an unreviewed resident slug', (t) => {
  const root = makeInstall({
    pointerResidents: { jerry: { keyVersion: 1 }, clay: { keyVersion: 1 } },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  generateEcosystem(root, { quiet: true });
  assert.throws(
    () => require(join(root, 'ecosystem.config.cjs')),
    /contains an unsupported resident/,
  );
});

test('schemaVersion 1 remains a fail-closed Jerry-only compatibility path', (t) => {
  const root = makeInstall({
    pointer: {
      schemaVersion: 1,
      releaseId: RELEASE_ID,
      predecessorReleaseId: PREDECESSOR_ID,
      residentSlug: 'jerry',
      residentKeyVersion: 7,
    },
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  generateEcosystem(root, { quiet: true });
  const apps = require(join(root, 'ecosystem.config.cjs')).apps;
  const jerry = apps.find((app) => app.name === 'home23-jerry-harness');
  const forrest = apps.find((app) => app.name === 'home23-forrest-harness');
  assert.equal(jerry.env.HOME23_COORDINATION_RESIDENT_ENABLED, 'true');
  assert.equal(jerry.env.HOME23_COORDINATION_RESIDENT_KEY_VERSION, '7');
  assert.deepEqual(
    Object.keys(forrest.env).filter((key) => key.startsWith('HOME23_COORDINATION_')),
    [],
  );
});

test('active release rejects a credential shared by two residents', (t) => {
  const root = makeInstall({ forrestKey: JERRY_KEY });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  generateEcosystem(root, { quiet: true });
  assert.throws(
    () => require(join(root, 'ecosystem.config.cjs')),
    /resident keys must be distinct/,
  );
});
