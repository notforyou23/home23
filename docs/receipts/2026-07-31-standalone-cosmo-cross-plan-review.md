# Standalone COSMO — §6 Cross-Plan Review Receipt (2026-07-31)

**Subject:** the 9-document planning set at `23cd6e3d` (plans) + `f77c8630` (governing design)
**Mandate:** master plan §6 "Cross-Plan Review Checklist" — the designated preflight; per the master, implementation must not begin until this passes.
**Method:** 10 independent reviewers (one per checklist cluster), evidence-first (file+line+quote required per finding), ~1.80M tokens, 398 tool uses, ~20 min. Full structured output archived in the session task record; findings verified severity-first by the orchestrating session.
**Separately:** a manual deep-read of Programs B, D, E, G by the orchestrating session (findings ledger at bottom).

## Verdict: NOT YET PASSED — 1 checklist item fails, 4 carry concerns, 5 pass

| Checklist cluster | Verdict |
| --- | --- |
| Governing-spec coverage (§4 map vs design §1–24) | PASS (2 minor attribution fixes) |
| **File ownership uniqueness** | **FAIL (2 blockers)** |
| Interface exactness: E vs D/B/C | PASS (2 minors) |
| Interface exactness: D vs B/C; F vs upstream | CONCERN |
| Interface exactness: G/H vs upstream | CONCERN (2 majors) |
| Name authority (§2 frozen names) | PASS (1 minor) |
| Workspace/lockfile/test-commit hygiene | CONCERN (2 majors) |
| Live-gate purity + no-weakening | CONCERN (1 major) |
| Unfinished-marker sweep | PASS (zero findings across ~40k lines) |
| D/E coupling, H separation, client gate | PASS (1 minor) |

## Blockers (must fix before the planning freeze is released)

**BLK-1 — E Task 11B and G Task 5 both own the same three files.**
`packages/cognition/src/legacy-import-candidate-service.ts`, its test, and `packages/cognition/src/index.ts` are Created/Modified by both plans; neither references the other; their step sequences assume contradictory states (G T5 implements+commits the service; E T11B expects it absent), and the test dependencies are circular (E T11B Step 4 runs tests only G T5 creates; G T5 Step 3 runs the test only E T11B creates). Under either execution order one plan is unexecutable as written.
*Proposed fix:* cognition is E-owned per the master package table — E Task 11B keeps sole ownership of the service+test+index; G Task 5 drops its Create/implement/commit steps for those files and consumes the E service, with an explicit cross-reference and ordering note (E T11B executes at G-time, after G T1 freezes the legacy contracts — make that interleave explicit in both plans).

**BLK-2 — G Task 5 writes inside C/D/E-owned packages.**
G modifies C-owned `packages/corpus/src/index.ts` and D-owned `packages/research/src/index.ts` and creates implementation files in those packages (`legacy-import-proposal.ts`, `legacy-import-proposals.ts`) — none declared shared.
*Proposed fix:* either move those proposal modules into `@cosmo/migration` (G-owned) behind ports the C/D packages already export, or declare narrow, reviewed ownership transfers in the master's shared-registry table. The first is cleaner and preserves the ownership law.

## Majors

1. **Sleep-proof statistical bar is stated three contradictory ways.** G Task 6's frozen threshold table: "≥9 treatment wins across 15 preregistered fixture-pairs" (ties count against). G's profile root: `pairedTrialCount` exactly 3. E's `PairedSleepProof.run()`: `pairedTrialCount: 5` meaning fixture count. Same identifier, different meanings, different numbers. *Fix:* one preregistered bar, one vocabulary (e.g. `fixturePairCount` vs `replicatesPerPair`), reconciled across G T6/T9 and E T10 — and this is the moment to set the statistically honest number (see ledger G-1).
2. **H consumes `BrainLogEntrySchema`, which no plan produces** (B produces `BrainLogPage` of `BrainCommit[]`). H forbids route-local approximations while depending on a phantom schema. *Fix:* H restates over `BrainLogPage`, or B adds the entry schema to its contract-freeze task.
3. **`RequiredHistoricalCaseIdSchema` is declared twice** (A `heritage.ts`, G `acceptance.ts`), both exported from the shared contracts index — a guaranteed export collision. *Fix:* A owns it; G imports.
4. **G workspace tasks (T2, T6) never commit the root lockfile as an executable step before dependent tests** — the master's rule exists precisely to prevent unresolvable-workspace failures mid-plan. Same defect in **all five H workspace tasks** (T1, T2, T4, T5, T7). *Fix:* insert the lockfile commit step after each workspace creation, before any dependent red-phase run.

## Minors (fix during execution; none gate the freeze)

Map attributions (Pure Mode → G1/G6/G7/G12 not G9; status/log/tag → B7/B12 not B5) · E's contracts-import block mislabels provenance as "Program D services" · `DESeedQuestionDraftSchema` name never declared by D (D has the interface, different export locus) · F renames formal params in "frozen" copies (`id`/`commitId`, `ref`/`name`) · **F re-declares five A-owned ID schemas as lookalike Zod objects (transform-built) instead of importing — silent parse-behavior divergence risk; treat as must-fix-on-contact** · `canonicalJsonBytes()` consumed 7× (C/G/H) but produced nowhere (A exports string-returning `canonicalJson`) — trivial shim, but a guaranteed build break as written · H's SSE `research_run` introduces `queued`, absent from D's frozen run-status union, with no mapping for `authorized` · `WakeBriefingSchema` attributed to F, produced by E · G's Brain-over-files test fields drift from G's own frozen schema (`assertionType` vs `type`, etc.) · four master-frozen leaf-schema constant names never appear verbatim in owner plans · five B tasks end on focused tests only (no broader tier) · G/H red-phase runs ordered before workspace manifests exist (failure will be `ERR_MODULE_NOT_FOUND`, misdiagnosed in the plan text) · D T10/H T3 defer lockfile commit to end-of-task · A's own post-bootstrap registry touches aren't literally authorized by the "later Program B–H" wording · F Task 10 omits `Modify: package-lock.json` from its Files block · **H's service defaults to port 43210 — the port live cosmo23 occupies on the operator's machine** (clean-room fine; operator-machine collision; change the default).

## Manual deep-read ledger (orchestrating session)

- **E-1 / G-1 (decision):** first-release sleep-proof statistics — now sharpened by Major 1. Recommend: 15 fixture-pairs × ≥9 wins (G T6's own table) as the single bar; kill the exactly-3 replicate pin or rename+justify it.
- **E-2 (recommendation):** off-plan, non-gating "soul spike" — run default-mode + dream generators against a live provider as soon as D T10 + E T5/T8 exist; observational receipts only.
- **E-3 (build-harness):** the interface-exactness findings above empirically validate the planned contract-identity hash-pin suite; build it in Program A.
- **D-1 (decision):** the standalone is OpenAI-only at birth (`@openai/agents@0.14.1`; zero mention of Anthropic/Ollama/xAI in D or the design). Architecturally contained behind `WorkerRuntime`, but single-vendor cognition + OpenAI-signed acceptance receipts should be an explicit operator decision.
- **G-2 (pass):** 8-hour externally-observed sustained-autonomy scenario is the program's strongest instrument; confirms ~8h+ irreducible wall-clock in G.
- **G-3 (decision):** no legacy-corpus/cosmo23 maintenance-freeze date exists anywhere; every day of live Jerry/cosmo23 activity widens G's import surface.
- **B (clean at plan level):** catastrophe-oracle union fixture and three-way redaction verification (`valid` / `valid_with_authorized_redactions` / `corrupt_missing_object`) are the strongest designs in the set. Unverified at this depth: B4/B6 journal no-omission mechanics, union performance at 65k-node scale — moved to the implementation drill list.

## Gate state (revision 1)

§6 is **not satisfied** until BLK-1, BLK-2, and Majors 1–4 land as plan edits (all are document surgery — no code exists yet; estimated well under a session). Minors may be batched or fixed on contact. Per the master: "Do not begin implementation until all Program A–H plans have passed the cross-plan review." The planning-freeze release remains an explicit operator decision after those edits.

---

# Revision 2 (2026-07-31, same day)

**Surgery applied at `5a448906`** (9 files, +436/−90): BLK-1/BLK-2 resolved by making G Task 5 consumer-only and adding owner extensions **C Task 12** and **D Task 13** (patterned on E Task 11B, executed in the Program G window after G T1's contract freeze), with E Task 11B absorbing the E-owned topology proposal builder; MAJ-1 harmonized (the three sleep numbers were one design — 5 frozen fixtures × 3 replicates = 15 preregistered fixture-pairs, ≥9 wins ties-against; the defects were T9's weaker tie handling and the `pairedTrialCount` identifier collision, fixed by aligning T9 to T6 verbatim and renaming E's option to `fixturePairCount`); MAJ-2 (H-owned `PublicBrainLogEntrySchema` projected from B's `BrainCommit`); MAJ-3 (A sole declarer, G imports by identity); MAJ-4 (executable lockfile-registration steps in all seven G/H workspace tasks); plus all 15 revision-1 minors.

**Re-review fleet** (10 reviewers, same clusters, revision-2 prompts requiring semantic verification of each prior finding + a sweep of the ~430 new lines): **0 fail / 1 concern / 9 pass.** Both blockers and all four majors verified resolved on semantics — the ownership reviewer re-extracted all 718 Create/Modify declarations across the eight plans and confirmed zero cross-program collisions outside the three declared registries, with the extension ordering acyclic (G T1 → C12/D13/E11B → G T5). The marker sweep stayed at zero across the enlarged set.

**R2 residue** (16 new minors — chiefly consistency fallout of the surgery itself: File Map inventories, master §7/§18 silence on the extensions, duplicate lockfile prose — plus carried-over old minors including F's frozen-copy param renames and the not-applicable reason field) **landed at `63c6322e`**, orchestrator-spot-verified: E T11B's test aligned to the frozen receipt fields (`previousCandidateHead`/`candidateRef`), the tie rule now present at all three G sites, H's `parentCommitIds` bound removed, `notApplicableReasons` with pre-output case-level reasons added to `VectorThresholdsDocumentSchema`, and the seven G/H registration steps left as the single authority on lockfile commits.

## Gate state (final)

**§6 is SATISFIED** at `63c6322e`: no fail verdicts, no blockers, no majors outstanding; every revision-1 and revision-2 finding is either fixed or (three wording-level items) fixed in the residue batch. Per the master's own rule, what remains before implementation is not review work but **operator decisions**: (1) release the planning freeze; (2) confirm OpenAI-only-at-birth as deliberate (ledger D-1); (3) set the cosmo23 maintenance-freeze date (ledger G-3). Ledger E-2 (early off-plan soul spike) stands as a build-phase recommendation.
