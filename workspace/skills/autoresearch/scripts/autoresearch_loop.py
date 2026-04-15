#!/usr/bin/env python3
"""
Autoresearch loop — Python implementation
Handles the full score/tweak/retest loop for improving target skills.
Receives params via HOME23_SKILL_PARAMS env var, returns JSON to stdout.
"""

import json
import os
import sys
import subprocess
from pathlib import Path

# Project root is 4 levels up from this script's dir
SCRIPT_DIR = Path(__file__).parent.resolve()
PROJECT_ROOT = SCRIPT_DIR.parent.parent.parent.parent
WORKSPACE = PROJECT_ROOT / "workspace"
REPORTS_DIR = WORKSPACE / "reports" / "autoresearch"

# Skill to test our execution chain
TARGET_SKILL = None
FAILURE_MODE = ""
PROMPT_SET = []
SCORE_RUBRIC = {}
MAX_ROUNDS = 3

def load_params():
    global TARGET_SKILL, FAILURE_MODE, PROMPT_SET, SCORE_RUBRIC, MAX_ROUNDS
    raw = os.environ.get("HOME23_SKILL_PARAMS", "{}")
    params = json.loads(raw)
    TARGET_SKILL = params.get("targetSkill", "")
    FAILURE_MODE = params.get("failureMode", "")
    PROMPT_SET = params.get("promptSet", [])
    SCORE_RUBRIC = params.get("scoreRubric", {})
    MAX_ROUNDS = max(1, min(int(params.get("maxRounds", 3)), 5))

def run_skill(skill_id, action, input_params):
    """Run a skill action via the CLI runner"""
    skill_dir = WORKSPACE / "skills" / skill_id
    skill_index = skill_dir / "index.js"
    if not skill_index.exists():
        return {"success": False, "error": f"No index.js for skill {skill_id}"}

    # Use node to run the workspace skills CLI
    cmd = [
        "node",
        str(WORKSPACE / "skills" / "index.js"),
        "run",
        skill_id,
        action,
        json.dumps(input_params)
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=60,
            cwd=str(PROJECT_ROOT)
        )
        # Parse the output - might be JSON or might be mixed with debug lines
        output = result.stdout.strip()
        if result.returncode != 0:
            return {"success": False, "error": result.stderr.strip() or f"Exit {result.returncode}"}
        
        # Try to extract JSON from the output (skip debug lines)
        for line in output.split("\n"):
            line = line.strip()
            if line.startswith("{") or line.startswith("["):
                return json.loads(line)
        return {"success": False, "error": "No parseable output", "raw": output[:200]}
    except subprocess.TimeoutExpired:
        return {"success": False, "error": "Timeout"}
    except Exception as e:
        return {"success": False, "error": str(e)}

def score_result(result, rubric):
    """Score a result across 5 dimensions (1-5 scale)"""
    scores = {}

    # Query strategy
    if result.get("success") and result.get("query"):
        queries = result.get("queries", [])
        result_count = result.get("resultCount", 0)
        scores["queryStrategy"] = 5 if len(queries) > 1 else (3 if result_count > 0 else 2)
    else:
        scores["queryStrategy"] = 1

    # Quality filtering
    tweets = result.get("tweets", [])
    if tweets and len(tweets) > 0:
        first = tweets[0]
        metrics = first.get("metrics", {})
        scores["qualityFiltering"] = 4 if metrics.get("likes", 0) > 0 else 2
    else:
        scores["qualityFiltering"] = 1

    # Result coverage
    rc = result.get("resultCount", 0)
    scores["resultCoverage"] = min(5, max(1, rc // 2 if rc < 10 else 4))

    # Action contract
    scores["actionContract"] = 4 if result.get("success") is not None else 1

    # Documentation - fixed score since we can't evaluate the doc from here
    scores["documentation"] = 3

    # Apply rubric targets
    for dim, target in rubric.items():
        if isinstance(target, dict) and "target" in target:
            pass  # Keep current score, target is for comparison

    total = round(sum(scores.values()) / len(scores), 1)
    return {"scores": scores, "total": total}

def update_skill_md(skill_id, weakness, revision):
    """Append a lesson to the target skill's SKILL.md"""
    skill_md = WORKSPACE / "skills" / skill_id / "SKILL.md"
    if not skill_md.exists():
        return False
    import yaml  # only import if needed
    content = skill_md.read_text()
    timestamp = __import__("datetime").date.today().isoformat()
    lesson = f"\n## Lesson [{timestamp}]\n\n**Weakness:** {weakness}\n\n**Revision:** {revision}\n"
    if "---" in content:
        parts = content.split("---", 2)
        fm = parts[1]
        body = parts[2] if len(parts) > 2 else ""
        new_content = f"---\n{fm}\n---\n{body.rstrip()}\n{lesson}"
    else:
        new_content = content.rstrip() + "\n" + lesson
    skill_md.write_text(new_content)
    return True

def weakest_dimension(round_scores):
    """Find the dimension with lowest average score"""
    dim_totals = {}
    dim_counts = {}
    for res in round_scores:
        for dim, score in res["scores"].items():
            dim_totals[dim] = dim_totals.get(dim, 0) + score
            dim_counts[dim] = dim_counts.get(dim, 0) + 1
    dim_avgs = {d: round(dim_totals[d] / dim_counts[d], 1) for d in dim_totals}
    return min(dim_avgs.items(), key=lambda x: x[1])

REVISIONS = {
    "queryStrategy": "Added guidance to broaden queries when results are sparse. The skill should detect zero/low-result queries and auto-retry with broader terms or reduced specificity.",
    "qualityFiltering": "Strengthened result quality guidance. Added explicit mention of engagement filters and spam avoidance in query construction.",
    "resultCoverage": "Emphasized running 1-3 complementary queries rather than a single query per search action. The workflow should iterate if the first pass returns < 3 useful results.",
    "actionContract": "Clarified action input/output contract with concrete examples showing exactly what fields each action returns.",
    "documentation": "Added worked examples for the most common failure query patterns. Gave users concrete query phrasing guidance for health/science topics.",
}

def main():
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    load_params()

    if not TARGET_SKILL or not FAILURE_MODE or not PROMPT_SET:
        print(json.dumps({"error": "Missing required params: targetSkill, failureMode, promptSet"}))
        sys.exit(1)

    # Detect the primary action for the target skill
    skill_manifest = WORKSPACE / "skills" / TARGET_SKILL / "manifest.json"
    primary_action = "search"
    if skill_manifest.exists():
        m = json.loads(skill_manifest.read_text())
        actions = m.get("actions", ["search"])
        primary_action = actions[0]

    print(f"[autoresearch] Starting {MAX_ROUNDS}-round loop on '{TARGET_SKILL}'", file=sys.stderr)
    print(f"[autoresearch] Failure mode: {FAILURE_MODE}", file=sys.stderr)
    print(f"[autoresearch] Prompts: {len(PROMPT_SET)} | Action: {primary_action}", file=sys.stderr)

    rounds = []

    for round_num in range(1, MAX_ROUNDS + 1):
        print(f"\n[autoresearch] === ROUND {round_num} ===", file=sys.stderr)
        round_results = []

        for prompt in PROMPT_SET:
            query = prompt if isinstance(prompt, str) else prompt.get("query", str(prompt))
            input_params = {"query": query} if isinstance(prompt, str) else prompt
            print(f"[autoresearch] Running prompt: {query}", file=sys.stderr)

            raw_result = run_skill(TARGET_SKILL, primary_action, input_params)
            scored = score_result(raw_result, SCORE_RUBRIC)

            round_results.append({
                "prompt": query,
                "raw": raw_result,
                "scores": scored["scores"],
                "total": scored["total"]
            })
            print(f"[autoresearch]   -> score: {scored['total']}/5 | success: {raw_result.get('success')}", file=sys.stderr)

        avg = round(sum(r["total"] for r in round_results) / len(round_results), 1)
        prev_avg = rounds[-1]["avgScore"] if rounds else None
        gain = round(avg - prev_avg, 1) if prev_avg is not None else None

        print(f"[autoresearch] Round {round_num} avg score: {avg}/5", file=sys.stderr)
        if gain is not None:
            print(f"[autoresearch] Score gain: {gain}", file=sys.stderr)

        rounds.append({"round": round_num, "results": round_results, "avgScore": avg, "gain": gain})

        # Auto-revise after round 1+
        if round_num < MAX_ROUNDS:
            weakest, weakest_score = weakest_dimension(round_results)
            revision = REVISIONS.get(weakest, f"Improve {weakest} from current avg {weakest_score}/5")
            updated = update_skill_md(TARGET_SKILL, f"{weakest} avg={weakest_score}/5", revision)
            if updated:
                print(f"[autoresearch] Auto-revised SKILL.md for weakest dim: {weakest} ({weakest_score}/5)", file=sys.stderr)
                print(f"[autoresearch] Lesson: {revision}", file=sys.stderr)

        # Stop if score flattened
        if round_num > 1 and gain is not None and gain <= 0.2:
            print(f"[autoresearch] Score gain {gain} <= 0.2 — stopping.", file=sys.stderr)
            break

    # Build report
    start = rounds[0]["avgScore"]
    final = rounds[-1]["avgScore"]
    total_gain = round(final - start, 1)

    report = {
        "targetSkill": TARGET_SKILL,
        "failureMode": FAILURE_MODE,
        "rounds": [
            {
                "round": r["round"],
                "avgScore": r["avgScore"],
                "gain": r["gain"],
                "promptCount": len(r["results"]),
                "scoreBreakdown": [
                    {"prompt": res["prompt"], "total": res["total"], "scores": res["scores"]}
                    for res in r["results"]
                ]
            }
            for r in rounds
        ],
        "summary": {
            "startScore": start,
            "finalScore": final,
            "totalGain": total_gain,
            "roundsRun": len(rounds),
            "maxRounds": MAX_ROUNDS,
            "stoppedEarly": len(rounds) < MAX_ROUNDS
        },
        "recommendations": [
            {
                "dimension": dim,
                "avgScore": score,
                "recommendation": f"Persistent low score in {dim} ({score}/5). Manual SKILL.md review recommended."
            }
            for dim, score in [weakest_dimension([r for rnd in rounds for r in rnd["results"]])]
        ] if len(rounds) > 0 else []
    }

    report_path = REPORTS_DIR / f"autoresearch-{TARGET_SKILL}-{int(__import__('time').time())}.json"
    report_path.write_text(json.dumps(report, indent=2))
    print(f"\n[autoresearch] Done. Report: {report_path}", file=sys.stderr)

    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    main()
