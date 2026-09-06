import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireWorkspaceLease, releaseWorkspaceLease } from '../../src/acp/workspace-lease.js';

test('leases exclude competing bridges and canonicalize symlinks and Git subdirectories', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'h23-lease-'));
  try {
    execFileSync('git', ['init', '-q', root]);
    mkdirSync(path.join(root, 'sub'));
    symlinkSync(root, path.join(root, 'alias'));
    const lease = acquireWorkspaceLease(root, root, path.join(root, 'job.json'));
    assert.throws(() => acquireWorkspaceLease(root, path.join(root, 'sub'), path.join(root, 'two.json')), /reserved/);
    assert.throws(() => acquireWorkspaceLease(root, path.join(root, 'alias'), path.join(root, 'two.json')), /reserved/);
    releaseWorkspaceLease({ ...lease, token: 'stale' });
    assert.ok(existsSync(lease.directory));
    releaseWorkspaceLease(lease);
    const next = acquireWorkspaceLease(root, root, path.join(root, 'two.json'));
    releaseWorkspaceLease(lease);
    assert.ok(existsSync(next.directory), 'old owner cannot release new reservation');
    releaseWorkspaceLease(next);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('dead owners can be recovered, but unreadable owners fail closed', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'h23-lease-'));
  try {
    const lease = acquireWorkspaceLease(root, root, path.join(root, 'job.json'));
    const file = path.join(lease.directory, 'owner.json');
    const owner = JSON.parse(readFileSync(file, 'utf8'));
    // A short-lived real process gives us a known exited PID.
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    writeFileSync(file, JSON.stringify({ ...owner, harnessPid: deadPid }));
    const recovered = acquireWorkspaceLease(root, root, path.join(root, 'two.json'));
    assert.notEqual(recovered.token, lease.token);
    writeFileSync(file, '{}');
    assert.throws(() => acquireWorkspaceLease(root, root, path.join(root, 'three.json')), /unreadable ownership/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a crash before PID persistence never frees a potentially spawned child workspace', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'h23-lease-'));
  try {
    const jobFile = path.join(root, 'job.json');
    writeFileSync(jobFile, JSON.stringify({ status: 'starting' }));
    const lease = acquireWorkspaceLease(root, root, jobFile);
    const file = path.join(lease.directory, 'owner.json');
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), harnessPid: deadPid }));
    assert.throws(() => acquireWorkspaceLease(root, root, path.join(root, 'other.json')), /reserved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
