/**
 * deliverable-paths.js
 *
 * Shared helpers for exact-path deliverable contracts and goal-theatre prevention.
 *
 * Root failures this targets:
 * 1) Exact-path contract mismatch
 *    - Goals demand outputs/recovery_report.json (etc.)
 *    - document_creation missions ship without mission.deliverable
 *    - saveDocument falls back to outputs/document-creation/{agentId}/...
 *    - doneWhen checks look for the top-level path and fail
 *    - meta-coordinator invents more write_path/exec-stub goals
 *
 * 2) Spec / goal-about-goal theatre
 *    - Goals whose only work is "paste insight X into goal_Y's recovery_gate"
 *    - recovery_gate / fsync / "write pipeline is dead" paper-pushing
 *    - Swarm of judged goals with no external artifact
 */

const path = require('path');
const fs = require('fs');

const FILE_PATH_RE =
  /\b(?:@?outputs\/|runtime\/outputs\/)?([A-Za-z0-9._/-]+\.(?:json|md|txt|html|csv|yaml|yml))\b/gi;

// Classic write-path / recovery artifact swarm
const WRITE_PATH_THEME_RE =
  /write[_\s-]?path|recovery_report|recovery_status|recovery_state|exec stub|child_process\.exec|filesystem write|persist(?:ed|ence)? to (?:disk|outputs)|mocked exec|real filesystem write/i;

// Broader write-myth / recovery-gate / hollow-output theatre (Forrest form)
const WRITE_MYTH_THEME_RE =
  /recovery_gate|write pipeline is dead|zero deliverables|success-reports-with-zero-files|phantom[- ]success|fsync wrapper|direct filesystem proof|ls -la \+ byte-count|write claims must be backed|unfreeze gate|zero-entry responses|outputs\/0 files|0 files metric/i;

// Goal whose primary work is editing/annotating other goals (no external artifact)
const GOAL_ABOUT_GOAL_RE =
  /(?:^|\b)(?:paste|insert|lift|extract|embed|cite|codify|integrate|translate|draft|add|update|append).{0,80}\bgoal_\d+\b|\bgoal_\d+\b.{0,40}(?:recovery_gate|acceptance criteria|cancellation set|preamble|spec section|protocol specification|blast_radius|unfreeze)|\bcross-reference (?:from |into )?goal_\d+\b|\binto goal_\d+\b.{0,40}(?:verbatim|spec|clause|gate)/i;

const SPEC_THEATRE_RE =
  /recovery_gate|spec draft|verbatim (?:phrase|text|clause|acceptance)|acceptance criteria|cancellation set|blast_radius|unfreeze gate|protocol specification/i;

/**
 * Normalize a path so it is relative to outputsDir.
 * "outputs/recovery_report.json" → "recovery_report.json"
 * "@outputs/foo.md" → "foo.md"
 * absolute .../outputs/foo.md → "foo.md"
 */
function normalizeOutputsRelativePath(input) {
  if (!input || typeof input !== 'string') return null;

  let p = input.trim().replace(/\\/g, '/');
  if (!p) return null;

  // Absolute or long relative paths that contain /outputs/
  const outputsIdx = p.lastIndexOf('/outputs/');
  if (outputsIdx !== -1) {
    p = p.slice(outputsIdx + '/outputs/'.length);
  }

  const prefixes = [
    'runtime/outputs/',
    '@outputs/',
    'outputs/',
    './outputs/',
  ];
  for (const prefix of prefixes) {
    if (p.startsWith(prefix)) {
      p = p.slice(prefix.length);
      break;
    }
  }

  if (p.startsWith('./')) p = p.slice(2);
  if (!p || p.includes('..') || path.isAbsolute(p)) return null;

  return p;
}

function extractPathsFromText(text) {
  if (!text) return [];
  const found = [];
  const s = String(text);
  for (const match of s.matchAll(FILE_PATH_RE)) {
    const raw = match[0];
    const norm = normalizeOutputsRelativePath(raw);
    if (norm) found.push(norm);
  }
  return [...new Set(found)];
}

/**
 * Collect concrete file deliverables from a goal's doneWhen + description.
 */
function extractFileDeliverablesFromGoal(goal = {}) {
  const paths = new Set();

  const criteria = Array.isArray(goal?.doneWhen?.criteria)
    ? goal.doneWhen.criteria
    : [];
  for (const criterion of criteria) {
    if (!criterion || criterion.type !== 'file_exists') continue;
    const norm = normalizeOutputsRelativePath(criterion.path || criterion.file || '');
    if (norm) paths.add(norm);
  }

  for (const field of [goal.description, goal.reason, goal?.metadata?.claimText]) {
    for (const p of extractPathsFromText(field)) paths.add(p);
  }

  return [...paths];
}

function formatFromFilename(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  switch (ext) {
    case '.json':
      return 'json';
    case '.html':
      return 'html';
    case '.md':
      return 'markdown';
    case '.csv':
      return 'csv';
    case '.yaml':
    case '.yml':
      return 'yaml';
    case '.txt':
      return 'txt';
    default:
      return 'markdown';
  }
}

/**
 * Build a PathResolver-compatible deliverableSpec for a top-level outputs file.
 */
function buildDeliverableSpecFromPath(relPath) {
  const filename = normalizeOutputsRelativePath(relPath);
  if (!filename) return null;

  const format = formatFromFilename(filename);
  return {
    location: '@outputs/',
    filename,
    type: format === 'json' ? 'json' : 'report',
    format,
    accessibility: 'mcp-required',
  };
}

function isWritePathRecoveryTheme(text) {
  const s = String(text || '');
  return WRITE_PATH_THEME_RE.test(s) || WRITE_MYTH_THEME_RE.test(s);
}

function isGoalAboutGoalTheme(text) {
  const s = String(text || '');
  if (!s) return false;
  if (GOAL_ABOUT_GOAL_RE.test(s)) return true;
  // Multiple goal_ references + spec language = goal theatre
  const goalRefs = s.match(/\bgoal_\d+\b/gi) || [];
  if (goalRefs.length >= 2 && SPEC_THEATRE_RE.test(s)) return true;
  if (goalRefs.length >= 1 && /verbatim|paste|recovery_gate|fsync/i.test(s)) return true;
  return false;
}

/**
 * Any goal theatre we should collapse: write-path myth OR goal-about-goal paper-pushing.
 */
function isGoalTheatreTheme(text) {
  return isWritePathRecoveryTheme(text) || isGoalAboutGoalTheme(text);
}

/**
 * Prefer one canonical goal in a theatre swarm; archive the rest.
 */
function collapseWritePathSwarm(activeGoals, { maxKeep = 1, maxCluster = 3 } = {}) {
  const cluster = (activeGoals || []).filter(
    (g) => g && (g.status === 'active' || !g.status) && isGoalTheatreTheme(g.description)
  );

  if (cluster.length < maxCluster) {
    return { cluster, keep: cluster, archive: [] };
  }

  const sorted = [...cluster].sort((a, b) => {
    const pr = (Number(b.priority) || 0) - (Number(a.priority) || 0);
    if (pr !== 0) return pr;
    // Prefer goals with machine-checkable file deliverables
    const aFiles = extractFileDeliverablesFromGoal(a).length;
    const bFiles = extractFileDeliverablesFromGoal(b).length;
    if (bFiles !== aFiles) return bFiles - aFiles;
    // Prefer non-goal-about-goal when possible
    const aGag = isGoalAboutGoalTheme(a.description) ? 1 : 0;
    const bGag = isGoalAboutGoalTheme(b.description) ? 1 : 0;
    if (aGag !== bGag) return aGag - bGag;
    return (Number(a.created) || 0) - (Number(b.created) || 0);
  });

  return {
    cluster,
    keep: sorted.slice(0, maxKeep),
    archive: sorted.slice(maxKeep),
  };
}

/**
 * If recovery artifacts already exist under outputsDir, the classic write-path
 * swarm is solved as a contract issue, not an open write-path bug.
 */
function recoveryArtifactsPresent(outputsDir) {
  if (!outputsDir) return false;
  try {
    return (
      fs.existsSync(path.join(outputsDir, 'recovery_report.json')) &&
      fs.existsSync(path.join(outputsDir, 'recovery_status.json'))
    );
  } catch {
    return false;
  }
}

/**
 * Archive/collapse write-path + spec-theatre goals.
 * Returns counts for logging.
 */
function pruneWritePathRecoverySwarm(goalsSystem, outputsDir, options = {}) {
  if (!goalsSystem || typeof goalsSystem.archiveGoal !== 'function') {
    return { archived: 0, kept: 0, reason: 'no_goals_system' };
  }

  const getGoals =
    typeof goalsSystem.getGoals === 'function'
      ? () => goalsSystem.getGoals()
      : () => Array.from(goalsSystem.goals?.values?.() || []);

  const active = (getGoals() || []).filter(
    (g) => g && (g.status === 'active' || !g.status)
  );
  const cluster = active.filter((g) => isGoalTheatreTheme(g.description));
  if (cluster.length === 0) {
    return { archived: 0, kept: 0, reason: 'no_cluster' };
  }

  let archived = 0;
  let kept = 0;

  // Pure goal-about-goal swarm with no external file deliverable: archive all.
  const pureGoalTheatre = cluster.filter(
    (g) =>
      isGoalAboutGoalTheme(g.description) &&
      extractFileDeliverablesFromGoal(g).length === 0
  );
  if (pureGoalTheatre.length >= (options.maxGoalAboutGoal ?? 2)) {
    for (const goal of pureGoalTheatre) {
      if (
        goalsSystem.archiveGoal(
          goal.id,
          options.goalAboutGoalReason ||
            'goal-about-goal / recovery_gate spec theatre: no external artifact; archive'
        )
      ) {
        archived += 1;
      }
    }
  }

  // Refresh cluster after pure goal-theatre purge
  const remainingActive = (getGoals() || []).filter(
    (g) => g && (g.status === 'active' || !g.status) && isGoalTheatreTheme(g.description)
  );

  if (recoveryArtifactsPresent(outputsDir)) {
    const writeCluster = remainingActive.filter((g) => isWritePathRecoveryTheme(g.description));
    for (const goal of writeCluster) {
      if (
        goalsSystem.archiveGoal(
          goal.id,
          options.resolvedReason ||
            'write-path-recovery artifacts present; deliverable-contract swarm closed'
        )
      ) {
        archived += 1;
      }
    }
    if (writeCluster.length > 0) {
      return {
        archived,
        kept: 0,
        reason: 'artifacts_present',
        clusterSize: cluster.length,
      };
    }
  }

  const collapsed = collapseWritePathSwarm(remainingActive, {
    maxKeep: options.maxKeep ?? 1,
    maxCluster: options.maxCluster ?? 3,
  });

  for (const goal of collapsed.archive) {
    if (
      goalsSystem.archiveGoal(
        goal.id,
        options.swarmReason ||
          'goal-theatre anti-swarm: keep one canonical goal'
      )
    ) {
      archived += 1;
    }
  }
  kept = collapsed.keep.length;

  return {
    archived,
    kept,
    reason: archived > 0 ? 'collapsed_swarm' : 'below_threshold',
    clusterSize: cluster.length,
    keepIds: collapsed.keep.map((g) => g.id),
  };
}

/**
 * Should this goal description be rejected at spawn time?
 * Blocks pure goal-about-goal paper-pushing unless it names a real file deliverable
 * or is explicitly allowed via metadata.
 */
function shouldRejectGoalAboutGoal(goalData = {}) {
  if (goalData?.metadata?.allowGoalAboutGoal === true) return false;
  const desc = goalData.description || '';
  if (!isGoalAboutGoalTheme(desc)) return false;
  // Allow if it also names a concrete external file deliverable
  const files = extractFileDeliverablesFromGoal({
    description: desc,
    doneWhen: goalData.doneWhen,
    reason: goalData.reason,
    metadata: goalData.metadata,
  });
  return files.length === 0;
}

/**
 * If content is destined for a .json file but wrapped in markdown/prose,
 * extract the JSON body when possible.
 */
function coerceJsonFileContent(content, filename) {
  if (!filename || !String(filename).toLowerCase().endsWith('.json')) {
    return content;
  }
  if (typeof content !== 'string') return content;

  const trimmed = content.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return content;
  }

  const fence = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const body = fence[1].trim();
    if (body.startsWith('{') || body.startsWith('[')) {
      try {
        JSON.parse(body);
        return body;
      } catch {
        // keep looking
      }
    }
  }

  const startObj = content.indexOf('{');
  const endObj = content.lastIndexOf('}');
  if (startObj !== -1 && endObj > startObj) {
    const candidate = content.slice(startObj, endObj + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // fall through
    }
  }

  const startArr = content.indexOf('[');
  const endArr = content.lastIndexOf(']');
  if (startArr !== -1 && endArr > startArr) {
    const candidate = content.slice(startArr, endArr + 1);
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // fall through
    }
  }

  return content;
}

/**
 * Prefer brain/outputs (or config outputsDir) over runtime/outputs for agent
 * default write roots.
 */
function resolveAgentOutputsRoot(config = {}, agentTypeFolder = 'misc') {
  if (config.outputsDir) {
    return path.join(config.outputsDir, agentTypeFolder);
  }
  if (config.brainPath) {
    return path.join(config.brainPath, 'outputs', agentTypeFolder);
  }
  if (config.logsDir) {
    // logsDir is often brain root in Home23
    const candidate = path.join(config.logsDir, 'outputs', agentTypeFolder);
    return candidate;
  }
  return path.join(process.cwd(), 'runtime', 'outputs', agentTypeFolder);
}

/**
 * Upgrade judged-only doneWhen blocks when the goal text already names concrete
 * output files. Machine file_exists should lead; judged can stay as secondary.
 *
 * This closes the "500 judged / 1 file_exists" failure mode where goals name
 * recovery_report.json (etc.) but only carry a vague judged restatement.
 */
function enrichDoneWhenWithFileExists(goalData = {}) {
  if (!goalData || typeof goalData !== 'object') return goalData;
  const dw = goalData.doneWhen;
  if (!dw || !Array.isArray(dw.criteria) || dw.criteria.length === 0) {
    return goalData;
  }

  const hasMachineFile = dw.criteria.some(
    (c) =>
      c &&
      (c.type === 'file_exists' ||
        c.type === 'file_created_after' ||
        c.type === 'output_count_since')
  );
  if (hasMachineFile) return goalData;

  const paths = new Set(
    extractFileDeliverablesFromGoal({
      description: goalData.description,
      reason: goalData.reason,
      metadata: goalData.metadata,
    })
  );
  for (const c of dw.criteria) {
    if (c?.type === 'judged' && c.criterion) {
      for (const p of extractPathsFromText(c.criterion)) paths.add(p);
    }
  }

  if (paths.size === 0) return goalData;

  const fileCriteria = [...paths].slice(0, 3).map((p) => ({
    type: 'file_exists',
    path: p.startsWith('outputs/') ? p : `outputs/${p}`,
  }));

  return {
    ...goalData,
    doneWhen: {
      ...dw,
      version: dw.version || 1,
      mode: dw.mode || 'all',
      criteria: [...fileCriteria, ...dw.criteria],
    },
    _doneWhenEnrichedWithFileExists: true,
  };
}

module.exports = {
  normalizeOutputsRelativePath,
  extractPathsFromText,
  extractFileDeliverablesFromGoal,
  buildDeliverableSpecFromPath,
  formatFromFilename,
  isWritePathRecoveryTheme,
  isGoalAboutGoalTheme,
  isGoalTheatreTheme,
  shouldRejectGoalAboutGoal,
  collapseWritePathSwarm,
  recoveryArtifactsPresent,
  pruneWritePathRecoverySwarm,
  coerceJsonFileContent,
  resolveAgentOutputsRoot,
  enrichDoneWhenWithFileExists,
  WRITE_PATH_THEME_RE,
  WRITE_MYTH_THEME_RE,
  GOAL_ABOUT_GOAL_RE,
};
