'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const TERMINAL = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);

async function receiptFixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-fixture-receipt-')));
  const receiptRunDir = path.join(root, 'receipt-run');
  await fs.mkdir(receiptRunDir, { mode: 0o700 });
  const receiptRunId = 'isolated-production-fixture';
  const implementationCommit = 'a'.repeat(40);
  const liveTree = 'b'.repeat(40);
  const hostname = 'fixture-host';
  const startedAt = '2026-07-10T00:00:00.000Z';
  await fs.writeFile(path.join(receiptRunDir, 'run-authority.json'), `${JSON.stringify({
    schemaVersion: 1,
    receiptRunId,
    authority: 'live',
    implementationCommit,
    expectedLiveTree: liveTree,
    actualLiveTree: liveTree,
    hostname,
    startedAt,
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const { receiptContext } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const context = await receiptContext(Object.create(null), {
    HOME23_RECEIPT_RUN_DIR: receiptRunDir,
    HOME23_RECEIPT_RUN_ID: receiptRunId,
    HOME23_RECEIPT_AUTHORITY: 'isolated-controlled',
    HOME23_RECEIPT_IMPLEMENTATION_COMMIT: implementationCommit,
  });
  return {
    root,
    context,
    visibleContext: {
      receiptRunDir,
      receiptRunId,
      authority: 'isolated-controlled',
      implementationCommit,
      hostname,
      startedAt,
    },
  };
}

async function primaryCheckoutRoot() {
  const linkedRoot = await fs.realpath(process.cwd());
  const gitEntry = path.join(linkedRoot, '.git');
  if ((await fs.lstat(gitEntry)).isDirectory()) return null;
  const pointer = (await fs.readFile(gitEntry, 'utf8')).trim();
  const gitdir = /^gitdir:\s*(.+)$/.exec(pointer)?.[1];
  assert.ok(gitdir, pointer);
  const worktreeGitDir = await fs.realpath(path.resolve(linkedRoot, gitdir));
  const commonPointer = (await fs.readFile(path.join(worktreeGitDir, 'commondir'), 'utf8')).trim();
  const commonGitDir = await fs.realpath(path.resolve(worktreeGitDir, commonPointer));
  assert.equal(path.basename(commonGitDir), '.git');
  return fs.realpath(path.dirname(commonGitDir));
}

async function runFixtureChild(argv, env) {
  const script = path.resolve('scripts/lib/isolated-brain-fixture.mjs');
  const child = spawn(process.execPath, [script, ...argv], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await new Promise((resolve) => {
    child.once('exit', (...result) => resolve(result));
  });
  return { code, signal, stderr };
}

async function fixtureTestDelay(operationDelayMs = 5) {
  const {
    createIsolatedFixtureTestDelaySeam,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  return createIsolatedFixtureTestDelaySeam({ operationDelayMs });
}

async function awaitTerminal(client, initial) {
  let current = initial;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (TERMINAL.has(current.state)) {
      return client.inspectOperation(current.operationId, 'result');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    current = await client.getOperation(current.operationId);
  }
  throw Object.assign(new Error('fixture operation did not become terminal'), {
    code: 'fixture_operation_timeout',
  });
}

async function awaitState(client, operationId, expected) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const current = await client.getOperation(operationId);
    if (expected.includes(current.state)) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Object.assign(new Error(`fixture operation did not reach ${expected.join(',')}`), {
    code: 'fixture_operation_timeout',
  });
}

async function awaitProviderStart(fixture, baseline) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const telemetry = await fixture.telemetry();
    if (telemetry.cosmo.providerStarts > baseline) return telemetry;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw Object.assign(new Error('fixture provider did not start'), {
    code: 'fixture_provider_timeout',
  });
}

async function assertPidExited(pid) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.equal(error.code, 'ESRCH');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`fixture child ${pid} remained alive`);
}

function mutateAfterIdentityRead(filePattern, mutate, { occurrence = 1 } = {}) {
  const originalOpen = fs.open;
  let observed = 0;
  let mutated = false;
  fs.open = async (file, flags, ...rest) => {
    const handle = await originalOpen(file, flags, ...rest);
    if (!filePattern.test(String(file))) return handle;
    observed += 1;
    if (observed !== occurrence) return handle;
    const originalClose = handle.close.bind(handle);
    handle.close = async () => {
      await originalClose();
      if (!mutated) {
        mutated = true;
        await mutate(String(file));
      }
    };
    return handle;
  };
  return {
    restore() { fs.open = originalOpen; },
    get observed() { return observed; },
    get mutated() { return mutated; },
  };
}

test('isolated stop refuses child handles not created by the fixture launcher', async () => {
  const { stopIsolatedFixture } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  await assert.rejects(stopIsolatedFixture({
    children: {
      dashboard: { pid: 111, exitCode: 0 },
      cosmo: { pid: 222, exitCode: 0 },
    },
    operationsRoot: '/tmp/not-a-fixture-store',
  }), (error) => error.code === 'isolated_child_not_owned');
});

test('isolated fixture bounds HTTP response bytes before JSON parsing', async () => {
  const {
    readBoundedFixtureJsonResponse,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  assert.deepEqual(await readBoundedFixtureJsonResponse(new Response('{"ok":true}'), {
    maxBytes: 32,
  }), { ok: true });
  await assert.rejects(readBoundedFixtureJsonResponse(new Response(JSON.stringify({
    payload: 'x'.repeat(128),
  })), { maxBytes: 32 }), (error) => error.code === 'fixture_response_too_large');
  await assert.rejects(readBoundedFixtureJsonResponse(new Response('{broken'), {
    maxBytes: 32,
  }), (error) => error.code === 'fixture_response_invalid');
});

test('controlled delay re-arms an early timer and clears the exact pending timer on abort', async () => {
  const {
    waitForControlledDelay,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  assert.equal(typeof waitForControlledDelay, 'function');
  let now = 0n;
  const timers = [];
  const cleared = [];
  const setTimeoutImpl = (callback, delay) => {
    const timer = { callback, delay, sequence: timers.length + 1 };
    timers.push(timer);
    return timer;
  };
  const clearTimeoutImpl = (timer) => cleared.push(timer);
  const telemetry = { providerAborts: 0 };
  let settled = false;
  const waiting = waitForControlledDelay(3_000, null, telemetry, {
    nowNs: () => now,
    setTimeoutImpl,
    clearTimeoutImpl,
  }).then(() => { settled = true; });
  assert.equal(timers[0].delay, 3_000);

  now = 2_999_000_000n;
  timers[0].callback();
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(timers[1].delay, 1);

  now = 3_000_000_000n;
  timers[1].callback();
  await waiting;
  assert.equal(settled, true);
  assert.deepEqual(cleared, []);

  const controller = new AbortController();
  const abortTelemetry = { providerAborts: 0 };
  const abortReason = Object.assign(new Error('cancel fixture delay'), {
    code: 'operation_cancelled',
  });
  const aborting = waitForControlledDelay(3_000, controller.signal, abortTelemetry, {
    nowNs: () => now,
    setTimeoutImpl,
    clearTimeoutImpl,
  });
  const abortTimer = timers.at(-1);
  controller.abort(abortReason);
  await assert.rejects(aborting, (error) => error === abortReason);
  assert.equal(abortTelemetry.providerAborts, 1);
  assert.equal(cleared.at(-1), abortTimer);
});

test('isolated metric publisher serializes writes, coalesces ticks, and awaits its exact writer on stop', async () => {
  const {
    createSerializedMetricPublisher,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  assert.equal(typeof createSerializedMetricPublisher, 'function');

  const timer = Object.freeze({ fixtureTimer: true });
  const clearCalls = [];
  const gates = [];
  const published = [];
  let tick;
  let active = 0;
  let maxActive = 0;
  const publisher = createSerializedMetricPublisher({
    intervalMs: 50,
    setIntervalImpl(callback, intervalMs) {
      assert.equal(intervalMs, 50);
      tick = callback;
      return timer;
    },
    clearIntervalImpl(value) {
      clearCalls.push(value);
    },
    publish: async () => {
      const sequence = gates.length + 1;
      let release;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      gates.push({ release });
      active += 1;
      maxActive = Math.max(maxActive, active);
      await blocked;
      published.push(sequence);
      active -= 1;
    },
  });

  tick();
  await Promise.resolve();
  assert.equal(gates.length, 1);
  tick();
  tick();
  assert.equal(gates.length, 1);

  gates[0].release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gates.length, 2);
  assert.deepEqual(published, [1]);
  assert.equal(maxActive, 1);

  let stopped = false;
  const stopping = publisher.stop().then(() => {
    stopped = true;
  });
  tick();
  await Promise.resolve();
  assert.equal(stopped, false);
  assert.deepEqual(clearCalls, [timer]);
  assert.equal(gates.length, 2);

  gates[1].release();
  await stopping;
  assert.equal(stopped, true);
  assert.equal(maxActive, 1);
  assert.deepEqual(published, [1, 2]);
  tick();
  await publisher.request();
  await publisher.stop();
  assert.equal(gates.length, 2);
  assert.deepEqual(clearCalls, [timer]);
});

test('isolated launcher rejects a forged visible receipt context before adopting the root', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-forged-context-fixture-'),
  ));
  let launched = null;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });

  let rejection = null;
  try {
    launched = await startIsolatedFixture({
      fixtureRoot: isolatedRoot,
      context: { ...state.visibleContext },
    });
  } catch (error) {
    rejection = error;
  }
  if (launched) {
    await stopIsolatedFixture(launched);
    launched = null;
  }
  assert.equal(rejection?.code, 'receipt_context_invalid');
  await assert.rejects(fs.stat(path.join(isolatedRoot, 'fixture-owner.json')), {
    code: 'ENOENT',
  });
});

test('isolated launcher refuses a non-production delay without the opaque test seam', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-delay-mismatch-fixture-'),
  ));
  let launched = null;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });

  let rejection = null;
  try {
    launched = await startIsolatedFixture({
      fixtureRoot: isolatedRoot,
      context: state.context,
      operationDelayMs: 5,
    });
  } catch (error) {
    rejection = error;
  }
  if (launched) {
    await stopIsolatedFixture(launched);
    launched = null;
  }
  assert.equal(rejection?.code, 'isolated_fixture_production_delay_required');
  await assert.rejects(fs.stat(path.join(isolatedRoot, 'fixture-owner.json')), {
    code: 'ENOENT',
  });
});

test('isolated launcher requires an exact operator-owned mode 0700 fixture root', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-insecure-mode-fixture-'),
  ));
  let launched = null;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });
  await fs.chmod(isolatedRoot, 0o755);
  let rejection = null;
  try {
    launched = await startIsolatedFixture({
      fixtureRoot: isolatedRoot,
      context: state.context,
      testDelaySeam: await fixtureTestDelay(),
    });
  } catch (error) {
    rejection = error;
  }
  if (launched) {
    await stopIsolatedFixture(launched);
    launched = null;
  }
  assert.equal(rejection?.code, 'isolated_fixture_ownership_mismatch');
});

test('isolated launcher revalidates every ready-file identity after the final child handshake', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-final-ready-fixture-'),
  ));
  let launched = null;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });
  const mutation = mutateAfterIdentityRead(
    /dashboard-[0-9a-f-]+\.ready\.json$/i,
    async (file) => fs.appendFile(file, '\n'),
  );
  let rejection = null;
  try {
    launched = await startIsolatedFixture({
      fixtureRoot: isolatedRoot,
      context: state.context,
      agent: 'final-ready-fixture',
      testDelaySeam: await fixtureTestDelay(),
    });
  } catch (error) {
    rejection = error;
  } finally {
    mutation.restore();
  }
  if (launched) {
    await stopIsolatedFixture(launched);
    launched = null;
  }
  assert.equal(mutation.mutated, true);
  assert.equal(rejection?.code, 'isolated_child_ready_invalid');
});

test('dashboard restart revalidates owner, configs, key, and every ready file after replacement', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-final-restart-bindings-'),
  ));
  let launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'final-restart-bindings',
    testDelaySeam: await fixtureTestDelay(),
  });
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });
  const capabilityKey = launched.capabilityKeyFile;
  const mutation = mutateAfterIdentityRead(
    /dashboard-[0-9a-f-]+\.ready\.json$/i,
    async () => fs.appendFile(capabilityKey, '\n'),
    { occurrence: 2 },
  );
  let rejection = null;
  try {
    await launched.restartDashboard({ readyTimeoutMs: 3_000 });
  } catch (error) {
    rejection = error;
  } finally {
    mutation.restore();
  }
  assert.equal(mutation.mutated, true);
  assert.equal(rejection?.code, 'isolated_fixture_capability_identity_invalid');
});

test('isolated child receives no inherited provider credentials, live paths, NODE_OPTIONS, or NODE_PATH', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-scrubbed-env-fixture-'),
  ));
  const hook = path.join(state.root, 'inherited-node-options-hook.cjs');
  const marker = path.join(state.root, 'inherited-node-options-ran.txt');
  await fs.writeFile(hook, [
    "'use strict';",
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(marker)}, \`${'${process.pid}'}\\n\`);`,
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  const inherited = {
    OPENAI_API_KEY: 'fake-openai-secret',
    ANTHROPIC_API_KEY: 'fake-anthropic-secret',
    GOOGLE_API_KEY: 'fake-google-secret',
    SYNTHESIS_LLM_PROVIDER: 'fake-live-provider',
    SYNTHESIS_LLM_MODEL: 'fake-live-model',
    HOME23_ROOT: process.cwd(),
    HOME23_AGENT: 'live-jerry',
    HOME23_CONFIG: path.join(process.cwd(), 'config', 'home.yaml'),
    NODE_OPTIONS: `--require=${hook}`,
    NODE_PATH: state.root,
  };
  const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
  Object.assign(process.env, inherited);
  let launched = null;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });

  try {
    launched = await startIsolatedFixture({
      fixtureRoot: isolatedRoot,
      context: state.context,
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const forbidden = new Set(Object.keys(inherited));
  forbidden.delete('NODE_PATH');
  for (const role of ['cosmo', 'dashboard', 'mcp']) {
    const keys = launched.childEnvironmentKeys[role];
    assert.equal(Array.isArray(keys), true);
    assert.equal(keys.includes('NODE_PATH'), true);
    assert.equal(keys.some((key) => forbidden.has(key)), false, JSON.stringify(keys));
  }
  await assert.rejects(fs.stat(marker), { code: 'ENOENT' });
});

test('direct isolated child invocation rejects a fixture root containing the live checkout', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-direct-child-fixture-'),
  ));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const keyFile = path.join(root, 'capability.key');
  const configFile = path.join(root, 'cosmo.json');
  const startToken = '11111111-2222-4333-8444-555555555555';
  const liveAncestor = await fs.stat('/', { bigint: true });
  await fs.writeFile(keyFile, `${'a'.repeat(64)}\n`, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(configFile, `${JSON.stringify({
    role: 'cosmo',
    startToken,
    launcherPid: process.pid,
    fixtureRoot: '/',
    fixtureRootIdentity: {
      path: '/',
      dev: liveAncestor.dev.toString(),
      ino: liveAncestor.ino.toString(),
    },
    capabilityKeyFile: keyFile,
  })}\n`, { flag: 'wx', mode: 0o600 });

  const result = await runFixtureChild([
    '--internal-role', 'cosmo',
    '--config', configFile,
  ], {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME23_ISOLATED_FIXTURE_CHILD: '1',
  });
  assert.notEqual(result.code, 0, result.stderr);
  const failure = JSON.parse(result.stderr.trim().split('\n').at(-1));
  assert.equal(failure.code, 'isolated_fixture_live_root_refused', result.stderr);
});

test('isolated launcher refuses the repository as a fixture root before creating runtime state', async (t) => {
  const { startIsolatedFixture } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  await assert.rejects(startIsolatedFixture({
    fixtureRoot: process.cwd(),
    context: state.context,
  }), (error) => error.code === 'isolated_fixture_live_root_refused');
});

test('isolated launcher rejects the primary checkout and sibling worktrees from a linked worktree', async (t) => {
  const { startIsolatedFixture } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const primaryRoot = await primaryCheckoutRoot();
  if (!primaryRoot) {
    t.skip('linked-worktree-only boundary proof');
    return;
  }
  const siblingRoot = await fs.realpath(path.join(
    primaryRoot,
    '.worktrees',
    'brain-agent-task2',
  ));
  assert.notEqual(primaryRoot, await fs.realpath(process.cwd()));
  assert.notEqual(siblingRoot, await fs.realpath(process.cwd()));
  for (const candidate of [primaryRoot, siblingRoot]) {
    await assert.rejects(startIsolatedFixture({
      fixtureRoot: candidate,
      context: state.context,
    }), (error) => error.code === 'isolated_fixture_live_root_refused', candidate);
  }
});

test('isolated launcher never adopts an ownerless non-empty fixture root', async (t) => {
  const { startIsolatedFixture } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-ownerless-fixture-'),
  ));
  t.after(() => Promise.all([
    fs.rm(state.root, { recursive: true, force: true }),
    fs.rm(isolatedRoot, { recursive: true, force: true }),
  ]));
  await fs.writeFile(path.join(isolatedRoot, 'unrelated-user-state.txt'), 'preserve me\n');

  await assert.rejects(startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
  }), (error) => error.code === 'isolated_fixture_ownerless_nonempty');
  assert.equal(await fs.readFile(path.join(isolatedRoot, 'unrelated-user-state.txt'), 'utf8'), 'preserve me\n');
  await assert.rejects(fs.stat(path.join(isolatedRoot, 'fixture-owner.json')), {
    code: 'ENOENT',
  });
});

test('isolated launcher rejects source and runtime symlink descendants before mutating their targets', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-symlink-descendant-fixture-'),
  ));
  const outsideRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-symlink-descendant-outside-'),
  ));
  const sentinel = path.join(outsideRoot, 'preserve.txt');
  await fs.writeFile(sentinel, 'outside must remain unchanged\n', { flag: 'wx', mode: 0o600 });
  let launched = null;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
      fs.rm(outsideRoot, { recursive: true, force: true }),
    ]);
  });

  launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'symlink-descendant-fixture',
    testDelaySeam: await fixtureTestDelay(),
  });
  await stopIsolatedFixture(launched);
  launched = null;
  await Promise.all([
    fs.rm(path.join(isolatedRoot, 'instances'), { recursive: true, force: true }),
    fs.rm(path.join(isolatedRoot, 'runtime'), { recursive: true, force: true }),
  ]);
  await fs.symlink(outsideRoot, path.join(isolatedRoot, 'instances'), 'dir');

  let rejection = null;
  try {
    launched = await startIsolatedFixture({
      fixtureRoot: isolatedRoot,
      context: state.context,
      agent: 'symlink-descendant-fixture',
      testDelaySeam: await fixtureTestDelay(),
    });
  } catch (error) {
    rejection = error;
  }
  if (launched) {
    await stopIsolatedFixture(launched);
    launched = null;
  }
  assert.equal(rejection?.code, 'isolated_fixture_path_invalid');
  assert.deepEqual(await fs.readdir(outsideRoot), ['preserve.txt']);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside must remain unchanged\n');
  assert.equal((await fs.stat(sentinel)).mode & 0o777, 0o600);

  await fs.unlink(path.join(isolatedRoot, 'instances'));
  await fs.symlink(outsideRoot, path.join(isolatedRoot, 'runtime'), 'dir');
  rejection = null;
  try {
    launched = await startIsolatedFixture({
      fixtureRoot: isolatedRoot,
      context: state.context,
      agent: 'symlink-descendant-fixture',
      testDelaySeam: await fixtureTestDelay(),
    });
  } catch (error) {
    rejection = error;
  }
  if (launched) {
    await stopIsolatedFixture(launched);
    launched = null;
  }
  assert.equal(rejection?.code, 'isolated_fixture_path_invalid');
  assert.deepEqual(await fs.readdir(outsideRoot), ['preserve.txt']);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside must remain unchanged\n');
  assert.equal((await fs.stat(sentinel)).mode & 0o777, 0o600);

  await fs.unlink(path.join(isolatedRoot, 'runtime'));
  await fs.chmod(path.join(isolatedRoot, 'instances'), 0o755);
  rejection = null;
  try {
    launched = await startIsolatedFixture({
      fixtureRoot: isolatedRoot,
      context: state.context,
      agent: 'symlink-descendant-fixture',
      testDelaySeam: await fixtureTestDelay(),
    });
  } catch (error) {
    rejection = error;
  }
  if (launched) {
    await stopIsolatedFixture(launched);
    launched = null;
  }
  assert.equal(rejection?.code, 'isolated_fixture_path_invalid');
  assert.equal((await fs.stat(path.join(isolatedRoot, 'instances'))).mode & 0o777, 0o755);
  assert.deepEqual(await fs.readdir(outsideRoot), ['preserve.txt']);
});

test('isolated shutdown records a crashed role distinctly from a clean exact-PID exit', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-crashed-child-fixture-'),
  ));
  let launched = null;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });

  launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'crashed-child-fixture',
    testDelaySeam: await fixtureTestDelay(),
  });
  const crashedPid = launched.pids.mcp;
  const crashed = new Promise((resolve) => launched.children.mcp.once('exit', resolve));
  process.kill(crashedPid, 'SIGKILL');
  await crashed;
  const stopped = await stopIsolatedFixture(launched);
  assert.equal(Object.isFrozen(stopped), true);
  assert.deepEqual({
    role: stopped.mcp.role,
    pid: stopped.mcp.pid,
    expectedPid: stopped.mcp.expectedPid,
    cleanExit: stopped.mcp.cleanExit,
    forcedKill: stopped.mcp.forcedKill,
    terminationRequested: stopped.mcp.terminationRequested,
    signalDeliveryObserved: stopped.mcp.signalDeliveryObserved,
    outcome: stopped.mcp.outcome,
    signal: stopped.mcp.signal,
  }, {
    role: 'mcp',
    pid: crashedPid,
    expectedPid: crashedPid,
    cleanExit: false,
    forcedKill: false,
    terminationRequested: false,
    signalDeliveryObserved: false,
    outcome: 'crashed',
    signal: 'SIGKILL',
  });
  for (const role of ['dashboard', 'cosmo']) {
    assert.equal(stopped[role].role, role);
    assert.equal(stopped[role].pid, launched.pids[role]);
    assert.equal(stopped[role].expectedPid, launched.pids[role]);
    assert.equal(stopped[role].cleanExit, true);
    assert.equal(stopped[role].forcedKill, false);
    assert.equal(stopped[role].terminationRequested, true);
    assert.equal(stopped[role].signalDeliveryObserved, true);
    assert.equal(stopped[role].outcome, 'clean-exit');
  }
  launched = null;
});

test('isolated shutdown cannot claim a clean stop for a child that exited before launcher termination', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-prestopped-child-fixture-'),
  ));
  let launched = null;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });

  launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'prestopped-child-fixture',
    testDelaySeam: await fixtureTestDelay(),
  });
  const prestoppedPid = launched.pids.mcp;
  const exited = new Promise((resolve) => launched.children.mcp.once('exit', resolve));
  process.kill(prestoppedPid, 'SIGTERM');
  await exited;
  const stopped = await stopIsolatedFixture(launched);
  assert.deepEqual({
    role: stopped.mcp.role,
    pid: stopped.mcp.pid,
    expectedPid: stopped.mcp.expectedPid,
    code: stopped.mcp.code,
    signal: stopped.mcp.signal,
    cleanExit: stopped.mcp.cleanExit,
    forcedKill: stopped.mcp.forcedKill,
    terminationRequested: stopped.mcp.terminationRequested,
    signalDeliveryObserved: stopped.mcp.signalDeliveryObserved,
    outcome: stopped.mcp.outcome,
  }, {
    role: 'mcp',
    pid: prestoppedPid,
    expectedPid: prestoppedPid,
    code: 0,
    signal: null,
    cleanExit: false,
    forcedKill: false,
    terminationRequested: false,
    signalDeliveryObserved: false,
    outcome: 'exited-before-stop',
  });
  launched = null;
});

test('isolated shutdown final-revalidates owner provenance and still stops every child on failure', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-final-owner-revalidation-fixture-'),
  ));
  let launched = null;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });

  launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'final-owner-revalidation-fixture',
    testDelaySeam: await fixtureTestDelay(),
  });
  const pids = { ...launched.pids };
  await fs.appendFile(path.join(isolatedRoot, 'fixture-owner.json'), '\n');
  let rejection = null;
  try {
    await stopIsolatedFixture(launched);
  } catch (error) {
    rejection = error;
  }
  assert.equal(rejection?.code, 'isolated_fixture_security_unproven');
  assert.equal(rejection?.stopped?.securityEvidence, null);
  for (const role of ['dashboard', 'cosmo', 'mcp']) {
    assert.equal(rejection?.stopped?.[role]?.role, role);
    assert.equal(rejection?.stopped?.[role]?.pid, pids[role]);
    assert.equal(rejection?.stopped?.[role]?.cleanExit, true);
    await assertPidExited(pids[role]);
  }
  launched = null;
});

test('isolated launcher exposes distinct own, sibling, completed-research, and MCP sources', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const { loadProductionModules } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const modules = await loadProductionModules();
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-source-mcp-fixture-'),
  ));
  let launched;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });

  launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'source-fixture',
    nodeCount: 12,
    edgeCount: 11,
    testDelaySeam: await fixtureTestDelay(),
  });
  assert.equal(Number.isSafeInteger(launched.pids.mcp), true);
  assert.equal(Number.isSafeInteger(launched.ports.mcp), true);
  assert.notEqual(launched.pids.mcp, launched.pids.dashboard);
  assert.notEqual(launched.pids.mcp, launched.pids.cosmo);
  assert.equal(launched.configuredOperationDelayMs, 3000);
  assert.equal(launched.effectiveOperationDelayMs, 5);
  assert.equal(launched.testOnlyOperationDelay, true);
  assert.equal(Object.isFrozen(launched.securityBindings), true);
  assert.equal(Object.isFrozen(launched.securityBindings.configs), true);
  assert.equal(Object.isFrozen(launched.securityBindings.ready), true);
  const identityFiles = [
    launched.securityBindings.owner.path,
    launched.securityBindings.capabilityKey.path,
    ...Object.values(launched.securityBindings.configs).map((entry) => entry.path),
    ...Object.values(launched.securityBindings.ready).map((entry) => entry.path),
  ];
  for (const file of identityFiles) {
    const stat = await fs.lstat(file);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(stat.nlink, 1);
    if (typeof process.getuid === 'function') assert.equal(stat.uid, process.getuid());
  }
  const capabilitySecret = (await fs.readFile(launched.capabilityKeyFile, 'utf8')).trim();
  for (const file of identityFiles.filter((entry) => entry !== launched.capabilityKeyFile)) {
    assert.equal((await fs.readFile(file, 'utf8')).includes(capabilitySecret), false);
  }
  const boundDashboardConfig = JSON.parse(
    await fs.readFile(launched.dashboardConfigFile, 'utf8'),
  );
  assert.equal(boundDashboardConfig.launcherPid, process.pid);
  assert.deepEqual(boundDashboardConfig.fixtureRootIdentity, launched.securityBindings.fixtureRoot);
  assert.deepEqual(boundDashboardConfig.fixtureOwnerIdentity, launched.securityBindings.owner);
  assert.deepEqual(
    boundDashboardConfig.capabilityKeyIdentity,
    launched.securityBindings.capabilityKey,
  );
  assert.deepEqual(launched.canary, {
    query: 'authoritative isolated canary production',
    nodeId: '1',
    sourceRevision: 1,
    sourceHealth: 'healthy',
    selectedBrain: launched.brainId,
    discoveryRoute: 'production-memory-source-reader',
  });
  const firstMetrics = {};
  for (const role of ['dashboard', 'cosmo', 'mcp']) {
    const metrics = JSON.parse(await fs.readFile(launched.metrics[role], 'utf8'));
    firstMetrics[role] = metrics;
    assert.equal(metrics.schemaVersion, 2);
    assert.equal(metrics.role, role);
    assert.equal(metrics.pid, launched.pids[role]);
    assert.equal(Object.hasOwn(metrics, 'heapUsedMiB'), false);
    assert.equal(Number.isFinite(metrics.v8HeapUsedMiB) && metrics.v8HeapUsedMiB >= 0, true);
    assert.equal(Number.isFinite(metrics.rssMiB) && metrics.rssMiB > 0, true);
    assert.equal(metrics.processMaxRssMiB >= metrics.rssMiB, true);
    assert.deepEqual(metrics.semantics, {
      v8HeapUsedBytes: 'request-time-sample',
      rssBytes: 'request-time-sample',
      processMaxRssBytes: 'process-lifetime-high-water',
    });
    assert.equal(Number.isFinite(Date.parse(metrics.updatedAt)), true);
  }
  await new Promise((resolve) => setTimeout(resolve, 75));
  for (const role of ['dashboard', 'cosmo', 'mcp']) {
    const metrics = JSON.parse(await fs.readFile(launched.metrics[role], 'utf8'));
    assert.equal(metrics.pid, firstMetrics[role].pid);
    assert.equal(metrics.processMaxRssMiB >= firstMetrics[role].processMaxRssMiB, true);
  }

  const client = new modules.BrainOperationsClient({
    baseUrl: launched.baseUrl,
    callerAgent: 'source-fixture',
    shortWaitMs: 5_000,
    reconnectDelayMs: 10,
  });
  const catalog = await client.getCatalog({ forceRefresh: true });
  const own = catalog.brains.find((brain) => brain.id === launched.brainId);
  const sibling = catalog.brains.find((brain) => brain.id === `${launched.brainId}-sibling`);
  const research = catalog.brains.find((brain) => brain.id === `${launched.brainId}-research-completed`);
  assert.ok(own);
  assert.ok(sibling);
  assert.ok(research);
  assert.equal(sibling.ownerAgent, 'source-fixture-sibling');
  assert.equal(research.kind, 'research');
  assert.equal(research.lifecycle, 'completed');
  assert.equal(new Set([
    own.canonicalRoot,
    sibling.canonicalRoot,
    research.canonicalRoot,
  ]).size, 3);
  assert.equal((await client.resolveTarget()).accessMode, 'own');
  assert.equal((await client.resolveTarget({ agent: sibling.ownerAgent })).accessMode, 'read-only');
  assert.equal((await client.resolveTarget({ brainId: research.id })).accessMode, 'read-only');

  const cases = [
    { target: undefined, phrase: 'authoritative isolated own canary', brainId: own.id },
    {
      target: { agent: sibling.ownerAgent },
      phrase: 'authoritative isolated sibling canary',
      brainId: sibling.id,
    },
    {
      target: { brainId: research.id },
      phrase: 'authoritative isolated completed research canary',
      brainId: research.id,
    },
  ];
  for (const entry of cases) {
    const initialSearch = await client.search({
      ...(entry.target ? { target: entry.target } : {}),
      query: entry.phrase,
      topK: 5,
    });
    const search = TERMINAL.has(initialSearch.state)
      ? await client.inspectOperation(initialSearch.operationId, 'result')
      : await awaitTerminal(client, initialSearch);
    assert.equal(search.sourceEvidence?.sourceHealth, 'healthy', JSON.stringify(search));
    assert.equal(search.sourceEvidence.selectedBrain, entry.brainId);
    assert.ok(search.result.results.some(
      (result) => String(result.concept).includes(entry.phrase),
    ));
  }

  const health = await fetch(`${launched.mcpBaseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    ok: true,
    protocolVersion: '2025-03-26',
    sourceHealth: 'healthy',
    revision: 1,
    totals: { nodes: 12, edges: 11 },
  });
  const proxied = await fetch(`${launched.baseUrl}/api/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'isolated-mcp-parity',
      method: 'tools/call',
      params: {
        name: 'query_memory',
        arguments: { query: 'authoritative isolated own canary', limit: 5 },
      },
    }),
  });
  const mcpText = await proxied.text();
  const dataLine = mcpText.split('\n').find((line) => line.startsWith('data: '));
  assert.ok(dataLine, mcpText);
  const mcpBody = JSON.parse(dataLine.slice(6));
  assert.equal(proxied.status, 200, JSON.stringify(mcpBody));
  const mcpResult = JSON.parse(mcpBody.result.content[0].text);
  assert.equal(mcpResult.evidence.sourceHealth, 'healthy');
  assert.equal(mcpResult.evidence.identity.brainId, own.id);
  assert.ok(mcpResult.results.some((result) => String(result.id) === '1'));

  const firstOwner = launched.owner;
  assert.equal(firstOwner.schemaVersion, 2);
  assert.match(firstOwner.provenanceSeal, /^sha256:[a-f0-9]{64}$/);
  const firstOwnerStat = await fs.stat(path.join(isolatedRoot, 'fixture-owner.json'));
  assert.equal(firstOwnerStat.mode & 0o777, 0o600);
  assert.equal(firstOwnerStat.nlink, 1);
  await stopIsolatedFixture(launched);
  launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'source-fixture',
    nodeCount: 12,
    edgeCount: 11,
    testDelaySeam: await fixtureTestDelay(),
  });
  assert.deepEqual(launched.owner, firstOwner);
  await stopIsolatedFixture(launched);
  launched = null;
  await assert.rejects(startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: { ...state.context, receiptRunId: 'different-isolated-production-fixture' },
    agent: 'source-fixture',
    nodeCount: 12,
    edgeCount: 11,
    testDelaySeam: await fixtureTestDelay(),
  }), (error) => error.code === 'receipt_context_invalid');
  const ownerFile = path.join(isolatedRoot, 'fixture-owner.json');
  const tampered = JSON.parse(await fs.readFile(ownerFile, 'utf8'));
  await fs.chmod(ownerFile, 0o600);
  await fs.writeFile(ownerFile, `${JSON.stringify({ ...tampered, hostname: 'tampered-host' })}\n`);
  await assert.rejects(startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'source-fixture',
    nodeCount: 12,
    edgeCount: 11,
    testDelaySeam: await fixtureTestDelay(),
  }), (error) => error.code === 'isolated_fixture_ownership_mismatch');
});

test('fixture owner rejects concurrent growth through positional bounded reads', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-owner-growth-fixture-'),
  ));
  t.after(() => Promise.all([
    fs.rm(state.root, { recursive: true, force: true }),
    fs.rm(isolatedRoot, { recursive: true, force: true }),
  ]));
  let launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'owner-growth-fixture',
    testDelaySeam: await fixtureTestDelay(),
  });
  await stopIsolatedFixture(launched);
  launched = null;

  const ownerFile = path.join(isolatedRoot, 'fixture-owner.json');
  const originalOpen = fs.open;
  await fs.chmod(ownerFile, 0o600);
  const writer = await originalOpen(ownerFile, 'r+');
  let positionalReadObserved = false;
  let unboundedReadFileObserved = false;
  let rejection = null;
  fs.open = async (file, flags, ...rest) => {
    const handle = await originalOpen(file, flags, ...rest);
    if (path.resolve(String(file)) !== ownerFile) return handle;
    const originalRead = handle.read.bind(handle);
    Object.defineProperty(handle, 'readFile', {
      configurable: true,
      value: async () => {
        unboundedReadFileObserved = true;
        throw Object.assign(new Error('unbounded owner read invoked'), {
          code: 'unbounded_owner_read_invoked',
        });
      },
    });
    handle.read = async (...args) => {
      if (!positionalReadObserved) {
        positionalReadObserved = true;
        const beforeGrowth = await writer.stat();
        const growth = Buffer.alloc(1024, 0x78);
        await writer.write(growth, 0, growth.length, Number(beforeGrowth.size));
        await writer.sync();
      }
      return originalRead(...args);
    };
    return handle;
  };
  try {
    launched = await startIsolatedFixture({
      fixtureRoot: isolatedRoot,
      context: state.context,
      agent: 'owner-growth-fixture',
      testDelaySeam: await fixtureTestDelay(),
    });
  } catch (error) {
    rejection = error;
  } finally {
    fs.open = originalOpen;
    await writer.close();
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
  }

  assert.equal(unboundedReadFileObserved, false);
  assert.equal(positionalReadObserved, true);
  assert.equal(rejection?.code, 'isolated_fixture_ownership_mismatch');
});

test('dashboard restart refuses a modified immutable config without stopping the owned child', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-restart-cleanup-fixture-'),
  ));
  let launched;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });
  launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'restart-cleanup-fixture',
    testDelaySeam: await fixtureTestDelay(),
  });
  const stoppedPid = launched.pids.dashboard;
  const redirectedReady = path.join(launched.runtimeRoot, 'redirected-dashboard.ready.json');
  const config = JSON.parse(await fs.readFile(launched.dashboardConfigFile, 'utf8'));
  await fs.writeFile(launched.dashboardConfigFile, `${JSON.stringify({
    ...config,
    readyFile: redirectedReady,
  })}\n`);

  await assert.rejects(
    launched.restartDashboard({ readyTimeoutMs: 3_000 }),
    (error) => error.code === 'isolated_child_config_identity_mismatch',
  );
  assert.doesNotThrow(() => process.kill(stoppedPid, 0));
  await assert.rejects(fs.stat(redirectedReady), { code: 'ENOENT' });
  assert.equal(launched.pids.dashboard, stoppedPid);
});

test('isolated launcher exercises production query, pinned PGS, and lifecycle recovery', async (t) => {
  const {
    startIsolatedFixture,
    stopIsolatedFixture,
  } = await import('../../scripts/lib/isolated-brain-fixture.mjs');
  const { loadProductionModules } = await import('../../scripts/live-brain-tools-smoke.mjs');
  const modules = await loadProductionModules();
  const state = await receiptFixture();
  const isolatedRoot = await fs.realpath(await fs.mkdtemp(
    path.join(os.tmpdir(), 'home23-two-process-fixture-'),
  ));
  let launched;
  t.after(async () => {
    if (launched) await stopIsolatedFixture(launched).catch(() => {});
    await Promise.all([
      fs.rm(state.root, { recursive: true, force: true }),
      fs.rm(isolatedRoot, { recursive: true, force: true }),
    ]);
  });
  launched = await startIsolatedFixture({
    fixtureRoot: isolatedRoot,
    context: state.context,
    agent: 'acceptance-fixture',
    nodeCount: 600,
    edgeCount: 599,
    testDelaySeam: await fixtureTestDelay(500),
    pgsSynthesisIncomplete: true,
  });
  assert.notEqual(launched.pids.dashboard, launched.pids.cosmo);
  assert.ok(launched.ports.dashboard > 0 && launched.ports.cosmo > 0);
  assert.equal(path.isAbsolute(launched.runtimeRoot), true);
  assert.equal(path.relative(launched.fixtureRoot, launched.runtimeRoot).startsWith('..'), false);
  const dashboardConfig = JSON.parse(await fs.readFile(launched.dashboardConfigFile, 'utf8'));
  assert.equal(Object.hasOwn(dashboardConfig, 'capabilityKey'), false);
  assert.equal(dashboardConfig.capabilityKeyFile, launched.capabilityKeyFile);
  assert.equal((await fs.stat(launched.capabilityKeyFile)).mode & 0o777, 0o600);
  const client = new modules.BrainOperationsClient({
    baseUrl: launched.baseUrl,
    callerAgent: 'acceptance-fixture',
    queryWaitMs: 5_000,
    reconnectDelayMs: 10,
  });

  const initial = await client.query({ query: 'controlled production fixture query' });
  if (['queued', 'running'].includes(initial.state)) await client.resumeOperation(initial.operationId);
  const terminal = await awaitTerminal(client, initial);
  const workerTelemetry = await launched.operationTelemetry(terminal.operationId);
  assert.equal(terminal.state, 'complete', JSON.stringify({ terminal, workerTelemetry }));
  assert.match(terminal.result.answer, /production pinned query executor/);
  assert.equal(terminal.result.answerQuality.expansionAttempted, true);
  const delayTelemetry = (await launched.telemetry()).cosmo;
  assert.equal(delayTelemetry.providerDelayCompletions, 2);
  assert.deepEqual(
    delayTelemetry.providerDelayActions.slice(0, 2).map(({ providerCallId }) => providerCallId),
    ['query', 'query-expand'],
  );
  assert.equal(delayTelemetry.lastProviderDelay.configuredDelayMs, 3000);
  assert.equal(delayTelemetry.lastProviderDelay.effectiveDelayMs, 500);
  assert.equal(delayTelemetry.lastProviderDelay.testOnlyDelay, true);
  assert.equal(delayTelemetry.lastProviderDelay.outcome, 'complete');
  assert.equal(delayTelemetry.lastProviderDelay.actionProven, true);
  assert.ok(delayTelemetry.lastProviderDelay.elapsedMs >= 500);
  assert.ok(Date.parse(delayTelemetry.lastProviderDelay.completedAt)
    <= Date.parse(terminal.completedAt));

  const pgsInitial = await client.query({
    query: 'authoritative isolated canary',
    enablePGS: true,
    pgsMode: 'fresh',
    pgsLevel: 'full',
    pgsSweep: { provider: 'controlled', model: 'controlled-pgs' },
    pgsSynth: { provider: 'controlled', model: 'controlled-pgs' },
  });
  if (['queued', 'running'].includes(pgsInitial.state)) {
    await client.resumeOperation(pgsInitial.operationId);
  }
  const pgs = await awaitTerminal(client, pgsInitial);
  assert.equal(pgs.state, 'partial', JSON.stringify(pgs));
  assert.equal(pgs.error.code, 'provider_incomplete');
  assert.equal(pgs.result.sweepOutputs.length, 3);
  assert.equal(pgs.result.metadata.pgs.successfulSweeps, 3);
  assert.deepEqual(pgs.result.metadata.pgs.sourceTotals, {
    edges: 599, nodes: 600, workUnits: 3,
  });
  assert.equal(pgs.sourceEvidence.authoritativeTotals.nodes, 600);
  assert.equal(pgs.sourcePinDescriptor.summary.nodeCount, 600);
  assert.match(pgs.sourcePinDigest, /^sha256:[a-f0-9]{64}$/);
  const telemetry = await launched.telemetry();
  assert.equal(telemetry.cosmo.models['controlled-pgs'], 4);
  assert.equal(telemetry.dashboard.providerStarts, 0);

  const detachStart = await client.start('query', {
    query: 'controlled lifecycle detach acceptance', mode: 'quick',
  });
  const detachRunning = await awaitState(client, detachStart.operationId, ['running']);
  const disconnect = new AbortController();
  disconnect.abort(Object.assign(new Error('controlled transport drop'), {
    code: 'transport_disconnect',
  }));
  const detached = await client.wait(detachStart.operationId, {
    operationType: 'query', initial: detachRunning,
    signal: disconnect.signal, waitMs: 5_000,
  });
  assert.equal(detached.state, 'running');
  assert.equal(detached.attachmentState, 'detached');
  await client.resumeOperation(detachStart.operationId);
  assert.equal((await awaitTerminal(client, detachRunning)).state, 'complete');

  const cancelStart = await client.start('query', {
    query: 'controlled lifecycle cancel acceptance', mode: 'quick',
  });
  const cancelRunning = await awaitState(client, cancelStart.operationId, ['running']);
  const abortsBefore = (await launched.telemetry()).cosmo.providerAborts;
  await client.cancel(cancelStart.operationId);
  const cancelled = await awaitTerminal(client, cancelRunning);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.error.code, 'operation_cancelled');
  assert.equal((await launched.telemetry()).cosmo.providerAborts, abortsBefore + 1);

  const restartProviderStarts = (await launched.telemetry()).cosmo.providerStarts;
  const restartStart = await client.start('query', {
    query: 'controlled lifecycle restart acceptance', mode: 'quick',
  });
  await awaitState(client, restartStart.operationId, ['running']);
  await awaitProviderStart(launched, restartProviderStarts);
  const firstDashboardPid = launched.pids.dashboard;
  await launched.restartDashboard();
  assert.notEqual(launched.pids.dashboard, firstDashboardPid);
  assert.throws(() => process.kill(firstDashboardPid, 0), (error) => error.code === 'ESRCH');
  const reloaded = new modules.BrainOperationsClient({
    baseUrl: launched.baseUrl,
    callerAgent: 'acceptance-fixture',
  });
  let reconciled;
  try {
    reconciled = await reloaded.getOperation(restartStart.operationId);
  } catch (error) {
    const operationDirectory = path.join(
      launched.operationsRoot,
      'operations',
      restartStart.operationId,
    );
    const attachmentDirectory = path.join(operationDirectory, 'attachments');
    const attachments = await fs.readdir(attachmentDirectory).catch(() => []);
    const diagnostics = {
      error: { code: error.code, message: error.message },
      status: JSON.parse(await fs.readFile(path.join(operationDirectory, 'status.json'), 'utf8')),
      attachments: Object.fromEntries(await Promise.all(attachments.map(async (name) => [
        name,
        JSON.parse(await fs.readFile(path.join(attachmentDirectory, name), 'utf8')),
      ]))),
      worker: await launched.operationTelemetry(restartStart.operationId),
    };
    assert.fail(JSON.stringify(diagnostics));
  }
  assert.equal(reconciled.state, 'running');
  const resumed = await reloaded.resumeOperation(restartStart.operationId);
  assert.equal((await awaitTerminal(reloaded, resumed)).state, 'complete');
  assert.equal((await reloaded.inspectOperation(terminal.operationId, 'result')).state, 'complete');

  const coordinatorRestart = await launched.restartCoordinator();
  assert.equal(coordinatorRestart.coordinatorRestarts, 1);
  const synthesisResponse = await fetch(`${launched.baseUrl}/api/synthesis/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trigger: 'fixture-route-rebind' }),
  });
  const synthesisStart = await synthesisResponse.json();
  assert.equal(synthesisResponse.status, 202, JSON.stringify(synthesisStart));
  const synthesis = await awaitTerminal(reloaded, synthesisStart);
  assert.equal(synthesis.state, 'complete', JSON.stringify(synthesis));
  const synthesisStateResponse = await fetch(
    `${launched.baseUrl}/api/synthesis/state?generationMarker=${encodeURIComponent(
      synthesis.result.generationMarker,
    )}`,
  );
  const synthesisState = await synthesisStateResponse.json();
  assert.equal(synthesisStateResponse.status, 200, JSON.stringify(synthesisState));
  assert.equal(synthesisState.latestOperation.operationId, synthesis.operationId);
  assert.equal(synthesisState.currentGenerationMarker, synthesis.result.generationMarker);
  assert.equal(synthesisState.markerStatus, 'matched');

  const stopped = await stopIsolatedFixture(launched);
  assert.equal(stopped.retainedStore, launched.operationsRoot);
  assert.equal(launched.operationDelayEvidence.schemaVersion, 2);
  assert.equal(launched.operationDelayEvidence.configuredDelayMs, 3000);
  assert.equal(launched.operationDelayEvidence.effectiveDelayMs, 500);
  assert.equal(launched.operationDelayEvidence.testOnlyDelay, true);
  assert.equal(launched.operationDelayEvidence.capturedBeforeStop, true);
  assert.equal(Object.hasOwn(
    launched.operationDelayEvidence,
    'actionBeforeTerminalProven',
  ), false);
  assert.equal(Object.hasOwn(
    launched.operationDelayEvidence.roles.cosmo,
    'lastProviderDelay',
  ), false);
  assert.ok((await fs.stat(launched.operationsRoot)).isDirectory());
  for (const pid of [launched.pids.dashboard, launched.pids.cosmo]) {
    assert.throws(() => process.kill(pid, 0), (error) => error.code === 'ESRCH');
  }
  launched = null;
});
