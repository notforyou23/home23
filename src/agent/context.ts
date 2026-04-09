/**
 * COSMO Home 2.3 — Context Manager
 *
 * Loads identity files (SOUL, MISSION, HEARTBEAT, MEMORY, LEARNINGS),
 * assembles the system prompt, and handles cache invalidation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import type { ContextManagerRef, PromptSourceInfo } from './types.js';
import type { IdentityLayerConfig } from '../types.js';
import { buildSystemPrompt } from '../agents/system-prompt.js';

export interface ContextConfig {
  workspacePath: string;
  identityFiles: string[];
  identityLayers?: IdentityLayerConfig[];
  heartbeatRefreshMs: number;
  enginePort: number;
  ownerName?: string;
  ownerTelegramId?: string;
}

export class ContextManager implements ContextManagerRef {
  private config: ContextConfig;
  private systemPrompt: string = '';
  private promptSourceInfo: PromptSourceInfo = {
    generatedAt: new Date(0).toISOString(),
    totalSections: 0,
    loadedFiles: [],
  };
  private heartbeatLastLoad = 0;
  private dirty = true;
  private lastProvider = '';

  constructor(config: ContextConfig) {
    this.config = config;
    this.rebuild();
  }

  getSystemPrompt(provider?: string): string {
    this.refreshHeartbeatIfNeeded();
    const p = provider ?? 'anthropic';
    if (this.dirty || p !== this.lastProvider) {
      this.rebuild(p);
    }
    return this.systemPrompt;
  }

  invalidate(): void {
    this.dirty = true;
  }

  getPromptSourceInfo(): PromptSourceInfo {
    this.refreshHeartbeatIfNeeded();
    if (this.dirty) {
      this.rebuild();
    }
    return this.promptSourceInfo;
  }

  private rebuild(provider: string = 'anthropic'): void {
    const sections: string[] = [];
    const loadedFiles: PromptSourceInfo['loadedFiles'] = [];

    this.getIdentityLayers().forEach((layer, layerIndex) => {
      for (const filename of layer.files) {
        const filePath = resolve(layer.basePath, filename);
        const label = filename.replace('.md', '').toUpperCase();
        const exists = existsSync(filePath);

        if (!exists) {
          loadedFiles.push({
            layerIndex,
            basePath: layer.basePath,
            filename,
            filePath,
            label,
            exists: false,
            included: false,
          });
          continue;
        }

        try {
          const content = this.readIdentityFile(filename, filePath);
          sections.push(`[${label}]\n${content}`);
          loadedFiles.push({
            layerIndex,
            basePath: layer.basePath,
            filename,
            filePath,
            label,
            exists: true,
            included: true,
          });
        } catch {
          loadedFiles.push({
            layerIndex,
            basePath: layer.basePath,
            filename,
            filePath,
            label,
            exists: true,
            included: false,
          });
          console.warn(`[context] Failed to read identity file: ${filePath}`);
        }
      }
    });

    const identity = sections.join('\n\n---\n\n');

    const contextBlock = [
      `[CONTEXT]`,
      `Current time: ${new Date().toISOString()}`,
      `Machine: ${hostname()}`,
      `User: ${this.config.ownerName ?? 'unknown'}${this.config.ownerTelegramId ? ` (Telegram ID: ${this.config.ownerTelegramId})` : ''}`,
      `Engine: http://localhost:${this.config.enginePort}`,
    ].join('\n');

    this.systemPrompt = `${buildSystemPrompt(provider)}\n\n---\n\n${identity}\n\n---\n\n${contextBlock}`;
    this.lastProvider = provider;
    this.promptSourceInfo = {
      generatedAt: new Date().toISOString(),
      totalSections: sections.length,
      loadedFiles,
    };
    this.dirty = false;

    console.log(`[context] System prompt built: ${this.systemPrompt.length} chars`);
  }

  private refreshHeartbeatIfNeeded(): void {
    const now = Date.now();
    if (now - this.heartbeatLastLoad < this.config.heartbeatRefreshMs) return;

    const heartbeatPath = this.findHeartbeatPath();
    if (!heartbeatPath || !existsSync(heartbeatPath)) return;

    // Heartbeat changed — force full rebuild to get fresh timestamp too
    this.dirty = true;
  }

  private getIdentityLayers(): IdentityLayerConfig[] {
    if (this.config.identityLayers && this.config.identityLayers.length > 0) {
      return this.config.identityLayers;
    }
    return [{ basePath: this.config.workspacePath, files: this.config.identityFiles }];
  }

  private readIdentityFile(filename: string, filePath: string): string {
    let content = readFileSync(filePath, 'utf-8').trim();

    if (filename === 'HEARTBEAT.md') {
      content = content.slice(0, 1500);
      this.heartbeatLastLoad = Date.now();
    } else if (filename === 'MISSION.md') {
      content = content.slice(0, 2500);
    } else if (filename === 'MEMORY.md') {
      content = content.slice(0, 3000);
    } else if (filename === 'LEARNINGS.md') {
      const lines = content.split('\n');
      content = lines.slice(-60).join('\n').slice(0, 2000);
    } else if (filename === 'SOUL.md') {
      content = content.slice(0, 3000);
    } else if (filename === 'NOW.md') {
      content = content.slice(0, 2200);
    } else if (filename === 'OPEN_PROJECTS.md') {
      content = content.slice(0, 2600);
    } else if (filename === 'RECENT_DECISIONS.md') {
      const lines = content.split('\n');
      content = lines.slice(0, 80).join('\n').slice(0, 2200);
    } else if (filename === 'AGENT_BRIEFING.md') {
      content = content.slice(0, 1800);
    } else if (filename === 'ARTIFACT_RECEIPTS.md') {
      const lines = content.split('\n');
      content = lines.slice(0, 100).join('\n').slice(0, 2200);
    } else if (filename === 'ALIASES.json') {
      content = content.slice(0, 1800);
    }

    return content;
  }

  private findHeartbeatPath(): string | null {
    for (const layer of this.getIdentityLayers()) {
      if (!layer.files.includes('HEARTBEAT.md')) continue;
      const heartbeatPath = resolve(layer.basePath, 'HEARTBEAT.md');
      if (existsSync(heartbeatPath)) return heartbeatPath;
    }
    return null;
  }
}
