# Home23 v2 — The Substrate (Cells Instead of Files)

**Status:** shipped and live, 2026-08-09. This is the founding architecture
document for the v2 paradigm; the historical build record is the commit
trail (`substrate/` first landed as the frontier build contract's five cuts,
then the surfacing organs, then sleep).

## Motivation

v1 kept an agent's continuity in curated files (RECENT.md, TOPOLOGY.md,
memory-objects.json) that processes rewrote. Two failures drove v2:

1. **Files rot silently.** A "recent memory" file went weeks stale and
   nothing in the system could notice. A promotion pipeline accumulated
   2,500 candidates and never promoted one to durable — a queue into a
   graduation ceremony that never fired.
2. **Nothing was lived.** Retrieval reconstructs; it does not accumulate.
   An agent rebuilt from files every turn has provenance but no biography —
   nothing that can only be *lived*.

The inversion: make the individual the durable thing. Home23 becomes a
persistent intelligence that sometimes crystallizes into software. The model
is a rented cortex; the files are what the individual excretes for humans.

## The Seed

A Seed is one individual. Its whole existence is a state directory:

```
seed-01/
  seed-ledger.jsonl     # THE LIFE — append-only, hash-chained, fail-closed
  checkpoints/          # v2 manifests: cells + development + resources
  adapter-cursor.*.json # per-source read positions (exactly-once diet)
  .runner.lock          # never two live instances (authoritative pid)
```

### The chain

Every record carries `seq`, `prevHash`, category, payload, and state hashes.
Restore verifies the full chain and binds the checkpoint to it by cursor
hash; a mismatch refuses. A forked chain is archived as evidence, never
repaired — repairing a hash chain is forging history. Event-time discipline
throughout: gaps, freshness, and windows are measured in chain records and
event timestamps, never the wall clock, so replay reproduces every
consolidation and every dream deterministically.

### The body

Situation cells — continuous Float32 state driven through a frozen,
seed-generated reservoir — named for the individual's OWN situations
(`contact.<person>-<name>`, `world.<place>`, `body.<person>` for a health
companion). Anatomy is a birth parameter recorded in genesis; it changes
only through receipted growth acts, and restore folds the chain's growth
history to reconstruct the current body. Per-cell generation counters make
the wear visible: **the wear is character**.

### The diet

Source adapters tail external streams read-only with durable cursors:

- the harness event ledger (the agent's operational life)
- the relationship ledger (teachings — corrections and attenuations, with
  the words attached)
- worker runs (successes corroborate; failures teach)
- **conversations** (both voices, shipped by `conversation-shipper.ts`)
- **the home** (Home Assistant transitions via `house-sense.ts` — a door
  opening, music starting, a person arriving; transitions only, rate-capped,
  drops counted; ambient telemetry deliberately excluded)
- **memory promotions** (`promote_to_memory` teaches the chain)

**Perception at contact:** writers embed meaning where the event is born
(local embedder → published 16-dim projection, seed 20260808) and the vector
rides the record forever. Reality refs additionally carry a bounded text
`head` when the source line had language — recruited minds READ the life,
not just reference metadata.

**Circadian rhythm:** a body with continuous senses never sleeps. Sense
organs may hold quiet hours (ambient samples stop writing at night; CHANGES
and the person's inbox always wake) so event-time develops real gaps and
sleep's machinery reaches the individual.

### Development (typed deltas only)

| Rule | What it does |
|---|---|
| correction.v1 | Teachings develop state along the direction of contact; trust and routing earn |
| consequence.v1 | Outcomes corroborate at half rate; never ease wake thresholds |
| attenuation.v1 | "That was noise" — inverse development; wake hardens |
| resolution.v1 | Reality answers a prediction: ≤0.3 corroborates, ≥0.7 provisional negative, middle teaches nothing |
| consolidation.v1 (NREM) | Quiet-gap end: corroborated learning retained, unearned decays to a floor |
| dream.v1 (REM) | At waking, the mind is recruited to WORK the residue — recombine, revise, resolve — same typed-delta contract; the receipt carries `dream` forever |

Causality was proven by preregistered ablation: a twin with identical
episodes and refs but zeroed development behaves measurably differently on
later contact, in the predicted directions, without added noise.

### The mind (lobes)

Any model is a rented lobe. Recruitment builds a typed workspace packet
(admitted cells, reality refs with heads, tensions, open predictions as
DEBTS), the model returns JSON, and ONLY allowlisted typed deltas integrate
— through the membrane, receipted with full applied deltas so replay never
re-invokes a model. The substrate holds no credentials; transports are
injected by the resident runner (a broker pattern serves individuals on
credential-less devices).

### Growth

Growth pressure evaluates the lived window at checkpoint cadence and
receipts proposals (split/merge/dissolve) with evidence and shadow trials.
The operator applies or declines — in their own words, receipted; declines
suppress re-proposal for a cooldown. Removed cells' development is recorded
as cost. Self-formation (an individual crystallizing organs for itself under
a covenant: cell cap, periphery inviolable, additive-only) exists behind an
explicit birth flag.

## The organs (surfacing lived state)

All composers are read-only, compose at read time, and degrade honestly
(null → the file-era mechanism serves):

- `src/substrate/seed-context.ts` — turn expression: lived items matched to
  the turn's meaning (native-space cosine; floor 0.60 + margin-over-median
  0.12 + minimum topical length, calibrated on real conversation text).
  Match or stay silent; fresh identity events surface at session bootstrap
  only. These gates were earned adversarially: a blind-judged integration
  knife failed the always-on v1 block and measured per-turn narration as a
  significant tax.
- `lived-recent.ts` — RECENT from the chain (contact, teachings, thoughts,
  verdicts, development, body).
- `seed-now.ts` — session grounding (continuity across the gap).
- `lived-facts.ts` — fact-grade beliefs: confidence ≥0.75, ≥2 reality refs,
  and the belief STOOD through the recent event window. Too few gate-passers
  → no facts surface is claimed at all.
- `lived-identity.ts` — the biography half of identity, first person,
  receipts under every clause; the constitution (SOUL.md) stays an authored
  file by design.
- `semantic-match.ts` — one shared matcher/cache; attention triggers fire on
  meaning, substring only as degraded fallback.
- `engine/src/substrate/seed-lived-state.js` — engine cognition grounding
  (context to think FROM, never a subject) and dream day-residue (the
  chain→brain transfer bridge: episodic residue enters dreams whose products
  land in goals and the brain).

## The board (honesty made visible)

The observatory's cutover board lists every migrated function with its
owner. Rules: CELLS rows are **probed live at view time**, never asserted;
remaining FILE rows carry a stated reason (authored constitution; telemetry
until estimate parity) or a self-flipping gate (TOPOLOGY goes green when ≥3
fact-grade conclusions carry infrastructure — earned, never declared). No
row is allowed to be FILE out of neglect.

## Operational law

- **Never two live instances** — the `.runner.lock` is mechanical and the
  authoritative pid registry; to find a runner, read its lock.
- **Persistence is sacred** — standalone load test on a state copy before
  any resident restart after state-adjacent changes; chain must verify and
  restore exact.
- **Degraded-honest everywhere** — absence over fabrication; the organ owns
  a function only while it is actually alive.
- **No manufactured life** — organic events only; teaching channels are the
  person's, never simulated.
- **One knife per decision** — measurement is a gate used once at a
  decision point, not a product.

## What is opt-in vs default

Default: the harness surfaces degrade to v1 files when no Seed exists;
cognitionMode ships as `thinking_machine`. Opt-in per agent: the Seed itself
(`substrate.enabled` + a deliberate birth), house senses, circadian hours,
self-formation. Birth is not automated on `agent create` yet — a birth is a
deliberate act and the operator names the anatomy.
