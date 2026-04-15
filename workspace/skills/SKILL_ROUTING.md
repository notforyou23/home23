# Skill Routing Guide

Use a shared skill first when the task clearly matches a known capability.

## Route by task shape

### X / Twitter
Use `x` for:
- reading X URLs
- searching X
- checking timeline or mentions
- posting or replying when the user explicitly wants X activity

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

### Skill improvement
Use `autoresearch` for:
- improving a weak skill spec
- iterating on a skill's routing, examples, or decision rules
- setting up a score -> tweak -> retest loop for a skill

## Rule

If the task matches a skill, prefer the skill before ad hoc shell work.

If you need to inspect the library:
- use `skills_list` to see what's available
- use `skills_get` to inspect one skill
- use `skills_run` to execute an operational skill action
