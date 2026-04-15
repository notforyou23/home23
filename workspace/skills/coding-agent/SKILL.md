---
id: coding-agent
name: Coding Agent
version: 1.0.0
layer: skill
runtime: docs
author: home23
description: Guidance for when to delegate coding work to a specialized coding runtime or worker.
capabilities:
  - brief: prepare a tight implementation brief
  - model-selection: choose the right coding runtime for the task
  - handoff: define ownership and expected outputs clearly
---

# Coding Agent

Use this skill when coding work is large enough that it benefits from a dedicated worker or coding runtime.

## When to use

Use `coding-agent` for:
- feature builds large enough to split from the main loop
- bounded refactors with clear file ownership
- implementation work that needs a concise brief before delegation

## Rules

- Keep the task concrete and bounded.
- Specify ownership: which files or module slice the worker owns.
- Say what success looks like.
- Avoid delegating the immediate blocking step if the main loop can just do it faster.

## Home23 mapping

- In Home23, this usually means using the agent's existing sub-agent tooling rather than inventing a new shell script.
- If the work is small, just edit directly instead of invoking this pattern.
