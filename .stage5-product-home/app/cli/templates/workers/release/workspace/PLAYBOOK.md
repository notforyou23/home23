# Release Playbook

Default inspection order:

1. Identify the target artifact and release channel.
2. Check current branch, recent commits, version/build metadata, and release notes source.
3. Run or recommend the smallest relevant preflight checks.
4. Identify blockers, warnings, and any genuinely missing authorization; do not request permission already granted.
5. Produce a release handoff with commands, expected artifacts, and verification steps.

Useful checks:

- `git status --short`
- `git log --oneline -10`
- project-specific build/test commands from package files or project docs
