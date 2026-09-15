import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('worktree dependency tests remain valid when cp -Rc clone capability is unavailable', () => {
  const shimDir = mkdtempSync(path.join(tmpdir(), 'home23-no-clone-cp-'));
  try {
    const cp = path.join(shimDir, 'cp');
    writeFileSync(cp, '#!/bin/sh\nexit 64\n');
    chmodSync(cp, 0o755);
    const suite = fileURLToPath(new URL('./worktrees.test.ts', import.meta.url));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));
    const result = spawnSync(process.execPath, [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      suite,
    ], {
      cwd: path.resolve(path.dirname(suite), '../..'),
      encoding: 'utf8',
      env: { ...env, PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ''}` },
    });

    const diagnostic = `nested worktree suite did not capability-skip cleanly:\n${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, diagnostic);
    assert.match(result.stdout, /skipped 2/, diagnostic);
  } finally {
    rmSync(shimDir, { recursive: true, force: true });
  }
});
