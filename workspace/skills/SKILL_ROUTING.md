# Skill Routing Guide

Use a shared skill first when the task clearly matches a known capability.

## Route by task shape

### X / Twitter
Use `x` for:
- reading X URLs
- searching X
- checking timeline or mentions
- posting or replying when the user explicitly wants X activity

Use `x-research` for:
- "what are people saying on X" questions
- read-only X/Twitter research
- thread follow-up from a tweet URL
- checking recent posts from a specific account
- watchlist-style monitoring of key accounts

### Browser tasks
Use `browser-automation` for:
- screenshots
- page extraction
- navigation checks in the live browser

### Coding workflows
Use `coding-agent` for:
- substantial coding jobs that should be delegated
- long refactors or build-outs where a bounded worker is the right shape
- choosing between Codex, Claude Code, or another coding runtime

Use `code-review` for:
- review requests
- diff and PR inspection
- bug, regression, and missing-test hunts

### Research and analysis
Use `source-validation` for:
- checking if a claim or source is trustworthy
- separating primary from secondary sources
- sanity-checking dates, provenance, and bias

Use `deep-research-synthesizer` for:
- turning many sources or brain outputs into one coherent answer
- deciding whether to query existing COSMO brains or launch deeper work
- producing a final synthesis with contradictions and open questions

Use `knowledge-structuring` for:
- turning messy notes into a framework, matrix, outline, or brief
- clustering ideas after research
- preparing structured handoff notes

### Automation and planning
Use `workflow-automation` for:
- breaking a goal into steps
- mapping steps to tools and skills
- setting execution order and safety rails

### Skill improvement
Use `autoresearch` for:
- improving a weak skill spec
- iterating on routing, examples, gotchas, or trigger text
- setting up a score -> tweak -> retest loop for a skill

## Rule

If the task matches a skill, prefer the skill before ad hoc shell work.

If you need to inspect the library:
- use `skills_list` to see what's available
- use `skills_get` to inspect one skill
- use `skills_suggest` when you want the best skill match for a task
- use `skills_audit` when you want to inspect quality or undertrigger risk
- use `skills_run` to execute an operational skill action
