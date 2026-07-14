import { json, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { DeviceRegistry } from '../push/device-registry.js';

interface QueryCredentialAuthority {
  issue(input: {
    audience: 'device';
    credentialId: string;
    requesterKind: 'device';
    generation: number;
    expiresAt: string;
  }): string;
}

export interface DeviceRouteConfig {
  agentName: string;
  registry: DeviceRegistry;
  token?: string;
  queryCredentialAuthority?: QueryCredentialAuthority;
  now?: () => number | string | Date;
}

function checkAuth(req: Request, res: Response, token?: string): boolean {
  if (!token) return true;
  const h = req.headers.authorization;
  const wanted = Buffer.from(`Bearer ${token}`, 'utf8');
  const supplied = typeof h === 'string' ? Buffer.from(h, 'utf8') : Buffer.alloc(0);
  const comparable = supplied.length === wanted.length ? supplied : Buffer.alloc(wanted.length);
  if (!timingSafeEqual(comparable, wanted) || supplied.length !== wanted.length) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

/** POST /api/device/register — register a device for push notifications. */
export function createRegisterDeviceHandler(config: DeviceRouteConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const {
      device_token,
      agent_id,
      chat_ids,
      bundle_id,
      env,
      platform,
      app_build,
      contract_version,
      capabilities_hash,
      installation_id,
      query_notifications,
    } = req.body ?? {};

    if (!device_token || typeof device_token !== 'string' || !/^[0-9a-fA-F]{32,}$/.test(device_token)) {
      res.status(400).json({ error: 'valid device_token (hex) required' }); return;
    }
    if (!Array.isArray(chat_ids) || !chat_ids.every(c => typeof c === 'string')) {
      res.status(400).json({ error: 'chat_ids: string[] required' }); return;
    }
    if (!bundle_id || typeof bundle_id !== 'string') {
      res.status(400).json({ error: 'bundle_id required' }); return;
    }
    if (env !== 'sandbox' && env !== 'production') {
      res.status(400).json({ error: 'env must be sandbox or production' }); return;
    }
    if (agent_id != null && agent_id !== config.agentName) {
      res.status(400).json({ error: `agent_id must match this bridge (${config.agentName})` }); return;
    }
    if (platform != null && typeof platform !== 'string') {
      res.status(400).json({ error: 'platform must be a string' }); return;
    }
    if (query_notifications != null && typeof query_notifications !== 'boolean') {
      res.status(400).json({ error: 'query_notifications must be a boolean' }); return;
    }
    if (installation_id != null
        && (typeof installation_id !== 'string'
          || !INSTALLATION_ID_PATTERN.test(installation_id))) {
      res.status(400).json({ error: 'valid installation_id required' }); return;
    }
    if (query_notifications === true && installation_id == null) {
      res.status(400).json({ error: 'installation_id required for query notifications' }); return;
    }

    const result = config.registry.register({
      device_token,
      agent_id: config.agentName,
      chat_ids,
      bundle_id,
      env,
      platform,
      app_build,
      contract_version,
      capabilities_hash,
      installation_id: installation_id ?? undefined,
      query_notifications: query_notifications ?? undefined,
    });
    res.json({
      ok: true,
      registered: true,
      agent_id: config.agentName,
      registered_chat_ids: result.chat_ids,
      ignored_chat_ids: [],
      updated_at: result.last_seen_at,
      installation_id: result.installation_id ?? null,
      query_notifications: result.query_notifications === true,
      device: result,
    });
  };
}

/** DELETE /api/device/register — unregister a device entirely. */
export function createUnregisterDeviceHandler(config: DeviceRouteConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const { device_token, bundle_id, chat_ids } = req.body ?? {};
    if (!device_token || typeof device_token !== 'string' || !bundle_id || typeof bundle_id !== 'string') {
      res.status(400).json({ error: 'device_token and bundle_id required' }); return;
    }

    if (chat_ids != null) {
      if (!Array.isArray(chat_ids) || chat_ids.length === 0 || !chat_ids.every(chatId => typeof chatId === 'string')) {
        res.status(400).json({ error: 'chat_ids must be a non-empty string[] when provided' }); return;
      }
      const result = config.registry.unregisterChats(device_token, bundle_id, Array.from(new Set(chat_ids)));
      res.json({
        ok: true,
        agent_id: config.agentName,
        found: result.found,
        unregistered: result.device_removed,
        device_unregistered: result.device_removed,
        removed_chat_ids: result.removed_chat_ids,
        remaining_chat_ids: result.remaining_chat_ids,
        updated_at: result.updated_at,
      });
      return;
    }

    const removed = config.registry.unregister(device_token, bundle_id);
    res.json({
      ok: true,
      agent_id: config.agentName,
      unregistered: removed,
      device_unregistered: removed,
      removed_chat_ids: [],
      remaining_chat_ids: [],
    });
  };
}

/** GET /api/device/registry — diagnostic, returns the full list. */
export function createListDevicesHandler(config: DeviceRouteConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    res.json({
      devices: config.registry.list().map((device) => ({
        ...device,
        agent_id: device.agent_id || config.agentName,
        updated_at: device.last_seen_at || device.registered_at,
      })),
    });
  };
}

const QUERY_CREDENTIAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const QUERY_CREDENTIAL_BODY_LIMIT_BYTES = 2 * 1024;

/** Strict bounded parser for the enrollment route; must be mounted before broad Chat parsing. */
export function createQueryCredentialJsonParser(): RequestHandler {
  const parser = json({ limit: QUERY_CREDENTIAL_BODY_LIMIT_BYTES, strict: true });
  return (req: Request, res: Response, next: NextFunction): void => {
    parser(req, res, (error?: unknown) => {
      if (!error) {
        next();
        return;
      }
      const status = (error as { status?: number }).status === 413 ? 413 : 400;
      res.status(status).json({ error: 'invalid_request' });
    });
  };
}

/** POST /api/device/query-credential — enroll this installation for Query notebook access. */
export function createQueryCredentialHandler(config: DeviceRouteConfig) {
  return (req: Request, res: Response): void => {
    if (!config.token || !config.queryCredentialAuthority) {
      res.status(503).json({ error: 'query_credential_unavailable' });
      return;
    }
    if (!checkAuth(req, res, config.token)) return;

    const body = req.body;
    if (!body || Array.isArray(body) || typeof body !== 'object'
        || Object.keys(body).length !== 2
        || !Object.hasOwn(body, 'installationId')
        || !Object.hasOwn(body, 'agent')
        || typeof body.installationId !== 'string'
        || !INSTALLATION_ID_PATTERN.test(body.installationId)
        || body.agent !== config.agentName) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    try {
      const rawNow = (config.now ?? Date.now)();
      const now = rawNow instanceof Date ? rawNow.getTime()
        : typeof rawNow === 'string' ? Date.parse(rawNow) : rawNow;
      if (!Number.isFinite(now)) throw new Error('invalid clock');
      const enrollment = config.registry.enrollQueryCredential({
        installationId: body.installationId,
        requesterAgent: config.agentName,
      });
      const expiresAt = new Date(Number(now) + QUERY_CREDENTIAL_TTL_MS).toISOString();
      const token = config.queryCredentialAuthority.issue({
        audience: 'device',
        credentialId: enrollment.credential_id,
        requesterKind: 'device',
        generation: enrollment.credential_generation,
        expiresAt,
      });
      res.json({
        credentialId: enrollment.credential_id,
        token,
        expiresAt,
        generation: enrollment.credential_generation,
      });
    } catch {
      res.status(503).json({ error: 'query_credential_unavailable' });
    }
  };
}
