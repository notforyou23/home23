/**
 * Autoresearch skill — loop runs in AgentLoop via spawn_agent.
 * The skill's execute() just returns the loop prompt; spawn_agent runs it
 * with full tool access (skills_run, edit_file, etc.).
 */

export const actions = {
  autoresearch_loop: actionAutoresearchLoop,
};

export async function execute(action, params, context) {
  if (actions[action]) return actions[action](params, context);
  throw new Error(`Unknown autoresearch action: ${action}`);
}

/**
 * Returns the autoresearch loop prompt for spawn_agent.
 * The sub-agent runs the full loop in the AgentLoop with full tool access.
 */
async function actionAutoresearchLoop(params = {}, context = {}) {
  const {
    targetSkill,
    failureMode,
    promptSet = [],
    scoreRubric = {},
    maxRounds = 3,
  } = params;

  if (!targetSkill) throw new Error("targetSkill is required");
  if (!failureMode) throw new Error("failureMode is required");
  if (!promptSet || promptSet.length === 0) throw new Error("promptSet is required");

  const rubricLines = Object.entries(scoreRubric).map(([dim, cfg]) =>
    `  - ${dim}: target=${cfg?.target ?? "unset"}`
  ).join("\n");

  const prompt = `Run an autoresearch loop against the skill "${targetSkill}".

## Failure mode
${failureMode}

## Prompt set
${promptSet.map((p, i) => `  ${i + 1}. ${typeof p === "string" ? p : JSON.stringify(p)}`).join("\n")}

## Score rubric
${rubricLines || "(use default rubric)"}` + `

## Parameters
- maxRounds: ${maxRounds}
- targetSkill: ${targetSkill}

## Instructions
1. For each prompt in the prompt set, call: skills_run(skillId="${targetSkill}", action="search", input={query: "..."})
2. Score each result across 5 dimensions (1=borked, 3=functional, 5=excellent):
   - queryStrategy: detects zero/low results and auto-broadens or retries
   - qualityFiltering: filters spam, elevates high-engagement signal  
   - resultCoverage: gets meaningful result volume per query
   - actionContract: returns well-formed, predictable responses
   - documentation: SKILL.md examples and gotchas are clear
3. Average scores per round. Report per-prompt scores + round average.
4. If any dimension averages < 3 after a round, use edit_file to revise ${targetSkill}'s SKILL.md:
   - Find the weakest dimension
   - Apply a targeted fix (gotcha, example, workflow step, etc.)
   - Be specific — don't rewrite the whole file, just fix the weak spot
5. Stop when score gain between rounds is ≤ 0.2
6. Return a final JSON report with this structure:
{
  "targetSkill": "${targetSkill}",
  "failureMode": "...",
  "rounds": [
    {
      "round": 1,
      "avgScore": 3.2,
      "gain": null,
      "revisionSuggested": "...",
      "results": [
        { "prompt": "...", "total": 3.2, "resultCount": 5, "scores": {...} }
      ]
    }
  ],
  "dimensionAverages": { "queryStrategy": 2.8, ... },
  "summary": { "startScore": 2.1, "finalScore": 3.2, "totalGain": 1.1, "roundsRun": 3 },
  "recommendations": [...]
}

Return the report as clean JSON to this chat when done.`;

  return {
    scheduled: "via_spawn_agent",
    targetSkill,
    failureMode,
    promptCount: promptSet.length,
    maxRounds,
    loopPrompt: prompt,
    instructions: `To run the loop: spawn_agent with task="""${prompt}"""`,
  };
}
