import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  agentProcessNames,
  agentProcessNameCandidates,
  filterNamesByEcosystem,
} = require('../../shared/agent-process-names.cjs');

function makeInstance(root, name, configYaml) {
  const dir = join(root, 'instances', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yaml'), configYaml);
}

test('default agent config yields engine, dash, mcp, harness — no seed', () => {
  const names = agentProcessNames({ agentName: 'jerry', config: {} });
  assert.deepEqual(names, [
    'home23-jerry',
    'home23-jerry-dash',
    'home23-jerry-mcp',
    'home23-jerry-harness',
  ]);
});

test('substrate.enabled: true adds the seed runner process', () => {
  const names = agentProcessNames({
    agentName: 'jerry',
    config: { substrate: { enabled: true } },
  });
  assert.deepEqual(names, [
    'home23-jerry',
    'home23-jerry-dash',
    'home23-jerry-mcp',
    'home23-jerry-harness',
    'home23-jerry-seed',
  ]);
});

test('mcp.enabled: false removes the mcp process, mirroring the generator', () => {
  const names = agentProcessNames({
    agentName: 'forrest',
    config: { mcp: { enabled: false }, substrate: { enabled: true } },
  });
  assert.deepEqual(names, [
    'home23-forrest',
    'home23-forrest-dash',
    'home23-forrest-harness',
    'home23-forrest-seed',
  ]);
});

test('substrate must be exactly enabled: true — truthy strings do not count', () => {
  const names = agentProcessNames({
    agentName: 'jerry',
    config: { substrate: { enabled: 'yes' } },
  });
  assert.ok(!names.includes('home23-jerry-seed'));
});

test('reads the instance config.yaml when config is not passed', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-procnames-'));
  try {
    makeInstance(root, 'mabel', 'substrate:\n  enabled: true\nmcp:\n  enabled: false\n');
    const names = agentProcessNames({ home23Root: root, agentName: 'mabel' });
    assert.deepEqual(names, [
      'home23-mabel',
      'home23-mabel-dash',
      'home23-mabel-harness',
      'home23-mabel-seed',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing instance config falls back to the default process set', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-procnames-'));
  try {
    const names = agentProcessNames({ home23Root: root, agentName: 'ghost' });
    assert.deepEqual(names, [
      'home23-ghost',
      'home23-ghost-dash',
      'home23-ghost-mcp',
      'home23-ghost-harness',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('candidates cover every possible suffix for teardown paths', () => {
  assert.deepEqual(agentProcessNameCandidates('jerry'), [
    'home23-jerry',
    'home23-jerry-dash',
    'home23-jerry-mcp',
    'home23-jerry-harness',
    'home23-jerry-seed',
  ]);
});

test('candidates exclude names owned by a sibling agent with a suffix-shaped name', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-procnames-'));
  try {
    makeInstance(root, 'alice', 'substrate:\n  enabled: true\n');
    makeInstance(root, 'alice-seed', 'agent:\n  displayName: alice-seed\n');
    // home23-alice-seed is agent alice-seed's ENGINE — stopping or deleting
    // alice must not reach it.
    assert.deepEqual(agentProcessNameCandidates('alice', root), [
      'home23-alice',
      'home23-alice-dash',
      'home23-alice-mcp',
      'home23-alice-harness',
    ]);
    // And alice's config-derived set drops the colliding seed name too.
    assert.deepEqual(agentProcessNames({ home23Root: root, agentName: 'alice' }), [
      'home23-alice',
      'home23-alice-dash',
      'home23-alice-mcp',
      'home23-alice-harness',
    ]);
    // The sibling's own lifecycle is unaffected.
    assert.deepEqual(agentProcessNameCandidates('alice-seed', root), [
      'home23-alice-seed',
      'home23-alice-seed-dash',
      'home23-alice-seed-mcp',
      'home23-alice-seed-harness',
      'home23-alice-seed-seed',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('filterNamesByEcosystem keeps only names declared in the generated file', () => {
  const root = mkdtempSync(join(tmpdir(), 'home23-procnames-'));
  try {
    const ecosystemPath = join(root, 'ecosystem.config.cjs');
    writeFileSync(ecosystemPath, [
      'module.exports = { apps: [',
      "    { name: 'home23-jerry', script: 'engine/src/index.js' },",
      "    { name: 'home23-jerry-dash', script: 'engine/src/dashboard/server.js' },",
      "    { name: 'home23-jerry-harness', script: 'dist/home.js' },",
      '] };',
    ].join('\n'));
    const filtered = filterNamesByEcosystem(
      agentProcessNameCandidates('jerry'),
      ecosystemPath,
    );
    assert.deepEqual(filtered, [
      'home23-jerry',
      'home23-jerry-dash',
      'home23-jerry-harness',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('filterNamesByEcosystem passes names through when the file is unreadable', () => {
  const names = agentProcessNameCandidates('jerry');
  const filtered = filterNamesByEcosystem(names, '/nonexistent/ecosystem.config.cjs');
  assert.deepEqual(filtered, names);
});
