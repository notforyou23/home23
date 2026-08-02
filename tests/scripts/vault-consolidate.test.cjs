'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { consolidate, uniqueName } = require('../../scripts/vault/consolidate.cjs');

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-consol-')));
  const srcA = path.join(root, 'srcA', 'voice');
  const srcB = path.join(root, 'srcB', 'voice');
  fs.mkdirSync(srcA, { recursive: true });
  fs.mkdirSync(srcB, { recursive: true });
  fs.writeFileSync(path.join(srcA, 'v1.md'), 'same content');
  fs.writeFileSync(path.join(srcB, 'v1.md'), 'same content');
  fs.writeFileSync(path.join(srcA, 'v2.md'), 'different content');
  return { root, sources: [path.join(root, 'srcA'), path.join(root, 'srcB')], vault: path.join(root, 'vault') };
}

test('copies documents into type folders and never mutates the source', () => {
  const { sources, vault } = fixture();
  const r = consolidate({ sources, vaultRoot: vault });
  assert.ok(fs.existsSync(path.join(vault, 'voice', 'v2.md')));
  assert.equal(fs.readFileSync(path.join(sources[0], 'voice', 'v2.md'), 'utf8'), 'different content');
  assert.equal(r.copied, 2);
});

test('identical content is stored once with both origins recorded', () => {
  const { sources, vault } = fixture();
  const r = consolidate({ sources, vaultRoot: vault });
  assert.equal(r.deduped, 1);
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, 'vault-manifest.json'), 'utf8'));
  const entry = Object.values(manifest.entries).find((e) => e.origins.length === 2);
  assert.equal(entry.origins.length, 2);
});

test('is idempotent -- a second run copies nothing new', () => {
  const { sources, vault } = fixture();
  consolidate({ sources, vaultRoot: vault });
  const second = consolidate({ sources, vaultRoot: vault });
  assert.equal(second.copied, 0);
});

test('skips excluded trees', () => {
  const { sources, vault } = fixture();
  const nm = path.join(sources[0], 'node_modules', 'pkg');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'README.md'), 'npm garbage');
  const r = consolidate({ sources, vaultRoot: vault });
  assert.equal(fs.existsSync(path.join(vault, 'notes', 'README.md')), false);
  assert.equal(r.skippedExcluded >= 1, true);
});

test('every scanned document is accounted for -- copied + deduped === scanned', () => {
  const { sources, vault } = fixture();
  const r = consolidate({ sources, vaultRoot: vault });
  assert.equal(r.copied + r.deduped, r.scanned);
});

// --- Step 5 mutation-testing additions -------------------------------------

test('idempotent rerun does not duplicate origins in the manifest', () => {
  const { sources, vault } = fixture();
  consolidate({ sources, vaultRoot: vault });
  consolidate({ sources, vaultRoot: vault });
  consolidate({ sources, vaultRoot: vault });
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, 'vault-manifest.json'), 'utf8'));
  for (const entry of Object.values(manifest.entries)) {
    const unique = new Set(entry.origins);
    assert.equal(unique.size, entry.origins.length, `origins grew duplicates: ${JSON.stringify(entry.origins)}`);
  }
  const dupEntry = Object.values(manifest.entries).find((e) => e.origins.length === 2);
  assert.ok(dupEntry, 'expected the two-origin entry to still exist after repeated runs');
});

test('directory-level exclusion and file-level exclusion are counted separately', () => {
  const { sources, vault } = fixture();
  const nm = path.join(sources[0], 'node_modules', 'pkg');
  fs.mkdirSync(nm, { recursive: true });
  fs.writeFileSync(path.join(nm, 'README.md'), 'npm garbage');
  // A vault-paths.isExcluded() hit: coordinator "nothing happened" record.
  const coordDir = path.join(sources[0], 'engine', 'runtime', 'coordinator');
  fs.mkdirSync(coordDir, { recursive: true });
  fs.writeFileSync(path.join(coordDir, 'review.md'), 'Thoughts Analyzed: 0');
  const r = consolidate({ sources, vaultRoot: vault });
  assert.ok(r.skippedExcludedDirs >= 1, 'expected at least one pruned directory subtree');
  assert.ok(r.skippedExcludedFiles >= 1, 'expected at least one file-level exclusion');
  assert.equal(r.skippedExcluded, r.skippedExcludedDirs + r.skippedExcludedFiles);
});

test('an unreadable directory is a loud failure, not a silent drop', () => {
  const { sources, vault } = fixture();
  const locked = path.join(sources[0], 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, 'secret.md'), 'cannot read this');
  fs.chmodSync(locked, 0o000);
  try {
    assert.throws(() => consolidate({ sources, vaultRoot: vault }), /unreadable|EACCES|permission/i);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

// NOTE ON THE TWO TESTS BELOW: prior to Task 6, a same-basename/
// different-content collision crashed consolidate() (VaultManifest.record()
// threw). These two tests originally asserted exactly that crash. Task 6's
// entire purpose is to stop that crash from happening -- collisions now
// resolve to a deterministic suffixed name instead (see uniqueName() in
// consolidate.cjs) -- so the old assertions ("this throws /collision/i") now
// directly contradict the feature this task implements. They are rewritten
// here to verify the corrected behavior instead of being left in place
// asserting behavior that would now be a bug. The second test's "does a
// mid-run crash still save partial progress" intent is preserved using a
// genuine crash trigger (an unreadable directory) instead of the no-longer-
// crashing basename collision.

test('a filename collision (same type folder, same basename, different content) gets a deterministic suffix instead of crashing or dropping data', () => {
  const { sources, vault } = fixture();
  const notesA = path.join(sources[0], 'notes');
  const notesB = path.join(sources[1], 'notes');
  fs.mkdirSync(notesA, { recursive: true });
  fs.mkdirSync(notesB, { recursive: true });
  fs.writeFileSync(path.join(notesA, 'dup.md'), 'first content');
  fs.writeFileSync(path.join(notesB, 'dup.md'), 'second, different content');
  const r = consolidate({ sources, vaultRoot: vault });
  const files = fs.readdirSync(path.join(vault, 'notes')).filter((f) => f.startsWith('dup'));
  assert.equal(files.length, 2, `expected both dup.md variants to survive under distinct names, got ${JSON.stringify(files)}`);
  const bodies = files.map((f) => fs.readFileSync(path.join(vault, 'notes', f), 'utf8')).sort();
  assert.deepEqual(bodies, ['first content', 'second, different content']);
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, 'vault-manifest.json'), 'utf8'));
  const dupEntries = Object.entries(manifest.entries).filter(([p]) => path.basename(p).startsWith('dup'));
  assert.equal(dupEntries.length, 2, 'manifest must record both distinct dup.md contents at distinct vault paths');
  assert.notEqual(dupEntries[0][1].sha256, dupEntries[1][1].sha256);
  assert.ok(r.copied >= 2);
});

test('a mid-run crash (unreadable directory) still saves the manifest for everything recorded before the crash', () => {
  const { sources, vault } = fixture();
  const locked = path.join(sources[1], 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, 'secret.md'), 'cannot read this');
  fs.chmodSync(locked, 0o000);
  try {
    assert.throws(() => consolidate({ sources, vaultRoot: vault }), /unreadable|EACCES|permission/i);
    const manifestPath = path.join(vault, 'vault-manifest.json');
    assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist even after a mid-run crash');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    // srcA's readable files (voice/v1.md, voice/v2.md) and srcB's readable
    // voice/v1.md must all have been recorded before the readErrors crash
    // fires at the end of the scan.
    assert.ok(
      Object.keys(manifest.entries).length >= 2,
      `expected the readable files to be recorded before the crash, got ${Object.keys(manifest.entries).length} entries`
    );
    assert.ok(manifest.entries['voice/v1.md']);
    assert.ok(manifest.entries['voice/v2.md']);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

test('a symlinked document is copied, not silently skipped', () => {
  const { sources, vault } = fixture();
  const notesDir = path.join(sources[0], 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, 'real.md'), 'symlink target content');
  fs.symlinkSync(path.join(notesDir, 'real.md'), path.join(notesDir, 'link.md'));
  const r = consolidate({ sources, vaultRoot: vault });
  assert.ok(fs.existsSync(path.join(vault, 'notes', 'link.md')), 'symlinked file should have been copied under its own name');
  assert.equal(
    fs.readFileSync(path.join(vault, 'notes', 'link.md'), 'utf8'),
    'symlink target content'
  );
  // Fixture already contributes 3 scanned files (v1.md x2, v2.md); this test
  // adds real.md and link.md on top of that -- both must be counted.
  assert.equal(r.scanned, 5, 'real.md and link.md should both be counted as scanned, on top of the 3 fixture files');
});

// --- The vault must never become its own provenance ------------------------

test('refuses a vault inside a source -- the vault must never become its own provenance', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-inside-')));
  const src = path.join(root, 'life', 'voice');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'aaa');
  assert.throws(
    () => consolidate({ sources: [path.join(root, 'life')], vaultRoot: path.join(root, 'life', 'vault') }),
    /inside --source|inside a source/i,
  );
});

test('refuses a vault inside a source even when the vault directory already exists', () => {
  // The pre-created case is the DANGEROUS one, not a milder variant: walk()
  // is a lazy generator, so a vault dir that exists when its parent is read
  // gets descended into after the copies land in it -- corrupting provenance
  // within a single run. Measured before the guard: one run produced
  // {"copied":2,"deduped":2,"scanned":4} with origins including the vault's
  // own copies. `mkdir -p <vault>` first is the most natural thing a person
  // does, so this must be refused just as hard as the not-yet-created case.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-inside-pre-')));
  const src = path.join(root, 'life', 'voice');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'aaa');
  fs.mkdirSync(path.join(root, 'life', 'vault'), { recursive: true });
  assert.throws(
    () => consolidate({ sources: [path.join(root, 'life')], vaultRoot: path.join(root, 'life', 'vault') }),
    /inside --source|inside a source/i,
  );
});

test('refuses a vault that IS a source directory', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-equals-')));
  const life = path.join(root, 'life');
  fs.mkdirSync(path.join(life, 'voice'), { recursive: true });
  fs.writeFileSync(path.join(life, 'voice', 'a.md'), 'aaa');
  assert.throws(
    () => consolidate({ sources: [life], vaultRoot: life }),
    /same directory as --source/i,
  );
});

test('refuses a source inside the vault -- the reverse direction is the same circularity', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'src-inside-')));
  const vault = path.join(root, 'vault');
  const src = path.join(vault, 'notes');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.md'), 'aaa');
  assert.throws(
    () => consolidate({ sources: [src], vaultRoot: vault }),
    /inside --vault/i,
  );
});

test('a vault that merely shares a path PREFIX with a source is allowed', () => {
  // /Users/jtr/vault must NOT be rejected because /Users/jtr/vault-old is a
  // source, and vice versa. A naive startsWith() without the separator would
  // false-positive here and refuse the real, correct layout. This is the
  // real-world shape: /Users/jtr/vault is a SIBLING of /Users/jtr/life.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-prefix-')));
  const src = path.join(root, 'vault-old');
  fs.mkdirSync(path.join(src, 'voice'), { recursive: true });
  fs.writeFileSync(path.join(src, 'voice', 'a.md'), 'aaa');
  const vault = path.join(root, 'vault'); // strict string prefix of 'vault-old'
  const r = consolidate({ sources: [src], vaultRoot: vault });
  assert.equal(r.copied, 1);
  assert.ok(fs.existsSync(path.join(vault, 'voice', 'a.md')));
});

test('a source that merely shares a path PREFIX with the vault is allowed (reverse direction)', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-prefix2-')));
  const src = path.join(root, 'vault'); // strict string prefix of 'vault-new'
  fs.mkdirSync(path.join(src, 'voice'), { recursive: true });
  fs.writeFileSync(path.join(src, 'voice', 'a.md'), 'aaa');
  const vault = path.join(root, 'vault-new');
  const r = consolidate({ sources: [src], vaultRoot: vault });
  assert.equal(r.copied, 1);
});

test('a vault nested in a source via a SYMLINKED ancestor is still refused', () => {
  // A purely lexical guard is bypassable: on macOS /tmp is a symlink to
  // /private/tmp, so `--vault /tmp/x/vault --source /private/tmp/x` looks
  // disjoint as text while walk() -- which traverses real directories --
  // descends from the source straight into the vault.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-symlink-')));
  const real = path.join(root, 'real');
  fs.mkdirSync(path.join(real, 'voice'), { recursive: true });
  fs.writeFileSync(path.join(real, 'voice', 'a.md'), 'aaa');
  const aliasRoot = path.join(root, 'alias');
  fs.symlinkSync(real, aliasRoot); // aliasRoot -> real
  // Source given by its real path; vault given through the symlinked alias.
  // Lexically disjoint ('/root/real' vs '/root/alias/vault'); actually nested.
  assert.throws(
    () => consolidate({ sources: [real], vaultRoot: path.join(aliasRoot, 'vault') }),
    /inside --source|inside a source/i,
  );
});

test('trailing separators do not defeat the disjointness guard', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-trailing-')));
  const src = path.join(root, 'life');
  fs.mkdirSync(path.join(src, 'voice'), { recursive: true });
  fs.writeFileSync(path.join(src, 'voice', 'a.md'), 'aaa');
  assert.throws(
    () => consolidate({ sources: [`${src}${path.sep}`], vaultRoot: path.join(src, 'vault') }),
    /inside --source|inside a source/i,
  );
});

// --- Case-folded vault paths must match the bytes on disk -------------------

test('a case-folded self-heal records the manifest key that actually exists on disk', () => {
  // Precondition (narrow but real): the manifest is lost while the vault
  // files remain, and the incoming document is a case-variant sibling with
  // identical content. uniqueName()'s filesystem fallback matches
  // case-insensitively on APFS and hands back the INCOMING basename, so the
  // manifest would record notes/SUMMARY.md for a file really named
  // notes/summary.md -- invisible here, broken the day the vault reaches ext4.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-case-')));
  const srcA = path.join(root, 'srcA', 'notes');
  const srcB = path.join(root, 'srcB', 'notes');
  fs.mkdirSync(srcA, { recursive: true });
  fs.mkdirSync(srcB, { recursive: true });
  fs.writeFileSync(path.join(srcA, 'summary.md'), 'identical');
  fs.writeFileSync(path.join(srcB, 'SUMMARY.md'), 'identical');
  const vault = path.join(root, 'vault');

  consolidate({ sources: [path.join(root, 'srcA')], vaultRoot: vault });
  fs.rmSync(path.join(vault, 'vault-manifest.json')); // manifest loss
  // Only the case-variant source: forces the fs fallback in slotAcceptsContent.
  consolidate({ sources: [path.join(root, 'srcB')], vaultRoot: vault });

  const manifest = JSON.parse(fs.readFileSync(path.join(vault, 'vault-manifest.json'), 'utf8'));
  const dirents = fs.readdirSync(path.join(vault, 'notes'));
  for (const key of Object.keys(manifest.entries)) {
    assert.ok(
      dirents.includes(path.basename(key)),
      `manifest key ${JSON.stringify(key)} does not exist on disk (dirents: ${JSON.stringify(dirents)}) ` +
      `-- it would fail to resolve on a case-sensitive filesystem`,
    );
  }
});

// --- Explicit mutation-catchers (from Step 5 instructions) -----------------

test('mutation guard: dedup count must reflect actual duplicate content', () => {
  const { sources, vault } = fixture();
  const r = consolidate({ sources, vaultRoot: vault });
  // A mutant that drops `stats.deduped += 1` would report deduped === 0 here.
  assert.equal(r.deduped, 1);
  assert.notEqual(r.deduped, 0);
});

test('mutation guard: manifest.record must run on the dedupe path too', () => {
  const { sources, vault } = fixture();
  consolidate({ sources, vaultRoot: vault });
  const manifest = JSON.parse(fs.readFileSync(path.join(vault, 'vault-manifest.json'), 'utf8'));
  const entries = Object.values(manifest.entries);
  // A mutant that skips manifest.record() on the dedupe path would leave the
  // duplicate's vault entry with only 1 origin instead of 2.
  const twoOrigin = entries.filter((e) => e.origins.length === 2);
  assert.equal(twoOrigin.length, 1);
});

test('regression: manifest loss with vault files still on disk does not break the accounting invariant', () => {
  // Found via mutation testing: a first-sighting hash whose vault target
  // already exists (e.g. the manifest.json was lost/reset but the copied
  // files under vault/<type>/ were not) must still be counted as either
  // copied or deduped -- never silently dropped from the invariant.
  const { sources, vault } = fixture();
  consolidate({ sources, vaultRoot: vault });
  fs.rmSync(path.join(vault, 'vault-manifest.json'));
  const r = consolidate({ sources, vaultRoot: vault });
  assert.equal(r.copied + r.deduped, r.scanned, 'invariant must hold even after manifest loss');
  assert.equal(r.copied, 0, 'no bytes should be recopied when the vault target already holds correct content');
});

test('mutation guard: walk must actually descend into nested source directories', () => {
  const { sources, vault } = fixture();
  const deep = path.join(sources[0], 'notes', 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, 'buried.md'), 'deep content');
  const r = consolidate({ sources, vaultRoot: vault });
  // A mutant where walk silently returns early (e.g. only reads top-level
  // entries) would never find this file.
  assert.ok(fs.existsSync(path.join(vault, 'notes', 'buried.md')));
  assert.ok(r.scanned >= 4);
});

// --- Task 6: same-basename, different-content collisions -------------------

test('different content with the same basename never overwrites or silently drops', () => {
  const { sources, vault } = fixture();
  fs.writeFileSync(path.join(sources[1], 'voice', 'v2.md'), 'DIFFERENT content, same name');
  const r = consolidate({ sources, vaultRoot: vault });
  assert.equal(r.copied, 3);
  const files = fs.readdirSync(path.join(vault, 'voice')).sort();
  assert.equal(files.length, 3);
  const bodies = files.map((f) => fs.readFileSync(path.join(vault, 'voice', f), 'utf8')).sort();
  assert.deepEqual(bodies, ['DIFFERENT content, same name', 'different content', 'same content']);
});

test('collision suffixes are deterministic -- reruns are still idempotent', () => {
  const { sources, vault } = fixture();
  fs.writeFileSync(path.join(sources[1], 'voice', 'v2.md'), 'DIFFERENT content, same name');
  consolidate({ sources, vaultRoot: vault });
  const first = fs.readdirSync(path.join(vault, 'voice')).sort();
  const second = consolidate({ sources, vaultRoot: vault });
  assert.equal(second.copied, 0);
  assert.deepEqual(fs.readdirSync(path.join(vault, 'voice')).sort(), first);
});

test('a third distinct file with the same basename also survives', () => {
  const { root, sources, vault } = fixture();
  const srcC = path.join(root, 'srcC', 'voice');
  fs.mkdirSync(srcC, { recursive: true });
  fs.writeFileSync(path.join(sources[1], 'voice', 'v2.md'), 'second variant');
  fs.writeFileSync(path.join(srcC, 'v2.md'), 'third variant');
  const r = consolidate({ sources: [...sources, path.join(root, 'srcC')], vaultRoot: vault });
  assert.equal(r.copied, 4);
  assert.equal(fs.readdirSync(path.join(vault, 'voice')).length, 4);
});

test('mutation guard: the collision suffix is a pure function of content, not of run history or process state', () => {
  // The idempotency test above ("collision suffixes are deterministic")
  // reruns consolidate() against the SAME vault, so the second run never
  // calls uniqueName() at all -- every hash is already seeded in the
  // manifest and takes the dedup branch. That proves names are STABLE
  // across reruns, but not that the suffix algorithm itself is a pure
  // function of content. A module-level counter would pass that test
  // (nothing re-derives names once seeded) while still being non-
  // deterministic in the way that matters: two independent people (or two
  // fresh runs after the vault was wiped) processing the identical
  // collision must land on the identical filename, not on whatever a
  // shared mutable counter happened to be at. This drives two entirely
  // separate, freshly-seeded vaults from the same source collision and
  // requires them to agree.
  const { sources, vault: vaultOne } = fixture();
  fs.writeFileSync(path.join(sources[1], 'voice', 'v2.md'), 'DIFFERENT content, same name');
  consolidate({ sources, vaultRoot: vaultOne });

  const vaultTwo = path.join(path.dirname(vaultOne), 'vault-independent-rerun');
  consolidate({ sources, vaultRoot: vaultTwo });

  assert.deepEqual(
    fs.readdirSync(path.join(vaultOne, 'voice')).sort(),
    fs.readdirSync(path.join(vaultTwo, 'voice')).sort(),
    'two independent fresh vaults built from the same collision must assign the same suffixed name'
  );
});

// --- Dangling symlinks are not read errors ---------------------------------
//
// EACCES on a directory means "there are files here I cannot see" -- possible
// mass silent loss, must throw. ENOENT on a symlink means "there is
// definitively nothing here" -- a link to a target that does not exist holds
// no content, so nothing can be lost by skipping it. Conflating the two made
// the real run throw at the very end over 3 broken links, one pointing at
// /home/jtr/... (a Linux path on a Mac: it has never resolved and never will).

test('a dangling symlink is counted, not treated as an unreadable path', () => {
  const { sources, vault } = fixture();
  const notes = path.join(sources[0], 'notes');
  fs.mkdirSync(notes, { recursive: true });
  // (a) dangling symlink with a DOC extension
  fs.symlinkSync(path.join(notes, 'gone.md'), path.join(notes, 'broken-doc.md'));
  // (b) dangling symlink with a NON-doc extension (the real corpus has
  //     jobs.json -> /home/jtr/.openclaw/cron/jobs.json)
  fs.symlinkSync('/home/jtr/.openclaw/cron/jobs.json', path.join(notes, 'jobs.json'));
  // (c) a VALID symlinked document, which must still be consolidated
  fs.writeFileSync(path.join(notes, 'real.md'), 'live target content');
  fs.symlinkSync(path.join(notes, 'real.md'), path.join(notes, 'link.md'));

  const r = consolidate({ sources, vaultRoot: vault });

  assert.equal(r.readErrors.length, 0, 'a dangling link is not a read error');
  assert.equal(r.danglingSymlinks.length, 2, 'both broken links must be counted, not swallowed');
  const reported = r.danglingSymlinks.map((d) => path.basename(d.path)).sort();
  assert.deepEqual(reported, ['broken-doc.md', 'jobs.json']);
  // the dangling links are visible, with what they pointed at
  assert.ok(r.danglingSymlinks.every((d) => typeof d.target === 'string' && d.target.length > 0));
  // the valid symlinked document still lands in the vault
  assert.equal(fs.readFileSync(path.join(vault, 'notes', 'link.md'), 'utf8'), 'live target content');
  assert.equal(r.copied + r.deduped, r.scanned);
});

test('a dangling symlink does not make the run throw', () => {
  const { sources, vault } = fixture();
  const notes = path.join(sources[0], 'notes');
  fs.mkdirSync(notes, { recursive: true });
  fs.symlinkSync('/nonexistent/target/somewhere.md', path.join(notes, 'broken.md'));
  // Must not throw -- this is the acceptance criterion for the real run.
  const r = consolidate({ sources, vaultRoot: vault });
  assert.equal(r.danglingSymlinks.length, 1);
});

test('a symlink that fails to stat with EACCES (not ENOENT) still throws -- the carve-out is ENOENT-only', () => {
  // Found by mutation testing: a mutant that swallowed EVERY symlink stat
  // error as "dangling" passed the whole suite, because the other EACCES
  // test locks a DIRECTORY and so fails inside readdirSync -- never reaching
  // the symlink catch block at all. This exercises the symlink catch with a
  // non-ENOENT error specifically. The link itself resolves fine; the
  // TARGET's parent directory is unreadable, so statSync() cannot traverse
  // to it and reports EACCES. That means "a document may be here and I
  // cannot see it" -- it must never be mistaken for "nothing is here".
  const { root, sources, vault } = fixture();
  const vaultOutside = path.join(root, 'locked-target-dir');
  fs.mkdirSync(vaultOutside, { recursive: true });
  fs.writeFileSync(path.join(vaultOutside, 'hidden.md'), 'a real document behind a permissions wall');
  const notes = path.join(sources[0], 'notes');
  fs.mkdirSync(notes, { recursive: true });
  fs.symlinkSync(path.join(vaultOutside, 'hidden.md'), path.join(notes, 'points-at-locked.md'));
  fs.chmodSync(vaultOutside, 0o000);
  try {
    let err;
    try { consolidate({ sources, vaultRoot: vault }); } catch (e) { err = e; }
    assert.ok(err, 'an EACCES symlink must make the run fail loudly, not be silently skipped');
    assert.match(err.message, /unreadable|EACCES|permission/i);
    assert.ok(
      (err.partialStats.danglingSymlinks || []).every((d) => !d.path.endsWith('points-at-locked.md')),
      'an EACCES symlink must NOT be recorded as merely dangling'
    );
  } finally {
    fs.chmodSync(vaultOutside, 0o755);
  }
});

test('a genuine EACCES directory STILL throws even when dangling symlinks are present', () => {
  // The dangling-symlink carve-out must not become a hole in the loud-failure
  // guard: a permissions blip that hides thousands of files must still stop
  // the run.
  const { sources, vault } = fixture();
  const notes = path.join(sources[0], 'notes');
  fs.mkdirSync(notes, { recursive: true });
  fs.symlinkSync('/nonexistent/target/somewhere.md', path.join(notes, 'broken.md'));
  const locked = path.join(sources[0], 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(locked, 'secret.md'), 'cannot read this');
  fs.chmodSync(locked, 0o000);
  try {
    assert.throws(() => consolidate({ sources, vaultRoot: vault }), /unreadable|EACCES|permission/i);
  } finally {
    fs.chmodSync(locked, 0o755);
  }
});

// --- Cross-type dedup: same content reachable from two type trees -----------
//
// Found on the real corpus: consolidate() crashed on the first document that
// is byte-identical under two differently-classified trees, because the
// dedup path passed the CURRENT origin's type alongside the FIRST
// sighting's vaultPath. An entry's type is a property of its vaultPath;
// origins may arrive from any tree. Measured scale: 1,701 content hashes
// across 3,889 origin files.

function crossTypeFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-xtype-')));
  const research = path.join(root, 'srcA', 'jerry_garcia', 'outputs');
  const sessions = path.join(root, 'srcB', 'runs', 'jtr', 'inputs');
  fs.mkdirSync(research, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(research, 'garcia-report.md'), 'identical bytes');
  fs.writeFileSync(path.join(sessions, 'garcia-report.md'), 'identical bytes');
  return {
    root,
    sources: [path.join(root, 'srcA'), path.join(root, 'srcB')],
    vault: path.join(root, 'vault'),
  };
}

test('same content reachable from two type trees is stored once, keeping both origins', () => {
  const { sources, vault } = crossTypeFixture();

  const r = consolidate({ sources, vaultRoot: vault });
  assert.equal(r.copied, 1);
  assert.equal(r.deduped, 1);
  assert.equal(r.copied + r.deduped, r.scanned);

  const m = JSON.parse(fs.readFileSync(path.join(vault, 'vault-manifest.json'), 'utf8'));
  const paths = Object.keys(m.entries);
  assert.equal(paths.length, 1);
  const entry = m.entries[paths[0]];
  // the entry's type agrees with its own location -- no self-contradiction
  assert.equal(paths[0].split('/')[0], entry.type);
  // and BOTH origins survive, from two different type trees
  assert.equal(entry.origins.length, 2);
});

test('cross-type dedup is idempotent', () => {
  const { sources, vault } = crossTypeFixture();
  consolidate({ sources, vaultRoot: vault });
  const firstPaths = Object.keys(
    JSON.parse(fs.readFileSync(path.join(vault, 'vault-manifest.json'), 'utf8')).entries
  ).sort();

  // Must not throw on the rerun: the seeded manifest replays the same
  // cross-type dedup through the same code path.
  const second = consolidate({ sources, vaultRoot: vault });
  assert.equal(second.copied, 0);
  assert.equal(second.copied + second.deduped, second.scanned);

  const m = JSON.parse(fs.readFileSync(path.join(vault, 'vault-manifest.json'), 'utf8'));
  assert.deepEqual(Object.keys(m.entries).sort(), firstPaths, 'rerun must not mint new vault paths');
  const entry = m.entries[firstPaths[0]];
  assert.equal(entry.origins.length, 2, 'both origins must survive the rerun without duplicating');
  assert.equal(new Set(entry.origins).size, 2, 'origins must not accumulate duplicates');
  assert.equal(firstPaths[0].split('/')[0], entry.type);
});

test('mutation guard: every manifest entry type agrees with its own vault location', () => {
  // A mutant that passes the deduped origin's type (the original bug) throws
  // outright on the cross-type fixture. This asserts the underlying
  // principle directly, across a mixed corpus: an entry stored at
  // <type>/<name> must record exactly <type>, whatever tree its origins
  // came from.
  const { root, sources, vault } = crossTypeFixture();
  // Add a same-content-different-tree pair under a second name, plus a
  // plain single-tree file, so the check spans more than one entry.
  fs.writeFileSync(path.join(root, 'srcA', 'jerry_garcia', 'outputs', 'shared.md'), 'shared bytes');
  fs.writeFileSync(path.join(root, 'srcB', 'runs', 'jtr', 'inputs', 'shared.md'), 'shared bytes');
  fs.writeFileSync(path.join(root, 'srcB', 'runs', 'jtr', 'inputs', 'only-here.md'), 'unique bytes');

  consolidate({ sources, vaultRoot: vault });
  const m = JSON.parse(fs.readFileSync(path.join(vault, 'vault-manifest.json'), 'utf8'));
  assert.ok(Object.keys(m.entries).length >= 3);
  for (const [vaultPath, entry] of Object.entries(m.entries)) {
    assert.equal(
      vaultPath.split('/')[0],
      entry.type,
      `entry at ${vaultPath} claims type ${entry.type}, contradicting its own location`
    );
  }
});

// --- uniqueName unit tests (synthetic manifests) ----------------------------
//
// A real SHA-256 collision (or even a same-8-hex-char-prefix collision)
// cannot be manufactured from real file content in a unit test -- finding
// one by brute force would need on the order of 2^32 hashes. These tests
// exercise the extend-the-suffix and exhaustion branches directly against a
// fake manifest object instead, which is the only practical way to prove
// those branches are reachable and correct.

// `claims` maps a LOWERCASED vaultPath to the sha256 occupying it. An empty
// vaultRoot path is passed where no filesystem fallback should trigger --
// claims answers every lookup in these cases.
const NO_VAULT = path.join(os.tmpdir(), 'vault-does-not-exist-' + process.pid);

test('uniqueName extends the suffix when the 8-char suffix is already claimed by different content', () => {
  const fileHash = `12345678${'90abcdef'}${'0'.repeat(48)}`; // 64 hex chars
  const collidingSha = `12345678${'ffffffff'}${'0'.repeat(48)}`; // same first 8 hex chars, differs after
  const claims = new Map([
    ['notes/dup.md', 'f'.repeat(64)],
    [`notes/dup-${fileHash.slice(0, 8)}.md`, collidingSha],
  ]);
  const result = uniqueName(claims, NO_VAULT, 'notes', '/fake/notes/dup.md', fileHash);
  assert.equal(result, `dup-${fileHash.slice(0, 16)}.md`);
});

test('uniqueName throws rather than guessing when every suffix length up to the full digest is already claimed by different content', () => {
  const fileHash = 'ab'.repeat(32); // 64 hex chars
  const claims = new Map([['notes/dup.md', 'f'.repeat(64)]]);
  for (let len = 8; len <= 64; len += 8) {
    claims.set(`notes/dup-${fileHash.slice(0, len)}.md`, 'c'.repeat(64));
  }
  assert.throws(
    () => uniqueName(claims, NO_VAULT, 'notes', '/fake/notes/dup.md', fileHash),
    /unique vault path|full digest/i
  );
});

test('uniqueName mutation guard: does not treat a suffix claimed by different content as free', () => {
  // Catches a mutant that returns the first candidate name without
  // re-checking the claim (e.g. a fixed-length suffix with no
  // freeness/ownership check at all).
  const fileHash = `abababab${'11111111'}${'0'.repeat(48)}`;
  const collidingSha = `abababab${'22222222'}${'0'.repeat(48)}`;
  const claims = new Map([
    ['notes/dup.md', 'e'.repeat(64)],
    [`notes/dup-${fileHash.slice(0, 8)}.md`, collidingSha],
  ]);
  const result = uniqueName(claims, NO_VAULT, 'notes', '/fake/notes/dup.md', fileHash);
  assert.notEqual(result, `dup-${fileHash.slice(0, 8)}.md`, 'must not reuse a suffix already claimed by different content');
});

test('uniqueName treats a claim that differs only by CASE as the same slot', () => {
  // On APFS/HFS+/NTFS, notes/summary.md and notes/SUMMARY.md are ONE file.
  // A case-sensitive claim lookup reports the second name as free, so the
  // second document is never copied while the manifest records that it was.
  // Measured: 9 of the owner's real documents lost exactly this way.
  const shaA = 'a'.repeat(64);
  const shaB = `bbbbbbbb${'1'.repeat(56)}`;
  const claims = new Map([['notes/summary.md', shaA]]);
  const result = uniqueName(claims, NO_VAULT, 'notes', '/fake/notes/SUMMARY.md', shaB);
  assert.notEqual(result, 'SUMMARY.md', 'SUMMARY.md must not claim the slot already held by summary.md');
  assert.equal(result, `SUMMARY-${shaB.slice(0, 8)}.md`);
});

test('uniqueName still returns the plain name when the case-differing slot holds THIS content', () => {
  // Idempotency: the same document re-offered under the same name must keep
  // its name, not acquire a suffix, whatever the key casing.
  const shaA = 'a'.repeat(64);
  const claims = new Map([['notes/summary.md', shaA]]);
  assert.equal(uniqueName(claims, NO_VAULT, 'notes', '/fake/notes/summary.md', shaA), 'summary.md');
});

test('uniqueName falls back to the filesystem when the manifest has no claim (manifest lost, files kept)', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-fsfallback-')));
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
  fs.writeFileSync(path.join(root, 'notes', 'dup.md'), 'content already in the vault');
  const onDisk = crypto.createHash('sha256').update('content already in the vault').digest('hex');
  const other = crypto.createHash('sha256').update('a different document entirely').digest('hex');

  // Same content, empty claims -> keeps its name (self-heal, no recopy).
  assert.equal(uniqueName(new Map(), root, 'notes', '/src/notes/dup.md', onDisk), 'dup.md');
  // Different content, empty claims -> must NOT claim the occupied slot.
  assert.equal(uniqueName(new Map(), root, 'notes', '/src/notes/dup.md', other), `dup-${other.slice(0, 8)}.md`);
});

test('every manifest entry matches the bytes actually on disk -- no entry may claim content the vault does not hold', () => {
  // The invariant that caught the case-collision data loss on the real
  // corpus. Deliberately filesystem-agnostic: on a case-insensitive volume
  // one of these gets a suffix, on a case-sensitive one both keep their
  // names -- either way, every entry must describe its own file truthfully.
  // The two names MUST live in different source directories: on a
  // case-insensitive volume a single directory cannot hold both (the second
  // write just overwrites the first). This mirrors how the real corpus
  // produces them -- e.g. two different projects each with their own
  // summary.md / SUMMARY.md -- which only collide once routed to one vault
  // folder.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-case-')));
  const srcA = path.join(root, 'srcA', 'notes');
  const srcB = path.join(root, 'srcB', 'notes');
  fs.mkdirSync(srcA, { recursive: true });
  fs.mkdirSync(srcB, { recursive: true });
  fs.writeFileSync(path.join(srcA, 'summary.md'), 'lowercase content');
  fs.writeFileSync(path.join(srcB, 'SUMMARY.md'), 'UPPERCASE content, entirely different');
  const vault = path.join(root, 'vault');

  const r = consolidate({ sources: [path.join(root, 'srcA'), path.join(root, 'srcB')], vaultRoot: vault });
  assert.equal(r.copied, 2, 'both documents must reach the vault');

  const m = JSON.parse(fs.readFileSync(path.join(vault, 'vault-manifest.json'), 'utf8'));
  assert.equal(Object.keys(m.entries).length, 2);
  for (const [vaultPath, entry] of Object.entries(m.entries)) {
    const p = path.join(vault, vaultPath);
    assert.ok(fs.existsSync(p), `${vaultPath} recorded but absent from the vault`);
    const actual = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    assert.equal(actual, entry.sha256, `${vaultPath} holds different bytes than the manifest claims`);
  }
  // Both distinct contents must be retrievable from the vault.
  const bodies = Object.keys(m.entries).map((k) => fs.readFileSync(path.join(vault, k), 'utf8')).sort();
  assert.deepEqual(bodies, ['UPPERCASE content, entirely different', 'lowercase content']);
});
