import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('service resolves the selected runtime, forwards existing authority, and refuses saved-environment drift', () => {
  const root = mkdtempSync(join(tmpdir(), 'chess-service-'));
  try {
    const release = join(root, 'release');
    mkdirSync(join(root, 'cli/lib'), {recursive:true}); mkdirSync(join(release, 'dist/chess'), {recursive:true});
    writeFileSync(join(root, 'package.json'), '{}');
    writeFileSync(join(release, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'cli/lib/coordination-active-release.cjs'), `exports.resolveActiveCoordinationRelease = () => (${JSON.stringify({releaseId:'selected',releaseRoot:release,residents:{jerry:{}}})});`);
    const env = {HOME23_AGENT:'jerry', HOME23_COORDINATION_RESIDENT_RUNTIME_ROOT:release};
    for (const key of ['SOCKET_PATH','SERVER_INSTANCE_ID','RESIDENT_CLIENT_INSTANCE_ID','RESIDENT_KEY_VERSION','RESIDENT_KEY']) env['HOME23_COORDINATION_'+key] = 'private-'+key;
    const ecosystem = () => writeFileSync(join(root, 'ecosystem.config.cjs'), 'module.exports = '+JSON.stringify({apps:[{name:'home23-jerry-harness',env}]}));
    ecosystem();
    const receipt = join(root,'receipt.json');
    writeFileSync(join(release,'dist/chess/cli.js'), `import fs from 'node:fs'; export async function main(args) {fs.writeFileSync(${JSON.stringify(receipt)},JSON.stringify({args,key:process.env.HOME23_COORDINATION_RESIDENT_KEY}));}`);
    const config = join(root,'service.json'), session = join(root,'session'), binding = join(root,'binding.json');
    writeFileSync(config,JSON.stringify({version:1,installation:root,resident:'jerry',sessionDirectory:session,bindingFile:binding}),{mode:0o600});
    const run = () => spawnSync(process.execPath,['scripts/chess/service.mjs',config],{encoding:'utf8'});
    const result = run(); assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(receipt)),{args:['serve',session,binding],key:'private-RESIDENT_KEY'});
    assert.ok(!result.stdout.includes('private-'));
    env.HOME23_COORDINATION_RESIDENT_RUNTIME_ROOT = join(root,'stale'); ecosystem();
    const refused = run(); assert.equal(refused.status,1); assert.match(refused.stderr,/does not match selected release/);
  } finally {rmSync(root,{recursive:true,force:true});}
});
