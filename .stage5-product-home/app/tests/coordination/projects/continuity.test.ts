import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {ProjectContinuityStore,projectContinuityPrompt} from '../../../src/coordination/projects/continuity.js';
import {searchHelperMemory} from '../../../src/coordination/app/helper-services.js';
import {createChannelService} from '../../../src/coordination/channels/service.js';
import {createMessagingFixture,ownerContext,residentContext} from '../messaging/test-fixture.js';

test('project notes survive a new store, are shared by participants, and reject stale edits',async t=>{
 const fixture=await createMessagingFixture();t.after(fixture.close);
 const root=mkdtempSync('/private/tmp/home23-project-');t.after(()=>rmSync(root,{recursive:true,force:true}));
 const channels=createChannelService({repository:fixture.repository,participantDirectory:fixture.directory,cursorSigningKey:Buffer.alloc(32,23),now:()=>fixture.clock.value});
 const channel=(await channels.createGroupChannel({context:ownerContext(881),idempotencyKey:'project-continuity-create',title:'Garden',purpose:'Keep the garden project together',memberBotIds:[fixture.bots.jerry.id,fixture.bots.forrest.id],pinned:false,responderPolicy:{mode:'mentions_only',coordinatorBotId:null,responseOrder:'sequential',maxBotTurns:4}})).channel;
 const create=()=>new ProjectContinuityStore(join(root,'bots'),(context,channelId)=>channels.getChannel({context,channelId}),async()=>false);
 let store=create();const initial=await store.read(ownerContext(882),channel.id);
 const doc=initial.documents.find(d=>d.name==='MEMORY.md')!;
 await store.write(ownerContext(883),{channelId:channel.id,name:doc.name,text:'The greenhouse watering valve is blue. Source: owner decision.',expectedRevision:doc.revision});
 store=create();const forrest=residentContext(fixture.bots.forrest,'forrest',884);
 const resumed=await store.read(forrest,channel.id);
 assert.match(resumed.documents.find(d=>d.name===doc.name)!.text,/greenhouse/);
 const results=await Promise.allSettled(['Forrest update','Jerry update'].map(text=>store.write(forrest,{channelId:channel.id,name:doc.name,text,expectedRevision:resumed.documents.find(d=>d.name===doc.name)!.revision})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);
 assert.match(readFileSync(join(initial.workspacePath!,'.changes',`${doc.revision}.md`),'utf8'),/# Memory/);
 assert.ok(projectContinuityPrompt({...resumed,documents:[{...doc,text:'x'.repeat(50000)}]}).length<14000);
 const direct=(await channels.createDirectConversation({context:ownerContext(885),idempotencyKey:'project-direct-jerry',memberBotIds:[fixture.bots.jerry.id],pinned:false})).channel;
 assert.equal((await store.read(ownerContext(886),direct.id)).available,false);
 await assert.rejects(store.read(forrest,direct.id));
 // A helper direct workspace retains actual authored memory, with its own root.
 const helperStore=new ProjectContinuityStore(join(root,'bots'),(context,channelId)=>channels.getChannel({context,channelId}),async()=>true);
 const personal=await helperStore.read(ownerContext(887),direct.id);
 const memory=personal.documents.find(d=>d.name==='MEMORY.md')!;
 await helperStore.write(ownerContext(888),{channelId:direct.id,name:memory.name,text:'Personal telescope calibration retained across sessions.',expectedRevision:memory.revision});
 assert.equal(searchHelperMemory(personal.workspacePath!,'telescope',5).results.length,1);
 assert.equal(searchHelperMemory(initial.workspacePath!,'telescope',5).results.length,0);
});
