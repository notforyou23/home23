import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { ToolRegistry } from '../../src/agent/tools/index.js';
import type { ToolContext, ToolResult } from '../../src/agent/types.js';
import { resolveDiagnosticInspection, INSPECTION_AUTHORITY_REFUSED } from '../../src/agent/diagnostic-inspection.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ConversationHistory } from '../../src/agent/history.js';

const source = readFileSync(new URL('../../src/home.ts', import.meta.url), 'utf8');
const start = source.indexOf('  const parseDiagnosticCompletion =');
const finish = source.indexOf('  // Resumable chat routes', start);
assert.ok(start > 0 && finish > start, 'the production diagnostic endpoint is present');
const handlerCode = ts.transpileModule(source.slice(start, finish), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

const intent = {
  schema: 'home23.bounded-agenda-intent.v1', operation: 'verify', targetRef: 'cron:morning-briefing',
  question: 'Does the morning briefing run every day, including weekends?',
  expectedEvidence: 'The current schedule and disabled flag for this specific briefing.',
  stopCondition: 'Stop after reading the schedule. Do not change or restart anything.',
  evidenceRefs: ['cron:morning-briefing'],
};
const problem = () => ({ id: 'agenda-inspection-fixture', claim: intent.question, inspection: { ...intent },
  inspectionEvidenceRefs: ['cron:morning-briefing'], inspectionExecution: { executionId: 'inspection:fixture' } });

async function fixture(t: { after(fn: () => void): void }, response: Record<string, unknown> | Error = {
  text: 'VERIFIER_STATUS: pass\nDISPATCH_OUTCOME: fixed\nSUMMARY: a schedule was inspected.',
  terminalStatus: 'complete', model: 'fixture', toolCallCount: 1, durationMs: 10,
}, callbackStatuses: number[] = [200]) {
  const root = mkdtempSync(join(tmpdir(), 'diagnostic-inspection-'));
  const instanceDir = join(root, 'instances', 'milo'), workspace = join(instanceDir, 'workspace');
  mkdirSync(workspace, { recursive: true }); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'evidence.txt'), 'The current schedule is every day.');
  const registry = new ToolRegistry(); let dangerous = 0;
  for (const name of ['shell', 'coding_run', 'spawn_agent', 'cron_update', 'web_browse', 'contact_owner', 'write_file']) registry.register({
    name, description: 'unsafe fixture tool', input_schema: { type: 'object' }, async execute() { dangerous++; return { content: 'must not run' }; },
  });
  registry.register({ name: 'cron_list', description: 'read schedules', input_schema: { type: 'object' }, async execute() { return { content: 'daily briefing: 15 7 * * *' }; } });
  let resolveDiagnosticInspection: any;
  if (existsSync(new URL('../../src/agent/diagnostic-inspection.ts', import.meta.url))) ({ resolveDiagnosticInspection } = await import('../../src/agent/diagnostic-inspection.js'));
  const runs: Array<{ chatId: string; mission: string; options: any }> = [], posts: Array<{ url: string; options: any; body: any }> = [];
  let handler: any;
  vm.runInNewContext(handlerCode, {
    bridgeToken: 'fixture-existing-bridge-token', ENGINE_BASE: 'http://engine.fixture', registry,
    INSTANCE_DIR: instanceDir, WORKSPACE_PATH: workspace, PROJECT_ROOT: root,
    resolveDiagnosticInspection,
    agent: { isRunning: () => false, runWithTurn: async (chatId: string, mission: string, options: any) => {
      runs.push({ chatId, mission, options });
      return { turnId: 'turn-fixture', response: response instanceof Error ? Promise.reject(response) : Promise.resolve(response) };
    } },
    bridgeApp: { post: (route: string, fn: any) => { assert.equal(route, '/api/diagnose'); handler = fn; } },
    fetch: async (url: string, options: any) => { posts.push({ url, options, body: JSON.parse(options.body) }); const status = callbackStatuses.shift() ?? 200; return { ok: status >= 200 && status < 300, status }; },
    setTimeout: (resolve: () => void) => { resolve(); },
    console: { log() {}, warn() {}, error() {} },
  });
  const invoke = async (value: unknown) => {
    const result: { status: number; body?: any } = { status: 200 };
    const res = { status(code: number) { result.status = code; return res; }, json(body: any) { result.body = body; return res; } };
    await handler({ headers: { authorization: 'Bearer fixture-existing-bridge-token' }, body: { problem: value } }, res);
    await new Promise(resolve => setImmediate(resolve));
    return result;
  };
  return { root, instanceDir, workspace, registry, runs, posts, invoke, dangerous: () => dangerous };
}

test('actual diagnose handler selects a separate read-only registry for typed inspections', async t => {
  const f = await fixture(t); assert.equal((await f.invoke(problem())).status, 200);
  assert.equal(f.runs.length, 1);
  assert.equal(f.runs[0]!.chatId, 'inspection:agenda-inspection-fixture');
  assert.ok(f.runs[0]!.options?.registry, 'a typed inspection must not use the shared full toolbox');
  for (const name of ['shell', 'coding_run', 'spawn_agent', 'cron_update', 'web_browse', 'contact_owner', 'write_file']) assert.equal(f.runs[0]!.options.registry.get(name), undefined, name);
  assert.doesNotMatch(f.runs[0]!.mission, /full toolbox|write scripts|restart processes/i);
  assert.equal(f.runs[0]!.options.suppressCompletionPush, true);
});
test('presence of invalid or forged inspection metadata never falls back to legacy repair authority', async t => {
  const f = await fixture(t);
  for (const inspection of [null, undefined, {}, { ...intent, schema: 'future-inspection' }, { ...intent, targetRef: 'unprovided:secret' }]) {
    assert.equal((await f.invoke({ ...problem(), inspection })).status, 400);
  }
  assert.equal(f.runs.length, 0);
});
test('inspection callback reports actual runtime completion separately from the model repair trailer', async t => {
  const f = await fixture(t); await f.invoke(problem());
  assert.equal(f.posts.length, 1);
  const posted = f.posts[0]!;
  assert.equal(posted.body.executionStatus, 'completed');
  assert.equal(posted.body.inspectionExecutionId, 'inspection:fixture');
  assert.equal(posted.body.inspectionCompletionSource, 'agent-loop-terminal');
  assert.equal(posted.body.dispatchOutcome, 'unknown'); assert.equal(posted.body.verifierStatus, 'unknown');
  assert.equal(posted.body.reportedDispatchOutcome, 'fixed');
  assert.equal(posted.options.headers.Authorization, 'Bearer fixture-existing-bridge-token');
  assert.ok(Number.isFinite(Date.parse(posted.body.inspectionCompletedAt)));
});
test('actual rejected or stopped turns cannot report a successful inspection execution', async t => {
  for (const outcome of [new Error('fixture runtime failure'), { text: 'pass', terminalStatus: 'stopped', model: 'fixture', toolCallCount: 0, durationMs: 1 }]) {
    const f = await fixture(t, outcome); await f.invoke(problem());
    assert.equal(f.posts[0]?.body.executionStatus, 'failed');
  }
});
test('legacy diagnostic requests retain their existing explicit repair path', async t => {
  const f = await fixture(t); await f.invoke({ id: 'legacy', claim: 'A known endpoint failed.' });
  assert.equal(f.runs[0]!.options, undefined); assert.match(f.runs[0]!.mission, /full toolbox/);
  assert.equal(f.posts[0]?.body.dispatchOutcome, 'fixed');
});

test('a typed callback retries the dispatch-record race without rerunning the agent or changing its receipt', async t => {
  const f = await fixture(t, undefined, [409, 409, 200]); await f.invoke(problem());
  assert.equal(f.runs.length, 1); assert.equal(f.posts.length, 3);
  assert.equal(new Set(f.posts.map(post => post.options.body)).size, 1);
  assert.ok(f.posts.every(post => post.options.headers.Authorization === 'Bearer fixture-existing-bridge-token'));
});

async function capabilityFixture(t: { after(fn: () => void): void }) {
  const f = await fixture(t); let snapshots = 0; const originalInputs: Array<{ name: string; input: unknown }> = [];
  for (const name of ['agency_brief', 'work_list']) f.registry.register({ name, description: 'fixture status', input_schema: { type: 'object' },
    async execute(input) { originalInputs.push({ name, input }); return { content: name === 'agency_brief' ? 'No open obligations.' : 'No active work.' }; } });
  const resolve = () => resolveDiagnosticInspection(problem(), { registry: f.registry, instanceDir: f.instanceDir, workspacePath: f.workspace,
    sourceRoot: f.root, runtimeSnapshot: async () => { snapshots++; return { memory: 'bounded current observation' }; } })!;
  const context = () => ({ ...toolContext(),
    agencyRequest: async (path: string, input?: RequestInit) => { originalInputs.push({ name: path, input }); return { text: 'No open obligations.' }; },
    workRegistry: { list: (input: unknown) => { originalInputs.push({ name: 'work_list', input }); return []; } },
  } as unknown as ToolContext);
  return { ...f, resolve, originalInputs, context, snapshots: () => snapshots };
}
const toolContext = () => ({ chatId: 'inspection:agenda-inspection-fixture' } as ToolContext);
const assertRefused = (result: ToolResult) => { assert.equal(result.is_error, true); assert.equal(JSON.parse(result.content).code, INSPECTION_AUTHORITY_REFUSED); };

test('inspection reads bounded local evidence, public source, and argument-free status tools', async t => {
  const f = await capabilityFixture(t); mkdirSync(join(f.root, 'src')); writeFileSync(join(f.root, 'src', 'public.ts'), 'export const status = true;');
  const inspection = f.resolve(), ctx = f.context();
  assert.match((await inspection.registry.execute('read_file', { path: join(f.workspace, 'evidence.txt') }, ctx)).content, /every day/);
  assert.match((await inspection.registry.execute('read_file', { path: join(f.root, 'src', 'public.ts') }, ctx)).content, /status = true/);
  assert.match((await inspection.registry.execute('list_files', { path: f.workspace }, ctx)).content, /evidence.txt/);
  assert.match((await inspection.registry.execute('runtime_snapshot', {}, ctx)).content, /bounded current observation/);
  assert.match((await inspection.registry.execute('agency_brief', {}, ctx)).content, /No open obligations/);
  assert.match((await inspection.registry.execute('work_list', { limit: 5 }, ctx)).content, /No active durable async work/);
  assert.equal(f.snapshots(), 1); assert.deepEqual(f.originalInputs[0], { name: '/api/agency/brief', input: undefined });
  assert.equal(inspection.registry.allowsNativeServerTools(), false);
});

test('credentials, traversal, escaping links, sibling residents, and private application config are refused', async t => {
  const f = await capabilityFixture(t);
  const denied = [join(f.workspace, '.env'), join(f.workspace, 'credentials.json'), join(f.workspace, 'secrets.yaml'), join(f.instanceDir, 'config.yaml'),
    join(f.root, 'outside.txt'), join(f.root, 'instances', 'other', 'evidence.txt'), join(f.root, 'app', 'config', 'providers.json')];
  for (const file of denied) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'PRIVATE_FIXTURE_MUST_NOT_ESCAPE'); }
  symlinkSync(denied[4]!, join(f.workspace, 'escape.txt')); symlinkSync(denied[1]!, join(f.workspace, 'innocent.txt'));
  for (const file of [...denied, join(f.workspace, 'escape.txt'), join(f.workspace, 'innocent.txt'), `${f.workspace}/../config.yaml`, 'relative.txt']) {
    const inspection = f.resolve(); const result = await inspection.registry.execute('read_file', { path: file }, toolContext());
    assertRefused(result); assert.doesNotMatch(result.content, /PRIVATE_FIXTURE_MUST_NOT_ESCAPE/);
    assert.equal(inspection.executionStatus({ terminalStatus: 'complete' } as never), 'failed');
  }
  const listed = await f.resolve().registry.execute('list_files', { path: f.workspace }, toolContext());
  assert.doesNotMatch(listed.content, /credentials|secrets|\.env|escape|innocent/);
});

test('repair, restart, delegation, network and indirect status writes cannot execute', async t => {
  const f = await capabilityFixture(t);
  for (const name of ['shell', 'coding_run', 'spawn_agent', 'cron_update', 'cron_run', 'web_browse', 'contact_owner', 'write_file', 'worker_run']) {
    const inspection = f.resolve(); assertRefused(await inspection.registry.execute(name, { command: 'restart' }, toolContext()));
    assert.equal(inspection.executionStatus({ terminalStatus: 'complete' } as never), 'failed');
  }
  for (const [name, args] of [['agency_brief', { surfacedObligationIds: ['forged'] }], ['runtime_snapshot', { command: 'env' }],
    ['cron_list', { show_disabled: true, action: 'delete' }], ['work_list', { limit: 1000 }], ['read_file', { path: join(f.workspace, 'evidence.txt'), content: 'write' }]] as const) {
    const inspection = f.resolve(); assertRefused(await inspection.registry.execute(name, args, f.context()));
    assertRefused(await inspection.registry.execute('runtime_snapshot', {}, toolContext()));
  }
  assert.equal(f.dangerous(), 0); assert.equal(f.originalInputs.length, 0); assert.equal(f.snapshots(), 0);
});

test('inspection has a twelve-call budget and bounded file/results sizes', async t => {
  const f = await capabilityFixture(t); const inspection = f.resolve();
  for (let i = 0; i < 12; i++) assert.equal((await inspection.registry.execute('runtime_snapshot', {}, toolContext())).is_error, undefined);
  assertRefused(await inspection.registry.execute('runtime_snapshot', {}, toolContext())); assert.equal(f.snapshots(), 12);
  writeFileSync(join(f.workspace, 'large.txt'), 'x'.repeat(128001));
  const large = await f.resolve().registry.execute('read_file', { path: join(f.workspace, 'large.txt') }, toolContext()); assert.equal(large.is_error, true); assert.ok(large.content.length < 500);
  writeFileSync(join(f.workspace, 'bounded.txt'), 'x'.repeat(50000));
  const bounded = await f.resolve().registry.execute('read_file', { path: join(f.workspace, 'bounded.txt') }, toolContext()); assert.ok(bounded.content.length < 24100); assert.match(bounded.content, /truncated/);
});

test('inspection time budget refuses subsequent tool execution before reading evidence', async t => {
  const f = await capabilityFixture(t), now = Date.now, started = now();
  try {
    Date.now = () => started;
    const inspection = f.resolve();
    Date.now = () => started + 180001;
    assertRefused(await inspection.registry.execute('runtime_snapshot', {}, toolContext()));
    assert.equal(f.snapshots(), 0);
  } finally { Date.now = now; }
});

test('actual AgentLoop uses the per-turn inspection registry for provider tool execution and persists refusals', async t => {
  const f = await capabilityFixture(t), inspection = f.resolve();
  const previousFetch = globalThis.fetch, previousKey = process.env.XAI_API_KEY, previousRoot = process.env.HOME23_ROOT;
  process.env.XAI_API_KEY = 'fixture-key'; process.env.HOME23_ROOT = f.root;
  t.after(() => { globalThis.fetch = previousFetch; if (previousKey === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = previousKey;
    if (previousRoot === undefined) delete process.env.HOME23_ROOT; else process.env.HOME23_ROOT = previousRoot; });
  const agent = new AgentLoop({ apiKey: 'fixture-key', model: 'grok-fixture', provider: 'xai', registry: f.registry,
    history: new ConversationHistory(join(f.root, 'conversations'), 100000, 'fixture'),
    contextManager: { getSystemPrompt: () => 'fixture', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    toolContext: { brainOperations: { withActivityHandler() { return this; } } } as never, workspacePath: f.workspace });
  let requestCount = 0; const events: any[] = [], sentTools: string[][] = [];
  globalThis.fetch = (async (_url, init) => {
    const sent = JSON.parse(String(init?.body)); sentTools.push((sent.tools ?? []).map((tool: any) => tool.name ?? tool.type));
    requestCount++;
    const name = requestCount === 1 ? 'runtime_snapshot' : 'shell';
    const body = [{ type: 'response.output_item.done', item: { type: 'function_call', call_id: `call-${requestCount}`, name, arguments: '{}' } },
      { type: 'response.completed', response: { status: 'completed' } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const started = await agent.runWithTurn('inspection:agenda-inspection-fixture', inspection.mission,
    { ...inspection.turnOptions, registry: inspection.registry, onEvent: event => events.push(event) });
  let terminal: any; try { terminal = await started.response; } catch { terminal = { terminalStatus: 'error' }; }
  assert.equal(f.snapshots(), 1); assert.equal(f.dangerous(), 0); assert.equal(requestCount, 2);
  assert.ok(sentTools.every(tools => !tools.includes('shell') && !tools.includes('web_search') && tools.includes('runtime_snapshot')));
  assert.equal(inspection.executionStatus(terminal), 'failed');
  assert.ok(events.some(event => event.type === 'tool_result' && event.success === false && String(event.exactResult).includes(INSPECTION_AUTHORITY_REFUSED)));
  const journal = readFileSync(join(f.root, 'conversations', 'fixture__inspection_agenda-inspection-fixture.jsonl'), 'utf8');
  assert.match(journal, /inspection_authority_refused/); assert.match(journal, new RegExp(started.turnId));
});
