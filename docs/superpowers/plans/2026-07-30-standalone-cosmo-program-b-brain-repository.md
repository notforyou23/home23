# Standalone COSMO Program B: Brain Repository and Trust Kernel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the immutable authority layer for standalone COSMO: content-addressed objects, trust-domain encryption, admitted journals, signed grants, atomic Brain commits and refs, Git-for-brains history and curation, forks, diffs, recursively consumable lossless union, read-only federation, portable export/import, authorized redaction, and deterministic crash/concurrency recovery.

**Architecture:** Canonical objects are immutable descriptors over plaintext payload identity, while private/restricted storage uses independently rotatable trust-domain ciphertext envelopes. Brain commits hash only their canonical unsigned payload; branch visibility changes only through leased compare-and-swap refs. Typed curation history records why preserved Brain states matter. Every public mutation is authorized, intent-journaled before acting, idempotent during replay, and recoverable without asking a model what happened.

**Tech Stack:** Node.js 22.12+, TypeScript ESM, npm workspaces, Zod v4, Node `crypto` Ed25519, filesystem content-addressed storage, `node:test` through `tsx`.

## Global Constraints

- The canonical source repository is `/Users/jtr/_JTR23_/cosmo`; Home23 is neither a package dependency nor a runtime host.
- Runtime and private installation state live under `~/.cosmo` and remain untracked.
- Program A's passing preservation receipt is required before this plan starts.
- Every durable identity is content-addressed or explicitly names a content-addressed parent.
- Workers and model calls never write canonical Brain state.
- The Trust and Continuity Kernel validates authority and transition mechanics; it never determines semantic truth.
- Candidate cognition is admitted through quarantine and schema/grant/provenance checks before entering the cognitive journal.
- A long-running session and its compaction state are runtime working memory, not the Brain and not sleep/dream.
- Merge is lossless authorized union before any separate metabolism commit.
- A merge cannot implicitly union Relationship state, private Program state, capability grants, private runtime data, or broaden rights.
- Commit identity is the SHA-256 hash of canonical `BrainCommitPayload` bytes; signatures are excluded from that hash.
- `BrainCommitPayload.journalEventIds`, not a cursor interval, is the authority
  for direct event membership. `journalRange` is only a verified high-water
  bound. A commit's event closure is the journal-ordered union of its parents'
  closures plus its own explicit IDs; unrelated globally interleaved events
  never enter a Brain merely because their cursors fall inside the range.
- A commit-root payload never embeds the child/enclosing `BrainCommitId`; derivation may name only already-existing parent commits, while the root codec receives the enclosing `sourceCommitId` during verification/materialization.
- Object identity binds media type, plaintext payload hash, links, and trust descriptor. Public payload bytes may be deduplicated globally; private/restricted payloads are envelope-encrypted and may be reused only inside the same trust domain and key generation.
- Ciphertext storage identity is distinct from immutable plaintext/object identity: trust-domain key rotation may replace the active envelope without changing `payloadSha256`, `objectId`, or any `BrainCommitId`.
- All canonical ref mutations require a live lease epoch, matching fencing token, signed capability grant, and expected head.
- A late or stale writer may leave an unreachable immutable object; it may not advance a canonical ref.
- Export/import reproduces exact commit IDs. Import verifies in quarantine before exposing any ref.
- Authorized redaction is explicit and signed; it yields `valid_with_authorized_redactions`, never ordinary validity.
- Ordinary federation and diff are read-only and leave every participating ref and root unchanged.
- The first standalone repository requires Node `>=22.12.0` and Zod `^4`.
- Use TDD, run the smallest focused test first, and commit after every independently reviewable task.
- Do not begin Program C until crash, concurrency, export/import, union, federation, and redaction gates pass.

---

## File Map

Paths are relative to `/Users/jtr/_JTR23_/cosmo`.

| Path | Responsibility |
| --- | --- |
| `packages/contracts/src/repository.ts` | Brain commit, journal, grant, encryption, ref, curation, Git-for-brains, diff, union-resolution, federation, bundle, and redaction schemas |
| `packages/repository/src/layout.ts` | Validated repository paths and safe names |
| `packages/repository/src/object-store.ts` | Plaintext object identity and immutable object descriptor CAS |
| `packages/repository/src/blob-envelope-store.ts` | Public plaintext blobs plus trust-domain ciphertext envelopes and active-envelope indexes |
| `packages/repository/src/encryption-keyring.ts` | Injected key-provider boundary, key identity, rotation, rewrap, and authorized erasure |
| `packages/repository/src/signatures.ts` | Ed25519 identity, canonical signing, and detached verification |
| `packages/repository/src/trust-kernel.ts` | Signed grants, revocation, rights intersection, and authorization decisions |
| `packages/repository/src/journal-store.ts` | Hash-chained, idempotent, admitted append-only journal |
| `packages/repository/src/lease-store.ts` | Epoch/fencing leases |
| `packages/repository/src/ref-store.ts` | Leased compare-and-swap refs and last-known-good refs |
| `packages/repository/src/commit-store.ts` | Immutable Brain commit payloads and detached signatures |
| `packages/repository/src/heritage-genesis-builder.ts` | Dedicated empty Intellectual Heritage builder for E-owned Brain genesis |
| `packages/repository/src/root-registry.ts` | Startup-frozen typed commit-root verification, closure, union dispatch, and materialization |
| `packages/repository/src/heritage-root-codec.ts` | Concrete typed codec for non-cyclic Intellectual Heritage root snapshots |
| `packages/repository/src/schema-registry.ts` | Version admission and auditable representation migrations |
| `packages/repository/src/transaction-coordinator.ts` | Append-before-act commit/ref transactions and recovery |
| `packages/repository/src/diff.ts` | Root, ancestry, and reachable-object differences |
| `packages/repository/src/fork.ts` | Exact-parent branch creation |
| `packages/repository/src/curation-ledger.ts` | Typed append-only Intellectual Heritage and Curation ledger |
| `packages/repository/src/brain-operations.ts` | Git-for-brains `status`, `log`, `tag`, `settle`, and `wake` semantics |
| `packages/repository/src/union.ts` | Authorized lossless union commits and recursive union-root layer resolution |
| `packages/repository/src/federation.ts` | Read-only exact-commit `BrainSet` |
| `packages/repository/src/bundle.ts` | Deterministic `.brain` directory export/import |
| `packages/repository/src/redaction.ts` | Signed tombstones and physical/logical redaction |
| `packages/repository/src/recovery.ts` | Startup reconciliation, bit-rot/degraded mode, and temp cleanup |
| `packages/repository/src/brain-repository.ts` | Authorized public façade |
| `packages/repository/src/index.ts` | Public `@cosmo/repository` exports |
| `packages/repository/test/*.test.ts` | Focused unit and integration tests |
| `packages/repository/test/support/fixtures.ts` | Deterministic repositories, keys, grants, commits, and fault fixtures |
| `fixtures/contracts/repository/*` | Deterministic object, merge, crash, and corruption fixtures |
| `scripts/verify-program-b.mjs` | Clean-commit Program B gate runner and canonical receipt writer |
| `docs/architecture/brain-repository.md` | Authority model, layout, recovery, and operator semantics |
| `docs/receipts/program-b-brain-repository.json` | Program B stop/go receipt |

## Public Interfaces Consumed by Programs C–H

These names and signatures are frozen:

```ts
export interface MutationAuthorization {
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
}

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
      programId: `program_${string}` | null;
      lineageId: Sha256;
      trustDomain: string | null;
    };

export interface PutObjectInput {
  mediaType: string;
  bytes: Uint8Array;
  links: ObjectId[];
  trust: TrustDescriptor;
}

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

export interface BrainObjectAddress {
  sourceCommitId: BrainCommitId;
  rootKind: BrainRootKind;
  rootObjectId: ObjectId;
  objectId: ObjectId;
}

export type BrainObjectLink =
  | {
      scope: 'existing';
      address: BrainObjectAddress;
    }
  | {
      scope: 'local';
      rootKind: BrainRootKind;
      objectRef: ObjectRef;
    };

export interface VerifyBrainRootInput {
  rootKind: BrainRootKind;
  sourceCommitId: BrainCommitId;
  root: ObjectRef;
  authorization?: MutationAuthorization;
}

export interface BrainRootLeafInput extends VerifyBrainRootInput {
  reader: Pick<ObjectStore, 'get' | 'verify'>;
}

export interface BrainRootLeafVerification<TSnapshot = unknown> {
  schema: 'cosmo.brain-root-leaf-verification.v1';
  rootKind: BrainRootKind;
  sourceCommitId: BrainCommitId;
  root: ObjectRef;
  payloadSchema: string;
  snapshot: TSnapshot;
  directReferencedObjectIds: ObjectId[];
  valid: boolean;
  reasonCodes: string[];
}

export interface BrainRootCodec<TSnapshot = unknown> {
  readonly rootKind: BrainRootKind;
  readonly payloadSchema: string;
  verifyLeaf(
    input: BrainRootLeafInput
  ): Promise<BrainRootLeafVerification<TSnapshot>>;
  materializeLeaf(input: BrainRootLeafInput): Promise<TSnapshot>;
}

export interface BrainRootClosure {
  schema: 'cosmo.brain-root-closure.v1';
  rootKind: BrainRootKind;
  sourceCommitId: BrainCommitId;
  requestedRoot: ObjectRef;
  leafLayers: UnionRootLayerRef[];
  reachableObjectIds: ObjectId[];
}

export interface BrainRootVerification {
  schema: 'cosmo.brain-root-verification.v1';
  rootKind: BrainRootKind;
  sourceCommitId: BrainCommitId;
  requestedRoot: ObjectRef;
  valid: boolean;
  payloadSchemas: string[];
  leafLayers: UnionRootLayerRef[];
  reachableObjectIds: ObjectId[];
  issueCodes: Array<
    | 'root_kind_mismatch'
    | 'union_not_permitted'
    | 'union_cycle'
    | 'union_depth_exceeded'
    | 'codec_missing'
    | 'payload_schema_mismatch'
    | 'descriptor_link_mismatch'
    | 'object_invalid'
    | 'object_unreadable'
    | 'typed_reference_invalid'
  >;
}

export interface BrainRootMaterialization<TSnapshot = unknown> {
  schema: 'cosmo.brain-root-materialization.v1';
  rootKind: BrainRootKind;
  sourceCommitId: BrainCommitId;
  requestedRoot: ObjectRef;
  leaves: Array<{
    sourceCommitId: BrainCommitId;
    root: ObjectRef;
    payloadSchema: string;
    snapshot: TSnapshot;
  }>;
  reachableObjectIds: ObjectId[];
}

export interface CommitRootVerification {
  schema: 'cosmo.commit-root-verification.v1';
  commitId: BrainCommitId;
  valid: boolean;
  roots: Record<BrainRootKind, BrainRootVerification>;
  reachableObjectIds: ObjectId[];
}

export interface BrainCrossRootValidationInput {
  candidateCommitId: BrainCommitId;
  payload: BrainCommitPayload;
  roots: Record<BrainRootKind, BrainRootMaterialization<unknown>>;
}

export interface BrainCrossRootValidation {
  schema: 'cosmo.brain-cross-root-validation.v1';
  validatorId: string;
  candidateCommitId: BrainCommitId;
  valid: boolean;
  issueCodes: string[];
  checkedObjectIds: ObjectId[];
}

export interface BrainCrossRootValidator {
  readonly validatorId: string;
  validate(
    input: BrainCrossRootValidationInput
  ): Promise<BrainCrossRootValidation>;
}

export interface BrainRootRegistry {
  closure(input: VerifyBrainRootInput): Promise<BrainRootClosure>;
  verify(input: VerifyBrainRootInput): Promise<BrainRootVerification>;
  materialize<TSnapshot = unknown>(
    input: VerifyBrainRootInput
  ): Promise<BrainRootMaterialization<TSnapshot>>;
  verifyCommit(commitId: BrainCommitId): Promise<CommitRootVerification>;
}

export interface ObjectStore {
  put(input: PutObjectInput, authorization: MutationAuthorization): Promise<ObjectRef>;
  get(ref: ObjectRef, authorization?: MutationAuthorization): Promise<StoredObject>;
  has(objectId: ObjectId): Promise<boolean>;
  verify(ref: ObjectRef): Promise<ObjectVerification>;
}

export interface JournalStore {
  append(input: AppendJournalInput): Promise<JournalRecord>;
  read(range: JournalRange): AsyncIterable<JournalRecord>;
  head(): Promise<JournalCursor>;
  verify(): Promise<JournalVerification>;
}

export interface CommitEventClosure {
  schema: 'cosmo.commit-event-closure.v1';
  commitId: BrainCommitId;
  directJournalEventIds: EventId[];
  inheritedJournalEventIds: EventId[];
  allJournalEventIds: EventId[];
  scopes: BrainEventScope[];
}

export interface CommitStore {
  create(
    payload: BrainCommitPayload,
    signatures: DetachedSignature[] | undefined,
    authorization: MutationAuthorization
  ): Promise<BrainCommit>;
  get(commitId: BrainCommitId): Promise<BrainCommit>;
  verify(commitId: BrainCommitId): Promise<VerificationReport>;
  eventClosure(commitId: BrainCommitId): Promise<CommitEventClosure>;
}

export interface RefStore {
  get(name: BrainRefName): Promise<BrainCommitId | null>;
  compareAndSwap(input: CompareAndSwapRefInput): Promise<RefUpdateReceipt>;
}

export interface LeaseStore {
  acquire(input: AcquireLeaseInput): Promise<LeaseProof>;
  renew(lease: LeaseProof, ttlMs: number): Promise<LeaseProof>;
  release(lease: LeaseProof): Promise<void>;
}

export interface BrainRepository {
  readonly repositoryIdentity: Sha256;
  objects: ObjectStore;
  journal: JournalStore;
  commits: CommitStore;
  refs: RefStore;
  leases: LeaseStore;
  trust: TrustKernel;
  roots: BrainRootRegistry;
  inspectGenesisEligibility(input: {
    targetRef: BrainRefName;
  }): Promise<GenesisRepositoryEligibility>;
  commitAndAdvance(input: CommitAndAdvanceInput): Promise<CommitAdvanceReceipt>;
  status(input: BrainStatusInput): Promise<BrainStatus>;
  log(input: BrainLogInput): Promise<BrainLogPage>;
  tag(input: TagBrainInput): Promise<RefUpdateReceipt>;
  settle(input: SettleBrainInput): Promise<SettleBrainReceipt>;
  wake(input: WakeBrainInput): Promise<WakeBrainReceipt>;
  curation: CurationLedger;
  heritageGenesis: HeritageGenesisBuilder;
  encryption: EncryptionAdministration;
  diff(left: BrainCommitId, right: BrainCommitId): Promise<BrainDiff>;
  fork(input: ForkRequest): Promise<RefUpdateReceipt>;
  union(input: UnionRequest): Promise<UnionReceipt>;
  resolveUnionRootLayers(
    input: ResolveUnionRootLayersInput
  ): Promise<ResolvedUnionRootLayers>;
  federate(input: FederatedReadRequest): Promise<BrainSet>;
  exportBundle(input: ExportBundleInput): Promise<ExportReceipt>;
  importBundle(input: ImportBundleInput): Promise<ImportReceipt>;
  verify(commitId: BrainCommitId): Promise<VerificationReport>;
  reconcile(): Promise<RecoveryReport>;
}

export interface GenesisRepositoryEligibility {
  schema: 'cosmo.genesis-repository-eligibility.v1';
  targetRef: BrainRefName;
  targetHead: null;
  commitCount: 0;
  refCount: 0;
  scopedJournalEventCount: 0;
  eligible: true;
}

export interface HeritageGenesisBuildInput {
  schema: 'cosmo.heritage-genesis-build-input.v1';
  rationale: string;
  trust: TrustDescriptor;
  idempotencyKey: Sha256;
  requestedAt: string;
  authorization: MutationAuthorization;
}

export interface HeritageGenesisRoots {
  schema: 'cosmo.heritage-genesis-roots.v1';
  heritageRootRef: ObjectRef;
  heritage: HeritageSnapshot;
  createdCurationEventId: ObjectId;
  idempotencyKey: Sha256;
  builtAt: string;
}

export interface HeritageGenesisBuilder {
  build(input: HeritageGenesisBuildInput): Promise<HeritageGenesisRoots>;
}

export function openBrainRepository(options: {
  rootDir: string;
  rootCodecs: readonly BrainRootCodec[];
  crossRootValidators: readonly BrainCrossRootValidator[];
  clock?: Clock;
  signer?: Signer;
  faultInjector?: FaultInjector;
  encryptionKeyProvider?: EncryptionKeyProvider;
}): Promise<BrainRepository>;
```

## Deterministic Test Support Contract

All helper names used in test snippets are implemented in `packages/repository/test/support/fixtures.ts`; they never touch `~/.cosmo` or historical data.

```ts
export interface TestRepository extends BrainRepository {
  clock: MutableTestClock;
  testSigner: Signer;
  testAuthorization: MutationAuthorization;
  schemaRegistry: SchemaRegistry;
}

export const publicTrust: TrustDescriptor;
export function h(hexCharacter: string): Sha256;
export function fixtureCommitPayload(): BrainCommitPayload;
export function textObject(text: string): PutObjectInput;
export function jsonObject(value: JsonValue): PutObjectInput;
export function leaseInput(resource: string, ttlMs: number): AcquireLeaseInput;
export function refUpdate(lease: LeaseProof): CompareAndSwapRefInput;
export function eventInput(
  repo: TestRepository,
  eventId: EventId,
  eventType: string,
  text: string
): Promise<AppendJournalInput>;
export function completeCommitPayload(repo: TestRepository): Promise<BrainCommitPayload>;
export function makeAuthorizedRepository(options?: FixtureFaultOptions): Promise<TestRepository>;
export function makeEmptyAuthorizedRepository(): Promise<TestRepository>;
export function makeUncheckedObjectStore(faultAt?: FaultPoint): Promise<TestFileObjectStore>;
export function makeTrustFixture(): Promise<TrustFixture>;
export function makeEncryptionFixture(): Promise<EncryptionFixture>;
export function makeEmptyTrustFixture(): Promise<EmptyTrustFixture>;
export function makeConcurrentRefFixture(): Promise<ConcurrentRefFixture>;
export function makeTwoCommitRepository(): Promise<TwoCommitFixture>;
export function makeInterleavedBranchJournalFixture(): Promise<InterleavedBranchJournalFixture>;
export function makeHeritageGenesisFixture(): Promise<HeritageGenesisFixture>;
export function makeUnionFixture(input: UnionFixtureInput): Promise<UnionFixture>;
export function makeNestedUnionFixture(): Promise<NestedUnionFixture>;
export function makeRightsConflictUnionFixture(): Promise<UnionFixture>;
export function makeFederationFixture(): Promise<FederationFixture>;
export function makeExportFixture(): Promise<ExportFixture>;
export function makeRedactionFixture(): Promise<RedactionFixture>;
export function makeSharedBlobRedactionFixture(): Promise<SharedBlobRedactionFixture>;
export function makeCrashFixture(point: FaultPoint): Promise<CrashFixture>;
export function closure(repo: BrainRepository, commitId: BrainCommitId): Promise<Set<ObjectId>>;
export function collect<T>(source: AsyncIterable<T>): Promise<T[]>;
export function countFiles(root: string): Promise<number>;
export function snapshotCommit(repo: BrainRepository, commitId: BrainCommitId): Promise<JsonValue>;
export function snapshotRepositoryIdentity(repo: BrainRepository): Promise<JsonValue>;
export function corruptOneBundleObject(bundlePath: string): Promise<void>;
export const allFaultPoints: readonly FaultPoint[];
```

Factories create unique temporary roots, bootstrap an Ed25519 owner and minimum signed grant, use a fixed mutable clock, and return cleanup methods. Test-only unchecked CAS methods are not exported from `@cosmo/repository`.

## Task 1: Extend Contracts and Scaffold `@cosmo/repository`

**Files:**
- Create: `packages/contracts/src/repository.ts`
- Modify: `packages/contracts/src/index.ts`
- Create: `packages/repository/package.json`
- Create: `packages/repository/tsconfig.json`
- Create: `packages/repository/src/layout.ts`
- Create: `packages/repository/src/index.ts`
- Test: `packages/repository/test/contracts.test.ts`
- Create: `packages/repository/test/support/fixtures.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: Program A IDs, `ObjectRef`, `JournalRange`, `TrustDescriptor`
- Produces: every public Program B schema and interface

`packages/repository/package.json` declares:

```json
{
  "name": "@cosmo/repository",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "node ../../scripts/run-tests.mjs test"
  },
  "dependencies": {
    "@cosmo/contracts": "*",
    "@cosmo/foundation": "*",
    "zod": "^4.0.0"
  }
}
```

The development workspace exports `./src/index.ts`. Only Program H's release builder may rewrite a staged release manifest to `./dist/index.js`; Program B never checks a dist-export manifest into the development tree.

- [ ] **Step 1: Write contract tests for commit identity and safe refs**

```ts
// packages/repository/test/contracts.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrainCommitPayloadSchema,
  BrainRefNameSchema,
  LeaseProofSchema,
  StoredObjectDescriptorSchema
} from '@cosmo/contracts';
import * as ContractRepositorySchemas from '@cosmo/contracts';
import * as PublicRepositorySchemas from '../src/index.js';
import {
  fixtureAppendJournalInput,
  fixtureCommitPayload,
  fixtureExportBundleInput,
  fixtureImportBundleInput,
  h,
  publicTrust,
} from './support/fixtures.js';

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false;
type Assert<Condition extends true> = Condition;
type _GenesisScopeTypeIdentity = Assert<Equal<
  PublicRepositorySchemas.GenesisBrainEventScope,
  ContractRepositorySchemas.GenesisBrainEventScope
>>;
type _LineageScopeTypeIdentity = Assert<Equal<
  PublicRepositorySchemas.BrainLineageEventScope,
  ContractRepositorySchemas.BrainLineageEventScope
>>;

test('Brain commit payload has all pinned roots and no signatures', () => {
  const payload = BrainCommitPayloadSchema.parse(fixtureCommitPayload());
  assert.equal(payload.schema, 'cosmo.brain-commit.v1');
  assert.equal('signatures' in payload, false);
  assert.equal(payload.heritageRoot.objectId.startsWith('sha256:'), true);
  assert.deepEqual(payload.journalEventIds, ['evt_fixture_1']);
  assert.equal(payload.schemaVersion, 1);
});

test('ref names cannot escape the repository', () => {
  assert.equal(BrainRefNameSchema.parse('refs/heads/main'), 'refs/heads/main');
  assert.throws(() => BrainRefNameSchema.parse('refs/heads/../../outside'));
  assert.throws(() => BrainRefNameSchema.parse('refs/heads//main'));
});

test('object descriptors bind links and trust to identity', () => {
  const descriptor = StoredObjectDescriptorSchema.parse({
    schema: 'cosmo.stored-object.v1',
    mediaType: 'application/json',
    byteLength: 2,
    payloadSha256: h('1'),
    links: [h('2')],
    trust: publicTrust
  });
  assert.deepEqual(descriptor.links, [h('2')]);
});

test('leases require epoch, fencing, resource, and expiry', () => {
  assert.throws(() => LeaseProofSchema.parse({
    leaseId: 'lease_x',
    resource: 'refs/heads/main',
    epoch: 1,
    expiresAt: '2026-07-30T12:00:00.000Z'
  }));
});

test('repository re-exports the sole contract schema objects by identity', () => {
  const names = [
    'AppendJournalInputSchema',
    'AcquireLeaseInputSchema',
    'RefUpdateReceiptSchema',
    'CommitAdvanceReceiptSchema',
    'CommitEventClosureSchema',
    'HeritageGenesisBuildInputSchema',
    'HeritageGenesisRootsSchema',
    'GenesisRepositoryEligibilitySchema',
    'BrainDiffSchema',
    'UnionReceiptSchema',
    'BrainEventScopeSchema',
    'GenesisBrainEventScopeSchema',
    'BrainLineageEventScopeSchema',
    'BrainObjectAddressSchema',
    'BrainObjectLinkSchema',
    'CanonicalBrainObjectAddressListSchema',
    'BrainRootKindSchema',
    'VerifyBrainRootInputSchema',
    'BrainRootLeafVerificationSchema',
    'BrainRootClosureSchema',
    'BrainRootVerificationSchema',
    'BrainRootMaterializationSchema',
    'CommitRootVerificationSchema',
    'BrainCrossRootValidationSchema',
    'FederatedReadRequestSchema',
    'BrainSetSchema',
    'ExportBundleInputSchema',
    'ExportReceiptSchema',
    'ImportBundleInputSchema',
    'ImportReceiptSchema',
    'VerificationReportSchema',
    'RecoveryReportSchema',
    'FaultPointSchema',
  ] as const;
  for (const name of names) {
    assert.equal(PublicRepositorySchemas[name], ContractRepositorySchemas[name]);
  }
});

test('narrow event-scope schemas are the exact branches of the sole union', () => {
  assert.equal(
    PublicRepositorySchemas.GenesisBrainEventScopeSchema,
    ContractRepositorySchemas.BrainEventScopeSchema.options[0],
  );
  assert.equal(
    PublicRepositorySchemas.BrainLineageEventScopeSchema,
    ContractRepositorySchemas.BrainEventScopeSchema.options[1],
  );
});

test('repository identity is public-safe, stable on reopen, and not path-derived', async () => {
  const fixture = await makeAuthorizedRepository();
  const first = fixture.repo.repositoryIdentity;
  assert.equal(Sha256Schema.safeParse(first).success, true);
  await fixture.reopen();
  assert.equal(fixture.repo.repositoryIdentity, first);
  assert.notEqual(first, sha256Text(fixture.rootDir));
  assert.equal(
    JSON.stringify(await fixture.readRepositoryIdentityRecord())
      .includes(fixture.rootDir),
    false,
  );
});

test('root contracts reject unsorted closure, kind drift, and unknown fields', () => {
  const root = {
    objectId: h('1'),
    mediaType: 'application/vnd.cosmo.epistemic-root+json',
    byteLength: 512,
  };
  assert.throws(() => ContractRepositorySchemas.BrainRootClosureSchema.parse({
    schema: 'cosmo.brain-root-closure.v1',
    rootKind: 'epistemicRoot',
    sourceCommitId: h('2'),
    requestedRoot: root,
    leafLayers: [{ sourceCommitId: h('2'), root }],
    reachableObjectIds: [h('4'), h('3')],
  }));
  assert.throws(() => ContractRepositorySchemas.VerifyBrainRootInputSchema.parse({
    rootKind: 'inventedRoot',
    sourceCommitId: h('2'),
    root,
  }));
  assert.throws(() => ContractRepositorySchemas.VerifyBrainRootInputSchema.parse({
    rootKind: 'epistemicRoot',
    sourceCommitId: h('2'),
    root,
    runtimeMutableRegistry: true,
  }));
});

test('merged object addresses retain source commit, root kind, root, and object', () => {
  const address = ContractRepositorySchemas.BrainObjectAddressSchema.parse({
    sourceCommitId: h('1'),
    rootKind: 'topologyRoot',
    rootObjectId: h('2'),
    objectId: h('3'),
  });
  assert.equal(address.objectId, h('3'));
  assert.throws(() =>
    ContractRepositorySchemas.CanonicalBrainObjectAddressListSchema.parse([
      { ...address, objectId: h('4') },
      address,
    ])
  );
});

test('object links distinguish existing attributed addresses from local refs', () => {
  const address = {
    sourceCommitId: h('1'),
    rootKind: 'topologyRoot',
    rootObjectId: h('2'),
    objectId: h('3'),
  };
  assert.equal(ContractRepositorySchemas.BrainObjectLinkSchema.safeParse({
    scope: 'existing',
    address,
  }).success, true);
  assert.equal(ContractRepositorySchemas.BrainObjectLinkSchema.safeParse({
    scope: 'local',
    rootKind: 'topologyRoot',
    objectRef: {
      objectId: h('4'),
      mediaType: 'application/json',
      byteLength: 2,
    },
  }).success, true);
  assert.equal(ContractRepositorySchemas.BrainObjectLinkSchema.safeParse({
    scope: 'existing',
    objectId: h('3'),
  }).success, false);
});

test('public operation schemas reject missing authority and unknown fields', () => {
  assert.throws(() => ContractRepositorySchemas.AppendJournalInputSchema.parse({
    ...fixtureAppendJournalInput(),
    capabilityGrantId: undefined,
  }));
  assert.throws(() => ContractRepositorySchemas.ExportBundleInputSchema.parse({
    ...fixtureExportBundleInput(),
    directFilesystemBypass: true,
  }));
  assert.throws(() => ContractRepositorySchemas.ImportBundleInputSchema.parse({
    ...fixtureImportBundleInput(),
    exposeRefs: [{
      ...fixtureImportBundleInput().exposeRefs[0],
      lease: undefined,
    }],
  }));
});
```

Define `h(character)` as a test-only helper returning `sha256:` plus 64 copies of the supplied lowercase hexadecimal character. Define complete `publicTrust`, `fixtureCommitPayload()`, `fixtureAppendJournalInput()`, `fixtureExportBundleInput()`, and `fixtureImportBundleInput()` in `packages/repository/test/support/fixtures.ts`. The operation fixtures return schema-complete strict objects with typed overrides and no `as any`.

- [ ] **Step 2: Register and commit the workspace before dependent tests**

Run:

```bash
npm install
git diff -- package-lock.json
git add packages/repository/package.json packages/repository/tsconfig.json package-lock.json
git commit -m "chore(repository): register workspace"
git diff --exit-code -- packages/repository/package.json \
  packages/repository/tsconfig.json package-lock.json
git diff --cached --quiet
```

Expected: npm recognizes `@cosmo/repository`, the lockfile contains its workspace entry, no unrelated dependency version changes appear, and the manifest/lockfile registration is committed before the first workspace-dependent test. The deliberately untracked or unstaged Program B source and test files remain available for Step 3 and the later implementation commit.

- [ ] **Step 3: Run the tests to verify Program B contracts are missing**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/contracts.test.ts
```

Expected: FAIL because `@cosmo/repository` and repository schemas do not exist.

- [ ] **Step 4: Define Brain commit and signature contracts exactly**

```ts
export const DetachedSignatureSchema = z.object({
  algorithm: z.literal('ed25519'),
  keyId: Sha256Schema,
  signatureBase64: z.string().min(1)
}).strict();

export const BrainEventScopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('genesis'),
    targetRef: BrainRefNameSchema,
    lineageId: Sha256Schema,
    trustDomain: z.string().min(1).nullable(),
  }).strict(),
  z.object({
    kind: z.literal('brain_lineage'),
    basedOnBrainCommitId: BrainCommitIdSchema,
    targetRef: BrainRefNameSchema,
    programId: z.string()
      .regex(/^program_[A-Za-z0-9_-]+$/)
      .nullable(),
    lineageId: Sha256Schema,
    trustDomain: z.string().min(1).nullable(),
  }).strict(),
]);

// These are identity-derived views of the sole union above. No owner may
// redeclare either branch as a structurally similar local schema.
export const GenesisBrainEventScopeSchema =
  BrainEventScopeSchema.options[0];
export const BrainLineageEventScopeSchema =
  BrainEventScopeSchema.options[1];
export type GenesisBrainEventScope =
  z.infer<typeof GenesisBrainEventScopeSchema>;
export type BrainLineageEventScope =
  z.infer<typeof BrainLineageEventScopeSchema>;

export const BrainObjectLinkSchema = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('existing'),
    address: BrainObjectAddressSchema,
  }).strict(),
  z.object({
    scope: z.literal('local'),
    rootKind: BrainRootKindSchema,
    objectRef: ObjectRefSchema,
  }).strict(),
]);

export type BrainObjectLink = z.infer<typeof BrainObjectLinkSchema>;

export const BrainCommitPayloadSchema = z.object({
  schema: z.literal('cosmo.brain-commit.v1'),
  parentCommitIds: z.array(Sha256Schema),
  corpusSnapshotIds: z.array(Sha256Schema),
  epistemicRoot: ObjectRefSchema,
  questionRoot: ObjectRefSchema,
  programRoot: ObjectRefSchema,
  relationshipRoot: ObjectRefSchema,
  heritageRoot: ObjectRefSchema,
  topologyRoot: ObjectRefSchema,
  activationRoot: ObjectRefSchema,
  negativeKnowledgeRoot: ObjectRefSchema,
  artifactIndexRoot: ObjectRefSchema,
  journalRange: JournalRangeSchema,
  journalEventIds: z.array(EventIdSchema).superRefine((eventIds, context) => {
    if (new Set(eventIds).size !== eventIds.length) {
      context.addIssue({
        code: 'custom',
        message: 'journalEventIds must be unique',
      });
    }
  }),
  principalVersion: Sha256Schema,
  kernelVersion: Sha256Schema,
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime()
}).strict().superRefine((payload, context) => {
  for (const [field, values] of [
    ['parentCommitIds', payload.parentCommitIds],
    ['corpusSnapshotIds', payload.corpusSnapshotIds]
  ] as const) {
    const normalized = [...new Set(values)].sort();
    if (JSON.stringify(values) !== JSON.stringify(normalized)) {
      context.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} must be unique and lexicographically sorted`
      });
    }
  }
});

export const BrainCommitSchema = z.object({
  commitId: Sha256Schema,
  payload: BrainCommitPayloadSchema,
  signatures: z.array(DetachedSignatureSchema)
}).strict();
```

- [ ] **Step 5: Define repository operation contracts**

Add strict schemas and inferred types for:

```ts
export type BrainRefName = `refs/${'heads' | 'tags' | 'settled'}/${string}`;

export interface StoredObjectDescriptor {
  schema: 'cosmo.stored-object.v1';
  mediaType: string;
  byteLength: number;
  payloadSha256: Sha256;
  links: ObjectId[];
  trust: TrustDescriptor;
}

export interface EncryptedBlobEnvelope {
  schema: 'cosmo.encrypted-blob-envelope.v1';
  trustDomain: string;
  keyId: Sha256;
  algorithm: 'aes-256-gcm';
  plaintextSha256: Sha256;
  ciphertextSha256: Sha256;
  nonceBase64: string;
  authTagBase64: string;
  plaintextByteLength: number;
  ciphertextByteLength: number;
  createdAt: string;
}

export type BlobStorageIdentity =
  | {
      mode: 'plaintext';
      plaintextSha256: Sha256;
      ciphertextSha256: null;
      trustDomain: null;
      keyId: null;
    }
  | {
      mode: 'encrypted';
      plaintextSha256: Sha256;
      ciphertextSha256: Sha256;
      trustDomain: string;
      keyId: Sha256;
    };

export interface EncryptionKeyMaterial {
  keyId: Sha256;
  keyBytes: Uint8Array;
}

export interface EncryptionKeyProvider {
  get(trustDomain: string, keyId: Sha256): Promise<EncryptionKeyMaterial | null>;
  createPrepared(trustDomain: string): Promise<EncryptionKeyMaterial>;
  activate(trustDomain: string, keyId: Sha256): Promise<void>;
  wrapForRecipient(
    trustDomain: string,
    keyId: Sha256,
    recipientWrappingKeyId: Sha256
  ): Promise<WrappedDomainKeyEnvelope>;
  unwrapAndInstall(envelope: WrappedDomainKeyEnvelope): Promise<void>;
  erase(trustDomain: string, keyId: Sha256): Promise<void>;
}

export interface WrappedDomainKeyEnvelope {
  schema: 'cosmo.wrapped-domain-key.v1';
  trustDomain: string;
  keyId: Sha256;
  recipientWrappingKeyId: Sha256;
  wrappingAlgorithm: string;
  wrappedKeySha256: Sha256;
  wrappedKeyBase64: string;
}

export interface JournalRecord {
  schema: 'cosmo.journal-record.v1';
  cursor: JournalCursor;
  eventId: EventId;
  eventType: string;
  payloadRef: ObjectRef;
  brainScope: BrainEventScope | null;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  idempotencyKey: string;
  occurredAt: string;
  recordedAt: string;
  previousRecordHash: Sha256 | null;
  recordHash: Sha256;
}

export interface LeaseProof {
  leaseId: `lease_${string}`;
  resource: string;
  epoch: number;
  fencingToken: string;
  expiresAt: string;
}

export interface CompareAndSwapRefInput {
  name: BrainRefName;
  expectedHead: BrainCommitId | null;
  nextHead: BrainCommitId;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  lease: LeaseProof;
}

export interface CommitAndAdvanceInput {
  payload: BrainCommitPayload;
  signatures: DetachedSignature[];
  targetRef: BrainRefName;
  expectedHead: BrainCommitId | null;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  lease: LeaseProof;
}

export interface BrainStatusInput {
  refName: BrainRefName;
  authorization?: MutationAuthorization;
}

export interface BrainStatus {
  schema: 'cosmo.brain-status.v1';
  refName: BrainRefName;
  headCommitId: BrainCommitId | null;
  settledCommitId: BrainCommitId | null;
  aheadOfSettled: number;
  verification: VerificationReport | null;
  unresolvedTransactionIds: Sha256[];
  degraded: boolean;
}

export interface BrainLogInput {
  fromCommitId: BrainCommitId;
  maxCommits: number;
  afterCommitId?: BrainCommitId;
  authorization?: MutationAuthorization;
}

export interface BrainLogPage {
  schema: 'cosmo.brain-log-page.v1';
  commits: BrainCommit[];
  nextAfterCommitId: BrainCommitId | null;
}

export type CurationEventPayload =
  | { kind: 'created' | 'locked' | 'forked' | 'merge_attempted' | 'merge_rejected'; rationale: string }
  | { kind: 'human_surprise' | 'judgment' | 'known_flaw'; noteObjectId: ObjectId }
  | { kind: 'frozen_hashes'; frozenObjectIds: ObjectId[] }
  | { kind: 'evaluation_result'; evaluationReceiptObjectId: ObjectId; outcome: 'pass' | 'fail' | 'inconclusive' }
  | { kind: 'design_material'; designMaterialObjectIds: ObjectId[] }
  | { kind: 'tagged' | 'settled' | 'woken'; refName: BrainRefName; rationale: string };

export interface CurationEventRecord {
  schema: 'cosmo.curation-event.v1';
  basedOnBrainCommitId: BrainCommitId | null;
  relatedCommitIds: BrainCommitId[];
  payload: CurationEventPayload;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  trust: TrustDescriptor;
  occurredAt: string;
  previousCurationEventId: ObjectId | null;
}

export interface CurationEvent {
  eventId: ObjectId;
  record: CurationEventRecord;
}

export interface HeritageSnapshot {
  schema: 'cosmo.intellectual-heritage.v1';
  parentHeritageRoots: ObjectRef[];
  curationEventIds: ObjectId[];
  createdAt: string;
}

export interface CurationLedger {
  append(input: Omit<
    CurationEventRecord,
    'schema' | 'previousCurationEventId'
  >): Promise<CurationEvent>;
  read(input: {
    basedOnBrainCommitId?: BrainCommitId | null;
    kinds?: CurationEventPayload['kind'][];
    authorization?: MutationAuthorization;
  }): AsyncIterable<CurationEvent>;
  createSnapshot(input: {
    parentHeritageRoots: ObjectRef[];
    curationEventIds: ObjectId[];
    trust: TrustDescriptor;
    authorization: MutationAuthorization;
  }): Promise<ObjectRef>;
  materialize(
    heritageRoot: ObjectRef,
    authorization?: MutationAuthorization
  ): Promise<{
    snapshot: HeritageSnapshot;
    events: CurationEvent[];
    trust: TrustDescriptor;
  }>;
  verify(): Promise<{ valid: boolean; eventCount: number; headEventId: ObjectId | null }>;
}

export interface TagBrainInput {
  tagRef: `refs/tags/${string}`;
  commitId: BrainCommitId;
  rationale: string;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  lease: LeaseProof;
}

export interface SettleBrainInput {
  branchRef: `refs/heads/${string}`;
  settledRef: `refs/settled/${string}`;
  expectedHead: BrainCommitId;
  rationale: string;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  lease: LeaseProof;
}

export interface SettleBrainReceipt {
  schema: 'cosmo.settle-brain-receipt.v1';
  branchRef: `refs/heads/${string}`;
  settledRef: `refs/settled/${string}`;
  settledCommitId: BrainCommitId;
  curationEventId: ObjectId;
  refUpdate: RefUpdateReceipt;
}

export interface WakeBrainInput {
  settledRef: `refs/settled/${string}`;
  wakeRef: `refs/heads/${string}`;
  expectedWakeHead: BrainCommitId | null;
  rationale: string;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  lease: LeaseProof;
}

export interface WakeBrainReceipt {
  schema: 'cosmo.wake-brain-receipt.v1';
  settledRef: `refs/settled/${string}`;
  wakeRef: `refs/heads/${string}`;
  wakeBrainCommitId: BrainCommitId;
  curationEventId: ObjectId;
  refUpdate: RefUpdateReceipt;
}

export type MergeableRootKind =
  | 'epistemicRoot'
  | 'questionRoot'
  | 'topologyRoot'
  | 'negativeKnowledgeRoot'
  | 'artifactIndexRoot';

export interface UnionRootLayerRef {
  sourceCommitId: BrainCommitId;
  root: ObjectRef;
}

export interface UnionRootPayload {
  schema: 'cosmo.union-root.v1';
  rootKind: MergeableRootKind;
  layers: UnionRootLayerRef[];
  unionMetadataObjectId: ObjectId;
}

export interface ResolveUnionRootLayersInput {
  rootKind: MergeableRootKind;
  sourceCommitId: BrainCommitId;
  root: ObjectRef;
  maxDepth: number;
  authorization?: MutationAuthorization;
}

export interface ResolvedUnionRootLayers {
  schema: 'cosmo.resolved-union-root-layers.v1';
  rootKind: MergeableRootKind;
  wrapperRoot: ObjectRef | null;
  leafLayers: UnionRootLayerRef[];
  reachableObjectIds: ObjectId[];
}

export interface RotateEncryptionKeyInput {
  trustDomain: string;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
}

export interface KeyRotationReceipt {
  schema: 'cosmo.key-rotation-receipt.v1';
  trustDomain: string;
  previousKeyId: Sha256;
  activeKeyId: Sha256;
  rewrappedPayloadCount: number;
  unchangedObjectIds: ObjectId[];
  completedAt: string;
}

export interface EraseEncryptionKeyInput {
  trustDomain: string;
  keyId: Sha256;
  authorizingTombstoneIds: ObjectId[];
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
}

export interface KeyErasureReceipt {
  schema: 'cosmo.key-erasure-receipt.v1';
  trustDomain: string;
  erasedKeyId: Sha256;
  inaccessiblePlaintextSha256: Sha256[];
  authorizingTombstoneIds: ObjectId[];
  completedAt: string;
}

export interface EncryptionAdministration {
  rotate(input: RotateEncryptionKeyInput): Promise<KeyRotationReceipt>;
  erase(input: EraseEncryptionKeyInput): Promise<KeyErasureReceipt>;
}
```

Also define strict schemas and types for:

- `CapabilityGrantPayload`, `CapabilityGrant`, and `GrantRevocation`;
- `AuthorizationRequest` and `AuthorizationDecision`;
- `AppendJournalInput`, `JournalVerification`;
- `AcquireLeaseInput`, `RefUpdateReceipt`, `CommitAdvanceReceipt`, and
  `CommitEventClosure`;
- `BrainDiff`, `ForkRequest`, `UnionRequest`, `UnionReceipt`,
  `UnionRootPayload`, and recursive union-resolution contracts;
- `BrainStatus`, `BrainLogPage`, `TagBrainInput`, `SettleBrainInput`,
  `WakeBrainInput`, `HeritageGenesisBuildInput`, `HeritageGenesisRoots`, and
  their receipts;
- `CurationEventPayload`, `CurationEventRecord`, decoded `CurationEvent`, `HeritageSnapshot`, and ledger verification/materialization;
- `EncryptedBlobEnvelope`, `BlobStorageIdentity`, key rotation, and key erasure inputs/receipts;
- `FederatedReadRequest`, `BrainSet`, and attributed federated object results;
- `ExportBundleInput`, `ExportReceipt`, `ImportBundleInput`, `ImportReceipt`;
- `RedactionTombstonePayload`, `RedactionTombstone`;
- `VerificationReport` with status `valid`, `valid_with_authorized_redactions`, or `corrupt_missing_object`;
- `RecoveryReport`;
- every `FaultPoint` listed in Task 12.

Freeze these operation shapes rather than leaving them to consuming programs:

```ts
export interface ForkRequest {
  parentCommitId: BrainCommitId;
  newRef: BrainRefName;
  purpose: string;
  covenantDifferenceObjectId: ObjectId | null;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  lease: LeaseProof;
}

export interface UnionRequest {
  targetRef: BrainRefName;
  expectedHead: BrainCommitId;
  targetParentCommitId: BrainCommitId;
  parentCommitIds: BrainCommitId[];
  mergeableRootKinds: Array<
    'epistemicRoot' |
    'questionRoot' |
    'topologyRoot' |
    'negativeKnowledgeRoot' |
    'artifactIndexRoot'
  >;
  targetTrustDomain: string | null;
  journalRange: JournalRange;
  idempotencyKey: Sha256;
  createdAt: string;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  lease: LeaseProof;
}

export interface UnionReceipt extends CommitAdvanceReceipt {
  unionOperationId: Sha256;
  eventScope: Extract<BrainEventScope, { kind: 'brain_lineage' }>;
}

export interface FederatedReadRequest {
  brainSetId: string;
  commitIds: BrainCommitId[];
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  allowPartial?: boolean;
}

export interface BrainDiff {
  schema: 'cosmo.brain-diff.v1';
  leftCommitId: BrainCommitId;
  rightCommitId: BrainCommitId;
  parentRelation: 'same' | 'left_is_ancestor' | 'right_is_ancestor' | 'diverged';
  changedRoots: Array<
    | 'epistemicRoot'
    | 'questionRoot'
    | 'programRoot'
    | 'relationshipRoot'
    | 'heritageRoot'
    | 'topologyRoot'
    | 'activationRoot'
    | 'negativeKnowledgeRoot'
    | 'artifactIndexRoot'
  >;
  addedObjectIds: ObjectId[];
  removedObjectIds: ObjectId[];
  sharedObjectIds: ObjectId[];
  addedCorpusSnapshotIds: CorpusSnapshotId[];
  removedCorpusSnapshotIds: CorpusSnapshotId[];
  addedJournalEventIds: EventId[];
  removedJournalEventIds: EventId[];
  principalVersionChanged: boolean;
  kernelVersionChanged: boolean;
  schemaVersionChanged: boolean;
}
```

Freeze every remaining cross-package repository contract in Task 1 rather than leaving a name for a later implementation to reinterpret:

```ts
export interface StoredObject {
  ref: ObjectRef;
  descriptor: StoredObjectDescriptor;
  bytes: Uint8Array;
  storage: BlobStorageIdentity;
}

export interface ObjectVerification {
  schema: 'cosmo.object-verification.v1';
  objectId: ObjectId;
  status:
    | 'valid'
    | 'descriptor_missing'
    | 'descriptor_hash_mismatch'
    | 'payload_missing'
    | 'payload_hash_mismatch'
    | 'ciphertext_hash_mismatch'
    | 'authentication_failed'
    | 'key_unavailable'
    | 'authorized_key_erasure';
  valid: boolean;
  payloadSha256: Sha256 | null;
  missingLinkedObjectIds: ObjectId[];
  authorizingTombstoneIds: ObjectId[];
}

export interface AppendJournalInput {
  eventId: EventId;
  eventType: string;
  payloadRef: ObjectRef;
  brainScope: BrainEventScope | null;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  idempotencyKey: string;
  occurredAt: string;
}

export interface JournalVerification {
  schema: 'cosmo.journal-verification.v1';
  valid: boolean;
  head: JournalCursor;
  recordCount: number;
  firstInvalidCursor: JournalCursor | null;
  reasonCodes: string[];
}

export interface AcquireLeaseInput {
  resource: string;
  ttlMs: number;
}

export interface RefUpdateReceipt {
  schema: 'cosmo.ref-update-receipt.v1';
  name: BrainRefName;
  previousHead: BrainCommitId | null;
  nextHead: BrainCommitId;
  updated: true;
  intentEventId: EventId;
  appliedEventId: EventId;
  leaseId: `lease_${string}`;
  leaseEpoch: number;
}

export interface CommitAdvanceReceipt {
  schema: 'cosmo.commit-advance-receipt.v1';
  transactionId: Sha256;
  commitId: BrainCommitId;
  targetRef: BrainRefName;
  previousHead: BrainCommitId | null;
  nextHead: BrainCommitId;
  journalRange: JournalRange;
  journalEventIds: EventId[];
  refUpdate: RefUpdateReceipt;
  outcome: 'committed' | 'already_committed';
}

export type RepositoryAction =
  | 'object:read'
  | 'object:put'
  | 'journal:append'
  | 'commit:create'
  | 'brain:genesis'
  | 'corpus:genesis'
  | 'research:genesis'
  | 'cognition:genesis'
  | 'ref:update'
  | 'branch:fork'
  | 'brain:union'
  | 'brain:federate'
  | 'brain:tag'
  | 'brain:settle'
  | 'brain:wake'
  | 'curation:read'
  | 'curation:append'
  | 'heritage:genesis'
  | 'bundle:export'
  | 'bundle:import'
  | 'encryption:key:rotate'
  | 'encryption:key:erase'
  | 'redaction:authorize';

export interface CapabilityGrantPayload {
  schema: 'cosmo.capability-grant.v1';
  subjectIdentity: Sha256;
  actions: RepositoryAction[];
  refPrefixes: BrainRefName[];
  objectIds: ObjectId[];
  trustDomains: string[];
  permittedUses: string[];
  sensitivityCeiling: TrustDescriptor['sensitivity'];
  issuedAt: string;
  expiresAt: string;
  issuingAuthorityObjectId: ObjectId;
  nonce: string;
}

export interface CapabilityGrant {
  grantId: ObjectId;
  payload: CapabilityGrantPayload;
  signatures: DetachedSignature[];
}

export interface GrantRevocationPayload {
  schema: 'cosmo.grant-revocation.v1';
  grantId: ObjectId;
  authorityIdentity: Sha256;
  reason: string;
  revokedAt: string;
  nonce: string;
}

export interface GrantRevocation {
  revocationId: ObjectId;
  payload: GrantRevocationPayload;
  signatures: DetachedSignature[];
}

export interface AuthorizationRequest {
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  action: RepositoryAction;
  refName: BrainRefName | null;
  objectIds: ObjectId[];
  trustDescriptors: TrustDescriptor[];
  requestedUse: string;
  now: string;
}

export interface AuthorizationDecision {
  schema: 'cosmo.authorization-decision.v1';
  allowed: boolean;
  reason:
    | 'allowed'
    | 'grant_missing'
    | 'grant_invalid'
    | 'grant_expired'
    | 'grant_revoked'
    | 'actor_mismatch'
    | 'action_not_granted'
    | 'ref_not_granted'
    | 'object_not_granted'
    | 'trust_domain_not_granted'
    | 'use_not_permitted'
    | 'sensitivity_exceeded'
    | 'license_mismatch'
    | 'retention_mismatch';
  grantId: ObjectId | null;
  evaluatedAt: string;
}

export interface AttributedBrainMember {
  commitId: BrainCommitId;
  payload: BrainCommitPayload;
  roots: {
    epistemicRoot: ObjectRef;
    questionRoot: ObjectRef;
    programRoot: ObjectRef;
    relationshipRoot: ObjectRef;
    heritageRoot: ObjectRef;
    topologyRoot: ObjectRef;
    activationRoot: ObjectRef;
    negativeKnowledgeRoot: ObjectRef;
    artifactIndexRoot: ObjectRef;
  };
  reachableObjectIds: ObjectId[];
}

export interface DeniedBrainSetMember {
  commitId: BrainCommitId;
  reason: 'not_found' | 'verification_failed' | 'read_not_authorized';
}

export interface BrainSet {
  schema: 'cosmo.brain-set.v1';
  brainSetId: string;
  commitIds: BrainCommitId[];
  members: AttributedBrainMember[];
  deniedMembers: DeniedBrainSetMember[];
  partial: boolean;
}

export interface ExportBundleInput {
  commitIds: BrainCommitId[];
  destination: string;
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
  redactionTombstoneIds: ObjectId[];
  recipientWrappingKeyIdsByTrustDomain: Record<string, Sha256>;
}

export interface ExportReceipt {
  schema: 'cosmo.export-receipt.v1';
  bundleId: Sha256;
  bundlePath: string;
  manifestSha256: Sha256;
  commitIds: BrainCommitId[];
  objectIds: ObjectId[];
  redactionTombstoneIds: ObjectId[];
  wrappedTrustDomains: string[];
  byteLength: number;
}

export interface ImportRefExposure {
  name: BrainRefName;
  expectedHead: BrainCommitId | null;
  nextHead: BrainCommitId;
  lease: LeaseProof;
}

export interface ImportBundleInput {
  bundlePath: string;
  exposeRefs: ImportRefExposure[];
  actorIdentity: Sha256;
  capabilityGrantId: ObjectId;
}

export interface ImportReceipt {
  schema: 'cosmo.import-receipt.v1';
  bundleId: Sha256;
  commitIds: BrainCommitId[];
  objectIds: ObjectId[];
  alreadyPresentCommitIds: BrainCommitId[];
  alreadyPresentObjectIds: ObjectId[];
  refUpdates: RefUpdateReceipt[];
  quarantineRemoved: boolean;
}

export interface RedactionTombstonePayload {
  schema: 'cosmo.redaction-tombstone.v1';
  objectId: ObjectId;
  objectMediaType: string;
  authorityIdentity: Sha256;
  reason: string;
  redactedAt: string;
  trustDomain: string | null;
  affectedCommitIds: BrainCommitId[];
  affectedDescendantObjectIds: ObjectId[];
  disposition: 'logical' | 'physical' | 'key_erasure';
}

export interface RedactionTombstone {
  tombstoneId: ObjectId;
  payload: RedactionTombstonePayload;
  signatures: DetachedSignature[];
}

export interface VerificationIssue {
  code:
    | 'missing_object'
    | 'invalid_object'
    | 'missing_commit'
    | 'invalid_commit'
    | 'invalid_signature'
    | 'invalid_tombstone'
    | 'unreachable_declared_object'
    | 'journal_range_invalid';
  objectId: ObjectId | null;
  message: string;
}

export interface VerificationReport {
  schema: 'cosmo.verification-report.v1';
  commitId: BrainCommitId;
  status:
    | 'valid'
    | 'valid_with_authorized_redactions'
    | 'corrupt_missing_object';
  verifiedObjectIds: ObjectId[];
  missingObjectIds: ObjectId[];
  corruptObjectIds: ObjectId[];
  authorizedRedactions: ObjectId[];
  invalidTombstoneIds: ObjectId[];
  issues: VerificationIssue[];
}

export interface RecoveryReport {
  schema: 'cosmo.recovery-report.v1';
  journalHeadAdvanced: number;
  completedTransactionIds: Sha256[];
  rolledBackTransactionIds: Sha256[];
  repairedRefNames: BrainRefName[];
  quarantinedPaths: string[];
  incompleteVisibleTransactions: number;
  partialCanonicalFiles: number;
  degraded: boolean;
  reasonCodes: string[];
}

export type FaultPoint =
  | 'after_blob_fsync'
  | 'before_blob_rename'
  | 'after_blob_rename'
  | 'after_ciphertext_fsync'
  | 'before_ciphertext_rename'
  | 'after_envelope_index_fsync'
  | 'before_envelope_index_rename'
  | 'after_key_rotation_prepare'
  | 'before_key_generation_rename'
  | 'after_descriptor_fsync'
  | 'before_descriptor_rename'
  | 'after_journal_record_fsync'
  | 'after_journal_record_rename'
  | 'before_journal_head'
  | 'after_commit_payload_fsync'
  | 'before_commit_payload_rename'
  | 'after_transaction_prepare'
  | 'after_ref_intent'
  | 'before_ref_rename'
  | 'after_ref_rename'
  | 'before_ref_applied'
  | 'after_curation_record_fsync'
  | 'before_curation_head'
  | 'after_import_quarantine'
  | 'during_import_admission'
  | 'before_tombstone_rename'
  | 'after_tombstone_rename';
```

Task 1 defines and exports a `.strict()` Zod schema with the same name plus `Schema` for every object above, and `FaultPointSchema`/`RepositoryActionSchema` for the closed unions. Arrays that represent identity sets are unique and lexicographically sorted; `AppendJournalInput` requires nonempty event type/idempotency key and an admitted payload ref; `AcquireLeaseInput` requires a nonempty normalized resource and integer `ttlMs` in `1..300_000`; lease expiry must be after acquisition and renewal may not exceed grant expiry. `RefUpdateReceipt` binds the exact lease epoch and distinct intent/applied events. `CommitAdvanceReceipt.nextHead` equals `commitId`, and its embedded ref update must bind the same ref/old/new heads.

`BrainDiff` identity arrays and changed roots are unique/sorted. `FederatedReadRequest.commitIds` and `BrainSet.commitIds` are exact sorted sets; each member appears once, `member.commitId === hashCanonical(member.payload)`, every `roots` field equals the matching payload field, and `partial` is true exactly when `deniedMembers` is nonempty and `allowPartial` was requested. Bundle inputs reject source/repository overlap and traversal, require every private/restricted export trust domain to have exactly one recipient wrapping key, and require each exposed import ref's `nextHead` to be among the admitted commits. Export/import receipts list complete sorted identity sets. Verification reports may use `valid_with_authorized_redactions` only when every missing object has a valid applicable tombstone and no other issue; unexplained absence is always `corrupt_missing_object`. Recovery reports count only reconciled on-disk facts and set `degraded` whenever any partial canonical file or unresolved reason remains.

The root contracts are equally closed. `BrainRootKindSchema` contains exactly the nine `BrainCommitPayload` root fields. `VerifyBrainRootInputSchema` is strict. Root leaf, closure, verification, materialization, and commit-verification schemas require matching `rootKind`, exact source commit/root attribution, unique lexicographically sorted `directReferencedObjectIds`, `reachableObjectIds`, `payloadSchemas`, and issue codes, and unique leaf layers sorted by `(sourceCommitId, root.objectId)`. A valid verification has no issues; an invalid verification has at least one. A materialization contains the same closure and leaf order as verification and may never collapse union leaves into an unattributed aggregate.

`BrainObjectAddressSchema` is the sole cross-program address for an object inside a possibly merged Brain. It is strict and always carries `{sourceCommitId, rootKind, rootObjectId, objectId}`. `CanonicalBrainObjectAddressListSchema` requires unique tuples sorted by those four fields. A consumer may accept a bare `ObjectId` only after materializing the relevant roots and proving exactly one matching address; ambiguity fails closed rather than selecting a layer.

`openBrainRepository` requires exactly one codec for every `BrainRootKind`, rejects duplicate/missing kinds and blank/duplicate `payloadSchema` values, copies and freezes the supplied array, and exposes no runtime registration method. Program C owns Epistemic/Negative Knowledge codecs, Program D owns Question/Program/Relationship/Artifact Index codecs, Program E owns Topology/Activation codecs, and Program B owns Heritage plus registry/union dispatch. This dependency inversion keeps `@cosmo/repository` independent of upper packages without permitting opaque commit roots.

On first repository initialization, Program B atomically stores
`repository/identity.json` with a versioned random public nonce and its
canonical SHA-256 identity. `BrainRepository.repositoryIdentity` exposes only
that `Sha256`. Reopen verifies the record and returns the same identity; it is
never derived from `rootDir`, a username, a machine identifier, or private
payload. A missing, changed, duplicate, or malformed identity record on a
nonempty repository fails closed. Program E uses this exact stable value for
the repository-global `genesis:<repositoryIdentity>` lease.

It also requires a nonempty startup-frozen `crossRootValidators` array with unique nonempty `validatorId` values. `BrainCrossRootValidationSchema` is strict, binds the candidate commit, requires sorted unique issue/object lists, and equates `valid` with an empty issue list. Program B never learns Corpus or cognition semantics; it supplies all nine already-verified materializations to each injected validator and refuses a commit if any validator fails, throws, returns the wrong candidate ID, or omits its declared ID.

`packages/repository/src/index.ts` re-exports these exact schema objects and inferred types from `@cosmo/contracts`; it never recreates a Zod object locally. Programs C–H import the same identities from `@cosmo/contracts` (or the identity-preserving repository re-export), and the Task 1 equality test is the executable guard against a second authority.

`BrainRefNameSchema` accepts only `refs/heads/`, `refs/tags/`, or `refs/settled/`, rejects empty components, `.`/`..`, repeated slash, backslash, NUL, and names ending in `.lock`.

- [ ] **Step 6: Create repository layout validation**

The only canonical paths are under the supplied repository root:

```text
repository/identity.json
blobs/public/sha256/
blobs/encrypted/<trust-domain-hash>/<key-id>/sha256/
blobs/envelope-index/<trust-domain-hash>/sha256/
objects/sha256/
journal/records/
journal/intents/
curation/records/
curation/head.json
commits/sha256/
refs/heads/
refs/tags/
refs/settled/
refs/last-known-good/
leases/
trust/identities/
trust/grants/
trust/revocations/
trust/encryption-key-metadata/
tombstones/
transactions/
quarantine/
```

`RepositoryLayout` maps hashes by stripping `sha256:`, taking the first two hex characters as directory, and using the remaining 62 as filename. Trust-domain directory names are SHA-256 hashes of the domain string, never raw domain names. It validates all ref names before joining paths and confirms the normalized result remains inside `rootDir`. `trust/encryption-key-metadata/` contains key IDs, states, and rotation receipts only; secret key bytes remain exclusively behind the injected `EncryptionKeyProvider`.

- [ ] **Step 7: Pass contract and build checks**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/contracts.test.ts
npm run build
```

Expected: all repository contracts parse, unsafe refs fail, and the workspace builds.

- [ ] **Step 8: Commit repository contracts**

```bash
git add packages/contracts packages/repository package-lock.json
git commit -m "feat: define brain repository contracts"
```

## Task 2: Implement Immutable Object Identity and Trust-Domain Blob Encryption

**Files:**
- Create: `packages/repository/src/object-store.ts`
- Create: `packages/repository/src/blob-envelope-store.ts`
- Create: `packages/repository/src/encryption-keyring.ts`
- Test: `packages/repository/test/object-store.test.ts`
- Test: `packages/repository/test/encryption-keyring.test.ts`

**Interfaces:**
- Consumes: canonical hashing, atomic files, `PutObjectInput`, `TrustDescriptor`, and injected `EncryptionKeyProvider`.
- Produces: internal `FileObjectStore`, `BlobEnvelopeStore`, `EncryptionAdministration`, and public authorized `ObjectStore`.

- [ ] **Step 1: Write failing plaintext/ciphertext identity and at-rest tests**

```ts
test('private payload identity stays plaintext-based while storage is ciphertext', async () => {
  const fixture = await makeEncryptionFixture();
  const bytes = Buffer.from('private phrase that must never appear at rest');
  const publicRef = await fixture.store.putUnchecked({
    mediaType: 'text/plain', bytes, links: [], trust: fixture.publicTrust
  });
  const privateRef = await fixture.store.putUnchecked({
    mediaType: 'text/plain', bytes, links: [], trust: fixture.privateTrust('research-jtr')
  });

  const publicStored = await fixture.store.getUnchecked(publicRef);
  const privateStored = await fixture.store.getUnchecked(privateRef);
  assert.notEqual(publicRef.objectId, privateRef.objectId);
  assert.equal(publicStored.descriptor.payloadSha256, privateStored.descriptor.payloadSha256);
  assert.equal(publicStored.storageIdentity.mode, 'plaintext');
  assert.equal(privateStored.storageIdentity.mode, 'encrypted');
  assert.equal(
    await directoryContainsBytes(fixture.layout.encryptedBlobRoot, bytes),
    false,
  );
});

test('equal private bytes in different trust domains never share ciphertext', async () => {
  const fixture = await makeEncryptionFixture();
  const left = await fixture.putPrivate('shared bytes', 'domain-left');
  const right = await fixture.putPrivate('shared bytes', 'domain-right');
  assert.equal(left.descriptor.payloadSha256, right.descriptor.payloadSha256);
  assert.notEqual(left.storageIdentity.keyId, right.storageIdentity.keyId);
  assert.notEqual(left.storageIdentity.ciphertextSha256, right.storageIdentity.ciphertextSha256);
});

test('key rotation preserves object and commit identity', async () => {
  const fixture = await makeEncryptionFixture();
  const before = await fixture.privateCommit('domain-a', 'rotating evidence');
  const rotation = await fixture.repo.encryption.rotate({
    trustDomain: 'domain-a',
    actorIdentity: fixture.owner.keyId,
    capabilityGrantId: fixture.rotationGrantId,
  });
  const after = await fixture.repo.objects.get(before.objectRef, fixture.readAuthorization);
  assert.equal(after.bytes.toString(), 'rotating evidence');
  assert.ok(rotation.unchangedObjectIds.includes(before.objectRef.objectId));
  assert.equal((await fixture.repo.refs.get('refs/heads/main')), before.commit.commitId);
  assert.notEqual(rotation.previousKeyId, rotation.activeKeyId);
});

test('key erasure requires a complete rewrap or signed tombstones', async () => {
  const fixture = await makeEncryptionFixture();
  const state = await fixture.privateCommit('domain-a', 'must survive');
  await assert.rejects(
    () => fixture.eraseKey(state.activeKeyId, []),
    { code: 'encryption_key_still_required' },
  );
});
```

- [ ] **Step 2: Run the focused tests and verify the storage boundary is absent**

Run:

```bash
npm exec -- node --import tsx --test \
  packages/repository/test/object-store.test.ts \
  packages/repository/test/encryption-keyring.test.ts
```

Expected: FAIL with missing object-store, envelope-store, and keyring modules.

- [ ] **Step 3: Implement immutable plaintext/object identity**

For every `PutObjectInput`:

1. hash caller bytes as the immutable `payloadSha256`;
2. normalize `TrustDescriptor.permittedUses`, links, and media type without weakening trust;
3. require every linked object to exist;
4. build `StoredObjectDescriptor` with no key ID, nonce, or ciphertext hash;
5. hash canonical descriptor bytes as immutable `objectId`;
6. publish the payload through Step 4's storage mode;
7. atomically publish canonical descriptor JSON under `objects/sha256`;
8. verify byte identity rather than overwrite any existing descriptor; and
9. return `{ objectId, mediaType, byteLength }`.

```ts
const descriptor: StoredObjectDescriptor = {
  schema: 'cosmo.stored-object.v1',
  mediaType: input.mediaType,
  byteLength: input.bytes.byteLength,
  payloadSha256: sha256(input.bytes),
  links: [...new Set(input.links)].sort(),
  trust: TrustDescriptorSchema.parse(input.trust),
};
const objectId = hashCanonical(descriptor as JsonValue);
```

This is the identity boundary: `payloadSha256` always names plaintext bytes; `ciphertextSha256` names one storage envelope only. Rotation, rewrap, or authorized key erasure never rewrites the descriptor or a commit that links it.

- [ ] **Step 4: Implement envelope storage, atomic reuse, and key separation**

`BlobEnvelopeStore.put()` uses exactly two modes:

- `sensitivity: public` and `encryptionDomain: null`: atomically store plaintext at `blobs/public/sha256/<payloadSha256>`;
- `sensitivity: private|restricted`: require a non-null `encryptionDomain`, obtain that domain's active 256-bit key, encrypt with AES-256-GCM and a fresh 96-bit random nonce, and store ciphertext under `blobs/encrypted/<domainHash>/<keyId>/sha256/<ciphertextSha256>`.

The active envelope index is keyed by `(trustDomain, payloadSha256)` and contains only `EncryptedBlobEnvelope`. Writers take the per-index filesystem lock, reuse an already verified envelope for the same active key, or publish ciphertext then atomically rename the canonical index. A losing race may leave only an unreachable verified ciphertext file for recovery cleanup. It may not repoint an object descriptor.

Key material never enters canonical JSON, logs, receipts, tests snapshots, `.brain` manifests, or `trust/encryption-key-metadata/`. `openBrainRepository()` accepts an `EncryptionKeyProvider`; opening without one is valid for public-only reads, but a private read/write fails `encryption_key_provider_required`.

`get()` resolves the descriptor's trust domain and plaintext hash to the active envelope, verifies `ciphertextSha256`, decrypts, then verifies GCM authentication, plaintext length, and `payloadSha256` before returning bytes. `verify()` distinguishes `ciphertext_hash_mismatch`, `authentication_failed`, `plaintext_hash_mismatch`, `key_unavailable`, and `authorized_key_erasure`.

- [ ] **Step 5: Implement crash-safe rotation and guarded erasure**

`EncryptionAdministration.rotate()` authorizes `encryption:key:rotate`, calls `createPrepared()` for a non-active domain key, decrypts every live domain payload with its old envelope, writes and verifies a new envelope, atomically advances the repository's domain-generation record only after all live payloads are rewrapped, then calls provider `activate()` as an idempotent mirror. The repository generation record—not mutable provider preference—is authoritative; reads request its exact key ID through `get()`. A crash leaves either the old generation active or a recoverable prepared/new generation. Recovery completes the mirror or removes unreachable ciphertext; it never mixes generations for a green receipt.

`erase()` authorizes `encryption:key:erase`. It may erase an inactive key only when every live descriptor has a verified envelope under a different active key. If erasure intentionally makes payloads unavailable, every affected object must be covered by a verified `key_erasure` tombstone and the receipt must list the exact plaintext hashes and tombstone IDs. Erasure without complete coverage fails closed.

- [ ] **Step 6: Add race, corruption, rotation-crash, and idempotence tests**

Prove:

- 20 concurrent identical public writes return one object ID and one plaintext blob;
- 20 concurrent identical private writes in one domain return one object ID and one active envelope;
- equal plaintext in different private domains has different key and ciphertext identities;
- scanning the repository never finds the private test phrase outside the in-memory test input;
- a missing linked object is rejected before payload publication;
- descriptor, ciphertext, authentication-tag, and decrypted-plaintext corruption are reported distinctly;
- crashes before/after envelope and generation-index renames reopen to the complete old or complete new key generation;
- re-putting identical input is idempotent; and
- failed writes leave at most unreachable verified storage, never a visible partial object.

Run:

```bash
npm exec -- node --import tsx --test \
  packages/repository/test/object-store.test.ts \
  packages/repository/test/encryption-keyring.test.ts
```

Expected: all identity, at-rest encryption, cross-domain isolation, rotation, erasure, race, and corruption tests pass.

- [ ] **Step 7: Commit object identity and envelope encryption**

```bash
git add packages/repository/src/object-store.ts \
  packages/repository/src/blob-envelope-store.ts \
  packages/repository/src/encryption-keyring.ts \
  packages/repository/test/object-store.test.ts \
  packages/repository/test/encryption-keyring.test.ts
git commit -m "feat: encrypt private brain objects by trust domain"
```

## Task 3: Enforce Signed Trust and Capability Grants

**Files:**
- Create: `packages/repository/src/signatures.ts`
- Create: `packages/repository/src/trust-kernel.ts`
- Test: `packages/repository/test/trust-kernel.test.ts`
- Modify: `packages/repository/test/encryption-keyring.test.ts`

**Interfaces:**
- Consumes: object descriptors and Ed25519 identities
- Produces:

```ts
export interface TrustKernel {
  bootstrap(input: BootstrapTrustInput): Promise<CapabilityGrant>;
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
  installGrant(grant: CapabilityGrant): Promise<void>;
  revoke(revocation: GrantRevocation): Promise<void>;
  intersect(descriptors: TrustDescriptor[], use: string): AuthorizationDecision;
}
```

- [ ] **Step 1: Write grant, expiry, revocation, and anti-broadening tests**

```ts
test('allows only signed action, scope, use, and trust domain', async () => {
  const fixture = await makeTrustFixture();
  const decision = await fixture.kernel.authorize({
    actorIdentity: fixture.worker.keyId,
    capabilityGrantId: fixture.grant.grantId,
    action: 'object:put',
    refName: null,
    objectIds: [],
    trustDescriptors: [privateTrust],
    requestedUse: 'research',
    now: fixture.clock.now()
  });
  assert.equal(decision.allowed, true);

  const denied = await fixture.kernel.authorize({
    ...fixture.request,
    action: 'redaction:authorize'
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, 'action_not_granted');
});

test('expired, revoked, forged, and cross-domain grants fail', async () => {
  const fixture = await makeTrustFixture();
  await fixture.kernel.revoke(fixture.signedRevocation);
  assert.equal((await fixture.kernel.authorize(fixture.request)).reason, 'grant_revoked');
  await assert.rejects(() => fixture.kernel.installGrant(fixture.forgedGrant), /signature/);
});

test('key administration is scoped to the exact trust domain', async () => {
  const fixture = await makeEncryptionFixture();
  await assert.rejects(() => fixture.repo.encryption.rotate({
    trustDomain: 'other-domain',
    actorIdentity: fixture.owner.keyId,
    capabilityGrantId: fixture.domainARotationGrantId,
  }), { code: 'trust_domain_not_granted' });
});

test('trust bootstrap is explicit and cannot replace an established owner', async () => {
  const fixture = await makeEmptyTrustFixture();
  const installed = await fixture.kernel.bootstrap({
    ownerPublicKeyDer: fixture.owner.publicKeyDer,
    rootGrant: fixture.ownerRootGrant
  });
  assert.equal(installed.grantId, fixture.ownerRootGrant.grantId);
  await assert.rejects(() => fixture.kernel.bootstrap({
    ownerPublicKeyDer: fixture.otherOwner.publicKeyDer,
    rootGrant: fixture.otherOwnerRootGrant
  }), /TRUST_ALREADY_BOOTSTRAPPED/);
});
```

- [ ] **Step 2: Run the test to verify trust code is absent**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/trust-kernel.test.ts
```

Expected: FAIL with missing trust-kernel exports.

- [ ] **Step 3: Implement canonical Ed25519 identities and signatures**

`keyId` is the SHA-256 of DER-encoded SPKI public-key bytes. Signatures cover canonical payload bytes prefixed with the domain string and NUL:

```ts
export function signatureMessage(domain: string, payload: JsonValue): Uint8Array {
  return Buffer.concat([
    Buffer.from(domain, 'utf8'),
    Buffer.from([0]),
    Buffer.from(canonicalBytes(payload))
  ]);
}
```

Use domains:

- `cosmo.capability-grant.v1`
- `cosmo.grant-revocation.v1`
- `cosmo.brain-commit-signature.v1`
- `cosmo.redaction-tombstone.v1`
- `cosmo.curation-event.v1`

Never sign a serialization containing its own signature.

- [ ] **Step 4: Implement capability and rights decisions**

`CapabilityGrantPayload` pins:

- subject key identity;
- allowed actions;
- exact ref prefixes;
- exact object IDs or wildcard-free trust domains;
- permitted uses;
- sensitivity ceiling;
- issue and expiry time;
- issuing Covenant or owner authority object;
- nonce.

The closed action set includes `encryption:key:rotate`, `encryption:key:erase`, `brain:tag`, `brain:settle`, `brain:wake`, and `curation:append`. Each encryption action requires one exact non-wildcard trust domain; each ref action requires the exact destination ref prefix.

`grantId` hashes the unsigned grant payload. `installGrant` verifies at least one trusted issuer signature and writes the immutable grant. Revocation is a separately signed immutable record; it never mutates the grant.

`intersect()` denies when any descriptor:

- lacks the requested permitted use;
- has a different non-null encryption domain;
- is non-exportable for export;
- has incompatible license terms;
- exceeds the grant sensitivity ceiling.

For the first build, licenses and retention rules must be byte-identical across a materialized union or export; no compatibility is inferred from license names. Encryption domains must either all be the same non-null value or all be null. Sensitivity uses the strict order `public < private < restricted`, exportability is logical AND, and permitted uses are the exact set intersection. An empty permitted-use intersection denies the operation. It never chooses the most permissive parent.

Bootstrap is explicit and one-time:

```ts
export interface BootstrapTrustInput {
  ownerPublicKeyDer: Uint8Array;
  rootGrant: CapabilityGrant;
}
```

`bootstrap()` succeeds only when `trust/identities`, `trust/grants`, refs, commits, and journal are all empty. The supplied root grant must be self-signed by `ownerPublicKeyDer`, its subject must equal the derived owner key ID, and its action/scope list is preserved exactly. Reopening a non-empty repository with a different owner fails `TRUST_ALREADY_BOOTSTRAPPED`; no runtime generates or replaces an owner key implicitly.

- [ ] **Step 5: Wrap public object writes with authorization**

`repository.objects.put(input, authorization)` builds an `AuthorizationRequest` for `object:put`, requires `decision.allowed`, verifies that private/restricted material has the exact granted `encryptionDomain`, then calls the unexported `putUnchecked`. `get(ref)` without authorization returns payload bytes only for `sensitivity: public`; private or restricted descriptors require an `object:read` grant through `get(ref, authorization)` before any key-provider call. `has()` and `verify()` expose integrity metadata but never payload bytes. Programs outside `@cosmo/repository` cannot import unchecked reads, writes, or key material.

Run:

```bash
npm exec -- node --import tsx --test \
  packages/repository/test/trust-kernel.test.ts \
  packages/repository/test/object-store.test.ts \
  packages/repository/test/encryption-keyring.test.ts
```

Expected: authorization, expiry, revocation, signature, rights-intersection, and object-write tests pass.

- [ ] **Step 6: Commit the trust kernel**

```bash
git add packages/repository/src/signatures.ts packages/repository/src/trust-kernel.ts \
  packages/repository/src/object-store.ts packages/repository/src/encryption-keyring.ts \
  packages/repository/test
git commit -m "feat: enforce brain trust grants"
```

## Task 4: Build the Admitted Append-Only Journal

**Files:**
- Create: `packages/repository/src/journal-store.ts`
- Test: `packages/repository/test/journal-store.test.ts`

**Interfaces:**
- Consumes: authorized payload `ObjectRef`
- Produces: `JournalStore`

- [ ] **Step 1: Write ordering, idempotency, and crash tests**

```ts
test('appends a contiguous hash chain and replays an exact range', async () => {
  const repo = await makeAuthorizedRepository();
  const one = await repo.journal.append(await eventInput(repo, 'evt_one', 'candidate.created', 'one'));
  const scope = brainLineageScopeFixture();
  const two = await repo.journal.append(await eventInput(
    repo,
    'evt_two',
    'candidate.reviewed',
    'two',
    { brainScope: scope },
  ));
  assert.equal(one.cursor, '1');
  assert.equal(two.cursor, '2');
  assert.equal(two.previousRecordHash, one.recordHash);
  assert.equal(one.brainScope, null);
  assert.deepEqual(two.brainScope, scope);
  assert.deepEqual(await collect(repo.journal.read({
    fromExclusive: '0',
    throughInclusive: '2'
  })), [one, two]);
});

test('same idempotency key returns the same record and conflicting bytes fail', async () => {
  const repo = await makeAuthorizedRepository();
  const input = await eventInput(repo, 'evt_one', 'candidate.created', 'one');
  assert.deepEqual(await repo.journal.append(input), await repo.journal.append(input));
  await assert.rejects(() => repo.journal.append({
    ...input,
    eventType: 'candidate.changed'
  }), /IDEMPOTENCY_CONFLICT/);
});

test('EventId resolves globally to exactly one immutable journal record', async () => {
  const repo = await makeAuthorizedRepository();
  const input = await eventInput(
    repo,
    'evt_globally_unique',
    'candidate.created',
    'one',
  );
  const first = await repo.journal.append(input);
  assert.deepEqual(await repo.journal.append(input), first);
  await assert.rejects(
    () => repo.journal.append({
      ...input,
      idempotencyKey: 'another-delivery-key',
    }),
    { code: 'JOURNAL_EVENT_ID_CONFLICT' },
  );
  assert.equal(await repo.journal.head(), '1');
  const reopened = await reopenWithoutFault(repo);
  await assert.rejects(
    () => reopened.journal.append({
      ...input,
      idempotencyKey: 'conflict-after-reopen',
    }),
    { code: 'JOURNAL_EVENT_ID_CONFLICT' },
  );
});

test('recovers a record written before head update', async () => {
  const repo = await makeAuthorizedRepository({ faultAt: 'after_journal_record_rename' });
  await assert.rejects(() => repo.journal.append(await eventInput(repo, 'evt_one', 'x', 'one')));
  const reopened = await reopenWithoutFault(repo);
  const report = await reopened.reconcile();
  assert.equal(report.journalHeadAdvanced, 1);
  assert.equal(await reopened.journal.head(), '1');
});

test('brain scope is hash-bound and tampering is detected', async () => {
  const repo = await makeAuthorizedRepository();
  const scope = brainLineageScopeFixture();
  const record = await repo.journal.append(await eventInput(
    repo,
    'evt_scoped',
    'candidate.reviewed',
    'scoped',
    { brainScope: scope },
  ));
  await repo.testOnlyTamperJournalRecord(record.cursor, {
    brainScope: {
      ...scope,
      targetRef: 'refs/heads/other',
    },
  });
  const verification = await repo.journal.verify();
  assert.equal(verification.valid, false);
  assert.equal(verification.firstInvalidCursor, record.cursor);
  assert.equal(verification.reasonCodes.includes(
    'journal_record_hash_mismatch',
  ), true);
});
```

- [ ] **Step 2: Run the test to verify journal code is absent**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/journal-store.test.ts
```

Expected: FAIL with a missing journal-store module.

- [ ] **Step 3: Implement one immutable record per cursor**

Use zero-padded 20-digit filenames under `journal/records`. Append:

1. authorize `journal:append`;
2. acquire the internal journal append lock with atomic `mkdir`;
3. recover stale lock only after its owner/expiry record is verifiably stale;
4. check the idempotency index;
5. check the durable global EventId index; an exact canonical replay returns
   its one record, while any different append reusing that EventId fails
   `JOURNAL_EVENT_ID_CONFLICT` before a write;
6. read and verify current head and previous record;
7. allocate next numeric cursor;
8. copy the parsed `brainScope` byte-for-byte into the record and build the
   record without `recordHash`;
9. set `recordHash = hashCanonical(recordWithoutHash)`;
10. atomically write the record;
11. atomically update head;
12. atomically update both idempotency and EventId indexes;
13. release the lock.

`brainScope` is a first-class hash-bound record field, including literal
`null`; it is never recovered from the payload or an index. `read()`,
idempotent replay, export/import, and recovery return it unchanged, while
`verify()` includes it in the canonical record hash. The EventId index stores
exactly `(eventId, cursor, recordHash, canonicalAppendHash)` and is rebuilt only
from a fully verified contiguous journal; duplicate EventIds or index drift are
corruption. On startup, contiguous verified records ahead of head advance head
and repair both indexes. A gap, duplicate cursor or EventId with different
bytes, broken previous hash, scope tamper, or missing payload object enters
degraded read-only mode.

- [ ] **Step 4: Add malformed, unauthorized, duplicate-delivery, and gap tests**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/journal-store.test.ts
```

Expected: all journal tests pass; unauthorized append creates no record; gap/corruption reports degraded mode.

- [ ] **Step 5: Commit the journal**

```bash
git add packages/repository/src/journal-store.ts packages/repository/test/journal-store.test.ts
git commit -m "feat: add admitted brain journal"
```

## Task 5: Add Epoch Leases and Compare-and-Swap Refs

**Files:**
- Create: `packages/repository/src/lease-store.ts`
- Create: `packages/repository/src/ref-store.ts`
- Test: `packages/repository/test/refs-leases.test.ts`

**Interfaces:**
- Consumes: grants, commits, journal
- Produces: `LeaseStore`, `RefStore`

- [ ] **Step 1: Write stale-fence and concurrent-CAS tests**

```ts
test('a reacquired lease fences the old writer', async () => {
  const repo = await makeAuthorizedRepository();
  const oldLease = await repo.leases.acquire(leaseInput('refs/heads/main', 1000));
  repo.clock.advance(1001);
  const newLease = await repo.leases.acquire(leaseInput('refs/heads/main', 1000));
  assert.equal(newLease.epoch, oldLease.epoch + 1);
  await assert.rejects(() => repo.refs.compareAndSwap(refUpdate(oldLease)), /STALE_FENCE/);
  assert.equal((await repo.refs.compareAndSwap(refUpdate(newLease))).updated, true);
});

test('exactly one concurrent ref writer wins', async () => {
  const fixture = await makeConcurrentRefFixture();
  const results = await Promise.allSettled([
    fixture.updateFromProcess('candidate-a'),
    fixture.updateFromProcess('candidate-b')
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.ok([fixture.a, fixture.b].includes(await fixture.repo.refs.get('refs/heads/main')));
});
```

- [ ] **Step 2: Run the test to verify lease/ref code is absent**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/refs-leases.test.ts
```

Expected: FAIL with missing lease/ref modules.

- [ ] **Step 3: Implement monotonic lease epochs and fencing**

Each resource has an immutable epoch counter plus one atomic live-lease record. Acquire requires no unexpired live lease, increments epoch, generates a cryptographically random fencing token, and writes expiry using the injected clock. Renew preserves epoch/token and can only shorten or extend within grant expiry. Release records release but never decrements epoch.

`validateLease()` requires exact resource, epoch, token, and unexpired time. An expired or released lease is invalid even if its token matches disk history.

- [ ] **Step 4: Implement ref CAS with append-before-act intent**

`compareAndSwap`:

1. authorizes `ref:update` for the exact ref;
2. verifies the target commit exists and is valid;
3. verifies lease resource, epoch, token, and expiry;
4. acquires a short internal ref lock;
5. compares current head with `expectedHead`;
6. appends a `ref.update.intent` journal record;
7. atomically writes the ref record `{commitId, epoch, updateEventId}`;
8. appends `ref.update.applied`;
9. updates last-known-good only after commit verification;
10. releases the internal lock.

The intent and applied records use immutable payload objects written through the authorized object path. Before the intent append, ref update verifies the commit has the signature threshold required by the target ref's trust policy. If expected head differs, it throws `REF_CONFLICT` and writes no intent. Ref files never contain paths, branch names, or mutable object data as identity.

- [ ] **Step 5: Pass lease/ref and crash-point tests**

Add injected failures before intent, after intent, before ref rename, after ref rename, and before applied receipt. Reopening and `reconcile()` must yield either the old ref or the complete new ref with a completed audit trail; never an invalid value.

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/refs-leases.test.ts
```

Expected: stale-fence, exact-one-winner, CAS conflict, and every crash-point test pass.

- [ ] **Step 6: Commit leases and refs**

```bash
git add packages/repository/src/lease-store.ts packages/repository/src/ref-store.ts packages/repository/test/refs-leases.test.ts
git commit -m "feat: fence atomic brain refs"
```

## Task 6: Create Immutable Brain Commits and Atomic Advancement

**Files:**
- Create: `packages/repository/src/commit-store.ts`
- Create: `packages/repository/src/root-registry.ts`
- Create: `packages/repository/src/heritage-root-codec.ts`
- Create: `packages/repository/src/heritage-genesis-builder.ts`
- Create: `packages/repository/src/schema-registry.ts`
- Create: `packages/repository/src/transaction-coordinator.ts`
- Create: `packages/repository/src/recovery.ts`
- Create: `packages/repository/src/brain-repository.ts`
- Modify: `packages/repository/src/index.ts`
- Test: `packages/repository/test/commit-store.test.ts`
- Test: `packages/repository/test/commit-advance.test.ts`
- Test: `packages/repository/test/root-registry.test.ts`
- Test: `packages/repository/test/heritage-root-codec.test.ts`
- Test: `packages/repository/test/heritage-genesis-builder.test.ts`

**Interfaces:**
- Consumes: objects, journal, leases, refs, trust
- Produces: `CommitStore`, startup-frozen `BrainRootRegistry`, concrete
  `HeritageRootCodec`, dedicated `HeritageGenesisBuilder`,
  `commitAndAdvance()`, `reconcile()`

- [ ] **Step 1: Write commit hashing and signature-independence tests**

```ts
test('commit ID hashes canonical payload and excludes signatures', async () => {
  const repo = await makeAuthorizedRepository();
  const payload = await completeCommitPayload(repo);
  const unsigned = await repo.commits.create(payload, undefined, repo.testAuthorization);
  const signed = await repo.commits.create(
    payload,
    [await repo.testSigner.signCommit(payload)],
    repo.testAuthorization
  );
  assert.equal(unsigned.commitId, signed.commitId);
  assert.equal(signed.commitId, hashCanonical(payload as JsonValue));
  assert.equal(signed.signatures.length, 1);
});

test('rejects a commit with missing roots, missing parents, or future journal range', async () => {
  const repo = await makeAuthorizedRepository();
  const payload = await completeCommitPayload(repo);
  await assert.rejects(() => repo.commits.create({
    ...payload,
    epistemicRoot: missingRef
  }, undefined, repo.testAuthorization), /MISSING_OBJECT/);
  await assert.rejects(() => repo.commits.create({
    ...payload,
    journalRange: { fromExclusive: '0', throughInclusive: '99' }
  }, undefined, repo.testAuthorization), /JOURNAL_RANGE_UNAVAILABLE/);
});

test('commit creation rejects a schema-invalid typed root even when every object exists', async () => {
  const repo = await makeAuthorizedRepository();
  const payload = await completeCommitPayload(repo);
  const wrongKind = await repo.objects.put(jsonObject({
    schema: 'fixture.question-root.v1',
    entries: [],
  }), repo.testAuthorization);
  await assert.rejects(() => repo.commits.create({
    ...payload,
    epistemicRoot: wrongKind,
  }, undefined, repo.testAuthorization), {
    code: 'BRAIN_ROOT_INVALID',
    rootKind: 'epistemicRoot',
  });
});

test('typed roots cannot embed their enclosing or not-yet-created child commit ID', async () => {
  const repo = await makeAuthorizedRepository();
  const payload = await completeCommitPayload(repo);
  const cyclicLeaf = await repo.objects.put(jsonObject({
    ...await fixtureEpistemicRootPayload(repo),
    childBrainCommitId: hashCanonical(payload as JsonValue),
  }), repo.testAuthorization);
  await assert.rejects(() => repo.commits.create({
    ...payload,
    epistemicRoot: cyclicLeaf,
  }, undefined, repo.testAuthorization), {
    code: 'BRAIN_ROOT_INVALID',
    issueCode: 'payload_schema_mismatch',
  });
});

test('commit creation and verification both fail a mechanical cross-root mismatch', async () => {
  const repo = await makeAuthorizedRepository({
    crossRootFault: 'corpus_snapshot_mismatch',
  });
  const payload = await completeCommitPayload(repo);
  await assert.rejects(
    () => repo.commits.create(payload, undefined, repo.testAuthorization),
    { code: 'BRAIN_CROSS_ROOT_INVALID' },
  );
  const malformed = await repo.installUncheckedCommitForTest(payload);
  assert.equal((await repo.roots.verifyCommit(malformed.commitId)).valid, false);
  assert.equal((await repo.verify(malformed.commitId)).status,
    'corrupt_missing_object');
});

test('interleaved global events belong only to the branch that selects them', async () => {
  const fixture = await makeInterleavedBranchJournalFixture();
  const [left, right] = await Promise.all([
    fixture.commitLeftSelecting(['evt_left_1', 'evt_left_2']),
    fixture.commitRightSelecting(['evt_right_1', 'evt_right_2']),
  ]);
  assert.deepEqual(left.payload.journalEventIds,
    ['evt_left_1', 'evt_left_2']);
  assert.deepEqual(right.payload.journalEventIds,
    ['evt_right_1', 'evt_right_2']);
  assert.deepEqual(
    (await fixture.repo.commits.eventClosure(left.commitId))
      .allJournalEventIds,
    ['evt_left_1', 'evt_left_2'],
  );
  assert.deepEqual(
    (await fixture.repo.commits.eventClosure(right.commitId))
      .allJournalEventIds,
    ['evt_right_1', 'evt_right_2'],
  );
  assert.equal(
    fixture.rangeContainsCursor(
      left.payload.journalRange,
      fixture.cursorOf('evt_right_1'),
    ),
    true,
    'range may span an unrelated event without admitting it',
  );
});

test('direct event IDs must resolve once, inside the bound, in journal order', async () => {
  const fixture = await makeInterleavedBranchJournalFixture();
  for (const journalEventIds of [
    ['evt_left_2', 'evt_left_1'],
    ['evt_left_1', 'evt_left_1'],
    ['evt_missing'],
    ['evt_after_declared_high_water'],
  ]) {
    await assert.rejects(
      () => fixture.commitLeftSelecting(journalEventIds),
      { code: 'BRAIN_COMMIT_EVENT_MEMBERSHIP_INVALID' },
    );
  }
});

test('candidate review may publish a descendant on the canonical ref', async () => {
  const fixture = await makeCandidatePromotionScopeFixture();
  const candidate = await fixture.commitCandidate();
  const accepted = await fixture.commitAcceptedDescendant({
    parentCommitId: candidate.commitId,
    targetRef: fixture.canonicalRef,
    expectedHead: fixture.canonicalBaseCommitId,
    directEventScope: {
      kind: 'brain_lineage',
      basedOnBrainCommitId: candidate.commitId,
      targetRef: fixture.canonicalRef,
      programId: fixture.programId,
      lineageId: fixture.lineageId,
      trustDomain: fixture.trustDomain,
    },
  });
  assert.deepEqual(accepted.payload.parentCommitIds, [candidate.commitId]);
  assert.equal(await fixture.repo.refs.get(fixture.canonicalRef),
    accepted.commitId);
  assert.deepEqual(
    (await fixture.repo.commits.eventClosure(accepted.commitId))
      .directJournalEventIds,
    fixture.reviewDecisionAndAcceptanceEventIds,
  );
});

test('the Heritage genesis builder is empty, dedicated, and replay-safe', async () => {
  const fixture = await makeHeritageGenesisFixture();
  const first = await fixture.builder.build(fixture.input);
  const replay = await fixture.builder.build(fixture.input);
  assert.deepEqual(replay, first);
  assert.deepEqual(first.heritage.parentHeritageRoots, []);
  assert.deepEqual(first.heritage.curationEventIds,
    [first.createdCurationEventId]);
  assert.equal(fixture.generalCreateSnapshotCalls, 0);
  assert.equal(fixture.commitAndAdvanceCalls, 0);
  assert.equal(fixture.createdCurationEvents, 1);
  assert.equal(first.heritageRootRef.objectId,
    fixture.storedHeritageRootRef.objectId);
});
```

- [ ] **Step 2: Run tests to verify commit code is absent**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/root-registry.test.ts packages/repository/test/heritage-root-codec.test.ts packages/repository/test/heritage-genesis-builder.test.ts packages/repository/test/commit-store.test.ts packages/repository/test/commit-advance.test.ts
```

Expected: FAIL with missing root-registry and commit modules.

- [ ] **Step 3: Implement immutable commits**

Before `create()`, implement `root-registry.ts`. Construction receives the exact nine `BrainRootCodec` values, rejects missing/duplicate kinds or payload schemas, copies and freezes them, and has no registration method. For a leaf root it:

1. verifies and reads the root through Program B;
2. dispatches only to the codec whose `rootKind` matches the commit field;
3. requires the codec's `payloadSchema`, `rootKind`, source commit, and root to match;
4. requires the leaf descriptor's sorted `links` to equal the codec's sorted `directReferencedObjectIds`;
5. recursively closes every descriptor link, verifies every object, rejects cycles that are not an explicit `cosmo.union-root.v1`, and returns a sorted complete closure; and
6. re-runs the same verification immediately before returning a materialization, so materialization cannot bypass verification.

For a mergeable root, the registry recognizes the Program B-owned strict `UnionRootPayloadSchema`, verifies `rootKind`, recursively expands its sorted attributed layers, rejects wrapper/commit cycles and depth above `128`, and dispatches every leaf to the owner codec. Non-mergeable union wrappers fail with `union_not_permitted`. `materialize()` returns attributed leaf snapshots and never invents a semantic merge. `verifyCommit()` runs all nine roots against their exact commit-field kinds, unions the sorted closures, and fails if any typed or generic check fails.

`heritage-root-codec.ts` exports the concrete `heritageRootCodec: BrainRootCodec<HeritageSnapshot>`. It accepts only `rootKind: 'heritageRoot'` and `cosmo.intellectual-heritage.v1`, verifies every parent heritage root and curation event recursively, requires the root descriptor links to equal the exact sorted parent-root/event object IDs, and materializes the complete attributed snapshot. It rejects `brainCommitId`, `childCommitId`, and `enclosingCommitId` in the strict leaf; each included event may name only `basedOnBrainCommitId: null` for genesis preparation or an already-existing parent/older commit. Add `heritage-root-codec.test.ts` proving valid recursive closure, missing event rejection, and child-commit-cycle rejection.

`heritage-genesis-builder.ts` is the only parentless Heritage construction
path. `build()` parses `HeritageGenesisBuildInput`, authorizes the dedicated
`heritage:genesis` action, appends exactly one `created` curation event with
`basedOnBrainCommitId: null`, then stores an exact
`HeritageSnapshot {parentHeritageRoots: [], curationEventIds: [eventId],
createdAt: requestedAt}` whose descriptor links only that event. It persists an
intent keyed by `idempotencyKey` before either write, recovers a partial
attempt, and returns the byte-identical `HeritageGenesisRoots` on replay.
Conflicting input under the same key fails. It does not call general
`CurationLedger.createSnapshot()`, create a Brain commit, or advance a ref.
Normal code cannot request an empty parent array from the general snapshot API;
that form is reserved to this builder.

After all nine root materializations pass, hash the complete payload to obtain the candidate commit ID and invoke every startup-frozen `BrainCrossRootValidator` with that ID, payload, and exact materializations. `CommitStore.create`, `commitAndAdvance`, `CommitStore.verify`, repository `verify`, import admission, and recovery last-known-good selection all call this same gate; no direct create/import path may bypass it.

`create()` first authorizes `commit:create`, then:

- validates schema;
- verifies every root object, every typed root schema/closure through `BrainRootRegistry`, every cross-root invariant, and every parent commit;
- verifies the journal range exists and is contiguous;
- resolves every `journalEventIds` member to exactly one admitted record,
  requires its cursor to lie inside `journalRange`, and requires the IDs to be
  unique and in ascending journal-cursor order;
- requires every selected record to carry a non-null strict
  `BrainEventScope`; genesis direct events share one exact genesis scope,
  while normal direct events share one exact `brain_lineage` scope whose
  `basedOnBrainCommitId` is a declared parent; repository-internal events with
  `brainScope: null` can never be selected;
- rejects a direct event already inherited from any parent, then derives
  `CommitEventClosure` as the cursor-ordered union of every parent closure plus
  the direct IDs and its canonical distinct scope set; it never scans or adopts
  unrelated global records merely because their cursors are inside
  `journalRange`;
- verifies each corpus snapshot ID is syntactically valid without pretending Program B owns corpus semantics;
- computes `commitId` from canonical payload only;
- atomically writes `payload.json`;
- stores detached signatures by key ID after verification;
- returns all currently verified signatures;
- never changes payload bytes for an existing ID.

Genesis has no parents, requires `journalRange` `0` through current admitted
head, and names only its explicit genesis events in `journalEventIds`.
Non-genesis commits require at least one parent. `CommitStore.eventClosure()`
recomputes and verifies this ancestry-based membership before returning it.
An identical payload is idempotent.

`commitAndAdvance()` additionally binds scope to publication. Every direct
genesis event has `targetRef === input.targetRef`. Every normal direct event
shares one byte-identical `BrainLineageEventScope`; its `targetRef` equals the
CAS target, its `basedOnBrainCommitId` is a declared parent, and its
lineage/trust fields agree with the verified parent lineage. This rule supports
both candidate admission (`parent = canonical base`, `target = candidate ref`)
and reviewed canonical publication (`parent = candidate commit`,
`target = canonical ref`, `expectedHead = candidate's verified sole parent`).
The latter is accepted only when the payload's sole parent is that candidate,
the candidate's sole parent is the expected canonical head, and every selected
review/decision/acceptance event uses the same canonical-target scope based on
the candidate. It cannot be used to jump from an unrelated parent or publish
events scoped to another ref.

A parentless payload requires `expectedHead: null`, an absent target ref, the
dedicated `brain:genesis` authority, and a prepared genesis intent. A generic
direct `CommitStore.create()` cannot bypass these genesis conditions.

`inspectGenesisEligibility()` is a fail-closed, read-only one-time check. It
returns the strict literal-zero receipt only when the target is absent, the
verified commit inventory is empty, no refs exist, and no journal record with a
non-null `brainScope` exists; otherwise it throws
`GENESIS_REPOSITORY_NOT_EMPTY` with counts but no private payload. The
parentless path repeats that zero-state check under the repository-global
genesis lease and target lease immediately before preparing the intent. Owner
builders may then append the intent-bound genesis events. Immediately before
the one CAS, the final eligibility check still requires zero commits and refs,
but requires the complete set of non-null scoped journal records to equal
`payload.journalEventIds` exactly, in cursor order. Every one must carry the
same `GenesisBrainEventScope`, target the prepared branch, bind the prepared
lineage/trust domain, and belong to that exact intent; an omitted, extra, or
foreign scoped event fails closed. The final check does not incorrectly demand
zero scoped events after the builders have produced the required genesis
events. Ordinary repository setup/grant events with `brainScope:null` do not
falsely make a fresh repository semantically nonempty.

- [ ] **Step 4: Implement `commitAndAdvance` as a recoverable transaction**

```ts
export async function commitAndAdvance(input: CommitAndAdvanceInput) {
  await requireAuthorized(input, ['commit:create', 'ref:update']);
  await leases.validate(input.lease, input.targetRef);
  const transactionId = hashCanonical({
    schema: 'cosmo.commit-advance-intent.v1',
    payloadHash: hashCanonical(input.payload as JsonValue),
    targetRef: input.targetRef,
    expectedHead: input.expectedHead,
    leaseEpoch: input.lease.epoch,
    fencingToken: input.lease.fencingToken
  });
  await transactions.prepare(transactionId, input);
  const commit = await commits.create(input.payload, input.signatures, {
    actorIdentity: input.actorIdentity,
    capabilityGrantId: input.capabilityGrantId
  });
  const refUpdate = await refs.compareAndSwap({
    name: input.targetRef,
    expectedHead: input.expectedHead,
    nextHead: commit.commitId,
    actorIdentity: input.actorIdentity,
    capabilityGrantId: input.capabilityGrantId,
    lease: input.lease
  });
  await transactions.complete(transactionId, commit.commitId, refUpdate);
  return { transactionId, commit, refUpdate };
}
```

Recovery reads prepared transactions. If the ref still equals expected, it may replay idempotently with a still-valid lease; if the ref equals the intended commit, it writes the missing completion receipt; if another commit won, it marks typed conflict and leaves the immutable losing commit unreachable.

- [ ] **Step 5: Pass commit, crash, and idempotent replay tests**

Before running the tests, implement `schema-registry.ts` with:

```ts
export interface RepresentationMigration {
  schemaName: string;
  fromVersion: number;
  toVersion: number;
  migrate(input: Uint8Array): Promise<Uint8Array>;
}

export interface MigrationReceipt {
  schema: 'cosmo.representation-migration.v1';
  sourceObjectId: ObjectId;
  derivedObjectId: ObjectId;
  schemaName: string;
  fromVersion: number;
  toVersion: number;
  migrationImplementation: Sha256;
}
```

Migration never overwrites an object or historical commit. It verifies the source, writes a new derived object linked to the source, and journals the immutable mapping. Add a test proving the old object ID still verifies after migration and the derived object has a different ID with an explicit source link.

```ts
test('representation migration derives a linked object and preserves the source', async () => {
  const repo = await makeAuthorizedRepository();
  const source = await repo.objects.put(
    jsonObject({ schema: 'fixture.v1', value: 1 }),
    repo.testAuthorization
  );
  const receipt = await repo.schemaRegistry.migrate({
    source,
    schemaName: 'fixture',
    fromVersion: 1,
    toVersion: 2,
    authorization: repo.testAuthorization
  });
  assert.notEqual(receipt.derivedObjectId, source.objectId);
  assert.equal((await repo.objects.verify(source)).status, 'valid');
  const derived = await repo.objects.get({
    objectId: receipt.derivedObjectId,
    mediaType: 'application/json',
    byteLength: receipt.derivedByteLength
  }, repo.testAuthorization);
  assert.ok(derived.descriptor.links.includes(source.objectId));
});
```

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/root-registry.test.ts packages/repository/test/heritage-root-codec.test.ts packages/repository/test/heritage-genesis-builder.test.ts packages/repository/test/commit-store.test.ts packages/repository/test/commit-advance.test.ts
```

Expected: all nine codecs are required, duplicate codecs fail startup, leaf kind/schema/link mismatch fails closed, nested union closure remains attributed, and commit identity, missing-root, signature, duplicate-call, stale-lease, crash-before-ref, crash-after-ref, and recovery tests pass.

- [ ] **Step 6: Commit canonical commit advancement**

```bash
git add packages/repository/src/commit-store.ts packages/repository/src/root-registry.ts \
  packages/repository/src/heritage-root-codec.ts \
  packages/repository/src/heritage-genesis-builder.ts \
  packages/repository/src/schema-registry.ts \
  packages/repository/src/transaction-coordinator.ts \
  packages/repository/src/recovery.ts \
  packages/repository/src/brain-repository.ts packages/repository/src/index.ts \
  packages/repository/test
git commit -m "feat: commit brain state atomically"
```

## Task 7: Implement Git-for-Brains History, Curation, Exact Fork, and Inspectable Diff

**Files:**
- Create: `packages/repository/src/curation-ledger.ts`
- Create: `packages/repository/src/brain-operations.ts`
- Create: `packages/repository/src/fork.ts`
- Create: `packages/repository/src/diff.ts`
- Test: `packages/repository/test/brain-operations.test.ts`
- Test: `packages/repository/test/curation-ledger.test.ts`
- Test: `packages/repository/test/fork-diff.test.ts`

**Interfaces:**
- Consumes: exact commits, ref CAS, journal intents, trust grants, object link closure
- Produces: `status()`, `log()`, `tag()`, `settle()`, `wake()`, typed `CurationLedger`, `fork()`, and `diff()`

- [ ] **Step 1: Write failing Git-for-brains and curation-history tests**

```ts
test('status and log report exact committed history without model inference', async () => {
  const fixture = await makeTwoCommitRepository();
  const status = await fixture.repo.status({ refName: 'refs/heads/main' });
  const log = await fixture.repo.log({
    fromCommitId: fixture.second.commitId,
    maxCommits: 20,
  });
  assert.equal(status.headCommitId, fixture.second.commitId);
  assert.deepEqual(
    log.commits.map((commit) => commit.commitId),
    [fixture.second.commitId, fixture.first.commitId],
  );
});

test('settle and wake preserve the exact commit and append typed heritage', async () => {
  const fixture = await makeTwoCommitRepository();
  const settled = await fixture.settleSecond('evidence plateau worth preserving');
  const woken = await fixture.wakeSettled('resume after human surprise');
  assert.equal(settled.settledCommitId, fixture.second.commitId);
  assert.equal(woken.wakeBrainCommitId, fixture.second.commitId);
  const events = await collect(fixture.repo.curation.read({
    basedOnBrainCommitId: fixture.second.commitId,
  }));
  assert.deepEqual(
    events.map((event) => event.record.payload.kind),
    ['settled', 'woken'],
  );
});

test('curation ledger preserves surprise, flaws, frozen hashes, evaluations, and design material', async () => {
  const fixture = await makeTwoCommitRepository();
  await fixture.appendEveryCurationPayloadKind();
  const verification = await fixture.repo.curation.verify();
  assert.equal(verification.valid, true);
  assert.deepEqual(
    await fixture.curationKinds(),
    [
      'human_surprise',
      'judgment',
      'known_flaw',
      'frozen_hashes',
      'evaluation_result',
      'design_material',
    ],
  );
});

test('fork creates a new ref at the exact parent without copying or changing it', async () => {
  const fixture = await makeTwoCommitRepository();
  const before = await snapshotRepositoryIdentity(fixture.repo);
  await fixture.repo.fork({
    parentCommitId: fixture.first.commitId,
    newRef: 'refs/heads/history-specialist',
    purpose: 'preserve a historical perspective',
    covenantDifferenceObjectId: null,
    actorIdentity: fixture.actor,
    capabilityGrantId: fixture.grantId,
    lease: await fixture.repo.leases.acquire(leaseInput('refs/heads/history-specialist', 5000))
  });
  assert.equal(await fixture.repo.refs.get('refs/heads/history-specialist'), fixture.first.commitId);
  assert.deepEqual(await snapshotCommit(fixture.repo, fixture.first.commitId), before.commits[0]);
});

test('diff reports root and reachable object changes without semantic inference', async () => {
  const fixture = await makeTwoCommitRepository();
  const diff = await fixture.repo.diff(fixture.first.commitId, fixture.second.commitId);
  assert.deepEqual(diff.parentRelation, 'left_is_ancestor');
  assert.ok(diff.changedRoots.includes('epistemicRoot'));
  assert.deepEqual(diff.addedObjectIds, [fixture.addedObjectId]);
  assert.deepEqual(diff.removedObjectIds, []);
});
```

- [ ] **Step 2: Run tests to verify the repository operations are absent**

Run:

```bash
npm exec -- node --import tsx --test \
  packages/repository/test/brain-operations.test.ts \
  packages/repository/test/curation-ledger.test.ts \
  packages/repository/test/fork-diff.test.ts
```

Expected: FAIL with missing brain-operations, curation-ledger, fork, and diff modules.

- [ ] **Step 3: Implement append-only Intellectual Heritage and Curation history**

`CurationLedger.append()` authorizes `curation:append`, validates the discriminated payload, verifies every referenced commit/object, hashes/stores canonical `CurationEventRecord` bytes without their own ID, attaches the returned `eventId` only in the decoded wrapper, and advances `curation/head.json` with append-before-act intent and CAS. `previousCurationEventId` makes the ledger independently verifiable. Events record why a Brain was created, locked, forked, considered for union, rejected, tagged, settled, or woken, plus typed human surprise, judgment, known flaw, frozen hash, evaluation result, and design material records.

`basedOnBrainCommitId` is null only for genesis preparation and otherwise names an already-existing commit. A curation event included in a new `HeritageSnapshot` may name only the parent/basis commit or older related commits, never the not-yet-hashable child commit that will contain that heritage root. An event written after a commit exists may name that commit, but it can first enter a later descendant heritage snapshot. Strict codec tests reject legacy `brainCommitId` and any attempted child/enclosing commit ID.

`createSnapshot()` writes immutable `cosmo.intellectual-heritage.v1` roots that link every parent heritage root and referenced curation event. Its explicit trust descriptor must be no broader than the exact intersection of parents/events, so private heritage is encrypted by Task 2. Every `BrainCommitPayload` pins one `heritageRoot`; genesis pins the dedicated parentless `created` snapshot, forks preserve the exact parent root, and any new child commit either carries it byte-identically or derives a linked snapshot for new heritage events. `materialize()` recursively verifies parent roots and returns the complete ordered event history plus effective trust without prose synthesis.

The general `createSnapshot()` input requires at least one
`parentHeritageRoots` member. Only Task 6's `HeritageGenesisBuilder` may build
the parentless root, and that root is not eventless: it contains the builder's
single `created` curation event. This prevents ordinary mutation code from
masquerading as genesis.

No event may change the referenced Brain commit. Large notes and artifacts are separately authorized objects linked by ID. `read()` filters only after authorization and preserves recorded order; `verify()` checks the entire hash chain and all references.

- [ ] **Step 4: Implement `status`, `log`, `tag`, `settle`, and `wake`**

- `status()` verifies the requested head, maps `refs/heads/<name>` only to `refs/settled/<name>`, counts first-parent commits ahead of that exact settled ref, and reports unresolved transactions/degraded mode without changing state.
- `log()` performs a deterministic parent traversal: first parent first, remaining parents lexicographically, visited once, bounded by `maxCommits`, with an exact continuation token. It never summarizes semantics.
- `tag()` authorizes `brain:tag`, verifies the target, appends a `tagged` curation event, and CAS-creates an immutable `refs/tags/*` ref. Reusing a tag for another commit fails `immutable_tag_conflict`.
- `settle()` authorizes `brain:settle`, requires `refs.get(branchRef) === expectedHead`, verifies the commit, appends the durable `settled` event, then CAS-creates or idempotently confirms `refs/settled/*` at that exact commit. It does not stop a process or rewrite the Brain.
- `wake()` authorizes `brain:wake`, resolves an exact settled ref, appends the durable `woken` event, and CAS-creates/advances the named head to the exact settled commit. It does not select a question or perform cognition; Program E resumes cognitive lifecycle from that commit.

All five operations use Program B transactions, leases, and fencing. Recovery yields the complete old or complete new ref plus exactly one curation event.

- [ ] **Step 5: Implement fork metadata and exact ref creation**

Fork authorizes `branch:fork`, verifies the parent commit, stores a typed immutable `cosmo.fork-record.v1` object containing purpose and optional Covenant-difference object ID, appends it to the journal, and CAS-creates the new ref from null to the exact parent. It does not create a copied commit, rewrite object IDs, or infer a merge base.

- [ ] **Step 6: Implement object-closure and ancestry diff**

Walk descriptor `links` from every Brain root with a visited set. `BrainDiff` contains:

- exact left/right commit IDs;
- parent relation;
- changed root field names;
- added, removed, and shared object IDs;
- corpus snapshot additions/removals;
- direct and ancestry-closed journal-event additions/removals plus the
  high-water range difference;
- Principal/kernel/schema version changes;
- no claim about semantic equivalence.

Sort every list by object ID so repeated diffs are byte-identical.

- [ ] **Step 7: Pass Git-for-brains, curation, fork/diff, and read-only tests**

Run:

```bash
npm exec -- node --import tsx --test \
  packages/repository/test/brain-operations.test.ts \
  packages/repository/test/curation-ledger.test.ts \
  packages/repository/test/fork-diff.test.ts
```

Expected: typed heritage is intact; status/log/diff are read-only; tag/settle/wake/fork preserve exact commits and recover atomically.

- [ ] **Step 8: Commit repository history and Git-for-brains operations**

```bash
git add packages/repository/src/curation-ledger.ts \
  packages/repository/src/brain-operations.ts packages/repository/src/fork.ts \
  packages/repository/src/diff.ts packages/repository/test/brain-operations.test.ts \
  packages/repository/test/curation-ledger.test.ts \
  packages/repository/test/fork-diff.test.ts
git commit -m "feat: add git for brains history"
```

## Task 8: Implement Authorized Lossless Union

**Files:**
- Create: `packages/repository/src/union.ts`
- Create: `fixtures/contracts/repository/catastrophic-merge-counts.json`
- Test: `packages/repository/test/union.test.ts`
- Test: `packages/repository/test/union-resolution.test.ts`

**Interfaces:**
- Consumes: parent commits, trust intersection, object closure, commit advancement
- Produces: `union(input: UnionRequest): Promise<UnionReceipt>` and `resolveUnionRootLayers(input): Promise<ResolvedUnionRootLayers>`

- [ ] **Step 1: Freeze the historical catastrophe oracle**

```json
{
  "schema": "cosmo.merge-catastrophe-counts.v1",
  "cases": [
    { "name": "STEM_A", "input": 2161, "historicalOutput": 5 },
    { "name": "STEM_B", "input": 2113, "historicalOutput": 23 },
    { "name": "STEM_C", "input": 1688, "historicalOutput": 130 },
    { "name": "HUMAN_D", "input": 2320, "historicalOutput": 31 },
    { "name": "HUMAN_E", "input": 1408, "historicalOutput": 4 },
    { "name": "HUMAN_F", "input": 2438, "historicalOutput": 26 },
    { "name": "AESTHETIC_G", "input": 1155, "historicalOutput": 14 }
  ]
}
```

- [ ] **Step 2: Write the lossless union tests**

```ts
test('union retains every authorized parent object byte-identically', async () => {
  const fixture = await makeUnionFixture({
    leftConcepts: ['same-source insight A', 'same-source insight B'],
    rightConcepts: ['cross-domain insight C']
  });
  const leftClosure = await closure(fixture.repo, fixture.left.commitId);
  const rightClosure = await closure(fixture.repo, fixture.right.commitId);
  const result = await fixture.repo.union(fixture.request);
  const child = await fixture.repo.commits.get(result.commitId);
  const childClosure = await closure(fixture.repo, result.commitId);
  for (const objectId of new Set([...leftClosure, ...rightClosure])) {
    assert.ok(childClosure.has(objectId), `missing ${objectId}`);
  }
  assert.deepEqual(await fixture.repo.objects.get(fixture.sameSourceA), fixture.originalA);
  assert.deepEqual(await fixture.repo.objects.get(fixture.sameSourceB), fixture.originalB);
  assert.deepEqual(child.payload.parentCommitIds.sort(),
    [fixture.left.commitId, fixture.right.commitId].sort());
});

test('union refuses incompatible rights and directs caller to federation', async () => {
  const fixture = await makeRightsConflictUnionFixture();
  await assert.rejects(() => fixture.repo.union(fixture.request), error => {
    assert.equal(error.code, 'UNION_RIGHTS_CONFLICT');
    assert.equal(error.recommendedOperation, 'federate');
    return true;
  });
});

test('nested union resolution returns every attributed leaf and wrapper reachability', async () => {
  const fixture = await makeNestedUnionFixture();
  const resolved = await fixture.repo.resolveUnionRootLayers({
    rootKind: 'epistemicRoot',
    sourceCommitId: fixture.outerUnion.commitId,
    root: fixture.outerUnion.payload.epistemicRoot,
    maxDepth: 32,
    authorization: fixture.readAuthorization,
  });
  assert.deepEqual(
    resolved.leafLayers.map((layer) => [layer.sourceCommitId, layer.root.objectId]),
    fixture.expectedLeafLayers,
  );
  assert.equal(resolved.reachableObjectIds.includes(fixture.innerWrapperObjectId), true);
  assert.equal(resolved.reachableObjectIds.includes(fixture.outerWrapperObjectId), true);
});

test('union resolution rejects kind mismatch, cycles, depth overflow, and inaccessible leaves', async () => {
  const fixture = await makeNestedUnionFixture();
  await assert.rejects(() => fixture.resolveAs('topologyRoot'), {
    code: 'union_root_kind_mismatch',
  });
  await assert.rejects(() => fixture.resolveCycle(), { code: 'union_root_cycle' });
  await assert.rejects(() => fixture.resolveAtDepth(1), {
    code: 'union_root_depth_exceeded',
  });
  await assert.rejects(() => fixture.resolveWithoutPrivateGrant(), {
    code: 'object_read_denied',
  });
});

test('union event closure is both parent histories plus explicit merge events', async () => {
  const fixture = await makeInterleavedBranchJournalFixture();
  const left = await fixture.commitLeftSelecting(
    ['evt_left_1', 'evt_left_2'],
  );
  const right = await fixture.commitRightSelecting(
    ['evt_right_1', 'evt_right_2'],
  );
  const merged = await fixture.union(left, right);
  const mergedCommit = await fixture.repo.commits.get(merged.commitId);
  assert.deepEqual(mergedCommit.payload.journalEventIds,
    fixture.explicitMergeEventIds);
  assert.deepEqual(
    (await fixture.repo.commits.eventClosure(merged.commitId))
      .allJournalEventIds,
    fixture.allBranchAndMergeEventIdsInJournalOrder,
  );
  assert.equal(
    (await fixture.repo.commits.eventClosure(left.commitId))
      .allJournalEventIds.includes('evt_right_1'),
    false,
  );
  assert.equal(
    (await fixture.repo.commits.eventClosure(right.commitId))
      .allJournalEventIds.includes('evt_left_1'),
    false,
  );
  assert.deepEqual(merged.eventScope, fixture.expectedDerivedUnionScope);
  assert.deepEqual(
    (await fixture.repo.commits.eventClosure(merged.commitId)).scopes,
    fixture.expectedClosureScopes,
  );
});

test('union scope is derived, replay-stable, and cannot be caller-selected', async () => {
  const fixture = await makeUnionFixture();
  assert.equal('eventScope' in fixture.request, false);
  const first = await fixture.repo.union(fixture.request);
  const replay = await fixture.repo.union({
    ...fixture.request,
    parentCommitIds: [...fixture.request.parentCommitIds].reverse(),
    lease: await fixture.renewLease(),
  });
  assert.deepEqual(replay, first);
  assert.equal(first.unionOperationId, fixture.expectedUnionOperationId);
  assert.equal(fixture.mergeEventAppendCount, 2);
  assert.deepEqual(first.eventScope, {
    kind: 'brain_lineage',
    basedOnBrainCommitId: fixture.request.targetParentCommitId,
    targetRef: fixture.request.targetRef,
    programId: null,
    lineageId: fixture.expectedUnionLineageId,
    trustDomain: fixture.effectiveTargetTrustDomain,
  });
  await assert.rejects(
    () => fixture.installMergeEventWithScope({
      ...first.eventScope,
      lineageId: fixture.attackerChosenLineageId,
    }),
    { code: 'BRAIN_COMMIT_EVENT_SCOPE_INVALID' },
  );
  await assert.rejects(
    () => fixture.repo.union({
      ...fixture.request,
      mergeableRootKinds: ['epistemicRoot'],
    }),
    { code: 'union_idempotency_conflict' },
  );
});
```

- [ ] **Step 3: Run tests to verify union is absent**

Run:

```bash
npm exec -- node --import tsx --test \
  packages/repository/test/union.test.ts \
  packages/repository/test/union-resolution.test.ts
```

Expected: FAIL with missing union module.

- [ ] **Step 4: Implement union wrappers without semantic deduplication**

For mergeable root fields `epistemicRoot`, `questionRoot`, `topologyRoot`, `negativeKnowledgeRoot`, and `artifactIndexRoot`, create:

```ts
interface UnionRootPayload {
  schema: 'cosmo.union-root.v1';
  rootKind:
    | 'epistemicRoot'
    | 'questionRoot'
    | 'topologyRoot'
    | 'negativeKnowledgeRoot'
    | 'artifactIndexRoot';
  layers: Array<{
    sourceCommitId: BrainCommitId;
    root: ObjectRef;
  }>;
  unionMetadataObjectId: ObjectId;
}
```

The wrapper descriptor links every layer root and the union-metadata object. `layers` is sorted by `(sourceCommitId, root.objectId)` and is unique only by that exact tuple: the same object reached from two source commits retains both provenance layers. Shared content-addressed ancestry appears once in `reachableObjectIds`; no similarity comparison, node rewrite, winner selection, status change, or same-source comparison occurs.

The target parent's `programRoot`, `relationshipRoot`, and `activationRoot` remain unchanged. The child `heritageRoot` is a structural `HeritageSnapshot` that links every parent's exact heritage root plus typed `merge_attempted` and outcome events; it performs no semantic curation. Parent corpus snapshots are included only when authorized. The target parent supplies Principal/kernel versions. `UnionRequest` pins exact parents, target ref/head, target parent, trust domain, declared mergeable classes, journal range, created time, authorization, and lease. It deliberately has no event-scope or lineage field.

The union service appends and selects only its own typed merge-attempt/outcome
records in the child's `journalEventIds`. It does not copy either parent's
direct list and never selects unrelated events inside the supplied high-water
range. The merged event closure comes mechanically from both parent ancestries
plus those explicit merge records, sorted by their admitted journal cursors.
The request cannot supply or override the child's event-membership list.

Before appending those records the repository sorts `parentCommitIds`
lexicographically and derives the sole merge scope itself:

```ts
const lineageId = hashCanonical({
  schema: 'cosmo.union-lineage-id.v1',
  targetRef: input.targetRef,
  parentCommitIds: [...input.parentCommitIds].sort(),
});
const eventScope: Extract<BrainEventScope, { kind: 'brain_lineage' }> = {
  kind: 'brain_lineage',
  basedOnBrainCommitId: input.targetParentCommitId,
  targetRef: input.targetRef,
  programId: null,
  lineageId,
  trustDomain: effectiveTargetTrustDomain,
};
```

`effectiveTargetTrustDomain` is the verified target-domain result after rights
intersection, not an unverified echo of the request. Every direct merge event
must carry this exact object. `UnionReceipt.eventScope` returns it and
`CommitStore.eventClosure()` includes it in the canonical scope set. Parent
ordering permutations replay to the same lineage and receipt. A caller-supplied
scope field, a merge event with another lineage/parent/ref/domain, or a target
parent outside the ordered parent set is rejected before publication.

Before the first merge event, the service canonicalizes the semantic request:
it sorts/deduplicates parent and mergeable-root lists, verifies the target
parent is a member, and excludes renewable lease expiry/token material. It
derives:

```ts
const unionOperationId = hashCanonical({
  schema: 'cosmo.union-operation.v1',
  targetRef: input.targetRef,
  expectedHead: input.expectedHead,
  targetParentCommitId: input.targetParentCommitId,
  parentCommitIds: canonicalParents,
  mergeableRootKinds: canonicalRootKinds,
  targetTrustDomain: input.targetTrustDomain,
  journalRange: input.journalRange,
  idempotencyKey: input.idempotencyKey,
  createdAt: input.createdAt,
  actorIdentity: input.actorIdentity,
  capabilityGrantId: input.capabilityGrantId,
});
```

It persists an append-before-act union intent indexed by
`(targetRef, idempotencyKey)` and bound to this operation ID before appending
either merge event. Exact replay,
including reversed caller parent order or a renewed lease, recovers and returns
the byte-identical `UnionReceipt` without duplicate events/CAS. A changed
semantic body under the same operation key fails `union_idempotency_conflict`.
`UnionReceipt.unionOperationId` exposes the stable recovery identity.

- [ ] **Step 5: Implement recursive, rights-aware union-root resolution**

`resolveUnionRootLayers()` is the structural compatibility view over the same `BrainRootRegistry` recursion used by commit verification:

1. verify `sourceCommitId`, the requested root, and `maxDepth` (`1..128`);
2. authorize the root before reading payload bytes;
3. if the payload is not `cosmo.union-root.v1`, return one leaf `{ sourceCommitId, root }`;
4. if it is a wrapper, require an exact `rootKind` match, add the wrapper and metadata closures to `reachableObjectIds`, and recursively visit every declared layer;
5. detect cycles by wrapper object ID on the active recursion path and fail `union_root_cycle`;
6. authorize every leaf independently and preserve its recorded `sourceCommitId`;
7. sort leaf tuples and reachable object IDs deterministically; and
8. require its leaf layers and closure to equal `repository.roots.closure(...)` for the same source/root/kind; and
9. return no synthesized snapshot and perform no canonical write.

This resolver preserves structural reachability and provenance. Typed consumers call `repository.roots.verify(...)` and `repository.roots.materialize(...)`; they may never parse a union wrapper as though it were a leaf snapshot or bypass the owner codec. Program E owns only the typed semantic composition of verified attributed leaves into a queryable/metabolizable view.

- [ ] **Step 6: Verify the union oracle and recursive resolver**

Add a generated test for each historical count that creates that many unique linked object descriptors and proves the union child's inherited reachable-object set equals the exact authorized parent-set union. Typed union wrappers and merge metadata are counted separately. The test does not claim to reproduce historical semantics; it proves the repository cannot collapse unique identities.

Run:

```bash
npm exec -- node --import tsx --test \
  packages/repository/test/union.test.ts \
  packages/repository/test/union-resolution.test.ts
```

Expected: every lossless-count, shared-ancestor, same-source, dissent, rights,
private-root, nested-wrapper, cycle, depth, attribution, interleaved-branch,
and explicit-merge event-membership test passes.

- [ ] **Step 7: Commit lossless union and recursive resolution**

```bash
git add packages/repository/src/union.ts packages/repository/test/union.test.ts \
  packages/repository/test/union-resolution.test.ts \
  fixtures/contracts/repository/catastrophic-merge-counts.json
git commit -m "feat: union brains without loss"
```

## Task 9: Implement Read-Only Exact-Commit Federation

**Files:**
- Create: `packages/repository/src/federation.ts`
- Test: `packages/repository/test/federation.test.ts`

**Interfaces:**
- Consumes: verified commits and trust grants
- Produces: `federate()`

- [ ] **Step 1: Write attribution and non-mutation tests**

```ts
test('federation attributes every root and changes no participating state', async () => {
  const fixture = await makeFederationFixture();
  const before = await snapshotRepositoryIdentity(fixture.repo);
  const set = await fixture.repo.federate({
    brainSetId: 'science-history',
    commitIds: [fixture.science.commitId, fixture.history.commitId],
    actorIdentity: fixture.actor,
    capabilityGrantId: fixture.grantId
  });
  assert.deepEqual(set.commitIds, [fixture.science.commitId, fixture.history.commitId].sort());
  assert.equal(set.members.every(member => member.commitId && member.roots), true);
  assert.deepEqual(await snapshotRepositoryIdentity(fixture.repo), before);
});
```

- [ ] **Step 2: Run the test to verify federation is absent**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/federation.test.ts
```

Expected: FAIL with missing federation module.

- [ ] **Step 3: Implement `BrainSet` as a read-only view**

Federation:

- verifies each exact commit;
- authorizes read access for each root;
- returns members sorted by commit ID;
- attaches `commitId` to every root/object result;
- exposes no mutation method;
- creates no commit, ref, journal event, or shared mutable state;
- fails the whole request if attribution would be ambiguous.

Rights may filter inaccessible members only when the request explicitly sets `allowPartial: true`; the result then lists denied commit IDs and reasons.

- [ ] **Step 4: Pass federation, partial-rights, and identity tests**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/federation.test.ts
```

Expected: exact attribution, denied-member, duplicate-commit, and zero-mutation tests pass.

- [ ] **Step 5: Commit federation**

```bash
git add packages/repository/src/federation.ts packages/repository/test/federation.test.ts
git commit -m "feat: federate exact brain commits"
```

## Task 10: Export and Import Verifiable `.brain` Bundles

**Files:**
- Create: `packages/repository/src/bundle.ts`
- Test: `packages/repository/test/bundle.test.ts`

**Interfaces:**
- Consumes: commits, object closure, signatures, trust
- Produces: `exportBundle()` and `importBundle()`

- [ ] **Step 1: Write exact round-trip and quarantine tests**

```ts
test('export/import reproduces exact commit and object IDs', async () => {
  const source = await makeTwoCommitRepository();
  const destination = await makeEmptyAuthorizedRepository();
  const exported = await source.repo.exportBundle({
    commitIds: [source.second.commitId],
    destination: source.bundlePath,
    actorIdentity: source.actor,
    capabilityGrantId: source.exportGrantId,
    redactionTombstoneIds: [],
    recipientWrappingKeyIdsByTrustDomain: {},
  });
  const imported = await destination.repo.importBundle({
    bundlePath: exported.bundlePath,
    exposeRefs: [],
    actorIdentity: destination.actor,
    capabilityGrantId: destination.importGrantId
  });
  assert.deepEqual(imported.commitIds, [source.second.commitId]);
  assert.equal((await destination.repo.verify(source.second.commitId)).status, 'valid');
  assert.deepEqual(await closure(destination.repo, source.second.commitId),
    await closure(source.repo, source.second.commitId));
});

test('corrupt bundle never escapes quarantine', async () => {
  const fixture = await makeExportFixture();
  await corruptOneBundleObject(fixture.bundlePath);
  await assert.rejects(() => fixture.destination.importBundle(fixture.importInput), /BUNDLE_HASH_MISMATCH/);
  await assert.rejects(
    () => fixture.destination.commits.get(fixture.commitId),
    /MISSING_COMMIT/
  );
  assert.equal(await fixture.destination.refs.get('refs/heads/imported'), null);
});

test('private bundle carries ciphertext and recipient-wrapped keys, never plaintext keys', async () => {
  const fixture = await makePrivateExportFixture();
  const exported = await fixture.source.exportBundle({
    ...fixture.exportInput,
    recipientWrappingKeyIdsByTrustDomain: {
      'private-jtr': fixture.destinationWrappingKeyId,
    },
  });
  assert.equal(await directoryContainsBytes(exported.bundlePath, fixture.privateBytes), false);
  assert.equal(await bundleContainsRawKeyBytes(exported.bundlePath, fixture.domainKeyBytes), false);
  await fixture.destination.importBundle(fixture.importInput(exported.bundlePath));
  assert.equal(
    (await fixture.destination.objects.get(
      fixture.privateObjectRef,
      fixture.destinationReadAuthorization,
    )).bytes.toString(),
    fixture.privateBytes.toString(),
  );
});
```

- [ ] **Step 2: Run tests to verify bundle code is absent**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/bundle.test.ts
```

Expected: FAIL with missing bundle module.

- [ ] **Step 3: Implement deterministic directory bundles**

Bundle layout:

```text
<bundle-id>.brain/
  manifest.json
  blobs/public/sha256/
  blobs/encrypted/<trust-domain-hash>/<key-id>/sha256/
  envelopes/
  wrapped-domain-keys/
  objects/sha256/
  journal/
  commits/sha256/
  signatures/
  tombstones/
  verification.json
```

The manifest pins exact commits, each commit's complete ancestry-derived event
closure and direct `journalEventIds`, the exact admitted journal records,
complete reachable object set, plaintext hashes, public blob hashes,
encrypted-envelope/ciphertext hashes, recipient-wrapped domain-key envelopes,
detached signatures, trust descriptors, tombstones, schema versions, and
verification instructions. `bundleId` hashes the canonical manifest payload
excluding `exportedAt`.
`ExportBundleInput.recipientWrappingKeyIdsByTrustDomain` is required for every
exported private/restricted trust domain.

Export stages outside repository/source roots, checks `bundle:export` and every object's exportability, copies only exact public or encrypted CAS bytes, asks `EncryptionKeyProvider.wrapForRecipient()` for each allowed domain key, rehashes the staging tree, scans for forbidden raw key/plaintext fixtures, and atomically publishes the bundle directory. It never decrypts a private payload into the staging tree.

Import:

1. copies or opens the bundle only inside `quarantine`;
2. validates manifest identity;
3. validates every descriptor, public blob, ciphertext, envelope, commit,
   signature, and tombstone, including each commit's explicit
   `journalEventIds`, cursor order/range, and ancestry-derived event closure;
4. checks import grant, exact trust-domain compatibility, and wrapped-key recipient identity;
5. asks the injected provider to unwrap/install keys, decrypt-verifies plaintext hashes in quarantine, and rolls key installation back on failure;
6. atomically admits immutable journal records, objects, and commits without
   changing event/object/commit IDs or adopting other quarantined records into
   a commit merely because their cursors are in range;
7. creates no ref unless `exposeRefs` explicitly names a ref, expected head, and lease; and
8. removes quarantine only after a complete receipt.

- [ ] **Step 4: Add restart, duplicate import, missing object, and no-ref tests**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/bundle.test.ts
```

Expected: exact public/private round trip, recipient mismatch, no-plaintext/no-raw-key, duplicate idempotence, missing object, corrupt ciphertext, crash during admission, and explicit-ref-only tests pass.

- [ ] **Step 5: Commit bundle portability**

```bash
git add packages/repository/src/bundle.ts packages/repository/test/bundle.test.ts
git commit -m "feat: export verifiable brain bundles"
```

## Task 11: Apply Signed Redactions Without Hiding Corruption

**Files:**
- Create: `packages/repository/src/redaction.ts`
- Test: `packages/repository/test/redaction.test.ts`

**Interfaces:**
- Consumes: trust keys, object closure, commits, bundles
- Produces: signed tombstones and redaction-aware verification

- [ ] **Step 1: Write authorized, forged, and shared-blob tests**

```ts
test('authorized deletion yields valid_with_authorized_redactions', async () => {
  const fixture = await makeRedactionFixture();
  const tombstone = await fixture.redactions.create({
    objectId: fixture.privateObject.objectId,
    objectMediaType: fixture.privateObject.mediaType,
    reason: 'owner deletion request',
    authorityIdentity: fixture.owner.keyId,
    redactedAt: fixture.clock.now(),
    trustDomain: 'private-jtr',
    affectedCommitIds: [fixture.commit.commitId]
  }, fixture.ownerSigner);
  await fixture.redactions.apply(tombstone, fixture.authorization);
  const report = await fixture.repo.verify(fixture.commit.commitId);
  assert.equal(report.status, 'valid_with_authorized_redactions');
  assert.deepEqual(report.authorizedRedactions, [tombstone.tombstoneId]);
});

test('forged tombstone is corruption, not authorization', async () => {
  const fixture = await makeRedactionFixture();
  await assert.rejects(() => fixture.redactions.apply(
    fixture.forgedTombstone,
    fixture.authorization
  ), /INVALID_TOMBSTONE_SIGNATURE/);
  assert.equal((await fixture.repo.verify(fixture.commit.commitId)).status, 'valid');
});

test('private key erasure cannot affect equal public plaintext or another domain', async () => {
  const fixture = await makeSharedBlobRedactionFixture();
  await fixture.redactions.apply(fixture.privateTombstone, fixture.authorization);
  assert.equal(await fixture.repo.objects.has(fixture.publicObject.objectId), true);
  assert.equal((await fixture.repo.objects.get(fixture.publicObject)).bytes.toString(), 'shared bytes');
  assert.equal(
    (await fixture.repo.objects.get(
      fixture.otherDomainObject,
      fixture.otherDomainAuthorization,
    )).bytes.toString(),
    'shared bytes',
  );
});
```

- [ ] **Step 2: Run tests to verify redaction code is absent**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/redaction.test.ts
```

Expected: FAIL with missing redaction module.

- [ ] **Step 3: Implement signed tombstones and access denial**

`RedactionTombstonePayload` contains deleted object hash/type, authority, reason, time, trust domain, affected descendants, and disposition `logical`, `physical`, or `key_erasure`. `tombstoneId` hashes unsigned payload; signatures use the redaction domain.

Apply:

1. authorizes `redaction:authorize`;
2. verifies authority controls the object's trust domain;
3. verifies affected descendants are complete;
4. persists the tombstone before denying access;
5. denies ordinary `get()` for the redacted object;
6. removes public raw bytes only when no non-redacted public descriptor uses the payload; private/restricted physical deletion removes only the target domain envelope/ciphertext, while key erasure follows Task 2's complete-rewrap-or-complete-tombstone rule;
7. appends the epistemic consequence requirement for Programs C/E;
8. never rewrites the historical commit.

- [ ] **Step 4: Integrate redactions with verify and bundle**

Verification returns:

- `valid` when every required object is present;
- `valid_with_authorized_redactions` when each unavailable object has a valid applicable tombstone;
- `corrupt_missing_object` for unexplained absence, invalid signatures, incomplete descendants, or a missing non-content audit record.

Export includes applicable tombstones without leaking payload. Import preserves denial and status.

- [ ] **Step 5: Pass redaction and round-trip tests**

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/redaction.test.ts packages/repository/test/bundle.test.ts
```

Expected: logical, physical, key-erasure, shared-blob, forged, incomplete-descendant, export/import, and status tests pass.

- [ ] **Step 6: Commit redaction semantics**

```bash
git add packages/repository/src/redaction.ts packages/repository/src/object-store.ts packages/repository/src/bundle.ts packages/repository/test
git commit -m "feat: preserve signed brain redactions"
```

## Task 12: Prove Crash, Concurrency, Bit-Rot, and Recovery Gates

**Files:**
- Create: `packages/repository/test/crash-matrix.test.ts`
- Create: `packages/repository/test/concurrency-process.test.ts`
- Create: `packages/repository/test/bitrot-recovery.test.ts`
- Create: `packages/repository/test/support/ref-writer-process.ts`
- Create: `fixtures/contracts/repository/unicode-surrogate.json`
- Create: `fixtures/contracts/repository/truncated-checkpoint.bin`
- Create: `scripts/verify-program-b.mjs`
- Create: `docs/architecture/brain-repository.md`
- Create: `docs/receipts/program-b-brain-repository.json`

**Interfaces:**
- Consumes: every Program B component
- Produces: the Program B stop/go receipt

- [ ] **Step 1: Consume the frozen Task 1 fault-point matrix**

Import `FaultPoint`, `FaultPointSchema`, and `allFaultPoints` from the Task 1 public exports. Do not redeclare the union in Task 12. Assert that `allFaultPoints` is byte-for-byte equal to `FaultPointSchema.options`, has no duplicates, and contains every value frozen in Task 1 before generating the crash matrix.

- [ ] **Step 2: Write the crash matrix test**

```ts
for (const point of allFaultPoints) {
  test(`reconciles ${point} to an old or complete new canonical state`, async () => {
    const fixture = await makeCrashFixture(point);
    await fixture.attempt();
    const reopened = await fixture.reopenWithoutFault();
    const recovery = await reopened.reconcile();
    const head = await reopened.refs.get('refs/heads/main');
    assert.ok(head === fixture.oldHead || head === fixture.newHead);
    if (head === fixture.newHead) {
      assert.equal((await reopened.verify(head)).status, fixture.expectedVerificationStatus);
      assert.deepEqual(
        (await reopened.commits.eventClosure(head)).allJournalEventIds,
        fixture.expectedEventClosureFor(head),
      );
      assert.equal(recovery.incompleteVisibleTransactions, 0);
    }
    assert.equal((await reopened.journal.verify()).valid, true);
    assert.equal(recovery.partialCanonicalFiles, 0);
  });
}
```

- [ ] **Step 3: Add real multi-process concurrency tests**

Spawn 8 Node processes against one temporary repository. Give each a valid lease attempt and the same expected head. Assert:

- one ref update succeeds;
- seven receive `REF_CONFLICT` or `STALE_FENCE`;
- journal chain remains contiguous;
- one canonical new head exists;
- losing immutable commits remain verified but unreachable;
- replay does not duplicate promotion or ref updates.

Run:

```bash
npm exec -- node --import tsx --test packages/repository/test/concurrency-process.test.ts
```

Expected: exactly one winner and zero journal/ref corruption.

- [ ] **Step 4: Add bit-rot, missing-drive, and malformed-fixture tests**

Tests deliberately:

- flip one blob byte;
- flip one encrypted ciphertext byte and one GCM tag;
- remove one object descriptor;
- truncate one journal record;
- insert a journal cursor gap;
- replace a ref with malformed JSON;
- remove the repository root during read;
- feed the historical truncated-checkpoint byte fixture;
- feed an unpaired-surrogate JSON fixture.

Expected outcomes are typed degraded/read-only reports. Recovery may select a verified last-known-good ref or complete/roll back a prepared key generation; it may not silently regenerate bytes, mix envelope generations, drop a record, or declare ordinary validity.

- [ ] **Step 5: Write the architecture note and aggregate verifier**

`docs/architecture/brain-repository.md` documents:

- plaintext payload identity versus ciphertext envelope identity;
- trust-domain encryption, external key-provider boundary, rotation, erasure, and private bundle wrapping;
- commit ID and detached signatures;
- journal, curation-ledger, and transaction ordering;
- explicit per-commit event membership, ancestry-derived event closure, and why
  cursor ranges are bounds rather than membership;
- Git-for-brains status/log/tag/settle/wake semantics;
- lease epochs and fencing;
- refs and last-known-good behavior;
- trust/grant/revocation authority;
- startup-frozen owner codecs, typed root verification/materialization, and generic descriptor closure;
- lossless union, recursive layer resolution, and Program E's separate composite materialization;
- federation;
- bundle quarantine;
- redaction states; and
- degraded/read-only recovery.

Create `scripts/verify-program-b.mjs`. It requires `--tested-commit <sha>`, refuses to start unless `git rev-parse HEAD` equals that SHA and `git status --porcelain` is empty, runs the exact commands in Step 7, confirms HEAD did not move, canonicalizes Program A IDs/JSON, and only then writes `docs/receipts/program-b-brain-repository.json`.

- [ ] **Step 6: Commit the complete Program B implementation and gate harness**

Commit all Program B code, contracts, tests, fixtures, verifier, and architecture documentation before generating the receipt:

```bash
git add packages/contracts packages/repository fixtures/contracts/repository \
  scripts/verify-program-b.mjs docs/architecture/brain-repository.md
git commit -m "feat: complete brain repository trust kernel"
test -z "$(git status --porcelain)"
```

Expected: the tree is clean. If any Program B implementation or harness file changes after this commit, discard the old gate result and repeat Steps 6–8 from a new implementation commit.

- [ ] **Step 7: Run the complete Program B suite against the exact clean commit**

Run:

```bash
tested_commit="$(git rev-parse HEAD)"
node scripts/verify-program-b.mjs --tested-commit "$tested_commit"
test "$(git rev-parse HEAD)" = "$tested_commit"
```

The verifier runs, in order:

```bash
npm run check:independence
npm run build
npm exec -- node --import tsx --test packages/repository/test/*.test.ts
npm test
git diff --check
```

Expected: all commands exit 0. The repository report includes
plaintext/ciphertext identity, key rotation/erasure, object CAS, journal,
cross-branch event isolation, explicit merge event closure, curation, trust,
lease, commit, Git-for-brains, fork, diff, nested union resolution, federation,
public/private export/import, redaction, crash, concurrency, and bit-rot lanes.

`docs/receipts/program-b-brain-repository.json` records exact test command, Git commit, fixture IDs, fault points tested, process count, union counts, round-trip commit ID, redaction statuses, Home23 dependency count, and:

```json
{
  "schema": "cosmo.program-b-receipt.v1",
  "gate": "pass",
  "home23DependencyCount": 0,
  "objectCorruption": 0,
  "privatePlaintextAtRestFindings": 0,
  "crossDomainCiphertextReuse": 0,
  "rotationIdentityChanges": 0,
  "curationLedgerCorruption": 0,
  "gitForBrainsOperationFailures": 0,
  "journalCorruption": 0,
  "crossBranchJournalContamination": 0,
  "lostAuthorizedUnionObjects": 0,
  "unresolvedUnionLeafLayers": 0,
  "implicitPrivateRootUnions": 0,
  "exportImportCommitMismatch": 0,
  "unexplainedMissingObjects": 0,
  "concurrentCanonicalWinners": 1
}
```

- [ ] **Step 8: Verify the receipt-only diff and commit the Program B gate**

Run:

```bash
test "$(git status --porcelain)" = "?? docs/receipts/program-b-brain-repository.json"
jq -e '
  .gate == "pass" and
  .home23DependencyCount == 0 and
  .objectCorruption == 0 and
  .privatePlaintextAtRestFindings == 0 and
  .crossDomainCiphertextReuse == 0 and
  .rotationIdentityChanges == 0 and
  .curationLedgerCorruption == 0 and
  .gitForBrainsOperationFailures == 0 and
  .journalCorruption == 0 and
  .crossBranchJournalContamination == 0 and
  .lostAuthorizedUnionObjects == 0 and
  .unresolvedUnionLeafLayers == 0 and
  .implicitPrivateRootUnions == 0 and
  .exportImportCommitMismatch == 0 and
  .unexplainedMissingObjects == 0 and
  .concurrentCanonicalWinners == 1
' docs/receipts/program-b-brain-repository.json
git add docs/receipts/program-b-brain-repository.json
test "$(git diff --cached --name-only)" = "docs/receipts/program-b-brain-repository.json"
git diff --cached --check
test "$(git status --porcelain)" = "A  docs/receipts/program-b-brain-repository.json"
git commit -m "test: receipt brain repository integrity"
test -z "$(git status --porcelain)"
```

Expected: the receipt names the exact implementation commit tested, the final commit contains only the receipt, and the worktree is clean.

## Program B Completion Check

- [ ] Object descriptors bind immutable plaintext identity while private/restricted storage is authenticated ciphertext scoped to one trust domain.
- [ ] Key rotation and authorized erasure never silently change object/commit identity or expose private plaintext at rest.
- [ ] Every public mutation is authorized by a signed, unexpired, unrevoked grant.
- [ ] The admitted journal is contiguous, hash-chained, idempotent, and recoverable.
- [ ] Brain commits hash canonical payload only and retain detached signatures.
- [ ] Every Brain commit pins an immutable `heritageRoot`; derived heritage snapshots link parent roots and typed curation events.
- [ ] Every canonical ref change uses expected head, lease epoch, fencing token, and append-before-act intent.
- [ ] Fork preserves the exact parent.
- [ ] Status/log/tag/settle/wake preserve exact history and append typed curation events.
- [ ] The Intellectual Heritage and Curation ledger preserves human surprise, judgments, flaws, frozen hashes, evaluations, and design material.
- [ ] Diff is deterministic and read-only.
- [ ] Union retains every authorized parent object byte-identically and changes no semantic status.
- [ ] Nested union roots resolve recursively to every attributed leaf and remain consumable by Program E without losing wrapper/parent reachability.
- [ ] Private roots and incompatible rights never enter union implicitly.
- [ ] Federation attributes every result and mutates nothing.
- [ ] Export/import reproduces exact commit IDs after quarantine verification.
- [ ] Signed redactions are distinguishable from corruption.
- [ ] Every fault point recovers to an old or complete new canonical state.
- [ ] Multi-process contention produces exactly one canonical winner.
- [ ] Bit rot and missing objects force explicit degraded/read-only status.
- [ ] The Program B receipt tests an exact clean implementation commit and is committed separately as a receipt-only commit before Program C begins.
