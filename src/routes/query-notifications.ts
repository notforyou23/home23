import { timingSafeEqual } from 'node:crypto';
import { json, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type {
  QueryTerminalNotificationInput,
  QueryTerminalNotificationReceipt,
} from '../push/apns-pusher.js';

const BODY_LIMIT_BYTES = 4 * 1024;
const OPERATION_ID_PATTERN = /^brop_[A-Za-z0-9_-]{32}$/;
const ROUTE_ID_PATTERN = /^qroute_[A-Za-z0-9_-]{32}$/;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/;
const TERMINAL_STATES = new Set(['complete', 'partial', 'failed', 'cancelled', 'interrupted']);

interface QueryNotificationPusher {
  notifyQueryTerminal(input: QueryTerminalNotificationInput): Promise<QueryTerminalNotificationReceipt>;
}

export interface QueryTerminalNotificationRouteConfig {
  agentName: string;
  bridgeToken?: string;
  pusher?: QueryNotificationPusher;
}

function plainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}

function exactKeys(value: unknown, allowed: string[]): value is Record<string, any> {
  if (!plainObject(value)) return false;
  const accepted = new Set(allowed);
  const keys = Reflect.ownKeys(value);
  return keys.length === accepted.size
    && keys.every(key => typeof key === 'string' && accepted.has(key));
}

function authorized(req: Request, token: string): boolean {
  const supplied = typeof req.headers.authorization === 'string'
    ? Buffer.from(req.headers.authorization, 'utf8') : Buffer.alloc(0);
  const wanted = Buffer.from(`Bearer ${token}`, 'utf8');
  const comparable = supplied.length === wanted.length ? supplied : Buffer.alloc(wanted.length);
  return timingSafeEqual(comparable, wanted) && supplied.length === wanted.length;
}

function validBody(value: unknown, agentName: string): value is Record<string, any> {
  if (!exactKeys(value, [
    'operationId', 'state', 'agent', 'routeId', 'generation', 'deviceIds',
  ])) return false;
  return OPERATION_ID_PATTERN.test(value.operationId)
    && TERMINAL_STATES.has(value.state)
    && value.agent === agentName
    && ROUTE_ID_PATTERN.test(value.routeId)
    && Number.isSafeInteger(value.generation) && value.generation >= 1
    && Array.isArray(value.deviceIds) && value.deviceIds.length >= 1 && value.deviceIds.length <= 64
    && value.deviceIds.every((deviceId: unknown) => (
      typeof deviceId === 'string' && INSTALLATION_ID_PATTERN.test(deviceId)
    ))
    && new Set(value.deviceIds).size === value.deviceIds.length;
}

function boundedReceipt(
  raw: QueryTerminalNotificationReceipt,
  input: QueryTerminalNotificationInput,
): QueryTerminalNotificationReceipt {
  if (!exactKeys(raw, [
    'operationId', 'routeId', 'generation', 'delivered', 'failed', 'pending',
  ])
      || raw.operationId !== input.operationId
      || raw.routeId !== input.routeId
      || raw.generation !== input.generation
      || !Array.isArray(raw.delivered)
      || !Array.isArray(raw.failed)
      || !Array.isArray(raw.pending)) {
    throw new Error('query_notification_receipt_invalid');
  }
  const allowed = new Set(input.deviceIds);
  const delivered = raw.delivered.filter((deviceId): deviceId is string => (
    typeof deviceId === 'string' && allowed.has(deviceId)
  ));
  const pending = raw.pending.filter((deviceId): deviceId is string => (
    typeof deviceId === 'string' && allowed.has(deviceId)
  ));
  const failed = raw.failed.filter((entry): entry is { deviceId: string; retryable: boolean } => (
    exactKeys(entry, ['deviceId', 'retryable'])
    && typeof entry.deviceId === 'string' && allowed.has(entry.deviceId)
    && typeof entry.retryable === 'boolean'
  )).map(entry => ({ deviceId: entry.deviceId, retryable: entry.retryable }));
  const identities = [
    ...delivered,
    ...pending,
    ...failed.map(entry => entry.deviceId),
  ];
  if (new Set(identities).size !== identities.length
      || delivered.length !== raw.delivered.length
      || pending.length !== raw.pending.length
      || failed.length !== raw.failed.length) {
    throw new Error('query_notification_receipt_invalid');
  }
  return { operationId: input.operationId, routeId: input.routeId,
    generation: input.generation, delivered, failed, pending };
}

export function createQueryNotificationJsonParser(): RequestHandler {
  const parser = json({ limit: BODY_LIMIT_BYTES, strict: true });
  return (req: Request, res: Response, next: NextFunction): void => {
    parser(req, res, (error?: unknown) => {
      if (!error) { next(); return; }
      res.status((error as { status?: number }).status === 413 ? 413 : 400)
        .json({ ok: false, error: 'invalid_request' });
    });
  };
}

export function createQueryTerminalNotificationHandler(
  config: QueryTerminalNotificationRouteConfig,
) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!AGENT_ID_PATTERN.test(config.agentName)
        || typeof config.bridgeToken !== 'string' || !config.bridgeToken
        || !config.pusher) {
      res.status(503).json({ ok: false, error: 'query_notifications_unavailable' });
      return;
    }
    if (!authorized(req, config.bridgeToken)) {
      res.status(401).json({ ok: false, error: 'unauthorized' });
      return;
    }
    if (!validBody(req.body, config.agentName)) {
      res.status(400).json({ ok: false, error: 'invalid_request' });
      return;
    }
    const input: QueryTerminalNotificationInput = {
      operationId: req.body.operationId,
      state: req.body.state,
      routeId: req.body.routeId,
      generation: req.body.generation,
      deviceIds: req.body.deviceIds,
    };
    try {
      const receipt = boundedReceipt(await config.pusher.notifyQueryTerminal(input), input);
      res.json({ ok: true, ...receipt });
    } catch {
      res.status(503).json({ ok: false, error: 'query_notification_delivery_unavailable' });
    }
  };
}
