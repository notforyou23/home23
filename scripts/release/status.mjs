#!/usr/bin/env node
// Read-only comparison of pointer, persisted launcher definitions and PM2.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function compareDefinitions({ root, release, residents, saved, running }) {
  const problems = [], processes = [];
  const canonical = value => { try { return fs.realpathSync(value); } catch { return null; } };
  const expected = [
    { name:'home23-coordination', script:path.join(release,'scripts/coordination/run.mjs'), cwd:release },
    ...residents.map(slug=>({ name:`home23-${slug}-harness`, script:path.join(release,'dist/home.js'), cwd:root, runtime:release })),
  ];
  for (const want of expected) {
    const configs=saved.filter(x=>x.name===want.name), live=running.filter(x=>x.name===want.name);
    if(configs.length!==1) problems.push(`${want.name}: expected exactly one saved definition`);
    if(live.length!==1) problems.push(`${want.name}: expected exactly one running definition`);
    for(const [label, rows] of [['saved',configs],['running',live]]) {
      if(rows.length!==1) continue;
      const row=rows[0];
      if(canonical(row.cwd)!==canonical(want.cwd) || !canonical(want.cwd)) problems.push(`${want.name}: ${label} working directory differs`);
      if(!row.script || canonical(path.resolve(row.cwd || root,row.script))!==canonical(want.script) || !canonical(want.script)) problems.push(`${want.name}: ${label} executable differs`);
      if(want.runtime && canonical(row.runtime || '')!==canonical(want.runtime)) problems.push(`${want.name}: ${label} resident runtime differs`);
      if(label==='running' && (row.status!=='online' || !row.pid)) problems.push(`${want.name}: process is not online`);
    }
    processes.push({ name:want.name, expectedScript:want.script, expectedCwd:want.cwd, saved:configs, running:live });
  }
  return { ok:problems.length===0, problems, processes, behavioralReadiness:'not measured', activationAuthorized:false };
}
export function status(root) {
  root=fs.realpathSync(root);
  const runtime=path.join(root,'instances','.house','coordination');
  const pointerFile=path.join(runtime,'active-release.json');
  const raw=fs.readFileSync(pointerFile);
  const pointer=JSON.parse(raw);
  if(![1,2].includes(pointer.schemaVersion) || !/^[a-f0-9]{40}$/.test(pointer.releaseId)) throw new Error('Invalid managed release pointer');
  const residents=pointer.schemaVersion===1 ? [pointer.residentSlug] : Object.keys(pointer.residents || {});
  if(!residents.length || residents.some(x=>!['jerry','forrest'].includes(x))) throw new Error('Unsupported resident pointer');
  const release=fs.realpathSync(path.join(runtime,'releases',pointer.releaseId));
  const require=createRequire(import.meta.url);
  // Project only deployment fields. Never serialize env/config/PM2 wholesale.
  const saved=[path.join(root,'ecosystem.config.cjs'),path.join(runtime,'ecosystem.config.cjs')].flatMap(file=> {
    delete require.cache[require.resolve(file)];
    return require(file).apps.map(app=>({ name:app.name,script:app.script,cwd:app.cwd,runtime:app.env?.HOME23_COORDINATION_RESIDENT_RUNTIME_ROOT }));
  });
  const rows=JSON.parse(execFileSync('pm2',['jlist'],{encoding:'utf8',maxBuffer:16*1024*1024}));
  const running=rows.map(row=>({name:row.name,pid:row.pid,status:row.pm2_env?.status,script:row.pm2_env?.pm_exec_path,cwd:row.pm2_env?.pm_cwd,runtime:row.pm2_env?.HOME23_COORDINATION_RESIDENT_RUNTIME_ROOT}));
  if(!raw.equals(fs.readFileSync(pointerFile))) throw new Error('Pointer changed during inspection');
  return { observedAt:new Date().toISOString(),releaseId:pointer.releaseId,...compareDefinitions({root,release,residents,saved,running}) };
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result=status(process.argv[2] || process.cwd());console.log(JSON.stringify(result,null,2));process.exitCode=result.ok?0:1; }
  catch { console.error('Release inspection failed; inspect pointer, launcher files and PM2 locally. No deployment changes made.');process.exitCode=2; }
}
