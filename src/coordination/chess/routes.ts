import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import type { CoordinationApplication } from '../app/types.js';
import type { CoordinationLifecycle } from '../app/lifecycle.js';
import { CoordinationHttpError } from '../http/errors.js';
import { coordinationIdempotencyKey, requireCoordinationAuth, requireCoordinationContext, requireCoordinationMetadata, requireIdempotencyKey } from '../http/middleware.js';

const invalid = () => new CoordinationHttpError('request_invalid', 400, false);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value.length) throw invalid();
  return value;
}
function optionalString(value: unknown): string | undefined { return value === undefined ? undefined : string(value); }
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}
function queryLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 200) throw invalid();
  return Number(value);
}
function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => void handler(request, response).catch(error => {
    if (response.headersSent) response.destroy(); else next(error);
  });
}
function reference(game: { id: string; version: number; ply: number }) {
  return { boardReference: { kind: 'chess_game', gameId: game.id, sharedVersion: game.version, sharedPly: game.ply,
    url: `home23://chess/games/${encodeURIComponent(game.id)}?sharedVersion=${game.version}&sharedPly=${game.ply}` } };
}
export function mountChessRoutes(router: Express, application: CoordinationApplication, lifecycle: CoordinationLifecycle) {
  const read = requireCoordinationAuth(application, ['product:read']);
  const write = requireCoordinationAuth(application, ['product:read', 'message:send']);
  const json = express.json({ limit: application.capabilities().limits.jsonBodyBytes });
  const service = (mutation = false) => {
    if (!(mutation ? application.capabilities().capabilities.chessMutation : application.capabilities().capabilities.chessRead) || !application.services.chess) throw new CoordinationHttpError('capability_unavailable', 503, true, { capability: mutation ? 'chessMutation' : 'chessRead' });
    return application.services.chess;
  };
  const actor = (response: Response) => ({ principalId: requireCoordinationContext(response).principalId });
  const listArgs = (request: Request) => ({ channelId: optionalString(request.query.channelId), limit: queryLimit(request.query.limit), cursor: optionalString(request.query.cursor) });
  router.get('/api/v1/chess/stats', read, route(async (_request, response) => { response.json(service().statistics(actor(response))); }));
  router.get('/api/v1/chess/options', read, route(async (_request, response) => { response.json(service().engineOptions()); }));
  router.post('/api/v1/chess/analysis', read, json, route(async (request, response) => {
    const body=object(request.body);
    if(body.moves !== undefined && (!Array.isArray(body.moves) || body.moves.length > 1000 || body.moves.some(move=>typeof move!=='string'))) throw invalid();
    const controller=new AbortController(); const stop=()=>controller.abort();
    response.once('close',stop);
    try { response.json(await service().analyze({fen:string(body.fen),...(body.moves ? {moves:body.moves as string[]} : {})},actor(response),controller.signal)); }
    finally { response.off('close',stop); }
  }));
  router.get('/api/v1/chess/games', read, route(async (request, response) => { response.json(service().list(listArgs(request), actor(response))); }));
  router.post('/api/v1/chess/games', write, requireIdempotencyKey(application), json, route(async (request, response) => {
    const body = object(request.body), players = object(body.players);
    const game = service(true).create({ channelId: string(body.channelId), players: { white: string(players.white), black: string(players.black) }, title: optionalString(body.title), initialPgn: optionalString(body.initialPgn), ...(body.automation !== undefined ? {automation:{maxPlies:integer(object(body.automation).maxPlies)}} : {}), ...(body.startPaused !== undefined ? {startPaused:body.startPaused as boolean} : {}) }, actor(response), coordinationIdempotencyKey(response));
    response.status(201).json({ game, ...reference(game) });
  }));
  router.get('/api/v1/chess/games/:gameId', read, route(async (request, response) => {
    const game = service().get(string(request.params.gameId), actor(response)); response.json({ game, ...reference(game) });
  }));
  router.post('/api/v1/chess/games/:gameId/moves', write, requireIdempotencyKey(application), json, route(async (request, response) => {
    const body = object(request.body);
    const game = service(true).move(string(request.params.gameId), { expectedVersion: integer(body.expectedVersion), from: string(body.from), to: string(body.to), promotion: optionalString(body.promotion) }, actor(response), coordinationIdempotencyKey(response));
    response.json({ game, ...reference(game) });
  }));
  router.post('/api/v1/chess/games/:gameId/control', write, requireIdempotencyKey(application), json, route(async (request, response) => {
    const body = object(request.body), action = string(body.action);
    if (!['pause', 'resume', 'resign', 'retry_turn', 'step'].includes(action)) throw invalid();
    const game = service(true).control(string(request.params.gameId), { expectedVersion: integer(body.expectedVersion), action: action as 'pause' | 'resume' | 'resign' | 'retry_turn' | 'step' }, actor(response), coordinationIdempotencyKey(response));
    response.json({ game, ...reference(game) });
  }));
  router.get('/api/v1/chess/games/:gameId/pgn', read, route(async (request, response) => {
    const pgn = service().exportPgn(string(request.params.gameId), actor(response));
    response.set('Content-Type', 'application/x-chess-pgn; charset=utf-8').set('Cache-Control', 'private, no-store').send(pgn);
  }));
  router.get('/api/v1/chess/positions', read, route(async (request, response) => { response.json(service().listPositions({ ...listArgs(request), channelId: optionalString(request.query.channelId) }, actor(response))); }));
  router.post('/api/v1/chess/positions', write, requireIdempotencyKey(application), json, route(async (request, response) => {
    const body = object(request.body);
    const position = service(true).savePosition(body as Parameters<ReturnType<typeof service>['savePosition']>[0], actor(response), coordinationIdempotencyKey(response));
    response.status(201).json({ position, boardReference: { kind: 'chess_position', positionId: position.id, url: `home23://chess/positions/${encodeURIComponent(position.id)}` } });
  }));
  router.get('/api/v1/chess/positions/:positionId', read, route(async (request, response) => { response.json({ position: service().getPosition(string(request.params.positionId), actor(response)) }); }));
  router.get('/api/v1/chess/games/:gameId/stream', read, route(async (request, response) => {
    const chess = service(), gameId = string(request.params.gameId), viewer = actor(response);
    let snapshot = chess.get(gameId, viewer);
    const controller = new AbortController(), stop = () => controller.abort();
    request.once('aborted', stop); response.once('close', stop);
    response.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    response.flushHeaders();
    const accessToken = request.get('authorization')!.slice(7), metadata = requireCoordinationMetadata(response);
    let previous = '', lastWrite = Date.now();
    try {
      while (!controller.signal.aborted) {
        if (lifecycle.state() !== 'accepting') break;
        await application.services.auth.validateAccessToken({ accessToken, network: metadata.networkEvidence, requiredScopes: ['product:read'] });
        snapshot = chess.get(gameId, viewer);
        const { moves: _moves, ...summary } = snapshot;
        const encoded = JSON.stringify({ ...summary, lastMove: snapshot.moves.at(-1) ?? null });
        if (encoded !== previous) {
          const frame = `event: snapshot\ndata: ${encoded}\n\n`;
          if (Buffer.byteLength(frame) > 48_000 || response.writableLength > 256_000 || !response.write(frame)) break;
          previous = encoded;
          lastWrite = Date.now();
        } else if (Date.now() - lastWrite >= 15_000) {
          if (!response.write(': heartbeat\n\n')) break;
          lastWrite = Date.now();
        }
        await new Promise<void>(resolve => {
          const timer = setTimeout(done, 1000);
          function done() { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); }
          controller.signal.addEventListener('abort', done, { once: true });
        });
      }
    } catch { /* A failed reauthorization or inaccessible game closes the private stream. */ }
    finally { controller.abort(); request.off('aborted', stop); response.off('close', stop); response.end(); }
  }));
}
