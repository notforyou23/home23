/**
 * Durable async-work HTTP surface on the bridge port (Step 31):
 *   GET  /api/work                 ?chatId=&active=1&limit=   list
 *   GET  /api/work/:workId                                    status
 *   GET  /api/work/:workId/receipt                            record + kind-specific detail
 *   POST /api/work/:workId/cancel                             cancel (202) — terminal ⇒ 409
 *   POST /api/work/:workId/inject                             steer note (202) — coding/empty ⇒ 400, terminal/overflow ⇒ 409
 * Bearer auth via timingSafeEqual, same policy as src/routes/device.ts
 * (empty configured token ⇒ open, matching the rest of the bridge surface).
 */
import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { isChatWorkHandle, TERMINAL_WORK_STATUSES, type AsyncWorkRecord } from '../work/types.js';
import type { WorkRegistry } from '../work/registry.js';
import { requestAsyncWorkCancel } from '../work/cancel.js';
import { workBus } from '../work/work-bus.js';
import { steerQueue } from '../agent/steer-queue.js';

export interface AsyncWorkRouterDeps {
  registry: WorkRegistry;
  token: string;
  cancelCodingJob: (jobId: string) => Promise<void>;
  /** Abort the active run for a chat (sub-agent cancel). Returns whether a run was found. */
  stopChat: (chatId: string) => boolean;
  /** Kind-specific receipt detail (coding receipt + events tail / sub-chat tail). */
  readReceiptDetail: (work: AsyncWorkRecord) => unknown;
}

function checkAuth(req: Request, res: Response, token: string): boolean {
  if (!token) return true;
  const header = req.headers.authorization ?? '';
  const expected = `Bearer ${token}`;
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length === b.length && timingSafeEqual(a, b)) return true;
  // EventSource cannot set headers; the live work stream authenticates via query.
  if (typeof req.query.token === 'string' && req.query.token === token) return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

export function createAsyncWorkRouter(deps: AsyncWorkRouterDeps): Router {
  const router = Router();

  router.get('/', (req, res) => {
    if (!checkAuth(req, res, deps.token)) return;
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : undefined;
    const active = req.query.active === '1' || req.query.active === 'true';
    const limit = Number.parseInt(String(req.query.limit ?? ''), 10);
    res.json({
      work: deps.registry.list({
        originChatId: chatId,
        active,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 50,
      }),
    });
  });

  router.get('/stream', (req, res) => {
    if (!checkAuth(req, res, deps.token)) return;
    const chatId = typeof req.query.chatId === 'string' ? req.query.chatId : '';
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const snapshot = deps.registry.list({
      originChatId: chatId || undefined,
      active: true,
      limit: 50,
    });
    res.write(`data: ${JSON.stringify({ type: 'snapshot', work: snapshot })}\n\n`);

    const unsubscribe = workBus.subscribe(chatId || '*', (record, reason) => {
      if (chatId && record.originChatId !== chatId) return;
      res.write(`data: ${JSON.stringify({ type: 'update', reason, work: record })}\n\n`);
    });

    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  router.get('/:workId', (req, res) => {
    if (!checkAuth(req, res, deps.token)) return;
    const work = deps.registry.get(req.params.workId);
    if (!work) return void res.status(404).json({ error: 'unknown work id' });
    res.json(work);
  });

  router.get('/:workId/receipt', (req, res) => {
    if (!checkAuth(req, res, deps.token)) return;
    const work = deps.registry.get(req.params.workId);
    if (!work) return void res.status(404).json({ error: 'unknown work id' });
    res.json({ work, detail: deps.readReceiptDetail(work) });
  });

  router.post('/:workId/inject', (req, res) => {
    if (!checkAuth(req, res, deps.token)) return;
    const work = deps.registry.get(req.params.workId);
    if (!work) return void res.status(404).json({ error: 'unknown work id' });
    if (TERMINAL_WORK_STATUSES.has(work.status)) {
      return void res.status(409).json({ error: 'already terminal', status: work.status });
    }
    if (!isChatWorkHandle(work.resultHandle)) {
      return void res.status(400).json({ error: 'inject requires a chat-backed run' });
    }
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    const queued = steerQueue.enqueue(work.resultHandle.chatId, text);
    if (!queued.ok && queued.error === 'empty') {
      return void res.status(400).json({ error: 'text required' });
    }
    if (!queued.ok && queued.error === 'overflow') {
      return void res.status(409).json({ error: 'steer queue full' });
    }
    deps.registry.noteProgress(work.workId, 'steer pending');
    res.status(202).json({
      workId: work.workId,
      pending: steerQueue.pendingCount(work.resultHandle.chatId),
    });
  });

  router.post('/:workId/cancel', (req, res) => {
    if (!checkAuth(req, res, deps.token)) return;
    const outcome = requestAsyncWorkCancel(deps, req.params.workId);
    if (outcome.status === 'not_found') {
      return void res.status(404).json({ error: 'unknown work id' });
    }
    if (outcome.status === 'already_terminal') {
      return void res.status(409).json({ error: 'already terminal', status: outcome.work.status });
    }
    res.status(202).json({ workId: outcome.work.workId, cancel: 'requested' });
  });

  return router;
}
