import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';

function fixture(t: { after(fn: () => void): void }, agent: string) {
  const root = mkdtempSync(join(tmpdir(), 'seed-surface-config-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'instances', 'river'), { recursive: true });
  writeFileSync(join(root, 'config/home.yaml'), '{}\n');
  writeFileSync(join(root, 'instances/river/config.yaml'), agent);
  const prior = process.env.HOME23_ROOT;
  process.env.HOME23_ROOT = root;
  t.after(() => {
    if (prior === undefined) delete process.env.HOME23_ROOT;
    else process.env.HOME23_ROOT = prior;
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test('Seed-enabled agent derives the state directory used by all lived surfaces', t => {
  const root = fixture(t, 'substrate:\n  enabled: true\nsituationalAwareness:\n  bootstrap:\n    reads: [NOW.md]\n  substrate:\n    budget: 1200\n');
  const config = loadConfig('river');
  assert.equal(config.situationalAwareness?.substrate?.stateDir, join(root, 'instances/river/substrate/seed-01'));
  assert.equal(config.situationalAwareness?.substrate?.budget, 1200);
  assert.deepEqual(config.situationalAwareness?.bootstrap?.reads, ['NOW.md']);
});

test('explicit Seed mirror path survives config loading', t => {
  fixture(t, 'substrate:\n  enabled: true\nsituationalAwareness:\n  substrate:\n    stateDir: /tmp/explicit-mirror\n');
  assert.equal(loadConfig('river').situationalAwareness?.substrate?.stateDir, '/tmp/explicit-mirror');
});

test('agent without an enabled Seed does not gain a lived surface path', t => {
  fixture(t, 'substrate:\n  enabled: false\n');
  assert.equal(loadConfig('river').situationalAwareness?.substrate?.stateDir, undefined);
});

test('external instance storage derives the same Seed path as the runner', t => {
  const root = fixture(t, 'substrate:\n  enabled: true\n');
  const externalInstance = join(root, 'external/river');
  writeFileSync(join(root, 'instances/river/config.yaml'), `system:\n  instanceRoot: ${JSON.stringify(externalInstance)}\nsubstrate:\n  enabled: true\n`);
  assert.equal(loadConfig('river').situationalAwareness?.substrate?.stateDir, join(externalInstance, 'substrate/seed-01'));
});
