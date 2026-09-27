import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Home23Adapter } from '../../src/channels/home23.js';
import { createOwnerOutreachSender, createOwnerOutreachHandler } from '../../src/channels/owner-outreach.js';
import { contactOwnerTool } from '../../src/agent/tools/owner-outreach.js';
import { createToolRegistry } from '../../src/agent/tools/index.js';
import type { ToolContext } from '../../src/agent/types.js';

test('contact_owner uses durable canonical delivery, retries the same message after restart, and never claims phone delivery', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'owner-outreach-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  let available = false; const committed = new Map<string,string>(); let attempts = 0;
  const deliver = async (message: { messageId:string;text:string }) => { attempts++; if (!available) throw new Error('Core offline'); committed.set(message.messageId,message.text); };
  const first = new Home23Adapter(dir, deliver);
  const ctx = { agentName: 'jerry', chatId: 'cron:curiosity', parentToolCallId: 'call-1', contactOwner: createOwnerOutreachSender(first) } as unknown as ToolContext;
  const input = { text: 'That music question connects to something you told me yesterday. Want to explore it?', reason: 'A remembered conversation made this connection worth sharing now.', evidence_refs: ['contact:one'] };
  const queued = JSON.parse((await contactOwnerTool.execute(input, ctx)).content);
  assert.equal(queued.status, 'queued'); assert.equal(queued.notification, 'not_confirmed');
  assert.equal(committed.size, 0); assert.equal(queued.messageIds.length, 1);
  available = true;
  const restarted = new Home23Adapter(dir, deliver);
  await restarted.flush();
  ctx.contactOwner = createOwnerOutreachSender(restarted);
  const result = JSON.parse((await contactOwnerTool.execute(input,ctx)).content);
  assert.equal(result.status, 'committed'); assert.equal(result.notification, 'not_confirmed');
  assert.deepEqual(result.messageIds,queued.messageIds); assert.equal(committed.size,1); assert.equal(attempts,2);
  assert.ok(createToolRegistry().get('contact_owner'), 'the resident can actually discover and call the tool');
});

test('no configured owner path and invalid messages produce explicit failures', async () => {
  assert.equal((await contactOwnerTool.execute({text:'hello',reason:'Worth sharing now'}, {} as ToolContext)).is_error,true);
  const send = createOwnerOutreachSender({ send: async () => { throw new Error('must not send invalid input'); } });
  await assert.rejects(send({ text:'hello',reason:'',deliveryId:'x' }),/requires/);
  await assert.rejects(send({ text:'hello',reason:'A relevant event happened',deliveryId:'x',channelId:'someone else' } as any),/requires/);
});

test('engine outreach HTTP boundary authenticates, validates and returns only actual transport receipt', async () => {
  const sent: unknown[] = [];
  const handler = createOwnerOutreachHandler({token:'local-secret',send:async input=>{sent.push(input);return {status:'queued',notification:'not_confirmed'};}});
  const invoke = async (authorization:string|undefined,body:unknown) => {
    let status=200; let result:unknown;
    const res={status(n:number){status=n;return {json(value:unknown){result=value;}};},json(value:unknown){result=value;}};
    await handler({headers:{authorization},body},res); return {status,result};
  };
  const body={text:'A relevant question for you',reason:'An actual conversation raised a useful connection',deliveryId:'thought:1'};
  assert.equal((await invoke(undefined,body)).status,401);
  assert.equal((await invoke('Bearer local-secret',{...body,channelId:'other'})).status,400);
  assert.deepEqual(await invoke('Bearer local-secret',body),{status:200,result:{status:'queued',notification:'not_confirmed'}});
  assert.equal(sent.length,1);
});
