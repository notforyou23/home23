import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectResidentWrite } from '../tools/tracked-source-guard.js';
import type { ArtifactRecord } from './types.js';
import { artifactRoot, captureInbox } from './paths.js';

const TEXT_EXTS = new Set(['.md', '.txt', '.json', '.csv', '.html', '.htm', '.xml', '.yml', '.yaml']);

function mimeGuess(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic'].includes(ext)) return `image/${ext.slice(1)}`;
  if (ext === '.pdf') return 'application/pdf';
  if (['.mp3', '.wav', '.m4a', '.ogg'].includes(ext)) return `audio/${ext.slice(1)}`;
  if (TEXT_EXTS.has(ext)) return 'text/plain';
  return 'application/octet-stream';
}

function extractCommitments(text: string): string[] {
  const candidates: string[] = [];
  const date = text.match(/\b(?:due|by|on)\s+\d{1,4}[\/\-]\d{1,2}[\/\-]\d{1,4}\b/i);
  if (date) candidates.push(`date: ${date[0]}`);
  const money = text.match(/\$\s?\d[\d,]*(?:\.\d{2})?/);
  if (money) candidates.push(`amount: ${money[0]}`);
  const todo = text.match(/\b(todo|follow up|call|email|pay|renew|rsvp)\b/i);
  if (todo) candidates.push(`action: ${todo[0]}`);
  return candidates;
}

function excerptOf(filePath: string, bytes: number): string | undefined {
  if (bytes > 200_000) return undefined;
  if (!TEXT_EXTS.has(extname(filePath).toLowerCase())) return undefined;
  try {
    return readFileSync(filePath, 'utf8').slice(0, 1500);
  } catch {
    return undefined;
  }
}

export function captureArtifact(input: {
  sourcePath: string;
  workspacePath: string;
  projectRoot: string;
  project?: string;
}): ArtifactRecord {
  const sourcePath = resolve(input.sourcePath);
  if (!existsSync(sourcePath)) throw new Error(`source not found: ${sourcePath}`);
  const stat = statSync(sourcePath);
  if (!stat.isFile()) throw new Error(`source is not a file: ${sourcePath}`);

  const id = `art_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${randomUUID().slice(0, 8)}`;
  const dir = join(artifactRoot(input.workspacePath), id);
  const originalName = basename(sourcePath);
  const archivePath = join(dir, originalName);
  const decision = inspectResidentWrite(archivePath, input.projectRoot);
  if (!decision.allow) throw new Error(decision.reason);

  mkdirSync(dir, { recursive: true });
  copyFileSync(sourcePath, archivePath);
  const excerpt = excerptOf(archivePath, stat.size);
  const record: ArtifactRecord = {
    id,
    archivedAt: new Date().toISOString(),
    originalName,
    originalPath: sourcePath,
    archivePath,
    mimeGuess: mimeGuess(originalName),
    bytes: stat.size,
    project: input.project,
    excerpt,
    actionCandidates: extractCommitments(`${originalName}\n${excerpt ?? ''}`),
  };
  writeFileSync(join(dir, 'provenance.json'), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

export function retrieveArtifact(workspacePath: string, artifactId: string): ArtifactRecord {
  const dir = join(artifactRoot(workspacePath), artifactId);
  const provenancePath = join(dir, 'provenance.json');
  if (!existsSync(provenancePath)) throw new Error(`artifact not found: ${artifactId}`);
  return JSON.parse(readFileSync(provenancePath, 'utf8')) as ArtifactRecord;
}

export function listInbox(workspacePath: string): string[] {
  const dir = captureInbox(workspacePath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .map((name) => join(dir, name))
    .filter((filePath) => {
      try { return statSync(filePath).isFile(); } catch { return false; }
    });
}
