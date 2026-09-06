#!/usr/bin/env node
// Run offline candidate checks and bind their receipts to the exact artifact.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { inventory, relativeFile } from './prepare.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function changedPaths(before,after) {
  const a=new Map(before.rows.map(r=>[r.path,r])),b=new Map(after.rows.map(r=>[r.path,r]));
  return [...new Set([...a.keys(),...b.keys()])].sort().filter(p=>!same(a.get(p),b.get(p)));
}
export function verify({ preparation, receiptDir, allowedChanges, checks, resolutions = {} }) {
  const prepared=JSON.parse(fs.readFileSync(path.join(preparation,'prepared.json'),'utf8'));
  const baseline=JSON.parse(fs.readFileSync(path.join(preparation,'baseline.json'),'utf8'));
  if(baseline.digest!==prepared.baselineDigest || inventory(prepared.baseline).digest!==baseline.digest) throw new Error('Baseline drift');
  if(!Array.isArray(allowedChanges) || !Array.isArray(checks) || !checks.length) throw new Error('Explicit changes and checks required');
  allowedChanges.forEach(relativeFile);
  for (const conflict of (prepared.changes ?? []).filter(c => c.status === 'conflict')) {
    const review = resolutions[conflict.path];
    if (!review || typeof review.reason !== 'string' || review.reason.trim().length < 10
        || sha(fs.readFileSync(path.join(prepared.candidate, relativeFile(conflict.path)))) !== review.sha256) {
      throw new Error(`Conflict requires a current resolution receipt: ${conflict.path}`);
    }
  }
  for(const c of checks) if(!c || typeof c.command!=='string' || !Array.isArray(c.args) || c.args.some(a=>typeof a!=='string') || !Number.isSafeInteger(c.timeoutMs) || c.timeoutMs<1) throw new Error('Invalid check');
  const before=inventory(prepared.candidate), changed=changedPaths(baseline,before);
  const allowed=new Set(allowedChanges);
  const unexpected=changed.filter(p=>!allowed.has(p) && !p.startsWith('dist/'));
  if(unexpected.length) throw new Error(`Unreviewed candidate changes: ${unexpected.join(', ')}`);
  for(const row of before.rows) {
    if(row.type==='file' && /\.(?:[cm]?[jt]s|tsx|md)$/.test(row.path) && !row.path.startsWith('node_modules/')) {
      if(/^<{7} |^>{7} /m.test(fs.readFileSync(path.join(prepared.candidate,row.path),'utf8'))) throw new Error(`Unresolved merge marker: ${row.path}`);
    }
  }
  const parent=fs.realpathSync(path.dirname(path.resolve(receiptDir)));
  receiptDir=path.join(parent,path.basename(receiptDir));
  if(receiptDir===prepared.candidate || receiptDir.startsWith(prepared.candidate+path.sep) || receiptDir===prepared.baseline || receiptDir.startsWith(prepared.baseline+path.sep)) throw new Error('Receipts must be outside artifacts');
  fs.mkdirSync(receiptDir,{mode:0o700});
  const results=[];
  for(const [i,c] of checks.entries()) {
    const log=path.join(receiptDir,`check-${i+1}.log`),fd=fs.openSync(log,'wx',0o600);
    const start=Date.now();
    let result;
    try { result=spawnSync(c.command,c.args,{cwd:prepared.candidate,stdio:['ignore',fd,fd],timeout:c.timeoutMs,killSignal:'SIGTERM'}); }
    finally { fs.closeSync(fd); }
    const record={...c,exitCode:result.status,signal:result.signal,error:result.error?.code ?? null,durationMs:Date.now()-start,logSha256:sha(fs.readFileSync(log))};
    results.push(record);
    process.stderr.write(`Check ${i+1}/${checks.length}: ${record.exitCode===0?'passed':'failed'}\n`);
    if(record.exitCode!==0 || record.error) break;
  }
  const after=inventory(prepared.candidate);
  const ok=results.length===checks.length && results.every(r=>r.exitCode===0 && !r.error) && after.digest===before.digest && inventory(prepared.baseline).digest===baseline.digest;
  const report={schemaVersion:1,verifiedAt:new Date().toISOString(),ok,candidate:prepared.candidate,candidateDigest:before.digest,baseline:prepared.baseline,baselineDigest:baseline.digest,changedPaths:changed,resolutions,checks:results,artifactUnchanged:after.digest===before.digest,activationReady:false,limits:['No live deployment, authenticated provider acceptance, or physical phone acceptance performed.']};
  fs.writeFileSync(path.join(receiptDir,'verification.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  return report;
}
export function checkReceipt(file) {
  const r=JSON.parse(fs.readFileSync(file,'utf8'));
  if(r.schemaVersion!==1 || r.ok!==true || !Array.isArray(r.checks) || !r.checks.length || inventory(r.candidate).digest!==r.candidateDigest || inventory(r.baseline).digest!==r.baselineDigest) throw new Error('Verification missing, failed, or stale');
  for(const [i,c] of r.checks.entries()) if(c.exitCode!==0 || sha(fs.readFileSync(path.join(path.dirname(file),`check-${i+1}.log`)))!==c.logSha256) throw new Error('Check receipt changed');
  return {ok:true,candidateDigest:r.candidateDigest,activationReady:false};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const [mode,file]=process.argv.slice(2);let r;if(mode==='run')r=verify(JSON.parse(fs.readFileSync(file,'utf8')));else if(mode==='check')r=checkReceipt(file);else throw new Error('Usage: verify.mjs run PLAN.json | check RECEIPT.json');console.log(JSON.stringify(r,null,2));process.exitCode=r.ok?0:1; }
  catch(error) { console.error(error.message);process.exitCode=1; }
}
