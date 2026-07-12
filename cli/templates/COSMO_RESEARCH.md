# COSMO Research Skill

You have access to COSMO 2.3 — a deep research engine that runs multi-agent orchestration with LLM providers to build knowledge brains. Use it when a question needs real investigation beyond what's already in your own brain.

## Core workflow

1. **Check existing brains first.**
   - `research_list_brains` — see what you already have.
   - `research_search_all_brains` — make a bounded direct-only query across the top few completed research brains. It does not accept PGS continuation or targeted controls. If an existing brain already answers the question, don't re-launch.

2. **Frame before you launch.** `research_launch` takes two critical fields:
   - `topic`: focused and specific. "Cosine similarity in semantic search" — not "everything about embeddings".
   - `context`: **why** you're researching, what sources are acceptable, scope, depth, rails. **Do not skip this.** Without it, COSMO's guided planner invents framing from model priors and builds over-prescriptive plans.

   Good context example: "I need a one-page primer for someone who knows linear algebra. Wikipedia + primary docs are fine. 5 cycles, normal depth. No deep academic sourcing needed."

3. **Size the run to the question:**
   - 5–10 cycles for a primer
   - 20–40 for a real investigation
   - 60–80 for a deep dive
   - `maxConcurrent: 6` is a reasonable default

4. **Watch sparingly.** `research_watch_run` is for checking progress, not for tailing every turn. Check every 2–3 turns, or when you think the run should be done. Always pass the `after` cursor from the previous call so you only see new entries. A launch call may finish while its underlying run remains active; use the current active-run block and exact `runId`, not the launch operation's terminal state.

5. **Query modes:**
   - A direct query is the default. Start with `quick` for a fast, bounded overview.
   - `full` — broader direct synthesis
   - `expert` — deep, with coordinator insights
   - `dive` — exhaustive, for crucial questions
   - For one exact brain, PGS levels are cumulative coverage budgets: skim (10%), sample (25%), deep (50%), full (100%). Fresh starts a new sweep, continue resumes an exact PGS operation, and targeted limits work to canonical partitions. An empty scoped result is not proof of full-brain absence.

6. **Compile to your brain when you want to keep the knowledge:**
   - `research_compile_brain` creates a bounded compiled artifact for a broad focus.
   - `research_compile_section` creates a smaller artifact for one goal, insight, or agent output.
   Generated installations watch `workspace/research/`, so the feeder can ingest these bounded artifacts.

7. **Orient before querying deeply.** Use `research_get_brain_summary` to see a brain's executive summary, goals, and trajectory before drilling into specifics with `research_query_brain`. Use `research_get_brain_graph` when you need to see HOW knowledge connects (clusters, bridges) rather than what it says.

## Rules

- **Never launch a run while another is active.** You'll see a `[COSMO ACTIVE RUN]` block in your prompt when one is in flight. If you need to cancel, use `research_stop`.
- **Detached is not failed.** Preserve exact operation IDs. Use `brain_status` to wait for or inspect a detached durable query, then reattach instead of starting duplicate work.
- **Never re-launch research that already exists in a brain.** Query it instead.
- **Never skip `context` in `research_launch`.** The guided planner needs it.
- **Prefer `research_compile_section` over `research_compile_brain`** when you only need one thread. Keep every compile bounded to the knowledge you intend to retain.
- **Don't quote multi-KB query responses verbatim.** Paraphrase, summarize, or compile. Large verbatim dumps eat conversation context.
