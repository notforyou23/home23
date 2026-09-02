import type { ConversationHistory } from "../agent/history.js";
import type { AgentLoop } from "../agent/loop.js";
import type { ModelAliases } from "../agent/model-resolution.js";
import { resolve } from "node:path";
import { createResidentCredential } from "../coordination/resident-protocol/index.js";
import { ResidentTurnUdsServer } from "./resident-uds.js";

const KEY=/^[a-f0-9]{64}$/i;
function exact(value:string|undefined,name:string){if(value==="true")return true;if(value===undefined||value===""||value==="false")return false;throw new Error(`${name} must be exactly true or false`);}

export async function startResidentCoordinationHarness(input:{agent:Pick<AgentLoop,"runWithTurn"|"stop"|"isRunning"|"getModel"|"getProvider"|"getReasoningEffort">;history:ConversationHistory;modelAliases?:ModelAliases;environment?:NodeJS.ProcessEnv}){
  const env=input.environment??process.env;
  if(!exact(env.HOME23_COORDINATION_RESIDENT_ENABLED,"HOME23_COORDINATION_RESIDENT_ENABLED"))return null;
  const slug=env.HOME23_AGENT??"";if(!/^[a-z][a-z0-9-]{0,62}$/.test(slug))throw new Error("HOME23_AGENT is not a valid resident slug");
  const socketPath=env.HOME23_COORDINATION_RESIDENT_SOCKET_PATH??"";if(!socketPath.startsWith("/"))throw new Error("HOME23_COORDINATION_RESIDENT_SOCKET_PATH must be absolute");
  const serverInstanceId=env.HOME23_COORDINATION_RESIDENT_SERVER_INSTANCE_ID??"";const clientInstanceId=env.HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID??"";
  if(![serverInstanceId,clientInstanceId].every(v=>/^[A-Za-z0-9._:-]{1,128}$/.test(v)))throw new Error("resident coordination instance IDs are invalid");
  const rawVersion=env.HOME23_COORDINATION_RESIDENT_KEY_VERSION??"";if(!/^[1-9][0-9]*$/.test(rawVersion))throw new Error("HOME23_COORDINATION_RESIDENT_KEY_VERSION must be positive");
  const key=env.HOME23_COORDINATION_RESIDENT_KEY??"";if(!KEY.test(key))throw new Error("HOME23_COORDINATION_RESIDENT_KEY must contain exactly 32 bytes of hex");
  const home23Root=env.HOME23_ROOT;const attachmentRoot=env.HOME23_COORDINATION_ATTACHMENTS_ROOT??(home23Root?resolve(home23Root,"instances",".house","coordination","attachments"):undefined);
  const rootKey=Buffer.from(key,"hex");const credential=createResidentCredential({residentSlug:slug,role:"resident",instanceId:clientInstanceId,keyVersion:Number(rawVersion),rootKey});rootKey.fill(0);
  const server=new ResidentTurnUdsServer({socketPath,serverInstanceId,credential,residentSlug:slug,agent:input.agent,history:input.history,modelAliases:input.modelAliases??{},...(attachmentRoot?{attachmentRoot}:{})});
  await server.start();return server;
}
