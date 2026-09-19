import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionOutputCapture, type ExecutionOutputRecord } from '../../src/agent/execution-output.js';
import { shellTool } from '../../src/agent/tools/shell.js';
import type { ToolContext } from '../../src/agent/types.js';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function records(root: string, id: string): Promise<ExecutionOutputRecord[]> {
  return (await readFile(join(root, 'execution-output', `${id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}

test('real shell stdout/stderr arrive before exit and preserve the bounded model result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'console-output-'));
  try {
    const capture = createExecutionOutputCapture({ instanceDir: root, turnId: 't_live', flushMs: 5 });
    let finished = false;
    const result = shellTool.execute({ command: `node -e "process.stdout.write('first\\n'); process.stderr.write('warning\\n'); setTimeout(()=>process.stdout.write('last\\n'),600)"`, cwd: root }, {
      projectRoot: root, instanceDir: root, parentToolCallId: 'tool-1',
      turnRuntime: { executionOutput: capture },
    } as unknown as ToolContext).then(value => { finished = true; return value; });
    let streamed: ExecutionOutputRecord[] = [];
    for (let i = 0; i < 30; i++) {
      await wait(10);
      try { streamed = await records(root, 't_live'); } catch { continue; }
      if (streamed.some(row => row.data.channel === 'stderr')) break;
    }
    assert.equal(finished, false, 'must observe while command is still running');
    assert.ok(streamed.some(row => row.data.text === 'first\n'));
    assert.ok(streamed.some(row => row.data.text === 'warning\n'));
    assert.deepEqual(await result, { content: 'STDOUT:\nfirst\nlast\n\n\nSTDERR:\nwarning\n\n\nExit code: 0', is_error: false });
    await capture.close();
    const final = await records(root, 't_live');
    assert.equal(final.at(-1)?.kind, 'capture_end');
    assert.equal(final.at(-1)?.data.complete, true);
    assert.deepEqual(final.map(row => row.seq), final.map((_row, i) => i + 1));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('capture bounds pending data, preserves invalid UTF8 bytes, and records loss honestly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'console-output-bounds-'));
  try {
    const capture = createExecutionOutputCapture({ instanceDir: root, turnId: 't_bounds', maxPendingBytes: 2048 });
    const raw = Buffer.from([0xff, 0x80, 0x00]);
    capture.write('tool-1', 'stdout', raw);
    capture.write('tool-1', 'stdout', Buffer.alloc(512 * 1024, 120));
    await capture.close();
    const output = await records(root, 't_bounds');
    const record = output.find(row => row.kind === 'tool_output')!;
    assert.equal(record.data.encoding, 'base64');
    assert.deepEqual(Buffer.from(String(record.data.text), 'base64'), raw);
    assert.ok(output.some(row => row.kind === 'capture_gap'));
    assert.equal(output.at(-1)?.data.complete, false);
    assert.ok(Number(output.at(-1)?.data.droppedBytes) > 0);
    assert.ok((await stat(join(root, 'execution-output/t_bounds.jsonl'))).size < 8192);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('retention removes only closed sidecars; unwritable capture never blocks model-facing shell output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'console-output-retention-'));
  try {
    const dir = join(root, 'execution-output');
    await mkdir(dir);
    await writeFile(join(dir, 't_old.jsonl'), JSON.stringify({ kind: 'capture_end' }) + '\n');
    await writeFile(join(dir, 't_incomplete.jsonl'), JSON.stringify({ kind: 'capture_start' }) + '\n');
    await utimes(join(dir, 't_old.jsonl'), new Date(0), new Date(0));
    await utimes(join(dir, 't_incomplete.jsonl'), new Date(0), new Date(0));
    const capture = createExecutionOutputCapture({ instanceDir: root, turnId: 't_new', retentionMs: 1 });
    await capture.close();
    await assert.rejects(stat(join(dir, 't_old.jsonl')), { code: 'ENOENT' });
    assert.ok(await stat(join(dir, 't_incomplete.jsonl')));
    const unavailable: string[] = [];
    const invalidRoot = join(root, 'a-file');
    await writeFile(invalidRoot, 'not a directory');
    const broken = createExecutionOutputCapture({ instanceDir: invalidRoot, turnId: 't_disk', onUnavailable: value => unavailable.push(value) });
    const result = await shellTool.execute({ command: 'printf works', cwd: root }, {
      projectRoot: root, parentToolCallId: 'tool', turnRuntime: { executionOutput: broken },
    } as unknown as ToolContext);
    assert.equal(result.content, 'STDOUT:\nworks\n\nExit code: 0');
    assert.equal(result.is_error, false);
    await broken.close();
    assert.equal(broken.status(), 'unavailable');
    assert.deepEqual(unavailable, ['capture_storage_unavailable']);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('per-turn and aggregate capture budgets expose loss without growing storage past the reservation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'console-output-budget-'));
  try {
    const capture = createExecutionOutputCapture({ instanceDir: root, turnId: 't_capped', maxTurnBytes: 8192 });
    for (let i = 0; i < 20; i++) {
      capture.write('tool', 'stdout', Buffer.alloc(16_384, 120));
      capture.toolEnd('tool');
      await wait(1);
    }
    await capture.close();
    const output = await records(root, 't_capped');
    assert.equal(output.filter(row => row.kind === 'capture_gap').length, 1);
    assert.equal(output.at(-1)?.data.complete, false);
    assert.equal(output.at(-1)?.data.droppedBytes, 20 * 16_384);
    assert.ok((await stat(join(root, 'execution-output/t_capped.jsonl'))).size <= 8192);
    const reasons: string[] = [];
    const refused = createExecutionOutputCapture({ instanceDir: root, turnId: 't_refused', maxTurnBytes: 8192,
      maxStorageBytes: 4096, onUnavailable: value => reasons.push(value) });
    await refused.close();
    assert.equal(refused.status(), 'unavailable');
    assert.deepEqual(reasons, ['capture_storage_capacity']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
