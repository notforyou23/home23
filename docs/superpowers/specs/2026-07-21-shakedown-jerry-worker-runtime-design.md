# Home23 Worker Runtime + ShakedownJerry — Complete Design

Date: 2026-07-21
Status: approved operating direction — awaiting jtr review of this written specification before implementation planning
Authority: this document supersedes `2026-05-02-worker-agents-design.md` and the worker vertical-slice plan where they conflict with this contract

## Decision

Home23 will repair the generic Worker runtime completely and use `shakedown-jerry` as its first resident, production-operating worker.

This is one delivery. The work has a dependency order, but no intermediate slice is an acceptable finished product and no material capability is parked for another version.

`shakedown-jerry` will:

- remain owned by Jerry;
- reuse Jerry's semantic brain and knowledge instead of creating another graph brain;
- maintain its own durable operational identity, state, campaigns, history, artifacts, and receipts;
- wake from Home23 cron and domain events;
- act through enforceable, typed capabilities;
- publish, distribute, measure, learn, repair, and continue autonomously under a standing grant;
- appear in Jerry's context and existing Home23 dashboard rather than requiring another agent conversation;
- run without another engine, harness, dashboard, MCP server, feeder, port set, or PM2 process family.

The completed system must replace the present declarative-only Worker behavior. There will be no permanent scheduled-`agentTurn` workaround, no second Worker execution path, and no duplicated Codex automation fleet left active after cutover.

## Why this is the correct Home23 object

Home23 has three distinct execution identities:

| Identity | Persistence | Runtime | Correct use |
| --- | --- | --- | --- |
| Full agent | Independent identity, brain, conversations, channels, scheduler, and cognitive engine | Four long-running PM2 processes | Jerry and Forrest |
| Worker | Named specialist identity, workspace, state, schedules, tools, receipts, and owner-brain access | In-process execution inside an owner harness | ShakedownJerry and other specialist operators |
| Ephemeral subagent | One conversation-scoped delegated result | Re-enters the owner loop | Parallel one-off work only |

ShakedownJerry needs durable specialization and autonomous wakeups, but it does not need an independent conversation, engine, or semantic brain. A repaired Worker is therefore the exact fit.

## Product contract

The user speaks to Jerry. Jerry remains the mouth, shared semantic memory, and owner-agent authority surface.

ShakedownJerry is a resident internal operator. Its loop is:

```text
wake
  -> load identity, current state, prior receipts, and fresh evidence
  -> discover and rank useful opportunities
  -> choose one coherent campaign step
  -> authorize each action against the standing grant
  -> act through typed capabilities
  -> verify public, runtime, and data consequences
  -> rollback automatically when required
  -> update campaign state, channel learning, and memory
  -> write a complete receipt
  -> return control until the next scheduled or event-driven wake
```

The loop prefers useful action. A denied action blocks only that action: the worker records the denial and selects another eligible opportunity. A run may end `no_change`, `cancelled`, `timed_out`, `budget_exhausted`, or `failed_after_bounded_retry`; none counts as useful progress. A data-integrity conflict or rollback failure freezes only the affected target while unrelated lanes remain eligible.

## Existing runtime defect being repaired

The current Worker runner loads `IDENTITY.md` and `PLAYBOOK.md` and passes a nominal system prompt, workspace, and tool list to `runAgentLoop`. Production wiring then ignores the supplied system prompt and tools and executes Jerry's fixed `AgentLoop` using Jerry's static workspace and full tool registry.

Consequences today:

- `provider` and `model` are parsed but not honored;
- `tools` and `safetyPolicy` are descriptive rather than enforceable;
- runtime, tool-call, and token limits are not applied;
- `NOW.md` is not loaded by the worker runner;
- every run uses a unique Jerry conversation key rather than a real worker-owned history policy;
- `requestedBy: cron` is metadata only;
- `feedsBrains` and `visibleTo` do not control receipt routing;
- receipts leave actions and memory candidates empty;
- cancellation is not implemented;
- one active worker blocks every other worker owned by the same agent;
- cron has no first-class `workerRun` payload;
- the Agency resident interval currently fails during startup because its logger contract is wrong.

The repair is complete only when each declared field and integration surface has observable runtime effect.

## Architecture

```text
Human -> Jerry chat -------------------------------+
Home23 cron -> workerRun --------------------------+
Domain event -> worker queue ----------------------+--> Worker Connector
Agency / Good Life / Live Problems ----------------+         |
CLI / Dashboard / API -----------------------------+         v
                                                    Worker Registry
                                                          |
                                        manifest + authority grant + hashes
                                                          |
                                                          v
                                            Worker Execution Runtime
                                  identity / workspace / history / model
                                    filtered tools / policy / limits
                                                          |
                                           typed capability executor
                                                          |
                   +------------------+--------------------+------------------+
                   |                  |                    |                  |
              local artifacts    Shakedown repo      configured public   owner brain
              and state          and candidates      channels/runtime    read + feed
                   |                  |                    |                  |
                   +------------------+--------------------+------------------+
                                                          |
                                           verification + rollback
                                                          |
                                                          v
                                        canonical WorkerRun receipt
                                                          |
                       worker store / scheduler / event bus / Jerry / dashboard
```

All dispatchers call the same Worker Connector and queue. None invokes a separate agent-turn implementation.

## Worker filesystem contract

Workers remain outside full-agent discovery:

```text
instances/workers/<name>/
  worker.yaml
  workspace/
    IDENTITY.md
    PLAYBOOK.md
    NOW.md
    MEMORY.md
    state/
      current.json
      opportunities.jsonl
      campaigns.jsonl
      channel-scores.json
      action-ledger.jsonl
    sessions/
    artifacts/
  runs/
    <run-id>/
      input.json
      input.md
      events.jsonl
      transcript.md
      receipt.json
      artifacts/
  logs/
  locks/
```

Rules:

- Runtime state is local and is never treated as installable source.
- State updates are schema-validated and atomic.
- JSONL ledgers are append-only; corrections create new records.
- Raw transcripts remain worker-local and do not enter an owner brain automatically.
- Artifacts and receipts carry content hashes.
- Existing worker directories and version-one receipts remain readable in place.
- Migrations are idempotent and create recovery copies before changing a worker-owned file.

## Worker manifest contract

The manifest remains YAML and gains an explicit schema. Schema numbering is data compatibility, not a staged product release.

```yaml
schema: home23.worker.v2
kind: worker
name: shakedown-jerry
displayName: ShakedownJerry
ownerAgent: jerry
class: growth-operator
purpose: Grow qualified Shakedown listeners and members by improving, publishing, distributing, and learning from the site.

provider: owner-default
model: owner-default

context:
  promptRoots: [worker-workspace]
  identityFiles: [IDENTITY.md, PLAYBOOK.md, NOW.md, MEMORY.md]
  sessionHistory: fresh
  ownerBrainRead:
    - agent: jerry
      scopes: [shakedownshuffle, jerry-garcia, public-research]

capabilities:
  - shakedown.observe
  - shakedown.content.prepare
  - shakedown.site.publish
  - shakedown.code.integrate
  - shakedown.backend.deploy
  - shakedown.distribute.substack
  - shakedown.distribute.channel
  - shakedown.communications.consented
  - shakedown.collection.local
  - shakedown.collection.promote-additive
  - shakedown.enrichment
  - shakedown.indexing
  - shakedown.runtime.reload-scoped
  - shakedown.rollback

authorityGrant: shakedown-jerry-standing

paths:
  read:
    - /Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects/shakedownshuffle
    - /Users/jtr/websites/shakedownshuffle.com/shakedown-v2
    - /Users/jtr/websites/shakedownshuffle.com/jerry-api
    - /Users/jtr/websites/shakedownshuffle.com/ops/jerry-collection
    - /Users/jtr/websites/shakedownshuffle.com/ops/shakedown-watchdog
    - /Users/jtr/websites/shakedownshuffle.com/releases
    - /Users/jtr/websites/shakedownshuffle.com/html
    - /Users/jtr/server/config/Caddyfile
  write:
    - /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry
    - /Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects/shakedownshuffle
  sourceClone:
    - /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/source-clones
  gitMetadata:
    - /Users/jtr/websites/shakedownshuffle.com/.git
  codeRelease:
    - /Users/jtr/websites/shakedownshuffle.com/releases/code
  runtimeWrite:
    - /Users/jtr/websites/shakedownshuffle.com/ops/jerry-collection/runtime
  dataWrite:
    - /Users/jtr/_JTR23_/jerry-collection/shows_catalog.json
    - /Users/jtr/_JTR23_/jerry-collection/audio_inventory.json
    - /Users/jtr/_JTR23_/jerry-collection/youtube_index.json
    - /Users/jtr/_JTR23_/jerry-collection/collection_state.json
    - /Users/jtr/websites/shakedownshuffle.com/jerry-api/show-enrichment/artifacts
    - /Users/jtr/websites/shakedownshuffle.com/jerry-api/data
  quarantine:
    - /Volumes/Althea/Jerry/audio/quarantine
  collectionCandidate:
    - /Volumes/Althea/Jerry/audio/release-candidates
  collectionStash:
    - /Volumes/Althea/Jerry/audio/stash
  artifact:
    - /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/workspace/artifacts
    - /Users/jtr/_JTR23_/release/home23/instances/workers/shakedown-jerry/runs
  privateRead:
    - /Users/jtr/websites/shakedownshuffle.com/private
  receipt:
    - /Users/jtr/websites/shakedownshuffle.com/ops/jerry-collection/runtime/receipts
    - /Users/jtr/websites/shakedownshuffle.com/jerry-api/show-enrichment/artifacts/reports
  releaseCandidate:
    - /Users/jtr/websites/shakedownshuffle.com/releases
  liveWebroot:
    - /Users/jtr/websites/shakedownshuffle.com/html

limits:
  maxRuntimeMinutes: 90
  maxToolCalls: 160
  maxTokens: 140000
  maxArtifactBytes: 2147483648
  maxConcurrentRuns: 1

safetyReserve:
  maxRuntimeMinutes: 30
  maxToolCalls: 24
  maxArtifactBytes: 268435456
  retryAttempts: 2

retry:
  transientAttempts: 3
  initialBackoffSeconds: 15
  maxBackoffSeconds: 300

feedsBrains: [jerry]
visibleTo: [jerry]
```

These are maximum roots, not blanket write authority. All version-controlled source in the active `/Users/jtr/websites/shakedownshuffle.com` checkout is read-only to the worker. Source changes occur in an independent worker-owned local clone with its own `.git`, pinned to a recorded commit; it never uses `git worktree` or writes the active repository's metadata merely to create an editing environment. After the preservation scan, approved local-only source/config inputs are materialized by hash into that clone and committed on a dedicated worker branch. Shakedown frontend, backend, and operational-script edits stay there until deliberately integrated. Builds write to a run-specific artifact directory and never to shared `shakedown-v2/dist`, because that directory is itself served publicly at `v2.shakedownshuffle.com`.

The `gitMetadata` ceiling is available only to `shakedown.code.integrate`. That adapter may import an exact tested commit/bundle and update a dedicated `refs/heads/codex/shakedown-worker/*` reference; it may not checkout or switch the user's branch, modify the active index/worktree, reset, clean, delete refs, rewrite history, or push externally. It proves the active worktree inventory and current branch/HEAD are unchanged before reporting success.

The `runtimeWrite`, `dataWrite`, `quarantine`, `collectionCandidate`, and `collectionStash` ceilings above are derived from `ops/jerry-collection/config.json`. Profile resolution records and pins that config's hash, rejects unknown keys or target drift, and requires a newly signed grant before a changed target can be used. They authorize only the corresponding typed state machine—not general file tools—and are unavailable when the target volume or hash-pinned config is absent. `privateRead` is available only to deterministic aggregate/redaction adapters; raw records never enter the model context. The standing grant supplies the narrower effective scopes for every path class, account, host, and action.

`/html`, `/html/pro`, the Shakedown private-data tree, Supabase/Stripe authority, credential stores, and the Caddyfile are never general worker write roots. A privileged typed publisher may replace the candidate-controlled portion of `/html` only after snapshot and preflight; the model never receives a general file tool that can write there. `v2.shakedownshuffle.com` is not a publication target unless a later grant revision names it explicitly; otherwise every run proves that its artifact hash and public behavior remain unchanged.

The schema rejects an empty effective write scope for any capability that declares writes, rejects unknown capability IDs, and rejects paths that do not resolve inside an approved installation root. Identity and mission paths are relative to declared prompt roots, realpath-confined, symlink-safe, and content-hash pinned; arbitrary absolute prompt paths are invalid. A `persistent` history worker is invalid with `maxConcurrentRuns > 1` unless claims are serialized by a durable lease on the persistent history key.

Backward compatibility:

- Existing broad tool booleans are translated through a documented compatibility map.
- Compatibility authority is the intersection of legacy manifest-declared intent and the approved compatibility map. It never preserves authority exposed only by the current full-tool-registry wiring defect. Ambiguous mappings fail closed.
- Newly created resident workers must use explicit capability IDs.
- Unknown fields, invalid limits, missing grants, and contradictory policies fail manifest loading with a visible worker error.

## Worker execution runtime

The owner harness will host one lightweight execution runtime per loaded worker. It is constructed or refreshed from the worker manifest and does not create OS processes or ports.

Manifest and grant resolution produces an immutable `WorkerExecutionProfile` containing the worker and owner principals, identity/prompt document paths and hashes, workspace and history locations, provider/model configuration, filtered capability registry, path/account/host scopes, brain scopes, limits, retry policy, visibility, feed destinations, and manifest/grant hashes. At claim time, symbolic values such as `owner-default` resolve to a concrete provider, model, and credential-authority ID; the attempt persists that tuple without secret material, and retry/resumption retains it. Every run constructs a worker-specific `AgentLoop`, `ContextManager`, history store, filtered registry, workspace binding, owner-brain delegate, and event ledger from that profile. Only stateless provider/configuration clients may be shared with Jerry's harness. A manifest or expanded grant reload takes effect between runs, never halfway through one. Revocation, expiry, or a hard-stop policy update is checked live at each consequential action and may only narrow an in-flight profile; a newly broadened grant never expands an existing run. The receipt records the exact resolved profile, prompt hashes, provider/model, manifest, grant, and any mid-run revocation hashes used.

Each worker runtime receives immutable per-run context:

- authoritative worker system prompt assembled from declared identity files;
- worker workspace and history store;
- manifest-selected provider and model;
- filtered tool registry built from capability definitions;
- worker policy enforcer;
- worker runtime, token, and tool-call budgets;
- owner-bound brain client with declared read scopes;
- cancellation signal, deadline, retry metadata, and idempotency key;
- trigger evidence and Agency pursuit binding.

The runtime must not mutate Jerry's static `AgentLoop` context to impersonate a worker. Worker execution context must remain correct under concurrent Jerry chat, Forrest work, and other worker runs.

History modes:

- `fresh`: every run starts with clean conversational history and reconstructs from explicit worker state, receipts, and owner-brain retrieval. ShakedownJerry uses this mode.
- `persistent`: runs reuse a stable worker conversation key when a worker genuinely needs conversational continuation.

Both modes use the same persistent identity and state. Conversation history is never the sole copy of a commitment, decision, or recovery instruction.

## Tool and capability enforcement

Prompt instructions are not security boundaries. Every tool call is authorized immediately before execution.

The policy decision receives:

- worker and owner identity;
- manifest and authority-grant hashes;
- capability ID and normalized arguments;
- action class;
- resolved filesystem, process, URL, account, and data targets;
- authenticated triggering source;
- run, pursuit, job, and idempotency IDs.

The decision returns `allow`, `deny`, or `require-human-authorization`. A denied call produces a receipt event and no side effect.

Every worker action crosses exactly one `CapabilityExecutor.execute(envelope)` chokepoint. It normalizes and resolves all targets, obtains the current policy decision, and durably records a redacted structured `action_started` event before any side effect. Only `allow` invokes the typed adapter. The executor then records `action_succeeded`, `action_denied`, `action_failed`, `action_rolled_back`, or `action_reconciliation_required` with structured evidence and resource usage. Workers cannot call the generic `ToolRegistry.execute`, a nested adapter, shell, browser driver, or deterministic executor directly; nested capability calls must re-enter the same wrapper with parent action and correlation IDs.

Filesystem rules:

- Resolve real paths before authorization.
- Reject path traversal and symlink escapes.
- Separate read, write, artifact, release-candidate, live-webroot, private-data, and receipt roots.
- Never authorize `/`, a home directory, a workspace root, or unresolved environment variables as destructive targets.
- Direct writes to the live Shakedown webroot are unavailable; publication uses the release capability.

Shell rules:

- Resident workers do not receive unrestricted shell by default.
- Known workflows are typed capabilities with fixed entrypoints, working directories, arguments, timeouts, and output contracts.
- A shell compatibility capability, where retained for existing workers, is path-confined and command-policy checked.
- Shell cannot bypass a denied file, database, account, production, or network action.

Network and browser rules:

- Hosts, accounts, and action types are declared per capability.
- Browser preflight that creates remote state is classified as a write.
- Credentials and session material never appear in prompts, transcripts, receipts, or artifacts.
- Public posting identifies Shakedown Shuffle transparently; it does not impersonate community members.

## Authenticated Worker Connector

Every management and dispatch route is mounted after and behind Home23 bridge authentication and fails closed when credential authority is unavailable or unconfigured. Worker ingress does not accept today's anonymous/no-token mode or one undifferentiated shared bearer as authenticated identity. Scoped signed credentials or authenticated operator sessions resolve an immutable principal, allowed operation set, and owner scope for `operator`, `agent:jerry`, `agent:forrest`, `service:cron`, `service:event-router`, `cli`, and other admitted clients. The connector derives the trigger class from that transport identity, then resolves `ownerAgent` from the registered manifest. Request bodies may not override owner, requester, principal, source, visibility, operation scope, or authority-grant identity.

The connector enforces operation-specific authorization for create, inspect, list, run, cancel, retry, schedule, event-bind, artifact read, receipt read, memory promotion, grant activation/revocation, disable, and archive. Run, receipt, event, and artifact queries are filtered by owner and `visibleTo`; a caller cannot enumerate another owner's records and then rely on UI filtering. Internal cron and event dispatch use service principals with explicit route scopes rather than trusted caller-supplied metadata. A harness may claim only requests whose `ownerAgent` equals its authenticated harness identity. A wrong-owner connector either routes through the authenticated owner broker or denies; Forrest's harness can never claim a Jerry-owned worker merely because both registries can see its manifest.

Owner-brain operations carry both the owner principal and the worker principal. The brain delegate enforces the resolved public-safe read scopes and feed destinations, records the requesting worker in the audit event, and cannot use Jerry's unrestricted identity to cross into personal, health, credential, or unrelated memory. Connector authentication, authorization, visibility, and cross-owner denial receive integration tests at the actual HTTP/IPC boundary.

## Limits, concurrency, lifecycle, and recovery

The runtime enforces:

- wall-clock deadline;
- model-token budget;
- tool-call budget;
- artifact-size budget;
- retry budget;
- per-worker concurrency;
- optional resource-group concurrency for expensive local operations.

`maxTokens` is cumulative across prompt and completion tokens for every model call and retry in the run, including any secondary model-backed capability. Provider usage is authoritative when available; otherwise the runtime records a conservative tokenizer estimate. Trigger-supplied timeout, history, tool, token, artifact, and retry values may only narrow the resolved profile limits, never broaden them.

The finite `safetyReserve` is separate from ordinary run limits and is available only after a live cutover/data transition to named deterministic verifier and rollback capabilities; it cannot call a model, generate new campaign work, publish new material, or broaden the transaction. Its wall-time, tool-call, artifact-byte, and retry ceilings persist across restarts rather than resetting. Exhaustion enters `rollback_failed`, freezes the affected target, preserves the journal and evidence, and raises an urgent operator item; it never runs indefinitely.

The current owner-wide lock is replaced by per-worker locks and shared resource locks. A long systems run must not block ShakedownJerry solely because both are owned by Jerry.

Lifecycle states:

```text
queued -> running -> verifying -> succeeded | no_change | denied | blocked | reconciliation_required | failed_after_bounded_retry | timed_out | budget_exhausted | cancelled | rolled_back | rollback_failed
```

Requirements:

- queued and running state survives harness restart;
- stale running records are deterministically reconciled;
- before a production transaction crosses cutover, cancellation signals the model and active tools, then records what completed;
- after cutover, cancellation, deadline, or model-budget exhaustion stops optional work but cannot interrupt mandatory verification or rollback, which use a reserved non-model safety budget;
- idempotency prevents duplicate scheduled, event, or retry actions;
- transient failures retry with bounded backoff;
- policy denial, invalid evidence, and data conflict do not retry blindly;
- a circuit opens per capability or external channel, never for the entire worker;
- other useful lanes continue while one capability is unavailable;
- rollback failure creates an urgent Jerry-visible operator item and stops actions against the affected target.

### Durable request and recovery journal

The canonical queue is a local SQLite/WAL store at `instances/workers/runtime/worker-runtime.sqlite`; per-run `events.jsonl` remains the human-readable audit projection. At minimum the store contains request envelopes, attempts, leases, idempotency results, outbox deliveries, and event-consumer cursors.

Each request persists before execution begins and includes `requestId`, worker/owner principals, authenticated trigger, mission text or confined relative prompt path plus resolved realpath/hash, identity hashes, created/not-before/deadline times, idempotency key, priority, pursuit binding, cancellation state, manifest/grant hashes, and requested limit narrowings. Claiming a request atomically records claimant, lease expiry, attempt number, heartbeat, and the concrete provider/model/credential-authority tuple. Every consequential capability call receives a deterministic action key derived from request, capability, normalized target, and logical operation. Before retry, its adapter checks the local action ledger and authoritative remote/public readback; an uncertain outcome becomes `reconciliation_required`, never a blind duplicate post, send, payment-adjacent operation, or promotion. Expired leases are reclaimed deterministically; completed action IDs and the idempotency-result index prevent replayed side effects. A bounded worker-execution capacity bucket is distinct from Jerry chat and from named shared-resource buckets such as site build, collection promotion, and public cutover.

Publication has its own restart-safe journal:

```text
prepared -> snapshotted -> cutover -> verifying -> committed
                                      |-> rolling_back -> rolled_back
```

Recovery resumes the mandatory phase indicated by that journal. It never guesses from a missing wrapper result or treats process death as proof of rollback.

Collection and enrichment promotions use equivalent durable journals in the same store:

```text
collection: candidate_prepared -> snapshot_verified -> stash_applied -> authorities_applied
            -> api_projection_applied -> runtime_reloaded -> verifying -> committed
                                                    |-> rolling_back -> rolled_back

enrichment: candidate_prepared -> snapshot_verified -> artifacts_applied
            -> runtime_reloaded -> verifying -> committed
                                  |-> rolling_back -> rolled_back
```

Each transition records predecessor/candidate hashes and the exact completed side effects before moving forward. After the first live-data transition, cancellation, deadline, harness restart, or model-budget exhaustion cannot interrupt mandatory verification or rollback; these phases use the same reserved non-model safety budget as website publication. Restart reconciliation resumes from journal plus authoritative filesystem/API readback, and a rollback failure freezes only the affected data target while creating an urgent operator item.

## Scheduler and event integration

Home23 cron gains a first-class payload:

```yaml
kind: workerRun
worker: shakedown-jerry
mission: optional short mission
missionPath: optional versioned prompt path
sessionHistory: fresh
timeoutSeconds: 5400
idempotencyKeyTemplate: "<job-id>:<scheduled-time>"
```

Before advancing a recurring job, the scheduler captures an immutable `SchedulerDispatchContext { schedulerRunId, dueAt, occurrenceKey, pursuitId }`. The default idempotency key is derived from the job ID and that captured occurrence key, not from the job's already-advanced `nextRunAt`. Dispatch persists the request envelope and context in one transaction; schedule advancement may then occur independently without losing the due occurrence.

The scheduler:

- resolves the worker and owner;
- sets `requestedBy: cron` itself;
- binds the run to the configured Agency pursuit;
- submits through the canonical worker queue;
- waits for or tracks the canonical receipt;
- maps receipt verification and consequence into scheduler semantic status;
- records delivery and consequence evidence;
- does not treat a mechanically green no-consequence run as useful work.

Domain events pass through a `WorkerTriggerRouter` and then use the same queue. The versioned router maps each event class to worker, mission, pursuit, filters, debounce/cooldown policy, and idempotency template. It authenticates the connector crossing, keeps a durable replay cursor, and rejects reflexive wakeups using origin worker, run, action, correlation, and causation IDs. A worker cannot trigger an unbounded loop by reading back its own publication or receipt.

Initial Shakedown event classes are:

- collection release or new-show receipt;
- show-enrichment readiness or live-promotion receipt;
- owned-site or Substack publication receipt;
- route, playback, signup, payment, entitlement, or service health failure;
- meaningful traffic, listening, conversion, or campaign change;
- configured anniversary or editorial opportunity.

Recurring and event-triggered work share one durable Shakedown Agency pursuit. They do not create ornamental pursuits for every run.

Initial installed schedule, in `America/New_York`:

| Job | Schedule | Mission |
| --- | --- | --- |
| `shakedown-resident-cycle` | `23 */2 * * *` | Refresh evidence, choose and complete the best useful campaign step, verify, learn, and record the next move |
| `shakedown-daily-trust` | `47 6 * * *` | Verify site, API, audio, analytics, signup/payment/entitlement evidence, jobs, and channel authentication before the main day |
| `shakedown-daily-collection` | `0 15 * * *` | Preserve and execute the verified non-audio -> verification -> collection sequence and emit opportunities from its receipts |
| `shakedown-weekly-strategy` | `19 8 * * 1` | Re-score channels and campaigns, retire weak work, identify missing product value, and set the week's emphasis |
| post-action readbacks | one-shot at capability-specific short, 24-hour, and 7-day windows | Verify external state and update campaign/channel outcomes |

Event wakeups are debounced and idempotent. The worker may adjust low-risk timing under its standing scheduling authority when measured traffic, service load, or campaign timing justifies it; schedule changes require a receipt and must preserve daily trust, daily collection, weekly strategy, and post-action obligations.

## Worker management contract

CLI, API, Jerry tools, and dashboard are different clients of the same management service. The service supports:

- list and inspect worker templates;
- create a worker without creating full-agent config or processes;
- validate, inspect, and reload a worker manifest and authority grant;
- activate a signed authority-grant version through an authenticated operator action;
- revoke an active grant immediately while preserving its audit history;
- list workers and their effective execution profiles;
- run now with an authenticated trigger and idempotency key;
- schedule or event-bind a worker through the scheduler/event registry;
- list queued, active, stale, and completed runs;
- stream progress events;
- inspect canonical receipts and artifacts;
- cancel an active run;
- retry a retry-eligible failed run without duplicating completed actions;
- promote eligible memory candidates;
- disable new dispatch while preserving worker state and history;
- archive a disabled worker through a recoverable, explicit operation.

There is no hard-delete worker action in normal operation. Management responses report the manifest hash, authority-grant hash, effective capabilities, owner, current locks, and next scheduled wake so UI and operator claims cannot drift from runtime authority.

## Agency, Good Life, Live Problems, and Jerry integration

The repaired Worker Connector is the sole dispatch surface for:

- Jerry and Forrest tools;
- Agency tasks and pursuits;
- Good Life governed delegation;
- Live Problems typed remediation;
- cron and event dispatch;
- CLI, API, and dashboard actions.

Required repairs:

- fix the Agency resident startup logger failure;
- ensure resident selection can create an executable worker dispatch rather than only a narrative next action;
- attach worker consequences to the bound pursuit;
- use the same authority policy at dispatch and tool execution;
- make worker completion visible in Jerry's pre-turn context;
- prevent raw worker transcripts from flooding Jerry's brain;
- make `feedsBrains` and `visibleTo` authoritative;
- make memory promotion an actual persisted operation rather than a readiness response.

Jerry can invoke ShakedownJerry naturally, inspect its status, redirect its pursuit, stop a run, or change its standing grant. The user does not need to open a separate Shakedown chat.

## Receipt contract

Every run commits one canonical receipt blob and hash in the durable runtime store. `runs/<run-id>/receipt.json` is its atomic human-readable filesystem projection. Existing version-one filesystem receipts remain readable.

Minimum version-two receipt fields:

```text
schema
runId / requestId / idempotencyKey / occurrenceKey
worker / ownerAgent
trigger: human | house-agent | cron | event | agency | good-life | live-problems | cli | api
requester and authenticated source reference
pursuitId / jobId / eventId / originRunId / correlationId / causationId
manifestHash / authorityGrantHash
provider / model
startedAt / finishedAt / duration
limits and actual resource use
status / semanticStatus / verifierStatus
mission and expected consequence
actions[] with capability, target, policy decision, redacted inputs, result, and rollback
evidence[] with source, freshness, hash, and verifier status
artifacts[] with URI, hash, media type, and role
stateDelta
campaign and channel-score deltas
memoryCandidates[] with provenance, confidence, and destination
delivery result
recovery state and next eligible action
```

Receipt rules:

- Completion requires consequence evidence appropriate to the mission.
- A narrative response is not evidence.
- Public publication requires public readback.
- A production change requires runtime and artifact readback plus a rollback address.
- A data promotion requires source, watermark, validation, and crossing evidence.
- Secrets and private recipient data are redacted before persistence.
- Actions and evidence are populated from runtime events, not inferred solely by parsing model prose.
- Terminal run state, canonical receipt blob/hash, and every initial outbox row commit in one SQLite transaction.
- `receipt.json` is written by atomic rename from that committed blob. Startup reconciliation regenerates a missing or hash-mismatched filesystem projection from SQLite before delivery continues.
- Audit-feed projection and semantic-memory promotion are separate destination-aware outbox deliveries with independent acknowledgements, retry state, and idempotency keys.
- A feed projection preserves the run's actual failure, denial, rollback, verifier, and semantic statuses; no consumer may coerce every delivered Worker run to `COLLECTED` or another success-like state.
- Feed paths and destinations are derived from the resolved runtime owner and `feedsBrains`, never from a hard-coded Jerry path.
- Only receipt-declared, verified `memoryCandidates` are eligible for semantic-memory promotion. General receipt text and raw transcripts are not ingested as memory.

## Memory model

ShakedownJerry has two kinds of memory:

1. **Worker operational memory** — campaigns, opportunities, previous actions, channel scores, failures, cooldowns, and next moves in its workspace.
2. **Jerry semantic memory** — Jerry/Garcia/Shakedown knowledge retrieved through Jerry's existing brain with source and freshness evidence.

ShakedownJerry does not create a new graph engine or duplicate Jerry's corpus.

Promotion rules:

- verified operational lessons and sourced domain facts explicitly emitted as `memoryCandidates` may be promoted automatically under the standing grant;
- unverified hypotheses remain worker-local;
- raw transcripts never promote automatically;
- private, personal, health, credential, account, or unrelated Jerry-brain context is unavailable to Shakedown retrieval and may never be externalized;
- public content must cite or trace to public-safe source evidence even when Jerry's brain supplied the discovery cue;
- corrections and later evidence supersede rather than delete prior records;
- every promoted item points back to a worker receipt and source evidence;
- owner-brain retrieval and promotion failures degrade that step but do not erase worker operational state.

## ShakedownJerry mission and ethos

Mission:

> Grow qualified visitors, listeners, returning members, and paying supporters by making Shakedown Shuffle continuously more useful, surprising, discoverable, and alive.

The differentiator is a curated, updated, playable collection of Jerry Garcia performances outside the Grateful Dead, combined with deep Jerry knowledge and original context. The worker must build around that value rather than imitate a generic newsletter-growth bot.

Operating principles:

- The owned site is home; Substack, email, search, social, and communities are roads to it.
- Create something worth visiting before asking for attention.
- Lead external posts to a specific playable or useful destination.
- Give value before asking for signup or payment.
- Use accurate sourcing, provenance, and uncertainty.
- Respect artists, archivists, tapers, communities, and listeners.
- Do not fabricate scarcity, social proof, controversy, quotes, or historical certainty.
- Do not spam, astroturf, impersonate a fan, or hide automation.
- Prefer curiosity, generosity, playfulness, and musical discovery over corporate growth language.
- Measure behavior without confusing tracking events with authoritative signup, billing, or entitlement truth.

The worker's job is not to market a static archive. Its job is to keep discovering the archive in public.

## Complete Shakedown capability surface

### 1. Observe the product and audience

- Matomo traffic, route, source, campaign, and behavior readback;
- listener starts, completion/engagement signals, favorites, returns, and leads;
- Supabase Auth/profile/signup state;
- Stripe checkout, webhook, subscription, and entitlement truth;
- public route, API, audio, SEO, canonical, sitemap, feed, and tracking health;
- collection, enrichment, publishing, and service receipts;
- search/indexing demand and coverage;
- configured community and channel signals;
- content inventory, asset readiness, and broken-link/backlink opportunities.

### 2. Maintain one opportunity ledger

Normalize evidence from publishing, collection, enrichment, funnel, analytics, infrastructure, search, and channels into independent lanes with:

- opportunity ID and type;
- source evidence and freshness;
- audience and expected consequence;
- destination route;
- required capabilities;
- effort, confidence, novelty, and risk;
- campaign and cooldown relationships;
- current state and stop condition;
- outcome and learning references.

A problem in one lane cannot mark unrelated lanes unsafe. Collection activity must not block publication merely because it is active.

### 3. Improve the owned product

- create and refresh articles and newsletter mirrors;
- generate indexable show, venue, year, date, song, lineup, and lineage experiences where evidence supports them;
- produce "on this date," hidden-gem, new-addition, venue-story, and connected-history discoveries;
- improve internal linking, canonical metadata, JSON-LD, Open Graph/Twitter data, image alt text, RSS, sitemaps, and IndexNow coverage;
- strengthen `/today`, `/now`, search, discovery, account, subscribe, and return paths;
- pair editorial context with immediate playable audio;
- validate social imagery and generate or select compliant assets;
- preserve route, tracking, player, API, static-asset, auth, and entitlement contracts.

A generated route is indexable only when it has a stable canonical identity, source-backed unique value beyond a catalog row, working internal links, and a verified destination. Thin combinations remain ungenerated or `noindex`; the worker may not manufacture pages merely to increase URL count.

### 4. Operate collection and show enrichment

- preserve the existing daily sequence:
  `non-audio:daily:local` -> `non-audio:verify` -> `collection:daily:local`;
- treat `waiting_for_batch_pair` as an expected state and never force acquisition from it;
- use current reconcile, discovery, no-overwrite acquisition, validation, quarantine, enrichment, editorial-lead, release-candidate, and promotion machinery;
- promote only additive, hash-bound, validated data through typed capabilities;
- preserve source families, provenance, confidence, watermarks, and rollback snapshots;
- verify API reload and public readback after live enrichment promotion.

### 5. Publish and distribute

- build isolated owned-site candidates;
- perform snapshot-first production publication with post-cutover readback and automatic rollback;
- create, update, schedule, and publish Substack material through configured adapters;
- send to opted-in recipients through configured channels;
- publish routine social and community posts from configured Shakedown accounts;
- perform bounded, transparent community engagement;
- submit complete dynamic URL sets for indexing;
- attach unique campaign and destination UTMs;
- read back every consequential external action.

### 6. Convert and retain

- monitor landing -> listening -> return -> account -> checkout -> webhook -> entitlement;
- distinguish Matomo journey evidence from Supabase/Stripe authority;
- detect broken funnel states, abandoned checkout, pending activation, paid-access mismatch, and return opportunities;
- create and send consented, relevant recovery or return messages under the standing grant;
- shift campaigns away from a broken destination while its repair proceeds;
- never expose recipient-level private data in public artifacts or general receipts.

### 7. Learn and choose the next action

- conduct timed post-action readbacks;
- score destinations, assets, content forms, and channels;
- compare qualified visits, listening, return, signup, entitlement, and support outcomes;
- improve winners, repair inconclusive campaigns, and retire weak ones;
- preserve experiment definitions and attribution;
- generate the next opportunity from measured evidence rather than a fixed newsletter calendar.

### 8. Operate and recover

- run scoped site/API/audio/operator checks;
- repair its own stale jobs, expired locks, incomplete receipts, and transient adapter failures;
- restart only named Shakedown/Home23 services through typed capabilities;
- validate Caddy before any scoped reload;
- preserve current production artifacts and rollback paths;
- surface only material failures or hard-stop requests to Jerry;
- continue useful work in unaffected lanes.

## Missing capabilities that are included in this delivery

The following gaps are not excluded or postponed:

- real worker identity, context, tool, policy, limit, history, memory, scheduling, cancellation, and receipt enforcement;
- direct cron and event `workerRun` dispatch;
- Agency resident startup and executable worker delegation;
- a unified Shakedown opportunity and campaign ledger;
- Matomo Reporting API and route/campaign scorecards;
- reconciliation of analytics source with the tracking behavior currently served in production;
- search-demand and indexing opportunity collection;
- dynamic sitemap/IndexNow coverage for all eligible content and catalog routes;
- indexable show/venue/year/date/song/lineage generation satisfying the canonical-identity and unique-value eligibility contract above;
- configured social, community, Substack, and consented email action adapters;
- channel scoring, timed readback, and weak-campaign retirement;
- social-image inventory repair and validation;
- removal of invalid cross-lane publishing blockers;
- replacement of obsolete automation paths and prompts;
- a useful Home23 Shakedown operating surface;
- durable capture of current local-only implementation and receipts.

## Standing authority

The current generic Jerry charter treats all public posting and broad production changes as per-action approval work. ShakedownJerry requires a narrower, explicit standing grant that is versioned, inspectable, and revocable without broadening Jerry globally.

Approval of this design authorizes implementation planning only. Live/public capabilities remain disabled until the user separately activates the versioned `shakedown-jerry-standing` grant and the Shakedown operational playbook recognizes that grant as explicit production-cutover authorization for its exact targets. Once activated, that one standing grant replaces per-action approval within scope. Before activation, after revocation or expiry, or on grant-hash/signature mismatch, every live/public capability returns `require-human-authorization`; local read, analysis, test, and candidate work may continue if independently authorized.

The repository-controlled policy lives at `config/worker-authority-grants/shakedown-jerry-standing.yaml`. Activation is an authenticated operator operation that verifies the document signature, records the user approval receipt and exact grant hash in the durable runtime store, and emits an immutable activation receipt. The grant is evaluated by `AuthorityPolicy` at dispatch and again at every consequential action. Revocation is immediate for new actions and wakeups; a transaction already past production cutover may perform only mandatory verification or rollback.

Minimum grant contract:

```yaml
schema: home23.worker-authority-grant.v1
id: shakedown-jerry-standing
version: 1
principal: worker:shakedown-jerry
ownerAgent: jerry
issuedAt: <timestamp>
notBefore: <timestamp>
expiresAt: null
signatureAlgorithm: Ed25519
signingKeyId: home23-operator-primary
signature: <operator-signature-over-canonical-document>
capabilities: [<exact typed capability IDs>]
pathScopes: { read: [], write: [], sourceClone: [], gitMetadata: [], codeRelease: [], runtimeWrite: [], dataWrite: [], quarantine: [], collectionCandidate: [], collectionStash: [], artifact: [], privateRead: [], receipt: [], releaseCandidate: [], liveWebroot: [] }
serviceTargets: [jerry-api, shakedown-audio-static, caddy]
hostTargets: [www.shakedownshuffle.com]
accountTargets: [<exact account registry IDs>]
actionClasses: [<exact action classes>]
ratePolicy: <versioned policy reference>
communicationPolicy: <versioned policy reference>
hardDenies: [<non-overridable action classes>]
```

The signed repository document is immutable policy: identity, validity window, scopes, targets, policies, key ID, and signature only. Mutable authority state is a separate transactional activation record `{ grantHash, activatedAt, approvalReceipt, revokedAt, revocationReason }` in the runtime store. An action is authorized only when the policy signature and validity window are sound and an unrevoked activation record exists for that exact hash; editing the policy creates a new inactive hash.

The angle-bracket values and empty collections above show schema slots, not installable values. The installed grant contains populated effective scopes; empty placeholders are invalid. The signature covers the RFC 8785 canonical-JSON projection of every field except `signature`; the private signing key remains outside the repository in the operator credential store, and the configured public key verifies activation and every action-time evaluation. Its capability IDs must be a subset of the manifest, and its path/account/host/action scopes must be narrower than the manifest ceilings. Precedence is: non-overridable repository/data invariants and hard denies; then an active exact-scope standing grant; then generic charter defaults; then deny. A scoped grant may therefore authorize covered routine production/public operations that the generic charter normally sends to approval, but it cannot weaken no-overwrite, backup, privacy, provenance, consent, readback, rollback, or the explicit hard-stop list below. `expiresAt: null` is permitted, but revocation and hash/version replacement remain available and visible in Jerry and the dashboard.

A **configured channel** is a registry entry with a named Shakedown account and exact account ID, authenticated adapter, allowed action types, per-run and per-day limits, quiet hours, cadence/cooldowns, reply/DM policy, transparent public identity, privacy classification, authoritative readback method, and correction/deletion policy. A communications entry additionally defines consent basis, recipient-segment query, suppression/unsubscribe/bounce enforcement, and required send preflights. Recipient PII is represented to the model by opaque IDs wherever possible and is excluded from transcripts, public artifacts, and general receipts. Email sends are irreversible: rollback means suppression of unsent work plus a correction/follow-up procedure when justified, never a claim that delivery was undone.

The implementation must inventory the channels currently accessible to the operator and produce a non-empty registry. Substack and at least one non-Substack public distribution channel are required for completion. Every admitted account must pass adapter contract, preflight, safe live canary, and authoritative readback tests before the system can claim that channel operational; an unavailable channel opens only its own circuit. Terms such as routine, bounded, configured, and consented mean the concrete limits and policies in this signed grant and registry, not model judgment.

### Authorized once the standing grant is active

- observation, analysis, opportunity scoring, and local receipts;
- local additive content, assets, candidates, packets, drafts, and enrichment;
- routine owned-site publication through the snapshot/test/readback/rollback capability;
- configured Substack publication and opted-in email distribution;
- configured social and community publication and engagement;
- indexing submission and UTM creation;
- bounded frontend, content, metadata, internal-linking, and SEO changes that preserve public contracts;
- import of tested code to a dedicated canonical ref and snapshot/test/deploy/readback/rollback of named Shakedown backend or operational executors, without modifying the user's active checkout;
- additive collection and enrichment promotion through existing no-overwrite machinery;
- scoped named-service restart or reload required by an otherwise authorized promotion;
- automatic retries, verification, corrections, campaign changes, and rollback;
- verified memory and channel-learning promotion.

Machine preconditions are not recurring human gates. After the standing grant is activated, an in-scope action proceeds only when its named current verifier and every applicable machine precondition pass.

### Hard stop or explicit human authorization

- deletion, replacement, or destructive merge of canonical show, audio, catalog, subscriber, receipt, or source data;
- direct or untyped writes to production databases;
- database schema, Auth, payment, entitlement, credential, account-ownership, DNS-account, or billing changes;
- spending money or starting paid advertising;
- bulk unsolicited messaging, purchased lists, or private-data export;
- legal, rights, takedown, or identity claims requiring the owner's judgment;
- weakening backups, provenance, watermark, validation, privacy, rollback, or no-overwrite controls;
- broad changes outside Shakedown and the repaired generic Worker runtime.

A hard stop blocks only the requested action and affected target. ShakedownJerry records it, informs Jerry when useful, and continues another authorized task.

Billing acceptance does not weaken this boundary. Automated and Stripe/Supabase sandbox coverage is labeled non-production. A fresh live charge, refund, subscription cancellation, entitlement mutation, or test-identity cleanup requires a separate, exact hard-stop authorization naming the owned test identity, maximum amount, operations, expiry, and cleanup plan. That bounded canary authorization is independent of the standing growth grant. Existing production transactions may provide read-only observational evidence, but sandbox success alone never proves the production billing path.

### Existing gate migration

The system distinguishes automatic correctness checks from human permission gates:

- Build, source, consent, provenance, privacy, freshness, watermark, readback, and rollback checks remain mandatory machine preconditions.
- Per-action human approval flags for operations covered by the standing grant are removed from the effective execution path.
- Standing authority never converts a failing machine precondition into `allow`. Until a named, versioned migration receipt proves an equivalent replacement, live Substack actions require queue-matched activation/readiness evidence, `status=ready-for-unattended-promotion`, and `automationPromotionPlan.applyAllowed=true`; communications require current consent, suppression, bounce/unsubscribe, and `outboundSendAllowed=true`; collection/enrichment promotion requires current watermark, paired-batch, validation, and readiness evidence. Historical, stale, or mismatched receipts never satisfy these gates.
- A migration may replace an obsolete approval-shaped field only after equivalence tests prove the new deterministic verifier protects the same invariant, the standing grant names the replacement, and the receipt records the supersession. It may remove repeated human permission inside the signed scope; it may not remove correctness evidence.
- Current communications scripts remain non-sending readers. A separate typed consented-send capability is installed and proven rather than silently flipping a broad `outboundSendAllowed` flag.
- Collection, publishing, analytics, enrichment, and communications calculate readiness independently; one lane cannot fail another lane's authority check merely by being active.
- A machine-precondition failure causes repair, rollback, or lane-specific circuit behavior—not an indefinite human review queue.

## Typed Shakedown capabilities

The implementation will expose typed actions rather than arbitrary production shell access. Each capability has fixed targets, arguments, preconditions, timeouts, receipts, verifiers, and rollback behavior.

Required capability families:

- `shakedown.observe` — operator, analytics, funnel, listener, search, receipt, route, and health readbacks;
- `shakedown.content.prepare` — inventory, generation, validation, assets, candidates, feeds, sitemaps, and UTMs;
- `shakedown.site.publish` — build, release snapshot, candidate overlay, cutover, smoke, and rollback;
- `shakedown.code.integrate` — import an exact tested worker-clone commit into a dedicated canonical repository ref without changing the user's active branch, index, or worktree;
- `shakedown.backend.deploy` — build/test a pinned backend or operational-code release, snapshot current service/runtime configuration, cut over the named executor to that release, restart, read back, and restore the exact predecessor on failure;
- `shakedown.distribute.substack` — preflight, draft, publish/update, send, and readback;
- `shakedown.distribute.channel` — configured social/community action and readback;
- `shakedown.communications.consented` — private candidate, send, and outcome readback for opted-in recipients;
- `shakedown.collection.local` — reconcile, discover, verify, acquire, convert, quarantine, and candidate build;
- `shakedown.collection.promote-additive` — validated release promotion and rollback;
- `shakedown.enrichment` — local enrichment, verification, live promotion, API reload, and readback;
- `shakedown.indexing` — sitemap and complete IndexNow submission;
- `shakedown.runtime.reload-scoped` — named PM2/Caddy actions with pre/post checks;
- `shakedown.rollback` — restore the exact recorded release/data/runtime predecessor and verify it.

`shakedown.runtime.reload-scoped` never counts as code deployment. Backend and operational-script changes remain candidate-only until `shakedown.code.integrate` and, where runtime code changes, `shakedown.backend.deploy` complete. The deployment capability executes from immutable release material under `releases/code`, never from the dirty active checkout, and journals `prepared -> snapshotted -> built -> tested -> cutover -> restarted -> verifying -> committed | rolling_back -> rolled_back` with the finite safety reserve.

## Data and website protection

Protection is structural and automatic, not a blanket read-only posture.

### Repository and runtime preservation

- Record the exact Home23 and Shakedown branch, commit, worktree status, untracked inventory, and relevant runtime state before edits.
- Preserve the user's modified and untracked files; never reset, clean, or overwrite them.
- Create a content-addressed code/config preservation set for tracked, untracked, and relevant ignored local-only Shakedown implementation. Its manifest records path, mode, size, hash, source worktree/commit, and exclusion reason; a secret/credential scan must pass before the set is stored with source artifacts.
- Preserve private receipts and mutable runtime state in a separate permission-restricted archive, never in the source archive or git. Its redacted manifest records hashes and restoration order without recipient PII or secrets; archive permissions and encryption-at-rest availability are recorded.
- Restore both preservation sets into fresh temporary destinations and verify hashes plus representative startup/readback before integration begins. An archive that was merely created but not restored is not a proven recovery point.
- Keep runtime secrets and private data out of commits and design artifacts.
- Maintain backward-readable Worker state and receipts throughout migration.

### Shakedown production publication

- Treat the user's active Shakedown checkout as read-only. Create or refresh an independent worker-owned clone pinned to a receipt-recorded commit for source-changing campaigns, and never reset, clean, or reuse the user's dirty checkout.
- Build only from the pinned worker clone's `shakedown-v2`, with a run-specific output directory. Never write shared `shakedown-v2/dist`; it is a public artifact served at `v2.shakedownshuffle.com`.
- Never edit `html` during normal feature work.
- Create a timestamped pre-cutover snapshot and production candidate.
- Overlay the built candidate while preserving `html/pro`, `env-config.js`, and live-only artifacts.
- Execute the complete current Shakedown `AGENTS.md` public-contract matrix: every listed route including `/start` and `/newsletter`; every listed API and static path; `window.ENV_CONFIG`; every tracking global; player globals and `jerry:player`; signed-out and signed-in entitlement behavior; mobile layouts; and an injected tracker failure proving analytics cannot block load, navigation, or playback.
- Hash-verify `html/pro`, `env-config.js`, and every allowlisted live-only artifact before and after cutover. Verify canonical host redirects and prove `v2.shakedownshuffle.com` is unchanged unless the active grant explicitly includes it.
- Automatically restore the recorded pre-cutover snapshot if required smoke checks fail.
- Record the exact candidate, predecessor, build commit, checks, and rollback command.
- Exercise rollback by injecting a verifier failure against a byte-equivalent or independently known-good candidate. The proof never deliberately publishes broken content.

### Collection and data promotion

- Preserve no-overwrite acquisition, paired-batch, quarantine, hash, watermark, source-family, and readiness contracts.
- Prefer additive candidates and atomic pointer changes.
- Take and verify rollback snapshots before promotion.
- Never infer data absence or readiness from a single route or wrapper timestamp.
- Treat Supabase Auth/profile, Stripe webhook/subscription, and entitlement state as conversion truth.
- Give analytics readers the minimum read authority required; do not give the growth worker direct billing or entitlement write access.

## Existing assets retained rather than rewritten

The worker orchestrates and strengthens current deterministic machinery:

- Home23 editorial Markdown, article inventory, editorial queue, newsletter source receipts, and Jerry brain;
- article/newsletter generators and current publishing pipeline;
- Substack local, Chrome, and Safari adapters after contract reconciliation;
- listener, subscriber-funnel, communications, and operator readbacks;
- Jerry Collection reconcile/discovery/acquisition/release/operator workflows;
- show-enrichment source policy, schemas, normalization, curation, note generation, and live promotion;
- Shakedown watchdog, PM2, Caddy, and release snapshot procedures;
- existing tracking globals, routes, API paths, player globals/events, runtime config, and static assets.

Archived root-web implementations and stale deployment scripts never become authority.

## Legacy knowledge absorption

The old OpenClaw Shakedown runtime is not revived. Its useful material is imported with provenance and current-state reconciliation:

- Shakedown `SOUL.md`, `AGENTS.md`, and draft template;
- `THE_NORTH_STAR.md` and launch playbook;
- research, reviews, drafts, issue versions, contacts, and image-prompt banks;
- relevant Codex automation prompts, receipts, and learned failure modes.

Stale pricing, paths, metrics, publishing assumptions, and runtime claims are not promoted as current truth without verification.

## Codex automation absorption and cutover

Existing Shakedown Codex automations are inputs to migration, not permanent parallel operators.

Before implementation planning can close, it must produce a versioned migration matrix with one row for every Codex automation ID and duplicate definition, Home23 cron, launchd job, PM2-backed executor, and deterministic loop in scope. Each row records current status, schedule, project root, authority, receipts, target worker trigger/capability or retained independent role, shared lock, live replacement proof, cutover/pause point, and rollback action. Unmapped jobs are a release blocker, not an implicit deletion.

Known dispositions that the matrix must preserve unless fresh evidence proves a safer exact replacement:

- the 120-second Shakedown watchdog remains the deterministic `jerry-api` recovery executor; ShakedownJerry calls its typed core through the same service lock and does not run a competing restart loop;
- `ops/dynamic-dns` remains independently governed and outside `shakedown-jerry-standing`;
- Jerry Collection Manager and its action worker remain available until Home23 has separately proven parity for their evidence and action consequences, after which the matrix may pause their duplicate scheduling without deleting their definitions or receipts.

For every logical role:

1. Inventory all duplicate definitions, prompts, schedules, project roots, status, and receipts.
2. Separate deterministic executor behavior from agent judgment.
3. Move durable judgment, identity, and selection logic into ShakedownJerry's playbook and state contracts.
4. Retain or repair the deterministic repository scripts as typed capabilities.
5. Create the equivalent Home23 `workerRun` cron or event trigger.
6. Execute one real end-to-end run that produces the intended consequence and canonical receipt.
7. Confirm the next scheduled state and restart persistence.
8. Pause the replaced Codex definitions and record the exact mapping and rollback action.

Publishing, collection, enrichment, analytics, operator upkeep, and distribution remain distinct lanes even though one worker coordinates them. No automation-state checker may classify a valid collection job as an unsafe publishing duplicate.

## Home23 user experience

No new standalone dashboard is created.

The existing Home23 surfaces will show:

- Workers roster: ShakedownJerry identity, purpose, authority posture, last run, current run, next wake, and health;
- Shakedown card: qualified visits, listening, returns, signups, paid/entitled outcomes, current campaigns, last useful action, next action, and material problems;
- Agency: one durable Shakedown growth pursuit and its consequence history;
- run detail: trigger, actions, policy decisions, evidence, artifacts, state delta, learning, rollback, and receipt;
- Jerry context: recent meaningful receipts and current state without raw transcript flooding;
- operator controls: run now, stop, retry, inspect artifact, inspect rollback, revoke grant, and explicitly authorize a hard-stop action.

Natural Jerry requests use the same worker connector:

- "What did ShakedownJerry do?"
- "Run ShakedownJerry now."
- "Focus Shakedown on new listeners this week."
- "Stop the current Shakedown run."
- "Why did it publish that?"

## Error handling

Errors are classified before recovery:

| Class | Default response |
| --- | --- |
| Transient provider/network/tool error | bounded retry with backoff |
| Missing or expired channel authentication | open only that channel's circuit; continue other lanes |
| Policy denial | no retry; record denial; select another task |
| Invalid or stale evidence | refresh evidence; do not act on the claim |
| Data contradiction or watermark failure | stop actions against that data target; preserve evidence; continue unrelated work |
| Build or preflight failure | do not cut over; repair or choose another task |
| Post-cutover verifier failure | automatic rollback and verification |
| Rollback failure | stop the affected target and create an urgent Jerry-visible operator item |
| Worker crash or harness restart | reconcile run/idempotency state and resume or close with a receipt |
| Consequential action with uncertain outcome | stop retries for that action, perform authoritative readback, and mark `reconciliation_required` until resolved |
| No useful opportunity | write a no-change receipt with evidence and wait; do not manufacture content |

Failures never disappear into narrative logs. They update worker state, campaign beliefs, and the canonical receipt.

## Testing strategy

### Generic Worker runtime tests

- manifest schema, compatibility translation, unknown-field, and contradictory-policy tests;
- immutable execution-profile, worker-specific loop/context/history/registry, manifest-refresh boundary, system prompt, identity-file, workspace, history-mode, provider, and model tests;
- prompt realpath/symlink/hash confinement, concrete provider/model pinning across retry, and persistent-history concurrency rejection/lease tests;
- tool inclusion and exclusion tests;
- `CapabilityExecutor` pre-side-effect journal, direct-registry/nested-adapter bypass denial, structured terminal event, and reconciliation tests;
- path traversal, symlink escape, absolute-path, shell bypass, network-host, and secret-redaction denial tests;
- cumulative prompt/completion/retry token accounting, estimation fallback, runtime, tool-call, artifact, retry, trigger-narrowing, and deadline enforcement tests;
- per-worker concurrency and shared-resource lock tests;
- cancellation during model and tool phases plus persisted finite safety-reserve completion/exhaustion for post-cutover verification and rollback;
- durable request-before-start, lease expiry/reclaim, idempotency-result, cron occurrence capture, event replay cursor, retry, and restart dispatch tests;
- structured action/evidence/artifact/memory receipt tests;
- canonical receipt, destination-aware outbox acknowledgement/retry, status-preserving feed projection, and verified-candidate-only semantic-memory tests;
- `feedsBrains`, `visibleTo`, scoped owner-brain principal, owner isolation, and memory-promotion tests;
- fail-closed credential-authority, scoped-principal ownership derivation, wrong-harness claim, and body-spoof denial tests for Agency, Good Life, Live Problems, CLI, API, Jerry-tool, cron, event, and dashboard connectors;
- event routing, debounce, correlation/causation loop suppression, and replay tests;
- scheduler semantic consequence and no-consequence tests;
- version-one worker and receipt compatibility tests;
- current systems, freshness, memory, parity, release, and feeder worker regression tests;
- Agency startup and executable-dispatch regression tests.

### Shakedown capability tests

- content-addressed source/config preservation, restricted private/runtime archive, secret/PII exclusion, and clean-destination restoration tests;
- independent source-clone confinement, exact-commit import, dedicated-ref-only Git integration, active checkout invariance, and no-external-push tests;
- backend/operational immutable-release build, test, cutover, restart/readback, crash recovery, and predecessor rollback tests;
- opportunity normalization and cross-lane isolation;
- Matomo, listener, Supabase, Stripe, entitlement, and operator readbacks with redaction;
- content/frontmatter, canonical, JSON-LD, Open Graph, RSS, sitemap, IndexNow, and asset validation;
- show/venue/year/date/song/lineage generation using real representative catalog records;
- owned-site candidate build and route/player/auth/tracking contract tests;
- pre-cutover snapshot, successful cutover, failed-smoke rollback, and rollback readback tests;
- Substack and configured-channel preflight, publish, send, and public readback tests;
- consent and recipient privacy enforcement;
- controlled signup, authentication, checkout, webhook, subscription, entitlement, cancellation/refund, and test-identity cleanup coverage in sandbox, explicitly labeled non-production;
- collection paired-batch, no-overwrite, quarantine, additive promotion, and rollback tests;
- show-enrichment provenance, confidence, API reload, and public-readback tests;
- campaign attribution, timed readback, scoring, and retirement tests;
- funnel contradiction and broken-destination campaign-shift tests;
- deliberately denied canonical deletion, database write, credential, spend, and bulk-message attempts.

Acceptance maintains a required-capability coverage matrix. Every required capability family and every configured account adapter receives automated contract proof and one safe live canary/readback. Collection promotion and enrichment promotion are separate proofs. Search-demand ingestion, indexing submission, generated-route coverage, social-image repair, campaign retirement, consent suppression, and correction handling each require their own receipt. Any excluded adapter or content class must be an explicit user-approved non-goal, never an unexplained or "where appropriate" remainder.

### Live proof

Automated tests are necessary but not sufficient. Completion requires fresh receipts proving:

1. An existing worker runs with its declared identity, workspace, tools, limits, history, and receipt routing.
2. Two different Jerry-owned workers can run without the old owner-wide lock while shared resource limits still hold.
3. A scheduled `workerRun` survives restart and executes exactly once.
4. An event-triggered `workerRun` executes exactly once and attaches its consequence to the Shakedown pursuit.
5. ShakedownJerry reads current traffic/listening/funnel evidence and chooses a supported action.
6. ShakedownJerry builds from its isolated pinned clone, publishes, executes the complete public-contract matrix, and reads back one bounded owned-site improvement through the production capability without changing shared `dist`, `html/pro`, `env-config.js`, or `v2.shakedownshuffle.com`.
7. An exact tested clone commit is imported to a dedicated canonical ref without changing the active checkout, and one harmless backend/operational canary is deployed from an immutable code release with PM2/runtime readback and verified predecessor rollback.
8. Every configured account adapter, including Substack and at least one non-Substack public channel, completes its safe live canary and authoritative readback; the consented-communications adapter proves suppression with an owned, consented test recipient and authoritative delivery readback.
9. One additive collection promotion and one separate enrichment promotion complete with source, watermark, validation, API/runtime, public-readback, and rollback evidence.
10. Under a separate exact hard-stop canary authorization, an owned controlled identity completes the production signup, checkout, webhook, and entitlement transition; any live charge/refund, cancellation, and cleanup are bounded and receipt-backed. Sandbox receipts remain supporting evidence only, and browser events are not accepted as transaction proof.
11. One campaign is measured through UTM, behavior, and authoritative conversion evidence and updates its channel score.
12. A deliberately attempted destructive website/data action is denied before side effects.
13. Search-demand ingestion, eligible generated-route coverage, social-image repair, complete indexing submission, and campaign retirement each produce verified consequence receipts.
14. An injected post-cutover verifier failure against a byte-equivalent or independently known-good candidate triggers automatic rollback and verified restoration, including restart during the rollback journal.
15. Standing-grant activation enables covered live actions without per-action approval; revocation and grant-hash mismatch immediately prevent new live actions while preserving mandatory verification/rollback.
16. Jerry can explain the worker's action, evidence, learning, and next move from structured context.

## Migration and release sequence

This order manages dependencies; it does not define separately shippable product versions.

1. Preserve Home23 and Shakedown repository/runtime state and hash-inventory local-only capabilities.
2. Add failing tests for every current Worker enforcement defect and backward-compatibility requirement.
3. Implement the worker manifest, execution runtime, policy enforcer, state store, lifecycle, queue, and version-two receipts.
4. Converge Jerry tools, CLI, API, cron, events, Agency, Good Life, Live Problems, and dashboard on the Worker Connector.
5. Repair Agency resident startup and executable delegation.
6. Prove existing workers and state survive the migration.
7. Create Shakedown typed capabilities and reconcile existing deterministic executors.
8. Create the ShakedownJerry identity, playbook, state schemas, standing grant, and pursuit.
9. Implement the missing opportunity, analytics, search/indexing, site-generation, distribution, scoring, and dashboard seams.
10. Absorb legacy OpenClaw knowledge and Codex automation logic with provenance.
11. Run the complete automated test matrix.
12. Deploy the repaired Home23 runtime with scoped restarts and verify Jerry/Forrest and current workers.
13. Ask the user to activate the exact signed standing-grant hash after its contract tests, channel registry, machine gates, snapshots, and rollback paths are verified.
14. Execute the complete Shakedown live-proof matrix with production snapshots and rollback ready.
15. Cut over schedules and pause replaced Codex automations after their corresponding live consequence receipts exist.
16. Verify restart/resurrection, next scheduled runs, dashboard truth, Jerry explanation, and rollback addresses.

No step may delete user-owned state or disable a current automation before its replacement has produced the required real receipt.

## Completion contract

The work is complete only when all of the following are true:

- every Worker manifest field has tested runtime meaning;
- every dispatch surface uses the canonical Worker Connector and queue;
- no permanent Shakedown scheduled-agent-turn workaround exists;
- existing workers, receipts, and brain feeds remain usable;
- cancellation, retry, idempotency, concurrency, restart recovery, and memory promotion work;
- authority is enforced at the action boundary and cannot be bypassed through shell, files, browser, or alternate dispatch;
- the signed standing grant was separately activated, can be revoked immediately, and is the explicit operational authorization for its exact live/public targets;
- ShakedownJerry has durable identity, state, schedules, events, owner-brain access, receipts, and dashboard visibility;
- the complete Shakedown observe -> discover -> improve -> publish -> distribute -> convert -> learn -> recover loop has live evidence;
- routine authorized public and reversible production actions proceed without per-action human approval;
- destructive website/data/account/payment actions are denied unless explicitly authorized;
- one blocked capability cannot freeze unrelated lanes;
- Codex automation responsibilities are mapped and replaced definitions are paused with rollback instructions;
- current local-only Shakedown capabilities are preserved durably;
- Shakedown source changes live on an imported canonical ref, production code runs from immutable receipt-addressed releases, and the user's active checkout remains unchanged;
- production publication, data promotion, denial, rollback, and restart/resurrection are all receipt-proven;
- Jerry can accurately report what ShakedownJerry did, why, with what evidence, what changed, and what comes next.

Until every item is satisfied, the system is accurately described as under implementation. Passing an isolated test suite, creating the worker directory, producing drafts, or showing a dashboard card is not completion.

## Explicit non-goals

These are exclusions, not postponed parts of the approved product:

- a third full Home23 agent or independent Shakedown graph brain;
- a separate Shakedown conversation the user must manage;
- a separate Worker dashboard or another control plane;
- a new CMS replacing the existing Markdown and repository authorities;
- destructive cleanup of historical workers, receipts, automations, content, or collection data;
- unrelated Home23, Forrest, health, forecasting, or non-Shakedown website refactors;
- paid advertising, purchased audiences, bulk unsolicited outreach, or hidden/impersonated community activity.

## Review decision

Approval of this file authorizes creation of one complete implementation plan covering the generic Worker runtime repair and ShakedownJerry production system together. The plan may sequence work by dependency and test boundaries, but it may not redefine any required section above as optional or omit it into an unowned parking lot.
