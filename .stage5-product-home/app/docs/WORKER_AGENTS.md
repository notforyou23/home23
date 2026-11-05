# Home23 Worker Agents

Worker agents are reusable specialists Home23 can call when a job needs focus but does not need another full engine. They have their own workspace, playbook, run history, artifacts, and proof receipts. Jerry, Forrest, or the human operator can run them on demand.

The point is simple: when something needs checking, a worker can do the pass, leave evidence, and feed useful findings back to the house agents.

## Packaged Worker Library

Home23 ships a portable worker-pack catalog. Packs are generic by default; install applies the local selected/primary owner agent so the same Home23 repo can run on another machine without hard-coded local names.

| Worker pack | Use it when | What it returns |
| --- | --- | --- |
| `systems` | Home23 feels slow, stale, broken, or confusing. | Process, endpoint, log, and verifier evidence. |
| `freshness` | Data may look recent but be stale underneath. | Fresh/stale/historical-only classification with timestamp evidence. |
| `memory` | Home23 may be remembering old conclusions as current truth. | Memory audit and curator handoff evidence. |
| `parity` | A native or web surface needs to match Home23 behavior. | Portable parity handoff with routes, models, UX notes, and smoke tests. |
| `release` | An app, package, or service change is near shipping. | Release preflight, blockers, artifact/version checks, and checklist. |
| `feeder` | Documents are not flowing into memory correctly. | Ingestion, watch-path, queue, quarantine, converter, and freshness diagnosis. |

### Systems Worker

Use `systems` when:

- Home23 feels slow or stale.
- A dashboard, endpoint, PM2 process, or live problem needs a grounded check.
- You want evidence before restarting anything.
- You need Jerry or Forrest to remember what was verified.

It can:

- Inspect scoped PM2 process status.
- Probe dashboard and engine endpoints.
- Read relevant service logs.
- Check freshness, health, receipts, and verifier outcomes.

It will not:

- Run global destructive PM2 commands.
- Clean up files or git state on its own.
- Claim a fix without a concrete verifier or equivalent check.

### Freshness Worker

Use `freshness` when a source may be current at the wrapper level but stale inside the payload. It checks semantic dates, state snapshots, receipts, endpoint payloads, and source file timestamps.

Good asks:

```text
Is this sensor payload actually fresh?
Find stale signals in the current state.
Check whether the latest receipt reflects current truth.
```

### Memory Worker

Use `memory` when the system may be rediscovering a resolved issue, trusting old memory over current state, or missing a resolution receipt.

Good asks:

```text
Is this belief still true?
Why does this problem keep coming back?
Does this completed work have a resolution receipt?
```

### Parity Worker

Use `parity` when web, Mac, iOS, tvOS, docs, and contracts need to stay aligned. It produces portable handoffs instead of assuming one local setup.

Good asks:

```text
Make the Mac app match this web feature.
Write a native parity contract.
Check whether this client already supports the capability.
```

### Release Worker

Use `release` before shipping. It runs readiness checks and produces release evidence without publishing unless explicitly asked.

Good asks:

```text
Run a release preflight.
Check what build number should ship.
Summarize changes since the last release.
```

### Feeder Worker

Use `feeder` when documents are not flowing into memory correctly. It inspects watch paths, manifests, compiler queues, converter health, quarantine state, and freshness.

Good asks:

```text
Why are these documents not showing up?
Check ingestion health.
Find stuck or quarantined files.
```

## User Surfaces

- Dashboard: `http://localhost:5002/home23`, then open `Workers` / `Worker Desk`.
- Settings: `http://localhost:5002/home23/settings#workers`, the `Worker Library`.
- Connector API through dashboard: `/home23/api/workers`.
- Owner bridge API: `/api/workers` on the selected agent bridge port, normally `5004` for Jerry.

## Create a Worker

From Settings, open `Workers`, pick a worker pack, choose the owner agent, enter a lowercase kebab-case name, and click `Install Worker`.

If the owner is omitted in CLI usage, Home23 uses the local primary agent from `config/agents.json`, falling back to `agent` for a newly bootstrapped portable install.

CLI equivalent:

```bash
node cli/home23.js worker create systems --template systems --owner <agent-name>
```

The worker is created under:

```text
instances/workers/<name>/
```

Each worker has:

- `worker.yaml` for identity, owner, class, tools, limits, visibility, and brain-feed defaults.
- `workspace/IDENTITY.md` for durable role identity.
- `workspace/PLAYBOOK.md` for the repeatable operating procedure.
- `workspace/artifacts/` for output files.
- `runs/<runId>/` for inputs, transcript, artifacts, and `receipt.json`.

## Run a Worker

From the dashboard `Workers` tab, pick a starter action such as `Check Home23 health`, `Why is it slow?`, `Inspect live problem`, or `Verify a fix`. Add plain-language context if needed, then click `Run Check`.

Good asks:

```text
Check why Home23 feels slow right now.
Inspect the current live problem and tell me the next repair step.
Verify the dashboard and engine endpoints are healthy.
Check whether the health bridge data is fresh enough to trust.
```

CLI equivalent:

```bash
node cli/home23.js worker run systems "inspect the current live problem and produce a receipt"
```

Direct dashboard API:

```bash
curl -s http://127.0.0.1:5002/home23/api/workers/systems/runs \
  -H 'content-type: application/json' \
  -d '{"prompt":"inspect the current live problem and produce a receipt","requestedBy":"human","requester":"jtr"}'
```

## Receipts and Memory

Every run writes a `home23.worker-run.v1` receipt with:

- `status`: `fixed`, `no_change`, `blocked`, `failed`, or `cancelled`.
- `verifierStatus`: `pass`, `fail`, `unknown`, or `not_run`.
- `summary`, evidence, artifacts, and memory candidates.
- source fields when a run came from live problems, Good Life, cron, or a house agent.

House agents observe the worker brain-feed JSONL and inject recent worker receipts into context. The dashboard receipt panel can also send memory candidates to the memory-curator handoff endpoint.

## Portable Defaults

Worker templates use symbolic owner placeholders such as `primary`. During install, Home23 replaces those placeholders with the selected owner or the local primary agent. Do not hard-code one operator's agent names into packaged worker templates.

## Safety Model

Workers are intended to be small, bounded, and reusable. They should:

- Work inside their own workspace unless the task explicitly requires reading the Home23 repo or host state.
- Produce receipts instead of vague chat summaries.
- Use verifiers before claiming a fix.
- Leave destructive host or git operations to a house agent unless explicitly allowed by their playbook and the operator request.

## Current Limits

- First slice runs are synchronous through the owner bridge connector.
- Cancel is exposed in the API but returns `not_supported` until async queued runs are added.
- Memory promotion currently returns candidates to the curator handoff surface; it does not silently write arbitrary memories.
