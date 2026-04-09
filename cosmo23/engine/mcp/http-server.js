#!/usr/bin/env node

/**
 * Cosmo MCP Server - HTTP Transport (Stateless)
 * 
 * Implements the official MCP Streamable HTTP transport specification
 * using the @modelcontextprotocol/sdk
 */

const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const yaml = require('js-yaml');
const { FreeWebSearch } = require('../src/tools/web-search-free');

const gunzip = promisify(zlib.gunzip);

// Initialize free web search
const webSearch = new FreeWebSearch(console);
const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);

// Configuration
const COSMO_ROOT = path.join(__dirname, '..');
// PRODUCTION: Use COSMO_RUNTIME_PATH from environment (set by unified server)
// FALLBACK: Use engine/runtime symlink for local development
const LOGS_DIR = process.env.COSMO_RUNTIME_PATH || path.join(COSMO_ROOT, 'runtime');
const STATE_FILE = path.join(LOGS_DIR, 'state.json.gz');
const THOUGHTS_FILE = path.join(LOGS_DIR, 'thoughts.jsonl');

console.log('📁 MCP HTTP file access paths:', process.env.COSMO_RUNTIME_PATH 
  ? ['User-specific runtime from COSMO_RUNTIME_PATH'] 
  : ['runtime/outputs/', 'runtime/exports/']);
const TOPICS_QUEUE = path.join(LOGS_DIR, 'topics-queue.json');
const ACTIONS_QUEUE = path.join(LOGS_DIR, 'actions-queue.json');
const COORDINATOR_DIR = path.join(LOGS_DIR, 'coordinator');

// Load COSMO configuration for file access control (mirrors filesystem MCP server behavior)
// PRODUCTION: Read from runtime config.yaml (per-user) instead of static engine/src/config.yaml
let COSMO_CONFIG = null;
let ALLOWED_PATHS = null;
try {
  // Try runtime config first (multi-tenant), then fall back to static config (local dev)
  const runtimeConfigPath = path.join(LOGS_DIR, 'config.yaml');
  const staticConfigPath = path.join(COSMO_ROOT, 'src', 'config.yaml');
  const configPath = fs.existsSync(runtimeConfigPath) ? runtimeConfigPath : staticConfigPath;

  console.log('📁 MCP HTTP loading config from:', configPath);

  if (fs.existsSync(configPath)) {
    COSMO_CONFIG = yaml.load(fs.readFileSync(configPath, 'utf8'));

    // Extract allowed paths from config structure: mcp.client.servers[0].allowedPaths
    const mcpServers = COSMO_CONFIG?.mcp?.client?.servers;
    if (mcpServers && mcpServers[0] && mcpServers[0].allowedPaths) {
      ALLOWED_PATHS = mcpServers[0].allowedPaths;
      console.log('📁 MCP HTTP file access paths:', ALLOWED_PATHS);
    } else {
      console.log('📁 MCP HTTP: no allowedPaths configured (full repository access)');
    }
  }
} catch (error) {
  console.warn('MCP HTTP: could not load file access config:', error.message);
}

/**
 * Check if path is allowed based on configuration.
 * Supports both COSMO-relative paths and absolute external paths.
 *
 * Behavior:
 * - Paths inside COSMO_ROOT are always allowed (repository access)
 * - Paths inside LOGS_DIR are always allowed (multi-tenant runtime)
 * - If allowedPaths are present, paths under them are allowed (external access)
 */
function isPathAllowed(relPath) {
  // Admin bypass — no path restrictions
  if (process.env.COSMO_ADMIN_MODE === 'true') {
    return true;
  }

  // Resolve the requested path (supports both absolute and relative)
  const resolvedRequested = path.isAbsolute(relPath)
    ? path.resolve(relPath)  // Use absolute path as-is
    : path.resolve(COSMO_ROOT, relPath);  // Resolve relative to COSMO root

  // Always allow paths inside COSMO_ROOT (repository)
  if (resolvedRequested.startsWith(COSMO_ROOT)) {
    return true;
  }

  // Always allow paths inside LOGS_DIR (multi-tenant runtime path)
  if (resolvedRequested.startsWith(LOGS_DIR)) {
    return true;
  }

  // Check explicit allowedPaths from config
  if (!ALLOWED_PATHS || ALLOWED_PATHS.length === 0) {
    return false; // No external paths allowed
  }

  return ALLOWED_PATHS.some(allowedPath => {
    // Resolve allowed path (supports both absolute and COSMO-relative paths)
    const resolvedAllowed = path.isAbsolute(allowedPath)
      ? path.resolve(allowedPath)  // External absolute path
      : path.resolve(COSMO_ROOT, allowedPath);  // COSMO-relative path

    return resolvedRequested.startsWith(resolvedAllowed);
  });
}

// Helper functions (same as stdio version)
async function readSystemState() {
  const compressed = await readFile(STATE_FILE);
  const decompressed = await gunzip(compressed);
  return JSON.parse(decompressed.toString());
}

async function readRecentThoughts(limit = 20) {
  const content = await readFile(THOUGHTS_FILE, 'utf-8');
  const lines = content.trim().split('\n');
  const thoughts = lines.slice(-limit).map(line => JSON.parse(line));
  return thoughts.reverse();
}

async function readTopicsQueue() {
  try {
    const content = await readFile(TOPICS_QUEUE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { topics: [] };
    }
    throw error;
  }
}

async function readActionsQueue() {
  try {
    const content = await readFile(ACTIONS_QUEUE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { actions: [] };
    }
    throw error;
  }
}

async function getLatestCoordinatorReport() {
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
}

async function queryMemory(query, limit = 10) {
  const state = await readSystemState();
  
  if (!state.memory || !state.memory.nodes || state.memory.nodes.length === 0) {
    return { results: [], message: 'Memory network is empty' };
  }
  
  const queryWords = query.toLowerCase().split(/\s+/);
  
  const scored = state.memory.nodes.map(node => {
    const conceptLower = (node.concept || '').toLowerCase();
    let score = 0;
    
    queryWords.forEach(word => {
      if (conceptLower.includes(word)) {
        score += 1;
      }
    });
    
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

// Create MCP server
function createMCPServer() {
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

  // Register tool handlers
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'get_system_state',
          description: 'Get Cosmo\'s current system state including cycle count, cognitive state, and memory/goal counts',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_recent_thoughts',
          description: 'Get Cosmo\'s recent thoughts with role, content, and metadata',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Number of thoughts to retrieve (default: 20, max: 100)',
                default: 20,
              },
            },
          },
        },
        {
          name: 'query_memory',
          description: 'Query Cosmo\'s memory network for concepts',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query',
              },
              limit: {
                type: 'number',
                description: 'Max results (default: 10)',
                default: 10,
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_active_goals',
          description: 'Get Cosmo\'s research goals',
          inputSchema: {
            type: 'object',
            properties: {
              status: {
                type: 'string',
                enum: ['active', 'completed', 'archived', 'all'],
                default: 'active',
              },
              limit: {
                type: 'number',
                default: 20,
              },
            },
          },
        },
        {
          name: 'get_agent_activity',
          description: 'Get specialist agent missions',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_coordinator_report',
          description: 'Get latest meta-coordinator report',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_memory_statistics',
          description: 'Get memory network statistics',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'inject_topic',
          description: 'Inject research topic',
          inputSchema: {
            type: 'object',
            properties: {
              topic: {
                type: 'string',
              },
              priority: {
                type: 'string',
                enum: ['high', 'medium', 'low'],
                default: 'medium',
              },
            },
            required: ['topic'],
          },
        },
        {
          name: 'spawn_agent',
          description: 'Spawn a specialist agent to perform a task',
          inputSchema: {
            type: 'object',
            properties: {
              agentType: {
                type: 'string',
                description: 'Type of agent to spawn',
                enum: ['research', 'analysis', 'synthesis', 'exploration', 'code_creation', 'code_execution', 'document_creation', 'document_analysis', 'quality_assurance', 'planning', 'integration', 'document_compiler', 'specialized_binary'],
              },
              mission: {
                type: 'string',
                description: 'Mission description for the agent',
              },
              priority: {
                type: 'number',
                description: 'Priority level (0.0-1.0)',
                default: 0.8,
              },
              immediate: {
                type: 'boolean',
                description: 'Process immediately on next cycle (default: false)',
                default: false,
              },
            },
            required: ['agentType', 'mission'],
          },
        },
        {
          name: 'create_goal',
          description: 'Create a new research goal',
          inputSchema: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: 'Goal description',
              },
              priority: {
                type: 'number',
                description: 'Priority level (0.0-1.0)',
                default: 0.8,
              },
              urgent: {
                type: 'boolean',
                description: 'Mark as urgent',
                default: false,
              },
              immediate: {
                type: 'boolean',
                description: 'Process immediately on next cycle (default: false)',
                default: false,
              },
            },
            required: ['description'],
          },
        },
        {
          name: 'generate_code',
          description: 'Generate code by spawning a code creation agent',
          inputSchema: {
            type: 'object',
            properties: {
              spec: {
                type: 'string',
                description: 'Code generation specification',
              },
              language: {
                type: 'string',
                description: 'Programming language',
                enum: ['javascript', 'python', 'typescript', 'java', 'go', 'rust'],
                default: 'javascript',
              },
            },
            required: ['spec'],
          },
        },
        {
          name: 'get_journal',
          description: 'Get Cosmo\'s thought journal entries',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                default: 20,
              },
            },
          },
        },
        {
          name: 'get_oscillator_mode',
          description: 'Get current oscillator mode and stats (focus/explore/execute)',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_topic_queue',
          description: 'Get current topic queue status',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get_memory_graph',
          description: 'Get complete memory network for graph visualization',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Max nodes (default: 200, 0 for all)',
                default: 200,
              },
            },
          },
        },
        {
          name: 'get_dreams',
          description: 'Get dream thoughts and goals generated during sleep cycles',
          inputSchema: {
            type: 'object',
            properties: {
              limit: {
                type: 'number',
                description: 'Max dreams to return (default: 20)',
                default: 20,
              },
            },
          },
        },
        {
          name: 'read_file',
          description: 'Read a file from the COSMO repository',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Relative path from repo root (e.g., "runtime/coordinator/insights_curated_cycle_50_2025-10-11.md")',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'read_binary_file',
          description: 'Read a binary file (PDF, Office documents, images, compressed files) as base64-encoded content',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Relative path to binary file from repository root',
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'write_file',
          description: 'Write content to a file in the COSMO repository (creates directories as needed)',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Relative path from repo root where file should be written',
              },
              content: {
                type: 'string',
                description: 'Content to write to the file',
              },
              encoding: {
                type: 'string',
                description: 'File encoding (default: "utf-8", or "base64" for binary)',
                default: 'utf-8',
              },
            },
            required: ['path', 'content'],
          },
        },
        {
          name: 'list_directory',
          description: 'List files and directories in a path',
          inputSchema: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: 'Relative path from repo root (default: ".")',
                default: '.',
              },
            },
          },
        },
        {
          name: 'web_search',
          description: 'Search the web for information (uses DuckDuckGo, no API key needed). Use this when you need current information, facts, or research data from the internet.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'Search query - be specific for best results',
              },
              maxResults: {
                type: 'number',
                description: 'Maximum number of results to return (default: 8, max: 15)',
                default: 8,
              },
            },
            required: ['query'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    try {
      let result;
      
      switch (name) {
        case 'get_system_state': {
          const state = await readSystemState();
          result = {
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
          };
          break;
        }
        
        case 'get_recent_thoughts': {
          const limit = Math.min(args.limit || 20, 100);
          const thoughts = await readRecentThoughts(limit);
          result = { count: thoughts.length, thoughts };
          break;
        }
        
        case 'query_memory': {
          result = await queryMemory(args.query, args.limit || 10);
          break;
        }
        
        case 'get_active_goals': {
          const state = await readSystemState();
          const status = args.status || 'active';
          const limit = args.limit || 20;
          
          // Goals are exported as Map entries: [[key, value], [key, value], ...]
          // Need to extract just the values
          const extractGoals = (goalArray) => {
            if (!goalArray) return [];
            return goalArray
              .filter(item => Array.isArray(item) && item.length === 2)
              .map(([id, goal]) => goal)
              .filter(g => g && typeof g === 'object');
          };
          
          let goals = [];
          if (status === 'all') {
            goals = [
              ...extractGoals(state.goals?.active).map(g => ({ ...g, status: 'active' })),
              ...extractGoals(state.goals?.completed).map(g => ({ ...g, status: 'completed' })),
              ...extractGoals(state.goals?.archived).map(g => ({ ...g, status: 'archived' })),
            ];
          } else {
            goals = extractGoals(state.goals?.[status]).map(g => ({ ...g, status }));
          }
          
          result = {
            filter: status,
            count: goals.length,
            goals: goals.slice(0, limit)
          };
          break;
        }
        
        case 'get_agent_activity': {
          const state = await readSystemState();
          
          // Extract agent data from agentExecutor state
          const agentExecutor = state.agentExecutor || {};
          const activeAgents = agentExecutor.activeAgents || [];
          const completedAgents = agentExecutor.completedAgents || [];
          
          result = {
            activeAgents: activeAgents,
            recentAgents: completedAgents.slice(-20).reverse(),
            stats: {
              totalCompleted: completedAgents.length,
              active: activeAgents.length,
              byType: {}
            }
          };
          
          // Count by type
          completedAgents.forEach(a => {
            const type = a.type || 'unknown';
            result.stats.byType[type] = (result.stats.byType[type] || 0) + 1;
          });
          
          break;
        }
        
        case 'get_coordinator_report': {
          result = await getLatestCoordinatorReport();
          break;
        }
        
        case 'get_memory_statistics': {
          const state = await readSystemState();
          const memory = state.memory || {};
          const nodes = memory.nodes || [];
          const edges = memory.edges || [];
          
          // Extract nodes from Map format if needed
          const extractNodes = (nodeArray) => {
            if (!nodeArray || nodeArray.length === 0) return [];
            // Check if it's Map format [[id, node], ...]
            if (Array.isArray(nodeArray[0]) && nodeArray[0].length === 2) {
              return nodeArray.map(([id, node]) => node);
            }
            return nodeArray;
          };
          
          const nodeList = extractNodes(nodes);
          
          const stats = {
            totalNodes: nodeList.length,
            totalEdges: Array.isArray(edges) ? edges.length : edges.size || 0,
            clusters: memory.clusters?.length || memory.clusters?.size || 0,
            nodesByTag: {},
            averageActivation: 0,
            averageWeight: 0,
            mostAccessedNodes: [],
            highestActivationNodes: [],
          };
          
          if (nodeList.length > 0) {
            // Group by tag
            nodeList.forEach(node => {
              const tag = node.tag || 'unknown';
              stats.nodesByTag[tag] = (stats.nodesByTag[tag] || 0) + 1;
            });
            
            // Calculate averages
            const totalActivation = nodeList.reduce((sum, n) => sum + (n.activation || 0), 0);
            const totalWeight = nodeList.reduce((sum, n) => sum + (n.weight || 0), 0);
            stats.averageActivation = (totalActivation / nodeList.length).toFixed(3);
            stats.averageWeight = (totalWeight / nodeList.length).toFixed(3);
            
            // Most accessed
            stats.mostAccessedNodes = nodeList
              .sort((a, b) => (b.accessCount || 0) - (a.accessCount || 0))
              .slice(0, 5)
              .map(n => ({
                concept: n.concept?.substring(0, 150),
                accessCount: n.accessCount,
                activation: n.activation?.toFixed(3),
              }));
            
            // Highest activation
            stats.highestActivationNodes = nodeList
              .sort((a, b) => (b.activation || 0) - (a.activation || 0))
              .slice(0, 5)
              .map(n => ({
                concept: n.concept?.substring(0, 150),
                activation: n.activation?.toFixed(3),
                weight: n.weight?.toFixed(3),
              }));
          }
          
          result = stats;
          break;
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
            context: args.context ? String(args.context).trim().substring(0, 2000) : undefined,
            depth: args.depth || undefined,
            injectedAt: new Date().toISOString(),
            source: 'mcp',
          };
          topicsData.topics = topicsData.topics || [];
          topicsData.topics.push(newTopic);
          await fs.promises.writeFile(TOPICS_QUEUE, JSON.stringify(topicsData, null, 2));
          result = { success: true, topic: newTopic, queueLength: topicsData.topics.length };
          break;
        }
        
        case 'spawn_agent': {
          // Validate input
          if (!args.agentType || typeof args.agentType !== 'string') {
            throw new Error('agentType is required');
          }
          if (!args.mission || typeof args.mission !== 'string') {
            throw new Error('mission is required');
          }
          if (args.mission.length > 100000) {
            throw new Error('mission too long (max 100k characters - if you need more, use a file reference)');
          }
          
          const validAgentTypes = ['research', 'analysis', 'synthesis', 'exploration', 'code_creation', 'code_execution', 'document_creation', 'document_analysis', 'quality_assurance', 'planning', 'integration', 'document_compiler', 'specialized_binary'];
          if (!validAgentTypes.includes(args.agentType)) {
            throw new Error(`agentType must be one of: ${validAgentTypes.join(', ')}`);
          }
          
          const actionsData = await readActionsQueue();
          const newAction = {
            actionId: `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            type: 'spawn_agent',
            agentType: args.agentType,
            mission: args.mission.trim(),
            priority: args.priority || 0.8,
            immediate: args.immediate || false, // Process on next cycle instead of waiting
            requestedAt: new Date().toISOString(),
            source: 'mcp',
            status: 'pending',
          };
          actionsData.actions = actionsData.actions || [];
          actionsData.actions.push(newAction);
          await fs.promises.writeFile(ACTIONS_QUEUE, JSON.stringify(actionsData, null, 2));
          result = {
            success: true,
            action: newAction,
            queueLength: actionsData.actions.length,
            message: newAction.immediate
              ? `Queued ${args.agentType} agent spawn (IMMEDIATE - will process next cycle).`
              : `Queued ${args.agentType} agent spawn. Will be processed by orchestrator.`
          };
          break;
        }
        
        case 'create_goal': {
          // Validate input
          if (!args.description || typeof args.description !== 'string') {
            throw new Error('description is required');
          }
          if (args.description.length > 100000) {
            throw new Error('description too long (max 100k characters - if you need more, use a file reference)');
          }
          
          const actionsData = await readActionsQueue();
          const newAction = {
            actionId: `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            type: 'create_goal',
            description: args.description.trim(),
            priority: args.priority || 0.8,
            urgent: args.urgent || false,
            immediate: args.immediate || false, // Process on next cycle instead of waiting
            requestedAt: new Date().toISOString(),
            source: 'mcp',
            status: 'pending',
          };
          actionsData.actions = actionsData.actions || [];
          actionsData.actions.push(newAction);
          await fs.promises.writeFile(ACTIONS_QUEUE, JSON.stringify(actionsData, null, 2));
          result = {
            success: true,
            action: newAction,
            queueLength: actionsData.actions.length,
            message: newAction.immediate
              ? `Queued goal creation (IMMEDIATE - will process next cycle).`
              : `Queued goal creation. Will be processed by orchestrator.`
          };
          break;
        }
        
        case 'generate_code': {
          // Validate input
          if (!args.spec || typeof args.spec !== 'string') {
            throw new Error('spec is required');
          }
          if (args.spec.length > 5000) {
            throw new Error('spec too long (max 5000 characters)');
          }
          
          const language = args.language || 'javascript';
          const validLanguages = ['javascript', 'python', 'typescript', 'java', 'go', 'rust'];
          if (!validLanguages.includes(language)) {
            throw new Error(`language must be one of: ${validLanguages.join(', ')}`);
          }
          
          const actionsData = await readActionsQueue();
          const newAction = {
            actionId: `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
            type: 'generate_code',
            spec: args.spec.trim(),
            language: language,
            requestedAt: new Date().toISOString(),
            source: 'mcp',
            status: 'pending',
          };
          actionsData.actions = actionsData.actions || [];
          actionsData.actions.push(newAction);
          await fs.promises.writeFile(ACTIONS_QUEUE, JSON.stringify(actionsData, null, 2));
          result = { 
            success: true, 
            action: newAction, 
            queueLength: actionsData.actions.length,
            message: `Queued code generation for ${language}. Will be processed by orchestrator.`
          };
          break;
        }
        
        case 'get_journal': {
          const state = await readSystemState();
          const limit = args.limit || 20;
          const journal = state.journal || [];
          result = {
            totalEntries: journal.length,
            entries: journal.slice(-limit).reverse()
          };
          break;
        }
        
        case 'get_oscillator_mode': {
          const state = await readSystemState();
          result = {
            currentMode: state.currentMode || state.oscillator?.currentMode || 'unknown',
            stats: state.oscillator || {},
            cycleCount: state.cycleCount
          };
          break;
        }
        
        case 'get_topic_queue': {
          const topicsData = await readTopicsQueue();
          result = {
            topics: topicsData.topics || [],
            queueLength: (topicsData.topics || []).length,
            processed: topicsData.processed || []
          };
          break;
        }
        
        case 'get_memory_graph': {
          const state = await readSystemState();
          const memory = state.memory || {};
          const requestedLimit = args.limit !== undefined ? args.limit : 0; // 0 = all
          
          // Extract nodes from Map format
          let nodeList = [];
          if (memory.nodes) {
            if (Array.isArray(memory.nodes) && memory.nodes.length > 0) {
              if (Array.isArray(memory.nodes[0]) && memory.nodes[0].length === 2) {
                // Map format [[id, node], ...]
                nodeList = memory.nodes.map(([id, node]) => node);
              } else {
                // Already array format
                nodeList = memory.nodes;
              }
            }
          }
          
          // Extract edges
          let edgeList = [];
          if (memory.edges) {
            if (Array.isArray(memory.edges)) {
              edgeList = memory.edges;
            } else if (memory.edges.size) {
              // Map format - convert to array
              edgeList = Array.from(memory.edges.entries()).map(([key, edge]) => {
                const [source, target] = key.split('->');
                return {
                  source: parseInt(source),
                  target: parseInt(target),
                  weight: edge.weight || 0.5,
                  type: edge.type
                };
              });
            }
          }
          
          // Sort and limit nodes
          nodeList.sort((a, b) => (b.activation || 0) - (a.activation || 0));
          
          if (requestedLimit > 0 && nodeList.length > requestedLimit) {
            const topNodes = nodeList.slice(0, requestedLimit);
            const nodeIds = new Set(topNodes.map(n => n.id));
            edgeList = edgeList.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
            nodeList = topNodes;
          }
          
          result = {
            nodes: nodeList.map(n => ({
              id: n.id,
              concept: (n.concept || '').substring(0, 200),
              tag: n.tag,
              activation: n.activation || 0,
              weight: n.weight || 0.5,
              accessCount: n.accessCount || 0,
              cluster: n.cluster || 0
            })),
            edges: edgeList,
            totalNodes: memory.nodes?.length || 0,
            totalEdges: memory.edges?.length || memory.edges?.size || 0
          };
          break;
        }
        
        case 'get_dreams': {
          const state = await readSystemState();
          const requestedLimit = args.limit || 20;
          const dreams = [];
          
          // Extract goals helper
          const extractGoals = (goalArray) => {
            if (!goalArray) return [];
            return goalArray
              .filter(item => Array.isArray(item) && item.length === 2)
              .map(([id, goal]) => goal)
              .filter(g => g && typeof g === 'object');
          };
          
          // Find dream goals (source='dream_gpt5' or 'dream')
          const allGoals = [
            ...extractGoals(state.goals?.active).map(g => ({ ...g, status: 'active' })),
            ...extractGoals(state.goals?.completed).map(g => ({ ...g, status: 'completed' })),
            ...extractGoals(state.goals?.archived).map(g => ({ ...g, status: 'archived' })),
          ];
          
          allGoals.forEach(goal => {
            if (goal.source === 'dream_gpt5' || goal.source === 'dream') {
              dreams.push({
                id: goal.id,
                type: 'goal',
                timestamp: goal.created || goal.lastPursued || new Date(),
                content: goal.description,
                reason: goal.reason || '',
                status: goal.status,
                priority: goal.priority,
                progress: goal.progress || 0,
                pursuitCount: goal.pursuitCount || 0,
                source: goal.source,
                model: goal.source === 'dream_gpt5' ? 'gpt-5.2' : 'gpt-5.2'
              });
            }
          });
          
          // Extract memory nodes
          let memoryNodes = [];
          if (state.memory && state.memory.nodes) {
            if (Array.isArray(state.memory.nodes) && state.memory.nodes.length > 0) {
              if (Array.isArray(state.memory.nodes[0]) && state.memory.nodes[0].length === 2) {
                memoryNodes = state.memory.nodes.map(([id, node]) => node);
              } else {
                memoryNodes = state.memory.nodes;
              }
            }
          }
          
          // Find dream memory nodes (tag='dream' or concept starts with [DREAM])
          memoryNodes.forEach(node => {
            if (node.tag === 'dream' || (node.concept && node.concept.startsWith('[DREAM]'))) {
              dreams.push({
                id: `dream_mem_${node.id}`,
                type: 'memory',
                timestamp: node.created || node.accessed,
                content: node.concept,
                activation: node.activation,
                weight: node.weight,
                accessCount: node.accessCount,
                cluster: node.cluster,
                source: 'memory'
              });
            }
          });
          
          // Sort by timestamp (newest first)
          dreams.sort((a, b) => {
            const timeA = new Date(a.timestamp).getTime();
            const timeB = new Date(b.timestamp).getTime();
            return timeB - timeA;
          });
          
          const limitedDreams = dreams.slice(0, requestedLimit);
          
          result = {
            dreams: limitedDreams,
            stats: {
              total: dreams.length,
              fromGoals: dreams.filter(d => d.type === 'goal').length,
              fromMemory: dreams.filter(d => d.type === 'memory').length,
              completed: dreams.filter(d => d.status === 'completed').length
            }
          };
          break;
        }
        
        case 'read_file': {
          const relPath = args.path || '';
          // Support both absolute paths (multi-tenant) and relative paths (COSMO root)
          const fullPath = path.isAbsolute(relPath)
            ? path.resolve(relPath)
            : path.resolve(COSMO_ROOT, relPath);

          // Check file access permissions (includes security checks for COSMO_ROOT, LOGS_DIR, allowedPaths)
          if (!isPathAllowed(relPath)) {
            throw new Error(`Access denied: path '${relPath}' not in allowed directories`);
          }
          
          const fileContent = await readFile(fullPath, 'utf-8');
          const stats = await fs.promises.stat(fullPath);
          
          result = {
            path: relPath,
            content: fileContent,
            size: stats.size,
            modified: stats.mtime.toISOString()
          };
          break;
        }
        
        case 'read_binary_file': {
          const relPath = args.path || '';
          // Support both absolute paths (multi-tenant) and relative paths (COSMO root)
          const fullPath = path.isAbsolute(relPath)
            ? path.resolve(relPath)
            : path.resolve(COSMO_ROOT, relPath);

          // Check file access permissions (includes security checks for COSMO_ROOT, LOGS_DIR, allowedPaths)
          if (!isPathAllowed(relPath)) {
            throw new Error(`Access denied: path '${relPath}' not in allowed directories`);
          }
          
          // Check if it's actually a binary file
          const ext = path.extname(fullPath).toLowerCase();
          const binaryExtensions = ['.pdf', '.docx', '.xlsx', '.doc', '.xls', '.zip', '.gz', '.png', '.jpg', '.jpeg', '.gif'];
          if (!binaryExtensions.includes(ext)) {
            throw new Error(`Use read_file for text files: ${relPath}`);
          }
          
          // Read as buffer
          const buffer = await fs.promises.readFile(fullPath);
          const stats = await fs.promises.stat(fullPath);
          
          result = {
            path: relPath,
            content: buffer.toString('base64'),
            encoding: 'base64',
            size: stats.size,
            modified: stats.mtime.toISOString()
          };
          break;
        }
        
        case 'write_file': {
          const relPath = args.path || '';
          const content = args.content || '';
          const encoding = args.encoding || 'utf-8';
          // Support both absolute paths (multi-tenant) and relative paths (COSMO root)
          const fullPath = path.isAbsolute(relPath)
            ? path.resolve(relPath)
            : path.resolve(COSMO_ROOT, relPath);

          // Check file access permissions (includes security checks for COSMO_ROOT, LOGS_DIR, allowedPaths)
          if (!isPathAllowed(relPath)) {
            throw new Error(`Access denied: path '${relPath}' not in allowed directories`);
          }
          
          // Create directory if it doesn't exist
          const dir = path.dirname(fullPath);
          await fs.promises.mkdir(dir, { recursive: true });
          
          // Write file with specified encoding
          if (encoding === 'base64') {
            const buffer = Buffer.from(content, 'base64');
            await fs.promises.writeFile(fullPath, buffer);
          } else {
            await fs.promises.writeFile(fullPath, content, encoding);
          }
          
          const stats = await fs.promises.stat(fullPath);
          
          result = {
            path: relPath,
            size: stats.size,
            created: stats.birthtime.toISOString(),
            modified: stats.mtime.toISOString(),
            success: true
          };
          break;
        }
        
        case 'list_directory': {
          const relPath = args.path || '.';
          // Support both absolute paths (multi-tenant) and relative paths (COSMO root)
          const fullPath = path.isAbsolute(relPath)
            ? path.resolve(relPath)
            : path.resolve(COSMO_ROOT, relPath);

          // Check file access permissions (includes security checks for COSMO_ROOT, LOGS_DIR, allowedPaths)
          if (!isPathAllowed(relPath)) {
            throw new Error(`Access denied: path '${relPath}' not in allowed directories`);
          }
          
          const entries = await readdir(fullPath, { withFileTypes: true });
          const items = await Promise.all(entries.map(async entry => {
            const itemPath = path.join(fullPath, entry.name);
            const stats = await fs.promises.stat(itemPath);
            return {
              name: entry.name,
              type: entry.isDirectory() ? 'directory' : 'file',
              size: entry.isFile() ? stats.size : null,
              modified: stats.mtime.toISOString()
            };
          }));
          
          result = {
            path: relPath,
            items,
            count: items.length
          };
          break;
        }

        case 'web_search': {
          const query = args.query;
          if (!query || query.trim().length === 0) {
            throw new Error('Search query is required');
          }

          const maxResults = Math.min(args.maxResults || 8, 15);
          console.log(`[MCP] Web search: "${query}" (max ${maxResults} results)`);

          const searchResult = await webSearch.search(query, { maxResults });

          if (searchResult.success && searchResult.results.length > 0) {
            result = {
              query: searchResult.query,
              resultCount: searchResult.results.length,
              source: searchResult.source,
              results: searchResult.results,
              formatted: webSearch.formatForLLM(searchResult)
            };
          } else {
            result = {
              query: searchResult.query,
              resultCount: 0,
              source: searchResult.source,
              results: [],
              message: searchResult.message || 'No results found',
              formatted: `No web search results found for "${query}". Please try a different query or rely on training knowledge.`
            };
          }
          break;
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2)
          }
        ]
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: error.message }, null, 2)
          }
        ],
        isError: true
      };
    }
  });

  return server;
}

// Start HTTP server - Stateless mode per SDK docs
async function main() {
  const app = express();
  
  // CORS middleware - allow localhost on any port
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin.match(/^http:\/\/localhost(:\d+)?$/)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, Mcp-Session-Id');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
    }
    
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    
    next();
  });
  
  // COSMO is a local research system - no artificial limits on data ingestion
  // Set to 10GB to handle serious document collections and large-scale analysis
  // This is a LOCAL system, not a public API - memory constraints come from OS, not app limits
  app.use(express.json({ limit: '10gb' }));
  app.use(express.urlencoded({ limit: '10gb', extended: true }));

  // POST /mcp - handle all MCP requests (stateless)
  app.post('/mcp', async (req, res) => {
    // Stateless: create new server + transport for each request
    const server = createMCPServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined  // Stateless mode
    });
    
    let requestComplete = false;
    
    res.on('close', () => {
      if (!requestComplete) {
        console.error('MCP: Client disconnected before request complete');
      }
      transport.close();
      server.close();
    });
    
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      requestComplete = true;
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
    
    // Note: Server and transport cleanup handled by res.on('close') event
  });

  // GET /mcp - Not supported in stateless mode
  app.get('/mcp', (req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.'
        },
        id: null
      })
    );
  });

  // DELETE /mcp - Not needed in stateless mode
  app.delete('/mcp', (req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.'
        },
        id: null
      })
    );
  });

  const port = process.argv[2] || 3335;
  app.listen(port, () => {
    console.error(`✅ Cosmo MCP Server (Streamable HTTP) on http://localhost:${port}/mcp`);
    console.error(`   Logs: ${LOGS_DIR}`);
  });
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

