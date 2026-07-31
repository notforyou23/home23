# Standalone COSMO Program E: Living Brain and Memory Metabolism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build COSMO's typed Living Brain, recursively materialized merged-Brain cognition, reproducible topology and activation, explicit evidence-bound self-model, durable autonomous/default-mode lifecycle, and fenced transactional sleep/dream metabolism, then pass the mandatory joint Program D+E cognitive vertical gate.

**Architecture:** `@cosmo/cognition` recursively resolves Program B union-root layers into attributed, queryable composite cognition without collapsing parent reachability, while Program D remains the owner of questions, expeditions, Principal decisions, and worker execution. Program E owns the durable cognitive lifecycle decision engine: a commodity host may wake it with time and an opaque wake ID, but cannot choose its next question, expedition, or sleep action. Metabolism pins an immutable parent and journal high-water mark, records every semantic stage output, validates reversible transformations, and advances a branch exactly once through Program B's fenced CAS.

**Tech Stack:** Node.js 22.12+, TypeScript ESM, npm workspaces, Zod 4 schemas, filesystem content-addressed storage, SQLite indexes only for non-authoritative lookup, `node:test`, Program B `BrainRepository`, Program C claim/evidence services, and Program D research/structured-role execution services.

## Global Constraints

- The canonical source repository is `/Users/jtr/_JTR23_/cosmo`; Home23 is neither a package dependency nor a runtime host.
- Runtime and private installation state live under `~/.cosmo` and remain untracked.
- Historical roots are read-only inputs. No plan may rename, delete, rewrite, normalize, or mass-copy them.
- Every durable identity is content-addressed or explicitly names a content-addressed parent.
- No stored E root or object embeds its own object ID or the child/enclosing
  Brain commit ID. A root carries the strict `RootDerivation` union: normal
  roots name one already-existing exact parent commit; genesis roots carry only
  the explicit genesis lineage ID and no fake/future commit ID. Program B
  attaches the enclosing source commit during materialization.
- Workers and model calls never write canonical Brain state.
- The Trust and Continuity Kernel validates authority and transition mechanics; it never determines semantic truth.
- Candidate cognition is admitted through quarantine and schema/grant/provenance checks before entering the cognitive journal.
- A long-running session and its compaction state are runtime working memory, not the Brain and not sleep/dream.
- Merge is lossless authorized union before any separate metabolism commit.
- A `cosmo.union-root.v1` object is never parsed as a leaf snapshot. Recursive resolution preserves every source layer, wrapper, and reachable parent before composite cognition or metabolism.
- Program C is the sole Epistemic-root schema/codec owner. Program E stores cognition node/edge/self-model refs only in Topology roots and combines C, D, and E materializations into a Living Brain view.
- Home23 must be absent from standalone build and acceptance environments.
- Program D and Program E share one acceptance gate; neither is a releasable COSMO milestone alone.
- No Program H Home23 client work begins without standalone acceptance and later explicit operator authorization.
- Use TDD, run the smallest focused test first, and commit after every independently reviewable task.
- Do not begin implementation until all Program A–H plans have passed the cross-plan review in this planning set.
- A metabolism run never mutates its parent commit, consumes journal events after its pinned high-water mark, or exposes a partial child.
- A dream begins as an unverified `CandidateFinding`; it cannot create a supported fact, change claim status, or widen authority.
- Pruning changes activation and default retrieval before retained cognition; access frequency is never a deletion rule.
- Program E's stop/go receipt is invalid unless the deterministic D+E behavioral-contract gate and the recorded production-code-path structural/fault gate both pass.
- Recorded model transport is never evidence of production-provider semantic quality. Program G alone may grant production semantic acceptance under a signed live-provider profile.
- Program E owns durable lifecycle state, due-work selection, and next-wake decisions. Program H may host timers and call `wakeDue()`; it may not reproduce or override cognitive scheduling policy.
- Program D is the sole Research Program state writer; Program E is the sole canonical acceptor of D Program-root proposals and sole authority for control convergence, settlement disposition, and `nextWakeAt`. Program H only delivers notices/wakes.
- Program E alone creates a parentless Brain. `GenesisBrainService` invokes the
  dedicated B/C/D/E owner builders, composes exactly nine verified roots,
  selects only explicit genesis journal events, and performs one absent-ref
  CAS. Normal semantic-root mutation APIs cannot manufacture genesis.

---

## Prerequisites and stop/go boundary

Execute this plan only after Programs A–C have committed their stop/go receipts and Program D has a green contract suite. Program B's receipt must include the recursive union-layer resolver and Git-for-brains wake contract. The Program D receipt must still state `cosmoAccepted: false` and `blockedOn: 'program-e-living-brain-metabolism'`; Program E replaces that core blocked state only after Task 12, while production semantic acceptance remains explicitly deferred to Program G.

Program E is not independently releasable. A green graph suite without autonomous cognition and metabolism is insufficient, and a green Program D runtime suite without the Living Brain remains a guided execution shell.

## File map

### Extend public contracts

- Create `packages/contracts/src/cognition.ts` — public Living Brain, topology, activation, self-model, metabolism, wake, and formation-trace schemas.
- Modify `packages/contracts/src/index.ts` — export the Program E contracts.
- Test `packages/contracts/test/cognition.test.ts` — schema acceptance and rejection traps.
- Create `packages/contracts/test/support/cognition-fixtures.ts` — strict schema-complete mutation fixtures for contract tests.
- Modify `package-lock.json` — workspace lockfile refresh after adding `@cosmo/cognition`.

### Create `@cosmo/cognition`

- Create `packages/cognition/package.json` — workspace package and focused test scripts.
- Create `packages/cognition/tsconfig.json` — ESM build configuration inherited from the root.
- Create `packages/cognition/src/index.ts` — public exports only.
- Create `packages/cognition/src/living-brain.ts` — immutable graph materialization and root accounting.
- Create `packages/cognition/src/union-materializer.ts` — typed attributed composition over Program B root-registry materializations.
- Create `packages/cognition/src/brain-root-codecs.ts` — Program B leaf codecs for Topology and Activation roots.
- Create `packages/cognition/src/genesis-brain-service.ts` — owner-builder orchestration and the sole parentless nine-root Brain transaction.
- Create `packages/cognition/src/topology.ts` — typed-edge validation and bounded causal formation traces.
- Create `packages/cognition/src/activation.ts` — deterministic transient and durable activation projections.
- Create `packages/cognition/src/self-model.ts` — explicit observational self-model and authority checks.
- Create `packages/cognition/src/default-mode-loop.ts` — awake/default-mode signal evaluation and autonomous question proposals.
- Create `packages/cognition/src/lifecycle-store.ts` — durable append-before-act lifecycle decisions and restart projection.
- Create `packages/cognition/src/cognitive-lifecycle-engine.ts` — due-work selection, dispatch, sleep/wake, and next-wake ownership.
- Create `packages/cognition/src/program-control.ts` — D Program-root mutation acceptance, convergence, and settlement handshake.
- Create `packages/cognition/src/metabolism-trigger.ts` — adaptive due/defer policy.
- Create `packages/cognition/src/metabolism-store.ts` — content-addressed, idempotent semantic-stage output recording.
- Create `packages/cognition/src/metabolism-runner.ts` — high-water, lease, fencing, replay, resume, and CAS transaction.
- Create `packages/cognition/src/stages/consolidate.ts` — reversible equivalence proposals and lineage mappings.
- Create `packages/cognition/src/stages/contradictions.ts` — contradiction and provenance-gap candidates.
- Create `packages/cognition/src/stages/dream.ts` — typed bridge hypotheses and incubation questions.
- Create `packages/cognition/src/stages/challenge.ts` — independent challenge enforcement.
- Create `packages/cognition/src/stages/prune.ts` — activation/default-retrieval pruning without epistemic loss.
- Create `packages/cognition/src/stages/validate.ts` — structural, rights, provenance, and object-accounting invariants.
- Create `packages/cognition/src/stages/wake.ts` — child roots and exact wake briefing.
- Create `packages/cognition/src/paired-sleep-proof.ts` — deterministic control/treatment comparison used by the Program E gate.
- Create `packages/cognition/src/de-vertical-gate.ts` — mandatory Program D+E flow and receipt.
- Create `packages/cognition/src/legacy-import-candidate-service.ts` — G-proposed, candidate-only nine-root import acceptance.

### Tests and frozen fixtures

- Create `packages/cognition/test/helpers/fixtures.ts` — canonical IDs, in-memory repository root, and fixture graph builders.
- Create `packages/cognition/test/living-brain.test.ts`.
- Create `packages/cognition/test/union-materializer.test.ts`.
- Create `packages/cognition/test/brain-root-codecs.test.ts`.
- Create `packages/cognition/test/genesis-brain-service.test.ts`.
- Create `packages/cognition/test/topology.test.ts`.
- Create `packages/cognition/test/activation.test.ts`.
- Create `packages/cognition/test/self-model.test.ts`.
- Create `packages/cognition/test/default-mode-loop.test.ts`.
- Create `packages/cognition/test/cognitive-lifecycle-engine.test.ts`.
- Create `packages/cognition/test/metabolism-trigger.test.ts`.
- Create `packages/cognition/test/metabolism-runner.test.ts`.
- Create `packages/cognition/test/metabolism-semantics.test.ts`.
- Create `packages/cognition/test/metabolism-faults.test.ts`.
- Create `packages/cognition/test/paired-sleep-proof.test.ts`.
- Create `packages/cognition/test/legacy-import-candidate-service.test.ts`.
- Create `tests/vertical/d-e-cognitive-flow.test.ts`.
- Create `tests/vertical/d-e-production-adapter.test.ts`.
- Create `tests/vertical/e-autonomous-lifecycle.test.ts`.
- Create `tests/vertical/union-cognition-metabolism.test.ts`.
- Create `fixtures/contracts/metabolism/contradiction-bridge.json`.
- Create `fixtures/contracts/metabolism/dormant-resonance.json`.
- Create `fixtures/contracts/metabolism/duplicate-lineage.json`.
- Create `fixtures/contracts/metabolism/negative-knowledge.json`.
- Create `fixtures/contracts/metabolism/cross-domain-question.json`.
- Create `scripts/verify-program-e.mjs` — aggregate D+E verification and canonical receipt writer.
- Modify `package.json` — add `verify:program-e`.
- Create `docs/receipts/program-e-living-brain-metabolism.json` — generated and then reviewed machine-readable gate receipt.

## Frozen consumed interfaces

Program E repeats and consumes these Program B exports without adapters that weaken their semantics:

```ts
openBrainRepository(input: {
  rootDir: string;
  rootCodecs: readonly BrainRootCodec[];
  crossRootValidators: readonly BrainCrossRootValidator[];
  clock?: Clock;
  signer?: Signer;
  faultInjector?: FaultInjector;
  encryptionKeyProvider?: EncryptionKeyProvider;
}): Promise<BrainRepository>;

repository.objects.put(
  input: PutObjectInput,
  authorization: MutationAuthorization
): Promise<ObjectRef>;
repository.objects.get(
  ref: ObjectRef,
  authorization?: MutationAuthorization
): Promise<StoredObject>;
repository.journal.read(range: JournalRange): AsyncIterable<JournalRecord>;
repository.journal.head(): Promise<JournalCursor>;
repository.commits.get(id: BrainCommitId): Promise<BrainCommit>;
repository.commits.eventClosure(
  id: BrainCommitId
): Promise<CommitEventClosure>;
repository.refs.get(ref: BrainRefName): Promise<BrainCommitId | null>;
repository.leases.acquire(input: AcquireLeaseInput): Promise<LeaseProof>;
repository.leases.renew(proof: LeaseProof, ttlMs: number): Promise<LeaseProof>;
repository.leases.release(proof: LeaseProof): Promise<void>;
repository.commitAndAdvance(input: CommitAndAdvanceInput): Promise<CommitAdvanceReceipt>;
repository.curation.createSnapshot(input: {
  parentHeritageRoots: ObjectRef[];
  curationEventIds: ObjectId[];
  trust: TrustDescriptor;
  authorization: MutationAuthorization;
}): Promise<ObjectRef>;
repository.resolveUnionRootLayers(
  input: ResolveUnionRootLayersInput
): Promise<ResolvedUnionRootLayers>;
repository.roots.verify(
  input: VerifyBrainRootInput
): Promise<BrainRootVerification>;
repository.roots.materialize<T>(
  input: VerifyBrainRootInput
): Promise<BrainRootMaterialization<T>>;
repository.heritageGenesis.build(
  input: HeritageGenesisBuildInput
): Promise<HeritageGenesisRoots>;

interface LeaseProof {
  leaseId: `lease_${string}`;
  resource: string;
  epoch: number;
  fencingToken: string;
  expiresAt: string;
}
```

Program E consumes these contracts-package exports and does not reimplement them; their declared owners vary (master §2 types are program-map-owned; D-owned entries are those frozen under Program D's **Program E Integration Surface**):

```ts
import {
  AcceptedClaimTransitionPayloadSchema as PublicAcceptedTransitionPayloadSchema,
  AcceptedClaimTransitionSchema as PublicAcceptedTransitionSchema,
  AcceptedClaimTransitionPayloadSchema,
  AcceptedClaimTransitionSchema,
  BuildExpeditionInputSchema,
  ClaimTransitionEvaluatedEventSchema,
  CognitiveEventSchema,
  EpistemicJournalEventSchema,
  DESeedQuestionDraftSchema,
  ExecuteExpeditionInputSchema,
  IndependentCandidateReviewAttemptSchema,
  IndependentCandidateReviewExecutionInputSchema,
  OriginateQuestionInputSchema,
  PrincipalResearchCycleInputSchema,
  ProposeCandidateDispositionInputSchema,
  ReviewFindingRecordedEventSchema,
  ReviewFindingRecordingSchema,
  ResearchProgramIdSchema,
  StructuredRoleExecutionInputSchema,
  StructuredRoleExecutionResultSchema,
  type AcceptedClaimTransition,
  type AcceptedClaimTransitionPayload,
  type BuildExpeditionInput,
  type ArtifactIndexRootPayload,
  type ArtifactIndexUpdateProposal,
  type ClaimTransitionDecisionRecord,
  type ClaimTransitionEvaluatedEvent,
  type CognitiveEvent,
  type CognitiveEventScope,
  type CorpusGenesisBuildInput,
  type CorpusGenesisRoots,
  type CorpusRootMutationBatchRecording,
  type CorpusRootMutationRecording,
  type CorpusRootUpdateProposal,
  type CovenantRevisionProposal,
  type DECommittedCandidateReviewInput,
  type DECommittedCandidateReviewReceipt,
  type DEVerticalGateInput,
  type DEVerticalGateResearchPort,
  type DEVerticalGateResearchReceipt,
  type EpistemicRootUpdateProposal,
  type EpistemicJournalEvent,
  type ExecuteExpeditionInput,
  type OriginateQuestionInput,
  type ProposeCandidateDispositionInput,
  type ProgramControlNotice,
  type PrincipalDecision,
  type PrincipalDecisionRecording,
  type PrincipalResearchCycleInput,
  type IndependentCandidateReviewAttempt,
  type IndependentCandidateReviewExecutionInput,
  type IndependentCandidateReviewExecutionPort,
  type ResearchCovenantPayload,
  type ResearchGenesisBuildInput,
  type ResearchGenesisRoots,
  type ResearchGenesisSeedQuestionInput,
  type ProgramRootUpdateProposal,
  type ProgramRootPayload,
  type QuestionMutationProposal,
  type QuestionRootUpdateProposal,
  type QuestionRootPayload,
  type ReviewQualification,
  type ReviewFindingRecordedEvent,
  type ReviewFindingRecording,
  type RelationshipMutationResult,
  type RelationshipRootUpdateProposal,
  type RelationshipRootPayload,
  type ResearchProgramDirectionProposal,
  type ResearchProgramId,
  type ResearchProgramMutationResult,
  type ResearchProgramState,
  type RuntimeReceipt,
  type StructuredRoleExecutionInput,
  type StructuredRoleExecutionPort,
  type StructuredRoleExecutionResult,
  type LegacyImportCandidateProposalBundle,
  type PublishStagedImportInput,
  type LegacyImportCandidateReceipt,
} from '@cosmo/contracts';

import type {
  HeritageGenesisBuildInput,
  HeritageGenesisRoots,
} from '@cosmo/repository';

interface ClaimTransitionRecordPort {
  loadRecord(input: {
    claimTransitionDecisionId: ObjectId;
    recordRef: ObjectRef;
    authorization?: MutationAuthorization;
  }): Promise<ClaimTransitionDecisionRecord>;
}

interface CorpusGenesisBuilderPort {
  build(input: CorpusGenesisBuildInput): Promise<CorpusGenesisRoots>;
}

interface ResearchGenesisBuilderPort {
  build(input: ResearchGenesisBuildInput): Promise<ResearchGenesisRoots>;
}
```

The imported DTOs and schemas above are identity exports of their declared owners, not Program E aliases or lookalike schemas. For the D-owned entries, the exact fields, strict unknown-key rejection, authorization requirements, and cross-field refinements are the definitions frozen under Program D's **Program E Integration Surface**. Program E may construct and parse those DTOs, but may not redeclare, `pick`, extend, or weaken them.

Program E produces these stable interfaces for Programs F and G:

```ts
interface CognitionGenesisBuildInput {
  schema: 'cosmo.cognition-genesis-build-input.v1';
  trust: TrustDescriptor;
  activationPolicy: ActivationPolicy['payload'];
  genesisScope: Extract<BrainEventScope, { kind: 'genesis' }>;
  idempotencyKey: Sha256;
  createdAt: string;
  authorization: MutationAuthorization;
}

interface CognitionGenesisRoots {
  schema: 'cosmo.cognition-genesis-roots.v1';
  topologyRootRef: ObjectRef;
  topology: TopologySnapshot;
  activationPolicyRef: ObjectRef;
  activationPolicy: ActivationPolicy;
  activationRootRef: ObjectRef;
  activation: ActivationSnapshot;
  eventIds: EventId[];
  idempotencyKey: Sha256;
  createdAt: string;
}

interface CognitionGenesisBuilder {
  build(input: CognitionGenesisBuildInput): Promise<CognitionGenesisRoots>;
}

export const GENESIS_ACTIVATION_POLICY_V1: Readonly<{
  schema: 'cosmo.activation-policy.v1';
  weightsByMode: ActivationPolicy['payload']['weightsByMode'];
  foregroundMinimum: 0.7;
  availableMinimum: 0.35;
  maximumForeground: 12;
}>;

interface CreateGenesisBrainDraft {
  schema: 'cosmo.create-genesis-brain-draft.v1';
  branchName: string;
  covenant: ResearchCovenantPayload;
  seedQuestions: ResearchGenesisSeedQuestionInput[];
  humanApproval: string;
}

interface CreateGenesisBrainInput {
  schema: 'cosmo.create-genesis-brain-input.v1';
  draft: CreateGenesisBrainDraft;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  createdAt: string;
}

interface GenesisBrainReceipt {
  genesisBrainReceiptId: ObjectId;
  schema: 'cosmo.genesis-brain-receipt.v1';
  targetRef: `refs/heads/${string}`;
  previousHead: null;
  parentCommitIds: [];
  brainCommitId: BrainCommitId;
  genesisLineageId: Sha256;
  corpusSnapshotIds: CorpusSnapshotId[];
  epistemicRootRef: ObjectRef;
  questionRootRef: ObjectRef;
  programRootRef: ObjectRef;
  relationshipRootRef: ObjectRef;
  heritageRootRef: ObjectRef;
  topologyRootRef: ObjectRef;
  activationRootRef: ObjectRef;
  activationPolicyRef: ObjectRef;
  activationPolicyHash: Sha256;
  negativeKnowledgeRootRef: ObjectRef;
  artifactIndexRootRef: ObjectRef;
  covenantPayloadRef: ObjectRef;
  relationshipEventIds: RelationshipEventId[];
  relationshipEventRefs: ObjectRef[];
  seedQuestions: Array<{
    questionId: QuestionId;
    questionRef: ObjectRef;
    originEventId: EventId;
  }>;
  heritageCurationEventId: ObjectId;
  rootDerivation: Extract<RootDerivation, { kind: 'genesis' }>;
  journalEventIds: EventId[];
  journalRange: JournalRange;
  commitAdvanceTransactionId: Sha256;
  refUpdate: RefUpdateReceipt;
  idempotencyKey: Sha256;
  createdAt: string;
}

interface GenesisBrainService {
  create(input: CreateGenesisBrainInput): Promise<GenesisBrainReceipt>;
}

interface CreateGenesisBrainServiceDependencies {
  repository: BrainRepository;
  principalVersion: Sha256;
  kernelVersion: Sha256;
  genesisTrust: TrustDescriptor;
}

declare function createGenesisBrainService(
  dependencies: CreateGenesisBrainServiceDependencies,
): GenesisBrainService;

export type LayerNodeAddress = BrainObjectAddress & {
  rootKind: 'topologyRoot';
};

export type BrainObjectTarget = BrainObjectLink;
export const BrainObjectTargetSchema = BrainObjectLinkSchema;

export type TopologyNodeTarget =
  | {
      scope: 'existing';
      address: LayerNodeAddress;
    }
  | {
      scope: 'local';
      rootKind: 'topologyRoot';
      objectRef: ObjectRef;
    };

export type FormationTraceTarget = ObjectId | LayerNodeAddress;

interface FormationTraceLimits {
  maxNodes: number;
  maxEdges: number;
  maxJournalRecords: number;
}

interface CandidateAdmission {
  candidateObjectRef: ObjectRef;
  candidate: CandidateFinding;
  admittedEventId: EventId;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
}

interface CandidateTopologyRootUpdateProposal {
  schema: 'cosmo.candidate-topology-root-update-proposal.v1';
  expectedBrainCommitId: BrainCommitId;
  previousTopologyRootRef: ObjectRef;
  addedNodeRefs: ObjectRef[];
  addedEdgeRefs: ObjectRef[];
  addedSelfResearchSnapshotRefs: ObjectRef[];
  causalEventIds: EventId[];
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
}

interface ActivationRootUpdateProposal {
  schema: 'cosmo.candidate-activation-root-update-proposal.v1';
  expectedBrainCommitId: BrainCommitId;
  previousActivationRootRef: ObjectRef;
  policyObjectId: ObjectId;
  entries: Array<{
    target: TopologyNodeTarget;
    score: number;
    state: 'foreground' | 'available' | 'dormant';
    factorReceiptObjectId: ObjectId;
  }>;
  causalEventIds: EventId[];
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
}

type CandidateRootMutation =
  | {
      rootKind: 'topologyRoot';
      storedProposalRef: ObjectRef;
      proposal: CandidateTopologyRootUpdateProposal;
    }
  | {
      rootKind: 'epistemicRoot';
      batchRecordingRef: ObjectRef;
      batchRecording: CorpusRootMutationBatchRecording;
      storedProposalRef: ObjectRef;
      recording: CorpusRootMutationRecording;
      proposal: Extract<
        CorpusRootUpdateProposal,
        { rootKind: 'epistemicRoot' }
      >;
    }
  | {
      rootKind: 'negativeKnowledgeRoot';
      batchRecordingRef: ObjectRef;
      batchRecording: CorpusRootMutationBatchRecording;
      storedProposalRef: ObjectRef;
      recording: CorpusRootMutationRecording;
      proposal: Extract<
        CorpusRootUpdateProposal,
        { rootKind: 'negativeKnowledgeRoot' }
      >;
    }
  | {
      rootKind: 'questionRoot';
      storedProposalRef: ObjectRef;
      proposal: QuestionMutationProposal;
    }
  | {
      rootKind: 'activationRoot';
      storedProposalRef: ObjectRef;
      proposal: ActivationRootUpdateProposal;
    };

interface CandidateBranchInputBase {
  parentCommitId: BrainCommitId;
  candidateBranchRef: `refs/heads/candidates/${string}`;
  expectedCandidateHead: null;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  admissions: CandidateAdmission[];
  rootMutations: CandidateRootMutation[];
  idempotencyKey: Sha256;
  requestedAt: string;
  authorization: MutationAuthorization;
  lease: LeaseProof;
}

export type AutonomousResearchCandidateBranchInput =
  CandidateBranchInputBase & {
    schema: 'cosmo.autonomous-research-candidate-branch-input.v1';
    originKind: 'autonomous_research';
    researchReceiptRef: ObjectRef;
    runtimeReceiptRefs: ObjectRef[];
  };

export type HumanInventCandidateBranchInput =
  CandidateBranchInputBase & {
    schema: 'cosmo.human-invent-candidate-branch-input.v1';
    originKind: 'human_invent';
    admittedHumanOperationEventId: EventId;
    inventDraftRef: ObjectRef;
    inventPreviewRef: ObjectRef;
  };

export type SemanticRoleCandidateBranchInput =
  CandidateBranchInputBase & {
    schema: 'cosmo.semantic-role-candidate-branch-input.v1';
    originKind: 'semantic_role';
    semanticRole:
      | 'default_mode_generator'
      | 'consolidation_dream_generator';
    attemptReceiptRef: ObjectRef;
    contextBundleId: ObjectId;
    outputSchemaRef: ObjectRef;
    outputRef: ObjectRef;
  };

export type CandidateBranchInput =
  | AutonomousResearchCandidateBranchInput
  | HumanInventCandidateBranchInput
  | SemanticRoleCandidateBranchInput;

interface CandidateBranchCommitReceiptBase {
  candidateBranchCommitReceiptId: ObjectId;
  parentCommitId: BrainCommitId;
  candidateBranchRef: `refs/heads/candidates/${string}`;
  previousCandidateHead: null;
  candidateBrainCommitId: BrainCommitId;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  admittedEventIds: EventId[];
  candidateObjectRefs: ObjectRef[];
  appliedRootKinds: Array<
    | 'epistemicRoot'
    | 'questionRoot'
    | 'topologyRoot'
    | 'activationRoot'
    | 'negativeKnowledgeRoot'
  >;
  epistemicRootRef: ObjectRef;
  questionRootRef: ObjectRef;
  topologyRootRef: ObjectRef;
  activationRootRef: ObjectRef;
  negativeKnowledgeRootRef: ObjectRef;
  heritageRootRef: ObjectRef;
  journalEventIds: EventId[];
  journalRange: JournalRange;
  commitAdvanceTransactionId: Sha256;
  idempotencyKey: Sha256;
  committedAt: string;
}

export type AutonomousResearchCandidateBranchCommitReceipt =
  CandidateBranchCommitReceiptBase & {
    schema:
      'cosmo.autonomous-research-candidate-branch-commit-receipt.v1';
    originKind: 'autonomous_research';
    researchReceiptRef: ObjectRef;
    runtimeReceiptRefs: ObjectRef[];
  };

export type HumanInventCandidateBranchCommitReceipt =
  CandidateBranchCommitReceiptBase & {
    schema: 'cosmo.human-invent-candidate-branch-commit-receipt.v1';
    originKind: 'human_invent';
    admittedHumanOperationEventId: EventId;
    inventDraftRef: ObjectRef;
    inventPreviewRef: ObjectRef;
  };

export type SemanticRoleCandidateBranchCommitReceipt =
  CandidateBranchCommitReceiptBase & {
    schema: 'cosmo.semantic-role-candidate-branch-commit-receipt.v1';
    originKind: 'semantic_role';
    semanticRole:
      | 'default_mode_generator'
      | 'consolidation_dream_generator';
    attemptReceiptRef: ObjectRef;
    contextBundleId: ObjectId;
    outputSchemaRef: ObjectRef;
    outputRef: ObjectRef;
  };

export type CandidateBranchCommitReceipt =
  | AutonomousResearchCandidateBranchCommitReceipt
  | HumanInventCandidateBranchCommitReceipt
  | SemanticRoleCandidateBranchCommitReceipt;

interface CandidateBranchService {
  commit(input: CandidateBranchInput): Promise<CandidateBranchCommitReceipt>;
}

type ReviewedCognitiveCandidate = CandidateFinding & {
  candidateType:
    | 'hypothesis'
    | 'connection'
    | 'contradiction_proposal'
    | 'activation_proposal'
    | 'negative_knowledge'
    | 'question';
};

interface AcceptReviewedCognitiveCandidateInput {
  schema: 'cosmo.accept-reviewed-cognitive-candidate-input.v1';
  candidateBranchReceiptRef: ObjectRef;
  candidateBranchReceipt: CandidateBranchCommitReceipt;
  committedCandidateReviewReceiptRef: ObjectRef;
  committedCandidateReviewReceipt: DECommittedCandidateReviewReceipt;
  candidateObjectRef: ObjectRef;
  candidate: ReviewedCognitiveCandidate;
  selectedRootMutations: CandidateRootMutation[];
  canonicalRef: `refs/heads/${string}`;
  expectedCanonicalHead: BrainCommitId;
  authorization: MutationAuthorization;
  lease: LeaseProof;
  idempotencyKey: Sha256;
  acceptedAt: string;
}

interface ReviewedCognitiveCandidateAcceptanceReceipt {
  reviewedCognitiveCandidateAcceptanceReceiptId: ObjectId;
  schema: 'cosmo.reviewed-cognitive-candidate-acceptance-receipt.v1';
  candidateObjectRef: ObjectRef;
  candidateBrainCommitId: BrainCommitId;
  committedCandidateReviewReceiptRef: ObjectRef;
  candidateType: ReviewedCognitiveCandidate['candidateType'];
  admittedCandidateEventId: EventId;
  qualifiedReviewEventIds: EventId[];
  reviewFindingRefs: ObjectRef[];
  reviewQualificationRefs: ObjectRef[];
  reviewCompletedEventId: EventId;
  principalDecisionEventId: EventId;
  acceptanceEventId: EventId;
  reviewScope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  desiredStatus:
    | 'candidate'
    | 'contested'
    | 'incubating'
    | 'dormant'
    | 'revived';
  previousCanonicalCommitId: BrainCommitId;
  acceptedCanonicalCommitId: BrainCommitId;
  appliedRootKinds: Array<
    'questionRoot' | 'topologyRoot' | 'activationRoot' | 'negativeKnowledgeRoot'
  >;
  heritageRootRef: ObjectRef;
  journalEventIds: EventId[];
  journalRange: JournalRange;
  commitAdvanceTransactionId: Sha256;
  idempotencyKey: Sha256;
  acceptedAt: string;
}

interface ReviewedCognitiveCandidateService {
  accept(
    input: AcceptReviewedCognitiveCandidateInput,
  ): Promise<ReviewedCognitiveCandidateAcceptanceReceipt>;
}

interface LegacyImportCandidateService {
  commitCandidate(
    input: PublishStagedImportInput,
  ): Promise<LegacyImportCandidateReceipt>;
}

interface MetabolismRequest {
  attemptId: MetabolismAttemptId;
  branchRef: `refs/heads/${string}`;
  expectedParentCommitId: BrainCommitId;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  triggerDecisionObjectId: ObjectId;
  metabolismPolicyObjectId: ObjectId;
  leaseInput: AcquireLeaseInput;
  authorization: MutationAuthorization;
  requestedAt: string;
}

interface LivingBrainService {
  materialize(commitId: BrainCommitId): Promise<LivingBrainView>;
  traceFormation(
    commitId: BrainCommitId,
    target: FormationTraceTarget,
    limits: FormationTraceLimits
  ): Promise<FormationTrace>;
}

interface CompositeRootMaterialization<T> {
  schema: 'cosmo.composite-root-materialization.v1';
  rootKind: MergeableRootKind;
  requestedCommitId: BrainCommitId;
  wrapperRoot: ObjectRef | null;
  layers: Array<{
    layerId: `layer_${string}`;
    sourceCommitId: BrainCommitId;
    sourceRoot: ObjectRef;
    snapshot: T;
  }>;
  reachableObjectIds: ObjectId[];
}

type RootDerivation =
  | {
      kind: 'genesis';
      lineageId: Sha256;
    }
  | {
      kind: 'parent';
      parentCommitId: BrainCommitId;
    };

interface TopologySnapshot {
  schema: 'cosmo.topology-root.v1';
  derivation: RootDerivation;
  nodeRefs: ObjectRef[];
  edgeRefs: ObjectRef[];
  selfResearchSnapshotRefs: ObjectRef[];
  researchReceiptRefs: ObjectRef[];
  runtimeReceiptRefs: ObjectRef[];
  semanticRoleAttemptRefs: ObjectRef[];
  committedCandidateReviewReceiptRefs: ObjectRef[];
  humanInventDraftRefs: ObjectRef[];
  humanInventPreviewRefs: ObjectRef[];
  causalEventIds: EventId[];
}

interface ActivationPolicy {
  policyObjectId: ObjectId;
  payload: {
    schema: 'cosmo.activation-policy.v1';
    weightsByMode: Record<
      'awake_focused' | 'awake_exploratory' | 'default_mode' | 'dream',
      ActivationWeights
    >;
    foregroundMinimum: number;
    availableMinimum: number;
    maximumForeground: number;
    factorImplementationObjectIds: ObjectId[];
  };
}

interface ActivationSnapshot {
  schema: 'cosmo.activation-root.v1';
  derivation: RootDerivation;
  policyObjectId: ObjectId;
  entries: Array<{
    target: TopologyNodeTarget;
    score: number;
    state: 'foreground' | 'available' | 'dormant';
    factorReceiptObjectId: ObjectId;
  }>;
  causalEventIds: EventId[];
}

interface SelfResearchSnapshot {
  schema: 'cosmo.self-research-snapshot.v1';
  basedOnBrainCommitId: BrainCommitId;
  sourceManifestId: ObjectId;
  redactedConfigurationRef: ObjectRef;
  redactedPaths: string[];
  runtimeReceiptIds: ObjectId[];
  programRootRef: ObjectRef;
  observedFaultEventIds: EventId[];
  unavailableEvidence: string[];
  authority: 'observe_and_propose';
  allowedOutputs: ['candidate_finding', 'isolated_patch_artifact'];
  forbiddenMutations: Array<
    | 'source'
    | 'kernel'
    | 'covenant'
    | 'security_policy'
    | 'credential'
    | 'deployment'
    | 'runtime_adapter'
    | 'capability_grant'
    | 'canonical_brain_direct'
  >;
  capturedAt: string;
}

interface LivingBrainSnapshot {
  schema: 'cosmo.living-brain-snapshot.v1';
  commitId: BrainCommitId;
  epistemic: BrainRootMaterialization<EpistemicRootSnapshot>;
  topology: BrainRootMaterialization<TopologySnapshot>;
  activation: BrainRootMaterialization<ActivationSnapshot>;
  question: BrainRootMaterialization<QuestionRootPayload>;
  program: BrainRootMaterialization<ProgramRootPayload>;
  relationship: BrainRootMaterialization<RelationshipRootPayload>;
  negativeKnowledge: BrainRootMaterialization<NegativeKnowledgeRootSnapshot>;
  artifactIndex: BrainRootMaterialization<ArtifactIndexRootPayload>;
  heritage: BrainRootMaterialization<HeritageSnapshot>;
  reachableObjectIds: ObjectId[];
}

interface LivingBrainView {
  schema: 'cosmo.living-brain-view.v1';
  snapshot: LivingBrainSnapshot;
  epistemic: CompositeRootMaterialization<EpistemicRootSnapshot>;
  topology: CompositeRootMaterialization<TopologySnapshot>;
  nodeIndexEntries: Array<{
    address: LayerNodeAddress;
    node: CognitionNode;
  }>;
  edgeIndexEntries: Array<{
    address: BrainObjectAddress;
    edge: CognitionEdge;
  }>;
}

declare const topologyRootCodec: BrainRootCodec<TopologySnapshot>;
declare const activationRootCodec: BrainRootCodec<ActivationSnapshot>;
declare const cosmoMechanicalCrossRootValidator: BrainCrossRootValidator;

interface ActivationService {
  computeTransient(input: ActivationInput): Promise<ActivationView>;
  proposeDurable(input: DurableActivationInput): Promise<CandidateFinding>;
}

interface MetabolismRunner {
  run(input: MetabolismRequest): Promise<MetabolismReceipt>;
  resume(attemptId: MetabolismAttemptId): Promise<MetabolismReceipt>;
}

interface CognitiveLifecycleEngine {
  acceptSemanticRootMutation(
    input: AcceptSemanticRootMutationInput
  ): Promise<SemanticRootMutationAcceptanceReceipt>;
  acceptProgramMutation(
    input: AcceptProgramMutationInput
  ): Promise<ProgramMutationAcceptanceReceipt>;
  acceptCandidateAgendaProposal(
    input: AcceptCandidateAgendaProposalInput
  ): Promise<CandidateAgendaAcceptanceReceipt>;
  initialize(
    input: InitializeCognitiveLifecycleInput
  ): Promise<CognitiveLifecycleInitializationResult>;
  reconcileProgramControl(input: {
    programId: ResearchProgramId;
    programStateObjectId: ObjectId;
    controlEpoch: number;
    hostControlDeliveryId: string;
    observedAt: string;
  }): Promise<CognitiveLifecycleDecision>;
  wakeDue(input: {
    programId: ResearchProgramId;
    hostWakeId: string;
    observedAt: string;
  }): Promise<CognitiveLifecycleWakeReceipt>;
  inspect(programId: ResearchProgramId): Promise<CognitiveLifecycleState>;
}

type SemanticRootMutationSource =
  | {
      rootKind: 'epistemicRoot';
      storedMutationRef: ObjectRef;
      mutation: CorpusRootMutationRecording;
      update: Extract<
        CorpusRootUpdateProposal,
        { rootKind: 'epistemicRoot' }
      >;
    }
  | {
      rootKind: 'negativeKnowledgeRoot';
      storedMutationRef: ObjectRef;
      mutation: CorpusRootMutationRecording;
      update: Extract<
        CorpusRootUpdateProposal,
        { rootKind: 'negativeKnowledgeRoot' }
      >;
    }
  | {
      rootKind: 'questionRoot';
      storedMutationRef: ObjectRef;
      mutation: QuestionMutationProposal;
      update: QuestionRootUpdateProposal;
    }
  | {
      rootKind: 'relationshipRoot';
      sourceKind: 'relationship_event';
      storedMutationRef: ObjectRef;
      mutation: RelationshipMutationResult;
      update: RelationshipRootUpdateProposal;
    }
  | {
      rootKind: 'relationshipRoot';
      sourceKind: 'covenant_revision';
      storedMutationRef: ObjectRef;
      mutation: CovenantRevisionProposal;
      update:
        CovenantRevisionProposal['relationshipMutation']['relationshipRootUpdate'];
    }
  | {
      rootKind: 'programRoot';
      storedMutationRef: ObjectRef;
      mutation: ResearchProgramMutationResult;
      update: ProgramRootUpdateProposal;
    }
  | {
      rootKind: 'artifactIndexRoot';
      storedMutationRef: ObjectRef;
      mutation: ArtifactIndexUpdateProposal;
      update: ArtifactIndexUpdateProposal;
    };

interface AcceptSemanticRootMutationInput {
  schema: 'cosmo.accept-semantic-root-mutation-input.v1';
  source: SemanticRootMutationSource;
  canonicalRef: `refs/heads/${string}`;
  expectedCanonicalHead: BrainCommitId;
  authorization: MutationAuthorization;
  lease: LeaseProof;
  idempotencyKey: Sha256;
  acceptedAt: string;
}

interface SemanticRootMutationAcceptanceReceipt {
  schema: 'cosmo.semantic-root-mutation-acceptance-receipt.v1';
  rootKind:
    | 'epistemicRoot'
    | 'negativeKnowledgeRoot'
    | 'questionRoot'
    | 'relationshipRoot'
    | 'programRoot'
    | 'artifactIndexRoot';
  storedMutationRef: ObjectRef;
  previousBrainCommitId: BrainCommitId;
  acceptedBrainCommitId: BrainCommitId;
  previousRootRef: ObjectRef;
  acceptedRootRef: ObjectRef;
  mutationEventId: EventId;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  journalEventIds: EventId[];
  journalRange: JournalRange;
  commitAdvanceTransactionId: Sha256;
  idempotencyKey: Sha256;
  acceptedAt: string;
}

interface AcceptProgramMutationInput {
  schema: 'cosmo.accept-program-mutation-input.v1';
  mutationResult: ResearchProgramMutationResult;
  mutationReceiptRef: ObjectRef;
  canonicalRef: `refs/heads/${string}`;
  expectedCanonicalHead: BrainCommitId;
  authorization: MutationAuthorization;
  lease: LeaseProof;
  hostControlDeliveryId: string;
  idempotencyKey: Sha256;
  acceptedAt: string;
}

interface ProgramMutationAcceptanceReceipt {
  schema: 'cosmo.program-mutation-acceptance-receipt.v1';
  programId: ResearchProgramId;
  researchProgramMutationReceiptId: ObjectId;
  previousBrainCommitId: BrainCommitId;
  acceptedBrainCommitId: BrainCommitId;
  previousProgramRootRef: ObjectRef;
  acceptedProgramRootRef: ObjectRef;
  programStateObjectId: ObjectId;
  controlEpoch: number;
  hostControlDeliveryId: string;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  journalEventIds: EventId[];
  journalRange: JournalRange;
  commitAdvanceTransactionId: Sha256;
  acceptedAt: string;
}

interface AcceptCandidateAgendaProposalInput {
  schema: 'cosmo.accept-candidate-agenda-proposal-input.v1';
  proposal: ResearchProgramDirectionProposal;
  storedProposalRef: ObjectRef;
  admittedEventId: EventId;
  candidateBranchRef: `refs/heads/candidates/${string}`;
  expectedCandidateHead: BrainCommitId | null;
  authorization: MutationAuthorization;
  lease: LeaseProof;
  idempotencyKey: Sha256;
  acceptedAt: string;
}

interface CandidateAgendaAcceptanceReceipt {
  schema: 'cosmo.candidate-agenda-acceptance-receipt.v1';
  proposalObjectId: ObjectId;
  admittedEventId: EventId;
  parentBrainCommitId: BrainCommitId;
  candidateBranchRef: `refs/heads/candidates/${string}`;
  previousCandidateHead: BrainCommitId | null;
  candidateBrainCommitId: BrainCommitId;
  agendaNodeAddress: BrainObjectAddress;
  topologyRootRef: ObjectRef;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  journalEventIds: EventId[];
  journalRange: JournalRange;
  commitAdvanceTransactionId: Sha256;
  idempotencyKey: Sha256;
  acceptedAt: string;
}

interface QualifiedPromotionCommitInput {
  schema: 'cosmo.qualified-promotion-commit-input.v1';
  candidateBranchReceiptRef: ObjectRef;
  candidateBranchReceipt: CandidateBranchCommitReceipt;
  committedCandidateReviewReceiptRef: ObjectRef;
  committedCandidateReviewReceipt: DECommittedCandidateReviewReceipt;
  candidateObjectRef: ObjectRef;
  candidate: CandidateFinding & { candidateType: 'claim' };
  canonicalRef: `refs/heads/${string}`;
  expectedCanonicalHead: BrainCommitId;
  idempotencyKey: Sha256;
  requestedAt: string;
  authorization: MutationAuthorization;
  lease: LeaseProof;
}

interface QualifiedPromotionCommitReceipt {
  qualifiedPromotionCommitReceiptId: ObjectId;
  schema: 'cosmo.qualified-promotion-commit-receipt.v1';
  candidateBranchCommitReceiptId: ObjectId;
  candidateBranchCommitId: BrainCommitId;
  committedCandidateReviewReceiptRef: ObjectRef;
  previousCanonicalCommitId: BrainCommitId;
  canonicalBrainCommitId: BrainCommitId;
  qualifiedReviewFindingIds: ReviewFindingId[];
  principalDecisionId: ObjectId;
  claimTransitionDecisionId: ObjectId;
  claimTransitionDecisionEventId: EventId;
  claimTransitionRequestedByEventId: EventId;
  selectedCandidateEventId: EventId;
  qualifiedReviewEventIds: EventId[];
  reviewCompletedEventId: EventId;
  principalDecisionEventId: EventId;
  acceptanceEventId: EventId;
  reviewScope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  previousEpistemicRootRef: ObjectRef;
  acceptedEpistemicRootRef: ObjectRef;
  previousTopologyRootRef: ObjectRef;
  acceptedTopologyRootRef: ObjectRef;
  qualifiedReviewFindingRefs: ObjectRef[];
  reviewQualificationRefs: ObjectRef[];
  claimTransitionDecisionRecordRef: ObjectRef;
  epistemicRootUpdateProposalRef: ObjectRef;
  acceptedClaimTransitionRef: ObjectRef;
  heritageRootRef: ObjectRef;
  journalEventIds: EventId[];
  journalRange: JournalRange;
  commitAdvanceTransactionId: Sha256;
  idempotencyKey: Sha256;
  committedAt: string;
}

interface DEVerticalGateMutationContext {
  canonicalRef: `refs/heads/${string}`;
  expectedCanonicalHead: BrainCommitId;
  acquireCanonicalLease(): Promise<LeaseProof>;
}

interface DEVerticalGateReviewContext {
  independentReviewInputs: IndependentCandidateReviewExecutionInput[];
}

interface DEVerticalGateCognitionPort {
  commitCandidateBranch(
    input: CandidateBranchInput
  ): Promise<CandidateBranchCommitReceipt>;
  commitQualifiedPromotion(
    input: QualifiedPromotionCommitInput
  ): Promise<QualifiedPromotionCommitReceipt>;
  metabolize(input: MetabolismRequest): Promise<MetabolismReceipt>;
  traceFormation(
    commitId: BrainCommitId,
    target: FormationTraceTarget
  ): Promise<FormationTrace>;
}

interface DEVerticalGateReceipt {
  schema: 'cosmo.de-vertical-gate-receipt.v1';
  researchReceipt: DEVerticalGateResearchReceipt;
  researchReceiptRef: ObjectRef;
  committedCandidateReviewReceipt: DECommittedCandidateReviewReceipt;
  committedCandidateReviewReceiptRef: ObjectRef;
  runtimeAdapter: DEVerticalGateInput['runtimeAdapter'];
  candidateBranchCommitId: BrainCommitId;
  qualifiedReviewFindingIds: ReviewFindingId[];
  claimTransitionDecisionId: ObjectId;
  claimTransitionDecisionEventId: EventId;
  claimTransitionRequestedByEventId: EventId;
  admittedCandidateEventId: EventId;
  qualifiedReviewEventIds: EventId[];
  reviewCompletedEventId: EventId;
  principalDecisionEventId: EventId;
  canonicalBrainCommitId: BrainCommitId;
  principalPromotionAction: 'propose_claim_transition';
  metabolismReceipt: MetabolismReceipt;
  wakeBrainCommitId: BrainCommitId;
  formationTrace: FormationTrace;
  canonicalMetabolismChildren: 1;
  cosmoAccepted: true;
  blockedOn: null;
}
```

`FormationTraceLimitsSchema` requires positive integers capped at `10_000`
nodes, `20_000` edges, and `50_000` journal records.
`CandidateBranchInputSchema` is the strict `originKind` discriminated union of
`AutonomousResearchCandidateBranchInputSchema`,
`HumanInventCandidateBranchInputSchema`, and
`SemanticRoleCandidateBranchInputSchema`. All three require an absent candidate
ref and literal
`expectedCandidateHead: null`, a lease for that exact ref, unique sorted
admissions, and at most one stored proposal for each closed candidate-mutable
root kind: C Epistemic/Negative Knowledge, D Question, and E
Topology/Activation. The autonomous variant requires the exact stored D
research receipt and its complete runtime-receipt ref set and forbids Invent
fields. The human variant requires the already-admitted human-operation event,
stored Invent draft, and consumed preview refs and forbids D research/runtime
receipt fields. The semantic-role variant requires the exact default-mode or
dream role, real D RuntimeReceipt ref, ContextBundle identity, output-schema
ref, and output ref and forbids both research-phase and Invent fields. The
caller never
supplies a `BrainCommitPayload`, root replacement, corpus-snapshot list,
Heritage root, journal range, Principal/kernel version, schema version, or raw
root replacement. Program/Relationship/Artifact Index roots are never
candidate-mutable.
The output mirrors this exactly through
`AutonomousResearchCandidateBranchCommitReceiptSchema`,
`HumanInventCandidateBranchCommitReceiptSchema`,
`SemanticRoleCandidateBranchCommitReceiptSchema`, and their strict
`CandidateBranchCommitReceiptSchema` union, also discriminated by
`originKind`. No nullable catch-all provenance fields exist.
Candidate creation is one E transaction against the absent ref; neither Program
F nor any other caller pre-forks it through Program B. `MetabolismRequestSchema`
requires a live head equal to `expectedParentCommitId`, exact trigger/policy
object IDs, and `leaseInput.resource === "metabolism:" + branchRef`.

## Task 1: Freeze Program E contracts and scaffold `@cosmo/cognition`

**Files:**
- Create: `packages/contracts/src/cognition.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/cognition.test.ts`
- Create: `packages/contracts/test/support/cognition-fixtures.ts`
- Create: `packages/cognition/package.json`
- Create: `packages/cognition/tsconfig.json`
- Create: `packages/cognition/src/brain-root-codecs.ts`
- Create: `packages/cognition/src/index.ts`
- Create: `packages/cognition/test/helpers/fixtures.ts`
- Test: `packages/cognition/test/brain-root-codecs.test.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Program A ID schemas; Program B root registry, explicit commit
  event closure, `BrainCommitId`, `ObjectRef`, `JournalRange`,
  `HeritageSnapshot`, and `HeritageGenesisBuilder`; Program C
  `EpistemicRootSnapshot`, `NegativeKnowledgeRootSnapshot`, and
  `CorpusGenesisBuilder` plus claim and evidence IDs.
- Consumes: Program D's sole `ResearchProgramIdSchema`,
  `ResearchProgramId`, `ResearchProgramState`,
  `ResearchProgramMutationResult`, `ProgramControlNotice`,
  `CandidateFindingSchema`, `CausalOriginAttestationSchema`,
  `OriginateQuestionInputSchema`, `BuildExpeditionInputSchema`,
  `ExecuteExpeditionInputSchema`, `ProposeCandidateDispositionInputSchema`,
  `ResearchGenesisBuilder`, `DESeedQuestionDraftSchema`,
  `DEVerticalGateResearchPort`, `DEVerticalGateInput`,
  and `DEVerticalGateResearchReceipt` identity exports and their exact inferred
  types from `@cosmo/contracts`; Program E must not redeclare any of them.
- Produces: `GenesisBrainService`, `CognitionGenesisBuilder`,
  `LayerNodeAddressSchema`/`LayerNodeAddress`,
  `FormationTraceTargetSchema`/`FormationTraceTarget`, `CognitionNode`,
  `CognitionEdge`, `LivingBrainSnapshot`, `LivingBrainView`,
  `TopologySnapshot`, `ActivationSnapshot`, `SelfResearchSnapshot`,
  `ActivationInputSchema`/`ActivationInput`,
  `DurableActivationInputSchema`/`DurableActivationInput`,
  `ActivationViewSchema`/`ActivationView`,
  `ActivationFactorsSchema`/`ActivationFactors`,
  `ActivationWeightsSchema`/`ActivationWeights`, `FormationTraceLimits`,
  `AutonomousResearchCandidateBranchInput`,
  `HumanInventCandidateBranchInput`, `SemanticRoleCandidateBranchInput`, their
  strict discriminated `CandidateBranchInput` union, and the corresponding
  origin-specific commit-receipt types,
  `MetabolismRequest`, Program-mutation
  acceptance/reconciliation contracts, `CognitiveLifecycleState`,
  `CognitiveLifecycleInitializationResult`,
  `CognitiveLifecycleInitializationConflict`, `CognitiveLifecycleDecision`,
  `CognitiveLifecycleWakeReceipt`, `MetabolismAttempt`,
  `MetabolismReceipt`, `WakeBriefing`, and `FormationTrace` schemas and types.
  `FormationJournalEventSchema` is the exact closed
  `z.union([CognitiveEventSchema, EpistemicJournalEventSchema,
  CognitionAcceptanceJournalEventSchema,
  PrincipalResearchLifecycleTriggerJournalEventSchema])`; E does not cast C or
  E journal payloads into D `CognitiveEvent`.
  `CognitionAcceptanceJournalEventSchema` is strict: Claim acceptance requires
  the C `AcceptedClaimTransition` ref, reviewed non-Claim acceptance requires
  `acceptedClosureRef:null`, causal parents are unique, and its Program B
  record must agree on event ID/type/payload ref/scope/time.

- [ ] **Step 1: Write schema tests that reject epistemic collapse**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ActivationSnapshotSchema,
  ACTIVATION_FACTOR_NAMES,
  ActivationFactorsSchema,
  ActivationInputSchema,
  ActivationViewSchema,
  ActivationWeightsSchema,
  AcceptReviewedCognitiveCandidateInputSchema,
  AcceptSemanticRootMutationInputSchema,
  AcceptProgramMutationInputSchema,
  AutonomousResearchCandidateBranchInputSchema,
  BrainObjectTargetSchema,
  CandidateBranchInputSchema,
  CreateGenesisBrainDraftSchema,
  CreateGenesisBrainInputSchema,
  CognitionAcceptanceJournalEventSchema,
  CognitionEdgePayloadSchema,
  CognitionEdgeSchema,
  CognitionNodePayloadSchema,
  CognitionNodeSchema,
  DurableActivationInputSchema,
  FormationJournalEventSchema,
  FormationTraceTargetSchema,
  FormationTraceLimitsSchema,
  GenesisBrainReceiptSchema,
  HumanInventCandidateBranchInputSchema,
  InitializeCognitiveLifecycleInputSchema,
  MetabolismAttemptSchema,
  MetabolismRequestSchema,
  PrincipalResearchLifecycleTriggerJournalEventSchema,
  QualifiedPromotionCommitInputSchema,
  RootDerivationSchema,
  SelfResearchSnapshotSchema,
  SemanticRoleCandidateBranchInputSchema,
  TopologySnapshotSchema,
  WritableBrainHeadRefSchema,
} from '../src/cognition.js';
import {
  activationSnapshotFixture,
  acceptProgramMutationInputFixture,
  candidateBranchInputFixture,
  claimTransitionEvaluatedEventFixture,
  cognitionAcceptanceJournalEventFixture,
  createGenesisBrainDraftFixture,
  createGenesisBrainInputFixture,
  deVerticalGateInputFixture,
  humanInventCandidateBranchInputFixture,
  initializeCognitiveLifecycleInputFixture,
  metabolismAttemptFixture,
  metabolismRequestFixture,
  principalResearchLifecycleTriggerEventFixture,
  qualifiedPromotionCommitInputFixture,
  reviewedCognitiveCandidateAcceptanceInputFixture,
  semanticRootMutationInputFixture,
  reviewFindingRecordedEventFixture,
  selfResearchSnapshotFixture,
  semanticRoleCandidateBranchInputFixture,
  topologySnapshotFixture,
} from './support/cognition-fixtures.js';
import {
  BuildExpeditionInputSchema as PublicBuildExpeditionInputSchema,
  ClaimTransitionEvaluatedEventSchema as PublicClaimTransitionEventSchema,
  DECommittedCandidateReviewInputSchema as PublicCommittedReviewInputSchema,
  DECommittedCandidateReviewReceiptSchema as PublicCommittedReviewReceiptSchema,
  DESeedQuestionDraftSchema as PublicDESeedQuestionDraftSchema,
  ExecuteExpeditionInputSchema as PublicExecuteExpeditionInputSchema,
  DEVerticalGateResearchReceiptSchema as PublicDEGateReceiptSchema,
  IndependentCandidateReviewAttemptSchema as PublicIndependentReviewAttemptSchema,
  IndependentCandidateReviewExecutionInputSchema as PublicIndependentReviewInputSchema,
  OriginateQuestionInputSchema as PublicOriginateQuestionInputSchema,
  PrincipalResearchCycleInputSchema as PublicPrincipalCycleInputSchema,
  ProposeCandidateDispositionInputSchema as PublicProposeCandidateDispositionInputSchema,
  ReviewFindingRecordedEventSchema as PublicReviewFindingEventSchema,
  ReviewFindingRecordingSchema as PublicReviewFindingRecordingSchema,
  ResearchProgramIdSchema as PublicResearchProgramIdSchema,
  StructuredRoleExecutionInputSchema as PublicStructuredRoleInputSchema,
  StructuredRoleExecutionResultSchema as PublicStructuredRoleResultSchema,
  BrainObjectLinkSchema as PublicBrainObjectLinkSchema,
  type BrainObjectLink as PublicBrainObjectLink,
  type DEVerticalGateInput as PublicDEGateInput,
  type DEVerticalGateResearchPort as PublicDEGateResearchPort,
  type DEVerticalGateResearchReceipt as PublicDEGateResearchReceipt,
  type DECommittedCandidateReviewInput as PublicCommittedReviewInput,
  type DECommittedCandidateReviewReceipt as PublicCommittedReviewReceipt,
  type IndependentCandidateReviewAttempt as PublicIndependentReviewAttempt,
  type IndependentCandidateReviewExecutionInput as PublicIndependentReviewInput,
  type IndependentCandidateReviewExecutionPort as PublicIndependentReviewPort,
  type PrincipalResearchCycleInput as PublicPrincipalCycleInput,
  type StructuredRoleExecutionInput as PublicStructuredRoleInput,
  type StructuredRoleExecutionPort as PublicStructuredRolePort,
  type StructuredRoleExecutionResult as PublicStructuredRoleResult,
} from '../src/index.js';
import {
  BrainObjectLinkSchema as RepositoryBrainObjectLinkSchema,
  type BrainObjectLink as RepositoryBrainObjectLink,
} from '../src/repository.js';
import {
  BuildExpeditionInputSchema as ResearchBuildExpeditionInputSchema,
  DECommittedCandidateReviewInputSchema as ResearchCommittedReviewInputSchema,
  DECommittedCandidateReviewReceiptSchema as ResearchCommittedReviewReceiptSchema,
  DESeedQuestionDraftSchema as ResearchDESeedQuestionDraftSchema,
  ExecuteExpeditionInputSchema as ResearchExecuteExpeditionInputSchema,
  DEVerticalGateResearchReceiptSchema as ResearchDEGateReceiptSchema,
  IndependentCandidateReviewAttemptSchema as ResearchIndependentReviewAttemptSchema,
  IndependentCandidateReviewExecutionInputSchema as ResearchIndependentReviewInputSchema,
  OriginateQuestionInputSchema as ResearchOriginateQuestionInputSchema,
  PrincipalResearchCycleInputSchema as ResearchPrincipalCycleInputSchema,
  ProposeCandidateDispositionInputSchema as ResearchProposeCandidateDispositionInputSchema,
  ResearchProgramIdSchema as ResearchResearchProgramIdSchema,
  StructuredRoleExecutionInputSchema as ResearchStructuredRoleInputSchema,
  StructuredRoleExecutionResultSchema as ResearchStructuredRoleResultSchema,
  type DEVerticalGateInput as ResearchDEGateInput,
  type DEVerticalGateResearchPort as ResearchDEGateResearchPort,
  type DEVerticalGateResearchReceipt as ResearchDEGateResearchReceipt,
  type DECommittedCandidateReviewInput as ResearchCommittedReviewInput,
  type DECommittedCandidateReviewReceipt as ResearchCommittedReviewReceipt,
  type IndependentCandidateReviewAttempt as ResearchIndependentReviewAttempt,
  type IndependentCandidateReviewExecutionInput as ResearchIndependentReviewInput,
  type IndependentCandidateReviewExecutionPort as ResearchIndependentReviewPort,
  type PrincipalResearchCycleInput as ResearchPrincipalCycleInput,
  type StructuredRoleExecutionInput as ResearchStructuredRoleInput,
  type StructuredRoleExecutionPort as ResearchStructuredRolePort,
  type StructuredRoleExecutionResult as ResearchStructuredRoleResult,
} from '../src/research.js';
import {
  AcceptedClaimTransitionPayloadSchema as CorpusAcceptedTransitionPayloadSchema,
  AcceptedClaimTransitionSchema as CorpusAcceptedTransitionSchema,
  ClaimTransitionEvaluatedEventSchema as CorpusClaimTransitionEventSchema,
  EpistemicJournalEventSchema as CorpusEpistemicJournalEventSchema,
  ReviewFindingRecordedEventSchema as CorpusReviewFindingEventSchema,
  ReviewFindingRecordingSchema as CorpusReviewFindingRecordingSchema,
} from '../src/corpus.js';

const sha = (character: string) => `sha256:${character.repeat(64)}`;
type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;
type _DEGateInputIdentity = Assert<
  Equal<PublicDEGateInput, ResearchDEGateInput>
>;
type _DEGatePortIdentity = Assert<
  Equal<PublicDEGateResearchPort, ResearchDEGateResearchPort>
>;
type _DEGateReceiptIdentity = Assert<
  Equal<PublicDEGateResearchReceipt, ResearchDEGateResearchReceipt>
>;
type _BrainObjectLinkIdentity = Assert<
  Equal<PublicBrainObjectLink, RepositoryBrainObjectLink>
>;
type _CommittedReviewInputIdentity = Assert<
  Equal<PublicCommittedReviewInput, ResearchCommittedReviewInput>
>;
type _CommittedReviewReceiptIdentity = Assert<
  Equal<PublicCommittedReviewReceipt, ResearchCommittedReviewReceipt>
>;
type _PrincipalCycleInputIdentity = Assert<
  Equal<PublicPrincipalCycleInput, ResearchPrincipalCycleInput>
>;
type _StructuredRoleInputIdentity = Assert<
  Equal<PublicStructuredRoleInput, ResearchStructuredRoleInput>
>;
type _StructuredRoleResultIdentity = Assert<
  Equal<PublicStructuredRoleResult, ResearchStructuredRoleResult>
>;
type _StructuredRolePortIdentity = Assert<
  Equal<PublicStructuredRolePort, ResearchStructuredRolePort>
>;
type _IndependentReviewInputIdentity = Assert<
  Equal<PublicIndependentReviewInput, ResearchIndependentReviewInput>
>;
type _IndependentReviewAttemptIdentity = Assert<
  Equal<PublicIndependentReviewAttempt, ResearchIndependentReviewAttempt>
>;
type _IndependentReviewPortIdentity = Assert<
  Equal<PublicIndependentReviewPort, ResearchIndependentReviewPort>
>;

test('Program E consumes the exact Program D integration schemas by identity', () => {
  assert.equal(
    PublicOriginateQuestionInputSchema,
    ResearchOriginateQuestionInputSchema,
  );
  assert.equal(
    PublicBuildExpeditionInputSchema,
    ResearchBuildExpeditionInputSchema,
  );
  assert.equal(
    PublicExecuteExpeditionInputSchema,
    ResearchExecuteExpeditionInputSchema,
  );
  assert.equal(
    PublicProposeCandidateDispositionInputSchema,
    ResearchProposeCandidateDispositionInputSchema,
  );
  assert.equal(PublicDEGateReceiptSchema, ResearchDEGateReceiptSchema);
  assert.equal(
    PublicCommittedReviewInputSchema,
    ResearchCommittedReviewInputSchema,
  );
  assert.equal(
    PublicCommittedReviewReceiptSchema,
    ResearchCommittedReviewReceiptSchema,
  );
  assert.equal(
    PublicDESeedQuestionDraftSchema,
    ResearchDESeedQuestionDraftSchema,
  );
  assert.equal(
    PublicPrincipalCycleInputSchema,
    ResearchPrincipalCycleInputSchema,
  );
  assert.equal(PublicStructuredRoleInputSchema, ResearchStructuredRoleInputSchema);
  assert.equal(
    PublicStructuredRoleResultSchema,
    ResearchStructuredRoleResultSchema,
  );
  assert.equal(
    PublicIndependentReviewInputSchema,
    ResearchIndependentReviewInputSchema,
  );
  assert.equal(
    PublicIndependentReviewAttemptSchema,
    ResearchIndependentReviewAttemptSchema,
  );
  const vertical = deVerticalGateInputFixture();
  assert.equal('seedQuestion' in vertical, false);
  assert.deepEqual(
    PublicDESeedQuestionDraftSchema.parse(vertical.seedQuestionDraft),
    vertical.seedQuestionDraft,
  );
});

test('Program E consumes C accepted-transition schemas by object identity', () => {
  assert.equal(
    PublicAcceptedTransitionPayloadSchema,
    CorpusAcceptedTransitionPayloadSchema,
  );
  assert.equal(
    PublicAcceptedTransitionSchema,
    CorpusAcceptedTransitionSchema,
  );
  assert.equal(
    PublicReviewFindingRecordingSchema,
    CorpusReviewFindingRecordingSchema,
  );
  assert.equal(
    PublicReviewFindingEventSchema,
    CorpusReviewFindingEventSchema,
  );
  assert.equal(
    PublicClaimTransitionEventSchema,
    CorpusClaimTransitionEventSchema,
  );
});

test('Formation Journal parses exact C epistemic and E lifecycle events', () => {
  for (const event of [
    reviewFindingRecordedEventFixture(),
    claimTransitionEvaluatedEventFixture(),
    cognitionAcceptanceJournalEventFixture(),
    principalResearchLifecycleTriggerEventFixture(),
  ]) {
    assert.deepEqual(FormationJournalEventSchema.parse(event), event);
    if (event.schema === 'cosmo.review-finding-recorded-event.v1'
      || event.schema === 'cosmo.claim-transition-evaluated-event.v1') {
      assert.deepEqual(CorpusEpistemicJournalEventSchema.parse(event), event);
    } else if (event.schema === 'cosmo.cognition-acceptance-journal-event.v1') {
      assert.deepEqual(CognitionAcceptanceJournalEventSchema.parse(event),
        event);
    } else {
      assert.deepEqual(
        PrincipalResearchLifecycleTriggerJournalEventSchema.parse(event),
        event,
      );
    }
  }
});

test('Program E uses Program B BrainObjectLink by schema and type identity', () => {
  assert.equal(PublicBrainObjectLinkSchema, RepositoryBrainObjectLinkSchema);
  assert.equal(BrainObjectTargetSchema, RepositoryBrainObjectLinkSchema);
});

test('ResearchProgramId has one exact lifecycle routing shape', () => {
  assert.equal(
    PublicResearchProgramIdSchema,
    ResearchResearchProgramIdSchema,
  );
  assert.equal(
    PublicResearchProgramIdSchema.parse('program_01J00000000000000000000000'),
    'program_01J00000000000000000000000',
  );
  assert.throws(() => PublicResearchProgramIdSchema.parse('research/program_1'));
});

test('every E mutation target is a writable head, never a tag or settled ref', () => {
  assert.equal(
    WritableBrainHeadRefSchema.parse('refs/heads/cosmo-main'),
    'refs/heads/cosmo-main',
  );
  for (const ref of ['refs/tags/cosmo-main', 'refs/settled/cosmo-main']) {
    assert.equal(WritableBrainHeadRefSchema.safeParse(ref).success, false);
    for (const [schema, input] of [
      [
        AcceptReviewedCognitiveCandidateInputSchema,
        reviewedCognitiveCandidateAcceptanceInputFixture(),
      ],
      [AcceptSemanticRootMutationInputSchema, semanticRootMutationInputFixture()],
      [AcceptProgramMutationInputSchema, acceptProgramMutationInputFixture()],
      [QualifiedPromotionCommitInputSchema, qualifiedPromotionCommitInputFixture()],
    ] as const) {
      assert.equal(schema.safeParse({ ...input, canonicalRef: ref }).success, false);
    }
    assert.equal(InitializeCognitiveLifecycleInputSchema.safeParse({
      ...initializeCognitiveLifecycleInputFixture(),
      branchRef: ref,
    }).success, false);
  }
});

test('public genesis draft is semantic-only and internal input adds only authority', () => {
  const draft = createGenesisBrainDraftFixture();
  assert.equal(CreateGenesisBrainDraftSchema.safeParse(draft).success, true);
  for (const privileged of [
    { targetRef: 'refs/heads/injected' },
    { expectedHead: null },
    { lease: leaseFixture('refs/heads/main') },
    { principalVersion: sha('1') },
    { kernelVersion: sha('2') },
    { genesisTrust: publicTrustFixture() },
    { activationPolicy: {} },
    { activationPolicyHash: sha('3') },
    { rootRefs: [] },
    { model: 'provider-model' },
  ]) {
    assert.equal(CreateGenesisBrainDraftSchema.safeParse({
      ...draft,
      ...privileged,
    }).success, false);
  }
  const internal = createGenesisBrainInputFixture({ draft });
  assert.equal(CreateGenesisBrainInputSchema.safeParse(internal).success, true);
  assert.equal(CreateGenesisBrainInputSchema.safeParse({
    ...internal,
    targetRef: 'refs/heads/injected',
  }).success, false);
});

test('a dream node remains an unverified hypothesis', () => {
  const payload = {
    schema: 'cosmo.cognition-node-payload.v1',
    kind: 'hypothesis',
    subject: {
      scope: 'existing',
      address: brainObjectAddressFixture({
        rootKind: 'epistemicRoot',
        objectId: sha('b'),
      }),
    },
    originEventId: 'evt_dream_1',
    origin: 'dream',
    legacyImportMappingObjectId: null,
    epistemicStatus: 'candidate',
    perspectiveTargets: [],
    createdAt: '2026-07-30T12:00:00.000Z',
  };
  assert.equal(CognitionNodePayloadSchema.safeParse(payload).success, true);
  const result = CognitionNodeSchema.safeParse({
    nodeId: sha('a'),
    payload,
  });
  assert.equal(result.success, true);
  assert.equal(CognitionNodePayloadSchema.safeParse({
    ...payload,
    nodeId: sha('a'),
  }).success, false);
});

test('a dream cannot declare itself supported', () => {
  const result = CognitionNodePayloadSchema.safeParse({
    schema: 'cosmo.cognition-node-payload.v1',
    kind: 'hypothesis',
    subject: {
      scope: 'existing',
      address: brainObjectAddressFixture({
        rootKind: 'epistemicRoot',
        objectId: sha('b'),
      }),
    },
    originEventId: 'evt_dream_1',
    origin: 'dream',
    legacyImportMappingObjectId: null,
    epistemicStatus: 'supported',
    perspectiveTargets: [],
    createdAt: '2026-07-30T12:00:00.000Z',
  });
  assert.equal(result.success, false);
});

test('edge payload endpoints distinguish existing addresses from local refs', () => {
  const payload = {
    schema: 'cosmo.cognition-edge-payload.v1',
    from: {
      scope: 'existing',
      address: topologyNodeAddressFixture('left'),
    },
    to: {
      scope: 'existing',
      address: topologyNodeAddressFixture('right'),
    },
    type: 'derived-from',
    originEventId: 'evt_edge_1',
    evidenceSpanIds: [],
    perspectiveTarget: null,
  };
  assert.equal(CognitionEdgePayloadSchema.safeParse(payload).success, true);
  assert.equal(CognitionEdgeSchema.safeParse({
    edgeId: sha('e'),
    payload,
  }).success, true);
  assert.equal(CognitionEdgePayloadSchema.safeParse({
    ...payload,
    edgeId: sha('e'),
  }).success, false);
  assert.equal(CognitionEdgePayloadSchema.safeParse({
    ...payload,
    from: sha('1'),
  }).success, false);
  assert.equal(CognitionEdgePayloadSchema.safeParse({
    ...payload,
    from: {
      scope: 'local',
      rootKind: 'topologyRoot',
      objectRef: objectRefFixture('new-left-node'),
    },
  }).success, true);
});

test('stored E roots use strict parent or genesis derivation without a child cycle', () => {
  const activation = activationSnapshotFixture();
  assert.equal(ActivationSnapshotSchema.safeParse(activation).success, true);
  assert.equal(RootDerivationSchema.safeParse({
    kind: 'parent',
    parentCommitId: sha('c'),
  }).success, true);
  assert.equal(RootDerivationSchema.safeParse({
    kind: 'genesis',
    lineageId: sha('e'),
  }).success, true);
  assert.equal(RootDerivationSchema.safeParse({
    kind: 'genesis',
    lineageId: sha('e'),
    parentCommitId: sha('c'),
  }).success, false);
  assert.equal(RootDerivationSchema.safeParse({
    kind: 'parent',
    parentCommitId: sha('c'),
    lineageId: sha('e'),
  }).success, false);
  assert.equal(ActivationSnapshotSchema.safeParse({
    ...activation,
    childCommitId: sha('d'),
  }).success, false);
  assert.equal(ActivationSnapshotSchema.safeParse({
    ...activation,
    derivedFromParentCommitId: sha('c'),
  }).success, false);
  assert.equal(TopologySnapshotSchema.safeParse(topologySnapshotFixture()).success, true);
  assert.equal(SelfResearchSnapshotSchema.safeParse(
    selfResearchSnapshotFixture(),
  ).success, true);
});

test('activation DTOs are strict, bounded, and layer-addressable', () => {
  const input = {
    schema: 'cosmo.activation-input.v1',
    brainCommitId: sha('d'),
    questionTargets: [{
      sourceCommitId: sha('d'),
      rootKind: 'topologyRoot',
      rootObjectId: sha('b'),
      objectId: sha('a'),
    }],
    perspectiveTargets: [],
    mode: 'awake_focused',
    maxForeground: 8,
  };
  assert.equal(ActivationInputSchema.safeParse(input).success, true);
  assert.equal(ActivationInputSchema.safeParse({
    ...input,
    capabilityGrantId: sha('f'),
  }).success, false);
  assert.equal(FormationTraceTargetSchema.safeParse(
    input.questionTargets[0],
  ).success, true);
  assert.equal(DurableActivationInputSchema.safeParse({
    schema: 'cosmo.durable-activation-input.v1',
    activation: input,
    origin: 'default_mode',
    rationale: 'Persist a reviewed activation proposal.',
  }).success, true);
  assert.equal(ActivationViewSchema.safeParse({
    schema: 'cosmo.activation-view.v1',
    input,
    policyObjectId: sha('e'),
    entries: [],
    durable: false,
  }).success, true);
  assert.equal(ActivationFactorsSchema.safeParse(
    Object.fromEntries(ACTIVATION_FACTOR_NAMES.map((name) => [name, 0.5])),
  ).success, true);
  assert.equal(ActivationWeightsSchema.safeParse(
    Object.fromEntries(ACTIVATION_FACTOR_NAMES.map((name) => [name, 1 / 11])),
  ).success, true);
});

test('a metabolism attempt pins its parent and high-water mark', () => {
  assert.equal(MetabolismAttemptSchema.safeParse(
    metabolismAttemptFixture(),
  ).success, true);
});

test('formation limits and mutation inputs are bounded and authority-bearing', () => {
  assert.equal(FormationTraceLimitsSchema.safeParse({
    maxNodes: 0,
    maxEdges: 80,
    maxJournalRecords: 120,
  }).success, false);
  const autonomous = candidateBranchInputFixture({
    expectedCandidateHead: null,
    originKind: 'autonomous_research',
  });
  assert.equal(
    AutonomousResearchCandidateBranchInputSchema.safeParse(autonomous).success,
    true,
  );
  assert.equal(CandidateBranchInputSchema.safeParse(autonomous).success, true);
  const humanInvent = humanInventCandidateBranchInputFixture({
    expectedCandidateHead: null,
  });
  assert.equal(
    HumanInventCandidateBranchInputSchema.safeParse(humanInvent).success,
    true,
  );
  assert.equal(CandidateBranchInputSchema.safeParse(humanInvent).success, true);
  const semanticRole = semanticRoleCandidateBranchInputFixture({
    expectedCandidateHead: null,
    originKind: 'semantic_role',
  });
  assert.equal(
    SemanticRoleCandidateBranchInputSchema.safeParse(semanticRole).success,
    true,
  );
  assert.equal(CandidateBranchInputSchema.safeParse(semanticRole).success, true);
  assert.equal(CandidateBranchInputSchema.safeParse({
    ...humanInvent,
    researchReceiptRef: objectRefFixture('fabricated-research'),
    runtimeReceiptRefs: [],
  }).success, false);
  assert.equal(CandidateBranchInputSchema.safeParse({
    ...semanticRole,
    researchReceiptRef: objectRefFixture('fabricated-research'),
    admittedHumanOperationEventId: 'evt_fabricated_human',
  }).success, false);
  assert.equal(CandidateBranchInputSchema.safeParse({
    ...autonomous,
    admittedHumanOperationEventId: 'evt_fabricated_human',
    inventDraftRef: objectRefFixture('invent-draft'),
    inventPreviewRef: objectRefFixture('invent-preview'),
  }).success, false);
  assert.equal(CandidateBranchInputSchema.safeParse(
    {
      ...autonomous,
      expectedCandidateHead: sha('1'),
    },
  ).success, false);
  assert.equal(CandidateBranchInputSchema.safeParse(
    {
      ...autonomous,
      payload: brainCommitPayloadFixture(),
    },
  ).success, false);
  for (const smuggled of [
    { programRoot: objectRefFixture('smuggled-program') },
    { relationshipRoot: objectRefFixture('smuggled-relationship') },
    { activationRoot: objectRefFixture('smuggled-activation') },
  ]) {
    assert.equal(CandidateBranchInputSchema.safeParse({
      ...autonomous,
      ...smuggled,
    }).success, false);
  }
  assert.equal(MetabolismRequestSchema.safeParse(
    metabolismRequestFixture({
      leaseInput: { resource: 'metabolism:refs/heads/main', ttlMs: 30_000 },
    }),
  ).success, true);
});
```

`packages/contracts/test/support/cognition-fixtures.ts` returns strict,
schema-complete examples of all three `CandidateBranchInput` origin variants
and `MetabolismRequest` objects with real
Program A hash-shaped IDs, stored candidate/proposal refs, an authorization
pair, and a lease or lease input bound to the exact ref. The candidate builder
never accepts or creates a `BrainCommitPayload`. Typed overrides may replace
only declared fields; the builders must not use `as any`, omit authority, or
manufacture a second Program D candidate-finding schema.

Create `packages/cognition/test/brain-root-codecs.test.ts`:

```ts
test('E codecs materialize exact topology/activation closure without child IDs', async () => {
  const fixture = await cognitionRootCodecFixture();
  for (const codec of [topologyRootCodec, activationRootCodec]) {
    const verified = await codec.verifyLeaf(fixture.leafInput(codec.rootKind));
    assert.equal(verified.valid, true);
    assert.deepEqual(
      verified.directReferencedObjectIds,
      fixture.expectedDirectReferences(codec.rootKind),
    );
  }
  await assert.rejects(
    fixture.verifyTopologyWithChildCommitId(),
    { code: 'payload_schema_mismatch' },
  );
});

test('mechanical cross-root validation rejects Corpus and activation drift', async () => {
  const fixture = await cognitionCrossRootFixture();
  assert.equal(
    (await cosmoMechanicalCrossRootValidator.validate(fixture.validInput)).valid,
    true,
  );
  assert.deepEqual(
    (await cosmoMechanicalCrossRootValidator.validate(
      fixture.withCorpusSnapshotMismatch(),
    )).issueCodes,
    ['corpus_snapshot_mismatch'],
  );
  assert.deepEqual(
    (await cosmoMechanicalCrossRootValidator.validate(
      fixture.withMissingActivationTarget(),
    )).issueCodes,
    ['activation_target_missing'],
  );
  assert.equal(
    (await cosmoMechanicalCrossRootValidator.validate(
      fixture.parentlessWithMatchingGenesisDerivation(),
    )).valid,
    true,
  );
  assert.deepEqual(
    (await cosmoMechanicalCrossRootValidator.validate(
      fixture.parentlessWithFabricatedParentDerivation(),
    )).issueCodes,
    ['root_derivation_invalid'],
  );
  assert.deepEqual(
    (await cosmoMechanicalCrossRootValidator.validate(
      fixture.childWithGenesisDerivation(),
    )).issueCodes,
    ['root_derivation_invalid'],
  );
});
```

- [ ] **Step 2: Run the contract test and verify it fails**

Run: `npm exec --workspace @cosmo/contracts -- tsx --test test/cognition.test.ts && npm exec --workspace @cosmo/cognition -- tsx --test test/brain-root-codecs.test.ts`

Expected: FAIL because the Program E schemas/codecs and genesis contracts are
not exported.

- [ ] **Step 3: Implement the public discriminated contracts**

Add exact Zod schemas for:

```ts
const EventIdSchema = z.string()
  .regex(/^evt_[A-Za-z0-9_-]+$/)
  .transform((value) => value as EventId);
const IsoDateTimeSchema = z.string().datetime();
const GenesisBranchNameSchema = z.string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  .refine((value) =>
    value !== '.'
    && value !== '..'
    && value !== 'refs'
    && !value.includes('..'),
  );
const ClaimStatusSchema = z.enum([
  'candidate',
  'supported',
  'contested',
  'disconfirmed',
  'superseded',
  'legacy_unverified',
  'retracted',
]);

export const CreateGenesisBrainDraftSchema = z.object({
  schema: z.literal('cosmo.create-genesis-brain-draft.v1'),
  branchName: GenesisBranchNameSchema,
  covenant: ResearchCovenantPayloadSchema,
  seedQuestions: z.array(ResearchGenesisSeedQuestionInputSchema)
    .min(1)
    .max(100),
  humanApproval: z.string().trim().min(1).max(20_000),
}).strict();

export const CreateGenesisBrainInputSchema = z.object({
  schema: z.literal('cosmo.create-genesis-brain-input.v1'),
  draft: CreateGenesisBrainDraftSchema,
  authorization: MutationAuthorizationSchema,
  idempotencyKey: Sha256Schema,
  createdAt: IsoDateTimeSchema,
}).strict();

export const CognitionNodeKindSchema = z.enum([
  'claim',
  'hypothesis',
  'synthesis',
  'contradiction',
  'question',
  'perspective',
  'concept',
  'model',
  'negative_knowledge',
  'relationship_judgment',
  'self_claim',
]);

export const CognitionEdgeTypeSchema = z.enum([
  'supports',
  'opposes',
  'qualifies',
  'derived-from',
  'explains',
  'causes',
  'correlates-with',
  'analogous-to',
  'contrasts-with',
  'answers',
  'raises',
  'supersedes',
  'failed-because',
  'observed-in',
  'belongs-to-perspective',
  'prompted-by-human',
  'produced-by-expedition',
  'consolidated-from',
]);

export const RootDerivationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('genesis'),
    lineageId: Sha256Schema,
  }).strict(),
  z.object({
    kind: z.literal('parent'),
    parentCommitId: BrainCommitIdSchema,
  }).strict(),
]);

export type RootDerivation = z.infer<typeof RootDerivationSchema>;

export const LayerNodeAddressSchema = BrainObjectAddressSchema.refine(
  (address) => address.rootKind === 'topologyRoot',
  { message: 'Layer node addresses must name topologyRoot' },
);

export type LayerNodeAddress = BrainObjectAddress & {
  rootKind: 'topologyRoot';
};

export const BrainObjectTargetSchema = BrainObjectLinkSchema;
export type BrainObjectTarget = BrainObjectLink;

export const TopologyNodeTargetSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('existing'),
    address: LayerNodeAddressSchema,
  }).strict(),
  z.object({
    scope: z.literal('local'),
    rootKind: z.literal('topologyRoot'),
    objectRef: ObjectRefSchema,
  }).strict(),
]);

const addressKey = (address: BrainObjectAddress): string => [
  address.sourceCommitId,
  address.rootKind,
  address.rootObjectId,
  address.objectId,
].join(':');

const targetKey = (target: BrainObjectTarget): string =>
  target.scope === 'existing'
    ? `existing:${addressKey(target.address)}`
    : `local:${target.rootKind}:${target.objectRef.objectId}`;

const CanonicalBrainObjectTargetListSchema = z.array(BrainObjectTargetSchema)
  .max(1024)
  .superRefine((targets, context) => {
    const keys = targets.map(targetKey);
    if (
      new Set(keys).size !== keys.length
      || keys.some((key, index) => index > 0 && keys[index - 1]! > key)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Addresses must be unique and canonically sorted',
      });
    }
  });

export const CognitionNodePayloadSchema = z.object({
  schema: z.literal('cosmo.cognition-node-payload.v1'),
  kind: CognitionNodeKindSchema,
  subject: BrainObjectTargetSchema,
  originEventId: EventIdSchema,
  origin: CandidateOriginSchema.or(z.literal('legacy_import')),
  legacyImportMappingObjectId: ObjectIdSchema.nullable(),
  epistemicStatus: ClaimStatusSchema,
  perspectiveTargets: CanonicalBrainObjectTargetListSchema,
  createdAt: IsoDateTimeSchema,
}).strict().superRefine((node, context) => {
  if (
    (node.origin === 'legacy_import')
      !== (node.legacyImportMappingObjectId !== null)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['legacyImportMappingObjectId'],
      message: 'Only legacy_import nodes require an explicit import mapping',
    });
  }
  if (
    node.origin === 'legacy_import'
    && node.epistemicStatus !== 'legacy_unverified'
  ) {
    context.addIssue({
      code: 'custom',
      path: ['epistemicStatus'],
      message: 'Legacy imports remain legacy_unverified',
    });
  }
  if (
    node.origin === 'dream'
    && !['candidate', 'contested', 'disconfirmed'].includes(node.epistemicStatus)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['epistemicStatus'],
      message: 'Dream cognition cannot self-promote',
    });
  }
});

export const CognitionNodeSchema = z.object({
  nodeId: ObjectIdSchema,
  payload: CognitionNodePayloadSchema,
}).strict();

export const CognitionEdgePayloadSchema = z.object({
  schema: z.literal('cosmo.cognition-edge-payload.v1'),
  from: TopologyNodeTargetSchema,
  to: TopologyNodeTargetSchema,
  type: CognitionEdgeTypeSchema,
  originEventId: EventIdSchema,
  evidenceSpanIds: z.array(ObjectIdSchema),
  perspectiveTarget: BrainObjectTargetSchema.nullable(),
}).strict();

export const CognitionEdgeSchema = z.object({
  edgeId: ObjectIdSchema,
  payload: CognitionEdgePayloadSchema,
}).strict();

export const FormationTraceTargetSchema = z.union([
  ObjectIdSchema,
  LayerNodeAddressSchema,
]);

export type FormationTraceTarget = ObjectId | LayerNodeAddress;

const formationTargetKey = (target: FormationTraceTarget): string =>
  typeof target === 'string'
    ? `object:${target}`
    : [
        target.sourceCommitId,
        target.rootKind,
        target.rootObjectId,
        target.objectId,
      ].join(':');

const CanonicalFormationTargetListSchema = z.array(FormationTraceTargetSchema)
  .max(256)
  .superRefine((targets, context) => {
    const keys = targets.map(formationTargetKey);
    if (
      new Set(keys).size !== keys.length
      || keys.some((key, index) => index > 0 && keys[index - 1]! > key)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Formation targets must be unique and canonically sorted',
      });
    }
  });

export const ACTIVATION_FACTOR_NAMES = [
  'question',
  'semantic',
  'causal',
  'evidence',
  'contradiction',
  'novelty',
  'meaningfulRecency',
  'humanInterest',
  'perspectiveDiversity',
  'dormantResonance',
  'negativeKnowledge',
] as const;

export const ActivationFactorsSchema = z.object({
  question: z.number().min(0).max(1),
  semantic: z.number().min(0).max(1),
  causal: z.number().min(0).max(1),
  evidence: z.number().min(0).max(1),
  contradiction: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  meaningfulRecency: z.number().min(0).max(1),
  humanInterest: z.number().min(0).max(1),
  perspectiveDiversity: z.number().min(0).max(1),
  dormantResonance: z.number().min(0).max(1),
  negativeKnowledge: z.number().min(0).max(1),
}).strict();

export type ActivationFactors = z.infer<typeof ActivationFactorsSchema>;

export const ActivationWeightsSchema = ActivationFactorsSchema.superRefine(
  (weights, context) => {
    const total = ACTIVATION_FACTOR_NAMES.reduce(
      (sum, name) => sum + weights[name],
      0,
    );
    if (Math.abs(total - 1) > 1e-9) {
      context.addIssue({
        code: 'custom',
        message: 'Activation weights must sum to 1',
      });
    }
  },
);

export type ActivationWeights = z.infer<typeof ActivationWeightsSchema>;

export const ActivationInputSchema = z.object({
  schema: z.literal('cosmo.activation-input.v1'),
  brainCommitId: BrainCommitIdSchema,
  questionTargets: CanonicalFormationTargetListSchema,
  perspectiveTargets: CanonicalFormationTargetListSchema,
  mode: z.enum([
    'awake_focused',
    'awake_exploratory',
    'default_mode',
    'dream',
  ]),
  maxForeground: z.number().int().min(1).max(1024),
}).strict();

export type ActivationInput = z.infer<typeof ActivationInputSchema>;

export const DurableActivationInputSchema = z.object({
  schema: z.literal('cosmo.durable-activation-input.v1'),
  activation: ActivationInputSchema,
  origin: z.enum(['principal', 'default_mode', 'dream']),
  rationale: z.string().min(1).max(4000),
}).strict();

export type DurableActivationInput = z.infer<
  typeof DurableActivationInputSchema
>;

export const ActivationEntrySchema = z.object({
  address: LayerNodeAddressSchema,
  score: z.number().min(0).max(1),
  state: z.enum(['foreground', 'available', 'dormant']),
  factors: ActivationFactorsSchema,
}).strict();

export const ActivationViewSchema = z.object({
  schema: z.literal('cosmo.activation-view.v1'),
  input: ActivationInputSchema,
  policyObjectId: ObjectIdSchema,
  entries: z.array(ActivationEntrySchema).max(100_000),
  durable: z.literal(false),
}).strict();

export type ActivationView = z.infer<typeof ActivationViewSchema>;
```

In `packages/contracts/src/cognition.ts`, import `CandidateFindingSchema`, `CandidateOriginSchema`, and `CausalOriginAttestationSchema` from Program D's research-contract module in the same package; in `@cosmo/cognition`, import their exported types/schemas from `@cosmo/contracts`. Do not copy, extend, or define a second candidate schema. Live nodes use the exact D origin set, including `evidence_gap` and `contradiction`. Historical data uses only `origin: 'legacy_import'` plus a required mapping object and `legacy_unverified`; it never enters the live CandidateFinding path.

Import Program B's sole `BrainRefNameSchema` and define
`WritableBrainHeadRefSchema` as its strict refinement to `refs/heads/*`.
Every E contract that can advance, initialize, reconcile, metabolize, or accept
into a ref uses that inferred writable-head type (with the narrower
`refs/heads/candidates/*` refinement where applicable). Read-only repository
lookups may continue to accept `BrainRefName`. Tags and settled refs are
immutable observations and fail every E mutation schema before lease or object
work begins.

`ActivationInputSchema` and `DurableActivationInputSchema` reject undeclared authority fields. Their target arrays are unique and canonically sorted by bare object ID or the Program B tuple `(sourceCommitId, rootKind, rootObjectId, objectId)` and reject duplicate or ambiguous addresses. `LayerNodeAddressSchema` is an identity-preserving refinement of Program B's sole `BrainObjectAddressSchema` with `rootKind: 'topologyRoot'`; it never invents a layer-only identity. `ActivationWeightsSchema` requires every declared factor exactly once, each weight in `[0, 1]`, and a total of `1` within `1e-9`. `FormationTraceTargetSchema` permits a bare `ObjectId` only after materialization proves exactly one matching `BrainObjectAddress`; merged ambiguity requires the full address.

Add strict lifecycle contracts. Import and re-export `ResearchProgramIdSchema` and `ResearchProgramId` by identity from Program D's `research.ts`; `cognition.ts` never creates a second Zod object:

```ts
export interface InitializeCognitiveLifecycleInput {
  schema: 'cosmo.initialize-cognitive-lifecycle-input.v1';
  programId: ResearchProgramId;
  branchRef: `refs/heads/${string}`;
  programStateObjectId: ObjectId;
  controlEpoch: number;
  acceptedProgramMutationReceiptId: ObjectId;
  initialBrainCommitId: BrainCommitId;
  seedQuestionIds: QuestionId[];
  lifecyclePolicyObjectId: ObjectId;
  authorization: MutationAuthorization;
  initializedAt: string;
}

export interface CognitiveLifecycleState {
  schema: 'cosmo.cognitive-lifecycle-state.v1';
  programId: ResearchProgramId;
  branchRef: `refs/heads/${string}`;
  acceptedBrainCommitId: BrainCommitId;
  programStateObjectId: ObjectId;
  controlEpoch: number;
  lifecycleEpoch: number;
  status:
    | 'awake'
    | 'researching'
    | 'sleep_due'
    | 'sleeping'
    | 'paused'
    | 'cancelled'
    | 'settled';
  nextWakeAt: string | null;
  lastDecisionObjectId: ObjectId | null;
  inFlightActionObjectId: ObjectId | null;
  updatedAt: string;
}

export interface CognitiveLifecycleInitializationResult {
  schema: 'cosmo.cognitive-lifecycle-initialization-result.v1';
  outcome: 'initialized' | 'already_initialized';
  initializationInputObjectId: ObjectId;
  state: CognitiveLifecycleState;
}

export interface CognitiveLifecycleInitializationConflict {
  code: 'cognitive_lifecycle_initialization_conflict';
  programId: ResearchProgramId;
  existingInitializationInputObjectId: ObjectId;
  requestedInitializationInputObjectId: ObjectId;
}

export interface CognitiveLifecycleDecision {
  cognitiveLifecycleDecisionObjectId: ObjectId;
  schema: 'cosmo.cognitive-lifecycle-decision.v1';
  programId: ResearchProgramId;
  branchRef: `refs/heads/${string}`;
  basedOnBrainCommitId: BrainCommitId;
  programStateObjectId: ObjectId;
  controlEpoch: number;
  lifecycleEpoch: number;
  action:
    | 'originate_question'
    | 'launch_expedition'
    | 'review_candidate'
    | 'metabolize'
    | 'creation_converged'
    | 'pause_converged'
    | 'resume_converged'
    | 'cancel_converged'
    | 'settlement_accepted'
    | 'settlement_rejected'
    | 'remain_idle';
  selectedQuestionId: QuestionId | null;
  signalSnapshotObjectId: ObjectId;
  principalDecisionId: ObjectId | null;
  reasonCodes: string[];
  decidedAt: string;
  nextWakeAt: string | null;
}

export interface CognitiveLifecycleWakeReceipt {
  schema: 'cosmo.cognitive-lifecycle-wake-receipt.v1';
  hostWakeId: string;
  programId: ResearchProgramId;
  outcome: 'not_due' | 'acted' | 'recovered' | 'settled';
  startingBrainCommitId: BrainCommitId;
  endingBrainCommitId: BrainCommitId;
  lifecycleDecisionObjectIds: ObjectId[];
  dispatchedActionReceiptObjectIds: ObjectId[];
  recoveredInFlightActionIds: ObjectId[];
  acceptedProgramMutationReceiptIds: ObjectId[];
  nextWakeAt: string | null;
}
```

`LivingBrainSnapshotSchema` requires all nine and only the nine typed commit-root
materializations: C Epistemic and Negative Knowledge; D Question, Program,
Relationship, and Artifact Index; E Topology and Activation; and B Intellectual
Heritage. `heritage` is not an `ObjectRef` shortcut and is not decoded through a
separate curation-only path. Its `BrainRootMaterialization<HeritageSnapshot>`
comes from `repository.roots.materialize({rootKind: 'heritageRoot', ...})`, so
the same registry verification, reachability accounting, authorization, and
cross-root rules apply. The view additionally exposes attributed composite
Epistemic and Topology layers for merged-Brain queries; these are projections
of the exact snapshot materializations, never replacement root identities.

`CognitiveLifecycleDecisionPayloadSchema` is the strict stored schema without `cognitiveLifecycleDecisionObjectId`; the public wrapper attaches the returned object ID. It is a generic lifecycle decision—not a metabolism receipt. Refinements require a transition action to match the exact D transitional status/control epoch, require a qualified Principal decision for either settlement action, require `nextWakeAt: null` for paused/cancelled/accepted settlement, and forbid H-selected questions or schedules. D finalizes Research Program state by the exact decision object ID.

Define strict `AcceptSemanticRootMutationInputSchema`, `SemanticRootMutationAcceptanceReceiptSchema`, `AcceptProgramMutationInputSchema`, `ProgramMutationAcceptanceReceiptSchema`, `AcceptCandidateAgendaProposalInputSchema`, `CandidateAgendaAcceptanceReceiptSchema`, and `ReconcileProgramControlInputSchema` for the frozen surface above. The semantic input is a strict discriminated union and requires the complete stored owner mutation object—not a free-floating root payload. A Program-root proposal is acceptable only as the exact update nested in a verified `ResearchProgramMutationResult`; a raw `ProgramRootUpdateProposal` never creates a Research Program. Covenant acceptance consumes one exact stored D `CovenantRevisionProposal`; its embedded `RelationshipMutationResult`, root update, `previousCovenantPayloadRef`, `covenantPayloadRef`, approval event, proposed event, and `basedOnBrainCommitId` must all agree. E does not accept a second caller-supplied Relationship mutation. The new Relationship root names `covenantPayloadRef` plus its revision event and never an enclosing Brain commit. Artifact acceptance requires the stored D `ArtifactIndexUpdateProposal` and uses the same CAS/idempotency path. A `ResearchProgramDirectionProposal` follows the separate candidate-agenda schema: it may create a candidate cognition/topology commit only and cannot enter `ProgramRoot`, call `ResearchProgramService.create()`, or initialize a lifecycle. The reconciliation input has exactly `{programId, programStateObjectId, controlEpoch, hostControlDeliveryId, observedAt}`; it carries no question, action, status, model, schedule, or authority override.

Every accepted C or D normal mutation carries the exact owner-provided
`eventScope`. E requires it on the input, stored proposal, nested root update,
and selected journal record; it must be one
`BrainLineageEventScope` with `basedOnBrainCommitId ===
expectedCanonicalHead` and `targetRef === canonicalRef`. Program ID, lineage,
and trust domain must agree across all nested values. E cannot rewrite a scope
to make a proposal publishable. Candidate-agenda scope instead targets the
candidate branch and is based on its exact parent.

Each Brain-creating receipt above returns `scope`, exact direct
`journalEventIds`, and `journalRange`. The implementation compares those IDs
to `repository.commits.eventClosure(acceptedBrainCommitId)
.directJournalEventIds`; a cursor bound may contain unrelated events but may
not adopt them. The same exact direct-membership rule applies to candidate
agenda acceptance and, below, metabolism.

Freeze the remaining durable/read contracts in Task 1 rather than leaving their shapes to the stage implementations:

```ts
export type MetabolismAttemptId = `met_${string}`;
export type MetabolismStageName =
  | 'replay'
  | 'consolidate'
  | 'contradictions'
  | 'dream'
  | 'challenge'
  | 'prune'
  | 'validate'
  | 'wake';

export interface MetabolismStageOutput {
  stage: MetabolismStageName;
  inputHash: Sha256;
  outputRef: ObjectRef;
  reused: boolean;
}

export interface MetabolismAttempt {
  schema: 'cosmo.metabolism-attempt.v1';
  attemptId: MetabolismAttemptId;
  branchRef: `refs/heads/${string}`;
  parentCommitId: BrainCommitId;
  journalHighWatermark: JournalCursor;
  replayRange: JournalRange;
  consumedEventIds: EventId[];
  status: 'staging' | 'publishing' | 'completed' | 'rolled_back' | 'conflicted';
  leaseId: `lease_${string}`;
  leaseEpoch: number;
  fencingTokenHash: Sha256;
  triggerDecisionObjectId: ObjectId;
  metabolismPolicyObjectId: ObjectId;
  stageOutputs: MetabolismStageOutput[];
  sourceLayerIds: `layer_${string}`[];
  sourceRootRefs: ObjectRef[];
  preservedUnionWrapperObjectIds: ObjectId[];
  parentHeritageRoot: ObjectRef;
  startedAt: string;
}

export interface SourceLayerMapping {
  sourceLayerId: `layer_${string}`;
  sourceCommitId: BrainCommitId;
  sourceRoot: ObjectRef;
  retainedNodeAddresses: BrainObjectAddress[];
  retainedEdgeAddresses: BrainObjectAddress[];
  consolidationMappingObjectIds: ObjectId[];
}

export interface MetabolismReceipt {
  schema: 'cosmo.metabolism-receipt.v1';
  attemptId: MetabolismAttemptId;
  branchRef: `refs/heads/${string}`;
  parentCommitId: BrainCommitId;
  childCommitId: BrainCommitId;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  journalEventIds: EventId[];
  journalRange: JournalRange;
  status: 'completed';
  stageOutputs: MetabolismStageOutput[];
  reusedStages: MetabolismStageName[];
  consumedEventIds: EventId[];
  sourceLayerMappings: SourceLayerMapping[];
  preservedUnionWrapperObjectIds: ObjectId[];
  childReachableObjectIds: ObjectId[];
  parentHeritageRoot: ObjectRef;
  childHeritageRoot: ObjectRef;
  wakeBriefingObjectRef: ObjectRef;
  commitAdvanceTransactionId: Sha256;
  completedAt: string;
}

export interface ConsolidationMapping {
  canonicalAddress: BrainObjectAddress;
  sourceAddresses: BrainObjectAddress[];
  reversible: true;
  rationale: string;
}

export interface CandidateBranchArchivalProposal {
  schema: 'cosmo.candidate-branch-archival-proposal.v1';
  candidateBranchRef: `refs/heads/candidates/${string}`;
  expectedCandidateHead: BrainCommitId;
  basedOnBrainCommitId: BrainCommitId;
  rationale: string;
  proposedByEventId: EventId;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
}

export interface WakeBriefing {
  schema: 'cosmo.wake-briefing.v1';
  parentCommitId: BrainCommitId;
  childCommitId: BrainCommitId;
  diff: BrainDiff;
  consolidationMappings: ConsolidationMapping[];
  contradictionCandidateIds: ObjectId[];
  dreamQuestionIds: QuestionId[];
  dreamCandidateBranchReceiptRefs: ObjectRef[];
  dreamStructuredRoleReceiptRefs: ObjectRef[];
  dreamReviewAttemptRefs: ObjectRef[];
  dreamReviewFindingRecordingRefs: ObjectRef[];
  dreamQuestionDraftRefs: ObjectRef[];
  retainedDissentIds: ObjectId[];
  failedStageNames: MetabolismStageName[];
  openQuestionIds: QuestionId[];
  candidateBranchArchivalProposals: CandidateBranchArchivalProposal[];
}

export interface FormationTraceLimits {
  maxNodes: number;
  maxEdges: number;
  maxJournalRecords: number;
}

export interface CognitionAcceptanceJournalEvent {
  schema: 'cosmo.cognition-acceptance-journal-event.v1';
  eventId: EventId;
  eventType:
    | 'reviewed_cognitive_candidate_accepted'
    | 'claim_transition_accepted';
  candidateRef: ObjectRef;
  committedCandidateReviewReceiptRef: ObjectRef;
  acceptedClosureRef: ObjectRef | null;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  causalParentEventIds: EventId[];
  occurredAt: string;
}

export interface PrincipalResearchLifecycleTriggerJournalEvent {
  schema: 'cosmo.principal-research-lifecycle-trigger-journal-event.v1';
  eventId: EventId;
  eventType: 'principal_research_lifecycle_triggered';
  triggerRef: ObjectRef;
  programId: ResearchProgramId;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  causalParentEventIds: EventId[];
  occurredAt: string;
}

export type FormationJournalEvent =
  | CognitiveEvent
  | EpistemicJournalEvent
  | CognitionAcceptanceJournalEvent
  | PrincipalResearchLifecycleTriggerJournalEvent;

export interface FormationTrace {
  schema: 'cosmo.formation-trace.v1';
  brainCommitId: BrainCommitId;
  requestedTarget: FormationTraceTarget;
  resolvedTarget: LayerNodeAddress;
  nodes: Array<{
    address: LayerNodeAddress;
    node: CognitionNode;
  }>;
  edges: Array<{
    address: BrainObjectAddress;
    edge: CognitionEdge;
  }>;
  events: Array<{
    eventId: EventId;
    sourceCommitId: BrainCommitId;
    journalCursor: JournalCursor;
    event: FormationJournalEvent;
  }>;
  evidenceSpanIds: ObjectId[];
  candidateEventIds: EventId[];
  reviewFindingIds: ReviewFindingId[];
  principalDecisionIds: ObjectId[];
  researchReceiptRefs: ObjectRef[];
  runtimeReceiptRefs: ObjectRef[];
  semanticRoleAttemptRefs: ObjectRef[];
  committedCandidateReviewReceiptRefs: ObjectRef[];
  humanInventDraftRefs: ObjectRef[];
  humanInventPreviewRefs: ObjectRef[];
  commitIds: BrainCommitId[];
  complete: boolean;
  missing: Array<
    | 'node'
    | 'edge'
    | 'evidence_span'
    | 'candidate_event'
    | 'review_finding'
    | 'principal_decision'
    | 'research_receipt'
    | 'runtime_receipt'
    | 'semantic_role_attempt'
    | 'committed_candidate_review_receipt'
    | 'human_invent_draft'
    | 'human_invent_preview'
    | 'commit'
    | 'journal_bound'
  >;
  inferredEvents: [];
}
```

All arrays that represent identity sets are unique and canonically sorted;
durable topology/activation/consolidation/dream identities use the full Program
B `BrainObjectAddress`. A bare `ObjectId` is accepted only by a read API after
the materialized view proves exactly one match; it is never persisted in a
cross-layer mapping. `stageOutputs` contains at most one entry per stage in
stage-order; reused stages are exactly those whose output says `reused`; replay
range ends at the attempt high-water mark; a completed receipt accounts for
every attempt stage/source layer/wrapper/root and has distinct parent/child
commits. `WakeBriefing` is outside the child's root closure.
`FormationTrace.complete` is true exactly when `missing` is empty and
`inferredEvents` is always the literal empty tuple. A referenced research,
runtime, or committed-review object that cannot be loaded and schema-verified,
or a human-Invent draft/preview ref that cannot be hash/media-type verified
against its admitted human-operation link, adds its exact category to `missing`;
a journal-complete event path does not conceal a broken provenance path.
`nodes` and `edges` are
fully attributed, so Program F never resolves a bare ID heuristically. `events`
contains only actual admitted journal records and is sorted by journal cursor
(with event ID as the deterministic tie-breaker); it is the trace's one
chronological surface. Identity arrays are canonically sorted sets and must not
be presented as a timeline. `requestedTarget` preserves the caller's exact
selector; `resolvedTarget` is always the unique full attributed topology
address. A bare requested ID that resolves zero or multiple times fails instead
of producing a trace.

Define strict stored-payload/public-wrapper schemas for `CognitionNode` and
`CognitionEdge`: `CognitionNodePayloadSchema` and
`CognitionEdgePayloadSchema` omit `nodeId`/`edgeId`; the decoded
`CognitionNodeSchema`/`CognitionEdgeSchema` wrappers attach exactly Program B's
returned object ID plus the parsed payload. Node subjects, perspective
references, edge endpoints, and durable activation targets use the explicit
Program B-owned `BrainObjectLink` (exported here only through the
object-identity alias `BrainObjectTarget`) and E's intentionally narrowed
`TopologyNodeTarget` union. `scope: 'existing'` requires a
full `BrainObjectAddress` to an already-existing commit. `scope: 'local'`
requires an `ObjectRef` plus root kind and resolves only inside the staged root
set for the same candidate child. Materialization attaches the final child
`sourceCommitId` and root object ID externally. No durable topology payload
stores a bare ambiguous object ID, and no payload embeds the not-yet-known child
commit ID or root ID.

Define strict schemas for `TopologySnapshot`, `ActivationPolicy`
payload/wrapper, `ActivationSnapshot`, `SelfResearchSnapshot`,
`LivingBrainSnapshot`, and `LivingBrainView`. Topology/activation roots permit
only the strict `RootDerivationSchema`. `{kind:'parent'}` requires one existing
parent commit ID; `{kind:'genesis'}` requires one lineage ID and contains no
commit field. `TopologySnapshot.researchReceiptRefs`, `runtimeReceiptRefs`,
`semanticRoleAttemptRefs`, `committedCandidateReviewReceiptRefs`,
`humanInventDraftRefs`, and `humanInventPreviewRefs` are exact, unique,
canonically sorted provenance sets.
Autonomous candidate publication appends the stored D research receipt and all
exact runtime receipt refs; human Invent appends the exact stored draft and
consumed-preview refs; canonical acceptance appends the stored committed-review
receipt. Every later Topology rewrite preserves them. The codec resolves D/C
refs under their exact schemas. To preserve the E→F dependency boundary, it
treats F draft/preview payloads as opaque content-addressed refs with exact
media types and requires the admitted human-operation payload to link both;
Program F parses its own stored values before calling E. Strict unknown-key
tests reject `derivedFromParentCommitId`,
`brainCommitId`, `childCommitId`, `enclosingCommitId`, and self IDs in stored
payloads. Root reference arrays are exact sorted descriptor links.

`topologyRootCodec` and `activationRootCodec` implement Program B's frozen leaf codec. Topology verification decodes every node/edge/self-model ref and validates endpoint/subject closure. Activation verification decodes every factor receipt and requires each attributed node to exist in the verified Topology materialization. `cosmoMechanicalCrossRootValidator` requires:

- `BrainCommitPayload.corpusSnapshotIds` exactly equals the materialized C `EpistemicRootSnapshot.corpusSnapshotIds`;
- every Topology node subject resolves either as a local staged-root ref or an
  attributed existing C/D/E object; each edge endpoint resolves independently
  under the same rule, so an authorized explicit edge may connect different
  source layers without collapsing either identity;
- every Question/Program root reference resolves and IDs/epochs match decoded wrappers;
- every Activation target resolves either to one exact existing attributed
  Topology node or one local staged Topology node; and
- for a parentless commit, only the E Topology and Activation roots carry the
  same exact `{kind:'genesis', lineageId}` derivation; D and E genesis journal
  events carry the exact genesis scope, B Heritage proves zero parents plus its
  one created curation event, and C proves its parentless empty Corpus and
  root shapes without pretending to store lineage; for every normal child,
  both E roots have `{kind:'parent', parentCommitId}` equal to one exact
  declared parent; mixed genesis/parent roots, fake/future IDs, and genesis on
  a non-parentless commit fail; and
- all other derived/based-on commit IDs name an existing parent, never the
  candidate child.

Program B invokes this validator on create/advance/verify/import/recovery. `LivingBrain.materialize()` invokes the same validator again before exposing a view.

- [ ] **Step 4: Add the cognition package manifest and deterministic fixture builders**

`packages/cognition/package.json`:

```json
{
  "name": "@cosmo/cognition",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "node ../../scripts/run-tests.mjs test"
  },
  "dependencies": {
    "@cosmo/contracts": "*",
    "@cosmo/corpus": "*",
    "@cosmo/foundation": "*",
    "@cosmo/repository": "*",
    "@cosmo/research": "*",
    "@cosmo/runtime": "*"
  }
}
```

The development workspace always exports source. Only Program H's release builder may rewrite a staged release manifest to `./dist/index.js`; Program E never checks a dist-export manifest into the development tree.

`packages/cognition/test/helpers/fixtures.ts` must export:

```ts
export const sha = (character: string): Sha256 =>
  `sha256:${character.repeat(64)}`;

export async function createCognitionFixture(
  name: string,
): Promise<{
  rootDir: string;
  repository: BrainRepository;
  parentCommit: BrainCommit;
  branchRef: `refs/heads/${string}`;
  cleanup(): Promise<void>;
}>;

export function cognitionNode(
  overrides: {
    nodeId: ObjectId;
    subject: BrainObjectTarget;
    payload?: Partial<Omit<CognitionNodePayload, 'subject'>>;
  },
): CognitionNode;
```

Use `mkdtemp()` beneath `os.tmpdir()` and remove only that exact returned path during cleanup.

- [ ] **Step 5: Register and commit the workspace before dependent tests**

Run:

```bash
npm install
git diff -- package-lock.json
git add packages/cognition/package.json packages/cognition/tsconfig.json package-lock.json
git commit -m "chore(cognition): register workspace"
git diff --exit-code -- packages/cognition/package.json \
  packages/cognition/tsconfig.json package-lock.json
git diff --cached --quiet
```

Expected: npm recognizes `@cosmo/cognition`, the lockfile contains its workspace entry, no unrelated dependency version changes appear, and the manifest/lockfile registration is committed before any test or build that depends on `@cosmo/cognition`. The deliberately untracked or unstaged Program E contracts, source, fixtures, and tests remain available for Step 6.

- [ ] **Step 6: Run the focused contracts and package build**

Run: `npm exec --workspace @cosmo/contracts -- tsx --test test/cognition.test.ts && npm exec --workspace @cosmo/cognition -- tsx --test test/brain-root-codecs.test.ts && npm run build --workspace @cosmo/cognition`

Expected: PASS; TypeScript reports no missing Program E exports, both E root codecs close exactly, and mechanical cross-root mismatches fail.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/cognition.ts packages/contracts/src/index.ts \
  packages/contracts/test/cognition.test.ts \
  packages/contracts/test/support/cognition-fixtures.ts \
  packages/cognition/src/brain-root-codecs.ts packages/cognition/src/index.ts \
  packages/cognition/test/helpers/fixtures.ts \
  packages/cognition/test/brain-root-codecs.test.ts
git commit -m "feat(cognition): define living brain contracts"
```

## Task 1B: Build the Sole Model-Free Genesis Brain Transaction

**Files:**
- Create: `packages/cognition/src/cognition-genesis-builder.ts`
- Create: `packages/cognition/src/genesis-brain-service.ts`
- Create: `packages/cognition/test/genesis-brain-service.test.ts`
- Modify: `packages/cognition/src/index.ts`

**Interfaces:**
- Consumes: Program B `inspectGenesisEligibility()`, repository identity,
  global/target leases, exact event closure, parentless `commitAndAdvance()`,
  `HeritageGenesisBuilder`, and all nine codecs/cross-root validators; Program
  C `CorpusGenesisBuilder`; Program D `ResearchGenesisBuilder`; and the Task 1
  genesis contracts.
- Produces: internal `CognitionGenesisBuilder`, exact public
  `createGenesisBrainService({repository, principalVersion, kernelVersion,
  genesisTrust})`, and `GenesisBrainService.create()`.

- [ ] **Step 1: Write failing composition, scope, recovery, and race tests**

```ts
test('genesis composes owner roots into one parentless absent-ref CAS', async () => {
  const fixture = await genesisBrainFixture();
  const receipt = await fixture.service.create(fixture.input);
  const commit = await fixture.repository.commits.get(receipt.brainCommitId);

  assert.deepEqual(commit.payload.parentCommitIds, []);
  assert.equal(commit.payload.epistemicRoot.objectId,
    fixture.corpusRoots.epistemicRootRef.objectId);
  assert.equal(commit.payload.negativeKnowledgeRoot.objectId,
    fixture.corpusRoots.negativeKnowledgeRootRef.objectId);
  assert.equal(commit.payload.questionRoot.objectId,
    fixture.researchRoots.payload.questionRootRef.objectId);
  assert.equal(commit.payload.programRoot.objectId,
    fixture.researchRoots.payload.programRootRef.objectId);
  assert.equal(commit.payload.relationshipRoot.objectId,
    fixture.researchRoots.payload.relationshipRootRef.objectId);
  assert.equal(commit.payload.artifactIndexRoot.objectId,
    fixture.researchRoots.payload.artifactIndexRootRef.objectId);
  assert.equal(commit.payload.heritageRoot.objectId,
    fixture.heritageRoots.heritageRootRef.objectId);
  assert.equal(commit.payload.topologyRoot.objectId,
    fixture.cognitionRoots.topologyRootRef.objectId);
  assert.equal(commit.payload.activationRoot.objectId,
    fixture.cognitionRoots.activationRootRef.objectId);
  assert.deepEqual(receipt.activationPolicyRef,
    fixture.cognitionRoots.activationPolicyRef);
  assert.equal(receipt.activationPolicyHash,
    fixture.expectedGenesisActivationPolicyHash);
  assert.equal(
    fixture.cognitionRoots.activation.policyObjectId,
    receipt.activationPolicyRef.objectId,
  );
  assert.deepEqual(commit.payload.journalEventIds,
    fixture.expectedGenesisEventIdsInJournalOrder);
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(receipt.brainCommitId))
      .directJournalEventIds,
    fixture.expectedGenesisEventIdsInJournalOrder,
  );
  assert.equal(fixture.commitAdvanceCalls, 1);
  assert.equal(fixture.commitAdvanceInputs[0]!.expectedHead, null);
  assert.equal(fixture.commitAdvanceInputs[0]!.targetRef,
    'refs/heads/main');
  assert.equal(fixture.providerCalls + fixture.runtimeCalls, 0);
});

test('genesis derives privilege, scope, trust, lineage, versions, and owner inputs', async () => {
  const fixture = await genesisBrainFixture();
  const receipt = await fixture.service.create(fixture.input);
  assert.equal(fixture.globalLease.resource,
    `genesis:${fixture.repositoryIdentity}`);
  assert.equal(fixture.targetLease.resource, receipt.targetRef);
  assert.equal(fixture.researchBuildInput.genesisScope.kind, 'genesis');
  assert.deepEqual(
    fixture.researchBuildInput.genesisScope,
    fixture.cognitionBuildInput.genesisScope,
  );
  assert.equal(fixture.researchBuildInput.genesisScope.lineageId,
    receipt.genesisLineageId);
  assert.equal(fixture.researchBuildInput.authorization,
    fixture.input.authorization);
  assert.deepEqual(fixture.researchBuildInput.trust,
    fixture.factoryGenesisTrust);
  assert.deepEqual(fixture.corpusBuildInput.trust,
    fixture.factoryGenesisTrust);
  assert.equal(fixture.commitPayload.principalVersion,
    fixture.factoryPrincipalVersion);
  assert.equal(fixture.commitPayload.kernelVersion,
    fixture.factoryKernelVersion);
  for (const eventId of fixture.expectedGenesisEventIdsInJournalOrder) {
    const event = await fixture.journalRecord(eventId);
    assert.deepEqual(event.brainScope,
      fixture.researchBuildInput.genesisScope);
    assert.deepEqual(event.trust, fixture.factoryGenesisTrust);
  }
  for (const forbidden of [
    'authorization',
    'lease',
    'fencingToken',
    'genesisTrust',
    'principalVersion',
    'kernelVersion',
  ]) {
    assert.equal(forbidden in receipt, false);
  }
});

test('genesis validates each owner-specific initial shape and acyclic closure', async () => {
  const fixture = await genesisBrainFixture();
  const receipt = await fixture.service.create(fixture.input);
  assert.deepEqual(fixture.corpusRoots.corpusSnapshot.payload, {
    schema: 'cosmo.corpus-snapshot.v1',
    parentSnapshotIds: [],
    entries: [],
    createdAt: fixture.input.createdAt,
  });
  assert.deepEqual(fixture.corpusRoots.epistemic.corpusSnapshotIds,
    [fixture.corpusRoots.corpusSnapshot.corpusSnapshotId]);
  assert.deepEqual(fixture.corpusRoots.negativeKnowledge.entries, []);
  assert.equal(fixture.researchRoots.questionRoot.entries.length,
    fixture.input.draft.seedQuestions.length);
  assert.deepEqual(fixture.researchRoots.programRoot.entries, []);
  assert.deepEqual(fixture.researchRoots.artifactIndexRoot.entries, []);
  assert.equal(fixture.researchRoots.relationshipEvents.some(
    (event) => event.kind === 'covenant_set' && event.confirmedByHuman,
  ), true);
  assert.deepEqual(fixture.heritageRoots.heritage.parentHeritageRoots, []);
  assert.deepEqual(fixture.heritageRoots.heritage.curationEventIds,
    [receipt.heritageCurationEventId]);
  assert.deepEqual(fixture.cognitionRoots.topology.derivation,
    receipt.rootDerivation);
  assert.deepEqual(fixture.cognitionRoots.activation.derivation,
    receipt.rootDerivation);
  assert.deepEqual(fixture.cognitionRoots.topology.nodeRefs, []);
  assert.deepEqual(fixture.cognitionRoots.topology.researchReceiptRefs, []);
  assert.deepEqual(fixture.cognitionRoots.topology.runtimeReceiptRefs, []);
  assert.deepEqual(fixture.cognitionRoots.topology.semanticRoleAttemptRefs, []);
  assert.deepEqual(
    fixture.cognitionRoots.topology.committedCandidateReviewReceiptRefs,
    [],
  );
  assert.deepEqual(fixture.cognitionRoots.topology.humanInventDraftRefs, []);
  assert.deepEqual(fixture.cognitionRoots.topology.humanInventPreviewRefs, []);
  assert.deepEqual(fixture.cognitionRoots.activation.entries, []);
  assert.equal(
    await fixture.everyRootClosureExcludes(
      receipt.brainCommitId,
      Object.values(fixture.committedRootRefs),
    ),
    true,
  );
});

test('genesis resumes every crash point and exact retry without a second CAS', async () => {
  for (const crashPoint of [
    'after_intent',
    'after_overall_event',
    'after_corpus_roots',
    'after_research_roots',
    'after_cognition_roots',
    'after_heritage_root',
    'after_commit_before_ref',
    'after_ref_before_receipt',
  ] as const) {
    const fixture = await genesisBrainFixture({ crashPoint });
    await assert.rejects(
      () => fixture.service.create(fixture.input),
      { code: 'fault_injected' },
    );
    await fixture.reopenWithoutFault();
    const recovered = await fixture.service.create(fixture.input);
    const replay = await fixture.service.create(fixture.input);
    assert.deepEqual(replay, recovered);
    assert.equal(fixture.successfulCommitAdvanceCount, 1);
    assert.equal(fixture.duplicateScopedEventCount, 0);
  }
});

test('completed genesis replay resolves its intent before empty-repository eligibility', async () => {
  const fixture = await genesisBrainFixture();
  const first = await fixture.service.create(fixture.input);
  fixture.failIfGenesisEligibilityIsInspectedAgain();
  const replay = await fixture.service.create(fixture.input);
  assert.deepEqual(replay, first);
  assert.equal(fixture.genesisEligibilityInspectionCount, 1);
  assert.equal(fixture.successfulCommitAdvanceCount, 1);
});

test('different-branch concurrent genesis attempts have exactly one clean winner', async () => {
  const fixture = await concurrentGenesisFixture();
  const results = await Promise.allSettled([
    fixture.main.create(fixture.mainInput),
    fixture.other.create(fixture.otherInput),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length,
    1);
  assert.equal(fixture.successfulCommitAdvanceCount, 1);
  assert.equal(fixture.loserScopedEventCount, 0);
  assert.equal(fixture.loserObjectOrIntentCount, 0);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/genesis-brain-service.test.ts`

Expected: FAIL because the internal cognition builder, two-phase genesis
transaction, and factory do not exist.

- [ ] **Step 3: Implement the E-owned Cognition genesis builder**

`CognitionGenesisBuilder` is internal to the E factory. It receives the
factory-pinned activation policy, E-derived normal storage trust, exact genesis
scope, derived sub-key, authorization, and timestamp. It append-before-writes
one E genesis event with that exact scope/trust, stores the activation policy,
an empty Topology root, and an empty Activation root, and returns their exact
refs plus event ID. Both roots carry
`{kind:'genesis', lineageId: scope.lineageId}`. It rejects a parent/future
commit field, nonempty node/edge/activation override, mismatched trust/scope,
or direct commit/ref call. Replay and partial recovery are exact.

The factory-pinned policy is not a fifth dependency. Program E exports/freezes
this exact non-implementation portion:

```ts
export const GENESIS_ACTIVATION_POLICY_V1 = Object.freeze({
  schema: 'cosmo.activation-policy.v1',
  weightsByMode: {
    awake_focused: {
      question: .20, semantic: .15, causal: .10, evidence: .15,
      contradiction: .10, novelty: .05, meaningfulRecency: .10,
      humanInterest: .05, perspectiveDiversity: .04,
      dormantResonance: .03, negativeKnowledge: .03,
    },
    awake_exploratory: {
      question: .10, semantic: .10, causal: .08, evidence: .08,
      contradiction: .10, novelty: .15, meaningfulRecency: .08,
      humanInterest: .08, perspectiveDiversity: .08,
      dormantResonance: .10, negativeKnowledge: .05,
    },
    default_mode: {
      question: .10, semantic: .08, causal: .08, evidence: .05,
      contradiction: .10, novelty: .14, meaningfulRecency: .05,
      humanInterest: .10, perspectiveDiversity: .10,
      dormantResonance: .15, negativeKnowledge: .05,
    },
    dream: {
      question: .08, semantic: .10, causal: .08, evidence: .04,
      contradiction: .12, novelty: .16, meaningfulRecency: .03,
      humanInterest: .08, perspectiveDiversity: .10,
      dormantResonance: .16, negativeKnowledge: .05,
    },
  },
  foregroundMinimum: 0.7,
  availableMinimum: 0.35,
  maximumForeground: 12,
} as const);
```

At factory construction E forms the stored payload by adding
`factorImplementationObjectIds: [kernelVersion]` and computes
`activationPolicyHash = hashCanonical({schema:
'cosmo.genesis-activation-policy-binding.v1', kernelVersion,
policy: storedPayload})`. The stored policy ref, Activation root
`policyObjectId`, receipt `activationPolicyRef`, and receipt hash must agree.
The public draft, Program H, and owner builders cannot override weights,
thresholds, maximum, factor implementation, or binding hash.

- [ ] **Step 4: Implement the globally serialized two-phase genesis service**

`createGenesisBrainService()` exposes exactly four factory arguments:
`repository`, installed `principalVersion`, installed `kernelVersion`, and
owner-approved `genesisTrust`. It instantiates the C, D, and E leaf builders
inside Program E and uses `repository.heritageGenesis`; Program H cannot inject,
reorder, or replace a builder or activation policy. The global lease resource
is built from `repository.repositoryIdentity`; E never derives repository
identity from `rootDir` or another path.

`create()`:

1. parses `CreateGenesisBrainInput`, derives
   `targetRef = refs/heads/<safe single segment>`, hashes the complete input into
   an intent lineage ID, and acquires the repository-wide
   `genesis:<repositoryIdentity>` lease before any inspection/write;
2. resolves the idempotency key and canonical request hash before any empty
   eligibility check: an identical existing intent enters recovery, verifies
   and reconciles its recorded builder phases/commit/ref/receipt, and returns
   the same receipt; reuse with a changed body fails
   `genesis_idempotency_conflict`;
3. only when no intent exists, calls `inspectGenesisEligibility()`, stores one
   append-before-build intent, and derives one exact
   `{kind:'genesis', targetRef, lineageId, trustDomain}` scope from the target,
   intent, and factory trust;
4. appends one overall genesis event pointing only to the intent/seed object,
   never a future root/commit, then invokes C, D, E, and B owner builders with
   deterministic sub-keys; the D input is mechanically
   `{covenant, seedQuestions, humanApproval:{principalId:
   authorization.actorIdentity,content}, genesisScope, trust:genesisTrust,
   authorization,idempotencyKey,createdAt}`;
5. verifies C's parentless empty Corpus shape, D's approved
   Covenant/Relationship + seed Questions + empty Program/Artifact shape, B's
   zero-parent single-created-event Heritage shape, and E's empty roots with
   matching genesis derivation;
6. loads the overall/D/E journal records, requires the exact scope/trust,
   resolves their unique IDs in admitted cursor order, and rejects every
   additional scoped event; C roots and B Heritage do not falsely claim to
   store lineage;
7. acquires the target-ref lease, builds a strict parentless payload with all
   nine refs, the one C snapshot ID, `journalRange` from zero through current
   head, and only the ordered selected IDs, then runs all root/cross-root gates;
8. asks Program B for the one `expectedHead:null` CAS while still holding both
   leases; B's final check permits exactly this intent's selected genesis
   events and rejects any other scoped event rather than repeating the
   pre-build zero-event check; and
9. stores the strict public-safe `GenesisBrainReceipt` and releases leases only
   after its durable write.

The receipt includes `brainCommitId`, exact nine root refs,
the bound `activationPolicyRef`/`activationPolicyHash`,
`covenantPayloadRef`, ordered `relationshipEventIds` and
`relationshipEventRefs`, `seedQuestions[{questionId,questionRef,
originEventId}]`, `heritageCurationEventId`, root derivation, ordered direct
event IDs/range, transaction/ref-update identities, and no grant, trust, lease,
fence, installed version, or model field. A same-body retry recovers by the
intent and is byte-identical even after the CAS has made the repository
nonempty; it never reruns the new-genesis zero check. Changed-body reuse fails.
Any preexisting commit,
ref, scoped semantic event, target race, other genesis intent, unexpected
builder event, or model/runtime call fails closed.

- [ ] **Step 5: Run focused, contract, repository, and owner suites**

Run:

```bash
npm exec --workspace @cosmo/cognition -- tsx --test test/genesis-brain-service.test.ts
npm exec --workspace @cosmo/contracts -- tsx --test test/cognition.test.ts
npm test --workspace @cosmo/repository
npm test --workspace @cosmo/corpus
npm test --workspace @cosmo/research
npm test --workspace @cosmo/cognition
```

Expected: PASS; one model-free genesis transaction creates an exact
parentless nine-root Brain, every crash/retry is exact, and concurrent genesis
has one clean winner.

- [ ] **Step 6: Commit**

```bash
git add packages/cognition/src/cognition-genesis-builder.ts \
  packages/cognition/src/genesis-brain-service.ts \
  packages/cognition/src/index.ts \
  packages/cognition/test/genesis-brain-service.test.ts
git commit -m "feat(cognition): create the sole genesis brain"
```

## Task 2: Materialize a typed Living Brain and bounded formation traces

**Files:**
- Create: `packages/cognition/src/living-brain.ts`
- Create: `packages/cognition/src/union-materializer.ts`
- Create: `packages/cognition/src/topology.ts`
- Create: `packages/cognition/test/living-brain.test.ts`
- Create: `packages/cognition/test/union-materializer.test.ts`
- Create: `packages/cognition/test/topology.test.ts`
- Modify: `packages/cognition/src/index.ts`

**Interfaces:**
- Consumes: `BrainRepository.commits.get()`, `roots.verify()/materialize()`, `cosmoMechanicalCrossRootValidator`, and immutable roots from `BrainCommitPayload`.
- Produces: `UnionMaterializer.materializeRoot()`, `LivingBrainService.materialize()`, and `traceFormation()` from the frozen Program E surface.

- [ ] **Step 1: Write failing graph-accounting tests**

```ts
test('Living Brain materializes every one of the nine commit roots through its typed codec', async () => {
  const fixture = await completeNineRootLivingBrainFixture();
  const view = await new LivingBrain(
    fixture.repository,
    fixture.readAuthorization,
  ).materialize(fixture.commitId);

  assert.deepEqual([...fixture.rootRegistryMaterializeCalls].sort(), [
    'epistemicRoot',
    'questionRoot',
    'topologyRoot',
    'programRoot',
    'relationshipRoot',
    'activationRoot',
    'negativeKnowledgeRoot',
    'heritageRoot',
    'artifactIndexRoot',
  ].sort());
  assert.deepEqual(
    Object.keys(view.snapshot)
      .filter((key) => !['schema', 'commitId', 'reachableObjectIds'].includes(key))
      .sort(),
    [
      'activation',
      'artifactIndex',
      'epistemic',
      'heritage',
      'negativeKnowledge',
      'program',
      'question',
      'relationship',
      'topology',
    ],
  );
  assert.equal(view.snapshot.negativeKnowledge.root.objectId,
    fixture.negativeKnowledgeRoot.objectId);
  assert.equal(view.snapshot.heritage.root.objectId,
    fixture.heritageRoot.objectId);
  assert.equal(fixture.curationShortcutCalls, 0);
});

test('materialize rejects a topology edge with a missing endpoint', async () => {
  const fixture = await createCognitionFixture('missing-endpoint');
  try {
    await seedLivingRoots(fixture, {
      nodes: [cognitionNode({
        nodeId: sha('1'),
        subject: {
          scope: 'existing',
          address: fixture.subjectAddress(sha('2')),
        },
      })],
      edges: [{
        edgeId: sha('3'),
        payload: {
          schema: 'cosmo.cognition-edge-payload.v1',
          from: {
            scope: 'existing',
            address: fixture.topologyNodeAddress(sha('1')),
          },
          to: {
            scope: 'existing',
            address: fixture.topologyNodeAddress(sha('4')),
          },
          type: 'derived-from',
          originEventId: 'evt_edge_1',
          evidenceSpanIds: [],
          perspectiveTarget: null,
        },
      }],
    });
    await assert.rejects(
      () => new LivingBrain(fixture.repository).materialize(
        (await fixture.repository.refs.get(fixture.branchRef))!,
      ),
      { code: 'cognition_topology_invalid' },
    );
  } finally {
    await fixture.cleanup();
  }
});

test('formation trace returns events and reports an incomplete lineage honestly', async () => {
  const fixture = await formationFixture({ omitPrincipalDecision: true });
  try {
    const brain = new LivingBrain(fixture.repository);
    const trace = await brain.traceFormation(
      fixture.commitId,
      fixture.synthesisNodeId,
      { maxNodes: 40, maxEdges: 80, maxJournalRecords: 120 },
    );
    assert.equal(trace.complete, false);
    assert.deepEqual(trace.missing, ['principal_decision']);
    assert.equal(trace.inferredEvents.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

for (const fault of [
  ['omitResearchReceipt', 'research_receipt'],
  ['omitRuntimeReceipt', 'runtime_receipt'],
  ['omitSemanticRoleAttempt', 'semantic_role_attempt'],
  ['omitCommittedReviewReceipt', 'committed_candidate_review_receipt'],
  ['omitHumanInventDraft', 'human_invent_draft'],
  ['omitHumanInventPreview', 'human_invent_preview'],
] as const) {
  test(`formation trace reports unresolved ${fault[1]} provenance`, async () => {
    const fixture = await formationFixture({ [fault[0]]: true });
    const trace = await new LivingBrain(fixture.repository).traceFormation(
      fixture.commitId,
      fixture.synthesisNodeId,
      { maxNodes: 40, maxEdges: 80, maxJournalRecords: 120 },
    );
    assert.equal(trace.complete, false);
    assert.equal(trace.missing.includes(fault[1]), true);
    assert.deepEqual(trace.inferredEvents, []);
  });
}

test('formation trace excludes an interleaved event absent from commit closure', async () => {
  const fixture = await interleavedFormationFixture();
  const trace = await new LivingBrain(fixture.repository).traceFormation(
    fixture.commitId,
    fixture.targetAddress,
    { maxNodes: 40, maxEdges: 80, maxJournalRecords: 120 },
  );
  assert.equal(
    fixture.commit.payload.journalRange.throughInclusive >=
      fixture.unrelatedEventCursor,
    true,
  );
  assert.equal(trace.events.some(
    (event) => event.eventId === fixture.unrelatedOtherBranchEventId,
  ), false);
  assert.deepEqual(
    trace.events.map((event) => event.eventId),
    fixture.expectedReferencedEventIdsInClosureOrder,
  );
});

test('a nested merged Brain is a queryable attributed composite', async () => {
  const fixture = await nestedUnionCognitionFixture();
  const view = await new LivingBrain(
    fixture.repository,
    fixture.readAuthorization,
  ).materialize(fixture.outerUnionCommitId);

  assert.deepEqual(
    view.epistemic.layers.map((layer) => layer.sourceCommitId),
    fixture.expectedSourceCommitIds,
  );
  assert.deepEqual(
    view.nodeIndexEntries.map((entry) => entry.address),
    fixture.expectedBrainObjectAddresses,
  );
  assert.equal(
    view.epistemic.reachableObjectIds.includes(fixture.innerWrapperObjectId),
    true,
  );
  assert.equal(
    view.epistemic.reachableObjectIds.includes(fixture.outerWrapperObjectId),
    true,
  );
});

test('BigMerge preserves an explicit science-to-history edge across layers', async () => {
  const fixture = await bigMergeCrossLayerEdgeFixture();
  const view = await new LivingBrain(
    fixture.repository,
    fixture.readAuthorization,
  ).materialize(fixture.bigMergeCommitId);
  const edge = view.edgeIndexEntries.find(
    (entry) => entry.edge.edgeId === fixture.crossLayerEdgeId,
  )!;
  assert.deepEqual(edge.edge.payload.from, {
    scope: 'existing',
    address: fixture.scienceNodeAddress,
  });
  assert.deepEqual(edge.edge.payload.to, {
    scope: 'existing',
    address: fixture.historyNodeAddress,
  });
  assert.notEqual(
    fixture.scienceNodeAddress.sourceCommitId,
    fixture.historyNodeAddress.sourceCommitId,
  );
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/living-brain.test.ts test/union-materializer.test.ts test/topology.test.ts`

Expected: FAIL because `UnionMaterializer`, `LivingBrain`, and `traceFormation()` do not exist.

- [ ] **Step 3: Implement recursive attributed root materialization**

`UnionMaterializer.materializeRoot<T>()` always calls Program B's typed root registry, even for a single leaf:

```ts
export class UnionMaterializer {
  constructor(
    private readonly repository: BrainRepository,
    private readonly readAuthorization?: MutationAuthorization,
  ) {}

  async materializeRoot<T>(input: {
    requestedCommitId: BrainCommitId;
    rootKind: BrainRootKind;
    root: ObjectRef;
  }): Promise<CompositeRootMaterialization<T>> {
    const materialized = await this.repository.roots.materialize<T>({
      rootKind: input.rootKind,
      sourceCommitId: input.requestedCommitId,
      root: input.root,
      authorization: this.readAuthorization,
    });
    return this.attributeVerifiedRoot(input, materialized);
  }

  attributeVerifiedRoot<T>(
    input: {
      requestedCommitId: BrainCommitId;
      rootKind: BrainRootKind;
      root: ObjectRef;
    },
    materialized: BrainRootMaterialization<T>,
  ): CompositeRootMaterialization<T> {
    return CompositeRootMaterializationSchema.parse({
      schema: 'cosmo.composite-root-materialization.v1',
      rootKind: input.rootKind,
      requestedCommitId: input.requestedCommitId,
      wrapperRoot: materialized.leaves.length > 1 ? input.root : null,
      layers: materialized.leaves.map((leaf) => ({
        layerId: layerIdFor(leaf.sourceCommitId, leaf.root.objectId),
        sourceCommitId: leaf.sourceCommitId,
        sourceRoot: leaf.root,
        snapshot: leaf.snapshot,
      })),
      reachableObjectIds: materialized.reachableObjectIds,
    });
  }
}
```

`layerIdFor()` is only a deterministic local view label. Durable identity remains Program B `BrainObjectAddress {sourceCommitId, rootKind, rootObjectId, objectId}`. Preserve duplicate semantic IDs in different leaves as different addresses, deduplicate only an identical four-field tuple, and reject an unresolved private layer, duplicate address with different bytes, or missing wrapper reachability.

- [ ] **Step 4: Build the immutable composite Living Brain view**

```ts
export class LivingBrain implements LivingBrainService {
  constructor(
    private readonly repository: BrainRepository,
    private readonly readAuthorization?: MutationAuthorization,
  ) {}

  async materialize(commitId: BrainCommitId): Promise<LivingBrainView> {
    const commit = await this.repository.commits.get(commitId);
    const epistemicRoot =
      await this.repository.roots.materialize<EpistemicRootSnapshot>({
      rootKind: 'epistemicRoot',
      root: commit.payload.epistemicRoot,
      sourceCommitId: commitId,
      authorization: this.readAuthorization,
    });
    const topologyRoot = await this.repository.roots.materialize<TopologySnapshot>({
      rootKind: 'topologyRoot',
      root: commit.payload.topologyRoot,
      sourceCommitId: commitId,
      authorization: this.readAuthorization,
    });
    const activation = await this.repository.roots.materialize<ActivationSnapshot>({
      rootKind: 'activationRoot',
      root: commit.payload.activationRoot,
      sourceCommitId: commitId,
      authorization: this.readAuthorization,
    });
    const question = await this.repository.roots.materialize<QuestionRootPayload>({
      rootKind: 'questionRoot',
      root: commit.payload.questionRoot,
      sourceCommitId: commitId,
      authorization: this.readAuthorization,
    });
    const program = await this.repository.roots.materialize<ProgramRootPayload>({
      rootKind: 'programRoot',
      root: commit.payload.programRoot,
      sourceCommitId: commitId,
      authorization: this.readAuthorization,
    });
    const relationship =
      await this.repository.roots.materialize<RelationshipRootPayload>({
        rootKind: 'relationshipRoot',
        root: commit.payload.relationshipRoot,
        sourceCommitId: commitId,
        authorization: this.readAuthorization,
      });
    const negativeKnowledge =
      await this.repository.roots.materialize<NegativeKnowledgeRootSnapshot>({
        rootKind: 'negativeKnowledgeRoot',
        root: commit.payload.negativeKnowledgeRoot,
        sourceCommitId: commitId,
        authorization: this.readAuthorization,
      });
    const artifactIndex =
      await this.repository.roots.materialize<ArtifactIndexRootPayload>({
        rootKind: 'artifactIndexRoot',
        root: commit.payload.artifactIndexRoot,
        sourceCommitId: commitId,
        authorization: this.readAuthorization,
      });
    const heritage = await this.repository.roots.materialize<HeritageSnapshot>({
      rootKind: 'heritageRoot',
      root: commit.payload.heritageRoot,
      sourceCommitId: commitId,
      authorization: this.readAuthorization,
    });
    const unionMaterializer = new UnionMaterializer(
      this.repository,
      this.readAuthorization,
    );
    const epistemic = unionMaterializer.attributeVerifiedRoot(
      {
        requestedCommitId: commitId,
        rootKind: 'epistemicRoot',
        root: commit.payload.epistemicRoot,
      },
      epistemicRoot,
    );
    const topology = unionMaterializer.attributeVerifiedRoot(
      {
        requestedCommitId: commitId,
        rootKind: 'topologyRoot',
        root: commit.payload.topologyRoot,
      },
      topologyRoot,
    );
    await assertCrossRootValidation(cosmoMechanicalCrossRootValidator, {
      commit,
      epistemic: epistemicRoot,
      topology: topologyRoot,
      activation,
      question,
      program,
      relationship,
      negativeKnowledge,
      artifactIndex,
      heritage,
    });
    const { nodeIndex, edgeIndex } = buildAttributedIndexes(epistemic, topology);
    assertCompositeTopologyIntegrity(nodeIndex, edgeIndex);
    return LivingBrainViewSchema.parse({
      schema: 'cosmo.living-brain-view.v1',
      snapshot: livingBrainSnapshotFromMaterializations({
        commit,
        epistemic: epistemicRoot,
        topology: topologyRoot,
        activation,
        question,
        program,
        relationship,
        negativeKnowledge,
        artifactIndex,
        heritage,
      }),
      epistemic,
      topology,
      nodeIndexEntries: sortedNodeIndexEntries(nodeIndex),
      edgeIndexEntries: sortedEdgeIndexEntries(edgeIndex),
    });
  }

  async traceFormation(
    commitId: BrainCommitId,
    target: FormationTraceTarget,
    limits: FormationTraceLimits,
  ): Promise<FormationTrace> {
    const view = await this.materialize(commitId);
    const eventClosure =
      await this.repository.commits.eventClosure(commitId);
    return buildFormationTrace(
      this.repository,
      view,
      target,
      limits,
      eventClosure,
    );
  }
}
```

Reject duplicate node or edge addresses, absent subjects, a leaf snapshot
pinned to the wrong source commit, unknown edge types, unresolved local or
existing endpoints, and journal events outside the source commit's exact
ancestry-derived `CommitEventClosure`. `journalRange` is only a cursor bound:
an interleaved record inside that range is invisible unless its ID is a direct
or inherited member of the closure. Resolve each edge endpoint independently: local refs must close
inside the staged/new root, while existing addresses may identify different
authorized union layers. Preserve both endpoint addresses exactly. A bare
`ObjectId` formation target is allowed only when unique across layers;
otherwise fail `cognition_node_ambiguous` and require the attributed selector.
Materialization never invents a cross-layer edge.

- [ ] **Step 5: Implement causal formation traversal without semantic invention**

Traverse only explicit `derived-from`, `consolidated-from`,
`produced-by-expedition`, `raises`, `answers`, `supports`, and `opposes` edges
plus journal records whose IDs are referenced by nodes and edges and are
members of the pinned commit's `CommitEventClosure`. For each selected record,
load `payloadRef`, parse it with the exact closed
`FormationJournalEventSchema`, and require payload event ID/type/scope/time to
equal the hash-bound Program B record. C `review_recorded` and
`claim_transition_evaluated` payloads remain their C-owned types; E never casts
them to D `CognitiveEvent`. Never scan all records in the commit's cursor
interval. Return:

```ts
{
  schema: 'cosmo.formation-trace.v1',
  brainCommitId,
  requestedTarget: target,
  resolvedTarget,
  nodes,
  edges,
  events,
  evidenceSpanIds,
  candidateEventIds,
  reviewFindingIds,
  principalDecisionIds,
  researchReceiptRefs,
  runtimeReceiptRefs,
  semanticRoleAttemptRefs,
  committedCandidateReviewReceiptRefs,
  humanInventDraftRefs,
  humanInventPreviewRefs,
  commitIds,
  complete,
  missing,
  inferredEvents: [],
}
```

When any link is absent, including an explicit
research/runtime/semantic-role-attempt/committed-review receipt or human-Invent
draft/preview ref,
append its exact category to `missing`; never synthesize a likely event or
recover it by scanning nearby objects. Provenance arrays come only from the
traversed Topology sets and C accepted-transition closure objects, are reloaded
under exact C/D schemas or, for F-owned human refs, verified as opaque
content-addressed values against the admitted event link. They are canonical
identity sets rather than chronology. Each returned node and edge includes its full
address. Each chronological event includes the actual admitted
`CognitiveEvent`, source commit, and journal cursor. Validate ordering against
the pinned commit ranges; do not derive chronology from the canonically sorted
identity sets.

- [ ] **Step 6: Run focused and package tests**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/living-brain.test.ts test/union-materializer.test.ts test/topology.test.ts && npm test --workspace @cosmo/cognition`

Expected: PASS; the missing-endpoint trap fails closed and incomplete formation remains explicit.

- [ ] **Step 7: Commit**

```bash
git add packages/cognition/src/living-brain.ts \
  packages/cognition/src/union-materializer.ts packages/cognition/src/topology.ts \
  packages/cognition/src/index.ts packages/cognition/test/living-brain.test.ts \
  packages/cognition/test/union-materializer.test.ts \
  packages/cognition/test/topology.test.ts
git commit -m "feat(cognition): materialize typed living brain"
```

## Task 3: Add reproducible topology and activation

**Files:**
- Create: `packages/cognition/src/activation.ts`
- Create: `packages/cognition/test/activation.test.ts`
- Modify: `packages/cognition/src/topology.ts`
- Modify: `packages/cognition/src/index.ts`

**Interfaces:**
- Consumes: `LivingBrainView`, typed edges, current question, perspectives, evidence quality, contradictions, negative knowledge, and meaningful-change events.
- Produces: one `ActivationEngine(dependencies: ActivationEngineDependencies)` constructor plus `ActivationService.computeTransient()` and `proposeDurable()`.

```ts
export interface LoadedActivationPolicy {
  policy: ActivationPolicy;
}

export interface ActivationFactorReceiptStore {
  write(input: {
    policyObjectId: ObjectId;
    derivedFromParentCommitId: BrainCommitId;
    entry: ActivationEntry;
  }): Promise<ObjectId>;
}

export interface ActivationEngineDependencies {
  livingBrain: LivingBrainService;
  policy: LoadedActivationPolicy;
  factorReceipts: ActivationFactorReceiptStore;
}
```

The caller loads and schema-verifies the content-addressed policy object before construction. The engine accepts no repository-or-policy overload and never substitutes hidden defaults for that pinned policy.

- [ ] **Step 1: Write failing transient-versus-durable activation tests**

```ts
test('an Ask retrieval activation never mutates the pinned Brain', async () => {
  const fixture = await activationFixture();
  try {
    const before = await authorityRoots(fixture.repository, fixture.branchRef);
    const service = new ActivationEngine({
      livingBrain: new LivingBrain(fixture.repository),
      policy: fixture.activationPolicy,
    });
    const result = await service.computeTransient({
      schema: 'cosmo.activation-input.v1',
      brainCommitId: fixture.commitId,
      questionTargets: [fixture.questionNodeAddress],
      perspectiveTargets: [],
      mode: 'awake_focused',
      maxForeground: 8,
    });
    const after = await authorityRoots(fixture.repository, fixture.branchRef);
    assert.deepEqual(after, before);
    assert.equal(result.durable, false);
    assert.equal(
      result.entries[0]?.address.objectId,
      fixture.supportedClaimNodeAddress.objectId,
    );
  } finally {
    await fixture.cleanup();
  }
});

test('access count alone cannot demote retained cognition', async () => {
  const graph = activationGraph({
    rareNode: { accessCount: 0, contradiction: 1, evidenceQuality: 1 },
    popularNode: { accessCount: 5000, contradiction: 0, evidenceQuality: 0.2 },
  });
  const view = computeActivation(graph, activationContext());
  assert.ok(scoreOf(view, graph.rareNode.nodeId) > scoreOf(view, graph.popularNode.nodeId));
});

test('durable activation is emitted as a candidate and not written directly', async () => {
  const fixture = readOnlyActivationFixture();
  const service = new ActivationEngine({
    livingBrain: fixture.livingBrain,
    policy: fixture.activationPolicy,
  });
  const candidate = await service.proposeDurable(durableActivationInput());
  assert.equal(candidate.candidateType, 'activation_proposal');
  assert.equal(candidate.origin, 'default_mode');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/activation.test.ts`

Expected: FAIL because `ActivationEngine` is not defined.

- [ ] **Step 3: Implement deterministic factor scoring**

Normalize each declared factor to `[0, 1]`, apply a content-addressed `ActivationPolicy`, and preserve the complete factor vector:

```ts
const FOUNDING_WEIGHTS = ActivationWeightsSchema.parse({
  question: 0.19,
  semantic: 0.12,
  causal: 0.12,
  evidence: 0.12,
  contradiction: 0.10,
  novelty: 0.08,
  meaningfulRecency: 0.06,
  humanInterest: 0.08,
  perspectiveDiversity: 0.05,
  dormantResonance: 0.05,
  negativeKnowledge: 0.03,
});

export function activationScore(
  factors: ActivationFactors,
  weights: ActivationWeights,
): number {
  const raw = Object.entries(weights).reduce(
    (sum, [name, weight]) => sum + clamp01(factors[name as keyof ActivationFactors]) * weight,
    0,
  );
  return Math.round(clamp01(raw) * 1_000_000) / 1_000_000;
}
```

`FOUNDING_WEIGHTS` is seed data for one mode inside a stored, content-addressed `ActivationPolicy`; it is never an implicit engine fallback. Do not include query popularity or access count as a scoring factor. Break ties by the exact Program B address tuple so merged-Brain nodes with equal local IDs remain distinct and the same input bytes produce the same view.

- [ ] **Step 4: Implement transient and durable boundaries**

`computeTransient()` returns an unpersisted `ActivationView` with `durable: false`. `proposeDurable()` imports and parses Program D's `CandidateFindingSchema` from `@cosmo/contracts` and returns only a `CandidateFinding(candidateType='activation_proposal')`; Program D admission and Principal/kernel promotion remain required before a later commit changes `activationRoot`.

```ts
export class ActivationEngine implements ActivationService {
  constructor(
    private readonly dependencies: ActivationEngineDependencies,
  ) {}

  async computeTransient(input: ActivationInput): Promise<ActivationView> {
    const parsed = ActivationInputSchema.parse(input);
    const graph = await this.dependencies.livingBrain.materialize(
      parsed.brainCommitId,
    );
    return ActivationViewSchema.parse({
      schema: 'cosmo.activation-view.v1',
      input: parsed,
      policyObjectId: this.dependencies.policy.policy.policyObjectId,
      entries: rankActivation(
        graph,
        parsed,
        this.dependencies.policy.policy.payload.weightsByMode[parsed.mode],
      ),
      durable: false,
    });
  }

  async proposeDurable(input: DurableActivationInput): Promise<CandidateFinding> {
    const parsed = DurableActivationInputSchema.parse(input);
    const view = await this.computeTransient(parsed.activation);
    const entries = await Promise.all(view.entries.map(async (entry) => ({
      address: entry.address,
      score: entry.score,
      factorReceiptObjectId: await this.dependencies.factorReceipts.write({
        policyObjectId: view.policyObjectId,
        derivedFromParentCommitId: view.input.brainCommitId,
        entry,
      }),
    })));
    return CandidateFindingSchema.parse({
      schema: 'cosmo.candidate-finding.v1',
      candidateType: 'activation_proposal',
      origin: parsed.origin,
      content: {
        policyObjectId: view.policyObjectId,
        derivedFromParentCommitId: view.input.brainCommitId,
        entries,
      },
      evidenceSpanIds: [],
      rationale: parsed.rationale,
    });
  }
}
```

- [ ] **Step 5: Run focused and package tests**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/activation.test.ts && npm test --workspace @cosmo/cognition`

Expected: PASS; repeated transient calls produce byte-identical results and unchanged refs.

- [ ] **Step 6: Commit**

```bash
git add packages/cognition/src/activation.ts packages/cognition/src/topology.ts \
  packages/cognition/src/index.ts packages/cognition/test/activation.test.ts
git commit -m "feat(cognition): add reproducible activation"
```

## Task 4: Build the explicit evidence-bound self-model

**Files:**
- Create: `packages/cognition/src/self-model.ts`
- Create: `packages/cognition/test/self-model.test.ts`
- Modify: `packages/cognition/src/index.ts`

**Interfaces:**
- Consumes: exact source commit/content manifest, redacted config objects, runtime/model receipts, current Brain/program IDs, fault events, and EvidenceSpans.
- Produces: `buildSelfResearchSnapshot()` and `validateSelfClaimCandidate()`.

- [ ] **Step 1: Write failing self-knowledge and authority traps**

```ts
test('self snapshot strips secrets and pins every observational input', async () => {
  const result = await buildSelfResearchSnapshot({
    sourceManifestId: sha('1'),
    configuration: {
      provider: 'openai',
      apiKey: 'must-not-survive',
      maxConcurrency: 3,
    },
    secretPaths: ['apiKey'],
    runtimeReceiptIds: [sha('2')],
    basedOnBrainCommitId: sha('3'),
    programRootRef: objectRef('program-root'),
    observedFaultEventIds: ['evt_fault_1'],
    unavailableEvidence: ['host firmware'],
    capturedAt: '2026-07-30T12:00:00.000Z',
  });
  assert.equal(JSON.stringify(result).includes('must-not-survive'), false);
  assert.deepEqual(result.redactedPaths, ['apiKey']);
  assert.equal(result.authority, 'observe_and_propose');
});

test('invented biography is rejected as a self claim', () => {
  assert.throws(
    () => validateSelfClaimCandidate({
      text: 'I remember being born in Menlo Park',
      evidenceSpanIds: [],
      category: 'biography',
      requestedAuthority: 'observe_and_propose',
    }),
    { code: 'self_claim_unsupported' },
  );
});

test('self research cannot widen its own grant', () => {
  assert.throws(
    () => validateSelfClaimCandidate({
      text: 'I should deploy this repair',
      evidenceSpanIds: [sha('5')],
      category: 'capability',
      requestedAuthority: 'modify_runtime',
    }),
    { code: 'self_authority_escalation' },
  );
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/self-model.test.ts`

Expected: FAIL because the self-model functions are absent.

- [ ] **Step 3: Implement observational snapshot construction**

Canonicalize only the allowlisted non-secret configuration fields into `redactedConfigurationRef`. Store secret redaction paths and missing evidence, never secret values. `basedOnBrainCommitId` and `programRootRef` must resolve to the already-existing parent observation point; the snapshot cannot name the child commit that may later reference it. Set:

```ts
authority: 'observe_and_propose';
allowedOutputs: ['candidate_finding', 'isolated_patch_artifact'];
forbiddenMutations: [
  'source',
  'kernel',
  'covenant',
  'security_policy',
  'credential',
  'deployment',
  'runtime_adapter',
  'capability_grant',
  'canonical_brain_direct',
];
```

Require any claim about capability, version, fault, performance, or current state to cite an object in the pinned snapshot and follow Program C evidence policy.

- [ ] **Step 4: Run focused and package tests**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/self-model.test.ts && npm test --workspace @cosmo/cognition`

Expected: PASS; the serialized snapshot contains no secret and both authority traps fail closed.

- [ ] **Step 5: Commit**

```bash
git add packages/cognition/src/self-model.ts packages/cognition/src/index.ts \
  packages/cognition/test/self-model.test.ts
git commit -m "feat(cognition): add evidence bound self model"
```

## Task 5: Restore Awake Autonomy and Own the Durable Cognitive Lifecycle

**Files:**
- Create: `packages/cognition/src/default-mode-loop.ts`
- Create: `packages/cognition/src/default-mode-structured-role-adapter.ts`
- Create: `packages/cognition/src/lifecycle-store.ts`
- Create: `packages/cognition/src/cognitive-lifecycle-engine.ts`
- Create: `packages/cognition/src/program-control.ts`
- Create: `packages/cognition/src/metabolism-trigger.ts`
- Create: `packages/cognition/test/default-mode-loop.test.ts`
- Create: `packages/cognition/test/default-mode-structured-role-adapter.test.ts`
- Create: `packages/cognition/test/cognitive-lifecycle-engine.test.ts`
- Create: `packages/cognition/test/program-control.test.ts`
- Create: `packages/cognition/test/metabolism-trigger.test.ts`
- Create: `tests/vertical/e-autonomous-lifecycle.test.ts`
- Modify: `packages/cognition/src/index.ts`

**Interfaces:**
- Consumes: Program D `DEVerticalGateResearchPort`, `QuestionService`,
  `ResearchProgramState`, `ResearchProgramDirectionProposal`,
  `PrincipalResearchCycleInput`, `StructuredRoleExecutionPort`, and the exact
  `IndependentCandidateReviewExecutionInput`/`Attempt`/`Port`; Covenant
  autonomy floor, causal origin attestation, Program B objects/journal/refs,
  `MetabolismRunner`, and current cognitive signals.
- Produces: `DefaultModeLoop.propose()`, `MetabolismTrigger.evaluate()/defer()`, `LifecycleStore`, generic semantic-root/program acceptance, candidate-agenda acceptance, control reconciliation/settlement, and E-owned `CognitiveLifecycleEngine.initialize()/wakeDue()/inspect()`.

```ts
export interface DefaultModeProposalExecutionInput {
  schema: 'cosmo.default-mode-proposal-execution-input.v1';
  allowedCandidateTypes: ['question', 'connection', 'hypothesis'];
  execution: StructuredRoleExecutionInput;
  outputSchemaRef: ObjectRef;
  outputTrust: TrustDescriptor;
}

export interface DefaultModeProposalAttempt {
  schema: 'cosmo.default-mode-proposal-attempt.v1';
  candidate: CandidateFinding & {
    candidateType: 'question' | 'connection' | 'hypothesis';
    origin: 'default_mode';
  };
  runId: RunId;
  generatorIdentity: Sha256;
  runtimeReceiptRef: ObjectRef;
  outputSchemaRef: ObjectRef;
  outputRef: ObjectRef;
  outputHash: Sha256;
  executionClass: RuntimeReceipt['executionClass'];
  contextBundleId: ObjectId;
  completedAt: string;
}

export interface DefaultModeProposalExecutionPort {
  propose(
    input: DefaultModeProposalExecutionInput
  ): Promise<DefaultModeProposalAttempt>;
}

export interface PrincipalResearchCoordinationPort {
  survey(input: PrincipalResearchCycleInput): Promise<PrincipalDecisionRecording>;
}

export interface PrincipalResearchLifecycleTrigger {
  schema: 'cosmo.principal-research-lifecycle-trigger.v1';
  triggerId: Sha256;
  programId: ResearchProgramId;
  kind:
    | 'program_initialized'
    | 'significant_evidence'
    | 'contradiction'
    | 'budget_threshold'
    | 'stagnation'
    | 'sleep_entry'
    | 'wake'
    | 'promotion'
    | 'merge'
    | 'artifact_release'
    | 'human_intervention';
  basedOnBrainCommitId: BrainCommitId;
  basisObjectIds: ObjectId[];
  observedAt: string;
}

export interface PrincipalResearchLifecycleAttempt {
  schema: 'cosmo.principal-research-lifecycle-attempt.v1';
  trigger: PrincipalResearchLifecycleTrigger;
  triggerRef: ObjectRef;
  triggerEventId: EventId;
  cycleInputObjectId: ObjectId;
  principalDecisionId: ObjectId;
  principalDecisionRef: ObjectRef;
  principalDecisionEventId: EventId;
  proposalAttemptRef: ObjectRef;
  completedAt: string;
}

export type PrincipalActionHandlerMap = {
  [Action in PrincipalDecision['action']]: (
    recording: PrincipalDecisionRecording,
  ) => Promise<ObjectRef | null>;
};

export interface PublishedCandidate {
  schema: 'cosmo.published-candidate.v1';
  candidateObjectRef: ObjectRef;
  admittedEventId: EventId;
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  generatorRunId: RunId;
  generatorIdentity: Sha256;
  runtimeReceiptRef: ObjectRef;
  executionClass: RuntimeReceipt['executionClass'];
  publishedAt: string;
}

export interface PublishCandidateInput {
  schema: 'cosmo.publish-candidate-input.v1';
  candidateObjectRef: ObjectRef;
  candidate: CandidateFinding;
  source: {
    role: 'default_mode_generator' | 'consolidation_dream_generator';
    attemptReceiptRef: ObjectRef;
    contextBundleId: ObjectId;
  };
  expectedScope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  causalParentEventIds: EventId[];
  runtimeAuthorization: RuntimeAuthorization;
  mutationAuthorization: MutationAuthorization;
  idempotencyKey: Sha256;
  admittedAt: string;
}

export interface CandidateJournalPort {
  publish(input: PublishCandidateInput): Promise<PublishedCandidate>;
}

export interface CognitiveLifecycleEngineDependencies {
  defaultModeExecution: DefaultModeProposalExecutionPort;
  principalResearcher: PrincipalResearchCoordinationPort;
  researchCoordinator: DEVerticalGateResearchPort;
  independentCandidateReview: IndependentCandidateReviewExecutionPort;
  candidateJournal: CandidateJournalPort;
  candidateBranches: CandidateBranchService;
  // plus the exact D/E services and stores named by this task
}
```

Task 1 exports strict unknown-key-rejecting schemas for
`DefaultModeProposalExecutionInput`, `DefaultModeProposalAttempt`,
`PublishCandidateInput`,
`PrincipalResearchLifecycleTrigger`, `PrincipalResearchLifecycleAttempt`,
and `PublishedCandidate`, including all nested D contracts. Program E consumes
the C-owned `ReviewFindingRecording` schema/type by object identity and never
declares a wrapper around `ReviewFinding`. It also re-exports D's exact
`IndependentCandidateReviewExecutionInputSchema`,
`IndependentCandidateReviewAttemptSchema`, and port/type identities; E defines
no second reviewer port.

`DefaultModeProposalExecutionInput.execution` is the complete exact D
`StructuredRoleExecutionInput`: stored Expedition ref plus decoded Expedition,
complete ContextBundle, RunId/start time, runtime and mutation authorization,
and idempotency key. Its `outputSchemaRef`/`outputTrust` must equal the
ContextBundle execution plan. `DefaultModeStructuredRoleAdapter` is the only
concrete default-mode adapter: it calls injected
`StructuredRoleExecutionPort.execute()`, verifies the exact returned
`StructuredRoleExecutionResult`, reloads/parses the output with E's strict
default-mode candidate schema, and retains the real
`runtimeReceiptRecording.receiptRef`, output ref/schema/hash, execution class,
and identities in `DefaultModeProposalAttempt`. It never calls
`WorkerRuntime`, a provider SDK, or invents a mission, ContextBundle, clock,
authority, or receipt. H injects the D structured-role implementation and D
independent-review execution port at composition.

`CandidateJournalPort.publish()` parses the strict publication input, stores or
byte-verifies the exact candidate object, persists an idempotency intent, and
maps fields one-for-one into D's sole `AdmitSemanticRoleEventInput`:
`source.kind:'semantic_role_attempt'`, the caller's role/attempt receipt/context,
`scope:expectedScope`, `eventType:'candidate_finding'`, the exact payload ref,
causal parents, both supplied authorizations, and `admittedAt`. It never derives
authority, scope, time, or a replacement receipt. The wrapper idempotency key
binds the complete canonical input; replay returns the same admitted event and
a changed body fails. The returned `PublishedCandidate.scope` must equal
`expectedScope`.

- [ ] **Step 1: Write failing autonomous-origin, signal-policy, and durable-lifecycle tests**

```ts
test('default mode originates a question outside the current task graph', async () => {
  const candidateJournal = recordingCandidateJournal();
  const loop = new DefaultModeLoop({
    questionService: recordingQuestionService(),
    candidateJournal,
    candidateBranches: recordingCandidateBranchService(),
    execution: recordingDefaultModeExecutionPort(),
    researchCoordinator: recordingDEVerticalGateResearchPort(),
    reviewedCandidates: recordingReviewedCognitiveCandidateService(),
  });
  const proposal = await loop.propose({
    ...defaultModeLoopOwnerInputFixture(),
    brainCommitId: sha('1'),
    program: researchProgramFixture({
      humanQuestionTexts: ['How does memory consolidation work?'],
    }),
    signals: cognitiveSignals({
      stagnation: 0.84,
      dormantResonance: 0.91,
      contradiction: 0.72,
    }),
    budget: {
      adjacentRemaining: 12,
      wildcardRemaining: 8,
      incubationRemaining: 6,
    },
  });
  assert.equal(proposal.attempt.candidate.origin, 'default_mode');
  assert.equal(
    proposal.promptProvenance.originAttestation.payload.classification,
    'autonomous',
  );
  assert.equal(proposal.lane, 'wildcard');
  assert.ok(proposal.question);
  assert.notEqual(
    proposal.question.wording,
    'How does memory consolidation work?',
  );
  assert.equal(
    proposal.published.admittedEventId !==
      proposal.committedCandidateReviewReceipt
        .reviewFindingRecordings[0]!.eventId,
    true,
  );
  assert.equal(
    proposal.committedCandidateReviewReceipt
      .independentReviewAttempts[0]!.receipt.runId !== proposal.attempt.runId,
    true,
  );
  assert.equal(
    proposal.committedCandidateReviewReceipt
      .reviewFindingRecordings[0]!.qualification.attemptId,
    proposal.committedCandidateReviewReceipt
      .independentReviewAttempts[0]!.receipt.runId,
  );
  assert.equal(
    candidateJournal.admitInputs[0]!.source.attemptReceiptRef.objectId,
    proposal.attempt.runtimeReceiptRef.objectId,
  );
  assert.deepEqual(
    candidateJournal.admitInputs[0]!.scope,
    proposal.published.scope,
  );
  assert.equal(
    proposal.candidateBranchReceipt.candidateBrainCommitId,
    proposal.committedCandidateReviewReceipt.candidateBrainCommitId,
  );
  assert.equal(
    proposal.acceptance.committedCandidateReviewReceiptRef.objectId,
    proposal.committedCandidateReviewReceiptRef.objectId,
  );
});

test('default-mode adapter forwards one exact D structured-role execution', async () => {
  const d = recordingStructuredRoleExecutionPort();
  const adapter = new DefaultModeStructuredRoleAdapter(d);
  const input = defaultModeProposalExecutionInputFixture();
  const attempt = await adapter.propose(input);
  assert.deepEqual(d.inputs, [input.execution]);
  assert.deepEqual(input.execution.expeditionRef,
    fixtureStoredExpeditionRef());
  assert.deepEqual(input.execution.expedition,
    fixtureStoredExpedition());
  assert.deepEqual(input.execution.context,
    fixtureContextBundle());
  assert.equal(d.inputs[0]!.runId, input.execution.runId);
  assert.equal(d.inputs[0]!.startedAt, input.execution.startedAt);
  assert.deepEqual(d.inputs[0]!.authorization,
    input.execution.authorization);
  assert.deepEqual(d.inputs[0]!.mutationAuthorization,
    input.execution.mutationAuthorization);
  assert.equal(d.inputs[0]!.idempotencyKey, input.execution.idempotencyKey);
  assert.deepEqual(attempt.runtimeReceiptRef,
    d.result.runtimeReceiptRecording.receiptRef);
  assert.deepEqual(attempt.outputRef, d.result.outputRef);
  assert.equal(attempt.outputHash, d.result.outputHash);
});

test('incubation alone cannot satisfy active autonomy', () => {
  const state = activeAutonomyState({
    adjacentUsed: 0,
    wildcardUsed: 0,
    incubationUsed: 20,
  });
  assert.equal(activeAutonomySatisfied(state), false);
});

test('metabolism is due from saturation and contradiction without a cycle clock', () => {
  const decision = new MetabolismTrigger(defaultMetabolismPolicy()).evaluate(
    cognitiveSignals({
      fatigue: 0.4,
      saturation: 0.9,
      contradiction: 0.86,
      meaningfulEventsSinceSleep: 74,
    }),
  );
  assert.equal(decision.action, 'sleep_due');
  assert.deepEqual(decision.reasons, ['source_saturation', 'contradiction_pressure']);
});

test('a metabolism deferral must expire', () => {
  assert.throws(
    () => new MetabolismTrigger(defaultMetabolismPolicy()).defer({
      reason: 'finish current evidence capture',
      expiresAt: null,
      reviewAfterMeaningfulEvents: null,
    }),
    { code: 'metabolism_unbounded_deferral' },
  );
});

test('host wakes carry no cognitive instruction and the engine keeps research moving', async () => {
  const fixture = await autonomousLifecycleFixture({
    crashAfterDecisionNumber: 3,
  });
  await fixture.engine.initialize(fixture.initializeInput);

  for (const observedAt of fixture.dueWakeTimes) {
    await fixture.reopenIfCrashed();
    await fixture.engine.wakeDue({
      programId: fixture.programId,
      hostWakeId: `host_${observedAt}`,
      observedAt,
    });
  }

  assert.deepEqual(
    fixture.recordedHostWakeInputs.map((input) => Object.keys(input).sort()),
    fixture.dueWakeTimes.map(() => ['hostWakeId', 'observedAt', 'programId']),
  );
  assert.ok(fixture.autonomousQuestionIds.length >= 2);
  assert.ok(fixture.expeditionIds.length >= 3);
  assert.ok(fixture.metabolismReceiptIds.length >= 1);
  assert.ok(fixture.wakeBrainCommitIds.length >= 1);
  assert.equal(fixture.duplicateDispatchedActions, 0);
  assert.equal(
    (await fixture.engine.inspect(fixture.programId)).nextWakeAt,
    fixture.expectedNextWakeAt,
  );
});

test('lifecycle initialization is repeat-safe across restart', async () => {
  const fixture = await autonomousLifecycleFixture();
  const first = await fixture.engine.initialize(fixture.initializeInput);
  assert.equal(first.outcome, 'initialized');

  await fixture.reopen();
  const repeated = await fixture.engine.initialize(fixture.initializeInput);
  assert.equal(repeated.outcome, 'already_initialized');
  assert.equal(
    repeated.initializationInputObjectId,
    first.initializationInputObjectId,
  );
  assert.deepEqual(repeated.state, first.state);

  await assert.rejects(
    fixture.engine.initialize({
      ...fixture.initializeInput,
      startingBrainCommitId: sha('9'),
    }),
    { code: 'cognitive_lifecycle_initialization_conflict' },
  );
  assert.deepEqual(
    await fixture.engine.inspect(fixture.programId),
    first.state,
  );
});

test('D create is committed before E initializes from the accepted child', async () => {
  const fixture = await programControlFixture({ action: 'create' });
  const accepted = await fixture.engine.acceptProgramMutation(
    fixture.acceptProgramMutationInput,
  );
  assert.deepEqual(accepted.scope,
    fixture.acceptProgramMutationInput.mutationResult.eventScope);
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(
      accepted.acceptedBrainCommitId,
    )).directJournalEventIds,
    accepted.journalEventIds,
  );
  const initialized = await fixture.engine.initialize({
    ...fixture.initializeInput,
    programStateObjectId: accepted.programStateObjectId,
    controlEpoch: accepted.controlEpoch,
    acceptedProgramMutationReceiptId:
      accepted.researchProgramMutationReceiptId,
    initialBrainCommitId: accepted.acceptedBrainCommitId,
  });
  assert.equal(
    initialized.state.acceptedBrainCommitId,
    accepted.acceptedBrainCommitId,
  );
  assert.notEqual(
    initialized.state.acceptedBrainCommitId,
    accepted.previousBrainCommitId,
  );
  assert.equal(await fixture.canonicalProgramStateStatus(), 'initializing');

  const decision = await fixture.engine.reconcileProgramControl({
    programId: fixture.programId,
    programStateObjectId: accepted.programStateObjectId,
    controlEpoch: accepted.controlEpoch,
    hostControlDeliveryId: 'create_control_delivery_1',
    observedAt: '2026-07-30T12:00:00.000Z',
  });
  assert.equal(decision.action, 'creation_converged');
  assert.equal(
    fixture.finalizeTransitionInput.cognitiveLifecycleDecisionObjectId,
    decision.cognitiveLifecycleDecisionObjectId,
  );
  assert.equal(await fixture.canonicalProgramStateStatus(), 'active');
  assert.equal(fixture.acceptedProgramRootCommitCount, 2);
});

test('stored D proposal interrupted before CAS is accepted exactly once on retry', async () => {
  const fixture = await programControlFixture({
    action: 'pause',
    crashAfterRootWriteBeforeCommitAdvance: true,
  });
  await assert.rejects(
    fixture.engine.acceptProgramMutation(fixture.acceptProgramMutationInput),
    { code: 'fault_injected' },
  );
  assert.equal(
    await fixture.dProgramStateStatus(),
    'pausing',
    'D intent exists even while canonical ProgramRoot is old',
  );
  assert.equal(await fixture.canonicalProgramStateStatus(), 'active');
  await fixture.reopen();
  const accepted = await fixture.engine.acceptProgramMutation(
    fixture.acceptProgramMutationInput,
  );
  const duplicate = await fixture.engine.acceptProgramMutation(
    fixture.acceptProgramMutationInput,
  );
  assert.equal(duplicate.acceptedBrainCommitId, accepted.acceptedBrainCommitId);
  assert.equal(await fixture.canonicalProgramStateStatus(), 'pausing');
  assert.equal(fixture.commitAdvanceSuccessCount, 1);
});

test('create convergence resumes across the initializing and active commits', async () => {
  const fixture = await programControlFixture({
    action: 'create',
    crashAfterFinalizeBeforeActiveAcceptance: true,
  });
  const initializing = await fixture.engine.acceptProgramMutation(
    fixture.acceptProgramMutationInput,
  );
  await fixture.engine.initialize({
    ...fixture.initializeInput,
    programStateObjectId: initializing.programStateObjectId,
    controlEpoch: initializing.controlEpoch,
    acceptedProgramMutationReceiptId:
      initializing.researchProgramMutationReceiptId,
    initialBrainCommitId: initializing.acceptedBrainCommitId,
  });
  await assert.rejects(
    fixture.engine.reconcileProgramControl(fixture.reconcileInput),
    { code: 'fault_injected' },
  );
  assert.equal(await fixture.dProgramStateStatus(), 'active');
  assert.equal(await fixture.canonicalProgramStateStatus(), 'initializing');

  await fixture.reopen();
  const recovered = await fixture.engine.reconcileProgramControl(
    fixture.reconcileInput,
  );
  assert.equal(recovered.action, 'creation_converged');
  assert.equal(await fixture.canonicalProgramStateStatus(), 'active');
  assert.equal(fixture.finalizeTransitionCalls, 1);
  assert.equal(fixture.activeProgramCommitAdvanceSuccessCount, 1);
});

test('generic Question and Relationship proposals remain inert until E accepts them', async () => {
  const fixture = await semanticRootAcceptanceFixture();
  assert.equal(await fixture.canonicalQuestionRoot(), fixture.oldQuestionRoot);
  const accepted = await fixture.engine.acceptSemanticRootMutation(
    fixture.questionAcceptanceInput,
  );
  assert.equal(accepted.rootKind, 'questionRoot');
  assert.deepEqual(accepted.scope,
    fixture.questionAcceptanceInput.source.mutation.eventScope);
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(
      accepted.acceptedBrainCommitId,
    )).directJournalEventIds,
    accepted.journalEventIds,
  );
  assert.equal(await fixture.canonicalQuestionRoot(), fixture.newQuestionRoot);
  const covenant = await fixture.engine.acceptSemanticRootMutation(
    fixture.covenantRevisionAcceptanceInput,
  );
  assert.equal(covenant.rootKind, 'relationshipRoot');
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(
      covenant.acceptedBrainCommitId,
    )).directJournalEventIds,
    covenant.journalEventIds,
  );
  assert.equal(
    await fixture.canonicalCovenantPayloadRef(),
    fixture.covenantRevision.covenantRoot,
  );
  assert.equal(
    'childCommitId' in fixture.covenantRevisionAcceptanceInput.source.update
      .nextRelationshipRoot,
    false,
  );
  const artifact = await fixture.engine.acceptSemanticRootMutation(
    fixture.artifactIndexAcceptanceInput,
  );
  assert.equal(artifact.rootKind, 'artifactIndexRoot');
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(
      artifact.acceptedBrainCommitId,
    )).directJournalEventIds,
    artifact.journalEventIds,
  );
  await assert.rejects(
    fixture.engine.acceptSemanticRootMutation(
      fixture.rawProgramRootProposalWithoutResearchProgramMutationResult,
    ),
    { code: 'semantic_root_source_invalid' },
  );
});

for (const rootKind of [
  'epistemicRoot',
  'negativeKnowledgeRoot',
  'questionRoot',
  'relationshipRoot',
  'programRoot',
  'artifactIndexRoot',
] as const) {
  test(`${rootKind} acceptance rejects any nested or journal scope mismatch`, async () => {
    const fixture = await semanticRootScopeFixture(rootKind);
    for (const input of [
      fixture.withWrongProposalTargetRef(),
      fixture.withWrongUpdateParent(),
      fixture.withWrongReceiptLineage(),
      fixture.withWrongJournalBrainScope(),
    ]) {
      await assert.rejects(
        () => fixture.engine.acceptSemanticRootMutation(input),
        { code: 'semantic_root_event_scope_mismatch' },
      );
    }
    assert.equal(fixture.canonicalAdvanceCount, 0);
  });
}

test('acquired corpus evidence enters the Brain only through its exact stored C proposal', async () => {
  const fixture = await acquiredEvidenceAcceptanceFixture();
  assert.deepEqual(await fixture.canonicalEpistemicRoot(),
    fixture.previousEpistemicRoot);
  const receipt = await fixture.engine.acceptSemanticRootMutation(
    fixture.epistemicAcceptanceInput,
  );
  assert.equal(receipt.rootKind, 'epistemicRoot');
  const view = await fixture.livingBrain.materialize(
    receipt.acceptedBrainCommitId,
  );
  const snapshot = view.snapshot.epistemic.leaves[0]!.snapshot;
  assert.equal(snapshot.corpusSnapshotIds.includes(
    fixture.corpusSnapshotId), true);
  assert.equal(snapshot.sourceRecordRefs.some(
    (ref) => ref.objectId === fixture.sourceRecordRef.objectId), true);
  assert.equal(snapshot.extractionRefs.some(
    (ref) => ref.objectId === fixture.extractionRef.objectId), true);
  assert.equal(snapshot.evidenceSpanRefs.some(
    (ref) => ref.objectId === fixture.evidenceSpanRef.objectId), true);
  assert.deepEqual(
    receipt.acceptedRootRef,
    fixture.expectedStoredNextRootRef,
  );
  assert.deepEqual(receipt.scope,
    fixture.epistemicAcceptanceInput.source.mutation.scope);
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(
      receipt.acceptedBrainCommitId,
    )).directJournalEventIds,
    receipt.journalEventIds,
  );
  assert.equal(fixture.eRebuiltEpistemicRootCalls, 0);
});

test('a proposed research direction becomes candidate cognition, never a live Program', async () => {
  const fixture = await candidateAgendaAcceptanceFixture();
  const accepted = await fixture.engine.acceptCandidateAgendaProposal(
    fixture.acceptInput,
  );
  assert.equal(accepted.proposalObjectId, fixture.proposal.proposalObjectId);
  assert.equal(accepted.parentBrainCommitId,
    fixture.proposal.payload.expectedBrainCommitId);
  assert.equal(accepted.agendaNodeAddress.rootKind, 'topologyRoot');
  assert.equal(await fixture.candidateBranchHead(),
    accepted.candidateBrainCommitId);
  assert.deepEqual(accepted.scope, fixture.proposal.payload.eventScope);
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(
      accepted.candidateBrainCommitId,
    )).directJournalEventIds,
    accepted.journalEventIds,
  );
  assert.equal(await fixture.canonicalProgramRoot(),
    fixture.unchangedProgramRoot);
  assert.equal(fixture.researchProgramCreateCalls, 0);

  const repeated = await fixture.engine.acceptCandidateAgendaProposal(
    fixture.acceptInput,
  );
  assert.deepEqual(repeated, accepted);
  assert.equal(fixture.candidateCommitAdvanceSuccessCount, 1);
});

test('candidate agenda rejects canonical or another candidate scope', async () => {
  const fixture = await candidateAgendaAcceptanceFixture();
  for (const input of [
    fixture.withCanonicalTargetScope(),
    fixture.withOtherCandidateTargetScope(),
    fixture.withAdmissionEventScopeMismatch(),
  ]) {
    await assert.rejects(
      () => fixture.engine.acceptCandidateAgendaProposal(input),
      { code: 'candidate_agenda_event_scope_mismatch' },
    );
  }
  assert.equal(fixture.candidateCommitAdvanceSuccessCount, 0);
});

test('control notice converges before due-work selection and E alone sets next wake', async () => {
  const fixture = await programControlFixture({ action: 'pause' });
  const accepted = await fixture.engine.acceptProgramMutation(
    fixture.acceptProgramMutationInput,
  );
  const decision = await fixture.engine.reconcileProgramControl({
    programId: fixture.programId,
    programStateObjectId: accepted.programStateObjectId,
    controlEpoch: accepted.controlEpoch,
    hostControlDeliveryId: 'control_delivery_1',
    observedAt: '2026-07-30T12:00:00.000Z',
  });
  assert.equal(decision.action, 'pause_converged');
  assert.equal(decision.nextWakeAt, null);
  assert.equal(fixture.dueWorkSelections, 0);
  assert.equal(
    fixture.finalizeTransitionInput.cognitiveLifecycleDecisionObjectId,
    decision.cognitiveLifecycleDecisionObjectId,
  );
});

test('settlement requires stopping criteria and a qualified Principal decision', async () => {
  const accepted = await settlementControlFixture({
    stoppingCriteriaSatisfied: true,
    principalDecisionQualified: true,
  });
  const decision = await accepted.engine.reconcileProgramControl(
    accepted.reconcileInput,
  );
  assert.equal(decision.action, 'settlement_accepted');
  assert.equal(decision.nextWakeAt, null);

  const rejected = await settlementControlFixture({
    stoppingCriteriaSatisfied: false,
    principalDecisionQualified: true,
  });
  assert.equal(
    (await rejected.engine.reconcileProgramControl(rejected.reconcileInput)).action,
    'settlement_rejected',
  );
  assert.equal(rejected.hostSettlementDecisionCalls, 0);
});

test('lead researcher is append-before-act and recovered once across lifecycle triggers', async () => {
  const fixture = await principalResearchLifecycleFixture({
    crashAfterTriggerPersisted: 'significant_evidence',
  });
  await assert.rejects(
    fixture.engine.wakeDue(fixture.hostWake),
    { code: 'fault_injected' },
  );
  await fixture.reopen();
  await fixture.engine.wakeDue(fixture.hostWake);
  assert.deepEqual(
    fixture.triggerKinds,
    [
      'program_initialized',
      'significant_evidence',
      'sleep_entry',
      'wake',
    ],
  );
  assert.equal(fixture.principalSurveyCallsByTrigger.significant_evidence, 1);
  assert.equal(fixture.duplicatePrincipalAttempts, 0);
  assert.equal(fixture.allDecisionsCandidateOnly, true);
  for (const attempt of fixture.principalAttempts) {
    assert.equal(
      attempt.cycleInput.requestedByEventId,
      attempt.triggerEvent.eventId,
    );
    assert.deepEqual(
      attempt.recording.event.causalParentEventIds,
      [attempt.triggerEvent.eventId],
    );
    assert.deepEqual(
      attempt.recording.event.scope,
      attempt.cycleInput.survey.eventScope,
    );
    assert.ok(
      attempt.triggerJournalCursor < attempt.principalSurveyCallCursor,
    );
  }
});

test('every Principal action has one closed append-before-act handler', async () => {
  const fixture = await principalActionDispatchFixture({
    crashAfterDispatchIntentFor: 'propose_cognitive_candidate',
  });
  assert.deepEqual(
    Object.keys(fixture.handlers).sort(),
    [...PrincipalDecisionActionSchema.options].sort(),
  );
  await assert.rejects(
    fixture.dispatch(fixture.recording('propose_cognitive_candidate')),
    { code: 'fault_injected' },
  );
  await fixture.reopen();
  await fixture.dispatch(fixture.recording('propose_cognitive_candidate'));
  assert.equal(fixture.handlerCalls.propose_cognitive_candidate, 1);

  await fixture.dispatch(fixture.recording('propose_metabolism'));
  assert.equal(fixture.metabolismTriggerSignalCount, 1);
  assert.equal(fixture.directMetabolismRuns, 0);
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/default-mode-loop.test.ts test/cognitive-lifecycle-engine.test.ts test/program-control.test.ts test/metabolism-trigger.test.ts && npm exec -- tsx --test tests/vertical/e-autonomous-lifecycle.test.ts`

Expected: FAIL because the loop, lifecycle store/engine, semantic-root/program-control acceptor, and trigger are absent.

- [ ] **Step 3: Implement default-mode proposal admission**

The loop may create only:

```ts
type DefaultModeOutput = {
  attempt: DefaultModeProposalAttempt;
  published: PublishedCandidate;
  candidateBranchReceipt: CandidateBranchCommitReceipt;
  committedCandidateReviewReceiptRef: ObjectRef;
  committedCandidateReviewReceipt: DECommittedCandidateReviewReceipt;
  acceptance: ReviewedCognitiveCandidateAcceptanceReceipt;
  question: Question | null;
  lane: 'adjacent' | 'wildcard' | 'incubation';
  promptProvenance: PromptProvenance;
};
```

It builds the strict bounded input and calls only
`DefaultModeProposalExecutionPort`, whose concrete adapter is the
`DefaultModeStructuredRoleAdapter` described above and records the true
`executionClass`. It parses the seven-variant D `CandidateFindingSchema`, calls
`CandidateJournalPort.publish()` with the owner-supplied scope, authorizations,
idempotency key, and time, then commits that admitted candidate to its isolated
candidate branch before review. Only that real
`CandidateBranchCommitReceipt` may enter D's exact
`reviewCommittedCandidate()` call. The lifecycle owner supplies complete,
already-stored independent review execution inputs; D alone runs those
attempts, records their Program C findings and qualifications, records review
completion, and obtains the Principal disposition. E stores that exact
`DECommittedCandidateReviewReceipt` and passes it unchanged to
`ReviewedCognitiveCandidateService.accept()`. The D review input uses
`originKind:'semantic_role'` and copies the branch receipt's
role, real RuntimeReceipt ref, ContextBundle ID, output-schema ref, and output
ref without substitution. For a question candidate, the
selected root mutation is the exact D Question proposal and only the reviewed
canonical acceptance makes it queryable; `QuestionService.originate()` never
publishes it ahead of review. Ordering is `proposal attempt → candidate
admitted event → candidate Brain commit → independent-review attempt(s) →
review-finding event(s) → review-completion event → Principal event → reviewed
E acceptance`; no ID is reused. It stops honestly when no autonomous budget
remains. Only
`proposal.question.promptProvenance.originAttestation.payload.classification ===
'autonomous'` earns adjacent/wildcard/incubation autonomy credit; an `ambiguous`
or `human_directed` attestation stays durable but does not satisfy the autonomy
floor. Recorded/mock execution remains attributable but cannot be mislabeled
live. The loop cannot call a provider SDK, repository commit APIs, or claim
promotion APIs.

- [ ] **Step 4: Implement adaptive sleep decisions and bounded deferral**

`MetabolismTrigger.evaluate()` uses fatigue, source saturation, repetition, stagnation, surprise, breakthrough, contradiction, evidence gaps, and meaningful event count. A wall-clock or cycle count may be a guardrail, never the sole signal. `defer()` requires either `expiresAt` or `reviewAfterMeaningfulEvents`, writes the rationale as a durable decision, and returns `sleep_due` after the bound.

```ts
evaluate(signals: CognitiveSignals): MetabolismDecision {
  const reasons = [
    signals.fatigue >= this.policy.fatigueThreshold && 'cognitive_fatigue',
    signals.saturation >= this.policy.saturationThreshold && 'source_saturation',
    signals.stagnation >= this.policy.stagnationThreshold && 'stagnation',
    signals.contradiction >= this.policy.contradictionThreshold
      && 'contradiction_pressure',
  ].filter((reason): reason is string => Boolean(reason));
  return reasons.length === 0
    ? { action: 'remain_awake', reasons: [] }
    : { action: 'sleep_due', reasons };
}

defer(input: MetabolismDeferralInput): MetabolismDeferral {
  if (input.expiresAt === null && input.reviewAfterMeaningfulEvents === null) {
    throw typedError('metabolism_unbounded_deferral');
  }
  return MetabolismDeferralSchema.parse({
    ...input,
    schema: 'cosmo.metabolism-deferral.v1',
  });
}
```

- [ ] **Step 5: Implement semantic-root acceptance and Program control convergence**

`acceptSemanticRootMutation()` parses the strict discriminated input and:

1. loads `storedMutationRef` through Program B, verifies its descriptor/payload, and requires byte-exact equality with the supplied decoded D mutation;
2. requires the nested update kind, expected Brain commit, previous root ref, changed ID, event ID, and next record ref to match the D object;
3. requires the canonical ref/head and live lease to equal the proposal pin;
4. validates and stores the exact D-owned next root with its owner codec and exact descriptor links;
5. persists an acceptance intent keyed by `(rootKind, storedMutationRef.objectId, idempotencyKey)` before CAS;
6. derives a Heritage snapshot whose curation event is `basedOnBrainCommitId: expectedCanonicalHead`, builds a child payload changing only the named semantic root, Heritage root, and admitted journal range, then runs typed/cross-root verification;
7. calls Program B `commitAndAdvance()` exactly once; and
8. stores `SemanticRootMutationAcceptanceReceipt` and returns the existing byte-identical receipt on replay.

A C source additionally requires
`storedMutationRef.objectId === mutation.proposalRef.objectId`, byte-verifies
the stored outer `CorpusRootUpdateProposal`, requires `update` to equal its
discriminated inner update, uses `mutation.proposalEventId` as the sole new
proposal mutation event, and dispatches by its exact
Epistemic/Negative Knowledge discriminator. E serializes the C-owned
`nextEpistemicRoot` or `nextNegativeKnowledgeRoot` exactly once through C's
singleton codec and never reconstructs, merges, normalizes, or semantically
edits that root. The commit's corpus-snapshot list must equal the accepted
Epistemic root exactly. Acquisition, Source, Extraction, EvidenceSpan, candidate
Claim, Review, Contradiction, Experiment, Negative Knowledge, and Claim
transition objects therefore all have the same inert-C-proposal → E-acceptance
path.

A crash after the next root is stored or after ref advance is recovered from the acceptance intent; it never creates a second child. A different body under the same idempotency key fails. Question/Relationship/Covenant/Program/Artifact Index proposals are inert objects until this method accepts them. Covenant acceptance verifies the payload ref and revision event rather than a child commit ID. The Program variant requires the complete stored `ResearchProgramMutationResult`; a free-floating Program-root proposal cannot create or control a program.

`acceptProgramMutation()` verifies that the stored receipt wrapper ID, decoded mutation receipt, derived `ProgramControlNotice`, next state ref/object ID, control epoch/status/action, and Program-root proposal all agree. It delegates CAS to `acceptSemanticRootMutation()` and returns the specialized acceptance receipt. A D `create` mutation must be accepted first; `initialize()` then requires that accepted child commit/state/epoch/receipt and refuses the pre-create parent.

`acceptCandidateAgendaProposal()` is deliberately not a semantic Program-root
acceptor. It loads `storedProposalRef`, proves byte-exact equality with the
decoded D `ResearchProgramDirectionProposal`, requires
`payload.expectedBrainCommitId` to be the candidate commit's sole parent, and
requires `admittedEventId` to be the durable admission event for that exact
proposal. It creates an unverified candidate agenda `CognitionNode`, stores a
Topology root whose only new causal event is that admission, preserves the other
eight roots byte-identically, verifies all nine roots and cross-root invariants,
and advances only `candidateBranchRef` under its exact expected head and lease.
The acceptance intent is persisted before CAS and replay returns the identical
receipt. This path cannot call `ResearchProgramService.create()`, cannot emit a
`ProgramControlNotice`, cannot mutate `ProgramRoot`, and cannot initialize the
cognitive lifecycle. Promotion of the candidate agenda is a later qualified
Program F/E action; actual Program creation still starts with Program D.

`reconcileProgramControl()` consumes every accepted Program notice before any ordinary due-work check. It rejects stale/skipped epochs and mismatched state IDs. Transitional status maps mechanically:

- `initializing → creation_converged`: E first initializes lifecycle state from
  the already-accepted initializing child, persists the decision, D finalizes
  `active`, and E accepts that final Program mutation into a second child;
- `pausing → pause_converged`, with `nextWakeAt: null`;
- `resuming → resume_converged`, with E selecting the first new `nextWakeAt`;
- `cancelling → cancel_converged`, with `nextWakeAt: null`;
- `completion_proposed → settlement_accepted` only when the exact D state shows satisfied stopping criteria and its cited Principal decision is qualified, otherwise `settlement_rejected`.

E stores the generic `CognitiveLifecycleDecision` before calling D `finalizeTransition()`. D receives only that exact decision object ID, returns the next Program mutation, and E accepts its Program root through the same CAS path before updating lifecycle state. For creation, the full ordered flow is `D create(initializing) → E accept root → E initialize → E creation_converged decision → D finalize(active) → E accept final root`; both acceptance edges and the decision/finalization edge are independently idempotent and restart-recoverable. This sequence makes pending D state versus canonical Program-root state explicit and recoverable. H supplies only delivery IDs/timestamps and never selects convergence, settlement, or a wake.

- [ ] **Step 6: Implement the durable cognitive lifecycle engine**

`LifecycleStore` persists immutable initialization, `CognitiveLifecycleDecision`, and outcome records in the admitted journal; an optional SQLite index may accelerate lookup but is disposable. `initialize()` canonicalizes the complete strict input with Program A's helper and stores its `initializationInputObjectId` under the exact `programId` before returning. The first successful call returns `outcome: 'initialized'`. Any concurrent or later byte-identical call, including after restart, returns `outcome: 'already_initialized'` with the same input object ID and byte-identical persisted state and appends no second initialization. A different canonical input for that program fails with `CognitiveLifecycleInitializationConflict`, leaves the original state unchanged, and cannot be treated as a lifecycle update. Program H may retry this exact port but may not implement an idempotency shim or choose any lifecycle policy.

The Principal Researcher is a live lifecycle participant, not a report-only or
unused dependency. E creates a strict `PrincipalResearchLifecycleTrigger` at
program initialization, significant new evidence, contradiction, budget
threshold, stagnation, sleep entry, wake, promotion, merge, artifact release,
and human intervention. The engine stores the trigger, then stores and appends
one distinct strict `PrincipalResearchLifecycleTriggerJournalEvent` before
survey. It constructs the complete exact D `PrincipalResearchCycleInput`
(bounded survey, `requestedByEventId` equal to that trigger event,
Principal/policy/review pins, mutation authority, and reviewed time), stores
that cycle input, and only then calls
`PrincipalResearchCoordinationPort.survey()`. The returned D
`PrincipalDecisionRecording.event` must have the survey's exact scope and the
trigger event as its sole direct causal parent. E then stores a
`PrincipalResearchLifecycleAttempt` linking trigger/ref/event, cycle input, the
returned decision ref/value/event, and its real proposal-attempt receipt before
any downstream action. No lifecycle stage fabricates the old survey-only call.
A crash at any boundary is recovered by `triggerId`; an identical trigger is
surveyed at most once, and a conflicting body under the same ID fails.

Principal output remains candidate-only until the appropriate authority accepts
it. `propose_expedition`, candidate contest/incubation, question transition,
dormancy/revival, and claim-transition proposals enter their D candidate and
review flows; they cannot mutate a canonical root directly.
`propose_program_stop` may call D's settlement-proposal method only with the
decision's exact ID and cited stopping evidence, after which the normal
Program-control handshake applies. `defer_metabolism` may create only a bounded
E deferral. No Principal proposal creates a Research Program from a direction
proposal, promotes its own finding, writes a canonical Brain commit, or calls a
provider SDK. The persisted trigger/attempt links make “what surprised it,”
“what changed its mind,” and “why it chose the next inquiry” formation-trace
questions answerable from the Brain rather than reconstructed prose.

Dispatch is a closed exhaustive table over D's exact
`PrincipalDecision['action']` union:

| Principal action | Only permitted E dispatch |
|---|---|
| `propose_question_origin` | D Question proposal, then E semantic-root acceptance |
| `propose_expedition` | D bounded expedition build/launch |
| `propose_cognitive_candidate` | E candidate branch only, followed by committed review |
| `propose_claim_transition` | E qualified Claim-promotion path |
| `contest_candidate` | E reviewed-cognitive disposition `contested` |
| `incubate_candidate` | E reviewed-cognitive disposition `incubating` |
| `propose_question_transition` | D Question transition proposal, then E acceptance |
| `propose_metabolism` | E metabolism-trigger signal only; never a direct run |
| `propose_program_settlement` | D settlement proposal, then E Program-control convergence |
| `propose_program_stop` | D stop/settlement proposal, then E Program-control convergence |
| `propose_dormancy` | reviewed cognition/Question dormancy proposal path |
| `propose_revival` | reviewed cognition/Question revival proposal path |
| `defer_metabolism` | bounded E deferral with expiry or meaningful-event bound |
| `defer_research_direction` | inert durable deferral; no mutation or dispatch |

For every row, E stores a canonical dispatch intent keyed by the Principal
decision/event before calling the handler, then stores the exact returned
proposal/receipt or inert outcome. Replay resumes that intent and invokes the
handler at most once. `PrincipalActionHandlerMap` is assigned with `satisfies`
against the closed union and its default branch is `assertNever`; an unknown,
missing, or multiply registered action fails startup and cannot silently defer.

For ordinary operation, `LifecycleStore` persists immutable decisions before dispatch, then persists an outcome event and the computed `nextWakeAt`. It reconstructs current state from the admitted journal after process death. `hostWakeId` is an idempotency key.

`CognitiveLifecycleEngine.wakeDue()` accepts only `{ programId, hostWakeId, observedAt }`. `programId` routes the host pulse to already-persisted E state; it is not a cognitive instruction. The input cannot accept a Question, lane, action, prompt, model, expedition, or sleep directive. In one bounded engine wake it:

1. reconstructs lifecycle state, accepts/reconciles every pending D
   `ProgramControlNotice`, and reconciles an unfinished Program D run,
   Principal lifecycle attempt, or metabolism attempt before checking whether
   ordinary work is due;
2. returns an idempotent `not_due` receipt if `observedAt < nextWakeAt`;
3. reads the exact branch head, Program D `ResearchProgramState`, autonomy ledger, admitted cognitive frontier, and current Living Brain signals;
4. selects exactly one action by frozen policy: recover in-flight work; run due metabolism; review a qualified candidate; launch an expedition for an active Question; originate causally autonomous default-mode work when the rolling floor requires it; otherwise remain idle;
5. appends the complete decision object and journal record before invoking Program D or `MetabolismRunner`;
6. dispatches through typed D/E ports, never directly through a model SDK;
7. records exact action receipts and the resulting Brain commit; and
8. computes/persists the next wake from remaining due work, meaningful-event bounds, backoff, and metabolism deferral—not from a Program H schedule policy.

On restart, a decision without an outcome is reconciled by its exact action/idempotency key. The engine resumes a D checkpoint, resumes a metabolism attempt, or records a typed lost-action outcome; it never chooses a second action merely because the first process vanished.

Program H's only allowed integration is:

```ts
await cognitiveLifecycleEngine.wakeDue({
  programId: scheduledProgramId,
  hostWakeId: durableSchedulerOccurrenceId,
  observedAt: clock.now().toISOString(),
});
```

H may persist timers and retry delivery, but may not evaluate signals, select questions/lanes, launch expeditions, call metabolism directly, or calculate `nextWakeAt`.

- [ ] **Step 7: Run focused, package, and autonomous lifecycle tests**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/default-mode-loop.test.ts test/cognitive-lifecycle-engine.test.ts test/program-control.test.ts test/metabolism-trigger.test.ts && npm exec -- tsx --test tests/vertical/e-autonomous-lifecycle.test.ts && npm test --workspace @cosmo/cognition`

Expected: PASS; C and D proposals remain inert until one canonical E
acceptance; acquired evidence appears through the exact C root proposal without
E rebuilding it; interrupted acceptance/reconciliation resumes exactly once;
create initializes from the accepted child; initialization is idempotent across
restart; control precedes due-work; E alone sets `nextWakeAt` and settlement;
causal attestation—not a caller Boolean—credits autonomy; restart dispatches no
duplicate action; repeated host-only wakes originate and pursue new questions;
and unbounded sleep deferral is impossible.

- [ ] **Step 8: Commit**

```bash
git add packages/cognition/src/default-mode-loop.ts \
  packages/cognition/src/default-mode-structured-role-adapter.ts \
  packages/cognition/src/lifecycle-store.ts \
  packages/cognition/src/program-control.ts \
  packages/cognition/src/cognitive-lifecycle-engine.ts \
  packages/cognition/src/metabolism-trigger.ts packages/cognition/src/index.ts \
  packages/cognition/test/default-mode-loop.test.ts \
  packages/cognition/test/default-mode-structured-role-adapter.test.ts \
  packages/cognition/test/cognitive-lifecycle-engine.test.ts \
  packages/cognition/test/program-control.test.ts \
  packages/cognition/test/metabolism-trigger.test.ts \
  tests/vertical/e-autonomous-lifecycle.test.ts
git commit -m "feat(cognition): restore default mode autonomy"
```

## Task 6: Fence the high-water metabolism transaction and make it resumable

**Files:**
- Create: `packages/cognition/src/metabolism-store.ts`
- Create: `packages/cognition/src/metabolism-runner.ts`
- Create: `packages/cognition/test/metabolism-runner.test.ts`
- Create: `packages/cognition/test/metabolism-faults.test.ts`
- Modify: `packages/cognition/src/cognitive-lifecycle-engine.ts`
- Modify: `packages/cognition/test/cognitive-lifecycle-engine.test.ts`
- Modify: `packages/cognition/src/index.ts`

**Interfaces:**
- Consumes: Program B journal, object, lease, commit, ref, and `commitAndAdvance()` APIs plus Task 2's attributed composite Living Brain.
- Produces: `MetabolismRunner.run()` and `resume()`, then replaces Task 5's recording `MetabolismRunner` test port with the real runner in lifecycle integration.

- [ ] **Step 1: Write failing high-water, resume, late-event, and concurrency tests**

```ts
test('events after the high-water mark remain for the next epoch', async () => {
  const fixture = await metabolismFixture();
  const runner = fixture.runner({ pauseAfterStage: 'replay' });
  const pending = runner.run(fixture.request);
  await fixture.waitForStage('replay');
  await fixture.appendCognitiveEvent('evt_late_1');
  await fixture.continue();
  const receipt = await pending;
  assert.equal(
    (await fixture.attempt(receipt.attemptId)).replayRange.throughInclusive,
    fixture.initialHighWater,
  );
  assert.equal(receipt.consumedEventIds.includes('evt_late_1'), false);
});

test('replay excludes an interleaved event from another Brain scope', async () => {
  const fixture = await metabolismFixture({
    interleaveOtherBranchEventInsideReplayRange: true,
  });
  const receipt = await fixture.runner().run(fixture.request);
  assert.deepEqual(receipt.consumedEventIds,
    fixture.expectedSameScopeInputEventIds);
  assert.equal(receipt.consumedEventIds.includes(
    fixture.otherBranchEventId,
  ), false);
  assert.deepEqual(receipt.scope, fixture.request.scope);
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(receipt.childCommitId))
      .directJournalEventIds,
    receipt.journalEventIds,
  );
  assert.equal(receipt.journalEventIds.some(
    (eventId) => receipt.consumedEventIds.includes(eventId),
  ), false);
});

test('resume reuses recorded semantic outputs byte for byte', async () => {
  const fixture = await metabolismFixture({ crashAfterStage: 'dream' });
  await assert.rejects(() => fixture.runner().run(fixture.request), {
    code: 'fault_injected',
  });
  const before = await fixture.stageOutputRef('dream');
  const receipt = await fixture.runner().resume(fixture.attemptId);
  const after = await fixture.stageOutputRef('dream');
  assert.equal(after.objectId, before.objectId);
  assert.equal(receipt.reusedStages.includes('dream'), true);
  assert.equal(fixture.semanticInvocationCount('dream'), 1);
});

test('a late fenced stage output cannot enter candidate history', async () => {
  const fixture = await metabolismFixture();
  const expired = await fixture.expireAndReplaceLease();
  await assert.rejects(
    () => fixture.runner().acceptStageOutput(expired.output, expired.leaseProof),
    { code: 'stale_fencing_token' },
  );
  assert.equal(await fixture.candidateJournalContains(expired.eventId), false);
});

test('simultaneous metabolism attempts produce at most one child', async () => {
  const fixture = await metabolismFixture();
  const [left, right] = await Promise.allSettled([
    fixture.runner().run({ ...fixture.request, attemptId: 'met_left' }),
    fixture.runner().run({ ...fixture.request, attemptId: 'met_right' }),
  ]);
  assert.equal([left, right].filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = [left, right].find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  assert.equal(rejected?.reason.code, 'lease_conflict');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/metabolism-runner.test.ts test/metabolism-faults.test.ts`

Expected: FAIL because the transaction runner and stage store are absent.

- [ ] **Step 3: Implement append-before-stage attempt creation**

At start:

1. resolve `branchRef` to `parentCommitId`;
2. read `journal.head()` once as `journalHighWatermark`;
3. acquire `leases.acquire({ resource: 'metabolism:<branchRef>', ... })`;
4. hash the fencing token for the persisted attempt record;
5. materialize and pin every source layer, union wrapper, and reachable root ID from the parent;
6. append the attempt record before invoking any semantic stage; and
7. use `(parent.journalRange.throughInclusive, journalHighWatermark]` only as a
   read bound, then select explicit admitted records whose strict
   `BrainLineageEventScope` equals `request.scope` byte-for-byte and whose event
   type is registered as a metabolism replay input; persist their cursor-ordered
   IDs as `consumedEventIds`.

```ts
const parentCommitId = await repository.refs.get(request.branchRef);
if (parentCommitId === null) throw typedError('brain_ref_missing');
if (parentCommitId !== request.expectedParentCommitId) {
  throw typedError('metabolism_parent_mismatch');
}
const parent = await repository.commits.get(parentCommitId);
if (request.scope.basedOnBrainCommitId !== parentCommitId ||
    request.scope.targetRef !== request.branchRef) {
  throw typedError('metabolism_scope_mismatch');
}
const parentView = await livingBrain.materialize(parentCommitId);
const journalHighWatermark = await repository.journal.head();
if (request.leaseInput.resource !== `metabolism:${request.branchRef}`) {
  throw typedError('metabolism_lease_resource_mismatch');
}
const lease = await repository.leases.acquire(request.leaseInput);
const replayRange = {
  fromExclusive: parent.payload.journalRange.throughInclusive,
  throughInclusive: journalHighWatermark,
};
const consumedEventIds = await selectMetabolismReplayEventIds({
  repository,
  replayRange,
  exactScope: request.scope,
});
const attempt = MetabolismAttemptSchema.parse({
  schema: 'cosmo.metabolism-attempt.v1',
  attemptId: request.attemptId,
  branchRef: request.branchRef,
  parentCommitId,
  journalHighWatermark,
  replayRange,
  consumedEventIds,
  status: 'staging',
  leaseId: lease.leaseId,
  leaseEpoch: lease.epoch,
  fencingTokenHash: await sha256Text(lease.fencingToken),
  triggerDecisionObjectId: request.triggerDecisionObjectId,
  metabolismPolicyObjectId: request.metabolismPolicyObjectId,
  stageOutputs: [],
  sourceLayerIds: parentView.topology.layers.map((layer) => layer.layerId),
  sourceRootRefs: allNineRootRefs(parent.payload),
  preservedUnionWrapperObjectIds: unionWrapperIds(parentView),
  parentHeritageRoot: parent.payload.heritageRoot,
  startedAt: clock.now().toISOString(),
});
await attemptStore.appendBeforeStage(attempt, request.authorization);
```

The live fencing token remains in the caller's protected runtime state and is supplied to every mutation; only its hash is stored in the attempt object.
`allNineRootRefs()` returns the exact canonically ordered Epistemic, Question,
Topology, Program, Relationship, Activation, Negative Knowledge, Heritage, and
Artifact Index refs from the pinned parent. Attempt validation rejects a
missing, duplicate, reordered, or extra root ref.
Every `objects.put()` in the attempt and stage store receives the same validated `MutationAuthorization { actorIdentity, capabilityGrantId }`; no unauthenticated object-write overload exists.
The cursor interval is never membership authority. Replay loads only the
persisted `consumedEventIds`, re-verifies each record's cursor, type, and exact
scope, and rejects an ID that moved, disappeared, or became inadmissible.
Another branch's interleaved record remains absent even when its cursor lies
between two selected events.

- [ ] **Step 4: Implement content-addressed, input-bound stage reuse**

```ts
export async function runRecordedStage<I, O>(
  store: MetabolismStageStore,
  attempt: MetabolismAttempt,
  stage: MetabolismStageName,
  input: I,
  execute: (input: I) => Promise<O>,
): Promise<{ output: O; outputRef: ObjectRef; reused: boolean }> {
  const inputHash = await canonicalSha256(input);
  const recorded = await store.get(attempt.attemptId, stage);
  if (recorded !== null) {
    if (recorded.inputHash !== inputHash) {
      throw typedError('metabolism_stage_input_mismatch', { stage });
    }
    return {
      output: await store.readOutput<O>(recorded.outputRef),
      outputRef: recorded.outputRef,
      reused: true,
    };
  }
  const output = await execute(input);
  const outputRef = await store.writeOutput(stage, inputHash, output);
  await store.record(attempt.attemptId, stage, inputHash, outputRef);
  return { output, outputRef, reused: false };
}
```

A semantic stage with different input creates a new `attemptId`; it is never merged into the old attempt.

- [ ] **Step 5: Implement CAS-only publication and complete rollback**

Build all child roots in object storage, validate them, then call exactly one:

```ts
repository.commitAndAdvance({
  payload: childPayload,
  signatures: [],
  targetRef: request.branchRef,
  expectedHead: attempt.parentCommitId,
  actorIdentity: request.authorization.actorIdentity,
  capabilityGrantId: request.authorization.capabilityGrantId,
  lease: liveLeaseProof,
});
```

On failure, leave the ref unchanged, persist `rolled_back` or `conflicted`, release the lease, and keep unreachable staged objects available for bounded garbage collection and audit.

Wire this concrete runner into `CognitiveLifecycleEngine` through the Task 1 `MetabolismRunner` interface. Keep the Task 5 recording port only as a focused unit-test double; add an integration case where an E-owned `sleep_due` decision invokes the real runner and persists its exact attempt/receipt IDs before scheduling the next wake.

- [ ] **Step 6: Run focused and package tests**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/metabolism-runner.test.ts test/metabolism-faults.test.ts test/cognitive-lifecycle-engine.test.ts && npm test --workspace @cosmo/cognition`

Expected: PASS; late events are excluded, restart reuses outputs, stale fences fail, and concurrency yields one child.

- [ ] **Step 7: Commit**

```bash
git add packages/cognition/src/metabolism-store.ts \
  packages/cognition/src/metabolism-runner.ts packages/cognition/src/index.ts \
  packages/cognition/src/cognitive-lifecycle-engine.ts \
  packages/cognition/test/metabolism-runner.test.ts \
  packages/cognition/test/metabolism-faults.test.ts \
  packages/cognition/test/cognitive-lifecycle-engine.test.ts
git commit -m "feat(cognition): fence metabolism transactions"
```

## Task 7: Add reversible consolidation and contradiction discovery

**Files:**
- Create: `packages/cognition/src/stages/consolidate.ts`
- Create: `packages/cognition/src/stages/contradictions.ts`
- Create: `packages/cognition/test/metabolism-semantics.test.ts`
- Modify: `packages/cognition/src/metabolism-runner.ts`
- Modify: `packages/cognition/src/index.ts`

**Interfaces:**
- Consumes: pinned replay output, Living Brain roots, evidence/provenance links, and model-produced semantic proposals delivered through Program D runtime.
- Produces: `ConsolidationMapping[]`, `ContradictionCandidate[]`, and `ProvenanceGapCandidate[]`.

- [ ] **Step 1: Write failing reversibility and status-preservation tests**

```ts
test('consolidation preserves every original through explicit mappings', async () => {
  const result = applyConsolidationProposals(
    duplicateRepresentationFixture(),
    [{
      canonicalAddress: topologyAddress('parent_a', 'a'),
      sourceAddresses: [
        topologyAddress('parent_a', 'a'),
        topologyAddress('parent_b', 'b'),
      ],
      rationale: 'same scoped proposition and evidence identity',
    }],
  );
  assert.deepEqual(
    result.mappings[0],
    {
      canonicalAddress: topologyAddress('parent_a', 'a'),
      sourceAddresses: [
        topologyAddress('parent_a', 'a'),
        topologyAddress('parent_b', 'b'),
      ],
      reversible: true,
      rationale: 'same scoped proposition and evidence identity',
    },
  );
  assert.equal(
    result.addressableNodeKeys.has(
      brainObjectAddressKey(topologyAddress('parent_b', 'b')),
    ),
    true,
  );
});

test('topology rewriting cannot change epistemic status', () => {
  assert.throws(
    () => applyConsolidationProposals(contestedClaimFixture(), [{
      canonicalAddress: topologyAddress('parent_a', 'c'),
      sourceAddresses: [
        topologyAddress('parent_a', 'c'),
        topologyAddress('parent_b', 'd'),
      ],
      proposedStatus: 'supported',
      rationale: 'merged nodes appear stronger',
    }]),
    { code: 'metabolism_status_mutation_forbidden' },
  );
});

test('contradiction detection emits a proposal and preserves both claims', () => {
  const result = detectContradictions(opposedClaimFixture());
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0]?.claimAddresses, [
    topologyAddress('parent_a', 'e'),
    topologyAddress('parent_b', 'f'),
  ]);
  assert.equal(result.retainedAddressKeys.has(
    brainObjectAddressKey(topologyAddress('parent_a', 'e'))), true);
  assert.equal(result.retainedAddressKeys.has(
    brainObjectAddressKey(topologyAddress('parent_b', 'f'))), true);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/metabolism-semantics.test.ts --test-name-pattern='consolidation|contradiction'`

Expected: FAIL because the stage functions do not exist.

- [ ] **Step 3: Implement strict reversible mappings**

Accept consolidation only when:

- all source nodes exist in the pinned parent;
- the canonical node is one of the source nodes or a new candidate with `consolidated-from` edges to all originals;
- every original remains byte-identically addressable;
- claim status, evidence links, dissent, perspective, and negative knowledge are unchanged;
- no same-source member is treated as independent cross-parent corroboration; and
- mapping output includes `reversible: true`.

Reject a proposal carrying `proposedStatus`, missing ancestry, or deletion.

```ts
for (const proposal of proposals) {
  if ('proposedStatus' in proposal) {
    throw typedError('metabolism_status_mutation_forbidden');
  }
  const originals = proposal.sourceAddresses.map(
    (address) => requireNodeAtAddress(parent, address),
  );
  if (!proposal.sourceAddresses.some(
    (address) => sameBrainObjectAddress(address, proposal.canonicalAddress),
  )) {
    requireConsolidatedFromEdges(
      proposal.canonicalAddress,
      originals,
      stagedTopology,
    );
  }
  mappings.push({
    canonicalAddress: proposal.canonicalAddress,
    sourceAddresses: canonicalAddressSort(proposal.sourceAddresses),
    reversible: true,
    rationale: proposal.rationale,
  });
}
assertEveryNodeAddressableByFullAddress(parent.nodeIndexEntries, stagedGraph, mappings);
```

- [ ] **Step 4: Implement contradiction and provenance-gap candidates**

Contradiction detection can use explicit `opposes` edges, incompatible scoped claim values, or semantic proposals, but output remains:

```ts
type ContradictionCandidate = {
  candidate: CandidateFinding & {
    candidateType: 'contradiction_proposal';
    origin: 'dream' | 'principal' | 'specialist';
  };
  claimAddresses: [BrainObjectAddress, BrainObjectAddress];
  evidenceSpanIds: ObjectId[];
  method: 'explicit_edge' | 'scoped_value_conflict' | 'semantic_proposal';
};
```

Neither claim is discarded or reclassified by this stage.

- [ ] **Step 5: Run focused and package tests**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/metabolism-semantics.test.ts && npm test --workspace @cosmo/cognition`

Expected: PASS; every original remains reachable and contradiction discovery is candidate-only.

- [ ] **Step 6: Commit**

```bash
git add packages/cognition/src/stages/consolidate.ts \
  packages/cognition/src/stages/contradictions.ts \
  packages/cognition/src/metabolism-runner.ts packages/cognition/src/index.ts \
  packages/cognition/test/metabolism-semantics.test.ts
git commit -m "feat(cognition): add reversible consolidation"
```

## Task 8: Generate dream bridges, challenge them independently, and prepare incubation questions

**Files:**
- Create: `packages/cognition/src/stages/dream.ts`
- Create: `packages/cognition/src/stages/dream-structured-role-adapter.ts`
- Create: `packages/cognition/src/stages/challenge.ts`
- Modify: `packages/cognition/src/metabolism-runner.ts`
- Modify: `packages/cognition/test/metabolism-semantics.test.ts`
- Create: `packages/cognition/test/dream-structured-role-adapter.test.ts`
- Modify: `packages/cognition/src/index.ts`

**Interfaces:**
- Consumes: Program D `StructuredRoleExecutionInput`/`Port`/`Result`, exact
  `IndependentCandidateReviewExecutionInput`/`Attempt`/`Port`,
  `QuestionService.originate()`, E candidate journal/branch services, and C
  `ReviewLedger`.
- Produces: isolated reviewed dream candidate branches and inert
  dream-originated incubation-question drafts for normal post-wake
  acceptance.

```ts
export interface DreamGeneratorInput {
  schema: 'cosmo.dream-generator-input.v1';
  programId: ResearchProgramId;
  basedOnBrainCommitId: BrainCommitId;
  priorRegionAddresses: [LayerNodeAddress, LayerNodeAddress];
  allowedCandidateTypes: [
    'hypothesis',
    'question',
    'connection',
    'contradiction_proposal',
    'activation_proposal',
  ];
  execution: StructuredRoleExecutionInput;
  outputSchemaRef: ObjectRef;
  outputTrust: TrustDescriptor;
}

export interface DreamProposalAttempt {
  schema: 'cosmo.dream-proposal-attempt.v1';
  finding: CandidateFinding & {
    candidateType:
      | 'hypothesis'
      | 'question'
      | 'connection'
      | 'contradiction_proposal'
      | 'activation_proposal';
    origin: 'dream';
  };
  priorRegionAddresses: [LayerNodeAddress, LayerNodeAddress];
  bridgeRationale: string;
  expectedInformationGain: number;
  disconfirmingObservation: string;
  nextQuestion: string;
  parentQuestionIds: QuestionId[];
  generatorRunId: RunId;
  generatorIdentity: Sha256;
  runtimeReceiptRef: ObjectRef;
  outputSchemaRef: ObjectRef;
  outputRef: ObjectRef;
  outputHash: Sha256;
  executionClass: RuntimeReceipt['executionClass'];
  contextBundleId: ObjectId;
  completedAt: string;
}

export interface DreamGeneratorPort {
  generate(input: DreamGeneratorInput): Promise<DreamProposalAttempt>;
}

export interface PublishedDreamCandidate {
  schema: 'cosmo.published-dream-candidate.v1';
  candidateObjectRef: ObjectRef;
  finding: DreamProposalAttempt['finding'];
  admittedEventId: EventId;
  epistemicStatus: 'candidate';
  priorRegionAddresses: [LayerNodeAddress, LayerNodeAddress];
  bridgeRationale: string;
  expectedInformationGain: number;
  disconfirmingObservation: string;
  nextQuestion: string;
  parentQuestionIds: QuestionId[];
  generatorRunId: RunId;
  generatorIdentity: Sha256;
  runtimeReceiptRef: ObjectRef;
  executionClass: RuntimeReceipt['executionClass'];
  scope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
  candidateBranchReceiptRef: ObjectRef;
  candidateBranchReceipt: SemanticRoleCandidateBranchCommitReceipt;
  publishedAt: string;
}

export interface DreamChallengeResult {
  schema: 'cosmo.dream-challenge-result.v1';
  input: IndependentCandidateReviewExecutionInput;
  attempt: IndependentCandidateReviewAttempt;
  reviewRecorded: ReviewFindingRecording;
}

export interface DreamIncubationQuestionDraft {
  schema: 'cosmo.dream-incubation-question-draft.v1';
  wording: string;
  parentQuestionIds: QuestionId[];
  candidateEventId: EventId;
  reviewFindingRecordingRef: ObjectRef;
  reviewFindingEventId: EventId;
  evidenceSpanIds: ObjectId[];
  createdAt: string;
}

export interface DreamStageResult {
  schema: 'cosmo.dream-stage-result.v1';
  candidates: PublishedDreamCandidate[];
  challenges: DreamChallengeResult[];
  questionDraftRefs: ObjectRef[];
  questionDrafts: DreamIncubationQuestionDraft[];
}
```

Task 1 exports strict schemas for every E-owned object above and reuses D's
review schemas by identity. `DreamGeneratorInput.execution` contains the
already-stored Expedition ref/value, complete ContextBundle, owner RunId/start,
runtime plus mutation authorization, and idempotency key.
`DreamStructuredRoleAdapter` calls only the injected D
`StructuredRoleExecutionPort`, verifies output schema/trust against the
ContextBundle plan, strictly parses E's dream proposal output, and preserves
the returned output ref/hash and real runtime receipt. It never calls
`WorkerRuntime` or a provider SDK directly. Challenge has no E lookalike port:
the owner constructs D's exact `IndependentCandidateReviewExecutionInput`,
calls the injected D `IndependentCandidateReviewExecutionPort`, strictly
reparses its attempt, and records the proposal through C `ReviewLedger`. H
injects both concrete D ports. Tuple addresses are canonical and distinct; a
dream cannot refer to a merged node by bare ID.

- [ ] **Step 1: Write failing dream-status and reviewer-independence tests**

```ts
test('dream adapter consumes exact stored Expedition, Context, authority, and receipt', async () => {
  const d = recordingStructuredRoleExecutionPort();
  const adapter = new DreamStructuredRoleAdapter(d);
  const input = dreamGeneratorInputFixture();
  const attempt = await adapter.generate(input);
  assert.deepEqual(d.inputs, [input.execution]);
  assert.deepEqual(input.outputSchemaRef,
    input.execution.context.payload.executionPlan.outputSchemaRef);
  assert.deepEqual(input.outputTrust,
    input.execution.context.payload.executionPlan.outputTrust);
  assert.equal(attempt.generatorRunId, input.execution.runId);
  assert.deepEqual(attempt.runtimeReceiptRef,
    d.result.runtimeReceiptRecording.receiptRef);
  assert.deepEqual(attempt.outputRef, d.result.outputRef);
  assert.equal(attempt.outputHash, d.result.outputHash);
});

test('a dream bridge is journaled before selection and remains candidate', async () => {
  const harness = dreamHarness();
  const result = await runDreamStage(harness.input, harness.ports);
  assert.equal(result.candidates[0]?.finding.origin, 'dream');
  assert.equal(result.candidates[0]?.finding.candidateType, 'connection');
  assert.equal(result.candidates[0]?.epistemicStatus, 'candidate');
  assert.equal(
    harness.journal.indexOf(result.candidates[0]!.admittedEventId)
      < harness.selectionLog.indexOf(result.candidates[0]!.admittedEventId),
    true,
  );
  const closure = await harness.repository.commits.eventClosure(
    result.candidates[0]!.candidateBranchReceipt.candidateBrainCommitId,
  );
  assert.deepEqual(closure.directJournalEventIds,
    [result.candidates[0]!.admittedEventId]);
  assert.deepEqual(result.candidates[0]!.scope,
    result.candidates[0]!.candidateBranchReceipt.scope);
});

test('the generator cannot verify its own dream', async () => {
  const candidate = dreamCandidateFixture({ generatorRunId: 'run_generator' });
  await assert.rejects(
    () => challengeDreamCandidate(candidate, dreamChallengeResultFixture({
      attempt: independentCandidateReviewAttemptFixture({
        runId: 'run_generator',
        reviewerIdentity: candidate.generatorIdentity,
      }),
    })),
    { code: 'review_not_independent' },
  );
});

test('a challenged dream creates only an inert incubation-question draft during sleep', async () => {
  const result = await prepareDreamIncubationDraft(
    challengedDreamFixture({ finding: 'supports' }),
  );
  assert.equal(result.draft.schema,
    'cosmo.dream-incubation-question-draft.v1');
  assert.equal(result.draft.candidateEventId,
    result.candidate.admittedEventId);
  assert.equal(result.draft.reviewFindingEventId,
    result.challenge.reviewRecorded.eventId);
  assert.equal('questionId' in result.draft, false);
  assert.equal('originEventId' in result.draft, false);
  assert.equal(result.createdSupportedClaims, 0);
  assert.equal(result.questionServiceCalls, 0);
});

test('dream Question originates only after reviewed candidate acceptance', async () => {
  const fixture = await acceptedDreamQuestionFixture();
  const result = await fixture.originateAfterAcceptance();
  assert.equal(result.proposal.question.origin, 'dream');
  assert.equal(result.proposal.question.status, 'incubating');
  assert.equal(result.input.requestedByEventId,
    fixture.candidateAcceptanceReceipt.acceptanceEventId);
  assert.equal(result.input.eventScope.basedOnBrainCommitId,
    fixture.candidateAcceptanceReceipt.acceptedCanonicalCommitId);
  assert.equal(result.input.eventScope.targetRef, fixture.canonicalRef);
  assert.equal(
    result.acceptedQuestionMutation.previousBrainCommitId,
    fixture.candidateAcceptanceReceipt.acceptedCanonicalCommitId,
  );
});

test('dream stage recovers every semantic boundary without duplicate admission or review', async () => {
  for (const crashAfter of [
    'generator_attempt_stored',
    'candidate_admitted',
    'candidate_branch_committed',
    'review_attempt_stored',
    'review_recorded',
    'question_draft_stored',
  ] as const) {
    const harness = dreamHarness({ crashAfter });
    await assert.rejects(
      () => runDreamStage(harness.input, harness.ports),
      { code: 'fault_injected' },
    );
    await harness.reopen();
    const result = await runDreamStage(harness.input, harness.ports);
    assert.equal(harness.structuredRoleExecutions, 1);
    assert.equal(harness.candidateAdmissionCount, 1);
    assert.equal(harness.candidateCommitAdvanceSuccessCount, 1);
    assert.equal(harness.independentReviewExecutions, 1);
    assert.equal(harness.reviewFindingRecordingCount, 1);
    assert.equal(harness.questionDraftStoreCount, 1);
    assert.equal(
      result.challenges[0]!.input.candidateBrainCommitId,
      result.candidates[0]!.candidateBranchReceipt.candidateBrainCommitId,
    );
    assert.deepEqual(
      (await harness.repository.commits.eventClosure(
        result.candidates[0]!.candidateBranchReceipt.candidateBrainCommitId,
      )).directJournalEventIds,
      [result.candidates[0]!.admittedEventId],
    );
    assert.equal(await harness.canonicalHead(), harness.parentCommitId);
  }
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/metabolism-semantics.test.ts --test-name-pattern='dream'`

Expected: FAIL because dream and challenge stages are absent.

- [ ] **Step 3: Implement typed dream output**

Permit only `hypothesis`, `question`, `connection`,
`contradiction_proposal`, and `activation_proposal`.
`DreamStructuredRoleAdapter` validates the exact D structured-role input/result
and E output schema before any candidate write. Reject a dream payload with
candidate type `claim`, any supported-status request, no formation parents,
output/schema/trust drift, or a missing real runtime receipt.

Each bridge records:

```ts
{
  priorRegionAddresses: [leftAddress, rightAddress],
  bridgeRationale,
  expectedInformationGain,
  disconfirmingObservation,
  nextQuestion,
  candidateFinding,
  generatorRunId,
  generatorIdentity,
  runtimeReceiptRef,
  executionClass,
}
```

- [ ] **Step 4: Enforce independent challenge and question causality**

The runner calls `CandidateJournalPort.publish()` with the exact dream output
ref, `role:'consolidation_dream_generator'`, real attempt receipt/ContextBundle,
candidate-branch scope, causal parents, both authorizations, idempotency key,
and admitted time. It then commits the admission through
`CandidateBranchService` using the `semantic_role` origin; only that exact
candidate commit/ref/event may populate D's independent-review input. The D
review attempt must differ from the generator run and identity, receives only
the published candidate, pinned evidence, declared policy, graph parents, and
its own complete structured-role execution input, and has no promotion
authority. E maps its strict proposal/receipt into C
`RecordReviewFindingInput`; it does not invent a second challenge DTO or port.
During sleep, a qualifying challenge may store only a strict
`DreamIncubationQuestionDraft`; it cannot call `QuestionService` or admit a
Question event against the not-yet-canonical candidate. Sleep chronology is:

```text
dream candidate -> candidate branch commit -> review finding -> inert question draft
```

After wake, the normal D committed-review/Principal and E candidate-acceptance
transaction runs first. Only then may the lifecycle translate the stored draft
into Program D's exact `OriginateQuestionInput`, based on the accepted canonical
commit and requested by the E acceptance event, followed by E semantic-root
acceptance. No Principal or kernel promotion is implied by the draft.
The post-wake D `reviewCommittedCandidate()` input carries
`originKind:'semantic_role'`, the exact dream candidate receipt provenance, and
the same stored challenge execution input. Idempotent D/C recovery reuses the
already-stored attempt and ReviewFinding recording, adds the mandatory review
completion and Principal events, and never performs a second reviewer run.

```ts
const reviewInput = IndependentCandidateReviewExecutionInputSchema.parse({
  schema: 'cosmo.independent-candidate-review-execution-input.v1',
  subject: cognitiveCandidateSubject(publishedCandidate),
  candidateBrainCommitId:
    publishedCandidate.candidateBranchReceipt.candidateBrainCommitId,
  candidateBranchRef:
    publishedCandidate.candidateBranchReceipt.candidateBranchRef,
  candidateEventId: publishedCandidate.admittedEventId,
  expectedScope: canonicalReviewScopeBasedOnCandidate(
    publishedCandidate.candidateBranchReceipt,
  ),
  reviewerIdentity: challengerIdentity,
  reviewerRoleDefinitionRef: dreamChallengerRoleDefinitionRef,
  evidencePolicyId: evidencePolicy.evidencePolicyId,
  evidenceSpanIds: pinnedEvidence.map((item) => item.objectId),
  execution: challengerStructuredRoleExecutionInput,
});
const reviewAttempt = IndependentCandidateReviewAttemptSchema.parse(
  await independentCandidateReview.review(reviewInput),
);
assertIndependentAttempts(
  publishedCandidate.generatorRunId,
  publishedCandidate.generatorIdentity,
  reviewAttempt.receipt.runId,
  reviewAttempt.receipt.reviewerIdentity,
);
const reviewRecorded = await reviewLedger.record(
  recordDreamReviewFindingInput(reviewInput, reviewAttempt, corpusMutation),
);
const reviewFindingRecordingRef = await repository.objects.put(
  objectForReviewFindingRecording(reviewRecorded),
  input.mutationAuthorization,
);
const questionDraft = DreamIncubationQuestionDraftSchema.parse({
  schema: 'cosmo.dream-incubation-question-draft.v1',
  wording: publishedCandidate.nextQuestion,
  parentQuestionIds: publishedCandidate.parentQuestionIds,
  candidateEventId: publishedCandidate.admittedEventId,
  reviewFindingRecordingRef,
  reviewFindingEventId: reviewRecorded.eventId,
  evidenceSpanIds: pinnedEvidence.map((item) => item.objectId),
  createdAt: reviewRecorded.recordedAt,
});
const questionDraftRef = await repository.objects.put(
  objectForDreamQuestionDraft(questionDraft),
  input.mutationAuthorization,
);

// Only in the post-wake handler, after reviewed candidate acceptance:
const questionInput = OriginateQuestionInputSchema.parse(
  dreamOriginateQuestionInput({
    draft: questionDraft,
    sourceEventIds: [
      questionDraft.candidateEventId,
      questionDraft.reviewFindingEventId,
      candidateAcceptanceReceipt.acceptanceEventId,
    ],
    origin: 'dream',
    initialStatus: 'incubating',
    requestedByEventId: candidateAcceptanceReceipt.acceptanceEventId,
    expectedBrainCommitId:
      candidateAcceptanceReceipt.acceptedCanonicalCommitId,
    eventScope: canonicalScopeBasedOnAcceptedCandidate(
      candidateAcceptanceReceipt,
    ),
    authorization: postWakeMutationAuthorization,
    occurredAt: postWakeObservedAt,
  }),
);
const questionProposal = await questionService.originate(questionInput);
await cognitiveLifecycle.acceptSemanticRootMutation(
  questionAcceptanceInput(
    questionProposal,
    candidateAcceptanceReceipt.acceptedCanonicalCommitId,
  ),
);
```

`dreamOriginateQuestionInput()` is a typed post-wake builder that supplies every
other required frozen Program D field: semantic variants, prompt object,
human/Principal task-graph ref, why-it-matters text, domains, perspectives,
bounded surprise/uncertainty, human-interest value, and review/expiry times. It
accepts only declared typed overrides, uses no cast, and leaves
`OriginateQuestionInputSchema` as the final authority. The candidate admission,
C-owned `ReviewFindingRecording.eventId`, E acceptance event, and later
`Question.originEventId` are distinct durable events in that causal order. The
Program C `ReviewFinding` itself supplies neither an event ID nor a review
timestamp; E never reads nonexistent `review.eventId` or `review.reviewedAt`
fields.

Dream artifacts remain on their isolated candidate branches during the
metabolism transaction. The wake Brain commit neither selects their
candidate/review events nor copies their candidate roots. Its outside-the-Brain
`WakeBriefing` retains exact candidate-branch, structured-role, review-attempt,
review-recording, and Question-draft refs. After wake, the ordinary candidate →
committed review → Principal → E acceptance transaction may publish qualified
cognition; a subsequent D Question proposal → E semantic-root acceptance child
publishes the incubation Question. Crash recovery persists an intent before each of
generator result, candidate admission, candidate branch commit, D review
attempt, C review recording, and Question draft; replay reuses exact refs
and repeats no semantic execution or append.

- [ ] **Step 5: Run focused and package tests**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/metabolism-semantics.test.ts test/dream-structured-role-adapter.test.ts && npm test --workspace @cosmo/cognition`

Expected: PASS; a dream creates a durable candidate/question chain while factual status remains unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/cognition/src/stages/dream.ts \
  packages/cognition/src/stages/dream-structured-role-adapter.ts \
  packages/cognition/src/stages/challenge.ts \
  packages/cognition/src/metabolism-runner.ts packages/cognition/src/index.ts \
  packages/cognition/test/metabolism-semantics.test.ts \
  packages/cognition/test/dream-structured-role-adapter.test.ts
git commit -m "feat(cognition): make dreams causal candidates"
```

## Task 9: Add safe pruning, full validation, atomic wake, and exact briefing

**Files:**
- Create: `packages/cognition/src/stages/prune.ts`
- Create: `packages/cognition/src/stages/validate.ts`
- Create: `packages/cognition/src/stages/wake.ts`
- Modify: `packages/cognition/src/metabolism-runner.ts`
- Modify: `packages/cognition/test/metabolism-runner.test.ts`
- Modify: `packages/cognition/test/metabolism-faults.test.ts`
- Modify: `packages/cognition/src/index.ts`
- Create: `tests/vertical/union-cognition-metabolism.test.ts`

**Interfaces:**
- Consumes: staged roots and all prior stage outputs.
- Produces: validated `BrainCommitPayload`, atomic child commit, `MetabolismReceipt`, and `WakeBriefing`.

- [ ] **Step 1: Write failing pruning, object-accounting, and wake-diff tests**

```ts
test('pruning demotes a node without deleting it', () => {
  const target: TopologyNodeTarget = {
    scope: 'existing',
    address: topologyAddress('parent_a', 'a'),
  };
  const result = applyPruning(
    pruningFixture(),
    [{
      target,
      action: 'remove_from_default_retrieval',
      reason: 'noise',
    }],
  );
  assert.equal(result.activation.stateOf(target), 'dormant');
  assert.equal(result.retainedAddressKeys.has(
    brainObjectAddressKey(target.address),
  ), true);
  assert.equal(result.deletedObjectIds.length, 0);
});

test('pruning can propose but cannot perform candidate-branch archival', () => {
  const fixture = pruningFixture({ staleCandidateBranch: true });
  const result = applyPruning(fixture, fixture.proposals);
  assert.equal(result.candidateBranchArchivalProposals.length, 1);
  assert.equal(fixture.refMutationCalls, 0);
  assert.equal(fixture.branchStillExists(), true);
});

test('validation fails if any durable object class loses one member', async () => {
  const fixture = await stagedMetabolismFixture({
    removeOneNegativeKnowledgeObject: true,
  });
  await assert.rejects(
    () => validateStagedChild(fixture.input),
    { code: 'metabolism_object_accounting_failed' },
  );
});

test('wake briefing reports exact diffs and never becomes Brain input', async () => {
  const fixture = await metabolismFixture();
  const receipt = await fixture.runner().run(fixture.request);
  const briefing = await fixture.loadWakeBriefing(
    receipt.wakeBriefingObjectRef,
  );
  assert.equal(briefing.parentCommitId, fixture.parentCommitId);
  assert.equal(briefing.childCommitId, receipt.childCommitId);
  assert.deepEqual(briefing.diff.addedCandidateEventIds.sort(), [
    'evt_dream_1',
    'evt_question_1',
  ]);
  assert.equal(
    receipt.childReachableObjectIds.includes(
      receipt.wakeBriefingObjectRef.objectId,
    ),
    false,
  );
});

test('a nested union can sleep and wake without losing any parent layer', async () => {
  const fixture = await nestedUnionMetabolismFixture();
  const before = await fixture.livingBrain.materialize(fixture.unionCommitId);
  const receipt = await fixture.runner.run(fixture.request);
  const after = await fixture.livingBrain.materialize(receipt.childCommitId);

  assert.deepEqual(
    receipt.sourceLayerMappings.map((mapping) => mapping.sourceLayerId).sort(),
    before.topology.layers.map((layer) => layer.layerId).sort(),
  );
  assert.deepEqual(
    receipt.preservedUnionWrapperObjectIds.sort(),
    fixture.expectedUnionWrapperObjectIds.sort(),
  );
  for (const objectId of before.topology.reachableObjectIds) {
    assert.equal(receipt.childReachableObjectIds.includes(objectId), true);
  }
  assert.equal(
    after.nodeIndexEntries.length >= fixture.minimumRetainedNodeCount,
    true,
  );
  assert.equal(await fixture.queryNovelConnection(after), fixture.expectedConnectionId);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/metabolism-runner.test.ts test/metabolism-faults.test.ts --test-name-pattern='pruning|accounting|wake' && npm exec -- tsx --test tests/vertical/union-cognition-metabolism.test.ts`

Expected: FAIL because pruning, full validation, and wake output are absent.

- [ ] **Step 3: Implement layered pruning**

Support only:

```ts
type PruningAction =
  | 'remove_from_context'
  | 'lower_activation'
  | 'remove_from_default_retrieval'
  | 'consolidate_with_reversible_mapping';
```

Every pruning proposal names a complete `TopologyNodeTarget`; persisted
retention uses the canonical full `BrainObjectAddress` key. A local target must
resolve within the staged Topology set before its address key is finalized.
The result exposes `retainedAddressKeys`, never bare `retainedNodeIds`, and
Activation lookup is `stateOf(target)`.

Candidate-branch archival is not a `PruningAction`. The stage may place a
strict `CandidateBranchArchivalProposal` in the outside-the-Brain
`WakeBriefing`; a separately authorized, lease-fenced repository operation may
act on it later after verifying the expected candidate head. Metabolism never
mutates or deletes a candidate ref. Rights/privacy tombstoning remains Program
B's separately authorized trust transition and cannot be requested by
metabolism pruning.

- [ ] **Step 4: Implement whole-child reconciliation**

Before publication, account for every parent and staged:

- claim and hypothesis;
- question;
- edge;
- perspective and dissent;
- negative-knowledge object;
- candidate lineage;
- EvidenceSpan reference;
- Relationship/Program root;
- Intellectual Heritage root and every referenced curation event;
- artifact link;
- consolidation mapping;
- every source layer ID, source root, union wrapper, and leaf reachable-object ID; and
- every explicit `consumedEventId` selected for replay and every direct
  metabolism output event selected for the child; cursor intervals alone do
  not establish membership.

Verify rights do not broaden, statuses change only through a qualified Principal proposal, and every object reference resolves. When the parent contains union wrappers, each new materialized root descriptor links the exact parent wrapper root and all source leaf roots. `sourceLayerMappings` accounts for every attributed node/edge address; consolidation may add explicit cross-layer `consolidated-from` or `derived-from` mappings but never discard the original layer snapshot. This makes the child root closure retain the full pre-metabolism composite.

```ts
export async function validateStagedChild(
  input: StagedChildValidationInput,
): Promise<ValidatedStagedChild> {
  assertRightsNoBroader(input.parentTrust, input.childTrust);
  assertStatusTransitionsAuthorized(
    input.parentClaims,
    input.childClaims,
    input.principalDecisions,
  );
  assertReconciledIds('claim', input.parentClaimIds, input.childClaimIds);
  assertReconciledIds('question', input.parentQuestionIds, input.childQuestionIds);
  assertReconciledIds('edge', input.parentEdgeIds, input.childEdgeIds);
  assertReconciledIds(
    'negative_knowledge',
    input.parentNegativeKnowledgeIds,
    input.childNegativeKnowledgeIds,
  );
  await assertEveryObjectRefResolves(input.repository, input.allChildRefs);
  return Object.freeze({ ...input, validated: true });
}
```

- [ ] **Step 5: Implement exact owner-proposed wake output and CAS**

Wake does not synthesize another owner's root. It stages one exact Program C
Corpus mutation batch when Epistemic/Negative Knowledge changes, exact Program
D Question/Program/Relationship/Artifact proposals when those roots change,
and E-owned Topology/Activation proposals. Each proposal is stored, scoped to
`request.scope`, pinned to the parent/root it replaces, and validated through
its owner schema/codec. The metabolism transaction loads those stored proposals
and atomically accepts only their exact next roots; every untouched root is
carried byte-identically.

Append typed metabolism, consolidation, dream, pruning, acceptance, and wake
curation events, then create `childHeritageRoot` linking
`attempt.parentHeritageRoot` and those exact event IDs. The payload's direct
`journalEventIds` are only the cursor-ordered metabolism output/acceptance
events, all with `request.scope`; `attempt.consumedEventIds` remain a separate
replay-input list. Validate all nine roots, the exact scope, and direct event
closure before the Task 6 CAS. Write `WakeBriefing` as an artifact/receipt
object outside the child's Brain roots, with exact parent/child diff, mappings,
contradictions, dream questions, retained dissent, failed stages, open
questions, and any inert candidate-branch archival proposals.
The canonical-scope dream curation event is only a metabolism-stage summary
that links the briefing; it is not a dream candidate, review, or Question
event. Those remain in their isolated candidate-branch provenance and are
forbidden from the wake child's direct event list.

```ts
const childHeritageRoot = await repository.curation.createSnapshot({
  parentHeritageRoots: [attempt.parentHeritageRoot],
  curationEventIds: metabolismCurationEventIds,
  trust: stagedChild.parentHeritageTrust,
  authorization: request.authorization,
});
const validated = await validateStagedChild({
  ...stagedChild,
  payload: { ...stagedChild.payload, heritageRoot: childHeritageRoot },
});
const advance = await repository.commitAndAdvance({
  payload: validated.payload,
  signatures: [],
  targetRef: request.branchRef,
  expectedHead: attempt.parentCommitId,
  actorIdentity: request.authorization.actorIdentity,
  capabilityGrantId: request.authorization.capabilityGrantId,
  lease,
});
const wakeBriefing = WakeBriefingSchema.parse({
  schema: 'cosmo.wake-briefing.v1',
  parentCommitId: attempt.parentCommitId,
  childCommitId: advance.commitId,
  diff: await repository.diff(attempt.parentCommitId, advance.commitId),
  consolidationMappings,
  contradictionCandidateIds,
  dreamQuestionIds,
  dreamCandidateBranchReceiptRefs,
  dreamStructuredRoleReceiptRefs,
  dreamReviewAttemptRefs,
  dreamReviewFindingRecordingRefs,
  dreamQuestionDraftRefs,
  retainedDissentIds,
  failedStageNames,
  openQuestionIds,
  candidateBranchArchivalProposals,
});
await receiptStore.writeWakeBriefing(wakeBriefing, request.authorization);
```

After the CAS, construct `MetabolismReceipt` with `scope`,
`journalEventIds`, `journalRange`, and `consumedEventIds`, and require:

```ts
const closure = await repository.commits.eventClosure(receipt.childCommitId);
assert.deepEqual(closure.directJournalEventIds, receipt.journalEventIds);
assert.equal(
  receipt.journalEventIds.some((id) => receipt.consumedEventIds.includes(id)),
  false,
);
```

- [ ] **Step 6: Run focused and package tests**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/metabolism-runner.test.ts test/metabolism-faults.test.ts && npm exec -- tsx --test tests/vertical/union-cognition-metabolism.test.ts && npm test --workspace @cosmo/cognition`

Expected: PASS; pruning is reversible, reconciliation is total, and wake publication is atomic.

- [ ] **Step 7: Commit**

```bash
git add packages/cognition/src/stages/prune.ts \
  packages/cognition/src/stages/validate.ts packages/cognition/src/stages/wake.ts \
  packages/cognition/src/metabolism-runner.ts packages/cognition/src/index.ts \
  packages/cognition/test/metabolism-runner.test.ts \
  packages/cognition/test/metabolism-faults.test.ts \
  tests/vertical/union-cognition-metabolism.test.ts
git commit -m "feat(cognition): validate and wake atomically"
```

## Task 10: Freeze and pass the five-fixture paired sleep proof

**Files:**
- Create: `packages/cognition/src/paired-sleep-proof.ts`
- Create: `packages/cognition/test/paired-sleep-proof.test.ts`
- Create: `fixtures/contracts/metabolism/contradiction-bridge.json`
- Create: `fixtures/contracts/metabolism/dormant-resonance.json`
- Create: `fixtures/contracts/metabolism/duplicate-lineage.json`
- Create: `fixtures/contracts/metabolism/negative-knowledge.json`
- Create: `fixtures/contracts/metabolism/cross-domain-question.json`
- Modify: `packages/cognition/src/index.ts`

**Interfaces:**
- Consumes: same-parent control/treatment branch factory, frozen probes, and `MetabolismRunner`.
- Produces: `PairedSleepProof.run()` with structural guardrails and blind-comparison outcomes.

- [ ] **Step 1: Write the failing preregistered proof test**

```ts
test('treatment wins at least sixty percent without a guardrail breach', async () => {
  const proof = new PairedSleepProof({
    fixtureDir: new URL(
      '../../../../fixtures/contracts/metabolism/',
      import.meta.url,
    ),
    scorer: deterministicBlindScorer(),
  });
  // fixturePairCount deliberately does not reuse Program G's profile
  // identifier pairedTrialCount (candidate-vs-baseline replicates, exactly 3
  // at first release). G's live release bar for sleep_dream_cognitive_effect
  // is these same five fixtures times three replicates: fifteen preregistered
  // fixture-pairs, at least nine treatment wins, ties counting against.
  const result = await proof.run({
    fixturePairCount: 5,
    targetDimension: 'formation_trace_recall',
    minimumWinRate: 0.60,
    requireDreamOutcomeChain: true,
  });
  assert.equal(result.fixtureCount, 5);
  assert.equal(result.guardrailFailures.length, 0);
  assert.ok(result.nonTieWinRate >= 0.60);
  assert.equal(result.dreamOutcomeChainComplete, true);
  assert.equal(result.passed, true);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/paired-sleep-proof.test.ts`

Expected: FAIL because the proof runner and five fixtures do not exist.

- [ ] **Step 3: Add five immutable fixtures**

Generate each fixture manifest from its checked-in portable parent bundle:

```ts
const parentBundle = await readPortableFixtureBundle('cross-domain-question');
const fixture = MetabolismFixtureSchema.parse({
  schema: 'cosmo.metabolism-fixture.v1',
  fixtureId: 'cross-domain-question',
  parentBundleId: hashCanonical(parentBundle.manifestPayload),
  journalHighWatermark: '24',
  targetDimension: 'formation_trace_recall',
  probeIds: ['formation', 'contradiction', 'negative-knowledge'],
  expectedStructuralCounts: {
    claims: 4,
    questions: 2,
    negativeKnowledge: 1,
    perspectives: 2,
  },
  requiredOutcome: 'dream_question_explicitly_unresolved',
});
await writeCanonicalJson(
  'fixtures/contracts/metabolism/cross-domain-question.json',
  fixture,
);
```

The checked-in `parentBundleId` must equal the hash recomputed from the adjacent bundle during every test; a hand-authored repeated-character digest is forbidden. Use distinct exact counts and outcome for all five fixtures. Store the full portable parent bundle beside the manifest according to Program A fixture rules; do not read historical live paths during the proof.

- [ ] **Step 4: Implement control/treatment isolation and scoring**

For each fixture:

1. import the same parent bundle twice;
2. pin equal parent commit, high-water mark, corpus, runtime class, and budget;
3. leave the control branch unchanged;
4. run the declared metabolism policy on treatment;
5. execute the same frozen probes against both;
6. blind branch labels before scoring;
7. reject any structural, evidence, rights, provenance, or reversibility regression;
8. calculate wins only across non-ties; and
9. require one complete dream-to-outcome chain.

The deterministic Program E proof demonstrates mechanism and gate wiring. Program G later repeats it under the signed, nondeterministic `AcceptanceProfile`.

```ts
for (const fixture of fixtures) {
  const [control, treatment] = await importMatchedBranches(fixture);
  const treatmentReceipt = await metabolism.run(treatment.request);
  const controlProbe = await probe(control.commitId, fixture.probeIds);
  const treatmentProbe = await probe(
    treatmentReceipt.childCommitId,
    fixture.probeIds,
  );
  assertStructuralNonRegression(control, treatmentReceipt);
  comparisons.push(await scorer.compareBlinded(
    blindLabels(controlProbe, treatmentProbe),
  ));
}
const nonTies = comparisons.filter((result) => result.winner !== 'tie');
const wins = nonTies.filter((result) => result.winner === 'treatment').length;
return {
  fixtureCount: fixtures.length,
  nonTieWinRate: nonTies.length === 0 ? 0 : wins / nonTies.length,
  guardrailFailures,
  dreamOutcomeChainComplete: await hasDreamOutcomeChain(treatmentReceipts),
};
```

- [ ] **Step 5: Run the proof twice for determinism**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/paired-sleep-proof.test.ts && npm exec --workspace @cosmo/cognition -- tsx --test test/paired-sleep-proof.test.ts`

Expected: both runs PASS with identical proof receipt hashes.

- [ ] **Step 6: Commit**

```bash
git add packages/cognition/src/paired-sleep-proof.ts \
  packages/cognition/src/index.ts packages/cognition/test/paired-sleep-proof.test.ts \
  fixtures/contracts/metabolism/contradiction-bridge.json \
  fixtures/contracts/metabolism/dormant-resonance.json \
  fixtures/contracts/metabolism/duplicate-lineage.json \
  fixtures/contracts/metabolism/negative-knowledge.json \
  fixtures/contracts/metabolism/cross-domain-question.json
git commit -m "test(cognition): freeze paired sleep proof"
```

## Task 11: Pass the deterministic joint Program D+E vertical gate

**Files:**
- Create: `packages/cognition/src/candidate-transaction-store.ts`
- Create: `packages/cognition/src/candidate-branch-service.ts`
- Create: `packages/cognition/src/reviewed-cognitive-candidate-service.ts`
- Create: `packages/cognition/src/qualified-promotion-service.ts`
- Create: `packages/cognition/src/de-vertical-gate.ts`
- Create: `packages/cognition/test/candidate-branch-service.test.ts`
- Create: `packages/cognition/test/reviewed-cognitive-candidate-service.test.ts`
- Create: `packages/cognition/test/qualified-promotion-service.test.ts`
- Create: `tests/vertical/d-e-cognitive-flow.test.ts`
- Modify: `packages/cognition/src/index.ts`

**Interfaces:**
- Consumes: Program D `DEVerticalGateResearchPort`,
  `DeterministicConformanceRuntime`, and exact
  `IndependentCandidateReviewExecutionInput`; Program E
  `DEVerticalGateCognitionPort`, `DEVerticalGateMutationContext`, and
  `DEVerticalGateReviewContext`.
- Produces: concrete E-owned `CandidateBranchService`,
  `QualifiedPromotionService`, `runDEVerticalGate()`, and a receipt that can set
  `cosmoAccepted: true` only after every required link is present.

- [ ] **Step 1: Write failing candidate and qualified-promotion transaction tests**

```ts
test('one candidate child closes new claim, question, two nodes, edge, and activation without a child-id cycle', async () => {
  const fixture = await candidateTransactionFixture({
    newClaim: true,
    newQuestion: true,
    newTopologyNodeCount: 2,
    connectNewNodes: true,
    activateNewNode: true,
  });
  const receipt = await fixture.candidateBranches.commit(fixture.input);
  assert.equal(receipt.originKind, 'autonomous_research');
  if (receipt.originKind !== 'autonomous_research') {
    throw new Error('expected autonomous research receipt');
  }
  const commit = await fixture.repository.commits.get(
    receipt.candidateBrainCommitId,
  );
  assert.deepEqual(commit.payload.parentCommitIds, [fixture.parentCommitId]);
  assert.deepEqual(receipt.appliedRootKinds, [
    'epistemicRoot',
    'questionRoot',
    'topologyRoot',
    'activationRoot',
  ]);
  assert.equal(receipt.previousCandidateHead, null);
  assert.equal(fixture.commitAdvanceSuccessCount, 1);
  assert.equal(commit.payload.programRoot.objectId,
    fixture.parent.payload.programRoot.objectId);
  assert.equal(commit.payload.relationshipRoot.objectId,
    fixture.parent.payload.relationshipRoot.objectId);
  assert.equal(commit.payload.artifactIndexRoot.objectId,
    fixture.parent.payload.artifactIndexRoot.objectId);
  assert.deepEqual(receipt.scope, fixture.input.scope);
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(
      receipt.candidateBrainCommitId,
    )).directJournalEventIds,
    receipt.journalEventIds,
  );
  assert.deepEqual(receipt.journalEventIds,
    fixture.admissionEventIdsInCursorOrder);
  assert.deepEqual(receipt.researchReceiptRef,
    fixture.input.researchReceiptRef);
  assert.deepEqual(receipt.runtimeReceiptRefs,
    fixture.input.runtimeReceiptRefs);
  for (const ref of [
    receipt.researchReceiptRef,
    ...receipt.runtimeReceiptRefs,
  ]) {
    assert.equal(await fixture.candidateTopologyOrHeritageContains(
      receipt,
      ref.objectId,
    ), true);
  }

  const storedText = await fixture.decodedCandidateClosureText(receipt);
  assert.equal(storedText.includes(receipt.candidateBrainCommitId), false);
  const view = await fixture.livingBrain.materialize(
    receipt.candidateBrainCommitId,
  );
  assert.deepEqual(
    view.snapshot.topology.leaves[0]!.snapshot.researchReceiptRefs,
    [receipt.researchReceiptRef],
  );
  assert.deepEqual(
    view.snapshot.topology.leaves[0]!.snapshot.runtimeReceiptRefs,
    receipt.runtimeReceiptRefs,
  );
  assert.deepEqual(
    view.snapshot.topology.leaves[0]!.snapshot
      .committedCandidateReviewReceiptRefs,
    [],
  );
  assert.equal(view.nodeIndexEntries.filter(
    (entry) => entry.address.sourceCommitId === receipt.candidateBrainCommitId,
  ).length, 2);
  assert.equal(
    view.snapshot.activation.leaves[0]!.snapshot.entries[0]!.target.scope,
    'local',
  );
  assert.equal(
    view.edgeIndexEntries[0]!.edge.payload.from.scope,
    'local',
  );
  assert.equal(
    view.edgeIndexEntries[0]!.edge.payload.to.scope,
    'local',
  );
});

test('human Invent commits one candidate with draft/preview provenance and no fabricated runtime', async () => {
  const fixture = await humanInventCandidateTransactionFixture();
  assert.deepEqual(
    HumanInventCandidateBranchInputSchema.parse(fixture.input),
    fixture.input,
  );
  const receipt = await fixture.candidateBranches.commit(fixture.input);
  assert.equal(receipt.originKind, 'human_invent');
  if (receipt.originKind !== 'human_invent') {
    throw new Error('expected human Invent receipt');
  }
  assert.equal(receipt.admittedHumanOperationEventId,
    fixture.input.admittedHumanOperationEventId);
  assert.deepEqual(receipt.inventDraftRef, fixture.input.inventDraftRef);
  assert.deepEqual(receipt.inventPreviewRef, fixture.input.inventPreviewRef);
  assert.equal('researchReceiptRef' in receipt, false);
  assert.equal('runtimeReceiptRefs' in receipt, false);
  const commit = await fixture.repository.commits.get(
    receipt.candidateBrainCommitId,
  );
  assert.deepEqual(commit.payload.parentCommitIds,
    [fixture.input.parentCommitId]);
  assert.deepEqual(commit.payload.journalEventIds,
    fixture.admissionEventIdsInCursorOrder);
  assert.equal(commit.payload.journalEventIds.includes(
    fixture.input.admittedHumanOperationEventId,
  ), true);
  const view = await fixture.livingBrain.materialize(
    receipt.candidateBrainCommitId,
  );
  const topology = view.snapshot.topology.leaves[0]!.snapshot;
  assert.deepEqual(topology.researchReceiptRefs, []);
  assert.deepEqual(topology.runtimeReceiptRefs, []);
  assert.deepEqual(topology.humanInventDraftRefs,
    [fixture.input.inventDraftRef]);
  assert.deepEqual(topology.humanInventPreviewRefs,
    [fixture.input.inventPreviewRef]);
  assert.equal(fixture.dResearchReceiptLoadCalls, 0);
  assert.equal(fixture.runtimeReceiptLoadCalls, 0);
  assert.deepEqual(
    await fixture.candidateBranches.commit(fixture.input),
    receipt,
  );
  assert.equal(fixture.commitAdvanceSuccessCount, 1);
});

test('semantic role commits one candidate with exact attempt and output provenance', async () => {
  const fixture = await semanticRoleCandidateTransactionFixture({
    semanticRole: 'consolidation_dream_generator',
  });
  const receipt = await fixture.candidateBranches.commit(fixture.input);
  assert.equal(receipt.originKind, 'semantic_role');
  if (receipt.originKind !== 'semantic_role') {
    throw new Error('expected semantic-role receipt');
  }
  assert.deepEqual(receipt.attemptReceiptRef,
    fixture.input.attemptReceiptRef);
  assert.deepEqual(receipt.outputRef, fixture.input.outputRef);
  assert.deepEqual(receipt.outputSchemaRef, fixture.input.outputSchemaRef);
  const topology = (await fixture.livingBrain.materialize(
    receipt.candidateBrainCommitId,
  )).snapshot.topology.leaves[0]!.snapshot;
  assert.deepEqual(topology.semanticRoleAttemptRefs,
    [fixture.input.attemptReceiptRef]);
  assert.deepEqual(topology.runtimeReceiptRefs,
    [fixture.input.attemptReceiptRef]);
  assert.deepEqual(topology.researchReceiptRefs, []);
  assert.deepEqual(topology.humanInventDraftRefs, []);
  assert.equal(fixture.semanticAdmission.source.attemptReceiptRef.objectId,
    fixture.input.attemptReceiptRef.objectId);
  assert.deepEqual(fixture.semanticAdmission.scope, fixture.input.scope);
  assert.equal(fixture.commitAdvanceSuccessCount, 1);
});

test('candidate transaction rejects raw or forbidden-root smuggling', async () => {
  const fixture = await candidateTransactionFixture();
  for (const input of [
    { ...fixture.input, payload: fixture.parent.payload },
    { ...fixture.input, programRoot: objectRef('smuggled-program') },
    { ...fixture.input, relationshipRoot: objectRef('smuggled-relationship') },
    { ...fixture.input, activationRoot: objectRef('raw-activation') },
  ]) {
    await assert.rejects(
      () => fixture.candidateBranches.commit(input),
      { code: 'candidate_branch_input_invalid' },
    );
  }
  assert.equal(await fixture.candidateBranchHead(), null);
});

test('candidate intent recovers one absent-ref CAS after crash', async () => {
  const fixture = await candidateTransactionFixture({
    crashAfterCommitAdvanceBeforeReceipt: true,
  });
  await assert.rejects(
    fixture.candidateBranches.commit(fixture.input),
    { code: 'fault_injected' },
  );
  await fixture.reopen();
  const receipt = await fixture.candidateBranches.commit(fixture.input);
  const repeated = await fixture.candidateBranches.commit(fixture.input);
  assert.deepEqual(repeated, receipt);
  assert.equal(fixture.commitAdvanceSuccessCount, 1);
});

test('qualified promotion accepts the exact stored C record once', async () => {
  const fixture = await qualifiedPromotionFixture({
    crashAfterCanonicalAdvanceBeforeReceipt: true,
  });
  const committed = fixture.input.committedCandidateReviewReceipt;
  const transition = committed.claimTransitionDecisionRecording!;
  const requiredReviews =
    transition.record.decision.payload.requiredReviewFindingIds.map(
      (reviewFindingId) => committed.reviewFindingRecordings.find(
        (recording) =>
          recording.finding.reviewFindingId === reviewFindingId,
      )!,
    );
  const requiredReviewEventIdsInCursorOrder =
    await fixture.eventIdsInJournalCursorOrder(
      requiredReviews.map((recording) => recording.eventId),
    );
  await assert.rejects(
    fixture.promotions.commit(fixture.input),
    { code: 'fault_injected' },
  );
  await fixture.reopen();
  const receipt = await fixture.promotions.commit(fixture.input);
  assert.equal(receipt.claimTransitionDecisionId,
    transition.record.decision.claimTransitionDecisionId);
  assert.equal(receipt.claimTransitionDecisionEventId,
    transition.record.decisionEventId);
  assert.deepEqual(receipt.reviewScope, committed.reviewScope);
  assert.equal(
    await fixture.canonicalClaimStatus(fixture.claimId),
    transition.record.decision.payload.desiredStatus,
  );
  for (const ref of [
    transition.recordRef,
    transition.proposalRef,
    ...requiredReviews.map((recording) => recording.findingRef),
    ...requiredReviews.map((recording) => recording.qualificationRef),
    fixture.input.committedCandidateReviewReceiptRef,
    receipt.acceptedClaimTransitionRef,
  ]) {
    assert.equal(
      await fixture.canonicalEpistemicRootContains(ref.objectId),
      true,
    );
  }
  const accepted = await fixture.repository.commits.get(
    receipt.canonicalBrainCommitId,
  );
  assert.deepEqual(accepted.payload.parentCommitIds,
    [fixture.candidateBrainCommitId]);
  assert.deepEqual(fixture.canonicalRefUpdate, {
    previousHead: fixture.canonicalBaseCommitId,
    nextHead: receipt.canonicalBrainCommitId,
  });
  const closure = await fixture.repository.commits.eventClosure(
    receipt.canonicalBrainCommitId,
  );
  assert.deepEqual(closure.directJournalEventIds, [
    ...requiredReviewEventIdsInCursorOrder,
    transition.record.decisionEventId,
    committed.reviewCompletionRecording.eventId,
    committed.principalDecisionRecording.eventId,
    receipt.acceptanceEventId,
  ]);
  assert.equal(closure.directJournalEventIds.includes(
    committed.candidateEventId,
  ), false);
  assert.equal(closure.inheritedJournalEventIds.includes(
    committed.candidateEventId,
  ), true);
  assert.deepEqual(receipt.qualifiedReviewFindingIds,
    transition.record.decision.payload.requiredReviewFindingIds);
  assert.deepEqual(receipt.qualifiedReviewFindingRefs,
    requiredReviews.map((recording) => recording.findingRef));
  assert.deepEqual(receipt.reviewQualificationRefs,
    requiredReviews.map((recording) => recording.qualificationRef));
  assert.deepEqual(receipt.qualifiedReviewEventIds,
    requiredReviews.map((recording) => recording.eventId));
  assert.equal(receipt.reviewCompletedEventId,
    committed.reviewCompletionRecording.eventId);
  const acceptedTransition = await fixture.loadAcceptedClaimTransition(
    receipt.acceptedClaimTransitionRef,
  );
  assert.deepEqual(
    acceptedTransition.payload.committedCandidateReviewReceiptRef,
    fixture.input.committedCandidateReviewReceiptRef,
  );
  assert.deepEqual(acceptedTransition.payload.requiredReviewFindingRefs,
    requiredReviews.map((recording) => recording.findingRef));
  assert.deepEqual(acceptedTransition.payload.requiredReviewQualificationRefs,
    requiredReviews.map((recording) => recording.qualificationRef));
  const formation = await fixture.livingBrain.traceFormation(
    receipt.canonicalBrainCommitId,
    fixture.expectedClaimNodeAddress(receipt.canonicalBrainCommitId),
    { maxNodes: 40, maxEdges: 80, maxJournalRecords: 120 },
  );
  const orderedAcceptanceEvents = [
    committed.candidateEventId,
    ...requiredReviewEventIdsInCursorOrder,
    transition.record.decisionEventId,
    committed.reviewCompletionRecording.eventId,
    committed.principalDecisionRecording.eventId,
    receipt.acceptanceEventId,
  ];
  assert.deepEqual(
    formation.events
      .map((entry) => entry.eventId)
      .filter((eventId) => orderedAcceptanceEvents.includes(eventId)),
    orderedAcceptanceEvents,
  );
  assert.deepEqual(formation.researchReceiptRefs,
    [fixture.input.candidateBranchReceipt.researchReceiptRef]);
  assert.deepEqual(formation.runtimeReceiptRefs,
    fixture.input.candidateBranchReceipt.runtimeReceiptRefs);
  assert.deepEqual(formation.committedCandidateReviewReceiptRefs,
    [fixture.input.committedCandidateReviewReceiptRef]);
  assert.equal(formation.complete, true);
  assert.equal(fixture.commitAdvanceSuccessCount, 1);
  assert.deepEqual(await fixture.promotions.commit(fixture.input), receipt);
});

for (const candidateType of [
  'connection',
  'contradiction_proposal',
] as const) {
  test(`reviewed ${candidateType} enters canonical topology with full formation`, async () => {
    const fixture = await reviewedCognitiveCandidateFixture({ candidateType });
    const committed = fixture.input.committedCandidateReviewReceipt;
    const reviewEventIdsInCursorOrder =
      await fixture.eventIdsInJournalCursorOrder(
        committed.reviewFindingRecordings.map(
          (recording) => recording.eventId,
        ),
      );
    const receipt = await fixture.reviewedCandidates.accept(fixture.input);
    assert.equal(receipt.candidateType, candidateType);
    assert.deepEqual(receipt.reviewFindingRefs,
      committed.reviewFindingRecordings.map(
        (recording) => recording.findingRef,
      ));
    assert.deepEqual(receipt.reviewQualificationRefs,
      committed.reviewFindingRecordings.map(
        (recording) => recording.qualificationRef,
      ));
    assert.deepEqual(receipt.qualifiedReviewEventIds,
      committed.reviewFindingRecordings.map(
        (recording) => recording.eventId,
      ));
    assert.equal(receipt.reviewCompletedEventId,
      committed.reviewCompletionRecording.eventId);
    assert.equal(receipt.principalDecisionEventId,
      committed.principalDecisionRecording.eventId);
    assert.equal(receipt.desiredStatus,
      candidateType === 'connection' ? 'candidate' : 'contested');
    assert.equal(receipt.appliedRootKinds.includes('topologyRoot'), true);
    const accepted = await fixture.repository.commits.get(
      receipt.acceptedCanonicalCommitId,
    );
    assert.deepEqual(accepted.payload.parentCommitIds,
      [fixture.input.candidateBranchReceipt.candidateBrainCommitId]);
    assert.deepEqual(fixture.canonicalRefUpdate, {
      previousHead: fixture.input.expectedCanonicalHead,
      nextHead: receipt.acceptedCanonicalCommitId,
    });
    const closure = await fixture.repository.commits.eventClosure(
      receipt.acceptedCanonicalCommitId,
    );
    assert.deepEqual(closure.directJournalEventIds, [
      ...reviewEventIdsInCursorOrder,
      committed.reviewCompletionRecording.eventId,
      committed.principalDecisionRecording.eventId,
      receipt.acceptanceEventId,
    ]);
    assert.equal(closure.directJournalEventIds.includes(
      committed.candidateEventId,
    ), false);
    assert.equal(closure.inheritedJournalEventIds.includes(
      committed.candidateEventId,
    ), true);
    const trace = await fixture.livingBrain.traceFormation(
      receipt.acceptedCanonicalCommitId,
      fixture.expectedNodeAddress(receipt.acceptedCanonicalCommitId),
      { maxNodes: 40, maxEdges: 80, maxJournalRecords: 120 },
    );
    for (const eventId of [
      committed.candidateEventId,
      ...reviewEventIdsInCursorOrder,
      committed.reviewCompletionRecording.eventId,
      committed.principalDecisionRecording.eventId,
    ]) {
      assert.equal(trace.events.some((entry) => entry.eventId === eventId), true);
    }
    const expectedOrderedAcceptanceEvents = [
      committed.candidateEventId,
      ...reviewEventIdsInCursorOrder,
      committed.reviewCompletionRecording.eventId,
      committed.principalDecisionRecording.eventId,
      receipt.acceptanceEventId,
    ];
    assert.deepEqual(
      trace.events
        .map((entry) => entry.eventId)
        .filter((eventId) =>
          expectedOrderedAcceptanceEvents.includes(eventId)),
      expectedOrderedAcceptanceEvents,
    );
    assert.deepEqual(trace.researchReceiptRefs,
      [fixture.input.candidateBranchReceipt.researchReceiptRef]);
    assert.deepEqual(trace.runtimeReceiptRefs,
      fixture.input.candidateBranchReceipt.runtimeReceiptRefs);
    assert.equal(trace.committedCandidateReviewReceiptRefs.some(
      (ref) => canonicalObjectRefEqual(
        ref,
        fixture.input.committedCandidateReviewReceiptRef,
      ),
    ), true);
    assert.equal(trace.complete, true);
  });
}

test('reviewed human Invent cognition enters canonical topology without fake research provenance', async () => {
  const fixture = await humanInventReviewedCandidateFixture({
    candidateType: 'connection',
  });
  const committed = fixture.input.committedCandidateReviewReceipt;
  assert.equal(committed.originKind, 'human_invent');
  const receipt = await fixture.reviewedCandidates.accept(fixture.input);
  assert.equal(receipt.acceptedCanonicalCommitId.startsWith('sha256:'), true);
  assert.equal(await fixture.canonicalTopologyContains(
    fixture.input.candidateObjectRef.objectId,
  ), true);
  const trace = await fixture.livingBrain.traceFormation(
    receipt.acceptedCanonicalCommitId,
    fixture.expectedNodeAddress(receipt.acceptedCanonicalCommitId),
    { maxNodes: 40, maxEdges: 80, maxJournalRecords: 120 },
  );
  assert.deepEqual(trace.humanInventDraftRefs,
    [fixture.input.candidateBranchReceipt.inventDraftRef]);
  assert.deepEqual(trace.humanInventPreviewRefs,
    [fixture.input.candidateBranchReceipt.inventPreviewRef]);
  assert.deepEqual(trace.researchReceiptRefs, []);
  assert.deepEqual(trace.runtimeReceiptRefs, []);
  assert.equal(trace.events.some((entry) =>
    entry.eventId === committed.reviewCompletionRecording.eventId), true);
});

test('reviewed default-mode or dream cognition preserves semantic-role provenance', async () => {
  const fixture = await semanticRoleReviewedCandidateFixture({
    semanticRole: 'consolidation_dream_generator',
    candidateType: 'connection',
  });
  const receipt = await fixture.reviewedCandidates.accept(fixture.input);
  assert.equal(fixture.input.candidateBranchReceipt.originKind, 'semantic_role');
  assert.equal(
    fixture.input.committedCandidateReviewReceipt.originKind,
    'semantic_role',
  );
  const trace = await fixture.livingBrain.traceFormation(
    receipt.acceptedCanonicalCommitId,
    fixture.expectedNodeAddress(receipt.acceptedCanonicalCommitId),
    { maxNodes: 40, maxEdges: 80, maxJournalRecords: 120 },
  );
  assert.deepEqual(trace.semanticRoleAttemptRefs,
    [fixture.input.candidateBranchReceipt.attemptReceiptRef]);
  assert.deepEqual(trace.researchReceiptRefs, []);
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(
      receipt.acceptedCanonicalCommitId,
    )).directJournalEventIds,
    receipt.journalEventIds,
  );
});

test('qualified human Invent Claim uses the same review and Principal gate', async () => {
  const fixture = await humanInventQualifiedPromotionFixture();
  const receipt = await fixture.promotions.commit(fixture.input);
  assert.equal(fixture.input.candidateBranchReceipt.originKind, 'human_invent');
  assert.equal(
    fixture.input.committedCandidateReviewReceipt.originKind,
    'human_invent',
  );
  assert.equal(await fixture.canonicalClaimStatus(fixture.claimId),
    fixture.expectedStatus);
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(
      receipt.canonicalBrainCommitId,
    )).directJournalEventIds,
    receipt.journalEventIds,
  );
  assert.equal('researchReceiptRef' in fixture.input.candidateBranchReceipt,
    false);
});

test('a non-claim candidate cannot use a fake Claim transition decision or supported status', async () => {
  const fixture = await reviewedCognitiveCandidateFixture({
    candidateType: 'connection',
  });
  await assert.rejects(
    () => fixture.reviewedCandidates.accept({
      ...fixture.input,
      desiredStatus: 'supported',
      claimTransitionDecisionRecording: fakeClaimTransitionRecording(),
    }),
    { code: 'reviewed_cognitive_candidate_input_invalid' },
  );
});

test('review scope must target canonical ref and cannot cross candidates', async () => {
  const [candidateA, candidateB] =
    await interleavedReviewedCandidateFixtures();
  await assert.rejects(
    () => candidateA.reviewedCandidates.accept({
      ...candidateA.input,
      canonicalRef: candidateA.otherCanonicalRef,
    }),
    { code: 'committed_candidate_review_scope_mismatch' },
  );
  await assert.rejects(
    () => candidateB.reviewedCandidates.accept({
      ...candidateB.input,
      committedCandidateReviewReceiptRef:
        candidateA.input.committedCandidateReviewReceiptRef,
      committedCandidateReviewReceipt:
        candidateA.input.committedCandidateReviewReceipt,
    }),
    { code: 'committed_candidate_review_mismatch' },
  );
  assert.equal(candidateA.canonicalAdvanceCount, 0);
  assert.equal(candidateB.canonicalAdvanceCount, 0);
});
```

- [ ] **Step 2: Run the transaction tests and verify they fail**

Run: `npm exec --workspace @cosmo/cognition -- tsx --test test/candidate-branch-service.test.ts test/reviewed-cognitive-candidate-service.test.ts test/qualified-promotion-service.test.ts`

Expected: FAIL because the concrete transaction store/services do not exist.

- [ ] **Step 3: Implement closed, recoverable E transactions**

`CandidateBranchService.commit()` schema-parses the caller input before any
read, requires the candidate ref to be absent and the lease to fence that exact
ref, and loads every candidate/proposal object from Program B. Supplied decoded
values must be byte-identical to stored bytes. It then follows exactly one
origin branch:

- `autonomous_research`: `researchReceiptRef` decodes to the exact D
  `DEVerticalGateResearchReceipt` from which every admission and root proposal
  was built; `runtimeReceiptRefs` equals that receipt's complete canonical set,
  not a caller-selected subset, and every ref loads exact stored
  `RuntimeReceipt` bytes through D's `RuntimeReceiptSchema`; the transient
  `RuntimeReceiptRecording {receiptRef, receipt}` wrapper is never expected at
  that ref; or
- `human_invent`: `admittedHumanOperationEventId` resolves to exactly one
  admitted canonical journal record with the candidate scope, its payload
  links the exact `inventDraftRef` and consumed `inventPreviewRef`, both refs
  resolve, and the candidate origin is literal `human`. This branch rejects
  every research/runtime receipt field and never fabricates an autonomous run.
- `semantic_role`: `attemptReceiptRef` decodes to the exact real D
  `RuntimeReceipt` for the default-mode or dream proposal attempt, and role,
  ContextBundle, output schema/ref,
  candidate bytes, admission event source, scope, and execution identity all
  agree. This branch rejects both DE research and human-Invent fields.

Each admission event must already
exist in the admitted journal, name the exact candidate ref/hash, and fall
inside the child journal range E derives. Each root proposal must pin the parent
commit and exact previous root. E permits only:

- at most one C batch recording, whose exact stored inner Epistemic and optional
  Negative Knowledge proposal objects/refs match the supplied decoded
  recordings; its new claim/evidence/corpus/negative objects close and the
  corpus-snapshot change equals its decoded next Epistemic root;
- a D Question mutation whose exact question/update/event agree;
- an E Topology proposal whose additions decode, preserve every parent member,
  and originate in the admitted candidates; and
- an E Activation proposal whose local/existing targets resolve against the
  staged Topology set and pinned policy receipts.

E loads the parent and constructs the child payload itself. It copies all
untouched roots, Principal/kernel/schema versions, and trust byte-identically;
applies only verified closed proposals; derives `corpusSnapshotIds` from the
accepted Epistemic root; gives the candidate payload the sole parent
`input.parentCommitId`; creates a Heritage snapshot from the parent Heritage
plus typed admission events; appends exactly the selected origin's autonomous
research/runtime refs, human Invent draft/preview refs, or semantic-role
attempt receipt to `semanticRoleAttemptRefs` and `runtimeReceiptRefs` (whose
recursive closure reaches its ContextBundle and output refs); and sets direct
`journalEventIds` to only those
cursor-ordered admission events. Every one has exactly `input.scope`, whose
`basedOnBrainCommitId` equals the parent and whose target is the candidate ref.
It verifies all nine roots, direct event closure, and the mechanical cross-root
validator; then performs one
`commitAndAdvance(expectedHead: null)` on the absent candidate ref. Local
object refs are resolved within the staged root set and final child addresses
are attached only after hashing. Existing targets keep their full attributed
addresses, including cross-layer edges.

`CandidateTransactionStore` writes a canonical intent before root staging and
indexes it by `(candidateBranchRef, parentCommitId, idempotencyKey)`. It records
staged refs, CAS result, and the stored receipt payload. Restart checks the ref
and Program B transaction receipt before retrying; it returns the same decoded
receipt and never emits a second child. Receipt stored payload omits
`candidateBranchCommitReceiptId`; the wrapper attaches its object ID. Its strict
receipt union echoes only the selected origin's provenance fields. Formation
Trace reaches those same refs through the committed Topology closure; neither a
journal cursor range nor the candidate receipt alone substitutes for those
durable links.

`ReviewedCognitiveCandidateService.accept()` is the canonical path for
non-claim cognition. It accepts only the D `cognitive_status` disposition
branch: hypothesis, connection, contradiction, activation, Negative Knowledge,
or question. The candidate-branch receipt and D committed-review receipt must
have the same `originKind` and exact origin-specific provenance. An
`autonomous_research` pair must agree on its research receipt; a `human_invent`
pair must agree on admitted human operation event, Invent draft, and consumed
preview refs and must contain no research receipt; and a `semantic_role` pair
must agree on role, attempt receipt, ContextBundle, and output refs.
All three origins enter the same
post-commit independent review, Principal disposition, and E acceptance gates;
human guidance never substitutes for review and autonomous provenance is never
fabricated. The candidate, exact candidate ref/event, C-owned
`ReviewFindingRecording[]`, their exact qualification refs, D's distinct
`reviewCompletionRecording`, and `PrincipalDecisionRecording` come from the stored
`DECommittedCandidateReviewReceipt`; E accepts no reconstructed
authority-bearing D disposition input or parallel review/Principal DTOs. It
byte-verifies that receipt/ref, the separately supplied candidate object/ref,
and the candidate membership in the branch receipt. The stored receipt's
`disposition` is the sole disposition authority. It rejects Claim candidates,
`supported`/`disconfirmed`
status, fake C Claim-transition records, self-review, and a worker-selected
canonical status.
The closed disposition/root table is:

| Candidate | Allowed status | Exact canonical root path |
|---|---|---|
| hypothesis / connection | candidate, contested, incubating | verified Topology additions |
| contradiction | contested, incubating | verified Topology additions, both sides retained |
| activation | candidate, dormant, revived | verified Activation proposal with resolvable targets |
| Negative Knowledge | candidate, contested | exact stored C batch Negative Knowledge proposal |
| question | candidate, incubating, dormant, revived | exact stored D Question mutation |

The service stores an acceptance intent before acting, loads all stored bytes,
and requires: candidate commit's sole parent equals
`expectedCanonicalHead`; `reviewScope.basedOnBrainCommitId` equals the
candidate commit; `reviewScope.targetRef` equals `canonicalRef`; and
program/lineage/trust equal the candidate admission scope. Every finding
recording, the distinct review-completion event, Principal event, and acceptance
event carries that exact review scope. Review qualifications are immutable
objects referenced by the recordings, not separate journal events. A
canonical-ref mismatch or Candidate A receipt applied to Candidate B fails
before writes.

It selects only the reviewed candidate's proposal members and starts from the
candidate commit's nine roots—not the older canonical base. The accepted
canonical commit's sole parent is the candidate commit, while the one fenced
CAS advances `canonicalRef` from `expectedCanonicalHead` to that descendant.
Direct `journalEventIds` contain only the canonical-scope finding-recording
events, distinct review-completion event, Principal event, and acceptance event
in cursor order. Candidate admission is
inherited through the candidate parent and is forbidden from the direct list.
The service appends `committedCandidateReviewReceiptRef` to the Topology
provenance set; it preserves the already-committed autonomous research/runtime
refs or human Invent draft/preview refs according to the origin discriminator,
derives Heritage from those direct events, preserves every
untouched candidate root byte-identically, validates all nine roots and exact
event closure, and CAS-advances once. Its acceptance journal payload is the
strict E `CognitionAcceptanceJournalEvent` with
`eventType:'reviewed_cognitive_candidate_accepted'`,
`acceptedClosureRef:null`, and the exact candidate/review receipt refs. Its
receipt's finding refs,
qualification refs, and finding event IDs are same-length and ordered exactly
as the stored D receipt; `reviewCompletedEventId` is sourced only from
`reviewCompletionRecording.eventId`, and mandatory
`principalDecisionEventId` echo the two later distinct events.
Restart/replay returns one receipt. Candidate, contested, or incubating status
does not imply factual support. Full Formation Trace retains the candidate,
research/runtime receipts, complete challenge receipt and events, Principal
recording, root proposal, and canonical commit.

`QualifiedPromotionService.commit()` first persists the complete strict input
and recovery intent. It loads and byte-verifies the candidate-branch receipt,
the exact stored `DECommittedCandidateReviewReceipt`, the separately supplied
candidate object/ref, and candidate membership in the branch receipt. From the
single D receipt it obtains the authoritative disposition, C
`ClaimTransitionDecisionRecording` and its record/proposal refs, the exact
C-owned `ReviewFindingRecording[]`, D's distinct
`reviewCompletionRecording`, and D
`PrincipalDecisionRecording`; no caller-supplied parallel record/ref/value is
accepted. It reloads every referenced object and requires byte identity. It
requires the candidate and committed-review receipt to share the exact
origin-specific provenance discriminator: research receipt for
`autonomous_research`, admitted operation plus draft/preview refs for
`human_invent`, or role/attempt-receipt/context/output refs for
`semantic_role`, never a mixture. It
requires one allowed desired transition and the complete ordered set selected
by `requiredReviewFindingIds`; every selected recording has a
`claim_revision` subject matching the candidate's proposed revision, is
independently qualified, and
`principalDecision.action === 'propose_claim_transition'`. It applies only the
recording's exact inert `EpistemicRootUpdateProposal`; the proposed
ClaimRevision and decision ref must be in its exact closure. It also promotes only the
selected candidate's verified Topology additions from the candidate receipt, so
formation remains queryable in the canonical Brain. Epistemic, Topology, and
Heritage therefore change; the other six roots are byte-preserved. Before
building the root, E stores `AcceptedClaimTransitionPayload` containing the
exact candidate receipt and committed-review receipt, C
record/decision/proposal/revision, ordered review/qualification arrays,
Principal, candidate-admission event, ordered finding events, distinct
Claim-decision event, review-completion event, and Principal event. The accepted
Epistemic root is mechanically the C proposed root plus the C record ref, C
proposal ref, every required ReviewFinding ref, every required
ReviewQualification ref, and E accepted-transition ref in their canonical
arrays; the C proposal never
self-references.
E then stores a strict `CognitionAcceptanceJournalEvent` with
`eventType:'claim_transition_accepted'`, the candidate/review receipt refs, and
`acceptedClosureRef` equal to that C accepted-transition object before journal
append.

The same descendant publication invariant applies: the candidate's sole parent
is the expected canonical base; the acceptance commit's sole parent is the
candidate; Program B CAS advances canonical base to accepted descendant.
`reviewScope` targets the canonical ref, is based on the candidate, and copies
program/lineage/trust from candidate scope. Finding-recording,
Claim-decision, review-completion, Principal, and acceptance events all carry
that exact scope. Direct `journalEventIds` have one frozen order: all required
finding-recording events sorted by their unique resolved Program B journal
cursor, the Claim-transition decision event, the distinct review-completion
event, the Principal event, then the acceptance event. C's
`requiredReviewFindingIds` and accepted-transition review arrays remain in
semantic decision order; E never assumes that order equals cursor order. D
must have admitted every required finding before the Claim decision, so a
cursor interleaving that violates the phase order fails closed. The accepted
Topology provenance set appends
`committedCandidateReviewReceiptRef`, while the C accepted-transition object
retains the same ref in Epistemic closure. Candidate admission appears only in inherited event
closure and cannot be selected again. E validates root closure, event ordering,
scope, direct/inherited event closure, and all nine roots before one CAS. Crash
recovery is identical to candidate creation. Receipt payload omits its self ID;
the wrapper attaches it.

The production `DEVerticalGateCognitionPort` is an adapter over these two real
services plus the real Metabolism runner and Living Brain. Vertical tests may
inject repositories/runtimes/faults, but may not substitute a fixture
implementation for candidate or promotion commits.

- [ ] **Step 4: Write the failing full-chain gate**

```ts
test('deterministic D+E gate proves autonomous cognition through wake and trace', async () => {
  const harness = await createDEVerticalHarness({
    runtime: new DeterministicConformanceRuntime(
      scriptedAutonomousResearchEvents(),
    ),
    input: {
      ...verticalGateInput(),
      runtimeAdapter: 'deterministic',
      forceRestartAfterEnvelopeSequence: 3,
      forceContextTurnover: true,
      injectLateFencedEvent: true,
    },
    raceMetabolismAttempts: true,
  });
  try {
    const receipt = await runDEVerticalGate(harness.input);
    assert.equal(receipt.cosmoAccepted, true);
    assert.equal(receipt.blockedOn, null);
    assert.equal(receipt.researchReceipt.promptProvenance.origin, 'default_mode');
    assert.equal(
      receipt.researchReceipt.promptProvenance.originAttestation.payload.classification,
      'autonomous',
    );
    assert.equal(receipt.researchReceipt.expeditionId.startsWith('exp_'), true);
    assert.equal(receipt.researchReceipt.endingCorpusSnapshotId.startsWith('sha256:'), true);
    assert.ok(receipt.researchReceipt.researchToolReceiptIds.length > 0);
    assert.ok(receipt.researchReceipt.acquiredSourceObjectIds.length > 0);
    assert.ok(receipt.researchReceipt.evidenceSpanIds.length > 0);
    assert.equal('reviewFindingIds' in receipt.researchReceipt, false);
    assert.ok(
      receipt.committedCandidateReviewReceipt
        .reviewFindingRecordings.length > 0,
    );
    assert.equal(receipt.researchReceipt.discoveryProposalCreditedAsEvidence, false);
    assert.equal(receipt.researchReceipt.toolReceiptCreditedAsEvidence, false);
    assert.equal(receipt.candidateBranchCommitId.startsWith('sha256:'), true);
    assert.ok(receipt.qualifiedReviewFindingIds.length > 0);
    assert.equal(receipt.qualifiedReviewFindingIds.every(
      (reviewFindingId) => reviewFindingId.startsWith('review_'),
    ), true);
    assert.equal(receipt.claimTransitionDecisionId.startsWith('sha256:'), true);
    assert.equal(receipt.claimTransitionDecisionEventId.startsWith('evt_'), true);
    assert.notEqual(
      receipt.claimTransitionDecisionEventId,
      receipt.claimTransitionRequestedByEventId,
    );
    assert.equal(
      receipt.committedCandidateReviewReceipt
        .principalDecisionRecording.decision.decisionId
        .startsWith('sha256:'),
      true,
    );
    assert.equal(receipt.principalPromotionAction, 'propose_claim_transition');
    assert.equal(receipt.wakeBrainCommitId.startsWith('sha256:'), true);
    assert.equal(receipt.formationTrace.complete, true);
    const formationEventIds = receipt.formationTrace.events.map(
      (entry) => entry.eventId,
    );
    for (const eventId of [
      receipt.admittedCandidateEventId,
      ...receipt.qualifiedReviewEventIds,
      receipt.reviewCompletedEventId,
      receipt.principalDecisionEventId,
      receipt.claimTransitionDecisionEventId,
    ]) {
      assert.equal(formationEventIds.includes(eventId), true);
    }
    const qualifiedReviewEventIdsInCursorOrder =
      await harness.eventIdsInJournalCursorOrder(
        receipt.qualifiedReviewEventIds,
      );
    const expectedOrderedReviewEvents = [
      ...qualifiedReviewEventIdsInCursorOrder,
      receipt.claimTransitionDecisionEventId,
      receipt.reviewCompletedEventId,
      receipt.principalDecisionEventId,
    ];
    assert.deepEqual(
      formationEventIds.filter(
        (eventId) => expectedOrderedReviewEvents.includes(eventId),
      ),
      expectedOrderedReviewEvents,
    );
    const canonicalClosure =
      await harness.repository.commits.eventClosure(
        receipt.canonicalBrainCommitId,
      );
    for (const eventId of receipt.qualifiedReviewEventIds) {
      assert.equal(
        canonicalClosure.directJournalEventIds.includes(eventId),
        true,
      );
    }
    assert.deepEqual(
      canonicalClosure.directJournalEventIds.filter(
        (eventId) => expectedOrderedReviewEvents.includes(eventId),
      ),
      expectedOrderedReviewEvents,
    );
    assert.deepEqual(receipt.formationTrace.researchReceiptRefs,
      [receipt.researchReceiptRef]);
    assert.deepEqual(receipt.formationTrace.runtimeReceiptRefs,
      receipt.researchReceipt.runtimeReceiptRefs);
    assert.deepEqual(
      receipt.formationTrace.committedCandidateReviewReceiptRefs,
      [receipt.committedCandidateReviewReceiptRef],
    );
    assert.equal(
      receipt.formationTrace.nodes.every(
        (entry) => entry.address.rootKind === 'topologyRoot',
      ),
      true,
    );
    assert.equal(
      receipt.formationTrace.edges.every(
        (entry) => entry.address.rootKind === 'topologyRoot',
      ),
      true,
    );
    assert.equal(receipt.researchReceipt.lateFencedEventRejected, true);
    assert.equal(receipt.canonicalMetabolismChildren, 1);
    assert.equal(receipt.researchReceipt.forcedRestartObserved, true);
    assert.equal(receipt.researchReceipt.contextTurnoverObserved, true);
    assert.equal(harness.commitQualifiedPromotionCalls, 1);
    assert.equal(
      harness.runtimeReceipts.every(
        (runtimeReceipt: RuntimeReceipt) =>
          runtimeReceipt.executionClass === 'deterministic_conformance',
      ),
      true,
    );
  } finally {
    await harness.cleanup();
  }
});
```

- [ ] **Step 5: Run the full-chain test and verify it fails**

Run: `npm exec -- tsx --test tests/vertical/d-e-cognitive-flow.test.ts`

Expected: FAIL because the joint gate has not been composed.

- [ ] **Step 6: Compose the exact mandatory flow**

`runDEVerticalGate()` must prove, in order:

```text
specialist/default-mode/dream-originated Question
  -> prompt provenance proves autonomous origin
  -> bounded ExpeditionContract
  -> admitted CandidateFinding
  -> D candidate research receipt stops before review/Principal
  -> candidate-only branch commit
  -> D reviews the exact committed candidate
  -> qualified ReviewFinding recording
  -> Claim transition decision where applicable
  -> Principal disposition
  -> E accepts the exact committed-review receipt
  -> canonical BrainCommit
  -> metabolism transaction
  -> wake BrainCommit
  -> read-only pinned formation trace
```

The gate first stores D's candidate-phase receipt, calls the concrete E
candidate transaction exactly once, then asks D
`reviewCommittedCandidate()` about that exact committed candidate. It stores
the returned `DECommittedCandidateReviewReceipt` and only then calls the
matching E acceptance path exactly once. For the Claim fixture that is
`commitQualifiedPromotion()`. The frozen E input carries the exact candidate
receipt/ref, exact committed-review receipt/ref (the sole disposition
authority), canonical
ref/expected base, authority, lease, time, and idempotency key—no duplicated C,
review, qualification, or Principal fields. The production port reloads and
verifies every ref inside the two receipts and refuses an unqualified,
mismatched, wrong-branch, or wrong-scope promotion before Program B CAS.
Every mutating D/E call receives `input.mutationAuthorization` explicitly and
an operation-specific key derived from `input.idempotencyKey`;
`DEVerticalGateMutationContext` supplies only the canonical ref/head and lease,
never ambient mutation authority or a fresh unrelated idempotency identity.
`DEVerticalGateReviewContext` supplies the complete, already-stored,
independent D review executions, including their distinct RunIds,
ContextBundles, role identities, authorities, times, and idempotency keys.
The gate validates at least one input and exact candidate/scope/policy pins; it
does not manufacture reviewer identity, context, authority, or time.

The gate fails if any ID is inferred, any event precedes its durable journal
append, D reviews before the candidate commit, the worker promotes its own
output, candidate parentage is skipped, the distinct Claim-transition decision
event is absent, the qualified review/Principal decision is missing, or the
formation trace is first created after the wake query.

```ts
const researchReceipt =
  await researchPort.runCandidateResearchPhase(input);
const researchReceiptRef =
  await receiptStore.putResearchReceipt(researchReceipt);

const candidateBranchReceipt =
  await cognitionPort.commitCandidateBranch(
    candidateBranchInputFrom({
      researchReceiptRef,
      researchReceipt,
      runtimeReceiptRefs: researchReceipt.runtimeReceiptRefs,
      mutationContext,
      authorization: input.mutationAuthorization,
      idempotencyKey: deriveSubkey(
        input.idempotencyKey,
        'candidate-branch',
      ),
    }),
  );
const candidateBranchReceiptRef =
  await receiptStore.putCandidateBranchReceipt(candidateBranchReceipt);

const committedCandidateReviewReceipt =
  await researchPort.reviewCommittedCandidate({
    schema: 'cosmo.de-committed-candidate-review-input.v1',
    originKind: 'autonomous_research',
    researchReceiptRef,
    researchReceipt,
    candidateBrainCommitId:
      candidateBranchReceipt.candidateBrainCommitId,
    candidateBranchRef: candidateBranchReceipt.candidateBranchRef,
    canonicalTargetRef: mutationContext.canonicalRef,
    candidateBranchReceiptRef,
    candidateRef: selectedCandidate.candidateRef,
    candidateEventId: selectedCandidate.event.eventId,
    independentReviewInputs: reviewContext.independentReviewInputs,
    evidencePolicyId: input.evidencePolicyId,
    principalVersion: input.principalVersion,
    authorization: input.mutationAuthorization,
    idempotencyKey: deriveSubkey(
      input.idempotencyKey,
      'committed-review',
    ),
    reviewedAt: clock.now().toISOString(),
  });
const committedCandidateReviewReceiptRef =
  await receiptStore.putCommittedReviewReceipt(
    committedCandidateReviewReceipt,
  );

const promotionReceipt = await cognitionPort.commitQualifiedPromotion({
  schema: 'cosmo.qualified-promotion-commit-input.v1',
  candidateBranchReceiptRef,
  candidateBranchReceipt,
  committedCandidateReviewReceiptRef,
  committedCandidateReviewReceipt,
  candidateObjectRef: selectedCandidate.candidateRef,
  candidate: selectedCandidate.candidate,
  canonicalRef: mutationContext.canonicalRef,
  expectedCanonicalHead: mutationContext.expectedCanonicalHead,
  idempotencyKey: deriveSubkey(input.idempotencyKey, 'qualified-promotion'),
  requestedAt: clock.now().toISOString(),
  authorization: input.mutationAuthorization,
  lease: await mutationContext.acquireCanonicalLease(),
});
const canonicalBrainCommitId = promotionReceipt.canonicalBrainCommitId;
```

- [ ] **Step 7: Include all continuity faults in the same gate**

Force:

- runtime restart after admitted candidate output;
- model-context turnover before the challenge;
- one post-cancellation late event with an expired fencing token;
- two simultaneous metabolism attempts; and
- a read-only formation trace after wake.

The exact Brain commit and journal prefix before restart must survive. The late event remains only in operational audit, and one metabolism contender receives a typed conflict.

```ts
const receipt = await runDEVerticalGate({
  researchPort,
  cognitionPort,
  input,
  mutationContext,
  reviewContext,
  faultPolicy: {
    forceRestartAfterEnvelopeSequence: input.forceRestartAfterEnvelopeSequence,
    forceContextTurnover: input.forceContextTurnover,
    injectLateFencedEvent: input.injectLateFencedEvent,
    simultaneousMetabolismAttempts: 2,
  },
});
assert.equal(receipt.researchReceipt.lateFencedEventRejected, true);
assert.equal(receipt.canonicalMetabolismChildren, 1);
assert.equal(receipt.formationTrace.complete, true);
```

- [ ] **Step 8: Run the deterministic gate and all D+E tests**

Run: `npm exec -- tsx --test tests/vertical/d-e-cognitive-flow.test.ts && npm test --workspace @cosmo/research && npm test --workspace @cosmo/runtime && npm test --workspace @cosmo/cognition`

Expected: PASS; the receipt sets `cosmoAccepted: true` for the deterministic gate and all package suites remain green.

- [ ] **Step 9: Commit**

```bash
git add packages/cognition/src/candidate-transaction-store.ts \
  packages/cognition/src/candidate-branch-service.ts \
  packages/cognition/src/reviewed-cognitive-candidate-service.ts \
  packages/cognition/src/qualified-promotion-service.ts \
  packages/cognition/src/de-vertical-gate.ts packages/cognition/src/index.ts \
  packages/cognition/test/candidate-branch-service.test.ts \
  packages/cognition/test/reviewed-cognitive-candidate-service.test.ts \
  packages/cognition/test/qualified-promotion-service.test.ts \
  tests/vertical/d-e-cognitive-flow.test.ts
git commit -m "test(cosmo): pass deterministic cognitive vertical"
```

## Task 11B: Accept G's Legacy Import Bundle Into a Candidate Branch Only

This is an E-owned extension implemented when Program G Task 1 has frozen the
shared legacy contracts. It does not add a dependency from `@cosmo/cognition`
to a migration package: both packages import the sole schema/type objects from
`@cosmo/contracts`. Core Program E verification may issue its Task 12 receipt
before this extension; Program G cannot issue its migration/release receipt
until this task passes.

**Files:**
- Create: `packages/cognition/src/legacy-import-proposal.ts`
- Create: `packages/cognition/src/legacy-import-candidate-service.ts`
- Create: `packages/cognition/test/legacy-import-proposal.test.ts`
- Create: `packages/cognition/test/legacy-import-candidate-service.test.ts`
- Modify: `packages/cognition/src/index.ts`

E is the sole owner of every file above. Program G Task 5 consumes these
implementations and creates nothing inside `packages/cognition`. The sibling
owner extensions — Program C Task 12 (corpus proposal builder) and Program D
Task 13 (question/artifact-index proposal builders) — execute in the same
Program G window; G Task 5 requires all three receipts before it begins.

**Interfaces:**
- Consumes by identity from Program G's shared-contract freeze:
  `LegacyImportMappingSchema`,
  `LegacyImportCandidateProposalBundleSchema`,
  `PublishStagedImportInputSchema`,
  `LegacyImportCandidateReceiptSchema`,
  `BuildLegacyTopologyImportProposalInputSchema`,
  `LegacyTopologyImportProposalSchema`, and their inferred types.
- Produces only:

```ts
export interface LegacyTopologyImportProposalBuilder {
  build(
    input: BuildLegacyTopologyImportProposalInput,
  ): Promise<LegacyTopologyImportProposalBuildResult>;
}

export interface LegacyImportCandidateService {
  commitCandidate(
    input: PublishStagedImportInput,
  ): Promise<LegacyImportCandidateReceipt>;
}
```

The topology builder parses the exact G-owned input/proposal/result schemas.
Every topology entry has one non-null mapping ref, `origin='legacy_import'`,
and `epistemicStatus='legacy_unverified'`; the builder cannot update
Activation or invoke reviewed-candidate acceptance, and it accepts only
`legacy_topology`, `process_history`, or mapped legacy-claim/question
projections. It returns one exact stored `LegacyTopologyImportProposal` and
has no ref/CAS/promotion method.

- [ ] **Step 1: Write failing identity, quarantine, scope, and recovery tests**

```ts
test('legacy service consumes the sole G schemas by object identity', () => {
  assert.equal(
    CognitionSchemas.LegacyImportCandidateProposalBundleSchema,
    ContractSchemas.LegacyImportCandidateProposalBundleSchema,
  );
  assert.equal(
    CognitionSchemas.PublishStagedImportInputSchema,
    ContractSchemas.PublishStagedImportInputSchema,
  );
  assert.equal(
    CognitionSchemas.LegacyImportCandidateReceiptSchema,
    ContractSchemas.LegacyImportCandidateReceiptSchema,
  );
});

test('legacy bundle closes all nine roots on an absent import ref only', async () => {
  const fixture = await legacyImportCandidateFixture();
  const canonicalBefore = await fixture.canonicalFingerprint();
  const receipt = await fixture.service.commitCandidate(fixture.input);
  const commit = await fixture.repository.commits.get(
    receipt.candidateBrainCommitId,
  );
  assert.deepEqual(commit.payload.parentCommitIds,
    [fixture.bundle.parentCommitId]);
  assert.deepEqual(
    fixture.bundle.rootPlans.map((plan) => plan.rootKind),
    [
      'epistemicRoot',
      'questionRoot',
      'programRoot',
      'relationshipRoot',
      'heritageRoot',
      'topologyRoot',
      'activationRoot',
      'negativeKnowledgeRoot',
      'artifactIndexRoot',
    ],
  );
  assert.equal(receipt.previousHead, null);
  assert.equal(receipt.targetBranch, fixture.bundle.candidateRef);
  assert.deepEqual(
    (await fixture.repository.commits.eventClosure(commit.commitId))
      .directJournalEventIds,
    fixture.bundle.selectedJournalEventIds,
  );
  assert.equal(await fixture.canonicalFingerprint(), canonicalBefore);
  assert.equal(fixture.canonicalAdvanceCount, 0);
  assert.equal(fixture.promotionServiceCalls, 0);
});

test('legacy import rejects widened trust, status, scope, or raw root smuggling', async () => {
  for (const fault of [
    'supported_claim',
    'active_question',
    'nonempty_activation',
    'canonical_target_scope',
    'wrong_parent_scope',
    'widened_trust',
    'raw_root_override',
    'principal_decision',
    'canonical_promotion_allowed',
  ] as const) {
    const fixture = await legacyImportCandidateFixture({ fault });
    await assert.rejects(
      () => fixture.service.commitCandidate(fixture.input),
      { code: 'legacy_import_candidate_invalid' },
    );
    assert.equal(await fixture.candidateHead(), null);
  }
});

test('legacy candidate transaction recovers one absent-ref CAS exactly', async () => {
  const fixture = await legacyImportCandidateFixture({
    crashAfterRefBeforeReceipt: true,
  });
  await assert.rejects(
    () => fixture.service.commitCandidate(fixture.input),
    { code: 'fault_injected' },
  );
  await fixture.reopenWithoutFault();
  const recovered = await fixture.service.commitCandidate(fixture.input);
  const replay = await fixture.service.commitCandidate(fixture.input);
  assert.deepEqual(replay, recovered);
  assert.equal(fixture.successfulCommitAdvanceCount, 1);
  assert.equal(fixture.duplicateSelectedEventCount, 0);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm exec --workspace @cosmo/cognition -- tsx --test \
  test/legacy-import-candidate-service.test.ts
```

Expected: FAIL because the candidate-only service does not exist.

- [ ] **Step 3: Implement the one narrow import transaction**

`commitCandidate()` begins with the exact
`PublishStagedImportInputSchema.parse(input)`. It reloads the staged-import and
proposal-bundle refs and requires byte-identical values. It reconciles
`bundleId`, migration ID, all four source/casebook identities, parent, absent
candidate ref/head, mappings, selected event IDs, exact
`BrainLineageEventScope`, effective trust, manifest/reconciliation refs,
idempotency key, and `canonicalPromotionAllowed:false`.

The nine-entry tuple is positional and exhaustive:

1. C Epistemic `apply_corpus_batch`;
2. D Question `apply_legacy_question_batch`;
3. D Program `copy_parent`;
4. D Relationship `copy_parent`;
5. B Heritage `derive_migration_heritage`;
6. E Topology `apply_legacy_topology`;
7. E Activation `copy_parent`;
8. C Negative Knowledge from the same exact Corpus batch; and
9. D Artifact Index `apply_legacy_artifact_batch`.

E loads every owner proposal/ref, verifies its exact parent/previous-root pin,
mapping coverage, scope, trust, and selected events, and never accepts a raw
root payload. Imported Claims/topology/artifacts remain
`legacy_unverified`; Questions remain `incubating`; Program, Relationship, and
Activation are byte-identical parent copies. It rejects Claim transitions,
active Programs, relationship beliefs/preferences, activation changes,
Principal decisions, canonical refs, and any promotion field.

Before writes, store one canonical intent indexed by
`(candidateRef,parentCommitId,idempotencyKey)` and bound to the full input and
bundle IDs. Under the candidate-ref lease, verify the ref is absent, construct
the child from the nine owner plans, require its direct
`journalEventIds === bundle.selectedJournalEventIds` in cursor order, derive
Heritage from the typed migration curation/event refs, validate all nine roots
and effective trust, then call one
`commitAndAdvance(expectedHead:null,targetRef:candidateRef)`. It never reads or
updates a canonical ref and never calls either promotion service. Recovery
reconciles staged roots, the Program B transaction, ref, and receipt; exact
replay returns the same `LegacyImportCandidateReceipt`, while changed input
conflicts.

- [ ] **Step 3B: Implement the E-owned topology import proposal builder**

Write the failing `test/legacy-import-proposal.test.ts` first (schema-identity
with the G-frozen contracts, `legacy_unverified`/`legacy_import` forcing,
mapping-ref coverage, rejection of Activation updates and unmapped kinds),
verify it fails, then implement `legacy-import-proposal.ts` to the frozen
interface above and export it from `packages/cognition/src/index.ts`.

- [ ] **Step 4: Run focused and cross-owner tests**

Run:

```bash
npm exec --workspace @cosmo/cognition -- tsx --test \
  test/legacy-import-proposal.test.ts \
  test/legacy-import-candidate-service.test.ts
npm exec --workspace @cosmo/corpus -- tsx --test \
  test/legacy-import-proposal.test.ts
npm exec --workspace @cosmo/research -- tsx --test \
  test/legacy-import-proposals.test.ts
```

The corpus and research suites are owned and created by Program C Task 12 and
Program D Task 13 (the sibling owner extensions); this step verifies the three
extensions compose, and fails honestly if either sibling has not landed.

Expected: PASS; the import branch is valid, quarantined, replay-safe, and
incapable of canonical mutation.

- [ ] **Step 5: Commit**

```bash
git add packages/cognition/src/legacy-import-proposal.ts \
  packages/cognition/src/legacy-import-candidate-service.ts \
  packages/cognition/src/index.ts \
  packages/cognition/test/legacy-import-proposal.test.ts \
  packages/cognition/test/legacy-import-candidate-service.test.ts
git commit -m "feat(cognition): accept quarantined legacy candidates"
```

## Task 12: Run Recorded Adapter Conformance and Issue Program E's Receipt

**Files:**
- Create: `tests/vertical/d-e-production-adapter.test.ts`
- Create: `scripts/verify-program-e.mjs`
- Modify: `package.json`
- Create: `docs/receipts/program-e-living-brain-metabolism.json`

**Interfaces:**
- Consumes: Program D `OpenAiAgentsRuntime` on its production code path with `RuntimeReceipt.executionClass: 'recorded_conformance'`, deterministic D+E behavioral-contract proof from Task 11, autonomous lifecycle proof from Task 5, merged-Brain metabolism proof from Task 9, and paired proof from Task 10.
- Produces: reviewed Program E core stop/go receipt with production semantic acceptance explicitly not run.

- [ ] **Step 1: Write the failing recorded structural/fault conformance gate**

```ts
test('recorded transport exercises adapter structure and faults without semantic acceptance', async () => {
  const transport = recordedOpenAiTransport(
    new URL('../fixtures/openai/d-e-vertical.ndjson', import.meta.url),
  );
  const runtime = new OpenAiAgentsRuntime({
    transport,
    clock: deterministicClock(),
    executionClass: 'recorded_conformance',
  });
  const harness = await createDEVerticalHarness({
    runtime,
    input: {
      ...verticalGateInput(),
      runtimeAdapter: 'openai_agents',
      forceRestartAfterEnvelopeSequence: 3,
      forceContextTurnover: true,
      injectLateFencedEvent: true,
    },
    raceMetabolismAttempts: true,
  });
  try {
    const receipt = await runDEVerticalGate(harness.input);
    const runtimeReceipts: RuntimeReceipt[] = runtime.receipts;
    assert.equal(receipt.cosmoAccepted, true);
    assert.equal(receipt.runtimeAdapter, 'openai_agents');
    assert.ok(runtimeReceipts.length > 0);
    assert.equal(
      runtimeReceipts.every(
        (runtimeReceipt) =>
          runtimeReceipt.executionClass === 'recorded_conformance',
      ),
      true,
    );
    assert.equal(
      runtimeReceipts.every(
        (runtimeReceipt) => runtimeReceipt.providerFallback === null,
      ),
      true,
    );
    assert.equal(receipt.formationTrace.complete, true);
    assert.equal(harness.commitQualifiedPromotionCalls, 1);
  } finally {
    await harness.cleanup();
  }
});
```

This test proves envelope mapping, structured-output validation, tool-event admission, checkpoint/restart, retry, fencing, RuntimeReceipt emission, candidate/review/Principal authority order, and D+E port compatibility. Its recorded answers are fixtures; neither their content nor a green end-to-end path is a production semantic-quality result.

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm exec -- tsx --test tests/vertical/d-e-production-adapter.test.ts`

Expected: FAIL until the recorded conformance execution class traverses the adapter and D+E structural/fault path.

- [ ] **Step 3: Satisfy the same ports without branching cognitive semantics**

Only adapt transport envelopes to Program D's existing `WorkerEventEnvelope`. Do not add OpenAI-specific state to Brain objects, heritage, metabolism, questions, lifecycle decisions, or commit identity. Reuse `runDEVerticalGate()` unchanged.

```ts
const runtime = new OpenAiAgentsRuntime({
  transport: recordedTransport,
  clock: deterministicClock,
});
const runtimeController = createRuntimeController({
  workerRuntime: runtime,
  stateStore: recordedRuntimeStateStore,
  eventAdmission,
  objectStore,
});
const executionPort = new RuntimeExpeditionExecutionAdapter({
  controller: runtimeController,
  objectStore,
});
const researchPort = createResearchRuntimeCoordinator({ executionPort });
const receipt = await runDEVerticalGate({
  researchPort,
  cognitionPort,
  input: {
    ...verticalGateInput(),
    runtimeAdapter: 'openai_agents',
  },
  mutationContext,
  reviewContext,
  faultPolicy: recordedAdapterFaultPolicy(),
});
```

No deterministic or recorded receipt may set or imply `productionSemanticAccepted: true`. Program G alone runs `executionClass: 'live_provider'` under a signed profile and decides that gate.

- [ ] **Step 4: Add and commit the aggregate verifier before running it**

Add `"verify:program-e": "node scripts/verify-program-e.mjs"` to the root scripts. `scripts/verify-program-e.mjs` requires `--tested-commit <sha>`, refuses to start unless `git rev-parse HEAD` equals that SHA and `git status --porcelain` is empty, runs the exact Step 5 commands, confirms HEAD did not move, canonicalizes the receipt with Program A's helper, and writes the receipt only after every command passes.

Commit the recorded test and verifier without the receipt:

```bash
git add tests/vertical/d-e-production-adapter.test.ts \
  scripts/verify-program-e.mjs package.json
git commit -m "test(cosmo): add living brain gate harness"
test -z "$(git status --porcelain)"
```

Expected: the implementation/harness commit is clean. Any later code, fixture, test, package, lockfile, or verifier change invalidates the result and requires a new harness commit.

- [ ] **Step 5: Test the exact clean commit and generate the receipt**

Run:

```bash
git diff --quiet
git diff --cached --quiet
test -z "$(git status --porcelain)"
tested_commit="$(git rev-parse HEAD)"
node scripts/verify-program-e.mjs --tested-commit "$tested_commit"
test "$(git rev-parse HEAD)" = "$tested_commit"
git diff --cached --quiet
```

The verifier runs:

```bash
npm run build
npm exec -- tsx --test \
  tests/vertical/d-e-cognitive-flow.test.ts \
  tests/vertical/d-e-production-adapter.test.ts \
  tests/vertical/e-autonomous-lifecycle.test.ts \
  tests/vertical/union-cognition-metabolism.test.ts
npm test --workspace @cosmo/contracts
npm test --workspace @cosmo/repository
npm test --workspace @cosmo/corpus
npm test --workspace @cosmo/research
npm test --workspace @cosmo/runtime
npm test --workspace @cosmo/cognition
git diff --check
```

`docs/receipts/program-e-living-brain-metabolism.json` records the exact `testedCommit`, Program B/C/D receipt IDs, deterministic gate hash, recorded structural/fault gate hash, autonomous lifecycle receipt hash, merged-Brain metabolism receipt hash, five-fixture paired-sleep hash/win distribution, restart/turnover/late-event/concurrency results, parent/child/heritage/ref identities, every command/exit code, and:

```js
const receipt = {
  schema: 'cosmo.program-e-receipt.v1',
  cosmoAccepted: true,
  stopGo: 'go',
  deterministicContractAcceptance: 'pass',
  deterministicExecutionClass: 'deterministic_conformance',
  recordedAdapterStructuralPassed: true,
  recordedExecutionClass: 'recorded_conformance',
  recordedProviderFallbackCount: 0,
  productionSemanticAccepted: false,
  productionSemanticAcceptance:
    'not_run_program_g_signed_live_provider_profile_required',
  releaseAccepted: false,
  durableLifecycleOwner: '@cosmo/cognition',
  hostCognitivePolicyCount: 0,
  unresolvedUnionLeafLayers: 0,
  missingPreservedUnionObjects: 0,
  missingHeritageRoots: 0,
  home23Present: false,
};
```

Here `cosmoAccepted: true` and `deterministicContractAcceptance: 'pass'` mean the standalone D+E behavioral contract is no longer blocked. They make no claim about live-provider answer quality; `releaseAccepted: false` and `productionSemanticAccepted: false` keep production semantic acceptance exclusively in Program G.

- [ ] **Step 6: Verify and commit only the generated receipt**

Run:

```bash
git diff --quiet
git diff --cached --quiet
test "$(git status --porcelain)" = "?? docs/receipts/program-e-living-brain-metabolism.json"
jq -e '
  .cosmoAccepted == true and
  .stopGo == "go" and
  .deterministicContractAcceptance == "pass" and
  .deterministicExecutionClass == "deterministic_conformance" and
  .recordedAdapterStructuralPassed == true and
  .recordedExecutionClass == "recorded_conformance" and
  .recordedProviderFallbackCount == 0 and
  .productionSemanticAccepted == false and
  .releaseAccepted == false and
  .durableLifecycleOwner == "@cosmo/cognition" and
  .hostCognitivePolicyCount == 0 and
  .unresolvedUnionLeafLayers == 0 and
  .missingPreservedUnionObjects == 0 and
  .missingHeritageRoots == 0 and
  .home23Present == false
' docs/receipts/program-e-living-brain-metabolism.json
git add docs/receipts/program-e-living-brain-metabolism.json
git diff --quiet
test "$(git diff --cached --name-only)" = "docs/receipts/program-e-living-brain-metabolism.json"
git diff --cached --check
git commit -m "test(cosmo): receipt living brain metabolism"
test -z "$(git status --porcelain)"
```

Expected: the receipt names the exact clean implementation/harness commit tested, the final commit contains only the receipt, and production semantic acceptance remains explicitly deferred.

## Program E completion gate

Program E is complete only when:

- typed graph, topology, activation, self-model, default mode, and metabolism suites pass;
- recursive union roots materialize as attributed queryable composites and survive metabolism with every wrapper/leaf still reachable;
- byte-identical lifecycle initialization returns the same persisted state with typed `initialized`/`already_initialized` outcomes, while conflicting reinitialization fails without mutation;
- Program E's durable lifecycle engine originates and pursues work across restart while host wakes contain no cognitive instruction;
- all staged semantic outputs are input-bound and resumable;
- every consolidation is reversible and every original remains addressable;
- every child commit carries a verified `heritageRoot` linked to its parent heritage and typed metabolism events;
- dream output remains candidate cognition and reaches at least one explicit question/outcome chain;
- pruning loses no retained epistemic object;
- forced faults never expose a partial child or change the parent ref;
- the five-fixture paired proof passes its preregistered target without a guardrail breach;
- the deterministic D+E behavioral-contract gate and recorded adapter structural/fault gate both pass the exact vertical chain;
- the reviewed receipt says `stopGo: go`, `releaseAccepted: false`, and `productionSemanticAccepted: false`; and
- Program G remains responsible for signed `live_provider` semantic acceptance.

Do not begin Program F execution merely because an individual Program E task is green. Begin it only after this receipt is committed.
