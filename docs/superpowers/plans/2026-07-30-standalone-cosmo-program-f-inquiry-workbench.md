# Standalone COSMO Program F: Inquiry and Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver pinned Ask/Steer/Invent inquiry, intent-specific retrieval, typed assertion provenance, causal idea-formation and surprise explanations, read-only comparison/federation, independent answer verification, the frozen Brain-over-files proof, and a restrained BrainStudio-style workbench.

**Architecture:** `@cosmo/inquiry` reads exact Program B commits and Program E cognitive roots through a mutation-free query scope, while Program C remains authoritative for evidence and Program D remains authoritative for Relationship/Question/Program writes. Ask fingerprints authority before and after generation, Steer writes only an explicit typed proposal through the kernel, Invent forks a candidate branch, and the workbench consumes a stable relative HTTP gateway that Program H will implement without changing workbench source.

**Tech Stack:** Node.js 22.12+, TypeScript ESM, npm workspaces, Zod 4 schemas, `node:test`, Program B `BrainRepository`, Program C evidence/claim services, Program E Living Brain/formation/activation services, React 19.1.1, Vite 7.0.6, Vitest 3.2.4, Testing Library, and CSS/SVG with no graph-view dependency.

## Global Constraints

- The canonical source repository is `/Users/jtr/_JTR23_/cosmo`; Home23 is neither a package dependency nor a runtime host.
- Runtime and private installation state live under `~/.cosmo` and remain untracked.
- Historical roots are read-only inputs. No plan may rename, delete, rewrite, normalize, or mass-copy them.
- Every durable identity is content-addressed or explicitly names a content-addressed parent.
- Workers and model calls never write canonical Brain state.
- The Trust and Continuity Kernel validates authority and transition mechanics; it never determines semantic truth.
- Candidate cognition is admitted through quarantine and schema/grant/provenance checks before entering the cognitive journal.
- A long-running session and its compaction state are runtime working memory, not the Brain and not sleep/dream.
- Merge is lossless authorized union before any separate metabolism commit.
- Home23 must be absent from standalone build and acceptance environments.
- Program D and Program E share one acceptance gate; neither is a releasable COSMO milestone alone.
- No Program H Home23 client work begins without standalone acceptance and later explicit operator authorization.
- Use TDD, run the smallest focused test first, and commit after every independently reviewable task.
- Do not begin implementation until all Program A–H plans have passed the cross-plan review in this planning set.
- Ask is read-only: it cannot change a Brain ref, canonical root, activation root, Relationship, Question Ecology, or Program state.
- Steer and Invent are explicit before execution, require a mutation review, and return exact resulting branch/commit identities.
- Every answer assertion is exactly one of the five governing assertion types and carries reconstructable support or an explicit limitation.
- Dream, reasoning, and introspection cognition is selected by intent and labeled; it is never universally discarded or silently presented as sourced fact.
- The answer generator never verifies itself; verification uses a distinct attempt and receives no hidden generator rationale.
- Program F cannot pass by answering from artifacts or query-time invention; its defining gate is the frozen read-only Brain-over-files proof.
- `apps/workbench/dist/` is generated and untracked. Program H serves the exact built output and implements its gateway; Program H does not edit Program F workbench source.
- Browser authentication exchanges a one-time `/#/connect/<code>` fragment for an HttpOnly same-origin session, removes the fragment, validates the strict exchange JSON, and retains its CSRF token only inside the in-memory gateway closure for `X-COSMO-CSRF` on later POST requests; the workbench never persists a bearer, session secret, or CSRF token.
- `POST /api/v1/session/exchange` is a narrowly scoped security-bootstrap exception, not a Brain/research mutation: it has no authenticated scope or CSRF token yet, atomically consumes a single-use hashed code, is replay-safe by consumption state, and cannot invoke any COSMO operation. Every later mutation uses authenticated server-derived authority and idempotency.

---

## Prerequisites and stop/go boundary

Execute this plan only after the committed Program E receipt reports a green joint D+E vertical gate. Program F consumes a Living Brain that has already demonstrated autonomous question origination, candidate promotion, metabolism, wake, and pre-query formation lineage.

Program F does not create a public daemon or final API server. It freezes the inquiry service and browser gateway contracts, implements deterministic conformance and production inquiry roles through Program D's one shared `StructuredRoleExecutionPort`, and builds the complete browser application. `WorkerRuntime` remains the worker-event transport beneath that D-owned seam and is never called directly by Program F. Program G requires live generator/verifier trials; Program H later implements the matching public HTTP/SSE surface and packages the unchanged build.

## File map

### Extend public contracts

- Create `packages/contracts/src/inquiry.ts` — frozen `QueryRequest`, execution scope, answer, assertion, verification, mutation, comparison, federation, public workbench DTO, and Brain-over-files schemas.
- Modify `packages/contracts/src/index.ts` — export Program F contracts.
- Create `packages/contracts/test/inquiry.test.ts` — mode, pins, and assertion traps.

### Create `@cosmo/inquiry`

- Create `packages/inquiry/package.json`.
- Create `packages/inquiry/tsconfig.json`.
- Create `packages/inquiry/src/index.ts`.
- Create `packages/inquiry/src/pins.ts` — exact commit/snapshot resolution and before/after authority fingerprints.
- Create `packages/inquiry/src/retrieval.ts` — intent-specific retrieval plans and bounded projections.
- Create `packages/inquiry/src/assertions.ts` — five assertion validators and provenance ledger.
- Create `packages/inquiry/src/ask.ts` — read-only generation and response composition.
- Create `packages/inquiry/src/verifier.ts` — independent verification policy and gates.
- Create `packages/inquiry/src/production-execution-port.ts` — two-role adapter over Program D's shared structured-role execution seam and exact attempt receipts.
- Create `packages/inquiry/test/production-execution-port.test.ts` — provider/runtime isolation and separate-attempt contract tests.
- Create `packages/inquiry/src/formation.ts` — idea-formation and surprise response contracts over Program E traces.
- Create `packages/inquiry/src/compare.ts` — commit/branch/Brain diff and read-only federation.
- Create `packages/inquiry/src/mutations.ts` — explicit Steer and Invent paths.
- Create `packages/inquiry/src/brain-over-files.ts` — defining frozen accumulated-cognition proof.
- Create `packages/inquiry/test/helpers/fixtures.ts`.
- Create `packages/inquiry/test/pins.test.ts`.
- Create `packages/inquiry/test/retrieval.test.ts`.
- Create `packages/inquiry/test/assertions.test.ts`.
- Create `packages/inquiry/test/ask.test.ts`.
- Create `packages/inquiry/test/verifier.test.ts`.
- Create `packages/inquiry/test/formation.test.ts`.
- Create `packages/inquiry/test/compare.test.ts`.
- Create `packages/inquiry/test/mutations.test.ts`.
- Create `packages/inquiry/test/brain-over-files.test.ts`.
- Create `fixtures/contracts/inquiry/brain-over-files.json`.
- Create `fixtures/contracts/inquiry/brain-over-files.objects.json`.

### Create the BrainStudio-style workbench

- Create `apps/workbench/package.json`.
- Create `apps/workbench/tsconfig.json`.
- Create `apps/workbench/vite.config.ts`.
- Create `apps/workbench/index.html`.
- Create `apps/workbench/src/main.tsx`.
- Create `apps/workbench/src/App.tsx`.
- Create `apps/workbench/src/styles.css`.
- Create `apps/workbench/src/gateway/types.ts`.
- Create `apps/workbench/src/gateway/http-gateway.ts`.
- Create `apps/workbench/src/gateway/session.ts`.
- Create `apps/workbench/src/gateway/session.test.ts`.
- Create `apps/workbench/src/test/fake-gateway.ts`.
- Create `apps/workbench/src/state/use-workbench.ts`.
- Create `apps/workbench/src/view-models.ts`.
- Create `apps/workbench/src/view-models.test.ts`.
- Create `apps/workbench/src/components/brain-pin-bar.tsx`.
- Create `apps/workbench/src/components/mode-switch.tsx`.
- Create `apps/workbench/src/components/intent-picker.tsx`.
- Create `apps/workbench/src/components/query-composer.tsx`.
- Create `apps/workbench/src/components/answer-panel.tsx`.
- Create `apps/workbench/src/components/assertion-card.tsx`.
- Create `apps/workbench/src/components/provenance-drawer.tsx`.
- Create `apps/workbench/src/components/formation-trace.tsx`.
- Create `apps/workbench/src/components/compare-panel.tsx`.
- Create `apps/workbench/src/components/federation-panel.tsx`.
- Create `apps/workbench/src/components/wake-briefing-panel.tsx`.
- Create `apps/workbench/src/components/mutation-review.tsx`.
- Create `apps/workbench/src/test/setup.ts`.
- Create co-located `*.test.tsx` files for the state hook and every interactive component named in the tasks.
- Create `scripts/verify-program-f.mjs` — aggregate Program F verification and canonical receipt writer.
- Modify `package.json` — add `verify:program-f`.
- Create `docs/receipts/program-f-inquiry-workbench.json`.

## Frozen consumed interfaces

Program F consumes Program B without adding a write method to Ask:

```ts
repository.commits.get(id: BrainCommitId): Promise<BrainCommit>;
repository.refs.get(ref: BrainRefName): Promise<BrainCommitId | null>;
repository.objects.get(
  ref: ObjectRef,
  authorization?: MutationAuthorization
): Promise<StoredObject>;
repository.diff(left: BrainCommitId, right: BrainCommitId): Promise<BrainDiff>;
repository.federate(input: FederatedReadRequest): Promise<BrainSet>;
repository.fork(input: ForkRequest): Promise<RefUpdateReceipt>;
```

Program F consumes Program D's contracts-only semantic execution seam:

```ts
StructuredRoleExecutionPort.execute(
  input: StructuredRoleExecutionInput
): Promise<StructuredRoleExecutionResult>;
```

The exact stored output schema named by
`input.context.payload.executionPlan.outputSchemaRef` is authoritative.
Program F reparses the returned JSON with its owner schema. It never imports a
runtime implementation, calls `WorkerRuntime`, receives worker envelopes, or
creates a second provider adapter.

Program F consumes Program E:

```ts
LivingBrainService.materialize(commitId: BrainCommitId): Promise<LivingBrainView>;
LivingBrainService.traceFormation(
  commitId: BrainCommitId,
  target: FormationTraceTarget,
  limits: FormationTraceLimits
): Promise<FormationTrace>;
ActivationService.computeTransient(input: ActivationInput): Promise<ActivationView>;
```

Program F produces:

```ts
interface FederatedInquirySelection {
  brainSetId: Sha256;
  commitIds: BrainCommitId[];
  allowPartial: boolean;
}

interface InquiryExecutionInput {
  schema: 'cosmo.inquiry-execution-input.v1';
  request: QueryRequest;
  comparisonTargets: BrainCommitId[];
  federation: FederatedInquirySelection | null;
  perspectiveIds: ObjectId[];
}

interface AssertionClaimSupport {
  claimId: ClaimId;
  revisionObjectId: ObjectId;
  address: BrainObjectAddress;
}

interface AssertionCognitionSupport {
  nodeId: ObjectId;
  address: BrainObjectAddress;
}

interface AssertionEvidenceSupport {
  evidenceSpanId: ObjectId;
  address: BrainObjectAddress;
}

interface AssertionRelationshipSupport {
  relationshipEventId: RelationshipEventId;
  address: BrainObjectAddress;
}

interface AssertionFormationEventSupport {
  eventId: EventId;
  sourceCommitId: BrainCommitId;
  journalCursor: JournalCursor;
}

interface InquiryAssertionPayload {
  schema: 'cosmo.inquiry-assertion-payload.v1';
  type:
    | 'sourced_fact'
    | 'committed_brain_synthesis'
    | 'new_connection_in_answer'
    | 'speculation_or_proposal'
    | 'human_steering_or_judgment';
  text: string;
  claimSupports: AssertionClaimSupport[];
  cognitionSupports: AssertionCognitionSupport[];
  evidenceSupports: AssertionEvidenceSupport[];
  relationshipSupports: AssertionRelationshipSupport[];
  formationEventSupports: AssertionFormationEventSupport[];
  formedDuringQueryId: string | null;
  limitation: string | null;
}

type InquiryAssertion = InquiryAssertionPayload & {
  assertionId: ObjectId;
};

type AnswerSectionKind =
  | 'answer'
  | 'evidence'
  | 'brain_synthesis'
  | 'new_connections'
  | 'uncertainties'
  | 'human_context'
  | 'limitations';

type GeneratedAnswerBlock =
  | { kind: 'section'; section: AnswerSectionKind }
  | { kind: 'assertion'; assertionIndex: number };

interface GeneratedAnswerDocument {
  schema: 'cosmo.generated-answer-document.v1';
  blocks: GeneratedAnswerBlock[];
}

type AnswerBlock =
  | { kind: 'section'; section: AnswerSectionKind }
  | { kind: 'assertion'; assertionId: ObjectId };

interface AnswerDocument {
  schema: 'cosmo.answer-document.v1';
  blocks: AnswerBlock[];
}

interface InquiryAnswer {
  schema: 'cosmo.inquiry-answer.v1';
  queryId: string;
  brainCommitId: BrainCommitId;
  corpusSnapshotIds: CorpusSnapshotId[];
  document: AnswerDocument;
  text: string;
  assertions: InquiryAssertion[];
  generatorAttemptReceipt: InquiryAttemptReceipt;
  verification: InquiryVerification;
  releaseable: boolean;
  omissions: string[];
  limitations: string[];
  createdAt: string;
}

interface InquiryGenerationInput {
  schema: 'cosmo.inquiry-generation-input.v1';
  request: QueryRequest;
  pinnedContextRef: ObjectRef;
  retrievalProjectionRef: ObjectRef;
  assertionContractRef: ObjectRef;
  execution: StructuredRoleExecutionInput;
}

interface InquiryGeneration {
  schema: 'cosmo.inquiry-generation.v1';
  queryId: string;
  brainCommitId: BrainCommitId;
  document: GeneratedAnswerDocument;
  assertionPayloads: InquiryAssertionPayload[];
  omissions: string[];
  attemptReceipt: InquiryAttemptReceipt;
}

interface InquiryVerificationInput {
  schema: 'cosmo.inquiry-verification-input.v1';
  queryId: string;
  query: string;
  intent: QueryRequest['intent'];
  assertions: InquiryAssertion[];
  pinnedSupportRefs: ObjectRef[];
  omissions: string[];
  verifierPolicyRef: ObjectRef;
  generatorAttemptReceipt: InquiryAttemptReceipt;
  execution: StructuredRoleExecutionInput;
  capabilities: {
    network: false;
    tools: false;
    mutation: false;
  };
}

interface InquiryVerificationFinding {
  assertionId: ObjectId;
  result: 'pass' | 'contest' | 'block' | 'escalate';
  reason: string;
  supportingAddresses: BrainObjectAddress[];
  opposingEvidenceSupports: AssertionEvidenceSupport[];
}

interface InquiryVerification {
  schema: 'cosmo.inquiry-verification.v1';
  queryId: string;
  generatorAttemptId: RunId;
  attemptReceipt: InquiryAttemptReceipt;
  findings: InquiryVerificationFinding[];
  releaseable: boolean;
  limitations: string[];
}

interface InquiryService {
  ask(input: InquiryExecutionInput): Promise<InquiryAnswer>;
  steer(input: SteerInput): Promise<SteerReceipt>;
  invent(input: InventInput): Promise<InventReceipt>;
  compare(input: CompareInput): Promise<ComparisonResult>;
  federate(input: FederatedInquiryInput): Promise<FederatedInquiryResult>;
}

interface InquiryExecutionPort {
  generate(input: InquiryGenerationInput): Promise<InquiryGeneration>;
  verify(input: InquiryVerificationInput): Promise<InquiryVerification>;
}

interface InquiryAttemptReceipt {
  schema: 'cosmo.inquiry-attempt-receipt.v1';
  attemptId: RunId;
  role: 'generator' | 'verifier';
  runtimeReceiptRef: ObjectRef;
  runtimeAdapterId: Sha256;
  outputSchemaRef: ObjectRef;
  outputRef: ObjectRef;
  executionClass: RuntimeReceipt['executionClass'];
  provider: string;
  model: string;
  contextBundleId: ObjectId;
  modelInputHash: Sha256;
  outputHash: Sha256;
  allowedToolNames: [];
  semanticAcceptanceEligible: boolean;
  startedAt: string;
  completedAt: string;
}

interface RelationshipEventSteerPayload {
  kind: 'relationship_event';
  relationshipKind:
    | 'why_it_matters'
    | 'taste_judgment'
    | 'correction'
    | 'direction_accepted'
    | 'direction_rejected'
    | 'answer_form_feedback';
  content: string;
  evidenceSpanIds: ObjectId[];
  confidence: number | null;
  reversesRelationshipEventId: RelationshipEventId | null;
}

interface QuestionProposalSteerPayload {
  kind: 'question_proposal';
  wording: string;
  semanticVariants: string[];
  whyItMatters: string;
  parentQuestionIds: QuestionId[];
  domains: string[];
  perspectiveIds: ObjectId[];
  surprise: number;
  uncertainty: number;
  evidenceConsidered: ObjectId[];
  humanInterest: string | null;
  initialStatus: 'new' | 'active' | 'incubating';
  reviewAt: string | null;
  expiresAt: string | null;
}

interface ProgramProposalSteerPayload {
  kind: 'program_proposal';
  title: string;
  purpose: string;
  mode: ResearchProgramMode;
  seedQuestionIds: QuestionId[];
  covenantCommitId: BrainCommitId;
  stoppingRules: string[];
}

type WorkbenchSteerPayload =
  | RelationshipEventSteerPayload
  | QuestionProposalSteerPayload
  | ProgramProposalSteerPayload;

type WorkbenchHeadRef = `refs/heads/${string}`;
type WorkbenchCandidateHeadRef = `refs/heads/candidates/${string}`;

interface WorkbenchBrainSummary {
  schema: 'cosmo.workbench-brain-summary.v1';
  brainCommitId: BrainCommitId;
  parentCommitIds: BrainCommitId[];
  corpusSnapshotIds: CorpusSnapshotId[];
  covenantCommitId: BrainCommitId;
  principalVersion: Sha256;
  refNames: BrainRefName[];
  selectedRef: BrainRefName | null;
  displayLabel: {
    text: string;
    source: 'selected_ref' | 'tag' | 'settled_ref' | 'commit_prefix';
    sourceRef: BrainRefName | null;
  };
  reachabilityStatuses: Array<
    'active_head' | 'tagged' | 'settled' | 'detached'
  >;
  integrity: 'verified' | 'degraded';
  interactionAccess: 'read_only' | 'query' | 'steer';
  questionCounts: Record<Question['status'], number>;
  claimCounts: Record<Claim['status'], number>;
  contradictionCount: number;
  negativeKnowledgeCount: number;
  lastMetabolismCommitId: BrainCommitId | null;
  trustProjection: 'public' | 'authenticated_redacted';
}

interface WorkbenchBrainCatalogRequest {
  schema: 'cosmo.workbench-brain-catalog-request.v1';
  cursor: string | null;
  limit: number;
  includeSettled: boolean;
}

interface WorkbenchBrainCatalog {
  schema: 'cosmo.workbench-brain-catalog.v1';
  brains: WorkbenchBrainSummary[];
  nextCursor: string | null;
}

interface WorkbenchSteerDraft {
  schema: 'cosmo.workbench-steer-draft.v1';
  requestId: string;
  request: QueryRequest & { mode: 'steer' };
  targetRef: WorkbenchHeadRef;
  target: 'relationship_event' | 'question_proposal' | 'program_proposal';
  payload: WorkbenchSteerPayload;
  expectedHead: BrainCommitId;
}

interface WorkbenchInventDraft {
  schema: 'cosmo.workbench-invent-draft.v1';
  requestId: string;
  request: QueryRequest & { mode: 'invent' };
  queriedRef: WorkbenchHeadRef;
  candidateRef: WorkbenchCandidateHeadRef;
  purpose: string;
  candidateFinding: CandidateFinding;
  expectedHead: BrainCommitId;
}

interface WorkbenchMutationPreview {
  previewId: ObjectId;
  schema: 'cosmo.workbench-mutation-preview.v1';
  kind: 'steer' | 'invent';
  requestId: string;
  draftRef: ObjectRef;
  draftHash: Sha256;
  expectedHead: BrainCommitId;
  authorityFingerprint: Sha256;
  reviewer: {
    principalId: Sha256;
    scopes: WorkbenchClientScope[];
  };
  changes: Array<{
    rootKind: BrainRootKind;
    operation:
      | 'append_relationship_event'
      | 'add_question_proposal'
      | 'add_program_proposal'
      | 'create_candidate_branch';
    affectedObjectCount: number;
  }>;
  expiresAt: string;
}

interface WorkbenchSteerCommitRequest {
  schema: 'cosmo.workbench-steer-commit-request.v1';
  requestId: string;
  previewId: ObjectId;
  draftHash: Sha256;
  expectedHead: BrainCommitId;
}

interface WorkbenchInventCommitRequest {
  schema: 'cosmo.workbench-invent-commit-request.v1';
  requestId: string;
  previewId: ObjectId;
  draftHash: Sha256;
  expectedHead: BrainCommitId;
}

interface SteerInput {
  draft: WorkbenchSteerDraft;
  preview: WorkbenchMutationPreview;
  reviewed: true;
  authorization: MutationAuthorization;
  lease: LeaseProof;
  resultRef: WorkbenchHeadRef;
  expectedResultHead: BrainCommitId | null;
  domainIdempotencyKey: Sha256;
  occurredAt: string;
}

interface SteerReceipt {
  schema: 'cosmo.steer-receipt.v1';
  requestId: string;
  targetRef: WorkbenchHeadRef;
  parentCommitId: BrainCommitId;
  childCommitId: BrainCommitId;
  resultRef: WorkbenchHeadRef;
  targetRefAfterCommitId: BrainCommitId;
  targetRefUnchanged: boolean;
  candidateRef: WorkbenchCandidateHeadRef | null;
  relationshipEventId: RelationshipEventId | null;
  questionProposalObjectId: ObjectId | null;
  programProposalObjectId: ObjectId | null;
  programDirectionProposalRecordingRef: ObjectRef | null;
  candidateAgendaReceiptRef: ObjectRef | null;
  principalDecisionId: ObjectId | null;
  humanOperationEventId: EventId;
  journalRange: JournalRange;
  previewId: ObjectId;
  draftHash: Sha256;
  occurredAt: string;
}

interface InventInput {
  draft: WorkbenchInventDraft;
  preview: WorkbenchMutationPreview;
  previewRef: ObjectRef;
  reviewed: true;
  authorization: MutationAuthorization;
  lease: LeaseProof;
  domainIdempotencyKey: Sha256;
  occurredAt: string;
}

interface InventReceipt {
  schema: 'cosmo.invent-receipt.v1';
  requestId: string;
  parentCommitId: BrainCommitId;
  candidateBranchCommitId: BrainCommitId;
  queriedRef: WorkbenchHeadRef;
  candidateRef: WorkbenchCandidateHeadRef;
  candidateFindingRef: ObjectRef;
  candidateFindingObjectId: ObjectId;
  candidateFinding: CandidateFinding;
  operationIntentRef: ObjectRef;
  candidateBranchReceiptRef: ObjectRef;
  candidateBranchReceipt: HumanInventCandidateBranchCommitReceipt;
  queriedRefUnchanged: true;
  principalDecisionId: ObjectId | null;
  humanOperationEventId: EventId;
  journalRange: JournalRange;
  previewId: ObjectId;
  draftHash: Sha256;
  occurredAt: string;
}

interface HumanInventOperationIntent {
  schema: 'cosmo.human-invent-operation-intent.v1';
  requestId: string;
  parentBrainCommitId: BrainCommitId;
  candidateBranchRef: WorkbenchCandidateHeadRef;
  candidateFindingRef: ObjectRef;
  inventDraftRef: ObjectRef;
  inventPreviewRef: ObjectRef;
  scope: CognitiveLineageEventScope;
  purpose: string;
  occurredAt: string;
}

interface PromoteHumanInventCandidateInput {
  schema: 'cosmo.promote-human-invent-candidate-input.v1';
  inventReceiptRef: ObjectRef;
  inventReceipt: InventReceipt;
  canonicalRef: WorkbenchHeadRef;
  expectedCanonicalHead: BrainCommitId;
  independentReviewInputs: IndependentCandidateReviewExecutionInput[];
  evidencePolicyId: ObjectId;
  principalVersion: Sha256;
  authorization: MutationAuthorization;
  lease: LeaseProof;
  idempotencyKey: Sha256;
  reviewedAt: string;
  acceptedAt: string;
}

interface HumanInventPromotionReceipt {
  schema: 'cosmo.human-invent-promotion-receipt.v1';
  inventReceiptRef: ObjectRef;
  committedCandidateReviewReceiptRef: ObjectRef;
  committedCandidateReviewReceipt:
    Extract<DECommittedCandidateReviewReceipt, { originKind: 'human_invent' }>;
  acceptance:
    | QualifiedPromotionCommitReceipt
    | ReviewedCognitiveCandidateAcceptanceReceipt;
}

interface HumanInventPromotionService {
  reviewAndPromote(
    input: PromoteHumanInventCandidateInput
  ): Promise<HumanInventPromotionReceipt>;
}

interface ProgramDirectionProposalRecording {
  schema: 'cosmo.program-direction-proposal-recording.v1';
  proposalRef: ObjectRef;
  proposal: ResearchProgramDirectionProposal;
  eventRef: ObjectRef;
  event: CognitiveEvent & { eventType: 'program_direction_proposed' };
  eventId: EventId;
}

interface ActivateProgramDirectionCandidateInput {
  schema: 'cosmo.activate-program-direction-candidate-input.v1';
  steerReceiptRef: ObjectRef;
  steerReceipt: SteerReceipt;
  proposalRecordingRef: ObjectRef;
  proposalRecording: ProgramDirectionProposalRecording;
  candidateAgendaReceiptRef: ObjectRef;
  candidateAgendaReceipt: CandidateAgendaAcceptanceReceipt;
  qualifiedReviewFindingRecordings: ReviewFindingRecording[];
  principalDecisionRecording: PrincipalDecisionRecording;
  createProgramInput: CreateResearchProgramInput;
  authorization: MutationAuthorization;
  lease: LeaseProof;
  hostControlDeliveryId: string;
  idempotencyKey: Sha256;
  activatedAt: string;
}

interface ProgramDirectionActivationReceipt {
  schema: 'cosmo.program-direction-activation-receipt.v1';
  proposalRecordingRef: ObjectRef;
  candidateAgendaReceiptRef: ObjectRef;
  researchProgramMutationResult: ResearchProgramMutationResult;
  programAcceptanceReceipt: ProgramMutationAcceptanceReceipt;
  initialization: CognitiveLifecycleInitializationResult;
  creationConvergedDecision: CognitiveLifecycleDecision;
  activeProgramMutationResult: ResearchProgramMutationResult;
  activeProgramAcceptanceReceipt: ProgramMutationAcceptanceReceipt;
}

interface ProgramDirectionActivationService {
  activate(
    input: ActivateProgramDirectionCandidateInput
  ): Promise<ProgramDirectionActivationReceipt>;
}

interface MutationRequester {
  principalId: Sha256;
  scopes: WorkbenchClientScope[];
}

interface MutationServiceContext {
  requester: MutationRequester;
  authorization: MutationAuthorization;
  domainIdempotencyKey: Sha256;
  observedAt: string;
}

interface PreviewSteerInput {
  draft: WorkbenchSteerDraft;
  context: MutationServiceContext;
}

interface PreviewInventInput {
  draft: WorkbenchInventDraft;
  context: MutationServiceContext;
}

interface ConsumeSteerInput {
  request: WorkbenchSteerCommitRequest;
  context: MutationServiceContext;
}

interface ConsumeInventInput {
  request: WorkbenchInventCommitRequest;
  context: MutationServiceContext;
}

interface MutationPreviewService {
  previewSteer(input: PreviewSteerInput): Promise<WorkbenchMutationPreview>;
  previewInvent(input: PreviewInventInput): Promise<WorkbenchMutationPreview>;
  consumeSteer(input: ConsumeSteerInput): Promise<SteerReceipt>;
  consumeInvent(input: ConsumeInventInput): Promise<InventReceipt>;
}

interface CompareInput {
  schema: 'cosmo.compare-input.v1';
  leftCommitId: BrainCommitId;
  rightCommitId: BrainCommitId;
  perspectiveIds: ObjectId[];
}

interface ReadOnlyInquiryReceipt {
  schema: 'cosmo.read-only-inquiry-receipt.v1';
  commitIds: BrainCommitId[];
  authorityFingerprintBefore: Sha256;
  authorityFingerprintAfter: Sha256;
  refFingerprintBefore: Sha256;
  refFingerprintAfter: Sha256;
  canonicalWriteCount: 0;
  refsChanged: false;
}

interface ComparisonDisplayIdentity {
  brainCommitId: BrainCommitId;
  refNames: BrainRefName[];
  displayLabel: WorkbenchBrainSummary['displayLabel'];
}

type ClaimComparisonChange =
  | {
      change: 'added';
      claimId: ClaimId;
      rightRevisionAddress: BrainObjectAddress;
      to: Claim['status'];
    }
  | {
      change: 'removed';
      claimId: ClaimId;
      leftRevisionAddress: BrainObjectAddress;
      from: Claim['status'];
    }
  | {
      change: 'status_changed';
      claimId: ClaimId;
      leftRevisionAddress: BrainObjectAddress;
      rightRevisionAddress: BrainObjectAddress;
      from: Claim['status'];
      to: Claim['status'];
      claimTransitionDecisionId: ObjectId;
      acceptedTransitionAddress: BrainObjectAddress;
    };

type QuestionComparisonChange =
  | {
      change: 'added';
      questionId: QuestionId;
      rightQuestionAddress: BrainObjectAddress;
      to: Question['status'];
      reasonEvents: AssertionFormationEventSupport[];
    }
  | {
      change: 'removed';
      questionId: QuestionId;
      leftQuestionAddress: BrainObjectAddress;
      from: Question['status'];
      reasonEvents: AssertionFormationEventSupport[];
    }
  | {
      change: 'status_changed';
      questionId: QuestionId;
      leftQuestionAddress: BrainObjectAddress;
      rightQuestionAddress: BrainObjectAddress;
      from: Question['status'];
      to: Question['status'];
      reasonEvents: AssertionFormationEventSupport[];
    };

interface ComparisonResult {
  schema: 'cosmo.comparison-result.v1';
  leftCommitId: BrainCommitId;
  rightCommitId: BrainCommitId;
  leftIdentity: ComparisonDisplayIdentity;
  rightIdentity: ComparisonDisplayIdentity;
  changedClaimStatuses: ClaimComparisonChange[];
  questionChanges: QuestionComparisonChange[];
  topologyChanges: Array<{
    edgeAddress: BrainObjectAddress;
    from: BrainObjectAddress;
    to: BrainObjectAddress;
    change: 'added' | 'removed' | 'retyped';
    reasonEvents: AssertionFormationEventSupport[];
  }>;
  activationChanges: Array<{
    target: LayerNodeAddress;
    from: number | null;
    to: number | null;
    reasonEvents: AssertionFormationEventSupport[];
  }>;
  negativeKnowledgeChanges: Array<{
    address: BrainObjectAddress;
    change: 'added' | 'removed' | 'changed';
  }>;
  perspectiveChanges: Array<{
    address: BrainObjectAddress;
    change: 'added' | 'removed' | 'changed';
  }>;
  relationshipAndProgramChanges: Array<{
    address: BrainObjectAddress;
    change: 'added' | 'removed' | 'changed';
  }>;
  metabolismMappings: Array<{
    from: BrainObjectAddress;
    to: BrainObjectAddress;
    reasonEvents: AssertionFormationEventSupport[];
  }>;
  artifactChanges: Array<{
    artifactId: ArtifactId;
    address: BrainObjectAddress;
    change: 'added' | 'removed' | 'changed';
  }>;
  readOnlyReceipt: ReadOnlyInquiryReceipt;
}

interface FederatedInquiryInput {
  schema: 'cosmo.federated-inquiry-input.v1';
  request: QueryRequest & { mode: 'ask' };
  brainSetId: Sha256;
  commitIds: BrainCommitId[];
  allowPartial: boolean;
  perspectiveIds: ObjectId[];
}

interface FederatedInquiryAssertion extends InquiryAssertion {
  brainSetSources: Array<{
    brainSetId: Sha256;
    brainCommitId: BrainCommitId;
    support:
      | {
          kind: 'claim';
          claimId: ClaimId;
          revisionObjectId: ObjectId;
          address: BrainObjectAddress;
        }
      | {
          kind: 'cognition';
          nodeId: ObjectId;
          address: BrainObjectAddress;
        }
      | {
          kind: 'evidence';
          evidenceSpanId: ObjectId;
          address: BrainObjectAddress;
        }
      | {
          kind: 'relationship';
          relationshipEventId: RelationshipEventId;
          address: BrainObjectAddress;
        }
      | {
          kind: 'formation_event';
          eventId: EventId;
          sourceCommitId: BrainCommitId;
          journalCursor: JournalCursor;
        };
  }>;
  disclosures: Array<{
    supportKey: string;
    status: 'disclosed' | 'withheld_by_rights';
  }>;
}

interface FederatedInquiryResult {
  schema: 'cosmo.federated-inquiry-result.v1';
  queryId: string;
  brainSetId: Sha256;
  commitIds: BrainCommitId[];
  sourceIdentities: ComparisonDisplayIdentity[];
  assertions: FederatedInquiryAssertion[];
  generatorAttemptReceipt: InquiryAttemptReceipt;
  verification: InquiryVerification;
  releaseable: boolean;
  omissions: string[];
  limitations: string[];
  partial: boolean;
  withheldSupportKeys: string[];
  readOnlyReceipt: ReadOnlyInquiryReceipt;
}

interface WorkbenchGateway {
  listBrains(
    input: WorkbenchBrainCatalogRequest
  ): Promise<WorkbenchBrainCatalog>;
  getBrain(commitId: BrainCommitId): Promise<WorkbenchBrainSummary>;
  ask(input: InquiryExecutionInput): Promise<InquiryAnswer>;
  previewSteer(input: WorkbenchSteerDraft): Promise<WorkbenchMutationPreview>;
  commitSteer(input: WorkbenchSteerCommitRequest): Promise<SteerReceipt>;
  previewInvent(input: WorkbenchInventDraft): Promise<WorkbenchMutationPreview>;
  commitInvent(input: WorkbenchInventCommitRequest): Promise<InventReceipt>;
  compare(input: CompareInput): Promise<ComparisonResult>;
  federate(input: FederatedInquiryInput): Promise<FederatedInquiryResult>;
  explainFormation(input: FormationInquiry): Promise<FormationExplanation>;
  getWakeBriefing(commitId: BrainCommitId): Promise<WakeBriefing>;
}

type WorkbenchClientScope =
  | 'read'
  | 'query'
  | 'steer'
  | 'operate'
  | 'export'
  | 'admin';

interface WorkbenchSessionExchangeResponse {
  schema: 'cosmo.browser-session-exchange.v1';
  principalId: Sha256;
  scopes: WorkbenchClientScope[];
  csrfToken: `csrf_${string}`;
  expiresAt: string;
}
```

## Task 1: Freeze inquiry contracts and scaffold `@cosmo/inquiry`

**Files:**
- Create: `packages/contracts/src/inquiry.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/inquiry.test.ts`
- Create: `packages/inquiry/package.json`
- Create: `packages/inquiry/tsconfig.json`
- Create: `packages/inquiry/src/index.ts`
- Create: `packages/inquiry/test/helpers/fixtures.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the program-map `QueryRequest` unchanged.
- Produces: strict schemas and exact types for `InquiryExecutionInput`,
  attributed `AssertionClaimSupport`, `AssertionCognitionSupport`,
  `AssertionEvidenceSupport`, `AssertionRelationshipSupport`, and
  `AssertionFormationEventSupport`, stored `InquiryAssertionPayload` and
  decoded `InquiryAssertion`, closed
  `GeneratedAnswerDocument`/`AnswerDocument` blocks, `InquiryAnswer`,
  `InquiryGenerationInput`/`InquiryGeneration`,
  `InquiryVerificationInput`/`InquiryVerificationFinding`/`InquiryVerification`,
  `InquiryAttemptReceipt`, internal authority-bearing `SteerInput`/`InventInput`,
  `HumanInventOperationIntent`, `PromoteHumanInventCandidateInput`,
  `HumanInventPromotionReceipt`, `HumanInventPromotionService`,
  `ProgramDirectionProposalRecording`,
  `ActivateProgramDirectionCandidateInput`,
  `ProgramDirectionActivationReceipt`,
  `ProgramDirectionActivationService`,
  the target-discriminated `WorkbenchSteerPayload`, public authority-free
  `WorkbenchSteerDraft`/`WorkbenchInventDraft`, `WorkbenchMutationPreview`,
  `WorkbenchSteerCommitRequest`/`WorkbenchInventCommitRequest`,
  `MutationRequester`, `MutationServiceContext`, the four exact
  preview/consume input types, `MutationPreviewService`,
  `WorkbenchBrainSummary`, `WorkbenchSessionExchangeResponse`, `SteerReceipt`,
  `InventReceipt`, add/remove-aware `CompareInput`/`ComparisonResult`, and
  `FederatedInquiryInput`/`FederatedInquiryResult`.

- [ ] **Step 1: Write failing mode, pin, and assertion tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InquiryAnswerSchema,
  InquiryExecutionInputSchema,
  QueryRequestSchema,
} from '../src/inquiry.js';

const sha = (character: string) => `sha256:${character.repeat(64)}`;

test('QueryRequest preserves every frozen program-map field', () => {
  const result = QueryRequestSchema.parse({
    queryId: 'query_01J00000000000000000000000',
    mode: 'ask',
    intent: 'surprise',
    brainCommitId: sha('a'),
    corpusSnapshotIds: [sha('b')],
    parentQueryId: null,
    text: 'What surprised you?',
  });
  assert.equal(result.mode, 'ask');
  assert.equal(result.intent, 'surprise');
  assert.equal(result.brainCommitId, sha('a'));
});

test('compare targets live outside the frozen QueryRequest', () => {
  const result = InquiryExecutionInputSchema.parse({
    schema: 'cosmo.inquiry-execution-input.v1',
    request: {
      queryId: 'query_compare',
      mode: 'ask',
      intent: 'compare',
      brainCommitId: sha('a'),
      corpusSnapshotIds: [sha('b')],
      parentQueryId: null,
      text: 'Compare these commits',
    },
    comparisonTargets: [sha('c')],
    federation: null,
    perspectiveIds: [],
  });
  assert.deepEqual(result.comparisonTargets, [sha('c')]);
});

test('public inquiry DTOs reject unknown and authority-bearing fields', () => {
  assert.throws(() => QueryRequestSchema.parse({
    queryId: 'query_unknown_authority',
    mode: 'ask',
    intent: 'answer',
    brainCommitId: sha('a'),
    corpusSnapshotIds: [sha('b')],
    parentQueryId: null,
    text: 'What does the Brain know?',
    capabilityGrantId: sha('c'),
  }));
});

test('an answer document has no free-prose escape hatch', () => {
  assert.equal(GeneratedAnswerDocumentSchema.safeParse({
    schema: 'cosmo.generated-answer-document.v1',
    blocks: [{
      kind: 'prose',
      text: 'A fluent but unsupported answer',
    }],
  }).success, false);
});

test('answer text is only the deterministic rendering of typed blocks', () => {
  const answer = inquiryAnswerFixture();
  assert.equal(InquiryAnswerSchema.safeParse({
    ...answer,
    text: `${answer.text}\nUnsupported epilogue`,
  }).success, false);
});
```

- [ ] **Step 2: Run the contract tests and verify they fail**

Run: `npm exec --workspace @cosmo/contracts -- tsx --test test/inquiry.test.ts`

Expected: FAIL because the Program F schemas are not exported.

- [ ] **Step 3: Implement the exact request and five assertion types**

These five ID schemas are Program A-owned; inquiry.ts imports them by identity and declares no lookalikes.

```ts
import {
  BrainCommitIdSchema,
  ClaimIdSchema,
  CorpusSnapshotIdSchema,
  EventIdSchema,
  RelationshipEventIdSchema,
} from './ids.js';

export const AssertionClaimSupportSchema = z.object({
  claimId: ClaimIdSchema,
  revisionObjectId: ObjectIdSchema,
  address: BrainObjectAddressSchema,
}).strict().superRefine((support, context) => {
  if (
    support.address.rootKind !== 'epistemicRoot'
    || support.address.objectId !== support.revisionObjectId
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Claim support must name the exact Epistemic revision object',
    });
  }
});

export const AssertionCognitionSupportSchema = z.object({
  nodeId: ObjectIdSchema,
  address: BrainObjectAddressSchema,
}).strict().superRefine((support, context) => {
  if (
    support.address.rootKind !== 'topologyRoot'
    || support.address.objectId !== support.nodeId
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Cognition support must name the exact Topology node object',
    });
  }
});

export const AssertionEvidenceSupportSchema = z.object({
  evidenceSpanId: ObjectIdSchema,
  address: BrainObjectAddressSchema,
}).strict().superRefine((support, context) => {
  if (
    support.address.rootKind !== 'epistemicRoot'
    || support.address.objectId !== support.evidenceSpanId
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Evidence support must name the exact Epistemic EvidenceSpan object',
    });
  }
});

export const AssertionRelationshipSupportSchema = z.object({
  relationshipEventId: RelationshipEventIdSchema,
  address: BrainObjectAddressSchema,
}).strict().superRefine((support, context) => {
  if (support.address.rootKind !== 'relationshipRoot') {
    context.addIssue({
      code: 'custom',
      message: 'Relationship support must resolve through relationshipRoot',
    });
  }
});

export const AssertionFormationEventSupportSchema = z.object({
  eventId: EventIdSchema,
  sourceCommitId: BrainCommitIdSchema,
  journalCursor: JournalCursorSchema,
}).strict();

export const QueryRequestSchema = z.object({
  queryId: z.string().min(1),
  mode: z.enum(['ask', 'steer', 'invent']),
  intent: z.enum([
    'answer',
    'explore',
    'surprise',
    'reflect',
    'challenge',
    'audit',
    'unknowns',
    'compare',
    'formation',
    'promote',
  ]),
  brainCommitId: BrainCommitIdSchema,
  corpusSnapshotIds: z.array(CorpusSnapshotIdSchema).min(1),
  parentQueryId: z.string().min(1).nullable(),
  text: z.string().trim().min(1),
}).strict();

export const AssertionTypeSchema = z.enum([
  'sourced_fact',
  'committed_brain_synthesis',
  'new_connection_in_answer',
  'speculation_or_proposal',
  'human_steering_or_judgment',
]);

export const InquiryAssertionPayloadSchema = z.object({
  schema: z.literal('cosmo.inquiry-assertion-payload.v1'),
  type: AssertionTypeSchema,
  text: z.string().trim().min(1),
  claimSupports: z.array(AssertionClaimSupportSchema),
  cognitionSupports: z.array(AssertionCognitionSupportSchema),
  evidenceSupports: z.array(AssertionEvidenceSupportSchema),
  relationshipSupports: z.array(AssertionRelationshipSupportSchema),
  formationEventSupports: z.array(AssertionFormationEventSupportSchema),
  formedDuringQueryId: z.string().min(1).nullable(),
  limitation: z.string().trim().min(1).nullable(),
}).strict();

export const InquiryAssertionSchema = InquiryAssertionPayloadSchema.extend({
  assertionId: ObjectIdSchema,
}).strict();

export const InquiryVerificationFindingSchema = z.object({
  assertionId: ObjectIdSchema,
  result: z.enum(['pass', 'contest', 'block', 'escalate']),
  reason: z.string().trim().min(1),
  supportingAddresses: z.array(BrainObjectAddressSchema),
  opposingEvidenceSupports: z.array(AssertionEvidenceSupportSchema),
}).strict().superRefine((finding, context) => {
  requireUniqueCanonical(
    finding.supportingAddresses,
    context,
    ['supportingAddresses'],
  );
  requireUniqueCanonical(
    finding.opposingEvidenceSupports.map((support) => support.address),
    context,
    ['opposingEvidenceSupports'],
  );
});
```

The generator emits only `InquiryAssertionPayload[]`; it cannot provide an
`assertionId`. Admission validates a payload, hashes its canonical payload bytes
without an ID, and attaches the resulting `assertionId` to the decoded wrapper.
`InquiryAssertionSchema` is only for that decoded wrapper and verifies that
`assertionId === sha256(canonical(payload))`. Unknown/self-ID fields in a
generation payload and a forged wrapper ID are rejected.

Use `.superRefine()` to require the support appropriate to each assertion type:
EvidenceSpan and exact attributed Claim revisions for sourced fact, pre-query
attributed cognition plus `formedDuringQueryId:null` for committed synthesis,
current query ID for a new connection, a limitation for speculation without
support, and RelationshipEvent for human judgment. Claim and cognition supports
are unique by full `BrainObjectAddress`; a bare ID is accepted only by an
internal resolver after proving one exact match in the pinned materialization.
Evidence supports are unique by full address, Relationship supports are unique
by full address, and formation events by
`(sourceCommitId,journalCursor,eventId)`, so repeated logical IDs across merged
leaves remain distinct.

Define a strict Zod schema and inferred type for every produced contract named in this task. Every externally accepted or emitted object, including nested `QueryRequest`, `InquiryAssertion`, Steer payload variants, comparison changes, and federated assertions, uses `.strict()`; no layer silently strips unknown keys.

Cross-field refinements are mandatory:

- `InquiryExecutionInput.request.mode` is `ask`; comparison targets are nonempty only for `intent='compare'`, federation and comparison cannot coexist, and all commits/snapshots/perspectives are unique and canonically sorted;
- generation pins the same query/Brain as its request and one immutable context/retrieval/assertion-contract triple. Its exact `StructuredRoleExecutionInput` names the generator output schema/ref, zero tools, the same pinned ContextBundle, and server-derived runtime/mutation authority, RunId, start time, and idempotency identity;
- generation emits no free-form answer prose: its strict document contains only closed section tokens and assertion indexes, every assertion payload index appears exactly once, and the final document replaces indexes with validated assertion IDs. `InquiryAnswer.text` must byte-equal the deterministic renderer over that document and those exact assertion texts;
- verification pins the same query and generator receipt, has a distinct verifier `StructuredRoleExecutionInput`, role, RunId, ContextBundle, and verifier output schema/ref, and its finding assertion IDs equal the generated assertion set exactly once;
- every verifier finding uses full `supportingAddresses` and attributed
  `opposingEvidenceSupports`; each address resolves in the pinned
  materialization, EvidenceSpan ID/address pairs agree, and duplicate logical
  IDs from different merged leaves remain distinct rather than collapsing to
  bare object IDs;
- `InquiryAnswer.releaseable` equals the verified result and every returned assertion has a finding; blocked/escalated sourced assertions cannot remain in released text;
- every mutable ref is heads-only: Steer canonical/result refs match
  `refs/heads/<segment>`, and Invent/program-direction candidate refs match
  `refs/heads/candidates/<segment>`; tags, settled refs, and arbitrary
  `BrainRefName` values are read-only and rejected before preview;
- `WorkbenchSteerDraft.target` equals `payload.kind`, includes a target head whose resolved value must match `expectedHead`, and accepts none of the internal authority fields;
- the three Steer payload variants accept only their declared reviewed semantic fields—no nested `unknown`, raw write, actor, grant, lease, fence, runtime authorization, or timestamp;
- `WorkbenchInventDraft` uses mode `invent`, pins `request.brainCommitId === expectedHead`, requires distinct queried/candidate refs, and carries one strict Program D `CandidateFinding` whose origin is exactly `human`; the browser cannot impersonate a worker, Principal, default-mode, dream, evidence-gap, contradiction, or specialist attempt;
- a preview is a decoded content-addressed wrapper over a stored strict payload, binds the exact draft ref/hash, expected head, authenticated authority fingerprint, safe principal/scopes, closed mechanical changes, and expiry, and contains no grant, lease, fence, secret, or raw diff text;
- `MutationServiceContext` is an internal, strict, non-HTTP contract: scopes are unique and canonically sorted, `authorization` is server-derived, `domainIdempotencyKey` is the SHA-256 identity of the outer idempotency record, and `observedAt` is server time. Program F derives the public-safe authority fingerprint from the requester plus authorization; H never supplies, stores, or compares a second fingerprint algorithm;
- commit requests contain only request ID, preview ID, draft hash, and expected head; the server reloads the stored draft/preview, re-derives authority, rechecks head/hash/expiry/consumption, and constructs internal `SteerInput`/`InventInput` with server-derived mutation authority, lease/fence context, `reviewed:true`, the exact `domainIdempotencyKey`, and occurred time;
- Human Invent stores the strict draft, consumed preview, and CandidateFinding
  separately. `HumanInventOperationIntent` links those three exact refs and the
  candidate scope; the admitted `candidate_finding` event points to that intent
  rather than pretending its payload is the candidate object. The exact
  `HumanInventCandidateBranchInputSchema` must parse the E call, and its stored
  receipt/ref are retained in `InventReceipt`;
- a program-direction Steer derives `refs/heads/candidates/program-direction-<sha256(requestId,draftHash)>` inside Program F, requires that ref to be absent, writes the candidate commit only there, and leaves the reviewed canonical `targetRef` at `expectedHead`; its receipt identifies both refs and both post-operation heads without implying a canonical advance;
- `SteerReceipt` cross-field refinements require relationship/question writes to have `resultRef === targetRef`, `targetRefAfterCommitId === childCommitId`, `targetRefUnchanged:false`, `candidateRef:null`, and null program-direction recording/agenda refs; a program proposal requires `resultRef === candidateRef`, `targetRefAfterCommitId === parentCommitId`, `targetRefUnchanged:true`, and non-null exact proposal-recording/candidate-agenda receipt refs;
- every Steer/Invent receipt names the admitted D `human_operation` CognitiveEvent; `principalDecisionId` is nullable because a valid human-reviewed candidate-only operation need not fabricate a Principal model turn, but when non-null it must resolve to a decision causally downstream of that operation event;
- `WorkbenchSessionExchangeResponseSchema` is strict, uses the exact six-value scope enum, requires a `csrf_` token with 32–128 URL-safe characters and a future ISO timestamp, and is the Program F schema Program H reuses for the session-exchange response;
- Claim and Question comparisons are closed `added | removed | status_changed`
  unions. Added/removed variants name only the side that exists;
  `status_changed` alone requires both addresses and accepted transition
  provenance;
- `CompareInput` and `FederatedInquiryInput` are authority-free serializable requests; repository dependencies and `MutationAuthorization` are constructor/server context, never body fields;
- a federated result is produced by the same typed generator, assertion
  validator, distinct verifier, and release gate as a normal Ask. It includes
  both attempt receipts, exact verification, releaseability, omissions,
  limitations, and one display identity per participating commit; and
- every receipt/result binds the exact request IDs, commits, preview hash, journal range, attempt receipts, and rights disclosures it reports.

`WorkbenchBrainSummarySchema` is ref-aware: `refNames` and reachability statuses are unique/sorted, `selectedRef` is null or a member of `refNames`, and `displayLabel` is derived deterministically from the selected ref, then lexicographically first tag, then settled ref, then commit prefix with its source declared. `interactionAccess='steer'` requires a selected writable head ref whose current value equals `brainCommitId`; a detached/tagged/settled-only commit is read-only. `WorkbenchBrainCatalogSchema` sorts entries by selected active-head status, declared label, then commit ID and is the only workbench bootstrap source.

`ReadOnlyInquiryReceiptSchema` requires identical before/after authority and ref fingerprints, sorted exact commits, literal zero writes, and `refsChanged:false`. Comparison results are built from typed left/right root materializations, never from Program B's structural diff alone. Federated support attribution is a strict union derived from the actual released `InquiryAssertion` support fields; every source repeats the exact `brainSetId`, names a participating commit, and has one matching disclosure. The result builder emits only declared result fields, derives `partial`/`withheldSupportKeys`, and refuses to release a federated assertion that the distinct verifier blocked or escalated; spreading a request object into a strict response is forbidden.

Program H authenticates the session, derives authority server-side, binds `requestId` to idempotency state, reacquires leases/fences, and then constructs only the internal execution inputs. Negative contract fixtures place forbidden authority at both top level and inside every nested union variant.

- [ ] **Step 4: Add the package manifest and fixture helpers**

`packages/inquiry/package.json`:

```json
{
  "name": "@cosmo/inquiry",
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
    "@cosmo/cognition": "*",
    "@cosmo/contracts": "*",
    "@cosmo/corpus": "*",
    "@cosmo/foundation": "*",
    "@cosmo/repository": "*",
    "@cosmo/research": "*"
  }
}
```

Export deterministic fixture helpers:

```ts
export async function createInquiryFixture(
  name: string,
): Promise<{
  repository: BrainRepository;
  inquiry: InquiryService;
  commitId: BrainCommitId;
  branchRef: BrainRefName;
  corpusSnapshotIds: CorpusSnapshotId[];
  cleanup(): Promise<void>;
}>;

export function queryRequest(
  overrides: Partial<QueryRequest> = {},
): QueryRequest;
```

- [ ] **Step 5: Register and commit the source-development workspace**

Run: `npm install && npm query .workspace | jq -r '.[].name' | sort`

Expected: `@cosmo/inquiry` is linked and represented in `package-lock.json`. Development imports resolve the source export; only Program H's release staging may rewrite it to `dist`.

```bash
git add packages/inquiry/package.json packages/inquiry/tsconfig.json \
  packages/inquiry/src/index.ts packages/inquiry/test/helpers/fixtures.ts \
  package-lock.json
git commit -m "build(inquiry): register inquiry workspace"
```

- [ ] **Step 6: Run contracts and build**

Run: `npm exec --workspace @cosmo/contracts -- tsx --test test/inquiry.test.ts && npm run build --workspace @cosmo/inquiry`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/inquiry.ts packages/contracts/src/index.ts \
  packages/contracts/test/inquiry.test.ts
git commit -m "feat(inquiry): define pinned inquiry contracts"
```

## Task 2: Enforce exact pins and a mutation-free Ask scope

**Files:**
- Create: `packages/inquiry/src/pins.ts`
- Create: `packages/inquiry/src/ask.ts`
- Create: `packages/inquiry/test/pins.test.ts`
- Create: `packages/inquiry/test/ask.test.ts`
- Modify: `packages/inquiry/src/index.ts`

**Interfaces:**
- Consumes: exact commit/corpus pins and Program E `LivingBrainService`.
- Produces: `PinnedInquiryContext`, `AuthorityFingerprint`, and `InquiryService.ask()`.

- [ ] **Step 1: Write failing pin and read-only tests**

```ts
test('Ask rejects a corpus snapshot not pinned by the Brain commit', async () => {
  const fixture = await createInquiryFixture('wrong-corpus');
  try {
    await assert.rejects(
      () => fixture.inquiry.ask({
        request: queryRequest({
          brainCommitId: fixture.commitId,
          corpusSnapshotIds: [sha('f')],
        }),
        comparisonTargets: [],
        federation: null,
        perspectiveIds: [],
      }),
      { code: 'inquiry_snapshot_not_pinned' },
    );
  } finally {
    await fixture.cleanup();
  }
});

test('Ask leaves branch head and every canonical root unchanged', async () => {
  const fixture = await createInquiryFixture('read-only');
  try {
    const before = await authorityFingerprint(
      fixture.repository,
      fixture.branchRef,
      fixture.commitId,
    );
    await fixture.inquiry.ask({
      request: queryRequest({
        brainCommitId: fixture.commitId,
        corpusSnapshotIds: fixture.corpusSnapshotIds,
      }),
      comparisonTargets: [],
      federation: null,
      perspectiveIds: [],
    });
    const after = await authorityFingerprint(
      fixture.repository,
      fixture.branchRef,
      fixture.commitId,
    );
    assert.deepEqual(after, before);
  } finally {
    await fixture.cleanup();
  }
});

test('Ask execution has neither tools, network, nor mutation capability', async () => {
  const port = capabilityInspectingInquiryPort();
  const fixture = await createInquiryFixture('capabilities', { executionPort: port });
  try {
    await fixture.inquiry.ask(defaultInquiryInput(fixture));
    assert.deepEqual(port.receivedCapabilities, {
      network: false,
      tools: false,
      canonicalMutation: false,
      relationshipMutation: false,
    });
  } finally {
    await fixture.cleanup();
  }
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/pins.test.ts test/ask.test.ts`

Expected: FAIL because pin resolution and Ask do not exist.

- [ ] **Step 3: Implement exact pin resolution**

```ts
export async function resolvePinnedContext(
  repository: BrainRepository,
  livingBrain: LivingBrainService,
  input: InquiryExecutionInput,
): Promise<PinnedInquiryContext> {
  const commit = await repository.commits.get(input.request.brainCommitId);
  const requested = [...input.request.corpusSnapshotIds].sort();
  const pinned = [...commit.payload.corpusSnapshotIds].sort();
  if (!arrayEqual(requested, pinned)) {
    throw typedError('inquiry_snapshot_not_pinned', { requested, pinned });
  }
  return Object.freeze({
    request: input.request,
    commit,
    brain: await livingBrain.materialize(commit.commitId),
    comparisonTargets: input.comparisonTargets,
    federation: input.federation,
    perspectiveIds: input.perspectiveIds,
  });
}
```

Do not resolve a branch name inside Ask; the request pins a commit ID. If a UI starts from a branch, it resolves the branch before constructing `QueryRequest` and displays the resulting commit.
Program H derives `readAuthorization` from the authenticated server-side session and constructs an authorized `LivingBrainService` plus Corpus read service for the request; the browser never sends an actor identity, capability grant, fencing token, or repository authorization. Public objects need no object-read authorization, while private/restricted object payloads fail closed without `object:read`.

- [ ] **Step 4: Fingerprint authority before and after generation**

Fingerprint the queried branch head when supplied for display, commit ID, every canonical root, journal range, Principal version, kernel version, and corpus snapshots. Supply the execution port only immutable projected context and:

```ts
capabilities: {
  network: false,
  tools: false,
  canonicalMutation: false,
  relationshipMutation: false,
}
```

After generation and verification, recompute the fingerprint. Throw `ask_mutated_authority` and withhold the answer if any field changed.

- [ ] **Step 5: Run focused and package tests**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/pins.test.ts test/ask.test.ts && npm test --workspace @cosmo/inquiry`

Expected: PASS; wrong snapshots fail and Ask leaves all authority bytes unchanged.

- [ ] **Step 6: Commit**

```bash
git add packages/inquiry/src/pins.ts packages/inquiry/src/ask.ts \
  packages/inquiry/src/index.ts packages/inquiry/test/pins.test.ts \
  packages/inquiry/test/ask.test.ts
git commit -m "feat(inquiry): enforce read only pinned ask"
```

## Task 3: Implement intent-specific retrieval without universal dream filtering

**Files:**
- Create: `packages/inquiry/src/retrieval.ts`
- Create: `packages/inquiry/test/retrieval.test.ts`
- Modify: `packages/inquiry/src/ask.ts`
- Modify: `packages/inquiry/src/index.ts`

**Interfaces:**
- Consumes: `PinnedInquiryContext`, Program E activation/formation, Program C evidence and negative knowledge.
- Produces: `buildRetrievalPlan()` and bounded `InquiryProjection`.

- [ ] **Step 1: Write failing intent-policy tests**

```ts
test('surprise retrieval includes dream lineage but labels candidate status', () => {
  const plan = buildRetrievalPlan(queryRequest({ intent: 'surprise' }));
  assert.equal(plan.includeOrigins.includes('dream'), true);
  assert.equal(plan.includeCandidateCognition, true);
  assert.equal(plan.requirePriorExpectation, true);
  assert.equal(plan.assertionLabelingRequired, true);
});

test('audit retrieval prioritizes evidence, reviews, and contradictions', () => {
  const plan = buildRetrievalPlan(queryRequest({ intent: 'audit' }));
  assert.deepEqual(plan.primaryObjectKinds, [
    'claim',
    'evidence_span',
    'review_finding',
    'contradiction',
    'negative_knowledge',
  ]);
  assert.equal(plan.includeRuntimeTranscript, false);
});

test('answer does not erase a supported synthesis because it originated in dream', async () => {
  const projection = await projectIntent(
    queryRequest({ intent: 'answer' }),
    supportedDreamDescendantFixture(),
  );
  assert.equal(
    projection.nodes.some((node) => node.nodeId === sha('d')),
    true,
  );
  assert.equal(projection.nodes.find((node) => node.nodeId === sha('d'))?.origin, 'dream');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/retrieval.test.ts`

Expected: FAIL because intent retrieval is absent.

- [ ] **Step 3: Implement the complete intent table**

Use this exact policy:

| Intent | Primary cognition | Special requirement |
| --- | --- | --- |
| `answer` | supported/contested claims, syntheses, contradictions, evidence, scoped negative knowledge | include a dream-origin descendant if its current status and lineage qualify; do not include raw dream prose by default |
| `explore` | concepts, typed cross-domain edges, perspectives, hypotheses, questions | include labeled specialist/default-mode/dream candidates |
| `surprise` | prior expectations, bridge edges, candidate events, challenges, later outcomes | require exact formation lineage and why it matters under the Covenant |
| `reflect` | Question/Program trajectory, RelationshipEvents, commits, wake briefings | separate human judgment from system synthesis |
| `challenge` | opposing evidence, contradictions, disconfirmations, failed routes | prioritize counterevidence over fluent restatement |
| `audit` | claims, EvidenceSpans, reviews, policies, integrity findings | reconstruct every asserted source chain |
| `unknowns` | active/incubating/dormant questions, gaps, inaccessible sources, negative knowledge | preserve search scope and limits |
| `compare` | exact commit diff or attributed BrainSet results | no union or write |
| `formation` | bounded Program E causal trace | no semantic-similarity reconstruction |
| `promote` | candidate, reviews, policy prerequisites, open blocks | read-only eligibility in Ask; mutation only through explicit Steer/Invent |

```ts
export const INTENT_POLICIES: Readonly<Record<QueryRequest['intent'], RetrievalPlan>> =
  Object.freeze({
    answer: plan(['claim', 'synthesis', 'contradiction', 'evidence_span', 'negative_knowledge']),
    explore: plan(['concept', 'edge', 'perspective', 'hypothesis', 'question'], {
      includeOrigins: ['specialist', 'default_mode', 'dream'],
      includeCandidateCognition: true,
    }),
    surprise: plan(['expectation', 'edge', 'candidate_event', 'review_finding', 'outcome'], {
      includeOrigins: ['specialist', 'default_mode', 'dream'],
      requirePriorExpectation: true,
    }),
    reflect: plan(['question', 'program_event', 'relationship_event', 'brain_commit', 'wake_briefing']),
    challenge: plan(['opposing_evidence', 'contradiction', 'disconfirmation', 'negative_knowledge']),
    audit: plan(['claim', 'evidence_span', 'review_finding', 'contradiction', 'negative_knowledge']),
    unknowns: plan(['question', 'evidence_gap', 'inaccessible_source', 'negative_knowledge']),
    compare: plan(['brain_diff']),
    formation: plan(['formation_trace']),
    promote: plan(['candidate_finding', 'review_finding', 'promotion_prerequisite', 'honest_block']),
  });
```

- [ ] **Step 4: Bound every projection**

Require explicit `maxNodes`, `maxEdges`, `maxEvidenceSpans`, `maxJournalRecords`, and `maxBytes` from a content-addressed retrieval policy. Sort deterministically, report omissions, and never replace omitted mandatory units with a runtime-generated summary.

```ts
export function enforceProjectionLimits(
  projection: InquiryProjection,
  limits: RetrievalLimits,
): InquiryProjection {
  const bounded = {
    ...projection,
    nodes: stableRank(projection.nodes).slice(0, limits.maxNodes),
    edges: stableRank(projection.edges).slice(0, limits.maxEdges),
    evidenceSpans: stableRank(projection.evidenceSpans)
      .slice(0, limits.maxEvidenceSpans),
    journalRecords: stableRank(projection.journalRecords)
      .slice(0, limits.maxJournalRecords),
  };
  const encoded = canonicalBytes(bounded);
  if (encoded.byteLength > limits.maxBytes) {
    throw typedError('inquiry_projection_too_large', {
      byteLength: encoded.byteLength,
      maxBytes: limits.maxBytes,
    });
  }
  return Object.freeze({
    ...bounded,
    omissions: exactOmissions(projection, bounded),
  });
}
```

- [ ] **Step 5: Run focused and package tests**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/retrieval.test.ts && npm test --workspace @cosmo/inquiry`

Expected: PASS; intent changes retrieval and no global dream/reasoning exclusion exists.

- [ ] **Step 6: Commit**

```bash
git add packages/inquiry/src/retrieval.ts packages/inquiry/src/ask.ts \
  packages/inquiry/src/index.ts packages/inquiry/test/retrieval.test.ts
git commit -m "feat(inquiry): add intent specific retrieval"
```

## Task 4: Validate the five answer assertion types and provenance ledger

**Files:**
- Create: `packages/inquiry/src/assertions.ts`
- Create: `packages/inquiry/test/assertions.test.ts`
- Modify: `packages/inquiry/src/ask.ts`
- Modify: `packages/inquiry/src/index.ts`

**Interfaces:**
- Consumes: generated structured assertions, pinned Brain, Program C EvidenceSpans/Claims, Program E formation, and RelationshipEvents.
- Produces: `validateAssertions()` and `AssertionProvenanceLedger`.

- [ ] **Step 1: Write failing assertion-support tests**

```ts
test('sourced fact requires an exact pinned EvidenceSpan', async () => {
  const result = await validateAssertions([
    assertionPayloadFixture({
      type: 'sourced_fact',
      evidenceSupports: [],
      limitation: null,
    }),
  ], assertionValidationContext());
  assert.deepEqual(result.errors.map((error) => error.code), [
    'sourced_fact_missing_evidence',
  ]);
});

test('committed synthesis must pre-exist the query', async () => {
  const result = await validateAssertions([
    assertionPayloadFixture({
      type: 'committed_brain_synthesis',
      cognitionSupports: [attributedCognitionSupport('science', sha('f'))],
      formedDuringQueryId: 'query_1',
    }),
  ], assertionValidationContext({ queriedCommitContains: [] }));
  assert.equal(result.errors[0]?.code, 'synthesis_not_in_pinned_brain');
});

test('a query-time bridge is admitted only as new-in-answer cognition', async () => {
  const result = await validateAssertions([
    assertionPayloadFixture({
      type: 'new_connection_in_answer',
      cognitionSupports: [],
      formedDuringQueryId: 'query_1',
    }),
  ], assertionValidationContext());
  assert.equal(result.assertions[0]?.type, 'new_connection_in_answer');
  assert.equal(result.assertions[0]?.formedDuringQueryId, 'query_1');
});

test('the generator cannot choose or forge an assertion content ID', async () => {
  const payload = assertionPayloadFixture({ type: 'sourced_fact' });
  assert.equal(InquiryAssertionPayloadSchema.safeParse({
    ...payload,
    assertionId: sha('forged'),
  }).success, false);
  const admitted = await validateAssertion(
    payload,
    assertionValidationContext(),
  );
  assert.equal(admitted.assertionId, await canonicalSha256(payload));
  assert.equal(InquiryAssertionSchema.safeParse({
    ...admitted,
    assertionId: sha('different'),
  }).success, false);
});

test('merged logical Relationship/Event IDs retain distinct attribution', () => {
  const payload = assertionPayloadFixture({
    type: 'human_steering_or_judgment',
    relationshipSupports: [
      attributedRelationshipSupport('history', 'rel_same'),
      attributedRelationshipSupport('science', 'rel_same'),
    ],
    formationEventSupports: [
      attributedFormationEventSupport('history', 'evt_same', '41'),
      attributedFormationEventSupport('science', 'evt_same', '87'),
    ],
  });
  const parsed = InquiryAssertionPayloadSchema.parse(payload);
  assert.equal(parsed.relationshipSupports.length, 2);
  assert.notDeepEqual(
    parsed.relationshipSupports[0]?.address,
    parsed.relationshipSupports[1]?.address,
  );
  assert.notEqual(
    parsed.formationEventSupports[0]?.sourceCommitId,
    parsed.formationEventSupports[1]?.sourceCommitId,
  );
});

test('merged EvidenceSpan IDs retain their exact leaf addresses', () => {
  const payload = assertionPayloadFixture({
    type: 'sourced_fact',
    evidenceSupports: [
      attributedEvidenceSupport('history', sha('same-span')),
      attributedEvidenceSupport('science', sha('same-span')),
    ],
  });
  const parsed = InquiryAssertionPayloadSchema.parse(payload);
  assert.equal(parsed.evidenceSupports.length, 2);
  assert.equal(
    parsed.evidenceSupports[0]?.evidenceSpanId,
    parsed.evidenceSupports[1]?.evidenceSpanId,
  );
  assert.notDeepEqual(
    parsed.evidenceSupports[0]?.address,
    parsed.evidenceSupports[1]?.address,
  );
});

test('verifier keeps opposing EvidenceSpan attribution by leaf', () => {
  const finding = InquiryVerificationFindingSchema.parse({
    assertionId: sha('assertion'),
    result: 'contest',
    reason: 'The two leaves disagree.',
    supportingAddresses: [
      brainObjectAddress('history', 'epistemicRoot', sha('support')),
    ],
    opposingEvidenceSupports: [
      attributedEvidenceSupport('history', sha('same-span')),
      attributedEvidenceSupport('science', sha('same-span')),
    ],
  });
  assert.equal(finding.opposingEvidenceSupports.length, 2);
  assert.notDeepEqual(
    finding.opposingEvidenceSupports[0]?.address,
    finding.opposingEvidenceSupports[1]?.address,
  );
});

test('human judgment cites an exact RelationshipEvent', async () => {
  const result = await validateAssertions([
    assertionPayloadFixture({
      type: 'human_steering_or_judgment',
      relationshipSupports: [],
    }),
  ], assertionValidationContext());
  assert.equal(result.errors[0]?.code, 'human_judgment_missing_relationship_event');
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/assertions.test.ts`

Expected: FAIL because assertion validation is absent.

- [ ] **Step 3: Implement type-specific validation**

For every assertion:

- compute `assertionId` from canonical assertion bytes;
- ensure all referenced objects occur in the pinned read set;
- require source/claim/review lineage for `sourced_fact`;
- require a pre-query CognitionNode and formation events for `committed_brain_synthesis`;
- require `formedDuringQueryId === request.queryId` for `new_connection_in_answer`; the workbench derives its visible “No accumulated-cognition credit” label from this exact type rather than storing an extra truth-like field;
- require explicit uncertainty/limitation for unsupported `speculation_or_proposal`;
- require exact committed `RelationshipEvent` identity for `human_steering_or_judgment`; and
- preserve opposing evidence and unresolved verifier findings.

```ts
export async function validateAssertion(
  candidate: InquiryAssertionPayload,
  context: AssertionValidationContext,
): Promise<InquiryAssertion> {
  const assertion = InquiryAssertionPayloadSchema.parse(candidate);
  if (assertion.type === 'sourced_fact') {
    requirePinnedEvidence(assertion.evidenceSupports, context);
    requireSupportedClaims(assertion.claimSupports, context);
  } else if (assertion.type === 'committed_brain_synthesis') {
    requirePreQueryNodes(assertion.cognitionSupports, context);
    requirePreQueryFormation(assertion.formationEventSupports, context);
    if (assertion.formedDuringQueryId !== null) {
      throw typedError('synthesis_formed_during_query');
    }
  } else if (assertion.type === 'new_connection_in_answer') {
    if (assertion.formedDuringQueryId !== context.queryId) {
      throw typedError('new_connection_wrong_query');
    }
  } else if (assertion.type === 'speculation_or_proposal') {
    if (assertion.limitation === null) {
      throw typedError('speculation_missing_limitation');
    }
  } else {
    requireRelationshipEvents(assertion.relationshipSupports, context);
  }
  return InquiryAssertionSchema.parse({
    ...assertion,
    assertionId: await canonicalSha256(assertion),
  });
}
```

- [ ] **Step 4: Make unlabeled prose structurally impossible**

The generator returns `InquiryAssertionPayload[]` plus a
`GeneratedAnswerDocument` containing only closed section tokens and assertion
indexes. Validate/hash the payloads first, replace each index with the resulting
assertion ID, require every index exactly once, and derive final `text`
mechanically from the closed section labels and assertion texts. There is no
free-prose block, connector exception, or generator-supplied heading in which an
untyped assertion can hide. Do not infer assertion type from tone.

```ts
export function assertFullTextCoverage(
  generated: GeneratedAnswerDocument,
  assertions: readonly InquiryAssertion[],
): { document: AnswerDocument; text: string } {
  requireExactIndexCoverage(
    generated.blocks
      .filter((block) => block.kind === 'assertion')
      .map((block) => block.assertionIndex),
    assertions.length,
  );
  const document = AnswerDocumentSchema.parse({
    schema: 'cosmo.answer-document.v1',
    blocks: generated.blocks.map((block) =>
      block.kind === 'section'
        ? block
        : { kind: 'assertion', assertionId: assertions[
            block.assertionIndex
          ]!.assertionId }),
  });
  return {
    document,
    text: renderAnswerDocument(document, assertions),
  };
}
```

- [ ] **Step 5: Run focused and package tests**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/assertions.test.ts && npm test --workspace @cosmo/inquiry`

Expected: PASS; each type has reconstructable support or a visible limitation.

- [ ] **Step 6: Commit**

```bash
git add packages/inquiry/src/assertions.ts packages/inquiry/src/ask.ts \
  packages/inquiry/src/index.ts packages/inquiry/test/assertions.test.ts
git commit -m "feat(inquiry): type every answer assertion"
```

## Task 5: Implement Production Inquiry Execution and an Independent Verifier

**Files:**
- Create: `packages/inquiry/src/verifier.ts`
- Create: `packages/inquiry/src/production-execution-port.ts`
- Create: `packages/inquiry/test/verifier.test.ts`
- Create: `packages/inquiry/test/production-execution-port.test.ts`
- Modify: `packages/inquiry/src/ask.ts`
- Modify: `packages/inquiry/src/index.ts`

**Interfaces:**
- Consumes: published answer assertions, pinned evidence/Brain support,
  `InquiryExecutionPort.verify()`, evidence policy, and Program D's injected
  contracts-only `StructuredRoleExecutionPort`.
- Produces: `ProductionInquiryExecutionPort`, separately receipted generator/verifier attempts, and `InquiryVerification` with pass/contest/block/escalate findings.

- [ ] **Step 1: Write failing independence and hidden-context tests**

```ts
test('generator and verifier attempts must be distinct', async () => {
  await assert.rejects(
    () => verifyInquiryAnswer(
      generatedAnswerFixture({ attemptId: 'run_same' }),
      verificationFixture({ attemptId: 'run_same' }),
      verifierPolicy(),
    ),
    { code: 'inquiry_verifier_not_independent' },
  );
});

test('verifier input excludes generator rationale and unpublished context', async () => {
  const port = recordingVerificationPort();
  await runIndependentVerification(
    generatedAnswerFixture({
      hiddenRationale: 'unpublished chain of thought',
      unpublishedContext: { secret: true },
    }),
    pinnedVerificationContext(),
    port,
  );
  const serialized = JSON.stringify(port.received);
  assert.equal(serialized.includes('unpublished chain of thought'), false);
  assert.equal(serialized.includes('"secret":true'), false);
});

test('a blocked sourced assertion withholds the answer', async () => {
  const result = applyVerification(
    generatedAnswerFixture(),
    verificationFixture({
      findings: [{
        assertionId: sha('a'),
        result: 'block',
        reason: 'citation does not entail claim',
      }],
    }),
  );
  assert.equal(result.releaseable, false);
});

test('production generation and verification use the shared structured seam with separate attempts and roles', async () => {
  const structuredExecution = recordingStructuredRoleExecutionPort();
  const port = productionInquiryPort({ structuredExecution });
  const generation = await port.generate(inquiryGenerationInput());
  const verification = await port.verify(inquiryVerificationInput(generation));

  assert.notEqual(generation.attemptReceipt.attemptId, verification.attemptReceipt.attemptId);
  assert.equal(generation.attemptReceipt.role, 'generator');
  assert.equal(verification.attemptReceipt.role, 'verifier');
  assert.notEqual(
    generation.attemptReceipt.contextBundleId,
    verification.attemptReceipt.contextBundleId,
  );
  assert.deepEqual(generation.attemptReceipt.allowedToolNames, []);
  assert.deepEqual(verification.attemptReceipt.allowedToolNames, []);
  assert.equal(generation.attemptReceipt.semanticAcceptanceEligible, false);
  assert.equal(verification.attemptReceipt.semanticAcceptanceEligible, false);
  assert.equal(
    structuredExecution.calls[0]?.context.payload.executionPlan.roleName,
    'COSMO Inquiry Generator',
  );
  assert.equal(
    structuredExecution.calls[1]?.context.payload.executionPlan.roleName,
    'COSMO Independent Verifier',
  );
  assert.equal(
    structuredExecution.calls[0]?.context.payload.executionPlan.outputSchemaName,
    'cosmo.inquiry-generation.v1',
  );
  assert.equal(
    structuredExecution.calls[1]?.context.payload.executionPlan.outputSchemaName,
    'cosmo.inquiry-verification.v1',
  );
});

test('production port rejects recorded or deterministic runtime identity in live mode', async () => {
  const port = productionInquiryPort({
    structuredExecution: recordingStructuredRoleExecutionPort({
      executionClass: 'deterministic_conformance',
    }),
    mode: 'live_required',
  });
  await assert.rejects(
    port.generate(inquiryGenerationInput()),
    { code: 'production_inquiry_runtime_required' },
  );
});

test('inquiry roles cannot cross the worker-event output seam', async () => {
  const input = inquiryGenerationInput();
  await assert.rejects(
    productionInquiryPort({
      structuredExecution: recordingStructuredRoleExecutionPort({
        outputSchemaRef: workerOutputBatchSchemaRef(),
      }),
    }).generate(input),
    { code: 'inquiry_output_schema_mismatch' },
  );
});
```

- [ ] **Step 2: Run both tests and verify they fail**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/verifier.test.ts test/production-execution-port.test.ts`

Expected: FAIL because production execution and independent verification are absent.

- [ ] **Step 3: Implement the production inquiry port over D's shared structured-role seam**

`ProductionInquiryExecutionPort` receives Program D's
`StructuredRoleExecutionPort`, immutable generator/verifier role definitions,
and a mode of `contract_only` or `live_required`. Each internal input contains
an already-stored zero-tool Expedition, bounded COSMO-owned `ContextBundle`,
exact runtime/mutation authorization, RunId, start time, idempotency identity,
and owner-defined output schema ref. `generate()` passes that exact
`StructuredRoleExecutionInput` to the shared port and reparses its returned
canonical JSON with `InquiryGenerationSchema`; `verify()` does the same with a
fresh run, fresh authorization, distinct verifier role/context, and
`InquiryVerificationSchema`.

The port verifies `StructuredRoleExecutionResult.outputSchemaRef`,
`outputRef`, `outputHash`, and `runtimeReceiptRecording` against the exact
stored output and schema before it constructs `InquiryAttemptReceipt`. It does
not persist a second runtime receipt or accept caller-supplied
provider/model/adapter claims. The receipt repeats the exact output schema/ref
pair and actual Program D `RuntimeReceipt.executionClass`. In `live_required`
it requires `executionClass === 'live_provider'` and rejects deterministic,
recorded, replay, mock, missing-provider, fallback, or same-attempt identities.
In `contract_only`, deterministic structured execution may prove schema/fault
behavior but the resulting receipt sets `semanticAcceptanceEligible:false`.
Program G's signed profile must select `live_required` for generator and
verifier trials.

The generator context includes the pinned Brain projection, question, retrieval output, assertion-payload contract, and closed generated-document contract. It emits payloads and assertion indexes, never IDs or free prose. Program F validates and hashes the payloads, transforms the document to exact assertion IDs, and derives final text before constructing verifier input. The verifier receives only those published candidate assertions and pinned support listed below. Neither role receives worker envelopes, hidden chain-of-thought, SDK session history, or mutable service access. Program F has no `@cosmo/runtime` dependency and cannot instantiate an SDK/provider path.

- [ ] **Step 4: Implement verifier isolation**

Verifier input contains only:

- query text and intent;
- published candidate answer assertions;
- exact pinned evidence and Brain objects used;
- declared retrieval omissions;
- EvidencePolicy/AcceptanceProfile verifier rules; and
- generator model/runtime receipt identity without hidden rationale.

Require a distinct attempt ID. Allow the same provider only when the pinned policy explicitly says so; record the limitation. The verifier cannot call mutation services.

```ts
const assertionValidation = await validateAssertions(
  generation.assertionPayloads,
  assertionValidationContextFromPinnedQuery(context),
);
const assertions = requireValidAssertions(assertionValidation);
const rendered = assertFullTextCoverage(generation.document, assertions);
const verificationInput = InquiryVerificationInputSchema.parse({
  schema: 'cosmo.inquiry-verification-input.v1',
  queryId: generation.queryId,
  query: request.text,
  intent: request.intent,
  assertions,
  pinnedSupportRefs: projectPublishedSupportRefs(generation, context),
  omissions: context.projection.omissions,
  verifierPolicyRef: context.verifierPolicyRef,
  generatorAttemptReceipt: generation.attemptReceipt,
  execution: freshVerifierStructuredExecutionInput(context),
  capabilities: {
    network: false,
    tools: false,
    mutation: false,
  },
});
const verification = await executionPort.verify(verificationInput);
if (
  verification.attemptReceipt.attemptId
  === generation.attemptReceipt.attemptId
) {
  throw typedError('inquiry_verifier_not_independent');
}
```

- [ ] **Step 5: Apply exact release behavior**

- `pass` — assertion may be returned;
- `contest` — return with visible dispute and opposing evidence;
- `block` — withhold the affected sourced assertion and mark answer incomplete;
- `escalate` — return no high-stakes conclusion and show the review requirement.

Preserve every disagreement in the answer receipt.

```ts
for (const finding of verification.findings) {
  if (finding.result === 'block') release.withhold(finding.assertionId);
  if (finding.result === 'contest') release.annotateContest(finding);
  if (finding.result === 'escalate') release.requireEscalation(finding);
  if (finding.result === 'pass') release.markVerified(finding.assertionId);
}
return release.finalize({
  releaseable: !verification.findings.some(
    (finding) => finding.result === 'block' || finding.result === 'escalate',
  ),
  preservedFindings: verification.findings,
});
```

- [ ] **Step 6: Run focused and package tests**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/verifier.test.ts test/production-execution-port.test.ts && npm test --workspace @cosmo/inquiry`

Expected: PASS; self-verification and hidden-rationale leakage fail closed.

- [ ] **Step 7: Commit**

```bash
git add packages/inquiry/src/verifier.ts packages/inquiry/src/production-execution-port.ts \
  packages/inquiry/src/ask.ts packages/inquiry/src/index.ts \
  packages/inquiry/test/verifier.test.ts \
  packages/inquiry/test/production-execution-port.test.ts
git commit -m "feat(inquiry): independently verify answers"
```

## Task 6: Explain idea formation and answer “What surprised you?”

**Files:**
- Modify: `packages/contracts/src/inquiry.ts`
- Modify: `packages/contracts/test/inquiry.test.ts`
- Create: `packages/inquiry/src/formation.ts`
- Create: `packages/inquiry/test/formation.test.ts`
- Modify: `packages/inquiry/src/ask.ts`
- Modify: `packages/inquiry/src/index.ts`

**Interfaces:**
- Consumes: Program E `FormationTraceTarget`, `FormationTraceTargetSchema`, `FormationTraceLimits`, and `traceFormation()` unchanged, plus pinned Covenant/Relationship state, contradictions, challenges, and commit diffs.
- Produces: strict `FormationInquirySchema`/`FormationInquiry`, `FormationExplanationSchema`/`FormationExplanation`, and `SurpriseExplanationSchema`/`SurpriseExplanation`.

Freeze the serializable formation request and response before implementation:

```ts
export interface FormationInquiry {
  schema: 'cosmo.formation-inquiry.v1';
  brainCommitId: BrainCommitId;
  target: FormationTraceTarget;
}

export interface FormationExplanation {
  schema: 'cosmo.formation-explanation.v1';
  brainCommitId: BrainCommitId;
  requestedTarget: FormationTraceTarget;
  resolvedTarget: LayerNodeAddress;
  nodes: FormationTrace['nodes'];
  edges: FormationTrace['edges'];
  events: FormationTrace['events'];
  originKinds: QuestionOrigin[];
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
  missing: FormationTrace['missing'];
  inferredEvents: [];
  summary: string;
}
```

Both schemas are `.strict()`, import Program E's sole
`FormationTraceTargetSchema`, preserve the requested target byte-for-byte, and
return Program E's exact `resolvedTarget`. A bare read target is accepted only
when Program E proves one exact match; merged ambiguity fails. Nodes, edges,
and chronological events retain the addressed trace shapes without flattening.
`FormationExplanationSchema` requires `inferredEvents` to be the empty tuple;
missing history is reported, never invented.

- [ ] **Step 1: Write failing formation and surprise tests**

```ts
test('formation explanation is an explicit bounded causal subgraph', async () => {
  const fixture = formationInquiryFixture();
  const explanation = await explainFormation(
    fixture.input,
    { maxNodes: 30, maxEdges: 60, maxJournalRecords: 100 },
    fixture.livingBrain,
  );
  assert.deepEqual(explanation.resolvedTarget, {
    sourceCommitId: sha('a'),
    rootKind: 'topologyRoot',
    rootObjectId: sha('9'),
    objectId: sha('0'),
  });
  assert.deepEqual(explanation.originKinds, ['specialist', 'dream']);
  assert.deepEqual(explanation.evidenceSpanIds, [sha('1'), sha('2')]);
  assert.deepEqual(explanation.candidateEventIds, ['evt_candidate_1']);
  assert.deepEqual(explanation.principalDecisionIds, [sha('3')]);
  assert.deepEqual(explanation.researchReceiptRefs,
    fixture.trace.researchReceiptRefs);
  assert.deepEqual(explanation.runtimeReceiptRefs,
    fixture.trace.runtimeReceiptRefs);
  assert.deepEqual(explanation.semanticRoleAttemptRefs,
    fixture.trace.semanticRoleAttemptRefs);
  assert.deepEqual(explanation.committedCandidateReviewReceiptRefs,
    fixture.trace.committedCandidateReviewReceiptRefs);
  assert.deepEqual(explanation.humanInventDraftRefs,
    fixture.trace.humanInventDraftRefs);
  assert.deepEqual(explanation.humanInventPreviewRefs,
    fixture.trace.humanInventPreviewRefs);
  assert.equal(explanation.inferredEvents.length, 0);
});

test('incomplete idea history is disclosed instead of reconstructed', async () => {
  const fixture = incompleteFormationInquiryFixture();
  const explanation = await explainFormation(
    fixture.input,
    { maxNodes: 30, maxEdges: 60, maxJournalRecords: 100 },
    fixture.livingBrain,
  );
  assert.equal(explanation.complete, false);
  assert.deepEqual(explanation.missing, ['candidate_event']);
  assert.match(explanation.summary, /history is incomplete/i);
});

test('formation preserves exact runtime, review, and Human Invent gaps', async () => {
  const fixture = incompleteFormationInquiryFixture({
    missing: [
      'runtime_receipt',
      'semantic_role_attempt',
      'committed_candidate_review_receipt',
      'human_invent_draft',
      'human_invent_preview',
    ],
  });
  const explanation = await explainFormation(
    fixture.input,
    { maxNodes: 30, maxEdges: 60, maxJournalRecords: 100 },
    fixture.livingBrain,
  );
  assert.deepEqual(explanation.missing, fixture.trace.missing);
});

test('a surprise names expectation, bridge, counterevidence, and next question', async () => {
  const result = await explainSurprise(surpriseFixture());
  assert.equal(result.priorExpectation.length > 0, true);
  assert.equal(result.newConnectionNodeAddresses.length, 2);
  assert.equal(result.counterEvidenceSpanIds.length > 0, true);
  assert.equal(result.nextQuestionId.startsWith('q_'), true);
  assert.equal(result.assertionTypes.includes('speculation_or_proposal'), true);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/formation.test.ts`

Expected: FAIL because formation/surprise composition is absent.

- [ ] **Step 3: Implement formation explanations over exact Program E traces**

Return source EvidenceSpans, prior claims/questions, candidate events, specialist perspectives, dream/expedition origin, review challenges, contradictions, Principal decision, commit diff, and revisions. Respect caller limits and carry `complete`, `missing`, and `inferredEvents: []`.

```ts
export async function explainFormation(
  input: FormationInquiry,
  limits: FormationTraceLimits,
  livingBrain: Pick<LivingBrainService, 'traceFormation'>,
): Promise<FormationExplanation> {
  const trace = await livingBrain.traceFormation(
    input.brainCommitId,
    input.target,
    limits,
  );
  return FormationExplanationSchema.parse({
    schema: 'cosmo.formation-explanation.v1',
    brainCommitId: input.brainCommitId,
    requestedTarget: trace.requestedTarget,
    resolvedTarget: trace.resolvedTarget,
    nodes: trace.nodes,
    edges: trace.edges,
    events: trace.events,
    originKinds: collectOrigins(trace),
    evidenceSpanIds: trace.evidenceSpanIds,
    candidateEventIds: trace.candidateEventIds,
    reviewFindingIds: trace.reviewFindingIds,
    principalDecisionIds: trace.principalDecisionIds,
    researchReceiptRefs: trace.researchReceiptRefs,
    runtimeReceiptRefs: trace.runtimeReceiptRefs,
    semanticRoleAttemptRefs: trace.semanticRoleAttemptRefs,
    committedCandidateReviewReceiptRefs:
      trace.committedCandidateReviewReceiptRefs,
    humanInventDraftRefs: trace.humanInventDraftRefs,
    humanInventPreviewRefs: trace.humanInventPreviewRefs,
    commitIds: trace.commitIds,
    complete: trace.complete,
    missing: trace.missing,
    inferredEvents: [],
    summary: trace.complete
      ? summarizePublishedTrace(trace)
      : `Idea history is incomplete: ${trace.missing.join(', ')}`,
  });
}
```

- [ ] **Step 4: Implement the complete surprise contract**

A surprise must include:

```ts
{
  priorExpectation,
  priorExpectationNodeAddresses,
  newConnection,
  newConnectionNodeAddresses,
  formationTrace,
  whyItMattersUnderCovenant,
  counterEvidenceSpanIds,
  assertionTypes,
  nextQuestionId,
}
```

Both address arrays contain full `BrainObjectAddress` values and remain
distinct across merged leaves even when `objectId` bytes match. If no prior
expectation or pre-query bridge exists, label the result as
`new_connection_in_answer`; do not claim accumulated surprise.

- [ ] **Step 5: Run focused and package tests**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/formation.test.ts && npm test --workspace @cosmo/inquiry`

Expected: PASS; formation is causal and surprise cannot be improvised retrospectively.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/inquiry.ts packages/contracts/test/inquiry.test.ts \
  packages/inquiry/src/formation.ts packages/inquiry/src/ask.ts \
  packages/inquiry/src/index.ts packages/inquiry/test/formation.test.ts
git commit -m "feat(inquiry): explain cognitive formation"
```

## Task 7: Add exact commit comparison and read-only Brain federation

**Files:**
- Create: `packages/inquiry/src/compare.ts`
- Create: `packages/inquiry/test/compare.test.ts`
- Modify: `packages/inquiry/src/ask.ts`
- Modify: `packages/inquiry/src/index.ts`

**Interfaces:**
- Consumes: Program B `diff()`/`federate()`, Program E `LivingBrainService.materialize()`, D Artifact-index materialization, and an injected read-authority/ref fingerprint port.
- Produces: attributed `ComparisonResult` and `FederatedInquiryResult`.

- [ ] **Step 1: Write failing comparison/federation immutability tests**

```ts
test('comparison reports exact roots, statuses, and activation changes', async () => {
  const fixture = compareFixture();
  const result = await compareCommits(fixture.input, fixture.dependencies);
  assert.equal(result.leftCommitId, sha('a'));
  assert.equal(result.rightCommitId, sha('b'));
  assert.deepEqual(result.changedClaimStatuses, [{
    change: 'status_changed',
    claimId: 'claim_1',
    leftRevisionAddress: fixture.leftClaimRevisionAddress,
    rightRevisionAddress: fixture.rightClaimRevisionAddress,
    from: 'contested',
    to: 'supported',
    claimTransitionDecisionId: sha('c'),
    acceptedTransitionAddress: fixture.acceptedTransitionAddress,
  }]);
  assert.deepEqual(result.activationChanges[0]?.reasonEvents, [
    attributedFormationEventSupport('right', 'evt_sleep_1', '91'),
  ]);
});

test('comparison preserves reused edge IDs from distinct merged leaves', async () => {
  const fixture = compareFixtureWithReusedEdgeObject();
  const result = await compareCommits(fixture.input, fixture.dependencies);
  const reused = result.topologyChanges.filter(
    (change) => change.edgeAddress.objectId === fixture.reusedEdgeId,
  );
  assert.equal(reused.length, 2);
  assert.notDeepEqual(reused[0]?.edgeAddress, reused[1]?.edgeAddress);
  assert.notDeepEqual(reused[0]?.from, reused[1]?.from);
});

test('comparison preserves same Claim IDs and metabolism object IDs by leaf', async () => {
  const fixture = compareFixtureWithReusedClaimAndMetabolismObjects();
  const result = await compareCommits(fixture.input, fixture.dependencies);
  const changed = result.changedClaimStatuses.filter(
    change => change.change === 'status_changed',
  );
  assert.equal(changed[0]?.claimId, changed[1]?.claimId);
  assert.notDeepEqual(
    changed[0]?.rightRevisionAddress,
    changed[1]?.rightRevisionAddress,
  );
  assert.equal(
    result.metabolismMappings[0]?.from.objectId,
    result.metabolismMappings[1]?.from.objectId,
  );
  assert.notDeepEqual(
    result.metabolismMappings[0]?.from,
    result.metabolismMappings[1]?.from,
  );
});

test('comparison represents Claim and Question additions and removals without invented opposite sides', async () => {
  const fixture = compareFixtureWithAddedAndRemovedObjects();
  const result = await compareCommits(fixture.input, fixture.dependencies);
  const addedClaim = result.changedClaimStatuses.find(
    change => change.change === 'added',
  )!;
  const removedQuestion = result.questionChanges.find(
    change => change.change === 'removed',
  )!;
  assert.equal('leftRevisionAddress' in addedClaim, false);
  assert.equal('claimTransitionDecisionId' in addedClaim, false);
  assert.equal('rightQuestionAddress' in removedQuestion, false);
});

test('federated assertions identify their Brain and commit', async () => {
  const fixture = await federationFixture();
  const before = await fixture.authorityFingerprints();
  const result = await fixture.inquiry.federate(fixture.input);
  const after = await fixture.authorityFingerprints();
  assert.equal(result.assertions.every(
    (assertion) => assertion.brainSetSources.every(
      (source) => source.brainSetId === result.brainSetId
        && source.brainCommitId.startsWith('sha256:'),
    ),
  ), true);
  assert.deepEqual(after, before);
  assert.equal(result.readOnlyReceipt.refsChanged, false);
  assert.notEqual(
    result.generatorAttemptReceipt.attemptId,
    result.verification.attemptReceipt.attemptId,
  );
  assert.equal(result.releaseable, result.verification.releaseable);
  assert.deepEqual(
    result.sourceIdentities.map(identity => identity.brainCommitId),
    result.commitIds,
  );
});

test('federation keeps same Claim ID revisions in separate merged leaves', async () => {
  const fixture = await federationFixtureWithDivergentClaimRevisions();
  const result = await fixture.inquiry.federate(fixture.input);
  const claimSources = result.assertions[0]!.brainSetSources.flatMap(
    (source) => source.support.kind === 'claim' ? [source.support] : [],
  );
  assert.equal(claimSources.length, 2);
  assert.equal(claimSources[0]?.claimId, claimSources[1]?.claimId);
  assert.notEqual(
    claimSources[0]?.revisionObjectId,
    claimSources[1]?.revisionObjectId,
  );
  assert.notDeepEqual(
    claimSources[0]?.address,
    claimSources[1]?.address,
  );
});

test('federation keeps same EvidenceSpan ID in separate merged leaves', async () => {
  const fixture = await federationFixtureWithReusedEvidenceSpan();
  const result = await fixture.inquiry.federate(fixture.input);
  const evidenceSources = result.assertions[0]!.brainSetSources.flatMap(
    (source) => source.support.kind === 'evidence'
      ? [source.support]
      : [],
  );
  assert.equal(evidenceSources.length, 2);
  assert.equal(
    evidenceSources[0]?.evidenceSpanId,
    evidenceSources[1]?.evidenceSpanId,
  );
  assert.notDeepEqual(
    evidenceSources[0]?.address,
    evidenceSources[1]?.address,
  );
});

test('rights-incompatible material remains attributed but undisclosed', async () => {
  const result = await federateBrains(rightsSplitFixture());
  assert.equal(result.assertions[0]?.disclosures[0]?.status, 'withheld_by_rights');
  assert.equal(
    result.assertions[0]?.disclosures[0]?.supportKey.length > 0,
    true,
  );
});

test('a federated assertion blocked by the independent verifier is not released', async () => {
  const fixture = await federationFixture({
    verifierResult: 'block',
  });
  const result = await fixture.inquiry.federate(fixture.input);
  assert.equal(result.releaseable, false);
  assert.equal(result.assertions.some(
    assertion => assertion.assertionId === fixture.blockedAssertionId,
  ), false);
  assert.equal(result.verification.findings.some(
    finding => finding.assertionId === fixture.blockedAssertionId
      && finding.result === 'block',
  ), true);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/compare.test.ts`

Expected: FAIL because compare/federation composition is absent.

- [ ] **Step 3: Implement diff projection**

Program B `BrainDiff` is only a structural change hint; it cannot prove typed Claim status, Question lifecycle, topology, activation, or metabolism changes. Resolve and verify both exact commits, call `LivingBrainService.materialize()` for each, and derive separately listed:

- claims/statuses;
- questions/lifecycle;
- topology edges;
- activation;
- negative knowledge;
- perspectives/dissent;
- Relationship/Program changes;
- metabolism mappings; and
- artifacts.

Do not reduce the diff to node counts.

Every changed semantic object is identified by a full address on the side where
it exists; logical Claim/Question/Artifact IDs remain labels, not leaf
identities. Every causal reason event uses
`AssertionFormationEventSupport`. Activation targets are resolved
`LayerNodeAddress` values. The comparison builder may accept a bare ID only
through the same exact-uniqueness resolver used by formation; ambiguity is an
error, never a first-match choice.

Each Claim/Question comparison is exactly one of `added`, `removed`, or
`status_changed`. Added/removed variants carry only the existing side and
cannot invent a missing address, prior status, or transition. Every
`status_changed` Claim's `claimTransitionDecisionId` must resolve to Program
C's exact decoded `ClaimTransitionDecision` wrapper referenced by the right
Epistemic root. Its payload must bind the same Claim revision and exact
`from`/`to` transition. A Principal decision ID, anonymous evaluator result, or
unreferenced transition object fails comparison instead of being displayed as
provenance. The left/right Claim revisions and accepted-transition record are
full addresses, not logical IDs. Metabolism mappings likewise preserve full
`from`/`to` addresses; matching object bytes in different merged leaves are
separate changes.

```ts
interface BrainDisplayIdentityPort {
  describe(commitId: BrainCommitId): Promise<ComparisonDisplayIdentity>;
}

interface ReadOnlyFingerprintPort {
  capture(commitIds: BrainCommitId[]): Promise<{
    authorityFingerprint: Sha256;
    refFingerprint: Sha256;
    canonicalWriteCount: number;
  }>;
}

export async function compareCommits(
  input: CompareInput,
  dependencies: {
    repository: Pick<BrainRepository, 'diff'>;
    livingBrain: Pick<LivingBrainService, 'materialize'>;
    identity: BrainDisplayIdentityPort;
    fingerprint: ReadOnlyFingerprintPort;
  },
): Promise<ComparisonResult> {
  const before = await dependencies.fingerprint.capture(
    [input.leftCommitId, input.rightCommitId],
  );
  const [diff, left, right, leftIdentity, rightIdentity] = await Promise.all([
    dependencies.repository.diff(
    input.leftCommitId,
    input.rightCommitId,
    ),
    dependencies.livingBrain.materialize(input.leftCommitId),
    dependencies.livingBrain.materialize(input.rightCommitId),
    dependencies.identity.describe(input.leftCommitId),
    dependencies.identity.describe(input.rightCommitId),
  ]);
  verifyDiffAgainstMaterializations(diff, left, right);
  const after = await dependencies.fingerprint.capture(
    [input.leftCommitId, input.rightCommitId],
  );
  return ComparisonResultSchema.parse({
    schema: 'cosmo.comparison-result.v1',
    leftCommitId: input.leftCommitId,
    rightCommitId: input.rightCommitId,
    leftIdentity,
    rightIdentity,
    changedClaimStatuses: compareClaimTransitions(left.epistemic, right.epistemic),
    questionChanges: compareQuestionTransitions(
      left.snapshot.question,
      right.snapshot.question,
    ),
    topologyChanges: compareTopology(left.topology, right.topology),
    activationChanges: compareActivation(
      left.snapshot.activation,
      right.snapshot.activation,
    ),
    negativeKnowledgeChanges: compareNegativeKnowledge(
      left.snapshot.negativeKnowledge,
      right.snapshot.negativeKnowledge,
    ),
    perspectiveChanges: comparePerspectives(left, right),
    relationshipAndProgramChanges: compareRelationshipAndPrograms(
      left.snapshot.relationship,
      right.snapshot.relationship,
      left.snapshot.program,
      right.snapshot.program,
    ),
    metabolismMappings: compareMetabolismMappings(left, right),
    artifactChanges: compareArtifacts(
      left.snapshot.artifactIndex,
      right.snapshot.artifactIndex,
    ),
    readOnlyReceipt: requireUnchangedReadOnlyReceipt(before, after),
  });
}
```

- [ ] **Step 4: Implement attributed federation**

Call `repository.federate()` over exact commits from an authority-free
`FederatedInquiryInput`, using a server-injected repository and session-derived
`MutationAuthorization`. Retrieve only authorized projections. Build a
`FederatedSupportAttribution` from the actual assertion fields
(`claimSupports`, `cognitionSupports`, `evidenceSupports`,
`relationshipSupports`, `formationEventSupports`) and the BrainSet's typed address
index; never read a nonexistent generic `sourceObjectIds`. Claim attribution
retains claim ID, exact revision object ID, and full address; cognition retains
node ID and full address. Duplicate bare IDs in two merged leaves are a required
fixture and must remain two distinct supports. Evidence retains EvidenceSpan ID
and full Epistemic-root address; Relationship support retains its full root
address; formation-event support retains source commit plus journal cursor, so
reused logical event IDs never collapse. Capture before/after fingerprints
for every participating commit/ref and reject any change. Neither public input
schema can contain a repository object, actor identity, grant, lease, fence, or
raw authorization.

The BrainSet is only the pinned retrieval projection. It does not authorize a
shortcut around Ask. Run the same `InquiryExecutionPort.generate()` call,
owner-side assertion validation, distinct
`InquiryExecutionPort.verify()` call, and release gate used by a single-Brain
answer. The generator and verifier each execute through Program D's shared
`StructuredRoleExecutionPort`; they have different RunIds, role definitions,
ContextBundles, output schema refs, and runtime receipts. Attribution and
rights disclosure are attached only to assertions that survive the release
gate. Blocked/escalated assertions remain in `verification.findings` but not in
released `assertions`. Resolve one `ComparisonDisplayIdentity` per participating
commit so the workbench never invents source labels.

```ts
const authorization = await authorizationProvider.forFederatedRead(input);
const before = await fingerprintBrainSet(repository, input.commitIds);
const brainSet = await repository.federate({
  brainSetId: input.brainSetId,
  commitIds: input.commitIds,
  actorIdentity: authorization.actorIdentity,
  capabilityGrantId: authorization.capabilityGrantId,
  allowPartial: input.allowPartial,
});
const generated = await generateFromBrainSet(
  brainSet,
  input.request,
  executionPort,
);
const assertions = await validateAssertions(
  generated.assertionPayloads,
  assertionValidationContextFromBrainSet(brainSet, input),
);
const verification = await runIndependentVerification(
  generated,
  pinnedFederatedVerificationContext(brainSet, assertions),
  executionPort,
);
const released = applyVerification(generated, assertions, verification);
const attributed = released.assertions.map((assertion) => ({
  ...assertion,
  brainSetSources: collectAssertionSupport(assertion).map((support) => ({
    brainSetId: input.brainSetId,
    ...requireBrainSetAttribution(brainSet, support),
  })),
  disclosures: collectAssertionSupport(assertion).map((support) =>
    projectRightsDisclosure(brainSet, support)),
}));
const after = await fingerprintBrainSet(repository, input.commitIds);
if (!deepEqual(after, before)) throw typedError('federation_mutated_authority');
const withheldSupportKeys = collectWithheldSupportKeys(attributed);
const sourceIdentities = await Promise.all(
  input.commitIds.map(commitId => identity.describe(commitId)),
);
return FederatedInquiryResultSchema.parse({
  schema: 'cosmo.federated-inquiry-result.v1',
  queryId: input.request.queryId,
  brainSetId: input.brainSetId,
  commitIds: input.commitIds,
  sourceIdentities,
  assertions: attributed,
  generatorAttemptReceipt: generated.attemptReceipt,
  verification,
  releaseable: released.releaseable,
  omissions: generated.omissions,
  limitations: released.limitations,
  partial: withheldSupportKeys.length > 0,
  withheldSupportKeys,
  readOnlyReceipt: requireUnchangedReadOnlyReceipt(before, after),
});
```

- [ ] **Step 5: Run focused and package tests**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/compare.test.ts && npm test --workspace @cosmo/inquiry`

Expected: PASS; federation performs no merge or mutation and every assertion is attributed.

- [ ] **Step 6: Commit**

```bash
git add packages/inquiry/src/compare.ts packages/inquiry/src/ask.ts \
  packages/inquiry/src/index.ts packages/inquiry/test/compare.test.ts
git commit -m "feat(inquiry): compare and federate brains"
```

## Task 8: Make Steer and Invent explicit typed writes

**Files:**
- Create: `packages/inquiry/src/mutation-preview.ts`
- Create: `packages/inquiry/src/mutations.ts`
- Create: `packages/inquiry/test/mutation-preview.test.ts`
- Create: `packages/inquiry/test/mutations.test.ts`
- Modify: `packages/inquiry/src/index.ts`

**Interfaces:**
- Consumes: Program B/D's exact `CognitiveLineageEventScope` schema, Program D
  Relationship/Question/Research Program direction services and
  human-operation admission/Principal/kernel path, Program D's exact
  post-commit independent-review service, Program E semantic-root,
  `HumanInventCandidateBranchInput`, reviewed-candidate/qualified-Claim
  promotion, candidate-agenda, Program acceptance, and lifecycle ports,
  expected head refs, and server-derived capability/lease context.
- Produces: `MutationPreviewService`, `InquiryMutationScopeResolver`,
  `InquiryHumanOperationAdmissionPort`, `InquiryService.steer()`, and
  `invent()`, plus explicit `HumanInventPromotionService` and
  `ProgramDirectionActivationService` paths that remain separate from
  candidate creation.

- [ ] **Step 1: Write failing explicit-mutation tests**

```ts
test('Steer requires a reviewed typed target and expected head', async () => {
  const fixture = await createInquiryFixture('steer-review');
  try {
    const draft = validWorkbenchSteerDraft(fixture, {
      target: 'relationship_event',
      payload: {
        kind: 'relationship_event',
        relationshipKind: 'taste_judgment',
        content: 'Follow the commercially useful path',
        evidenceSpanIds: [],
        confidence: null,
        reversesRelationshipEventId: null,
      },
    });
    assert.throws(() => WorkbenchSteerDraftSchema.parse({
      ...draft,
      authorization: fixture.authorization,
    }));
    const preview = await fixture.previews.previewSteer(
      {
        draft,
        context: previewMutationContext(fixture),
      },
    );
    await assert.rejects(
      () => fixture.inquiry.steer({
        ...serverMaterializeSteerInput(draft, preview, fixture),
        reviewed: false,
      } as never),
      { code: 'steer_review_required' },
    );
  } finally {
    await fixture.cleanup();
  }
});

test('Steer creates a RelationshipEvent commit and leaves the parent immutable', async () => {
  const fixture = await createInquiryFixture('steer');
  try {
    const draft = validWorkbenchSteerDraft(fixture);
    const preview = await fixture.previews.previewSteer({
      draft,
      context: previewMutationContext(fixture),
    });
    const receipt = await fixture.previews.consumeSteer({
      request: commitSteerInput(preview),
      context: consumeMutationContext(fixture),
    });
    assert.equal(receipt.parentCommitId, fixture.commitId);
    assert.notEqual(receipt.childCommitId, fixture.commitId);
    assert.equal(receipt.resultRef, receipt.targetRef);
    assert.equal(receipt.targetRefAfterCommitId, receipt.childCommitId);
    assert.equal(receipt.targetRefUnchanged, false);
    assert.equal(receipt.candidateRef, null);
    assert.equal(receipt.relationshipEventId?.startsWith('rel_'), true);
    assert.equal(receipt.previewId, preview.previewId);
    assert.equal(receipt.draftHash, preview.draftHash);
    assert.equal(await fixture.repository.commits.verify(fixture.commitId).then(
      (verification) => verification.valid,
    ), true);
  } finally {
    await fixture.cleanup();
  }
});

test('Invent creates a candidate branch without advancing the queried ref', async () => {
  const fixture = await createInquiryFixture('invent');
  try {
    const before = await fixture.repository.refs.get(fixture.branchRef);
    const draft = validWorkbenchInventDraft(fixture);
    const preview = await fixture.previews.previewInvent({
      draft,
      context: previewMutationContext(fixture),
    });
    const receipt = await fixture.previews.consumeInvent({
      request: commitInventInput(preview),
      context: consumeMutationContext(fixture),
    });
    const after = await fixture.repository.refs.get(fixture.branchRef);
    assert.equal(after, before);
    assert.equal(receipt.parentCommitId, fixture.commitId);
    assert.notEqual(receipt.candidateBranchCommitId, fixture.commitId);
    assert.equal(receipt.candidateFinding.candidateType, 'connection');
    assert.equal(
      receipt.candidateFindingRef.objectId,
      receipt.candidateFindingObjectId,
    );
    assert.deepEqual(
      HumanInventCandidateBranchCommitReceiptSchema.parse(
        receipt.candidateBranchReceipt,
      ),
      receipt.candidateBranchReceipt,
    );
    assert.equal(receipt.previewId, preview.previewId);
  } finally {
    await fixture.cleanup();
  }
});

test('preview consumption rejects stale head, authority drift, changed body, and replay', async () => {
  const fixture = await createInquiryFixture('preview-binding');
  const draft = validWorkbenchInventDraft(fixture);
  const preview = await fixture.previews.previewInvent({
    draft,
    context: previewMutationContext(fixture),
  });
  await assert.rejects(
    fixture.previews.consumeInvent({
      request: commitInventInput(preview, {
        expectedHead: ids.commit('moved'),
      }),
      context: consumeMutationContext(fixture),
    }),
    { code: 'mutation_preview_stale_head' },
  );
  await assert.rejects(
    fixture.previews.consumeInvent({
      request: commitInventInput(preview),
      context: consumeMutationContext(fixture, {
        authorization: differentServerAuthorization(fixture),
      }),
    }),
    { code: 'mutation_preview_authority_changed' },
  );
  await assert.rejects(
    fixture.previews.consumeInvent({
      request: commitInventInput(preview, {
        draftHash: ids.sha('changed-body'),
      }),
      context: consumeMutationContext(fixture),
    }),
    { code: 'mutation_preview_draft_changed' },
  );
  const first = await fixture.previews.consumeInvent({
    request: commitInventInput(preview),
    context: consumeMutationContext(fixture),
  });
  const retry = await fixture.previews.consumeInvent({
    request: commitInventInput(preview),
    context: consumeMutationContext(fixture),
  });
  assert.deepEqual(retry, first);
  await assert.rejects(
    fixture.previews.consumeInvent({
      request: commitInventInput(preview),
      context: consumeMutationContext(fixture, {
        domainIdempotencyKey: ids.sha('different-idempotency-record'),
      }),
    }),
    { code: 'mutation_preview_already_consumed' },
  );
  assert.equal('capabilityGrantId' in preview.reviewer, false);
});

test('browser Invent cannot forge an autonomous origin', () => {
  const fixture = inquiryFixture('human-origin-only');
  for (const origin of [
    'worker',
    'principal',
    'specialist',
    'default_mode',
    'dream',
    'evidence_gap',
    'contradiction',
  ] as const) {
    assert.equal(WorkbenchInventDraftSchema.safeParse(
      validWorkbenchInventDraft(fixture, {
        candidateFinding: candidateFindingFixture({ origin }),
      }),
    ).success, false);
  }
});

test('Invent admits the human candidate in the exact candidate-ref scope', async () => {
  const fixture = await createInquiryFixture('invent-scope');
  const draft = validWorkbenchInventDraft(fixture);
  const preview = await fixture.previews.previewInvent({
    draft,
    context: previewMutationContext(fixture),
  });
  const receipt = await fixture.previews.consumeInvent({
    request: commitInventInput(preview),
    context: consumeMutationContext(fixture),
  });
  const admitted = await fixture.humanOperationEvent(
    receipt.humanOperationEventId,
  );
  assert.equal(admitted.scope.kind, 'brain_lineage');
  assert.equal(admitted.scope.basedOnBrainCommitId,
    draft.request.brainCommitId);
  assert.equal(admitted.scope.targetRef, draft.candidateRef);
  const eInput = HumanInventCandidateBranchInputSchema.parse(
    fixture.mutationPort.candidateInputs[0],
  );
  assert.equal(eInput.originKind, 'human_invent');
  assert.deepEqual(eInput.scope, admitted.scope);
  assert.equal(eInput.admittedHumanOperationEventId, admitted.eventId);
  assert.deepEqual(eInput.inventDraftRef, preview.draftRef);
  assert.deepEqual(eInput.inventPreviewRef, fixture.storedPreviewRef);
  const intent = await fixture.objects.getTyped(
    receipt.operationIntentRef,
    HumanInventOperationIntentSchema,
  );
  assert.deepEqual(intent.candidateFindingRef, receipt.candidateFindingRef);
  assert.deepEqual(intent.inventDraftRef, eInput.inventDraftRef);
  assert.deepEqual(intent.inventPreviewRef, eInput.inventPreviewRef);
  assert.deepEqual(admitted.payloadRef, receipt.operationIntentRef);
  assert.equal(
    eInput.idempotencyKey,
    fixture.domainIdempotencyKey,
  );
});

test('program-direction Steer creates only a deterministic candidate ref', async () => {
  const fixture = await createInquiryFixture('program-direction-candidate');
  const draft = validWorkbenchSteerDraft(fixture, {
    target: 'program_proposal',
    payload: completeProgramProposalPayload(),
  });
  const preview = await fixture.previews.previewSteer({
    draft,
    context: previewMutationContext(fixture),
  });
  const receipt = await fixture.previews.consumeSteer({
    request: commitSteerInput(preview),
    context: consumeMutationContext(fixture),
  });
  assert.equal(receipt.candidateRef, deriveProgramDirectionCandidateRef(
    draft.requestId,
    preview.draftHash,
  ));
  assert.equal(receipt.resultRef, receipt.candidateRef);
  assert.equal(receipt.targetRefAfterCommitId, draft.expectedHead);
  assert.equal(receipt.targetRefUnchanged, true);
  assert.notEqual(receipt.programDirectionProposalRecordingRef, null);
  assert.notEqual(receipt.candidateAgendaReceiptRef, null);
  assert.equal(await fixture.repository.refs.get(draft.targetRef), draft.expectedHead);
  const recording = await fixture.programDirectionProposalRecording(receipt);
  assert.equal(recording.event.eventType, 'program_direction_proposed');
  assert.deepEqual(recording.event.payloadRef, recording.proposalRef);
  assert.deepEqual(recording.event.causalParentEventIds,
    [recording.proposal.payload.requestedByEventId]);
  assert.equal(
    receipt.humanOperationEventId,
    recording.event.eventId,
  );
});

test('Steer and Invent reject tags, settled refs, and non-candidate result heads', () => {
  const fixture = inquiryFixture('heads-only-mutations');
  assert.equal(WorkbenchSteerDraftSchema.safeParse({
    ...validWorkbenchSteerDraft(fixture),
    targetRef: 'refs/tags/release',
  }).success, false);
  assert.equal(WorkbenchInventDraftSchema.safeParse({
    ...validWorkbenchInventDraft(fixture),
    queriedRef: 'refs/settled/archive',
  }).success, false);
  assert.equal(WorkbenchInventDraftSchema.safeParse({
    ...validWorkbenchInventDraft(fixture),
    candidateRef: 'refs/heads/not-a-candidate-namespace',
  }).success, false);
});

test('a Human Invent candidate promotes only after D review and E acceptance', async () => {
  const fixture = await reviewedHumanInventFixture();
  const before = await fixture.repository.refs.get(fixture.canonicalRef);
  assert.equal(before, fixture.inventReceipt.parentCommitId);
  const promoted = await fixture.promotions.reviewAndPromote(fixture.input);
  assert.equal(
    promoted.committedCandidateReviewReceipt.originKind,
    'human_invent',
  );
  assert.deepEqual(
    promoted.committedCandidateReviewReceipt.inventDraftRef,
    fixture.inventReceipt.candidateBranchReceipt.inventDraftRef,
  );
  assert.deepEqual(
    promoted.committedCandidateReviewReceipt.inventPreviewRef,
    fixture.inventReceipt.candidateBranchReceipt.inventPreviewRef,
  );
  assert.equal(
    promoted.committedCandidateReviewReceipt
      .independentReviewAttempts.length > 0,
    true,
  );
  const acceptedCommitId =
    'acceptedCanonicalCommitId' in promoted.acceptance
      ? promoted.acceptance.acceptedCanonicalCommitId
      : promoted.acceptance.canonicalBrainCommitId;
  assert.equal(
    await fixture.repository.refs.get(fixture.canonicalRef),
    acceptedCommitId,
  );
});

test('a candidate program direction activates only through later D create and E lifecycle acceptance', async () => {
  const fixture = await qualifiedProgramDirectionActivationFixture();
  assert.equal(await fixture.activeProgramState(), null);
  const receipt = await fixture.activations.activate(fixture.input);
  assert.equal(
    receipt.proposalRecordingRef.objectId,
    fixture.input.proposalRecordingRef.objectId,
  );
  assert.equal(
    receipt.researchProgramMutationResult.receipt.action,
    'create',
  );
  assert.equal(receipt.initialization.outcome, 'initialized');
  assert.equal(await fixture.activeProgramState(), 'active');
  assert.equal(fixture.programCreateCalls, 1);
  assert.equal(fixture.candidateAgendaAcceptanceCalls, 0);
});

test('recovery reuses the exact domain idempotency key at the E seam', async () => {
  const fixture = await createInquiryFixture('domain-idempotency-recovery', {
    failAfterSemanticCommitOnce: true,
  });
  const draft = validWorkbenchInventDraft(fixture);
  const preview = await fixture.previews.previewInvent({
    draft,
    context: previewMutationContext(fixture),
  });
  const consume = {
    request: commitInventInput(preview),
    context: consumeMutationContext(fixture),
  };
  await assert.rejects(fixture.previews.consumeInvent(consume), {
    code: 'mutation_receipt_recovery_required',
  });
  const recovered = InventReceiptSchema.parse(
    await fixture.previews.consumeInvent(consume),
  );
  assert.equal(recovered.previewId, preview.previewId);
  assert.deepEqual(fixture.mutationPort.domainIdempotencyKeys, [
    consume.context.domainIdempotencyKey,
    consume.context.domainIdempotencyKey,
  ]);
  assert.equal(fixture.repository.semanticCommitCount, 1);
});

test('question Steer maps every reviewed semantic field into D exact input', async () => {
  const fixture = await createInquiryFixture('question-steer-map');
  const draft = validWorkbenchSteerDraft(fixture, {
    target: 'question_proposal',
    payload: completeQuestionProposalPayload(),
  });
  const input = buildOriginateQuestionInput(
    draft,
    humanOperationAdmissionFixture(fixture),
    questionSteerServerContext(fixture),
  );
  const parsed = OriginateQuestionInputSchema.parse(input);
  assert.equal(parsed.wording, draft.payload.wording);
  assert.equal(parsed.surprise, draft.payload.surprise);
  assert.equal(parsed.uncertainty, draft.payload.uncertainty);
  assert.equal(parsed.initialStatus, draft.payload.initialStatus);
  assert.equal(parsed.promptObjectId, fixture.storedDraftPromptObjectId);
  assert.deepEqual(parsed.sourceEventIds, [fixture.humanOperationEventId]);
  assert.deepEqual(parsed.eventScope, fixture.humanOperationEvent.scope);
  assert.equal(parsed.idempotencyKey, fixture.domainIdempotencyKey);
});

test('all Steer targets derive one unforgeable D mutation scope and key', async () => {
  for (const target of [
    'relationship_event',
    'question_proposal',
    'program_proposal',
  ] as const) {
    const fixture = await steerMappingFixture(target);
    const mapped = await fixture.map();
    const parsed = fixture.exactDInputSchema.parse(mapped.dInput);
    const expectedTargetRef = target === 'program_proposal'
      ? deriveProgramDirectionCandidateRef(
          fixture.draft.requestId,
          fixture.preview.draftHash,
        )
      : fixture.draft.targetRef;
    assert.equal(parsed.idempotencyKey, fixture.domainIdempotencyKey);
    assert.deepEqual(parsed.eventScope, mapped.humanOperationEvent.scope);
    assert.equal(parsed.eventScope.basedOnBrainCommitId,
      fixture.draft.expectedHead);
    assert.equal(parsed.eventScope.targetRef, expectedTargetRef);
    assert.equal(fixture.scopeResolver.inputs[0]?.targetRef,
      expectedTargetRef);
    assert.equal('eventScope' in fixture.publicDraft, false);
  }
});
```

- [ ] **Step 2: Run both tests and verify they fail**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/mutation-preview.test.ts test/mutations.test.ts`

Expected: FAIL because preview binding and explicit mutation services are absent.

- [ ] **Step 3: Implement server-derived previews and one-time consumption**

Export the exact four-method `MutationPreviewService` interface and strict
`MutationRequester`, `MutationServiceContext`, `PreviewSteerInput`,
`PreviewInventInput`, `ConsumeSteerInput`, and `ConsumeInventInput` schemas
frozen in Task 1. Each method takes one object argument. Transport adapters may
construct only `MutationServiceContext`; no overload accepts a raw principal,
scope, fingerprint, authorization, idempotency string, or timestamp in a
separate positional argument.

`MutationPreviewService` stores each strict draft as an authorized immutable
object, computes the authority fingerprint itself from the authenticated
requester and current authorization/grant policy, re-reads the exact target
ref/head, and returns a decoded `WorkbenchMutationPreview`. The preview's
`previewId` is the content hash of its stored payload; `draftHash` hashes the
canonical draft bytes. Safe changes are derived mechanically from the
discriminant and never contain prompt/source text, secrets, grants, leases,
fences, or hidden policy. An identical preview method call with the same
`domainIdempotencyKey` returns the same preview; changed canonical input under
that key is an idempotency conflict.

`consumeSteer()` and `consumeInvent()` atomically bind one preview ID to the
commit request's `domainIdempotencyKey`. They reload the draft and preview,
verify their content hashes, expected/current head, freshly derived authority
fingerprint, expiry, principal, required sorted scopes, and prior consumption,
then derive the exact result ref, acquire its fresh lease, and construct the
internal `SteerInput`/`InventInput`. The service injects the accepted
`InquiryService`, calls exactly one of `steer()` or `invent()`, and durably
records the strict receipt before returning it. An exact retry returns that
receipt. If recovery finds a semantic commit but no outer receipt, it invokes
the same path with the exact same `domainIdempotencyKey`; Program E's idempotent
acceptance returns the one prior commit, after which F completes the receipt.
A different idempotency identity against a consumed preview, or any changed
request, draft, authority, head, or result ref, fails before a new semantic
mutation.

- [ ] **Step 4: Implement Steer through exact D proposals and an E adapter**

Permit only:

```ts
type SteerTarget =
  | 'relationship_event'
  | 'question_proposal'
  | 'program_proposal';
```

`WorkbenchSteerDraftSchema` is the strict, authority-free transport contract. Authority, lease, timestamps, `reviewed`, or preview values arriving in the draft are rejected as unknown fields. Cross-field refinement requires `target === payload.kind`.

Freeze this F-owned adapter interface, implemented over Program E by the production composition:

```ts
interface InquiryMutationScopeResolver {
  resolve(input: {
    basedOnBrainCommitId: BrainCommitId;
    targetRef: WorkbenchHeadRef;
    programId: ResearchProgramId | null;
    authorization: MutationAuthorization;
  }): Promise<CognitiveLineageEventScope>;
}

interface InquiryHumanOperationAdmissionPort {
  admit(input: AdmitHumanOperationEventInput): Promise<CognitiveEvent>;
}

interface InquiryMutationCommitReceipt {
  commitId: BrainCommitId;
  principalDecisionId: ObjectId | null;
  humanOperationEventId: EventId;
  journalRange: JournalRange;
}

interface InquiryMutationPort {
  commitRelationshipMutation(input: {
    mutation: RelationshipMutationResult;
    expectedHead: BrainCommitId;
    targetRef: WorkbenchHeadRef;
    authorization: MutationAuthorization;
    lease: LeaseProof;
    domainIdempotencyKey: Sha256;
  }): Promise<InquiryMutationCommitReceipt>;
  commitQuestionMutation(input: {
    mutation: QuestionMutationProposal;
    expectedHead: BrainCommitId;
    targetRef: WorkbenchHeadRef;
    authorization: MutationAuthorization;
    lease: LeaseProof;
    domainIdempotencyKey: Sha256;
  }): Promise<InquiryMutationCommitReceipt>;
  commitProgramDirectionCandidate(input: {
    proposalRecording: ProgramDirectionProposalRecording;
    parentCommitId: BrainCommitId;
    canonicalTargetRef: WorkbenchHeadRef;
    candidateBranchRef: WorkbenchCandidateHeadRef;
    expectedCandidateHead: null;
    authorization: MutationAuthorization;
    lease: LeaseProof;
    domainIdempotencyKey: Sha256;
  }): Promise<InquiryMutationCommitReceipt & {
    proposalRecordingRef: ObjectRef;
    candidateAgendaReceiptRef: ObjectRef;
    candidateAgendaReceipt: CandidateAgendaAcceptanceReceipt;
  }>;
  commitHumanInventCandidate(
    input: HumanInventCandidateBranchInput
  ): Promise<{
    receiptRef: ObjectRef;
    receipt: HumanInventCandidateBranchCommitReceipt;
  }>;
}
```

The production adapter calls Program E's exact semantic-root/candidate-branch acceptance services; it never reimplements CAS, root construction, or cognition admission. Target mapping is closed:

- `relationship_event` → D `ResearchRelationshipService.record()` → its exact Relationship-root update → E semantic-root acceptance;
- `question_proposal` → D `QuestionService.originate(origin='human')` → its exact Question-root update → E semantic-root acceptance; and
- `program_proposal` → D `ResearchProgramService.proposeDirection()` → admitted candidate-agenda CognitiveEvent → E candidate commit at Program F's deterministic absent candidate ref.

A caller never supplies `eventScope`. After re-verifying the head, F resolves a
canonical lineage scope through `InquiryMutationScopeResolver`, stores the
reviewed draft payload, and admits a human-operation request through
`InquiryHumanOperationAdmissionPort`. Relationship/Question scopes target the
reviewed canonical ref. For a program proposal, F derives and proves the
candidate ref absent *before* scope resolution/admission; that scope is based on
the canonical parent but targets the deterministic candidate ref. The first
human request event points to the stored reviewed draft and becomes D
`ProposeResearchProgramDirectionInput.requestedByEventId`. Only after D returns
and F byte-verifies the stored `ResearchProgramDirectionProposal` does F admit a
second `program_direction_proposed` event whose `payloadRef` is that exact
proposal ref and whose sole causal parent is the first request event. F stores
the exact `ProgramDirectionProposalRecording` and passes its second EventId to
E `acceptCandidateAgendaProposal()`. A draft/request event can never substitute
for this proposal event. Parent, target, program, lineage, trust, proposal,
event, or key drift fails before E sees the proposal.

A program proposal is never an active Research Program, never changes
`programRoot`, and never advances the reviewed canonical target ref. Program F
derives `candidateBranchRef =
refs/heads/candidates/program-direction-${sha256(requestId,draftHash)}` and
verifies it is absent before acquiring its lease. The production E adapter
receives both `canonicalTargetRef` as read-only provenance and
`candidateBranchRef` with `expectedCandidateHead:null`. Every mutation-port
call receives the unchanged `domainIdempotencyKey` from preview consumption and
passes it as Program E's exact acceptance idempotency key.

Activation is a later explicit operation through
`ProgramDirectionActivationService`, never a continuation hidden inside
Steer. It reloads the exact proposal recording and candidate-agenda receipt,
requires qualified review findings and the pinned Principal decision, maps the
reviewed semantic agenda into a complete D `CreateResearchProgramInput`, then
uses the ordinary D create → E Program acceptance → E initialize →
creation-converged → D finalize(active) → E accept(active) handshake. A model
proposal, candidate commit, or human preview alone cannot activate a Program;
replay returns the same complete activation receipt.

For `question_proposal`, reviewed semantic values come only from the strict draft: wording, semantic variants, why it matters, parents, domains, perspectives, surprise, uncertainty, evidence considered, human interest, initial status, review time, and expiry. The server derives only mechanical/provenance fields: current expected Brain/Question root, canonical stored draft-prompt object, current human/Principal task-graph ref, the already admitted human-operation event as the sole initial source/request event, its exact lineage scope, authority, unchanged domain idempotency identity, and occurred time. `QuestionService` assigns a distinct later `question_originated` EventId. No hidden default chooses surprise, uncertainty, status, or meaning, and a cross-contract test must parse the constructed object with D's exact `OriginateQuestionInputSchema`.

The Steer result sets exactly one of `relationshipEventId`, `questionProposalObjectId`, or `programProposalObjectId`; the other two are null. The returned commit receipt supplies the Principal decision and journal range:

```ts
const { draft, preview } = SteerInputSchema.parse(input);
const proposed = await proposeTypedSteerMutation(draft, dServices, input);
const programDirectionRecording =
  proposed.kind === 'program_direction'
    ? await admitAndStoreProgramDirectionProposal({
        proposal: proposed.proposal,
        proposalRef: proposed.proposalRef,
        requestedByEvent: proposed.requestedByEvent,
        authorization: input.authorization,
        admittedAt: input.occurredAt,
      })
    : null;
const committed = await commitTypedSteerMutation(
  draft.target,
  proposed,
  programDirectionRecording,
  mutationPort,
  input,
);
return SteerReceiptSchema.parse({
  schema: 'cosmo.steer-receipt.v1',
  requestId: draft.requestId,
  targetRef: draft.targetRef,
  parentCommitId: draft.expectedHead,
  childCommitId: committed.commitId,
  resultRef: input.resultRef,
  targetRefAfterCommitId:
    proposed.kind === 'program_direction'
      ? draft.expectedHead
      : committed.commitId,
  targetRefUnchanged: proposed.kind === 'program_direction',
  candidateRef:
    proposed.kind === 'program_direction'
      ? input.resultRef
      : null,
  relationshipEventId:
    proposed.kind === 'relationship' ? proposed.event.relationshipEventId : null,
  questionProposalObjectId:
    proposed.kind === 'question' ? proposed.questionObjectId : null,
  programProposalObjectId:
    proposed.kind === 'program_direction' ? proposed.proposalObjectId : null,
  programDirectionProposalRecordingRef:
    proposed.kind === 'program_direction'
      ? committed.proposalRecordingRef
      : null,
  candidateAgendaReceiptRef:
    proposed.kind === 'program_direction'
      ? committed.candidateAgendaReceiptRef
      : null,
  principalDecisionId: committed.principalDecisionId,
  humanOperationEventId: committed.humanOperationEventId,
  journalRange: committed.journalRange,
  previewId: preview.previewId,
  draftHash: preview.draftHash,
  occurredAt: input.occurredAt,
});
```

- [ ] **Step 5: Implement Invent as an isolated candidate branch**

Require `mode: 'invent'`, exact parent commit, purpose, strict candidate finding,
fresh server grant/lease, and consumed preview. The candidate ref must not
exist. Resolve a lineage scope based on the queried commit and targeting that
candidate ref. Store the CandidateFinding separately, then store one strict
`HumanInventOperationIntent` linking that exact candidate ref, the preview's
stored draft ref, and the consumed preview ref. Admit a human-operation
`candidate_finding` event through Program D with `payloadRef` equal to the
intent ref—not the CandidateFinding ref—and the exact candidate scope. Program
F then constructs and parses Program E's exact
`HumanInventCandidateBranchInput`; no generic candidate DTO or autonomous
research/runtime field is accepted. Do not first call Program B `fork()`,
which would violate E's `expectedCandidateHead:null` precondition. Return the
exact E receipt/ref, parent/candidate identities, CandidateFinding ref, and
intent ref; leave the queried ref unchanged.

```ts
const { draft, preview } = InventInputSchema.parse(input);
const parentHead = await repository.refs.get(draft.queriedRef);
if (parentHead !== draft.request.brainCommitId) {
  throw typedError('invent_parent_moved');
}
if (await repository.refs.get(draft.candidateRef) !== null) {
  throw typedError('invent_candidate_ref_exists');
}
const scope = await scopeResolver.resolve({
  basedOnBrainCommitId: draft.request.brainCommitId,
  targetRef: draft.candidateRef,
  programId: null,
  authorization: input.authorization,
});
const candidateFindingRef = await objects.putTyped(
  draft.candidateFinding,
  CandidateFindingSchema,
  input.authorization,
);
const operationIntentRef = await objects.putTyped(
  HumanInventOperationIntentSchema.parse({
    schema: 'cosmo.human-invent-operation-intent.v1',
    requestId: draft.requestId,
    parentBrainCommitId: draft.request.brainCommitId,
    candidateBranchRef: draft.candidateRef,
    candidateFindingRef,
    inventDraftRef: preview.draftRef,
    inventPreviewRef: input.previewRef,
    scope,
    purpose: draft.purpose,
    occurredAt: input.occurredAt,
  }),
  input.authorization,
);
const admission = await eventAdmission.admit(
  inventAdmissionInput({
    eventType: 'candidate_finding',
    payloadRef: operationIntentRef,
    scope,
    origin: 'human',
  }, input),
);
const admittedEvent = requireAdmitted(admission);
const candidateInput = HumanInventCandidateBranchInputSchema.parse({
  schema: 'cosmo.human-invent-candidate-branch-input.v1',
  originKind: 'human_invent',
  parentCommitId: draft.request.brainCommitId,
  candidateBranchRef: draft.candidateRef,
  expectedCandidateHead: null,
  scope,
  admissions: [{
    candidateObjectRef: candidateFindingRef,
    candidate: draft.candidateFinding,
    admittedEventId: admittedEvent.eventId,
    scope,
  }],
  rootMutations: await buildHumanInventRootMutations({
    parentCommitId: draft.request.brainCommitId,
    candidateFindingRef,
    candidate: draft.candidateFinding,
    admittedEvent,
    scope,
  }),
  admittedHumanOperationEventId: admittedEvent.eventId,
  inventDraftRef: preview.draftRef,
  inventPreviewRef: input.previewRef,
  idempotencyKey: input.domainIdempotencyKey,
  requestedAt: input.occurredAt,
  authorization: input.authorization,
  lease: input.lease,
});
const candidateBranchCommit =
  await mutationPort.commitHumanInventCandidate(candidateInput);
return InventReceiptSchema.parse({
  schema: 'cosmo.invent-receipt.v1',
  requestId: draft.requestId,
  parentCommitId: draft.request.brainCommitId,
  candidateBranchCommitId:
    candidateBranchCommit.receipt.candidateBrainCommitId,
  queriedRef: draft.queriedRef,
  candidateRef: draft.candidateRef,
  candidateFindingRef,
  candidateFindingObjectId: candidateFindingRef.objectId,
  candidateFinding: draft.candidateFinding,
  operationIntentRef,
  candidateBranchReceiptRef: candidateBranchCommit.receiptRef,
  candidateBranchReceipt: candidateBranchCommit.receipt,
  queriedRefUnchanged: true,
  principalDecisionId: null,
  humanOperationEventId: admittedEvent.eventId,
  journalRange: candidateBranchCommit.receipt.journalRange,
  previewId: preview.previewId,
  draftHash: preview.draftHash,
  occurredAt: input.occurredAt,
});
```

- [ ] **Step 6: Implement explicit reviewed promotion and Program activation**

`HumanInventPromotionService.reviewAndPromote()` reloads and byte-verifies the
stored `InventReceipt`, exact E
`HumanInventCandidateBranchCommitReceipt`, CandidateFinding, operation intent,
draft, preview, and admitted event. It maps them into D's exact
`DECommittedCandidateReviewInput` human branch:

```ts
const reviewInput = DECommittedCandidateReviewInputSchema.parse({
  schema: 'cosmo.de-committed-candidate-review-input.v1',
  originKind: 'human_invent',
  candidateBrainCommitId:
    invent.candidateBranchReceipt.candidateBrainCommitId,
  candidateBranchRef: invent.candidateRef,
  canonicalTargetRef: input.canonicalRef,
  candidateBranchReceiptRef: invent.candidateBranchReceiptRef,
  candidateRef: invent.candidateFindingRef,
  candidateEventId: invent.humanOperationEventId,
  admittedHumanOperationEventId: invent.humanOperationEventId,
  inventDraftRef: invent.candidateBranchReceipt.inventDraftRef,
  inventPreviewRef: invent.candidateBranchReceipt.inventPreviewRef,
  independentReviewInputs: input.independentReviewInputs,
  evidencePolicyId: input.evidencePolicyId,
  principalVersion: input.principalVersion,
  authorization: input.authorization,
  idempotencyKey: deriveSubkey(input.idempotencyKey, 'independent-review'),
  reviewedAt: input.reviewedAt,
});
```

D performs the independent structured reviewer attempts, records the exact C
findings/qualifications and optional Claim transition, stores
`reviewCompletionRecording`, and obtains the Principal disposition. F stores
the exact D receipt/ref and passes it unchanged with the matching human-origin
candidate-branch receipt to E's `QualifiedPromotionService` for a Claim or
`ReviewedCognitiveCandidateService` for other cognition. Invent creation alone
never advances the canonical ref; this explicit second operation is the only
human-candidate promotion path, and a human preview never substitutes for
independent review.

`ProgramDirectionActivationService.activate()` likewise reloads every exact
proposal/event/candidate-agenda/review object, requires the proposal event to
be `program_direction_proposed`, and runs the ordinary complete D/E Program
creation lifecycle described in Step 4. It cannot reuse Steer's candidate lease
or idempotency key, and it returns only after the final active Program mutation
is accepted. Neither explicit path is an HTTP shortcut; a later public route
must freeze its own authority-free preview/commit DTO before exposing it.

- [ ] **Step 7: Run focused and package tests**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/mutation-preview.test.ts test/mutations.test.ts && npm test --workspace @cosmo/inquiry`

Expected: PASS; Ask remains read-only and both write paths are explicit and traceable.

- [ ] **Step 8: Commit**

```bash
git add packages/inquiry/src/mutation-preview.ts packages/inquiry/src/mutations.ts \
  packages/inquiry/src/index.ts packages/inquiry/test/mutation-preview.test.ts \
  packages/inquiry/test/mutations.test.ts
git commit -m "feat(inquiry): add explicit steer and invent"
```

## Task 9: Freeze and pass the Brain-over-files proof

**Files:**
- Create: `packages/inquiry/src/brain-over-files.ts`
- Create: `packages/inquiry/test/brain-over-files.test.ts`
- Create: `fixtures/contracts/inquiry/brain-over-files.json`
- Create: `fixtures/contracts/inquiry/brain-over-files.objects.json`
- Modify: `packages/inquiry/src/index.ts`

**Interfaces:**
- Consumes: frozen candidate Brain, journal range, corpus snapshots, artifact index, probe deck, and read-only Ask.
- Produces: `runBrainOverFilesProof()` and content-addressed proof receipt.

- [ ] **Step 1: Write the failing defining product proof**

```ts
test('answers come from cognition frozen before the query, not artifacts or tools', async () => {
  const fixture = await importBrainOverFilesFixture();
  try {
    const result = await runBrainOverFilesProof({
      inquiry: fixture.inquiry,
      repository: fixture.repository,
      brainCommitId: fixture.commitId,
      branchRef: fixture.branchRef,
      corpusSnapshotIds: fixture.corpusSnapshotIds,
      excludedArtifactIds: fixture.artifactIds,
      probes: [
        'What surprised you?',
        'Explain how the central bridge formed.',
        'What evidence opposes it?',
        'What failed?',
        'What is important but absent from the artifact?',
      ],
      capabilities: {
        network: false,
        tools: false,
        steer: false,
        invent: false,
        workerExecution: false,
      },
    });
    assert.equal(result.passed, true);
    assert.equal(result.authorityChanged, false);
    assert.equal(result.excludedArtifactBytesRead, 0);
    assert.equal(result.preQueryFormationCoverage, 1);
    assert.equal(result.queryTimeConnectionsCredited, 0);
  } finally {
    await fixture.cleanup();
  }
});
```

- [ ] **Step 2: Run the proof and verify it fails**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/brain-over-files.test.ts`

Expected: FAIL because the frozen bundle and proof harness are absent.

- [ ] **Step 3: Add a portable fixture with cognition deeper than its artifact**

The fixture manifest pins:

- Brain commit and all canonical roots;
- consumed journal range;
- corpus snapshots;
- a polished artifact whose payload is separately hash-listed and excluded;
- a surprise formed before the query;
- a cross-domain bridge with evidence, candidate, review, Principal decision, and commit ancestry;
- a contradiction;
- scoped negative knowledge;
- an important detail absent from the artifact; and
- expected read-only authority fingerprint.

The objects file contains only portable fixture bytes and exact hashes; it has no live path.

```ts
const manifest = BrainOverFilesFixtureSchema.parse({
  schema: 'cosmo.brain-over-files-fixture.v1',
  fixtureId: 'menlo-park-accumulated-cognition',
  brainCommitId: await reconstructAndVerifyCommit(objects.brainCommit),
  journalRange: {
    fromExclusive: '0',
    throughInclusive: '48',
  },
  corpusSnapshotIds: [
    await reconstructAndVerifySnapshot(objects.corpusSnapshot),
  ],
  excludedArtifactIds: [
    await putAndHashFixtureArtifact(objects.polishedArtifact),
  ],
  probeIds: [
    'surprise',
    'formation',
    'opposition',
    'negative-knowledge',
    'artifact-absence',
  ],
  expectedAuthorityFingerprint: await fingerprintFixtureAuthority(objects),
});
```

The fixture builder writes the resulting canonical manifest. No digest is hand-authored: each ID above is recomputed from the exact portable object bytes and the verifier reconstructs the same identity offline.

- [ ] **Step 4: Implement the read-only proof**

Before queries:

1. fingerprint the commit, branch ref, roots, journal range, corpus, and artifact index;
2. make artifact payloads unreadable to the inquiry projection;
3. disable network, tools, mutations, and worker execution;
4. record object read receipts.

After queries:

1. require every accumulated surprise/connection to resolve to pre-query events and ancestry;
2. classify a newly generated connection as `new_connection_in_answer`;
3. require opposition, negative knowledge, formation, and artifact-absence probes;
4. verify zero artifact payload reads; and
5. compare the complete authority fingerprint byte for byte.

```ts
const before = await authorityFingerprint(repository, input.branchRef, input.brainCommitId);
const deniedArtifacts = new DeniedObjectSet(input.excludedArtifactIds);
const answers = [];
for (const probe of input.probes) {
  answers.push(await input.inquiry.ask({
    ...brainOverFilesInquiryInput(input, probe),
    deniedObjectIds: deniedArtifacts,
    capabilities: input.capabilities,
  }));
}
const after = await authorityFingerprint(repository, input.branchRef, input.brainCommitId);
const preQueryFormationCoverage = formationCoverageBeforeQuery(
  answers,
  input.brainCommitId,
  input.journalRange,
);
return BrainOverFilesProofSchema.parse({
  passed: deepEqual(before, after)
    && deniedArtifacts.readCount === 0
    && preQueryFormationCoverage === 1,
  authorityChanged: !deepEqual(before, after),
  excludedArtifactBytesRead: deniedArtifacts.readBytes,
  preQueryFormationCoverage,
  queryTimeConnectionsCredited: countImproperQueryTimeCredits(answers),
});
```

- [ ] **Step 5: Run the proof twice and the entire package**

Run: `npm exec --workspace @cosmo/inquiry -- tsx --test test/brain-over-files.test.ts && npm exec --workspace @cosmo/inquiry -- tsx --test test/brain-over-files.test.ts && npm test --workspace @cosmo/inquiry`

Expected: both proof receipt hashes match; all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/inquiry/src/brain-over-files.ts \
  packages/inquiry/src/index.ts packages/inquiry/test/brain-over-files.test.ts \
  fixtures/contracts/inquiry/brain-over-files.json \
  fixtures/contracts/inquiry/brain-over-files.objects.json
git commit -m "test(inquiry): prove brain over files"
```

## Task 10: Scaffold the restrained React/Vite workbench and stable gateway

**Files:**
- Modify: `package-lock.json`
- Create: `apps/workbench/package.json`
- Create: `apps/workbench/tsconfig.json`
- Create: `apps/workbench/vite.config.ts`
- Create: `apps/workbench/index.html`
- Create: `apps/workbench/src/main.tsx`
- Create: `apps/workbench/src/App.tsx`
- Create: `apps/workbench/src/styles.css`
- Create: `apps/workbench/src/gateway/types.ts`
- Create: `apps/workbench/src/gateway/http-gateway.ts`
- Create: `apps/workbench/src/gateway/session.ts`
- Create: `apps/workbench/src/gateway/session.test.ts`
- Create: `apps/workbench/src/state/use-workbench.ts`
- Create: `apps/workbench/src/state/use-workbench.test.tsx`
- Create: `apps/workbench/src/test/setup.ts`
- Create: `apps/workbench/src/test/fake-gateway.ts`

**Interfaces:**
- Consumes: Program F public request/response contracts.
- Produces: `WorkbenchGateway`, relative HTTP implementation, app shell, and generated `apps/workbench/dist/`.

- [ ] **Step 1: Pin the UI dependencies and scripts**

Create `apps/workbench/package.json` first:

```json
{
  "name": "@cosmo/workbench",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/main.tsx",
    "./gateway": "./src/gateway/types.ts"
  },
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "@cosmo/contracts": "*",
    "react": "19.1.1",
    "react-dom": "19.1.1"
  },
  "devDependencies": {
    "@testing-library/react": "16.3.0",
    "@testing-library/user-event": "14.6.1",
    "@types/react": "19.1.9",
    "@types/react-dom": "19.1.7",
    "@vitejs/plugin-react": "4.6.0",
    "jsdom": "26.1.0",
    "vite": "7.0.6",
    "vitest": "3.2.4"
  }
}
```

Run:

```bash
npm install --workspace @cosmo/workbench --save-exact \
  react@19.1.1 react-dom@19.1.1
npm install --workspace @cosmo/workbench --save-dev --save-exact \
  vite@7.0.6 @vitejs/plugin-react@4.6.0 vitest@3.2.4 \
  jsdom@26.1.0 @testing-library/react@16.3.0 \
  @testing-library/user-event@14.6.1 \
  @types/react@19.1.9 @types/react-dom@19.1.7
```

Expected: root `package-lock.json` records exact versions; no Home23 package appears.

Commit the workspace identity, source-development exports, and reviewed dependency lock before any workbench test imports it:

```bash
git add apps/workbench/package.json package-lock.json
git commit -m "build(workbench): register source workspace"
```

- [ ] **Step 2: Write a failing state/gateway test**

```tsx
import { renderHook, act } from '@testing-library/react';
import { expect, test } from 'vitest';
import { useWorkbench } from './use-workbench.js';
import { fakeWorkbenchGateway } from '../test/fake-gateway.js';

test('Ask carries the displayed commit pin and does not call a mutation route', async () => {
  const gateway = fakeWorkbenchGateway({
    catalog: workbenchBrainCatalogFixture([
      workbenchBrainSummaryFixture({
        brainCommitId: `sha256:${'a'.repeat(64)}`,
        corpusSnapshotIds: [`sha256:${'b'.repeat(64)}`],
        refNames: ['refs/heads/menlo-park'],
        selectedRef: 'refs/heads/menlo-park',
        displayLabel: {
          text: 'menlo-park',
          source: 'selected_ref',
          sourceRef: 'refs/heads/menlo-park',
        },
        reachabilityStatuses: ['active_head'],
        interactionAccess: 'steer',
      }),
    ]),
  });
  const { result } = renderHook(() => useWorkbench(gateway));
  await act(() => result.current.bootstrap());
  act(() => {
    result.current.setMode('ask');
    result.current.setIntent('surprise');
    result.current.setText('What surprised you?');
  });
  await act(() => result.current.submit());
  expect(gateway.calls.ask).toHaveLength(1);
  expect(gateway.calls.ask[0]?.request.brainCommitId).toBe(
    `sha256:${'a'.repeat(64)}`,
  );
  expect(result.current.selectedBrain?.selectedRef).toBe(
    'refs/heads/menlo-park',
  );
  expect(gateway.calls.previewSteer).toHaveLength(0);
  expect(gateway.calls.commitSteer).toHaveLength(0);
  expect(gateway.calls.previewInvent).toHaveLength(0);
  expect(gateway.calls.commitInvent).toHaveLength(0);
});

test('formation loads through the frozen gateway contract', async () => {
  const gateway = fakeWorkbenchGateway({
    formation: formationExplanationFixture(),
  });
  const input = formationInquiryFixture().input;
  const explanation = await gateway.explainFormation(input);
  expect(gateway.calls.explainFormation).toEqual([input]);
  expect(explanation).toEqual(
    FormationExplanationSchema.parse(formationExplanationFixture()),
  );
});
```

- [ ] **Step 3: Write the failing one-time session exchange test**

```ts
import { describe, expect, test, vi } from 'vitest';
import { createBrowserSessionClient } from './session.js';

describe('browser session', () => {
  test('exchanges the fragment, clears it, and persists no secret', async () => {
    history.replaceState(
      null,
      '',
      '/#/connect/exchange_abcdefghijklmnopqrstuvwxyz123456',
    );
    const fetch = vi.fn(async () => Response.json({
      schema: 'cosmo.browser-session-exchange.v1',
      principalId: `sha256:${'a'.repeat(64)}`,
      scopes: ['read', 'query'],
      csrfToken: 'csrf_abcdefghijklmnopqrstuvwxyz123456',
      expiresAt: '2026-07-31T12:00:00.000Z',
    }));
    const localWrite = vi.spyOn(Storage.prototype, 'setItem');
    const client = createBrowserSessionClient(fetch, {
      now: () => new Date('2026-07-30T12:00:00.000Z'),
    });

    const exchanged = await client.exchangeConnectFragment(window);

    expect(exchanged).toBe(true);
    expect(fetch).toHaveBeenCalledWith('/api/v1/session/exchange', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        exchangeCode: 'exchange_abcdefghijklmnopqrstuvwxyz123456',
      }),
    });
    expect(location.hash).toBe('');
    expect(localWrite).not.toHaveBeenCalled();
  });

  test('POST requests use the memory-only CSRF token and HttpOnly session', async () => {
    const fetch = sessionExchangeThenMutationFetch();
    const client = createBrowserSessionClient(fetch, {
      now: () => new Date('2026-07-30T12:00:00.000Z'),
    });
    history.replaceState(
      null,
      '',
      '/#/connect/exchange_abcdefghijklmnopqrstuvwxyz123456',
    );
    await client.exchangeConnectFragment(window);
    await client.sessionFetch('/api/v1/inquiries', {
      method: 'POST',
      body: JSON.stringify({ queryId: 'query_1' }),
    });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-COSMO-CSRF': 'csrf_abcdefghijklmnopqrstuvwxyz123456',
      },
    });
    expect(document.cookie).not.toContain('csrf');
  });
});
```

- [ ] **Step 4: Run the state and session tests and verify they fail**

Run: `npm exec --workspace @cosmo/workbench -- vitest run src/state/use-workbench.test.tsx src/gateway/session.test.ts`

Expected: FAIL because the workbench package, state, and browser session helper do not exist.

- [ ] **Step 5: Implement one-time session exchange and CSRF-bound requests**

`createBrowserSessionClient()` owns the CSRF token in a private closure that is lost on reload. Its `exchangeConnectFragment()` matches only `^#/connect/(exchange_[A-Za-z0-9_-]{32,128})$`, decodes the one-time code, POSTs `{ exchangeCode }` to `/api/v1/session/exchange` with `credentials: 'include'`, validates `WorkbenchSessionExchangeResponseSchema`, and removes the entire fragment with:

```ts
history.replaceState(null, '', `${location.pathname}${location.search}`);
```

Remove the fragment in `finally` so a failed or already-used code never remains in history. Do not write the code, session ID, bearer, or CSRF token to localStorage, sessionStorage, IndexedDB, cookies, URL query parameters, application state, logs, errors, or receipts. The server-created session cookie is HttpOnly and unreadable to JavaScript; there is no CSRF cookie. The exchange is the sole POST exempt from authenticated scope, CSRF, and ordinary mutation idempotency headers because those do not yet exist; its atomic one-time code consumption is the idempotency/replay mechanism, it creates no research-operation receipt, and it cannot read or mutate a Brain. The closure's `sessionFetch()` sends the validated in-memory token as `X-COSMO-CSRF` on every later POST and always uses `credentials: 'include'`; it fails `session_not_exchanged` after reload until a new code is exchanged. `main.tsx` completes the exchange before mounting the app.

- [ ] **Step 6: Implement the stable relative gateway**

Use only:

```text
POST /api/v1/session/exchange
GET  /api/v1/brains
GET  /api/v1/brains/:commitId
POST /api/v1/inquiries
POST /api/v1/formations
POST /api/v1/steering/previews
POST /api/v1/steering
POST /api/v1/inventions/previews
POST /api/v1/inventions
POST /api/v1/comparisons
POST /api/v1/federations
GET  /api/v1/wake-briefings/:commitId
```

`HttpWorkbenchGateway` accepts an injected `fetch` and base path, validates every response with Program F schemas, and sends no credentials except the browser's same-origin authorization policy. Program H implements every route in this accepted gateway subset exactly; H's separately frozen product contract may add explicit reviewed-candidate promotion and agenda-activation operations without changing these F routes.

`explainFormation()` posts the exact `FormationInquirySchema` to
`/api/v1/formations` and parses the exact `FormationExplanationSchema`.
`useWorkbench` loads this route when the selected answer/intent names a
formation target; components never manufacture a `FormationTrace` fixture or
reach into Program E directly.

All gateway POSTs call `sessionFetch()`; no component calls `fetch` directly.

After session exchange, `useWorkbench.bootstrap()` calls `listBrains({cursor:null, limit:50, includeSettled:true})`. It selects the first schema-ordered verified entry, preserving that entry's exact `selectedRef`/commit pair; it never manufactures a label or writable ref from a commit. If the catalog is empty it shows a first-run/import state, and if every entry is detached/degraded it remains read-only. A later catalog selection replaces the entire pinned summary atomically before a request can submit.

- [ ] **Step 7: Implement the app shell and visual tokens**

Use a three-region desktop layout that collapses to one column below `880px`:

- left: pinned Brain, commit, intent, compare/federation sources;
- center: query/answer/formation;
- right: provenance, contradictions, and wake briefing.

Use system fonts, warm neutral canvas, ink, ledger blue, oxidized red only for contradiction/error, and no purple gradient:

```css
:root {
  color-scheme: light;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --canvas: #f2efe8;
  --paper: #fffdf8;
  --ink: #171b1f;
  --muted: #667078;
  --line: #d7d0c4;
  --ledger: #244d65;
  --ledger-soft: #dce8ec;
  --oxide: #9a3f34;
  --focus: #0c6d86;
}
```

Display commit IDs and corpus pins persistently; never hide them behind an advanced drawer.

- [ ] **Step 8: Run the state/session tests and build**

Run: `npm exec --workspace @cosmo/workbench -- vitest run src/state/use-workbench.test.tsx src/gateway/session.test.ts && npm run build --workspace @cosmo/workbench`

Expected: PASS; Vite writes only `apps/workbench/dist/`.

- [ ] **Step 9: Commit**

```bash
git add apps/workbench/tsconfig.json \
  apps/workbench/vite.config.ts apps/workbench/index.html \
  apps/workbench/src/main.tsx apps/workbench/src/App.tsx \
  apps/workbench/src/styles.css apps/workbench/src/gateway/types.ts \
  apps/workbench/src/gateway/http-gateway.ts \
  apps/workbench/src/gateway/session.ts \
  apps/workbench/src/gateway/session.test.ts \
  apps/workbench/src/state/use-workbench.ts \
  apps/workbench/src/state/use-workbench.test.tsx \
  apps/workbench/src/test/setup.ts apps/workbench/src/test/fake-gateway.ts
git commit -m "feat(workbench): scaffold pinned inquiry shell"
```

## Task 11: Render assertion provenance and causal formation

**Files:**
- Create: `apps/workbench/src/view-models.ts`
- Create: `apps/workbench/src/view-models.test.ts`
- Create: `apps/workbench/src/components/brain-pin-bar.tsx`
- Create: `apps/workbench/src/components/mode-switch.tsx`
- Create: `apps/workbench/src/components/intent-picker.tsx`
- Create: `apps/workbench/src/components/query-composer.tsx`
- Create: `apps/workbench/src/components/answer-panel.tsx`
- Create: `apps/workbench/src/components/assertion-card.tsx`
- Create: `apps/workbench/src/components/provenance-drawer.tsx`
- Create: `apps/workbench/src/components/formation-trace.tsx`
- Create co-located tests for each component.
- Modify: `apps/workbench/src/App.tsx`
- Modify: `apps/workbench/src/styles.css`

**Interfaces:**
- Consumes: `InquiryAnswer`, `InquiryAssertion`,
  `InquiryVerificationFinding`, Program E's exact addressed
  `FormationTrace`, and `WorkbenchBrainSummary`.
- Produces: pure strict `AssertionCardModel`/`FormationTraceModel` adapters and
  accessible answer/provenance/formation UI.

- [ ] **Step 1: Write a failing assertion-label test**

```tsx
test('all five assertion types remain visible and distinct', () => {
  render(<AnswerPanel answer={fiveAssertionAnswerFixture()} />);
  expect(screen.getByText('Sourced fact')).toBeVisible();
  expect(screen.getByText('Brain synthesis')).toBeVisible();
  expect(screen.getByText('New in this answer')).toBeVisible();
  expect(screen.getByText('Speculation')).toBeVisible();
  expect(screen.getByText('Human judgment')).toBeVisible();
  expect(screen.getByText('No accumulated-cognition credit')).toBeVisible();
});

test('formation view reports missing history', () => {
  render(<FormationTrace trace={buildFormationTraceModel(
    incompleteFormationFixture(),
  )} />);
  expect(screen.getByText(/history is incomplete/i)).toBeVisible();
  expect(screen.getByText(/candidate event unavailable/i)).toBeVisible();
});

test('assertion cards join the one exact verifier finding and derive credit', () => {
  const models = buildAssertionCardModels(fiveAssertionAnswerFixture());
  const synthesis = models.find(
    (model) => model.assertion.type === 'committed_brain_synthesis',
  )!;
  const fresh = models.find(
    (model) => model.assertion.type === 'new_connection_in_answer',
  )!;
  assert.equal(synthesis.accumulatedCognitionCredit, 'preexisting_brain');
  assert.equal(fresh.accumulatedCognitionCredit, 'query_time_only');
  assert.equal(fresh.verification.assertionId, fresh.assertion.assertionId);
});

test('formation view model preserves addressed nodes, edges, and journal order', () => {
  const trace = formationTraceAcrossMergedLayersFixture();
  const model = buildFormationTraceModel(trace);
  assert.deepEqual(model.resolvedTarget, trace.resolvedTarget);
  assert.deepEqual(
    model.nodes.map((node) => node.address),
    trace.nodes.map((node) => node.address),
  );
  assert.deepEqual(
    model.edges.map((edge) => edge.address),
    trace.edges.map((edge) => edge.address),
  );
  assert.deepEqual(
    model.events.map((event) => event.journalCursor),
    [...trace.events]
      .sort(compareJournalCursorThenEventId)
      .map((event) => event.journalCursor),
  );
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm exec --workspace @cosmo/workbench -- vitest run src/view-models.test.ts src/components/answer-panel.test.tsx src/components/formation-trace.test.tsx`

Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement persistent pins and clear mode/intent controls**

`brain-pin-bar` displays readable Brain label, full copyable commit ID, corpus snapshot count/list, Principal version, and read-only/writable mode. `mode-switch` uses a labeled three-option control:

- Ask — `Read only`
- Steer — `Writes relationship or research direction`
- Invent — `Creates a candidate branch`

The chosen mutation meaning remains beside the submit button.

```tsx
export function ModeSwitch({ mode, onChange }: ModeSwitchProps) {
  const options = [
    ['ask', 'Ask', 'Read only'],
    ['steer', 'Steer', 'Writes relationship or research direction'],
    ['invent', 'Invent', 'Creates a candidate branch'],
  ] as const;
  return (
    <fieldset className="mode-switch">
      <legend>Inquiry mode</legend>
      {options.map(([value, label, meaning]) => (
        <label key={value}>
          <input
            type="radio"
            name="inquiry-mode"
            value={value}
            checked={mode === value}
            onChange={() => onChange(value)}
          />
          <span>{label}</span>
          <small>{meaning}</small>
        </label>
      ))}
    </fieldset>
  );
}
```

- [ ] **Step 4: Implement assertion cards and provenance**

Each assertion card shows one type badge, text, verification status, opposing evidence count, and support links. `provenance-drawer` exposes exact EvidenceSpan, claim, cognition node, RelationshipEvent, candidate event, reviewer, Principal decision, and commit identities. A blocked assertion is not rendered as ordinary answer prose.

```tsx
export type AccumulatedCognitionCredit =
  | 'preexisting_brain'
  | 'query_time_only'
  | 'not_applicable';

export interface AssertionCardModel {
  assertion: InquiryAssertion;
  verification: InquiryVerificationFinding;
  accumulatedCognitionCredit: AccumulatedCognitionCredit;
  opposingEvidenceCount: number;
}

export function buildAssertionCardModels(
  answer: InquiryAnswer,
): AssertionCardModel[] {
  const findings = new Map(
    answer.verification.findings.map((finding) => [
      finding.assertionId,
      finding,
    ]),
  );
  return answer.assertions.map((assertion) => {
    const verification = findings.get(assertion.assertionId);
    if (!verification) throw typedError('assertion_verification_missing');
    return {
      assertion,
      verification,
      accumulatedCognitionCredit:
        assertion.type === 'committed_brain_synthesis'
          ? 'preexisting_brain'
          : assertion.type === 'new_connection_in_answer'
            ? 'query_time_only'
            : 'not_applicable',
      opposingEvidenceCount: verification.opposingEvidenceSupports.length,
    };
  });
}

export function AssertionCard({ model, onOpenProvenance }: AssertionCardProps) {
  const { assertion, verification } = model;
  return (
    <article className={`assertion assertion--${assertion.type}`}>
      <header>
        <span className="assertion__type">{ASSERTION_LABELS[assertion.type]}</span>
        <span className="assertion__verification">
          {verification.result}
        </span>
      </header>
      <p>{assertion.text}</p>
      {model.accumulatedCognitionCredit === 'query_time_only' && (
        <p className="assertion__limit">No accumulated-cognition credit</p>
      )}
      <p>{model.opposingEvidenceCount} opposing evidence spans</p>
      <button type="button" onClick={() => onOpenProvenance(assertion.assertionId)}>
        Inspect provenance
      </button>
    </article>
  );
}
```

The drawer receives the model, never a bare logical ID. Claim and cognition
links use their full addresses; Relationship links use their exact
Relationship-root address; formation events use source commit plus journal
cursor. If the same logical ID occurs in two merged leaves, both attributed
rows remain visible.

- [ ] **Step 5: Render formation as a bounded accessible SVG plus ordered text**

Use typed edge styles and direct node labels; do not add a graph dependency.
`buildFormationTraceModel()` consumes Program E's exact trace without relabeling
or flattening its addresses. Nodes and edges preserve their full addresses.
`events` is the sole chronological surface and is validated in Program E's
`(journalCursor,eventId)` order; the canonical ID arrays are not presented as a
timeline. Include the chronological textual equivalent beneath the SVG for
keyboard/screen-reader access. Missing lineage is a visible node, not an
inferred connector.

```tsx
export interface FormationTraceModel {
  brainCommitId: FormationTrace['brainCommitId'];
  requestedTarget: FormationTrace['requestedTarget'];
  resolvedTarget: FormationTrace['resolvedTarget'];
  nodes: FormationTrace['nodes'];
  edges: FormationTrace['edges'];
  events: FormationTrace['events'];
  evidenceSpanIds: FormationTrace['evidenceSpanIds'];
  candidateEventIds: FormationTrace['candidateEventIds'];
  reviewFindingIds: FormationTrace['reviewFindingIds'];
  principalDecisionIds: FormationTrace['principalDecisionIds'];
  researchReceiptRefs: FormationTrace['researchReceiptRefs'];
  runtimeReceiptRefs: FormationTrace['runtimeReceiptRefs'];
  semanticRoleAttemptRefs: FormationTrace['semanticRoleAttemptRefs'];
  committedCandidateReviewReceiptRefs:
    FormationTrace['committedCandidateReviewReceiptRefs'];
  humanInventDraftRefs: FormationTrace['humanInventDraftRefs'];
  humanInventPreviewRefs: FormationTrace['humanInventPreviewRefs'];
  commitIds: FormationTrace['commitIds'];
  complete: boolean;
  missing: FormationTrace['missing'];
  inferredEvents: FormationTrace['inferredEvents'];
}

export function buildFormationTraceModel(
  trace: FormationTrace,
): FormationTraceModel {
  requireJournalCursorThenEventIdOrder(trace.events);
  return {
    brainCommitId: trace.brainCommitId,
    requestedTarget: trace.requestedTarget,
    resolvedTarget: trace.resolvedTarget,
    nodes: trace.nodes,
    edges: trace.edges,
    events: trace.events,
    evidenceSpanIds: trace.evidenceSpanIds,
    candidateEventIds: trace.candidateEventIds,
    reviewFindingIds: trace.reviewFindingIds,
    principalDecisionIds: trace.principalDecisionIds,
    researchReceiptRefs: trace.researchReceiptRefs,
    runtimeReceiptRefs: trace.runtimeReceiptRefs,
    semanticRoleAttemptRefs: trace.semanticRoleAttemptRefs,
    committedCandidateReviewReceiptRefs:
      trace.committedCandidateReviewReceiptRefs,
    humanInventDraftRefs: trace.humanInventDraftRefs,
    humanInventPreviewRefs: trace.humanInventPreviewRefs,
    commitIds: trace.commitIds,
    complete: trace.complete,
    missing: trace.missing,
    inferredEvents: trace.inferredEvents,
  };
}

const MISSING_FORMATION_LABELS: Record<
  FormationTrace['missing'][number],
  string
> = {
  node: 'node unavailable',
  edge: 'edge unavailable',
  evidence_span: 'evidence span unavailable',
  candidate_event: 'candidate event unavailable',
  review_finding: 'review finding unavailable',
  principal_decision: 'Principal decision unavailable',
  research_receipt: 'research receipt unavailable',
  runtime_receipt: 'runtime receipt unavailable',
  semantic_role_attempt: 'semantic role attempt unavailable',
  committed_candidate_review_receipt:
    'committed candidate review receipt unavailable',
  human_invent_draft: 'Human Invent draft unavailable',
  human_invent_preview: 'Human Invent preview unavailable',
  commit: 'commit unavailable',
  journal_bound: 'journal bound unavailable',
};

export function FormationTrace({ trace }: { trace: FormationTraceModel }) {
  return (
    <section aria-labelledby="formation-title">
      <h2 id="formation-title">How this idea formed</h2>
      {!trace.complete && (
        <p role="status">
          Idea history is incomplete: {trace.missing
            .map((reason) => MISSING_FORMATION_LABELS[reason])
            .join(', ')}
        </p>
      )}
      <svg role="img" aria-label="Causal formation graph">
        {layoutTrace(trace).edges.map(renderTypedEdge)}
        {layoutTrace(trace).nodes.map(renderLabeledNode)}
      </svg>
      <ol aria-label="Formation events in journal order">
        {trace.events.map((event) => (
          <li key={`${event.sourceCommitId}:${event.journalCursor}:${event.eventId}`}>
            <code>{event.event.eventType}</code>
            {' · '}
            <code>{event.eventId}</code>
            {' · journal '}
            <code>{event.journalCursor}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}
```

- [ ] **Step 6: Run component tests and build**

Run: `npm test --workspace @cosmo/workbench && npm run build --workspace @cosmo/workbench`

Expected: PASS; all five assertion labels and incomplete-lineage disclosure are visible.

- [ ] **Step 7: Commit**

```bash
git add apps/workbench/src/App.tsx apps/workbench/src/styles.css \
  apps/workbench/src/view-models.ts \
  apps/workbench/src/view-models.test.ts \
  apps/workbench/src/components/brain-pin-bar.tsx \
  apps/workbench/src/components/brain-pin-bar.test.tsx \
  apps/workbench/src/components/mode-switch.tsx \
  apps/workbench/src/components/mode-switch.test.tsx \
  apps/workbench/src/components/intent-picker.tsx \
  apps/workbench/src/components/intent-picker.test.tsx \
  apps/workbench/src/components/query-composer.tsx \
  apps/workbench/src/components/query-composer.test.tsx \
  apps/workbench/src/components/answer-panel.tsx \
  apps/workbench/src/components/answer-panel.test.tsx \
  apps/workbench/src/components/assertion-card.tsx \
  apps/workbench/src/components/assertion-card.test.tsx \
  apps/workbench/src/components/provenance-drawer.tsx \
  apps/workbench/src/components/provenance-drawer.test.tsx \
  apps/workbench/src/components/formation-trace.tsx \
  apps/workbench/src/components/formation-trace.test.tsx
git commit -m "feat(workbench): expose cognition provenance"
```

## Task 12: Add compare, federation, wake, and reviewed mutation surfaces

**Files:**
- Create: `apps/workbench/src/components/compare-panel.tsx`
- Create: `apps/workbench/src/components/federation-panel.tsx`
- Create: `apps/workbench/src/components/wake-briefing-panel.tsx`
- Create: `apps/workbench/src/components/mutation-review.tsx`
- Create co-located tests for each component.
- Modify: `apps/workbench/src/App.tsx`
- Modify: `apps/workbench/src/state/use-workbench.ts`
- Modify: `apps/workbench/src/styles.css`

**Interfaces:**
- Consumes: compare/federation/wake and Steer/Invent contracts.
- Produces: complete operator surface with explicit mutation confirmation.

- [ ] **Step 1: Write failing immutable-compare and mutation-review tests**

```tsx
test('federation labels every assertion by Brain commit', () => {
  render(<FederationPanel result={federatedResultFixture()} />);
  expect(screen.getByText('Physics Brain')).toBeVisible();
  expect(screen.getByText(`sha256:${'a'.repeat(64)}`)).toBeVisible();
  expect(screen.getByText('History Brain')).toBeVisible();
  expect(screen.getByText(`sha256:${'b'.repeat(64)}`)).toBeVisible();
});

test('Steer cannot submit before exact mutation review', async () => {
  const user = userEvent.setup();
  const onConfirm = vi.fn();
  render(<MutationReview preview={steerPreviewFixture()} onConfirm={onConfirm} />);
  expect(screen.getByRole('button', { name: 'Commit steering event' })).toBeDisabled();
  await user.click(screen.getByLabelText('I reviewed the exact parent, event, and diff'));
  await user.click(screen.getByRole('button', { name: 'Commit steering event' }));
  expect(onConfirm).toHaveBeenCalledOnce();
});

test('Invent names its branch and preserves the queried commit', () => {
  render(<MutationReview preview={inventPreviewFixture()} />);
  expect(screen.getByText('Queried commit remains unchanged')).toBeVisible();
  expect(screen.getByText('Candidate branch')).toBeVisible();
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `npm exec --workspace @cosmo/workbench -- vitest run src/components/federation-panel.test.tsx src/components/mutation-review.test.tsx`

Expected: FAIL because these components do not exist.

- [ ] **Step 3: Implement compare and federation panels**

Compare displays changes by object class rather than one score, rendering the
`added`, `removed`, and `status_changed` variants without inventing a missing
side. Federation uses `result.sourceIdentities` for Brain labels, shows each
Brain/commit source beside each released assertion, preserves conflicts and
rights-withheld commitments, and displays the distinct verifier result. It
never derives a label from a commit prefix when the result supplies one. Both
remain within Ask mode and expose a `No refs changed` receipt.

```tsx
export function ComparePanel({ result }: { result: ComparisonResult }) {
  return (
    <section>
      <h2>Commit comparison</h2>
      <CommitPair left={result.leftCommitId} right={result.rightCommitId} />
      <ChangeSection title="Claim status" rows={result.changedClaimStatuses} />
      <ChangeSection title="Questions" rows={result.questionChanges} />
      <ChangeSection title="Topology" rows={result.topologyChanges} />
      <ChangeSection title="Activation" rows={result.activationChanges} />
      <ChangeSection title="Negative knowledge" rows={result.negativeKnowledgeChanges} />
      <p className="integrity-receipt">No refs changed</p>
    </section>
  );
}
```

- [ ] **Step 4: Implement wake briefing without feeding it back into cognition**

Display exact parent/child IDs, metabolism policy, consolidation mappings, contradictions, dream questions, activation changes, retained dissent, failures, and open questions. Label the briefing as a projection/receipt, not a Brain source.

```tsx
export function WakeBriefingPanel({ briefing }: { briefing: WakeBriefing }) {
  return (
    <section>
      <header>
        <p className="eyebrow">Projection receipt · not Brain evidence</p>
        <h2>Wake briefing</h2>
      </header>
      <CommitPair left={briefing.parentCommitId} right={briefing.childCommitId} />
      <ReceiptList title="Consolidations" rows={briefing.consolidationMappings} />
      <ReceiptList title="Contradictions" rows={briefing.contradictionCandidateIds} />
      <ReceiptList title="Dream questions" rows={briefing.dreamQuestionIds} />
      <ReceiptList
        title="Dream candidate receipts"
        rows={briefing.dreamCandidateBranchReceiptRefs}
      />
      <ReceiptList
        title="Dream role receipts"
        rows={briefing.dreamStructuredRoleReceiptRefs}
      />
      <ReceiptList title="Open questions" rows={briefing.openQuestionIds} />
    </section>
  );
}
```

- [ ] **Step 5: Implement reviewed Steer/Invent submission**

Before enabling submit, show:

- mode and target;
- exact parent commit/ref;
- payload/event or candidate branch purpose;
- exact draft hash;
- reviewer principal/scopes and public-safe authority fingerprint;
- authority boundary; and
- resulting write semantics.

Require an explicit review checkbox after every preview change. A server response with an unexpected parent or child identity fails closed and is not displayed as success.

```tsx
const [reviewedHash, setReviewedHash] = useState<string | null>(null);
const currentHash = preview.draftHash;
const canCommit = reviewedHash === currentHash;
return (
  <section className="mutation-review">
    <MutationBoundary preview={preview} />
    <label>
      <input
        type="checkbox"
        checked={canCommit}
        onChange={(event) => setReviewedHash(event.target.checked ? currentHash : null)}
      />
      I reviewed the exact parent, event, and diff
    </label>
    <button type="button" disabled={!canCommit} onClick={() => onConfirm(preview)}>
      {preview.kind === 'steer' ? 'Commit steering event' : 'Create candidate branch'}
    </button>
  </section>
);
```

- [ ] **Step 6: Run the complete UI suite and production build**

Run: `npm test --workspace @cosmo/workbench && npm run build --workspace @cosmo/workbench`

Expected: PASS; compare/federation are read-only, mutations require review, and `apps/workbench/dist/` builds.

- [ ] **Step 7: Commit**

```bash
git add apps/workbench/src/App.tsx apps/workbench/src/styles.css \
  apps/workbench/src/state/use-workbench.ts \
  apps/workbench/src/components/compare-panel.tsx \
  apps/workbench/src/components/compare-panel.test.tsx \
  apps/workbench/src/components/federation-panel.tsx \
  apps/workbench/src/components/federation-panel.test.tsx \
  apps/workbench/src/components/wake-briefing-panel.tsx \
  apps/workbench/src/components/wake-briefing-panel.test.tsx \
  apps/workbench/src/components/mutation-review.tsx \
  apps/workbench/src/components/mutation-review.test.tsx
git commit -m "feat(workbench): add compare and mutation review"
```

## Task 13: Issue Program F's read-only inquiry/workbench receipt

**Files:**
- Create: `scripts/verify-program-f.mjs`
- Modify: `package.json`
- Create: `docs/receipts/program-f-inquiry-workbench.json`

**Interfaces:**
- Consumes: Program F package and UI suites, Brain-over-files proof, and generated workbench build.
- Produces: reviewed Program F stop/go receipt for Programs G and H.

- [ ] **Step 1: Run a static Home23 and generated-output boundary scan**

Run:

```bash
if rg -n -i 'home23|cosmo23' packages/inquiry apps/workbench; then
  echo 'Program F contains a forbidden Home23 dependency' >&2
  exit 1
fi
if git ls-files apps/workbench/dist | grep -q .; then
  echo 'Generated workbench dist must remain untracked' >&2
  exit 1
fi
```

Expected: exit `0`; neither source tree references Home23 and `dist/` is untracked.

- [ ] **Step 2: Add the verifier without generating a receipt**

Add `"verify:program-f": "node scripts/verify-program-f.mjs"` to root scripts. The script executes:

```js
const commands = [
  ['npm', ['run', 'build']],
  ['npm', ['test', '--workspace', '@cosmo/contracts']],
  ['npm', ['test', '--workspace', '@cosmo/repository']],
  ['npm', ['test', '--workspace', '@cosmo/corpus']],
  ['npm', ['test', '--workspace', '@cosmo/cognition']],
  ['npm', ['test', '--workspace', '@cosmo/inquiry']],
  ['npm', ['test', '--workspace', '@cosmo/workbench']],
  ['npm', ['run', 'build', '--workspace', '@cosmo/workbench']],
];
for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
```

It writes `docs/receipts/program-f-inquiry-workbench.json` and records:

- exact source commit;
- Program E receipt ID;
- QueryRequest/assertion/gateway contract hashes;
- read-only authority fingerprints before/after each defining probe;
- Brain-over-files fixture and proof receipt hashes;
- zero excluded-artifact reads;
- zero query-time connections credited as accumulated cognition;
- assertion/verifier trap results;
- production generator/verifier port contract results and proof their attempts, roles, contexts, and runtime receipts differ;
- comparison/federation no-write receipts;
- Steer/Invent parent and branch invariants;
- workbench dependency lock and build artifact hash;
- one-time session exchange, fragment removal, HttpOnly-cookie, and CSRF-header test receipts;
- all commands and exit codes;
- confirmation that Home23 was absent; and
- `stopGo: go` only if every item is green.

The receipt object is constructed only from command outputs and computed hashes:

```js
const receipt = ProgramFReceiptSchema.parse({
  schema: 'cosmo.program-f-receipt.v1',
  testedGitCommit: expectedCommit,
  testedGitTree: await capture('git', ['rev-parse', 'HEAD^{tree}']),
  programEReceiptId: await hashFile('docs/receipts/program-e-living-brain-metabolism.json'),
  brainOverFilesProofId: await hashFile(proofReceiptPath),
  authorityChanged: authorityProbe.changed,
  excludedArtifactBytesRead: artifactProbe.bytesRead,
  queryTimeConnectionsCredited: formationProbe.queryTimeCredit,
  productionInquiryContractPassed: productionPortProbe.passed,
  comparisonAndFederationWrites: readOnlyProbe.writeCount,
  sessionExchangePassed: sessionProbe.exchangePassed,
  csrfBindingPassed: sessionProbe.csrfPassed,
  home23Present: independenceProbe.home23Present,
  stopGo: allRequiredChecksPassed ? 'go' : 'stop',
});
```

The verifier requires `--expected-commit`, refuses a dirty tree, verifies `HEAD` and `HEAD^{tree}`, and never treats its contract-only production-port probe as a live semantic trial. Program G owns the mandatory live generator/verifier proof.

- [ ] **Step 3: Commit the complete verifier before executing it**

```bash
git add scripts/verify-program-f.mjs package.json package-lock.json
git commit -m "test(inquiry): add Program F verification harness"
test -z "$(git status --porcelain)"
```

Expected: the verifier and all Program F source/tests are in the exact clean commit that will be tested; the generated receipt is not part of that commit.

- [ ] **Step 4: Run the complete Program F verification on the clean commit**

Run:

```bash
candidate_commit="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
npm run verify:program-f -- --expected-commit "$candidate_commit"
jq -e --arg commit "$candidate_commit" '
  .testedGitCommit == $commit
  and .productionInquiryContractPassed == true
  and .authorityChanged == false
  and .stopGo == "go"
' docs/receipts/program-f-inquiry-workbench.json
```

Expected: every command exits `0`; Brain-over-files passes, the production inquiry port contract passes, UI build succeeds, and the receipt names the exact clean commit.

- [ ] **Step 5: Verify the receipt and source hygiene**

Run:

```bash
test "$(git status --porcelain)" = "?? docs/receipts/program-f-inquiry-workbench.json"
```

Expected: the complete worktree contains only the newly generated receipt; source, fixture, lockfile, unstaged, or extra untracked drift invalidates the run.

- [ ] **Step 6: Commit only the reviewed receipt**

```bash
git add docs/receipts/program-f-inquiry-workbench.json
test "$(git diff --cached --name-only)" = "docs/receipts/program-f-inquiry-workbench.json"
git diff --cached --check
test "$(git status --porcelain)" = "A  docs/receipts/program-f-inquiry-workbench.json"
git commit -m "docs(inquiry): receipt brain over files"
test -z "$(git status --porcelain)"
```

## Program F completion gate

Program F is complete only when:

- Ask pins exact Brain/corpus state and proves no canonical mutation;
- all ten intents use their declared retrieval policy;
- all answer content is covered by one of five assertion types;
- independent verification gates sourced and high-stakes output;
- the concrete production inquiry port uses Program D's one
  `StructuredRoleExecutionPort`, pins owner-defined generator/verifier output
  schemas, and produces separate attempt/runtime/output receipts, while live
  semantic release credit remains reserved for Program G;
- idea formation is a bounded causal subgraph with honest gaps and preserves
  E's complete research/runtime/semantic-role/review/Human-Invent provenance;
- surprise answers identify prior expectation, connection, counterevidence, Covenant relevance, and next question;
- compare/federation leave every ref/root unchanged, comparison represents
  additions/removals, and federation independently verifies every released
  assertion;
- Steer and Invent require heads-only refs and explicit reviewed write
  semantics; Invent maps the exact E human-origin candidate contract and has a
  separate D-reviewed promotion path;
- program-direction Steer records a distinct proposal event and remains
  candidate-only until the explicit reviewed D/E activation lifecycle;
- the frozen Brain-over-files proof passes with artifacts, network, tools, workers, Steer, and Invent disabled;
- the restrained workbench exposes pins, epistemic types, provenance, formation, comparison, wake, and mutation review;
- the production workbench build succeeds; and
- one-time browser connection codes are exchanged and removed without persistent bearer state, and every POST is session-cookie/CSRF bound; and
- the reviewed receipt says `stopGo: go`.

Program H may package and serve the exact workbench build only after this receipt is committed. It implements the frozen relative HTTP routes and does not revise Program F's cognitive or UI semantics.
