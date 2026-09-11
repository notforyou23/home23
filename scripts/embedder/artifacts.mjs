import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { HF_ID, OWNED_ARTIFACTS } from './recipe.mjs';

const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024 * 1024;

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function modelRoot(cacheDir) {
  return join(cacheDir, HF_ID);
}

export function verifyArtifacts(cacheDir) {
  const root = modelRoot(cacheDir);
  const checked = {};
  for (const [rel, expected] of Object.entries(OWNED_ARTIFACTS)) {
    const path = join(root, rel);
    if (!existsSync(path)) return { ok: false, code: 'bad_artifact', missing: rel };
    const actual = sha256File(path);
    if (actual !== expected) return { ok: false, code: 'bad_artifact', mismatch: rel };
    checked[rel] = actual;
  }
  return { ok: true, artifactDigests: checked, root };
}

function nodeReadable(body) {
  if (!body) return null;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  return body;
}

export async function downloadFile(url, dest, {
  expectedSha,
  signal,
  fetchImpl = fetch,
  maxBytes = MAX_DOWNLOAD_BYTES,
} = {}) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  const existing = existsSync(tmp) ? statSync(tmp).size : 0;
  const headers = {};
  if (existing > 0) headers.Range = `bytes=${existing}-`;
  const res = await fetchImpl(url, { headers, signal });
  if (res.status === 416 && existing > 0 && expectedSha && sha256File(tmp) === expectedSha) {
    renameSync(tmp, dest);
    return dest;
  }
  if (!res.body || (res.status !== 200 && res.status !== 206)) {
    throw new Error(`download-failed:${res.status}`);
  }
  const length = Number.parseInt(res.headers?.get?.('content-length') || '', 10);
  const projected = (res.status === 206 ? existing : 0) + (Number.isFinite(length) ? length : 0);
  if (projected > maxBytes) throw new Error('download-failed:too_large');
  const append = res.status === 206 && existing > 0;
  if (!append && existsSync(tmp)) rmSync(tmp, { force: true });
  await pipeline(nodeReadable(res.body), createWriteStream(tmp, append ? { flags: 'a' } : undefined));
  if (existsSync(tmp) && statSync(tmp).size > maxBytes) {
    rmSync(tmp, { force: true });
    throw new Error('download-failed:too_large');
  }
  if (expectedSha) {
    if (!existsSync(tmp) || sha256File(tmp) !== expectedSha) {
      rmSync(tmp, { force: true });
      throw new Error('bad_artifact');
    }
  }
  renameSync(tmp, dest);
  return dest;
}

export async function ensureArtifacts(cacheDir, { fetchIfMissing = true, signal } = {}) {
  if (typeof cacheDir !== 'string' || !cacheDir.trim()) {
    throw new Error('HOME23_EMBEDDER_CACHE is required and must be an explicit directory');
  }
  if (cacheDir === '~' || cacheDir.startsWith('~/') || cacheDir === process.env.HOME) {
    throw new Error('HOME23_EMBEDDER_CACHE must not be the GUI or home directory');
  }
  if (cacheDir.includes('/release/home23')) {
    throw new Error('HOME23_EMBEDDER_CACHE must not use release/home23');
  }
  mkdirSync(cacheDir, { recursive: true });
  let verified = verifyArtifacts(cacheDir);
  if (verified.ok) return verified;
  if (!fetchIfMissing) return verified;
  const root = modelRoot(cacheDir);
  for (const rel of Object.keys(OWNED_ARTIFACTS)) {
    const dest = join(root, rel);
    if (existsSync(dest) && sha256File(dest) === OWNED_ARTIFACTS[rel]) continue;
    const url = `https://huggingface.co/${HF_ID}/resolve/main/${rel}`;
    try {
      await downloadFile(url, dest, { expectedSha: OWNED_ARTIFACTS[rel], signal });
    } catch (error) {
      try { rmSync(`${dest}.part`, { force: true }); } catch { /* ignore */ }
      return { ok: false, code: error.message === 'bad_artifact' ? 'bad_artifact' : 'unavailable', reason: String(error.message || error) };
    }
  }
  verified = verifyArtifacts(cacheDir);
  return verified.ok ? verified : { ok: false, code: 'bad_artifact' };
}
