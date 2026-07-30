# Standalone COSMO Implementation Program

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved standalone COSMO as eight bounded, dependency-ordered programs without writing or accepting a guided orchestration shell in place of the living cognitive system.

**Architecture:** A new TypeScript monorepo at `/Users/jtr/_JTR23_/cosmo` owns all COSMO source, releases, state contracts, and acceptance. Programs A–C establish preserved evidence, immutable authority, and claim provenance; Programs D and E form one inseparable executable cognitive gate; Programs F–H add inquiry, migration/acceptance, and standalone product packaging over the accepted core.

**Tech Stack:** Node.js 22.12+, TypeScript ESM, npm workspaces, Zod 4 schemas, filesystem content-addressed storage, SQLite indexes where non-authoritative lookup is required, `node:test`, OpenAI Agents SDK behind `WorkerRuntime`, React/Vite workbench, HTTP/SSE public API.

## Global Constraints

- The canonical source repository is `/Users/jtr/_JTR23_/cosmo`; Home23 is neither a package dependency nor a runtime host.
- Runtime and private installation state live under `~/.cosmo` and remain untracked.
- Historical roots are read-only inputs. No plan may rename, delete, rewrite, normalize, or mass-copy them.
- Every durable identity is content-addressed or explicitly names a content-addressed parent.
- No content-addressed payload may contain its own derived ID or the not-yet-computable ID of an enclosing Brain commit. Root leaves record an existing parent commit, causal events, or transaction intent; the root codec attaches the enclosing source commit only in decoded materialization output.
- Workers and model calls never write canonical Brain state.
- The Trust and Continuity Kernel validates authority and transition mechanics; it never determines semantic truth.
- Candidate cognition is admitted through quarantine and schema/grant/provenance checks before entering the cognitive journal.
- New external evidence must pass capability-checked discovery → receipted acquisition → immutable Corpus snapshot → extraction → EvidenceSpan; a URL, search result, or tool receipt is never evidence.
- A long-running session and its compaction state are runtime working memory, not the Brain and not sleep/dream.
- Program E owns the durable cognitive lifecycle engine, including autonomous continuation and sleep/dream triggers; Program H may host, wake, and observe it but may not recreate its scheduler policy.
- A clean repository becomes usable only through Program E's one model-free,
  parentless genesis transaction: B/C/D/E owner builders produce nine acyclic
  roots, scoped semantic events, the initial Covenant/Relationship and seed
  Questions; Program H supplies only an authority-free semantic draft and
  authenticated transport context.
- Merge is lossless authorized union before any separate metabolism commit.
- Every development workspace exports source and is added to the root lockfile before dependent tests; only Program H's isolated release staging rewrites package exports to built `dist` files.
- Deterministic, recorded, replay, and mock transports prove structure and faults only. Signed Program G semantic trials require real provider/model/runtime identities for autonomous, guided, Pure Mode, inquiry generation, and independent verification.
- Home23 must be absent from standalone build and acceptance environments.
- Program D and Program E share one acceptance gate; neither is a releasable COSMO milestone alone.
- No Program H Home23 client work begins without standalone acceptance and later explicit operator authorization.
- Use TDD, run the smallest focused test first, and commit after every independently reviewable task.
- Do not begin implementation until all Program A–H plans have passed the cross-plan review in this planning set.

---

## 1. Canonical Repository Layout

```text
/Users/jtr/_JTR23_/cosmo/
  AGENTS.md
  README.md
  package.json
  package-lock.json
  tsconfig.base.json
  tsconfig.build.json
  eslint.config.js
  .gitignore
  config/
    heritage-roots.example.json
    cosmo.example.json
  packages/
    contracts/
      src/
    foundation/
      src/
    heritage/
      src/
    repository/
      src/
    corpus/
      src/
    runtime/
      src/
    research/
      src/
    cognition/
      src/
    inquiry/
      src/
    migration/
      src/
    acceptance/
      src/
    product-contracts/
      src/
    api/
      src/
    client/
      src/
    cli/
      src/
  apps/
    service/
      src/
    workbench/
      src/
  fixtures/
    casebook/
    contracts/
    acceptance/
  docs/
    architecture/
    operations/
    receipts/
  scripts/
  tests/
```

### Package ownership

| Package | Sole responsibility | First owning program |
| --- | --- | --- |
| `@cosmo/contracts` | Core Zod schemas, branded IDs, and serializable A–G types; immutable after Program G acceptance | A, extended B–G |
| `@cosmo/foundation` | canonical JSON, hashing, atomic files, clocks, typed errors | A |
| `@cosmo/heritage` | read-only historical inventory, aliases, Git identity, fixture bundles | A |
| `@cosmo/repository` | object store, journal, commits, refs, forks, union, federation, redaction | B |
| `@cosmo/corpus` | sources, snapshots, extractions, evidence, claims, reviews, negative knowledge | C |
| `@cosmo/runtime` | `WorkerRuntime`, grants, leases, event quarantine, adapters, reconciliation | D |
| `@cosmo/research` | Covenant, Relationship, Questions, Principal, allocations, expeditions | D |
| `@cosmo/cognition` | living graph, activation, autonomous loop, metabolism, wake | E |
| `@cosmo/inquiry` | pinned Ask, Steer, Invent, provenance, formation trace, comparison | F |
| `@cosmo/migration` | typed legacy adapters and staged imports | G |
| `@cosmo/acceptance` | signed profiles, external harness, probes, ablations, receipts | G |
| `@cosmo/product-contracts` | H-only public status, HTTP/SSE, session, lifecycle, and release transport schemas over the accepted core | H |
| `@cosmo/api` | public HTTP/SSE handlers over frozen product contracts and narrow service ports | H |
| `@cosmo/client` | unprivileged public API client | H |
| `@cosmo/cli` | install, lifecycle, research, Brain, query, and verification commands | H |
| `apps/service` | standalone daemon composition only | H |
| `apps/workbench` | BrainStudio-style reader/operator UI | F, packaged H |

### Dependency direction

```text
contracts
  <- foundation
  <- heritage
  <- repository
       <- corpus
            <- runtime
            <- research
(runtime, research)
  <- cognition
       <- inquiry
       <- migration
       <- acceptance
            <- product-contracts
                 <- api
                 <- client
                 <- cli
                 <- service
       <- workbench
```

Imports may move only downward through this graph. `contracts` contains no runtime service logic. `repository` cannot import model, worker, inquiry, UI, or API code.
`runtime` and `research` are sibling consumers of `corpus` and lower
contracts. Neither may import the other's concrete workspace; their
collaboration occurs only through contracts-owned ports injected by the
composition root. `cognition` may consume both.

## 2. Cross-Program Type Authority

The following names and shapes are frozen by the program map. A detailed plan may add optional fields through a new schema version, but it may not rename or reinterpret these fields.

```ts
export type Sha256 = `sha256:${string}`;
export type ObjectId = Sha256;
export type BrainCommitId = Sha256;
export type CorpusSnapshotId = Sha256;
export type ArtifactId = Sha256;
export type EventId = `evt_${string}`;
export type RunId = `run_${string}`;
export type ExpeditionId = `exp_${string}`;
export type QuestionId = `q_${string}`;
export type ResearchProgramId = `program_${string}`;
export type ClaimId = `claim_${string}`;
export type ReviewFindingId = `review_${string}`;
export type RelationshipEventId = `rel_${string}`;
export type JournalCursor = `${number}`;
export type BrainRefName =
  `refs/${'heads' | 'tags' | 'settled'}/${string}`;

export type BrainRootKind =
  | 'epistemicRoot'
  | 'questionRoot'
  | 'programRoot'
  | 'relationshipRoot'
  | 'heritageRoot'
  | 'topologyRoot'
  | 'activationRoot'
  | 'negativeKnowledgeRoot'
  | 'artifactIndexRoot';

export interface ObjectRef {
  objectId: ObjectId;
  mediaType: string;
  byteLength: number;
}

export interface BrainObjectAddress {
  sourceCommitId: BrainCommitId;
  rootKind: BrainRootKind;
  rootObjectId: ObjectId;
  objectId: ObjectId;
}

export type BrainObjectLink =
  | {
      scope: 'local';
      rootKind: BrainRootKind;
      objectRef: ObjectRef;
    }
  | {
      scope: 'existing';
      address: BrainObjectAddress;
    };

export type BrainEventScope =
  | {
      kind: 'genesis';
      targetRef: BrainRefName;
      lineageId: Sha256;
      trustDomain: string | null;
    }
  | {
      kind: 'brain_lineage';
      basedOnBrainCommitId: BrainCommitId;
      targetRef: BrainRefName;
      programId: ResearchProgramId | null;
      lineageId: Sha256;
      trustDomain: string | null;
    };

export type GenesisBrainEventScope =
  Extract<BrainEventScope, { kind: 'genesis' }>;
export type BrainLineageEventScope =
  Extract<BrainEventScope, { kind: 'brain_lineage' }>;

export interface JournalRange {
  fromExclusive: JournalCursor;
  throughInclusive: JournalCursor;
}

export interface TrustDescriptor {
  ownerId: string;
  sensitivity: 'public' | 'private' | 'restricted';
  license: string;
  permittedUses: string[];
  retention: 'retain' | 'expire' | 'tombstone';
  exportable: boolean;
  encryptionDomain: string | null;
}
```

An address identifies one object as materialized through one exact root in one
exact Brain commit. A bare object ID is accepted by a read API only after the
chosen materialization proves exactly one match; merged or federated ambiguity
requires the full address.

Stored roots use `BrainObjectLink` whenever a subject, edge endpoint, activation
target, or cross-root update may name an object created in the same
not-yet-hashed Brain commit. A local link names the exact stored object and
destination root kind but cannot contain the future root object ID or child
commit ID. An existing link uses the full address of an already-existing
commit. After commit creation, materialization resolves every local link to a
full `BrainObjectAddress` using the accepted commit/root identities. Pretending
a new child object came from its parent or embedding a future child identity is
invalid.

Program B is the sole schema owner for `BrainObjectLink` and
`BrainEventScope`, including identity-derived canonical genesis and lineage
narrowings. Every journal event eligible for direct selection by a Brain commit
carries exactly one scope. Programs C and D import those same schema objects,
while Program E validates that every directly selected event matches the
commit's lineage/ref/trust boundary. Repository-global journal position is
never a substitute for branch membership.

### Canonical Brain commit

```ts
export interface BrainCommitPayload {
  schema: 'cosmo.brain-commit.v1';
  parentCommitIds: BrainCommitId[];
  corpusSnapshotIds: CorpusSnapshotId[];
  epistemicRoot: ObjectRef;
  questionRoot: ObjectRef;
  programRoot: ObjectRef;
  relationshipRoot: ObjectRef;
  heritageRoot: ObjectRef;
  topologyRoot: ObjectRef;
  activationRoot: ObjectRef;
  negativeKnowledgeRoot: ObjectRef;
  artifactIndexRoot: ObjectRef;
  journalRange: JournalRange;
  journalEventIds: EventId[];
  principalVersion: Sha256;
  kernelVersion: Sha256;
  schemaVersion: 1;
  createdAt: string;
}

export interface BrainCommit {
  commitId: BrainCommitId;
  payload: BrainCommitPayload;
  signatures: DetachedSignature[];
}
```

`commitId` is the SHA-256 hash of canonical `payload` bytes. Detached signatures are excluded from that hash.

`journalRange` proves the bounded repository high-water interval examined while
forming the commit; it is not event membership. `journalEventIds` is the exact
unique journal-ordered set newly selected by this commit. Verification resolves
each selected ID inside the declared range and rejects an unresolved,
duplicated, out-of-order, already-inherited, or foreign-scope ID. The repository
does not infer omission by scanning unrelated range records; D/E owner
transactions prove their own exact required no-omission event sets before
commit. Historical event closure comes from commit ancestry plus each
ancestor's explicit selections, never by replaying every repository-global
record between two cursors.

### Canonical Brain root registry

Program B opens a repository only when exactly one codec for each of the nine root fields is supplied. The codec schema identity and link-closure policy are public contracts owned by the program named here; Program B owns only frozen dispatch, recursive union wrappers for mergeable kinds, and whole-commit verification.

| Brain field / `BrainRootKind` | Sole leaf schema and codec owner | Frozen leaf artifact | Link-closure rule | Union behavior |
| --- | --- | --- | --- | --- |
| `epistemicRoot` | Program C | `EpistemicRootSnapshotSchema` / `epistemicRootCodec` | links every Claim, ReviewFinding, durable Claim-transition decision/update proposal, contradiction, and cited EvidenceSpan needed to reconstruct status | lossless attributed union |
| `questionRoot` | Program D | `QuestionRootPayloadSchema` / `questionRootCodec` | links each Question wrapper plus its causal-attestation, parent, evidence-gap, and event closure | lossless attributed union |
| `programRoot` | Program D | `ProgramRootPayloadSchema` / `programRootCodec` | links each Research Program state plus the Principal and lifecycle decision objects named by that state; mutation receipts remain in the journal because they reference the proposed root | target-parent leaf; changed only by an accepted D proposal |
| `relationshipRoot` | Program D | `RelationshipRootPayloadSchema` / `relationshipRootCodec` | links Covenant, projected Relationship state, and the complete non-deleted RelationshipEvent lineage | target-parent leaf |
| `heritageRoot` | Program B | `HeritageSnapshotSchema` / `heritageRootCodec` | links parent heritage roots and typed curation records without embedding the child commit ID | structural attributed union derived by Program B |
| `topologyRoot` | Program E | `TopologySnapshotSchema` / `topologyRootCodec` | links every fully attributed cognition node/edge and their admitted formation events | lossless attributed union |
| `activationRoot` | Program E | `ActivationSnapshotSchema` / `activationRootCodec` | links durable activation values, factors, policy, and source cognition at the existing parent pin | target-parent leaf; metabolism may derive a new leaf |
| `negativeKnowledgeRoot` | Program C | `NegativeKnowledgeRootSnapshotSchema` / `negativeKnowledgeRootCodec` | links every NegativeKnowledge wrapper, boundary, attempt, and evidence/review closure | lossless attributed union |
| `artifactIndexRoot` | Program D | `ArtifactIndexRootPayloadSchema` / `artifactIndexRootCodec` | links immutable artifact descriptors, bytes, derivation events, and exact existing Brain/corpus parent pins | lossless attributed union |

Every codec implements the exact Program B `BrainRootCodec` interface, declares one unique payload schema string, validates direct links and the complete recursively reachable object closure, and exposes the enclosing `sourceCommitId` only on the decoded `BrainRootMaterialization`. Programs B, C, D, and E each ship contract tests for their codecs; all nine exist before the joint D+E gate opens a repository. Program H's composition root enumerates these exact nine exported codec identities; runtime registration, opaque fallback codecs, duplicate kinds, missing kinds, or an unresolvable descendant are startup failures.

Program B also freezes an injected `BrainCrossRootValidator` and invokes it from
both `commitAndAdvance()` and `verifyCommit()` after all nine codecs succeed.
The production validator is composed from the owner modules and mechanically
requires: commit `corpusSnapshotIds` exactly equal the C Epistemic-root snapshot
set; every Question/Program/Relationship entry resolves to the typed record it
names; every topology subject and edge endpoint independently resolves either
as a local object in the declared root set or as a fully attributed object in
an existing commit; cross-layer edges may span different authorized roots;
every activation target resolves to an exact topology node through the same
local/existing rule; every NegativeKnowledge and artifact citation resolves
under the declared corpus/claim/event pins; and no root descendant embeds its
enclosing commit ID. Program E's `LivingBrainService.materialize()` repeats this
validation before exposing a view and expands local links into full addresses.
This validator checks referential and pin coherence only, never semantic truth.

### Evidence and cognition

```ts
export interface EvidenceSpan {
  evidenceSpanId: ObjectId;
  sourceObjectId: ObjectId;
  corpusSnapshotId: CorpusSnapshotId;
  extractionObjectId: ObjectId;
  locator: {
    kind: 'bytes' | 'lines' | 'pages' | 'time';
    start: number;
    end: number;
  };
  textSha256: Sha256;
}

export interface Claim {
  claimId: ClaimId;
  text: string;
  scope: string;
  status:
    | 'candidate'
    | 'supported'
    | 'contested'
    | 'disconfirmed'
    | 'superseded'
    | 'legacy_unverified'
    | 'retracted';
  supportingEvidenceSpanIds: ObjectId[];
  opposingEvidenceSpanIds: ObjectId[];
  reviewFindingIds: ReviewFindingId[];
  originEventId: EventId;
}

export type CandidateOrigin =
  | 'human'
  | 'worker'
  | 'principal'
  | 'specialist'
  | 'default_mode'
  | 'dream'
  | 'evidence_gap'
  | 'contradiction';

export interface CandidateClaimContent {
  statement: string;
  claimKind: 'observation' | 'interpretation' | 'causal' | 'forecast';
  scope: string;
}

export interface CandidateHypothesisContent {
  statement: string;
  testablePredictions: string[];
  falsificationConditions: string[];
}

export interface CandidateQuestionContent {
  wording: string;
  whyItMatters: string;
  parentQuestionIds: QuestionId[];
}

export interface CandidateConnectionContent {
  left: BrainObjectAddress;
  right: BrainObjectAddress;
  relationship: string;
  proposedMechanism: string | null;
  noveltyBasis: BrainObjectAddress[];
}

export interface CandidateContradictionContent {
  leftClaim: {
    claimId: ClaimId;
    address: BrainObjectAddress;
  };
  rightClaim: {
    claimId: ClaimId;
    address: BrainObjectAddress;
  };
  conflict: string;
  resolutionNeeded: string;
  opposingEvidenceSpanIds: ObjectId[];
}

export interface CandidateActivationContent {
  policyObjectId: ObjectId;
  derivedFromParentCommitId: BrainCommitId;
  entries: Array<{
    target: BrainObjectAddress;
    score: number;
    factorReceiptObjectId: ObjectId;
  }>;
}

export interface CandidateNegativeKnowledgeContent {
  boundary: string;
  scope: string;
  attemptedMethodObjectIds: ObjectId[];
  outcome: 'no_result' | 'inconclusive' | 'contradicted' | 'blocked';
  retryConditions: string[];
}

export interface CandidateFindingBase {
  schema: 'cosmo.candidate-finding.v1';
  origin: CandidateOrigin;
  evidenceSpanIds: ObjectId[];
  rationale: string;
}

export type CandidateFinding =
  | (CandidateFindingBase & {
      candidateType: 'claim';
      content: CandidateClaimContent;
    })
  | (CandidateFindingBase & {
      candidateType: 'hypothesis';
      content: CandidateHypothesisContent;
    })
  | (CandidateFindingBase & {
      candidateType: 'question';
      content: CandidateQuestionContent;
    })
  | (CandidateFindingBase & {
      candidateType: 'connection';
      content: CandidateConnectionContent;
    })
  | (CandidateFindingBase & {
      candidateType: 'contradiction_proposal';
      content: CandidateContradictionContent;
    })
  | (CandidateFindingBase & {
      candidateType: 'activation_proposal';
      content: CandidateActivationContent;
    })
  | (CandidateFindingBase & {
      candidateType: 'negative_knowledge';
      content: CandidateNegativeKnowledgeContent;
    });

export interface ReviewFinding {
  reviewFindingId: ReviewFindingId;
  subjectObjectId: ObjectId;
  reviewerIdentity: Sha256;
  attemptId: RunId;
  finding:
    | 'supports'
    | 'contests'
    | 'blocks'
    | 'escalates';
  dimensions: {
    entailment: boolean | null;
    sourceQuality: string;
    oppositionSearchSatisfied: boolean;
    maturity: string;
  };
  evidenceSpanIds: ObjectId[];
}
```

Program B Task 1 owns `BrainObjectAddressSchema`; it verifies the source commit/root tuple and permits a bare object ID at an API edge only after uniqueness is proven in the exact pinned materialization. Program D Task 1 is the sole implementing/export authority for `CandidateFindingSchema`. It is a strict discriminated union at both the finding and content levels: no variant permits `unknown`, raw provider payloads, authority, grants, leases, executable tool requests, or canonical IDs chosen by a worker. Claim candidates require evidence; a contradiction names two distinct attributed claims and its opposing spans are a subset of the finding's evidence; connection/activation targets preserve full root-layer attribution, activation scores are finite in `[0,1]`, and activation names an existing parent commit rather than the enclosing child commit; negative knowledge requires at least one attempted method or a durable blocked reason. Program C does not own or redefine this boundary.

### Research program and runtime

```ts
export interface AutonomyAllocation {
  directed: number;
  adjacent: number;
  wildcard: number;
  incubation: number;
}

export interface ExpeditionContract {
  schema: 'cosmo.expedition.v1';
  expeditionId: ExpeditionId;
  parentQuestionIds: QuestionId[];
  mission: string;
  brainCommitId: BrainCommitId;
  eventScope: BrainLineageEventScope;
  corpusSnapshotIds: CorpusSnapshotId[];
  covenantCommitId: BrainCommitId;
  principalVersion: Sha256;
  evidencePolicyId: ObjectId;
  allocation: AutonomyAllocation;
  capabilityGrantId: ObjectId;
  budget: {
    maxTokens: number;
    maxToolCalls: number;
    maxRuntimeMs: number;
    maxCostUsd: number;
  };
  stoppingCriteria: string[];
  honestBlockConditions: string[];
}

export interface RuntimeAuthorization {
  capabilityGrantId: ObjectId;
  covenantCommitId: BrainCommitId;
  missionHash: Sha256;
  branchEpoch: number;
  fencingToken: string;
  expiresAt: string;
}

export interface WorkerRuntime {
  runMission(
    mission: ExpeditionContract,
    context: ContextBundle,
    authorization: RuntimeAuthorization
  ): Promise<WorkerRuntimeExecutionHandle>;
  pause(runId: RunId): Promise<RuntimeCheckpointRef>;
  resume(
    checkpoint: RuntimeCheckpointRef,
    freshAuthorization: RuntimeAuthorization,
    expectedMissionHash: Sha256
  ): Promise<WorkerRuntimeExecutionHandle>;
  inspect(runId: RunId): Promise<RuntimeRunState>;
  cancel(runId: RunId): Promise<void>;
}
```

`WorkerRuntimeExecutionHandle`, `RuntimeAdapterCompletion`, the durable
`ExpeditionExecutionHandle`, and the owner-schema
`StructuredRoleExecutionPort` are frozen in Program D. A terminal provider
result is not complete merely because its event stream ended: the canonical
output and RuntimeReceipt must be durably stored before the completion promise
resolves. Principal, default mode, dream, independent review, and inquiry
generation/verification all use the one injected structured-role port; none
owns a second SDK or bare WorkerRuntime path.

Raw `WorkerEventEnvelope` objects enter the operational quarantine journal. Only admitted `CognitiveEvent` objects receive an `EventId` and enter canonical candidate history.

Program D's frozen `RuntimeReceipt.executionClass` is one of `live_provider`, `deterministic_conformance`, `recorded_conformance`, `replay`, or `mock`. Only `live_provider` with a null fallback can satisfy Program G semantic acceptance; the other classes remain valuable for structural, recovery, and fault tests.

### Inquiry and acceptance

```ts
export interface QueryRequest {
  queryId: string;
  mode: 'ask' | 'steer' | 'invent';
  intent:
    | 'answer'
    | 'explore'
    | 'surprise'
    | 'reflect'
    | 'challenge'
    | 'audit'
    | 'unknowns'
    | 'compare'
    | 'formation'
    | 'promote';
  brainCommitId: BrainCommitId;
  corpusSnapshotIds: CorpusSnapshotId[];
  parentQueryId: string | null;
  text: string;
}

export type RequiredHistoricalCaseId =
  | 'original-deep-code-self-audit'
  | 'autoscombo2'
  | 'jerryg'
  | 'standalone-jerryshows'
  | 'june-30-controlled-receipt'
  | 'degraded-home23'
  | 'old-new-jtr-brains'
  | 'terrapin-collapse'
  | 'bigmerge-cross-domain'
  | 'catastrophic-stem-humanities-aesthetic-merges'
  | 'menlo-park-zero-metrics'
  | 'truncated-checkpoint-unicode'
  | 'clawd-openclaw-continuity'
  | 'subject-brain-federation-merge';

export type RequiredReleaseScenarioId =
  | 'g.repository.genesis-brain.v1'
  | 'g.autonomous.sustained-observe-only.v1'
  | 'g.guided.satisfiable.v1'
  | 'g.guided.deliberately-blocked.v1'
  | 'g.pure.open-question.v1'
  | 'g.inquiry.brain-over-files.v1'
  | 'g.discovery.live-new-evidence.v1'
  | 'g.discovery.fresh-nonce-canary.v1'
  | 'g.metabolism.paired-sleep.v1'
  | 'g.relationship.export-import.v1'
  | 'g.negative-knowledge.dead-end.v1'
  | 'g.self-research.causal-origin.v1'
  | 'g.repository.union-materialization.v1'
  | 'g.repository.encrypted-restricted-export.v1'
  | 'g.git-for-brains.status-log-tag-settle-wake.v1';

export interface AcceptanceProfile {
  schema: 'cosmo.acceptance-profile.v1';
  profileId: Sha256;
  governingSpecHash: Sha256;
  requiredHistoricalCaseManifestId: Sha256;
  requiredHistoricalCaseIds: RequiredHistoricalCaseId[];
  fixtureManifestIds: Sha256[];
  startingBrainCommitIds: BrainCommitId[];
  corpusSnapshotIds: CorpusSnapshotId[];
  journalRanges: JournalRange[];
  artifactSetManifest: ObjectRef;
  covenantCommitId: BrainCommitId;
  evidencePolicyIds: ObjectId[];
  promptIdentityManifest: ObjectRef;
  toolIdentityManifest: ObjectRef;
  seedManifest: ObjectRef;
  hiddenOracleCommitments: ObjectRef;
  interventionSchedule: ObjectRef;
  executionIdentities: ObjectRef;
  productionExecutionRequirements: ObjectRef;
  budgets: ObjectRef;
  baselineIds: Sha256[];
  candidateBaselineParity: ObjectRef;
  pairedTrialCount: number;
  hardGates: ObjectRef;
  vectorThresholds: ObjectRef;
  scorerIdentities: ObjectRef;
  nondeterminismPolicy: ObjectRef;
  statisticalMethods: ObjectRef;
  nonRegressionRules: ObjectRef;
  humanReviewProtocol: ObjectRef;
  environmentPolicy: ObjectRef;
  signatures: DetachedSignature[];
}
```

Every referenced subdocument has its own strict versioned schema and content address. `profileId` hashes the canonical payload without `profileId` or `signatures`; detached signatures bind that ID. Verification resolves and hashes every referenced object before any candidate run. The first release requires all fourteen `RequiredHistoricalCaseId` values and all fifteen `RequiredReleaseScenarioId` values exactly once, including the model-free structural genesis scenario, and forbids post-output profile changes.

## 3. Program Plans and Gates

| Program | Detailed plan | Consumes | Independently testable product | Stop/go gate |
| --- | --- | --- | --- | --- |
| A | `2026-07-30-standalone-cosmo-program-a-preservation.md` | historical roots and approved spec | read-only heritage catalog, integrity anchors, portable casebook bundles | designated roots cataloged; source bytes unchanged; fixtures verify offline |
| B | `2026-07-30-standalone-cosmo-program-b-brain-repository.md` | A manifests and common primitives | immutable object/journal/commit/ref repository with fork, union, federation, redaction | crash, concurrency, export/import, union, and redaction gates pass |
| C | `2026-07-30-standalone-cosmo-program-c-evidence-claims.md` | B repository | corpus snapshots, EvidenceSpans, Claims, Reviews, contradictions, negative knowledge | seeded entailment, alias, injection, invalidation, and promotion traps pass |
| D | `2026-07-30-standalone-cosmo-program-d-research-runtime.md` | B+C contracts | Covenant, Relationship, Questions, Principal, expeditions, runtime adapters, and D-owned genesis leaves | contract suites pass; not accepted as COSMO until E vertical gate |
| E | `2026-07-30-standalone-cosmo-program-e-living-brain-metabolism.md` | B+C+D | parentless genesis, living graph, activation, autonomous loop, transactional sleep/dream | model-free genesis plus D+E vertical flow and paired sleep proof pass |
| F | `2026-07-30-standalone-cosmo-program-f-inquiry-workbench.md` | B–E | pinned Ask/Steer/Invent, idea lineage, comparison, workbench | frozen Brain-over-files proof passes read-only |
| G | `2026-07-30-standalone-cosmo-program-g-migration-acceptance.md` | A–F | typed legacy imports, signed acceptance harness, genesis conformance, shadow trials | all fifteen frozen release scenarios pass with Home23 absent |
| H | `2026-07-30-standalone-cosmo-program-h-standalone-product.md` | accepted A–G | standalone daemon, CLI, public API/client, packaged workbench, release | clean install/lifecycle receipt; no Home23 dependency |

### Declared shared integration registries

Implementation file ownership is exclusive except for these three ordered integration registries:

| Shared file | Bootstrap owner | Later authorized changes |
| --- | --- | --- |
| `package.json` and `package-lock.json` | Program A Task 1 | The workspace/dependency/script task that explicitly names the change in any later Program B–H; every new workspace runs `npm install` and commits its lockfile entry before dependent tests |
| `packages/contracts/src/index.ts` | Program A Task 1 | Programs B–G contract-freeze tasks may append only their reviewed exports; Program G then hashes and freezes the package as accepted core, and Program H may not modify it |
| `packages/product-contracts/src/index.ts` | Program H Task 1 | Program H alone; it imports accepted core schemas and owns only product/status/transport contracts |

No other cross-program implementation path may have more than one owning program. Generated build output and receipts do not transfer source ownership.

## 4. Governing-Spec Coverage Map

| Governing design section | Executable plan coverage |
| --- | --- |
| §§1–3 Executive decision, product identity, scope, and non-goals | A1 independent repository; master global constraints; H5 standalone composition; H10 separation and future-client gate; H11 clean-room receipt |
| §4 Historical canon and evidence limits | A4–A7 immutable inventory, Git identity, catalog, and casebook; G2–G4 typed read-only adapters |
| §5 Regression model and protected “chaos” | D3–D6 Question Ecology, allocation, Principal periodicity; E5/E8 autonomous/default-mode/dream origination; G8–G9 causal behavioral gates |
| §§6–7 architecture and non-negotiable invariants | A1–A3 foundation; B1–B6 authority; C1/C5/C9 evidence policy; D7 quarantine; E6/E9 atomic metabolism; F2 mutation-free Ask; H5–H6 honest lifecycle |
| §8 canonical cognitive model and separations | B/C/D/E owner-only genesis builders and E parentless transaction; B1/B6 commit authority; C1–C7 epistemic objects; D1–D3 program/relationship/questions; E1–E4 Living Brain; F1 assertion contracts |
| §9 Principal Researcher and Research Relationship | D2 Relationship, D6 durable Principal, D11 integration flow; G9 Relationship and self-research proofs |
| §10 Question Ecology and autonomous rhythm | D3 Question lifecycle and causal-origin attestation; D4 allocations and recomputed autonomy floor; E5 default-mode rhythm and E-owned durable lifecycle engine; E8 dream/incubation questions; G9 observe-only autonomous and Pure Mode gates |
| §11 Expedition Engine and WorkerRuntime | D4 ExpeditionContracts; D5 COSMO-owned ContextBundles; D7 admission; D8 capability-checked discovery/acquisition/experiment registry plus deterministic adapter; D9 recovery; D10 production adapter |
| §12 Evidence Corpus and epistemic promotion | C2 receipted acquisition bridge and immutable child snapshots; C3–C6 identity, spans, policy, claims, reviews; C7 negative knowledge; C8 experiment bench; C9 injection boundary; C10 consequences; G live absent-evidence acquisition case |
| §13 Living Brain | E2 typed graph and formation; E3 topology/activation; E4 self-model; E7 consolidation/contradiction; E9 wake state |
| §14 sleep/dream metabolism | E5 trigger policy; E6 fenced transaction; E7 reversible consolidation; E8 dream/challenge; E9 pruning/wake; E10 paired proof; G9 release proof |
| §15 Brain Repository and Git for Brains | B4 journal; B5 refs/leases plus status/log/tag; B6 commits and heritage root; B7 fork/diff; B8 recursively materializable lossless union; B9 federation; B10 export/import; B11 encryption/redaction; B12 settle/wake and recovery |
| §16 Inquiry and Workbench | F1–F9 pinned Ask/Steer/Invent, authority-free public DTOs, production generator/verifier port, assertion types, formation, comparison, Brain-over-files; F10–F13 workbench; H3/H8 API and packaging |
| §17 trust, security, continuity, and failures | A2 trust; B3 grants; B12 recovery; C5/C9 policy and injection; D7/D9 fenced admission/recovery; E6 transaction; H2 auth; H6 lifecycle; H10 separation |
| §18 historical preservation and migration | A4–A8 preservation gate; G1–G5 import classes, staging, reconciliation, and CAS publication |
| §19 evaluation and acceptance | A7 closed fourteen-case portable historical casebook; G6 exact signed profile and all referenced pins plus the model-free genesis structural scenario; G7 external observe-only harness; G8 all hard gates, new-source acquisition, real semantic providers, and Brain-over-files; G9 vector/behavior/ablation proofs; G10 continuity/core isolation; H11 clean install → genesis → first Research Program and final clean release |
| §20 delivery decomposition | This master map and the eight detailed plans |
| §21 first restoration boundary and deferrals | Program A–H stop/go gates; E establishes one model-free genesis boundary; H10 keeps deferred adapters out; H11 proves clean install → genesis → first Research Program before the named first-release lifecycle |
| §22 decision log | Frozen master constraints, shared types, dependency direction, D+E gate, G acceptance authority, and H separation gate |
| §23 objective traceability | This coverage map plus the Program A heritage manifest and Program G measurement receipts |
| §24 governing test | D+E vertical gate, G zero-tolerance cognitive acceptance, H clean-room lifecycle, and the final human product review |

## 5. D+E Vertical Acceptance Gate

Programs D and E must jointly prove this exact flow before either can be called a functioning COSMO:

```text
specialist/default-mode/dream/evidence-gap/contradiction-originated Question
  -> kernel-recomputed causal attestation proves autonomous origin
  -> bounded ExpeditionContract
  -> capability-checked discovery/acquisition when evidence is absent
  -> immutable child Corpus snapshot and exact EvidenceSpan
  -> admitted CandidateFinding
  -> candidate-only branch commit whose sole parent is the canonical base
  -> post-commit independent ReviewFinding and qualification
  -> Claim-transition decision when applicable
  -> Principal disposition based on that candidate commit and scoped to the canonical target
  -> reviewed acceptance commit whose sole parent is the candidate commit
  -> canonical ref CAS directly from the still-current base to that descendant
  -> metabolism transaction
  -> wake BrainCommit
  -> read-only pinned surprise/formation query
```

Candidate admission events are direct selections of the candidate commit and
are inherited by the reviewed descendant. The acceptance commit directly
selects only its scoped review findings, review-completed marker,
qualifications, Claim-transition when applicable, Principal decision, and
acceptance event; it never cherry-picks the admission range, adds a second
parent, or constructs a partial union. An autonomous-research candidate
commit's recursively
materialized closure retains the exact stored D research receipt and therefore
its runtime, ContextBundle, tool, source, evidence, and admitted-event
provenance. The acceptance closure retains the exact stored D committed-review
receipt. A review or decision from an interleaved candidate branch is rejected.
Default-mode and dream generators may also publish a candidate directly from a
stored Program D structured-role attempt, and Human Invent may publish one from
an admitted operation plus stored draft/preview. Those paths use strict
origin-specific candidate receipts instead of fabricating a D research
receipt, but they join this same post-candidate-commit independent review,
Principal disposition, reviewed acceptance, metabolism, and wake sequence.
The structural flow runs through the
deterministic conformance adapter first and the production-adapter contract
second. It must include a forced restart, context turnover, late fenced event,
simultaneous metabolism attempt, and exact pre-query lineage. Recorded
transport can satisfy only contract/fault conformance. Program G repeats the
semantic portions with signed real provider/model/runtime identities, separate
live inquiry generator/verifier attempts, and no fallback before any release
decision.

## 6. Cross-Plan Review Checklist

Before any implementation:

- [ ] Every governing-spec section maps to at least one detailed task.
- [ ] Every implementation path has one owning program except the three declared shared integration registries.
- [ ] Every produced interface is repeated exactly in consuming plans.
- [ ] All ID, schema, event, commit, runtime, and acceptance names match this map.
- [ ] Every added workspace has source-development exports, exact build/test scripts, and a committed root lockfile entry before dependent tests.
- [ ] Every A–H gate tests a clean committed candidate and commits only its command-derived receipt afterward.
- [ ] No release-semantic gate can be satisfied by deterministic, recorded, replay, mock, skipped, or missing-provider execution.
- [ ] No plan contains unfinished-marker language, an unresolved design choice, or an undefined implementation step.
- [ ] D and E cannot be executed or accepted independently as a guided shell.
- [ ] G cannot weaken acceptance thresholds after candidate output.
- [ ] H contains no Home23 import, runtime hosting, supervision, or mutable-state access.
- [ ] Optional Home23 client work is a post-acceptance, separately authorized operation.
- [ ] Each task ends with a focused test, broader relevant test, and intentional commit.

## 7. Execution Order

```text
A
  -> B
      -> C
          -> D contract work
          -> E cognitive work
          -> joint D+E gate
              -> F
                  -> G
                      -> H
```

No later program starts merely because an earlier task produced files. Its explicit stop/go gate must pass and its receipt must be committed.
