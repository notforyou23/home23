---
id: autoresearch
name: Autoresearch
version: 2.0.0
layer: skill
runtime: nodejs
author: home23
description: Iteratively improve a weak skill through score, tweak, and retest loops. Run against a target skill, define failure mode and rubric, execute the loop, and get a scored report with recommendations.
category: meta
keywords:
  - skill
  - improve
  - autoresearch
  - optimize
  - iterate
  - quality
triggers:
  - improve this skill
  - autoresearch this skill
  - optimize the skill
  - why is this skill weak
capabilities:
  - autoresearch_loop: Run a full score/tweak/retest loop against a target skill
requiresTools:
  - skills_run
  - skills_list
  - skills_get
  - skills_audit
dependsOn:
  - skill-loader
composes:
  - knowledge-structuring
  - source-validation
---

# Autoresearch

Use this skill when a skill exists but performs inconsistently and needs deliberate improvement rather than one-off fixes.

## When to use

Use `autoresearch` for:
- a skill that triggers inconsistently across similar asks
- a skill whose instructions feel vague, brittle, or underspecified
- quality work where the target is the skill itself, not just the current answer

## Workflow

1. Define the failure mode clearly.
2. Choose a score rubric (5 dimensions, 1–5 each).
3. Run representative prompts against the skill across N rounds.
4. Auto-revise `SKILL.md` after each round (targets weakest dimension).
5. Stop when score gain flattens (≤ 0.2 improvement).
6. Return a scored report with per-round results and recommendations.

## Score Rubric (5 dimensions)

| Dimension | What it measures |
|---|---|
| `queryStrategy` | Detects zero/low results and auto-broadens or retries |
| `qualityFiltering` | Filters spam, elevates high-engagement signal |
| `resultCoverage` | Gets meaningful result volume per query |
| `actionContract` | Returns well-formed, predictable responses |
| `documentation` | SKILL.md examples and gotchas are clear and actionable |

Scores: 1 (broken) → 3 (functional) → 5 (excellent).

## autoresearch_loop action

```json
{
  "action": "autoresearch_loop",
  "input": {
    "targetSkill": "x-research",
    "failureMode": "X search returns spam for health queries with no retry logic",
    "promptSet": [
      "sauna cold plunge contrast therapy",
      "infrared sauna health benefits",
      "cold plunge recovery sleep"
    ],
    "scoreRubric": {
      "queryStrategy": { "target": 4 },
      "qualityFiltering": { "target": 3 },
      "resultCoverage": { "target": 3 },
      "actionContract": { "target": 4 },
      "documentation": { "target": 3 }
    },
    "maxRounds": 3
  }
}
```

## Output

Returns a JSON report with:
- `rounds[]`: per-round scores per prompt and dimension averages
- `summary`: start/final/total gain, rounds run, stopped-early flag
- `recommendations[]`: dimensions still scoring < 3 after loop

Report saved to `workspace/reports/autoresearch/autoresearch-{skill}-{timestamp}.json`.

## Gotchas

- Do not autoresearch every miss. Only use it when the pattern repeats.
- Keep the prompt set stable while you iterate or the score signal becomes noise.
- Fix routing text and gotchas before inventing more actions.
- Autoresearch runs inside the target skill's context — it does NOT need its own auth.
- Round scores start at ~2–3 for a broken skill and should climb with each revision.
