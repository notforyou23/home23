/**
 * COSMO Home 2.3 — Context Manager
 *
 * Loads identity files (SOUL, MISSION, HEARTBEAT, MEMORY, LEARNINGS),
 * assembles the system prompt, and handles cache invalidation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import type { ContextManagerRef, PromptSourceInfo } from './types.js';
import type { IdentityLayerConfig } from '../types.js';
import { buildSystemPrompt } from '../agents/system-prompt.js';
import { composeLivedIdentity } from '../substrate/lived-identity.js';
import {
  budgetIdentityContent,
  classifyIdentityLayer,
  resolveBudget,
  IDENTITY_LAYER_ORDER,
  IDENTITY_LAYER_LABEL,
  type IdentityLayer,
  type BudgetedContent,
} from './identity-budget.js';

export interface ContextConfig {
  workspacePath: string;
  identityFiles: string[];
  identityLayers?: IdentityLayerConfig[];
  heartbeatRefreshMs: number;
  enginePort: number;
  ownerName?: string;
  ownerTelegramId?: string;
  /** Per-file identity char budgets (Step 30); overrides DEFAULT_IDENTITY_BUDGETS. */
  identityBudgets?: Record<string, number>;
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
    const loadedFiles: PromptSourceInfo['loadedFiles'] = [];
    // Collect each present identity file with its budgeted content + layer, so
    // the identity region can be emitted grouped by the six-layer scheme
    // instead of raw config order (Step 30).
    interface Loaded { filename: string; label: string; layer: IdentityLayer; budgeted: BudgetedContent; }
    const loaded: Loaded[] = [];
    let anyTruncated = false;

    this.getIdentityLayers().forEach((layer, layerIndex) => {
      for (const filename of layer.files) {
        const filePath = resolve(layer.basePath, filename);
        const label = filename.replace('.md', '').toUpperCase();
        const idLayer = classifyIdentityLayer(filename);

        if (!existsSync(filePath)) {
          loadedFiles.push({ layerIndex, basePath: layer.basePath, filename, filePath, label,
            exists: false, included: false, layer: idLayer });
          continue;
        }
        try {
          const raw = readFileSync(filePath, 'utf-8').trim();
          if (filename === 'HEARTBEAT.md') this.heartbeatLastLoad = Date.now();
          const { budget, strategy } = resolveBudget(filename, this.config.identityBudgets);
          const budgeted = budgetIdentityContent(filename, raw, budget, strategy);
          loaded.push({ filename, label, layer: idLayer, budgeted });
          if (budgeted.truncated) anyTruncated = true;
          loadedFiles.push({ layerIndex, basePath: layer.basePath, filename, filePath, label,
            exists: true, included: true, layer: idLayer,
            rawBytes: budgeted.rawBytes, includedBytes: budgeted.includedBytes,
            budget: budgeted.budget, truncated: budgeted.truncated,
            omittedSections: budgeted.omittedSections });
        } catch {
          loadedFiles.push({ layerIndex, basePath: layer.basePath, filename, filePath, label,
            exists: true, included: false, layer: idLayer });
          console.warn(`[context] Failed to read identity file: ${filePath}`);
        }
      }
    });

    // Emit identity grouped and ordered by the six-layer scheme. Within a layer,
    // config order is preserved. Each layer gets a clear header so the prompt
    // composition is legible and inspectable.
    const layerBlocks: string[] = [];
    let totalSections = 0;
    for (const idLayer of IDENTITY_LAYER_ORDER) {
      const inLayer = loaded.filter(l => l.layer === idLayer);
      if (inLayer.length === 0) continue;
      const files = inLayer.map(l => `[${l.label}]\n${l.budgeted.text}`).join('\n\n');
      layerBlocks.push(`[${IDENTITY_LAYER_LABEL[idLayer]}]\n\n${files}`);
      totalSections += inLayer.length;
    }

    // Home23 v2 cut 7: identity = constitution + biography. SOUL (authored,
    // jtr's voice) stays the enduring-self layer; the LIVED half — who the
    // individual has become, composed from his chain — joins right behind
    // it. Seed dir derived from the workspace sibling; degraded-honest:
    // no seed → constitution-only, exactly as before.
    try {
      const seedDir = resolve(this.config.workspacePath, '..', 'substrate', 'seed-01');
      const biography = composeLivedIdentity(seedDir);
      if (biography) {
        layerBlocks.splice(Math.min(1, layerBlocks.length), 0, `[WHO I HAVE BECOME — biography, composed from my chain]\n\n${biography}`);
        totalSections += 1;
      }
    } catch { /* identity never blocks on the biography */ }

    const identity = layerBlocks.join('\n\n---\n\n');

    const contextBlock = [
      `[CONTEXT]`,
      `Current time: ${new Date().toISOString()}`,
      `Machine: ${hostname()}`,
      `User: ${this.config.ownerName ?? 'unknown'}${this.config.ownerTelegramId ? ` (Telegram ID: ${this.config.ownerTelegramId})` : ''}`,
      `Engine: http://localhost:${this.config.enginePort}`,
      `Project root: ${this.config.workspacePath.replace(/\/workspace$/, '')}`,
      `Workspace: ${this.config.workspacePath}`,
    ].join('\n');

    this.systemPrompt = `${buildSystemPrompt(provider)}\n\n---\n\n${identity}\n\n---\n\n${contextBlock}`;
    this.lastProvider = provider;
    this.promptSourceInfo = {
      generatedAt: new Date().toISOString(),
      totalSections,
      loadedFiles,
      systemPromptBytes: this.systemPrompt.length,
      anyTruncated,
    };
    this.dirty = false;

    console.log(`[context] System prompt built: ${this.systemPrompt.length} chars`
      + (anyTruncated ? ` (some identity files truncated to budget — see /prompt or /api/prompt-composition)` : ''));
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

  private findHeartbeatPath(): string | null {
    for (const layer of this.getIdentityLayers()) {
      if (!layer.files.includes('HEARTBEAT.md')) continue;
      const heartbeatPath = resolve(layer.basePath, 'HEARTBEAT.md');
      if (existsSync(heartbeatPath)) return heartbeatPath;
    }
    return null;
  }
}
