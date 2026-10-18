/**
 * COSMO Home 2.3 — Context Manager
 *
 * Loads identity files (SOUL, MISSION, HEARTBEAT, MEMORY, LEARNINGS),
 * assembles the system prompt, and handles cache invalidation.
 */

import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { createRequire } from 'node:module';
import type { HomeWorldContext } from '../../shared/home-world-context.cjs';
const { readHomeWorldContext, formatHomeWorldContext } = createRequire(import.meta.url)('../../shared/home-world-context.cjs') as {
  readHomeWorldContext: (options: { home23Root?: string; timezone?: string; now?: Date }) => HomeWorldContext;
  formatHomeWorldContext: (context: HomeWorldContext) => string;
};
import type { ContextManagerRef, PromptSourceInfo } from './types.js';
import type { IdentityLayerConfig } from '../types.js';
import { buildSystemPrompt } from '../agents/system-prompt.js';
import { composeLivedIdentity } from '../substrate/lived-identity.js';
import {
  budgetIdentityContent, loadAuthoredIdentity,
  classifyIdentityLayer,
  resolveBudget,
  IDENTITY_LAYER_ORDER,
  IDENTITY_LAYER_LABEL,
  type IdentityLayer,
  type BudgetedContent,
} from './identity-budget.js';

export interface ContextConfig {
  workspacePath: string;
  projectRoot?: string;
  identityFiles: string[];
  identityLayers?: IdentityLayerConfig[];
  /** Exact workspace sources refreshed by session bootstrap on every turn. */
  dynamicContextFiles?: string[];
  heartbeatRefreshMs: number;
  enginePort: number;
  ownerName?: string;
  ownerTelegramId?: string;
  /** Agent's IANA timezone (config `agent.timezone`) — renders the prompt
   * timestamp agent-local so the model never reads UTC as the local clock. */
  timezone?: string;
  /** Authored identity maintenance targets; they do not truncate the individual. */
  identityBudgets?: Record<string, number>;
}

/**
 * Render a prompt timestamp that cannot be misread as the wrong clock:
 * agent-local first with an explicit zone label, UTC clearly marked after.
 * A bare toISOString() here was read as local time on 2026-08-11 — 23:43Z
 * became "late night" in a greeting at 7:41 PM EDT. Invalid/missing
 * timezone degrades to the labeled UTC form rather than an unlabeled one.
 */
export function formatContextTimestamp(date: Date, timezone?: string): string {
  const iso = date.toISOString();
  if (!timezone) return `${iso} (UTC — no agent timezone configured)`;
  try {
    const local = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(date);
    return `${local} (${timezone}) — UTC ${iso}`;
  } catch {
    return `${iso} (UTC — configured timezone "${timezone}" is invalid)`;
  }
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
    const p = provider ?? (this.lastProvider || 'anthropic');
    if (this.dirty || p !== this.lastProvider) {
      this.rebuild(p);
    }
    return this.systemPrompt;
  }

  getWorldContext(now = new Date()): string {
    return formatHomeWorldContext(readHomeWorldContext({ home23Root: this.config.projectRoot ?? process.env.HOME23_ROOT, timezone: this.config.timezone, now }));
  }

  invalidate(): void {
    this.dirty = true;
  }

  getPromptSourceInfo(): PromptSourceInfo {
    this.refreshHeartbeatIfNeeded();
    if (this.dirty) {
      this.rebuild(this.lastProvider || 'anthropic');
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
    const deferred: string[] = [];
    const sourcePath = (file: string): string => {
      try { return realpathSync(file); } catch { return file; }
    };
    const dynamicSources = new Set((this.config.dynamicContextFiles ?? [])
      .map(file => sourcePath(resolve(this.config.workspacePath, file))));
    const seenSources = new Set<string>();
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
          const rawSource = readFileSync(filePath, 'utf-8');
          const raw = rawSource.trim();
          const sourceSHA256 = createHash('sha256').update(rawSource).digest('hex');
          const canonicalPath = sourcePath(filePath);
          const source = { layerIndex, basePath: layer.basePath, filename, filePath, label,
            exists: true, layer: idLayer, rawBytes: raw.length, sourceSHA256 };
          if (dynamicSources.has(canonicalPath)) {
            loadedFiles.push({ ...source, included: false, includedBytes: 0, deferredReason: 'session_bootstrap' });
            if (!seenSources.has(canonicalPath)) deferred.push(`${filePath}: refreshed in fresh session bootstrap on each turn; no cached identity copy.`);
            seenSources.add(canonicalPath);
            continue;
          }
          if (seenSources.has(canonicalPath)) {
            loadedFiles.push({ ...source, included: false, includedBytes: 0, deferredReason: 'duplicate_source' });
            continue;
          }
          seenSources.add(canonicalPath);
          const recordedAt = /(?:^|\n)Generated\s*:?\s+(\d{4}-\d{2}-\d{2}T\S+)/i.exec(raw)?.[1];
          if (/(?:^|_)STATUS\.md$/i.test(filename) && recordedAt && Number.isFinite(Date.parse(recordedAt))
            && Date.now() - Date.parse(recordedAt) > 86_400_000) {
            loadedFiles.push({ ...source, included: false, includedBytes: 0,
              deferredReason: 'historical_status', sourceRecordedAt: recordedAt });
            const ownerDirections = raw.split('\n').filter(line => /\bDROPPED by\b|\bowner closed\b/i.test(line));
            deferred.push([
              `Historical status: ${filePath}; generated ${recordedAt}; SHA256 ${sourceSHA256}.`,
              'Its old pending requests are not current assignments. Read the complete source with read_file when relevant and verify present project evidence before reviving them.',
              ...ownerDirections.map(line => `Recorded owner direction (preserved): ${line}`),
            ].join('\n'));
            continue;
          }
          if (filename === 'HEARTBEAT.md') this.heartbeatLastLoad = Date.now();
          const { budget, strategy } = resolveBudget(filename, this.config.identityBudgets);
          const budgeted = loadAuthoredIdentity(filename, raw, budget);
          loaded.push({ filename, label, layer: idLayer, budgeted });
          if (budgeted.truncated) anyTruncated = true;
          loadedFiles.push({ layerIndex, basePath: layer.basePath, filename, filePath, label,
            exists: true, included: true, layer: idLayer,
            sourceSHA256,
            rawBytes: budgeted.rawBytes, includedBytes: budgeted.includedBytes,
            budget: budgeted.budget, maintenanceNeeded: raw.length > budget, truncated: budgeted.truncated,
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

    const identity = [...layerBlocks, ...(deferred.length ? ['[CONTEXT SOURCE ROUTING]\n' + deferred.join('\n\n') + '\n[/CONTEXT SOURCE ROUTING]'] : [])].join('\n\n---\n\n');

    // Keep rebuild timestamps in diagnostics, outside the reusable prompt.
    // Refreshing unchanged files must not invalidate the prefix cache.
    const contextBlock = [
      `[CONTEXT]`,
      `Timezone: ${this.config.timezone ? `(${this.config.timezone})` : "not configured; use explicitly labeled UTC"}. For the current time use session context (NOW) or the machine clock.`,
      `Machine: ${hostname()}`,
      `User: ${this.config.ownerName ?? 'unknown'}${this.config.ownerTelegramId ? ` (Telegram ID: ${this.config.ownerTelegramId})` : ''}`,
      `Engine: http://localhost:${this.config.enginePort}`,
      ...(this.config.projectRoot ? [`Project root: ${this.config.projectRoot}`] : []),
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

    // Re-read heartbeat content after the refresh interval.
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
