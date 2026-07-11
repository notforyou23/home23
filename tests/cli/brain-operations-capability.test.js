import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

import {
  ensureBrainOperationsCapabilityKey,
  inspectBrainOperationsCapabilityState,
} from '../../cli/lib/brain-operations-capability.js';
import {
  buildScopedPm2RefreshArgs,
  prepareBrainOperationsCapability,
  runBrainOperationsCommand,
} from '../../cli/lib/brain-operations-command.js';
import { generateEcosystem } from '../../cli/lib/generate-ecosystem.js';
import { startEcosystemProcesses } from '../../cli/lib/shared-service-start.js';
import { ensureSystemHealth } from '../../cli/lib/system-health.js';
import { seedCosmo23Config } from '../../cli/lib/cosmo23-config.js';
import * as capabilitySecretModule from '../../cli/lib/brain-operations-capability.js';

const require = createRequire(import.meta.url);
const CAPABILITY_ENV = 'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY';
const MCP_AVAILABLE_ENV = 'HOME23_MCP_AVAILABLE';
const TEST_NODE_MODULES = dirname(dirname(require.resolve('js-yaml/package.json')));

function makeInstall({ key, mode = 0o600 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'home23-brain-operations-'));
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, 'instances', 'jerry'), { recursive: true });
  mkdirSync(join(root, 'instances', 'forrest'), { recursive: true });
  symlinkSync(TEST_NODE_MODULES, join(root, 'node_modules'), 'dir');
  writeFileSync(join(root, 'config', 'home.yaml'), yaml.dump({
    home: { primaryAgent: 'jerry' },
    providers: { 'ollama-local': { baseUrl: 'http://127.0.0.1:11434' } },
  }), 'utf8');
  const secrets = {
    providers: {},
    cosmo23: { encryptionKey: 'not-a-real-secret' },
  };
  if (key !== undefined) secrets.brainOperations = { capabilityKey: key };
  writeFileSync(join(root, 'config', 'secrets.yaml'), yaml.dump(secrets), { mode });
  chmodSync(join(root, 'config', 'secrets.yaml'), mode);
  for (const [name, engine, dashboard] of [
    ['jerry', 5001, 5002],
    ['forrest', 5011, 5012],
  ]) {
    writeFileSync(join(root, 'instances', name, 'config.yaml'), yaml.dump({
      agent: { displayName: name },
      ports: { engine, dashboard, mcp: engine + 2 },
    }), 'utf8');
  }
  generateEcosystem(root);
  return root;
}

function targetNames() {
  return ['home23-jerry-dash', 'home23-forrest-dash', 'home23-cosmo23'];
}

function processesWithoutCapability() {
  return [
    ...targetNames().map((name) => ({ name, status: 'online', env: {} })),
    { name: 'home23-jerry', status: 'online', env: {} },
    { name: 'home23-jerry-harness', status: 'online', env: {} },
    { name: 'unrelated-service', status: 'online', env: {} },
  ];
}

function processesWithCapability(key) {
  return targetNames().map((name) => ({
    name,
    status: 'online',
    env: { [CAPABILITY_ENV]: key },
  }));
}

function rawPm2Processes(key) {
  return targetNames().map((name) => ({
    name,
    pm2_env: {
      status: 'online',
      [CAPABILITY_ENV]: key,
      env: { [CAPABILITY_ENV]: key },
    },
  }));
}

function readSecrets(root) {
  return yaml.load(readFileSync(join(root, 'config', 'secrets.yaml'), 'utf8'));
}

function modeOf(filePath) {
  return (statSync(filePath).mode & 0o777).toString(8).padStart(4, '0');
}

function treeSnapshot(root) {
  const rows = [];
  function visit(entry) {
    const st = lstatSync(entry);
    const rel = relative(root, entry) || '.';
    const row = {
      path: rel,
      type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'symlink' : 'file',
      mode: st.mode & 0o777,
      size: st.size,
      ino: st.ino,
      mtimeMs: st.mtimeMs,
      ctimeMs: st.ctimeMs,
    };
    if (st.isFile()) row.bytes = readFileSync(entry).toString('base64');
    rows.push(row);
    if (st.isDirectory()) {
      for (const name of readdirSync(entry).sort()) visit(join(entry, name));
    }
  }
  visit(root);
  return rows;
}

function loadEcosystem(root) {
  const ecosystemPath = join(root, 'ecosystem.config.cjs');
  delete require.cache[ecosystemPath];
  return require(ecosystemPath);
}

function assertReceiptHasNoSecret(receipt, secret) {
  assert.equal(JSON.stringify(receipt).includes(secret), false);
}

test('generated ecosystem isolates one shared capability to dashboards and COSMO only', () => {
  const key = 'a'.repeat(64);
  const root = makeInstall({ key });
  try {
    const ecosystem = loadEcosystem(root);
    const apps = new Map(ecosystem.apps.map((app) => [app.name, app]));
    for (const name of targetNames()) assert.equal(apps.get(name)?.env?.[CAPABILITY_ENV], key, name);
    for (const app of ecosystem.apps) {
      assert.ok(app.filter_env?.includes(CAPABILITY_ENV), `${app.name} filters inherited capability`);
      if (!targetNames().includes(app.name)) {
        assert.notEqual(app.env?.[CAPABILITY_ENV], key, app.name);
      }
    }
    const source = readFileSync(join(root, 'ecosystem.config.cjs'), 'utf8');
    assert.doesNotMatch(source, /commonEnv\s*=\s*\{[^}]*HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY/s);
    for (const name of ['home23-jerry', 'home23-forrest', 'home23-jerry-harness', 'home23-forrest-harness']) {
      assert.ok(apps.get(name)?.filter_env?.includes(CAPABILITY_ENV), `${name} blocks inherited capability`);
    }
    assert.equal(apps.get('home23-jerry')?.kill_timeout, 210_000);
    assert.equal(apps.get('home23-forrest')?.kill_timeout, 210_000);
    assert.equal(apps.get('home23-jerry-dash')?.kill_timeout, 210_000);
    assert.equal(apps.get('home23-forrest-dash')?.kill_timeout, 210_000);
    assert.match(source, /const DASHBOARD_KILL_TIMEOUT_MS = 210000;/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated ecosystem starts one loopback MCP service per enabled agent', () => {
  const root = makeInstall({ key: 'b'.repeat(64) });
  try {
    const ecosystem = loadEcosystem(root);
    const agentApps = ecosystem.apps.filter((app) => /^home23-(jerry|forrest)(?:$|-dash$|-harness$|-mcp$)/.test(app.name));
    const mcpApps = ecosystem.apps.filter((app) => /^home23-(jerry|forrest)-mcp$/.test(app.name));
    assert.equal(agentApps.length, 8);
    assert.equal(mcpApps.length, 2);
    for (const app of agentApps) {
      assert.ok(app.filter_env?.includes(MCP_AVAILABLE_ENV), `${app.name} scrubs inherited MCP availability`);
    }
    for (const app of mcpApps) {
      assert.equal(app.script, 'mcp/http-server.js');
      assert.equal(app.cwd.endsWith('/engine') || app.cwd === 'engine', true);
      assert.equal(app.env.MCP_HTTP_HOST, '127.0.0.1');
      assert.equal(app.env[MCP_AVAILABLE_ENV], 'true');
      assert.equal(realpathSync(app.env.HOME23_ROOT), realpathSync(root));
      assert.match(app.env.COSMO_RUNTIME_DIR, /instances\/(?:jerry|forrest)\/brain$/);
    }
    for (const app of ecosystem.apps.filter((app) => /-dash$/.test(app.name) && /^home23-(jerry|forrest)-/.test(app.name))) {
      assert.equal(app.env?.[MCP_AVAILABLE_ENV], 'true', `${app.name} probes local MCP`);
    }

    const source = readFileSync(join(root, 'ecosystem.config.cjs'), 'utf8');
    assert.match(source, /name: 'home23-jerry-mcp'/);
    assert.match(source, /MCP_HTTP_HOST: '127\.0\.0\.1'/);
    assert.match(source, /PM2_INHERITANCE_BLOCKLIST[^\n]*HOME23_MCP_AVAILABLE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('generated ecosystem omits agent-scoped MCP when an agent disables it', () => {
  const root = makeInstall({ key: 'c'.repeat(64) });
  try {
    const forrestConfigPath = join(root, 'instances', 'forrest', 'config.yaml');
    const forrestConfig = yaml.load(readFileSync(forrestConfigPath, 'utf8'));
    forrestConfig.mcp = { enabled: false };
    writeFileSync(forrestConfigPath, yaml.dump(forrestConfig), 'utf8');
    generateEcosystem(root);

    const ecosystem = loadEcosystem(root);
    assert.ok(ecosystem.apps.some((app) => app.name === 'home23-jerry-mcp'));
    assert.equal(ecosystem.apps.some((app) => app.name === 'home23-forrest-mcp'), false);
    assert.equal(ecosystem.apps.find((app) => app.name === 'home23-jerry-dash')?.env?.[MCP_AVAILABLE_ENV], 'true');
    assert.equal(ecosystem.apps.find((app) => app.name === 'home23-forrest-dash')?.env?.[MCP_AVAILABLE_ENV], 'false');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('scoped PM2 starts scrub inherited capability from command and child environments', () => {
  let invocation;
  startEcosystemProcesses({
    home23Root: '/tmp/home23',
    names: ['home23-jerry'],
    env: { PATH: process.env.PATH, [CAPABILITY_ENV]: 'a'.repeat(64) },
    execFile: (command, args, options) => { invocation = { command, args, options }; },
  });
  assert.equal(invocation.options.env[CAPABILITY_ENV], undefined);
  const unsetIndex = invocation.args.indexOf(CAPABILITY_ENV);
  assert.ok(unsetIndex > 0);
  assert.equal(invocation.args[unsetIndex - 1], '-u');
});

test('prepare dry-run is byte/type/mode/mtime read-only and normal prepare is idempotent', async () => {
  const root = makeInstall();
  const secretsPath = join(root, 'config', 'secrets.yaml');
  const ecosystemPath = join(root, 'ecosystem.config.cjs');
  const agentsPath = join(root, 'config', 'agents.json');
  const pm2Calls = [];
  try {
    const before = treeSnapshot(root);
    const secretsBefore = readFileSync(secretsPath);
    const ecosystemBefore = readFileSync(ecosystemPath);
    const agentsBefore = readFileSync(agentsPath);
    const dryRun = await runBrainOperationsCommand(root, ['prepare', '--dry-run'], {
      listProcesses: async () => processesWithoutCapability(),
      runPm2: async (args) => pm2Calls.push(args),
    });
    assert.deepEqual(dryRun, {
      dryRun: true,
      filesystemChanged: false,
      filesystemWouldChange: true,
      keyCreated: false,
      keyWouldBeCreated: true,
      permissionsRepaired: false,
      permissionsWouldBeRepaired: false,
      secretsModeBefore: '0600',
      secretsModeAfter: '0600',
      ecosystemRegenerated: false,
      ecosystemWouldChange: true,
      configuredProcessNames: targetNames(),
      changedProcessNames: targetNames(),
      restartRequired: true,
      liveEnvVerified: true,
    });
    assert.deepEqual(treeSnapshot(root), before);
    assert.deepEqual(pm2Calls, []);
    assert.equal(existsSync(join(root, 'config', '.brain-operations-capability.lock')), false);

    const prepared = await runBrainOperationsCommand(root, ['prepare'], {
      listProcesses: async () => processesWithoutCapability(),
      runPm2: async (args) => pm2Calls.push(args),
    });
    const key = readSecrets(root).brainOperations.capabilityKey;
    assert.match(key, /^[a-f0-9]{64}$/);
    assert.equal(prepared.keyCreated, true);
    assert.equal(prepared.ecosystemRegenerated, true);
    assert.equal(prepared.filesystemChanged, true);
    assert.equal(prepared.filesystemWouldChange, true);
    assert.deepEqual(prepared.changedProcessNames, targetNames());
    assert.equal(prepared.restartRequired, true);
    assert.equal(prepared.liveEnvVerified, true);
    assertReceiptHasNoSecret(prepared, key);
    assert.deepEqual(pm2Calls, []);
    assert.notDeepEqual(readFileSync(secretsPath), secretsBefore);
    assert.notDeepEqual(readFileSync(ecosystemPath), ecosystemBefore);
    assert.deepEqual(readFileSync(agentsPath), agentsBefore);
    assert.equal(modeOf(secretsPath), '0600');

    const stableSecrets = readFileSync(secretsPath);
    const stableEcosystem = readFileSync(ecosystemPath);
    const stableSecretsStat = statSync(secretsPath);
    const stableEcosystemStat = statSync(ecosystemPath);
    const repeated = await runBrainOperationsCommand(root, ['prepare'], {
      listProcesses: async () => processesWithoutCapability(),
      runPm2: async (args) => pm2Calls.push(args),
    });
    assert.equal(repeated.keyCreated, false);
    assert.equal(repeated.ecosystemRegenerated, false);
    assert.equal(repeated.filesystemChanged, false);
    assert.deepEqual(repeated.changedProcessNames, targetNames());
    assert.equal(repeated.restartRequired, true);
    assert.deepEqual(readFileSync(secretsPath), stableSecrets);
    assert.deepEqual(readFileSync(ecosystemPath), stableEcosystem);
    assert.equal(statSync(secretsPath).mtimeMs, stableSecretsStat.mtimeMs);
    assert.equal(statSync(ecosystemPath).mtimeMs, stableEcosystemStat.mtimeMs);

    const settled = await runBrainOperationsCommand(root, ['prepare'], {
      listProcesses: async () => rawPm2Processes(key),
      runPm2: async (args) => pm2Calls.push(args),
    });
    assert.deepEqual(settled.changedProcessNames, []);
    assert.equal(settled.restartRequired, false);
    assert.equal(settled.filesystemChanged, false);
    assert.deepEqual(pm2Calls, []);

    assert.deepEqual(buildScopedPm2RefreshArgs(prepared), [
      'start',
      'ecosystem.config.cjs',
      '--only',
      'home23-jerry-dash,home23-forrest-dash,home23-cosmo23',
      '--update-env',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing 0644 key is reported in dry-run, repaired once, and never rotated', async () => {
  const key = 'b'.repeat(64);
  const root = makeInstall({ key, mode: 0o644 });
  const secretsPath = join(root, 'config', 'secrets.yaml');
  const ecosystemPath = join(root, 'ecosystem.config.cjs');
  const processRows = processesWithCapability(key);
  try {
    const bytesBefore = readFileSync(secretsPath);
    const ecosystemBefore = readFileSync(ecosystemPath);
    const dryRun = await prepareBrainOperationsCapability(root, {
      dryRun: true,
      listProcesses: async () => processRows,
    });
    assert.equal(dryRun.permissionsWouldBeRepaired, true);
    assert.equal(dryRun.permissionsRepaired, false);
    assert.equal(dryRun.secretsModeBefore, '0644');
    assert.equal(dryRun.secretsModeAfter, '0644');
    assert.equal(dryRun.restartRequired, false);
    assert.deepEqual(readFileSync(secretsPath), bytesBefore);
    assert.deepEqual(readFileSync(ecosystemPath), ecosystemBefore);
    assert.equal(modeOf(secretsPath), '0644');

    const prepared = await prepareBrainOperationsCapability(root, {
      listProcesses: async () => processRows,
    });
    assert.equal(prepared.keyCreated, false);
    assert.equal(prepared.permissionsRepaired, true);
    assert.equal(prepared.permissionsWouldBeRepaired, false);
    assert.equal(prepared.secretsModeBefore, '0644');
    assert.equal(prepared.secretsModeAfter, '0600');
    assert.equal(prepared.ecosystemRegenerated, false);
    assert.equal(prepared.restartRequired, false);
    assert.equal(readSecrets(root).brainOperations.capabilityKey, key);

    const stableSecrets = readFileSync(secretsPath);
    const stableEcosystem = readFileSync(ecosystemPath);
    const stableSecretStat = statSync(secretsPath);
    const stableEcosystemStat = statSync(ecosystemPath);
    const repeated = await prepareBrainOperationsCapability(root, {
      listProcesses: async () => processRows,
    });
    assert.equal(repeated.permissionsRepaired, false);
    assert.equal(repeated.permissionsWouldBeRepaired, false);
    assert.equal(repeated.filesystemChanged, false);
    assert.deepEqual(readFileSync(secretsPath), stableSecrets);
    assert.deepEqual(readFileSync(ecosystemPath), stableEcosystem);
    assert.equal(statSync(secretsPath).mtimeMs, stableSecretStat.mtimeMs);
    assert.equal(statSync(ecosystemPath).mtimeMs, stableEcosystemStat.mtimeMs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('secret creation and permission repair serialize 32 concurrent callers', async () => {
  const root = makeInstall();
  try {
    const created = await Promise.all(Array.from({ length: 32 }, () =>
      ensureBrainOperationsCapabilityKey(root)));
    const keys = new Set(created.map((result) => result.capabilityKey));
    assert.equal(keys.size, 1);
    assert.equal(created.filter((result) => result.keyCreated).length, 1);
    assert.equal(readSecrets(root).brainOperations.capabilityKey, created[0].capabilityKey);
    assert.equal(modeOf(join(root, 'config', 'secrets.yaml')), '0600');
    assert.equal(readdirSync(join(root, 'config')).some((name) => /brain-operations-capability|\.tmp$/.test(name)), false);

    chmodSync(join(root, 'config', 'secrets.yaml'), 0o644);
    const repaired = await Promise.all(Array.from({ length: 32 }, () =>
      ensureBrainOperationsCapabilityKey(root)));
    assert.equal(new Set(repaired.map((result) => result.capabilityKey)).size, 1);
    assert.equal(repaired[0].capabilityKey, created[0].capabilityKey);
    assert.equal(repaired.filter((result) => result.permissionsRepaired).length, 1);
    assert.equal(modeOf(join(root, 'config', 'secrets.yaml')), '0600');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('atomic creation and metadata-repair faults fail typed without corrupting prior bytes', async () => {
  const root = makeInstall();
  const secretsPath = join(root, 'config', 'secrets.yaml');
  try {
    const before = readFileSync(secretsPath);
    await assert.rejects(
      ensureBrainOperationsCapabilityKey(root, {
        beforeRename: async () => { throw new Error('injected rename fault'); },
      }),
      (error) => error?.code === 'capability_preparation_failed',
    );
    assert.deepEqual(readFileSync(secretsPath), before);
    assert.equal(readdirSync(join(root, 'config')).some((name) => /brain-operations-capability|\.tmp$/.test(name)), false);

    const key = 'c'.repeat(64);
    writeFileSync(secretsPath, yaml.dump({ brainOperations: { capabilityKey: key } }), { mode: 0o644 });
    chmodSync(secretsPath, 0o644);
    await assert.rejects(
      ensureBrainOperationsCapabilityKey(root, {
        beforePermissionRepair: async () => { throw new Error('injected chmod fault'); },
      }),
      (error) => error?.code === 'capability_preparation_failed',
    );
    assert.equal(modeOf(secretsPath), '0644');
    assert.equal(readSecrets(root).brainOperations.capabilityKey, key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('secret creation detects a pre-rename byte change and retries from the latest snapshot', async () => {
  const root = makeInstall();
  const secretsPath = join(root, 'config', 'secrets.yaml');
  let injected = false;
  try {
    const prepared = await ensureBrainOperationsCapabilityKey(root, {
      beforeRename: async () => {
        if (injected) return;
        injected = true;
        writeFileSync(secretsPath, yaml.dump({
          providers: { concurrent: { apiKey: 'preserve-me' } },
          cosmo23: { encryptionKey: 'still-here' },
        }), { mode: 0o600 });
      },
    });
    const secrets = readSecrets(root);
    assert.equal(secrets.providers.concurrent.apiKey, 'preserve-me');
    assert.equal(secrets.brainOperations.capabilityKey, prepared.capabilityKey);
    assert.equal(modeOf(secretsPath), '0600');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('normal prepare revalidates the key after PM2 inspection before claiming readiness', async () => {
  const key = '9'.repeat(64);
  const root = makeInstall({ key });
  const secretsPath = join(root, 'config', 'secrets.yaml');
  try {
    await assert.rejects(
      prepareBrainOperationsCapability(root, {
        listProcesses: async () => {
          const secrets = readSecrets(root);
          secrets.brainOperations.capabilityKey = '8'.repeat(64);
          writeFileSync(secretsPath, yaml.dump(secrets), { mode: 0o600 });
          return processesWithCapability(key);
        },
      }),
      (error) => error?.code === 'preparation_state_changed',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed persisted capability values and multiple YAML documents fail closed', async () => {
  const invalid = [
    'null',
    'true',
    '7',
    "''",
    "'   '",
    "'short'",
    `'${'A'.repeat(64)}'`,
    '[]',
    '{}',
  ];
  for (const serialized of invalid) {
    const root = makeInstall();
    const secretsPath = join(root, 'config', 'secrets.yaml');
    try {
      writeFileSync(secretsPath, `brainOperations:\n  capabilityKey: ${serialized}\n`, { mode: 0o600 });
      const ecosystemBefore = readFileSync(join(root, 'ecosystem.config.cjs'));
      for (const dryRun of [true, false]) {
        await assert.rejects(
          prepareBrainOperationsCapability(root, {
            dryRun,
            listProcesses: async () => processesWithoutCapability(),
          }),
          (error) => error?.code === 'capability_secret_invalid',
          serialized,
        );
        assert.deepEqual(readFileSync(join(root, 'ecosystem.config.cjs')), ecosystemBefore);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const root = makeInstall();
  try {
    writeFileSync(join(root, 'config', 'secrets.yaml'), `---\nbrainOperations: {}\n---\nbrainOperations: {}\n`);
    await assert.rejects(
      inspectBrainOperationsCapabilityState(root),
      (error) => error?.code === 'capability_secret_invalid',
    );
    await assert.rejects(
      ensureBrainOperationsCapabilityKey(root),
      (error) => error?.code === 'capability_secret_invalid',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty, null, false, scalar, array, and multi-document secrets fail closed without mutation', async () => {
  const documents = [
    '',
    '   \n',
    'null\n',
    'false\n',
    '0\n',
    'text\n',
    '[]\n',
    '---\n{}\n---\n{}\n',
  ];
  for (const document of documents) {
    const root = makeInstall();
    const secretsPath = join(root, 'config', 'secrets.yaml');
    const ecosystemPath = join(root, 'ecosystem.config.cjs');
    try {
      writeFileSync(secretsPath, document, { mode: 0o640 });
      chmodSync(secretsPath, 0o640);
      const secretsBefore = readFileSync(secretsPath);
      const ecosystemBefore = readFileSync(ecosystemPath);
      for (const dryRun of [true, false]) {
        await assert.rejects(
          prepareBrainOperationsCapability(root, {
            dryRun,
            listProcesses: async () => processesWithoutCapability(),
          }),
          (error) => error?.code === 'capability_secret_invalid',
          JSON.stringify(document),
        );
        assert.deepEqual(readFileSync(secretsPath), secretsBefore);
        assert.deepEqual(readFileSync(ecosystemPath), ecosystemBefore);
        assert.equal(modeOf(secretsPath), '0640');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('dry-run detects concurrent secret/ecosystem input change and never emits a mixed receipt', async () => {
  const root = makeInstall();
  const secretsPath = join(root, 'config', 'secrets.yaml');
  try {
    await assert.rejects(
      prepareBrainOperationsCapability(root, {
        dryRun: true,
        listProcesses: async () => processesWithoutCapability(),
        afterInspection: async () => {
          writeFileSync(secretsPath, `${readFileSync(secretsPath, 'utf8')}# concurrent\n`);
        },
      }),
      (error) => error?.code === 'preparation_state_changed',
    );
    assert.equal(existsSync(join(root, 'config', '.brain-operations-capability.lock')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run detects renderer input drift in home config, instance membership, or agent config', async () => {
  for (const mutate of [
    (root) => writeFileSync(join(root, 'config', 'home.yaml'), 'home:\n  primaryAgent: forrest\n'),
    (root) => mkdirSync(join(root, 'instances', 'new-agent')),
    (root) => writeFileSync(
      join(root, 'instances', 'forrest', 'config.yaml'),
      yaml.dump({ agent: { displayName: 'changed' }, ports: { engine: 9001, dashboard: 9002 } }),
    ),
  ]) {
    const root = makeInstall();
    try {
      await assert.rejects(
        prepareBrainOperationsCapability(root, {
          dryRun: true,
          listProcesses: async () => processesWithoutCapability(),
          afterInspection: async () => mutate(root),
        }),
        (error) => error?.code === 'preparation_state_changed',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('PM2 inspection failure is fail-closed and refresh guard only permits exact target names', async () => {
  const key = 'd'.repeat(64);
  const root = makeInstall({ key });
  try {
    const receipt = await prepareBrainOperationsCapability(root, {
      listProcesses: async () => { throw new Error('pm2 unavailable'); },
    });
    assert.equal(receipt.liveEnvVerified, false);
    assert.equal(receipt.restartRequired, true);
    assert.deepEqual(receipt.changedProcessNames, targetNames());
    assertReceiptHasNoSecret(receipt, key);

    const base = {
      restartRequired: true,
      liveEnvVerified: true,
      configuredProcessNames: targetNames(),
      changedProcessNames: targetNames(),
    };
    for (const bad of [
      { ...base, restartRequired: false },
      { ...base, liveEnvVerified: false },
      { ...base, changedProcessNames: [] },
      { ...base, changedProcessNames: ['all'] },
      { ...base, changedProcessNames: ['home23-*'] },
      { ...base, changedProcessNames: ['home23-jerry'] },
      { ...base, changedProcessNames: ['home23-jerry-harness'] },
      { ...base, changedProcessNames: ['unrelated-service'] },
      { ...base, changedProcessNames: ['home23-attacker-dash'] },
      { ...base, changedProcessNames: ['home23-cosmo23', 'home23-cosmo23'] },
      { ...base, changedProcessNames: ['home23-cosmo23', 'home23-jerry-dash'] },
    ]) {
      assert.throws(() => buildScopedPm2RefreshArgs(bad), /refresh_|live_env_|changed_processes_/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('PM2 normalization handles live shapes and fails closed on duplicate or disagreeing evidence', async () => {
  const key = 'f'.repeat(64);
  const root = makeInstall({ key });
  try {
    const directOnly = targetNames().map((name) => ({
      name,
      pm2_env: { status: 'online', [CAPABILITY_ENV]: key },
    }));
    const nestedOnly = targetNames().map((name) => ({
      name,
      pm2_env: { status: 'online', env: { [CAPABILITY_ENV]: key } },
    }));
    for (const rows of [directOnly, nestedOnly]) {
      const receipt = await prepareBrainOperationsCapability(root, {
        listProcesses: async () => rows,
      });
      assert.equal(receipt.liveEnvVerified, true);
      assert.equal(receipt.restartRequired, false);
      assert.deepEqual(receipt.changedProcessNames, []);
    }

    const absentAndOffline = [
      { name: 'home23-jerry-dash', pm2_env: { status: 'stopped', [CAPABILITY_ENV]: key } },
    ];
    const absentReceipt = await prepareBrainOperationsCapability(root, {
      listProcesses: async () => absentAndOffline,
    });
    assert.equal(absentReceipt.liveEnvVerified, true);
    assert.deepEqual(absentReceipt.changedProcessNames, []);
    assert.equal(absentReceipt.restartRequired, false);

    const duplicateRows = [
      ...rawPm2Processes(key),
      rawPm2Processes(key)[0],
    ];
    const duplicateReceipt = await prepareBrainOperationsCapability(root, {
      listProcesses: async () => duplicateRows,
    });
    assert.equal(duplicateReceipt.liveEnvVerified, false);
    assert.deepEqual(duplicateReceipt.changedProcessNames, targetNames());

    const disagreement = rawPm2Processes(key);
    disagreement[0].pm2_env.env[CAPABILITY_ENV] = '0'.repeat(64);
    const disagreementReceipt = await prepareBrainOperationsCapability(root, {
      listProcesses: async () => disagreement,
    });
    assert.equal(disagreementReceipt.liveEnvVerified, false);
    assert.deepEqual(disagreementReceipt.changedProcessNames, targetNames());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dry-run without a persisted key marks every online target stale even if env equals the sentinel', async () => {
  const root = makeInstall();
  try {
    const publicSentinel = '0'.repeat(64);
    const receipt = await prepareBrainOperationsCapability(root, {
      dryRun: true,
      listProcesses: async () => processesWithCapability(publicSentinel),
    });
    assert.equal(receipt.keyWouldBeCreated, true);
    assert.equal(receipt.liveEnvVerified, true);
    assert.deepEqual(receipt.changedProcessNames, targetNames());
    assert.equal(receipt.restartRequired, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every PM2 launcher and watchdog scrub list blocks inherited brain capability', () => {
  for (const file of [
    'engine/src/dashboard/home23-settings-api.js',
    'engine/src/dashboard/server.js',
    'scripts/home23-pm2-watchdog.cjs',
    'scripts/home23-pm2-watchdog-daemon.cjs',
  ]) {
    const source = readFileSync(join(process.cwd(), file), 'utf8');
    const blocklist = source.match(/const PM2_ENV_BLOCKLIST = \[([\s\S]*?)\n\];/)?.[1] || '';
    assert.match(blocklist, /HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY/, file);
  }
  const startSource = readFileSync(join(process.cwd(), 'cli', 'lib', 'pm2-commands.js'), 'utf8');
  assert.match(startSource, /coordinateSharedServiceStartup\(\{ home23Root \}\)/);
  assert.doesNotMatch(startSource, /restartOnline\s*:\s*true/);
});

test('crash-left capability lock and atomic temp files remain ignored', () => {
  for (const candidate of [
    'config/.brain-operations-capability.lock',
    'config/secrets.yaml.1234.00000000-0000-4000-8000-000000000000.tmp',
    'ecosystem.config.cjs.1234.00000000-0000-4000-8000-000000000000.tmp',
  ]) {
    assert.doesNotThrow(() => execFileSync('git', ['check-ignore', '-q', candidate], {
      cwd: process.cwd(),
      stdio: 'pipe',
    }), candidate);
  }
});

test('command rejects unknown flags, never calls a PM2 mutator, and the routed CLI/help expose prepare', async () => {
  const root = makeInstall();
  const pm2Calls = [];
  try {
    await assert.rejects(
      runBrainOperationsCommand(root, ['prepare', '--unknown'], {
        listProcesses: async () => processesWithoutCapability(),
        runPm2: async (args) => pm2Calls.push(args),
      }),
      /brain_operations_usage/,
    );
    await assert.rejects(runBrainOperationsCommand(root, ['other']), /brain_operations_usage/);
    assert.deepEqual(pm2Calls, []);
    const cli = readFileSync(join(process.cwd(), 'cli', 'home23.js'), 'utf8');
    assert.match(cli, /brain-operations prepare \[--dry-run\]/);
    assert.match(cli, /runBrainOperationsCommand/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init, start, update, COSMO seed, and system health propagate preparation failures', async () => {
  const root = makeInstall();
  const secretsPath = join(root, 'config', 'secrets.yaml');
  try {
    writeFileSync(secretsPath, 'null\n', { mode: 0o640 });
    chmodSync(secretsPath, 0o640);
    const before = readFileSync(secretsPath);
    await assert.rejects(seedCosmo23Config(root), /capability_secret_invalid/);
    await assert.rejects(ensureSystemHealth(root), /capability_secret_invalid/);
    assert.deepEqual(readFileSync(secretsPath), before);
    assert.equal(modeOf(secretsPath), '0640');

    const sources = Object.fromEntries([
      'init.js',
      'pm2-commands.js',
      'update.js',
    ].map((name) => [name, readFileSync(join(process.cwd(), 'cli', 'lib', name), 'utf8')]));
    assert.match(sources['init.js'], /await ensureBrainOperationsCapabilityKey\(home23Root\)/);
    assert.match(sources['pm2-commands.js'], /await ensureSystemHealth\(home23Root\)/);
    assert.match(sources['update.js'], /await ensureBrainOperationsCapabilityKey\(home23Root\)/);
    assert.match(sources['update.js'], /await ensureSystemHealth\(home23Root\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('system health propagates ecosystem render failures instead of claiming healthy', async () => {
  const root = makeInstall({ key: '7'.repeat(64) });
  try {
    mkdirSync(join(root, 'cosmo23', 'prisma'), { recursive: true });
    writeFileSync(join(root, 'cosmo23', 'prisma', 'dev.db'), 'fixture');
    writeFileSync(join(root, 'instances', 'jerry', 'config.yaml'), 'ports: [unterminated\n');
    await assert.rejects(
      ensureSystemHealth(root),
      /unexpected end of the stream|bad indentation|missed comma|flow sequence/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Task 2 secret writers share one lock and preserve capability plus concurrent fields', async () => {
  assert.equal(typeof capabilitySecretModule.updateHome23Secrets, 'function');
  const root = makeInstall();
  try {
    const initialSecrets = readSecrets(root);
    delete initialSecrets.cosmo23;
    writeFileSync(join(root, 'config', 'secrets.yaml'), yaml.dump(initialSecrets), { mode: 0o600 });
    await Promise.all([
      capabilitySecretModule.updateHome23Secrets(root, (secrets) => {
        if (!secrets.providers) secrets.providers = {};
        secrets.providers.race = { apiKey: 'preserve-race-field' };
        return { changed: true, value: 'provider-added' };
      }),
      ensureBrainOperationsCapabilityKey(root),
      seedCosmo23Config(root),
    ]);
    const secrets = readSecrets(root);
    assert.match(secrets.brainOperations.capabilityKey, /^[a-f0-9]{64}$/);
    assert.equal(secrets.providers.race.apiKey, 'preserve-race-field');
    assert.match(secrets.cosmo23.encryptionKey, /^[a-f0-9]{64}$/);
    assert.equal(modeOf(join(root, 'config', 'secrets.yaml')), '0600');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the tracked secrets example omits a generated capability and no tracked source contains a generated key', () => {
  const example = yaml.load(readFileSync(join(process.cwd(), 'config', 'secrets.yaml.example'), 'utf8'));
  assert.equal(example.brainOperations?.capabilityKey, undefined);
  const generatedLooking = /brainOperations:\s*\n\s*capabilityKey:\s*[a-f0-9]{64}/;
  for (const file of [
    'config/secrets.yaml.example',
    'cli/lib/brain-operations-capability.js',
    'cli/lib/brain-operations-command.js',
    'shared/brain-operations/capability.cjs',
  ]) {
    assert.doesNotMatch(readFileSync(join(process.cwd(), file), 'utf8'), generatedLooking, file);
  }
});
