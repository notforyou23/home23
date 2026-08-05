/**
 * Bridge lifecycle tests against a FAKE claude-code CLI: a node script that
 * ignores its argv and prints canned stream-json lines. Pointing the
 * claude-code backend's config bin at the fake exercises the REAL arg builder,
 * detached spawn, events.jsonl tail, finalize, cancel, and recovery paths.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ACPBridge, normalizeBridgeConfig } from '../../src/acp/bridge.js';
import type { BridgeLifecycleEvent, CodingJobRecord } from '../../src/acp/types.js';

const FIXTURE_LINES = [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-fixture-1', model: 'claude-fake' }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
];
const FIXTURE_RESULT = JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: 'All done',
  total_cost_usd: 0.12, num_turns: 3, duration_ms: 250,
});

function writeFakeCli(dir: string, name: string, body: string): string {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}`);
  chmodSync(file, 0o755);
  return file;
}

function happyCli(dir: string): string {
  return writeFakeCli(dir, 'fake-claude.js', [
    `const lines = ${JSON.stringify(FIXTURE_LINES)};`,
    'for (const l of lines) process.stdout.write(l + "\\n");',
    'setTimeout(() => {',
    `  process.stdout.write(${JSON.stringify(FIXTURE_RESULT)} + "\\n");`,
    '  process.exit(0);',
    '}, 200);',
  ].join('\n'));
}

function sleepyCli(dir: string): string {
  return writeFakeCli(dir, 'fake-sleepy.js', [
    `process.stdout.write(${JSON.stringify(FIXTURE_LINES[0])} + "\\n");`,
    'setTimeout(() => process.exit(0), 30000);',
  ].join('\n'));
}

function makeBridge(root: string, bin: string, configOverrides: Record<string, unknown> = {}): ACPBridge {
  return new ACPBridge({
    config: normalizeBridgeConfig({
      backends: { 'claude-code': { bin } },
      ...configOverrides,
    }),
    jobsDir: path.join(root, 'coding-jobs'),
    projectRoot: root,
    log: () => undefined,
  });
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('startJob → waitForJob completes with receipt, events on disk, ordered lifecycle', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-acp-bridge-'));
  const bridge = makeBridge(root, happyCli(root));
  try {
    const seen: BridgeLifecycleEvent[] = [];
    bridge.addListener(e => seen.push(e));

    const started = await bridge.startJob({ prompt: 'do the thing', label: 'happy path' });
    assert.equal(started.status, 'running');
    assert.equal(started.backend, 'claude-code');
    assert.ok(started.pid && started.pid > 0);
    assert.equal(started.pgid, started.pid);
    // Prompt is elided from the recorded argv but present as job.prompt.
    assert.equal(started.argv?.[started.argv.length - 1], '<prompt>');
    assert.equal(started.prompt, 'do the thing');
    // claude-code new jobs pre-generate the session id for later resume.
    assert.match(started.sessionId ?? '', /^[0-9a-f-]{36}$/);
    assert.ok(started.argv?.includes('--session-id'));

    const done = await bridge.waitForJob(started.id, 15_000);
    assert.equal(done.status, 'completed');
    // The stream-reported session id (system/init) wins over bookkeeping —
    // resumed claude sessions fork under a NEW id only the stream knows.
    assert.equal(done.sessionId, 'sess-fixture-1');

    const receipt = bridge.getReceipt(started.id);
    assert.ok(receipt);
    assert.equal(receipt!.status, 'completed');
    assert.equal(receipt!.resultTail, 'All done');
    assert.equal(receipt!.costUsd, 0.12);
    assert.equal(receipt!.numTurns, 3);
    assert.equal(receipt!.toolUseCount, 1);
    assert.equal(receipt!.eventsCount, 4);

    // Raw stream is durable on disk.
    const eventsFile = path.join(root, 'coding-jobs', started.id, 'events.jsonl');
    assert.ok(existsSync(eventsFile));
    assert.match(readFileSync(eventsFile, 'utf8'), /sess-fixture-1/);
    const jobJson = JSON.parse(readFileSync(path.join(root, 'coding-jobs', started.id, 'job.json'), 'utf8')) as CodingJobRecord;
    assert.equal(jobJson.status, 'completed');

    // Lifecycle ordering: started first, finished last, events in between.
    assert.equal(seen[0]!.type, 'job_started');
    assert.equal(seen[seen.length - 1]!.type, 'job_finished');
    const kinds = seen.filter(e => e.type === 'job_event').map(e => (e as { event: { kind: string } }).event.kind);
    assert.deepEqual(kinds, ['session', 'text', 'tool_use', 'result']);

    // Normalized tail reader agrees with the live parse.
    const tail = bridge.readEventsTail(started.id, 10);
    assert.equal(tail[tail.length - 1]!.kind, 'result');
  } finally {
    bridge.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancelJob stops the process and labels the job cancelled', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-acp-bridge-'));
  const bridge = makeBridge(root, sleepyCli(root));
  try {
    const started = await bridge.startJob({ prompt: 'sleep forever' });
    assert.equal(started.status, 'running');
    const pid = started.pid!;

    await bridge.cancelJob(started.id);
    const done = await bridge.waitForJob(started.id, 15_000);
    assert.equal(done.status, 'cancelled');
    assert.equal(pidAlive(pid), false, 'child process must actually be dead');
    assert.equal(bridge.getReceipt(started.id)?.status, 'cancelled');
  } finally {
    bridge.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('recover finalizes dead jobs: completed with result, interrupted without', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-acp-bridge-'));
  try {
    const jobsDir = path.join(root, 'coding-jobs');
    const seed = (id: string, lines: string[]) => {
      const dir = path.join(jobsDir, id);
      mkdirSync(dir, { recursive: true });
      const record: CodingJobRecord = {
        schema: 'home23.coding-job.v1',
        id,
        backend: 'claude-code',
        status: 'running',
        prompt: 'orphaned work',
        cwd: root,
        requestedCwd: root,
        pid: 999_999, // beyond macOS pid range → definitely dead
        pgid: 999_999,
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        isolation: 'none',
      };
      writeFileSync(path.join(dir, 'job.json'), JSON.stringify(record, null, 2));
      writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
    };
    seed('cj_20260805T000000Z_dead', [...FIXTURE_LINES, FIXTURE_RESULT]);
    seed('cj_20260805T000001Z_gone', FIXTURE_LINES);

    const bridge = makeBridge(root, happyCli(root));
    const { resumed, finalized } = await bridge.recover();
    assert.deepEqual(resumed, []);
    assert.deepEqual([...finalized].sort(), ['cj_20260805T000000Z_dead', 'cj_20260805T000001Z_gone']);

    const completed = bridge.getJob('cj_20260805T000000Z_dead');
    assert.equal(completed?.status, 'completed');
    // Session id recovered from the replayed stream — resume handle survives.
    assert.equal(completed?.sessionId, 'sess-fixture-1');
    const receipt = bridge.getReceipt('cj_20260805T000000Z_dead');
    assert.equal(receipt?.resultTail, 'All done');
    assert.equal(receipt?.eventsCount, 4);
    assert.equal(receipt?.toolUseCount, 1);

    const interrupted = bridge.getJob('cj_20260805T000001Z_gone');
    assert.equal(interrupted?.status, 'interrupted');
    assert.equal(interrupted?.sessionId, 'sess-fixture-1', 'interrupted job keeps its resume handle');
    assert.equal(bridge.getReceipt('cj_20260805T000001Z_gone')?.status, 'interrupted');
    bridge.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('recover flushes a torn terminal line (child killed mid-write) → completed, not interrupted', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-acp-bridge-'));
  try {
    const jobsDir = path.join(root, 'coding-jobs');
    const id = 'cj_20260805T000002Z_torn';
    const dir = path.join(jobsDir, id);
    mkdirSync(dir, { recursive: true });
    const record: CodingJobRecord = {
      schema: 'home23.coding-job.v1',
      id,
      backend: 'claude-code',
      status: 'running',
      prompt: 'torn write',
      cwd: root,
      requestedCwd: root,
      pid: 999_999,
      pgid: 999_999,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      isolation: 'none',
    };
    writeFileSync(path.join(dir, 'job.json'), JSON.stringify(record, null, 2));
    // The final result line has NO trailing newline — the host died mid-write.
    writeFileSync(path.join(dir, 'events.jsonl'), FIXTURE_LINES.join('\n') + '\n' + FIXTURE_RESULT);

    const bridge = makeBridge(root, happyCli(root));
    await bridge.recover();
    const job = bridge.getJob(id);
    assert.equal(job?.status, 'completed', 'torn terminal line is flushed and recognized');
    assert.equal(bridge.getReceipt(id)?.resultTail, 'All done');
    assert.equal(bridge.getReceipt(id)?.eventsCount, 4);
    bridge.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('maxConcurrentJobs is enforced against non-terminal jobs', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-acp-bridge-'));
  const bridge = makeBridge(root, sleepyCli(root), { maxConcurrentJobs: 1 });
  try {
    const first = await bridge.startJob({ prompt: 'occupy the slot' });
    await assert.rejects(
      bridge.startJob({ prompt: 'one too many' }),
      /Concurrent coding-job limit reached \(1\/1\)/,
    );
    await bridge.cancelJob(first.id);
    await bridge.waitForJob(first.id, 15_000);
    // Slot freed after the first job reached a terminal status.
    const second = await bridge.startJob({ prompt: 'now it fits' });
    await bridge.cancelJob(second.id);
    await bridge.waitForJob(second.id, 15_000);
  } finally {
    bridge.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('disabled config and validation failures reject with clear messages', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-acp-bridge-'));
  try {
    const disabled = makeBridge(root, happyCli(root), { enabled: false });
    await assert.rejects(disabled.startJob({ prompt: 'nope' }), /disabled/);
    disabled.dispose();

    const bridge = makeBridge(root, happyCli(root), { allowedAgents: ['codex'] });
    await assert.rejects(bridge.startJob({ prompt: 'x', backend: 'claude-code' }), /not in allowedAgents/);
    await assert.rejects(bridge.startJob({ prompt: 'x', backend: 'no-such-backend' }), /Unknown coding backend/);
    await assert.rejects(bridge.startJob({ prompt: '   ' }), /prompt is empty/);
    bridge.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('codex startJob fails fast with install instructions when the CLI is absent', async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-acp-bridge-'));
  const bridge = makeBridge(root, happyCli(root));
  try {
    const codex = bridge.listBackends().find(b => b.id === 'codex')!;
    if (codex.available) return t.skip('codex CLI is installed on this machine');
    await assert.rejects(
      bridge.startJob({ prompt: 'x', backend: 'codex' }),
      /codex CLI not found; install with `npm i -g @openai\/codex` or set acp\.backends\.codex\.bin/,
    );
  } finally {
    bridge.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('listBackends reports availability from resolved bins', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'home23-acp-bridge-'));
  const bin = happyCli(root);
  const bridge = makeBridge(root, bin);
  try {
    const backends = bridge.listBackends();
    const claude = backends.find(b => b.id === 'claude-code')!;
    assert.equal(claude.available, true);
    assert.equal(claude.bin, bin);
    assert.ok(backends.some(b => b.id === 'codex'));
  } finally {
    bridge.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a job inside the Home23 checkout auto-isolates into a worktree', async (t) => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch {
    return t.skip('git unavailable');
  }
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'home23-acp-bridge-')));
  const gitRun = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  gitRun(['init', '-q']);
  gitRun(['config', 'user.email', 'test@home23.local']);
  gitRun(['config', 'user.name', 'Home23 Test']);
  writeFileSync(path.join(root, 'README.md'), 'repo\n');
  gitRun(['add', '.']);
  gitRun(['commit', '-q', '-m', 'init']);

  // Fake CLI proves it ran in the worktree by writing an artifact into cwd.
  const bin = writeFakeCli(root, 'fake-worktree.js', [
    'require("node:fs").writeFileSync("job-artifact.txt", "made by job\\n");',
    `process.stdout.write(${JSON.stringify(FIXTURE_LINES[0])} + "\\n");`,
    `process.stdout.write(${JSON.stringify(FIXTURE_RESULT)} + "\\n");`,
  ].join('\n'));
  const bridge = makeBridge(root, bin);
  try {
    const started = await bridge.startJob({ prompt: 'change the checkout', label: 'wt demo' });
    assert.equal(started.isolation, 'worktree');
    assert.ok(started.worktree);
    assert.equal(started.cwd, started.worktree!.path);
    assert.equal(started.requestedCwd, root);
    assert.match(started.worktree!.branch, /^home23-agent\/wt-demo/);

    const done = await bridge.waitForJob(started.id, 15_000);
    assert.equal(done.status, 'completed');
    // The job's edits landed in the worktree, never in the live checkout.
    assert.ok(existsSync(path.join(started.worktree!.path, 'job-artifact.txt')));
    assert.equal(existsSync(path.join(root, 'job-artifact.txt')), false);
    const receipt = bridge.getReceipt(started.id)!;
    assert.deepEqual(receipt.worktree, started.worktree);
    assert.match(receipt.diffStat ?? '', /job-artifact\.txt/);
  } finally {
    bridge.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test('normalizeBridgeConfig fails closed when absent, defaults when present, maps builder-era ask to allowlist', () => {
  // Absent block (agent config predating Step 29) must NOT silently enable
  // bypass-authority coding jobs on restart.
  assert.equal(normalizeBridgeConfig(undefined).enabled, false);
  assert.equal(normalizeBridgeConfig(null).enabled, false);

  // Present-but-empty block opts in with full defaults.
  const present = normalizeBridgeConfig({});
  assert.equal(present.enabled, true);
  assert.equal(present.defaultAgent, 'claude-code');
  assert.deepEqual(present.allowedAgents, ['claude-code', 'codex']);
  assert.equal(present.permissionMode, 'bypassPermissions');
  assert.equal(present.maxConcurrentJobs, 3);
  assert.equal(present.jobTimeoutMs, 6 * 60 * 60 * 1000);

  assert.equal(normalizeBridgeConfig({ enabled: false }).enabled, false);
  assert.equal(normalizeBridgeConfig({ enabled: true }).enabled, true);
  // 'ask' must gate (allowlist), never silently widen to bypassPermissions.
  assert.equal(normalizeBridgeConfig({ permissionMode: 'ask' }).permissionMode, 'allowlist');
  assert.equal(normalizeBridgeConfig({ permissionMode: 'plan' }).permissionMode, 'plan');
});
