/**
 * COSMO Home 2.3 — Agent Types
 *
 * Core types for the agentic tool-use loop.
 */

import type { MediaAttachment } from '../types.js';
import type { CronScheduler } from '../scheduler/cron.js';
import type { TTSService } from '../observability/tts.js';
import type { BrowserController } from '../browser/cdp.js';

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
}

// ─── Tool Context ───────────────────────────────────────────

export interface SubAgentTracker {
  active: number;
  maxConcurrent: number;
  queue: Array<{ task: string; chatId: string; resolve: () => void }>;
}

export interface ToolContext {
  scheduler: CronScheduler | null;
  ttsService: TTSService | null;
  browser: BrowserController | null;
  projectRoot: string;
  enginePort: number;
  workspacePath: string;
  tempDir: string;
  contextManager: ContextManagerRef;
  subAgentTracker: SubAgentTracker;
  chatId: string;
  telegramAdapter: TelegramAdapterRef | null;
  runAgentLoop: AgentLoopRunner | null;
  onEvent?: AgentEventCallback;
  conversationHistory?: { append(chatId: string, records: unknown[]): void };
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
  | { type: 'tool_result'; tool: string; result: string; success: boolean }
  | { type: 'response_chunk'; chunk: string }
  | { type: 'media'; mediaType: string; path: string; caption?: string }
  | { type: 'subagent_result'; task: string; result: string };

export type AgentEventCallback = (event: AgentEvent) => void;

// ─── Agent Response ─────────────────────────────────────────

export interface AgentResponse {
  text: string;
  media?: MediaAttachment[];
  model: string;
  toolCallCount: number;
  durationMs: number;
}
