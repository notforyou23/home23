import type { NativeChessService } from './service.js';
import type { ScheduledChannelTurn } from '../app/scheduled-turns.js';

/** The durable intent belongs to the game transaction; canonical Work owns execution. */
export function createChessTurnDispatcher(options: {
  chess: NativeChessService;
  accepting(): boolean;
  run(input: ScheduledChannelTurn, botId: string): Promise<{ state: string; workIds?: string[]; error?: string }>;
}) {
  let running = false;
  return async function reconcile() {
    if (running || !options.accepting()) return;
    running = true;
    try {
      for (const turn of options.chess.dueTurns(20)) {
        if (!options.accepting()) break;
        try {
          const result = await options.run({ runId: turn.runId, jobId: `native-chess:${turn.gameId}:${turn.gameVersion}`,
            channelId: turn.channelId, targetBotId: turn.targetBotId, prompt: turn.prompt }, turn.targetBotId);
          if (['failed', 'cancelled', 'succeeded'].includes(result.state)) {
            // A successful model response alone is not a chess move. A move atomically supersedes this intent.
            options.chess.settleTurn(turn.id, { status: 'failed', workIds: result.workIds ?? [],
              error: result.state === 'succeeded' ? 'The bot finished without making a move. Retry its turn when ready.' : 'The bot turn did not complete. Retry when ready.' });
          } else if (result.workIds?.length) {
            options.chess.settleTurn(turn.id, { status: 'dispatched', workIds: result.workIds });
          }
        } catch (error) {
          if (!options.accepting()) break;
          if (['server_busy', 'turn_in_progress', 'deadline_exceeded', 'connection_lost', 'request_rate_limited'].includes(String((error as { code?: string }).code))) continue;
          options.chess.settleTurn(turn.id, { status: 'failed', error: 'Bot turn could not be admitted. Check that the player is an active channel member, then retry.' });
        }
      }
    } finally { running = false; }
  };
}
