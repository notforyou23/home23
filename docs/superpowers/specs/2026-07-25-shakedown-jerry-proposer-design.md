# ShakedownJerry as Proposer — Design

Date: 2026-07-25
Status: draft for jtr review
Supersedes: `2026-07-21-shakedown-jerry-worker-runtime-design.md` for everything after the
generic Worker runtime repair. That document's Tasks 1–13 are built and retained; its
Tasks 16–33 are withdrawn and replaced by this design.

## Decision

Shakedown work is split along the seam where risk actually changes, and each piece gets
only the machinery its risk warrants.

- **Deterministic operations stay deterministic scripts** on Home23 cron. No agent, no
  capability registry, no authority grant.
- **ShakedownJerry becomes a proposer.** It observes, ranks opportunities, and writes
  candidates and drafts into a queue. It has no authority to publish, send, spend, or
  mutate production. Its worst failure is a bad draft in a file.
- **Irreversible actions require jtr**, through one approval surface, until a specific lane
  has earned narrower automation from measured behavior.

The 2026-07-21 design fused these three into one worker with one authority model, then
built cryptographic grants, fencing epochs, three two-phase-commit journals, and a
non-model safety reserve to make that fusion safe. Those mechanisms defend against
adversaries and concurrency that do not exist on a single-operator Mac. This design
removes the fusion instead of defending it.

## Why this shape

Evidence that argued for it:

- **19 of the 21 Codex automations were already PAUSED** at the time the prior spec was
  written. Only `shakedown-publishing-pipeline-scan` and
  `shakedown-show-detail-enrichment-ops` were ACTIVE. A rigorous migration for 19 dormant
  definitions is migration of dead weight.
- **The deterministic work already exists and already works.** The collection sequence,
  enrichment machinery, publish pipeline, Substack adapters, and operator checks are
  written and receipted. They did not need an agent before and do not need one now.
- **Home23 cron already runs plain commands.** `config/cron-jobs.json` supports
  `payload: { kind: "exec", command, cwd, timeoutSeconds }` with `delivery.mode: "failures"`.
  The deterministic lane needs no new runtime.
- **The approval surface partly exists.**
  `instances/jerry/workspace/projects/shakedownshuffle/content/` already holds
  `article-editorial-queue.md`, `article-inventory.md`, and `drafts/`.
- **The prior plan's first useful output arrived at Task 31 of 33.** A feedback loop that
  long is mis-specified for a solo operator regardless of the quality of each step.

The earlier house doctrine in `instances/jerry/workspace/projects/agent-migration/`
already said this: *implement workflows before adding bodies; verify they solve real pain
before personifying them*. This design returns to that rule.

## Operating context

Work on this system halted on 2026-07-24 after unattended agent execution produced
roughly $3,000 in automated charges. Two consequences are binding here:

1. **Build sessions are attended.** No unattended development loops, no auto-refill, a
   hard account-level spend cap, one milestone per session with review between.
2. **The runtime the proposer uses must be interruptible and bounded.** A proposer run
   that is killed mid-flight must leave nothing but a partial draft.

## What is not rebuilt

These remain exactly as they are, own their domains, and are outside this design:

| Component | Role |
| --- | --- |
| `com.jtr.shakedown-watchdog` (120s launchd) | Deterministic `jerry-api` recovery owner |
| `ops/dynamic-dns` | Independent DNS operator |
| `com.jtr.matomo` (`localhost:8081`) | Analytics authority; proposer gets read-only |
| `homebrew.mxcl.caddy`, `com.jtr.caddy-static` | Web/proxy and audio-static owners |
| PM2 `jerry-api` | Backend service |
| Jerry Collection Manager and action worker | Retained until parity is observed, never deleted |
| Jerry's brain | Sole semantic memory; the proposer reads it and creates no second graph |

## Architecture

```text
                     ┌──────────────── Lane 1: deterministic ────────────────┐
Home23 cron (exec) ──▶ collection sequence · enrichment · site build         │
                     │ operator checks · sitemap/IndexNow                    │
                     └───────────────────────┬──────────────────────────────┘
                                             │ receipts + state
                                             ▼
                     ┌──────────────── Lane 2: proposer ─────────────────────┐
Home23 cron ────────▶ ShakedownJerry: read evidence, rank opportunities,     │
                     │ write candidates + drafts. Writes ONLY to its         │
                     │ own workspace and the queue.                          │
                     └───────────────────────┬──────────────────────────────┘
                                             │ queue entries
                                             ▼
                     ┌──────────────── Lane 3: approval ─────────────────────┐
jtr reviews queue ──▶ approve → invokes a Lane 1 script                      │
                     │ reject  → records why, feeds ranking                  │
                     └──────────────────────────────────────────────────────┘
```

Lane 1 never calls Lane 2. Lane 2 never calls Lane 1. Lane 3 is the only path between
them, and it is a human until a lane earns otherwise.

## Lane 1 — deterministic operations

Existing scripts, registered as Home23 cron `exec` payloads. Each one:

- runs from a fixed `cwd` with a `timeoutSeconds` bound;
- writes its own receipt where it already writes one;
- reports through `delivery.mode: "failures"` so silence means success;
- is individually enable/disable-able in `config/cron-jobs.json`.

Initial registrations, `America/New_York`:

| Job | Schedule | Command |
| --- | --- | --- |
| `shakedown-collection-daily` | `0 15 * * *` | Existing `non-audio:daily:local` → `non-audio:verify` → `collection:daily:local` sequence |
| `shakedown-enrichment-daily` | `30 15 * * *` | Existing show-enrichment local run and validation |
| `shakedown-operator-check` | `0 7 * * *` | `shakedown-v2/scripts/operator-check.mjs` |
| `shakedown-publish-scan` | `30 9 * * *` | `shakedown-v2/scripts/shakedown-publish-pipeline.mjs` in scan-only mode |

Rules that carry over unchanged from the 2026-07-21 design, because they protect things
that are genuinely irreplaceable:

- `waiting_for_batch_pair` is an expected state and never forces acquisition.
- Collection promotion is additive, hash-bound, no-overwrite, with provenance, source
  families, watermarks, and a verified rollback snapshot taken before promotion.
- Site publication is snapshot-first: build to a run-specific directory, overlay the
  candidate, verify, and restore the recorded predecessor automatically on failure.
- Never write shared `shakedown-v2/dist` — Caddy serves it at `v2.shakedownshuffle.com`.
- Never edit `html` directly; preserve and hash-check `html/pro` and `html/env-config.js`
  across any cutover.
- The active checkout at `/Users/jtr/websites/shakedownshuffle.com` is never reset,
  cleaned, branch-switched, or used as an editing environment.

## Lane 2 — the proposer

### Identity

ShakedownJerry is owned by Jerry, reuses Jerry's brain, and has no separate conversation,
engine, dashboard, port set, or PM2 process. jtr talks to Jerry about it.

### Mission

> Find the next thing worth doing to make Shakedown Shuffle more useful, surprising, and
> discoverable — and say why, with evidence.

The differentiator is a curated, playable collection of Jerry Garcia performances outside
the Grateful Dead, paired with real context. The proposer builds around that, not around
generic newsletter growth.

### What it may read

- Matomo route, source, campaign, and behavior data (read-only)
- Listener starts, completions, favorites, returns
- Supabase auth/profile state and Stripe entitlement state (read-only, aggregate)
- Lane 1 receipts: collection, enrichment, publish, operator checks
- Content inventory, editorial queue, asset readiness, broken links
- Search demand and indexing coverage
- Jerry's brain, scoped to `shakedownshuffle`, `jerry-garcia`, `public-research`

Private, personal, health, credential, and unrelated brain context is unavailable.
Recipient-level data is never read; funnel evidence is aggregate only.

### What it may write

Exactly two places:

1. `instances/workers/shakedown-jerry/workspace/` — its own state, opportunity ledger,
   channel scores, and run notes.
2. `instances/jerry/workspace/projects/shakedownshuffle/content/` — queue entries in
   `article-editorial-queue.md` and drafts in `drafts/`.

Nothing else. No repo writes, no `html`, no database, no network posting, no email. This
is enforced by giving the proposer no tool that can do those things, not by a policy
engine that decides not to.

### Opportunity ledger

One append-only ledger at `workspace/state/opportunities.jsonl`, each entry carrying:

```text
opportunityId · type · lane
sourceEvidence[] with freshness
audience and expected consequence
destination route
effort · confidence · novelty · risk
proposedAction (what a human would approve)
state: proposed | approved | rejected | expired | done
outcomeRef (set after the fact by a readback job)
```

Lanes are independent. A stalled collection lane never blocks a content proposal.

### Run shape

```text
wake (cron)
  -> load state, prior outcomes, fresh Lane 1 receipts and analytics
  -> rank opportunities
  -> write or refresh the top N candidates and any drafts they need
  -> write a run note and update the ledger
  -> exit
```

Bounded per run: **20 minutes wall clock, 60k tokens, 40 tool calls, 5 new proposals.**
A run that exceeds any bound stops and writes what it has. A killed run leaves a partial
draft and nothing else.

Schedule: `shakedown-proposer-cycle` at `0 */6 * * *`, and
`shakedown-proposer-weekly` Monday `19 8 * * 1` for re-scoring and retirement.

## Lane 3 — approval

The queue is a markdown file jtr already reads. Each proposal appears as:

```markdown
### [proposed] Feature the 1973-11-01 Keystone run on /today
- why: 41 sessions hit /browse?year=1973 last week, no landing surface exists
- evidence: matomo-2026-07-24.json#route-1973, collection receipt r-8891
- action: approve → runs `publish-today-feature.mjs --show 1973-11-01`
- risk: low · reversible via publish snapshot
```

Approval is jtr editing `[proposed]` to `[approved]`. A Lane 1 cron job picks up approved
entries, executes the named script, records the outcome against the `opportunityId`, and
marks the entry `done`. Rejection is `[rejected]` plus a one-line reason, which feeds
ranking.

No dashboard is built for this. If the markdown loop becomes tedious, the existing Home23
Worker Desk gains a read view later — not before.

## Earned automation

A lane may be automated only when it has evidence, not because it was designed to be:

- at least **20 approvals** in that lane,
- with **no rejections in the last 10**,
- and **no edits** to the proposed action in the last 10,
- over at least **4 weeks**.

Then that lane's script may run on approval-by-default: the proposal is written, and if
jtr does not reject it within a stated window, Lane 1 executes it. Every such lane keeps a
kill switch in `config/cron-jobs.json` and reverts to manual on any failed readback.

Publishing to external channels, sending email, and anything touching money never becomes
approval-by-default under this design.

## Authority

There is no signed grant, no key ceremony, no policy engine.

Authority is structural: the proposer cannot perform an action for which it has no tool.
Lane 1 scripts have real authority but no judgment — they do one fixed thing with fixed
arguments. Lane 3 is a human.

**Permanent hard stops**, enforced by absence of capability and by Lane 1 script design:

- deletion or destructive merge of canonical show, audio, catalog, subscriber, or receipt data
- direct or untyped writes to production databases
- schema, auth, payment, entitlement, credential, account-ownership, or DNS changes
- spending money or starting paid advertising
- bulk or unsolicited messaging, purchased lists, private-data export
- weakening backup, provenance, watermark, validation, privacy, or no-overwrite controls

## Receipts

Kept from the prior design, because it is the best idea in it:

- A narrative response is not evidence.
- A completed action requires consequence evidence appropriate to what it claimed.
- Public publication requires public readback.
- A production change requires runtime and artifact readback plus a rollback address.
- A data promotion requires source, watermark, validation, and crossing evidence.

Lane 1 scripts emit their existing receipt formats. The proposer emits a per-run note with
evidence references and the ledger delta. No new receipt schema is introduced; the v2
receipt work already built on `codex/shakedown-jerry-recovery-port` is available if the
proposer runs through the Worker runtime, but this design does not require it.

## Relationship to the built Worker runtime

`codex/shakedown-jerry-recovery-port` carries 139 commits implementing the generic Worker
runtime (Tasks 1–13 plus stale-run recovery). That work is kept and stays green.

The proposer **may** run as a Worker on that runtime, in its simplest configuration with
no live capabilities. It **must not require** it. If registering the proposer as a cron
`exec` payload is simpler, that is the correct implementation. The runtime is an available
asset, not a dependency, and no further tasks from the 2026-07-21 plan are undertaken to
serve it.

## Codex automation disposition

The 2026-07-21 migration matrix is retained as the inventory of record, with one change in
policy: **the 19 automations that were already PAUSED are not migrated.** They stay paused
and defined. If a specific one is later missed, it is revived deliberately as a Lane 1
script, one at a time, with a reason.

The two that were ACTIVE are replaced by Lane 1 cron jobs:

| Codex automation | Replacement | Cutover |
| --- | --- | --- |
| `shakedown-publishing-pipeline-scan` | `shakedown-publish-scan` | Pause only after the replacement produces one real scan output and a next wake |
| `shakedown-show-detail-enrichment-ops` | `shakedown-collection-daily` + `shakedown-enrichment-daily` | Pause only after separate collection and enrichment consequence receipts |

No definition is deleted. Rollback is re-enabling the exact Codex ID.

## Milestones

Each is independently useful and independently stoppable. This replaces the prior
"one delivery, no intermediate slice" constraint, which produced no feedback until Task 31.

| # | Deliverable | Done when |
| --- | --- | --- |
| 1 | Lane 1 registered | The four scripts run on Home23 cron with receipts and failure delivery; both ACTIVE Codex automations paused after parity |
| 2 | Proposer reads | ShakedownJerry wakes, reads evidence, writes a run note. Proposes nothing yet |
| 3 | Proposer proposes | Ledger and queue entries appear with evidence and a named action. Still no execution path |
| 4 | Approval loop closes | An approved queue entry executes its Lane 1 script and records an outcome |
| 5 | Readback and learning | Timed outcome readbacks update channel scores; weak proposals retire |
| 6 | Earned automation | The first lane meets the threshold and moves to approval-by-default |

Milestone 4 is a working system. Everything after it is refinement.

## Completion contract

- Lane 1 scripts run on schedule, emit receipts, and report failures.
- The proposer cannot write outside its workspace and the queue, demonstrated by an
  attempted-write test.
- Every proposal carries source evidence, a named reversible action, and a risk note.
- An approved proposal executes exactly once and records its outcome against its
  `opportunityId`.
- Site publication and data promotion remain snapshot-backed with proven rollback.
- No Codex definition is deleted, and both replaced ACTIVE automations have parity receipts.
- Jerry can say what ShakedownJerry proposed, why, what jtr approved, and what happened.

## Non-goals

- A third full Home23 agent, or a second brain
- A separate Shakedown conversation or dashboard
- A capability registry, authority-grant signing, or policy engine
- Autonomous publishing, sending, or spending
- A production payment canary (the 2026-07-21 Task 32) — withdrawn, not deferred
- A CMS replacing the existing markdown authorities
- Rebuilding the watchdog, DNS, Matomo, Caddy, or collection manager

## Decisions taken (2026-07-25)

1. **Scope is shakedownshuffle.com.** Only what jtr controls. Other surfaces are addressed
   as they come up, not designed for in advance.
2. **Substack publication is manual, indefinitely.** No `pipeline:distribute-substack:*`
   entrypoint is ever cron-registered and the `:unattended` variants are never used. The
   proposer may prepare a draft; a human publishes it.
3. **No second channel is required.** The prior spec made one a completion blocker. It is
   not one here. If jtr wants one later it is added as its own small piece of work.
4. **The priority is Lane 1 and access**, not the proposer. Getting the automations correct,
   running in Home23, with Jerry able to see the whole Shakedown surface, is the point.
   The proposer is the layer that comes after that is solid.
5. **Shakedown is the income stream.** Site health and the signup → entitlement funnel are
   first-class in the status surface, not an afterthought. Substack existed to drive
   traffic here; the owned site is what matters.

## Still open

- **Proposal volume.** 5 per run every 6 hours is a guess. Tune once it is clear whether
  reviewing them is pleasant or a chore.
- **Show-note prose authorship.** Whether `run-non-audio-daily.mjs` generates the public
  prose itself or the Codex agent wrote it is unresolved. Task 1 of the plan answers this.
  If it was the agent, that judgment moves to the proposer rather than being lost silently.
