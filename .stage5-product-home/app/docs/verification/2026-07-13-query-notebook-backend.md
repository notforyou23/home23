# Query Notebook Backend Verification — Superseded Attempt

Status: `SUPERSEDED — DO NOT USE AS CURRENT AUTHORITY`
Date: 2026-07-13 through 2026-07-14

This file originally held the pre-repair comprehensive live-verifier template.
Its two machine runs ended failed before the immutable-session continuation
repair:

- `.verification/query-notebook/backend-live.json`:
  `terminal_operation_failed`.
- `.verification/query-notebook/backend-live-68cd1fa.json`:
  HTTP 500 during the then-broken recovery path.

Those files are intentionally retained as negative evidence. They are not
current health authority and must never be relabeled as passed.

The repaired backend passed its full automated suite, production-scale PGS
lifecycle, live 416/416 recovery, and the exact-commit iOS lifecycle verifier.
Use these current authority files instead:

- `docs/verification/current.md`
- `docs/receipts/2026-07-14-query-pgs-recovery-closeout.md`
- Home23 iOS repository:
  `docs/verification/2026-07-13-ios-query-notebook.md`

The replacement acceptance deliberately reused the already completed immutable
PGS recovery rather than purchasing another full provider sweep or creating
another large session projection. The closeout receipt records the exact source,
continuation lineage, test totals, machine-receipt digest, runtime state, and
bounded retained storage.
