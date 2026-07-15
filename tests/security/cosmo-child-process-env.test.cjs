const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..', '..');
const CAPABILITY_ENV = 'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY';
const AUTHORITY_ENV = 'HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY';

test('COSMO unprivileged child environment strips both privileged Home23 roots after overrides', () => {
  const { unprivilegedChildEnv } = require('../../shared/child-process-env.cjs');
  const base = {
    PATH: '/usr/bin',
    KEEP: 'base',
    [CAPABILITY_ENV]: 'capability-test-value',
    [AUTHORITY_ENV]: 'authority-test-value',
  };
  const env = unprivilegedChildEnv(base, {
    EXTRA: 'override',
    [CAPABILITY_ENV]: 'override-must-not-restore',
    [AUTHORITY_ENV]: 'override-must-not-restore',
  });

  assert.equal(env.KEEP, 'base');
  assert.equal(env.EXTRA, 'override');
  assert.equal(Object.hasOwn(env, CAPABILITY_ENV), false);
  assert.equal(Object.hasOwn(env, AUTHORITY_ENV), false);
  assert.equal(base[CAPABILITY_ENV], 'capability-test-value');
  assert.equal(base[AUTHORITY_ENV], 'authority-test-value');
});

test('every COSMO model or provider controlled subprocess imports and uses the shared scrubber', () => {
  const required = [
    'cosmo23/engine/src/core/capabilities.js',
    'cosmo23/engine/src/core/mcp-client.js',
    'cosmo23/engine/src/planning/acceptance-validator.js',
    'cosmo23/engine/src/agents/code-creation-agent.js',
    'cosmo23/engine/src/agents/data-acquisition-agent.js',
    'cosmo23/engine/src/agents/execution/bash-executor.js',
    'cosmo23/engine/src/agents/execution/macos-native.js',
    'cosmo23/engine/src/agents/execution/python-executor.js',
    'cosmo23/engine/src/agents/execution-base-agent.js',
    'cosmo23/engine/src/agents/ide-agent.js',
    'cosmo23/engine/src/interactive/interactive-tools.js',
    'cosmo23/engine/src/execution/environment-provisioner.js',
    'cosmo23/engine/src/execution/execution-monitor.js',
    'cosmo23/engine/src/execution/skill-registry.js',
    'cosmo23/engine/src/execution/tool-discovery.js',
    'cosmo23/engine/src/execution/tool-registry.js',
    'cosmo23/engine/src/ide/tools.js',
    'cosmo23/ide/tools.js',
    'cosmo23/engine/brain-studio/server/tools.js',
    'cosmo23/engine/brain-studio-new/server/tools.js',
  ];

  for (const file of required) {
    const requestedPath = path.join(ROOT, file);
    const realPath = fs.realpathSync(requestedPath);
    const source = fs.readFileSync(realPath, 'utf8');
    assert.match(source, /shared\/child-process-env\.cjs/, `${file} must import the shared scrubber`);
    assert.match(source, /unprivilegedChildEnv\(/, `${file} must use the shared scrubber`);
    const importPath = source.match(/require\('([^']*shared\/child-process-env\.cjs)'\)/)?.[1];
    assert.ok(importPath, `${file} must require the shared scrubber`);
    assert.equal(
      path.resolve(path.dirname(realPath), importPath),
      path.join(ROOT, 'shared', 'child-process-env.cjs'),
      `${file} scrubber import must resolve to the Home23 shared boundary`,
    );
  }
});

test('COSMO data acquisition Python child cannot observe either privileged Home23 root', async (t) => {
  const { DataAcquisitionAgent } = require(
    '../../cosmo23/engine/src/agents/data-acquisition-agent.js'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-data-acquisition-env-'));
  const binDir = path.join(root, 'bin');
  const outputDir = path.join(root, 'output');
  const observedPath = path.join(root, 'observed.txt');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'records.json'), JSON.stringify([
    { name: 'first' },
    { name: 'second' },
  ]));
  fs.writeFileSync(path.join(binDir, 'python3'), `#!/bin/sh
if [ -n "$${CAPABILITY_ENV}" ] || [ -n "$${AUTHORITY_ENV}" ]; then
  printf present > ${JSON.stringify(observedPath)}
else
  printf absent > ${JSON.stringify(observedPath)}
fi
printf 0
`, { mode: 0o700 });

  const priorPath = process.env.PATH;
  const priorCapability = process.env[CAPABILITY_ENV];
  const priorAuthority = process.env[AUTHORITY_ENV];
  process.env.PATH = `${binDir}:${priorPath || ''}`;
  process.env[CAPABILITY_ENV] = 'capability-test-value';
  process.env[AUTHORITY_ENV] = 'authority-test-value';
  t.after(() => {
    process.env.PATH = priorPath;
    if (priorCapability === undefined) delete process.env[CAPABILITY_ENV];
    else process.env[CAPABILITY_ENV] = priorCapability;
    if (priorAuthority === undefined) delete process.env[AUTHORITY_ENV];
    else process.env[AUTHORITY_ENV] = priorAuthority;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const agent = Object.create(DataAcquisitionAgent.prototype);
  agent._outputDir = outputDir;
  agent.acquisitionManifest = {};
  agent.logger = { debug() {} };
  agent._writeManifest = async () => {};
  agent.addFinding = async () => {};

  await agent._consolidateToDatabase();

  assert.equal(fs.readFileSync(observedPath, 'utf8'), 'absent');
});

test('COSMO model bash execution cannot observe either privileged Home23 root', async (t) => {
  const { BashExecutor } = require('../../cosmo23/engine/src/agents/execution/bash-executor.js');
  const priorCapability = process.env[CAPABILITY_ENV];
  const priorAuthority = process.env[AUTHORITY_ENV];
  process.env[CAPABILITY_ENV] = 'capability-test-value';
  process.env[AUTHORITY_ENV] = 'authority-test-value';
  t.after(() => {
    if (priorCapability === undefined) delete process.env[CAPABILITY_ENV];
    else process.env[CAPABILITY_ENV] = priorCapability;
    if (priorAuthority === undefined) delete process.env[AUTHORITY_ENV];
    else process.env[AUTHORITY_ENV] = priorAuthority;
  });

  const logger = { error() {}, warn() {}, info() {} };
  const executor = new BashExecutor(null, logger);
  const result = await executor.execute(
    `node -e "process.stdout.write(String(Boolean(process.env.${CAPABILITY_ENV} || process.env.${AUTHORITY_ENV})))"`,
    os.tmpdir(),
  );

  assert.equal(result.success, true);
  assert.equal(result.output, 'false');
  assert.doesNotMatch(result.output, /capability-test-value|authority-test-value/);
});
