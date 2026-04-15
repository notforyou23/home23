---
id: autoresearch
name: Autoresearch
version: 1.0.0
layer: skill
runtime: docs
author: home23
description: Guidance for iteratively improving a weak skill through score, tweak, and retest loops.
capabilities:
  - autoresearch_loop: tighten a skill by measuring quality, revising it, and running the loop again
---

# Autoresearch

Use this skill when a skill exists but performs inconsistently and needs deliberate improvement rather than one-off edits.

## Workflow

1. Define the failure mode clearly.
2. Choose a score rubric.
3. Run representative prompts against the skill.
4. Revise `SKILL.md`, routing, examples, or manifest metadata.
5. Retest on the same prompt set.
6. Stop when the quality gain flattens.

## Notes

- This is a process skill, not a direct executable runtime in Home23 yet.
- Use it when the right move is improving the skill itself, not just answering the current task.
