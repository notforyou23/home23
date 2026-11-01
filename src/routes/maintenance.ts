import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { MaintenanceAdmission } from '../agent/maintenance-admission.js';

/** Fail closed without a configured bridge credential. Never executes a restart. */
export function createMaintenanceRouter(input: {
  token: string; admission: MaintenanceAdmission;
  active: () => { runs: number; work: number; coding: number };
}) {
  const router = Router();
  router.use((req, res, next) => {
    const actual = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${input.token}`);
    if (!input.token || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.status(401).json({ error: 'Unauthorized' }); return;
    }
    next();
  });
  router.post('/lease', (req, res) => {
    try {
      const lease = input.admission.acquire(req.body?.id);
      res.json({ lease, active: input.active() });
    } catch { input.admission.release(req.body?.id); res.status(409).json({ error: 'Maintenance lease unavailable' }); }
  });
  router.delete('/lease', (req, res) => {
    input.admission.release(req.body?.id);
    res.json({ released: true });
  });
  return router;
}
