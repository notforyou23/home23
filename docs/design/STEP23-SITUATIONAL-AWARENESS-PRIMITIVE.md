# Step 23: Situational + Temporal Awareness Primitive

**Date:** 2026-04-20
**Status:** Shipped (forrest + jerry live; system-level default active)

## Problem

An agent that loads only its static identity on each turn has no grounding in the present moment. The stale-start failure mode was: a chat opens, the model starts answering from accumulated memory and prior-context debt, invents certainty about metrics or system state it hasn't actually seen today, and the human has to steer it back to reality before the real work begins.

Forrest originated the fix organically — a `SOUL.md` "Startup reflex" paragraph telling the model to `Read NOW.md` and `Read PLAYBOOK.md` before doing anything else, backed by a timer-driven Python script that kept NOW.md fresh with live health metrics. It worked, but:

- The reflex text sat in the system prompt **every turn**, so the model sometimes re-read the files on turn 5 even though they were already in conversation history — wasted tokens, wasted tool calls, and a hint of the stale-start loop re-emerging as history rolled.
- The pattern was forrest-specific. Nothing enforced it for other agents, subagents, or cron-spawned isolated sessions. The primary agent (jerry) had no equivalent; scheduled runs that most needed the grounding had to re-prescribe "Read NOW.md first" in every prompt file.
- The reflex was aspirational in any chat path without tool access — the model couldn't execute a `Read` call, so the instruction became a lie in that context.

## Design Principle

**Situational + temporal awareness is a bedrock system primitive, not a per-agent quirk.** Every agent, subagent, and scheduled isolated session wakes up grounded in the present. The harness does the grounding; the model never has to remember to ask.

Corollary: tuning is about *which surfaces* an agent needs, never *whether* it gets any. Silent agents don't exist in this system.

## Section 1: The Two Layers

The primitive separates cleanly into a writer and a reader.

### Writer — timer-driven refresh

Each agent owns a refresh script (conventionally `workspace/scripts/update_now.py`) that pulls the data this agent cares about and rewrites `workspace/NOW.md`. The script runs on the agent's own scheduler (per-agent `conversations/cron-jobs.json`), typically every 5 minutes. Two live examples:

- **forrest** (health agent) — pulls VO2/HRV/RHR/wrist temp from `~/.health_log.jsonl`, latest run+sauna from the canonical workout ledger, barometric pressure from `~/.pressure_log.jsonl`, and next-scheduled touchpoints. Writes a situation + imminent + freshness triptych.
- **jerry** (primary / ecosystem) — pulls pm2 process state, per-agent online/degraded status, imminent cron fires across all agents, recent git commits. Writes an ecosystem overview.

Content is domain-specific. A new agent gets a placeholder NOW.md and is expected to write its own updater reflecting its domain.

`PLAYBOOK.md` is the lookup map for the agent — where to go for which question. Unlike NOW.md, it's static and curator-maintained; no refresh script required.

### Reader — session-boundary-aware injection

On every turn, `src/agent/loop.ts` already computes a `needsBoundary` flag: true if conversation history is empty OR the gap since the last message exceeds `sessionGapMs` (default 30 min). That flag is the session-start signal.

When `needsBoundary` fires, `src/agent/session-bootstrap.ts::buildBootstrapBlock` reads the configured files and produces a single `[SESSION BOOTSTRAP] ... [/SESSION BOOTSTRAP]` block that is appended to the system prompt **for that turn only**. Turns 2+ within the same session skip bootstrap entirely — the file content persists in the conversation history from turn 1's system prompt.

The block uses plain file-content injection, not tool calls. Models without tools (simple chat paths) still get the grounding. Models with tools don't waste a Read call on a file whose contents are already in the prompt.

## Section 2: Config Schema

Top-level in `HomeConfig`:

```yaml
situationalAwareness:
  bootstrap:
    reads:             # list of filenames relative to workspacePath
      - NOW.md
      - PLAYBOOK.md
    maxBytesPerFile:   # per-file cap; defaults to 4000
      4000
```

**Resolution order** (via `src/config.ts::loadConfig` deepMerge):
1. `config/home.yaml` — system default.
2. `instances/<agent>/config.yaml` — agent override.
3. Per-subagent / cron-job level — not currently exposed, inheritable future hook.

`config/home.yaml` ships with `reads: [NOW.md, PLAYBOOK.md]` as the default. An agent needs no explicit block to get the primitive — it just needs those files in its workspace. Agents that want a different set (e.g. the primary might add `TOPOLOGY.md`, `PERSONAL.md`) override in their own `config.yaml`.

Missing files are silently skipped — bootstrap gracefully degrades. Agents that *want* silent surfaces can simply not create the file.

## Section 3: Session Boundary Detection

Boundary fires when:

- `storedHistory.length === 0` — brand-new chatId (new dashboard conversation, new cron isolated session, new subagent spawn).
- OR `now - lastMessageTimestamp > sessionGapMs` — same chatId but user stepped away long enough that "what's the situation" is a fresh question.

A session-boundary record is appended to history when this fires. The bootstrap block is injected the first turn after the boundary; subsequent turns within the new session skip it until the next boundary.

This matches and reuses existing Step 19 session logic (`threadBindings.idleHours`, `sessions.sessionGapMs`). No new boundary concept introduced.

## Section 4: Subagent + Cron Inheritance

When `AgentLoop` spawns a subagent via `toolContext.runAgentLoop`, the subagent calls `agent.run(newChatId, ...)` on the same `AgentLoop` instance with a fresh `chatId`. Fresh chatId → empty history → `needsBoundary === true` → bootstrap fires.

Same path for scheduled isolated cron runs: scheduler creates a `cron-<jobId>` chatId, calls `agent.run`, bootstrap fires on their first (and often only) turn.

**Consequence:** a 6:30am scheduled morning-briefing cron on forrest no longer needs "Read NOW.md first" baked into its prompt file. It gets the block automatically. Prompt files were simplified accordingly.

## Section 5: Token Discipline

The bootstrap block is paid **once per session**, not per turn:

- Turn 1 of a fresh session: `staticIdentity + [SESSION BOOTSTRAP block] + dynamic tail (situational awareness + cosmo + recovery)`
- Turn 2+ of the same session: `staticIdentity + dynamic tail` (bootstrap skipped)

Because the bootstrap sits in the dynamic tail, the cached static prefix still hits on turn 2+. Cache math:

- Forrest bootstrap: ~4,647 chars (~1,150 tokens) for NOW.md + PLAYBOOK.md.
- Jerry bootstrap: ~3,962 chars (~1,000 tokens) for NOW.md + PLAYBOOK.md.

A session of 10 turns amortizes ~100 tokens per turn — inexpensive for the stale-start avoidance it buys. Cap at `maxBytesPerFile: 4000` keeps any single surface from runaway growth.

## Section 6: Relationship to Step 20

Step 20 (situational-awareness-engine) gives each turn a per-turn brain probe + surface scoring + salience ranking — the `[SITUATIONAL AWARENESS]` block with brain cues and top-k domain surfaces. That fires **every turn**.

Step 23 gives each *session* a bootstrap — the `[SESSION BOOTSTRAP]` block with full-content NOW.md + PLAYBOOK.md. That fires **once per session**.

They coexist in the system prompt (distinct labels). Step 20 is dynamic per-query intelligence; Step 23 is stable per-session grounding. Neither replaces the other.

## Section 7: Migration of Forrest

Forrest's earlier hand-rolled version had to be unwound alongside the new primitive:

1. **SOUL.md** — stripped the "Startup reflex" procedural section (lines 17-30 of the prior version) and replaced with a single sentence grounding statement. The harness now does what the reflex asked the model to do.
2. **4 scheduled prompt files** (`morning-weekday.md`, `morning-weekend.md`, `health-read.md`, `weekly-review.md`) — dropped the "Read NOW.md first" step from each `Before you write anything` list. Added a one-line note that NOW.md + PLAYBOOK.md are already in the session bootstrap.
3. **config.yaml** — removed the explicit `situationalAwareness` block after the `config/home.yaml` default was added. Forrest now inherits the default; behavior unchanged.

## Section 8: CLI Scaffolding

`node cli/home23.js agent create <name>` now:

- Creates `workspace/scripts/` directory alongside `workspace/`.
- Writes `workspace/NOW.md` and `workspace/PLAYBOOK.md` from templates at `cli/templates/NOW.md` and `cli/templates/PLAYBOOK.md` (placeholder text with clear "you need to configure a refresh script" instructions).
- Prints next-steps guidance pointing the user at jerry and forrest as example `update_now.py` implementations.

New agents get the bootstrap primitive out of the box with zero config. The only manual step is writing a domain-specific refresh script and adding its cron job — exactly the work nobody else can do for them.

## Section 9: Files

**New:**
- `src/agent/session-bootstrap.ts` — `buildBootstrapBlock(workspacePath, cfg)`.
- `cli/templates/NOW.md` — placeholder for new-agent scaffolding.
- `cli/templates/PLAYBOOK.md` — generic lookup-map template.
- `instances/jerry/workspace/NOW.md` + `PLAYBOOK.md` + `scripts/update_now.py` — jerry's ecosystem snapshot flow.

**Modified:**
- `src/types.ts` — added `situationalAwareness?: { bootstrap?: { reads?, maxBytesPerFile? } }` to `HomeConfig`.
- `src/agent/loop.ts` — constructor option + inject bootstrap block when `needsBoundary`.
- `src/home.ts` — pass `config.situationalAwareness` into `AgentLoop`.
- `config/home.yaml` — added default `situationalAwareness.bootstrap.reads: [NOW.md, PLAYBOOK.md]`.
- `cli/lib/agent-create.js` — scaffolds NOW.md + PLAYBOOK.md + `scripts/` dir + next-steps guidance.
- `instances/forrest/config.yaml` — removed explicit block (inherits from home.yaml).
- `instances/forrest/workspace/SOUL.md` — replaced procedural reflex section with one sentence.
- `instances/forrest/workspace/prompts/{morning-weekday,morning-weekend,health-read,weekly-review}.md` — stripped Read-NOW step.
- `instances/jerry/conversations/cron-jobs.json` — added 5-min `update_now.py` refresh job.

## Section 10: Verification

End-to-end confirmed live:

```
[agent] Session bootstrap injected (3962 chars)       # jerry, turn 1
[agent] Situational awareness: 10 brain cues, ...     # (Step 20 still fires)
...
[agent] Situational awareness: 10 brain cues, ...     # jerry, turn 2 (no bootstrap)

[agent] Session bootstrap injected (4647 chars)       # forrest, turn 1, config inherited from home.yaml
```

- Fresh chatId → bootstrap fires, ~1,000 tokens.
- Same chatId, turn 2 → bootstrap skipped.
- Forrest with explicit block removed → bootstrap still fires (system default inheritance proven).
- Step 20 context assembly continues to run every turn unchanged.

## Anti-Patterns This Replaces

- Prompt-engineering every cron prompt file with "Read NOW.md first."
- Baking startup reflex text into SOUL.md and hoping the model complies on turn 5.
- Duplicating the NOW.md pattern as a one-off per domain agent without system-level support.
- Per-turn Read tool calls for files already in session history.
