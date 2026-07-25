import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createRestrictedFileTools } from '../../../src/agent/tools/restricted-files.js';
import type { ToolContext } from '../../../src/agent/types.js';

const ctx = { workspacePath: '/nonexistent-workspace' } as unknown as ToolContext;

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'restricted-files-'));
  const surface = path.join(root, 'surface');       // read root
  const workspace = path.join(root, 'workspace');   // write root
  const secrets = path.join(root, 'surface', 'secrets'); // deny inside read root
  const outside = path.join(root, 'outside');       // never granted
  for (const d of [surface, workspace, secrets, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(surface, 'status.json'), '{"ok":true}');
  writeFileSync(path.join(secrets, 'env'), 'SECRET=1');
  writeFileSync(path.join(outside, 'live.html'), '<html>');
  const tools = createRestrictedFileTools({
    readRoots: [surface], writeRoots: [workspace], denyPaths: [secrets],
  });
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  return { root, surface, workspace, secrets, outside, by };
}

test('reads inside the read root succeed; writes there are refused', async () => {
  const f = fixture();
  const read = await f.by.read_file!.execute({ path: path.join(f.surface, 'status.json') }, ctx);
  assert.equal(read.is_error, undefined);
  assert.match(read.content, /"ok":true/);
  const write = await f.by.write_file!.execute({ path: path.join(f.surface, 'x.md'), content: 'no' }, ctx);
  assert.equal(write.is_error, true);
  assert.match(write.content, /outside write roots/);
  assert.equal(existsSync(path.join(f.surface, 'x.md')), false);
});

test('writes inside the write root are atomic and readable back', async () => {
  const f = fixture();
  const p = path.join(f.workspace, 'runs', 'note.md');
  const write = await f.by.write_file!.execute({ path: p, content: '# run note' }, ctx);
  assert.equal(write.is_error, undefined, write.content);
  assert.equal(readFileSync(p, 'utf-8'), '# run note');
  const read = await f.by.read_file!.execute({ path: p }, ctx); // write roots implicitly readable
  assert.match(read.content, /run note/);
});

test('deny paths refuse reads even inside an allowed root', async () => {
  const f = fixture();
  const read = await f.by.read_file!.execute({ path: path.join(f.secrets, 'env') }, ctx);
  assert.equal(read.is_error, true);
  assert.match(read.content, /denied path/);
});

test('symlink escape out of a write root is refused', async () => {
  const f = fixture();
  const link = path.join(f.workspace, 'escape');
  symlinkSync(f.outside, link);
  const write = await f.by.write_file!.execute({ path: path.join(link, 'live.html'), content: 'pwn' }, ctx);
  assert.equal(write.is_error, true, write.content);
  assert.equal(readFileSync(path.join(f.outside, 'live.html'), 'utf-8'), '<html>');
});

test('paths fully outside every root are refused for both modes', async () => {
  const f = fixture();
  for (const [tool, args] of [
    ['read_file', { path: path.join(f.outside, 'live.html') }],
    ['write_file', { path: path.join(f.outside, 'new.md'), content: 'x' }],
    ['list_files', { path: f.outside }],
  ] as const) {
    const out = await f.by[tool]!.execute(args as Record<string, unknown>, ctx);
    assert.equal(out.is_error, true, `${tool} should refuse`);
  }
});

test('oversized writes are refused before touching disk', async () => {
  const f = fixture();
  const tools = createRestrictedFileTools({
    readRoots: [f.surface], writeRoots: [f.workspace], denyPaths: [], maxWriteBytes: 10,
  });
  const write = await tools.find((t) => t.name === 'write_file')!
    .execute({ path: path.join(f.workspace, 'big.md'), content: 'x'.repeat(11) }, ctx);
  assert.equal(write.is_error, true);
  assert.equal(existsSync(path.join(f.workspace, 'big.md')), false);
});

test('factory refuses a nonexistent root and an empty grant', () => {
  assert.throws(() => createRestrictedFileTools({
    readRoots: ['/definitely/not/a/real/root'], writeRoots: [], denyPaths: [],
  }), /does not exist/);
  assert.throws(() => createRestrictedFileTools({
    readRoots: [], writeRoots: [], denyPaths: [],
  }), /at least one read root/);
});
