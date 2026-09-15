import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { workspaceStatus, formatStatus } from '../../scripts/development/status.mjs';
import { prepare } from '../../scripts/release/prepare.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23 workspace '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['home23', 'home23-apple']) {
    const dir = path.join(root, name); fs.mkdirSync(dir);
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'base']);
    execFileSync('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  }
  const backend = path.join(root, 'home23');
  return { root, backend, apple: path.join(root, 'home23-apple'),
    backendBase: execFileSync('git', ['-C', backend, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() };
}

function receipt(commit, overrides = {}) {
  return { schemaVersion: 1, recordedAt: '2026-09-15T12:00:00.000Z', commit, repo: 'home23', branch: 'main',
    summary: 'Verified repair', verification: 'tests/repair.test.js', surfaces: ['fixture'], deployed: false,
    deployedReleaseId: null, deployedAt: null, recordedBy: 'test', ...overrides };
}

function writeLedger(root, records) {
  const file = path.join(root, 'state', 'land-receipts.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

test('reports dirty source and independent main comparisons without altering files or HEAD', t => {
  const f = fixture(t);
  const draft = path.join(f.apple, 'unfinished.swift'); fs.writeFileSync(draft, 'keep my draft');
  const head = execFileSync('git', ['-C', f.apple, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const report = workspaceStatus(f);
  assert.equal(report.repositories.apple.changedFiles.length, 1);
  assert.deepEqual(report.repositories.backend.main, { ref: 'origin/main', localOnly: 0, remoteOnly: 0 });
  assert.equal(fs.readFileSync(draft, 'utf8'), 'keep my draft');
  assert.equal(execFileSync('git', ['-C', f.apple, 'rev-parse', 'HEAD'], { encoding: 'utf8' }), head);
  assert.match(formatStatus(report), /preserve 1/);
  assert.equal(report.runtime, null);
});

test('marks stale release baseline and mismatched phone selection without reading private state', t => {
  const f = fixture(t); const installation = path.join(f.root, 'live');
  const house = path.join(installation, 'instances/.house'); fs.mkdirSync(path.join(house, 'coordination'), { recursive: true });
  const write = (p, x) => fs.writeFileSync(path.join(house, p), JSON.stringify(x));
  write('coordination/active-release.json', { schemaVersion: 2, releaseId: 'a'.repeat(40) });
  write('source-authority.json', { deployedReleaseId: 'b'.repeat(40) });
  write('home23-ios.json', { installedBuild: 135, sourceRoot: '/different/source', receipt: '/private/receipt', secret: 'never-report' });
  const report = workspaceStatus({ ...f, installation });
  assert.equal(report.selected.phone.build, 135);
  assert.equal(report.concerns.length, 2);
  assert.ok(!JSON.stringify(report).includes('never-report'));
  assert.equal(report.selected.phone.evidence, 'installation record');
  assert.match(formatStatus(report), /Release preparation base: unknown .*no recorded source provenance/);
  assert.doesNotMatch(formatStatus(report), /running package/);
});

test('missing active release remains unavailable while the ledger is still reported', t => {
  const f=fixture(t),installation=path.join(f.root,'live');
  fs.mkdirSync(path.join(installation,'instances/.house/coordination'),{recursive:true});
  writeLedger(f.backend,[receipt(f.backendBase)]);

  const report=workspaceStatus({...f,installation});
  const text=formatStatus(report);

  assert.equal(report.selected.backendRelease,null);
  assert.equal(report.selected.backendSource,null);
  assert.deepEqual(report.landReceipts.undeployed.map(value=>value.commit),[f.backendBase]);
  assert.match(text,/Release preparation base: unavailable: active release record does not exist/);
  assert.match(text,/Undeployed land receipts: 1/);
  assert.doesNotMatch(text,/running package/);
});

test('malformed active release and runtime inspection errors never suppress the ledger', t => {
  const f=fixture(t),installation=path.join(f.root,'live'),house=path.join(installation,'instances/.house');
  fs.mkdirSync(path.join(house,'coordination'),{recursive:true});
  fs.writeFileSync(path.join(house,'coordination/active-release.json'),'{broken}\n');
  writeLedger(f.backend,[receipt(f.backendBase)]);

  for(const runtime of [false,true]) {
    const report=workspaceStatus({...f,installation,runtime});
    const text=formatStatus(report);
    assert.equal(report.selected.backendRelease,null);
    assert.match(report.selected.backendReleaseError,/invalid JSON/);
    assert.match(text,/Undeployed land receipts: 1/);
    assert.doesNotMatch(text,/running package/);
    if(runtime) assert.match(report.runtime.error,/Release inspection failed|Unexpected token|JSON/);
  }
});

test('unsupported active release schema remains unavailable rather than becoming deployment evidence', t => {
  const f=fixture(t),installation=path.join(f.root,'live'),house=path.join(installation,'instances/.house');
  fs.mkdirSync(path.join(house,'coordination'),{recursive:true});
  fs.writeFileSync(path.join(house,'coordination/active-release.json'),JSON.stringify({schemaVersion:99,releaseId:'a'.repeat(40)}));
  writeLedger(f.backend,[receipt(f.backendBase)]);

  const report=workspaceStatus({...f,installation});

  assert.equal(report.selected.backendRelease,null);
  assert.match(report.selected.backendReleaseError,/unsupported schemaVersion/);
  assert.equal(report.landReceipts.undeployed.length,1);
  assert.match(formatStatus(report),/Release preparation base: unavailable/);
});

test('legacy active release keeps source provenance explicitly unknown', t => {
  const f=fixture(t),installation=path.join(f.root,'live'),house=path.join(installation,'instances/.house');
  fs.mkdirSync(path.join(house,'coordination'),{recursive:true});
  fs.writeFileSync(path.join(house,'coordination/active-release.json'),JSON.stringify({
    schemaVersion:2,releaseId:'a'.repeat(40),residents:{jerry:{keyVersion:1}},
  }));

  const report=workspaceStatus({...f,installation});

  assert.equal(report.selected.backendSource.preparationBaseCommit,null);
  assert.equal(report.selected.backendSource.dirty,null);
  assert.match(report.selected.backendSource.provenance,/no recorded source provenance/);
  assert.match(formatStatus(report),/Release preparation base: unknown/);
});

test('reports preparation-base checkout history separately from folded undeployed land receipts', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.backend, 'later.txt'), 'later\n');
  execFileSync('git', ['-C', f.backend, 'add', 'later.txt']);
  execFileSync('git', ['-C', f.backend, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'not running']);
  const later = execFileSync('git', ['-C', f.backend, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(f.backend, 'unrecorded.txt'), 'unrecorded\n');
  execFileSync('git', ['-C', f.backend, 'add', 'unrecorded.txt']);
  execFileSync('git', ['-C', f.backend, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'unrecorded commit']);
  const unrecorded = execFileSync('git', ['-C', f.backend, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const releaseId = 'a'.repeat(40), installation = path.join(f.root, 'live');
  const house = path.join(installation, 'instances/.house');
  fs.mkdirSync(path.join(house, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(house, 'coordination/active-release.json'), JSON.stringify({
    schemaVersion: 2, releaseId, residents: { jerry: { keyVersion: 1 } },
    sourceCommit: f.backendBase, sourceRepo: 'home23', sourceBranch: 'main',
    sourceDirty: false, preparedAt: '2026-09-15T11:00:00.000Z',
    sourceProvenance: 'prepared artifact verification matched selected release',
  }));
  writeLedger(f.backend, [
    receipt(f.backendBase, { summary: 'Already running' }),
    { schemaVersion: 1, recordType: 'deployment', recordedAt: '2026-09-15T12:30:00.000Z', commit: f.backendBase, releaseId },
    receipt(later, { summary: 'Still waiting', surfaces: ['mail', 'reminders'] }),
  ]);
  const pointerFile=path.join(house,'coordination/active-release.json'),ledgerFile=path.join(f.backend,'state/land-receipts.jsonl');
  const before={head:execFileSync('git',['-C',f.backend,'rev-parse','HEAD'],{encoding:'utf8'}),
    status:execFileSync('git',['-C',f.backend,'status','--porcelain=v1'],{encoding:'utf8'}),
    pointer:fs.readFileSync(pointerFile),ledger:fs.readFileSync(ledgerFile)};
  const expectedHistory=execFileSync('git',['--no-optional-locks','-C',f.backend,'log','--oneline',`${f.backendBase}..HEAD`],{encoding:'utf8'}).trimEnd().split('\n');

  const report = workspaceStatus({ ...f, installation });

  assert.equal(report.selected.backendSource.preparationBaseCommit, f.backendBase);
  assert.deepEqual(report.selected.backendSource.commitsSincePreparationBase.lines, expectedHistory);
  assert.deepEqual(report.landReceipts.undeployed.map(value => value.commit), [later]);
  assert.equal(report.landReceipts.undeployed.some(value=>value.commit===unrecorded),false);
  assert.equal(execFileSync('git',['-C',f.backend,'rev-parse','HEAD'],{encoding:'utf8'}),before.head);
  assert.equal(execFileSync('git',['-C',f.backend,'status','--porcelain=v1'],{encoding:'utf8'}),before.status);
  assert.equal(fs.readFileSync(pointerFile).equals(before.pointer),true);
  assert.equal(fs.readFileSync(ledgerFile).equals(before.ledger),true);
  const text = formatStatus(report);
  assert.match(text, new RegExp(`Release preparation base: home23 ${f.backendBase}`));
  assert.match(text, /Source commits since preparation base in inspected checkout: 2/);
  assert.match(text, /Undeployed land receipts: 1/);
  assert.match(text, /Still waiting \[mail, reminders\]/);
});

test('reports a prepared base as comparison context without claiming selected source bytes are not running', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.backend, 'src'));
  fs.writeFileSync(path.join(f.backend, 'src/a.js'), 'base\n');
  execFileSync('git', ['-C', f.backend, 'add', 'src/a.js']);
  execFileSync('git', ['-C', f.backend, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'reviewed base']);
  const base = execFileSync('git', ['-C', f.backend, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const baseline = path.join(f.root, 'baseline');
  fs.mkdirSync(path.join(baseline, 'src'), { recursive: true });
  fs.writeFileSync(path.join(baseline, 'src/a.js'), 'base\n');

  fs.writeFileSync(path.join(f.backend, 'src/a.js'), 'selected candidate bytes\n');
  execFileSync('git', ['-C', f.backend, 'add', 'src/a.js']);
  execFileSync('git', ['-C', f.backend, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'selected candidate change']);
  const selectedCommit = execFileSync('git', ['-C', f.backend, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const prepared = prepare({
    baseline,
    source: f.backend,
    baseRef: base,
    files: ['src/a.js'],
    output: path.join(f.root, 'preparation'),
  });
  assert.equal(fs.readFileSync(path.join(prepared.candidate, 'src/a.js'), 'utf8'), 'selected candidate bytes\n');

  const installation = path.join(f.root, 'live');
  const house = path.join(installation, 'instances/.house');
  fs.mkdirSync(path.join(house, 'coordination'), { recursive: true });
  fs.writeFileSync(path.join(house, 'coordination/active-release.json'), JSON.stringify({
    schemaVersion: 2,
    releaseId: 'a'.repeat(40),
    residents: { jerry: { keyVersion: 1 } },
    sourceCommit: prepared.sourceCommit,
    sourceRepo: prepared.sourceRepo,
    sourceBranch: prepared.sourceBranch,
    sourceDirty: prepared.sourceDirty,
    preparedAt: prepared.preparedAt,
    sourceProvenance: 'prepared artifact verification matched selected release',
  }));

  const report = workspaceStatus({ ...f, installation });
  const source = report.selected.backendSource;
  const text = formatStatus(report);

  assert.equal(source.preparationBaseCommit, base);
  assert.match(source.commitsSincePreparationBase.lines[0], new RegExp(`^${selectedCommit.slice(0, 7)} selected candidate change$`));
  assert.match(text, new RegExp(`Release preparation base: home23 ${base}`));
  assert.match(text, /Source commits since preparation base in inspected checkout: 1/);
  assert.doesNotMatch(text, /Deployed source:|Source commits not running:/);
});

test('malformed or missing ledger is unavailable rather than reported as zero', t => {
  const f = fixture(t);
  const missing = workspaceStatus(f);
  assert.equal(missing.landReceipts.available, false);
  assert.match(formatStatus(missing), /ledger unavailable: .*does not exist/);
  writeLedger(f.backend, [receipt(f.backendBase)]);
  fs.appendFileSync(path.join(f.backend, 'state/land-receipts.jsonl'), '{broken}\n');
  const malformed = workspaceStatus(f);
  assert.equal(malformed.landReceipts.available, false);
  assert.match(formatStatus(malformed), /ledger unavailable: .*line 2/);
  assert.doesNotMatch(formatStatus(malformed), /Undeployed land receipts: 0/);
});

test('missing repository is unavailable rather than clean, and remote credentials are omitted', t => {
  const f = fixture(t);
  execFileSync('git', ['-C', f.backend, 'remote', 'add', 'origin', 'https://user:private-token@example.invalid/home23.git']);
  const report = workspaceStatus({ ...f, apple: path.join(f.root, 'absent') });
  assert.ok(report.repositories.apple.error);
  assert.equal(report.repositories.backend.remote, 'https://example.invalid/home23.git');
  assert.ok(!JSON.stringify(report).includes('private-token'));
});
