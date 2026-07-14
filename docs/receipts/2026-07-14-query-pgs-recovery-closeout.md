# Query and PGS Recovery Closeout

Date: 2026-07-14
Backend repository: Home23
iOS repository: Home23 iOS

## Verdict

The Query/PGS repair is complete and live. The backend now recovers a
provider-stalled PGS operation from its original immutable session projection,
preserves completed sweep work across repeated continuations, and never reopens
the caller's current live brain as a substitute source. Query and iOS use the
same selected-agent catalog and protected durable-operation routes.

The exact final iOS verifier completed Direct Query, durable result reopen,
Markdown export, notification subscribe/unsubscribe, recovered PGS readback,
same-session continuation creation, durable cancellation, inventory agreement,
wrong-agent rejection, and wrong-device rejection. No active Jerry Query/PGS
operation remained after acceptance.

## Exact code authority

- Backend HEAD: `d46921b119f328b58fb4c54d9cd2e51cf4da2d8d`.
- iOS verifier HEAD: `091e32ca1f10f60e3f9d0b93a874f07acc584067`.
- iOS documentation closeout: `b536858`.
- Private iOS receipt in the iOS repository:
  `.verification/query-notebook/ios-live-091e32c-final.json`.
- Receipt SHA-256:
  `0d4de2a57234cb67858adc297aa7d07281cf3a7abfd73c6185db29412a02424a`.

The older backend files `.verification/query-notebook/backend-live.json` and
`backend-live-68cd1fa.json` have `status=failed`. They predate the final source
reuse fix and are deliberately retained as negative evidence; they are not
current acceptance authority.

## Live PGS proof

- Root operation: `brop_hJB97_IvIyZBOYGdwEYlPST7LoT8hRtr`.
- Final recovered operation: `brop_7MbwzkEbLxSyw2WsUVO503zzzv4UcdXn`.
- Root state: retryable `provider_stalled` after 327 successful work units.
- Final state: complete; 416/416 successful, 0 failed, 0 pending, 0 retryable.
- Reuse: 406 existing work units plus 10 new work units.
- Synthesis: two hierarchy levels, 24 provider calls, all 23 final batches.
- Runtime: 11m52s for the successful recovery continuation.
- Same immutable session: `pgss_TRitqmT3rK5nHDmMV7T6py86AzcF-tZ_`.
- Original source revision: `1891463280844112`.
- Original source size: 142,231 nodes and 465,991 edges.
- Source digest:
  `sha256:24c1a11540c69063304fca2c6a05e2a89f5bc1ef35e993efbfdb5c000ca9c022`.
- Source health: healthy `manifest-v1-session-projection`.
- Final verifier cancellation:
  `brop_CbX7YIt3o6yyZNqDar8vh38plN9eUEOE`, durable `cancelled`.
- The one live child exposed by the verifier's initial queued-only assumption,
  `brop_Q1JoY2AQi6moroLFk-3eALr7Un9GgXEv`, was immediately and durably cancelled.

## Correctness boundaries

- Every recovery hop must retain agent, brain, PGS level, sweep provider/model,
  synthesis provider/model, and `pgsMode=continue` authority.
- Retryable stalled sources must expose a nonnegative `progress.successful`;
  child reuse must meet or exceed that completed-work floor.
- Consecutive absent-result stalls are recoverable without reading nonexistent
  result bodies.
- Existing completed recovery can be reverified without another full synthesis
  or another large session copy.
- Action responses accept only the schema's two canonical active states,
  `queued` and `running`, and require a distinct valid PGS operation.
- Verification source identity is captured before the live run and must remain
  clean and on the same exact commit afterward.
- Private evidence directories are mode `0700`; receipts are mode `0600`.

## Automated verification

- Backend full `npm test`: passed on `d46921b`, including the production-scale
  100,000-node / 300,000-edge PGS lifecycle.
- Backend build: passed.
- Backend contracts: 62 passed, 1 intentional live skip, 0 failed.
- Backend focused continuation/session matrix: 168 passed, 0 failed.
- iOS exact-HEAD full Node suite: 643 passed, 0 failed, 0 skipped.
- iOS focused acceptance verifier: 43 passed, 0 failed.
- Independent final verifier review: no blocker.
- Backend and iOS `git diff --check`: passed.

## Current runtime and capacity

- `home23-cosmo23`, both engines, both dashboards, both harnesses, and both MCP
  services are online.
- Jerry and Forrest Query catalogs are available, each with the same 18 exact
  provider/model rows and its own resident brain selected.
- Jerry's final direct operation
  `brop_S6vbEQWr20vhxvMK_83PS2PZkgEx16ju` completed in 32.2s; protected result
  reopen and Markdown export digest matched.
- Jerry has zero active Query/PGS notebook operations after closeout.
- Jerry retains 14 bounded PGS sessions totaling 6.1 GiB; the data volume has
  17 GiB free. Valid sessions expire automatically between July 19 and July 21.
- Continuations reused the same 449 MiB source projection; no large continuation
  copy was created.
- Jerry's current manifest-v1 snapshot is revision `1891463280847016`, with
  142,404 nodes and 466,324 edges.
- Forrest's current manifest-v1 snapshot is revision `1677572487654900`, with
  118,402 nodes and 457,044 edges. Its prior pause marker was resumed without a destructive
  restart or data rewrite.

## iPhone and Chat boundary

No trusted Chat runtime source or app binary changed during the final verifier
hardening. The previously signed app remains installed on paired CoreDevice
`8593A82D-FAFC-5EEC-9574-849F2821D849`. The operator confirmed push delivery
and app launch. No TestFlight, App Store, broad PM2 stop/delete, destructive Git
cleanup, or operator runtime-data deletion was performed.
