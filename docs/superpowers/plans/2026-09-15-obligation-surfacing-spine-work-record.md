# Obligation surfacing spine work record

Date: 2026-09-15
Lead: Codex `/root`

## Scope and authority

- Outcome: split operator/self agency obligations, suppress terminal coordination Work from open obligations, inject unsurfaced operator obligations into every turn, and record explicit surfaced receipts.
- Source: `/Users/jtr/_JTR23_/development/home23/.home23-worktrees/obligation-surfacing-spine`
- Branch: `home23-agent/obligation-surfacing-spine`
- Starting commit: `0d1d240293addd410ede0be639a423f9125ea61e`
- Maintained baseline: `/Users/jtr/_JTR23_/development/home23` at the same commit.
- Authorized: source edits, scoped cleanup/integration, verification, and a local commit.
- Not authorized: push, deployment, service restart, runtime-state mutation, or release-checkout edits.

## Evidence and dependencies

- No source changes were borrowed.
- Read-only live evidence found 53 open agency tasks: 52 coordination-derived, of which 51 have explicit terminal canonical Work state and one remains running.
- The release checkout was used only for read-only evidence; it is not a source baseline.
- Baseline: resident-kernel tests passed 66/66; context/tool focused tests passed 33/33.

## Current state

- Implemented the bounded audience split, terminal canonical-Work filtering, always-on operator-obligation context, explicit surfaced receipt path, dashboard/brief rendering split, and supporting documentation.
- Pattern-consistency review found and prompted two corrections: unchanged canonical digests now still migrate legacy manufactured `L2` authority to `unknown`, and invalid brief POST acknowledgements return HTTP 400 like adjacent mutating routes. The follow-up review reported no remaining deviations.
- `npx tsc --noEmit`: passed with exit 0.
- `npm run build`: passed with exit 0 after temporarily linking this isolated worktree to the maintained checkout's existing `node_modules`; the temporary link was removed. The first build attempt failed before compilation because the isolated worktree had no local TypeScript binary.
- Focused post-change tests: 147 passed, 0 failed (70 agency kernel; 40 context/gating/tool; 24 resident-assignment/helper; 13 dashboard).
- JavaScript syntax checks and `git diff --check`: passed.
- No service was restarted or deployed, and no runtime/release state was changed.
- Next owner/action: Codex reviews and commits this task-only diff on the current branch; activation remains a separate, unauthorized operation.
