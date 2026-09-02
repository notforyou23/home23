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
import type { RelationshipLedger } from './relationship-ledger.js';
import type { MemoryObjectStore } from './memory-objects.js';
import type { ModelAliases } from './model-resolution.js';
import type { ReasoningEffort } from './reasoning-effort.js';
import type { AsyncWorkRecord } from '../work/types.js';
import type { WorkCancelOutcome } from '../work/cancel.js';
import type {
  BridgeEvent,
  CodingIsolation,
  CodingJobReceipt,
  CodingJobRecord,
  CodingJobStatus,
} from '../acp/types.js';
import type { ToolRegistry } from './tools/index.js';

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

export type SubAgentExecutionMode = 'joined' | 'detached';

export interface TurnRuntimeContext {
  turnId: string;
  abortController: AbortController;
  signal: AbortSignal;
  brainOperations: BrainOperationsClient;
  onOperationActivity: (activity: OperationActivity) => void;
  /** Immutable per-turn registry override. Absent means the loop's shared registry. */
  registry?: ToolRegistry;
}

/** Privacy-safe provenance for a turn leased from the coordination plane. */
export interface CoordinationTurnOrigin {
  kind: 'coordination';
  workId: string;
  attemptId: string;
  leaseId: string;
  holderPrincipalId: string;
  holderInstanceId: string;
  authorityReference: string;
  fencingToken: number;
  channelId: string;
  originMessageId: string | null;
  roundId: string | null;
}

export interface DurableTurnStart {
  turnId: string;
  chatId: string;
  persistedAt: string;
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
  /** Configured short names accepted by model-selecting tools. */
  modelAliases?: ModelAliases;
  chatId: string;
  /** Actual channel/user turn data, set by the loop rather than tool input. */
  authenticatedUserMessage?: {
    chatId: string;
    messageRef: string;
    text: string;
  };
  /** Loop-owned store whose correction validator is bound to active recorded turns. */
  memoryObjectStore?: MemoryObjectStore;
  /** Loop-owned curated working-relationship ledger (Step 30, Piece 2). */
  relationshipLedger?: RelationshipLedger | null;
  telegramAdapter: TelegramAdapterRef | null;
  codingBridge?: CodingBridgeRef | null;
  workRegistry?: WorkRegistryRef | null;
  /** In-process cancellation plumbing shared with /api/work; never HTTP/shell. */
  requestWorkCancel?: (workId: string) => WorkCancelOutcome;
  /** Set when this context belongs to work spawned by another work item (nesting). */
  parentWorkId?: string;
  /** Terminal async-work hook installed by home.ts — runs the completion pipeline. */
  onWorkTerminal?: (workId: string, resultText: string) => void;
  runAgentLoop: AgentLoopRunner | null;
  workerConnectorBaseUrl?: string;
  fetch?: typeof fetch;
  onEvent?: AgentEventCallback;
  /** Stable parent tool-call identity for nested runtime activity. */
  parentToolCallId?: string;
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
    /** Companion Layer (Step 30) inspection fields — omission is now visible. */
    layer?: string;            // one of the six IdentityLayer names
    rawBytes?: number;         // size of the file on disk (trimmed)
    includedBytes?: number;    // size of the retained content actually injected
    budget?: number;           // the char budget applied
    truncated?: boolean;       // whether any section was dropped / boundary-cut
    omittedSections?: string[];// heading titles of dropped sections
  }>;
  /** Total system-prompt size and how it split across the cache boundary. */
  systemPromptBytes?: number;
  /** True when at least one identity file was truncated to fit its budget. */
  anyTruncated?: boolean;
}

export interface ContextManagerRef {
  getSystemPrompt(): string;
  getPromptSourceInfo(): PromptSourceInfo;
  invalidate(): void;
}

/** Minimal interface to the async-work registry (Step 31) — avoids importing the full class */
export interface WorkRegistryRef {
  create(input: {
    kind: 'coding' | 'subagent' | 'cron';
    originChatId: string;
    originTurnId?: string;
    parentWorkId?: string;
    label: string;
    resultHandle:
      | { type: 'coding_job'; jobId: string }
      | { type: 'subagent_chat'; chatId: string }
      | { type: 'cron_chat'; chatId: string };
  }): { workId: string; originChatId: string };
  get(workId: string): AsyncWorkRecord | undefined;
  list(filter?: { originChatId?: string; active?: boolean; limit?: number }): AsyncWorkRecord[];
  complete(workId: string, status: 'completed' | 'failed' | 'cancelled' | 'interrupted', error?: string): unknown;
}

/** Minimal interface to the ACP coding bridge — avoids importing the full class */
export interface CodingBridgeRef {
  startJob(opts: {
    prompt: string;
    backend?: string;
    cwd?: string;
    label?: string;
    model?: string;
    effort?: string;
    isolation?: CodingIsolation;
    resumeSessionId?: string;
    resumedFromJobId?: string;
    appendSystemPrompt?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    addDirs?: string[];
    maxBudgetUsd?: number;
    requestedBy?: string;
  }): Promise<CodingJobRecord>;
  getJob(id: string): CodingJobRecord | undefined;
  listJobs(filter?: { status?: CodingJobStatus; limit?: number }): CodingJobRecord[];
  getReceipt(id: string): CodingJobReceipt | undefined;
  readEventsTail(id: string, maxEvents?: number): BridgeEvent[];
  cancelJob(id: string): Promise<CodingJobRecord>;
  waitForJob(id: string, timeoutMs: number): Promise<CodingJobRecord>;
  listBackends(): Array<{ id: string; available: boolean; bin: string | null; defaultModel?: string }>;
}

/** Minimal interface for TelegramAdapter — avoids importing the full class */
export interface TelegramAdapterRef {
  sendTyping(chatId: string): Promise<void>;
  sendPhoto(chatId: string, filePath: string, caption?: string): Promise<void>;
  sendVoice(chatId: string, filePath: string): Promise<void>;
  sendDocument(chatId: string, filePath: string, caption?: string): Promise<void>;
  sendText?(chatId: string, text: string): Promise<void>;
}

/** Function signature for spawning sub-agent loops */
export type AgentLoopRunner = (
  systemPrompt: string,
  userMessage: string,
  tools: ToolDefinition[],
  ctx: ToolContext,
  options?: {
    modelOverride?: { model: string; provider?: string; reasoningEffort?: ReasoningEffort };
    effort?: ReasoningEffort;
    registry?: ToolRegistry;
  },
) => Promise<AgentResponse>;

// ─── Agent Events (streaming) ───────────────────────────────

export type ReasoningProvenance =
  | 'provider_verbatim_reasoning'
  | 'provider_reasoning_summary'
  | 'agent_authored_explanation';

export type AgentEvent =
  | { type: 'thinking'; content: string; provenance: ReasoningProvenance;
      sourceEventType: string; providerEvent?: unknown }
  | { type: 'tool_start'; tool: string; args: unknown; toolCallId: string;
      parentActivityId?: string; sourceEventType?: string; providerEvent?: unknown }
  | { type: 'tool_result'; tool: string; result: string; success: boolean;
      toolCallId: string; exactResult?: string; resultHandle?: string;
      toolMetadata?: BrainToolEventMetadata; sourceEventType?: string; providerEvent?: unknown }
  | { type: 'response_chunk'; chunk: string; sourceEventType?: string;
      providerEvent?: unknown }
  | { type: 'media'; mediaType: string; path: string; caption?: string;
      generatedBy?: 'generate_image';
      mimeType?: string; fileName?: string; byteCount?: number; sha256?: string;
      toolCallId?: string; sourceEventType?: string }
  | { type: 'subagent_start'; subagentId: string; task: string;
      parentToolCallId?: string; label?: string; sourceEventType?: string }
  | { type: 'subagent_result'; subagentId: string; task: string; result: string;
      success: boolean; parentToolCallId?: string; sourceEventType?: string }
  | { type: 'cache'; read: number; write: number; input: number; output: number;
      sourceEventType?: string }
  | { type: 'status'; status: string; message?: string;
      activity_deadline_at?: string; hard_deadline_at?: string; sourceEventType?: string };

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
