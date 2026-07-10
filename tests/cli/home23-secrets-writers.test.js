import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import yaml from 'js-yaml';

import { withBrainOperationsCapabilityLock } from '../../cli/lib/brain-operations-capability.js';

const require = createRequire(import.meta.url);
const repoRoot = process.cwd();
const capabilityKey = '6'.repeat(64);

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-secret-writers-'));
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config', 'secrets.yaml'), '# operator comment must not create a plaintext backup\n' + yaml.dump({
    providers: {},
    agents: {},
    dashboard: {},
    brainOperations: { capabilityKey },
  }), { mode: 0o600 });
  return root;
}

function childFor(source, root) {
  const settingsPath = path.join(repoRoot, 'engine', 'src', 'dashboard', 'home23-settings-api.js');
  const secretsHelperPath = path.join(repoRoot, 'engine', 'src', 'dashboard', 'home23-secrets.js');
  const agentPath = path.join(repoRoot, 'cli', 'lib', 'agent-create.js');
  const tilesPath = path.join(repoRoot, 'engine', 'src', 'dashboard', 'home23-tiles.js');
  const scripts = {
    settings: `
      const { updateSettingsSecrets } = require(${JSON.stringify(settingsPath)});
      await updateSettingsSecrets(${JSON.stringify(root)}, (secrets) => {
        secrets.settingsRace = 'preserved';
        return { changed: true };
      });
    `,
    oauth: `
      const { updateDashboardOAuthTokenSecrets } = require(${JSON.stringify(secretsHelperPath)});
      await updateDashboardOAuthTokenSecrets(${JSON.stringify(root)}, 'anthropic', 'oauth-race-token');
    `,
    agent: `
      const { addBotTokenToSecrets } = await import(${JSON.stringify(agentPath)});
      await addBotTokenToSecrets(${JSON.stringify(root)}, 'race-agent', 'telegram-race-token');
    `,
    tiles: `
      const { updateTileConnectionSecrets } = require(${JSON.stringify(tilesPath)});
      await updateTileConnectionSecrets(${JSON.stringify(root)}, [{
        id: 'race-tile', name: 'Race Tile', type: 'generic-http',
        config: { baseUrl: 'https://example.test', authType: 'bearer' },
        secrets: { bearerToken: 'tile-race-token' },
      }]);
    `,
  };
  const script = `(async () => { ${scripts[source]} })().catch((error) => { console.error(error); process.exitCode = 1; });`;
  return spawn(process.execPath, ['-e', script], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function exitResult(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('all production Home23 secret writer families expose the shared coordinated path', async () => {
  const settings = require('../../engine/src/dashboard/home23-settings-api.js');
  const secretsHelper = require('../../engine/src/dashboard/home23-secrets.js');
  const tiles = require('../../engine/src/dashboard/home23-tiles.js');
  const agent = await import('../../cli/lib/agent-create.js');
  assert.equal(typeof settings.updateSettingsSecrets, 'function');
  assert.equal(typeof secretsHelper.updateDashboardOAuthTokenSecrets, 'function');
  assert.equal(typeof agent.addBotTokenToSecrets, 'function');
  assert.equal(typeof tiles.updateTileConnectionSecrets, 'function');
});

test('Settings, OAuth poller, agent-create, and tile writers block on the capability lock', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const source of ['settings', 'oauth', 'agent', 'tiles']) {
    let child;
    let resultPromise;
    await withBrainOperationsCapabilityLock(root, async () => {
      child = childFor(source, root);
      resultPromise = exitResult(child);
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(child.exitCode, null, `${source} bypassed the shared lock`);
    });
    const result = await resultPromise;
    assert.equal(result.code, 0, `${source}: ${result.stderr || result.stdout}`);
  }

  const secrets = yaml.load(fs.readFileSync(path.join(root, 'config', 'secrets.yaml'), 'utf8'));
  assert.equal(secrets.brainOperations.capabilityKey, capabilityKey);
  assert.equal(secrets.settingsRace, 'preserved');
  assert.equal(secrets.providers.anthropic.apiKey, 'oauth-race-token');
  assert.equal(secrets.providers.anthropic.oauthManaged, true);
  assert.equal(secrets.agents['race-agent'].telegram.botToken, 'telegram-race-token');
  assert.equal(secrets.dashboard.tileConnections.connections[0].secrets.bearerToken, 'tile-race-token');
  assert.equal(fs.statSync(path.join(root, 'config', 'secrets.yaml')).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(root, 'engine', '.backups')), false);
});

test('same-process async writers serialize without blocking the event loop or losing fields', async (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { updateSettingsSecrets } = require('../../engine/src/dashboard/home23-settings-api.js');
  let active = 0;
  let maxActive = 0;

  await Promise.all(['one', 'two', 'three', 'four'].map((name, index) =>
    updateSettingsSecrets(root, async (secrets) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30 - (index * 3)));
      secrets[`sameProcess${name}`] = index;
      active -= 1;
      return { changed: true };
    })));

  assert.equal(maxActive, 1);
  const secrets = yaml.load(fs.readFileSync(path.join(root, 'config', 'secrets.yaml'), 'utf8'));
  assert.deepEqual(
    ['one', 'two', 'three', 'four'].map((name) => secrets[`sameProcess${name}`]),
    [0, 1, 2, 3],
  );
  assert.equal(secrets.brainOperations.capabilityKey, capabilityKey);
});

test('generic YAML safety refuses config/secrets.yaml without writing a plaintext backup', (t) => {
  const root = makeRoot();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { writeYamlSafely } = require('../../engine/src/dashboard/yaml-write-safety.js');
  const secretsPath = path.join(root, 'config', 'secrets.yaml');
  const before = fs.readFileSync(secretsPath);

  assert.throws(
    () => writeYamlSafely(secretsPath, { overwritten: true }, { yaml, rootDir: root }),
    (error) => error?.code === 'secrets_write_requires_coordination',
  );
  assert.deepEqual(fs.readFileSync(secretsPath), before);
  assert.equal(fs.existsSync(path.join(root, 'engine', '.backups')), false);
  assert.equal(fs.statSync(secretsPath).mode & 0o777, 0o600);
});

test('known production writers no longer perform direct read-modify-write on secrets.yaml', () => {
  const sources = {
    settings: fs.readFileSync(path.join(repoRoot, 'engine/src/dashboard/home23-settings-api.js'), 'utf8'),
    oauth: fs.readFileSync(path.join(repoRoot, 'engine/src/dashboard/server.js'), 'utf8'),
    agent: fs.readFileSync(path.join(repoRoot, 'cli/lib/agent-create.js'), 'utf8'),
    tiles: fs.readFileSync(path.join(repoRoot, 'engine/src/dashboard/home23-tiles.js'), 'utf8'),
    cosmo: fs.readFileSync(path.join(repoRoot, 'cosmo23/server/index.js'), 'utf8'),
  };
  assert.doesNotMatch(sources.settings, /saveYaml\(secretsPath,/);
  assert.doesNotMatch(sources.oauth, /writeFileSync\(secretsPath,/);
  assert.doesNotMatch(sources.agent, /writeFileSync\(secretsPath,/);
  assert.doesNotMatch(sources.tiles, /this\.writeSecrets\(secrets\)/);
  assert.doesNotMatch(sources.cosmo, /writeFile(?:Sync)?\([^\n]*config\/secrets\.yaml/);
  assert.doesNotMatch(
    [sources.settings, sources.oauth, sources.agent, sources.tiles].join('\n'),
    /updateHome23SecretsSync|withHome23SecretsLockSync/,
  );
  assert.equal((sources.settings.match(/await updateSettingsSecrets\(/g) || []).length, 6);
  assert.equal((sources.settings.match(/await updateDashboardOAuthTokenSecrets\(/g) || []).length, 1);
});
