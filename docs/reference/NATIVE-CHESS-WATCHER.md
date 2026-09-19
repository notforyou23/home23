# Session-scoped native macOS Chess watcher

This optional process observes one normal Chess.app game through Accessibility. A binding selects the human color and the exact canonical bot; either side may be White. It does not focus the app, capture images, execute moves, run cron, or call a model. Banter and responding Chess Work remain in the selected canonical channel.

## Prepare and inspect

From the reviewed backend source/package, install locked dependencies and build:

```sh
npm ci --include=dev
npm run build
npm run test:chess
node scripts/chess/watch.mjs inspect 'Game 2 | owner - Auto-Match Player' '/absolute/path/to/Unsaved Chess Document.game'
```

`inspect` is read-only and requires macOS Accessibility/Automation permission for the execution host. It returns the current AX board, document FEN and coordinate history, and a binding template. Copy **only `binding`** into a private JSON file; replace `channelId` and `botId` with the canonical channel and active member bot IDs, set `botName` for readable prompts, and choose `ownerColor` (`w` or `b`). Keep `initialBotTurn: false` unless explicitly requesting an initial bot move. Keep state and binding outside Git (for example under the installation's ignored `instances/jerry/chess/`). Do not copy an old position from a handoff. Start refuses unless two fresh samples match the complete supplied history and board.

The exact window title marker omits the changing trailing parenthesized status, such as ` (Black to Move)`. No `front window` selector is used. Identity includes the live Chess PID, unique matching window, absolute autosave path, a hash of document start date/time/player/variant, initial move history, and the configured human color. Another process cannot watch the same canonical document path concurrently, even using a different session directory.

## Start and control

Run under the primary resident's **existing signed resident environment** (the same environment as the resident harness):

- `HOME23_AGENT=<primary-resident-slug>`
- `HOME23_COORDINATION_RESIDENT_KEY`
- `HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID`
- `HOME23_COORDINATION_RESIDENT_KEY_VERSION`
- `HOME23_COORDINATION_SOCKET_PATH`
- `HOME23_COORDINATION_SERVER_INSTANCE_ID` (defaults to `home23-coordination`)

Never put the key in a command argument, binding file, output or source. This utility consumes existing credentials; it does not create or change them. Core must have canonical channels enabled and the authenticated sender must be the primary resident and a member of the active group channel, as required by the existing scheduled submission seam. The target bot must also be an active member; authenticating as the resident does not impersonate the target.

```sh
node scripts/chess/watch.mjs start /absolute/private/session /absolute/private/binding.json
# In another terminal / exec session:
node scripts/chess/watch.mjs status /absolute/private/session
node scripts/chess/watch.mjs pause /absolute/private/session
node scripts/chess/watch.mjs resume /absolute/private/session
node scripts/chess/watch.mjs stop /absolute/private/session
```

Equivalent entry point: `npm run chess:watch -- <command> ...`. `start` stays in the foreground; retain its terminal/exec session. For supervised startup, use `serve` as described below. SIGINT/SIGTERM exit without changing the persisted mode. Stop preserves its state and receipts. A stopped session cannot resume; inspect and create a new session directory for another session. Starting an interrupted session with the same binding loads it **paused** and requires explicit `resume`. The per-document lease expires after a crashed process; wait at least 10 seconds before restarting. Status distinguishes an unreachable process from its last saved state.

Pause is serialized with a pending admission, so its acknowledgement can take up to the signed request timeout. Pause/stop halt future watcher admissions; they do **not** cancel already admitted canonical Work. Inspect/cancel that Work through existing Home23 controls if necessary. Never delete a pending outbox to force a retry.

## Behavior and recovery

- Local polls have a 500 ms delay and require two identical complete samples. AX is the board authority; autosave history and normalized FEN must independently agree. Slow AX reads and pending signed requests increase this interval.
- `chess.js` 1.4.0 validates all legal moves, including castling, en passant, checks and promotions. Exactly one legal transition must produce the observed board. The autosave must extend the accepted history by exactly that move. This intentionally pauses on autosave lag rather than guessing; after it catches up, resume rechecks the same transition.
- A human move persists the new position/hash and exact outbox request using file fsync, atomic rename and directory fsync **before** any network request. Repeated board samples cannot generate another event. A signed retry retains the same `sched-run-UUID`, input and server-side idempotency key.
- The adapter uses `ResidentUdsClient` with the existing `/internal/v1/scheduled-turns` signed seam. Core journals admission, calls `CoordinationMessageSubmissionPort.submitMessage` with a bot-authored message mentioning the configured target bot, and owns canonical Work execution/recovery. This utility does not schedule periodic agent turns. Pending Work status checks reuse the same request, at most once every two seconds.
- A successful canonical result with Work IDs clears the outbox and saves its receipt. An acknowledgement alone is not verified piece movement. The watcher independently accepts a unique legal bot transition without waking it again. It does not create another human event while the previous Work is pending. A game initially bound on the bot's turn does **not** trigger a move unless `initialBotTurn: true` was explicitly set in the fresh binding.
- Transient read failures retain running mode and require two fresh stable samples before recovery. Process replacement, changed document, history rewind/new game, multiple missed moves, malformed board, terminal game, failed Work or uncertain acknowledgement pause locally and report once on stderr and in status. No model is called to interpret ambiguity.
- After uncertain acknowledgement, resume retries the exact saved request only after the board/history still matches the saved position or one legal next move. If multiple moves were missed, leave it paused and reconcile in the channel. Resuming cannot reinterpret the game or silently rebase its history.

The move message instructs the configured bot to re-read the exact bound board before acting and verify one move of its configured color. The watcher cannot enforce the resident's physical move execution or prevent a separate manual channel instruction from requesting another move. Physical acceptance must verify that seam.

## Verification and release boundary

`npm run test:chess` uses fixtures/mocks only: legal edge cases, identity/history refusals, stability, pause/resume/stop, durable replay, atomic persistence, exclusion of duplicate processes and signed UDS transport. It never moves pieces. `tests/coordination/app/scheduled-turns.test.ts` covers the existing canonical admission/restart dedupe.

Integration means reviewing/cherry-picking the task commit into maintained source and reconciling its dependency lockfile. Deployment remains separate: follow [managed releases](MANAGED-RELEASES.md), inspect the selected package versus maintained HEAD, and build/verify a candidate before authorized activation. The watcher is a separate process, optionally supervised by a user launch agent. After activation, inspect the live game again, start with its fresh binding, observe one human move and verify one bot message, one canonical Work and one legal bot response. Also verify minimized operation, pause, duplicate exclusion and stop. Build and fixture receipts do not replace that acceptance.

## Persistent user service

Install `scripts/chess/service.mjs` as a stable, operator-owned launcher outside the immutable release. A launchd user agent runs `node /absolute/service.mjs /absolute/service.json` with `RunAtLoad`, `KeepAlive`, and a 15-second throttle. It runs in the logged-in GUI session; the execution host needs the same macOS Accessibility/Automation permission as `inspect`.

The service config is a regular mode-0600 JSON file:

```json
{
  "version": 1,
  "installation": "/absolute/home23-installation",
  "resident": "jerry",
  "sessionDirectory": "/absolute/private/chess/session",
  "bindingFile": "/absolute/private/chess/binding.json"
}
```

`resident` selects existing transport authority; the binding's `botId` selects the opponent. The launcher resolves the selected managed release and its saved harness environment on every startup. Keys never belong in the plist or configuration. Restart this one service after a managed release changes. A missing release, credential, or mismatched saved environment fails closed.

`serve` preserves running, paused and stopped modes across restarts. A stopped service stays reachable for status without polling; it cannot resume. Running sessions validate fresh board identity/history before replaying a saved pending admission. A replaced Chess process pauses rather than silently attaching to another game.

Bot, color and new-game changes require only configuration and a scoped service restart, **not** backend or Apple rebuilds. Pause the old session, inspect the actual board, create a fresh binding and session directory, update the service config, and restart the named launch agent. Never retarget a session with pending work. Old state and receipts remain intact. Restarting with an edited binding in the same session is refused.
