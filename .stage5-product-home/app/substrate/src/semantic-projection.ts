/**
 * Semantic projection — the retina's contract (encoder stage 1).
 *
 * Meaning enters the substrate as a small vector ON THE EVENT, produced once
 * at contact by whatever embedder the writer's machine runs (Home23's local
 * nomic-embed-text today), projected down through THIS fixed, published
 * projection. The projection is the species-level part of perception: every
 * writer that speaks semantic events uses the same matrix, so the same
 * sentence lands in the same direction for every individual, on any silicon.
 *
 * Determinism: perception happens ONCE — the projected vector is part of the
 * event record, so replaying the same lines is byte-identical regardless of
 * embedder availability or drift. Embedder nondeterminism is perception-time
 * nondeterminism, which is honest: organisms do not re-see; the record is
 * what was seen. Quantization to 4 decimals keeps the recorded bytes stable
 * across float formatting.
 *
 * The projection matrix is derived from a published seed via the same
 * mulberry32 the reservoir uses — no weights shipped, fully reproducible.
 */

export const SEMANTIC_PROJECTION_SEED = 20260808;
/** Channels of meaning an event may carry into the reservoir. */
export const SEM_DIM = 16;
/** The embedder dimensionality this projection expects (nomic-embed-text). */
export const EMBED_DIM = 768;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let cachedMatrix: Float64Array | null = null;

/** The fixed SEM_DIM×EMBED_DIM projection, generated on first use. */
function projectionMatrix(): Float64Array {
  if (cachedMatrix !== null) return cachedMatrix;
  const rand = mulberry32(SEMANTIC_PROJECTION_SEED);
  const matrix = new Float64Array(SEM_DIM * EMBED_DIM);
  // Gaussian-ish entries via central limit (sum of uniforms), scaled for
  // unit-norm inputs to land comfortably inside [-1, 1] after tanh-free clamp.
  for (let i = 0; i < matrix.length; i++) {
    matrix[i] = (rand() + rand() + rand() + rand() - 2) / Math.sqrt(EMBED_DIM / 4);
  }
  cachedMatrix = matrix;
  return matrix;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Project a full embedding down to the event's semantic vector.
 * Input is L2-normalized first (embedders vary in scale); output is clamped
 * to [-1, 1] and quantized to 4 decimals (stable recorded bytes).
 */
export function projectEmbedding(embedding: readonly number[]): number[] {
  if (embedding.length !== EMBED_DIM) {
    throw new Error(`semantic projection expects ${EMBED_DIM} dims, got ${embedding.length}`);
  }
  let normSq = 0;
  for (const v of embedding) normSq += v * v;
  const norm = Math.sqrt(normSq) || 1;
  const matrix = projectionMatrix();
  const out: number[] = new Array(SEM_DIM);
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

/** Validate a semantic vector arriving on a source line: finite numbers,
 * sane length, values in [-1, 1] (clamped). Returns null when unusable. */
export function sanitizeSemanticVector(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 64) return null;
  const out: number[] = new Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    out[i] = clamp(v, -1, 1);
  }
  return out;
}
