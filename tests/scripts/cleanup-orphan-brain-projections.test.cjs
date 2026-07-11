const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');

const SCRIPT = '../../scripts/cleanup-orphan-brain-projections.mjs';
const UUIDS = Object.freeze({
  jerry: '11111111-1111-4111-8111-111111111111',
  forrest: '22222222-2222-4222-8222-222222222222',
});

function owner(pid = 424242) {
  return {
    pid,
    processStartedAt: 100,
    handleId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    bootToken: 'boot-test',
    processStartToken: 'start-test',
  };
}

async function writeJson(filePath, value, mode = 0o600) {
  await fsp.writeFile(filePath, `${JSON.stringify(value)}\n`, { mode });
}

async function createCandidate(homeRoot, agent, {
  uuid = UUIDS[agent],
  pid = 424242,
  operationRoot,
  rootName = `dashboard-source-${uuid}`,
  lockCandidate,
  attempt = true,
} = {}) {
  const operationsRoot = path.join(homeRoot, 'instances', agent, 'runtime', 'brain-operations');
  const candidateRoot = path.join(operationsRoot, rootName);
  await fsp.mkdir(candidateRoot, { recursive: true, mode: 0o700 });
  await writeJson(path.join(candidateRoot, '.scratch-quota.json'), {
    version: 1,
    operationRoot: operationRoot || candidateRoot,
    maxBytes: 1024 * 1024,
    actualPrivateBytes: 7,
    claimedSinceReconcile: 0,
    reservations: {
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': {
        owner: owner(pid),
        kinds: { projection: 7 },
      },
    },
    usedBytes: 4096,
    updatedAt: 0,
  });
  if (attempt) {
    const attemptRoot = path.join(
      candidateRoot,
      'source-projections',
      `.attempt-${pid}-33333333-3333-4333-8333-333333333333`,
    );
    await fsp.mkdir(attemptRoot, { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(attemptRoot, 'memory-nodes.base.jsonl.gz'), 'projected', {
      mode: 0o600,
    });
  }
  if (lockCandidate === 'zero') {
    await fsp.writeFile(path.join(candidateRoot, '.scratch-quota.lock.candidate-stale'), '', {
      mode: 0o600,
    });
  }
  return candidateRoot;
}

async function createFixture(options = {}) {
  const requestedOuter = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-orphan-cleaner-'));
  const outer = await fsp.realpath(requestedOuter);
  const requestedHomeRoot = path.join(outer, 'home23');
  await fsp.mkdir(requestedHomeRoot, { mode: 0o700 });
  const homeRoot = await fsp.realpath(requestedHomeRoot);
  for (const agent of ['jerry', 'forrest']) {
    await fsp.mkdir(path.join(homeRoot, 'instances', agent, 'brain'), {
      recursive: true,
      mode: 0o700,
    });
    await fsp.writeFile(path.join(homeRoot, 'instances', agent, 'brain', 'memory-nodes.jsonl'),
      `${agent}-brain\n`, { mode: 0o600 });
    const operationsRoot = path.join(homeRoot, 'instances', agent, 'runtime', 'brain-operations');
    await fsp.mkdir(path.join(operationsRoot, 'operations', 'durable-op'), {
      recursive: true,
      mode: 0o700,
    });
    await fsp.writeFile(path.join(operationsRoot, 'operations', 'durable-op', 'status.json'),
      `${agent}-durable\n`, { mode: 0o600 });
  }
  const candidates = {};
  if (options.candidates !== false) {
    candidates.jerry = await createCandidate(homeRoot, 'jerry', options.jerry);
    candidates.forrest = await createCandidate(homeRoot, 'forrest', options.forrest);
  }
  const receiptPath = path.join(outer, 'receipts', 'cleanup.json');
  return { outer, homeRoot, candidates, receiptPath };
}

function stoppedPm2() {
  const ports = {
    jerry: { REALTIME_PORT: '5001', DASHBOARD_PORT: '5002', MCP_HTTP_PORT: '5003' },
    forrest: { REALTIME_PORT: '5011', DASHBOARD_PORT: '5012', MCP_HTTP_PORT: '5015' },
  };
  return [
    { name: 'home23-jerry', status: 'stopped', pid: 0, pm2_env: { env: { ...ports.jerry } } },
    { name: 'home23-jerry-dash', status: 'stopped', pid: 0, pm2_env: { env: { ...ports.jerry } } },
    { name: 'home23-forrest', status: 'stopped', pid: 0, pm2_env: { env: { ...ports.forrest } } },
    { name: 'home23-forrest-dash', status: 'stopped', pid: 0, pm2_env: { env: { ...ports.forrest } } },
  ];
}

function safeChecks(overrides = {}) {
  return {
    agents: ['jerry', 'forrest'],
    ports: [5001, 5002, 5003, 5011, 5012, 5015],
    protectedPorts: [],
    approvalActor: 'jtr',
    approvalText: 'Approved removal of the exact manifest-selected orphan projection roots.',
    approvalAt: '2026-07-11T12:00:00.000Z',
    getPm2States: async () => stoppedPm2(),
    inspectProcessOwner: async () => 'absent',
    inspectPid: async () => 'absent',
    checkOpenFileDescriptors: async () => ({ status: 'clear', open: [] }),
    inspectListeners: async () => [],
    inspectListenerProcess: async (pid) => ({
      bootToken: 'boot-test', processStartToken: `listener-start-${pid}`,
    }),
    getFilesystemStats: async () => ({
      blockSize: '4096',
      blocks: '100000',
      freeBlocks: '50000',
      availableBlocks: '49000',
      availableBytes: '200704000',
    }),
    ...overrides,
  };
}

async function digestPath(filePath) {
  const bytes = await fsp.readFile(filePath);
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

test('dry run selects only exact immediate dashboard-source UUID roots', async (t) => {
  const { preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const nearMiss = path.join(
    state.homeRoot,
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    'dashboard-source-not-a-uuid',
  );
  await fsp.mkdir(nearMiss, { mode: 0o700 });
  await fsp.writeFile(path.join(nearMiss, 'keep.txt'), 'keep', { mode: 0o600 });

  const result = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    ...safeChecks(),
  });

  assert.equal(result.status, 'dry_run');
  assert.match(result.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.approvalToken, `APPLY-ORPHAN-BRAIN-PROJECTIONS:${result.manifestSha256}`);
  assert.deepEqual(result.manifest.agents.map((entry) => entry.agent), ['forrest', 'jerry']);
  assert.deepEqual(
    result.manifest.agents.flatMap((entry) => entry.eligible.map((item) => item.name)).sort(),
    [`dashboard-source-${UUIDS.forrest}`, `dashboard-source-${UUIDS.jerry}`].sort(),
  );
  for (const agent of result.manifest.agents) {
    assert.ok(Array.isArray(agent.brain.tree.entries));
    assert.ok(agent.brain.tree.entries.length >= 2);
    assert.ok(agent.nonselected.every((entry) => Array.isArray(entry.tree.entries)));
  }
  assert.ok(result.manifest.agents.find((entry) => entry.agent === 'jerry')
    .nonselected.some((entry) => entry.name === 'dashboard-source-not-a-uuid'));
});

test('canonical home authority and explicit safe agent list cannot be redirected', async (t) => {
  const { preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));

  const alias = path.join(state.outer, 'home-alias');
  await fsp.symlink(state.homeRoot, alias);
  await assert.rejects(preflightOrphanBrainProjections({
    homeRoot: alias,
    ...safeChecks(),
  }), (error) => error.code === 'cleanup_home_root_not_canonical');
  await assert.rejects(preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    ...safeChecks({ agents: ['jerry', '../mallory'] }),
  }), (error) => error.code === 'cleanup_agent_not_authorized');
  await assert.rejects(preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    ...safeChecks({ agents: [] }),
  }), (error) => error.code === 'cleanup_agent_required');
});

test('live or unknown owners and open descriptors exclude only affected roots', async (t) => {
  const { preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture({
    jerry: { pid: 1111 },
    forrest: { pid: 2222 },
  });
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));

  const result = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    ...safeChecks({
      inspectProcessOwner: async ({ pid }) => (pid === 1111 ? 'alive' : 'absent'),
      inspectPid: async (pid) => (pid === 1111 ? 'alive' : 'absent'),
      checkOpenFileDescriptors: async ({ agent }) => (agent === 'forrest'
        ? { status: 'open', open: [{ pid: 9, fd: '4w' }] }
        : { status: 'clear', open: [] }),
    }),
  });

  assert.equal(result.manifest.agents.flatMap((entry) => entry.eligible).length, 0);
  const exclusions = result.manifest.agents.flatMap((entry) => entry.excluded);
  assert.ok(exclusions.some((entry) => entry.agent === 'jerry'
    && entry.reasons.includes('owner_alive')));
  assert.ok(exclusions.some((entry) => entry.agent === 'forrest'
    && entry.reasons.includes('open_file_descriptors')));
});

test('malformed metadata, external operationRoot, links, and hardlinks fail closed per root', async (t) => {
  const { preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const operationsRoot = path.dirname(state.candidates.jerry);
  const malformed = await createCandidate(state.homeRoot, 'jerry', {
    uuid: '44444444-4444-4444-8444-444444444444',
  });
  await fsp.writeFile(path.join(malformed, '.scratch-quota.json'), '{broken', { mode: 0o600 });
  const external = await createCandidate(state.homeRoot, 'jerry', {
    uuid: '55555555-5555-4555-8555-555555555555',
    operationRoot: '/tmp/not-this-operation',
  });
  const linked = await createCandidate(state.homeRoot, 'jerry', {
    uuid: '66666666-6666-4666-8666-666666666666',
  });
  await fsp.symlink('/tmp', path.join(linked, 'escape'));
  const hardlinked = await createCandidate(state.homeRoot, 'jerry', {
    uuid: '77777777-7777-4777-8777-777777777777',
  });
  const original = path.join(hardlinked, 'original');
  await fsp.writeFile(original, 'same inode', { mode: 0o600 });
  await fsp.link(original, path.join(hardlinked, 'second-name'));

  const result = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    ...safeChecks(),
  });
  const excluded = result.manifest.agents.find((entry) => entry.agent === 'jerry').excluded;
  assert.ok(excluded.find((entry) => entry.path === malformed)
    .reasons.includes('malformed_metadata'));
  assert.ok(excluded.find((entry) => entry.path === external)
    .reasons.includes('external_operation_root'));
  assert.ok(excluded.find((entry) => entry.path === linked)
    .reasons.includes('symlink_rejected'));
  assert.ok(excluded.find((entry) => entry.path === hardlinked)
    .reasons.includes('hardlink_rejected'));
  assert.ok((await fsp.readdir(operationsRoot)).includes(path.basename(malformed)));
});

test('zero-byte scratch lock candidate debris excludes that root as unknown metadata', async (t) => {
  const { preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture({ jerry: { lockCandidate: 'zero' } });
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));

  const result = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    ...safeChecks(),
  });
  const jerry = result.manifest.agents.find((entry) => entry.agent === 'jerry');
  assert.equal(jerry.eligible.length, 0);
  assert.ok(jerry.excluded[0].reasons.includes('malformed_metadata'));
  assert.equal((await fsp.lstat(state.candidates.jerry)).isDirectory(), true);
});

test('real numeric ledgers with empty reservations use attempt ownership and valid lock candidates', async (t) => {
  const { preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const ledgerPath = path.join(state.candidates.jerry, '.scratch-quota.json');
  const ledger = JSON.parse(await fsp.readFile(ledgerPath, 'utf8'));
  ledger.reservations = {};
  ledger.updatedAt = 1783766999589;
  await writeJson(ledgerPath, ledger);
  await writeJson(path.join(state.candidates.jerry, '.scratch-quota.lock.candidate-serialized'), {
    version: 1,
    operationRoot: state.candidates.jerry,
    maxBytes: ledger.maxBytes,
    owner: owner(424242),
    acquiredAt: 1783766999589,
  });

  const result = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    ...safeChecks(),
  });
  const jerry = result.manifest.agents.find((entry) => entry.agent === 'jerry');
  assert.equal(jerry.eligible.length, 1);
  assert.equal(jerry.excluded.length, 0);
});

test('the real crash-window lock and candidate hardlink pair stays conservatively excluded', async (t) => {
  const { preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const lockPath = path.join(state.candidates.jerry, '.scratch-quota.lock');
  const candidatePath = path.join(state.candidates.jerry, '.scratch-quota.lock.candidate-serialized');
  const ledger = JSON.parse(await fsp.readFile(path.join(state.candidates.jerry, '.scratch-quota.json')));
  await writeJson(lockPath, {
    version: 1,
    operationRoot: state.candidates.jerry,
    maxBytes: ledger.maxBytes,
    owner: owner(424242),
    acquiredAt: 1783766999589,
  });
  await fsp.link(lockPath, candidatePath);

  const result = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    ...safeChecks(),
  });
  const jerry = result.manifest.agents.find((entry) => entry.agent === 'jerry');
  assert.equal(jerry.eligible.length, 0);
  assert.ok(jerry.excluded[0].reasons.includes('hardlink_rejected'));
});

test('all four exact engine/dashboard PM2 rows must be stopped', async (t) => {
  const { preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const rows = stoppedPm2();
  rows.find((entry) => entry.name === 'home23-forrest-dash').status = 'online';
  rows.find((entry) => entry.name === 'home23-forrest-dash').pid = 123;

  await assert.rejects(preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    ...safeChecks({ getPm2States: async () => rows }),
  }), (error) => error.code === 'cleanup_pm2_not_stopped'
    && error.message.includes('home23-forrest-dash'));
});

test('explicit monitored ports equal the stopped PM2 env union and protected ports are disjoint', async (t) => {
  const { preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));

  await assert.rejects(preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    ...safeChecks({ ports: [5999] }),
  }), (error) => error.code === 'cleanup_ports_authority_mismatch');
  await assert.rejects(preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    ...safeChecks({ protectedPorts: [5002] }),
  }), (error) => error.code === 'cleanup_protected_port_overlap');

  const rows = stoppedPm2();
  rows.find((entry) => entry.name === 'home23-jerry-dash').pm2_env.env.DASHBOARD_PORT = '5099';
  await assert.rejects(preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    ...safeChecks({ getPm2States: async () => rows }),
  }), (error) => error.code === 'cleanup_pm2_port_authority_invalid');
});

test('an unaccounted listener blocks preflight and listener state is rechecked before every rename', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));

  await assert.rejects(preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    ...safeChecks({
      inspectListeners: async () => [{ port: 5002, pid: 91, command: 'node' }],
    }),
  }), (error) => error.code === 'cleanup_unaccounted_listener'
    && error.message.includes('5002'));

  let listenerChecks = 0;
  const checks = safeChecks({
    inspectListeners: async () => {
      listenerChecks += 1;
      return [];
    },
  });
  const preflight = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    ...checks,
  });
  const beforeApply = listenerChecks;
  await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
  });
  assert.equal(listenerChecks - beforeApply, 6,
    'fresh preflight, pre-rename and pre-remove checks, plus final gate');
});

test('a listener appearing after candidate hashing blocks the immediately pending rename', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  let listenerAppeared = false;
  const checks = safeChecks({
    inspectListeners: async () => (listenerAppeared
      ? [{ port: 5012, pid: 991, command: 'late-listener' }]
      : []),
  });
  const preflight = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    ...checks,
  });

  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
    _testHooks: {
      beforeQuarantineSafetyRecheck: async ({ agent }) => {
        if (agent === 'forrest') listenerAppeared = true;
      },
    },
  });

  assert.equal(result.status, 'partial');
  const forrest = result.results.find((entry) => entry.agent === 'forrest');
  assert.equal(forrest.status, 'not_removed');
  assert.equal(forrest.error.code, 'cleanup_unaccounted_listener');
  assert.equal((await fsp.lstat(state.candidates.forrest)).isDirectory(), true);
});

test('an explicitly protected listener is manifest-bound and cannot change identity before rename', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  let changed = false;
  const checks = safeChecks({
    protectedPorts: [5013],
    inspectListeners: async () => [{
      port: 5013,
      pid: 3214,
      command: 'protected-service',
    }],
    inspectListenerProcess: async () => ({
      bootToken: 'boot-test',
      processStartToken: changed ? 'replacement-start' : 'protected-start',
    }),
  });
  const preflight = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    ...checks,
  });
  assert.deepEqual(preflight.manifest.listeners, [{
    port: 5013,
    pid: 3214,
    command: 'protected-service',
    processIdentity: { bootToken: 'boot-test', processStartToken: 'protected-start' },
  }]);

  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
    _testHooks: {
      beforeQuarantineSafetyRecheck: async () => { changed = true; },
    },
  });
  assert.equal(result.status, 'partial');
  assert.ok(result.results.every((entry) => entry.error.code === 'cleanup_listener_inventory_changed'));
});

test('apply requires the captured manifest and its explicit digest-bound token', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const preflight = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    ...safeChecks(),
  });

  await assert.rejects(applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: 'yes',
    ...safeChecks(),
  }), (error) => error.code === 'cleanup_approval_token_invalid');
  await assert.rejects(applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    approvalToken: preflight.approvalToken,
    ...safeChecks(),
  }), (error) => error.code === 'cleanup_manifest_required');
  await assert.rejects(applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...safeChecks({ agents: ['jerry'], ports: [5001] }),
  }), (error) => error.code === 'cleanup_manifest_arguments_mismatch');
  assert.equal((await fsp.lstat(state.candidates.jerry)).isDirectory(), true);
});

test('apply requires bounded explicit approval actor, text, and timestamp and records them', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const checks = safeChecks();
  const preflight = await preflightOrphanBrainProjections({ homeRoot: state.homeRoot, ...checks });

  await assert.rejects(applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
    approvalActor: undefined,
  }), (error) => error.code === 'cleanup_approval_record_invalid');

  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
  });
  assert.deepEqual(result.approval, {
    actor: checks.approvalActor,
    text: checks.approvalText,
    approvedAt: checks.approvalAt,
  });
});

test('captured dry-run receipts are mode-bound, identity-bound, and checksum-verified', async (t) => {
  const { loadCapturedCleanupManifestReceipt } = await import(SCRIPT);
  const state = await createFixture({ candidates: false });
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const receipt = {
    schemaVersion: 1,
    kind: 'home23-orphan-brain-projection-cleanup',
    status: 'dry_run',
    manifest: { schemaVersion: 1 },
    manifestSha256: 'a'.repeat(64),
  };
  const bodyBytes = Buffer.from(`${JSON.stringify(receipt)}\n`);
  const complete = {
    ...receipt,
    receiptSha256: crypto.createHash('sha256').update(bodyBytes).digest('hex'),
  };
  const receiptPath = path.join(state.outer, 'captured.json');
  await fsp.writeFile(receiptPath, `${JSON.stringify(complete)}\n`, { mode: 0o600 });
  assert.deepEqual(await loadCapturedCleanupManifestReceipt(receiptPath), complete);

  await fsp.chmod(receiptPath, 0o644);
  await assert.rejects(loadCapturedCleanupManifestReceipt(receiptPath),
    (error) => error.code === 'cleanup_manifest_required');
  await fsp.chmod(receiptPath, 0o600);
  const tampered = { ...complete, manifestSha256: 'b'.repeat(64) };
  await fsp.writeFile(receiptPath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
  await assert.rejects(loadCapturedCleanupManifestReceipt(receiptPath),
    (error) => error.code === 'cleanup_manifest_checksum_invalid');
});

test('receipt writer refuses an oversized serialized receipt before creating its path', async (t) => {
  const { createCleanupReceiptWriter } = await import(SCRIPT);
  const state = await createFixture({ candidates: false });
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const writeReceipt = await createCleanupReceiptWriter(state.receiptPath, state.homeRoot, {
    maxBytes: 256,
  });

  await assert.rejects(writeReceipt({ payload: 'x'.repeat(1024) }),
    (error) => error.code === 'cleanup_receipt_too_large');
  await assert.rejects(fsp.lstat(state.receiptPath), { code: 'ENOENT' });
});

test('receipt writer rejects a same-mode replacement before publish readback', async (t) => {
  const { createCleanupReceiptWriter } = await import(SCRIPT);
  const state = await createFixture({ candidates: false });
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const writeReceipt = await createCleanupReceiptWriter(state.receiptPath, state.homeRoot, {
    afterPublishBeforeReadback: async ({ receiptPath }) => {
      await fsp.unlink(receiptPath);
      await fsp.writeFile(receiptPath, '{"replacement":true}\n', { mode: 0o600 });
    },
  });

  await assert.rejects(writeReceipt({ payload: 'bounded' }),
    (error) => error.code === 'cleanup_receipt_write_invalid');
});

test('apply writes in-progress receipt before mutation, removes exact roots, and preserves boundaries', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const jerryBrain = path.join(state.homeRoot, 'instances', 'jerry', 'brain', 'memory-nodes.jsonl');
  const durable = path.join(
    state.homeRoot,
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    'operations',
    'durable-op',
    'status.json',
  );
  const boundaryBefore = [await digestPath(jerryBrain), await digestPath(durable)];
  const preflight = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    ...safeChecks(),
  });
  let sawInProgress = false;

  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...safeChecks(),
    _testHooks: {
      beforeFirstMutation: async () => {
        const receipt = JSON.parse(await fsp.readFile(state.receiptPath, 'utf8'));
        sawInProgress = receipt.status === 'in_progress' && receipt.results.length === 0;
      },
    },
  });

  assert.equal(sawInProgress, true);
  assert.equal(result.status, 'completed');
  assert.equal(result.results.filter((entry) => entry.status === 'removed').length, 2);
  await assert.rejects(fsp.lstat(state.candidates.jerry), { code: 'ENOENT' });
  await assert.rejects(fsp.lstat(state.candidates.forrest), { code: 'ENOENT' });
  assert.deepEqual([await digestPath(jerryBrain), await digestPath(durable)], boundaryBefore);
  const receiptBytes = await fsp.readFile(state.receiptPath);
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  assert.equal(receipt.status, 'completed');
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.receiptSha256,
    crypto.createHash('sha256').update(`${JSON.stringify({ ...receipt, receiptSha256: undefined })}\n`)
      .digest('hex'));
  assert.equal((await fsp.stat(state.receiptPath)).mode & 0o777, 0o600);
});

test('apply receipt carries candidate bytes, statfs delta, explicit boundaries, and final runtime gates', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const statfsSamples = ['1000000', '900000', '5000000'];
  let statfsCalls = 0;
  const checks = safeChecks({
    getFilesystemStats: async () => ({
      blockSize: '4096',
      blocks: '100000',
      freeBlocks: '50000',
      availableBlocks: '49000',
      availableBytes: statfsSamples[Math.min(statfsCalls++, statfsSamples.length - 1)],
    }),
  });
  const preflight = await preflightOrphanBrainProjections({ homeRoot: state.homeRoot, ...checks });
  const candidates = preflight.manifest.agents.flatMap((agent) => agent.eligible);
  assert.ok(candidates.every((entry) => /^\d+$/.test(entry.logicalBytes)
    && /^\d+$/.test(entry.allocatedBytes)));

  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
  });

  assert.equal(result.candidateBytes.selected.count, 2);
  assert.equal(result.candidateBytes.removed.count, 2);
  assert.match(result.candidateBytes.removed.logicalBytes, /^\d+$/);
  assert.match(result.candidateBytes.removed.allocatedBytes, /^\d+$/);
  assert.equal(result.filesystemBefore.availableBytes, '900000');
  assert.equal(result.filesystemAfter.availableBytes, '5000000');
  assert.equal(result.filesystemAvailableDeltaBytes, '4100000');
  assert.ok(result.preservedBoundaries.length >= 2);
  assert.ok(result.preservedBoundaries.every((entry) => entry.before.treeSha256
    && entry.after.treeSha256 && entry.unchanged === true));
  assert.equal(result.finalRuntime.pm2.status, 'passed');
  assert.equal(result.finalRuntime.listeners.status, 'passed');
  assert.equal(result.finalRuntime.openFileDescriptors.status, 'passed');
  assert.equal(result.finalRuntime.openFileDescriptors.entries.length, 2);
});

test('apply refuses manifest drift before any quarantine rename', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const preflight = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    ...safeChecks(),
  });
  await fsp.appendFile(path.join(
    state.candidates.jerry,
    'source-projections',
    '.attempt-424242-33333333-3333-4333-8333-333333333333',
    'memory-nodes.base.jsonl.gz',
  ), 'drift');

  await assert.rejects(applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...safeChecks(),
  }), (error) => error.code === 'cleanup_manifest_drift');
  assert.equal((await fsp.lstat(state.candidates.jerry)).isDirectory(), true);
  assert.equal((await fsp.lstat(state.candidates.forrest)).isDirectory(), true);
});

test('post-rename identity drift is retained in quarantine and recorded as partial', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const preflight = await preflightOrphanBrainProjections({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    ...safeChecks(),
  });
  let changed = false;

  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    canonicalHomeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...safeChecks(),
    _testHooks: {
      afterQuarantineRename: async ({ agent, quarantinePath }) => {
        if (agent === 'forrest' && !changed) {
          changed = true;
          await fsp.appendFile(path.join(
            quarantinePath,
            'source-projections',
            '.attempt-424242-33333333-3333-4333-8333-333333333333',
            'memory-nodes.base.jsonl.gz',
          ), 'late-drift');
        }
      },
    },
  });

  assert.equal(result.status, 'partial');
  const retained = result.results.find((entry) => entry.agent === 'forrest');
  assert.equal(retained.status, 'quarantined_not_removed');
  assert.equal((await fsp.lstat(retained.quarantinePath)).isDirectory(), true);
  assert.equal((await fsp.stat(state.receiptPath)).mode & 0o777, 0o600);
});

test('exclusive quarantine container refuses a child destination race without overwriting it', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const checks = safeChecks();
  const preflight = await preflightOrphanBrainProjections({ homeRoot: state.homeRoot, ...checks });
  let racedDestination = null;

  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
    _testHooks: {
      afterQuarantineContainerCreated: async ({ agent, destinationPath }) => {
        if (agent !== 'forrest') return;
        racedDestination = destinationPath;
        await fsp.mkdir(destinationPath, { mode: 0o700 });
        await fsp.writeFile(path.join(destinationPath, 'do-not-overwrite'), 'preserve', { mode: 0o600 });
      },
    },
  });

  assert.equal(result.status, 'partial');
  const forrest = result.results.find((entry) => entry.agent === 'forrest');
  assert.equal(forrest.status, 'not_removed');
  assert.equal(forrest.error.code, 'cleanup_quarantine_destination_exists');
  assert.equal(await fsp.readFile(path.join(racedDestination, 'do-not-overwrite'), 'utf8'), 'preserve');
  assert.equal((await fsp.lstat(state.candidates.forrest)).isDirectory(), true);
});

test('a failure after confirmed removal is reported as removed postcondition failure', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const checks = safeChecks();
  const preflight = await preflightOrphanBrainProjections({ homeRoot: state.homeRoot, ...checks });

  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
    _testHooks: {
      afterQuarantineRemoval: async ({ agent }) => {
        if (agent === 'forrest') throw Object.assign(new Error('post removal failure'), {
          code: 'post_remove_test_failure',
        });
      },
    },
  });

  assert.equal(result.status, 'partial');
  const forrest = result.results.find((entry) => entry.agent === 'forrest');
  assert.equal(forrest.status, 'removed_postcondition_failed');
  assert.equal(forrest.error.code, 'post_remove_test_failure');
  await assert.rejects(fsp.lstat(state.candidates.forrest), { code: 'ENOENT' });
  await assert.rejects(fsp.lstat(forrest.quarantinePath), { code: 'ENOENT' });
  assert.equal(result.candidateBytes.removed.count, 2);
});

test('a post-removal receipt failure leaves a durable pending intent instead of false rollback evidence', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  const checks = safeChecks();
  const preflight = await preflightOrphanBrainProjections({ homeRoot: state.homeRoot, ...checks });

  await assert.rejects(applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
    _testHooks: {
      beforeProgressReceipt: async ({ phase, agent }) => {
        if (phase === 'after_candidate' && agent === 'forrest') {
          throw Object.assign(new Error('receipt storage unavailable'), {
            code: 'receipt_storage_test_failure',
          });
        }
      },
    },
  }), (error) => error.code === 'receipt_storage_test_failure');

  const durable = JSON.parse(await fsp.readFile(state.receiptPath, 'utf8'));
  assert.equal(durable.status, 'in_progress');
  assert.equal(durable.results.length, 1);
  assert.equal(durable.results[0].agent, 'forrest');
  assert.equal(durable.results[0].status, 'pending');
  await assert.rejects(fsp.lstat(state.candidates.forrest), { code: 'ENOENT' });
});

test('final runtime gate records a listener that appears after the last removal', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  t.after(() => fsp.rm(state.outer, { recursive: true, force: true }));
  let finalGate = false;
  const checks = safeChecks({
    inspectListeners: async () => (finalGate
      ? [{ port: 5002, pid: 8080, command: 'late-dashboard' }]
      : []),
  });
  const preflight = await preflightOrphanBrainProjections({ homeRoot: state.homeRoot, ...checks });

  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
    _testHooks: {
      beforeFinalRuntimeGates: async () => { finalGate = true; },
    },
  });

  assert.equal(result.status, 'partial');
  assert.equal(result.finalRuntime.listeners.status, 'failed');
  assert.equal(result.finalRuntime.listeners.error.code, 'cleanup_unaccounted_listener');
});

test('final FD gate treats an unreadable remaining candidate as unknown, never absent', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture({ jerry: { lockCandidate: 'zero' } });
  const jerryOperations = path.dirname(state.candidates.jerry);
  t.after(async () => {
    await fsp.chmod(jerryOperations, 0o700).catch(() => {});
    await fsp.rm(state.outer, { recursive: true, force: true });
  });
  const checks = safeChecks();
  const preflight = await preflightOrphanBrainProjections({ homeRoot: state.homeRoot, ...checks });

  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
    _testHooks: {
      beforeFinalRuntimeGates: async () => { await fsp.chmod(jerryOperations, 0o000); },
    },
  });
  await fsp.chmod(jerryOperations, 0o700);

  assert.equal(result.status, 'partial');
  const jerryFd = result.finalRuntime.openFileDescriptors.entries.find((entry) =>
    entry.agent === 'jerry');
  assert.equal(jerryFd.status, 'unknown');
});

test('an unreadable quarantine is never reported as removed', async (t) => {
  const { applyOrphanBrainProjectionCleanup, preflightOrphanBrainProjections } = await import(SCRIPT);
  const state = await createFixture();
  let unreadableContainer = null;
  t.after(async () => {
    if (unreadableContainer) await fsp.chmod(unreadableContainer, 0o700).catch(() => {});
    await fsp.rm(state.outer, { recursive: true, force: true });
  });
  const checks = safeChecks();
  const preflight = await preflightOrphanBrainProjections({ homeRoot: state.homeRoot, ...checks });

  const result = await applyOrphanBrainProjectionCleanup({
    homeRoot: state.homeRoot,
    receiptPath: state.receiptPath,
    capturedManifest: preflight.manifest,
    capturedManifestSha256: preflight.manifestSha256,
    approvalToken: preflight.approvalToken,
    ...checks,
    _testHooks: {
      afterQuarantineRename: async ({ agent, quarantinePath }) => {
        if (agent !== 'forrest') return;
        unreadableContainer = path.dirname(quarantinePath);
        await fsp.chmod(unreadableContainer, 0o000);
      },
    },
  });

  const forrest = result.results.find((entry) => entry.agent === 'forrest');
  assert.equal(result.status, 'partial');
  assert.equal(forrest.status, 'removal_state_unknown');
  assert.equal(result.candidateBytes.removed.count, 1);
  await fsp.chmod(unreadableContainer, 0o700);
  assert.equal((await fsp.lstat(forrest.quarantinePath)).isDirectory(), true);
});
