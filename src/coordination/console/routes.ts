import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { pipeline } from 'node:stream/promises';
import type { CoordinationApplication } from '../app/types.js';
import type { CoordinationLifecycle } from '../app/lifecycle.js';
import { CoordinationHttpError } from '../http/errors.js';
import { coordinationIdempotencyKey, requireCoordinationAuth, requireCoordinationContext, requireCoordinationMetadata, requireIdempotencyKey } from '../http/middleware.js';
import { ConsoleReadError } from './types.js';

function text(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.length) throw new CoordinationHttpError('request_invalid', 400, false, { field: name });
  return value;
}
function limit(value: unknown): number | undefined {
  const raw = text(value, 'limit');
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > 200) throw new CoordinationHttpError('request_invalid', 400, false);
  return Number(raw);
}
function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction) => void handler(request,response).catch(error => {
    if (response.headersSent) { response.destroy(); return; }
    next(error instanceof ConsoleReadError ? new CoordinationHttpError(error.code,error.status,false) : error);
  });
}
/** A paused socket stops the generator, so no subsequent disk page is read. */
async function write(response: Response, frame: string, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted || response.destroyed) return false;
  if (Buffer.byteLength(frame) > 1_048_576 || response.writableLength > 1_048_576) return false;
  if (response.write(frame)) return true;
  return new Promise(resolve => {
    const finish = (ok: boolean) => { clearTimeout(timer); response.off('drain', drained); signal.removeEventListener('abort', aborted); resolve(ok); };
    const drained = () => finish(true), aborted = () => finish(false);
    const timer = setTimeout(() => finish(false), 15_000);
    response.once('drain',drained); signal.addEventListener('abort',aborted,{once:true});
  });
}
export function mountConsoleRoutes(router: Express, application: CoordinationApplication, lifecycle: CoordinationLifecycle) {
  const read = requireCoordinationAuth(application,['product:read']);
  const command = requireCoordinationAuth(application,['product:read','message:send']);
  const bodyParser = express.json({limit:application.capabilities().limits.jsonBodyBytes});
  const service = () => {
    if (!application.capabilities().capabilities.consoleRead || !application.services.console) throw new CoordinationHttpError('capability_unavailable',503,true,{capability:'consoleRead'});
    return application.services.console;
  };
  router.get('/api/v1/console/sources',read,route(async (request,response) => {
    const state = text(request.query.state,'state');
    if (state !== undefined && state !== 'active' && state !== 'recent') throw new CoordinationHttpError('request_invalid',400,false);
    response.json(await service().list({state,limit:limit(request.query.limit),cursor:text(request.query.cursor,'cursor')},requireCoordinationContext(response)));
  }));
  router.get('/api/v1/console/sources/:sourceId',read,route(async (request,response) => {
    response.json({source:await service().source(text(request.params.sourceId,'sourceId')!,requireCoordinationContext(response))});
  }));
  router.get('/api/v1/console/sources/:sourceId/records',read,route(async (request,response) => {
    response.json(await service().history(text(request.params.sourceId,'sourceId')!,{before:text(request.query.before,'before'),limit:limit(request.query.limit)},requireCoordinationContext(response)));
  }));
  router.get('/api/v1/console/sources/:sourceId/records/:recordId/raw',read,route(async (request,response) => {
    const raw=await service().raw(text(request.params.sourceId,'sourceId')!,text(request.params.recordId,'recordId')!,requireCoordinationContext(response));
    response.setHeader('content-type',raw.contentType);
    response.setHeader('content-length',raw.byteLength);
    response.setHeader('cache-control','private, no-store');
    response.setHeader('x-content-type-options','nosniff');
    await pipeline(raw.stream,response);
  }));
  router.get('/api/v1/console/stream',read,route(async (request,response) => {
    const consoleService=service(), context=requireCoordinationContext(response);
    const scope=text(request.query.scope,'scope');
    if (scope!==undefined && scope!=='active') throw new CoordinationHttpError('request_invalid',400,false);
    const sourceIds=request.query.sourceId===undefined?[]:Array.isArray(request.query.sourceId)?request.query.sourceId.map(v=>text(v,'sourceId')!):[text(request.query.sourceId,'sourceId')!];
    const after=text(request.query.after,'after'), last=request.get('last-event-id');
    if (after && last && after!==last) throw new CoordinationHttpError('request_invalid',400,false,{},'Conflicting resume cursors.');
    const prepared=await consoleService.prepare({sourceIds,scope,after:after??last},context);
    const controller=new AbortController();
    const disconnected=()=>controller.abort();
    response.once('close',disconnected); request.once('aborted',disconnected);
    response.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    response.flushHeaders();
    const accessToken=request.get('authorization')!.slice(7), metadata=requireCoordinationMetadata(response);
    try {
      const reauthorize=async()=> { if(lifecycle.state()!=="accepting") throw new CoordinationHttpError("server_draining",503,true); await application.services.auth.validateAccessToken({accessToken,network:metadata.networkEvidence,requiredScopes:['product:read']}); };
      for await(const frame of consoleService.stream(prepared,context,controller.signal,reauthorize)) {
        const encoded=`${frame.id?`id: ${frame.id}\n`:''}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
        if (!await write(response,encoded,controller.signal)) break;
      }
    } catch(error) {
      // Never expose disk paths or internal transport errors to an established stream.
      const reason=error instanceof ConsoleReadError || error instanceof CoordinationHttpError?error.code:'stream_unavailable';
      if (!controller.signal.aborted) await write(response,`event: gap\ndata: ${JSON.stringify({sourceId:null,reason})}\n\n`,controller.signal);
    } finally {
      controller.abort(); response.off('close',disconnected); request.off('aborted',disconnected);
      response.end();
    }
  }));
  for(const operation of ['cancel','steer'] as const) router.post(`/api/v1/executions/:sourceId/${operation}`,command,requireIdempotencyKey(application),bodyParser,route(async(request,response)=> {
    if (!application.capabilities().capabilities.consoleControl) throw new CoordinationHttpError('capability_unavailable',503,true,{capability:'consoleControl'});
    const body=request.body;
    if (!body || typeof body!=='object' || Array.isArray(body) || typeof body.expectedExecutionId!=='string' || !body.expectedExecutionId || body.expectedExecutionId.length>256 || (operation==='steer'&&(typeof body.text!=='string'||!body.text.trim()||Buffer.byteLength(body.text)>16_384))) throw new CoordinationHttpError('request_invalid',400,false);
    const receipt=await service().control(text(request.params.sourceId,'sourceId')!,operation,{expectedExecutionId:body.expectedExecutionId,text:operation==='steer'?body.text:undefined,idempotencyKey:coordinationIdempotencyKey(response)},requireCoordinationContext(response));
    response.status(receipt.status==='cancellation_requested'||receipt.status==='queued'?202:200).json(receipt);
  }));
}
