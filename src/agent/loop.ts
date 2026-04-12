/**
 * COSMO Home 2.3 — Agent Loop
 *
 * The core agentic tool-use loop. Every message enters here.
 * The LLM sees tools, decides what to use, executes them,
 * and loops until it produces a final text response.
 */

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolRegistry } from './tools/index.js';
import type { ContextManager } from './context.js';
import { ConversationHistory, type StoredMessage, type ContentBlock, type HistoryRecord, type SessionBoundary } from './history.js';
import type { AgentResponse, ToolContext } from './types.js';
import { MemoryManager } from './memory.js';
import type { CompactionManager } from './compaction.js';
import type { MediaAttachment } from '../types.js';
import { getCodexCredentials, getCodexHeaders } from './codex-auth.js';
import { assembleContext } from './context-assembly.js';
import { EventLedger } from './event-ledger.js';

const MAX_ITERATIONS = 100;
const TYPING_INTERVAL_MS = 4000;

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
  return `${toolName} completed via xAI server: ${details}`.slice(0, 300);
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
  private activeRuns = new Map<string, AbortController>();
  private sessionGapMs: number;
  private workspacePath: string;
  private eventLedger: EventLedger;

  constructor(opts: {
    apiKey: string;
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
  }) {
    // OAuth tokens (sk-ant-oat*) need stealth headers + authToken param
    this.isOAuth = opts.apiKey.startsWith('sk-ant-oat');
    this.client = this.isOAuth
      ? new Anthropic({
          authToken: opts.apiKey,
          defaultHeaders: getStealthHeaders(),
          dangerouslyAllowBrowser: true,
        })
      : new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
    this.provider = opts.provider ?? (opts.model.includes('claude') ? 'anthropic' : 'unknown');
    this.maxTokens = opts.maxTokens ?? 8192;
    this.temperature = opts.temperature ?? 0.7;
    this.registry = opts.registry;
    this.contextManager = opts.contextManager;
    this.history = opts.history;
    this.toolContext = opts.toolContext;
    this.memory = new MemoryManager({
      client: this.client,
      model: this.model,
      workspacePath: opts.workspacePath,
    });
    this.compaction = opts.compaction ?? null;
    this.cacheDiagnostics = opts.cacheDiagnostics;
    this.sessionGapMs = opts.sessionGapMs ?? 30 * 60 * 1000;
    this.workspacePath = opts.workspacePath;
    this.eventLedger = new EventLedger(join(this.workspacePath, '..', 'brain'));
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
    const filename = `session-${timestamp}.md`;
    const sessionsDir = join(this.workspacePath, 'sessions');

    try {
      mkdirSync(sessionsDir, { recursive: true });
      const content = `# Conversation Session\n\nDate: ${new Date().toISOString()}\nChannel: ${chatId}\nMessages: ${sessionMessages.length}\n\n---\n\n${lines.join('\n\n')}`;
      writeFileSync(join(sessionsDir, filename), content);
      console.log(`[loop] Session transcript written: ${filename} (${sessionMessages.length} messages)`);
    } catch (err) {
      console.warn(`[loop] Failed to write session transcript: ${err}`);
    }
  }

  /** Expose client for CompactionManager wiring */
  getClient(): Anthropic { return this.client; }

  /** Expose memory for CompactionManager wiring */
  getMemory(): MemoryManager { return this.memory; }

  setModel(model: string, provider?: string): void {
    this.model = model;
    this.provider = provider ?? (
      model.includes('claude') ? 'anthropic' :
      model.includes('grok') ? 'xai' :
      'unknown'
    );
  }

  getModel(): string {
    return this.model;
  }

  getProvider(): string {
    return this.provider;
  }

  /** Stop an active run. Returns true if a run was aborted. */
  stop(chatId?: string): { stopped: boolean; chatIds: string[] } {
    if (chatId) {
      const ac = this.activeRuns.get(chatId);
      if (ac) {
        ac.abort();
        this.activeRuns.delete(chatId);
        return { stopped: true, chatIds: [chatId] };
      }
      return { stopped: false, chatIds: [] };
    }
    // Stop all active runs
    const ids = [...this.activeRuns.keys()];
    for (const ac of this.activeRuns.values()) ac.abort();
    this.activeRuns.clear();
    return { stopped: ids.length > 0, chatIds: ids };
  }

  /** Check if the agent is currently running for a given chatId. */
  isRunning(chatId: string): boolean {
    return this.activeRuns.has(chatId);
  }

  /** List all active run chatIds. */
  getActiveRuns(): string[] {
    return [...this.activeRuns.keys()];
  }

  async run(chatId: string, userText: string, userMedia?: MediaAttachment[], onEvent?: import('./types.js').AgentEventCallback): Promise<AgentResponse> {
    const startMs = Date.now();
    let toolCallCount = 0;
    const allMedia: MediaAttachment[] = [];

    // Abort controller for this run — checked between iterations, passed to API calls
    const ac = new AbortController();
    this.activeRuns.set(chatId, ac);

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
      // Add images as vision blocks
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
          const { messages: compactedMsgs, result } = await this.compaction.compact(chatId, storedHistory, this.model);
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
      let rawSystemPrompt = this.contextManager.getSystemPrompt(this.provider);

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
          const active = await checkCosmoActiveRun();
          if (active) {
            rawSystemPrompt += `\n\n[COSMO ACTIVE RUN]
A research run is currently in flight — do not launch another.
- runName: ${active.runName}
- topic: ${active.topic || '(unknown)'}
- started: ${active.startedAt || '(unknown)'}
- processes: ${active.processCount}
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
            const bundle = this.memory.buildRecoveryBundle();
            if (bundle) {
              rawSystemPrompt = `${rawSystemPrompt}\n\n${bundle}`;
            }
          }
        } catch {
          // Never block on memory failure
        }
      }

      const systemPrompt = this.isOAuth
        ? [
            getClaudeCodeSystemPrompt(),
            { type: 'text' as const, text: rawSystemPrompt },
          ]
        : rawSystemPrompt;

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
            provider: this.provider,
            model: this.model,
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

      // Per-run context copy — avoids race condition when concurrent runs
      // (e.g., telegram message + cron job) would overwrite each other's chatId
      const runContext: ToolContext = { ...this.toolContext, chatId, onEvent, conversationHistory: this.history };

      // Track all messages exchanged during this turn for persistence
      const turnMessages: HistoryRecord[] = [userMsg];

      // Non-Claude model — chat-only, no tools
      const isClaudeModel = this.provider === 'anthropic';

      if (!isClaudeModel) {
        try {
          if (this.provider === 'openai-codex') {
            // ── OpenAI Codex OAuth path ──
            // Uses ChatGPT OAuth credentials from ~/.evobrew/auth-profiles.json.
            // Calls https://chatgpt.com/backend-api/codex/responses (Responses API, SSE).
            // Returns respMsg in OAI Chat Completions format so the tool loop below runs unchanged.

            const creds = await getCodexCredentials();
            if (!creds) throw new Error('openai-codex credentials not found — run evobrew login');

            const sysText = typeof systemPrompt === 'string'
              ? systemPrompt
              : (systemPrompt as Array<{ text: string }>).map(b => b.text).join('\n');

            // Convert Anthropic-format history to plain OAI messages
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
                return { text: interruptText, media: allMedia.length > 0 ? allMedia : undefined, model: this.model, toolCallCount, durationMs: Date.now() - startMs };
              }

              // ── Convert apiMessages → Responses API input ──
              // apiMessages[0] is always the system message — extract as instructions, skip in input.
              const instructions = (apiMessages[0]?.content as string) ?? '';
              const inputItems: Array<Record<string, unknown>> = [];

              for (const msg of apiMessages.slice(1)) {
                const role = msg.role as string;
                const content = msg.content as string | null | undefined;
                const toolCalls = msg.tool_calls as ToolCallObj[] | undefined;

                if (role === 'user') {
                  inputItems.push({
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'input_text', text: content ?? '' }],
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
                model: this.model,
                instructions,
                input: inputItems,
                tools: codexTools.length > 0 ? codexTools : undefined,
                tool_choice: codexTools.length > 0 ? 'auto' : undefined,
                stream: true,
                store: false,
              };

              console.log(`[agent] codex request: model=${this.model}, tools=${codexTools.length}, input_items=${inputItems.length}, instructions_len=${instructions.length}`);

              const codexTimeout = 120_000;
              // AbortSignal.any is Node 20+; fall back to ac.signal if unavailable
              const fetchSignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
                ? (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([ac.signal, AbortSignal.timeout(codexTimeout)])
                : ac.signal;

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

              console.log(`[agent] codex response: content=${(respMsg.content || '').length} chars, tool_calls=${respMsg.tool_calls?.length ?? 0}, tools_sent=${codexTools.length}, model=${this.model}`);

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
                  this.memory.extractAndSave(chatId, messages, this.model).catch(() => {});
                }
                return { text: answer, media: allMedia.length > 0 ? allMedia : undefined, model: this.model, toolCallCount, durationMs: Date.now() - startMs };
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
                  const result = await this.registry.execute(tc.function.name, input, runContext);
                  if (result.media) {
                    allMedia.push(...result.media);
                    if (onEvent) for (const m of result.media) onEvent({ type: 'media', mediaType: m.type || 'image', path: m.path, caption: m.caption });
                  }
                  apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result.content.slice(0, 4000) });
                  if (onEvent) onEvent({ type: 'tool_result', tool: tc.function.name, result: result.content.slice(0, 300), success: true });
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
            return { text: capText, media: allMedia.length > 0 ? allMedia : undefined, model: this.model, toolCallCount, durationMs: Date.now() - startMs };
          } else if (this.provider === 'xai' || this.model.includes('grok')) {
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
                return { text: interruptText, media: allMedia.length > 0 ? allMedia : undefined, model: this.model, toolCallCount, durationMs: Date.now() - startMs };
              }

              const inputItems = nextInputItems ?? initialInput;

              const xaiBody = {
                model: this.model,
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
              const fetchSignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any
                ? (AbortSignal as unknown as { any: (signals: AbortSignal[]) => AbortSignal }).any([ac.signal, AbortSignal.timeout(xaiTimeout)])
                : ac.signal;

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
                        onEvent({ type: 'tool_result', tool: toolName, result: summarizeXaiServerToolResult(toolName, item ?? {}), success: true });
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

              console.log(`[agent] xai responses: content=${answerText.length} chars, tool_calls=${toolCalls.length}, tools_sent=${xaiTools.length}, model=${this.model}`);

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
                  this.memory.extractAndSave(chatId, messages, this.model).catch(() => {});
                }
                return { text: answer, media: allMedia.length > 0 ? allMedia : undefined, model: this.model, toolCallCount, durationMs: Date.now() - startMs };
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
                  const result = await this.registry.get(tc.function.name)!.execute(input, runContext);
                  if (result.media?.length) { allMedia.push(...result.media); if (onEvent) for (const m of result.media) onEvent({ type: 'media', mediaType: m.type || 'image', path: m.path, caption: m.caption }); }
                  nextInputItems.push({ type: 'function_call_output', call_id: tc.id, output: result.content.slice(0, 50_000) });
                  if (onEvent) onEvent({ type: 'tool_result', tool: tc.function.name, result: result.content.slice(0, 300), success: true });
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
            return { text: capText, media: allMedia.length > 0 ? allMedia : undefined, model: this.model, toolCallCount, durationMs: Date.now() - startMs };

          } else {
          // ── Non-Claude tool-use loop ──
          // Ollama Cloud: native /api/chat (proper tool support, configurable num_ctx)
          // OpenAI: /v1/chat/completions (standard OpenAI format)

          const isOllamaCloud = this.provider === 'ollama-cloud';

          const providerConfig: Record<string, { keyEnv: string; timeout: number }> = {
            'openai': { keyEnv: 'OPENAI_API_KEY', timeout: 60_000 },
            'ollama-cloud': { keyEnv: 'OLLAMA_CLOUD_API_KEY', timeout: 120_000 },
          };
          const pconf = providerConfig[this.provider];
          if (!pconf) throw new Error(`Unknown provider: ${this.provider}`);

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
            if (!ollamaCapabilitiesCache.has(this.model)) {
              try {
                const showRes = await fetch('https://ollama.com/api/show', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                  body: JSON.stringify({ model: this.model }),
                  signal: AbortSignal.timeout(5_000),
                });
                if (showRes.ok) {
                  const showData = await showRes.json() as { capabilities?: string[] };
                  ollamaCapabilitiesCache.set(this.model, new Set(showData.capabilities ?? []));
                }
              } catch { /* assume tools supported */ }
            }
            const caps = ollamaCapabilitiesCache.get(this.model);
            if (caps && !caps.has('tools')) {
              modelSupportsTools = false;
              console.log(`[agent] Model ${this.model} does not support tools — chat-only mode`);
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
              return { text: interruptText, media: allMedia.length > 0 ? allMedia : undefined, model: this.model, toolCallCount, durationMs: Date.now() - startMs };
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
                  model: this.model,
                  messages: apiMessages,
                  tools: oaiTools.length > 0 ? oaiTools : undefined,
                  stream: false,
                  options: { num_ctx: 32768, temperature: this.temperature },
                }),
                signal: AbortSignal.timeout(pconf.timeout),
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
              const isGpt5Plus = this.model.includes('gpt-5') || this.model.includes('gpt5');
              const tokenParam = isGpt5Plus ? { max_completion_tokens: this.maxTokens } : { max_tokens: this.maxTokens };

              const res = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify({
                  model: this.model,
                  messages: apiMessages,
                  tools: oaiTools.length > 0 ? oaiTools : undefined,
                  ...tokenParam,
                  temperature: this.temperature,
                }),
                signal: AbortSignal.timeout(pconf.timeout),
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
            console.log(`[agent] Response: content=${(respMsg.content || '').length} chars, tool_calls=${toolCalls?.length ?? 0}, tools_sent=${oaiTools.length}, model=${this.model}`);

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
                this.memory.extractAndSave(chatId, messages, this.model).catch(() => {});
              }
              return { text: answer, media: allMedia.length > 0 ? allMedia : undefined, model: this.model, toolCallCount, durationMs: Date.now() - startMs };
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
                const result = await this.registry.execute(tc.function.name, input, runContext);
                if (result.media) {
                  allMedia.push(...result.media);
                  if (onEvent) for (const m of result.media) onEvent({ type: 'media', mediaType: m.type || 'image', path: m.path, caption: m.caption });
                }
                apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result.content.slice(0, 4000) });
                if (onEvent) onEvent({ type: 'tool_result', tool: tc.function.name, result: result.content.slice(0, 300), success: true });
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
          return { text: capText, media: allMedia.length > 0 ? allMedia : undefined, model: this.model, toolCallCount, durationMs: Date.now() - startMs };
          } // end else (non-codex providers)
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          return {
            text: `Error calling ${this.model}: ${errMsg}`,
            model: this.model,
            toolCallCount: 0,
            durationMs: Date.now() - startMs,
          };
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
            model: this.model,
            toolCallCount,
            durationMs: Date.now() - startMs,
          };
        }

        let response: Anthropic.Message;
        try {
          response = await this.client.messages.create(
            {
              model: this.model,
              max_tokens: this.maxTokens,
              temperature: this.temperature,
              system: systemPrompt,
              messages: messages as Anthropic.MessageParam[],
              tools: tools as Anthropic.Tool[],
            },
            { signal: ac.signal },
          );
        } catch (err) {
          // If aborted by /stop, exit gracefully instead of throwing
          if (ac.signal.aborted) {
            const interruptText = `Stopped. (${toolCallCount} tool call${toolCallCount !== 1 ? 's' : ''}, ${((Date.now() - startMs) / 1000).toFixed(1)}s)`;
            turnMessages.push({ role: 'assistant', content: interruptText });
            this.history.append(chatId, turnMessages);
            return {
              text: interruptText,
              media: allMedia.length > 0 ? allMedia : undefined,
              model: this.model,
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
              const result = await this.registry.execute(toolCall.name, toolCall.input, runContext);

              if (result.media) {
                allMedia.push(...result.media);
                if (onEvent) {
                  for (const m of result.media) {
                    onEvent({ type: 'media', mediaType: m.type || 'image', path: m.path, caption: m.caption });
                  }
                }
              }

              const resultContent = result.content.slice(0, 4000);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolCall.id,
                content: resultContent,
                ...(result.is_error ? { is_error: true } : {}),
              });
              if (onEvent) onEvent({ type: 'tool_result', tool: toolCall.name, result: resultContent.slice(0, 300), success: !result.is_error });
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

        // ── No tool_use blocks — extract text response ──
        const textBlocks = response.content.filter(b => b.type === 'text');
        const finalText = textBlocks.map(b => (b as { text: string }).text).join('\n');
        if (onEvent && finalText) onEvent({ type: 'response_chunk', chunk: finalText });

        if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence' || finalText) {
          const assistantMsg: StoredMessage = { role: 'assistant', content: finalText || '(no response)' };
          turnMessages.push(assistantMsg);
          this.history.append(chatId, turnMessages);

          // ── Memory: Extract and save (fire-and-forget) ───
          if (messages.length > 10) {
            this.memory.extractAndSave(chatId, messages, this.model).catch(() => {});
          }

          return {
            text: finalText || '(no response)',
            media: allMedia.length > 0 ? allMedia : undefined,
            model: this.model,
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
          model: this.model,
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
        model: this.model,
        toolCallCount,
        durationMs: Date.now() - startMs,
      };
    } catch (err) {
      console.error('[agent] LOOP ERROR:', err instanceof Error ? err.message : String(err));
      if (err instanceof Error && err.stack) console.error('[agent] Stack:', err.stack);
      throw err;
    } finally {
      this.activeRuns.delete(chatId);
      if (typingInterval) clearInterval(typingInterval);
    }
  }
}
