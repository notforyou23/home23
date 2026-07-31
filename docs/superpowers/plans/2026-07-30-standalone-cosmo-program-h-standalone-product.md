# Standalone COSMO Program H: Standalone Product Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the accepted COSMO core as an independently installable, operable, inspectable product with its own daemon, CLI, versioned public API, unprivileged client, and Program F workbench, while preserving complete constitutional separation from Home23.

**Architecture:** A Fastify transport package exposes narrow ports over accepted Programs B–G rather than repository internals. A public client consumes only versioned, authority-free HTTP/SSE contracts, including Program F's mandatory preview-then-commit protocol for Steer and Invent. A standalone service composes COSMO-owned packages, performs deterministic recovery before readiness, and hosts Program E's already-accepted cognitive lifecycle engine plus its one-time, model-free `GenesisBrainService`; Program H's durable scheduler may persist and deliver wake signals but may not recreate genesis semantics, expedition, question, Principal, metabolism, sleep, or wake policy. The CLI initializes private state under `~/.cosmo`, manages only the exact COSMO service instance, and calls the same public API available to any authorized client. A content-manifested release archive packages compiled workspaces and the exact Program F workbench build; an external Linux clean-room harness proves installation, creates the first Brain, starts the first Research Program from that exact receipt, and reruns the sustained packaged scheduler with Home23 absent.

**Tech Stack:** Node.js 22.12+, TypeScript ESM, npm workspaces, Zod 4, Fastify 5, Node `crypto` and `child_process`, React/Vite output produced by Program F, HTTP/SSE, `node:test`, Docker plus `strace` for the final clean-room receipt.

## Global Constraints

- Do not begin implementation until the complete Programs A–H planning set has passed cross-program interface review and the operator explicitly releases the planning freeze.
- Do not execute this plan until the signed Program G shadow-acceptance receipt verifies.
- The canonical source repository is `/Users/jtr/_JTR23_/cosmo`; runtime and private state default to `~/.cosmo`.
- The Program G-accepted `@cosmo/contracts` source and every file in `coreArtifactSet` are immutable inputs to H. Product/API contracts live only in the new H-owned `@cosmo/product-contracts` workspace; any attempted write under accepted core paths invalidates H and requires a new Program G run.
- Home23 is not a source dependency, package dependency, service dependency, process supervisor, state store, discovery mechanism, endpoint, or acceptance dependency.
- Do not create or modify a Home23 client in this program. Such work requires a passing standalone release receipt and a later explicit operator authorization.
- `@cosmo/api`, `@cosmo/client`, and `@cosmo/cli` depend only on public package interfaces; none imports repository implementation paths.
- API clients cannot write objects, journal entries, refs, claims, or Brain commits directly. They request typed operations that still pass Program B kernel and Program C promotion rules.
- Every semantic, candidate, promotion, Research Program, and lifecycle mutation target is parsed through Program E's exact `WritableBrainHeadRefSchema`; candidate targets additionally remain under `refs/heads/candidates/*`. Tags and settled refs may be created only by their dedicated Program B curation operations and are immutable read sources for every E mutation path.
- A fresh repository has no implicit Brain. Exactly one authenticated `POST /brains` request may invoke Program E's accepted `GenesisBrainService`; it creates all nine initial roots, the initial approved Covenant and Relationship event, admitted seed Questions, and Heritage event, then performs one authorized absent-ref CAS. Exact retry returns the same receipt; any existing Brain commit, canonical Brain ref, semantic journal record, non-absent target ref, model call, normal parent-pinned mutation path, or H-authored genesis payload fails closed.
- Public requests never carry `actorIdentity`, `capabilityGrantId`, `LeaseProof`, fencing tokens, journal authority, or internal Program B `ForkRequest`/`UnionRequest`. The authenticated server derives all authority and concurrency fields at the operation boundary.
- Steer and Invent are always two-phase. Preview stores and returns Program F's exact content-addressed, expiring `WorkbenchMutationPreview`; commit accepts only Program F's four-field commit request and fails closed on a changed head, draft, authority fingerprint, principal/scope set, expiry, or prior consumption.
- Service health, research activity, cognitive change, and epistemic integrity are separate status fields.
- Bind to loopback by default. Non-loopback binding requires an explicit origin allowlist and an operator-supplied transport-security policy.
- Bearer tokens never appear in URLs, logs, receipts, shell history examples, or generated configuration. Only salted hashes are stored.
- Browser sessions use one-time fragment exchange codes, `HttpOnly` cookies, and CSRF protection; the workbench never persists a bearer token.
- A mutating HTTP request requires authenticated scopes and an idempotency key, then returns its frozen domain receipt or the generic `OperationReceipt`, except `POST /session/exchange`: its expiring single-use exchange code is consumed atomically as the sole bootstrap/auth/idempotency exception.
- The CLI may stop only the exact COSMO instance whose startup identity it verifies. It must never invoke a broad process-manager or kill command.
- Startup is not ready until repository verification, journal replay, nonterminal-run reconciliation, and scheduler fencing complete.
- Program E owns the cognitive lifecycle engine and every decision to originate, pursue, sleep, settle, or wake. Program H owns process hosting, durable wake delivery, readiness, shutdown, and transport only.
- Program F owns all files under `apps/workbench/`; Program H consumes its generated `apps/workbench/dist/` without modifying workbench source or configuration.
- Release artifacts are built from a committed source tree, include hashes for every file, and are verified before installation.
- Use TDD, run the smallest focused test first, and commit after every independently reviewable task.

---

## File Structure

```text
packages/product-contracts/
  package.json
  tsconfig.json
  src/
    product.ts
    api.ts
    index.ts
packages/api/src/
  auth/
    bearer-token.ts
    origin-policy.ts
    scope-guard.ts
    browser-session.ts
  routes/
    status.ts
    brains.ts
    inquiry.ts
    research.ts
    events.ts
    lifecycle.ts
  errors.ts
  idempotency.ts
  mutation-preview.ts
  ports.ts
  sse.ts
  server.ts
  index.ts
packages/client/src/
  client.ts
  errors.ts
  sse-parser.ts
  index.ts
packages/cli/src/
  commands/
    init.ts
    lifecycle.ts
    open.ts
    research.ts
    brain.ts
    inquiry.ts
  output.ts
  main.ts
  index.ts
apps/service/src/
  config.ts
  composition-root.ts
  research-operation-adapter.ts
  status-aggregator.ts
  startup-recovery.ts
  durable-scheduler.ts
  static-workbench.ts
  shutdown.ts
  main.ts
scripts/
  build-standalone-release.mjs
  install-standalone-release.mjs
  verify-standalone-release.mjs
  prepare-clean-room-context.mjs
config/
  cosmo.example.json
tests/product/
tests/api/
tests/client/
tests/service/
tests/cli/
tests/release/
  Dockerfile
  tsconfig.json
  clean-environment.ts
  clean-room-scenario.ts
  trace-audit.ts
docs/architecture/
  public-api.md
  client-boundary.md
docs/operations/
  install.md
  lifecycle.md
  security.md
docs/receipts/
  program-h-clean-release.md
```

---

### Task 1: Freeze the Public Product and API Contracts

**Files:**
- Modify: `package-lock.json`
- Create: `packages/product-contracts/package.json`
- Create: `packages/product-contracts/tsconfig.json`
- Create: `packages/product-contracts/src/product.ts`
- Create: `packages/product-contracts/src/api.ts`
- Create: `packages/product-contracts/src/index.ts`
- Create: `tests/product/contracts.test.ts`
- Create: `fixtures/contracts/api-v1-route-manifest.json`
- Create: `fixtures/contracts/api-v1-route-fixtures.json`

**Interfaces:**
- Consumes: `BrainCommitId`, `JournalCursor`, `ObjectId`, `ObjectRef`, `QueryRequest`, `QuestionId`, `ResearchProgramId`, `ResearchProgramMode`, `ResearchProgramModeSchema`, `ResearchProgramStatus`, `ResearchProgramStatusSchema`, `RunId`, `Sha256`, `DetachedSignature`; Program E's exact authority-free `CreateGenesisBrainDraft`/`CreateGenesisBrainDraftSchema`, `GenesisBrainReceipt`/`GenesisBrainReceiptSchema`, and `WritableBrainHeadRefSchema`; and Program F's exact `WorkbenchBrainCatalogRequest`, `WorkbenchBrainCatalogRequestSchema`, `WorkbenchBrainCatalog`, `WorkbenchBrainCatalogSchema`, `WorkbenchClientScope`, `WorkbenchClientScopeSchema`, `WorkbenchSessionExchangeResponse`, `WorkbenchSessionExchangeResponseSchema`, `WorkbenchSteerDraft`, `WorkbenchSteerDraftSchema`, `WorkbenchInventDraft`, `WorkbenchInventDraftSchema`, `WorkbenchMutationPreview`, `WorkbenchMutationPreviewSchema`, `WorkbenchSteerCommitRequest`, `WorkbenchSteerCommitRequestSchema`, `WorkbenchInventCommitRequest`, `WorkbenchInventCommitRequestSchema`, `FormationInquiry`, `FormationInquirySchema`, `FormationExplanation`, `FormationExplanationSchema`, `InventReceipt`, `InventReceiptSchema`, `HumanInventPromotionReceipt`, `HumanInventPromotionReceiptSchema`, `ProgramDirectionActivationReceipt`, and `ProgramDirectionActivationReceiptSchema` from the accepted core contracts.
- Re-exports Program E's exact genesis draft/receipt and writable-head schema plus Program F's exact catalog, session, formation, Invent receipt/promotion, program-direction activation receipt, and two-phase mutation schema/type identities. Produces from `@cosmo/product-contracts`: `CreateGenesisBrainHttpRequest`, authority-free `PromoteHumanInventCandidateRequest` and `ActivateResearchAgendaRequest`, `ProductStatus`, `LifecycleIdentity`, `ApiPrincipal`, `ApiError`, `OperationReceipt`, `EventStreamFrame`, and `ApiV1RouteManifest`.

- [ ] **Step 1: Write failing tests for separate status dimensions and route stability**

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ApiErrorSchema,
  ApiV1RouteManifestSchema,
  CreateGenesisBrainDraftSchema,
  FormationExplanationSchema,
  FormationInquirySchema,
  ExchangeBrowserSessionResponseSchema,
  EventStreamFrameSchema,
  GenesisBrainReceiptSchema,
  HumanInventPromotionReceiptSchema,
  InventReceiptSchema,
  ProgramDirectionActivationReceiptSchema,
  PromoteHumanInventCandidateHttpRequestSchema,
  ActivateResearchAgendaHttpRequestSchema,
  SteerReceiptSchema,
  WritableBrainHeadRefSchema,
  WorkbenchBrainCatalogRequestSchema,
  WorkbenchBrainCatalogSchema,
  WorkbenchInventCommitRequestSchema,
  WorkbenchInventDraftSchema,
  WorkbenchMutationPreviewSchema,
  ProductStatusSchema,
  WorkbenchSteerCommitRequestSchema,
  WorkbenchSteerDraftSchema,
  WorkbenchSessionExchangeResponseSchema,
} from '@cosmo/product-contracts';
import {
  CreateGenesisBrainDraftSchema as CoreCreateGenesisBrainDraftSchema,
  GenesisBrainReceiptSchema as CoreGenesisBrainReceiptSchema,
} from '@cosmo/contracts';
import routeManifest from '../../fixtures/contracts/api-v1-route-manifest.json' with {
  type: 'json',
};

test('product status cannot collapse cognition into process health', () => {
  assert.throws(() => ProductStatusSchema.parse({
    schema: 'cosmo.product-status.v1',
    service: 'online',
  }));
});

test('the checked-in v1 route manifest satisfies the public schema', () => {
  const parsed = ApiV1RouteManifestSchema.parse(routeManifest);
  assert.equal(parsed.basePath, '/api/v1');
  assert.equal(parsed.routes.some((route) => route.path === '/inquiries'), true);
});

test('every route has a positive request and response fixture', () => {
  assert.equal(Object.keys(validRequestFixtures).length, 36);
  assert.equal(Object.keys(validResponseFixtures).length, 36);
  for (const route of routeManifest.routes) {
    const key = `${route.method} ${route.path}`;
    schemaRegistry[route.requestSchema].parse(validRequestFixtures[key]);
    schemaRegistry[route.responseSchema].parse(validResponseFixtures[key]);
  }
});

test('every request rejects unknown fields and mutations reject authority', () => {
  for (const route of routeManifest.routes) {
    const key = `${route.method} ${route.path}`;
    const requestSchema = schemaRegistry[route.requestSchema];
    const responseSchema = schemaRegistry[route.responseSchema];
    const request = validRequestFixtures[key];
    const response = validResponseFixtures[key];
    assert.throws(() => requestSchema.parse({
      ...request,
      unknownTransportField: true,
    }));
    assert.throws(() => responseSchema.parse({
      ...response,
      unknownResponseField: true,
    }));

    if (route.mutates && route.path !== '/session/exchange') {
      assert.throws(() => requestSchema.parse({
        ...request,
        body: {
          ...request.body,
          actorIdentity: sha256('forged actor'),
          capabilityGrantId: objectIdFixture,
          fencingToken: 'forged',
        },
      }));
    }
  }
});

test('API errors reject unknown top-level and nested fields', () => {
  const error = apiErrorFixture();
  assert.throws(() => ApiErrorSchema.parse({
    ...error,
    stack: 'must not cross the boundary',
  }));
  assert.throws(() => ApiErrorSchema.parse({
    ...error,
    error: {
      ...error.error,
      internalCause: 'must not cross the boundary',
    },
  }));
});

test('public SSE rejects raw payloads and private fields', () => {
  const frame = publicEventFrameFixture();
  assert.throws(() => EventStreamFrameSchema.parse({
    ...frame,
    data: { prompt: 'private prompt' },
  }));
  assert.throws(() => EventStreamFrameSchema.parse({
    ...frame,
    projection: {
      ...frame.projection,
      sourceExcerpt: 'restricted source bytes',
    },
  }));
});

test('session exchange response has one F-owned schema identity', () => {
  assert.equal(
    ExchangeBrowserSessionResponseSchema,
    WorkbenchSessionExchangeResponseSchema,
  );
});

test('genesis draft and receipt retain Program E schema identity', () => {
  assert.equal(
    CreateGenesisBrainDraftSchema,
    CoreCreateGenesisBrainDraftSchema,
  );
  assert.equal(GenesisBrainReceiptSchema, CoreGenesisBrainReceiptSchema);
  assert.equal(
    schemaRegistry.CreateGenesisBrainDraftSchema,
    CoreCreateGenesisBrainDraftSchema,
  );
  assert.equal(
    schemaRegistry.GenesisBrainReceiptSchema,
    CoreGenesisBrainReceiptSchema,
  );
});

test('public genesis draft cannot supply core mechanics or trust', () => {
  const draft = validRequestFixtures['POST /brains'].body;
  for (const [field, value] of [
    ['targetRef', 'refs/heads/forged'],
    ['expectedHead', null],
    ['rootRefs', []],
    ['lease', { fencingToken: 'forged' }],
    ['principalVersion', sha256('forged principal')],
    ['kernelVersion', sha256('forged kernel')],
    ['trust', { sensitivity: 'public' }],
    ['genesisScope', { kind: 'genesis' }],
  ] as const) {
    assert.throws(() => CreateGenesisBrainDraftSchema.parse({
      ...draft,
      [field]: value,
    }));
  }
});

test('mutation drafts, preview, and commit requests retain Program F schema identity', () => {
  assert.equal(
    schemaRegistry.WorkbenchBrainCatalogRequestSchema,
    WorkbenchBrainCatalogRequestSchema,
  );
  assert.equal(
    schemaRegistry.WorkbenchBrainCatalogSchema,
    WorkbenchBrainCatalogSchema,
  );
  assert.equal(
    schemaRegistry.WorkbenchSteerDraftSchema,
    WorkbenchSteerDraftSchema,
  );
  assert.equal(
    schemaRegistry.WorkbenchInventDraftSchema,
    WorkbenchInventDraftSchema,
  );
  assert.equal(
    schemaRegistry.WorkbenchMutationPreviewSchema,
    WorkbenchMutationPreviewSchema,
  );
  assert.equal(
    schemaRegistry.WorkbenchSteerCommitRequestSchema,
    WorkbenchSteerCommitRequestSchema,
  );
  assert.equal(
    schemaRegistry.WorkbenchInventCommitRequestSchema,
    WorkbenchInventCommitRequestSchema,
  );
});

test('H fixtures preserve F candidate-only program Steer and human-only Invent', () => {
  const steer = SteerReceiptSchema.parse(
    validResponseFixtures['POST /steering'],
  );
  assert.notEqual(steer.candidateRef, null);
  assert.equal(steer.resultRef, steer.candidateRef);
  assert.equal(steer.targetRefAfterCommitId, steer.parentCommitId);
  assert.equal(steer.targetRefUnchanged, true);
  assert.throws(() => SteerReceiptSchema.parse({
    ...steer,
    targetRefUnchanged: false,
  }));

  const invent = validRequestFixtures['POST /inventions/previews'].body;
  assert.equal(invent.candidateFinding.origin, 'human');
  assert.throws(() => WorkbenchInventDraftSchema.parse({
    ...invent,
    candidateFinding: {
      ...invent.candidateFinding,
      origin: 'worker',
    },
  }));
});

test('formation and human Invent promotion retain Program F schema identity', () => {
  assert.equal(
    schemaRegistry.FormationInquirySchema,
    FormationInquirySchema,
  );
  assert.equal(
    schemaRegistry.FormationExplanationSchema,
    FormationExplanationSchema,
  );
  assert.equal(schemaRegistry.InventReceiptSchema, InventReceiptSchema);
  assert.equal(
    schemaRegistry.HumanInventPromotionReceiptSchema,
    HumanInventPromotionReceiptSchema,
  );
});

test('all public semantic write targets are writable heads', () => {
  const promotion = validRequestFixtures['POST /inventions/promotions'];
  const activation = validRequestFixtures['POST /research/agendas/activate'];
  assert.equal(
    WritableBrainHeadRefSchema.parse(
      promotion.body.inventReceipt.queriedRef,
    ),
    promotion.body.inventReceipt.queriedRef,
  );
  assert.equal(
    WritableBrainHeadRefSchema.parse(
      activation.body.steerReceipt.targetRef,
    ),
    activation.body.steerReceipt.targetRef,
  );
  for (const forbiddenRef of [
    'refs/tags/reviewed',
    'refs/settled/reviewed',
  ]) {
    assert.throws(() => PromoteHumanInventCandidateHttpRequestSchema.parse({
      ...promotion,
      body: {
        ...promotion.body,
        inventReceipt: {
          ...promotion.body.inventReceipt,
          queriedRef: forbiddenRef,
        },
      },
    }));
    assert.throws(() => ActivateResearchAgendaHttpRequestSchema.parse({
      ...activation,
      body: {
        ...activation.body,
        steerReceipt: {
          ...activation.body.steerReceipt,
          targetRef: forbiddenRef,
        },
      },
    }));
  }
});

```

- [ ] **Step 2: Run the focused test and verify the missing exports**

Run:

```bash
npm test -- tests/product/contracts.test.ts
```

Expected: FAIL because the run fails with an unresolvable workspace specifier (`ERR_MODULE_NOT_FOUND` for `@cosmo/product-contracts`) until implementation lands.

- [ ] **Step 3: Create the H-owned contract workspace and define the exact product status contract**

Create private ESM workspace `@cosmo/product-contracts` with a `./src/index.ts` development export, `tsc -p tsconfig.json` build, root-runner tests, and only `"@cosmo/contracts": "*"` as a COSMO dependency. It imports and re-exports the exact accepted Program B–F public domain schemas/types needed by API consumers, but never edits or redeclares them. In particular, `CreateGenesisBrainDraftSchema`, `GenesisBrainReceiptSchema`, and `WritableBrainHeadRefSchema` retain Program E object identity; `WorkbenchBrainCatalogRequestSchema`, `WorkbenchBrainCatalogSchema`, `FormationInquirySchema`, `FormationExplanationSchema`, `InventReceiptSchema`, and `HumanInventPromotionReceiptSchema` retain Program F object identity; `ClientScopeSchema` is an object-identity alias of F's `WorkbenchClientScopeSchema`; `ExchangeBrowserSessionResponseSchema` is an object-identity alias of F's `WorkbenchSessionExchangeResponseSchema`; and the Steer/Invent draft, preview, and commit schemas are direct object-identity re-exports of Program F. H defines only strict HTTP envelopes around those bodies and the two authority-free activation requests below. H-owned status, other transport, route-manifest, and error contracts are defined only here. The release builder alone rewrites the staged export to `./dist/index.js`.

```ts
export const LifecycleIdentitySchema = z.object({
  schema: z.literal('cosmo.lifecycle-identity.v1'),
  instanceId: z.string().regex(/^cosmo_[a-zA-Z0-9_-]+$/),
  startupNonceHash: Sha256Schema,
  pid: z.number().int().positive(),
  executablePathHash: Sha256Schema,
  releaseId: Sha256Schema,
  startedAt: z.string().datetime(),
}).strict();

export const ProductBlockerSchema = z.object({
  component: z.enum([
    'repository',
    'journal',
    'runtime',
    'research_program',
    'cognitive_lifecycle',
    'scheduler',
  ]),
  code: z.enum([
    'integrity_failure',
    'recovery_incomplete',
    'run_reconciliation_pending',
    'program_control_pending',
    'wake_delivery_pending',
    'operator_action_required',
  ]),
  retryable: z.boolean(),
}).strict();

export const ProductStatusSchema = z.object({
  schema: z.literal('cosmo.product-status.v1'),
  observedAt: z.string().datetime(),
  lifecycleIdentity: LifecycleIdentitySchema,
  service: z.enum(['starting', 'online', 'degraded', 'stopping', 'offline']),
  research: z.enum(['idle', 'active', 'paused', 'blocked', 'dormant']),
  cognition: z.enum([
    'unchanged',
    'candidate_only',
    'committed',
    'metabolizing',
    'wake_pending',
  ]),
  epistemic: z.enum([
    'verified',
    'valid_with_authorized_redactions',
    'degraded',
    'unknown',
  ]),
  pinnedBrainCommitId: BrainCommitIdSchema.nullable(),
  journalCursor: JournalCursorSchema,
  activeRunIds: z.array(RunIdSchema),
  completionDeliveryPendingRunIds: z.array(RunIdSchema),
  blockers: z.array(ProductBlockerSchema),
}).strict();
```

Declare `LifecycleIdentitySchema` before `ProductStatusSchema`; the reverse order creates a module-evaluation temporal-dead-zone failure. `completionDeliveryPendingRunIds` contains Program D runs with `status='completed' && completionDelivered===false`; it is not a synthetic runtime status.

- [ ] **Step 3B: Register the workspace in the root lockfile before any dependent test**

Run `npm install` at the repo root, then commit the registry change before any test that imports the new workspace:

```bash
npm install
git add package.json package-lock.json packages/product-contracts/package.json packages/product-contracts/tsconfig.json
git commit -m "chore(product-contracts): register workspace"
```

- [ ] **Step 4: Define authorization and operation contracts**

```ts
export const ClientScopeSchema = WorkbenchClientScopeSchema;
export type ClientScope = WorkbenchClientScope;

const ClientScopeOrder = new Map(
  WorkbenchClientScopeSchema.options.map((scope, index) => [scope, index]),
);
const CanonicalClientScopesSchema = z.array(ClientScopeSchema)
  .max(WorkbenchClientScopeSchema.options.length)
  .superRefine((scopes, context) => {
    const expected = [...new Set(scopes)].sort(
      (left, right) =>
        ClientScopeOrder.get(left)! - ClientScopeOrder.get(right)!,
    );
    if (
      expected.length !== scopes.length
      || expected.some((scope, index) => scope !== scopes[index])
    ) {
      context.addIssue({
        code: 'custom',
        message: 'client scopes must be unique and in Program F order',
      });
    }
  });

export const ApiPrincipalSchema = z.object({
  principalId: Sha256Schema,
  tokenId: Sha256Schema,
  scopes: CanonicalClientScopesSchema.refine(
    (scopes) => scopes.length >= 1,
    { message: 'an authenticated principal requires at least one scope' },
  ),
}).strict();

export const OperationReceiptSchema = z.object({
  schema: z.literal('cosmo.operation-receipt.v1'),
  operationId: z.string().regex(/^op_[a-zA-Z0-9_-]+$/),
  idempotencyKeyHash: Sha256Schema,
  requestObjectId: ObjectIdSchema,
  principalId: Sha256Schema,
  status: z.enum(['accepted', 'blocked', 'completed', 'failed']),
  resultRef: ObjectRefSchema.nullable(),
  blockReasons: z.array(z.enum([
    'authorization_denied',
    'stale_state',
    'operation_in_progress',
    'policy_blocked',
    'integrity_degraded',
    'operator_action_required',
  ])),
  journalCursor: JournalCursorSchema,
}).strict();

export const PublicApiErrorBodySchema = z.discriminatedUnion('code', [
  z.object({
    code: z.literal('INVALID_REQUEST'),
    message: z.literal('Request did not satisfy the public contract.'),
    retryable: z.literal(false),
    details: z.object({
      issues: z.array(z.object({
        path: z.array(z.string().min(1).max(128)).max(16),
        reason: z.enum(['missing', 'invalid_type', 'invalid_value', 'unknown_field']),
      }).strict()).max(100),
    }).strict(),
  }).strict(),
  z.object({
    code: z.literal('AUTHENTICATION_FAILED'),
    message: z.literal('Authentication failed.'),
    retryable: z.literal(false),
    details: z.object({
      reason: z.enum(['missing', 'invalid', 'expired', 'revoked']),
    }).strict(),
  }).strict(),
  z.object({
    code: z.literal('FORBIDDEN'),
    message: z.literal('The authenticated client lacks the required scope.'),
    retryable: z.literal(false),
    details: z.object({
      requiredScopes: CanonicalClientScopesSchema.refine(
        (scopes) => scopes.length >= 1,
        { message: 'at least one required scope is required' },
      ),
    }).strict(),
  }).strict(),
  z.object({
    code: z.literal('NOT_FOUND'),
    message: z.literal('The requested public resource was not found.'),
    retryable: z.literal(false),
    details: z.object({
      resource: z.enum([
        'brain',
        'research_program',
        'operation',
        'event_cursor',
        'mutation_preview',
      ]),
    }).strict(),
  }).strict(),
  z.object({
    code: z.literal('IDEMPOTENCY_KEY_REQUIRED'),
    message: z.literal('A valid Idempotency-Key is required.'),
    retryable: z.literal(false),
    details: z.object({ header: z.literal('Idempotency-Key') }).strict(),
  }).strict(),
  z.object({
    code: z.literal('IDEMPOTENCY_CONFLICT'),
    message: z.literal('The idempotency key is bound to a different request.'),
    retryable: z.literal(false),
    details: z.object({ conflict: z.literal('request_hash_mismatch') }).strict(),
  }).strict(),
  z.object({
    code: z.literal('STATE_CONFLICT'),
    message: z.literal('The requested operation conflicts with current state.'),
    retryable: z.literal(true),
    details: z.object({
      resource: z.enum(['brain_ref', 'research_program', 'lifecycle']),
      reason: z.enum([
        'expected_head_mismatch',
        'expected_status_mismatch',
        'expected_control_epoch_mismatch',
        'operation_in_progress',
      ]),
    }).strict(),
  }).strict(),
  z.object({
    code: z.literal('MUTATION_PREVIEW_INVALID'),
    message: z.literal('The reviewed mutation preview is no longer committable.'),
    retryable: z.literal(false),
    details: z.object({
      reason: z.enum([
        'kind_mismatch',
        'request_id_mismatch',
        'draft_hash_mismatch',
        'expected_head_mismatch',
        'preview_integrity_failure',
        'authority_changed',
        'principal_changed',
        'scopes_changed',
        'expired',
        'consumed',
        'lease_revalidation_failed',
        'claim_in_progress',
      ]),
    }).strict(),
  }).strict(),
  z.object({
    code: z.literal('RATE_LIMITED'),
    message: z.literal('The request rate limit was reached.'),
    retryable: z.literal(true),
    details: z.object({
      retryAfterMs: z.number().int().positive().max(86_400_000),
    }).strict(),
  }).strict(),
  z.object({
    code: z.literal('SERVICE_UNAVAILABLE'),
    message: z.literal('The service is temporarily unavailable.'),
    retryable: z.literal(true),
    details: z.object({
      retryAfterMs: z.number().int().positive().max(86_400_000),
    }).strict(),
  }).strict(),
  z.object({
    code: z.literal('INTERNAL'),
    message: z.literal('The request could not be completed.'),
    retryable: z.literal(false),
    details: z.object({ incidentId: Sha256Schema }).strict(),
  }).strict(),
]);

export const ApiErrorSchema = z.object({
  schema: z.literal('cosmo.api-error.v1'),
  error: PublicApiErrorBodySchema,
  requestId: z.string().regex(/^req_[A-Za-z0-9_-]+$/),
}).strict();

export type ApiError = z.infer<typeof ApiErrorSchema>;
```

- [ ] **Step 5: Define every authority-free public request and response DTO**

Program E's frozen `CreateGenesisBrainDraftSchema`, `GenesisBrainReceiptSchema`, and `WakeBriefingSchema` (Program E produces `WakeBriefing`/`WakeBriefingSchema`; Program F only reads it) and Program F's frozen public DTOs are reused unchanged: `WorkbenchBrainSummarySchema`, `InquiryExecutionInputSchema`, `InquiryAnswerSchema`, `WorkbenchSteerDraftSchema`, `WorkbenchInventDraftSchema`, `WorkbenchMutationPreviewSchema`, `WorkbenchSteerCommitRequestSchema`, `WorkbenchInventCommitRequestSchema`, `SteerReceiptSchema`, `InventReceiptSchema`, `CompareInputSchema`, `ComparisonResultSchema`, `FederatedInquiryInputSchema`, and `FederatedInquiryResultSchema`. `POST /brains` wraps only the exact authority-free genesis draft and returns the exact authority-free genesis receipt. In particular, `/steering/previews` and `/inventions/previews` accept only the exact authority-free drafts; `/steering` and `/inventions` accept only the exact four-field commit requests; none accepts internal `CreateGenesisBrainInput`, `SteerInput`, or `InventInput`.

Define strict product DTOs:

```ts
export interface ForkBrainRequest {
  branchName: string;
  purpose: string;
  covenantDifferenceObjectId: ObjectId | null;
  expectedHead: BrainCommitId;
}

export interface UnionBrainsRequest {
  targetBranchName: string;
  expectedHead: BrainCommitId;
  leftCommitId: BrainCommitId;
  rightCommitId: BrainCommitId;
  purpose: string;
}

export interface TagBrainRequest {
  tagName: string;
  expectedCurrentTagCommitId: BrainCommitId | null;
  rationale: string;
}

export interface SettleBrainRequest {
  branchName: string;
  settlementName: string;
  expectedHead: BrainCommitId;
  rationale: string;
}

export interface WakeBrainRequest {
  settledName: string;
  wakeBranchName: string;
  expectedWakeHead: BrainCommitId | null;
  rationale: string;
}

export interface ExportBrainRequest {
  commitId: BrainCommitId;
  format: 'cosmo_bundle_v1';
  includeRestricted: boolean;
  encryptionRecipientKeyId: Sha256 | null;
}

export interface ImportBrainRequest {
  bundleBase64: string;
  bundleSha256: Sha256;
  targetBranchName: string;
  expectedHead: BrainCommitId | null;
  decryptionKeyBindingId: Sha256 | null;
}

export interface CreateResearchProgramRequest {
  title: string;
  purpose: string;
  mode: ResearchProgramMode;
  branchName: string;
  covenantCommitId: BrainCommitId;
  startingBrainCommitId: BrainCommitId;
  seedQuestionIds: QuestionId[];
  stoppingCriteria: string[];
  honestBlockConditions: string[];
  budget: {
    maxTokens: number;
    maxToolCalls: number;
    maxRuntimeMs: number;
    maxCostUsd: number;
  };
}

export interface PromoteHumanInventCandidateRequest {
  inventReceipt: InventReceipt;
}

export interface ActivateResearchAgendaRequest {
  steerReceipt: SteerReceipt;
  honestBlockConditions: string[];
  budget: CreateResearchProgramRequest['budget'];
}

export interface StopLifecycleRequest {
  expectedInstanceId: string;
  expectedStartupNonceHash: Sha256;
  reason: 'operator' | 'upgrade' | 'clean_room_test';
}
```

Also define and export strict schemas/types for `NoRequest`, `CreateGenesisBrainHttpRequest`, `CommitPathRequest`, `ListBrainsHttpRequest`, `BrainStatusResponse`, `BrainLogRequest/Response`, `BrainDiffHttpRequest`, `ForkBrainHttpRequest`, `UnionBrainsHttpRequest`, `TagBrainHttpRequest`, `SettleBrainHttpRequest`, `WakeBrainHttpRequest`, `BrainExportResponse`, `ImportBrainResponse`, `CreateBrowserSessionCodeRequest/Response`, `ExchangeBrowserSessionRequest/Response`, `FormationHttpRequest`, `PromoteHumanInventCandidateHttpRequest`, `ActivateResearchAgendaHttpRequest`, `ResearchProgramPathRequest`, `ResearchProgramView`, `ProgramMutationRequest`, `EventStreamRequest`, and `StopLifecycleRequest`. Every `*HttpRequest` is a strict `{params, query, body}` envelope, so path/query/body validation is named in the manifest. H does not define a second genesis draft/receipt, Brain-list request/response, formation contract, Invent receipt, or human-promotion receipt; those routes wrap or transform into the exact accepted core contracts.

Freeze the transport-owned field shapes in `packages/product-contracts/src/api.ts`; imported Program B/F response/body schemas remain their sole definitions:

```ts
const EmptyHttpPartSchema = z.object({}).strict();
const RefNameComponentSchema = z.string()
  .regex(/^(?!\.{1,2}$)[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/);
const Base64PayloadSchema = z.string()
  .min(4)
  .max(64 * 1024 * 1024)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
const IdempotencyReasonSchema = z.string().trim().min(1).max(2_000);

const HttpRequestSchema = <
  P extends z.ZodType,
  Q extends z.ZodType,
  B extends z.ZodType,
>(params: P, query: Q, body: B) => z.object({
  params,
  query,
  body,
}).strict();

const CommitParamsSchema = z.object({
  commitId: BrainCommitIdSchema,
}).strict();

const ProgramParamsSchema = z.object({
  programId: ResearchProgramIdSchema,
}).strict();

export const NoRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
);

export const CreateGenesisBrainHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  CreateGenesisBrainDraftSchema,
);
export type CreateGenesisBrainHttpRequest =
  z.infer<typeof CreateGenesisBrainHttpRequestSchema>;

export const CommitPathRequestSchema = HttpRequestSchema(
  CommitParamsSchema,
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
);

const WorkbenchBrainCatalogQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  includeSettled: z.enum(['true', 'false']).default('false')
    .transform((value) => value === 'true'),
}).strict().transform((query) => WorkbenchBrainCatalogRequestSchema.parse({
  schema: 'cosmo.workbench-brain-catalog-request.v1',
  cursor: query.cursor ?? null,
  limit: query.limit,
  includeSettled: query.includeSettled,
}));

export const ListBrainsHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  WorkbenchBrainCatalogQuerySchema,
  EmptyHttpPartSchema,
);

export const BrainStatusResponseSchema = z.object({
  schema: z.literal('cosmo.brain-status-response.v1'),
  commitId: BrainCommitIdSchema,
  status: BrainStatusSchema,
  verification: VerificationReportSchema,
}).strict();

export const BrainLogRequestSchema = HttpRequestSchema(
  CommitParamsSchema,
  z.object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }).strict(),
  EmptyHttpPartSchema,
);

// H-owned public projection of the accepted-core BrainCommit. Program B's
// produced log interface is BrainLogPage { commits: BrainCommit[] }; no core
// package exports a "BrainLogEntry". Route handlers derive each entry from
// one BrainCommit in the page and never invent fields absent from the core
// commit payload.
export const PublicBrainLogEntrySchema = z.object({
  schema: z.literal('cosmo.public-brain-log-entry.v1'),
  commitId: BrainCommitIdSchema,
  parentCommitIds: z.array(BrainCommitIdSchema),
  createdAt: z.string().datetime(),
}).strict();

export const BrainLogResponseSchema = z.object({
  schema: z.literal('cosmo.brain-log-response.v1'),
  commitId: BrainCommitIdSchema,
  entries: z.array(PublicBrainLogEntrySchema).max(200),
  nextCursor: z.string().min(1).max(512).nullable(),
}).strict();

export const BrainDiffHttpRequestSchema = HttpRequestSchema(
  CommitParamsSchema,
  z.object({ rightCommitId: BrainCommitIdSchema }).strict(),
  EmptyHttpPartSchema,
);

export const ForkBrainRequestSchema = z.object({
  branchName: RefNameComponentSchema,
  purpose: z.string().trim().min(1).max(2_000),
  covenantDifferenceObjectId: ObjectIdSchema.nullable(),
  expectedHead: BrainCommitIdSchema,
}).strict();

export const UnionBrainsRequestSchema = z.object({
  targetBranchName: RefNameComponentSchema,
  expectedHead: BrainCommitIdSchema,
  leftCommitId: BrainCommitIdSchema,
  rightCommitId: BrainCommitIdSchema,
  purpose: z.string().trim().min(1).max(2_000),
}).strict();

export const TagBrainRequestSchema = z.object({
  tagName: RefNameComponentSchema,
  expectedCurrentTagCommitId: BrainCommitIdSchema.nullable(),
  rationale: IdempotencyReasonSchema,
}).strict();

export const SettleBrainRequestSchema = z.object({
  branchName: RefNameComponentSchema,
  settlementName: RefNameComponentSchema,
  expectedHead: BrainCommitIdSchema,
  rationale: IdempotencyReasonSchema,
}).strict();

export const WakeBrainRequestSchema = z.object({
  settledName: RefNameComponentSchema,
  wakeBranchName: RefNameComponentSchema,
  expectedWakeHead: BrainCommitIdSchema.nullable(),
  rationale: IdempotencyReasonSchema,
}).strict();

export const ForkBrainHttpRequestSchema = HttpRequestSchema(
  CommitParamsSchema,
  EmptyHttpPartSchema,
  ForkBrainRequestSchema,
).superRefine((request, context) => {
  if (request.params.commitId !== request.body.expectedHead) {
    context.addIssue({
      code: 'custom',
      path: ['body', 'expectedHead'],
      message: 'fork path commit must equal the reviewed expected head',
    });
  }
});
export const UnionBrainsHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  UnionBrainsRequestSchema,
);
export const TagBrainHttpRequestSchema = HttpRequestSchema(
  CommitParamsSchema,
  EmptyHttpPartSchema,
  TagBrainRequestSchema,
);
export const SettleBrainHttpRequestSchema = HttpRequestSchema(
  CommitParamsSchema,
  EmptyHttpPartSchema,
  SettleBrainRequestSchema,
).superRefine((request, context) => {
  if (request.params.commitId !== request.body.expectedHead) {
    context.addIssue({
      code: 'custom',
      path: ['body', 'expectedHead'],
      message: 'settle path commit must equal the reviewed expected head',
    });
  }
});
export const WakeBrainHttpRequestSchema = HttpRequestSchema(
  CommitParamsSchema,
  EmptyHttpPartSchema,
  WakeBrainRequestSchema,
);

export const ExportBrainRequestSchema = z.object({
  commitId: BrainCommitIdSchema,
  format: z.literal('cosmo_bundle_v1'),
  includeRestricted: z.boolean(),
  encryptionRecipientKeyId: Sha256Schema.nullable(),
}).strict().superRefine((request, context) => {
  if (request.includeRestricted && request.encryptionRecipientKeyId === null) {
    context.addIssue({
      code: 'custom',
      path: ['encryptionRecipientKeyId'],
      message: 'restricted export requires an encryption recipient',
    });
  }
});
export const ExportBrainHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  ExportBrainRequestSchema,
);
export const BrainExportResponseSchema = z.object({
  schema: z.literal('cosmo.brain-export-response.v1'),
  commitId: BrainCommitIdSchema,
  bundleBase64: Base64PayloadSchema,
  bundleSha256: Sha256Schema,
  encrypted: z.boolean(),
  encryptionRecipientKeyId: Sha256Schema.nullable(),
}).strict();

export const ImportBrainRequestSchema = z.object({
  bundleBase64: Base64PayloadSchema,
  bundleSha256: Sha256Schema,
  targetBranchName: RefNameComponentSchema,
  expectedHead: BrainCommitIdSchema.nullable(),
  decryptionKeyBindingId: Sha256Schema.nullable(),
}).strict();
export const ImportBrainHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  ImportBrainRequestSchema,
);
export const ImportBrainResponseSchema = z.object({
  schema: z.literal('cosmo.brain-import-response.v1'),
  importedCommitId: BrainCommitIdSchema,
  targetBranchName: RefNameComponentSchema,
  operation: OperationReceiptSchema,
}).strict();

export const CreateBrowserSessionCodeInputSchema = z.object({
  requestedScopes: CanonicalClientScopesSchema.refine(
    (scopes) => scopes.length >= 1 && !scopes.includes('admin'),
    {
      message:
        'at least one non-admin browser session scope is required',
    },
  ),
  returnPath: z.string().regex(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/),
}).strict();
export const CreateBrowserSessionCodeRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  CreateBrowserSessionCodeInputSchema,
);
export const CreateBrowserSessionCodeResponseSchema = z.object({
  schema: z.literal('cosmo.browser-session-code.v1'),
  exchangeCode: z.string().regex(/^exchange_[A-Za-z0-9_-]{32,128}$/),
  exchangePath: z.literal('/api/v1/session/exchange'),
  expiresAt: z.string().datetime(),
}).strict();

export const ExchangeBrowserSessionRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  z.object({
    exchangeCode: z.string().regex(/^exchange_[A-Za-z0-9_-]{32,128}$/),
  }).strict(),
);
export const ExchangeBrowserSessionResponseSchema =
  WorkbenchSessionExchangeResponseSchema;
export type ExchangeBrowserSessionResponse =
  WorkbenchSessionExchangeResponse;

export const InquiryHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  InquiryExecutionInputSchema,
);
export const FormationHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  FormationInquirySchema,
);
export const SteerPreviewHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  WorkbenchSteerDraftSchema,
);
export const SteerCommitHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  WorkbenchSteerCommitRequestSchema,
);
export const InventPreviewHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  WorkbenchInventDraftSchema,
);
export const InventCommitHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  WorkbenchInventCommitRequestSchema,
);
export const PromoteHumanInventCandidateRequestSchema = z.object({
  inventReceipt: InventReceiptSchema,
}).strict().superRefine((request, context) => {
  if (
    WritableBrainHeadRefSchema.safeParse(
      request.inventReceipt.queriedRef,
    ).success === false
  ) {
    context.addIssue({
      code: 'custom',
      path: ['inventReceipt', 'queriedRef'],
      message: 'human Invent promotion requires a writable canonical head',
    });
  }
});
export const PromoteHumanInventCandidateHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  PromoteHumanInventCandidateRequestSchema,
);
export const CompareHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  CompareInputSchema,
);
export const FederatedInquiryHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  FederatedInquiryInputSchema,
);

export const ResearchProgramBudgetRequestSchema = z.object({
  maxTokens: z.number().int().nonnegative(),
  maxToolCalls: z.number().int().nonnegative(),
  maxRuntimeMs: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative(),
}).strict();

export const ActivateResearchAgendaRequestSchema = z.object({
  steerReceipt: SteerReceiptSchema,
  honestBlockConditions: z.array(
    z.string().trim().min(1).max(1_000),
  ).min(1).max(100),
  budget: ResearchProgramBudgetRequestSchema,
}).strict().superRefine((request, context) => {
  const receipt = request.steerReceipt;
  if (
    receipt.programProposalObjectId === null
    || receipt.candidateRef === null
    || receipt.resultRef !== receipt.candidateRef
    || receipt.targetRefUnchanged !== true
    || receipt.targetRefAfterCommitId !== receipt.parentCommitId
  ) {
    context.addIssue({
      code: 'custom',
      path: ['steerReceipt'],
      message: 'agenda activation requires an exact candidate-only Program proposal receipt',
    });
  }
  if (WritableBrainHeadRefSchema.safeParse(receipt.targetRef).success === false) {
    context.addIssue({
      code: 'custom',
      path: ['steerReceipt', 'targetRef'],
      message: 'agenda activation requires a writable canonical head',
    });
  }
});
export const ActivateResearchAgendaHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  ActivateResearchAgendaRequestSchema,
);

export const PublicResearchProgramStatusSchema = ResearchProgramStatusSchema;

export const CreateResearchProgramRequestSchema = z.object({
  title: z.string().trim().min(1).max(500),
  purpose: z.string().trim().min(1).max(4_000),
  mode: ResearchProgramModeSchema,
  branchName: RefNameComponentSchema,
  covenantCommitId: BrainCommitIdSchema,
  startingBrainCommitId: BrainCommitIdSchema,
  seedQuestionIds: z.array(QuestionIdSchema).max(100),
  stoppingCriteria: z.array(
    z.string().trim().min(1).max(1_000),
  ).min(1).max(100),
  honestBlockConditions: z.array(
    z.string().trim().min(1).max(1_000),
  ).min(1).max(100),
  budget: ResearchProgramBudgetRequestSchema,
}).strict();
export const CreateResearchProgramHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  CreateResearchProgramRequestSchema,
);
export const ResearchProgramPathRequestSchema = HttpRequestSchema(
  ProgramParamsSchema,
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
);
export const ResearchProgramViewSchema = z.object({
  schema: z.literal('cosmo.research-program-view.v1'),
  programId: ResearchProgramIdSchema,
  programStateObjectId: ObjectIdSchema,
  title: z.string().min(1),
  mode: ResearchProgramModeSchema,
  status: PublicResearchProgramStatusSchema,
  controlEpoch: z.number().int().nonnegative(),
  purpose: z.string().min(1),
  branchName: RefNameComponentSchema,
  covenantCommitId: BrainCommitIdSchema,
  startingBrainCommitId: BrainCommitIdSchema,
  currentBrainCommitId: BrainCommitIdSchema,
  seedQuestionIds: z.array(QuestionIdSchema),
  stoppingCriteria: z.array(z.string().min(1)),
  honestBlockConditions: z.array(z.string().min(1)),
  blockedReasonCodes: z.array(z.string().min(1)),
  budget: ResearchProgramBudgetRequestSchema,
  nextWakeAt: z.string().datetime().nullable(),
  lifecycle: CognitiveLifecycleStateSchema,
  updatedAt: z.string().datetime(),
}).strict();
export const ProgramMutationInputSchema = z.object({
  expectedStatus: PublicResearchProgramStatusSchema,
  expectedControlEpoch: z.number().int().nonnegative(),
  reason: IdempotencyReasonSchema,
}).strict();
export const ProgramMutationRequestSchema = HttpRequestSchema(
  ProgramParamsSchema,
  EmptyHttpPartSchema,
  ProgramMutationInputSchema,
);
export const EventStreamRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  z.object({
    afterCursor: JournalCursorSchema.optional(),
  }).strict(),
  EmptyHttpPartSchema,
);
export const StopLifecycleHttpRequestSchema = HttpRequestSchema(
  EmptyHttpPartSchema,
  EmptyHttpPartSchema,
  z.object({
    expectedInstanceId: z.string().regex(/^cosmo_[A-Za-z0-9_-]+$/),
    expectedStartupNonceHash: Sha256Schema,
    reason: z.enum(['operator', 'upgrade', 'clean_room_test']),
  }).strict(),
);
```

Every schema above has a matching `z.infer` export. The schema registry also registers the exact imported Program E `CreateGenesisBrainDraftSchema`, `GenesisBrainReceiptSchema`, and `WritableBrainHeadRefSchema`; Program F request bodies `WorkbenchBrainCatalogRequestSchema`, `WorkbenchSteerDraftSchema`, `WorkbenchInventDraftSchema`, `WorkbenchSteerCommitRequestSchema`, `WorkbenchInventCommitRequestSchema`, and `FormationInquirySchema`; plus the exact responses `ProductStatusSchema`, `LifecycleIdentitySchema`, `WorkbenchBrainCatalogSchema`, `WorkbenchBrainSummarySchema`, `BrainDiffSchema`, `VerificationReportSchema`, `InquiryAnswerSchema`, `FormationExplanationSchema`, `WorkbenchMutationPreviewSchema`, `SteerReceiptSchema`, `InventReceiptSchema`, `HumanInventPromotionReceiptSchema`, `ProgramDirectionActivationReceiptSchema`, `ComparisonResultSchema`, `FederatedInquiryResultSchema`, `WakeBriefingSchema`, `OperationReceiptSchema`, and `EventStreamFrameSchema`. No route-local request or response approximation is permitted.

`ResearchProgramView.currentBrainCommitId` is materialized from the repository's pinned decoded read context and cross-checked against the Program root/state projection; it is never required inside a Program/Question/Relationship root payload or any bytes hashed into the enclosing child Brain commit. Likewise, D control input receives an expected already-existing commit pin derived by the server, never a caller-supplied enclosing child ID. H rejects any codec/root object that attempts that cyclic embedding.

`CreateResearchProgramRequestSchema.mode` is Program D's exact shared `ResearchProgramModeSchema`: `guided`, `blended`, `autonomous`, or `pure`. H performs no aliasing or remapping. The API rejects `pure` unless the service can establish Program D's causally isolated pure-mode preconditions, and it never silently downgrades pure to autonomous or upgrades guided/blended authority.

The session exchange handler places the opaque session secret in exactly one host-only cookie, always `HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=28800`; externally TLS-terminated mode additionally requires `Secure`, while explicit loopback HTTP mode omits only `Secure`. It returns only the strict response above. It never returns a bearer token, session secret, capability grant, or cookie value in JSON. The CSRF token is returned once in the exchange JSON, retained only in Workbench process memory, and bound to the hashed server-side session record; it is never stored in a second cookie or persistent browser storage. Later cookie-authenticated mutations require `X-COSMO-CSRF`, which the server compares in constant time with that session-bound token. The one-time code is consumed atomically before the cookie is emitted.

The Brain-operation DTO schemas explicitly reject `actorIdentity`, `capabilityGrantId`, `lease`, `fencingToken`, `branchEpoch`, `journalRange`, `targetTrustDomain`, internal `ForkRequest`, and internal `UnionRequest`. The service derives actor/grant from `ApiPrincipal`, obtains fresh leases/fences, derives safe ref names and journal range, and constructs the internal Program B request. Program F's strict draft and commit schemas reject those same privileged fields at every nested level. Each preview draft binds its `requestId` to preview idempotency before the server derives authority. A commit binds the same `requestId`, `previewId`, `draftHash`, and `expectedHead`; the server reloads rather than trusts the stored draft and preview, re-derives authority, and constructs the internal Program F input only after the two-phase checks pass. Human Invent promotion accepts the exact public `InventReceipt` but no review input, policy, Principal version, authority, lease, clock, or canonical-ref override. Agenda activation accepts the exact candidate-only Program-proposal `SteerReceipt` plus only the missing honest block conditions and bounded budget; title, purpose, mode, stopping rules, Questions, Covenant, canonical head/ref, candidate ref, and proposal identity are reloaded and cross-checked rather than caller-rewritten.

- [ ] **Step 6: Define the full literal checked-in `/api/v1` route manifest**

`fixtures/contracts/api-v1-route-manifest.json` is equivalent to this literal array; no prose-only route exists:

```ts
export const apiV1Routes = [
  { method: 'GET', path: '/status', requestSchema: 'NoRequestSchema', responseSchema: 'ProductStatusSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'GET', path: '/lifecycle/identity', requestSchema: 'NoRequestSchema', responseSchema: 'LifecycleIdentitySchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/session/exchange-codes', requestSchema: 'CreateBrowserSessionCodeRequestSchema', responseSchema: 'CreateBrowserSessionCodeResponseSchema', requiredScopes: ['admin'], mutates: true, idempotency: 'required', authMode: 'bearer_admin' },
  { method: 'POST', path: '/session/exchange', requestSchema: 'ExchangeBrowserSessionRequestSchema', responseSchema: 'ExchangeBrowserSessionResponseSchema', requiredScopes: [], mutates: true, idempotency: 'atomic_exchange', authMode: 'one_time_exchange_code' },
  { method: 'POST', path: '/brains', requestSchema: 'CreateGenesisBrainHttpRequestSchema', responseSchema: 'GenesisBrainReceiptSchema', requiredScopes: ['operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'GET', path: '/brains', requestSchema: 'ListBrainsHttpRequestSchema', responseSchema: 'WorkbenchBrainCatalogSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'GET', path: '/brains/:commitId', requestSchema: 'CommitPathRequestSchema', responseSchema: 'WorkbenchBrainSummarySchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'GET', path: '/brains/:commitId/status', requestSchema: 'CommitPathRequestSchema', responseSchema: 'BrainStatusResponseSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'GET', path: '/brains/:commitId/log', requestSchema: 'BrainLogRequestSchema', responseSchema: 'BrainLogResponseSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'GET', path: '/brains/:commitId/diff', requestSchema: 'BrainDiffHttpRequestSchema', responseSchema: 'BrainDiffSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'GET', path: '/brains/:commitId/verification', requestSchema: 'CommitPathRequestSchema', responseSchema: 'VerificationReportSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/brains/:commitId/fork', requestSchema: 'ForkBrainHttpRequestSchema', responseSchema: 'OperationReceiptSchema', requiredScopes: ['operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/brains/union', requestSchema: 'UnionBrainsHttpRequestSchema', responseSchema: 'OperationReceiptSchema', requiredScopes: ['operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/brains/:commitId/tags', requestSchema: 'TagBrainHttpRequestSchema', responseSchema: 'OperationReceiptSchema', requiredScopes: ['operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/brains/:commitId/settle', requestSchema: 'SettleBrainHttpRequestSchema', responseSchema: 'OperationReceiptSchema', requiredScopes: ['operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/brains/:commitId/wake', requestSchema: 'WakeBrainHttpRequestSchema', responseSchema: 'OperationReceiptSchema', requiredScopes: ['operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/brains/export', requestSchema: 'ExportBrainHttpRequestSchema', responseSchema: 'BrainExportResponseSchema', requiredScopes: ['export'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/brains/import', requestSchema: 'ImportBrainHttpRequestSchema', responseSchema: 'ImportBrainResponseSchema', requiredScopes: ['operate', 'export'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/inquiries', requestSchema: 'InquiryHttpRequestSchema', responseSchema: 'InquiryAnswerSchema', requiredScopes: ['query'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/formations', requestSchema: 'FormationHttpRequestSchema', responseSchema: 'FormationExplanationSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/steering/previews', requestSchema: 'SteerPreviewHttpRequestSchema', responseSchema: 'WorkbenchMutationPreviewSchema', requiredScopes: ['steer'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/steering', requestSchema: 'SteerCommitHttpRequestSchema', responseSchema: 'SteerReceiptSchema', requiredScopes: ['steer'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/inventions/previews', requestSchema: 'InventPreviewHttpRequestSchema', responseSchema: 'WorkbenchMutationPreviewSchema', requiredScopes: ['steer'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/inventions', requestSchema: 'InventCommitHttpRequestSchema', responseSchema: 'InventReceiptSchema', requiredScopes: ['steer'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/inventions/promotions', requestSchema: 'PromoteHumanInventCandidateHttpRequestSchema', responseSchema: 'HumanInventPromotionReceiptSchema', requiredScopes: ['steer', 'operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/comparisons', requestSchema: 'CompareHttpRequestSchema', responseSchema: 'ComparisonResultSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/federations', requestSchema: 'FederatedInquiryHttpRequestSchema', responseSchema: 'FederatedInquiryResultSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'GET', path: '/wake-briefings/:commitId', requestSchema: 'CommitPathRequestSchema', responseSchema: 'WakeBriefingSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/research/programs', requestSchema: 'CreateResearchProgramHttpRequestSchema', responseSchema: 'OperationReceiptSchema', requiredScopes: ['operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/research/agendas/activate', requestSchema: 'ActivateResearchAgendaHttpRequestSchema', responseSchema: 'ProgramDirectionActivationReceiptSchema', requiredScopes: ['operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'GET', path: '/research/programs/:programId', requestSchema: 'ResearchProgramPathRequestSchema', responseSchema: 'ResearchProgramViewSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/research/programs/:programId/pause', requestSchema: 'ProgramMutationRequestSchema', responseSchema: 'OperationReceiptSchema', requiredScopes: ['operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/research/programs/:programId/resume', requestSchema: 'ProgramMutationRequestSchema', responseSchema: 'OperationReceiptSchema', requiredScopes: ['operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/research/programs/:programId/cancel', requestSchema: 'ProgramMutationRequestSchema', responseSchema: 'OperationReceiptSchema', requiredScopes: ['operate'], mutates: true, idempotency: 'required', authMode: 'bearer_or_session' },
  { method: 'GET', path: '/events', requestSchema: 'EventStreamRequestSchema', responseSchema: 'EventStreamFrameSchema', requiredScopes: ['read'], mutates: false, idempotency: 'forbidden', authMode: 'bearer_or_session' },
  { method: 'POST', path: '/lifecycle/stop', requestSchema: 'StopLifecycleHttpRequestSchema', responseSchema: 'OperationReceiptSchema', requiredScopes: ['admin'], mutates: true, idempotency: 'required', authMode: 'bearer_admin' },
] as const;
```

The checked-in JSON is parsed through an exact manifest schema, not treated as documentation:

```ts
export const ApiV1RouteRecordSchema = z.object({
  method: z.enum(['GET', 'POST']),
  path: z.string().regex(/^\/[A-Za-z0-9:_/-]+$/),
  requestSchema: z.string().regex(/^[A-Z][A-Za-z0-9]+Schema$/),
  responseSchema: z.string().regex(/^[A-Z][A-Za-z0-9]+Schema$/),
  requiredScopes: CanonicalClientScopesSchema,
  mutates: z.boolean(),
  idempotency: z.enum(['forbidden', 'required', 'atomic_exchange']),
  authMode: z.enum([
    'bearer_or_session',
    'bearer_admin',
    'one_time_exchange_code',
  ]),
}).strict();

export const ApiV1RouteManifestSchema = z.object({
  schema: z.literal('cosmo.api-route-manifest.v1'),
  basePath: z.literal('/api/v1'),
  routes: z.array(ApiV1RouteRecordSchema).length(36),
}).strict().superRefine((manifest, ctx) => {
  const identities = new Set<string>();

  for (const [index, route] of manifest.routes.entries()) {
    const identity = `${route.method} ${route.path}`;
    if (identities.has(identity)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routes', index],
        message: `duplicate route: ${identity}`,
      });
    }
    identities.add(identity);

    const isExchange =
      route.method === 'POST' && route.path === '/session/exchange';

    if (isExchange) {
      if (
        route.authMode !== 'one_time_exchange_code'
        || route.idempotency !== 'atomic_exchange'
        || route.requiredScopes.length !== 0
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['routes', index],
          message: 'session exchange must use its sole atomic exception',
        });
      }
      continue;
    }

    if (
      route.authMode === 'one_time_exchange_code'
      || route.idempotency === 'atomic_exchange'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routes', index],
        message: 'atomic exchange policy is exclusive to POST /session/exchange',
      });
    }

    if (
      route.mutates
      && (
        route.idempotency !== 'required'
        || route.requiredScopes.length === 0
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routes', index],
        message: 'ordinary mutations require idempotency and at least one scope',
      });
    }

    if (!route.mutates && route.idempotency !== 'forbidden') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routes', index],
        message: 'nonmutating routes forbid idempotency keys',
      });
    }
  }
});

export const apiV1RouteManifest = ApiV1RouteManifestSchema.parse({
  schema: 'cosmo.api-route-manifest.v1',
  basePath: '/api/v1',
  routes: apiV1Routes,
});
```

`POST /session/exchange` is the sole exception to “every mutation requires bearer/session authentication and an `Idempotency-Key`.” Its one-time code is itself the atomic, expiring, single-use idempotency key; the server consumes it and creates the session in one compare-and-swap transaction. It accepts neither bearer/session auth nor CSRF, and every replay fails. No other route may use `authMode='one_time_exchange_code'` or `idempotency='atomic_exchange'`.

- [ ] **Step 7: Add the SSE frame and structured error contracts**

```ts
export const PublicEventProjectionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('research_program'),
    programId: ResearchProgramIdSchema,
    status: ResearchProgramStatusSchema,
    controlEpoch: z.number().int().nonnegative(),
    action: z.enum([
      'create',
      'pause',
      'resume',
      'cancel',
      'propose_settlement',
      'finalize_transition',
    ]),
  }).strict(),
  z.object({
    kind: z.literal('research_run'),
    programId: ResearchProgramIdSchema,
    runId: RunIdSchema,
    status: z.enum([
      'authorized', 'running', 'paused', 'completed', 'failed', 'cancelled',
    ]),
  }).strict(),
  z.object({
    kind: z.literal('brain'),
    commitId: BrainCommitIdSchema,
    change: z.enum(['advanced', 'forked', 'unioned', 'tagged', 'settled', 'woken']),
  }).strict(),
  z.object({
    kind: z.literal('operation'),
    operationId: z.string().regex(/^op_[A-Za-z0-9_-]+$/),
    status: z.enum(['accepted', 'blocked', 'completed', 'failed']),
  }).strict(),
  z.object({
    kind: z.literal('cognitive_lifecycle'),
    programId: ResearchProgramIdSchema,
    outcome: z.enum([
      'initialized',
      'wake_committed',
      'control_converged',
      'settled',
      'blocked',
    ]),
  }).strict(),
  z.object({
    kind: z.literal('integrity'),
    state: z.enum(['verified', 'degraded', 'corrupt']),
  }).strict(),
]);

export const EventStreamFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('event'),
    cursor: JournalCursorSchema,
    eventObjectId: ObjectIdSchema,
    projection: PublicEventProjectionSchema,
  }).strict(),
  z.object({
    type: z.literal('heartbeat'),
    cursor: JournalCursorSchema,
    observedAt: z.string().datetime(),
  }).strict(),
  z.object({
    type: z.literal('reset_required'),
    earliestAvailableCursor: JournalCursorSchema,
    reason: z.enum([
      'cursor_expired',
      'cursor_unknown',
      'retention_boundary',
    ]),
  }).strict(),
]);
```

The `research_run` status members are Program D's frozen `RuntimeRunState.status` values verbatim; the total mapping for the D statuses not surfaced is: `pausing` projects as `running`, `resuming` projects as `paused`, and `lost` projects as `failed`. `wake_committed` and `control_converged` are H's public names for Program E's wake-commit and control-convergence settlement outcomes (Program E program-control/wake stages); the H projection maps them one-to-one from the E lifecycle engine's typed outcomes and surfaces no other lifecycle values. The SSE contract contains no arbitrary `data`, summary text, prompt, source locator, source excerpt, artifact body, provider payload, grant, lease, fence, token, filesystem path, or private trust descriptor. `EventReadPort` authorizes the principal against the underlying event before mapping it to one closed projection. Unknown internal event types are not serialized; clients discover the durable state through the relevant read route instead.

- [ ] **Step 8: Run focused and contract tests**

Run:

```bash
npm test -- tests/product/contracts.test.ts
npm run test:contracts
```

Expected: PASS; all 36 positive request/response fixture pairs parse, every unknown or privileged field is rejected, pagination/cursor bounds hold, session JSON contains no bearer/session secret, every literal route has a registered schema and handler, the Program E genesis route, Program F formation and reviewed-human-promotion routes, the agenda-activation route, and four Program F preview/commit routes retain exact schema identity, and every mutating route except the one-time atomic session exchange requires authentication, scopes, CSRF when cookie-authenticated, and an idempotency key.

- [ ] **Step 9: Commit the frozen transport contract**

```bash
git add package-lock.json packages/product-contracts tests/product/contracts.test.ts fixtures/contracts/api-v1-route-manifest.json fixtures/contracts/api-v1-route-fixtures.json
git commit -m "feat(product): freeze standalone public contracts"
```

---

### Task 2: Implement Token, Origin, Scope, and Browser-Session Security

**Files:**
- Modify: `package-lock.json`
- Create: `packages/api/package.json`
- Create: `packages/api/tsconfig.json`
- Create: `packages/api/src/auth/bearer-token.ts`
- Create: `packages/api/src/auth/origin-policy.ts`
- Create: `packages/api/src/auth/scope-guard.ts`
- Create: `packages/api/src/auth/browser-session.ts`
- Create: `tests/api/auth.test.ts`
- Create: `docs/operations/security.md`

**Interfaces:**
- Consumes: `ApiPrincipal`, `ClientScope`, injected `Clock`, injected `RandomBytes`, and an atomic private-file port from `@cosmo/foundation`.
- Produces: `BearerTokenStore`, `OriginPolicy`, `authorizeScopes()`, `BrowserSessionStore`, and one-time exchange codes.

- [ ] **Step 1: Write failing security-boundary tests**

```ts
test('bootstrap stores only a salted token hash', async () => {
  const issued = await store.issue(['read', 'query']);
  const persisted = JSON.stringify(await files.readJson('auth/tokens.json'));
  assert.equal(persisted.includes(issued.plaintextToken), false);
  assert.equal(await store.authenticate(issued.plaintextToken) !== null, true);
});

test('one-time browser code cannot be replayed', async () => {
  const code = await sessions.issueExchangeCode({
    principal: owner,
    requestedScopes: ['read', 'query'],
    returnPath: '/',
  });
  const exchanged = await sessions.exchange(code);
  assert.equal(exchanged.principalId, owner.principalId);
  assert.deepEqual(exchanged.scopes, ['read', 'query']);
  await assert.rejects(() => sessions.exchange(code), /already used/);
});

test('browser exchange cannot elevate or retain admin scope', async () => {
  await assert.rejects(
    () => sessions.issueExchangeCode({
      principal: owner,
      requestedScopes: ['read', 'admin'],
      returnPath: '/',
    }),
    /browser scope/,
  );
  await assert.rejects(
    () => sessions.issueExchangeCode({
      principal: readOnlyPrincipal,
      requestedScopes: ['read', 'steer'],
      returnPath: '/',
    }),
    /scope escalation/,
  );
});

test('non-loopback origin is denied unless exactly allowlisted', () => {
  assert.equal(policy.allows('https://research.example', false), false);
  assert.equal(policy.allows('https://research.example', true), true);
  assert.equal(policy.allows('https://lookalike.example', true), false);
});
```

- [ ] **Step 2: Verify the focused test fails**

Run:

```bash
npm test -- tests/api/auth.test.ts
```

Expected: FAIL because the run fails with an unresolvable workspace specifier (`ERR_MODULE_NOT_FOUND` for `@cosmo/api`) until implementation lands.

- [ ] **Step 3: Create the API workspace and implement bearer-token issuance**

Create private ESM workspace `@cosmo/api` with a `./src/index.ts` development export, `tsc -p tsconfig.json` build, and root-runner tests. Its initial COSMO dependencies are `"@cosmo/product-contracts": "*"` and `"@cosmo/foundation": "*"`. Task 3 adds Fastify and the remaining public service-port packages without changing this boundary.

Use 32 random bytes encoded as base64url with the `cosmo_` prefix. Persist only:

```ts
interface StoredTokenRecord {
  tokenId: Sha256;
  principalId: Sha256;
  salt: string;
  scryptHash: string;
  scopes: ClientScope[];
  createdAt: string;
  revokedAt: string | null;
}
```

Derive hashes with `scrypt` using `N=16384`, `r=8`, `p=1`, compare with `timingSafeEqual`, write `auth/tokens.json` atomically with mode `0600`, and return plaintext only from the issuance call.

- [ ] **Step 3B: Register the workspace in the root lockfile before any dependent test**

Run `npm install` at the repo root, then commit the registry change before any test that imports the new workspace:

```bash
npm install
git add package.json package-lock.json packages/api/package.json packages/api/tsconfig.json
git commit -m "chore(api): register workspace"
```

- [ ] **Step 4: Implement exact scope and origin enforcement**

`authorizeScopes(principal, required)` requires every declared route scope. Requests with an `Origin` header must match loopback same-origin or one exact configured HTTPS origin. Wildcards, suffix matching, reflected origins, and credentialed cross-origin access are rejected.

- [ ] **Step 5: Implement browser exchange and CSRF**

An authenticated, admin-scoped `POST /api/v1/session/exchange-codes` returns a 256-bit, 60-second, single-use code to `cosmo open`. The code record is immutably bound to the issuing principal, the exact canonically ordered requested scopes, and the validated return path. Requested scopes must be a subset of the issuing principal's scopes and must not contain `admin`; exchange returns exactly that bound principal and scope set, never the issuer's full scope set or a caller-supplied replacement. The response is marked `Cache-Control: no-store` and redacted from logs. The CLI opens:

```text
http://127.0.0.1:<port>/#/connect/<base64url-code>
```

The fragment is not transmitted in the HTTP request. Program F JavaScript posts the code to `/api/v1/session/exchange`; the API returns:

```text
Set-Cookie: cosmo_session=<opaque>; HttpOnly; SameSite=Strict; Path=/api/v1; Max-Age=28800
```

The session exchange JSON contains the CSRF token once; Program F holds it only in Workbench process memory. The server binds its hash to the hashed session ID. All cookie-authenticated mutations require `X-COSMO-CSRF`, which must constant-time match the server-side session binding. There is no CSRF cookie and no local/session-storage copy. The session cookie is host-only. Explicit loopback HTTP mode omits `Secure`; any externally TLS-terminated mode adds `Secure` and rejects exchange over a non-TLS forwarded origin. Exchange codes and session IDs are stored only as hashes. Authentication headers, cookies, exchange codes, and CSRF values are redacted before logging.

- [ ] **Step 6: Document local and remote security behavior**

Document loopback default, token rotation/revocation, file permissions, one-time browser launch, origin policy, TLS requirement for non-loopback use, and the fact that model prompts cannot grant client authority.

- [ ] **Step 7: Run security and API contract tests**

Run:

```bash
npm test -- tests/api/auth.test.ts tests/product/contracts.test.ts
```

Expected: PASS, including expiry, replay, browser-scope binding and elevation rejection, revoked-token, missing-scope, CSRF, log-redaction, and origin-confusion cases.

- [ ] **Step 8: Commit the security boundary**

```bash
git add package-lock.json packages/api/package.json packages/api/tsconfig.json packages/api/src/auth tests/api/auth.test.ts docs/operations/security.md
git commit -m "feat(api): enforce standalone client security"
```

---

### Task 3: Build the Versioned HTTP and SSE API

**Files:**
- Modify: `package-lock.json`
- Modify: `packages/api/package.json`
- Create: `packages/api/src/errors.ts`
- Create: `packages/api/src/idempotency.ts`
- Create: `packages/api/src/mutation-preview.ts`
- Create: `packages/api/src/ports.ts`
- Create: `packages/api/src/sse.ts`
- Create: `packages/api/src/routes/status.ts`
- Create: `packages/api/src/routes/brains.ts`
- Create: `packages/api/src/routes/inquiry.ts`
- Create: `packages/api/src/routes/research.ts`
- Create: `packages/api/src/routes/events.ts`
- Create: `packages/api/src/routes/lifecycle.ts`
- Create: `packages/api/src/server.ts`
- Create: `packages/api/src/index.ts`
- Create: `tests/api/routes.test.ts`
- Create: `tests/api/mutation-preview.test.ts`
- Create: `tests/api/sse.test.ts`
- Create: `docs/architecture/public-api.md`

**Interfaces:**
- Consumes: the Task 1 manifest and schema registry; narrow service ports `StatusPort`, `BrainReadPort`, `BrainOperationPort`, `InquiryPort`, `WorkbenchMutationPort`, `ResearchPort`, `EventReadPort`, and `LifecyclePort`; Program D's exact `CognitiveLineageEventScope`, `AdmitHumanOperationEventInput`, `AdmissionDecision`, `CreateResearchProgramInputSchema`, `ResearchProgramControlInputSchema`, `ResearchProgramDirectionProposalSchema`, and `ResearchProgramService`; Program E's exact `GenesisBrainService`, `CreateGenesisBrainDraft`, `CreateGenesisBrainInput`, `CreateGenesisBrainInputSchema`, `GenesisBrainReceipt`, `GenesisBrainReceiptSchema`, and `WritableBrainHeadRefSchema`; and Program F's exact exported `MutationRequester`, `MutationServiceContext`, `PreviewSteerInput`, `PreviewInventInput`, `ConsumeSteerInput`, `ConsumeInventInput`, `MutationPreviewService`, `PromoteHumanInventCandidateInput`, `HumanInventPromotionService`, `ActivateProgramDirectionCandidateInput`, `ProgramDirectionActivationReceipt`, `ProgramDirectionActivationService`, `FormationInquiry`, `FormationExplanation`, and matching strict schemas. `BrainOperationPort.createGenesis()` and `WorkbenchMutationPort` are H transport adapters over those core services, not H implementations of genesis, preview, formation, review, promotion, or agenda activation semantics. Research transport remains scope-free; the service-only `BrainMutationScopeResolver` and `HumanOperationAdmissionPort` derive/admit the exact D scope before a D mutation input exists.
- Produces: `buildCosmoApi()`, the `/api/v1` handlers, `IdempotencyStore`, the schema/error-safe Program F mutation transport adapter, and resumable SSE.

- [ ] **Step 1: Add the transport dependency to the existing API workspace**

Retain the Task 2 private ESM `@cosmo/api` package and add every newly consumed public COSMO package with `"*"`, including `@cosmo/product-contracts`, plus Fastify major `"5"`. No API source imports an H client, repository implementation path, or Program E implementation path. Program H's release builder later rewrites only the staged archive copy to `./dist/index.js`.

Run:

```bash
npm install --workspace @cosmo/api fastify@5
```

Expected: the exact resolved Fastify version is recorded in `package-lock.json`; no Home23 package or process library is introduced. Commit the lockfile change immediately so it is committed before later steps run tests:

```bash
git add packages/api/package.json package-lock.json && git commit -m "chore(api): pin fastify"
```

- [ ] **Step 2: Write failing route-boundary tests**

Freeze these exact API-to-service ports first in `packages/api/src/ports.ts`. Every method accepts one closed named input; handlers may not reach around these ports to a repository, Program D/E implementation, auth store, or process primitive:

```ts
export interface AuthenticatedCallContext {
  requestId: string;
  principal: ApiPrincipal;
  observedAt: string;
}

export interface MutationCallContext extends AuthenticatedCallContext {
  idempotencyKey: string;
  requestObjectId: ObjectId;
  domainIdempotencyKey: Sha256;
}

export interface BrowserSessionExchangeCallContext {
  requestId: string;
  observedAt: string;
  secureCookie: boolean;
}

export interface BrowserSessionExchangeResult {
  response: WorkbenchSessionExchangeResponse;
  cookie: {
    name: 'cosmo_session';
    opaqueValue: string;
    httpOnly: true;
    sameSite: 'Strict';
    path: '/api/v1';
    maxAgeSeconds: 28_800;
    secure: boolean;
  };
}

export interface StatusPort {
  read(input: {
    context: AuthenticatedCallContext;
  }): Promise<ProductStatus>;
}

export interface BrainReadPort {
  list(input: {
    request: WorkbenchBrainCatalogRequest;
    context: AuthenticatedCallContext;
  }): Promise<WorkbenchBrainCatalog>;
  get(input: {
    commitId: BrainCommitId;
    context: AuthenticatedCallContext;
  }): Promise<WorkbenchBrainSummary>;
  status(input: {
    commitId: BrainCommitId;
    context: AuthenticatedCallContext;
  }): Promise<BrainStatusResponse>;
  log(input: {
    commitId: BrainCommitId;
    cursor: string | null;
    limit: number;
    context: AuthenticatedCallContext;
  }): Promise<BrainLogResponse>;
  diff(input: {
    leftCommitId: BrainCommitId;
    rightCommitId: BrainCommitId;
    context: AuthenticatedCallContext;
  }): Promise<BrainDiff>;
  verify(input: {
    commitId: BrainCommitId;
    context: AuthenticatedCallContext;
  }): Promise<VerificationReport>;
  export(input: {
    request: ExportBrainRequest;
    context: AuthenticatedCallContext;
  }): Promise<BrainExportResponse>;
}

export interface BrainOperationPort {
  createGenesis(input: {
    draft: CreateGenesisBrainDraft;
    context: MutationCallContext;
  }): Promise<GenesisBrainReceipt>;
  fork(input: {
    pathCommitId: BrainCommitId;
    request: ForkBrainRequest;
    context: MutationCallContext;
  }): Promise<OperationReceipt>;
  union(input: {
    request: UnionBrainsRequest;
    context: MutationCallContext;
  }): Promise<OperationReceipt>;
  tag(input: {
    pathCommitId: BrainCommitId;
    request: TagBrainRequest;
    context: MutationCallContext;
  }): Promise<OperationReceipt>;
  settle(input: {
    pathCommitId: BrainCommitId;
    request: SettleBrainRequest;
    context: MutationCallContext;
  }): Promise<OperationReceipt>;
  wake(input: {
    pathCommitId: BrainCommitId;
    request: WakeBrainRequest;
    context: MutationCallContext;
  }): Promise<OperationReceipt>;
  import(input: {
    request: ImportBrainRequest;
    context: MutationCallContext;
  }): Promise<ImportBrainResponse>;
}

export interface InquiryPort {
  ask(input: {
    request: InquiryExecutionInput;
    context: AuthenticatedCallContext;
  }): Promise<InquiryAnswer>;
  explainFormation(input: {
    request: FormationInquiry;
    context: AuthenticatedCallContext;
  }): Promise<FormationExplanation>;
  compare(input: {
    request: CompareInput;
    context: AuthenticatedCallContext;
  }): Promise<ComparisonResult>;
  federate(input: {
    request: FederatedInquiryInput;
    context: AuthenticatedCallContext;
  }): Promise<FederatedInquiryResult>;
  wakeBriefing(input: {
    commitId: BrainCommitId;
    context: AuthenticatedCallContext;
  }): Promise<WakeBriefing>;
}

export interface WorkbenchMutationPort {
  previewSteer(input: {
    draft: WorkbenchSteerDraft;
    context: MutationCallContext;
  }): Promise<WorkbenchMutationPreview>;
  commitSteer(input: {
    request: WorkbenchSteerCommitRequest;
    context: MutationCallContext;
  }): Promise<SteerReceipt>;
  previewInvent(input: {
    draft: WorkbenchInventDraft;
    context: MutationCallContext;
  }): Promise<WorkbenchMutationPreview>;
  commitInvent(input: {
    request: WorkbenchInventCommitRequest;
    context: MutationCallContext;
  }): Promise<InventReceipt>;
  promoteHumanInvent(input: {
    request: PromoteHumanInventCandidateRequest;
    context: MutationCallContext;
  }): Promise<HumanInventPromotionReceipt>;
}

export interface MutationAuthorityResolver {
  resolve(input: {
    principal: ApiPrincipal;
    requiredScope: 'steer' | 'operate';
    requestObjectId: ObjectId;
  }): Promise<MutationAuthorization>;
}

export interface HumanInventPromotionInputResolver {
  resolve(input: {
    inventReceipt: InventReceipt;
    context: MutationCallContext;
  }): Promise<PromoteHumanInventCandidateInput>;
}

export interface ProgramDirectionActivationInputResolver {
  resolve(input: {
    request: ActivateResearchAgendaRequest;
    context: MutationCallContext;
  }): Promise<ActivateProgramDirectionCandidateInput>;
}

export type BrainMutationScopeResolution =
  | {
      kind: 'program_create';
      targetRef: WritableBrainHeadRef;
      brainCommitId: BrainCommitId;
      programId: ResearchProgramId;
      programRootRef: ObjectRef;
      programStateObjectId: null;
      programStatus: null;
      controlEpoch: null;
      eventScope: CognitiveLineageEventScope;
      effectiveTrust: TrustDescriptor;
    }
  | {
      kind: 'program_control';
      targetRef: WritableBrainHeadRef;
      brainCommitId: BrainCommitId;
      programId: ResearchProgramId;
      programRootRef: ObjectRef;
      programStateObjectId: ObjectId;
      programStatus: ResearchProgramStatus;
      controlEpoch: number;
      eventScope: CognitiveLineageEventScope;
      effectiveTrust: TrustDescriptor;
    };

export interface BrainMutationScopeResolver {
  resolveCreate(input: {
    targetRef: WritableBrainHeadRef;
    expectedBrainCommitId: BrainCommitId;
    programId: ResearchProgramId;
    requestObjectId: ObjectId;
    authorization: MutationAuthorization;
    operationId: Sha256;
    observedAt: string;
  }): Promise<Extract<
    BrainMutationScopeResolution,
    { kind: 'program_create' }
  >>;
  resolveControl(input: {
    programId: ResearchProgramId;
    expectedStatus: ResearchProgramStatus;
    expectedControlEpoch: number;
    requestObjectId: ObjectId;
    authorization: MutationAuthorization;
    operationId: Sha256;
    observedAt: string;
  }): Promise<Extract<
    BrainMutationScopeResolution,
    { kind: 'program_control' }
  >>;
}

export interface HumanOperationAdmissionPort {
  admit(input: {
    operationKind:
      | 'program_create'
      | 'program_agenda_activation'
      | 'program_pause'
      | 'program_resume'
      | 'program_cancel';
    operationId: Sha256;
    principalId: Sha256;
    requestObjectId: ObjectId;
    scope: CognitiveLineageEventScope;
    authorization: MutationAuthorization;
    admittedAt: string;
  }): Promise<AdmissionDecision>;
}

export interface ResearchPort {
  create(input: {
    request: CreateResearchProgramRequest;
    context: MutationCallContext;
  }): Promise<OperationReceipt>;
  activateAgenda(input: {
    request: ActivateResearchAgendaRequest;
    context: MutationCallContext;
  }): Promise<ProgramDirectionActivationReceipt>;
  get(input: {
    programId: ResearchProgramId;
    context: AuthenticatedCallContext;
  }): Promise<ResearchProgramView>;
  pause(input: {
    programId: ResearchProgramId;
    request: ProgramMutationInput;
    context: MutationCallContext;
  }): Promise<OperationReceipt>;
  resume(input: {
    programId: ResearchProgramId;
    request: ProgramMutationInput;
    context: MutationCallContext;
  }): Promise<OperationReceipt>;
  cancel(input: {
    programId: ResearchProgramId;
    request: ProgramMutationInput;
    context: MutationCallContext;
  }): Promise<OperationReceipt>;
}

export interface EventReadPort {
  stream(input: {
    afterCursor: JournalCursor | null;
    context: AuthenticatedCallContext;
  }): AsyncIterable<EventStreamFrame>;
}

export interface LifecyclePort {
  identity(input: {
    context: AuthenticatedCallContext;
  }): Promise<LifecycleIdentity>;
  issueBrowserSessionCode(input: {
    request: CreateBrowserSessionCodeInput;
    context: MutationCallContext;
  }): Promise<CreateBrowserSessionCodeResponse>;
  exchangeBrowserSession(input: {
    exchangeCode: string;
    context: BrowserSessionExchangeCallContext;
  }): Promise<BrowserSessionExchangeResult>;
  stop(input: {
    request: StopLifecycleRequest;
    context: MutationCallContext;
  }): Promise<OperationReceipt>;
}

export interface CosmoApiPorts {
  status: StatusPort;
  brainRead: BrainReadPort;
  brainOperation: BrainOperationPort;
  inquiry: InquiryPort;
  workbenchMutation: WorkbenchMutationPort;
  research: ResearchPort;
  eventRead: EventReadPort;
  lifecycle: LifecyclePort;
}
```

`AuthenticatedCallContext` is constructed only after bearer/session authentication, origin policy, scope checks, and CSRF where required. `MutationCallContext.idempotencyKey` is the already syntax-validated request header, not a client authority field. The one-time exchange route is the only route that constructs `BrowserSessionExchangeCallContext`; its opaque cookie value is consumed only by the response-cookie serializer and is redacted before every log/error path.

`MutationCallContext.requestObjectId` is the Program A canonical object ID of the already parsed route request. `domainIdempotencyKey` is the SHA-256 identity assigned to the outer H idempotency record over exactly `{principalId, keyHash, requestObjectId}`; both are middleware outputs and are never accepted from params/query/body. The same principal/key/request retry reproduces both values byte-for-byte.

`BrainMutationScopeResolver` and `HumanOperationAdmissionPort` are server-only
authority boundaries, not product DTOs or client methods. The resolver receives
only the authenticated authorization, canonical request identity, stable
domain operation ID, and expected public pins. For create it acquires and
rereads the named target ref, verifies/materializes the exact nine-root head,
derives the Program-root ref, target lineage, program binding, and effective
trust. For control it loads the canonical Program entry/state plus its
repository head/root context and verifies status/epoch. In both cases it returns
one exact D `CognitiveLineageEventScope` whose `basedOnBrainCommitId`,
`targetRef`, `programId`, `lineageId`, and `trustDomain` are derived from that
verified state; `trustDomain === effectiveTrust.encryptionDomain`.

The admission adapter reloads `requestObjectId` as the exact stored canonical
request ref and constructs Program D's strict
`AdmitHumanOperationEventInput`: source is
`{kind:'human_operation', operationId, principalId, previewId:null}`, scope is
the resolver result, payload is that exact request ref, causal parents are the
verified operation-specific parents, and authorization/time are server-derived.
The operation/event mapping is closed and exhaustive:
`program_create` and `program_agenda_activation -> program_direction_proposed`; `program_pause`,
`program_resume`, and `program_cancel -> program_control_requested`. No
operation may substitute another D event type.
It delegates to D's accepted `EventAdmissionService`, reparses the decision,
and returns an admitted or exact-duplicate event with non-null event ID and
byte-equal scope. A rejected/operational-only decision, null event, changed
scope, wrong source principal/operation, or payload-ref mismatch stops before
`ResearchProgramService`. Neither port accepts a caller-supplied scope, lineage,
trust, event ID, grant, or idempotency identity.

`BrainOperationPort.createGenesis()` is a mechanical adapter over Program E's exact `GenesisBrainService`. After strict draft parsing, H derives `MutationAuthorization` from the authenticated `operate` principal and constructs only:

```ts
CreateGenesisBrainInputSchema.parse({
  schema: 'cosmo.create-genesis-brain-input.v1',
  draft,
  authorization,
  idempotencyKey: context.domainIdempotencyKey,
  createdAt: context.observedAt,
});
```

Program E derives and validates the canonical `refs/heads/<draft.branchName>` target, requires its head, the repository's Brain-commit/ref inventory, and semantic journal to be empty, invokes the accepted B/C/D/E owner-only genesis builders, acquires its own lease, and asks Program B for one parentless `expectedHead:null` CAS. From the validated target, deterministic intent lineage, authenticated authorization, and factory-pinned owner-approved `genesisTrust`, E derives one `{kind:'genesis', targetRef, lineageId, trustDomain}` cognitive-event scope and one coherent genesis storage-trust descriptor. Every admitted genesis event must use that exact scope, and its trust domain must match the accepted descriptor; neither is a public override. The overall genesis event points only to the append-before-build intent/seed object, while Relationship and Question events point only to their leaf objects; no event payload may point to the later roots bundle, any enclosing root, or a future commit. The public draft carries only operator-owned semantic choices; H cannot override trust, event scope, root refs, leases, expected head, model/runtime identity, Principal version, or kernel version. The composed installed kernel pins mechanical version identities. Topology and activation roots must carry their exact explicit genesis derivation variant, never a fabricated zero/future parent commit. Program E returns the exact public-safe `GenesisBrainReceipt`; it explicitly carries `covenantPayloadRef`, ordered initial Relationship event IDs/refs, ordered seed records `{questionId, questionRef, originEventId}`, `heritageCurationEventId`, all nine root refs, ordered `journalEventIds` and journal range, parentless commit/target ref, and transaction/CAS receipt. H neither constructs a root, scans to infer missing genesis identity, nor translates that receipt. Exact `(principal, idempotency key, draft)` retry returns the original receipt. A changed draft under the same key, a second genesis request, any existing Brain commit/canonical Brain ref/semantic journal record, or an authorization/absence race rejects without another CAS. Route tests assert every receipt identity matches the objects actually committed, all admitted events use the derived genesis scope/trust, topology and activation report genesis derivation, every root closure is acyclic and excludes its own ref/future commit, and provider/runtime model-call spies remain at zero.

Implement `WorkbenchMutationPort` only as this mechanical adapter:

```ts
export class ProgramFWorkbenchMutationAdapter
  implements WorkbenchMutationPort {
  constructor(
    private readonly previews: MutationPreviewService,
    private readonly humanPromotions: HumanInventPromotionService,
    private readonly promotionInputs: HumanInventPromotionInputResolver,
    private readonly authority: MutationAuthorityResolver,
  ) {}

  private async context(
    transport: MutationCallContext,
  ): Promise<MutationServiceContext> {
    const authorization = await this.authority.resolve({
      principal: transport.principal,
      requiredScope: 'steer',
      requestObjectId: transport.requestObjectId,
    });
    return MutationServiceContextSchema.parse({
      requester: {
        principalId: transport.principal.principalId,
        scopes: transport.principal.scopes,
      },
      authorization,
      domainIdempotencyKey: transport.domainIdempotencyKey,
      observedAt: transport.observedAt,
    });
  }

  async previewSteer(input: {
    draft: WorkbenchSteerDraft;
    context: MutationCallContext;
  }): Promise<WorkbenchMutationPreview> {
    return this.previews.previewSteer(PreviewSteerInputSchema.parse({
      draft: input.draft,
      context: await this.context(input.context),
    }));
  }

  async commitSteer(input: {
    request: WorkbenchSteerCommitRequest;
    context: MutationCallContext;
  }): Promise<SteerReceipt> {
    return this.previews.consumeSteer(ConsumeSteerInputSchema.parse({
      request: input.request,
      context: await this.context(input.context),
    }));
  }

  async previewInvent(input: {
    draft: WorkbenchInventDraft;
    context: MutationCallContext;
  }): Promise<WorkbenchMutationPreview> {
    return this.previews.previewInvent(PreviewInventInputSchema.parse({
      draft: input.draft,
      context: await this.context(input.context),
    }));
  }

  async commitInvent(input: {
    request: WorkbenchInventCommitRequest;
    context: MutationCallContext;
  }): Promise<InventReceipt> {
    return this.previews.consumeInvent(ConsumeInventInputSchema.parse({
      request: input.request,
      context: await this.context(input.context),
    }));
  }

  async promoteHumanInvent(input: {
    request: PromoteHumanInventCandidateRequest;
    context: MutationCallContext;
  }): Promise<HumanInventPromotionReceipt> {
    return this.humanPromotions.reviewAndPromote(
      await this.promotionInputs.resolve({
        inventReceipt: input.request.inventReceipt,
        context: input.context,
      }),
    );
  }
}
```

The authenticated principal's scopes are already unique and Program F-canonically ordered by the token/session store; the adapter does not invent a second order. `MutationServiceContextSchema` rechecks that order. H passes no token ID, raw idempotency key, preview fingerprint, lease, fence, timestamp override, or client-provided authorization into Program F. `HumanInventPromotionInputResolver` is server-only and must produce Program F's full exact input by the verification sequence below; it is not exported by product contracts or clients.

Freeze the exhaustive route-to-method table as a literal in `server.ts`:

```ts
type RouteIdentity<R> = R extends {
  method: infer Method extends string;
  path: infer Path extends string;
}
  ? `${Method} ${Path}`
  : never;

export type ApiV1RouteIdentity =
  RouteIdentity<(typeof apiV1Routes)[number]>;

export type CosmoApiPortMethod = {
  [Port in keyof CosmoApiPorts]: {
    [Method in keyof CosmoApiPorts[Port]]:
      `${Extract<Port, string>}.${Extract<Method, string>}`;
  }[keyof CosmoApiPorts[Port]];
}[keyof CosmoApiPorts];

export const apiV1HandlerBindings = {
  'GET /status': 'status.read',
  'GET /lifecycle/identity': 'lifecycle.identity',
  'POST /session/exchange-codes': 'lifecycle.issueBrowserSessionCode',
  'POST /session/exchange': 'lifecycle.exchangeBrowserSession',
  'POST /brains': 'brainOperation.createGenesis',
  'GET /brains': 'brainRead.list',
  'GET /brains/:commitId': 'brainRead.get',
  'GET /brains/:commitId/status': 'brainRead.status',
  'GET /brains/:commitId/log': 'brainRead.log',
  'GET /brains/:commitId/diff': 'brainRead.diff',
  'GET /brains/:commitId/verification': 'brainRead.verify',
  'POST /brains/:commitId/fork': 'brainOperation.fork',
  'POST /brains/union': 'brainOperation.union',
  'POST /brains/:commitId/tags': 'brainOperation.tag',
  'POST /brains/:commitId/settle': 'brainOperation.settle',
  'POST /brains/:commitId/wake': 'brainOperation.wake',
  'POST /brains/export': 'brainRead.export',
  'POST /brains/import': 'brainOperation.import',
  'POST /inquiries': 'inquiry.ask',
  'POST /formations': 'inquiry.explainFormation',
  'POST /steering/previews': 'workbenchMutation.previewSteer',
  'POST /steering': 'workbenchMutation.commitSteer',
  'POST /inventions/previews': 'workbenchMutation.previewInvent',
  'POST /inventions': 'workbenchMutation.commitInvent',
  'POST /inventions/promotions': 'workbenchMutation.promoteHumanInvent',
  'POST /comparisons': 'inquiry.compare',
  'POST /federations': 'inquiry.federate',
  'GET /wake-briefings/:commitId': 'inquiry.wakeBriefing',
  'POST /research/programs': 'research.create',
  'POST /research/agendas/activate': 'research.activateAgenda',
  'GET /research/programs/:programId': 'research.get',
  'POST /research/programs/:programId/pause': 'research.pause',
  'POST /research/programs/:programId/resume': 'research.resume',
  'POST /research/programs/:programId/cancel': 'research.cancel',
  'GET /events': 'eventRead.stream',
  'POST /lifecycle/stop': 'lifecycle.stop',
} as const satisfies Record<ApiV1RouteIdentity, CosmoApiPortMethod>;
```

```ts
test('inquiry remains pinned to the caller supplied Brain commit', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/inquiries',
    headers: bearerHeaders(['query']),
    payload: frozenQueryRequest,
  });
  assert.equal(response.statusCode, 200);
  assert.equal(inquiryPort.calls[0].brainCommitId, frozenQueryRequest.brainCommitId);
});

test('genesis is one exact public draft mapped once into Program E', async () => {
  const headers = mutationHeaders(['operate'], 'idem_genesis_1');
  const first = await app.inject({
    method: 'POST',
    url: '/api/v1/brains',
    headers,
    payload: genesisDraftFixture,
  });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(
    GenesisBrainReceiptSchema.parse(first.json()),
    genesisReceiptFixture,
  );
  assert.deepEqual(
    programEGenesisService.calls[0],
    CreateGenesisBrainInputSchema.parse({
      schema: 'cosmo.create-genesis-brain-input.v1',
      draft: genesisDraftFixture,
      authorization: derivedOperateAuthorization,
      idempotencyKey: domainKeyFor(
        ownerPrincipal.principalId,
        'idem_genesis_1',
        genesisDraftFixture,
      ),
      createdAt: fixedClock.now(),
    }),
  );

  const retry = await app.inject({
    method: 'POST',
    url: '/api/v1/brains',
    headers,
    payload: genesisDraftFixture,
  });
  assert.deepEqual(retry.json(), first.json());
  assert.equal(programEGenesisService.calls.length, 1);
  assert.equal(modelRuntime.calls.length, 0);

  const second = await app.inject({
    method: 'POST',
    url: '/api/v1/brains',
    headers: mutationHeaders(['operate'], 'idem_genesis_2'),
    payload: secondGenesisDraftFixture,
  });
  assert.equal(second.statusCode, 409);
  assert.equal(programEGenesisService.calls.length, 2);
  assert.equal(repositoryGenesisCas.calls.length, 1);
});

test('no route exposes a direct canonical write', async () => {
  for (const path of ['/objects', '/journal', '/refs/main', '/claims/promote']) {
    assert.equal((await app.inject({
      method: 'POST',
      url: `/api/v1${path}`,
      headers: ownerHeaders,
    })).statusCode, 404);
  }
});

test('mutations reject a missing idempotency key', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/research/programs/${programId}/pause`,
    headers: bearerHeaders(['operate']),
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('public Brain mutation DTOs reject repository authority fields', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/brains/${commitId}/fork`,
    headers: mutationHeaders(['operate']),
    payload: {
      ...forkBrainRequest,
      actorIdentity: sha256('forged actor'),
      capabilityGrantId: objectId,
      fencingToken: 'forged fence',
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(brainOperationPort.calls.length, 0);
});

test('public research DTOs cannot forge event scope or admission identity', async () => {
  for (const payload of [
    {
      ...createResearchProgramRequest,
      eventScope: forgedBrainLineageScope,
    },
    {
      ...createResearchProgramRequest,
      requestedByEventId: eventId('forged'),
    },
    {
      ...createResearchProgramRequest,
      trust: publicTrustFixture(),
    },
  ]) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/research/programs',
      headers: mutationHeaders(['operate']),
      payload,
    });
    assert.equal(response.statusCode, 400);
  }
  assert.equal(researchPort.calls.length, 0);
});

test('public research control cannot forge scope, event, or authority', async () => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/research/programs/${programId}/pause`,
    headers: mutationHeaders(['operate']),
    payload: {
      ...programMutationRequest,
      eventScope: forgedBrainLineageScope,
      requestedByEventId: eventId('forged'),
      authorization: forgedAuthorization,
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(researchPort.calls.length, 0);
});

for (const operation of ['fork', 'settle'] as const) {
  test(`${operation} cannot target a different commit than the reviewed path`, async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/brains/${reviewedCommitId}/${operation}`,
      headers: mutationHeaders(['operate']),
      payload: brainMutationFixture(operation, {
        expectedHead: differentCommitId,
      }),
    });
    assert.equal(response.statusCode, 400);
    assert.equal(brainOperationPort.calls.length, 0);
  });
}

test('error serialization never reflects secrets or internal paths', () => {
  const response = toPublicApiError(
    new Error('Bearer cosmo_secret at /Users/operator/private/source.json'),
    { requestId: 'req_fixture', incidentId: sha256('incident') },
  );
  const serialized = JSON.stringify(response);
  assert.equal(serialized.includes('cosmo_secret'), false);
  assert.equal(serialized.includes('/Users/operator'), false);
  assert.equal(ApiErrorSchema.parse(response).error.code, 'INTERNAL');
});

test('SSE projects only closed authorized public fields', async () => {
  eventReadPort.next = internalEventFixture({
    prompt: 'private prompt',
    sourceExcerpt: 'restricted source bytes',
    capabilityGrantId: objectId,
    filesystemPath: '/private/fixture',
  });
  const frame = await readOneEventFrame(app, bearerHeaders(['read']));
  const serialized = JSON.stringify(EventStreamFrameSchema.parse(frame));
  for (const forbidden of [
    'private prompt',
    'restricted source bytes',
    'capabilityGrantId',
    '/private/fixture',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('program-proposal SSE never claims the reviewed target advanced', async () => {
  eventReadPort.next = programProposalCommittedEventFixture();
  const frame = EventStreamFrameSchema.parse(
    await readOneEventFrame(app, bearerHeaders(['read'])),
  );
  assert.equal(frame.type, 'event');
  if (frame.type === 'event') {
    assert.equal(frame.projection.kind, 'operation');
    assert.equal(JSON.stringify(frame.projection).includes('advanced'), false);
  }
});

test('all 36 manifest routes invoke exactly their frozen port method', async () => {
  const expected = Object.fromEntries(
    routeManifest.routes.map((route) => [
      `${route.method} ${route.path}`,
      apiV1HandlerBindings[`${route.method} ${route.path}`],
    ]),
  );
  assert.equal(Object.keys(apiV1HandlerBindings).length, 36);
  assert.deepEqual(apiV1HandlerBindings, expected);

  for (const route of routeManifest.routes) {
    portSpies.reset();
    const identity = `${route.method} ${route.path}` as ApiV1RouteIdentity;
    await injectPositiveRouteFixture(app, route, validRequestFixtures[identity]);
    assert.deepEqual(portSpies.calledMethods(), [
      apiV1HandlerBindings[identity],
    ]);
    assert.deepEqual(
      portSpies.onlyCall().input,
      expectedParsedPortInput(identity, validRequestFixtures[identity]),
    );
  }
});

test('Steer commit accepts only the reviewed four-field Program F request', async () => {
  const preview = await injectSteerPreview(app, steerDraft, principal);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/steering',
    headers: mutationHeaders(['steer'], 'idem_steer_commit_1'),
    payload: {
      schema: 'cosmo.workbench-steer-commit-request.v1',
      requestId: steerDraft.requestId,
      previewId: preview.previewId,
      draftHash: preview.draftHash,
      expectedHead: preview.expectedHead,
      capabilityGrantId: objectId,
    },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(workbenchMutationPort.commitCalls.length, 0);
});

for (const staleCase of [
  'head_changed',
  'draft_hash_changed',
  'authority_changed',
  'principal_or_scope_changed',
  'expired',
] as const) {
  test(`Steer commit fails closed when ${staleCase}`, async () => {
    const preview = await injectSteerPreview(app, steerDraft, principal);
    programFPreviewFixture.makeStale(staleCase, preview);
    const response = await injectSteerCommit(app, preview, principal);
    assert.equal(response.statusCode, 409);
    assert.equal(inquiryService.steerCalls.length, 0);
  });
}

test('a consumed preview retries only under the same idempotency record', async () => {
  const preview = await injectInventPreview(app, inventDraft, principal);
  const first = await injectInventCommit(app, preview, principal, 'idem_invent_1');
  const retry = await injectInventCommit(app, preview, principal, 'idem_invent_1');
  const replay = await injectInventCommit(app, preview, principal, 'idem_invent_2');
  assert.equal(first.statusCode, 200);
  assert.deepEqual(retry.json(), first.json());
  assert.equal(replay.statusCode, 409);
  assert.equal(inquiryService.inventCalls.length, 1);
});

test('H adapts mutation context into the four exact Program F inputs', async () => {
  const adapter = new ProgramFWorkbenchMutationAdapter(
    mutationPreviewServiceSpy,
    humanInventPromotionServiceSpy,
    humanInventPromotionInputResolver,
    mutationAuthorityResolver,
  );
  const contexts = {
    steerPreview: mutationContextFixture('steer-preview'),
    steerCommit: mutationContextFixture('steer-commit'),
    inventPreview: mutationContextFixture('invent-preview'),
    inventCommit: mutationContextFixture('invent-commit'),
  };
  await adapter.previewSteer({
    draft: steerDraft,
    context: contexts.steerPreview,
  });
  await adapter.commitSteer({
    request: steerCommit,
    context: contexts.steerCommit,
  });
  await adapter.previewInvent({
    draft: inventDraft,
    context: contexts.inventPreview,
  });
  await adapter.commitInvent({
    request: inventCommit,
    context: contexts.inventCommit,
  });

  const expectedContext = (transport: MutationCallContext) =>
    MutationServiceContextSchema.parse({
      requester: {
        principalId: transport.principal.principalId,
        scopes: transport.principal.scopes,
      },
      authorization: serverDerivedAuthorization,
      domainIdempotencyKey: transport.domainIdempotencyKey,
      observedAt: transport.observedAt,
    });
  assert.deepEqual(mutationPreviewServiceSpy.calls, [
    ['previewSteer', PreviewSteerInputSchema.parse({
      draft: steerDraft,
      context: expectedContext(contexts.steerPreview),
    })],
    ['consumeSteer', ConsumeSteerInputSchema.parse({
      request: steerCommit,
      context: expectedContext(contexts.steerCommit),
    })],
    ['previewInvent', PreviewInventInputSchema.parse({
      draft: inventDraft,
      context: expectedContext(contexts.inventPreview),
    })],
    ['consumeInvent', ConsumeInventInputSchema.parse({
      request: inventCommit,
      context: expectedContext(contexts.inventCommit),
    })],
  ]);
  const serialized = JSON.stringify(mutationPreviewServiceSpy.calls);
  for (const context of Object.values(contexts)) {
    assert.equal(serialized.includes(context.idempotencyKey), false);
    assert.equal(serialized.includes(context.principal.tokenId), false);
  }
});

test('program creation pins the reread branch, Covenant, and seed Questions', async () => {
  for (const invalid of [
    'branch_head_changed',
    'covenant_not_pinned_by_start_brain',
    'seed_question_not_in_start_question_root',
  ] as const) {
    const fixture = createProgramPortFixture({ invalid });
    const response = await injectCreateProgram(app, fixture.request);
    assert.equal(response.statusCode, 409);
    assert.equal(fixture.researchProgramService.createCalls.length, 0);
    assert.equal(fixture.lifecycleEngine.acceptProgramMutation.calls.length, 0);
    assert.equal(fixture.lifecycleEngine.initialize.calls.length, 0);
  }
});

test('formation is an exact read with no semantic execution', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/formations',
    headers: bearerHeaders(['read']),
    payload: formationInquiryFixture,
  });
  assert.deepEqual(
    FormationExplanationSchema.parse(response.json()),
    formationExplanationFixture,
  );
  assert.deepEqual(inquiryPort.explainFormation.calls[0].request,
    FormationInquirySchema.parse(formationInquiryFixture));
  assert.equal(structuredRoleExecution.calls.length, 0);
});

test('human Invent promotion derives every review and authority field', async () => {
  await injectHumanInventPromotion(app, inventReceiptFixture);
  const call = humanInventPromotionService.reviewAndPromote.calls[0];
  assert.equal(call.inventReceipt, inventReceiptFixture);
  assert.equal(call.canonicalRef, inventReceiptFixture.queriedRef);
  assert.equal(call.expectedCanonicalHead, inventReceiptFixture.parentCommitId);
  assert.equal(call.authorization, derivedOperateAuthorization);
  assert.equal(call.lease, serverLease);
  assert.equal('independentReviewInputs' in promotionPublicRequestFixture, false);
  assert.equal('principalVersion' in promotionPublicRequestFixture, false);
});

test('agenda activation reloads the candidate and uses exact F activation', async () => {
  const response = await injectAgendaActivation(
    app,
    activateResearchAgendaRequestFixture,
  );
  assert.deepEqual(
    ProgramDirectionActivationReceiptSchema.parse(response.json()),
    programDirectionActivationReceiptFixture,
  );
  assert.deepEqual(
    ActivateProgramDirectionCandidateInputSchema.parse(
      programDirectionActivationService.activate.calls[0],
    ),
    expectedProgramDirectionActivationInput,
  );
  assert.equal(researchProgramService.create.calls.length, 1);
  assert.equal(cognitiveLifecycle.initialize.calls.length, 1);
});
```

- [ ] **Step 3: Run the tests and verify missing handlers**

Run:

```bash
npm test -- tests/api/routes.test.ts tests/api/mutation-preview.test.ts tests/api/sse.test.ts
```

Expected: FAIL because `buildCosmoApi()` is not implemented.

- [ ] **Step 4: Implement a schema-driven route registrar**

`buildCosmoApi()` must load the checked-in manifest, resolve every named request and response schema, reject a manifest route without a handler, authenticate before body parsing where possible, validate request/response bodies, and serialize every failure through the imported closed public error contract.

The API imports the Task 1 `ApiErrorSchema`; error serialization maps internal failures to one closed code/message/details variant, parses the completed envelope, and only then writes it. It never reflects an exception message, stack, provider payload, path, prompt, source content, token, cookie, grant, lease, or fence. The contract suite mutates both successful response fixtures and error fixtures with an unknown top-level or nested field and requires rejection. No API-local error interface or permissive serializer exists.

- [ ] **Step 5: Implement read, inquiry, and exact two-phase mutation routes**

Read routes pin exact commit IDs and return integrity state. `GET /brains` transforms the bounded URL query into Program F's exact `WorkbenchBrainCatalogRequest`, including explicit `cursor:null` when the URL omitted it, and returns the exact `WorkbenchBrainCatalogSchema`; H has no parallel list response. `GET /brains/:commitId` returns Program F's `WorkbenchBrainSummary`, not a product-local `BrainView`. `/inquiries` accepts Program F's frozen `InquiryExecutionInput` and stays read-only. `POST /formations` passes the exact `FormationInquiry` to Program F's formation service and returns its exact `FormationExplanation`; it performs no new model execution, synthesis, or mutation. `/comparisons`, `/federations`, and `/wake-briefings/:commitId` implement the relative gateway frozen by Program F and remain read-only.

The four mutation routes implement Program F's exact gateway seam:

- `POST /steering/previews` parses `WorkbenchSteerDraftSchema` and returns `WorkbenchMutationPreviewSchema`;
- `POST /steering` parses `WorkbenchSteerCommitRequestSchema` and returns `SteerReceiptSchema`;
- `POST /inventions/previews` parses `WorkbenchInventDraftSchema` and returns `WorkbenchMutationPreviewSchema`; and
- `POST /inventions` parses `WorkbenchInventCommitRequestSchema` and returns `InventReceiptSchema`.

On preview, H authenticates the principal and exact Program F-canonical scope set, binds `draft.requestId` to the preview route's idempotency record, derives `MutationAuthorization`, and uses `ProgramFWorkbenchMutationAdapter` to parse an exact `PreviewSteerInput` or `PreviewInventInput`. Its F-owned `MutationServiceContext` contains only `{requester:{principalId,scopes}, authorization, domainIdempotencyKey, observedAt}`. The adapter delegates to accepted `MutationPreviewService.previewSteer()` or `.previewInvent()`. Program F alone resolves and rechecks the named ref/head, canonically stores the strict draft as an authorized immutable object, computes `draftRef`/`draftHash` and the public-safe authority fingerprint, derives the closed mechanical changes, chooses the bounded expiry, and creates the content-addressed preview. H reparses the exact returned object through `WorkbenchMutationPreviewSchema` before serialization. `reviewer` exposes only the hashed principal ID and exact sorted public scope values; H neither recreates Program F's hashing/storage rules nor reads an internal preview record into a response.

On commit, H parses only the exact four-field Program F commit request, authenticates and re-derives an exact `MutationServiceContext` with the commit phase's outer-record `domainIdempotencyKey`, parses `ConsumeSteerInput` or `ConsumeInventInput`, and delegates to Program F `MutationPreviewService.consumeSteer()` or `.consumeInvent()`. Preview and commit use distinct idempotency records; each phase's domain key is stable only across retries of that same phase. The accepted F service reloads and strictly reparses its stored draft/preview, validates request ID, preview ID, kind, draft hash, expected/current head, principal, scopes, authority fingerprint, expiry, prior consumption, and fresh lease, and constructs the internal `SteerInput` or `InventInput` with `reviewed:true`, that exact commit-domain idempotency key, and server time. Program F `InquiryService.steer()`/`.invent()` and its accepted Program E mutation adapter are the only canonical mutation path. H returns only the exact parsed `SteerReceiptSchema`/`InventReceiptSchema`.

A changed head, canonical draft byte/hash, preview byte/ID, authority binding/fingerprint, principal, scope set, kind, request ID, expiry, lease revalidation, or prior consumption fails inside Program F before its semantic mutation. Preview IDs are single-use across idempotency identities. Byte-identical retry with the original commit idempotency key returns the original strict receipt; a different key against a consumed preview returns conflict. H maps only F's typed preview failures to the closed `MUTATION_PREVIEW_INVALID` reasons and never reflects internal text. There is no H preview store, one-step compatibility route, or server fallback that synthesizes a preview.

Program-proposal Steer remains Program F's candidate-only operation. F derives the deterministic candidate ref from request/draft identity, requires it absent, writes only that candidate ref, and leaves the reviewed `targetRef` at `expectedHead`. H accepts the result only through exact `SteerReceiptSchema` refinement: `resultRef === candidateRef`, `targetRefAfterCommitId === parentCommitId`, and `targetRefUnchanged === true`. Client/CLI output says candidate created/reviewed target unchanged; no API response or error may report that the canonical target advanced or that a Research Program became active. Because the closed SSE projection has no safe candidate-ref detail variant, the event stream emits only the generic operation status for this action and must not emit `brain.change='advanced'`; clients read the exact receipt for candidate identity. Invent accepts only Program F's strict human-origin `CandidateFinding`; H has no `runtimeAuthorization` field, adapter path, default, or compatibility shim.

`POST /inventions/promotions` is the separate, explicit human-candidate
promotion boundary. H stores or byte-verifies the exact submitted
`InventReceipt`, derives `inventReceiptRef`, parses `queriedRef` through
Program E's exact `WritableBrainHeadRefSchema`, and requires the current head
still equal `parentCommitId`. It then derives fresh independent-review inputs,
evidence policy, Principal version, authorization, lease, idempotency identity,
and timestamps from installed server state and calls only
`HumanInventPromotionService.reviewAndPromote()` with Program F's exact
`PromoteHumanInventCandidateInput`. The client cannot submit review findings,
Principal decisions, policy/version identity, authority, lease, runtime
authorization, or time. The exact `HumanInventPromotionReceipt` is returned
unchanged. Tags, settled refs, detached commits, non-human Invent receipts,
moved heads, forged receipt/object identities, or unqualified independent
review fail before Program E acceptance.

- [ ] **Step 6: Implement research and Brain operation routes**

All operations call narrow ports and return a receipt. `GET /research/programs/:programId` returns the exact `ResearchProgramView`. Import verifies and, when required, decrypts the uploaded export before exposing a ref. Union remains lossless, materializes a complete resolvable closure, and cannot trigger metabolism.

For fork, union, tag, settle, wake, and import, the handler authenticates first, canonicalizes the authority-free DTO, binds its `Idempotency-Key`, derives `actorIdentity` and `capabilityGrantId` from the principal, acquires the resource-specific lease and fence, validates the current head, and only then constructs the internal Program B request. Steer and Invent follow the stricter preview/commit sequence in Step 5: their internal Program F inputs are reconstructed only from the revalidated stored draft and preview. Client input can never choose a grant, lease, fence, trust domain, journal range, internal mutation timestamp, or `reviewed` value.

Brain status/log are read projections over immutable commits, refs, and journal history. Fork and settle reject unless path `:commitId === body.expectedHead`; after acquiring the named ref's lease, the handler rereads that ref and rejects unless it still equals the same reviewed commit before constructing any Program B input. Tag constructs Program B `TagBrainInput`, including server-derived authority and lease. Settle maps `branchName` and `settlementName` to validated refs and constructs Program B `SettleBrainInput`. Wake verifies that `refs/settled/<settledName>` resolves to the route's `:commitId`, maps `wakeBranchName` to `refs/heads/<wakeBranchName>`, and constructs Program B `WakeBrainInput`. It only preserves the exact settled commit and appends the typed curation event; it does not itself originate cognition or call Program E. Lifecycle stop preserves its distinct process-only semantics.

`POST /research/agendas/activate` is the only public transition from a reviewed
program-direction candidate to an active Research Program. H stores or
byte-verifies the exact `SteerReceipt`, requires its strict candidate-only
program-proposal invariants, reloads `ResearchProgramDirectionProposal` by
`programProposalObjectId`, and verifies the candidate ref/commit, unchanged
reviewed target, originating admitted human-operation event, proposal bytes,
and current writable head. It derives the candidate-agenda acceptance receipt,
qualified independent-review recordings, Principal decision, authorization,
lease, stable host delivery/idempotency identities, and time from accepted
server state. From the stored proposal it takes title, purpose, mode, seed
Questions, Covenant, and stopping rules; the authority-free public request adds
only honest block conditions and budget. H constructs/parses Program D's exact
`CreateResearchProgramInput`, then calls only Program F's
`ProgramDirectionActivationService.activate()` with exact
`ActivateProgramDirectionCandidateInput`. The response is Program F's exact
`ProgramDirectionActivationReceipt`, including D mutation, Program E
acceptance/initialization, convergence, and active-state receipts. H does not
reimplement activation or a reduced E interface. A tag, settled ref, detached
commit, hypothesis candidate, forged receipt/proposal/event, moved head,
unqualified review, or mismatched proposal fails before D create or E
acceptance.

Pause, resume, and cancel use one exact orchestration:

1. authenticate, derive `MutationAuthorization`, store the canonical request,
   and require the public `expectedStatus` and `expectedControlEpoch`;
2. call `BrainMutationScopeResolver.resolveControl()` with only the program,
   public pins, canonical request identity, server authorization, stable
   `domainIdempotencyKey`, and server time; require the returned canonical
   state/root/head, program binding, effective trust, and exact scope;
3. call `HumanOperationAdmissionPort.admit()` with that scope and operation
   kind, require an admitted/exact-duplicate event whose source, payload, and
   scope match, and take only its non-null `eventId` as `requestedByEventId`;
4. construct and parse exact `ResearchProgramControlInput`, using the resolver
   Brain/root/state/status/epoch pins, route action, admitted event ID and
   scope, server authorization/time, and
   `idempotencyKey=context.domainIdempotencyKey`;
5. call exactly `ResearchProgramService.pause()`, `.resume()`, or `.cancel()`
   and persist the returned `ResearchProgramMutationResult`, immutable receipt
   ref, and stable
   `hostControlDeliveryId = sha256(operationId, controlReceiptId)`;
6. acquire the canonical ref lease and call Program E
   `acceptProgramMutation()` with exact `AcceptProgramMutationInput`, so E
   alone accepts D's Program-root proposal in a canonical Brain commit;
7. deliver only `{programId, programStateObjectId, controlEpoch,
   hostControlDeliveryId, observedAt}` to `reconcileProgramControl()` and await
   its exact `CognitiveLifecycleDecision`; and
8. mark the H operation complete only when the action is respectively
   `pause_converged`, `resume_converged`, or `cancel_converged`, D's canonical
   status/epoch and E's lifecycle state agree, and no mutation remains pending.

H never writes D state, calls `finalizeTransition()`, sets `nextWakeAt`, selects the convergence action, or constructs the canonical Brain transaction. A crash after any numbered step resumes the same operation, D receipt, and `hostControlDeliveryId`; E's acceptance/reconciliation identities make delivery idempotent. A conflicting D request, changed authority, changed canonical head, different receipt, or mismatched E decision fails closed.

Creating a Research Program uses the same ownership boundary. The server
derives `programId` from the canonical request plus idempotency identity and
validates `ResearchProgramModeSchema` without remapping. It calls
`BrainMutationScopeResolver.resolveCreate()` with the derived branch ref,
public starting-commit pin, derived program ID, canonical request identity,
server authorization/domain idempotency/time, then requires the verified
head/Program root and exact program-bound scope/trust. It admits one
`program_create` human-operation event through
`HumanOperationAdmissionPort`, requires its returned cognitive event to echo
that scope/source/payload, and constructs only:

```ts
CreateResearchProgramInputSchema.parse({
  schema: 'cosmo.create-research-program-input.v1',
  programId,
  title: request.title,
  purpose: request.purpose,
  mode: request.mode,
  branchRef: resolution.targetRef,
  startingBrainCommitId: resolution.brainCommitId,
  expectedProgramRootRef: resolution.programRootRef,
  covenantCommitId: request.covenantCommitId,
  seedQuestionIds: request.seedQuestionIds,
  stoppingCriteria: request.stoppingCriteria,
  honestBlockConditions: request.honestBlockConditions,
  budget: request.budget,
  requestedByEventId: admission.eventId,
  eventScope: resolution.eventScope,
  authorization,
  idempotencyKey: context.domainIdempotencyKey,
  createdAt: context.observedAt,
});
```

D returns only an `initializing` `ResearchProgramMutationResult`. H then
delivers it through `acceptProgramMutation()` before invoking Program E
`initialize()` with the accepted Brain commit, exact program state/epoch, D
mutation receipt ID, seed Questions, lifecycle-policy object, server-derived
authorization, and admitted timestamp. Its operation receipt is `completed`
only after Program E returns `CognitiveLifecycleInitializationResult` with
`outcome='initialized'` or `outcome='already_initialized'`, D's finalized
canonical state is `active`, and E's state matches it. A crash in any window
leaves an honest `initialization_pending` H operation; startup reuses the same
operation ID, admitted event, scope resolution, D result, accepted-mutation
identity, and initialization input. Program E owns exact-retry identity and
typed conflicting-reinitialization rejection. H coordinates these public
boundaries but supplies no cognitive policy.

Inside `resolveCreate()`, H resolves
`branchRef = refs/heads/<validated branchName>`, acquires that named ref's
resource lease, and rereads it under the lease. The reread head must equal
`CreateResearchProgramRequest.startingBrainCommitId`; a detached commit, tag,
settled ref, pre-lease observation, or moved head is ineligible. H verifies and
materializes that exact start Brain through Program B's nine-codec registry.
The decoded Relationship-root projection must identify the request's
`covenantCommitId` as the Covenant pinned by that start Brain, and every
`seedQuestionId` must resolve as an admitted Question in that same commit's
decoded Question root. Merely finding the Covenant or Question object
elsewhere in the object store, another branch, a later commit, a candidate
proposal, or an artifact is insufficient. A changed head, failed root
verification, mismatched Covenant, missing/non-admitted seed, authorization
failure, scope/program mismatch, or admission failure rejects before
`ResearchProgramService.create()`, `acceptProgramMutation()`, or
`initialize()`. H retains/revalidates the lease through Program E's accepted
canonical create transaction and never substitutes a newer head silently.

- [ ] **Step 7: Implement idempotency**

For each principal, store:

```ts
interface IdempotencyRecord {
  principalId: Sha256;
  keyHash: Sha256;
  requestObjectId: ObjectId;
  domainIdempotencyKey: Sha256;
  responseObjectId: ObjectId;
  responseSchema: string;
  expiresAt: string;
}
```

`domainIdempotencyKey = sha256(canonicalJsonBytes({principalId, keyHash, requestObjectId}))`; it is calculated by middleware, stored explicitly, and passed unchanged in `MutationCallContext`. The same key and request returns the original schema-parsed response, including the same preview for a preview retry and the same receipt for a commit retry. The same key with different canonical request bytes returns `409 IDEMPOTENCY_CONFLICT`. H supplies this stable outer-record identity to Program F preview/consumption; Program F's own exact one-use/retry contract remains authoritative if H crashes between its outer record and response. Recovery may return a completed F response but can never authorize a second semantic call.

`POST /session/exchange` bypasses this store only because `BrowserSessionStore.exchange()` atomically compares, consumes, and marks the one-time code before creating the session. Every other mutation passes `IdempotencyStore`.

- [ ] **Step 8: Implement resumable SSE**

`GET /events?afterCursor=<cursor>` emits `id`, `event`, and JSON `data` fields, sends a heartbeat every 15 seconds through an injected clock, closes cleanly on abort, and emits `reset_required` when the requested cursor is no longer available. It never streams raw model reasoning, credentials, quarantined envelopes, or private data outside the principal's grant.

- [ ] **Step 9: Run focused and full API tests**

Run:

```bash
npm test -- tests/api/routes.test.ts tests/api/mutation-preview.test.ts tests/api/sse.test.ts tests/api/auth.test.ts
npm run test:contracts
```

Expected: PASS; the implementation route table exactly equals the frozen v1
manifest, public research DTOs remain scope/authority-free, and forged scope,
event, trust, or authorization fields fail before the `ResearchPort`.

- [ ] **Step 10: Commit the API**

```bash
git add package-lock.json packages/api tests/api docs/architecture/public-api.md
git commit -m "feat(api): expose versioned COSMO operations"
```

---

### Task 4: Build the Unprivileged Public Client

**Files:**
- Modify: `package-lock.json`
- Create: `packages/client/package.json`
- Create: `packages/client/tsconfig.json`
- Create: `packages/client/src/errors.ts`
- Create: `packages/client/src/sse-parser.ts`
- Create: `packages/client/src/client.ts`
- Create: `packages/client/src/index.ts`
- Create: `tests/client/client.test.ts`
- Create: `tests/client/dependency-boundary.test.ts`
- Create: `docs/architecture/client-boundary.md`

**Interfaces:**
- Consumes: only `@cosmo/product-contracts`, the standard `fetch` shape, and a supplied credential provider.
- Produces: `CosmoClient`, `CosmoClientOptions`, typed operation methods, and `events()` as an async iterable.

- [ ] **Step 1: Write failing public-client conformance tests**

```ts
test('client sends a stable idempotency key on mutation retry', async () => {
  const key = 'idem_test_1';
  const request = {
    expectedStatus: 'active',
    expectedControlEpoch: 4,
    reason: 'operator paused for review',
  } as const;
  await client.pauseProgram(programId, request, { idempotencyKey: key });
  await client.pauseProgram(programId, request, { idempotencyKey: key });
  assert.deepEqual(fetchCalls.map((call) => call.headers['Idempotency-Key']), [
    key,
    key,
  ]);
});

test('client resumes SSE from the last validated cursor', async () => {
  const cursors: string[] = [];
  for await (const frame of client.events({ afterCursor: '41' })) {
    if (frame.type === 'event') cursors.push(frame.cursor);
    if (cursors.length === 2) break;
  }
  assert.deepEqual(cursors, ['42', '43']);
});

test('client exposes Program F preview and commit as separate exact calls', async () => {
  const preview = await client.previewSteer(programProposalSteerDraft, {
    idempotencyKey: 'idem_preview_1',
  });
  const receipt = await client.commitSteer({
    schema: 'cosmo.workbench-steer-commit-request.v1',
    requestId: programProposalSteerDraft.requestId,
    previewId: preview.previewId,
    draftHash: preview.draftHash,
    expectedHead: preview.expectedHead,
  }, {
    idempotencyKey: 'idem_commit_1',
  });
  assert.deepEqual(fetchCalls.map(({ path }) => path), [
    '/api/v1/steering/previews',
    '/api/v1/steering',
  ]);
  assert.equal(receipt.resultRef, receipt.candidateRef);
  assert.equal(receipt.targetRefAfterCommitId, receipt.parentCommitId);
  assert.equal(receipt.targetRefUnchanged, true);
});
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
npm test -- tests/client/client.test.ts tests/client/dependency-boundary.test.ts
```

Expected: FAIL because `@cosmo/client` does not exist.

- [ ] **Step 3: Implement the exact client surface**

Create a private ESM `@cosmo/client` package with a `./src/index.ts` development export, `tsc -p tsconfig.json` build, root-runner tests, and only `"@cosmo/product-contracts": "*"` as a COSMO dependency. The release builder alone rewrites the staged export to `./dist/index.js`.

```ts
export interface MutationOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface EventStreamOptions {
  afterCursor?: JournalCursor;
  signal?: AbortSignal;
}

export type BrowserSessionCode = CreateBrowserSessionCodeResponse;

export interface CosmoClient {
  status(): Promise<ProductStatus>;
  lifecycleIdentity(): Promise<LifecycleIdentity>;
  createBrain(request: CreateGenesisBrainDraft, options: MutationOptions): Promise<GenesisBrainReceipt>;
  listBrains(request: WorkbenchBrainCatalogRequest): Promise<WorkbenchBrainCatalog>;
  getBrain(commitId: BrainCommitId): Promise<WorkbenchBrainSummary>;
  getBrainStatus(commitId: BrainCommitId): Promise<BrainStatusResponse>;
  getBrainLog(request: BrainLogRequest): Promise<BrainLogResponse>;
  diffBrains(left: BrainCommitId, right: BrainCommitId): Promise<BrainDiff>;
  verifyBrain(commitId: BrainCommitId): Promise<VerificationReport>;
  query(request: InquiryExecutionInput): Promise<InquiryAnswer>;
  explainFormation(request: FormationInquiry): Promise<FormationExplanation>;
  previewSteer(request: WorkbenchSteerDraft, options: MutationOptions): Promise<WorkbenchMutationPreview>;
  commitSteer(request: WorkbenchSteerCommitRequest, options: MutationOptions): Promise<SteerReceipt>;
  previewInvent(request: WorkbenchInventDraft, options: MutationOptions): Promise<WorkbenchMutationPreview>;
  commitInvent(request: WorkbenchInventCommitRequest, options: MutationOptions): Promise<InventReceipt>;
  promoteHumanInventCandidate(request: PromoteHumanInventCandidateRequest, options: MutationOptions): Promise<HumanInventPromotionReceipt>;
  compare(request: CompareInput): Promise<ComparisonResult>;
  federate(request: FederatedInquiryInput): Promise<FederatedInquiryResult>;
  getWakeBriefing(commitId: BrainCommitId): Promise<WakeBriefing>;
  createProgram(request: CreateResearchProgramRequest, options: MutationOptions): Promise<OperationReceipt>;
  activateResearchAgenda(request: ActivateResearchAgendaRequest, options: MutationOptions): Promise<ProgramDirectionActivationReceipt>;
  getProgram(programId: ResearchProgramId): Promise<ResearchProgramView>;
  pauseProgram(programId: ResearchProgramId, request: ProgramMutationInput, options: MutationOptions): Promise<OperationReceipt>;
  resumeProgram(programId: ResearchProgramId, request: ProgramMutationInput, options: MutationOptions): Promise<OperationReceipt>;
  cancelProgram(programId: ResearchProgramId, request: ProgramMutationInput, options: MutationOptions): Promise<OperationReceipt>;
  forkBrain(parent: BrainCommitId, request: ForkBrainRequest, options: MutationOptions): Promise<OperationReceipt>;
  unionBrains(request: UnionBrainsRequest, options: MutationOptions): Promise<OperationReceipt>;
  tagBrain(commitId: BrainCommitId, request: TagBrainRequest, options: MutationOptions): Promise<OperationReceipt>;
  settleBrain(commitId: BrainCommitId, request: SettleBrainRequest, options: MutationOptions): Promise<OperationReceipt>;
  wakeBrain(commitId: BrainCommitId, request: WakeBrainRequest, options: MutationOptions): Promise<OperationReceipt>;
  exportBrain(request: ExportBrainRequest): Promise<BrainExportResponse>;
  importBrain(request: ImportBrainRequest, options: MutationOptions): Promise<ImportBrainResponse>;
  createBrowserSessionCode(request: CreateBrowserSessionCodeInput, options: MutationOptions): Promise<CreateBrowserSessionCodeResponse>;
  stopLifecycle(request: StopLifecycleRequest, options: MutationOptions): Promise<OperationReceipt>;
  events(options: EventStreamOptions): AsyncIterable<EventStreamFrame>;
}
```

The client requires `MutationOptions.idempotencyKey` to match `/^[A-Za-z0-9._:-]{8,128}$/`, maps it only to the `Idempotency-Key` header, and reuses it byte-for-byte on retry; it carries no principal, grant, lease, or fence. `createBrain()` accepts only Program E's exact authority-free draft and parses its exact public-safe genesis receipt; it cannot supply expected head, root refs, versions, authority, or a model choice. `explainFormation()` accepts and returns Program F's exact read-only formation contracts. `previewSteer()`/`previewInvent()` accept only Program F's exact drafts and parse the exact preview; `commitSteer()`/`commitInvent()` accept only Program F's exact four-field commit requests and never auto-preview, copy a draft into a commit, synthesize `reviewed`, or accept `runtimeAuthorization`. `promoteHumanInventCandidate()` submits only the exact stored `InventReceipt`; the server performs the independent review and derives Principal, policy, authorization, lease, time, and writable head. `activateResearchAgenda()` submits only the exact candidate-producing `SteerReceipt`, honest block conditions, and budget; the server reloads the candidate proposal and derives the accepted D/E create path. Every mutation response is parsed with its exact accepted core receipt schema. In particular, a program-proposal Steer returns its candidate `resultRef`/`candidateRef` and `targetRefUnchanged:true`; the client exposes those fields without converting the result into “canonical target advanced” or “program started.” `EventStreamOptions.afterCursor` maps only to the validated `afterCursor` query parameter, while `signal` controls local cancellation and is never serialized. `BrowserSessionCode` is an explicit compatibility alias of the exact authority-free `CreateBrowserSessionCodeResponse`, not a second contract. Every response is parsed with the public Zod schema before it reaches the caller. Authentication comes from an injected async credential provider and is never retained in serialized client state.

No method accepts Program B `ForkRequest`, `UnionRequest`, `MutationAuthorization`, a grant, lease, or fence. Dependency tests compile negative fixtures that try each forbidden authority field and require a type error plus runtime strict-schema rejection.

`tests/client/client.test.ts` table-drives all 36 manifest rows: 35 are exact `CosmoClient` operations, while the sole `POST /session/exchange` bootstrap row is exercised by Program F's exact browser-session exchange adapter and is intentionally absent from the bearer-oriented client surface. For each operation it captures the exact method/path/params/query/body, reconstructs the named strict HTTP envelope, parses it through the manifest request schema, returns the positive response fixture through the named response schema, and asserts no unconsumed argument remains. It proves `createBrain()` sends the exact Program E draft and parses the exact genesis receipt; `listBrains()` first parses Program F's exact request, omits the schema discriminator from the URL, maps `cursor:null` to an absent query parameter, and receives the exact `WorkbenchBrainCatalogSchema`; the server-side transport transform reconstructs the same explicit null request. The table also proves formation identity, exact human Invent receipt promotion, candidate-agenda activation, browser session code input plus idempotency, the separate Program F draft-preview and commit calls, and pause/resume/cancel `expectedStatus`/`expectedControlEpoch`/`reason` bodies are serialized rather than silently defaulted.

- [ ] **Step 3B: Register the workspace in the root lockfile before any dependent test**

Run `npm install` at the repo root, then commit the registry change before any test that imports the new workspace:

```bash
npm install
git add package.json package-lock.json packages/client/package.json packages/client/tsconfig.json
git commit -m "chore(client): register workspace"
```

- [ ] **Step 4: Enforce the package boundary**

The dependency test reads `packages/client/package.json` and its source import graph. It permits `@cosmo/product-contracts` and platform modules only. It fails on direct `@cosmo/contracts`, `@cosmo/repository`, `@cosmo/corpus`, `@cosmo/runtime`, `@cosmo/research`, `@cosmo/cognition`, local instance paths, or any Home23 identifier.

- [ ] **Step 5: Run client, live API, and type tests**

Run:

```bash
npm test -- tests/client/client.test.ts tests/client/dependency-boundary.test.ts tests/api/routes.test.ts
npm run typecheck
```

Expected: PASS against an in-process API with fake ports and against the checked-in response fixtures.

- [ ] **Step 6: Commit the client**

```bash
git add package-lock.json packages/client tests/client docs/architecture/client-boundary.md
git commit -m "feat(client): add unprivileged COSMO client"
```

---

### Task 5: Compose the Standalone Service and Honest Status

**Files:**
- Modify: `package-lock.json`
- Create: `apps/service/package.json`
- Create: `apps/service/tsconfig.json`
- Create: `apps/service/src/config.ts`
- Create: `apps/service/src/composition-root.ts`
- Create: `apps/service/src/research-operation-adapter.ts`
- Create: `apps/service/src/status-aggregator.ts`
- Create: `apps/service/src/main.ts`
- Create: `config/cosmo.example.json`
- Create: `tests/service/config.test.ts`
- Create: `tests/service/composition.test.ts`
- Create: `tests/service/research-operation-adapter.test.ts`
- Create: `tests/service/status.test.ts`

**Interfaces:**
- Consumes: public constructors and ports from Programs B–G; Program B `TrustDescriptorSchema` and `heritageRootCodec`; Program C's exact `epistemicRootCodec`, `negativeKnowledgeRootCodec`, `EpistemicRootSnapshotSchema`, and `NegativeKnowledgeRootSnapshotSchema`; Program D `questionRootCodec`, `programRootCodec`, `relationshipRootCodec`, `artifactIndexRootCodec`, `ResearchProgramService`, `EventAdmissionService`, `RuntimeStructuredRoleExecutionAdapter`, `RuntimePrincipalResearchExecutionAdapter`, `RuntimeIndependentCandidateReviewExecutionAdapter`, exact human-operation admission/create/control schemas, and exact mutation/list/page contracts; Program E `topologyRootCodec`, `activationRootCodec`, `cosmoMechanicalCrossRootValidator`, `CognitiveLifecycleEngine`, `DefaultModeStructuredRoleAdapter`, `DreamStructuredRoleAdapter`, `GenesisBrainService`, `createGenesisBrainService()`, `CreateGenesisBrainInputSchema`, and `GenesisBrainReceiptSchema`; Program F `ProductionInquiryExecutionPort`, `HumanInventPromotionService`, and the exact accepted mutation/inquiry services; and `buildCosmoApi()`.
- Produces: `StandaloneConfig`, `StandaloneResearchOperationAdapter`, the server-only `BrainMutationScopeResolver`/`HumanOperationAdmissionPort` implementations, `composeStandaloneService()`, `StatusAggregator`, and the COSMO-owned service entrypoint.

Program H imports Program E's frozen ownership boundary unchanged and defines only a
host-facing view with TypeScript's structural `Pick`; it never redeclares a
smaller lookalike:

```ts
import type { CognitiveLifecycleEngine } from '@cosmo/cognition';

export type CognitiveLifecycleHostPort = Pick<
  CognitiveLifecycleEngine,
  | 'acceptProgramMutation'
  | 'initialize'
  | 'reconcileProgramControl'
  | 'wakeDue'
  | 'inspect'
>;
```

The composed object remains one full, exact `CognitiveLifecycleEngine`, including
Program E semantic-root and candidate-agenda acceptance methods; only the
scheduler/research host receives `CognitiveLifecycleHostPort`. The picked
methods therefore retain the exact Program E input, output, retry, and conflict
types without H importing or reproducing them. Its initialization result carries
`outcome: 'initialized' | 'already_initialized'`, `initializationInputObjectId`,
and `state`; Program E owns byte-identical retry and typed conflict semantics.
Program E, not H, decides whether control converged and whether a host pulse
produces an expedition, default-mode proposal, Principal review, metabolism,
settlement, or no action. H reads `nextWakeAt` only from Program E state and
passes only the exact Program E host input, never a cognitive reason, Question,
lane, action, prompt, model, expedition, or sleep directive. If the exact
interface is absent, implementation stops for a cross-program contract
correction; H does not add an alias, shadow interface, or second lifecycle
engine.

- [ ] **Step 1: Write failing configuration and honest-status tests**

```ts
test('default configuration binds only to loopback', () => {
  const config = StandaloneConfigSchema.parse(minimalConfig);
  assert.equal(config.http.host, '127.0.0.1');
});

test('online process can report degraded Brain integrity', async () => {
  integrityPort.current = {
    state: 'degraded',
    blockers: [{
      component: 'repository',
      code: 'integrity_failure',
      retryable: false,
    }],
  };
  const status = await statusAggregator.read();
  assert.equal(status.service, 'degraded');
  assert.equal(status.epistemic, 'degraded');
  assert.deepEqual(status.blockers, integrityPort.current.blockers);
});

test('verified empty repository is online and ready for genesis', async () => {
  integrityPort.current = {
    state: 'verified_empty',
    blockers: [],
  };
  const status = await statusAggregator.read();
  assert.equal(status.service, 'online');
  assert.equal(status.research, 'idle');
  assert.equal(status.cognition, 'unchanged');
  assert.equal(status.epistemic, 'unknown');
  assert.equal(status.pinnedBrainCommitId, null);
});

test('service composition never probes another product', async () => {
  await composeStandaloneService(config, testDependencies);
  assert.deepEqual(networkProbe.calls, []);
  assert.deepEqual(serviceDiscovery.calls, []);
});

test('one D structured-role runtime is shared by every semantic role', async () => {
  const composed = await composeStandaloneService(config, testDependencies);
  assert.equal(
    testDependencies.structuredRoleExecutionFactory.calls.length,
    1,
  );
  const shared =
    testDependencies.structuredRoleExecutionFactory.calls[0].result;
  assert.equal(composed.roleExecution.principal.structuredExecution, shared);
  assert.equal(composed.roleExecution.defaultMode.structuredExecution, shared);
  assert.equal(composed.roleExecution.dream.structuredExecution, shared);
  assert.equal(
    composed.roleExecution.independentReviewer.structuredExecution,
    shared,
  );
  assert.equal(composed.roleExecution.inquiry.structuredExecution, shared);
  assert.equal(testDependencies.workerRuntimeDirectRoleCalls.length, 0);
});

test('composition supplies the exact nine accepted root codecs once', async () => {
  await composeStandaloneService(config, testDependencies);
  const exactCodecs = [
    epistemicRootCodec,
    questionRootCodec,
    programRootCodec,
    relationshipRootCodec,
    heritageRootCodec,
    topologyRootCodec,
    activationRootCodec,
    negativeKnowledgeRootCodec,
    artifactIndexRootCodec,
  ] as const;
  assert.deepEqual(repositoryFactory.calls[0].rootCodecs, exactCodecs);
  assert.deepEqual(exactCodecs.map((codec) => codec.rootKind), [
    'epistemicRoot',
    'questionRoot',
    'programRoot',
    'relationshipRoot',
    'heritageRoot',
    'topologyRoot',
    'activationRoot',
    'negativeKnowledgeRoot',
    'artifactIndexRoot',
  ]);
  assert.equal(
    epistemicRootCodec.payloadSchema,
    EpistemicRootSnapshotSchema.parse(epistemicRootFixture).schema,
  );
  assert.equal(
    negativeKnowledgeRootCodec.payloadSchema,
    NegativeKnowledgeRootSnapshotSchema.parse(
      negativeKnowledgeRootFixture,
    ).schema,
  );
});

test('composition delegates genesis to the accepted model-free core service', async () => {
  const composed = await composeStandaloneService(config, testDependencies);
  assert.deepEqual(createGenesisBrainService.calls[0], {
    repository: composed.repository,
    principalVersion: installedPrincipalVersion,
    kernelVersion: installedKernelVersion,
    genesisTrust: config.genesis.trust,
  });
  const receipt = await composed.apiPorts.brainOperation.createGenesis({
    draft: createGenesisBrainDraftFixture,
    context: genesisMutationContextFixture,
  });
  assert.deepEqual(receipt, genesisBrainReceiptFixture);
  assert.equal(genesisBrainService.calls.length, 1);
  assert.equal(modelRuntime.calls.length, 0);
  assert.equal(repositoryGenesisCas.calls.length, 1);
  assert.equal(repositoryGenesisCas.calls[0].expectedHead, null);
});

test('research create derives and admits scope before D sees an input', async () => {
  const composed = await composeStandaloneService(config, testDependencies);
  await composed.apiPorts.research.create({
    request: createResearchProgramRequestFixture,
    context: researchMutationContextFixture,
  });
  assert.equal(scopeResolver.resolveCreate.calls.length, 1);
  assert.deepEqual(
    humanOperationAdmission.calls[0].scope,
    resolvedProgramCreateScope,
  );
  assert.equal(
    eventAdmissionService.calls[0].eventType,
    'program_direction_proposed',
  );
  assert.deepEqual(
    researchProgramService.create.calls[0].eventScope,
    resolvedProgramCreateScope,
  );
  assert.equal(
    researchProgramService.create.calls[0].requestedByEventId,
    admittedHumanOperationEvent.eventId,
  );
  assert.equal(
    researchProgramService.create.calls[0].idempotencyKey,
    researchMutationContextFixture.domainIdempotencyKey,
  );
  assert.equal('eventScope' in createResearchProgramRequestFixture, false);
});

test('mismatched admitted scope never reaches Program D', async () => {
  humanOperationAdmission.nextDecision = admittedHumanOperationDecision({
    cognitiveEvent: {
      ...admittedHumanOperationEvent,
      scope: differentBrainLineageScope,
    },
  });
  const composed = await composeStandaloneService(config, testDependencies);
  await assert.rejects(
    composed.apiPorts.research.pause({
      programId,
      request: programMutationRequestFixture,
      context: researchMutationContextFixture,
    }),
    /admitted human-operation scope mismatch/,
  );
  assert.equal(researchProgramService.pause.calls.length, 0);
  assert.equal(cognitiveLifecycle.acceptProgramMutation.calls.length, 0);
});

for (const action of ['pause', 'resume', 'cancel'] as const) {
  test(`${action} admits only program_control_requested`, async () => {
    const harness = makeResearchOperationHarness({ action });
    await harness.adapter[action](
      controlOperationFixture({ action }),
    );
    assert.equal(
      harness.eventAdmission.calls[0].eventType,
      'program_control_requested',
    );
    assert.deepEqual(
      harness.researchProgramService[action].calls[0].eventScope,
      harness.scopeResolver.resolution.eventScope,
    );
  });
}
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
npm test -- tests/service/config.test.ts tests/service/composition.test.ts tests/service/research-operation-adapter.test.ts tests/service/status.test.ts
```

Expected: FAIL because the run fails with an unresolvable workspace specifier
(`ERR_MODULE_NOT_FOUND` for `@cosmo/service`) until implementation lands.

- [ ] **Step 3: Define exact standalone configuration**

Create private ESM workspace `@cosmo/service` with a `./src/main.ts` development entry, plus `build`, `test`, and `start` scripts. Every COSMO dependency uses `"*"`; the service has no Home23, PM2, or service-discovery dependency. Only the staged release manifest points at compiled `dist/main.js`.

```ts
export const StandaloneConfigSchema = z.object({
  schema: z.literal('cosmo.standalone-config.v1'),
  stateRoot: z.string().min(1),
  repositoryRoot: z.string().min(1),
  http: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1024).max(65535).default(43610),
    allowedOrigins: z.array(z.string().url()).default([]),
    transportSecurity: z.enum(['loopback_only', 'external_tls_terminated'])
      .default('loopback_only'),
  }).strict(),
  runtime: z.object({
    adapter: z.enum(['deterministic_conformance', 'openai_agents']),
    configRef: z.string().min(1),
  }).strict(),
  genesis: z.object({
    trust: TrustDescriptorSchema,
  }).strict(),
  scheduler: z.object({
    tickMs: z.number().int().min(250).default(1000),
    maxConcurrentExpeditions: z.number().int().positive(),
  }).strict(),
  workbench: z.object({
    enabled: z.boolean().default(true),
    assetRoot: z.string().min(1),
  }).strict(),
}).strict();
```

`stateRoot` defaults to the platform-resolved `~/.cosmo` only in the CLI initializer; tests and clean-room runs pass an explicit absolute root. The HTTP port defaults to 43610 (avoids the operator-machine collision with a Home23-managed cosmo23 on 43210 and standalone cosmo 2.3 on 431xx).

- [ ] **Step 3B: Register the workspace in the root lockfile before any dependent test**

Run `npm install` at the repo root, then commit the registry change before any test that imports the new workspace:

```bash
npm install
git add package.json package-lock.json apps/service/package.json apps/service/tsconfig.json
git commit -m "chore(service): register workspace"
```

- [ ] **Step 4: Compose only COSMO-owned services**

The composition root creates the object store, journal, kernel, corpus, runtime adapter, Program E `CognitiveLifecycleEngine` and `GenesisBrainService`, inquiry service, acceptance reader, API, wake-host scheduler, and status aggregator through public constructors. H calls only Program E's exact `createGenesisBrainService({ repository, principalVersion, kernelVersion, genesisTrust })`; `genesisTrust` is the installation/owner-approved `TrustDescriptorSchema` value from private configuration and is validated against the authenticated genesis authorization. E internally owns and orders the accepted C/D/E owner-only genesis builders and Program B parentless-CAS primitive. H cannot import, inspect, wrap, reorder, or replace those leaf builders. It does not assemble a parallel genesis/question/research/metabolism loop in H. It must not import legacy adapters into normal runtime composition; legacy input enters only through an explicit verified migration operation.

Composition constructs exactly one Program D
`RuntimeStructuredRoleExecutionAdapter` over the installed runtime controller,
receipt store, and exact structured-output boundary. That one object is injected
into D's `RuntimePrincipalResearchExecutionAdapter` and
`RuntimeIndependentCandidateReviewExecutionAdapter`, E's
`DefaultModeStructuredRoleAdapter` and `DreamStructuredRoleAdapter`, and F's
`ProductionInquiryExecutionPort`. The full E lifecycle receives those concrete
adapters plus the same D `DEVerticalGateResearchPort`; F's
`HumanInventPromotionService` receives that D
`DEVerticalGateResearchPort`/`ResearchRuntimeCoordinator` that owns committed
candidate review plus the full exact E acceptance adapter. No Principal, default-mode,
Dream, reviewer, or inquiry component receives `WorkerRuntime`, a provider SDK,
or a separately constructed structured-role adapter. Constructor-identity
tests and a static import check make duplicate adapters or direct semantic-role
runtime calls a build failure.

Before opening Program B, H imports and passes the exact nine accepted singleton codec objects, once each and in `BrainCommitPayload` field order: Program C `epistemicRootCodec`; Program D `questionRootCodec`, `programRootCodec`, and `relationshipRootCodec`; Program B `heritageRootCodec`; Program E `topologyRootCodec` and `activationRootCodec`; Program C `negativeKnowledgeRootCodec`; and Program D `artifactIndexRootCodec`. The two C singletons must declare the payload schema parsed by `EpistemicRootSnapshotSchema` and `NegativeKnowledgeRootSnapshotSchema`. F and H own no root codec. H does not wrap, instantiate, clone, adapt, or reconstruct any codec, and startup fails before repository access when the set has a missing/duplicate kind, wrong singleton object identity, or wrong payload schema. The same composition passes Program E's exact cross-root validator.

The composition constructs Program F's exact `MutationPreviewService` with its accepted Program B object/read/lease ports, authority-fingerprint dependencies, `InquiryService`, and accepted Program E mutation adapter. It also constructs Program F's exact `HumanInventPromotionService` with the shared D `DEVerticalGateResearchPort`/`ResearchRuntimeCoordinator`—already wired to the installed independent reviewer, evidence policy, ReviewLedger, and Principal—and the full E acceptance adapter. It then constructs the exact `ProgramFWorkbenchMutationAdapter` above with those F services plus H's server-only promotion-input and authority resolvers. Composition tests parse all four preview/consume calls through `PreviewSteerInputSchema`, `PreviewInventInputSchema`, `ConsumeSteerInputSchema`, and `ConsumeInventInputSchema`, parse promotion through `PromoteHumanInventCandidateInputSchema`, and assert that every forwarded `domainIdempotencyKey`/`idempotencyKey` equals the H outer idempotency-record identity. H contributes only verified receipt/head plus authenticated requester/authorization/idempotency/time context and closed error translation. It defines no preview store, fingerprint algorithm, preview hash algorithm, consumption state machine, review semantics, or mutation semantics.

The composition also constructs `StandaloneResearchOperationAdapter` with the
repository/root registry, canonical request store, authority resolver, Program
D `EventAdmissionService` adapter, `ResearchProgramService`, and Program E
acceptance/lifecycle ports, plus Program F's exact
`ProgramDirectionActivationService` and the server-only exact-input resolver.
Its `BrainMutationScopeResolver` implementation
derives scope only after lease-bound verified-head/state materialization. Its
`HumanOperationAdmissionPort` implementation reloads the stored request ref,
constructs/parses exact `AdmitHumanOperationEventInput`, and calls D admission.
The adapter then constructs/parses exact D create/control inputs with only the
resolved scope, admitted event ID, server authorization/time, and unchanged
`domainIdempotencyKey`. Static imports and runtime spies prove no route or
public client can instantiate a D mutation input directly, and no H component
can append a cognitive event without the D admission port. Agenda activation
resolves only to exact `ActivateProgramDirectionCandidateInput` and delegates
to Program F; the adapter does not inline D create, E acceptance, lifecycle
initialization, review, or Principal logic.

- [ ] **Step 5: Implement honest status aggregation**

Status reads independent ports for process lifecycle, Program E lifecycle state, Program D runtime states, cognitive journal/commit state, and repository integrity. A verified repository with zero Brain commits/refs and zero semantic journal events is a valid `service='online'`, `research='idle'`, `cognition='unchanged'`, `epistemic='unknown'`, `pinnedBrainCommitId=null` first-run state; it is not degraded and admits only the normal authenticated operations, including genesis. `service='online'` is otherwise allowed only when all startup gates pass. A Program D run is completion-pending exactly when `status === 'completed' && completionDelivered === false`; no synthetic completion-pending runtime status is invented. Any integrity failure sets `service='degraded'` without falsifying the research or cognition fields.

- [ ] **Step 6: Run service and dependency tests**

Run:

```bash
npm test -- tests/service/config.test.ts tests/service/composition.test.ts tests/service/research-operation-adapter.test.ts tests/service/status.test.ts tests/client/dependency-boundary.test.ts
npm run typecheck
```

Expected: PASS; static imports originate only from declared COSMO workspaces
and external commodities, every D create/control call carries the exact
resolver/admission scope and domain idempotency identity, and forged or
mismatched client/admission scope never reaches Program D.

- [ ] **Step 7: Commit service composition**

```bash
git add package-lock.json apps/service/src/config.ts apps/service/src/composition-root.ts apps/service/src/research-operation-adapter.ts apps/service/src/status-aggregator.ts apps/service/src/main.ts apps/service/package.json apps/service/tsconfig.json config/cosmo.example.json tests/service
git commit -m "feat(service): compose independent COSMO daemon"
```

---

### Task 6: Add Deterministic Startup Recovery, Scheduling, and Shutdown

**Files:**
- Create: `apps/service/src/startup-recovery.ts`
- Create: `apps/service/src/durable-scheduler.ts`
- Create: `apps/service/src/shutdown.ts`
- Modify: `apps/service/src/composition-root.ts`
- Create: `tests/service/startup-recovery.test.ts`
- Create: `tests/service/scheduler.test.ts`
- Create: `tests/service/shutdown.test.ts`
- Create: `docs/operations/lifecycle.md`

**Interfaces:**
- Consumes: Program B journal/repository recovery; Program D `RuntimeReconciler`, `WorkerRuntime.inspect()/pause()`, `ResearchProgramService.reconcile()/listPending()/listCanonical()`, `ListPendingProgramMutationsInput`/`PendingProgramMutationPage`, and `ListResearchProgramsInput`/`ResearchProgramPage`; Program E's exact `CognitiveLifecycleEngine.acceptProgramMutation()/initialize()/reconcileProgramControl()/wakeDue()/inspect()` contract; injected `Clock`; and the exact lifecycle identity.
- Produces: `runStartupRecovery()`, a host-only `DurableScheduler`, `ShutdownCoordinator`, and append-before-delivery wake records. It produces no research or metabolism policy.

- [ ] **Step 1: Write failing recovery and concurrency tests**

```ts
test('service is not ready before nonterminal runs reconcile', async () => {
  runtime.inspectResult = {
    ...runtimeRunStateFixture(),
    status: 'completed',
    completionDelivered: false,
  };
  const recovery = runStartupRecovery(dependencies);
  assert.equal(readiness.current(), 'starting');
  await recovery;
  assert.equal(readiness.current(), 'online');
  assert.equal(candidateAdmission.calls.length, 1);
});

test('pending create/control work converges before lifecycle enumeration', async () => {
  operationStore.initializationPending = [pendingCreateOperationFixture()];
  researchPrograms.pendingMutations = [pendingControlMutationFixture()];
  await runStartupRecovery(dependencies);
  assert.deepEqual(callOrder, [
    'runtime.reconcile',
    'resume-initialization-pending',
    'research.reconcile-pending-mutation',
    'lifecycle.reconcile-program-control',
    'lifecycle.inspect',
    'scheduler.enable',
  ]);
});

test('two schedulers cannot launch the same due expedition', async () => {
  clock.set('2026-07-30T12:00:00.000Z');
  await Promise.all([schedulerA.tick(), schedulerB.tick()]);
  assert.equal(lifecycleEngine.wakeDue.calls.length, 1);
  assert.deepEqual(
    Object.keys(lifecycleEngine.wakeDue.calls[0][0]).sort(),
    ['hostWakeId', 'observedAt', 'programId'],
  );
  assert.equal(runtime.runMission.calls.length <= 1, true);
});

test('shutdown preserves unresolved work without claiming completion', async () => {
  await shutdown.request('operator');
  assert.equal(runtime.pause.calls.length, 1);
  assert.equal(researchProgramService.pause.calls.length, 0);
  assert.equal(program.status, 'active');
  assert.equal(question.status, 'active');
});
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
npm test -- tests/service/startup-recovery.test.ts tests/service/scheduler.test.ts tests/service/shutdown.test.ts
```

Expected: FAIL because recovery, scheduling, and shutdown are not implemented.

- [ ] **Step 3: Implement the fixed startup sequence**

```text
load and verify release identity
  -> verify config and private-file permissions
  -> open object store and journal
  -> verify last-known-good refs
  -> bounded journal replay
  -> reconcile every nonterminal run with Program D RuntimeReconciler
  -> reconcile status='completed' and completionDelivered=false idempotently
  -> resume every H initialization_pending create operation with its original operation/idempotency identity
  -> page ResearchProgramService.listPending(ListPendingProgramMutationsInput) to exhaustion
  -> for any H operation whose D intent lacks a result, call ResearchProgramService.reconcile(programId) once under that operation identity
  -> deliver every exact pending ResearchProgramMutationResult through CognitiveLifecycleEngine.acceptProgramMutation()
  -> for create, resume its exact initialize() input; for control/finalization, call reconcileProgramControl() with the exact five-field delivery input
  -> await Program E convergence and the resulting canonical Program-root acceptance
  -> require both the H initialization_pending index and a fresh listPending() traversal to be empty
  -> page ResearchProgramService.listCanonical(ListResearchProgramsInput) against the accepted Brain/root context
  -> reconstruct each Program E lifecycle through CognitiveLifecycleEngine.inspect(programId)
  -> restore H-owned delivery claims from each returned lifecycleEpoch/nextWakeAt
  -> call wakeDue({programId, hostWakeId, observedAt}) for states already due
  -> expose readiness
```

Missing objects, an irreconcilable journal, a conflicting initialization retry, a rejected control notice, or any still-pending Program-root proposal enters degraded read-only mode. It never reports ordinary readiness. Neither `inspect()` nor due-state enumeration runs against a Research Program whose create/control mutation has not converged, and the scheduler is not enabled until both pending listings are empty.

- [ ] **Step 4: Implement append-before-delivery host scheduling**

Before delivering a due Program E host pulse, append:

```ts
interface HostWakeIntent {
  schema: 'cosmo.host-wake-intent.v1';
  intentId: ObjectId;
  hostWakeId: string;
  programId: ResearchProgramId;
  observedAt: string;
  observedLifecycleEpoch: number;
  observedNextWakeAt: string;
  attempt: number;
}
```

For each persisted Research Program, the host calls `inspect(programId)` and compares `clock.now()` only to the returned `nextWakeAt`. When due, it derives stable `hostWakeId = sha256(programId, lifecycleEpoch, nextWakeAt)`, atomically claims that ID in the H-owned delivery store, journals `HostWakeIntent`, and calls `wakeDue({programId, hostWakeId, observedAt})`. The successful claimant alone delivers; a retry reuses `programId`, `hostWakeId`, and the original `observedAt` and increments only the host attempt record. Program E independently treats `(programId, hostWakeId)` as its idempotency identity and reconstructs any decision without an outcome. H cannot calculate `nextWakeAt`, construct an expedition, choose a lane, originate a Question, decide sleep, invoke metabolism directly, synthesize a WakeBriefing, or advance a Brain ref.

- [ ] **Step 5: Implement bounded graceful shutdown**

Shutdown stops API admission and new host-pulse delivery, waits within the configured bound for an in-flight `wakeDue()` call, checkpoints remaining runtime processes through `WorkerRuntime.pause()`, lets an in-flight atomic commit finish, flushes journal handles, writes terminal service lifecycle state, and closes HTTP. This host checkpoint does not call `ResearchProgramService.pause()`, emit a `ProgramControlNotice`, or change the semantic Research Program status: an active program remains active/resumable across service restart unless an explicit authenticated pause operation already passed through D and E. If the bound expires, shutdown leaves the admitted `HostWakeIntent` unresolved so restart retries the same `hostWakeId`; Program E's journal then recovers its decision without a second action. It never marks a Question answered or research complete, and it never edits Program D or Program E lifecycle state directly.

- [ ] **Step 6: Run fault, recovery, and service tests**

Run:

```bash
npm test -- tests/service/startup-recovery.test.ts tests/service/scheduler.test.ts tests/service/shutdown.test.ts
npm test -- packages/repository/test/bitrot-recovery.test.ts packages/repository/test/crash-matrix.test.ts packages/runtime/test/runtime-reconciliation.test.ts packages/cognition/test/metabolism-faults.test.ts
```

Expected: PASS for initialization-pending recovery, pending Program-root/control convergence before lifecycle enumeration, stale host wake, lost run, duplicate wake delivery, `status='completed' && completionDelivered=false`, simultaneous scheduler, process interruption, and graceful-stop cases. Tests also fail if shutdown semantically pauses a Research Program, or on any H import of Program E implementation internals or direct call to expedition/metabolism constructors.

- [ ] **Step 7: Commit lifecycle mechanics**

```bash
git add apps/service/src/startup-recovery.ts apps/service/src/durable-scheduler.ts apps/service/src/shutdown.ts apps/service/src/composition-root.ts tests/service docs/operations/lifecycle.md
git commit -m "feat(service): recover and schedule durable cognition"
```

---

### Task 7: Build the Standalone CLI Without Broad Process Control

**Files:**
- Modify: `package-lock.json`
- Create: `packages/cli/package.json`
- Create: `packages/cli/tsconfig.json`
- Create: `packages/cli/src/output.ts`
- Create: `packages/cli/src/commands/init.ts`
- Create: `packages/cli/src/commands/lifecycle.ts`
- Create: `packages/cli/src/commands/open.ts`
- Create: `packages/cli/src/commands/research.ts`
- Create: `packages/cli/src/commands/brain.ts`
- Create: `packages/cli/src/commands/inquiry.ts`
- Create: `packages/cli/src/main.ts`
- Create: `packages/cli/src/index.ts`
- Create: `tests/cli/init.test.ts`
- Create: `tests/cli/lifecycle.test.ts`
- Create: `tests/cli/commands.test.ts`

**Interfaces:**
- Consumes: `@cosmo/client`, Task 5 config, and Program G `handleMigrationCommand()` and `handleAcceptanceCommand()`.
- Produces: the `cosmo` binary and exact command surface below.

- [ ] **Step 1: Write failing CLI behavior tests**

```ts
test('init creates private state without starting research', async () => {
  await runCli(['init', '--state-root', stateRoot], io);
  assert.equal((await fs.stat(stateRoot)).isDirectory(), true);
  assert.equal(await modeOf(`${stateRoot}/secrets`), 0o700);
  assert.equal(runtime.runMission.calls.length, 0);
});

test('brain create uses only the public genesis operation', async () => {
  await runCli([
    'brain', 'create',
    '--request', genesisDraftPath,
    '--idempotency-key', 'idem_genesis_cli_1',
  ], io);
  assert.deepEqual(client.createBrain.calls[0], [
    createGenesisBrainDraftFixture,
    { idempotencyKey: 'idem_genesis_cli_1' },
  ]);
  assert.equal(repository.calls.length, 0);
  assert.equal(modelRuntime.calls.length, 0);
  assert.match(io.stdout, new RegExp(genesisBrainReceiptFixture.brainCommitId));
});

test('stop refuses a mismatched lifecycle identity', async () => {
  lifecycleFile.startupNonceHash = sha256('old-instance');
  await assert.rejects(
    () => runCli(['stop', '--state-root', stateRoot], io),
    /instance identity does not match/,
  );
  assert.equal(signal.calls.length, 0);
});
```

- [ ] **Step 2: Run the focused CLI tests**

Run:

```bash
npm test -- tests/cli/init.test.ts tests/cli/lifecycle.test.ts tests/cli/commands.test.ts
```

Expected: FAIL because the run fails with an unresolvable workspace specifier (`ERR_MODULE_NOT_FOUND` for `@cosmo/cli`) until implementation lands.

- [ ] **Step 3: Implement initialization**

Create private ESM `@cosmo/cli` with development export `./src/index.ts`, development bin entry `cosmo: ./src/main.ts`, `tsc -p tsconfig.json` build, and root-runner tests. It depends on `@cosmo/client`, `@cosmo/product-contracts`, `@cosmo/foundation`, `@cosmo/migration`, and `@cosmo/acceptance` through `"*"`. The release builder alone rewrites the staged export and bin to compiled `dist/` targets.

`cosmo init`:

1. resolves `~/.cosmo` or an explicit `--state-root`;
2. refuses a nonempty incompatible root;
3. creates `config`, `repository`, `runtime`, `secrets`, `logs`, and `exports`;
4. applies `0700` to private directories and `0600` to secret/config files;
5. copies and validates `cosmo.example.json`;
6. creates a release identity, owner token, and machine-local encryption-domain identity;
7. materializes an owner-approved private, non-export-broadening `genesis.trust` through the exact `TrustDescriptorSchema` without taking trust from the later public Brain draft;
8. prints the token once to the attached terminal without logging it;
9. performs no model call, research launch, or canonical commit; and
10. prints the exact next steps `cosmo start`, `cosmo brain create --request <file>`, and then `cosmo research start --program <file>` without inventing IDs.

- [ ] **Step 3B: Register the workspace in the root lockfile before any dependent test**

Run `npm install` at the repo root, then commit the registry change before any test that imports the new workspace:

```bash
npm install
git add package.json package-lock.json packages/cli/package.json packages/cli/tsconfig.json
git commit -m "chore(cli): register workspace"
```

- [ ] **Step 4: Implement exact lifecycle commands**

```text
cosmo start [--foreground] [--state-root <absolute-path>]
cosmo stop [--state-root <absolute-path>]
cosmo status [--json]
cosmo open
```

Detached start uses `spawn(process.execPath, [serviceEntrypoint, ...], { detached: true })`, then waits for `/lifecycle/identity` and atomically records its identity. Stop authenticates to that exact service, compares `instanceId`, `startupNonceHash`, `executablePathHash`, and `releaseId`, then calls `/lifecycle/stop`. It never calls `pm2`, `pkill`, `killall`, or a wildcard process command.

- [ ] **Step 5: Implement research, Brain, and inquiry commands**

```text
cosmo research start --program <file>
cosmo research activate-agenda --request <activate-research-agenda.json>
cosmo research show <program-id>
cosmo research pause <program-id> --expected-status <status> --expected-control-epoch <n> --reason <text>
cosmo research resume <program-id> --expected-status <status> --expected-control-epoch <n> --reason <text>
cosmo research cancel <program-id> --expected-status <status> --expected-control-epoch <n> --reason <text>
cosmo brain create --request <create-genesis-brain-draft.json> [--idempotency-key <key>]
cosmo brain list [--limit <1-100>] [--after <cursor>] [--include-settled]
cosmo brain show <commit-id>
cosmo brain status <commit-id>
cosmo brain log <commit-id> [--limit <1-200>] [--after <cursor>]
cosmo brain diff <left-id> <right-id>
cosmo brain fork <commit-id> --branch <name> --expected-head <id> --purpose <text> [--covenant-difference <object-id>]
cosmo brain union --left <id> --right <id> --branch <name> --expected-head <id> --purpose <text>
cosmo brain tag <commit-id> --name <tag> --expected-current <id|none> --rationale <text>
cosmo brain settle <commit-id> --branch <name> --name <settlement> --expected-head <id> --rationale <text>
cosmo brain wake <commit-id> --settled <name> --wake-branch <name> --expected-wake-head <id|none> --rationale <text>
cosmo brain export <commit-id> --out <file> [--include-restricted --recipient-key <sha256>]
cosmo brain import <file> --branch <name> --expected-head <id|none> [--decryption-key-binding <sha256>]
cosmo brain verify <commit-id>
cosmo ask --request <inquiry-execution-input.json>
cosmo formation --request <formation-inquiry.json>
cosmo steer --request <workbench-steer-draft.json> [--yes --reviewed-preview-id <object-id> --reviewed-draft-hash <sha256>]
cosmo invent --request <workbench-invent-draft.json> [--yes --reviewed-preview-id <object-id> --reviewed-draft-hash <sha256>]
cosmo invent promote --receipt <invent-receipt.json>
cosmo compare --request <compare-input.json>
cosmo federate --request <federated-inquiry-input.json>
cosmo wake-briefing <commit-id>
cosmo events [--after <journal-cursor>] [--json-lines]
cosmo migrate ...
cosmo acceptance ...
```

Genesis, inquiry, formation, Steer, Invent, promotion, agenda activation, compare, and federation inputs have no safe CLI defaults. The CLI requires a JSON file and parses it through the frozen public schema. `brain create` parses only `CreateGenesisBrainDraftSchema`, calls `CosmoClient.createBrain()`, and prints the exact `GenesisBrainReceipt` commit/ref, nine root refs, Covenant/Relationship, seed Question, Heritage, ordered journal-event, journal-range, and CAS identities without printing private authorization. `formation` parses Program F's exact `FormationInquirySchema`, calls only `explainFormation()`, and prints the exact explanation without starting a model run. For Steer/Invent it parses only `WorkbenchSteerDraftSchema`/`WorkbenchInventDraftSchema`, calls the corresponding server preview endpoint, parses `WorkbenchMutationPreviewSchema`, and prints the exact expected head, draft hash, expiry, closed mechanical changes, and safe reviewer `{principalId, scopes}`. `invent promote` parses only the exact `InventReceiptSchema`; `research activate-agenda` parses only `ActivateResearchAgendaRequestSchema`. Neither command accepts review, Principal, policy, authority, lease, runtime, ref, or time overrides. They print the exact Program F promotion/activation receipts. The CLI never prints a grant, lease, fence, private authority binding, source/prompt body, or raw internal diff.

Interactive mode requires the operator to confirm the exact returned preview before the CLI builds Program F's four-field commit request from that preview. Noninteractive mode requires all three flags `--yes`, `--reviewed-preview-id <exact returned previewId>`, and `--reviewed-draft-hash <exact returned draftHash>`; either mismatch fails before the commit call. The preview and commit each get a separately generated idempotency key, and each key is reused unchanged only for transport retry of that same phase. The CLI never locally synthesizes a preview, skips preview, sends the draft to the commit route, or accepts `runtimeAuthorization`. Ask never mutates. Steer and Invent print the strict Program F receipt identity. For a program proposal the human output says `candidate created; reviewed target unchanged` and prints `resultRef`, `candidateRef`, and `targetRefAfterCommitId`; it never says the canonical target advanced or a Research Program started. Human-readable and `--json` output use the same parsed response object.

`research show` calls `CosmoClient.getProgram()`. Brain `status`, `log`, `tag`, `settle`, and `wake` call only their public client methods. Tag/settle/wake require stable idempotency keys and print the immutable Program B operation receipt; Brain wake restores the exact settled commit and does not directly pulse Program E. `stop` calls `CosmoClient.stopLifecycle()` after the local identity comparison. Tests prove none of these commands imports repository, research, cognition, or lifecycle implementation modules.

Freeze this complete CLI-to-route mapping; “generated idempotency” means one random key is created once per command invocation and reused unchanged on transport retry:

| Route | CLI source/default | Client call | Strict envelope |
| --- | --- | --- | --- |
| `GET /status` | `status`; no input | `status()` | empty params/query/body |
| `GET /lifecycle/identity` | `start/stop` verification; no input | `lifecycleIdentity()` | empty |
| `POST /session/exchange-codes` | `open`; scopes=`read,query,steer,operate,export`, returnPath=`/`, generated idempotency | `createBrowserSessionCode(input, options)` | body=`CreateBrowserSessionCodeInput` |
| `POST /session/exchange` | browser fragment callback only; exact one-time code | browser gateway | body=`{exchangeCode}`; never general CLI input |
| `POST /brains` | schema-validated genesis draft file; supplied key or one generated once | `createBrain()` | body=`CreateGenesisBrainDraft`; exact `GenesisBrainReceipt` |
| `GET /brains` | list flags; exact F request with `schema`, cursor=`null`, limit=50, includeSettled=false defaults | `listBrains()` | URL omits null cursor; server reconstructs `WorkbenchBrainCatalogRequest` |
| `GET /brains/:commitId` | show positional ID | `getBrain()` | commit params |
| `GET /brains/:commitId/status` | status positional ID | `getBrainStatus()` | commit params |
| `GET /brains/:commitId/log` | log ID/limit/after | `getBrainLog()` | commit params + bounded query |
| `GET /brains/:commitId/diff` | left path, right query | `diffBrains()` | commit params + `rightCommitId` |
| `GET /brains/:commitId/verification` | verify positional ID | `verifyBrain()` | commit params |
| `POST /brains/:commitId/fork` | all required flags; absent covenant difference=`null` | `forkBrain()` | exact fork body |
| `POST /brains/union` | all five required flags | `unionBrains()` | exact union body |
| `POST /brains/:commitId/tags` | name/expected-current/rationale | `tagBrain()` | `none` maps only to JSON `null` |
| `POST /brains/:commitId/settle` | branch/name/expected-head/rationale | `settleBrain()` | exact settle body |
| `POST /brains/:commitId/wake` | settled/wake-branch/expected/rationale | `wakeBrain()` | `none` maps only to JSON `null` |
| `POST /brains/export` | commit; restricted=false unless paired flags present | `exportBrain()` | exact export body |
| `POST /brains/import` | verified file bytes/hash plus explicit expected head | `importBrain()` | exact import body |
| `POST /inquiries` | schema-validated request file | `query()` | body=`InquiryExecutionInput` |
| `POST /formations` | exact schema-validated formation file; no defaults | `explainFormation()` | body=`FormationInquiry` |
| `POST /steering/previews` | schema-validated `WorkbenchSteerDraft` file; generated preview idempotency | `previewSteer()` | body=`WorkbenchSteerDraft` |
| `POST /steering` | exact live preview identity/hash/head after explicit review; generated commit idempotency | `commitSteer()` | body=`WorkbenchSteerCommitRequest` |
| `POST /inventions/previews` | schema-validated `WorkbenchInventDraft` file; generated preview idempotency | `previewInvent()` | body=`WorkbenchInventDraft` |
| `POST /inventions` | exact live preview identity/hash/head after explicit review; generated commit idempotency | `commitInvent()` | body=`WorkbenchInventCommitRequest` |
| `POST /inventions/promotions` | exact `InventReceipt` file; generated idempotency | `promoteHumanInventCandidate()` | body=`{inventReceipt}` |
| `POST /comparisons` | schema-validated request file | `compare()` | body=`CompareInput` |
| `POST /federations` | schema-validated request file | `federate()` | body=`FederatedInquiryInput` |
| `GET /wake-briefings/:commitId` | positional commit | `getWakeBriefing()` | commit params |
| `POST /research/programs` | exact validated `--program` file | `createProgram()` | body=`CreateResearchProgramRequest` |
| `POST /research/agendas/activate` | exact authority-free activation request file; generated idempotency | `activateResearchAgenda()` | body=`ActivateResearchAgendaRequest`; exact `ProgramDirectionActivationReceipt` |
| `GET /research/programs/:programId` | show positional ID | `getProgram()` | program params |
| `POST /research/programs/:programId/pause` | expected-status/control-epoch/reason, generated idempotency | `pauseProgram()` | exact mutation body |
| `POST /research/programs/:programId/resume` | expected-status/control-epoch/reason, generated idempotency | `resumeProgram()` | exact mutation body |
| `POST /research/programs/:programId/cancel` | expected-status/control-epoch/reason, generated idempotency | `cancelProgram()` | exact mutation body |
| `GET /events` | optional after; output only as stream/JSON lines | `events()` | bounded cursor query |
| `POST /lifecycle/stop` | exact local identity, reason=`operator`, generated idempotency | `stopLifecycle()` | exact stop body |

`tests/cli/commands.test.ts` table-drives these 36 rows against the client transport table and route manifest. It asserts every required flag/file field reaches exactly one params/query/body location, every documented default is the value parsed by the strict schema, `none` alone maps to null, unsafe omissions fail before network access, each phase's idempotency key survives only its own retry, interactive review and noninteractive preview-ID/draft-hash checks match the live server preview, and stale/expired/consumed previews fail closed. Dedicated assertions require genesis to use the exact core draft/receipt with zero model calls or CLI authority fields; formation to remain a model-free read; human promotion and agenda activation to reject tags, settled refs, moved heads, forged receipts, and client-supplied authority/review fields; program-proposal output to name the candidate result and unchanged target without “advanced”/“started” language; reject any non-human Invent origin; and prove no CLI-only authority or `runtimeAuthorization` field appears.

- [ ] **Step 6: Implement safe browser launch**

`cosmo open` requests a one-time browser code over the authenticated loopback API and passes it only in the URL fragment. It invokes the platform browser opener without shell interpolation.

- [ ] **Step 7: Run CLI, client, and lifecycle tests**

Run:

```bash
npm test -- tests/cli tests/client tests/service/shutdown.test.ts
npm run typecheck
```

Expected: PASS, including paths with spaces, stale lifecycle files, occupied ports, already-running service, already-stopped service, token redaction, JSON output, SIGINT foreground shutdown, exact one-time genesis creation/retry, get-program, Git-for-brains status/log/tag/settle/wake, stable mutation retry keys, and authority-field rejection.

- [ ] **Step 8: Commit the standalone CLI**

```bash
git add package-lock.json packages/cli tests/cli
git commit -m "feat(cli): operate standalone COSMO safely"
```

---

### Task 8: Serve the Exact Program F Workbench Build

**Files:**
- Create: `apps/service/src/static-workbench.ts`
- Modify: `apps/service/src/composition-root.ts`
- Create: `tests/service/static-workbench.test.ts`
- Create: `tests/release/workbench-build-identity.test.ts`

**Interfaces:**
- Consumes: the generated, untracked `apps/workbench/dist/` created by Program F and the relative `/api/v1` gateway contract already tested in Program F.
- Produces: immutable static serving, SPA fallback outside `/api`, a workbench asset manifest, and content-security headers.

- [ ] **Step 1: Write failing static-serving tests**

```ts
test('service returns the exact manifest-hashed workbench asset', async () => {
  const response = await app.inject({ method: 'GET', url: '/assets/app.js' });
  assert.equal(response.statusCode, 200);
  assert.equal(sha256(response.rawPayload), assetManifest['assets/app.js']);
});

test('SPA fallback never masks an API 404', async () => {
  assert.equal((await app.inject({
    method: 'GET',
    url: '/api/v1/not-a-route',
  })).statusCode, 404);
});
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
npm run build --workspace apps/workbench
npm test -- tests/service/static-workbench.test.ts tests/release/workbench-build-identity.test.ts
```

Expected: FAIL because the service has no static workbench handler or manifest.

- [ ] **Step 3: Implement immutable asset serving**

At service build time, hash every file under `apps/workbench/dist/` and write the generated manifest into the service build output. Hashed assets receive `Cache-Control: public, max-age=31536000, immutable`; `index.html` receives `no-cache`. The handler refuses an asset whose bytes do not match the release manifest.

- [ ] **Step 4: Enforce browser security headers**

Return a restrictive CSP with `default-src 'self'`, no inline scripts, same-origin API connections, `object-src 'none'`, `base-uri 'none'`, and `frame-ancestors 'none'`. Also set `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Cross-Origin-Resource-Policy: same-origin`.

- [ ] **Step 5: Verify Program F remains the sole workbench source owner**

Run:

```bash
git diff -- apps/workbench
npm test --workspace @cosmo/workbench
npm test -- tests/service/static-workbench.test.ts tests/release/workbench-build-identity.test.ts
```

Expected: no tracked Program H diff under `apps/workbench`; all Program F tests and packaging identity tests PASS.

- [ ] **Step 6: Commit only service-side packaging**

```bash
git add apps/service/src/static-workbench.ts apps/service/src/composition-root.ts tests/service/static-workbench.test.ts tests/release/workbench-build-identity.test.ts
git commit -m "feat(service): package the research workbench"
```

---

### Task 9: Build and Verify the Standalone Release Archive

**Files:**
- Create: `scripts/build-standalone-release.mjs`
- Create: `scripts/install-standalone-release.mjs`
- Create: `scripts/verify-standalone-release.mjs`
- Modify: `package.json`
- Create: `tests/release/archive.test.ts`
- Create: `tests/release/install.test.ts`
- Create: `tests/release/package-exports.test.ts`
- Create: `tests/release/accepted-core-bridge.test.ts`
- Create: `docs/operations/install.md`

**Interfaces:**
- Consumes: an H `releaseSourceCommit`, compiled npm workspaces, Program F workbench output, the exact committed canonical raw G receipt at `docs/receipts/program-g-shadow-acceptance.json`, and an operator release-signing key supplied by file descriptor or local key reference.
- Produces outside the source tree: `cosmo-standalone.tgz`, `release-manifest.json`, `release-manifest.sig`, `release-public-key.pem`, a byte-identical verified `program-g-receipt.json` handoff, a `packagedCoreArtifactSetId`, and a verified installation.

- [ ] **Step 1: Write failing reproducibility and tamper tests**

```ts
test('two builds from the same commit have the same file manifest', async () => {
  const first = await buildRelease({ sourceDateEpoch: 1785412800 });
  const second = await buildRelease({ sourceDateEpoch: 1785412800 });
  assert.deepEqual(first.manifest.files, second.manifest.files);
  assert.equal(
    first.manifest.releaseSourceCommit,
    second.manifest.releaseSourceCommit,
  );
});

test('installer refuses one changed byte', async () => {
  await mutateArchiveFile(archive, 'package/apps/service/dist/main.js');
  await assert.rejects(
    () => installRelease({ archive, prefix, stateRoot }),
    /manifest verification failed/,
  );
});

test('later H source is accepted only when packaged core bytes equal G', async () => {
  const release = await buildRelease({
    releaseSourceCommit: hCommit,
    programGReceiptPath: canonicalProgramGReceiptPath,
  });
  assert.notEqual(release.manifest.releaseSourceCommit, gReceipt.coreAcceptedSourceCommit);
  assert.equal(
    release.manifest.packagedCoreArtifactSetId,
    gReceipt.coreArtifactSetId,
  );
});

test('one changed accepted-core byte rejects packaging', async () => {
  await mutateStagedFile('packages/cognition/dist/index.js');
  await assert.rejects(
    () => buildRelease({
      releaseSourceCommit: hCommit,
      programGReceiptPath: canonicalProgramGReceiptPath,
    }),
    /packaged core differs from Program G accepted core/,
  );
});

test('H source never changes a Program G accepted workspace', async () => {
  const acceptedRoots = deriveWorkspaceRoots(gReceipt.coreArtifactSet.files);
  const changed = await gitChangedPaths({
    from: gReceipt.coreAcceptedSourceCommit,
    to: hCommit,
    roots: acceptedRoots,
  });
  assert.deepEqual(changed, []);
  assert.equal(acceptedRoots.includes('packages/contracts'), true);
  assert.equal(acceptedRoots.includes('packages/product-contracts'), false);
});

test('manifest rejects hostile paths, ordering, modes, and missing entrypoints', () => {
  for (const manifest of [
    releaseManifestFixture({ filePath: '../escape' }),
    releaseManifestFixture({ duplicatePath: true }),
    releaseManifestFixture({ reverseFileOrder: true }),
    releaseManifestFixture({ fileMode: 0o777 }),
    releaseManifestFixture({ missingCliEntrypoint: true }),
  ]) {
    assert.throws(() => StandaloneReleaseManifestSchema.parse(
      withRecomputedReleaseId(manifest),
    ));
  }
});

test('manifest rejects wrong self hash, signature, and artifact bridge', async () => {
  assert.throws(() => StandaloneReleaseManifestSchema.parse(
    releaseManifestFixture({ releaseId: sha256('wrong') }),
  ));
  await assert.rejects(
    () => verifyReleaseManifest(validManifest, wrongDetachedSignature, publicKey),
    /signature verification failed/,
  );
  assert.throws(() => StandaloneReleaseManifestSchema.parse(
    withRecomputedReleaseId(releaseManifestFixture({
      packagedCoreArtifactSetId: sha256('different core'),
    })),
  ));
});
```

- [ ] **Step 2: Run the focused tests**

Run:

```bash
npm test -- tests/release/archive.test.ts tests/release/install.test.ts tests/release/accepted-core-bridge.test.ts
```

Expected: FAIL because the release builder, verifier, and installer do not exist.

- [ ] **Step 3: Implement an allowlisted release build**

The builder:

1. refuses uncommitted source changes;
2. records the exact H `releaseSourceCommit`;
3. reads `docs/receipts/program-g-shadow-acceptance.json` as immutable bytes, requires canonical encoding, recomputes its `programGReceiptId`, verifies the G signature/status/profile, and retains its distinct `coreAcceptedSourceCommit` and `coreArtifactSetId`;
4. runs build, focused product tests, contracts, and accepted A–G gate verification, then copies those exact raw G receipt bytes to `program-g-receipt.json` without reserialization or resigning;
5. stages every G-declared logical core artifact path, hashes the staged bytes with the exact G algorithm, builds `packagedCoreArtifactSetId`, and refuses release unless it equals G's `coreArtifactSetId` and every path/hash/length/mode entry matches byte-for-byte;
6. copies only root package metadata, compiled workspace `dist/`, workbench `dist/`, configuration example, installer, license, and operational docs;
7. rewrites each staged workspace's development export from `./src/index.ts` to `./dist/index.js`, rewrites bins to compiled entrypoints, and fails if any rewritten target is absent;
8. rejects secret, instance, log, cache, `.env`, credential, transcript, or historical-root paths;
9. normalizes archive ownership, permissions, ordering, and timestamps from `SOURCE_DATE_EPOCH`;
10. hashes every file with SHA-256;
11. signs canonical manifest bytes with Ed25519; and
12. emits the archive outside the source tree.

`accepted-core-bridge.test.ts` proves the G and H commits are allowed to differ, the G receipt bytes/object ID/signature never change, every G core logical path is present exactly once, and `packagedCoreArtifactSetId === coreArtifactSetId`. It derives accepted source workspace roots from those exact G logical paths and requires an empty Git diff from `coreAcceptedSourceCommit` through `releaseSourceCommit` under every derived root, including `packages/contracts` and `apps/workbench`; H-owned `packages/product-contracts`, API, client, CLI, service, release scripts, docs, and root workspace metadata remain outside that set. Any accepted-core source or compiled-byte delta requires a new full Program G run and new raw G receipt before H can continue. `package-exports.test.ts` separately proves the committed development manifests still point at source entries, then extracts the archive and proves only the staged copies were rewritten. It installs production dependencies and enumerates/imports every root and conditional/subpath export of every packaged `@cosmo/*` workspace, including `@cosmo/acceptance/core-candidate-entrypoint`, plus the service and CLI entrypoints. It asserts that no packaged manifest value references `src/`, every `exports`, `main`, `types`, and `bin` target exists inside the archive, no target escapes its package, ESM imports succeed in a fresh process, `cosmo --help` executes from the compiled bin, and the service entrypoint reaches configuration validation without a TypeScript loader.

- [ ] **Step 4: Define the release manifest**

```ts
const ReleaseArchivePathSchema = z.string()
  .min(1)
  .max(512)
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9._/-]+$/);

export const StandaloneReleaseFileSchema = z.object({
  path: ReleaseArchivePathSchema,
  sha256: Sha256Schema,
  byteLength: z.number().int().nonnegative(),
  mode: z.union([z.literal(0o644), z.literal(0o755)]),
}).strict();

export const StandaloneReleaseManifestSchema = z.object({
  schema: z.literal('cosmo.standalone-release.v1'),
  releaseId: Sha256Schema,
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  releaseSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  programGReceiptId: ObjectIdSchema,
  coreAcceptedSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  coreArtifactSetId: Sha256Schema,
  packagedCoreArtifactSetId: Sha256Schema,
  sourceDateEpoch: z.number().int().nonnegative(),
  nodeRange: z.literal('>=22.12.0'),
  entrypoints: z.object({
    service: ReleaseArchivePathSchema,
    cli: ReleaseArchivePathSchema,
    installer: ReleaseArchivePathSchema,
  }).strict(),
  workspaceVersions: z.record(
    z.string().regex(/^@cosmo\/[a-z0-9-]+$/),
    z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  ),
  files: z.array(StandaloneReleaseFileSchema).min(1),
}).strict().superRefine((manifest, context) => {
  const paths = manifest.files.map((file) => file.path);
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  const entrypoints = Object.values(manifest.entrypoints);
  const { releaseId: _releaseId, ...unsigned } = manifest;

  if (
    new Set(paths).size !== paths.length
    || !paths.every((path, index) => path === sorted[index])
  ) {
    context.addIssue({
      code: 'custom',
      path: ['files'],
      message: 'release file paths must be unique and canonically sorted',
    });
  }
  if (!entrypoints.every((entrypoint) => paths.includes(entrypoint))) {
    context.addIssue({
      code: 'custom',
      path: ['entrypoints'],
      message: 'every entrypoint must be a manifested archive file',
    });
  }
  if (manifest.coreArtifactSetId !== manifest.packagedCoreArtifactSetId) {
    context.addIssue({
      code: 'custom',
      path: ['packagedCoreArtifactSetId'],
      message: 'packaged core differs from Program G accepted core',
    });
  }
  if (manifest.releaseId !== sha256(canonicalJsonBytes(unsigned))) {
    context.addIssue({
      code: 'custom',
      path: ['releaseId'],
      message: 'release ID does not match canonical self-omitting manifest bytes',
    });
  }
});

export type StandaloneReleaseManifest =
  z.infer<typeof StandaloneReleaseManifestSchema>;
```

`verifyReleaseManifest()` parses this schema, recomputes `releaseId` with only that field omitted, verifies the detached Ed25519 signature over the exact canonical manifest bytes, then verifies every archive byte/mode against `files`. `releaseSourceCommit` and `coreAcceptedSourceCommit` are separately validated identities; artifact equality never becomes Git-commit equality and never rebinds the G signature.

- [ ] **Step 5: Implement verified, non-destructive installation**

The installer requires explicit `--prefix` and `--state-root` in automation; interactive use defaults to platform application storage and `~/.cosmo`. It verifies signature and every file before writing, stages into a sibling temporary directory, runs `npm ci --omit=dev --ignore-scripts`, checks Node compatibility, and atomically advances a `current` release link. It never overwrites a non-COSMO directory and preserves prior releases for rollback.

- [ ] **Step 6: Add exact package scripts**

```json
{
  "scripts": {
    "release:build": "node scripts/build-standalone-release.mjs",
    "release:verify": "node scripts/verify-standalone-release.mjs",
    "release:test": "node --test --import tsx tests/release/*.test.ts"
  }
}
```

- [ ] **Step 7: Run archive, install, upgrade, and rollback tests**

Run:

```bash
npm test -- tests/release/archive.test.ts tests/release/install.test.ts tests/release/package-exports.test.ts tests/release/accepted-core-bridge.test.ts
```

Expected: PASS using synthetic committed-tree fixtures; wrong self hash, bad signature, duplicate/unsorted paths, traversal, backslash, invalid mode, missing entrypoint, artifact-bridge mismatch, byte tampering, unsigned manifest, symlink escape, wrong Node version, nonempty foreign prefix, interrupted install, and failed health-check upgrade are rejected without losing the last-known-good release. A signed candidate release is built only from the clean commit in Task 11.

- [ ] **Step 8: Commit release packaging**

```bash
git add scripts/build-standalone-release.mjs scripts/install-standalone-release.mjs scripts/verify-standalone-release.mjs package.json tests/release/archive.test.ts tests/release/install.test.ts tests/release/package-exports.test.ts tests/release/accepted-core-bridge.test.ts docs/operations/install.md
git commit -m "feat(release): package verifiable standalone COSMO"
```

---

### Task 10: Enforce Product Separation and the Future-Client Authorization Gate

**Files:**
- Create: `tests/product/standalone-boundary.test.ts`
- Create: `tests/product/public-client-parity.test.ts`
- Modify: `docs/architecture/client-boundary.md`
- Create: `docs/architecture/future-adapters.md`

**Interfaces:**
- Consumes: release manifest, npm dependency graph, built JavaScript import graph, route manifest, and `CosmoClient`.
- Produces: a static separation receipt and a documented post-release authorization gate for any future product adapter.

- [ ] **Step 1: Write the failing static-boundary test**

```ts
test('standalone runtime has no Home23 dependency or discovery path', async () => {
  const graph = await inspectReleaseGraph(releaseRoot);
  assert.deepEqual(graph.forbiddenPackageEdges, []);
  assert.deepEqual(graph.forbiddenRuntimeImports, []);
  assert.deepEqual(graph.processSupervisorCommands, []);
  assert.deepEqual(graph.foreignMutableStatePaths, []);
  assert.deepEqual(graph.foreignServiceEndpoints, []);
});
```

- [ ] **Step 2: Prove public-client parity**

The parity test begins with genesis creation on a fresh disposable repository through `CosmoClient`, verifies the exact retry and second-genesis rejection through the CLI, then performs status, pinned Ask, Steer proposal, research pause/resume, Brain diff, fork, union, export/import, and event resume through `CosmoClient`. It compares the public receipts with the CLI calls and proves neither channel has a private repository or kernel bypass.

- [ ] **Step 3: Define the later adapter gate without implementing an adapter**

`docs/architecture/future-adapters.md` must state that any future Home23 or other product client:

1. starts only after the Program H clean-release receipt and separate operator authorization;
2. runs out of process;
3. uses only `@cosmo/client` or the documented `/api/v1` contract;
4. has no privilege unavailable to another client with the same scopes;
5. cannot supervise liveness, import internals, share mutable state, or bypass receipts;
6. passes public-client parity and revocation tests; and
7. is delivered in a separate plan and commit series.

- [ ] **Step 4: Run static and parity checks**

Run:

```bash
npm test -- tests/product/standalone-boundary.test.ts tests/product/public-client-parity.test.ts tests/client/dependency-boundary.test.ts
npm ls --all
```

Expected: PASS with no extraneous dependency, forbidden import, supervisor command, foreign mutable-state path, or privileged client operation.

- [ ] **Step 5: Commit the separation gate**

```bash
git add tests/product/standalone-boundary.test.ts tests/product/public-client-parity.test.ts docs/architecture/client-boundary.md docs/architecture/future-adapters.md
git commit -m "test(product): enforce constitutional separation"
```

---

### Task 11: Produce the External Clean-Room Lifecycle Receipt

**Files:**
- Create: `scripts/prepare-clean-room-context.mjs`
- Create: `tests/release/Dockerfile`
- Create: `tests/release/tsconfig.json`
- Create: `tests/release/clean-environment.ts`
- Create: `tests/release/clean-room-scenario.ts`
- Create: `tests/release/trace-audit.ts`
- Create: `tests/release/clean-room.test.ts`
- Create: `docs/receipts/program-h-clean-release.md`

**Interfaces:**
- Consumes: signed Program G profile bundle and receipt, signed Program H release archive, the exact authority-free first-run `CreateGenesisBrainDraft`, the same signed live-provider/runtime/tool identities accepted by Program G, a credential-broker file descriptor/socket, signed clean-environment policy, and external filesystem/network/proxy traces. Deterministic conformance is used only by the focused harness/fault tests.
- Produces: a signed `cosmo.program-h-clean-release.v1` receipt and the final technical go/no-go result.

- [ ] **Step 1: Write the failing clean-room receipt test**

```ts
test('receipt requires every lifecycle operation and external trace audit', () => {
  assert.throws(() => ProgramHCleanReleaseReceiptSchema.parse({
    schema: 'cosmo.program-h-clean-release.v1',
    status: 'accepted',
    probes: {
      install: passedProbe,
      launch: passedProbe,
    },
  }));
});

test('accepted receipt cannot hide a failed probe', () => {
  assert.throws(() => ProgramHCleanReleaseReceiptSchema.parse(
    cleanReleaseReceiptFixture({
      status: 'accepted',
      probes: { guidedBlocked: failedProbe },
    }),
  ));
});
```

- [ ] **Step 2: Compile the H-owned harness and create an allowlisted temporary Docker context**

`tests/release/tsconfig.json` compiles `clean-environment.ts`, `clean-room-scenario.ts`, and `trace-audit.ts` to ESM JavaScript. No TypeScript source is copied into the image and no file under Program G-owned `packages/acceptance/` is created or modified.

`scripts/prepare-clean-room-context.mjs` accepts explicit paths to the signed release archive, release verification key, signed Program G profile bundle, the exact canonical raw Program G receipt, the strict authority-free genesis draft, a trusted-input signing key file descriptor, and output directory. It verifies the raw receipt's canonical bytes/object ID/signature without changing them, parses the genesis draft through Program E's exact `CreateGenesisBrainDraftSchema`, derives and writes the matching profile public verification key, reads the exact base-image/egress-proxy digests from the signed environment policy, refuses a nonempty output directory, verifies every input first, compiles the three harness files, and creates a directory containing exactly:

```text
Dockerfile
cosmo-standalone.tgz
release-public-key.pem
program-g-profile.tgz
program-g-profile-public-key.pem
program-g-receipt.json
create-genesis-brain-draft.json
trusted-inputs.json
trusted-inputs.sig
trusted-inputs-public-key.pem
harness/clean-environment.js
harness/clean-room-scenario.js
harness/trace-audit.js
```

`trusted-inputs.json` canonically records every filename/hash/byte length; H `releaseId` and `releaseSourceCommit`; G `programGReceiptId`, `coreAcceptedSourceCommit`, and `coreArtifactSetId`; H `packagedCoreArtifactSetId`; the equality proof over every accepted core entry; Program G profile ID; the canonical genesis-draft hash; compiled harness hashes; Node base-image digest; egress-proxy image digest; credential-broker key ID; exact allowed provider/search/acquisition hostnames and ports; exact environment-key allowlist; and the single writable state root. It explicitly models the two source commits as distinct identities and never claims the G signature covers H. The preparation command signs it before any image build. A directory listing with any additional entry rejects the context.

`tests/release/Dockerfile` uses the trusted digest-pinned Node 22 Bookworm Slim base, installs only `strace`, creates an unprivileged `cosmo` user, and has literal `COPY` statements for only the 12 non-Dockerfile entries above. It never uses `COPY .`, `ADD` from a URL, a source-repository mount, user home, external drive, or another checkout.

- [ ] **Step 3: Run the exact packaged lifecycle and sustained-scheduler scenario**

Inside the container:

```text
verify trusted-input signature and every context hash
verify archive signature and hashes
verify exact canonical Program G profile and raw acceptance receipt
verify G coreArtifactSetId equals H packagedCoreArtifactSetId entry-for-entry
  -> install to /opt/cosmo
  -> initialize state at /var/lib/cosmo
  -> launch the packaged standalone service with signed live-provider identities
  -> verify separate status dimensions
  -> verify the Brain catalog is empty
  -> create the sole Genesis Brain through `cosmo brain create` using the signed authority-free draft
  -> parse the exact GenesisBrainReceipt and verify its parentless commit, nine roots, covenantPayloadRef, ordered Relationship event refs/IDs, ordered seed questionId/questionRef/originEventId records, heritageCurationEventId, ordered journal events/range, and one absent-ref CAS
  -> retry with the same idempotency key and require the byte-identical receipt with no second CAS; reject a changed-key second genesis
  -> read the Genesis Brain through CosmoClient, take title/purpose/mode/stopping rules/block conditions/budget only from the signed guided first-run profile fixture, and create the first Research Program using exactly the receipt's Brain commit, Covenant, admitted seed Questions, and branch head
  -> require the D create/E initialize handshake to reach canonical `active` before any scheduler observation
  -> externally observe the packaged scheduler for at least 28,800,000 monotonic ms
  -> prove H delivered only `{programId, hostWakeId, observedAt}` pulses to Program E and never recreated lifecycle policy
  -> run the signed autonomous and Pure cases through repeated scheduler wake cycles
  -> run satisfiable guided program
  -> run deliberately blocked guided program
  -> discover, acquire, snapshot, span, review, promote, and query new evidence
  -> execute transactional sleep and wake
  -> query pinned pre-existing cognition
  -> execute Steer and Invent through preview then commit in both public client and CLI
  -> prove program-proposal Steer creates only its absent deterministic candidate ref and leaves targetRef unchanged
  -> prove Invent accepts only a human-origin candidate and no runtime authorization
  -> read exact formation through public client and CLI with zero new model execution
  -> independently review and promote the human Invent candidate through public client and CLI
  -> activate the reviewed program-direction candidate through public client and CLI
  -> prove changed-head, changed-authority, expired, and consumed-preview rejection
  -> prove same-key retry returns the original preview/receipt without a second domain call
  -> fork a Brain
  -> losslessly union two branches
  -> run Brain status, log, tag, settle, and wake through CLI and public client
  -> encrypted export and import, then import every packaged workspace export
  -> stop exact service
  -> restart and reconcile
  -> verify commit, journal, relationship, and negative-knowledge continuity
  -> verify public-client/CLI parity
```

- [ ] **Step 4: Audit filesystem, scheduler, provider, and network traces outside COSMO**

The COSMO container has only an internal Docker network. A separately digest-pinned CONNECT proxy is the sole member of both that internal network and an egress network; it permits only the signed host/port allowlist and emits an externally retained connection log. Provider credentials are absent from the context and image; a read-only credential-broker Unix socket is mounted at `/run/cosmo-acceptance/credential-broker.sock` and binds credentials to the signed public identities.

Inside the COSMO container, run:

```bash
strace -ff -o /tmp/cosmo-trace -e trace=file,network \
  node /fixtures/harness/clean-room-scenario.js \
  --cosmo-cli /opt/cosmo/current/bin/cosmo \
  --profile-bundle /fixtures/program-g-profile.tgz \
  --program-g-receipt /fixtures/program-g-receipt.json \
  --genesis-draft /fixtures/create-genesis-brain-draft.json \
  --trusted-inputs /fixtures/trusted-inputs.json \
  --credential-broker /run/cosmo-acceptance/credential-broker.sock \
  --state-root /var/lib/cosmo
```

`trace-audit.ts` permits `/opt/cosmo`, `/var/lib/cosmo`, `/fixtures`, the read-only broker socket, declared OS libraries/devices, loopback API sockets, and the exact proxy socket. It rejects every other path or network destination, direct DNS/provider connections, service discovery, process supervisors, and undeclared child executables. The proxy audit independently proves that every hostname/port matches the signed policy. Runtime receipts must match the signed provider/model/adapter/tool identities, require `executionClass='live_provider'`, and require `providerFallback=null`; deterministic, recorded, replay, or mock receipts cannot satisfy a semantic probe.

An external observer process measures the sustained interval, process liveness, status/event reads, wake deliveries, and resource use. It is observe-only and signs its receipt. The packaged scheduler passes only if the same Program E `(programId, hostWakeId)` is delivered at most once, every E call contains exactly `programId`, `hostWakeId`, and `observedAt`, at least the profile-required wake cycles occur across the full interval, and static/runtime traces show no H implementation of question origination, lane selection, expedition construction, Principal decisions, metabolism policy, or wake synthesis. The `publicClientParity` probe separately parses all 36 route fixtures, exercises the exact Program E genesis route, Program F formation read, four preview/commit routes, human Invent promotion, and program-direction activation, checks one-use/idempotent-retry behavior, and scans browser, CLI, server logs, SSE, errors, and receipts for forbidden grant, lease, fence, private authority, prompt, source, path, token, cookie, or raw-diff leakage.

- [ ] **Step 5: Define the complete signed receipt**

```ts
export const ProgramHProbeIdSchema = z.enum([
  'install',
  'packageExports',
  'launch',
  'genesisBrain',
  'firstResearchProgram',
  'sustainedScheduler',
  'autonomous',
  'pure',
  'guidedSatisfied',
  'guidedBlocked',
  'discoveryAcquisition',
  'sleepWake',
  'pinnedQuery',
  'formationRead',
  'humanInventPromotion',
  'agendaActivation',
  'fork',
  'union',
  'exportImport',
  'brainStatus',
  'brainLog',
  'brainTag',
  'brainSettle',
  'brainWake',
  'stop',
  'restart',
  'continuity',
  'publicClientParity',
]);

export const ProbeReceiptSchema = z.object({
  schema: z.literal('cosmo.program-h-probe-receipt.v1'),
  probeId: ProgramHProbeIdSchema,
  status: z.enum(['pass', 'fail', 'interrupted']),
  releaseId: Sha256Schema,
  releaseSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  programGReceiptId: ObjectIdSchema,
  coreAcceptedSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  coreArtifactSetId: Sha256Schema,
  packagedCoreArtifactSetId: Sha256Schema,
  evidenceRefs: z.array(ObjectRefSchema).min(1),
  executionIdentityReceiptRefs: z.array(ObjectRefSchema),
  violationIds: z.array(z.string().min(1)),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
}).strict().superRefine((probe, context) => {
  if (probe.status === 'pass' && probe.violationIds.length !== 0) {
    context.addIssue({
      code: 'custom',
      path: ['violationIds'],
      message: 'a passing probe has no violations',
    });
  }
  if (probe.coreArtifactSetId !== probe.packagedCoreArtifactSetId) {
    context.addIssue({
      code: 'custom',
      path: ['packagedCoreArtifactSetId'],
      message: 'packaged core differs from Program G accepted core',
    });
  }
});

const ProgramHProbeSetSchema = z.object({
  install: ProbeReceiptSchema,
  packageExports: ProbeReceiptSchema,
  launch: ProbeReceiptSchema,
  genesisBrain: ProbeReceiptSchema,
  firstResearchProgram: ProbeReceiptSchema,
  sustainedScheduler: ProbeReceiptSchema,
  autonomous: ProbeReceiptSchema,
  pure: ProbeReceiptSchema,
  guidedSatisfied: ProbeReceiptSchema,
  guidedBlocked: ProbeReceiptSchema,
  discoveryAcquisition: ProbeReceiptSchema,
  sleepWake: ProbeReceiptSchema,
  pinnedQuery: ProbeReceiptSchema,
  formationRead: ProbeReceiptSchema,
  humanInventPromotion: ProbeReceiptSchema,
  agendaActivation: ProbeReceiptSchema,
  fork: ProbeReceiptSchema,
  union: ProbeReceiptSchema,
  exportImport: ProbeReceiptSchema,
  brainStatus: ProbeReceiptSchema,
  brainLog: ProbeReceiptSchema,
  brainTag: ProbeReceiptSchema,
  brainSettle: ProbeReceiptSchema,
  brainWake: ProbeReceiptSchema,
  stop: ProbeReceiptSchema,
  restart: ProbeReceiptSchema,
  continuity: ProbeReceiptSchema,
  publicClientParity: ProbeReceiptSchema,
}).strict();

export const ProgramHCleanReleaseReceiptSchema = z.object({
  schema: z.literal('cosmo.program-h-clean-release.v1'),
  receiptId: ObjectIdSchema,
  status: z.enum(['accepted', 'rejected']),
  releaseId: Sha256Schema,
  releaseSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  acceptanceProfileId: Sha256Schema,
  programGReceiptId: ObjectIdSchema,
  coreAcceptedSourceCommit: z.string().regex(/^[0-9a-f]{40}$/),
  coreArtifactSetId: Sha256Schema,
  packagedCoreArtifactSetId: Sha256Schema,
  trustedInputsId: Sha256Schema,
  environmentImageId: Sha256Schema,
  genesisBrainCommitId: BrainCommitIdSchema,
  genesisBrainReceiptRef: ObjectRefSchema,
  firstResearchProgramId: ResearchProgramIdSchema,
  firstResearchProgramReceiptRef: ObjectRefSchema,
  executionIdentityReceiptRefs: z.array(ObjectRefSchema).length(11),
  externalObserverReceiptRef: ObjectRefSchema,
  probes: ProgramHProbeSetSchema,
  staticDependencyAudit: ObjectRefSchema,
  lifecycleOwnershipAudit: ObjectRefSchema,
  schedulerTraceAudit: ObjectRefSchema,
  filesystemTraceAudit: ObjectRefSchema,
  networkTraceAudit: ObjectRefSchema,
  egressProxyAudit: ObjectRefSchema,
  hardGateViolationIds: z.array(z.string().min(1)),
  completedAt: z.string().datetime(),
  signatures: z.array(DetachedSignatureSchema).min(1),
}).strict().superRefine((receipt, context) => {
  const entries = Object.entries(receipt.probes);
  const liveProbeIds = new Set([
    'sustainedScheduler',
    'autonomous',
    'pure',
    'guidedSatisfied',
    'guidedBlocked',
    'discoveryAcquisition',
    'sleepWake',
    'pinnedQuery',
    'humanInventPromotion',
    'agendaActivation',
    'continuity',
  ]);
  const probeIdsMatchKeys = entries.every(
    ([key, probe]) => key === probe.probeId,
  );
  const probesBindReceipt = entries.every(([, probe]) =>
    probe.releaseId === receipt.releaseId
    && probe.releaseSourceCommit === receipt.releaseSourceCommit
    && probe.programGReceiptId === receipt.programGReceiptId
    && probe.coreAcceptedSourceCommit === receipt.coreAcceptedSourceCommit
    && probe.coreArtifactSetId === receipt.coreArtifactSetId
    && probe.packagedCoreArtifactSetId === receipt.packagedCoreArtifactSetId
  );
  const liveProbeMinimumsHold = entries.every(([key, probe]) =>
    !liveProbeIds.has(key) || probe.executionIdentityReceiptRefs.length >= 1
  );
  const allPassed = entries.every(([, probe]) => probe.status === 'pass');

  if (
    receipt.coreArtifactSetId !== receipt.packagedCoreArtifactSetId
    || !probeIdsMatchKeys
    || !probesBindReceipt
    || !liveProbeMinimumsHold
  ) {
    context.addIssue({
      code: 'custom',
      path: ['probes'],
      message: 'probe identity or accepted-core binding mismatch',
    });
  }
  if (
    receipt.status === 'accepted'
    && (!allPassed || receipt.hardGateViolationIds.length !== 0)
  ) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'accepted release requires all 28 probes and zero violations',
    });
  }
  if (
    receipt.status === 'rejected'
    && allPassed
    && receipt.hardGateViolationIds.length === 0
  ) {
    context.addIssue({
      code: 'custom',
      path: ['status'],
      message: 'rejected release must retain its failed oracle',
    });
  }
});

export type ProbeReceipt = z.infer<typeof ProbeReceiptSchema>;
export type ProgramHCleanReleaseReceipt =
  z.infer<typeof ProgramHCleanReleaseReceiptSchema>;
```

The semantic probes (`sustainedScheduler`, `autonomous`, `pure`, both guided probes, `discoveryAcquisition`, `sleepWake`, `pinnedQuery`, `humanInventPromotion`, `agendaActivation`, and `continuity`) each require all role receipts actually involved in that probe; `formationRead` instead requires exact trace evidence and zero new structured-role calls. The final receipt requires all eleven profile roles and rechecks the eight signed independence pairs. External verification resolves `genesisBrainReceiptRef` through exact `GenesisBrainReceiptSchema`, requires its commit to equal `genesisBrainCommitId`, and requires `firstResearchProgramReceiptRef` to identify the D-create/E-initialize operation for `firstResearchProgramId` rooted at that exact genesis commit/Covenant/seed set. The first-program evidence must also contain the server-derived scope resolution and admitted human-operation event; their target/head/program/lineage/trust identities must match the D create input, while the raw public request contains none of those fields. Both refs must also appear in their matching probe evidence. `receiptId` hashes canonical receipt bytes with `receiptId` and `signatures` omitted, and each detached signature binds that ID and those exact unsigned bytes. External verification recomputes the ID, signatures, source/artifact bridge, durations, probe-key identities, evidence refs, live identities, prompt/context/process bindings, and independence constraints. A failed or interrupted run still writes and signs a canonical `status='rejected'` receipt with all completed/failed/interrupted probe evidence; the harness never suppresses a failure receipt or emits `accepted` from a partial probe set.

- [ ] **Step 6: Run focused harness tests**

Run:

```bash
npm test -- tests/release/clean-room.test.ts tests/product/standalone-boundary.test.ts tests/product/public-client-parity.test.ts
npm exec -- tsc -p tests/release/tsconfig.json --noEmit
node --check scripts/prepare-clean-room-context.mjs
npm run typecheck
```

Expected: PASS with a fixture archive, deterministic structural/fault adapter, seeded trace violations, extra-context-file rejection, unsigned trusted-input rejection, compiled-runner enforcement, altered raw G receipt, accepted-core byte mismatch, live-provider identity mismatch, lifecycle-ownership violation, scheduler duplicate-wake, receipt-ID/signature mismatch, partial accepted receipt, and signed rejected-receipt fixtures.

- [ ] **Step 7: Commit the clean-room harness before building a release**

```bash
git add scripts/prepare-clean-room-context.mjs tests/release/Dockerfile tests/release/tsconfig.json tests/release/clean-environment.ts tests/release/clean-room-scenario.ts tests/release/trace-audit.ts tests/release/clean-room.test.ts
git commit -m "test(release): add external clean-room harness"
```

The release builder now sees a committed, clean source revision containing every product and acceptance path.

- [ ] **Step 8: Bind H release outputs and the accepted-core bridge without conflating commits**

```bash
test -z "$(git status --porcelain)"
release_source_commit="$(git rev-parse HEAD)"
release_run_root="$(mktemp -d "${TMPDIR:-/tmp}/cosmo-h-release.XXXXXX")"
clean_context="$release_run_root/context"

npm ci
npm run build
npm test
npm run test:contracts
npm run release:build -- \
  --release-source-commit "$release_source_commit" \
  --program-g-receipt docs/receipts/program-g-shadow-acceptance.json \
  --output-root "$release_run_root/artifacts" \
  --signing-key-fd 4

node scripts/prepare-clean-room-context.mjs \
  --release-archive "$release_run_root/artifacts/cosmo-standalone.tgz" \
  --release-public-key "$release_run_root/artifacts/release-public-key.pem" \
  --program-g-profile fixtures/acceptance/release-profile.v1 \
  --program-g-receipt "$release_run_root/artifacts/program-g-receipt.json" \
  --trusted-input-signing-key-fd 5 \
  --output "$clean_context"

test -z "$(git status --porcelain)"
```

Expected: the release manifest, archive, compiled JavaScript harness, and H clean-room receipt side name `release_source_commit` as `releaseSourceCommit`. The immutable G side remains the pre-trial signed profile named by `profileId` plus the byte-identical raw receipt named by `programGReceiptId`; that receipt retains its older `coreAcceptedSourceCommit`, `coreArtifactSetId`, and original signature. `programGReceiptId` plus entry-for-entry equality of `packagedCoreArtifactSetId === coreArtifactSetId` is the bridge between the two sides. Neither the profile nor G receipt is rebound to `releaseSourceCommit`, and the two Git commits are never claimed equal. The source tree remains clean. The preparation script reads actual base/proxy digests and egress allowlists from the signed environment policy, so the command contains no fabricated digest. A core-byte mismatch stops here and requires a new full G acceptance run.

- [ ] **Step 9: Build only from the allowlisted context and run the complete release gate**

The exact credential-broker socket is an operator-supplied secure runtime input; it is not copied or hashed as file content. Create uniquely named internal/egress networks and a digest-pinned proxy from `trusted-inputs.json`, attach COSMO only to the internal network, and mount the broker read-only:

```bash
set -euo pipefail
base_image="$(node "$clean_context/harness/clean-environment.js" read --field baseImageDigest --trusted-inputs "$clean_context/trusted-inputs.json")"
proxy_image="$(node "$clean_context/harness/clean-environment.js" read --field egressProxyImageDigest --trusted-inputs "$clean_context/trusted-inputs.json")"
: "${credential_broker_socket:?operator must set credential_broker_socket to the verified broker socket}"
test -S "$credential_broker_socket"
mkdir -p "$release_run_root/state"
release_run_id="$(printf '%s' "$release_run_root" | shasum -a 256 | cut -c1-16)"
internal_network="cosmo-acceptance-internal-$release_run_id"
egress_network="cosmo-acceptance-egress-$release_run_id"
proxy_name="cosmo-acceptance-proxy-$release_run_id"
cosmo_name="cosmo-acceptance-runtime-$release_run_id"
image_name="cosmo-clean-release:$release_run_id"

cleanup_clean_room() {
  docker logs "$proxy_name" > "$release_run_root/egress-proxy.log" 2>&1 || true
  docker rm -f "$cosmo_name" "$proxy_name" >/dev/null 2>&1 || true
  docker network rm "$internal_network" "$egress_network" >/dev/null 2>&1 || true
  docker image rm "$image_name" >/dev/null 2>&1 || true
}
trap cleanup_clean_room EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker build \
  --build-arg "BASE_IMAGE=$base_image" \
  -f "$clean_context/Dockerfile" \
  -t "$image_name" \
  "$clean_context"
docker network create --internal "$internal_network"
docker network create "$egress_network"
docker run -d --name "$proxy_name" \
  --network "$internal_network" \
  --mount "type=bind,src=$clean_context/trusted-inputs.json,dst=/policy/trusted-inputs.json,readonly" \
  "$proxy_image"
docker network connect "$egress_network" "$proxy_name"
docker run --rm \
  --name "$cosmo_name" \
  --network "$internal_network" \
  --mount "type=bind,src=$credential_broker_socket,dst=/run/cosmo-acceptance/credential-broker.sock,readonly" \
  --mount "type=bind,src=$release_run_root/state,dst=/var/lib/cosmo" \
  -e "HTTPS_PROXY=http://$proxy_name:8080" \
  -e "HTTP_PROXY=http://$proxy_name:8080" \
  "$image_name"
docker logs "$proxy_name" > "$release_run_root/egress-proxy.log"
node scripts/verify-standalone-release.mjs \
  --archive "$release_run_root/artifacts/cosmo-standalone.tgz" \
  --public-key "$release_run_root/artifacts/release-public-key.pem"
```

The cleanup trap names only resources created for this exact `release_run_root`, captures the externally retained proxy log before removal, and executes on success, failure, interrupt, or termination. A failed acceptance attempt is never resumed against its partial state or context: rerun Step 8 to obtain a new `mktemp` run root, new signed context, new state directory, and new Docker identities. The prior run root remains an auditable failed-attempt artifact until the operator explicitly disposes of it.

Expected:

```text
PROGRAM_G_RECEIPT_VERIFIED
RELEASE_MANIFEST_VERIFIED
STATIC_SEPARATION_VERIFIED
FILESYSTEM_TRACE_VERIFIED
NETWORK_TRACE_VERIFIED
EGRESS_PROXY_POLICY_VERIFIED
LIVE_EXECUTION_IDENTITIES_VERIFIED
PACKAGED_SCHEDULER_8H_VERIFIED
LIFECYCLE_OWNERSHIP_VERIFIED
PACKAGE_EXPORTS_VERIFIED
GENESIS_BRAIN_VERIFIED
FIRST_RESEARCH_PROGRAM_ACTIVE
PUBLIC_CLIENT_PARITY_VERIFIED
CLEAN_ROOM_LIFECYCLE_VERIFIED
PROGRAM_H_CLEAN_RELEASE_ACCEPTED
```

Any missing probe, signature failure, hash mismatch, status conflation, non-live/fallback semantic execution, duplicate wake, H-owned cognition policy, privileged-client path, undeclared access, source-export left in the archive, import failure, continuity failure, or hard-gate violation rejects the release.

- [ ] **Step 10: Record the immutable receipt and rollback identity**

Use the compiled H-owned renderer from `clean_context` to verify the canonical receipt written under the mounted state root and create `docs/receipts/program-h-clean-release.md`. Record release/trusted-input/image IDs, H `releaseSourceCommit`, G `coreAcceptedSourceCommit`, Program G receipt ID, accepted and packaged core artifact-set IDs plus equality proof, profile ID, genesis draft/receipt IDs and exact no-second-CAS proof, first Research Program create/initialize receipt IDs, all live execution identity receipts, external eight-hour observer, scheduler/lifecycle-ownership traces, package-export imports, every probe, proxy/filesystem/network audits, receipt object ID, signer identity, exact commands/result lines, and prior release rollback ID. State explicitly that the G signature was not rebound. Do not include tokens, cookies, broker path, private paths, source contents, or model credentials.

- [ ] **Step 11: Prove receipt-only drift and commit the immutable receipt**

```bash
test "$release_source_commit" = "$(node "$clean_context/harness/clean-environment.js" read-receipt --field releaseSourceCommit --receipt "$release_run_root/state/receipts/program-h-clean-release.json")"
test "$(node "$clean_context/harness/clean-environment.js" read-receipt --field coreArtifactSetId --receipt "$release_run_root/state/receipts/program-h-clean-release.json")" = "$(node "$clean_context/harness/clean-environment.js" read-receipt --field packagedCoreArtifactSetId --receipt "$release_run_root/state/receipts/program-h-clean-release.json")"
test "$(git status --porcelain)" = "?? docs/receipts/program-h-clean-release.md"
git diff --check
git add docs/receipts/program-h-clean-release.md
git diff --cached --check
git diff --cached --name-only | diff -u - <(printf '%s\n' docs/receipts/program-h-clean-release.md)
git commit -m "test(release): record standalone COSMO lifecycle"
```

The receipt-only commit is not the tested H release source. The H receipt and archive continue to name `release_source_commit`; the unchanged embedded G receipt continues to name its own `coreAcceptedSourceCommit`.

---

## Program H Stop/Go Gate

Program H passes only when all of the following are true:

- [ ] The exact committed canonical raw Program G receipt verifies before release construction; its bytes, object ID, signature, and `coreAcceptedSourceCommit` remain unchanged.
- [ ] A committed source revision produces a signed, content-manifested release archive.
- [ ] The archive installs and operates as an unprivileged user in the clean-room image.
- [ ] Startup recovery completes before readiness.
- [ ] Service, research, cognition, and epistemic states remain separately observable.
- [ ] A verified-empty fresh install becomes ready, creates exactly one model-free parentless Genesis Brain through Program E with all nine roots and explicit genesis lineage/trust/journal evidence, returns the same receipt on exact retry, rejects a second genesis, and starts the first Research Program from only that receipt plus the signed program fixture.
- [ ] The exact 36-route `/api/v1` manifest parses, every public request is authority-free, `POST /brains` delegates one model-free parentless creation to Program E, formation is a model-free read, the four Program F preview/commit routes enforce review, human Invent promotion and agenda activation use their exact Program F services, and `POST /session/exchange` is the only atomic one-time-code exception.
- [ ] Public Research Program DTOs remain scope-free; H derives an authority-bound verified Brain/program/trust scope, admits one exact human-operation event through Program D, and forwards that scope, event ID, and domain idempotency identity unchanged into every D create/control input.
- [ ] The CLI controls only the exact verified COSMO lifecycle identity.
- [ ] The API has no direct canonical-state mutation path.
- [ ] Steer and Invent expose no one-step mutation path: live server preview ID, draft hash, expected head, principal/scopes, authority fingerprint, expiry, and one-use state are revalidated before Program F receives an internal mutation.
- [ ] The public client and CLI have identical authorized capabilities.
- [ ] The Program F workbench build is packaged byte-for-byte without Program H source edits.
- [ ] Every documented package root and subpath imports from the installed archive with plain Node ESM and no TypeScript loader or source export.
- [ ] Static dependency inspection finds no Home23 runtime edge.
- [ ] Runtime filesystem and network traces show no Home23 access or undeclared service discovery.
- [ ] The packaged scheduler remains healthy under an observe-only external monitor for at least 28,800,000 monotonic milliseconds.
- [ ] H only hosts Program E's `GenesisBrainService` and hosts/wakes its `CognitiveLifecycleEngine`; source inspection and runtime traces show no H genesis builder or second question, expedition, Principal, metabolism, sleep, dream, or wake policy.
- [ ] All semantic probes use signed `live_provider` identities with `providerFallback=null`; deterministic execution is confined to structural and injected-fault tests.
- [ ] Install, launch, Genesis Brain, first Research Program, autonomous, Pure, guided-satisfied, guided-blocked, discovery/acquisition, sleep/wake, query, fork, lossless union, status, log, tag, settle, wake, encrypted export/import, stop, and restart probes all pass.
- [ ] Brain, journal, relationship, negative-knowledge, and exact commit continuity survive restart.
- [ ] H's archive, compiled harness, clean-room receipt, and rollback identity bind to `releaseSourceCommit`; G's unchanged receipt separately binds to `coreAcceptedSourceCommit`.
- [ ] The immutable signed G profile remains identified by the `profileId` inside `programGReceiptId`; neither G artifact is relabeled as an H-source artifact.
- [ ] `packagedCoreArtifactSetId` equals G's `coreArtifactSetId`, and every G-declared core path/hash/length/mode matches byte-for-byte; no equality claim is made about the two Git commits.
- [ ] The receipt contains zero hard-gate violations.
- [ ] No optional Home23 client or other product adapter has been implemented.
- [ ] The final human product review explicitly accepts that this release feels like a research colleague that continued thinking.

Only after this gate and explicit operator acceptance may a separately authorized future-client plan be written.
