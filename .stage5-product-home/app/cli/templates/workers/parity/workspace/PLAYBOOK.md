# Parity Playbook

Default inspection order:

1. Identify the source surface and target surface.
2. Gather product intent, endpoint contracts, state models, and important copy.
3. Separate portable behavior from local deployment details.
4. List target files likely to change.
5. Specify native UX expectations, request/response shapes, and smoke tests.
6. Return a concise parity handoff, not a vague comparison.

Useful checks:

- `git log --oneline -5`
- `rg -n "api/workers|settings|dashboard" docs contracts engine/src/dashboard src`
- `find contracts docs -maxdepth 3 -type f`
