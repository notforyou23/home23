import { workStatusTool } from '../../src/agent/tools/work.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBootstrapBlock } from '../../src/agent/session-bootstrap.js';
import { loadAuthoredIdentity } from '../../src/agent/identity-budget.js';
import { inspectIdentitySource, preserveIdentitySource } from '../../src/agent/identity-maintenance.js';
test('owner correction at the end of a large identity source survives intact', () => {
 const text = '# History\n' + 'Earlier detail. '.repeat(2000) + '\n# Current owner decision\nFinish the authorized work.';
 const result = loadAuthoredIdentity('LEARNINGS.md', text, 8000);
 assert.equal(result.text, text); assert.equal(result.truncated, false);
});
test('maintenance reports excess without rewriting; pre-update history is recoverable and deduplicated', () => {
 const root = mkdtempSync(join(tmpdir(), 'identity-maintenance-'));
 try {
 const text = 'old context '.repeat(1000); writeFileSync(join(root,'LEARNINGS.md'),text);
 const audit = inspectIdentitySource(root,'LEARNINGS.md'); assert.equal(audit.maintenanceNeeded,true);
 const first = preserveIdentitySource(root,'LEARNINGS.md')!;
 assert.equal(preserveIdentitySource(root,'LEARNINGS.md'),first);
 writeFileSync(join(root,'LEARNINGS.md'),'Current guidance');
 assert.equal(readFileSync(first,'utf8'),text);
 } finally { rmSync(root,{recursive:true,force:true}); }
});

test('bootstrap preserves the final correction beyond its old character cutoff', () => {
 const root = mkdtempSync(join(tmpdir(), 'bootstrap-complete-'));
 try { const text = 'Earlier detail. '.repeat(1000) + '\nOwner correction: finish the existing assignment.';
 writeFileSync(join(root,'PLAYBOOK.md'),text);
 assert.ok(buildBootstrapBlock(root,{bootstrap:{reads:['PLAYBOOK.md'],maxBytesPerFile:100}})?.includes(text));
 } finally {rmSync(root,{recursive:true,force:true});}
});

test('connected work status routes canonical IDs while preserving old async handles', async () => {
 const calls: unknown[]=[];
 const ctx:any={turnRuntime:{coordinationOrigin:{workId:'wrk_parent'}},parentToolCallId:'tool',
 coordinationChannelOperation:async (request:unknown)=>{calls.push(request);return {registry:'canonical'};},
 workRegistry:{get:(id:string)=>({id,status:'completed'})}};
 assert.match((await workStatusTool.execute({work_id:'wrk_child'},ctx)).content,/canonical/);
 assert.match((await workStatusTool.execute({work_id:'aw_older'},ctx)).content,/aw_older/);
 assert.equal((await workStatusTool.execute({},ctx)).is_error,true);assert.equal(calls.length,1);
});
