import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codingSourceRoot } from '../../src/acp/source-authority.js';
import { configuredCodingRunTool } from '../../src/agent/tools/coding.js';
test('new installation coding jobs use maintained source while another explicit project is preserved', () => {
 const root=mkdtempSync(join(tmpdir(),'coding-source-')); const dev=join(root,'dev');
 try {mkdirSync(join(root,'instances/.house'),{recursive:true});mkdirSync(join(dev,'.git'),{recursive:true});
 writeFileSync(join(root,'instances/.house/source-authority.json'),JSON.stringify({development:{backend:dev}}));
 assert.equal(codingSourceRoot(root),realpathSync(dev));assert.equal(codingSourceRoot(root,root),realpathSync(dev));
 assert.equal(codingSourceRoot(root,'/another/project'),'/another/project');
 writeFileSync(join(root,'instances/.house/source-authority.json'),'{}');assert.throws(()=>codingSourceRoot(root),/Source authority/);
 } finally {rmSync(root,{recursive:true,force:true});}
});
test('Codex-only resident is not offered unavailable backend controls', () => {
 const schema=configuredCodingRunTool({defaultAgent:'codex',allowedAgents:['codex']}).input_schema as any;
 assert.deepEqual(schema.properties.backend.enum,['codex']);assert.equal(schema.properties.max_budget_usd,undefined);
 assert.equal(schema.properties.effort,undefined);assert.match(schema.properties.backend.description,/codex/);
});
