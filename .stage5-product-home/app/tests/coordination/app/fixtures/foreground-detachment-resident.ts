/** Separate real resident process. Only provider output and external tool effects are deterministic. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgentLoop } from '../../../../src/agent/loop.js';
import { ConversationHistory } from '../../../../src/agent/history.js';
import { ToolRegistry } from '../../../../src/agent/tools/index.js';
import type { ToolContext } from '../../../../src/agent/types.js';
import { startResidentCoordinationHarness } from '../../../../src/coordination-adapter/harness-runtime.js';

assert.equal(process.env.HOME23_COORDINATION_DB_PATH, undefined);
assert.equal(process.env.HOME23_COORDINATION_CAPABILITY_TOKEN, undefined);
const root = process.env.TEST_RESIDENT_ROOT!;
const slug = process.env.HOME23_AGENT!;
const releases = new Map<string, () => void>();
let modelCalls = 0;
const model = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const part of req) chunks.push(Buffer.from(part));
  const body = JSON.parse(Buffer.concat(chunks).toString());
  modelCalls++;
  const text = String(body.messages.findLast((m: { role: string }) => m.role === 'user')?.content ?? '');
  const toolReturned = body.messages.at(-1)?.role === 'tool';
  const latest = text.split('\n').at(-1)!;
  const label = latest.match(/substantial-[a-z]+/)?.[0] ?? 'substantial-one';
  const message = latest.includes('substantial-') && !text.includes('owner-result contract') && !toolReturned
    ? { role: 'assistant', content: null, tool_calls: [{ id: `selected-${slug}-${label}`, type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ task: label, sentinel: `${slug}-exact-arguments` }) } }] }
    : { role: 'assistant', content: text.includes('owner-result contract') ? `${slug}: the substantial assignment finished exactly once.` : toolReturned ? 'I started a separate Working Thread.' : `${slug}: independent answer.` };
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
});
await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${(model.address() as {port:number}).port}/v1`;
const registry = new ToolRegistry();
registry.register({ name: 'spawn_agent', description: 'Run one substantial assignment', input_schema: { type: 'object', properties: { task: { type: 'string' }, sentinel: { type: 'string' } }, required: ['task','sentinel'] }, execute: async (args, ctx) => {
  assert.ok(ctx.coordinationWorkDestination, 'exact execution must have canonical Work lineage');
  ctx.onEvent?.({ type: 'thinking', content: 'Checking the selected assignment while conversation remains available.', provenance: 'agent_authored_explanation', sourceEventType: 'fixture.progress' });
  ctx.onEvent?.({ type: 'subagent_start', subagentId: `${slug}-hidden-helper`, task: String(args.task), parentToolCallId: ctx.parentToolCallId });
  process.send?.({ type: 'executed', slug, args, destination: ctx.coordinationWorkDestination, chatId: ctx.chatId, pid: process.pid });
  await new Promise<void>((resolve, reject) => {
    releases.set(String(args.task), resolve);
    ctx.abortSignal?.addEventListener('abort', () => { process.send?.({ type: 'aborted', task: args.task }); reject(new Error('executor aborted')); }, { once: true });
  });
  ctx.onEvent?.({ type: 'subagent_result', subagentId: `${slug}-hidden-helper`, task: String(args.task), result: 'Verified the assignment.', success: true, parentToolCallId: ctx.parentToolCallId });
  return { content: `${slug}: finished ${String(args.task)} exactly once.` };
} });
const history = new ConversationHistory(join(root, 'history'), 400_000, slug);
mkdirSync(join(root, 'workspace'), { recursive: true });
let harness: Awaited<ReturnType<typeof startResidentCoordinationHarness>>;
const context = { agentName: slug, residentBinding: slug,
  brainOperations: { searchContext: async () => ({ results: [], sourceEvidence: { sourceHealth: 'healthy', matchOutcome: 'no_match' } }) },
  onForegroundDetachRequired: async (request: Parameters<NonNullable<ToolContext['onForegroundDetachRequired']>>[0]) => {
    const ack = await harness!.admitForegroundDetachment(request).catch(error => { process.send?.({ type: 'admission-error', message: String(error) }); throw error; });
    process.send?.({ type: 'admitted', ack });
    return { created: true as const, handle: { workId: ack.workId } };
  },
} as unknown as ToolContext;
const agent = new AgentLoop({ apiKey: 'test', model: 'fixture-local-model', provider: 'ollama-local', registry,
  contextManager: { getSystemPrompt: () => 'Fixture resident', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
  history, toolContext: context, workspacePath: join(root, 'workspace') });
context.runAgentLoop = async (_system, text, _tools, childContext, options) => {
  assert.ok(options?.registry);
  assert.equal(options.registry.getOpenAITools().length, 0);
  const synthesis = new AgentLoop({ apiKey: 'test', model: 'fixture-local-model', provider: 'ollama-local', registry: options.registry,
    contextManager: { getSystemPrompt: () => 'Summarize evidence', getPromptSourceInfo: () => ({ loadedFiles: [] }) } as never,
    history, toolContext: childContext, workspacePath: join(root, 'workspace') });
  const turn = await synthesis.runWithTurn(`${childContext.chatId}:synthesis`, text, { coordinationOrigin: childContext.turnRuntime?.coordinationOrigin, coordinationWorkDestination: childContext.coordinationWorkDestination });
  return turn.response;
};
harness = await startResidentCoordinationHarness({ agent, history, exactToolRuntime: { registry, context } });
process.on('message', (value: { type: string; task?: string }) => {
  if (value.type === 'release') releases.get(value.task!)?.();
  if (value.type === 'stats') process.send?.({ type: 'stats', modelCalls });
  if (value.type === 'close') void (async () => { for (const release of releases.values()) release(); await harness?.close(); model.closeAllConnections(); model.close(); process.exit(0); })();
});
process.send?.({ type: 'ready', pid: process.pid, noDatabasePath: true, noCapabilityToken: true });
