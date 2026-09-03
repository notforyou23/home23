import type { CoordinationDatabase, CoordinationTransaction } from "../db/index.js";
import type {
  BotAliasRecord, BotDirectoryRecord, BotDirectoryRepository,
  CommitResidentHeartbeatInput, CommitResidentHeartbeatResult,
  CommitResidentRegistrationInput, CommitResidentRegistrationResult,
  EnsurePersistentBindingInput, EnsurePersistentBindingResult,
} from "./types.js";

interface BotRow { id:string;principalId:string;name:string;purpose:string;lifecycle:BotDirectoryRecord["lifecycle"];conversationId:string|null;residentBinding:string;continuingIdentity:number;durableMailbox:number;requiredCapabilitiesJson:string;activeInstanceId:string|null;activeKeyVersion:number|null;residentProtocolVersion:number|null;residentCapabilitiesJson:string;residentRegisteredAt:string|null;lastHeartbeatAt:string|null;reportedAvailability:BotDirectoryRecord["reportedAvailability"];version:number;createdAt:string;updatedAt:string }
interface AliasRow { id:string;namespace:string;aliasDigest:string;targetType:"bot";targetId:string;active:number;createdAt:string;updatedAt:string }
const BOT=`SELECT id,principal_id AS principalId,name,purpose,lifecycle,conversation_id AS conversationId,resident_binding AS residentBinding,continuing_identity AS continuingIdentity,durable_mailbox AS durableMailbox,required_capabilities_json AS requiredCapabilitiesJson,active_instance_id AS activeInstanceId,active_key_version AS activeKeyVersion,resident_protocol_version AS residentProtocolVersion,resident_capabilities_json AS residentCapabilitiesJson,resident_registered_at AS residentRegisteredAt,last_heartbeat_at AS lastHeartbeatAt,reported_availability AS reportedAvailability,version,created_at AS createdAt,updated_at AS updatedAt FROM bots`;
const ALIAS=`SELECT id,namespace,alias_digest AS aliasDigest,target_type AS targetType,target_id AS targetId,active,created_at AS createdAt,updated_at AS updatedAt FROM aliases`;
const bot=(r:BotRow):BotDirectoryRecord=>Object.freeze({...r,continuingIdentity:r.continuingIdentity===1,durableMailbox:r.durableMailbox===1,requiredCapabilities:Object.freeze(JSON.parse(r.requiredCapabilitiesJson) as string[]),residentCapabilities:Object.freeze(JSON.parse(r.residentCapabilitiesJson) as string[]),requiredCapabilitiesJson:undefined,residentCapabilitiesJson:undefined} as unknown as BotDirectoryRecord);
const alias=(r:AliasRow):BotAliasRecord=>Object.freeze({...r,active:r.active===1});
function version(tx:CoordinationTransaction,id:string){return(tx.readOne<{count:number}>("SELECT count(*) AS count FROM events WHERE aggregate_kind='bot' AND aggregate_id=?",id)?.count??0)+1;}
function event(tx:CoordinationTransaction,input:{requestId:string;correlationId:string;actorPrincipalId:string},id:string,at:string,outcome:string){return{type:"bot.updated",aggregateKind:"bot",aggregateId:id,aggregateVersion:version(tx,id),channelId:null,actorPrincipalId:input.actorPrincipalId,requestId:input.requestId,correlationId:input.correlationId,payload:{outcome},createdAt:at};}

export class SqliteBotDirectoryRepository implements BotDirectoryRepository {
  constructor(private readonly database:CoordinationDatabase){}
  async getBotByResidentBinding(value:string){const r=this.database.readOne<BotRow>(`${BOT} WHERE resident_binding=?`,value);return r?bot(r):null;}
  async getBotById(id:string){const r=this.database.readOne<BotRow>(`${BOT} WHERE id=?`,id);return r?bot(r):null;}
  async listPersistentBots(){return Object.freeze(this.database.readAll<BotRow>(`${BOT} ORDER BY name COLLATE NOCASE,id`).map(bot));}
  async resolveActiveAlias(namespace:string,digest:string){const r=this.database.readOne<AliasRow>(`${ALIAS} WHERE namespace=? AND alias_digest=? AND active=1`,namespace,digest);return r?alias(r):null;}
  async ensurePersistentBinding(input:EnsurePersistentBindingInput):Promise<EnsurePersistentBindingResult>{
    const before=await this.getBotByResidentBinding(input.bot.residentBinding);
    if(before&&before.name===input.bot.name&&before.purpose===input.bot.purpose&&JSON.stringify(before.requiredCapabilities)===JSON.stringify(input.bot.requiredCapabilities)){
      const complete=input.aliases.every(a=>this.database.readOne<AliasRow>(`${ALIAS} WHERE namespace=? AND alias_digest=? AND active=1`,a.namespace,a.aliasDigest)?.targetId===before.id);
      if(complete)return{outcome:"existing",bot:before};
    }
    return this.database.mutateWithEvent<EnsurePersistentBindingResult>(tx=>{
      const existing=tx.readOne<BotRow>(`${BOT} WHERE resident_binding=?`,input.bot.residentBinding);
      const target=existing?.id??input.bot.id;
      for(const a of input.aliases){const collision=tx.readOne<AliasRow>(`${ALIAS} WHERE namespace=? AND alias_digest=?`,a.namespace,a.aliasDigest);if(collision&&collision.targetId!==target)return{value:{outcome:"alias_collision",namespace:a.namespace,existingBotId:collision.targetId},event:event(tx,input,target,input.bot.createdAt,"alias_collision")};}
      if(existing){const same=existing.name===input.bot.name&&existing.purpose===input.bot.purpose&&existing.requiredCapabilitiesJson===JSON.stringify(input.bot.requiredCapabilities);if(!same)return{value:{outcome:"binding_conflict",existingBotId:existing.id},event:event(tx,input,existing.id,input.bot.createdAt,"binding_conflict")};for(const a of input.aliases)tx.run("INSERT OR IGNORE INTO aliases (id,namespace,alias_digest,target_type,target_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",a.id,a.namespace,a.aliasDigest,a.targetType,existing.id,a.active?1:0,a.createdAt,a.updatedAt);return{value:{outcome:"existing",bot:bot(existing)},event:event(tx,input,existing.id,input.bot.createdAt,"existing")};}
      if(tx.readOne("SELECT id FROM bots WHERE id=?",input.bot.id)||tx.readOne("SELECT id FROM aliases WHERE id IN (SELECT value FROM json_each(?))",JSON.stringify(input.aliases.map(a=>a.id))))return{value:{outcome:"identity_collision"},event:event(tx,input,input.bot.id,input.bot.createdAt,"identity_collision")};
      tx.run("INSERT OR IGNORE INTO principals (id,kind,created_at) VALUES ('user_owner','owner',?)",input.bot.createdAt);tx.run("INSERT INTO principals (id,kind,created_at) VALUES (?,'bot',?)",input.bot.id,input.bot.createdAt);
      const b=input.bot;tx.run(`INSERT INTO bots (id,principal_id,name,purpose,lifecycle,conversation_id,resident_binding,continuing_identity,durable_mailbox,required_capabilities_json,active_instance_id,active_key_version,resident_protocol_version,resident_capabilities_json,resident_registered_at,last_heartbeat_at,reported_availability,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,b.id,b.principalId,b.name,b.purpose,b.lifecycle,b.conversationId,b.residentBinding,1,1,JSON.stringify(b.requiredCapabilities),b.activeInstanceId,b.activeKeyVersion,b.residentProtocolVersion,JSON.stringify(b.residentCapabilities),b.residentRegisteredAt,b.lastHeartbeatAt,b.reportedAvailability,b.version,b.createdAt,b.updatedAt);
      for(const a of input.aliases)tx.run("INSERT INTO aliases (id,namespace,alias_digest,target_type,target_id,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",a.id,a.namespace,a.aliasDigest,a.targetType,a.targetId,a.active?1:0,a.createdAt,a.updatedAt);
      return{value:{outcome:"created",bot:b},event:event(tx,input,b.id,b.createdAt,"created")};
    }).value;
  }
  async commitResidentRegistration(input:CommitResidentRegistrationInput):Promise<CommitResidentRegistrationResult>{return this.database.mutateWithEvent<CommitResidentRegistrationResult>(tx=>{const row=tx.readOne<BotRow>(`${BOT} WHERE id=?`,input.botId);const evt=(out:string)=>event(tx,input,input.botId,input.registeredAt,out);if(!row)return{value:{outcome:"not_found"},event:evt("not_found")};if(row.lifecycle!=="active")return{value:{outcome:"inactive"},event:evt("inactive")};if(row.residentBinding!==input.residentBinding||row.version!==input.expectedVersion)return{value:{outcome:"conflict"},event:evt("conflict")};if(row.activeInstanceId!==null&&row.activeInstanceId!==input.instanceId&&row.activeKeyVersion!==null&&(input.keyVersion<row.activeKeyVersion||(input.keyVersion===row.activeKeyVersion&&!input.allowSameKeyReplacement)))return{value:{outcome:"superseded_instance"},event:evt("superseded_instance")};tx.run("UPDATE bots SET active_instance_id=?,active_key_version=?,resident_protocol_version=?,resident_capabilities_json=?,resident_registered_at=?,last_heartbeat_at=?,reported_availability=?,version=version+1,updated_at=? WHERE id=?",input.instanceId,input.keyVersion,input.protocolVersion,JSON.stringify(input.capabilities),input.registeredAt,input.registeredAt,input.reportedAvailability,input.registeredAt,input.botId);const updated=tx.readOne<BotRow>(`${BOT} WHERE id=?`,input.botId)!;return{value:{outcome:"registered",bot:bot(updated)},event:evt("registered")}}).value;}
  async commitResidentHeartbeat(input:CommitResidentHeartbeatInput):Promise<CommitResidentHeartbeatResult>{return this.database.mutateWithEvent<CommitResidentHeartbeatResult>(tx=>{const row=tx.readOne<BotRow>(`${BOT} WHERE id=?`,input.botId);const evt=(out:string)=>event(tx,input,input.botId,input.heartbeatAt,out);if(!row)return{value:{outcome:"not_found"},event:evt("not_found")};if(row.lifecycle!=="active")return{value:{outcome:"inactive"},event:evt("inactive")};if(row.activeInstanceId!==input.instanceId||row.activeKeyVersion!==input.keyVersion)return{value:{outcome:"stale_instance"},event:evt("stale_instance")};if(row.version!==input.expectedVersion)return{value:{outcome:"conflict"},event:evt("conflict")};tx.run("UPDATE bots SET last_heartbeat_at=?,reported_availability=?,version=version+1,updated_at=? WHERE id=?",input.heartbeatAt,input.reportedAvailability,input.heartbeatAt,input.botId);return{value:{outcome:"recorded",bot:bot(tx.readOne<BotRow>(`${BOT} WHERE id=?`,input.botId)!)},event:evt("recorded")}}).value;}
  async transitionLifecycle(input:{botId:string;from:"active"|"archived";to:"active"|"archived";actorPrincipalId:"user_owner";requestId:string;correlationId:string;changedAt:string}):Promise<BotDirectoryRecord>{
    return this.database.mutateWithEvent<BotDirectoryRecord>(tx=>{
      const row=tx.readOne<BotRow>(`${BOT} WHERE id=?`,input.botId);
      if(!row)throw Object.assign(new Error("bot_not_found"),{code:"bot_not_found"});
      if(row.lifecycle===input.to)return{value:bot(row),event:event(tx,input,input.botId,input.changedAt,`already_${input.to}`)};
      if(row.lifecycle!==input.from)throw Object.assign(new Error("lifecycle_conflict"),{code:"lifecycle_conflict"});
      if(input.to==="archived"&&tx.readOne(
        `SELECT id FROM works pending
         WHERE pending.target_principal_id=?
           AND pending.kind IN ('bot_turn','channel.bot_turn')
           AND (pending.state IN ('queued','leased','running','cancelling') OR (
             pending.state='succeeded' AND NOT EXISTS (
               SELECT 1 FROM messages result
               WHERE result.id='msg_'||substr(pending.id,5)
                 AND result.work_id=pending.id AND result.kind='result'
             ) AND (
               pending.kind='bot_turn' OR NOT EXISTS (
                 SELECT 1 FROM rounds settled_round
                 WHERE settled_round.id=pending.round_id
                   AND settled_round.state IN ('completed','failed','cancelled')
               )
             )
           ))
         LIMIT 1`,row.principalId,
      ))throw Object.assign(new Error("bot_has_unsettled_work"),{code:"bot_has_unsettled_work"});
      tx.run("UPDATE bots SET lifecycle=?,active_instance_id=NULL,active_key_version=NULL,resident_protocol_version=NULL,resident_capabilities_json='[]',resident_registered_at=NULL,last_heartbeat_at=NULL,reported_availability=NULL,version=version+1,updated_at=? WHERE id=? AND lifecycle=?",input.to,input.changedAt,input.botId,input.from);
      const updated=tx.readOne<BotRow>(`${BOT} WHERE id=?`,input.botId)!;
      return{value:bot(updated),event:{...event(tx,input,input.botId,input.changedAt,input.to),payload:{outcome:input.to,lifecycle:input.to,conversationId:updated.conversationId,residentBinding:updated.residentBinding}}};
    }).value;
  }
}
