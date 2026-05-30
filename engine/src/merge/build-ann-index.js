/**
 * build-ann-index.js — Build a persistent HNSW ANN index from the brain memory sidecar.
 *
 * Why: brain_search was a linear cosine scan over a 1.67GB / ~91k-node gzipped
 * sidecar, taking ~69s/query and timing out under load. This builds a one-time
 * HNSW index (queryable in ms) plus a compact metadata map so search results can
 * be hydrated without re-reading the full sidecar.
 *
 * Outputs (next to the sidecar, in the brain dir):
 *   memory-ann.index   — native hnswlib index (vectors only, by integer label)
 *   memory-ann.meta.json — { dim, count, builtAt, builtFromMtime, labels: [{id,concept,tag,weight,activation,cluster,created,source_class,salienceWeight,provenance}] }
 *
 * Run: node engine/src/merge/build-ann-index.js [brainDir]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { classifyMemoryProvenance } = require('../memory/provenance-salience');

const DIM = 768; // nomic-embed-text
const HNSW_M = 16;
const HNSW_EF_CONSTRUCTION = 200;

function log(...a) { console.log('[build-ann]', ...a); }

async function build(brainDir) {
  const hnswlib = require('hnswlib-node');
  const sidecarPath = path.join(brainDir, 'memory-nodes.jsonl.gz');
  if (!fs.existsSync(sidecarPath)) {
    throw new Error(`sidecar not found: ${sidecarPath}`);
  }
  const sidecarStat = fs.statSync(sidecarPath);
  log(`reading ${sidecarPath} (${(sidecarStat.size / 1e6).toFixed(0)}MB)`);

  // First pass already streamed; we do a single streaming pass to collect
  // embeddings + light metadata. We size the index after a count, so we
  // collect into arrays then init with exact capacity + headroom.
  const labels = [];      // compact metadata, index = hnsw label
  const vectors = [];     // Float32-friendly arrays, index = hnsw label

  const rl = readline.createInterface({
    input: fs.createReadStream(sidecarPath).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });

  let total = 0, skipped = 0;
  for await (const line of rl) {
    if (!line) continue;
    let n;
    try { n = JSON.parse(line); } catch { skipped++; continue; }
    const e = n.embedding;
    if (!Array.isArray(e) || e.length !== DIM) { skipped++; continue; }
    const provenance = classifyMemoryProvenance(n);
    labels.push({
      id: n.id,
      concept: typeof n.concept === 'string' ? n.concept.slice(0, 800) : '',
      tag: n.tag || null,
      weight: n.weight ?? null,
      activation: n.activation ?? null,
      cluster: n.cluster ?? null,
      created: n.created ?? null,
      source_class: n.source_class || provenance.sourceClass,
      salienceWeight: n.salienceWeight ?? provenance.salienceWeight,
      provenance: n.provenance || {
        sourceClass: provenance.sourceClass,
        reason: provenance.reason,
        retention: provenance.retention,
      },
    });
    vectors.push(e);
    total++;
    if (total % 20000 === 0) log(`  ...${total} nodes read`);
  }
  log(`read complete: ${total} usable nodes, ${skipped} skipped`);

  const capacity = total + 1000; // headroom
  const index = new hnswlib.HierarchicalNSW('cosine', DIM);
  index.initIndex(capacity, HNSW_M, HNSW_EF_CONSTRUCTION);

  log(`building HNSW index (M=${HNSW_M}, efC=${HNSW_EF_CONSTRUCTION}, cap=${capacity})`);
  const t0 = Date.now();
  for (let i = 0; i < vectors.length; i++) {
    index.addPoint(vectors[i], i);
    if ((i + 1) % 20000 === 0) log(`  ...${i + 1} points added (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  log(`index built in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  const indexPath = path.join(brainDir, 'memory-ann.index');
  const metaPath = path.join(brainDir, 'memory-ann.meta.json');
  index.writeIndexSync(indexPath);
  fs.writeFileSync(metaPath, JSON.stringify({
    dim: DIM,
    count: total,
    M: HNSW_M,
    efConstruction: HNSW_EF_CONSTRUCTION,
    builtAt: new Date().toISOString(),
    builtFromMtime: sidecarStat.mtime.toISOString(),
    builtFromSize: sidecarStat.size,
    labels,
  }));
  log(`wrote ${indexPath} (${(fs.statSync(indexPath).size / 1e6).toFixed(1)}MB)`);
  log(`wrote ${metaPath} (${(fs.statSync(metaPath).size / 1e6).toFixed(1)}MB)`);
  return { total, indexPath, metaPath };
}

if (require.main === module) {
  const brainDir = process.argv[2] || path.join(__dirname, '../../../instances/jerry/brain');
  build(brainDir)
    .then(r => { log('DONE', r.total, 'nodes indexed'); process.exit(0); })
    .catch(e => { console.error('[build-ann] FAILED:', e.message); process.exit(1); });
}

module.exports = { build, DIM };
