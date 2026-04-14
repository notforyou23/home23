/**
 * Cycle Tools — inline tools for cognitive cycles (quantum reasoner)
 *
 * Exposes a curated, read-heavy slice of MCPBridge methods plus surface-reading
 * capability so cognitive cycles can pull real data mid-thought instead of being
 * limited to pre-queried memory context.
 *
 * Each tool is defined in Anthropic's format: { name, description, input_schema }.
 * The executor routes tool_use blocks to the right MCPBridge method or filesystem op.
 *
 * No hard call limit — if cycles start looping, we'll tighten policy.
 */

const fs = require('fs');
const path = require('path');

// Domain surfaces that cycles can read to ground their thinking in jtr's world
const READABLE_SURFACES = [
  'TOPOLOGY.md',
  'PROJECTS.md',
  'PERSONAL.md',
  'DOCTRINE.md',
  'RECENT.md',
  'BRAIN_INDEX.md',
  'SOUL.md',
  'MISSION.md',
  'COZ.md',
  'HEARTBEAT.md',
];

/**
 * Build the Anthropic-format tool definitions that cycles can call.
 * These are passed as the `tools` parameter when generating thoughts.
 */
function buildCycleTools() {
  return [
    {
      name: 'read_surface',
      description:
        "Read a domain surface file from jtr's workspace. Use this to ground " +
        "your thinking in what's actually true about jtr's projects, context, " +
        'or recent events — instead of relying on cached memory. Available: ' +
        READABLE_SURFACES.join(', '),
      input_schema: {
        type: 'object',
        properties: {
          surface: {
            type: 'string',
            description: 'Surface filename (e.g. TOPOLOGY.md, PROJECTS.md, PERSONAL.md, RECENT.md)',
          },
        },
        required: ['surface'],
      },
    },
    {
      name: 'query_brain',
      description:
        'Search the brain memory for concepts matching a query. Returns up to 10 ' +
        'relevant memory nodes ranked by relevance. Use when you need specific ' +
        'knowledge beyond what\'s already in your memory context.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for' },
          limit: { type: 'integer', description: 'Max results (default 10, max 20)', default: 10 },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_recent_thoughts',
      description:
        "Read the agent's own recent thoughts (up to 20). Use sparingly — " +
        'most recent context is already injected. Useful for tracking themes ' +
        'across recent cycles or referencing a specific prior insight.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'How many recent thoughts to fetch (max 30)', default: 10 },
        },
      },
    },
    {
      name: 'get_active_goals',
      description:
        "View jtr's active goals that the agent is pursuing. Useful for " +
        'grounding proposed actions in what the agent is already working on.',
      input_schema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max goals (default 15)', default: 15 },
        },
      },
    },
    {
      name: 'get_pending_notifications',
      description:
        'Read the current queue of pending notifications the agent has raised ' +
        'for jtr. Useful to avoid duplicating notifications or to see what the ' +
        'agent has already flagged.',
      input_schema: { type: 'object', properties: {} },
    },
  ];
}

/**
 * Build an executor function that runs a tool call against the engine's
 * MCPBridge and workspace. Returns stringified JSON result (what the LLM sees).
 *
 * @param {Object} ctx
 * @param {Object} ctx.mcpBridge - MCPBridge instance with methods like query_memory, get_recent_thoughts
 * @param {string} ctx.workspacePath - Absolute path to agent workspace (for surface reads)
 * @param {string} ctx.brainDir - Absolute path to agent brain dir (for notifications)
 * @param {Object} ctx.logger
 */
function buildCycleToolExecutor(ctx) {
  const { mcpBridge, workspacePath, brainDir, logger } = ctx;

  return async function execute(toolName, toolInput) {
    logger?.info?.('🛠 Cycle tool call', {
      tool: toolName,
      input: JSON.stringify(toolInput || {}).substring(0, 200),
    });

    try {
      switch (toolName) {
        case 'read_surface': {
          const surface = String(toolInput?.surface || '').trim();
          if (!READABLE_SURFACES.includes(surface)) {
            return {
              error: `Unknown surface: ${surface}`,
              available: READABLE_SURFACES,
            };
          }
          if (!workspacePath) {
            return { error: 'Workspace path not configured' };
          }
          const full = path.join(workspacePath, surface);
          if (!fs.existsSync(full)) {
            return { surface, exists: false, content: null };
          }
          // Cap at 10KB to avoid blowing context
          const raw = fs.readFileSync(full, 'utf-8');
          const truncated = raw.length > 10000;
          return {
            surface,
            exists: true,
            length: raw.length,
            truncated,
            content: truncated ? raw.substring(0, 10000) + '\n...[truncated]' : raw,
          };
        }

        case 'query_brain': {
          if (!mcpBridge?.query_memory) {
            return { error: 'Memory query unavailable (no MCP bridge)' };
          }
          const query = String(toolInput?.query || '').trim();
          const limit = Math.min(Number(toolInput?.limit) || 10, 20);
          if (!query) return { error: 'query is required' };
          return await mcpBridge.query_memory(query, limit);
        }

        case 'get_recent_thoughts': {
          if (!mcpBridge?.get_recent_thoughts) {
            return { error: 'Unavailable' };
          }
          const limit = Math.min(Number(toolInput?.limit) || 10, 30);
          return await mcpBridge.get_recent_thoughts(limit);
        }

        case 'get_active_goals': {
          if (!mcpBridge?.get_active_goals) {
            return { error: 'Unavailable' };
          }
          const limit = Math.min(Number(toolInput?.limit) || 15, 30);
          return await mcpBridge.get_active_goals('active', limit);
        }

        case 'get_pending_notifications': {
          if (!brainDir) return { error: 'brainDir unavailable' };
          const file = path.join(brainDir, 'notifications.jsonl');
          if (!fs.existsSync(file)) return { total: 0, pending: 0, items: [] };
          const ackFile = path.join(brainDir, 'notifications-ack.json');
          let acks = {};
          try {
            if (fs.existsSync(ackFile)) acks = JSON.parse(fs.readFileSync(ackFile, 'utf-8'));
          } catch { /* best-effort */ }
          const all = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l));
          const pending = all.filter(n => !acks[n.id]);
          return {
            total: all.length,
            pending: pending.length,
            items: pending.slice(-20).map(n => ({
              id: n.id,
              cycle: n.cycle,
              source: n.source,
              severity: n.severity,
              message: n.message.substring(0, 300),
              ts: n.ts,
            })),
          };
        }

        default:
          return { error: `Unknown tool: ${toolName}` };
      }
    } catch (err) {
      logger?.warn?.('Cycle tool execution failed', { tool: toolName, error: err.message });
      return { error: err.message };
    }
  };
}

module.exports = {
  buildCycleTools,
  buildCycleToolExecutor,
  READABLE_SURFACES,
};
