# Honest Mirror — Diagnostic Scanner Design

## Problem

The system cannot feel its own pain. Every metric, status report, and "green"
is the system trusting its own self-reporting. When the system lies to itself
— counting inbox file lines as pending work, counting "process exists" as
"service healthy," counting "claim exists" as "claim resolved" — nobody
notices until jtr asks.

## Root Cause

There is no independent diagnostic layer. The live-problems system tracks
hand-seeded invariants (disk, health log, create_file tool) but does not
discover structural failures on its own. The 116 dashboard restarts, 2,458
fake queue items, 7 stale contradictions, resurrected crons, and ghost tasks
were all invisible because nobody was checking for them.

## Design Principles

1. **Never trust self-reports.** Every check reads reality directly — files on
   disk, PM2 state, cron job state, truth.jsonl contents. No LLM calls, no
   asking the system how it feels.

2. **Never create a parallel tracking system.** Findings feed into the existing
   live-problems store. The existing loop handles verification, remediation,
   and escalation. The scanner is a sensor, not a second brain.

3. **Never auto-fix destructively.** Bounded safe fixes only: close ghost tasks,
   re-kill resurrected crons, auto-resolve stale implicit contradictions.
   Never delete files, restart processes, or modify config autonomously.

4. **Be honest about what you can't check.** If a check can't run, report the
   failure. Don't report green when the sensor is blind.

5. **Idempotent.** Running the scanner twice produces the same result. No side
   effects from scanning alone.

6. **Cheap.** Runs in seconds. No LLM calls, no network requests to external
   services. Pure local filesystem + PM2 + process state.

## Architecture

```
engine/src/diagnostic/
  scanner.js              — main loop, runs all checks on cadence
  checks/
    crash-loops.js        — PM2 restart count > threshold in time window
    stale-contradictions.js — truth.jsonl unresolved contradictions > 72h
    resurrected-crons.js  — disabled cron jobs with recent lastRunAt
    ghost-tasks.js        — tasks referencing dead/closed pursuits
    inflated-queue.js     — queueDepth metric != actual pending count
    theatre-crons.js      — enabled crons producing only no-change/discard
    stale-truth-claims.js — current claims contradicted by observable state
```

## Check Contract

Each check module exports:

```js
{
  id: 'crash_loops',           // stable identifier
  label: 'Crash-Loop Detection',
  intervalMs: 5 * 60 * 1000,    // how often to run (default 5 min)
  async run(ctx) -> {
    findings: [{
      id: 'crash_loop:home23-jerry-dash',
      severity: 'critical' | 'warning' | 'info',
      code: 'pm2_restart_count_exceeded',
      message: 'home23-jerry-dash restarted 116 times',
      evidence: { process, restartCount, threshold },
      autoFixable: false,       // scanner won't fix this
      liveProblem: {             — upsert into live-problems store
        claim: 'home23-jerry-dash is crash-looping',
        verifier: { type, args }, — deterministic re-check
        remediation: [ ... ],     — ordered fix plan
      }
    }],
    ok: true | false,            — did the check itself run cleanly?
    error: null | string,        — if check failed to run
  }
}
```

## Scanner Loop

1. Load all check modules from `checks/`
2. Every tick (default 5 min):
   a. Run each check whose interval has elapsed
   b. Collect findings
   c. For autoFixable findings: apply bounded fix, log receipt
   d. For non-autoFixable findings: upsert into live-problems store
   e. Write diagnostic report to `brain/diagnostic-report.json`
3. Findings that resolve (check returns no finding) → close corresponding
   live-problem

## What Each Check Detects

### crash-loops
- Reads `pm2 jlist` directly
- For each `home23-*` process: if `restart_time > 5` in last hour → critical
- If `restart_time > 0` and uptime < 5 min → warning (just restarted)
- Would have caught: 116 dashboard restarts

### stale-contradictions
- Reads `truth.jsonl` directly
- Computes `latestClaims` (Map by ID, last wins)
- Finds claims with `status: contested` and `acceptedAt > 72h ago`
- Would have caught: 7 contradictions stuck for weeks

### resurrected-crons
- Reads cron job state files directly
- For each job with `enabled: false`: if `lastRunAt` is within last 10 min → critical
- Would have caught: field-report-cycle running 86 times after disable

### ghost-tasks
- Reads `tasks.jsonl` directly
- For each task with `pursuitId`: check if pursuit exists in `pursuits.jsonl`
- If pursuit doesn't exist or is `closed`/`discarded` → warning
- Would have caught: 4 ghost tasks referencing dead pursuits

### inflated-queue
- Reads `inbox.jsonl` line count (cheap byte-scan)
- Reads agency state `queueDepth` field
- If `queueDepth > actualPendingCount * 1.5` → warning
- Would have caught: 2,458 "pending" items that were all processed

### theatre-crons
- Reads cron run logs / receipts
- For each enabled cron job: check last N runs
- If all N runs are `discard` or `no_change` with zero `pursue`/`watch`/`task` → warning
- Would have caught: field-report-cycle's 86 no-consequence runs

### stale-truth-claims
- Reads `truth.jsonl` for `status: current` claims
- For claims with `sourceRef` pointing to a file: check if file still exists
- For claims about process state: check PM2 directly
- Would have caught: stale claims about old unit state

## Auto-Fix Actions (bounded, reversible)

1. **Close ghost task**: append `status: closed` to tasks.jsonl with reason
2. **Re-kill resurrected cron**: set `enabled: false` in cron job state
3. **Auto-resolve stale implicit contradiction**: append `status: resolved` to truth.jsonl

All auto-fixes write receipts to `brain/diagnostic-fix-receipts.jsonl` with:
- timestamp, check id, finding id, action taken, evidence, reversible

## Integration Points

- **live-problems store**: scanner upserts findings as live-problems
- **Good Life snapshot**: scanner findings feed into viability lane
- **Dashboard**: `GET /api/diagnostic` returns latest report
- **Agency brief**: open diagnostic findings appear in "what needs attention"

## What This Is NOT

- Not a second brain. Not a second agency loop. Not an LLM-powered meta-cognition.
- Not a replacement for jtr's judgment on hard calls.
- A dumb, honest, cheap mirror that catches the system lying to itself.