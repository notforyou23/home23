#!/usr/bin/env node
/**
 * Stage 1 compatibility experiment. Isolated from product defaults.
 * Real Ollama baseline + real Transformers.js ONNX candidate under Node 22.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { alnumLength, cosine, EMBED_DIM, l2Norm, projectEmbedding } from './projection.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MATCH_FLOOR = 0.6;
const MATCH_MARGIN = 0.12;
const MIN_ALNUM = 20;
const SEED_TIMEOUT_MS = 1500;
const OLLAMA_HOST = process.env.EMBEDDER_EXPERIMENT_OLLAMA || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.EMBEDDER_EXPERIMENT_OLLAMA_MODEL || 'nomic-embed-text';
const ONNX_MODEL_CANDIDATES = (process.env.EMBEDDER_EXPERIMENT_ONNX_MODEL || 'nomic-ai/nomic-embed-text-v1.5,Xenova/nomic-embed-text-v1.5')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ONNX_DTYPE = process.env.EMBEDDER_EXPERIMENT_ONNX_DTYPE || 'fp32';
const SKIP_ONNX = process.env.EMBEDDER_EXPERIMENT_SKIP_ONNX === '1';
const CACHE_DIR = process.env.EMBEDDER_EXPERIMENT_CACHE || join(here, '.cache');
const RESULTS_DIR = join(here, 'results');

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function summarize(values) {
  if (values.length === 0) return { n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return {
    n: values.length,
    min: sorted[0],
    p50: percentile(sorted, 50),
    p85: percentile(sorted, 85),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean: Number(mean.toFixed(6)),
  };
}

function rssMb() {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 10) / 10;
}

function walkFiles(root, acc = []) {
  if (!existsSync(root)) return acc;
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const st = statSync(path);
    if (st.isDirectory()) walkFiles(path, acc);
    else acc.push({ path, bytes: st.size });
  }
  return acc;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function prepareSeedText(text) {
  const trimmed = String(text).trim();
  if (trimmed.length < 8) return null;
  return trimmed.slice(0, 1000);
}

function prepareMemoryText(text) {
  const value = String(text || '');
  return value.length > 2000 ? value.slice(0, 2000) : value;
}

async function ollamaNative(text, { timeoutMs = 120000, prefix = '' } = {}) {
  const prepared = prepareSeedText(text);
  if (prepared === null) return { ok: false, reason: 'too-short' };
  const prompt = prefix ? `${prefix}${prepared}` : prepared;
  const started = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_MODEL, prompt }),
      signal: ac.signal,
    });
    const raw = await res.text();
    const ms = performance.now() - started;
    if (!res.ok) return { ok: false, reason: `http-${res.status}`, ms, body: raw.slice(0, 200) };
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length !== EMBED_DIM) {
      return { ok: false, reason: 'bad-dim', ms, dim: parsed.embedding?.length ?? null };
    }
    return { ok: true, embedding: parsed.embedding, ms, dim: parsed.embedding.length, protocol: 'ollama-native' };
  } catch (error) {
    return { ok: false, reason: error.name === 'AbortError' ? 'timeout' : String(error.message || error), ms: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaOpenAI(text, { timeoutMs = 120000 } = {}) {
  const input = prepareMemoryText(text);
  const started = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA_HOST}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ollama' },
      body: JSON.stringify({ model: OLLAMA_MODEL, input }),
      signal: ac.signal,
    });
    const raw = await res.text();
    const ms = performance.now() - started;
    if (!res.ok) return { ok: false, reason: `http-${res.status}`, ms, body: raw.slice(0, 200) };
    const parsed = JSON.parse(raw);
    const embedding = parsed?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== EMBED_DIM) {
      return { ok: false, reason: 'bad-dim', ms, dim: embedding?.length ?? null };
    }
    return { ok: true, embedding, ms, dim: embedding.length, protocol: 'openai-compatible' };
  } catch (error) {
    return { ok: false, reason: error.name === 'AbortError' ? 'timeout' : String(error.message || error), ms: performance.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

async function loadOnnx() {
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = CACHE_DIR;
  env.allowRemoteModels = true;
  const errors = [];
  const rssBefore = rssMb();
  for (const model of ONNX_MODEL_CANDIDATES) {
    const started = performance.now();
    try {
      const extractor = await pipeline('feature-extraction', model, { dtype: ONNX_DTYPE });
      return { extractor, model, coldMs: performance.now() - started, rssBefore, rssAfterLoad: rssMb(), attempts: errors };
    } catch (error) {
      errors.push({ model, error: String(error.message || error) });
    }
  }
  throw new Error(`ONNX load failed: ${JSON.stringify(errors)}`);
}

async function onnxEmbed(extractor, text, { prefix = '', normalize = false, pooling = 'mean' } = {}) {
  const prepared = prepareSeedText(text);
  if (prepared === null) return { ok: false, reason: 'too-short' };
  const input = prefix ? `${prefix}${prepared}` : prepared;
  const started = performance.now();
  try {
    const output = await extractor(input, { pooling, normalize });
    const embedding = Array.from(output?.tolist?.()?.[0] ?? output?.data ?? []);
    const ms = performance.now() - started;
    if (embedding.length !== EMBED_DIM) return { ok: false, reason: 'bad-dim', ms, dim: embedding.length };
    return { ok: true, embedding, ms, dim: embedding.length, protocol: 'onnx-transformersjs' };
  } catch (error) {
    return { ok: false, reason: String(error.message || error), ms: performance.now() - started };
  }
}

function sharedGate(score, turnText) {
  if (alnumLength(turnText) < MIN_ALNUM) return { skipped: true, admit: false };
  return { skipped: false, admit: score >= MATCH_FLOOR };
}

function seedContextGate(score, poolScores, turnText) {
  if (alnumLength(turnText) < MIN_ALNUM) return { skipped: true, admit: false, median: null };
  const sorted = [...poolScores].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return { skipped: false, admit: score >= MATCH_FLOOR && score - median >= MATCH_MARGIN, median };
}

function projectionAgreement(a, b) {
  const pa = projectEmbedding(a);
  const pb = projectEmbedding(b);
  let equal4dp = true;
  let maxAbs = 0;
  for (let i = 0; i < pa.length; i++) {
    const d = Math.abs(pa[i] - pb[i]);
    if (d > maxAbs) maxAbs = d;
    if (pa[i] !== pb[i]) equal4dp = false;
  }
  return { equal4dp, maxAbs, cosine: cosine(pa, pb), projectedA: pa, projectedB: pb };
}

async function embedAll(name, embedFn, texts) {
  const vectors = {};
  const timings = [];
  const failures = [];
  for (const [id, text] of Object.entries(texts)) {
    const result = await embedFn(text);
    if (!result.ok) {
      failures.push({ id, reason: result.reason, ms: result.ms ?? null });
      vectors[id] = null;
      continue;
    }
    vectors[id] = result.embedding;
    timings.push(result.ms);
  }
  return { name, vectors, timings, failures };
}

function pairStats(pairs, texts, leftVecs, rightVecs) {
  const rows = [];
  for (const pair of pairs) {
    const a = leftVecs[pair.left];
    const b = rightVecs[pair.right];
    if (!a || !b) {
      rows.push({ id: pair.id, kind: pair.kind, ok: false, reason: 'missing-vector' });
      continue;
    }
    const score = cosine(a, b);
    const turnText = texts[pair.left];
    const gate = sharedGate(score, turnText);
    rows.push({
      id: pair.id,
      kind: pair.kind,
      expect: pair.expect,
      score: Number(score.toFixed(6)),
      sharedGate: gate,
      aboveFloor: !gate.skipped && score >= MATCH_FLOOR,
    });
  }
  return rows;
}

function comparePairGates(baselineRows, candidateRows) {
  const byId = new Map(candidateRows.map((row) => [row.id, row]));
  let agree = 0;
  let disagree = 0;
  const disagreements = [];
  for (const base of baselineRows) {
    const other = byId.get(base.id);
    if (!other || !base.sharedGate || !other.sharedGate) continue;
    const same = base.sharedGate.skipped === other.sharedGate.skipped
      && base.sharedGate.admit === other.sharedGate.admit;
    if (same) agree += 1;
    else {
      disagree += 1;
      disagreements.push({
        id: base.id,
        kind: base.kind,
        baselineScore: base.score,
        candidateScore: other.score,
        baselineAdmit: base.sharedGate.admit,
        candidateAdmit: other.sharedGate.admit,
      });
    }
  }
  return { agree, disagree, disagreements };
}

function retrievalRanks(set, queryVecs, docVecs) {
  const q = queryVecs[set.query];
  if (!q) return { id: set.id, ok: false, reason: 'missing-query' };
  const ranked = set.documents
    .map((id) => ({ id, score: docVecs[id] ? cosine(q, docVecs[id]) : null }))
    .filter((row) => row.score !== null)
    .sort((a, b) => b.score - a.score);
  const relevantRanks = set.relevant.map((id) => ranked.findIndex((row) => row.id === id) + 1 || null);
  return {
    id: set.id,
    ok: true,
    top: ranked[0]?.id ?? null,
    relevantRanks,
    scores: ranked.map((row) => ({ id: row.id, score: Number(row.score.toFixed(6)) })),
  };
}

async function main() {
  if (!process.version.startsWith('v22.')) {
    console.error(`Refusing to run: packaged-runtime constraint is Node 22, this is ${process.version}`);
    process.exit(2);
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  const corpus = JSON.parse(readFileSync(join(here, 'corpus.json'), 'utf8'));
  const inventory = JSON.parse(readFileSync(join(here, 'inventory.json'), 'utf8'));
  const privatePath = process.env.EMBEDDER_EXPERIMENT_PRIVATE_CORPUS || join(here, 'private-corpus.json');
  const privateCorpus = existsSync(privatePath) ? JSON.parse(readFileSync(privatePath, 'utf8')) : null;

  const hardware = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    rssMbStart: rssMb(),
  };

  const tagsRes = await fetch(`${OLLAMA_HOST}/api/tags`);
  const tags = tagsRes.ok ? await tagsRes.json() : { error: `http-${tagsRes.status}` };
  const baselineModel = Array.isArray(tags.models)
    ? tags.models.find((m) => String(m.name || '').startsWith(OLLAMA_MODEL))
    : null;

  const warmup = await ollamaNative('The library opens at nine.');
  const deadlineProbe = [];
  for (let i = 0; i < 8; i += 1) {
    const r = await ollamaNative('Install Node.js 22 from the official site, then verify the version.', { timeoutMs: SEED_TIMEOUT_MS });
    deadlineProbe.push({ ok: r.ok, ms: r.ms ?? null, reason: r.reason ?? null });
  }

  const backends = [];
  backends.push({
    id: 'ollama-seed',
    kind: 'real-baseline',
    embed: (text) => ollamaNative(text),
  });
  backends.push({
    id: 'ollama-memory',
    kind: 'real-baseline-protocol',
    embed: (text) => ollamaOpenAI(text),
  });
  backends.push({
    id: 'ollama-seed-search_document',
    kind: 'real-baseline-prefix-ablation',
    embed: (text) => ollamaNative(text, { prefix: 'search_document: ' }),
  });

  let onnxMeta = null;
  if (!SKIP_ONNX) {
    try {
      const loaded = await loadOnnx();
      onnxMeta = {
        model: loaded.model,
        dtype: ONNX_DTYPE,
        coldLoadMs: loaded.coldMs,
        rssBeforeMb: loaded.rssBefore,
        rssAfterLoadMb: loaded.rssAfterLoad,
        attempts: loaded.attempts,
      };
      const extractor = loaded.extractor;
      backends.push({
        id: 'onnx-fp32-noprefix',
        kind: 'real-candidate',
        embed: (text) => onnxEmbed(extractor, text, { prefix: '', normalize: false }),
      });
      backends.push({
        id: 'onnx-fp32-noprefix-l2',
        kind: 'real-candidate',
        embed: (text) => onnxEmbed(extractor, text, { prefix: '', normalize: true }),
      });
      backends.push({
        id: 'onnx-fp32-search_document',
        kind: 'real-candidate-nomic-recipe',
        embed: (text) => onnxEmbed(extractor, text, { prefix: 'search_document: ', normalize: true }),
      });
      backends.push({
        id: 'onnx-fp32-search_query',
        kind: 'real-candidate-nomic-recipe',
        embed: (text) => onnxEmbed(extractor, text, { prefix: 'search_query: ', normalize: true }),
      });
      backends.push({
        id: 'onnx-fp32-cls-noprefix',
        kind: 'real-candidate-pooling-ablation',
        embed: (text) => onnxEmbed(extractor, text, { prefix: '', normalize: false, pooling: 'cls' }),
      });
    } catch (error) {
      onnxMeta = { error: String(error.message || error) };
    }
  } else {
    onnxMeta = { skipped: true };
  }

  const runs = {};
  for (const backend of backends) {
    console.error(`embedding via ${backend.id}...`);
    runs[backend.id] = await embedAll(backend.id, backend.embed, corpus.texts);
    runs[backend.id].kind = backend.kind;
  }

  const baseline = runs['ollama-seed'];
  const comparisons = {};
  for (const [id, run] of Object.entries(runs)) {
    if (id === 'ollama-seed') continue;
    const agreements = [];
    const proj = [];
    const norms = [];
    for (const textId of Object.keys(corpus.texts)) {
      const a = baseline.vectors[textId];
      const b = run.vectors[textId];
      if (!a || !b) continue;
      agreements.push(cosine(a, b));
      const p = projectionAgreement(a, b);
      proj.push(p);
      norms.push({ id: textId, baselineL2: l2Norm(a), candidateL2: l2Norm(b) });
    }
    const pairBase = pairStats(corpus.pairs, corpus.texts, baseline.vectors, baseline.vectors);
    const pairCand = pairStats(corpus.pairs, corpus.texts, run.vectors, run.vectors);
    const seedPools = corpus.seedContextPools.map((pool) => {
      const turnB = baseline.vectors[pool.turn];
      const turnC = run.vectors[pool.turn];
      const scoresB = pool.anchors.map((aid) => (turnB && baseline.vectors[aid] ? cosine(turnB, baseline.vectors[aid]) : null)).filter((v) => v !== null);
      const scoresC = pool.anchors.map((aid) => (turnC && run.vectors[aid] ? cosine(turnC, run.vectors[aid]) : null)).filter((v) => v !== null);
      const targetB = turnB && baseline.vectors[pool.anchors[0]] ? cosine(turnB, baseline.vectors[pool.anchors[0]]) : null;
      const targetC = turnC && run.vectors[pool.anchors[0]] ? cosine(turnC, run.vectors[pool.anchors[0]]) : null;
      return {
        id: pool.id,
        baseline: targetB === null ? null : seedContextGate(targetB, scoresB, corpus.texts[pool.turn]),
        candidate: targetC === null ? null : seedContextGate(targetC, scoresC, corpus.texts[pool.turn]),
        baselineTarget: targetB,
        candidateTarget: targetC,
      };
    });
    comparisons[id] = {
      perVectorCosine: summarize(agreements),
      below099: agreements.filter((v) => v < 0.99).length,
      below095: agreements.filter((v) => v < 0.95).length,
      projectionEqual4dp: proj.filter((p) => p.equal4dp).length,
      projectionTotal: proj.length,
      projectionMaxAbs: proj.reduce((m, p) => Math.max(m, p.maxAbs), 0),
      projectionCosine: summarize(proj.map((p) => p.cosine)),
      pairGates: comparePairGates(pairBase, pairCand),
      seedContextPools: seedPools,
      retrievalBaseline: corpus.retrievalSets.map((set) => retrievalRanks(set, baseline.vectors, baseline.vectors)),
      retrievalCandidate: corpus.retrievalSets.map((set) => retrievalRanks(set, run.vectors, run.vectors)),
      pairScoresBaseline: pairBase,
      pairScoresCandidate: pairCand,
      norms: {
        baseline: summarize(norms.map((n) => n.baselineL2)),
        candidate: summarize(norms.map((n) => n.candidateL2)),
      },
    };
  }

  const cacheFiles = walkFiles(CACHE_DIR);
  const modelFiles = cacheFiles
    .filter((f) => /onnx|json|txt|safetensor|bin$/i.test(f.path))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 20)
    .map((f) => ({
      rel: f.path.slice(CACHE_DIR.length + 1),
      bytes: f.bytes,
      sha256: f.bytes <= 80 * 1024 * 1024 ? sha256File(f.path) : 'skipped-large',
    }));

  const long = `${corpus.texts.truncation_source} ${corpus.texts.embed_doc} ${corpus.texts.recycle_doc}`.repeat(8);
  const seedPrepared = prepareSeedText(long);
  const memoryPrepared = prepareMemoryText(long);
  const truncSeed = await ollamaNative(long);
  const truncMemory = await ollamaOpenAI(long);
  const truncation = {
    rawChars: long.length,
    seedChars: seedPrepared?.length ?? 0,
    memoryChars: memoryPrepared.length,
    seedVsMemoryCosine: truncSeed.ok && truncMemory.ok ? cosine(truncSeed.embedding, truncMemory.embedding) : null,
  };

  let privateSummary = { ran: false, reason: 'no-private-corpus' };
  if (privateCorpus?.texts && privateCorpus?.pairs) {
    const privBase = await embedAll('private-ollama-seed', (text) => ollamaNative(text), privateCorpus.texts);
    const scores = [];
    for (const pair of privateCorpus.pairs) {
      const a = privBase.vectors[pair.left];
      const b = privBase.vectors[pair.right];
      if (a && b) scores.push(cosine(a, b));
    }
    privateSummary = {
      ran: true,
      textCount: Object.keys(privateCorpus.texts).length,
      pairCount: privateCorpus.pairs.length,
      scoreSummary: summarize(scores),
      textsOmitted: true,
    };
  }

  const evidence = {
    generatedAt: new Date().toISOString(),
    hardware,
    baselineModel: {
      name: baselineModel?.name ?? null,
      digest: baselineModel?.digest ?? null,
      size: baselineModel?.size ?? null,
      details: baselineModel?.details ?? null,
      warmupOk: warmup.ok,
      warmupMs: warmup.ms ?? null,
      warmupDim: warmup.ok ? warmup.embedding.length : null,
      warmupL2: warmup.ok ? l2Norm(warmup.embedding) : null,
    },
    onnx: onnxMeta,
    modelCache: {
      dir: CACHE_DIR,
      fileCount: cacheFiles.length,
      bytes: cacheFiles.reduce((s, f) => s + f.bytes, 0),
      topFiles: modelFiles,
    },
    deadline1500ms: {
      trials: deadlineProbe,
      pass: deadlineProbe.filter((t) => t.ok).length,
      fail: deadlineProbe.filter((t) => !t.ok).length,
    },
    timings: Object.fromEntries(Object.entries(runs).map(([id, run]) => [id, { ...summarize(run.timings), failures: run.failures }])),
    comparisons,
    truncation,
    privateCalibration: privateSummary,
    inventoryRef: inventory.sourceCommit,
    corpusId: corpus.id,
    fixture: false,
    realInference: {
      ollama: warmup.ok,
      onnx: Boolean(onnxMeta && !onnxMeta.error && !onnxMeta.skipped && runs['onnx-fp32-noprefix']),
    },
  };

  const out = join(RESULTS_DIR, 'stage1-evidence.json');
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(join(RESULTS_DIR, 'stage1-summary.json'), `${JSON.stringify({
    generatedAt: evidence.generatedAt,
    hardware,
    baseline: evidence.baselineModel,
    onnx: onnxMeta,
    comparisons: Object.fromEntries(Object.entries(comparisons).map(([id, c]) => [id, {
      perVectorCosine: c.perVectorCosine,
      below099: c.below099,
      below095: c.below095,
      projectionEqual4dp: `${c.projectionEqual4dp}/${c.projectionTotal}`,
      projectionMaxAbs: c.projectionMaxAbs,
      pairGateDisagree: c.pairGates.disagree,
      pairGateDisagreements: c.pairGates.disagreements,
    }])),
    timings: evidence.timings,
    deadline1500ms: evidence.deadline1500ms,
    truncation,
    realInference: evidence.realInference,
    modelBytes: evidence.modelCache.bytes,
  }, null, 2)}\n`);
  console.log(out);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
