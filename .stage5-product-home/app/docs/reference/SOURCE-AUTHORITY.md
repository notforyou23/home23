# Source authority

Development source, installed executable packages and resident state have different jobs. Keep one maintained source repository per independently built component. A release directory is an immutable artifact; old worktrees are recoverable history until their unique changes have been classified.

On a reconciled installation, `npm run source:status` reads ignored `instances/.house/source-authority.json`. From a separate development checkout pass the installation root after `--`. It identifies maintained backend/Apple sources, selected release, preserved baseline and changes to recorded source files. Use `git status` for newly added files. This is a read-only source check, not behavioral acceptance.

Before incorporation, preserve source bytes and Git history, identify concurrent writers, compare exact deployed and working inputs, and record each divergent file's resolution. Never choose an entire older checkout over a newer deployed package. Keep current engine/web changes even when those services run outside the package. A clean merge and a successful build alone do not prove preservation.

Verify the combined source with both sides' regression tests and preserve the artifact and source digests. Keep tests of runtime ownership, cancellation, recovery, source selection and persistence compatibility. Treat stale tests explicitly; do not weaken a current contract to match an old fixture.

For backend activation use [Managed releases](MANAGED-RELEASES.md). Do not copy a development tree over a live installation. Updating the development source does not require restarting the running system. Apple source relocation may change the selected source path only after byte verification; retain bundle identity, persistence contract and installation state.

The machine-specific source map, paths and preservation receipts belong in ignored installation state and local operator guidance. Keep runtime data and secrets out of source checkpoints and public history.
