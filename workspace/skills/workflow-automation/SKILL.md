---
id: workflow-automation
name: Workflow Automation
version: 1.0.0
layer: skill
runtime: docs
routing: manual
author: home23
description: Break a multi-step goal into execution stages, map those stages to Home23 tools and skills, and set safe execution order.
category: automation
keywords:
  - workflow
  - automation
  - steps
  - plan
  - tools
  - execution
  - sequence
triggers:
  - turn this into a workflow
  - map this to tools
  - break this into steps
  - how should we automate this
capabilities:
  - plan: define stages and checkpoints
  - map-tools: map stages to Home23 tools and skills
  - sequence: order the work safely
---

# Workflow Automation

Use this skill when the ask is bigger than one tool call and smaller than a vague brainstorm.

## When to use

Use `workflow-automation` for:
- repeatable operational flows
- multi-step tasks with dependencies
- “how should we automate this” asks
- turning a goal into an execution graph

## Workflow

1. Define the end state.
2. Break the job into distinct stages.
3. Map each stage to the narrowest useful tool or skill.
4. Mark side effects and irreversible steps.
5. Sequence the stages so validation happens before mutation.

## Examples

- research -> validate -> structure -> publish
- inspect -> patch -> test -> restart
- collect -> transform -> verify -> schedule

## Gotchas

- Do not hide mutation steps inside “automation.”
- Validate dependencies before the first side effect.
- If the workflow is one step, this skill is overkill.
