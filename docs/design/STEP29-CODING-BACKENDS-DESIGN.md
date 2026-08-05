# Step 29 — First-Class Coding Backends (Claude Code + Codex)

**Status:** implemented in this step
**Owner:** harness (`src/acp/`)

## Problem

Home23's agent harness had an ACP bridge (`src/acp/bridge.ts`) that was dead code:
never instantiated, never registered as a tool, and its CLI invocations were wrong
(`codex --print` is not a Codex flag; `claude --print <prompt>` ignores everything
modern headless Claude Code offers). Jerry could not delegate real coding work to
the installed CLIs, jobs did not survive a harness restart, and self-modification
of the live Home23 checkout had no isolation story.

## Goals

1. Claude Code (`claude`) and Codex (`codex`) as first-class coding backends,
   driven through their headless interfaces with streaming JSON events.
2. Durable jobs: start / status / result / cancel that survive harness restarts.
   Jobs run **detached** — a Home23 restart does not kill a running coding job.
3. Genuine isolation for delegated work: per-job prompt, model, tool policy,
   session, and working directory. Git worktrees for Home23 self-modification.
4. Streaming progress into the existing AgentEvent pipeline (dashboard SSE +
   Telegram), with concise receipts persisted per job.
5. Practical lifecycle hooks (job started / completed / failed) for
   observability — no permission theater; Jerry keeps full machine authority.

## Non-goals

- No new permission prompts or approval flows.
- No parallel abstraction: `src/acp/` is rebuilt in place.
- No dependency on the Codex CLI being installed (it currently is not on this
  machine); the backend degrades to a clear "not installed" answer.

## Architecture

```
src/acp/
  bridge.ts       ACPBridge — job lifecycle orchestrator (rebuilt in place)
  backends.ts     Backend definitions: argv builders, env, event normalizers
  job-store.ts    Durable on-disk job records + crash recovery
  worktrees.ts    Git worktree + checkpoint helpers for self-modification
src/agent/tools/
  coding.ts       coding_run / coding_jobs / coding_status / coding_result /
                  coding_cancel / coding_continue / coding_backends
```

### Backends (`backends.ts`)

Each backend declares: `id`, `binCandidates`, `buildArgs(job)`, `buildEnv()`,
`parseEvent(line)` (normalizes one stdout line to a `BridgeEvent`), and
`resolveSessionResume(args)`.

**claude-code** (headless):

```
claude -p --output-format stream-json --verbose \
  --session-id <uuid>            # new job (recorded for later resume)
  --resume <session-id>          # coding_continue
  --model <model> --effort <level>
  --dangerously-skip-permissions # default: Jerry's machine, Jerry's authority
  --allowedTools/--disallowedTools ...   # only when a job requests a tool policy
  --append-system-prompt <text>  # per-job system prompt add-on
  --add-dir <paths...>
  --max-budget-usd <n>           # only when configured
  <prompt>
```

Stream-json events normalized: `system/init` (session id, model, tools),
`assistant` text + `tool_use` (name + compact input), `result` (final text,
cost, duration, num_turns, is_error).

**codex** (headless):

```
codex exec --json --skip-git-repo-check -C <cwd> \
  [--model <m>] [--full-auto | --sandbox <mode> | --dangerously-bypass-approvals-and-sandbox] \
  <prompt>
codex exec resume <session-id> --json ... <prompt>    # coding_continue
```

JSONL events normalized from `thread.started` (session id), `item.completed`
(`agent_message`, `command_execution`, `file_change`, `reasoning`), and
`turn.completed` (usage). Binary discovery: config `backends.codex.bin` →
`codex` on PATH. When missing, `coding_backends` reports it and `coding_run`
fails fast with instructions.

Env: children get a scrubbed environment (`unprivilegedChildEnv`) plus the
minimum the CLIs need (`HOME`, `PATH`, `TERM`, `USER`), plus any explicitly
configured `envPassthrough` names. **Anthropic auth is passed through**
(`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`): Home23 is the provider
authority (Step 21) and its brokered OAuth tokens are auto-refreshed and
lineage-monitored, whereas the CLI's own keychain login was verified stale on
this machine. Non-Anthropic provider keys and Home23 secrets (bot tokens,
encryption key, DB URL) are stripped; Codex authenticates via its own
`~/.codex/auth.json`.

### Durable jobs (`job-store.ts`)

Layout, one directory per job under the instance dir:

```
instances/<agent>/coding-jobs/<jobId>/
  job.json        # metadata + status (atomic tmp+rename writes)
  events.jsonl    # the CLI's raw stream — child writes directly via fd
  stderr.log
  receipt.json    # concise final receipt
```

The child process is spawned **detached** with stdout redirected straight into
`events.jsonl`. That file is simultaneously the durability layer and the
streaming source: the harness tails it for live events, and after a restart the
same file replays what happened while Home23 was down.

Recovery on boot (`bridge.recover()`):
- scan job dirs for `status: running`
- PID alive → reattach the tail, keep streaming (job survived the restart)
- PID dead → finalize from `events.jsonl` (find the terminal event) →
  `completed` / `failed`; no terminal event → `interrupted` with
  `resumable: true` (the recorded session id lets `coding_continue` pick the
  conversation back up)

Receipts are concise by design: status, backend, model, session id, exit code,
duration, cost (when the CLI reports it), turns, files changed (from git when
in a repo), branch/worktree, and a bounded tail of the final result.

### Worktrees + checkpoints (`worktrees.ts`)

- A job whose `cwd` resolves inside the Home23 checkout defaults to
  `isolation: worktree`: `git worktree add .home23-worktrees/<slug>
  -b home23-agent/<slug>` and the job runs there. The receipt records branch,
  worktree path, and `git diff --stat`. Rollback = delete the worktree/branch;
  the live checkout is never touched.
- In-place jobs inside any git repo get a **checkpoint**: `git stash create`
  (a dangling commit, working tree untouched) recorded in the receipt so any
  damage can be recovered via `git stash apply <sha>`.
- Explicit `isolation: none` opts out entirely (non-repo targets).

### Lifecycle hooks

Bridge-level hook points: `job_started`, `job_event`, `job_finished`. The
harness wires them to: dashboard/Telegram progress (AgentEvent `status` +
final summary appended to conversation history, mirroring the `spawn_agent`
delivery contract) and the per-agent event ledger. Config may add shell hooks
(`acp.hooks.onComplete` / `onFail`) executed with `HOME23_JOB_*` env vars.
Hooks observe; they never gate.

### Delegated-agent isolation (`spawn_agent`)

`spawn_agent` grows optional `tools` (worker grant groups → seeded registry),
`system_prompt` (replaces the parent's assembled prompt for the sub-run), and
a per-spawn sub-chat id so sub-agent turns no longer masquerade as the parent
conversation. Defaults preserve the current behavior.

## Config

`ACPConfig` (src/types.ts) grows optional fields; existing configs stay valid:

```yaml
acp:
  enabled: true
  defaultAgent: claude-code
  allowedAgents: [claude-code, codex]
  permissionMode: bypassPermissions   # Jerry's default; 'allowlist' honors tool lists
  maxConcurrentJobs: 3
  jobTimeoutMs: 3600000
  backends:
    claude-code: { bin: /Users/jtr/.local/bin/claude }
    codex:       { bin: codex, sandbox: danger-full-access }
  envPassthrough: []
  hooks: { onComplete: "", onFail: "" }
```

## Testing

- argv/env builders per backend (new session, resume, tool policy, budget)
- job-store: atomic writes, scan, finalize-from-events with real stream-json
  and codex JSONL fixtures
- bridge lifecycle against a fake CLI (node script emitting stream-json):
  start → events → receipt; cancel; detached survival; recovery of dead PIDs
- tools: execute() against a mock ToolContext (idiom of
  tests/agent/tools/workers.test.ts)
- worktrees: real temp git repos — worktree create/cleanup, checkpoint stash
