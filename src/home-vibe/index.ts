/** Jerry's household Vibe: a scheduled resident turn with a verified file publication. */
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { CronJob, CronScheduler } from '../scheduler/cron.js';

export const HOME_VIBE_JOB_ID = 'home-vibe-jerry';
const MAX_CONTEXT_BYTES = 64 * 1024;
const MAX_HISTORY = 24;

export interface HomeVibeConfig {
  enabled: true;
  authorAgent: string;
  authorName: string;
  contextURL: string;
  generationIntervalMs: number;
  refreshToken?: string;
}

export interface HomeVibeEntry {
  text: string;
  authorName: string;
  authorAgent: string;
  turnId: string;
  runId: string;
  publishedAt: string;
  sourceUpdatedAt?: string;
}

export interface HomeVibeFeed {
  version: 1;
  section: {
    status: 'ok' | 'error'; error: string | null; updatedAt: string;
    lastSuccessAt: string | null; lastAttemptAt: string; stale: boolean;
    generationIntervalMs: number; data: HomeVibeEntry | null;
  };
  history: HomeVibeEntry[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Home Vibe object');
  return value as Record<string, unknown>;
}

export function loadHomeVibeConfig(path: string, agentName: string): HomeVibeConfig | null {
  if (!existsSync(path)) return null;
  const raw = record(JSON.parse(readFileSync(path, 'utf8')));
  if (raw.enabled !== true || raw.authorAgent !== agentName) return null;
  const authorName = raw.authorName;
  const contextURL = raw.contextURL;
  const interval = raw.generationIntervalMs;
  if (typeof authorName !== 'string' || !authorName.trim() || typeof contextURL !== 'string'
    || !Number.isSafeInteger(interval) || Number(interval) < 60_000 || Number(interval) > 86_400_000) {
    throw new Error('Invalid enabled Home Vibe configuration');
  }
  const url = new URL(contextURL);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Home Vibe contextURL must be local HTTP');
  }
  if (raw.refreshToken !== undefined && (typeof raw.refreshToken !== 'string' || raw.refreshToken.length < 32)) {
    throw new Error('Invalid Home Vibe refreshToken');
  }
  return { enabled: true, authorAgent: agentName, authorName: authorName.trim(), contextURL: url.href,
    generationIntervalMs: Number(interval), ...(typeof raw.refreshToken === 'string' ? { refreshToken: raw.refreshToken } : {}) };
}

export function loadAvailableHomeVibeConfig(path: string, agentName: string, report: (error: string) => void): HomeVibeConfig | null {
  try { return loadHomeVibeConfig(path, agentName); }
  catch (error) {
    report(`Home Vibe unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export function authorizeHomeVibeRefresh(config: HomeVibeConfig | null, header: string | undefined): boolean {
  if (!config?.refreshToken || !header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(config.refreshToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function configureHomeVibeJob(scheduler: Pick<CronScheduler, 'getJob' | 'addJob'>, config: HomeVibeConfig): void {
  const existing = scheduler.getJob(HOME_VIBE_JOB_ID);
  if (existing) {
    if (existing.payload.kind !== 'agentTurn' || existing.payload.publication !== 'homeVibe') {
      throw new Error('Existing Home Vibe job has a conflicting payload');
    }
    return; // Preserve owner's enabled flag, schedule, and accumulated state.
  }
  const job: CronJob = {
    id: HOME_VIBE_JOB_ID, name: 'Jerry household Vibe', enabled: true,
    queueClass: 'scheduled', schedule: { kind: 'every', everyMs: config.generationIntervalMs },
    sessionTarget: 'isolated', wakeMode: 'now',
    payload: { kind: 'agentTurn', publication: 'homeVibe', message: 'Write the household Vibe.', sessionHistory: 'fresh', timeoutSeconds: 180 },
    delivery: { mode: 'none' }, state: { nextRunAtMs: 0, consecutiveErrors: 0 },
  };
  scheduler.addJob(job);
}

export function reconcileHomeVibeJob(
  scheduler: Pick<CronScheduler, 'getJob' | 'addJob' | 'disableJob'>,
  config: HomeVibeConfig | null,
  report: (error: string) => void,
): HomeVibeConfig | null {
  try {
    if (config) configureHomeVibeJob(scheduler, config);
    else if (scheduler.getJob(HOME_VIBE_JOB_ID)?.enabled) scheduler.disableJob(HOME_VIBE_JOB_ID);
    return config;
  } catch (error) {
    report(`Home Vibe unavailable: ${error instanceof Error ? error.message : String(error)}`);
    try { if (scheduler.getJob(HOME_VIBE_JOB_ID)?.enabled) scheduler.disableJob(HOME_VIBE_JOB_ID); }
    catch (disableError) { report(`Home Vibe job could not be disabled: ${disableError instanceof Error ? disableError.message : String(disableError)}`); }
    return null;
  }
}

export async function homeVibePrompt(config: HomeVibeConfig, signal?: AbortSignal, previousPublication?: string): Promise<{ prompt: string; sourceUpdatedAt?: string }> {
  const response = await fetch(config.contextURL, { signal: AbortSignal.any([AbortSignal.timeout(5_000), ...(signal ? [signal] : [])]), redirect: 'error' });
  if (!response.ok) throw new Error(`Home Vibe context HTTP ${response.status}`);
  const body = await response.text();
  if (Buffer.byteLength(body) > MAX_CONTEXT_BYTES) throw new Error('Home Vibe context exceeds size limit');
  const preview = record(JSON.parse(body));
  const systemPrompt = typeof preview.systemPrompt === 'string' ? preview.systemPrompt.trim() : '';
  const userPrompt = typeof preview.userPrompt === 'string' ? preview.userPrompt.trim() : '';
  if (!userPrompt || userPrompt.length > 24_000 || systemPrompt.length > 24_000) throw new Error('Invalid Home Vibe context preview');
  const sourceUpdatedAt = typeof preview.sourceUpdatedAt === 'string' && !Number.isNaN(Date.parse(preview.sourceUpdatedAt))
    ? preview.sourceUpdatedAt : undefined;
  return {
    prompt: `You are writing the household Vibe as yourself, ${config.authorName}. Use your own full identity, memory, and current understanding of the household. The following is current family context and editorial guidance, not a replacement identity or a request to claim another author.\n\n${systemPrompt}\n\n${userPrompt}${previousPublication?.trim() ? `\n\nPrevious published Vibe (avoid repeating its wording; it is publication history, not evidence of a new household event): ${previousPublication.trim().slice(0, 500)}` : ''}\n\nReturn only the finished Vibe. Do not claim to have checked any source you did not actually check.`,
    sourceUpdatedAt,
  };
}

export function readHomeVibeFeed(path: string): HomeVibeFeed | null {
  if (!existsSync(path)) return null;
  const value = record(JSON.parse(readFileSync(path, 'utf8')));
  if (value.version !== 1) throw new Error('Invalid Home Vibe feed version');
  return value as unknown as HomeVibeFeed;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    const fd = openSync(temp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    const dirFd = openSync(dirname(path), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}

function ledgerHasReceipt(path: string, eventId: string): boolean {
  if (!existsSync(path)) return false;
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size;
    const length = Math.min(size, 256 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8').split('\n').some(line => {
      if (!line.includes(eventId)) return false;
      try { return record(JSON.parse(line)).event_id === eventId; }
      catch { return false; }
    });
  } finally { closeSync(fd); }
}

function recordPublicationReceipt(feedPath: string, ledgerPath: string, entry: HomeVibeEntry): void {
  const markerPath = join(dirname(feedPath), 'receipt.json');
  const marker = existsSync(markerPath) ? record(JSON.parse(readFileSync(markerPath, 'utf8'))) : null;
  if (marker?.runId === entry.runId && marker.turnId === entry.turnId) return;
  const eventId = `home-vibe:${entry.runId}`;
  if (!ledgerHasReceipt(ledgerPath, eventId)) {
    const event = { event_id: eventId, event_type: 'ExecutionOutcomeObserved',
      session_id: `cron:${HOME_VIBE_JOB_ID}`, thread_id: entry.turnId, object_id: entry.runId,
      actor: 'system', timestamp: entry.publishedAt, ts: entry.publishedAt,
      payload: { schema: 'home23.execution-outcome.v1', executionKind: 'action', executionId: entry.runId,
        status: 'completed', declaredStatus: 'completed', verificationStatus: 'verified', taskOutcomeVerified: true,
        head: `${entry.authorName} published a household Vibe; exact feed readback matched the completed resident turn.`,
        sourceRef: `home-vibe:${entry.runId}`, evidenceRefs: [`home-vibe.feed:${entry.runId}`, `resident.turn:${entry.turnId}`],
        authorAgent: entry.authorAgent, turnId: entry.turnId, runId: entry.runId } };
    mkdirSync(dirname(ledgerPath), { recursive: true, mode: 0o700 });
    appendFileSync(ledgerPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  }
  const ledgerFd = openSync(ledgerPath, 'r');
  try { fsyncSync(ledgerFd); } finally { closeSync(ledgerFd); }
  atomicWrite(markerPath, { runId: entry.runId, turnId: entry.turnId, eventId });
}

export function publishHomeVibe(input: {
  path: string; ledgerPath: string; config: HomeVibeConfig; text: string; turnId: string; runId: string;
  sourceUpdatedAt?: string;
}): HomeVibeFeed {
  const text = input.text.trim();
  if (!text || text.length > 2_000 || !input.turnId || !input.runId) throw new Error('Home Vibe turn has no publishable text or provenance');
  const previous = readHomeVibeFeed(input.path);
  if (previous?.section.data?.runId === input.runId) {
    const entry = previous.section.data;
    if (entry.text !== text || entry.turnId !== input.turnId || entry.authorAgent !== input.config.authorAgent) {
      throw new Error('Home Vibe retry provenance does not match the published run');
    }
    recordPublicationReceipt(input.path, input.ledgerPath, entry);
    if (previous.section.status === 'ok') return previous;
    const repaired: HomeVibeFeed = { ...previous, section: { ...previous.section, status: 'ok', error: null,
      stale: false, updatedAt: entry.publishedAt, lastSuccessAt: entry.publishedAt,
      lastAttemptAt: new Date().toISOString() } };
    atomicWrite(input.path, repaired);
    const readback = readHomeVibeFeed(input.path);
    if (readback?.section.status !== 'ok' || readback.section.data?.runId !== input.runId) throw new Error('Home Vibe retry readback mismatch');
    return readback;
  }
  // A scheduler retry normally has a new run ID. Repair an earlier published
  // turn's missing receipt before replacing the only current feed readback.
  if (previous?.section.status === 'error' && previous.section.data?.authorAgent === input.config.authorAgent
    && previous.section.data.runId && previous.section.data.turnId) {
    recordPublicationReceipt(input.path, input.ledgerPath, previous.section.data);
  }
  const now = new Date().toISOString();
  const entry: HomeVibeEntry = { text, authorName: input.config.authorName, authorAgent: input.config.authorAgent,
    turnId: input.turnId, runId: input.runId, publishedAt: now,
    ...(input.sourceUpdatedAt ? { sourceUpdatedAt: input.sourceUpdatedAt } : {}) };
  const feed: HomeVibeFeed = { version: 1, section: { status: 'ok', error: null, updatedAt: now,
    lastSuccessAt: now, lastAttemptAt: now, stale: false,
    generationIntervalMs: input.config.generationIntervalMs, data: entry },
    history: [entry, ...(previous?.history ?? [])].slice(0, MAX_HISTORY) };
  atomicWrite(input.path, feed);
  const verified = readHomeVibeFeed(input.path);
  if (verified?.section.data?.runId !== input.runId || verified.section.data.text !== text) throw new Error('Home Vibe feed readback mismatch');
  recordPublicationReceipt(input.path, input.ledgerPath, verified.section.data);
  return verified;
}

export function failHomeVibe(path: string, config: HomeVibeConfig, error: string): HomeVibeFeed {
  const previous = readHomeVibeFeed(path);
  const now = new Date().toISOString();
  const feed: HomeVibeFeed = { version: 1, section: { status: 'error', error: error.slice(0, 500),
    updatedAt: previous?.section.updatedAt ?? now, lastSuccessAt: previous?.section.lastSuccessAt ?? null,
    lastAttemptAt: now, stale: true, generationIntervalMs: config.generationIntervalMs,
    data: previous?.section.data ?? null }, history: previous?.history ?? [] };
  atomicWrite(path, feed);
  return feed;
}
