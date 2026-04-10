# COSMO Research Skill

You have access to COSMO 2.3 — a deep research engine that runs multi-agent orchestration with LLM providers to build knowledge brains. Use it when a question needs real investigation beyond what's already in your own brain.

## Core workflow

1. **Check existing brains first.**
   - `research_list_brains` — see what you already have.
   - `research_search_all_brains` — query the top few brains for your question. If an existing brain already answers it, don't re-launch.

2. **Frame before you launch.** `research_launch` takes two critical fields:
   - `topic`: focused and specific. "Cosine similarity in semantic search" — not "everything about embeddings".
   - `context`: **why** you're researching, what sources are acceptable, scope, depth, rails. **Do not skip this.** Without it, COSMO's guided planner invents framing from model priors and builds over-prescriptive plans.

   Good context example: "I need a one-page primer for someone who knows linear algebra. Wikipedia + primary docs are fine. 5 cycles, normal depth. No deep academic sourcing needed."

3. **Size the run to the question:**
   - 5–10 cycles for a primer
   - 20–40 for a real investigation
   - 60–80 for a deep dive
   - `maxConcurrent: 6` is a reasonable default

4. **Watch sparingly.** `research_watch_run` is for checking progress, not for tailing every turn. Check every 2–3 turns, or when you think the run should be done. Always pass the `after` cursor from the previous call so you only see new entries.

5. **Query modes:**
   - `quick` — fast overview, small token budget
   - `full` — standard (default)
   - `expert` — deep, with coordinator insights
   - `dive` — exhaustive, for crucial questions

6. **Compile to your brain when you want to keep the knowledge:**
   - `research_compile_brain` for the whole run (one big node)
   - `research_compile_section` for one specific thread (one goal, insight, or agent's output)
   The engine feeder automatically ingests files written to `workspace/research/`.

7. **Orient before querying deeply.** Use `research_get_brain_summary` to see a brain's executive summary, goals, and trajectory before drilling into specifics with `research_query_brain`. Use `research_get_brain_graph` when you need to see HOW knowledge connects (clusters, bridges) rather than what it says.

## Rules

- **Never launch a run while another is active.** You'll see a `[COSMO ACTIVE RUN]` block in your prompt when one is in flight. If you need to cancel, use `research_stop`.
- **Never re-launch research that already exists in a brain.** Query it instead.
- **Never skip `context` in `research_launch`.** The guided planner needs it.
- **Prefer `research_compile_section` over `research_compile_brain`** when you only need one thread. Whole-brain compiles produce one giant node; section compiles produce focused nodes that cluster better in your own brain.
- **Don't quote multi-KB query responses verbatim.** Paraphrase, summarize, or compile. Large verbatim dumps eat conversation context.
