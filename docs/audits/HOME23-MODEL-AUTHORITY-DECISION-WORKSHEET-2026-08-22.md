# Home23 Model Authority — Decision Worksheet (2026-08-22)

Companion to `HOME23-MODEL-AUTHORITY-MORNING-BRIEF-2026-08-22.md` (the brief; section references below point there) and `HOME23-MODEL-PROVIDER-RUNTIME-AUDIT-2026-08-21.md` (the audit; F/S/U ids point there). Fill this in live during the session. Nothing here executes anything — it is the record of what was decided.

**Session:** date ______ time ______ attendees ______

---

## 1. Current-state checklist — confirm shared understanding before deciding

Initial each line once both parties accept it (evidence in brief §3–§9; all VERIFIED unless marked).

- [ ] Five selection authorities run concurrently; no single place answers "which model runs X". (brief §3, audit §1.1)
- [ ] The engine `modelAssignments.default` catch-all silently rewrites ~30 callsites; code literals and log banners do not describe what ran. (brief §3.2, audit F2)
- [ ] Jerry synthesis, Aug 8–21: 452 ops, **432 real provider calls, 50 commits**; 217 discarded `source_changed` *after* the paid call; trigger `manual` 327 of 452. (brief §6, audit §6)
- [ ] The storm's driver (every-30-min freshness cron, 523 runs / 200 poll-timeout errors) is **disabled**, but the structural gap — no admission-time dedup — remains. (brief §6.3)
- [ ] The synthesis model walked MiniMax-M3 → claude-haiku-4-5 → gemma4:31b during the window; the storm was **not** "432 Gemma calls". (brief §6.2)
- [ ] Worker receipts (0/1,158), skills telemetry, seed ledgers, and async-work records carry no model identity. (audit F6)
- [ ] Metering exists on 4 partial lanes only; total spend and the storm's cost are **not computable** from local receipts. (brief §9, audit F5)
- [ ] Doctrine says Home23 does not host Cosmo; the generator creates `home23-cosmo23`, seeds its env, and it is online in PM2 now. (brief §5.1, audit F3)
- [ ] Legacy dashboard chat/IDE/query/PGS bypass all authority with hardcoded/caller models and no receipts; no window use observed, but reachable. (audit F4/F19)
- [ ] jerry `feeder.converter.visionModel: gpt-5.6-luna` is a Codex-OAuth id feeding an OpenAI-keyed client — OCR lane likely broken (live failure unobserved). (audit F10)
- [ ] forrest chat config carries an invalid pair (`minimax` + `gpt-5.6-terra`) accepted by everything, saved by call-time inference. (audit F9)
- [ ] Engine cognition currently runs `openai-codex/gpt-5.6-luna` — codex entered the engine after the 08-11 audit deferred that as jtr's call. (brief §16 D7)
- [ ] The durable synthesis machinery itself is sound (one call per op, CAS commit, full event trail); forrest's disciplined caller commits at ~64% on the same coordinator. (brief §1, §6.3)

Disagreements to resolve before options are discussed: ______________________

---

## 2. Proposed principles — accept, amend, or reject each

| # | Principle | Accept? | Amendment |
|---|---|---|---|
| P1 | Every provider call produces one receipt in one place (surface, trigger, caller, exact pair, outcome, usage). | ☐ yes ☐ amended ☐ no | |
| P2 | No call site carries a bare model string; aliases resolve once, at the door; provider is never inferred at call time. | ☐ ☐ ☐ | |
| P3 | Invalid selections are refused at **save/config time**, not discovered at call time. | ☐ ☐ ☐ | |
| P4 | Missing bindings resolve **loudly** to a declared floor — never silently to a catch-all. | ☐ ☐ ☐ | |
| P5 | Admission coalesces duplicate work (same surface + requestKey returns the active op); retries are the caller's job and must carry the same key. | ☐ ☐ ☐ | |
| P6 | External authorities (coding CLIs, Cosmo, seeds, skills) are **recorded, not controlled** — receipts at the boundary, no proxying their selection. | ☐ ☐ ☐ | |
| P7 | Identity-bearing prompts cross machine boundaries only under an explicit per-surface config grant. | ☐ ☐ ☐ | |
| P8 | No flag day: every stage independently shippable, flag-reversible, and no data/history deleted without explicit owner permission. | ☐ ☐ ☐ | |
| P9 | Server-owned selection for synthesis stays; callers remain refused. | ☐ ☐ ☐ | |
| P10 | No cost-motivated migration decisions until unified receipts exist (meter before migrate). | ☐ ☐ ☐ | |

---

## 3. Architecture options (brief §12)

| | A — Minimal repair | B — Contract-first consolidation (recommended) | C — Aggressive unification |
|---|---|---|---|
| Scope | Admission dedup, typed triggers, validation fixes, additive receipt fields, S1 exposure, F12 rename | A as Stage 0/1, then registry → unified receipts → shadow resolver → per-class enforcement → legacy gating → egress policy | One resolver + one config now; delete modelAssignments, catch-all, legacy routes in one push |
| Effort | days | weeks, staged, each shippable | "a fortnight" that becomes a quarter |
| Stops the storm class | synthesis only | all surfaces (requestKey + ledger) | all, eventually |
| Economics visibility | none | full (ledger + rollups + wasted-calls counter) | full, after a worse-before-better gap |
| Risk | low | medium, isolated per stage, canaried | high; flag day on engine cognition; breaks substrate boundary for lobes |
| Reversibility | trivial | per-stage flag/file rollback | poor after deletions |

**Decision:** Option chosen: ______ Variations: ______________________

---

## 4. Decision log (brief §16)

| ID | Decision | Options | Outcome | Decided by | Date |
|---|---|---|---|---|---|
| D1 | Cosmo topology (F3/U10) | hosted-and-documented / standalone-and-ungenerated | | jtr | |
| D2 | Identity egress for synthesis prompts (currently ollama-cloud/gemma4:31b) | accept-and-record / move local / named-provider allowlist | | jtr | |
| D3 | Architecture option + authorize Stage 0–1 | A / B / C | | jtr | |
| D4 | grokbot residency (F14/U1) | decommission / repair local / migrate to volume install | | jtr | |
| D5 | jerry visionModel fix | set OpenAI-servable model / add converter provider-resolution | | jtr (config is local state) | |
| D6 | Legacy stratum 403-gate now (removal is a separate future decision) | gate / leave open | | jtr | |
| D7 | Codex on engine cognition — confirm deliberate or reassign slots | confirm / reassign | | jtr | |
| D8 | Meter-before-migrate rule (P10) | affirm / reject | | jtr | |

---

## 5. Keep / change / retire — per authority class (brief §11)

| Authority | Recommended | Agreed? | Notes |
|---|---|---|---|
| Harness precedence chain | KEEP (+ save-time pair validation) | ☐ | |
| Engine modelAssignments + UnifiedClient | REPAIR → CONSOLIDATE (catch-all deleted only after shadow goldens) | ☐ | |
| Dashboard brain-op resolvers | KEEP law / REPAIR admission / EXPOSE in Settings | ☐ | |
| Feeder compiler resolver | KEEP short-term → CONSOLIDATE at Stage 2–3 | ☐ | |
| Legacy stratum | RETIRE (gate now; removal needs explicit permission + 30d zero hits) | ☐ | |
| Coding CLIs / Cosmo internals / seed lobes / skills / exec crons | DO NOT CENTRALIZE — boundary receipts only | ☐ | |

---

## 6. Risk acceptance — sign only what is consciously accepted as-is

| # | Risk being accepted if unaddressed | Source | Accept as-is? | Until when |
|---|---|---|---|---|
| R1 | A future bare-POST caller can recreate the synthesis storm (admission gap remains until Stage 4) | F1 | ☐ | |
| R2 | Identity files continue shipping to a rented endpoint every synthesis run until D2 lands | §8 | ☐ | |
| R3 | Fleet spend remains unknowable until Stage 1 receipts exist | F5 | ☐ | |
| R4 | Legacy routes stay reachable off-ledger until D6/Stage 5 | F4/F19 | ☐ | |
| R5 | Engine cognition rides a 10-day OAuth token (codex) until D7 resolves | §16 D7 | ☐ | |
| R6 | jerry scanned-document OCR presumed broken until D5 applied | F10 | ☐ | |
| R7 | grokbot ambiguity (PM2 online, engine dead since 08-17) persists until D4 | F14 | ☐ | |
| R8 | Exec-cron LLM egress remains unverifiable until receipt-level declarations (Stage 6) | F20/U9 | ☐ | |

---

## 7. Staged rollout approvals (brief §13; gates verbatim from target-architecture §9)

| Stage | Content (summary) | Gate to advance | Rollback | Approved | Owner | Target date |
|---|---|---|---|---|---|---|
| 0 | Registry file, receipt schema, F12 rename, D5 config fix, S1 read-only render | build+tests green; zero runtime diff | delete files | ☐ | | |
| 1 | Receipt shims on existing call paths; additive model fields | 7d ledger reconciles ±5% vs brop store + conversation counts | remove shims | ☐ | | |
| 2 | Shadow resolver + models.yaml generated from current effective config | 0 unexplained divergences for 7d (30 golden surfaces) | shadow flag off | ☐ | | |
| 3 | Per-class enforcement (cognition → synthesis/query → chat/workers → media); canary agent: ______ | 72h per class ≤ baseline error rate; commit-rate ≥ baseline | per-class flag revert | ☐ | | |
| 4 | requestKey coalescing; typed trigger enum; freshness single-owner; engine guard demoted to alerting | storm-replay test admits 1 op/interval; 7d commit:attempt ≥ 1:1.5 | coalescing flag off | ☐ | | |
| 5 | 403-gate legacy routes; removal **only** with explicit owner sign-off | 30d zero legacy hits + signed permission | gate → allow | ☐ | | |
| 6 | Egress classes + data-class enforcement; D2 encoded in config | policy dry-run reviewed; no surprise refusals in 7d shadow | policy flag off | ☐ | | |

---

## 8. Parking lot

Items raised but not decided today (carry into next session or a Jerry task):

- ______________________________________________
- ______________________________________________
- ______________________________________________

Standing candidates: F15 embedding reindex ceremony; F16 evobrew boundary accept-vs-consolidate; F17 doc-drift fixes (after D1); U3 anthropic usageSink verification; U4 operation_not_found reproduction; U9 exec-cron script sweep.

---

## 9. Next actions

| # | Action | Owner | Due | Depends on |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |

Pre-approved for Jerry once D3 lands (brief §16 "autonomously later"): F12 rename; additive receipt fields (F6); registry seeding; probe labeling (F7); settings pair validation (F9); S1 read-only render; F11 lastTriggerAt persistence; divergence-report design.

---

*Cross-references: brief = `HOME23-MODEL-AUTHORITY-MORNING-BRIEF-2026-08-22.md` (§ numbers), audit = `HOME23-MODEL-PROVIDER-RUNTIME-AUDIT-2026-08-21.md` (F/S/U ids), inventory = `HOME23-MODEL-SURFACE-INVENTORY-2026-08-21.json`, target = `../design/HOME23-MODEL-AUTHORITY-TARGET-ARCHITECTURE-2026-08-21.md`.*
