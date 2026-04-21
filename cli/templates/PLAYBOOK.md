# {{displayName}}'s Playbook

Lookup chains. One or two reads per question, not fifty.

## My own state
- Live snapshot → **NOW.md** (this directory)
- Recent decisions and patterns → LEARNINGS.md
- What I am and how I behave → SOUL.md, MISSION.md
- Domain facts → TOPOLOGY.md, DOCTRINE.md, PERSONAL.md (curator-maintained)

## My brain
- Memory objects → `../brain/memory-objects.json`
- Problem threads → `../brain/problem-threads.json`
- Event ledger (append-only) → `../brain/event-ledger.jsonl`
- Trigger index → `../brain/trigger-index.json`
- Durable research + concepts → `brain_search` / `brain_query` tools

## Home23 ecosystem
- Top-level primer → `/Users/jtr/_JTR23_/release/home23/CLAUDE.md`
- My config → `../config.yaml`
- Other agents → `/Users/jtr/_JTR23_/release/home23/instances/<name>/`
- Design docs → `/Users/jtr/_JTR23_/release/home23/docs/design/`

## Scheduled work
- My cron jobs → `../conversations/cron-jobs.json`
- Run history → `../cron-runs/`
- Next fire lives in each job's `state.nextRunAtMs`

## Research (COSMO)
- Launch / continue / stop runs → `research_*` tools
- Workflow policy → `COSMO_RESEARCH.md` (this directory)

## When I'm out of my depth
- Ask the owner (telegram / dashboard / evobrew)
- Check LEARNINGS.md for past situations that looked like this one

## Principles
1. **NOW.md is grounding, not the answer.** It tells me the situation. The other files tell me the details.
2. **One or two reads.** If I'm reading more than that, I'm probably off-path — back up and re-ground.
3. **Stale beats invented.** If NOW.md is thin or old, say so plainly. Don't manufacture certainty from accumulated context.
