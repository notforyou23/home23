# Surfacer, land-receipt, and provisioning integration work record

Date: 2026-09-15
Lead: Codex `/root`
Next owner: Jerry

## Scope and authority

- Outcome: integrate the reviewed obligation-surfacing, land-receipt/release-provenance, and coding-worktree dependency-provisioning changes; correct the two retained Important review findings; leave a locally committed branch for inspection and later maintained-source integration.
- Worktree: `/Users/jtr/_JTR23_/development/home23/.home23-worktrees/integrate-surfacer-ledger-provisioning`
- Branch: `home23-agent/integrate-surfacer-ledger-provisioning`
- Maintained-source starting commit: `0d1d240293addd410ede0be639a423f9125ea61e`
- Authorized: bounded source/test/docs corrections, verification, and local commits.
- Excluded: main-branch mutation, push, deployment, release-pointer mutation, service restart, and runtime-state changes.

## Integrated lineage

The reviewed commits were cherry-picked in the requested order without conflicts:

1. `8a4ed73e7951aa21e45b3e8cdeba6cf7d7e6fa11` -> `8cefd2b68244b53c64250e61ad6bcff99ba3d8b7`
2. `af5ae440ecdc61dc4ed28b86832b1a9ed79ce773` -> `7e84583d3be6b3a8946e995e09a52a9dcff920e1`
3. `bdfcebb009b0376382be5f5fc5f98025f4e86433` -> `7109b4d0d81322f2c7e26e192964cd4d542326ff`
4. `46bb6d446632f929618445f2254edf2ede41cbfe` -> `10f5ccda7eae9ae810d3739e46f9c7dc11c64277`
5. `4b7bb09eb95f9a60e49bc320ffe42b1bac7edd15` -> `db2a77ce3e34f3e96a161afff038ff86a2a6409c`

## Retained review findings and corrections

1. `scripts/development/status.mjs` treated the prepared `sourceCommit` as an exact deployed tree and labeled `sourceCommit..HEAD` as “Source commits not running.” Preparation actually records the reviewed `baseRef`; selected post-base bytes can be present in the candidate. Correction commit `90c9184d945443358fed90c1661a6e3d51742dc8` renames the projection and output to preparation-base checkout context, removes the unsupported deployment inference, documents the boundary, registers the status regression, and adds a prepare-to-status test that proves selected post-base bytes can be in the candidate.
2. The two real-clone success cases in `tests/acp/worktrees.test.ts` guarded only Git, then dereferenced destinations even where the macOS-specific `cp -Rc` invocation is unsupported. The same correction commit capability-gates only those positive cases, keeps the cross-platform failure-receipt case active, strengthens its absent-destination assertion, and adds a meta-regression that forces clone-command failure. Production provisioning remains unchanged and fail-closed; no copy, symlink, or install fallback was added.

The post-correction pattern-consistency review reported no Critical, Important, or Minor findings.

## Verification receipt

Red-stage evidence against `db2a77ce3e34f3e96a161afff038ff86a2a6409c`:

- Prepare-to-status regression: exit 1; 9 passed, 1 failed because `preparationBaseCommit` was absent.
- Forced no-clone portability regression: exit 1; nested worktree suite had 8 passed and 2 failed because the positive tests dereferenced absent destinations.

Green-stage evidence at correction commit `90c9184d945443358fed90c1661a6e3d51742dc8`:

| Check | Exit | Result |
| --- | ---: | --- |
| `git diff --cached --check` for the correction | 0 | No whitespace errors. |
| `npx tsc --noEmit` | 0 | No diagnostics. |
| `npm run build` | 0 | Build completed without diagnostics. |
| Obligation kernel/context/dashboard/tools focused suite | 0 | 145 passed, 0 failed/skipped. |
| ACP worktrees/portability and coding consumers | 0 | 36 passed, 0 failed/skipped. |
| `npm run test:managed-release` | 0 | 38 passed, 0 failed/skipped; includes the registered development-status suite. |
| Land-receipt and release-provenance focused group | 0 | 51 passed, 0 failed/skipped. |

`COSMO23_SOURCE_ROOT` was absent and was not set for any follow-up check; these focused checks do not require it. The full repository suite was not rerun in this follow-up. The prior full-suite attempt remains incomplete: with `COSMO23_SOURCE_ROOT=/Users/jtr/_JTR23_/cosmo23`, 1,430 tests executed (1,423 passed, 1 failed, 6 skipped) before the command stopped on the known unrelated `tests/cli/product-memory.test.js` ephemeral-port failure; later chained groups did not run. That unrelated test was not changed or repaired here.

A supplementary package-registration guard ran 5 tests: 3 passed and 2 failed on pre-existing unregistered suites outside this correction diff. Neither corrected/new suite appears in its missing-registration output.

## Read-only release and ledger evidence

`node scripts/development/status.mjs --installation /Users/jtr/_JTR23_/release/home23 --apple /Users/jtr/_JTR23_/development/home23-apple` exited 0 at the clean correction commit. It reported selected backend release `4e97f875df656da8cb085a6d9379ddc263c2cc4d`, phone build 157, `Release preparation base: unknown` because the active pointer has no recorded source provenance, one undeployed receipt, and a stale source-reconciliation-baseline review note. The command explicitly made no source, state, or service change.

Every nonblank line of `state/land-receipts.jsonl` parsed as JSON: 1 line, 1 record. Its `6c84ce350a5e0d5a0fd7357f0e9e659ad591af8f` commit resolved as a Git commit and remains recorded as undeployed.

## Remaining action and blockers

- The bounded coding correction is complete and locally committed. It is not merged to main, pushed, deployed, or released.
- Jerry owns inspection and the already-authorized maintained-source integration/release follow-through.
- Release provenance remains unavailable for the currently selected live backend, the `6c84ce35...` land receipt remains undeployed, and the source reconciliation baseline remains stale. Those are truthful release-state blockers, not correction failures.
- The prior product-memory port test and the supplementary package-registration failures remain separate, pre-existing test-harness issues; no full-suite success is claimed.
