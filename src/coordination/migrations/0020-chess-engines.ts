/** Engine seats are chess-local identities; they never become House principals. */
export const CHESS_ENGINES_MIGRATION_SQL = `
PRAGMA defer_foreign_keys = ON;
CREATE TABLE chess_games_v20 (
  id TEXT PRIMARY KEY CHECK (id LIKE 'chess_%'),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  white_principal_id TEXT NOT NULL,
  black_principal_id TEXT NOT NULL,
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
  automatic_max_plies INTEGER NOT NULL DEFAULT 80 CHECK (automatic_max_plies BETWEEN 1 AND 400),
  automatic_remaining INTEGER NOT NULL DEFAULT 80 CHECK (automatic_remaining BETWEEN 0 AND 400),
  pause_reason TEXT
) STRICT;
CREATE TABLE chess_positions_v20 (
  id TEXT PRIMARY KEY CHECK (id LIKE 'chesspos_%'),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  fen TEXT NOT NULL,
  annotations_json TEXT NOT NULL CHECK (json_valid(annotations_json) AND json_type(annotations_json) = 'object'),
  source_game_id TEXT REFERENCES chess_games_v20(id),
  source_ply INTEGER CHECK (source_ply IS NULL OR source_ply >= 0),
  created_by TEXT NOT NULL REFERENCES principals(id),
  created_at TEXT NOT NULL,
  CHECK ((source_game_id IS NULL) = (source_ply IS NULL)),
  FOREIGN KEY (channel_id, created_by) REFERENCES channel_members(channel_id, principal_id)
) STRICT;
CREATE TABLE chess_turn_intents_v20 (
  id TEXT PRIMARY KEY CHECK (id LIKE 'chessturn_%'),
  game_id TEXT NOT NULL REFERENCES chess_games_v20(id),
  game_version INTEGER NOT NULL CHECK (game_version >= 1),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  target_bot_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'dispatched', 'failed', 'cancelled')),
  work_ids_json TEXT CHECK (work_ids_json IS NULL OR json_valid(work_ids_json)),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (game_id, game_version)
) STRICT;
INSERT INTO chess_games_v20 (id,channel_id,white_principal_id,black_principal_id,title,initial_fen,fen,pgn,moves_json,status,result,turn,ply,version,created_at,updated_at) SELECT id,channel_id,white_principal_id,black_principal_id,title,initial_fen,fen,pgn,moves_json,status,result,turn,ply,version,created_at,updated_at FROM chess_games;
INSERT INTO chess_positions_v20 SELECT * FROM chess_positions;
INSERT INTO chess_turn_intents_v20 SELECT * FROM chess_turn_intents;
DROP TABLE chess_positions;
DROP TABLE chess_turn_intents;
DROP TABLE chess_games;
ALTER TABLE chess_games_v20 RENAME TO chess_games;
ALTER TABLE chess_positions_v20 RENAME TO chess_positions;
ALTER TABLE chess_turn_intents_v20 RENAME TO chess_turn_intents;
CREATE INDEX chess_games_channel_updated ON chess_games(channel_id, updated_at DESC, id DESC);
CREATE INDEX chess_positions_channel_created ON chess_positions(channel_id, created_at DESC, id DESC);
CREATE INDEX chess_turn_intents_due ON chess_turn_intents(status, created_at, id);
CREATE TRIGGER chess_players_insert BEFORE INSERT ON chess_games
WHEN (NEW.white_principal_id NOT IN ('engine_stockfish_0','engine_stockfish_1','engine_stockfish_2','engine_stockfish_3','engine_stockfish_4','engine_stockfish_5','engine_stockfish_6','engine_stockfish_7','engine_stockfish_8','engine_stockfish_9','engine_stockfish_10','engine_stockfish_11','engine_stockfish_12','engine_stockfish_13','engine_stockfish_14','engine_stockfish_15','engine_stockfish_16','engine_stockfish_17','engine_stockfish_18','engine_stockfish_19','engine_stockfish_20') AND NOT EXISTS (SELECT 1 FROM channel_members WHERE channel_id=NEW.channel_id AND principal_id=NEW.white_principal_id))
 OR (NEW.black_principal_id NOT IN ('engine_stockfish_0','engine_stockfish_1','engine_stockfish_2','engine_stockfish_3','engine_stockfish_4','engine_stockfish_5','engine_stockfish_6','engine_stockfish_7','engine_stockfish_8','engine_stockfish_9','engine_stockfish_10','engine_stockfish_11','engine_stockfish_12','engine_stockfish_13','engine_stockfish_14','engine_stockfish_15','engine_stockfish_16','engine_stockfish_17','engine_stockfish_18','engine_stockfish_19','engine_stockfish_20') AND NOT EXISTS (SELECT 1 FROM channel_members WHERE channel_id=NEW.channel_id AND principal_id=NEW.black_principal_id))
BEGIN SELECT RAISE(ABORT, 'chess player must be a channel member or supported engine'); END;
CREATE TRIGGER chess_turn_target_insert BEFORE INSERT ON chess_turn_intents
WHEN NEW.target_bot_id NOT IN ('engine_stockfish_0','engine_stockfish_1','engine_stockfish_2','engine_stockfish_3','engine_stockfish_4','engine_stockfish_5','engine_stockfish_6','engine_stockfish_7','engine_stockfish_8','engine_stockfish_9','engine_stockfish_10','engine_stockfish_11','engine_stockfish_12','engine_stockfish_13','engine_stockfish_14','engine_stockfish_15','engine_stockfish_16','engine_stockfish_17','engine_stockfish_18','engine_stockfish_19','engine_stockfish_20') AND NOT EXISTS (SELECT 1 FROM bots WHERE id=NEW.target_bot_id)
BEGIN SELECT RAISE(ABORT, 'invalid chess turn target'); END;
CREATE TRIGGER chess_players_update BEFORE UPDATE ON chess_games
WHEN (NEW.white_principal_id NOT IN ('engine_stockfish_0','engine_stockfish_1','engine_stockfish_2','engine_stockfish_3','engine_stockfish_4','engine_stockfish_5','engine_stockfish_6','engine_stockfish_7','engine_stockfish_8','engine_stockfish_9','engine_stockfish_10','engine_stockfish_11','engine_stockfish_12','engine_stockfish_13','engine_stockfish_14','engine_stockfish_15','engine_stockfish_16','engine_stockfish_17','engine_stockfish_18','engine_stockfish_19','engine_stockfish_20') AND NOT EXISTS (SELECT 1 FROM channel_members WHERE channel_id=NEW.channel_id AND principal_id=NEW.white_principal_id))
 OR (NEW.black_principal_id NOT IN ('engine_stockfish_0','engine_stockfish_1','engine_stockfish_2','engine_stockfish_3','engine_stockfish_4','engine_stockfish_5','engine_stockfish_6','engine_stockfish_7','engine_stockfish_8','engine_stockfish_9','engine_stockfish_10','engine_stockfish_11','engine_stockfish_12','engine_stockfish_13','engine_stockfish_14','engine_stockfish_15','engine_stockfish_16','engine_stockfish_17','engine_stockfish_18','engine_stockfish_19','engine_stockfish_20') AND NOT EXISTS (SELECT 1 FROM channel_members WHERE channel_id=NEW.channel_id AND principal_id=NEW.black_principal_id))
BEGIN SELECT RAISE(ABORT, 'chess player must be a channel member or supported engine'); END;
CREATE TRIGGER chess_turn_target_update BEFORE UPDATE ON chess_turn_intents
WHEN NEW.target_bot_id NOT IN ('engine_stockfish_0','engine_stockfish_1','engine_stockfish_2','engine_stockfish_3','engine_stockfish_4','engine_stockfish_5','engine_stockfish_6','engine_stockfish_7','engine_stockfish_8','engine_stockfish_9','engine_stockfish_10','engine_stockfish_11','engine_stockfish_12','engine_stockfish_13','engine_stockfish_14','engine_stockfish_15','engine_stockfish_16','engine_stockfish_17','engine_stockfish_18','engine_stockfish_19','engine_stockfish_20') AND NOT EXISTS (SELECT 1 FROM bots WHERE id=NEW.target_bot_id)
BEGIN SELECT RAISE(ABORT, 'invalid chess turn target'); END;
`;
