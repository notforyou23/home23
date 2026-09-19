# Session-scoped native macOS Chess watcher

This optional foreground process observes one normal Chess.app game through Accessibility, with White as the owner and Jerry as Black. It does not focus the app, capture images, execute moves, run cron, or call a model. Banter and responding Chess Work remain in the selected canonical channel.

## Prepare and inspect

From the reviewed backend source/package, install locked dependencies and build:

```sh
npm ci --include=dev
npm run build
npm run test:chess
node scripts/chess/watch.mjs inspect 'Game 2 | owner - Auto-Match Player' '/absolute/path/to/Unsaved Chess Document.game'
```

`inspect` is read-only and requires macOS Accessibility/Automation permission for the execution host. It returns the current AX board, document FEN and coordinate history, and a binding template. Copy **only `binding`** into a private JSON file; replace `channelId` with the canonical Chess channel ID. Keep state and binding outside Git (for example under the installation's ignored `instances/jerry/chess/`). Do not copy an old position from a handoff. Start refuses unless two fresh samples match the complete supplied history and board.

The exact window title marker omits the changing trailing parenthesized status, such as ` (Black to Move)`. No `front window` selector is used. Identity includes the live Chess PID, unique matching window, absolute autosave path, a hash of document start date/time/player/variant, initial move history, and White ownership. Another process cannot watch the same canonical document path concurrently, even using a different session directory.

## Start and control

Run under Jerry's **existing signed resident environment** (the same environment as the resident harness):

- `HOME23_AGENT=jerry`
- `HOME23_COORDINATION_RESIDENT_KEY`
- `HOME23_COORDINATION_RESIDENT_CLIENT_INSTANCE_ID`
- `HOME23_COORDINATION_RESIDENT_KEY_VERSION`
- `HOME23_COORDINATION_SOCKET_PATH`
- `HOME23_COORDINATION_SERVER_INSTANCE_ID` (defaults to `home23-coordination`)

Never put the key in a command argument, binding file, output or source. This utility consumes existing credentials; it does not create or change them. Core must have canonical channels enabled and Jerry must be the primary resident and a member of the active group channel, as required by the existing scheduled submission seam.

```sh
node scripts/chess/watch.mjs start /absolute/private/session /absolute/private/binding.json
# In another terminal / exec session:
node scripts/chess/watch.mjs status /absolute/private/session
node scripts/chess/watch.mjs pause /absolute/private/session
node scripts/chess/watch.mjs resume /absolute/private/session
node scripts/chess/watch.mjs stop /absolute/private/session
```

Equivalent entry point: `npm run chess:watch -- <command> ...`. `start` stays in the foreground; retain its terminal/exec session. Do not install a launch agent or perpetual daemon. SIGINT/SIGTERM stop the watcher. Stop preserves its state and receipts. A stopped session cannot resume; inspect and create a new session directory for another session. Starting an interrupted session with the same binding loads it **paused** and requires explicit `resume`. The per-document lease expires after a crashed process; wait at least 10 seconds before restarting. Status distinguishes an unreachable process from its last saved state.

Pause is serialized with a pending admission, so its acknowledgement can take up to the signed request timeout. Pause/stop halt future watcher admissions; they do **not** cancel already admitted canonical Work. Inspect/cancel that Work through existing Home23 controls if necessary. Never delete a pending outbox to force a retry.

## Behavior and recovery

- Local polls have a 500 ms delay and require two identical complete samples. AX is the board authority; autosave history and normalized FEN must independently agree. Slow AX reads and pending signed requests increase this interval.
- `chess.js` 1.4.0 validates all legal moves, including castling, en passant, checks and promotions. Exactly one legal transition must produce the observed board. The autosave must extend the accepted history by exactly that move. This intentionally pauses on autosave lag rather than guessing; after it catches up, resume rechecks the same transition.
- A White move persists the new position/hash and exact outbox request using file fsync, atomic rename and directory fsync **before** any network request. Repeated board samples cannot generate another event. A signed retry retains the same `sched-run-UUID`, input and server-side idempotency key.
- The adapter uses `ResidentUdsClient` with the existing `/internal/v1/scheduled-turns` signed seam. Core journals admission, calls `CoordinationMessageSubmissionPort.submitMessage` with a bot-authored message mentioning Jerry, and owns canonical Work execution/recovery. This utility does not schedule periodic agent turns. Pending Work status checks reuse the same request, at most once every two seconds.
- A successful canonical result with Work IDs clears the outbox and saves its receipt. An acknowledgement alone is not verified piece movement. The watcher independently accepts a unique legal Black transition without waking Jerry. It does not create another White event while the previous Work is pending. A game initially bound on Black's turn does **not** trigger a move: the existing lead/turn must handle Black first.
- App/window disappearance, process replacement, changed document, history rewind/new game, multiple missed moves, malformed board, terminal game, failed Work or uncertain acknowledgement pause locally and report once on stderr and in status. No model is called to interpret ambiguity.
- After uncertain acknowledgement, resume retries the exact saved request only after the board/history still matches the saved position or one legal next move. If multiple moves were missed, leave it paused and reconcile in the channel. Resuming cannot reinterpret the game or silently rebase its history.

The move message instructs Jerry to re-read the exact bound board before acting and verify one Black move. The watcher cannot enforce the resident's physical move execution or prevent a separate manual channel instruction from requesting another move. Physical acceptance must verify that seam.

## Verification and release boundary

`npm run test:chess` uses fixtures/mocks only: legal edge cases, identity/history refusals, stability, pause/resume/stop, durable replay, atomic persistence, exclusion of duplicate processes and signed UDS transport. It never moves pieces. `tests/coordination/app/scheduled-turns.test.ts` covers the existing canonical admission/restart dedupe.

Integration means reviewing/cherry-picking the task commit into maintained source and reconciling its dependency lockfile. Deployment remains separate: follow [managed releases](MANAGED-RELEASES.md), inspect the selected package versus maintained HEAD, and build/verify a candidate before authorized activation. The watcher itself is an explicitly started process, not a new Core service. After activation, inspect the live game again, start with its fresh binding, observe one White move and verify one bot message, one canonical Work and one legal Black response. Also verify minimized operation, pause, duplicate exclusion and stop. Build and fixture receipts do not replace that acceptance.
