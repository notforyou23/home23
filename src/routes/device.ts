import type { Request, Response } from 'express';
import type { DeviceRegistry } from '../push/device-registry.js';

export interface DeviceRouteConfig {
  agentName: string;
  registry: DeviceRegistry;
  token?: string;
}

function checkAuth(req: Request, res: Response, token?: string): boolean {
  if (!token) return true;
  const h = req.headers.authorization;
  if (!h || h !== `Bearer ${token}`) {
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
    });
    res.json({
      ok: true,
      registered: true,
      agent_id: config.agentName,
      registered_chat_ids: result.chat_ids,
      ignored_chat_ids: [],
      updated_at: result.last_seen_at,
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
