# Standalone COSMO Program D: Research Program and Worker Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build COSMO’s durable Research Covenant, Relationship, Question Ecology, Principal decision role, bounded expeditions, event-admission boundary, and replaceable WorkerRuntime while proving that this machinery cannot be mistaken for COSMO without Program E’s Living Brain and sleep/dream metabolism.

**Architecture:** `@cosmo/research` owns semantic research state, autonomy, questions, Principal proposals, and COSMO-authored ContextBundles. `@cosmo/runtime` owns execution attempts, operational quarantine, checkpoints, fencing, retries, reconciliation, and one OpenAI Agents SDK adapter. Workers emit untrusted envelopes; admitted cognitive events and Principal decisions still require Program E to materialize a Living Brain, commit cognition, perform metabolism, wake, and pass pinned inquiry.

**Tech Stack:** Node.js 22.12+, TypeScript ESM, npm workspaces, Zod 4.4.3, `node:test`, Program B repository/trust/lease APIs, Program C evidence and claim APIs, `@openai/agents` 0.14.1 behind the frozen `WorkerRuntime` interface.

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
- COSMO owns every prompt, specialist role, Question, allocation, handoff purpose, semantic ContextBundle, and Principal decision. A runtime SDK owns none of them.
- Runtime sessions, `previousResponseId`, SDK history, serialized `RunState`, compaction output, traces, and checkpoints remain runtime-only state.
- A runtime `completion_proposal` does not answer a Question, support a Claim, accept an artifact, or create a Brain commit.
- Cancellation, authorization expiry, and branch-epoch changes fence every later worker event before cognitive admission.
- Program D’s gate receipt must always say `"cosmoAccepted":false` and `"blockedOn":"program-e-living-brain-metabolism"`.
- Every non-genesis D mutation input, stored proposal, root-update proposal, and
  returned recording carries Program B's exact `brain_lineage` event scope.
  Its `basedOnBrainCommitId` equals the expected parent, its target/program/
  lineage/trust match the requesting event, and every newly appended mutation
  event repeats it. Program E rejects a D proposal whose scope or selected
  event differs; no service infers branch membership from journal position.

### Content-addressing rule for returned records

An interface that exposes the `ObjectId` of its own record is a decoded wrapper. The stored canonical payload omits that self-ID, Program B returns the `ObjectRef`, and the service attaches `objectId` before validating the public wrapper. This applies to `QuestionMutationProposal.questionObjectId`, `ResearchProgramMutationReceipt.researchProgramMutationReceiptId`, `LaneUseReceipt.laneUseReceiptId`, `PrincipalDecision.decisionId`, `RuntimeCheckpointRef.checkpointObjectId`, `ReconciliationReceipt.reconciliationReceiptId`, `CausalOriginAttestation.attestationId`, and `ResearchToolInvocationReceipt.receiptId`. `PromptProvenance.promptObjectId` instead names the separately stored prompt body. No runtime or research service places an object’s hash inside the bytes used to compute that hash.

---

## Program Boundary and Explicit Non-Acceptance

Program D produces a testable research-control and execution subsystem. It is not an independently acceptable COSMO release and must never be presented as “COSMO is running.”

Program D may prove:

- a Covenant and human Research Relationship survive restart;
- Questions remain distinct from tasks, goals, and Claims;
- rolling autonomy cannot silently decay to zero;
- an ExpeditionContract is complete, bounded, and pinned;
- COSMO, not the SDK, composes semantic context and roles;
- raw events are quarantined before admission;
- a deterministic runtime can pause, resume, cancel, duplicate, delay, and lose events safely;
- startup reconciliation has deterministic outcomes;
- the production OpenAI adapter conforms to `WorkerRuntime`; and
- a qualified Principal promotion proposal can be produced.

Program D cannot prove:

- a Living Brain exists;
- candidate cognition entered a candidate-only Brain commit;
- canonical cognition advanced;
- activation changed;
- sleep/dream metabolized memory;
- a wake commit exists;
- surprise or idea formation pre-existed a query; or
- COSMO genuinely continued thinking.

Those proofs belong to the joint D+E gate. Every Program D receipt, status object, and handoff repeats this limitation.

The Program D contract gate is:

```bash
npm run verify:program-d
```

Expected: exit `0`, all research/runtime contract tests pass, and the generated receipt contains:

```json
{
  "program": "D",
  "status": "contract-complete",
  "cosmoAccepted": false,
  "blockedOn": "program-e-living-brain-metabolism"
}
```

## File Map

All paths below are relative to `/Users/jtr/_JTR23_/cosmo`.

| Path | Responsibility | Owning task |
| --- | --- | --- |
| `packages/contracts/src/research.ts` | Covenant, Relationship, Question, Program, Principal, allocation, ExpeditionContract, and ContextBundle schemas | 1 |
| `packages/contracts/src/runtime.ts` | RuntimeAuthorization, WorkerRuntime event/checkpoint/state, admission, and receipt schemas | 1 |
| `packages/contracts/src/index.ts` | Program D contract exports | 1 |
| `packages/contracts/test/research-runtime-contracts.test.ts` | Frozen-shape and strict-rejection tests | 1 |
| `packages/research/package.json` | Research package dependencies and scripts | 1 |
| `packages/research/tsconfig.json` | Research package TypeScript configuration | 1 |
| `packages/research/src/index.ts` | Public research exports | 1–11 |
| `packages/research/test/support.ts` | Deterministic research fixtures and spies | 1 |
| `packages/runtime/package.json` | Runtime package dependencies and scripts | 1, modified 10 |
| `packages/runtime/tsconfig.json` | Runtime package TypeScript configuration | 1 |
| `packages/runtime/src/index.ts` | Public runtime exports | 1–11 |
| `packages/runtime/test/support.ts` | Runtime state, adapter, clock, trust, and repository test doubles | 1 |
| `packages/research/src/covenant-service.ts` | Initial Covenant and authenticated revision proposals | 2 |
| `packages/research/src/relationship-service.ts` | RelationshipEvent recording and deterministic state projection | 2 |
| `packages/research/test/covenant-relationship.test.ts` | Versioning, correction, permission, and inference tests | 2 |
| `packages/research/src/question-service.ts` | Question origination and lifecycle transitions | 3 |
| `packages/research/src/causal-origin-attestor.ts` | Kernel-recomputed prompt/Question causality and autonomy-credit authority | 3 |
| `packages/research/test/question-ecology.test.ts` | Parentage, provenance, dormancy, revival, and category tests | 3 |
| `packages/research/src/autonomy-policy.ts` | Allocation validation and rolling autonomy accounting | 4 |
| `packages/research/src/expedition-service.ts` | Bounded ExpeditionContract construction and validation | 4 |
| `packages/research/test/autonomy-expedition.test.ts` | Allocation, provenance, override, and contract tests | 4 |
| `packages/research/src/context-bundle-service.ts` | COSMO-authored semantic context selection and immutable bundle identity | 5 |
| `packages/research/src/context-renderer.ts` | Mandatory/optional packing and omission receipt | 5 |
| `packages/research/test/context-bundle.test.ts` | Pinning, omission, compaction, and untrusted-source tests | 5 |
| `packages/research/src/principal-service.ts` | Versioned Principal policy and typed decision proposals | 6 |
| `packages/research/test/principal-decisions.test.ts` | Periodic authority, review, dissent, and no-direct-write tests | 6 |
| `packages/runtime/src/runtime-state-store.ts` | Private runtime-only run/checkpoint/quarantine persistence | 7 |
| `packages/runtime/src/event-quarantine.ts` | Append-before-admit raw envelope journal | 7 |
| `packages/runtime/src/event-admission-service.ts` | Schema, identity, grant, rights, mission, epoch, fence, and provenance admission | 7 |
| `packages/runtime/test/event-admission.test.ts` | Duplicate, stale, hostile, malformed, and canonicalization tests | 7 |
| `packages/runtime/src/deterministic-conformance-runtime.ts` | Scripted WorkerRuntime and fault injection | 8 |
| `packages/runtime/test/conformance-runtime.test.ts` | Deterministic contract, turnover, duplicate, loss, and late-event tests | 8 |
| `packages/runtime/src/research-tool-registry.ts` | Capability-checked discovery, acquisition, and experiment tool dispatch | 8 |
| `packages/runtime/src/tools/openai-web-search-discovery.ts` | Production hosted-web-search discovery adapter with immutable result receipts | 8, wired 10 |
| `packages/runtime/src/tools/restricted-http-acquisition.ts` | Bounded HTTPS byte acquisition with SSRF, secret, media, redirect, and size controls | 8 |
| `packages/runtime/src/tools/experiment-execution.ts` | Sandboxed experiment invocation into Program C protocol/observation records | 8 |
| `packages/runtime/test/research-tool-registry.test.ts` | Capability, discovery/acquisition chain, denial, and receipt tests | 8 |
| `packages/runtime/src/runtime-controller.ts` | Start, pause, resume, inspect, cancel, and fresh-authorization state machine | 9 |
| `packages/runtime/src/runtime-reconciler.ts` | Startup reconciliation for nonterminal runs | 9 |
| `packages/runtime/test/runtime-lifecycle.test.ts` | Pause/resume/cancel/fence tests | 9 |
| `packages/runtime/test/runtime-reconciliation.test.ts` | Stale lease, missing job, undelivered completion, and duplicate recovery | 9 |
| `packages/runtime/src/openai/openai-agent-factory.ts` | Builds one SDK agent from a COSMO-authored execution plan | 10 |
| `packages/runtime/src/openai/openai-agents-runtime.ts` | Production OpenAI Agents SDK `WorkerRuntime` adapter | 10 |
| `packages/runtime/src/openai/openai-runtime-receipts.ts` | Provider/model/tool/context/tracing receipts | 10 |
| `packages/runtime/test/openai-agents-runtime.test.ts` | Mocked SDK conformance and authority-boundary tests | 10 |
| `packages/runtime/test/openai-agents-runtime.live.test.ts` | Explicitly gated real-API smoke test | 10 |
| `packages/research/src/research-runtime-coordinator.ts` | Question → Expedition → runtime → admission → Principal proposal flow | 11 |
| `packages/research/src/d-e-vertical-gate.ts` | Exact Program E integration port and partial receipt | 11 |
| `packages/research/test/research-runtime-coordinator.test.ts` | Deterministic D flow and explicit E blocker | 11 |
| `packages/research/test/program-d-gate.test.ts` | Program D aggregate contract gate | 12 |
| `scripts/verify-program-d.mjs` | Runs Program D suites and emits non-acceptance receipt | 12 |
| `docs/receipts/program-d-gate.json` | Generated, committed Program D contract receipt | 12 |

## Frozen Program D Interfaces

The program-map `AutonomyAllocation`, `ExpeditionContract`, `RuntimeAuthorization`, and `WorkerRuntime` names and fields are unchanged. The following additions are authoritative for Programs E–H.

```ts
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

export type QuestionOrigin =
  | 'human'
  | 'principal'
  | 'specialist'
  | 'default_mode'
  | 'dream'
  | 'evidence_gap'
  | 'contradiction';

export interface CausalOriginAttestationPayload {
  schema: 'cosmo.causal-origin-attestation.v1';
  promptObjectId: ObjectId;
  initiatingQuestionId: QuestionId;
  admittedSourceEventIds: EventId[];
  parentQuestionIds: QuestionId[];
  humanPrincipalTaskGraphRef: ObjectRef;
  kernelVersion: Sha256;
  classification: 'autonomous' | 'human_directed' | 'ambiguous';
  reasonCodes: string[];
  computedAt: string;
}

export interface CausalOriginAttestation {
  attestationId: ObjectId;
  payload: CausalOriginAttestationPayload;
}

export interface PromptProvenance {
  schema: 'cosmo.prompt-provenance.v1';
  origin: QuestionOrigin;
  initiatingQuestionId: QuestionId;
  sourceEventIds: EventId[];
  promptObjectId: ObjectId;
  originAttestation: CausalOriginAttestation;
  createdAt: string;
}

export interface Question {
  schema: 'cosmo.question.v1';
  questionId: QuestionId;
  wording: string;
  semanticVariants: string[];
  parentQuestionIds: QuestionId[];
  origin: PromptProvenance['origin'];
  originEventId: EventId;
  promptProvenance: PromptProvenance;
  whyItMatters: string;
  domains: string[];
  perspectiveIds: ObjectId[];
  surprise: number;
  uncertainty: number;
  evidenceConsidered: ObjectId[];
  partialAnswerClaimIds: ClaimId[];
  failedApproachIds: ObjectId[];
  humanInterest: string | null;
  status:
    | 'new'
    | 'active'
    | 'incubating'
    | 'partially_answered'
    | 'answered'
    | 'dormant'
    | 'revived'
    | 'abandoned';
  lastMeaningfulChangeAt: string;
}

export interface QuestionMutationProposal {
  schema: 'cosmo.question-mutation-proposal.v1';
  questionObjectId: ObjectId;
  previousQuestionObjectId: ObjectId | null;
  question: Question;
  rationale: string;
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  reviewAt: string | null;
  expiresAt: string | null;
  questionRootUpdate: QuestionRootUpdateProposal;
}

export interface ResearchCovenantPayload {
  schema: 'cosmo.research-covenant.v1';
  purpose: string;
  scope: string[];
  hopedForCharacter: string;
  evidenceMinimum: EvidenceMinimum;
  privacyRules: string[];
  rightsRules: string[];
  riskTolerance: string;
  autonomyPolicy: {
    rollingBudgetUnit: 'tokens' | 'tool_calls' | 'runtime_ms' | 'cost_usd';
    rollingBudgetSize: number;
    minimumActiveAutonomyPercent: number;
    maximumAuthority: string[];
  };
  budgetEnvelope: ExpeditionContract['budget'];
  breadthDepthPreference: string;
  stoppingRules: string[];
  escalationRules: string[];
  explicitApprovalDomains: string[];
  tasteExamples: string[];
  tasteAntiExamples: string[];
  usefulnessDefinition: string;
  noveltyDefinition: string;
  rigorDefinition: string;
  harmDefinition: string;
  inwardSelfResearch: 'forbidden' | 'observational' | 'proposal_only';
}

export interface ProposeInitialCovenantInput {
  schema: 'cosmo.propose-initial-covenant-input.v1';
  expectedBrainCommitId: BrainCommitId;
  expectedRelationshipRootRef: ObjectRef;
  payload: ResearchCovenantPayload;
  approvedByRelationshipEventId: RelationshipEventId;
  proposedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  proposedAt: string;
}

export interface ProposeCovenantRevisionInput {
  schema: 'cosmo.propose-covenant-revision-input.v1';
  expectedBrainCommitId: BrainCommitId;
  expectedRelationshipRootRef: ObjectRef;
  expectedCurrentCovenantPayloadRef: ObjectRef;
  payload: ResearchCovenantPayload;
  approvedByRelationshipEventId: RelationshipEventId;
  proposedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  proposedAt: string;
}

export interface CovenantRevisionProposal {
  schema: 'cosmo.covenant-revision-proposal.v1';
  basedOnBrainCommitId: BrainCommitId;
  previousCovenantPayloadRef: ObjectRef | null;
  covenantPayloadRef: ObjectRef;
  payload: ResearchCovenantPayload;
  relationshipMutation: RelationshipMutationResult;
  approvedByRelationshipEventId: RelationshipEventId;
  proposedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  proposedAt: string;
}

export interface RelationshipEvent {
  schema: 'cosmo.relationship-event.v1';
  relationshipEventId: RelationshipEventId;
  kind:
    | 'covenant_set'
    | 'covenant_revised'
    | 'human_question'
    | 'why_it_matters'
    | 'taste_judgment'
    | 'correction'
    | 'permission_granted'
    | 'permission_revoked'
    | 'direction_accepted'
    | 'direction_rejected'
    | 'answer_form_feedback'
    | 'personal_fact_confirmed'
    | 'personal_inference'
    | 'unresolved_request';
  content: string;
  actorIdentity: Sha256;
  evidenceSpanIds: ObjectId[];
  confidence: number | null;
  confirmedByHuman: boolean;
  reversesRelationshipEventId: RelationshipEventId | null;
  occurredAt: string;
}

export interface RelationshipState {
  schema: 'cosmo.relationship-state.v1';
  throughEventId: RelationshipEventId;
  activePermissions: RelationshipEventId[];
  revokedPermissions: RelationshipEventId[];
  confirmedPersonalFacts: RelationshipEventId[];
  personalInferences: RelationshipEventId[];
  tasteJudgments: RelationshipEventId[];
  corrections: RelationshipEventId[];
  unresolvedRequests: RelationshipEventId[];
}

export interface RecordRelationshipEventInput {
  schema: 'cosmo.record-relationship-event-input.v1';
  expectedBrainCommitId: BrainCommitId;
  expectedRelationshipRootRef: ObjectRef;
  kind: RelationshipEvent['kind'];
  content: string;
  evidenceSpanIds: ObjectId[];
  confidence: number | null;
  confirmedByHuman: boolean;
  reversesRelationshipEventId: RelationshipEventId | null;
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  occurredAt: string;
}

export interface RelationshipMutationResult {
  schema: 'cosmo.relationship-mutation-result.v1';
  event: RelationshipEvent;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  projectedState: RelationshipState;
  relationshipRootUpdate: RelationshipRootUpdateProposal;
}

export type ResearchProgramId = `program_${string}`;

export type ResearchProgramMode =
  | 'guided'
  | 'blended'
  | 'autonomous'
  | 'pure';

export type ResearchProgramStatus =
  | 'draft'
  | 'initializing'
  | 'active'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'cancelling'
  | 'cancelled'
  | 'completion_proposed'
  | 'completed'
  | 'blocked';

export interface ResearchProgramStatePayload {
  schema: 'cosmo.research-program-state.v1';
  programId: ResearchProgramId;
  title: string;
  purpose: string;
  mode: ResearchProgramMode;
  branchRef: `refs/heads/${string}`;
  startingBrainCommitId: BrainCommitId;
  basedOnBrainCommitId: BrainCommitId;
  covenantCommitId: BrainCommitId;
  seedQuestionIds: QuestionId[];
  status: ResearchProgramStatus;
  controlEpoch: number;
  activeRunIds: RunId[];
  stoppingCriteria: string[];
  honestBlockConditions: string[];
  budget: ExpeditionContract['budget'];
  lastPrincipalDecisionId: ObjectId | null;
  lastCognitiveLifecycleDecisionObjectId: ObjectId | null;
  blockedReasonCodes: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ResearchProgramState {
  programStateObjectId: ObjectId;
  payload: ResearchProgramStatePayload;
}

export interface CreateResearchProgramInput {
  schema: 'cosmo.create-research-program-input.v1';
  programId: ResearchProgramId;
  title: string;
  purpose: string;
  mode: ResearchProgramMode;
  branchRef: `refs/heads/${string}`;
  startingBrainCommitId: BrainCommitId;
  expectedProgramRootRef: ObjectRef;
  covenantCommitId: BrainCommitId;
  seedQuestionIds: QuestionId[];
  stoppingCriteria: string[];
  honestBlockConditions: string[];
  budget: ExpeditionContract['budget'];
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  createdAt: string;
}

export interface ProposeResearchProgramDirectionInput {
  schema: 'cosmo.propose-research-program-direction-input.v1';
  expectedBrainCommitId: BrainCommitId;
  title: string;
  purpose: string;
  mode: ResearchProgramMode;
  seedQuestionIds: QuestionId[];
  covenantCommitId: BrainCommitId;
  stoppingRules: string[];
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  proposedAt: string;
}

export interface ResearchProgramDirectionProposalPayload {
  schema: 'cosmo.research-program-direction-proposal.v1';
  expectedBrainCommitId: BrainCommitId;
  title: string;
  purpose: string;
  mode: ResearchProgramMode;
  seedQuestionIds: QuestionId[];
  covenantCommitId: BrainCommitId;
  stoppingRules: string[];
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  proposedAt: string;
}

export interface ResearchProgramDirectionProposal {
  proposalObjectId: ObjectId;
  payload: ResearchProgramDirectionProposalPayload;
}

export interface ResearchProgramControlInput {
  schema: 'cosmo.research-program-control-input.v1';
  programId: ResearchProgramId;
  expectedBrainCommitId: BrainCommitId;
  expectedProgramRootRef: ObjectRef;
  expectedStateObjectId: ObjectId;
  expectedStatus: ResearchProgramStatus;
  action: 'pause' | 'resume' | 'cancel';
  reason: string;
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  requestedAt: string;
}

export interface ProposeProgramSettlementInput {
  schema: 'cosmo.propose-program-settlement-input.v1';
  programId: ResearchProgramId;
  expectedStateObjectId: ObjectId;
  expectedBrainCommitId: BrainCommitId;
  expectedProgramRootRef: ObjectRef;
  principalDecisionId: ObjectId;
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  satisfiedStoppingCriterionIndexes: number[];
  evidenceObjectIds: ObjectId[];
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  proposedAt: string;
}

export interface FinalizeProgramTransitionInput {
  schema: 'cosmo.finalize-program-transition-input.v1';
  programId: ResearchProgramId;
  expectedStateObjectId: ObjectId;
  expectedBrainCommitId: BrainCommitId;
  expectedProgramRootRef: ObjectRef;
  expectedControlEpoch: number;
  action:
    | 'creation_converged'
    | 'pause_converged'
    | 'resume_converged'
    | 'cancel_converged'
    | 'settlement_accepted'
    | 'settlement_rejected';
  cognitiveLifecycleDecisionObjectId: ObjectId;
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  reason: string;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  finalizedAt: string;
}

export interface ResearchProgramMutationReceipt {
  researchProgramMutationReceiptId: ObjectId;
  schema: 'cosmo.research-program-mutation-receipt.v1';
  programId: ResearchProgramId;
  action:
    | 'create'
    | 'pause'
    | 'resume'
    | 'cancel'
    | 'propose_settlement'
    | 'finalize_transition';
  previousStateObjectId: ObjectId | null;
  nextState: ResearchProgramState;
  controlEpoch: number;
  controlEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  fencedRunIds: RunId[];
  checkpointObjectIds: ObjectId[];
  journalRange: JournalRange;
  programRootUpdate: ProgramRootUpdateProposal;
  idempotencyKey: Sha256;
  occurredAt: string;
}

export interface ProgramControlNotice {
  schema: 'cosmo.program-control-notice.v1';
  programId: ResearchProgramId;
  programStateObjectId: ObjectId;
  controlReceiptId: ObjectId;
  controlEpoch: number;
  action: ResearchProgramMutationReceipt['action'];
  nextStatus: ResearchProgramStatus;
  programRootUpdate: ProgramRootUpdateProposal;
}

export interface ResearchProgramMutationResult {
  schema: 'cosmo.research-program-mutation-result.v1';
  receipt: ResearchProgramMutationReceipt;
  controlNotice: ProgramControlNotice;
}

export interface ListResearchProgramsInput {
  schema: 'cosmo.list-research-programs-input.v1';
  brainCommitId: BrainCommitId;
  programRootRef: ObjectRef;
  statuses: ResearchProgramStatus[];
  afterProgramId: ResearchProgramId | null;
  limit: number;
  authorization: MutationAuthorization;
}

export interface ResearchProgramPage {
  schema: 'cosmo.research-program-page.v1';
  brainCommitId: BrainCommitId;
  programRootRef: ObjectRef;
  programs: ResearchProgramState[];
  nextProgramId: ResearchProgramId | null;
}

export interface ListPendingProgramMutationsInput {
  schema: 'cosmo.list-pending-program-mutations-input.v1';
  afterReceiptId: ObjectId | null;
  limit: number;
  authorization: MutationAuthorization;
}

export interface PendingProgramMutationPage {
  schema: 'cosmo.pending-program-mutation-page.v1';
  results: ResearchProgramMutationResult[];
  nextReceiptId: ObjectId | null;
}

export interface QuestionRootPayload {
  schema: 'cosmo.question-root.v1';
  entries: Array<{
    questionId: QuestionId;
    questionObjectRef: ObjectRef;
  }>;
  throughEventId: EventId;
}

export interface QuestionRootUpdateProposal {
  schema: 'cosmo.question-root-update-proposal.v1';
  expectedBrainCommitId: BrainCommitId;
  previousQuestionRootRef: ObjectRef;
  nextQuestionRoot: QuestionRootPayload;
  changedQuestionId: QuestionId;
  nextQuestionRef: ObjectRef;
  mutationEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
}

export interface ProgramRootPayload {
  schema: 'cosmo.program-root.v1';
  entries: Array<{
    programId: ResearchProgramId;
    stateObjectRef: ObjectRef;
    controlEpoch: number;
  }>;
  throughEventId: EventId;
}

export interface ProgramRootUpdateProposal {
  schema: 'cosmo.program-root-update-proposal.v1';
  expectedBrainCommitId: BrainCommitId;
  previousProgramRootRef: ObjectRef;
  nextProgramRoot: ProgramRootPayload;
  changedProgramId: ResearchProgramId;
  nextProgramStateRef: ObjectRef;
  controlEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
}

export interface RelationshipRootPayload {
  schema: 'cosmo.relationship-root.v1';
  covenantPayloadRef: ObjectRef;
  covenantRevisionEventId: RelationshipEventId;
  relationshipStateRef: ObjectRef;
  throughRelationshipEventId: RelationshipEventId;
}

export interface RelationshipRootUpdateProposal {
  schema: 'cosmo.relationship-root-update-proposal.v1';
  expectedBrainCommitId: BrainCommitId;
  previousRelationshipRootRef: ObjectRef;
  nextRelationshipRoot: RelationshipRootPayload;
  relationshipEventId: RelationshipEventId;
  nextRelationshipStateRef: ObjectRef;
  mutationEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
}

export interface ArtifactRecordPayload {
  schema: 'cosmo.artifact-record.v1';
  artifactType:
    | 'research_note'
    | 'report'
    | 'dataset'
    | 'visualization'
    | 'experiment_output'
    | 'export_manifest';
  title: string;
  mediaType: string;
  bytesRef: ObjectRef;
  derivedFromBrainCommitId: BrainCommitId;
  corpusSnapshotIds: CorpusSnapshotId[];
  producingProgramId: ResearchProgramId | null;
  generatingEventIds: EventId[];
  supportingClaimIds: ClaimId[];
  createdAt: string;
}

export interface ArtifactRecord {
  artifactId: ArtifactId;
  payload: ArtifactRecordPayload;
}

export interface ArtifactIndexRootPayload {
  schema: 'cosmo.artifact-index-root.v1';
  entries: Array<{
    artifactId: ArtifactId;
    artifactRecordRef: ObjectRef;
  }>;
  throughEventId: EventId;
}

export interface ResearchGenesisSeedQuestionInput {
  wording: string;
  semanticVariants: string[];
  whyItMatters: string;
  domains: string[];
  perspectiveIds: ObjectId[];
  surprise: number;
  uncertainty: number;
  humanInterest: string | null;
  initialStatus: 'new' | 'active' | 'incubating';
}

export interface ResearchGenesisBuildInput {
  schema: 'cosmo.research-genesis-build-input.v1';
  covenant: ResearchCovenantPayload;
  seedQuestions: ResearchGenesisSeedQuestionInput[];
  humanApproval: {
    principalId: Sha256;
    content: string;
  };
  genesisScope: Extract<CognitiveEventScope, { kind: 'genesis' }>;
  trust: TrustDescriptor;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  createdAt: string;
}

export interface ResearchGenesisRootsPayload {
  schema: 'cosmo.research-genesis-roots.v1';
  covenantPayloadRef: ObjectRef;
  relationshipEventRefs: ObjectRef[];
  relationshipStateRef: ObjectRef;
  questionRefs: ObjectRef[];
  seedQuestionIds: QuestionId[];
  relationshipRootRef: ObjectRef;
  questionRootRef: ObjectRef;
  programRootRef: ObjectRef;
  artifactIndexRootRef: ObjectRef;
  eventIds: EventId[];
  createdAt: string;
}

export interface ResearchGenesisRoots {
  rootsRef: ObjectRef;
  payload: ResearchGenesisRootsPayload;
  relationshipRoot: RelationshipRootPayload;
  questionRoot: QuestionRootPayload;
  programRoot: ProgramRootPayload;
  artifactIndexRoot: ArtifactIndexRootPayload;
  questions: Question[];
  relationshipEvents: RelationshipEvent[];
  cognitiveEvents: CognitiveEvent[];
}

export interface ProposeArtifactIndexUpdateInput {
  schema: 'cosmo.propose-artifact-index-update-input.v1';
  expectedBrainCommitId: BrainCommitId;
  expectedArtifactIndexRootRef: ObjectRef;
  artifact: ArtifactRecordPayload;
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  occurredAt: string;
}

export interface ArtifactIndexUpdateProposal {
  schema: 'cosmo.artifact-index-update-proposal.v1';
  expectedBrainCommitId: BrainCommitId;
  previousArtifactIndexRootRef: ObjectRef;
  nextArtifactIndexRoot: ArtifactIndexRootPayload;
  artifact: ArtifactRecord;
  mutationEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
}

export interface ProgramRunControlInput {
  schema: 'cosmo.program-run-control-input.v1';
  runIds: RunId[];
  reason: string;
  mutationAuthorization: MutationAuthorization;
  idempotencyKey: Sha256;
  occurredAt: string;
}

export interface ProgramRunControlPort {
  pauseRuns(
    input: ProgramRunControlInput
  ): Promise<RuntimeCheckpointRef[]>;
  cancelRuns(input: ProgramRunControlInput): Promise<RunId[]>;
  assertNoActiveRuns(runIds: RunId[]): Promise<void>;
}

export interface ExpeditionExecutionPort {
  execute(input: ExecuteExpeditionInput): Promise<ExpeditionExecutionHandle>;
}

export interface RuntimeReceiptRecording {
  schema: 'cosmo.runtime-receipt-recording.v1';
  receiptRef: ObjectRef;
  receipt: RuntimeReceipt;
}

export interface ExpeditionExecutionHandle {
  events: AsyncIterable<CognitiveEvent>;
  completion: Promise<RuntimeReceiptRecording>;
}

export interface LaneUseReceipt {
  schema: 'cosmo.lane-use-receipt.v1';
  laneUseReceiptId: ObjectId;
  expeditionId: ExpeditionId;
  lane: 'directed' | 'adjacent' | 'wildcard' | 'incubation';
  budgetUnit: ResearchCovenantPayload['autonomyPolicy']['rollingBudgetUnit'];
  amount: number;
  promptProvenance: PromptProvenance;
  occurredAt: string;
}

export interface DirectedOverride {
  schema: 'cosmo.directed-override.v1';
  missionHash: Sha256;
  authorizedByRelationshipEventId: RelationshipEventId;
  startsAt: string;
  expiresAt: string;
  maximumBudget: number;
}

export interface ContextUnit {
  unitId: ObjectId;
  kind:
    | 'brain_projection'
    | 'evidence'
    | 'question'
    | 'program'
    | 'relationship'
    | 'negative_knowledge'
    | 'perspective'
    | 'role_definition'
    | 'tool_contract';
  contentRef: ObjectRef;
  required: boolean;
  priority: number;
  inclusionReason: string;
  maximumTokens: number;
  trust: TrustDescriptor;
}

export interface RuntimeExecutionPlan {
  schema: 'cosmo.runtime-execution-plan.v1';
  roleId: ObjectId;
  roleName: string;
  instructionsRef: ObjectRef;
  perspectiveIds: ObjectId[];
  handoffPurpose: string | null;
  allowedToolNames: string[];
  outputSchemaName: string;
  outputSchemaRef: ObjectRef;
  outputTrust: TrustDescriptor;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface WorkerOutputBatch {
  schema: 'cosmo.worker-output-batch.v1';
  events: WorkerEvent[];
}

export interface StructuredRoleExecutionInput {
  schema: 'cosmo.structured-role-execution-input.v1';
  runId: RunId;
  expeditionRef: ObjectRef;
  expedition: ExpeditionContract;
  context: ContextBundle;
  authorization: RuntimeAuthorization;
  mutationAuthorization: MutationAuthorization;
  idempotencyKey: Sha256;
  startedAt: string;
}

export interface StructuredRoleExecutionResult {
  schema: 'cosmo.structured-role-execution-result.v1';
  runId: RunId;
  outputSchemaName: string;
  outputSchemaRef: ObjectRef;
  outputRef: ObjectRef;
  output: JsonValue;
  outputHash: Sha256;
  runtimeReceiptRecording: RuntimeReceiptRecording;
}

export interface StructuredRoleExecutionPort {
  execute(
    input: StructuredRoleExecutionInput
  ): Promise<StructuredRoleExecutionResult>;
}

export interface ResolvedStructuredOutputSchema {
  schemaName: string;
  schemaRef: ObjectRef;
  canonicalJsonSchema: JsonValue;
  providerOutputType: unknown;
  parse(value: JsonValue): JsonValue;
}

export type ResearchToolCapability =
  | 'source:discover'
  | 'source:acquire'
  | 'experiment:execute';

export interface ResearchToolDescriptor {
  schema: 'cosmo.research-tool-descriptor.v1';
  name: string;
  toolIdentity: Sha256;
  adapterKind:
    | 'openai_hosted_web_search'
    | 'restricted_https_acquisition'
    | 'sandboxed_experiment';
  capability: ResearchToolCapability;
  inputSchemaHash: Sha256;
  outputSchemaHash: Sha256;
  networkPolicyRef: ObjectRef | null;
  enabledProviderModels: string[];
}

export interface SourceDiscoveryProposal {
  schema: 'cosmo.source-discovery-proposal.v1';
  runId: RunId;
  expeditionId: ExpeditionId;
  query: string;
  uri: string;
  title: string | null;
  snippet: string | null;
  providerResultRef: ObjectRef;
  toolInvocationReceiptId: ObjectId;
  discoveredAt: string;
}

export interface ResearchToolInvocationInput {
  descriptor: ResearchToolDescriptor;
  runId: RunId;
  expeditionId: ExpeditionId;
  missionHash: Sha256;
  authorization: RuntimeAuthorization;
  canonicalInput: unknown;
}

export interface HostedResearchToolResult {
  invocation: ResearchToolInvocationInput;
  providerCallId: string;
  providerResult: unknown;
  startedAt: string;
  completedAt: string;
}

export interface BoundResearchToolSet {
  descriptors: ResearchToolDescriptor[];
  providerTools: unknown[];
  invokeLocal(input: ResearchToolInvocationInput): Promise<ResearchToolInvocationReceipt>;
  admitHostedResult(input: HostedResearchToolResult): Promise<ResearchToolInvocationReceipt>;
}

export interface ResearchToolInvocationReceiptPayload {
  schema: 'cosmo.research-tool-invocation-receipt.v1';
  runId: RunId;
  expeditionId: ExpeditionId;
  toolName: string;
  toolIdentity: Sha256;
  capabilityGrantId: ObjectId;
  missionHash: Sha256;
  branchEpoch: number;
  fencingToken: string;
  canonicalInputHash: Sha256;
  outputRef: ObjectRef | null;
  status: 'completed' | 'denied' | 'failed' | 'cancelled';
  reasonCodes: string[];
  startedAt: string;
  completedAt: string;
}

export interface ResearchToolInvocationReceipt {
  receiptId: ObjectId;
  payload: ResearchToolInvocationReceiptPayload;
}

export interface ResearchToolRegistry {
  resolveAuthorized(
    executionPlan: RuntimeExecutionPlan,
    authorization: RuntimeAuthorization
  ): Promise<ResearchToolDescriptor[]>;
  bindForProvider(
    executionPlan: RuntimeExecutionPlan,
    authorization: RuntimeAuthorization,
    provider: 'openai_responses' | 'deterministic'
  ): Promise<BoundResearchToolSet>;
  invokeLocal(
    input: ResearchToolInvocationInput
  ): Promise<ResearchToolInvocationReceipt>;
  admitHostedResult(
    input: HostedResearchToolResult
  ): Promise<ResearchToolInvocationReceipt>;
}

export interface ContextBundlePayload {
  schema: 'cosmo.context-bundle.v1';
  brainCommitId: BrainCommitId;
  corpusSnapshotIds: CorpusSnapshotId[];
  covenantCommitId: BrainCommitId;
  principalVersion: Sha256;
  questionIds: QuestionId[];
  units: ContextUnit[];
  executionPlan: RuntimeExecutionPlan;
  createdAt: string;
}

export interface ContextBundle {
  contextBundleId: ObjectId;
  payload: ContextBundlePayload;
}

export interface RenderedContextReceipt {
  schema: 'cosmo.rendered-context-receipt.v1';
  contextBundleId: ObjectId;
  renderedContextHash: Sha256;
  includedUnitIds: ObjectId[];
  omittedOptionalUnitIds: ObjectId[];
  requestedReplacementForRequiredUnitIds: ObjectId[];
  generatedSummaryUsed: false;
  tokenEstimate: number;
}

export interface PrincipalDecision {
  schema: 'cosmo.principal-decision.v1';
  decisionId: ObjectId;
  action:
    | 'propose_question_origin'
    | 'propose_expedition'
    | 'propose_cognitive_candidate'
    | 'propose_claim_transition'
    | 'contest_candidate'
    | 'incubate_candidate'
    | 'propose_question_transition'
    | 'propose_metabolism'
    | 'propose_program_settlement'
    | 'propose_program_stop'
    | 'propose_dormancy'
    | 'propose_revival'
    | 'defer_metabolism'
    | 'defer_research_direction';
  parentBrainCommitId: BrainCommitId;
  principalVersion: Sha256;
  subjectObjectIds: ObjectId[];
  evidencePolicyId: ObjectId;
  reviewFindingIds: ReviewFindingId[];
  principalResearchProposalAttemptRef: ObjectRef | null;
  surveyContextBundleId: ObjectId | null;
  rationale: string;
  proposedAt: string;
  reviewAt: string | null;
  expiresAt: string | null;
}

export interface PrincipalDecisionRecording {
  schema: 'cosmo.principal-decision-recording.v1';
  decisionRef: ObjectRef;
  decision: PrincipalDecision;
  eventRef: ObjectRef;
  event: CognitiveEvent;
  eventId: EventId;
}

export interface RegisterPrincipalPolicyInput {
  schema: 'cosmo.register-principal-policy-input.v1';
  roleDefinitionRef: ObjectRef;
  promptPolicyRef: ObjectRef;
  modelClass: string;
  decisionPolicyRef: ObjectRef;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  registeredAt: string;
}

export interface PrincipalProposalContext {
  parentBrainCommitId: BrainCommitId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  principalVersion: Sha256;
  evidencePolicyId: ObjectId;
  reviewFindingRecordings: ReviewFindingRecording[];
  requestedByEventId: EventId;
  rationale: string;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  proposedAt: string;
  reviewAt: string | null;
  expiresAt: string | null;
}

export interface ProposeExpeditionInput extends PrincipalProposalContext {
  schema: 'cosmo.propose-expedition-input.v1';
  expeditionRef: ObjectRef;
  expedition: ExpeditionContract;
}

export interface ProposeQuestionTransitionInput extends PrincipalProposalContext {
  schema: 'cosmo.propose-question-transition-input.v1';
  questionRef: ObjectRef;
  question: Question;
  desiredStatus: Question['status'];
}

export interface ProposeMetabolismDeferralInput extends PrincipalProposalContext {
  schema: 'cosmo.propose-metabolism-deferral-input.v1';
  triggerReasonCodes: string[];
}

export interface PrincipalResearchSurveyInput {
  schema: 'cosmo.principal-research-survey-input.v1';
  runId: RunId;
  programId: ResearchProgramId;
  programStateObjectId: ObjectId;
  brainCommitId: BrainCommitId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  expeditionRef: ObjectRef;
  expedition: ExpeditionContract;
  corpusSnapshotIds: CorpusSnapshotId[];
  contextBundle: ContextBundle;
  questionProjectionRef: ObjectRef;
  programProjectionRef: ObjectRef;
  relationshipProjectionRef: ObjectRef;
  cognitionProjectionRef: ObjectRef;
  negativeKnowledgeProjectionRef: ObjectRef;
  recentJournalRange: JournalRange;
  runtimeAuthorization: RuntimeAuthorization;
  idempotencyKey: Sha256;
  startedAt: string;
}

export type PrincipalResearchProposal =
  | {
      proposalType: 'originate_question';
      candidate: CandidateFinding & { candidateType: 'question' };
      noveltyBasis: BrainObjectAddress[];
      surpriseBasis: BrainObjectAddress[];
    }
  | {
      proposalType: 'launch_expedition';
      questionId: QuestionId;
      objective: string;
      specialistRoleObjectIds: ObjectId[];
      proposedAllocation: AutonomyAllocation;
    }
  | {
      proposalType: 'synthesize_across_program';
      candidate: CandidateFinding & {
        candidateType: 'connection' | 'hypothesis';
      };
      subjects: BrainObjectAddress[];
      whyNovel: string;
    }
  | {
      proposalType: 'request_metabolism';
      triggerReasonCodes: string[];
      meaningfulEventIds: EventId[];
    }
  | {
      proposalType: 'propose_settlement';
      satisfiedStoppingCriterionIndexes: number[];
      evidenceObjectIds: ObjectId[];
      unresolvedQuestionIds: QuestionId[];
    }
  | {
      proposalType: 'defer';
      reason: string;
      reviewAt: string | null;
      expiresAt: string | null;
    };

export interface PrincipalResearchAttemptReceipt {
  schema: 'cosmo.principal-research-attempt-receipt.v1';
  runId: RunId;
  roleDefinitionObjectId: ObjectId;
  expeditionRef: ObjectRef;
  runtimeReceiptRef: ObjectRef;
  outputSchemaRef: ObjectRef;
  outputRef: ObjectRef;
  executionClass: RuntimeReceipt['executionClass'];
  adapterId: Sha256;
  provider: string;
  model: string;
  contextBundleId: ObjectId;
  modelInputHash: Sha256;
  outputHash: Sha256;
  allowedToolNames: [];
  startedAt: string;
  completedAt: string;
}

export interface PrincipalResearchProposalAttempt {
  schema: 'cosmo.principal-research-proposal-attempt.v1';
  surveyBrainCommitId: BrainCommitId;
  proposal: PrincipalResearchProposal;
  receipt: PrincipalResearchAttemptReceipt;
}

export interface PrincipalResearchExecutionInput {
  schema: 'cosmo.principal-research-execution-input.v1';
  survey: PrincipalResearchSurveyInput;
  mutationAuthorization: MutationAuthorization;
}

export interface PrincipalResearchExecutionPort {
  propose(
    input: PrincipalResearchExecutionInput
  ): Promise<PrincipalResearchProposalAttempt>;
}

export interface PrincipalResearchCycleInput {
  schema: 'cosmo.principal-research-cycle-input.v1';
  survey: PrincipalResearchSurveyInput;
  requestedByEventId: EventId;
  principalVersion: Sha256;
  evidencePolicyId: ObjectId;
  requiredReviewFindingIds: ReviewFindingId[];
  mutationAuthorization: MutationAuthorization;
  reviewedAt: string;
}

export interface IndependentCandidateReviewExecutionInput {
  schema: 'cosmo.independent-candidate-review-execution-input.v1';
  subject: ReviewSubject;
  candidateBrainCommitId: BrainCommitId;
  candidateBranchRef: `refs/heads/candidates/${string}`;
  candidateEventId: EventId;
  expectedScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  reviewerIdentity: Sha256;
  reviewerRoleDefinitionRef: ObjectRef;
  evidencePolicyId: ObjectId;
  evidenceSpanIds: ObjectId[];
  execution: StructuredRoleExecutionInput;
}

export interface IndependentCandidateReviewProposal {
  schema: 'cosmo.independent-candidate-review-proposal.v1';
  finding: ReviewFinding['finding'];
  dimensions: ReviewFinding['dimensions'];
  evidenceSpanIds: ObjectId[];
  rationale: string;
}

export interface IndependentCandidateReviewAttemptReceipt {
  schema: 'cosmo.independent-candidate-review-attempt-receipt.v1';
  runId: RunId;
  reviewerIdentity: Sha256;
  reviewerRoleDefinitionRef: ObjectRef;
  expeditionRef: ObjectRef;
  contextBundleId: ObjectId;
  runtimeReceiptRef: ObjectRef;
  outputSchemaRef: ObjectRef;
  outputRef: ObjectRef;
  executionClass: RuntimeReceipt['executionClass'];
  provider: string;
  model: string;
  startedAt: string;
  completedAt: string;
}

export interface IndependentCandidateReviewAttempt {
  schema: 'cosmo.independent-candidate-review-attempt.v1';
  attemptRef: ObjectRef;
  inputRef: ObjectRef;
  proposal: IndependentCandidateReviewProposal;
  receipt: IndependentCandidateReviewAttemptReceipt;
}

export interface IndependentCandidateReviewExecutionPort {
  review(
    input: IndependentCandidateReviewExecutionInput
  ): Promise<IndependentCandidateReviewAttempt>;
}

export interface CandidateReviewCompletionPayload {
  schema: 'cosmo.candidate-review-completion.v1';
  candidateBrainCommitId: BrainCommitId;
  candidateBranchReceiptRef: ObjectRef;
  candidateRef: ObjectRef;
  candidateEventId: EventId;
  independentReviewAttemptRefs: ObjectRef[];
  reviewFindingRecordingRefs: ObjectRef[];
  claimTransitionDecisionRecordRef: ObjectRef | null;
  scope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  completedAt: string;
}

export interface CandidateReviewCompletionRecording {
  schema: 'cosmo.candidate-review-completion-recording.v1';
  completionRef: ObjectRef;
  completion: CandidateReviewCompletionPayload;
  eventRef: ObjectRef;
  event: CognitiveEvent & { eventType: 'candidate_review_completed' };
  eventId: EventId;
}

export interface ReviewPrincipalResearchProposalInput {
  schema: 'cosmo.review-principal-research-proposal-input.v1';
  survey: PrincipalResearchSurveyInput;
  attempt: PrincipalResearchProposalAttempt;
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  principalVersion: Sha256;
  evidencePolicyId: ObjectId;
  requiredReviewFindingIds: ReviewFindingId[];
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  reviewedAt: string;
}

export interface WorkerEventEnvelope {
  schema: 'cosmo.worker-event-envelope.v1';
  envelopeId: string;
  adapterId: Sha256;
  runId: RunId;
  expeditionId: ExpeditionId;
  attempt: number;
  sequence: number;
  branchEpoch: number;
  fencingToken: string;
  missionHash: Sha256;
  authorizationHash: Sha256;
  emittedAt: string;
  event: WorkerEvent;
}

export interface EvidenceSpanExtractionProposal {
  schema: 'cosmo.evidence-span-extraction-proposal.v1';
  extractionObjectId: ObjectId;
  corpusSnapshotId: CorpusSnapshotId;
  sourceObjectId: ObjectId;
  locator: EvidenceSpan['locator'];
  expectedTextSha256: Sha256;
  purpose: string;
}

export interface NegativeResultProposal {
  schema: 'cosmo.negative-result-proposal.v1';
  kind: NegativeKnowledge['kind'];
  statement: string;
  corpusSnapshotIds: CorpusSnapshotId[];
  strategy: string;
  scope: string;
  limits: string[];
  evidenceSpanIds: ObjectId[];
  occurredAt: string;
  retryWhen: string[];
}

export interface ExperimentProtocolProposal {
  schema: 'cosmo.experiment-protocol-proposal.v1';
  hypothesisObjectId: ObjectId;
  method: string;
  environment: ObjectRef;
  inputs: ObjectRef[];
  plannedObservations: string[];
  falsificationCriteria: string[];
}

export interface ExperimentObservationProposal {
  schema: 'cosmo.experiment-observation-proposal.v1';
  protocolId: ObjectId;
  outputs: ObjectRef[];
  observed: string;
  occurredAt: string;
  executionReceipt: ObjectRef;
}

export type WorkerEvent =
  | { type: 'source_discovered'; proposal: SourceDiscoveryProposal }
  | { type: 'source_retrieved'; proposal: CorpusAcquisitionOutcome }
  | { type: 'evidence_span_extracted'; proposal: EvidenceSpanExtractionProposal }
  | { type: 'candidate_finding'; finding: CandidateFinding }
  | { type: 'negative_result'; proposal: NegativeResultProposal }
  | { type: 'experiment_protocol'; proposal: ExperimentProtocolProposal }
  | { type: 'experiment_observation'; proposal: ExperimentObservationProposal }
  | { type: 'artifact_candidate'; artifactRef: ObjectRef }
  | { type: 'tool_receipt'; receiptRef: ObjectRef }
  | { type: 'model_receipt'; receiptRef: ObjectRef }
  | { type: 'progress_checkpoint'; message: string }
  | { type: 'handoff'; purpose: string; recipientRoleId: ObjectId }
  | { type: 'failure'; code: string; message: string; retryable: boolean }
  | { type: 'pause'; checkpointReason: string }
  | { type: 'completion_proposal'; criteria: Array<{ criterion: string; satisfied: boolean; evidenceObjectIds: ObjectId[] }> };

export type CognitiveEventSource =
  | {
      kind: 'worker_envelope';
      envelopeId: string;
      expeditionId: ExpeditionId;
      runId: RunId;
    }
  | {
      kind: 'human_operation';
      operationId: string;
      principalId: Sha256;
      previewId: ObjectId | null;
    }
  | {
      kind: 'semantic_role_attempt';
      role:
        | 'principal_researcher'
        | 'default_mode_generator'
        | 'consolidation_dream_generator'
        | 'independent_challenger';
      attemptReceiptRef: ObjectRef;
      contextBundleId: ObjectId;
    }
  | {
      kind: 'kernel_lifecycle';
      programId: ResearchProgramId | null;
      decisionObjectId: ObjectId;
      stage:
        | 'genesis'
        | 'program_control'
        | 'candidate_promotion'
        | 'metabolism'
        | 'wake'
        | 'settlement';
    };

export type CognitiveEventScope = BrainEventScope;
export const CognitiveEventScopeSchema = BrainEventScopeSchema;
export type CognitiveLineageEventScope = BrainLineageEventScope;
export const CognitiveLineageEventScopeSchema =
  BrainLineageEventScopeSchema;
export type CognitiveGenesisEventScope = GenesisBrainEventScope;
export const CognitiveGenesisEventScopeSchema =
  GenesisBrainEventScopeSchema;

export interface CognitiveEvent {
  schema: 'cosmo.cognitive-event.v1';
  eventId: EventId;
  source: CognitiveEventSource;
  scope: CognitiveEventScope;
  origin: CandidateOrigin | 'kernel' | 'migration';
  eventType:
    | 'genesis_research_roots_built'
    | 'candidate_finding'
    | 'source_canonicalized'
    | 'evidence_canonicalized'
    | 'negative_knowledge_candidate'
    | 'experiment_candidate'
    | 'completion_proposal'
    | 'review_recorded'
    | 'candidate_review_completed'
    | 'question_originated'
    | 'relationship_event_recorded'
    | 'program_direction_proposed'
    | 'program_control_requested'
    | 'principal_decision_recorded'
    | 'lifecycle_decision_recorded'
    | 'metabolism_stage_completed'
    | 'artifact_index_proposed';
  payloadRef: ObjectRef;
  causalParentEventIds: EventId[];
  occurredAt: string;
}

export interface AdmissionDecision {
  status: 'admitted' | 'rejected' | 'operational_only' | 'duplicate';
  eventId: EventId | null;
  cognitiveEvent: CognitiveEvent | null;
  reasonCodes: string[];
}

export interface QuarantineRecord {
  schema: 'cosmo.quarantine-record.v1';
  envelope: WorkerEventEnvelope;
  envelopeHash: Sha256;
  appendedAt: string;
  decision: AdmissionDecision | null;
  decidedAt: string | null;
}

export interface AdmitWorkerEventInput {
  schema: 'cosmo.admit-worker-event-input.v1';
  envelope: WorkerEventEnvelope;
  currentAuthorization: RuntimeAuthorization;
  remainingBudget: {
    tokens: number;
    toolCalls: number;
    runtimeMs: number;
    costUsd: number;
  };
  cancelled: boolean;
  expectedScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  mutationAuthorization: MutationAuthorization;
  admittedAt: string;
}

export interface AdmitHumanOperationEventInput {
  schema: 'cosmo.admit-human-operation-event-input.v1';
  source: Extract<CognitiveEventSource, { kind: 'human_operation' }>;
  scope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  eventType:
    | 'candidate_finding'
    | 'question_originated'
    | 'relationship_event_recorded'
    | 'program_direction_proposed'
    | 'program_control_requested'
    | 'artifact_index_proposed';
  payloadRef: ObjectRef;
  causalParentEventIds: EventId[];
  mutationAuthorization: MutationAuthorization;
  admittedAt: string;
}

export interface AdmitSemanticRoleEventInput {
  schema: 'cosmo.admit-semantic-role-event-input.v1';
  source: Extract<CognitiveEventSource, { kind: 'semantic_role_attempt' }>;
  scope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  eventType:
    | 'candidate_finding'
    | 'review_recorded'
    | 'question_originated'
    | 'principal_decision_recorded'
    | 'completion_proposal';
  payloadRef: ObjectRef;
  causalParentEventIds: EventId[];
  runtimeAuthorization: RuntimeAuthorization;
  mutationAuthorization: MutationAuthorization;
  admittedAt: string;
}

export interface AdmitKernelLifecycleEventInput {
  schema: 'cosmo.admit-kernel-lifecycle-event-input.v1';
  source: Extract<CognitiveEventSource, { kind: 'kernel_lifecycle' }>;
  scope: CognitiveEventScope;
  eventType:
    | 'genesis_research_roots_built'
    | 'lifecycle_decision_recorded'
    | 'metabolism_stage_completed'
    | 'review_recorded'
    | 'candidate_review_completed';
  payloadRef: ObjectRef;
  causalParentEventIds: EventId[];
  mutationAuthorization: MutationAuthorization;
  admittedAt: string;
}

export type AdmitCognitiveEventInput =
  | AdmitWorkerEventInput
  | AdmitHumanOperationEventInput
  | AdmitSemanticRoleEventInput
  | AdmitKernelLifecycleEventInput;

export interface RuntimeCheckpointRef {
  schema: 'cosmo.runtime-checkpoint-ref.v1';
  checkpointObjectId: ObjectId;
  runId: RunId;
  adapterId: Sha256;
  missionHash: Sha256;
  contextBundleId: ObjectId;
  branchEpoch: number;
  lastSequence: number;
  runtimeStateRef: ObjectRef;
  createdAt: string;
}

export interface RuntimeRunState {
  schema: 'cosmo.runtime-run-state.v1';
  runId: RunId;
  expeditionId: ExpeditionId;
  status:
    | 'authorized'
    | 'running'
    | 'pausing'
    | 'paused'
    | 'resuming'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'lost';
  missionHash: Sha256;
  contextBundleId: ObjectId;
  branchEpoch: number;
  fencingToken: string;
  lastEnvelopeSequence: number;
  admittedEventIds: EventId[];
  terminalRuntimeReceiptRef: ObjectRef | null;
  completionDelivered: boolean;
  updatedAt: string;
}

export interface StartRuntimeInput {
  schema: 'cosmo.start-runtime-input.v1';
  runId: RunId;
  expeditionRef: ObjectRef;
  expedition: ExpeditionContract;
  context: ContextBundle;
  authorization: RuntimeAuthorization;
  mutationAuthorization: MutationAuthorization;
  idempotencyKey: Sha256;
  startedAt: string;
}

export interface PauseRuntimeInput {
  schema: 'cosmo.pause-runtime-input.v1';
  runId: RunId;
  reason: string;
  mutationAuthorization: MutationAuthorization;
  idempotencyKey: Sha256;
  pausedAt: string;
}

export interface ResumeRuntimeInput {
  schema: 'cosmo.resume-runtime-input.v1';
  checkpoint: RuntimeCheckpointRef;
  freshAuthorization: RuntimeAuthorization;
  expectedMissionHash: Sha256;
  mutationAuthorization: MutationAuthorization;
  idempotencyKey: Sha256;
  resumedAt: string;
}

export interface CancelRuntimeInput {
  schema: 'cosmo.cancel-runtime-input.v1';
  runId: RunId;
  reason: string;
  mutationAuthorization: MutationAuthorization;
  idempotencyKey: Sha256;
  cancelledAt: string;
}

export interface ReconcileRuntimeInput {
  schema: 'cosmo.reconcile-runtime-input.v1';
  runId: RunId;
  mutationAuthorization: MutationAuthorization;
  idempotencyKey: Sha256;
  reconciledAt: string;
}

export interface ReconciliationReceipt {
  reconciliationReceiptId: ObjectId;
  schema: 'cosmo.runtime-reconciliation-receipt.v1';
  runId: RunId;
  priorStateHash: Sha256;
  observedAdapterStateRef: ObjectRef;
  action:
    | 'no_action'
    | 'cancel_and_fence'
    | 'mark_lost_and_preserve_question'
    | 'deliver_completed_result'
    | 'deduplicate'
    | 'remain_paused_require_fresh_authorization'
    | 'already_reconciled';
  resultingStateHash: Sha256;
  admittedJournalRange: JournalRange | null;
  completionDeliveryEventId: EventId | null;
  duplicateOfReceiptId: ObjectId | null;
  reasonCodes: string[];
  reconciledAt: string;
}

export interface RuntimeReceipt {
  schema: 'cosmo.runtime-receipt.v1';
  runId: RunId;
  expeditionId: ExpeditionId;
  expeditionRef: ObjectRef;
  missionHash: Sha256;
  authorizationHash: Sha256;
  branchEpoch: number;
  fencingTokenHash: Sha256;
  adapterId: Sha256;
  executionClass:
    | 'live_provider'
    | 'deterministic_conformance'
    | 'recorded_conformance'
    | 'replay'
    | 'mock';
  provider: string;
  model: string;
  transport: string;
  contextBundleId: ObjectId;
  contextBundleRef: ObjectRef;
  outputSchemaName: string;
  outputSchemaRef: ObjectRef;
  outputTrust: TrustDescriptor;
  outputObjectRef: ObjectRef;
  outputHash: Sha256;
  renderedContextHash: Sha256;
  modelInputHash: Sha256;
  omittedOptionalUnitIds: ObjectId[];
  toolCallCount: number;
  tokenUsage: { input: number; output: number; total: number };
  costUsd: number | null;
  traceId: string | null;
  providerFallback: { from: string; to: string; reason: string } | null;
  startedAt: string;
  completedAt: string;
}

export interface RuntimeAdapterCompletion {
  schema: 'cosmo.runtime-adapter-completion.v1';
  runId: RunId;
  adapterId: Sha256;
  executionClass: RuntimeReceipt['executionClass'];
  provider: string;
  model: string;
  transport: string;
  contextBundleId: ObjectId;
  renderedContextHash: Sha256;
  modelInputHash: Sha256;
  outputSchemaName: string;
  output: JsonValue;
  omittedOptionalUnitIds: ObjectId[];
  toolCallCount: number;
  tokenUsage: { input: number; output: number; total: number };
  costUsd: number | null;
  traceId: string | null;
  providerFallback: RuntimeReceipt['providerFallback'];
  startedAt: string;
  completedAt: string;
}

export interface WorkerRuntimeExecutionHandle {
  envelopes: AsyncIterable<WorkerEventEnvelope>;
  completion: Promise<RuntimeAdapterCompletion>;
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

## Program E Integration Surface

Program D must export these exact interfaces from `packages/research/src/d-e-vertical-gate.ts`:

```ts
export interface OriginateQuestionInput {
  schema: 'cosmo.originate-question-input.v1';
  expectedBrainCommitId: BrainCommitId;
  expectedQuestionRootRef: ObjectRef;
  wording: string;
  semanticVariants: string[];
  parentQuestionIds: QuestionId[];
  origin: QuestionOrigin;
  sourceEventIds: EventId[];
  promptObjectId: ObjectId;
  humanPrincipalTaskGraphRef: ObjectRef;
  whyItMatters: string;
  domains: string[];
  perspectiveIds: ObjectId[];
  surprise: number;
  uncertainty: number;
  evidenceConsidered: ObjectId[];
  humanInterest: string | null;
  initialStatus: 'new' | 'active' | 'incubating';
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  reviewAt: string | null;
  expiresAt: string | null;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  occurredAt: string;
}

export interface TransitionQuestionInput {
  schema: 'cosmo.transition-question-input.v1';
  expectedBrainCommitId: BrainCommitId;
  expectedQuestionRootRef: ObjectRef;
  expectedQuestionObjectId: ObjectId;
  questionId: QuestionId;
  expectedStatus: Question['status'];
  nextStatus: Question['status'];
  partialAnswerClaimIds: ClaimId[];
  failedApproachIds: ObjectId[];
  rationale: string;
  requestedByEventId: EventId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  reviewAt: string | null;
  expiresAt: string | null;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  occurredAt: string;
}

export interface BuildExpeditionInput {
  schema: 'cosmo.build-expedition-input.v1';
  parentQuestionIds: QuestionId[];
  mission: string;
  brainCommitId: BrainCommitId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  corpusSnapshotIds: CorpusSnapshotId[];
  covenantCommitId: BrainCommitId;
  principalVersion: Sha256;
  evidencePolicyId: ObjectId;
  allocation: AutonomyAllocation;
  capabilityGrantId: ObjectId;
  budget: ExpeditionContract['budget'];
  stoppingCriteria: string[];
  honestBlockConditions: string[];
  proposedByEventId: EventId;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  proposedAt: string;
}

export interface ExecuteExpeditionInput {
  schema: 'cosmo.execute-expedition-input.v1';
  runId: RunId;
  expeditionRef: ObjectRef;
  expedition: ExpeditionContract;
  context: ContextBundle;
  authorization: RuntimeAuthorization;
  mutationAuthorization: MutationAuthorization;
  idempotencyKey: Sha256;
  startedAt: string;
}

export interface CandidateDispositionInputBase {
  schema: 'cosmo.propose-candidate-disposition-input.v1';
  parentBrainCommitId: BrainCommitId;
  eventScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  principalVersion: Sha256;
  candidateRef: ObjectRef;
  candidate: CandidateFinding;
  candidateEventId: EventId;
  evidencePolicyId: ObjectId;
  rationale: string;
  requestedByEventId: EventId;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  proposedAt: string;
  reviewAt: string | null;
  expiresAt: string | null;
}

export type ProposeCandidateDispositionInput =
  | (CandidateDispositionInputBase & {
      dispositionKind: 'claim_status';
      candidate: CandidateFinding & { candidateType: 'claim' };
      transitionDecisionRecording: ClaimTransitionDecisionRecording;
      desiredDisposition: 'supported' | 'contested' | 'disconfirmed';
    })
  | (CandidateDispositionInputBase & {
      dispositionKind: 'cognitive_status';
      candidate: CandidateFinding & {
        candidateType:
          | 'hypothesis'
          | 'question'
          | 'connection'
          | 'contradiction_proposal'
          | 'activation_proposal'
          | 'negative_knowledge';
      };
      reviewFindingRecordings: ReviewFindingRecording[];
      desiredDisposition:
        | 'candidate'
        | 'contested'
        | 'incubating'
        | 'dormant'
        | 'revived';
    });

export interface DEVerticalGateResearchPort {
  originateQuestion(input: OriginateQuestionInput): Promise<QuestionMutationProposal>;
  buildExpedition(input: BuildExpeditionInput): Promise<ExpeditionContract>;
  executeExpedition(
    input: ExecuteExpeditionInput
  ): Promise<ExpeditionExecutionHandle>;
  proposeCandidateDisposition(
    input: ProposeCandidateDispositionInput
  ): Promise<PrincipalDecisionRecording>;
  runCandidateResearchPhase(
    input: DEVerticalGateInput
  ): Promise<DEVerticalGateResearchReceipt>;
  reviewCommittedCandidate(
    input: DECommittedCandidateReviewInput
  ): Promise<DECommittedCandidateReviewReceipt>;
}

// `DESeedQuestionDraftSchema` (the Zod object for this interface) is exported
// from `@cosmo/contracts` with the same identity.
export interface DESeedQuestionDraft {
  schema: 'cosmo.de-seed-question-draft.v1';
  wording: string;
  semanticVariants: string[];
  origin: QuestionOrigin;
  sourceEventIds: EventId[];
  promptObjectId: ObjectId;
  humanPrincipalTaskGraphRef: ObjectRef;
  whyItMatters: string;
  domains: string[];
  perspectiveIds: ObjectId[];
  surprise: number;
  uncertainty: number;
  evidenceConsidered: ObjectId[];
  humanInterest: string | null;
  initialStatus: 'new' | 'active' | 'incubating';
  requestedByEventId: EventId;
  reviewAt: string | null;
  expiresAt: string | null;
  occurredAt: string;
}

export interface DEVerticalGateInput {
  startingBrainCommitId: BrainCommitId;
  candidateBranchRef: `refs/heads/candidates/${string}`;
  lineageId: Sha256;
  trustDomain: string | null;
  corpusSnapshotIds: CorpusSnapshotId[];
  covenantCommitId: BrainCommitId;
  evidencePolicyId: ObjectId;
  principalVersion: Sha256;
  seedQuestionDraft: DESeedQuestionDraft;
  autonomyAllocation: AutonomyAllocation;
  capabilityGrantId: ObjectId;
  runtimeAdapter: 'deterministic' | 'openai_agents';
  mutationAuthorization: MutationAuthorization;
  idempotencyKey: Sha256;
  forceRestartAfterEnvelopeSequence: number;
  forceContextTurnover: boolean;
  injectLateFencedEvent: boolean;
}

export interface DEVerticalGateResearchReceipt {
  schema: 'cosmo.de-vertical-gate-research-receipt.v1';
  startingBrainCommitId: BrainCommitId;
  candidateBranchRef: `refs/heads/candidates/${string}`;
  questionId: QuestionId;
  promptProvenance: PromptProvenance;
  questionMutationProposalRef: ObjectRef;
  questionMutationProposal: QuestionMutationProposal;
  expeditionId: ExpeditionId;
  endingCorpusSnapshotId: CorpusSnapshotId;
  admittedEventIds: EventId[];
  runtimeReceiptRefs: ObjectRef[];
  researchToolReceiptIds: ObjectId[];
  acquiredSourceObjectIds: ObjectId[];
  evidenceSpanIds: ObjectId[];
  admittedCandidates: Array<{
    candidateRef: ObjectRef;
    candidate: CandidateFinding;
    event: CognitiveEvent;
  }>;
  corpusRootMutationBatchRecording: CorpusRootMutationBatchRecording;
  discoveryProposalCreditedAsEvidence: false;
  toolReceiptCreditedAsEvidence: false;
  forcedRestartObserved: boolean;
  contextTurnoverObserved: boolean;
  lateFencedEventRejected: boolean;
  cosmoAccepted: false;
  blockedOn: 'program-e-living-brain-metabolism';
}

interface DECommittedCandidateReviewInputBase {
  schema: 'cosmo.de-committed-candidate-review-input.v1';
  candidateBrainCommitId: BrainCommitId;
  candidateBranchRef: `refs/heads/candidates/${string}`;
  canonicalTargetRef: `refs/heads/${string}`;
  candidateBranchReceiptRef: ObjectRef;
  candidateRef: ObjectRef;
  candidateEventId: EventId;
  independentReviewInputs: IndependentCandidateReviewExecutionInput[];
  evidencePolicyId: ObjectId;
  principalVersion: Sha256;
  authorization: MutationAuthorization;
  idempotencyKey: Sha256;
  reviewedAt: string;
}

export type DECommittedCandidateReviewInput =
  | (DECommittedCandidateReviewInputBase & {
      originKind: 'autonomous_research';
      researchReceiptRef: ObjectRef;
      researchReceipt: DEVerticalGateResearchReceipt;
    })
  | (DECommittedCandidateReviewInputBase & {
      originKind: 'human_invent';
      admittedHumanOperationEventId: EventId;
      inventDraftRef: ObjectRef;
      inventPreviewRef: ObjectRef;
    })
  | (DECommittedCandidateReviewInputBase & {
      originKind: 'semantic_role';
      semanticRole:
        | 'default_mode_generator'
        | 'consolidation_dream_generator';
      attemptReceiptRef: ObjectRef;
      contextBundleId: ObjectId;
      outputSchemaRef: ObjectRef;
      outputRef: ObjectRef;
    });

interface DECommittedCandidateReviewReceiptBase {
  schema: 'cosmo.de-committed-candidate-review-receipt.v1';
  candidateBrainCommitId: BrainCommitId;
  candidateBranchReceiptRef: ObjectRef;
  candidateRef: ObjectRef;
  candidateEventId: EventId;
  independentReviewAttempts: IndependentCandidateReviewAttempt[];
  independentReviewAttemptRefs: ObjectRef[];
  reviewFindingRecordings: ReviewFindingRecording[];
  reviewFindingRecordingRefs: ObjectRef[];
  claimTransitionDecisionRecording: ClaimTransitionDecisionRecording | null;
  principalDecisionRecording: PrincipalDecisionRecording;
  disposition: ProposeCandidateDispositionInput['desiredDisposition'];
  reviewScope: Extract<CognitiveEventScope, { kind: 'brain_lineage' }>;
  reviewCompletionRecording: CandidateReviewCompletionRecording;
  cosmoAccepted: false;
  blockedOn: 'program-e-living-brain-metabolism';
}

export type DECommittedCandidateReviewReceipt =
  | (DECommittedCandidateReviewReceiptBase & {
      originKind: 'autonomous_research';
      researchReceiptRef: ObjectRef;
    })
  | (DECommittedCandidateReviewReceiptBase & {
      originKind: 'human_invent';
      admittedHumanOperationEventId: EventId;
      inventDraftRef: ObjectRef;
      inventPreviewRef: ObjectRef;
    })
  | (DECommittedCandidateReviewReceiptBase & {
      originKind: 'semantic_role';
      semanticRole:
        | 'default_mode_generator'
        | 'consolidation_dream_generator';
      attemptReceiptRef: ObjectRef;
      contextBundleId: ObjectId;
      outputSchemaRef: ObjectRef;
      outputRef: ObjectRef;
    });
```

Program E supplies the cognition side and orchestrates the immutable boundary:
D candidate research receipt → E candidate-branch commit → D committed-candidate
review receipt → E qualified Claim or reviewed cognitive acceptance → metabolism
→ wake BrainCommit → pinned formation trace. D never reviews or asks the
Principal to disposition a candidate before E returns the exact candidate Brain
commit and receipt ref. Program D alone always returns `cosmoAccepted:false`.

### Task 1: Freeze Research and Runtime Contracts

**Files:**
- Create: `packages/contracts/src/research.ts`
- Create: `packages/contracts/src/runtime.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/contracts/test/research-runtime-contracts.test.ts`
- Create: `packages/research/package.json`
- Create: `packages/research/tsconfig.json`
- Create: `packages/research/src/index.ts`
- Create: `packages/research/test/support.ts`
- Create: `packages/runtime/package.json`
- Create: `packages/runtime/tsconfig.json`
- Create: `packages/runtime/src/index.ts`
- Create: `packages/runtime/test/support.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Program-map IDs, `ObjectRef`, `TrustDescriptor`, Program B's sole
  `BrainEventScope`/`BrainEventScopeSchema` union and exact identity-derived
  `BrainLineageEventScope`/`BrainLineageEventScopeSchema` and
  `GenesisBrainEventScope`/`GenesisBrainEventScopeSchema` narrowings, Program C
  `EvidenceMinimum`, `ReviewFinding`, `ReviewQualification`, exact
  `ReviewFindingRecording`,
  `CorpusRootMutationBatchRecording`, and exact
  `ClaimTransitionDecisionRecording`, plus the master-map `CandidateFinding`
  shape. `CognitiveEventScope`/`CognitiveEventScopeSchema` and
  `CognitiveLineageEventScope`/`CognitiveLineageEventScopeSchema`, and
  `CognitiveGenesisEventScope`/`CognitiveGenesisEventScopeSchema` are exact
  type/object-identity aliases of those Program B exports, never second
  declarations. Every normal D input/proposal schema uses the lineage object;
  dedicated genesis contracts use the genesis object; `CognitiveEvent` alone
  uses the full union.
- Produces: every frozen Program D interface and strict Zod schema above,
  including `ResearchProgramIdSchema`, `ResearchProgramModeSchema`, the
  Research Program direction/state/create/control/settlement/finalization/
  receipt/result/notice/list/page schemas, the exact initial/revision Covenant
  input and revision-proposal schemas, the D genesis seed/input/root-bundle
  schemas, the Principal policy/proposal-context/expedition/question/deferral
  inputs, Principal decision stored-payload/decoded-wrapper/
  `PrincipalDecisionRecording` schemas, the Principal survey/proposal/attempt/
  review schemas and execution port, the Question/Program/Relationship root
  and root-update schemas, `ArtifactRecordPayloadSchema`/decoded wrapper/
  Artifact-index root/update schemas (the root payload schemas are exported
  verbatim as `QuestionRootPayloadSchema`, `ProgramRootPayloadSchema`,
  `RelationshipRootPayloadSchema`, and `ArtifactIndexRootPayloadSchema`),
  `OriginateQuestionInputSchema`,
  `TransitionQuestionInputSchema`, `RecordRelationshipEventInputSchema`,
  `BuildExpeditionInputSchema`, `ExecuteExpeditionInputSchema`,
  `ProgramRunControlInputSchema`, `RuntimeReceiptRecordingSchema`, the
  `WorkerOutputBatchSchema`, `RuntimeAdapterCompletionSchema`,
  `WorkerRuntimeExecutionHandle`, `StructuredRoleExecutionInputSchema`,
  `StructuredRoleExecutionResultSchema`, and `StructuredRoleExecutionPort`,
  the independent-candidate-review input/proposal/attempt/receipt schemas and
  execution port, the candidate-review completion payload/recording schemas,
  the discriminated `ProposeCandidateDispositionInputSchema`, the two D→E
  candidate-phase input/receipt schemas with all three
  `autonomous_research`/`human_invent`/`semantic_role` provenance variants,
  `EvidenceSpanExtractionProposalSchema`,
  `NegativeResultProposalSchema`, `ExperimentProtocolProposalSchema`,
  `ExperimentObservationProposalSchema`, the source-discriminated
  `CognitiveEvent` and all four `AdmitCognitiveEventInput` schemas,
  `QuarantineRecordSchema`, `StartRuntimeInputSchema`,
  `PauseRuntimeInputSchema`, `ResumeRuntimeInputSchema`,
  `CancelRuntimeInputSchema`, `ReconcileRuntimeInputSchema`, and the
  stored-payload/public-wrapper
  `ReconciliationReceipt` schemas. Program D Task 1 is the sole schema owner
  for `CandidateFindingSchema`; Program C does not export it, and Programs E–H
  import it from `@cosmo/contracts`.
- Consumes the final Program B authority-bearing repository signatures exactly:

```ts
export interface MutationAuthorization {
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
}

export interface ObjectStore {
  put(
    input: PutObjectInput,
    authorization: MutationAuthorization
  ): Promise<ObjectRef>;
  get(
    ref: ObjectRef,
    authorization?: MutationAuthorization
  ): Promise<StoredObject>;
  has(objectId: ObjectId): Promise<boolean>;
  verify(ref: ObjectRef): Promise<ObjectVerification>;
}
```

The unauthenticated `ObjectStore.get(ref)` form is valid only for public objects. Private or restricted payload reads pass an authorized `object:read` grant. `has` and `verify` expose integrity metadata only. Program D imports Program B's complete canonical `CommitStore` type for authority-boundary tests but does not narrow, redeclare, or call it; only Program E receives a least-authority promotion port that may create/advance a Brain commit.

Both `@cosmo/research` and `@cosmo/runtime` are private ESM workspaces with `build: "tsc -p tsconfig.json"` and `test: "node ../../scripts/run-tests.mjs test"`. They export `./src/index.ts` for source development and declare all lower COSMO workspaces with `"*"`. Only `@cosmo/runtime` may depend on the Agents SDK; `@cosmo/research` remains provider-agnostic.

- [ ] **Step 1: Register and commit both source-development workspaces**

Create both package manifests, TypeScript configs, empty public indexes, and test-support modules first. Then run:

```bash
npm install
npm query .workspace | jq -r '.[].name' | sort
```

Expected: npm links `@cosmo/research` and `@cosmo/runtime`, records both workspace manifests in the root lockfile, and performs no provider call. A missing lockfile workspace entry is a stop condition.

Commit this independently testable dependency boundary before any later task imports either workspace:

```bash
git add packages/research/package.json packages/research/tsconfig.json packages/research/src/index.ts packages/research/test/support.ts packages/runtime/package.json packages/runtime/tsconfig.json packages/runtime/src/index.ts packages/runtime/test/support.ts package-lock.json
git commit -m "build(research): register research runtime workspaces"
```

- [ ] **Step 2: Write the failing frozen-contract tests**

```ts
test('ExpeditionContract retains every program-map field and allocation totals 100', () => {
  const contract = ExpeditionContractSchema.parse(expeditionFixture());
  assert.equal(contract.schema, 'cosmo.expedition.v1');
  assert.deepEqual(
    contract.eventScope,
    expeditionFixture().eventScope,
  );
  assert.equal(contract.eventScope.kind, 'brain_lineage');
  assert.equal(contract.eventScope.basedOnBrainCommitId, contract.brainCommitId);
  assert.equal(contract.allocation.directed + contract.allocation.adjacent
    + contract.allocation.wildcard + contract.allocation.incubation, 100);
  assert.equal(contract.honestBlockConditions.length, 1);
});

test('RuntimeAuthorization and WorkerEventEnvelope reject fence mismatch shapes', () => {
  const authorization = RuntimeAuthorizationSchema.parse(runtimeAuthorizationFixture());
  assert.equal(authorization.branchEpoch, 4);
  assert.throws(() => WorkerEventEnvelopeSchema.parse({
    ...workerEnvelopeFixture(),
    sequence: -1,
  }));
  assert.throws(() => WorkerEventEnvelopeSchema.parse({
    ...workerEnvelopeFixture(),
    event: { type: 'hidden_reasoning', content: 'private chain' },
  }));
});

test('runtime completion recording binds its exact stored receipt', () => {
  const receipt = runtimeReceiptFixture();
  const recording = RuntimeReceiptRecordingSchema.parse({
    schema: 'cosmo.runtime-receipt-recording.v1',
    receiptRef: objectRefFor(receipt),
    receipt,
  });
  assert.equal(recording.receipt.expeditionId, 'exp_fixture');
  assert.deepEqual(
    recording.receipt.contextBundleRef,
    objectRefFor(contextBundleFixture()),
  );
  assert.throws(() => RuntimeReceiptRecordingSchema.parse({
    ...recording,
    receiptRef: objectRef('different-runtime-receipt'),
  }));
});

test('worker and structured-role outputs share one pinned receipted schema seam', () => {
  const workerPlan = RuntimeExecutionPlanSchema.parse(
    runtimeExecutionPlanFixture({
      outputSchemaName: 'cosmo.worker-output-batch.v1',
      outputSchemaRef: objectRef('worker-output-json-schema'),
    }),
  );
  assert.equal(workerPlan.outputSchemaName, 'cosmo.worker-output-batch.v1');
  assert.equal(WorkerOutputBatchSchema.safeParse({
    schema: 'cosmo.worker-output-batch.v1',
    events: [workerEventFixture()],
  }).success, true);

  const structured = StructuredRoleExecutionInputSchema.parse(
    structuredRoleExecutionInputFixture({
      outputSchemaName: 'cosmo.principal-research-proposal.v1',
    }),
  );
  assert.deepEqual(
    structured.expeditionRef,
    objectRefFor(structured.expedition),
  );
  assert.equal(
    structured.context.payload.executionPlan.outputSchemaName,
    'cosmo.principal-research-proposal.v1',
  );
  assert.throws(() => StructuredRoleExecutionResultSchema.parse(
    structuredRoleExecutionResultFixture({
      outputSchemaRef: objectRef('different-json-schema'),
    }),
  ));
});

test('Question keeps origin provenance separate from its current status', () => {
  const question = QuestionSchema.parse(questionFixture({
    origin: 'default_mode',
    status: 'incubating',
  }));
  assert.equal(question.promptProvenance.origin, 'default_mode');
  assert.equal(
    question.promptProvenance.originAttestation.payload.classification,
    'autonomous',
  );
});

test('CandidateFinding has one strict Program D schema owner', () => {
  const finding = CandidateFindingSchema.parse(candidateFindingFixture({
    origin: 'dream',
    candidateType: 'connection',
  }));
  assert.equal(finding.schema, 'cosmo.candidate-finding.v1');
  assert.throws(() => CandidateFindingSchema.parse({
    ...finding,
    directCanonicalWrite: true,
  }));
  assert.throws(() => CandidateFindingSchema.parse({
    ...finding,
    content: {
      ...finding.content,
      capabilityGrantId: ids.object('smuggled-grant'),
    },
  }));
  assert.throws(() => CandidateFindingSchema.parse(candidateFindingFixture({
    candidateType: 'claim',
    evidenceSpanIds: [],
  })));
});

test('D aliases Program B event scope by object identity', () => {
  assert.equal(CognitiveEventScopeSchema, BrainEventScopeSchema);
  assert.equal(
    CognitiveLineageEventScopeSchema,
    BrainLineageEventScopeSchema,
  );
  assert.equal(
    CognitiveGenesisEventScopeSchema,
    GenesisBrainEventScopeSchema,
  );
  assert.equal(
    CognitiveEventScopeSchema.parse(brainLineageEventScopeFixture()).kind,
    'brain_lineage',
  );
  assert.equal(
    ProposeInitialCovenantInputSchema.safeParse({
      ...proposeInitialCovenantInputFixture(),
      eventScope: genesisBrainEventScopeFixture(),
    }).success,
    false,
  );
});

test('D to E gate inputs have one strict authority-bearing contract', () => {
  const originate = OriginateQuestionInputSchema.parse(
    originateQuestionInput(),
  );
  const build = BuildExpeditionInputSchema.parse(buildExpeditionInput());
  const execute = ExecuteExpeditionInputSchema.parse(
    executeExpeditionInput(),
  );
  const runControl = ProgramRunControlInputSchema.parse(
    programRunControlInputFixture(),
  );
  const reconcile = ReconcileRuntimeInputSchema.parse(
    reconcileRuntimeInputFixture(),
  );
  const disposition = ProposeCandidateDispositionInputSchema.parse(
    contestedCandidateInput(),
  );
  const committedReview = DECommittedCandidateReviewInputSchema.parse(
    deCommittedCandidateReviewInputFixture(),
  );
  const vertical = DEVerticalGateInputSchema.parse(verticalGateInput());

  assert.equal(originate.schema, 'cosmo.originate-question-input.v1');
  assert.equal(build.schema, 'cosmo.build-expedition-input.v1');
  assert.equal(execute.schema, 'cosmo.execute-expedition-input.v1');
  assert.equal(execute.runId, executeExpeditionInput().runId);
  assert.equal(execute.startedAt, executeExpeditionInput().startedAt);
  assert.match(execute.idempotencyKey, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(runControl.runIds, [...runControl.runIds].sort());
  assert.match(runControl.idempotencyKey, /^sha256:[a-f0-9]{64}$/);
  assert.match(reconcile.idempotencyKey, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    reconcile.mutationAuthorization,
    reconcileRuntimeInputFixture().mutationAuthorization,
  );
  assert.match(build.idempotencyKey, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    execute.mutationAuthorization,
    executeExpeditionInput().mutationAuthorization,
  );
  assert.deepEqual(
    vertical.mutationAuthorization,
    verticalGateInput().mutationAuthorization,
  );
  assert.match(vertical.idempotencyKey, /^sha256:[a-f0-9]{64}$/);
  assert.equal('questionId' in vertical.seedQuestionDraft, false);
  assert.equal('originEventId' in vertical.seedQuestionDraft, false);
  assert.equal(
    disposition.schema,
    'cosmo.propose-candidate-disposition-input.v1',
  );
  assert.throws(() => OriginateQuestionInputSchema.parse({
    ...originate,
    authorization: undefined,
  }));
  assert.throws(() => ExecuteExpeditionInputSchema.parse({
    ...execute,
    mutationAuthorization: undefined,
  }));
  assert.throws(() => ProgramRunControlInputSchema.parse({
    ...runControl,
    mutationAuthorization: undefined,
  }));
  assert.throws(() => ReconcileRuntimeInputSchema.parse({
    ...reconcile,
    mutationAuthorization: undefined,
  }));
  assert.throws(() => DEVerticalGateInputSchema.parse({
    ...vertical,
    idempotencyKey: undefined,
  }));
  assert.throws(() => ExecuteExpeditionInputSchema.parse({
    ...execute,
    directCanonicalWrite: true,
  }));
  assert.equal(
    DECommittedCandidateReviewInputSchema.safeParse({
      ...committedReview,
      canonicalTargetRef: committedReview.candidateBranchRef,
    }).success,
    false,
  );
});

test('Research Program and canonical roots have strict sorted contracts', () => {
  const state = ResearchProgramStateSchema.parse(researchProgramStateFixture({
    status: 'active',
    controlEpoch: 2,
  }));
  assert.match(state.payload.programId, /^program_/);
  const programRoot = ProgramRootPayloadSchema.parse(programRootFixture([
    state,
  ]));
  assert.equal(programRoot.entries[0]?.stateObjectRef.objectId,
    state.programStateObjectId);
  assert.throws(() => ProgramRootPayloadSchema.parse({
    ...programRoot,
    entries: [...programRoot.entries, ...programRoot.entries],
  }));
  assert.throws(() => ResearchProgramControlInputSchema.parse({
    ...researchProgramControlInputFixture(),
    actorIdentity: ids.sha('browser-supplied-authority'),
  }));
});

test('Program D partial receipt can never claim COSMO acceptance', () => {
  const question = questionMutationProposalFixture();
  const candidate = admittedCandidateFixture();
  const receipt = DEVerticalGateResearchReceiptSchema.parse({
    schema: 'cosmo.de-vertical-gate-research-receipt.v1',
    startingBrainCommitId: ids.commit('starting'),
    candidateBranchRef: 'refs/heads/candidates/program-d-contract',
    questionId: 'q_fixture',
    promptProvenance: promptProvenanceFixture(),
    questionMutationProposalRef: objectRefFor(question),
    questionMutationProposal: question,
    expeditionId: 'exp_fixture',
    endingCorpusSnapshotId: ids.snapshot('ending'),
    admittedEventIds: ['evt_candidate'],
    runtimeReceiptRefs: [objectRef('runtime-receipt')],
    researchToolReceiptIds: [ids.object('tool-receipt')],
    acquiredSourceObjectIds: [ids.object('source')],
    evidenceSpanIds: [ids.object('span')],
    admittedCandidates: [candidate],
    corpusRootMutationBatchRecording:
      corpusRootMutationBatchRecordingFixture(),
    discoveryProposalCreditedAsEvidence: false,
    toolReceiptCreditedAsEvidence: false,
    forcedRestartObserved: true,
    contextTurnoverObserved: true,
    lateFencedEventRejected: true,
    cosmoAccepted: false,
    blockedOn: 'program-e-living-brain-metabolism',
  });
  assert.equal(receipt.cosmoAccepted, false);
});
```

- [ ] **Step 3: Run and verify failure**

Run:

```bash
node --test --import tsx packages/contracts/test/research-runtime-contracts.test.ts
```

Expected: FAIL because Program D schemas do not exist.

- [ ] **Step 4: Implement strict schemas and package exports**

Use `.strict()` on every externally supplied object. Define a strict stored payload schema without the self-ID for each wrapper named in the content-addressing rule, plus its public recomposed wrapper schema. Refine:

- every allocation field is finite, nonnegative, and totals exactly `100`;
- `surprise`, `uncertainty`, and `confidence` are between `0` and `1`;
- `Question.origin` equals `Question.promptProvenance.origin`;
- `CausalOriginAttestation` is a stored wrapper whose kernel-recomputed classification is derived from the exact admitted events, parent Questions, prompt object, and frozen human/Principal task graph; missing, unreadable, mixed, or ambiguous ancestry is classified `ambiguous` and receives no autonomy credit;
- an `autonomous` attestation is valid only for `specialist`, `default_mode`, `dream`, `evidence_gap`, or `contradiction` origin and only when no causally equivalent active human/Principal task exists;
- `ResearchProgramIdSchema` is exactly `/^program_[A-Za-z0-9_-]+$/`; Program state wrapper IDs are derived from stored payloads, active run IDs and seed Questions are unique/sorted, `controlEpoch` is monotonic, and callers cannot choose an arbitrary next status;
- `ResearchProgramStatePayload.basedOnBrainCommitId` must equal the already-existing parent/expected commit from which the state was derived; no Program-root descendant may embed the not-yet-computable Brain commit that will enclose that root, and materializers attach the enclosing source commit only outside hashed payload bytes;
- every create/control/settlement/finalization mutation requires a SHA-256 `idempotencyKey`; replay succeeds only when the canonical input bytes are identical, while key reuse with any changed byte fails `program_idempotency_conflict`;
- pause/resume/cancel require the exact prior state object/status, append a control event before run fencing, and return only after the declared run-control effect is durable;
- `CreateResearchProgramInput.branchRef` is a live `refs/heads/*` ref equal to
  `eventScope.targetRef`, and `startingBrainCommitId` equals
  `eventScope.basedOnBrainCommitId`; the state, root proposal, and Program E
  acceptance retain those same pins and reject tags, settled refs, and
  cross-branch publication;
- `ResearchProgramModeSchema` is the one shared closed enum: `guided` permits only human/Principal-started expeditions, `blended` enforces the Covenant allocation across directed/adjacent/wildcard/incubation lanes, `autonomous` permits the durable cognitive lifecycle to originate work within Covenant bounds while remaining steerable, and `pure` is the causally isolated acceptance mode with no human/Principal task equivalent or steering during the measured run;
- `FinalizeProgramTransitionInput` requires the exact transitional state, control epoch, Brain/root pins, Program E `CognitiveLifecycleDecision` object, mutation authority, and idempotency key; only `creation_converged`, `pause_converged`, `resume_converged`, `cancel_converged`, `settlement_accepted`, and `settlement_rejected` map to their declared legal next states;
- settlement reaches only `completion_proposed` before E review and requires a qualified `PrincipalDecision.action='propose_program_settlement'`, satisfied stopping-criterion indexes, exact evidence objects, and no active/unfenced run; `propose_program_stop` remains the distinct immediate control proposal and cannot prove settlement; Program D remains the state-transition authority and Program E owns the accepting Brain/program-root commit;
- Question, Program, and Relationship root entries are uniquely keyed, canonically sorted, content-addressed strict payloads whose refs resolve to the matching decoded records and whose `through*EventId` values fall inside the Brain commit journal range;
- Relationship roots link the Covenant payload and revision event directly; they never embed the enclosing child Brain commit ID, and the codec/materialized view attaches that source commit externally;
- `OriginateQuestionInput` requires admitted source events, the exact prompt/task-graph objects, bounded initial status, and mutation authorization; `QuestionService` derives the Question ID and causal attestation rather than accepting either from the caller;
- `BuildExpeditionInput` pins every Question, Brain, candidate target
  ref/lineage/trust scope, corpus, Covenant, Principal, policy, grant,
  allocation, budget, stop, and block input before the service derives its
  Expedition ID and mission hash; it requires mutation authorization and a
  SHA-256 idempotency key before storing or appending anything;
  `ExpeditionContract.eventScope` is byte-equal to this input and the
  RuntimeAuthorization hash binds it;
- `ExecuteExpeditionInput` contains only the already-stored Expedition, its
  exact ContextBundle, matching RuntimeAuthorization, and the separate
  MutationAuthorization required for quarantine/admission journal writes. Its
  RunId is derived from the persisted coordinator intent, its first
  `startedAt` comes from the injected Clock and is then replayed, and its
  SHA-256 idempotency key binds all of those bytes. Cross-field refinement
  requires their mission, commit, corpus, Covenant, grant, and fence identities
  to agree; `StartRuntimeInput` receives those exact run/time/authority/key
  values, while provider-facing `WorkerRuntime.runMission` receives none of the
  mutation authority or idempotency key;
- `ProgramRunControlInput` is the sole batch pause/cancel envelope. Run IDs are
  unique/sorted and it requires reason, MutationAuthorization, occurrence time,
  and a SHA-256 idempotency key. The adapter derives deterministic per-run
  subkeys and maps those exact values into `PauseRuntimeInput` or
  `CancelRuntimeInput`; it never synthesizes authority or wall-clock time;
- `RuntimeExecutionPlan.outputSchemaRef` resolves to an immutable canonical
  JSON Schema whose declared name equals `outputSchemaName`.
  `cosmo.worker-output-batch.v1` validates the newly defined strict
  `WorkerOutputBatch`; Principal, independent-review, inquiry-generator, and
  inquiry-verifier roles pin their own owner-defined schema refs through the
  same mechanism;
- `RuntimeExecutionPlan.outputTrust` is explicit and may be only equally or
  more restrictive than every required ContextUnit, Covenant rule, and tool
  output that can influence the result. The runtime recomputes that meet,
  rejects a broader caller value, stores the output with the effective
  descriptor, and repeats it in the RuntimeReceipt;
- `StructuredRoleExecutionInput` requires an already-stored Expedition ref,
  exact ContextBundle, runtime and mutation authorizations, persisted RunId,
  time, and idempotency identity. `StructuredRoleExecutionPort` validates
  canonical JSON against the pinned schema before storing it and returns only
  `StructuredRoleExecutionResult`; the semantic owner then reparses that JSON
  with its own strict schema. Provider output, SDK state, and hidden reasoning
  never cross this seam;
- every `RuntimeReceipt` repeats the exact run/Expedition identity and carries
  refs for its immutable Expedition, ContextBundle, output schema, and output
  object, plus mission/authorization hashes and branch epoch/fence. Those refs
  and hashes must resolve and cross-pin exactly to the grant, Covenant, budget,
  mission, context, and output used; the receipt cannot be reconstructed from
  provider metadata alone;
- raw fencing tokens remain runtime/quarantine-only; durable receipts and Brain
  closure retain only `fencingTokenHash`, which is non-replayable and must
  match the authorization hash computation;
- `RuntimeReceiptRecording.receiptRef` is recomputed from and resolves to the
  exact strict RuntimeReceipt bytes; a caller-chosen, missing, or mismatched
  completion ref is rejected;
- `ProposeCandidateDispositionInput` requires mutation authorization and the exact Program C transition decision, preserves its review IDs, and cannot request `supported` when that decision is not allowed;
- each worker evidence/negative/experiment proposal uses its named strict schema and omits canonical IDs that only Program C may assign; admission maps them respectively to a verified `EvidenceSpan`, `NegativeKnowledge`, `ExperimentProtocol`, or `ExperimentObservation` wrapper and stores only that canonical output reference in the CognitiveEvent;
- `CandidateFindingSchema` is a strict discriminated union whose seven content variants exactly match the frozen master interfaces; no nested variant permits `unknown`, raw provider/tool bytes, authority, grants, leases, code, or worker-chosen canonical IDs;
- claim candidates require at least one evidence span; contradiction candidates name distinct fully attributed claims and only opposing spans also present in the outer evidence set; connection and activation candidates use Program B `BrainObjectAddress` values, activation scores are finite in `[0,1]` with unique attributed targets and an existing parent commit pin, and no merged-Brain producer may collapse an address to a bare ID without a uniqueness proof; negative-knowledge candidates require a recorded attempt or an explicit durable blocked outcome;
- an evidence extraction proposal must resolve its named Extraction, snapshot, source, locator, and text hash exactly; raw URL/text/provider payloads remain opaque tool-receipt data and are rejected at the cognitive admission boundary;
- ContextUnit priority is a nonnegative integer and unit IDs are unique within a bundle;
- budgets are nonnegative and at least one limit is positive;
- `expiresAt` is after the authorizing time;
- runtime sequence and branch epoch are nonnegative integers;
- `event.type` is a closed discriminated union;
- `CognitiveEvent.source` is the closed worker/human/semantic-role/kernel union, each source permits only its declared event kinds, causal parents are unique/sorted and older, and only the worker source can name an envelope/Expedition/Run or enter quarantine;
- `RenderedContextReceipt.generatedSummaryUsed` is the literal `false`; and
- `DEVerticalGateResearchReceipt.cosmoAccepted` and `blockedOn` are literals;
- `DEVerticalGateInput` requires a per-call MutationAuthorization and one
  SHA-256 base idempotency key. The coordinator derives named deterministic
  subkeys for Question origin, Expedition build, each admission, Corpus batch,
  and final receipt storage; it never obtains per-call authority from its
  constructor or ambient process state. Identical replay returns the same
  durable results without a second model/tool call or journal event, and any
  changed byte under the base key fails `idempotency_conflict`.
- `DEVerticalGateResearchReceipt.admittedEventIds`,
  `runtimeReceiptRefs`, and `researchToolReceiptIds` are unique and
  lexicographically sorted. Every admitted worker event resolves through its
  source `runId` and `expeditionId` to exactly one selected RuntimeReceipt;
  every selected RuntimeReceipt resolves its immutable ContextBundle; every
  selected research-tool receipt repeats the same run/Expedition/mission
  identity; and the receipt rejects missing, duplicate, mismatched, or orphan
  runtime/tool provenance.

Do not put repository service logic in `@cosmo/contracts`.

- [ ] **Step 5: Confirm workspace resolution and lockfile stability**

Run:

```bash
npm install
npm query .workspace | jq -r '.[].name' | sort
```

Expected: npm still resolves both workspaces and does not introduce an unreviewed dependency or lockfile change.

- [ ] **Step 6: Run focused and existing contract tests**

Run:

```bash
node --test --import tsx packages/contracts/test/research-runtime-contracts.test.ts
npm test --workspace @cosmo/contracts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/research.ts packages/contracts/src/runtime.ts packages/contracts/src/index.ts packages/contracts/test/research-runtime-contracts.test.ts packages/research/src/index.ts packages/runtime/src/index.ts
git commit -m "feat(research): freeze research and runtime contracts"
```

### Task 2: Version the Research Covenant, Human Relationship, and Research Program

**Files:**
- Create: `packages/research/src/covenant-service.ts`
- Create: `packages/research/src/relationship-service.ts`
- Create: `packages/research/src/research-program-service.ts`
- Create: `packages/research/src/artifact-index-service.ts`
- Create: `packages/research/src/research-genesis-builder.ts`
- Create: `packages/research/src/root-codecs.ts`
- Create: `packages/research/test/covenant-relationship.test.ts`
- Create: `packages/research/test/research-program.test.ts`
- Create: `packages/research/test/artifact-index.test.ts`
- Create: `packages/research/test/research-genesis-builder.test.ts`
- Create: `packages/research/test/root-codecs.test.ts`
- Modify: `packages/research/src/index.ts`

**Interfaces:**
- Consumes: Program B `BrainRepository.objects`, `.journal`, `.trust`; Program C `EvidencePolicyService.assertAtLeastAsStrong`; injected contracts-only `ProgramRunControlPort`.
- Produces:

```ts
export class ResearchCovenantService {
  proposeInitial(input: ProposeInitialCovenantInput): Promise<CovenantRevisionProposal>;
  proposeRevision(input: ProposeCovenantRevisionInput): Promise<CovenantRevisionProposal>;
}

export class ResearchRelationshipService {
  record(input: RecordRelationshipEventInput): Promise<RelationshipMutationResult>;
  project(events: readonly RelationshipEvent[]): RelationshipState;
}

export class ResearchProgramService {
  proposeDirection(
    input: ProposeResearchProgramDirectionInput
  ): Promise<ResearchProgramDirectionProposal>;
  create(input: CreateResearchProgramInput): Promise<ResearchProgramMutationResult>;
  pause(input: ResearchProgramControlInput): Promise<ResearchProgramMutationResult>;
  resume(input: ResearchProgramControlInput): Promise<ResearchProgramMutationResult>;
  cancel(input: ResearchProgramControlInput): Promise<ResearchProgramMutationResult>;
  proposeSettlement(
    input: ProposeProgramSettlementInput
  ): Promise<ResearchProgramMutationResult>;
  finalizeTransition(
    input: FinalizeProgramTransitionInput
  ): Promise<ResearchProgramMutationResult>;
  get(programId: ResearchProgramId): Promise<ResearchProgramState>;
  listCanonical(input: ListResearchProgramsInput): Promise<ResearchProgramPage>;
  listPending(
    input: ListPendingProgramMutationsInput
  ): Promise<PendingProgramMutationPage>;
  reconcile(programId: ResearchProgramId): Promise<ResearchProgramMutationResult | null>;
}

export class ArtifactIndexService {
  proposeAddition(
    input: ProposeArtifactIndexUpdateInput
  ): Promise<ArtifactIndexUpdateProposal>;
}

export class ResearchGenesisBuilder {
  build(
    input: ResearchGenesisBuildInput
  ): Promise<ResearchGenesisRoots>;
}

export const questionRootCodec: BrainRootCodec<QuestionRootPayload>;
export const programRootCodec: BrainRootCodec<ProgramRootPayload>;
export const relationshipRootCodec: BrainRootCodec<RelationshipRootPayload>;
export const artifactIndexRootCodec: BrainRootCodec<ArtifactIndexRootPayload>;
```

- [ ] **Step 1: Write the failing versioning and inference tests**

```ts
test('Covenant revision preserves parent and cannot weaken evidence without human event', async () => {
  const harness = await covenantHarness({
    current: covenantFixture({ minimumIndependentSources: 2 }),
    approvalEvent: relationshipEventFixture({
      kind: 'taste_judgment',
      confirmedByHuman: true,
    }),
  });
  await assert.rejects(harness.service.proposeRevision(
    proposeCovenantRevisionInput(harness, {
      payload: covenantFixture({ minimumIndependentSources: 1 }),
    }),
  ), /authenticated Covenant revision is required to loosen evidence minimum/);
});

test('Covenant revision is an inert, fully rooted Relationship proposal', async () => {
  const harness = await covenantHarness({
    approvalEvent: relationshipEventFixture({
      kind: 'permission_granted',
      confirmedByHuman: true,
    }),
  });
  const input = proposeCovenantRevisionInput(harness);
  const proposal = await harness.service.proposeRevision(input);
  assert.equal(
    proposal.previousCovenantPayloadRef.objectId,
    harness.currentCovenantPayloadRef.objectId,
  );
  assert.equal(proposal.basedOnBrainCommitId, harness.brainCommitId);
  assert.equal(
    proposal.relationshipMutation.event.kind,
    'covenant_revised',
  );
  assert.deepEqual(proposal.eventScope, input.eventScope);
  assert.deepEqual(
    proposal.relationshipMutation.relationshipRootUpdate.eventScope,
    input.eventScope,
  );
  assert.deepEqual(
    proposal.relationshipMutation.relationshipRootUpdate.nextRelationshipRoot
      .covenantPayloadRef,
    proposal.covenantPayloadRef,
  );
  assert.equal(harness.repository.commits.createCalls.length, 0);
  assert.equal(harness.repository.refs.advanceCalls.length, 0);
  await assert.rejects(
    harness.service.proposeRevision({
      ...input,
      idempotencyKey: ids.sha('wrong-scope-attempt'),
      eventScope: {
        ...input.eventScope,
        basedOnBrainCommitId: ids.commit('other-parent'),
      },
    }),
    { code: 'research_mutation_scope_mismatch' },
  );
});

test('human correction reverses an earlier event without deleting it', async () => {
  const service = makeRelationshipService();
  const earlier = await service.record(relationshipInput({
    kind: 'taste_judgment',
    content: 'Prefer breadth in every project.',
  }));
  const correction = await service.record(relationshipInput({
    kind: 'correction',
    content: 'Prefer depth for this research program.',
    reversesRelationshipEventId: earlier.event.relationshipEventId,
  }));
  const state = service.project([earlier.event, correction.event]);
  assert.ok(state.corrections.includes(correction.event.relationshipEventId));
  assert.ok(!state.tasteJudgments.includes(earlier.event.relationshipEventId));
});

test('personal inference never becomes a confirmed personal fact', async () => {
  const service = makeRelationshipService();
  const inference = await service.record(relationshipInput({
    kind: 'personal_inference',
    content: 'The human may prefer visual output.',
    confirmedByHuman: false,
    confidence: 0.55,
  }));
  const state = service.project([inference.event]);
  assert.deepEqual(state.confirmedPersonalFacts, []);
  assert.deepEqual(
    state.personalInferences,
    [inference.event.relationshipEventId],
  );
});

test('Research Program create is idempotent only for the exact same request', async () => {
  const service = makeResearchProgramService();
  const input = createResearchProgramInput();
  const first = await service.create(input);
  const duplicate = await service.create(input);
  assert.equal(
    duplicate.receipt.researchProgramMutationReceiptId,
    first.receipt.researchProgramMutationReceiptId,
  );
  assert.equal(first.receipt.nextState.payload.status, 'initializing');
  assert.equal(input.branchRef, input.eventScope.targetRef);
  assert.equal(
    input.startingBrainCommitId,
    input.eventScope.basedOnBrainCommitId,
  );
  assert.equal(first.receipt.nextState.payload.branchRef, input.branchRef);
  await assert.rejects(
    service.create({ ...input, purpose: 'A conflicting purpose' }),
    { code: 'program_idempotency_conflict' },
  );
  assert.equal(CreateResearchProgramInputSchema.safeParse({
    ...input,
    branchRef: 'refs/tags/not-writable',
  }).success, false);
});

test('a reviewed program direction remains a candidate and creates no Program state', async () => {
  const harness = await researchProgramHarness();
  const proposal = await harness.service.proposeDirection(
    proposeResearchProgramDirectionInput(harness),
  );
  assert.match(proposal.proposalObjectId, /^sha256:/);
  assert.equal(harness.stateStore.programs.size, 0);
  assert.equal(harness.repository.commits.createCalls.length, 0);
  assert.equal(harness.repository.refs.advanceCalls.length, 0);
});

test('pause durably records intent before fencing every active run', async () => {
  const harness = await activeResearchProgramHarness({ runIds: ['run_1', 'run_2'] });
  const input = researchProgramControlInput(harness, { action: 'pause' });
  const receipt = await harness.service.pause(
    input,
  );
  assert.deepEqual(harness.store.statusWrites, ['pausing']);
  assert.deepEqual(harness.runControl.pausedRunIds, ['run_1', 'run_2']);
  assert.deepEqual(harness.runControl.pauseInputs, [{
    schema: 'cosmo.program-run-control-input.v1',
    runIds: ['run_1', 'run_2'],
    reason: input.reason,
    mutationAuthorization: input.authorization,
    idempotencyKey: deriveSubkey(input.idempotencyKey, 'pause-runs'),
    occurredAt: input.requestedAt,
  }]);
  assert.deepEqual(receipt.receipt.fencedRunIds, ['run_1', 'run_2']);
  assert.equal(receipt.receipt.nextState.payload.status, 'pausing');
  assert.equal(
    receipt.controlNotice.programRootUpdate.changedProgramId,
    harness.programId,
  );
  assert.equal(harness.repository.refs.advanceCalls.length, 0);
  assert.equal(harness.repository.commits.createCalls.length, 0);
});

test('crash during cancel reconciles once and rejects stale control epochs', async () => {
  const harness = await cancellingResearchProgramHarness({
    crashAfterIntent: true,
    runIds: ['run_9'],
  });
  await assert.rejects(
    harness.service.cancel(researchProgramControlInput(harness, { action: 'cancel' })),
    /injected crash/,
  );
  const reconciled = await harness.service.reconcile(harness.programId);
  const duplicate = await harness.service.reconcile(harness.programId);
  assert.equal(reconciled?.receipt.nextState.payload.status, 'cancelling');
  assert.equal(duplicate, null);
  assert.equal(harness.runControl.cancelCalls, 1);
  await assert.rejects(
    harness.service.pause(staleEpochControlInput(harness)),
    { code: 'program_control_epoch_mismatch' },
  );
});

test('resume never revives an old run and leaves scheduling to Program E', async () => {
  const harness = await pausedResearchProgramHarness();
  const receipt = await harness.service.resume(
    researchProgramControlInput(harness, { action: 'resume' }),
  );
  assert.equal(receipt.receipt.nextState.payload.status, 'resuming');
  assert.deepEqual(receipt.receipt.nextState.payload.activeRunIds, []);
  assert.equal(harness.runControl.startCalls, 0);
  assert.equal(
    receipt.controlNotice.programRootUpdate.changedProgramId,
    harness.programId,
  );
});

test('settlement is a Principal-backed proposal, never silent completion', async () => {
  const harness = await activeResearchProgramHarness();
  const receipt = await harness.service.proposeSettlement(
    proposeProgramSettlementInput(harness),
  );
  assert.equal(receipt.receipt.nextState.payload.status, 'completion_proposed');
  assert.notEqual(receipt.receipt.nextState.payload.status, 'completed');
  assert.equal(
    receipt.receipt.nextState.payload.lastPrincipalDecisionId,
    harness.principalDecisionId,
  );
});

test('only an exact Program E decision can finalize a transitional state', async () => {
  const harness = await resumingResearchProgramHarness();
  const result = await harness.service.finalizeTransition(
    finalizeProgramTransitionInput(harness, {
      action: 'resume_converged',
    }),
  );
  assert.equal(result.receipt.nextState.payload.status, 'active');
  assert.equal(
    result.receipt.nextState.payload.lastCognitiveLifecycleDecisionObjectId,
    harness.cognitiveLifecycleDecisionObjectId,
  );
  await assert.rejects(
    harness.service.finalizeTransition({
      ...finalizeProgramTransitionInput(harness),
      expectedControlEpoch: harness.controlEpoch - 1,
    }),
    { code: 'program_control_epoch_mismatch' },
  );
});

test('creation becomes active only after E accepts the pending root and initializes', async () => {
  const harness = await initializingResearchProgramHarness();
  const result = await harness.service.finalizeTransition(
    finalizeProgramTransitionInput(harness, {
      action: 'creation_converged',
      expectedBrainCommitId: harness.commitThatAcceptedInitializingRoot,
      expectedProgramRootRef: harness.acceptedInitializingProgramRootRef,
    }),
  );
  assert.equal(result.receipt.nextState.payload.status, 'active');
  assert.equal(
    result.receipt.nextState.payload.lastCognitiveLifecycleDecisionObjectId,
    harness.initializationDecisionObjectId,
  );
});

test('canonical enumeration is root-pinned and pending mutations stay distinct', async () => {
  const harness = await mixedCanonicalAndPendingProgramHarness();
  const canonical = await harness.service.listCanonical(
    listResearchProgramsInput(harness),
  );
  const pending = await harness.service.listPending(
    listPendingProgramMutationsInput(harness),
  );
  assert.deepEqual(
    canonical.programs.map((program) => program.payload.programId),
    harness.canonicalProgramIds,
  );
  assert.deepEqual(
    pending.results.map((result) => result.receipt.programId),
    harness.pendingProgramIds,
  );
  assert.equal(
    canonical.programs.some((program) =>
      harness.pendingProgramIds.includes(program.payload.programId)),
    false,
  );
});

test('D root codecs expose exact closure and never require enclosing commit IDs', async () => {
  const harness = await researchRootCodecHarness();
  for (const codec of [
    questionRootCodec,
    programRootCodec,
    relationshipRootCodec,
    artifactIndexRootCodec,
  ]) {
    const verification = await codec.verify(harness.verifyInput(codec.rootKind));
    assert.equal(verification.valid, true);
    assert.equal(
      verification.reachableObjectIds.includes(harness.enclosingCommitId),
      false,
    );
  }
  await assert.rejects(
    programRootCodec.verify(harness.withMissingLifecycleDecision()),
    { code: 'root_closure_missing_object' },
  );
});

test('artifact index is derived secondary output and cannot claim Brain truth', async () => {
  const harness = await artifactIndexHarness();
  const input = proposeArtifactIndexUpdateInput(harness);
  const proposal = await harness.service.proposeAddition(input);
  assert.equal(
    proposal.artifact.payload.derivedFromBrainCommitId,
    harness.existingParentCommitId,
  );
  assert.notEqual(
    proposal.artifact.payload.bytesRef.objectId,
    proposal.artifact.artifactId,
  );
  assert.equal(harness.repository.commits.createCalls.length, 0);
  assert.equal(harness.repository.refs.advanceCalls.length, 0);
  assert.deepEqual(proposal.eventScope, input.eventScope);
  await assert.rejects(
    harness.service.proposeAddition({
      ...proposeArtifactIndexUpdateInput(harness),
      artifact: {
        ...proposeArtifactIndexUpdateInput(harness).artifact,
        claimStatus: 'supported',
      },
    } as never),
    { code: 'artifact_record_invalid' },
  );
});

test('every normal D root mutation is scope-bound and exactly idempotent', async () => {
  for (const scenario of await normalResearchMutationScopeCases([
    'relationship',
    'program_direction',
    'program_create',
    'program_pause',
    'program_settlement',
    'program_finalize',
    'artifact',
  ])) {
    const first = await scenario.invoke(scenario.input);
    const retry = await scenario.invoke(scenario.input);
    assert.deepEqual(retry, first, scenario.name);
    assert.deepEqual(scenario.resultScope(first), scenario.input.eventScope);

    await assert.rejects(
      scenario.invoke(scenario.changeSemanticByteUnderSameKey()),
      { code: 'idempotency_conflict' },
    );

    for (const wrongScope of scenario.wrongScopeVariants([
      'basedOnBrainCommitId',
      'targetRef',
      'programId',
      'lineageId',
      'trustDomain',
    ])) {
      const appendCount = scenario.journalAppendCount();
      await assert.rejects(
        scenario.invoke({
          ...scenario.input,
          idempotencyKey: ids.sha(`${scenario.name}-${wrongScope.field}`),
          eventScope: wrongScope.value,
        }),
        { code: 'research_mutation_scope_mismatch' },
      );
      assert.equal(scenario.journalAppendCount(), appendCount);
    }
  }
});

test('genesis builder creates D roots without requiring an existing Brain', async () => {
  const harness = makeResearchGenesisBuilderHarness();
  const input = researchGenesisBuildInput({
    seedQuestions: [genesisSeedQuestionFixture()],
  });
  const bundle = await harness.builder.build(input);
  assert.equal(bundle.relationshipRoot.covenantPayloadRef.objectId,
    bundle.payload.covenantPayloadRef.objectId);
  assert.equal(bundle.questionRoot.entries.length, 1);
  assert.deepEqual(
    bundle.payload.seedQuestionIds,
    bundle.questions.map((question) => question.questionId),
  );
  assert.deepEqual(
    bundle.payload.questionRefs,
    bundle.questionRoot.entries.map((entry) => entry.questionObjectRef),
  );
  assert.deepEqual(bundle.programRoot.entries, []);
  assert.deepEqual(bundle.artifactIndexRoot.entries, []);
  assert.equal(bundle.questions[0]?.promptProvenance.origin, 'human');
  assert.equal(bundle.relationshipEvents.some(
    (event) => event.kind === 'covenant_set' && event.confirmedByHuman,
  ), true);
  assert.equal(bundle.cognitiveEvents.every(
    (event) => event.source.kind === 'kernel_lifecycle'
      && event.source.stage === 'genesis'
      && canonicalEqual(event.scope, input.genesisScope),
  ), true);
  const enclosingRefs = [
    bundle.rootsRef,
    bundle.payload.relationshipRootRef,
    bundle.payload.questionRootRef,
    bundle.payload.programRootRef,
    bundle.payload.artifactIndexRootRef,
  ];
  assert.equal(bundle.cognitiveEvents.every(
    (event) => enclosingRefs.every(
      (ref) => event.payloadRef.objectId !== ref.objectId,
    ),
  ), true);
  await assertAcyclicObjectClosure(
    harness.repository,
    [...enclosingRefs, ...bundle.payload.relationshipEventRefs,
      ...bundle.payload.questionRefs],
  );
  assert.equal(
    input.genesisScope.trustDomain,
    input.trust.encryptionDomain,
  );
  await assert.rejects(
    harness.builder.build({
      ...input,
      genesisScope: {
        ...input.genesisScope,
        trustDomain: 'different-domain',
      },
    }),
    { code: 'genesis_trust_scope_mismatch' },
  );
  assert.equal(harness.repository.commits.createCalls.length, 0);
  assert.equal(harness.repository.refs.advanceCalls.length, 0);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test --import tsx packages/research/test/covenant-relationship.test.ts
```

Expected: FAIL because the Covenant, Relationship, and Research Program services are missing.

- [ ] **Step 3: Implement proposals, events, and projection**

Every write first calls `repository.trust.authorize(...)`; only `allowed: true` proceeds. Store strict payload bytes through Program B `repository.objects.put(input, { actorIdentity, capabilityGrantId })`, then append the exact Program B `AppendJournalInput`. Any private or restricted read passes that authorization to `repository.objects.get`. Neither service calls `repository.commits.create`, `repository.refs.compareAndSwap`, or `repository.commitAndAdvance`; if a later program needs direct commit creation, Program B requires `repository.commits.create(payload, signatures, authorization)`.

`ResearchCovenantService` accepts only the two strict inputs frozen in Task 1.
It resolves the expected Brain and Relationship root, loads the current
Covenant payload for a revision, and verifies the existing
`approvedByRelationshipEventId`. Initial setup requires a confirmed human
`permission_granted` event; a revision that changes authority, privacy, rights,
budget, evidence minimum, autonomy floor, or self-research mode requires a
confirmed human approval event whose content explicitly names that revision.
The service stores the new Covenant payload, records a distinct
`covenant_set`/`covenant_revised` RelationshipEvent through
`ResearchRelationshipService`, and returns one inert
`CovenantRevisionProposal` containing the payload ref and exact Relationship
root update. It creates no Brain commit. Exact retries return the same proposal;
changed input under an idempotency key fails.

`ResearchGenesisBuilder` is the only exception to the normal
parent-pinned D mutation inputs, and it is a builder rather than a commit
authority. From one authenticated human approval, initial Covenant, and at
least one explicit seed Question, it stores the Covenant, initial
RelationshipEvents/state, human-origin Questions/provenance, and exact empty
Program/Artifact-index leaves. It returns all four verified root payloads/refs,
the stored bundle ref, and distinct genesis CognitiveEvents. It receives no
existing Brain/root ID, cannot call a commit/ref method, and cannot be used when
the target ref already exists. The overall genesis event points only to a
separately stored pre-build intent/seed object; Relationship and Question events
point only to their leaf records. No genesis event may point to `rootsRef`, an
enclosing root, or a future commit, and the builder verifies the complete
object-link closure is acyclic before returning. Its `genesisScope` is derived
by Program E from
the target ref, deterministic genesis lineage identity, and approved effective
trust domain (`string | null`); D echoes it byte-for-byte on every genesis
event and cannot replace it. Program E passes its single factory-pinned
`genesisTrust`; D requires `genesisScope.trustDomain` to equal
`genesisTrust.encryptionDomain` and uses the same descriptor for every stored
genesis object.
Program E's `GenesisBrainService` composes this bundle with the C/B/E owner
builders and alone creates the parentless commit.
Normal `proposeInitial()` remains parent-pinned and is never used to fake
genesis.

Only the resulting `covenant_revised` RelationshipEvent with
`confirmedByHuman:true` may propose changed authority, privacy, rights, budget,
evidence minimum, or autonomy floor. Revocations reference the grant event they
reverse. Projection is deterministic by `(occurredAt, relationshipEventId)`.

`ResearchProgramService` is Program D's sole authority for durable Research Program state and control epochs. It validates the caller's exact Brain commit, Program root ref, state object ID, status, and authorization before changing anything. Creation stores only an `initializing` `ResearchProgramStatePayload`, appends the control event, and returns a `ProgramRootUpdateProposal`; it never reports `active`, creates a Brain commit, or advances a ref. Program E first accepts that exact pending root proposal in a canonical child commit, initializes the lifecycle against that accepted child, and calls `finalizeTransition(action='creation_converged')`; D then proposes the `active` state/root for E's second idempotent canonical transaction. A crash in any window remains honestly `initializing` and is resumed from the stored D receipt. An identical `(programId, idempotencyKey)` request returns the prior decoded receipt, while any different body under that key fails closed.

Creation additionally requires
`branchRef === eventScope.targetRef` and
`startingBrainCommitId === eventScope.basedOnBrainCommitId`; the branch must be
a live `refs/heads/*` ref, never a tag or settled snapshot. Every returned
state and Program-root proposal preserves that exact ref. Program E may accept
the proposal only onto the same canonical ref, so a caller cannot cross-pin
Program state to one branch while advancing another.

`proposeDirection()` is deliberately not `create()`. It stores a strict candidate-only research agenda with the existing Brain/Covenant pins and returns its decoded object identity for admission into cognition. It allocates no `ResearchProgramId`, creates no Program state/root entry, starts no runtime, and advances no ref. A later explicit create flow must supply the complete `CreateResearchProgramInput` and pass the D→E initialization state machine.

Pause and cancel are recoverable two-phase controls:

1. persist an immutable `pausing` or `cancelling` intent state and journal record;
2. call the injected `ProgramRunControlPort` with the sorted active run IDs;
3. persist the resulting checkpoints/fences on the transitional state; and
4. store the decoded `ResearchProgramMutationReceipt` payload and return the exact `ResearchProgramMutationResult`, whose derived `ProgramControlNotice` carries that receipt identity and root proposal.

For pause/cancel, step 2 maps the human control input exactly into one
`ProgramRunControlInput`: sorted stored RunIds, unchanged reason,
`authorization` as `mutationAuthorization`, `requestedAt` as `occurredAt`, and
a deterministic `pause-runs` or `cancel-runs` subkey. Program D persists this
batch input with the control intent before calling the port. The runtime
adapter may derive per-run subkeys but may not replace any mapped value.

`reconcile(programId)` resumes only an unfinished persisted intent and is idempotent across restart. It never repeats an already receipted runtime side effect. Resume asserts that no old run is active, clears `activeRunIds`, persists `resuming`, and emits a control notice; it does not start a run or choose `nextWakeAt`. Program E consumes each committed notice before its next due-check and decides when the control has converged. It then calls D's `finalizeTransition()` with the exact state object, Brain/root pins, control epoch, E-owned `CognitiveLifecycleDecision` object, authority, and idempotency key. Program D remains the sole writer of Research Program state: it validates that decision, records only its object ID, and produces the final `paused`, `active`, `cancelled`, or `completed` state plus its next Program-root proposal. Program E remains the single source of truth for `nextWakeAt` and owns the canonical Brain transaction that accepts the proposal. Completion is likewise two-stage: `proposeSettlement()` can persist only `completion_proposed` after validating the Principal decision, satisfied stopping criteria, and cited evidence; only `settlement_accepted` may finalize `completed`, while `settlement_rejected` returns the Program to `active` with the rejection reason preserved.

All state/root arrays are canonicalized before storage. `ProgramRootUpdateProposal.previousProgramRootRef` must equal the caller's expected root; `nextProgramStateRef` must name the just-stored state; `expectedBrainCommitId` is a pin, not permission to mutate that commit. Relationship, Question, and Program root changes remain proposals until Program E's single canonical Brain transaction accepts them.

Every normal Covenant, Relationship, Question, Research Program, and Artifact
mutation verifies its explicit `eventScope` against the expected Brain and
requesting event, appends each new event with that same scope, and returns the
scope unchanged on its stored proposal/root update/receipt. Program E accepts
only proposals whose event IDs resolve to that exact scope and target ref.
Genesis alone uses the dedicated genesis builders and genesis scope.

`listCanonical()` verifies the exact Brain commit and Program root, authorizes every non-public state read, filters only the closed status enum, and paginates deterministically by `programId`. It never includes a D state whose root proposal has not entered that canonical Program root. `listPending()` reads the separate idempotency/journal index of stored mutation results awaiting E acceptance and paginates by receipt ID. Program H must reconcile pending creation/control/finalization results before asking E to inspect or schedule canonical Programs; it may not infer pending state by scanning object-store directories.

`ArtifactIndexService` stores immutable artifact bytes separately from a strict descriptor, requires `derivedFromBrainCommitId` to be an already-existing parent pin, and returns only an Artifact-index root proposal. An artifact is a secondary projection: it cannot add/change a Claim, Question, cognition node, Program status, evidence status, or canonical ref. Its descriptor cites the exact admitted derivation events and supporting claims. Query code may retrieve an artifact only when explicitly requested; the Brain-over-files proof forbids substituting artifact prose for accumulated cognition.

`questionRootCodec`, `programRootCodec`, `relationshipRootCodec`, and `artifactIndexRootCodec` implement Program B's exact frozen `BrainRootCodec` interface. Each accepts only its matching leaf schema, verifies the supplied root descriptor and source-commit field, and returns a lexicographically sorted complete closure. Question closure follows Question wrappers, parent Questions, causal attestations, prompts, admitted source events, claims, and evidence refs. Program closure follows state wrappers plus the Principal and E lifecycle decision objects explicitly named in each state; every model-derived Principal decision further links its proposal-attempt receipt, runtime receipt, role definition, and survey ContextBundle. Mutation receipts stay journal-addressed because they already contain the proposed root and would create a hash cycle if the root linked back to them. Relationship closure follows the Covenant, projected state, every unretracted/reversal event needed for projection, and cited evidence. Artifact closure follows each descriptor, immutable bytes, generating events, cited claims, and declared corpus pins. None of the four leaf payloads contains the enclosing source commit ID; the codec attaches that ID only to the decoded Program B materialization wrapper.

- [ ] **Step 4: Run focused and package tests**

Run:

```bash
node --test --import tsx packages/research/test/covenant-relationship.test.ts
node --test --import tsx packages/research/test/research-program.test.ts
node --test --import tsx packages/research/test/artifact-index.test.ts
node --test --import tsx packages/research/test/research-genesis-builder.test.ts
node --test --import tsx packages/research/test/root-codecs.test.ts
npm test --workspace @cosmo/research
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/covenant-service.ts packages/research/src/relationship-service.ts packages/research/src/research-program-service.ts packages/research/src/artifact-index-service.ts packages/research/src/research-genesis-builder.ts packages/research/src/root-codecs.ts packages/research/src/index.ts packages/research/test/covenant-relationship.test.ts packages/research/test/research-program.test.ts packages/research/test/artifact-index.test.ts packages/research/test/research-genesis-builder.test.ts packages/research/test/root-codecs.test.ts
git commit -m "feat(research): preserve Covenant relationship and program history"
```

### Task 3: Implement Durable Question Ecology

**Files:**
- Create: `packages/research/src/question-service.ts`
- Create: `packages/research/src/causal-origin-attestor.ts`
- Create: `packages/research/test/question-ecology.test.ts`
- Modify: `packages/research/src/index.ts`

**Interfaces:**
- Consumes: admitted `CognitiveEvent`, relationship events, exact corpus snapshots, Program B objects/journal/trust.
- Produces:

```ts
export class QuestionService {
  originate(input: OriginateQuestionInput): Promise<QuestionMutationProposal>;
  transition(input: TransitionQuestionInput): Promise<QuestionMutationProposal>;
  load(questionObjectId: ObjectId): Promise<Question>;
}

export class CausalOriginAttestor {
  attest(input: CausalOriginAttestationInput): Promise<CausalOriginAttestation>;
  verify(input: VerifyCausalOriginAttestationInput): Promise<CausalOriginVerification>;
}
```

- [ ] **Step 1: Write the failing ecology tests**

```ts
test('question remains distinct from task, goal, and claim identifiers', async () => {
  const service = makeQuestionService();
  const proposal = await service.originate(originateQuestionInput({
    wording: 'Why do two distant evidence clusters move together?',
    origin: 'default_mode',
  }));
  assert.match(proposal.question.questionId, /^q_/);
  assert.ok(!proposal.question.wording.startsWith('Complete '));
  assert.deepEqual(proposal.question.partialAnswerClaimIds, []);
});

test('Question origination is scope-bound and exactly idempotent', async () => {
  const service = makeQuestionService();
  const input = originateQuestionInput();
  const first = await service.originate(input);
  const retry = await service.originate(input);
  assert.deepEqual(retry, first);
  assert.deepEqual(first.eventScope, input.eventScope);
  await assert.rejects(
    service.originate({
      ...input,
      wording: 'Different wording under the same key',
    }),
    { code: 'idempotency_conflict' },
  );
});

test('autonomous origin requires kernel-recomputed causal separation', async () => {
  const service = makeQuestionService();
  await assert.rejects(service.originate(originateQuestionInput({
    origin: 'wildcard' as never,
  })), /invalid question origin/);
  const result = await service.originate(originateQuestionInput({
    origin: 'default_mode',
    sourceEventIds: ['evt_default_mode_trigger'],
    humanPrincipalTaskGraphRef: ids.objectRef('task-graph-with-equivalent-question'),
  }));
  assert.equal(
    result.question.promptProvenance.originAttestation.payload.classification,
    'human_directed',
  );
});

test('evidence gaps and contradictions can originate autonomous Questions', async () => {
  const service = makeQuestionService();
  const gap = await service.originate(originateQuestionInput({
    origin: 'evidence_gap',
    sourceEventIds: ['evt_review_gap'],
  }));
  const contradiction = await service.originate(originateQuestionInput({
    origin: 'contradiction',
    sourceEventIds: ['evt_contradiction_opened'],
  }));
  assert.equal(
    gap.question.promptProvenance.originAttestation.payload.classification,
    'autonomous',
  );
  assert.equal(
    contradiction.question.promptProvenance.originAttestation.payload.classification,
    'autonomous',
  );
});

test('dormancy requires durable reason and bounded review or expiry', async () => {
  const fixture = await activeQuestionHarness();
  const input = transitionQuestionInputFixture(fixture, {
    expectedStatus: 'active',
    nextStatus: 'dormant',
    rationale: 'Lower priority',
    reviewAt: null,
    expiresAt: null,
  });
  assert.equal(TransitionQuestionInputSchema.safeParse(input).success, true);
  await assert.rejects(
    fixture.service.transition(input),
    /dormancy requires reviewAt or expiresAt/,
  );
});

test('answered question may revive only with a named change event', async () => {
  const fixture = await answeredQuestionHarness();
  const input = transitionQuestionInputFixture(fixture, {
    expectedStatus: 'answered',
    nextStatus: 'revived',
    rationale: 'New corpus snapshot contests the prior answer.',
    requestedByEventId: 'evt_new_snapshot',
  });
  const revived = await fixture.service.transition(input);
  assert.equal(revived.question.status, 'revived');
  assert.deepEqual(revived.eventScope, input.eventScope);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test --import tsx packages/research/test/question-ecology.test.ts
```

Expected: FAIL because `QuestionService` is missing.

- [ ] **Step 3: Implement the closed lifecycle**

Allowed transitions:

```text
new -> active | incubating | abandoned
active -> partially_answered | answered | incubating | dormant | abandoned
incubating -> active | dormant | abandoned
partially_answered -> active | answered | dormant
answered -> revived
dormant -> revived | abandoned
revived -> active | partially_answered | answered | dormant
abandoned -> revived
```

Every transition stores `QuestionMutationProposalPayload` without `questionObjectId`, attaches Program B’s returned object ID, and returns a new immutable `QuestionMutationProposal`. It preserves parentage, origin, prompt provenance, partial answers, failed approaches, and why the Question matters. No transition closes an Expedition or changes a Claim.

Origination and transition both require the exact Program B
`brain_lineage` scope and an idempotency key. The service verifies the requested
event has that scope, `basedOnBrainCommitId` equals the expected Brain, appends
the Question event with the same scope, and copies it into both the mutation
proposal and Question-root update. Exact retry returns the same Question/event/
proposal identities; changed input under the same key conflicts.

`QuestionService.originate` cannot accept an autonomy Boolean from a caller. It stores the proposed prompt, pins the current admitted-event frontier and human/Principal task graph, and asks `CausalOriginAttestor` to recompute ancestry. The attestor traverses admitted source events, parent Questions, Relationship events, current directed Questions/tasks, and canonical prompt hashes. Exact/equivalent human or Principal ancestry yields `human_directed`; missing or mixed ancestry yields `ambiguous`; only a complete causally independent chain yields `autonomous`. The immutable attestation and its kernel version are attached to `PromptProvenance`. Callers may request an origin label, but cannot choose the classification or autonomy credit.

- [ ] **Step 4: Run focused and package tests**

Run:

```bash
node --test --import tsx packages/research/test/question-ecology.test.ts
npm test --workspace @cosmo/research
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/question-service.ts packages/research/src/causal-origin-attestor.ts packages/research/src/index.ts packages/research/test/question-ecology.test.ts
git commit -m "feat(research): establish durable question ecology"
```

### Task 4: Enforce Rolling Autonomy and Build ExpeditionContracts

**Files:**
- Create: `packages/research/src/autonomy-policy.ts`
- Create: `packages/research/src/expedition-service.ts`
- Create: `packages/research/test/autonomy-expedition.test.ts`
- Modify: `packages/research/src/index.ts`

**Interfaces:**
- Consumes: `Question`, `ResearchCovenantPayload`, Program C policy IDs, Program B grants.
- Produces:

```ts
export function validateAllocation(
  allocation: AutonomyAllocation
): AllocationDecision;

export function evaluateRollingAutonomy(
  policy: ResearchCovenantPayload['autonomyPolicy'],
  receipts: readonly LaneUseReceipt[],
  override: DirectedOverride | null,
  now: string
): RollingAutonomyDecision;

export class ExpeditionService {
  build(input: BuildExpeditionInput): Promise<ExpeditionContract>;
}
```

- [ ] **Step 1: Write failing allocation and provenance tests**

```ts
test('allocation must total 100 and active autonomy is adjacent plus wildcard', () => {
  assert.equal(validateAllocation({
    directed: 60,
    adjacent: 20,
    wildcard: 10,
    incubation: 10,
  }).activeAutonomyPercent, 30);
  assert.equal(validateAllocation({
    directed: 60,
    adjacent: 20,
    wildcard: 10,
    incubation: 9,
  }).allowed, false);
});

test('incubation and mislabeled Principal work do not satisfy active autonomy', () => {
  const result = evaluateRollingAutonomy(
    autonomyPolicy({ minimumActiveAutonomyPercent: 20 }),
    [
      laneReceipt({ lane: 'incubation', amount: 30, origin: 'dream' }),
      laneReceipt({
        lane: 'wildcard',
        amount: 20,
        origin: 'principal',
        causalClassification: 'human_directed',
      }),
      laneReceipt({ lane: 'directed', amount: 50, origin: 'human' }),
    ],
    null,
    '2026-07-30T12:00:00.000Z',
  );
  assert.equal(result.activeAutonomyPercent, 0);
  assert.equal(result.allowed, false);
});

test('fully directed mode requires a scoped authenticated expiring override', () => {
  const expired = directedOverrideFixture({
    expiresAt: '2026-07-29T12:00:00.000Z',
  });
  const result = evaluateRollingAutonomy(
    autonomyPolicy(),
    [laneReceipt({ lane: 'directed', amount: 100, origin: 'human' })],
    expired,
    '2026-07-30T12:00:00.000Z',
  );
  assert.equal(result.allowed, false);
  assert.ok(result.reasonCodes.includes('directed_override_expired'));
});

test('ExpeditionContract pins every authority and evidence identity', async () => {
  const expedition = await makeExpeditionService().build(buildExpeditionInput());
  assert.equal(expedition.schema, 'cosmo.expedition.v1');
  assert.match(expedition.expeditionId, /^exp_/);
  assert.deepEqual(expedition.eventScope, buildExpeditionInput().eventScope);
  assert.equal(expedition.corpusSnapshotIds.length, 2);
  assert.ok(expedition.stoppingCriteria.length > 0);
  assert.ok(expedition.honestBlockConditions.length > 0);
});

test('Expedition build is exactly idempotent across the journal boundary', async () => {
  const service = makeExpeditionService();
  const input = buildExpeditionInput({
    idempotencyKey: ids.sha('expedition-build'),
  });
  const first = await service.build(input);
  const second = await service.build(input);
  assert.deepEqual(second, first);
  assert.equal(
    await service.journal.count('research.expedition_proposed', {
      expeditionId: first.expeditionId,
    }),
    1,
  );
  await assert.rejects(
    service.build({
      ...input,
      mission: `${input.mission} changed`,
    }),
    { code: 'idempotency_conflict' },
  );
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test --import tsx packages/research/test/autonomy-expedition.test.ts
```

Expected: FAIL because autonomy and expedition services are missing.

- [ ] **Step 3: Implement rolling accounting and contract construction**

Store each receipt as `LaneUseReceiptPayload` without `laneUseReceiptId`, then attach its content ID. Reject nonpositive amounts and receipts whose `budgetUnit` differs from the Covenant. For deterministic rolling accounting:

1. sort receipts newest-first by `(occurredAt, laneUseReceiptId)`;
2. walk until `rollingBudgetSize` units are covered, clipping the oldest included receipt at the boundary;
3. divide qualified autonomous units by all units in that clipped window;
4. count only `adjacent` and `wildcard` units whose provenance origin is `specialist`, `default_mode`, `dream`, `evidence_gap`, or `contradiction` and whose stored `CausalOriginAttestation` was recomputed by the current kernel as `autonomous`;
5. report directed and incubation units separately; and
6. if the history window is empty, return `window_empty` without fabricating past autonomy and require the proposed Expedition allocation itself to meet the floor.

Never accept a caller-supplied classification as credit. `evaluateRollingAutonomy` resolves every attestation object, recomputes it against the pinned admitted-event range and task-graph object, verifies the attestation kernel version, and grants zero credit for a missing object, stale kernel, unresolved parent, mixed causality, or `ambiguous` result.

Directed work remains guided. A directed override authorizes only its matching `missionHash`, only through `expiresAt`, and only up to `maximumBudget`; consumption beyond that limit is rejected. An override never relabels directed work as autonomy.

`ExpeditionService.build` must:

1. load all parent Questions;
2. validate both the proposed allocation floor and the clipped rolling-history floor (or the explicit empty-window bootstrap rule);
3. validate the exact Covenant commit and policy;
4. call `repository.trust.authorize` for the capability grant;
5. hash the mission from canonical mission/scope bytes;
6. pin Brain, corpus, Covenant, Principal, policy, capability, budget, stopping, and honest-block fields;
7. persist an idempotency intent binding the complete canonical input bytes;
8. store the contract before execution;
9. append `research.expedition_proposed`; and
10. finalize the intent with the contract ref and event ID.

An identical retry resumes or returns that exact stored result without a second
append; changed bytes under the key fail `idempotency_conflict`. It does not
start a runtime and does not advance a Brain ref.

- [ ] **Step 4: Run focused and package tests**

Run:

```bash
node --test --import tsx packages/research/test/autonomy-expedition.test.ts
npm test --workspace @cosmo/research
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/autonomy-policy.ts packages/research/src/expedition-service.ts packages/research/src/index.ts packages/research/test/autonomy-expedition.test.ts
git commit -m "feat(research): protect autonomous expedition capacity"
```

### Task 5: Compose COSMO-Owned ContextBundles

**Files:**
- Create: `packages/research/src/context-bundle-service.ts`
- Create: `packages/research/src/context-renderer.ts`
- Create: `packages/research/test/context-bundle.test.ts`
- Modify: `packages/research/src/index.ts`

**Interfaces:**
- Consumes: pinned Brain projection refs from Program B/E, Program C `UntrustedSourceEnvelope`, Question/Program/Relationship refs.
- Produces:

```ts
export class ContextBundleService {
  create(input: CreateContextBundleInput): Promise<ContextBundle>;
  load(contextBundleId: ObjectId): Promise<ContextBundle>;
}

export function renderContextBundle(
  bundle: ContextBundle,
  units: readonly ResolvedContextUnit[],
  tokenLimit: number
): RenderedContext;
```

- [ ] **Step 1: Write failing semantic ownership tests**

```ts
test('runtime may omit optional units but never mandatory cognition', async () => {
  const bundle = await makeContextBundleService().create(contextBundleInput({
    units: [
      contextUnit({ id: 'question', required: true, maximumTokens: 100 }),
      contextUnit({ id: 'evidence', required: true, maximumTokens: 200 }),
      contextUnit({ id: 'background', required: false, maximumTokens: 500 }),
    ],
  }));
  const rendered = renderContextBundle(bundle, resolveUnits(bundle), 350);
  assert.deepEqual(rendered.receipt.includedUnitIds.sort(), [
    ids.object('evidence'),
    ids.object('question'),
  ].sort());
  assert.deepEqual(rendered.receipt.omittedOptionalUnitIds, [
    ids.object('background'),
  ]);
  assert.equal(rendered.receipt.generatedSummaryUsed, false);
});

test('required overflow requests a COSMO projection and fails honestly', async () => {
  const bundle = await makeContextBundleService().create(contextBundleInput({
    units: [contextUnit({ id: 'required-large', required: true, maximumTokens: 900 })],
  }));
  assert.throws(
    () => renderContextBundle(bundle, resolveUnits(bundle), 400),
    /mandatory context does not fit; COSMO projection required/,
  );
});

test('untrusted source markers survive context rendering', async () => {
  const bundle = await contextBundleWithHostileSource();
  const rendered = renderContextBundle(bundle.bundle, bundle.units, 2000);
  assert.match(rendered.text, /BEGIN UNTRUSTED SOURCE DATA/);
  assert.match(rendered.text, /authority=none/);
  assert.equal(bundle.toolDispatcher.calls.length, 0);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test --import tsx packages/research/test/context-bundle.test.ts
```

Expected: FAIL because the context service and renderer are missing.

- [ ] **Step 3: Implement deterministic selection and rendering**

COSMO supplies already selected `ContextUnit` refs and `RuntimeExecutionPlan`. The runtime can pack optional units by the deterministic order `(required desc, inclusion priority, unitId)` but cannot rewrite, summarize, or replace content. Hash:

- canonical `ContextBundlePayload` → `contextBundleId`;
- final rendered UTF-8 bytes → `renderedContextHash`;
- exact final model input → `modelInputHash` in the runtime receipt.

SDK session history and compaction never enter `ContextUnit[]`. Runtime-produced summaries never flow back as evidence or Brain state.

- [ ] **Step 4: Run focused and package tests**

Run:

```bash
node --test --import tsx packages/research/test/context-bundle.test.ts
npm test --workspace @cosmo/research
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/context-bundle-service.ts packages/research/src/context-renderer.ts packages/research/src/index.ts packages/research/test/context-bundle.test.ts
git commit -m "feat(research): make context composition COSMO-owned"
```

### Task 6: Implement the Durable Principal and Independent Reviewer Roles

**Files:**
- Create: `packages/research/src/principal-service.ts`
- Create: `packages/research/src/principal-researcher.ts`
- Create: `packages/research/test/principal-decisions.test.ts`
- Create: `packages/research/test/principal-researcher.test.ts`
- Create: `packages/runtime/src/principal-research-execution-adapter.ts`
- Create: `packages/runtime/src/independent-candidate-review-execution-adapter.ts`
- Create: `packages/runtime/test/principal-research-execution-adapter.test.ts`
- Create: `packages/runtime/test/independent-candidate-review-execution-adapter.test.ts`
- Modify: `packages/research/src/index.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- `@cosmo/research` consumes: Question state, Program C review and transition
  decisions, Covenant/Relationship state, parent Brain commit, and injected
  contracts-only `PrincipalResearchExecutionPort` and
  `IndependentCandidateReviewExecutionPort`.
- `@cosmo/runtime` consumes: the contracts-only
  `StructuredRoleExecutionPort` and implements the Principal execution port
  without importing `@cosmo/research`.
- Produces:

```ts
export class PrincipalService {
  registerPolicy(input: RegisterPrincipalPolicyInput): Promise<Sha256>;
  proposeExpedition(
    input: ProposeExpeditionInput
  ): Promise<PrincipalDecisionRecording>;
  proposeCandidateDisposition(
    input: ProposeCandidateDispositionInput
  ): Promise<PrincipalDecisionRecording>;
  proposeQuestionTransition(
    input: ProposeQuestionTransitionInput
  ): Promise<PrincipalDecisionRecording>;
  proposeMetabolismDeferral(
    input: ProposeMetabolismDeferralInput
  ): Promise<PrincipalDecisionRecording>;
  reviewResearchProposal(
    input: ReviewPrincipalResearchProposalInput
  ): Promise<PrincipalDecisionRecording>;
}

export class PrincipalResearcher {
  survey(input: PrincipalResearchCycleInput): Promise<PrincipalDecisionRecording>;
}

export class RuntimePrincipalResearchExecutionAdapter
  implements PrincipalResearchExecutionPort {
  propose(
    input: PrincipalResearchExecutionInput
  ): Promise<PrincipalResearchProposalAttempt>;
}

export class RuntimeIndependentCandidateReviewExecutionAdapter
  implements IndependentCandidateReviewExecutionPort {
  review(
    input: IndependentCandidateReviewExecutionInput
  ): Promise<IndependentCandidateReviewAttempt>;
}
```

- [ ] **Step 1: Write failing authority tests**

```ts
test('Principal proposes support only with a qualified transition decision', async () => {
  const service = makePrincipalService();
  await assert.rejects(service.proposeCandidateDisposition({
    schema: 'cosmo.propose-candidate-disposition-input.v1',
    parentBrainCommitId: ids.commit('parent'),
    eventScope: brainLineageEventScopeFixture({
      basedOnBrainCommitId: ids.commit('parent'),
    }),
    principalVersion: ids.sha('principal-v1'),
    candidateRef: objectRef('candidate'),
    candidate: candidateClaimFixture(),
    candidateEventId: 'evt_candidate_admitted',
    evidencePolicyId: ids.object('policy'),
    dispositionKind: 'claim_status',
    transitionDecisionRecording: claimTransitionDecisionRecordingFixture({
      allowed: false,
      reasonCodes: ['entailment_review_failed'],
      requiredReviewFindingIds: [],
      independentSourceGroups: [],
    }),
    desiredDisposition: 'supported',
    rationale: 'The evidence seems persuasive.',
    requestedByEventId: 'evt_candidate_review_requested',
    authorization: mutationAuthorization(),
    idempotencyKey: ids.sha('principal-disposition'),
    proposedAt: '2026-07-30T12:00:00.000Z',
    reviewAt: null,
    expiresAt: null,
  }), /claim transition prerequisites are not satisfied/);
});

test('Principal verifies the exact stored C transition recording', async () => {
  const input = contestedCandidateInput();
  await assert.rejects(
    makePrincipalService().proposeCandidateDisposition({
      ...input,
      transitionDecisionRecording: {
        ...input.transitionDecisionRecording,
        recordRef: objectRef('different-record'),
      },
    }),
    { code: 'claim_transition_recording_identity_mismatch' },
  );
});

test('non-Claim cognition is reviewed without a fabricated Claim decision', async () => {
  const recording = await makePrincipalService().proposeCandidateDisposition(
    cognitiveCandidateDispositionInput({
      candidate: candidateConnectionFixture(),
      desiredDisposition: 'incubating',
    }),
  );
  assert.equal(recording.decision.action, 'incubate_candidate');
  assert.equal(
    'transitionDecisionRecording'
      in cognitiveCandidateDispositionInput({
        candidate: candidateConnectionFixture(),
        desiredDisposition: 'incubating',
      }),
    false,
  );
  assert.equal(recording.decisionRef.objectId, recording.decision.decisionId);
});

test('Principal preserves dissent when reviews disagree', async () => {
  const input = contestedCandidateInput();
  const recording = await makePrincipalService().proposeCandidateDisposition(
    input,
  );
  assert.equal(recording.decision.action, 'contest_candidate');
  assert.equal(recording.decision.reviewFindingIds.length, 2);
  assert.equal(recording.decisionRef.objectId, recording.decision.decisionId);
  assert.deepEqual(recording.event.payloadRef, recording.decisionRef);
  assert.equal(recording.eventRef.mediaType, 'application/vnd.cosmo.cognitive-event+json');
  assert.equal(recording.eventId, recording.event.eventId);
  assert.equal(recording.event.eventType, 'principal_decision_recorded');
  assert.deepEqual(recording.event.scope, input.eventScope);
  assert.notEqual(recording.eventId, input.requestedByEventId);
});

test('Principal cannot advance a Brain ref directly', async () => {
  const spies = repositoryMutationSpies();
  await makePrincipalService(spies.repository).proposeExpedition(
    principalExpeditionInput(),
  );
  assert.equal(spies.commitsCreate.callCount, 0);
  assert.equal(spies.refCompareAndSwap.callCount, 0);
  assert.equal(spies.commitAndAdvance.callCount, 0);
});

test('metabolism deferral requires bounded review or expiry', async () => {
  await assert.rejects(makePrincipalService().proposeMetabolismDeferral(
    proposeMetabolismDeferralInput({
      rationale: 'Continue gathering evidence.',
    reviewAt: null,
    expiresAt: null,
    }),
  ), /deferral requires reviewAt or expiresAt/);
});

test('lead researcher surveys across Questions, Programs, cognition, and unknowns', async () => {
  const execution = recordingPrincipalResearchExecutionPort({
    proposal: crossDomainConnectionProposal(),
  });
  const researcher = makePrincipalResearcher({ execution });
  const cycle = principalResearchCycleInput();
  const recording = await researcher.survey(cycle);
  assert.equal(execution.inputs.length, 1);
  assert.deepEqual(
    execution.inputs[0]?.mutationAuthorization,
    cycle.mutationAuthorization,
  );
  assert.equal(execution.inputs[0]?.survey.questionProjectionRef.objectId,
    ids.object('question-projection'));
  assert.equal(execution.inputs[0]?.survey.cognitionProjectionRef.objectId,
    ids.object('cognition-projection'));
  assert.equal(recording.decision.action, 'propose_cognitive_candidate');
  assert.equal(recording.decision.subjectObjectIds.length >= 2, true);
});

test('Principal survey retry reuses its attempt, scope, and decision event', async () => {
  const harness = principalResearcherHarness({
    proposal: crossDomainConnectionProposal(),
  });
  const first = await harness.researcher.survey(harness.input);
  const retry = await harness.researcher.survey(harness.input);
  assert.deepEqual(retry, first);
  assert.deepEqual(first.event.scope, harness.input.survey.eventScope);
  assert.equal(harness.execution.inputs.length, 1);
  assert.deepEqual(
    harness.principalService.reviewInputs[0],
    {
      schema: 'cosmo.review-principal-research-proposal-input.v1',
      survey: harness.input.survey,
      attempt: harness.attempt,
      requestedByEventId: harness.input.requestedByEventId,
      eventScope: harness.input.survey.eventScope,
      principalVersion: harness.input.principalVersion,
      evidencePolicyId: harness.input.evidencePolicyId,
      requiredReviewFindingIds: harness.input.requiredReviewFindingIds,
      authorization: harness.input.mutationAuthorization,
      idempotencyKey: deriveSubkey(
        harness.input.survey.idempotencyKey,
        'review-principal-research-proposal',
      ),
      reviewedAt: harness.input.reviewedAt,
    },
  );
  assert.deepEqual(
    first.event.causalParentEventIds,
    [harness.input.requestedByEventId],
  );
  await assert.rejects(
    harness.researcher.survey({
      ...harness.input,
      survey: {
        ...harness.input.survey,
        cognitionProjectionRef: objectRef('changed-projection'),
      },
    }),
    { code: 'idempotency_conflict' },
  );
});

test('every lead-researcher proposal preserves its exact semantic action', async () => {
  const cases = [
    [originateQuestionProposal(), 'propose_question_origin'],
    [launchExpeditionProposal(), 'propose_expedition'],
    [crossDomainConnectionProposal(), 'propose_cognitive_candidate'],
    [requestMetabolismProposal(), 'propose_metabolism'],
    [proposeSettlementProposal(), 'propose_program_settlement'],
    [deferResearchDirectionProposal(), 'defer_research_direction'],
  ] as const;
  for (const [proposal, expectedAction] of cases) {
    const harness = principalResearcherHarness({ proposal });
    const recording = await harness.researcher.survey(harness.input);
    assert.equal(recording.decision.action, expectedAction);
    assert.deepEqual(
      recording.decision.principalResearchProposalAttemptRef,
      harness.storedAttemptRef,
    );
    assert.equal(
      recording.decision.surveyContextBundleId,
      harness.input.survey.contextBundle.contextBundleId,
    );
  }
});

test('Principal may propose metabolism but cannot start sleep or write a Brain', async () => {
  const harness = principalResearcherHarness({
    proposal: requestMetabolismProposal(),
  });
  const recording = await harness.researcher.survey(harness.input);
  assert.equal(recording.decision.action, 'propose_metabolism');
  assert.equal(harness.metabolismRunner.runCalls.length, 0);
  assert.equal(harness.lifecycle.enterSleepCalls.length, 0);
  assert.equal(harness.repository.commits.createCalls.length, 0);
  assert.equal(harness.repository.refs.advanceCalls.length, 0);
});

test('Principal output is candidate-only and bound to a real execution receipt', async () => {
  const harness = principalResearcherHarness({
    executionClass: 'live_provider',
  });
  const recording = await harness.researcher.survey(harness.input);
  assert.equal(harness.attempt.receipt.executionClass, 'live_provider');
  assert.equal(harness.attempt.receipt.allowedToolNames.length, 0);
  assert.equal(harness.repository.refs.advanceCalls.length, 0);
  assert.equal(harness.repository.commits.createCalls.length, 0);
  assert.equal(
    recording.decision.parentBrainCommitId,
    harness.input.survey.brainCommitId,
  );
  assert.equal(recording.decisionRef.objectId, recording.decision.decisionId);
});

test('recorded Principal attempts remain attributable but cannot satisfy live acceptance', async () => {
  const attempt = await runtimePrincipalResearchAdapter({
    runtime: recordedConformanceRuntime(),
  }).propose(principalResearchExecutionInputFixture());
  assert.equal(attempt.receipt.executionClass, 'recorded_conformance');
  assert.equal(isLivePrincipalAcceptanceEligible(attempt.receipt), false);
});

test('Principal runtime maps a stored expedition but leaks no authority to model context', async () => {
  const harness = runtimePrincipalResearchAdapterHarness();
  const input = principalResearchExecutionInputFixture();
  const attempt = await harness.adapter.propose(input);
  assert.deepEqual(
    harness.structuredExecution.inputs[0].expeditionRef,
    input.survey.expeditionRef,
  );
  assert.deepEqual(
    harness.structuredExecution.inputs[0].mutationAuthorization,
    input.mutationAuthorization,
  );
  assert.equal(
    harness.structuredExecution.inputs[0].expedition.expeditionId,
    input.survey.expedition.expeditionId,
  );
  const modelContext = JSON.stringify(harness.provider.modelContexts[0]);
  assert.equal(modelContext.includes(input.mutationAuthorization.actorIdentity), false);
  assert.equal(modelContext.includes(input.survey.idempotencyKey), false);
  assert.deepEqual(attempt.receipt.expeditionRef, input.survey.expeditionRef);
});

test('independent reviewer maps one strict structured attempt and receipt', async () => {
  const harness = runtimeIndependentReviewAdapterHarness();
  const input = independentCandidateReviewExecutionInputFixture();
  const attempt = await harness.adapter.review(input);
  assert.deepEqual(harness.structuredExecution.inputs, [input.execution]);
  assert.deepEqual(
    await harness.objects.getTyped(
      attempt.inputRef,
      IndependentCandidateReviewExecutionInputSchema,
    ),
    input,
  );
  assert.deepEqual(
    await harness.objects.getTyped(
      attempt.attemptRef,
      IndependentCandidateReviewAttemptSchema,
    ),
    attempt,
  );
  assert.equal(attempt.receipt.runId, input.execution.runId);
  assert.equal(attempt.receipt.reviewerIdentity, input.reviewerIdentity);
  assert.deepEqual(
    attempt.receipt.runtimeReceiptRef,
    harness.structuredResult.runtimeReceiptRecording.receiptRef,
  );
  assert.deepEqual(attempt.receipt.outputRef, harness.structuredResult.outputRef);
  assert.equal(
    IndependentCandidateReviewProposalSchema.safeParse(attempt.proposal).success,
    true,
  );
});

test('Principal execution cannot smuggle authority or free-form output', async () => {
  const researcher = principalResearcherWithOutput({
    proposalType: 'synthesize_across_program',
    candidate: {
      ...crossDomainConnectionProposal().candidate,
      content: {
        ...crossDomainConnectionProposal().candidate.content,
        capabilityGrantId: ids.object('forged-grant'),
      },
    },
  });
  await assert.rejects(
    researcher.survey(principalResearchCycleInput()),
    { code: 'principal_research_output_invalid' },
  );
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test --import tsx packages/research/test/principal-decisions.test.ts
node --test --import tsx packages/research/test/principal-researcher.test.ts
node --test --import tsx packages/runtime/test/principal-research-execution-adapter.test.ts
```

Expected: FAIL because the Principal admission service, lead-researcher orchestrator, and runtime execution adapter are missing.

- [ ] **Step 3: Implement typed, periodic decisions**

`principalVersion` is the SHA-256 of canonical Principal policy, role,
prompt-policy identity, and declared model class. `PrincipalResearcher` is the
semantic lead researcher: it accepts one strict `PrincipalResearchCycleInput`,
surveys the bounded content-addressed context spanning active Questions,
Research Programs, Relationship/Covenant direction, admitted cognition,
negative knowledge, recent events, novelty, surprise, and contradictions, and
passes only `{survey, mutationAuthorization}` to the injected execution port.
After receiving exactly one strict candidate-only proposal and receipt, it
constructs `ReviewPrincipalResearchProposalInput` by exact field mapping and a
deterministic review subkey, then calls `PrincipalService`. It cannot synthesize
authority or policy, write a Brain, mark a claim true, or bypass review.
The cycle's `requestedByEventId` must already resolve in
`survey.eventScope`; it is copied into the review input and is the sole direct
causal parent of the resulting Principal-decision event.

`RuntimePrincipalResearchExecutionAdapter` receives the already-stored
zero-tool Principal Expedition, exact ContextBundle, RunId, start time,
runtime authorization, and output-schema ref through the survey. It verifies
their role/mission/context/grant pins, maps them plus only the explicit
operational MutationAuthorization into `StructuredRoleExecutionInput`, and
calls the shared contracts-only `StructuredRoleExecutionPort`. It reparses the
returned canonical JSON with `PrincipalResearchProposalSchema`, verifies the
output/schema/runtime refs and hashes, and persists
`PrincipalResearchAttemptReceipt`. It never constructs a missing mission,
budget, ContextBundle, clock value, or authority; never passes mutation
authority/idempotency into the model context; and never calls an SDK directly.
Deterministic/recorded structured execution remains usable for conformance but
cannot satisfy Program G's live Principal trial.

`RuntimeIndependentCandidateReviewExecutionAdapter` uses the same structured
seam with an independent-review role and the D-owned
`IndependentCandidateReviewProposalSchema`. Its input pins the candidate
commit/ref/event, C `ReviewSubject`, exact evidence/policy/scope, reviewer
identity/role, and a complete stored zero-tool execution. It stores both input
and attempt, returns their refs plus the real RuntimeReceipt/output refs, and
never calls Program C itself. `ResearchRuntimeCoordinator` validates reviewer
and run independence, then gives the strict proposal and attempt identity to
Program C's ReviewLedger, which alone assigns the ReviewFinding identity and
qualification. A model response without that stored attempt chain cannot
become a ReviewFindingRecording.

`PrincipalResearchSurveyInput.idempotencyKey` indexes the complete survey,
runtime attempt, proposal review, stored decision, and decision event. Before
running a model, `PrincipalResearcher` recovers an existing identical attempt
or receipt. Its `ReviewPrincipalResearchProposalInput` copies the exact
`survey.eventScope`, uses a deterministic sub-key, and rejects any scope/input
drift. A crash after model output or event append resumes without a second
model call or duplicate Principal event.

A closed mapping preserves what the lead researcher actually proposed:

| `PrincipalResearchProposal.proposalType` | `PrincipalDecision.action` |
| --- | --- |
| `originate_question` | `propose_question_origin` |
| `launch_expedition` | `propose_expedition` |
| `synthesize_across_program` | `propose_cognitive_candidate` |
| `request_metabolism` | `propose_metabolism` |
| `propose_settlement` | `propose_program_settlement` |
| `defer` | `defer_research_direction` |

No row aliases a synthesis to a Claim transition, a new Question to a Question-status transition, a settlement to an immediate stop, or a positive metabolism request to a deferral. Every mapped decision retains the exact stored proposal-attempt ref and survey ContextBundle identity. `propose_metabolism` is candidate-only: Program E may use it as one input to its deterministic trigger policy, but neither D nor the Principal can enter sleep, run metabolism, or advance a Brain ref.

A model turn may suggest a decision, but `PrincipalService` parses the strict proposal, stores `PrincipalDecisionPayload` without `decisionId`, attaches Program B’s returned object ID, and checks:

- parent commit and Principal version are pinned;
- `eventScope.kind === 'brain_lineage'`,
  `eventScope.basedOnBrainCommitId === parentBrainCommitId`, and the requested
  causal event resolves in that exact target-ref/program/lineage/trust scope;
- required policy and reviews exist;
- reviewer identities and attempts are independent;
- for `dispositionKind:'claim_status'`, the exact stored Program C
  `ClaimTransitionDecisionRecording` reparses, all
  record/decision/proposal refs match their canonical bytes, and its decision
  payload allows the proposed Claim status;
- for `dispositionKind:'cognitive_status'`, every exact Program C
  `ReviewFindingRecording` reparses its finding, qualification, event, scope,
  and recorded time; independent-review rules pass, and no Claim-transition
  field is accepted or fabricated;
- grants, budgets, and expiry are current;
- dormancy and deferral include durable rationale plus review/expiry;
- dissenting reviews remain attached; and
- proposal, survey, context, Principal version, execution attempt, and parent Brain pins all agree;
- a decision admitted from the lead-researcher role carries the immutable `principalResearchProposalAttemptRef` and `surveyContextBundleId`; direct non-model policy decisions set both to null, and no caller may claim model-derived judgment without that chain;
- cross-program synthesis names at least two resolvable subjects and declares its novelty basis;
- request-metabolism and settlement proposals remain proposals for Program E/D state machines; and
- no direct repository commit/ref method is called.

Before any downstream action, `PrincipalService` stores the decision payload,
re-reads its `ObjectRef`, appends a distinct `principal_decision_recorded`
`CognitiveEvent` whose causal parent is the request/proposal event, and returns
the exact `PrincipalDecisionRecording`. Its `decisionRef.objectId` equals
`decision.decisionId`; `eventRef` and `event` resolve the exact appended
`principal_decision_recorded` event, `eventId === event.eventId`, and that ID is
never reused from the request. Exact retry returns the same recording.
`PrincipalResearcher`, the D→E coordinator, and lifecycle dispatch pass this
recording intact, so Program E never searches for or infers a Principal object
ref, event object, scope, or event ID.

Principal review occurs at program initialization, expedition proposal, significant evidence/contradiction, budget/stagnation threshold, sleep entry/wake, promotion, merge, artifact release, or human intervention. It is not required synchronously for preauthorized candidate Questions and candidate-only branches.

- [ ] **Step 4: Run focused and package tests**

Run:

```bash
node --test --import tsx packages/research/test/principal-decisions.test.ts
node --test --import tsx packages/research/test/principal-researcher.test.ts
node --test --import tsx packages/runtime/test/principal-research-execution-adapter.test.ts
node --test --import tsx packages/runtime/test/independent-candidate-review-execution-adapter.test.ts
npm test --workspace @cosmo/research
npm test --workspace @cosmo/runtime
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/principal-service.ts packages/research/src/principal-researcher.ts packages/research/src/index.ts packages/research/test/principal-decisions.test.ts packages/research/test/principal-researcher.test.ts packages/runtime/src/principal-research-execution-adapter.ts packages/runtime/src/independent-candidate-review-execution-adapter.ts packages/runtime/src/index.ts packages/runtime/test/principal-research-execution-adapter.test.ts packages/runtime/test/independent-candidate-review-execution-adapter.test.ts
git commit -m "feat(research): constrain Principal to typed proposals"
```

### Task 7: Quarantine and Admit Worker Events

**Files:**
- Create: `packages/runtime/src/runtime-state-store.ts`
- Create: `packages/runtime/src/event-quarantine.ts`
- Create: `packages/runtime/src/event-admission-service.ts`
- Create: `packages/runtime/test/event-admission.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Consumes: Program B objects/journal/trust; Program C source/evidence/candidate/negative-knowledge/experiment services; `ExpeditionContract`; `RuntimeAuthorization`; and the four strict proposal schemas frozen in Task 1.
- Produces:

```ts
export class RuntimeStateStore {
  createRun(state: RuntimeRunState): Promise<void>;
  updateRun(expected: RuntimeRunState, next: RuntimeRunState): Promise<void>;
  getRun(runId: RunId): Promise<RuntimeRunState | null>;
  appendQuarantine(record: QuarantineRecord): Promise<void>;
  readQuarantine(runId: RunId): AsyncIterable<QuarantineRecord>;
  putCheckpoint(bytes: Uint8Array, trust: TrustDescriptor): Promise<ObjectRef>;
}

export class EventQuarantine {
  append(envelope: WorkerEventEnvelope): Promise<QuarantineRecord>;
  markDecision(envelopeId: string, decision: AdmissionDecision): Promise<void>;
}

export class EventAdmissionService {
  admit(input: AdmitCognitiveEventInput): Promise<AdmissionDecision>;
}
```

`AdmitCognitiveEventInputSchema` is the strict discriminated union frozen in Task 1. The worker variant carries the raw envelope, exact current RuntimeAuthorization, remaining budget snapshot, cancellation state, and mutation authorization; it alone must first enter `EventQuarantine`. Human operations must bind an authenticated operation/preview, semantic roles must bind an exact attempt receipt/context/runtime authorization, and kernel events must bind a persisted lifecycle decision. The service's worker canonicalization port returns the exact Program C wrapper union `EvidenceSpan | NegativeKnowledge | ExperimentProtocol | ExperimentObservation`; the admitted `CognitiveEvent.payloadRef` always names that wrapper's stored payload. No producer-supplied canonical ID, raw text, URL, provider response, opaque object, grant, or hidden rationale is retained as a cognitive payload.

- [ ] **Step 1: Write failing admission tests**

```ts
test('raw envelope is durable before cognitive admission', async () => {
  const harness = makeAdmissionHarness();
  const decision = await harness.admission.admit(admitInput(workerEnvelopeFixture()));
  assert.equal(harness.quarantine.records.length, 1);
  assert.equal(decision.status, 'admitted');
  assert.match(decision.eventId ?? '', /^evt_/);
  assert.equal(harness.repository.journal.records.length, 1);
});

test('late event from an old fencing token is rejected but retained operationally', async () => {
  const harness = makeAdmissionHarness({
    currentAuthorization: runtimeAuthorizationFixture({
      branchEpoch: 3,
      fencingToken: 'fence_current',
    }),
  });
  const decision = await harness.admission.admit(admitInput(workerEnvelopeFixture({
    branchEpoch: 2,
    fencingToken: 'fence_old',
  })));
  assert.equal(decision.status, 'rejected');
  assert.ok(decision.reasonCodes.includes('stale_fencing_token'));
  assert.equal(harness.quarantine.records.length, 1);
  assert.equal(harness.repository.journal.records.length, 0);
});

test('duplicate delivery admits at most one cognitive event', async () => {
  const harness = makeAdmissionHarness();
  const envelope = workerEnvelopeFixture({ envelopeId: 'runtime_evt_7' });
  const first = await harness.admission.admit(admitInput(envelope));
  const second = await harness.admission.admit(admitInput(envelope));
  assert.equal(first.status, 'admitted');
  assert.equal(second.status, 'duplicate');
  assert.equal(harness.repository.journal.records.length, 1);
});

test('human and semantic-role events need real source receipts, not fake envelopes', async () => {
  const harness = makeAdmissionHarness();
  const human = await harness.admission.admit(
    admitHumanOperationEventInput({
      eventType: 'relationship_event_recorded',
      previewId: ids.object('preview'),
    }),
  );
  const semantic = await harness.admission.admit(
    admitSemanticRoleEventInput({
      eventType: 'review_recorded',
      role: 'independent_challenger',
      attemptReceiptRef: ids.objectRef('challenge-attempt'),
    }),
  );
  assert.equal(human.cognitiveEvent?.source.kind, 'human_operation');
  assert.equal(semantic.cognitiveEvent?.source.kind, 'semantic_role_attempt');
  assert.equal('admittedFromEnvelopeId' in human.cognitiveEvent!, false);
  assert.equal(harness.quarantine.records.length, 0);
});

test('review, question, and lifecycle events receive distinct causal event IDs', async () => {
  const harness = makeAdmissionHarness();
  const review = await harness.admission.admit(
    admitSemanticRoleEventInput({ eventType: 'review_recorded' }),
  );
  const question = await harness.admission.admit(
    admitSemanticRoleEventInput({
      eventType: 'question_originated',
      causalParentEventIds: [review.eventId!],
    }),
  );
  const lifecycle = await harness.admission.admit(
    admitKernelLifecycleEventInput({
      eventType: 'lifecycle_decision_recorded',
      causalParentEventIds: [question.eventId!],
    }),
  );
  assert.equal(new Set([
    review.eventId,
    question.eventId,
    lifecycle.eventId,
  ]).size, 3);
});

test('arbitrary worker source text cannot cross the strict evidence proposal boundary', async () => {
  const harness = makeAdmissionHarness();
  const decision = await harness.admission.admit(admitInput(workerEnvelopeFixture({
    event: {
      type: 'evidence_span_extracted',
      proposal: {
        workerEvidenceId: 'worker_span_12',
        sourceUrl: 'https://example.test/source',
        text: 'exact excerpt',
      },
    },
  })));
  assert.equal(decision.status, 'rejected');
  assert.equal(harness.corpusCanonicalizationCalls.length, 0);
});

test('a strict extraction proposal is canonicalized by Corpus before admission', async () => {
  const harness = makeAdmissionHarness();
  const decision = await harness.admission.admit(admitInput(workerEnvelopeFixture({
    event: {
      type: 'evidence_span_extracted',
      proposal: {
        schema: 'cosmo.evidence-span-extraction-proposal.v1',
        extractionObjectId: ids.object('extraction'),
        corpusSnapshotId: ids.snapshot('snapshot'),
        sourceObjectId: ids.object('source-bytes'),
        locator: { kind: 'lines', start: 4, end: 6 },
        expectedTextSha256: ids.sha('extracted-text'),
        purpose: 'Test the candidate connection against exact source lines.',
      },
    },
  })));
  assert.equal(decision.status, 'admitted');
  assert.notEqual(
    decision.cognitiveEvent?.payloadRef.objectId,
    ids.object('extraction'),
  );
  assert.equal(harness.corpusCanonicalizationCalls.length, 1);
});

test('progress and model receipts remain operational-only', async () => {
  const harness = makeAdmissionHarness();
  const decision = await harness.admission.admit(admitInput(workerEnvelopeFixture({
    event: { type: 'progress_checkpoint', message: 'searched one source' },
  })));
  assert.equal(decision.status, 'operational_only');
  assert.equal(decision.eventId, null);
});

test('event scope cannot be reassigned across Brain lineages', async () => {
  const harness = makeAdmissionHarness({
    expeditionScope: brainLineageScopeFixture({
      targetRef: 'refs/heads/research-a',
      lineageId: ids.sha('lineage-a'),
    }),
  });
  const input = admitInput(workerEnvelopeFixture());
  await assert.rejects(harness.admission.admit({
    ...input,
    expectedScope: {
      ...input.expectedScope,
      targetRef: 'refs/heads/research-b',
      lineageId: ids.sha('lineage-b'),
    },
  }), { code: 'cognitive_event_scope_mismatch' });
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test --import tsx packages/runtime/test/event-admission.test.ts
```

Expected: FAIL because runtime state, quarantine, and admission services are missing.

- [ ] **Step 3: Implement append-before-admit and deterministic checks**

Runtime state is private installation state under `~/.cosmo/runtime/`, encrypted according to its trust domain, and never included in a Brain commit root. Each append uses length-prefixed canonical JSON plus checksum and `fsync`.

Worker admission order is fixed:

1. append raw envelope to quarantine;
2. parse strict schema;
3. verify adapter and run identity;
4. verify expedition, mission hash, and authorization hash;
5. verify branch epoch and fencing token;
6. verify expiry, remaining budget, and cancellation state;
7. call `repository.trust.authorize`;
8. derive the event's `CognitiveEventScope` from the exact Expedition/Program,
   based-on Brain, target ref, lineage, and trust domain, then reject any
   caller-provided expected scope mismatch;
9. verify source rights and snapshot scope;
10. send source/extraction proposals to Program C for canonical identity;
11. classify operational-only versus cognitive;
12. put the admitted payload through `repository.objects.put(input, { actorIdentity, capabilityGrantId })`;
13. append an exact Program B journal record with a newly assigned `EventId`; and
14. mark the quarantine decision idempotently.

Non-worker admission is also append-before-admit but never fabricates an envelope, Expedition, or Run:

1. resolve the operation, preview, semantic attempt, or lifecycle decision object named by the source variant;
2. validate the source-specific closed event-kind pairing and exact
   context/Brain/Program pins plus the server-derived lineage/ref/trust scope;
3. authorize the mutation and verify the payload object already exists with compatible trust;
4. verify all causal parent events exist and are earlier than the new event;
5. derive a fresh `EventId`, append the exact Program B journal record, and return the admitted `CognitiveEvent`; and
6. index the source identity/idempotency key so replay returns duplicate rather than a second event.

Human operations, Principal/default-mode/dream/challenger turns, review findings, question origins, and lifecycle/metabolism stages therefore have real distinct causal events and formation lineage without pretending to be workers. Hidden reasoning streams, arbitrary transcripts, SDK summaries, and unknown source/event combinations are rejected. A `completion_proposal` is admitted as a program candidate only; it does not close anything.

The repository journal is global, but `CognitiveEvent.scope` is mandatory and
immutable. A Brain commit selects exact new `journalEventIds`; a range alone
never confers membership. Program E may replay only selected events from the
target commit ancestry whose lineage/ref/program/trust scope is admissible for
that transaction, plus explicitly imported parent closures during a verified
union. Interleaved events for another branch or trust domain remain in the
global journal but cannot enter the wrong Brain. `scope.trustDomain` is exactly
the effective `TrustDescriptor.encryptionDomain`, including `null` for
public/plaintext objects; every event payload and protected descendant must be
compatible with it.

- [ ] **Step 4: Run focused and package tests**

Run:

```bash
node --test --import tsx packages/runtime/test/event-admission.test.ts
npm test --workspace @cosmo/runtime
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/runtime-state-store.ts packages/runtime/src/event-quarantine.ts packages/runtime/src/event-admission-service.ts packages/runtime/src/index.ts packages/runtime/test/event-admission.test.ts
git commit -m "feat(runtime): admit and fence cognitive events"
```

### Task 8: Build the Capability-Checked Research Tools and Deterministic Runtime

**Files:**
- Create: `packages/runtime/src/deterministic-conformance-runtime.ts`
- Create: `packages/runtime/test/conformance-runtime.test.ts`
- Create: `packages/runtime/src/structured-output-schema-registry.ts`
- Create: `packages/runtime/test/structured-output-schema-registry.test.ts`
- Create: `packages/runtime/src/research-tool-registry.ts`
- Create: `packages/runtime/src/tools/openai-web-search-discovery.ts`
- Create: `packages/runtime/src/tools/restricted-http-acquisition.ts`
- Create: `packages/runtime/src/tools/experiment-execution.ts`
- Create: `packages/runtime/test/research-tool-registry.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Consumes: frozen `WorkerRuntime`, `RuntimeStateStore`, scripted `ConformanceScenario`.
- Produces:

```ts
export class DeterministicConformanceRuntime implements WorkerRuntime {
  constructor(options: DeterministicConformanceOptions);
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

export class DefaultStructuredOutputSchemaRegistry {
  resolve(
    schemaName: string,
    schemaRef: ObjectRef
  ): Promise<ResolvedStructuredOutputSchema>;
}

export class DefaultResearchToolRegistry implements ResearchToolRegistry {
  resolveAuthorized(
    executionPlan: RuntimeExecutionPlan,
    authorization: RuntimeAuthorization
  ): Promise<ResearchToolDescriptor[]>;
  bindForProvider(
    executionPlan: RuntimeExecutionPlan,
    authorization: RuntimeAuthorization,
    provider: 'openai_responses' | 'deterministic'
  ): Promise<BoundResearchToolSet>;
  invokeLocal(input: ResearchToolInvocationInput): Promise<ResearchToolInvocationReceipt>;
  admitHostedResult(input: HostedResearchToolResult): Promise<ResearchToolInvocationReceipt>;
}

export class RestrictedHttpAcquisitionAdapter {
  retrieve(input: SourceAcquisitionRequest): Promise<RetrievedSourceBytes>;
}
```

- [ ] **Step 1: Write failing capability, discovery, acquisition, and conformance tests**

```ts
test('discovery and acquisition require distinct current capabilities', async () => {
  const fixture = researchToolFixture({
    capabilities: ['source:discover'],
  });
  const bound = await fixture.registry.bindForProvider(
    fixture.executionPlan(['source.discover.web']),
    fixture.authorization,
    'openai_responses',
  );
  assert.deepEqual(bound.descriptors.map(value => value.name), ['source.discover.web']);
  await assert.rejects(
    fixture.registry.invokeLocal(fixture.acquireInvocation()),
    { code: 'research_tool_capability_denied' },
  );
});

test('new evidence travels from hosted discovery through captured Corpus bytes', async () => {
  const fixture = researchToolFixture({
    capabilities: ['source:discover', 'source:acquire'],
    startingCorpusContainsTargetEvidence: false,
  });
  const discoveryReceipt = await fixture.registry.admitHostedResult(
    fixture.hostedWebSearchResult({
      query: 'the open question',
      uri: 'https://sources.example/primary-record',
    }),
  );
  const discovery = await fixture.loadDiscovery(discoveryReceipt);
  const acquisitionReceipt = await fixture.registry.invokeLocal(
    fixture.acquireInvocation({
      discovery,
      uri: discovery.uri,
    }),
  );
  const outcome = await fixture.loadAcquisitionOutcome(acquisitionReceipt);
  assert.equal(
    fixture.startingSnapshot.payload.entries.some(
      value => value.sourceObjectId === outcome.source.sourceObjectId,
    ),
    false,
  );
  assert.equal(
    outcome.corpusSnapshot.payload.entries.some(
      value => value.sourceObjectId === outcome.source.sourceObjectId,
    ),
    true,
  );
  assert.equal(
    outcome.corpusSnapshot.payload.parentSnapshotIds[0],
    fixture.startingSnapshot.corpusSnapshotId,
  );
});

test('restricted acquisition blocks SSRF, secrets, redirect escape, and oversize bytes', async () => {
  const adapter = restrictedHttpFixture();
  for (const uri of [
    'http://example.test/plaintext',
    'https://127.0.0.1/private',
    'https://169.254.169.254/latest/meta-data',
    'file:///etc/passwd',
    'https://user:password@example.test/secret',
  ]) {
    await assert.rejects(adapter.retrieve(sourceAcquisitionRequest({ uri })));
  }
  await assert.rejects(
    adapter.retrieve(sourceAcquisitionRequest({
      uri: 'https://allowed.test/redirect',
      maximumBytes: 1024,
    })),
    { code: 'acquisition_redirect_policy_violation' },
  );
  await assert.rejects(
    adapter.retrieve(sourceAcquisitionRequest({
      uri: 'https://allowed.test/oversize',
      maximumBytes: 1024,
    })),
    { code: 'acquisition_maximum_bytes_exceeded' },
  );
});

test('structured output registry binds name to exact immutable JSON Schema', async () => {
  const fixture = structuredOutputRegistryFixture();
  const resolved = await fixture.registry.resolve(
    fixture.schemaName,
    fixture.schemaRef,
  );
  assert.equal(resolved.schemaName, fixture.schemaName);
  assert.deepEqual(resolved.schemaRef, fixture.schemaRef);
  assert.deepEqual(resolved.parse(fixture.validOutput), fixture.validOutput);
  assert.throws(() => resolved.parse(fixture.invalidOutput));
  await assert.rejects(
    fixture.registry.resolve(fixture.schemaName, objectRef('different-schema')),
    { code: 'structured_output_schema_identity_mismatch' },
  );
});

test('conformance adapter emits deterministic ordered envelopes', async () => {
  const runtime = conformanceRuntime({
    events: [
      candidateEvent('question'),
      candidateEvent('connection'),
      completionProposalEvent(),
    ],
  });
  const firstHandle = await runtime.runMission(
    expeditionFixture(),
    contextBundleFixture(),
    runtimeAuthorizationFixture(),
  );
  const first = await collect(firstHandle.envelopes);
  const replayHandle = await conformanceRuntime({
    events: [
      candidateEvent('question'),
      candidateEvent('connection'),
      completionProposalEvent(),
    ],
  }).runMission(
    expeditionFixture(),
    contextBundleFixture(),
    runtimeAuthorizationFixture(),
  );
  const replay = await collect(replayHandle.envelopes);
  assert.deepEqual(first, replay);
  assert.deepEqual(await firstHandle.completion, await replayHandle.completion);
});

test('pause and resume cross context turnover without duplicating envelopes', async () => {
  const runtime = conformanceRuntime({
    events: [candidateEvent('claim'), candidateEvent('connection')],
    pauseAfterSequence: 0,
  });
  const firstHandle = await runtime.runMission(
    expeditionFixture(),
    contextBundleFixture(),
    runtimeAuthorizationFixture(),
  );
  await collect(firstHandle.envelopes);
  const checkpoint = await runtime.pause('run_fixture');
  const resumedHandle = await runtime.resume(
    checkpoint,
    runtimeAuthorizationFixture({ branchEpoch: 2, fencingToken: 'fence_2' }),
    missionHash(expeditionFixture()),
  );
  const resumed = await collect(resumedHandle.envelopes);
  assert.deepEqual(resumed.map(item => item.sequence), [1]);
  assert.equal(resumed[0].branchEpoch, 2);
});

test('late, duplicate, and lost delivery faults are scriptable', async () => {
  const runtime = conformanceRuntime({
    events: [candidateEvent('claim'), candidateEvent('connection')],
    duplicateSequences: [0],
    withholdSequencesUntilInspect: [1],
    emitLateOldFenceAfterResume: true,
  });
  const events = await runFaultScenario(runtime);
  assert.equal(events.filter(item => item.sequence === 0).length, 2);
  assert.ok(events.some(item => item.fencingToken === 'fence_old'));
  assert.equal((await runtime.inspect('run_fixture')).status, 'completed');
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test --import tsx packages/runtime/test/research-tool-registry.test.ts packages/runtime/test/conformance-runtime.test.ts packages/runtime/test/structured-output-schema-registry.test.ts
```

Expected: FAIL because the registry, real acquisition bridge, and conformance adapter are missing.

- [ ] **Step 3: Implement the concrete research-tool path**

`DefaultResearchToolRegistry` is the sole dispatcher. It loads only descriptor names already frozen in `RuntimeExecutionPlan.allowedToolNames`, resolves the current capability grant through Program B, checks mission hash/epoch/fence/expiry/budget immediately before every call, and emits an immutable `ResearchToolInvocationReceipt` for success, denial, cancellation, and failure. Unknown tools and provider-added tools fail closed. Tool output enters runtime quarantine before any cognitive event.

`DefaultStructuredOutputSchemaRegistry` resolves only immutable canonical JSON
Schema objects by exact `(outputSchemaName, outputSchemaRef)`, verifies the
declared schema identity/hash, compiles a bounded validator without executing
schema-provided code, and caches by ObjectRef. Worker, Principal, reviewer,
dream/default-mode, and inquiry output schemas all use this one registry.

The first production registry contains exactly:

| Name | Capability | Concrete adapter | Result authority |
| --- | --- | --- | --- |
| `source.discover.web` | `source:discover` | OpenAI Agents SDK `webSearchTool()` on the Responses path | Produces only typed `SourceDiscoveryProposal` objects and signed invocation receipts; snippets/citations are not evidence |
| `source.acquire.https` | `source:acquire` | local `RestrictedHttpAcquisitionAdapter` using injected `fetch`/DNS resolver | Streams bounded exact bytes to Program C `CorpusAcquisitionPort`; only the resulting SourceObject/snapshot can feed extraction |
| `experiment.execute.sandbox` | `experiment:execute` | allowlisted, network-off, resource-limited experiment runner | Produces Program C protocol/observation/result refs; simulations remain experimental evidence |

`OpenAiWebSearchDiscoveryAdapter` accepts an injected `HostedWebSearchFactory` in Task 8, so the provider-agnostic registry builds and tests before the SDK dependency exists. Task 10 binds that factory to the official Agents SDK `webSearchTool()` only after registry authorization. `OpenAiAgentsRuntime` records each provider tool call/result and passes it back to `admitHostedResult`; unreceipted hosted results are discarded. It stores canonical query, returned URI/title/snippet, provider call identity, provider/model identity, grant/mission/fence, start/end times, and result hash—never request credentials or hidden model reasoning.

`RestrictedHttpAcquisitionAdapter` allows HTTPS only; resolves all redirect hops; rejects loopback, link-local, private, multicast, local hostname, credential-bearing URI, unsupported port, and DNS rebinding; sends no ambient cookies/authentication; sets a fixed user agent; enforces media types, redirect count, compressed and decompressed byte ceilings, wall deadline, and grant domain allowlist; computes the content hash while streaming; and then calls Program C's `DefaultCorpusAcquisitionBridge`. A grant may narrow but never widen these defaults.

The experiment adapter can execute only a precommitted `ExperimentProtocol`, declared inputs, and allowlisted runtime image. It has no network by default, stores stdout/stderr/result bytes as experimental objects, and records timeout/resource/failure state as `NegativeKnowledge`.

- [ ] **Step 4: Implement scripted runtime state and exact checkpointing**

The adapter:

- never calls a model;
- hashes the canonical scenario, mission, context bundle, and authorization;
- stores the next sequence in runtime-only state;
- reproduces the same envelope bytes for deterministic replay;
- supports duplicate, withheld, malformed, delayed, late-fenced, crash, refusal, timeout, and completion-without-delivery faults;
- serializes checkpoint state without Brain objects; and
- emits model/session compaction fixtures only as operational receipts.

It is a test adapter, not a second production agent framework and not evidence that production runtime replacement works.

- [ ] **Step 5: Run focused and package tests**

Run:

```bash
node --test --import tsx packages/runtime/test/research-tool-registry.test.ts packages/runtime/test/conformance-runtime.test.ts packages/runtime/test/structured-output-schema-registry.test.ts
npm test --workspace @cosmo/runtime
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/deterministic-conformance-runtime.ts packages/runtime/src/structured-output-schema-registry.ts packages/runtime/src/research-tool-registry.ts packages/runtime/src/tools/openai-web-search-discovery.ts packages/runtime/src/tools/restricted-http-acquisition.ts packages/runtime/src/tools/experiment-execution.ts packages/runtime/src/index.ts packages/runtime/test/research-tool-registry.test.ts packages/runtime/test/conformance-runtime.test.ts packages/runtime/test/structured-output-schema-registry.test.ts
git commit -m "feat(runtime): add bounded research tools and conformance adapter"
```

### Task 9: Fence Pause, Resume, Cancel, and Startup Reconciliation

**Files:**
- Create: `packages/runtime/src/runtime-controller.ts`
- Create: `packages/runtime/src/runtime-reconciler.ts`
- Create: `packages/runtime/test/runtime-lifecycle.test.ts`
- Create: `packages/runtime/test/runtime-reconciliation.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Consumes: `WorkerRuntime`, Program B trust/leases, `RuntimeStateStore`, `EventAdmissionService`.
- Produces:

```ts
export class RuntimeController {
  start(input: StartRuntimeInput): Promise<ExpeditionExecutionHandle>;
  pause(input: PauseRuntimeInput): Promise<RuntimeCheckpointRef>;
  resume(input: ResumeRuntimeInput): Promise<ExpeditionExecutionHandle>;
  cancel(input: CancelRuntimeInput): Promise<RuntimeRunState>;
  inspect(runId: RunId): Promise<RuntimeRunState>;
}

export class RuntimeReconciler {
  reconcileAll(inputs: ReconcileRuntimeInput[]): Promise<ReconciliationReceipt[]>;
  reconcile(input: ReconcileRuntimeInput): Promise<ReconciliationReceipt>;
}
```

All five lifecycle schemas come from Task 1. `StartRuntimeInputSchema` requires
the coordinator-persisted RunId, start time, mutation authority, idempotency
key, and exact Expedition/Context/Authorization cross-pins.
`PauseRuntimeInputSchema`, `ResumeRuntimeInputSchema`, and
`CancelRuntimeInputSchema` require fresh mutation authority, exact stored run
identity, an operation time, and a SHA-256 idempotency key; resume additionally
requires a strictly newer branch epoch/fence and the same
adapter/mission/context identities. Actor-only or unauthenticated control is
rejected. `ReconcileRuntimeInputSchema` likewise requires current mutation
authority, an explicit injected time, and a SHA-256 idempotency key for one
stored RunId. Identical start/control replay returns the same state/checkpoint
without repeating the adapter call or journal append; changed bytes under a key
fail `idempotency_conflict`. `ReconciliationReceiptSchema` is the decoded
wrapper over a stored payload without its self-ID; a second reconciliation of
identical state must return `already_reconciled`, point
`duplicateOfReceiptId` to the first receipt, and admit no second completion
event.

- [ ] **Step 1: Write failing lifecycle tests**

```ts
test('resume requires fresh authorization and exact mission hash', async () => {
  const controller = await pausedControllerFixture();
  await assert.rejects(controller.resume({
    schema: 'cosmo.resume-runtime-input.v1',
    checkpoint: controller.checkpoint,
    freshAuthorization: controller.oldAuthorization,
    expectedMissionHash: controller.checkpoint.missionHash,
    mutationAuthorization: mutationAuthorization(),
    idempotencyKey: ids.sha('resume-old-fence'),
    resumedAt: '2026-07-30T12:00:00.000Z',
  }), /fresh branch epoch and fencing token are required/);
  await assert.rejects(controller.resume({
    schema: 'cosmo.resume-runtime-input.v1',
    checkpoint: controller.checkpoint,
    freshAuthorization: controller.freshAuthorization,
    expectedMissionHash: ids.sha('wrong-mission'),
    mutationAuthorization: mutationAuthorization(),
    idempotencyKey: ids.sha('resume-wrong-mission'),
    resumedAt: '2026-07-30T12:00:00.000Z',
  }), /mission hash mismatch/);
});

test('cancel fences every later envelope and does not mark the Question answered', async () => {
  const fixture = await runningControllerFixture();
  await fixture.controller.cancel({
    schema: 'cosmo.cancel-runtime-input.v1',
    runId: fixture.runId,
    reason: 'Human requested stop',
    mutationAuthorization: fixture.humanMutationAuthorization,
    idempotencyKey: ids.sha('cancel-run'),
    cancelledAt: '2026-07-30T12:00:00.000Z',
  });
  const late = await fixture.emitLateEnvelope();
  assert.equal(late.status, 'rejected');
  assert.ok(late.reasonCodes.includes('run_cancelled'));
  assert.equal(fixture.question.status, 'active');
});

test('start and pause replay exact persisted operation identities', async () => {
  const fixture = runtimeLifecycleReplayFixture();
  const start = startRuntimeInput({
    runId: 'run_replay',
    idempotencyKey: ids.sha('start-run-replay'),
    startedAt: '2026-07-30T12:00:00.000Z',
  });
  const firstStart = await fixture.controller.start(start);
  await drain(firstStart.events);
  await firstStart.completion;
  const startCounts = fixture.sideEffectCounts();
  const replayStart = await fixture.controller.start(start);
  await drain(replayStart.events);
  await replayStart.completion;
  assert.deepEqual(fixture.sideEffectCounts(), startCounts);

  const pause = pauseRuntimeInput({
    runId: start.runId,
    mutationAuthorization: start.mutationAuthorization,
    idempotencyKey: ids.sha('pause-run-replay'),
    pausedAt: '2026-07-30T12:05:00.000Z',
  });
  const first = await fixture.controller.pause(pause);
  const second = await fixture.controller.pause(pause);
  assert.deepEqual(second, first);
  await assert.rejects(
    fixture.controller.pause({ ...pause, reason: 'changed' }),
    { code: 'idempotency_conflict' },
  );
});

test('completed-but-undelivered result is admitted exactly once on startup', async () => {
  const fixture = completedUndeliveredFixture();
  const input = reconcileRuntimeInput({
    runId: fixture.runId,
    mutationAuthorization: fixture.startupMutationAuthorization,
    idempotencyKey: ids.sha('reconcile-completed-undelivered'),
    reconciledAt: '2026-07-30T12:10:00.000Z',
  });
  const first = ReconciliationReceiptSchema.parse(
    await fixture.reconciler.reconcile(input),
  );
  const second = ReconciliationReceiptSchema.parse(
    await fixture.reconciler.reconcile(input),
  );
  assert.equal(first.action, 'deliver_completed_result');
  assert.equal(second.action, 'already_reconciled');
  assert.equal(second.duplicateOfReceiptId, first.reconciliationReceiptId);
  assert.equal(fixture.admittedCompletionCount(), 1);
});

test('reconciliation rejects expired or revoked authority before effects', async () => {
  const fixture = completedUndeliveredFixture();
  for (const mutationAuthorization of [
    fixture.expiredMutationAuthorization,
    fixture.revokedMutationAuthorization,
  ]) {
    await assert.rejects(
      fixture.reconciler.reconcile(reconcileRuntimeInput({
        runId: fixture.runId,
        mutationAuthorization,
        idempotencyKey: ids.sha(
          `reconcile-${mutationAuthorization.authorizationId}`,
        ),
        reconciledAt: '2026-07-30T12:10:00.000Z',
      })),
      { code: 'mutation_authorization_invalid' },
    );
  }
  assert.equal(fixture.admittedCompletionCount(), 0);
  assert.equal(fixture.reconciliationReceiptCount(), 0);
});
```

- [ ] **Step 2: Write failing reconciliation matrix tests**

```ts
const cases = [
  ['stale_lease_running_job', 'cancel_and_fence'],
  ['active_lease_missing_job', 'mark_lost_and_preserve_question'],
  ['completed_undelivered', 'deliver_completed_result'],
  ['duplicate_delivery', 'deduplicate'],
  ['paused_authorization_expired', 'remain_paused_require_fresh_authorization'],
] as const;

for (const [fixture, expectedAction] of cases) {
  test(`reconciles ${fixture}`, async () => {
    const harness = reconciliationFixture(fixture);
    const receipt = ReconciliationReceiptSchema.parse(
      await harness.reconciler.reconcile(reconcileRuntimeInput({
        runId: harness.runId,
        mutationAuthorization: harness.startupMutationAuthorization,
        idempotencyKey: ids.sha(`reconcile-${fixture}`),
        reconciledAt: '2026-07-30T12:10:00.000Z',
      })),
    );
    assert.equal(receipt.action, expectedAction);
  });
}
```

- [ ] **Step 3: Run and verify failure**

Run:

```bash
node --test --import tsx packages/runtime/test/runtime-lifecycle.test.ts packages/runtime/test/runtime-reconciliation.test.ts
```

Expected: FAIL because controller and reconciler are missing.

- [ ] **Step 4: Implement compare-before-transition runtime state**

`RuntimeController` state transitions use `RuntimeStateStore.updateRun(expected, next)` and reject stale writers. Before resume, revalidate:

- capability grant and revocation;
- remaining budget and deadline;
- Covenant commit;
- mission hash;
- branch epoch;
- fencing token;
- checkpoint adapter identity; and
- context bundle identity.

Before any start/pause/resume/cancel side effect, persist an intent keyed by the
strict input's idempotency key and canonical bytes. Finalize it with the exact
runtime state, checkpoint, journal event, and terminal RuntimeReceipt refs.
Recovery resumes the unfinished intent at the first absent durable step;
identical replay never generates a new RunId/time or repeats a provider call,
and changed bytes under the key fail closed.

`RuntimeController.start()` and `.resume()` return an
`ExpeditionExecutionHandle`, not a bare stream. Its event iterator can be
consumed while work runs, but its completion promise cannot resolve until the
adapter completion has been schema-validated, the canonical output object and
`RuntimeReceipt` have been stored, and
`RuntimeRunState.terminalRuntimeReceiptRef` has been compare-and-set to that
receipt. The same persisted handle result is returned on exact replay. A crash
after provider completion but before consumer delivery leaves
`completionDelivered:false`; reconciliation redelivers the stored receipt
exactly once without re-running the provider.

Cancel first persists `cancelled`, releases or expires the Program B lease, advances the local branch epoch/fence, then calls the adapter. A late adapter result can remain in quarantine but cannot enter cognitive admission.

`RuntimeReconciler` runs on startup, inspects every nonterminal local run through `WorkerRuntime.inspect`, and emits a typed receipt. It never infers completion from an artifact or output file.
The composition root supplies one strict `ReconcileRuntimeInput` per discovered
run, with current mutation authority, an injected reconciliation time, and a
stable idempotency key derived from the run plus the observed durable state
hash. `reconcileAll()` accepts that explicit list; neither reconciler method
manufactures authority, wall-clock time, or operation identity. Expired or
revoked authority fails before adapter inspection, journal admission, or
receipt storage.

- [ ] **Step 5: Run focused and package tests**

Run:

```bash
node --test --import tsx packages/runtime/test/runtime-lifecycle.test.ts packages/runtime/test/runtime-reconciliation.test.ts
npm test --workspace @cosmo/runtime
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime/src/runtime-controller.ts packages/runtime/src/runtime-reconciler.ts packages/runtime/src/index.ts packages/runtime/test/runtime-lifecycle.test.ts packages/runtime/test/runtime-reconciliation.test.ts
git commit -m "feat(runtime): fence lifecycle and reconcile interrupted runs"
```

### Task 10: Implement the Production OpenAI Agents SDK Adapter

**Files:**
- Modify: `packages/runtime/package.json`
- Modify: `package-lock.json`
- Create: `packages/runtime/src/openai/openai-agent-factory.ts`
- Create: `packages/runtime/src/openai/openai-agents-runtime.ts`
- Create: `packages/runtime/src/openai/openai-runtime-receipts.ts`
- Modify: `packages/runtime/src/tools/openai-web-search-discovery.ts`
- Create: `packages/runtime/test/openai-agents-runtime.test.ts`
- Create: `packages/runtime/test/openai-agents-runtime.live.test.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- Consumes: frozen `WorkerRuntime`, `RuntimeExecutionPlan`,
  `RenderedContext`, `RuntimeStateStore`, and the exact
  `ResearchToolRegistry` plus `DefaultStructuredOutputSchemaRegistry` from
  Task 8.
- Produces:

```ts
export class OpenAiAgentsRuntime implements WorkerRuntime {
  constructor(options: OpenAiAgentsRuntimeOptions);
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

Official behavior references:

- [Running agents](https://openai.github.io/openai-agents-js/guides/running-agents/)
- [Sessions](https://openai.github.io/openai-agents-js/guides/sessions/)
- [Human-in-the-loop and RunState](https://openai.github.io/openai-agents-js/guides/human-in-the-loop/)
- [Structured output](https://openai.github.io/openai-agents-js/guides/agents/)
- [Hosted and function tools](https://openai.github.io/openai-agents-js/guides/tools/)
- [Tracing and sensitive data](https://openai.github.io/openai-agents-js/guides/tracing/)

- [ ] **Step 1: Add the exact production dependencies**

Run:

```bash
npm install --workspace @cosmo/runtime --save-exact @openai/agents@0.14.1 zod@4.4.3
```

Expected: `packages/runtime/package.json` and root `package-lock.json` pin those exact versions. No API call occurs. Commit the pinned dependency immediately so the lockfile change is committed before later steps run tests:

```bash
git add packages/runtime/package.json package-lock.json && git commit -m "chore(runtime): pin agents sdk"
```

- [ ] **Step 2: Write the failing mocked-adapter tests**

```ts
test('adapter uses COSMO instructions and Zod 4 worker output', async () => {
  const sdk = fakeAgentsSdk({
    finalOutput: {
      schema: 'cosmo.worker-output-batch.v1',
      events: [{ type: 'candidate_finding', finding: candidateFindingFixture() }],
    },
  });
  const runtime = makeOpenAiRuntime({ sdk });
  const handle = await runtime.runMission(
    expeditionFixture(),
    contextBundleFixture(),
    runtimeAuthorizationFixture(),
  );
  const events = await collect(handle.envelopes);
  const completion = await handle.completion;
  assert.equal(sdk.createdAgents.length, 1);
  assert.equal(sdk.createdAgents[0].instructions, resolvedCosmoInstructions());
  assert.equal(sdk.createdAgents[0].outputType, WorkerOutputBatchSchema);
  assert.equal(events[0].event.type, 'candidate_finding');
  assert.equal(completion.outputSchemaName, 'cosmo.worker-output-batch.v1');
});

test('adapter resolves arbitrary owner output only from the pinned schema ref', async () => {
  const schemaRegistry = structuredOutputRegistryFixture({
    schemaName: 'cosmo.principal-research-proposal.v1',
    validator: PrincipalResearchProposalSchema,
  });
  const sdk = fakeAgentsSdk({ finalOutput: crossDomainConnectionProposal() });
  const runtime = makeOpenAiRuntime({ sdk, schemaRegistry });
  const context = contextBundleFixture({
    executionPlan: runtimeExecutionPlanFixture({
      outputSchemaName: schemaRegistry.schemaName,
      outputSchemaRef: schemaRegistry.schemaRef,
    }),
  });
  const handle = await runtime.runMission(
    expeditionFixture(),
    context,
    runtimeAuthorizationFixture(),
  );
  assert.deepEqual(sdk.createdAgents[0].outputType, schemaRegistry.validator);
  assert.deepEqual((await handle.completion).output,
    crossDomainConnectionProposal());
  await assert.rejects(makeOpenAiRuntime({
    sdk,
    schemaRegistry,
  }).runMission(
    expeditionFixture(),
    contextBundleFixture({
      executionPlan: {
        ...context.payload.executionPlan,
        outputSchemaRef: objectRef('wrong-schema'),
      },
    }),
    runtimeAuthorizationFixture(),
  ), { code: 'structured_output_schema_identity_mismatch' });
});

test('adapter excludes sensitive trace payloads and emits COSMO receipt', async () => {
  const sdk = fakeAgentsSdk();
  const runtime = makeOpenAiRuntime({ sdk });
  const handle = await runtime.runMission(
    expeditionFixture(),
    contextBundleFixture(),
    runtimeAuthorizationFixture(),
  );
  await collect(handle.envelopes);
  const completion = await handle.completion;
  assert.equal(sdk.runCalls[0].options.traceIncludeSensitiveData, false);
  assert.equal(completion.contextBundleId, contextBundleFixture().contextBundleId);
  assert.equal(completion.provider, 'openai');
  assert.equal(completion.executionClass, 'mock');
  assert.equal(completion.providerFallback, null);
});

test('SDK session state, previousResponseId, and RunState never enter Brain or cognitive events', async () => {
  const sdk = fakeAgentsSdk({
    previousResponseId: 'resp_runtime_only',
    serializedRunState: '{"sdk":"runtime-only"}',
  });
  const spies = authorityBoundarySpies();
  const runtime = makeOpenAiRuntime({ sdk, stateStore: spies.stateStore });
  const handle = await runtime.runMission(
    expeditionFixture(),
    contextBundleFixture(),
    runtimeAuthorizationFixture(),
  );
  const events = await collect(handle.envelopes);
  assert.equal(spies.stateStore.contains('resp_runtime_only'), true);
  assert.equal(JSON.stringify(events).includes('resp_runtime_only'), false);
  assert.equal(spies.brainObjectWritesContaining('runtime-only'), 0);
});

test('SDK handoff cannot change Principal, Question, role, or promotion authority', async () => {
  const sdk = fakeAgentsSdk({ emitHandoff: 'unexpected_agent' });
  const runtime = makeOpenAiRuntime({ sdk });
  const handle = await runtime.runMission(
    expeditionFixture(),
    contextBundleFixture(),
    runtimeAuthorizationFixture(),
  );
  const events = await collect(handle.envelopes);
  assert.ok(events.some(event =>
    event.event.type === 'failure'
    && event.event.code === 'undeclared_sdk_handoff',
  ));
});
```

- [ ] **Step 3: Run and verify failure**

Run:

```bash
node --test --import tsx packages/runtime/test/openai-agents-runtime.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 4: Implement one bounded SDK agent per COSMO execution plan**

Use `Agent` with Zod 4 structured output and a reusable `Runner`. COSMO resolves `instructionsRef`, role, perspective, handoff purpose, tool names, and context before calling the adapter. `OpenAiAgentsRuntime` obtains the tool list only from `ResearchToolRegistry.bindForProvider(...)`; it must not construct `webSearchTool()` or any function tool directly. Every hosted result returns through `admitHostedResult`, and every local acquisition/experiment call returns through `invokeLocal`, before a worker envelope can be emitted.

Core construction resolves the output validator from the exact stored schema
before creating the Agent:

```ts
const resolvedOutput = await structuredOutputSchemas.resolve(
  executionPlan.outputSchemaName,
  executionPlan.outputSchemaRef,
);
const agent = new Agent({
  name: executionPlan.roleName,
  instructions: cosmoAuthoredInstructions,
  model: options.model,
  tools: boundResearchTools.providerTools,
  outputType: resolvedOutput.providerOutputType,
});

const result = await runner.run(agent, rendered.text, {
  maxTurns: boundedMaxTurns(mission.budget),
  signal: abortController.signal,
  traceIncludeSensitiveData: false,
  workflowName: 'COSMO Expedition',
  groupId: mission.expeditionId,
  traceMetadata: {
    runId,
    expeditionId: mission.expeditionId,
    contextBundleId: context.contextBundleId,
  },
});
const canonicalOutput = resolvedOutput.parse(result.finalOutput);
```

Only a plan naming `cosmo.worker-output-batch.v1` may turn its parsed events
into worker envelopes. Every other owner schema produces zero worker envelopes
and returns its canonical JSON only through `RuntimeAdapterCompletion`; the
controller stores it with the recomputed effective `outputTrust` before
resolving the completion handle.

Do not use SDK handoffs to decide specialist routing or cognitive authority. If a declared SDK handoff is later used for transport, it must match a COSMO-authored recipient and purpose already present in `RuntimeExecutionPlan`; its result remains a worker envelope.

Use one conversation-state strategy per attempt. For this adapter:

- normal response continuation uses `previousResponseId`;
- approval interruption serializes `RunState.toString()` without tracing credentials;
- resume rebuilds the exact versioned agent graph and uses `RunState.fromStringWithContext`;
- SDK state is stored only through `RuntimeStateStore`;
- SDK history compaction is working-memory maintenance and emits only a runtime receipt;
- no SDK history or compaction result is supplied to Program C or E as cognition.

Persist `@openai/agents` version, agent-graph version, provider, model, transport, previous response ID, serialized RunState ref, trace ID, usage, context hashes, declared omissions, and fallback in runtime-only state/receipts. Use `AbortController` for cancellation. Never log prompt/source payloads through tracing; set `traceIncludeSensitiveData: false` on every run.

- [ ] **Step 5: Run mocked adapter and all runtime tests**

Run:

```bash
node --test --import tsx packages/runtime/test/openai-agents-runtime.test.ts
npm test --workspace @cosmo/runtime
```

Expected: PASS without network access and without any credential.

- [ ] **Step 6: Add an explicitly gated real-API smoke test**

The live test must skip unless `COSMO_OPENAI_LIVE=1`. It sends a tiny bounded mission, requires one Zod-valid `candidate_finding`, requires `RuntimeReceipt.executionClass === 'live_provider'`, records provider/model/trace metadata without payload content, then cancels a second run and proves late admission is fenced. Adapter constructors cannot choose this class directly: the receipt factory derives it from the concrete transport plus test-double/recording markers and refuses `live_provider` when an injected SDK, recorded response, replay file, or mock transport is present.

Before executing the live test, invoke the `openai-developers:openai-platform-api-key` credential gate. Do not write setup commands, inspect a key, print a key, copy a key into a file, or commit a credential. If the secure gate is not authorized, leave the live test skipped and record that it was not executed.

After the secure gate succeeds, run:

```bash
COSMO_OPENAI_LIVE=1 node --test --import tsx packages/runtime/test/openai-agents-runtime.live.test.ts
```

Expected: PASS with one structured candidate and one fenced cancellation; test output contains no secret or prompt/source payload.

- [ ] **Step 7: Commit**

```bash
git add packages/runtime/package.json package-lock.json packages/runtime/src/openai/openai-agent-factory.ts packages/runtime/src/openai/openai-agents-runtime.ts packages/runtime/src/openai/openai-runtime-receipts.ts packages/runtime/src/tools/openai-web-search-discovery.ts packages/runtime/src/index.ts packages/runtime/test/openai-agents-runtime.test.ts packages/runtime/test/openai-agents-runtime.live.test.ts
git commit -m "feat(runtime): add production OpenAI Agents adapter"
```

Program D is still not accepted as COSMO after this task. A working model adapter is commodity execution, not a Living Brain.

### Task 11: Wire the Research Runtime Flow and Program E Port

**Files:**
- Create: `packages/research/src/research-runtime-coordinator.ts`
- Create: `packages/research/src/d-e-vertical-gate.ts`
- Create: `packages/research/test/research-runtime-coordinator.test.ts`
- Create: `packages/runtime/src/runtime-expedition-execution-adapter.ts`
- Create: `packages/runtime/src/runtime-structured-role-execution-adapter.ts`
- Create: `packages/runtime/src/runtime-program-control-adapter.ts`
- Create: `packages/runtime/test/runtime-port-adapters.test.ts`
- Create: `packages/runtime/test/runtime-structured-role-execution-adapter.test.ts`
- Modify: `packages/research/src/index.ts`
- Modify: `packages/runtime/src/index.ts`

**Interfaces:**
- `@cosmo/research` consumes: `QuestionService`, `ExpeditionService`, `PrincipalService`, Program C `CorpusAcquisitionPort`, and the contracts-only `ExpeditionExecutionPort`.
- `@cosmo/runtime` consumes: `RuntimeController`, `RuntimeReconciler`, and `EventAdmissionService`, then implements the contracts-only `ExpeditionExecutionPort` and `ProgramRunControlPort`.
- Neither workspace imports the other's concrete classes. Program H's composition root injects the runtime adapters into the Research Program service and Research Runtime coordinator.
- Produces:

```ts
export class ResearchRuntimeCoordinator implements DEVerticalGateResearchPort {
  originateQuestion(input: OriginateQuestionInput): Promise<QuestionMutationProposal>;
  buildExpedition(input: BuildExpeditionInput): Promise<ExpeditionContract>;
  executeExpedition(
    input: ExecuteExpeditionInput
  ): Promise<ExpeditionExecutionHandle>;
  proposeCandidateDisposition(
    input: ProposeCandidateDispositionInput
  ): Promise<PrincipalDecisionRecording>;
  runCandidateResearchPhase(
    input: DEVerticalGateInput
  ): Promise<DEVerticalGateResearchReceipt>;
  reviewCommittedCandidate(
    input: DECommittedCandidateReviewInput
  ): Promise<DECommittedCandidateReviewReceipt>;
}

export class RuntimeExpeditionExecutionAdapter implements ExpeditionExecutionPort {
  execute(input: ExecuteExpeditionInput): Promise<ExpeditionExecutionHandle>;
}

export class RuntimeStructuredRoleExecutionAdapter
  implements StructuredRoleExecutionPort {
  execute(
    input: StructuredRoleExecutionInput
  ): Promise<StructuredRoleExecutionResult>;
}

export class RuntimeProgramControlAdapter implements ProgramRunControlPort {
  pauseRuns(
    input: ProgramRunControlInput
  ): Promise<RuntimeCheckpointRef[]>;
  cancelRuns(input: ProgramRunControlInput): Promise<RunId[]>;
  assertNoActiveRuns(runIds: RunId[]): Promise<void>;
}
```

- [ ] **Step 1: Write the failing deterministic research-phase test**

```ts
test('D candidate phase preserves autonomous provenance before review', async () => {
  const coordinator = makeResearchRuntimeCoordinator({
    runtime: conformanceRuntime({
      events: [
        candidateEvent('question', { origin: 'default_mode' }),
        candidateEvent('connection', { origin: 'specialist' }),
        completionProposalEvent(),
      ],
      crashAfterSequence: 0,
      emitLateOldFenceAfterResume: true,
    }),
  });
  const receipt = await coordinator.runCandidateResearchPhase(verticalGateInput());

  assert.equal(receipt.promptProvenance.origin, 'default_mode');
  assert.equal(
    receipt.promptProvenance.originAttestation.payload.classification,
    'autonomous',
  );
  assert.ok(receipt.admittedEventIds.length >= 2);
  assert.equal(receipt.admittedCandidates.every(({ event }) =>
    event.scope.kind === 'brain_lineage'
      && event.scope.basedOnBrainCommitId === receipt.startingBrainCommitId
      && event.scope.targetRef === verticalGateInput().candidateBranchRef
      && event.scope.lineageId === verticalGateInput().lineageId
      && event.scope.trustDomain === verticalGateInput().trustDomain
  ), true);
  assert.equal(receipt.forcedRestartObserved, true);
  assert.equal(receipt.contextTurnoverObserved, true);
  assert.equal(receipt.lateFencedEventRejected, true);
  assert.equal(receipt.admittedCandidates.length >= 1, true);
  assert.equal('principalDecisionRef' in receipt, false);
  assert.equal('reviewFindingIds' in receipt, false);
  assert.equal(receipt.cosmoAccepted, false);
  assert.equal(receipt.blockedOn, 'program-e-living-brain-metabolism');
});

test('runtime completion proposal does not answer the Question', async () => {
  const fixture = await runCandidateResearchPhaseFixture();
  assert.equal(fixture.runtimeState.status, 'completed');
  assert.equal(fixture.question.status, 'active');
  assert.equal(fixture.brainRef, fixture.startingBrainCommitId);
});

test('research phase can discover and acquire evidence absent from its starting Corpus', async () => {
  const fixture = await newEvidenceResearchPhaseFixture({
    startingCorpusContainsTargetEvidence: false,
  });
  const receipt = await fixture.coordinator.runCandidateResearchPhase(fixture.input);
  assert.deepEqual(receipt.researchToolReceiptIds.length >= 2, true);
  assert.notEqual(receipt.endingCorpusSnapshotId, fixture.startingCorpusSnapshotId);
  assert.equal(receipt.acquiredSourceObjectIds.length, 1);
  assert.equal(receipt.evidenceSpanIds.length, 1);
  assert.deepEqual(
    receipt.corpusRootMutationBatchRecording.orderedCauseEventIds,
    fixture.expectedOrderedCauseEventIds,
  );
  assert.equal(
    receipt.corpusRootMutationBatchRecording.epistemic.proposal.update
      .changedObjectRefs.some((ref) =>
        ref.objectId === receipt.evidenceSpanIds[0]),
    true,
  );
  assert.equal(receipt.discoveryProposalCreditedAsEvidence, false);
  assert.equal(receipt.toolReceiptCreditedAsEvidence, false);
});

test('research receipt closes admitted worker events over immutable execution provenance', async () => {
  const fixture = await runCandidateResearchPhaseFixture();
  const receipt = fixture.receipt;
  const runtimeReceipts = await Promise.all(
    receipt.runtimeReceiptRefs.map(ref =>
      fixture.objects.getTyped(ref, RuntimeReceiptSchema)),
  );
  const admittedEvents = await fixture.journal.getMany(receipt.admittedEventIds);
  const workerEvents = admittedEvents.filter(
    event => event.source.kind === 'worker_envelope',
  );

  assert.ok(runtimeReceipts.length > 0);
  for (const event of workerEvents) {
    const matches = runtimeReceipts.filter(runtime =>
      runtime.runId === event.source.runId
        && runtime.expeditionId === event.source.expeditionId,
    );
    assert.equal(matches.length, 1);
    const bundle = await fixture.objects.getTyped(
      matches[0].contextBundleRef,
      ContextBundleSchema,
    );
    assert.equal(bundle.contextBundleId, matches[0].contextBundleId);
    assert.equal(bundle.payload.brainCommitId, receipt.startingBrainCommitId);
  }
  const toolReceipts = await fixture.objects.getManyTyped(
    receipt.researchToolReceiptIds,
    ResearchToolInvocationReceiptSchema,
  );
  assert.equal(toolReceipts.every(tool =>
    runtimeReceipts.some(runtime =>
      runtime.runId === tool.payload.runId
        && runtime.expeditionId === tool.payload.expeditionId,
    ),
  ), true);
  assert.deepEqual(
    [...new Set(receipt.runtimeReceiptRefs.map(canonicalObjectRefKey))].sort(),
    receipt.runtimeReceiptRefs.map(canonicalObjectRefKey),
  );
});

test('candidate research phase replays the complete operation exactly once', async () => {
  const fixture = candidateResearchReplayFixture();
  const input = verticalGateInput({
    mutationAuthorization: fixture.authorization,
    idempotencyKey: ids.sha('candidate-research-phase'),
  });
  const first = await fixture.coordinator.runCandidateResearchPhase(input);
  const counts = fixture.sideEffectCounts();
  const second = await fixture.coordinator.runCandidateResearchPhase(input);
  assert.deepEqual(second, first);
  assert.deepEqual(fixture.sideEffectCounts(), counts);
  await assert.rejects(
    fixture.coordinator.runCandidateResearchPhase({
      ...input,
      principalVersion: ids.sha('changed-principal'),
    }),
    { code: 'idempotency_conflict' },
  );
});

test('D receipt cannot contain a wake commit or formation query', async () => {
  const receipt = await runCandidateResearchPhaseFixture().then(
    value => value.receipt,
  );
  assert.equal('wakeBrainCommitId' in receipt, false);
  assert.equal('formationTrace' in receipt, false);
});

test('independent review and Principal disposition occur only after candidate commit', async () => {
  const fixture = await committedCandidateReviewFixture();
  const receipt = await fixture.coordinator.reviewCommittedCandidate(
    fixture.input,
  );
  assert.equal(receipt.originKind, 'autonomous_research');
  assert.equal(fixture.input.originKind, 'autonomous_research');
  if (
    receipt.originKind !== 'autonomous_research'
    || fixture.input.originKind !== 'autonomous_research'
  ) {
    throw new Error('fixture must exercise autonomous research provenance');
  }
  assert.deepEqual(
    receipt.researchReceiptRef,
    fixture.input.researchReceiptRef,
  );
  assert.equal(
    fixture.candidateCommit.createdAt
      < receipt.reviewCompletionRecording.event.occurredAt,
    true,
  );
  assert.equal(
    receipt.principalDecisionRecording.decision.parentBrainCommitId,
    fixture.candidateBrainCommitId,
  );
  const expectedReviewScope = {
    kind: 'brain_lineage',
    basedOnBrainCommitId: fixture.candidateBrainCommitId,
    targetRef: fixture.canonicalTargetRef,
    programId: fixture.candidateEvent.scope.programId,
    lineageId: fixture.candidateEvent.scope.lineageId,
    trustDomain: fixture.candidateEvent.scope.trustDomain,
  } as const;
  assert.deepEqual(receipt.reviewScope, expectedReviewScope);
  assert.equal(
    receipt.reviewCompletionRecording.event.eventType,
    'candidate_review_completed',
  );
  assert.deepEqual(
    receipt.reviewCompletionRecording.event.scope,
    expectedReviewScope,
  );
  assert.deepEqual(
    receipt.reviewCompletionRecording.event.payloadRef,
    receipt.reviewCompletionRecording.completionRef,
  );
  assert.deepEqual(
    await fixture.objects.getTyped(
      receipt.reviewCompletionRecording.completionRef,
      CandidateReviewCompletionPayloadSchema,
    ),
    receipt.reviewCompletionRecording.completion,
  );
  assert.deepEqual(
    receipt.reviewCompletionRecording.completion
      .independentReviewAttemptRefs,
    receipt.independentReviewAttemptRefs,
  );
  assert.deepEqual(
    receipt.reviewCompletionRecording.completion.reviewFindingRecordingRefs,
    receipt.reviewFindingRecordingRefs,
  );
  assert.deepEqual(
    receipt.reviewCompletionRecording.completion.scope,
    expectedReviewScope,
  );
  assert.deepEqual(
    receipt.reviewCompletionRecording.event.causalParentEventIds,
    [
      ...receipt.reviewFindingRecordings.map(recording => recording.eventId),
      ...(receipt.claimTransitionDecisionRecording === null
        ? []
        : [receipt.claimTransitionDecisionRecording.record.decisionEventId]),
    ],
  );
  assert.ok(receipt.reviewFindingRecordings.length > 0);
  assert.equal(
    fixture.independentReview.inputs.length,
    fixture.input.independentReviewInputs.length,
  );
  assert.equal(
    receipt.independentReviewAttempts.length,
    fixture.input.independentReviewInputs.length,
  );
  for (const [index, attempt] of
    receipt.independentReviewAttempts.entries()) {
    const reviewInput = fixture.input.independentReviewInputs[index]!;
    const recording = receipt.reviewFindingRecordings.find(
      candidate =>
        candidate.qualification.attemptId === attempt.receipt.runId,
    );
    assert.ok(recording);
    assert.equal(attempt.receipt.reviewerIdentity, reviewInput.reviewerIdentity);
    assert.equal(recording.qualification.reviewerIdentity,
      attempt.receipt.reviewerIdentity);
    assert.deepEqual(recording.qualification.runtimeReceiptRef,
      attempt.receipt.runtimeReceiptRef);
    assert.equal(recording.qualification.providerFamily,
      attempt.receipt.provider);
    assert.equal(recording.qualification.modelFamily, attempt.receipt.model);
    assert.deepEqual(
      await fixture.objects.getTyped(
        receipt.independentReviewAttemptRefs[index]!,
        IndependentCandidateReviewAttemptSchema,
      ),
      attempt,
    );
    assert.deepEqual(
      await fixture.objects.getTyped(
        receipt.reviewFindingRecordingRefs[index]!,
        ReviewFindingRecordingSchema,
      ),
      receipt.reviewFindingRecordings[index],
    );
  }
  const generatorRuntimeReceipts = await Promise.all(
    fixture.input.researchReceipt.runtimeReceiptRefs.map(ref =>
      fixture.objects.getTyped(ref, RuntimeReceiptSchema)),
  );
  const generatorRunIds = new Set(
    generatorRuntimeReceipts.map(runtime => runtime.runId),
  );
  const generatorRoleIds = new Set(
    await Promise.all(generatorRuntimeReceipts.map(async runtime =>
      fixture.objects.getTyped(
        runtime.contextBundleRef,
        ContextBundleSchema,
      ).then(context => context.payload.executionPlan.roleId))),
  );
  assert.equal(receipt.independentReviewAttempts.every(attempt =>
    !generatorRunIds.has(attempt.receipt.runId)
      && !generatorRoleIds.has(
        attempt.receipt.reviewerRoleDefinitionRef.objectId,
      ),
  ), true);
  assert.equal(receipt.reviewFindingRecordings.every(
    (recording) => canonicalEqual(recording.scope, expectedReviewScope)
      && recording.eventId !== fixture.candidateEventId
      && recording.recordedAt >= fixture.candidateCommit.createdAt,
  ), true);
  assert.deepEqual(
    receipt.principalDecisionRecording.event.scope,
    expectedReviewScope,
  );
  assert.deepEqual(
    [...receipt.principalDecisionRecording.decision.reviewFindingIds].sort(),
    receipt.reviewFindingRecordings
      .map(recording => recording.finding.reviewFindingId)
      .sort(),
  );
  assert.equal(
    receipt.claimTransitionDecisionRecording === null
      || canonicalEqual(
        receipt.claimTransitionDecisionRecording.scope,
        expectedReviewScope,
      ),
    true,
  );
  assert.deepEqual(await fixture.journal.orderOf([
    fixture.candidateEventId,
    ...receipt.reviewFindingRecordings.map(recording => recording.eventId),
    ...(receipt.claimTransitionDecisionRecording === null
      ? []
      : [receipt.claimTransitionDecisionRecording.record.decisionEventId]),
    receipt.reviewCompletionRecording.eventId,
    receipt.principalDecisionRecording.eventId,
  ]), [
    fixture.candidateEventId,
    ...receipt.reviewFindingRecordings.map(recording => recording.eventId),
    ...(receipt.claimTransitionDecisionRecording === null
      ? []
      : [receipt.claimTransitionDecisionRecording.record.decisionEventId]),
    receipt.reviewCompletionRecording.eventId,
    receipt.principalDecisionRecording.eventId,
  ]);
  const sideEffects = fixture.sideEffectCounts();
  assert.deepEqual(
    await fixture.coordinator.reviewCommittedCandidate(fixture.input),
    receipt,
  );
  assert.deepEqual(fixture.sideEffectCounts(), sideEffects);
  assert.equal(receipt.cosmoAccepted, false);
});

test('committed review preserves human-Invent and semantic-role provenance', async () => {
  for (const originKind of ['human_invent', 'semantic_role'] as const) {
    const fixture = await committedCandidateReviewFixture({ originKind });
    const receipt = await fixture.coordinator.reviewCommittedCandidate(
      fixture.input,
    );
    assert.equal(receipt.originKind, originKind);
    if (
      receipt.originKind === 'human_invent'
      && fixture.input.originKind === 'human_invent'
    ) {
      assert.equal(
        receipt.admittedHumanOperationEventId,
        fixture.input.admittedHumanOperationEventId,
      );
      assert.deepEqual(receipt.inventDraftRef, fixture.input.inventDraftRef);
      assert.deepEqual(receipt.inventPreviewRef, fixture.input.inventPreviewRef);
    } else if (
      receipt.originKind === 'semantic_role'
      && fixture.input.originKind === 'semantic_role'
    ) {
      assert.equal(receipt.semanticRole, fixture.input.semanticRole);
      assert.deepEqual(
        receipt.attemptReceiptRef,
        fixture.input.attemptReceiptRef,
      );
      assert.equal(receipt.contextBundleId, fixture.input.contextBundleId);
      assert.deepEqual(receipt.outputSchemaRef, fixture.input.outputSchemaRef);
      assert.deepEqual(receipt.outputRef, fixture.input.outputRef);
    } else {
      throw new Error('origin discriminant changed during committed review');
    }
    assert.equal('researchReceiptRef' in receipt, false);
    assert.equal(receipt.reviewCompletionRecording.event.eventType,
      'candidate_review_completed');
    assert.equal(receipt.cosmoAccepted, false);
  }
});

test('research coordinator depends only on injected ports', async () => {
  const executionPort = recordingExpeditionExecutionPort();
  const coordinator = makeResearchRuntimeCoordinator({ executionPort });
  const receipt = await coordinator.runCandidateResearchPhase(verticalGateInput());
  assert.equal(executionPort.inputs.length, 1);
  assert.deepEqual(
    receipt.runtimeReceiptRefs,
    [executionPort.completion.receiptRef],
  );
  assert.equal(
    dependencyGraph('@cosmo/research').imports.some(
      (specifier) => specifier === '@cosmo/runtime'
        || specifier.startsWith('@cosmo/runtime/'),
    ),
    false,
  );
});

test('runtime adapters satisfy contracts without importing research', async () => {
  const adapters = await runtimePortAdapterHarness();
  const input = executeExpeditionInput();
  const handle = await adapters.execution.execute(input);
  await drain(handle.events);
  const completion = await handle.completion;
  const controlInput = programRunControlInputFixture({
    runIds: ['run_1'],
    reason: 'program pause',
  });
  await adapters.control.pauseRuns(controlInput);
  const cancelInput = programRunControlInputFixture({
    runIds: ['run_2'],
    reason: 'program cancel',
    idempotencyKey: ids.sha('program-cancel'),
  });
  await adapters.control.cancelRuns(cancelInput);
  assert.equal(adapters.controller.startCalls, 1);
  assert.equal(adapters.controller.pauseCalls, 1);
  assert.equal(adapters.controller.cancelCalls, 1);
  assert.deepEqual(
    adapters.controller.startInputs[0].mutationAuthorization,
    input.mutationAuthorization,
  );
  assert.equal(adapters.controller.startInputs[0].runId, input.runId);
  assert.equal(adapters.controller.startInputs[0].startedAt, input.startedAt);
  assert.equal(
    adapters.controller.startInputs[0].idempotencyKey,
    input.idempotencyKey,
  );
  assert.deepEqual(
    adapters.controller.pauseInputs[0],
    {
      schema: 'cosmo.pause-runtime-input.v1',
      runId: 'run_1',
      reason: controlInput.reason,
      mutationAuthorization: controlInput.mutationAuthorization,
      idempotencyKey: deriveSubkey(controlInput.idempotencyKey, 'pause', 'run_1'),
      pausedAt: controlInput.occurredAt,
    },
  );
  assert.deepEqual(
    adapters.controller.cancelInputs[0],
    {
      schema: 'cosmo.cancel-runtime-input.v1',
      runId: 'run_2',
      reason: cancelInput.reason,
      mutationAuthorization: cancelInput.mutationAuthorization,
      idempotencyKey: deriveSubkey(cancelInput.idempotencyKey, 'cancel', 'run_2'),
      cancelledAt: cancelInput.occurredAt,
    },
  );
  assert.equal(completion.receipt.expeditionId, input.expedition.expeditionId);
  assert.deepEqual(
    completion.receipt.contextBundleRef,
    objectRefFor(input.context),
  );
  assert.deepEqual(
    await adapters.objects.getTyped(
      completion.receiptRef,
      RuntimeReceiptSchema,
    ),
    completion.receipt,
  );
  assert.equal(
    dependencyGraph('@cosmo/runtime').imports.some(
      (specifier) => specifier === '@cosmo/research'
        || specifier.startsWith('@cosmo/research/'),
    ),
    false,
  );
});

test('structured-role adapter resolves only a durably stored schema/output/receipt', async () => {
  const fixture = runtimeStructuredRoleAdapterHarness();
  const input = structuredRoleExecutionInputFixture();
  const result = await fixture.adapter.execute(input);
  assert.deepEqual(
    fixture.controller.startInputs[0],
    {
      schema: 'cosmo.start-runtime-input.v1',
      runId: input.runId,
      expeditionRef: input.expeditionRef,
      expedition: input.expedition,
      context: input.context,
      authorization: input.authorization,
      mutationAuthorization: input.mutationAuthorization,
      idempotencyKey: input.idempotencyKey,
      startedAt: input.startedAt,
    },
  );
  assert.deepEqual(await fixture.objects.get(
    result.outputSchemaRef,
    input.mutationAuthorization,
  ), fixture.outputSchemaObject);
  assert.deepEqual(await fixture.objects.get(
    result.outputRef,
    input.mutationAuthorization,
  ).then(stored => decodeJson(stored.bytes)), result.output);
  assert.equal(hashCanonicalJson(result.output), result.outputHash);
  assert.deepEqual(
    await fixture.objects.getTyped(
      result.runtimeReceiptRecording.receiptRef,
      RuntimeReceiptSchema,
    ),
    result.runtimeReceiptRecording.receipt,
  );
  assert.deepEqual(
    result.runtimeReceiptRecording.receipt.outputObjectRef,
    result.outputRef,
  );
  const counts = fixture.sideEffectCounts();
  assert.deepEqual(await fixture.adapter.execute(input), result);
  assert.deepEqual(fixture.sideEffectCounts(), counts);
});
```

- [ ] **Step 2: Run and verify failure**

Run:

```bash
node --test --import tsx packages/research/test/research-runtime-coordinator.test.ts
node --test --import tsx packages/runtime/test/runtime-port-adapters.test.ts packages/runtime/test/runtime-structured-role-execution-adapter.test.ts
```

Expected: FAIL because the coordinator and contracts-only runtime adapters do not exist.

- [ ] **Step 3: Implement the exact research-phase sequence**

Sequence:

```text
originate Question with provenance
  -> build bounded ExpeditionContract
  -> build COSMO ContextBundle
  -> acquire/validate runtime authorization
  -> bind only grant-authorized research tools
  -> run through the injected contracts-only ExpeditionExecutionPort
  -> quarantine every envelope
  -> admit discovery proposal
  -> invoke bounded acquisition and Program C CorpusAcquisitionPort
  -> create immutable child Corpus snapshot
  -> extract exact EvidenceSpan
  -> admit eligible CognitiveEvents
  -> await and verify the terminal RuntimeReceiptRecording
  -> stage one exact Program C Corpus-root mutation batch
  -> return candidate research receipt
  -> stop
```

The candidate phase does not run an independent review or Principal disposition.
`DEVerticalGateInput` preallocates the exact absent candidate ref, lineage ID,
and trust domain and carries the explicit mutation authorization plus base
idempotency key for this call. The coordinator derives stable named subkeys and
builds every Expedition and admitted event
with `basedOnBrainCommitId === startingBrainCommitId` and that exact
candidate-ref scope. Program E must reject a candidate-branch request unless
its ref/parent/lineage/trust values and selected `journalEventIds` match those
events exactly. Before Program E requests that commit, its D/E coordinator
stores the canonical `DEVerticalGateResearchReceipt` bytes through Program B
and supplies the resulting `researchReceiptRef`. The candidate commit's
Topology/Heritage closure must retain that ref. Resolving it must reach every
selected RuntimeReceipt, immutable ContextBundle, research-tool receipt,
acquired source, EvidenceSpan, candidate object, and admitted event; an
unresolvable, orphaned, or mismatched provenance edge blocks the commit.
The coordinator must not create a candidate Brain commit, canonical Brain
commit, metabolism run, wake commit, or query. It returns the literal Program E
blocker.

Only after Program E commits an origin-specific candidate receipt to a
candidate Brain does
`reviewCommittedCandidate()` run:

```text
verify the exact autonomous-research, human-Invent, or semantic-role
  provenance bytes/refs
  -> verify candidate branch receipt ref and candidate Brain commit
  -> prove candidate object/event is reachable in that commit
  -> run independent Program C ReviewFinding + ReviewQualification
  -> for Claim status, record exact C ClaimTransitionDecision
  -> append the review-completed event
  -> call PrincipalService with claim-status or cognitive-status input
  -> append the Principal-decision event
  -> store and return committed-candidate review receipt
```

The candidate commit timestamp/event selection precedes every review and
Principal event. The Principal decision pins the candidate commit as its parent.
The selected candidate event must have one `brain_lineage` scope matching the
candidate-branch receipt's ref, lineage, and trust. The D review input and
receipt use the same strict `originKind` discriminant and preserve, unchanged:
the autonomous research receipt; the admitted human operation plus Invent
draft/preview; or the semantic role, attempt receipt, ContextBundle, output
schema, and output refs. A mismatch blocks review before any reviewer run.
For `semantic_role`, `attemptReceiptRef` resolves the real D
`RuntimeReceipt` named by the admitted semantic-role event; its
`contextBundleId`, output schema ref, and output object ref must equal the
other preserved fields and the candidate-branch receipt.
Program E supplies the
intended canonical publication ref in `canonicalTargetRef`. Every review,
Claim-transition, review-completed, and Principal event copies the candidate
program/lineage/trust, advances `basedOnBrainCommitId` to the candidate Brain
commit, and sets `targetRef` to that exact canonical ref. Mixed, missing,
candidate-ref, wrong-canonical-ref, or base-commit review scopes fail before any
review event is appended. The canonical journal order is all review-finding
events, the Claim-transition event when applicable, the mandatory
review-completed event, and then the mandatory Principal-decision event. Retry
reuses all review/decision/event identities.
Program E then consumes this second stored receipt as the sole disposition
authority for qualified Claim promotion or generic reviewed-cognition
acceptance. Both acceptance paths directly select every scoped review-finding
event, the mandatory `reviewCompletionRecording.event`, every qualification and
Claim-transition event applicable to the subject, the mandatory Principal
decision event, and the acceptance event. Their recursively materialized
closure retains `committedCandidateReviewReceiptRef`, which itself retains
the complete origin-specific provenance closure; no caller-supplied duplicate
disposition may substitute for those stored bytes.

`ResearchRuntimeCoordinator` receives `ExpeditionExecutionPort` and
`CorpusAcquisitionPort` as constructor dependencies. It does not import
`RuntimeController`, `EventAdmissionService`, `RuntimeStateStore`, or any
`@cosmo/runtime` path. The execution port returns an
`ExpeditionExecutionHandle`: its stream yields only already-admitted
`CognitiveEvent` values, and its completion promise resolves only after the
terminal `RuntimeReceipt` is durably stored and returns the verifying
`RuntimeReceiptRecording`. Provider envelopes and quarantine records cannot
cross this boundary. A missing/rejected completion promise blocks the D
research receipt rather than dropping execution provenance.

`RuntimeExpeditionExecutionAdapter` is the sole Program D adapter that maps
`ExecuteExpeditionInput` into the exact `StartRuntimeInput`, including the
caller's explicit MutationAuthorization, drains the `RuntimeController`, and
exposes admitted events plus the terminal receipt recording. It does not pass
MutationAuthorization into provider-facing `WorkerRuntime.runMission`.
`RuntimeStructuredRoleExecutionAdapter` maps
`StructuredRoleExecutionInput` into that same durable controller start handle,
requires zero admitted cognitive events for a non-worker output schema, awaits
the stored completion receipt, re-reads the pinned schema, output, and
RuntimeReceipt objects, and revalidates schema name/ref, output hash, trust,
and all Expedition/Context/authorization pins before returning
`StructuredRoleExecutionResult`. It owns replay/recovery for this seam.
Program H instantiates this one adapter and injects it into the Principal,
default-mode, dream, independent-review, inquiry-generator, and
inquiry-verifier owner adapters; none creates a parallel provider path.
`RuntimeProgramControlAdapter` maps Program-level pause/cancel fencing onto the
controller and reconciler. It accepts only `ProgramRunControlInput`, derives
one stable per-run subkey, and propagates the caller's reason, authority, and
occurrence time byte-for-byte into the strict pause/cancel input. It lives in
`@cosmo/runtime`, imports only
`@cosmo/contracts` plus runtime-local modules, and never imports
`@cosmo/research`. The architecture test parses both workspace dependency
graphs and source imports; a concrete sibling import in either direction fails
the gate.

Program E consumes the exact `DEVerticalGateResearchPort` and adds:

```text
D candidate research receipt
  -> candidate-only branch commit
  -> D independent review + Principal receipt
  -> qualified Claim promotion or reviewed-cognition acceptance
  -> canonical BrainCommit
  -> metabolism transaction
  -> wake BrainCommit
  -> pinned surprise/formation query
```

- [ ] **Step 4: Run focused and both package suites**

Run:

```bash
node --test --import tsx packages/research/test/research-runtime-coordinator.test.ts
node --test --import tsx packages/runtime/test/runtime-port-adapters.test.ts packages/runtime/test/runtime-structured-role-execution-adapter.test.ts
npm test --workspace @cosmo/research
npm test --workspace @cosmo/runtime
```

Expected: PASS and every D receipt remains explicitly blocked on Program E.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/research-runtime-coordinator.ts packages/research/src/d-e-vertical-gate.ts packages/research/src/index.ts packages/research/test/research-runtime-coordinator.test.ts packages/runtime/src/runtime-expedition-execution-adapter.ts packages/runtime/src/runtime-structured-role-execution-adapter.ts packages/runtime/src/runtime-program-control-adapter.ts packages/runtime/src/index.ts packages/runtime/test/runtime-port-adapters.test.ts packages/runtime/test/runtime-structured-role-execution-adapter.test.ts
git commit -m "feat(research): expose the D to E cognitive gate"
```

### Task 12: Lock the Program D Contract Gate and Non-Acceptance Receipt

**Files:**
- Create: `packages/research/test/program-d-gate.test.ts`
- Create: `scripts/verify-program-d.mjs`
- Create: `docs/receipts/program-d-gate.json` through the verification script
- Modify: `package.json`

**Interfaces:**
- Consumes: all Program D tests and the Program C gate receipt.
- Produces: `npm run verify:program-d` and a committed machine-readable non-acceptance receipt.

- [ ] **Step 1: Write the failing aggregate gate**

```ts
test('Program C gate is passed before Program D gate', async () => {
  const receipt = await readJson('docs/receipts/program-c-gate.json');
  assert.equal(receipt.status, 'passed');
  assert.equal(receipt.hardGateViolations, 0);
});

test('Program D exports exact WorkerRuntime and D/E contracts', async () => {
  assert.equal(typeof DeterministicConformanceRuntime, 'function');
  assert.equal(typeof OpenAiAgentsRuntime, 'function');
  assert.equal(typeof DefaultResearchToolRegistry, 'function');
  assert.equal(typeof ResearchRuntimeCoordinator, 'function');
  assert.equal(typeof EventAdmissionService, 'function');
});

test('Program D remains unaccepted without Program E', async () => {
  const receipt = await makeResearchRuntimeCoordinator().runCandidateResearchPhase(
    verticalGateInput(),
  );
  assert.equal(receipt.cosmoAccepted, false);
  assert.equal(receipt.blockedOn, 'program-e-living-brain-metabolism');
});

test('Program D contains no Home23 runtime dependency', async () => {
  const imports = await scanPackageImports([
    'packages/research',
    'packages/runtime',
  ]);
  assert.deepEqual(
    imports.filter(value => /home23|cosmo23/i.test(value)),
    [],
  );
});
```

- [ ] **Step 2: Run and verify failure before wiring the command**

Run:

```bash
node --test --import tsx packages/research/test/program-d-gate.test.ts
```

Expected: FAIL until the aggregate exports and receipt writer are connected.

- [ ] **Step 3: Implement the verification script**

`scripts/verify-program-d.mjs` runs:

```text
npm run build
npm test --workspace @cosmo/contracts
npm test --workspace @cosmo/repository
npm test --workspace @cosmo/corpus
npm test --workspace @cosmo/research
npm test --workspace @cosmo/runtime
```

It writes canonical JSON from verified results:

```js
const receipt = {
  schema: 'cosmo.program-gate-receipt.v1',
  program: 'D',
  status: 'contract-complete',
  cosmoAccepted: false,
  blockedOn: 'program-e-living-brain-metabolism',
  hardGateViolations: 0,
  deterministicAdapterPassed: deterministicResult.status === 'passed',
  productionAdapterContractPassed: contractResult.status === 'passed',
  productionAdapterLiveSmoke: liveResult.invoked
    ? 'passed'
    : 'skipped_secure_credential_gate_not_invoked',
  gitCommit: await capture('git', ['rev-parse', 'HEAD']),
  gitTree: await capture('git', ['rev-parse', 'HEAD^{tree}']),
};
```

The script requires `--expected-commit`, a clean tree, exact `HEAD === expectedCommit`, and `git write-tree === HEAD^{tree}` before it runs a test. The schema accepts exactly `passed` or `skipped_secure_credential_gate_not_invoked` for `productionAdapterLiveSmoke`. A skipped or passing D smoke test is diagnostic only: neither state satisfies Program G's production-semantic acceptance profiles. `capture` trims one successful stdout line or fails the gate. The script refuses any attempt to set `cosmoAccepted` to `true`; it never reads or emits credentials.

Add the root script:

```json
{
  "scripts": {
    "verify:program-d": "node scripts/verify-program-d.mjs"
  }
}
```

- [ ] **Step 4: Commit the complete Program D gate harness**

Run:

```bash
git add packages/research/test/program-d-gate.test.ts scripts/verify-program-d.mjs package.json package-lock.json
git commit -m "test(research): add Program D contract gate"
test -z "$(git status --porcelain)"
```

Expected: all Program D implementation and its verifier are committed, the tree is clean, and no receipt for this commit has been generated yet.

- [ ] **Step 5: Test the exact clean commit**

Run:

```bash
candidate_commit="$(git rev-parse HEAD)"
candidate_tree="$(git rev-parse HEAD^{tree})"
test -z "$(git status --porcelain)"
npm run verify:program-d -- --expected-commit "$candidate_commit"
test "$(git rev-parse HEAD)" = "$candidate_commit"
test "$(git rev-parse HEAD^{tree})" = "$candidate_tree"
jq -e --arg commit "$candidate_commit" '
  .status == "contract-complete"
  and .cosmoAccepted == false
  and .blockedOn == "program-e-living-brain-metabolism"
  and .gitCommit == $commit
' docs/receipts/program-d-gate.json
```

Expected: exit `0`; every contract suite passes, the receipt names the exact clean commit, and the verifier neither changes HEAD nor the committed tree.

- [ ] **Step 6: Verify dependency and secret hygiene**

Run:

```bash
rg -n -i 'home23|cosmo23' packages/research packages/runtime scripts/verify-program-d.mjs
rg -n 'OPENAI_API_KEY|sk-proj-|sk-[A-Za-z0-9]' packages/research packages/runtime docs/receipts/program-d-gate.json
git diff --check
test "$(git status --porcelain)" = "?? docs/receipts/program-d-gate.json"
```

Expected: no Home23 source import or runtime dependency; the credential scan may find only the literal environment-variable name inside the explicitly gated live test and must find no key-shaped value; `git diff --check` prints nothing; the exact-status assertion permits only `docs/receipts/program-d-gate.json`.

- [ ] **Step 7: Commit only the non-acceptance receipt**

```bash
git add docs/receipts/program-d-gate.json
test "$(git diff --cached --name-only)" = "docs/receipts/program-d-gate.json"
git diff --cached --check
test "$(git status --porcelain)" = "A  docs/receipts/program-d-gate.json"
git commit -m "docs(research): receipt Program D contract gate"
test -z "$(git status --porcelain)"
```

### Task 13: Owner Extension — Legacy Question and Artifact Index Proposal Builders (executes during Program G)

This is a D-owned extension implemented when Program G Task 1 has frozen the
shared legacy contracts in `@cosmo/contracts`. It adds no dependency from
`@cosmo/research` to a migration package: both sides import the sole
schema/type objects from `@cosmo/contracts`. Core Program D verification
(Task 12) issues its non-acceptance receipt before this extension; Program G
Task 5 cannot begin until this task's commit lands. C Task 12 and E Task 11B
are the sibling owner extensions in the same window.

**Files:**
- Create: `packages/research/src/legacy-import-proposals.ts`
- Create: `packages/research/test/legacy-import-proposals.test.ts`
- Modify: `packages/research/src/index.ts`

**Interfaces:**
- Consumes by identity from Program G's shared-contract freeze:
  `BuildLegacyQuestionBatchProposalInputSchema`,
  `BuildArtifactIndexBatchUpdateProposalInputSchema`, the two proposal and
  strict result schemas, and `LegacyImportMappingSchema`, with their inferred
  types.
- Produces only:

```ts
export interface LegacyQuestionBatchProposalBuilder {
  build(
    input: BuildLegacyQuestionBatchProposalInput,
  ): Promise<LegacyQuestionBatchProposalBuildResult>;
}

export interface ArtifactIndexBatchUpdateProposalBuilder {
  build(
    input: BuildArtifactIndexBatchUpdateProposalInput,
  ): Promise<ArtifactIndexBatchUpdateProposalBuildResult>;
}
```

- [ ] **Step 1: Write the failing builder tests**

Cover both builders: schema-identity with the G-frozen contract objects; the
Question builder admitting only `legacy_question` mappings, forcing
`origin='legacy_import'` and `status='incubating'`, and unable to create an
active Question or any Program mutation; the Artifact builder admitting only
`legacy_artifact` mappings, requiring each `curationEventId` to be a Program B
`ObjectId`, and forcing `disposition='legacy_unverified'`; equal-length,
unique, canonically ordered `mappingRefs`/`mappings` with byte-identical
stored mapping bytes; the empty-subset no-op proposal whose next root equals
its previous root; the exact shared candidate scope/trust; typed journal
events appended before the next root is proposed; and rejection paths for
unmapped kinds, widened trust, Principal decisions, and promotion fields.
Neither builder has a ref/CAS/promotion method.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm exec --workspace @cosmo/research -- tsx --test \
  test/legacy-import-proposals.test.ts
```

Expected: FAIL because the builders do not exist.

- [ ] **Step 3: Implement both builders and export them**

Implement both interfaces exactly as frozen: parse the G-owned input schemas
first, validate mapping ledgers as tested, and return one exact stored
proposal object per builder whose parent/previous-root pin, mapping coverage,
scope, trust, and selected events are verifiable by Program E's acceptance
transaction. Export from `packages/research/src/index.ts`.

- [ ] **Step 4: Run focused and package suites**

Run:

```bash
npm exec --workspace @cosmo/research -- tsx --test \
  test/legacy-import-proposals.test.ts
npm exec --workspace @cosmo/research -- tsx --test test/
```

Expected: PASS with no regression in the research suite.

- [ ] **Step 5: Commit**

```bash
git add packages/research/src/legacy-import-proposals.ts \
  packages/research/src/index.ts \
  packages/research/test/legacy-import-proposals.test.ts
git commit -m "feat(research): owner-built legacy question and artifact proposals"
```

## Joint D+E Handoff

After Program D’s receipt is committed:

- Program E imports `DEVerticalGateResearchPort`, `DEVerticalGateInput`,
  `DEVerticalGateResearchReceipt`, `DECommittedCandidateReviewInput`, and
  `DECommittedCandidateReviewReceipt` exactly.
- Program E supplies `DEVerticalGateCognitionPort` and `runDEVerticalGate`.
- The mandatory joint stop/go command is `npm run verify:program-e`; no Program D command substitutes for it.
- The joint verifier runs `tests/vertical/d-e-cognitive-flow.test.ts`, `tests/vertical/d-e-production-adapter.test.ts`, and the contracts/repository/corpus/research/runtime/cognition package suites.
- The deterministic adapter runs first.
- The production OpenAI Agents adapter runs second through the same port.
- The joint test forces restart, context turnover, a late fenced event, and simultaneous metabolism attempts.
- Only the joint receipt at `docs/receipts/program-e-living-brain-metabolism.json` may set `cosmoAccepted: true` and `stopGo: "go"`, and only after candidate research, candidate branch, post-commit independent review/Principal recording, qualified Claim promotion plus reviewed non-Claim cognition acceptance, canonical commit, metabolism, wake commit, and pinned formation trace all pass in that order.

Until that joint gate passes, Program D is useful infrastructure but it is not COSMO.
