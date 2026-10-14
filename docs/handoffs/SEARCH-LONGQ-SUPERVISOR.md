# Long-query search and resident supervisor repair

Task owner: Codex. Branch: `fix/search-longq-supervisor`.
Starting commit: `f993be91f4de0625acaf2c99551299158ac93c6f`.

Scope: dashboard memory retrieval for longer queries, resident supervisor
ownership, no-spawn clients, safe update readiness recovery, and regression tests.
Source edits and a local commit are authorized. No push, live PM2 operation,
service restart, or installed-home change is authorized. Existing dependency
links are unrelated and remain untracked.

Ownership: the memory worker owns memory search and dashboard retrieval tests;
the supervisor worker owns supervisor, admission, Host process definitions,
and their tests. The lead owns update/backup clients, readiness integration,
review, final verification, and the commit. A read-only audit checks PM2 paths.

## Reconciled findings and changes

- Dashboard compact ANN labels lack per-node embedder identity. Retrieval now
  uses the verified ANN generation identity instead of rejecting owned embeddings.
- A query-length phrase heuristic forced ordinary longer queries to scan sources
  after ANN noise filtering. Ordinary queries now retain indexed results. Encoder
  outages use covered keyword labels and deltas. Default fallback scans have a
  4,000-visit and cooperative 1,500 ms bound with incomplete-coverage evidence.
- Update inventory, writer fencing, startup identity checks, and house process
  clients could create plain PM2 daemons. Product clients now forbid spawning;
  house definitions and actual forks remove supervisor control variables.
- Resident startup delegated fatal recovery to PM2's detached self-update path.
  Launchd now owns recovery. Shutdown RPCs are refused, and fatal errors, exit
  codes, and catchable signals receive durable diagnostics.
- Dead residents are distinct from empty homes. Owner-bound update recovery can
  kickstart launchd only after independent executable/cwd and process checks prove
  there are no detached writers. Matching pre-writer admissions are also supported.
  Orphans or ambiguous evidence defer the admitted update without duplicating
  writers or restoring state. Paused registrations remain paused.
- Inventory imports selected supervisor code in a fresh process after selection.
  Prepared/stopped homes can return an empty inventory only with no-writer proof.

The historical exit-code-1 trigger remains unproved without its missing error
receipt. The repaired shutdown and self-update paths are confirmed code hazards.
No installed-home behavior or live latency was verified.

## Verification

- Five memory/dashboard suites: 143 passed. These cover memory-search,
  memory-search-embedding, memory-delta-overlay-cache, network-memory-keyword-index,
  and network-memory-cooperative-retrieval.
- Synthetic 55,000-label indexed queries: 206–222 ms, zero source reads. Embedding
  and ANN search were injected; this is not a live-brain timing receipt.
- Guarded clients, CLI/shared startup, engine channels/snapshot/remediation,
  startup identity, and dashboard runtime health: 74 passed.
- `npm run test:runtime-regressions`: 103 passed, 11 failed. Each failure hit the
  sandbox's loopback socket `listen EPERM` restriction.
- Product update/Host/supervisor/backup/semantic CLI subset, including
  `tests/product-supervisor.test.mjs`: 318 passed, 88 failed from socket `EPERM`,
  one optional real-payload test skipped.
- New update inventory/recovery selection: four passed. The added regressions
  reproduced their defects before the fixes.
- Independent cross-review found and resolved the stopped-home inventory and
  old-package module-cache regressions. Syntax and `git diff --check` passed.

## Remaining action

Source and tests are uncommitted. Git staging failed because this session cannot
create `.git/index.lock`. The lead's next action is to stage only task files and
commit when Git metadata writes are permitted; do not stage dependency links.
Rerun socket-dependent verification in an environment that permits isolated
fixture listeners. No push or production activation is authorized.
