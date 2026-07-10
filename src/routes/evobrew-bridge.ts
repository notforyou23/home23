/**
 * Evobrew Bridge — routes messages to the agent's own loop.
 *
 * The agent runs with its full identity (SOUL, MISSION, MEMORY),
 * conversation history, and tools. Evobrew is just a chat window.
 * Same pattern as OpenClaw — the agent IS the agent.
 *
 * IDE context (current folder, open file, brain status) is passed
 * alongside the user message so the agent knows the user's workspace state.
 */

import type { Request, Response } from 'express';
import type { AgentLoop } from '../agent/loop.js';
import { executeTrackedTurn } from '../agent/turn-entrypoint.js';

export interface BridgeConfig {
  agent: AgentLoop;
  token: string;
  agentName: string;
}

function writeSse(res: Response, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n[...truncated...]`;
}

function extractPromptLine(systemPrompt: string, labels: string[]): string {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = systemPrompt.match(new RegExp(`\\*\\*${escaped}\\*\\*:\\s*([^\\n]+)`));
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function extractPromptSection(systemPrompt: string, heading: string, limit: number): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = systemPrompt.match(new RegExp(`## ${escaped}\\s*\\n([\\s\\S]*?)(?:\\n## |\\n════════|$)`));
  return match?.[1] ? clip(match[1].trim(), limit) : '';
}

function buildStructuredContextParts(context: Record<string, unknown>): string[] {
  const parts: string[] = [];

  const currentFolder = cleanString(context.currentFolder);
  const fileName = cleanString(context.fileName);
  const language = cleanString(context.language);
  const selectedText = cleanString(context.selectedText);
  const documentContent = cleanString(context.documentContent);
  const fileTreeContext = cleanString(context.fileTreeContext);
  const conversationSummary = cleanString(context.conversationSummary);
  const brain = asRecord(context.brain);

  if (currentFolder) parts.push(`Working directory: ${currentFolder}`);
  if (fileName) parts.push(`Open file: ${fileName}`);
  if (language) parts.push(`Language: ${language}`);

  if (brain) {
    const brainEnabled = brain.enabled !== false;
    const brainName = cleanString(brain.name);
    const brainPath = cleanString(brain.path);
    const brainNodes = typeof brain.nodes === 'number' ? ` (${brain.nodes} nodes${brainPath ? `, path: ${brainPath}` : ''})` : brainPath ? ` (path: ${brainPath})` : '';
    if (brainEnabled && (brainName || brainPath)) {
      parts.push(`Connected brain: ${brainName || brainPath}${brainNodes}`);
    }
  }

  if (conversationSummary) {
    parts.push(`Conversation summary:\n${clip(conversationSummary, 1200)}`);
  }

  const recentMessages = Array.isArray(context.recentMessages) ? context.recentMessages : [];
  if (recentMessages.length > 0) {
    const rendered = recentMessages
      .map((msg) => {
        const record = asRecord(msg);
        const role = cleanString(record?.role);
        const content = cleanString(record?.content);
        return role && content ? `${role}: ${clip(content, 600)}` : '';
      })
      .filter(Boolean)
      .join('\n');
    if (rendered) parts.push(`Recent Evobrew conversation:\n${clip(rendered, 1800)}`);
  }

  if (selectedText) {
    parts.push(`Selected text:\n${clip(selectedText, 2000)}`);
  } else if (documentContent) {
    parts.push(`Current document:\n${clip(documentContent, 2000)}`);
  }

  if (fileTreeContext) {
    parts.push(`File tree:\n${clip(fileTreeContext, 1200)}`);
  }

  return parts;
}

function buildPromptFallbackParts(systemPrompt: string): string[] {
  const parts: string[] = [];

  const folder = extractPromptLine(systemPrompt, ['Folder']);
  const file = extractPromptLine(systemPrompt, ['Open File', 'File']);
  const language = extractPromptLine(systemPrompt, ['Language']);
  const brain = extractPromptLine(systemPrompt, ['Brain']);
  const projectStructure = extractPromptSection(systemPrompt, 'Project Structure', 1200);

  if (folder) parts.push(`Working directory: ${folder}`);
  if (file && file !== 'untitled') parts.push(`Open file: ${file}`);
  if (language && language !== 'text') parts.push(`Language: ${language}`);
  if (brain) parts.push(`Connected brain: ${brain}`);
  if (projectStructure) parts.push(`Project structure:\n${projectStructure}`);

  return parts;
}

/**
 * Build IDE context block from evobrew's system prompt and request metadata.
 * Gives the agent awareness of what the user is looking at in the IDE.
 */
function buildIdeContext(body: Record<string, unknown>): string {
  const structured = asRecord(body.context);
  const parts = structured ? buildStructuredContextParts(structured) : [];
  const systemPrompt = body.systemPrompt as string || '';

  if (parts.length === 0 && systemPrompt) {
    parts.push(...buildPromptFallbackParts(systemPrompt));
  }

  if (parts.length === 0) return '';
  return `[Evobrew IDE Context]\n${parts.join('\n')}\n---\n`;
}

export function createEvobrewChatHandler(config: BridgeConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    // Auth (skip if no token configured)
    if (config.token) {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${config.token}`) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
    }

    const body = req.body ?? {};
    const { messages, message } = body;

    // Extract the user message — either a plain string or last user message from array
    let userText = '';
    if (typeof message === 'string') {
      userText = message;
    } else if (Array.isArray(messages)) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role === 'user') {
          userText = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
              : '';
          break;
        }
      }
    }

    if (!userText) {
      res.status(400).json({ error: 'No user message found' });
      return;
    }

    // Prepend IDE context so the agent knows what the user is looking at
    const ideContext = buildIdeContext(body);
    const enrichedMessage = ideContext ? `${ideContext}${userText}` : userText;

    // Use provided chatId (dashboard conversations) or default for evobrew
    const chatId = (body.chatId as string) || `evobrew:${config.agentName}`;

    console.log(`[evobrew-bridge] ${config.agentName}: "${userText.substring(0, 60)}..." ${ideContext ? '(+IDE context)' : ''}`);

    // SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    try {
      // Stream events live as the agent works
      const onEvent = (event: { type: string; [key: string]: unknown }) => {
        writeSse(res, event);
      };

      // Run the full agent loop — identity, memory, history, tools, everything
      const { response: result } = await executeTrackedTurn(
        config.agent,
        chatId,
        enrichedMessage,
        { onEvent },
      );

      const text = result.text || '';

      writeSse(res, { type: 'done', stopReason: 'end_turn' });
      res.write('data: [DONE]\n\n');

      console.log(`[evobrew-bridge] ${config.agentName}: ${text.length} chars, ${result.toolCallCount} tools, ${result.durationMs}ms`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[evobrew-bridge] ${config.agentName} error:`, message);
      writeSse(res, { type: 'done', stopReason: 'error', error: message });
      res.write('data: [DONE]\n\n');
    }

    res.end();
  };
}

export function createStopHandler(config: BridgeConfig) {
  return (req: Request, res: Response): void => {
    const chatId = req.body?.chatId;
    const result = config.agent.stop(chatId || undefined);
    console.log(`[evobrew-bridge] Stop requested: chatId=${chatId || 'all'}, stopped=${result.stopped}`);
    res.json(result);
  };
}

export function createHealthHandler(config: { agentName: string; agent?: AgentLoop }) {
  return (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      agent: config.agentName,
      type: 'cosmohome',
      endpoint: '/api/chat',
      model: config.agent?.getModel?.() || null,
      provider: config.agent?.getProvider?.() || null,
    });
  };
}
