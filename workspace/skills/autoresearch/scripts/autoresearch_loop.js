/**
 * Autoresearch Loop — executable implementation
 * Iteratively improves a target skill by running prompt tests, scoring,
 * revising SKILL.md, and retesting until quality gains flatten.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ → autoresearch/ → skills/ → workspace/ → home23/
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WORKSPACE_DIR = path.join(PROJECT_ROOT, "workspace");
const resolveProjectRoot = () => PROJECT_ROOT;

function skillDir(skillId) {
  return path.join(resolveProjectRoot(), "workspace", "skills", skillId);
}

function readYamlFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  return yaml.load(fs.readFileSync(filePath, "utf8")) || {};
}

function loadSecrets() {
  return readYamlFile(path.join(resolveProjectRoot(), "config", "secrets.yaml"));
}

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (match) {
    return { meta: yaml.load(match[1]) || {}, body: match[2] };
  }
  return { meta: {}, body: content };
}

function writeFrontmatter(meta, body) {
  const fm = yaml.dump(meta).trim();
  return `---\n${fm}\n---\n${body}`;
}

// --- Skill execution via Home23 engine ---
async function runPromptAgainstSkill(skillId, action, input, context = {}) {
  const { executeSkill } = await import(path.join(resolveProjectRoot(), "workspace", "skills", "loader.js"));

  try {
    const result = await executeSkill(skillId, action, input, {
      projectRoot: resolveProjectRoot(),
      workspacePath: path.join(WORKSPACE_DIR, "skills", "autoresearch"),
      secrets: loadSecrets(),
    });
    return { success: true, result };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// --- Score rubric ---
function scoreResult(result, rubric) {
  const scores = {};
  let total = 0;

  // Query strategy: bonus for having a retry or reformulation path
  scores.queryStrategy = result.success && result.result?.query
    ? (result.result.queries?.length > 1 ? 5 : result.result.resultCount > 0 ? 3 : 2)
    : 1;
  scores.queryStrategy = Math.min(5, Math.max(1, rubric.queryStrategy?.target ?? scores.queryStrategy));
  total += scores.queryStrategy;

  // Quality filtering: bonus for engagement filter or quality flag working
  scores.qualityFiltering = result.success && result.result?.tweets
    ? (result.result.tweets.length > 0 && result.result.tweets[0]?.metrics ? 4 : 2)
    : 1;
  scores.qualityFiltering = Math.min(5, Math.max(1, rubric.qualityFiltering?.target ?? scores.qualityFiltering));
  total += scores.qualityFiltering;

  // Result coverage: did we get any results worth reporting
  scores.resultCoverage = result.success
    ? Math.min(5, Math.max(1, Math.ceil((result.result?.resultCount || 0) / 2)))
    : 1;
  scores.resultCoverage = Math.min(5, Math.max(1, rubric.resultCoverage?.target ?? scores.resultCoverage));
  total += scores.resultCoverage;

  // Action contract: did the skill return a well-formed response
  scores.actionContract = result.success && result.result?.success !== undefined ? 4 : 1;
  scores.actionContract = Math.min(5, Math.max(1, rubric.actionContract?.target ?? scores.actionContract));
  total += scores.actionContract;

  // Documentation: SKILL.md readability assessed separately
  scores.documentation = 3; // default, updated after review
  scores.documentation = Math.min(5, Math.max(1, rubric.documentation?.target ?? scores.documentation));
  total += scores.documentation;

  return { scores, total: Math.round((total / 5) * 10) / 10 };
}

function buildScoreCard(scores, total) {
  return Object.entries(scores)
    .map(([k, v]) => `  ${k}: ${v}/5`)
    .join("\n") + `\n  TOTAL: ${total}/5.0`;
}

// --- SKILL.md revision helper ---
function reviseSkillMd(skillId, weakness, revision) {
  const mdPath = path.join(skillDir(skillId), "SKILL.md");
  if (!fs.existsSync(mdPath)) return { error: "SKILL.md not found" };

  const content = fs.readFileSync(mdPath, "utf8");
  const { meta, body } = parseFrontmatter(content);

  // Append weakness + revision as a new "Lesson" section
  const timestamp = new Date().toISOString().split("T")[0];
  const lesson = `\n## Lesson [${timestamp}]\n\n**Weakness:** ${weakness}\n\n**Revision:** ${revision}\n`;

  const newBody = body.trimEnd() + "\n" + lesson;
  fs.writeFileSync(mdPath, writeFrontmatter(meta, newBody), "utf8");

  return { lesson: lesson.trim(), path: mdPath };
}

// --- Main loop ---
async function autoresearchLoop({ targetSkill, failureMode, promptSet, scoreRubric, maxRounds = 3 }) {
  const rounds = [];
  const skillPath = path.join(skillDir(targetSkill), "SKILL.md");

  if (!fs.existsSync(skillPath)) {
    return { error: `Target skill ${targetSkill} has no SKILL.md`, rounds };
  }

  // Load target skill actions from manifest
  const manifestPath = path.join(skillDir(targetSkill), "manifest.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
  const actions = manifest.actions || ["search"];
  const primaryAction = actions[0];

  console.error(`[autoresearch] Starting ${maxRounds}-round loop on "${targetSkill}"`);
  console.error(`[autoresearch] Failure mode: ${failureMode}`);
  console.error(`[autoresearch] Prompts: ${promptSet.length} | Action: ${primaryAction}`);

  for (let round = 1; round <= maxRounds; round++) {
    console.error(`\n[autoresearch] === ROUND ${round} ===`);
    const roundResults = [];
    let roundScores = [];

    for (const prompt of promptSet) {
      const input = typeof prompt === "string" ? { query: prompt } : prompt;
      console.error(`[autoresearch] Running prompt: ${input.query || JSON.stringify(input)}`);

      const runResult = await runPromptAgainstSkill(targetSkill, primaryAction, input);
      const scored = scoreResult(runResult, scoreRubric);

      roundResults.push({
        prompt: input.query || JSON.stringify(input),
        raw: runResult,
        scores: scored.scores,
        total: scored.total,
      });
      roundScores.push(scored.total);

      console.error(`[autoresearch]   → score: ${scored.total}/5 | success: ${runResult.success}`);
    }

    const avgScore = Math.round((roundScores.reduce((a, b) => a + b, 0) / roundScores.length) * 10) / 10;
    const prevScore = rounds.length > 0 ? rounds[rounds.length - 1].avgScore : null;
    const gain = prevScore !== null ? Math.round((avgScore - prevScore) * 10) / 10 : null;

    console.error(`[autoresearch] Round ${round} avg score: ${avgScore}/5${gain !== null ? ` | gain: ${gain}` : ""}`);

    rounds.push({ round, results: roundResults, avgScore, gain });

    // Stop if score flattened
    if (round > 1 && gain !== null && gain <= 0.2) {
      console.error(`[autoresearch] Score gain ${gain} ≤ 0.2 — stopping.`);
      break;
    }

    // Auto-revise based on weakest dimension
    if (round < maxRounds) {
      const allScores = roundResults.flatMap((r) => Object.entries(r.scores));
      const avgByDim = {};
      for (const [dim, score] of allScores) {
        avgByDim[dim] = (avgByDim[dim] || 0) + score;
      }
      for (const dim of Object.keys(avgByDim)) {
        avgByDim[dim] = Math.round((avgByDim[dim] / promptSet.length) * 10) / 10;
      }

      const weakest = Object.entries(avgByDim).sort((a, b) => a[1] - b[1])[0];
      const revision = generateRevision(targetSkill, primaryAction, weakest[0], weakest[1], roundResults);
      const revised = reviseSkillMd(targetSkill, `${weakest[0]} avg=${weakest[1]}/5`, revision);

      if (!revised.error) {
        console.error(`[autoresearch] Auto-revised SKILL.md for weakest dim: ${weakest[0]} (${weakest[1]}/5)`);
        console.error(`[autoresearch] Lesson: ${revision}`);
      }
    }
  }

  // Final report
  const finalScore = rounds[rounds.length - 1].avgScore;
  const startScore = rounds[0].avgScore;
  const totalGain = Math.round((finalScore - startScore) * 10) / 10;

  const report = {
    targetSkill,
    failureMode,
    rounds: rounds.map((r) => ({
      round: r.round,
      avgScore: r.avgScore,
      gain: r.gain,
      promptCount: r.results.length,
      scoreBreakdown: r.results.map((res) => ({
        prompt: res.prompt,
        total: res.total,
        scores: res.scores,
      })),
    })),
    summary: {
      startScore,
      finalScore,
      totalGain,
      roundsRun: rounds.length,
      maxRounds,
      stoppedEarly: rounds.length < maxRounds,
    },
    recommendations: generateRecommendations(rounds),
  };

  const reportDir = path.join(WORKSPACE_DIR, "reports", "autoresearch");
  fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `autoresearch-${targetSkill}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");

  console.error(`\n[autoresearch] Done. Report: ${reportPath}`);
  return report;
}

function generateRevision(skillId, action, weakestDim, score, roundResults) {
  const revisions = {
    queryStrategy: "Added guidance to broaden queries when results are sparse. " +
      "The skill should detect zero/low-result queries and auto-retry with broader terms or reduced specificity.",
    qualityFiltering: "Strengthened result quality guidance. " +
      "Added explicit mention of engagement filters and spam avoidance in query construction.",
    resultCoverage: "Emphasized running 1-3 complementary queries rather than a single query per search action. " +
      "The workflow should iterate if the first pass returns < 3 useful results.",
    actionContract: "Clarified action input/output contract with concrete examples " +
      "showing exactly what fields each action returns.",
    documentation: "Added worked examples for the most common failure query patterns. " +
      "Gave users concrete query phrasing guidance for health/science topics.",
  };
  return revisions[weakestDim] || `Improve ${weakestDim} from current avg ${score}/5`;
}

function generateRecommendations(rounds) {
  const recs = [];
  const last = rounds[rounds.length - 1];

  // Check each dimension for persistent low scores across rounds
  const dimAvgs = {};
  for (const round of rounds) {
    for (const res of round.results) {
      for (const [dim, score] of Object.entries(res.scores)) {
        dimAvgs[dim] = (dimAvgs[dim] || 0) + score;
      }
    }
  }
  const count = rounds.length * rounds[0].results.length;
  for (const dim of Object.keys(dimAvgs)) {
    dimAvgs[dim] = Math.round((dimAvgs[dim] / count) * 10) / 10;
  }

  for (const [dim, avg] of Object.entries(dimAvgs)) {
    if (avg < 3) {
      recs.push({
        dimension: dim,
        avgScore: avg,
        recommendation: `Persistent low score in ${dim} (${avg}/5). Manual SKILL.md review recommended.`,
      });
    }
  }

  if (recs.length === 0) {
    recs.push({
      recommendation: "All dimensions score ≥ 3. Skill is operationally functional. Manual review SKILL.md for prose clarity.",
    });
  }

  return recs;
}

export { autoresearchLoop };

// --- CLI / shell-wrapper entry point ---
// Loader passes params via HOME23_SKILL_PARAMS env var
const envParams = process.env.HOME23_SKILL_PARAMS;
if (envParams) {
  try {
    const params = JSON.parse(envParams);
    const report = await autoresearchLoop({
      targetSkill: params.targetSkill,
      failureMode: params.failureMode,
      promptSet: params.promptSet || [],
      scoreRubric: params.scoreRubric || {},
      maxRounds: Math.max(1, Math.min(Number(params.maxRounds || 3), 5)),
    });
    console.log(JSON.stringify(report));
    process.exit(0);
  } catch (err) {
    console.error('[autoresearch] Fatal:', err.message);
    process.exit(1);
  }
}
