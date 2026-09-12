/** Published Seed projection — mirror of substrate/src/semantic-projection.ts. */

export const SEMANTIC_PROJECTION_SEED = 20260808;
export const SEM_DIM = 16;
export const EMBED_DIM = 768;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let cachedMatrix = null;

function projectionMatrix() {
  if (cachedMatrix !== null) return cachedMatrix;
  const rand = mulberry32(SEMANTIC_PROJECTION_SEED);
  const matrix = new Float64Array(SEM_DIM * EMBED_DIM);
  for (let i = 0; i < matrix.length; i++) {
    matrix[i] = (rand() + rand() + rand() + rand() - 2) / Math.sqrt(EMBED_DIM / 4);
  }
  cachedMatrix = matrix;
  return matrix;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

export function projectEmbedding(embedding) {
  if (embedding.length !== EMBED_DIM) {
    throw new Error(`semantic projection expects ${EMBED_DIM} dims, got ${embedding.length}`);
  }
  let normSq = 0;
  for (const v of embedding) normSq += v * v;
  const norm = Math.sqrt(normSq) || 1;
  const matrix = projectionMatrix();
  const out = new Array(SEM_DIM);
  for (let i = 0; i < SEM_DIM; i++) {
    let sum = 0;
    const row = i * EMBED_DIM;
    for (let j = 0; j < EMBED_DIM; j++) {
      sum += (matrix[row + j] ?? 0) * ((embedding[j] ?? 0) / norm);
    }
    out[i] = Math.round(clamp(sum, -1, 1) * 10_000) / 10_000;
  }
  return out;
}

export function l2Norm(vec) {
  let s = 0;
  for (const v of vec) s += v * v;
  return Math.sqrt(s);
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export function alnumLength(text) {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '').length;
}
