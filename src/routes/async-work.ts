/**
 * Durable async-work HTTP surface on the bridge port (Step 31):
 *   GET  /api/work                 ?chatId=&active=1&limit=   list
 *   GET  /api/work/:workId                                    status
 *   GET  /api/work/:workId/receipt                            record + kind-specific detail
 *   POST /api/work/:workId/cancel                             cancel (202) — terminal ⇒ 409
 * Bearer auth via timingSafeEqual, same policy as src/routes/device.ts
 * (empty configured token ⇒ open, matching the rest of the bridge surface).
 */
import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { AsyncWorkRecord } from '../work/types.js';
import type { WorkRegistry } from '../work/registry.js';
import { requestAsyncWorkCancel } from '../work/cancel.js';

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
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  return true;
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
