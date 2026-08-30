import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export interface LegacyBridgeAuthConfig {
  staticToken?: string;
  coordinationOrigin?: string;
  fetchImpl?: typeof fetch;
}

function exactStaticBearer(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header) return false;
  const wanted = Buffer.from(`Bearer ${token}`, 'utf8');
  const supplied = Buffer.from(header, 'utf8');
  const comparable = supplied.length === wanted.length ? supplied : Buffer.alloc(wanted.length);
  return supplied.length === wanted.length && timingSafeEqual(comparable, wanted);
}

function suppliedBearer(request: Request): string | undefined {
  const header = request.get('authorization');
  if (header?.startsWith('Bearer ') && header.length > 7 && header.length <= 4103) return header;
  const queryToken = request.query.token;
  if (typeof queryToken === 'string' && queryToken.length > 0 && queryToken.length <= 4096) {
    return `Bearer ${queryToken}`;
  }
  return undefined;
}

/**
 * Compatibility boundary for legacy bridge routes. The configured static
 * bridge bearer remains accepted during migration. Coordinator credentials
 * are checked online for scope plus current session/device/revocation state on
 * every request, then translated only inside this process for unchanged route
 * handlers. No coordinator credential is logged or persisted by the bridge.
 */
export function createLegacyBridgeAuthMiddleware(config: LegacyBridgeAuthConfig): RequestHandler {
  const fetchImpl = config.fetchImpl ?? fetch;
  const origin = config.coordinationOrigin?.replace(/\/$/, '');
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const bearer = suppliedBearer(request);
    if (exactStaticBearer(bearer, config.staticToken)) {
      next();
      return;
    }
    if (!origin) {
      if (!config.staticToken) next();
      else response.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (!bearer) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const upstream = await fetchImpl(`${origin}/api/v1/legacy-bridge/session`, {
        method: 'GET',
        headers: { Authorization: bearer, Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!upstream.ok) {
        response.status(upstream.status === 401 || upstream.status === 403 ? 401 : 503)
          .json({ error: upstream.status === 401 || upstream.status === 403 ? 'Unauthorized' : 'Auth service unavailable' });
        return;
      }
      const receipt = await upstream.json() as { ok?: unknown; scopes?: unknown };
      if (receipt.ok !== true || !Array.isArray(receipt.scopes) || !receipt.scopes.includes('legacy-bridge:access')) {
        response.status(401).json({ error: 'Unauthorized' });
        return;
      }
      if (config.staticToken) request.headers.authorization = `Bearer ${config.staticToken}`;
      next();
    } catch {
      response.status(503).json({ error: 'Auth service unavailable' });
    }
  };
}
