// src/agent/compaction.ts
import Anthropic from '@anthropic-ai/sdk';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { exec } from 'node:child_process';
import type { StoredMessage, HistoryRecord } from './history.js';
import type { ConversationHistory } from './history.js';
import type { MemoryManager } from './memory.js';
import { DefaultCompactionHooks, type CompactionHooks } from './compaction-hooks.js';

export interface CompactionResult {
  compacted: boolean;
  reason: string;
  tokensBefore: number;
  tokensAfter: number;
  summary?: string;
  extractedLearnings?: boolean;
  recoveryBundle?: string | null;
}

export interface CompactionConfig {
  /** Fraction of maxChars that triggers compaction (default 0.8) */
  triggerThreshold: number;
  /** Number of recent messages to always preserve (default 10) */
  keepRecentMessages: number;
  /** Max chars for the generated summary (default 2000) */
  maxSummaryChars: number;
}

const DEFAULT_CONFIG: CompactionConfig = {
  triggerThreshold: 0.8,
  keepRecentMessages: 10,
  maxSummaryChars: 2000,
};

export class CompactionManager {
  private client: Anthropic;
  private history: ConversationHistory;
  private memory: MemoryManager;
  private config: CompactionConfig;
  private hooks: CompactionHooks;

  constructor(opts: {
    client: Anthropic;
    history: ConversationHistory;
    memory: MemoryManager;
    config?: Partial<CompactionConfig>;
    hooks?: CompactionHooks;
  }) {
    this.client = opts.client;
    this.history = opts.history;
    this.memory = opts.memory;
    this.config = { ...DEFAULT_CONFIG, ...opts.config };
    this.hooks = opts.hooks ?? new DefaultCompactionHooks();
  }

  /** Check if compaction is needed based on current history size. */
  needsCompaction(records: HistoryRecord[], maxChars: number): boolean {
    const chars = this.history.estimateChars(records);
    return chars > maxChars * this.config.triggerThreshold;
  }

  /**
   * Use LLM to summarize older messages into a condensed summary.
   */
  private async summarizeMessages(olderMessages: StoredMessage[]): Promise<string> {
    const transcript = olderMessages
      .map(m => {
        const role = m.role === 'user' ? 'Human' : 'Assistant';
        const content = typeof m.content === 'string'
          ? m.content
          : Array.isArray(m.content)
            ? (m.content as Array<{ type: string; text?: string }>)
                .filter(b => b.type === 'text' && b.text)
                .map(b => b.text)
                .join(' ')
            : '[complex content]';
        return `${role}: ${content.slice(0, 500)}`;
      })
      .join('\n\n');

    const response = await this.client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 800,
      system: 'You are a conversation summarizer. Produce a dense, factual summary that preserves: key decisions, tool actions taken, current goals, important context. No fluff. No preamble.',
      messages: [{
        role: 'user',
        content: `Summarize this conversation segment. Preserve all important context, decisions, and state. The summary will replace these messages in the conversation history.\n\n${transcript.slice(0, 12000)}`,
      }],
    });

    return response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { text: string }).text)
      .join('\n')
      .trim()
      .slice(0, this.config.maxSummaryChars);
  }

  /**
   * Run the full 3-phase compaction pipeline:
   * 1. Pre-compaction extraction (save learnings before they're lost)
   * 2. LLM summarization (replace older messages with summary)
   * 3. Rewrite history file (summary + recent messages)
   */
  async compact(
    chatId: string,
    records: HistoryRecord[],
    currentModel?: string,
  ): Promise<{ messages: StoredMessage[]; result: CompactionResult }> {
    const messages = records.filter(
      (r): r is StoredMessage => !('type' in r && r.type === 'session_boundary'),
    );

    const charsBefore = this.history.estimateChars(records);

    const keepCount = Math.min(this.config.keepRecentMessages, messages.length);
    const olderMessages = messages.slice(0, messages.length - keepCount);
    const recentMessages = messages.slice(messages.length - keepCount);

    if (olderMessages.length < 3) {
      return {
        messages,
        result: { compacted: false, reason: 'Not enough older messages', tokensBefore: charsBefore, tokensAfter: charsBefore },
      };
    }

    // Phase 1: Pre-compaction hook (save learnings before they are lost)
    const { extractedLearnings } = await this.hooks.preCompaction({
      chatId,
      olderMessages,
      currentModel,
      memory: this.memory,
    });

    // Phase 2: LLM summarization
    let summary: string;
    try {
      summary = await this.summarizeMessages(olderMessages);
    } catch (err) {
      console.warn('[compaction] Summarization failed, falling back to truncation:', err);
      const charsAfter = this.history.estimateChars(recentMessages);
      this.history.compact(chatId, recentMessages);
      const { recoveryBundle } = await this.hooks.postCompaction({
        chatId,
        olderMessages,
        recentMessages,
        compacted: true,
        currentModel,
        memory: this.memory,
      });
      return {
        messages: recentMessages,
        result: { compacted: true, reason: 'Summarization failed, fell back to truncation', tokensBefore: charsBefore, tokensAfter: charsAfter, extractedLearnings, recoveryBundle },
      };
    }

    // Phase 3: Build compacted history
    const finalMessages: StoredMessage[] = [
      { role: 'user', content: '[Session context restored after compaction]', ts: new Date().toISOString() },
      { role: 'assistant', content: `[Conversation Summary]\n${summary}`, ts: new Date().toISOString() },
    ];

    // If recent starts with assistant, insert a bridging user message
    if (recentMessages.length > 0 && recentMessages[0]!.role === 'assistant') {
      finalMessages.push({ role: 'user', content: '(continuing)', ts: new Date().toISOString() });
    }
    finalMessages.push(...recentMessages);

    this.history.compact(chatId, finalMessages);

    const { recoveryBundle } = await this.hooks.postCompaction({
      chatId,
      olderMessages,
      recentMessages,
      summary,
      compacted: true,
      currentModel,
      memory: this.memory,
    });

    const charsAfter = this.history.estimateChars(finalMessages);
    console.log(`[compaction] ${chatId}: ${charsBefore} → ${charsAfter} chars, summary ${summary.length} chars, extracted=${extractedLearnings}`);

    // Rebuild FAISS index in background if we extracted learnings
    if (extractedLearnings) {
      const scriptPath = join(process.cwd(), 'memory-pipeline', 'build_index.py');
      if (existsSync(scriptPath)) {
        exec(`OLLAMA_HOST=http://localhost:11434 python3 ${scriptPath}`, { timeout: 120_000 }, (err) => {
          if (err) console.warn('[compaction] FAISS rebuild failed:', err.message);
          else console.log('[compaction] FAISS index rebuilt');
        });
      }
    }

    return {
      messages: finalMessages,
      result: { compacted: true, reason: 'LLM summarization', tokensBefore: charsBefore, tokensAfter: charsAfter, summary, extractedLearnings, recoveryBundle },
    };
  }
}
