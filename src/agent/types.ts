/**
 * COSMO Home 2.3 — Agent Types
 *
 * Core types for the agentic tool-use loop.
 */

import type { MediaAttachment } from '../types.js';
import type { CronScheduler } from '../scheduler/cron.js';
import type { TTSService } from '../observability/tts.js';
import type { BrowserController } from '../browser/cdp.js';
import type { BrainOperationsClient } from './brain-operations/client.js';
import type { OperationActivity } from './brain-operations/types.js';
import type { MemoryObjectStore } from './memory-objects.js';

// ─── Tool Types ─────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  content: string;
  media?: MediaAttachment[];
  is_error?: boolean;
  resultHandle?: string;
  metadata?: Record<string, unknown>;
}

// ─── Tool Context ───────────────────────────────────────────

export interface SubAgentTracker {
  active: number;
  maxConcurrent: number;
  queue: Array<{ task: string; chatId: string; resolve: () => void }>;
}

export interface TurnRuntimeContext {
  turnId: string;
  abortController: AbortController;
  signal: AbortSignal;
  brainOperations: BrainOperationsClient;
  onOperationActivity: (activity: OperationActivity) => void;
}

export interface ToolContext {
  scheduler: CronScheduler | null;
  ttsService: TTSService | null;
  browser: BrowserController | null;
  projectRoot: string;
  enginePort: number;
  agentName: string;                  // HOME23_AGENT
  cosmo23BaseUrl: string;             // http://localhost:43210
  brainRoute: string | null;          // ${cosmo23BaseUrl}/api/brain/<brainId>; null if unresolved
  workspacePath: string;
  tempDir: string;
  contextManager: ContextManagerRef;
  subAgentTracker: SubAgentTracker;
  chatId: string;
  /** Actual channel/user turn data, set by the loop rather than tool input. */
  authenticatedUserMessage?: {
    chatId: string;
    messageRef: string;
    text: string;
  };
  /** Loop-owned store whose correction validator is bound to active recorded turns. */
  memoryObjectStore?: MemoryObjectStore;
  telegramAdapter: TelegramAdapterRef | null;
  runAgentLoop: AgentLoopRunner | null;
  workerConnectorBaseUrl?: string;
  fetch?: typeof fetch;
  onEvent?: AgentEventCallback;
  conversationHistory?: { append(chatId: string, records: unknown[]): void };
  abortSignal?: AbortSignal;
  brainOperations: BrainOperationsClient;
  onOperationActivity?: (activity: OperationActivity) => void;
  turnRuntime: TurnRuntimeContext | null;
}

/** Minimal interface to avoid circular deps — implemented by ContextManager */
export interface PromptSourceInfo {
  generatedAt: string;
  totalSections: number;
  loadedFiles: Array<{
    layerIndex: number;
    basePath: string;
    filename: string;
    filePath: string;
    label: string;
    exists: boolean;
    included: boolean;
  }>;
}

export interface ContextManagerRef {
  getSystemPrompt(): string;
  getPromptSourceInfo(): PromptSourceInfo;
  invalidate(): void;
}

/** Minimal interface for TelegramAdapter — avoids importing the full class */
export interface TelegramAdapterRef {
  sendTyping(chatId: string): Promise<void>;
  sendPhoto(chatId: string, filePath: string, caption?: string): Promise<void>;
  sendVoice(chatId: string, filePath: string): Promise<void>;
  sendDocument(chatId: string, filePath: string, caption?: string): Promise<void>;
}

/** Function signature for spawning sub-agent loops */
export type AgentLoopRunner = (
  systemPrompt: string,
  userMessage: string,
  tools: ToolDefinition[],
  ctx: ToolContext,
) => Promise<AgentResponse>;

// ─── Agent Events (streaming) ───────────────────────────────

export type AgentEvent =
  | { type: 'thinking'; content: string }
  | { type: 'tool_start'; tool: string; args: unknown }
  | { type: 'tool_result'; tool: string; result: string; success: boolean;
      resultHandle?: string; toolMetadata?: BrainToolEventMetadata }
  | { type: 'response_chunk'; chunk: string }
  | { type: 'media'; mediaType: string; path: string; caption?: string }
  | { type: 'subagent_result'; task: string; result: string }
  | { type: 'cache'; read: number; write: number; input: number; output: number }
  | { type: 'status'; status: string; message?: string;
      activity_deadline_at?: string; hard_deadline_at?: string };

export type AgentEventCallback = (event: AgentEvent) => void;

export interface BrainToolEventMetadata {
  operationId: string;
  operationType?: string;
  state: 'queued' | 'running' | 'complete' | 'partial'
    | 'failed' | 'cancelled' | 'interrupted';
  attachmentState?: 'attached' | 'detached' | 'closed';
  classification?: string;
  error?: { code: string; message: string; retryable: boolean };
  pgs?: Record<string, string | number | boolean | null>;
  sourceEvidence?: Record<string, unknown>;
}

// ─── Agent Response ─────────────────────────────────────────

export interface AgentResponse {
  text: string;
  media?: MediaAttachment[];
  model: string;
  toolCallCount: number;
  durationMs: number;
}
