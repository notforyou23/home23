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

test('owner children get the owner home as HOME only under the Host, without privileged keys', () => {
  const { ownerChildEnv } = require('../../shared/child-process-env.cjs');
  const secrets = { [AUTHORITY_ENV]: 'authority-test-value', [CAPABILITY_ENV]: 'capability-test-value' };
  const runtime = '/fixture/home/runtime/user';
  const product = ownerChildEnv({ HOME23_PRODUCT_HOST: 'true', HOME: runtime, HOME23_OWNER_HOME: '/fixture/owner', ...secrets });
  assert.equal(product.HOME, '/fixture/owner');
  assert.equal(product.HOME23_RUNTIME_HOME, runtime);
  assert.equal(product.HOME23_OWNER_HOME, '/fixture/owner');
  // A child of an owner child still finds Home23's private home.
  assert.equal(ownerChildEnv(product).HOME23_RUNTIME_HOME, runtime);
  // Without the variable the passwd entry is the owner, never the runtime HOME.
  assert.equal(ownerChildEnv({ HOME23_PRODUCT_HOST: 'true', HOME: runtime }).HOME, os.userInfo().homedir);
  // An explicit override wins.
  assert.equal(ownerChildEnv({ HOME23_PRODUCT_HOST: 'true', HOME: runtime }, { HOME: '/fixture/chosen' }).HOME, '/fixture/chosen');
  const development = ownerChildEnv({ HOME: '/fixture/dev', ...secrets });
  assert.deepEqual(development, { HOME: '/fixture/dev' });
  for (const env of [product, development]) {
    assert.equal(AUTHORITY_ENV in env, false);
    assert.equal(CAPABILITY_ENV in env, false);
  }
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
