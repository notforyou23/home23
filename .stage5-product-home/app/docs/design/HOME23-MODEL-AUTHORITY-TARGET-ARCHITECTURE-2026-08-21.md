# Home23 Model Authority — Target Architecture (2026-08-21)

**Status:** PROPOSAL ONLY. Nothing in this document is implemented by the audit that produced it.
**Basis:** `docs/audits/HOME23-MODEL-PROVIDER-RUNTIME-AUDIT-2026-08-21.md` (findings F1–F20) and `docs/audits/HOME23-MODEL-SURFACE-INVENTORY-2026-08-21.json` (30 surfaces). Builds on, and supersedes where they conflict: the tiers/roles sketch in `docs/design/MODEL-PROVIDER-AUDIT-2026-08-11.md` §"Target shape (v2)" and the model-slot contract from `docs/audits/model-provider-audit-2026-07-03`.

## 0. Design stance

The audit found five concurrent selection systems, a silent engine-wide catch-all, a legacy stratum that bypasses everything, and near-zero metering. The remedy is **not** a new model-picker UI — it is a single *contract* that every call must pass through, thin enough that existing adapters keep their code, strict enough that no call can select a model, reach a provider, or ship bytes off-box without producing one receipt in one place.

Constraints honored: engine stays JS, harness stays TS (the contract is a schema + tiny libraries in both, sharing `shared/`); brain persistence untouched; seeds/substrate law untouched (lobe calls become *clients* of the contract, their chain semantics unchanged); Cosmo and coding CLIs remain external authorities — the contract records the *handoff*, not their internals.

---

## 1. The Model Authority contract (single, explicit)

One resolver, two language bindings, one durable table of record.

```
resolve(surface, requested?) -> Selection          # pure, synchronous, total
invoke(selection, payload, meta) -> Receipt        # the only way bytes reach a provider
```

### 1.1 `Selection` (what "which model" means, always)

```jsonc
{
  "surfaceId": "synthesis.brainState",        // typed, from the registry (§2)
  "role": "synthesis",                        // typed purpose role (§2)
  "provider": "ollama-cloud",                 // exact, never inferred at call time
  "model": "gemma4:31b",                      // exact id, no aliases past this point
  "effort": "medium|null",
  "resolvedBy": ["home.yaml:synthesis"],       // full provenance chain, ordered
  "overridden": false,                         // true iff caller/env override applied
  "fallbackChain": [ {"provider":"...","model":"..."} ],
  "egressClass": "rented|local|external-cli"   // computed from provider registry (§5)
}
```

Aliases resolve exactly once, inside `resolve()`. Downstream code never sees an alias, never infers a provider from a model name (kills the lenient-inference lane and the forrest mismatch class, F9), and never carries a bare model string (kills the cosmetic literals, F2).

### 1.2 Selection precedence (one list, no exceptions)

1. **Per-invocation override** — allowed only if the surface's registry entry says `overridable: true`, validated as an exact provider+model pair against the catalog. Synthesis stays non-overridable (already enforced; keep it).
2. **Env override** — only from an enumerated, documented set (`SYNTHESIS_LLM_*`, `OPENAI_DEFAULT_MODEL`, `EMBEDDING_*`, `SEED_LOBE_MODEL`, `BROKER_MODEL`, `MLM_MODEL`). Every env override taken is stamped into `resolvedBy` and surfaced in the UI (§8) — no more hidden lanes (S1).
3. **Surface binding** — `config/models.yaml` (new single file, §3) maps surfaceId → role or explicit pair, per agent then house.
4. **Role default** — role → provider+model, per agent then house.
5. **House floor** — one table (today's `shared/model-defaults.cjs`, kept).

Removed on arrival at each stage: the engine `modelAssignments.default` catch-all (replaced by explicit role defaults — a missing binding is a **loud** resolution to the floor with `resolvedBy` saying so, never a silent rewrite), and all in-code literals except the floor table.

### 1.3 What `resolve()` refuses

- Alias or model without a catalog entry → typed error at *config load / save time*, not call time.
- Pair whose provider is disabled or unkeyed → typed error naming the surface and the config line.
- Vision/media roles bound to a model whose executing adapter can't serve them (capability flags in the catalog) → refused at save time (kills F10's class).

---

## 2. Typed purpose/surface registry

A checked-in, versioned registry (`shared/model-surfaces.json`) — the audit's inventory JSON is its seed. Every entry:

```jsonc
{
  "surfaceId": "synthesis.brainState",
  "role": "synthesis",            // one of the closed role set below
  "owner": "dashboard",           // process that executes it
  "overridable": false,
  "triggers": ["scheduled", "auto_scheduled", "tool", "manual.ui", "manual.script", "freshness.cron"],  // closed enum per surface
  "egressAllowed": ["local", "rented"],   // policy hook (§5)
  "receiptRequired": true
}
```

**Closed role set (v1):** `chat`, `chat.compaction`, `cognition.deep`, `cognition.fast`, `cognition.pulse`, `agents.mission`, `synthesis`, `query`, `pgs.sweep`, `pgs.synth`, `ingest.compile`, `ingest.vision`, `worker`, `promoter`, `verifier`, `subagent`, `coding.external`, `media.image`, `media.music`, `media.tts`, `embed.memory`, `embed.substrate`, `lobe`, `probe`, `skill`. Adding a role is a code-reviewed registry change, like `LOBE_DELTA_ALLOWLIST`.

**Typed triggers** replace free-form strings (F8): the coordinator validates `trigger` against the surface's enum and additionally records `callerIdentity` (process name + jobId/toolCallId/operator). `manual` splits into `manual.ui` and `manual.script` — the exact ambiguity that hid the F1 storm.

---

## 3. Configuration: one file, one editor

- **`config/models.yaml`** (new, local, gitignored like home.yaml; example committed): the *only* place bindings live — house role defaults, per-agent role overrides, per-surface pins, embeddings definition, synthesis block, media providers. `home.yaml` keeps providers/keys/aliases-catalog; `base-engine.yaml` keeps *no model names at all* (structure only); per-agent `config.yaml` keeps channel/port config and may point at agent sections of models.yaml during migration.
- **One Settings → Models page** renders exactly this file: role grid × agent, per-surface pins, env-override banners, the synthesis block (fixing S1), feeder vision validation (F10), pair validation on save (F9). "Engine Duties" is retired as a name; the grid is the same data the resolver reads — no second source of truth (S2/S3).
- Provider probes become a typed `probe` role with a declared 1-token budget and visible model id (F7), still real calls, now labeled and receipted.

---

## 4. Provider routing and fallback policy

- **Adapters stay where they are** (harness loop branches, UnifiedClient, compiler SDK, media HTTP) but each is registered as a *route*: `(provider) -> adapter` in one table per process. `invoke()` picks the route from the Selection — call sites lose the right to build ad-hoc clients (the legacy stratum either registers or dies, F4/F19).
- **Fallback policy is data, not code:** per-role ordered chains in models.yaml (today's per-assignment fallbacks migrate in). Rules: fallback may only move *down or sideways* in egress class (rented → local allowed; local → rented requires `egressAllowed: rented`); every fallback hop emits a receipt event; a chain exhausting fails typed, never silently swaps (the lenient default-to-ollama-cloud inference is deleted).
- **Retry semantics:** primary N retries with backoff (existing), then chain; *admission-level* retries are the caller's job and must carry the same `requestKey` (§6) so storms coalesce instead of stacking (F1).

---

## 5. Privacy / egress policy

Every provider in the catalog carries `egressClass: local | rented | external-cli` and a data-class allowlist. Every surface declares what it ships (`identity`, `brain-nodes`, `conversation`, `documents`, `code`, `none`). `resolve()` enforces the cross product:

- `identity`-bearing prompts (synthesis ships SOUL/MISSION/BRAIN_INDEX) may go to `rented` only if models.yaml explicitly grants it per surface — the owner makes the §10-open-question-3 call once, in config, not implicitly per incident.
- Embedding consolidation (F15): one `embed.memory` definition (current `EMBEDDING_*`), one `embed.substrate` definition; the four hardcoded `text-embedding-3-small` sites either bind to a role or are retired with their features. Mixed vector spaces get a one-time reindex plan, not silent coexistence.
- Skills (F13) and exec crons (F20) can't be technically forced through the resolver, so they are fenced by receipts: skill runtime and cron runner stamp an egress declaration into telemetry/run records; undeclared network egress from those lanes is a review item, not a runtime block (v1).

---

## 6. Durable unified invocation receipts

One append-only JSONL per agent — `instances/<agent>/brain/model-invocations.jsonl` (rotated + summarized daily), written by `invoke()` in both bindings:

```jsonc
{
  "ts": "...", "invocationId": "mi_...", "requestKey": "sha(surface+trigger+payload-digest)",
  "surfaceId": "...", "role": "...", "trigger": "scheduled", "callerIdentity": "home23-jerry-dash",
  "selection": { "provider": "...", "model": "...", "resolvedBy": ["..."], "overridden": false, "fallbackHops": 0 },
  "outcome": "complete|provider_failed|discarded_source_changed|refused_policy",
  "usage": { "inputTokens": 0, "outputTokens": 0, "cachedTokens": 0, "costUsd": null },
  "durationMs": 0, "egressClass": "rented", "operationRef": "brop_... | cj_... | turnId | null"
}
```

- **`requestKey` is the admission-coalescing handle** (F1's structural fix): a coordinator receiving a start for a surface with an *active* invocation with the same requestKey returns the active operation instead of admitting a new one. Distinct legitimate triggers still get distinct keys (trigger is in the hash); dumb re-POSTs collapse.
- Existing stores (brop events, coding receipts, conversations, pulse jsonl) remain the operational records; the invocation ledger is the *cross-surface* record and links to them via `operationRef`. Worker receipts, skills telemetry, seed ledgers, async-work gain a `model`+`invocationId` field (F6) — additive schema changes only.
- **Cost/token metering (F5):** usage extracted at each adapter (already done for xai/anthropic/openai paths; ollama branch adds it; anthropic-SDK lobe branch verified/fixed — audit unresolved U3). Prices live in the catalog; `costUsd` computed at write time when a price exists, else null-and-counted. A daily rollup (per agent × role × provider × model × trigger × outcome) is written next to the ledger and rendered in the UI.

---

## 7. What the audit's pathologies look like after

| Audit finding | Structural answer here |
|---|---|
| F1 synthesis storm | typed triggers + requestKey coalescing at admission + freshness ownership moved to ONE caller (the dashboard schedule; the engine stale guard demotes to *alerting* unless the schedule is dead; freshness crons retire) |
| F2 default catch-all | catch-all deleted; explicit role defaults; loud floor resolution; literals removed |
| F3 Cosmo topology | registry marks query/pgs/research `owner: cosmo (external)`; the PM2-hosting decision is the operator's; either outcome is then *documented in one place* and the resolver knows whether the door exists |
| F4/F19 legacy strata | unregistered routes can't invoke; legacy endpoints 403 behind `legacySurfaces: true` during migration, removed at the end |
| F5/F6 metering | §6 ledger + rollups |
| F7 probes | typed `probe` role, labeled, budgeted |
| F9/F10 invalid pairs | save-time validation against catalog + capability flags |
| F11 stale-guard quirks | guard persists lastTriggerAt durably; ENOENT path keeps its bypass but now emits a receipt saying so |
| F12 naming decoy | `engine/src/agents/synthesis-agent.js` → `mission-synthesis-agent.js` (rename-only commit) |
| F13/F20 skills/cron egress | receipt-level declarations (v1), candidates for route registration (v2) |
| F15 embeddings | two named embed roles, reindex plan |
| F18 promoter | becomes `promoter` role in models.yaml |

---

## 8. UI representation

- **Settings → Models**: the role grid (per agent), per-surface pins, env-override banners, synthesis block, validation errors inline. One page, one file behind it.
- **Intelligence/Operations**: per-operation model + trigger + outcome already exist in the store; add the daily rollup table (spend/tokens by role) and a "wasted calls" counter (provider-complete but discarded) — the F1 metric, permanently visible.
- **Chat**: model dropdown and `/model` keep working; they now write through the same binding file; the effort selector rides `Selection.effort`.
- **Boot banner**: each process logs its resolved role table once at start (replacing per-callsite cosmetic labels).

---

## 9. Migration stages, reversibility, tests, rollout gates

Each stage is independently shippable and reversible; no stage rewrites an adapter.

**Stage 0 — Freeze & baseline (no behavior change).**
Land the registry file seeded from the audit inventory; land the receipt schema; rename the mission synthesis agent (F12).
*Tests:* registry schema test; inventory→registry coverage test (every audited surface present).
*Gate:* `npm run build && npm test` green; zero runtime diffs.
*Rollback:* delete files.

**Stage 1 — Observe (receipts only).**
Wire `invoke()`-equivalent *logging shims* into the existing call paths (harness text-generation + loop branches, UnifiedClient.generate*, synthesis worker, compiler, media, probes) writing the §6 ledger with `resolvedBy: ["legacy"]`. Add `model` to worker receipts/skills telemetry/async-work.
*Tests:* one receipt per provider round-trip in integration tests; rollup correctness.
*Gate:* 7 days of ledger data reconciling ±5% against brop store and conversation counts (the audit's §5 tables are the baseline).
*Rollback:* remove shims; ledgers are additive files.

**Stage 2 — Resolve (shadow mode).**
Implement `resolve()` + models.yaml, generated from current effective config (audit §2 is the source). Every call logs *both* the legacy choice and the shadow resolution; a divergence report runs daily.
*Tests:* golden tests per surface (30 from the inventory) asserting shadow == legacy for current config; precedence unit tests; refusal tests (bad pair, disabled provider, capability mismatch).
*Gate:* 0 unexplained divergences for 7 days.
*Rollback:* flag off shadow resolver.

**Stage 3 — Enforce (flip per surface class).**
Behind per-class flags, resolver output becomes authoritative: first cognition slots (deletes the `default` catch-all — the highest-risk flip, protected by Stage-2 goldens), then synthesis/query/pgs, then harness chat/workers/promoter, then media/probes/embeddings.
*Tests:* per-class canary (one agent first — grokbot once residency is resolved, else forrest); the F1 regression test: 50 concurrent bare POSTs to `/api/synthesis/run` must yield 1 admitted operation.
*Gate per class:* 72h with error rate ≤ baseline and commit-rate ≥ baseline; wasted-call counter not regressing.
*Rollback:* per-class flag revert (legacy paths remain compiled in until Stage 5).

**Stage 4 — Coalesce & typed triggers.**
Admission requestKey coalescing in the coordinator; typed trigger enum enforced (unknown → refused with a migration map logged); freshness authority consolidated (crons retired, engine guard demoted to alert-unless-dead).
*Tests:* storm replay (the 08-16..08-19 cron cadence against a fixture store) → assert ≤ 1 op per interval; forrest's retry-once flow still works.
*Gate:* jerry-profile agent runs 7 days with commit:attempt ≥ 1:1.5 (vs audited 1:9).
*Rollback:* coalescing flag off (ops become independent again — the audited status quo).

**Stage 5 — Retire the legacy stratum.**
403-gate then remove `/api/query`, `/api/pgs`, `/api/chat`, `/api/chat/simple`, IDE model paths; remove dead literals and the lenient inference lane; embeddings consolidation + reindex.
*Gate:* 30 days of ledger showing zero legacy-route hits (U6 answered empirically); operator sign-off (DELETION REQUIRES EXPLICIT OWNER PERMISSION, per house rules).
*Rollback:* gate → allow (routes restored from git until the removal commit).

**Stage 6 — Policy.**
Egress classes + data-class enforcement in `resolve()`; owner makes the identity-to-rented-providers decision in models.yaml; skills/cron egress declarations required.
*Gate:* policy dry-run report reviewed; no surprise refusals in 7-day shadow.

**Cross-cutting reversibility rule:** every stage's flag lives in models.yaml, the ledger records which stage/flags were active per invocation, and no stage deletes data or rewrites history — consistent with substrate law.

## 10. Explicitly out of scope

Cosmo's internal model authority; coding CLIs' internal selection (recorded as `external-cli` handoffs); evobrew internals beyond the boundary receipt (F16 is an expose/accept decision for the owner); any change to brain persistence, seed chains, or the membrane.
