/**
 * COSMO Home 2.3 — MemoryManager
 *
 * Two memory systems:
 *
 * A) extractAndSave   — session end: extract structured MemoryObjects via Claude
 * B) buildRecoveryBundle — post-compaction: reinject last 24h memory into system prompt
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  readFileSync,
  appendFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import type { StoredMessage } from './history.js';

const MEMORY_DIR_NAME = 'memory';
const MAX_RECOVERY_CHARS = 2000;

// ─── MemoryManager ───────────────────────────────────────────

export class MemoryManager {
  private client: Anthropic;
  private model: string;
  private workspacePath: string;
  private memoryDir: string;

  constructor(opts: {
    client: Anthropic;
    model: string;
    workspacePath: string;
  }) {
    this.client = opts.client;
    this.model = opts.model;
    this.workspacePath = opts.workspacePath;
    this.memoryDir = join(opts.workspacePath, MEMORY_DIR_NAME);
    mkdirSync(this.memoryDir, { recursive: true });
  }

  // ── A) Extract and Save ──────────────────────────────────

  /**
   * Extract learnings from conversation history and persist.
   * Fire-and-forget — never call with await in the hot path.
   */
  async extractAndSave(
    chatId: string,
    messages: Array<{ role: string; content: unknown }>,
    currentModel?: string,
  ): Promise<void> {
    try {
      if (messages.length < 4) return; // Not enough to be worth extracting
      // Build a condensed transcript (last 30 messages max)
      const recent = messages.slice(-30);
      const transcript = recent
        .map(m => {
          const role = m.role === 'user' ? 'Human' : 'Assistant';
          const content = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? (m.content as Array<{ type: string; text?: string }>)
                  .filter(b => b.type === 'text' && b.text)
                  .map(b => b.text)
                  .join(' ')
              : String(m.content);
          return `${role}: ${content.slice(0, 500)}`;
        })
        .join('\n\n');

      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 500,
        system: `You are a memory extraction assistant for a persistent AI agent. Extract structured memory objects from conversations.

For each important item, output a JSON object on its own line with these fields:
- type: "insight" | "observation" | "correction" | "procedure" | "uncertainty_item"
- title: short title
- statement: the knowledge itself
- domain: "ops" | "project" | "personal" | "doctrine"
- before: what was true/believed before (empty string if new knowledge)
- after: what is now true
- why: why this changed or matters
- trigger_keywords: comma-separated keywords that should resurface this
- applies_to: comma-separated contexts where this applies
- priority: "high" | "medium" | "low"

Prioritize: corrections (agent was wrong about something), new conventions, topology changes, personal context shared, key decisions.
Skip: pleasantries, repetitive questions, implementation details already in code.
Output ONLY the JSON objects, one per line. No prose.`,
        messages: [
          {
            role: 'user',
            content: `Extract structured memory objects from this conversation:\n\n${transcript}`,
          },
        ],
      });

      const extracted = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('\n')
        .trim();

      if (!extracted) return;

      // Parse structured output into MemoryObjects
      const lines = extracted.split('\n').filter(l => l.trim().startsWith('{'));

      if (lines.length === 0) {
        // Fallback: write raw extraction to daily file (backwards compat)
        const dateStr = new Date().toISOString().split('T')[0]!;
        const timeStr = new Date().toLocaleTimeString('en-US', {
          timeZone: 'America/New_York',
          hour: '2-digit',
          minute: '2-digit',
        });
        const dailyPath = join(this.memoryDir, `${dateStr}.md`);
        const dailyEntry = `\n## Session ${timeStr} ET — chat:${chatId}\n\n${extracted}\n`;
        appendFileSync(dailyPath, dailyEntry, 'utf-8');
        return;
      }

      // Create MemoryObjects from parsed lines
      try {
        const { MemoryObjectStore } = await import('./memory-objects.js');
        const brainDir = join(this.workspacePath, '..', 'brain');
        const store = new MemoryObjectStore(brainDir);

        // Get existing objects for dedup
        const existingTitles = new Set(
          store.getObjectsByLayer('working')
            .concat(store.getObjectsByLayer('durable'))
            .map(o => o.title.toLowerCase())
        );

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as {
              type: string; title: string; statement: string; domain: string;
              before: string; after: string; why: string;
              trigger_keywords: string; applies_to: string; priority: string;
            };

            // Dedup: skip if title already exists as a memory object
            if (existingTitles.has(parsed.title.toLowerCase())) {
              console.log(`[memory] Skipping duplicate extraction: "${parsed.title}"`);
              continue;
            }
            existingTitles.add(parsed.title.toLowerCase());

            // Find or create thread
            const threads = store.getOpenThreads();
            let thread = threads.find(t =>
              t.context_boundaries.applies_to.some(a =>
                parsed.applies_to.split(',').map(s => s.trim()).includes(a)
              )
            );

            if (!thread) {
              thread = store.createThread({
                title: `${parsed.domain} — ${parsed.title}`,
                question: `What should be known about ${parsed.title}?`,
                objective: parsed.statement.slice(0, 100),
                level: 'immediate',
                status: 'open',
                priority: parsed.priority === 'high' ? 'high' : 'medium',
                owner: 'extraction',
                child_threads: [],
                current_state_summary: parsed.statement,
                success_criteria: [],
                related_threads: [],
                context_boundaries: {
                  applies_to: parsed.applies_to.split(',').map(s => s.trim()),
                  does_not_apply_to: [],
                },
              });
            }

            const deltaClass = parsed.type === 'correction' ? 'belief_change'
              : parsed.type === 'uncertainty_item' ? 'uncertainty_change'
              : parsed.type === 'procedure' ? 'action_change'
              : 'belief_change';

            store.createObject({
              type: parsed.type as any,
              thread_id: thread.thread_id,
              session_id: chatId,
              lifecycle_layer: 'working',
              status: 'candidate',
              title: parsed.title,
              statement: parsed.statement,
              actor: 'extraction',
              provenance: {
                source_refs: [],
                session_refs: [chatId],
                generation_method: 'conversation',
              },
              evidence: {
                evidence_links: [],
                grounding_strength: 'medium',
                grounding_note: 'Extracted from conversation by Haiku',
              },
              confidence: {
                score: 0.75,
                basis: 'Conversation extraction',
              },
              state_delta: {
                delta_class: deltaClass,
                before: { state: parsed.before || '(unknown prior state)' },
                after: { state: parsed.after },
                why: parsed.why,
              },
              triggers: parsed.trigger_keywords.split(',').map(kw => ({
                trigger_type: 'keyword',
                condition: kw.trim(),
              })).filter(t => t.condition),
              scope: {
                applies_to: parsed.applies_to.split(',').map(s => s.trim()),
                excludes: [],
              },
              review_state: 'unreviewed',
              staleness_policy: {
                review_after_days: 30,
              },
            });

            console.log(`[memory] Extracted MemoryObject: "${parsed.title}" (${parsed.type})`);
          } catch (parseErr) {
            // Skip malformed lines
            console.warn('[memory] Failed to parse extraction line:', line.slice(0, 80));
          }
        }
      } catch (storeErr) {
        console.warn('[memory] Failed to create MemoryObjects from extraction:', storeErr);
      }

      console.log(`[memory] Extracted and saved session memory for ${chatId}`);
    } catch (err) {
      // Never crash — memory extraction is best-effort
      console.warn('[memory] extractAndSave failed:', err instanceof Error ? err.message : err);
    }
  }

  /**
   * Extract structured learnings from messages about to be compacted.
   * Called BEFORE compaction so nothing is lost.
   */
  async preCompactionExtract(
    chatId: string,
    messages: StoredMessage[],
    currentModel?: string,
  ): Promise<string | null> {
    try {
      if (messages.length < 3) return null;
      if (!(currentModel ?? this.model).includes('claude')) return null;

      const transcript = messages
        .map(m => {
          const role = m.role === 'user' ? 'Human' : 'Assistant';
          const content = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? (m.content as Array<{ type: string; text?: string }>)
                  .filter(b => b.type === 'text' && b.text)
                  .map(b => b.text)
                  .join(' ')
              : String(m.content);
          return `${role}: ${content.slice(0, 300)}`;
        })
        .join('\n');

      const response = await this.client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 600,
        system: 'Extract structured learnings from this conversation segment. Be terse. Bullet points only.',
        messages: [{
          role: 'user',
          content: `Extract learnings from this conversation in these 5 categories:\n\n1. DECISIONS MADE\n2. WHAT WORKED\n3. WHAT FAILED/BLOCKED\n4. FACTS LEARNED\n5. OPEN QUESTIONS\n\nSkip any category with nothing notable. Be concise.\n\n${transcript}`,
        }],
      });

      const extracted = response.content
        .filter(b => b.type === 'text')
        .map(b => (b as { text: string }).text)
        .join('\n')
        .trim();

      if (!extracted) return null;

      // Save to daily memory file
      const dateStr = new Date().toISOString().split('T')[0]!;
      const timeStr = new Date().toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit',
        minute: '2-digit',
      });
      const dailyPath = join(this.memoryDir, `${dateStr}.md`);
      const entry = `\n## Pre-Compaction Extract ${timeStr} ET — chat:${chatId}\n\n${extracted}\n`;
      appendFileSync(dailyPath, entry, 'utf-8');

      console.log(`[memory] Pre-compaction extraction for ${chatId}: ${extracted.length} chars`);
      return extracted;
    } catch (err) {
      console.warn('[memory] preCompactionExtract failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

  // ── B) Recovery Bundle ───────────────────────────────────

  /**
   * Build a recovery bundle from recent memory files.
   * Called after compaction to restore context.
   */
  buildRecoveryBundle(): string | null {
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000; // 24 hours ago

      const files = readdirSync(this.memoryDir)
        .filter(f => f.endsWith('.md') && /^\d{4}-\d{2}-\d{2}/.test(f))
        .map(f => join(this.memoryDir, f))
        .filter(f => {
          try {
            return statSync(f).mtime.getTime() > cutoff;
          } catch {
            return false;
          }
        })
        .sort((a, b) => statSync(b).mtime.getTime() - statSync(a).mtime.getTime())
        .slice(0, 3); // Max 3 files

      if (files.length === 0) return null;

      const chunks: string[] = [];
      let totalChars = 0;

      for (const file of files) {
        const content = readFileSync(file, 'utf-8').trim();
        const filename = file.split('/').pop()!;
        const entry = `**${filename}:**\n${content}`;
        if (totalChars + entry.length > MAX_RECOVERY_CHARS) {
          // Truncate this entry to fit
          const remaining = MAX_RECOVERY_CHARS - totalChars;
          if (remaining > 100) {
            chunks.push(entry.slice(0, remaining) + '\n...(truncated)');
          }
          break;
        }
        chunks.push(entry);
        totalChars += entry.length;
      }

      if (chunks.length === 0) return null;

      return `## Memory Recovery Bundle\n*Recent session context restored after compaction*\n\n${chunks.join('\n\n---\n\n')}\n\n---`;
    } catch (err) {
      console.warn('[memory] buildRecoveryBundle failed:', err instanceof Error ? err.message : err);
      return null;
    }
  }

}
