import Database from "better-sqlite3";
import { createBotDirectory, SqliteBotDirectoryRepository } from "../bots/index.js";
import { createChannelService, SqliteBotConversationBindingAdapter, SqliteMessagingRepository } from "../channels/index.js";
import { openCoordinationDatabase } from "../db/index.js";
import { generateCoordinationId } from "../ids/index.js";
import { M11MessageProvenanceAuthority } from "../work/index.js";
import { validateInitialAuthorityEpoch } from "../epochs/index.js";
import { HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES } from "./house-resident-attachment-capability-upgrade.js";

export interface JerryBootstrapAuthority { approved:true;kind:"m14-bootstrap";operator:"user_owner";resident:"jerry";legacyWriterAuthoritative:true;coordinationFlagsAllFalse:true }
export interface JerryBootstrapInput { databasePath:string;apply?:boolean;authority?:JerryBootstrapAuthority;serverInstanceId:string;keyVersion:number;now?:()=>Date }
export interface JerryBootstrapReceipt { mode:"inspection"|"applied";principalId:"user_owner";residentBinding:"jerry";botId:string|null;channelId:string|null;conversationId:string|null;mailboxDurable:boolean;runtimeBinding:{instanceId:string|null;keyVersion:number|null};mutated:boolean }

function inspect(path:string):JerryBootstrapReceipt{
  let db:Database.Database;try{db=new Database(path,{readonly:true,fileMustExist:true});}catch{return{mode:"inspection",principalId:"user_owner",residentBinding:"jerry",botId:null,channelId:null,conversationId:null,mailboxDurable:false,runtimeBinding:{instanceId:null,keyVersion:null},mutated:false};}
  try{const row=db.prepare(`SELECT b.id AS botId,b.durable_mailbox AS durableMailbox,b.active_instance_id AS instanceId,b.active_key_version AS keyVersion,c.id AS channelId,h.id AS conversationId FROM bots b LEFT JOIN conversation_handles h ON h.id=b.conversation_id LEFT JOIN channels c ON c.id=h.channel_id WHERE b.resident_binding='jerry'`).get() as {botId:string;durableMailbox:number;instanceId:string|null;keyVersion:number|null;channelId:string|null;conversationId:string|null}|undefined;return{mode:"inspection",principalId:"user_owner",residentBinding:"jerry",botId:row?.botId??null,channelId:row?.channelId??null,conversationId:row?.conversationId??null,mailboxDurable:row?.durableMailbox===1,runtimeBinding:{instanceId:row?.instanceId??null,keyVersion:row?.keyVersion??null},mutated:false};}finally{db.close();}
}

export async function bootstrapJerry(input:JerryBootstrapInput):Promise<JerryBootstrapReceipt>{
  if(input.apply!==true)return inspect(input.databasePath);
  if(!input.authority||input.authority.approved!==true||input.authority.kind!=="m14-bootstrap"||input.authority.operator!=="user_owner"||input.authority.resident!=="jerry"||input.authority.legacyWriterAuthoritative!==true||input.authority.coordinationFlagsAllFalse!==true)throw new Error("M14 bootstrap apply requires explicit feature-off legacy-authority evidence");
  if(!Number.isSafeInteger(input.keyVersion)||input.keyVersion<1)throw new Error("resident key version must be positive");
  const database=openCoordinationDatabase({path:input.databasePath,applicationVersion:"home23-coordination-m14-bootstrap",now:input.now});
  try{
    const existingEpoch=database.readOne<{epoch:number;mode:string;writer:string}>("SELECT epoch,mode,writer FROM authority_epochs WHERE capability='messages' ORDER BY epoch DESC LIMIT 1");
    if(!existingEpoch){const epoch={capability:"messages" as const,epoch:1,mode:"legacy" as const,writer:"legacy-conversation-writer",effectiveAtEventSequence:null,rollbackEpoch:null};if(validateInitialAuthorityEpoch(epoch).decision!=="valid")throw new Error("initial messages authority is invalid");const now=(input.now?.()??new Date()).toISOString();const requestId=generateCoordinationId("request"),correlationId=generateCoordinationId("correlation");database.mutateWithEvent(tx=>{tx.run("INSERT INTO authority_epochs (capability,epoch,mode,writer,effective_at_event_sequence,rollback_epoch,receipt_json,created_at) VALUES (?,?,?,?,?,?,?,?)",epoch.capability,epoch.epoch,epoch.mode,epoch.writer,null,null,JSON.stringify({kind:"feature-off-bootstrap",authority:input.authority}),now);return{value:null,event:{type:"authority.epoch_changed",aggregateKind:"authorityEpoch",aggregateId:"authority:messages",aggregateVersion:1,channelId:null,actorPrincipalId:"user_owner",requestId,correlationId,payload:{capability:"messages",epoch:1,writer:epoch.writer,mode:"legacy"},createdAt:now}};});}else if(existingEpoch.epoch!==1||existingEpoch.mode!=="legacy"||existingEpoch.writer!=="legacy-conversation-writer")throw new Error("existing messages authority is not the feature-off legacy baseline");
    const repo=new SqliteBotDirectoryRepository(database);const policy={degradedAfterMs:30_000,offlineAfterMs:120_000};const directory=createBotDirectory({repository:repo,availabilityPolicy:policy,now:input.now});
    const requestId=generateCoordinationId("request"),correlationId=generateCoordinationId("correlation");const bot=await directory.ensurePersistentBinding({residentBinding:"jerry",name:"Jerry",purpose:"Persistent Home23 resident",continuingIdentity:true,durableMailbox:true,requiredCapabilities:HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES,aliases:[{namespace:"name",value:"Jerry"}]},{principalId:"user_owner",requestId,correlationId});
    const current=await repo.getBotByResidentBinding("jerry");if(!current)throw new Error("Jerry binding was not persisted");
    if(current.activeInstanceId===null){await directory.registerResident({context:{requestId,correlationId,credential:{residentSlug:"jerry",role:"resident",instanceId:input.serverInstanceId,keyVersion:input.keyVersion}},botBinding:"jerry",protocolVersion:1,capabilities:HOUSE_RESIDENT_ATTACHMENT_CAPABILITIES});}
    const participants=Object.freeze({listVisibleBots:directory.listVisibleBots,resolveAlias:directory.resolveAlias,getBotByResidentBinding:(binding:string)=>repo.getBotByResidentBinding(binding)});
    const messaging=new SqliteMessagingRepository(database,{botConversationBinding:new SqliteBotConversationBindingAdapter(),messageProvenanceAuthorization:new M11MessageProvenanceAuthority()});
    const channels=createChannelService({repository:messaging,participantDirectory:participants,cursorSigningKey:Buffer.alloc(32,1),now:input.now});
    const context={principalId:"user_owner",requestId,correlationId,identity:{kind:"owner" as const,auth:{principalId:"user_owner" as const,deviceId:generateCoordinationId("device"),sessionId:generateCoordinationId("clientSession"),scopes:["product:read","message:send"] as const}}};
    const direct=await channels.createDirectConversation({context,memberBotIds:[bot.id],pinned:true,idempotencyKey:"home23-m14-jerry-direct-bootstrap-v1"});
    return{mode:"applied",principalId:"user_owner",residentBinding:"jerry",botId:bot.id,channelId:direct.channel.id,conversationId:direct.channel.conversationId,mailboxDurable:true,runtimeBinding:{instanceId:input.serverInstanceId,keyVersion:input.keyVersion},mutated:true};
  }finally{database.close();}
}
