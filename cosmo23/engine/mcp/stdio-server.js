#!/usr/bin/env node

/**
 * Cosmo MCP Server - stdio transport
 * 
 * For local desktop apps like Claude Desktop
 * Uses stdio (stdin/stdout) communication
 * 
 * For HTTP access, use cosmo-mcp-http.js instead
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);
const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);

// Configuration
const COSMO_ROOT = path.join(__dirname, '..');
// PRODUCTION: Use COSMO_RUNTIME_PATH from environment
const LOGS_DIR = process.env.COSMO_RUNTIME_PATH || path.join(COSMO_ROOT, 'runtime');
const STATE_FILE = path.join(LOGS_DIR, 'state.json.gz');
const THOUGHTS_FILE = path.join(LOGS_DIR, 'thoughts.jsonl');
const TOPICS_QUEUE = path.join(LOGS_DIR, 'topics-queue.json');
const COORDINATOR_DIR = path.join(LOGS_DIR, 'coordinator');

/**
 * Read and decompress system state
 */
async function readSystemState() {
  try {
    const compressed = await readFile(STATE_FILE);
    const decompressed = await gunzip(compressed);
    return JSON.parse(decompressed.toString());
  } catch (error) {
    throw new Error(`Failed to read system state: ${error.message}`);
  }
}

/**
 * Read recent thoughts from JSONL file
 */
async function readRecentThoughts(limit = 20) {
  try {
    const content = await readFile(THOUGHTS_FILE, 'utf-8');
    const lines = content.trim().split('\n');
    const thoughts = lines.slice(-limit).map(line => JSON.parse(line));
    return thoughts.reverse(); // Most recent first
  } catch (error) {
    throw new Error(`Failed to read thoughts: ${error.message}`);
  }
}

/**
 * Read topics queue
 */
async function readTopicsQueue() {
  try {
    const content = await readFile(TOPICS_QUEUE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { topics: [] };
    }
    throw new Error(`Failed to read topics queue: ${error.message}`);
  }
}

/**
 * Get latest coordinator report
 */
async function getLatestCoordinatorReport() {
  try {
    const files = await readdir(COORDINATOR_DIR);
    const reviewFiles = files
      .filter(f => f.startsWith('review_') && f.endsWith('.md'))
      .sort()
      .reverse();
    
    if (reviewFiles.length === 0) {
      return { report: 'No coordinator reports found yet.' };
    }
    
    const latestFile = path.join(COORDINATOR_DIR, reviewFiles[0]);
    const content = await readFile(latestFile, 'utf-8');
    
    return {
      filename: reviewFiles[0],
      content,
      totalReports: reviewFiles.length
    };
  } catch (error) {
    throw new Error(`Failed to read coordinator reports: ${error.message}`);
  }
}

/**
 * Query memory network using simple similarity
 */
async function queryMemory(query, limit = 10) {
  const state = await readSystemState();
  
  if (!state.memory || !state.memory.nodes || state.memory.nodes.length === 0) {
    return { results: [], message: 'Memory network is empty' };
  }
  
  // Simple keyword matching (actual Cosmo uses embeddings)
  const queryWords = query.toLowerCase().split(/\s+/);
  
  const scored = state.memory.nodes.map(node => {
    const conceptLower = (node.concept || '').toLowerCase();
    let score = 0;
    
    // Count keyword matches
    queryWords.forEach(word => {
      if (conceptLower.includes(word)) {
        score += 1;
      }
    });
    
    // Boost by activation and weight
    score *= (node.activation || 0.5) * (node.weight || 0.5);
    
    return { ...node, score };
  });
  
  const results = scored
    .filter(n => n.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, concept, tag, activation, weight, accessCount, cluster }) => ({
      concept: concept.substring(0, 200),
      tag,
      activation: activation?.toFixed(3),
      weight: weight?.toFixed(3),
      accessCount,
      cluster,
      relevanceScore: score.toFixed(3)
    }));
  
  return {
    query,
    resultsFound: results.length,
    totalNodes: state.memory.nodes.length,
    results
  };
}

// Initialize MCP Server
const server = new Server(
  {
    name: 'cosmo-brain',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'get_system_state',
        description: 'Get Cosmo\'s current system state including cycle count, cognitive state (curiosity, mood, energy), active mode, and memory/goal counts',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_recent_thoughts',
        description: 'Get Cosmo\'s recent thoughts with role, content, cognitive state, and metadata',
        inputSchema: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              description: 'Number of recent thoughts to retrieve (default: 20, max: 100)',
              default: 20,
            },
          },
        },
      },
      {
        name: 'query_memory',
        description: 'Query Cosmo\'s memory network for concepts related to a topic. Returns relevant memory nodes with activation levels and content',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query for memory concepts',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return (default: 10)',
              default: 10,
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_active_goals',
        description: 'Get Cosmo\'s active research goals with priorities, progress, and pursuit counts',
        inputSchema: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              description: 'Filter by status: active, completed, archived, or all (default: active)',
              enum: ['active', 'completed', 'archived', 'all'],
              default: 'active',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of goals to return (default: 20)',
              default: 20,
            },
          },
        },
      },
      {
        name: 'get_agent_activity',
        description: 'Get information about specialist agents and their missions (research, analysis, synthesis, exploration)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_coordinator_report',
        description: 'Get the latest meta-coordinator strategic review report',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'get_memory_statistics',
        description: 'Get detailed statistics about Cosmo\'s memory network structure',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'inject_topic',
        description: 'Inject a new research topic into Cosmo\'s topic queue for exploration',
        inputSchema: {
          type: 'object',
          properties: {
            topic: {
              type: 'string',
              description: 'The research topic or question to explore',
            },
            priority: {
              type: 'string',
              description: 'Priority level: high, medium, or low (default: medium)',
              enum: ['high', 'medium', 'low'],
              default: 'medium',
            },
            context: {
              type: 'string',
              description: 'Additional context or constraints for the exploration',
            },
            depth: {
              type: 'string',
              description: 'Exploration depth: deep, moderate, or quick (default: moderate)',
              enum: ['deep', 'moderate', 'quick'],
              default: 'moderate',
            },
          },
          required: ['topic'],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  try {
    switch (name) {
      case 'get_system_state': {
        const state = await readSystemState();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                cycle: state.cycleCount || 0,
                cognitiveState: state.cognitiveState || {},
                mode: state.currentMode || 'focus',
                memory: {
                  totalNodes: state.memory?.nodes?.length || 0,
                  totalEdges: state.memory?.edges?.length || 0,
                  clusters: state.memory?.clusters?.length || 0,
                },
                goals: {
                  active: state.goals?.active?.length || 0,
                  completed: state.goals?.completed?.length || 0,
                  archived: state.goals?.archived?.length || 0,
                },
                journal: {
                  totalEntries: state.journal?.length || 0,
                },
                agents: state.activeAgents || [],
              }, null, 2),
            },
          ],
        };
      }
      
      case 'get_recent_thoughts': {
        const limit = Math.min(args.limit || 20, 100);
        const thoughts = await readRecentThoughts(limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                count: thoughts.length,
                thoughts: thoughts.map(t => ({
                  cycle: t.cycle,
                  role: t.role,
                  thought: t.thought,
                  goal: t.goal,
                  surprise: t.surprise,
                  cognitiveState: t.cognitiveState,
                  mode: t.oscillatorMode,
                  model: t.model,
                  usedWebSearch: t.usedWebSearch,
                  timestamp: t.timestamp,
                })),
              }, null, 2),
            },
          ],
        };
      }
      
      case 'query_memory': {
        const query = args.query;
        const limit = Math.min(args.limit || 10, 50);
        const results = await queryMemory(query, limit);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(results, null, 2),
            },
          ],
        };
      }
      
      case 'get_active_goals': {
        const state = await readSystemState();
        const status = args.status || 'active';
        const limit = args.limit || 20;
        
        let goals = [];
        if (status === 'all') {
          goals = [
            ...(state.goals?.active || []).map(g => ({ ...g, status: 'active' })),
            ...(state.goals?.completed || []).map(g => ({ ...g, status: 'completed' })),
            ...(state.goals?.archived || []).map(g => ({ ...g, status: 'archived' })),
          ];
        } else {
          goals = (state.goals?.[status] || []).map(g => ({ ...g, status }));
        }
        
        goals = goals
          .sort((a, b) => (b.priority || 0) - (a.priority || 0))
          .slice(0, limit)
          .map(g => ({
            id: g.id,
            description: g.description,
            status: g.status,
            priority: g.priority?.toFixed(3),
            progress: g.progress?.toFixed(3),
            pursuitCount: g.pursuitCount,
            created: new Date(g.created).toISOString(),
            lastPursued: g.lastPursued ? new Date(g.lastPursued).toISOString() : null,
            source: g.source,
            reason: g.reason,
          }));
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                filter: status,
                count: goals.length,
                goals,
              }, null, 2),
            },
          ],
        };
      }
      
      case 'get_agent_activity': {
        const state = await readSystemState();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                activeAgents: state.activeAgents || [],
                recentMissions: state.agentHistory?.slice(-10) || [],
                agentStats: state.agentStats || {},
              }, null, 2),
            },
          ],
        };
      }
      
      case 'get_coordinator_report': {
        const report = await getLatestCoordinatorReport();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(report, null, 2),
            },
          ],
        };
      }
      
      case 'get_memory_statistics': {
        const state = await readSystemState();
        const memory = state.memory || { nodes: [], edges: [] };
        
        // Calculate statistics
        const stats = {
          totalNodes: memory.nodes?.length || 0,
          totalEdges: memory.edges?.length || 0,
          clusters: memory.clusters?.length || 0,
          nodesByTag: {},
          averageActivation: 0,
          averageWeight: 0,
          mostAccessedNodes: [],
          highestActivationNodes: [],
        };
        
        if (memory.nodes && memory.nodes.length > 0) {
          // Group by tag
          memory.nodes.forEach(node => {
            const tag = node.tag || 'unknown';
            stats.nodesByTag[tag] = (stats.nodesByTag[tag] || 0) + 1;
          });
          
          // Calculate averages
          const totalActivation = memory.nodes.reduce((sum, n) => sum + (n.activation || 0), 0);
          const totalWeight = memory.nodes.reduce((sum, n) => sum + (n.weight || 0), 0);
          stats.averageActivation = (totalActivation / memory.nodes.length).toFixed(3);
          stats.averageWeight = (totalWeight / memory.nodes.length).toFixed(3);
          
          // Most accessed
          stats.mostAccessedNodes = memory.nodes
            .sort((a, b) => (b.accessCount || 0) - (a.accessCount || 0))
            .slice(0, 5)
            .map(n => ({
              concept: n.concept?.substring(0, 100),
              accessCount: n.accessCount,
              activation: n.activation?.toFixed(3),
            }));
          
          // Highest activation
          stats.highestActivationNodes = memory.nodes
            .sort((a, b) => (b.activation || 0) - (a.activation || 0))
            .slice(0, 5)
            .map(n => ({
              concept: n.concept?.substring(0, 100),
              activation: n.activation?.toFixed(3),
              weight: n.weight?.toFixed(3),
            }));
        }
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      }
      
      case 'inject_topic': {
        // Validate input (defensive - system will also validate when polling)
        if (!args.topic || typeof args.topic !== 'string') {
          throw new Error('topic is required and must be a string');
        }
        if (args.topic.length > 1000) {
          throw new Error('topic too long (max 1000 characters)');
        }
        
        const validPriorities = ['high', 'medium', 'low'];
        const priority = args.priority || 'medium';
        if (!validPriorities.includes(priority.toLowerCase())) {
          throw new Error('priority must be: high, medium, or low');
        }
        
        const topicsData = await readTopicsQueue();
        
        const newTopic = {
          topic: args.topic.trim(),
          priority: priority.toLowerCase(),
          context: args.context ? String(args.context).trim().substring(0, 2000) : '',
          depth: args.depth || 'moderate',
          injectedAt: new Date().toISOString(),
          source: 'mcp',
        };
        
        topicsData.topics = topicsData.topics || [];
        topicsData.topics.push(newTopic);
        
        // Write back to file
        await fs.promises.writeFile(
          TOPICS_QUEUE,
          JSON.stringify(topicsData, null, 2),
          'utf-8'
        );
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                message: 'Topic injected successfully',
                topic: newTopic,
                queueLength: topicsData.topics.length,
              }, null, 2),
            },
          ],
        };
      }
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: error.message,
            tool: name,
          }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start stdio server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('Cosmo MCP Server running (stdio mode)');
  console.error(`Logs directory: ${LOGS_DIR}`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
