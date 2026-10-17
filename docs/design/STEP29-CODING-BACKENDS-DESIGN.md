# Coding backends: Codex and Cursor

Home23 delegates coding through `src/acp/bridge.ts`. Only `codex` and `cursor`
are selectable or advertised. Historical adapters remain for stored event and
receipt compatibility; they cannot launch new jobs.

## Model and invocation contracts

Codex launches `codex exec --json --skip-git-repo-check --model MODEL PROMPT`.
The working directory comes from process spawn, not a CLI directory override.
Configured models, explicit selections and saved continuation models pass to
the CLI unchanged. The existing default remains `gpt-5.6-sol` when neither an
explicit nor configured model is supplied. Home23 rejects malformed identifiers
before workspace or job creation; it does not maintain a model release allowlist.
The CLI validates availability with its own account and current catalog. A
rejected model fails the job; Home23 never retries with another model. Home23
provider discovery can inform choices but does not gate the CLI's separate account.
Execution-policy options precede the `resume SESSION_ID` subcommand, because
Codex accepts `--sandbox` on `exec`, not on `exec resume`. Continuation retains
the saved sandbox. Without an explicit sandbox, allowlist mode uses
`--ask-for-approval on-request` and `--sandbox workspace-write` instead of the
removed `--full-auto` alias; bypass mode retains its explicit bypass flag.
Codex extraArgs cannot select another model, profile or provider. Config
arguments are limited to quoted `model_reasoning_effort` and
`model_reasoning_summary` values. Existing unsupported config must be corrected
explicitly; it is never silently ignored.

Cursor launches `cursor-agent -p --output-format stream-json --trust` with
its configured model, permission mode and optional add-dir/extraArgs.
Both backends report their own session IDs for continuation. Unsupported
controls (effort, system-prompt append, tool filters and dollar budgets) are
omitted from the configured tool schema and rejected by the adapters.

Children receive a scrubbed environment. Home23 provider secrets are not
forwarded; each CLI uses its own authentication state. Binary discovery is
not proof of authentication, account balance or provider readiness.

## Durable jobs and lifecycle limits

Each instance stores `coding-jobs/<id>/job.json`, `events.jsonl`, `stderr.log`
and a final `receipt.json`. Jobs spawn detached with output redirected to
files. Recovery reattaches to live PIDs or finalizes dead jobs from saved
terminal events. Absence of a terminal event is interruption, not success.

Detachment survives ordinary parent exit, but a supervisor can kill the
entire descendant tree. PM2 with `treekill: true` does this even across process
groups. A coding child must not restart its own managed host. Run managed
activation from an independent operator process after active work drains;
see [managed releases](../reference/MANAGED-RELEASES.md).

Home23 jobs default to a Git worktree from committed HEAD. Uncommitted and
untracked work is not copied. Checkpoint mode records tracked state without
changing the original checkout; it does not back up untracked files. Neither
mode is a machine sandbox. Inspect receipts, integrate only the authorized
diff and verify the target before claiming completion.

## Configuration

```yaml
acp:
  enabled: true
  defaultAgent: codex
  allowedAgents: [codex, cursor]
  permissionMode: bypassPermissions
  backends:
    codex: { bin: codex, model: gpt-5.6-sol }
    cursor: { bin: cursor-agent, model: cursor-grok-4.6-high }
```

An absent ACP block remains disabled. CLI scaffolding explicitly opts in new
agents. The configured tool schema advertises only supported enabled backends.

## Verification

Backend tests cover argv, model rejection, supported controls and stream
parsing. Bridge tests exercise real child processes with scripted providers,
job persistence, cancellation, recovery and continuation. Tool tests cover
configured schemas and receipt delivery. Real provider acceptance is separate
from these offline checks.
