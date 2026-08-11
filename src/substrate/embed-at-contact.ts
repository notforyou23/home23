/**
 * Perception at contact, harness side (encoder stage 2).
 *
 * The substrate's rule: meaning is perceived ONCE, where the event is born,
 * and the projected vector rides the record forever. Stage 1 gave jtr's
 * inbox to bobby a voice; stage 2 gives it to the house's own writers — the
 * relationship ledger (title/statement/why are real language) and worker
 * receipts (summary/rootCause) — so every Seed eating those streams eats
 * meaning.
 *
 * The projection here is a MIRROR of substrate/src/semantic-projection.ts
 * (same published seed, same math, same quantization) because the harness
 * build cannot reach across package roots. A parity test pins the two
 * implementations equal; if you change one, the test forces you to change
 * both. Never change the seed: it is the species-level retina, and events
 * already on chains were perceived through it.
 *
 * Embedding is a bounded SYNCHRONOUS call to the local embedder (these are
 * low-frequency writer paths: a handful of events per hour). Degraded-
 * honest: embedder down, text too short, timeout → null → the line ships
 * without a vector, exactly as it always did.
 */

import { execFileSync } from 'node:child_process';

export const SEMANTIC_PROJECTION_SEED = 20260808;
export const SEM_DIM = 16;
export const EMBED_DIM = 768;
// Same env vocabulary as substrate/src/embed-fetch.ts — the embedder is one
// knob across both packages (P2-15b); the fetch implementations stay
// separate only because the membrane seam forbids substrate→harness links.
const EMBED_ENDPOINT = process.env['SEED_EMBED_ENDPOINT'] ?? 'http://127.0.0.1:11434/api/embeddings';
const EMBED_MODEL = process.env['SEED_EMBED_MODEL'] ?? 'nomic-embed-text';
const MIN_TEXT_LENGTH = 8;
const EMBED_TIMEOUT_MS = 1500;

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

function projectionMatrix(): Float64Array {
  if (cachedMatrix !== null) return cachedMatrix;
  const rand = mulberry32(SEMANTIC_PROJECTION_SEED);
  const matrix = new Float64Array(SEM_DIM * EMBED_DIM);
  for (let i = 0; i < matrix.length; i++) {
    matrix[i] = (rand() + rand() + rand() + rand() - 2) / Math.sqrt(EMBED_DIM / 4);
  }
  cachedMatrix = matrix;
  return matrix;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

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

function fetchEmbedding(text: string): number[] | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH) return null;
  try {
    const body = JSON.stringify({ model: EMBED_MODEL, prompt: trimmed.slice(0, 1000) });
    const raw = execFileSync('curl', ['-s', '-m', String(EMBED_TIMEOUT_MS / 1000), EMBED_ENDPOINT, '-d', body], {
      encoding: 'utf-8',
      timeout: EMBED_TIMEOUT_MS + 500,
    });
    const parsed = JSON.parse(raw) as { embedding?: number[] };
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== EMBED_DIM) return null;
    return parsed.embedding;
  } catch {
    return null;
  }
}

/** Embed + project a piece of text, or null (degraded-honest). Synchronous
 * and bounded — for low-frequency writer paths only. This is the RECORD
 * form: 16 dims, quantized, fit to ride a chain forever. */
export function embedTextSync(text: string): number[] | null {
  const embedding = fetchEmbedding(text);
  return embedding === null ? null : projectEmbedding(embedding);
}

/** Raw 768-dim embedding, or null. For MATCHING only (e.g. the SUBSTRATE
 * surfacing organ deciding which lived items a turn touches): full acuity,
 * never persisted. Calibration (2026-08-08) showed the projected space is
 * too coarse to threshold — related/unrelated turn-item cosines overlap in
 * 16 dims but separate cleanly in the native space. */
export function embedTextRawSync(text: string): number[] | null {
  return fetchEmbedding(text);
}
