# Brain Authority and Operation Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the canonical brain catalog, trusted requester capability, durable operation store, dashboard coordinator, and capability-protected COSMO worker boundary required before any agent can target another brain.

**Architecture:** The requester agent's dashboard is the sole coordinator and derives identity from its configured process. It stores operation truth under the requester's ignored instance runtime, signs short-lived capabilities for COSMO, and keeps caller attachments separate from durable job state. COSMO validates every internal request and acts only as an abortable worker.

**Tech Stack:** Node.js CommonJS, Express, node:test, HMAC-SHA256, proper-lockfile, atomic JSON writes, PM2 ecosystem generation.

## Global Constraints

- The caller's own brain is the default; other brains require explicit selection.
- Only COSMO-discovered sibling resident brains and completed research brains are eligible read-only targets.
- Unknown, ambiguous, mismatched, active-research, or unavailable targets fail closed.
- Requester identity comes from the dashboard process, never request input.
- Operation IDs and result handles are not bearer credentials.
- Durable execution states are queued, running, complete, partial, failed, cancelled, and interrupted; attachment state is separate.
- Emit queued/running heartbeats every 10 seconds. Treat 60 seconds without an event as transport trouble, not provider failure.
- Default server execution deadlines are two hours for ordinary query/compile/stop work and eight hours for PGS/synthesis; attachment wait deadlines are handled separately by the client.
- Retain terminal metadata for 30 days and all inline/file-backed result payloads plus scratch artifacts for seven days unless explicitly exported; never collect nonterminal operations.
- Bound both canonical and worker event journals at 4,096 records and 8 MiB, coalescing noisy progress while preserving terminal/provider/phase evidence and surfacing typed resumable gaps.
- Inline at most 64 KiB of UTF-8 JSON result data. Larger results use an atomic requester-owned result file plus an opaque requester-authorized handle.
- `mutationBoundaries` is always an array of server-derived `{kind,path}` records. Every catalog entry exposes exactly the seven required kinds: `brain`, `run`, `pgs`, `session`, `cache`, `export`, and `agency`.
- Source-requiring operations persist an atomic source-pin descriptor plus digest before any capability is issued. Non-source operations persist both fields as `null`; null never means “use current source.”
- Native manifests and legacy resident/research inputs share one source-plan pin contract: every public descriptor has numeric `version:1` plus safe-integer revisions. Legacy inputs are streamed into requester-owned immutable numeric-v1 projections; a format-0, string-version, null-revision, or target-local projection is never capability-authoritative.
- Reader/writer source locking belongs only to the source-plan seam. Its trusted global lock root is `<home23Root>/runtime/brain-source-locks`, outside every target and requester operation; no public request, catalog field, capability, or executor parameter may select a lock path or create `.memory-source.lock` in a target.
- `graph_export` has one wire/storage format: uncompressed JSONL (`format:'jsonl'`, `mediaType:'application/x-ndjson'`, `contentEncoding:'identity'`). JSON, gzip, and caller paths are invalid.
- Every operation type is authorized by the shared server-side authority matrix before a capability is issued and again before a COSMO executor runs.
- Capability secrets and operation records are ignored installation state and never enter Git.
- New cross-brain tool schemas remain disabled until this plan and the no-write integration tests pass.
- Do not delete or rewrite user brain/runtime data.
- Execute only in the clean isolated worktree created by superpowers:using-git-worktrees. Before each task, require an empty index and no unrelated working-tree changes.
- Stage only task paths, inspect their cached diff, and commit with explicit path arguments. Never execute this plan in the dirty primary checkout.

---

### Task 1: Canonical Brain Catalog

**Files:**
- Modify: cosmo23/server/lib/brain-registry.js
- Modify: cosmo23/server/lib/brains-router.js
- Modify: cosmo23/server/lib/brains-router.test.js
- Modify: cosmo23/server/index.js
- Create: tests/cosmo23/brain-catalog-contract.test.cjs
- Create: contracts/schemas/brain-operations.schema.json
- Modify: docs/design/COSMO23-VENDORED-PATCHES.md

**Interfaces:**
- Consumes: Existing listBrains(options), inspectBrain(path), canonical plan/run metadata, configured agent names from ignored config/agents.json, and activeRunPath.
- Produces: buildCanonicalCatalog(options), resolveCanonicalTarget(catalog, callerAgent, selector), BrainCatalog and BrainCatalogEntry response shapes.

- [ ] **Step 1: Write failing canonical catalog tests**

Add fixtures for one resident brain, one symlink to that brain, one active research run, one completed research run, two duplicate display names, and one unavailable canonical resident owner named `offline`. A research fixture is completed only when its canonical `plans/plan:main.json` says `status: "COMPLETED"` and has numeric `completedAt`; `outputs/.complete`, age, display name, or mere absence from activeContext never proves run completion. The active fixture is selected by the canonical `activeRunPath`, and a stopped run whose plan remains ACTIVE is unavailable. Assert this shape:

The unavailable resident fixture is a configured agent with an existing canonical `instances/offline/brain` directory but no valid state source. Extend `listBrains()` with an internal `includeUnavailableConfiguredResidents` option used only by the canonical catalog: it may retain that exact configured `<instancesRoot>/<agent>/brain` entry with `hasState:false`, while legacy picker calls keep filtering empty sibling directories. Reject unsafe/duplicate configured agent names and do not turn arbitrary instance subdirectories into catalog identities.

    {
      catalogRevision: 'stable-sha256',
      brains: [{
        id: 'brain-jerry',
        displayName: 'jerry',
        ownerAgent: 'jerry',
        kind: 'resident',
        lifecycle: 'resident',
        canonicalRoot: '/real/path/instances/jerry/brain',
        sourceType: 'home23-agent',
        nodeCount: 12,
        modifiedAt: '2026-07-09T00:00:00.000Z',
        route: '/api/brain/brain-jerry',
        mutationBoundaries: [
          { kind: 'brain', path: '/real/path/instances/jerry/brain' },
          { kind: 'run', path: '/real/path/instances/jerry/brain' },
          { kind: 'pgs', path: '/real/path/instances/jerry/brain/pgs-sessions' },
          { kind: 'session', path: '/real/path/instances/jerry/brain/sessions' },
          { kind: 'cache', path: '/real/path/instances/jerry/brain/cache' },
          { kind: 'export', path: '/real/path/instances/jerry/brain/exports' },
          { kind: 'agency', path: '/real/path/instances/jerry/brain/agency' }
        ]
      }]
    }

The tests must prove known-ineligible targets, malformed selectors, unknown selectors, and ambiguity remain distinct:

    assert.equal(catalog.brains.filter((brain) => brain.canonicalRoot === realRoot).length, 1);
    assert.equal(resolveCanonicalTarget(catalog, 'jerry').id, 'brain-jerry');
    assert.equal(resolveCanonicalTarget(catalog, 'jerry', { agent: 'forrest' }).ownerAgent, 'forrest');
    assert.equal(resolveCanonicalTarget(catalog, 'jerry', { brainId: completed.id }).lifecycle, 'completed');
    assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { brainId: active.id }), /target_not_available/);
    assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { brainId: unavailable.id }), /target_not_available/);
    assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { brainId: 'brain-does-not-exist' }), /target_not_found/);
    assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { agent: 'does-not-exist' }), /target_not_found/);
    assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { agent: 'offline' }), /target_not_available/);
    assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { agent: 'jerry', brainId: forrest.id }), /target_mismatch/);
    assert.equal(catalog.brains.filter((brain) => brain.displayName === 'duplicate').length, 2);
    assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { name: 'duplicate' }), /invalid_request/);
    assert.throws(() => resolveCanonicalTarget(duplicateOwnerCatalog, 'jerry', { agent: 'forrest' }), /target_ambiguous/);
    assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { brainId: 23 }), /invalid_request/);
    assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', { agent: '' }), /invalid_request/);
    assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', null), /invalid_request/);
    assert.throws(() => resolveCanonicalTarget(catalog, 'jerry', []), /invalid_request/);
    assert.throws(() => resolveCanonicalTarget(catalog, '', {}), /invalid_request/);
    const residentEntry = catalog.brains.find((brain) => brain.id === 'brain-jerry');
    assert.deepEqual(residentEntry.mutationBoundaries.map(({ kind }) => kind),
      ['brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency']);
    assert.deepEqual(residentEntry.mutationBoundaries.find(({ kind }) => kind === 'run'),
      { kind: 'run', path: await fs.promises.realpath(residentBrainRoot) });
    assert.deepEqual(residentEntry.mutationBoundaries.find(({ kind }) => kind === 'brain'),
      { kind: 'brain', path: await fs.promises.realpath(residentBrainRoot) });
    assert.equal(catalog.brains.some((brain) => brain.mutationBoundaries.some(({ path: boundaryPath }) =>
      boundaryPath === '/caller/supplied/or/outside-root')), false);

    for (const brain of catalog.brains) {
      assert.deepEqual(new Set(brain.mutationBoundaries.map(({ kind }) => kind)),
        new Set(['brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency']));
      assert.equal(brain.mutationBoundaries.every(({ path: boundaryPath }) =>
        path.isAbsolute(boundaryPath)), true);
    }

- [ ] **Step 2: Run the catalog tests and verify RED**

Run:

    node --test --test-concurrency=1 cosmo23/server/lib/brains-router.test.js tests/cosmo23/brain-catalog-contract.test.cjs

Expected: FAIL because buildCanonicalCatalog and resolveCanonicalTarget do not exist and the current registry lacks ownerAgent, kind, lifecycle, canonicalRoot, catalogRevision, and mutationBoundaries.

- [ ] **Step 3: Implement canonical identity and resolution**

Add these exports to brain-registry.js:

    function catalogError(code) {
      const error = new Error(code);
      error.code = code;
      return error;
    }

    function hashCatalog(brains) {
      const identity = brains.map(({
        id, ownerAgent, kind, lifecycle, canonicalRoot, modifiedAt, mutationBoundaries,
      }) => ({ id, ownerAgent, kind, lifecycle, canonicalRoot, modifiedAt, mutationBoundaries }));
      return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    }

    const MUTATION_BOUNDARY_KINDS = Object.freeze([
      'brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency',
    ]);

    function assertAllowedCanonicalBoundary(boundary, allowedRoots) {
      const inside = allowedRoots.some((root) => {
        const relative = path.relative(root, boundary);
        return relative === '' || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
      });
      if (!inside) throw catalogError('catalog_boundary_invalid');
    }

    async function buildMutationBoundaries({ canonicalRoot, mutationRoot, allowedCanonicalRoots }) {
      const candidates = [
        { kind: 'brain', path: canonicalRoot },
        { kind: 'run', path: mutationRoot },
        { kind: 'pgs', path: path.join(canonicalRoot, 'pgs-sessions') },
        { kind: 'session', path: path.join(canonicalRoot, 'sessions') },
        { kind: 'cache', path: path.join(canonicalRoot, 'cache') },
        { kind: 'export', path: path.join(canonicalRoot, 'exports') },
        { kind: 'agency', path: path.join(canonicalRoot, 'agency') },
      ];
      const seenKinds = new Set();
      const boundaries = [];
      for (const boundary of candidates) {
        const resolvedPath = path.resolve(boundary.path);
        const canonicalPath = await fs.promises.realpath(resolvedPath).catch((error) => {
          if (error.code === 'ENOENT') return resolvedPath;
          throw error;
        });
        if (!MUTATION_BOUNDARY_KINDS.includes(boundary.kind) || seenKinds.has(boundary.kind)) {
          throw catalogError('catalog_boundary_invalid');
        }
        seenKinds.add(boundary.kind);
        assertAllowedCanonicalBoundary(canonicalPath, allowedCanonicalRoots);
        boundaries.push(Object.freeze({ kind: boundary.kind, path: canonicalPath }));
      }
      return boundaries;
    }

    async function readCanonicalRunLifecycle(canonicalRoot, activeRunPath) {
      if (activeRunPath) {
        const activeRoot = await fs.promises.realpath(activeRunPath).catch(() => path.resolve(activeRunPath));
        if (activeRoot === canonicalRoot) return { lifecycle: 'active', ownerAgent: null };
      }
      const [plan, run] = await Promise.all([
        loadJsonIfPresent(path.join(canonicalRoot, 'plans', 'plan:main.json')),
        loadJsonIfPresent(path.join(canonicalRoot, 'run.json')),
      ]);
      const completed = plan?.status === 'COMPLETED' && Number.isFinite(Number(plan.completedAt));
      return {
        lifecycle: completed ? 'completed' : 'unavailable',
        ownerAgent: typeof run?.owner === 'string' && run.owner.trim() ? run.owner.trim() : null,
      };
    }

    async function toCanonicalEntry(brain, canonicalRoot, options) {
      const relative = path.relative(options.instancesRoot, canonicalRoot).split(path.sep);
      const resident = relative.length === 2 && relative[1] === 'brain' && !relative[0].startsWith('..');
      const runLifecycle = resident
        ? { lifecycle: brain.hasState === false ? 'unavailable' : 'resident', ownerAgent: relative[0] }
        : await readCanonicalRunLifecycle(canonicalRoot, options.activeRunPath);
      const id = 'brain-' + crypto.createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 16);
      const mutationRoot = canonicalRoot;
      const mutationBoundaries = await buildMutationBoundaries({
        canonicalRoot, mutationRoot, allowedCanonicalRoots: options.allowedCanonicalRoots,
      });
      return {
        id,
        displayName: brain.displayName || brain.name || path.basename(canonicalRoot),
        ownerAgent: runLifecycle.ownerAgent,
        kind: resident ? 'resident' : 'research',
        lifecycle: runLifecycle.lifecycle,
        canonicalRoot,
        sourceType: brain.sourceType || (resident ? 'home23-agent' : 'research-run'),
        nodeCount: Number.isFinite(Number(brain.nodes)) ? Number(brain.nodes) : null,
        modifiedAt: new Date(brain.modifiedDate || brain.metadata?.modifiedAt || 0).toISOString(),
        route: '/api/brain/' + encodeURIComponent(id),
        mutationBoundaries,
      };
    }

    async function buildCanonicalCatalog(options = {}) {
      if (!options.instancesRoot || !options.localRunsPath
          || !Array.isArray(options.referenceRunsPaths)
          || !Array.isArray(options.configuredAgentNames)) {
        throw catalogError('catalog_configuration_invalid');
      }
      const configuredAgentNames = [...new Set(options.configuredAgentNames)];
      if (configuredAgentNames.some((name) =>
        typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))) {
        throw catalogError('catalog_configuration_invalid');
      }
      const configuredRoots = [
        options.instancesRoot,
        options.localRunsPath,
        ...options.referenceRunsPaths,
      ];
      const allowedCanonicalRoots = await Promise.all(configuredRoots.map((root) =>
        fs.promises.realpath(root).catch(() => path.resolve(root))));
      const instancesRoot = allowedCanonicalRoots[0];
      const inspected = await listBrains({
        ...options,
        configuredAgentNames,
        includeUnavailableConfiguredResidents: true,
      });
      const byRoot = new Map();
      for (const brain of inspected) {
        const canonicalRoot = await fs.promises.realpath(brain.path).catch(() => path.resolve(brain.path));
        const entry = await toCanonicalEntry(brain, canonicalRoot, {
          ...options, instancesRoot, allowedCanonicalRoots,
        });
        const prior = byRoot.get(canonicalRoot);
        if (!prior || entry.lifecycle === 'resident') byRoot.set(canonicalRoot, entry);
      }
      const brains = [...byRoot.values()].sort((a, b) => a.id.localeCompare(b.id));
      return { catalogRevision: hashCatalog(brains), brains };
    }

    function resolveCanonicalTarget(catalog, callerAgent, selector = {}) {
      if (!catalog || !Array.isArray(catalog.brains)) throw catalogError('catalog_unavailable');
      if (typeof callerAgent !== 'string' || !callerAgent.trim()) throw catalogError('invalid_request');
      if (!selector || Array.isArray(selector) || typeof selector !== 'object') {
        throw catalogError('invalid_request');
      }
      const keys = Object.keys(selector);
      if (keys.some((key) => key !== 'agent' && key !== 'brainId')) throw catalogError('invalid_request');
      if (selector.agent !== undefined && (typeof selector.agent !== 'string' || !selector.agent.trim())) {
        throw catalogError('invalid_request');
      }
      if (selector.brainId !== undefined && (typeof selector.brainId !== 'string' || !selector.brainId.trim())) {
        throw catalogError('invalid_request');
      }
      const eligibleLifecycle = (brain) =>
        brain.lifecycle === 'resident' || brain.lifecycle === 'completed';
      const resolveUnique = (matches) => {
        if (matches.length > 1) throw catalogError('target_ambiguous');
        if (matches.length === 0) throw catalogError('target_not_found');
        if (!eligibleLifecycle(matches[0])) throw catalogError('target_not_available');
        return matches[0];
      };
      const byAgent = selector.agent
        ? resolveUnique(catalog.brains.filter((brain) =>
            brain.ownerAgent === selector.agent && brain.kind === 'resident'))
        : null;
      const byId = selector.brainId
        ? resolveUnique(catalog.brains.filter((brain) => brain.id === selector.brainId))
        : null;
      if (byAgent && byId && byAgent.id !== byId.id) throw catalogError('target_mismatch');
      if (byId || byAgent) return byId || byAgent;
      return resolveUnique(catalog.brains.filter((brain) =>
        brain.ownerAgent === callerAgent && brain.kind === 'resident'));
    }

Compute catalogRevision with SHA-256 over sorted identity/lifecycle/boundary fields. Derive resident owner only from canonical instances/<agent>/brain roots. Derive research ownership and completion only from canonical run metadata; do not infer completed from a display name. Derive every `mutationBoundaries` record server-side after canonical-root resolution and ignore any caller/registry-supplied boundary array. Each entry has exactly one record for each required kind: `brain` is the canonical brain/source root; `run` is the same canonical brain root for a resident (never the noisy whole instance containing live logs/conversations) and the canonical research-run root for research; `pgs`, `session`, `cache`, `export`, and `agency` are the canonical named subtrees beneath the brain/source root. A missing subtree is still a canonical potential mutation boundary and is hashed as absent during no-write tests. Reject a kind outside the seven-kind enum, duplicate kinds, relative paths, or paths outside configured instances/research roots. Include the ordered `{kind,path}` records in catalogRevision. Each boundary is recursively inventoried so unknown or newly created paths are visible without accepting a path from request input.

A known catalog entry with lifecycle active or unavailable returns target_not_available, whether addressed by its exact brain ID or its unique canonical resident owner. A well-formed selector with no catalog match returns target_not_found. Unsupported selector fields and non-string/empty values return invalid_request. Duplicate display names stay visible but display-name selection is unsupported; duplicate canonical eligible owner mappings return target_ambiguous before choosing either entry.

- [ ] **Step 4: Expose the canonical contract and verify GREEN**

GET /api/brains returns the canonical catalog while preserving a legacy brains alias only where current UI callers require it. In `cosmo23/server/index.js`, derive `home23Root` from the installed server location, read ignored `config/agents.json` without logging its contents, pass its exact agent names plus canonical `instancesRoot`, `localRunsPath`, `referenceRunsPaths`, and current `activeRunPath` into the builder, and fail the canonical route closed on malformed config. A missing manifest before setup means an empty configured-agent list, not invented agents.

Canonical IDs are derived only from the real root, never the scanned symlink spelling or the existing path-derived ID. Update detail/query route resolution so the returned canonical route resolves back through the same catalog entry; retain old route keys as compatibility lookup aliases, not as cross-brain authorization identities. Add a symlink fixture assertion that its canonical route returns the same brain and does not create a second catalog identity. Validate the fixture with contracts/schemas/brain-operations.schema.json. Its `mutationBoundaries` schema is a required seven-item array whose objects require only `kind` and absolute `path`, set `additionalProperties:false`, enumerate all seven kinds, use `contains` plus `minContains:1`/`maxContains:1` for each kind, and set `uniqueItems:true`. Contract tests must reject a missing kind, duplicate kind, unknown kind, string member, relative path, caller-supplied outside path, and extra property.

Open reserved `COSMO23-VENDORED-PATCHES.md` Patch 47 with the canonical-catalog phase and state that its protected-worker phase lands in Task 5. Do not allocate Patch 48 or 49; those are reserved for source truth and provider execution.

Run the Step 2 command.

Expected: PASS with stable identity, deduplication, strict resolution, and contract validation.

- [ ] **Step 5: Commit the catalog**

    git add -- cosmo23/server/lib/brain-registry.js cosmo23/server/lib/brains-router.js cosmo23/server/lib/brains-router.test.js cosmo23/server/index.js tests/cosmo23/brain-catalog-contract.test.cjs contracts/schemas/brain-operations.schema.json docs/design/COSMO23-VENDORED-PATCHES.md
    git diff --cached --check
    git diff --cached
    git commit --only cosmo23/server/lib/brain-registry.js cosmo23/server/lib/brains-router.js cosmo23/server/lib/brains-router.test.js cosmo23/server/index.js tests/cosmo23/brain-catalog-contract.test.cjs contracts/schemas/brain-operations.schema.json docs/design/COSMO23-VENDORED-PATCHES.md -m "feat: add canonical brain catalog"

---

### Task 2: Capability Secret and Signed Trust Boundary

**Files:**
- Modify: cli/home23.js
- Create: cli/lib/brain-operations-capability.js
- Create: cli/lib/brain-operations-command.js
- Modify: cli/lib/init.js
- Modify: cli/lib/cosmo23-config.js
- Modify: cli/lib/pm2-commands.js
- Modify: cli/lib/update.js
- Modify: cli/lib/system-health.js
- Modify: cli/lib/generate-ecosystem.js
- Modify: config/secrets.yaml.example
- Create: shared/brain-operations/canonical-json.cjs
- Create: shared/brain-operations/capability.cjs
- Create: cosmo23/server/lib/capability-nonce-store.js
- Create: tests/engine/dashboard/brain-operation-capability.test.js
- Create: tests/cli/brain-operations-capability.test.js
- Modify: tests/engine/cli-onboarding.test.js

**Interfaces:**
- Consumes: secrets.yaml local-state seeding and ecosystem generation.
- Produces: canonicalJson(value), canonicalSha256(value), issueCapability(key, claims), verifyCapability(key, token, expected), CapabilityNonceStore.consume(), and `brain-operations prepare [--dry-run]`.

- [ ] **Step 1: Write failing capability and secret-plumbing tests**

Use a fixed test key and clock. The test must cover success, invalid signature, expiry, replay, and every binding mismatch:

    const claims = {
      requesterAgent: 'jerry',
      targetDomain: 'brain',
      targetBrainId: 'brain-forrest',
      targetRunId: null,
      targetRequesterAgent: null,
      canonicalRoot: '/brains/forrest',
      accessMode: 'read-only',
      operationType: 'query',
      operationId: 'op-123',
      sourcePinDigest: 'sha256:' + 'a'.repeat(64),
      issuedAt: 1_700_000,
      expiresAt: 1_800_000,
      nonce: 'nonce-1'
    };
    const token = issueCapability(TEST_KEY, claims);
    assert.deepEqual(verifyCapability(TEST_KEY, token, { ...claims, now: 1_700_000 }), claims);
    assert.throws(() => verifyCapability(TEST_KEY, token, { ...claims, operationId: 'op-999', now: 1_700_000 }), /capability_mismatch/);

First table-test `canonicalJson()`/`canonicalSha256()` with recursively reordered nested objects and require byte/digest identity; array order remains significant. Reject cycles, sparse arrays, nonfinite numbers, `undefined`, BigInt, functions, symbols, nonplain prototypes, getters/toJSON hooks, and dangerous prototype keys with typed `canonical_json_invalid`. This one shared primitive is used by operation idempotency, source descriptor digests, worker fingerprints, and receipts so separately implemented sorting cannot drift.

Table-test empty tokens, one-part tokens, extra segments, non-canonical base64url, validly signed non-JSON payloads, arrays/null instead of claim objects, absent/empty/non-string requester/access/type/operation/nonce fields, invalid target domains, zero or multiple populated target identity fields, a half-null target/root pair, nonstring target identity, nonnumeric issued/expiry times, issued-at too far in the future, expiry before issuance, a lifetime over `CAPABILITY_MAX_TTL_MS = 120000`, unsupported version, and absent verification time. Every malformed input must become a typed capability error rather than leaking a JSON/Buffer/TypeError. Target binding is exact: `targetDomain:'brain'` requires only nonempty `targetBrainId` plus absolute canonicalRoot; `targetDomain:'owned-run'` requires only nonempty `targetRunId` plus absolute canonicalRoot; `targetDomain:'requester'` requires only `targetRequesterAgent === requesterAgent` and canonicalRoot null. All unused target identity fields are exactly null and every field must equal trusted durable expectations. Issue must reject an absent key or non-object claims. The coordinator issues each endpoint token with a 60-second TTL; the 120-second verifier ceiling permits bounded clock skew, never an operation-duration bearer. Use a fresh token for each nonce-store assertion and prove 32 concurrent consume attempts yield exactly one success. With an injected clock, fill the nonce store, advance beyond expiry, and prove expired entries are pruned. Set an explicit maximum of 100,000 unexpired entries; at capacity fail closed with `capability_nonce_capacity` and never evict an unexpired nonce into replayability.

The generated ecosystem test must assert HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY exists only in dashboard and home23-cosmo23 env objects, never engine, harness, cron, or commonEnv. The existing-install test starts with a secrets file lacking brainOperations, invokes the exact migration command below twice, proves one stable key was persisted with mode 0600, regenerates ignored ecosystem.config.cjs with the same key, and proves both required process classes receive that key without logging it. The second normal invocation must leave the secrets and ecosystem target bytes/modes unchanged; transient acquisition/removal of the mutating helper's local lock is allowed.

Add a second existing-install fixture whose `config/secrets.yaml` already contains a valid stable capability key but is deliberately mode 0644. With ecosystem bytes and live process environments already correct, dry-run must report `permissionsWouldBeRepaired:true`, `permissionsRepaired:false`, `secretsModeBefore:'0644'`, and `secretsModeAfter:'0644'` while leaving bytes and mode unchanged. Normal prepare must preserve the exact key, report `permissionsRepaired:true`, and leave the file mode 0600 without requesting a PM2 refresh. A second normal prepare must leave the secrets/ecosystem bytes and target-file metadata unchanged with both permission flags false; only transient local lock lifecycle is allowed. This fixture is mandatory: an existing key is not prepared while its local secrets file remains group/world readable.

Assert every generated dashboard and the one shared `home23-cosmo23` process receive the same exact capability key read from `config/secrets.yaml`; per-agent keys are invalid because sibling dashboards must speak to the same protected COSMO worker. Assert no receipt, stdout/stderr capture, health response, or tracked file contains that value.

Also invoke `ensureBrainOperationsCapabilityKey()` concurrently 32 times against one temporary install. Assert every caller receives the same key, the final YAML parses, no temporary/lock artifact remains, the file mode is 0600, and a fault injected before rename leaves the prior secrets file byte-identical. Repeat the concurrency test against a mode-0644 file that already contains a key: exactly one serialized caller reports the repair, all callers receive the same unrotated key, and all observe final mode 0600. Inject a fault into the metadata-repair path and require a typed preparation failure rather than a false ready receipt. This is required because update/start preparation may overlap on a live installation.

Table-test malformed existing capability secrets: null, boolean, number, whitespace, short text, uppercase/nonhex, arrays/objects, and multiple YAML documents. The only accepted persisted key format is the generated 64-character lowercase hex value. Dry-run reports typed `capability_secret_invalid` without a write; normal prepare also fails closed and never silently rotates an invalid existing value, regenerates ecosystem config, or claims readiness. Key rotation needs a separate explicit future operator action because changing it invalidates live peer environments.

Route this exact idempotent existing-install command from `cli/home23.js`:

    node cli/home23.js brain-operations prepare [--dry-run]

Add CLI tests with injected filesystem and PM2 execution spies:

    const secretsPath = path.join(root, 'config', 'secrets.yaml');
    const ecosystemPath = path.join(root, 'ecosystem.config.cjs');
    const secretsBefore = await fs.promises.readFile(secretsPath, 'utf8');
    const ecosystemBefore = await fs.promises.readFile(ecosystemPath, 'utf8');
    const targetNames = ['home23-jerry-dash', 'home23-forrest-dash', 'home23-cosmo23'];
    const runningTargetsWithoutCapability = [
      ...targetNames.map((name) => ({ name, status: 'online', env: {} })),
      { name: 'home23-jerry', status: 'online', env: {} },
      { name: 'home23-jerry-harness', status: 'online', env: {} },
      { name: 'unrelated-service', status: 'online', env: {} },
    ];
    const dryRun = await runBrainOperationsCommand(root, ['prepare', '--dry-run'], {
      listProcesses: async () => runningTargetsWithoutCapability,
      runPm2: async (args) => pm2Calls.push(args),
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.keyCreated, false);
    assert.equal(dryRun.keyWouldBeCreated, true);
    assert.equal(dryRun.ecosystemRegenerated, false);
    assert.equal(dryRun.ecosystemWouldChange, true);
    assert.equal(dryRun.filesystemChanged, false);
    assert.equal(dryRun.filesystemWouldChange, true);
    assert.deepEqual(dryRun.changedProcessNames,
      ['home23-jerry-dash', 'home23-forrest-dash', 'home23-cosmo23']);
    assert.deepEqual(pm2Calls, []);
    assert.equal(await fs.promises.readFile(secretsPath, 'utf8'), secretsBefore);
    assert.equal(await fs.promises.readFile(ecosystemPath, 'utf8'), ecosystemBefore);
    assert.equal(await pathExists(path.join(root, 'config', '.brain-operations-capability.lock')), false);

    const prepared = await runBrainOperationsCommand(root, ['prepare'], {
      listProcesses: async () => runningTargetsWithoutCapability,
      runPm2: async (args) => pm2Calls.push(args),
    });
    assert.equal(prepared.keyCreated, true);
    assert.equal(prepared.ecosystemRegenerated, true);
    assert.equal(prepared.filesystemChanged, true);
    assert.deepEqual(prepared.changedProcessNames,
      ['home23-jerry-dash', 'home23-forrest-dash', 'home23-cosmo23']);
    assert.equal(prepared.restartRequired, true);
    assert.deepEqual(pm2Calls, []);
    const preparedCapability = readYamlOrEmpty(secretsPath).brainOperations.capabilityKey;
    const runningTargetsWithPreparedCapability = targetNames.map((name) => ({
      name, status: 'online',
      env: { HOME23_BRAIN_OPERATIONS_CAPABILITY_KEY: preparedCapability },
    }));

    const repeated = await runBrainOperationsCommand(root, ['prepare'], {
      listProcesses: async () => runningTargetsWithoutCapability,
      runPm2: async (args) => pm2Calls.push(args),
    });
    assert.deepEqual(repeated.changedProcessNames,
      ['home23-jerry-dash', 'home23-forrest-dash', 'home23-cosmo23']);
    assert.equal(repeated.keyCreated, false);
    assert.equal(repeated.ecosystemRegenerated, false);
    assert.equal(repeated.filesystemChanged, false);
    assert.equal(repeated.restartRequired, true);
    assert.deepEqual(pm2Calls, []);

    const settled = await runBrainOperationsCommand(root, ['prepare'], {
      listProcesses: async () => runningTargetsWithPreparedCapability,
      runPm2: async (args) => pm2Calls.push(args),
    });
    assert.deepEqual(settled.changedProcessNames, []);
    assert.equal(settled.restartRequired, false);
    assert.equal(settled.filesystemChanged, false);
    assert.deepEqual(pm2Calls, []);

    assert.deepEqual(buildScopedPm2RefreshArgs(prepared), [
      'start', 'ecosystem.config.cjs', '--only',
      'home23-jerry-dash,home23-forrest-dash,home23-cosmo23', '--update-env',
    ]);
    assert.throws(() => buildScopedPm2RefreshArgs({ ...prepared, restartRequired: false }),
      /refresh_not_required/);
    assert.throws(() => buildScopedPm2RefreshArgs({ ...prepared, liveEnvVerified: false }),
      /live_env_unverified/);

`prepare --dry-run` reports whether the key and ignored ecosystem would change but performs no writes and no restart. Snapshot the entire temporary install tree before and after dry-run, including absent directories, and require byte/type/mode/mtime identity with no lock/temp artifact; inject a concurrent input change and require `preparation_state_changed` rather than a mixed receipt. Normal `prepare` atomically creates the capability only when absent, regenerates ignored `ecosystem.config.cjs` only when bytes differ, and uses read-only PM2 inspection to report exact running `home23-<agent>-dash` and `home23-cosmo23` names whose live capability environment differs from the prepared config. Repeating it before an env refresh performs no filesystem write but continues to report stale live processes; after a successful named env refresh it reports none. It never invokes a PM2 mutation. If PM2 inspection is unavailable, fail closed with `liveEnvVerified:false` and the configured relevant names rather than claiming readiness.

Its non-secret receipt is the prerequisite for this exact later scoped rollout command:

    pm2 start ecosystem.config.cjs --only <comma-separated-changed-names> --update-env

That later operator/rollout action must first use the nonterminal-operation preflight in Task 4 and prove shared COSMO idle. For a PM2 ecosystem file, `pm2 start <ecosystem> --only ... --update-env` intentionally performs an exact-name restart with the new environment for matched existing processes and starts a matched configured process only when it is absent; it is not a no-restart operation. The command is allowed only when `restartRequired:true`, `liveEnvVerified:true`, and `changedProcessNames` is the exact nonempty allowlisted set; after it, rerun prepare and require `restartRequired:false`. Reject unknown flags and assert no receipt or command contains the capability key, `all`, `delete`, a separately issued broad `restart` command, an engine/harness process, or an unrelated process. Unit-test these semantics through the injected PM2 adapter and record the exact installed-PM2 behavior in the rollout receipt before live use.

- [ ] **Step 2: Run capability tests and verify RED**

    node --test --test-concurrency=1 tests/engine/dashboard/brain-operation-capability.test.js tests/cli/brain-operations-capability.test.js tests/engine/cli-onboarding.test.js

Expected: FAIL because the capability module, local key, and env injection do not exist.

- [ ] **Step 3: Implement the HMAC capability**

Create `shared/brain-operations/canonical-json.cjs` first. It recursively copies only null, booleans, finite numbers, strings, dense arrays, and own enumerable keys of plain objects into lexically sorted-key form without invoking getters or `toJSON`; serialize that value once and expose SHA-256 over its UTF-8 bytes. Use it for every canonical digest in this program.

Then use a versioned base64url payload and constant-time comparison:

    function issueCapability(key, claims) {
      if (!key) throw capabilityError('capability_unavailable');
      if (!claims || Array.isArray(claims) || typeof claims !== 'object') {
        throw capabilityError('capability_invalid');
      }
      const payload = Buffer.from(JSON.stringify({ v: 1, ...claims })).toString('base64url');
      const signature = createHmac('sha256', key).update(payload).digest('base64url');
      return payload + '.' + signature;
    }

    function verifyCapability(key, token, expected) {
      if (!key) throw capabilityError('capability_unavailable');
      const parts = typeof token === 'string' ? token.split('.') : [];
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw capabilityError('capability_invalid');
      const [payload, supplied] = parts;
      const suppliedBytes = Buffer.from(supplied, 'base64url');
      if (suppliedBytes.toString('base64url') !== supplied) throw capabilityError('capability_invalid');
      const calculated = createHmac('sha256', key).update(payload).digest();
      if (calculated.length !== suppliedBytes.length || !timingSafeEqual(calculated, suppliedBytes)) {
        throw capabilityError('capability_invalid');
      }
      let claims;
      try {
        const payloadBytes = Buffer.from(payload, 'base64url');
        if (payloadBytes.toString('base64url') !== payload) throw capabilityError('capability_invalid');
        claims = JSON.parse(payloadBytes.toString('utf8'));
      } catch (error) {
        if (error?.code?.startsWith('capability_')) throw error;
        throw capabilityError('capability_invalid');
      }
      validateClaims(claims, expected);
      return claims;
    }

    function capabilityError(code) {
      const error = new Error(code);
      error.code = code;
      return error;
    }

    function validateClaims(claims, expected) {
      if (!claims || Array.isArray(claims) || typeof claims !== 'object') {
        throw capabilityError('capability_invalid');
      }
      if (claims.v !== 1) throw capabilityError('capability_version');
      if (!Number.isFinite(expected?.now)) throw capabilityError('capability_invalid');
      if (!Number.isFinite(claims.issuedAt)
          || claims.issuedAt > expected.now + 5_000
          || !Number.isFinite(claims.expiresAt)
          || claims.expiresAt <= expected.now
          || claims.expiresAt <= claims.issuedAt
          || claims.expiresAt - claims.issuedAt > 120_000) {
        throw capabilityError('capability_expired');
      }
      for (const field of [
        'requesterAgent', 'accessMode', 'operationType', 'operationId', 'nonce',
      ]) {
        if (typeof claims[field] !== 'string' || !claims[field].trim()) {
          throw capabilityError('capability_invalid');
        }
      }
      const targetIds = [claims.targetBrainId, claims.targetRunId, claims.targetRequesterAgent];
      if (!['brain', 'owned-run', 'requester'].includes(claims.targetDomain)
          || targetIds.filter((value) => typeof value === 'string' && value.trim()).length !== 1) {
        throw capabilityError('capability_invalid');
      }
      const targetValid = claims.targetDomain === 'brain'
        ? (typeof claims.targetBrainId === 'string' && claims.targetBrainId.trim()
          && claims.targetRunId === null && claims.targetRequesterAgent === null
          && typeof claims.canonicalRoot === 'string' && path.isAbsolute(claims.canonicalRoot))
        : claims.targetDomain === 'owned-run'
          ? (claims.targetBrainId === null && typeof claims.targetRunId === 'string'
            && claims.targetRunId.trim() && claims.targetRequesterAgent === null
            && typeof claims.canonicalRoot === 'string' && path.isAbsolute(claims.canonicalRoot))
          : (claims.targetBrainId === null && claims.targetRunId === null
            && claims.targetRequesterAgent === claims.requesterAgent && claims.canonicalRoot === null);
      if (!targetValid) throw capabilityError('capability_invalid');
      for (const field of [
        'requesterAgent', 'targetDomain', 'targetBrainId', 'targetRunId',
        'targetRequesterAgent', 'canonicalRoot', 'accessMode', 'operationType', 'operationId',
      ]) {
        if (claims[field] !== expected[field]) throw capabilityError('capability_mismatch');
      }
      const pinDigestValid = claims.sourcePinDigest === null
        || (typeof claims.sourcePinDigest === 'string'
          && /^sha256:[a-f0-9]{64}$/.test(claims.sourcePinDigest));
      if (!pinDigestValid || claims.sourcePinDigest !== expected.sourcePinDigest) {
        throw capabilityError('capability_mismatch');
      }
    }

CapabilityNonceStore stores consumed nonce plus operation ID until expiry and rejects a second consume. It prunes expired entries before each consume, caps unexpired entries at 100,000, and fails closed rather than evicting a live replay marker. Each HTTP request receives a newly issued nonce; an SSE connection consumes its nonce once at connection establishment.

- [ ] **Step 4: Seed and isolate the capability key**

Create this idempotent helper and call it from init, COSMO config seeding, update before ignored ecosystem regeneration, and `brain-operations prepare`. Key lookup, creation, and permission repair are serialized across processes. The helper returns metadata rather than only the key so callers cannot silently ignore an unsafe existing mode:

    async function ensureBrainOperationsCapabilityKey(home23Root) {
      const secretsPath = path.join(home23Root, 'config', 'secrets.yaml');
      const configDir = path.dirname(secretsPath);
      await fs.promises.mkdir(configDir, { recursive: true });
      const release = await lockfile.lock(configDir, {
        realpath: false,
        lockfilePath: path.join(configDir, '.brain-operations-capability.lock'),
        retries: { retries: 20, minTimeout: 10, maxTimeout: 100 },
      });
      try {
        const secrets = readYamlOrEmpty(secretsPath);
        if (!secrets || Array.isArray(secrets) || typeof secrets !== 'object') {
          throw capabilityError('capability_secret_invalid');
        }
        const brainOperations = secrets.brainOperations;
        if (brainOperations !== undefined
            && (!brainOperations || Array.isArray(brainOperations)
              || typeof brainOperations !== 'object')) {
          throw capabilityError('capability_secret_invalid');
        }
        const existingKey = brainOperations?.capabilityKey;
        if (existingKey !== undefined
            && (typeof existingKey !== 'string' || !/^[a-f0-9]{64}$/.test(existingKey))) {
          throw capabilityError('capability_secret_invalid');
        }
        if (existingKey) {
          const modeBefore = (await fs.promises.stat(secretsPath)).mode & 0o777;
          let permissionsRepaired = false;
          if (modeBefore !== 0o600) {
            const handle = await fs.promises.open(secretsPath, 'r');
            try {
              await handle.chmod(0o600);
              await handle.sync();
            } finally {
              await handle.close();
            }
            const directory = await fs.promises.open(configDir, 'r');
            try { await directory.sync(); } finally { await directory.close(); }
            permissionsRepaired = true;
          }
          return {
            capabilityKey: existingKey,
            keyCreated: false,
            permissionsRepaired,
            secretsModeBefore: modeString(modeBefore),
            secretsModeAfter: modeString((await fs.promises.stat(secretsPath)).mode & 0o777),
          };
        }
        const capabilityKey = randomBytes(32).toString('hex');
        secrets.brainOperations = { ...(brainOperations || {}), capabilityKey };
        await writeYamlAtomic(secretsPath, secrets, { mode: 0o600 });
        return {
          capabilityKey,
          keyCreated: true,
          permissionsRepaired: false,
          secretsModeBefore: null,
          secretsModeAfter: '0600',
        };
      } finally {
        await release();
      }
    }

    function modeString(mode) {
      return mode.toString(8).padStart(4, '0');
    }

    function readYamlOrEmpty(filePath) {
      try { return yaml.load(fs.readFileSync(filePath, 'utf8')) || {}; }
      catch (error) {
        if (error.code === 'ENOENT') return {};
        throw capabilityError('capability_secret_invalid', { cause: error });
      }
    }

    async function writeYamlAtomic(filePath, value, options = {}) {
      const mode = options.mode || 0o600;
      const temporary = filePath + '.' + process.pid + '.' + randomUUID() + '.tmp';
      let handle;
      try {
        handle = await fs.promises.open(temporary, 'wx', mode);
        await handle.writeFile(yaml.dump(value, { lineWidth: 120 }), 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.promises.rename(temporary, filePath);
        await fs.promises.chmod(filePath, mode);
        const directory = await fs.promises.open(path.dirname(filePath), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await fs.promises.rm(temporary, { force: true });
        throw error;
      }
    }

Keep the example blank. Inject the one shared value directly into each dashboard and COSMO env. Add it to inherited-env blocklists so no engine/harness child receives it. system-health reports configured true/false without exposing the value. Existing installations therefore become ready on their next safe update/start preparation without rerunning destructive setup. `prepare --dry-run` uses a strictly read-only `inspectBrainOperationsCapabilityState()` plus a non-secret placeholder when comparing the prospective ecosystem; it must not acquire `proper-lockfile` because that would create a lock artifact. Instead read/lstat the secrets and ecosystem inputs twice, compare inode/size/mtime/ctime/mode snapshots around parsing, and fail closed with typed `preparation_state_changed` if either changes concurrently. It reports an unsafe existing mode but does not create a key, lock/temp file, directory, chmod, ecosystem, or secret disclosure. Normal callers use the serialized mutating helper, must destructure its result, and use `capabilityKey`; no caller may treat the whole result as a key. Capability tests also issue and verify a non-source operation with `sourcePinDigest:null`; a null digest is accepted only when the server authority row says the operation has no source, and never authorizes opening an unpinned current source.

`prepareBrainOperationsCapability()` returns this non-secret receipt:

    {
      dryRun: boolean,
      filesystemChanged: boolean,
      filesystemWouldChange: boolean,
      keyCreated: boolean,
      keyWouldBeCreated: boolean,
      permissionsRepaired: boolean,
      permissionsWouldBeRepaired: boolean,
      secretsModeBefore: string | null,
      secretsModeAfter: string | null,
      ecosystemRegenerated: boolean,
      ecosystemWouldChange: boolean,
      changedProcessNames: string[],
      restartRequired: boolean,
      liveEnvVerified: boolean
    }

`filesystemChanged` is exactly `keyCreated || permissionsRepaired || ecosystemRegenerated`. `filesystemWouldChange` is exactly `filesystemChanged || keyWouldBeCreated || permissionsWouldBeRepaired || ecosystemWouldChange`; on dry-run the first is always false and the second reports prospective target-file mutation. Neither flag includes transient mutating-lock lifecycle or any PM2 state.

Export `buildScopedPm2RefreshArgs(receipt)` as a pure guard for the later rollout. It requires `restartRequired:true`, `liveEnvVerified:true`, and a nonempty sorted/deduplicated `changedProcessNames` set matching only configured dashboard names plus `home23-cosmo23`; it returns exactly `['start','ecosystem.config.cjs','--only',names.join(','),'--update-env']`. It rejects `all`, globs, engines, harnesses, unrelated names, empty names, and any other PM2 verb. Preparation and this helper still perform no PM2 mutation.

Regeneration writes only ignored `ecosystem.config.cjs`. It does not stage or commit it. A newly created key or changed relevant environment means already-running dashboards and COSMO need the guarded named `pm2 start ecosystem.config.cjs --only <names> --update-env` refresh before capability traffic can work; the helper records that prerequisite as `restartRequired:true` and the exact live-stale process names but does not execute it. A permission-only repair with already-matching live env does not require a process refresh. Repeated normal execution with a stable key, mode 0600, and generated ecosystem performs no durable target-file write (apart from transient serialized lock lifecycle), while read-only inspection keeps `restartRequired:true` visible until live env matches. The later integration rollout owns the guarded named refresh; this command owns preparation only.

- [ ] **Step 5: Verify GREEN and commit**

Run the Step 2 command.

Expected: PASS; generated config never prints or serializes the secret into tracked files.

    git add -- cli/home23.js cli/lib/brain-operations-capability.js cli/lib/brain-operations-command.js cli/lib/init.js cli/lib/cosmo23-config.js cli/lib/pm2-commands.js cli/lib/update.js cli/lib/system-health.js cli/lib/generate-ecosystem.js config/secrets.yaml.example shared/brain-operations/canonical-json.cjs shared/brain-operations/capability.cjs cosmo23/server/lib/capability-nonce-store.js tests/engine/dashboard/brain-operation-capability.test.js tests/cli/brain-operations-capability.test.js tests/engine/cli-onboarding.test.js
    git diff --cached --check
    git diff --cached
    git commit --only cli/home23.js cli/lib/brain-operations-capability.js cli/lib/brain-operations-command.js cli/lib/init.js cli/lib/cosmo23-config.js cli/lib/pm2-commands.js cli/lib/update.js cli/lib/system-health.js cli/lib/generate-ecosystem.js config/secrets.yaml.example shared/brain-operations/canonical-json.cjs shared/brain-operations/capability.cjs cosmo23/server/lib/capability-nonce-store.js tests/engine/dashboard/brain-operation-capability.test.js tests/cli/brain-operations-capability.test.js tests/engine/cli-onboarding.test.js -m "feat: add brain operation capability boundary"

---

### Task 3: Durable Operation Store

**Files:**
- Create: engine/src/dashboard/brain-operations/operation-contract.js
- Create: engine/src/dashboard/brain-operations/operation-store.js
- Modify: engine/src/utils/durable-write.js
- Create: tests/engine/dashboard/brain-operation-store.test.js

**Interfaces:**
- Consumes: Requester agent name and ignored instances/<agent>/runtime root.
- Produces: `buildBrainOperationIdempotencyKey()`, stable target/request fingerprinting, and BrainOperationStore with atomic state, event, attachment, result, idempotency, reconciliation, and GC primitives.

- [ ] **Step 1: Write failing store state-machine tests**

Construct the store in a temporary directory and assert:

    const sameRequest = {
      requestId: 'request-1',
      requesterAgent: 'jerry',
      target: {
        domain: 'brain',
        brainId: 'brain-jerry', canonicalRoot: '/brains/jerry', accessMode: 'own',
        ownerAgent: 'jerry', displayName: 'jerry', kind: 'resident', lifecycle: 'resident',
        catalogRevision: 'catalog-1', route: '/api/brain/brain-jerry',
        mutationBoundaries: [
          { kind: 'brain', path: '/instances/jerry/brain' },
          { kind: 'run', path: '/instances/jerry/brain' },
          { kind: 'pgs', path: '/instances/jerry/brain/pgs-sessions' },
          { kind: 'session', path: '/instances/jerry/brain/sessions' },
          { kind: 'cache', path: '/instances/jerry/brain/cache' },
          { kind: 'export', path: '/instances/jerry/brain/exports' },
          { kind: 'agency', path: '/instances/jerry/brain/agency' },
        ],
      },
      operationType: 'query',
      requestParameters: { query: 'canary' },
      parameters: { query: 'canary' },
      sourcePinDescriptor: null,
      sourcePinDigest: null,
    };
    const concurrent = await Promise.all(
      Array.from({ length: 32 }, () => store.create(sameRequest))
    );
    assert.equal(concurrent.filter(({ created }) => created).length, 1);
    assert.deepEqual(new Set(concurrent.map(({ record }) => record.operationId)).size, 1);
    const first = concurrent[0].record;
    const duplicate = await store.create(sameRequest);
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.record.operationId, first.operationId);
    assert.equal((await store.list()).length, 1);
    const catalogDrift = await store.create({
      ...sameRequest,
      target: {
        ...sameRequest.target,
        displayName: 'renamed display only',
        catalogRevision: 'catalog-2',
        mutationBoundaries: sameRequest.target.mutationBoundaries.map((boundary) => ({ ...boundary })),
      },
    });
    assert.equal(catalogDrift.created, false);
    assert.equal(catalogDrift.record.operationId, first.operationId);
    await assert.rejects(() => store.create({
      ...sameRequest,
      target: {
        ...sameRequest.target,
        brainId: 'brain-forrest',
        canonicalRoot: '/brains/forrest',
        accessMode: 'read-only',
        ownerAgent: 'forrest',
      },
    }), /idempotency_conflict/);
    await assert.rejects(() => store.create({
      ...sameRequest,
      requestParameters: { query: 'different request under reused id' },
      parameters: { query: 'different request under reused id' },
    }), /idempotency_conflict/);
    const operationDirectories = (await fs.promises.readdir(
      path.join(root, 'operations'), { withFileTypes: true }
    )).filter((entry) => entry.isDirectory());
    assert.equal(operationDirectories.length, 1);

Assert every created operation ID matches `^brop_[A-Za-z0-9_-]{32}$`, is generated from 24 random bytes, differs from requestId, and remains identical only for an idempotent duplicate. Table-test empty/oversized/non-string/control-character request IDs and requester/type/attachment identifiers, traversal, separators, NUL, Unicode separator lookalikes, and caller-supplied operation IDs; all fail before any directory/index/lock is created. Attachment IDs are bounded opaque client correlation IDs, never filesystem paths.

Inject a crash after the initial `status.json` rename and directory fsync but before the idempotency-index rename. Reload the store and call `findByIdempotencyKey()` before any catalog lookup; it must discover the one durable orphan by its persisted idempotency key/fingerprint, repair the index under the requester lock, and return that exact operation. Retrying `create()` then returns it with `created:false`; no second operation directory or worker-owning create result may appear. Delete/corrupt only the test index and prove the same recovery. Two valid records claiming one key, a record/requester mismatch, or an indexed record whose stored fingerprint differs must fail closed as `idempotency_corrupt`, never pick one. A fault before the status rename leaves no visible record/index and may be retried as one fresh `created:true` operation.

    const descriptor = {
      version: 1,
      canonicalRoot: '/brains/jerry',
      generation: 'g1',
      sourceMode: 'memory_manifest',
      baseRevision: 1,
      cutoffRevision: 1,
      activeBase: {
        nodes: { file: 'memory-nodes.base-1.jsonl.gz', count: 12, bytes: 100 },
        edges: { file: 'memory-edges.base-1.jsonl.gz', count: 20, bytes: 200 },
      },
      activeDelta: {
        epoch: 'e1', file: 'memory-delta.e1.jsonl', fromRevision: 2,
        toRevision: 1, count: 0, committedBytes: 0,
      },
      summary: { nodeCount: 12, edgeCount: 20, clusterCount: 3 },
    };
    const digest = 'sha256:' + crypto.createHash('sha256')
      .update(canonicalJson(descriptor)).digest('hex');
    const attached = await store.attachSourcePin(first.operationId, {
      expectedVersion: first.recordVersion, descriptor, digest,
    });
    assert.deepEqual(attached.sourcePinDescriptor, descriptor);
    assert.equal(attached.sourcePinDigest, digest);
    const attachmentRetries = await Promise.all(Array.from({ length: 32 }, () =>
      store.attachSourcePin(first.operationId, {
        expectedVersion: first.recordVersion, descriptor, digest,
      })));
    assert.deepEqual(new Set(attachmentRetries.map((row) => row.recordVersion)),
      new Set([attached.recordVersion]));
    await assert.rejects(() => store.attachSourcePin(first.operationId, {
      expectedVersion: attached.recordVersion,
      descriptor: { ...descriptor, cutoffRevision: 2 }, digest: 'sha256:' + 'b'.repeat(64),
    }), /source_pin_conflict/);

Before the successful attachment, table-test deleting or changing each of
`activeBase.nodes.count/bytes`, `activeBase.edges.count/bytes`, and
`activeDelta.fromRevision/toRevision/count/committedBytes`, including zero base
bytes, inconsistent range/count, fractions, negatives, strings, unknown keys,
and a digest recomputed over the malformed descriptor. Every case rejects
before durable attachment or capability issuance; recomputing the hash never
makes an invalid descriptor valid.

    const running = await store.transition(first.operationId, {
      expectedVersion: attached.recordVersion,
      state: 'running'
    });
    await store.openAttachment(first.operationId, 'a');
    await store.openAttachment(first.operationId, 'b');
    await store.detachAttachment(first.operationId, 'a', 'wait_deadline');
    assert.equal((await store.get(first.operationId)).state, 'running');
    assert.equal((await store.getAttachment(first.operationId, 'b')).state, 'attached');

Add concurrent cancel-versus-complete, terminal immutability, monotonic event sequence, crash-safe reload, nonterminal GC protection, and 7/30-day retention tests. Define `OPERATION_EVENT_MAX_COUNT = 4096` and `OPERATION_EVENT_MAX_BYTES = 8 * 1024 * 1024`; flood both limits, prove noisy heartbeat/progress events are coalesced/evicted while phase/provider/terminal/gap evidence remains, and require an `event_gap` envelope with oldest/latest sequence when a reader resumes before the retained window. Race `setResult({expectedVersion,...})` against cancellation in both deterministic lock orders: cancellation-first rejects the late result without files/handles/status mutation; result-first may retain the committed bytes as partial evidence but the later completion transition cannot overwrite a winning cancelled state. A second result or worker assignment and any mutation after terminal state must be rejected.

Add exact 64 KiB inline-boundary, atomic-file, protected-handle, and retention tests:

    const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify({ answer: '' }), 'utf8');
    const inline = { answer: 'x'.repeat((64 * 1024) - emptyEnvelopeBytes) };
    assert.equal(Buffer.byteLength(JSON.stringify(inline), 'utf8'), 64 * 1024);
    const { record: inlineOperation } = await store.create({
      ...sameRequest, requestId: 'request-inline'
    });
    const inlineStored = await store.setResult(inlineOperation.operationId, {
      expectedVersion: inlineOperation.recordVersion,
      result: inline,
    });
    assert.deepEqual(inlineStored.result, inline);
    assert.equal(inlineStored.resultHandle, null);

    const large = { answer: inline.answer + 'x' };
    assert.equal(Buffer.byteLength(JSON.stringify(large), 'utf8'), (64 * 1024) + 1);
    const { record: largeOperation } = await store.create({
      ...sameRequest, requestId: 'request-large'
    });
    const stored = await store.setResult(largeOperation.operationId, {
      expectedVersion: largeOperation.recordVersion,
      result: large,
    });
    assert.match(stored.resultHandle, /^brres_[A-Za-z0-9_-]{32}$/);
    assert.equal(stored.result, null);
    assert.deepEqual(stored.resultArtifact, {
      mediaType: 'application/json',
      contentEncoding: 'identity',
      bytes: Buffer.byteLength(JSON.stringify(large), 'utf8'),
      sha256: crypto.createHash('sha256').update(JSON.stringify(large)).digest('hex'),
    });
    assert.deepEqual(await store.getResult(largeOperation.operationId, {
      requesterAgent: 'jerry', resultHandle: stored.resultHandle,
    }), large);
    await assert.rejects(() => store.getResult(largeOperation.operationId, {
      requesterAgent: 'forrest', resultHandle: stored.resultHandle,
    }), /access_denied/);
    await assert.rejects(() => store.getResult(largeOperation.operationId, {
      requesterAgent: 'jerry', resultHandle: 'brres_invalid',
    }), /result_handle_invalid/);
    const terminal = await store.transition(largeOperation.operationId, {
      expectedVersion: stored.recordVersion,
      state: 'complete',
    });
    assert.ok(terminal.resultExpiresAt);
    assert.ok(terminal.metadataExpiresAt);

Inject a durable writer that fails before rename and assert no `result.json`, handle index, or status mutation becomes visible. Terminalize both inline and file-backed result fixtures, advance the injected clock seven days plus one millisecond, run collectGarbage(), and assert inline payload bytes are cleared, `result.json` plus its handle index are removed, both reads return `result_expired`, and terminal state/error/sourceEvidence metadata remains until day 30. Assert nonterminal operations retain all inline/file-backed results and scratch regardless of age.

Add a streaming artifact-adoption test for full-graph export. Write a large uncompressed JSONL fixture beneath that operation's own scratch directory, compute its byte count and SHA-256 by stream, and call:

    await store.adoptResultArtifact(graphOperation.operationId, {
      expectedVersion: graphOperation.recordVersion,
      scratchPath: graphScratchPath,
      mediaType: 'application/x-ndjson',
      contentEncoding: 'identity',
      bytes: graphBytes,
      sha256: graphSha256,
    });

Assert the store never calls `readFile` on the artifact, atomically moves it to the fixed private operation artifact name, leaves public `result:null`, records only `{mediaType,contentEncoding,bytes,sha256}` plus the opaque `brres_` handle publicly, and `openResultArtifact()` streams byte-identical content. Reject sources outside that operation's canonical scratch root, symlinks, directories, byte/hash mismatches, gzip/non-identity encoding, unsupported media type, a byte count over `OPERATION_RESULT_ARTIFACT_MAX_BYTES = 2 * 1024 * 1024 * 1024`, and a second adoption. Inject failure before rename and prove neither public artifact metadata nor a handle becomes visible.

Add atomic pin-attachment crash tests. Inject failure before the `status.json` rename and prove the prior record remains byte-identical with both pin fields null. Retry the same descriptor/digest and prove one version increment; repeat the exact call after a simulated lost response and prove it is an idempotent read with no new event/version. A different descriptor or digest is `source_pin_conflict`. Reload the store after each crash point and prove reconciliation can distinguish: (a) no provider pin yet, (b) an operation-owned provider pin exists but the record fields are null, and (c) the descriptor/digest are durable but no worker is recorded. Non-source operations must retain `sourcePinDescriptor:null` and `sourcePinDigest:null` through terminalization and reconciliation.

Table-test `attachSourcePin()` with manifest and legacy-projection descriptors. Both accepted forms have numeric `version:1`, nonempty generation, safe-integer nonnegative `baseRevision` and `cutoffRevision` with cutoff not below base, exact canonical target root, relative generated basenames only, and no `projectionRoot`, `lockRoot`, `operationRoot`, or absolute file. Reject string `'1'`, version 0, float/unsafe/string/null/absent revisions, null generation, traversal/absolute files, a physical legacy projection path, and a digest that is not the exact canonical descriptor SHA-256. A legacy descriptor remains indistinguishable in authority shape from a native numeric-v1 descriptor; its trusted private projection mapping is owned only by the source provider.

The full result must live in atomically replaced `result.json` under the operation directory. A companion requester-scoped handle index stores only a SHA-256 handle hash to operation mapping. The returned resultHandle is random opaque metadata, not a path, operation ID, or bearer token.

- [ ] **Step 2: Run store tests and verify RED**

    node --test --test-concurrency=1 tests/engine/dashboard/brain-operation-store.test.js

Expected: FAIL because BrainOperationStore does not exist.

- [ ] **Step 3: Implement the operation contract and atomic store**

Define:

    const EXECUTION_STATES = ['queued', 'running', 'complete', 'partial', 'failed', 'cancelled', 'interrupted'];
    const TERMINAL_STATES = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
    const ATTACHMENT_STATES = ['attached', 'detached', 'closed'];

Every persisted/public record uses these canonical names:

    {
      operationId,
      requestId,
      operationType,
      requestParameters,
      parameters,
      canonicalEvidence,
      recordVersion,
      eventSequence,
      requesterAgent,
      target:
        | {
            domain: 'brain', brainId, canonicalRoot, accessMode, ownerAgent, displayName,
            kind, lifecycle, catalogRevision, route, mutationBoundaries
          }
        | {
            domain: 'owned-run', runId, canonicalRoot, ownerAgent, runState,
            catalogRevision, route, mutationBoundaries
          }
        | { domain: 'requester', requesterAgent },
      state,
      phase,
      startedAt,
      updatedAt,
      completedAt,
      lastProviderActivityAt,
      lastProgressAt,
      result,
      resultHandle,
      resultArtifact: { mediaType, contentEncoding: 'identity', bytes, sha256 } | null,
      error,
      sourceEvidence,
      sourcePinDescriptor,
      sourcePinDigest,
      sourcePinReleasedAt,
      resultExpiresAt,
      resultExpiredAt,
      metadataExpiresAt
    }

Implement this exact public interface:

    interface BrainOperationStore {
      create(input): Promise<{ record: BrainOperationRecord, created: boolean }>;
      get(operationId): Promise<BrainOperationRecord>;
      list(): Promise<BrainOperationRecord[]>;
      findByIdempotencyKey(key): Promise<BrainOperationRecord | null>;
      appendEvent(operationId, event): Promise<BrainOperationRecord>;
      readEvents(operationId, afterSequence): Promise<BrainOperationEvent[]>;
      transition(operationId, transition): Promise<BrainOperationRecord>;
      setWorker(operationId, { expectedVersion, worker }): Promise<BrainOperationRecord>;
      getWorker(operationId): Promise<object | null>;
      ensureScratchDirectory(operationId): Promise<string>;
      attachSourcePin(operationId, input: {
        expectedVersion, descriptor, digest
      }): Promise<BrainOperationRecord>;
      setResult(operationId, { expectedVersion, result }): Promise<BrainOperationRecord>;
      adoptResultArtifact(operationId, input): Promise<BrainOperationRecord>;
      getResult(operationId, { requesterAgent, resultHandle }): Promise<object>;
      openResultArtifact(operationId, { requesterAgent, resultHandle }): Promise<{ metadata, stream }>;
      openAttachment(operationId, attachmentId): Promise<object>;
      getAttachment(operationId, attachmentId): Promise<object>;
      detachAttachment(operationId, attachmentId, reason): Promise<object>;
      closeAttachment(operationId, attachmentId, reason): Promise<object>;
      listNonterminal(): Promise<BrainOperationRecord[]>;
      listPinsPendingRelease(): Promise<BrainOperationRecord[]>;
      releaseSourcePinOnce(operationId, releasedAt, release): Promise<BrainOperationRecord>;
      collectGarbage(now?): Promise<object>;
    }

`getWorker()`, `ensureScratchDirectory()`, `readEvents()`, and
`closeAttachment()` are privileged coordinator/executor seams on the mutable
store. They are never methods on `BrainOperationStoreReader`, never mounted as
generic HTTP methods, and never expose worker records or absolute scratch paths
through a public record. The public routes use their purpose-built coordinator
methods and requester-bound reader facade only.

Export one `buildBrainOperationIdempotencyKey(requesterAgent,requestId,operationType)` from `operation-contract.js`; both coordinator and store use it and validate nonempty bounded strings before hashing. The key is SHA-256(requesterAgent + NUL + requestId + NUL + operationType). The store generates operation IDs as `brop_` plus 24 cryptographically random bytes in canonical base64url; it never accepts an operation ID from input or derives one from the request ID. Store the idempotency mapping in `idempotency/index.json` under the requester runtime root together with `canonicalSha256({target:stableTargetIdentity,requestParameters})` from the one shared canonical-JSON module; reject non-JSON values before fingerprinting. Stable brain identity is exactly `{domain:'brain',brainId,canonicalRoot,accessMode}`, stable owned-run identity is exactly `{domain:'owned-run',runId,canonicalRoot,ownerAgent}`, and requester-domain identity is exactly `{domain:'requester',requesterAgent}`. Exclude display name, counts, modified time, lifecycle/run state, catalog revision, mutation-boundary copies, source revision, server-injected provider/model, and all other drift-prone evidence from this fingerprint. `requestParameters` stores normalized caller intent; `parameters` stores the trusted executor parameters and may additionally contain server-derived values such as the synthesis provider/model pair.

`create()` holds the requester-level `idempotency/.index.lock` across index reload, lookup, fingerprint comparison, operation-directory creation, initial status fsync/rename, and index fsync/rename; there is no unlocked create decision. Persist the idempotency key and request fingerprint inside the private on-disk status record as well as the index, but strip both from every public/store-reader/route projection. The live mutable store's `findByIdempotencyKey()` also takes this lock and, when an entry is missing, scans canonical nonsymlink operation directories for valid status records claiming that key before returning not-found. Exactly one match repairs the index atomically and returns it; multiple matches or any key/fingerprint/requester inconsistency is `idempotency_corrupt`. `create()` repeats the same lookup/repair after taking the lock, closing both concurrent-create and the unavoidable crash window after status commit but before index commit. The separate read-only store reader used by CLI/HTTP projections never runs this repair or acquires a mutating lock.

`create()` returns `{record,created}`. Exactly one of 32 semantically equivalent concurrent duplicate starts returns `created:true`; all others return the same durable record with `created:false`. Catalog/display/boundary drift for the same stable target identity is not a conflict and never replaces the original target snapshot. Reusing the same key with a different stable target or normalized caller-parameter fingerprint fails `idempotency_conflict` and never returns/starts the old work as though it matched. A fault before status rename cleans its temporary artifact; a committed orphan is recovered rather than duplicated. `transition()` reloads status under the operation lock, compares expectedVersion, rejects a second terminal transition, increments recordVersion, and stamps updatedAt/completedAt.

`create()` always initializes `sourcePinDescriptor:null` and `sourcePinDigest:null`; request input cannot pre-seed either field. `attachSourcePin(operationId,{expectedVersion,descriptor,digest})` holds the operation lock, reloads status, and validates the source contract's exact numeric-v1 public descriptor. Each exact active-base node/edge object requires a relative basename plus nonnegative safe-integer count and positive safe-integer compressed bytes. The exact delta object requires a bounded epoch/basename, `fromRevision === baseRevision + 1`, `toRevision === cutoffRevision`, `count === cutoffRevision - baseRevision`, and nonnegative safe-integer committedBytes. It also requires bounded nonnegative scalar node/edge/cluster summary, exact target canonicalRoot, no unknown keys/private projection/lock paths, and an exact lowercase `sha256:<64 hex>` digest of canonical JSON. It compares expectedVersion and commits both fields in one atomic status write before capability issuance is possible. An exact descriptor/digest retry returns the current record even if `expectedVersion` is the pre-attachment version, covering a lost response. Any non-identical second attachment is `source_pin_conflict`. A failure before rename exposes neither field. The coordinator/provider reconciliation contract, not the store, decides whether to repin or interrupt a queued record whose fields remain null.

Define `INLINE_RESULT_LIMIT_BYTES = 64 * 1024`. `setWorker()` and `setResult()` hold the operation lock, compare `expectedVersion`, and reject terminal or already-result-bearing records before mutating anything. This prevents a late worker/result callback from changing a cancelled/failed operation. `setResult()` measures the complete UTF-8 JSON encoding. Values at or below the limit remain inline. Larger values are written by temp-file, file fsync, atomic rename to `result.json`, and parent-directory fsync before status may expose a handle. Their public status is always `result:null`, `resultArtifact:{mediaType:'application/json',contentEncoding:'identity',bytes,sha256}`, and an opaque handle; never use a truncation string as a result. Generate handles with `brres_` plus 24 random bytes encoded base64url; persist only `sha256(handle)` in the requester-scoped handle index.

`adoptResultArtifact()` is the non-materializing result path. Under the operation lock it compares `expectedVersion`, requires a safe integer `0 <= bytes <= OPERATION_RESULT_ARTIFACT_MAX_BYTES`, verifies by lstat plus realpath that `scratchPath` is a regular nonsymlink file inside that same operation's canonical scratch root, requires a one-link source inode, and verifies caller-supplied byte count and SHA-256 through one stable open stream. It then streams those verified bytes into a new private one-link inode, fsyncs it, atomically renames that inode to the fixed private operation artifact name, fsyncs the directory, and only then commits `result:null`, `resultArtifact:{mediaType,contentEncoding,bytes,sha256}`, and a handle. Copying into a new inode is intentional: a retained writable descriptor or surviving hardlink to the worker scratch inode can never mutate published result bytes. A crash after private-artifact publication but before status publication is reconciled only from an exact byte/hash/media match; orphan handle indexes are removed before retry. The aggregate scratch quota introduced in Source Task 2 accounts for both source and destination bytes during this handoff, and production source-requiring graph export remains disabled until that quota is connected. `openResultArtifact()` repeats requester/handle authorization and returns a read stream; it never publishes a filesystem path. A graph executor cannot adopt a file from another operation or target tree.

Neither result method starts retention while the operation remains nonterminal. The successful terminal transition atomically sets `completedAt`, `resultExpiresAt = completedAt + 7 days`, and `metadataExpiresAt = completedAt + 30 days` in the same record write. `getResult()` and `openResultArtifact()` require the dashboard-derived requester to match the record and a timing-safe handle-hash match for file-backed data.

At seven days, `collectGarbage()` removes file-backed JSON/artifact results, handle indexes, and scratch; clears any inline result payload; sets `resultExpiredAt`; and leaves only an expired-result summary plus terminal state, error, sourceEvidence, and other metadata until day 30. Retrieval then returns typed `result_expired`. This GC-only payload retirement is allowed after terminalization but cannot change execution state/error/evidence. At day 30 it removes terminal metadata. It skips every nonterminal record regardless of age.

`releaseSourcePinOnce()` holds the operation lock across record reload, the injected idempotent release callback, `sourcePinReleasedAt` update, and durable record write. Concurrent callers whose marker is already present return without invoking the callback. The callback must itself be idempotent by operation ID to cover a process crash after external release but before the marker write. Use proper-lockfile around all per-operation mutation. Write status/result/attachment JSON through temp file, fsync, rename, and parent-directory fsync. Append events under the same lock with strictly increasing eventSequence and increment recordVersion on each committed state mutation. Reject path traversal in operation, requester, and attachment identifiers.

Lock acquisition is bounded but aligned with the operation protocol rather than
a short HTTP wait: the default mutation-lock acquisition deadline is at least
the maximum configured server execution deadline (eight hours by default), is
explicitly configurable for deterministic tests, retains proper-lockfile stale
owner heartbeats, and reports typed `operation_lock_timeout` only after that
deadline. A legitimate multi-gigabyte artifact stream or idempotent pin-release
callback must not fail because an unrelated five-second retry budget expired.

- [ ] **Step 4: Verify GREEN and commit**

Run the Step 2 command.

Expected: PASS, including concurrency and reload tests.

    git add -- engine/src/dashboard/brain-operations/operation-contract.js engine/src/dashboard/brain-operations/operation-store.js engine/src/utils/durable-write.js tests/engine/dashboard/brain-operation-store.test.js
    git diff --cached --check
    git diff --cached
    git commit --only engine/src/dashboard/brain-operations/operation-contract.js engine/src/dashboard/brain-operations/operation-store.js engine/src/utils/durable-write.js tests/engine/dashboard/brain-operation-store.test.js -m "feat: persist durable brain operations"

---

### Task 4: Dashboard Coordinator and Public Operation Routes

**Files:**
- Modify: cli/home23.js
- Modify: cli/lib/brain-operations-command.js
- Create: shared/brain-operations/authority.cjs
- Create: engine/src/dashboard/brain-operations/coordinator.js
- Create: engine/src/dashboard/brain-operations/router.js
- Create: engine/src/dashboard/brain-operations/worker-adapter.js
- Create: engine/src/dashboard/brain-operations/store-reader.js
- Create: engine/src/dashboard/brain-operations/exporter.js
- Modify: engine/src/dashboard/server.js
- Create: tests/cli/brain-operations-list.test.js
- Create: tests/engine/dashboard/brain-operation-authority.test.js
- Create: tests/engine/dashboard/brain-operation-coordinator.test.js
- Create: tests/engine/dashboard/brain-operation-exporter.test.js
- Create: tests/engine/dashboard/brain-operation-routes.test.js

**Interfaces:**
- Consumes: BrainOperationStore, buildCanonicalCatalog(), resolveCanonicalTarget(), shared authority matrix, worker adapter, optional sourcePin provider, injected `operationModelResolver`, clock, and timers.
- Produces: BrainOperationCoordinator including read-only `resolveTargetContext(selector)`, requester-authenticated read-only store access, canonical exporter, operator nonterminal preflight, and /home23/api/brain-operations routes.

- [ ] **Step 1: Write failing coordinator timing and reconciliation tests**

Use injected timers and deferred promises. Assert:

    const operation = await coordinator.start({
      requestId: 'req-1',
      operationType: 'query',
      target: { brainId: 'brain-forrest' },
      parameters: { query: 'canary' }
    });
    const a = await coordinator.attach(operation.operationId, { attachmentId: 'a' });
    const b = await coordinator.attach(operation.operationId, { attachmentId: 'b' });
    await coordinator.detach(operation.operationId, { attachmentId: 'a', reason: 'wait_deadline' });
    await a.done;
    assert.equal((await coordinator.status(operation.operationId)).state, 'running');
    worker.emit({ type: 'progress', eventSequence: 2, operationId: operation.operationId });
    assert.equal(await b.nextEvent().then((event) => event.eventSequence), 2);

Before operation-start tests, call `coordinator.resolveTargetContext({})` and
`coordinator.resolveTargetContext({agent:'forrest'})`. Assert it builds the same
fresh canonical catalog used by `start()`, returns exactly frozen
`{catalogRevision,target,accessMode}` with the canonical entry (including route
and all seven mutation boundaries), performs no store/pin/capability/worker
side effect, and never adds an operation/request ID. Unknown, unavailable,
ambiguous, malformed, or caller-spoofed selectors retain the catalog's typed
errors. This read-only seam is used by same-agent compatibility search/status/
graph routes; those routes create their own ephemeral operation identity.

Add a 32-caller concurrent-start fixture using one byte-equivalent request. Assert one durable operation ID, exactly one `store.create()` result with `created:true`, one source `pin`, one capability issuance, and one worker start. Every `created:false` caller returns the original queued/running record and performs none of those post-create side effects. Inject a crash after durable create but before source pin and prove startup reconciliation, rather than a duplicate request handler, resumes that operation through the idempotent pin/attach/start path.

Add lost-start-response retry tests. After the original operation is durable, make the live catalog rename/change revision and then make catalog resolution unavailable. Retrying the same requester/requestId/type, normalized caller parameters, and a selector that still denotes the persisted target must return the original operation without catalog resolution, configured-model resolution, pinning, capability issuance, or worker start. `{agent:'forrest'}`, `{brainId: persisted.target.brainId}`, and the matching combined selector are equivalent for that persisted resident target. A different agent/brain ID, a mismatched combined selector, different normalized caller parameters, or a requester-domain target is `idempotency_conflict` even while the catalog is unavailable. For synthesis, change the configured provider/model after the first start and prove the retry retains the original persisted executor pair and never calls the resolver again.

Also test 10-second queued/running heartbeats, 60-second event silence followed by status/reconnect, a worker `event_gap` followed by current-status plus future-event resumption, provider-stall cancellation despite heartbeats, hard execution deadline, explicit cancel propagation, complete/cancel race, and startup reconciliation. `event_gap` records a canonical gap event/evidence marker but does not fail or cancel a worker whose authenticated current status is still running.

Provider stall tracking is per active provider call, never one replaceable operation timer. Every `provider_selected`, `provider_activity`, and `provider_call_terminal` worker event carries the same nonempty `providerCallId`. Query, synthesis, and research compile use stable singleton IDs `query`, `synthesis`, and `research_compile`; PGS sweep calls use `pgs:<workUnitId>` and final PGS synthesis uses `pgs:synthesis`. A valid selected event carries a positive finite `providerStallMs` no greater than the operation hard deadline and creates exactly one entry in an operation-local `Map<providerCallId,{providerStallMs,lastActivityAt,timer}>`; duplicate selected for an already-active ID is `provider_contract_invalid`. Selection does not update the record's aggregate `lastProviderActivityAt`. A matching activity event renews only that call's timer and updates both call and aggregate timestamps from the coordinator's injected local receipt clock. Worker/provider/child timestamps are diagnostic only and can never control a timer or persisted activity truth. Activity or terminal events for an unknown ID fail closed. A matching terminal event clears only that call's timer and removes its entry; it cannot make the operation terminal by itself. Heartbeat, phase, token-estimate, activity from a sibling provider call, and generic progress never renew another call.

Use fake timers with two concurrent deferred PGS sweeps. Emit activity every second for `pgs:p1-u1` while `pgs:p2-u1` is silent; prove the silent sibling expires at its own bound, cancels the worker, clears every call timer, and terminalizes the operation with retryable `provider_stalled` plus `providerCallId:'pgs:p2-u1'`, preserving partial result/evidence. Also prove an on-time `provider_call_terminal` clears one timer without touching its sibling. Feed past, future, malformed, and absent child timestamps and prove every renewal uses only local receipt time. Invalid/absent stall data or call correlation is `provider_contract_invalid` before a provider-selected operation can be reported complete. On worker reattachment, authenticated worker status returns the bounded active-call snapshot `{providerCallId,providerStallMs,idleMs}`; the worker derives nonnegative finite `idleMs` from its injected monotonic activity clock at status serialization, not a wall-clock timestamp. Coordinator validates unique IDs and `0 <= idleMs`, rearms each timer for `providerStallMs-idleMs` from its own receipt clock, and immediately expires any `idleMs >= providerStallMs`. No active-call snapshot may be supplied by caller parameters or an unauthenticated event. Use fake timers throughout with no sleep. Verify the coordinator releases its requester-owned source pin exactly once on worker-start failure and every terminal path, but not on caller detachment or successful reattachment:

    worker.proveActive = async (operationId) => operationId === liveOperation.operationId;
    await coordinator.reconcile();
    assert.equal((await coordinator.status(liveOperation.operationId)).state, 'running');
    assert.equal(worker.reattached.includes(liveOperation.operationId), true);
    assert.equal((await coordinator.status(orphanedOperation.operationId)).state, 'interrupted');
    assert.equal(worker.cancelled.includes(orphanedOperation.operationId), true);

Make pin-release coverage exhaustive and crash-recoverable. For each of `complete`, `partial`, `failed`, `cancelled`, and `interrupted`, terminalize an independently pinned operation, race 32 duplicate terminal callbacks, and run reconciliation twice; assert one release callback invocation, one externally visible release, and one durable `sourcePinReleasedAt`. Cover worker-start rejection after the coordinator pin is durable, an orphaned nonterminal reconciled to `interrupted`, a live nonterminal reattached without release, and a pre-existing terminal record whose pin marker is absent. The latter must release and mark exactly once during reconciliation. Inject a source-pin provider whose `releaseOperationPins(operationId)` is idempotent by operation ID so a crash after provider release but before the marker cannot make a second visible release.

Cover all create/pin/attach/capability crash windows with an idempotent provider `pin(canonicalRoot,operationId)`. If reconciliation sees a queued source operation with null pin fields, it calls that same idempotent pin operation: no provider pin yet creates one; an already-durable operation pin returns the same descriptor/digest; then `attachSourcePin()` commits both atomically before capability issuance. If the record has a durable descriptor/digest but no worker, reconciliation resumes capability issuance/start from that record. If the provider cannot prove/recreate the exact pin, terminalize `interrupted` and release any operation-owned pin. Reconciliation of a non-source operation never calls pin/open/release merely because both pin fields are null.

Add a lying-worker evidence fixture. The worker returns correct numeric watermarks but false identity fields such as `requesterAgent:'mallory'`, `selectedAgent:'mallory'`, `selectedBrain:'brain-mallory'`, and `route:'/forged'`. Assert the terminal record and protected result response retain the watermarks while replacing every identity field from the durable requester and canonical catalog target:

    assert.deepEqual(record.sourceEvidence, {
      ...workerWatermarks,
      requesterAgent: 'jerry',
      operationId: record.operationId,
      operationType: 'query',
      targetDomain: 'brain',
      selectedAgent: 'forrest',
      selectedBrain: 'brain-forrest',
      route: '/api/brain/brain-forrest',
      targetKind: 'resident',
      targetLifecycle: 'resident',
      catalogRevision: catalog.catalogRevision,
      accessMode: 'read-only',
    });

Add a graph-artifact coordinator fixture whose worker returns the standard trusted descriptor. Spy on the store and assert the call order is `adoptResultArtifact` then terminal `transition`, with the transition's `expectedVersion` equal to the adoption record version. Assert the completed status has `result:null`, `resultArtifact:{mediaType:'application/x-ndjson',contentEncoding:'identity',bytes,sha256}`, and an opaque `brres_` handle but no `scratchPath`. Return an outside path, symlink, wrong hash/byte count, nonidentity encoding, result-plus-artifact, and artifact on a non-graph operation; each must fail without calling terminal-complete and without exposing a handle. Simulate a crash after adoption but before terminal transition, reload, and prove reconciliation terminalizes from the already-adopted durable artifact without adopting a second time.

- [ ] **Step 2: Write failing authority, route, list, and export tests**

POST a body containing requesterAgent: forrest to Jerry's dashboard and assert the stored requester remains jerry or the spoofed field is rejected. Test every status/events/result/cancel/export route requires dashboard-derived requester authorization and returns 404/403 for another requester.

Before any catalog/store test, send valid JSON at exactly 1 MiB and one byte
over to the public operation start/cancel/detach/export bodies, plus malformed
JSON and a highly compressible oversized string. The exact bound may pass only
when its operation-specific schema also passes; one byte over returns typed 413
`request_too_large` with zero catalog/store/pin/capability/worker calls. Add the
same exact/over test at 2 MiB for the protected internal worker start body and
256 KiB for its cancel/control bodies. Capability verification still runs for
an in-budget internal request, but no parser retains an over-budget body.

Define and exhaustively table-test this shared server-side policy. The test must assert its operation-type set exactly equals the matrix keys so adding a type without a row fails:

    const OPERATION_AUTHORITY = Object.freeze({
      search:                { domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'], lifecycles: ['resident', 'completed'], writes: 'none' },
      graph:                 { domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'], lifecycles: ['resident', 'completed'], writes: 'none' },
      status:                { domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'], lifecycles: ['resident', 'completed'], writes: 'none' },
      query:                 { domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'], lifecycles: ['resident', 'completed'], writes: 'requester-scratch' },
      pgs:                   { domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'], lifecycles: ['resident', 'completed'], writes: 'requester-scratch' },
      graph_export:          { domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'], lifecycles: ['resident', 'completed'], writes: 'requester-result' },
      synthesis:             { domain: 'brain', requiresSourcePin: true, modes: ['own'], lifecycles: ['resident'], writes: 'own-brain-cas' },
      research_compile:      { domain: 'brain', requiresSourcePin: true, modes: ['own', 'read-only'], lifecycles: ['resident', 'completed'], writes: 'requester-workspace' },
      research_launch:       { domain: 'requester', requiresSourcePin: false, modes: ['own'], lifecycles: [], writes: 'requester-run' },
      research_continue:     { domain: 'owned-run', requiresSourcePin: false, modes: ['own'], runStates: ['paused', 'failed', 'completed'], writes: 'requester-run' },
      research_stop:         { domain: 'owned-run', requiresSourcePin: false, modes: ['own'], runStates: ['starting', 'active', 'stopping'], writes: 'requester-run' },
      research_watch:        { domain: 'owned-run', requiresSourcePin: false, modes: ['own'], runStates: ['starting', 'active', 'paused', 'failed', 'completed', 'stopped'], writes: 'none' },
      research_intelligence: { domain: 'brain', requiresSourcePin: true, modes: ['read-only'], lifecycles: ['completed'], writes: 'none' },
      ad_hoc_export:         { domain: 'requester', requiresSourcePin: false, modes: ['own'], lifecycles: [], writes: 'requester-workspace-noncanonical', canonicalEvidence: false },
    });

For every `domain:'brain'` row, test own resident and sibling resident/completed according to the declared mode, then deny active, unavailable, malformed/mismatched targets and every undeclared mode/lifecycle. Access mode is `own` only for the requester's resident brain; every completed research brain is immutable `read-only` even when its canonical owner metadata names that requester. Therefore `research_intelligence` is accepted only with a selected completed research brain and `read-only` mode, never a resident or active run. For every `domain:'owned-run'` row, require a selector exactly shaped `{runId:<nonempty canonical id>}` (no omission, wildcard, brainId alias, or extra field), resolve canonical run metadata from it, allow only declared states whose `ownerAgent === requesterAgent`, and deny a different owner, absent/ambiguous owner metadata, and every undeclared run state. In particular `research_watch` and `research_stop` cannot become global all-run operations when the selector is missing. For every `domain:'requester'` row, deny a caller-supplied owner or cross-requester path. Separately deny an unknown operation type, cross-brain synthesis, target-tree writes from every read-only row, and caller-supplied policy fields. Assert `authorizeBrainOperation()` returns a frozen server policy rather than request data and that every row declares boolean `requiresSourcePin`.

Add a trusted operation-model resolver fixture with a catalog containing two providers that share a model label. Query accepts either no selection or exactly `modelSelection:{provider,model}`. PGS accepts either no selection or exact nested `pgsSweep:{provider,model}` and/or `pgsSynth:{provider,model}` pairs. Omitted pairs resolve from the server's configured query slots; explicit pairs are validated as selectable, available, and capability-complete. Reject model-only/provider-only objects, flat `provider`/`model`, legacy `pgsSweepModel`/`pgsSynthModel`/provider fields, extra pair keys, ambiguous defaults, mismatched pairs, unavailable clients, and invalid capabilities before capability/provider work. Assert trusted executor `parameters` always contain the resolved pair(s), while `requestParameters` contains a pair only when the caller explicitly supplied it. A small-graph PGS fallback still receives `pgsSynth`, not the direct-query pair.

Add a trusted synthesis-start test using the same duplicate-label catalog. `POST /api/synthesis/run` accepts only bounded trigger/reason fields, rejects caller `provider`, `providerId`, `model`, `modelId`, pair objects, or capability/policy fields, and asks the injected synthesis-config resolver for the exact server pair. Assert the coordinator persists that `{provider,model}` only in trusted executor `parameters` before pin attachment and capability issuance; normalized caller `requestParameters` remains only trigger/reason. The executor receives the same pair, and an unavailable/ambiguous pair fails before a capability or provider call. Scheduled synthesis uses the same resolver. These tests must fail if model-name inference can silently switch providers.

Add a `research_compile` dispatch test. Preserve `operationType:'research_compile'` through normalization, authority, idempotency, capability, and the worker-adapter lookup. Register distinct throwing public-query and private-compile spies; the authorized compile must invoke only the exact `research_compile` executor with its pinned source and requester workspace boundary. If that executor is absent, return typed `executor_unavailable` rather than falling back to `query`, rewriting the capability operation type, or calling a public query route. Reject caller output/provider paths and prove no target boundary changes.

Routes:

    GET  /home23/api/brain-operations/catalog
    GET  /home23/api/brain-operations?state=nonterminal
    POST /home23/api/brain-operations
    GET  /home23/api/brain-operations/:operationId
    GET  /home23/api/brain-operations/:operationId/events?after=<sequence>&attachmentId=<id>
    GET  /home23/api/brain-operations/:operationId/result
    POST /home23/api/brain-operations/:operationId/cancel
    POST /home23/api/brain-operations/:operationId/detach
    POST /home23/api/brain-operations/:operationId/export

The collection GET accepts only `state=nonterminal`. It derives requester identity from the dashboard, rejects a `requesterAgent` query field, returns only queued/running records whose durable `requesterAgent` matches that identity, and never returns another requester's record even if a corrupt/injected test store exposes it. Test Jerry's response excludes a Forrest queued record and all terminal states. Unknown state/filter values are `invalid_request`.

Add a read-only operator preflight using the exact CLI:

    node cli/home23.js brain-operations list --state nonterminal --all-requesters

The CLI enumerates canonical non-symlink `instances/<agent>/runtime/brain-operations` roots, opens each through the same `BrainOperationStoreReader` used by the route, binds expected requester to the canonical instance directory, and returns sorted nonterminal records across requesters. It fails closed on a record/requester mismatch, invalid instance name, symlinked runtime root, unknown state, or omission of `--all-requesters`; it never creates a directory, lock, status, or receipt. This command exists for pre-restart safety when an old dashboard does not yet expose the collection route. Route authorization remains requester-scoped after restart; the operator-only CLI does not create a cross-requester HTTP API.

Canonical export tests call `POST /:operationId/export` with `{format:'markdown'}` or `{format:'json'}` for an ordinary stored JSON result and prove the exporter authorizes the durable source operation, then reloads its protected canonical stored result bytes. For a `graph_export`, start accepts only `parameters:{format:'jsonl'}` and the later export accepts only `{format:'jsonl'}`; it streams the stored uncompressed `application/x-ndjson`/`identity` artifact byte-for-byte to a `.jsonl` workspace file. Reject graph `json`, `markdown`, `gzip`, `jsonl.gz`, or omitted formats rather than relabeling bytes. Reject `answer`, `content`, raw bytes, arbitrary source/destination paths, traversal/symlink filenames, unsupported formats, an expired/mismatched result handle, another requester, and a nonterminal operation. Assert target `mutationBoundaries` remain byte-identical and the only durable write is beneath `instances/jerry/workspace/brain-exports/`, plus a requester-runtime export receipt.

Also test the compatibility-only `ad_hoc_export` operation. It accepts a bounded legacy `{query,answer,format,metadata}` payload only after requester authority, rejects every target selector/path and cross-requester field, writes only requester workspace, and returns/persists `canonicalEvidence:false`. It must never be accepted by the canonical `POST /:operationId/export` path as though caller answer bytes were source evidence. A `graph_export` start must be a durable operation whose executor streams uncompressed JSONL into requester-owned operation scratch, returns the trusted artifact descriptor, and ultimately exposes only opaque result-handle plus artifact metadata; `graph?full=1`, dashboard/harness full-graph materialization, gzip, and target-owned exports are invalid.

- [ ] **Step 3: Run coordinator/route tests and verify RED**

    node --test --test-concurrency=1 tests/engine/dashboard/brain-operation-authority.test.js tests/engine/dashboard/brain-operation-coordinator.test.js tests/engine/dashboard/brain-operation-exporter.test.js tests/engine/dashboard/brain-operation-routes.test.js tests/cli/brain-operations-list.test.js

Expected: FAIL because the authority, coordinator/router, authenticated reader, exporter, and list command do not exist.

- [ ] **Step 4: Implement coordinator lifecycle**

Implement this exact public interface:

    interface BrainOperationCoordinator {
      resolveTargetContext(selector?): Promise<{
        catalogRevision: string, target: BrainTarget, accessMode: 'own' | 'read-only'
      }>;
      start(input: { requestId, operationType, target?, parameters }): Promise<BrainOperationRecord>;
      status(operationId): Promise<BrainOperationRecord>;
      listNonterminal(): Promise<BrainOperationRecord[]>;
      attach(operationId, input: { attachmentId, signal, onEvent }): Promise<Attachment>;
      detach(operationId, input: { attachmentId, reason }): Promise<Attachment>;
      cancel(operationId): Promise<BrainOperationRecord>;
      exportResult(operationId, input: { resultHandle, format, fileName }): Promise<object>;
      reconcile(): Promise<void>;
      stop(): Promise<void>;
    }

The injected worker is one composite adapter:

    interface BrainOperationWorkerAdapter {
      registerLocalExecutor(operationType, executor): void;
      start(context, capability): Promise<WorkerRecord>;
      status(operationId, capability): Promise<WorkerRecord>;
      events(operationId, { afterSequence, signal }, capability): AsyncIterable<WorkerEvent>;
      result(operationId, capability): Promise<WorkerResult>;
      cancel(operationId, capability): Promise<WorkerRecord>;
    }

The persisted worker reference is exact
`{version:1,workerId,workerType:'local'|'cosmo',operationType}`. A returned
`WorkerRecord` contains that `reference` plus exact `operationId`, execution
`state`, `phase`, monotonic `eventSequence`, and a bounded unique
`activeProviderCalls:Array<{providerCallId,providerStallMs,idleMs}>`. Startup
reconciliation proves liveness through authenticated `status()` and resumes
through `events()`; there is no separate `proveActive` or unbound reattach API.
Every adapter method obtains a fresh one-use capability from the coordinator.
The signal-bearing events input is the deterministic shutdown/reconnect seam
for a blocked worker stream.

Every executor receives the same context and returns the same envelope:

    {
      operationId,
      operationType,
      requesterAgent,
      target: BrainTarget | OwnedRunTarget | RequesterTarget,
      parameters,
      scratchDir,
      scratchQuota: OperationScratchQuota | null,
      signal,
      sourcePin: PinnedMemorySource | null,
      reportEvent
    }

    { state: 'complete' | 'partial' | 'failed' | 'cancelled',
      result: object | null,
      resultArtifact?: {
        scratchPath: string,
        mediaType: 'application/x-ndjson',
        contentEncoding: 'identity',
        bytes: number,
        sha256: string
      } | null,
      error: object | null,
      sourceEvidence: object | null }

`registerLocalExecutor` is the only dashboard-local executor seam; the provider plan registers synthesis there. Query and PGS use the protected COSMO routes. Construct `sourcePins` only through the source plan's `createMemorySourcePinProvider({home23Root,requesterAgent})`. It supplies idempotent `pin(canonicalRoot, operationId) -> {descriptor,digest}`, `openPinnedSource(descriptor, expectations)`, and idempotent `releaseOperationPins(operationId)`. Repeating `pin` for one operation returns the same canonical descriptor/digest or a typed conflict; this is the crash-recovery seam. The provider derives the requester operation root and external `<home23Root>/runtime/brain-source-locks` from trusted construction/context, uses the source plan's `withMemorySourceLock()` internally, and never accepts a lock/projection/pin path from operation input. After Source Task 2 is injected, every process touching scratch creates a source-plan `OperationScratchQuota` handle for the exact durable operation root; all handles coordinate through that root's one durable quota ledger, so projection, overlay, protected COSMO PGS, local export, and result adoption share one logical aggregate rather than independent ceilings. Until Source Tasks 1-3 land, source-requiring operation types remain disabled and a local worker-context handle may be null. Once enabled, every `requiresSourcePin:true` worker requires a nonnull reconciled handle before pin/open/start. For rows with `requiresSourcePin:false`, `OperationWorkerContext.sourcePin` is exactly null and no implementation may substitute the current live source.

The coordinator receives one injected `resolveOwnedRunTarget({runId})` beside
the canonical brain catalog builder/resolver. It returns the exact owned-run
target union from trusted run metadata or a typed not-found/unavailable/
ambiguity error. No catalog display name, caller path, or global all-run scan
may substitute for this resolver. `authorizeBrainOperation()` consumes the one
canonical discriminated `target` for all domains; it has no second `run`
argument that could disagree with that target.

Local executors receive the in-process `sourcePin` reader object in their
executor context. Remote COSMO transport never serializes that object: it sends
only the durable descriptor/digest and capability-bound canonical identity;
the protected worker opens its own process-local reader in Task 5. Until that
boundary exists, remote source operations are disabled rather than silently
running without a pin.

Because the existing dashboard installs a broad 10-GiB compatibility JSON
parser, create and mount a dedicated placeholder operation router **before**
that parser in `DashboardServer` construction. Its strict JSON middleware caps
public brain-operation bodies at 1 MiB and emits the typed error above; later
initialization attaches the actual routes to the already-mounted placeholder.
The broad parser must see these requests only after the bounded parser has
finished and must not parse them again. Mount compatibility query ingress the
same way in Plan D. COSMO mounts protected worker routers with strict 2-MiB
start/256-KiB control parsers before any broad parser. Tests inspect middleware
order and monkeypatch the broad parser to throw if it sees a brain-operation
request.

Implement `resolveTargetContext(selector = {})` as a read-only coordinator
method. It calls the injected fresh `buildCanonicalCatalog()`, resolves with the
coordinator's immutable process-derived requester through
`resolveCanonicalTarget()`, derives `accessMode:'own'` only for that requester's
resident brain and otherwise `read-only`, and returns a deeply frozen exact
`{catalogRevision,target,accessMode}`. It does not accept a requester argument,
does not cache across calls, and performs no store, idempotency, model, pin,
capability, timer, or worker action. `start()` uses this same internal resolution
path on a fresh request so compatibility routes and durable operations cannot
disagree about target identity.

`start()` first rejects caller-supplied authority/identity fields, canonicalizes `operationType:'query'` plus `parameters.enablePGS:true` to operation type `pgs`, and removes that routing flag from normalized `requestParameters`; all later authorization, idempotency, persistence, capability, and executor selection use `pgs`. It rejects contradictory PGS routing fields on any other type. `requestParameters` is the bounded recursively key-sorted caller intent after route normalization. Executor `parameters` starts as the same object but may receive trusted server-derived fields later.

Target-shape validation is domain-specific and happens before resolution: brain-domain operations accept only `{agent?,brainId?}` (or omission for the requester's resident default); owned-run operations require exactly `{runId}`; requester-domain operations require target omission. After normalization, derive the idempotency key and call `findByIdempotencyKey()` before consulting drift-prone catalog or provider configuration. If a durable record exists, compare `requestParameters` and the supplied selector against that record's stable target identity: omitted brain target matches only the requester's persisted own resident; `agent` and `brainId` must each match their persisted fields; `{runId}` must match the persisted owned run; requester-domain target must remain omitted. A match returns the original record and performs no create, catalog resolution, model resolution, pin, capability, or worker side effect. A difference is `idempotency_conflict`. This pre-check is requester-scoped and cannot retrieve another requester's record.

Only when no idempotency record exists does the coordinator resolve and snapshot a discriminated target union. Brain records add `domain:'brain'` to the full canonical brain fields, including `ownerAgent`, `kind`, `lifecycle`, `catalogRevision`, `route`, and server-derived `mutationBoundaries`; owned-run records add `domain:'owned-run'`, exact run ID/root/owner/state and canonical run metadata; requester records are exactly `{domain:'requester',requesterAgent}`. It calls `authorizeBrainOperation()` with that snapshot before store creation, pinning, capability issuance, or executor selection.

Before persistence or capability issuance, call one injected `operationModelResolver` for provider-backed operations. For `query`, resolve an omitted or exact `requestParameters.modelSelection` into trusted `parameters.modelSelection:{provider,model}`. For `pgs`, independently resolve omitted or exact nested `requestParameters.pgsSweep` and `requestParameters.pgsSynth` into both trusted nested pairs; never infer one pair from the other. The resolver validates the exact catalog row, client availability, `maxOutputTokens`, and `providerStallMs`; model ID alone, flat/legacy spellings, implicit provider fallback, or ambiguous configured defaults fail before store/capability/provider work. Non-provider operation parameters pass through their route-specific sanitizer.

The coordinator also adds trusted
`parameters.operationControl:{hardDeadlineAt}` before `store.create()` and
rejects that key from caller parameters. This timestamp is derived once from
the server clock and operation-type deadline, survives a lost-response retry,
and is the durable queued/running deadline authority after restart. The worker
adapter strips `operationControl` from provider/domain parameters and receives
it only as coordinator control metadata. A queued record without this trusted
field is old/incomplete and reconciliation marks it retryable `interrupted`
before worker work; it never invents or renews a deadline from a heartbeat
timestamp.

For synthesis, callers cannot provide any pair. The resolver loads the configured synthesis pair and forms executor `parameters` as `{...requestParameters,provider,model}`. The idempotency fingerprint always remains based on normalized caller `requestParameters`, so a lost-response retry returns the original operation and trusted pair(s) even if configuration later changes. Until the provider plan registers the real resolver, all provider-backed source operations remain disabled; Plan A tests use only an injected fake and never introduce model inference.

Then call `store.create()` with `requestParameters`, trusted executor `parameters`, and `canonicalEvidence = policy.canonicalEvidence !== false`, `sourcePinDescriptor:null`, and `sourcePinDigest:null`. If its atomic result is `created:false`, another concurrent caller won; return that record immediately and perform no post-create side effect. Only the one `created:true` caller owns initial execution. When `policy.requiresSourcePin === true`, it calls the provider's idempotent `pin(canonicalRoot,operationId)` and repeats the store's full descriptor validation before attachment: numeric `version === 1`; nonempty generation; safe-integer nonnegative base/cutoff revisions; exact node/edge base basename/count/positive-byte triples; exact delta epoch/basename/from/to/count/committed-byte tuple consistent with those revisions; safe-integer nonnegative scalar node/edge/cluster counts; exact target canonicalRoot; no unknown/private projection/lock path; and exact canonical digest. It then calls `store.attachSourcePin(operationId,{expectedVersion,descriptor,digest})`; only that returned durable record may feed capability claims. When `policy.requiresSourcePin === false`, both fields remain null and the source-pin capability claim is null.

Issue every worker capability from the durable record after that atomic attachment. Brain-domain records bind `{targetDomain:'brain',targetBrainId,targetRunId:null,targetRequesterAgent:null,canonicalRoot}`. Owned-run records bind `{targetDomain:'owned-run',targetBrainId:null,targetRunId,targetRequesterAgent:null,canonicalRoot}`. Requester-domain records bind `{targetDomain:'requester',targetBrainId:null,targetRunId:null,targetRequesterAgent:requesterAgent,canonicalRoot:null}`. The worker compares every one of these against freshly resolved canonical metadata; operationId alone never substitutes for target identity. Then start the worker exactly once. Reject caller-supplied `requesterAgent`, `idempotencyKey`, canonicalEvidence, canonical root, access mode, owner, lifecycle, run owner, policy, pin descriptor/digest, provider/model for synthesis, lock/projection/operation paths, and write-scope fields. A fault after `created:true` is handled by the explicit failure path or startup reconciliation; a duplicate request handler never becomes a second execution owner.

Persist worker result/evidence and the terminal transition under the operation lock. Preserve worker-supplied watermark/provenance fields, but overwrite identity fields server-side before exposure:

    function enrichSourceEvidence(record, workerEvidence = {}) {
      const base = {
        ...workerEvidence,
        requesterAgent: record.requesterAgent,
        operationId: record.operationId,
        operationType: record.operationType,
        targetDomain: record.target.domain,
      };
      if (record.target.domain === 'brain') {
        return Object.freeze({
          ...base,
          selectedAgent: record.target.ownerAgent,
          selectedBrain: record.target.brainId,
          route: record.target.route,
          targetKind: record.target.kind,
          targetLifecycle: record.target.lifecycle,
          catalogRevision: record.target.catalogRevision,
          accessMode: record.target.accessMode,
        });
      }
      if (record.target.domain === 'owned-run') {
        return Object.freeze({
          ...base,
          runId: record.target.runId,
          runOwnerAgent: record.target.ownerAgent,
          runState: record.target.runState,
          route: record.target.route,
          catalogRevision: record.target.catalogRevision,
        });
      }
      return Object.freeze({ ...base, selectedAgent: record.requesterAgent });
    }

Never copy requester/target identity from worker output, parameters, or capability payload into public evidence. `GET result` returns this persisted top-level `sourceEvidence`, including on partial results.

Before any terminal transition, validate the worker envelope. It may return either `result` or `resultArtifact`, never both. A trusted `resultArtifact` is accepted only for `graph_export`, with `mediaType:'application/x-ndjson'`, `contentEncoding:'identity'`, safe-integer bytes not exceeding `OPERATION_RESULT_ARTIFACT_MAX_BYTES`, and a lowercase SHA-256. Independently lstat/realpath `scratchPath` under the exact durable operation scratch directory, reject symlinks/directories/cross-operation paths, then call `store.adoptResultArtifact(operationId,{expectedVersion,scratchPath,mediaType,contentEncoding,bytes,sha256})`. The store repeats the boundary/hash/ceiling checks and returns a new version. Persist ordinary results through `setResult(operationId,{expectedVersion,result})`. Only after either result commit succeeds may the coordinator transition the returned new record version to terminal. A concurrent cancel/failure that wins the version race prevents late result mutation; a result commit that wins may be retained as partial evidence even if the immediately following terminal race resolves to cancelled. Worker `scratchPath` is never copied to status, events, result responses, or receipts. An invalid artifact terminalizes failed with `worker_result_invalid` and cannot expose a handle.

A failed start after a pin is durable terminalizes and then releases. Every transition into `complete`, `partial`, `failed`, `cancelled`, or `interrupted` invokes this crash-recoverable release path after durable terminal state is committed; detachment and live-worker reconciliation retain pins:

    async function releasePinOnce(operationId) {
      return store.releaseSourcePinOnce(operationId, clock.now(), async () => {
        await sourcePins.releaseOperationPins(operationId); // idempotent by operationId
      });
    }

`releaseSourcePinOnce()` serializes the callback and marker under the operation lock. Startup reconciliation first repairs terminal records from `listPinsPendingRelease()`, then repairs queued source records through idempotent pin plus `attachSourcePin()`, and finally reconciles nonterminal workers. Repeated/concurrent terminal callbacks or reconciliation therefore leave one durable marker and one normal-path callback invocation, while the provider's idempotency covers the crash window after provider release but before the marker. Heartbeat events carry operationId, monotonic eventSequence, recordVersion, state, phase, updatedAt, lastProviderActivityAt, and lastProgressAt. Transport heartbeat and provider activity use separate clocks. The coordinator maintains one timer per authenticated active `providerCallId`; selected creates that call entry, matching activity alone renews it at the coordinator receipt clock, matching terminal clears it, and heartbeat/progress, child timestamps, or another call's activity never affect it. Worker status supplies bounded authenticated `{providerCallId,providerStallMs,idleMs}` snapshots needed to rebuild those timers after reattachment. Any one call's expiry cancels the whole operation as retryable `provider_stalled` and records the expired call ID.

Implement `OPERATION_AUTHORITY` and `authorizeBrainOperation({requesterAgent, operationType, target})` in the shared CommonJS module. Freeze every row and array. Derive `own` only for the requester's canonical resident brain; completed research targets are always `read-only`. Derive run owner/state from the canonical persisted target resolved through the exact `{runId}` selector. The function returns the matching frozen row or throws a typed deny before a capability exists. The coordinator and COSMO worker import this same module; neither keeps a second allowlist.

`BrainOperationStoreReader` is the only read facade used by HTTP routes and the operator CLI:

    interface BrainOperationStoreReader {
      getAuthorized(operationId): Promise<BrainOperationRecord>;
      listNonterminalAuthorized(): Promise<BrainOperationRecord[]>;
      getResultAuthorized(operationId, resultHandle?): Promise<object>;
      openResultArtifactAuthorized(operationId, resultHandle?): Promise<{ metadata, stream }>;
    }

Construct it with `createBrainOperationStoreReader({operationsRoot, expectedRequester, liveStore?})`. The dashboard passes its live store and process-derived requester; the CLI passes the canonical existing root and requester derived from its instance directory. The expected requester is immutable and is not a method argument. Every read verifies the record requester equals that binding. CLI read mode performs no mkdir, repair, lock, GC, or metadata update. A mismatch is corruption/access denial, never a reason to relabel the record.

Implement canonical export in the dashboard, not in the COSMO worker:

    function authorizeStoredResultExport(record, requesterAgent) {
      const policy = OPERATION_AUTHORITY[record.operationType];
      if (!policy || record.requesterAgent !== requesterAgent) throw authorityError('access_denied');
      if (!TERMINAL_STATES.has(record.state)) throw authorityError('operation_not_terminal');
      if (policy.canonicalEvidence === false || record.canonicalEvidence !== true) {
        throw authorityError('canonical_export_required');
      }
      return policy;
    }

    interface BrainOperationExporter {
      exportResult(input: {
        requesterAgent, operationId, resultHandle, format, fileName
      }): Promise<{
        exportHandle, relativePath, bytes, sha256, sourceOperationId,
        sourceResultHandleHash, format, canonicalEvidence
      }>;
      exportAdHoc(input: {
        requesterAgent, operationId, query, answer, format, metadata
      }): Promise<object>;
    }

The canonical path calls reader `getAuthorized()` and `authorizeStoredResultExport(record, requesterAgent)` before reading any bytes, requires a terminal canonical operation, and reloads the stored result instead of trusting request bytes. Ordinary JSON results use reader `getResultAuthorized()` and deterministic `markdown` or `json` serialization. An `application/x-ndjson`/`identity` graph artifact uses `openResultArtifactAuthorized()` and is streamed byte-for-byte to a `.jsonl` export only when format is `jsonl`; `json`, markdown, gzip, and any encoding mismatch are rejected rather than materializing or relabeling the graph. A supplied result handle is checked against the record but is metadata, never authorization. The exporter accepts a sanitized basename (or server-generated name) and no caller-provided content/source/destination path. It writes by temp file, fsync, atomic rename, and directory fsync beneath `instances/<requester>/workspace/brain-exports/`, returning `brexp_` plus 24 random base64url bytes and a requester-runtime receipt containing SHA-256, byte count, relative path, source operation, SHA-256 of any source result handle, format, and `canonicalEvidence:true`. The export receipt never extends access to the operation; it is provenance only. Explicit workspace exports outlive the seven-day operation-result artifact unless the user deletes them.

`exportAdHoc()` is registered as the local executor for the matrix's requester-only `ad_hoc_export`. It validates bounded text/metadata, rejects any target field, writes the same requester-owned export format, and stamps the operation result and receipt `canonicalEvidence:false`. It does not call the canonical result exporter, fabricate sourceEvidence, or mutate a brain. This preserves legacy query/answer compatibility without confusing caller-supplied text with a canonical stored operation result.

`graph_export` is the only full-graph path. Its executor streams canonical uncompressed JSONL to a temporary `.jsonl` file beneath the requester operation scratch directory and returns the trusted descriptor; the coordinator validates it and the store adopts it with no full in-memory materialization using the same fsync/rename/opaque-handle contract as any large result. The normal protected result route returns metadata only. A later canonical `format:'jsonl'` export copies those stored bytes to requester workspace. The dashboard never asks COSMO to export a stored answer, never writes under a selected target, never compresses or relabels graph bytes, and never treats legacy `full=1` as an export.

On shutdown, stop timers without terminalizing active workers. On startup, reconcile each nonterminal record with worker identity. Never change operation execution state when one attachment detaches.

- [ ] **Step 5: Mount routes and verify GREEN**

Register the router from the dashboard server with requesterAgent derived only from getHome23AgentName()/HOME23_AGENT. GET catalog returns the canonical catalog. Collection GET returns requester-authorized nonterminal records only. GET events requires attachmentId, durably opens that attachment, and resumes after eventSequence. POST detach records only that attachment as detached. GET result authenticates with dashboard-derived requester identity, loads the record's stored handle internally, and returns canonical result, error, resultHandle, resultArtifact metadata, and enriched sourceEvidence; it rejects any caller-supplied handle as an authorization mechanism. It never streams a graph artifact into an agent response—the explicit export route performs the requester-owned streaming copy. POST export delegates only to `BrainOperationExporter`, never to the worker or target. Validate query length, prior-context length, mode, topK, bounded graph limits, PGS fraction, the domain-specific target selector, graph `format:'jsonl'`, operation type, and the authority matrix before store/worker calls. Provider/model inputs are allowed only on operation types whose route schema explicitly permits them; synthesis always rejects them and injects the configured catalog pair server-side before capability issuance.

Extend the existing Task 2 command dispatcher with exact read-only `brain-operations list --state nonterminal --all-requesters` behavior. Output one stable JSON object containing `checkedAt`, sorted `requesters`, sorted nonterminal `operations`, and `count`; expose no capability value, canonical source bytes, or result contents. This preflight reports safety evidence only and never restarts PM2.

Run the Step 3 command.

Expected: PASS with no real sleeps.

- [ ] **Step 6: Commit coordinator paths only**

    git add -- cli/home23.js cli/lib/brain-operations-command.js shared/brain-operations/authority.cjs engine/src/dashboard/brain-operations/coordinator.js engine/src/dashboard/brain-operations/router.js engine/src/dashboard/brain-operations/worker-adapter.js engine/src/dashboard/brain-operations/store-reader.js engine/src/dashboard/brain-operations/exporter.js engine/src/dashboard/server.js tests/cli/brain-operations-list.test.js tests/engine/dashboard/brain-operation-authority.test.js tests/engine/dashboard/brain-operation-coordinator.test.js tests/engine/dashboard/brain-operation-exporter.test.js tests/engine/dashboard/brain-operation-routes.test.js
    git diff --cached --check
    git diff --cached
    git commit --only cli/home23.js cli/lib/brain-operations-command.js shared/brain-operations/authority.cjs engine/src/dashboard/brain-operations/coordinator.js engine/src/dashboard/brain-operations/router.js engine/src/dashboard/brain-operations/worker-adapter.js engine/src/dashboard/brain-operations/store-reader.js engine/src/dashboard/brain-operations/exporter.js engine/src/dashboard/server.js tests/cli/brain-operations-list.test.js tests/engine/dashboard/brain-operation-authority.test.js tests/engine/dashboard/brain-operation-coordinator.test.js tests/engine/dashboard/brain-operation-exporter.test.js tests/engine/dashboard/brain-operation-routes.test.js -m "feat: coordinate durable brain operations"

---

### Task 5: Capability-Protected COSMO Worker Boundary

**Execution dependency:** Pause this plan after Task 4, execute source-truth Tasks 1-3 so the real sourcePins contract exists, then return for Task 5. Before Step 1, require the source reader/pin/writer suites green and explicitly prove: native and legacy resident/research inputs return only numeric-v1 safe-integer descriptors; legacy physical projections stay beneath requester operation runtime and never cross the descriptor; the shared reader/writer lock is only the source plan's external `<home23Root>/runtime/brain-source-locks` seam; and the target has no `.memory-source.lock`. The worker tests may use focused fakes for error tables, but numeric-legacy and lock-path integration fixtures must use the real source-plan provider. Live/runtime registration must use that implementation.

**Files:**
- Create: cosmo23/server/lib/brain-operation-worker.js
- Create: cosmo23/server/lib/brain-operation-routes.js
- Modify: cosmo23/server/index.js
- Create: tests/cosmo23/brain-operation-worker.test.cjs
- Modify: docs/design/COSMO23-VENDORED-PATCHES.md

**Interfaces:**
- Consumes: Verified capability claims, canonical catalog/run metadata, shared authority matrix, requester runtime root, exact-key executor registry, source-plan `createMemorySourcePinProvider()`, numeric-v1 descriptors, and its trusted external-lock `openPinnedSource(descriptor, expectations)` seam.
- Produces: BrainOperationWorker and internal start/status/events/result/cancel routes used only by dashboard coordinators.

- [ ] **Step 1: Write failing worker-boundary tests**

Create an injected executor:

    const executor = async ({ operationId, requesterAgent, target, parameters, signal, scratchDir, sourcePin, reportEvent }) => {
      reportEvent({ type: 'progress', phase: 'test', sourceRevision: sourcePin.revision });
      await deferred.promise;
      if (signal.aborted) throw signal.reason;
      return {
        state: 'complete',
        result: { content: 'ok', operationId, requesterAgent, brainId: target.brainId, parameters },
        error: null,
        sourceEvidence: sourcePin.evidence,
      };
    };

Assert valid capabilities start once, replayed/nonmatching capabilities fail, scratchDir resolves inside:

    instances/jerry/runtime/brain-operations/operations/<operationId>/scratch

and supplied scratchDir, requesterAgent, canonicalRoot, operationId, owner, lifecycle, run owner, policy, or write-scope body overrides are rejected. Assert cancel aborts the executor and events are monotonic. For each internal endpoint—start, status, events, result, and cancel—run a table test with a fresh valid capability, then invalid signature, expired token, replayed nonce, wrong requester, wrong target kind/brain/run/requester/root, wrong operation type, and wrong operation ID. A capability consumed on one endpoint cannot be replayed on another.

Race 32 start requests for one operation using 32 distinct valid one-use capabilities and a byte-equivalent canonical request. Assert the registry creates one worker, opens one process-local source pin, and invokes one executor; every caller observes the same worker identity. Retry after a simulated lost start response while that worker is running and after it is terminal; both are idempotent reads, not new execution. A second start with the same operation ID but different canonical target, access mode, operation type, source-pin digest, or recursively sorted trusted parameters is `worker_operation_conflict` and cannot observe or replace the existing worker.

Emit more than 4,096 small events and more than 8 MiB of noisy progress/token-estimate payloads. Assert the worker coalesces or evicts only bounded resumable noise, retains current state plus terminal/provider/phase evidence, and never exceeds `WORKER_EVENT_MAX_COUNT = 4096` or `WORKER_EVENT_MAX_BYTES = 8 * 1024 * 1024`. An `afterSequence` older than the retained window returns exactly `{type:'event_gap',operationId,oldestSequence,latestSequence,currentStatus}` where `currentStatus` is the complete authenticated current worker record and its sequence is at least `latestSequence`; it does not fabricate continuity or fail/cancel the operation. The coordinator/client must perform a fresh bounded status read before advancing to that authenticated cursor and resuming future events.

Use an injected clock to prove worker-registry retention is bounded. Never evict a nonterminal worker. After the coordinator successfully reads a terminal result, retain it for a 10-minute retry grace and then remove its AbortController, result, and event ring. A terminal result never read is retained for at most 24 hours, after which `status/result` returns typed `worker_not_found`; the dashboard's canonical durable result remains authoritative. Registry GC releases no pin a second time and cannot change a dashboard operation state.

Add a non-source `research_watch` fixture with exact target `{runId:'run-owned-1'}`, an `owned-run` capability bound to that run ID/canonical root, a null `sourcePinDigest`, and canonical owned-run metadata. A token for a different run or a requester-domain target must fail even when operation ID/type match. Assert `sourcePins.openPinnedSource` is never called and executor context receives `sourcePin:null`. Missing/wildcard/brainId run selectors and another requester's run fail before executor invocation. Add a requester-domain launch fixture bound to `targetRequesterAgent` and prove another dashboard identity fails. Add a completed-research `research_intelligence` brain fixture and assert its access mode is `read-only`; resident, active, and unavailable targets fail.

Add real-provider native-manifest, legacy-resident, and legacy-research fixtures. Assert every worker-visible descriptor has number `version === 1`, safe-integer base/cutoff revisions, target canonicalRoot, generated relative basenames, and no physical projection/operation/lock path. Assert process pins and any legacy projection are requester-owned, lock acquisition appears only under the trusted external global lock root, global discovery finds the process pin, and complete target hashes include no created/excluded target-local lock. Reject format-0, string-version, null/unsafe revision, exposed projection path, caller lockRoot, and capability/durable digest mismatch before executor invocation.

Register different spies for `query` and `research_compile`. Start an authorized compile with its exact pinned source and requester workspace boundary; assert only the private compile spy runs and the worker/result/capability retain `operationType:'research_compile'`. A missing compile executor is `executor_unavailable`; it must never fall back to query, change the operation type, or accept a caller provider/output path. The actual private provider-backed compile adapter lands in the agent-integration plan; this foundation task enforces the no-fallback registry boundary it plugs into.

Run every shared authority-matrix allow/deny fixture through worker start after capability verification. Assert an unknown operation, cross-brain synthesis, ineligible brain lifecycle, wrong run owner/state/selector, source-required operation with null digest, source-none operation with a nonnull digest, or write-scope mismatch is rejected before `openPinnedSource()` and before executor invocation. Assert the worker imports the shared matrix object rather than a local operation allowlist.

Add a `graph_export` executor fixture that returns `{state:'complete',result:null,error:null,sourceEvidence,resultArtifact:{scratchPath,mediaType:'application/x-ndjson',contentEncoding:'identity',bytes,sha256}}`. Assert the internal worker result preserves this trusted descriptor for the requester coordinator but rejects result plus artifact together, path outside operation scratch, non-JSONL media, gzip encoding, and graph parameters other than exactly `format:'jsonl'`. Add provider-event fixtures proving every selected/activity/terminal event preserves one validated `providerCallId`, `provider_selected` preserves validated `providerStallMs`, `provider_activity` is distinguishable from transport heartbeat, and invalid/nonfinite stall data or missing/mismatched correlation cannot be emitted as a valid worker event. While two provider calls are deferred, assert worker status returns only their bounded authenticated `{providerCallId,providerStallMs,idleMs}` snapshots, derives idle duration from its local monotonic clock regardless of child timestamps, and removes each exact entry on its terminal event.

For each worker terminal state `complete`, `partial`, `failed`, `cancelled`, and `interrupted`, assert its process-local pin releases exactly once. Race 32 result/cancel observations and terminal callbacks without a second release. A start rejected before a local pin opens releases zero; an executor throw after open releases once. Detachment has no COSMO route and cannot release a running worker pin.

- [ ] **Step 2: Run worker tests and verify RED**

    node --test --test-concurrency=1 tests/cosmo23/brain-operation-worker.test.cjs

Expected: FAIL because the worker and internal routes do not exist.

- [ ] **Step 3: Implement the worker registry and protected routes**

Worker interface:

    interface BrainOperationWorker {
      start(operationId, capability, request): Promise<WorkerRecord>;
      status(operationId, capability): Promise<WorkerRecord>;
      events(operationId, capability, afterSequence): AsyncIterable<WorkerEvent>;
      result(operationId, capability): Promise<WorkerResult>;
      cancel(operationId, capability): Promise<WorkerRecord>;
    }

Routes:

    POST /api/internal/brain-operations/:id/start
    GET  /api/internal/brain-operations/:id/status
    GET  /api/internal/brain-operations/:id/events
    GET  /api/internal/brain-operations/:id/result
    POST /api/internal/brain-operations/:id/cancel

Every method verifies a fresh capability against path ID, requester, access mode, operation type, source-pin descriptor digest, and the complete domain-specific target tuple. Brain operations compare brain ID/root; owned-run operations compare run ID/root plus canonical owner metadata; requester operations compare the bound requester target and require null root. After verification and fresh canonical target/run resolution, `start()` invokes shared `authorizeBrainOperation()` before opening a source or selecting an executor. Under one process-local operation registry lock, fingerprint canonical requester/target/access/type/source-pin digest plus recursively sorted trusted parameters. An equivalent existing worker is returned; a differing fingerprint fails closed; only the registry creator may open the pin or invoke the executor. This makes a lost HTTP response and concurrent fresh-capability retries idempotent without treating the capability nonce as the operation identity. When `requiresSourcePin:true`, require the durable numeric-v1 descriptor plus nonnull digest and reopen only through the source-plan provider's `openPinnedSource()` using capability-derived canonicalRoot, numeric cutoff revision, operationId, trusted requester operation root, trusted external lock root, and worker process identity; reject a missing pin, raw manifest path, format-0/string-version/null-revision legacy descriptor, exposed projection root, or mismatched descriptor before invoking an executor. When `requiresSourcePin:false`, both descriptor and digest must be null, no source API is called, and executor context receives `sourcePin:null`.

Executor lookup is exact by authorized operation type and has no query/default fallback. In particular, `research_compile` can run only through its separately registered private compile executor; the worker cannot relabel it as `query` or call a public query executor. The executor receives the canonical OperationWorkerContext and returns `{state,result,resultArtifact?,error,sourceEvidence}`. `resultArtifact`, when present, has only trusted `{scratchPath,mediaType:'application/x-ndjson',contentEncoding:'identity',bytes,sha256}` fields and is allowed only for a `graph_export` whose parameters are exactly `format:'jsonl'`; worker validation proves the path is under its operation scratch, and the coordinator/store repeat validation before adoption. Worker evidence is untrusted for identity; the coordinator enriches it from durable catalog fields. Provider events retain distinct event types and one required `providerCallId`: validated `provider_selected.providerStallMs` creates that call's coordinator stall entry, only matching `provider_activity` renews it, and matching `provider_call_terminal` removes it. The protected worker exposes only its currently active validated call snapshots to authenticated status/reconciliation.

The worker owns its process-local pin, when one exists, and caches one local `releasePromise` in a `releaseOnce()` guard used by `finally` for `complete`, `partial`, `failed`, `cancelled`, and `interrupted`. A non-source operation has no release promise and never calls the source provider. Repeated/concurrent result/cancel calls observe state only. Caller detachment does not release a running worker pin. The worker retains AbortController and bounded event/result state only; cap its in-memory event ring at both 4,096 events and 8 MiB, coalesce high-frequency progress/token estimates, and surface an explicit resumable `event_gap` rather than growing without bound. Use a fake-clock-tested registry GC: nonterminal workers are protected, observed terminal results have a 10-minute retry grace, and unread terminal results have a 24-hour hard retention ceiling. The dashboard store remains canonical. On COSMO restart or a legitimately expired terminal worker, absent worker truth lets coordinator reconciliation use its own already-durable result or mark an unresolved operation interrupted. Canonical stored-result export remains dashboard-owned; there is no internal worker export endpoint.

- [ ] **Step 4: Verify GREEN, document the patch, and commit**

Run the Step 2 command and the existing brains router tests.

Expected: PASS; no route accepts an operation ID alone.

Complete reserved Patch 47 by adding the capability-protected worker boundary, exact tests, and the fact that canonical stored-result export remains dashboard-local. The history line must describe both Task 1 catalog authority and this worker phase without claiming the later source/provider/tool rollout is complete.

    git add -- cosmo23/server/lib/brain-operation-worker.js cosmo23/server/lib/brain-operation-routes.js cosmo23/server/index.js tests/cosmo23/brain-operation-worker.test.cjs docs/design/COSMO23-VENDORED-PATCHES.md
    git diff --cached --check
    git diff --cached
    git commit --only cosmo23/server/lib/brain-operation-worker.js cosmo23/server/lib/brain-operation-routes.js cosmo23/server/index.js tests/cosmo23/brain-operation-worker.test.cjs docs/design/COSMO23-VENDORED-PATCHES.md -m "feat: add protected cosmo brain workers"

---

## Plan Acceptance

Before beginning the next plan:

    node --test --test-concurrency=1 tests/shared/memory-source-contracts.test.js tests/shared/memory-source-reader.test.js tests/shared/memory-source-adapters.test.js tests/shared/memory-source-pin.test.js tests/shared/memory-source-writer.test.js cosmo23/server/lib/brains-router.test.js tests/cosmo23/brain-catalog-contract.test.cjs tests/cosmo23/brain-operation-worker.test.cjs tests/engine/dashboard/brain-operation-capability.test.js tests/engine/dashboard/brain-operation-store.test.js tests/engine/dashboard/brain-operation-authority.test.js tests/engine/dashboard/brain-operation-coordinator.test.js tests/engine/dashboard/brain-operation-exporter.test.js tests/engine/dashboard/brain-operation-routes.test.js tests/cli/brain-operations-capability.test.js tests/cli/brain-operations-list.test.js tests/engine/cli-onboarding.test.js

On an existing-install fixture, also run:

    node cli/home23.js brain-operations prepare --dry-run
    node cli/home23.js brain-operations prepare
    node cli/home23.js brain-operations prepare
    node cli/home23.js brain-operations list --state nonterminal --all-requesters

Expected: all tests pass with zero warnings; native and legacy sources expose only numeric-v1 pins; source locks stay under the trusted external global lock root with no target-local lock; `research_compile` has an exact private executor boundary and no query fallback; dry-run writes nothing; first prepare reports only exact live-stale dashboard/COSMO names with `restartRequired:true`; second prepare makes no filesystem change and retains that same prerequisite until the guarded `pm2 start ecosystem.config.cjs --only <names> --update-env` rollout occurs; the pure command builder returns only that exact scoped argument vector; a fixture whose live env already matches returns `restartRequired:false`; the list command is read-only and requester-authenticated per store; no runtime-state fixture leaks; cross-brain public tool schemas remain disabled.
