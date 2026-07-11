'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  CANONICAL_RUN_METADATA_BASENAME,
  MAX_RUN_METADATA_BYTES,
  loadCanonicalRunMetadata,
  writeCanonicalRunMetadataAtomic,
} = require('../../cosmo23/server/lib/research-run-metadata');

function hasCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

async function makeFixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const fixtureRoot = await fs.mkdtemp(path.join(temporaryRoot, 'home23-run-metadata-'));
  t.after(() => fs.rm(fixtureRoot, { recursive: true, force: true }));
  const runRoot = path.join(fixtureRoot, 'research-run-1');
  await fs.mkdir(runRoot);
  return {
    fixtureRoot,
    runRoot,
    metadataPath: path.join(runRoot, CANONICAL_RUN_METADATA_BASENAME),
  };
}

function record(runRoot, overrides = {}) {
  return {
    version: 1,
    runId: 'research-run-1',
    ownerAgent: 'jerry',
    operationId: 'brop_0123456789abcdef0123456789abcdef',
    canonicalRoot: runRoot,
    topic: 'Verify the canonical research evidence chain.',
    parameters: { cycles: 8, topic: 'Verify the canonical research evidence chain.' },
    state: 'starting',
    createdAt: '2026-07-10T12:00:00.000Z',
    updatedAt: '2026-07-10T12:00:00.000Z',
    ...overrides,
  };
}

test('writes and reloads one bounded canonical regular metadata file atomically', async (t) => {
  const fixture = await makeFixture(t);
  const input = record(fixture.runRoot);

  await writeCanonicalRunMetadataAtomic(fixture.runRoot, input);
  const loaded = await loadCanonicalRunMetadata(fixture.runRoot);

  assert.deepEqual(loaded, input);
  assert.notEqual(loaded, input);
  assert.deepEqual(await fs.readdir(fixture.runRoot), [CANONICAL_RUN_METADATA_BASENAME]);
  const stat = await fs.lstat(fixture.metadataPath);
  assert.equal(stat.isFile(), true);
  assert.equal(stat.isSymbolicLink(), false);
  assert.equal(stat.nlink, 1);
  assert.equal(stat.mode & 0o777, 0o600);
  const raw = await fs.readFile(fixture.metadataPath, 'utf8');
  assert.equal(raw.endsWith('\n'), true);
  assert.equal(raw.indexOf('"canonicalRoot"') < raw.indexOf('"createdAt"'), true);
});

test('rename publication replaces an existing regular file without leaving staging files', async (t) => {
  const fixture = await makeFixture(t);
  await writeCanonicalRunMetadataAtomic(fixture.runRoot, record(fixture.runRoot));
  const before = await fs.lstat(fixture.metadataPath);

  await writeCanonicalRunMetadataAtomic(fixture.runRoot, record(fixture.runRoot, {
    state: 'active',
    startedAt: '2026-07-10T12:01:00.000Z',
    updatedAt: '2026-07-10T12:01:00.000Z',
  }));

  const after = await fs.lstat(fixture.metadataPath);
  assert.notEqual(after.ino, before.ino);
  assert.equal((await loadCanonicalRunMetadata(fixture.runRoot)).state, 'active');
  assert.deepEqual(await fs.readdir(fixture.runRoot), [CANONICAL_RUN_METADATA_BASENAME]);
});

test('missing canonical metadata preserves ENOENT for adapter discovery', async (t) => {
  const fixture = await makeFixture(t);
  await assert.rejects(
    loadCanonicalRunMetadata(fixture.runRoot),
    (error) => error?.code === 'ENOENT',
  );
});

test('rejects a symlinked run root or metadata path without touching the external file', async (t) => {
  const fixture = await makeFixture(t);
  const externalRoot = path.join(fixture.fixtureRoot, 'external');
  const externalFile = path.join(externalRoot, 'outside.json');
  await fs.mkdir(externalRoot);
  await fs.writeFile(externalFile, '{"outside":true}\n');

  const linkedRoot = path.join(fixture.fixtureRoot, 'linked-run');
  await fs.symlink(fixture.runRoot, linkedRoot, 'dir');
  await assert.rejects(
    writeCanonicalRunMetadataAtomic(linkedRoot, record(fixture.runRoot)),
    hasCode('run_metadata_boundary_invalid'),
  );

  await fs.symlink(externalFile, fixture.metadataPath);
  await assert.rejects(
    loadCanonicalRunMetadata(fixture.runRoot),
    hasCode('run_metadata_boundary_invalid'),
  );
  await assert.rejects(
    writeCanonicalRunMetadataAtomic(fixture.runRoot, record(fixture.runRoot)),
    hasCode('run_metadata_boundary_invalid'),
  );
  assert.equal(await fs.readFile(externalFile, 'utf8'), '{"outside":true}\n');
});

test('rejects hard-linked and non-regular metadata destinations', async (t) => {
  const linked = await makeFixture(t);
  const external = path.join(linked.fixtureRoot, 'external.json');
  await fs.writeFile(external, '{"outside":true}\n');
  await fs.link(external, linked.metadataPath);
  await assert.rejects(
    loadCanonicalRunMetadata(linked.runRoot),
    hasCode('run_metadata_boundary_invalid'),
  );
  await assert.rejects(
    writeCanonicalRunMetadataAtomic(linked.runRoot, record(linked.runRoot)),
    hasCode('run_metadata_boundary_invalid'),
  );

  const directory = await makeFixture(t);
  await fs.mkdir(directory.metadataPath);
  await assert.rejects(
    loadCanonicalRunMetadata(directory.runRoot),
    hasCode('run_metadata_boundary_invalid'),
  );
});

test('enforces the byte limit on both writes and externally supplied reads', async (t) => {
  const fixture = await makeFixture(t);
  const original = record(fixture.runRoot);
  await writeCanonicalRunMetadataAtomic(fixture.runRoot, original);

  await assert.rejects(
    writeCanonicalRunMetadataAtomic(fixture.runRoot, record(fixture.runRoot, {
      topic: 'x'.repeat(MAX_RUN_METADATA_BYTES),
    })),
    hasCode('run_metadata_too_large'),
  );
  assert.deepEqual(await loadCanonicalRunMetadata(fixture.runRoot), original);

  await fs.writeFile(fixture.metadataPath, Buffer.alloc(MAX_RUN_METADATA_BYTES + 1, 0x20));
  await assert.rejects(
    loadCanonicalRunMetadata(fixture.runRoot),
    hasCode('run_metadata_too_large'),
  );
});

test('rejects malformed or unsafe JSON and noncanonical root paths', async (t) => {
  const fixture = await makeFixture(t);
  await fs.writeFile(fixture.metadataPath, '{not-json}\n');
  await assert.rejects(
    loadCanonicalRunMetadata(fixture.runRoot),
    hasCode('run_metadata_invalid'),
  );

  await fs.writeFile(fixture.metadataPath, '{"__proto__":{"polluted":true}}\n');
  await assert.rejects(
    loadCanonicalRunMetadata(fixture.runRoot),
    hasCode('run_metadata_invalid'),
  );

  const noncanonical = `${fixture.runRoot}${path.sep}..${path.sep}${path.basename(fixture.runRoot)}`;
  await assert.rejects(
    loadCanonicalRunMetadata(noncanonical),
    hasCode('invalid_request'),
  );
  await assert.rejects(
    writeCanonicalRunMetadataAtomic('relative/run', record(fixture.runRoot)),
    hasCode('invalid_request'),
  );
});
