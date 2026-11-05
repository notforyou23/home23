/**
 * dedup-before-spawn.js — spawn-time duplicate-question guard.
 *
 * Jerry's self-diagnosis on 2026-04-17 flagged that the same conclusion
 * gets rediscovered 8–16 times: the health-pipeline diagnosis, the binary-
 * string decoding, the "what is Home23" self-description, etc. Each
 * rediscovery burns an agent cycle. This module checks whether the
 * memory graph already holds an answer-tagged node semantically similar
 * to the pending mission, and signals the caller to skip the spawn.
 *
 * Pure function — no side effects. The caller decides whether to skip.
 */

const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
const DEFAULT_ANSWER_TAG_REGEX = /answer|resolved|finding|conclusion|verdict/i;

/**
 * @param {object} missionSpec   { goalId, description, agentType, ...}
 * @param {object} memory        NetworkMemory-shaped object with async query(text, topK)
 * @param {object} opts          { threshold, answerTagRegex, logger }
 * @returns {Promise<{
 *   duplicate: boolean,
 *   match?: { id, similarity, tag, concept },
 *   reason?: string,
 * }>}
 */
async function checkDedup(missionSpec, memory, opts = {}) {
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : DEFAULT_SIMILARITY_THRESHOLD;
  const answerTagRegex = opts.answerTagRegex || DEFAULT_ANSWER_TAG_REGEX;
  const logger = opts.logger;

  if (!memory || typeof memory.query !== 'function') {
    return { duplicate: false, reason: 'memory has no query method' };
  }

  const queryText = buildQueryText(missionSpec);
  if (!queryText || queryText.trim().length < 10) {
    return { duplicate: false, reason: 'query text too short' };
  }

  let results;
  try {
    results = await memory.query(queryText, 5);
  } catch (err) {
    logger?.warn?.('[dedup] memory query failed', { error: err.message });
    return { duplicate: false, reason: `query error: ${err.message}` };
  }

  if (!Array.isArray(results) || results.length === 0) {
    return { duplicate: false, reason: 'no memory results' };
  }

  // Scan results for an answer-tagged node above threshold. memory.query
  // sets `similarity` on the best match and `activation` on the rest. We
  // honor whichever scalar ranks the node — both are bounded [0,1].
  for (const r of results) {
    const score = Number(r?.similarity ?? r?.activation ?? 0);
    if (!Number.isFinite(score) || score < threshold) continue;
    const tag = String(r?.tag || '');
    if (!answerTagRegex.test(tag)) continue;
    return {
      duplicate: true,
      match: {
        id: r.id,
        similarity: score,
        tag,
        concept: typeof r.concept === 'string' ? r.concept.slice(0, 120) : undefined,
      },
    };
  }
  return { duplicate: false, reason: 'no answer-tagged match above threshold' };
}

function buildQueryText(missionSpec) {
  const parts = [];
  if (missionSpec?.description) parts.push(String(missionSpec.description));
  if (missionSpec?.goal?.description) parts.push(String(missionSpec.goal.description));
  if (missionSpec?.mission) parts.push(String(missionSpec.mission));
  if (missionSpec?.prompt) parts.push(String(missionSpec.prompt));
  return parts.join(' ').slice(0, 600);
}

module.exports = {
  checkDedup,
  buildQueryText,
  DEFAULT_SIMILARITY_THRESHOLD,
  DEFAULT_ANSWER_TAG_REGEX,
};
