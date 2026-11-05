# Brain Retrieval Grounding Closeout

Date: 2026-07-15
Backend repository: Home23
Status: complete, with retained live negative evidence and no post-stop provider rerun

## Verdict

The three retrieval repairs in the approved design are implemented on `main`:

1. current verified state, corrections, closure proof, direct artifacts, and
   worker receipts outrank stale archive, external intake, and report-only
   synthesis through one authority projection and scorer;
2. native manifest-v1 retrieval can use a revisioned ANN plus a contiguous
   delta overlay, reports the selected retrieval mode and coverage separately
   from exact ANN freshness, and reuses complete overlay work;
3. provenance authority is authenticated, strict, non-lossy, bounded at public
   surfaces, and preserved through dashboard search, agent/MCP tools, Query,
   PGS, and the Query notebook contract.

PGS progress projection also received a final repair after a real live run
proved that a durable operation could advance while its public counters froze.
That run was intentionally cancelled after the defect was isolated. It remains
negative evidence; it was not erased or converted into a false successful
receipt.

No provider-backed Query, PGS, or iOS acceptance was started after the operator
ordered a credit stop. The final closeout uses the already-captured live proof,
the existing accepted iOS receipt, focused local tests recorded during the
repair, and fresh read-only runtime and repository checks.

## Code authority

The integrated retrieval/authority boundary is anchored by:

- `aa29d2cf` — grounded retrieval and durable PGS source handling;
- `fe0723f9` — merged retrieval grounding with Query authority parity;
- `a39ac27f` — strict authority attestation, safe persistence normalization,
  child-environment scrubbing, ANN authority projection, Query/PGS hardening;
- `ef87488e` — guarded, compare-and-swap provenance audit apply path;
- `3500701f`, `705d3ce5` — safe ANN schema fallback and coherent source counts;
- `d5c59cd5` — live MCP brain-retrieval parity;
- `995a1a3a` — complete delta-overlay reuse;
- `3102a5be`, `1f019ba2` — embedded and public Query retrieval evidence;
- `6345fd03`, `30ead477`, `bdf98d1f` — durable PGS source identity, bounds, and
  authenticated provider evidence;
- `e0f6013e`, `307dee2f` — retained PGS progress recovery and monotonic public
  projection across worker/event gaps.

Current code HEAD before this documentation commit was
`307dee2f1541dae2876bc1d11ef329ff6f983635`.

## Live diagnostic that found the final PGS defect

- Operation: `brop_ePD_5l0iN6w7oFSAVn0-_Z2negwDY8Ej`.
- Immutable session: `pgss_j9MJzFSkVoqpw1HEP8OotZa68C7l_OxW`.
- Durable SQLite state reached 472 of 473 successful units.
- The public operation projection remained at 340 of 473 and still displayed
  sweeping while the retained event journal showed `pgs_synthesis`.
- One provider work item at ordinal 233 ended in retryable `ETIMEDOUT`; this was
  not a retrieval-logic failure.
- Root cause: disposable/compacted worker progress events were treated as the
  only public counter source. Gap recovery advanced its cursor without
  reconstructing the latest retained PGS snapshot, and terminal projection
  could preserve stale counters.
- The operation was cancelled after it could no longer be the final acceptance
  run, preventing further provider spend. Both dashboards now report zero
  nonterminal operations.
- Retained private receipt:
  `.verification/brain-retrieval-query-final-20260715T122824Z-bdf98d1/live-query-pgs-skim-sample.json`.

The fix retains authoritative progress snapshots in both worker adapters,
recovers across multiple event windows, prevents replay/timestamp regression,
and keeps terminal truth monotonic. Independent spec and quality review found
no remaining Critical, Important, or Minor issue in this slice.

## Verification evidence

Recorded on the exact `307dee2f` code head before this receipt:

- affected coordinator, worker, Query progress/client, and operation-store
  suites: 282 passed, 0 failed;
- `npm run build`: passed;
- `npm run test:contracts`: 62 passed, 1 intentional live-only skip, 0 failed;
- `git show --check` for both progress commits: passed;
- external-tag authority regression from `a39ac27f`: 1 passed, 0 failed;
- independent final review: spec pass and quality pass.

The earlier full backend gate on the integrated retrieval baseline recorded
2,637 passed and 1 intentional skip. It was not rerun after the last progress
slice because the operator explicitly stopped further credit-consuming
acceptance activity. The changed progress paths are covered by the 282-test
focused exact-head gate above.

The accepted iOS Query notebook receipt remains:

- receipt: iOS worktree
  `.verification/query-notebook/ios-live-091e32c-final.json`;
- observed: `2026-07-14T09:47:02.770Z`;
- status: passed;
- Apple verifier HEAD: `091e32ca1f10f60e3f9d0b93a874f07acc584067`;
- SHA-256:
  `0d4de2a57234cb67858adc297aa7d07281cf3a7abfd73c6185db29412a02424a`;
- proved completed recovered PGS readback, same-operation continuation, durable
  cancellation, result reopen, notification subscription, and wrong-agent and
  wrong-device rejection.

Later iOS commits through `8a23fcc` are Query UI/history/credential safety
changes. No new iOS provider operation was launched for this closeout.

## Fresh read-only runtime truth

Read on 2026-07-15 after the scoped deployment:

- all nine scoped Home23 services are online: both engines, dashboards,
  harnesses, and MCP services, plus COSMO;
- `HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY` is present in all nine process
  environments; no value was printed;
- the brain-operations capability is present only in COSMO and both dashboards;
  no value was printed;
- Jerry and Forrest MCP `/health` return `ok: true` and
  `sourceHealth: healthy`;
- COSMO `/api/status` returns success, `lifecycle: idle`, `running: false`, and
  no active run;
- the canonical `/home23/api/query/catalog` route returns HTTP 200 with the
  same 18 model rows for Jerry and Forrest;
- the canonical nonterminal-operation route returns HTTP 200 and count 0 for
  both dashboards;
- the legacy `/api/query/catalog` route returns HTTP 410 by design and is not
  current catalog authority.

Only `home23-cosmo23`, `home23-jerry-dash`, and `home23-forrest-dash` were
restarted for the final progress deployment, without `--update-env`. Engines,
harnesses, and MCP were not restarted in that deployment wave. Restart history
is not used as proof of key activation; the fresh boolean-only process readback
above proves the active scope directly.

## ANN and storage truth

Both brains are native manifest-v1 and have revisioned ANN pins. Exact ANN
freshness is currently false; complete same-generation delta-overlay coverage
is the intended normal route between builds.

| Agent | Current revision | ANN revision | Revision gap | ANN vectors |
| --- | ---: | ---: | ---: | ---: |
| Jerry | 1891463280871501 | 1891463280866762 | 4,739 | 143,239 |
| Forrest | 1677572487682768 | 1677572487677724 | 5,044 | 119,187 |

The health result must therefore say “healthy source with a lagging pinned ANN
and overlay-aware retrieval,” not “ANN fresh” and not “brain offline.”

Jerry currently retains 17 PGS session directories using 7,889,804 KiB
(approximately 7.5 GiB). Forrest retains none. The data volume reports
19,783,724 KiB available (91% used). No session, brain, index, receipt, or
runtime data was deleted during this closeout.

## Authority and threat boundary

Authenticated authority binds durable identity, every claim-text fallback,
class/domain, relation and evidence refs, semantic time, and other fields used
by classification or closure. Oversized, malformed, lossy, copied-ID, mutated,
externally tagged, replay-freshened, ID-colliding, and caller-vector promotion
cases fail closed or remain unsigned narrative. Ordinary/raw callers cannot
auto-sign; correction and goal writers sign only after their real validation
boundary. Goal closure cannot manufacture incident verifier proof.

The HMAC is application-layer integrity against forged/model-generated memory
data. It is not claimed to resist arbitrary hostile code running as the same OS
user. Model-controlled child environments scrub both authority and
brain-operations capability keys as defense in depth. A stronger hostile-local-
code boundary would require a separately privileged signer or OS isolation.

## Preserved operator state

The operator-owned `scripts/refresh-synthesis.cjs`, `.system-verifier/`, and
`.verification/` paths were not staged, committed, deleted, or rewritten. The
failed and cancelled receipts remain available as negative evidence.

## Remaining operational work

This code repair is complete. Routine operations still need to rebuild ANN
before overlay gaps or retained sessions grow beyond configured thresholds, and
expired PGS sessions should be reclaimed by the existing bounded retention
policy. Those are monitored maintenance conditions, not evidence that the
retrieval path is offline.
