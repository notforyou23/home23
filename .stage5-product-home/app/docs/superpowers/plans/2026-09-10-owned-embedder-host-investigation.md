# Owned embedder — Host investigation

Date: 2026-09-10  
Status: investigation and Host-side contract draft only. No Host, Apple, packaging, Encoder, or Memory product implementation.  
Worker: Host  
Plan of record: [2026-09-10-owned-embedder-host-integration.md](./2026-09-10-owned-embedder-host-integration.md) at `3c7495d6dd5b424a7e17307364b1b5a26586e49a`. That plan supersedes conflicting statements in the original embedder spec.

This file is Host’s working record of current architecture, future file claims, and contract needs. It does not select a default encoder, download a model, or change any home.

Preserved invariants: one shared home-birth operation, resident authority, memory scopes, and immutable Seed history. Host must not invent a second birth path.

---

## 1. Plan stages and files Host will own

Host’s product work is **stage 4** (Host and native setup), plus packaging/delivery seams in **stages 5 and 7**. Stages 1–3 belong to Encoder (and Memory for consumer contracts). Stage 6 is an existing-home transition and is out of the first new-home milestone.

| Stage | Host role | Depends on |
|---|---|---|
| 1. Compatibility experiment | Observe only. Do not implement Host defaults from speculation. | Encoder evidence |
| 2. Encoder-aware contracts | Consume published Host-facing fields once Encoder/Memory publish them. | Encoder/Memory contracts |
| 3. Owned inference service | Do not implement the service. Host will start/stop/supervise whatever Encoder ships. | Encoder service + recipe |
| 4. Host and native setup | Own. Private process/port, durable progress, native status/retry, source-setup parity. | Stages 1–3 |
| 5. New-home semantic milestone | Own isolated Host create/start/stop and packaging integration of the owned default. Do not touch existing homes. | Stages 1–4 |
| 6. Existing-home transition | Later. Newer Host must not silently require the embedder on an old home. | Explicit upgrade (D08) |
| 7. Release delivery | Own Host/runtime signing order and owner-facing setup/recovery copy with D02/D09. | Reviewed artifacts |

### Exact paths from the plan (Host claim later)

Apple paths are relative to `home23-apple`. All others are backend `home23`.

**Backend lifecycle (exclusive Host claim later)**

- `cli/lib/product-host.js`
- `cli/lib/product-environment.js`
- `cli/lib/product-memory.js`
- `scripts/product/host.mjs`

**Shared birth / source setup (Host orchestrates around; does not replace)**

- `cli/lib/create-home.js` — call the existing operation; keep it free of service startup and model downloads
- `cli/lib/seed-birth.js` — do not add downloads, inference, or process start
- `cli/lib/setup.js` — source-setup parity: Host-equivalent semantic preparation around birth, not a second birth
- `cli/lib/init.js` — remove user-facing Ollama/manual embedding install as the ordinary path; Host/source setup prepare the owned encoder

**Native Host (Apple exclusive claim later)**

- `Home23Host/HostCommand.swift`
- `Home23Host/HostModel.swift`
- `Home23Host/Home23HostApp.swift`
- `Home23Host/Tests/HostCommandTests.swift` (coverage named by the plan)
- `scripts/build-home23-host.mjs` (Apple Host packaging; not listed in the plan table but is the current assembler)

**Packaging (Host claim later, coordinated with Encoder artifacts)**

- `scripts/product/package.mjs`
- `cli/lib/product-payload.js`
- `scripts/product/runtime-tools/package.json` and `package-lock.json`
- `scripts/product/verify-install.mjs`
- `tests/cli/product-host.test.js`
- `tests/cli/product-memory.test.js`
- `tests/cli/product-package.test.js`
- `tests/cli/product-payload.test.js`

**Seams Host will use but must not exclusively claim**

| Path | Why it is shared |
|---|---|
| `cli/lib/generate-ecosystem.js` | Plan lists it under Configuration. Encoder owns recipe/env defaults; Host admits a subset into `runtime/ecosystem.config.json`. |
| `shared/seed-embedding-config.cjs` | Encoder/Memory configuration. Host reads it today via `product-memory.js`. |
| `substrate/bin/organ-probes.ts` | Consumes Host’s submitted process plan. Seed/organ inventory, not a Host UI file. |
| `engine/src/live-problems/seed.js` | Host-scoped default monitors. Not an Encoder/Memory file, but not in the plan’s Host file list. Coordinate before changing. |
| `scripts/embedder/` (proposed) | Encoder. Host starts the resulting process; does not author the service. |
| Substrate / attention / engine retrieval files | Encoder and Memory. Host must not edit them. |

---

## 2. Current native Mac setup, lifecycle, progress, recovery, and packaging

Observed in maintained sources at backend `44288211b` and Apple `215241f6f6`. The September 9 Host product work in `home23-host-product` (`07b6d4a8`) and `home23-apple-host-product` (`9fffddd`) is already in this Host-file lineage; those worktrees were left untouched.

### Native setup UX today

Home23 Host (`com.home23.host`) is a separate Mac companion. It is not App Sandboxed. The everyday home is `~/Library/Application Support/Home23 Host/Home`. Development builds may pass `--home-root` and `--payload` for isolated acceptance; ordinary builds ignore those arguments.

The owner fills name, resident, purpose, optional folders, and a chat provider. Create runs `install` (if absent) → `create` → `start`. The GUI already says Host does not install a local embedding service. For `ollama-local` it asks the owner to enter a model already present in their Ollama installation. That copy is the current Memory Lite gap the plan exists to close.

Users must not be asked to operate PM2 or install embedding dependencies. That is already the Host product rule for Node/PM2; it is not yet true for embeddings.

### Backend protocol

`scripts/product/host.mjs` accepts one action and an absolute `--home`. Actions: `status`, `catalog`, `install`, `create`, `start`, `stop`. One JSON object on stdout. Credentials only on create stdin. Diagnostic progress is intended for stderr; the native decoder currently ignores stderr.

State file: `<homeRoot>/.home23-host.json`, schema `home23.host.v1`. Phases: `creating` → `prepared` → `starting` / `stopped`. `desiredRunning` is the durable start/stop intent. Open-at-login resumes only when `desiredRunning` is true.

Lifecycle lock: `<homeRoot>/runtime/.host.lock`, stale 180s. Create and start hold this lock for the whole command. A multi-minute model fetch cannot live inside those commands without a separate durable operation.

### Process supervision (already private; not a user tool)

Each home has a private PM2 under `<homeRoot>/runtime/pm2` and short sockets under `/tmp/h23-<uid>-<hash>`. `productEnvironment()` sets `HOME23_PRODUCT_HOST=true`, a private `HOME`, and a PATH that includes bundled Node and the private PM2 binary. The owner never sees PM2 if Host works.

`ownedProcessNames(resident)` is a hard allowlist:

`home23-coordination`, `home23-${name}`, `home23-${name}-dash`, `home23-${name}-harness`, `home23-${name}-seed`, `home23-${name}-shipper`, `home23-seed-observatory`, `home23-evobrew`

Start writes that subset to `runtime/ecosystem.config.json` via `productDefinitions()`. Optional generator apps (Chrome CDP, MCP, house-sense, watchdog) are not admitted. Stop writes `desiredRunning: false` first, then stops only those owned names. Unexpected processes abort the action.

There is no embedder process and no embedder port.

### Ports

`PORT_KEYS` today: `coordination`, `engine`, `dashboard`, `mcp`, `bridge`, `evobrew`, `observatory`. Values are random loopback ports in 20000–60999. `validatePortPlan()` rejects any other shape. Adding a key without versioning would make every existing Host home unreadable.

### Readiness vs memory

`probeReadiness()` requires every owned process online and owned, Core capabilities + Host pairing, signed resident availability, and health of engine, dashboard, observatory, and evobrew. PM2 `online` is not sufficient for `ready`, but it is necessary.

`inspectProductMemory()` is a separate warning channel. For `ollama-local` it probes `/api/tags` only. Comments and tests already state that a listing is not a successful embed. Status values: `unconfigured`, `not_detected`, `model_detected`, `configured_unverified`. Seed contact uses the same tag probe against `shared/seed-embedding-config.cjs`.

`ready` can be true while semantic search is absent (Memory Lite). Native Host shows those warnings on the ready card, not as a hard stop.

### Birth

`seedAndCreate()` copies example config, writes ports, optionally copies an `ollama-local` chat `baseUrl` onto both `home.embeddings.providers` and `home.substrate.embedding` as `nomic-embed-text` / `/api/embeddings`, stores the API key, then calls `createHome()`. That is the shared birth. `createHome()` / `prepareSeedBirth()` prepare files only: no package install, no model call, no PM2, `modelInvocations: 0`, `runtimeStarted: false`. Genesis is a local checkpoint, not contact.

Host must keep calling this operation. Semantic preparation belongs around it, not inside it, unless Encoder’s inventory proves meaningful contact happens during preparation (plan prerequisite). Current birth code does not emit contact events.

### Chat provider vs embeddings (current coupling)

Selecting `ollama-local` plus a custom `baseUrl` currently points embeddings at that same server. The plan requires decoupling chat-provider base URL from automatic embedding selection. Paid-provider Host setups leave embeddings unconfigured and warn.

### Recovery today

| Failure | Current behavior |
|---|---|
| Interrupted install | Payload copy lock + receipt; `verify-install --resume-install` only before a resident exists |
| Interrupted create | `phase: creating` + birth journal; same profile resumes; different profile refused |
| Start process error | `desiredRunning` stays true; status `degraded`; native “Start home” / “Check status” |
| Host session invalid | `host_session_recovery_required`; Start re-pairs; other devices untouched |
| Stop | Home and Seed retained; processes stopped; `desiredRunning: false` |
| Newer companion | Dispatches the **installed** runtime, not the bundled one. No silent upgrade |

There is no durable semantic-preparation handle, no download resume, and no Retry/Resume that is specific to encoder artifacts.

### Native progress surfaces

Apple `HostAction` timeouts: install 600s, create 300s, start 180s, status/catalog 45s. `HostReply` decodes `ok`, `status`, `homeRoot`, `connection`, `providers`, `error`/`message`, `profile`, `desiredRunning`, `readiness.issues/warnings`, and named process/state pairs only. It does not decode a progress handle, percent, phase, checksum, or semantic-readiness object.

`HostModel` operation strings: “Checking your home…”, “Preparing the runtime…”, “Creating your resident and Seed…”, “Starting your home…”, “Resuming your home…”. Starting polls status every 5s. An active window polls every 30s. Scene activation must not wipe an unclaimed setup draft (`shouldAutomaticallyInspect`).

Statuses the GUI already maps include `absent`, `installed`, `creating` / `preparing` / `incomplete`, `prepared`, `starting`, `ready` / `running`, `stopped`, `degraded` / `failed`. Backend does not currently emit `preparing` as a semantic-download phase.

Logs: Host process stderr is discarded by the native runner except for overflow detection. Support logs live under the home’s `runtime/pm2` and per-action verify-install `*.log` files. The Services disclosure shows `name: state` only.

### Packaging / delivery today

`scripts/product/package.mjs` builds a machine-specific payload: official Node 22 (no Homebrew dylibs), archived Git source, `npm ci` on app/engine/evobrew/runtime-tools, `scripts/release/build.mjs`, then load-checks `better-sqlite3`, `hnswlib-node` (root and engine), `node-pty`, and `tsx` with the distributed Node. Manifest schema `home23.product-payload.v1` is an integrity inventory, not a publisher signature. Required files include `bin/node`, `app/scripts/product/host.mjs`, and `tools/node_modules/pm2/bin/pm2`.

`installProductPayload()` copies into a new owned root, refuses overwrite/adoption of a different package, and writes `.home23-install.json`. Mutable config and `instances/` stay under `app/`. Model weights are not part of the payload.

Apple `scripts/build-home23-host.mjs` copies that payload to `Contents/Resources/Home23Runtime`, verifies it with bundled Node, and applies an ad-hoc hardened `codesign --options runtime`. Public Developer ID + notarization remain D02 work. Host is not sandboxed; the conversation client is a different identity.

`scripts/product/verify-install.mjs` creates a **new** output directory, installs, creates resident `milo`, points embeddings at a local fixture (synthetic 768-vectors + `/api/tags`), starts, pairs, chats, stops, restarts. It never reuses another home. Fixture embeddings are not real inference.

Source `cli/lib/init.js` still warns: install Ollama and `ollama pull nomic-embed-text`. That is a user-facing dependency path the plan forbids for ordinary setup.

---

## 3. How an owned embedder process would start, supervise, recover, and tear down

Design target: the owner uses Home23 Host only. No PM2 commands, no `npm`/`pip`, no `ollama pull`, no manual model files.

Proposed Host-owned lifecycle (implementation blocked until Encoder contracts and experiment evidence):

1. **Install payload** — existing `install`. Reserve encoder port and empty encoder config in Host state **without** downloading. Version the port plan so old homes remain inspectable.
2. **Birth** — existing `createHome` / `prepareSeedBirth`. Contact writers stay stopped. Do not fetch models here.
3. **Semantic preparation (new durable operation)** — Host-owned handle, persisted under the home (not the GUI home directory). States at least: `downloading`, `verifying`, `warming`, `ready`, `interrupted`, `failed`. Begin/resume returns the handle immediately. Status reads disk. A long download must outlive the native command and the 180s host lock.
4. **Start owned inference** — admit one process from the submitted plan on the reserved loopback port. Bind `127.0.0.1`. Environment selects the per-home model directory explicitly. Reconcile any surviving worker before starting another. Supervisor remains the existing private PM2; it stays an implementation detail.
5. **Warm-up gate** — Encoder health must prove actual inference, expected recipe, finite output, and dimension. `/api/tags` and PM2 `online` are insufficient. Only then admit Seed/harness/shipper writers that can emit contact.
6. **Ready split** — report resident availability and semantic readiness as separate facts. Document ingestion completion is a third fact (existing pipeline; Host reports outcome, does not merge memory scopes).
7. **Stop / teardown** — Stop still means stopped. Tear down only that home’s processes, embedder last or in reverse admission order, preserve `desiredRunning`, never start a duplicate Seed runner. Do not delete model artifacts on ordinary stop.
8. **Later outage** — running home keeps existing nonblocking vector-absent behavior and attention fallback, but Host must report the degraded capability. Restoring the encoder must not backfill immutable contact history.
9. **Old homes** — a newer Host that knows about embedders must not mark an un-upgraded home missing-service. Requirements are selected by an explicit upgrade, not by expanding `ownedProcessNames()` unconditionally.

Source-setup parity: `setup.js` / `init.js` orchestrate the same preparation around `createHome`. They may print Host-equivalent status. They must not document PM2 or manual embedding installs as the product path.

---

## 4. Progress reporting surfaces

| Surface | What exists | What Host will need |
|---|---|---|
| Native Host header / `statusTitle` | Lifecycle words only | Distinct “preparing semantic memory” vs “starting resident” vs “ready” |
| Native `operation` + `ProgressView` | Single in-flight command label | Pollable phase from persisted handle; must survive command timeout |
| Native readiness issues | Process/API failures | Encoder not ready, disk, digest mismatch, bind failure — owner language |
| Native readiness warnings | Memory Lite / missing Ollama model | Replace “install that service yourself” with Retry/Resume; keep Memory Lite only as honest fallback if Encoder is optional for that home |
| Services disclosure | `name: state` | Include embedder process without exposing PM2 |
| `host.mjs` stderr | Intended progress channel | Keep technical; native UI must not render arbitrary stderr |
| Host JSON stdout | One object | Additive fields: semantic operation handle, phase, bytes, semanticReady, recipe id — versioned so old companions ignore them |
| PM2 / runtime logs | Support only | Translate into Host diagnostics; never make `pm2 logs` the ordinary recovery path |
| Source setup CLI | Journal steps `resident-and-seed` / `canonical-home` / `launch-config` | Parallel semantic-prep steps; no `ollama pull` instructions |
| Dashboard Live Problems | Harness/dashboard/engine for new Host homes | Optional later monitor; not a second setup UI. iPhone/Mac clients reuse existing capability/status; no local encoder |

Long downloads cannot depend on `HostAction.create` (300s) or `start` (180s) staying alive.

---

## 5. Packaging and delivery integration points

| Concern | Current seam | Host integration once Encoder pins artifacts |
|---|---|---|
| Inference libraries | `package.mjs` `npm ci` + ABI load-check | Add Encoder’s native modules or binary to the same load-check with distributed Node. Do not put them in `substrate/`. |
| Runtime tools | `scripts/product/runtime-tools` (PM2 7.0.4 only) | Supervisor stays PM2 unless Encoder proves a different supervised binary. Extra tools need a lockfile and notices. |
| Model weights | Not packaged (correct) | Private per-home directory outside immutable `app/` sources. Host env names the cache. Offline pre-seed supported. Shared immutable cache can follow later. |
| Integrity | `manifest.json` sha256 of payload files | Payload includes runtime/binary; **not** mutable downloads. Downloads get their own digest file after verify + atomic publish. |
| Signing order | Ad-hoc hardened sign of the `.app` after runtime copy | D02: sign runtime + app in manifest order; notarize. New native `.dylib`/helper may need entitlements (`com.apple.security.cs.allow-unsigned-executable-memory` / JIT) if ONNX/ORT requires it. Unknown until experiment. |
| Sandbox | Host not sandboxed; client is | Do not move inference into the sandboxed conversation app. iPhone/Mac clients stay remote to this home. |
| Notices | `notices/NODE-LICENSE` + package licenses | Encoder must supply model/runtime distribution notices for Host to copy. |
| Architecture | `darwin` + `arm64`/`x64`; Node must match builder | Measure only the initial supported Mac arch. Do not claim other targets. |
| Installer | Refuses overwrite | New encoder in a newer companion does not rewrite an installed home’s runtime. D08 updater is a later gate. |

---

## 6. Proposed Host-side contract needs

Host cannot implement stage 4 until Encoder (and Memory where noted) publish these. Names below are proposals for the shared contracts file; Encoder owns the service fields.

### Process and plan

- **Submitted process name** — recommendation: house-level `home23-embedder` inside the private supervisor (same class as `home23-coordination`). Confirm; do not also emit a resident-scoped duplicate.
- **Definition contract** — script/cwd stay under `app/`; interpreter `none` with bundled Node **or** a payload-owned binary whose path Host can ownership-check the way it checks `bin/node`.
- **Admission flag** — home requirement version / `encoderRequired` so old homes are not expected to run it.
- **Autorestart / memory cap** — Encoder proposes; Host applies on the submitted definition (`max_memory_restart` was spec-only; not in current Host definitions).
- **No global daemon** — one process per installed home.

### Ports and bind

- New port key (proposal: `embedder`) added to a **versioned** port plan (`home23.host.v2` or nested `ports.version`).
- Loopback only. Encoder enforces Origin/Host checks and input limits.
- Source-install default port (spec mentioned 11435) is not the Host port.

### Health, version, checksum

Host readiness needs more than tags:

| Field | Why Host needs it |
|---|---|
| `recipeId` / encoder identity | Must match the home’s reserved profile before writers start |
| `dimension` | Reject mismatch (768 until a separate design change) |
| `modelRevision` + artifact digests | Display/verify; refuse load on mismatch |
| `warm` | Actual inference succeeded, not just process up |
| `protocols` | Which of the two embedding protocols are live |
| `pid` / start generation | Reconcile surviving workers |
| `lastError` (no document/conversation text) | Owner-safe diagnostic |

`/api/tags` may remain for source compatibility; it must not be Host’s ready signal.

### Start / stop / status API (Host command layer)

Additive Host actions or create/start substates, still one JSON on stdout:

- `semantic-prepare` begin/resume → `{ handle, phase }`
- `status` includes `{ semantic: { handle, phase, bytesReceived, bytesTotal?, semanticReady, recipeId, error? } }`
- Existing `start` / `stop` remain the process admission API; they consume a ready encoder or report degraded
- Cancellation that leaves verified partial files and does not start a second worker

Native timeouts stay short; the worker is owned and discoverable on disk + process list.

### Setup phases (owner language)

Proposal for GUI/CLI, independent of Encoder’s internal steps:

1. Runtime installed
2. Resident and Seed prepared (existing birth)
3. Semantic memory downloading
4. Semantic memory verifying
5. Semantic memory warming
6. Home starting
7. Resident ready
8. Semantic ready
9. Documents imported (existing ingestion; separate)

Fresh setup **pauses before live contact** while mandatory semantic preparation is unavailable, with Retry/Resume and the saved home intact.

### Failure / recovery

Encoder must define: disk-full, digest mismatch, incompatible native module, bind in use, inference timeout, cancelled download, offline with missing artifacts, crash after warm-up. Host maps those to Retry/Resume/Stop and support detail. No user PM2.

Memory must define: vector-absent behavior, scope isolation for residents/helpers/channels, and that Host must not backfill Seed history.

---

## 7. File ownership map Host will claim later

Do not claim Encoder or Memory product files.

### home23 (backend)

| Path | Later Host work |
|---|---|
| `cli/lib/product-host.js` | Versioned ports/processes, durable semantic operation, start order, stop, old-home gating, chat/embed decoupling |
| `cli/lib/product-environment.js` | Port key versioning, explicit model-cache env, no ambient home-dir dependency |
| `cli/lib/product-memory.js` | Real inference readiness vs tag listing; separate semanticReady |
| `scripts/product/host.mjs` | Any new action; keep one JSON stdout |
| `cli/lib/setup.js`, `cli/lib/init.js` | Source parity; remove ordinary Ollama/manual embed install UX |
| `cli/lib/create-home.js`, `cli/lib/seed-birth.js` | Only if inventory proves a contact-boundary move; otherwise call unchanged |
| `scripts/product/package.mjs`, `cli/lib/product-payload.js` | Bundle/load-check Encoder runtime; keep models out of payload |
| `scripts/product/verify-install.mjs` | Isolated new home only; later real-inference proof is stage 5, not this investigation |
| `tests/cli/product-host.test.js`, `product-memory.test.js`, `product-package.test.js`, `product-payload.test.js` | Host invariants and recovery |
| `docs/design/HOST-COMPANION.md` | After implementation, record actual limits (docs already point at the plan) |

### home23-apple

| Path | Later Host work |
|---|---|
| `Home23Host/HostCommand.swift` | Decode durable progress; timeouts for short commands only; keep stderr off-screen |
| `Home23Host/HostModel.swift` | Prepare/retry/resume; do not auto-start while semantic-prep is mandatory and failed |
| `Home23Host/Home23HostApp.swift` | Owner-facing phases; remove “Host does not install that service for you” once Host does |
| `Home23Host/Tests/HostCommandTests.swift` | Progress decode, interrupted prepare, draft-stability |
| `scripts/build-home23-host.mjs` | Signing/runtime copy if payload layout changes |
| `Home23Host/README.md` | Protocol/actions after they exist |

### Explicitly not Host

`scripts/embedder/**`, `shared/seed-embedding-config.cjs` (Encoder-owned edits), `src/substrate/embed-at-contact.ts`, `substrate/src/embed-fetch.ts`, Seed adapters/types/metabolism, `src/substrate/semantic-match.ts`, `src/substrate/seed-context.ts`, `src/agent/context-assembly.ts`, `src/agent/trigger-index.ts`, `engine/src/core/openai-client.js`, `engine/src/memory/network-memory.js`, `engine/src/merge/build-ann-index.js`, work-record/contracts files owned by Encoder, Memory investigation file.

---

## 8. Risks of implementing before experiment evidence

| Risk | Why Host must wait |
|---|---|
| Binary vs Python vs Node service | Changes payload layout, load-check, codesign, process definition, and PATH. Guessing locks packaging. |
| Model family / revision / precision | Changes size, RAM, warm latency, and whether create can pause before contact. |
| Model size and download | Determines whether status-polling + resume is enough, and disk checks. Nomic ONNX was speculated ~140MB in the old spec; unmeasured. |
| Packaged Node ABI | Transformers.js / onnxruntime-node / a custom binary may fail the same class of Homebrew-Node mistake `inspectProductNode()` already guards. |
| Codesign / hardened runtime | JIT or unsigned executable memory can fail notarization. Host already signs `--options runtime`. |
| Sandbox | Must stay in Host, not the client. A helper tool may still need entitlements. |
| Unconditional `ownedProcessNames()` growth | Would degrade every existing Host home on status/start. |
| Unversioned `PORT_KEYS` | Would make `.home23-host.json` unreadable. |
| Holding `.host.lock` during download | Stale 180s; concurrent Start could fight a living worker. |
| Native command timeouts | Create/start cannot be “just make the timeout bigger” (plan). |
| Chat `baseUrl` → embeddings | Current tests assert this coupling; flipping it without a reserved Host endpoint is a behavior change. |
| Treating `/api/tags` as ready | Current Host already knows this is insufficient; implementing a fake ready would violate the plan. |
| Fetching into `~/.home23` or the GUI home | Plan forbids implicit ambient cache. |
| Starting writers before warm-up | First contact events would be permanently vectorless. |
| Touching live `release/home23` or the default Host home | Out of scope; destroys the isolation rule. |

---

## 9. Isolated TEST home verification approach

Authorization for this investigation: **create/start/stop only on a new isolated home, and only after implementation is authorized.** This investigation did not create or start any home.

When Host implementation is authorized:

1. Build or reuse a payload in a **new** output directory. Never overlay `release/home23` or `~/Library/Application Support/Home23 Host/Home`.
2. Use `scripts/product/verify-install.mjs PAYLOAD NEW_OUTPUT_DIRECTORY` as the pattern: `mkdirSync(outputPath, { recursive: false })`, home at `outputPath/Home`, fixture or owned encoder only as Encoder specifies.
3. Apple isolated acceptance: development Host with `--home-root /absolute/new-test-home` and `--payload /absolute/payload`. Do not replace an installed app.
4. Exercise: install → create (same `createHome`) → semantic-prepare → start → status (resident ready vs semantic ready) → stop (`desiredRunning: false`) → start. Confirm Stop stays stopped across Host relaunch.
5. Do not import owner documents into a test home that might later be confused with production. Use a nonpersonal fixture only when stage 5 is authorized.
6. Do not run `pm2` against the operator daemon. Do not `pm2 stop all`.
7. Leave the stopped test home for inspection; do not delete unless the owner asks.
8. Unit coverage stays in `tests/cli/product-*` and `Home23Host/Tests/HostCommandTests.swift`. Real inference is a dedicated job with digest-verified cached weights, not ordinary CI.

---

## 10. Open questions only experiment evidence or Encoder contracts can answer

1. Exact runtime: Node + Transformers.js/ONNX, a native binary, or a Python service — and which can load under packaged Node 22 on the first supported Mac arch.
2. Exact model revision, artifact URLs, digests, size, RAM, cold/warm latency, and whether first-run download can finish on typical home disk/network.
3. Whether both existing embedding protocols are served by one process, and the loopback URLs Host should write into `home.embeddings` and `home.substrate.embedding` (independent of chat `baseUrl`).
4. Process argv, env vars (especially model directory), health path, warm-up request, and structured error codes without logging user text.
5. Whether Encoder needs extra native libraries or a second executable in the payload, and their codesign story.
6. Memory/scheduling: interactive vs ingestion queue, so Host start-order and timeouts stay honest.
7. Whether birth/preparation currently emits any meaningful contact (inventory). If yes, encoder prep moves before that boundary; current Host reading says no.
8. Process name and whether source multi-agent installs share one house embedder (plan: one per home).
9. Recipe id string Host should persist and show.
10. Offline pre-seed directory layout and Host env name.
11. Whether Memory Lite remains a supported Host mode if encoder prep fails, or fresh Host setup must pause indefinitely until Retry succeeds.
12. Calibration/attention policy — Memory/Encoder; Host only displays degraded vs ready.
13. D08 upgrade selector for already-installed product homes — Host must expose it later, not invent it in stage 4.

---

## Concurrent work preserved

| Location | State | Host action |
|---|---|---|
| `home23` on `codex/jerry-continuity-20260907` @ `44288211b` | Clean; another session’s branch | Not switched; not dirtied |
| `.home23-worktrees/owned-embedder-encoder-stage1` | Encoder Stage 1; same base commit; no work-record/contracts yet | Not edited |
| `home23-scout-reconcile-20260910` | Same commit; copy of plan/spec | Not edited |
| `home23-host-product` | Historical Host product branch; Host files already in current lineage | Not edited |
| `home23-apple` on `codex/mac-dashboard2-20260908` | Clean | Not edited |
| `home23-apple-host-product` | Host companion history | Not edited |
| `release/home23` | Live installation | Not used as a source; not started/stopped |

Encoder’s `2026-09-10-owned-embedder-work-record.md` and `2026-09-10-owned-embedder-contracts.md` were not created or edited. Memory’s investigation file was not created or edited.

---

## Handoff

- Investigation written in isolated worktree `home23/.home23-worktrees/owned-embedder-host-investigation` on `home23-agent/owned-embedder-host-investigation`.
- Repo-relative path: `docs/superpowers/plans/2026-09-10-owned-embedder-host-investigation.md`.
- Implementation remains blocked on Encoder Stage 1 evidence and shared contracts.
- Next Host action after lead review: wait; then implement stage 4 only against published contracts, in this or a successor isolated worktree, with an isolated TEST home.
