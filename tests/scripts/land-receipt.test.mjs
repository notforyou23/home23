import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { LEDGER_ENV, parseLandReceiptLedger } from '../../scripts/development/land-receipt.mjs';

// Runs the real CLI in place against a temporary workspace ledger. The product
// deployment on 2026-09-24 could not be recorded because `land` only accepted a
// 40-character managed releaseId and one commit per call; a signed product
// package is a 64-character packageId that deploys many commits at once.
const SCRIPT = fileURLToPath(new URL('../../scripts/development/land-receipt.mjs', import.meta.url));
const PACKAGE_ID = 'ff3e288f'.repeat(8);
const RELEASE_ID = 'a'.repeat(40);

function commit(repoRoot, content) {
  fs.writeFileSync(path.join(repoRoot, 'fixture.txt'), `${content}\n`);
  execFileSync('git', ['-C', repoRoot, 'add', 'fixture.txt']);
  execFileSync('git', ['-C', repoRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', content]);
  return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-land-receipt-cli-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const repoRoot = path.join(parent, 'home23');
  fs.mkdirSync(repoRoot);
  execFileSync('git', ['init', '-q', '-b', 'main', repoRoot]);
  const first = commit(repoRoot, 'first'), second = commit(repoRoot, 'second'), third = commit(repoRoot, 'third');
  fs.mkdirSync(path.join(parent, 'verification'));
  const ledgerPath = path.join(parent, 'verification', 'land-receipts.jsonl');
  const run = args => new Promise(resolve => execFile(process.execPath, [SCRIPT, ...args],
    { cwd: repoRoot, env: { ...process.env, [LEDGER_ENV]: ledgerPath } },
    (error, stdout, stderr) => resolve({ status: error?.code ?? 0, stdout, stderr })));
  const record = async (sha, summary = `Repair ${sha.slice(0, 7)}`) => {
    const result = await run(['record', '--commit', sha, '--summary', summary, '--verification', 'tests/fixture.test.js',
      '--surfaces', 'fixture', '--recorded-by', 'cli-test']);
    assert.equal(result.status, 0, result.stderr);
  };
  const ledger = () => parseLandReceiptLedger(fs.readFileSync(ledgerPath));
  return { repoRoot, ledgerPath, first, second, third, run, record, ledger };
}

test('land records a product package deployment by its 64-character packageId', async (t) => {
  const f = fixture(t);
  await f.record(f.first);

  const landed = await f.run(['land', '--commit', f.first, '--release', PACKAGE_ID]);

  assert.equal(landed.status, 0, landed.stderr);
  const report = JSON.parse(landed.stdout);
  assert.equal(report.releaseId, PACKAGE_ID);
  assert.equal(report.releaseKind, 'product-package');
  assert.deepEqual(report.unrecorded, []);
  assert.equal(report.deployed.length, 1);
  assert.deepEqual(f.ledger()[1], {
    schemaVersion: 1,
    recordType: 'deployment',
    recordedAt: report.deployed[0].recordedAt,
    commit: f.first,
    releaseId: PACKAGE_ID,
    releaseKind: 'product-package',
  });

  const list = await f.run(['list']);
  assert.equal(list.status, 0, list.stderr);
  const [folded] = JSON.parse(list.stdout);
  assert.equal(folded.deployed, true);
  assert.equal(folded.deployedReleaseId, PACKAGE_ID);
  assert.equal(folded.deployedReleaseKind, 'product-package');
});

test('land keeps accepting a 40-character managed releaseId and records its kind', async (t) => {
  const f = fixture(t);
  await f.record(f.first);

  const landed = await f.run(['land', '--commit', f.first.slice(0, 8), '--release', RELEASE_ID]);

  assert.equal(landed.status, 0, landed.stderr);
  const report = JSON.parse(landed.stdout);
  assert.equal(report.releaseKind, 'managed-release');
  assert.equal(f.ledger()[1].releaseId, RELEASE_ID);
  assert.equal(f.ledger()[1].releaseKind, 'managed-release');
  const list = await f.run(['list']);
  assert.equal(JSON.parse(list.stdout)[0].deployedReleaseKind, 'managed-release');
});

test('land with repeated --commit appends one deployment record per receipt in one call', async (t) => {
  const f = fixture(t);
  await f.record(f.first);
  await f.record(f.second);

  const landed = await f.run(['land', '--commit', f.first, '--commit', f.second.slice(0, 10), '--commit', f.first, '--release', PACKAGE_ID]);

  assert.equal(landed.status, 0, landed.stderr);
  const report = JSON.parse(landed.stdout);
  assert.deepEqual(report.deployed.map(value => value.commit), [f.first, f.second]);
  assert.equal(new Set(report.deployed.map(value => value.recordedAt)).size, 1);
  assert.deepEqual(report.unrecorded, []);
  assert.equal(f.ledger().length, 4);
  const undeployed = await f.run(['list', '--undeployed']);
  assert.deepEqual(JSON.parse(undeployed.stdout), []);
});

test('land with --commits <shaA>..<shaB> resolves the range through git in the current checkout', async (t) => {
  const f = fixture(t);
  await f.record(f.second);
  await f.record(f.third);

  const landed = await f.run(['land', '--commits', `${f.first.slice(0, 8)}..${f.third}`, '--release', PACKAGE_ID]);

  assert.equal(landed.status, 0, landed.stderr);
  const report = JSON.parse(landed.stdout);
  assert.deepEqual(report.deployed.map(value => value.commit), [f.second, f.third]);
  assert.deepEqual(report.unrecorded, []);
  assert.equal(f.ledger().length, 4);
});

test('a commit without a receipt is reported while the receipted commits are recorded', async (t) => {
  const f = fixture(t);
  await f.record(f.first);
  await f.record(f.third);

  const landed = await f.run(['land', '--commits', `${f.first}..${f.third}`, '--commit', f.first, '--release', PACKAGE_ID]);

  assert.equal(landed.status, 0, landed.stderr);
  const report = JSON.parse(landed.stdout);
  assert.deepEqual(report.deployed.map(value => value.commit), [f.third, f.first]);
  assert.deepEqual(report.unrecorded, [f.second]);
  assert.match(landed.stderr, new RegExp(`no land receipt.*${f.second}`));
  assert.equal(f.ledger().length, 4);
});

test('--strict fails the whole call and appends nothing when any commit lacks a receipt', async (t) => {
  const f = fixture(t);
  await f.record(f.first);
  const before = fs.readFileSync(f.ledgerPath);

  const rejected = await f.run(['land', '--strict', '--commit', f.first, '--commit', f.second, '--release', PACKAGE_ID]);

  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /No prior land receipt/);
  assert.match(rejected.stderr, new RegExp(f.second));
  assert.equal(fs.readFileSync(f.ledgerPath).equals(before), true);
});

test('a land call whose commits all lack receipts fails instead of reporting success', async (t) => {
  const f = fixture(t);
  await f.record(f.first);
  const before = fs.readFileSync(f.ledgerPath);

  const rejected = await f.run(['land', '--commit', f.second, '--release', PACKAGE_ID]);

  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /No prior land receipt/);
  assert.equal(fs.readFileSync(f.ledgerPath).equals(before), true);
});

test('invalid release ids are rejected before the ledger is touched', async (t) => {
  const f = fixture(t);
  await f.record(f.first);
  const before = fs.readFileSync(f.ledgerPath);

  for (const releaseId of ['a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(41), 'a'.repeat(39), '']) {
    const rejected = await f.run(['land', '--commit', f.first, '--release', releaseId]);
    assert.equal(rejected.status, 1, `accepted ${JSON.stringify(releaseId)}`);
    assert.match(rejected.stderr, /release must be/);
  }
  assert.equal(fs.readFileSync(f.ledgerPath).equals(before), true);
});

test('land rejects missing, duplicate and malformed options with usage instead of writing', async (t) => {
  const f = fixture(t);
  await f.record(f.first);
  const before = fs.readFileSync(f.ledgerPath);

  for (const args of [
    ['land', '--commit', f.first],
    ['land', '--release', PACKAGE_ID],
    ['land', '--commit', f.first, '--release', PACKAGE_ID, '--release', PACKAGE_ID],
    ['land', '--commit', f.first, '--release', PACKAGE_ID, '--strict', '--strict'],
    ['land', '--commits', f.first, '--release', PACKAGE_ID],
    ['land', '--commits', `${f.first}...${f.third}`, '--release', PACKAGE_ID],
    ['land', '--commits', `${f.first}..${'f'.repeat(40)}`, '--release', PACKAGE_ID],
    ['land', '--commits', `${f.third}..${f.first}`, '--release', PACKAGE_ID],
  ]) {
    const rejected = await f.run(args);
    assert.equal(rejected.status, 1, `accepted ${args.join(' ')}`);
    assert.match(rejected.stderr, /--commits|--release|--strict|range|Usage/i);
  }
  assert.equal(fs.readFileSync(f.ledgerPath).equals(before), true);
});

test('an old deployment record without releaseKind still folds as a managed release; a mismatched kind is malformed', async (t) => {
  const f = fixture(t);
  await f.record(f.first);
  fs.appendFileSync(f.ledgerPath, `${JSON.stringify({
    schemaVersion: 1, recordType: 'deployment', recordedAt: '2026-09-15T13:00:00.000Z', commit: f.first, releaseId: RELEASE_ID,
  })}\n`);

  const list = await f.run(['list']);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(JSON.parse(list.stdout)[0].deployedReleaseId, RELEASE_ID);
  assert.equal(JSON.parse(list.stdout)[0].deployedReleaseKind, 'managed-release');

  for (const record of [
    { releaseId: PACKAGE_ID },
    { releaseId: PACKAGE_ID, releaseKind: 'managed-release' },
    { releaseId: RELEASE_ID, releaseKind: 'product-package' },
  ]) {
    const broken = `${f.ledgerPath}.${Object.keys(record).length}${record.releaseKind ?? ''}`;
    fs.copyFileSync(f.ledgerPath, broken);
    fs.appendFileSync(broken, `${JSON.stringify({
      schemaVersion: 1, recordType: 'deployment', recordedAt: '2026-09-24T13:00:00.000Z', commit: f.first, ...record,
    })}\n`);
    assert.throws(() => parseLandReceiptLedger(fs.readFileSync(broken)), /line 3/);
  }
});
