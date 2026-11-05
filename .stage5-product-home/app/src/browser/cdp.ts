/**
 * COSMO Home 2.3 — CDP Browser Controller
 *
 * Thin wrapper over Chrome DevTools Protocol using HTTP endpoints
 * for target management and WebSocket for runtime commands.
 */

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

// ─── Browser Controller ─────────────────────────────────────

export class BrowserController {
  private config: BrowserConfig;
  private browserInfo: CDPVersionInfo | null = null;
  private sockets = new Map<string, WS>();
  private messageId = 1;

  constructor(config: BrowserConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const res = await fetch(`${this.config.cdpUrl}/json/version`);
    if (!res.ok) {
      throw new Error(`CDP connect failed: ${res.status} ${res.statusText}`);
    }
    this.browserInfo = (await res.json()) as CDPVersionInfo;
    console.log(`[cdp] Connected to ${this.browserInfo.Browser}`);
  }

  async getTargets(): Promise<CDPTarget[]> {
    const res = await fetch(`${this.config.cdpUrl}/json`);
    if (!res.ok) {
      throw new Error(`CDP getTargets failed: ${res.status}`);
    }
    const raw = (await res.json()) as Array<Record<string, string | undefined>>;
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
    const endpoint = url
      ? `${this.config.cdpUrl}/json/new?${url}`
      : `${this.config.cdpUrl}/json/new`;
    const res = await fetch(endpoint, { method: 'PUT' });
    if (!res.ok) {
      throw new Error(`CDP newTab failed: ${res.status}`);
    }
    const raw = (await res.json()) as Record<string, string | undefined>;
    return {
      id: raw.id ?? '',
      title: raw.title ?? '',
      url: raw.url ?? '',
      type: raw.type ?? '',
    };
  }

  async closeTab(targetId: string): Promise<void> {
    const res = await fetch(`${this.config.cdpUrl}/json/close/${targetId}`);
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
    console.log('[cdp] Disconnected');
  }

  // ─── Internal WebSocket Helpers ─────────────────────────────

  private async getSocket(targetId: string): Promise<WS> {
    const existing = this.sockets.get(targetId);
    if (existing && existing.readyState === WS.OPEN) {
      return existing;
    }

    const res = await fetch(`${this.config.cdpUrl}/json`);
    const targets = (await res.json()) as Array<Record<string, string>>;
    const target = targets.find(t => t.id === targetId);
    if (!target?.webSocketDebuggerUrl) {
      throw new Error(`[cdp] No WebSocket URL for target ${targetId}`);
    }

    const ws = new WS(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    this.sockets.set(targetId, ws);
    return ws;
  }

  private async sendCommand(
    targetId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<unknown> {
    const ws = await this.getSocket(targetId);
    const id = this.messageId++;

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`[cdp] Command ${method} timed out`));
      }, 30_000);

      const handler = (data: Buffer | ArrayBuffer | Buffer[]) => {
        const msg = JSON.parse(data.toString()) as CDPResponse;
        if (msg.id !== id) return;
        ws.off('message', handler);
        clearTimeout(timeout);
        if (msg.error) {
          reject(new Error(`[cdp] ${method} error: ${msg.error.message}`));
        } else {
          resolve(msg.result);
        }
      };

      ws.on('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
}
