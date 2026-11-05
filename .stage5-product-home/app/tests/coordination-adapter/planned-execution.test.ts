import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TurnStore } from '../../src/chat/turn-store.js';
import { ConversationHistory } from '../../src/agent/history.js';
import type { ToolContext } from '../../src/agent/types.js';
import type { ToolRegistry } from '../../src/agent/tools/index.js';
import { ResidentTurnUdsServer, ResidentUdsAgentPort } from '../../src/coordination-adapter/resident-uds.js';
import { canonicalToolArguments } from '../../src/coordination-adapter/foreground-detachment-contract.js';
import { createResidentCredential } from '../../src/coordination/resident-protocol/index.js';
import { ResidentUdsClient } from '../../src/coordination/transport/uds/index.js';

for (const resident of ['jerry', 'forrest']) for (const mode of ['complete', 'cancel', 'fail', 'recover', 'interrupted']) test(`${resident} ${mode} exact UDS dispatch executes once after durable start, preserving child lineage`, async t => {
  const root = mkdtempSync(join(tmpdir(), 'h23-exact-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const history = new ConversationHistory(join(root, 'chats'), 400000, resident);
  const origin = { kind: 'coordination' as const, workId: 'wrk_0198d95f-6c00-7000-8000-000000000101', attemptId: 'att_0198d95f-6c00-7000-8000-000000000102', leaseId: 'lea_0198d95f-6c00-7000-8000-000000000103', holderPrincipalId: 'bot_0198d95f-6c00-7000-8000-000000000104', holderInstanceId: `home23-${resident}-harness`, authorityReference: `resident:${resident}`, fencingToken: 1, channelId: 'chn_0198d95f-6c00-7000-8000-000000000105', originMessageId: 'msg_0198d95f-6c00-7000-8000-000000000106', roundId: null };
  const credential = createResidentCredential({ rootKey: Buffer.alloc(32, 22), residentSlug: resident, role: 'resident', instanceId: origin.holderInstanceId, keyVersion: 1 });
  const destination = { parentWorkId: origin.workId, attemptId: origin.attemptId, leaseId: origin.leaseId, fencingToken: origin.fencingToken, targetPrincipalId: origin.holderPrincipalId, residentInstanceId: origin.holderInstanceId, residentBinding: resident, authorityReference: origin.authorityReference, channelId: origin.channelId, originMessageId: origin.originMessageId, conversationId: 'cnv_0198d95f-6c00-7000-8000-000000000107' };
  let starts = 0, executions = 0, durable = false;
  let began!: () => void; const beganPromise = new Promise<void>(resolve => { began = resolve; });
  const registry = { get: () => ({}), async execute(name: string, args: unknown, context: ToolContext) { executions++; assert.equal(starts, 1); assert.equal(name, 'spawn_agent'); assert.deepEqual(args, { task: 'Inspect health', nested: { x: 1 } }); assert.deepEqual(context.coordinationWorkDestination, destination); assert.equal(context.onForegroundDetachRequired, undefined); assert.equal(context.turnRuntime?.coordinationOrigin?.workId, origin.workId); began(); if (mode === 'cancel') await new Promise<void>((_resolve, reject) => context.abortSignal!.addEventListener('abort', () => reject(context.abortSignal!.reason), { once: true })); if (mode === 'fail') return {content:'Inspection failed',is_error:true}; return { content: 'Health inspected; all checks completed.' }; } } as unknown as ToolRegistry;
  const context = { agentName: resident, async runAgentLoop(_a: unknown, _b: unknown, _c: unknown, _d: unknown, options: {registry: ToolRegistry}) { assert.deepEqual(options.registry.getOpenAITools(), []); return { text: 'All health checks completed.' }; } } as unknown as ToolContext;
  const reverse = { async request(request: {path: string}) { assert.equal(durable, true); assert.equal(request.path, '/internal/v1/foreground-detachments/start'); starts++; return {payload:{accepted:true,workId:origin.workId,invocationId:'call-exact'}}; }, async close() {} } as unknown as ResidentUdsClient;
  const server = new ResidentTurnUdsServer({ socketPath: join(root,'r.sock'), serverInstanceId: origin.holderInstanceId, credential, residentSlug:resident, history, coordinationClient:reverse, exactToolRuntime:{registry,context}, agent:{ getModel:()=> 'model', getProvider:()=> 'provider', getReasoningEffort:()=> 'medium', runWithTurn:async()=>{throw Error('Must not re-prompt model to choose a tool');},stop:()=>({stopped:false,chatIds:[]}),isRunning:()=>false} });
  await server.start(); t.after(()=>server.close());
  const client = new ResidentUdsClient({socketPath:join(root,'r.sock'),serverInstanceId:origin.holderInstanceId,credential}); t.after(()=>client.close());
  const port = new ResidentUdsAgentPort({client,residentSlug:resident});
  const events: string[] = [];
  const options = { coordinationOrigin:origin,coordinationWorkDestination:destination, plannedExecution:{kind:'planned_tool' as const,toolName:'spawn_agent',canonicalArgs:{task:'Inspect health',nested:{x:1}},invocationId:'call-exact',executionInstruction:'Inspect health',title:'Health review',recoveryPolicy:'safe_before_start' as const}, coordinationRequest:{requestId:'req_0198d95f-6c00-7000-8000-000000000108',correlationId:'cor_0198d95f-6c00-7000-8000-000000000109'},turnSelection:{modelAlias:null,reasoningEffort:null},onDurableStart:()=>{assert.equal(executions,0);durable=true;},onEvent:(event: {event:{type:string}})=>{events.push(event.event.type);} };
  if (mode === 'recover' || mode === 'interrupted') new TurnStore(history).writeStart('coordination:exact:child', `coord-${origin.workId}`, 'model', 'provider', {coordination_origin:origin});
  if (mode === 'interrupted') { await assert.rejects(port.runWithTurn('coordination:exact:child','execute assigned work',options), /requires coordinator recovery/); assert.equal(executions,0); return; }
  const run=await port.runWithTurn('coordination:exact:child','execute assigned work',{...options,...(mode === 'recover' ? {plannedRecoveryBeforeStart:true as const}: {})});
  if (mode === 'cancel' || mode === 'fail') {
    const failed = assert.rejects(run.response, mode === 'fail' ? /Inspection failed/ : /cancelled/);
    await beganPromise;
    if (mode === 'cancel') { assert.deepEqual(await port.stopExact('coordination:exact:child', origin, 'cor_0198d95f-6c00-7000-8000-000000000112'), {stopped:true}); assert.deepEqual(await port.stopExact('coordination:exact:child', origin, 'cor_0198d95f-6c00-7000-8000-000000000113'), {stopped:true}); }
    await failed; assert.equal(executions,1); return;
  }
  assert.equal((await run.response).text,'All health checks completed.');
  assert.equal(executions,1); assert.equal(starts,1); assert.ok(events.includes('tool_start')); assert.ok(events.includes('tool_result'));
  const replay=await port.runWithTurn('coordination:exact:child','execute assigned work',{...options,onDurableStart:()=>{},coordinationRequest:{requestId:'req_0198d95f-6c00-7000-8000-000000000110',correlationId:'cor_0198d95f-6c00-7000-8000-000000000111'}});
  assert.equal((await replay.response).text,'All health checks completed.'); assert.equal(executions,1);
});

test('canonical arguments reject lossy JSON and excessive nesting', () => {
  for (const value of [{value:undefined},{value:NaN},{value:()=>null},{value:BigInt(1)}]) assert.throws(()=>canonicalToolArguments(value));
  assert.deepEqual(Object.keys(canonicalToolArguments({z:1,a:2})),['a','z']);
});
