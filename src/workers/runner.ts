import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveModelOverride } from '../agent/model-resolution.js';
import { createSeededToolRegistry, resolveWorkerTools } from '../agent/tools/index.js';
import { loadWorker } from './registry.js';
import { writeWorkerReceipt } from './receipts.js';
import type { ToolContext } from '../agent/types.js';
import type { WorkerCollaborationHandoff, WorkerRunReceipt, WorkerRunRequest } from './types.js';

const activeOwners = new Set<string>();

export interface RunWorkerInput {
  projectRoot: string;
  request: WorkerRunRequest;
  ctx: ToolContext;
}

export interface RunWorkerResult {
  runId: string;
  runPath: string;
  receipt: WorkerRunReceipt;
}

function makeRunId(worker: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `wr_${stamp}_${worker}_${suffix}`;
}

function readIfExists(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function workerSystemPrompt(workerName: string, identity: string, playbook: string): string {
  return [
    `You are the reusable Home23 worker named ${workerName}.`,
    '',
    identity,
    '',
    playbook,
    '',
    'Return concise findings with evidence. Do not claim success unless a concrete verifier or equivalent check passed.',
    'End with machine-readable lines when possible:',
    'VERIFIER_STATUS: pass|fail|unknown',
    'DISPATCH_OUTCOME: fixed|failed|blocked|unknown|not_fixed',
    'SUMMARY: <one sentence>'
  ].join('\n');
}

function cleanLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function summarizePromptIntent(prompt: string): string {
  return String(prompt || '')
    .split('\n')
    .map(line => line.trim())
    .find(Boolean)
    ?.slice(0, 240)
    || 'Complete the requested Home23 worker task without drifting from owner intent.';
}

function normalizeCollaborationHandoff(request: WorkerRunRequest): WorkerCollaborationHandoff {
  const provided = request.collaborationHandoff || {};
  const whyThisMatters = String(provided.whyThisMatters || '').trim()
    || (request.source?.type
      ? `${request.source.type}${request.source.id ? ` ${request.source.id}` : ''} needs worker judgment without losing the owner intent behind the request.`
      : summarizePromptIntent(request.prompt));

  const constraints = cleanLines(provided.constraints);
  if (constraints.length === 0) {
    constraints.push(
      'Preserve the stated owner intent; do not replace missing context with reasonable but unverified assumptions.',
      'Separate observed evidence from claims, and name anything that remains uncertain.',
      'Keep changes scoped to the requested Home23 surface and record the verifier or concrete check used.'
    );
  }

  const reviewLens = cleanLines(provided.reviewLens);
  if (reviewLens.length === 0) {
    reviewLens.push(
      'Would this still look right to the owner after the speed of delegation is removed?',
      'Did the worker filter the generated answer instead of only completing the literal prompt?',
      'What would be technically correct but wrong for Home23 in this context?'
    );
  }

  return {
    schema: 'home23.worker-collaboration-handoff.v1',
    sourceIssues: Array.from(new Set([78, ...(Array.isArray(provided.sourceIssues) ? provided.sourceIssues : [])]
      .map(n => Number(n))
      .filter(n => Number.isInteger(n) && n > 0))),
    whyThisMatters,
    constraints,
    reviewLens,
    handoffTaxMitigation: String(provided.handoffTaxMitigation || '').trim()
      || 'Worker must state evidence, uncertainty, verifier status, and the review lens used so the owner can catch intent drift before accepting the artifact.'
  };
}

function formatCollaborationHandoff(handoff: WorkerCollaborationHandoff): string {
  return [
    '[COLLABORATION HANDOFF]',
    `Schema: ${handoff.schema}`,
    `Source issues: ${handoff.sourceIssues.join(', ')}`,
    `Why this matters: ${handoff.whyThisMatters}`,
    '',
    'Constraints:',
    ...handoff.constraints.map(item => `- ${item}`),
    '',
    'Review lens:',
    ...handoff.reviewLens.map(item => `- ${item}`),
    '',
    `Handoff-tax mitigation: ${handoff.handoffTaxMitigation}`
  ].join('\n');
}

function workerMission(systemPrompt: string, prompt: string, handoff: WorkerCollaborationHandoff): string {
  return [
    '[HOME23 WORKER CONTEXT]',
    systemPrompt,
    '',
    formatCollaborationHandoff(handoff),
    '',
    '[WORKER TASK]',
    prompt
  ].join('\n');
}

function parseVerifierStatus(text: string): WorkerRunReceipt['verifierStatus'] {
  const explicit = text.match(/VERIFIER_STATUS:\s*(pass|fail|unknown|not_run)/i)?.[1]?.toLowerCase();
  if (explicit === 'pass' || explicit === 'fail' || explicit === 'unknown' || explicit === 'not_run') return explicit;
  if (/verifier:\s*pass/i.test(text) || /\bverifier(?: now)? passes\b/i.test(text)) return 'pass';
  if (/verifier:\s*fail/i.test(text) || /\bverifier(?: still)? fails\b/i.test(text)) return 'fail';
  return 'unknown';
}

function parseStatus(text: string, verifierStatus: WorkerRunReceipt['verifierStatus']): WorkerRunReceipt['status'] {
  const explicit = text.match(/DISPATCH_OUTCOME:\s*(fixed|failed|blocked|unknown|not_fixed)/i)?.[1]?.toLowerCase();
  if (explicit === 'fixed') return 'fixed';
  if (explicit === 'not_fixed') return verifierStatus === 'pass' ? 'no_change' : 'failed';
  if (explicit === 'failed') return 'failed';
  if (explicit === 'blocked') return 'blocked';
  if (verifierStatus === 'pass' && /\bfixed\b/i.test(text)) return 'fixed';
  if (/\bblocked\b/i.test(text)) return 'blocked';
  if (/\bfailed\b|\berror\b/i.test(text)) return 'failed';
  return 'no_change';
}

function parseSummary(text: string): string {
  const summary = text.match(/SUMMARY:\s*(.+)$/im)?.[1]?.trim()
    || text.match(/Summary:\s*(.+)$/im)?.[1]?.trim()
    || text.split('\n').find(line => line.trim())?.trim()
    || 'Worker run completed.';
  return summary.slice(0, 500);
}

function receiptFromResponse(args: {
  request: WorkerRunRequest;
  runId: string;
  runPath: string;
  workerName: string;
  ownerAgent: string;
  startedAt: string;
  finishedAt: string;
  responseText: string;
  collaborationHandoff: WorkerCollaborationHandoff;
}): WorkerRunReceipt {
  const verifierStatus = parseVerifierStatus(args.responseText);
  const status = parseStatus(args.responseText, verifierStatus);
  const summary = parseSummary(args.responseText);
  return {
    schema: 'home23.worker-run.v1',
    runId: args.runId,
    worker: args.workerName,
    ownerAgent: args.ownerAgent,
    requestedBy: args.request.requestedBy,
    requester: args.request.requester,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    status,
    verifierStatus,
    summary,
    actions: [],
    evidence: [{ type: 'worker_response', detail: summary, status: verifierStatus }],
    artifacts: [path.join(args.runPath, 'transcript.md')],
    memoryCandidates: [],
    collaborationHandoff: args.collaborationHandoff,
    source: args.request.source
  };
}

export async function runWorker(input: RunWorkerInput): Promise<RunWorkerResult> {
  const worker = loadWorker(input.projectRoot, input.request.worker);
  const owner = input.request.ownerAgent || worker.ownerAgent;
  if (activeOwners.has(owner)) throw new Error(`Worker run already active for owner ${owner}`);
  if (!input.ctx.runAgentLoop) throw new Error('Worker runner requires runAgentLoop in ToolContext');

  activeOwners.add(owner);
  try {
    const id = makeRunId(worker.name);
    const runPath = path.join(worker.rootPath, 'runs', id);
    mkdirSync(runPath, { recursive: true });

    const startedAt = new Date().toISOString();
    const identity = readIfExists(path.join(worker.rootPath, 'workspace', 'IDENTITY.md'));
    const playbook = readIfExists(path.join(worker.rootPath, 'workspace', 'PLAYBOOK.md'));
    const systemPrompt = workerSystemPrompt(worker.name, identity, playbook);
    const collaborationHandoff = normalizeCollaborationHandoff(input.request);
    const mission = workerMission(systemPrompt, input.request.prompt, collaborationHandoff);

    writeFileSync(path.join(runPath, 'input.md'), [
      formatCollaborationHandoff(collaborationHandoff),
      '',
      '[WORKER TASK]',
      input.request.prompt
    ].join('\n'));
    // WorkerConfig.provider/model were parsed by the registry and consumed by
    // nothing (2026-08-11 audit D6). A worker that declares them now actually
    // runs on them; a declared-but-unroutable model fails the run loudly.
    let workerModelOverride: { model: string; provider?: string } | undefined;
    if (worker.model) {
      workerModelOverride = worker.provider
        ? { model: worker.model, provider: worker.provider }
        : resolveModelOverride(worker.model, input.ctx.modelAliases) ?? undefined;
      if (!workerModelOverride) {
        throw new Error(`Worker ${worker.name} declares model "${worker.model}" which is not a known alias or routable model`);
      }
    }
    const workerTools = resolveWorkerTools(worker.tools ?? {});
    const workerRegistry = createSeededToolRegistry(workerTools);
    const response = await input.ctx.runAgentLoop(systemPrompt, mission, workerTools, {
      ...input.ctx,
      agentName: owner,
      workspacePath: path.join(worker.rootPath, 'workspace'),
      chatId: `worker:${worker.name}:${id}`
    }, {
      ...(workerModelOverride ? { modelOverride: workerModelOverride } : {}),
      registry: workerRegistry,
    });
    const finishedAt = new Date().toISOString();
    writeFileSync(path.join(runPath, 'transcript.md'), response.text);

    const receipt = receiptFromResponse({
      request: { ...input.request, ownerAgent: owner },
      runId: id,
      runPath,
      workerName: worker.name,
      ownerAgent: owner,
      startedAt,
      finishedAt,
      responseText: response.text,
      collaborationHandoff
    });
    writeWorkerReceipt(input.projectRoot, runPath, receipt);
    return { runId: id, runPath, receipt };
  } finally {
    activeOwners.delete(owner);
  }
}
