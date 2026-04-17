/**
 * force-output.js — back-pressure for the thinking ↔ shipping loop.
 *
 * Jerry's 2026-04-17 self-diagnosis: 2,780 agents, 4 test files, 0.14%
 * output rate. The system thinks forever and ships nothing. This module
 * creates a forcing function: when N cycles pass without a fresh file
 * in outputs/, inject ONE synthetic goal whose sole criterion is to
 * produce a digest of the current best memory material.
 *
 * The goal is deliberately *concrete* — it references specific memory
 * node ids + domain surfaces so the spawned agent doesn't hallucinate
 * a summary of nothing. This is where Jerry's "write about what?"
 * question gets its answer: the goal description itself carries the
 * material.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_EVERY_N_CYCLES = 100;
const DEFAULT_SURFACE_FILES = ['RECENT.md', 'PROJECTS.md'];
const ANSWER_TAG_RE = /answer|resolved|finding|conclusion|insight|verdict/i;

function countRecentOutputs(outputsDir, since) {
  if (!outputsDir || !fs.existsSync(outputsDir)) return 0;
  try {
    let n = 0;
    for (const name of fs.readdirSync(outputsDir)) {
      if (name.startsWith('.')) continue;
      const full = path.join(outputsDir, name);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isFile() && st.mtimeMs > since) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

function readSurface(workspaceDir, name, maxChars = 1200) {
  if (!workspaceDir) return null;
  const p = path.join(workspaceDir, name);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return raw.slice(0, maxChars);
  } catch {
    return null;
  }
}

function pickHighSignalNodes(memory, limit = 5) {
  if (!memory?.nodes?.values) return [];
  // Score candidates by (tag-match × activation). Activation is the best
  // proxy for "recently relevant" on this engine.
  const picks = [];
  for (const node of memory.nodes.values()) {
    if (!node) continue;
    const tag = String(node.tag || '');
    const tagScore = ANSWER_TAG_RE.test(tag) ? 1 : 0;
    const act = Number(node.activation || 0);
    const score = tagScore * 1.0 + act * 0.5;
    if (score <= 0) continue;
    picks.push({ id: node.id, tag, concept: String(node.concept || '').slice(0, 240), score });
  }
  picks.sort((a, b) => b.score - a.score);
  return picks.slice(0, limit);
}

function buildDigestGoal({ cycle, nodes, surfaces }) {
  const refs = nodes.map(n => `  - [#${n.id} tag=${n.tag}] ${n.concept}`).join('\n');
  const surfaceLines = Object.entries(surfaces || {})
    .filter(([, v]) => typeof v === 'string' && v.length)
    .map(([k, v]) => `${k}:\n${String(v).slice(0, 400)}`)
    .join('\n\n');

  const filename = `digest-${cycle}.md`;
  const description =
    `Produce outputs/${filename}. Synthesize these findings from recent memory:\n${refs}\n\n` +
    (surfaceLines ? `Current context:\n${surfaceLines}\n\n` : '') +
    `Write 400-800 words. Tie each finding to its originating thought (reference by cycle) and any sensor data. ` +
    `Include a "what we don't know yet" section naming at least one open question.`;

  return {
    description,
    reason: `force-output back-pressure at cycle ${cycle}`,
    uncertainty: 0.4,
    source: { origin: 'force-output', label: 'force-output' },
    doneWhen: {
      version: 1,
      criteria: [
        { type: 'file_exists', path: filename },
        {
          type: 'judged',
          criterion:
            `The file outputs/${filename} exists and synthesizes at least 3 of the referenced memory findings, ` +
            `each tied to a source cycle or sensor reading, with a "what we don't know yet" section.`,
          judgeModel: 'gpt-5-mini',
          judgedAt: null,
          judgedVerdict: null,
        }
      ]
    }
  };
}

/**
 * Stateful check — keeps its own tracking state in the returned object,
 * so the orchestrator passes the same `state` back each call.
 *
 * @param {object} opts
 *   { outputsDir, workspaceDir, memory, goals, cycle, state, config, logger }
 * @returns {Promise<{
 *   triggered: boolean, skipped?: boolean, reason?: string, goalId?: string,
 *   state: { lastOutputCycle, lastOutputCheckTime, nextEligibleCycle }
 * }>}
 */
async function checkAndMaybeTrigger(opts) {
  const {
    outputsDir, workspaceDir, memory, goals, cycle, state = {}, config = {}, logger,
  } = opts;

  if (process.env.HOME23_FORCE_OUTPUT_DISABLE === '1' || config.enabled === false) {
    return { triggered: false, reason: 'disabled', state };
  }

  const everyN = Number(config.everyNCycles) || DEFAULT_EVERY_N_CYCLES;
  const now = Date.now();
  const lastOutputCheckTime = Number(state.lastOutputCheckTime) || 0;
  const lastOutputCycle = Number(state.lastOutputCycle) || 0;

  // Count files produced since the last check — any fresh file resets.
  const fresh = countRecentOutputs(outputsDir, lastOutputCheckTime || (now - 60 * 60 * 1000));
  if (fresh > 0) {
    logger?.debug?.('[force-output] fresh output detected, resetting counter', { fresh });
    return {
      triggered: false, reason: 'fresh-output',
      state: { lastOutputCycle: cycle, lastOutputCheckTime: now }
    };
  }

  // Not yet at the threshold.
  if (cycle - lastOutputCycle < everyN) {
    return { triggered: false, reason: 'under-threshold',
      state: { lastOutputCycle, lastOutputCheckTime: now } };
  }

  // Pull material. If no high-signal nodes, don't fire — just skip.
  const nodes = pickHighSignalNodes(memory, 5);
  if (nodes.length < 2) {
    logger?.info?.('[force-output] no high-signal nodes — skipping this cycle', { cycle });
    return {
      triggered: false, skipped: true, reason: 'no material',
      state: { lastOutputCycle: cycle - Math.floor(everyN / 4), lastOutputCheckTime: now }
    };
  }

  // Build concrete goal with material embedded.
  const surfaceFiles = config.surfaceFiles || DEFAULT_SURFACE_FILES;
  const surfaces = {};
  for (const name of surfaceFiles) {
    const v = readSurface(workspaceDir, name);
    if (v) surfaces[name] = v;
  }
  const goalData = buildDigestGoal({ cycle, nodes, surfaces });

  // Add the goal through the normal gate. Back-pressure source is honest
  // about its origin; if the gate rejects for any reason, we log and retry
  // at the next cycle.
  if (!goals || typeof goals.addGoal !== 'function') {
    return { triggered: false, reason: 'no goals system', state };
  }
  const goal = goals.addGoal(goalData);
  if (!goal) {
    logger?.warn?.('[force-output] gate rejected back-pressure goal', { cycle });
    return { triggered: false, reason: 'gate-rejected', state };
  }
  logger?.info?.('[force-output] back-pressure goal created', {
    cycle, goalId: goal.id, nodeCount: nodes.length
  });
  return {
    triggered: true, goalId: goal.id,
    state: { lastOutputCycle: cycle, lastOutputCheckTime: now }
  };
}

module.exports = {
  checkAndMaybeTrigger,
  buildDigestGoal,
  pickHighSignalNodes,
  countRecentOutputs,
  readSurface,
  DEFAULT_EVERY_N_CYCLES,
};
