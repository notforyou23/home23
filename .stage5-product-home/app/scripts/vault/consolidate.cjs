'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { classifyOrigin, isExcluded } = require('./vault-paths.cjs');
const { hashFile, HashIndex } = require('./hash-index.cjs');
const { VaultManifest } = require('./vault-manifest.cjs');

const DOC_EXT = new Set(['.md', '.txt', '.pdf', '.bib']);
// 'venv' and 'site-packages' added after a real-corpus scan found 89 files under
// /venv/ and 103 under site-packages reaching the vault as Python package READMEs.
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.venv', 'venv', 'site-packages', '__pycache__']);

// Walks `root`, yielding absolute paths to candidate document files.
// Every directory this walk cannot read is a potential silent loss of an
// unknown number of the owner's files -- it is recorded (never swallowed)
// into stats.readErrors so consolidate() can fail loudly rather than return
// a plausible-looking undercount. Symlinked regular files are followed and
// treated as ordinary files (hashFile() already follows symlinks; walk() was
// previously silently skipping them because Dirent.isFile() is false for a
// symlink entry -- confirmed against the real corpus, which has symlinked
// .md documents). Symlinked directories are NOT recursed into (cycle risk)
// but are counted, not silently dropped.
function* walk(root, stats) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    stats.readErrors.push({ dir: root, message: err.message });
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);

    if (e.isDirectory()) {
      if (EXCLUDE_DIRS.has(e.name)) { stats.skippedExcludedDirs += 1; stats.skippedExcluded += 1; continue; }
      yield* walk(full, stats);
      continue;
    }

    if (e.isFile()) {
      if (e.name.startsWith('.')) continue;
      if (!DOC_EXT.has(path.extname(e.name).toLowerCase())) continue;
      yield full;
      continue;
    }

    if (e.isSymbolicLink()) {
      let target;
      try {
        target = fs.statSync(full);
      } catch (err) {
        if (err.code === 'ENOENT') {
          // DANGLING: the link resolves to nothing. This is categorically
          // different from EACCES on a directory. EACCES means "there are
          // files here I cannot see" -- an unknown number of the owner's
          // documents may be hiding behind it, so the run must fail loudly.
          // ENOENT on a link means "there is definitively nothing here":
          // there is no content behind a broken link, so nothing can be
          // lost by not consolidating it. Treating it as a read error made
          // the real run throw at the very end over 3 broken links -- one
          // pointing at /home/jtr/... , a Linux path on a Mac that has never
          // resolved on this machine and never will.
          //
          // Recorded, never merely tolerated: a dangling link whose name
          // looks like a document may itself be evidence that something the
          // owner cared about was moved or deleted. That is worth seeing,
          // which is why every one is reported in stats.danglingSymlinks
          // rather than silently skipped.
          let linkTarget = null;
          try { linkTarget = fs.readlinkSync(full); } catch { /* unreadable link body; path alone still reported */ }
          stats.danglingSymlinks.push({ path: full, target: linkTarget });
          continue;
        }
        // EACCES, EIO, EPERM, ELOOP, anything else: we cannot rule out that
        // real documents are behind this. Stays a loud failure.
        stats.readErrors.push({ dir: full, message: `unreadable symlink: ${err.message}` });
        continue;
      }
      if (target.isDirectory()) {
        // Do not recurse through symlinked directories -- real risk of
        // cycles. Counted explicitly so it is visible, not silently lost.
        stats.skippedSymlinkDirs += 1;
        continue;
      }
      if (target.isFile()) {
        if (e.name.startsWith('.')) continue;
        if (!DOC_EXT.has(path.extname(e.name).toLowerCase())) continue;
        yield full;
      }
      continue;
    }
    // Anything else (fifo, socket, device, etc.) is neither a document nor
    // a directory to recurse into -- correctly ignored, not a document type.
  }
}

// True when `child` is `parent` itself or lives underneath it.
//
// The `+ path.sep` is LOAD-BEARING, not defensive garnish. A bare
// `child.startsWith(parent)` is a substring test, not a path test: it would
// call /Users/jtr/vault-old a child of /Users/jtr/vault, and reject the real
// vault because a similarly-named sibling is a source. The separator is what
// makes this ask "is it under this directory" instead of "does the text
// begin with these characters".
function containsPath(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

// Resolves `p` to its real on-disk location, following symlinked ancestors,
// WITHOUT requiring that `p` itself exists yet (the vault usually does not on
// a first run). Walks up to the nearest existing ancestor, realpaths that,
// and re-appends the not-yet-created tail.
//
// Why this is not over-engineering for the disjointness check below: on this
// very machine /tmp IS a symlink to /private/tmp. A purely lexical check
// would call `--vault /tmp/x/vault` and `--source /private/tmp/x` disjoint
// while walk() -- which traverses real directories -- would happily descend
// from the source straight into the vault. The guard has to reason about the
// same filesystem walk() reasons about, or it guards a different program
// than the one that runs. (walk() never follows symlinked DIRECTORIES, so
// resolving real paths here is exactly the right notion of reachability: a
// symlink pointing into the vault from inside a source cannot be walked
// into, but a real path reached via a symlinked ancestor certainly can.)
//
// Degrades to the lexical path if nothing can be realpathed -- worst case we
// are no weaker than a string comparison, which is what we would have had.
function realpathBestEffort(p) {
  const resolved = path.resolve(p);
  let current = resolved;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length === 0 ? real : path.join(real, ...tail);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved; // reached the root; nothing resolvable
      tail.unshift(path.basename(current));
      current = parent;
    }
  }
}

// The vault and the sources must be DISJOINT TREES. If the vault lives inside
// a source, a later run walks the vault's own copies and records them as
// origins: the vault becomes its own provenance, and the coverage report --
// the one thing whose entire job is proving nothing is wrong -- certifies it
// clean with `missing: []`.
//
// That is precisely the ouroboros this project exists to remove from the
// brain (Home23's feeder watching the agent's own output directory and
// ingesting its own prose as knowledge), rebuilt one layer down. It also
// breaks plan 3's core promise directly: "every node traces to a file" is
// circular the moment an origin IS a vault path -- the node traces to a file
// that traces to itself.
//
// Measured, not theorized (scratch dirs, before this guard existed):
//   vault inside source, vault dir pre-created, ONE run:
//     {"copied":2,"deduped":2,"scanned":4}
//     notes/a.md origins: ["/life/notes/a.md", "/life/vault/notes/a.md"]
// Note "ONE run". The hazard is worse than a second-run-only problem: walk()
// is a lazy generator, so a vault directory that exists when its parent is
// read (i.e. any `mkdir -p <vault>` beforehand -- the most natural thing a
// person does) is descended into AFTER the copies have landed in it, within
// the very same run. The single clean first run in the no-mkdir case is an
// accident of readdirSync having snapshotted the parent a moment too early.
//
// Checked in BOTH directions. The invariant is disjointness, and half an
// invariant is the kind of thing that gets re-broken later by someone who
// reads the guard and reasonably concludes the other direction was
// considered and permitted. A source inside the vault (--source <vault>/notes)
// produces the identical circular provenance by the identical mechanism, and
// costs one extra line to refuse.
function assertVaultDisjointFromSources(vaultRoot, sources) {
  const realVault = realpathBestEffort(vaultRoot);
  for (const src of sources) {
    const realSrc = realpathBestEffort(src);
    if (containsPath(realSrc, realVault)) {
      const relation = realVault === realSrc ? 'is the same directory as' : 'is inside';
      throw new Error(
        `consolidate: --vault ${vaultRoot} ${relation} --source ${src}. ` +
        `The vault would consolidate its own copies and record them as origins, ` +
        `making the vault its own provenance while the coverage report certifies ` +
        `it clean. Choose a vault path outside every source.`
      );
    }
    if (containsPath(realVault, realSrc)) {
      throw new Error(
        `consolidate: --source ${src} is inside --vault ${vaultRoot}. ` +
        `Consolidating the vault into itself would record vault paths as origins, ` +
        `so a document's provenance would point at a copy of itself. ` +
        `Choose sources outside the vault.`
      );
    }
  }
}

// Returns `vaultPath` with its basename corrected to the casing actually on
// disk. Only meaningful after the filesystem has confirmed the target exists.
//
// Why this exists: uniqueName()'s filesystem fallback answers "does this slot
// hold my content?" through existsSync/hashFile, both of which are
// CASE-INSENSITIVE on APFS/HFS+/NTFS. So when the manifest has been lost and
// the vault already holds `notes/summary.md`, an incoming `notes/SUMMARY.md`
// with identical content matches -- and uniqueName hands back the INCOMING
// basename. The manifest would then record the key `notes/SUMMARY.md` for a
// file that is really named `notes/summary.md`.
//
// On APFS that discrepancy is invisible (existsSync resolves either spelling,
// so coverage passes). It becomes real damage the moment the vault is copied
// to ext4 -- which is the exact portability scenario the case-folding above
// exists to protect, and which plan 3 walks straight into if it opens files
// by manifest key on Linux.
//
// readdirSync, not realpathSync: verified on this machine that
// fs.realpathSync('.../SUMMARY.md') returns '.../SUMMARY.md' on APFS even
// though the real dirent is 'summary.md'. realpath resolves symlinks, not
// case. Only the directory listing knows the true spelling.
function canonicalizeVaultPathCase(vaultRoot, vaultPath) {
  const dir = path.dirname(vaultPath);
  const base = path.basename(vaultPath);
  let names;
  try {
    names = fs.readdirSync(path.join(vaultRoot, dir));
  } catch {
    return vaultPath; // cannot list; leave as-is rather than invent a name
  }
  // Exact spelling present (always true on a case-sensitive fs where both
  // variants may legitimately coexist) -- nothing to correct.
  if (names.includes(base)) return vaultPath;
  const lower = base.toLowerCase();
  const match = names.find((n) => n.toLowerCase() === lower);
  return match ? path.join(dir, match) : vaultPath;
}

// Same basename + different content must never collide at the same vault
// path. Measured need: a read-only diagnostic across all five sources found
// 376 colliding vault-path slots affecting ~4,154 origin files (10.6% of the
// corpus) -- research/research_summary.md alone has 693 distinct contents
// all named the same thing.
//
// Decided against BOTH a pure-manifest and a pure-filesystem check; this
// uses the manifest first and the filesystem as a fallback, because each
// alone silently loses documents:
//
//   * Manifest alone: the manifest's key space is CASE-SENSITIVE (plain JS
//     object keys) but a vault on APFS/HFS+/NTFS is CASE-INSENSITIVE.
//     `notes/summary.md` and `notes/SUMMARY.md` are two manifest keys but
//     ONE file on disk. A manifest-only check sees the second name as
//     unclaimed, hands back the plain basename, finds the target "already
//     exists" (case-insensitively!), takes the dedup branch, never copies
//     it -- and records that it did. Measured on the real corpus: 9 of the
//     owner's documents silently destroyed while the manifest asserted they
//     were present. Exactly the failure this project exists to end.
//   * Filesystem alone: re-hashes the same colliding target once per
//     contender (693x for research/research_summary.md), and cannot see the
//     names assigned earlier in THIS run until they are on disk.
//
// So: `claims` (lowercased vaultPath -> sha256) models the vault's ACTUAL
// namespace, is authoritative, and is updated the moment a name is assigned.
// When claims has never heard of a path, the filesystem is consulted as the
// backstop -- that covers a lost/reset manifest whose vault files remain,
// where only the bytes on disk know the truth. The filesystem is only
// touched when claims misses, so the 693-way slot costs one map lookup per
// contender, not 693 re-hashes.
//
// Case-folding is applied UNCONDITIONALLY, including on case-sensitive
// filesystems like ext4 where `summary.md` and `SUMMARY.md` could coexist.
// That is deliberate: it costs only a suffix that was not strictly required
// on Linux, and it keeps the vault portable -- an archive built on ext4
// that relied on case to separate two documents would silently lose one the
// day it was copied to a Mac or a Windows box. The owner's archive must
// survive being moved.
//
// The suffix is DETERMINISTIC (derived from the file's own sha256), never a
// counter or timestamp: naming must not depend on iteration order or wall
// clock, or a rerun would mint different names and re-copy the whole corpus,
// breaking idempotency. This function is only ever invoked on a hash's first
// sighting (see the caller) -- once a name is assigned and recorded, every
// later sighting of the same hash (this run or a future one) is looked up
// directly via vaultPathByHash / the seeded HashIndex and never calls this
// again, so a given hash's name is decided exactly once, ever.
//
// An 8-hex-char (32-bit) suffix keeps names short and is already very safe
// at the corpus's worst-case fan-in: birthday-bound collision probability at
// n=693 distinct contents sharing one slot is ~ n^2 / (2 * 2^32) ~= 5.6e-5
// (about 1 in 18,000) -- unlikely, but "unlikely" is not a substitute for a
// correctness check in a tool whose entire purpose is never silently losing
// a file. So a same-length suffix match is re-verified against the manifest
// (does the existing entry at that path actually have OUR sha256, or a
// different one?) and, on a genuine same-length collision, the loop extends
// to a longer, still-deterministic suffix rather than trusting the 8-char
// prefix blindly. At len=64 the "suffix" is the full digest, so two
// different contents can only still collide there via an actual SHA-256
// collision -- cryptographically infeasible -- at which point this throws
// loudly instead of guessing.
// True when `vaultPath` can hold this content: either nothing claims that
// slot, or what already occupies it IS this exact content. Case-folded, so
// it answers for the vault's real namespace rather than for JS string
// equality. See uniqueName() above for why both sources are consulted.
function slotAcceptsContent(claims, vaultRoot, vaultPath, sha256) {
  const claimed = claims.get(vaultPath.toLowerCase());
  if (claimed !== undefined) return claimed === sha256;
  // Unknown to the manifest -- the vault itself may still hold this name
  // (manifest lost/reset, or a differently-cased sibling on a
  // case-insensitive filesystem). Only the bytes can settle it.
  const target = path.join(vaultRoot, vaultPath);
  if (!fs.existsSync(target)) return true;
  return hashFile(target) === sha256;
}

function uniqueName(claims, vaultRoot, type, origin, sha256) {
  const base = path.basename(origin);
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);

  if (slotAcceptsContent(claims, vaultRoot, path.join(type, base), sha256)) return base;

  for (let len = 8; len <= 64; len += 8) {
    const candidateBase = `${stem}-${sha256.slice(0, len)}${ext}`;
    if (slotAcceptsContent(claims, vaultRoot, path.join(type, candidateBase), sha256)) return candidateBase;
  }

  // Exhausted the full 64-char digest without finding a free or matching
  // slot. manifest.record() would throw on this too, but throwing here with
  // full context is clearer than letting it fail one level down.
  throw new Error(
    `consolidate: could not find a unique vault path for ${origin} ` +
    `(type ${type}, sha256 ${sha256}) -- every candidate name up to the ` +
    `full digest is already claimed by different content in the manifest.`
  );
}

// COPY ONLY. Never moves, never deletes.
//
// Accounting invariant: copied + deduped === scanned. Every branch below
// that consumes a `scanned` unit must increment exactly one of the two.
function consolidate({ sources, vaultRoot }) {
  // FIRST, before the manifest is opened or a single byte is written: the
  // vault and every source must be disjoint trees. This lives in
  // consolidate() rather than main() deliberately -- see the note on
  // assertSafeVaultTarget() for why that one is CLI-only and this one is not.
  assertVaultDisjointFromSources(vaultRoot, sources);

  const stats = {
    copied: 0,
    deduped: 0,
    scanned: 0,
    // skippedExcluded conflated dirs and files in the original spec draft,
    // which made the number meaningless (one dir subtree with 10,000 files
    // pruned looked identical to one lone excluded file). It is now the sum
    // of the two precise counters below, kept only for callers that just
    // want a single "was anything excluded" signal.
    skippedExcluded: 0,
    // Directory subtrees pruned by name (node_modules, .git, .venv, ...).
    // Counted once per pruned subtree, NOT once per file inside it -- the
    // files inside are never individually visited, so they cannot be
    // counted individually without walking the very tree we're pruning.
    skippedExcludedDirs: 0,
    // Individual files skipped by vault-paths.isExcluded() (event-record
    // exclusions: coordinator reviews, cron sync logs, memory stubs).
    // Counted one per file, same unit as `scanned`.
    skippedExcludedFiles: 0,
    skippedSymlinkDirs: 0,
    // Symlinks whose target does not exist. Not read errors (see walk()):
    // there is no content behind a broken link. Reported so they are visible
    // rather than merely tolerated. { path, target }.
    danglingSymlinks: [],
    readErrors: [],
  };
  const manifest = new VaultManifest(path.join(vaultRoot, 'vault-manifest.json'));
  const index = new HashIndex();
  const vaultPathByHash = new Map();
  // Lowercased vaultPath -> sha256 that occupies it. Models the vault's real
  // (case-insensitive on macOS/Windows) name space, which manifest.entries'
  // case-sensitive keys do not. See uniqueName().
  const claims = new Map();

  // Seed from the existing manifest so reruns are idempotent.
  // MUST use seed(), not recordSighting(): recordSighting takes ONE origin, so
  // seeding through it would drop origins[1..n] and every "idempotent" re-run
  // would silently destroy provenance the first run correctly captured.
  // Read manifest.entries directly (there is no iteration API) -- safe here
  // because this loop only reads primitives (sha256 strings, origins arrays)
  // to seed a fresh HashIndex; nothing here mutates manifest.entries itself.
  for (const [vaultPath, entry] of Object.entries(manifest.entries)) {
    index.seed(entry.sha256, entry.origins);
    vaultPathByHash.set(entry.sha256, vaultPath);
    claims.set(vaultPath.toLowerCase(), entry.sha256);
  }

  // The whole scan runs inside try/finally so that ANY mid-run exception --
  // an internal invariant throw, a pathological uniqueName() exhaustion (see
  // above), or anything else -- still saves whatever was successfully
  // recorded before the crash. (Same-basename/different-content collisions
  // are no longer in this list: uniqueName() resolves them to distinct
  // paths before manifest.record() ever sees them -- that was Task 6's
  // territory, and after Task 6 record() should never see a real collision
  // again.) Without this, files already copied to disk during a
  // long real-corpus run would sit there with zero manifest entries the
  // moment something threw, and a naive rerun would have no record of them.
  // (In practice the existsSync self-heal branch above would reconcile this
  // on a subsequent run anyway, but there is no reason to depend on that --
  // durability of partial progress should not be incidental.) This is NOT a
  // workaround for the collision bug itself: the exception still propagates
  // after save(), so the run still fails loudly, exactly as it should.
  try {
    for (const source of sources) {
      for (const origin of walk(source, stats)) {
        if (isExcluded(origin)) { stats.skippedExcluded += 1; stats.skippedExcludedFiles += 1; continue; }
        stats.scanned += 1;
        const sha256 = hashFile(origin);
        const type = classifyOrigin(origin);
        const bytes = fs.statSync(origin).size;

        if (!index.recordSighting(sha256, origin).firstSighting) {
          stats.deduped += 1;
          const vaultPath = vaultPathByHash.get(sha256);
          if (!vaultPath) {
            // The dedup index knows this hash but we have no vault path for
            // it. This should be unreachable (every path into the index also
            // sets vaultPathByHash), but silently dropping the origin here
            // would erase its provenance forever. Fail loudly instead.
            throw new Error(
              `consolidate: internal invariant violated -- hash ${sha256} is known ` +
              `to the dedup index but has no vault path (origin: ${origin}). ` +
              `Refusing to silently drop this origin's provenance.`
            );
          }
          // An entry's type is a property of its vaultPath, NOT of this
          // origin. The same content is legitimately reachable from several
          // type trees (measured on the real corpus: 1,701 hashes across
          // 3,889 origins) -- e.g. one Garcia report that is byte-identical
          // under life/areas/jerry_garcia/outputs (research) and
          // cosmo-home/runs/jtr/inputs (sessions). The file is stored once,
          // under the first sighting's type; every origin is still recorded
          // in origins[]. Passing THIS origin's type here instead would
          // fight record()'s type guard over a non-problem -- that bug
          // crashed the real run on the first cross-type document.
          //
          // Derived from the vaultPath string, NOT read back from
          // manifest.get(vaultPath).type: the stored value is precisely what
          // record()'s guard compares against, so feeding it back would make
          // the comparison tautological and silently disable the guard on
          // this path. Deriving it independently keeps the guard able to
          // catch an entry whose stored type contradicts its own location.
          // Safe by construction: every vaultPath is built as
          // path.join(type, <name>), so segment 0 is always the type.
          const vaultType = vaultPath.split(path.sep)[0];
          manifest.record({ vaultPath, sha256, type: vaultType, origins: [origin], bytes });
          continue;
        }

        let vaultPath = path.join(type, uniqueName(claims, vaultRoot, type, origin, sha256));
        let target = path.join(vaultRoot, vaultPath);

        if (fs.existsSync(target)) {
          // A first-sighting hash whose vault target already exists on disk.
          // uniqueName() has already established that this exact path holds
          // this exact content (it checked claims, and fell back to hashing
          // the bytes when claims did not know) -- so this is the self-heal
          // case: the manifest was lost or reset but the copied file is
          // still there. Re-copying it would be pointless; dropping it from
          // the accounting would break copied + deduped === scanned, which
          // was a real bug here. Count it as deduped and re-record its
          // provenance. manifest.record() remains the final arbiter.
          //
          // Canonicalize the casing FIRST: existsSync matched
          // case-insensitively on APFS, so `vaultPath` may spell a name the
          // disk does not actually use. Recording the incoming spelling
          // would write a manifest key that resolves on this Mac and
          // nowhere on ext4. See canonicalizeVaultPathCase().
          vaultPath = canonicalizeVaultPathCase(vaultRoot, vaultPath);
          target = path.join(vaultRoot, vaultPath);
          stats.deduped += 1;
        } else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(origin, target);
          stats.copied += 1;
        }

        // Set AFTER the branch above: canonicalization can rewrite vaultPath,
        // and both of these must record the name the disk really uses, not
        // the one we arrived with.
        vaultPathByHash.set(sha256, vaultPath);
        claims.set(vaultPath.toLowerCase(), sha256);

        manifest.record({ vaultPath, sha256, type, origins: [origin], bytes });
      }
    }
  } finally {
    // Runs on the happy path AND on any exception (collision, invariant
    // violation, etc.) -- partial progress is never left unrecorded.
    manifest.save();
  }

  if (stats.readErrors.length > 0) {
    const err = new Error(
      `consolidate: ${stats.readErrors.length} directory/path read error(s) -- ` +
      `an unknown number of documents under these paths were NOT scanned and ` +
      `are therefore NOT accounted for in copied/deduped/scanned. This is a ` +
      `loud failure by design (silent loss is the one thing this tool must ` +
      `never do). Partial results were still saved to the manifest.\n` +
      stats.readErrors.map((e) => `  - ${e.dir}: ${e.message}`).join('\n')
    );
    err.readErrors = stats.readErrors;
    err.partialStats = stats;
    throw err;
  }

  return stats;
}

// --------------------------- CLI -------------------------------------
//
// Task 9 (the real ~39,203-document dry run) drives this CLI, not the
// exported function directly -- so its ergonomics and safety matter as
// much as consolidate() itself.
//
// Minimal, dependency-free flag parser. Mirrors the convention already
// used by scripts/audit-brain-provenance.cjs (parseArgs -> args object,
// `--key value` pairs only) rather than introducing a new parsing style.
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

// classifyOrigin()/isExcluded() (vault-paths.cjs) THROW a TypeError when
// handed a non-absolute path. Without this check, a relative --source
// would sail past argument parsing, past the whole walk() of the first
// source tree, and only blow up when the walk finally reaches a file
// under the *relative* source -- deep inside consolidate()'s scan loop,
// as a bare "isExcluded requires an absolute path, got './foo/bar.md'"
// with no indication that the real cause was the --source flag itself.
// Rejecting non-absolute input here, before any scanning starts, turns
// that into a one-line, one-cause error pointing at the exact flag.
//
// Deliberately NOT silently resolved against process.cwd() instead:
// this tool's entire purpose is never writing/attributing files to the
// wrong place, and CWD-relative resolution is exactly the kind of
// ambient, invisible behavior that produces "it wrote to the wrong
// directory" surprises. Requiring the caller to state the path in full
// costs one shell interpolation ($(pwd)/x) and buys an unambiguous
// audit trail for a tool whose failure mode is silent misplacement of
// tens of thousands of files.
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
  // path.resolve() on an already-absolute input just normalizes it
  // (collapses '..', '.', duplicate/trailing slashes) -- no CWD lookup
  // happens because isAbsolute() has already guaranteed that.
  return path.resolve(rawValue);
}

// The blast radius this guards against: a mistyped --vault pointed at a
// real, populated, unrelated directory (an owner's home directory, a git
// checkout, /Users/jtr/life/ itself pointed at prematurely) would splatter
// tens of thousands of copied files into it with no warning. An empty or
// new directory, or one that already has this tool's own manifest in it
// (a real vault, safe to add to / rerun against), are both fine. Anything
// else -- non-empty, no vault-manifest.json -- reads as "someone else's
// directory" and is refused outright.
//
// .DS_Store is ignored when judging "empty": Finder writes it into any
// directory it has ever displayed on macOS, so a directory a user just
// created and considers empty can still fail a naive non-empty check.
//
// This guard stays CLI-only, while assertVaultDisjointFromSources() lives in
// consolidate(). The line between them is deliberate: this one is a
// blast-radius check on a human-typed flag ("did you mean to point at a
// stranger's directory?"), and a programmatic caller passing a populated
// directory on purpose is making a legitimate choice this shouldn't veto.
// Disjointness is not that -- it is a correctness invariant of the operation
// itself, false for every caller for the same reason, and its violation is
// invisible (the coverage report says the vault is clean). Invariants that
// protect the data model belong with the operation; guards that protect
// against typos belong with the typing.
function assertSafeVaultTarget(vaultRoot) {
  if (!fs.existsSync(vaultRoot)) return; // fresh path -- consolidate() creates it
  const stat = fs.statSync(vaultRoot);
  if (!stat.isDirectory()) {
    throw new Error(`--vault must be a directory; found a non-directory at: ${vaultRoot}`);
  }
  if (fs.existsSync(path.join(vaultRoot, 'vault-manifest.json'))) return; // already our vault
  const entries = fs.readdirSync(vaultRoot).filter((name) => name !== '.DS_Store');
  if (entries.length === 0) return; // genuinely empty -- safe to seed
  throw new Error(
    `--vault ${vaultRoot} is a non-empty directory with no vault-manifest.json in it. ` +
    `That does not look like a vault this tool created or manages -- refusing to copy ` +
    `files into what may be someone else's directory. Point --vault at an empty/new ` +
    `directory, or at an existing vault (one that already has a vault-manifest.json).`
  );
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.vault) {
    throw new Error('--vault is required: absolute path to the vault directory (created if it does not exist).');
  }
  if (!args.source) {
    throw new Error('--source is required: comma-separated absolute paths to source directories to consolidate.');
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

  assertSafeVaultTarget(vaultRoot);

  const stats = consolidate({ sources, vaultRoot });
  console.log(JSON.stringify(stats, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // consolidate() attaches partialStats to readError failures because the
    // manifest is saved (in its finally block) before the error propagates --
    // surface that partial progress too, not just the error text, so a
    // failed run's real state is visible rather than just its cause.
    if (err && err.partialStats) {
      console.log(JSON.stringify(err.partialStats, null, 2));
    }
    process.stderr.write(`${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  }
}

// walk() is exported for reuse by coverage-report.cjs. It is deliberately
// NOT duplicated there: this walk took two rounds of review to get right
// (symlink handling, dangling-link vs EACCES distinction, DOC_EXT/
// EXCLUDE_DIRS pruning) and a second copy WILL drift from this one over
// time. A coverage report built on a drifted walk would silently check a
// different set of files than this module actually copies -- certifying a
// vault it never really verified, which is worse than not certifying it at
// all. One walk, two callers.
// assertVaultDisjointFromSources is exported so a real, live vault can be
// checked against a candidate source list WITHOUT calling consolidate() --
// it only realpaths and stats, never writes. Verifying the guard against
// /Users/jtr/vault must not require consolidating into /Users/jtr/vault.
module.exports = { consolidate, uniqueName, walk, main, assertVaultDisjointFromSources };
