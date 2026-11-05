import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnAgentTool } from '../../src/agent/tools/subagent.js';
import { applyForegroundToolPolicy } from '../../src/agent/foreground-tool-policy.js';

test('tracked-source assignment refuses before a specialist or Working Thread is allocated',async()=>{
 const input={task:'Fix the provider implementation',task_kind:'source_change',tool_grants:['files','shell']};
 const policy=applyForegroundToolPolicy('spawn_agent',input,{chatId:'coordination:fixture:fixture',authenticatedUserMessage:'Fix it'} as any);
 assert.equal(policy.action,'refuse');assert.match(policy.reason!,/coding_run/);
 const result=await spawnAgentTool.execute(input,{} as any);assert.equal(result.is_error,true);assert.match(result.content,/coding_run/);
});
test('declared local changes require matching grants before execution',async()=>{
 const result=await spawnAgentTool.execute({task:'Update local notes',task_kind:'local_state_change',tool_grants:['web']},{} as any);
 assert.equal(result.is_error,true);assert.match(result.content,/files or shell/);
});
