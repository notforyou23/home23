import type { Request, Response } from 'express';
import type { ConversationHistory } from '../agent/history.js';
import { projectChatHistoryRecords } from '../chat/history-projection.js';

export { projectChatHistoryRecords } from '../chat/history-projection.js';

export interface ChatHistoryConfig {
  agentName: string;
  history: ConversationHistory;
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
    const summaries = chatIds.map((cid: string) => {
      const recs = config.history.loadRaw(cid);
      const last = recs[recs.length - 1] as { ts?: string; ended_at?: string; started_at?: string } | undefined;
      const lastTs = last?.ts || last?.ended_at || last?.started_at || null;
      return { chatId: cid, count: recs.length, lastTs };
    });

    res.json({ conversations: summaries });
  };
}
