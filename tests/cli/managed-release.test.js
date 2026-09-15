import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { prepare, inventory, relativeFile } from '../../scripts/release/prepare.mjs';
import { verify } from '../../scripts/release/verify.mjs';
import { compareDefinitions, pointerProvenance } from '../../scripts/release/status.mjs';
import { rebind, writeActiveReleaseProvenance } from '../../scripts/release/rebind.mjs';
import { runUpdate } from '../../cli/lib/update.js';

function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'home23-release-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root; }
function put(root,file,bytes) { fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});fs.writeFileSync(path.join(root,file),bytes); }
const TEST_NODE_MODULES=path.dirname(path.dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')));
function installDependencies(root) { fs.symlinkSync(TEST_NODE_MODULES,path.join(root,'node_modules')); }
function verifyPreparation(root, preparation) {
  const receiptDir=path.join(root,'verification');
  const report=verify({preparation,receiptDir,allowedChanges:[],
    checks:[{command:process.execPath,args:['-e','process.exit(0)'],timeoutMs:2000}]});
  return {report,verificationReceipt:path.join(receiptDir,'verification.json')};
}

test('preparation preserves deployed repairs, reports overlap and captures source provenance without touching sources', t=> {
  const root=fixture(t), source=path.join(root,'home23'),baseline=path.join(root,'baseline');
  fs.mkdirSync(source);fs.mkdirSync(baseline);
  const git=args=>execFileSync('git',args,{cwd:source,stdio:'pipe'});
  git(['init','-q','-b','main']);put(source,'src/a.js','original\n');git(['add','.']);git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','base']);
  put(baseline,'src/a.js','deployed repair\n');put(baseline,'src/keep.js','keep\n');
  put(source,'src/a.js','new improvement\n');put(source,'src/new.js','new\n');
  const before=inventory(baseline);
  const args={baseline,source,baseRef:'HEAD',files:['src/a.js','src/new.js'],output:path.join(root,'out')};
  const report=prepare(args);
  assert.equal(report.activationReady,false);
  assert.equal(report.sourceCommit,report.base);
  assert.equal(report.sourceRepo,'home23');
  assert.equal(report.sourceBranch,'main');
  assert.equal(report.sourceDirty,true);
  assert.equal(report.changes[0].status,'conflict');
  assert.equal(fs.readFileSync(path.join(report.candidate,'src/a.js'),'utf8'),'deployed repair\n');
  assert.equal(fs.readFileSync(path.join(report.candidate,'src/new.js'),'utf8'),'new\n');
  assert.equal(inventory(baseline).digest,before.digest);
  assert.throws(()=>prepare(args),/EEXIST/);
  assert.throws(()=>prepare({...args,output:path.join(source,'candidate')}),/outside/);
});

test('preparation records the explicit base commit and clean state when baseRef differs from HEAD', t => {
  const root=fixture(t), source=path.join(root,'home23'), baseline=path.join(root,'baseline');
  fs.mkdirSync(source);fs.mkdirSync(baseline);
  execFileSync('git',['init','-q','-b','feature',source]);
  put(source,'src/a.js','base\n');execFileSync('git',['-C',source,'add','.']);
  execFileSync('git',['-C',source,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','base']);
  const base=execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  put(source,'src/a.js','feature\n');execFileSync('git',['-C',source,'add','.']);
  execFileSync('git',['-C',source,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','feature']);
  put(baseline,'src/a.js','base\n');

  const report=prepare({baseline,source,baseRef:base,files:['src/a.js'],output:path.join(root,'prepared')});

  assert.equal(report.sourceCommit,base);
  assert.equal(report.sourceBranch,'feature');
  assert.equal(report.sourceDirty,false);
});

test('active release annotation carries matched prepared source provenance without selecting a package', t => {
  const root=fixture(t), source=path.join(root,'home23'), baseline=path.join(root,'baseline'), preparation=path.join(root,'prepared');
  fs.mkdirSync(source);fs.mkdirSync(baseline);
  execFileSync('git',['init','-q','-b','main',source]);
  put(source,'src/a.js','source\n');
  execFileSync('git',['-C',source,'add','.']);
  execFileSync('git',['-C',source,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','source']);
  put(baseline,'src/a.js','source\n');
  const prepared=prepare({baseline,source,baseRef:'HEAD',files:['src/a.js'],output:preparation});
  const {report:verification,verificationReceipt}=verifyPreparation(root,preparation);
  const releaseId=verification.candidateDigest.slice(0,40);
  const installation=path.join(root,'installation'), runtime=path.join(installation,'instances/.house/coordination');
  fs.mkdirSync(installation);installDependencies(installation);
  fs.mkdirSync(path.join(runtime,'releases'),{recursive:true});
  fs.cpSync(prepared.candidate,path.join(runtime,'releases',releaseId),{recursive:true});
  const pointer={schemaVersion:2,releaseId,predecessorReleaseId:'b'.repeat(40),activatedAt:'2026-09-15T12:00:00.000Z',residents:{jerry:{keyVersion:1}}};
  put(installation,'instances/.house/coordination/active-release.json',JSON.stringify(pointer));

  const next=writeActiveReleaseProvenance({root:installation,releaseId,preparation,verificationReceipt});

  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtime,'active-release.json'),'utf8')),next);
  assert.equal(next.releaseId,pointer.releaseId);
  assert.equal(next.predecessorReleaseId,pointer.predecessorReleaseId);
  assert.equal(next.activatedAt,pointer.activatedAt);
  assert.equal(next.sourceCommit,prepared.sourceCommit);
  assert.equal(next.sourceRepo,'home23');
  assert.equal(next.sourceBranch,'main');
  assert.equal(next.sourceDirty,false);
  assert.equal(next.preparedAt,prepared.preparedAt);
  assert.equal(next.sourceProvenance,'prepared artifact verification matched selected release');
});

test('active release annotation writes explicit null provenance for a legacy selected package', t => {
  const root=fixture(t), installation=path.join(root,'installation'), runtime=path.join(installation,'instances/.house/coordination');
  fs.mkdirSync(installation);installDependencies(installation);
  const releaseId='b'.repeat(40);put(installation,`instances/.house/coordination/releases/${releaseId}/package.json`,'{}\n');
  put(installation,'instances/.house/coordination/active-release.json',JSON.stringify({schemaVersion:2,releaseId,residents:{jerry:{keyVersion:1}}}));
  const pointerFile=path.join(runtime,'active-release.json'),before=fs.readFileSync(pointerFile);

  assert.throws(()=>writeActiveReleaseProvenance({root:installation,releaseId}),/explicit sourceProvenanceUnavailable/);
  assert.equal(fs.readFileSync(pointerFile).equals(before),true);

  const next=writeActiveReleaseProvenance({root:installation,releaseId,
    sourceProvenanceUnavailable:'legacy release has no prepared.json or verification receipt'});

  assert.equal(next.sourceCommit,null);
  assert.equal(next.sourceRepo,null);
  assert.equal(next.sourceBranch,null);
  assert.equal(next.sourceDirty,null);
  assert.equal(next.preparedAt,null);
  assert.equal(next.sourceProvenance,'legacy release has no prepared.json or verification receipt');
});

test('active release annotation refuses to select a different package', t => {
  const root=fixture(t), installation=path.join(root,'installation'), releaseId='a'.repeat(40);
  fs.mkdirSync(installation);installDependencies(installation);
  put(installation,`instances/.house/coordination/releases/${releaseId}/package.json`,'{}\n');
  const pointer=JSON.stringify({schemaVersion:2,releaseId,residents:{jerry:{keyVersion:1}}});
  put(installation,'instances/.house/coordination/active-release.json',pointer);

  assert.throws(()=>writeActiveReleaseProvenance({root:installation,releaseId:'b'.repeat(40)}),/does not select/);
  assert.equal(fs.readFileSync(path.join(installation,'instances/.house/coordination/active-release.json'),'utf8'),pointer);
});

test('active release annotation rejects stale evidence or different installed contents', t => {
  const root=fixture(t), source=path.join(root,'home23'), baseline=path.join(root,'baseline'), preparation=path.join(root,'prepared');
  fs.mkdirSync(source);fs.mkdirSync(baseline);
  execFileSync('git',['init','-q','-b','main',source]);put(source,'src/a.js','source\n');
  execFileSync('git',['-C',source,'add','.']);
  execFileSync('git',['-C',source,'-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-q','-m','source']);
  put(baseline,'src/a.js','source\n');
  const prepared=prepare({baseline,source,baseRef:'HEAD',files:['src/a.js'],output:preparation});
  const {report:verification,verificationReceipt}=verifyPreparation(root,preparation);
  const releaseId=verification.candidateDigest.slice(0,40),installation=path.join(root,'installation');
  fs.mkdirSync(installation);installDependencies(installation);
  put(installation,`instances/.house/coordination/releases/${releaseId}/wrong.txt`,'not the verified candidate\n');
  const pointerFile=path.join(installation,'instances/.house/coordination/active-release.json');
  put(installation,'instances/.house/coordination/active-release.json',JSON.stringify({schemaVersion:2,releaseId,residents:{jerry:{keyVersion:1}}}));
  const before=fs.readFileSync(pointerFile);

  assert.throws(()=>writeActiveReleaseProvenance({root:installation,releaseId,preparation,verificationReceipt}),/selected release contents changed/i);
  assert.equal(fs.readFileSync(pointerFile).equals(before),true);

  fs.rmSync(path.join(installation,'instances/.house/coordination/releases',releaseId),{recursive:true});
  fs.cpSync(prepared.candidate,path.join(installation,'instances/.house/coordination/releases',releaseId),{recursive:true});
  fs.writeFileSync(verificationReceipt,JSON.stringify({schemaVersion:1,ok:true,candidate:prepared.candidate,
    candidateDigest:verification.candidateDigest}));
  assert.throws(()=>writeActiveReleaseProvenance({root:installation,releaseId,preparation,verificationReceipt}),/complete passing artifact evidence/i);
  assert.equal(fs.readFileSync(pointerFile).equals(before),true);
});

test('pointer provenance write does not contend with the supervisor lifetime lock', t => {
  const root=fixture(t),installation=path.join(root,'installation'),releaseId='b'.repeat(40);
  fs.mkdirSync(installation);installDependencies(installation);
  put(installation,`instances/.house/coordination/releases/${releaseId}/package.json`,'{}\n');
  put(installation,'instances/.house/coordination/active-release.json',JSON.stringify({schemaVersion:2,releaseId,residents:{jerry:{keyVersion:1}}}));
  const maintenance=path.join(installation,'instances/.house/maintenance');fs.mkdirSync(maintenance,{recursive:true});
  const Database=createRequire(import.meta.url)('better-sqlite3');
  const supervisor=new Database(path.join(maintenance,'supervisor-lock.sqlite3'));
  supervisor.exec('CREATE TABLE IF NOT EXISTS ownership (id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE');
  try {
    const next=writeActiveReleaseProvenance({root:installation,releaseId,
      sourceProvenanceUnavailable:'legacy release has no prepared source evidence'});
    assert.equal(next.sourceCommit,null);
  } finally { supervisor.exec('ROLLBACK');supervisor.close(); }
});

test('rebind check requires evidence or surfaces the exact explicit legacy reason', async t => {
  const root=fixture(t),releaseId='b'.repeat(40),current={releaseId,ok:true,problems:[],processes:[]};
  put(root,`instances/.house/coordination/releases/${releaseId}/package.json`,'{}\n');
  put(root,'instances/.house/coordination/active-release.json',JSON.stringify({schemaVersion:2,releaseId,residents:{jerry:{keyVersion:1}}}));
  const plan={root,releaseId,expectedRunning:[],receipt:path.join(root,'receipt.json')};
  const inspectPlan=()=>({current,blockers:[],commands:[],plannedProvenance:null});

  await assert.rejects(rebind(plan,false,{inspectPlan}),/explicit sourceProvenanceUnavailable/);

  const reason='legacy release has no prepared source evidence';
  const result=await rebind({...plan,sourceProvenanceUnavailable:reason},false,{inspectPlan});
  assert.equal(result.executed,false);
  assert.equal(result.plannedProvenance.sourceCommit,null);
  assert.equal(result.plannedProvenance.sourceProvenance,reason);
});

test('release status keeps old pointer schemas valid while projecting provenance as explicitly unknown', () => {
  assert.deepEqual(pointerProvenance({schemaVersion:1,releaseId:'a'.repeat(40)}),{
    sourceCommit:null,sourceRepo:null,sourceBranch:null,sourceDirty:null,preparedAt:null,
    sourceProvenance:'active release record has no recorded source provenance',
  });
  assert.deepEqual(pointerProvenance({
    schemaVersion:2,releaseId:'a'.repeat(40),sourceCommit:'c'.repeat(40),sourceRepo:'home23',sourceBranch:'main',
    sourceDirty:false,preparedAt:'2026-09-15T12:00:00.000Z',sourceProvenance:'prepared artifact verification matched selected release',
  }),{
    sourceCommit:'c'.repeat(40),sourceRepo:'home23',sourceBranch:'main',sourceDirty:false,preparedAt:'2026-09-15T12:00:00.000Z',
    sourceProvenance:'prepared artifact verification matched selected release',
  });
  assert.deepEqual(pointerProvenance({schemaVersion:2,releaseId:'a'.repeat(40),sourceCommit:null,sourceRepo:null,
    sourceBranch:null,sourceDirty:null,preparedAt:null,sourceProvenance:'legacy activation lacked prepared.json'}),{
    sourceCommit:null,sourceRepo:null,sourceBranch:null,sourceDirty:null,preparedAt:null,
    sourceProvenance:'legacy activation lacked prepared.json',
  });
  assert.throws(()=>pointerProvenance({schemaVersion:2,releaseId:'a'.repeat(40),sourceCommit:null}),/Invalid recorded source provenance/);
  assert.throws(()=>pointerProvenance({schemaVersion:2,releaseId:'a'.repeat(40),sourceRepo:'home23'}),/Invalid recorded source provenance/);
  assert.throws(()=>pointerProvenance({schemaVersion:2,releaseId:'a'.repeat(40),sourceCommit:'short'}),/Invalid recorded source provenance/);
});

test('rebind publishes provenance only after matching runtime readback succeeds', async t => {
  const root=fixture(t), receipt=path.join(root,'rebind.json'), releaseId='a'.repeat(40), events=[];
  const current={releaseId,ok:false,problems:[],processes:[]};
  const plan={root,releaseId,expectedRunning:[],receipt,preparation:'/prepared',verificationReceipt:'/verification'};
  const provenance={sourceCommit:'c'.repeat(40),sourceRepo:'home23',sourceBranch:'main',sourceDirty:false,
    preparedAt:'2026-09-15T12:00:00.000Z',sourceProvenance:'prepared artifact verification matched selected release'};
  const dependencies={
    inspectPlan:()=>({current,blockers:[],commands:[],plannedProvenance:provenance}),
    getStatus:()=>{events.push('runtime-readback');return {...current,ok:true};},
    writeProvenance:()=>{events.push('provenance-write');return {...current,...provenance};},
    validateProvenancePlan:()=>provenance,
    attempts:1,
  };

  const result=await rebind(plan,true,dependencies);

  assert.deepEqual(events,['runtime-readback','provenance-write']);
  assert.equal(result.ok,true);
  assert.equal(result.runtimeRebound,true);
  assert.deepEqual(result.sourceProvenance,provenance);
});

test('failed rebind readback never annotates source provenance', async t => {
  const root=fixture(t), receipt=path.join(root,'rebind-failed.json'), releaseId='a'.repeat(40);let wrote=false;
  const current={releaseId,ok:false,problems:[],processes:[]};
  const plan={root,releaseId,expectedRunning:[],receipt};
  const pointerFile=path.join(root,'instances/.house/coordination/active-release.json');
  put(root,'instances/.house/coordination/active-release.json',JSON.stringify({schemaVersion:2,releaseId,residents:{jerry:{keyVersion:1}}}));
  const pointerBefore=fs.readFileSync(pointerFile);

  await assert.rejects(rebind(plan,true,{
    inspectPlan:()=>({current,blockers:[],commands:[],plannedProvenance:null}),
    getStatus:()=>current,
    writeProvenance:()=>{wrote=true;},
    validateProvenancePlan:()=>null,
    attempts:1,
  }),/readback failed/);

  assert.equal(wrote,false);
  assert.equal(fs.readFileSync(pointerFile).equals(pointerBefore),true);
  assert.equal(JSON.parse(fs.readFileSync(receipt,'utf8')).runtimeRebound,false);
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

test('status CLI executes through a directory symlink and fails closed instead of silently succeeding', t => {
  const root = fixture(t), alias = path.join(root, 'alias');
  fs.symlinkSync(path.resolve('scripts/release'), alias);
  assert.throws(() => execFileSync(process.execPath, [path.join(alias, 'status.mjs'), root], { stdio: 'pipe' }), e => {
    assert.equal(e.status, 2);
    assert.match(e.stderr.toString(), /Release inspection failed/);
    return true;
  });
});

test('managed rebind rejects own-host ancestry and limits commands to named registrations', async () => {
  const { assertIndependent, restartCommands } = await import('../../scripts/release/rebind.mjs');
  assert.throws(() => assertIndependent([10], 30, id => ({30:20,20:10})[id]), /descendant/);
  assert.doesNotThrow(() => assertIndependent([10], 30, () => 1));
  assert.throws(() => restartCommands('/install', ['all']), /Unmanaged/);
  assert.deepEqual(restartCommands('/install', ['home23-jerry-harness']), [
    ['delete', 'home23-jerry-harness'],
    ['start', '/install/ecosystem.config.cjs', '--only', 'home23-jerry-harness', '--update-env'],
  ]);
});

test('restart helper can be imported by an operator stdin command', () => {
  const moduleUrl = new URL('../../scripts/release/rebind.mjs', import.meta.url).href;
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '-'], {
    input: `await import(${JSON.stringify(moduleUrl)});`, stdio: ['pipe', 'pipe', 'pipe'],
  }));
});

test('installed supervisor bundle imports without prepare tooling', t => {
  const root=fixture(t),releaseScripts=path.join(root,'scripts/release');fs.mkdirSync(releaseScripts,{recursive:true});
  for(const name of ['supervisor.mjs','status.mjs','rebind.mjs']) {
    fs.copyFileSync(new URL(`../../scripts/release/${name}`,import.meta.url),path.join(releaseScripts,name));
  }
  const importer=path.join(root,'import.mjs');
  fs.writeFileSync(importer,`await import(${JSON.stringify(new URL(`file://${path.join(releaseScripts,'supervisor.mjs')}`).href)});\n`);
  assert.doesNotThrow(()=>execFileSync(process.execPath,[importer],{stdio:['ignore','pipe','pipe']}));
});
