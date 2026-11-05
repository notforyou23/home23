# Core feature-off deployment and canary preflight

This is a deterministic review gate for exact candidate `9ae494591e164b11450323d058b684f7a3dbadd0`. It accepts synthetic fixture evidence only. It never opens a database, reads live configuration, invokes PM2, changes an authority epoch or feature flag, sends a Message, or executes any command in its generated plan. It refuses `--live`.

The manifest binds the candidate and clean tracked tree, build and generated ecosystem hashes, reviewed migration plan/schema checksums, a complete all-false coordination flag snapshot, pre-rehearsal database/sidecar/authority-history hashes, exactly one legacy writer and no coordination writer, distinct Jerry/Forrest bindings, and an exact rollback snapshot/ecosystem/source/writer tuple.

Run only with an invented or redacted offline fixture:

```bash
npm run build
npm run test:coordination:deployment-preflight
npm run coordination:deployment-preflight:fixture -- \
  --fixture tests/coordination/rollout/fixtures/deployment-preflight.fixture.json \
  --out /absolute/path/new-deployment-preflight-receipt.json
```

Output uses exclusive create with mode 0600. A pass says only `fixture_ready_for_operator_review`, `liveDeploymentAttempted: false`, and `liveMutationAuthorized: false`. The staged commands in the receipt are inert text and each is marked `authorizedOnly`.

## Live hold points

An authorized operator must separately approve and capture the real source/build/ecosystem hashes, a consistent database and SQLite sidecar snapshot, authority history, current PM2/process ownership, complete effective flag projection, and supported binding discovery. The operator must approve any dependency install, build, ecosystem regeneration, migration/open, process start, flag or epoch transition, and canary Message.

Deploy feature-off first and stop if the generated config differs, coordination starts or autorestarts, any coordination flag is true, migration bytes differ, or writer ownership is not exactly the reviewed legacy writer. Jerry is the first live canary. Forrest requires an accepted Jerry receipt and a separate authorization. On failure, close admission, preserve evidence, stop/drain the affected writer under authority, and restore only the pinned snapshot/config/source tuple; verify one legacy writer before reopening.
