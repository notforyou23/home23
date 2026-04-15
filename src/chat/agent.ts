/**
 * COSMO Home 2.3 — Chat Agent
 *
 * Direct LLM conversation with identity context injection.
 * This is the FAST path — calls Claude/GPT directly with SOUL/MISSION/HEARTBEAT
 * context. The brain's /api/query is the DEEP path for explicit research queries.
 *
 * Modeled on OpenClaw's 3-layer context injection:
 *   1. Identity (SOUL, MISSION — loaded once, cached)
 *   2. Brain memory (lightweight search, 2s timeout, graceful skip)
 *   3. Conversation history (per-thread, bounded)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { IdentityLayerConfig } from '../types.js';

// ─── Types ───────────────────────────────────────────────────

export interface ChatConfig {
  provider: string;
  model: string;
  maxTokens: number;
  temperature: number;
  historyDepth: number;
  memorySearch: {
    enabled: boolean;
    timeoutMs: number;
    topK: number;
  };
  identityFiles: string[];
  identityLayers?: IdentityLayerConfig[];
  heartbeatRefreshMs: number;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  answer: string;
  model: string;
  provider: string;
  durationMs: number;
  memoryNodesUsed: number;
}

// ─── Chat Agent ──────────────────────────────────────────────

export class ChatAgent {
  private config: ChatConfig;
  private projectRoot: string;
  private workspacePath: string;
  private enginePort: number;

  // Cached identity context
  private systemPrompt: string = '';
  private identityLoaded = false;
  private heartbeatCache: string = '';
  private heartbeatLastLoad = 0;

  // Conversation history per thread
  private threads: Map<string, ChatMessage[]> = new Map();

  constructor(config: ChatConfig, projectRoot: string, enginePort: number = 4601) {
    this.config = config;
    this.projectRoot = projectRoot;
    this.workspacePath = join(projectRoot, 'workspace');
    this.enginePort = enginePort;

    this.loadSecrets();
    this.loadIdentity();
  }

  // ── Public API ─────────────────────────────────────────────

  async chat(chatId: string, text: string, senderName: string): Promise<ChatResult> {
    const startMs = Date.now();

    // Refresh heartbeat if stale
    this.refreshHeartbeatIfNeeded();

    // Get or create conversation thread
    const history = this.getThread(chatId);

    // Add user message
    history.push({ role: 'user', content: text });

    // Optional: search brain memory for relevant context
    let memoryContext = '';
    let memoryNodesUsed = 0;
    if (this.config.memorySearch.enabled) {
      const memResult = await this.searchBrainMemory(text);
      memoryContext = memResult.context;
      memoryNodesUsed = memResult.count;
    }

    // Assemble system prompt with memory
    const fullSystem = memoryContext
      ? `${this.systemPrompt}\n\n[BRAIN MEMORY — relevant to this conversation]\n${memoryContext}`
      : this.systemPrompt;

    // Call LLM
    const answer = await this.callLLM(fullSystem, history);

    // Add assistant response to history
    history.push({ role: 'assistant', content: answer });

    // Trim history to depth limit
    while (history.length > this.config.historyDepth * 2) {
      history.shift();
    }

    const durationMs = Date.now() - startMs;
    console.log(`[chat] ${senderName} → ${answer.length} chars in ${durationMs}ms (${memoryNodesUsed} memory nodes)`);

    return {
      answer,
      model: this.config.model,
      provider: this.config.provider,
      durationMs,
      memoryNodesUsed,
    };
  }

  // ── Identity Loading ───────────────────────────────────────

  private loadIdentity(): void {
    const sections: string[] = [];
    let loadedCount = 0;

    for (const layer of this.getIdentityLayers()) {
      for (const filename of layer.files) {
        const filePath = resolve(layer.basePath, filename);
        if (!existsSync(filePath)) continue;

        try {
          const content = this.readIdentityFile(filename, filePath);
          sections.push(`[${filename.replace('.md', '').toUpperCase()}]\n${content}`);
          loadedCount += 1;
        } catch {
          console.warn(`[chat] Failed to read identity file: ${filePath}`);
        }
      }
    }

    this.systemPrompt = sections.join('\n\n---\n\n');
    this.identityLoaded = true;
    console.log(`[chat] Identity loaded: ${loadedCount} files, ${this.systemPrompt.length} chars`);
  }

  private refreshHeartbeatIfNeeded(): void {
    const now = Date.now();
    if (now - this.heartbeatLastLoad < this.config.heartbeatRefreshMs) return;

    const heartbeatPath = this.findHeartbeatPath();
    if (!heartbeatPath || !existsSync(heartbeatPath)) return;

    try {
      this.heartbeatCache = readFileSync(heartbeatPath, 'utf-8').trim().slice(0, 1500);
      this.heartbeatLastLoad = now;

      // Replace the HEARTBEAT section in the system prompt
      const heartbeatSection = `[HEARTBEAT]\n${this.heartbeatCache}`;
      this.systemPrompt = this.systemPrompt.replace(
        /\[HEARTBEAT\]\n[\s\S]*?(?=\n\n---|$)/,
        heartbeatSection,
      );
    } catch {
      // Non-fatal
    }
  }

  private getIdentityLayers(): IdentityLayerConfig[] {
    if (this.config.identityLayers && this.config.identityLayers.length > 0) {
      return this.config.identityLayers;
    }
    return [{ basePath: this.workspacePath, files: this.config.identityFiles }];
  }

  private readIdentityFile(filename: string, filePath: string): string {
    let content = readFileSync(filePath, 'utf-8').trim();

    if (filename === 'HEARTBEAT.md') {
      content = content.slice(0, 1500);
      this.heartbeatCache = content;
      this.heartbeatLastLoad = Date.now();
    } else if (filename === 'MISSION.md') {
      content = content.slice(0, 2500);
    } else if (filename === 'MEMORY.md') {
      content = content.slice(0, 3000);
    } else if (filename === 'LEARNINGS.md') {
      const lines = content.split('\n');
      const lastChunk = lines.slice(-60).join('\n');
      content = lastChunk.slice(0, 2000);
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
    } else if (filename === 'SKILL_ROUTING.md') {
      content = content.slice(0, 2200);
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

  // ── Secrets ────────────────────────────────────────────────
  // No longer needed — LLM calls go through the engine's /api/chat/simple
  // which has its own SDK instances with proper auth (including OAuth tokens)
  private loadSecrets(): void {
    // No-op — engine handles auth
  }

  // ── Conversation History ───────────────────────────────────

  private getThread(chatId: string): ChatMessage[] {
    let thread = this.threads.get(chatId);
    if (!thread) {
      thread = [];
      this.threads.set(chatId, thread);
    }
    return thread;
  }

  // ── Brain Memory Search (lightweight) ──────────────────────

  private async searchBrainMemory(query: string): Promise<{ context: string; count: number }> {
    try {
      const url = `http://localhost:${this.enginePort}/api/memory?search=${encodeURIComponent(query)}&limit=${this.config.memorySearch.topK}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(this.config.memorySearch.timeoutMs),
      });

      if (!res.ok) return { context: '', count: 0 };

      const data = await res.json() as { nodes?: Array<{ concept?: string; tag?: string; id?: string | number }> };
      const nodes = data.nodes ?? [];
      if (nodes.length === 0) return { context: '', count: 0 };

      const context = nodes
        .slice(0, this.config.memorySearch.topK)
        .map((n, i) => `[Mem ${n.id ?? i}] ${(n.concept ?? '').slice(0, 300)}`)
        .join('\n');

      return { context, count: nodes.length };
    } catch {
      // Timeout or network error — graceful degradation
      return { context: '', count: 0 };
    }
  }

  // ── LLM Call (via engine's /api/chat/simple) ────────────────
  //
  // Routes through the engine dashboard which has properly initialized
  // SDK instances for all providers — including OAuth tokens for Anthropic.
  // This means we get full provider support without reimplementing auth.

  private async callLLM(systemPrompt: string, messages: ChatMessage[]): Promise<string> {
    const url = `http://localhost:${this.enginePort}/api/chat/simple`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        provider: this.config.provider,
        model: this.config.model,
        maxTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Engine chat error: ${res.status} — ${errText.slice(0, 300)}`);
    }

    const data = await res.json() as {
      answer: string;
      model: string;
      provider: string;
      usage: Record<string, number>;
    };

    const usageStr = Object.entries(data.usage || {})
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    if (usageStr) {
      console.log(`[chat] ${data.provider}/${data.model}: ${usageStr}`);
    }

    return data.answer;
  }
}
