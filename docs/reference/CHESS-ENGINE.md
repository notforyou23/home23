# House chess engine

House runs an optional local Stockfish executable through asynchronous UCI pipes.
Install it explicitly before enabling engine opponents or analysis. Home23 does
not download software or change a running House's environment automatically.

## Installation

Use the [official Stockfish 17.1 release](https://github.com/official-stockfish/Stockfish/releases/tag/sf_17.1)
(tag `sf_17.1`, source commit `03e27488f3d21d8ff4dbf3065603afa21dbd0ef3`).
Choose the archive for your operating system and CPU. Extract the complete
archive into an operator-owned tools directory outside the source checkout and
runtime state. Keep its source, notices and license alongside the executable.
No package manager or privileged installation is required.

For example, on an Apple silicon Mac, with an existing private tools directory:

```sh
curl --fail --location --output "$TOOLS_DIR/stockfish-17.1.tar" \
  https://github.com/official-stockfish/Stockfish/releases/download/sf_17.1/stockfish-macos-m1-apple-silicon.tar
tar -xf "$TOOLS_DIR/stockfish-17.1.tar" -C "$TOOLS_DIR"
export HOME23_STOCKFISH_PATH="$TOOLS_DIR/stockfish/stockfish-macos-m1-apple-silicon"
```

SHA-256 of that official archive:
`4e23165eb8f353c221ff7ab6716f0a160c3993dadf90d0c0ad982a7ade4091c9`.
Other platforms must use their matching official asset, not this binary/hash.

Alternatively, build the pinned source using its included
[compilation instructions](https://official-stockfish.github.io/docs/stockfish-wiki/Compiling-from-source.html).
The exact source can be retrieved without following a moving branch:

```sh
curl --fail --location --output "$TOOLS_DIR/stockfish-17.1-source.tar.gz" \
  https://github.com/official-stockfish/Stockfish/archive/03e27488f3d21d8ff4dbf3065603afa21dbd0ef3.tar.gz
```

The build's `src/Makefile` and `scripts/net.sh` retrieve the matching neural
networks when needed. Keep those build inputs when retaining a reproducible
source build. A separately authorized runtime configuration change is needed
for a managed House to inherit the executable setting.

`HOME23_STOCKFISH_PATH` is an operator setting, never a request field. When set,
it is authoritative: a missing or non-executable override reports unavailable.
Otherwise Home23 looks for `stockfish` (`stockfish.exe` on Windows) in absolute
PATH directories. `available()` only checks file/executable access; it does not
start a process or promise that a binary is compatible with the current CPU.

## Adapter contract

```ts
const engine = new StockfishEngine();
engine.available(); // boolean; no process launch
await engine.analyze({ fen, moves, skillLevel, moveTimeMs, multiPV }, signal);
// { fen, bestMove: string | null, lines: [{ moves, scoreCp?, mate?, depth }] }
```

Moves are UCI coordinates (including optional promotion), applied legally using
chess.js before launch. The returned FEN is the position after those moves and
before `bestMove`. Supplied move history is sent to Stockfish for repetition
handling. Scores retain Stockfish's side-to-move perspective. A null best move
requires a position with no legal moves. Variations and best moves are checked
for legality before return. This adapter validates FEN/king safety and supplied
moves; it does not prove that an arbitrary study FEN has a reachable game history.

Each request starts one process using an executable path and argv, without a
shell. All instances in the Core process share one active slot; a competing
request fails immediately with `engine_busy`. There is no queue. The slot is
released only after the child closes. The caller can retry a busy request later.

Limits: one thread, 32 MiB hash, Skill Level 0–20 (default 20), MultiPV 1–3
(default 1), search time 1–1500 ms (default 500). Finite numeric settings are
clamped to these bounds. Stockfish internally uses additional candidate moves
at reduced skill levels; the adapter only returns the requested number of lines.
The 32 MiB setting bounds the transposition table, not total process memory;
Stockfish also holds its neural networks and other engine data.

The entire child lifetime has a ten-second deadline including startup. On
abort, Home23 sends `stop` and kills a child still running after 100 ms. On
success it sends `quit` with the same exit grace. Deadline expiry kills
immediately. Input is limited to 256 FEN characters / 1000 moves; output is
limited to 1 MiB total, 16 KiB per line and 256 plies per variation. Malformed
informational lines are ignored; illegal returned moves fail the request.

`StockfishError.code` is one of `invalid_input`, `engine_unavailable`,
`engine_busy`, `engine_cancelled`, `engine_timeout`, or `engine_protocol`.
The engine never mutates a game. The caller owns authorization, game version
checks, automatic-turn budgets, persistence and retries.

Focused check: `node --import tsx --test tests/coordination/chess/stockfish.test.ts`.
The deterministic tests use private temporary executable fixtures; set
`HOME23_STOCKFISH_TEST_TMPDIR` to choose their parent directory. They do not
download or probe a real engine.

## Stockfish license and notices

Stockfish is a separate program licensed under
[GNU GPL version 3](https://github.com/official-stockfish/Stockfish/blob/03e27488f3d21d8ff4dbf3065603afa21dbd0ef3/Copying.txt).
Its source headers permit version 3 or, at your option, a later version.
Preserve `Copying.txt`, `AUTHORS`, the upstream README and network/data notices.
The [pinned upstream README](https://github.com/official-stockfish/Stockfish/blob/03e27488f3d21d8ff4dbf3065603afa21dbd0ef3/README.md)
describes source availability requirements when distributing a binary, and
acknowledges Leela Chess Zero training data under the Open Database License.
If redistributing Stockfish, provide its license and corresponding source (or
the source access described by upstream); make any modifications available
under GPLv3. This integration adds no Stockfish binaries to the Home23 repository.

## Games and study

The authenticated Chess options route (`GET /api/v1/chess/options`) reports
availability. Chess seats accept the owner, active channel bots, and
`engine_stockfish_0` through `engine_stockfish_20`. Only the owner can create
a game they are watching without playing. Engine seats are local to chess and
do not create bot accounts or grant House permissions.

Game creation accepts `automation: {maxPlies: 1..400}` (default 80) and
`startPaused`. The allowance counts accepted automatic moves, survives restarts,
and pauses play at zero. `resume` replenishes it; `step` plays one automatic turn
from a paused game and pauses again. Bot turns still use canonical Work and the
current game-version fence. Engine turns use the same durable turn intents and
recheck the version before applying their result. Pausing invalidates late moves.
The allowance limits automatic moves, not a monetary amount or bot token spend.

`POST /api/v1/chess/analysis` takes `{fen, moves?}` under owner read authorization.
It returns a best move and up to three variations without changing any game.
An engine error produces a failed turn or an analysis error; it never silently
substitutes another player. Retrying a failed turn remains an explicit action.
