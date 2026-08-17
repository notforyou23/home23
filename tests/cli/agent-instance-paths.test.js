import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

import {
  assertAgentInstanceStorageReady,
  resolveAgentInstancePaths,
} from '../../shared/agent-instance-paths.cjs';

function makeInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-agent-instance-paths-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'instances'), { recursive: true });
  fs.writeFileSync(join(root, 'config', 'home.yaml'), yaml.dump({
    home: { primaryAgent: 'jerry' },
  }), 'utf8');
  return root;
}

function join(...parts) {
  return path.join(...parts);
}

function writeLocalAgentConfig(root, agent, config = {}) {
  const instanceDir = join(root, 'instances', agent);
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(join(instanceDir, 'config.yaml'), yaml.dump({
    agent: { name: agent, displayName: agent },
    ports: { engine: 5001, dashboard: 5002, mcp: 5003, bridge: 5004 },
    system: { name: 'home23', version: '1.0.0', workspace: 'workspace' },
    ...config,
  }), 'utf8');
}

test('resolver keeps ordinary local agents on instances/<agent>', () => {
  const root = makeInstall();
  try {
    const localRoot = join(root, 'instances', 'jerry');
    fs.mkdirSync(join(localRoot, 'brain'), { recursive: true });
    fs.mkdirSync(join(localRoot, 'workspace'), { recursive: true });
    writeLocalAgentConfig(root, 'jerry');

    const resolved = resolveAgentInstancePaths(root, 'jerry', { requireConfig: true });
    assert.equal(resolved.storageMode, 'local');
    assert.equal(resolved.instanceRoot, localRoot);
    assert.equal(resolved.configPath, join(localRoot, 'config.yaml'));
    assert.equal(resolved.brainDir, join(localRoot, 'brain'));
    assert.equal(resolved.workspaceDir, join(localRoot, 'workspace'));
    assert.equal(resolved.conversationsDir, join(localRoot, 'conversations'));
    assert.equal(resolved.logsDir, join(localRoot, 'logs'));
    assert.doesNotThrow(() => assertAgentInstanceStorageReady(resolved));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolver maps a configured system.instanceRoot onto an external runtime root', () => {
  const root = makeInstall();
  const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-agent-external-root-'));
  try {
    fs.mkdirSync(join(externalRoot, 'brain'), { recursive: true });
    fs.mkdirSync(join(externalRoot, 'workspace'), { recursive: true });
    fs.mkdirSync(join(externalRoot, 'conversations'), { recursive: true });
    fs.mkdirSync(join(externalRoot, 'logs'), { recursive: true });
    writeLocalAgentConfig(root, 'grokbot', {
      system: {
        name: 'home23',
        version: '1.0.0',
        workspace: 'workspace',
        instanceRoot: externalRoot,
      },
    });

    const resolved = resolveAgentInstancePaths(root, 'grokbot', { requireConfig: true });
    assert.equal(resolved.storageMode, 'external');
    assert.equal(resolved.instanceRoot, externalRoot);
    assert.equal(resolved.configPath, join(root, 'instances', 'grokbot', 'config.yaml'));
    assert.equal(resolved.brainDir, join(externalRoot, 'brain'));
    assert.equal(resolved.workspaceDir, join(externalRoot, 'workspace'));
    assert.equal(resolved.conversationsDir, join(externalRoot, 'conversations'));
    assert.equal(resolved.logsDir, join(externalRoot, 'logs'));
    assert.doesNotThrow(() => assertAgentInstanceStorageReady(resolved));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('storage preflight fails closed when a configured external instance root is unavailable', () => {
  const root = makeInstall();
  const missingRoot = join(os.tmpdir(), `home23-missing-${process.pid}-${Date.now()}`, 'grokbot');
  try {
    writeLocalAgentConfig(root, 'grokbot', {
      system: {
        name: 'home23',
        version: '1.0.0',
        workspace: 'workspace',
        instanceRoot: missingRoot,
      },
    });

    const resolved = resolveAgentInstancePaths(root, 'grokbot', { requireConfig: true });
    assert.throws(
      () => assertAgentInstanceStorageReady(resolved),
      (error) => error?.code === 'instance_storage_unavailable',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('storage preflight preserves symlink rejection for configured external instance roots', () => {
  const root = makeInstall();
  const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-agent-real-root-'));
  const linkedParent = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-agent-linked-parent-'));
  const linkedRoot = join(linkedParent, 'grokbot-link');
  try {
    fs.mkdirSync(join(realRoot, 'brain'), { recursive: true });
    fs.mkdirSync(join(realRoot, 'workspace'), { recursive: true });
    fs.symlinkSync(realRoot, linkedRoot, 'dir');
    writeLocalAgentConfig(root, 'grokbot', {
      system: {
        name: 'home23',
        version: '1.0.0',
        workspace: 'workspace',
        instanceRoot: linkedRoot,
      },
    });

    const resolved = resolveAgentInstancePaths(root, 'grokbot', { requireConfig: true });
    assert.throws(
      () => assertAgentInstanceStorageReady(resolved),
      (error) => error?.code === 'instance_storage_not_canonical',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(realRoot, { recursive: true, force: true });
    fs.rmSync(linkedParent, { recursive: true, force: true });
  }
});
