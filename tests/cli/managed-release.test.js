import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { prepare, inventory, relativeFile } from '../../scripts/release/prepare.mjs';
import { compareDefinitions } from '../../scripts/release/status.mjs';
import { runUpdate } from '../../cli/lib/update.js';

function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'home23-release-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root; }
function put(root,file,bytes) { fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),bytes); }

test('preparation preserves deployed repairs, reports overlap and captures untracked inputs without touching sources', t=> {
  const root=fixture(t), source=path.join(root,'source'),baseline=path.join(root,'baseline');
  fs.mkdirSync(source);fs.mkdirSync(baseline);
  const git=args=>execFileSync('git',args,{cwd:source,stdio:'pipe'});
  git(['init']);put(source,'src/a.js','original\n');git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','base']);
  put(baseline,'src/a.js','deployed repair\n');put(baseline,'src/keep.js','keep\n');
  put(source,'src/a.js','new improvement\n');put(source,'src/new.js','new\n');
  const before=inventory(baseline);
  const args={baseline,source,baseRef:'HEAD',files:['src/a.js','src/new.js'],output:path.join(root,'out')};
  const report=prepare(args);
  assert.equal(report.activationReady,false);
  assert.equal(report.changes[0].status,'conflict');
  assert.equal(fs.readFileSync(path.join(report.candidate,'src/a.js'),'utf8'),'deployed repair\n');
  assert.equal(fs.readFileSync(path.join(report.candidate,'src/new.js'),'utf8'),'new\n');
  assert.equal(inventory(baseline).digest,before.digest);
  assert.throws(()=>prepare(args),/EEXIST/);
  assert.throws(()=>prepare({...args,output:path.join(source,'candidate')}),/outside/);
});

test('inventory refuses escaping symlinks and input paths reject runtime state', t=>{
  const root=fixture(t);put(root,'outside','private');fs.mkdirSync(path.join(root,'artifact'));fs.symlinkSync('../outside',path.join(root,'artifact','escape'));
  assert.throws(()=>inventory(path.join(root,'artifact')),/escapes/);
  for(const p of ['../x','/etc/passwd','instances/a','config/secrets.yaml','src/../x','ecosystem.config.cjs']) assert.throws(()=>relativeFile(p),/Unsafe/);
});

test('launcher audit detects wrong checkout even when process is online and resolves symlinks', t=>{
  const root=fixture(t),release=path.join(root,'release');put(release,'dist/home.js','');put(release,'scripts/coordination/run.mjs','');put(root,'dist/home.js','');fs.symlinkSync(release,path.join(root,'alias'));
  const saved=[{name:'home23-coordination',script:path.join(release,'scripts/coordination/run.mjs'),cwd:release},{name:'home23-jerry-harness',script:path.join(root,'alias/dist/home.js'),cwd:root,runtime:release}];
  const running=saved.map(x=>({...x,status:'online',pid:123}));
  assert.equal(compareDefinitions({root,release,residents:['jerry'],saved,running}).ok,true);
  saved[1].script='dist/home.js';
  assert.match(compareDefinitions({root,release,residents:['jerry'],saved,running}).problems.join(' '),/saved executable differs/);
});

test('ordinary updater rejects managed installations before reading package or fetching, including check mode', async t=>{
  const root=fixture(t);put(root,'instances/.house/coordination/active-release.json','invalid');
  await assert.rejects(runUpdate(root),/Managed release detected/);
  await assert.rejects(runUpdate(root,true),/Managed release detected/);
});

test('managed build fails before invoking the compiler', async t=>{
  const { build }=await import('../../scripts/release/build.mjs');
  const root=fixture(t);put(root,'instances/.house/coordination/active-release.json','invalid');
  assert.throws(()=>build(root),/Refusing build/);
});

test('candidate verification binds logs and artifact contents; drift invalidates receipt', async t=>{
  const { verify, checkReceipt }=await import('../../scripts/release/verify.mjs');
  const root=fixture(t), baseline=path.join(root,'baseline'),candidate=path.join(root,'candidate'),preparation=path.join(root,'preparation');
  put(baseline,'src/a.js','old');put(candidate,'src/a.js','new');fs.mkdirSync(preparation);
  const inv=inventory(baseline);
  put(preparation,'baseline.json',JSON.stringify(inv));put(preparation,'prepared.json',JSON.stringify({baseline,candidate,baselineDigest:inv.digest}));
  const plan={preparation,receiptDir:path.join(root,'receipt'),allowedChanges:['src/a.js'],checks:[{command:process.execPath,args:['-e','process.stdout.write("verified")'],timeoutMs:2000}]};
  assert.equal(verify(plan).ok,true);
  const receipt=path.join(plan.receiptDir,'verification.json');assert.equal(checkReceipt(receipt).ok,true);
  put(candidate,'src/a.js','changed afterward');assert.throws(()=>checkReceipt(receipt),/stale/);
  assert.throws(()=>verify({...plan,allowedChanges:[],receiptDir:path.join(root,'rejected')}),/Unreviewed/);
});

test('failed verification cannot become a passing receipt', async t=>{
  const { verify, checkReceipt }=await import('../../scripts/release/verify.mjs');
  const root=fixture(t),baseline=path.join(root,'baseline'),candidate=path.join(root,'candidate'),preparation=path.join(root,'preparation');
  put(baseline,'a','same');put(candidate,'a','same');fs.mkdirSync(preparation);const inv=inventory(baseline);
  put(preparation,'baseline.json',JSON.stringify(inv));put(preparation,'prepared.json',JSON.stringify({baseline,candidate,baselineDigest:inv.digest}));
  const receiptDir=path.join(root,'failed');
  assert.equal(verify({preparation,receiptDir,allowedChanges:[],checks:[{command:process.execPath,args:['-e','process.exit(2)'],timeoutMs:2000}]}).ok,false);
  assert.throws(()=>checkReceipt(path.join(receiptDir,'verification.json')),/failed/);
});
