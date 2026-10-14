# Owner recall ranking repair

Lead: Codex. Checkout: Home23 `fix/owner-recall-ranking`, starting commit
`9c69d6fc` (main includes PR 43). No borrowed source edits. Preserve existing
untracked dependency links.

Authorization: source edits and synthetic fixture verification. No live home
access, PM2, commits, pushes, deployment, or secrets.

Outcome: meaningful relationship overlap, owner calendar windows in
America/New_York, and bounded read-only transcript excerpts for thin owner heads.
Quoted owner dates use authorized local time-window recall rather than graph scans.

Ownership:

- Relationship worker: ledger overlap, candidate ranking, ledger regressions.
- Owner recall worker: calendar parsing, transcript resolver and resolver tests.
- Lead: brain tool integration, end-to-end regressions, review and verification.

Implementation:

- Relationship federation reports meaningful whole-word overlap. A correction
  receives a small relevance-scaled tie-break instead of a flat 900-point boost.
- Owner windows use America/New_York, including DST. Thin in-window heads qualify
  before transcript topic matching. Owner hits lead dated recovered rankings.
- Fresh dated own-brain requests resolve canonical ownership, then read the
  scoped owner stores directly. Quoted dates never force a graph logical scan.
  Empty and unavailable scoped reads remain distinct; no durable receipt is invented.
- One read-only snapshot resolves quote-gated canonical owner sessions or cited
  raw owner turns and their assistant context. Group, peer, scheduler, worker,
  delegated, tool and credential-shaped content cannot earn owner attribution.
  Owner wording remains verbatim within the excerpt; assistant text is clipped.
- Reads cap at 8 MiB per search and 1 MiB per file. Discovery caps at 8192 directory
  entries and 128 files. The parsed-file cache uses file identity and timestamps,
  with a 32-file/4-MiB-character ceiling. Capped and unavailable excerpts are visible
  separately from ledger/fact health. No graph writes or backfill are needed.
- The loop passes the configured owner-distill session gap into recall. Completed
  search recovery upgrades same-ID thin indexed copies and preserves durable handles.

Changed files:

- `src/agent/tools/brain.ts`
- `src/agent/owner-conversation-recall.ts`
- `src/agent/owner-conversation-transcripts.ts` (new)
- `src/agent/relationship-ledger.ts`
- `src/agent/loop.ts`
- `src/agent/types.ts`
- `tests/agent/tools/brain.test.ts`
- `tests/agent/owner-conversation-recall.test.ts` (new)
- `tests/agent/relationship-ledger.test.ts`
- `package.json` (register the new suite)
- This handoff.

Verification commands (synthetic temporary fixtures only):

```sh
TZ=UTC node --import tsx --test --test-concurrency=1 tests/agent/owner-distill.test.ts tests/agent/owner-conversation-recall.test.ts tests/agent/relationship-ledger.test.ts tests/agent/owner-personal-context.test.ts tests/agent/memory-objects-provenance.test.ts tests/agent/tools/relationship-tool.test.ts tests/agent/tools/brain.test.ts tests/agent/context-loop.test.ts
node --test --test-concurrency=1 tests/engine/dashboard/memory-search.test.js tests/engine/dashboard/memory-search-embedding.test.js tests/engine/dashboard/brain-source-executors.test.js tests/engine/dashboard/memory-search-routes.test.js tests/engine/dashboard/memory-delta-overlay-cache.test.js
node --import tsx --test --test-concurrency=1 tests/agent/brain-operations-client.test.ts tests/agent/context-brain-retrieval.test.ts
node --test tests/engine/package-test-registration.test.cjs
node node_modules/typescript/bin/tsc --noEmit
git diff --check
```

Engine search: 170 passed. Registration: five passed. Client/context: 65 passed,
three failed at `listen EPERM` on `127.0.0.1`, before the HTTP assertions ran:

- real client stays attached while a durable legacy source pin is still projecting
- real store, reader, router, and client preserve exact cancel and no-result terminal envelopes
- real coordinator and router detach then reopen the same attachment ID across a compacted gap

Integrated owner/tool/context suite with `TZ=UTC`: 183 passed, zero failed.
TypeScript `--noEmit` and `git diff --check`: passed. Full `npm test` was not run.
Final integration review found no remaining actionable issues in the reported cases.
Regressions cover the exact long Oct 14 query and quoted ISO date, 12 older generic
corrections, thin heads, undated transcript-only topics, source/session mapping,
privacy and owner-channel exclusions, caps/cache, recovered duplicate IDs, custom
session gaps, long tail quotes, compaction/terminal boundaries, after-noon persistence,
older reordered refs, queued Work, canonical timestamp precedence and future replies.

Remaining bounds: without authenticated canonical session contacts, only the
cited raw owner turn and its safe same-turn assistant are eligible. Missing or
capped sources retain the distilled head and report transcript unavailability or
incompleteness. Raw occurrence mapping without canonical contact timestamps uses
the unique nearest compatible quote-matched pending onset and reports inference as
incomplete; tied sources remain unresolved. Date eligibility retains the latest
preserved owner-evidence timestamp, rather than inventing dates for overwritten quotes.
No live retrieval or activation has been performed.

Source-only task finished and verified. Branch remains `fix/owner-recall-ranking`
at `9c69d6fc`; all task edits remain uncommitted, as requested. The existing
dependency links remain unchanged. No activation is authorized. The three localhost
HTTP fixtures still require an environment that permits isolated listeners.
