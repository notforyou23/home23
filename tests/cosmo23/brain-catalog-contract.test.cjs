const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const Ajv2020 = require('ajv/dist/2020');

const {
  buildCanonicalCatalog,
  inspectBrain,
  resolveBrainBySelector,
  resolveCanonicalTarget,
} = require('../../cosmo23/server/lib/brain-registry');

const REQUIRED_BOUNDARY_KINDS = [
  'brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency',
];

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'home23-brain-catalog-'));
}

async function writeState(brainRoot, nodeCount = 1) {
  await fsp.mkdir(brainRoot, { recursive: true });
  await fsp.writeFile(path.join(brainRoot, 'state.json'), JSON.stringify({
    cycleCount: 7,
    memory: {
      nodes: Array.from({ length: nodeCount }, (_, index) => ({ id: `n${index}` })),
      edges: [],
    },
  }));
}

async function writeResearchRun(runRoot, {
  status = 'ACTIVE',
  completedAt,
  owner = null,
  nodeCount = 2,
  completeMarker = false,
} = {}) {
  await writeState(runRoot, nodeCount);
  await fsp.mkdir(path.join(runRoot, 'plans'), { recursive: true });
  const plan = { status };
  if (completedAt !== undefined) plan.completedAt = completedAt;
  await fsp.writeFile(path.join(runRoot, 'plans', 'plan:main.json'), JSON.stringify(plan));
  if (owner !== null) {
    await fsp.writeFile(path.join(runRoot, 'run.json'), JSON.stringify({ owner }));
  }
  if (completeMarker) {
    await fsp.mkdir(path.join(runRoot, 'outputs'), { recursive: true });
    await fsp.writeFile(path.join(runRoot, 'outputs', '.complete'), 'complete');
  }
}

async function buildFixture() {
  const root = await makeTempDir();
  const instancesRoot = path.join(root, 'instances');
  const localRunsPath = path.join(root, 'runs');
  const referenceRunsPath = path.join(root, 'reference-runs');
  await Promise.all([
    fsp.mkdir(instancesRoot, { recursive: true }),
    fsp.mkdir(localRunsPath, { recursive: true }),
    fsp.mkdir(referenceRunsPath, { recursive: true }),
  ]);

  const residentBrainRoot = path.join(instancesRoot, 'jerry', 'brain');
  const forrestBrainRoot = path.join(instancesRoot, 'forrest', 'brain');
  const offlineBrainRoot = path.join(instancesRoot, 'offline', 'brain');
  await writeState(residentBrainRoot, 12);
  await writeState(forrestBrainRoot, 4);
  await fsp.mkdir(offlineBrainRoot, { recursive: true });

  const arbitraryBrainRoot = path.join(instancesRoot, 'not-configured', 'brain');
  await writeState(arbitraryBrainRoot, 99);

  const activeRunPath = path.join(localRunsPath, 'active-research');
  const stoppedActiveRunPath = path.join(localRunsPath, 'stopped-active');
  const completedRunPath = path.join(localRunsPath, 'completed-research');
  const markerOnlyRunPath = path.join(localRunsPath, 'marker-only');
  await writeResearchRun(activeRunPath, { status: 'ACTIVE', owner: 'jerry' });
  await writeResearchRun(stoppedActiveRunPath, { status: 'ACTIVE', owner: 'jerry' });
  await writeResearchRun(completedRunPath, {
    status: 'COMPLETED', completedAt: Date.UTC(2026, 6, 9), owner: 'researcher', nodeCount: 8,
  });
  await writeResearchRun(markerOnlyRunPath, {
    status: 'ACTIVE', owner: 'jerry', completeMarker: true,
  });

  const duplicateLocal = path.join(localRunsPath, 'duplicate');
  const duplicateReference = path.join(referenceRunsPath, 'duplicate');
  await writeResearchRun(duplicateLocal, {
    status: 'COMPLETED', completedAt: Date.UTC(2026, 6, 8), owner: 'alpha',
  });
  await writeResearchRun(duplicateReference, {
    status: 'COMPLETED', completedAt: Date.UTC(2026, 6, 7), owner: 'beta',
  });

  await fsp.symlink(residentBrainRoot, path.join(referenceRunsPath, 'jerry-symlink'));

  const modified = new Date('2026-07-09T00:00:00.000Z');
  for (const brainRoot of [residentBrainRoot, forrestBrainRoot, offlineBrainRoot]) {
    await fsp.utimes(brainRoot, modified, modified);
  }

  const options = {
    instancesRoot,
    localRunsPath,
    referenceRunsPaths: [referenceRunsPath],
    configuredAgentNames: ['jerry', 'forrest', 'offline'],
    activeRunPath,
  };
  return {
    root,
    options,
    residentBrainRoot,
    forrestBrainRoot,
    offlineBrainRoot,
    arbitraryBrainRoot,
    activeRunPath,
    stoppedActiveRunPath,
    completedRunPath,
    markerOnlyRunPath,
  };
}

test('canonical catalog deduplicates real roots and resolves only eligible canonical identities', async (t) => {
  assert.equal(typeof buildCanonicalCatalog, 'function');
  assert.equal(typeof resolveCanonicalTarget, 'function');
  const fixture = await buildFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));

  const catalog = await buildCanonicalCatalog(fixture.options);
  const catalogWithCallerBoundary = await buildCanonicalCatalog({
    ...fixture.options,
    mutationBoundaries: [{ kind: 'brain', path: '/caller/supplied/or/outside-root' }],
  });
  const rebuilt = await buildCanonicalCatalog(fixture.options);
  const realRoot = await fsp.realpath(fixture.residentBrainRoot);
  const forrestRoot = await fsp.realpath(fixture.forrestBrainRoot);
  const activeRoot = await fsp.realpath(fixture.activeRunPath);
  const stoppedActiveRoot = await fsp.realpath(fixture.stoppedActiveRunPath);
  const completedRoot = await fsp.realpath(fixture.completedRunPath);
  const markerOnlyRoot = await fsp.realpath(fixture.markerOnlyRunPath);
  const unavailableRoot = await fsp.realpath(fixture.offlineBrainRoot);

  assert.match(catalog.catalogRevision, /^[a-f0-9]{64}$/);
  assert.equal(rebuilt.catalogRevision, catalog.catalogRevision);
  assert.equal(catalog.brains.filter((brain) => brain.canonicalRoot === realRoot).length, 1);
  assert.equal(catalog.brains.some((brain) => brain.canonicalRoot === fixture.arbitraryBrainRoot), false);

  const resident = catalog.brains.find((brain) => brain.canonicalRoot === realRoot);
  const forrest = catalog.brains.find((brain) => brain.canonicalRoot === forrestRoot);
  const active = catalog.brains.find((brain) => brain.canonicalRoot === activeRoot);
  const stoppedActive = catalog.brains.find((brain) => brain.canonicalRoot === stoppedActiveRoot);
  const completed = catalog.brains.find((brain) => brain.canonicalRoot === completedRoot);
  const markerOnly = catalog.brains.find((brain) => brain.canonicalRoot === markerOnlyRoot);
  const unavailable = catalog.brains.find((brain) => brain.canonicalRoot === unavailableRoot);

  assert.ok(resident);
  assert.equal(resident.ownerAgent, 'jerry');
  assert.equal(resident.kind, 'resident');
  assert.equal(resident.lifecycle, 'resident');
  assert.equal(resident.nodeCount, 12);
  assert.equal(resident.modifiedAt, '2026-07-09T00:00:00.000Z');
  assert.equal(resident.route, `/api/brain/${encodeURIComponent(resident.id)}`);
  assert.equal(typeof resident.routeKey, 'string');
  assert.equal(resident.name, 'brain');
  assert.equal(resident.path, realRoot);
  assert.equal(resident.sourceLabel, 'jerry');
  assert.equal(resident.sourceType, 'home23-agent');
  assert.equal(typeof resident.modified, 'number');
  assert.equal(resident.nodes, 12);
  assert.equal(resident.edges, 0);
  assert.equal(resident.isActive, false);
  assert.equal(forrest.ownerAgent, 'forrest');
  assert.equal(active.lifecycle, 'active');
  assert.equal(stoppedActive.lifecycle, 'unavailable');
  assert.equal(completed.lifecycle, 'completed');
  assert.equal(markerOnly.lifecycle, 'unavailable', 'outputs/.complete is not completion authority');
  assert.equal(unavailable.ownerAgent, 'offline');
  assert.equal(unavailable.lifecycle, 'unavailable');

  assert.equal(resolveCanonicalTarget(catalog, 'jerry').id, resident.id);
  assert.equal(resolveCanonicalTarget(catalog, 'jerry', {}).id, resident.id);
  assert.equal(resolveCanonicalTarget(catalog, 'jerry', { agent: 'forrest' }).ownerAgent, 'forrest');
  assert.equal(resolveCanonicalTarget(catalog, 'jerry', { brainId: completed.id }).lifecycle, 'completed');
  const legacyAliasTarget = await resolveBrainBySelector(resident.routeKey, {
    ...fixture.options,
    canonicalCatalog: catalog,
  });
  assert.equal(await fsp.realpath(legacyAliasTarget.path), realRoot);
  assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { brainId: active.id }), /target_not_available/);
  assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { brainId: unavailable.id }), /target_not_available/);
  assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { brainId: 'brain-does-not-exist' }), /target_not_found/);
  assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { agent: 'does-not-exist' }), /target_not_found/);
  assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { agent: 'offline' }), /target_not_available/);
  assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { agent: 'jerry', brainId: forrest.id }), /target_mismatch/);
  assert.equal(catalog.brains.filter((brain) => brain.displayName === 'duplicate').length, 2);
  assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { name: 'duplicate' }), /invalid_request/);

  const duplicateOwnerCatalog = structuredClone(catalog);
  duplicateOwnerCatalog.brains.push({ ...structuredClone(forrest), id: 'brain-0000000000000000' });
  assert.throws(() => resolveCanonicalTarget(duplicateOwnerCatalog, 'jerry', { agent: 'forrest' }), /target_ambiguous/);
  assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { brainId: 23 }), /invalid_request/);
  assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { agent: '' }), /invalid_request/);
  assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', null), /invalid_request/);
  assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', []), /invalid_request/);
  assert.throws(() => resolveCanonicalTarget(catalog, '', {}), /invalid_request/);

  assert.deepEqual(resident.mutationBoundaries.map(({ kind }) => kind), REQUIRED_BOUNDARY_KINDS);
  assert.deepEqual(resident.mutationBoundaries.find(({ kind }) => kind === 'run'),
    { kind: 'run', path: realRoot });
  assert.deepEqual(resident.mutationBoundaries.find(({ kind }) => kind === 'brain'),
    { kind: 'brain', path: realRoot });
  assert.equal(catalog.brains.some((brain) => brain.mutationBoundaries.some(({ path: boundaryPath }) =>
    boundaryPath === '/caller/supplied/or/outside-root')), false);
  assert.equal(catalogWithCallerBoundary.brains.some((brain) => brain.mutationBoundaries.some(({ path: boundaryPath }) =>
    boundaryPath === '/caller/supplied/or/outside-root')), false);

  for (const brain of catalog.brains) {
    assert.deepEqual(new Set(brain.mutationBoundaries.map(({ kind }) => kind)), new Set(REQUIRED_BOUNDARY_KINDS));
    assert.equal(brain.mutationBoundaries.every(({ path: boundaryPath }) => path.isAbsolute(boundaryPath)), true);
  }

  await assert.rejects(buildCanonicalCatalog({
    ...fixture.options,
    configuredAgentNames: ['jerry', 'jerry'],
  }), /catalog_configuration_invalid/);
  await assert.rejects(buildCanonicalCatalog({
    ...fixture.options,
    configuredAgentNames: ['jerry', '../outside'],
  }), /catalog_configuration_invalid/);
  await assert.rejects(buildCanonicalCatalog({
    ...fixture.options,
    configuredAgentNames: ['Jerry'],
  }), /catalog_configuration_invalid/);
  await assert.rejects(buildCanonicalCatalog({
    ...fixture.options,
    configuredAgentNames: ['jerry_test'],
  }), /catalog_configuration_invalid/);
});

test('completion requires canonical COMPLETED plan status and a numeric completedAt', async (t) => {
  assert.equal(typeof buildCanonicalCatalog, 'function');
  const fixture = await buildFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const stringTimeRoot = path.join(fixture.options.localRunsPath, 'string-time');
  const nullTimeRoot = path.join(fixture.options.localRunsPath, 'null-time');
  await writeResearchRun(stringTimeRoot, { status: 'COMPLETED', completedAt: '1720483200000' });
  await writeResearchRun(nullTimeRoot, { status: 'COMPLETED', completedAt: null });

  const catalog = await buildCanonicalCatalog(fixture.options);
  const stringCanonicalRoot = await fsp.realpath(stringTimeRoot);
  const nullCanonicalRoot = await fsp.realpath(nullTimeRoot);
  assert.equal(catalog.brains.find((brain) => brain.canonicalRoot === stringCanonicalRoot).lifecycle, 'unavailable');
  assert.equal(catalog.brains.find((brain) => brain.canonicalRoot === nullCanonicalRoot).lifecycle, 'unavailable');
});

test('brain catalog schema requires exactly one absolute server-derived boundary of every kind', async (t) => {
  assert.equal(typeof buildCanonicalCatalog, 'function');
  const fixture = await buildFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const catalog = await buildCanonicalCatalog(fixture.options);
  const schema = JSON.parse(fsp.readFile
    ? await fsp.readFile(path.join(process.cwd(), 'contracts/schemas/brain-operations.schema.json'), 'utf8')
    : fs.readFileSync(path.join(process.cwd(), 'contracts/schemas/brain-operations.schema.json'), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true, formats: { 'date-time': true } });
  const validate = ajv.compile(schema);
  assert.equal(validate(catalog), true, ajv.errorsText(validate.errors));

  const expectInvalid = (mutate, label) => {
    const candidate = structuredClone(catalog);
    mutate(candidate.brains[0].mutationBoundaries);
    assert.equal(validate(candidate), false, label);
  };
  expectInvalid((boundaries) => boundaries.pop(), 'missing kind');
  expectInvalid((boundaries) => { boundaries[6] = { kind: 'brain', path: boundaries[6].path }; }, 'duplicate kind');
  expectInvalid((boundaries) => { boundaries[0].kind = 'unknown'; }, 'unknown kind');
  expectInvalid((boundaries) => { boundaries[0] = 'brain'; }, 'string member');
  expectInvalid((boundaries) => { boundaries[0].path = 'relative/brain'; }, 'relative path');
  expectInvalid((boundaries) => { boundaries[0].extra = true; }, 'extra property');
});

test('catalog inspection reports corrupt and oversized state summaries as unknown, never false zero', async (t) => {
  assert.equal(typeof inspectBrain, 'function');
  const root = await makeTempDir();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const corruptRoot = path.join(root, 'corrupt');
  const oversizedRoot = path.join(root, 'oversized');
  await Promise.all([
    fsp.mkdir(corruptRoot, { recursive: true }),
    fsp.mkdir(oversizedRoot, { recursive: true }),
  ]);
  await fsp.writeFile(path.join(corruptRoot, 'state.json'), '{not-json');
  await fsp.writeFile(path.join(oversizedRoot, 'state.json'), '{}');
  await fsp.truncate(path.join(oversizedRoot, 'state.json'), 20 * 1024 * 1024);

  for (const brainRoot of [corruptRoot, oversizedRoot]) {
    const brain = await inspectBrain(brainRoot);
    assert.equal(brain.hasState, true);
    assert.equal(brain.hasStateSummary, false);
    assert.equal(brain.nodes, null);
    assert.equal(brain.edges, null);
    assert.equal(brain.cycleCount, null);
  }
});

test('catalog rejects canonical-root and per-entry boundary symlink escapes', async (t) => {
  assert.equal(typeof buildCanonicalCatalog, 'function');
  const siblingFixture = await buildFixture();
  const siblingCache = path.join(siblingFixture.forrestBrainRoot, 'cache');
  await fsp.mkdir(siblingCache, { recursive: true });
  await fsp.symlink(siblingCache, path.join(siblingFixture.residentBrainRoot, 'cache'));
  t.after(() => fsp.rm(siblingFixture.root, { recursive: true, force: true }));
  await assert.rejects(
    buildCanonicalCatalog(siblingFixture.options),
    /catalog_boundary_invalid/,
    'a Jerry boundary cannot resolve into Forrest even though both are globally configured roots',
  );

  const danglingFixture = await buildFixture();
  t.after(() => fsp.rm(danglingFixture.root, { recursive: true, force: true }));
  const missingOutsideCache = path.join(danglingFixture.root, 'outside', 'missing-cache');
  await fsp.symlink(missingOutsideCache, path.join(danglingFixture.residentBrainRoot, 'cache'));
  await assert.rejects(
    buildCanonicalCatalog(danglingFixture.options),
    /catalog_boundary_invalid/,
    'a dangling boundary symlink must not fall back to its safe-looking lexical path',
  );

  const root = await makeTempDir();
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const instancesRoot = path.join(root, 'instances');
  const localRunsPath = path.join(root, 'runs');
  const outsideRun = path.join(root, 'outside', 'escaped-run');
  await Promise.all([
    fsp.mkdir(instancesRoot, { recursive: true }),
    fsp.mkdir(localRunsPath, { recursive: true }),
    writeResearchRun(outsideRun, {
      status: 'COMPLETED', completedAt: Date.UTC(2026, 6, 9), owner: 'outside',
    }),
  ]);
  await fsp.symlink(outsideRun, path.join(localRunsPath, 'escaped-run'));
  await assert.rejects(buildCanonicalCatalog({
    instancesRoot,
    localRunsPath,
    referenceRunsPaths: [],
    configuredAgentNames: [],
    activeRunPath: null,
  }), /catalog_boundary_invalid/);
});

test('shared legacy resolver rejects duplicate names but prefers canonical ids and unique route keys', async (t) => {
  const fixture = await buildFixture();
  t.after(() => fsp.rm(fixture.root, { recursive: true, force: true }));
  const catalog = await buildCanonicalCatalog(fixture.options);
  const duplicates = catalog.brains.filter((brain) => brain.name === 'duplicate');
  assert.equal(duplicates.length, 2);

  await assert.rejects(
    resolveBrainBySelector('duplicate', { ...fixture.options, canonicalCatalog: catalog }),
    (error) => error?.code === 'target_ambiguous' && error.message === 'target_ambiguous',
  );

  for (const entry of duplicates) {
    const byCanonicalId = await resolveBrainBySelector(entry.id, {
      ...fixture.options,
      canonicalCatalog: catalog,
    });
    assert.equal(await fsp.realpath(byCanonicalId.path), entry.canonicalRoot);

    const byLegacyRouteKey = await resolveBrainBySelector(entry.routeKey, {
      ...fixture.options,
      canonicalCatalog: catalog,
    });
    assert.equal(await fsp.realpath(byLegacyRouteKey.path), entry.canonicalRoot);
  }
});
