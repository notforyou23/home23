# Step 30 — Companion Layer (Jerry & Forrest)

**Status:** implemented in this step (branch `claude_jtr/home23-agent-harness-upgrade-883359`)
**Owner:** harness (`src/agent/*`)

## Problem

Jerry and Forrest already carry a full companion doctrine in their `SOUL.md`
(R2/3PO, object permanence, loyal dissent, two gears, "character is conduct,"
no manufactured emotion). But the harness was not delivering that identity
reliably, and had no memory of the working relationship, no gate on autonomous
chatter, and no conduct tests.

Concretely, four gaps:

1. **Identity was silently truncated.** `context.ts` sliced `SOUL.md` at
   `content.slice(0, 3000)` — mid-sentence, no diagnostic. Jerry's SOUL is
   ~4.5k, Forrest's ~5k, so the companion-shape / grounding tail of *both*
   never reached the model. Prompt composition was also uninspectable.
2. **No working-relationship memory.** Factual memory (`MemoryObject`) and raw
   chat history existed, but nothing curated the jtr↔agent relationship —
   promises, corrections, decisions, threads, why-it-mattered.
3. **No attention gate.** An engine attention policy existed but was wired into
   only 1 of 3 autonomous-outbound paths; cron delivery and `/api/notify` were
   ungated, and the `ATTENTION_*.md` files in Jerry's workspace were inert.
4. **No conduct tests.** No behavioral eval for what the agents notice,
   remember, surface, suppress, or keep private.

This step is a harness + memory update that makes the *existing* identity affect
behavior reliably. It does not add personality text, catchphrases, emotional
simulation, or a larger prompt.

## Piece 1 — Identity delivery

`src/agent/identity-budget.ts` (new, pure/testable) replaces blind slicing with
**section-aware budgeting**: markdown is split on headings, whole least-important
sections are dropped to fit a per-file budget, single over-budget sections are
cut on a paragraph/sentence/word boundary (never mid-word), and every omission
appends a visible `_[identity-budget: kept X/Y chars of F; omitted N section(s): …]_`
diagnostic. `DEFAULT_IDENTITY_BUDGETS` raises `SOUL.md` to 8000 so the whole
doctrine reaches the model; budgets are overridable via `chat.identityBudgets`.

`context.ts` now:
- classifies each identity file into the six-layer scheme
  (`enduring_self → relationship → role → world_state → operational → task`)
  and emits the identity region **grouped and ordered by layer** with clear
  `[LAYER N · …]` headers, regardless of config order;
- records `rawBytes / includedBytes / budget / truncated / omittedSections /
  layer` per file plus `systemPromptBytes / anyTruncated` in `PromptSourceInfo`.

Inspection paths (both **bearer-gated** — never public):
- `GET /api/prompt-composition` — the developer/debug view: every source,
  section, size, and omission; `?includeText=1` returns the full prompt.
- the `/prompt` slash command now shows per-file layer + sizes + omissions.

*Deliberate deviation:* the base `buildSystemPrompt()` (voice + CORE_RUNTIME
operational rules) stays as the framing block rather than being physically
relocated into layer 5 — moving it would destabilize prompt caching and every
agent for little gain. The six-layer ordering is applied to the identity region
we control, and the inspection path reports the true physical composition.

*Caching:* all of this stays inside `getSystemPrompt()` — the cacheable prefix
boundary — so no per-turn cost is added.

## Piece 2 — Relationship continuity

`src/agent/relationship-ledger.ts` (new) is a curated, bounded, **inspectable**
per-agent store at `instances/<agent>/brain/relationship-ledger.json`
(atomic tmp+rename writes, JSONL event sibling). Entry types: `thread`,
`promise`, `correction`, `decision`, `preference`, `aversion`,
`shared_reference`, `miss_repair`, `why_it_mattered`. Each carries provenance,
agent ownership (`actor`), confidence (anti-theater caps by generation method),
`status` (active/superseded/resolved/removed), `supersedes`/`superseded_by`, and
`privacy_class`.

It reuses the codebase's authenticated-correction mechanism: `actor:'jtr'` is
earned only when a real jtr correction passes the same one-shot validator the
loop binds for `MemoryObjectStore` — a self-declared `jtr_correction` is
silently downgraded to `agent_note` (closes the confidence-laundering vector).

Retrieval: `retrieveForContext(query, {budgetChars, excludePrivacy})` ranks
active entries by relevance + recency + type weight, packs whole entries to
budget, and renders a `[RELATIONSHIP — <agent>]` block. **This is the only
render-to-prompt path, and it enforces `privacy_class`** (the schema field the
rest of the codebase records but never enforced) — `sensitive` entries never
enter the prompt. The loop injects it into the dynamic tail (identity layer 2)
and calls `markSurfaced()` after real use. Kept out of the curator's surface
map, so it is never auto-clobbered. Tools: `relationship_note`,
`relationship_recall`, `relationship_update` (supersede/resolve/remove).

Jerry and Forrest each own a separate ledger — shared facts, distinct
perspectives, no merged identity.

## Piece 3 — Attention gate

`src/agent/attention/attention-gate.ts` (new, deterministic-first, no model
calls) decides surface / suppress / aggregate for **autonomous, resident-
originated** outbound. Priority: user replies and requested answers always
surface (numeric chatId / `user-reply` origin / `isDirectAnswer` guards);
completion-blocking failures and critical/emergency escalations always surface;
then dedup of identical messages, materiality (requiresAction / anomaly /
alert+urgent / changes-story / explicitly-watched), staleness, protected rhythms
(family-evening/sleep/deep-work → aggregate), and telemetry-noise suppression.
Every verdict carries an inspectable `reason` slug. A bounded digest aggregates
held low-materiality items.

Wired at the two previously-ungated harness paths, keyed so user replies (which
flow through the channel router, not these paths) are never touched:
- `DeliveryManager.deliver` — **dedup-only**: a jtr-configured cron delivery is
  `explicitlyWatched` (always surfaces on first occurrence); only an identical
  repeat within the window is suppressed. jtr's explicit delivery config is
  never overridden (no backend magic).
- `POST /api/notify` — full materiality + aggregation + digest flush to the
  owner channel. Live-problems escalations (remediation-exhausted) surface;
  routine low-severity engine pings aggregate or suppress.

Config `attention.enabled` (default true) with tunable dedupe/aggregate
windows; `enabled: false` restores the exact prior behavior.

## Piece 4 — Behavioral evaluation

- `tests/agent/companion-conduct.test.ts` — deterministic conduct against the
  pure units: shared-history recall, privacy enforcement, ownership
  anti-laundering, agent distinctness, change-vs-telemetry, failures/answers
  never swallowed, identity recognizable with no brain/network.
- `tests/agent/companion-guardrails.test.ts` — static-source + invariants: the
  gate never keys materiality on user identity, SOUL is no longer clipped at
  3000, and live Jerry/Forrest souls are distinct and both carry the companion
  shape.
- `tests/agent/companion-graded.test.ts` + `fixtures/companion-conduct-scenarios.json`
  — model-graded conduct scenarios (dissent, repair, person-first, no
  manufactured emotion). Fixture integrity is checked always; the graded run is
  **off by default**, opt-in via `HOME23_LIVE_GRADED=1`.

## Canary (does not touch live Jerry or Forrest)

Everything is on the feature branch; live instances are **not restarted**. To
try it in isolation, run a throwaway agent (e.g. `HOME23_AGENT=canary`) from the
worktree, or unit-drive the pure units. The two live configs already have the
coding backends enabled from Step 29; the Companion Layer is code-level and
applies to any agent on its next (operator-initiated) restart.
