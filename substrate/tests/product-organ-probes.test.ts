import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { localProbeRoster, probeLocalHome } from '../bin/organ-probes.js';

test('installed probes follow only the declared local resident and report real chain/PM2 failures', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-probe-'));
  try {
    const stateDir = join(root, 'instances', 'milo', 'substrate', 'seed-01');
    const conversations = join(root, 'instances', 'milo', 'conversations');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(conversations, { recursive: true });
    writeFileSync(join(stateDir, 'seed-ledger.jsonl'), JSON.stringify({ issuedAt: new Date().toISOString(), category: 'transition', payload: {} }) + '\n');
    const apps = [
      { name: 'home23-milo', env: { HOME23_AGENT: 'milo', HOME23_CONVERSATIONS_DIR: conversations } },
      { name: 'home23-milo-seed', env: { HOME23_AGENT: 'milo', SEED_STATE_DIR: stateDir, SEED_LOBE: '' } },
      { name: 'home23-milo-shipper', env: { SHIPPER_CONVERSATIONS_DIR: conversations, SHIPPER_STREAM_PATH: join(stateDir, '..', 'conversation-stream.jsonl') } },
      { name: 'home23-retired', autostart: false },
    ];
    writeFileSync(join(root, 'ecosystem.config.cjs'), `module.exports = ${JSON.stringify({ apps })};\n`);
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('unreadable installed inventory reports the failure without falling back to developer home or PM2', () => {
  const root = mkdtempSync(join(tmpdir(), 'host-probe-missing-'));
  try {
    const result = probeLocalHome(root, () => { throw new Error('must not inspect an unrelated daemon'); });
    assert.equal(result[0]?.organ, 'inventory');
    assert.equal(result[0]?.ok, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
