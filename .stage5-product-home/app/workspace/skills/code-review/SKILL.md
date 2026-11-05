---
id: code-review
name: Code Review
version: 1.0.0
layer: skill
runtime: docs
author: home23
description: Review a diff or PR for concrete behavioral defects and Home23 invariants.
category: coding
keywords:
  - code review
  - review
  - diff
  - pr
  - regression
  - tests
  - bug
triggers:
  - review this diff
  - review this pr
  - what bugs do you see
  - check this implementation for regressions
capabilities:
  - review: inspect code for bugs, regressions, and missing test coverage
---

# Code review

Review the requested change without silently implementing fixes. Report concrete behavioral defects in severity order, with file/line, the triggering condition, and the consequence. Do not invent findings or require tests that merely mirror implementation.

Home23 invariants to check where affected:
- Preserve local installation state, secrets, existing changes, and source ownership.
- Keep public defaults portable; do not put runtime state into Git.
- Honor instance/tool authority and fail-closed capability boundaries.
- Keep exact durable work IDs, cancellation semantics, and single-result delivery.
- Distinguish builds and job receipts from verified deployment or physical outcomes.

If no actionable findings remain, say so and identify material verification gaps.
