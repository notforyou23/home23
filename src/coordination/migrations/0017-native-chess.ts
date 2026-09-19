export const NATIVE_CHESS_MIGRATION_SQL = `
CREATE TABLE chess_games (
  id TEXT PRIMARY KEY CHECK (id LIKE 'chess_%'),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  white_principal_id TEXT NOT NULL REFERENCES principals(id),
  black_principal_id TEXT NOT NULL REFERENCES principals(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  initial_fen TEXT NOT NULL,
  fen TEXT NOT NULL,
  pgn TEXT NOT NULL,
  moves_json TEXT NOT NULL CHECK (json_valid(moves_json) AND json_type(moves_json) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'finished')),
  result TEXT NOT NULL CHECK (result IN ('*', '1-0', '0-1', '1/2-1/2')),
  turn TEXT NOT NULL CHECK (turn IN ('w', 'b')),
  ply INTEGER NOT NULL CHECK (ply >= 0),
  version INTEGER NOT NULL CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (channel_id, white_principal_id) REFERENCES channel_members(channel_id, principal_id),
  FOREIGN KEY (channel_id, black_principal_id) REFERENCES channel_members(channel_id, principal_id)
) STRICT;
CREATE INDEX chess_games_channel_updated ON chess_games(channel_id, updated_at DESC, id DESC);

CREATE TABLE chess_positions (
  id TEXT PRIMARY KEY CHECK (id LIKE 'chesspos_%'),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  fen TEXT NOT NULL,
  annotations_json TEXT NOT NULL CHECK (json_valid(annotations_json) AND json_type(annotations_json) = 'object'),
  source_game_id TEXT REFERENCES chess_games(id),
  source_ply INTEGER CHECK (source_ply IS NULL OR source_ply >= 0),
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  CHECK ((source_game_id IS NULL) = (source_ply IS NULL)),
  FOREIGN KEY (channel_id, created_by) REFERENCES channel_members(channel_id, principal_id)
) STRICT;
CREATE INDEX chess_positions_channel_created ON chess_positions(channel_id, created_at DESC, id DESC);

CREATE TABLE chess_idempotency (
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  key_digest TEXT NOT NULL CHECK (length(key_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  operation TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  response_json TEXT NOT NULL CHECK (json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (actor_principal_id, key_digest)
) STRICT;

CREATE TABLE chess_turn_intents (
  id TEXT PRIMARY KEY CHECK (id LIKE 'chessturn_%'),
  game_id TEXT NOT NULL REFERENCES chess_games(id),
  game_version INTEGER NOT NULL CHECK (game_version >= 1),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  target_bot_id TEXT NOT NULL REFERENCES bots(id),
  run_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'dispatched', 'failed', 'cancelled')),
  work_ids_json TEXT CHECK (work_ids_json IS NULL OR json_valid(work_ids_json)),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (game_id, game_version)
) STRICT;
CREATE INDEX chess_turn_intents_due ON chess_turn_intents(status, created_at, id);
`;
