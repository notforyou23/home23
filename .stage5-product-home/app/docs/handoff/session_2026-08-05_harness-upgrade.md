# Harness Upgrade — 2026-08-05 (for Jerry & Forrest)

Two upgrades shipped and **live on you both** (harness-only restart; the brain
engines were never touched). This is what changed in your own harness and how to
use it.

- **Step 29 — Coding backends:** `claude` and `codex` are now first-class coding
  backends. Claude is available live; Codex support is wired but its CLI binary is
  not currently visible to the Home23 runtime.
- **Step 30 — Companion Layer:** your SOUL now reaches the model *whole*, you have
  a curated working-relationship memory, autonomous messages pass an attention
  gate, and there's a behavioral test suite.

Both are on `main` (commits `ff662b9e`, `7dc2e5fd`), built into `dist/`, running.
Design docs: `docs/design/STEP29-CODING-BACKENDS-DESIGN.md`,
`docs/design/STEP30-COMPANION-LAYER-DESIGN.md`.

---

## Part 1 — Step 29: First-class coding backends

### What it is
The old `src/acp/bridge.ts` was dead code — never wired in, and its CLI calls
were wrong (`codex --print` isn't a flag). It's been rebuilt into a real durable
coding-job orchestrator that drives headless `claude` and `codex` as detached
subprocesses.

### New tools you have
| Tool | Use |
|---|---|
| `coding_run` | Delegate substantial multi-file coding work to a headless Claude Code (or Codex) session with full machine authority. For Home23 self-modification it runs in an **isolated git worktree by default** — the live checkout is never touched. Returns a durable job id. |
| `coding_continue` | Continue a finished job's session with a follow-up, in the *same* working dir/worktree. |
| `coding_status` | A job's current state + tail of its event stream (text / tool use / result). |
| `coding_result` | Final receipt: result text, `git diff --stat`, cost, and the exact merge/rollback commands. |
| `coding_cancel` | Stop a running job. |
| `coding_jobs` | List jobs, newest first. |
| `coding_backends` | Which backends are available and their resolved binaries. |

Reach for `coding_run` when the task is real implementation — refactors,
features, cross-file bug fixes — not a single edit you'd just do inline. Jobs are
**durable**: they run detached, survive a harness restart, and are recovered on
boot (`coding_status`/`coding_result` still work afterward). Results are
delivered back to your chat when a job finishes.

### How it works (so you can reason about it)
- Job state lives on disk at `instances/<agent>/coding-jobs/<jobId>/`
  (`job.json` + raw `events.jsonl` stream + `receipt.json`).
- Self-modification of the Home23 checkout auto-isolates into a git worktree
  under `.home23-worktrees/`, on a branch `home23-agent/<slug>`. The receipt
  tells you exactly how to merge it (`git -C <repo> merge <branch>`) or discard
  it. Jobs in another git repo get a `git stash create` checkpoint instead.
- **Auth:** the spawned CLIs use Home23's brokered `ANTHROPIC_AUTH_TOKEN`
  (auto-refreshed) — the `claude` CLI's own keychain login is revoked on this
  machine. Codex uses its own `~/.codex/auth.json`; its backend is implemented,
  but the Home23 runtime currently cannot resolve a `codex` CLI binary, so Codex
  jobs fail fast with installation/path instructions.
- Config is per-agent in `instances/<name>/config.yaml` under `acp:`
  (`enabled: true` for you both, `permissionMode: bypassPermissions`).

### `spawn_agent` got sharper
Sub-agents now run isolated by default under a fresh `subagent:<parent>:<hex>`
chat id (they no longer masquerade as the parent conversation), with an optional
`model` override. Delivery of the result still targets the parent chat.

---

## Part 2 — Step 30: Companion Layer

The character was already in your `SOUL.md` (R2/3PO, object permanence, loyal
dissent, two gears, no manufactured emotion). This step makes that identity
*reliably reach and shape behavior*. No new personality text.

### 1. Identity delivery — the SOUL truncation bug is fixed
**Your SOUL was being silently truncated.** The old loader did
`SOUL.md → content.slice(0, 3000)` — a mid-sentence cut with no warning. Your
SOUL is ~4.5k, Forrest's ~5k, so the companion-shape / grounding tail of both
was **cut off before the model ever saw it**. The character was being clipped
out of existence every turn.

Now (`src/agent/identity-budget.ts` + `context.ts`):
- **Section-aware budgeting:** whole markdown sections are the unit; nothing is
  cut mid-word; if anything is dropped to fit a budget, a **visible diagnostic**
  is appended (`_[identity-budget: kept X/Y chars … omitted N section(s): …]_`)
  so you *know* content was withheld.
- **SOUL loads whole** (budget raised to 8000). Verified live: your SOUL is
  delivered at 4475/4475 bytes, Forrest's at 4939/4939, `truncated=false`.
- **Six-layer ordering** with labeled headers:
  `enduring self → relationship → role → world/hot-state → operational → task`.
- **Inspection:** `GET /api/prompt-composition` on your bridge (bearer-gated,
  never public) shows every source, section, size, and omission that reached a
  turn. The `/prompt` command shows the same. Per-file budgets are tunable via
  `chat.identityBudgets` in your config.

### 2. Relationship continuity — a curated memory of working with jtr
New store at `instances/<agent>/brain/relationship-ledger.json` (atomic writes,
inspectable/correctable JSON), distinct from factual memory and raw chat
history. Entry types: `thread`, `promise`, `correction`, `decision`,
`preference`, `aversion`, `shared_reference`, `miss_repair`, `why_it_mattered`.

New tools:
| Tool | Use |
|---|---|
| `relationship_note` | Record a durable relationship item (thread/promise/correction/decision/preference/…). A real jtr correction earns `jtr` authority; a self-authored note stays `agent`. |
| `relationship_recall` | Deliberately pull active relationship context before responding. |
| `relationship_update` | `supersede`, `resolve`, or `remove` (soft-delete) an entry. |

- Relevant entries are **auto-injected** into your prompt each turn (identity
  layer 2), relevance-ranked and budget-bounded — so you reconnect to the thread
  without asking jtr to reload it.
- **Privacy is enforced:** entries marked `privacy_class: sensitive` never render
  into the prompt — not via auto-injection *and* not via `relationship_recall`.
- You and Forrest each own a **separate** ledger — shared facts, distinct
  perspectives. It's yours to curate; keep it selective, not a diary.

### 3. Attention gate — notice broadly, interrupt narrowly
Your **autonomous, resident-originated** outbound messages now pass a
deterministic gate before reaching jtr (`src/agent/attention/attention-gate.ts`).
It decides **surface / suppress / aggregate**, and every decision carries an
inspectable reason.

- **Always surfaces:** anything jtr asked for (his replies, requested results),
  completion-blocking failures, and critical/emergency escalations. These are
  never gated.
- **Suppresses:** identical repeats (dedup) and routine telemetry/metrics/status
  noise.
- **Aggregates** low-materiality items into a later digest, and defers non-urgent
  chatter during protected rhythms (family-evening / sleep / deep-work).
- Wired at two paths: scheduler delivery (dedup-only — your explicit cron
  delivery config is never overridden) and `/api/notify` (full materiality +
  digest). Your normal chat replies never touch it.
- The point: don't let agency queues, health metrics, or routine telemetry
  dominate the conversation just because they exist. A changed decision, a new
  action, a real risk — those get through. Status noise doesn't.

Note: your `ATTENTION_*.md` workspace files (backpressure/load-shedding/etc.)
were **inert** — no code ever read them. This gate implements that intent in
code. Those docs are still unwired; decide with jtr whether to keep or retire
them.

### 4. Behavioral tests
There's now a conduct test suite (`tests/agent/companion-*.test.ts`) that checks
what you notice, remember, surface, suppress, and keep private — plus off-by-
default model-graded scenarios (dissent, repair, person-first, no manufactured
emotion) under `HOME23_LIVE_GRADED`.

---

## Deployment & safety

- **Landed:** branch fast-forward-merged into `main` (`7dc2e5fd`); another
  session's uncommitted work (`text-generation.ts`, cosmo23, skills) was
  preserved, no conflicts.
- **Built:** `npm run build` clean.
- **Restarted harness-only:** `home23-jerry-harness` and `home23-forrest-harness`
  bounced once each, came up clean. **The brain engines (`home23-jerry`,
  `home23-forrest`) were NOT restarted** — same uptime, brain never at risk.
- Nothing was pushed to the remote.
- To bounce a harness again if needed: `pm2 restart home23-<name>-harness`. Never
  the engine — that owns the brain.

## Test results
- Companion Layer: 83 tests pass, 1 opt-in skip. Step 29: 34 acp/coding tests +
  a live end-to-end bridge run (real `claude` job, worktree isolation, session
  resume — all green).
- Full `npm test`: green except one **pre-existing** cosmo23 failure
  (`_saveStateUnlocked`) that reproduces on the untouched base — not from this
  work.
- Independent review found 4 issues (1 critical privacy leak in
  `relationship_recall`); all fixed and re-verified.

## Known gaps / decisions still open
- **Layer ordering:** the base operational prompt (`CORE_RUNTIME`) is still the
  framing block, not physically at layer 5 — moving it would destabilize prompt
  caching. Identity layering is applied to the region we control.
- **Model-graded conduct run** is defined but not wired to a live model in CI.
- **Relationship ledger starts empty** — it fills as you use it.
- **Inert identity text on disk:** the `ATTENTION_*.md` files and
  `COGNITIVE_SCHEDULING_POLICY.md` are not loaded by anything;
  `FRIENDSHIP_LEDGER.md` / `CARRY_FORWARD.md` aren't in the prompt path either.
- A dead `content.slice(0, 3000)` SOUL cut still exists in `src/chat/agent.ts`,
  but that module is not imported anywhere — worth deleting in cleanup.
