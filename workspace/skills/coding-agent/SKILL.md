---
id: coding-agent
name: Coding Agent
version: 1.0.0
layer: skill
runtime: docs
author: home23
description: Delegate coding through Home23 coding jobs, with isolation and verified integration.
category: coding
keywords:
  - coding
  - delegate
  - worker
  - refactor
  - feature
  - implementation
triggers:
  - delegate this coding task
  - spin up a worker for this feature
  - use a coding agent
  - hand this off to codex
capabilities:
  - brief: prepare a tight implementation brief
  - model-selection: choose the right coding runtime for the task
  - handoff: define ownership and expected outputs clearly
---

# Coding and delegation

Choose the route by the outcome and coordination cost. A capable model can handle a substantial change directly; file count alone is not a reason to delegate. Use independent agents for separable investigation, implementation, or review, not obligatory stages.

- Direct work: enough context is already present and delegation would delay the critical path.
- `coding_run`: a detached CLI coding session, with Git worktree/checkpoint options. Read [coding jobs](references/coding-jobs.md) before launching or integrating one.
- `spawn_agent`: a background Home23 run with shared identity and machine access, normally a fresh chat. Read [subagents and workers](references/subagents-and-workers.md) for context, model selection, and lifecycle limits.
- `worker_run`: a reusable configured worker with its own contract; inspect `worker_list` first.

Give the child the intended outcome, relevant facts and paths, owned files, existing work to preserve, authority and limits, and completion evidence. It may discover the cause itself. Keep briefing proportional; do not require an elaborate template or solve the task before delegating.

Remain responsible for the result. A launch or successful child message is not a finished parent task. Inspect relevant evidence, integrate within the original authorization, and check the resulting behavior. Preserve exact handles and avoid duplicate final delivery.
