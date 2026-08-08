import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { embedTextSync } from '../substrate/embed-at-contact.js';
import path from 'node:path';
import type { WorkerRunReceipt } from './types.js';

export interface WrittenWorkerReceipt {
  receiptPath: string;
  ownerWorkspacePath: string;
  ownerBrainPath: string;
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true });
}

function receiptMarkdown(receipt: WorkerRunReceipt, receiptPath: string): string {
  const evidence = receipt.evidence.map(e => `- ${e.type}: ${e.detail}${e.status ? ` (${e.status})` : ''}`).join('\n') || '- none recorded';
  const actions = receipt.actions.map(a => `- ${a.type}${a.target ? `: ${a.target}` : ''}${a.path ? `: ${a.path}` : ''}${a.detail ? `: ${a.detail}` : ''}`).join('\n') || '- none recorded';
  const memory = receipt.memoryCandidates.map(m => `- ${m.text} (confidence ${m.confidence})`).join('\n') || '- none';

  return [
    `# Worker Run ${receipt.runId}`,
    '',
    `Worker: ${receipt.worker}`,
    `Owner: ${receipt.ownerAgent}`,
    `Requested by: ${receipt.requestedBy}`,
    `Status: ${receipt.status}`,
    `Verifier: ${receipt.verifierStatus}`,
    `Started: ${receipt.startedAt}`,
    `Finished: ${receipt.finishedAt}`,
    '',
    '## Summary',
    receipt.summary,
    '',
    '## Root Cause',
    receipt.rootCause || 'Not established.',
    '',
    '## Actions',
    actions,
    '',
    '## Evidence',
    evidence,
    '',
    '## Memory Candidates',
    memory,
    '',
    '## Receipt',
    receiptPath
  ].join('\n');
}

export function writeWorkerReceipt(projectRoot: string, runPath: string, receipt: WorkerRunReceipt): WrittenWorkerReceipt {
  ensureDir(runPath);
  const receiptPath = path.join(runPath, 'receipt.json');
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  const ownerWorkspaceDir = path.join(projectRoot, 'instances', receipt.ownerAgent, 'workspace', 'worker-runs');
  ensureDir(ownerWorkspaceDir);
  const ownerWorkspacePath = path.join(ownerWorkspaceDir, `${receipt.runId}.md`);
  writeFileSync(ownerWorkspacePath, `${receiptMarkdown(receipt, receiptPath)}\n`);

  const ownerBrainDir = path.join(projectRoot, 'instances', receipt.ownerAgent, 'brain');
  ensureDir(ownerBrainDir);
  const ownerBrainPath = path.join(ownerBrainDir, 'worker-runs.jsonl');
  // Perception at contact (encoder stage 2): the receipt's language becomes
  // a semantic vector on the line every Seed eating worker-runs will taste.
  const semanticVector = embedTextSync(`${receipt.summary}${receipt.rootCause ? `. ${receipt.rootCause}` : ''}`);
  const brainRecord = {
    schema: 'home23.worker-run-memory.v1',
    ...(semanticVector !== null ? { semantic_vector: semanticVector } : {}),
    runId: receipt.runId,
    worker: receipt.worker,
    ownerAgent: receipt.ownerAgent,
    requestedBy: receipt.requestedBy,
    status: receipt.status,
    verifierStatus: receipt.verifierStatus,
    startedAt: receipt.startedAt,
    finishedAt: receipt.finishedAt,
    summary: receipt.summary,
    rootCause: receipt.rootCause || null,
    actions: receipt.actions,
    evidence: receipt.evidence,
    memoryCandidates: receipt.memoryCandidates,
    receiptPath,
    ownerWorkspacePath,
    transcriptIncluded: false
  };
  appendFileSync(ownerBrainPath, `${JSON.stringify(brainRecord)}\n`);

  return { receiptPath, ownerWorkspacePath, ownerBrainPath };
}

export function readWorkerReceipt(receiptPath: string): WorkerRunReceipt {
  if (!existsSync(receiptPath)) throw new Error(`Receipt not found: ${receiptPath}`);
  return JSON.parse(readFileSync(receiptPath, 'utf8')) as WorkerRunReceipt;
}
