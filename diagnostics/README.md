# Forrest stop-tail recovery patch (not deployed/applied)

Base: cf50c4f275a27f1f0f111543ef50e898bc0684c8; branch fix/forrest-stop-tail-recovery.
Only product edits: substrate/bin/seed-recover-tail.ts and substrate/tests/seed-tail-recovery.test.ts.
Patch artifact: forrest-stop-tail-recovery.patch (git diff --binary).
The local node_modules symlink is disposable tooling pointing to the maintained checkout's dependencies; do not integrate it or these diagnostic artifacts into a product release.

## Root cause / implementation
The latest checkpoint can be followed by its own checkpoint receipt, a clean stop receipt, then resumed life without another checkpoint. Recovery previously ignored stop, shifting sequence-dependent replay and dropping a receipt. Preserve that administrative boundary verbatim in scratch and restore with requireCheckpointCoversTail:true. Existing strict restore checks stop authority, source, exact payload shape and checkpoint binding and accounts for the boundary. Replay subsequent life normally. All original receipts (including stop) remain in the full count/category/state-hash comparison. Unknown later categories explicitly fail closed. No resident state changes and no stop() invocation during replay.

## Verification
- node --import tsx --test --test-concurrency=1 substrate/tests/*.test.ts: 277 passed, 0 failed (substrate-suite.txt).
- Focused adapter-runner/checkpoint/tail tests: 36 passed (regression-tests.txt). Tail tests cover ordinary and stop-boundary interrupted life, missing evidence rejection, valid-chain malformed stop rejection, dry-run immutability, apply backup on disposable fixtures, and repeated restart idempotence.
- ./node_modules/.bin/tsc -p substrate/tsconfig.json --noEmit --rootDir .: exit 0 (typecheck-rootdir.txt). Default rootDir fails TS6059 on both baseline and patched trees (typecheck-baseline.txt, typecheck.txt); not introduced here.
- git diff --check: exit 0.
- Actual stopped resident: forrest-actual-dryrun.json contains exact reproducible command, supported runtime/ecosystem.config.json source mapping, output and SHA256 inventory of all 1496 resident state files before/after. Checkpoint 57349, stop 57351, head 57383: all 33 tail receipts verified, apply:false, expected state hash a17143c9aac9ce30512f24bf8782aa8e19c08ff8d22ce3884c537e352a3eb36d. All state files remained identical after all checks.
- Baseline same read-only command: exit 1, expected 33 got 32 (baseline-dryrun.json).

## Supported integration / next step
No apply, lived ledger/checkpoint edits, deployment, seed restart or owner notification performed. Live runner health is NOT repaired by this patch alone. Parent must separately authorize/assess recovery and release.
This installation is product Host layout with Home/runtime/ecosystem.config.json, NOT the legacy managed-release-pointer layout. Legacy npm run release:status cannot inspect it (missing instances/.house/coordination/active-release.json); do not use that route.
Supported product entry points: scripts/product/package.mjs builds a dependency-complete product payload from Git; scripts/product/host.mjs preview --home ABS --payload ABS invokes product-host previewProductUpdate. Actual admitted update uses host.mjs update --home ABS --payload ABS --staging ABS (product-update-apply.js); review admission/seed stopped-state behavior before execution. Inspect the installed receipt and preserve newer deployed behavior when preparing candidate. Do not copy source into installed app or restart Seed as a substitute for a supported update. Source integration, new package preparation and update execution have NOT occurred.
Original fix_recipe_recorded verifier was not callable with this specialist's tools; parent owns that final diagnostic closure.
