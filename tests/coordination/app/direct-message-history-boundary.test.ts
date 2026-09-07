import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteDirectMessageContext } from '../../../src/coordination/app/direct-message-context.js';
import { createWorkService } from '../../../src/coordination/work/index.js';
import { AT, BOT_ID, CHANNEL_ID, MESSAGE_ID, OWNER_ID, M11TestDatabase, createFixtureIdGenerator, fixtureId } from '../work/test-fixture.js';

for (const resident of ['jerry', 'forrest']) {
 for (const oversized of [false,true]) {
  test(`${resident} ${oversized ? "bounded large history" : "normal history"}: current owner instruction stays separate from bounded history through durable recovery`, async t => {
    const database = M11TestDatabase.temporary();
    t.after(() => database.close());
    const conversationId = 'cnv_0198d95f-6c00-7000-8000-000000000901';
    database.raw.prepare('INSERT INTO conversation_handles (id,channel_id,created_at) VALUES (?,?,?)').run(conversationId,CHANNEL_ID,AT);
    database.raw.prepare('UPDATE bots SET resident_binding=?,conversation_id=? WHERE id=?').run(resident,conversationId,BOT_ID);
    const oldAssignment = 'Run a separate reliability review with spawn_agent; report its result once.' + (oversized ? 'x'.repeat(70_000) : '');
    const texts = [oldAssignment, 'The separate assignment is working.', `While that separate assignment continues, answer only: ${resident} conversation available.`, 'Future owner request must not leak into this snapshot.'];
    for (const [i,text] of texts.entries()) {
      const n=i+2;
      database.raw.prepare(`INSERT INTO messages (id,channel_id,channel_sequence,author_principal_id,author_kind,author_display_name,kind,body_text,stored_visibility,created_at) VALUES (?,?,?,?,?,?,'text',?,'visible',?)`).run(fixtureId('message',n),CHANNEL_ID,n,i===1?BOT_ID:OWNER_ID,i===1?'bot':'owner',i===1?resident:'Owner',text,AT);
      database.raw.prepare(`INSERT INTO events (id,schema_version,type,durability,aggregate_kind,aggregate_id,aggregate_version,channel_id,actor_principal_id,request_id,correlation_id,payload_json,payload_digest,created_at) SELECT ?,schema_version,type,durability,aggregate_kind,?,aggregate_version,channel_id,?,request_id,correlation_id,payload_json,payload_digest,created_at FROM events WHERE aggregate_id=?`).run(fixtureId('event',n),fixtureId('message',n),i===1?BOT_ID:OWNER_ID,MESSAGE_ID);
    }
    const page = database.readAll<{id:string;sequence:number;text:string;createdAt:string;principalId:string;displayName:string}>('SELECT id,channel_sequence AS sequence,body_text AS text,created_at AS createdAt,author_principal_id AS principalId,author_display_name AS displayName FROM messages ORDER BY channel_sequence').map(row=>({...row,author:{principalId:row.principalId,displayName:row.displayName},attachments:[]}));
    const context = new SqliteDirectMessageContext(database,{listMessages:async()=>({messages:page})});
    const origin = page.find(message=>message.sequence===4)!;
    const identity = {requestId:fixtureId('request',50),correlationId:fixtureId('correlation',50)};
    const prepared = await context.prepare({context:{principalId:OWNER_ID,...identity},channelId:CHANNEL_ID,originMessage:origin,attachmentIds:[]});
    assert.equal(prepared.instruction,texts[2]);
    assert.deepEqual(prepared.historyBackfill.map(entry=>({role:entry.role,text:entry.text})),oversized ? [{role:'user',text:'not exposed'},{role:'assistant',text:texts[1]}] : [{role:'user',text:'not exposed'},{role:'user',text:oldAssignment},{role:'assistant',text:texts[1]}]);
    assert(Buffer.byteLength(JSON.stringify(prepared.historyBackfill),'utf8')<=65536);
    assert(!prepared.historyBackfill.some(entry=>entry.messageId===origin.id));
    const work = createWorkService({database,generateId:createFixtureIdGenerator(),now:()=>new Date(AT)}).create({principalId:OWNER_ID,targetPrincipalId:BOT_ID,channelId:CHANNEL_ID,originMessageId:origin.id,roundId:null,kind:'resident_turn',idempotencyKey:`history-boundary-${resident}`,manifest:prepared.manifest,maxAutomaticOffers:1,...identity}).work;
    database.reopen();
    const restored = await context.recover(work);
    assert.equal(restored.prepared.instruction,texts[2]);
    assert.deepEqual(restored.prepared.historyBackfill,prepared.historyBackfill);
    assert.deepEqual(restored.prepared.manifest,prepared.manifest);
  });
}
}
