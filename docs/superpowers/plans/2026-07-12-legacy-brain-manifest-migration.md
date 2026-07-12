# Legacy Brain Manifest Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move existing Jerry and Forrest resident brains from legacy sidecars to manifest-v1 without losing concurrent engine mutations, stop false-green/orphan ANN rebuilds, and make backups and disk use revision-safe.

**Architecture:** Legacy appends and migration share the existing external canonical-root lock. Migration streams the exact stable legacy logical source into operation-private projection files, publishes uniquely named native base/delta files, then atomically switches `memory-manifest.json`; blocked engine saves resume against the new manifest. ANN construction refuses legacy projections and reports failure unless its manifest CAS succeeds. Backups retain their source pin/lock through the complete copy and verify stable file identities before publication.

**Tech Stack:** Node.js CommonJS/ESM, Node streams/fs/zlib, existing `shared/memory-source`, `node:test`, shell smoke tests, PM2-scoped live rollout.

## Global Constraints

- Never rewrite or delete the live legacy base/delta in place.
- The manifest rename is the only authority switch; failures before it leave legacy authority unchanged.
- Every legacy append and migration uses `<home23Root>/runtime/brain-source-locks` for the same canonical root.
- Migration must stream; it may not materialize Jerry or Forrest's full graph in a second JS object graph.
- Require enough free disk for the projected base plus a 4 GiB reserve before migration publication.
- ANN is successful only when its files are named by and CAS-pinned into the current manifest revision.
- No nightly job may print `OK` or exit zero for a missing manifest, stale CAS, empty unintended index, or builder failure.
- A backup is publishable only while its legacy lock or native source pin remains held through copy, fsync, and identity revalidation.
- Preserve one verified rollback backup and all legacy source files through live acceptance. Cleanup of superseded multi-gigabyte files is a separate, explicit post-acceptance action.
- Use TDD for every behavior change and run the focused test before broader verification.

---

### Task 1: Truthful ANN Build and Nightly Wrapper

**Files:**
- Modify: `engine/src/merge/build-ann-index.js`
- Modify: `scripts/rebuild-ann-indexes.sh`
- Modify: `tests/engine/merge/build-ann-index.test.js`
- Create: `tests/scripts/rebuild-ann-indexes.test.cjs`

**Interfaces:**
- Consumes: pinned `source.manifest` and `advanceAnnBuiltFromRevision()`.
- Produces: a builder result only when `advanced.advanced === true`; otherwise a typed nonzero failure with no newly retained final ANN files.

- [x] Add a failing builder test using a legacy projection manifest and assert HNSW construction, target writes, and CAS are never invoked.
- [x] Add a failing stale-CAS test asserting newly written index/meta files are removed and the builder rejects.
- [x] Add a failing wrapper test with a builder that exits nonzero and assert the wrapper exits nonzero and never prints `<agent> OK`.
- [x] Make the builder reject `sourceMode === 'legacy_projection'`/non-native source authority before allocating HNSW.
- [x] Treat an unadvanced ANN CAS as failure and remove only the exact newly created files after identity checks.
- [x] Add `set -o pipefail`; require both agents to have `memory-manifest.json`; print a typed skip/failure rather than a success for legacy brains.
- [x] Run `node --test --test-concurrency=1 tests/engine/merge/build-ann-index.test.js tests/scripts/rebuild-ann-indexes.test.cjs` and `git diff --check`.

### Task 2: Lock Legacy Appends Across the Authority Switch

**Files:**
- Modify: `engine/src/core/memory-sidecar.js`
- Modify: `engine/src/core/memory-persistence.js`
- Modify: `tests/engine/core/memory-sidecar.test.cjs`
- Modify: `tests/engine/core/memory-persistence.test.js`

**Interfaces:**
- Consumes: `withMemorySourceLock(brainDir,{lockRoot},callback)`.
- Produces: `appendMemoryDelta(brainDir,changes,{lockRoot,signal})`, which rechecks the manifest while locked and, if migration won, releases then appends through `appendMemoryRevision()`.

- [x] Add a failing race test that pauses a legacy append before lock acquisition, publishes a manifest, then proves the change lands in the manifest delta and not `memory-delta.jsonl`.
- [x] Add a failing serialization test proving migration and a legacy append cannot both publish legacy bytes.
- [x] Pass the production global lock root from `persistMemoryRevision()` into `appendMemoryDelta()`.
- [x] Implement the locked recheck without recursive lock acquisition.
- [x] Run the two focused persistence suites and `git diff --check`.

### Task 3: Streaming Legacy-to-Manifest Promotion

**Files:**
- Create: `shared/memory-source/legacy-migration.cjs`
- Modify: `shared/memory-source/index.cjs`
- Create: `scripts/migrate-legacy-brain.mjs`
- Create: `tests/shared/memory-source-legacy-migration.test.js`
- Create: `tests/scripts/migrate-legacy-brain.test.cjs`

**Interfaces:**
- Produces: `migrateLegacyResidentToManifest({brainDir,home23Root,requesterAgent,operationId,signal,minFreeBytes=4*1024**3})`.
- Returns: `{migrated,authority,generation,revision,summary,sourceFingerprint,files,unchangedLegacy:true}`.

- [x] Add a failing migration test with base upserts, delta upserts/deletes, and a concurrent append waiting on the same lock.
- [x] Add crash-window tests after each base copy, after empty-delta fsync, and before manifest rename; legacy selection must remain authoritative and readable.
- [x] Add insufficient-disk, existing-manifest idempotency, cancellation, symlink/collision, and operation-root cleanup tests.
- [x] Stream `projectLegacyResidentSidecars()` under the shared source lock into an operation-private root.
- [x] Copy through anchored no-follow handles into unique native base filenames, create/fsync an empty epoch delta, revalidate projection digests/counts, then atomically write the native manifest with `ann` null.
- [x] Publish a bounded JSON receipt from the CLI; dry-run performs selection, size, disk, and active-operation checks without target writes.
- [x] Run the migration and CLI focused suites plus writer/reader suites and `git diff --check`.

### Task 4: Coherent Backups and Capacity Guard

**Files:**
- Modify: `engine/src/core/brain-backups.js`
- Modify: `tests/engine/core/brain-backups.test.cjs`

**Interfaces:**
- Legacy: hold the same external source lock through all raw-file copies and revalidate exact inode/size/mtime before publishing.
- Native: keep the opened pinned source alive through all manifest-named file copies and close it only after backup rename/fsync.

- [x] Add failing legacy mutation-during-copy and native retirement-during-copy tests.
- [x] Add a failing capacity test that refuses a backup when projected bytes would breach a configurable free-space reserve.
- [x] Refactor source resolution into a callback-scoped handle so the lock/pin outlives copy publication.
- [x] Record generation, revision, source fingerprint/descriptor digest, copied byte counts, and hashes in `backup-manifest.json`.
- [x] Run focused backup tests and `git diff --check`.

### Task 5: Isolated and Live Acceptance

**Files:**
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md` only if COSMO code changes.
- Create: `docs/receipts/2026-07-12-legacy-brain-manifest-migration.md` after live proof.

- [x] Run the complete source-truth matrix, `npm run build`, `npm test`, `npm run test:contracts`, and portability/archive checks.
- [x] Deploy code to the preserved live checkout without resetting or deleting user work.
- [x] Restart only Jerry/Forrest engines after the locked-append code is built; leave dashboards, harnesses, MCP, and COSMO running unless route evidence requires a scoped restart.
- [x] Require no queued/running brain operations, fresh coherent rollback backups, and disk reserve before each migration.
- [x] Dry-run then migrate Jerry; prove manifest counts, legacy tree unchanged, post-switch engine delta append, bounded status/graph/search, and restart/load continuity.
- [x] Build Jerry ANN; require `builtFromRevision === currentRevision`, active ANN filenames in the manifest, and search without `ann_missing`.
- [x] Repeat for Forrest only after Jerry passes every gate.
- [x] Verify nightly wrapper failure semantics with a controlled fixture; do not wait for 04:00.
- [x] Record exact hashes, revisions, counts, durations, disk before/after, PM2 PIDs/restarts, routes, and commands in the receipt.
- [x] Keep legacy originals, rollback backups, and stale ANN files until the operator explicitly authorizes post-acceptance reclamation.
