/**
 * The writer-side local embedder fetch — ONE substrate copy (P2-15b,
 * 2026-08-11). conversation-shipper and house-sense each carried an inline
 * duplicate of this call with their own timeouts; changing the embedder
 * meant editing three fetch implementations. The third copy is harness-side
 * (src/substrate/embed-at-contact.ts) and stays separate by the membrane
 * seam — the substrate package never links against harness code — but both
 * honor the same env overrides, so the embedder is one knob:
 *
 *   SEED_EMBED_ENDPOINT — default http://127.0.0.1:11434/api/embeddings
 *   SEED_EMBED_MODEL    — default nomic-embed-text
 *
 * Credential-free by design: the local embedder needs no key, so this does
 * not touch the substrate's no-credentials law (membrane 'secret.read'
 * stays FORBIDDEN).
 */

import { execFileSync } from 'node:child_process';

export const SEED_EMBED_ENDPOINT = process.env['SEED_EMBED_ENDPOINT'] ?? 'http://127.0.0.1:11434/api/embeddings';
export const SEED_EMBED_MODEL = process.env['SEED_EMBED_MODEL'] ?? 'nomic-embed-text';

/** Raw embedding at the declared dimensionality, or null (degraded-honest —
 * absence over fabrication; callers project or skip). */
export function fetchRawEmbedding(text: string, expectedDim: number, timeoutSeconds = 2): number[] | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  try {
    const body = JSON.stringify({ model: SEED_EMBED_MODEL, prompt: trimmed.slice(0, 1000) });
    const raw = execFileSync('curl', ['-s', '-m', String(timeoutSeconds), SEED_EMBED_ENDPOINT, '-d', body], {
      encoding: 'utf-8',
      timeout: timeoutSeconds * 1000 + 500,
    });
    const parsed = JSON.parse(raw) as { embedding?: number[] };
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== expectedDim) return null;
    return parsed.embedding;
  } catch {
    return null;
  }
}
