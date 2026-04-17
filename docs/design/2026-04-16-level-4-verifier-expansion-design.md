# Level 4 — Agent-written verifiers behind an approval gate

Date: 2026-04-16
Status: Scaffolding only. Design doc for iteration; runtime not built.

## Context

Levels 1–3 of verifier vocabulary expansion:

- **Level 1 — compositional primitives** (shipped): `jsonpath_http`,
  `jsonl_recent_match`, `composed`. Four primitives express most JSON
  APIs, any append-only log, any boolean combination. Promoter has
  dramatically more room to propose without new code.

- **Level 2 — targets registry** (shipped): `config/targets.yaml` is the
  canonical vocabulary of what exists on this system. The promoter
  validates every proposed verifier against the registry before promoting;
  hallucinated targets are rejected.

- **Level 3 — pattern-driven registry suggestions** (shipped): when the
  promoter rejects N+ concerns referencing the same missing target, it
  emits a `registry_suggestion` signal on the dashboard. jtr sees "add X
  to the registry?" with evidence; one edit expands the vocabulary.

Level 4 is the next step: when even compositional primitives can't
express the check jtr's world needs, the agent (Tier-2 dispatch) proposes
a new verifier TYPE by writing a small function. Sandbox tests run for
N ticks; jtr approves; it joins the catalog.

## Why not just keep building primitives by hand

The four-primitive vocabulary is broad, but some concerns resist
expression:

- **Multi-step checks** that require a non-JSON parsing pass
  ("SSH into the pi, run `systemctl status pipeline-bridge`, parse
  output, return healthy/stale").
- **Cross-source composition** that isn't well-served by
  `composed: all_of` (e.g., "field X in JSON A minus field Y in JSON B
  should be under N").
- **Domain-specific predicates** that live in jtr's own mental model
  (trading positions, workout cadence, sauna routine patterns).

Writing these by hand means jtr (or I) must re-engage every time the
world grows. The promise of Home23 is that Jerry can eventually shape
his own world-understanding. Level 4 is the structural enabler for that
ambition — with strict bounds.

## The risk

LLM-generated code executing in the engine's process is the single
biggest risk in this whole architecture. A bad or malicious verifier
can:

- Read anything on disk (including secrets.yaml)
- Open network connections (exfiltrate)
- Spawn processes / exec shell
- Call destructive fs APIs
- Infinite-loop / burn CPU
- Import and use any node module

**Nothing** about this can be safe without a strict sandbox. The design
below is the minimum viable sandbox; it can tighten further over time
but must not loosen.

## Sandbox contract (what runtime enforces)

Each verifier proposal runs in a `vm.Context` created fresh per
invocation with the following globals:

**Allowed:**
- `Promise`, `setTimeout`, `clearTimeout` (cleanup via timeout cap)
- `JSON` (parse/stringify)
- `Math`, `Date`, `Number`, `String`, `Array`, `Object`, `RegExp`
- `sandbox.readFile(path)` — wrapper around `fs.readFileSync` that
  rejects any path not in `config/targets.yaml` files list or not under
  a whitelisted prefix
- `sandbox.fetch(url, opts)` — wrapper around `fetch` that rejects any
  URL whose origin isn't in the registry `urls` list (or localhost / RFC1918)
- `sandbox.console` — captures console output to a log buffer; nothing
  reaches the engine's stdout/stderr
- `sandbox.args` — the user-supplied args object (read-only)
- `sandbox.ctx` — a minimal context (just `brainDir`, no memory, no fs
  escape)

**Forbidden (not present in globals):**
- `require`, `import`, `process`, `Buffer`
- `child_process`, `fs`, `net`, `http`, `https` (except sandbox.fetch)
- `vm`, `module`, `exports`, `global`, `globalThis`

**Enforcement:**
- The verifier function is compiled via `vm.Script` and run with
  `script.runInContext(ctx, { timeout: 10_000, breakOnSigint: true })`.
  Any uncaught exception is caught and becomes `{ok: false, detail: err}`.
- The VM context has no path back to the host — scripts cannot
  reach out of the context via prototypes.

## Proposal lifecycle

1. **Agent writes proposal.** During a Tier-2 dispatch, if the agent
   recognizes that the concern needs a check outside the existing verifier
   vocabulary, it writes two files:
     - `engine/src/live-problems/custom-verifiers/proposals/<name>.js`
     - `engine/src/live-problems/custom-verifiers/proposals/<name>.meta.json`

2. **Proposal-runner trial.** A new engine module scans this dir every
   tick. New proposals enter "trial" state: the runner invokes them in
   the sandbox once per engine tick (alongside built-in verifiers), records
   each result to the meta's `trialResults` array. After M trials (say 10),
   the proposal's meta gets `trialComplete: true`.

3. **Dashboard review UI.** A new dashboard panel (`📋 Proposed verifiers`)
   lists proposals with:
     - source (which agent turn, which concern it was derived from)
     - function source (syntax-highlighted)
     - trial-result distribution (ok% / error% / mean latency)
     - what it reads (paths, URLs)
     - sandbox audit notes
   jtr flips `approved: true` via a button.

4. **Promotion.** On approval, an engine process moves the file from
   `proposals/` to `custom-verifiers/`. Next engine restart loads it into
   `verifiers.js`-alike catalog.

5. **Runtime.** Approved custom verifiers invoke identically to built-ins:
   `runVerifier({type: '<name>', args}, ctx)`.

6. **Revocation.** Deleting the file from `custom-verifiers/` removes it
   on next engine restart. Problems using it will flip to `unverifiable`.

## Files added by this scaffold

```
engine/src/live-problems/custom-verifiers/
  README.md               # sandbox contract, proposal shape
  proposals/              # empty; where agent-dispatched proposals land
    .gitkeep
docs/design/
  2026-04-16-level-4-verifier-expansion-design.md  # this file
```

No runtime code changes. Nothing loads these proposals yet. The scaffold
exists so that when we build the runtime pieces, the structure is clear
and jtr can review the design doc first.

## What's NOT built yet

- Proposal runner (scans `proposals/`, sandboxes each, records trials)
- `sandbox.readFile` / `sandbox.fetch` wrapper module
- `vm.Context` setup + globals allowlist
- Dashboard UI for reviewing proposals
- Approval endpoint (moves file from proposals/ to custom-verifiers/)
- Loader hook in `verifiers.js` that scans custom-verifiers/ at engine start
- Agent prompt additions for writing proposals (Tier-2 dispatch mission
  prompt would need a "you may propose a new verifier type" section)

## Estimated build cost

Rough breakdown:

| Piece | Estimate |
|---|---|
| Sandbox wrapper (`sandbox.js`) with readFile + fetch | 2-3h |
| Proposal runner (scan + trial-run + record) | 2-3h |
| verifiers.js loader hook | 1h |
| Agent prompt additions | 1h |
| Dashboard proposals tile | 2-3h |
| Approval endpoint + file move | 1h |
| Integration testing | 2h |
| **Total** | **~12h** |

## Questions to resolve before build

1. **Where do proposals come from?** Two options:
   - Tier-2 dispatch writes them (agent has file tools).
   - A dedicated "verifier-proposal" turn spec, triggered from
     `registry_suggestion` signals that the user explicitly escalates
     ("this is verifiable but we don't have the primitive").
   Recommendation: start with Tier-2 dispatch, since the agent is already
   writing scripts + configs as part of diagnosis. Add a new clause to
   its mission prompt.

2. **How strict is the sandbox?** The contract above is maximally strict.
   Likely we'll need to loosen `sandbox.readFile` to allow reading a
   curated set of paths that aren't in the registry (e.g., `/tmp/*` for
   staging or `/proc/loadavg` for system stats on Linux). Each loosening
   requires explicit review.

3. **Trial duration before approval available?** Running for 10 ticks
   (~15 min at 90s cadence) feels short. Longer trials catch intermittent
   bugs but slow autonomy. Start with 10 and tune.

4. **What if a proposal keeps failing in trials?** After N consecutive
   errors, auto-reject and emit a `proposal_rejected` signal. Don't let
   agents spam proposals that don't work.

5. **Versioning.** If a proposal is revised, does it start trial from 0?
   Yes — treat revision as a new proposal.

6. **Audit trail.** Every approval / revocation logs to signals.jsonl
   (`type: "custom_verifier_approved"`) with full provenance (who proposed,
   who approved, trial summary).

## Interaction with Level 3

Level 3's `registry_suggestion` signals say "add X to the registry."
Level 4 would let jtr say "X isn't just missing from the registry — it
needs a whole new kind of check." The two compose:

- `registry_suggestion` + exists-in-system + primitive fits → add to targets.yaml
- `registry_suggestion` + exists + primitive doesn't fit → trigger Level-4
  proposal workflow
- `registry_suggestion` + doesn't really exist / not jtr's world → ignore

The dashboard UI should make these three paths clear from the same card.

## Recommendation

Ship Levels 1–3 (done), let them run for a week or two, see what clusters
actually accumulate. If the accumulated patterns genuinely exceed what
four primitives can express, build Level 4. If they don't, the scaffold
here documents the design for when the need arises, and the complexity
cost of LLM-code-in-engine is deferred.

If/when we do build it: sandbox first, everything else second. Every
shortcut on sandboxing becomes a permanent risk.
