# Query Notebook verified follow-up acceptance — 2026-07-21

## Accepted outcome

- A saved Query answer opens from prior history on the physical iPhone.
- **Follow Up** returns to the Query composer with a visible **Following up on:** banner.
- Same-agent navigation preserves the protected parent answer and follow-up authority.
- Repeated follow-ups remain server-authorized; selected-agent routing and interrupted-bootstrap recovery remain intact.
- Device acceptance was confirmed by the operator on 2026-07-21: **worked**.

## Landed revisions

- Backend `main`: `7c2b297382b912e6f2d38b890d88bd8cde5a7bcc`
- Apple client `main`: `0be1c6d922055141a8dbb7c30ef9c2cae16fa2eb`
- The final Apple lifecycle repair only resets/rebootstraps Query ownership when the host/agent changes or route/catalog readiness is missing; returning from an answer no longer clears a prepared follow-up.

## Verification

- Backend full test gate: 2,850 passed, 1 skipped, 0 failed.
- Backend focused integration rerun: 423 passed, 0 failed.
- Apple Query source/UI/route gate: 23 passed, 0 failed.
- `Home23Shared`: 469 XCTest plus 24 Swift Testing cases passed.
- Generic iOS signed build and Mac Catalyst no-sign build succeeded with Xcode 26.4.
- Protected live root → child → grandchild verification passed; receipt: `/private/tmp/home23-query-follow-up-live-20260721.json`.
- Signed `com.regina6.home23` was installed and launched on `jtr iPhone` (`8593A82D-FAFC-5EEC-9574-849F2821D849`) running iOS 27 beta; final process readback PID `57588`.

## Preservation

- Existing dirty and untracked files in both original checkouts were preserved and excluded from integration commits.
- No backend services were restarted for the final Apple navigation-state repair.
