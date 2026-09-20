# Native Chess API

Home23 owns the game record and applies legal moves. A bot chooses its move through `native_chess`; it never operates another application's board. This first version supports multiple independent human-versus-bot games, either color, and immutable teaching positions. No engine evaluation, tournament scheduling, clocks, or automatic quiz grading is included.

## Apple integration

Use the signed-in House origin and normal bearer session. Discover `chessRead` and `chessMutation` in `/api/v1/capabilities`. Writes require `product:read`, `message:send`, and a 16–128 character `Idempotency-Key`. Keep the same key and body when retrying an uncertain response. A changed request needs a new key.

| Method | Path under `/api/v1/chess` | Result |
|---|---|---|
| GET / POST | `/games` | List / create a game |
| GET | `/games/:gameId` | `{game, boardReference}` including complete move history |
| POST | `/games/:gameId/moves` | Apply one legal move |
| POST | `/games/:gameId/control` | Pause, resume, resign, retry a failed bot turn |
| GET | `/games/:gameId/pgn` | PGN download |
| GET | `/games/:gameId/stream` | Live compact game snapshots |
| GET / POST | `/positions` | List / save immutable teaching positions |
| GET | `/positions/:positionId` | Read a saved position |

Game lists accept `channelId`, `limit`, `cursor`; position lists require `channelId`. Follow `nextCursor` when present. Bot access is checked against current channel membership; the signed-in owner retains standing read access. Mutations also enforce player and control permissions. A game always names two exact principal IDs: `user_owner` and an active channel bot. There is no hardcoded Chester, Jerry, or Black side.

Create body:

```json
{"channelId":"chn_...","players":{"white":"user_owner","black":"bot_..."},"title":"Chess with Chester"}
```

Optional `initialPgn` imports a bounded standard-start game. An imported game starts active unless finished. Resignation and agreed-draw results in PGN are preserved; a result conflicting with a forced board outcome is rejected. If the bot is to move, creation records its turn immediately. The owner may select any eligible opponent; a bot may create a game only with itself as opponent. A new game is a new record; it never resets an old game or changes the meaning of a shared position.

Move body:

```json
{"expectedVersion":2,"from":"e7","to":"e8","promotion":"n"}
```

`promotion` is `q`, `r`, `b`, or `n` when promoting. Version counts game mutations, including controls; `ply` counts moves. On conflict, fetch the game and let the player decide again. Never replay a stale drag automatically against a newer position. The server decides legality and side to move. The human cannot submit moves as the bot by supplying its principal ID.

Control body: `{"expectedVersion":3,"action":"pause"}`. Actions: `pause`, `resume`, `resign`, `retry_turn`. Owner controls pause/resume/retry; a player resigns their own side. Game over and paused states disable moves. Checkmate and draw results come from the legal game record. Bot-turn failure is separate from game result. `retry_turn` is allowed only for a failed turn, never while queued or running.

## Live updates and history

`/stream` sends `event: snapshot` with the game fields **except `moves`**, plus `lastMove` (or null). The first snapshot is current state. Reconnect sends current state again; no byte/event cursor is needed because GET holds the entire durable history. Replace the displayed state by game ID/version; `turnDelivery` may change without the version changing. Fetch GET when move history needs refreshing. Heartbeats do not indicate a new move. Stream records stay below 48 KB and close on lost authorization or server drain.

A bot turn shows `turnDelivery.status`: `queued`, `dispatched`, or `failed`, with work IDs when known. A successful model reply is not proof of a move. If the bot finishes without submitting one, the turn becomes failed and the owner can retry explicitly. No automatic repeated paid attempts. Move acceptance and the next bot-turn intent are committed together. Restart recovery reuses the same scheduled run ID.

A bot mutation is tied to its authenticated canonical Work and current game-turn intent. Pausing/retrying supersedes that intent: an old Work cannot gain authority merely by fetching the latest version. An already-running model may finish its reply, but its old turn cannot change the game.

## Inline boards and saved positions

The tool returns `boardReference` and a `home23://chess/...` URL. A bot can embed `[Chess board](URL)` in its ordinary chat reply. Apple should recognize only these typed routes and render a native board; do not execute arbitrary HTML or model-generated code. The backend adds no new message-body variant.

- Live game: `home23://chess/games/<gameId>?sharedVersion=<version>&sharedPly=<ply>`.
- Frozen teaching position: `home23://chess/positions/<positionId>`.

A live link follows the game, with “View position when shared” using `sharedPly` against `initialFen`/move history. A position link always shows its saved FEN. An expanded view loads the same record; it does not copy or fork the game.

Save body requires `channelId`, `title`, `fen`; optional `annotations` contains `arrows:[{from,to,color?}]` and `highlights:[{square,color?}]` (up to 64 each). Optional `sourceGameId` and `sourcePly` must appear together and match that game's exact historical FEN. FEN must be a valid playable position in this version. Positions can represent examples or the starting point of a client-side analysis board; exploring them must never call the live game's move route. Saving another position creates another immutable record. Hidden exercise solutions and persisted analysis trees are future additions.

## Contract and verification

Canonical schemas and examples are in `src/coordination/contracts/v1/`: `chess-game`, `chess-position`, and `chess-snapshot`. Fixtures were produced from actual service operations and sanitized to stable IDs/timestamps. Generate Swift fixture data with the existing `generate-apple-fixtures.ts`; Core's pack is authoritative.

Migration 17 adds isolated game, position, mutation-receipt and turn-intent tables. Existing channels, messages and Work remain their current authorities. Native Chess is independent of the retired optional Apple Chess watcher.

Focused verification uses real SQLite persistence, legal chess moves, authenticated HTTP/fenced tool paths, restart recovery, stale-turn rejection, and canonical fixture validation. No live game or paid model turn is required to run it.

### Bot move arguments

Use `native_chess` with `operation: "move"`, the current `gameId` and `expectedVersion`, and lowercase `from`/`to` squares. Omit `promotion` or send `null` for ordinary moves; choose `q`, `r`, `b`, or `n` only when a pawn reaches its last rank. Do not fill unrelated fields such as players, title, or initialPgn. The tool normalizes legacy blank/none promotion placeholders; the public HTTP move contract is unchanged.

Example ordinary move: `{"operation":"move","gameId":"<current game>","expectedVersion":2,"from":"e7","to":"e5","promotion":null}`. A returned game with the new move is the success receipt.
