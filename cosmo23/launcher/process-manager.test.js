'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  ProcessManager,
  STARTUP_READINESS_TIMEOUT_MS,
  RUNNER_HISTORY_FILENAME,
  RUNNER_CLAIM_FILENAME
} = require('./process-manager');

const logger = { info() {}, warn() {}, error() {} };

async function temporaryRun() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-runner-'));
}

test('launch readiness allows ten seconds for child services', () => {
  assert.equal(STARTUP_READINESS_TIMEOUT_MS, 10000);
});

test('runner ownership refuses a second live runner for one run', async () => {
  const runPath = await temporaryRun();
  const manager = new ProcessManager(__dirname, logger);
  await manager.writeRunnerState(runPath, {
    active: true,
    pid: process.pid,
    runPath,
    startedAt: new Date().toISOString()
  });

  await assert.rejects(
    manager.assertSingleRunner(runPath),
    error => error.code === 'COSMO_RUNNER_ACTIVE'
  );
});

test('runner claim is atomic across launcher instances', async () => {
  const runPath = await temporaryRun();
  const first = new ProcessManager(__dirname, logger);
  const second = new ProcessManager(__dirname, logger);

  await first.acquireRunnerClaim(runPath);
  await assert.rejects(
    second.acquireRunnerClaim(runPath),
    error => error.code === 'COSMO_RUNNER_ACTIVE'
  );
  const claim = JSON.parse(await fs.readFile(
    path.join(runPath, 'drill', RUNNER_CLAIM_FILENAME),
    'utf8'
  ));
  assert.equal(claim.launcherPid, process.pid);
});

test('stale ownership can be superseded without erasing its history', async () => {
  const runPath = await temporaryRun();
  const manager = new ProcessManager(__dirname, logger);
  manager.isPidAlive = () => false;
  manager.isPortInUse = async () => false;
  await manager.writeRunnerState(runPath, {
    active: true,
    pid: 999999,
    runPath,
    startedAt: '2026-01-01T00:00:00.000Z'
  });

  await manager.assertSingleRunner(runPath, 43140);
  await manager.writeRunnerState(runPath, {
    active: true,
    pid: process.pid,
    runPath,
    startedAt: new Date().toISOString()
  });
  await manager.markRunnerStopped(runPath, process.pid, 0, null);

  const current = await manager.readRunnerState(runPath);
  const history = (await fs.readFile(
    path.join(runPath, 'drill', RUNNER_HISTORY_FILENAME),
    'utf8'
  )).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(current.active, false);
  assert.equal(history.length, 3);
  assert.equal(history[0].pid, 999999);
  assert.equal(history[2].exitCode, 0);
});

test('readiness waits for the required port instead of process age', async () => {
  const manager = new ProcessManager(__dirname, logger);
  let checks = 0;
  manager.isPortInUse = async () => {
    checks += 1;
    return checks >= 3;
  };
  const proc = { exitCode: null, signalCode: null, killed: false };
  manager.processes.set('service', proc);

  await manager.waitForRequiredProcess('service', proc, {
    port: 43199,
    timeoutMs: 100,
    pollIntervalMs: 1
  });
  assert.equal(checks, 3);
});
