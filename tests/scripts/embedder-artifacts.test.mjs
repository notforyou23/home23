import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { downloadFile } from '../../scripts/embedder/artifacts.mjs';

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
