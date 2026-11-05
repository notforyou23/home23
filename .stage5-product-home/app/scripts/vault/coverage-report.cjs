'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashFile } = require('./hash-index.cjs');
const { VaultManifest } = require('./vault-manifest.cjs');
const { isExcluded } = require('./vault-paths.cjs');
const { walk } = require('./consolidate.cjs');

// "Nothing missed" must be CHECKABLE, not hoped for. This module verifies
// two independent directions and refuses to blur them together:
//
//   1. SOURCE -> VAULT: does every candidate document under `sources` show
//      up as a recorded origin somewhere in the manifest?
//   2. VAULT -> DISK: does every manifest entry correspond to a real,
//      unaltered file actually sitting in the vault?
//
// A report that only checked (1) could still say "all good" over a vault
// whose files were silently destroyed after consolidation (Task 6's
// APFS case-folding bug did exactly this to 9 documents). A report that
// only checked (2) could say "all good" while entire source directories
// were never even looked at. Both directions, always.
function coverageReport({ sources, vaultRoot }) {
  const manifest = new VaultManifest(path.join(vaultRoot, 'vault-manifest.json'));

  // --- knownOrigins: the ONLY source of truth for "was this document
  // consolidated". Built directly from manifest.entries[*].origins.
  //
  // Deliberately NOT supplemented with a content-hash fallback ("origin
  // unknown, but its bytes match something already in the vault -> count it
  // accounted-for anyway"). consolidate.cjs's own accounting invariant
  // guarantees every scanned, non-excluded origin is recorded as an origin
  // string on some manifest entry -- including every deduped file (see its
  // `stats.deduped` branch, which still calls manifest.record with
  // origins: [origin]). So if an origin is genuinely missing from
  // knownOrigins, that IS the finding: its provenance was never captured,
  // whether or not identical bytes happen to exist elsewhere in the vault.
  // A hash-only match is not evidence THIS file was accounted for -- it is
  // evidence some OTHER file with the same content was. Treating those as
  // interchangeable is exactly the kind of quiet substitution this project
  // exists to catch (6,320 real dedups all still kept distinct origins for
  // this reason). Counting hash matches as "accounted for" would let a
  // broken recordSighting/manifest.record call path silently vanish an
  // origin while the report still says "all good".
  const knownOrigins = new Set();
  for (const entry of Object.values(manifest.entries)) {
    for (const o of entry.origins) knownOrigins.add(o);
  }

  const walkStats = {
    skippedExcludedDirs: 0,
    skippedExcluded: 0,
    skippedSymlinkDirs: 0,
    danglingSymlinks: [],
    readErrors: [],
  };

  let sourceDocs = 0;
  let accountedFor = 0;
  let excluded = 0;
  const missing = [];

  for (const source of sources) {
    for (const origin of walk(source, walkStats)) {
      sourceDocs += 1;

      // isExcluded() files are DELIBERATELY absent from the vault -- they
      // are the coordinator-review/cron-sync/memory-stub event exhaust that
      // consolidate() also skips (stats.skippedExcludedFiles there). An
      // excluded file is not a gap: reporting all ~13,558 of them as
      // "missing" would bury the small number of REAL gaps in a wall of
      // expected, intentional absences, training the owner to stop reading
      // the missing list. So exclusion is tracked as its own bucket,
      // checkable and visible, but never conflated with `missing`. Nothing
      // is hidden -- `excluded` is a first-class field, and sourceDocs =
      // accountedFor + excluded + missing.length always holds, so the
      // exclusion count itself is auditable against consolidate()'s own
      // skippedExcludedFiles stat.
      if (isExcluded(origin)) {
        excluded += 1;
        continue;
      }

      if (knownOrigins.has(origin)) {
        accountedFor += 1;
      } else {
        missing.push(origin);
      }
    }
  }

  // walk() can only enumerate what it can read. A directory it could not
  // read (EACCES/EIO/etc, NOT a dangling symlink -- see consolidate.cjs's
  // walk() comments) means an UNKNOWN number of documents under it were
  // never even considered. Silently returning a report that omits them
  // would be a report that says "all good" about a subtree it never looked
  // at -- precisely the failure mode this module exists to prevent. Fail
  // loudly, exactly as consolidate() itself does for the same reason,
  // rather than returning a plausible-looking but incomplete count.
  if (walkStats.readErrors.length > 0) {
    const err = new Error(
      `coverageReport: ${walkStats.readErrors.length} directory/path read error(s) while ` +
      `walking the sources -- an unknown number of documents under these paths could not ` +
      `even be enumerated, so this report cannot certify coverage for them. Refusing to ` +
      `return a report that would look clean while parts of the source tree were unreadable.\n` +
      walkStats.readErrors.map((e) => `  - ${e.dir}: ${e.message}`).join('\n')
    );
    err.readErrors = walkStats.readErrors;
    throw err;
  }

  // --- VAULT -> DISK: every manifest entry, checked against the actual
  // vault contents. This is the direction Task 6's real bug lived in: the
  // manifest asserted 9 documents were present while APFS case-folding had
  // silently overwritten them with different content. Checking manifest
  // entry count alone (Object.keys(manifest.entries).length) would have
  // said "32,883 files" and been wrong -- only walking the disk and
  // re-hashing catches that class of bug.
  const vaultEntries = Object.entries(manifest.entries);
  const vaultFilesMissing = [];
  const vaultFilesCorrupted = [];
  const vaultFilesUnreadable = [];
  for (const [vaultPath, entry] of vaultEntries) {
    const full = path.join(vaultRoot, vaultPath);
    if (!fs.existsSync(full)) {
      vaultFilesMissing.push(vaultPath);
      continue;
    }
    let actualHash;
    try {
      actualHash = hashFile(full);
    } catch (err) {
      // hashFile() is deliberately load-bearing-throws in hash-index.cjs
      // because the consolidator is a WRITER: an unreadable file there must
      // stop the run rather than silently misclassify it as a duplicate.
      // This module is a READER producing a report, not writing anything --
      // here, one unreadable vault file dying the whole process would bury
      // every OTHER finding this report would otherwise have surfaced. So
      // it is caught and reported as its own finding instead of thrown.
      vaultFilesUnreadable.push({ vaultPath, message: err.message });
      continue;
    }
    if (actualHash !== entry.sha256) {
      vaultFilesCorrupted.push(vaultPath);
    }
  }

  return {
    sourceDocs,
    accountedFor,
    excluded,
    missing,
    vaultManifestEntries: vaultEntries.length,
    vaultFilesMissing,
    vaultFilesCorrupted,
    vaultFilesUnreadable,
    danglingSymlinks: walkStats.danglingSymlinks,
    skippedExcludedDirs: walkStats.skippedExcludedDirs,
  };
}

// --------------------------- CLI -------------------------------------
//
// A dedicated flag-based CLI, not a `node -e '...VAULT_SOURCES.split(...)'`
// one-liner in package.json: an unset env var there throws a bare
// "Cannot read properties of undefined (reading 'split')" with no mention
// of which variable, and env-var arguments are a different calling
// convention from the --vault/--source flags the consolidator CLI uses --
// two ways to pass the same two inputs to two commands run back-to-back
// on the same vault. A tiny, real CLI here costs ~30 lines and gives a
// consistent, self-documenting interface (`--help`-able by inspection)
// instead of a shell-quoting-fragile inline script.
//
// Duplicated (not shared) parseArgs/resolveAbsolute rather than imported
// from consolidate.cjs: both are ~10-line, dependency-free, self-contained
// helpers, and this module already has a deliberate one-way dependency on
// consolidate.cjs (walk() only, see the comment above coverageReport()).
// Reaching back into consolidate.cjs for CLI plumbing too would blur that
// boundary for no real gain -- this file stays fully readable on its own.
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`unknown argument: ${token}`);
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`value required for --${key}`);
    if (Object.hasOwn(args, key)) throw new Error(`duplicate argument: --${key}`);
    args[key] = value;
    index += 1;
  }
  return args;
}

// Same rationale as consolidate.cjs's resolveAbsolute(): walk() calls
// classifyOrigin()/isExcluded() (via consolidate.cjs's walk, reused here),
// and both throw on non-absolute paths. Rejecting a relative path here,
// before any walking starts, turns that into a one-line, one-cause error
// instead of a confusing failure deep inside the shared walk.
function resolveAbsolute(flagName, rawValue) {
  if (!path.isAbsolute(rawValue)) {
    throw new Error(
      `--${flagName} must be an absolute path, got: ${JSON.stringify(rawValue)}. ` +
      `Relative paths are rejected here (rather than resolved against the ` +
      `current directory) because a relative path would otherwise fail deep ` +
      `inside the file walk with a confusing "not absolute" error instead of ` +
      `right here. Pass an absolute path, e.g. "$(pwd)/${rawValue}".`
    );
  }
  return path.resolve(rawValue);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.vault) {
    throw new Error('--vault is required: absolute path to the vault directory to check coverage for.');
  }
  if (!args.source) {
    throw new Error('--source is required: comma-separated absolute paths to the original source directories.');
  }

  const vaultRoot = resolveAbsolute('vault', args.vault);
  const sources = args.source
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => resolveAbsolute('source', s));
  if (sources.length === 0) {
    throw new Error('--source must contain at least one non-empty, comma-separated path.');
  }

  const report = coverageReport({ sources, vaultRoot });
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  }
}

module.exports = { coverageReport, main };
