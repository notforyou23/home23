import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  foldLandReceipts,
  loadLandReceipts,
  recordDeployment,
  recordLandReceipt,
  runLandReceiptCommand,
} from '../../scripts/development/land-receipt.mjs';

const RELEASE_ID = 'a'.repeat(40);

function fixture(t, repoName = 'home23') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-land-receipt-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repoRoot = path.join(parent, repoName);
  fs.mkdirSync(repoRoot);
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  fs.writeFileSync(path.join(repoRoot, 'fixture.txt'), 'first\n');
  execFileSync('git', ['-C', repoRoot, 'add', 'fixture.txt']);
  execFileSync('git', ['-C', repoRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'first']);
  const first = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(repoRoot, 'fixture.txt'), 'second\n');
  execFileSync('git', ['-C', repoRoot, 'add', 'fixture.txt']);
  execFileSync('git', ['-C', repoRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'second']);
  const second = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const ledgerPath = path.join(repoRoot, 'state', 'land-receipts.jsonl');
  return { parent, repoRoot, ledgerPath, first, second };
}

function installCli(fixtureValue, { dependencies = true } = {}) {
  const target = path.join(fixtureValue.repoRoot, 'scripts', 'development', 'land-receipt.mjs');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(fileURLToPath(new URL('../../scripts/development/land-receipt.mjs', import.meta.url)), target);
  if (dependencies) {
    const dependencyRoot = path.dirname(path.dirname(createRequire(import.meta.url).resolve('better-sqlite3/package.json')));
    fs.symlinkSync(dependencyRoot, path.join(fixtureValue.repoRoot, 'node_modules'));
  }
  return target;
}

function runCli(script, cwd, args) {
  return new Promise(resolve => execFile(process.execPath, [script, ...args], { cwd }, (error, stdout, stderr) => {
    resolve({ status: error?.code ?? 0, stdout, stderr });
  }));
}

const details = {
  summary: 'Repair the fixture surface',
  verification: 'tests/fixture.test.js',
  surfaces: ['fixture'],
  recordedBy: 'test',
};

test('deployment appends a new line without changing the landed receipt bytes', (t) => {
  const f = fixture(t);
  recordLandReceipt({ ...f, commit: f.first.slice(0, 8), ...details, now: () => new Date('2026-09-15T12:00:00.000Z') });
  const before = fs.readFileSync(f.ledgerPath);
  const firstLine = before.toString('utf8').trimEnd();

  recordDeployment({ ledgerPath: f.ledgerPath, commit: f.first.slice(0, 8), releaseId: RELEASE_ID, now: () => new Date('2026-09-15T13:00:00.000Z') });

  const after = fs.readFileSync(f.ledgerPath);
  assert.equal(after.subarray(0, before.length).equals(before), true);
  assert.equal(after.toString('utf8').split('\n')[0], firstLine);
  assert.equal(after.toString('utf8').trimEnd().split('\n').length, 2);
});

test('append preserves a valid final record that lacks a terminal newline', (t) => {
  const f = fixture(t);
  recordLandReceipt({ ...f, commit: f.first, ...details });
  const original = fs.readFileSync(f.ledgerPath);
  fs.truncateSync(f.ledgerPath, original.length - 1);
  const before = fs.readFileSync(f.ledgerPath);

  recordLandReceipt({ ...f, commit: f.second, ...details, summary: 'Second repair' });

  const after = fs.readFileSync(f.ledgerPath);
  assert.equal(after.subarray(0, before.length).equals(before), true);
  assert.deepEqual(loadLandReceipts(f.ledgerPath).map(value => value.commit), [f.first, f.second]);
});

test('record refuses a duplicate full commit and leaves the ledger byte-identical', (t) => {
  const f = fixture(t);
  recordLandReceipt({ ...f, commit: f.first, ...details });
  const before = fs.readFileSync(f.ledgerPath);

  assert.throws(
    () => recordLandReceipt({ ...f, commit: f.first.slice(0, 10), ...details }),
    /already has a land receipt/,
  );
  assert.equal(fs.readFileSync(f.ledgerPath).equals(before), true);
});

test('record refuses a commit that does not exist and does not create a ledger', (t) => {
  const f = fixture(t);
  assert.throws(
    () => recordLandReceipt({ ...f, commit: 'f'.repeat(40), ...details }),
    /does not exist/,
  );
  assert.equal(fs.existsSync(f.ledgerPath), false);
});

test('record refuses a commit that is not on the checkout branch', (t) => {
  const f = fixture(t);
  execFileSync('git', ['-C', f.repoRoot, 'checkout', '-q', '--orphan', 'other']);
  execFileSync('git', ['-C', f.repoRoot, 'rm', '-q', '-rf', '.']);
  fs.writeFileSync(path.join(f.repoRoot, 'other.txt'), 'other\n');
  execFileSync('git', ['-C', f.repoRoot, 'add', 'other.txt']);
  execFileSync('git', ['-C', f.repoRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'other']);
  const unrelated = execFileSync('git', ['-C', f.repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', f.repoRoot, 'checkout', '-q', 'main']);

  assert.throws(() => recordLandReceipt({ ...f, commit: unrelated, ...details }), /not reachable from branch main/);
  assert.equal(fs.existsSync(f.ledgerPath), false);
});

test('backend CLI derives home23-apple identity from its actual working checkout', async (t) => {
  const f = fixture(t), script = installCli(f), appleRoot = path.join(f.parent, 'home23-apple');
  fs.mkdirSync(appleRoot);
  execFileSync('git', ['init', '-q', '-b', 'main', appleRoot]);
  fs.writeFileSync(path.join(appleRoot, 'fixture.swift'), 'repair\n');
  execFileSync('git', ['-C', appleRoot, 'add', 'fixture.swift']);
  execFileSync('git', ['-C', appleRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'repair']);
  const commit = execFileSync('git', ['-C', appleRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const result = await runCli(script, appleRoot, ['record', '--commit', commit, '--summary', details.summary,
    '--verification', details.verification, '--surfaces', 'apple', '--recorded-by', 'apple-cli-test']);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.repo, 'home23-apple');
  assert.equal(receipt.branch, 'main');
  assert.equal(receipt.commit, commit);
  assert.equal(fs.existsSync(path.join(appleRoot, 'state', 'land-receipts.jsonl')), false);
  assert.equal(loadLandReceipts(f.ledgerPath)[0].repo, 'home23-apple');
});

test('malformed input is a hard failure that names the one-based line number', (t) => {
  const f = fixture(t);
  recordLandReceipt({ ...f, commit: f.first, ...details });
  fs.appendFileSync(f.ledgerPath, '{not json}\n');

  assert.throws(() => loadLandReceipts(f.ledgerPath), /line 2/);
});

test('fold projects the latest deployment while preserving original receipt evidence', (t) => {
  const f = fixture(t);
  recordLandReceipt({ ...f, commit: f.first, ...details, now: () => new Date('2026-09-15T12:00:00.000Z') });
  recordLandReceipt({ ...f, commit: f.second, ...details, summary: 'Repair the second surface', surfaces: ['second'] });
  recordDeployment({ ledgerPath: f.ledgerPath, commit: f.first, releaseId: RELEASE_ID, now: () => new Date('2026-09-15T13:00:00.000Z') });

  const folded = loadLandReceipts(f.ledgerPath);
  assert.equal(folded.length, 2);
  assert.deepEqual(folded[0], {
    schemaVersion: 1,
    recordedAt: '2026-09-15T12:00:00.000Z',
    commit: f.first,
    repo: 'home23',
    branch: 'main',
    summary: details.summary,
    verification: details.verification,
    surfaces: details.surfaces,
    deployed: true,
    deployedReleaseId: RELEASE_ID,
    deployedAt: '2026-09-15T13:00:00.000Z',
    recordedBy: details.recordedBy,
  });
  assert.equal(folded[1].deployed, false);
  assert.equal(folded[1].deployedReleaseId, null);
  assert.equal(folded[1].deployedAt, null);
});

test('fold rejects a deployment record that has no prior land receipt', () => {
  assert.throws(
    () => foldLandReceipts([{
      schemaVersion: 1,
      recordType: 'deployment',
      recordedAt: '2026-09-15T13:00:00.000Z',
      commit: 'b'.repeat(40),
      releaseId: RELEASE_ID,
    }]),
    /line 1.*no prior land receipt/i,
  );
});

test('check returns exit code 3 and prints only undeployed folded receipts', (t) => {
  const f = fixture(t);
  recordLandReceipt({ ...f, commit: f.first, ...details });
  recordLandReceipt({ ...f, commit: f.second, ...details, summary: 'Still waiting' });
  recordDeployment({ ledgerPath: f.ledgerPath, commit: f.first, releaseId: RELEASE_ID });
  const stdout = [];
  const stderr = [];

  const exitCode = runLandReceiptCommand(['check'], {
    repoRoot: f.repoRoot,
    ledgerPath: f.ledgerPath,
    stdout: value => stdout.push(value),
    stderr: value => stderr.push(value),
  });

  assert.equal(exitCode, 3);
  assert.equal(stderr.length, 0);
  const printed = JSON.parse(stdout.join(''));
  assert.deepEqual(printed.map(receipt => receipt.commit), [f.second]);
});

test('read-only list and check do not require the native writer dependency', async t => {
  const f=fixture(t),script=installCli(f,{dependencies:false});
  fs.mkdirSync(path.dirname(f.ledgerPath),{recursive:true});
  fs.writeFileSync(f.ledgerPath,JSON.stringify({schemaVersion:1,recordedAt:'2026-09-15T12:00:00.000Z',commit:f.first,
    repo:'home23',branch:'main',summary:details.summary,verification:details.verification,surfaces:details.surfaces,
    deployed:false,deployedReleaseId:null,deployedAt:null,recordedBy:details.recordedBy})+'\n');

  const list=await runCli(script,f.repoRoot,['list']);
  const check=await runCli(script,f.repoRoot,['check']);

  assert.equal(list.status,0,list.stderr);
  assert.equal(JSON.parse(list.stdout)[0].commit,f.first);
  assert.equal(check.status,3,check.stderr);
});

test('real CLI records, lists, refuses an unrecorded deployment, and exits 3 while undeployed', async (t) => {
  const f = fixture(t), script = installCli(f);
  const record = await runCli(script, f.repoRoot, ['record', '--commit', f.first.slice(0, 8),
    '--summary', details.summary, '--verification', details.verification, '--surfaces', 'fixture', '--recorded-by', 'cli-test']);
  assert.equal(record.status, 0, record.stderr);
  assert.equal(JSON.parse(record.stdout).commit, f.first);

  const check = await runCli(script, f.repoRoot, ['check']);
  assert.equal(check.status, 3, check.stderr);
  assert.deepEqual(JSON.parse(check.stdout).map(value => value.commit), [f.first]);

  const rejected = await runCli(script, f.repoRoot, ['land', '--commit', f.second, '--release', RELEASE_ID]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /No prior land receipt/);

  const landed = await runCli(script, f.repoRoot, ['land', '--commit', f.first.slice(0, 8), '--release', RELEASE_ID]);
  assert.equal(landed.status, 0, landed.stderr);
  const list = await runCli(script, f.repoRoot, ['list', '--undeployed']);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout), []);
});

test('concurrent CLI records serialize duplicate detection and append exactly one receipt', async (t) => {
  const f = fixture(t), script = installCli(f);
  const args = ['record', '--commit', f.first, '--summary', details.summary, '--verification', details.verification,
    '--surfaces', 'fixture', '--recorded-by', 'concurrency-test'];

  const results = await Promise.all(Array.from({ length: 20 }, () => runCli(script, f.repoRoot, args)));

  assert.equal(results.filter(result => result.status === 0).length, 1);
  assert.equal(results.filter(result => result.status !== 0).length, 19);
  assert.equal(loadLandReceipts(f.ledgerPath).length, 1);
  assert.equal(fs.readFileSync(f.ledgerPath, 'utf8').trimEnd().split('\n').length, 1);
});
