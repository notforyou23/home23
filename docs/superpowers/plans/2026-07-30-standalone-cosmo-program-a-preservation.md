# Standalone COSMO Program A: Preservation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the independent COSMO repository and prove a read-only, content-addressed preservation path for the historical COSMO estate, including aliases, Git identity, atomic catalogs, portable casebook bundles, and a source-unchanged receipt.

**Architecture:** Program A creates only the standalone repository foundation, shared contracts, and heritage tooling. Historical roots are opened read-only, catalog identity is derived from canonical bytes rather than paths or timestamps, symlink and hard-link locations resolve to shared identities, and all generated state is written under the new repository or `~/.cosmo`, never beside donor data.

**Tech Stack:** Node.js 22.12+, TypeScript ESM, npm workspaces, Zod v4, Node `crypto`/`fs`/`child_process`, `node:test` through `tsx`.

## Global Constraints

- The canonical source repository is `/Users/jtr/_JTR23_/cosmo`; Home23 is neither a package dependency nor a runtime host.
- Runtime and private installation state live under `~/.cosmo` and remain untracked.
- Historical roots are read-only inputs. No task may rename, delete, rewrite, normalize, chmod, chown, touch, or mass-copy them.
- Every durable identity is content-addressed or explicitly names a content-addressed parent.
- Preservation catalogs/casebooks may record donor Git commits, but no Program A payload accepts a future/enclosing COSMO `BrainCommitId`; later commit-root codecs attach enclosing commit provenance without creating a hash cycle.
- Full-corpus preservation hashes bytes in place; it never copies the approximately 78 GB Bertha corpus into the repository.
- Missing, inaccessible, corrupt, or ambiguous history remains explicit. The catalog never manufactures ancestry or silently skips a configured root.
- Catalog identity excludes observation time; observation time belongs only to a receipt envelope.
- A symlink, hard link, mirror, or website alias may add a location but may not count as independent evidence.
- Source-byte verification reopens and rehashes every regular file in a `full` scan. Metadata-only or anchor-only development scans cannot satisfy the Program A gate.
- Portable casebook bundles include selected bytes only when rights permit. Otherwise they include a stable content commitment and an explicit unavailable-source oracle.
- The first standalone repository requires Node `>=22.12.0` and Zod `^4`.
- Use TDD, run the smallest focused test first, and commit after every independently reviewable task.
- Do not begin Program B until the Program A stop/go receipt passes.

---

## File Map

Implementation occurs in `/Users/jtr/_JTR23_/cosmo`. Paths below are relative to that repository.

| Path | Responsibility |
| --- | --- |
| `AGENTS.md` | Standalone boundary, read-only heritage rule, test and commit discipline |
| `README.md` | Product boundary and Program A commands |
| `package.json`, `package-lock.json` | Node/npm workspace authority with Node 22.12+ and Zod v4 |
| `tsconfig.base.json`, `tsconfig.build.json`, `eslint.config.js` | Shared TypeScript and lint configuration |
| `.gitignore` | Excludes `~/.cosmo`-style local state, build output, caches, and receipts containing private paths |
| `scripts/check-no-home23-dependency.mjs` | Static standalone-boundary gate |
| `config/heritage-roots.example.json` | Public schema-valid example without machine-specific active state |
| `packages/contracts/src/ids.ts` | Frozen branded identifiers and ID schemas |
| `packages/contracts/tsconfig.json` | Composite package build boundary |
| `packages/contracts/src/trust.ts` | `ObjectRef`, `JournalRange`, and `TrustDescriptor` |
| `packages/contracts/src/heritage.ts` | Heritage root, entry, Git identity, catalog, casebook, and receipt schemas |
| `packages/contracts/src/index.ts` | Public `@cosmo/contracts` exports |
| `packages/foundation/src/canonical-json.ts` | Unicode-safe canonical JSON |
| `packages/foundation/tsconfig.json` | Composite package build boundary |
| `packages/foundation/src/hash.ts` | SHA-256 helpers |
| `packages/foundation/src/atomic-file.ts` | fsync-backed sibling-temp atomic writes |
| `packages/foundation/src/clock.ts` | Injectable wall clock |
| `packages/foundation/src/errors.ts` | Stable typed error codes |
| `packages/foundation/src/path-policy.ts` | Output/source separation and traversal checks |
| `packages/foundation/src/index.ts` | Public `@cosmo/foundation` exports |
| `packages/heritage/src/root-identity.ts` | Configured path, resolved path, device/inode, symlink, and alias identity |
| `packages/heritage/tsconfig.json` | Composite package build boundary |
| `packages/heritage/src/read-only-walker.ts` | Deterministic, non-following, byte-hashing walker |
| `packages/heritage/src/git-identity.ts` | HEAD, tree, roots, branch, remotes, and worktree fingerprint |
| `packages/heritage/src/classify.ts` | Explicit ordered legacy classification rules |
| `packages/heritage/src/catalog-builder.ts` | Canonical catalog payload and Merkle identity |
| `packages/heritage/src/catalog-store.ts` | Staged catalog publication and `current` pointer |
| `packages/heritage/src/unchanged-verifier.ts` | Exact post-scan byte and identity comparison |
| `packages/heritage/src/casebook-builder.ts` | Content-addressed portable fixture bundles |
| `packages/heritage/src/casebook-verifier.ts` | Offline bundle verification |
| `packages/heritage/src/cli.ts` | `scan`, `verify-unchanged`, `build-casebook`, and `verify-casebook` |
| `packages/heritage/src/index.ts` | Public `@cosmo/heritage` exports |
| `packages/*/test/*.test.ts` | Focused package tests |
| `packages/heritage/test/support/fixtures.ts` | Deterministic temporary Git, catalog, and casebook fixtures |
| `fixtures/casebook/required-historical-cases.v1.json` | Closed, versioned registry of every governing historical acceptance case |
| `fixtures/casebook/definitions/*.json` | One locked selector and explicit evidence limit per required historical case |
| `scripts/verify-program-a.mjs` | Fail-closed Program A gate runner and command-derived public receipt writer |
| `docs/architecture/heritage-preservation.md` | Operator semantics and recovery procedure |
| `docs/receipts/program-a-preservation.json` | Redacted, content-addressed Program A gate receipt |

## Interfaces Produced for Later Programs

Program B and later programs consume these exact exports:

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
export type ClaimId = `claim_${string}`;
export type ReviewFindingId = `review_${string}`;
export type RelationshipEventId = `rel_${string}`;
export type JournalCursor = `${number}`;

export interface ObjectRef {
  objectId: ObjectId;
  mediaType: string;
  byteLength: number;
}

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

export function canonicalJson(value: JsonValue): string;
export function canonicalBytes(value: JsonValue): Uint8Array;
// UTF-8 bytes of canonicalJson(value); the byte form consumed by C, G, and H.
export function canonicalJsonBytes(value: unknown): Uint8Array;
export function sha256(bytes: Uint8Array | string): Sha256;
export function hashCanonical(value: JsonValue): Sha256;
export async function atomicWriteFile(
  destination: string,
  bytes: Uint8Array,
  options?: AtomicWriteOptions
): Promise<void>;

export interface RequiredHistoricalCase {
  caseId:
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
  definitionPath: string;
  definitionHash: Sha256;
}

export interface RequiredHistoricalCaseManifest {
  schema: 'cosmo.required-historical-cases.v1';
  cases: RequiredHistoricalCase[];
}
```

Test helpers referenced below are created incrementally in `packages/heritage/test/support/fixtures.ts` and never read a real donor. Task 4 creates the helper module and Tasks 5–7 add only the fixtures required by their own tests:

```ts
export function clockAt(iso: string): Clock;
export async function makeGitFixture(): Promise<string>;
export function fixtureInput(clock: Clock): BuildCatalogInput;
export async function makeStoreWithCurrent(oldId: Sha256): Promise<CatalogStoreFixture>;
export async function buildFullFixtureCatalog(): Promise<FullCatalogFixture>;
export async function makeCasebookFixture(): Promise<EmbeddedCasebookFixture>;
export async function makeCommitmentOnlyFixture(): Promise<CommitmentOnlyCasebookFixture>;
```

Every helper creates a unique `mkdtemp()` root, returns a cleanup function, uses only injected clocks and keys, and exposes the exact source/output paths asserted by its test.

## Task 1: Bootstrap the Independent Repository

**Files:**
- Create: all root configuration files listed in the File Map
- Create: `packages/contracts/package.json`
- Create: `packages/foundation/package.json`
- Create: `packages/heritage/package.json`
- Create: `packages/contracts/src/index.ts`
- Create: `packages/foundation/src/index.ts`
- Create: `packages/heritage/src/index.ts`
- Create: `scripts/run-tests.mjs`
- Create: `scripts/check-docs.mjs`
- Create: `package-lock.json`
- Test: `tests/standalone-boundary.test.ts`

**Interfaces:**
- Consumes: approved governing specification and this plan only
- Produces: a buildable npm workspace at `/Users/jtr/_JTR23_/cosmo`

- [ ] **Step 1: Prove the target is safe to initialize**

Run:

```bash
target=/Users/jtr/_JTR23_/cosmo
if [ -e "$target" ] && [ -n "$(find "$target" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
  echo "Refusing to initialize non-empty target: $target" >&2
  exit 1
fi
mkdir -p "$target"
git -C "$target" init -b main
```

Expected: a new empty Git repository at the canonical standalone path. If the target is non-empty, stop and inspect it rather than merging it into this plan.

- [ ] **Step 2: Write the failing standalone-boundary test**

```ts
// tests/standalone-boundary.test.ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { checkStandaloneBoundary } from '../scripts/check-no-home23-dependency.mjs';

test('rejects Home23 imports and accepts standalone packages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cosmo-boundary-'));
  await writeFile(path.join(root, 'good.ts'), "import { z } from 'zod';\n");
  assert.deepEqual(await checkStandaloneBoundary(root), []);
  await writeFile(path.join(root, 'bad.ts'), "import x from '/Users/jtr/_JTR23_/release/home23/shared/x.js';\n");
  const violations = await checkStandaloneBoundary(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.reason, /Home23/);
  await rm(root, { recursive: true, force: true });
});

test('package engine and Zod floors are frozen', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.engines.node, '>=22.12.0');
  assert.equal(pkg.devDependencies.zod, '^4.0.0');
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run:

```bash
cd /Users/jtr/_JTR23_/cosmo
node --test tests/standalone-boundary.test.ts
```

Expected: FAIL because the workspace and checker do not exist.

- [ ] **Step 4: Create the workspace manifests and boundary checker**

Use this root manifest:

```json
{
  "name": "cosmo",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.12.0" },
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "build": "npm run build --workspaces",
    "typecheck": "npm run build",
    "test": "node scripts/run-tests.mjs",
    "test:a": "node scripts/run-tests.mjs tests/standalone-boundary.test.ts packages/contracts/test packages/foundation/test packages/heritage/test",
    "test:contracts": "node scripts/run-tests.mjs packages/contracts/test tests/contracts",
    "lint": "eslint .",
    "docs:check": "node scripts/check-docs.mjs docs",
    "check:independence": "node scripts/check-no-home23-dependency.mjs",
    "heritage": "node --import tsx packages/heritage/src/cli.ts"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "eslint": "^9.0.0",
    "tsx": "^4.20.0",
    "typescript": "^5.8.0",
    "zod": "^4.0.0"
  }
}
```

Each package uses `"type": "module"`, an `exports` entry for `./src/index.ts` during development, `"build": "tsc -p tsconfig.json"`, and `"test": "node ../../scripts/run-tests.mjs test"`, with the dependency direction `contracts <- foundation <- heritage`. `@cosmo/contracts` declares `"zod": "^4.0.0"` as a runtime dependency; `@cosmo/foundation` declares `"@cosmo/contracts": "*"`; `@cosmo/heritage` declares both lower packages as `"*"` dependencies so npm resolves the local workspaces. No package may install a second Zod major. The checker recursively inspects tracked source/config files, rejects import specifiers or package dependencies containing `home23`, rejects absolute references to `/Users/jtr/_JTR23_/release/home23` outside `fixtures/casebook/definitions`, and reports `{path, reason}` without mutating files.

`tests/standalone-boundary.test.ts` also enumerates every `packages/*/package.json` and `apps/*/package.json`; once a workspace directory exists, the test requires nonempty `build` and `test` scripts. This makes `npm run build --workspaces` fail closed rather than silently skipping a new package.

Each initial package entrypoint contains the valid module marker `export {};`, allowing the composite build to run before Task 2 adds public symbols.

`scripts/run-tests.mjs` has two explicit modes:

1. With one or more path arguments, it recursively resolves only those files/directories, selects direct and nested `*.test.ts`, `*.test.tsx`, `*.test.js`, and `*.test.mjs` files, sorts them, fails when a supplied existing test directory contains zero tests, and invokes the Node runner below. This is the mode used by Node-based package scripts and targeted root commands.
2. With no arguments, it runs only root `tests/` through that Node mode, then discovers every npm workspace from the root manifest and invokes each workspace's own nonempty `test` script in dependency/path order. This routes `apps/workbench` through Vitest/jsdom and Node packages through their local runner, fails on any missing/failed workspace script, and never scans `packages/` or `apps/` into a second incompatible runner.

```js
spawnSync(process.execPath, ['--test', '--import', 'tsx', ...testFiles], {
  stdio: 'inherit',
});
```

The no-argument dispatcher, rather than shell glob expansion or a universal test framework, remains the repository-wide test authority as later workspaces are added. Root tests and workspace tests execute exactly once under their declared runner. `scripts/check-docs.mjs` verifies balanced Markdown fences, valid relative links, unique plan task headings, and UTF-8 readability without modifying documents.

```js
// scripts/check-no-home23-dependency.mjs
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = /\.(?:[cm]?[jt]s|json)$/;
const ALLOWED_HERITAGE = `${path.sep}fixtures${path.sep}casebook${path.sep}definitions${path.sep}`;

export async function checkStandaloneBoundary(root) {
  const violations = [];
  async function visit(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!SOURCE.test(entry.name)) continue;
      const text = await readFile(full, 'utf8');
      const dependencyHit = /(?:from\s+|import\s*\(|require\s*\()\s*['"][^'"]*home23/i.test(text);
      const absoluteHit = text.includes('/Users/jtr/_JTR23_/release/home23');
      if (dependencyHit || (absoluteHit && !full.includes(ALLOWED_HERITAGE))) {
        violations.push({ path: path.relative(root, full), reason: 'Home23 dependency is forbidden' });
      }
    }
  }
  await visit(root);
  return violations.sort((a, b) => a.path.localeCompare(b.path));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = await checkStandaloneBoundary(process.cwd());
  if (violations.length > 0) {
    process.stderr.write(`${JSON.stringify(violations, null, 2)}\n`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 5: Register and commit the source-exporting workspaces before dependent tests**

Run:

```bash
npm install
git diff -- package-lock.json
git add package.json package-lock.json tsconfig.base.json tsconfig.build.json \
  packages/contracts/package.json packages/contracts/tsconfig.json \
  packages/foundation/package.json packages/foundation/tsconfig.json \
  packages/heritage/package.json packages/heritage/tsconfig.json
git commit -m "chore: register standalone cosmo workspaces"
git diff --exit-code -- package.json package-lock.json tsconfig.base.json \
  tsconfig.build.json packages/contracts/package.json \
  packages/contracts/tsconfig.json packages/foundation/package.json \
  packages/foundation/tsconfig.json packages/heritage/package.json \
  packages/heritage/tsconfig.json
git diff --cached --quiet
```

Expected: all three development workspaces export `./src/index.ts`, npm records each workspace in the root lockfile, and the manifest/lockfile registration is committed before any dependent build or test. The deliberately untracked scaffold sources and tests remain available for Step 6.

- [ ] **Step 6: Build and pass the focused test**

Run:

```bash
npm run build
node --import tsx --test tests/standalone-boundary.test.ts
npm run check:independence
```

Expected: build succeeds, 2 tests pass, and the independence checker exits 0.

- [ ] **Step 7: Commit the remaining standalone scaffold**

```bash
git add AGENTS.md README.md eslint.config.js .gitignore \
  scripts/check-no-home23-dependency.mjs scripts/run-tests.mjs \
  scripts/check-docs.mjs tests/standalone-boundary.test.ts \
  packages/contracts/src/index.ts packages/foundation/src/index.ts \
  packages/heritage/src/index.ts
git commit -m "chore: scaffold standalone cosmo repository"
```

## Task 2: Freeze Shared Identity, Trust, and Heritage Contracts

**Files:**
- Create: `packages/contracts/src/ids.ts`
- Create: `packages/contracts/src/trust.ts`
- Create: `packages/contracts/src/heritage.ts`
- Modify: `packages/contracts/src/index.ts`
- Test: `packages/contracts/test/contracts.test.ts`

**Interfaces:**
- Consumes: Zod v4
- Produces: the frozen types in “Interfaces Produced for Later Programs”

- [ ] **Step 1: Write contract tests before schemas**

```ts
// packages/contracts/test/contracts.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HeritageCatalogEnvelopeSchema,
  HeritageEntrySchema,
  BuildCatalogInputSchema,
  CasebookDefinitionSchema,
  CasebookManifestSchema,
  SourceUnchangedReceiptSchema,
  BrainCommitIdSchema,
  RunIdSchema,
  QuestionIdSchema,
  Sha256Schema,
  TrustDescriptorSchema
} from '../src/index.js';

const h = `sha256:${'a'.repeat(64)}`;

test('accepts exact SHA-256 identities only', () => {
  assert.equal(Sha256Schema.parse(h), h);
  assert.throws(() => Sha256Schema.parse('a'.repeat(64)));
  assert.throws(() => Sha256Schema.parse(`sha256:${'A'.repeat(64)}`));
  assert.equal(BrainCommitIdSchema.parse(h), h);
  assert.equal(RunIdSchema.parse('run_01JTEST'), 'run_01JTEST');
  assert.equal(QuestionIdSchema.parse('q_01JTEST'), 'q_01JTEST');
  assert.throws(() => RunIdSchema.parse('01JTEST'));
});

test('trust descriptors cannot imply export through omission', () => {
  assert.throws(() => TrustDescriptorSchema.parse({
    ownerId: 'jtr',
    sensitivity: 'private',
    license: 'private',
    permittedUses: ['research'],
    retention: 'retain',
    encryptionDomain: 'local'
  }));
});

test('heritage entries distinguish locations from content identity', () => {
  const parsed = HeritageEntrySchema.parse({
    entryId: h,
    locationId: h,
    relativePath: 'data/state.json.gz',
    kind: 'file',
    byteLength: 12,
    mode: 0o444,
    modifiedTimeNs: '100',
    device: '1',
    inode: '2',
    contentSha256: h,
    linkTarget: null,
    contentAliasOf: null,
    classification: 'legacy_cognition_unverified',
    integrity: 'verified'
  });
  assert.equal(parsed.contentSha256, h);
});

test('catalog envelope rejects an unhashed payload', () => {
  assert.throws(() => HeritageCatalogEnvelopeSchema.parse({
    schema: 'cosmo.heritage-catalog-envelope.v1',
    catalogId: h,
    observedAt: '2026-07-30T12:00:00.000Z',
    payload: { schema: 'cosmo.heritage-catalog.v1', roots: [], entries: [], gitRepositories: [] }
  }));
});

test('Program G preservation inputs have one strict schema authority', () => {
  const buildInput = {
    roots: [{
      label: 'fixture',
      path: '/fixture/source',
      classification: 'legacy_cognition_unverified',
      trust: {
        ownerId: 'fixture',
        sensitivity: 'private',
        license: 'private-test',
        permittedUses: ['preservation'],
        retention: 'retain',
        exportable: false,
        encryptionDomain: 'fixture',
      },
    }],
    policy: {
      hashPolicy: 'full',
      anchorPatterns: ['**/state.json.gz'],
      classificationRules: [],
    },
    clock: { now: () => new Date('2026-07-30T12:00:00.000Z') },
  };
  assert.equal(BuildCatalogInputSchema.safeParse(buildInput).success, true);
  assert.equal(BuildCatalogInputSchema.safeParse({
    ...buildInput,
    mutateSources: true,
  }).success, false);

  const definition = casebookDefinitionFixture();
  assert.equal(CasebookDefinitionSchema.safeParse(definition).success, true);
  assert.equal(CasebookDefinitionSchema.safeParse({
    ...definition,
    selectors: [],
  }).success, false);
  assert.equal(
    CasebookManifestSchema.safeParse(casebookManifestFixture(definition)).success,
    true,
  );
  assert.equal(
    CasebookManifestSchema.safeParse({
      ...casebookManifestFixture(definition),
      childBrainCommitId: h,
    }).success,
    false,
  );
  assert.equal(
    SourceUnchangedReceiptSchema.safeParse(sourceUnchangedReceiptFixture()).success,
    true,
  );
});
```

The three `*Fixture()` helpers in this contract test are local pure object builders in `packages/contracts/test/contracts.test.ts`; each returns the complete strict shape and accepts only typed declared overrides.

- [ ] **Step 2: Run the test to verify schema exports are missing**

Run:

```bash
npm exec -- node --import tsx --test packages/contracts/test/contracts.test.ts
```

Expected: FAIL because `../src/index.js` does not provide the requested contract exports.

- [ ] **Step 3: Define the frozen identifiers and trust schemas**

```ts
// packages/contracts/src/ids.ts
import { z } from 'zod';

export type Sha256 = `sha256:${string}`;
export type ObjectId = Sha256;
export type BrainCommitId = Sha256;
export type CorpusSnapshotId = Sha256;
export type ArtifactId = Sha256;
export type EventId = `evt_${string}`;
export type RunId = `run_${string}`;
export type ExpeditionId = `exp_${string}`;
export type QuestionId = `q_${string}`;
export type ClaimId = `claim_${string}`;
export type ReviewFindingId = `review_${string}`;
export type RelationshipEventId = `rel_${string}`;
export type JournalCursor = `${number}`;

const brandedSha256 = <T extends Sha256>() => z.string()
  .regex(/^sha256:[0-9a-f]{64}$/)
  .transform(value => value as T);
const prefixedId = <T extends string>(prefix: string) => z.string()
  .regex(new RegExp(`^${prefix}[A-Za-z0-9_-]+$`))
  .transform(value => value as T);

export const Sha256Schema = brandedSha256<Sha256>();
export const ObjectIdSchema = brandedSha256<ObjectId>();
export const BrainCommitIdSchema = brandedSha256<BrainCommitId>();
export const CorpusSnapshotIdSchema = brandedSha256<CorpusSnapshotId>();
export const ArtifactIdSchema = brandedSha256<ArtifactId>();
export const EventIdSchema = prefixedId<EventId>('evt_');
export const RunIdSchema = prefixedId<RunId>('run_');
export const ExpeditionIdSchema = prefixedId<ExpeditionId>('exp_');
export const QuestionIdSchema = prefixedId<QuestionId>('q_');
export const ClaimIdSchema = prefixedId<ClaimId>('claim_');
export const ReviewFindingIdSchema = prefixedId<ReviewFindingId>('review_');
export const RelationshipEventIdSchema =
  prefixedId<RelationshipEventId>('rel_');
export const JournalCursorSchema = z.string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .transform(value => value as JournalCursor);
```

```ts
// packages/contracts/src/trust.ts
import { z } from 'zod';
import { JournalCursorSchema, ObjectIdSchema } from './ids.js';

export const ObjectRefSchema = z.object({
  objectId: ObjectIdSchema,
  mediaType: z.string().min(1),
  byteLength: z.number().int().nonnegative()
}).strict();

export const JournalRangeSchema = z.object({
  fromExclusive: JournalCursorSchema,
  throughInclusive: JournalCursorSchema
}).strict().refine(
  value => BigInt(value.throughInclusive) >= BigInt(value.fromExclusive),
  'throughInclusive must not precede fromExclusive'
);

export const TrustDescriptorSchema = z.object({
  ownerId: z.string().min(1),
  sensitivity: z.enum(['public', 'private', 'restricted']),
  license: z.string().min(1),
  permittedUses: z.array(z.string().min(1)),
  retention: z.enum(['retain', 'expire', 'tombstone']),
  exportable: z.boolean(),
  encryptionDomain: z.string().min(1).nullable()
}).strict();

export type ObjectRef = z.infer<typeof ObjectRefSchema>;
export type JournalRange = z.infer<typeof JournalRangeSchema>;
export type TrustDescriptor = z.infer<typeof TrustDescriptorSchema>;
```

- [ ] **Step 4: Define heritage contracts with explicit uncertainty**

`HeritageEntrySchema` uses the exact fields asserted by the test. Add:

```ts
export const LegacyClassificationSchema = z.enum([
  'evidence_capable',
  'committed_cognition_partial_provenance',
  'legacy_cognition_unverified',
  'process_history',
  'artifact',
  'design_heritage',
  'corrupt_or_ambiguous'
]);

export const HeritageRootSchema = z.object({
  rootId: Sha256Schema,
  label: z.string().min(1),
  configuredPath: z.string().min(1),
  resolvedPath: z.string().nullable(),
  availability: z.enum(['present', 'missing', 'permission_denied']),
  device: z.string().nullable(),
  inode: z.string().nullable(),
  symlinkTarget: z.string().nullable(),
  aliasOfRootId: Sha256Schema.nullable(),
  classification: LegacyClassificationSchema,
  trust: TrustDescriptorSchema
}).strict();

export const GitIdentitySchema = z.object({
  repositoryPath: z.string().min(1),
  headCommit: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
  headTree: z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),
  rootCommits: z.array(z.string().regex(/^[0-9a-f]{40,64}$/)),
  branch: z.string().nullable(),
  remotes: z.array(z.object({ name: z.string(), url: z.string() }).strict()),
  porcelainV2Sha256: Sha256Schema,
  dirty: z.boolean()
}).strict();

export const HeritageCatalogPayloadSchema = z.object({
  schema: z.literal('cosmo.heritage-catalog.v1'),
  hashPolicy: z.enum(['metadata', 'anchors', 'full']),
  roots: z.array(HeritageRootSchema),
  entries: z.array(HeritageEntrySchema),
  gitRepositories: z.array(GitIdentitySchema),
  sourceMerkleRoot: Sha256Schema
}).strict();

export const HeritageCatalogEnvelopeSchema = z.object({
  schema: z.literal('cosmo.heritage-catalog-envelope.v1'),
  catalogId: Sha256Schema,
  observedAt: z.string().datetime(),
  payload: HeritageCatalogPayloadSchema,
  payloadSha256: Sha256Schema
}).strict().refine(value => value.catalogId === value.payloadSha256, {
  message: 'catalogId must equal payloadSha256'
});
```

Freeze the Program G preservation handoff inputs in the same contract module:

```ts
export interface Clock {
  now(): Date;
}

export const HeritageRootConfigSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1),
  classification: LegacyClassificationSchema,
  trust: TrustDescriptorSchema,
}).strict();

export const HeritageClassificationRuleSchema = z.object({
  pattern: z.string().min(1),
  classification: LegacyClassificationSchema,
}).strict();

export const CatalogBuildPolicySchema = z.object({
  hashPolicy: z.enum(['metadata', 'anchors', 'full']),
  anchorPatterns: z.array(z.string().min(1)),
  classificationRules: z.array(HeritageClassificationRuleSchema),
}).strict();

export const ClockSchema = z.custom<Clock>(
  value => typeof value === 'object'
    && value !== null
    && typeof (value as Clock).now === 'function',
  'Clock.now() is required',
);

export const BuildCatalogInputSchema = z.object({
  roots: z.array(HeritageRootConfigSchema).min(1),
  policy: CatalogBuildPolicySchema,
  clock: ClockSchema,
}).strict();

export type BuildCatalogInput = z.infer<typeof BuildCatalogInputSchema>;

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

export const RequiredHistoricalCaseSchema = z.object({
  caseId: RequiredHistoricalCaseIdSchema,
  definitionPath: z.string().min(1),
  definitionHash: Sha256Schema,
}).strict();

export const RequiredHistoricalCaseManifestSchema = z.object({
  schema: z.literal('cosmo.required-historical-cases.v1'),
  cases: z.array(RequiredHistoricalCaseSchema).length(14),
}).strict();

export const CasebookSelectorSchema = z.object({
  rootId: Sha256Schema,
  entryIds: z.array(Sha256Schema).min(1),
  purpose: z.string().min(1),
}).strict();

export const UnavailableSourceOracleSchema = z.object({
  requiredState: z.enum(['available', 'unavailable_allowed']),
  objectSha256: Sha256Schema,
  publicCommitment: Sha256Schema,
  hiddenOracleCommitment: Sha256Schema,
  unavailableReason: z.enum([
    'rights_prevent_redistribution',
    'source_offline',
    'permission_denied',
    'corrupt_or_ambiguous',
  ]).nullable(),
}).strict();

export const CasebookDefinitionSchema = z.object({
  schema: z.literal('cosmo.casebook-definition.v1'),
  caseId: RequiredHistoricalCaseIdSchema,
  fixtureName: z.string().min(1),
  fixtureVersion: z.number().int().positive(),
  evidenceFor: z.array(z.string().min(1)).min(1),
  cannotProve: z.array(z.string().min(1)).min(1),
  selectors: z.array(CasebookSelectorSchema).min(1),
  materialization: z.enum(['embed', 'commitment_only']),
  unavailableSourceOracle: z.array(UnavailableSourceOracleSchema).min(1),
  knownContamination: z.array(z.string().min(1)),
  expectedBehavior: z.object({
    transition: z.string().min(1).nullable(),
    insight: z.string().min(1).nullable(),
    failureCode: z.string().min(1).nullable(),
  }).strict(),
}).strict();

export type CasebookDefinition = z.infer<typeof CasebookDefinitionSchema>;

export const CasebookManifestObjectSchema = z.object({
  entryId: Sha256Schema,
  rootId: Sha256Schema,
  relativePath: z.string().min(1),
  objectSha256: Sha256Schema,
  byteLength: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  materialization: z.enum(['embedded', 'commitment_only']),
  classification: LegacyClassificationSchema,
  knownContamination: z.array(z.string().min(1)),
  publicCommitment: Sha256Schema,
  hiddenOracleCommitment: Sha256Schema,
}).strict();

export const CasebookManifestPayloadSchema = z.object({
  schema: z.literal('cosmo.casebook-manifest-payload.v1'),
  sourceCatalogId: Sha256Schema,
  caseId: RequiredHistoricalCaseIdSchema,
  fixtureName: z.string().min(1),
  fixtureVersion: z.number().int().positive(),
  evidenceFor: z.array(z.string().min(1)).min(1),
  cannotProve: z.array(z.string().min(1)).min(1),
  objects: z.array(CasebookManifestObjectSchema).min(1),
  unavailableSources: z.array(z.object({
    objectSha256: Sha256Schema,
    reason: z.enum([
      'rights_prevent_redistribution',
      'source_offline',
      'permission_denied',
      'corrupt_or_ambiguous',
    ]),
  }).strict()),
}).strict();

export const CasebookManifestSchema = z.object({
  schema: z.literal('cosmo.casebook-manifest.v1'),
  bundleId: Sha256Schema,
  payload: CasebookManifestPayloadSchema,
  payloadSha256: Sha256Schema,
  builtAt: z.string().datetime(),
}).strict().superRefine((manifest, context) => {
  if (manifest.bundleId !== manifest.payloadSha256) {
    context.addIssue({
      code: 'custom',
      message: 'bundleId must equal payloadSha256',
    });
  }
});

export type CasebookManifest = z.infer<typeof CasebookManifestSchema>;

export const SourceChangeSchema = z.object({
  entryId: Sha256Schema,
  relativePath: z.string().min(1),
  expectedContentSha256: Sha256Schema.nullable(),
  actualContentSha256: Sha256Schema.nullable(),
  reason: z.enum([
    'content_hash_mismatch',
    'identity_mismatch',
    'metadata_mismatch',
    'source_missing',
    'permission_denied',
    'read_error',
  ]),
}).strict();

export const SourceUnchangedReceiptSchema = z.object({
  schema: z.literal('cosmo.source-unchanged-receipt.v1'),
  catalogId: Sha256Schema,
  verificationPolicy: z.literal('rehash_all_cataloged_regular_files'),
  verifiedEntryCount: z.number().int().nonnegative(),
  changed: z.array(SourceChangeSchema),
  missing: z.array(SourceChangeSchema),
  errors: z.array(SourceChangeSchema),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  sourceUnchanged: z.boolean(),
}).strict();

export type SourceUnchangedReceipt = z.infer<
  typeof SourceUnchangedReceiptSchema
>;
```

All root labels and selector `(rootId, entryId)` pairs are unique and canonically sorted; policy pattern/rule lists reject duplicates and retain declared order only where rule precedence is semantic. `BuildCatalogInputSchema` rejects a clock whose `now()` does not return a valid `Date`; catalog building calls it once and never reads wall time elsewhere. `CasebookDefinitionSchema` requires every selector to resolve to a finite nonempty entry set in the pinned catalog, requires one oracle row per selected content hash, forbids `embed` when the oracle says redistribution is unavailable, and requires exactly one of transition/insight/failureCode to be non-null. Manifest objects are the complete selected set, unique/sorted by `(rootId, entryId)`, and each commitment matches the definition oracle. Because `@cosmo/contracts` cannot import the higher `@cosmo/foundation` package, the schema enforces `bundleId === payloadSha256`; `CasebookBuilder` must independently recompute `payloadSha256 = hashCanonical(payload)` before parsing the wrapper. `SourceUnchangedReceiptSchema` requires `completedAt >= startedAt`, disjoint changed/missing/error entry IDs, `verifiedEntryCount` equal to the full-scan regular-file count attempted, and `sourceUnchanged === true` exactly when all three exception arrays are empty.

Also define and export:

- `HeritageEntry`
- `HeritageRoot`
- `GitIdentity`
- `HeritageCatalogPayload`
- `HeritageCatalogEnvelope`
- `BuildCatalogInput`
- `CasebookDefinition`
- `CasebookManifest`
- `SourceUnchangedReceipt`

- [ ] **Step 5: Run focused contracts and build**

Run:

```bash
npm exec -- node --import tsx --test packages/contracts/test/contracts.test.ts
npm run build
```

Expected: 5 tests pass and TypeScript resolves all public types.

- [ ] **Step 6: Commit shared contracts**

```bash
git add packages/contracts
git commit -m "feat: define cosmo preservation contracts"
```

## Task 3: Implement Canonical Hashing and Atomic File Primitives

**Files:**
- Create: `packages/foundation/src/canonical-json.ts`
- Create: `packages/foundation/src/hash.ts`
- Create: `packages/foundation/src/atomic-file.ts`
- Create: `packages/foundation/src/clock.ts`
- Create: `packages/foundation/src/errors.ts`
- Create: `packages/foundation/src/path-policy.ts`
- Modify: `packages/foundation/src/index.ts`
- Test: `packages/foundation/test/foundation.test.ts`

**Interfaces:**
- Consumes: `Sha256`
- Produces: canonical bytes and atomic persistence used by A–H

- [ ] **Step 1: Write failure-first tests for canonical identity and atomic replacement**

```ts
// packages/foundation/test/foundation.test.ts
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { atomicWriteFile, canonicalJson, hashCanonical } from '../src/index.js';

test('canonical JSON sorts recursively and rejects invalid scalar input', () => {
  assert.equal(canonicalJson({ z: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"z":1}');
  assert.equal(hashCanonical({ b: 2, a: 1 }), hashCanonical({ a: 1, b: 2 }));
  assert.throws(() => canonicalJson({ value: Number.NaN }), /finite/);
  assert.throws(() => canonicalJson({ value: '\ud800' }), /surrogate/);
});

test('atomic writer leaves the old file visible when failure occurs before rename', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cosmo-atomic-'));
  const file = path.join(dir, 'current');
  await writeFile(file, 'old');
  await assert.rejects(() => atomicWriteFile(file, Buffer.from('new'), {
    fault: point => {
      if (point === 'before_rename') throw new Error('injected crash');
    }
  }));
  assert.equal(await readFile(file, 'utf8'), 'old');
  assert.deepEqual(
    (await readdir(dir)).filter(name => name.includes('.tmp-')),
    []
  );
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify the foundation exports are absent**

Run:

```bash
npm exec -- node --import tsx --test packages/foundation/test/foundation.test.ts
```

Expected: FAIL because `../src/index.js` does not provide the requested foundation exports.

- [ ] **Step 3: Implement canonical JSON and SHA-256**

```ts
// packages/foundation/src/canonical-json.ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function assertScalarString(value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError('unpaired high surrogate');
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError('unpaired low surrogate');
    }
  }
}

function normalize(value: JsonValue): JsonValue {
  if (typeof value === 'string') assertScalarString(value);
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('number must be finite');
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      assertScalarString(key);
      const member = value[key];
      if (member === undefined) throw new TypeError('undefined is not canonical JSON');
      output[key] = normalize(member);
    }
    return output;
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(value));
}

export function canonicalBytes(value: JsonValue): Uint8Array {
  return Buffer.from(canonicalJson(value), 'utf8');
}

// Cross-program alias: C, G, and H consume this exact name. Same function,
// no second implementation.
export const canonicalJsonBytes = canonicalBytes;
```

```ts
// packages/foundation/src/hash.ts
import { createHash } from 'node:crypto';
import type { Sha256 } from '@cosmo/contracts';
import { canonicalBytes, type JsonValue } from './canonical-json.js';

export function sha256(input: Uint8Array | string): Sha256 {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

export function hashCanonical(value: JsonValue): Sha256 {
  return sha256(canonicalBytes(value));
}
```

- [ ] **Step 4: Implement fsync-backed atomic writes and path separation**

`atomicWriteFile` must:

1. create a random sibling using `open(path, 'wx', 0o600)`;
2. invoke `fault('after_open')`;
3. write all bytes and `FileHandle.sync()`;
4. invoke `fault('before_rename')`;
5. close and rename the sibling over the destination;
6. fsync the destination directory;
7. remove only its own sibling temp in `finally`.

```ts
export interface AtomicWriteOptions {
  mode?: number;
  fault?: (point: 'after_open' | 'before_rename' | 'after_rename') => void | Promise<void>;
}

export async function assertOutputOutsideSources(
  outputPath: string,
  sourceRoots: string[]
): Promise<void>;
```

`assertOutputOutsideSources` resolves the nearest existing parent of `outputPath` and every source root, then rejects equality or descendant overlap in either direction. It never creates the output directory during checking.

- [ ] **Step 5: Pass foundation tests and inspect temp cleanup**

Run:

```bash
npm exec -- node --import tsx --test packages/foundation/test/foundation.test.ts
npm run build
```

Expected: canonical-order, Unicode-surrogate, non-finite-number, atomic visibility, and temp cleanup tests pass.

- [ ] **Step 6: Commit foundation primitives**

```bash
git add packages/foundation
git commit -m "feat: add canonical and atomic foundation"
```

## Task 4: Walk Historical Roots Without Following or Mutating Them

**Files:**
- Create: `packages/heritage/src/root-identity.ts`
- Create: `packages/heritage/src/read-only-walker.ts`
- Modify: `packages/heritage/src/index.ts`
- Create: `packages/heritage/test/support/fixtures.ts`
- Test: `packages/heritage/test/read-only-walker.test.ts`

**Interfaces:**
- Consumes: `sha256`, heritage contracts, output/source path policy
- Produces:

```ts
export async function resolveRootIdentities(config: HeritageRootConfig[]): Promise<HeritageRoot[]>;
export async function* walkRoot(
  root: HeritageRoot,
  options: WalkOptions
): AsyncIterable<HeritageEntry>;
```

- [ ] **Step 1: Write a symlink and byte-preservation test**

```ts
// packages/heritage/test/read-only-walker.test.ts
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resolveRootIdentities, walkRoot } from '../src/index.js';

const privateTrust = {
  ownerId: 'test-owner',
  sensitivity: 'private' as const,
  license: 'private-test-fixture',
  permittedUses: ['preservation'],
  retention: 'retain' as const,
  exportable: false,
  encryptionDomain: 'test-private'
};

test('records a symlinked root as one location of the same physical root', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'cosmo-heritage-'));
  const physical = path.join(dir, 'physical');
  const alias = path.join(dir, 'alias');
  await (await import('node:fs/promises')).mkdir(physical);
  await writeFile(path.join(physical, 'state.json'), '{"nodes":1}\n', { mode: 0o640 });
  await symlink(physical, alias);
  const before = await lstat(path.join(physical, 'state.json'), { bigint: true });

  const roots = await resolveRootIdentities([
    { label: 'physical', path: physical, classification: 'legacy_cognition_unverified', trust: privateTrust },
    { label: 'website-alias', path: alias, classification: 'legacy_cognition_unverified', trust: privateTrust }
  ]);
  assert.equal(roots.filter(root => root.aliasOfRootId !== null).length, 1);

  const entries = [];
  for await (const entry of walkRoot(roots[0]!, { hashPolicy: 'full', anchorPatterns: [] })) entries.push(entry);
  assert.equal(entries.filter(entry => entry.kind === 'file').length, 1);
  assert.match(entries[0]!.contentSha256!, /^sha256:/);

  const after = await lstat(path.join(physical, 'state.json'), { bigint: true });
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.equal(after.mode, before.mode);
  assert.equal(await readFile(path.join(physical, 'state.json'), 'utf8'), '{"nodes":1}\n');
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the test to verify the walker does not exist**

Run:

```bash
npm exec -- node --import tsx --test packages/heritage/test/read-only-walker.test.ts
```

Expected: FAIL with a missing `../src/index.js` export.

- [ ] **Step 3: Implement root identity and alias grouping**

For every configured path:

1. expand a leading `~/` using `os.homedir()`;
2. `lstat` the configured path;
3. if it is a symlink, record `readlink()` and resolve its target once;
4. `stat` the resolved root and derive physical key `${dev}:${ino}`;
5. choose the lexicographically first present root as the alias-group primary;
6. set every other root's `aliasOfRootId` to that primary;
7. represent `ENOENT` as `missing` and `EACCES`/`EPERM` as `permission_denied`;
8. never call `realpath` recursively on entries during traversal.

`rootId` hashes the canonical tuple `{label, configuredPath, resolvedPath, device, inode}`. It identifies the cataloged location; it does not pretend a path is content identity.

A configured regular-file root, including an OpenClaw backup tarball, produces one file entry through the same read-only hash path. It is never unpacked into its source directory.

- [ ] **Step 4: Implement deterministic read-only traversal**

The walker sorts directory entries by raw UTF-8 name, uses `lstat`, skips `.git` internals after recording the repository boundary, and never follows entry symlinks. Regular files are opened with `O_RDONLY | O_NOFOLLOW`; the open handle's `stat()` device/inode must equal the preceding `lstat()` values before hashing.

```ts
export interface WalkOptions {
  hashPolicy: 'metadata' | 'anchors' | 'full';
  anchorPatterns: RegExp[];
  readChunkBytes?: number;
}

async function hashHandle(handle: FileHandle, chunkBytes: number): Promise<Sha256> {
  const digest = createHash('sha256');
  const buffer = Buffer.allocUnsafe(chunkBytes);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    digest.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return `sha256:${digest.digest('hex')}`;
}
```

`entryId` hashes location identity plus path metadata and content hash. `contentAliasOf` points to the lexicographically first entry with the same file content hash. Device/inode aliasing is recorded separately so hard links do not masquerade as corroboration.

Task 4 also creates `packages/heritage/test/support/fixtures.ts` with `clockAt()` and `makeGitFixture()`. The Git helper initializes only its exact `mkdtemp()` directory, sets repository-local identity, and returns cleanup ownership to the caller. Later tasks extend this same module rather than inventing task-local fixture copies.

- [ ] **Step 5: Add race, external-symlink, permission, and duplicate-content tests**

Tests must prove:

- an entry symlink records its link text and does not traverse the target;
- two byte-identical files have distinct locations and one content identity;
- a file swapped between `lstat` and `open` fails with `HERITAGE_ENTRY_RACED`;
- an unavailable root is represented rather than skipped;
- a regular-file root produces one hashed entry without extraction;
- `metadata` policy leaves `contentSha256` null;
- `full` policy hashes every regular file.

Run:

```bash
npm exec -- node --import tsx --test packages/heritage/test/read-only-walker.test.ts
```

Expected: all walker tests pass with no donor writes.

- [ ] **Step 6: Commit the read-only walker**

```bash
git add packages/heritage/src/root-identity.ts packages/heritage/src/read-only-walker.ts \
  packages/heritage/src/index.ts packages/heritage/test/read-only-walker.test.ts \
  packages/heritage/test/support/fixtures.ts
git commit -m "feat: catalog heritage roots read only"
```

## Task 5: Record Git Identity and Build the Canonical Catalog

**Files:**
- Create: `packages/heritage/src/git-identity.ts`
- Create: `packages/heritage/src/classify.ts`
- Create: `packages/heritage/src/catalog-builder.ts`
- Modify: `packages/heritage/src/index.ts`
- Modify: `packages/heritage/test/support/fixtures.ts`
- Modify: `packages/heritage/package.json`
- Modify: `package-lock.json`
- Test: `packages/heritage/test/catalog-builder.test.ts`

**Interfaces:**
- Consumes: resolved roots and deterministic entries
- Produces:

```ts
export async function readGitIdentity(repositoryPath: string): Promise<GitIdentity>;
export function classifyEntry(relativePath: string, rules: HeritageClassificationRule[]): LegacyClassification;
export async function buildCatalog(input: BuildCatalogInput): Promise<HeritageCatalogEnvelope>;
```

- [ ] **Step 1: Write a test that separates Git commit identity from working-tree state**

```ts
test('records HEAD, tree, roots, remotes, and dirty bytes without changing Git state', async () => {
  const repo = await makeGitFixture();
  const clean = await readGitIdentity(repo);
  assert.match(clean.headCommit!, /^[0-9a-f]{40}$/);
  assert.match(clean.headTree!, /^[0-9a-f]{40}$/);
  assert.equal(clean.rootCommits.length, 1);
  assert.equal(clean.dirty, false);

  await writeFile(path.join(repo, 'untracked.txt'), 'candidate history\n');
  const dirty = await readGitIdentity(repo);
  assert.equal(dirty.headCommit, clean.headCommit);
  assert.equal(dirty.headTree, clean.headTree);
  assert.equal(dirty.dirty, true);
  assert.notEqual(dirty.porcelainV2Sha256, clean.porcelainV2Sha256);
});

test('catalog ID is stable across observation times', async () => {
  const first = await buildCatalog(fixtureInput(clockAt('2026-07-30T10:00:00.000Z')));
  const second = await buildCatalog(fixtureInput(clockAt('2026-07-30T11:00:00.000Z')));
  assert.equal(first.catalogId, second.catalogId);
  assert.notEqual(first.observedAt, second.observedAt);
});
```

`makeGitFixture()` initializes a temporary repository, sets local user name/email, commits one file, and never reads global identity configuration.
Task 5 extends the shared fixture module with `fixtureInput()` and the typed catalog inputs used here.

- [ ] **Step 2: Run the tests to verify catalog code is missing**

Run:

```bash
npm exec -- node --import tsx --test packages/heritage/test/catalog-builder.test.ts
```

Expected: FAIL because `readGitIdentity` and `buildCatalog` are not exported.

- [ ] **Step 3: Implement Git identity with non-mutating commands**

Use `execFile('git', ['-C', repositoryPath, command], { env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })` for:

- `rev-parse HEAD`
- `rev-parse HEAD^{tree}`
- `rev-list --max-parents=0 HEAD`
- `symbolic-ref --quiet --short HEAD`
- `remote -v`
- `status --porcelain=v2 -z --untracked-files=all`

Do not use `git add`, `git update-index`, `git write-tree`, checkout, clean, stash, or commit. `GIT_OPTIONAL_LOCKS=0` prevents a read from refreshing the donor index. Hash the exact NUL-delimited porcelain bytes. An unborn repository uses null HEAD/tree, an empty root list, and its still-hashed status bytes.

- [ ] **Step 4: Implement explicit classification and catalog identity**

Classification is ordered configuration, not model inference:

```ts
export interface HeritageClassificationRule {
  pattern: string;
  classification:
    | 'evidence_capable'
    | 'committed_cognition_partial_provenance'
    | 'legacy_cognition_unverified'
    | 'process_history'
    | 'artifact'
    | 'design_heritage'
    | 'corrupt_or_ambiguous';
}

export function classifyEntry(relativePath: string, rules: HeritageClassificationRule[]) {
  for (const rule of rules) {
    if (minimatch(relativePath, rule.pattern, { dot: true, nocase: false })) {
      return rule.classification;
    }
  }
  return 'corrupt_or_ambiguous' as const;
}
```

Add `minimatch` `10.2.6` as an exact package dependency of `@cosmo/heritage`. Catalog building:

1. resolves all roots and alias groups;
2. traverses each physical primary once;
3. emits location records for every alias;
4. reads each discovered Git repository identity;
5. sorts roots by `rootId`, entries by `entryId`, and Git records by path;
6. computes `sourceMerkleRoot` from sorted entry IDs and Git identity hashes;
7. canonicalizes the payload without `observedAt`;
8. sets both `payloadSha256` and `catalogId` to the payload hash;
9. validates the final envelope through Zod before returning.

- [ ] **Step 5: Commit the exact classification dependency before dependent tests**

Run:

```bash
npm install --workspace @cosmo/heritage --save-exact minimatch@10.2.6
git diff -- packages/heritage/package.json package-lock.json
git add packages/heritage/package.json package-lock.json
git commit -m "chore(heritage): register exact minimatch dependency"
git diff --exit-code -- packages/heritage/package.json package-lock.json
git diff --cached --quiet
```

Expected: `@cosmo/heritage` and the root lockfile pin exactly `minimatch@10.2.6`, whose Node engine supports Node 22; no unrelated dependency changes appear. The catalog source and tests remain unstaged for the next step.

- [ ] **Step 6: Pass catalog tests and verify the founding donor read-only**

Run:

```bash
npm exec -- node --import tsx --test packages/heritage/test/catalog-builder.test.ts
GIT_OPTIONAL_LOCKS=0 git -C '/Volumes/Bertha - Data/_ALL_COZ/new_Coz' status --short --branch
git -C '/Volumes/Bertha - Data/_ALL_COZ/new_Coz' rev-parse HEAD
```

Expected: tests pass; donor status remains unchanged; the current donor HEAD is recorded by the future scan rather than hard-coded as the founding commit.

- [ ] **Step 7: Commit Git and catalog identity**

```bash
git add packages/heritage/src/git-identity.ts packages/heritage/src/classify.ts \
  packages/heritage/src/catalog-builder.ts packages/heritage/src/index.ts \
  packages/heritage/test/catalog-builder.test.ts \
  packages/heritage/test/support/fixtures.ts
git commit -m "feat: preserve git and catalog identity"
```

## Task 6: Publish Catalogs Atomically and Prove Sources Unchanged

**Files:**
- Create: `packages/heritage/src/catalog-store.ts`
- Create: `packages/heritage/src/unchanged-verifier.ts`
- Create: `packages/heritage/src/cli.ts`
- Modify: `packages/heritage/src/index.ts`
- Modify: `packages/heritage/test/support/fixtures.ts`
- Test: `packages/heritage/test/catalog-store.test.ts`
- Test: `packages/heritage/test/unchanged-verifier.test.ts`

**Interfaces:**
- Consumes: `HeritageCatalogEnvelope`
- Produces:

```ts
export async function publishCatalog(
  storeRoot: string,
  catalog: HeritageCatalogEnvelope
): Promise<{ catalogPath: string; currentRefPath: string }>;
export async function verifySourcesUnchanged(
  catalog: HeritageCatalogEnvelope
): Promise<SourceUnchangedReceipt>;
```

- [ ] **Step 1: Write crash and mutation detection tests**

```ts
test('failed publication never advances current', async () => {
  const store = await makeStoreWithCurrent('sha256:' + '1'.repeat(64));
  await assert.rejects(() => publishCatalog(store.root, store.nextCatalog, {
    fault: point => {
      if (point === 'before_current_ref') throw new Error('crash');
    }
  }));
  assert.equal((await readFile(path.join(store.root, 'current'), 'utf8')).trim(), store.oldId);
});

test('full unchanged verification detects a one-byte donor change', async () => {
  const fixture = await buildFullFixtureCatalog();
  await writeFile(fixture.sourceFile, 'changed\n');
  const receipt = await verifySourcesUnchanged(fixture.catalog);
  assert.equal(receipt.sourceUnchanged, false);
  assert.equal(receipt.changed.length, 1);
  assert.equal(receipt.changed[0]!.reason, 'content_hash_mismatch');
});
```

Task 6 extends the shared fixture module with `makeStoreWithCurrent()` and `buildFullFixtureCatalog()`. Both return the exact temporary output/source paths and cleanup function used by these tests.

- [ ] **Step 2: Run the tests to verify publication code is absent**

Run:

```bash
npm exec -- node --import tsx --test packages/heritage/test/catalog-store.test.ts packages/heritage/test/unchanged-verifier.test.ts
```

Expected: FAIL with missing exports.

- [ ] **Step 3: Implement immutable catalog publication**

Store layout:

```text
~/.cosmo/heritage/
  catalogs/
    sha256-<hex>/
      catalog.json
  current
  receipts/
  casebooks/
```

`publishCatalog` validates output/source separation, writes `catalog.json` into a unique staging directory, fsyncs it, atomically renames the complete directory, then atomically writes `current`. If the catalog already exists, it verifies byte identity and reuses it. It never overwrites a non-identical catalog directory.

- [ ] **Step 4: Implement exact full-policy verification**

`verifySourcesUnchanged` rejects a catalog whose `hashPolicy` is not `full`. For each cataloged entry it:

- rechecks kind, device/inode when still meaningful, byte length, mode, and symlink target;
- rehashes every regular file through the read-only handle path;
- recomputes all Git identities;
- reports changed, missing, permission, and race failures separately;
- recomputes `sourceMerkleRoot`;
- sets `sourceUnchanged` true only when all arrays are empty and the Merkle root matches.

The receipt envelope may contain `startedAt` and `completedAt`; its `receiptId` hashes a payload that excludes those observation times.

- [ ] **Step 5: Implement the heritage command surface**

Exact commands:

```text
cosmo-heritage scan --config <file> --store <directory> --hash-policy full
cosmo-heritage verify-unchanged --catalog <catalog.json> --receipt <file>
cosmo-heritage build-casebook --catalog <catalog.json> --definition <definition.json> --store <directory>
cosmo-heritage verify-casebook --bundle <bundle-directory> --offline
```

Every command emits one JSON result to stdout and diagnostics to stderr. Exit codes are:

- `0` verified success;
- `2` schema/config error;
- `3` source missing or inaccessible;
- `4` source changed;
- `5` integrity failure.

The CLI refuses an output path inside any configured source root before opening a source file.

- [ ] **Step 6: Pass focused and package tests**

Run:

```bash
npm exec -- node --import tsx --test packages/heritage/test/catalog-store.test.ts packages/heritage/test/unchanged-verifier.test.ts
npm run test:a
```

Expected: atomic-publication, full-rehash, changed-source, missing-source, and CLI exit-code tests pass.

- [ ] **Step 7: Commit catalog durability**

```bash
git add packages/heritage
git commit -m "feat: publish atomic heritage catalogs"
```

## Task 7: Build Portable, Offline-Verifiable Casebook Bundles

**Files:**
- Modify: `packages/contracts/src/heritage.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/test/contracts.test.ts`
- Create: `packages/heritage/src/casebook-builder.ts`
- Create: `packages/heritage/src/casebook-verifier.ts`
- Modify: `packages/heritage/src/index.ts`
- Modify: `packages/heritage/test/support/fixtures.ts`
- Create: `packages/heritage/test/casebook.test.ts`
- Create: `fixtures/casebook/required-historical-cases.v1.json`
- Create: `fixtures/casebook/definitions/original-deep-code-self-audit.json`
- Create: `fixtures/casebook/definitions/autoscombo2.json`
- Create: `fixtures/casebook/definitions/jerryg.json`
- Create: `fixtures/casebook/definitions/standalone-jerryshows.json`
- Create: `fixtures/casebook/definitions/june-30-controlled-receipt.json`
- Create: `fixtures/casebook/definitions/degraded-home23.json`
- Create: `fixtures/casebook/definitions/old-new-jtr-brains.json`
- Create: `fixtures/casebook/definitions/terrapin-collapse.json`
- Create: `fixtures/casebook/definitions/bigmerge-cross-domain.json`
- Create: `fixtures/casebook/definitions/catastrophic-stem-humanities-aesthetic-merges.json`
- Create: `fixtures/casebook/definitions/menlo-park-zero-metrics.json`
- Create: `fixtures/casebook/definitions/truncated-checkpoint-unicode.json`
- Create: `fixtures/casebook/definitions/clawd-openclaw-continuity.json`
- Create: `fixtures/casebook/definitions/subject-brain-federation-merge.json`

**Interfaces:**
- Consumes: a frozen catalog and casebook definition
- Produces:

```ts
export async function buildCasebook(input: BuildCasebookInput): Promise<CasebookBuildReceipt>;
export async function verifyCasebook(bundlePath: string, options: { offline: boolean }): Promise<CasebookVerification>;
```

- [ ] **Step 1: Write the offline portability test**

Task 7 extends the shared fixture module with `makeCasebookFixture()` and `makeCommitmentOnlyFixture()` before the test below. Each helper owns one temporary catalog/store pair and returns explicit cleanup.

```ts
test('verifies embedded bytes after the original source is gone', async () => {
  const fixture = await makeCasebookFixture();
  const built = await buildCasebook({
    catalog: fixture.catalog,
    definition: fixture.definition,
    bundleStore: fixture.bundleStore
  });
  await rm(fixture.sourceRoot, { recursive: true, force: true });
  const verified = await verifyCasebook(built.bundlePath, { offline: true });
  assert.equal(verified.status, 'valid');
  assert.equal(verified.verifiedEmbeddedObjects, 2);
  assert.equal(verified.sourceAccessAttempts, 0);
});

test('commitment-only material is explicit rather than silently absent', async () => {
  const fixture = await makeCommitmentOnlyFixture();
  const built = await buildCasebook(fixture);
  const verified = await verifyCasebook(built.bundlePath, { offline: true });
  assert.equal(verified.status, 'valid_with_unavailable_sources');
  assert.deepEqual(verified.unavailableSources, [{
    objectSha256: fixture.contentSha256,
    reason: 'rights_prevent_redistribution'
  }]);
});
```

- [ ] **Step 2: Run the tests to verify casebook code is absent**

Run:

```bash
npm exec -- node --import tsx --test packages/heritage/test/casebook.test.ts
```

Expected: FAIL with missing casebook exports.

- [ ] **Step 3: Implement the deterministic bundle format**

Bundle layout:

```text
<bundle-id>.casebook/
  manifest.json
  oracle.json
  objects/
    sha256/
      ab/
        cdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
```

The manifest payload contains:

- schema and bundle ID;
- source catalog ID;
- fixture name and version;
- `evidenceFor` and `cannotProve`;
- each source location and content hash;
- `embedded` or `commitment_only`;
- source classification and known contamination;
- public and hidden-oracle commitments;
- required unavailable-source state;
- exact object byte lengths and media types.

`fixtures/casebook/required-historical-cases.v1.json` is a closed registry, not a discovery glob. It contains exactly the fourteen `caseId` literals in `RequiredHistoricalCase`, one unique definition path per case, and the canonical SHA-256 of each definition. `RequiredHistoricalCaseManifestSchema` rejects missing, duplicate, extra, renamed, or hash-mismatched cases. Program G consumes the manifest object ID and must not substitute a generic fixture for a named historical case.

`bundleId` hashes the canonical manifest payload excluding `builtAt`. Embedded objects are copied through read-only handles into a staging bundle, rehashed before publication, and never copied to the Git repository. The complete bundle directory is atomically renamed into `~/.cosmo/heritage/casebooks`.

- [ ] **Step 4: Define the historical fixtures without claiming more than they prove**

Lock these fourteen definitions, each with its exact `caseId`, finite resolved entry IDs, public and hidden oracle commitments, expected transition/insight/failure, known contamination, `evidenceFor`, and `cannotProve`:

| Case ID | Required historical selectors and purpose |
| --- | --- |
| `original-deep-code-self-audit` | Founding architecture, the original deep-code audit outputs, coordinator state, and Git identity under `/Volumes/Bertha - Data/_ALL_COZ/new_Coz`; proves the early self-propelled audit pattern without claiming exact modern replay. |
| `autoscombo2` | The exact `Autoscombo2` state, questions, outputs, coordinator journals, and nearest valid checkpoints discovered in the catalog; preserves the named autonomous run as its own case. |
| `jerryg` | `/Users/jtr/cosmo-data/JerryG-fork-jtr` Brain, coordinator, governance, plan, question, dream, and source/provenance records; tests a durable subject Brain rather than a document bundle. |
| `standalone-jerryshows` | The standalone `jerryshows` run and its exact state/query/artifact/source records outside Home23; tests the known pre-integration behavior independently of Home23 hosting. |
| `june-30-controlled-receipt` | The exact June 30 controlled run receipt plus pinned input Brain, corpus, journal, prompts, tools, outputs, and evaluation artifacts; tests receipt-to-cognition reconstruction and anti-fabrication. |
| `degraded-home23` | Content-addressed read-only COSMO23 run state, query receipts, failures, and degraded-runtime records from Home23; tests regression behavior without invoking or importing Home23. |
| `old-new-jtr-brains` | `/Volumes/Bertha - Data/_ALL_COZ/cosmoRuns/_JTRNEW1`, `_allTesting/_JTRNEW1`, `_allTesting/priorRuns/backup_jtr_full_overnightcont_1_20251013_110059`, and `backup_jtr_full_overnight1_20251013_094041` state, dream-goal, coordinator, and query records; tests before/after sleep and accumulated-cognition differences. |
| `terrapin-collapse` | Terrapin state, dreams, queries, checkpoints, corpus links, fabricated self-model, and evaluation records; tests corpus/Brain collapse and honest degraded state. |
| `bigmerge-cross-domain` | `~/clawd/COSMObrains/BigMerge_01_23/{state.json.gz,merge-report.json,MERGE_REPORT.md}`, coordinator results/curation, and `/Users/jtr/websites/cosmos.evobrew.com/queries-archive/jsonl/_BigMergeF1-queries.jsonl`; tests cross-domain surprise already present in the merged Brain. |
| `catastrophic-stem-humanities-aesthetic-merges` | All seven `_baseSingles/{STEM_A,STEM_B,STEM_C,HUMAN_D,HUMAN_E,HUMAN_F,AESTHETIC_G}` reports and compressed states plus catastrophic merge outputs; tests lossless parent reachability and explicit failure. |
| `menlo-park-zero-metrics` | The October 30, November 3, and November 4 Menlo Park IP registers, “zero metrics” reports, rich query results, and corresponding state; tests metric/query contradiction without privileging prose. |
| `truncated-checkpoint-unicode` | Every catalog entry ending in `.tmp` over 100 MiB as `commitment_only`, a deterministic 64 KiB prefix/suffix specimen, its nearest preceding verified checkpoint, plus known Unicode path/content failures; tests explicit corruption and portable decoding behavior. |
| `clawd-openclaw-continuity` | `~/clawd/{CONTEXT_LOADING_COMPARISON.md,MEMORY_ARCHITECTURE.md,MEMORY_CONTINUITY_COMPLETE.md,MEMORY_PROTOCOL.md}`, Moltbot synthesis, dated Clawdbot runtime backups, both March 2 OpenClaw tarballs, and the Casey OpenClaw snapshots; tests restart/compaction/session separation. |
| `subject-brain-federation-merge` | At least two exact specialist Brain exports, their refs/commits/corpus roots, a historical federation query, and a historical merge result; tests attributed read-only federation separately from authorized lossless union. |

The Althea Menlo Park/IP snapshot and the Casey Jones Unified/2.3/IDE backups, cursor exports, COSMO engine backups, and other OpenClaw snapshots remain cataloged heritage. They enter one or more named cases only through an exact locked selector and must never be swept into a generic “all COSMO” fixture.

Each definition names a finite selected file list after catalog resolution. Globs may discover candidates, but the generated definition lock stores exact entry IDs before bundle materialization. Large private state files use local `embed`; material that cannot be redistributed uses `commitment_only` with a reason.

- [ ] **Step 5: Pass offline, corruption, and determinism tests**

Add tests proving:

- changing one bundled byte yields `corrupt_object`;
- removing an embedded object yields `missing_object`;
- building twice from the same catalog and definition yields the same bundle ID;
- a source changed after cataloging refuses materialization;
- a path outside the selected catalog cannot enter a bundle;
- offline verification performs zero source filesystem calls.
- the required-case manifest contains exactly all fourteen literals, every definition hash resolves, and deleting or substituting any named case fails verification.

Run:

```bash
npm exec -- node --import tsx --test packages/heritage/test/casebook.test.ts
npm run test:a
```

Expected: casebook tests and the full Program A package suite pass.

- [ ] **Step 6: Commit casebook tooling and definitions**

```bash
git add packages/contracts/src/heritage.ts packages/contracts/src/index.ts \
  packages/contracts/test/contracts.test.ts packages/heritage \
  fixtures/casebook/required-historical-cases.v1.json fixtures/casebook/definitions
git commit -m "feat: create portable cosmo casebooks"
```

## Task 8: Run the Real Preservation Gate and Commit the Redacted Receipt

**Files:**
- Create: `config/heritage-roots.example.json`
- Create: `docs/architecture/heritage-preservation.md`
- Create: `scripts/verify-program-a.mjs`
- Modify: `package.json`
- Generate after testing: `docs/receipts/program-a-preservation.json`
- Local only: `~/.cosmo/config/heritage-roots.json`
- Local only: `~/.cosmo/heritage/**`

**Interfaces:**
- Consumes: all Program A components and mounted historical roots
- Produces: the Program A stop/go receipt consumed by Program B

- [ ] **Step 1: Create the public example and private active root configuration**

The active local configuration must name these roots independently:

```json
{
  "schema": "cosmo.heritage-roots.v1",
  "trustDefaults": {
    "ownerId": "jtr",
    "sensitivity": "private",
    "license": "private-preservation",
    "permittedUses": ["preservation", "research", "acceptance"],
    "retention": "retain",
    "exportable": false,
    "encryptionDomain": "jtr-local"
  },
  "roots": [
    { "label": "bertha-all-coz", "path": "/Volumes/Bertha - Data/_ALL_COZ", "classification": "corrupt_or_ambiguous" },
    { "label": "althea-cosmo", "path": "/Volumes/Althea/Cosmo", "classification": "committed_cognition_partial_provenance" },
    { "label": "casey-cosmo-unified-dev", "path": "/Volumes/Casey Jones/Cosmo_Unified_dev", "classification": "design_heritage" },
    { "label": "casey-cosmo-backup-2026-03-09", "path": "/Volumes/Casey Jones/COSMO_BACKUP_3.9.26", "classification": "process_history" },
    { "label": "casey-unified-backup-2026-03-09", "path": "/Volumes/Casey Jones/cosmo_unified_BACKUP_3.9.26", "classification": "process_history" },
    { "label": "casey-ide-v2-backup", "path": "/Volumes/Casey Jones/cosmo_ide_v2_dev.backup", "classification": "artifact" },
    { "label": "casey-cursor-cosmo-exports", "path": "/Volumes/Casey Jones/cursor-export", "classification": "process_history" },
    { "label": "casey-engine-cosmo-home", "path": "/Volumes/Casey Jones/enginebackups/cosmo-home", "classification": "process_history" },
    { "label": "casey-engine-cosmo-home-2.3", "path": "/Volumes/Casey Jones/enginebackups/cosmo-home_2.3", "classification": "process_history" },
    { "label": "casey-engine-cosmo-2.3", "path": "/Volumes/Casey Jones/enginebackups/cosmo_2.3", "classification": "process_history" },
    { "label": "casey-engine-cosmos-website", "path": "/Volumes/Casey Jones/enginebackups/cosmos.evobrew.com", "classification": "process_history" },
    { "label": "casey-engine-cosmo23-runs", "path": "/Volumes/Casey Jones/enginebackups/home23/cosmo23-runs", "classification": "process_history" },
    { "label": "casey-litdata-cosmo-docs", "path": "/Volumes/Casey Jones/litdata/cosmo_docs", "classification": "design_heritage" },
    { "label": "casey-litdata-archived-cosmo", "path": "/Volumes/Casey Jones/litdata/_archived_cosmo_20251025", "classification": "design_heritage" },
    { "label": "casey-openclaw-status-snapshot", "path": "/Volumes/Casey Jones/pi-backups/status/openclaw-full-2026-02-28_2350.tar.gz", "classification": "process_history" },
    { "label": "casey-openclaw-weekly-snapshot", "path": "/Volumes/Casey Jones/pi-backups/weekly/openclaw-full-2026-03-01_0430.tar.gz", "classification": "process_history" },
    { "label": "cosmos-evobrew-website", "path": "/Users/jtr/websites/cosmos.evobrew.com", "classification": "design_heritage" },
    { "label": "standalone-cosmo-2.3", "path": "/Users/jtr/_JTR23_/cosmo_2.3", "classification": "process_history" },
    { "label": "home23-cosmo23-donor", "path": "/Users/jtr/_JTR23_/release/home23/cosmo23", "classification": "process_history" },
    { "label": "clawd", "path": "/Users/jtr/clawd", "classification": "process_history" },
    { "label": "base-cosmo", "path": "/Users/jtr/_JTR23_/base_cosmo", "classification": "design_heritage" },
    { "label": "cosmo-ide", "path": "/Users/jtr/_JTR23_/cosmo_ide", "classification": "artifact" },
    { "label": "cosmo-ide-v2", "path": "/Users/jtr/_JTR23_/cosmo_ide_v2", "classification": "artifact" },
    { "label": "cosmo-space", "path": "/Users/jtr/_JTR23_/CosmoSpace", "classification": "artifact" },
    { "label": "cosmo-brain-server", "path": "/Users/jtr/_JTR23_/cosmo-brain-server", "classification": "process_history" },
    { "label": "cosmo-data-jerryg", "path": "/Users/jtr/cosmo-data/JerryG-fork-jtr", "classification": "committed_cognition_partial_provenance" },
    { "label": "cosmo-home-workspace", "path": "/Users/jtr/cosmo-home_2.3/workspace", "classification": "process_history" },
    { "label": "cosmo-unified", "path": "/Users/jtr/_JTR_/COSMO_Unified", "classification": "design_heritage" },
    { "label": "cosmo-unified-worktree", "path": "/Users/jtr/.claude-worktrees/Cosmo_Unified_dev", "classification": "design_heritage" },
    { "label": "cozmo-state", "path": "/Users/jtr/.cozmo", "classification": "process_history" },
    { "label": "cosmo23-state", "path": "/Users/jtr/.cosmo2.3", "classification": "process_history" },
    { "label": "brain-server-state", "path": "/Users/jtr/.cosmo-brain-server", "classification": "process_history" },
    { "label": "desktop-cosmo", "path": "/Users/jtr/Desktop/cosmo", "classification": "artifact" },
    { "label": "clawdbot-runtime-backup", "path": "/Users/jtr/clawdbot.backup-20260202-074148", "classification": "process_history" },
    { "label": "openclaw-backup-113908", "path": "/Users/jtr/openclaw-mac-backup-20260302-113908.tgz", "classification": "process_history" },
    { "label": "openclaw-backup-113931", "path": "/Users/jtr/openclaw-mac-backup-20260302-113931.tgz", "classification": "process_history" },
    { "label": "clawdbot-dev", "path": "/Users/jtr/.clawdbot-dev", "classification": "process_history" },
    { "label": "clawdbot-backup-main", "path": "/Users/jtr/.clawdbot.backup-20260202", "classification": "process_history" },
    { "label": "clawdbot-backup-0742", "path": "/Users/jtr/.clawdbot.backup-20260202-0742", "classification": "process_history" },
    { "label": "clawdbot-backup-074100", "path": "/Users/jtr/.clawdbot.backup-20260202-074100", "classification": "process_history" }
  ],
  "hashPolicy": "full",
  "anchorPatterns": [
    "**/COSMO_IP_REGISTER_*.md",
    "**/state.json.gz",
    "**/merge-report.json",
    "**/run-metadata.json",
    "**/thoughts.jsonl",
    "**/dreams.jsonl",
    "**/queries.jsonl"
  ]
}
```

The configuration loader materializes `trustDefaults` onto every root before schema validation; a root-level `trust` may only make the descriptor more restrictive. The public example uses `/path/to/historical-cosmo` and contains no active machine paths. If any designated root is missing, record it in a development catalog but do not issue the Program A passing receipt.

- [ ] **Step 2: Run a full read-only catalog**

Run:

```bash
cd /Users/jtr/_JTR23_/cosmo
npm run build
npm run heritage -- scan \
  --config /Users/jtr/.cosmo/config/heritage-roots.json \
  --store /Users/jtr/.cosmo/heritage \
  --hash-policy full \
  > /Users/jtr/.cosmo/heritage/scan-result.json
```

Expected: exit 0; all designated roots are present; the website `data` symlink is recorded as an alias of `/Volumes/Bertha - Data/_ALL_COZ/cosmoRuns/data`; no source path is created or changed.

- [ ] **Step 3: Build and verify every locked casebook offline**

Run:

```bash
catalog_path="$(jq -r .catalogPath /Users/jtr/.cosmo/heritage/scan-result.json)"
test -f "$catalog_path"

for definition in fixtures/casebook/definitions/*.json; do
  npm run heritage -- build-casebook \
    --catalog "$catalog_path" \
    --definition "$definition" \
    --store /Users/jtr/.cosmo/heritage/casebooks
done

for bundle in /Users/jtr/.cosmo/heritage/casebooks/*.casebook; do
  COSMO_HERITAGE_OFFLINE=1 npm run heritage -- verify-casebook \
    --bundle "$bundle" \
    --offline
done
```

Expected: every bundle reports `valid` or `valid_with_unavailable_sources`, and source access attempts equal zero during offline verification.

- [ ] **Step 4: Rehash all sources and emit the unchanged receipt**

Run:

```bash
npm run heritage -- verify-unchanged \
  --catalog "$(jq -r .catalogPath /Users/jtr/.cosmo/heritage/scan-result.json)" \
  --receipt /Users/jtr/.cosmo/heritage/receipts/program-a-source-unchanged.json
jq '{sourceUnchanged, verifiedEntryCount, changed, missing, errors}' \
  /Users/jtr/.cosmo/heritage/receipts/program-a-source-unchanged.json
```

Expected: `sourceUnchanged: true`; `changed`, `missing`, and `errors` are empty; every full-scan regular file was rehashed.

- [ ] **Step 5: Implement the fail-closed verifier and operator documentation**

Add `"verify:program-a": "node scripts/verify-program-a.mjs"` to the root scripts. The verifier accepts explicit `--catalog`, `--source-receipt`, `--casebook-store`, `--required-cases`, `--expected-commit`, and `--out` arguments. It refuses to start unless:

- `git status --porcelain` is empty;
- `git rev-parse HEAD` equals `--expected-commit`;
- the index tree and `HEAD^{tree}` are identical;
- the catalog uses the `full` hash policy and every configured root is present;
- the private source-unchanged receipt is valid and names that catalog;
- the closed required-case manifest validates exactly fourteen definition hashes;
- one offline-verified bundle exists for every required case ID; and
- the boundary/build/test commands all exit zero.

The script reruns `verify-unchanged` itself after the tests, rather than trusting a hand-authored Boolean. It derives the redacted public receipt exclusively from parsed command outputs and verified private receipts. The generated receipt contains:

- catalog ID and source Merkle root;
- configured/present/alias root counts;
- file, directory, symlink, hard-link, and Git repository counts;
- the required-case manifest ID and each exact case ID, bundle ID, definition hash, and offline verification state;
- unchanged receipt ID and verified entry count;
- explicit statement that the full private catalogs and absolute-path inventory live under `~/.cosmo`;
- zero source changes;
- tool version, exact tested Git commit, and exact tested tree;
- the ordered command/exit-code receipts used to derive the result;
- no source bytes, credentials, private relationship data, or generated historical claims.

The architecture document explains scan policies, alias semantics, casebook availability states, rerun cost, mount-loss behavior, and why a path, folder name, or `LOCKED_IN` directory is not cognitive identity.

- [ ] **Step 6: Commit the complete gate implementation before testing it**

Run:

```bash
git add config/heritage-roots.example.json docs/architecture/heritage-preservation.md scripts/verify-program-a.mjs package.json package-lock.json
git commit -m "test: add Program A preservation gate"
test -z "$(git status --porcelain)"
```

Expected: the verifier, documentation, scripts, and all Program A implementation are committed; the tree is clean; no public receipt exists yet for this commit.

- [ ] **Step 7: Test the exact clean commit and generate its receipt**

Run:

```bash
candidate_commit="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
npm run verify:program-a -- \
  --catalog "$(jq -r .catalogPath /Users/jtr/.cosmo/heritage/scan-result.json)" \
  --source-receipt /Users/jtr/.cosmo/heritage/receipts/program-a-source-unchanged.json \
  --casebook-store /Users/jtr/.cosmo/heritage/casebooks \
  --required-cases fixtures/casebook/required-historical-cases.v1.json \
  --expected-commit "$candidate_commit" \
  --out docs/receipts/program-a-preservation.json
jq -e --arg commit "$candidate_commit" '
  .gate == "pass"
  and .testedGitCommit == $commit
  and .home23DependencyCount == 0
  and .sourceChanges == 0
  and (.requiredHistoricalCases | length) == 14
  and all(.requiredHistoricalCases[]; .offlineVerified == true)
' docs/receipts/program-a-preservation.json
test "$(git rev-parse HEAD)" = "$candidate_commit"
test "$(git status --porcelain)" = "?? docs/receipts/program-a-preservation.json"
git diff --check -- docs/receipts/program-a-preservation.json
```

Expected: every command exits 0; `HEAD` is still the exact candidate and the generated receipt is the only working-tree change. A missing root, unreadable bundle, changed source, unresolved duplicate identity, or Home23 dependency is a stop condition.

- [ ] **Step 8: Commit only the receipt for the already-tested commit**

```bash
test "$(git status --porcelain)" = "?? docs/receipts/program-a-preservation.json"
git add docs/receipts/program-a-preservation.json
test "$(git diff --cached --name-only)" = "docs/receipts/program-a-preservation.json"
git diff --cached --check
test "$(git status --porcelain)" = "A  docs/receipts/program-a-preservation.json"
git commit -m "docs: receipt cosmo heritage preservation"
test -z "$(git status --porcelain)"
```

Expected: before staging and after staging, the exact-status checks prove that no source, fixture, lockfile, unstaged, or extra untracked drift accompanies the receipt. The receipt's `testedGitCommit` is the immediately preceding clean commit; the receipt commit itself is never claimed as the code-under-test commit.

## Program A Completion Check

- [ ] The standalone repository exists at `/Users/jtr/_JTR23_/cosmo` and builds on Node 22.12+.
- [ ] Zod v4 is the only Zod major in the lockfile.
- [ ] Home23 is absent from dependencies and runtime imports.
- [ ] Every designated historical root is represented, including unavailable state where applicable.
- [ ] The website/Bertha symlink is an alias, not duplicate evidence.
- [ ] Git HEAD, tree, root commits, branch, remotes, and working-state fingerprint are retained without mutation.
- [ ] The full catalog and `current` pointer publish atomically.
- [ ] All casebooks verify with source access disabled.
- [ ] A second full byte pass proves source bytes unchanged.
- [ ] The redacted receipt passes and is committed.
- [ ] Program B may begin only after all checks above are true.
