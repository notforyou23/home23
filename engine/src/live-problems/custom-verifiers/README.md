# Custom Verifiers (Level 4 — approval-gated, scaffolded only)

This directory is reserved for LLM-proposed, jtr-approved verifier functions
that extend the built-in catalog at `engine/src/live-problems/verifiers.js`.

**Not yet active.** The runtime pieces (sandbox, loader, approval UI) are
not wired in yet. This README + the `proposals/` subdirectory document the
intended shape so we can iterate on the design before building.

## The pattern

1. **Proposal.** When a cognitive role emits a concern that the built-in
   verifier catalog can't express, the agent (Tier-2 dispatch) can propose
   a new verifier type by writing a JS function to `proposals/*.js` with
   a matching `proposals/*.meta.json` describing what it does, what args
   it takes, and what it reads from the system.

2. **Sandbox test run.** A verifier-proposal-runner (not yet built) loads
   each proposal in a VM context with a locked-down globals table:
     - fs.readFileSync (restricted to paths in config/targets.yaml files list)
     - fetch (restricted to URLs in config/targets.yaml urls list)
     - setTimeout / clearTimeout
     - console (captured to log, not forwarded)
     - NO: process, child_process, fs.writeFileSync, net, http, vm, require
   The proposal runs against a dry-run input and its output is captured.
   Safe proposals write a `proposals/*.trial.json` with N observed results
   across N ticks.

3. **Approval.** jtr reviews the proposal + trial results in the dashboard
   (a new "proposed verifiers" surface) and flips `approved: true` in the
   meta. An approved proposal moves from `proposals/` to this directory
   as `custom-verifiers/<name>.js` and is loaded at engine start by
   `verifiers.js` via a scan of this dir.

4. **Runtime.** Approved custom verifiers are invoked identically to
   built-ins: `runVerifier({type: '<name>', args})`. Revocation is
   deletion of the file + engine restart.

## Shape of a proposed verifier

A `proposals/<name>.js` file exports a single async function:

```js
// proposals/cron_last_success.js
module.exports = async function cron_last_success(args = {}, ctx = {}) {
  // args: { service, maxAgeMin }
  // Must return: { ok: boolean, detail: string, observed?: object }
  const { service, maxAgeMin = 360 } = args;
  const statePath = `/Users/jtr/cron-state/${service}/last-success.ts`;
  // ... read file, check mtime, return result
};
```

The matching `proposals/<name>.meta.json`:

```json
{
  "name": "cron_last_success",
  "description": "Verify a cron job has a last-success marker within N minutes",
  "argsSchema": {
    "service": { "type": "string", "required": true, "enum": ["..."] },
    "maxAgeMin": { "type": "number", "default": 360 }
  },
  "readsPaths": ["/Users/jtr/cron-state/*"],
  "readsUrls": [],
  "proposedBy": "agent-dispatch:<turnId>",
  "proposedAt": "2026-04-16T...",
  "trialRuns": 0,
  "trialResults": [],
  "approved": false,
  "approvedBy": null,
  "approvedAt": null
}
```

## Why sandboxing is mandatory

LLM-generated code in a privileged runtime is the biggest risk in this
whole architecture. Sandbox contract:

- **No write access.** Verifiers are read-only. Any attempted write is
  caught by the VM context (no fs.write* in globals).
- **No network except whitelisted URLs.** Verifiers that need HTTP must
  declare their URLs in `readsUrls`; the sandbox fetch wrapper enforces
  this at call time.
- **No process control.** No child_process, no exec, no spawn.
- **Timeout.** Each verifier call is capped at 10s (configurable per-proposal
  but upper-bounded).
- **No require() of arbitrary modules.** Require is replaced with a stub
  that only resolves a whitelisted module list (currently empty — add
  modules to the whitelist by hand as needed).

## What NOT to put here by hand

Built-in verifier types live in `engine/src/live-problems/verifiers.js`
(the file in the parent directory). Those are trusted first-class code
reviewed by humans. Don't use this directory for hand-written code —
that's what verifiers.js is for. This directory is specifically for the
approval-gated autonomous-expansion path.

## Status

| Component | State |
|---|---|
| Directory structure | ✅ present (this file) |
| Proposal shape documented | ✅ above |
| Meta-schema documented | ✅ above |
| Sandbox contract documented | ✅ above |
| Runtime loader | ❌ not built |
| VM context / sandbox | ❌ not built |
| Approval UI | ❌ not built |
| Proposal queue worker | ❌ not built |
| Trial-run harness | ❌ not built |

See the parent `engine/src/live-problems/` README (and `verifiers.js`
module-level comments) for the built-in catalog that Level 4 extends.
