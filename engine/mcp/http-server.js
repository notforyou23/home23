#!/usr/bin/env node

/**
 * Cosmo MCP Server - HTTP Transport (Stateless)
 * 
 * Implements the official MCP Streamable HTTP transport specification
 * using the @modelcontextprotocol/sdk
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const yaml = require('js-yaml');
const { FreeWebSearch } = require('../src/tools/web-search-free');
const {
  createDefaultMcpMemoryTools,
  createMcpReadinessController,
  createSnapshotScalarStateReader,
} = require('../../shared/memory-source/mcp-http-runtime.cjs');
const { createMemorySearchService } = require('../src/dashboard/memory-search.js');
const { createMemoryDeltaOverlayCache } = require('../src/dashboard/memory-delta-overlay-cache.js');
const { readRecentJsonlTail } = require('../../shared/bounded-jsonl-tail.cjs');

// Initialize free web search
const webSearch = new FreeWebSearch(console);
const readFile = promisify(fs.readFile);
const readdir = promisify(fs.readdir);

function loadMcpSdk() {
  return {
    Server: require('@modelcontextprotocol/sdk/server/index.js').Server,
    StreamableHTTPServerTransport: require('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport,
    ...require('@modelcontextprotocol/sdk/types.js'),
  };
}

// Configuration
const COSMO_ROOT = path.join(__dirname, '..');
const LOGS_DIR = process.env.COSMO_RUNTIME_DIR
  ? path.resolve(process.env.COSMO_RUNTIME_DIR)
  : path.join(COSMO_ROOT, 'runtime');
const THOUGHTS_FILE = path.join(LOGS_DIR, 'thoughts.jsonl');
const TOPICS_QUEUE = path.join(LOGS_DIR, 'topics-queue.json');
const ACTIONS_QUEUE = path.join(LOGS_DIR, 'actions-queue.json');
const COORDINATOR_DIR = path.join(LOGS_DIR, 'coordinator');

// Load COSMO configuration for file access control (mirrors filesystem MCP server behavior)
let COSMO_CONFIG = null;
let ALLOWED_PATHS = null;
const OWN_BRAIN_DIAGNOSTIC_TOOL_NAMES = Object.freeze([
  'get_system_state',
  'get_recent_thoughts',
  'query_memory',
  'get_active_goals',
  'get_agent_activity',
  'get_memory_statistics',
  'get_journal',
  'get_oscillator_mode',
  'get_memory_graph',
  'get_dreams',
]);
try {
  const configPath = path.join(COSMO_ROOT, 'src', 'config.yaml');
  if (fs.existsSync(configPath)) {
    COSMO_CONFIG = yaml.load(fs.readFileSync(configPath, 'utf8'));

    // Extract allowed paths from config structure: mcp.client.servers[0].allowedPaths
    const mcpServers = COSMO_CONFIG?.mcp?.client?.servers;
    if (mcpServers && mcpServers[0] && mcpServers[0].allowedPaths) {
      ALLOWED_PATHS = mcpServers[0].allowedPaths;
      console.error('📁 MCP HTTP file access paths:', ALLOWED_PATHS);
    } else {
      console.error('📁 MCP HTTP: no allowedPaths configured (full repository access)');
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
 * - If no allowedPaths are configured, fall back to full repository access
 *   (current default behavior, so this is non-breaking).
 * - If allowedPaths are present, the requested path must be under one of them.
 */
function isPathAllowedForRoots(requestedPath, allowedRoots) {
  const resolvedRequested = path.resolve(requestedPath);
  return allowedRoots.some((allowedRoot) => {
    const relative = path.relative(path.resolve(allowedRoot), resolvedRequested);
    return relative === ''
      || (relative !== '..'
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative));
  });
}

function isPathAllowed(relPath) {
  if (!ALLOWED_PATHS || ALLOWED_PATHS.length === 0) {
    return true; // No restrictions configured
  }

  // Resolve the requested path (supports both absolute and relative)
  const resolvedRequested = path.isAbsolute(relPath)
    ? path.resolve(relPath)  // Use absolute path as-is
    : path.resolve(COSMO_ROOT, relPath);  // Resolve relative to COSMO root

  const resolvedAllowedRoots = ALLOWED_PATHS.map(allowedPath => (
    path.isAbsolute(allowedPath)
      ? path.resolve(allowedPath)  // External absolute path
      : path.resolve(COSMO_ROOT, allowedPath) // COSMO-relative path
  ));
  return isPathAllowedForRoots(resolvedRequested, resolvedAllowedRoots);
}

async function readRecentThoughts(limit = 20, { signal } = {}) {
  return readRecentJsonlTail(THOUGHTS_FILE, { limit, signal });
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

function unsupportedScalarResult(state, capability, overrideMessage) {
  const projection = state?.scalarProjection || {};
  const advertised = projection.capabilities?.[capability];
  const error = advertised?.error || {
    code: 'snapshot_capability_unsupported',
    message: `${capability} is not projected by brain-snapshot`,
    retryable: false,
  };
  return {
    ok: false,
    status: 'unsupported',
    sourceHealth: projection.sourceHealth || 'degraded',
    capability,
    scalarProjection: {
      source: projection.source || 'brain-snapshot',
      sourceHealth: projection.sourceHealth || 'degraded',
      updatedAt: projection.updatedAt || null,
    },
    error: {
      code: error.code || 'snapshot_capability_unsupported',
      message: overrideMessage || error.message || `${capability} is not projected by brain-snapshot`,
      retryable: error.retryable === true,
    },
  };
}

async function buildInstalledBrainCatalog(home23Root) {
  const {
    buildCanonicalCatalog,
    parseReferenceRunsPaths,
  } = require('../../cosmo23/server/lib/brain-registry.js');
  const agentsPath = path.join(home23Root, 'config', 'agents.json');
  let manifest = [];
  if (fs.existsSync(agentsPath)) manifest = JSON.parse(fs.readFileSync(agentsPath, 'utf8'));
  if (!Array.isArray(manifest)) {
    throw Object.assign(new Error('catalog_configuration_invalid'), {
      code: 'catalog_configuration_invalid',
    });
  }
  const cosmoRoot = path.join(home23Root, 'cosmo23');
  const localRunsPath = path.join(cosmoRoot, 'runs');
  return buildCanonicalCatalog({
    instancesRoot: path.join(home23Root, 'instances'),
    localRunsPath,
    referenceRunsPaths: parseReferenceRunsPaths(
      process.env.COSMO_REFERENCE_RUNS_PATHS || process.env.COSMO_REFERENCE_RUNS_PATH || '',
      cosmoRoot,
      localRunsPath,
    ),
    configuredAgentNames: manifest.map((agent) => agent?.name),
    activeRunPath: path.join(cosmoRoot, 'runtime'),
  });
}

function createProductionMcpMemoryTools({
  brainDir = LOGS_DIR,
  home23Root = process.env.HOME23_ROOT,
  requesterAgent = process.env.HOME23_AGENT,
  createSearchService = createMemorySearchService,
  createOverlayCache = createMemoryDeltaOverlayCache,
  createDirectMemoryTools = createDefaultMcpMemoryTools,
  buildCatalog = () => buildInstalledBrainCatalog(home23Root),
  realpath = fs.promises.realpath,
  logger = console,
} = {}) {
  if (typeof createSearchService !== 'function' || typeof createOverlayCache !== 'function'
      || typeof createDirectMemoryTools !== 'function' || typeof buildCatalog !== 'function'
      || typeof realpath !== 'function') {
    throw Object.assign(new Error('MCP shared search dependencies required'), {
      code: 'mcp_source_context_required',
    });
  }
  const resolveTargetContext = async (selector = {}) => {
    if (selector && Object.keys(selector).length !== 0) {
      throw Object.assign(new Error('MCP source identity is server-derived'), {
        code: 'invalid_request', status: 400,
      });
    }
    const canonicalRoot = await realpath(brainDir);
    const catalog = await buildCatalog();
    const entries = catalog?.brains || catalog?.entries || catalog?.targets || [];
    const matches = entries.filter((entry) => (
      entry?.canonicalRoot === canonicalRoot || entry?.target?.canonicalRoot === canonicalRoot
    ) && (entry?.target?.ownerAgent || entry?.ownerAgent) === requesterAgent
      && (entry?.target?.kind || entry?.kind) === 'resident');
    if (matches.length !== 1) {
      throw Object.assign(new Error(matches.length > 1
        ? 'ambiguous local source context' : 'local source missing from canonical catalog'), {
        code: 'source_changed', retryable: true,
      });
    }
    const target = matches[0]?.target || matches[0];
    return Object.freeze({
      catalogRevision: catalog.catalogRevision || catalog.revision || 'local',
      accessMode: 'own',
      target: Object.freeze({ ...target, canonicalRoot }),
    });
  };
  const nodeOverlayProvider = createOverlayCache({
    cacheRoot: path.join(home23Root, 'instances', requesterAgent, 'runtime', 'cache'),
  });
  if (!nodeOverlayProvider || typeof nodeOverlayProvider.refresh !== 'function') {
    throw Object.assign(new Error('MCP overlay provider required'), {
      code: 'mcp_source_context_required',
    });
  }
  const searchService = createSearchService({
    brainDir,
    home23Root,
    requesterAgent,
    resolveTargetContext,
    logger,
    deltaOverlayCache: nodeOverlayProvider,
  });
  if (!searchService || typeof searchService.search !== 'function') {
    throw Object.assign(new Error('MCP shared search service required'), {
      code: 'mcp_source_context_required',
    });
  }
  const memoryTools = createDirectMemoryTools({
    brainDir,
    home23Root,
    requesterAgent,
    logger,
    resolveTargetContext,
    searchMemory: (request) => searchService.search(request),
    nodeOverlayProvider,
  });
  let closePromise = null;
  return Object.freeze({
    ...memoryTools,
    close() {
      closePromise ||= Promise.resolve().then(() => searchService.close?.());
      return closePromise;
    },
  });
}

// Create MCP server
function createMCPServer(options = {}) {
  const memoryTools = options.memoryTools;
  const readScalarState = options.readScalarState;
  const signal = options.signal;
  const readThoughts = options.readRecentThoughts || readRecentThoughts;
  const allowedToolNames = options.allowedToolNames === undefined
    ? null
    : new Set(options.allowedToolNames);
  if (allowedToolNames
      && ([...allowedToolNames].some((name) => typeof name !== 'string' || !name)
        || allowedToolNames.size === 0)) {
    throw Object.assign(new Error('MCP tool allowlist is invalid'), {
      code: 'mcp_tool_allowlist_invalid',
    });
  }
  if (!memoryTools || typeof memoryTools.queryMemory !== 'function'
      || typeof memoryTools.getMemoryStatistics !== 'function'
      || typeof memoryTools.getMemoryGraph !== 'function'
      || typeof memoryTools.getSystemState !== 'function'
      || typeof readScalarState !== 'function') {
    throw Object.assign(new Error('MCP memory source dependencies required'), {
      code: 'mcp_source_context_required',
    });
  }
  const {
    Server,
    CallToolRequestSchema,
    ListToolsRequestSchema,
  } = options.sdk || loadMcpSdk();
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
    const response = {
      tools: [
        {
          name: 'get_system_state',
          description: 'Get bounded own-brain read-only diagnostics. Snapshot-only fields include explicit capability metadata; use durable brain operations for direct, cross-brain, or PGS work.',
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
          description: 'Run a bounded read-only keyword query against this server agent\'s own brain. Use durable brain operations for direct, cross-brain, or PGS work.',
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
              tag: {
                type: 'string',
                description: 'Optional exact tag filter',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'get_active_goals',
          description: 'Get bounded active-goal summaries when projected by the own-brain snapshot; unavailable goal collections return explicit unsupported state.',
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
          description: 'Get own-brain agent activity only when the bounded snapshot advertises that capability; otherwise returns explicit unsupported state.',
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
          description: 'Get bounded read-only statistics for this server agent\'s own canonical brain.',
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
                enum: ['research', 'analysis', 'synthesis', 'exploration', 'code_creation', 'code_execution', 'document_creation', 'document_analysis', 'quality_assurance', 'planning', 'integration'],
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
          description: 'Get own-brain journal entries only when the bounded snapshot advertises that capability; otherwise returns explicit unsupported state.',
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
          description: 'Get own-brain oscillator state only when the bounded snapshot advertises that capability; otherwise returns explicit unsupported state.',
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
          description: 'Get a bounded read-only graph projection from this server agent\'s own brain. Use durable brain operations for direct, cross-brain, PGS, or complete graph work.',
          inputSchema: {
            type: 'object',
            properties: {
              nodeLimit: {
                type: 'integer',
                description: 'Max nodes (default: 200, range: 1-2000)',
                default: 200,
                minimum: 1,
                maximum: 2000,
              },
              edgeLimit: {
                type: 'integer',
                description: 'Max connecting edges (default: 800, range: 0-8000)',
                default: 800,
                minimum: 0,
                maximum: 8000,
              },
              clusterId: {
                type: ['string', 'number'],
                description: 'Optional cluster filter',
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_dreams',
          description: 'Get own-brain dream records only when the bounded snapshot advertises that capability; otherwise returns explicit unsupported state.',
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
    if (allowedToolNames === null) return response;
    return { tools: response.tools.filter((tool) => allowedToolNames.has(tool.name)) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    
    try {
      if (allowedToolNames !== null && !allowedToolNames.has(name)) {
        throw new Error(`MCP tool is not available on this transport: ${name}`);
      }
      let result;
      
      switch (name) {
        case 'get_system_state': {
          result = await memoryTools.getSystemState({ signal });
          break;
        }
        
        case 'get_recent_thoughts': {
          const limit = Math.min(args.limit || 20, 100);
          const thoughts = await readThoughts(limit, { signal });
          result = { count: thoughts.length, thoughts };
          break;
        }
        
        case 'query_memory': {
          result = await memoryTools.queryMemory({
            query: args.query,
            limit: args.limit ?? 10,
            tag: args.tag ?? null,
            signal,
          });
          break;
        }
        
        case 'get_active_goals': {
          const state = await readScalarState();
          const status = args.status || 'active';
          const limit = args.limit || 20;
          const capability = state.scalarProjection?.capabilities?.goals;
          const activeAvailable = capability?.status === 'degraded'
            && capability.available?.includes('activeSummaries')
            && Array.isArray(state.goals?.active);
          if (status !== 'active' || !activeAvailable) {
            result = unsupportedScalarResult(
              state,
              'goals',
              status === 'active'
                ? undefined
                : `brain-snapshot does not project ${status} goal entries`,
            );
            break;
          }
          
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
            ok: true,
            status: 'degraded',
            sourceHealth: state.scalarProjection.sourceHealth,
            filter: status,
            count: goals.length,
            goals: goals.slice(0, limit),
            scalarProjection: state.scalarProjection,
          };
          break;
        }
        
        case 'get_agent_activity': {
          const state = await readScalarState();
          if (state.scalarProjection?.capabilities?.agentActivity?.status !== 'supported') {
            result = unsupportedScalarResult(state, 'agentActivity');
            break;
          }
          
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
          result = await memoryTools.getMemoryStatistics({ signal });
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
          
          const validAgentTypes = ['research', 'analysis', 'synthesis', 'exploration', 'code_creation', 'code_execution', 'document_creation', 'document_analysis', 'quality_assurance', 'planning', 'integration', 'document_compiler'];
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
            message: `Queued ${args.agentType} agent spawn. Will be processed by orchestrator.`
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
            message: `Queued goal creation. Will be processed by orchestrator.`
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
          const state = await readScalarState();
          if (state.scalarProjection?.capabilities?.journal?.status !== 'supported') {
            result = unsupportedScalarResult(state, 'journal');
            break;
          }
          const limit = args.limit || 20;
          const journal = state.journal || [];
          result = {
            totalEntries: journal.length,
            entries: journal.slice(-limit).reverse()
          };
          break;
        }
        
        case 'get_oscillator_mode': {
          const state = await readScalarState();
          if (state.scalarProjection?.capabilities?.oscillator?.status !== 'supported') {
            result = unsupportedScalarResult(state, 'oscillator');
            break;
          }
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
          result = await memoryTools.getMemoryGraph({
            nodeLimit: args.nodeLimit ?? 200,
            edgeLimit: args.edgeLimit ?? 800,
            clusterId: args.clusterId ?? null,
            signal,
          });
          break;
        }
        
        case 'get_dreams': {
          const state = await readScalarState();
          if (state.scalarProjection?.capabilities?.dreams?.status !== 'supported') {
            result = unsupportedScalarResult(state, 'dreams');
            break;
          }
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
          const fullPath = path.resolve(COSMO_ROOT, relPath);
          
          // Security: prevent path traversal
          if (!fullPath.startsWith(COSMO_ROOT)) {
            throw new Error('Access denied: path outside repository');
          }

          // Check file access permissions based on configuration
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
          const fullPath = path.resolve(COSMO_ROOT, relPath);
          
          // Security: prevent path traversal
          if (!fullPath.startsWith(COSMO_ROOT)) {
            throw new Error('Access denied: path outside repository');
          }

          // Check file access permissions based on configuration
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
          const fullPath = path.resolve(COSMO_ROOT, relPath);
          
          // Security: prevent path traversal
          if (!fullPath.startsWith(COSMO_ROOT)) {
            throw new Error('Access denied: path outside repository');
          }

          // Check file access permissions based on configuration
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
          const fullPath = path.resolve(COSMO_ROOT, relPath);
          
          // Security: prevent path traversal
          if (!fullPath.startsWith(COSMO_ROOT)) {
            throw new Error('Access denied: path outside repository');
          }

          // Check file access permissions based on configuration
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
          console.error(`[MCP] Web search: "${query}" (max ${maxResults} results)`);

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
        ],
        ...((result?.ok === false || result?.success === false) ? { isError: true } : {}),
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

function createOwnBrainMCPServer(options = {}) {
  return createMCPServer({
    ...options,
    allowedToolNames: OWN_BRAIN_DIAGNOSTIC_TOOL_NAMES,
  });
}

function createMcpHttpApp(options = {}) {
  // Load the execution runtime before advertising a listener. Missing SDK
  // dependencies must fail process startup instead of producing a false-green
  // health endpoint that cannot execute tools.
  const sdk = options.sdk || loadMcpSdk();
  const memoryTools = options.memoryTools || createProductionMcpMemoryTools({
    logger: options.logger || console,
  });
  const readScalarState = options.readScalarState
    || createSnapshotScalarStateReader({ brainDir: LOGS_DIR });
  const readiness = options.readiness || createMcpReadinessController({
    memoryTools,
    logger: options.logger || console,
  });
  const app = express();
  app.locals.mcpReadiness = readiness;
  app.locals.mcpMemoryTools = memoryTools;
  app.locals.mcpLogger = options.logger || console;
  
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
  
  // MCP control messages are bounded. Large artifacts travel through the
  // existing file/operation paths rather than being buffered as request JSON.
  const requestBodyLimit = options.requestBodyLimit || '16mb';
  app.use(express.json({ limit: requestBodyLimit, strict: true }));
  app.use(express.urlencoded({ limit: requestBodyLimit, extended: true }));
  app.use((error, _req, res, next) => {
    if (error?.type !== 'entity.too.large') return next(error);
    return res.status(413).json({
      jsonrpc: '2.0',
      error: { code: -32600, message: 'MCP request body exceeds limit' },
      id: null,
    });
  });

  app.get('/health', (_req, res) => {
    const status = readiness.status();
    res.status(status.ok ? 200 : 503).json(status);
  });

  // POST /mcp - handle all MCP requests (stateless)
  app.post('/mcp', async (req, res) => {
    const { StreamableHTTPServerTransport } = sdk;
    const requestController = new AbortController();
    // Stateless: create new server + transport for each request
    const server = createMCPServer({
      memoryTools,
      readScalarState,
      readRecentThoughts: options.readRecentThoughts,
      signal: requestController.signal,
      sdk,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined  // Stateless mode
    });
    
    let requestComplete = false;
    
    res.on('close', () => {
      if (!requestComplete) {
        console.error('MCP: Client disconnected before request complete');
        requestController.abort(Object.assign(new Error('MCP client disconnected'), {
          name: 'AbortError',
          code: 'cancelled',
        }));
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
  return app;
}

function assertLoopbackHost(host) {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw Object.assign(new Error('MCP HTTP must bind to loopback'), {
      code: 'invalid_mcp_host',
    });
  }
}

function startMcpHttpServer(options = {}) {
  const host = options.host ?? process.env.MCP_HTTP_HOST ?? '127.0.0.1';
  assertLoopbackHost(host);
  const port = options.port ?? Number(process.env.MCP_HTTP_PORT || 3335);
  const app = options.app || createMcpHttpApp(options);
  const server = app.listen(port, host, () => {
    if (options.log !== false) {
      console.error(`✅ Cosmo MCP Server (Streamable HTTP) on http://${host}:${server.address().port}/mcp`);
      console.error(`   Logs: ${LOGS_DIR}`);
    }
  });
  server.once('close', () => {
    app.locals.mcpReadiness?.close?.();
    void Promise.resolve().then(() => app.locals.mcpMemoryTools?.close?.()).catch((error) => {
      app.locals.mcpLogger?.warn?.('[MCP] canonical memory tools close failed', {
        error: error.message,
      });
    });
  });
  return server;
}

// Start HTTP server - Stateless mode per SDK docs
async function main() {
  startMcpHttpServer({ port: process.argv[2] || undefined });
}

if (require.main === module) {
  main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = {
  OWN_BRAIN_DIAGNOSTIC_TOOL_NAMES,
  assertLoopbackHost,
  createMCPServer,
  createOwnBrainMCPServer,
  createProductionMcpMemoryTools,
  createMcpHttpApp,
  isPathAllowedForRoots,
  startMcpHttpServer,
};
