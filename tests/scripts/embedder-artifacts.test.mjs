import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { downloadFile, ensureArtifacts } from '../../scripts/embedder/artifacts.mjs';

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function webStream(buf) {
  return Readable.toWeb(Readable.from(Buffer.from(buf)));
}

test('downloadFile verifies the part file before renaming onto dest', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'embedder-dl-'));
  const dest = join(dir, 'model.onnx');
  const body = Buffer.from('owned-onnx-bytes');
  const expectedSha = sha256(body);
  writeFileSync(dest, 'stale-dest');
  await downloadFile('https://example.test/model.onnx', dest, {
    expectedSha,
    fetchImpl: async () => ({ ok: true, status: 200, body: webStream(body) }),
  });
  assert.equal(readFileSync(dest, 'utf8'), 'owned-onnx-bytes');
  assert.equal(existsSync(`${dest}.part`), false);
});

test('downloadFile does not replace dest when the digest is wrong', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'embedder-dl-'));
  const dest = join(dir, 'model.onnx');
  writeFileSync(dest, 'keep-me');
  await assert.rejects(() => downloadFile('https://example.test/model.onnx', dest, {
    expectedSha: 'ab'.repeat(32),
    fetchImpl: async () => ({ ok: true, status: 200, body: webStream(Buffer.from('bad-bytes')) }),
  }), /bad_artifact/);
  assert.equal(readFileSync(dest, 'utf8'), 'keep-me');
  assert.equal(existsSync(`${dest}.part`), false);
});

test('downloadFile resumes a verified partial with Range and honors abort', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'embedder-dl-'));
  const dest = join(dir, 'model.onnx');
  const full = Buffer.from('abcdefghijklmnop');
  writeFileSync(`${dest}.part`, full.subarray(0, 8));
  const headers = [];
  await downloadFile('https://example.test/model.onnx', dest, {
    expectedSha: sha256(full),
    fetchImpl: async (_url, init) => {
      headers.push(init.headers.Range);
      assert.equal(init.headers.Range, 'bytes=8-');
      return { ok: true, status: 206, body: webStream(full.subarray(8)) };
    },
  });
  assert.deepEqual(headers, ['bytes=8-']);
  assert.equal(readFileSync(dest).equals(full), true);

  const dest2 = join(dir, 'aborted.onnx');
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => downloadFile('https://example.test/aborted.onnx', dest2, {
    expectedSha: sha256(full),
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      if (init.signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return { ok: true, status: 200, body: webStream(full) };
    },
  }), /aborted|AbortError/);
  assert.equal(existsSync(dest2), false);
});

test('ensureArtifacts keeps a truncated .part on abort and Range-resumes it', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'embedder-ensure-'));
  const full = Buffer.from('abcdefghijklmnop');
  const artifacts = { 'onnx/model.onnx': sha256(full) };
  const dest = join(cacheDir, 'nomic-ai/nomic-embed-text-v1.5', 'onnx/model.onnx');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(`${dest}.part`, full.subarray(0, 8));
  const controller = new AbortController();
  controller.abort();
  const aborted = await ensureArtifacts(cacheDir, {
    artifacts,
    signal: controller.signal,
    fetchImpl: async (_url, init) => {
      if (init.signal?.aborted) {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }
      return { ok: true, status: 200, body: webStream(full) };
    },
  });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.code, 'unavailable');
  assert.equal(existsSync(`${dest}.part`), true);
  assert.equal(statSync(`${dest}.part`).size, 8);

  const ranges = [];
  const resumed = await ensureArtifacts(cacheDir, {
    artifacts,
    fetchImpl: async (_url, init) => {
      ranges.push(init.headers.Range);
      assert.equal(init.headers.Range, 'bytes=8-');
      return { ok: true, status: 206, body: webStream(full.subarray(8)) };
    },
  });
  assert.equal(resumed.ok, true);
  assert.deepEqual(ranges, ['bytes=8-']);
  assert.equal(readFileSync(dest).equals(full), true);
  assert.equal(existsSync(`${dest}.part`), false);
});

test('ensureArtifacts deletes .part only when the finished digest is wrong', async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), 'embedder-ensure-bad-'));
  const dest = join(cacheDir, 'nomic-ai/nomic-embed-text-v1.5', 'onnx/model.onnx');
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(`${dest}.part`, Buffer.from('keep-if-abort-only'));
  const result = await ensureArtifacts(cacheDir, {
    artifacts: { 'onnx/model.onnx': 'ab'.repeat(32) },
    fetchImpl: async () => ({ ok: true, status: 200, body: webStream(Buffer.from('bad-bytes')) }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'bad_artifact');
  assert.equal(existsSync(`${dest}.part`), false);
});

test('downloadFile overwrites the part when the server ignores Range', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'embedder-dl-'));
  const dest = join(dir, 'model.onnx');
  const full = Buffer.from('abcdefghijklmnop');
  writeFileSync(`${dest}.part`, Buffer.from('XXXX'));
  await downloadFile('https://example.test/model.onnx', dest, {
    expectedSha: sha256(full),
    fetchImpl: async () => ({ ok: true, status: 200, body: webStream(full) }),
  });
  assert.equal(readFileSync(dest).equals(full), true);
  assert.equal(statSync(dest).size, full.length);
});
