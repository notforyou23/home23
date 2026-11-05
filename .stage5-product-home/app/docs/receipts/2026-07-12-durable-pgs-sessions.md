# Durable PGS Sessions Completion Receipt

Date: 2026-07-12
Operator: Codex
Repository: `/Users/jtr/_JTR23_/release/home23`
Design: `docs/superpowers/specs/2026-07-12-durable-pgs-sessions-design.md`
Plan: `docs/superpowers/plans/2026-07-12-durable-pgs-sessions.md`

## Verdict

The approved durable PGS design is implemented and live for the Query tab and agent brain/research tools. PGS now has named skim/sample/deep/full levels, fresh/continue/targeted modes, durable detach/reattach/cancel behavior, exact session binding, cumulative sweep reuse, bounded multi-batch full coverage, and honest scoped-versus-global coverage receipts.

Jerry's original agent-tool failure is also closed on the final runtime: Jerry invoked `brain_status`, waited for the durable operation, and received healthy native `manifest-v1` evidence with a fresh ANN index and no `fetch failed` error.

No broad PM2 stop/delete command, destructive Git cleanup, or deletion of operator brain data was performed.

## Implemented Contract

- PGS public callers choose only `skim` (10%), `sample` (25%), `deep` (50%), or `full` (100%); raw fractions and private session paths are not public authority.
- `fresh` creates a protected per-agent session, `continue` expands the same deterministic level scope, and `targeted` operates on the exact requested partition union.
- A continuation must match owner, target, query, source revision, sweep pair, prompt contract, limits, and coverage-selection policy. Mismatch or non-monotonic scope fails typed and never starts a silent fresh sweep.
- Successful work is committed batch by batch and reused. Full mode drains beyond the 256-work-unit execution window instead of stopping after one batch.
- Cancelled, interrupted, and typed-failed operations retain valid session lineage independently of a nullable answer, without presenting failure as success.
- Query UI exposes Start Fresh, Continue, targeted partition selection, Reattach, and Cancel, and reports reused/new/pending work, requested-scope completion, global coverage, session expiry, and canonical operation identity.
- Agent `brain_query` and research tools use the same named PGS contract and can remain attached/reconnect for operations lasting up to six hours.
- Direct Query fields that PGS does not consume (`mode` and `priorContext`) are rejected instead of ignored.
- Per-session storage is capped at 8 GiB, aggregate per-agent session storage at 32 GiB, and operations retain at least 1 GiB filesystem free space. Active leases reserve house headroom so concurrent creates cannot over-admit.
- Sessions expire after seven days. Expired state is now automatically reclaimed through the exact identity-checked cleanup path before fresh admission and before a valid continuation consumes quota. Cleanup is bounded and does not recurse or follow symlinks/hard links.

## Live Acceptance

Jerry source authority during acceptance was revision `1891463280844112`, with 142,231 nodes, 465,991 edges, and 4,152 PGS work units.

| Proof | Operation | Result |
|---|---|---|
| Direct Query | `brop__qCgtVZmK94yNiqTUNf6VvXCEI3wCnFB` | complete, healthy source, matches |
| Fresh skim | `brop_hcBZYPgeKLn37tqZ4MdSEJKJjuo4Z7t3` | created durable session; deliberately cancelled after eight successful sweeps to prove resumability without paying for 416 live calls |
| Level continuation | `brop_KCCiah2EPULIzGZWi0-Fip7wbu721jmS` | same session; eight work units reused before three additional live sweeps; deliberately cancelled |
| Invalid cross-scope continuation | `brop_8dBeLqBvHNJ8QqTuq9NkJ7KF2EwzfY2U` | typed `pgs_scope_non_monotonic`; no silent fallback |
| Targeted fresh `c-13` | `brop_MdppYPi3cPJ6PUJRZUcrkmTMkiHfyeb9` | complete; one new work unit; scope complete; global full coverage false |
| Targeted union `c-13,c-14` | `brop_mHh5oy2XorE4FxtMs7RtYPRQ6ut96_9r` | complete; one reused and one new work unit; exact union complete |
| Targeted reattach/reuse | `brop_NU2adA5j_Co0---m40sBEMGEQ3ognmkM` | complete; two reused, zero new, no repeated sweep |
| Final Jerry agent tool | `brop_-OH07c5C0qrMJpqbgAtMNHEmYrJFxrqc` | `brain_status` complete; healthy manifest-v1; fresh ANN; 142,231/465,991; no diagnostics or fallback |

The full live 4,152-call provider sweep was intentionally not purchased. The same full-drain path completed against an isolated production-scale fixture with 100,000 nodes, 300,000 edges, and 400 partitions in about 57 seconds, as permitted by the approved design's live-acceptance boundary.

## Capacity and Leak Proof

- Two real Jerry acceptance sessions occupy 903 MiB total; each durable SQLite projection is 446 MiB. Continuations reuse that database and do not copy it.
- Both sessions have no live lease after terminalization. Jerry and Forrest each report zero nonterminal brain operations.
- A post-restart targeted continuation rose from about 99 MiB dashboard RSS to about 416 MiB while opening the source/session, then settled to a 280 MiB physical footprint. No PGS database descriptor or worker child remained open.
- The final dashboard restart loaded the retention fix at about 187-189 MiB per dashboard. The acceptance session files remain intentionally continuable until 2026-07-19; automatic bounded cleanup reclaims them before later admission after expiry.
- Current free disk at closeout was 8.7 GiB. The independent 1 GiB free-space floor remains authoritative even when configured session quotas are larger than currently available disk.

## Automated Verification

- Full `npm test`: pass.
  - isolated acceptance runtime: 24/24
  - agent/dashboard/scheduler/worker suite: 208/208
  - COSMO/shared source suite: 367/367
  - engine suite: 1,122/1,122
  - scripts suite: 91/91
  - legacy memory routes: 2/2
- `npm run test:contracts`: 40 pass, 1 intentional live skip, 0 fail.
- `npm run build`: pass.
- Final affected PGS/dashboard matrix: 233 applicable JavaScript tests passed; the normal project runner subsequently passed all TypeScript agent tests.
- PGS session authority after automatic retention admission: 22/22.
- Focused PGS store/worker/coordinator checks covered cancellation, interruption, failure lineage, quota reservation, retry starvation, more than 256 work units, deterministic cumulative levels, targeted unions, scope/global receipts, and schema-v2 refusal.

## Final Runtime

The final code-loading restart was limited to the two dashboards because the last retention change lives there. Engines, harnesses, MCP services, and COSMO had already received the broader approved restart earlier in this repair.

| Process | PID | State |
|---|---:|---|
| `home23-cosmo23` | 83750 | online |
| `home23-jerry` | 83960 | online |
| `home23-forrest` | 84154 | online |
| `home23-jerry-dash` | 64783 | online |
| `home23-forrest-dash` | 64795 | online |
| `home23-jerry-harness` | 84221 | online |
| `home23-forrest-harness` | 84255 | online |
| `home23-jerry-mcp` | 66269 | online |
| `home23-forrest-mcp` | 66282 | online |

Final HTTP readbacks were 200 for Jerry and Forrest Query catalogs, both MCP health routes, Jerry's chat bridge, and COSMO status. Both Query catalogs were available with 52 models and selected their own resident brains. Both MCP routes reported healthy source authority at their current native revisions.

## Retained Boundaries

Runtime sessions under `instances/*/runtime/pgs-sessions` are ignored local installation state and are not Git deliverables. They are retained only for the bounded continuation window and then reclaimed through session authority. The portable source, tests, schemas, design, plan, and this receipt are the deliverable.

## 2026-07-14 Current-State Correction

The capacity figures above were an accurate July 12 snapshot, not a permanent
inventory. After the broader Query/iOS acceptance work, Jerry retains 14
seven-day PGS sessions totaling 6.1 GiB, with 17 GiB free on the data volume.
This remains below the 32 GiB per-agent cap. The retained sessions include
acceptance and recovery sources that expire between July 19 and July 21; they
were not deleted because they are operator runtime data and remain valid
continuation authority.

The final recovery reused one existing 449 MiB immutable session projection
across every continuation. No continuation copied that projection. The current
closeout and exact operation lineage are recorded in
`docs/receipts/2026-07-14-query-pgs-recovery-closeout.md`.
