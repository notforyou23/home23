/**
 * COSMO Home 2.3 — CDP Browser Controller
 *
 * Thin wrapper over Chrome DevTools Protocol using HTTP endpoints
 * for target management and WebSocket for runtime commands.
 * Every wait is bounded, and it only drives Home23's managed browser.
 */

import { existsSync } from 'node:fs';
import { readlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserConfig } from '../types.js';
import { WebSocket as WS } from 'ws';

// ─── Types ───────────────────────────────────────────────────

export interface CDPTarget {
  id: string;
  title: string;
  url: string;
  type: string;
}

interface CDPVersionInfo {
  Browser: string;
  'Protocol-Version': string;
  'User-Agent': string;
  'V8-Version': string;
  'WebKit-Version': string;
  webSocketDebuggerUrl?: string;
}

interface CDPResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

// ─── Typed failures ──────────────────────────────────────────

export type BrowserErrorCode = 'browser_unavailable' | 'browser_endpoint_not_managed';

const OWNER_ACTION = 'Do not launch or reconfigure Chrome yourself; tell the owner.';

export const BROWSER_DISABLED_MESSAGE = `browser_unavailable (disabled): Home23's managed browser is not enabled for this resident. ${OWNER_ACTION}`;

/** A typed CDP failure; its message tells the resident what the owner must do. */
export class BrowserUnavailableError extends Error {
  readonly code: BrowserErrorCode;
  readonly reason: string;
  constructor(code: BrowserErrorCode, reason: string, message: string) {
    super(message);
    this.name = 'BrowserUnavailableError';
    this.code = code;
    this.reason = reason;
  }
}

function unavailable(cdpUrl: string, reason: string, detail?: string): BrowserUnavailableError {
  return new BrowserUnavailableError('browser_unavailable', reason,
    `browser_unavailable (${reason}): Home23's managed browser is unavailable at ${cdpUrl}${detail ? ` (${detail})` : ''}. ${OWNER_ACTION}`);
}

function notManaged(cdpUrl: string, detail: string): BrowserUnavailableError {
  return new BrowserUnavailableError('browser_endpoint_not_managed', 'not_managed',
    `browser_endpoint_not_managed: the browser answering at ${cdpUrl} is not Home23's managed browser (${detail}); Home23 will not drive it. ${OWNER_ACTION}`);
}

// The launcher's binaries (scripts/chrome-cdp.sh); only used to tell the owner which fix applies.
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function errorCode(error: unknown): string | undefined {
  const value = error as { code?: unknown; cause?: { code?: unknown; errors?: Array<{ code?: unknown }> }; errors?: Array<{ code?: unknown }> } | undefined;
  const code = value?.code ?? value?.cause?.code ?? value?.errors?.[0]?.code ?? value?.cause?.errors?.[0]?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Why nothing usable answered: timeout, not_started, chrome_not_installed or unreachable. */
export function browserUnavailableReason(error: unknown, platform: string = process.platform, candidates: string[] = CHROME_CANDIDATES): string {
  const name = (error as { name?: string } | undefined)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (errorCode(error) === 'ECONNREFUSED') {
    return platform === 'darwin' && !candidates.some((candidate) => existsSync(candidate)) ? 'chrome_not_installed' : 'not_started';
  }
  return 'unreachable';
}

// ─── Managed-browser identity ────────────────────────────────

/**
 * The managed profile, computed exactly as the launcher does
 * (`${CDP_USER_DATA_DIR:-$HOME/.home23/chrome-cdp}`); the owner-home contract
 * pins CDP_USER_DATA_DIR for every Host process.
 */
export function managedProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CDP_USER_DATA_DIR?.trim() || join(env.HOME?.trim() || homedir(), '.home23', 'chrome-cdp');
}

/** Chrome's SingletonLock is a symlink to "<host>-<pid>" of the browser holding the profile. */
async function profileOwnerPid(profileDir: string): Promise<number | undefined> {
  try {
    const pid = Number(/-(\d+)$/.exec(await readlink(join(profileDir, 'SingletonLock')))?.[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

// ─── Browser Controller ─────────────────────────────────────

export class BrowserController {
  private config: BrowserConfig;
  private browserInfo: CDPVersionInfo | null = null;
  private sockets = new Map<string, WS>();
  private messageId = 1;
  private verifiedEndpoint: string | null = null;
  private readonly httpTimeoutMs: number;
  private readonly socketTimeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(config: BrowserConfig) {
    this.config = config;
    this.httpTimeoutMs = config.connectTimeoutMs ?? 3_000;
    this.socketTimeoutMs = config.connectTimeoutMs ?? 5_000;
    this.commandTimeoutMs = config.commandTimeoutMs ?? 30_000;
  }

  async connect(): Promise<void> {
    const res = await this.request('/json/version');
    if (!res.ok) throw unavailable(this.config.cdpUrl, `http_${res.status}`);
    const info = await this.readJson<CDPVersionInfo>(res);
    await this.verifyManaged(info);
    const changed = this.browserInfo?.webSocketDebuggerUrl !== info.webSocketDebuggerUrl;
    this.browserInfo = info;
    if (changed) console.log(`[cdp] Connected to ${info.Browser}`);
  }

  async getTargets(): Promise<CDPTarget[]> {
    const res = await this.request('/json');
    if (!res.ok) {
      throw new Error(`CDP getTargets failed: ${res.status}`);
    }
    const raw = await this.readJson<Array<Record<string, string | undefined>>>(res);
    return raw.map(t => ({
      id: t.id ?? '',
      title: t.title ?? '',
      url: t.url ?? '',
      type: t.type ?? '',
    }));
  }

  async navigate(targetId: string, url: string): Promise<void> {
    await this.sendCommand(targetId, 'Page.navigate', { url });
  }

  async evaluate(targetId: string, expression: string): Promise<unknown> {
    if ((this.config as unknown as Record<string, unknown>).evaluateEnabled === false) {
      throw new Error('[cdp] JavaScript evaluation is disabled in config');
    }
    const result = await this.sendCommand(targetId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
    });
    const evalResult = result as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (evalResult.exceptionDetails) {
      throw new Error(`[cdp] Evaluation error: ${JSON.stringify(evalResult.exceptionDetails)}`);
    }
    return evalResult.result?.value;
  }

  async screenshot(targetId: string): Promise<Buffer> {
    const result = await this.sendCommand(targetId, 'Page.captureScreenshot', {
      format: 'png',
    });
    const { data } = result as { data: string };
    return Buffer.from(data, 'base64');
  }

  async newTab(url?: string): Promise<CDPTarget> {
    const res = await this.request(url ? `/json/new?${url}` : '/json/new', { method: 'PUT' });
    if (!res.ok) {
      throw new Error(`CDP newTab failed: ${res.status}`);
    }
    const raw = await this.readJson<Record<string, string | undefined>>(res);
    return {
      id: raw.id ?? '',
      title: raw.title ?? '',
      url: raw.url ?? '',
      type: raw.type ?? '',
    };
  }

  async closeTab(targetId: string): Promise<void> {
    const res = await this.request(`/json/close/${targetId}`);
    if (!res.ok) {
      throw new Error(`CDP closeTab failed: ${res.status}`);
    }
  }

  disconnect(): void {
    this.sockets.forEach((ws) => {
      ws.close();
    });
    this.sockets.clear();
    this.browserInfo = null;
    this.verifiedEndpoint = null;
    console.log('[cdp] Disconnected');
  }

  // ─── Internal HTTP/WebSocket Helpers ─────────────────────────

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(`${this.config.cdpUrl}${path}`, { ...init, signal: AbortSignal.timeout(this.httpTimeoutMs) });
    } catch (error) {
      throw unavailable(this.config.cdpUrl, browserUnavailableReason(error));
    }
  }

  private async readJson<T>(res: Response): Promise<T> {
    try {
      return (await res.json()) as T;
    } catch (error) {
      throw unavailable(this.config.cdpUrl, error instanceof SyntaxError ? 'invalid_response' : browserUnavailableReason(error));
    }
  }

  /**
   * Whatever answers the port must be the browser that holds Home23's
   * managed profile: the pid in the profile's SingletonLock must be the pid
   * the answering browser reports for itself.
   */
  private async verifyManaged(info: CDPVersionInfo): Promise<void> {
    const endpoint = info.webSocketDebuggerUrl ?? '';
    if (endpoint && endpoint === this.verifiedEndpoint) return;
    const profile = managedProfileDir();
    const ownerPid = await profileOwnerPid(profile);
    if (ownerPid === undefined) {
      // A source install may point cdpUrl at a hand-run browser; a Host home only drives its own.
      if (process.env.HOME23_PRODUCT_HOST !== 'true') return;
      throw notManaged(this.config.cdpUrl, `no managed browser holds ${profile}`);
    }
    const browserPid = endpoint ? await this.browserPid(endpoint) : undefined;
    if (browserPid !== ownerPid) {
      throw notManaged(this.config.cdpUrl, `it reports pid ${browserPid ?? 'unknown'}, the managed profile ${profile} is held by pid ${ownerPid}`);
    }
    this.verifiedEndpoint = endpoint;
  }

  private async browserPid(endpoint: string): Promise<number | undefined> {
    const ws = await this.openSocket(endpoint);
    try {
      const result = await this.command(ws, 'SystemInfo.getProcessInfo') as { processInfo?: Array<{ type?: string; id?: number }> };
      return result.processInfo?.find((entry) => entry.type === 'browser')?.id;
    } catch (error) {
      if (error instanceof BrowserUnavailableError) throw error;
      return undefined;
    } finally {
      ws.close();
    }
  }

  private openSocket(url: string): Promise<WS> {
    const ws = new WS(url);
    // Without a standing listener, a late socket 'error' event would crash the process.
    ws.on('error', () => undefined);
    return new Promise<WS>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(unavailable(this.config.cdpUrl, 'timeout', 'the DevTools WebSocket did not open'));
        ws.terminate();
      }, this.socketTimeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        resolve(ws);
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(unavailable(this.config.cdpUrl, browserUnavailableReason(error)));
      });
    });
  }

  private async getSocket(targetId: string): Promise<WS> {
    const existing = this.sockets.get(targetId);
    if (existing && existing.readyState === WS.OPEN) {
      return existing;
    }

    const res = await this.request('/json');
    if (!res.ok) throw new Error(`CDP getTargets failed: ${res.status}`);
    const targets = await this.readJson<Array<Record<string, string>>>(res);
    const target = targets.find(t => t.id === targetId);
    if (!target?.webSocketDebuggerUrl) {
      throw new Error(`[cdp] No WebSocket URL for target ${targetId}`);
    }

    const ws = await this.openSocket(target.webSocketDebuggerUrl);
    ws.once('close', () => {
      if (this.sockets.get(targetId) === ws) this.sockets.delete(targetId);
    });
    this.sockets.set(targetId, ws);
    return ws;
  }

  private async sendCommand(
    targetId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    return this.command(await this.getSocket(targetId), method, params);
  }

  private command(ws: WS, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.messageId++;

    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        ws.off('message', handler);
        ws.off('close', onClose);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`browser_command_timeout: [cdp] Command ${method} timed out after ${this.commandTimeoutMs} ms`));
      }, this.commandTimeoutMs);
      const onClose = () => {
        cleanup();
        reject(unavailable(this.config.cdpUrl, 'connection_closed', `the socket closed during ${method}`));
      };
      const handler = (data: WS.RawData) => {
        let msg: CDPResponse;
        try {
          msg = JSON.parse(data.toString()) as CDPResponse;
        } catch {
          return;
        }
        if (msg.id !== id) return;
        cleanup();
        if (msg.error) {
          reject(new Error(`[cdp] ${method} error: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      };

      ws.on('message', handler);
      ws.once('close', onClose);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
