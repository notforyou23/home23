export type ChessActor = { principalId: string; /** Trusted scheduled Work origin, never a client request field. */ turnId?: string };
export type ChessSide = 'w' | 'b';
export type ChessResult = '*' | '1-0' | '0-1' | '1/2-1/2';
export type ChessStatus = 'active' | 'paused' | 'finished';
export interface ChessMove { ply: number; uci: string; san: string; fen: string }
export interface ChessTurnDelivery { id: string; gameVersion: number; status: 'queued' | 'dispatched' | 'failed'; workIds: string[]; error: string | null }
export interface ChessGame {
  id: string; channelId: string; title: string; players: { white: string; black: string };
  initialFen: string; fen: string; turn: ChessSide; ply: number; moves: ChessMove[];
  status: ChessStatus; result: ChessResult; version: number; createdAt: string; updatedAt: string;
  turnDelivery?: ChessTurnDelivery;
  automation?: { maxPlies: number; remainingPlies: number };
  pauseReason?: string;
}
export interface ChessPosition {
  id: string; channelId: string; title: string; fen: string;
  annotations: { arrows: Array<{ from: string; to: string; color?: string }>; highlights: Array<{ square: string; color?: string }> };
  sourceGameId?: string; sourcePly?: number; createdBy: string; createdAt: string;
}
export interface ChessTurnIntent {
  id: string; gameId: string; gameVersion: number; channelId: string; targetBotId: string;
  runId: string; prompt: string; status: 'queued' | 'dispatched' | 'failed'; workIds: string[]; error: string | null;
}
