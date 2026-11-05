'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BashExecutor } = require('../../engine/src/agents/execution/bash-executor.js');

const AUTHORITY_ENV = 'HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY';
const CAPABILITY_ENV = 'HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY';

test('engine model bash execution cannot inherit privileged Home23 authority env', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-engine-child-env-'));
  const previousAuthority = process.env[AUTHORITY_ENV];
  const previousCapability = process.env[CAPABILITY_ENV];
  process.env[AUTHORITY_ENV] = 'authority-test-value';
  process.env[CAPABILITY_ENV] = 'capability-test-value';
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    if (previousAuthority === undefined) delete process.env[AUTHORITY_ENV];
    else process.env[AUTHORITY_ENV] = previousAuthority;
    if (previousCapability === undefined) delete process.env[CAPABILITY_ENV];
    else process.env[CAPABILITY_ENV] = previousCapability;
  });
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const executor = new BashExecutor(null, logger);

  const result = await executor.execute(
    `node -e "process.stdout.write(String(Boolean(process.env.${AUTHORITY_ENV} || process.env.${CAPABILITY_ENV})))"`,
    cwd,
  );
  assert.equal(result.success, true);
  assert.equal(result.output, 'false');
});

test('macOS-native model execution passes only an unprivileged child env', async (t) => {
  const childProcess = require('node:child_process');
  const modulePath = require.resolve('../../engine/src/agents/execution/macos-native.js');
  const originalExec = childProcess.exec;
  const previousAuthority = process.env[AUTHORITY_ENV];
  const previousCapability = process.env[CAPABILITY_ENV];
  let observedEnv = null;
  childProcess.exec = (_command, options, callback) => {
    observedEnv = options?.env;
    callback(null, '', '');
  };
  process.env[AUTHORITY_ENV] = 'authority-test-value';
  process.env[CAPABILITY_ENV] = 'capability-test-value';
  delete require.cache[modulePath];
  t.after(() => {
    childProcess.exec = originalExec;
    delete require.cache[modulePath];
    if (previousAuthority === undefined) delete process.env[AUTHORITY_ENV];
    else process.env[AUTHORITY_ENV] = previousAuthority;
    if (previousCapability === undefined) delete process.env[CAPABILITY_ENV];
    else process.env[CAPABILITY_ENV] = previousCapability;
  });

  const { MacOSNative } = require(modulePath);
  const native = new MacOSNative({ info() {}, error() {} });
  native.enabled = true;
  await native.openApp('Finder');

  assert.ok(observedEnv);
  assert.equal(AUTHORITY_ENV in observedEnv, false);
  assert.equal(CAPABILITY_ENV in observedEnv, false);
});

test('every root engine model/provider child path uses the centralized scrubber', () => {
  const files = [
    'engine/src/core/capabilities.js',
    'engine/src/agents/execution/bash-executor.js',
    'engine/src/agents/execution/python-executor.js',
    'engine/src/agents/execution/macos-native.js',
    'engine/src/ide/tools.js',
    'engine/src/planning/acceptance-validator.js',
    'engine/src/core/mcp-client.js',
    'engine/src/agents/code-creation-agent.js',
    'engine/src/cognition/latent-projector.js',
    'engine/src/ingestion/document-converter.js',
    'engine/src/dashboard/server.js',
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
    assert.match(source, /child-process-env\.cjs/, file);
    assert.match(source, /unprivilegedChildEnv\(/, file);
  }
});
