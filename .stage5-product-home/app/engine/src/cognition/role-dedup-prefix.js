/**
 * role-dedup-prefix.js — pre-turn memory check for cognitive roles.
 *
 * The role cycle (curiosity, analyst, proposal, curator, critic) generates
 * thoughts each cycle without consulting memory for "answered already."
 * dedup-before-spawn protects agent spawns; pin-canonical-nodes seeds
 * memory with answer-tagged nodes. This module closes the remaining
 * gap: when an answer-tagged node matches the current goal topic, inject
 * a prefix into the role prompt telling the role to propose something
 * NEW, a concrete next step, or NO_ACTION — rather than restate the
 * resolved conclusion.
 */

const DEFAULT_THRESHOLD = 0.78;
const ANSWER_TAG_RE = /answer|resolved|finding|conclusion|verdict|insight/i;

function buildQueryText(goal) {
  if (!goal) return '';
  const parts = [];
  if (goal.description) parts.push(String(goal.description));
  if (goal.reason) parts.push(String(goal.reason));
  return parts.join(' ').slice(0, 600);
}

/**
 * @param {object} opts
 *   { goal, memory, threshold, logger }
 * @returns {Promise<{ prefix: string|null, match?: { id, similarity, tag, concept } }>}
 */
async function computeRoleDedupPrefix({ goal, memory, threshold, logger }) {
  if (!memory || typeof memory.query !== 'function') return { prefix: null };
  if (!goal) return { prefix: null };
  const queryText = buildQueryText(goal);
  if (queryText.length < 10) return { prefix: null };

  const th = Number.isFinite(threshold) ? threshold : DEFAULT_THRESHOLD;
  let results;
  try {
    results = await memory.query(queryText, 5);
  } catch (err) {
    logger?.warn?.('[role-dedup] memory query failed', { error: err.message });
    return { prefix: null };
  }
  if (!Array.isArray(results) || results.length === 0) return { prefix: null };

  for (const r of results) {
    const score = Number(r?.similarity ?? r?.activation ?? 0);
    if (!Number.isFinite(score) || score < th) continue;
    const tag = String(r?.tag || '');
    if (!ANSWER_TAG_RE.test(tag)) continue;
    const concept = String(r?.concept || '').slice(0, 400);
    const prefix = [
      '',
      '─── ALREADY IN MEMORY (answer-tagged) ─────────────────────',
      `The following is SETTLED in the memory graph:`,
      `  tag=${tag}`,
      `  ${concept}`,
      '',
      'Do NOT restate this conclusion. If this topic is the goal,',
      'either propose a NEW question the resolved finding does not',
      'answer, a concrete next step that advances the work, or tag',
      'NO_ACTION. Restating a known answer is redundant and will be',
      'treated as noise.',
      '───────────────────────────────────────────────────────────',
      ''
    ].join('\n');
    return {
      prefix,
      match: { id: r.id, similarity: score, tag, concept },
    };
  }
  return { prefix: null };
}

module.exports = {
  computeRoleDedupPrefix,
  buildQueryText,
  DEFAULT_THRESHOLD,
  ANSWER_TAG_RE,
};
