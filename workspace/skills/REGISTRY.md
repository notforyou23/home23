# Skills Registry

Generated from live skill discovery. Total: 10 skills.

## autoresearch

- **ID:** `autoresearch`
- **Type:** rich
- **Runtime:** docs
- **Category:** meta
- **Operational:** no
- **Has SKILL.md:** yes
- **Has manifest:** yes
- **Has scripts:** no
- **Hooks:** none
- **Description:** Improve a weak skill by running a score, tweak, and retest loop when the issue is the skill itself rather than the current task.
- **Actions:** autoresearch_loop
- **Triggers:** improve this skill | autoresearch this skill | optimize the skill | why is this skill weak
- **Requires tools:** skills_audit
- **Composes:** knowledge-structuring
- **Depends on:** none

## browser-automation

- **ID:** `browser-automation`
- **Type:** rich
- **Runtime:** nodejs
- **Category:** browser
- **Operational:** yes
- **Has SKILL.md:** yes
- **Has manifest:** yes
- **Has scripts:** no
- **Hooks:** none
- **Description:** Inspect a live web page with the shared browser controller when you need screenshots, rendered text, or navigation checks.
- **Actions:** navigate, extract, screenshot
- **Triggers:** take a screenshot | extract the page text | check if this page loads | inspect the rendered page
- **Requires tools:** none
- **Composes:** source-validation
- **Depends on:** none

## code-review

- **ID:** `code-review`
- **Type:** rich
- **Runtime:** docs
- **Category:** coding
- **Operational:** no
- **Has SKILL.md:** yes
- **Has manifest:** yes
- **Has scripts:** no
- **Hooks:** none
- **Description:** Review a patch, diff, PR, or implementation for bugs, regressions, risky assumptions, and missing tests.
- **Actions:** review
- **Triggers:** review this diff | review this pr | what bugs do you see | check this implementation for regressions
- **Requires tools:** read_file, search_files, list_files
- **Composes:** source-validation, knowledge-structuring
- **Depends on:** none

## coding-agent

- **ID:** `coding-agent`
- **Type:** rich
- **Runtime:** docs
- **Category:** coding
- **Operational:** no
- **Has SKILL.md:** yes
- **Has manifest:** yes
- **Has scripts:** no
- **Hooks:** none
- **Description:** Delegate a substantial coding task to a specialized coding runtime or worker when the job is too large for an inline pass.
- **Actions:** brief, model-selection, handoff
- **Triggers:** delegate this coding task | spin up a worker for this feature | use a coding agent | hand this off to codex
- **Requires tools:** spawn_agent
- **Composes:** workflow-automation
- **Depends on:** none

## deep-research-synthesizer

- **ID:** `deep-research-synthesizer`
- **Type:** rich
- **Runtime:** docs
- **Category:** research
- **Operational:** no
- **Has SKILL.md:** yes
- **Has manifest:** yes
- **Has scripts:** no
- **Hooks:** none
- **Description:** Turn many sources or brain outputs into one coherent synthesis with contradictions, confidence, and next actions.
- **Actions:** synthesize
- **Triggers:** synthesize this research | pull these sources together | what do all these findings say | summarize the research with contradictions
- **Requires tools:** research_list_brains, research_search_all_brains, research_query_brain, web_search
- **Composes:** knowledge-structuring
- **Depends on:** source-validation

## knowledge-structuring

- **ID:** `knowledge-structuring`
- **Type:** rich
- **Runtime:** docs
- **Category:** research
- **Operational:** no
- **Has SKILL.md:** yes
- **Has manifest:** yes
- **Has scripts:** no
- **Hooks:** none
- **Description:** Turn messy notes, findings, or context into a framework, matrix, outline, or clean handoff structure.
- **Actions:** structure
- **Triggers:** organize these notes | turn this into a framework | structure this research | make this a clean handoff
- **Requires tools:** none
- **Composes:** source-validation
- **Depends on:** none

## source-validation

- **ID:** `source-validation`
- **Type:** rich
- **Runtime:** docs
- **Category:** research
- **Operational:** no
- **Has SKILL.md:** yes
- **Has manifest:** yes
- **Has scripts:** no
- **Hooks:** none
- **Description:** Validate claims and sources for credibility, recency, provenance, and likely bias before you rely on them.
- **Actions:** validate
- **Triggers:** is this source trustworthy | validate this claim | check the source quality | is this a primary source
- **Requires tools:** web_search, web_browse
- **Composes:** none
- **Depends on:** none

## workflow-automation

- **ID:** `workflow-automation`
- **Type:** rich
- **Runtime:** docs
- **Category:** automation
- **Operational:** no
- **Has SKILL.md:** yes
- **Has manifest:** yes
- **Has scripts:** no
- **Hooks:** none
- **Description:** Break a multi-step goal into execution stages, map those stages to Home23 tools and skills, and set safe execution order.
- **Actions:** plan, map-tools, sequence
- **Triggers:** turn this into a workflow | map this to tools | break this into steps | how should we automate this
- **Requires tools:** skills_suggest, cron_schedule, shell
- **Composes:** coding-agent, source-validation, deep-research-synthesizer
- **Depends on:** knowledge-structuring

## x

- **ID:** `x`
- **Type:** rich
- **Runtime:** nodejs
- **Category:** social
- **Operational:** yes
- **Has SKILL.md:** yes
- **Has manifest:** yes
- **Has scripts:** no
- **Hooks:** beforeRun
- **Description:** Read, search, or post on X/Twitter when the task clearly involves tweets, mentions, timelines, or tweet URLs.
- **Actions:** timeline, read, search, mentions, post, reply
- **Triggers:** read this x link | search x for | check mentions | look at my timeline | reply on x
- **Requires tools:** none
- **Composes:** source-validation
- **Depends on:** none

## x-research

- **ID:** `x-research`
- **Type:** rich
- **Runtime:** nodejs
- **Category:** research
- **Operational:** yes
- **Has SKILL.md:** yes
- **Has manifest:** yes
- **Has scripts:** no
- **Hooks:** none
- **Description:** Research live discourse on X/Twitter when the task is to find what people are saying, follow threads, inspect profiles, or monitor key accounts without posting.
- **Actions:** search, thread, profile, tweet, watchlist_show, watchlist_add, watchlist_remove, watchlist_check, cache_clear
- **Triggers:** search x for | search twitter for | what are people saying on x | what's twitter saying | check x discourse | follow this x thread
- **Requires tools:** none
- **Composes:** source-validation, deep-research-synthesizer
- **Depends on:** none

