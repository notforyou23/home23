# ShakedownJerry Proposer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Spec:** `docs/superpowers/specs/2026-07-25-shakedown-jerry-proposer-design.md`

**Goal:** Get the Shakedown automations running in Home23, owned by Jerry, with full read access to
the Shakedown surface — then add a proposer that suggests the next useful thing, with jtr approving.

**Supersedes:** `2026-07-21-shakedown-jerry-worker-runtime.md` Tasks 14–33. That plan's Tasks 1–13
are built on `codex/shakedown-jerry-recovery-port` and are retained.

**Tech:** Home23 cron (`config/cron-jobs.json`, `payload.kind: "exec"`), existing Shakedown npm
entrypoints, Node/Bun, Jerry's brain, markdown queue.

## Global constraints

- **Attended execution.** One task per session, reviewed before the next. No unattended loops, no
  auto-refill, hard account-level spend cap. This plan exists because unattended agent execution
  cost roughly $3,000 on 2026-07-24.
- **The active Shakedown checkout is read-only to automation.** `/Users/jtr/websites/shakedownshuffle.com`
  is a dirty `velvet-sunset` worktree at `2f0c832`, snapshotted at `snapshot/velvet-sunset-20260724`.
  Never reset, clean, switch, or stage it. Lane 1 scripts run *in place* and write only where they
  already write.
- **Never write `shakedown-v2/dist`** — Caddy serves it at `v2.shakedownshuffle.com`.
- **Never edit `html/` directly**; preserve and hash-check `html/pro` and `html/env-config.js`.
- **Never auto-promote a collection release candidate.** The current automation explicitly does not,
  and neither does this.
- **Substack stays manual.** No `pipeline:distribute-substack:*` entrypoint is ever cron-registered,
  and the `:unattended` variants are never used.
- **No Codex definition is deleted.** Cutover pauses an exact ID only after its replacement has run
  successfully with a next wake recorded. Rollback is re-enabling that exact ID.
- Commit after each green task with only that task's files.

---

## Milestone 1 — Access and Lane 1

### Task 1: Inventory what actually runs, and separate script from judgment

The two ACTIVE Codex automations wrapped deterministic entrypoints in agent narration. Before
replacing them, establish which parts were the script and which were the model — the parts that were
the model either move to Lane 2 later or are dropped deliberately.

- [ ] Record the current state of both ACTIVE automations from `~/.codex/automations/`:
      `shakedown-show-detail-enrichment-ops` (daily 15:00) and
      `shakedown-publishing-pipeline-scan` (daily 09:30), including their `memory.md`.
- [ ] Run each entrypoint by hand from its real cwd and capture output and receipt paths:
      - `ops/jerry-collection`: `npm run non-audio:daily:local`, `npm run non-audio:verify`,
        `npm run collection:daily:local`, `npm run editorial:leads`, `npm run non-audio:readiness`
      - `shakedown-v2`: `npm run pipeline:scan`, `npm run check:operator`
- [ ] For each, write down: exit behavior, runtime, what files it wrote, what receipt it emitted,
      and whether it is idempotent on immediate replay.
- [ ] **Answer explicitly:** does `run-non-audio-daily.mjs` generate the show-note prose itself, or
      did the Codex agent write it? If the agent wrote it, that is judgment and belongs in Lane 2 —
      record it as a gap rather than silently losing it.
- [ ] Write findings to `instances/jerry/workspace/projects/shakedownshuffle/OPERATIONS.md`.

**Verify:** every command above has a recorded runtime, receipt path, and script-vs-judgment
verdict. No command is registered as cron until it has run clean by hand at least twice.

**Status 2026-07-25 — COMPLETE.** `OPERATIONS.md` written. Resolved:

- **Broken npm aliases** — 23 of 27 omitted the required `--config`. Fixed in
  `ops/jerry-collection/package.json`; two alias-pinning tests updated; `npm test` 532/532.
- **Script vs judgment** — prose is script-generated. No model call exists anywhere in
  `ops/jerry-collection` or `jerry-api/show-enrichment`. Nothing is lost moving the lane to Lane 1.
- **Supervised apply runs** — all three ran clean twice with jtr present:
  non-audio 7.9s/8.3s, verify 23.5s passed, collection 326.7s/312.3s `waiting_for_batch_pair`.
- **Idempotency** — verified by the script itself; each collection receipt carries
  `discovery.replayVerified: true`.
- **Full lane runtime ~5.6 min**, dominated by collection search. Use `timeoutSeconds: 1800`.
- **Cursor wrapped into pass 2** (`462 → 502 → 6`, `passNumber: 2`) — expected; a full first
  pass over the 535 `wanted` shows is now complete. Expect lower candidate yield in pass 2.

### Task 2: Give Home23 read access to the Shakedown surface

"Access to it all" is the point of the whole exercise. Jerry should be able to answer questions
about Shakedown without a human fetching files.

- [ ] Add a read-only Shakedown surface config listing the authoritative paths:
      site repo roots (`shakedown-v2`, `jerry-api`, `html`, `ops/*`), collection data
      (`/Users/jtr/_JTR23_/jerry-collection/*.json`), enrichment artifacts
      (`jerry-api/show-enrichment/artifacts`), publish outputs
      (`shakedown-v2/outputs/publishing-pipeline`), and receipts.
- [ ] Confirm Jerry can read Matomo (`localhost:8081`) read-only.
- [ ] Confirm Jerry can read Supabase and Stripe **aggregate** state — counts and status only, never
      recipient-level rows.
- [ ] Verify no write path is granted anywhere in this task.

**Verify:** ask Jerry, in conversation, "what is the state of the Shakedown collection and the site
right now?" and get an answer sourced from real files with paths, not from memory.

**Status 2026-07-25 — COMPLETE, with one finding that changes Task 7.**
Artifact: `instances/jerry/workspace/projects/shakedownshuffle/surface.json`.

- Access did not need granting. `src/agent/tools/files.ts` `resolvePath` returns absolute paths
  unchanged and there is **no path policy layer in `src/agent/`**, so Jerry already has
  unconfined read *and write* across the filesystem. The real gap was discoverability.
- `ops/jerry-collection/config.json` is the existing path authority — it already defines
  `catalogPath`, `inventoryPath`, `enrichmentRoot`, `runtimeDir`, and `newsletterIndexPath`
  (which points back into Jerry's workspace). `surface.json` pins its hash `cdc190f8…` rather
  than duplicating values, so drift is detectable.
- Matomo `localhost:8081` → HTTP 200. `jerry-api` online in PM2.
- Verified end-to-end reading only paths `surface.json` names: collection cursor 6 / pass 2,
  wanted-list 1,783 (535 wanted / 1,117 have_audio / 131 discovered), last run
  `waiting_for_batch_pair`, publishing total 25 / 6 owned-live / 24 distributed.
- `neverRead` and `neverWrite` recorded and **explicitly marked unenforced**.
  `jerry-api/.env` holds `SUPABASE_SERVICE_KEY` and `STRIPE_SECRET_KEY`, reachable by
  `read_file` today.

**The "no write path granted" step cannot pass as written.** This task granted none, but
unconfined write already exists.

**Consequence for Task 7:** the proposer cannot receive the standard toolset. It needs a
restricted reader bound to the `surface.json` read roots plus a writer bound to its workspace
and the content queue. Verified requirement, not a design preference.

**Open decision for jtr:** whether to add path confinement to `files.ts` itself. It would
protect Jerry and Forrest too, but changes Home23's core tool layer and may break agent
behavior relying on arbitrary path reach.

### Task 3: Register the collection lane

Replacement for `shakedown-show-detail-enrichment-ops`.

> **Task 1 outcome.** The `ops/jerry-collection` aliases were broken (23 of 27 omitted the
> required `--config`) and were **fixed on 2026-07-25**. `npm run` is now the correct form.

- [ ] Add `shakedown-collection-daily` to `config/cron-jobs.json`:
      `schedule: { kind: "cron", expr: "0 15 * * *", tz: "America/New_York" }`,
      `queueClass: "background"`, `sessionTarget: "isolated"`,
      `delivery: { mode: "failures" }`,
      `payload: { kind: "exec", cwd: "/Users/jtr/websites/shakedownshuffle.com/ops/jerry-collection",
      timeoutSeconds: <verification-dominated; set after the Task 1 apply runs> }`.
- [ ] The command runs the three entrypoints **in order**, stopping on first failure:
      ```
      npm run non-audio:daily:local && npm run non-audio:verify && npm run collection:daily:local
      ```
- [ ] Size `timeoutSeconds` around the **verification** step — it runs 532 ops tests, frontend
      lint, a frontend build, and 19 operator checks. It dominates the lane's runtime.
- [ ] Preserve `waiting_for_batch_pair` as an expected, non-failing state.
- [ ] Do not include any promote step.
- [ ] Leave the Codex automation PAUSED as it currently is; do not re-enable it. Parity in Task 5
      compares against the 2026-07-22 receipts, which are the last real Codex run.

**Status 2026-07-25 — REGISTERED AND LIVE. Verify step pending the first real run.**

Job `shakedown-collection-daily` is in the live scheduler store, `enabled: true`, first fire
**2026-07-25 15:00 EDT**. All five pre-existing jobs preserved.

Verified before registering: `exec` payloads are shell-interpreted (`execAsync` in `home.ts:763`,
so `&&` works); `cwd` is honored; default timeout is only **60s**, so `timeoutSeconds: 1800` is
mandatory; `maxBuffer` is 10 MB against ~70 KB of lane output; `unprivilegedChildEnv` strips only
two Home23 keys so `npm` resolves on the inherited PATH; the chain short-circuits on failure
(exit 1) and succeeds cleanly (exit 0); and `waiting_for_batch_pair` exits 0, so the expected
steady state will not spam failure delivery.

**Two cron stores — essential for any future cron work:**

- `config/cron-jobs.json` — seed config, read **once at harness startup**, no watcher.
- `instances/jerry/conversations/cron-jobs.json` — live scheduler store (62 jobs) holding state
  and `nextRunAtMs`.

Editing the seed does nothing until restart. **The scheduler runs in `home23-jerry-harness`
(`home.js`), not `home23-jerry` (`index.js`)** — the latter is the engine and restarting it has
no effect on cron loading. Confirmation appears in `instances/jerry/logs/harness-out.log`:
`[home] Loaded 1 new and updated 5 cron job(s) from config/cron-jobs.json (6 total in file)`.

Remaining for Task 3:

- [ ] First real 15:00 run produces a receipt matching the Codex shape, and `nextRunAtMs` advances.
- [ ] Confirm a forced failure reports through `delivery.mode: "failures"`.

**Verify:** one real overnight run produces the same receipt shape as the Codex automation, and
`nextRunAtMs` advances. A forced failure reports through `delivery.mode: "failures"`.

### Task 4: Register the scan, operator, and leads lanes

- [ ] `shakedown-publish-scan` — `expr: "30 9 * * *"`, cwd `shakedown-v2`, command
      `npm run pipeline:scan`. Scan only. No build, no deploy, no distribute.
      Measured 11.5s; receipt `outputs/publishing-pipeline/runs/<ts>-scan.json`.
- [ ] `shakedown-operator-check` — `expr: "0 7 * * *"`, cwd `shakedown-v2`, command
      `npm run check:operator`. Measured 14.6s; report
      `operator-reports/shakedown-operator-check-<ts>.json`.
- [ ] `shakedown-editorial-leads` — `expr: "30 15 * * *"`, cwd `ops/jerry-collection`, command
      `npm run editorial:leads`. Runs after the collection lane so leads reflect fresh state.
- [ ] Each job individually `enabled` toggleable; none depends on another's process.

**Status 2026-07-25 — REGISTERED AND LIVE. Verify step pending three days of clean runs.**
All three in the live scheduler store after harness restart (`Loaded 3 new and updated 6 ...
(9 total in file)`). `editorial:leads` ran clean by hand twice first (0.62s/0.47s). Timeouts:
operator 300s, scan 600s, leads 300s. First fires: leads today 15:30 ET; operator Sun 07:00;
scan Sun 09:30. Collection job's 15:00 fire unaffected by the restart.

**Verify:** three consecutive days of clean runs with receipts and advancing next wakes. Disabling
any one job leaves the others running.

### Task 5: Prove parity and pause the two ACTIVE Codex automations

- [ ] For each ACTIVE automation, place its last Codex receipt beside the Home23 replacement's
      receipt for the same day and confirm equivalent consequence.
- [ ] Pause `shakedown-show-detail-enrichment-ops`; record the exact ID and the re-enable step.
- [ ] Pause `shakedown-publishing-pipeline-scan`; same.
- [ ] Write the cutover record to
      `config/worker-migrations/shakedown-automation-cutover.md` — ID, replacement job, parity
      receipt pair, rollback command.
- [ ] Leave all 19 already-PAUSED automations untouched and undeleted.

**Verify:** both IDs read PAUSED, both Home23 jobs have advanced next wakes, and the cutover record
names an exact rollback for each. Nothing was deleted.

---

## Milestone 2 — Visibility

### Task 6: One Shakedown status surface, including the money path

Shakedown is the income stream. Jerry should be able to state its health and its funnel without
anyone opening a dashboard.

- [ ] Build a read-only status assembler that reports, from authoritative sources:
      - collection: shows catalog size, audio inventory, wanted-list position, quarantine count
      - enrichment: artifact freshness, last validation
      - site: last publish, current release, route/API/audio health from `check:operator`
      - funnel: sessions, top routes, listener starts (Matomo); signups and active entitlements
        (Supabase/Stripe **aggregate counts only**)
      - jobs: each Lane 1 job's last result and next wake
- [ ] Surface it in Jerry's pre-turn context so it is available in conversation.
- [ ] No recipient-level data anywhere in this output.

**Verify:** ask Jerry "how is Shakedown doing?" and get collection, site, job, and funnel state in
one answer, each line traceable to a file or API readback.

---

## Milestone 3 — The proposer

### Task 7: ShakedownJerry reads and reports, proposes nothing

- [ ] Create the worker workspace at `instances/workers/shakedown-jerry/workspace/` with
      `IDENTITY.md`, `PLAYBOOK.md`, `NOW.md`, and `state/`.
- [ ] Grant read scopes only: the Task 2 surface, the Task 6 status, and Jerry's brain scoped to
      `shakedownshuffle`, `jerry-garcia`, `public-research`.
- [ ] **Do not give the proposer the standard `files.ts` toolset.** Task 2 verified that
      `read_file`/`write_file`/`edit_file` are unconfined — absolute paths pass straight through
      and no path policy layer exists. Build a reader bound to the `surface.json` read roots and
      a writer bound to the worker workspace plus the content queue, honoring `neverRead`.
- [ ] Register `shakedown-proposer-cycle`, `expr: "0 */6 * * *"`, bounded to
      **20 minutes, 60k tokens, 40 tool calls**.
- [ ] Each run writes exactly one run note to `workspace/runs/<timestamp>.md` and nothing else.
- [ ] Add an attempted-write test proving the proposer cannot write outside its workspace.

**Verify:** four consecutive runs produce run notes citing real evidence; the attempted-write test
fails closed; killing a run mid-flight leaves only a partial note.

### Task 8: Opportunity ledger and queue proposals

- [ ] Append-only `workspace/state/opportunities.jsonl` with the fields named in the spec.
- [ ] Each run writes at most **5** new proposals into
      `instances/jerry/workspace/projects/shakedownshuffle/content/article-editorial-queue.md`
      using the `[proposed]` block format from the spec: why, evidence refs, named action, risk.
- [ ] Drafts, where a proposal needs one, go to `content/drafts/`.
- [ ] Every proposal's `action` names an existing Lane 1 script and arguments. A proposal whose
      action has no script is invalid and must not be written.
- [ ] Lanes are independent — a failing collection lane never suppresses a content proposal.

**Verify:** a week of proposals where every entry has real evidence references and a named,
runnable action. jtr reads them without needing to ask what any of them mean.

---

## Milestone 4 — Closing the loop

### Task 9: Approval executes

- [ ] Add `shakedown-approval-runner` cron job, `expr: "*/30 * * * *"`, that scans the queue for
      `[approved]` entries.
- [ ] For each, execute the named Lane 1 script with its recorded arguments, exactly once,
      keyed by `opportunityId`.
- [ ] Record the outcome against the ledger entry and mark the queue entry `[done]`.
- [ ] `[rejected]` entries record the reason into the ledger and are never executed.
- [ ] Any script failure marks the entry `[failed]` with the error and does not retry blindly.
- [ ] Site-publishing actions run through the existing snapshot-first path with rollback.

**Verify:** approve one low-risk proposal end to end; confirm exactly one execution, a real
consequence, an outcome recorded against the `opportunityId`, and a working rollback address.

---

## Milestone 5 — Learning

### Task 10: Readbacks and scoring

- [ ] One-shot readbacks at short, 24-hour, and 7-day windows after an executed action.
- [ ] Update channel and content-type scores from measured outcomes, not from intent.
- [ ] Retire proposal types that repeatedly get rejected or produce no measurable outcome.
- [ ] Feed rejection reasons into ranking.

**Verify:** ranking visibly changes after a month of outcomes; a consistently-rejected proposal type
stops appearing.

---

## Deliberately not in this plan

- Authority-grant signing, policy engine, capability registry, fencing, safety-reserve budgets
- Autonomous publishing, sending, or spending
- A production payment canary
- Any second distribution channel — added later only if jtr wants one
- A new dashboard
- Migration of the 19 already-PAUSED Codex automations
- Further tasks from the 2026-07-21 plan to justify the built Worker runtime

## Earned automation, later

Not a task. After a lane accumulates 20 approvals with no rejections or edits in the last 10, over
at least 4 weeks, that lane may move to approval-by-default with a kill switch. External channels,
email, and money never qualify.
