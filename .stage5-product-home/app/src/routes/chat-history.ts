import type { Request, Response } from 'express';
import type { ConversationHistory } from '../agent/history.js';
import {
  ConversationMetadataStore,
  isSafeConversationChatId,
  sanitizeConversationTitle,
} from '../chat/conversation-metadata.js';
import { projectChatHistoryRecords } from '../chat/history-projection.js';

export { projectChatHistoryRecords } from '../chat/history-projection.js';

export interface ChatHistoryConfig {
  agentName: string;
  history: ConversationHistory;
  token?: string;
  metadata?: ConversationMetadataStore;
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

/**
 * GET /api/chat/history?chatId=X&limit=50
 * Returns display records in order, bounded after transport reconstruction.
 */
export function createChatHistoryHandler(config: ChatHistoryConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const chatId = String(req.query.chatId || '');
    if (!chatId) { res.status(400).json({ error: 'chatId required' }); return; }

    const rawLimit = Number(req.query.limit ?? 200);
    const limit = Math.max(1, Math.min(1000, Number.isFinite(rawLimit) ? rawLimit : 200));

    const records = config.history.loadRaw(chatId);
    const projected = projectChatHistoryRecords(records, limit);

    res.json({
      chatId,
      count: projected.length,
      total: records.length,
      projectedTotal: projectChatHistoryRecords(records, Number.MAX_SAFE_INTEGER).length,
      records: projected,
    });
  };
}

/**
 * GET /api/chat/conversations — list all chatIds with metadata.
 */
export function createChatListHandler(config: ChatHistoryConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;

    const chatIds = (config.history as unknown as { listChatIds?: () => string[] }).listChatIds?.() ?? [];
    const metadata = config.metadata?.loadAll() ?? {};
    const summaries = chatIds.map((cid: string) => {
      const recs = config.history.loadRaw(cid);
      const last = recs[recs.length - 1] as { ts?: string; ended_at?: string; started_at?: string } | undefined;
      const lastTs = last?.ts || last?.ended_at || last?.started_at || null;
      const meta = metadata[cid] ?? {};
      return {
        chatId: cid,
        count: recs.length,
        lastTs,
        agent: config.agentName,
        title: typeof meta.title === 'string' && meta.title.trim() ? meta.title : null,
        pinned: meta.pinned === true,
      };
    });

    summaries.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return String(b.lastTs || '').localeCompare(String(a.lastTs || ''));
    });

    res.json({ conversations: summaries });
  };
}

/**
 * PATCH /api/chat/conversations/:chatId — durable title and/or pin.
 * Does not rename JSONL files and does not bump conversation recency to pin.
 */
export function createChatMetadataHandler(config: ChatHistoryConfig) {
  return (req: Request, res: Response): void => {
    if (!checkAuth(req, res, config.token)) return;
    if (!config.metadata) {
      res.status(503).json({ error: 'conversation metadata unavailable' });
      return;
    }

    const chatId = String(req.params.chatId || '');
    if (!isSafeConversationChatId(chatId)) {
      res.status(400).json({ error: 'invalid chatId' });
      return;
    }

    const body = (req.body ?? {}) as { title?: unknown; pinned?: unknown };
    const hasTitle = Object.prototype.hasOwnProperty.call(body, 'title');
    const hasPinned = Object.prototype.hasOwnProperty.call(body, 'pinned');
    if (!hasTitle && !hasPinned) {
      res.status(400).json({ error: 'title or pinned required' });
      return;
    }

    let title: string | null | undefined;
    if (hasTitle) {
      if (body.title !== null && typeof body.title !== 'string') {
        res.status(400).json({ error: 'title must be a string or null' });
        return;
      }
      title = sanitizeConversationTitle(body.title);
      if (body.title !== null && typeof body.title === 'string' && title === undefined) {
        res.status(400).json({ error: 'invalid title' });
        return;
      }
    }

    let pinned: boolean | undefined;
    if (hasPinned) {
      if (typeof body.pinned !== 'boolean') {
        res.status(400).json({ error: 'pinned must be a boolean' });
        return;
      }
      pinned = body.pinned;
    }

    const stored = config.metadata.update(chatId, { title, pinned });
    const recs = config.history.loadRaw(chatId);
    const last = recs[recs.length - 1] as { ts?: string; ended_at?: string; started_at?: string } | undefined;
    res.json({
      chatId,
      count: recs.length,
      lastTs: last?.ts || last?.ended_at || last?.started_at || null,
      agent: config.agentName,
      title: typeof stored.title === 'string' && stored.title.trim() ? stored.title : null,
      pinned: stored.pinned === true,
    });
  };
}
