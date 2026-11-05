import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const operationContextPath = require.resolve('../../shared/memory-source/operation-context.cjs');
const {
  createInstalledLocalSourceContext,
  withEphemeralMemorySource,
  withMemorySourceLock,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeManifestBrain() {
  const brain = await tempDir('home23-memory-source-context-brain-');
  const nodes = await writeJsonlGzAtomic(path.join(brain, 'nodes.gz'), [{ id: 1, concept: 'context canary' }]);
  const edges = await writeJsonlGzAtomic(path.join(brain, 'edges.gz'), []);
  await fsp.writeFile(path.join(brain, 'delta.jsonl'), '');
  await fsp.writeFile(path.join(brain, 'memory-manifest.json'), `${JSON.stringify({
    formatVersion: 1,
    generation: 'g1',
    baseRevision: 1,
    currentRevision: 1,
    activeDeltaEpoch: 'e0',
    activeBase: {
      nodes: { file: 'nodes.gz', count: 1, bytes: nodes.bytes },
      edges: { file: 'edges.gz', count: 0, bytes: edges.bytes },
    },
    activeDelta: { epoch: 'e0', file: 'delta.jsonl', fromRevision: 2, toRevision: 1, count: 0, committedBytes: 0 },
    ann: { indexFile: null, metaFile: null, builtFromRevision: 1 },
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, null, 2)}\n`);
  return brain;
}

async function writeLegacyBrain() {
  const brain = await tempDir('home23-memory-source-context-legacy-brain-');
  await writeJsonlGzAtomic(path.join(brain, 'memory-nodes.jsonl.gz'), [
    { id: 1, concept: 'legacy compatibility canary' },
  ]);
  await writeJsonlGzAtomic(path.join(brain, 'memory-edges.jsonl.gz'), []);
  await fsp.writeFile(path.join(brain, 'memory-delta.jsonl'), '');
  return brain;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate, attempts = 400) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
}

async function operationRoots(home23Root) {
  const instances = path.join(home23Root, 'instances');
  const agents = await fsp.readdir(instances, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const roots = [];
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const operations = path.join(instances, agent.name, 'runtime', 'brain-operations');
    const entries = await fsp.readdir(operations, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isDirectory()) roots.push(path.join(operations, entry.name));
    }
  }
  return roots.sort();
}

function waitForChildMessage(child, expectedType, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`child message timed out: ${expectedType}`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onMessage = (message) => {
      if (message?.type === 'error') {
        cleanup();
        reject(Object.assign(new Error(message.message), { code: message.code }));
      } else if (message?.type === expectedType) {
        cleanup();
        resolve(message);
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`child exited before ${expectedType}: ${code ?? signal}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function waitForChildExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('child exit timed out'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function collect(iterator) {
  const rows = [];
  for await (const row of iterator) rows.push(row);
  return rows;
}

test('withEphemeralMemorySource derives operation roots, opens source, and removes only operation scratch', async () => {
  const home23Root = await tempDir('home23-memory-source-context-home-');
  const brainDir = await writeManifestBrain();
  let captured;
  const concepts = await withEphemeralMemorySource({
    brainDir,
    home23Root,
    requesterAgent: 'jerry',
    identity: { brainId: 'jerry' },
    uuid: () => 'abc123',
  }, async (source, context) => {
    captured = context;
    return (await collect(source.iterateNodes())).map((node) => node.concept);
  });
  assert.deepEqual(concepts, ['context canary']);
  assert.equal(captured.operationId, 'local-abc123');
  const canonicalHome = await fsp.realpath(home23Root);
  assert.equal(captured.operationRoot.startsWith(path.join(canonicalHome, 'instances', 'jerry')), true);
  assert.equal(captured.lockRoot, path.join(canonicalHome, 'runtime', 'brain-source-locks'));
  assert.equal(await fsp.access(captured.operationRoot).then(() => true).catch(() => false), false);
  assert.equal(await fsp.access(brainDir).then(() => true).catch(() => false), true);
});

test('withEphemeralMemorySource removes owned operation scratch when quota construction aborts', async () => {
  const home23Root = await tempDir('home23-memory-source-context-abort-home-');
  const brainDir = await writeManifestBrain();
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop ephemeral quota construction'), {
    name: 'AbortError',
  });
  controller.abort(reason);
  const operationRoot = path.join(
    await fsp.realpath(home23Root),
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    'local-abort123',
  );
  try {
    await assert.rejects(
      () => withEphemeralMemorySource({
        brainDir,
        home23Root,
        requesterAgent: 'jerry',
        signal: controller.signal,
        uuid: () => 'abort123',
      }, async () => null),
      (error) => error === reason,
    );
    assert.equal(await fsp.access(operationRoot).then(() => true).catch(() => false), false);
  } finally {
    await fsp.rm(home23Root, { recursive: true, force: true });
    await fsp.rm(brainDir, { recursive: true, force: true });
  }
});

test('compatibility admission permits one mixed caller per canonical legacy source without contender scratch', async (t) => {
  const home23Root = await tempDir('home23-memory-source-admission-home-');
  const brainDir = await writeLegacyBrain();
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brainDir, { recursive: true, force: true }),
  ]));
  const held = deferred();
  let entered = 0;
  let active = 0;
  let maxActive = 0;
  let uuidCalls = 0;
  const settled = Array(16).fill(false);
  const calls = Array.from({ length: settled.length }, (_, index) => {
    const prefix = ['dashboard-source', 'mcp', 'cosmo-source'][index % 3];
    const requesterAgent = index % 2 === 0 ? 'jerry' : 'forrest';
    return withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent,
      prefix,
      identity: { callerToken: `caller-${index}` },
      uuid: () => {
        uuidCalls += 1;
        return `concurrent-${index}`;
      },
    }, async (_source, context) => {
      entered += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await held.promise;
        return {
          index,
          prefix,
          callerToken: context.identity.callerToken,
          operationId: context.operationId,
        };
      } finally {
        active -= 1;
      }
    }).then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    ).finally(() => {
      settled[index] = true;
    });
  });

  assert.equal(await waitFor(() => entered >= 1), true);
  const contendersSettled = await waitFor(
    () => settled.filter(Boolean).length === settled.length - 1,
  );
  let beforeReleaseError = null;
  try {
    assert.equal(contendersSettled, true, 'all non-admitted callers must fail without waiting');
    assert.equal(entered, 1);
    assert.equal(maxActive, 1);
    assert.equal(uuidCalls, 1, 'busy contenders must not allocate operation identities');
    const roots = await operationRoots(home23Root);
    assert.equal(roots.length, 1);
    assert.equal(
      await fsp.access(path.join(roots[0], 'source-projections')).then(() => true).catch(() => false),
      true,
    );
  } catch (error) {
    beforeReleaseError = error;
  } finally {
    held.resolve();
  }

  const outcomes = await Promise.all(calls);
  if (beforeReleaseError) throw beforeReleaseError;
  const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
  const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, settled.length - 1);
  assert.equal(fulfilled[0].value.callerToken, `caller-${fulfilled[0].value.index}`);
  assert.match(
    fulfilled[0].value.operationId,
    new RegExp(`^${fulfilled[0].value.prefix}-`),
  );
  assert.equal(rejected.every(({ error }) => (
    error.code === 'source_busy' && error.retryable === true
  )), true);
  assert.deepEqual(await operationRoots(home23Root), []);
});

test('manifest compatibility admission releases after open so long callbacks do not starve readers', async (t) => {
  const home23Root = await tempDir('home23-memory-source-native-admission-home-');
  const brainDir = await writeManifestBrain();
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brainDir, { recursive: true, force: true }),
  ]));
  const held = deferred();
  let entered = 0;
  const first = withEphemeralMemorySource({
    brainDir,
    home23Root,
    requesterAgent: 'jerry',
    prefix: 'mcp',
    uuid: () => 'native-holder',
  }, async (source) => {
    entered += 1;
    assert.equal(source.getEvidence().implementation, 'manifest-v1');
    await held.promise;
    return 'first';
  });
  assert.equal(await waitFor(() => entered === 1), true);

  const second = withEphemeralMemorySource({
    brainDir,
    home23Root,
    requesterAgent: 'forrest',
    prefix: 'dashboard-source',
    uuid: () => 'native-contender',
  }, async (source) => {
    entered += 1;
    assert.equal(source.getEvidence().implementation, 'manifest-v1');
    return 'second';
  });

  let overlapError = null;
  try {
    assert.equal(await waitFor(() => entered === 2), true,
      'a safely opened manifest callback must not retain compatibility admission');
    assert.equal((await operationRoots(home23Root)).length, 2);
    assert.equal(await second, 'second');
  } catch (error) {
    overlapError = error;
  } finally {
    held.resolve();
  }
  assert.equal(await first, 'first');
  if (overlapError) throw overlapError;
  assert.deepEqual(await operationRoots(home23Root), []);
});

test('manifest operation scratch is cleaned if admission release fails after open', async (t) => {
  const home23Root = await tempDir('home23-memory-source-native-release-failure-home-');
  const brainDir = await writeManifestBrain();
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brainDir, { recursive: true, force: true }),
  ]));
  let callbackCalls = 0;
  await assert.rejects(
    withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent: 'jerry',
      prefix: 'mcp',
      uuid: () => 'native-release-failure',
      _testHooks: {
        afterAdmissionLockReleased() {
          throw new Error('controlled admission release observer failure');
        },
      },
    }, async () => {
      callbackCalls += 1;
    }),
    error => error?.code === 'invalid_memory_source' && error?.sourceLockReleased === true,
  );
  assert.equal(callbackCalls, 0);
  assert.deepEqual(await operationRoots(home23Root), []);
});

test('compatibility admission rejects a second process before operation identity or scratch', async (t) => {
  const home23Root = await tempDir('home23-memory-source-cross-process-home-');
  const brainDir = await writeLegacyBrain();
  const childScript = `
    const { withEphemeralMemorySource } = require(${JSON.stringify(operationContextPath)});
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    process.on('message', (message) => {
      if (message?.type === 'release') release();
    });
    withEphemeralMemorySource({
      brainDir: ${JSON.stringify(brainDir)},
      home23Root: ${JSON.stringify(home23Root)},
      requesterAgent: 'jerry',
      prefix: 'dashboard-source',
      uuid: () => 'cross-process-holder',
    }, async (_source, context) => {
      process.send({ type: 'entered', operationRoot: context.operationRoot });
      await held;
    }).then(
      () => process.send({ type: 'released' }, () => process.exit(0)),
      (error) => process.send({
        type: 'error', code: error.code, message: error.message,
      }, () => process.exit(1)),
    );
  `;
  const child = spawn(process.execPath, ['-e', childScript], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitForChildExit(child).catch(() => {});
    await Promise.all([
      fsp.rm(home23Root, { recursive: true, force: true }),
      fsp.rm(brainDir, { recursive: true, force: true }),
    ]);
  });

  const entered = await waitForChildMessage(child, 'entered');
  assert.equal(
    await fsp.access(path.join(entered.operationRoot, 'source-projections'))
      .then(() => true).catch(() => false),
    true,
  );
  let uuidCalls = 0;
  await assert.rejects(
    () => withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent: 'forrest',
      prefix: 'mcp',
      uuid: () => {
        uuidCalls += 1;
        return 'cross-process-contender';
      },
    }, async () => assert.fail('cross-process contender must not open a source')),
    (error) => error.code === 'source_busy' && error.retryable === true,
  );
  assert.equal(uuidCalls, 0);
  const rootsWhileHeld = await operationRoots(home23Root);
  assert.equal(rootsWhileHeld.length, 1);
  assert.equal(await fsp.realpath(rootsWhileHeld[0]), await fsp.realpath(entered.operationRoot));

  const released = waitForChildMessage(child, 'released');
  const exited = waitForChildExit(child);
  child.send({ type: 'release' });
  await released;
  const exit = await exited;
  assert.equal(exit.code, 0, stderr);
  assert.deepEqual(await operationRoots(home23Root), []);
  assert.equal(await withEphemeralMemorySource({
    brainDir,
    home23Root,
    requesterAgent: 'jerry',
    prefix: 'dashboard-source',
    uuid: () => 'cross-process-recovered',
  }, async (_source, context) => context.operationId), 'dashboard-source-cross-process-recovered');
  assert.deepEqual(await operationRoots(home23Root), []);
});

test('compatibility admission preserves abort identity and releases after callback failure', async (t) => {
  const home23Root = await tempDir('home23-memory-source-admission-release-home-');
  const brainDir = await writeLegacyBrain();
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brainDir, { recursive: true, force: true }),
  ]));
  const held = deferred();
  let activeEntered = false;
  const active = withEphemeralMemorySource({
    brainDir,
    home23Root,
    requesterAgent: 'jerry',
    prefix: 'dashboard-source',
    uuid: () => 'active-release',
  }, async () => {
    activeEntered = true;
    await held.promise;
    return 'active-complete';
  });
  assert.equal(await waitFor(() => activeEntered), true);

  const controller = new AbortController();
  const abortReason = Object.assign(new Error('cancel exact contender'), {
    name: 'AbortError',
    code: 'cancelled',
  });
  controller.abort(abortReason);
  let abortedUuidCalls = 0;
  let busyUuidCalls = 0;
  let admissionError = null;
  try {
    await assert.rejects(
      () => withEphemeralMemorySource({
        brainDir,
        home23Root,
        requesterAgent: 'forrest',
        signal: controller.signal,
        prefix: 'mcp',
        uuid: () => {
          abortedUuidCalls += 1;
          return 'aborted-contender';
        },
      }, async () => assert.fail('aborted contender must never open a source')),
      (error) => error === abortReason,
    );
    assert.equal(abortedUuidCalls, 0);

    await assert.rejects(
      () => withEphemeralMemorySource({
        brainDir,
        home23Root,
        requesterAgent: 'forrest',
        prefix: 'cosmo-source',
        uuid: () => {
          busyUuidCalls += 1;
          return 'busy-contender';
        },
      }, async () => assert.fail('busy contender must never open a source')),
      (error) => error.code === 'source_busy' && error.retryable === true,
    );
    assert.equal(busyUuidCalls, 0);
  } catch (error) {
    admissionError = error;
  } finally {
    held.resolve();
  }
  assert.equal(await active, 'active-complete');
  if (admissionError) throw admissionError;
  assert.deepEqual(await operationRoots(home23Root), []);

  const failure = new Error('callback failed after projection');
  await assert.rejects(
    () => withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent: 'jerry',
      prefix: 'dashboard-source',
      uuid: () => 'failing-callback',
    }, async () => { throw failure; }),
    (error) => error === failure,
  );
  assert.deepEqual(await operationRoots(home23Root), []);
  assert.equal(await withEphemeralMemorySource({
    brainDir,
    home23Root,
    requesterAgent: 'jerry',
    prefix: 'dashboard-source',
    uuid: () => 'after-failure',
  }, async (_source, context) => context.identity.operationId), 'dashboard-source-after-failure');
  assert.deepEqual(await operationRoots(home23Root), []);
});

test('an admitted compatibility call returns the exact mid-operation abort reason', async (t) => {
  const home23Root = await tempDir('home23-memory-source-admitted-abort-home-');
  const brainDir = await writeLegacyBrain();
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brainDir, { recursive: true, force: true }),
  ]));
  const controller = new AbortController();
  const entered = deferred();
  const reason = Object.assign(new Error('cancel admitted compatibility source'), {
    name: 'AbortError',
    code: 'cancelled',
  });
  const active = withEphemeralMemorySource({
    brainDir,
    home23Root,
    requesterAgent: 'jerry',
    signal: controller.signal,
    prefix: 'dashboard-source',
    uuid: () => 'admitted-abort',
  }, async () => {
    entered.resolve();
    await new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
        once: true,
      });
    });
  });
  await entered.promise;
  controller.abort(reason);
  await assert.rejects(active, (error) => error === reason);
  assert.deepEqual(await operationRoots(home23Root), []);
});

test('compatibility admission remains independent for different canonical sources', async (t) => {
  const home23Root = await tempDir('home23-memory-source-admission-independent-home-');
  const brains = await Promise.all([writeLegacyBrain(), writeLegacyBrain()]);
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    ...brains.map((brain) => fsp.rm(brain, { recursive: true, force: true })),
  ]));
  const held = deferred();
  let entered = 0;
  const calls = brains.map((brainDir, index) => withEphemeralMemorySource({
    brainDir,
    home23Root,
    requesterAgent: 'jerry',
    prefix: 'dashboard-source',
    uuid: () => `independent-${index}`,
  }, async () => {
    entered += 1;
    await held.promise;
    return index;
  }));
  let beforeReleaseError = null;
  try {
    assert.equal(await waitFor(() => entered === 2), true);
    assert.equal((await operationRoots(home23Root)).length, 2);
  } catch (error) {
    beforeReleaseError = error;
  } finally {
    held.resolve();
  }
  assert.deepEqual(await Promise.all(calls), [0, 1]);
  if (beforeReleaseError) throw beforeReleaseError;
  assert.deepEqual(await operationRoots(home23Root), []);
});

test('ephemeral source never adopts or removes a pre-existing operation root', async (t) => {
  const home23Root = await tempDir('home23-memory-source-operation-owner-home-');
  const brainDir = await writeLegacyBrain();
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brainDir, { recursive: true, force: true }),
  ]));
  const operationRoot = path.join(
    await fsp.realpath(home23Root),
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    'dashboard-source-owned-collision',
  );
  await fsp.mkdir(operationRoot, { recursive: true });
  const sentinel = path.join(operationRoot, 'preserve-existing-owner.txt');
  await fsp.writeFile(sentinel, 'preserve me\n');

  let observed;
  try {
    await withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent: 'jerry',
      prefix: 'dashboard-source',
      uuid: () => 'owned-collision',
    }, async () => assert.fail('a pre-existing operation root must never be adopted'));
  } catch (error) {
    observed = error;
  }
  assert.equal(observed?.code, 'source_busy');
  assert.equal(observed?.retryable, true);
  assert.equal(await fsp.readFile(sentinel, 'utf8'), 'preserve me\n');
});

test('ephemeral source rejects a symlinked operation ancestor before crossing into the brain', async (t) => {
  const home23Root = await tempDir('home23-memory-source-operation-symlink-home-');
  const brainDir = await writeLegacyBrain();
  const divertedInstances = path.join(brainDir, 'diverted-instances');
  await fsp.mkdir(divertedInstances);
  await fsp.symlink(divertedInstances, path.join(home23Root, 'instances'), 'dir');
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brainDir, { recursive: true, force: true }),
  ]));
  let uuidCalls = 0;

  await assert.rejects(
    () => withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent: 'jerry',
      prefix: 'dashboard-source',
      uuid: () => {
        uuidCalls += 1;
        return 'symlink-crossing';
      },
    }, async () => assert.fail('symlinked operation ancestry must not open a source')),
    (error) => error.code === 'invalid_memory_source' && error.retryable === false,
  );
  assert.equal(uuidCalls, 0);
  assert.deepEqual(await fsp.readdir(divertedInstances), []);
  assert.equal((await fsp.lstat(path.join(home23Root, 'instances'))).isSymbolicLink(), true);
});

test('ephemeral cleanup preserves a replacement operation root and fails closed on turnover', async (t) => {
  const home23Root = await tempDir('home23-memory-source-operation-turnover-home-');
  const brainDir = await writeLegacyBrain();
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(brainDir, { recursive: true, force: true }),
  ]));
  let replacementRoot;
  const sentinelText = 'replacement owner survives\n';

  await assert.rejects(
    () => withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent: 'jerry',
      prefix: 'dashboard-source',
      uuid: () => 'cleanup-turnover',
      _testHooks: {
        async beforeOperationRootQuarantine({ operationRoot }) {
          replacementRoot = operationRoot;
          await fsp.rm(operationRoot, { recursive: true, force: true });
          await fsp.mkdir(operationRoot, { mode: 0o700 });
          await fsp.writeFile(path.join(operationRoot, 'replacement-owner.txt'), sentinelText);
        },
      },
    }, async () => 'callback-complete'),
    (error) => error.code === 'invalid_memory_source' && error.retryable === false,
  );
  assert.equal(
    await fsp.readFile(path.join(replacementRoot, 'replacement-owner.txt'), 'utf8'),
    sentinelText,
  );
});

test('ephemeral cleanup fails closed when its owned operation root is renamed away', async (t) => {
  const home23Root = await tempDir('home23-memory-source-operation-renamed-home-');
  const brainDir = await writeLegacyBrain();
  let renamedRoot;
  t.after(async () => {
    if (renamedRoot) await fsp.rm(renamedRoot, { recursive: true, force: true });
    await Promise.all([
      fsp.rm(home23Root, { recursive: true, force: true }),
      fsp.rm(brainDir, { recursive: true, force: true }),
    ]);
  });

  await assert.rejects(
    () => withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent: 'jerry',
      prefix: 'dashboard-source',
      uuid: () => 'cleanup-renamed-away',
      _testHooks: {
        async beforeOperationRootQuarantine({ operationRoot }) {
          renamedRoot = `${operationRoot}.external-owner`;
          await fsp.rename(operationRoot, renamedRoot);
        },
      },
    }, async () => 'callback-complete'),
    (error) => error.code === 'invalid_memory_source' && error.retryable === false,
  );
  assert.equal((await fsp.lstat(renamedRoot)).isDirectory(), true);
  assert.equal(
    await fsp.access(path.join(renamedRoot, 'source-projections'))
      .then(() => true).catch(() => false),
    true,
  );
});

test('local source contexts reject dot-segment requester and generated path components', async () => {
  const home23Root = await tempDir('home23-memory-source-context-safe-home-');
  const brainDir = await writeManifestBrain();
  for (const requesterAgent of ['.', '..']) {
    await assert.rejects(withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent,
      uuid: () => 'abc123',
    }, async () => null), { code: 'invalid_request' });
    assert.throws(() => createInstalledLocalSourceContext({
      home23Root,
      requesterAgent,
      brainDir,
    }), { code: 'invalid_request' });
  }
  for (const [prefix, uuid] of [['.', 'abc123'], ['local', '..']]) {
    await assert.rejects(withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent: 'jerry',
      prefix,
      uuid: () => uuid,
    }, async () => null), { code: 'invalid_request' });
  }
});

test('createInstalledLocalSourceContext rejects public selectors and resolves exact canonical root', async () => {
  const home23Root = await tempDir('home23-memory-source-context-home-');
  const brainDir = await writeManifestBrain();
  const context = createInstalledLocalSourceContext({
    home23Root,
    requesterAgent: 'jerry',
    brainDir,
    buildCatalog: async () => ({
      revision: 'catalog-1',
      entries: [{ target: { canonicalRoot: await fsp.realpath(brainDir), brainId: 'jerry', requesterAgent: 'jerry' } }],
    }),
  });
  const resolved = await context.resolveTargetContext();
  assert.equal(resolved.catalogRevision, 'catalog-1');
  assert.equal(resolved.accessMode, 'own');
  assert.equal(resolved.target.canonicalRoot, await fsp.realpath(brainDir));
  await assert.rejects(() => context.resolveTargetContext({ agent: 'other' }), { code: 'invalid_request' });
});

test('withMemorySourceLock uses an external lock root and leaves target tree unchanged', async () => {
  const brainDir = await writeManifestBrain();
  const home23Root = await tempDir('home23-memory-source-context-home-');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  const before = (await fsp.readdir(brainDir)).sort();
  const value = await withMemorySourceLock(brainDir, { lockRoot }, async () => {
    assert.equal((await fsp.readdir(lockRoot)).length, 1);
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual((await fsp.readdir(brainDir)).sort(), before);
  assert.deepEqual(await fsp.readdir(lockRoot), []);
});
