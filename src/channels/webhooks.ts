/**
 * COSMO Home 2.3 — Webhook Channel Adapter
 *
 * Runs an Express HTTP server that receives incoming webhook
 * POST requests, authenticates via bearer token, matches
 * against configured mappings, template-substitutes the payload,
 * and forwards to the message router.
 *
 * Synchronous callers: if a mapping has deliver=true, the
 * response text is returned in the HTTP response body.
 */

import express, { type Request, type Response, type Application } from 'express';
import type { Server } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { ChannelAdapter, IncomingMessage, OutgoingResponse } from './router.js';

// ─── Config ──────────────────────────────────────────────────

export interface WebhookMapping {
  id: string;
  match: { path: string };
  sessionKey?: string;
  messageTemplate?: string;
  nameTemplate?: string;
  wakeMode?: string;
  deliver?: boolean;
}

interface WebhookConfig {
  port?: number;
  path: string;
  token: string;
  mappings: WebhookMapping[];
  sessionApi?: {
    enabled?: boolean;
    historyDir?: string;
    getBindings?: () => Array<{
      key: string;
      sessionId: string;
      lastActivity: number;
      channel: string;
      chatId: string;
    }>;
    getBindingByKey?: (key: string) => {
      key: string;
      sessionId: string;
      lastActivity: number;
      channel: string;
      chatId: string;
    } | null;
  };
}

// ─── Adapter ─────────────────────────────────────────────────

export class WebhookServer implements ChannelAdapter {
  readonly name = 'webhook';

  private config: WebhookConfig;
  private onMessage: (msg: IncomingMessage) => Promise<void>;
  private app: Application | null = null;
  private server: Server | null = null;
  private pendingResponses: Map<string, (response: OutgoingResponse) => void> = new Map();

  constructor(
    config: WebhookConfig,
    onMessage: (msg: IncomingMessage) => Promise<void>,
  ) {
    this.config = config;
    this.onMessage = onMessage;
  }

  /** Expose Express app for adding external routes */
  getApp(): Application | null {
    return this.app;
  }

  async start(): Promise<void> {
    this.app = express();
    this.app.use(express.json());

    // Register routes for each mapping
    for (const mapping of this.config.mappings) {
      const routePath = `${this.config.path}/${mapping.match.path}`.replace(/\/+/g, '/');
      this.app.post(routePath, (req: Request, res: Response) => {
        this.handleWebhook(req, res, mapping);
      });
    }

    if (this.config.sessionApi?.enabled) {
      const sessionMessagePath = `${this.config.path}/session-message`.replace(/\/+/g, '/');
      const sessionHistoryPath = `${this.config.path}/sessions/:sessionId/history`.replace(/\/+/g, '/');
      const sessionBindingsPath = `${this.config.path}/sessions/bindings`.replace(/\/+/g, '/');
      const sessionResolvePath = `${this.config.path}/sessions/resolve`.replace(/\/+/g, '/');
      const sessionHistoryByKeyPath = `${this.config.path}/sessions/history-by-key`.replace(/\/+/g, '/');
      const mediaPath = `${this.config.path}/media`.replace(/\/+/g, '/');

      this.app.post(sessionMessagePath, (req: Request, res: Response) => {
        this.handleSessionMessage(req, res);
      });

      this.app.get(sessionHistoryPath, (req: Request, res: Response) => {
        this.handleSessionHistory(req, res);
      });

      this.app.get(sessionBindingsPath, (req: Request, res: Response) => {
        this.handleSessionBindings(req, res);
      });

      this.app.get(sessionResolvePath, (req: Request, res: Response) => {
        this.handleSessionResolve(req, res);
      });

      this.app.get(sessionHistoryByKeyPath, (req: Request, res: Response) => {
        this.handleSessionHistoryByKey(req, res);
      });

      this.app.get(mediaPath, (req: Request, res: Response) => {
        this.handleMedia(req, res);
      });
    }

    // Start listening
    const port = this.config.port ?? 3100;
    return new Promise((resolve) => {
      this.server = this.app!.listen(port, () => {
        console.log(`[webhook] Listening on port ${port}, base path ${this.config.path}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          console.log('[webhook] Server stopped');
          this.server = null;
          resolve();
        });
      });
    }
  }

  async send(response: OutgoingResponse): Promise<void> {
    // Check if there's a pending synchronous caller waiting for this response
    const resolve = this.pendingResponses.get(response.chatId);
    if (resolve) {
      this.pendingResponses.delete(response.chatId);
      resolve(response);
    }
    // For non-deliver mappings, responses are fire-and-forget
    // (already sent through the router's adapter.send path)
  }

  // ── Private ───────────────────────────────────────────────

  private handleWebhook(req: Request, res: Response, mapping: WebhookMapping): void {
    // Authenticate bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${this.config.token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const payload = req.body as Record<string, unknown>;

    // Template substitution for message text
    const text = mapping.messageTemplate
      ? this.templateSubstitute(mapping.messageTemplate, payload)
      : JSON.stringify(payload);

    // Template substitution for sender name
    const senderName = mapping.nameTemplate
      ? this.templateSubstitute(mapping.nameTemplate, payload)
      : `webhook:${mapping.id}`;

    // Build session key / chat ID
    const chatId = mapping.sessionKey
      ? this.templateSubstitute(mapping.sessionKey, payload)
      : `webhook:${mapping.id}`;

    const messageId = `wh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const incoming: IncomingMessage = {
      channel: 'webhook',
      chatId,
      senderId: mapping.id,
      senderName,
      text,
      messageId,
      timestamp: Date.now(),
      metadata: {
        mappingId: mapping.id,
        wakeMode: mapping.wakeMode,
        payload,
      },
    };

    if (mapping.deliver) {
      // Synchronous mode: wait for the router to produce a response
      const responsePromise = new Promise<OutgoingResponse>((resolve) => {
        this.pendingResponses.set(chatId, resolve);
      });

      // Set a timeout so we don't hang forever
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(chatId);
        res.status(504).json({ error: 'Response timeout' });
      }, 60_000);

      this.onMessage(incoming)
        .then(() => responsePromise)
        .then((response) => {
          clearTimeout(timeout);
          res.json({
            text: response.text,
            media: this.serializeMedia(response.media),
            model: response.model,
            mode: response.mode,
            durationMs: response.durationMs,
          });
        })
        .catch((err) => {
          clearTimeout(timeout);
          console.error('[webhook] Deliver error:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Internal error' });
          }
        });
    } else {
      // Fire-and-forget: accept immediately
      this.onMessage(incoming).catch(err => {
        console.error('[webhook] onMessage error:', err);
      });
      res.json({ ok: true, messageId });
    }
  }

  private handleSessionMessage(req: Request, res: Response): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${this.config.token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text : '';
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const senderId = typeof body.senderId === 'string' ? body.senderId : 'session-api';
    const senderName = typeof body.senderName === 'string' ? body.senderName : 'session-api';
    const metadata = typeof body.metadata === 'object' && body.metadata !== null
      ? (body.metadata as Record<string, unknown>)
      : {};

    if (!text.trim()) {
      res.status(400).json({ error: 'Missing text' });
      return;
    }

    if (!sessionId.trim()) {
      res.status(400).json({ error: 'Missing sessionId' });
      return;
    }

    const chatId = `session:${sessionId}`;
    const messageId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const incoming: IncomingMessage = {
      channel: 'webhook',
      chatId,
      senderId,
      senderName,
      text,
      messageId,
      timestamp: Date.now(),
      metadata: {
        ...metadata,
        sessionApi: true,
        requestedSessionId: sessionId,
      },
    };

    const responsePromise = new Promise<OutgoingResponse>((resolve) => {
      this.pendingResponses.set(chatId, resolve);
    });

    const timeout = setTimeout(() => {
      this.pendingResponses.delete(chatId);
      res.status(504).json({ error: 'Response timeout' });
    }, 60_000);

    this.onMessage(incoming)
      .then(() => responsePromise)
      .then((response) => {
        clearTimeout(timeout);
        res.json({
          sessionId,
          chatId,
          text: response.text,
          media: this.serializeMedia(response.media),
          model: response.model,
          mode: response.mode,
          durationMs: response.durationMs,
        });
      })
      .catch((err) => {
        clearTimeout(timeout);
        console.error('[webhook] Session message error:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal error' });
        }
      });
  }

  private handleSessionHistory(req: Request, res: Response): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${this.config.token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const sessionId = req.params.sessionId;
    const historyDir = this.config.sessionApi?.historyDir;
    if (!historyDir) {
      res.status(503).json({ error: 'Session history unavailable' });
      return;
    }

    const sessionFile = join(historyDir, `${sessionId}.jsonl`);
    if (!existsSync(sessionFile)) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    try {
      const raw = readFileSync(sessionFile, 'utf8');
      const records = raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line));
      res.json({ sessionId, records });
    } catch (err) {
      console.error('[webhook] Session history error:', err);
      res.status(500).json({ error: 'Failed to read session history' });
    }
  }

  private handleSessionBindings(req: Request, res: Response): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${this.config.token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const getBindings = this.config.sessionApi?.getBindings;
    if (!getBindings) {
      res.status(503).json({ error: 'Bindings unavailable' });
      return;
    }

    res.json({ bindings: getBindings() });
  }

  private handleSessionResolve(req: Request, res: Response): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${this.config.token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const channel = typeof req.query.channel === 'string' ? req.query.channel : '';
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : '';
    if (!channel || !chatId) {
      res.status(400).json({ error: 'channel and chatId are required' });
      return;
    }

    const getBindingByKey = this.config.sessionApi?.getBindingByKey;
    if (!getBindingByKey) {
      res.status(503).json({ error: 'Binding resolution unavailable' });
      return;
    }

    const key = `${channel}:${chatId}`;
    const binding = getBindingByKey(key);
    res.json({ key, sessionId: binding?.sessionId ?? null, binding });
  }

  private handleSessionHistoryByKey(req: Request, res: Response): void {
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${this.config.token}`) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const channel = typeof req.query.channel === 'string' ? req.query.channel : '';
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : '';
    const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const limit = Number.isFinite(limitRaw) && (limitRaw as number) > 0 ? Math.floor(limitRaw as number) : undefined;

    if (!channel || !chatId) {
      res.status(400).json({ error: 'channel and chatId are required' });
      return;
    }

    const getBindingByKey = this.config.sessionApi?.getBindingByKey;
    const historyDir = this.config.sessionApi?.historyDir;
    if (!getBindingByKey || !historyDir) {
      res.status(503).json({ error: 'History-by-key unavailable' });
      return;
    }

    const key = `${channel}:${chatId}`;
    const binding = getBindingByKey(key);
    if (!binding) {
      res.json({ key, sessionId: null, records: [] });
      return;
    }

    const sessionFile = join(historyDir, `${binding.sessionId}.jsonl`);
    if (!existsSync(sessionFile)) {
      res.json({ key, sessionId: binding.sessionId, records: [] });
      return;
    }

    try {
      const raw = readFileSync(sessionFile, 'utf8');
      let records = raw
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => JSON.parse(line));
      if (limit) records = records.slice(-limit);
      res.json({ key, sessionId: binding.sessionId, records });
    } catch (err) {
      console.error('[webhook] Session history-by-key error:', err);
      res.status(500).json({ error: 'Failed to read session history' });
    }
  }

  /**
   * Replace {{payload.field}} and {{payload.nested.field}} tokens
   * with values from the request body.
   */
  private templateSubstitute(template: string, payload: Record<string, unknown>): string {
    return template.replace(/\{\{payload\.([^}]+)\}\}/g, (_match, path: string) => {
      const value = this.resolvePath(payload, path);
      if (value === undefined) return '';
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
  }

  /**
   * Resolve a dotted path like "user.name" against a nested object.
   */
  private resolvePath(obj: Record<string, unknown>, path: string): unknown {
    let current: unknown = obj;
    for (const key of path.split('.')) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[key];
    }
    return current;
  }

  private handleMedia(req: Request, res: Response): void {
    const filePath = req.query.path;
    if (!filePath || typeof filePath !== 'string') {
      res.status(400).json({ error: 'path required' });
      return;
    }

    const resolvedPath = resolve(filePath);
    if (!resolvedPath.startsWith(process.cwd()) && !resolvedPath.startsWith('/tmp/')) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }

    if (!existsSync(resolvedPath)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.sendFile(resolvedPath);
  }

  private serializeMedia(media: OutgoingResponse['media']): Array<Record<string, unknown>> {
    return (media ?? []).map((item) => ({
      type: item.type,
      path: item.path,
      mimeType: item.mimeType,
      fileName: item.fileName,
      caption: item.caption,
      url: `${this.config.path}/media?path=${encodeURIComponent(item.path)}`.replace(/\/+/g, '/'),
    }));
  }
}
