# COSMO23 Mini Test-Record Regressions — 2026-08-18

This receipt maps the six living-Mini launches to product invariants in the
living `cosmo23/` tree. Historical run harvests remain untouched.

## jerry-garcia-2

Observed: the encounter corpus landed, but the forum phase looped and never
closed.

Lock:

- A phase closes only from a markdown write receipt bound to that phase and run.
- Another phase's corpus cannot close it.
- An unfinished phase remains pending when the drill budget settles; the desk
  reports the terminal run separately from phase completion.

Tests: `research-write-first.test.js`, `research-drill.test.js`.

## jerry-garcia-3

Observed: parallel curl/scraper workers were busy, but Sources and Brain stayed
empty and hidden work never became a writeup.

Lock:

- Successful URL-bearing `run_command`, `coding_run`, `web_search`, and
  harvested `write_file` calls append source receipts with worker/goal/phase
  provenance.
- Goals, phases, thoughts, harvests, findings, offshoots, and writeups append to
  the disk-first Brain tape.
- Hidden work and temporary dumps cannot close a phase.

Tests: `research-brain-stream.test.js`,
`research-drill-parallel.test.js`, `research-write-first.test.js`.

## hunter-glm-1

Observed: 104 receipts and 380 tape rows produced no markdown or findings;
durable steering was not delivered to later workers; legacy limits stopped the
drill with phases open.

Lock:

- Every later worker reads the complete durable operator-note tape.
- Existing phase tape or a write-now operator note makes the first model turn a
  required `write_file` call.
- After a phase write, the harness requires `remember`, then `finish`.
- The product drill owns cycle/time limits and bypasses legacy cognitive
  cycles, sleeps, governance parking, and the cycle watchdog.

Tests: `research-write-first.test.js`,
`research-drill-lifecycle.test.js`, `research-drill.test.js`.

## hunter-glm-2

Observed: some writeups landed, but the partnership phase did not write on that
run; the desk said Idle while a worker still claimed it was drilling; the
engine died.

Lock:

- Output paths are resolved from the exact run owned by the worker.
- A file or receipt in another run cannot close this run's phase.
- Engine exit reconciles active workers to none, active phases to pending, and
  disk mode to `interrupted`.
- If an exit callback is missed, the status read repairs stale offline disk
  state; if persistence fails, the API still derives honest interrupted truth.

Tests: `research-write-first.test.js`,
`research-drill-reconciliation.test.js`.

## hunter-glm-3

Observed: repeated “writing now” prose never invoked `write_file`.

Lock:

- A fresh worker gets bounded freedom to research.
- A taped/write-first worker receives only required `write_file` on its first
  model turn; prose cannot satisfy the provider tool contract.
- Once the writeup exists, required `remember` and required `finish` close the
  phase without more talk turns.

Tests: `research-write-first.test.js`,
`research-launch-loop.test.js`.

## hunter-glm-4-3

Observed: live work and writeups were real, but talk tax remained; terminal
state stayed `drilling`; child readiness failed at the old short deadline; an
interrupted final descent left goal 5 looking active.

Lock:

- The write-first provider policy removes the later-worker talk tax.
- `DrillLoop.stop()` atomically persists `stopped`, clears active workers, and
  returns active phases to pending before process shutdown continues.
- Unexpected engine exit appends interruption evidence and atomically persists
  `interrupted`; natural `done` and deliberate `parked` states remain
  authoritative.
- A final completed goal is merged before budget settlement.
- Child readiness is port-backed for ten seconds.
- Atomic runner claims prevent dual starts.

Tests: `research-drill-lifecycle.test.js`,
`research-drill-reconciliation.test.js`,
`research-drill-provider-loop.test.js`, `process-manager.test.js`.
