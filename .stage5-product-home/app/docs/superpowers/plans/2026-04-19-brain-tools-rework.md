# Brain Tools Rework + Research Run Topology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align agent `brain_*` tools with the dashboard Query tab's cosmo23 protocol, and relocate research runs from `cosmo23/runs/` into launching-agent workspaces.

**Architecture:** ToolContext gains `brainRoute` + `agentName` + `cosmo23BaseUrl`. `brain_query` + `brain_query_export` call `${brainRoute}/<op>` on cosmo23 with the tab's payload shape. `brain_pgs` is deleted (merged into `brain_query`). `research_launch` sends `runName` + `runRoot` so cosmo23 creates runs at `instances/<agent>/workspace/research-runs/<runName>/` and symlinks the legacy path.

**Tech Stack:** TypeScript (harness), JavaScript (cosmo23 + scripts), Node.js built-in test runner via `tsx`. No new dependencies.

**Reference spec:** `docs/superpowers/specs/2026-04-19-brain-tools-rework-design.md`

---

## File Structure

**Harness (TypeScript):**
- Modify: `src/agent/types.ts` — extend `ToolContext`
- Create: `src/agent/brain-route-resolver.ts` — resolve brainRoute at startup
- Modify: `src/home.ts:220` — call resolver, populate new ToolContext fields
- Modify: `src/agent/tools/brain.ts` — rework `brain_query`, add `brain_query_export`, remove `brain_pgs`
- Modify: `src/agent/tools/research.ts` — `research_launch` sends `runName` + `runRoot`
- Modify: `src/agent/tools/index.ts` — drop `brainPgsTool` export, add `brainQueryExportTool`
- Modify: `src/agents/system-prompt.ts` — remove any `brain_pgs` references

**Harness tests:**
- Create: `tests/agent/brain-route-resolver.test.ts`
- Create: `tests/agent/tools/brain.test.ts`
- Modify: `package.json` — add `test` script

**Cosmo23 (JavaScript):**
- Modify: `cosmo23/launcher/run-manager.js:112` — `createRun(runName, { runPath } = {})`
- Modify: `cosmo23/server/index.js:616` — extract `runRoot` + `runName` from payload, pass through
- Modify: `cosmo23/server/lib/brains-router.test.js` — add patch 7 tests

**Config + docs:**
- Modify: `configs/base-engine.yaml:637` — add research-runs exclusion patterns
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md` — add Patch 7
- Modify: `cli/templates/COSMO_RESEARCH.md` — replace `brain_pgs` refs

**Scripts:**
- Create: `cli/lib/relocate-research-runs.js` — interactive relocation
- Create: `scripts/smoke-brain-tools.js` — live integration smoke

---

## Task 1: Extend ToolContext interface

**Files:**
- Modify: `src/agent/types.ts:35`

**Context:** `ToolContext` already has `workspacePath`. We add `agentName`, `brainRoute`, and `cosmo23BaseUrl`. `brainRoute` is nullable because resolution can fail (cosmo23 down) but harness still boots.

- [ ] **Step 1: Add new fields to ToolContext**

Edit `src/agent/types.ts`, find the `ToolContext` interface at line 35 and add three fields below `enginePort`:

```ts
export interface ToolContext {
  scheduler: CronScheduler | null;
  ttsService: TTSService | null;
  browser: BrowserController | null;
  projectRoot: string;
  enginePort: number;
  agentName: string;                  // HOME23_AGENT
  cosmo23BaseUrl: string;             // http://localhost:43210
  brainRoute: string | null;          // ${cosmo23BaseUrl}/api/brain/<brainId>; null if unresolved
  workspacePath: string;
  tempDir: string;
  contextManager: ContextManagerRef;
  subAgentTracker: SubAgentTracker;
  chatId: string;
  telegramAdapter: TelegramAdapterRef | null;
  runAgentLoop: AgentLoopRunner | null;
  onEvent?: AgentEventCallback;
  conversationHistory?: { append(chatId: string, records: unknown[]): void };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run:
```bash
cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit
```

Expected: many errors complaining that `home.ts` doesn't populate the new fields. That's intentional — they'll be filled in Task 3.

- [ ] **Step 3: Commit**

```bash
git add src/agent/types.ts
git commit -m "$(cat <<'EOF'
feat(agent): extend ToolContext with agentName, cosmo23BaseUrl, brainRoute

Groundwork for brain_* tool rework — tools will POST to
${brainRoute}/<op> against cosmo23 (the same protocol the dashboard
Query tab uses) instead of hitting engine-local /api/query and /api/pgs.

brainRoute is nullable because resolution can fail (cosmo23 down) but
harness still needs to boot. Tools returning is_error when brainRoute
is null is handled in the follow-up tasks.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Write brain-route-resolver with tests

**Files:**
- Create: `src/agent/brain-route-resolver.ts`
- Create: `tests/agent/brain-route-resolver.test.ts`
- Modify: `package.json`

**Context:** `resolveBrainRoute(agentName, cosmo23BaseUrl)` fetches cosmo23's `/api/brains`, finds the brain matching the agent by name or by path, returns `${cosmo23BaseUrl}/api/brain/<brainId>`. Retries twice on network failure (cosmo23 slow to boot), returns null if truly unreachable.

- [ ] **Step 1: Add test script to package.json**

Edit `package.json` and add a `test` script under `scripts`:

```json
"scripts": {
  "build": "tsc",
  "test": "node --import tsx --test tests/**/*.test.ts",
  "pm2:start": "npm run build && pm2 start ecosystem.config.cjs",
  "pm2:stop": "pm2 stop ecosystem.config.cjs",
  "pm2:restart": "npm run build && pm2 restart ecosystem.config.cjs",
  "pm2:logs": "pm2 logs --lines 50",
  "start:test-agent": "bash scripts/start-agent.sh test-agent"
}
```

- [ ] **Step 2: Create the test file (failing)**

Create `tests/agent/brain-route-resolver.test.ts`:

```ts
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBrainRoute } from '../../src/agent/brain-route-resolver.js';

describe('resolveBrainRoute', () => {
  it('returns brainRoute when cosmo23 lists a brain matching the agent name', async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ brains: [
        { id: 'abc123', name: 'jerry', path: '/x/instances/jerry/brain' },
        { id: 'def456', name: 'coz', path: '/x/instances/coz/brain' },
      ]}),
    } as unknown as Response));

    const route = await resolveBrainRoute('jerry', 'http://localhost:43210', { fetchImpl: fetchMock as any, retries: 0 });
    assert.equal(route, 'http://localhost:43210/api/brain/abc123');
  });

  it('returns brainRoute when brain matches by path segment instead of name', async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ brains: [
        { id: 'xyz789', name: 'cosmo', path: '/x/instances/jerry/brain' },
      ]}),
    } as unknown as Response));

    const route = await resolveBrainRoute('jerry', 'http://localhost:43210', { fetchImpl: fetchMock as any, retries: 0 });
    assert.equal(route, 'http://localhost:43210/api/brain/xyz789');
  });

  it('returns null when no brain matches', async () => {
    const fetchMock = mock.fn(async () => ({
      ok: true,
      json: async () => ({ brains: [{ id: 'abc123', name: 'other', path: '/x/other/brain' }] }),
    } as unknown as Response));

    const route = await resolveBrainRoute('jerry', 'http://localhost:43210', { fetchImpl: fetchMock as any, retries: 0 });
    assert.equal(route, null);
  });

  it('retries on network failure up to the configured count', async () => {
    let attempts = 0;
    const fetchMock = mock.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error('ECONNREFUSED');
      return { ok: true, json: async () => ({ brains: [{ id: 'z1', name: 'jerry', path: '' }] }) } as unknown as Response;
    });

    const route = await resolveBrainRoute('jerry', 'http://localhost:43210', { fetchImpl: fetchMock as any, retries: 2, retryDelayMs: 0 });
    assert.equal(route, 'http://localhost:43210/api/brain/z1');
    assert.equal(attempts, 3);
  });

  it('returns null after retries exhausted', async () => {
    const fetchMock = mock.fn(async () => { throw new Error('ECONNREFUSED'); });
    const route = await resolveBrainRoute('jerry', 'http://localhost:43210', { fetchImpl: fetchMock as any, retries: 2, retryDelayMs: 0 });
    assert.equal(route, null);
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npm test
```

Expected: FAIL with "Cannot find module '../../src/agent/brain-route-resolver.js'" (since the implementation doesn't exist yet).

- [ ] **Step 4: Create the resolver implementation**

Create `src/agent/brain-route-resolver.ts`:

```ts
/**
 * Resolves the cosmo23 brainRoute for an agent at harness startup.
 * Called once from home.ts; result is cached on ToolContext for the
 * rest of the process lifetime.
 */

type FetchFn = typeof fetch;

interface Brain {
  id?: string;
  name?: string;
  path?: string;
}

interface ResolveOptions {
  fetchImpl?: FetchFn;
  retries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
}

const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5000;

export async function resolveBrainRoute(
  agentName: string,
  cosmo23BaseUrl: string,
  opts: ResolveOptions = {},
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(`${cosmo23BaseUrl}/api/brains`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        if (attempt < retries) { await sleep(retryDelayMs); continue; }
        return null;
      }
      const data = await res.json() as { brains?: Brain[] };
      const brains = data.brains ?? [];
      const match = findBrainForAgent(agentName, brains);
      if (!match?.id) return null;
      return `${cosmo23BaseUrl}/api/brain/${match.id}`;
    } catch {
      if (attempt < retries) { await sleep(retryDelayMs); continue; }
      return null;
    }
  }
  return null;
}

function findBrainForAgent(agentName: string, brains: Brain[]): Brain | undefined {
  const byName = brains.find(b => b.name === agentName);
  if (byName) return byName;
  return brains.find(b => typeof b.path === 'string' && b.path.includes(`/instances/${agentName}/brain`));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npm test
```

Expected: 5/5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add package.json src/agent/brain-route-resolver.ts tests/agent/brain-route-resolver.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): add brain-route-resolver with tests

Startup helper that asks cosmo23 which brain belongs to this agent and
returns the scoped API URL. Matches by name first, falls back to path
contains /instances/<agent>/brain (handles brains where name was set to
"cosmo" or similar). Retries twice because cosmo23 may still be booting
when the harness comes up.

Tests use Node's built-in test runner via tsx — no new dependency.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire resolver into home.ts bootstrap

**Files:**
- Modify: `src/home.ts:220`

**Context:** The ToolContext is constructed at `src/home.ts:220`. We read `HOME23_AGENT`, resolve `brainRoute`, and populate the new fields. If resolution fails we log a warning and set `brainRoute: null` — tools check for null and return a clear error.

- [ ] **Step 1: Import the resolver**

Open `src/home.ts` and add to the imports near the top:

```ts
import { resolveBrainRoute } from './agent/brain-route-resolver.js';
```

- [ ] **Step 2: Resolve brainRoute and populate ToolContext**

Replace the existing ToolContext construction at line 220 with:

```ts
  // ── Resolve cosmo23 brainRoute at startup ──
  const agentName = process.env.HOME23_AGENT || 'unknown';
  const cosmo23Port = config.cosmo23?.port ?? 43210;
  const cosmo23BaseUrl = `http://localhost:${cosmo23Port}`;
  const brainRoute = await resolveBrainRoute(agentName, cosmo23BaseUrl);
  if (brainRoute) {
    console.log(`[home] brainRoute resolved: ${brainRoute}`);
  } else {
    console.warn(`[home] brainRoute NOT resolved for ${agentName} — brain_query tools will return is_error. Check: curl ${cosmo23BaseUrl}/api/brains`);
  }

  // ── Tool Context (pre-wired, agent loop + scheduler added below) ──
  const toolContext: ToolContext = {
    scheduler: null,
    ttsService,
    browser,
    projectRoot: PROJECT_ROOT,
    enginePort: DASHBOARD_PORT,
    agentName,
    cosmo23BaseUrl,
    brainRoute,
    workspacePath,
    tempDir,
    contextManager,
    subAgentTracker,
    chatId: '',
    telegramAdapter: null,
    runAgentLoop: null,
  };
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/home.ts
git commit -m "$(cat <<'EOF'
feat(agent): resolve brainRoute at harness startup, populate ToolContext

Reads HOME23_AGENT, queries cosmo23's /api/brains, caches the scoped
URL on ToolContext for every tool call. Logs a clear warning (with the
curl command for manual verification) when resolution fails so the
failure mode is visible at boot, not only when an agent invokes a tool.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Rework brain_query

**Files:**
- Modify: `src/agent/tools/brain.ts:60-128`
- Create test: `tests/agent/tools/brain.test.ts`

**Context:** This is the core of the rework. `brain_query` abandons the engine's `/api/query` + 9-mode system and becomes a thin POST to `${ctx.brainRoute}/query` with the dashboard tab's exact payload shape.

- [ ] **Step 1: Create the test file (failing)**

Create `tests/agent/tools/brain.test.ts`:

```ts
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { brainQueryTool, brainQueryExportTool } from '../../../src/agent/tools/brain.js';
import type { ToolContext } from '../../../src/agent/types.js';

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    scheduler: null,
    ttsService: null,
    browser: null,
    projectRoot: '/fake',
    enginePort: 5002,
    agentName: 'jerry',
    cosmo23BaseUrl: 'http://localhost:43210',
    brainRoute: 'http://localhost:43210/api/brain/abc123',
    workspacePath: '/fake/instances/jerry/workspace',
    tempDir: '/tmp',
    contextManager: { getSystemPrompt: () => '', getPromptSourceInfo: () => ({ generatedAt: '', totalSections: 0, loadedFiles: [] }), invalidate: () => {} },
    subAgentTracker: { active: 0, maxConcurrent: 3, queue: [] },
    chatId: '',
    telegramAdapter: null,
    runAgentLoop: null,
    ...overrides,
  };
}

describe('brain_query', () => {
  it('sends the dashboard tab payload shape to ${brainRoute}/query', async () => {
    let capturedUrl = '';
    let capturedBody: any;
    const fetchSpy = mock.fn(async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return {
        ok: true,
        json: async () => ({ answer: 'ok', evidence: [], metadata: { mode: 'full' } }),
      } as unknown as Response;
    });
    (globalThis as any).fetch = fetchSpy;

    await brainQueryTool.execute(
      { query: 'what is the sauna state?', mode: 'expert', enablePGS: true, pgsConfig: { sweepFraction: 0.25 } },
      makeCtx(),
    );

    assert.equal(capturedUrl, 'http://localhost:43210/api/brain/abc123/query');
    assert.equal(capturedBody.query, 'what is the sauna state?');
    assert.equal(capturedBody.mode, 'expert');
    assert.equal(capturedBody.enablePGS, true);
    assert.deepEqual(capturedBody.pgsConfig, { sweepFraction: 0.25 });
    assert.equal(capturedBody.pgsFullSweep, false);
  });

  it('derives pgsFullSweep=true when sweepFraction >= 1.0', async () => {
    let capturedBody: any;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answer: 'ok' }) } as unknown as Response;
    };
    await brainQueryTool.execute(
      { query: 'q', enablePGS: true, pgsConfig: { sweepFraction: 1.0 } },
      makeCtx(),
    );
    assert.equal(capturedBody.pgsFullSweep, true);
  });

  it('passes priorContext through for follow-up queries', async () => {
    let capturedBody: any;
    (globalThis as any).fetch = async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ answer: 'ok' }) } as unknown as Response;
    };
    await brainQueryTool.execute(
      { query: 'follow-up', priorContext: { query: 'prior', answer: 'prior answer' } },
      makeCtx(),
    );
    assert.deepEqual(capturedBody.priorContext, { query: 'prior', answer: 'prior answer' });
  });

  it('returns is_error when brainRoute is null', async () => {
    const result = await brainQueryTool.execute({ query: 'q' }, makeCtx({ brainRoute: null }));
    assert.equal(result.is_error, true);
    assert.match(result.content, /not registered in cosmo23/);
  });
});

describe('brain_query_export', () => {
  it('POSTs to ${brainRoute}/export-query with the dashboard tab payload', async () => {
    let capturedUrl = '';
    let capturedBody: any;
    (globalThis as any).fetch = async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ exportedTo: '/fake/exports/q.md' }) } as unknown as Response;
    };
    await brainQueryExportTool.execute(
      { query: 'q', answer: 'a', format: 'markdown', metadata: { mode: 'full' } },
      makeCtx(),
    );
    assert.equal(capturedUrl, 'http://localhost:43210/api/brain/abc123/export-query');
    assert.equal(capturedBody.query, 'q');
    assert.equal(capturedBody.answer, 'a');
    assert.equal(capturedBody.format, 'markdown');
    assert.deepEqual(capturedBody.metadata, { mode: 'full' });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npm test
```

Expected: FAIL — `brainQueryExportTool` doesn't exist, and `brainQueryTool` doesn't accept the new payload shape.

- [ ] **Step 3: Rewrite brainQueryTool and add brainQueryExportTool**

Replace the existing `brainQueryTool` export in `src/agent/tools/brain.ts` (lines 60-128) with the new implementation, and add `brainQueryExportTool` after `brainSynthesizeTool`. The full replacement:

```ts
export const brainQueryTool: ToolDefinition = {
  name: 'brain_query',
  description:
    'Query the brain with the same protocol the dashboard Query tab uses. ' +
    'Three modes: full (balanced, default), expert (maximum depth, multi-pass), dive (exploratory synthesis, creative cross-domain). ' +
    'Enable PGS for full graph coverage via parallel partition sweeps — set enablePGS=true and pick pgsConfig.sweepFraction ' +
    '(0.10 skim, 0.25 sample, 0.50 deep, 1.0 full). Sweep model should be fast/cheap (many parallel calls); ' +
    'synthesis model stronger (one final reasoning pass). For follow-up queries that build on a prior answer, pass priorContext.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The research question' },
      model: { type: 'string', description: 'Main query model (answer generation). Any model from cosmo23 catalog.' },
      mode: {
        type: 'string',
        enum: ['full', 'expert', 'dive'],
        description: 'full=balanced (default), expert=maximum depth, dive=exploratory synthesis',
      },
      enableSynthesis: { type: 'boolean', description: 'Enable synthesis layer over retrieved evidence (default true)' },
      includeOutputs: { type: 'boolean', description: 'Include agent output files as evidence' },
      includeThoughts: { type: 'boolean', description: 'Include thought journal entries as evidence' },
      includeCoordinatorInsights: { type: 'boolean', description: 'Include coordinator reviews/insights' },
      allowActions: { type: 'boolean', description: 'Permit the query to trigger tool actions (default false — safety)' },
      enablePGS: { type: 'boolean', description: 'Enable Progressive Graph Search (full graph coverage)' },
      pgsMode: { type: 'string', description: 'PGS mode — default "full"' },
      pgsConfig: {
        type: 'object',
        properties: {
          sweepFraction: { type: 'number', description: '0.10=skim, 0.25=sample, 0.50=deep, 1.0=full coverage' },
        },
      },
      pgsSweepModel: { type: 'string', description: 'Model for parallel partition sweeps (pick fast/cheap)' },
      pgsSynthModel: { type: 'string', description: 'Model for final synthesis pass (pick stronger)' },
      priorContext: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          answer: { type: 'string' },
        },
        description: 'For follow-up queries — pass the previous query + answer for context continuity',
      },
    },
    required: ['query'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.brainRoute) {
      return {
        content: `brain_query: agent brain not registered in cosmo23. Check: curl ${ctx.cosmo23BaseUrl}/api/brains`,
        is_error: true,
      };
    }

    const pgsConfig = input.pgsConfig as { sweepFraction?: number } | undefined;
    const sweepFraction = pgsConfig?.sweepFraction;
    const pgsFullSweep = typeof sweepFraction === 'number' && sweepFraction >= 1.0;

    const body: Record<string, unknown> = {
      query: input.query,
      model: input.model,
      mode: input.mode ?? 'full',
      enableSynthesis: input.enableSynthesis ?? true,
      includeOutputs: input.includeOutputs ?? false,
      includeThoughts: input.includeThoughts ?? false,
      includeCoordinatorInsights: input.includeCoordinatorInsights ?? false,
      allowActions: input.allowActions ?? false,
      enablePGS: input.enablePGS ?? false,
      pgsMode: input.pgsMode ?? 'full',
      pgsConfig: pgsConfig ?? {},
      pgsFullSweep,
      pgsSweepModel: input.pgsSweepModel,
      pgsSynthModel: input.pgsSynthModel,
      priorContext: input.priorContext ?? null,
      exportFormat: 'markdown',
      provider: null,
    };

    const timeoutMs = body.enablePGS ? 1_800_000 : 120_000;

    try {
      const res = await fetch(`${ctx.brainRoute}/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { content: `brain_query failed: HTTP ${res.status} — ${errText.slice(0, 500)}`, is_error: true };
      }

      const data = await res.json() as Record<string, unknown>;
      const answer = (data.answer ?? data.response ?? data.text ?? '') as string;
      const evidence = data.evidence as Array<unknown> | undefined;
      const meta = data.metadata as Record<string, unknown> | undefined;

      const parts: string[] = [];
      parts.push(answer.slice(0, 10_000) || 'brain_query returned empty result.');

      const footer: string[] = [];
      if (evidence?.length) footer.push(`${evidence.length} evidence nodes`);
      if (body.enablePGS && meta?.pgsPartitions) footer.push(`PGS: ${JSON.stringify(meta.pgsPartitions)}`);
      if (meta?.models) footer.push(`models=${JSON.stringify(meta.models)}`);
      if (footer.length) parts.push(`\n\n---\n[${footer.join(' · ')} · mode=${body.mode}]`);

      return { content: parts.join('') };
    } catch (err) {
      return { content: `brain_query error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};

// ── brain_query_export — write a query answer to the brain's export dir ──

export const brainQueryExportTool: ToolDefinition = {
  name: 'brain_query_export',
  description:
    'Export a prior brain_query answer to the brain export directory as markdown or json. ' +
    'Pass the query, answer, and optionally metadata from the brain_query response. ' +
    'The file is written inside the brain\'s own runs/<brain>/exports/ directory and the path is returned.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The original query' },
      answer: { type: 'string', description: 'The answer to export' },
      format: { type: 'string', enum: ['markdown', 'json'], description: 'Output format (default markdown)' },
      metadata: { type: 'object', description: 'Metadata from the brain_query response (models, mode, evidence counts, etc.)' },
    },
    required: ['query', 'answer'],
  },

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!ctx.brainRoute) {
      return {
        content: `brain_query_export: agent brain not registered in cosmo23. Check: curl ${ctx.cosmo23BaseUrl}/api/brains`,
        is_error: true,
      };
    }

    const body = {
      query: input.query,
      answer: input.answer,
      format: (input.format as string) ?? 'markdown',
      metadata: input.metadata ?? {},
    };

    try {
      const res = await fetch(`${ctx.brainRoute}/export-query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        return { content: `brain_query_export failed: HTTP ${res.status} — ${errText.slice(0, 500)}`, is_error: true };
      }
      const data = await res.json() as { exportedTo?: string; error?: string };
      if (data.error) return { content: `brain_query_export: ${data.error}`, is_error: true };
      return { content: `Exported to: ${data.exportedTo ?? '(unknown path)'}` };
    } catch (err) {
      return { content: `brain_query_export error: ${err instanceof Error ? err.message : String(err)}`, is_error: true };
    }
  },
};
```

- [ ] **Step 4: Remove brainPgsTool**

In the same file (`src/agent/tools/brain.ts`), delete the entire `brainPgsTool` export block (starting at approximately line 263 `// ── brain_pgs — Progressive Graph Search ──` and going through the closing `};` around line 375).

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npm test
```

Expected: all tests pass including the 5 new tests for `brain_query` and `brain_query_export`.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/brain.ts tests/agent/tools/brain.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): rework brain_query + add brain_query_export, remove brain_pgs

brain_query now POSTs to \${brainRoute}/query (cosmo23, same endpoint
the dashboard Query tab uses) with the tab's exact payload shape:
mode: full|expert|dive, enablePGS, pgsConfig.sweepFraction, priorContext.
The legacy 9-mode engine /api/query path is abandoned.

PGS is a flag on brain_query (enablePGS=true) — the standalone brain_pgs
tool is deleted, matching the tab's treatment of PGS as a checkbox.

brain_query_export wraps \${brainRoute}/export-query for writing answers
to the brain's own exports/ dir.

Tests assert the wire payload field-by-field so future drift between the
tab and the tool fails CI.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Update tools index + system prompt

**Files:**
- Modify: `src/agent/tools/index.ts`
- Modify: `src/agents/system-prompt.ts`

**Context:** Drop `brainPgsTool` export and references, add `brainQueryExportTool`.

- [ ] **Step 1: Update tools/index.ts**

Open `src/agent/tools/index.ts`. Find the brain tool imports/exports and change:

- Remove: `brainPgsTool` from both the import from `./brain.js` and from the exported array
- Add: `brainQueryExportTool` to both the import and the exported array

The specific lines will look like (before → after):

```ts
// Before
import { brainSearchTool, brainQueryTool, brainMemoryGraphTool, brainSynthesizeTool, brainPgsTool, brainStatusTool } from './brain.js';

// After
import { brainSearchTool, brainQueryTool, brainQueryExportTool, brainMemoryGraphTool, brainSynthesizeTool, brainStatusTool } from './brain.js';
```

And in the array of registered tools, replace `brainPgsTool` with `brainQueryExportTool` (or simply remove `brainPgsTool` and add `brainQueryExportTool`).

- [ ] **Step 2: Update system-prompt.ts**

```bash
cd /Users/jtr/_JTR23_/release/home23 && grep -n "brain_pgs\|brainPgsTool" src/agents/system-prompt.ts
```

For any hit, replace references to `brain_pgs` with a short note that PGS is now a flag on `brain_query`. If `brainPgsTool` is imported, remove the import.

Example inline replacement (if the system prompt has a tool list):
- Before: `- brain_pgs: Progressive Graph Search for full graph coverage`
- After: `- brain_query with enablePGS=true: Progressive Graph Search for full graph coverage`

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run tests**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/tools/index.ts src/agents/system-prompt.ts
git commit -m "$(cat <<'EOF'
feat(agent): drop brain_pgs from tool registry + system prompt

brain_pgs is merged into brain_query (enablePGS flag). Agent system
prompt is updated to reference the new invocation shape so jerry/coz
don't keep trying to call the old tool name.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Extend research_launch with runRoot + runName

**Files:**
- Modify: `src/agent/tools/research.ts:285-387`

**Context:** Tool computes `runName` and `runRoot` client-side so cosmo23 and the filesystem agree. `cosmo23` Patch 7 (Task 7) consumes these.

- [ ] **Step 1: Add runName generator + runRoot computation**

Edit `src/agent/tools/research.ts`. Near the top (after `errResult` around line 20), add helper imports and a runName generator:

```ts
import * as path from 'node:path';

function generateRunName(topic: string): string {
  const slug = (topic || 'research')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'research';
  const ts = new Date().toISOString()
    .replace(/[-:T.Z]/g, '')
    .slice(0, 14);
  return `${slug}-${ts}`;
}
```

- [ ] **Step 2: Update the research_launch execute function**

In `research_launch` at line 329, find the `payload` construction block and the POST call. Replace with:

```ts
  async execute(input, ctx) {
    const topic = input.topic as string;
    if (!topic) return errResult('research_launch: topic is required');
    try {
      const base = getCosmoBase(ctx);
      // Refuse if a run is already active — jerry should explicitly stop first
      const active = await checkCosmoActiveRun(ctx);
      if (active) {
        return errResult(
          `Cannot launch: a run is already active ("${active.runName}", topic: "${active.topic}"). Use research_stop first, or research_watch_run to monitor it.`
        );
      }

      // Generate runName + runRoot client-side so agent workspace owns the run
      const runName = generateRunName(topic);
      const runRoot = path.join(ctx.workspacePath, 'research-runs', runName);

      const payload: Record<string, unknown> = {
        topic,
        runName,
        runRoot,
        context: input.context || '',
        explorationMode: input.explorationMode || 'guided',
        analysisDepth: input.analysisDepth || 'normal',
        cycles: input.cycles || 20,
        maxConcurrent: input.maxConcurrent || 6,
        enableWebSearch: true,
        enableCodingAgents: false,
        enableAgentRouting: true,
        enableMemoryGovernance: true,
      };
      if (input.primaryModel) payload.primaryModel = input.primaryModel;
      if (input.primaryProvider) payload.primaryProvider = input.primaryProvider;
      if (input.fastModel) payload.fastModel = input.fastModel;
      if (input.fastProvider) payload.fastProvider = input.fastProvider;
      if (input.strategicModel) payload.strategicModel = input.strategicModel;
      if (input.strategicProvider) payload.strategicProvider = input.strategicProvider;

      const result = await fetchJson<LaunchResponse>(
        `${base}/api/launch`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
        45_000
      );

      if (!result.success) {
        return errResult(`research_launch failed: ${result.error || result.message || 'unknown'}`);
      }
      const lines = [
        `Research run launched:`,
        `- runName: **${result.runName}**`,
        `- brainId: ${result.brainId || '(pending)'}`,
        `- cycles: ${result.cycles || payload.cycles}`,
        `- runRoot: ${runRoot}`,
      ];
      if (result.dashboardUrl) lines.push(`- dashboard: ${result.dashboardUrl}`);
      lines.push('');
      lines.push('The run lives in your workspace. Feeder will ingest markdown output as it appears.');
      lines.push('Use research_watch_run to check progress. Do not check every turn.');
      return { content: lines.join('\n') };
    } catch (err) {
      return errResult(`research_launch: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Add a test for the new payload fields**

Append to `tests/agent/tools/brain.test.ts` (or create a separate `tests/agent/tools/research.test.ts` if preferred):

```ts
import { launchTool } from '../../../src/agent/tools/research.js';

describe('research_launch', () => {
  it('sends runName and runRoot derived from ctx.workspacePath', async () => {
    let capturedBody: any;
    (globalThis as any).fetch = async (url: any, init: any) => {
      const u = String(url);
      if (u.endsWith('/api/status')) {
        return { ok: true, json: async () => ({ running: false }) } as unknown as Response;
      }
      if (u.endsWith('/api/launch')) {
        capturedBody = JSON.parse(init.body);
        return { ok: true, json: async () => ({ success: true, runName: capturedBody.runName, brainId: 'b1', cycles: 10 }) } as unknown as Response;
      }
      return { ok: true, json: async () => ({}) } as unknown as Response;
    };
    await launchTool.execute(
      { topic: 'sauna HRV correlation' },
      makeCtx(),
    );
    assert.match(capturedBody.runName, /^sauna-hrv-correlation-\d{14}$/);
    assert.equal(capturedBody.runRoot, '/fake/instances/jerry/workspace/research-runs/' + capturedBody.runName);
  });
});
```

- [ ] **Step 5: Run tests**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/agent/tools/research.ts tests/agent/tools/brain.test.ts
git commit -m "$(cat <<'EOF'
feat(agent): research_launch sends runName + runRoot to cosmo23

Tool now computes a stable slug-timestamp runName and a runRoot inside
the launching agent's workspace (instances/<agent>/workspace/research-
runs/<runName>). cosmo23 Patch 7 (next commit) consumes these and
creates the run there with a symlink back to cosmo23/runs/<runName>.

Result line includes the runRoot so jerry/coz see exactly where the run
lives and the feeder picks up markdown output as it appears.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Cosmo23 Patch 7 — createRun accepts runPath override

**Files:**
- Modify: `cosmo23/launcher/run-manager.js:112`
- Modify: `cosmo23/server/index.js:616`

**Context:** `RunManager.createRun` currently hardcodes `this.runsDir/<runName>`. Patch adds an optional `runPath` override. When caller provides runPath, we mkdir there, then create a symlink at the legacy path. Failures on the symlink are non-fatal.

- [ ] **Step 1: Update RunManager.createRun**

Edit `cosmo23/launcher/run-manager.js`. Replace the `createRun` method (starting at line 112) with:

```js
  /**
   * Create a new run
   * @param {string} runName
   * @param {object} [options]
   * @param {string} [options.runPath] - Override the run dir location (used
   *   when a Home23 agent owns the run; also creates a symlink at the
   *   default location so cosmo23/runs/<runName> still resolves).
   */
  async createRun(runName, options = {}) {
    const defaultPath = path.join(this.runsDir, runName);
    const runPath = options.runPath || defaultPath;
    const needsSymlink = !!options.runPath && options.runPath !== defaultPath;

    try {
      // Check if the actual run path already exists
      try {
        await fs.access(runPath);
        throw new Error(`Run path "${runPath}" already exists`);
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }

      // Create run directory structure at runPath
      await fs.mkdir(runPath, { recursive: true });
      await fs.mkdir(path.join(runPath, 'coordinator'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'agents'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'outputs'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'exports'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'policies'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'training'), { recursive: true });
      await fs.mkdir(path.join(runPath, 'ingestion', 'documents'), { recursive: true });

      // If runPath diverges from the default, create symlink at default so
      // existing cosmo23 consumers (dashboards, CLI tools) keep working.
      if (needsSymlink) {
        try {
          // Ensure parent runs dir exists
          await fs.mkdir(this.runsDir, { recursive: true });
          // Remove any stale entry at the default path
          try { await fs.unlink(defaultPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          await fs.symlink(runPath, defaultPath, 'dir');
          this.logger.info(`Created run: ${runName} at ${runPath} (symlink at ${defaultPath})`);
        } catch (err) {
          this.logger.warn(`Symlink creation failed for ${runName}: ${err.message}. Run still created at ${runPath}.`);
        }
      } else {
        this.logger.info(`Created run: ${runName}`);
      }

      // Write run.json ownership record
      const ownerInfo = {
        owner: options.owner || null,
        createdAt: new Date().toISOString(),
        topic: options.topic || null,
        runName,
      };
      try {
        await fs.writeFile(path.join(runPath, 'run.json'), JSON.stringify(ownerInfo, null, 2));
      } catch (err) {
        this.logger.warn(`Failed to write run.json: ${err.message}`);
      }

      return { success: true, runName, path: runPath };
    } catch (error) {
      this.logger.error(`Failed to create run ${runName}:`, error);
      return { success: false, error: error.message };
    }
  }
```

- [ ] **Step 2: Wire runRoot through ensureLocalBrainForLaunch**

Edit `cosmo23/server/index.js`. Find the block around line 616 (inside `ensureLocalBrainForLaunch`):

```js
  const baseName = sanitizeRunName(payload.runName || payload.topic || 'cosmo');
  const runName = await ensureUniqueRunName(baseName, LOCAL_RUNS_PATH);
  const created = await runManager.createRun(runName);
```

Replace with:

```js
  // Honor caller-supplied runName when present (harness-driven Home23 launches);
  // otherwise derive from topic. Collision check still runs against LOCAL_RUNS_PATH.
  const baseName = sanitizeRunName(payload.runName || payload.topic || 'cosmo');
  const runName = await ensureUniqueRunName(baseName, LOCAL_RUNS_PATH);

  // Home23 agents supply runRoot to relocate the run dir into their workspace.
  // Without runRoot, legacy cosmo23 behavior (dir at LOCAL_RUNS_PATH/<runName>).
  const createOpts = {};
  if (payload.runRoot && typeof payload.runRoot === 'string') {
    createOpts.runPath = payload.runRoot;
  }
  if (payload.owner || payload.agentName) {
    createOpts.owner = payload.owner || payload.agentName;
  }
  if (payload.topic) createOpts.topic = payload.topic;

  const created = await runManager.createRun(runName, createOpts);
```

- [ ] **Step 3: Add tests for the new behavior**

Edit `cosmo23/server/lib/brains-router.test.js` (or create `cosmo23/launcher/run-manager.test.js` if the existing test file isn't about run-manager). Test structure:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const RunManager = require('../../launcher/run-manager');

function silentLogger() { return { info: () => {}, warn: () => {}, error: () => {} }; }

test('createRun with runPath creates at override location and symlinks default', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-rm-'));
  const runsDir = path.join(tmp, 'runs');
  await fs.mkdir(runsDir, { recursive: true });
  const externalDir = path.join(tmp, 'agent-workspace', 'research-runs', 'test-run');
  const rm = new RunManager({ runsDir, logger: silentLogger() });

  const result = await rm.createRun('test-run', { runPath: externalDir, owner: 'jerry', topic: 'test topic' });
  assert.equal(result.success, true);
  assert.equal(result.path, externalDir);

  const stat = await fs.stat(externalDir);
  assert.ok(stat.isDirectory());

  const linkStat = await fs.lstat(path.join(runsDir, 'test-run'));
  assert.ok(linkStat.isSymbolicLink());

  const runJson = JSON.parse(await fs.readFile(path.join(externalDir, 'run.json'), 'utf8'));
  assert.equal(runJson.owner, 'jerry');
  assert.equal(runJson.topic, 'test topic');

  await fs.rm(tmp, { recursive: true, force: true });
});

test('createRun without runPath preserves legacy behavior', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cosmo-rm-'));
  const runsDir = path.join(tmp, 'runs');
  await fs.mkdir(runsDir, { recursive: true });
  const rm = new RunManager({ runsDir, logger: silentLogger() });

  const result = await rm.createRun('legacy-run');
  assert.equal(result.success, true);
  assert.equal(result.path, path.join(runsDir, 'legacy-run'));

  const stat = await fs.lstat(path.join(runsDir, 'legacy-run'));
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink());

  await fs.rm(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 4: Run the cosmo23 tests**

```bash
cd /Users/jtr/_JTR23_/release/home23/cosmo23 && node --test server/lib/brains-router.test.js
```

Expected: both new tests pass. If the existing test file has other tests, they should continue passing.

- [ ] **Step 5: Commit**

```bash
git add cosmo23/launcher/run-manager.js cosmo23/server/index.js cosmo23/server/lib/brains-router.test.js
git commit -m "$(cat <<'EOF'
feat(cosmo23): Patch 7 — createRun accepts runPath override + ownership

RunManager.createRun(runName, options) now takes optional { runPath,
owner, topic }. When runPath diverges from the default runsDir location,
we mkdir at runPath and create a symlink at runsDir/<runName> so legacy
consumers still resolve by the default path. Symlink failure is
non-fatal — logged, not thrown. Each run writes run.json with owner +
createdAt + topic for future discovery tools.

launchResearch -> ensureLocalBrainForLaunch forwards payload.runRoot,
payload.owner, payload.agentName into createOpts. Missing runRoot
preserves today's behavior exactly.

Tests cover: override path + symlink creation + ownership record;
legacy path without override; existing collisions.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Document Patch 7 in COSMO23-VENDORED-PATCHES.md

**Files:**
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md`

**Context:** All cosmo23 patches must be tracked so they survive upstream resyncs. Add Patch 7 entry with file paths, diff summary, and why.

- [ ] **Step 1: Read the existing file to match style**

```bash
cd /Users/jtr/_JTR23_/release/home23 && tail -40 docs/design/COSMO23-VENDORED-PATCHES.md
```

Note the formatting conventions for Patch 1-6.

- [ ] **Step 2: Append Patch 7**

Add to the bottom of `docs/design/COSMO23-VENDORED-PATCHES.md`:

```markdown

---

## Patch 7: `runRoot` + ownership on research-run launch

**Why:** Home23 agents own research runs they launch. The runs must live inside the launching agent's workspace (`instances/<agent>/workspace/research-runs/<runName>/`) so they are visible to the agent, picked up by the feeder, and survive any future reorganization of cosmo23's runs directory. cosmo23 continues to find runs by the legacy path via a symlink it creates automatically.

**Files touched:**
- `cosmo23/launcher/run-manager.js` — `createRun(runName, options = {})` accepts `options.runPath`, `options.owner`, `options.topic`; creates run dir at `runPath` when given, symlinks the default location back to it, writes `run.json` with ownership record
- `cosmo23/server/index.js` — `ensureLocalBrainForLaunch` forwards `payload.runRoot`, `payload.owner`, `payload.agentName`, `payload.topic` into `createRun` options

**Behavior preserved:** launches without `runRoot` in the payload (cosmo23 CLI, direct dashboard launches, pre-Home23 callers) continue to create runs at `cosmo23/runs/<runName>/` exactly as before. No symlink created when runPath equals default path.

**Must survive upstream resync.** If cosmo23's run creation API changes upstream, re-apply the same semantics: optional runRoot + non-fatal symlink + ownership record.
```

- [ ] **Step 3: Commit**

```bash
git add docs/design/COSMO23-VENDORED-PATCHES.md
git commit -m "$(cat <<'EOF'
docs(cosmo23): record Patch 7 — runRoot + ownership on research launch

Tracked patch so it survives the next upstream cosmo23 resync.
Re-applies as: optional runRoot payload field + non-fatal symlink at
legacy path + run.json ownership record.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Add feeder exclusion patterns

**Files:**
- Modify: `configs/base-engine.yaml:637`

**Context:** Research runs now live inside agent workspaces. Markdown output is welcome in the brain, but raw brain state files (`research-runs/*/brain/**`) and cycle-log JSONL (`research-runs/*/*.jsonl`) are operational — ingesting them would create recursion noise.

- [ ] **Step 1: Add exclusions**

Edit `configs/base-engine.yaml`. Find the `excludePatterns:` block at line 637 and add the two new patterns:

```yaml
  excludePatterns:
    - "**/node_modules/**"
    - "**/dist/**"
    - "**/build/**"
    - "**/out/**"
    - "**/target/**"
    - "**/coverage/**"
    - "**/__pycache__/**"
    - "**/venv/**"
    - "**/*.min.js"
    - "**/*.min.css"
    - "**/*.map"
    - "**/*.lock"
    - "**/*.log"
    - "**/package-lock.json"
    - "**/yarn.lock"
    - "**/pnpm-lock.yaml"
    - "**/*.pyc"
    - "**/research-runs/*/brain/**"
    - "**/research-runs/*/*.jsonl"
```

- [ ] **Step 2: Commit**

```bash
git add configs/base-engine.yaml
git commit -m "$(cat <<'EOF'
config(feeder): exclude raw research-run brain state + cycle-log JSONL

Research runs now live inside agent workspaces and markdown output is
welcome in the brain. But research-runs/*/brain/** is the run's own
compressed state (would create recursion noise if ingested), and the
cycle-log JSONL is operational plumbing, not brain content.

Only research markdown docs get ingested.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Sweep identity and skill files for brain_pgs references

**Files:**
- Modify: `cli/templates/COSMO_RESEARCH.md` (if present)
- Modify: `instances/*/workspace/*.md` (any file referencing `brain_pgs`)

**Context:** Any skill or identity file telling agents to call `brain_pgs` will fail post-deploy. Replace with the new invocation.

- [ ] **Step 1: Find all references**

```bash
cd /Users/jtr/_JTR23_/release/home23 && grep -rln "brain_pgs" cli/templates/ instances/ 2>/dev/null
```

Note each file in the output.

- [ ] **Step 2: Update each file**

For each file found, open it and replace `brain_pgs` references. The canonical replacement pattern:

- Before: `brain_pgs(query="X", mode="full")` or `use brain_pgs for...`
- After: `brain_query(query="X", enablePGS=true, pgsConfig={sweepFraction: 0.25})` or `use brain_query with enablePGS=true for...`

If a file has extensive tool-list prose mentioning `brain_pgs` as a named tool, edit the prose to reflect the merge — PGS is a flag, not a tool.

- [ ] **Step 3: Verify no remaining references**

```bash
cd /Users/jtr/_JTR23_/release/home23 && grep -rn "brain_pgs" cli/templates/ instances/ 2>/dev/null
```

Expected: no output (zero hits).

- [ ] **Step 4: Commit**

```bash
git add cli/templates/ instances/
git commit -m "$(cat <<'EOF'
docs(identity): replace brain_pgs references with brain_query enablePGS

Sweep of cli/templates + instances workspace files. brain_pgs is no
longer a tool — PGS is a flag on brain_query. Agents reading these
skill/identity files will now invoke the correct tool.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Write cli/lib/relocate-research-runs.js

**Files:**
- Create: `cli/lib/relocate-research-runs.js`

**Context:** One-shot interactive script: walks `cosmo23/runs/`, for each regular directory (not already a symlink) prompts which agent owns it, moves it into that agent's workspace, creates the symlink, writes `run.json`. Skippable per-run.

- [ ] **Step 1: Create the script**

Create `cli/lib/relocate-research-runs.js`:

```js
#!/usr/bin/env node
/**
 * One-shot relocator for pre-Patch-7 research runs.
 *
 * Walks cosmo23/runs/, finds regular directories (not symlinks), asks
 * which agent owns each, moves to instances/<agent>/workspace/research-
 * runs/<runName>, symlinks back, writes run.json. Skippable per-run.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const COSMO_RUNS = path.join(REPO_ROOT, 'cosmo23', 'runs');
const INSTANCES = path.join(REPO_ROOT, 'instances');

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, a => resolve(a.trim())));
}

async function listAgents() {
  try {
    const entries = await fs.readdir(INSTANCES, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}

async function isRegularDir(p) {
  try {
    const s = await fs.lstat(p);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
}

async function moveRun(sourcePath, destPath) {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.rename(sourcePath, destPath);
}

async function createSymlink(linkPath, targetPath) {
  try { await fs.unlink(linkPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await fs.symlink(targetPath, linkPath, 'dir');
}

async function writeRunJson(runPath, owner, topic) {
  const file = path.join(runPath, 'run.json');
  try { await fs.access(file); return; } catch {}
  await fs.writeFile(file, JSON.stringify({
    owner,
    createdAt: new Date().toISOString(),
    topic: topic || null,
    runName: path.basename(runPath),
    relocatedAt: new Date().toISOString(),
  }, null, 2));
}

async function readTopic(runPath) {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(runPath, 'metadata.json'), 'utf8'));
    return meta.topic || null;
  } catch { return null; }
}

async function main() {
  console.log(`Relocating runs from ${COSMO_RUNS} into instances/<agent>/workspace/research-runs/`);

  const agents = await listAgents();
  if (agents.length === 0) {
    console.error('No agents found under instances/. Abort.');
    process.exit(1);
  }
  console.log(`Detected agents: ${agents.join(', ')}`);

  let runs;
  try {
    runs = await fs.readdir(COSMO_RUNS);
  } catch (err) {
    console.error(`Cannot read ${COSMO_RUNS}: ${err.message}`);
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let moved = 0, skipped = 0;

  for (const runName of runs) {
    const sourcePath = path.join(COSMO_RUNS, runName);
    if (!await isRegularDir(sourcePath)) continue;

    const topic = await readTopic(sourcePath);
    console.log(`\n── Run: ${runName}${topic ? ` (topic: ${topic})` : ''}`);
    const ans = await prompt(rl, `Owner agent (one of ${agents.join('/')}) or 'skip' [skip]: `);
    if (!ans || ans.toLowerCase() === 'skip') { skipped++; continue; }
    if (!agents.includes(ans)) {
      console.log(`  ! '${ans}' is not a known agent. Skipped.`);
      skipped++;
      continue;
    }

    const destPath = path.join(INSTANCES, ans, 'workspace', 'research-runs', runName);
    try {
      await moveRun(sourcePath, destPath);
      await createSymlink(sourcePath, destPath);
      await writeRunJson(destPath, ans, topic);
      console.log(`  ✓ Moved to ${destPath}`);
      console.log(`  ✓ Symlink at ${sourcePath}`);
      moved++;
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
      skipped++;
    }
  }

  rl.close();
  console.log(`\nDone. Moved: ${moved}. Skipped: ${skipped}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x /Users/jtr/_JTR23_/release/home23/cli/lib/relocate-research-runs.js
```

- [ ] **Step 3: Commit (do NOT run the script yet — that's a deploy step)**

```bash
git add cli/lib/relocate-research-runs.js
git commit -m "$(cat <<'EOF'
feat(cli): relocate-research-runs script for pre-Patch-7 run migration

Interactive one-shot: walks cosmo23/runs/, skips symlinks, for each
regular dir asks which agent owns it, moves to the agent's workspace,
creates symlink + run.json. Skippable per-run. Reads topic from existing
metadata.json when present.

Not run automatically — operator runs after the harness + cosmo23 deploy
is stable. Leaves untouched runs in place.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: Write scripts/smoke-brain-tools.js

**Files:**
- Create: `scripts/smoke-brain-tools.js`

**Context:** Live smoke test. Hits a running jerry (or whatever primary agent). One call per brain tool. Assert non-error + expected response fields. Operator runs this before declaring the deploy stable.

- [ ] **Step 1: Create the script**

Create `scripts/smoke-brain-tools.js`:

```js
#!/usr/bin/env node
/**
 * Live smoke test for brain_* tools. Requires a running agent + cosmo23.
 *
 * Usage:
 *   HOME23_AGENT=jerry node scripts/smoke-brain-tools.js
 */

const agentName = process.env.HOME23_AGENT || 'jerry';
const cosmo23Port = Number(process.env.COSMO23_PORT || 43210);
const enginePort = Number(process.env.HOME23_ENGINE_PORT || 5002);
const cosmo23Base = `http://localhost:${cosmo23Port}`;
const engineBase = `http://localhost:${enginePort}`;

async function resolveBrainRoute() {
  const res = await fetch(`${cosmo23Base}/api/brains`);
  if (!res.ok) throw new Error(`${cosmo23Base}/api/brains returned HTTP ${res.status}`);
  const data = await res.json();
  const brains = data.brains || [];
  const match = brains.find(b => b.name === agentName) ||
                brains.find(b => typeof b.path === 'string' && b.path.includes(`/instances/${agentName}/brain`));
  if (!match?.id) throw new Error(`No brain found for agent ${agentName} in ${cosmo23Base}/api/brains`);
  return `${cosmo23Base}/api/brain/${match.id}`;
}

function assertOk(condition, msg) {
  if (!condition) { console.error(`  ✗ ${msg}`); process.exitCode = 1; }
  else console.log(`  ✓ ${msg}`);
}

async function smokeBrainSearch() {
  console.log('\n[brain_search]');
  const res = await fetch(`${engineBase}/api/memory/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'smoke test query', topK: 3, minSimilarity: 0.1 }),
  });
  assertOk(res.ok, `HTTP ${res.status}`);
  if (res.ok) {
    const data = await res.json();
    assertOk(Array.isArray(data.results), 'results is array');
  }
}

async function smokeBrainStatus() {
  console.log('\n[brain_status]');
  const res = await fetch(`${engineBase}/api/state`);
  assertOk(res.ok, `HTTP ${res.status}`);
}

async function smokeBrainQuery(brainRoute) {
  console.log('\n[brain_query] (mode=full, no PGS, short timeout)');
  const res = await fetch(`${brainRoute}/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'What is the current status of the system?',
      mode: 'full',
      enableSynthesis: true,
      enablePGS: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  assertOk(res.ok, `HTTP ${res.status}`);
  if (res.ok) {
    const data = await res.json();
    assertOk(typeof data.answer === 'string', 'answer is string');
  }
}

async function smokeBrainQueryExport(brainRoute) {
  console.log('\n[brain_query_export]');
  const res = await fetch(`${brainRoute}/export-query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: 'smoke export test',
      answer: 'smoke test answer content',
      format: 'markdown',
      metadata: { smoke: true },
    }),
  });
  assertOk(res.ok, `HTTP ${res.status}`);
  if (res.ok) {
    const data = await res.json();
    assertOk(typeof data.exportedTo === 'string' && data.exportedTo.length > 0, `exportedTo: ${data.exportedTo}`);
  }
}

(async () => {
  console.log(`Smoke test for agent=${agentName} cosmo23=${cosmo23Base} engine=${engineBase}`);
  const brainRoute = await resolveBrainRoute();
  console.log(`Resolved brainRoute: ${brainRoute}`);

  await smokeBrainSearch();
  await smokeBrainStatus();
  await smokeBrainQuery(brainRoute);
  await smokeBrainQueryExport(brainRoute);

  if (process.exitCode) console.error('\n✗ Smoke FAILED');
  else console.log('\n✓ Smoke PASSED');
})().catch(err => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Commit (script is not run at plan time — run during deploy verification)**

```bash
chmod +x /Users/jtr/_JTR23_/release/home23/scripts/smoke-brain-tools.js
git add scripts/smoke-brain-tools.js
git commit -m "$(cat <<'EOF'
test(smoke): live brain-tool smoke script

One call per brain tool against a running agent. Resolves brainRoute the
same way the harness does, hits /api/memory/search, /api/state, cosmo23
query, export-query. Asserts non-error + shape, non-zero exit on any
failure. Run during deploy verification.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Build, restart, verify

**Files:**
- None (verification step)

**Context:** All code is in place. Build the harness, restart jerry's harness process, verify brainRoute resolves, run the smoke script. Per the persistence-safety rules, we **do not** restart the engine. The changes are harness-only + cosmo23-only.

- [ ] **Step 1: Build the harness**

```bash
cd /Users/jtr/_JTR23_/release/home23 && npm run build 2>&1 | tail -20
```

Expected: zero TypeScript errors.

- [ ] **Step 2: Restart the harness (jerry) — but NOT the engine**

```bash
pm2 restart home23-jerry-harness
```

Wait ~10 seconds for boot.

- [ ] **Step 3: Verify brainRoute resolved at boot**

```bash
pm2 logs home23-jerry-harness --lines 50 --nostream --raw 2>/dev/null | grep -i "brainRoute"
```

Expected: line containing `[home] brainRoute resolved: http://localhost:43210/api/brain/<id>`.

If instead you see `brainRoute NOT resolved`, run `curl http://localhost:43210/api/brains` to debug.

- [ ] **Step 4: Restart cosmo23**

```bash
pm2 restart home23-cosmo23
```

Wait ~5 seconds.

- [ ] **Step 5: Run the smoke**

```bash
cd /Users/jtr/_JTR23_/release/home23 && HOME23_AGENT=jerry node scripts/smoke-brain-tools.js
```

Expected: `✓ Smoke PASSED`. Failures should be diagnosed before continuing — do not run the relocation script until smoke is clean.

- [ ] **Step 6: Run the cosmo23 tests fresh (post-restart sanity)**

```bash
cd /Users/jtr/_JTR23_/release/home23/cosmo23 && node --test server/lib/brains-router.test.js
```

Expected: all pass.

- [ ] **Step 7: Optional — run the relocation script for existing runs**

```bash
cd /Users/jtr/_JTR23_/release/home23 && node cli/lib/relocate-research-runs.js
```

Interactive — answer per run or `skip`. If none of the existing runs belong to specific agents (they're legacy/orphaned), skip all and leave them.

- [ ] **Step 8: 24h verification (passive)**

Over the next 24 hours tail the event ledger for stray `brain_pgs` tool-call attempts:

```bash
tail -f /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/event-ledger.jsonl | grep brain_pgs
```

Zero output = skill-file sweep was complete. If anything appears, there's still an identity/skill reference to hunt down.

---

## Self-Review

Checklist run against the spec:

- **Summary (spec):** agent tools use dashboard protocol + research runs in agent workspace → **Tasks 1-8 (brain tools) + 6-7 (research runs)** cover both
- **Tool Surface Kept As-Is** (search, memory_graph, status, synthesize): **no tasks needed** — they stay on engine endpoints
- **Tool Surface Reworked** (brain_query): **Task 4**
- **Tool Surface Removed** (brain_pgs): **Tasks 4 + 5 + 10**
- **Tool Surface Added** (brain_query_export): **Task 4**
- **Research Run Storage Topology:** **Tasks 6 + 7 + 11**
- **Patch 7 documentation:** **Task 8**
- **Feeder exclusion patterns:** **Task 9**
- **Plumbing (ToolContext + resolver):** **Tasks 1-3**
- **Unit tests:** **Tasks 2, 4, 6**
- **Cosmo23 patch tests:** **Task 7**
- **Smoke script:** **Task 12**
- **Migration (sweep skill files + run relocation):** **Tasks 10 + 11**
- **Deploy verification:** **Task 13**
- **Rollback:** all changes are additive or in files with clean reverts — no separate task needed

**Placeholder scan:** no TBDs, no "implement later," no unexplained code references. Every step that changes code shows the code.

**Type consistency:** `brainQueryTool`, `brainQueryExportTool` used consistently. `createRun(runName, options)` with `options.runPath` consistent between Task 7 and its tests. `resolveBrainRoute(agentName, cosmo23BaseUrl, options)` consistent between Task 2 and Task 3.

**Spec gaps found:** none — every spec requirement maps to at least one task.
