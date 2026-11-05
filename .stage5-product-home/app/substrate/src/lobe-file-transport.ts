/**
 * File-exchange lobe transport — cognition across the membrane without
 * credentials (Cut 4 tail: the lobe broker's Seed-side half).
 *
 * A Seed living on minimal hardware (the Pi) holds no provider keys and
 * opens no listening ports. When it wants to recruit a lobe, it writes a
 * request file into an exchange directory and waits. A broker on a trusted
 * machine (the Mac, which already reaches the Pi over ssh) polls the
 * exchange, services the request with its own provider credentials, and
 * writes back a result file carrying the REAL model receipt. Keys never
 * move; the Pi never listens; the trusted side initiates every connection.
 *
 * The result re-enters the Seed only through the existing lobe membrane
 * (validateLobeResult's hard allowlist) — this transport moves bytes, it
 * grants nothing. Replay never re-calls a transport, so wall-clock use
 * here is honest (same as every model call).
 */

import { writeFileSync, readFileSync, mkdirSync, readdirSync, unlinkSync, renameSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelReceipt } from './types.js';
import type { LobeTransport } from './lobe.js';

export interface LobeFileRequest {
  id: string;
  prompt: string;
  createdAt: string;
}

export interface LobeFileResult {
  id: string;
  text?: string;
  modelReceipt?: ModelReceipt;
  /** Set when the broker could not service the request (model failure,
   * malformed request). Surfaces Seed-side as an honest lobe error receipt. */
  error?: string;
}

const ID_PATTERN = /^req_[a-z0-9]+_[0-9]+$/;
const MAX_PROMPT_BYTES = 64 * 1024;
const ORPHAN_RESULT_MAX_AGE_MS = 30 * 60 * 1000;

export function requestsDir(exchangeDir: string): string {
  return join(exchangeDir, 'requests');
}

export function resultsDir(exchangeDir: string): string {
  return join(exchangeDir, 'results');
}

/** Parse + validate a request file's contents. Throws on anything malformed —
 * the broker turns that throw into an error result, never silence. */
export function parseLobeRequest(raw: string): LobeFileRequest {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const id = parsed['id'];
  const prompt = parsed['prompt'];
  const createdAt = parsed['createdAt'];
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new Error('lobe request: bad id');
  if (typeof prompt !== 'string' || prompt.length === 0) throw new Error('lobe request: bad prompt');
  if (Buffer.byteLength(prompt, 'utf-8') > MAX_PROMPT_BYTES) throw new Error('lobe request: prompt too large');
  if (typeof createdAt !== 'string') throw new Error('lobe request: bad createdAt');
  return { id, prompt, createdAt };
}

export function formatLobeResult(result: LobeFileResult): string {
  return JSON.stringify(result);
}

function parseLobeResultFile(raw: string): LobeFileResult {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed['id'] !== 'string') throw new Error('lobe result: bad id');
  if (typeof parsed['error'] === 'string') return { id: parsed['id'], error: parsed['error'] };
  const receipt = parsed['modelReceipt'] as ModelReceipt | undefined;
  if (typeof parsed['text'] !== 'string' || receipt === undefined || typeof receipt.modelId !== 'string') {
    throw new Error('lobe result: missing text or modelReceipt');
  }
  return { id: parsed['id'], text: parsed['text'], modelReceipt: receipt };
}

let requestCounter = 0;

export interface FileLobeTransportOptions {
  /** How often to check for the result file. Default 2000ms. */
  pollMs?: number;
  /** Give up (and withdraw the request) after this long. Default 180000ms —
   * must comfortably exceed the broker's poll interval + model latency. */
  timeoutMs?: number;
}

/** Seed-side transport: write request, wait for the broker's result. */
export function createFileLobeTransport(exchangeDir: string, opts: FileLobeTransportOptions = {}): LobeTransport {
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const reqDir = requestsDir(exchangeDir);
  const resDir = resultsDir(exchangeDir);
  mkdirSync(reqDir, { recursive: true });
  mkdirSync(resDir, { recursive: true });

  return async (prompt: string) => {
    sweepOrphanResults(resDir);
    requestCounter += 1;
    const id = `req_${Date.now().toString(36)}_${requestCounter}`;
    const request: LobeFileRequest = { id, prompt, createdAt: new Date().toISOString() };
    const finalPath = join(reqDir, `${id}.json`);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(request), 'utf-8');
    renameSync(tmpPath, finalPath);

    const resultPath = join(resDir, `res-${id}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(resultPath)) {
        const result = parseLobeResultFile(readFileSync(resultPath, 'utf-8'));
        try { unlinkSync(resultPath); } catch { /* already gone */ }
        try { unlinkSync(finalPath); } catch { /* broker consumed it */ }
        if (result.error !== undefined) throw new Error(`broker: ${result.error}`);
        return { text: result.text as string, modelReceipt: result.modelReceipt as ModelReceipt };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    // Withdraw the request so the broker doesn't service a dead one later.
    try { unlinkSync(finalPath); } catch { /* broker may have consumed it */ }
    throw new Error(`file lobe transport: no result within ${timeoutMs}ms`);
  };
}

/** Results whose requester gave up long ago are exhaust — remove them. */
function sweepOrphanResults(resDir: string): void {
  let names: string[];
  try { names = readdirSync(resDir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!name.startsWith('res-') || !name.endsWith('.json')) continue;
    try {
      const full = join(resDir, name);
      if (now - statSync(full).mtimeMs > ORPHAN_RESULT_MAX_AGE_MS) unlinkSync(full);
    } catch { /* raced with consumer — fine */ }
  }
}
