import { dirname, join } from 'node:path';

export function brainDirFromWorkspace(workspacePath: string): string {
  if (workspacePath.endsWith('/workspace')) {
    return workspacePath.replace(/\/workspace$/, '/brain');
  }
  return join(dirname(workspacePath), 'brain');
}

export function contactReceiptPath(workspacePath: string): string {
  return join(brainDirFromWorkspace(workspacePath), 'contact-receipts.jsonl');
}

export function artifactRoot(workspacePath: string): string {
  return join(brainDirFromWorkspace(workspacePath), 'artifacts');
}

export function captureInbox(workspacePath: string): string {
  return join(workspacePath, 'intake');
}

export function commsDraftDir(workspacePath: string): string {
  return join(workspacePath, 'comms', 'drafts');
}
