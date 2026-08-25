# M31 connected-surfaces activation preflight

This package is a deterministic, fixture-only review aid for M31. It does not inspect live state, edit a database or configuration, change an authority epoch, flip a flag, activate a surface, or advertise a capability. A passing receipt says only `fixture_ready_for_operator_review`; it always records `liveSuccess: false` and `activationAuthorized: false`.

## Fixed sequence and hold points

Prepare exactly one synthetic input and one receipt at a time:

1. unread — missed-event convergence
2. Activity — provenance
3. search — evidence-chain canary
4. attachments — exact hash round trip
5. Channel UI — transcript correlation across supported platforms

Every capability after unread must cite only the immediately preceding fixture receipt. Stop for operator review between receipts. Never batch capabilities or treat a fixture digest as live evidence.

Each input must keep its feature flag false before and after validation and must name the independent kill switch. It must also contain exact current/proposed authority epochs, converged source/destination watermarks, a capability-specific canary and correlation, a non-empty zero-mismatch drift comparison, and an exact rollback target. Stable direct messaging on Mac and physical iPhone, plus zero open P0/P1 defects, are represented by receipt references; this tool validates their shape only and cannot verify those live claims.

## Offline use

Build first, then run against a reviewed synthetic JSON fixture:

```bash
npm run build
npm run coordination:m31-preflight:fixture -- --fixture tests/coordination/rollout/fixtures/m31-unread.fixture.json
```

An optional `--out <new-path>` writes a new receipt with exclusive-create semantics. `--live` and every unknown option are refused. Do not point the runner at live exports: fixture inputs should contain invented identifiers and no message bodies, tokens, credentials, database paths, configuration paths, or runtime endpoints.

## Operator-owned live gate

This package cannot satisfy M31 activation. Before each real flag/epoch change, the authorized operator must independently confirm M26/M27 direct-message stability over the agreed observation window, accepted backend/client packages, no P0/P1, live canonical watermarks and drift, and the capability-specific live canary. The operator must rehearse the independent kill switch and approve the exact epoch transition. No next capability advances without acceptance of the prior live receipt.

If a live canary fails, preserve text direct messaging and use the narrowest applicable rollback from the master plan: stop admission for that capability, stop new work, preserve safe reads for diagnosis, drain/revoke and reconcile positive truth if applicable, disable only its surface, and create a new epoch only when write authority changes. Process stop or snapshot restore are last-resort actions under separate operator authority.
