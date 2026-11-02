import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventLedger } from '../../src/agent/event-ledger.js';
import { readPriorCanonicalDeliveredReply, observeDeliveredConduct } from '../../src/agent/delivered-conversation-observation.js';
import { createLearningDecisionEvidenceReader, verifiedDeliveredConductObservations } from '../../src/agent/learning-decision-evidence.js';
import { assessDeliveredConversationFeedback } from '../../src/agent/conversation-feedback-runtime.js';
import { validateConversationFeedbackClaim } from '../../src/agent/conversation-feedback-contract.js';

// Reduced, anonymous regression text; the original exchange stays in private evidence.
const feedback='This is a broken record. Literally the same diagnosis every time.';
const axes={engagement:'analyze',initiative:'offer_next_step',continuity:'grounded_connection',depth:'developed'} as const;
async function fixture(t: {after(fn:()=>void):void}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'home23-delivered-conduct-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const brain=path.join(root,'brain'),ledger=new EventLedger(brain),ledgerPath=path.join(brain,'event-ledger.jsonl'),contactPath=path.join(root,'contact.jsonl');
 fs.writeFileSync(ledgerPath,'');
 const contact=(id:string,role:string,content:string,seq:number,extra={})=>({schema:'home23.resident.contact.v1',contactId:`message:${id}`,sourceRef:`coordination.message:${id}`,
  sourceSequence:seq,channelId:'channel',session:'coordination:channel',conversationId:'conversation',messageId:id,actor:{principalId:role==='user'?'owner':'resident',kind:role==='user'?'owner':'bot'},voice:role==='user'?'jtr':'self',role,content,channelKind:'direct',ts:`2026-11-02T14:${seq===1?'12:52':seq===2?'30:33':'33:54'}.000Z`,...extra});
 const contacts=[contact('request','user','Spend some time investigating why Home23 falls short.',1),contact('report','assistant','My diagnosis: persistence describes activity but does not own outcomes. The report proposes another architecture and verification plan.',2,{replyToMessageId:'request',worker:true}),contact('feedback','user',feedback,3)];
 const write=()=>fs.writeFileSync(contactPath,contacts.map(c=>JSON.stringify(c)).join('\n')+'\n');write();
 const read=()=>readPriorCanonicalDeliveredReply({ledgerPath,contactPath,conversationRef:'coordination:channel',currentMessageId:'feedback'});
 return{root,ledger,ledgerPath,contactPath,contacts,write,read};
}
test('ordinary async delivered reply can acquire explicit retrospective conduct evidence with exact canonical delivery',async t=>{
 const f=await fixture(t),prior=await f.read();assert.ok(prior);assert.equal(prior.selected,null);assert.equal(prior.originalOwnerText,f.contacts[0]!.content);
 const observed=observeDeliveredConduct({prior,situation:'reflection',axes,eventLedger:f.ledger,chatId:'native-feedback'});
 const rows=fs.readFileSync(f.ledgerPath,'utf8').trim().split('\n').map(s=>JSON.parse(s));
 assert.equal(rows.some(r=>r.event_type==='ConversationReplySelected'),false);assert.equal(rows.filter(r=>r.event_type==='LearningDecisionObserved').length,4);
 assert.equal(verifiedDeliveredConductObservations(rows).length,1);
 const reader=createLearningDecisionEvidenceReader(f.ledgerPath,{contactPath:f.contactPath});const evidence=await reader(observed.selection.decisions);
 for(const d of observed.selection.decisions){const e=evidence[d.decisionId]!;assert.equal(e.status,'verified');if(e.status==='verified'){assert.equal(e.behavior.kind,'delivered-conversation-observation');assert.equal(e.delivery.status,'observed');}}
 const before=fs.readFileSync(f.ledgerPath);const retried=await f.read();assert.ok(retried?.selected);
 assert.equal(retried.selected.selection.annotationSource,'delivered-reply-observation');
 assert.equal(retried.selected.selection.selectionId,observed.selection.selectionId);
 // Re-emitting exact retained annotation is an idempotent source retry.
 observeDeliveredConduct({prior:retried,situation:'reflection',axes,eventLedger:f.ledger,chatId:'different-retry-turn'});
 assert.deepEqual(fs.readFileSync(f.ledgerPath),before);
 assert.throws(()=>observeDeliveredConduct({prior:retried,situation:'sharing',axes,eventLedger:f.ledger,chatId:'different'}),/conflict/);
});
test('independent assessor handles real repeated-diagnosis feedback and reports source admission separately from Seed application',async t=>{
 const f=await fixture(t);let applied=0;const controller=new AbortController();
 await assessDeliveredConversationFeedback({context:{chatId:'native-feedback',authenticatedUserMessage:{chatId:'native-feedback',messageRef:'turn:feedback:user',text:feedback}} as any,
 runtime:{turnId:'turn:feedback',contextPurpose:'conversation',coordinationOrigin:{channelId:'channel',originMessageId:'feedback'},signal:controller.signal} as any,eventLedger:f.ledger,readPrior:f.read,
 generate:async request=>{assert.ok(request.system!.length<5000);assert.equal(request.requireComplete,true);return JSON.stringify({schema:'home23.conversation-feedback-assessment.v1',observed:{situation:'reflection',axes},feedback:[{axis:'engagement',quote:'Literally the same diagnosis every time.',direction:'attenuate',standing:false,conditions:[],supersedes:[]}]});},
 apply:({proposals,prior,owner})=>{applied++;const p=proposals[0] as any;assert.equal(p.decisionId,`${prior.selection.selectionId}:engagement`);assert.equal(validateConversationFeedbackClaim(owner.text,{...p,axis:'engagement',value:'analyze',situation:'reflection'},prior.selection.reply),null);return{status:'source_recorded',entryId:'source-entry',projected:1,pending:0,seedApplication:'not_yet_confirmed'};}});
 assert.equal(applied,1);const rows=fs.readFileSync(f.ledgerPath,'utf8').trim().split('\n').map(s=>JSON.parse(s));const receipt=rows.find(r=>r.event_type==='ConversationFeedbackProcessed');assert.equal(receipt.payload.status,'source_recorded');assert.equal(receipt.payload.seedApplication,'not_yet_confirmed');assert.equal(receipt.payload.assessmentIndependent,true);
});
test('feedback failure and no-feedback outcomes remain explicit and do not create observations',async t=>{
 const f=await fixture(t);const args={context:{chatId:'native-feedback',authenticatedUserMessage:{chatId:'native-feedback',messageRef:'turn:feedback:user',text:feedback}} as any,
 runtime:{turnId:'turn:feedback',contextPurpose:'conversation',coordinationOrigin:{channelId:'channel',originMessageId:'feedback'},signal:new AbortController().signal} as any,eventLedger:f.ledger,readPrior:f.read,apply:()=>{throw Error('must not apply');}};
 await assessDeliveredConversationFeedback({...args,generate:async()=>{throw Error('private token must never be logged');}});
 await assessDeliveredConversationFeedback({...args,generate:async()=>JSON.stringify({schema:'home23.conversation-feedback-assessment.v1',observed:null,feedback:[]})});
 const raw=fs.readFileSync(f.ledgerPath,'utf8');assert.equal(raw.includes('private token'),false);const rows=raw.trim().split('\n').map(s=>JSON.parse(s));assert.deepEqual(rows.map(r=>r.payload.status),['deferred','no_feedback']);assert.equal(rows.some(r=>r.event_type==='ConversationConductObserved'),false);
});
test('missing, mismatched, ambiguous, future or superseding canonical delivery refuses ordinary attribution',async t=>{
 const f=await fixture(t),original={...f.contacts[1]!};
 f.contacts[1]={...original,role:'user'};f.write();assert.equal(await f.read(),null);
 f.contacts[1]={...original,replyToMessageId:'missing'};f.write();assert.equal(await f.read(),null);
 f.contacts[1]={...original,voice:'other'};f.write();assert.equal(await f.read(),null);
 f.contacts[1]={...original,ts:'2026-11-02T15:00:00.000Z'};f.write();assert.equal(await f.read(),null);
 f.contacts[1]=original;f.contacts.push({...original});f.write();assert.equal(await f.read(),null);
});
test('repetition critique is grounded to actual diagnostic reply and preserves negation',()=>{
 const base={decisionId:'observed:engagement',axis:'engagement',value:'analyze',situation:'reflection',direction:'attenuate',standing:false,conditions:[],supersedes:[]} as const;
 for(const quote of ['Literally the same diagnosis every time.'])assert.equal(validateConversationFeedbackClaim(feedback,{...base,conditions:[],supersedes:[],quote},'The diagnosis is another architecture plan.'),null);
 assert.equal(validateConversationFeedbackClaim('This is a broken record.',{...base,conditions:[],supersedes:[],quote:'This is a broken record.'},'The diagnosis is another architecture plan.'),null);
 for(const quote of ['This is not a broken record.','This was not the same diagnosis.',"I don't mind the same diagnosis.",'This is not just the same diagnosis.','The same diagnosis is fine with me.','Two doctors gave the same diagnosis.','The same diagnosis was expected.','That album is a broken record.'])assert.ok(validateConversationFeedbackClaim(quote,{...base,conditions:[],supersedes:[],quote},'The diagnosis is another architecture plan.'));
 assert.ok(validateConversationFeedbackClaim('This is a broken record.',{...base,conditions:[],supersedes:[],quote:'This is a broken record.'},'Nice weather today.'));
});

import { RelationshipLedger } from '../../src/agent/relationship-ledger.js';
import { applyConversationFeedback } from '../../src/agent/conversation-feedback.js';
import { SeedProcess } from '../../substrate/src/seed.js';
import { EventLedgerTailAdapter } from '../../substrate/src/adapters/event-ledger-tail.js';
import { readSeedLearning } from '../../shared/seed-learning.cjs';
import { selectConversationReply } from '../../src/agent/conversation-judgment.js';

for(const dimensionCount of [1,4])test(`ordinary delivered feedback changes the next fixed reply through real Seed (${dimensionCount} axes), even with reversed adapter order`,async t=>{
 const f=await fixture(t);const ownerWords=dimensionCount===1?feedback:'Your diagnosis was unhelpful. Stop giving advice. Stop bringing up our history. Your reply was too long.';
 f.contacts[2]!.content=ownerWords;f.write();
 const seedDir=path.join(f.root,'seed');let seed=SeedProcess.initialize(seedDir);seed.checkpoint();
 let authorizations=0;const owner={chatId:'native-feedback',messageRef:'turn:feedback:user',text:ownerWords};
 const relationshipLedger=new RelationshipLedger(path.join(f.root,'brain'),{validateCorrectionIngress:i=>{authorizations++;return i.chatId===owner.chatId&&i.messageRef===owner.messageRef&&i.userText===owner.text;}});
 const interpretations=dimensionCount===1?[{axis:'engagement',quote:'Literally the same diagnosis every time.',direction:'attenuate',standing:false,conditions:[],supersedes:[]}]:[
  {axis:'engagement',quote:'Your diagnosis was unhelpful.',direction:'attenuate',standing:false,conditions:[],supersedes:[]},
  {axis:'initiative',quote:'Stop giving advice.',direction:'attenuate',standing:true,conditions:[],supersedes:[]},
  {axis:'continuity',quote:'Stop bringing up our history.',direction:'attenuate',standing:true,conditions:[],supersedes:[]},
  {axis:'depth',quote:'Your reply was too long.',direction:'attenuate',standing:false,conditions:[],supersedes:[]},
 ];
 const assess=(messageRef=owner.messageRef)=>assessDeliveredConversationFeedback({context:{chatId:owner.chatId,authenticatedUserMessage:{...owner,messageRef}} as any,
  runtime:{turnId:'turn:feedback',contextPurpose:'conversation',coordinationOrigin:{channelId:'channel',originMessageId:'feedback'},signal:new AbortController().signal} as any,
  eventLedger:f.ledger,readPrior:f.read,
  generate:async request=>JSON.stringify({schema:'home23.conversation-feedback-assessment.v1',observed:JSON.parse(request.prompt!).priorDimensions?null:{situation:'reflection',axes},feedback:interpretations}),
  apply:input=>applyConversationFeedback({...input,relationshipLedger,seedStateDir:seedDir})});
 await assess();
 assert.equal(relationshipLedger.listEntries().length,1);
 const entry=relationshipLedger.listEntries()[0]!;assert.equal(entry.learning_batch!.length,dimensionCount);assert.ok(entry.learning_batch!.every(l=>l.cellId===undefined));
 const sourcesBefore=fs.readFileSync(path.join(f.root,'brain','relationship-ledger.events.jsonl'));
 const teaching=new EventLedgerTailAdapter({sourcePath:path.join(f.root,'brain','relationship-ledger.events.jsonl'),sourceType:'relationship-ledger',cursorDir:path.join(f.root,'relationship-cursor'),fromEnd:false});
 for(const event of teaching.pullSync()){seed.transition(event);teaching.commit(event.endOffset);}
 seed.checkpoint();assert.equal(readSeedLearning(seedDir).lessons.filter(l=>l.scope.startsWith('foreground.conduct.')).length,0,'source admission alone does not prove applied learning');
 const runtime=new EventLedgerTailAdapter({sourcePath:f.ledgerPath,cursorDir:path.join(f.root,'runtime-cursor'),fromEnd:false});
 for(const event of runtime.pullSync()){seed.transition(event);runtime.commit(event.endOffset);}
 seed.checkpoint();seed=SeedProcess.restore(seedDir);const learned=readSeedLearning(seedDir);
 assert.equal(learned.available,true);assert.equal(learned.lessons.filter(l=>l.scope.startsWith('foreground.conduct.')).length,dimensionCount);
 const proposed={schema:'home23.conversation-proposal.v1' as const,route:'conversation' as const,situation:'reflection' as const,feedback:[],candidates:[
  {id:'a',reply:'Here is my diagnosis and another architecture plan.',axes},
  {id:'b',reply:'It sounds exhausting to keep carrying this. I can stay with that for a moment.',axes:{engagement:'acknowledge',initiative:'stay_with',continuity:'present_only',depth:'brief'} as const},
 ]};
 const selected=selectConversationReply(proposed,learned);assert.equal(selected.selected.id,'b');assert.equal(selected.counterfactual.selectedId,'a');assert.equal(selected.counterfactual.changed,true);
 await assess('turn:retry:user');assert.equal(authorizations,1);assert.equal(relationshipLedger.listEntries().length,1);assert.deepEqual(fs.readFileSync(path.join(f.root,'brain','relationship-ledger.events.jsonl')),sourcesBefore);
 const text=fs.readFileSync(f.ledgerPath,'utf8');assert.equal(text.split('"event_type":"ConversationConductObserved"').length-1,1);assert.equal(text.split('"event_type":"LearningDecisionObserved"').length-1,4);
});

test('an interrupted ordinary observation resumes its exact first receipt and missing witnesses',async t=>{
 const f=await fixture(t),prior=await f.read();assert.ok(prior);
 observeDeliveredConduct({prior,situation:'reflection',axes,eventLedger:f.ledger,chatId:'first-assessment'});
 const rows=fs.readFileSync(f.ledgerPath,'utf8').trim().split('\n');fs.writeFileSync(f.ledgerPath,rows.slice(0,3).join('\n')+'\n');
 const partial=await f.read();assert.ok(partial?.retainedObservation);assert.equal(partial.selected,null);
 observeDeliveredConduct({prior:partial,situation:'reflection',axes,eventLedger:f.ledger,chatId:'retry-assessment'});
 assert.deepEqual(fs.readFileSync(f.ledgerPath,'utf8').trim().split('\n'),rows);
});
test('cancelled or steered assessment cannot create teaching or observation',async t=>{
 const f=await fixture(t),ac=new AbortController();let applied=0;
 const args={context:{chatId:'native-feedback',authenticatedUserMessage:{chatId:'native-feedback',messageRef:'turn:user',text:feedback}} as any,
 runtime:{turnId:'turn:feedback',contextPurpose:'conversation',coordinationOrigin:{channelId:'channel',originMessageId:'feedback'},signal:ac.signal} as any,
 eventLedger:f.ledger,readPrior:f.read,apply:()=>{applied++;return{status:'source_recorded' as const};}};
 await assert.rejects(assessDeliveredConversationFeedback({...args,generate:async()=>{ac.abort();return JSON.stringify({schema:'home23.conversation-feedback-assessment.v1',observed:{situation:'reflection',axes},feedback:[{axis:'engagement',quote:'Literally the same diagnosis every time.',direction:'attenuate',standing:false}]});}}),/abort/i);
 assert.equal(fs.readFileSync(f.ledgerPath,'utf8'),'');assert.equal(applied,0);
 await assessDeliveredConversationFeedback({...args,runtime:{...args.runtime,signal:new AbortController().signal},stillCurrent:()=>false,generate:async()=>{throw Error('must not generate after steer');}});
 const receipt=JSON.parse(fs.readFileSync(f.ledgerPath,'utf8').trim());assert.equal(receipt.payload.reason,'turn_steered');assert.equal(applied,0);
});
