import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { localProbeRoster, probeLocalHome } from '../bin/organ-probes.js';

const require = createRequire(import.meta.url);
const { generateEcosystem } = require('../../cli/lib/generate-ecosystem.js');
const { productDefinitions, ownedProcessNames } = require('../../cli/lib/product-host.js');
const { productEnvironment } = require('../../cli/lib/product-environment.js');

test('installed probes follow only the declared local resident and report real chain/PM2 failures', () => {
  const home = mkdtempSync(join(tmpdir(), 'host-probe-'));
  const root = join(home, 'app');
  try {
    mkdirSync(join(home, 'runtime'));
    const stateDir = join(root, 'instances', 'milo', 'substrate', 'seed-01');
    const conversations = join(root, 'instances', 'milo', 'conversations');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(conversations, { recursive: true });
    writeFileSync(join(stateDir, 'seed-ledger.jsonl'), JSON.stringify({ issuedAt: new Date().toISOString(), category: 'transition', payload: {} }) + '\n');
    const apps = [
      { name: 'home23-milo', env: { HOME23_AGENT: 'milo', HOME23_CONVERSATIONS_DIR: conversations } },
      { name: 'home23-milo-seed', env: { HOME23_AGENT: 'milo', SEED_STATE_DIR: stateDir, SEED_LOBE: '' } },
      { name: 'home23-milo-shipper', env: { SHIPPER_CONVERSATIONS_DIR: conversations, SHIPPER_STREAM_PATH: join(stateDir, '..', 'conversation-stream.jsonl') } },
    ];
    writeFileSync(join(home, 'runtime', 'ecosystem.config.json'), JSON.stringify({ apps }));
    writeFileSync(join(root, 'ecosystem.config.cjs'), 'throw new Error("the general generator inventory is not the submitted Host plan");\n');
    const roster = localProbeRoster(root);
    assert.deepEqual(roster.engines, ['home23-milo']);
    assert.deepEqual(roster.seeds, [{ name: 'milo-seed', stateDir, agent: 'milo', hasLobe: false }]);
    assert.equal(roster.feeds[0]?.agent, 'milo');
    let reads = 0;
    const results = probeLocalHome(root, () => {
      reads++;
      return [{ name: 'home23-milo', pm2_env: { status: 'online' } }];
    });
    assert.equal(reads, 1, 'one private PM2 read, with no SSH or ambient inventory fallback');
    assert.ok(results.find(result => result.organ === 'milo-seed-chain')?.ok);
    assert.equal(results.find(result => result.organ === 'pm2:milo-seed')?.ok, false);
    assert.equal(results.some(result => /jerry|forrest|bobby|pi|retired|seed-thought/.test(result.organ)), false);
    rmSync(join(stateDir, 'seed-ledger.jsonl'));
    assert.equal(probeLocalHome(root, () => []).find(result => result.organ === 'milo-seed-chain')?.ok, false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('unreadable installed inventory reports the failure without falling back to developer home or PM2', () => {
  const home = mkdtempSync(join(tmpdir(), 'host-probe-missing-'));
  const root = join(home, 'app');
  try {
    mkdirSync(root);
    writeFileSync(join(root, 'ecosystem.config.cjs'), 'throw new Error("must not fall back to the general generated inventory");\n');
    const result = probeLocalHome(root, () => { throw new Error('must not inspect an unrelated daemon'); });
    assert.equal(result[0]?.organ, 'inventory');
    assert.equal(result[0]?.ok, false);
    mkdirSync(join(home, 'runtime'));
    for (const invalid of [{}, { apps: [] }, { apps: [{ name: 'unknown' }] }]) {
      writeFileSync(join(home, 'runtime', 'ecosystem.config.json'), JSON.stringify(invalid));
      assert.match(probeLocalHome(root)[0]?.why ?? '', /no valid submitted process plan/);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('real generated optional Chrome and MCP services do not enter the submitted Host monitoring plan', () => {
  const home = mkdtempSync(join(tmpdir(), 'host-generated-probe-'));
  const root = join(home, 'app');
  try {
    mkdirSync(join(root, 'config'), { recursive: true });
    mkdirSync(join(root, 'instances', 'milo'), { recursive: true });
    mkdirSync(join(home, 'runtime'));
    writeFileSync(join(root, 'config', 'home.yaml'), JSON.stringify({ home: { primaryAgent: 'milo' }, substrate: { observatory: {} } }));
    writeFileSync(join(root, 'instances', 'milo', 'config.yaml'), JSON.stringify({ agent: { displayName: 'Milo' }, ports: { engine: 24001, dashboard: 24002, mcp: 24003, bridge: 24004 }, substrate: { enabled: true } }));
    const generated = generateEcosystem(root, { quiet: true });
    const module = { exports: {} as { apps: Array<{ name: string }> } };
    runInNewContext(generated.ecosystemSource, { require, module, process: { env: productEnvironment(home) } });
    const generalNames = module.exports.apps.map(app => app.name);
    assert.ok(generalNames.includes('home23-chrome-cdp'));
    assert.ok(generalNames.includes('home23-milo-mcp'));
    const submitted = productDefinitions(module.exports.apps, home, 'milo');
    writeFileSync(join(home, 'runtime', 'ecosystem.config.json'), JSON.stringify({ apps: submitted }));
    const roster = localProbeRoster(root);
    assert.deepEqual(roster.expected, ownedProcessNames('milo'));
    assert.equal(roster.expected.some(name => /chrome|mcp/.test(name)), false);
    assert.equal(roster.feeds[0]?.agent, 'milo');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
