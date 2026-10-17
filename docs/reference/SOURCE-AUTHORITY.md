# Source authority

Development source, installed executable packages and resident state have different jobs. Keep one maintained source repository per independently built component. A release directory is an immutable artifact; old worktrees are recoverable history until their unique changes have been classified.

`npm run source:status` reads ignored `instances/.house/source-authority.json`. From a separate development checkout pass the installation's `app/` directory after `--`. This is a read-only source check, not behavioral acceptance.

Product Host homes can record the maintained source mapping without creating historical release or preservation evidence:

```json
{
  "schemaVersion": 2,
  "development": {
    "backend": "/absolute/path/to/maintained/backend",
    "apple": "/absolute/path/to/maintained/apple"
  },
  "recordedAt": "2026-10-17T23:00:00.000Z",
  "recordedBy": "owner-authorized-operator"
}
```

Both source paths must identify available Git repositories; Git worktrees are supported. Record the actual actor and time. New coding jobs targeting the installation use `development.backend`; explicit other projects and resumed jobs retain their selected identity. Do not point this record at the immutable installed package.

Version 2 reads the product manifest above `app/` through the product manifest validator. It reports the selected package, backend source commit and current maintained source roots. It needs neither legacy `coordination/active-release.json` nor an Apple installation record. It does not create or infer them. `preservation` and `changesSinceReconciledBaseline` are `null` because the routing record contains no byte baseline. A successful check does not verify installed runtime bytes, running process paths, Apple build or persistence compatibility, or physical-device acceptance. Use `git status` in each maintained source repository for working edits and newly added files.

Existing version 1 records remain supported. They compare the selected legacy release and Apple persistence contract with their recorded source manifests and preservation baseline. Do not replace a recorded baseline merely to clear a drift warning.

Before incorporation, preserve source bytes and Git history, identify concurrent writers, compare exact deployed and working inputs, and record each divergent file's resolution. Never choose an entire older checkout over a newer deployed package. Keep current engine/web changes even when those services run outside the package. A clean merge and a successful build alone do not prove preservation.

Verify the combined source with both sides' regression tests and preserve the artifact and source digests. Keep tests of runtime ownership, cancellation, recovery, source selection and persistence compatibility. Treat stale tests explicitly; do not weaken a current contract to match an old fixture.

For backend activation use [Managed releases](MANAGED-RELEASES.md). Do not copy a development tree over a live installation. Updating the development source does not require restarting the running system. Apple source relocation may change the selected source path only after byte verification; retain bundle identity, persistence contract and installation state.

The machine-specific source map, paths and preservation receipts belong in ignored installation state and local operator guidance. Keep runtime data and secrets out of source checkpoints and public history.
