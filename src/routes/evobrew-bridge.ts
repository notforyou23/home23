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

export interface BridgeConfig {
  agent: AgentLoop;
  token: string;
  agentName: string;
}

function writeSse(res: Response, data: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Build IDE context block from evobrew's system prompt and request metadata.
 * Gives the agent awareness of what the user is looking at in the IDE.
 */
function buildIdeContext(body: Record<string, unknown>): string {
  const parts: string[] = [];

  // Extract structured fields if present
  const systemPrompt = body.systemPrompt as string || '';

  // Parse key context from evobrew's system prompt
  const folderMatch = systemPrompt.match(/\*\*Folder\*\*:\s*(.+)/);
  const fileMatch = systemPrompt.match(/\*\*Open File\*\*:\s*(.+)/);
  const brainMatch = systemPrompt.match(/\*\*Brain\*\*:\s*(.+)/);

  if (folderMatch?.[1]) parts.push(`Working directory: ${folderMatch[1].trim()}`);
  if (fileMatch?.[1]) parts.push(`Open file: ${fileMatch[1].trim()}`);
  if (brainMatch?.[1]) parts.push(`Connected brain: ${brainMatch[1].trim()}`);

  // Extract document content if embedded in the system prompt
  const docStart = systemPrompt.indexOf('**Document Content');
  if (docStart > -1) {
    const docSection = systemPrompt.slice(docStart, docStart + 2000);
    parts.push(docSection);
  }

  // Extract file tree context if present
  const treeStart = systemPrompt.indexOf('**File Tree');
  if (treeStart > -1) {
    const treeSection = systemPrompt.slice(treeStart, treeStart + 1000);
    parts.push(treeSection);
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
      const result = await config.agent.run(chatId, enrichedMessage, undefined, onEvent);

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

export function createHealthHandler(config: { agentName: string }) {
  return (_req: Request, res: Response): void => {
    res.json({ status: 'ok', agent: config.agentName, type: 'cosmohome', endpoint: '/api/chat' });
  };
}
