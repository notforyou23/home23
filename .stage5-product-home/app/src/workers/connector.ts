import express from 'express';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createWorkerFromTemplate } from './scaffold.js';
import { listWorkerTemplates, listWorkers } from './registry.js';
import { readWorkerReceipt } from './receipts.js';
import { runWorker as defaultRunWorker } from './runner.js';
import type { ToolContext } from '../agent/types.js';
import type { WorkerConfig, WorkerRunReceipt, WorkerRunRequest, WorkerRunStatus } from './types.js';

export type WorkerSummary = Pick<WorkerConfig, 'name' | 'displayName' | 'ownerAgent' | 'class' | 'purpose'>;

export interface WorkerRunSummary {
  runId: string;
  worker: string;
  ownerAgent?: string;
  requestedBy?: WorkerRunReceipt['requestedBy'];
  requester?: string;
  source?: WorkerRunReceipt['source'];
  status: WorkerRunStatus | 'running' | 'stale';
  verifierStatus?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  runPath: string;
  receiptPath?: string;
  stale?: boolean;
}

const STALE_RUNNING_RUN_MS = 6 * 60 * 60 * 1000;

export interface WorkerRunListOptions {
  ownerAgent?: string;
}

export interface WorkerHandlerDeps {
  projectRoot: string;
  ctx?: ToolContext;
  listWorkers?: () => WorkerSummary[];
  listTemplates?: () => ReturnType<typeof listWorkerTemplates>;
  runWorker?: (request: WorkerRunRequest) => Promise<{ runId: string; runPath: string; receipt: WorkerRunReceipt }>;
  readRunReceipt?: (runId: string) => Promise<WorkerRunReceipt>;
}

function toWorkerSummary(worker: WorkerConfig | WorkerSummary): WorkerSummary {
  return {
    name: worker.name,
    displayName: worker.displayName,
    ownerAgent: worker.ownerAgent,
    class: worker.class,
    purpose: worker.purpose
  };
}

function findRunReceiptPath(projectRoot: string, runId: string): string | null {
  for (const worker of listWorkers(projectRoot)) {
    const receiptPath = path.join(worker.rootPath, 'runs', runId, 'receipt.json');
    if (existsSync(receiptPath)) return receiptPath;
  }
  return null;
}

function runStartedAtFromId(runId: string): string | null {
  const match = String(runId || '').match(/^wr_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z_/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? iso : null;
}

function runStartedAtFromPath(runId: string, runPath: string): string | null {
  const fromId = runStartedAtFromId(runId);
  if (fromId) return fromId;
  try {
    return statSync(runPath).mtime.toISOString();
  } catch {
    return null;
  }
}

function isStaleRunningRun(startedAt: string | null, nowMs = Date.now()): boolean {
  if (!startedAt) return false;
  const startedMs = Date.parse(startedAt);
  return Number.isFinite(startedMs) && nowMs - startedMs > STALE_RUNNING_RUN_MS;
}

function listRunSummaries(projectRoot: string, options: WorkerRunListOptions = {}): WorkerRunSummary[] {
  const ownerAgent = options.ownerAgent?.trim();
  const runs: WorkerRunSummary[] = [];
  for (const worker of listWorkers(projectRoot)) {
    const runsDir = path.join(worker.rootPath, 'runs');
    if (!existsSync(runsDir)) continue;
    for (const entry of readdirSync(runsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const runPath = path.join(runsDir, entry.name);
      const receiptPath = path.join(runPath, 'receipt.json');
      if (existsSync(receiptPath)) {
        const receipt = readWorkerReceipt(receiptPath);
        const summary: WorkerRunSummary = {
          runId: receipt.runId,
          worker: receipt.worker,
          ownerAgent: receipt.ownerAgent,
          requestedBy: receipt.requestedBy,
          requester: receipt.requester,
          source: receipt.source,
          status: receipt.status,
          verifierStatus: receipt.verifierStatus,
          startedAt: receipt.startedAt,
          finishedAt: receipt.finishedAt,
          summary: receipt.summary,
          runPath,
          receiptPath
        };
        if (!ownerAgent || summary.ownerAgent === ownerAgent) runs.push(summary);
      } else {
        const startedAt = runStartedAtFromPath(entry.name, runPath);
        const stale = isStaleRunningRun(startedAt);
        const summary: WorkerRunSummary = {
          runId: entry.name,
          worker: worker.name,
          ownerAgent: worker.ownerAgent,
          status: stale ? 'stale' : 'running',
          verifierStatus: stale ? 'unknown' : undefined,
          startedAt: startedAt || undefined,
          summary: stale
            ? 'No worker receipt found; this run is stale and is not active repair work.'
            : undefined,
          runPath,
          stale
        };
        if (!ownerAgent || summary.ownerAgent === ownerAgent) runs.push(summary);
      }
    }
  }
  return runs.sort((a, b) => String(b.finishedAt || b.startedAt || b.runId).localeCompare(String(a.finishedAt || a.startedAt || a.runId)));
}

export function createWorkerHandlers(deps: WorkerHandlerDeps) {
  const list = deps.listWorkers || (() => listWorkers(deps.projectRoot).map(toWorkerSummary));
  const templates = deps.listTemplates || (() => listWorkerTemplates(deps.projectRoot));
  const runner = deps.runWorker || ((request: WorkerRunRequest) => {
    if (!deps.ctx) throw new Error('Worker connector requires ToolContext');
    return defaultRunWorker({ projectRoot: deps.projectRoot, request, ctx: deps.ctx });
  });

  return {
    async listWorkers() {
      return { workers: list() };
    },
    async getWorker(name: string) {
      const worker = list().find(w => w.name === name);
      if (!worker) throw new Error(`Worker not found: ${name}`);
      return { worker };
    },
    async listTemplates() {
      return { templates: templates() };
    },
    async createWorker(body: { name?: string; template?: string; ownerAgent?: string }) {
      if (!body.name || typeof body.name !== 'string') throw new Error('name is required');
      const result = createWorkerFromTemplate(deps.projectRoot, {
        name: body.name,
        template: body.template || body.name,
        ownerAgent: body.ownerAgent
      });
      return { worker: toWorkerSummary(result.worker), createdPath: result.createdPath };
    },
    async startRun(worker: string, body: Partial<WorkerRunRequest> & { prompt?: string }) {
      if (!body.prompt || typeof body.prompt !== 'string') throw new Error('prompt is required');
      return await runner({
        worker,
        prompt: body.prompt,
        ownerAgent: body.ownerAgent,
        requestedBy: body.requestedBy || 'api',
        requester: body.requester,
        collaborationHandoff: body.collaborationHandoff,
        source: body.source,
        metadata: body.metadata
      });
    },
    async listRuns(options: WorkerRunListOptions = {}) {
      return { runs: listRunSummaries(deps.projectRoot, options) };
    },
    async getRun(runId: string) {
      const run = listRunSummaries(deps.projectRoot).find(item => item.runId === runId);
      if (!run) throw new Error(`Worker run not found: ${runId}`);
      return { run };
    },
    async readReceipt(runId: string) {
      if (deps.readRunReceipt) return await deps.readRunReceipt(runId);
      const found = findRunReceiptPath(deps.projectRoot, runId);
      if (!found) throw new Error(`Worker run not found: ${runId}`);
      return readWorkerReceipt(found);
    },
    async listArtifacts(runId: string) {
      const receipt = await this.readReceipt(runId);
      return { runId, artifacts: receipt.artifacts };
    },
    async cancelRun(runId: string) {
      return { runId, cancelled: false, status: 'not_supported', detail: 'worker cancellation is not available for synchronous first-slice runs' };
    },
    async promoteMemory(runId: string) {
      const receipt = await this.readReceipt(runId);
      return {
        runId,
        status: 'ready_for_memory_curator',
        candidates: receipt.memoryCandidates.length,
        memoryCandidates: receipt.memoryCandidates
      };
    }
  };
}

export function createWorkerRouter(deps: WorkerHandlerDeps): express.Router {
  const router = express.Router();
  const handlers = createWorkerHandlers(deps);

  router.get('/api/workers/templates', async (_req, res) => {
    try { res.json(await handlers.listTemplates()); } catch (err) { res.status(500).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.get('/api/workers/runs', async (req, res) => {
    const ownerAgent = typeof req.query.ownerAgent === 'string' ? req.query.ownerAgent : undefined;
    try { res.json(await handlers.listRuns({ ownerAgent })); } catch (err) { res.status(500).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.get('/api/workers/runs/:runId', async (req, res) => {
    try { res.json(await handlers.getRun(req.params.runId)); } catch (err) { res.status(404).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.get('/api/workers/runs/:runId/receipt', async (req, res) => {
    try { res.json(await handlers.readReceipt(req.params.runId)); } catch (err) { res.status(404).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.get('/api/workers/runs/:runId/artifacts', async (req, res) => {
    try { res.json(await handlers.listArtifacts(req.params.runId)); } catch (err) { res.status(404).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.post('/api/workers/runs/:runId/cancel', async (req, res) => {
    try { res.status(409).json(await handlers.cancelRun(req.params.runId)); } catch (err) { res.status(404).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.post('/api/workers/runs/:runId/promote-memory', async (req, res) => {
    try { res.json(await handlers.promoteMemory(req.params.runId)); } catch (err) { res.status(404).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.get('/api/workers', async (_req, res) => {
    try { res.json(await handlers.listWorkers()); } catch (err) { res.status(500).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.post('/api/workers', async (req, res) => {
    try { res.json(await handlers.createWorker(req.body || {})); } catch (err) { res.status(400).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.get('/api/workers/:name', async (req, res) => {
    try { res.json(await handlers.getWorker(req.params.name)); } catch (err) { res.status(404).json({ error: String(err instanceof Error ? err.message : err) }); }
  });
  router.post('/api/workers/:name/runs', async (req, res) => {
    try { res.json(await handlers.startRun(req.params.name, req.body || {})); } catch (err) { res.status(400).json({ error: String(err instanceof Error ? err.message : err) }); }
  });

  return router;
}
