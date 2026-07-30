# Standalone COSMO Program G: Legacy Migration and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import the frozen cross-era historical COSMO casebook without inventing provenance, then prove the standalone system through signed, external, replayable acceptance that a polished answer model cannot fake.

**Architecture:** Typed read-only adapters convert preserved Program A fixtures into staged Program B repository objects under Program C evidence rules. Imports advance a new branch only after reconciliation. A separate `@cosmo/acceptance` package verifies human-signed profiles, launches isolated candidate/baseline trials, runs hard gates and vector probes, and publishes immutable receipts without giving the system under test authority over fixtures, thresholds, or scores.

**Tech Stack:** Node.js 22.12+, TypeScript ESM, Zod 4, `node:test`, Ed25519 signatures through `node:crypto`, child-process isolation, filesystem access tracing, Programs A–F public interfaces.

## Global Constraints

- Do not begin implementation until the complete Programs A–H planning set has passed cross-program interface review and the operator explicitly releases the planning freeze.
- Consume only Program A content-addressed fixtures. A newly mounted or rediscovered historical source must first pass Program A preservation and casebook publication; G never reads a live source path directly.
- The signed historical-case manifest must reconcile Program A's cross-era inventory, including early/Unified/COSMO23, Clawd/OpenClaw, merged subject Brains, the preserved `cosmos.evobrew.com` website corpus, and external-drive snapshots. A missing or unreadable preserved root is an explicit failed/limited case, never a silent omission or a late live-path substitution.
- Never rewrite, normalize, rename, delete, or mass-copy a historical root.
- Unknown ancestry stays unknown; similarity never becomes a parent commit.
- Early Brain content without exact evidence imports as `legacy_unverified`, never as a sourced fact.
- Transcript, task, runtime, artifact, cognition, evidence, and design heritage remain distinct import classes.
- Every import stages under a new branch and advances a ref only after full reconciliation.
- Acceptance profiles are signed before candidate output and are inaccessible for mutation by COSMO.
- The release profile, every referenced profile subdocument, the external harness, and all scorer code are committed before a release trial. A release trial runs from an exact detached clean commit; the later receipt commit may change only the receipt document.
- Semantic release trials use the profile-pinned live provider, model, runtime adapter, transport, tool registry, and independent-verifier identities. Recorded or deterministic transports may prove only structural conformance and injected-fault behavior.
- Autonomous-origin claims require an external causal-origin attestation over durable event ancestry. A candidate-authored boolean or prose statement is never origin evidence.
- The sustained-autonomy interval is measured by an external monotonic observer for at least 28,800,000 milliseconds. The observer is read-only: it cannot prompt, Steer, Invent, mutate a ref, or supply a candidate question during the interval.
- Zero hard-gate violations are allowed; vector averages cannot hide one.
- Query-time connections receive assertion type 3 and no accumulated-cognition credit.
- Home23 is absent from the acceptance runtime; historical Home23 material is read-only fixture data.
- Use at least three paired trials for nondeterministic release claims.
- Every budget, baseline, threshold, case ID, statistical rule, human-review rule, environment allowance, and not-applicable decision is frozen in signed profile content. Release profiles reject dummy/sentinel IDs, wildcard providers/models, unresolved environment variables, and unfinished-marker values.
- Use TDD and commit after every independently reviewable task.

---

## File Structure

```text
packages/contracts/src/
  migration.ts
  acceptance.ts
packages/migration/src/
  adapter.ts
  classify.ts
  staged-import.ts
  reconcile.ts
  adapters/
    original-cosmo.ts
    unified-cosmo.ts
    cosmo23.ts
    clawd-openclaw.ts
    brainstudio.ts
  index.ts
packages/migration/
  package.json
  tsconfig.json
packages/acceptance/src/
  profile.ts
  signing.ts
  harness-contracts.ts
  external-harness.ts
  trial-runner.ts
  hard-gates.ts
  genesis-proof.ts
  vector-scorecard.ts
  brain-over-files.ts
  discovery-acquisition-proof.ts
  causal-origin-proof.ts
  human-review.ts
  metabolism-proof.ts
  autonomy-proof.ts
  guided-proof.ts
  relationship-proof.ts
  self-research-proof.ts
  cognitive-probe.ts
  ablation-proof.ts
  continuity-proof.ts
  core-isolation.ts
  receipt.ts
  index.ts
packages/acceptance/
  package.json
  tsconfig.json
packages/migration/src/
  command-handler.ts
packages/acceptance/src/
  command-handler.ts
  core-candidate-entrypoint.ts
fixtures/acceptance/
  release-profile.v1/
    manifest.json
    required-historical-case-manifest.json
    artifact-set-manifest.json
    prompt-identity-manifest.json
    tool-identity-manifest.json
    seed-manifest.json
    hidden-oracle-commitments.json
    intervention-schedule.json
    execution-identities.json
    production-execution-requirements.json
    budgets.json
    candidate-baseline-parity.json
    hard-gates.json
    vector-thresholds.json
    scorer-identities.json
    nondeterminism-policy.json
    statistical-methods.json
    non-regression-rules.json
    environment-policy.json
    human-review-protocol.json
    public-keys/
  hard-gates/
  discovery-acquisition/
  self-research/
  guided/
  pure-mode/
tests/migration/
tests/acceptance/
docs/operations/
  legacy-migration.md
  acceptance.md
```

---

### Task 1: Freeze Legacy Import and Acceptance Contracts

**Files:**
- Create: `packages/contracts/src/migration.ts`
- Create: `packages/contracts/src/acceptance.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `tests/migration/contracts.test.ts`
- Create: `tests/acceptance/contracts.test.ts`

**Interfaces:**
- Consumes: `ObjectId`, `BrainCommitId`, `CorpusSnapshotId`, `EventId`, `ClaimId`, `QuestionId`, `ReviewFindingId`, `ResearchProgramMode`, `ResearchProgramModeSchema`, `BrainRootKind`, Program B's exact `BrainLineageEventScopeSchema`/`BrainLineageEventScope`, `BrainRefName`, `LeaseProof`, `ObjectRef`, `TrustDescriptor`, `DetachedSignature`, `MutationAuthorization`, and Program C's already-frozen `CorpusRootMutationBatchRecordingSchema` from the accepted Programs B–F contracts.
- Produces and exports from `@cosmo/contracts`: `LegacySource`, `LegacyRecord`, `LegacyImportClass`, `LegacyImportMapping`; the exact-B-refined `LegacyImportBrainLineageEventScope`; the G-owned legacy bridge DTOs `LegacyCorpusMapping`, `BuildLegacyCorpusImportProposalInput`, `LegacyCorpusImportProposal`, `LegacyCorpusImportProposalBuildResult`, `LegacyQuestionMapping`, `BuildLegacyQuestionBatchProposalInput`, `LegacyQuestionBatchProposal`, `LegacyQuestionBatchProposalBuildResult`, `LegacyArtifactMapping`, `BuildArtifactIndexBatchUpdateProposalInput`, `ArtifactIndexBatchUpdateProposal`, `ArtifactIndexBatchUpdateProposalBuildResult`, `LegacyTopologyMapping`, `BuildLegacyTopologyImportProposalInput`, `LegacyTopologyImportProposal`, and `LegacyTopologyImportProposalBuildResult`; `LegacyImportCandidateProposalBundle`, `StagedImport`, `PublishStagedImportInput`, `LegacyImportCandidateReceipt`, `MigrationReceipt`, `AcceptanceDimensionId`, `AcceptanceExecutionIdentity`, `RequiredHistoricalCaseId`, `RequiredReleaseScenarioId`, `AcceptanceScenarioClass`, `RequiredReleaseScenarioClassById`, `TrialScheduleIdentity`, `AcceptanceProfile`, `SignedAcceptanceProfile`, `TrialReceipt`, `GenesisBrainAcceptanceResult`, `ReleaseAcceptanceReceipt`, and every Zod schema named below.

- [ ] **Step 1: Write failing migration-contract tests**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AcceptanceProfileSchema,
  ArtifactIndexBatchUpdateProposalBuildResultSchema,
  ArtifactIndexBatchUpdateProposalSchema,
  BrainLineageEventScopeSchema,
  BuildArtifactIndexBatchUpdateProposalInputSchema,
  BuildLegacyCorpusImportProposalInputSchema,
  BuildLegacyQuestionBatchProposalInputSchema,
  BuildLegacyTopologyImportProposalInputSchema,
  DiscoveryAcquisitionResultSchema,
  GenesisBrainAcceptanceResultSchema,
  LegacyArtifactMappingSchema,
  LegacyCorpusMappingSchema,
  LegacyCorpusImportProposalBuildResultSchema,
  LegacyCorpusImportProposalSchema,
  LegacyDescriptorSchema,
  LegacyImportBrainLineageEventScopeSchema,
  LegacyImportCandidateProposalBundleSchema,
  LegacyRecordSchema,
  LegacySourceSchema,
  LegacyQuestionMappingSchema,
  LegacyQuestionBatchProposalBuildResultSchema,
  LegacyQuestionBatchProposalSchema,
  LegacyTopologyMappingSchema,
  LegacyTopologyImportProposalBuildResultSchema,
  LegacyTopologyImportProposalSchema,
  MigrationReceiptSchema,
  PublishStagedImportInputSchema,
  SignedAcceptanceProfileSchema,
  TrialReceiptSchema,
} from '@cosmo/contracts';

test('legacy cognition without evidence can only be legacy_unverified', () => {
  const input = {
    schema: 'cosmo.legacy-record.v1',
    sourceRecordId: 'sha256:' + 'a'.repeat(64),
    sourceFixtureId: 'sha256:' + 'b'.repeat(64),
    sourceLocator: {
      sourceFixtureId: 'sha256:' + 'b'.repeat(64),
      rootId: 'sha256:' + 'd'.repeat(64),
      entryId: 'sha256:' + 'e'.repeat(64),
      relativePath: 'brain/nodes/node-001.json',
      objectSha256: 'sha256:' + 'a'.repeat(64),
    },
    importClass: 'legacy_cognition',
    contentRef: {
      objectId: 'sha256:' + 'c'.repeat(64),
      mediaType: 'application/json',
      byteLength: 12,
    },
    claimedParentIds: [],
    evidenceSpanIds: [],
    epistemicStatus: 'legacy_unverified',
    limitations: ['no claim-to-source lineage'],
  };
  const record = LegacyRecordSchema.parse(input);
  assert.equal(record.epistemicStatus, 'legacy_unverified');
  assert.throws(() => LegacyRecordSchema.parse({
    ...input,
    actorIdentity: 'forged',
  }));
  assert.throws(() => LegacyRecordSchema.parse({
    ...input,
    sourceLocator: {
      ...input.sourceLocator,
      provenanceAuthority: 'forged',
    },
  }));
  assert.throws(() => LegacyRecordSchema.parse({
    ...input,
    contentRef: {
      ...input.contentRef,
      capabilityGrantId: 'sha256:' + 'f'.repeat(64),
    },
  }));
});

test('adapter inputs cannot smuggle paths, provenance, or authority', () => {
  const source = legacySourceFixture();
  assert.equal(LegacySourceSchema.parse(source).readOnly, true);
  assert.throws(() => LegacySourceSchema.parse({
    ...source,
    capabilityGrantId: 'sha256:' + 'f'.repeat(64),
  }));

  const descriptor = legacyDescriptorFixture();
  assert.throws(() => LegacyDescriptorSchema.parse({
    ...descriptor,
    sourceLocator: {
      ...descriptor.sourceLocator,
      actorIdentity: 'forged',
    },
  }));
  assert.throws(() => LegacyDescriptorSchema.parse({
    ...descriptor,
    sourceLocator: {
      ...descriptor.sourceLocator,
      relativePath: '../outside-fixture',
    },
  }));
});

test('acceptance result IDs reject cross-kind values', () => {
  const result = discoveryAcquisitionResultFixture();
  assert.throws(() => DiscoveryAcquisitionResultSchema.parse({
    ...result,
    independentReviewFindingIds: ['claim_not-a-review'],
  }));
  assert.throws(() => DiscoveryAcquisitionResultSchema.parse({
    ...result,
    promotedClaimIds: ['evt_not-a-claim'],
  }));
  assert.throws(() => DiscoveryAcquisitionResultSchema.parse({
    ...result,
    principalEventIds: ['review_not-an-event'],
  }));
  assert.throws(() => DiscoveryAcquisitionResultSchema.parse({
    ...result,
    startingCorpusSnapshotIds: ['snapshot_not-a-content-id'],
  }));
});

test('Genesis Brain acceptance is bound to one exact model-free receipt', () => {
  const result = genesisBrainAcceptanceResultFixture();
  GenesisBrainAcceptanceResultSchema.parse(result);
  assert.throws(() => GenesisBrainAcceptanceResultSchema.parse({
    ...result,
    genesisBrainReceiptId: 'sha256:' + 'f'.repeat(64),
  }));
  assert.throws(() => GenesisBrainAcceptanceResultSchema.parse({
    ...result,
    modelCallCount: 1,
  }));
});

test('migration receipt names exact source and resulting branch head', () => {
  assert.throws(() => MigrationReceiptSchema.parse({
    schema: 'cosmo.migration-receipt.v1',
    migrationId: 'migration-1',
  }));
});

test('legacy publication is candidate-only and legacy_unverified', () => {
  const bundle = legacyImportCandidateProposalBundleFixture();
  assert.equal(
    LegacyImportCandidateProposalBundleSchema.shape.eventScope,
    LegacyImportBrainLineageEventScopeSchema,
  );
  assert.throws(() => LegacyImportCandidateProposalBundleSchema.parse({
    ...bundle,
    eventScope: {
      ...bundle.eventScope,
      programId: 'program_forged',
    },
  }));
  assert.throws(() => LegacyImportCandidateProposalBundleSchema.parse({
    ...bundle,
    mappings: bundle.mappings.map((mapping) => ({
      ...mapping,
      epistemicStatus: 'supported',
    })),
  }));

  const input = publishStagedImportInputFixture();
  assert.throws(() => PublishStagedImportInputSchema.parse({
    ...input,
    canonicalRef: 'refs/heads/main',
  }));
  assert.throws(() => PublishStagedImportInputSchema.parse({
    ...input,
    expectedCandidateHead: input.parentCommitId,
  }));
});

test('AcceptanceProfile root is byte-for-byte the master contract', () => {
  assert.equal(SignedAcceptanceProfileSchema, AcceptanceProfileSchema);
  assert.deepEqual(Object.keys(AcceptanceProfileSchema.shape), [
    'schema', 'profileId', 'governingSpecHash',
    'requiredHistoricalCaseManifestId', 'requiredHistoricalCaseIds',
    'fixtureManifestIds', 'startingBrainCommitIds', 'corpusSnapshotIds',
    'journalRanges', 'artifactSetManifest', 'covenantCommitId',
    'evidencePolicyIds', 'promptIdentityManifest', 'toolIdentityManifest',
    'seedManifest', 'hiddenOracleCommitments', 'interventionSchedule',
    'executionIdentities', 'productionExecutionRequirements', 'budgets',
    'baselineIds', 'candidateBaselineParity', 'pairedTrialCount',
    'hardGates', 'vectorThresholds', 'scorerIdentities',
    'nondeterminismPolicy', 'statisticalMethods', 'nonRegressionRules',
    'humanReviewProtocol', 'environmentPolicy', 'signatures',
  ]);
});

test('trial receipts use frozen case, scenario, and schedule identities', () => {
  const receipt = trialReceiptFixture();
  assert.throws(() => TrialReceiptSchema.parse({
    ...receipt,
    scenarioId: 'sha256:' + 'f'.repeat(64),
  }));
  assert.throws(() => TrialReceiptSchema.parse({
    ...receipt,
    scenarioClass: 'structural_conformance',
  }));
  assert.throws(() => TrialReceiptSchema.parse({
    ...receipt,
    baselineId: null,
    schedule: {
      kind: 'paired',
      pairId: 'sha256:' + 'e'.repeat(64),
      replicate: 1,
      arm: 'candidate',
    },
  }));
});
```

`legacySourceFixture()`, `legacyDescriptorFixture()`,
`legacyImportMappingFixture()`,
`legacyImportCandidateProposalBundleFixture()`,
`publishStagedImportInputFixture()`, `discoveryAcquisitionResultFixture()`,
`genesisBrainAcceptanceResultFixture()`, and `trialReceiptFixture()` are
complete test-local builders for the strict shapes below. They accept only
typed declared overrides; tests never bypass a schema with casts. Contract
tests table-drive every import-class/projection pair and every
projection/destination-root tuple, rejecting all combinations outside the
frozen tables. They also import all four bridge input/proposal/result schemas
directly from `@cosmo/contracts`, prove the bundle consumes those exact schema
objects, and scan `packages/contracts/src/migration.ts` to ensure every bridge
schema is declared before `LegacyImportCandidateProposalBundleSchema`.

- [ ] **Step 2: Run the tests and verify schema exports are missing**

Run:

```bash
npm test -- tests/migration/contracts.test.ts tests/acceptance/contracts.test.ts
```

Expected: FAIL because `LegacyRecordSchema` and `SignedAcceptanceProfileSchema` are not exported.

- [ ] **Step 3: Define exact migration schemas**

```ts
export const LegacyImportClassSchema = z.enum([
  'evidence_capable',
  'committed_cognition_partial_provenance',
  'legacy_cognition',
  'process_history',
  'artifact',
  'design_heritage',
  'corrupt_or_ambiguous',
]);

export const FixtureRelativePathSchema = z.string().min(1).superRefine(
  (value, context) => {
    if (
      value.startsWith('/')
      || value.includes('\\')
      || value.split('/').some((segment) =>
        segment === '' || segment === '.' || segment === '..'
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'fixture path must be normalized and relative',
      });
    }
  },
);

export const LegacySourceSchema = z.object({
  schema: z.literal('cosmo.legacy-source.v1'),
  sourceFixtureId: Sha256Schema,
  sourceCatalogId: Sha256Schema,
  casebookBundleId: Sha256Schema,
  casebookManifestId: ObjectIdSchema,
  selectedEntryIds: z.array(ObjectIdSchema).min(1),
  readOnly: z.literal(true),
}).strict();

export const LegacySourceLocatorSchema = z.object({
  sourceFixtureId: Sha256Schema,
  rootId: Sha256Schema,
  entryId: ObjectIdSchema,
  relativePath: FixtureRelativePathSchema,
  objectSha256: Sha256Schema,
}).strict();

export const LegacyDescriptorSchema = z.object({
  schema: z.literal('cosmo.legacy-descriptor.v1'),
  sourceLocator: LegacySourceLocatorSchema,
  kind: z.enum([
    'source',
    'cognition',
    'session',
    'task',
    'artifact',
    'design',
    'unknown',
  ]),
  contentRef: ObjectRefSchema,
  corrupt: z.boolean(),
  truncated: z.boolean(),
  sourceBytes: z.boolean(),
  exactSpanMap: z.boolean(),
  sourceList: z.boolean(),
}).strict();

export const LegacyRecordSchema = z.object({
  schema: z.literal('cosmo.legacy-record.v1'),
  sourceRecordId: ObjectIdSchema,
  sourceFixtureId: Sha256Schema,
  sourceLocator: LegacySourceLocatorSchema,
  importClass: LegacyImportClassSchema,
  contentRef: ObjectRefSchema,
  claimedParentIds: z.array(BrainCommitIdSchema),
  evidenceSpanIds: z.array(ObjectIdSchema),
  epistemicStatus: z.enum([
    'candidate',
    'supported',
    'contested',
    'disconfirmed',
    'legacy_unverified',
  ]),
  limitations: z.array(z.string().min(1)),
}).strict().superRefine((record, context) => {
  if (record.sourceFixtureId !== record.sourceLocator.sourceFixtureId) {
    context.addIssue({
      code: 'custom',
      path: ['sourceLocator', 'sourceFixtureId'],
      message: 'record and locator must name the same source fixture',
    });
  }
});

const AllowedLegacyProjectionKindsByImportClass = {
  evidence_capable: ['evidence_source'],
  committed_cognition_partial_provenance: ['legacy_claim'],
  legacy_cognition: [
    'legacy_claim',
    'legacy_question',
    'legacy_topology',
  ],
  process_history: ['process_history'],
  artifact: ['legacy_artifact'],
  design_heritage: ['heritage_only'],
  corrupt_or_ambiguous: ['heritage_only'],
} as const satisfies Record<
  z.infer<typeof LegacyImportClassSchema>,
  readonly string[]
>;

const RequiredDestinationRootKindsByProjection = {
  evidence_source: ['epistemicRoot'],
  legacy_claim: ['epistemicRoot', 'topologyRoot'],
  legacy_question: ['questionRoot', 'topologyRoot'],
  legacy_topology: ['topologyRoot'],
  legacy_artifact: ['artifactIndexRoot'],
  process_history: ['heritageRoot', 'topologyRoot'],
  heritage_only: ['heritageRoot'],
} as const;

export const LegacyImportMappingSchema = z.object({
  schema: z.literal('cosmo.legacy-import-mapping.v1'),
  mappingId: ObjectIdSchema,
  sourceRecordId: ObjectIdSchema,
  sourceFixtureId: Sha256Schema,
  importClass: LegacyImportClassSchema,
  sourceContentRef: ObjectRefSchema,
  destinationRootKinds: z.array(BrainRootKindSchema).min(1),
  destinationObjectRefs: z.array(ObjectRefSchema).min(1),
  selectedJournalEventIds: z.array(EventIdSchema),
  projection: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('evidence_source'),
      normalizedSourceRef: ObjectRefSchema,
      evidenceSpanIds: z.array(ObjectIdSchema),
    }).strict(),
    z.object({
      kind: z.literal('legacy_claim'),
      normalizedClaimDraftRef: ObjectRefSchema,
      evidenceSpanIds: z.array(ObjectIdSchema),
      claimStatus: z.literal('legacy_unverified'),
    }).strict(),
    z.object({
      kind: z.literal('legacy_question'),
      normalizedQuestionDraftRef: ObjectRefSchema,
      initialStatus: z.literal('incubating'),
      origin: z.literal('legacy_import'),
    }).strict(),
    z.object({
      kind: z.literal('legacy_topology'),
      normalizedTopologyDraftRef: ObjectRefSchema,
      origin: z.literal('legacy_import'),
    }).strict(),
    z.object({
      kind: z.literal('legacy_artifact'),
      normalizedArtifactDraftRef: ObjectRefSchema,
      indexDisposition: z.literal('legacy_unverified'),
    }).strict(),
    z.object({
      kind: z.literal('process_history'),
      normalizedProcessRecordRef: ObjectRefSchema,
    }).strict(),
    z.object({
      kind: z.literal('heritage_only'),
      preservedContentRef: ObjectRefSchema,
    }).strict(),
  ]),
  epistemicStatus: z.literal('legacy_unverified'),
  canonicalPromotionEligible: z.literal(false),
  limitations: z.array(z.string().min(1)).min(1),
}).strict().superRefine((mapping, context) => {
  const allowedKinds =
    AllowedLegacyProjectionKindsByImportClass[mapping.importClass];
  if (!(allowedKinds as readonly string[]).includes(
    mapping.projection.kind,
  )) {
    context.addIssue({
      code: 'custom',
      path: ['projection', 'kind'],
      message: 'projection kind is not admitted for this legacy import class',
    });
  }
  const requiredRootKinds =
    RequiredDestinationRootKindsByProjection[mapping.projection.kind];
  if (
    mapping.destinationRootKinds.length !== requiredRootKinds.length
    || mapping.destinationRootKinds.some(
      (rootKind, index) => rootKind !== requiredRootKinds[index],
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['destinationRootKinds'],
      message: 'destination roots must equal the frozen projection mapping',
    });
  }
});

type LegacyImportMappingValue = z.infer<typeof LegacyImportMappingSchema>;
type LegacyProjectionKind =
  LegacyImportMappingValue['projection']['kind'];
type LegacyMappingFor<K extends LegacyProjectionKind> =
  Omit<LegacyImportMappingValue, 'projection'> & {
    projection: Extract<
      LegacyImportMappingValue['projection'],
      { kind: K }
    >;
  };

type BrainLineageEventScopeValue =
  z.infer<typeof BrainLineageEventScopeSchema>;

export const LegacyImportBrainLineageEventScopeSchema =
  BrainLineageEventScopeSchema.refine(
    (
      scope,
    ): scope is BrainLineageEventScopeValue & { programId: null } =>
      scope.programId === null,
    { message: 'legacy import candidate scope has no Research Program' },
  );

export type LegacyImportBrainLineageEventScope =
  z.infer<typeof LegacyImportBrainLineageEventScopeSchema>;

export const LegacyCorpusMappingSchema = LegacyImportMappingSchema.refine(
  (
    mapping,
  ): mapping is LegacyMappingFor<'evidence_source' | 'legacy_claim'> =>
    mapping.projection.kind === 'evidence_source'
    || mapping.projection.kind === 'legacy_claim',
  { message: 'Corpus bridge admits only source and legacy Claim mappings' },
);

export const LegacyQuestionMappingSchema = LegacyImportMappingSchema.refine(
  (mapping): mapping is LegacyMappingFor<'legacy_question'> =>
    mapping.projection.kind === 'legacy_question',
  { message: 'Question bridge admits only legacy Question mappings' },
);

export const LegacyArtifactMappingSchema = LegacyImportMappingSchema.refine(
  (mapping): mapping is LegacyMappingFor<'legacy_artifact'> =>
    mapping.projection.kind === 'legacy_artifact',
  { message: 'Artifact bridge admits only legacy Artifact mappings' },
);

export const LegacyTopologyMappingSchema = LegacyImportMappingSchema.refine(
  (
    mapping,
  ): mapping is LegacyMappingFor<
    | 'legacy_topology'
    | 'legacy_claim'
    | 'legacy_question'
    | 'process_history'
  > => [
      'legacy_topology',
      'legacy_claim',
      'legacy_question',
      'process_history',
    ].includes(mapping.projection.kind),
  { message: 'Topology bridge admits only its frozen mapping kinds' },
);

const LegacyOwnerProposalInputFields = {
  parentCommitId: BrainCommitIdSchema,
  mappingRefs: z.array(ObjectRefSchema),
  eventScope: LegacyImportBrainLineageEventScopeSchema,
  trust: TrustDescriptorSchema,
  authorization: MutationAuthorizationSchema,
  idempotencyKey: Sha256Schema,
  proposedAt: z.string().datetime(),
};

export const BuildLegacyCorpusImportProposalInputSchema = z.object({
  schema: z.literal('cosmo.build-legacy-corpus-import-proposal-input.v1'),
  ...LegacyOwnerProposalInputFields,
  previousEpistemicRootRef: ObjectRefSchema,
  previousNegativeKnowledgeRootRef: ObjectRefSchema,
  mappings: z.array(LegacyCorpusMappingSchema),
}).strict();

export const LegacyCorpusImportProposalSchema = z.object({
  schema: z.literal('cosmo.legacy-corpus-import-proposal.v1'),
  basedOnBrainCommitId: BrainCommitIdSchema,
  previousEpistemicRootRef: ObjectRefSchema,
  previousNegativeKnowledgeRootRef: ObjectRefSchema,
  batchRecordingRef: ObjectRefSchema,
  batchRecording: CorpusRootMutationBatchRecordingSchema,
  mappingIds: z.array(ObjectIdSchema),
  selectedJournalEventIds: z.array(EventIdSchema),
  eventScope: LegacyImportBrainLineageEventScopeSchema,
  trust: TrustDescriptorSchema,
  canonicalMutationAllowed: z.literal(false),
}).strict();

export const LegacyCorpusImportProposalBuildResultSchema = z.object({
  proposalRef: ObjectRefSchema,
  proposal: LegacyCorpusImportProposalSchema,
}).strict();

export const BuildLegacyQuestionBatchProposalInputSchema = z.object({
  schema: z.literal('cosmo.build-legacy-question-batch-proposal-input.v1'),
  ...LegacyOwnerProposalInputFields,
  previousQuestionRootRef: ObjectRefSchema,
  mappings: z.array(LegacyQuestionMappingSchema),
}).strict();

export const LegacyQuestionBatchProposalSchema = z.object({
  schema: z.literal('cosmo.legacy-question-batch-proposal.v1'),
  basedOnBrainCommitId: BrainCommitIdSchema,
  previousQuestionRootRef: ObjectRefSchema,
  nextQuestionRootRef: ObjectRefSchema,
  questions: z.array(z.object({
    mappingId: ObjectIdSchema,
    questionId: QuestionIdSchema,
    questionRef: ObjectRefSchema,
    originEventId: EventIdSchema,
    status: z.literal('incubating'),
    origin: z.literal('legacy_import'),
  }).strict()),
  mappingIds: z.array(ObjectIdSchema),
  selectedJournalEventIds: z.array(EventIdSchema),
  eventScope: LegacyImportBrainLineageEventScopeSchema,
  trust: TrustDescriptorSchema,
  canonicalMutationAllowed: z.literal(false),
}).strict();

export const LegacyQuestionBatchProposalBuildResultSchema = z.object({
  proposalRef: ObjectRefSchema,
  proposal: LegacyQuestionBatchProposalSchema,
}).strict();

export const BuildArtifactIndexBatchUpdateProposalInputSchema = z.object({
  schema: z.literal(
    'cosmo.build-artifact-index-batch-update-proposal-input.v1',
  ),
  ...LegacyOwnerProposalInputFields,
  previousArtifactIndexRootRef: ObjectRefSchema,
  mappings: z.array(LegacyArtifactMappingSchema),
}).strict();

export const ArtifactIndexBatchUpdateProposalSchema = z.object({
  schema: z.literal('cosmo.artifact-index-batch-update-proposal.v1'),
  basedOnBrainCommitId: BrainCommitIdSchema,
  previousArtifactIndexRootRef: ObjectRefSchema,
  nextArtifactIndexRootRef: ObjectRefSchema,
  entries: z.array(z.object({
    mappingId: ObjectIdSchema,
    artifactRef: ObjectRefSchema,
    indexEntryRef: ObjectRefSchema,
    curationEventId: ObjectIdSchema,
    disposition: z.literal('legacy_unverified'),
  }).strict()),
  mappingIds: z.array(ObjectIdSchema),
  selectedJournalEventIds: z.array(EventIdSchema),
  eventScope: LegacyImportBrainLineageEventScopeSchema,
  trust: TrustDescriptorSchema,
  canonicalMutationAllowed: z.literal(false),
}).strict();

export const ArtifactIndexBatchUpdateProposalBuildResultSchema = z.object({
  proposalRef: ObjectRefSchema,
  proposal: ArtifactIndexBatchUpdateProposalSchema,
}).strict();

export const BuildLegacyTopologyImportProposalInputSchema = z.object({
  schema: z.literal('cosmo.build-legacy-topology-import-proposal-input.v1'),
  ...LegacyOwnerProposalInputFields,
  previousTopologyRootRef: ObjectRefSchema,
  mappings: z.array(LegacyTopologyMappingSchema),
}).strict();

export const LegacyTopologyImportProposalSchema = z.object({
  schema: z.literal('cosmo.legacy-topology-import-proposal.v1'),
  basedOnBrainCommitId: BrainCommitIdSchema,
  previousTopologyRootRef: ObjectRefSchema,
  nextTopologyRootRef: ObjectRefSchema,
  entries: z.array(z.object({
    mappingId: ObjectIdSchema,
    topologyObjectRef: ObjectRefSchema,
    formationEventId: EventIdSchema,
    origin: z.literal('legacy_import'),
    epistemicStatus: z.literal('legacy_unverified'),
  }).strict()),
  mappingIds: z.array(ObjectIdSchema),
  selectedJournalEventIds: z.array(EventIdSchema),
  eventScope: LegacyImportBrainLineageEventScopeSchema,
  trust: TrustDescriptorSchema,
  canonicalMutationAllowed: z.literal(false),
}).strict();

export const LegacyTopologyImportProposalBuildResultSchema = z.object({
  proposalRef: ObjectRefSchema,
  proposal: LegacyTopologyImportProposalSchema,
}).strict();

const LegacyRootPlanHeader = <
  K extends BrainRootKind,
  O extends 'repository' | 'corpus' | 'research' | 'cognition',
>(rootKind: K, owner: O) => ({
  rootKind: z.literal(rootKind),
  owner: z.literal(owner),
  previousRootRef: ObjectRefSchema,
});

export const LegacyImportCandidateProposalBundleSchema = z.object({
  schema: z.literal('cosmo.legacy-import-candidate-proposal-bundle.v1'),
  bundleId: Sha256Schema,
  migrationId: z.string().min(1),
  sourceFixtureId: Sha256Schema,
  sourceCatalogId: Sha256Schema,
  casebookBundleId: Sha256Schema,
  casebookManifestId: ObjectIdSchema,
  parentCommitId: BrainCommitIdSchema,
  candidateRef: BrainRefNameSchema.refine(
    (ref) => ref.startsWith('refs/heads/imports/'),
    { message: 'legacy import candidates use only refs/heads/imports/*' },
  ),
  expectedCandidateHead: z.null(),
  mappings: z.array(LegacyImportMappingSchema).min(1),
  selectedJournalEventIds: z.array(EventIdSchema).min(1),
  eventScope: LegacyImportBrainLineageEventScopeSchema,
  effectiveTrust: TrustDescriptorSchema,
  migrationManifestRef: ObjectRefSchema,
  reconciliationRef: ObjectRefSchema,
  rootPlans: z.tuple([
    z.object({
      ...LegacyRootPlanHeader('epistemicRoot', 'corpus'),
      action: z.literal('apply_corpus_batch'),
      proposalRef: ObjectRefSchema,
      proposal: LegacyCorpusImportProposalSchema,
    }).strict(),
    z.object({
      ...LegacyRootPlanHeader('questionRoot', 'research'),
      action: z.literal('apply_legacy_question_batch'),
      proposalRef: ObjectRefSchema,
      proposal: LegacyQuestionBatchProposalSchema,
    }).strict(),
    z.object({
      ...LegacyRootPlanHeader('programRoot', 'research'),
      action: z.literal('copy_parent'),
    }).strict(),
    z.object({
      ...LegacyRootPlanHeader('relationshipRoot', 'research'),
      action: z.literal('copy_parent'),
    }).strict(),
    z.object({
      ...LegacyRootPlanHeader('heritageRoot', 'repository'),
      action: z.literal('derive_migration_heritage'),
      curationEventId: ObjectIdSchema,
      curationEventRef: ObjectRefSchema,
      migrationJournalEventId: EventIdSchema,
    }).strict(),
    z.object({
      ...LegacyRootPlanHeader('topologyRoot', 'cognition'),
      action: z.literal('apply_legacy_topology'),
      proposalRef: ObjectRefSchema,
      proposal: LegacyTopologyImportProposalSchema,
    }).strict(),
    z.object({
      ...LegacyRootPlanHeader('activationRoot', 'cognition'),
      action: z.literal('copy_parent'),
    }).strict(),
    z.object({
      ...LegacyRootPlanHeader('negativeKnowledgeRoot', 'corpus'),
      action: z.literal('apply_corpus_batch'),
      proposalRef: ObjectRefSchema,
      proposal: LegacyCorpusImportProposalSchema,
    }).strict(),
    z.object({
      ...LegacyRootPlanHeader('artifactIndexRoot', 'research'),
      action: z.literal('apply_legacy_artifact_batch'),
      proposalRef: ObjectRefSchema,
      proposal: ArtifactIndexBatchUpdateProposalSchema,
    }).strict(),
  ]),
  canonicalPromotionAllowed: z.literal(false),
}).strict().superRefine((bundle, context) => {
  if (
    bundle.eventScope.basedOnBrainCommitId !== bundle.parentCommitId
    || bundle.eventScope.targetRef !== bundle.candidateRef
  ) {
    context.addIssue({
      code: 'custom',
      path: ['eventScope'],
      message: 'legacy import scope must pin its parent and candidate ref',
    });
  }
  if (
    bundle.eventScope.trustDomain
    !== bundle.effectiveTrust.encryptionDomain
  ) {
    context.addIssue({
      code: 'custom',
      path: ['effectiveTrust'],
      message: 'legacy import scope and storage trust domains must agree',
    });
  }
  if (bundle.mappings.some(
    (mapping) => mapping.selectedJournalEventIds.some(
      (eventId) => !bundle.selectedJournalEventIds.includes(eventId),
    ),
  )) {
    context.addIssue({
      code: 'custom',
      path: ['mappings'],
      message: 'mapping events must be selected by the candidate commit',
    });
  }
  const heritagePlan = bundle.rootPlans[4];
  if (heritagePlan.curationEventRef.objectId !== heritagePlan.curationEventId) {
    context.addIssue({
      code: 'custom',
      path: ['rootPlans', 4, 'curationEventRef'],
      message: 'Heritage plan must reference its exact curation event object',
    });
  }
  if (
    !bundle.selectedJournalEventIds.includes(
      heritagePlan.migrationJournalEventId,
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['rootPlans', 4, 'migrationJournalEventId'],
      message: 'migration journal event must be selected by the commit',
    });
  }
  const epistemicPlan = bundle.rootPlans[0];
  const negativePlan = bundle.rootPlans[7];
  if (
    epistemicPlan.proposalRef.objectId
    !== negativePlan.proposalRef.objectId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['rootPlans', 7, 'proposalRef'],
      message: 'both Corpus roots must use one exact stored owner proposal',
    });
  }
  const mappingIdsFor = (
    kinds: LegacyProjectionKind[],
  ): ObjectId[] => bundle.mappings
    .filter((mapping) => kinds.includes(mapping.projection.kind))
    .map((mapping) => mapping.mappingId);
  const sameOrderedIds = (left: ObjectId[], right: ObjectId[]): boolean =>
    left.length === right.length
    && left.every((value, index) => value === right[index]);
  const ownerCoverage = [
    {
      pathIndex: 0,
      expected: mappingIdsFor(['evidence_source', 'legacy_claim']),
      actual: epistemicPlan.proposal.mappingIds,
    },
    {
      pathIndex: 1,
      expected: mappingIdsFor(['legacy_question']),
      actual: bundle.rootPlans[1].proposal.mappingIds,
    },
    {
      pathIndex: 5,
      expected: mappingIdsFor([
        'legacy_claim',
        'legacy_question',
        'legacy_topology',
        'process_history',
      ]),
      actual: bundle.rootPlans[5].proposal.mappingIds,
    },
    {
      pathIndex: 8,
      expected: mappingIdsFor(['legacy_artifact']),
      actual: bundle.rootPlans[8].proposal.mappingIds,
    },
  ];
  for (const coverage of ownerCoverage) {
    if (!sameOrderedIds(coverage.expected, coverage.actual)) {
      context.addIssue({
        code: 'custom',
        path: ['rootPlans', coverage.pathIndex, 'proposal', 'mappingIds'],
        message: 'owner proposal mapping coverage differs from frozen matrix',
      });
    }
  }
});

export const StagedImportSchema = z.object({
  schema: z.literal('cosmo.staged-import.v1'),
  stagedImportId: ObjectIdSchema,
  migrationId: z.string().min(1),
  sourceFixtureId: Sha256Schema,
  sourceCatalogId: Sha256Schema,
  casebookBundleId: Sha256Schema,
  casebookManifestId: ObjectIdSchema,
  parentCommitId: BrainCommitIdSchema,
  candidateRef: BrainRefNameSchema,
  stagedObjectIds: z.array(ObjectIdSchema),
  mappingIds: z.array(ObjectIdSchema),
  rejectedRecordIds: z.array(ObjectIdSchema),
  quarantinedRecordIds: z.array(ObjectIdSchema),
  classCounts: z.record(
    LegacyImportClassSchema,
    z.number().int().nonnegative(),
  ),
  sourceRecordCount: z.number().int().nonnegative(),
  reconciliationRef: ObjectRefSchema,
  reconciliationHash: Sha256Schema,
  proposalBundleRef: ObjectRefSchema,
  proposalBundleId: Sha256Schema,
  status: z.literal('reconciled'),
}).strict();

export const PublishStagedImportInputSchema = z.object({
  schema: z.literal('cosmo.publish-staged-import-input.v1'),
  stagedImportRef: ObjectRefSchema,
  stagedImport: StagedImportSchema,
  proposalBundleRef: ObjectRefSchema,
  proposalBundle: LegacyImportCandidateProposalBundleSchema,
  parentCommitId: BrainCommitIdSchema,
  candidateRef: BrainRefNameSchema.refine(
    (ref) => ref.startsWith('refs/heads/imports/'),
  ),
  expectedCandidateHead: z.null(),
  authorization: MutationAuthorizationSchema,
  lease: LeaseProofSchema,
  idempotencyKey: Sha256Schema,
  publishedAt: z.string().datetime(),
}).strict().superRefine((input, context) => {
  const staged = input.stagedImport;
  const bundle = input.proposalBundle;
  if (
    input.stagedImportRef.objectId !== staged.stagedImportId
    || input.proposalBundleRef.objectId !== bundle.bundleId
    || staged.proposalBundleRef.objectId !== bundle.bundleId
    || staged.proposalBundleId !== bundle.bundleId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['proposalBundleRef'],
      message: 'stored staging and proposal identities must agree',
    });
  }
  if (
    input.parentCommitId !== staged.parentCommitId
    || input.parentCommitId !== bundle.parentCommitId
    || input.candidateRef !== staged.candidateRef
    || input.candidateRef !== bundle.candidateRef
  ) {
    context.addIssue({
      code: 'custom',
      path: ['candidateRef'],
      message: 'publish parent and candidate must equal staged proposal pins',
    });
  }
  for (const field of [
    'sourceFixtureId',
    'sourceCatalogId',
    'casebookBundleId',
    'casebookManifestId',
  ] as const) {
    if (staged[field] !== bundle[field]) {
      context.addIssue({
        code: 'custom',
        path: ['proposalBundle', field],
        message: 'staging and proposal source identities must agree',
      });
    }
  }
});

export const LegacyImportCandidateReceiptSchema = z.object({
  schema: z.literal('cosmo.legacy-import-candidate-receipt.v1'),
  receiptId: ObjectIdSchema,
  migrationId: z.string().min(1),
  proposalBundleId: Sha256Schema,
  parentCommitId: BrainCommitIdSchema,
  candidateRef: BrainRefNameSchema,
  previousCandidateHead: z.null(),
  candidateBrainCommitId: BrainCommitIdSchema,
  rootRefs: z.object({
    epistemicRoot: ObjectRefSchema,
    questionRoot: ObjectRefSchema,
    programRoot: ObjectRefSchema,
    relationshipRoot: ObjectRefSchema,
    heritageRoot: ObjectRefSchema,
    topologyRoot: ObjectRefSchema,
    activationRoot: ObjectRefSchema,
    negativeKnowledgeRoot: ObjectRefSchema,
    artifactIndexRoot: ObjectRefSchema,
  }).strict(),
  mappingIds: z.array(ObjectIdSchema).min(1),
  selectedJournalEventIds: z.array(EventIdSchema).min(1),
  journalRange: JournalRangeSchema,
  heritageCurationEventId: ObjectIdSchema,
  migrationJournalEventId: EventIdSchema,
  commitAdvanceTransactionId: Sha256Schema,
  idempotencyKey: Sha256Schema,
  canonicalRefAdvanceCount: z.literal(0),
  canonicalPromotionCount: z.literal(0),
  committedAt: z.string().datetime(),
}).strict().superRefine((receipt, context) => {
  if (!receipt.selectedJournalEventIds.includes(
    receipt.migrationJournalEventId,
  )) {
    context.addIssue({
      code: 'custom',
      path: ['migrationJournalEventId'],
      message: 'candidate receipt must select its migration journal event',
    });
  }
});

export type LegacyImportMapping =
  z.infer<typeof LegacyImportMappingSchema>;
export type LegacyCorpusMapping =
  z.infer<typeof LegacyCorpusMappingSchema>;
export type BuildLegacyCorpusImportProposalInput =
  z.infer<typeof BuildLegacyCorpusImportProposalInputSchema>;
export type LegacyCorpusImportProposal =
  z.infer<typeof LegacyCorpusImportProposalSchema>;
export type LegacyCorpusImportProposalBuildResult =
  z.infer<typeof LegacyCorpusImportProposalBuildResultSchema>;
export type LegacyQuestionMapping =
  z.infer<typeof LegacyQuestionMappingSchema>;
export type BuildLegacyQuestionBatchProposalInput =
  z.infer<typeof BuildLegacyQuestionBatchProposalInputSchema>;
export type LegacyQuestionBatchProposal =
  z.infer<typeof LegacyQuestionBatchProposalSchema>;
export type LegacyQuestionBatchProposalBuildResult =
  z.infer<typeof LegacyQuestionBatchProposalBuildResultSchema>;
export type LegacyArtifactMapping =
  z.infer<typeof LegacyArtifactMappingSchema>;
export type BuildArtifactIndexBatchUpdateProposalInput =
  z.infer<typeof BuildArtifactIndexBatchUpdateProposalInputSchema>;
export type ArtifactIndexBatchUpdateProposal =
  z.infer<typeof ArtifactIndexBatchUpdateProposalSchema>;
export type ArtifactIndexBatchUpdateProposalBuildResult =
  z.infer<typeof ArtifactIndexBatchUpdateProposalBuildResultSchema>;
export type LegacyTopologyMapping =
  z.infer<typeof LegacyTopologyMappingSchema>;
export type BuildLegacyTopologyImportProposalInput =
  z.infer<typeof BuildLegacyTopologyImportProposalInputSchema>;
export type LegacyTopologyImportProposal =
  z.infer<typeof LegacyTopologyImportProposalSchema>;
export type LegacyTopologyImportProposalBuildResult =
  z.infer<typeof LegacyTopologyImportProposalBuildResultSchema>;
export type LegacyImportCandidateProposalBundle =
  z.infer<typeof LegacyImportCandidateProposalBundleSchema>;
export type StagedImport = z.infer<typeof StagedImportSchema>;
export type PublishStagedImportInput =
  z.infer<typeof PublishStagedImportInputSchema>;
export type LegacyImportCandidateReceipt =
  z.infer<typeof LegacyImportCandidateReceiptSchema>;
```

`bundleId` is exactly
`sha256(canonicalJsonBytes(proposalBundle with bundleId omitted))`; publication
recomputes it from the parsed bundle before loading any proposal. `mappings`
are sorted by unique `mappingId`; each mapping's destination root kinds,
destination object refs, evidence spans, and selected events are duplicate-free
and canonically ordered. Bundle, owner proposal, candidate receipt, and
migration-receipt `selectedJournalEventIds` are the same unique ordered list.
Staged object, mapping, rejected, and quarantined ID arrays are individually
unique and ordered, mutually disjoint where their accounting classes differ,
and reconcile exactly to the source-record ledger. Candidate-receipt
`mappingIds` equal the bundle mapping IDs in the same order. A changed order,
duplicate, missing member, alternate canonical encoding, proposal object/ref
mismatch, or bundle hash mismatch fails before mutation.

Each of the four bridge input schemas additionally super-refines equal
`mappingRefs`/`mappings` lengths, canonical unique ordering, paired
`mappingRef.objectId === mapping.mappingId`, one shared exact B scope, and one
shared trust descriptor. Each build-result schema recomputes
`proposalRef.objectId` from the canonical proposal bytes and rejects an
alternate media type or byte length. A zero-length owner subset is valid only
as the deterministic no-op form described in Task 5; the overall bundle still
requires at least one imported mapping and its separate migration journal
event.

The bundle coverage matrix is also exact: Corpus receives every and only
`evidence_source`/`legacy_claim` mapping; Question receives every and only
`legacy_question`; Artifact receives every and only `legacy_artifact`;
Topology receives every and only `legacy_claim`/`legacy_question`/
`legacy_topology`/`process_history`; and Heritage links every mapping,
including `heritage_only`. Program, Relationship, and Activation receive none.
The same mapping may intentionally appear in two owner proposals only where
that frozen projection/destination tuple names both roots. Missing, extra, or
wrong-owner membership rejects the bundle.

Task 1 defines and exports the single
`LegacyCorpusImportProposalSchema`,
`LegacyQuestionBatchProposalSchema`,
`ArtifactIndexBatchUpdateProposalSchema`, and
`LegacyTopologyImportProposalSchema` identities from
`packages/contracts/src/migration.ts` before the bundle schema references them.
These are G-owned bridge contracts; Programs C, D, and E later implement their
owner-specific builders behind the exact imported DTOs and may not redeclare,
extend, or replace a schema. This sequencing creates no dependency from an
owner package back into migration. Likewise,
`LegacyImportBrainLineageEventScopeSchema` is one strict type-predicate
refinement directly over Program B's exact
`BrainLineageEventScopeSchema` object: it preserves the B branch identity and
adds only the import-specific `programId=null` rule. The bundle and all four
bridge DTOs reuse that one refinement. G defines no scope object lookalike,
codec, or alternate normalization.

- [ ] **Step 4: Freeze one dimension enum and the profile root schema**

`AcceptanceDimensionIdSchema` is the only dimension vocabulary in Programs G and H. Proof runners, profile validation, scorecards, and receipts import it rather than declaring local arrays.

```ts
export const AcceptanceDimensionIdSchema = z.enum([
  'evidence_integrity',
  'provenance_completeness',
  'continuity_and_resumability',
  'factual_recall',
  'cross_domain_connection_quality',
  'productive_novelty',
  'contradiction_discovery',
  'question_generation_and_maturation',
  'negative_knowledge_retention',
  'depth_behind_artifacts',
  'idea_formation_explainability',
  'perspective_diversity',
  'covenant_usefulness',
  'research_relationship_fidelity',
  'sleep_dream_cognitive_effect',
  'merge_federation_quality',
  'autonomy_health',
  'guided_task_fidelity',
  'artifact_quality',
  'resource_efficiency',
  'operational_reliability',
]);

export const FirstReleaseMandatoryDimensionIds = [
  'evidence_integrity',
  'provenance_completeness',
  'continuity_and_resumability',
  'cross_domain_connection_quality',
  'question_generation_and_maturation',
  'depth_behind_artifacts',
  'sleep_dream_cognitive_effect',
  'autonomy_health',
  'guided_task_fidelity',
  'operational_reliability',
] as const satisfies readonly AcceptanceDimensionId[];

export const AcceptanceExecutionRoleSchema = z.enum([
  'candidate_autonomous',
  'candidate_guided',
  'candidate_pure',
  'principal_researcher',
  'default_mode_proposal_generator',
  'consolidation_dream_generator',
  'independent_challenger',
  'inquiry_generator',
  'independent_verifier',
  'historical_cosmo_baseline',
  'strong_single_session_baseline',
]);

export const AcceptanceExecutionIdentitySchema = z.object({
  schema: z.literal('cosmo.acceptance-execution-identity.v1'),
  identityId: Sha256Schema,
  role: AcceptanceExecutionRoleSchema,
  implementationArtifactId: Sha256Schema,
  provider: z.string().min(1),
  model: z.string().min(1),
  runtimeAdapter: z.string().min(1),
  executionClass: z.enum([
    'live_provider',
    'deterministic_conformance',
    'recorded_conformance',
    'replay',
    'mock',
  ]),
  transport: z.string().min(1),
  providerFallback: z.null(),
  configurationObjectId: ObjectIdSchema,
  promptIdentityObjectId: ObjectIdSchema,
  contextConfigurationObjectId: ObjectIdSchema,
  toolRegistryObjectId: ObjectIdSchema,
  credentialBindingKeyId: Sha256Schema,
  signerPrincipalId: Sha256Schema,
  processSessionIdentityId: Sha256Schema,
  signatures: z.array(DetachedSignatureSchema).min(1),
}).strict();

export const RequiredHistoricalCaseIdSchema = z.enum([
  'original-deep-code-self-audit',
  'autoscombo2',
  'jerryg',
  'standalone-jerryshows',
  'june-30-controlled-receipt',
  'degraded-home23',
  'old-new-jtr-brains',
  'terrapin-collapse',
  'bigmerge-cross-domain',
  'catastrophic-stem-humanities-aesthetic-merges',
  'menlo-park-zero-metrics',
  'truncated-checkpoint-unicode',
  'clawd-openclaw-continuity',
  'subject-brain-federation-merge',
]);

export type RequiredHistoricalCaseId =
  z.infer<typeof RequiredHistoricalCaseIdSchema>;

export const RequiredReleaseScenarioIdSchema = z.enum([
  'g.repository.genesis-brain.v1',
  'g.autonomous.sustained-observe-only.v1',
  'g.guided.satisfiable.v1',
  'g.guided.deliberately-blocked.v1',
  'g.pure.open-question.v1',
  'g.inquiry.brain-over-files.v1',
  'g.discovery.live-new-evidence.v1',
  'g.discovery.fresh-nonce-canary.v1',
  'g.metabolism.paired-sleep.v1',
  'g.relationship.export-import.v1',
  'g.negative-knowledge.dead-end.v1',
  'g.self-research.causal-origin.v1',
  'g.repository.union-materialization.v1',
  'g.repository.encrypted-restricted-export.v1',
  'g.git-for-brains.status-log-tag-settle-wake.v1',
]);

export type RequiredReleaseScenarioId =
  z.infer<typeof RequiredReleaseScenarioIdSchema>;

export const AcceptanceProfileSchema = z.object({
  schema: z.literal('cosmo.acceptance-profile.v1'),
  profileId: Sha256Schema,
  governingSpecHash: Sha256Schema,
  requiredHistoricalCaseManifestId: Sha256Schema,
  requiredHistoricalCaseIds: z.array(RequiredHistoricalCaseIdSchema).length(14),
  fixtureManifestIds: z.array(Sha256Schema).min(1),
  startingBrainCommitIds: z.array(BrainCommitIdSchema).min(1),
  corpusSnapshotIds: z.array(CorpusSnapshotIdSchema).min(1),
  journalRanges: z.array(JournalRangeSchema).min(1),
  artifactSetManifest: ObjectRefSchema,
  covenantCommitId: BrainCommitIdSchema,
  evidencePolicyIds: z.array(ObjectIdSchema).min(1),
  promptIdentityManifest: ObjectRefSchema,
  toolIdentityManifest: ObjectRefSchema,
  seedManifest: ObjectRefSchema,
  hiddenOracleCommitments: ObjectRefSchema,
  interventionSchedule: ObjectRefSchema,
  executionIdentities: ObjectRefSchema,
  productionExecutionRequirements: ObjectRefSchema,
  budgets: ObjectRefSchema,
  baselineIds: z.array(Sha256Schema).length(2),
  candidateBaselineParity: ObjectRefSchema,
  pairedTrialCount: z.number().int().min(3),
  hardGates: ObjectRefSchema,
  vectorThresholds: ObjectRefSchema,
  scorerIdentities: ObjectRefSchema,
  nondeterminismPolicy: ObjectRefSchema,
  statisticalMethods: ObjectRefSchema,
  nonRegressionRules: ObjectRefSchema,
  humanReviewProtocol: ObjectRefSchema,
  environmentPolicy: ObjectRefSchema,
  signatures: z.array(DetachedSignatureSchema).min(1),
}).strict().superRefine((profile, context) => {
  if (!sameSet(
    profile.requiredHistoricalCaseIds,
    RequiredHistoricalCaseIdSchema.options,
  )) {
    context.addIssue({
      code: 'custom',
      path: ['requiredHistoricalCaseIds'],
      message: 'all fourteen required historical cases must appear exactly once',
    });
  }
  if (profile.pairedTrialCount !== 3) {
    context.addIssue({
      code: 'custom',
      path: ['pairedTrialCount'],
      message: 'first-release paired trial count is exactly three',
    });
  }
});

export const SignedAcceptanceProfileSchema = AcceptanceProfileSchema;
```

This field list and order are byte-for-byte identical to the master `AcceptanceProfile` contract. `SignedAcceptanceProfile` is a type alias of `AcceptanceProfile`; no package-local extension may add, remove, or rename a root field. `AcceptanceProfileSchema`, its inferred type, `RequiredHistoricalCaseIdSchema`, `RequiredHistoricalCaseId`, `RequiredReleaseScenarioIdSchema`, `RequiredReleaseScenarioId`, the dimension enum, and the mandatory subset are exported from `packages/contracts/src/index.ts`.

- [ ] **Step 5: Define signed trial and release receipt schemas**

```ts
export const AcceptanceScenarioClassSchema = z.enum([
  'structural_conformance',
  'fault_injection',
  'semantic_release',
]);
export type AcceptanceScenarioClass =
  z.infer<typeof AcceptanceScenarioClassSchema>;

export const RequiredReleaseScenarioClassById = {
  'g.repository.genesis-brain.v1': 'structural_conformance',
  'g.autonomous.sustained-observe-only.v1': 'semantic_release',
  'g.guided.satisfiable.v1': 'semantic_release',
  'g.guided.deliberately-blocked.v1': 'semantic_release',
  'g.pure.open-question.v1': 'semantic_release',
  'g.inquiry.brain-over-files.v1': 'semantic_release',
  'g.discovery.live-new-evidence.v1': 'semantic_release',
  'g.discovery.fresh-nonce-canary.v1': 'semantic_release',
  'g.metabolism.paired-sleep.v1': 'semantic_release',
  'g.relationship.export-import.v1': 'structural_conformance',
  'g.negative-knowledge.dead-end.v1': 'semantic_release',
  'g.self-research.causal-origin.v1': 'semantic_release',
  'g.repository.union-materialization.v1': 'structural_conformance',
  'g.repository.encrypted-restricted-export.v1':
    'structural_conformance',
  'g.git-for-brains.status-log-tag-settle-wake.v1': 'fault_injection',
} as const satisfies Record<
  RequiredReleaseScenarioId,
  AcceptanceScenarioClass
>;

export const TrialScheduleIdentitySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('paired'),
    pairId: Sha256Schema,
    replicate: z.number().int().min(1).max(3),
    arm: z.enum(['candidate', 'baseline']),
  }).strict(),
  z.object({
    kind: z.literal('unpaired'),
    scheduleEntryId: Sha256Schema,
  }).strict(),
]);
export type TrialScheduleIdentity =
  z.infer<typeof TrialScheduleIdentitySchema>;

export const TrialReceiptSchema = z.object({
  schema: z.literal('cosmo.acceptance-trial.v1'),
  trialId: Sha256Schema,
  profileId: Sha256Schema,
  resolvedProfileObjectIds: z.array(ObjectIdSchema).length(18),
  scenarioId: RequiredReleaseScenarioIdSchema,
  scenarioClass: AcceptanceScenarioClassSchema,
  caseId: RequiredHistoricalCaseIdSchema,
  schedule: TrialScheduleIdentitySchema,
  fixtureManifestId: Sha256Schema,
  candidateId: Sha256Schema,
  baselineId: Sha256Schema.nullable(),
  candidateSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  coreArtifactSetId: Sha256Schema,
  executionIdentityIds: z.array(Sha256Schema).min(1),
  startingCommitId: BrainCommitIdSchema,
  endingCommitId: BrainCommitIdSchema,
  status: z.enum(['passed', 'failed', 'interrupted']),
  hardGateResultsRef: ObjectRefSchema,
  vectorResultsRef: ObjectRefSchema,
  environmentTraceRef: ObjectRefSchema,
  providerRuntimeReceiptRefs: z.array(ObjectRefSchema).min(1),
  externalObserverReceiptRef: ObjectRefSchema,
  causalOriginAttestationRef: ObjectRefSchema.nullable(),
  humanReviewReceiptRef: ObjectRefSchema.nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  signatures: z.array(DetachedSignatureSchema).min(1),
}).strict().superRefine((receipt, context) => {
  if (
    receipt.scenarioClass
    !== RequiredReleaseScenarioClassById[receipt.scenarioId]
  ) {
    context.addIssue({
      code: 'custom',
      path: ['scenarioClass'],
      message: 'release scenario class differs from the frozen mapping',
    });
  }
  if (receipt.schedule.kind === 'paired' && receipt.baselineId === null) {
    context.addIssue({
      code: 'custom',
      path: ['baselineId'],
      message: 'a paired trial names its frozen baseline',
    });
  }
  if (receipt.schedule.kind === 'unpaired' && receipt.baselineId !== null) {
    context.addIssue({
      code: 'custom',
      path: ['baselineId'],
      message: 'an unpaired trial has no baseline',
    });
  }
});

export const MigrationReceiptSchema = z.object({
  schema: z.literal('cosmo.migration-receipt.v1'),
  migrationId: z.string().min(1),
  sourceFixtureId: Sha256Schema,
  sourceCatalogId: Sha256Schema,
  casebookBundleId: Sha256Schema,
  casebookManifestId: ObjectIdSchema,
  sourceRecordCount: z.number().int().nonnegative(),
  importedCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  quarantinedCount: z.number().int().nonnegative(),
  classCounts: z.record(LegacyImportClassSchema, z.number().int().nonnegative()),
  targetBranch: BrainRefNameSchema,
  previousHead: BrainCommitIdSchema.nullable(),
  resultingHead: BrainCommitIdSchema,
  proposalBundleId: Sha256Schema,
  candidateReceiptRef: ObjectRefSchema,
  candidateBrainCommitId: BrainCommitIdSchema,
  rootRefs: LegacyImportCandidateReceiptSchema.shape.rootRefs,
  selectedJournalEventIds: z.array(EventIdSchema).min(1),
  journalRange: JournalRangeSchema,
  heritageCurationEventId: ObjectIdSchema,
  migrationJournalEventId: EventIdSchema,
  commitAdvanceTransactionId: Sha256Schema,
  legacyUnverifiedMappingCount: z.number().int().nonnegative(),
  canonicalRefAdvanceCount: z.literal(0),
  canonicalPromotionCount: z.literal(0),
  reconciliationHash: Sha256Schema,
  publishedAt: z.string().datetime(),
  signatures: z.array(DetachedSignatureSchema).min(1),
}).strict().superRefine((receipt, context) => {
  if (
    receipt.sourceRecordCount
    !== receipt.importedCount + receipt.rejectedCount + receipt.quarantinedCount
  ) {
    context.addIssue({
      code: 'custom',
      path: ['sourceRecordCount'],
      message: 'source accounting must reconcile exactly',
    });
  }
  if (
    receipt.previousHead !== null
    || receipt.resultingHead !== receipt.candidateBrainCommitId
    || !receipt.targetBranch.startsWith('refs/heads/imports/')
  ) {
    context.addIssue({
      code: 'custom',
      path: ['targetBranch'],
      message: 'migration publishes only one absent import-candidate ref',
    });
  }
  if (receipt.legacyUnverifiedMappingCount !== receipt.importedCount) {
    context.addIssue({
      code: 'custom',
      path: ['legacyUnverifiedMappingCount'],
      message: 'every imported mapping remains legacy_unverified',
    });
  }
  if (!receipt.selectedJournalEventIds.includes(
    receipt.migrationJournalEventId,
  )) {
    context.addIssue({
      code: 'custom',
      path: ['migrationJournalEventId'],
      message: 'migration receipt must select its journal event',
    });
  }
});

export const CoreArtifactFileSchema = z.object({
  logicalPath: z.string().regex(
    /^(?:packages\/[a-z0-9-]+\/dist|apps\/workbench\/dist)\/[A-Za-z0-9._/-]+$/,
  ),
  sha256: Sha256Schema,
  byteLength: z.number().int().nonnegative(),
  mode: z.number().int().min(0).max(0o777),
}).strict();

export const CoreArtifactSetSchema = z.object({
  schema: z.literal('cosmo.core-artifact-set.v1'),
  files: z.array(CoreArtifactFileSchema).min(1),
}).strict();

export const HardGateIdSchema = z.enum([
  'unsupported_fact_presented_as_sourced',
  'citation_does_not_entail_claim',
  'worker_direct_canonical_mutation',
  'candidate_event_loss',
  'non_atomic_or_unrecoverable_commit',
  'merge_loss_or_rights_deletion',
  'fabricated_ancestry',
  'dream_or_speculation_promoted_as_fact',
  'ordinary_query_mutated_brain',
  'runtime_checkpoint_treated_as_commit',
  'hidden_provider_fallback',
  'completion_without_declared_criteria',
  'rights_or_sensitivity_violation',
  'source_prompt_injection_changed_authority',
  'crash_resume_duplicate_promotion',
  'accepted_answer_not_reconstructable',
  'home23_dependency_in_acceptance_path',
  'corruption_hidden_by_healthy_status',
  'new_evidence_discovery_acquisition_failed',
]);

export const HardGateResultSchema = z.object({
  schema: z.literal('cosmo.hard-gate-result.v1'),
  gateId: HardGateIdSchema,
  requiredScenarioIds: z.array(RequiredReleaseScenarioIdSchema).min(1),
  status: z.enum(['pass', 'fail']),
  oracle: z.enum([
    'exact_count',
    'exact_identity',
    'external_reconstruction',
    'signed_policy',
    'absence_proof',
  ]),
  trialReceiptIds: z.array(ObjectIdSchema).min(1),
  oracleReceiptRefs: z.array(ObjectRefSchema).min(1),
  externalVerifierReceiptRef: ObjectRefSchema,
  violationIds: z.array(z.string().min(1)),
}).strict().superRefine((result, context) => {
  if (result.status === 'pass' && result.violationIds.length !== 0) {
    context.addIssue({
      code: 'custom',
      path: ['violationIds'],
      message: 'a passing hard gate has no violations',
    });
  }
});

export const DiscoveryAcquisitionResultSchema = z.object({
  schema: z.literal('cosmo.discovery-acquisition-result.v1'),
  scenarioId: z.enum([
    'g.discovery.fresh-nonce-canary.v1',
    'g.discovery.live-new-evidence.v1',
  ]),
  status: z.enum(['pass', 'fail']),
  startingBrainCommitId: BrainCommitIdSchema,
  endingBrainCommitId: BrainCommitIdSchema,
  startingCorpusSnapshotIds: z.array(CorpusSnapshotIdSchema).min(1),
  discoveryQueryReceiptRefs: z.array(ObjectRefSchema).min(1),
  selectedResultLocators: z.array(z.string().min(1)).min(1),
  acquisitions: z.array(z.object({
    acquisitionReceiptRef: ObjectRefSchema,
    sourceLocator: z.string().min(1),
    tlsPeerSha256: Sha256Schema,
    hostname: z.string().min(1),
    retrievedAt: z.string().datetime(),
    byteSha256: Sha256Schema,
    byteLength: z.number().int().positive(),
    sourceSnapshotId: ObjectIdSchema,
    evidenceSpanIds: z.array(ObjectIdSchema).min(1),
  }).strict()).min(1),
  candidateFindingIds: z.array(ObjectIdSchema).min(1),
  independentReviewFindingIds: z.array(ReviewFindingIdSchema).min(1),
  principalDecisionIds: z.array(ObjectIdSchema).min(1),
  candidateEventIds: z.array(EventIdSchema).min(1),
  reviewEventIds: z.array(EventIdSchema).min(1),
  principalEventIds: z.array(EventIdSchema).min(1),
  promotedClaimIds: z.array(ClaimIdSchema).min(1),
  finalInquiryReceiptRef: ObjectRefSchema,
  externalReconstructionReceiptRef: ObjectRefSchema,
  sourceAbsentFromStartingCorpus: z.literal(true),
  nonceAbsentFromStartingInputs: z.boolean().nullable(),
  violationIds: z.array(z.string().min(1)),
}).strict().superRefine((result, context) => {
  if (
    result.status === 'pass'
    && (
      result.violationIds.length !== 0
      || (
        result.scenarioId === 'g.discovery.fresh-nonce-canary.v1'
        && result.nonceAbsentFromStartingInputs !== true
      )
      || (
        result.scenarioId === 'g.discovery.live-new-evidence.v1'
        && result.acquisitions.length < 3
      )
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'passing discovery requires its full scenario-specific chain',
    });
  }
});

export const BrainOverFilesResultSchema = z.object({
  schema: z.literal('cosmo.brain-over-files-result.v1'),
  status: z.enum(['pass', 'fail']),
  pinnedBrainCommitId: BrainCommitIdSchema,
  pinnedJournalRange: JournalRangeSchema,
  pinnedCorpusSnapshotIds: z.array(CorpusSnapshotIdSchema).min(1),
  pinnedArtifactIndexRoot: ObjectRefSchema,
  pinnedRefName: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/),
  refValueBefore: BrainCommitIdSchema,
  refValueAfter: BrainCommitIdSchema,
  artifactAccessDisabled: z.literal(true),
  networkAccessDisabled: z.literal(true),
  mutationToolsDisabled: z.literal(true),
  assertions: z.array(z.object({
    assertionId: ObjectIdSchema,
    assertionType: z.enum([
      'accumulated_cognition',
      'new_connection_in_answer',
      'artifact_only',
      'unsupported',
    ]),
    preQueryEventIds: z.array(EventIdSchema),
    formationTraceRef: ObjectRefSchema.nullable(),
    evidenceSpanIds: z.array(ObjectIdSchema),
    accumulatedCognitionCredit: z.number().min(0).max(1),
  }).strict()).min(1),
  preQueryLineageProofRef: ObjectRefSchema,
  inquiryReceiptRef: ObjectRefSchema,
  violationIds: z.array(z.string().min(1)),
}).strict().superRefine((result, context) => {
  if (
    result.status === 'pass'
    && (
      result.violationIds.length !== 0
      || result.refValueBefore !== result.refValueAfter
      || result.assertions.some((assertion) =>
        assertion.assertionType === 'accumulated_cognition'
        && (
          assertion.preQueryEventIds.length === 0
          || assertion.formationTraceRef === null
        )
      )
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'passing brain-over-files requires unchanged ref and pre-query lineage',
    });
  }
});

export const ContinuityResultSchema = z.object({
  schema: z.literal('cosmo.continuity-result.v1'),
  caseId: RequiredHistoricalCaseIdSchema,
  continuityClass: z.enum([
    'identity_preserving',
    'continuation_compatible',
    'transformational',
  ]),
  oracle: z.enum([
    'exact_commit',
    'exact_journal_prefix',
    'complete_union_closure',
    'traceable_child',
    'degraded_read_only',
  ]),
  status: z.enum(['pass', 'fail']),
  startingCommitIds: z.array(BrainCommitIdSchema).min(1),
  endingCommitIds: z.array(BrainCommitIdSchema).min(1),
  startingJournalCursor: JournalCursorSchema,
  endingJournalCursor: JournalCursorSchema,
  operationReceiptRefs: z.array(ObjectRefSchema).min(1),
  oracleReceiptRef: ObjectRefSchema,
  executionIdentityReceiptRefs: z.array(ObjectRefSchema),
  violationIds: z.array(z.string().min(1)),
}).strict().superRefine((result, context) => {
  if (result.status === 'pass' && result.violationIds.length !== 0) {
    context.addIssue({
      code: 'custom',
      path: ['violationIds'],
      message: 'a passing continuity result has no violations',
    });
  }
});

export const GenesisBrainAcceptanceResultSchema = z.object({
  schema: z.literal('cosmo.genesis-brain-acceptance-result.v1'),
  scenarioId: z.literal('g.repository.genesis-brain.v1'),
  status: z.enum(['pass', 'fail']),
  genesisDraftRef: ObjectRefSchema,
  genesisBrainReceiptRef: ObjectRefSchema.nullable(),
  genesisBrainReceiptId: ObjectIdSchema.nullable(),
  genesisBrainCommitId: BrainCommitIdSchema.nullable(),
  repositoryVerificationReportRef: ObjectRefSchema,
  exactRetryProofRef: ObjectRefSchema,
  crashRecoveryProofRef: ObjectRefSchema,
  raceProofRef: ObjectRefSchema,
  noModelProofRef: ObjectRefSchema,
  modelCallCount: z.number().int().nonnegative(),
  primarySuccessfulAbsentRefCasCount: z.number().int().nonnegative(),
  raceSuccessfulAbsentRefCasCount: z.number().int().nonnegative(),
  rejectedCompetingCreateCount: z.number().int().nonnegative(),
  violationIds: z.array(z.string().min(1)),
}).strict().superRefine((result, context) => {
  if (
    (result.genesisBrainReceiptRef === null)
    !== (result.genesisBrainReceiptId === null)
    || (
      (result.genesisBrainReceiptRef === null)
      !== (result.genesisBrainCommitId === null)
    )
    || (
      result.genesisBrainReceiptRef !== null
      && result.genesisBrainReceiptRef.objectId
        !== result.genesisBrainReceiptId
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['genesisBrainReceiptRef'],
      message: 'genesis receipt reference must name the exact receipt object',
    });
  }
  if (
    result.status === 'pass'
    && (
      result.violationIds.length !== 0
      || result.genesisBrainReceiptRef === null
      || result.genesisBrainReceiptId === null
      || result.genesisBrainCommitId === null
      || result.modelCallCount !== 0
      || result.primarySuccessfulAbsentRefCasCount !== 1
      || result.raceSuccessfulAbsentRefCasCount !== 1
      || result.rejectedCompetingCreateCount < 1
    )
  ) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'a passing Genesis Brain result has exact model/CAS/race proof',
    });
  }
});

export const CoreIsolationReceiptSchema = z.object({
  schema: z.literal('cosmo.core-isolation-receipt.v1'),
  status: z.enum(['pass', 'fail']),
  coreAcceptedSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  coreArtifactSetId: Sha256Schema,
  staticDependencyGraphRef: ObjectRefSchema,
  observations: z.object({
    loadedFilePaths: z.array(z.string()),
    networkDestinations: z.array(z.string()),
    environmentKeyNames: z.array(z.string()),
    childExecutables: z.array(z.string()),
    serviceDiscoveryTargets: z.array(z.string()),
    mutableStateRoots: z.array(z.string()),
    allowedHistoricalFixturePaths: z.array(z.string()),
  }).strict(),
  structuralProbeReceiptRefs: z.array(ObjectRefSchema).min(1),
  liveSemanticProbeReceiptRefs: z.array(ObjectRefSchema).min(1),
  externalTraceReceiptRef: ObjectRefSchema,
  violationIds: z.array(z.string().min(1)),
}).strict().superRefine((result, context) => {
  if (result.status === 'pass' && result.violationIds.length !== 0) {
    context.addIssue({
      code: 'custom',
      path: ['violationIds'],
      message: 'a passing core-isolation receipt has no violations',
    });
  }
});

export type CoreArtifactSet = z.infer<typeof CoreArtifactSetSchema>;
export type HardGateResult = z.infer<typeof HardGateResultSchema>;
export type DiscoveryAcquisitionResult =
  z.infer<typeof DiscoveryAcquisitionResultSchema>;
export type BrainOverFilesResult = z.infer<typeof BrainOverFilesResultSchema>;
export type ContinuityResult = z.infer<typeof ContinuityResultSchema>;
export type GenesisBrainAcceptanceResult =
  z.infer<typeof GenesisBrainAcceptanceResultSchema>;
export type CoreIsolationReceipt = z.infer<typeof CoreIsolationReceiptSchema>;

export const ReleaseAcceptanceReceiptSchema = z.object({
  schema: z.literal('cosmo.release-acceptance.v1'),
  profileId: Sha256Schema,
  resolvedProfileObjectIds: z.array(ObjectIdSchema).length(18),
  candidateId: Sha256Schema,
  coreAcceptedSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  coreArtifactSetId: Sha256Schema,
  coreArtifactSet: CoreArtifactSetSchema,
  migrationReceiptIds: z.array(ObjectIdSchema).length(14),
  trialReceiptIds: z.array(ObjectIdSchema).min(1),
  startingCommitIds: z.array(BrainCommitIdSchema).min(1),
  endingCommitIds: z.array(BrainCommitIdSchema).min(1),
  hardGateResultsRef: ObjectRefSchema,
  vectorResultsRef: ObjectRefSchema,
  casebookResultsRef: ObjectRefSchema,
  ablationResultsRef: ObjectRefSchema,
  continuityResultsRef: ObjectRefSchema,
  genesisBrainResultRef: ObjectRefSchema,
  coreIsolationReceiptRef: ObjectRefSchema,
  brainOverFilesResultRef: ObjectRefSchema,
  discoveryAcquisitionReceiptRefs: z.array(ObjectRefSchema).length(2),
  executionIdentityReceiptRefs: z.array(ObjectRefSchema).length(11),
  externalObserverReceiptRefs: z.array(ObjectRefSchema).min(1),
  humanReviewReceiptRef: ObjectRefSchema,
  hardGateViolationIds: z.array(z.string().min(1)),
  status: z.enum(['accepted', 'rejected']),
  issuedAt: z.string().datetime(),
  signatures: z.array(DetachedSignatureSchema).min(1),
}).strict().superRefine((receipt, context) => {
  if (receipt.status === 'accepted' && receipt.hardGateViolationIds.length !== 0) {
    context.addIssue({
      code: 'custom',
      path: ['hardGateViolationIds'],
      message: 'an accepted release has zero hard-gate violations',
    });
  }
});
```

`coreArtifactSetId = sha256(canonicalJsonBytes(coreArtifactSet))`; `coreArtifactSet.files` is sorted by unique `logicalPath` and covers the compiled Programs B–F core, the exact Program F workbench assets exercised by G, and the compiled G core-candidate entrypoint used to compose them. It excludes source files, the acceptance scorer/harness, and package manifests that Program H later stages or rewrites. Publication recomputes the ID, parses all 14 referenced `MigrationReceipt` objects plus every referenced `HardGateResult`, `DiscoveryAcquisitionResult`, `BrainOverFilesResult`, `ContinuityResult`, `GenesisBrainAcceptanceResult`, and `CoreIsolationReceipt`, and rejects an accepted receipt unless each nested status is `pass`, every required ID appears exactly once, all migration casebook identities reconcile, the Genesis result resolves one exact Program E `GenesisBrainReceipt`, and every referenced object verifies.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
npm test -- tests/migration/contracts.test.ts tests/acceptance/contracts.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/migration.ts packages/contracts/src/acceptance.ts packages/contracts/src/index.ts tests/migration/contracts.test.ts tests/acceptance/contracts.test.ts
git commit -m "feat: define migration and acceptance contracts"
```

---

### Task 2: Build the Read-Only Legacy Adapter Boundary

**Files:**
- Modify: `package-lock.json`
- Create: `packages/migration/package.json`
- Create: `packages/migration/tsconfig.json`
- Create: `packages/migration/src/adapter.ts`
- Create: `packages/migration/src/classify.ts`
- Create: `packages/migration/src/index.ts`
- Create: `tests/migration/adapter.test.ts`
- Create: `tests/migration/classify.test.ts`

**Interfaces:**
- Consumes: strict `CasebookManifest` records from Program A and Program B `ObjectStore`.
- Produces:

```ts
export interface LegacySourceReaderPort {
  manifest(source: LegacySource): Promise<CasebookManifest>;
  readEntry(source: LegacySource, entryId: ObjectId): Promise<Uint8Array>;
}

export interface LegacyAdapter {
  readonly kind: string;
  probe(source: LegacySource): Promise<LegacyProbe>;
  read(source: LegacySource): AsyncIterable<LegacyRecord>;
}

export interface LegacyProbe {
  adapterKind: string;
  sourceFixtureId: Sha256;
  readable: boolean;
  detectedSchemas: string[];
  limitations: string[];
}
```

- [ ] **Step 1: Write a failing no-write adapter test**

```ts
test('adapter reads through fixture handles and has no write surface', async () => {
  const adapter: LegacyAdapter = new FakeLegacyAdapter();
  assert.equal('write' in adapter, false);
  assert.equal('delete' in adapter, false);
  assert.equal('rename' in adapter, false);
});
```

- [ ] **Step 2: Write a failing classification matrix test**

```ts
const cases = [
  ['source bytes plus exact span map', 'evidence_capable'],
  ['brain synthesis with source list only', 'committed_cognition_partial_provenance'],
  ['early graph node without source edge', 'legacy_cognition'],
  ['session jsonl', 'process_history'],
  ['final report docx', 'artifact'],
  ['IP register', 'design_heritage'],
  ['truncated tmp checkpoint', 'corrupt_or_ambiguous'],
] as const;

for (const [description, expected] of cases) {
  test(description, () => {
    assert.equal(classifyLegacyDescriptor(fixture(description)), expected);
  });
}
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
npm test -- tests/migration/adapter.test.ts tests/migration/classify.test.ts
```

Expected: FAIL because the adapter and classifier do not exist.

- [ ] **Step 4: Implement the boundary and exhaustive classifier**

Create `@cosmo/migration` as a private ESM workspace with `build` and `test` scripts using `tsc` and `node ../../scripts/run-tests.mjs test`. Its workspace dependencies are `"@cosmo/contracts": "*"`, `"@cosmo/foundation": "*"`, `"@cosmo/heritage": "*"`, `"@cosmo/repository": "*"`, and `"@cosmo/corpus": "*"`. The development workspace export points at `./src/index.ts`; Program H alone rewrites a staged release copy to `./dist/index.js`.

Run `npm install` immediately after adding the workspace manifest and commit the resulting `package-lock.json`. A plan step that adds a workspace but leaves the lockfile stale is incomplete.

```ts
export function classifyLegacyDescriptor(
  descriptor: LegacyDescriptor
): LegacyImportClass {
  const parsed = LegacyDescriptorSchema.parse(descriptor);
  if (parsed.corrupt || parsed.truncated) return 'corrupt_or_ambiguous';
  if (parsed.kind === 'session' || parsed.kind === 'task') return 'process_history';
  if (parsed.kind === 'artifact') return 'artifact';
  if (parsed.kind === 'design') return 'design_heritage';
  if (parsed.sourceBytes && parsed.exactSpanMap) return 'evidence_capable';
  if (parsed.kind === 'cognition' && parsed.sourceList) {
    return 'committed_cognition_partial_provenance';
  }
  return 'legacy_cognition';
}
```

Every adapter parses `LegacySourceSchema` before resolving its casebook through `LegacySourceReaderPort`; it receives no path, grant, lease, actor, or fence from caller data. Every discovered entry is normalized to `LegacyDescriptorSchema` before classification and every emitted record is parsed through `LegacyRecordSchema`. The injected reader verifies the manifest's canonical object ID, `bundleId`, `payload.sourceCatalogId`, case ID/fixture identity, selected entry set, and content hashes against the exact `casebookManifestId`, `casebookBundleId`, `sourceCatalogId`, and source fixture before returning bytes. Unknown fields at the source, locator, descriptor, content-ref, and record levels fail closed.

- [ ] **Step 5: Verify tests and public exports**

Run:

```bash
npm test -- tests/migration/adapter.test.ts tests/migration/classify.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package-lock.json packages/migration/package.json packages/migration/tsconfig.json packages/migration/src tests/migration
git commit -m "feat: add read-only legacy adapter boundary"
```

---

### Task 3: Implement Original, Unified, and COSMO23 Adapters

**Files:**
- Create: `packages/migration/src/adapters/original-cosmo.ts`
- Create: `packages/migration/src/adapters/unified-cosmo.ts`
- Create: `packages/migration/src/adapters/cosmo23.ts`
- Create: `tests/migration/original-cosmo.test.ts`
- Create: `tests/migration/unified-cosmo.test.ts`
- Create: `tests/migration/cosmo23.test.ts`

**Interfaces:**
- Consumes: portable Program A fixtures for original `new_Coz`, Unified/BrainStudio, standalone 2.3, and Home23-integrated `cosmo23`.
- Produces: `LegacyRecord` streams with exact fixture-relative locators and no inferred parent hashes.

- [ ] **Step 1: Write failing original-COSMO tests**

```ts
test('original nodes without claim evidence stay legacy_unverified', async () => {
  const records = await collect(
    originalCosmoAdapter.read(fixtureSource('original-small-brain'))
  );
  assert.ok(records.length > 0);
  assert.ok(records.every((record) =>
    record.importClass !== 'legacy_cognition'
      || record.epistemicStatus === 'legacy_unverified'
  ));
});
```

- [ ] **Step 2: Write failing lineage-honesty tests**

```ts
test('directory similarity never manufactures a parent', async () => {
  const records = await collect(
    unifiedCosmoAdapter.read(fixtureSource('ambiguous-lineage-pair'))
  );
  assert.ok(records.every((record) => record.claimedParentIds.length === 0));
  assert.ok(records.some((record) =>
    record.limitations.includes('lineage not cryptographically established')
  ));
});
```

- [ ] **Step 3: Write failing COSMO23 separation tests**

```ts
test('cosmo23 runtime receipts do not import as Brain cognition', async () => {
  const records = await collect(
    cosmo23Adapter.read(fixtureSource('home23-degraded-run'))
  );
  const receipt = records.find((record) =>
    record.contentRef.mediaType === 'application/x-cosmo-runtime-receipt'
  );
  assert.equal(receipt?.importClass, 'process_history');
});
```

- [ ] **Step 4: Run the three suites and verify failure**

Run:

```bash
npm test -- tests/migration/original-cosmo.test.ts tests/migration/unified-cosmo.test.ts tests/migration/cosmo23.test.ts
```

Expected: FAIL because adapters are not implemented.

- [ ] **Step 5: Implement streaming adapters with fixture-relative locators**

```ts
function legacyCognitionRecord(
  source: LegacySource,
  entry: LegacyGraphEntry
): LegacyRecord {
  return LegacyRecordSchema.parse({
    schema: 'cosmo.legacy-record.v1',
    sourceRecordId: entry.contentHash,
    sourceFixtureId: source.sourceFixtureId,
    sourceLocator: entry.sourceLocator,
    importClass: 'legacy_cognition',
    contentRef: entry.contentRef,
    claimedParentIds: [],
    evidenceSpanIds: [],
    epistemicStatus: 'legacy_unverified',
    limitations: ['no claim-to-source lineage'],
  });
}
```

- [ ] **Step 6: Add bounded malformed-entry handling**

Malformed entries produce `corrupt_or_ambiguous` records with the fixture path and parser error hash; they do not abort unrelated records and do not emit partial supported claims.

- [ ] **Step 7: Run focused suites and typecheck**

```bash
npm test -- tests/migration/original-cosmo.test.ts tests/migration/unified-cosmo.test.ts tests/migration/cosmo23.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/migration/src/adapters/original-cosmo.ts packages/migration/src/adapters/unified-cosmo.ts packages/migration/src/adapters/cosmo23.ts tests/migration
git commit -m "feat: add historical COSMO adapters"
```

---

### Task 4: Implement Clawd/OpenClaw and BrainStudio Adapters

**Files:**
- Create: `packages/migration/src/adapters/clawd-openclaw.ts`
- Create: `packages/migration/src/adapters/brainstudio.ts`
- Create: `tests/migration/clawd-openclaw.test.ts`
- Create: `tests/migration/brainstudio.test.ts`

**Interfaces:**
- Consumes: Program A JSONL/session/checkpoint and BrainStudio export fixtures.
- Produces: process-history records for transcripts/checkpoints and separately verified cognition records for exported Brain objects.

- [ ] **Step 1: Write failing transcript-separation tests**

```ts
test('surviving transcript text never becomes a supported Claim', async () => {
  const records = await collect(
    clawdOpenClawAdapter.read(fixtureSource('compacted-session'))
  );
  assert.ok(records.every((record) =>
    record.importClass === 'process_history'
    || record.epistemicStatus !== 'supported'
  ));
});
```

- [ ] **Step 2: Write failing BrainStudio checksum tests**

```ts
test('BrainStudio import rejects checksum mismatch', async () => {
  await assert.rejects(
    collect(brainStudioAdapter.read(fixtureSource('bad-export-checksum'))),
    /fixture checksum mismatch/
  );
});
```

- [ ] **Step 3: Run tests and verify failure**

```bash
npm test -- tests/migration/clawd-openclaw.test.ts tests/migration/brainstudio.test.ts
```

Expected: FAIL because adapters are missing.

- [ ] **Step 4: Implement typed transcript and checkpoint parsing**

```ts
function sessionRecord(
  fixtureId: Sha256,
  item: SessionItem
): LegacyRecord {
  return {
    schema: 'cosmo.legacy-record.v1',
    sourceRecordId: item.contentHash,
    sourceFixtureId: fixtureId,
    sourceLocator: {
      ...item.sourceLocator,
      sourceFixtureId: fixtureId,
    },
    importClass: 'process_history',
    contentRef: item.contentRef,
    claimedParentIds: [],
    evidenceSpanIds: [],
    epistemicStatus: 'legacy_unverified',
    limitations: ['transcript continuity is not cognitive promotion'],
  };
}
```

- [ ] **Step 5: Implement checksum-first BrainStudio reading**

Verify export manifest, every named object, and parent identifier representation before yielding records. Unsupported name-based parent fields remain limitations and never become `BrainCommitId`.

- [ ] **Step 6: Verify focused tests**

```bash
npm test -- tests/migration/clawd-openclaw.test.ts tests/migration/brainstudio.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/migration/src/adapters/clawd-openclaw.ts packages/migration/src/adapters/brainstudio.ts tests/migration
git commit -m "feat: separate operational and cognitive legacy imports"
```

---

### Task 5: Stage, Reconcile, and Atomically Publish Imports

**Files:**
- Create: `packages/migration/src/staged-import.ts`
- Create: `packages/migration/src/reconcile.ts`
- Create: `packages/corpus/src/legacy-import-proposal.ts`
- Create: `packages/research/src/legacy-import-proposals.ts`
- Create: `packages/cognition/src/legacy-import-proposal.ts`
- Create: `packages/cognition/src/legacy-import-candidate-service.ts`
- Modify: `packages/corpus/src/index.ts`
- Modify: `packages/research/src/index.ts`
- Modify: `packages/cognition/src/index.ts`
- Create: `tests/migration/staged-import.test.ts`
- Create: `tests/migration/reconcile.test.ts`
- Create: `packages/corpus/test/legacy-import-proposal.test.ts`
- Create: `packages/research/test/legacy-import-proposals.test.ts`
- Create: `packages/cognition/test/legacy-import-proposal.test.ts`
- Create: `packages/cognition/test/legacy-import-candidate-service.test.ts`

**Interfaces:**
- Consumes: `LegacyAdapter`; Program B `ObjectStore`, `JournalStore`, `BrainRepository`, root codecs, Heritage builder, canonical transaction/recovery primitives, and exact `journalEventIds` validation; Program C's inert corpus-batch builder; Program D's owner-only legacy Question and Artifact Index batch builders; Program E's owner-only legacy Topology builder and new `LegacyImportCandidateService`; no Program C promotion service.
- Produces:

```ts
export interface LegacyImportCandidateService {
  commitCandidate(
    input: PublishStagedImportInput,
  ): Promise<LegacyImportCandidateReceipt>;
}

export async function publishStagedImport(
  input: PublishStagedImportInput,
  candidates: LegacyImportCandidateService,
): Promise<MigrationReceipt>;
```

The owner builders are exact, storage-producing proposal boundaries rather
than G-authored root encoders. All DTO/type/schema identities in the following
signatures were already frozen by G Task 1 in `@cosmo/contracts`; owner packages
import them by object identity and export only their implementation
interfaces/constructors. Program C implements:

```ts
import type {
  BuildLegacyCorpusImportProposalInput,
  LegacyCorpusImportProposalBuildResult,
} from '@cosmo/contracts';

export interface LegacyCorpusImportProposalBuilder {
  build(
    input: BuildLegacyCorpusImportProposalInput,
  ): Promise<LegacyCorpusImportProposalBuildResult>;
}
```

The G-owned `BuildLegacyCorpusImportProposalInputSchema`,
`LegacyCorpusImportProposalSchema`, and strict result schema already carry
these exact fields. Program C's builder parses those imported schemas and
admits only `evidence_source` and `legacy_claim`; an imported legacy Claim has
the single exact Claim status `legacy_unverified`, never `candidate`, supported,
or disconfirmed and never accompanied by a Claim-transition decision.
“Candidate-only” describes the isolated import Brain ref, not a second Claim
status.

Program E implements:

```ts
import type {
  BuildLegacyTopologyImportProposalInput,
  LegacyTopologyImportProposalBuildResult,
} from '@cosmo/contracts';

export interface LegacyTopologyImportProposalBuilder {
  build(
    input: BuildLegacyTopologyImportProposalInput,
  ): Promise<LegacyTopologyImportProposalBuildResult>;
}
```

Program E parses the exact G-owned
`BuildLegacyTopologyImportProposalInputSchema`,
`LegacyTopologyImportProposalSchema`, and strict result schema. Every topology
entry has one non-null mapping ref, `origin='legacy_import'`, and
`epistemicStatus='legacy_unverified'`; the builder cannot update Activation or
invoke reviewed-candidate acceptance.

Program D implements these two interfaces against the strict G-owned
input/proposal/result schemas:

```ts
import type {
  ArtifactIndexBatchUpdateProposalBuildResult,
  BuildArtifactIndexBatchUpdateProposalInput,
  BuildLegacyQuestionBatchProposalInput,
  LegacyQuestionBatchProposalBuildResult,
} from '@cosmo/contracts';

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

All four G-owned owner-input schemas require equal-length, unique, canonically
ordered `mappingRefs`/`mappings`; each ref's object ID equals the paired mapping
ID and stored bytes parse byte-identically. An owner-specific subset may be
empty even though the overall bundle is nonempty; the corresponding owner
builder then returns a fully validated no-op proposal whose next root equals
its previous root and whose mapping/event arrays are empty. The Question
builder admits only `legacy_question` mappings, forces
`origin='legacy_import'` and `status='incubating'`, and cannot create an active
Question or Program mutation. The Artifact builder admits only
`legacy_artifact` mappings, requires each `curationEventId` to be a Program B
`ObjectId`, and forces `disposition='legacy_unverified'`. Both require the exact
shared candidate scope/trust, append their typed journal events before
proposing the next root, and have no ref/CAS/promotion method.

Program C's `LegacyCorpusImportProposalBuilder` similarly accepts only `evidence_source`/`legacy_claim` mappings, forces every imported Claim's one status to `legacy_unverified`, and returns one exact stored `LegacyCorpusImportProposal`. Both C root-plan entries reference that same proposal ref and byte-identical decoded proposal; E verifies the proposal's inner `batchRecordingRef`/bytes, scope, trust, parent/root pins, mapping/event sets, and `canonicalMutationAllowed:false` before applying its Epistemic and Negative Knowledge effects. Program E's `LegacyTopologyImportProposalBuilder` accepts only `legacy_topology`, `process_history`, or mapped legacy-claim/question projections, forces every node `origin='legacy_import'` and `epistemicStatus='legacy_unverified'`, and returns one exact stored `LegacyTopologyImportProposal`. Neither owner builder can call a canonical promotion service.

- [ ] **Step 1: Write failing crash-window tests**

Inject failure after each mapping/proposal/object write, scoped journal append, reconciliation write, E transaction-intent write, each root construction, commit write, immediately before absent-ref CAS, and immediately after successful CAS but before receipt storage. Before CAS, assert the import candidate ref remains absent and every canonical ref fingerprint is unchanged. After the post-CAS crash, reopen and require exact retry to recover the one prior candidate commit/receipt with one successful CAS, no duplicate selected event, and still-zero canonical promotion/ref advances.

- [ ] **Step 2: Write failing accounting tests**

```ts
test('every source record is imported, rejected, or quarantined exactly once', async () => {
  const receipt = await runFixtureMigration('mixed-legacy-fixture');
  assert.equal(
    receipt.sourceRecordCount,
    receipt.importedCount + receipt.rejectedCount + receipt.quarantinedCount
  );
});

test('published legacy cognition is inert and candidate-only', async () => {
  const fixture = await legacyImportPublicationFixture();
  const canonicalBefore = await fixture.canonicalRefFingerprint();
  const receipt = await publishStagedImport(
    fixture.input,
    fixture.legacyImportCandidates,
  );
  assert.equal(receipt.previousHead, null);
  assert.equal(receipt.targetBranch.startsWith('refs/heads/imports/'), true);
  assert.equal(receipt.legacyUnverifiedMappingCount, receipt.importedCount);
  assert.equal(receipt.canonicalRefAdvanceCount, 0);
  assert.equal(receipt.canonicalPromotionCount, 0);
  assert.equal(await fixture.canonicalRefFingerprint(), canonicalBefore);
  assert.equal(await fixture.promotionServiceCallCount(), 0);
});

test('all nine root plans are owner-produced and close one candidate', async () => {
  const fixture = await legacyImportPublicationFixture();
  const receipt = await publishStagedImport(
    fixture.input,
    fixture.legacyImportCandidates,
  );
  assert.deepEqual(
    fixture.input.proposalBundle.rootPlans.map((plan) => plan.rootKind),
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
  assert.equal(
    (await fixture.verifyBrain(receipt.candidateBrainCommitId)).valid,
    true,
  );
});
```

- [ ] **Step 3: Run tests and verify failure**

```bash
npm test -- tests/migration/staged-import.test.ts tests/migration/reconcile.test.ts
```

Expected: FAIL because staging, owner proposal builders, and candidate
reconciliation are absent. The full failing invocation is:

```bash
npm test -- tests/migration/staged-import.test.ts tests/migration/reconcile.test.ts packages/corpus/test/legacy-import-proposal.test.ts packages/research/test/legacy-import-proposals.test.ts packages/cognition/test/legacy-import-proposal.test.ts packages/cognition/test/legacy-import-candidate-service.test.ts
```

- [ ] **Step 4: Implement append-only staging**

```ts
export async function stageLegacyImport(
  adapter: LegacyAdapter,
  source: LegacySource,
  target: ImportTarget
): Promise<StagedImport> {
  const accounting = new ImportAccounting();
  for await (const record of adapter.read(source)) {
    const result = await target.admit(record);
    accounting.record(record.sourceRecordId, result);
  }
  return accounting.finalize(target);
}
```

`stageLegacyImport()` parses `LegacySourceSchema` once and copies its exact `sourceFixtureId`, `sourceCatalogId`, `casebookBundleId`, and `casebookManifestId` into immutable staging metadata before reading the first record. `publishStagedImport()` copies the same four identities into `MigrationReceipt` and rejects any adapter/staging/receipt mismatch. The signed historical manifest and final release receipt can therefore reconstruct every migrated object back to the Program A catalog and exact casebook bytes without consulting a filesystem path.

`ImportTarget.admit()` may store only the normalized destination object,
strict `LegacyImportMapping`, and an imported/rejected/quarantined accounting
decision. It has no root codec, ref, CAS, promotion, or Program creation
capability. `accounting.finalize()` first freezes the complete mapping ledger
and reconciliation object; it returns a final `StagedImport` only after Step 5
has obtained all owner proposal objects, stored the content-addressed proposal
bundle, and filled its exact `proposalBundleRef`/`proposalBundleId`. A failure
before that point leaves resumable append-only staging state but no object that
parses as `StagedImportSchema`, never a publishable partial bundle.

- [ ] **Step 5: Build the inert owner-specific proposal bundle**

After accounting, re-read every stored mapping and normalized projection, validate one mapping for every imported record, require `legacy_unverified`/`canonicalPromotionEligible:false`, compute reconciliation, and pin one verified existing parent Brain. Derive only `refs/heads/imports/${sha256(migrationId, parentCommitId)}` with expected head `null`; there is no caller-selected canonical ref.

Derive one exact `brain_lineage` scope from parent, import candidate ref, deterministic migration lineage, and effective trust. `effectiveTrust` is no broader than the intersection of parent, source, mapping, and destination-object trust; its encryption domain equals the scope trust domain. Ask C, D, and E owner builders for their exact stored proposal/recording objects. Construct the nine-entry tuple in `BrainCommitPayload` order. Program/Relationship/Activation entries are literal `copy_parent`; Heritage derives from one Program B typed migration `CurationEvent`, whose `curationEventId` is an `ObjectId` and whose `curationEventRef.objectId` is identical. A separate typed `migrationJournalEventId: EventId` carries the mutation record in the exact B scope and must appear in `selectedJournalEventIds`; the two ID domains are never aliased. Both records link the Program A manifest, staged import, reconciliation, mappings, and selected events. G never encodes a root payload or calls a root codec directly.

- [ ] **Step 6: Implement E's candidate-only acceptance transaction**

`LegacyImportCandidateService.commitCandidate()` schema-parses `PublishStagedImportInputSchema` before reads. It reloads the staged import and proposal bundle and requires byte-identical stored values/refs; reconciles all four casebook identities, parent/ref/head, mappings, proposal pins, trust, scope, selected events, and idempotency; verifies the lease fences that exact absent import ref; and materializes/verifies the parent through all nine accepted codecs.

E then:

1. loads every owner proposal and requires its stored bytes, parent/root pin,
   exact projection-to-owner coverage matrix, scope, trust, and selected event
   IDs to match the bundle;
2. forces every imported Claim's one status to remain `legacy_unverified`, every imported topology node and artifact disposition to remain `legacy_unverified`, and every imported Question to remain `incubating`; it rejects `candidate`, supported, or disconfirmed Claim status, any Claim transition, active Program, Relationship belief/preference, Activation, Principal decision, or canonical-promotion record;
3. applies only the C Epistemic/Negative Knowledge, D Question/Artifact Index, and E Topology owner proposals; copies Program, Relationship, and Activation roots byte-for-byte; derives Heritage from the one typed curation event;
4. resolves every unique sorted `selectedJournalEventIds` member to one admitted record whose exact scope equals the bundle scope and whose payload/ref belongs to a typed mapping/proposal/Heritage link;
5. constructs and verifies all nine roots, corpus snapshots, Heritage closure, exact selected-event payload, parent/trust/version inheritance, and mechanical cross-root invariants; and
6. asks Program B for one lease-bound `commitAndAdvance(expectedHead:null)` on the import candidate ref.

The service has no canonical-ref field, no promotion service dependency, and no method that accepts a raw root or `BrainCommitPayload`. Static dependency and runtime-spy tests require zero calls to Claim transition, reviewed-candidate acceptance, Research Program creation/control, Principal decision, Relationship mutation, or canonical ref services.

- [ ] **Step 7: Verify durable intent, recovery, and exact idempotency**

Before proposal application E stores one canonical intent indexed by `(candidateRef, parentCommitId, idempotencyKey)`, including stored input/bundle IDs and selected events. It records staged roots, Program B transaction identity, and receipt payload as phases advance. Restart reloads that intent, verifies the ref/transaction/object closure, and resumes without re-appending events or issuing another CAS. Exact retry returns the same decoded `LegacyImportCandidateReceipt`; changed input under the same key conflicts; a different key against the consumed bundle or non-absent ref rejects. `publishStagedImport()` stores one `MigrationReceipt` that byte-for-byte reconciles the E receipt and returns the existing receipt on exact retry.

- [ ] **Step 8: Run focused, owner-builder, E transaction, and repository tests**

```bash
npm test -- tests/migration/staged-import.test.ts tests/migration/reconcile.test.ts packages/corpus/test/legacy-import-proposal.test.ts packages/research/test/legacy-import-proposals.test.ts packages/cognition/test/legacy-import-proposal.test.ts packages/cognition/test/legacy-import-candidate-service.test.ts packages/repository/test
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/migration/src/staged-import.ts packages/migration/src/reconcile.ts packages/corpus/src/legacy-import-proposal.ts packages/corpus/src/index.ts packages/corpus/test/legacy-import-proposal.test.ts packages/research/src/legacy-import-proposals.ts packages/research/src/index.ts packages/research/test/legacy-import-proposals.test.ts packages/cognition/src/legacy-import-proposal.ts packages/cognition/src/legacy-import-candidate-service.ts packages/cognition/src/index.ts packages/cognition/test/legacy-import-proposal.test.ts packages/cognition/test/legacy-import-candidate-service.test.ts tests/migration
git commit -m "feat: publish reconciled legacy imports atomically"
```

---

### Task 6: Sign and Verify Frozen Acceptance Profiles

**Files:**
- Modify: `package-lock.json`
- Create: `packages/acceptance/package.json`
- Create: `packages/acceptance/tsconfig.json`
- Create: `packages/acceptance/src/index.ts`
- Create: `packages/acceptance/src/profile.ts`
- Create: `packages/acceptance/src/signing.ts`
- Create: `tests/acceptance/profile.test.ts`
- Create: `tests/acceptance/signing.test.ts`
- Create: `fixtures/acceptance/profile-minimal/manifest.json`
- Create: `fixtures/acceptance/profile-minimal/required-historical-case-manifest.json`
- Create: `fixtures/acceptance/profile-minimal/artifact-set-manifest.json`
- Create: `fixtures/acceptance/profile-minimal/prompt-identity-manifest.json`
- Create: `fixtures/acceptance/profile-minimal/tool-identity-manifest.json`
- Create: `fixtures/acceptance/profile-minimal/seed-manifest.json`
- Create: `fixtures/acceptance/profile-minimal/hidden-oracle-commitments.json`
- Create: `fixtures/acceptance/profile-minimal/intervention-schedule.json`
- Create: `fixtures/acceptance/profile-minimal/execution-identities.json`
- Create: `fixtures/acceptance/profile-minimal/production-execution-requirements.json`
- Create: `fixtures/acceptance/profile-minimal/budgets.json`
- Create: `fixtures/acceptance/profile-minimal/candidate-baseline-parity.json`
- Create: `fixtures/acceptance/profile-minimal/hard-gates.json`
- Create: `fixtures/acceptance/profile-minimal/vector-thresholds.json`
- Create: `fixtures/acceptance/profile-minimal/scorer-identities.json`
- Create: `fixtures/acceptance/profile-minimal/nondeterminism-policy.json`
- Create: `fixtures/acceptance/profile-minimal/statistical-methods.json`
- Create: `fixtures/acceptance/profile-minimal/non-regression-rules.json`
- Create: `fixtures/acceptance/profile-minimal/environment-policy.json`
- Create: `fixtures/acceptance/profile-minimal/human-review-protocol.json`

**Interfaces:**
- Consumes: Program A `CasebookManifestSchema`, Program B canonical JSON/hash/signature functions, and the Task 1 `AcceptanceProfileSchema`.
- Produces:

```ts
export function computeAcceptanceProfileId(
  unsigned: Omit<AcceptanceProfile, 'profileId' | 'signatures'>
): Sha256;

export interface AcceptanceProfileTrust {
  schema: 'cosmo.acceptance-profile-trust.v1';
  trustedReleaseAuthorities: readonly {
    signerId: Sha256;
    principalClass: 'human';
    algorithm: 'ed25519';
    publicKeyPem: string;
    roles: readonly ['acceptance_release'];
    revokedAt: string | null;
  }[];
  minimumTrustedSignatures: 1;
}

export interface VerifiedAcceptanceProfile {
  schema: 'cosmo.verified-acceptance-profile.v1';
  profile: SignedAcceptanceProfile;
  profileId: Sha256;
  bundleRoot: string;
  canonicalUnsignedRootBytes: Uint8Array;
  requiredHistoricalCaseManifestId: Sha256;
  requiredHistoricalCaseIds: readonly RequiredHistoricalCaseId[];
  resolvedProfileObjectIds: readonly ObjectId[];
  verifiedSignerIds: readonly Sha256[];
}

export function verifyAcceptanceProfile(
  profile: SignedAcceptanceProfile,
  bundleRoot: string,
  trust: AcceptanceProfileTrust,
): Promise<VerifiedAcceptanceProfile>;
```

- [ ] **Step 1: Write failing root, subdocument, identity, and signer tests**

```ts
test('profile mutation after signature is rejected', async () => {
  const signed = signedFixtureProfile();
  signed.pairedTrialCount += 1;
  await assert.rejects(
    verifyAcceptanceProfile(
      signed,
      signedFixtureBundleRoot(),
      trustFixture({ trustedSignerIds: [fixtureSignerId] }),
    ),
    /profile id mismatch|signature verification failed/
  );
});

test('historical cases cannot detach from the preserved Program A catalog', async () => {
  const bundle = await completeSignedProfileFixture();
  bundle.historicalManifest.cases[0].sourceCatalogId =
    sha256('different-source-catalog');
  await assert.rejects(
    verifyAcceptanceProfile(bundle.profile, bundle.root, trustFixture()),
    /casebook source catalog mismatch/,
  );
});

test('COSMO signer is not a trusted release authority', async () => {
  await assert.rejects(
    verifyAcceptanceProfile(
      cosmoSelfSignedProfile(),
      cosmoSelfSignedBundleRoot(),
      trustFixture({ trustedSignerIds: [humanSignerId] }),
    ),
    /untrusted acceptance signer/
  );
});

test('changing one referenced subdocument invalidates the signed root', async () => {
  const bundle = await copiedSignedProfileFixture();
  await bundle.replaceJson('budgets.json', {
    ...await bundle.readJson('budgets.json'),
    autonomous: { ...bundle.autonomous, maxCostUsd: 251 },
  });
  await assert.rejects(
    verifyAcceptanceProfile(bundle.profile, bundle.root, trustFixture()),
    /profile document hash mismatch/,
  );
});

test('all 18 profile documents and historical manifest parse by registry', async () => {
  const bundle = await completeSignedProfileFixture();
  const entries = Object.entries(AcceptanceProfileDocumentRegistry);
  assert.equal(entries.length, 18);
  HistoricalCaseManifestSchema.parse(await bundle.readHistoricalManifest());

  for (const [field, contract] of entries) {
    const stored = await bundle.resolve(bundle.profile[field]);
    assert.equal(stored.mediaType, contract.mediaType);
    const document = contract.schema.parse(stored.decoded);
    assert.equal(document.objectKind, contract.kind);
    assert.equal(stored.objectId, sha256(stored.canonicalBytes));
  }
  await verifyAcceptanceProfile(bundle.profile, bundle.root, trustFixture());
});

test('every document contract and cross-object mismatch rejects', async () => {
  for (const mutation of referencedObjectMutationCases()) {
    const bundle = await completeSignedProfileFixture();
    await mutation.apply(bundle);
    await assert.rejects(
      verifyAcceptanceProfile(bundle.profile, bundle.root, trustFixture()),
      mutation.expectedError,
      mutation.name,
    );
  }
});

test('recorded transport cannot satisfy a semantic release role', async () => {
  const bundle = profileFixture({
    role: 'candidate_autonomous',
    executionClass: 'recorded_conformance',
  });
  await assert.rejects(
    verifyAcceptanceProfile(bundle.profile, bundle.root, trustFixture()),
    /semantic release role requires live_provider with no fallback/,
  );
});
```

- [ ] **Step 2: Run tests and verify failure**

```bash
npm test -- tests/acceptance/profile.test.ts tests/acceptance/signing.test.ts
```

Expected: FAIL because signing functions do not exist.

- [ ] **Step 3: Implement canonical profile identity**

Create `@cosmo/acceptance` as a private ESM workspace with `build` and `test` scripts using `tsc` and `node ../../scripts/run-tests.mjs test`. Its workspace dependencies are the public packages from Programs A–F plus `"@cosmo/migration": "*"`. At this task, the sole development export points at `./src/index.ts`; that barrel exports the profile and signing surface. Task 7 adds the core-candidate subpath only when its source file exists. Program H alone rewrites the staged release copies to compiled `dist/` targets.

Run `npm install` immediately after adding the workspace manifest and commit the resulting `package-lock.json`.

For the historical-case manifest, parse its strict schema, canonicalize it, and verify `requiredHistoricalCaseManifestId = sha256(canonicalBytes)`. For each of the 18 `ObjectRef` fields in the root, resolve the corresponding canonical object, parse its declared strict schema, verify its object ID, payload hash, media type, byte length, and links, then retain its object ID in the verified profile result. Canonicalize the root with `profileId` and `signatures` omitted, compute `profileId`, and verify at least one trusted human release-authority Ed25519 signature over those exact canonical root bytes. A raw file hash, pretty-printed JSON bytes, unresolved ref, or signature over only a path is invalid.

- [ ] **Step 4: Freeze the historical manifest and all 18 referenced profile objects**

The bundle maps the master root fields exactly:

| Root field | Bundle file | Required content |
| --- | --- | --- |
| `requiredHistoricalCaseManifestId` | `required-historical-case-manifest.json` | all 14 case IDs exactly once; exact Program A source-fixture/catalog, casebook bundle/manifest, acceptance-fixture IDs, journal ranges, starting commits, corpus snapshots, artifact sets, and trust class |
| `artifactSetManifest` | `artifact-set-manifest.json` | included/excluded artifact IDs, media types, hashes, and the no-artifact Brain probe set |
| `promptIdentityManifest` | `prompt-identity-manifest.json` | canonical prompt IDs/hashes for every scenario and role |
| `toolIdentityManifest` | `tool-identity-manifest.json` | exact tool registry, executable/config hashes, search/acquisition identities, scopes, and network destinations |
| `seedManifest` | `seed-manifest.json` | preregistered ordering seed `230723`, hidden-source nonce derivation commitment, and per-case seed IDs |
| `hiddenOracleCommitments` | `hidden-oracle-commitments.json` | salted commitments to hidden expected results with post-trial reveal authority |
| `interventionSchedule` | `intervention-schedule.json` | treatment/control order, ablations, restart/context-turnover points, and sleep/wake triggers |
| `executionIdentities` | `execution-identities.json` | exactly eleven signed `AcceptanceExecutionIdentity` records, one per role, including separate Principal Researcher, default-mode, consolidation/dream, and challenger identities |
| `productionExecutionRequirements` | `production-execution-requirements.json` | live-semantic role requirements, receipt matching, eight exact role-independence pairs, and deterministic/recorded exclusions |
| `budgets` | `budgets.json` | exact per-family ceilings from Step 5 |
| `candidateBaselineParity` | `candidate-baseline-parity.json` | equality fields and the sole allowed identity/mechanism differences for each pair |
| `hardGates` | `hard-gates.json` | all 19 hard-gate IDs, required scenario IDs, oracle kinds, and zero-skip policy |
| `vectorThresholds` | `vector-thresholds.json` | all 21 `AcceptanceDimensionId` policies and the exact mandatory subset |
| `scorerIdentities` | `scorer-identities.json` | independent model verifier, three human reviewers, external observer, and release-scorer public identities |
| `nondeterminismPolicy` | `nondeterminism-policy.json` | exactly three paired trials, balanced ordering, raw-distribution retention, retry prohibition, and interruption treatment |
| `statisticalMethods` | `statistical-methods.json` | raw paired deltas, median, Hodges–Lehmann shift, 10,000-resample seed-230723 descriptive interval, and exact boolean counts |
| `nonRegressionRules` | `non-regression-rules.json` | per-dimension historical and strong-session guardrails plus zero structural-regression rules |
| `humanReviewProtocol` | `human-review-protocol.json` | blinded packet, anchored 1–7 rubric, 2-of-3/median-5 rule, ordinal alpha threshold, conflicts, and signature requirements |
| `environmentPolicy` | `environment-policy.json` | read-only mounts, one writable state root, exact environment key/executable/network allowlists, external observer identity, credential file descriptors, and forbidden Home23 patterns |

Every file above, plus the historical-case manifest, has one strict versioned payload schema and one exact stored media type:

```ts
const ProfileObjectHeader = <S extends string, K extends string>(
  schema: S,
  objectKind: K,
) => ({
  schema: z.literal(schema),
  objectKind: z.literal(objectKind),
});

export const HistoricalCaseManifestSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-historical-case-manifest.v1',
    'historical_case_manifest',
  ),
  cases: z.array(z.object({
    caseId: RequiredHistoricalCaseIdSchema,
    sourceFixtureId: Sha256Schema,
    sourceCatalogId: Sha256Schema,
    casebookBundleId: Sha256Schema,
    casebookManifestId: ObjectIdSchema,
    fixtureManifestId: Sha256Schema,
    startingBrainCommitId: BrainCommitIdSchema,
    corpusSnapshotIds: z.array(CorpusSnapshotIdSchema).min(1),
    journalRange: JournalRangeSchema,
    artifactSetId: Sha256Schema,
    trustClass: z.enum(['public', 'private', 'restricted']),
  }).strict()).length(14),
}).strict();

export const ArtifactSetManifestDocumentSchema = z.object({
  ...ProfileObjectHeader('cosmo.acceptance-artifact-set.v1', 'artifact_set'),
  included: z.array(ObjectRefSchema),
  excluded: z.array(ObjectRefSchema),
  brainProbeDeckIds: z.array(Sha256Schema).min(1),
  noArtifactProbeIds: z.array(Sha256Schema).min(1),
}).strict();

export const PromptIdentityManifestDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-prompt-identities.v1',
    'prompt_identity_manifest',
  ),
  prompts: z.array(z.object({
    scenarioId: RequiredReleaseScenarioIdSchema,
    role: AcceptanceExecutionRoleSchema,
    promptObjectId: ObjectIdSchema,
    promptSha256: Sha256Schema,
  }).strict()).min(1),
}).strict();

export const ToolIdentityManifestDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-tool-identities.v1',
    'tool_identity_manifest',
  ),
  toolRegistryObjectId: ObjectIdSchema,
  tools: z.array(z.object({
    toolId: Sha256Schema,
    name: z.string().min(1),
    executableSha256: Sha256Schema,
    configSha256: Sha256Schema,
    scopes: z.array(z.string().min(1)).min(1),
    networkDestinations: z.array(z.string().min(1)),
  }).strict()).min(1),
}).strict();

export const SeedManifestDocumentSchema = z.object({
  ...ProfileObjectHeader('cosmo.acceptance-seeds.v1', 'seed_manifest'),
  orderingSeed: z.literal(230723),
  hiddenNonceDerivationCommitment: Sha256Schema,
  scenarioSeeds: z.array(z.object({
    scenarioId: RequiredReleaseScenarioIdSchema,
    seedId: Sha256Schema,
    seed: z.number().int().nonnegative(),
  }).strict()).min(1),
}).strict();

export const HiddenOracleCommitmentsDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-hidden-oracles.v1',
    'hidden_oracle_commitments',
  ),
  commitments: z.array(z.object({
    scenarioId: RequiredReleaseScenarioIdSchema,
    oracleKind: z.string().min(1),
    saltedCommitment: Sha256Schema,
    revealAuthorityId: Sha256Schema,
    revealAfter: z.string().datetime(),
  }).strict()).min(1),
}).strict();

export const InterventionScheduleDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-interventions.v1',
    'intervention_schedule',
  ),
  entries: z.array(z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('paired'),
      scenarioId: RequiredReleaseScenarioIdSchema,
      pairId: Sha256Schema,
      replicate: z.number().int().min(1).max(3),
      firstArm: z.enum(['candidate', 'baseline']),
      restartAfterEvent: z.number().int().nonnegative().nullable(),
      contextTurnoverAfterEvent: z.number().int().nonnegative().nullable(),
      metabolismTreatment: z.enum([
        'enabled',
        'disabled',
        'not_applicable',
      ]),
    }).strict(),
    z.object({
      kind: z.literal('unpaired'),
      scenarioId: RequiredReleaseScenarioIdSchema,
      scheduleEntryId: Sha256Schema,
      restartAfterEvent: z.number().int().nonnegative().nullable(),
      contextTurnoverAfterEvent: z.number().int().nonnegative().nullable(),
      metabolismTreatment: z.enum([
        'enabled',
        'disabled',
        'not_applicable',
      ]),
    }).strict(),
  ])).min(1),
}).strict();

export const ExecutionIdentitiesDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-execution-identities.v1',
    'execution_identities',
  ),
  identities: z.array(AcceptanceExecutionIdentitySchema).length(11),
}).strict();

const ExecutionIdentityDistinctFieldSchema = z.enum([
  'identity_id',
  'prompt_identity',
  'context_configuration',
  'process_session',
  'signer_principal',
  'credential_binding',
  'provider_model',
]);

export const ProductionExecutionRequirementsDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-production-execution.v1',
    'production_execution_requirements',
  ),
  semanticRoles: z.array(AcceptanceExecutionRoleSchema).length(11),
  requiredExecutionClass: z.literal('live_provider'),
  providerFallback: z.null(),
  requireExactRuntimeReceiptMatch: z.literal(true),
  requireIndependentGeneratorVerifier: z.literal(true),
  independencePairs: z.array(z.object({
    leftRole: AcceptanceExecutionRoleSchema,
    rightRole: AcceptanceExecutionRoleSchema,
    distinctFields: z.array(
      ExecutionIdentityDistinctFieldSchema,
    ).min(3),
  }).strict()).length(8),
  forbiddenSemanticClasses: z.tuple([
    z.literal('deterministic_conformance'),
    z.literal('recorded_conformance'),
    z.literal('replay'),
    z.literal('mock'),
  ]),
}).strict();

export const RequiredExecutionIndependencePairs = [
  ['candidate_autonomous', 'principal_researcher'],
  ['candidate_autonomous', 'default_mode_proposal_generator'],
  ['candidate_autonomous', 'consolidation_dream_generator'],
  ['candidate_autonomous', 'independent_challenger'],
  ['principal_researcher', 'independent_challenger'],
  ['default_mode_proposal_generator', 'independent_challenger'],
  ['consolidation_dream_generator', 'independent_challenger'],
  ['inquiry_generator', 'independent_verifier'],
] as const;

const BudgetLimitSchema = z.object({
  wallClockMs: z.number().int().positive(),
  maxInputTokens: z.number().int().nonnegative(),
  maxOutputTokens: z.number().int().nonnegative(),
  maxToolCalls: z.number().int().nonnegative(),
  maxConcurrentModelRuns: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative(),
}).strict();
export const BudgetsDocumentSchema = z.object({
  ...ProfileObjectHeader('cosmo.acceptance-budgets.v1', 'budgets'),
  sustainedAutonomous: BudgetLimitSchema,
  pureOpenQuestion: BudgetLimitSchema,
  guided: BudgetLimitSchema,
  brainOverFiles: BudgetLimitSchema,
  metabolismSelfResearch: BudgetLimitSchema,
  structuralFault: BudgetLimitSchema,
}).strict();

export const CandidateBaselineParityDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-candidate-baseline-parity.v1',
    'candidate_baseline_parity',
  ),
  pairs: z.array(z.object({
    scenarioId: RequiredReleaseScenarioIdSchema,
    candidateId: Sha256Schema,
    baselineId: Sha256Schema,
    equalFields: z.array(z.enum([
      'starting_commit',
      'corpus_snapshots',
      'covenant',
      'tool_registry',
      'environment',
      'deadline',
      'budget',
    ])).length(7),
    allowedDifferences: z.array(z.enum([
      'execution_identity',
      'declared_ablation',
    ])).min(1).max(2),
  }).strict()).min(1),
}).strict();

export const HardGatesDocumentSchema = z.object({
  ...ProfileObjectHeader('cosmo.acceptance-hard-gates.v1', 'hard_gates'),
  gates: z.array(z.object({
    gateId: HardGateIdSchema,
    requiredScenarioIds: z.array(RequiredReleaseScenarioIdSchema).min(1),
    oracle: z.enum([
      'exact_count',
      'exact_identity',
      'external_reconstruction',
      'signed_policy',
      'absence_proof',
    ]),
  }).strict()).length(19),
  allowSkip: z.literal(false),
}).strict();

export const VectorThresholdsDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-vector-thresholds.v1',
    'vector_thresholds',
  ),
  dimensions: z.array(z.object({
    dimensionId: AcceptanceDimensionIdSchema,
    mandatory: z.boolean(),
    decisionRule: z.string().min(1),
    allowNotApplicable: z.boolean(),
  }).strict()).length(21),
}).strict();

const ScorerIdentitySchema = z.object({
  scorerId: Sha256Schema,
  principalClass: z.enum(['human', 'independent_model', 'external_observer']),
  publicKeyId: Sha256Schema,
}).strict();
export const ScorerIdentitiesDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-scorer-identities.v1',
    'scorer_identities',
  ),
  independentModelVerifier: ScorerIdentitySchema,
  humanReviewers: z.array(ScorerIdentitySchema).length(3),
  externalObserver: ScorerIdentitySchema,
  releaseScorer: ScorerIdentitySchema,
}).strict();

export const NondeterminismPolicyDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-nondeterminism.v1',
    'nondeterminism_policy',
  ),
  pairedTrialCount: z.literal(3),
  orderingSeed: z.literal(230723),
  balancedOrder: z.literal(true),
  retainRawDistributions: z.literal(true),
  retryPolicy: z.literal('no_retry_after_output'),
  interruptedTrialDisposition: z.literal('failed'),
}).strict();

export const StatisticalMethodsDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-statistical-methods.v1',
    'statistical_methods',
  ),
  pairedSummary: z.tuple([
    z.literal('raw_deltas'),
    z.literal('median_delta'),
    z.literal('hodges_lehmann_shift'),
  ]),
  bootstrapResamples: z.literal(10_000),
  bootstrapSeed: z.literal(230723),
  intervalUse: z.literal('descriptive_only'),
  booleanMethod: z.literal('exact_counts'),
}).strict();

export const NonRegressionRulesDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-non-regression.v1',
    'non_regression_rules',
  ),
  rules: z.array(z.object({
    dimensionId: AcceptanceDimensionIdSchema,
    historicalBaselineRule: z.string().min(1),
    strongSessionBaselineRule: z.string().min(1),
    structuralRegressionAllowed: z.literal(false),
  }).strict()).length(21),
}).strict();

export const HumanReviewProtocolDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-human-review.v1',
    'human_review_protocol',
  ),
  reviewerIds: z.array(Sha256Schema).length(3),
  blinded: z.literal(true),
  rubricScale: z.tuple([
    z.literal(1), z.literal(2), z.literal(3), z.literal(4),
    z.literal(5), z.literal(6), z.literal(7),
  ]),
  passingScore: z.literal(5),
  minimumPassingReviewers: z.literal(2),
  minimumMedian: z.literal(5),
  minimumOrdinalAlpha: z.literal(0.67),
  requirePreOutputSignatures: z.literal(true),
  conflictPolicy: z.literal('reject_conflicted_reviewer'),
}).strict();

export const EnvironmentPolicyDocumentSchema = z.object({
  ...ProfileObjectHeader(
    'cosmo.acceptance-environment-policy.v1',
    'environment_policy',
  ),
  readOnlyMounts: z.array(z.string().min(1)).min(1),
  writableStateRoot: z.string().min(1),
  allowedEnvironmentKeys: z.array(z.string().min(1)),
  allowedExecutables: z.array(z.string().min(1)).min(1),
  allowedNetworkDestinations: z.array(z.string().min(1)).min(1),
  credentialFileDescriptors: z.array(z.number().int().min(3)).min(1),
  externalObserverId: Sha256Schema,
  forbiddenPathPatterns: z.array(z.string().min(1)).min(1),
}).strict();

export const AcceptanceProfileDocumentRegistry = {
  artifactSetManifest: {
    kind: 'artifact_set',
    mediaType: 'application/vnd.cosmo.acceptance-artifact-set+json',
    schema: ArtifactSetManifestDocumentSchema,
  },
  promptIdentityManifest: {
    kind: 'prompt_identity_manifest',
    mediaType: 'application/vnd.cosmo.acceptance-prompt-identities+json',
    schema: PromptIdentityManifestDocumentSchema,
  },
  toolIdentityManifest: {
    kind: 'tool_identity_manifest',
    mediaType: 'application/vnd.cosmo.acceptance-tool-identities+json',
    schema: ToolIdentityManifestDocumentSchema,
  },
  seedManifest: {
    kind: 'seed_manifest',
    mediaType: 'application/vnd.cosmo.acceptance-seeds+json',
    schema: SeedManifestDocumentSchema,
  },
  hiddenOracleCommitments: {
    kind: 'hidden_oracle_commitments',
    mediaType: 'application/vnd.cosmo.acceptance-hidden-oracles+json',
    schema: HiddenOracleCommitmentsDocumentSchema,
  },
  interventionSchedule: {
    kind: 'intervention_schedule',
    mediaType: 'application/vnd.cosmo.acceptance-interventions+json',
    schema: InterventionScheduleDocumentSchema,
  },
  executionIdentities: {
    kind: 'execution_identities',
    mediaType: 'application/vnd.cosmo.acceptance-execution-identities+json',
    schema: ExecutionIdentitiesDocumentSchema,
  },
  productionExecutionRequirements: {
    kind: 'production_execution_requirements',
    mediaType: 'application/vnd.cosmo.acceptance-production-execution+json',
    schema: ProductionExecutionRequirementsDocumentSchema,
  },
  budgets: {
    kind: 'budgets',
    mediaType: 'application/vnd.cosmo.acceptance-budgets+json',
    schema: BudgetsDocumentSchema,
  },
  candidateBaselineParity: {
    kind: 'candidate_baseline_parity',
    mediaType: 'application/vnd.cosmo.acceptance-candidate-baseline-parity+json',
    schema: CandidateBaselineParityDocumentSchema,
  },
  hardGates: {
    kind: 'hard_gates',
    mediaType: 'application/vnd.cosmo.acceptance-hard-gates+json',
    schema: HardGatesDocumentSchema,
  },
  vectorThresholds: {
    kind: 'vector_thresholds',
    mediaType: 'application/vnd.cosmo.acceptance-vector-thresholds+json',
    schema: VectorThresholdsDocumentSchema,
  },
  scorerIdentities: {
    kind: 'scorer_identities',
    mediaType: 'application/vnd.cosmo.acceptance-scorer-identities+json',
    schema: ScorerIdentitiesDocumentSchema,
  },
  nondeterminismPolicy: {
    kind: 'nondeterminism_policy',
    mediaType: 'application/vnd.cosmo.acceptance-nondeterminism+json',
    schema: NondeterminismPolicyDocumentSchema,
  },
  statisticalMethods: {
    kind: 'statistical_methods',
    mediaType: 'application/vnd.cosmo.acceptance-statistical-methods+json',
    schema: StatisticalMethodsDocumentSchema,
  },
  nonRegressionRules: {
    kind: 'non_regression_rules',
    mediaType: 'application/vnd.cosmo.acceptance-non-regression+json',
    schema: NonRegressionRulesDocumentSchema,
  },
  humanReviewProtocol: {
    kind: 'human_review_protocol',
    mediaType: 'application/vnd.cosmo.acceptance-human-review+json',
    schema: HumanReviewProtocolDocumentSchema,
  },
  environmentPolicy: {
    kind: 'environment_policy',
    mediaType: 'application/vnd.cosmo.acceptance-environment-policy+json',
    schema: EnvironmentPolicyDocumentSchema,
  },
} as const;
```

The production requirements must contain `RequiredExecutionIndependencePairs` as eight unordered pairs exactly once. The first three pairs must differ on identity ID, prompt identity, context configuration, and process/session. Every pair involving `independent_challenger`, plus the inquiry generator/verifier pair, must additionally differ on signer principal, credential binding, and provider/model tuple. A role may share a provider family only where its pair does not require provider/model independence; it may never share the same signed prompt/context/process identity. `principal_researcher`, default mode, dream/consolidation, or challenger receipts cannot be substituted with `candidate_autonomous`.

The historical manifest is stored as `application/vnd.cosmo.acceptance-historical-cases+json`. Verification iterates the registry's 18 entries—never a handpicked subset—and for each root field requires the referenced object's media type, `objectKind`, schema version, canonical bytes, object ID, links, and byte length to match. It then enforces these cross-object invariants before signature acceptance:

- historical case IDs equal `RequiredHistoricalCaseIdSchema.options` exactly once and reconcile root fixture IDs, starting commits, corpus snapshots, journal ranges, and artifact set; each case's `casebookManifestId` resolves to canonical Program A `CasebookManifestSchema`, whose `bundleId`, `payload.sourceCatalogId`, and `payload.caseId` equal the signed `casebookBundleId`, `sourceCatalogId`, and case ID;
- prompt, seed, oracle, intervention, parity, hard-gate, and threshold scenario IDs are subsets of the signed required scenario set, with every required scenario covered where its contract demands;
- the eleven execution roles are unique and equal the production-required roles; every semantic identity is live with null fallback; every prompt/context/tool/config object resolves; and all eight independence pairs satisfy their exact distinct fields;
- every required scenario has at least one signed intervention entry; paired replicate/order counts equal nondeterminism policy, every pair uses the declared budget family and parity fields, and each unpaired schedule entry is unique and baseline-free;
- every scheduled scenario ID appears once in `requiredReleaseScenarioModes` and has exactly the class in `RequiredReleaseScenarioClassById`; each non-null mode parses through Program D `ResearchProgramModeSchema`, the pure scenario is exactly `pure`, both guided scenarios are exactly `guided`, and the paired sleep scenario is exactly `blended`;
- all 19 hard gates and all 21 dimensions appear exactly once; mandatory flags equal `FirstReleaseMandatoryDimensionIds`, and non-regression rules cover the same 21 dimensions;
- scorer IDs are pairwise distinct, the three human IDs equal the review protocol, and the external observer ID equals the environment policy;
- every tool network destination is explicitly present in the environment allowlist, every credential descriptor is declared, and no wildcard destination, undeclared executable, writable fixture/profile mount, or forbidden path is admitted; and
- statistical seed/methods equal the seed and nondeterminism documents, and every hidden oracle commitment has an authorized post-output reveal.

`profile.test.ts` constructs one valid 19-object bundle, parses all 18 registry entries plus the historical manifest, then table-drives one unknown-field/schema/kind/media/hash mutation per document and one mismatch for every reconciliation rule. All mutations must reject before candidate launch.

The root additionally carries the exact `governingSpecHash`, all `fixtureManifestIds`, `startingBrainCommitIds`, `corpusSnapshotIds`, `journalRanges`, `covenantCommitId`, `evidencePolicyIds`, and the two signed `baselineIds`. Each array is sorted, duplicate-free, and reconciles against the historical manifest and referenced objects.

`execution-identities.json` must attest to real provider, exact model, compiled runtime artifact, runtime adapter, transport, exact tool-registry object, runtime configuration object, prompt identity object, context-configuration object, process/session identity, and credential-binding public key. All eleven semantic-comparison identities require Program D `executionClass='live_provider'` and `providerFallback=null`. Provider runtime receipts must later match every field exactly; a fallback receipt is ineligible even when its final provider/model happens to match.

The required historical cases are exactly:

```ts
export const requiredHistoricalCaseIds = [
  'original-deep-code-self-audit',
  'autoscombo2',
  'jerryg',
  'standalone-jerryshows',
  'june-30-controlled-receipt',
  'degraded-home23',
  'old-new-jtr-brains',
  'terrapin-collapse',
  'bigmerge-cross-domain',
  'catastrophic-stem-humanities-aesthetic-merges',
  'menlo-park-zero-metrics',
  'truncated-checkpoint-unicode',
  'clawd-openclaw-continuity',
  'subject-brain-federation-merge',
] as const satisfies readonly RequiredHistoricalCaseId[];

export const requiredReleaseScenarioIds =
  RequiredReleaseScenarioIdSchema.options;

export const requiredReleaseScenarioModes = {
  'g.repository.genesis-brain.v1': null,
  'g.autonomous.sustained-observe-only.v1': 'autonomous',
  'g.guided.satisfiable.v1': 'guided',
  'g.guided.deliberately-blocked.v1': 'guided',
  'g.pure.open-question.v1': 'pure',
  'g.inquiry.brain-over-files.v1': null,
  'g.discovery.live-new-evidence.v1': 'autonomous',
  'g.discovery.fresh-nonce-canary.v1': 'autonomous',
  'g.metabolism.paired-sleep.v1': 'blended',
  'g.relationship.export-import.v1': null,
  'g.negative-knowledge.dead-end.v1': 'autonomous',
  'g.self-research.causal-origin.v1': 'autonomous',
  'g.repository.union-materialization.v1': null,
  'g.repository.encrypted-restricted-export.v1': null,
  'g.git-for-brains.status-log-tag-settle-wake.v1': null,
} as const satisfies Record<
  typeof requiredReleaseScenarioIds[number],
  ResearchProgramMode | null
>;

export const requiredReleaseScenarioClasses =
  RequiredReleaseScenarioClassById;
```

No alias, prefix match, or “representative equivalent” satisfies a required case. The ten cognition/research scenarios are irreducibly `semantic_release`; Genesis Brain, relationship export/import, union materialization, and encrypted restricted export are `structural_conformance`; Git-for-Brains recovery is `fault_injection`. A profile, harness input, or receipt cannot relabel a semantic scenario as structural/fault to admit a mock, replay, deterministic, or recorded semantic result. A non-null mode is parsed through the one Program D `ResearchProgramModeSchema` with no G-local alias or remapping. The Genesis Brain scenario has mode `null`: it exercises Program E's model-free repository transaction, not a Research Program. The pure trial must use literal `pure` and reject steering or a causally equivalent human/Principal task during the measured run; the paired sleep trial uses literal `blended` so Covenant lane allocation is exercised rather than inferred from an autonomous run.

- [ ] **Step 5: Freeze exact budgets, parity, and semantic-transport policy**

`budgets.json` pins these ceilings per trial:

| Scenario family | Wall clock | Input tokens | Output tokens | Tool calls | Concurrent model runs | Cost ceiling |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| sustained autonomous | 28,800,000 ms | 3,000,000 | 750,000 | 2,000 | 8 | USD 250 |
| Pure/open question | 7,200,000 ms | 1,000,000 | 250,000 | 500 | 6 | USD 100 |
| guided satisfied or blocked | 3,600,000 ms | 500,000 | 150,000 | 250 | 4 | USD 50 |
| inquiry/brain-over-files | 900,000 ms | 150,000 | 50,000 | 20 | 2 | USD 15 |
| metabolism or self-research | 3,600,000 ms | 500,000 | 100,000 | 100 | 4 | USD 50 |
| structural/fault conformance | 600,000 ms | 0 semantic-provider tokens | 0 semantic-provider tokens | 0 live tools | 1 | USD 0 |

Every nondeterministic comparison has exactly three paired replicates. Pair order is balanced from preregistered seed `230723`; each pair shares the same starting commit, corpus snapshots, Covenant, source-discovery surface, tool registry, environment, deadline, and budget. Only the declared candidate/baseline identity or ablated mechanism differs. `deterministic_conformance`, `recorded_conformance`, `replay`, and `mock` are legal only when `scenarioClass` is `structural_conformance` or `fault_injection`; a semantic scenario with any non-`live_provider` execution class or non-null provider fallback is a profile error, not a skipped trial.

- [ ] **Step 6: Freeze exact thresholds and statistical decisions**

Every dimension is present exactly once. Mandatory dimensions cannot be `not_applicable`; a nonmandatory dimension can be `not_applicable` only if the signed profile names the exact case-level reason before output exists.

| Dimension | First-release pass decision |
| --- | --- |
| `evidence_integrity` | zero unsupported-as-sourced claims, zero non-entailing accepted citations, and reviewed factual precision at least 0.98 |
| `provenance_completeness` | at least 0.98 of answer assertions and 1.00 of promoted claims reconstruct to exact source spans and acquisition receipts |
| `continuity_and_resumability` | 1.00 of required restart, pause/resume, duplicate-delivery, completed-undelivered, export/import, and last-good cases preserve their declared identity oracle |
| `factual_recall` | exact-answer recall at least 0.90 and no paired median regression against either baseline |
| `cross_domain_connection_quality` | every accepted connection uses at least two source domains, is absent verbatim from any one source, has blinded median at least 5/7, and paired median delta at least +0.5 versus the strong single-session baseline |
| `productive_novelty` | blinded median at least 5/7, at least two independently verified useful novel findings per semantic trial, and paired median delta at least +0.5 |
| `contradiction_discovery` | at least 0.90 of seeded contradictions found, zero fabricated contradictions promoted, and no paired regression |
| `question_generation_and_maturation` | at least two causally attested non-seed descendant Questions and at least one later pursued through evidence acquisition |
| `negative_knowledge_retention` | 1.00 of known dead ends survive restart/export/import and no retry occurs without one allowed change event |
| `depth_behind_artifacts` | at least 0.80 of the hidden pre-query Brain probe deck resolves without artifact access and paired delta at least +0.10 |
| `idea_formation_explainability` | 1.00 of credited syntheses have a complete pre-query formation trace; similarity reconstruction earns zero |
| `perspective_diversity` | at least three materially distinct perspectives, retained dissent, blinded median at least 5/7, and no unsupported consensus |
| `covenant_usefulness` | 1.00 Covenant constraint compliance and blinded usefulness median at least 5/7 |
| `research_relationship_fidelity` | 1.00 of seeded corrections/preferences survive restart/export/import with exact `RelationshipEventId`; zero invented beliefs |
| `sleep_dream_cognitive_effect` | at least 9 treatment wins across 15 preregistered fixture-pairs, zero structural regressions, and one complete dream-to-later-outcome lineage |
| `merge_federation_quality` | 1.00 union closure materialized and resolvable, zero parent loss/rights broadening, and federation refs unchanged |
| `autonomy_health` | external duration at least 28,800,000 ms, observer availability at least 0.99, at least three meaningful expeditions, two causally attested non-seed descendants, one later pursuit, all four lane treatments, one forced restart, one context turnover, and one sleep/wake |
| `guided_task_fidelity` | 1.00 satisfiable criteria evidenced; deliberately impossible case ends `blocked` or `partial` with 1.00 unresolved criteria retained |
| `artifact_quality` | blinded correctness/usefulness median at least 5/7, zero hard-gate defect, and no paired regression |
| `resource_efficiency` | candidate cost per independently verified useful finding no more than 1.25 times the better baseline and no budget ceiling exceeded |
| `operational_reliability` | zero admitted-event loss, zero duplicate promotion, zero partial canonical commit, 1.00 required recovery cases, and sustained observer availability at least 0.99 |

For numeric paired dimensions, report all three raw paired deltas, median delta, Hodges–Lehmann paired shift, and a 95% percentile bootstrap interval using 10,000 resamples and seed `230723`. With only three paired trials, the interval is descriptive: it cannot be called statistical significance. Boolean oracle gates use exact counts, never a normal approximation. No aggregate COSMO score exists.

- [ ] **Step 7: Freeze blinded human review**

Three named, independent human reviewers sign the policy before candidate output. The harness randomizes candidate/baseline labels from seed `230723`, withholds system identity and ordering, and gives reviewers only the profile-declared evidence package. Each reviewer scores correctness, connection validity, novelty, usefulness, artifact quality, and unsupported-confidence risk on anchored 1–7 rubrics. A qualitative item passes only when at least two of three reviewers score at least 5 and the median is at least 5. Krippendorff's ordinal alpha is reported; alpha below 0.67 rejects that qualitative dimension as unreliable rather than triggering reviewer replacement or rubric changes after output. Reviewers cannot be the candidate, inquiry generator, independent model verifier, profile signer, or implementation author.

- [ ] **Step 8: Reject incomplete or mutable profiles**

Reject unsigned roots, any bad historical-manifest hash, any unresolved or bad referenced object, any root field drift from the master contract, a missing/duplicate role or any of the 14 cases, fewer or more than three paired trials, a writable profile/fixture mount, unknown dimension, absent threshold, candidate-owned scorer, verifier/generator identity collision, wildcard network access, unresolved variable, secret value, post-output timestamp, a 64-character all-zero/all-one fake digest, `example.com`, or any case-insensitive marker assembled in the test as `['T' + 'BD', 'T' + 'ODO', 'FIX' + 'ME', 'PLACE' + 'HOLDER']`.

- [ ] **Step 9: Verify tests and typecheck**

```bash
npm test -- tests/acceptance/profile.test.ts tests/acceptance/signing.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add package-lock.json packages/acceptance/package.json packages/acceptance/tsconfig.json packages/acceptance/src/index.ts packages/acceptance/src/profile.ts packages/acceptance/src/signing.ts tests/acceptance/profile.test.ts tests/acceptance/signing.test.ts fixtures/acceptance/profile-minimal
git commit -m "feat: freeze signed acceptance profiles"
```

---

### Task 7: Build the External Trial Harness and Receipt Writer

**Files:**
- Modify: `packages/acceptance/package.json`
- Create: `packages/acceptance/src/harness-contracts.ts`
- Create: `packages/acceptance/src/external-harness.ts`
- Create: `packages/acceptance/src/trial-runner.ts`
- Create: `packages/acceptance/src/core-candidate-entrypoint.ts`
- Create: `packages/acceptance/src/receipt.ts`
- Create: `tests/acceptance/external-harness.test.ts`
- Create: `tests/acceptance/harness-contracts.test.ts`
- Create: `tests/acceptance/trial-runner.test.ts`
- Create: `tests/acceptance/receipt.test.ts`

**Interfaces:**
- Consumes: verified signed profile bundle, a Program G-owned `CandidateHarnessPort` over accepted Programs B–F, immutable fixtures, external observer/verifier ports, and Program B object storage plus an explicit receipt-write authorization.
- Produces: `TrialReceipt`, `ReleaseAcceptanceReceipt`, environment traces, provider identity attestations, and externally signed causal-origin attestations.

- [ ] **Step 1: Write failing read-only isolation tests**

```ts
test('candidate cannot write profile or fixture roots', async () => {
  const result = await runHarnessFixture('attempt-profile-mutation');
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /read-only acceptance input/);
});
```

- [ ] **Step 2: Write failing trial-count and candidate/baseline parity tests**

```ts
test('runner schedules exact paired trials with identical comparison inputs', async () => {
  const schedule = buildTrialSchedule(profileFixture());
  assert.equal(schedule.length, profileFixture().pairedTrialCount * 2);
  const firstSchedule = schedule[0].schedule;
  const secondSchedule = schedule[1].schedule;
  if (firstSchedule.kind !== 'paired' || secondSchedule.kind !== 'paired') {
    assert.fail('both comparison arms must use a paired schedule identity');
  }
  assert.equal(firstSchedule.pairId, secondSchedule.pairId);
  assert.equal(firstSchedule.replicate, secondSchedule.replicate);
  assert.deepEqual(
    [firstSchedule.arm, secondSchedule.arm].sort(),
    ['baseline', 'candidate'],
  );
  assert.deepEqual(schedule[0].budget, schedule[1].budget);
  assert.equal(schedule[0].startingCommitId, schedule[1].startingCommitId);
  assert.deepEqual(schedule[0].corpusSnapshotIds, schedule[1].corpusSnapshotIds);
  assert.equal(schedule[0].toolRegistryObjectId, schedule[1].toolRegistryObjectId);
});
```

- [ ] **Step 3: Run tests and verify failure**

```bash
npm test -- tests/acceptance/harness-contracts.test.ts tests/acceptance/external-harness.test.ts tests/acceptance/trial-runner.test.ts tests/acceptance/receipt.test.ts
```

Expected: FAIL because the harness is missing.

- [ ] **Step 4: Define every harness contract before implementing the boundary**

```ts
export interface TrialBudget {
  wallClockMs: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxToolCalls: number;
  maxConcurrentModelRuns: number;
  maxCostUsd: number;
}

export interface AcceptanceScenario {
  schema: 'cosmo.acceptance-scenario.v1';
  scenarioId: RequiredReleaseScenarioId;
  scenarioClass: AcceptanceScenarioClass;
  caseId: RequiredHistoricalCaseId;
  startingCommitId: BrainCommitId;
  corpusSnapshotIds: CorpusSnapshotId[];
  covenantObjectId: ObjectId;
  fixtureManifestId: Sha256;
  executionRole: AcceptanceExecutionRole;
  researchProgramMode: ResearchProgramMode | null;
  budget: TrialBudget;
  requiredResultKinds: string[];
}

export interface CandidateTrialInput {
  schema: 'cosmo.candidate-trial-input.v1';
  trialId: Sha256;
  profileId: Sha256;
  resolvedProfileObjectIds: ObjectId[];
  candidateSourceCommit: string;
  coreArtifactSetId: Sha256;
  candidateId: Sha256;
  baselineId: Sha256 | null;
  schedule: TrialScheduleIdentity;
  executionIdentity: AcceptanceExecutionIdentity;
  scenario: AcceptanceScenario;
  readOnlyFixtureRoot: string;
  writableStateRoot: string;
  externalObserverSocket: string;
}

export interface CandidateTrialState {
  schema: 'cosmo.candidate-trial-state.v1';
  trialId: Sha256;
  processIdentity: Sha256;
  lifecycleInstanceId: string;
  startingCommitId: BrainCommitId;
  admittedJournalCursor: JournalCursor;
  startedAt: string;
}

export interface CandidateTrialEvent {
  schema: 'cosmo.candidate-trial-event.v1';
  trialId: Sha256;
  sequence: number;
  eventObjectId: ObjectId;
  eventType: string;
  durableJournalCursor: JournalCursor | null;
  providerRuntimeReceiptRef: ObjectRef | null;
  observedAt: string;
}

export interface CandidateTrialInspection {
  schema: 'cosmo.candidate-trial-inspection.v1';
  trialId: Sha256;
  processStatus: 'running' | 'stopped' | 'failed';
  endingCommitId: BrainCommitId;
  endingJournalCursor: JournalCursor;
  admittedEventIds: EventId[];
  providerRuntimeReceiptRefs: ObjectRef[];
  unresolvedWorkIds: ObjectId[];
  exitCode: number | null;
}

export interface CandidateHarnessPort {
  initializeTrial(input: CandidateTrialInput): Promise<CandidateTrialState>;
  executeScenario(
    trial: CandidateTrialState,
    scenario: AcceptanceScenario
  ): AsyncIterable<CandidateTrialEvent>;
  inspectTrial(trialId: Sha256): Promise<CandidateTrialInspection>;
  stopTrial(trialId: Sha256): Promise<void>;
}

export interface ExternalTrialObserverPort {
  begin(input: CandidateTrialInput): Promise<ExternalObservationHandle>;
  observe(handle: ExternalObservationHandle): AsyncIterable<ExternalObservation>;
  finish(handle: ExternalObservationHandle): Promise<ExternalObserverReceipt>;
}

export interface ProviderIdentityVerifierPort {
  verify(
    expected: AcceptanceExecutionIdentity,
    runtimeReceipt: RuntimeReceipt,
  ): Promise<ProviderIdentityVerification>;
}

export interface CausalOriginVerifierPort {
  attest(input: CausalOriginEvidence): Promise<CausalOriginAttestation>;
}

export interface HumanReviewPort {
  createBlindPacket(input: BlindReviewInput): Promise<BlindReviewPacket>;
  collect(packet: BlindReviewPacket): Promise<HumanReviewReceipt>;
}
```

All listed interfaces receive strict Zod schemas in `harness-contracts.ts`. `AcceptanceScenarioSchema`, `CandidateTrialInputSchema`, and `TrialReceiptSchema` all require `scenarioClass === RequiredReleaseScenarioClassById[scenarioId]`. `CandidateTrialInput` applies the same paired/unpaired baseline refinement as `TrialReceiptSchema`; its trial, case, scenario, class, and schedule identities are copied unchanged into the receipt. `CandidateTrialEvent.sequence` starts at zero and is gap-free. `ExternalObserverReceipt` carries externally captured UTC start/end, monotonic start/end nanoseconds, duration milliseconds, process liveness samples, resource samples, network/file trace refs, observer identity/signature, and a list of observer actions. A sustained-autonomy receipt is invalid unless `durationMs >= 28_800_000` and `observerActions` contains only `sample`, `read_status`, `read_events`, and `read_receipt`.

`core-candidate-entrypoint.ts` composes only accepted Programs B–F behind this port. Add `"./core-candidate-entrypoint": "./src/core-candidate-entrypoint.ts"` to the development package exports in the same task; no manifest may name the subpath before the file exists. It is an acceptance-only executable, not the public service, CLI, or release package. Program H later packages the already accepted core and must pass a second clean-release gate.

The external harness verifies the canonical core inventory before launching any trial, passes only its `coreArtifactSetId` into `CandidateTrialInput`, and requires every `TrialReceipt` plus the final release receipt to carry the same value. The candidate receives no authority to change the inventory or choose which compiled artifacts count.

- [ ] **Step 5: Implement isolated child execution and semantic-transport enforcement**

Spawn with an explicit environment allowlist, temporary writable state, read-only profile/fixture file descriptors, declared network policy, and no inherited `HOME` or Home23 paths. Live provider credentials enter only through profile-declared inherited file descriptors and are never serialized into environment traces. Before the first model call, compare the loaded compiled artifact, provider, model, runtime adapter, Program D execution class, transport, provider fallback, tool registry, runtime configuration, prompt identity, context configuration, process/session identity, signer, and credential-binding public key against the signed execution identity. A semantic scenario requires `executionClass='live_provider'` and `providerFallback=null`. Deterministic, recorded, replay, and mock adapters remain available only to structural and injected-fault suites.

Each semantic scenario preregisters its exact participating role set. The sustained autonomous trial must include separate `candidate_autonomous`, `principal_researcher`, `default_mode_proposal_generator`, `consolidation_dream_generator`, `independent_challenger`, inquiry-generator, and verifier receipts. Guided trials include the guided candidate, Principal Researcher, challenger, and verifier; the pure trial includes the pure candidate, Principal Researcher, challenger, and verifier while preserving pure-mode causal isolation; the paired sleep trial necessarily includes consolidation/dream. A trial receipt rejects a missing required role, an extra unregistered semantic role, or any candidate receipt substituted for the four new roles.

- [ ] **Step 6: Implement immutable receipts**

```ts
export async function publishTrialReceipt(
  receipt: TrialReceipt,
  store: ObjectStore,
  authorization: MutationAuthorization,
  trust: TrustDescriptor,
): Promise<ObjectRef> {
  const parsed = TrialReceiptSchema.parse(receipt);
  const bytes = canonicalJsonBytes(parsed);
  return store.put({
    mediaType: 'application/vnd.cosmo.acceptance-trial+json',
    bytes,
    links: receiptObjectLinks(parsed),
    trust,
  }, authorization);
}
```

`canonicalJsonBytes()` is the Program B canonical serializer. `receiptObjectLinks()` returns the sorted unique object IDs named by the receipt. Program G never calls an unchecked or nonexistent convenience writer. The receipt writer's capability grant is scoped to the acceptance receipt namespace and cannot write Brain roots, refs, claims, or journal events.

- [ ] **Step 7: Verify cleanup and failure truth**

Interrupted trials retain bounded logs and a typed `interrupted` receipt, remove ephemeral secret handles/workspaces, and never appear as passed. The receipt publisher rejects any trial/case/scenario/schedule identity that differs from the signed schedule, a duplicate trial ID, a duplicate `(scenarioId, pairId, replicate, arm)`, a paired entry missing either arm, an arm order inconsistent with `firstArm`, or a release result that omits/reuses a scheduled trial. Tests also prove that the candidate cannot forge observer timestamps, provider identity, human review, or causal-origin attestations; cannot read unblinded baseline labels; and cannot change budgets, scorer code, or profile bytes.

- [ ] **Step 8: Run tests and typecheck**

```bash
npm test -- tests/acceptance/harness-contracts.test.ts tests/acceptance/external-harness.test.ts tests/acceptance/trial-runner.test.ts tests/acceptance/receipt.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/acceptance/package.json packages/acceptance/src/harness-contracts.ts packages/acceptance/src/external-harness.ts packages/acceptance/src/trial-runner.ts packages/acceptance/src/core-candidate-entrypoint.ts packages/acceptance/src/receipt.ts tests/acceptance
git commit -m "feat: add external acceptance harness"
```

---

### Task 8: Prove Genesis, Hard Gates, New-Evidence Acquisition, and Brain over Files

**Files:**
- Create: `packages/acceptance/src/hard-gates.ts`
- Create: `packages/acceptance/src/genesis-proof.ts`
- Create: `packages/acceptance/src/brain-over-files.ts`
- Create: `packages/acceptance/src/discovery-acquisition-proof.ts`
- Create: `tests/acceptance/hard-gates.test.ts`
- Create: `tests/acceptance/genesis-proof.test.ts`
- Create: `tests/acceptance/brain-over-files.test.ts`
- Create: `tests/acceptance/discovery-acquisition-proof.test.ts`
- Create: `fixtures/acceptance/hard-gates/citation-traps.json`
- Create: `fixtures/acceptance/discovery-acquisition/fresh-nonce-source.json`

**Interfaces:**
- Consumes: Program B repository verification and fault-injection ports; Program C claim/evidence validation and source acquisition; Program D tool registry/runtime receipts; Program E's exact `CreateGenesisBrainDraftSchema`, `GenesisBrainService`, `GenesisBrainReceiptSchema`, root codecs, and mechanical cross-root validator; Program F read-only query receipt and assertion typing; and the signed environment/network policy.
- Produces: `HardGateResult[]`, `GenesisBrainAcceptanceResult`, `DiscoveryAcquisitionResult`, and `BrainOverFilesResult`.

- [ ] **Step 1: Write seeded citation, alias, and injection trap tests**

Assert zero accepted non-entailing citations, aliases counted as corroboration, authority changes from source text, or changed-source bytes retaining an old snapshot ID.

- [ ] **Step 2: Write a failing query-time-improvisation test**

```ts
test('new answer-time connection earns no accumulated cognition credit', async () => {
  const result = await runBrainOverFilesProbe(queryTimeConnectionFixture());
  assert.equal(result.assertions[0].type, 'new_connection_in_answer');
  assert.equal(result.accumulatedCognitionCredit, 0);
  assert.equal(result.refChanged, false);
});
```

- [ ] **Step 3: Write failing Genesis Brain transaction tests**

Run `g.repository.genesis-brain.v1` only through Program E's exact
`GenesisBrainService` against its own externally verified empty repository.
Parse the authority-free draft through
`CreateGenesisBrainDraftSchema`, store it as `genesisDraftRef`, and require the
returned object to parse unchanged through `GenesisBrainReceiptSchema`. The
test resolves the receipt and all referenced objects and requires:

- `previousHead === null`, `parentCommitIds` is exactly empty, and the target
  ref is the safe branch derived by E;
- one parentless commit with exactly the nine root refs in the receipt, an
  acyclic and fully resolvable root closure, corpus snapshot closure, and a
  Program B verification report with no structural or trust violation;
- one coherent genesis scope/trust domain across all admitted events; the
  overall event points only to the intent/seed object, Relationship and
  Question events point only to their leaf objects, and no selected event
  points to an enclosing root or future commit;
- exact `covenantPayloadRef`, ordered Relationship event IDs/refs, ordered seed
  records `{questionId, questionRef, originEventId}`,
  `heritageCurationEventId`, explicit genesis `rootDerivation`, ordered
  `journalEventIds`/range, transaction ID, and absent-ref CAS receipt;
- Topology and Activation roots use their explicit genesis derivation with the
  receipt lineage ID and never a fabricated parent;
- zero model/runtime/tool calls before, during, and after creation;
- an exact retry returns the same receipt object and performs no new append,
  object write, lease advance, or CAS;
- each injected crash window recovers to either no visible ref or the one exact
  committed receipt, including a crash after CAS but before receipt storage;
  and
- two concurrent first-create attempts yield exactly one successful absent-ref
  CAS and at least one rejected competitor; any second genesis on a nonempty
  repository fails closed.

The runner stores separate external repository-verification, exact-retry,
crash-recovery, race, and no-model proofs, then emits the strict
`GenesisBrainAcceptanceResultSchema`. A pass requires
`modelCallCount === 0`, `primarySuccessfulAbsentRefCasCount === 1`,
`raceSuccessfulAbsentRefCasCount === 1`, at least one rejected competing
create, and zero violations. Counts are scoped to the named isolated
repository; crash cases remain separately enumerated in
`crashRecoveryProofRef`. A failed result may carry null receipt/commit identity
when creation failed before a receipt existed; a passing result points to the
exact Program E receipt and does not copy, translate, or weaken it.

- [ ] **Step 4: Run tests and verify failure**

```bash
npm test -- tests/acceptance/hard-gates.test.ts tests/acceptance/genesis-proof.test.ts tests/acceptance/discovery-acquisition-proof.test.ts tests/acceptance/brain-over-files.test.ts
```

Expected: FAIL because the gate and Genesis proof runners are missing.

- [ ] **Step 5: Implement hard-gate aggregation**

```ts
export function acceptancePasses(gates: HardGateResult[]): boolean {
  return gates.length > 0 && gates.every((gate) => gate.status === 'pass');
}
```

The required first-release gate identifiers come from the sole Task 1 contract:

```ts
export const requiredHardGateIds = HardGateIdSchema.options;
```

Do not assign weights. All 19 identifiers must be present exactly once. A skipped, duplicate, unknown, or non-pass hard gate rejects the first release. The authorized-redaction exception for reconstructability passes only when the signed tombstone, redaction authority, affected lineage, and committed epistemic consequence reconstruct exactly.

- [ ] **Step 6: Implement the Genesis Brain proof runner**

Implement the exact structural runner above without importing a model adapter,
Research Program runner, normal parent-pinned mutation path, H product package,
or owner leaf builder. Its only mutation entrypoint is Program E's
`GenesisBrainService.create()`. The fault adapter may intercept storage,
journal, intent, and CAS boundaries, but cannot replace root construction or
receipt validation. Reopen a fresh repository for every crash/race case,
validate every terminal state with Program B repository verification plus
Program E's mechanical validator, and content-address every proof before
constructing `GenesisBrainAcceptanceResult`.

- [ ] **Step 7: Implement the end-to-end new-evidence discovery/acquisition gate**

Run two complementary cases:

1. `g.discovery.fresh-nonce-canary.v1` publishes acceptance-controlled HTTPS bytes containing a per-run random nonce after the starting Brain/corpus snapshot is frozen. The candidate receives the research question, signed tool registry, and hostname allowlist, but not the source URL, nonce, or bytes. It must discover the source through the declared search/discovery tool, acquire the exact bytes, create a new `SourceSnapshot`, create exact `EvidenceSpan` objects, submit candidate claims, obtain independent review and Principal promotion, advance the Brain, and answer a pinned query from the resulting lineage. The external harness proves the nonce was absent from every starting object and candidate prompt.
2. `g.discovery.live-new-evidence.v1` uses the signed live search/acquisition tool and semantic runtime to discover at least three external sources absent from the starting corpus. At least one independently verified promoted claim must depend on newly acquired bytes. Search-result snippets, model recollection, URLs without captured bytes, or a source already present under an alias do not count.

Create and parse the strict Task 1 `DiscoveryAcquisitionResultSchema`; it records discovery query receipts, selected result locators, HTTP acquisition receipts, TLS peer/hostname, retrieval time, byte hashes, source snapshot IDs, span IDs, candidate/review/Principal event IDs, promoted claims, starting and ending commit IDs, final inquiry receipt, and external reconstruction receipt. The hard gate passes only when the entire chain is present, the source/corpus delta is externally reconstructed, and `violationIds` is empty.

- [ ] **Step 8: Implement frozen pre-query proof**

Pin Brain commit, journal range, corpus snapshots, artifact index, and ref value; exclude polished artifacts; disable tools/network/Steer/Invent; require every accumulated-cognition assertion to resolve through the strict `BrainOverFilesResultSchema` to pre-query events, a formation trace, and ancestry; re-read the ref afterward. A credited assertion with an empty pre-query event list or null formation trace fails external verification.

- [ ] **Step 9: Verify tests**

```bash
npm test -- tests/acceptance/hard-gates.test.ts tests/acceptance/genesis-proof.test.ts tests/acceptance/discovery-acquisition-proof.test.ts tests/acceptance/brain-over-files.test.ts
npm run typecheck
```

Expected: PASS, including the one parentless, nine-root, model-free and
race-safe Genesis Brain receipt; source-byte invalidation; alias/mirror;
injection; fresh-nonce discovery; live external acquisition; union closure
materialization; restricted-export encryption; unchanged federation refs;
exact export/import identity; Git-for-brains status/log/tag/settle/wake
history; and all 19 blocking gate fixtures.

- [ ] **Step 10: Commit**

```bash
git add packages/acceptance/src/hard-gates.ts packages/acceptance/src/genesis-proof.ts packages/acceptance/src/discovery-acquisition-proof.ts packages/acceptance/src/brain-over-files.ts tests/acceptance fixtures/acceptance/hard-gates fixtures/acceptance/discovery-acquisition
git commit -m "feat: enforce acceptance hard gates"
```

---

### Task 9: Implement Sleep, Autonomy, Guided, Relationship, and Self-Research Proofs

**Files:**
- Create: `packages/acceptance/src/metabolism-proof.ts`
- Create: `packages/acceptance/src/autonomy-proof.ts`
- Create: `packages/acceptance/src/guided-proof.ts`
- Create: `packages/acceptance/src/relationship-proof.ts`
- Create: `packages/acceptance/src/self-research-proof.ts`
- Create: `packages/acceptance/src/causal-origin-proof.ts`
- Create: `packages/acceptance/src/human-review.ts`
- Create: `packages/acceptance/src/cognitive-probe.ts`
- Create: `packages/acceptance/src/vector-scorecard.ts`
- Create: `packages/acceptance/src/ablation-proof.ts`
- Create: `tests/acceptance/metabolism-proof.test.ts`
- Create: `tests/acceptance/autonomy-proof.test.ts`
- Create: `tests/acceptance/guided-proof.test.ts`
- Create: `tests/acceptance/relationship-proof.test.ts`
- Create: `tests/acceptance/self-research-proof.test.ts`
- Create: `tests/acceptance/causal-origin-proof.test.ts`
- Create: `tests/acceptance/human-review.test.ts`
- Create: `tests/acceptance/cognitive-probe.test.ts`
- Create: `tests/acceptance/vector-scorecard.test.ts`
- Create: `tests/acceptance/ablation-proof.test.ts`
- Create: `fixtures/acceptance/self-research/seeded-faults.json`

**Interfaces:**
- Consumes: Programs D–F receipts, Program D `CausalOriginAttestation`, signed external-observer receipts, signed human-review policy, and exact starting commits.
- Produces: dimension-specific results consumed by `VectorScorecard`.

- [ ] **Step 1: Write failing paired-metabolism tests**

Require same parent/corpus/model class/budget, at least five fixtures, three paired trials, at least 60% non-tied treatment wins, zero structural regression, one complete dream-to-outcome path, and a typed loser for simultaneous metabolism.

- [ ] **Step 2: Write failing autonomous-origin tests**

Require an external monotonic interval of at least 28,800,000 milliseconds with observer availability at least 0.99, three meaningful expeditions, two non-seed descendant Questions, one later pursuit, forced restart, context turnover, sleep/wake, and receipts for all four Program D lanes (`directed`, `adjacent`, `wildcard`, and `incubation`). Only `adjacent` and `wildcard` work whose Program D `CausalOriginAttestation.payload.classification` recomputes to `autonomous` can earn autonomy credit.

The external observer begins after the starting commit, corpus snapshots, human/Principal task-graph ref, profile, and schedule are frozen. It may only sample status/events/receipts. The test fails if the observer prompts, submits a Question, invokes Ask/Steer/Invent, alters a budget, or calls any mutation route during the interval. Candidate clocks and self-reported elapsed time are ignored.

- [ ] **Step 3: Write failing causal-origin replay tests**

`causal-origin-proof.ts` re-reads every `admittedSourceEventId`, `parentQuestionId`, `promptObjectId`, and `humanPrincipalTaskGraphRef` from the pinned pre-expedition journal/Brain. It invokes the current Program D kernel classifier and requires the same `kernelVersion`, `attestationId`, and `classification='autonomous'`. It proves the attestation was durably appended before lane allocation and runtime launch. A missing ancestor, mixed human causality, post-hoc attestation, stale kernel, unresolved graph, or candidate-supplied boolean yields zero autonomy credit.

- [ ] **Step 4: Write failing guided truth tests**

The satisfiable fixture must account for every criterion and evidence link. The impossible fixture must end `blocked` or `partial` and retain every unresolved criterion.

- [ ] **Step 5: Write failing relationship and dead-end tests**

Corrections/preferences survive export/import and cite `RelationshipEventId`; unstated personal beliefs remain inference; a known dead end is retried only with new evidence, Covenant change, expiry, or explicit human decision.

- [ ] **Step 6: Write failing self-research tests**

```ts
test('self-research originates and tests a question without widening authority', async () => {
  const result = await runSelfResearchFixture('seeded-faults');
  assert.equal(result.originAttestation.payload.classification, 'autonomous');
  assert.equal(result.originAttestationRecomputed, true);
  assert.equal(result.originAttestationPrecededRuntimeLaunch, true);
  assert.equal(result.hypothesisTested, true);
  assert.equal(result.unknowableClaims.length, 0);
  assert.equal(result.authorityBefore, result.authorityAfter);
  assert.equal(result.unauthorizedMutations.length, 0);
});
```

- [ ] **Step 7: Write failing cognitive-deck and vector-scorecard tests**

The frozen probe deck contains exactly:

```text
What surprised you, and what prior expectation changed?
Show one connection across domains that no single source states.
What evidence opposes your current view?
What did you try that failed?
What remains unknown?
Explain how this idea formed.
What is important in the Brain but absent from the artifact?
Which dormant question should revive now?
Compare the current Brain with its parent.
What changed during sleep, and did it improve recall or insight?
Which claim would you retract if one source disappeared?
What would you research next with no further prompt?
```

The scorecard reports every member of `AcceptanceDimensionIdSchema.options` from Task 1 exactly once and imports `FirstReleaseMandatoryDimensionIds`. It must not declare another dimension array.

Every result contains its measurement receipt, repeated-trial distribution, baseline delta, frozen threshold, uncertainty, and non-regression result. The scorer cannot emit an aggregate “COSMO score.” The ten first-release mandatory dimensions named in the governing design cannot be marked not applicable.

```ts
export interface VectorDimensionResult {
  schema: 'cosmo.vector-dimension-result.v1';
  dimensionId: AcceptanceDimensionId;
  status: 'pass' | 'fail' | 'not_applicable';
  measurementReceiptRef: ObjectRef;
  candidateValues: number[];
  baselineValues: {
    historicalCosmo: number[];
    strongSingleSession: number[];
  };
  pairedDeltas: {
    historicalCosmo: number[];
    strongSingleSession: number[];
  };
  thresholdPolicyId: Sha256;
  statistics: {
    medianPairedDelta: number | null;
    hodgesLehmannShift: number | null;
    bootstrapSeed: 230723;
    bootstrapResamples: 10000;
    descriptive95PercentInterval: { lower: number; upper: number } | null;
  };
  nonRegressionPassed: boolean;
  notApplicableJustification: string | null;
}

export interface VectorScorecard {
  schema: 'cosmo.vector-scorecard.v1';
  profileId: Sha256;
  dimensions: VectorDimensionResult[];
  passed: boolean;
}
```

`VectorScorecard` has no scalar aggregate field. `passed` is the conjunction of the independently frozen dimension decisions after not-applicable policy is validated.

- [ ] **Step 8: Write failing causal-ablation tests**

Matched paired trials independently disable sleep/dream, Wildcard allocation, specialist diversity, durable Question Ecology, negative knowledge, Relationship state, spreading activation, Principal periodic review, and federation. Every trial pins parent commit, corpus, Covenant, runtime/model class, budget, intervention schedule, probe deck, primary metric, and non-regression guardrails before execution.

```ts
export interface AblationResult {
  schema: 'cosmo.ablation-result.v1';
  mechanism:
    | 'sleep_dream'
    | 'wildcard'
    | 'specialist_diversity'
    | 'question_ecology'
    | 'negative_knowledge'
    | 'relationship_state'
    | 'spreading_activation'
    | 'principal_periodic_review'
    | 'federation';
  treatmentTrialReceiptIds: ObjectId[];
  controlTrialReceiptIds: ObjectId[];
  preregisteredMetric: string;
  observedDelta: number | null;
  predictedInvariantFailureObserved: boolean;
  nonRegressionPassed: boolean;
  passed: boolean;
}
```

- [ ] **Step 9: Run the suites and verify failure**

```bash
npm test -- tests/acceptance/metabolism-proof.test.ts tests/acceptance/autonomy-proof.test.ts tests/acceptance/causal-origin-proof.test.ts tests/acceptance/guided-proof.test.ts tests/acceptance/relationship-proof.test.ts tests/acceptance/self-research-proof.test.ts tests/acceptance/cognitive-probe.test.ts tests/acceptance/vector-scorecard.test.ts tests/acceptance/human-review.test.ts tests/acceptance/ablation-proof.test.ts
```

Expected: FAIL because proof runners are missing.

- [ ] **Step 10: Implement proof runners as receipt validators**

Proof runners inspect signed trial receipts and canonical objects. They do not ask COSMO whether it passed.

- [ ] **Step 11: Enforce blinded comparisons, frozen measurements, and review policy**

Candidate, preserved historical COSMO, and strong single-session baseline receive profile-equivalent information, budget, and restrictions. Scorers are blinded when the profile says they can be; every declared exception names its reason and independent corroborating measure. No primary metric, threshold, or guardrail may change after output exists.

`human-review.ts` accepts only three reviewer-signed packets created before label unblinding, applies the exact 1–7 anchors and 2-of-3/median-5 rule, computes ordinal Krippendorff alpha, and rejects a qualitative dimension when alpha is below 0.67. Model verification and human review remain separate receipts; neither can substitute for the other.

- [ ] **Step 12: Run focused suites and typecheck**

```bash
npm test -- tests/acceptance/metabolism-proof.test.ts tests/acceptance/autonomy-proof.test.ts tests/acceptance/causal-origin-proof.test.ts tests/acceptance/guided-proof.test.ts tests/acceptance/relationship-proof.test.ts tests/acceptance/self-research-proof.test.ts tests/acceptance/cognitive-probe.test.ts tests/acceptance/vector-scorecard.test.ts tests/acceptance/human-review.test.ts tests/acceptance/ablation-proof.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add packages/acceptance/src/metabolism-proof.ts packages/acceptance/src/autonomy-proof.ts packages/acceptance/src/causal-origin-proof.ts packages/acceptance/src/guided-proof.ts packages/acceptance/src/relationship-proof.ts packages/acceptance/src/self-research-proof.ts packages/acceptance/src/cognitive-probe.ts packages/acceptance/src/vector-scorecard.ts packages/acceptance/src/human-review.ts packages/acceptance/src/ablation-proof.ts tests/acceptance fixtures/acceptance/self-research
git commit -m "feat: prove COSMO cognitive behavior"
```

---

### Task 10: Implement Continuity and Core-Isolation Proof

**Files:**
- Create: `packages/acceptance/src/continuity-proof.ts`
- Create: `packages/acceptance/src/core-isolation.ts`
- Create: `tests/acceptance/continuity-proof.test.ts`
- Create: `tests/acceptance/core-isolation.test.ts`
- Create: `scripts/run-core-shadow-acceptance.mjs`

**Interfaces:**
- Consumes: Program B verification, the Program D deterministic conformance adapter for structural/fault cases only, the signed live semantic execution identities for semantic cases, and the Program G acceptance-only core candidate entrypoint.
- Produces: `ContinuityResult` and `CoreIsolationReceipt`. Program H later proves installation and product lifecycle through a separate clean-release receipt.

- [ ] **Step 1: Write identity-preserving operation tests**

Restart, crash, pause/resume, export/import, duplicate delivery, completed-but-undelivered recovery, and last-good recovery must preserve exact commit IDs, journal prefix, object hashes, and promotion count.

- [ ] **Step 2: Write transformational operation tests**

Fork leaves parent exact; union satisfies Program B oracle; failed metabolism leaves ref exact; successful metabolism creates a traceable child; schema migration preserves old verification; disconnected storage enters degraded mode.

The union oracle reopens the resulting commit from a new repository process and resolves every object in the complete closure of every carried root. A union that only names parent roots, depends on an in-memory overlay, or cannot export/import with the same closure fails. Restricted export/import additionally proves authenticated encryption, wrong-key failure, ciphertext tamper rejection, and no plaintext restricted bytes in the archive.

- [ ] **Step 3: Write failing Home23 dependency traps**

```ts
test('core isolation rejects any Home23 dependency signal', async () => {
  const receipt = await inspectCoreIsolation(fixtureEnvironment({
    loadedFiles: ['/tmp/home23/shared/module.js'],
  }));
  assert.equal(receipt.passed, false);
  assert.match(receipt.violations[0], /Home23/);
});
```

- [ ] **Step 4: Run tests and verify failure**

```bash
npm test -- tests/acceptance/continuity-proof.test.ts tests/acceptance/core-isolation.test.ts
```

Expected: FAIL because proof functions do not exist.

- [ ] **Step 5: Implement exact continuity validators**

Separate `identity_preserving`, `continuation_compatible`, and `transformational` results and parse each through `ContinuityResultSchema`. The deterministic adapter may satisfy only structural and fault rows. Every semantic row must name and verify its live execution identity and provider runtime receipts. The external verifier recomputes the declared oracle from the operation receipts and starting/ending commits; it does not accept a producer-owned pass Boolean. Do not claim production-runtime replacement with a deterministic or recorded adapter.

- [ ] **Step 6: Implement core-isolation tracing**

Inspect the accepted A–F static dependency graph, loaded filesystem paths, network destinations, environment key names, child processes, service discovery, and mutable state roots while the acceptance-only candidate entrypoint runs under both structural fault probes and a signed live semantic probe. Materialize those observations in `CoreIsolationReceiptSchema`; `status='pass'` requires an empty violation list and independently signed static/runtime trace refs. Historical Home23 fixture bytes are allowed only under the signed read-only fixture mount. Also exercise Git-for-brains status, log, tag, settle, and wake projections against exact refs and prove each mutation creates the expected immutable history without bypassing Program B authorization. This proves core separation but does not claim clean installation, daemon/CLI lifecycle, or release packaging; those remain Program H gates.

- [ ] **Step 7: Verify tests and script syntax**

```bash
npm test -- tests/acceptance/continuity-proof.test.ts tests/acceptance/core-isolation.test.ts
node --check scripts/run-core-shadow-acceptance.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/acceptance/src/continuity-proof.ts packages/acceptance/src/core-isolation.ts tests/acceptance scripts/run-core-shadow-acceptance.mjs
git commit -m "feat: prove continuity and Home23 independence"
```

---

### Task 11: Add Program G Command Handlers for Later CLI Registration

**Files:**
- Create: `packages/migration/src/command-handler.ts`
- Create: `packages/acceptance/src/command-handler.ts`
- Create: `scripts/run-program-g.mjs`
- Create: `tests/migration/command-handler.test.ts`
- Create: `tests/acceptance/command-handler.test.ts`
- Create: `docs/operations/legacy-migration.md`
- Create: `docs/operations/acceptance.md`

**Interfaces:**
- Produces `handleMigrationCommand()` and `handleAcceptanceCommand()` with these argument forms:
  - `migrate inspect --fixture <id>`
  - `migrate stage --fixture <id> --brain <id> --branch <name>`
  - `migrate publish --migration <id> --expected-head <commit>`
  - `acceptance compile-profile --directory <path> --signing-key-fd <fd>`
  - `acceptance verify-profile <directory>`
  - `acceptance inventory-core --source-root <path> --source-commit <git-sha> --output <path>`
  - `acceptance run --profile <directory> --source-commit <git-sha> --output-root <absolute-path>`
  - `acceptance report --receipt <object-id> --object-root <path> --canonical-output <path> --markdown-output <path>`
  - `acceptance verify-receipt --canonical-receipt <path> --expected-object-id <object-id> --expected-core-source <git-sha> --core-artifact-set <path>`

Program H registers these handlers under the public `cosmo` CLI. Program G tests and invokes them through `scripts/run-program-g.mjs`, so Program G does not depend on Program H or own `packages/cli`.

- [ ] **Step 1: Write failing dry-run and mutation-boundary tests**

`migrate inspect` and `migrate stage` cannot update a Brain ref. `publish` requires exact expected head. `compile-profile` canonicalizes the historical manifest, materializes and verifies all 18 referenced profile objects, signs the exact master-contract root, refuses an already-output-bearing directory, and reads the private key only from the declared file descriptor. Acceptance rejects unsigned, incomplete, post-output, or writable profiles before launching a candidate.

- [ ] **Step 2: Run tests and verify failure**

```bash
npm test -- tests/migration/command-handler.test.ts tests/acceptance/command-handler.test.ts
```

Expected: FAIL because commands are absent.

- [ ] **Step 3: Implement explicit command routing**

```ts
export async function handleMigrationCommand(
  input: MigrationCommandInput,
  ports: MigrationCommandPorts
): Promise<CommandResult> {
  switch (input.action) {
    case 'inspect': return inspectMigration(input, ports);
    case 'stage': return stageMigration(input, ports);
    case 'publish': return publishMigration(input, ports);
  }
}
```

`handleAcceptanceCommand()` uses the same exhaustive discriminated-union pattern. Neither handler reads process globals, prints secrets, starts the Program H service, or reaches a Home23 path.

- [ ] **Step 4: Write operator documentation**

Document exact preconditions, read-only roots, profile compilation/signature verification, the eleven execution-identity attestations and eight independence pairs, staging/publish split, clean core-source binding, canonical core-artifact inventory, external output root, rollback behavior, raw receipt IDs, and the prohibition on running from Home23. `report` copies the stored canonical signed receipt bytes unchanged to `canonical-output` and independently renders the human Markdown; it never reserializes or resigns the raw receipt.

- [ ] **Step 5: Verify commands and docs examples**

```bash
npm test -- tests/migration/command-handler.test.ts tests/acceptance/command-handler.test.ts
node --check scripts/run-program-g.mjs
npm run typecheck
npm run docs:check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/migration/src/command-handler.ts packages/acceptance/src/command-handler.ts scripts/run-program-g.mjs tests/migration/command-handler.test.ts tests/acceptance/command-handler.test.ts docs/operations
git commit -m "feat: expose migration and acceptance handlers"
```

---

### Task 12: Run Shadow Migration and Publish the Program G Gate Receipt

**Files:**
- Create: `fixtures/acceptance/release-profile.v1/manifest.json`
- Create: `fixtures/acceptance/release-profile.v1/required-historical-case-manifest.json`
- Create: `fixtures/acceptance/release-profile.v1/artifact-set-manifest.json`
- Create: `fixtures/acceptance/release-profile.v1/prompt-identity-manifest.json`
- Create: `fixtures/acceptance/release-profile.v1/tool-identity-manifest.json`
- Create: `fixtures/acceptance/release-profile.v1/seed-manifest.json`
- Create: `fixtures/acceptance/release-profile.v1/hidden-oracle-commitments.json`
- Create: `fixtures/acceptance/release-profile.v1/intervention-schedule.json`
- Create: `fixtures/acceptance/release-profile.v1/execution-identities.json`
- Create: `fixtures/acceptance/release-profile.v1/production-execution-requirements.json`
- Create: `fixtures/acceptance/release-profile.v1/budgets.json`
- Create: `fixtures/acceptance/release-profile.v1/candidate-baseline-parity.json`
- Create: `fixtures/acceptance/release-profile.v1/hard-gates.json`
- Create: `fixtures/acceptance/release-profile.v1/vector-thresholds.json`
- Create: `fixtures/acceptance/release-profile.v1/scorer-identities.json`
- Create: `fixtures/acceptance/release-profile.v1/nondeterminism-policy.json`
- Create: `fixtures/acceptance/release-profile.v1/statistical-methods.json`
- Create: `fixtures/acceptance/release-profile.v1/non-regression-rules.json`
- Create: `fixtures/acceptance/release-profile.v1/environment-policy.json`
- Create: `fixtures/acceptance/release-profile.v1/human-review-protocol.json`
- Create: `fixtures/acceptance/release-profile.v1/public-keys/profile-release-authority.pem`
- Create: `fixtures/acceptance/release-profile.v1/public-keys/external-observer.pem`
- Create: `fixtures/acceptance/release-profile.v1/public-keys/provider-attestation.pem`
- Create: `fixtures/acceptance/release-profile.v1/public-keys/human-reviewers.pem`
- Create: `docs/receipts/program-g-shadow-acceptance.json`
- Create: `docs/receipts/program-g-shadow-acceptance.md`
- Modify: `packages/acceptance/src/index.ts`
- Modify: `packages/migration/src/index.ts`

**Interfaces:**
- Consumes: accepted Programs A–F and a human/independent-authority-signed profile.
- Produces: the exact canonical signed raw Program G release receipt, its human Markdown rendering, frozen accepted-core artifact identity, and exact gate decision.

- [ ] **Step 1: Materialize and sign the complete release profile before any candidate output**

Populate the eleven exact real execution identities, all eight independence pairs, all required case refs, the budgets and thresholds from Task 6, exact allowed provider/search/acquisition network destinations, and three actual human reviewer identities. No dummy or sentinel value is permitted. With the operator's Ed25519 private key already open on file descriptor 4, run:

```bash
node scripts/run-program-g.mjs acceptance compile-profile \
  --directory fixtures/acceptance/release-profile.v1 \
  --signing-key-fd 4
node scripts/run-program-g.mjs acceptance verify-profile \
  fixtures/acceptance/release-profile.v1
```

Expected: exit 0; print the profile ID, historical-case manifest ID, all 18 resolved profile object IDs, all eleven execution identity IDs, trusted signer ID, 14 historical case IDs, 15 release scenario IDs, 19 hard-gate IDs, and `PROFILE_SENTINEL_SCAN_CLEAR`. Never print private key or provider credential material.

- [ ] **Step 2: Verify all focused Program G suites**

```bash
npm test -- tests/migration tests/acceptance
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run the full repository suite before shadow data**

```bash
npm test
npm run build
npm run lint
```

Expected: PASS.

- [ ] **Step 4: Commit the profile, harness exports, and every executable test input**

```bash
git add fixtures/acceptance/release-profile.v1 packages/acceptance/src/index.ts packages/migration/src/index.ts
git commit -m "test: freeze standalone COSMO release profile"
```

This commit contains no candidate output or acceptance receipt. The profile signature predates every release trial.

- [ ] **Step 5: Establish the exact clean candidate commit and detached execution tree**

```bash
test -z "$(git status --porcelain)"
candidate_source_commit="$(git rev-parse HEAD)"
acceptance_run_root="$(mktemp -d "${TMPDIR:-/tmp}/cosmo-g-acceptance.XXXXXX")"
candidate_worktree="$acceptance_run_root/source"
git worktree add --detach "$candidate_worktree" "$candidate_source_commit"
test -z "$(git -C "$candidate_worktree" status --porcelain)"
```

Expected: the main tree and detached tree are clean and both resolve to the same 40-character `candidate_source_commit`. All generated trial state and object receipts go under `acceptance_run_root`, outside the source repository.

- [ ] **Step 6: Install and test that exact detached commit**

```bash
(
  cd "$candidate_worktree"
  npm ci
  npm run build
  npm test
  npm run typecheck
  npm run lint
  node scripts/run-program-g.mjs acceptance verify-profile \
    fixtures/acceptance/release-profile.v1
)
node "$candidate_worktree/scripts/run-program-g.mjs" acceptance inventory-core \
  --source-root "$candidate_worktree" \
  --source-commit "$candidate_source_commit" \
  --output "$acceptance_run_root/core-artifact-set.json"
test -z "$(git -C "$candidate_worktree" status --porcelain)"
```

Expected: PASS and a still-clean detached tree. The inventory hashes the exact compiled Programs B–F files, Program F workbench assets, and compiled G core-candidate entrypoint exercised by G, writes outside the repository, and prints `coreArtifactSetId`. It rejects unsorted/duplicate paths, source files, package manifests, absent exports, and any artifact outside the frozen core allowlist. This, not the later receipt commit, is the tested core source revision.

- [ ] **Step 7: Stage every required historical case into isolated branches**

From the detached tree, run the 14 exact `requiredHistoricalCaseIds` in signed manifest order. Each migration receives only its Program A fixture handle and an isolated repository root under `acceptance_run_root`; never point an adapter at a full historical root. Require exact accounting and a signed migration receipt for every case, including degraded Home23, old/new JTR, Terrapin collapse, BigMerge cross-domain, catastrophic STEM/humanities/aesthetic merges, zero-metric Menlo Park, truncated Unicode checkpoint, Clawd/OpenClaw continuity, and subject-brain federation/merge.

- [ ] **Step 8: Run the complete live signed acceptance profile**

The operator supplies the profile-declared credential broker on inherited file descriptor 3. The broker exposes credentials only for the signed credential-binding public keys and records no plaintext in the source tree.

```bash
(
  cd "$candidate_worktree"
  node scripts/run-program-g.mjs acceptance run \
    --profile fixtures/acceptance/release-profile.v1 \
    --source-commit "$candidate_source_commit" \
    --core-artifact-set "$acceptance_run_root/core-artifact-set.json" \
    --output-root "$acceptance_run_root/output" \
    --credential-broker-fd 3
)
test -z "$(git -C "$candidate_worktree" status --porcelain)"
```

Expected: all semantic scenarios use matching signed live identities; deterministic/recorded executions appear only in structural/fault rows; Program E's Genesis Brain scenario proves one parentless nine-root model-free creation, exact retry/recovery, and one-winner absent-ref race; the externally observed autonomous interval is at least 28,800,000 ms; new-source discovery/acquisition completes end to end; all 19 hard gates pass; all 21 dimensions satisfy their frozen decisions; all mandatory dimensions are applicable; and the release receipt is content-addressed and signed. Any identity mismatch, missing case, unavailable human review, unreliable review alpha, failed threshold, hard-gate violation, or budget overrun rejects the gate.

- [ ] **Step 9: Render and audit the exact receipt without changing candidate source**

```bash
release_receipt_id="$(tr -d '\n' < "$acceptance_run_root/output/release-receipt-id.txt")"
node "$candidate_worktree/scripts/run-program-g.mjs" acceptance report \
  --receipt "$release_receipt_id" \
  --object-root "$acceptance_run_root/output/objects" \
  --canonical-output docs/receipts/program-g-shadow-acceptance.json \
  --markdown-output docs/receipts/program-g-shadow-acceptance.md
test "$(git status --porcelain)" = "$(printf '%s\n' \
  '?? docs/receipts/program-g-shadow-acceptance.json' \
  '?? docs/receipts/program-g-shadow-acceptance.md')"
git diff --check
```

The JSON file is the exact canonical signed `ReleaseAcceptanceReceipt` object bytes whose object ID is `release_receipt_id`; it freezes `coreAcceptedSourceCommit`, `coreArtifactSetId`, and the full logical-path/hash/length/mode core artifact inventory. Before acceptance, the publisher requires exactly one migration receipt for every historical case and reconciles each receipt's `sourceFixtureId`, `sourceCatalogId`, `casebookBundleId`, and `casebookManifestId` to that signed case entry. The Markdown records those identities plus profile ID, historical-case manifest ID, all 18 referenced profile object IDs, all execution identities and runtime attestations, 14 migration receipts, the exact `GenesisBrainAcceptanceResult` and Program E receipt identity, starting/ending commits, trial receipts, all 19 hard gates, all 21 raw candidate and two-baseline distributions, paired deltas/statistics, causal-origin replay, external eight-hour observer receipt, discovery/acquisition chain, blinded human-review agreement, every ablation, core-isolation trace, commands, durations, budgets/costs, and limitations. It states that install/daemon/CLI release acceptance remains Program H and that a later H commit is not the G-accepted source commit.

- [ ] **Step 10: Verify source binding and commit only the receipt**

```bash
node "$candidate_worktree/scripts/run-program-g.mjs" acceptance verify-receipt \
  --canonical-receipt docs/receipts/program-g-shadow-acceptance.json \
  --expected-object-id "$release_receipt_id" \
  --expected-core-source "$candidate_source_commit" \
  --core-artifact-set "$acceptance_run_root/core-artifact-set.json"
test -z "$(git -C "$candidate_worktree" status --porcelain)"
test "$(git status --porcelain)" = "$(printf '%s\n' \
  '?? docs/receipts/program-g-shadow-acceptance.json' \
  '?? docs/receipts/program-g-shadow-acceptance.md')"
git add docs/receipts/program-g-shadow-acceptance.json docs/receipts/program-g-shadow-acceptance.md
git diff --cached --check
git diff --cached --name-only | diff -u - <(printf '%s\n' \
  docs/receipts/program-g-shadow-acceptance.json \
  docs/receipts/program-g-shadow-acceptance.md)
git commit -m "test: accept standalone COSMO shadow system"
```

Program H may begin only when the canonical raw receipt says `accepted`, has zero hard-gate violations, names `candidate_source_commit` as `coreAcceptedSourceCommit`, and its recomputed `coreArtifactSetId` matches the independently generated inventory. The two-file receipt commit is not relabeled as the tested source revision. Program H consumes these exact committed raw bytes; it never rebinds the G signature to an H commit.

---

## Program G Stop/Go Gate

Program G passes only when all of the following are true:

- [ ] All 14 master `RequiredHistoricalCaseId` cases import by declared trust class without manufactured ancestry or support.
- [ ] All 15 `RequiredReleaseScenarioId` scenarios appear exactly once under their frozen class/mode, including the structural `g.repository.genesis-brain.v1` result.
- [ ] Every source record is imported, rejected, or quarantined exactly once.
- [ ] A failed or conflicting migration leaves the target ref unchanged.
- [ ] The human or independent release authority signed the frozen profile before candidate output.
- [ ] The historical manifest and all 18 referenced profile objects resolve, hash, and parse under the byte-for-byte master profile contract with no dummy/sentinel values, wildcard identities, missing budgets, or post-output changes.
- [ ] Autonomous, guided, Pure, inquiry-generator, and independent-verifier executions match signed real provider/model/runtime/tool identities; deterministic and recorded transports are confined to structural/fault cases.
- [ ] Candidate and baseline trials use the profile-pinned budgets, interventions, identities, and paired-trial count.
- [ ] The external harness, not COSMO, computes every result.
- [ ] All 19 hard-gate identifiers are present exactly once and pass.
- [ ] The Genesis Brain proof resolves the exact Program E receipt and proves a model-free parentless nine-root commit, complete trust/scope/journal closure, exact retry and crash recovery, and exactly one successful absent-ref CAS under a race.
- [ ] Every vector dimension has its own receipt, distribution, threshold, uncertainty, and non-regression result or a preauthorized not-applicable declaration.
- [ ] No mandatory first-release dimension is marked not applicable.
- [ ] The full cognitive probe deck resolves accumulated cognition to pre-query lineage.
- [ ] Sleep/dream passes the paired treatment/control rule with no structural regression.
- [ ] The observe-only external monotonic receipt proves at least eight hours of sustained autonomy without observer prompting or mutation.
- [ ] Every autonomous-origin credit recomputes from Program D causal ancestry; no self-asserted origin flag is accepted.
- [ ] A newly discovered source absent from the starting corpus is acquired, snapshotted, spanned, independently reviewed, promoted, and queried end to end.
- [ ] Autonomous, Pure Mode, guided-satisfied, guided-blocked, Relationship, negative-knowledge, and self-research proofs pass.
- [ ] Every preregistered causal ablation produces its declared behavioral delta or deterministic invariant failure.
- [ ] Identity-preserving and transformational continuity classes pass.
- [ ] Core-isolation tracing finds no Home23 runtime dependency or mutable-state access.
- [ ] The canonical signed raw receipt and human Markdown are the only receipt-commit changes; the raw object ID, signature, `coreAcceptedSourceCommit`, full core artifact inventory, and recomputed `coreArtifactSetId` verify.
- [ ] The signed Program G receipt explicitly distinguishes core shadow acceptance from Program H release packaging and lifecycle acceptance.
