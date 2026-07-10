/**
 * done-when.js — goal-completion verifier.
 *
 * Every goal carries a `doneWhen.criteria` array. Each criterion is a
 * concrete, checkable condition. This module dispatches each criterion to
 * a primitive handler and returns whether it passed.
 *
 * Non-LLM primitives (this file) are synchronous-ish and cheap. The
 * LLM-based `judged` primitive lives alongside but has its own caching
 * contract (added in Task 2).
 *
 * env shape:
 *   { memory, logger, outputsDir, brainDir, llmClient? }
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutputsRelativePath } = require('./deliverable-paths');

const JUDGE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 12_000;
const MAX_ARTIFACT_CHARS = 8_000;

function resolveSafe(baseDir, relPath) {
  // Goals often say "outputs/foo.json" while env.outputsDir is already .../outputs.
  // Normalize first so file_exists checks hit the real top-level artifact.
  const normalized = normalizeOutputsRelativePath(relPath) || relPath;
  const full = path.resolve(baseDir, normalized);
  const rel = path.relative(baseDir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return full;
}

async function checkFileExists(crit, env) {
  const resolved = resolveSafe(env.outputsDir, crit.path);
  if (!resolved) return { passed: false, note: 'path outside outputsDir' };
  return { passed: fs.existsSync(resolved), note: resolved };
}

async function checkFileCreatedAfter(crit, env) {
  const resolved = resolveSafe(env.outputsDir, crit.path);
  if (!resolved) return { passed: false, note: 'path outside outputsDir' };
  if (!fs.existsSync(resolved)) return { passed: false, note: 'missing' };
  const stat = fs.statSync(resolved);
  const since = typeof crit.since === 'string' ? Date.parse(crit.since) : Number(crit.since);
  return { passed: stat.mtimeMs > since, note: `mtime=${stat.mtimeMs} since=${since}` };
}

async function checkMemoryNodeTagged(crit, env) {
  const tag = String(crit.tag || '').toLowerCase();
  if (!tag) return { passed: false, note: 'empty tag' };
  if (!env.memory?.nodes) return { passed: false, note: 'no memory' };
  for (const node of env.memory.nodes.values()) {
    if (String(node.tag || '').toLowerCase() === tag) {
      return { passed: true, note: `node id=${node.id}` };
    }
  }
  return { passed: false, note: 'no matching node' };
}

async function checkMemoryNodeMatches(crit, env) {
  if (!crit.regex) return { passed: false, note: 'no regex' };
  if (!env.memory?.nodes) return { passed: false, note: 'no memory' };
  let re;
  try { re = new RegExp(crit.regex, 'i'); }
  catch (err) { return { passed: false, note: `bad regex: ${err.message}` }; }
  for (const node of env.memory.nodes.values()) {
    if (re.test(node.concept || '')) {
      return { passed: true, note: `node id=${node.id}` };
    }
  }
  return { passed: false, note: 'no matching concept' };
}

async function checkOutputCountSince(crit, env) {
  const baseDir = crit.dir === '.' || !crit.dir ? env.outputsDir
    : resolveSafe(env.outputsDir, crit.dir);
  if (!baseDir) return { passed: false, note: 'dir outside outputsDir' };
  if (!fs.existsSync(baseDir)) return { passed: false, note: 'dir missing' };
  const since = typeof crit.since === 'string' ? Date.parse(crit.since) : Number(crit.since);
  const gte = Number(crit.gte) || 1;
  let count = 0;
  for (const name of fs.readdirSync(baseDir)) {
    const full = path.join(baseDir, name);
    const st = fs.statSync(full);
    if (st.isFile() && st.mtimeMs > since) count++;
  }
  return { passed: count >= gte, note: `count=${count} gte=${gte}` };
}

function referencedOutputPaths(crit) {
  const text = String([crit?.path, crit?.file, crit?.artifact, crit?.criterion].filter(Boolean).join('\n'));
  const paths = new Set();
  for (const match of text.matchAll(/\boutputs\/([A-Za-z0-9._/-]+\.[A-Za-z0-9]+)\b/g)) {
    paths.add(match[1]);
  }
  for (const match of text.matchAll(/\b([A-Za-z0-9._/-]+\.(?:md|txt|json|html|csv))\b/g)) {
    const candidate = match[1].replace(/^outputs\//, '');
    if (!candidate.includes('..')) paths.add(candidate);
  }
  return [...paths];
}

function readOutputArtifactSnippets(crit, env) {
  if (!env?.outputsDir) return [];
  const snippets = [];
  for (const relPath of referencedOutputPaths(crit)) {
    const resolved = resolveSafe(env.outputsDir, relPath);
    if (!resolved || !fs.existsSync(resolved)) continue;
    let stat;
    try { stat = fs.statSync(resolved); } catch { continue; }
    if (!stat.isFile()) continue;
    let raw;
    try { raw = fs.readFileSync(resolved, 'utf8'); } catch { continue; }
    snippets.push({
      path: relPath,
      size: stat.size,
      content: raw.slice(0, MAX_ARTIFACT_CHARS),
      truncated: Buffer.byteLength(raw, 'utf8') > MAX_ARTIFACT_BYTES || raw.length > MAX_ARTIFACT_CHARS,
    });
  }
  return snippets;
}

async function checkJudged(crit, env) {
  const cachedValid = crit.judgedVerdict && crit.judgedAt
    && (Date.now() - Number(crit.judgedAt) < JUDGE_TTL_MS);
  if (cachedValid) {
    return {
      passed: crit.judgedVerdict === 'pass',
      note: `cached verdict=${crit.judgedVerdict}`,
      judgedAt: crit.judgedAt,
    };
  }
  if (!env.llmClient) {
    return { passed: false, note: 'no llmClient available' };
  }
  const artifacts = readOutputArtifactSnippets(crit, env);
  const artifactBlock = artifacts.length
    ? artifacts.map((artifact) => [
      `Path: outputs/${artifact.path}`,
      `Size: ${artifact.size} bytes${artifact.truncated ? ' (truncated)' : ''}`,
      'Content:',
      artifact.content,
    ].join('\n')).join('\n\n---\n\n')
    : 'No referenced output artifacts were found under outputsDir.';
  const prompt = [
    { role: 'system', content:
      'You are a strict verifier. Given a goal success criterion, decide whether the criterion is currently satisfied by observable artifacts in the environment. Return ONLY JSON: {"verdict":"pass"|"fail","reason":"<one sentence>"}.' },
    { role: 'user', content:
      `Criterion: ${crit.criterion}\n\nObservable output artifacts:\n${artifactBlock}\n\nRespond with JSON only.` }
  ];
  let verdict, reason;
  try {
    const resp = await env.llmClient.chat({
      model: crit.judgeModel || 'gpt-5.4-mini',
      messages: prompt,
      max_completion_tokens: 200,
      temperature: 0.1,
    });
    const parsed = JSON.parse((resp.content || '').trim());
    verdict = parsed.verdict;
    reason = parsed.reason;
  } catch (err) {
    return { passed: false, note: `judge parse error: ${err.message}` };
  }
  if (verdict !== 'pass' && verdict !== 'fail') {
    return { passed: false, note: `judge invalid verdict: ${verdict}` };
  }
  crit.judgedAt = Date.now();
  crit.judgedVerdict = verdict;
  return {
    passed: verdict === 'pass',
    note: `verdict=${verdict} reason=${reason}`,
    judgedAt: crit.judgedAt,
  };
}

const DISPATCH = {
  file_exists: checkFileExists,
  file_created_after: checkFileCreatedAfter,
  memory_node_tagged: checkMemoryNodeTagged,
  memory_node_matches: checkMemoryNodeMatches,
  output_count_since: checkOutputCountSince,
  judged: checkJudged,
};

async function checkCriterion(crit, env) {
  const handler = DISPATCH[crit?.type];
  if (!handler) return { passed: false, note: `unknown type: ${crit?.type}` };
  try {
    return await handler(crit, env);
  } catch (err) {
    return { passed: false, note: `handler error: ${err.message}` };
  }
}

async function checkDoneWhen(goal, env) {
  const criteria = goal?.doneWhen?.criteria;
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return { satisfied: 0, total: 0, details: [] };
  }
  const details = [];
  let satisfied = 0;
  for (const crit of criteria) {
    const r = await checkCriterion(crit, env);
    details.push({ type: crit.type, passed: !!r.passed, note: r.note, judgedAt: r.judgedAt });
    if (r.passed) satisfied++;
  }
  return { satisfied, total: criteria.length, details };
}

module.exports = { checkCriterion, checkDoneWhen, DISPATCH, JUDGE_TTL_MS };
