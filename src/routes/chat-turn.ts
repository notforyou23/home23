import { attachmentContentType } from "../attachment-content.js";
import type { Request, Response } from 'express';
import type { AgentLoop } from '../agent/loop.js';
import type { ConversationHistory } from '../agent/history.js';
import type { MediaAttachment } from '../types.js';
import { TurnStore } from '../chat/turn-store.js';
import { turnBus } from '../chat/turn-bus.js';
import { isTurnEnvelope, isTurnEvent } from '../chat/turn-types.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ModelAliases } from '../agent/model-resolution.js';
import {
  modelSupportsReasoningEffort,
  parseReasoningEffort,
  reasoningEffortsForModel,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from '../agent/reasoning-effort.js';

export interface ChatTurnConfig {
  agentName: string;
  agent: AgentLoop;
  history: ConversationHistory;
  token?: string;
  modelAliases?: ModelAliases;
  /** Absolute path to instances/<agent>/. Used as upload root for chat image attachments. */
  instanceDir?: string;
}

const PERSISTED_PENDING_MAX_AGE_MS = 10 * 60 * 1000;

function checkAuth(req: Request, res: Response, token?: string): boolean {
  if (!token) return true;
  const h = req.headers.authorization;
  if (h === `Bearer ${token}`) return true;
  // EventSource cannot set headers, so the stream authenticates via query
  // param. Enrolling a query-notebook bridge token silently locked out the
  // dashboard chat (2026-07-16) — every UI call 401'd with no way to comply.
  if (typeof req.query.token === 'string' && req.query.token === token) return true;
  res.status(401).json({ error: 'Unauthorized' });
  return false;
}

/** POST /api/chat/turn — start a turn, return turn_id immediately. Agent runs detached. */
export function createTurnStartHandler(config: ChatTurnConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!checkAuth(req, res, config.token)) return;

    const { chatId, message, model, effort: requestedEffort, images, attachments } = req.body ?? {};
    if (!chatId || typeof chatId !== 'string') {
      res.status(400).json({ error: 'chatId required' }); return;
    }
    if (typeof message !== 'string' || (!message.trim() && !images?.length && !attachments?.length)) {
      res.status(400).json({ error: 'message required' }); return;
    }

    let effort: ReasoningEffort | undefined;
    try {
      effort = parseReasoningEffort(requestedEffort, 'effort');
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
        code: 'reasoning_effort_invalid',
      });
      return;
    }

    const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
    const MAX_IMAGES = 6;
    const MAX_BYTES = 10 * 1024 * 1024;
    const validatedImages: Array<{ buf: Buffer; mimeType: string; fileName?: string }> = [];
    if (images !== undefined) {
      if (!Array.isArray(images)) {
        res.status(400).json({ error: 'images must be an array' }); return;
      }
      if (images.length > MAX_IMAGES) {
        res.status(413).json({ error: `too many images (max ${MAX_IMAGES})` }); return;
      }
      for (const img of images) {
        if (!img || typeof img.data !== 'string' || typeof img.mimeType !== 'string') {
          res.status(400).json({ error: 'each image needs data (base64) and mimeType' }); return;
        }
        if (!ALLOWED_MIME.has(img.mimeType)) {
          res.status(415).json({ error: `unsupported mime ${img.mimeType}` }); return;
        }
        let buf: Buffer;
        try { buf = Buffer.from(img.data, 'base64'); }
        catch { res.status(400).json({ error: 'invalid base64' }); return; }
        if (buf.length === 0) {
          res.status(400).json({ error: 'empty image' }); return;
        }
        if (buf.length > MAX_BYTES) {
          res.status(413).json({ error: `image exceeds ${MAX_BYTES} bytes` }); return;
        }
        validatedImages.push({ buf, mimeType: img.mimeType, fileName: typeof img.fileName === 'string' ? img.fileName : undefined });
      }
    }

    if (attachments !== undefined) {
      if (!Array.isArray(attachments) || attachments.length + validatedImages.length > 10) {
        res.status(413).json({ error: 'Up to 10 attachments are allowed per message.' }); return;
      }
      let totalBytes = validatedImages.reduce((n, file) => n + file.buf.length, 0);
      for (const file of attachments) {
        if (!file || typeof file.data !== 'string' || file.data.length > Math.ceil(25 * 1024 * 1024 / 3) * 4 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.data)) {
          res.status(400).json({ error: 'Attachment data must be valid base64.' }); return;
        }
        const buf = Buffer.from(file.data, 'base64');
        totalBytes += buf.length;
        if (totalBytes > 25 * 1024 * 1024) {
          res.status(413).json({ error: 'The combined attachments exceed 25 MB.' }); return;
        }
        const fileName = typeof file.fileName === 'string' ? file.fileName.normalize('NFC') : 'Attachment';
        if (!fileName || fileName.length > 255 || /[\x00-\x1f\x7f/\\]/u.test(fileName) || fileName === '.' || fileName === '..') {
          res.status(400).json({ error: 'The attachment filename is invalid.' }); return;
        }
        validatedImages.push({ buf, mimeType: attachmentContentType(buf), fileName });
      }
    }

    // Reject or recover persisted pending turns before starting a duplicate.
    const store = new TurnStore(config.history);
    const isActive = config.agent.isRunning(chatId);
    if (!isActive) {
      for (const recoveredTurnId of store.sweepOrphans(chatId, PERSISTED_PENDING_MAX_AGE_MS)) {
        const env = store.finalEnvelope(chatId, recoveredTurnId);
        if (env) {
          turnBus.emit(chatId, recoveredTurnId, env);
          turnBus.close(chatId, recoveredTurnId);
        }
      }
    }
    const pending = store.pendingTurns(chatId);
    const existing = pending[pending.length - 1];
    if (existing) {
      res.status(409).json({
        error: 'turn in progress',
        turn_id: existing.turn_id,
        active: isActive,
        recoverable: !isActive,
      });
      return;
    }

    // Resolve model alias → { model, provider } for per-turn override.
    let modelOverride: { model: string; provider?: string; reasoningEffort?: import('../agent/reasoning-effort.js').ReasoningEffort } | undefined;
    if (typeof model === 'string' && model.length > 0) {
      const alias = config.modelAliases?.[model];
      if (alias) {
        modelOverride = {
          model: alias.model,
          provider: alias.provider,
          ...(alias.reasoningEffort ? { reasoningEffort: alias.reasoningEffort } : {}),
        };
      } else {
        // Accept raw model name without alias — provider inferred by setModel().
        modelOverride = { model };
      }
    }
    const selectedModel = modelOverride?.model ?? config.agent.getModel();
    const selectedEffort = effort ?? modelOverride?.reasoningEffort ?? config.agent.getReasoningEffort();
    if (!modelSupportsReasoningEffort(selectedModel, selectedEffort)) {
      res.status(400).json({
        error: `reasoning effort ${selectedEffort} is unavailable for ${selectedModel}`,
        code: 'reasoning_effort_unsupported',
      });
      return;
    }

    // Generate turnId early so image filenames can use it.
    const turnId = `t_${Date.now()}_${randomUUID().slice(0, 8)}`;

    const media: MediaAttachment[] = [];
    if (validatedImages.length > 0) {
      if (!config.instanceDir) {
        res.status(500).json({ error: 'instanceDir not configured' }); return;
      }
      const uploadDir = join(config.instanceDir, 'uploads', 'chat');
      mkdirSync(uploadDir, { recursive: true });
      const extByMime: Record<string, string> = {
        'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
      };
      for (let i = 0; i < validatedImages.length; i++) {
        const v = validatedImages[i]!;
        const suppliedExtension = extname(v.fileName ?? '');
        const ext = extByMime[v.mimeType] ?? (/^\.[a-z0-9]{1,16}$/i.test(suppliedExtension) ? suppliedExtension : '.bin');
        const p = join(uploadDir, `${turnId}-${i}${ext}`);
        writeFileSync(p, v.buf, { flag: 'wx', mode: 0o600 });
        media.push({ type: ALLOWED_MIME.has(v.mimeType) ? 'image' : 'document', path: p, mimeType: v.mimeType, fileName: v.fileName, byteCount: v.buf.length });
      }
    }

    try {
      const { turnId: actualTurnId, response } = await config.agent.runWithTurn(chatId, message, {
        turnId,
        modelOverride,
        effort,
        media: media.length > 0 ? media : undefined,
      });

      // Detach — don't await. Swallow errors (already persisted to JSONL as error envelope).
      response.catch(err => {
        console.error(`[chat-turn] ${config.agentName} ${actualTurnId} error:`, err?.message || err);
      });

      res.json({ turn_id: actualTurnId });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`[chat-turn] ${config.agentName} start error:`, m);
      res.status(500).json({ error: m });
    }
  };
}

/** GET /api/chat/stream?chatId=X&turn_id=Y&cursor=N — SSE replay + live tail. */
export function createTurnStreamHandler(config: ChatTurnConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    if (!checkAuth(req, res, config.token)) return;

    const chatId = String(req.query.chatId || '');
    const turnId = String(req.query.turn_id || '');
    const cursor = Number(req.query.cursor ?? -1);

    if (!chatId || !turnId) {
      res.status(400).json({ error: 'chatId and turn_id required' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');

    const write = (data: unknown): void => {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let lastSeq = cursor;
    let finished = false;
    let unsubscribe = (): void => {};
    const finish = (): void => {
      if (finished) return;
      finished = true;
      res.write('data: [DONE]\n\n');
      res.end();
      unsubscribe();
    };

    // Subscribe before replay/final-state checks so a terminal envelope cannot
    // land between catch-up and live tail attachment.
    unsubscribe = turnBus.subscribe(chatId, turnId, (record) => {
      if (finished) return;
      if (isTurnEvent(record) && record.seq <= lastSeq) return; // already sent during catch-up
      write(record);
      if (isTurnEvent(record)) lastSeq = record.seq;
      if (isTurnEnvelope(record) && record.status !== 'pending') {
        finish();
      }
    });

    const store = new TurnStore(config.history);

    // Phase 1: catch-up from JSONL
    const catchup = store.eventsSince(chatId, turnId, cursor);
    for (const ev of catchup) {
      if (finished) break;
      write(ev);
      lastSeq = ev.seq;
    }
    if (finished) return;

    // Check if turn already finished after subscribing.
    const finalEnv = store.finalEnvelope(chatId, turnId);
    if (finalEnv && !finished) {
      write(finalEnv);
      finish();
      return;
    }

    // Client disconnect
    req.on('close', () => {
      finished = true;
      unsubscribe();
    });

    // Heartbeat to keep connection alive through proxies (every 15s)
    const heartbeat = setInterval(() => {
      if (finished) { clearInterval(heartbeat); return; }
      res.write(': heartbeat\n\n');
    }, 15000);

    res.on('close', () => clearInterval(heartbeat));
  };
}

/** POST /api/chat/stop-turn {chatId, turn_id} — stop the active run. */
export function createTurnStopHandler(config: ChatTurnConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const chatId = req.body?.chatId;
    if (!chatId) { res.status(400).json({ error: 'chatId required' }); return; }
    const turnId = typeof req.body?.turn_id === 'string' && req.body.turn_id.length > 0
      ? req.body.turn_id
      : undefined;

    const store = new TurnStore(config.history);
    if (turnId) {
      const requested = store.listTurns(chatId).find(t => t.turn_id === turnId);
      if (!requested) {
        res.status(404).json({ error: 'turn not found', turn_id: turnId });
        return;
      }
      if (requested.status !== 'pending') {
        res.json({ stopped: false, chatIds: [], turn_id: turnId, alreadyTerminal: true, status: requested.status });
        return;
      }
    }

    const result = config.agent.stop(chatId, turnId);

    if (turnId && !result.terminal && result.activeTurnId && result.activeTurnId !== turnId) {
      res.status(409).json({
        stopped: false,
        chatIds: [],
        turn_id: turnId,
        activeTurnId: result.activeTurnId,
        error: 'different turn is active',
      });
      return;
    }

    if (turnId && !store.finalEnvelope(chatId, turnId)) {
      const events = store.eventsSince(chatId, turnId, -1);
      const lastSeq = events.length ? events[events.length - 1]!.seq : 0;
      const terminal = result.terminal ?? {
        status: 'stopped' as const,
        stop_reason: result.stopped ? 'operator_stop' : 'operator_stop_no_active_run',
      };
      const env = store.writeEnd(chatId, turnId, terminal.status, {
        last_seq: lastSeq,
        stop_reason: terminal.stop_reason,
        error: terminal.error_message,
        error_code: terminal.error_code,
        error_message: terminal.error_message,
      });
      turnBus.emit(chatId, turnId, env);
      turnBus.close(chatId, turnId);
    }

    res.json(turnId ? { ...result, turn_id: turnId } : result);
  };
}

/** GET /api/chat/turn-status?chatId=X&turn_id=Y — non-mutating turn status read. */
export function createTurnStatusHandler(config: ChatTurnConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const chatId = String(req.query.chatId || '');
    const turnId = String(req.query.turn_id || '');
    if (!chatId || !turnId) {
      res.status(400).json({ error: 'chatId and turn_id required' });
      return;
    }

    const store = new TurnStore(config.history);
    const status = store.statusForTurn(chatId, turnId, {
      active: config.agent.isRunning(chatId),
      provider: config.agent.getProvider?.() ?? null,
      defaultModel: config.agent.getModel?.() ?? null,
      defaultProvider: config.agent.getProvider?.() ?? null,
    });

    if (!status) {
      res.status(404).json({ error: 'turn not found' });
      return;
    }

    res.json(status);
  };
}

/** GET /api/chat/models — list of alias names the client can pick from, plus current default. */
export function createModelsHandler(config: ChatTurnConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;
    const aliases = config.modelAliases ?? {};
    const models = Object.entries(aliases).map(([alias, val]) => ({
      alias,
      provider: val.provider,
      model: val.model,
      reasoningEfforts: reasoningEffortsForModel(val.model),
    }));
    res.json({
      models,
      defaultModel: config.agent.getModel(),
      defaultProvider: config.agent.getProvider(),
      defaultReasoningEffort: config.agent.getReasoningEffort(),
      reasoningEfforts: REASONING_EFFORTS,
    });
  };
}

/** GET /api/chat/pending?chatId=X — list pending turns for page-load resume. */
export function createPendingTurnsHandler(config: ChatTurnConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const chatId = String(req.query.chatId || '');
    if (!chatId) { res.status(400).json({ error: 'chatId required' }); return; }

    const store = new TurnStore(config.history);
    res.json({ pending: store.pendingTurns(chatId) });
  };
}
