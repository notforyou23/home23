import type { NativeChessService } from './service.js';
import { ChessError } from './service.js';
import type { M11Database } from '../work/types.js';
import type { CoordinationTurnOrigin } from '../../agent/types.js';

/** Derive a bot's active chess turn solely from its fenced canonical Work. */
export function resolveChessMoveTurnId(database: M11Database, origin: CoordinationTurnOrigin, principalId: string, gameId: string): string | undefined {
  return database.readOne<{ id: string }>(`SELECT i.id FROM chess_turn_intents i
    JOIN chess_games g ON g.id=i.game_id AND g.version=i.game_version AND g.status='active'
    JOIN events e ON e.aggregate_kind='scheduled_channel_run' AND e.aggregate_version=1 AND e.aggregate_id=i.run_id
    JOIN works w ON w.origin_message_id=json_extract(e.payload_json,'$.messageId')
      AND w.channel_id=i.channel_id AND w.target_principal_id=i.target_bot_id
      AND w.kind IN ('channel.bot_turn','bot_turn')
    WHERE i.game_id=? AND i.target_bot_id=? AND i.status IN ('queued','dispatched') AND w.id=?
    LIMIT 1`, gameId, principalId, origin.workId)?.id;
}

const required = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value) throw new ChessError('invalid_request', `${field} must be a nonempty string`);
  return value;
};
const version = (value: unknown, field = 'expectedVersion'): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ChessError('invalid_request', `${field} must be a nonnegative integer`);
  return value;
};
const optional = (value: unknown, field: string): string | undefined => value === undefined ? undefined : required(value, field);
const limit = (value: unknown): number | undefined => value === undefined ? undefined : version(value, 'limit');
function gameReference(game: { id: string; version: number; ply: number }) {
  return { boardReference: { kind: 'chess_game', gameId: game.id, sharedVersion: game.version, sharedPly: game.ply,
    url: `home23://chess/games/${encodeURIComponent(game.id)}?sharedVersion=${game.version}&sharedPly=${game.ply}` } };
}
function positionReference(position: { id: string }) {
  return { boardReference: { kind: 'chess_position', positionId: position.id,
    url: `home23://chess/positions/${encodeURIComponent(position.id)}` } };
}
export function executeChessOperation(service: NativeChessService, actor: { principalId: string }, args: Record<string, unknown>, key: string): unknown {
  const gameId = () => required(args.gameId, 'gameId');
  const listArgs = () => ({ channelId: optional(args.channelId, 'channelId'), limit: limit(args.limit), cursor: optional(args.cursor, 'cursor') });
  switch (args.operation) {
    case 'chess_list': return service.list(listArgs(), actor);
    case 'chess_get': { const game = service.get(gameId(), actor); return { game, ...gameReference(game) }; }
    case 'chess_create': {
      const players = args.players;
      if (!players || typeof players !== 'object' || Array.isArray(players)) throw new ChessError('invalid_request', 'Players are required');
      const game = service.create({ channelId: required(args.channelId, 'channelId'), players: { white: required((players as Record<string, unknown>).white, 'players.white'), black: required((players as Record<string, unknown>).black, 'players.black') }, title: optional(args.title, 'title'), initialPgn: optional(args.initialPgn, 'initialPgn') }, actor, key);
      return { game, ...gameReference(game) };
    }
    case 'chess_move': {
      const game = service.move(gameId(), { expectedVersion: version(args.expectedVersion), from: required(args.from, 'from'), to: required(args.to, 'to'), promotion: optional(args.promotion, 'promotion') }, actor, key);
      return { game, ...gameReference(game) };
    }
    case 'chess_control': {
      const action = required(args.action, 'action');
      if (!['pause', 'resume', 'resign', 'retry_turn'].includes(action)) throw new ChessError('invalid_request', 'Unknown control action');
      const game = service.control(gameId(), { expectedVersion: version(args.expectedVersion), action: action as 'pause' | 'resume' | 'resign' | 'retry_turn' }, actor, key);
      return { game, ...gameReference(game) };
    }
    case 'chess_export': return { pgn: service.exportPgn(gameId(), actor) };
    case 'chess_list_positions': return service.listPositions({ ...listArgs(), channelId: required(args.channelId, 'channelId') }, actor);
    case 'chess_get_position': { const position = service.getPosition(required(args.positionId, 'positionId'), actor); return { position, ...positionReference(position) }; }
    case 'chess_save_position': {
      const position = service.savePosition(args as Parameters<NativeChessService['savePosition']>[0], actor, key);
      return { position, ...positionReference(position) };
    }
    default: throw new ChessError('invalid_request', 'Unknown Chess operation');
  }
}
