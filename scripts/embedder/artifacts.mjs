import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HF_ID, OWNED_ARTIFACTS } from './recipe.mjs';

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

async function downloadFile(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.part`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download-failed:${res.status}`);
  await pipeline(res.body, createWriteStream(tmp));
  renameSync(tmp, dest);
}

export async function ensureArtifacts(cacheDir, { fetchIfMissing = true } = {}) {
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
      await downloadFile(url, dest);
    } catch (error) {
      try { rmSync(`${dest}.${process.pid}.part`, { force: true }); } catch { /* ignore */ }
      return { ok: false, code: 'unavailable', reason: String(error.message || error) };
    }
  }
  verified = verifyArtifacts(cacheDir);
  return verified.ok ? verified : { ok: false, code: 'bad_artifact' };
}
