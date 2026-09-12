#!/usr/bin/env node
/** Detached Host worker: fetch/verify/warm owned artifacts. One JSON progress file. */
import { absoluteHome, embedderCacheDir } from '../../cli/lib/product-environment.js';
import { beginPhase, failPrep, finishReady } from '../../cli/lib/product-embedder.js';

const args = process.argv.slice(2);
const homeFlag = args.indexOf('--home');
if (homeFlag < 0 || !args[homeFlag + 1]) {
  console.error('Usage: semantic-prepare-worker.mjs --home ABS');
  process.exit(1);
}

const homeRoot = absoluteHome(args[homeFlag + 1]);
const cacheDir = embedderCacheDir(homeRoot);

try {
  beginPhase(homeRoot, 'downloading');
  const { ensureArtifacts } = await import('../embedder/artifacts.mjs');
  const artifacts = await ensureArtifacts(cacheDir, { fetchIfMissing: true });
  if (!artifacts.ok) {
    failPrep(homeRoot, artifacts.code || 'bad_artifact');
    process.exit(1);
  }
  beginPhase(homeRoot, 'verifying', { artifactDigests: artifacts.artifactDigests });
  beginPhase(homeRoot, 'warming');
  const { loadOwnedExtractor, embedOwned } = await import('../embedder/infer.mjs');
  const extractor = await loadOwnedExtractor(cacheDir);
  try {
    const vector = await embedOwned(extractor, 'The library opens at nine.');
    if (!Array.isArray(vector) || vector.length !== 768 || vector.some(n => !Number.isFinite(n))) {
      failPrep(homeRoot, 'bad_artifact');
      process.exit(1);
    }
  } finally {
    try { await extractor?.dispose?.(); } catch { /* ORT teardown may abort; artifacts are already verified. */ }
  }
  finishReady(homeRoot);
} catch (error) {
  failPrep(homeRoot, error.code || 'unavailable', error.message);
  process.exit(1);
}
