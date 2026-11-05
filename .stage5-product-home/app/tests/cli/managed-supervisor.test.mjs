import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest } from '../../scripts/release/supervisor.mjs';
import { assertIndependent, restartCommands } from '../../scripts/release/rebind.mjs';
const id = '11111111-1111-4111-8111-111111111111';
const base = { id, action: 'restart-managed', releaseId: 'a'.repeat(40), reason: 'Load authorized runtime settings', createdAt: 1000, notBefore: 31000, expiresAt: 100000 };
test('restart request is pinned to the selected release and expires', () => {
  assert.doesNotThrow(() => validateRequest(base, base.releaseId, 32000));
  assert.throws(() => validateRequest(base, 'b'.repeat(40), 32000), /stale-release/);
  assert.throws(() => validateRequest(base, base.releaseId, 100000), /expired/);
});
test('reject arbitrary actions, paths and invalid timing', () => {
  for (const change of [{action:'exec'}, {id:'../../payload'}, {reason:''}, {expiresAt:Infinity}, {notBefore:NaN}, {expiresAt:90000000}]) {
    assert.throws(() => validateRequest({...base,...change}, base.releaseId, 32000));
  }
});
test('independent service retains the target-process ancestry guard', () => {
  assert.throws(() => assertIndependent([10], 30, pid => ({30:20,20:10})[pid]), /descendant/);
  assert.doesNotThrow(() => assertIndependent([10], 40, () => 1));
});
test('restart scope cannot reach dashboard, shell or unrelated processes', () => {
  assert.throws(() => restartCommands('/installation', ['home23-jerry-dash']), /Unmanaged/);
  assert.throws(() => restartCommands('/installation', ['all']), /Unmanaged/);
  const commands = restartCommands('/installation', ['home23-coordination']);
  assert.deepEqual(commands, [['delete','home23-coordination'],['start','/installation/instances/.house/coordination/ecosystem.config.cjs','--only','home23-coordination','--update-env']]);
});

test('queue writes complete durable requests and joins duplicates without resetting cooldown', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { requestRestart } = await import('../../scripts/release/supervisor.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-supervisor-'));
  try {
    const dir = path.join(root, 'instances/.house/maintenance'); fs.mkdirSync(dir, {recursive:true});
    fs.writeFileSync(path.join(dir,'policy.json'), JSON.stringify({enabled:true,allowManagedRestart:true}));
    const getStatus = () => ({ok:true,releaseId:'a'.repeat(40)});
    const first = requestRestart(root, 'Apply runtime settings', getStatus);
    const second = requestRestart(root, 'Same pending maintenance', getStatus);
    assert.equal(first.id, second.id);
    assert.equal(first.notBefore, second.notBefore);
    assert.equal(first.state, 'queued');
    assert.deepEqual(fs.readdirSync(path.join(dir,'requests')), [first.id+'.json']);
    fs.writeFileSync(path.join(dir,'policy.json'), JSON.stringify({enabled:false}));
    assert.throws(() => requestRestart(root, 'Disabled request', getStatus), /not enabled/);
  } finally { fs.rmSync(root, {recursive:true,force:true}); }
});

test('CLI entry point executes status rather than silently importing', async () => {
  const {execFileSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/release/supervisor.mjs', import.meta.url)), 'status', '/nonexistent-home23-fixture'], {encoding:'utf8'});
  assert.deepEqual(JSON.parse(output), []);
});

test('nested PM2 launch cannot inherit supervisor identity or arguments', async () => {
  const {operatorEnvironment} = await import('../../scripts/release/supervisor.mjs');
  assert.deepEqual(operatorEnvironment({HOME:'/home/operator',PATH:'/bin',PM2_HOME:'/pm2',name:'supervisor',args:'bad',pm_id:'99',pm_exec_path:'/wrong',NODE_OPTIONS:'--require /wrong'}), {HOME:'/home/operator',PATH:'/bin',PM2_HOME:'/pm2'});
});

test('exclusive service lock rejects a second owner and releases for restart', async () => {
  const fs = await import('node:fs');const os = await import('node:os');const path = await import('node:path');
  const {default:Database} = await import('better-sqlite3');
  const {acquireSupervisorLock} = await import('../../scripts/release/supervisor.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'home23-service-lock-'));
  try {
    const release = acquireSupervisorLock(dir, Database);
    assert.throws(() => acquireSupervisorLock(dir, Database), /Another maintenance supervisor/);
    release();
    fs.writeFileSync(path.join(dir,'supervisor.lock'),'999999');
    const recovered = acquireSupervisorLock(dir, Database); recovered();
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
