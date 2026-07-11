/**
 * COSMO Home 2.3 — Agent Loop
 *
 * The core agentic tool-use loop. Every message enters here.
 * The LLM sees tools, decides what to use, executes them,
 * and loops until it produces a final text response.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolRegistry } from './tools/index.js';
import type { ContextManager } from './context.js';
import { ConversationHistory, type StoredMessage, type ContentBlock, type HistoryRecord, type SessionBoundary } from './history.js';
import type {
  AgentResponse,
  ToolContext,
  TurnRuntimeContext,
} from './types.js';
import type { OperationActivity } from './brain-operations/types.js';
import type { BrainOperationsClient } from './brain-operations/client.js';
import { ActivityLease, MAX_TIMER_DELAY_MS, type LeaseExpiryReason } from './activity-lease.js';
import { executeAndFormatTool } from './tool-result.js';
import { MemoryManager } from './memory.js';
import type { CompactionManager } from './compaction.js';
import type { MediaAttachment } from '../types.js';
import { getCodexCredentials, getCodexHeaders } from './codex-auth.js';
import { assembleContext } from './context-assembly.js';
import { EventLedger } from './event-ledger.js';
import { TriggerIndex } from './trigger-index.js';
import { MemoryObjectStore } from './memory-objects.js';
import { TurnStore } from '../chat/turn-store.js';
import { turnBus } from '../chat/turn-bus.js';
import { newTurnId, type TurnEvent } from '../chat/turn-types.js';

const MAX_ITERATIONS = 500;
const TYPING_INTERVAL_MS = 4000;
const MODEL_TOOL_RESULT_LIMIT_CHARS = 4000;
const TOOL_EVENT_RESULT_LIMIT_CHARS = 4000;
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TURN_HARD_DURATION_MS = 8 * 60 * 60 * 1000;
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 30 * 1000;

function combineRequestSignals(turnSignal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const abortSignalAny = (AbortSignal as unknown as {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (abortSignalAny) return abortSignalAny([turnSignal, timeoutSignal]);

  const controller = new AbortController();
  const sources = [turnSignal, timeoutSignal];
  const listeners = new Map<AbortSignal, () => void>();
  const cleanup = (): void => {
    for (const [source, listener] of listeners) {
      source.removeEventListener('abort', listener);
    }
    listeners.clear();
  };
  for (const source of sources) {
    const listener = (): void => controller.abort(source.reason);
    listeners.set(source, listener);
    if (source.aborted) {
      listener();
      break;
    }
    source.addEventListener('abort', listener, { once: true });
  }
  if (controller.signal.aborted) cleanup();
  else controller.signal.addEventListener('abort', cleanup, { once: true });
  return controller.signal;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

function stringifyContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content.map(block => JSON.stringify(block)).join('\n');
}

export interface CacheDiagnosticsConfig {
  enabled: boolean;
  runtimeDir: string;
  logger: (event: Record<string, unknown>) => void;
}

// ─── OAuth Stealth Headers ──────────────────────────────────
// Required to use OAuth tokens (sk-ant-oat*) with the Anthropic SDK.
// Impersonates Claude Code CLI — this is the same mechanism cosmo_2.3 uses.
function getStealthHeaders(): Record<string, string> {
  return {
    'accept': 'application/json',
    'anthropic-dangerous-direct-browser-access': 'true',
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11',
    'user-agent': 'claude-cli/2.1.32 (external, cli)',
    'x-app': 'cli',
  };
}

function getClaudeCodeSystemPrompt(): { type: 'text'; text: string; cache_control: { type: 'ephemeral' } } {
  return {
    type: 'text',
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
    cache_control: { type: 'ephemeral' },
  };
}

function inferProviderFromModel(model: string, provider?: string): string {
  return provider ?? (
    model.includes('claude') ? 'anthropic' :
    model.includes('grok') ? 'xai' :
    model.includes('MiniMax') ? 'minimax' :
    model.startsWith('gpt') ? 'openai' :
    'unknown'
  );
}

function createAnthropicRuntimeClient(apiKey: string, baseURL?: string): { client: Anthropic; isOAuth: boolean } {
  const isOAuth = apiKey.startsWith('sk-ant-oat');
  const client = isOAuth
    ? new Anthropic({
        authToken: apiKey,
        ...(baseURL ? { baseURL } : {}),
        defaultHeaders: getStealthHeaders(),
        dangerouslyAllowBrowser: true,
      })
    : new Anthropic({
        apiKey,
        ...(baseURL ? { baseURL } : {}),
      });
  return { client, isOAuth };
}

type RuntimeModelContext = {
  model: string;
  provider: string;
  client: Anthropic;
  isOAuth: boolean;
  memory: MemoryManager;
};

type TerminalTurnOverride = {
  status: 'stopped' | 'timeout';
  stop_reason: string;
  error_code?: string;
  error_message?: string;
};

// Cache model capabilities from Ollama Cloud /api/show
const ollamaCapabilitiesCache = new Map<string, Set<string>>();

// ─── SSE Parser ─────────────────────────────────────────────
// Used by the openai-codex provider path.
// Yields parsed JSON objects from a Server-Sent Events stream.
// Filter on event.type from the JSON body — not on event._event,
// which is added from the SSE "event:" header line and may be absent.
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode(); // flush remaining bytes
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!frame.trim()) continue;

        let eventType = '';
        const dataLines: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }

        const payload = dataLines.join('\n').trim();
        if (!payload || payload === '[DONE]') continue;

        try {
          const parsed = JSON.parse(payload) as Record<string, unknown>;
          if (eventType) parsed._event = eventType;
          yield parsed;
        } catch { /* skip malformed frame */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

type OpenAIFunctionTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
};

type XaiResponseTool =
  | { type: 'function'; name: string; description: string | null; parameters: unknown }
  | { type: 'web_search' }
  | { type: 'x_search' }
  | { type: 'code_interpreter' };

const XAI_SERVER_TOOLS: XaiResponseTool[] = [
  { type: 'web_search' },
  { type: 'x_search' },
  { type: 'code_interpreter' },
];

function buildXaiResponseTools(registry: ToolRegistry): XaiResponseTool[] {
  const localTools = (registry.getOpenAITools() as OpenAIFunctionTool[])
    // Avoid a name collision with xAI's native web_search tool.
    .filter((tool) => tool.function.name !== 'web_search')
    .map((tool) => ({
      type: 'function' as const,
      name: tool.function.name,
      description: tool.function.description ?? null,
      parameters: tool.function.parameters ?? null,
    }));

  return [...XAI_SERVER_TOOLS, ...localTools];
}

function getXaiServerToolName(itemType: string | undefined): string | null {
  if (itemType === 'web_search_call') return 'web_search';
  if (itemType === 'x_search_call') return 'x_search';
  if (itemType === 'code_interpreter_call') return 'code_execution';
  return null;
}

function getXaiServerToolArgs(item: Record<string, unknown>): unknown {
  if (typeof item.arguments === 'string' && item.arguments.trim()) {
    try {
      return JSON.parse(item.arguments);
    } catch {
      return item.arguments;
    }
  }
  if (typeof item.input === 'string' && item.input.trim()) {
    try {
      return JSON.parse(item.input);
    } catch {
      return item.input;
    }
  }
  if (typeof item.query === 'string' && item.query.trim()) {
    return { query: item.query };
  }
  return {};
}

function summarizeXaiServerToolResult(toolName: string, item: Record<string, unknown>): string {
  const query = typeof item.query === 'string' ? item.query.trim() : '';
  const args = typeof item.arguments === 'string' ? item.arguments.trim() : '';
  const input = typeof item.input === 'string' ? item.input.trim() : '';
  const details = query || args || input || (typeof item.id === 'string' ? `id=${item.id}` : 'handled by xAI server');
  const outcome = xaiServerToolSucceeded(item) ? 'completed' : 'failed';
  return `${toolName} ${outcome} via xAI server: ${details}`.slice(0, 300);
}

function xaiServerToolSucceeded(item: Record<string, unknown>): boolean {
  const status = typeof item.status === 'string' ? item.status.trim().toLowerCase() : '';
  return item.error == null
    && !['failed', 'error', 'cancelled', 'incomplete'].includes(status);
}

function getXaiServerToolNameFromItem(item: Record<string, unknown> | undefined): string | null {
  const directType = getXaiServerToolName(item?.type as string | undefined);
  if (directType) return directType;

  const name = typeof item?.name === 'string' ? item.name : '';
  if (name === 'code_execution') return 'code_execution';
  if (name === 'web_search' || name === 'web_search_with_snippets' || name === 'browse_page') return 'web_search';
  if (name.startsWith('x_')) return 'x_search';

  return null;
}

function isAnthropicSamplingDeprecatedModel(model: string): boolean {
  return /^(?:[^/]+\/)?claude-opus-4-8(?:$|[-@])/.test(String(model || '').trim());
}

export class AgentLoop {
  private client: Anthropic;
  private model: string;
  private provider: string;
  private maxTokens: number;
  private temperature: number;
  private registry: ToolRegistry;
  private contextManager: ContextManager;
  private history: ConversationHistory;
  private toolContext: ToolContext;
  private isOAuth: boolean;
  private memory: MemoryManager;
  private compaction: CompactionManager | null;
  private cacheDiagnostics?: CacheDiagnosticsConfig;
  private activeRuns = new Map<string, Map<string, AbortController>>();
  private activeTurnIds = new Map<string, Set<string>>();
  private terminalTurnOverrides = new Map<string, TerminalTurnOverride>();
  private sessionGapMs: number;
  private workspacePath: string;
  private eventLedger: EventLedger;
  private triggerIndex: TriggerIndex;
  private memoryStore: MemoryObjectStore;
  private turnStore: TurnStore;
  private turnTiming = {
    now: Date.now,
    setTimeout: (fn: () => void, ms: number): unknown => setTimeout(fn, ms),
    clearTimeout: (id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>),
  };
  private pusher: import('../push/apns-pusher.js').ApnsPusher | null = null;
  private codexCredentialsProvider: typeof getCodexCredentials = getCodexCredentials;
  private situationalAwareness?: import('./session-bootstrap.js').SituationalAwarenessConfig;

  constructor(opts: {
    apiKey: string;
    baseURL?: string;
    model: string;
    provider?: string;
    maxTokens?: number;
    temperature?: number;
    registry: ToolRegistry;
    contextManager: ContextManager;
    history: ConversationHistory;
    toolContext: ToolContext;
    workspacePath: string;
    compaction?: CompactionManager;
    cacheDiagnostics?: CacheDiagnosticsConfig;
    sessionGapMs?: number;
    situationalAwareness?: import('./session-bootstrap.js').SituationalAwarenessConfig;
  }) {
    // OAuth tokens (sk-ant-oat*) need stealth headers + authToken param
    const runtimeClient = createAnthropicRuntimeClient(opts.apiKey, opts.baseURL);
    this.isOAuth = runtimeClient.isOAuth;
    this.client = runtimeClient.client;
    this.model = opts.model;
    this.provider = inferProviderFromModel(opts.model, opts.provider);
    this.maxTokens = opts.maxTokens ?? 16384;
    this.temperature = opts.temperature ?? 0.7;
    this.registry = opts.registry;
    this.contextManager = opts.contextManager;
    this.history = opts.history;
    this.turnStore = new TurnStore(this.history);
    this.toolContext = opts.toolContext;
    this.memory = new MemoryManager({
      client: this.client,
      model: this.model,
      provider: this.provider,
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      workspacePath: opts.workspacePath,
    });
    this.compaction = opts.compaction ?? null;
    this.cacheDiagnostics = opts.cacheDiagnostics;
    this.sessionGapMs = opts.sessionGapMs ?? 30 * 60 * 1000;
    this.workspacePath = opts.workspacePath;
    this.situationalAwareness = opts.situationalAwareness;
    this.eventLedger = new EventLedger(join(this.workspacePath, '..', 'brain'));
    const brainDir = join(this.workspacePath, '..', 'brain');
    this.memoryStore = new MemoryObjectStore(brainDir);
    this.triggerIndex = new TriggerIndex();
    this.triggerIndex.loadFrom(this.memoryStore);
  }

  /**
   * Write (or overwrite) workspace/sessions/session-live-<chatId>.md with the
   * complete current conversation after every turn. This is both the recovery
   * surface and the feeder's durable ingestion source: the final turn reaches
   * the brain without waiting for a later message to create a session boundary.
   */
  private async updateActiveSnapshot(chatId: string): Promise<void> {
    const records = this.history.load(chatId);
    const messages = records.filter((r): r is StoredMessage => !('type' in r && r.type === 'session_boundary'));
    if (messages.length < 2) return;

    const lines: string[] = [];
    for (const msg of messages) {
      const role = msg.role === 'user' ? 'User' : 'Agent';
      const content = typeof msg.content === 'string'
        ? msg.content
        : (msg.content as Array<{ type: string; text?: string }>)
            .filter(b => b.type === 'text')
            .map(b => b.text || '')
            .join('');
      if (content.trim()) lines.push(`**${role}:** ${content.trim()}`);
    }
    if (lines.length < 2) return;

    const sessionsDir = join(this.workspacePath, 'sessions');
    // Safe filename: replace any non-[A-Za-z0-9_-] with _
    const safeChatId = String(chatId).replace(/[^A-Za-z0-9_-]/g, '_');
    const filename = `session-live-${safeChatId}.md`;
    const body = `# Conversation Session (live)\n\n- **chatId:** ${chatId}\n- **messages:** ${messages.length}\n- **updated:** ${new Date().toISOString()}\n\n---\n\n${lines.join('\n\n')}\n`;

    try {
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(join(sessionsDir, filename), body);
    } catch (err) {
      console.warn(`[loop] Failed to write active snapshot for ${chatId}: ${err}`);
    }
  }

  private async compileSessionTranscript(chatId: string, records: HistoryRecord[]): Promise<void> {
    let lastBoundaryIdx = -1;
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i];
      if (r && 'type' in r && r.type === 'session_boundary') {
        lastBoundaryIdx = i;
        break;
      }
    }

    const sessionMessages = records
      .slice(lastBoundaryIdx + 1)
      .filter((r): r is StoredMessage => !('type' in r && r.type === 'session_boundary'));

    if (sessionMessages.length < 2) return;

    const lines: string[] = [];
    for (const msg of sessionMessages) {
      const role = msg.role === 'user' ? 'User' : 'Agent';
      const content = typeof msg.content === 'string'
        ? msg.content
        : (msg.content as Array<{ type: string; text?: string }>)
            .filter(b => b.type === 'text')
            .map(b => b.text || '')
            .join('');
      if (content.trim()) {
        lines.push(`**${role}:** ${content.trim()}`);
      }
    }

    if (lines.length < 2) return;

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeChatId = String(chatId).replace(/[^A-Za-z0-9_-]/g, '_');
    const filename = `session-${timestamp}-${safeChatId}.md`;
    const sessionsDir = join(this.workspacePath, 'sessions');

    try {
      mkdirSync(sessionsDir, { recursive: true });
      const content = `# Conversation Session\n\nDate: ${new Date().toISOString()}\nChannel: ${chatId}\nMessages: ${sessionMessages.length}\n\n---\n\n${lines.join('\n\n')}`;
      writeFileSync(join(sessionsDir, filename), content);
      console.log(`[loop] Session transcript written: ${filename} (${sessionMessages.length} messages)`);
    } catch (err) {
      console.warn(`[loop] Failed to write session transcript: ${err}`);
    }

    // Phase 7 of thinking-machine-cycle: emit conversation salience sidecar.
    // Engine-side discovery reads this to weight attention toward clusters
    // the user is actively engaging with. Token-overlap based for v1; no
    // embeddings required — keeps harness dependency footprint minimal.
    try {
      const salienceDir = join(this.workspacePath, '..', 'brain');
      mkdirSync(salienceDir, { recursive: true });
      const salienceEntry = {
        ts: new Date().toISOString(),
        chatId,
        messageCount: sessionMessages.length,
        // Compact summary for engine-side token overlap scoring: the joined
        // lines trimmed to a reasonable size. Full text lives in sessions/.
        summary: lines.join('\n\n').slice(0, 8000),
      };
      appendFileSync(
        join(salienceDir, 'conversation-salience.jsonl'),
        JSON.stringify(salienceEntry) + '\n'
      );
    } catch (err) {
      // Non-fatal — discovery salience is an optimization, not a requirement
      console.warn(`[loop] Failed to write conversation-salience: ${err}`);
    }
  }

  /** Expose client for CompactionManager wiring */
  getClient(): Anthropic { return this.client; }

  /** Expose memory for CompactionManager wiring */
  getMemory(): MemoryManager { return this.memory; }

  /** Expose history for cron sessionHistory='fresh' rotation */
  getHistory(): ConversationHistory { return this.history; }

  private providerMap: Map<string, { apiKey: string; baseURL?: string }> = new Map();

  /** Give AgentLoop the knowledge it needs to rebuild its HTTP client when switching
   *  between Anthropic-SDK providers (anthropic vs minimax vs Claude-via-OAuth).
   *  Other providers (openai/xai/ollama) are called via fetch() and read their keys
   *  from env, so no client rebuild needed. */
  setProviderMap(map: Record<string, { apiKey: string; baseURL?: string }>): void {
    this.providerMap = new Map(Object.entries(map));
  }

  private createRuntimeContext(modelOverride?: { model: string; provider?: string }): RuntimeModelContext {
    const model = modelOverride?.model ?? this.model;
    const provider = modelOverride?.model
      ? inferProviderFromModel(modelOverride.model, modelOverride.provider)
      : this.provider;

    let client = this.client;
    let isOAuth = this.isOAuth;
    const sdkProviders = new Set(['anthropic', 'minimax']);
    if (modelOverride?.model && sdkProviders.has(provider)) {
      const cfg = this.providerMap.get(provider);
      if (cfg?.apiKey) {
        const runtimeClient = createAnthropicRuntimeClient(cfg.apiKey, cfg.baseURL);
        client = runtimeClient.client;
        isOAuth = runtimeClient.isOAuth;
      } else {
        console.warn(`[agent] model override: no provider config for ${provider} — using configured client`);
      }
    }

    const cfg = this.providerMap.get(provider);
    const memory = modelOverride?.model
      ? new MemoryManager({
          client,
          model,
          provider,
          apiKey: cfg?.apiKey,
          baseURL: cfg?.baseURL,
          workspacePath: this.workspacePath,
        })
      : this.memory;

    return { model, provider, client, isOAuth, memory };
  }

  setModel(model: string, provider?: string): void {
    const newProvider = inferProviderFromModel(model, provider);

    // Rebuild the Anthropic SDK client when switching between SDK providers
    // (anthropic <-> minimax). Their baseURLs differ; the client is bound at construction.
    const sdkProviders = new Set(['anthropic', 'minimax']);
    if (newProvider !== this.provider && sdkProviders.has(newProvider)) {
      const cfg = this.providerMap.get(newProvider);
      if (cfg && cfg.apiKey) {
        const runtimeClient = createAnthropicRuntimeClient(cfg.apiKey, cfg.baseURL);
        this.isOAuth = runtimeClient.isOAuth;
        this.client = runtimeClient.client;
        console.log(`[agent] provider switched to ${newProvider} (baseURL=${cfg.baseURL ?? 'default'})`);
      } else {
        console.warn(`[agent] setModel: no provider config for ${newProvider} — keeping existing client`);
      }
    }

    this.model = model;
    this.provider = newProvider;
    const cfg = this.providerMap.get(newProvider);
    this.memory = new MemoryManager({
      client: this.client,
      model: this.model,
      provider: this.provider,
      apiKey: cfg?.apiKey,
      baseURL: cfg?.baseURL,
      workspacePath: this.workspacePath,
    });
  }

  getModel(): string {
    return this.model;
  }

  getProvider(): string {
    return this.provider;
  }

  /** Stop an active run. Returns true if a run was aborted. */
  stop(chatId?: string, turnId?: string): { stopped: boolean; chatIds: string[]; turnIds?: string[]; activeTurnId?: string } {
    if (chatId) {
      const runs = this.activeRuns.get(chatId);
      if (runs && runs.size > 0) {
        const selected = turnId ? [[turnId, runs.get(turnId)] as const] : [...runs.entries()];
        const activeTurnId = [...runs.keys()].at(-1);
        if (turnId && !runs.has(turnId)) {
          return { stopped: false, chatIds: [], activeTurnId };
        }
        const stoppedTurnIds: string[] = [];
        for (const [selectedTurnId, ac] of selected) {
          if (!ac) continue;
          if (!selectedTurnId.startsWith('raw:')) {
            this.setTerminalTurnOverrideOnce(chatId, selectedTurnId, {
              status: 'stopped',
              stop_reason: 'operator_stop',
            });
          }
          ac.abort(Object.assign(new Error('operator_stop'), { code: 'operator_stop' }));
          this.unregisterActiveRun(chatId, selectedTurnId, ac);
          stoppedTurnIds.push(selectedTurnId);
        }
        return { stopped: stoppedTurnIds.length > 0, chatIds: [chatId], turnIds: stoppedTurnIds };
      }
      return { stopped: false, chatIds: [] };
    }
    // Stop all active runs
    const ids = [...this.activeRuns.keys()];
    const turnIds: string[] = [];
    for (const [activeChatId, runs] of [...this.activeRuns.entries()]) {
      for (const [activeTurnId, ac] of [...runs.entries()]) {
        if (!activeTurnId.startsWith('raw:')) {
          this.setTerminalTurnOverrideOnce(activeChatId, activeTurnId, {
            status: 'stopped',
            stop_reason: 'operator_stop',
          });
        }
        ac.abort(Object.assign(new Error('operator_stop'), { code: 'operator_stop' }));
        this.unregisterActiveRun(activeChatId, activeTurnId, ac);
        turnIds.push(activeTurnId);
      }
    }
    return { stopped: ids.length > 0, chatIds: ids, turnIds };
  }

  private turnKey(chatId: string, turnId: string): string {
    return `${chatId}\u0000${turnId}`;
  }

  private setTerminalTurnOverrideOnce(
    chatId: string,
    turnId: string,
    override: TerminalTurnOverride,
  ): void {
    const key = this.turnKey(chatId, turnId);
    if (!this.terminalTurnOverrides.has(key)) this.terminalTurnOverrides.set(key, override);
  }

  private registerActiveRun(chatId: string, turnId: string, ac: AbortController): void {
    let runs = this.activeRuns.get(chatId);
    if (!runs) {
      runs = new Map();
      this.activeRuns.set(chatId, runs);
    }
    runs.set(turnId, ac);
    let turnIds = this.activeTurnIds.get(chatId);
    if (!turnIds) {
      turnIds = new Set();
      this.activeTurnIds.set(chatId, turnIds);
    }
    turnIds.add(turnId);
  }

  private unregisterActiveRun(chatId: string, turnId: string, ac: AbortController): void {
    const runs = this.activeRuns.get(chatId);
    if (runs?.get(turnId) !== ac) return;
    runs.delete(turnId);
    if (runs.size === 0) this.activeRuns.delete(chatId);
    const turnIds = this.activeTurnIds.get(chatId);
    turnIds?.delete(turnId);
    if (turnIds?.size === 0) this.activeTurnIds.delete(chatId);
  }

  private isExactRunActive(chatId: string, turnId: string, ac: AbortController): boolean {
    return this.activeRuns.get(chatId)?.get(turnId) === ac;
  }

  /** Check if the agent is currently running for a given chatId. */
  isRunning(chatId: string): boolean {
    return (this.activeRuns.get(chatId)?.size ?? 0) > 0;
  }

  /** List all active run chatIds. */
  getActiveRuns(): string[] {
    return [...this.activeRuns.keys()];
  }

  /** Recover stale pending turn envelopes after process restarts or abandoned runs. */
  recoverStaleTurns(maxAgeMs: number = 10 * 60 * 1000): Array<{ chatId: string; turnId: string }> {
    const recovered: Array<{ chatId: string; turnId: string }> = [];
    for (const chatId of this.history.listChatIds()) {
      const activeTurnIds = this.activeTurnIds.get(chatId);
      const turnIds = this.turnStore.sweepOrphans(chatId, maxAgeMs, { activeTurnIds });
      for (const turnId of turnIds) {
        const env = this.turnStore.finalEnvelope(chatId, turnId);
        if (env) {
          turnBus.emit(chatId, turnId, env);
          turnBus.close(chatId, turnId);
        }
        recovered.push({ chatId, turnId });
      }
    }
    return recovered;
  }

  /** Optional: install an APNs pusher to fire notifications on turn completion. */
  setPusher(pusher: import('../push/apns-pusher.js').ApnsPusher | null): void {
    this.pusher = pusher;
  }

  /**
   * Run a turn with lifecycle tracking. Writes a `pending` envelope, persists every
   * onEvent as a seq'd `event` record, and writes a final envelope on completion/error.
   * Returns the turn_id immediately — the agent run is awaited by the caller but can
   * be detached (caller fires-and-forgets the returned promise).
   */
  async runWithTurn(
    chatId: string,
    userText: string,
    opts: {
      turnId?: string;
      media?: import('../types.js').MediaAttachment[];
      onEvent?: import('./types.js').AgentEventCallback;
      modelOverride?: { model: string; provider?: string };
      inactivityMs?: number;
      hardDurationMs?: number;
      maxDurationMs?: number;
      firstTokenTimeoutMs?: number;
    } = {},
  ): Promise<{ turnId: string; response: Promise<import('./types.js').AgentResponse> }> {
    const turnId = opts.turnId ?? newTurnId();
    const startedAtMs = this.turnTiming.now();
    const inactivityMs = opts.inactivityMs ?? opts.maxDurationMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const hardDurationMs = opts.hardDurationMs ?? DEFAULT_TURN_HARD_DURATION_MS;
    const firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    if (![inactivityMs, hardDurationMs, firstTokenTimeoutMs]
      .every(value => Number.isSafeInteger(value) && value > 0 && value <= MAX_TIMER_DELAY_MS)) {
      throw new TypeError('invalid turn deadline');
    }
    const activity_deadline_at = new Date(startedAtMs + inactivityMs).toISOString();
    const hard_deadline_at = new Date(startedAtMs + hardDurationMs).toISOString();
    const deadline_at = activity_deadline_at;
    const first_token_deadline_at = new Date(startedAtMs + firstTokenTimeoutMs).toISOString();

    const runtime = this.createRuntimeContext(opts.modelOverride);
    const model = runtime.model;
    const provider = runtime.provider;

    let seq = 0;
    const persistAndFanOut = (event: import('./types.js').AgentEvent): void => {
      seq++;
      const record: TurnEvent = {
        type: 'event',
        turn_id: turnId,
        seq,
        ts: new Date().toISOString(),
        kind: event.type,
        data: { ...event } as Record<string, unknown>,
      };
      this.turnStore.writeEvent(chatId, record);
      turnBus.emit(chatId, turnId, record);
      if (opts.onEvent) {
        try { opts.onEvent(event); } catch { /* caller errors don't kill the run */ }
      }
    };

    const ac = new AbortController();
    const expireTurn = (reason: LeaseExpiryReason): void => {
      if (ac.signal.aborted) return;
      const hard = reason === 'hard_timeout';
      const timeoutMs = hard ? hardDurationMs : inactivityMs;
      const code = hard ? 'turn_hard_timeout' : 'turn_timeout';
      const label = hard ? 'hard' : 'inactivity';
      const error_message = `turn ${label} timeout after ${timeoutMs}ms`;
      console.warn(`[loop] turn ${turnId} ${label} deadline reached — aborting`);
      this.setTerminalTurnOverrideOnce(chatId, turnId, {
        status: 'timeout',
        stop_reason: code,
        error_code: code,
        error_message,
      });
      ac.abort(Object.assign(new Error(error_message), { code }));
    };
    const lease = new ActivityLease({
      inactivityMs,
      hardDurationMs,
      now: this.turnTiming.now,
      setTimeout: this.turnTiming.setTimeout,
      clearTimeout: this.turnTiming.clearTimeout,
      onExpire: expireTurn,
    });
    const onOperationActivity = (activity: OperationActivity): void => {
      if (!lease.observe(activity)) return;
      persistAndFanOut({
        type: 'status',
        status: 'brain_operation_active',
        message: `${activity.operationId} ${activity.state} ${activity.phase || ''}`.trim(),
        activity_deadline_at: new Date(lease.activityDeadlineMs!).toISOString(),
        hard_deadline_at: new Date(lease.hardDeadlineMs!).toISOString(),
      });
    };
    const baseBrainOperations = this.toolContext.brainOperations;
    const runBrainOperations = baseBrainOperations?.withActivityHandler
      ? baseBrainOperations.withActivityHandler(onOperationActivity)
      : baseBrainOperations;
    const turnRuntime: TurnRuntimeContext = Object.freeze({
      turnId,
      abortController: ac,
      signal: ac.signal,
      brainOperations: runBrainOperations as BrainOperationsClient,
      onOperationActivity,
    });
    let firstTokenWatchdog: unknown = null;
    try {
      lease.start();
      firstTokenWatchdog = this.turnTiming.setTimeout(() => {
        if (seq === 0 && this.isExactRunActive(chatId, turnId, ac)) {
          persistAndFanOut({
            type: 'status',
            status: 'awaiting_model',
            message: `waiting for first model token after ${firstTokenTimeoutMs}ms`,
          });
        }
      }, firstTokenTimeoutMs);
      this.registerActiveRun(chatId, turnId, ac);
      this.turnStore.writeStart(chatId, turnId, model, provider, {
        deadline_at,
        activity_deadline_at,
        hard_deadline_at,
        first_token_deadline_at,
      });
    } catch (err) {
      lease.close();
      if (firstTokenWatchdog !== null) {
        this.turnTiming.clearTimeout(firstTokenWatchdog);
        firstTokenWatchdog = null;
      }
      this.unregisterActiveRun(chatId, turnId, ac);
      this.terminalTurnOverrides.delete(this.turnKey(chatId, turnId));
      throw err;
    }

    const response = (async () => {
      try {
        const result = await this.run(
          chatId,
          userText,
          opts.media,
          persistAndFanOut,
          runtime,
          turnRuntime,
        );
        const terminalOverride = this.terminalTurnOverrides.get(this.turnKey(chatId, turnId));
        if (terminalOverride?.status === 'timeout') {
          if (ac.signal.reason instanceof Error) throw ac.signal.reason;
          throw Object.assign(
            new Error(terminalOverride.error_message ?? terminalOverride.stop_reason),
            { code: terminalOverride.error_code ?? terminalOverride.stop_reason },
          );
        }
        const terminalActivityDeadlineAt = new Date(
          lease.activityDeadlineMs ?? startedAtMs + inactivityMs,
        ).toISOString();
        const endEnv = this.turnStore.writeEnd(chatId, turnId, terminalOverride?.status ?? 'complete', {
          last_seq: seq,
          stop_reason: terminalOverride?.stop_reason ?? 'end_turn',
          error_code: terminalOverride?.error_code,
          error_message: terminalOverride?.error_message,
          deadline_at: terminalActivityDeadlineAt,
          activity_deadline_at: terminalActivityDeadlineAt,
          hard_deadline_at,
          first_token_deadline_at,
        });
        turnBus.emit(chatId, turnId, endEnv);
        turnBus.close(chatId, turnId);
        if (this.pusher) {
          this.pusher.notifyTurnComplete({
            chatId,
            turnId,
            assistantText: result.text ?? '',
          }).catch(err => console.warn('[push] notifyTurnComplete failed:', err));
        }
        // Write/overwrite the durable live session after every completed turn.
        // The feeder watches this non-volatile session file, so the brain sees
        // the latest conversation even if no later message creates a boundary.
        // Fire-and-forget; a write failure must not poison turn completion.
        this.updateActiveSnapshot(chatId).catch(err => {
          console.warn(`[loop] active snapshot failed for ${chatId}:`, err?.message || err);
        });
        return result;
      } catch (err) {
        const terminalOverride = this.terminalTurnOverrides.get(this.turnKey(chatId, turnId));
        const msg = err instanceof Error ? err.message : String(err);
        const isAbort = terminalOverride?.status === 'stopped' || msg.includes('aborted') || msg.includes('AbortError') || msg.includes('operator_stop');
        const isTimeout = terminalOverride?.status === 'timeout' || msg.includes('turn timeout');
        const status = terminalOverride?.status ?? (isTimeout ? 'timeout' : (isAbort ? 'stopped' : 'error'));
        const terminalActivityDeadlineAt = new Date(
          lease.activityDeadlineMs ?? startedAtMs + inactivityMs,
        ).toISOString();
        const endEnv = this.turnStore.writeEnd(chatId, turnId, status, {
          last_seq: seq,
          error: msg,
          error_code: terminalOverride?.error_code ?? (isTimeout ? 'turn_timeout' : (status === 'error' ? 'provider_error' : undefined)),
          error_message: terminalOverride?.error_message ?? (status === 'error' || status === 'timeout' ? msg : undefined),
          stop_reason: terminalOverride?.stop_reason,
          deadline_at: terminalActivityDeadlineAt,
          activity_deadline_at: terminalActivityDeadlineAt,
          hard_deadline_at,
          first_token_deadline_at,
        });
        turnBus.emit(chatId, turnId, endEnv);
        turnBus.close(chatId, turnId);
        throw err;
      } finally {
        lease.close();
        if (firstTokenWatchdog !== null) {
          this.turnTiming.clearTimeout(firstTokenWatchdog);
          firstTokenWatchdog = null;
        }
        this.unregisterActiveRun(chatId, turnId, ac);
        this.terminalTurnOverrides.delete(this.turnKey(chatId, turnId));
      }
    })();

    return { turnId, response };
  }

  async run(
    chatId: string,
    userText: string,
    userMedia?: MediaAttachment[],
    onEvent?: import('./types.js').AgentEventCallback,
    runtime: RuntimeModelContext = this.createRuntimeContext(),
    turnRuntime?: TurnRuntimeContext,
  ): Promise<AgentResponse> {
    const startMs = Date.now();
    let toolCallCount = 0;
    const allMedia: MediaAttachment[] = [];
    const runtimeModel = runtime.model;
    const runtimeProvider = runtime.provider;
    const runtimeClient = runtime.client;
    const runtimeIsOAuth = runtime.isOAuth;
    const runtimeMemory = runtime.memory;

    // Abort controller for this run — checked between iterations, passed to API calls
    const ac = turnRuntime?.abortController ?? new AbortController();
    const activeTurnId = turnRuntime?.turnId ?? `raw:${newTurnId()}`;
    this.registerActiveRun(chatId, activeTurnId, ac);

    // Per-run context copy — avoids races between concurrent turns and makes
    // situational-awareness reads use the exact turn client and abort signal.
    const runContext: ToolContext = {
      ...this.toolContext,
      chatId,
      onEvent,
      conversationHistory: this.history,
      abortSignal: ac.signal,
      brainOperations: turnRuntime?.brainOperations ?? this.toolContext.brainOperations,
      onOperationActivity: turnRuntime?.onOperationActivity,
      turnRuntime: turnRuntime ?? null,
    };

    // Start typing indicator (via toolContext.telegramAdapter)
    const adapter = this.toolContext.telegramAdapter;
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    if (adapter) {
      adapter.sendTyping(chatId).catch(() => {});
      typingInterval = setInterval(() => {
        adapter.sendTyping(chatId).catch(() => {});
      }, TYPING_INTERVAL_MS);
    }

    try {
      // Load conversation history
      const storedHistory = this.history.load(chatId);

      // Insert session boundary if gap > 30 minutes since last message
      const SESSION_GAP_MS = this.sessionGapMs;
      const now = new Date();
      let needsBoundary = storedHistory.length === 0;

      if (!needsBoundary && storedHistory.length > 0) {
        const last = storedHistory[storedHistory.length - 1]!;
        if ('ts' in last && last.ts) {
          const lastTs = new Date(last.ts).getTime();
          needsBoundary = (now.getTime() - lastTs) > SESSION_GAP_MS;
        } else {
          // No timestamp on last message — treat as gap exceeded
          needsBoundary = true;
        }
      }

      if (needsBoundary && storedHistory.length > 2) {
        await this.compileSessionTranscript(chatId, storedHistory);
      }

      if (needsBoundary) {
        const boundary: SessionBoundary = {
          type: 'session_boundary',
          ts: now.toISOString(),
          trigger: chatId.startsWith('cron-') ? chatId.replace('cron-', '') : chatId.split(':')[0] || 'chat',
        };
        this.history.append(chatId, [boundary]);
        storedHistory.push(boundary);
      }

      // Build user content blocks
      const userContent: ContentBlock[] = [];
      if (userText) {
        userContent.push({ type: 'text', text: userText });
      }
      // Add images as vision blocks. Carry path/fileName on the block so
      // history.ts can persist an image_ref pointer (instead of base64) and
      // rehydrate from disk on the next load — survives across turns.
      if (userMedia) {
        for (const m of userMedia) {
          if (m.type === 'image') {
            const { readFileSync } = await import('node:fs');
            const data = readFileSync(m.path).toString('base64');
            userContent.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: m.mimeType || 'image/jpeg',
                data,
              },
              path: m.path,
              fileName: m.fileName,
            });
          }
        }
      }

      // Add user message to history
      const userMsg: StoredMessage = {
        role: 'user',
        content: userContent.length === 1 && userContent[0]!.type === 'text'
          ? (userContent[0] as { type: 'text'; text: string }).text
          : userContent,
      };
      storedHistory.push(userMsg);

      // Truncate/compact if needed
      let truncated: StoredMessage[];
      let didTruncate = false;
      let recoveryBundle: string | null | undefined;

      if (this.compaction && this.compaction.needsCompaction(storedHistory, this.history.budget)) {
        try {
          const { messages: compactedMsgs, result } = await this.compaction.compact(chatId, storedHistory, runtimeModel, runtimeProvider);
          truncated = compactedMsgs;
          didTruncate = result.compacted;
          recoveryBundle = result.recoveryBundle;
          if (result.compacted) {
            console.log(`[agent] Auto-compacted: ${result.reason} (${result.tokensBefore} → ${result.tokensAfter})`);
          }
        } catch (err) {
          console.warn('[agent] Smart compaction failed, falling back to truncation:', err);
          truncated = this.history.truncate(storedHistory);
          didTruncate = truncated.length < storedHistory.length;
        }
      } else {
        const preCount = storedHistory.length;
        truncated = this.history.truncate(storedHistory);
        didTruncate = truncated.length < preCount;
      }

      // Get system prompt — provider-aware (overlay + voice + core)
      // Static identity portion — stable across calls, cacheable long-term.
      // Dynamic additions (situational awareness, COSMO state, recovery notes)
      // are kept separate so the static prefix hits cache on every call.
      const staticSystemPrompt = this.contextManager.getSystemPrompt(runtimeProvider);
      let rawSystemPrompt = staticSystemPrompt;

      // ── Session Bootstrap (situational + temporal awareness) ──
      // Fresh session OR resumed after idle-gap → inject the files listed in
      // config.situationalAwareness.bootstrap.reads (NOW.md + PLAYBOOK.md by default).
      // Turns 2+ within the same session skip this — content persists via history.
      if (needsBoundary) {
        try {
          const { buildBootstrapBlock } = await import('./session-bootstrap.js');
          const bootstrap = buildBootstrapBlock(this.workspacePath, this.situationalAwareness);
          if (bootstrap) {
            rawSystemPrompt += `\n\n${bootstrap}`;
            console.log(`[agent] Session bootstrap injected (${bootstrap.length} chars)`);
          }
        } catch (err) {
          console.warn('[agent] Session bootstrap failed:', err instanceof Error ? err.message : err);
        }
      }

      // ── Situational Awareness: Context Assembly (Step 20) ──
      // Replaces: hardcoded evobrew/cosmo checks + semanticRecall
      try {
        const recentTurns = truncated
          .filter((m): m is StoredMessage => 'role' in m)
          .slice(-5)
          .map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : stringifyContent(m.content as ContentBlock[]),
          }));

        const assembly = await assembleContext(
          userText,
          chatId,
          recentTurns,
          {
            workspacePath: this.workspacePath,
            brainDir: join(this.workspacePath, '..', 'brain'),
            enginePort: this.toolContext.enginePort,
            sessionId: chatId,
            triggerIndex: this.triggerIndex,
          },
          this.eventLedger,
        );

        if (assembly.block) {
          rawSystemPrompt += `\n\n${assembly.block}`;
        }

        // Log assembly result
        if (assembly.degraded) {
          console.warn('[agent] Situational awareness: DEGRADED — brain unreachable');
        } else if (assembly.brainCueCount > 0 || assembly.surfacesLoaded.length > 0) {
          console.log(`[agent] Situational awareness: ${assembly.brainCueCount} brain cues, ${assembly.surfacesLoaded.length} surfaces (${assembly.surfacesLoaded.join(', ')})`);
        }
      } catch (err) {
        // Never block on assembly failure — proceed with static identity only
        console.warn('[agent] Context assembly failed, proceeding without situational awareness:', err instanceof Error ? err.message : err);
      }

      // ── Situational awareness: COSMO 2.3 active-run check ──
      // Keep this — it's a real-time probe, not a surface/memory concern
      if (this.registry.get('research_launch')) {
        try {
          const { checkCosmoActiveRun } = await import('./tools/research.js');
          const active = await checkCosmoActiveRun(runContext);
          if (active) {
            rawSystemPrompt += `\n\n[COSMO ACTIVE RUN]
A research run is currently in flight — do not launch another.
- runName: ${active.runName}
- topic: ${active.topic || '(unknown)'}
- started: ${active.startedAt || '(unknown)'}
- processes: ${active.processCount ?? '(unknown)'}
Use research_watch_run to check progress. Use research_stop to cancel. You can still query completed brains while this runs.`;
          }
        } catch {
          // Never block on situational awareness failure
        }
      }

      // ── Memory: Recovery Bundle (after truncation/compaction) ───────
      if (didTruncate) {
        try {
          if (recoveryBundle) {
            rawSystemPrompt = `${rawSystemPrompt}\n\n${recoveryBundle}`;
          } else if (!this.compaction) {
            const bundle = runtimeMemory.buildRecoveryBundle();
            if (bundle) {
              rawSystemPrompt = `${rawSystemPrompt}\n\n${bundle}`;
            }
          }
        } catch {
          // Never block on memory failure
        }
      }

      // Build system prompt with multi-block caching strategy.
      //
      // Goal: maximize cache hits across calls. Cache is prefix-match, so we put
      // cache_control at the boundary between static (stable across calls) and
      // dynamic (varies per call) content. Every call that shares the static prefix
      // gets a cache hit on that prefix even though the dynamic tail differs.
      //
      // Block layout (non-OAuth, supported providers):
      //   [0] static identity (CLAUDE.md, COZ instructions, MCP tools)  ← cache_control
      //   [1] dynamic tail    (situational awareness, COSMO state, recovery)  no cache_control
      //
      // For OAuth (Claude via sk-ant-oat*): keep Claude Code stub + full real prompt
      // as two blocks (stub already has cache_control via getClaudeCodeSystemPrompt).
      const supportsCacheControl = runtimeProvider === 'anthropic' || runtimeProvider === 'minimax';
      const dynamicTail = rawSystemPrompt.length > staticSystemPrompt.length
        ? rawSystemPrompt.slice(staticSystemPrompt.length)
        : '';
      const systemPrompt: string | Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }> =
        runtimeIsOAuth
          ? [
              getClaudeCodeSystemPrompt(),
              { type: 'text' as const, text: rawSystemPrompt },
            ]
          : (supportsCacheControl && staticSystemPrompt.length >= 1024
              ? [
                  {
                    type: 'text' as const,
                    text: staticSystemPrompt,
                    cache_control: { type: 'ephemeral' as const },
                  },
                  ...(dynamicTail
                    ? [{ type: 'text' as const, text: dynamicTail }]
                    : []),
                ]
              : rawSystemPrompt);

      // Build messages for Anthropic API
      const messages = truncated.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      }));

      // Get tool definitions
      const tools = this.registry.getAnthropicTools();

      if (this.cacheDiagnostics?.enabled) {
        try {
          const systemPromptText = typeof systemPrompt === 'string'
            ? systemPrompt
            : systemPrompt.map(block => block.text).join('\n\n');
          const toolNames = tools.map(tool => tool.name);
          const historyText = truncated
            .map(m => `${m.role}:${stringifyContent(m.content)}`)
            .join('\n\n');
          const memorySuffix = rawSystemPrompt.startsWith(this.contextManager.getSystemPrompt())
            ? rawSystemPrompt.slice(this.contextManager.getSystemPrompt().length)
            : rawSystemPrompt;
          const memoryBlockHash = memorySuffix.trim() ? hashText(memorySuffix) : null;
          const memoryBlockLength = memorySuffix.trim().length;

          this.cacheDiagnostics.logger({
            type: 'turn',
            timestamp: new Date().toISOString(),
            chatId,
            provider: runtimeProvider,
            model: runtimeModel,
            systemPromptHash: hashText(systemPromptText),
            systemPromptLength: systemPromptText.length,
            toolsHash: hashText(JSON.stringify(toolNames)),
            toolCount: toolNames.length,
            toolNames,
            historyHash: hashText(historyText),
            historyLength: historyText.length,
            historyMessageCount: truncated.length,
            memoryBlockHash,
            memoryBlockLength,
            userTextHash: hashText(userText),
            userTextLength: userText.length,
            usedCompaction: didTruncate,
          });
        } catch (err) {
          console.warn('[cache-diagnostics] Failed to emit turn diagnostics:', err);
        }
      }

      // Track all messages exchanged during this turn for persistence
      const turnMessages: HistoryRecord[] = [userMsg];

      // Non-Claude model — chat-only, no tools
      const isClaudeModel = runtimeProvider === 'anthropic' || runtimeProvider === 'minimax';

      if (!isClaudeModel) {
        try {
          if (runtimeProvider === 'openai-codex') {
            // ── OpenAI Codex OAuth path ──
            // Uses ChatGPT OAuth credentials from ~/.evobrew/auth-profiles.json.
            // Calls https://chatgpt.com/backend-api/codex/responses (Responses API, SSE).
            // Returns respMsg in OAI Chat Completions format so the tool loop below runs unchanged.

            const creds = await this.codexCredentialsProvider();
            if (!creds) throw new Error('openai-codex credentials not found — connect OpenAI Codex in Home23 Setup or Settings > Providers');

            const sysText = typeof systemPrompt === 'string'
              ? systemPrompt
              : (systemPrompt as Array<{ text: string }>).map(b => b.text).join('\n');

            // Convert Anthropic-format history to OAI messages.
            // For user messages with image blocks, build a Responses API content
            // array so vision models can actually see the bytes.
            const chatMsgs: Array<Record<string, unknown>> = [];
            for (const m of truncated) {
              if (typeof m.content === 'string') {
                chatMsgs.push({ role: m.role, content: m.content });
              } else {
                const blocks = m.content as Array<Record<string, unknown>>;
                const hasImage = m.role === 'user' && blocks.some(b => b.type === 'image');
                if (hasImage) {
                  const respContent: Array<Record<string, unknown>> = [];
                  for (const block of blocks) {
                    if (block.type === 'text' && block.text) {
                      respContent.push({ type: 'input_text', text: block.text as string });
                    } else if (block.type === 'image') {
                      const src = block.source as { type?: string; media_type?: string; data?: string } | undefined;
                      if (src?.type === 'base64' && src.data && src.media_type) {
                        respContent.push({
                          type: 'input_image',
                          image_url: `data:${src.media_type};base64,${src.data}`,
                        });
                      }
                    }
                  }
                  if (respContent.length === 0) respContent.push({ type: 'input_text', text: '(empty)' });
                  chatMsgs.push({ role: m.role, content: respContent });
                } else {
                  const parts: string[] = [];
                  for (const block of blocks) {
                    if (block.type === 'text' && block.text) parts.push(block.text as string);
                    else if (block.type === 'tool_use') parts.push(`[Used tool: ${block.name}]`);
                    else if (block.type === 'tool_result') parts.push(`[Tool result: ${((block.content as string) || '').slice(0, 200)}]`);
                    else if (block.type === 'image') parts.push('[image]');
                  }
                  chatMsgs.push({ role: m.role, content: parts.join('\n') || '(empty)' });
                }
              }
            }

            // Build the live message array (system at index 0, always stays there)
            const apiMessages: Array<Record<string, unknown>> = [
              { role: 'system', content: sysText },
              ...chatMsgs,
            ];

            // Convert OAI tools to Responses API format.
            // Do NOT set strict:true — it requires additionalProperties:false recursively on all
            // nested schemas, which our tool definitions don't guarantee.
            type OAITool = { type: string; function: { name: string; description?: string; parameters?: unknown } };
            const codexTools = (this.registry.getOpenAITools() as OAITool[]).map(t => ({
              type: 'function',
              name: t.function.name,
              description: t.function.description ?? null,
              parameters: t.function.parameters ?? null,
            }));

            // ── Tool-use loop ──
            type ToolCallObj = { id?: string; type?: string; function: { name: string; arguments: string | Record<string, unknown> } };
            type ResponseMessage = { role: string; content?: string | null; tool_calls?: ToolCallObj[] };

            for (let i = 0; i < MAX_ITERATIONS; i++) {
              if (ac.signal.aborted) {
                const interruptText = `Stopped. (${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''}, ${((Date.now() - startMs) / 1000).toFixed(1)}s)`;
                turnMessages.push({ role: 'assistant', content: interruptText });
                this.history.append(chatId, turnMessages);
                return { text: interruptText, media: allMedia.length > 0 ? allMedia : undefined, model: runtimeModel, toolCallCount, durationMs: Date.now() - startMs };
              }

              // ── Convert apiMessages → Responses API input ──
              // apiMessages[0] is always the system message — extract as instructions, skip in input.
              const instructions = (apiMessages[0]?.content as string) ?? '';
              const inputItems: Array<Record<string, unknown>> = [];

              for (const msg of apiMessages.slice(1)) {
                const role = msg.role as string;
                const content = msg.content as string | Array<Record<string, unknown>> | null | undefined;
                const toolCalls = msg.tool_calls as ToolCallObj[] | undefined;

                if (role === 'user') {
                  inputItems.push({
                    type: 'message',
                    role: 'user',
                    content: Array.isArray(content)
                      ? content
                      : [{ type: 'input_text', text: (content as string | null | undefined) ?? '' }],
                  });
                } else if (role === 'assistant') {
                  // Emit text message first if content is non-empty
                  if (content) {
                    inputItems.push({
                      type: 'message',
                      role: 'assistant',
                      content: [{ type: 'output_text', text: content }],
                    });
                  }
                  // Emit function_call items for each tool call
                  if (toolCalls?.length) {
                    for (const tc of toolCalls) {
                      inputItems.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.function.name,
                        arguments: typeof tc.function.arguments === 'string'
                          ? tc.function.arguments
                          : JSON.stringify(tc.function.arguments),
                      });
                    }
                  }
                } else if (role === 'tool') {
                  inputItems.push({
                    type: 'function_call_output',
                    call_id: msg.tool_call_id as string,
                    output: (msg.content as string) ?? '',
                  });
                }
              }

              // ── POST to Codex endpoint ──
              const codexBody = {
                model: runtimeModel,
                instructions,
                input: inputItems,
                tools: codexTools.length > 0 ? codexTools : undefined,
                tool_choice: codexTools.length > 0 ? 'auto' : undefined,
                stream: true,
                store: false,
              };

              console.log(`[agent] codex request: model=${runtimeModel}, tools=${codexTools.length}, input_items=${inputItems.length}, instructions_len=${instructions.length}`);

              const codexTimeout = 120_000;
              const fetchSignal = combineRequestSignals(ac.signal, codexTimeout);

              const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
                method: 'POST',
                headers: getCodexHeaders(creds),
                body: JSON.stringify(codexBody),
                signal: fetchSignal,
              });

              if (!res.ok) {
                const errText = await res.text().catch(() => '');
                throw new Error(`codex HTTP ${res.status}: ${errText.slice(0, 300)}`);
              }
              if (!res.body) throw new Error('codex response missing body');

              // ── Parse SSE stream ──
              let textContent = '';
              type FunctionCallItem = { call_id: string; name: string; arguments: string };
              const functionCallItems: FunctionCallItem[] = [];

              for await (const event of parseSSE(res.body)) {
                const evType = event.type as string | undefined;
                if (evType === 'response.output_text.delta') {
                  textContent += (event.delta as string) ?? '';
                } else if (evType === 'response.output_text.done') {
                  textContent = (event.text as string) ?? textContent;
                } else if (evType === 'response.output_item.done') {
                  const item = event.item as Record<string, unknown> | undefined;
                  if (item?.type === 'function_call') {
                    functionCallItems.push({
                      call_id: item.call_id as string,
                      name: item.name as string,
                      arguments: (item.arguments as string) ?? '{}',
                    });
                  }
                }
              }

              // ── Build respMsg in OAI Chat Completions format ──
              const respMsg: ResponseMessage = {
                role: 'assistant',
                content: textContent || null,
                tool_calls: functionCallItems.length > 0
                  ? functionCallItems.map(fc => ({
                      id: fc.call_id,
                      type: 'function' as const,
                      function: { name: fc.name, arguments: fc.arguments },
                    }))
                  : undefined,
              };

              console.log(`[agent] codex response: content=${(respMsg.content || '').length} chars, tool_calls=${respMsg.tool_calls?.length ?? 0}, tools_sent=${codexTools.length}, model=${runtimeModel}`);

              // ── Process the response ──
              const toolCalls = respMsg.tool_calls;

              if (!toolCalls || toolCalls.length === 0) {
                let contentStr = (respMsg.content || '').trim();

                // Detect model outputting tool calls as text — strip and retry
                const hasTextToolCall = contentStr.includes('<parameter name=') ||
                  contentStr.includes('</invoke>') ||
                  contentStr.includes('[Used tool') ||
                  contentStr.includes('"type":"tool_use"') ||
                  contentStr.includes('"type":"function"');

                if (hasTextToolCall) {
                  console.warn('[agent] codex: model returned tool calls as text — stripping and retrying');
                  const cleanText = contentStr
                    .replace(/\[Used tools?[^\]]*\][\s\S]*$/m, '')
                    .replace(/\[?\{["\s]*type["\s]*:["\s]*(tool_use|function)[\s\S]*$/m, '')
                    .trim();
                  if (cleanText) apiMessages.push({ role: 'assistant', content: cleanText });
                  apiMessages.push({ role: 'user', content: 'Please use the function calling tools provided to take actions. Do not output tool calls as text.' });
                  continue;
                }

                const answer = contentStr || '(no response)';
                if (onEvent && answer) onEvent({ type: 'response_chunk', chunk: answer });
                turnMessages.push({ role: 'assistant', content: answer });
                this.history.append(chatId, turnMessages);
                if (messages.length > 10) {
                  runtimeMemory.extractAndSave(chatId, messages, runtimeModel, runtimeProvider).catch(() => {});
                }
                return { text: answer, media: allMedia.length > 0 ? allMedia : undefined, model: runtimeModel, toolCallCount, durationMs: Date.now() - startMs };
              }

              // Model wants to call tools — append to apiMessages and execute
              apiMessages.push({
                role: 'assistant',
                content: respMsg.content || null,
                tool_calls: toolCalls,
              });

              for (const tc of toolCalls) {
                if (ac.signal.aborted) {
                  apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: 'Interrupted by /stop' });
                  continue;
                }

                toolCallCount++;
                let input: Record<string, unknown>;
                if (typeof tc.function.arguments === 'string') {
                  try { input = JSON.parse(tc.function.arguments); } catch { input = { raw: tc.function.arguments }; }
                } else {
                  input = tc.function.arguments as Record<string, unknown>;
                }

                const argsPreview = typeof tc.function.arguments === 'string'
                  ? tc.function.arguments.slice(0, 100)
                  : JSON.stringify(tc.function.arguments).slice(0, 100);
                console.log(`[agent] Tool call #${toolCallCount}: ${tc.function.name}(${argsPreview})`);
                if (onEvent) onEvent({ type: 'tool_start', tool: tc.function.name, args: input });

                try {
                  const formatted = await executeAndFormatTool({
                    registry: this.registry,
                    name: tc.function.name,
                    input,
                    context: runContext,
                    onEvent,
                    modelLimit: MODEL_TOOL_RESULT_LIMIT_CHARS,
                    eventLimit: TOOL_EVENT_RESULT_LIMIT_CHARS,
                  });
                  const { result } = formatted;
                  if (result.media) {
                    allMedia.push(...result.media);
                    if (onEvent) for (const m of result.media) onEvent({ type: 'media', mediaType: m.type || 'image', path: m.path, caption: m.caption });
                  }
                  apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: formatted.modelContent });
                } catch (toolErr) {
                  console.error(`[agent] Tool ${tc.function.name} threw:`, toolErr);
                  const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                  apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: `Tool error: ${errMsg}` });
                  if (onEvent) onEvent({ type: 'tool_result', tool: tc.function.name, result: errMsg, success: false });
                }
              }

              const toolNames = toolCalls.map(tc => tc.function.name).join(', ');
              turnMessages.push({ role: 'assistant', content: `[Used tools: ${toolNames}]` });
              // continue to next iteration
            }

            // Hit iteration cap
            const capText = `Hit max tool calls (${MAX_ITERATIONS}).`;
            turnMessages.push({ role: 'assistant', content: capText });
            this.history.append(chatId, turnMessages);
            return { text: capText, media: allMedia.length > 0 ? allMedia : undefined, model: runtimeModel, toolCallCount, durationMs: Date.now() - startMs };
          } else if (runtimeProvider === 'xai' || runtimeModel.includes('grok')) {
            // ── xAI Responses API path (all Grok models) ──
            const xaiKey = process.env.XAI_API_KEY;
            if (!xaiKey) throw new Error('XAI_API_KEY not set');

            const sysText = typeof systemPrompt === 'string'
              ? systemPrompt
              : (systemPrompt as Array<{ text: string }>).map(b => b.text).join('\n');

            const chatMsgs: Array<Record<string, unknown>> = [];
            for (const m of truncated) {
              if (typeof m.content === 'string') {
                chatMsgs.push({ role: m.role, content: m.content });
              } else {
                const parts: string[] = [];
                for (const block of m.content as Array<Record<string, unknown>>) {
                  if (block.type === 'text' && block.text) parts.push(block.text as string);
                  else if (block.type === 'tool_use') parts.push(`[Used tool: ${block.name}]`);
                  else if (block.type === 'tool_result') parts.push(`[Tool result: ${((block.content as string) || '').slice(0, 200)}]`);
                  else if (block.type === 'image') parts.push('[image]');
                }
                chatMsgs.push({ role: m.role, content: parts.join('\n') || '(empty)' });
              }
            }

            const xaiTools = buildXaiResponseTools(this.registry);

            const initialInput: Array<Record<string, unknown>> = [
              ...(sysText ? [{ role: 'system', content: sysText }] : []),
              ...chatMsgs,
            ];

            type ToolCallObj = { id?: string; type?: string; function: { name: string; arguments: string | Record<string, unknown> } };
            let previousResponseId: string | null = null;
            let nextInputItems: Array<Record<string, unknown>> | null = null;

            for (let i = 0; i < MAX_ITERATIONS; i++) {
              if (ac.signal.aborted) {
                const interruptText = `Stopped. (${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''}, ${((Date.now() - startMs) / 1000).toFixed(1)}s)`;
                turnMessages.push({ role: 'assistant', content: interruptText });
                this.history.append(chatId, turnMessages);
                return { text: interruptText, media: allMedia.length > 0 ? allMedia : undefined, model: runtimeModel, toolCallCount, durationMs: Date.now() - startMs };
              }

              const inputItems = nextInputItems ?? initialInput;

              const xaiBody = {
                model: runtimeModel,
                input: inputItems,
                tools: xaiTools.length > 0 ? xaiTools : undefined,
                tool_choice: xaiTools.length > 0 ? 'auto' : undefined,
                parallel_tool_calls: true,
                truncation: 'auto',
                max_output_tokens: this.maxTokens,
                temperature: this.temperature,
                tool_stream: true,
                stream: true,
                ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
              };

              const xaiTimeout = 120_000;
              const fetchSignal = combineRequestSignals(ac.signal, xaiTimeout);

              const res = await fetch('https://api.x.ai/v1/responses', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${xaiKey}` },
                body: JSON.stringify(xaiBody),
                signal: fetchSignal,
              });

              if (!res.ok) {
                const errText = await res.text().catch(() => '');
                throw new Error(`xai responses HTTP ${res.status}: ${errText.slice(0, 300)}`);
              }
              if (!res.body) throw new Error('xai responses missing body');

              // Parse SSE stream
              let textContent = '';
              let reasoningSummary = '';
              let streamedAnswer = false;
              type FunctionCallItem = { call_id: string; name: string; arguments: string };
              const functionCallItems: FunctionCallItem[] = [];
              const serverToolNames: string[] = [];
              let responseId: string | null = null;

              for await (const event of parseSSE(res.body)) {
                const evType = event.type as string | undefined;
                const maybeResponse = event.response as Record<string, unknown> | undefined;
                if (typeof maybeResponse?.id === 'string') {
                  responseId = maybeResponse.id;
                } else if (typeof event.id === 'string') {
                  responseId = event.id as string;
                }
                if (evType === 'response.output_text.delta') {
                  textContent += (event.delta as string) ?? '';
                  if (onEvent && event.delta) {
                    streamedAnswer = true;
                    onEvent({ type: 'response_chunk', chunk: event.delta as string });
                  }
                } else if (evType === 'response.output_text.done') {
                  textContent = (event.text as string) ?? textContent;
                } else if (evType === 'response.output_item.done') {
                  const item = event.item as Record<string, unknown> | undefined;
                  if (item?.type === 'function_call') {
                    functionCallItems.push({ call_id: item.call_id as string, name: item.name as string, arguments: (item.arguments as string) ?? '{}' });
                  } else {
                    const toolName = getXaiServerToolNameFromItem(item);
                    if (toolName) {
                      toolCallCount++;
                      serverToolNames.push(toolName);
                      const args = item ? getXaiServerToolArgs(item) : {};
                      if (onEvent) {
                        onEvent({ type: 'tool_start', tool: toolName, args });
                        onEvent({
                          type: 'tool_result',
                          tool: toolName,
                          result: summarizeXaiServerToolResult(toolName, item ?? {}),
                          success: xaiServerToolSucceeded(item ?? {}),
                        });
                      }
                    }
                  }
                } else if (evType === 'response.reasoning_summary_text.delta') {
                  reasoningSummary += (event.delta as string) ?? '';
                  if (onEvent) onEvent({ type: 'thinking', content: (event.delta as string) ?? '' });
                } else if (evType === 'response.reasoning_summary_text.done') {
                  reasoningSummary = (event.text as string) ?? reasoningSummary;
                }
              }

              const answerText = (textContent || reasoningSummary || '').trim();
              const toolCalls: ToolCallObj[] = functionCallItems.map(fc => ({
                id: fc.call_id,
                type: 'function' as const,
                function: { name: fc.name, arguments: fc.arguments },
              }));

              console.log(`[agent] xai responses: content=${answerText.length} chars, tool_calls=${toolCalls.length}, tools_sent=${xaiTools.length}, model=${runtimeModel}`);

              if (toolCalls.length === 0) {
                const answer = answerText || '(no response)';
                if (onEvent && answer && !streamedAnswer) {
                  onEvent({ type: 'response_chunk', chunk: answer });
                }
                if (serverToolNames.length > 0) {
                  turnMessages.push({ role: 'assistant', content: `[Used tools: ${serverToolNames.join(', ')}]` });
                }
                turnMessages.push({ role: 'assistant', content: answer });
                this.history.append(chatId, turnMessages);
                if (messages.length > 10) {
                  runtimeMemory.extractAndSave(chatId, messages, runtimeModel, runtimeProvider).catch(() => {});
                }
                return { text: answer, media: allMedia.length > 0 ? allMedia : undefined, model: runtimeModel, toolCallCount, durationMs: Date.now() - startMs };
              }

              if (!responseId) {
                throw new Error('xai responses missing response id for tool continuation');
              }

              previousResponseId = responseId;
              nextInputItems = [];
              for (const tc of toolCalls) {
                if (ac.signal.aborted) {
                  nextInputItems.push({ type: 'function_call_output', call_id: tc.id, output: 'Interrupted by /stop' });
                  continue;
                }
                toolCallCount++;
                let input: Record<string, unknown>;
                try { input = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments; }
                catch { input = {}; }
                if (onEvent) onEvent({ type: 'tool_start', tool: tc.function.name, args: input });
                try {
                  const formatted = await executeAndFormatTool({
                    registry: this.registry,
                    name: tc.function.name,
                    input,
                    context: runContext,
                    onEvent,
                    modelLimit: MODEL_TOOL_RESULT_LIMIT_CHARS,
                    eventLimit: TOOL_EVENT_RESULT_LIMIT_CHARS,
                  });
                  const { result } = formatted;
                  if (result.media?.length) { allMedia.push(...result.media); if (onEvent) for (const m of result.media) onEvent({ type: 'media', mediaType: m.type || 'image', path: m.path, caption: m.caption }); }
                  nextInputItems.push({ type: 'function_call_output', call_id: tc.id, output: formatted.modelContent });
                } catch (toolErr) {
                  const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                  nextInputItems.push({ type: 'function_call_output', call_id: tc.id, output: `Error: ${errMsg}` });
                  if (onEvent) onEvent({ type: 'tool_result', tool: tc.function.name, result: errMsg, success: false });
                }
              }
              const toolNames = [...serverToolNames, ...toolCalls.map(tc => tc.function.name)].join(', ');
              turnMessages.push({ role: 'assistant', content: `[Used tools: ${toolNames}]` });
            }

            const capText = `Hit max tool calls (${MAX_ITERATIONS}).`;
            turnMessages.push({ role: 'assistant', content: capText });
            this.history.append(chatId, turnMessages);
            return { text: capText, media: allMedia.length > 0 ? allMedia : undefined, model: runtimeModel, toolCallCount, durationMs: Date.now() - startMs };

          } else {
          // ── Non-Claude tool-use loop ──
          // Ollama Cloud: native /api/chat (proper tool support, configurable num_ctx)
          // OpenAI: /v1/chat/completions (standard OpenAI format)

          const isOllamaCloud = runtimeProvider === 'ollama-cloud';

          const providerConfig: Record<string, { keyEnv: string; timeout: number }> = {
            'openai': { keyEnv: 'OPENAI_API_KEY', timeout: 60_000 },
            'ollama-cloud': { keyEnv: 'OLLAMA_CLOUD_API_KEY', timeout: 120_000 },
          };
          const pconf = providerConfig[runtimeProvider];
          if (!pconf) throw new Error(`Unknown provider: ${runtimeProvider}`);

          const apiKey = process.env[pconf.keyEnv];
          if (!apiKey) throw new Error(`${pconf.keyEnv} not set`);

          const sysText = typeof systemPrompt === 'string'
            ? systemPrompt
            : (systemPrompt as Array<{text: string}>).map(b => b.text).join('\n');

          // Convert Anthropic-format history to plain text messages
          const chatMsgs: Array<Record<string, unknown>> = [];
          for (const m of truncated) {
            if (typeof m.content === 'string') {
              chatMsgs.push({ role: m.role, content: m.content });
            } else {
              const parts: string[] = [];
              for (const block of m.content as Array<Record<string, unknown>>) {
                if (block.type === 'text' && block.text) parts.push(block.text as string);
                else if (block.type === 'tool_use') parts.push(`[Used tool: ${block.name}]`);
                else if (block.type === 'tool_result') parts.push(`[Tool result: ${((block.content as string) || '').slice(0, 200)}]`);
                else if (block.type === 'image') parts.push('[image]');
              }
              chatMsgs.push({ role: m.role, content: parts.join('\n') || '(empty)' });
            }
          }

          // Check if model supports tools (Ollama Cloud only — cache per model)
          let modelSupportsTools = true;
          if (isOllamaCloud) {
            if (!ollamaCapabilitiesCache.has(runtimeModel)) {
              try {
                const showRes = await fetch('https://ollama.com/api/show', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                  body: JSON.stringify({ model: runtimeModel }),
                  signal: combineRequestSignals(ac.signal, 5_000),
                });
                if (showRes.ok) {
                  const showData = await showRes.json() as { capabilities?: string[] };
                  ollamaCapabilitiesCache.set(runtimeModel, new Set(showData.capabilities ?? []));
                }
              } catch { /* assume tools supported */ }
            }
            const caps = ollamaCapabilitiesCache.get(runtimeModel);
            if (caps && !caps.has('tools')) {
              modelSupportsTools = false;
              console.log(`[agent] Model ${runtimeModel} does not support tools — chat-only mode`);
            }
          }

          const oaiTools = modelSupportsTools ? this.registry.getOpenAITools() : [];

          // Build the live message array for the API (mutated during tool loop)
          const apiMessages: Array<Record<string, unknown>> = [
            { role: 'system', content: sysText },
            ...chatMsgs,
          ];

          // Tool-use loop
          for (let i = 0; i < MAX_ITERATIONS; i++) {
            if (ac.signal.aborted) {
              const interruptText = `Stopped. (${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''}, ${((Date.now() - startMs) / 1000).toFixed(1)}s)`;
              turnMessages.push({ role: 'assistant', content: interruptText });
              this.history.append(chatId, turnMessages);
              return { text: interruptText, media: allMedia.length > 0 ? allMedia : undefined, model: runtimeModel, toolCallCount, durationMs: Date.now() - startMs };
            }

            // ── Make the API call ──
            type ToolCallObj = { id?: string; function: { name: string; arguments: string | Record<string, unknown> } };
            type ResponseMessage = { role: string; content?: string | null; tool_calls?: ToolCallObj[] };
            let respMsg: ResponseMessage;

            if (isOllamaCloud) {
              // Native Ollama /api/chat — proper tool support + num_ctx
              const res = await fetch('https://ollama.com/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                  model: runtimeModel,
                  messages: apiMessages,
                  tools: oaiTools.length > 0 ? oaiTools : undefined,
                  stream: false,
                  options: { num_ctx: 32768, temperature: this.temperature },
                }),
                signal: combineRequestSignals(ac.signal, pconf.timeout),
              });
              if (!res.ok) {
                const errText = await res.text().catch(() => '');
                throw new Error(`ollama-cloud HTTP ${res.status}: ${errText.slice(0, 300)}`);
              }
              const data = await res.json() as { message?: ResponseMessage };
              respMsg = data.message ?? { role: 'assistant', content: '(no response)' };
            } else {
              // OpenAI — standard /v1/chat/completions
              const baseUrl = 'https://api.openai.com/v1';
              const isGpt5Plus = runtimeModel.includes('gpt-5') || runtimeModel.includes('gpt5');
              const tokenParam = isGpt5Plus ? { max_completion_tokens: this.maxTokens } : { max_tokens: this.maxTokens };

              const res = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                  model: runtimeModel,
                  messages: apiMessages,
                  tools: oaiTools.length > 0 ? oaiTools : undefined,
                  ...tokenParam,
                  temperature: this.temperature,
                }),
                signal: combineRequestSignals(ac.signal, pconf.timeout),
              });
              if (!res.ok) {
                const errText = await res.text().catch(() => '');
                throw new Error(`openai HTTP ${res.status}: ${errText.slice(0, 300)}`);
              }
              const data = await res.json() as { choices?: Array<{ message: ResponseMessage }> };
              respMsg = data.choices?.[0]?.message ?? { role: 'assistant', content: '(no response)' };
            }

            // ── Process the response ──
            const toolCalls = respMsg.tool_calls;

            // Log response shape for debugging
            console.log(`[agent] Response: content=${(respMsg.content || '').length} chars, tool_calls=${toolCalls?.length ?? 0}, tools_sent=${oaiTools.length}, model=${runtimeModel}`);

            if (!toolCalls || toolCalls.length === 0) {
              let contentStr = (respMsg.content || '').trim();

              // Detect model outputting tool calls as text (XML or JSON format)
              // instead of using the function calling API. Strip and retry.
              const hasTextToolCall = contentStr.includes('<parameter name=') ||
                contentStr.includes('</invoke>') ||
                contentStr.includes('[Used tool') ||
                contentStr.includes('"type":"tool_use"') ||
                contentStr.includes('"type":"function"');

              if (hasTextToolCall) {
                console.warn(`[agent] Model returned tool calls as text — stripping and retrying`);
                // Strip the fake tool call, keep any real text before it
                const cleanText = contentStr
                  .replace(/\[Used tools?[^\]]*\][\s\S]*$/m, '')
                  .replace(/\[?\{["\s]*type["\s]*:["\s]*(tool_use|function)[\s\S]*$/m, '')
                  .trim();

                if (cleanText) {
                  apiMessages.push({ role: 'assistant', content: cleanText });
                }
                apiMessages.push({ role: 'user', content: 'Please use the function calling tools provided to take actions. Do not output tool calls as text.' });
                continue;
              }

              // Final text response
              const answer = contentStr || '(no response)';
              if (onEvent && answer) onEvent({ type: 'response_chunk', chunk: answer });
              turnMessages.push({ role: 'assistant', content: answer });
              this.history.append(chatId, turnMessages);
              if (messages.length > 10) {
                runtimeMemory.extractAndSave(chatId, messages, runtimeModel, runtimeProvider).catch(() => {});
              }
              return { text: answer, media: allMedia.length > 0 ? allMedia : undefined, model: runtimeModel, toolCallCount, durationMs: Date.now() - startMs };
            }

            // Model wants to call tools
            apiMessages.push({
              role: 'assistant',
              content: respMsg.content || null,
              tool_calls: toolCalls,
            });

            for (const tc of toolCalls) {
              if (ac.signal.aborted) {
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: 'Interrupted by /stop' });
                continue;
              }

              toolCallCount++;
              // Native Ollama returns arguments as object; OpenAI returns as string
              let input: Record<string, unknown>;
              if (typeof tc.function.arguments === 'string') {
                try { input = JSON.parse(tc.function.arguments); } catch { input = { raw: tc.function.arguments }; }
              } else {
                input = tc.function.arguments as Record<string, unknown>;
              }

              const argsPreview = typeof tc.function.arguments === 'string' ? tc.function.arguments.slice(0, 100) : JSON.stringify(tc.function.arguments).slice(0, 100);
              console.log(`[agent] Tool call #${toolCallCount}: ${tc.function.name}(${argsPreview})`);
              if (onEvent) onEvent({ type: 'tool_start', tool: tc.function.name, args: input });

              try {
                const formatted = await executeAndFormatTool({
                  registry: this.registry,
                  name: tc.function.name,
                  input,
                  context: runContext,
                  onEvent,
                  modelLimit: MODEL_TOOL_RESULT_LIMIT_CHARS,
                  eventLimit: TOOL_EVENT_RESULT_LIMIT_CHARS,
                });
                const { result } = formatted;
                if (result.media) {
                  allMedia.push(...result.media);
                  if (onEvent) for (const m of result.media) onEvent({ type: 'media', mediaType: m.type || 'image', path: m.path, caption: m.caption });
                }
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: formatted.modelContent });
              } catch (toolErr) {
                console.error(`[agent] Tool ${tc.function.name} threw:`, toolErr);
                const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: `Tool error: ${errMsg}` });
                if (onEvent) onEvent({ type: 'tool_result', tool: tc.function.name, result: errMsg, success: false });
              }
            }

            // Record in history for Anthropic-format persistence
            const toolNames = toolCalls.map(tc => tc.function.name).join(', ');
            turnMessages.push({ role: 'assistant', content: `[Used tools: ${toolNames}]` });
            continue;
          }

          // Hit iteration cap
          const capText = `Hit max tool calls (${MAX_ITERATIONS}).`;
          turnMessages.push({ role: 'assistant', content: capText });
          this.history.append(chatId, turnMessages);
          return { text: capText, media: allMedia.length > 0 ? allMedia : undefined, model: runtimeModel, toolCallCount, durationMs: Date.now() - startMs };
          } // end else (non-codex providers)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errorText = `Error calling ${runtimeModel}: ${errMsg}`;
          throw new Error(errorText);
        }
      }

      // The loop
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        // ── Check abort signal (set by /stop command) ──
        if (ac.signal.aborted) {
          const interruptText = `Stopped. (${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''}, ${((Date.now() - startMs) / 1000).toFixed(1)}s)`;
          turnMessages.push({ role: 'assistant', content: interruptText });
          this.history.append(chatId, turnMessages);
          return {
            text: interruptText,
            media: allMedia.length > 0 ? allMedia : undefined,
            model: runtimeModel,
            toolCallCount,
            durationMs: Date.now() - startMs,
          };
        }

        let response: Anthropic.Message;
        try {
          // Streaming call: emit text/thinking deltas to onEvent as they arrive,
          // then resolve the full Message at the end for tool-loop processing.
          // SDK: messages.stream() returns an iterable of server-sent events plus
          // a finalMessage() method that yields the fully-accumulated Message.
          const omitSamplingParams = isAnthropicSamplingDeprecatedModel(runtimeModel);
          const requestParams: Record<string, unknown> = {
            model: runtimeModel,
            max_tokens: this.maxTokens,
            system: systemPrompt,
            messages: messages as Anthropic.MessageParam[],
            tools: tools as Anthropic.Tool[],
            temperature: this.temperature,
          };
          if (omitSamplingParams) {
            delete requestParams.temperature;
          }

          const stream = runtimeClient.messages.stream(
            requestParams as unknown as Anthropic.MessageCreateParams,
            { signal: ac.signal },
          );

          for await (const event of stream) {
            if (event.type === 'content_block_delta' && onEvent) {
              const delta = event.delta as
                | { type: 'text_delta'; text: string }
                | { type: 'thinking_delta'; thinking: string }
                | { type: 'input_json_delta'; partial_json: string };
              if (delta.type === 'text_delta') {
                onEvent({ type: 'response_chunk', chunk: delta.text });
              } else if (delta.type === 'thinking_delta') {
                onEvent({ type: 'thinking', content: delta.thinking });
              }
              // input_json_delta accumulates tool-call arguments; surface the
              // completed tool call at content_block_stop via finalMessage below.
            }
          }

          response = await stream.finalMessage();
        } catch (err) {
          // If aborted by /stop, exit gracefully instead of throwing
          if (ac.signal.aborted) {
            const interruptText = `Stopped. (${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''}, ${((Date.now() - startMs) / 1000).toFixed(1)}s)`;
            turnMessages.push({ role: 'assistant', content: interruptText });
            this.history.append(chatId, turnMessages);
            return {
              text: interruptText,
              media: allMedia.length > 0 ? allMedia : undefined,
              model: runtimeModel,
              toolCallCount,
              durationMs: Date.now() - startMs,
            };
          }
          throw err;
        }

        // ── Handle tool_use blocks (regardless of stop_reason) ──
        const toolUseBlocks = response.content.filter(b => b.type === 'tool_use') as Array<{
          type: 'tool_use';
          id: string;
          name: string;
          input: Record<string, unknown>;
        }>;

        if (toolUseBlocks.length > 0) {
          // Add assistant message with tool calls to messages
          const assistantToolMsg = {
            role: 'assistant' as const,
            content: response.content as unknown as string | ContentBlock[],
          };
          messages.push(assistantToolMsg);
          turnMessages.push(assistantToolMsg as StoredMessage);

          // Execute each tool and collect results
          const toolResults: Array<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> = [];

          for (const toolCall of toolUseBlocks) {
            // Check abort before each tool execution
            if (ac.signal.aborted) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: 'Interrupted by /stop',
                is_error: true,
              });
              continue;
            }

            toolCallCount++;
            console.log(`[agent] Tool call #${toolCallCount}: ${toolCall.name}(${JSON.stringify(toolCall.input).slice(0, 100)})`);
            if (onEvent) onEvent({ type: 'tool_start', tool: toolCall.name, args: toolCall.input });

            // Catch per-tool errors so one bad tool doesn't kill the whole turn
            try {
              const formatted = await executeAndFormatTool({
                registry: this.registry,
                name: toolCall.name,
                input: toolCall.input,
                context: runContext,
                onEvent,
                modelLimit: MODEL_TOOL_RESULT_LIMIT_CHARS,
                eventLimit: TOOL_EVENT_RESULT_LIMIT_CHARS,
              });
              const { result } = formatted;

              if (result.media) {
                allMedia.push(...result.media);
                if (onEvent) {
                  for (const m of result.media) {
                    onEvent({ type: 'media', mediaType: m.type || 'image', path: m.path, caption: m.caption });
                  }
                }
              }

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: formatted.modelContent,
                ...(result.is_error ? { is_error: true } : {}),
              });
            } catch (toolErr) {
              console.error(`[agent] Tool ${toolCall.name} threw:`, toolErr);
              const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: `Tool error: ${errMsg}`,
                is_error: true,
              });
              if (onEvent) onEvent({ type: 'tool_result', tool: toolCall.name, result: errMsg, success: false });
            }
          }

          // Add tool results as user message
          const toolResultMsg = {
            role: 'user' as const,
            content: toolResults as unknown as string | ContentBlock[],
          };
          messages.push(toolResultMsg);
          turnMessages.push(toolResultMsg as StoredMessage);

          continue;
        }

        // ── Cache activity — known only after stream completes ──
        // Text/thinking deltas have already been streamed to onEvent above;
        // this reports token accounting from the final message usage block.
        const usage = response.usage as { cache_read_input_tokens?: number; cache_creation_input_tokens?: number; input_tokens?: number; output_tokens?: number } | undefined;
        const cacheRead = usage?.cache_read_input_tokens ?? 0;
        const cacheWrite = usage?.cache_creation_input_tokens ?? 0;
        if ((cacheRead > 0 || cacheWrite > 0) && onEvent) {
          onEvent({ type: 'cache', read: cacheRead, write: cacheWrite, input: usage?.input_tokens ?? 0, output: usage?.output_tokens ?? 0 });
        }

        // ── Assemble final text (already streamed; this is for history storage) ──
        const textBlocks = response.content.filter(b => b.type === 'text');
        const finalText = textBlocks.map(b => (b as { text: string }).text).join('\n');

        if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence' || finalText) {
          const assistantMsg: StoredMessage = { role: 'assistant', content: finalText || '(no response)' };
          turnMessages.push(assistantMsg);
          this.history.append(chatId, turnMessages);

          // ── Memory: Extract and save (fire-and-forget) ───
          if (messages.length > 10) {
            runtimeMemory.extractAndSave(chatId, messages, runtimeModel, runtimeProvider).catch(() => {});
          }

          return {
            text: finalText || '(no response)',
            media: allMedia.length > 0 ? allMedia : undefined,
            model: runtimeModel,
            toolCallCount,
            durationMs: Date.now() - startMs,
          };
        }

        // Truly unexpected — log and return what we have
        console.warn(`[agent] Unexpected stop_reason: ${response.stop_reason}, content types: ${response.content.map(b => b.type).join(',')}`);
        turnMessages.push({ role: 'assistant', content: '(unexpected response)' });
        this.history.append(chatId, turnMessages);

        return {
          text: '(unexpected response)',
          media: allMedia.length > 0 ? allMedia : undefined,
          model: runtimeModel,
          toolCallCount,
          durationMs: Date.now() - startMs,
        };
      }

      // Hit iteration cap — still persist what we have
      const capText = `I've hit the maximum number of tool calls (${MAX_ITERATIONS}) for this message. Here's what I've done so far — let me know if you'd like me to continue.`;
      turnMessages.push({ role: 'assistant', content: capText });
      this.history.append(chatId, turnMessages);

      return {
        text: capText,
        media: allMedia.length > 0 ? allMedia : undefined,
        model: runtimeModel,
        toolCallCount,
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      console.error('[agent] LOOP ERROR:', err instanceof Error ? err.message : String(err));
      if (err instanceof Error && err.stack) console.error('[agent] Stack:', err.stack);
      throw err;
    } finally {
      this.unregisterActiveRun(chatId, activeTurnId, ac);
      if (typingInterval) clearInterval(typingInterval);
    }
  }
}
