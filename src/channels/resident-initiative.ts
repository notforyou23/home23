import { timingSafeEqual } from 'node:crypto';
import { parseResidentInitiation, type ResidentInitiation } from '../coordination/app/resident-initiations.js';

/** The local engine can propose a move to its own signed resident connection.
 * Core resolves the identity and existing owner conversation from that key. */
export function createResidentInitiativeHandler(options: {
  token: string;
  initiate(input: ResidentInitiation): Promise<unknown>;
}) {
  return async (req: { headers: { authorization?: string }; body?: unknown }, res: {
    status(code: number): { json(body: unknown): void }; json(body: unknown): void;
  }) => {
    const expected = Buffer.from(`Bearer ${options.token}`);
    const provided = Buffer.from(req.headers.authorization || '');
    if (!options.token || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'unauthorized' }); return;
    }
    let input: ResidentInitiation;
    try { input = parseResidentInitiation(req.body); }
    catch { res.status(400).json({ error: 'invalid_resident_initiative' }); return; }
    try { res.json(await options.initiate(input)); }
    catch { res.status(503).json({ error: 'resident_initiative_unavailable' }); }
  };
}

export function createResidentInitiativeStatusHandler(options: {
  token: string;
  status(input: { initiationId: string }): Promise<unknown>;
}) {
  return async (req: { headers: { authorization?: string }; body?: unknown }, res: {
    status(code: number): { json(body: unknown): void }; json(body: unknown): void;
  }) => {
    const expected = Buffer.from(`Bearer ${options.token}`);
    const provided = Buffer.from(req.headers.authorization || '');
    if (!options.token || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'unauthorized' }); return;
    }
    const input = req.body as { initiationId?: unknown } | null;
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'initiationId'
        || typeof input.initiationId !== 'string' || !input.initiationId.trim() || input.initiationId.includes('\0')
        || Buffer.byteLength(input.initiationId) > 128) {
      res.status(400).json({ error: 'invalid_resident_initiative_status' }); return;
    }
    try { res.json(await options.status({ initiationId: input.initiationId })); }
    catch { res.status(503).json({ error: 'resident_initiative_status_unavailable' }); }
  };
}
