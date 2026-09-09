# Resident Outcome Reporting Integration Receipt

Date: 2026-09-08
Status: maintained-source integration and offline verification complete; managed release preparation and activation pending

## Outcome

- Integrated the reviewed reporting repair from `613c2a2f1292fd1a5b7fbd63fb18dfee553a3708` as `3090f103`.
- Integrated the bounded expired-read guard from `8e40a028` as `58b820fc` after pre-integration review found that event replay otherwise had no consecutive `capability_expired` retry bound.
- Blank optional `revisit_at` values are omitted, invalid reporting inputs retain actionable `request_invalid` messages, and genuine execution errors still produce failed receipts.
- Result and event GETs may renew one expired signed capability. `ResidentUdsClient.request()` creates a fresh request ID, nonce, issue time, expiry, and signature for that retry. A second consecutive expiry fails closed. Start and stop mutations do not opt into expiry renewal; cancellation and fencing logic are unchanged.

## Integrated verification

Run in `/Users/jtr/_JTR23_/development/home23`:

```bash
node --import tsx --test --test-concurrency=1 \
  tests/coordination/app/resident-assignments.test.ts \
  tests/coordination/transport/uds/uds.test.ts \
  tests/coordination-adapter/resident-uds.test.ts
```

Result: 29 passed, 0 failed, 0 skipped.

```bash
node --import tsx --test \
  --test-name-pattern='successful resident completion emits|genuine resident execution error' \
  tests/coordination-adapter/resident-adapter.test.ts
```

Result: 2 passed, 0 failed, 0 skipped.

- `npm run build` — passed.
- `npm run test:contracts` — 71 passed, 0 failed, 2 skipped.
- `git diff --check` — passed.

## Activation boundary

Before integration, the seven reviewed source/test files in maintained source matched deployed package `bb8327e4320efd2ceb969d3623cf35e66cc627ba`; the maintained source now differs by the intended reporting changes and this receipt. `npm run source:status -- /Users/jtr/_JTR23_/release/home23` still reports broader deployed-backend divergence from the reconciled baseline, so this checkout must not be copied over the installation.

Prepare and verify a managed candidate from the selected deployed package using only the reviewed files. The behavioral change is coordinator-owned, but a coherent managed-package activation must keep `home23-coordination`, `home23-jerry-harness`, and `home23-forrest-harness` aligned to the same selected package. Pointer change, admission fence, Work drain, database backup/integrity checks, scoped process rebinding, and live behavioral readback require separate activation authority.

Evidence limit: no live retry was induced. Verification is source inspection plus isolated signed-transport regression tests; live behavioral readiness remains unmeasured.
