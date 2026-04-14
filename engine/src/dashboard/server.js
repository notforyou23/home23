const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { createReadStream } = require('fs');
const { createInterface } = require('readline');
const zlib = require('zlib');
const crypto = require('crypto');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);
const { StateCompression } = require('../core/state-compression');
const { InsightAnalyzer } = require('./insight-analyzer');
const { NoveltyValidator } = require('./novelty-validator');
const { QueryEngine } = require('./query-engine');
const { IntelligenceBuilder } = require('./intelligence-builder');
const { ClusterDataProxy } = require('../cluster/cluster-data-proxy');
const { MissionTracer } = require('../../scripts/TRACE_RESEARCH_MISSIONS');
const { Home23VibeService } = require('./home23-vibe/service');
const { Home23TileService } = require('./home23-tiles');

/**
 * Phase 2B Dashboard Server
 * Real-time visualization of all Phase 2B features
 */
class DashboardServer {
  constructor(port = 3344, logsDir) {
    this.port = port;
    this.mcpPort = parseInt(process.env.MCP_HTTP_PORT || process.env.MCP_PORT || 3347);
    this.runsDir = process.env.COSMO_RUNS_DIR
      ? path.resolve(process.env.COSMO_RUNS_DIR)
      : path.resolve(__dirname, '..', '..', '..', 'runs');
    // COSMO_RUNTIME_DIR allows per-instance runtime isolation (cosmo-home multi-family)
    const runtimeEnv = process.env.COSMO_RUNTIME_DIR;
    this.defaultRunDir = runtimeEnv
      ? path.resolve(runtimeEnv)
      : path.resolve(__dirname, '..', '..', '..', 'runtime');
    
    // Default to GPT-5.2 logs, fallback to regular logs
    this.logsDir = logsDir || this.detectLogsDirectory();
    this.currentRun = runtimeEnv ? path.basename(this.defaultRunDir) : 'runtime'; // Track current run name
    this.currentRunMetadata = null;
    
    this.app = express();

    // Enable CORS for local development (cosmo-lab.html served from different port)
    this.app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // COSMO is a local research system - no artificial limits on data ingestion
    // Set to 10GB to handle serious document collections, large queries, and AI analysis
    // This is a LOCAL system, not a public API - memory constraints come from OS, not app limits
    this.app.use(express.json({ limit: '10gb' }));
    this.app.use(express.urlencoded({ limit: '10gb', extended: true }));
    this.clients = new Set();
    this.insightAnalyzer = new InsightAnalyzer(this.logsDir, console);
    this.noveltyValidator = new NoveltyValidator({}, console, this.logsDir); // NEW: Novelty validation layer with logsDir
    this.intelligenceBuilder = new IntelligenceBuilder(this.runsDir, this.defaultRunDir);
    
    // Load OpenAI key from environment
    require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
    this.queryEngine = new QueryEngine(this.logsDir, process.env.OPENAI_API_KEY);
    
    // Orchestrator reference (for query actions)
    this.orchestrator = null;
    
    // Console log streaming clients (SSE)
    this.logStreamClients = new Set();
    this.metadataErrorCache = new Set();
    this.homeSummaryCache = { data: null, expiresAt: 0 };
    
    // Logger for route handlers - using console for consistency
    this.logger = console;
    this.home23Tiles = new Home23TileService({
      home23Root: this.getHome23Root(),
      logger: this.logger,
    });
    this.home23Vibe = new Home23VibeService({
      home23Root: this.getHome23Root(),
      agentName: this.getHome23AgentName(),
      loadState: () => this.loadState(),
      getRecentThoughts: (limit) => this.getRecentThoughts(limit),
      logger: this.logger,
    });
    
    this.setupRoutes();
  }

  /**
   * Set orchestrator reference (enables query command center actions)
   */
  setOrchestrator(orchestrator) {
    this.orchestrator = orchestrator;
    console.log('[DashboardServer] Orchestrator reference set - query actions enabled');
  }

  /**
   * Load config from a run directory (for local LLM support)
   * Checks metadata.json for local LLM settings and constructs config object
   * @param {string} runDir - Run directory path
   * @param {string|null} backendOverride - Force backend: 'openai', 'local', or null for auto-detect
   */
  async loadRunConfig(runDir, backendOverride = null) {
    try {
      const metadataPath = path.join(runDir, 'metadata.json');
      const metadataContent = await fs.readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent);

      // Determine if we should use local LLM
      // Priority: backendOverride > run's metadata setting
      let useLocalLlm;
      if (backendOverride === 'openai') {
        useLocalLlm = false;
      } else if (backendOverride === 'local') {
        useLocalLlm = true;
      } else {
        // Auto-detect from run's metadata
        useLocalLlm = metadata.enableLocalLlm || false;
      }

      if (useLocalLlm) {
        return {
          providers: {
            local: {
              enabled: true,
              baseURL: metadata.localLlmBaseUrl || process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1',
              defaultModel: metadata.localLlmDefaultModel || 'qwen2.5:14b',
              modelMapping: {
                'gpt-5.2': metadata.localLlmDefaultModel || 'qwen2.5:14b',
                'gpt-5': metadata.localLlmDefaultModel || 'qwen2.5:14b',
                'gpt-5-mini': metadata.localLlmFastModel || 'qwen2.5:14b'
              }
            }
          },
          modelAssignments: {
            default: {
              provider: 'local',
              model: metadata.localLlmDefaultModel || 'qwen2.5:14b'
            }
          },
          _backendOverride: backendOverride // Track if override was used
        };
      }

      // Use OpenAI (either by override or run default)
      return null;
    } catch (error) {
      // No metadata or error loading
      // If override is 'local', try to use local with defaults
      if (backendOverride === 'local') {
        return {
          providers: {
            local: {
              enabled: true,
              baseURL: process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1',
              defaultModel: 'qwen2.5:14b',
              modelMapping: {
                'gpt-5.2': 'qwen2.5:14b',
                'gpt-5': 'qwen2.5:14b',
                'gpt-5-mini': 'qwen2.5:14b'
              }
            }
          },
          modelAssignments: {
            default: {
              provider: 'local',
              model: 'qwen2.5:14b'
            }
          }
        };
      }
      return null;
    }
  }

  /**
   * Get run's LLM backend info (for UI indicator)
   */
  async getRunBackendInfo(runDir) {
    try {
      const metadataPath = path.join(runDir, 'metadata.json');
      const metadataContent = await fs.readFile(metadataPath, 'utf-8');
      const metadata = JSON.parse(metadataContent);

      return {
        runBackend: metadata.enableLocalLlm ? 'local' : 'openai',
        localConfig: metadata.enableLocalLlm ? {
          baseUrl: metadata.localLlmBaseUrl || 'http://localhost:11434/v1',
          defaultModel: metadata.localLlmDefaultModel || 'qwen2.5:14b',
          fastModel: metadata.localLlmFastModel || 'qwen2.5:14b'
        } : null
      };
    } catch (error) {
      return {
        runBackend: 'openai',
        localConfig: null
      };
    }
  }

  /**
   * Broadcast log to all connected console stream clients
   */
  broadcastLog(level, message, meta = {}) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level: level,
      message: message,
      meta: meta
    };

    const data = `data: ${JSON.stringify(logEntry)}\n\n`;
    
    this.logStreamClients.forEach(client => {
      try {
        client.write(data);
      } catch (error) {
        // Client disconnected, will be cleaned up
        this.logStreamClients.delete(client);
      }
    });
  }

  /**
   * Detect which logs directory to use
   * ALWAYS prefer runtime if it exists (current system)
   */
  detectLogsDirectory() {
    const gpt5Dir = this.defaultRunDir;
    const regularDir = this.defaultRunDir;
    
    const fs = require('fs');
    
    // ALWAYS use runtime if directory exists
    // This is the current system, runtime is legacy
    if (fs.existsSync(gpt5Dir)) {
      console.log('Using runtime/ (current system)');
      return gpt5Dir;
    } else if (fs.existsSync(regularDir)) {
      console.log('Using runtime/ (legacy fallback)');
      return regularDir;
    } else {
      // Default to gpt5
      console.log('No logs found, defaulting to runtime/');
      return gpt5Dir;
    }
  }

  safeParseMetadata(rawContent, filePath = '') {
    try {
      const clean = (rawContent || '').replace(/^\uFEFF/, '').trim();
      if (!clean) {
        throw new Error('empty metadata');
      }
      return JSON.parse(clean);
    } catch (error) {
      const cacheKey = `${filePath}:${error.message}`;
      if (!this.metadataErrorCache.has(cacheKey)) {
        this.metadataErrorCache.add(cacheKey);
        console.warn(`[Dashboard] Metadata parse error${filePath ? ` (${filePath})` : ''}: ${error.message}`);
      }
      return null;
    }
  }

  /**
   * List all available runs
   */
  async listAvailableRuns() {
    const runs = [];
    
    try {
      const fsPromises = require('fs').promises;
      const fsSync = require('fs');
      
      // Check if runs directory exists
      if (!fsSync.existsSync(this.runsDir)) {
        return runs;
      }
      
      const entries = await fsPromises.readdir(this.runsDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const runPath = path.join(this.runsDir, entry.name);
          const statePath = path.join(runPath, 'state.json.gz');
          const metadataPath = path.join(runPath, 'run-metadata.json');
          
          // Check if this looks like a valid run
          const hasState = fsSync.existsSync(statePath);
          if (hasState) {
            let metadata = null;
            try {
              const metadataContent = await fsPromises.readFile(metadataPath, 'utf-8');
              metadata = this.safeParseMetadata(metadataContent, metadataPath);
            } catch (error) {
              // Metadata might not exist or be invalid
              metadata = null;
            }
            
            // Get state file stats
            const stats = await fsPromises.stat(statePath);
            
            runs.push({
              name: entry.name,
              path: runPath,
              metadata: metadata,
              sizeKB: Math.round(stats.size / 1024),
              created: metadata?.created || stats.birthtime
            });
          }
        }
      }
      
      // Sort by creation date (newest first)
      runs.sort((a, b) => {
        const dateA = new Date(a.created);
        const dateB = new Date(b.created);
        return dateB - dateA;
      });
      
    } catch (error) {
      console.error('Error listing runs:', error.message);
    }
    
    return runs;
  }

  /**
   * Get current runtime metadata
   */
  async getCurrentRuntimeMetadata() {
    try {
      const fsPromises = require('fs').promises;
      const metadataPath = path.join(this.defaultRunDir, 'run-metadata.json');
      const metadataContent = await fsPromises.readFile(metadataPath, 'utf-8');
      return JSON.parse(metadataContent);
    } catch (error) {
      return null;
    }
  }

  /**
   * Switch to a different run
   */
  async switchToRun(runName) {
    const fsSync = require('fs');
    
    if (runName === 'runtime' || runName === 'current') {
      this.logsDir = this.defaultRunDir;
      this.currentRun = 'runtime';
      this.currentRunMetadata = await this.getCurrentRuntimeMetadata();
    } else {
      const runPath = path.join(this.runsDir, runName);
      const statePath = path.join(runPath, 'state.json.gz');
      
      // Verify run exists
      if (!fsSync.existsSync(statePath)) {
        throw new Error(`Run "${runName}" not found or invalid`);
      }
      
      this.logsDir = runPath;
      this.currentRun = runName;
      
      // Load metadata
      try {
        const fsPromises = require('fs').promises;
        const metadataPath = path.join(runPath, 'run-metadata.json');
        const metadataContent = await fsPromises.readFile(metadataPath, 'utf-8');
        this.currentRunMetadata = JSON.parse(metadataContent);
      } catch (error) {
        this.currentRunMetadata = null;
      }
    }
    
    // Update dependent components
    this.insightAnalyzer = new InsightAnalyzer(this.logsDir, console);
    this.noveltyValidator = new NoveltyValidator({}, console, this.logsDir);
    this.queryEngine = new QueryEngine(this.logsDir, process.env.OPENAI_API_KEY);
    
    return {
      run: this.currentRun,
      metadata: this.currentRunMetadata
    };
  }

  /**
   * Get statistics for a specific run
   */
  async getRunStats(runDir) {
    const fsPromises = require('fs').promises;
    const fsSync = require('fs');
    const stats = {
      cycles: 0,
      memoryNodes: 0,
      goals: { active: 0, completed: 0 },
      agents: { total: 0, completed: 0, failed: 0, timeout: 0 },
      coordinatorReviews: 0,
      latestReview: null
    };

    try {
      // Get memory node count from state
      const statePath = path.join(runDir, 'state.json.gz');
      if (fsSync.existsSync(statePath)) {
        // Check file size before attempting to load (skip files > 100MB)
        const fileStats = fsSync.statSync(statePath);
        const maxSize = 250 * 1024 * 1024; // 250MB limit

        // For large states (terrapin), use pre-generated dashboard cache
        const cachePath = path.join(runDir, 'dashboard-cache.json');
        if (fileStats.size > 100 * 1024 * 1024 && require('fs').existsSync(cachePath)) {
          try {
            const cache = JSON.parse(require('fs').readFileSync(cachePath, 'utf8'));
            stats.cycles = cache.cycleCount || 0;
            stats.memoryNodes = cache.nodeCount || 0;
            stats.goals.active = cache.goalsActive || 0;
            stats.goals.completed = 0;
            return stats;
          } catch (e) { /* fall through to normal load */ }
        }
        
        if (fileStats.size > maxSize) {
          console.warn(`Skipping large state file (${fileStats.size} bytes) for ${runDir}`);
          // Try to get cycle count from metrics instead
          const metricsPath = path.join(runDir, 'evaluation-metrics.json');
          if (fsSync.existsSync(metricsPath)) {
            const metrics = JSON.parse(fsSync.readFileSync(metricsPath, 'utf8'));
            stats.cycles = metrics.totalCycles || 0;
            stats.memoryNodes = metrics.totalNodes || 0;
            stats.goals.active = metrics.activeGoals || 0;
            stats.goals.completed = metrics.completedGoals || 0;
          }
        } else {
          const compressed = await fsPromises.readFile(statePath);
          const decompressed = await gunzip(compressed);
          const state = JSON.parse(decompressed.toString());
          
          stats.cycles = state.cycleCount || 0;
          stats.memoryNodes = state.memory?.nodes?.length || 0;
          stats.goals.active = state.goals?.active?.length || 0;
          stats.goals.completed = (state.goals?.all || []).filter(g => g.status === 'completed').length;
        }
      }

      // Count coordinator reviews
      const coordinatorDir = path.join(runDir, 'coordinator');
      if (fsSync.existsSync(coordinatorDir)) {
        const files = await fsPromises.readdir(coordinatorDir);
        const reviews = files.filter(f => f.startsWith('review_') && f.endsWith('.md'));
        stats.coordinatorReviews = reviews.length;
        
        // Get latest review
        if (reviews.length > 0) {
          const sorted = reviews.sort((a, b) => {
            const numA = parseInt(a.match(/review_(\d+)/)?.[1] || 0);
            const numB = parseInt(b.match(/review_(\d+)/)?.[1] || 0);
            return numB - numA;
          });
          stats.latestReview = sorted[0];
        }
      }

      // Count agents from results queue
      const resultsPath = path.join(runDir, 'coordinator', 'results_queue.jsonl');
      if (fsSync.existsSync(resultsPath)) {
        const content = await fsPromises.readFile(resultsPath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l);
        stats.agents.total = lines.length;
        
        lines.forEach(line => {
          try {
            const result = JSON.parse(line);
            if (result.status === 'completed') stats.agents.completed++;
            if (result.status === 'failed') stats.agents.failed++;
            if (result.status === 'timeout') stats.agents.timeout++;
          } catch (e) {
            // Skip invalid lines
          }
        });
      }

    } catch (error) {
      console.error('Error getting run stats:', error.message);
    }

    return stats;
  }

  /**
   * Parse coordinator review metadata from markdown content
   */
  parseReviewMetadata(content, filename) {
    const metadata = {
      filename: filename,
      cycle: 0,
      cyclesReviewed: '',
      cyclesCount: 0,
      date: '',
      duration: '',
      thoughtsAnalyzed: 0,
      goalsEvaluated: 0,
      memoryNodes: 0,
      memoryEdges: 0,
      quality: { depth: 0, novelty: 0, coherence: 0 }
    };

    // Extract cycle from filename
    const cycleMatch = filename.match(/review_(\d+)/);
    if (cycleMatch) {
      metadata.cycle = parseInt(cycleMatch[1]);
    }

    // Parse header section
    const lines = content.split('\n');
    for (let i = 0; i < Math.min(lines.length, 50); i++) {
      const line = lines[i];
      
      if (line.includes('**Date:**')) {
        const dateMatch = line.match(/\*\*Date:\*\* (.+)/);
        if (dateMatch) metadata.date = dateMatch[1].trim();
      }
      
      if (line.includes('**Cycles Reviewed:**')) {
        const cyclesMatch = line.match(/\*\*Cycles Reviewed:\*\* (.+)/);
        if (cyclesMatch) {
          const cyclesInfo = cyclesMatch[1].trim();
          metadata.cyclesReviewed = cyclesInfo;
          const countMatch = cyclesInfo.match(/\((\d+) cycles?\)/);
          if (countMatch) metadata.cyclesCount = parseInt(countMatch[1]);
        }
      }
      
      if (line.includes('**Duration:**')) {
        const durMatch = line.match(/\*\*Duration:\*\* (.+)/);
        if (durMatch) metadata.duration = durMatch[1].trim();
      }
      
      if (line.includes('- Thoughts Analyzed:')) {
        const thoughtsMatch = line.match(/- Thoughts Analyzed: (\d+)/);
        if (thoughtsMatch) metadata.thoughtsAnalyzed = parseInt(thoughtsMatch[1]);
      }
      
      if (line.includes('- Goals Evaluated:')) {
        const goalsMatch = line.match(/- Goals Evaluated: (\d+)/);
        if (goalsMatch) metadata.goalsEvaluated = parseInt(goalsMatch[1]);
      }
      
      if (line.includes('- Memory Nodes:')) {
        const nodesMatch = line.match(/- Memory Nodes: (\d+)/);
        if (nodesMatch) metadata.memoryNodes = parseInt(nodesMatch[1]);
      }
      
      if (line.includes('- Memory Edges:')) {
        const edgesMatch = line.match(/- Memory Edges: (\d+)/);
        if (edgesMatch) metadata.memoryEdges = parseInt(edgesMatch[1]);
      }
    }

    // Try to extract quality scores from content (format: "- Depth: 7 —")
    const depthMatch = content.match(/[-•]\s*Depth:\s*(\d+)/i);
    if (depthMatch) metadata.quality.depth = parseInt(depthMatch[1]);
    
    const noveltyMatch = content.match(/[-•]\s*Novelty:\s*(\d+)/i);
    if (noveltyMatch) metadata.quality.novelty = parseInt(noveltyMatch[1]);
    
    const coherenceMatch = content.match(/[-•]\s*Coherence:\s*(\d+)/i);
    if (coherenceMatch) metadata.quality.coherence = parseInt(coherenceMatch[1]);

    return metadata;
  }

  /**
   * Parse coordinator review into sections
   */
  parseReviewSections(content) {
    const sections = {
      summary: '',
      cognitiveWorkAnalysis: '',
      goalPortfolio: '',
      strategicRecommendations: '',
      decisions: ''
    };

    // Split by headers and extract sections
    const summaryMatch = content.match(/## Summary\n([\s\S]*?)(?=\n## |$)/);
    if (summaryMatch) sections.summary = summaryMatch[1].trim();

    const cognitiveMatch = content.match(/## Cognitive Work Analysis\n([\s\S]*?)(?=\n## |$)/);
    if (cognitiveMatch) sections.cognitiveWorkAnalysis = cognitiveMatch[1].trim();

    const goalMatch = content.match(/## Goal Portfolio Evaluation\n([\s\S]*?)(?=\n## |$)/);
    if (goalMatch) sections.goalPortfolio = goalMatch[1].trim();

    const stratMatch = content.match(/## Strategic Recommendations\n([\s\S]*?)(?=\n## |$)/);
    if (stratMatch) sections.strategicRecommendations = stratMatch[1].trim();

    const decisionsMatch = content.match(/## Decisions Made\n([\s\S]*?)(?=\n## |$)/);
    if (decisionsMatch) sections.decisions = decisionsMatch[1].trim();

    return sections;
  }

  /**
   * Parse curated insight metadata from markdown content
   */
  parseInsightMetadata(content, filename) {
    const metadata = {
      filename: filename,
      cycle: null,
      date: '',
      mode: '',
      rawInsights: 0,
      highValue: 0,
      duration: '',
      activeGoals: 0
    };

    // Extract cycle from filename
    const cycleMatch = filename.match(/insights_curated_cycle_(\d+)/);
    if (cycleMatch) {
      metadata.cycle = parseInt(cycleMatch[1]);
    }

    // Parse header section
    const lines = content.split('\n');
    for (let i = 0; i < Math.min(lines.length, 50); i++) {
      const line = lines[i];
      
      if (line.includes('**Curation Mode:**')) {
        const modeMatch = line.match(/\*\*Curation Mode:\*\* (.+)/);
        if (modeMatch) metadata.mode = modeMatch[1].trim();
      }
      
      if (line.includes('**Raw Insights Generated:**')) {
        const rawMatch = line.match(/\*\*Raw Insights Generated:\*\* (\d+)/);
        if (rawMatch) metadata.rawInsights = parseInt(rawMatch[1]);
      }
      
      if (line.includes('**High-Value Insights Identified:**')) {
        const hvMatch = line.match(/\*\*High-Value Insights Identified:\*\* (\d+)/);
        if (hvMatch) metadata.highValue = parseInt(hvMatch[1]);
      }
      
      if (line.includes('**Curation Duration:**')) {
        const durMatch = line.match(/\*\*Curation Duration:\*\* (.+)/);
        if (durMatch) metadata.duration = durMatch[1].trim();
      }
      
      if (line.includes('**Active Goals:**') && line.includes('[')) {
        const goalsMatch = line.match(/\[(\d+) goals?\]/);
        if (goalsMatch) metadata.activeGoals = parseInt(goalsMatch[1]);
      }
    }

    // Try to extract date from header
    const dateMatch = content.match(/## (\d{1,2}\/\d{1,2}\/\d{4})/);
    if (dateMatch) {
      metadata.date = dateMatch[1];
    }

    return metadata;
  }

  /**
   * Validate filesystem path for safety
   * Prevents path traversal attacks and ensures path is within workspace
   */
  isFilesystemPathSafe(filePath) {
    if (!filePath || typeof filePath !== 'string') {
      return false;
    }
    
    // Reject path traversal attempts
    if (filePath.includes('..')) {
      return false;
    }
    
    // Reject absolute paths outside workspace (basic check)
    // Note: For Documentation IDE, we allow paths within the project
    const normalized = path.normalize(filePath);
    
    // Reject attempts to access sensitive system paths
    const forbidden = ['/etc/', '/var/', '/usr/', '/bin/', '/sbin/', '/root/', '/home/'];
    for (const prefix of forbidden) {
      if (normalized.startsWith(prefix)) {
        return false;
      }
    }
    
    return true;
  }

  getHome23Root() {
    return process.env.HOME23_ROOT
      || (process.env.COSMO_RUNTIME_DIR
        ? path.resolve(process.env.COSMO_RUNTIME_DIR, '..', '..', '..')
        : path.resolve(__dirname, '..', '..', '..'));
  }

  getHome23AgentName() {
    if (process.env.HOME23_AGENT) return process.env.HOME23_AGENT;
    if (process.env.COSMO_WORKSPACE_PATH) {
      return path.basename(path.dirname(path.resolve(process.env.COSMO_WORKSPACE_PATH)));
    }
    if (process.env.COSMO_RUNTIME_DIR) {
      return path.basename(path.dirname(path.resolve(process.env.COSMO_RUNTIME_DIR)));
    }
    return 'agent';
  }

  setupRoutes() {
    this.app.use(express.static(path.join(__dirname)));

    // Home23 — first-run detection: welcome screen or dashboard
    this.app.get('/home23', (req, res) => {
      const fsSync = require('fs');
      const home23Root = this.getHome23Root();
      const instancesDir = path.join(home23Root, 'instances');
      let hasAgents = false;
      if (fsSync.existsSync(instancesDir)) {
        hasAgents = fsSync.readdirSync(instancesDir).some(name => {
          return fsSync.existsSync(path.join(instancesDir, name, 'config.yaml'));
        });
      }
      if (hasAgents) {
        res.sendFile(path.join(__dirname, 'home23-dashboard.html'));
      } else {
        res.sendFile(path.join(__dirname, 'home23-welcome.html'));
      }
    });

    // Settings page (always accessible)
    this.app.get('/home23/settings', (req, res) => {
      res.sendFile(path.join(__dirname, 'home23-settings.html'));
    });

    this.app.get('/home23/agents.json', (req, res) => {
      const fsSync = require('fs');
      // COSMO_RUNTIME_DIR = instances/<name>/brain → go up 3 levels to Home23 root
      const home23Root = this.getHome23Root();
      const manifestPath = path.join(home23Root, 'config', 'agents.json');
      if (fsSync.existsSync(manifestPath)) {
        res.type('application/json').send(fsSync.readFileSync(manifestPath, 'utf8'));
      } else {
        res.json([]);
      }
    });

    // Home23 config (ports for client-side URL construction)
    this.app.get('/home23/config.json', (req, res) => {
      res.json({
        evobrewPort: parseInt(process.env.EVOBREW_PORT || '3415', 10),
        cosmo23Port: parseInt(process.env.COSMO23_PORT || '43210', 10)
      });
    });

    // Home23 tile runtime
    this.app.get('/home23/api/tiles/config', (req, res) => {
      try {
        res.json(this.home23Tiles.getRuntimeConfig());
      } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
      }
    });

    this.app.get('/home23/api/tiles/:tileId/data', async (req, res) => {
      try {
        const data = await this.home23Tiles.getTileData(req.params.tileId);
        res.json({ ok: true, ...data });
      } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });

    this.app.post('/home23/api/tiles/:tileId/actions/:actionId', async (req, res) => {
      try {
        const action = await this.home23Tiles.runTileAction(
          req.params.tileId,
          req.params.actionId,
          req.body || {}
        );
        const data = await this.home23Tiles.getTileData(req.params.tileId);
        res.json({ ok: true, action, data });
      } catch (err) {
        res.status(400).json({ ok: false, error: err.message });
      }
    });

    // Home23 feeder status — reads from engine's DocumentFeeder manifest
    this.app.get('/home23/feeder-status', (req, res) => {
      const fsSync = require('fs');
      const runtimeDir = process.env.COSMO_RUNTIME_DIR || path.join(__dirname, '..', 'runtime');
      const workspacePath = process.env.COSMO_WORKSPACE_PATH;
      const manifestPath = path.join(runtimeDir, 'ingestion-manifest.json');
      const agentName = (process.env.INSTANCE_ID || 'home23-agent').replace('home23-', '');

      try {
        // Count total files in workspace (what needs to be ingested)
        let workspaceFileCount = 0;
        if (workspacePath && fsSync.existsSync(workspacePath)) {
          const countFiles = (dir) => {
            let count = 0;
            try {
              for (const entry of fsSync.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name.startsWith('.')) continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) count += countFiles(full);
                else if (entry.isFile()) count++;
              }
            } catch { /* unreadable dir */ }
            return count;
          };
          workspaceFileCount = countFiles(workspacePath);
        }

        if (!fsSync.existsSync(manifestPath)) {
          res.json({ feeders: [{ member: agentName, totalFiles: workspaceFileCount, processedFiles: 0, pendingCount: workspaceFileCount, compiledCount: 0, files: [] }] });
          return;
        }

        const manifest = JSON.parse(fsSync.readFileSync(manifestPath, 'utf8'));
        const entries = Object.entries(manifest);
        const compiled = entries.filter(([, meta]) => meta.compiled);
        const quarantined = entries.filter(([, meta]) => meta.parseStatus === 'suspect_truncation' || meta.parseStatus === 'un_normalizable');
        const chunks = entries.reduce((sum, [, meta]) => sum + (meta.nodeCount || (Array.isArray(meta.nodeIds) ? meta.nodeIds.length : 0)), 0);
        const remaining = Math.max(0, workspaceFileCount - entries.length);

        const files = entries
          .sort(([, a], [, b]) => (b.ingestedAt || '').localeCompare(a.ingestedAt || ''))
          .slice(0, 50)
          .map(([filePath, meta]) => ({
            path: filePath,
            label: meta.label || '',
            hash: (meta.hash || '').slice(0, 12),
            chunks: meta.nodeCount || (Array.isArray(meta.nodeIds) ? meta.nodeIds.length : 0),
            lastIngested: meta.ingestedAt || meta.ts || null,
            compiled: meta.compiled || false,
            status: meta.parseStatus || 'ok',
          }));

        res.json({
          feeders: [{
            member: agentName,
            totalFiles: workspaceFileCount,
            processedFiles: entries.length,
            pendingCount: remaining,
            compiledCount: compiled.length,
            quarantinedCount: quarantined.length,
            chunkCount: chunks,
            files,
          }]
        });
      } catch (err) {
        res.json({ feeders: [], error: err.message });
      }
    });

    // ── Feeder tab: upload / flush / watch-path management ──
    // Upload: writes files directly to <runPath>/ingestion/documents/<label>/.
    //   The engine's chokidar watcher on that directory picks them up
    //   automatically within ~500ms. No inter-process coordination needed.
    // Flush / watch-path: proxied to the engine's admin HTTP endpoints on
    //   the realtime server port (REALTIME_PORT, default 5001) because only
    //   the engine process holds the live feeder instance.
    try {
      const multer = require('multer');
      const fsSync = require('fs');
      const runtimeDir = process.env.COSMO_RUNTIME_DIR || path.join(__dirname, '..', 'runtime');
      const ingestBase = path.join(runtimeDir, 'ingestion', 'documents');

      const sanitizeLabel = (raw) => String(raw || 'dropzone')
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .slice(0, 40) || 'dropzone';

      const uploadStorage = multer.diskStorage({
        destination: (req, file, cb) => {
          const label = sanitizeLabel(req.body?.label);
          const dest = path.join(ingestBase, label);
          fsSync.mkdirSync(dest, { recursive: true });
          cb(null, dest);
        },
        filename: (req, file, cb) => {
          // Preserve original filename; prefix timestamp only if collision
          const label = sanitizeLabel(req.body?.label);
          const dest = path.join(ingestBase, label);
          const base = file.originalname || `upload-${Date.now()}`;
          const target = path.join(dest, base);
          if (fsSync.existsSync(target)) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            cb(null, `${ts}-${base}`);
          } else {
            cb(null, base);
          }
        },
      });
      const feederUpload = multer({
        storage: uploadStorage,
        limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per file
      });

      this.app.post('/home23/feeder/upload', feederUpload.array('files', 20), (req, res) => {
        const files = (req.files || []).map((f) => ({
          name: f.originalname,
          stored: f.filename,
          size: f.size,
          dest: f.destination,
        }));
        res.json({ ok: true, count: files.length, files, label: sanitizeLabel(req.body?.label) });
      });

      // Proxy helper: forward a JSON request to the engine's admin endpoint
      const realtimePort = parseInt(process.env.REALTIME_PORT || '5001', 10);
      const adminUrl = (p) => `http://localhost:${realtimePort}${p}`;
      const proxyJson = async (req, res, method, path) => {
        try {
          const r = await fetch(adminUrl(path), {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: method === 'POST' ? JSON.stringify(req.body || {}) : undefined,
            signal: AbortSignal.timeout(10_000),
          });
          const body = await r.json().catch(() => ({ ok: false, error: 'invalid response' }));
          res.status(r.status).json(body);
        } catch (err) {
          res.status(502).json({ ok: false, error: `Engine admin unreachable: ${err.message}` });
        }
      };

      this.app.get('/home23/feeder/live-status', (req, res) => proxyJson(req, res, 'GET', '/admin/feeder/status'));
      this.app.post('/home23/feeder/flush', (req, res) => proxyJson(req, res, 'POST', '/admin/feeder/flush'));
      this.app.post('/home23/feeder/add-watch-path', (req, res) => proxyJson(req, res, 'POST', '/admin/feeder/addWatchPath'));
      this.app.post('/home23/feeder/remove-watch-path', (req, res) => proxyJson(req, res, 'POST', '/admin/feeder/removeWatchPath'));
      this.app.post('/home23/feeder/update-compiler', (req, res) => proxyJson(req, res, 'POST', '/admin/feeder/updateCompiler'));
    } catch (err) {
      console.warn('[Feeder routes] Failed to mount:', err.message);
    }

    // Home23 Settings API
    try {
      const { createSettingsRouter } = require('./home23-settings-api.js');
      const home23Root = this.getHome23Root();
      const { router: settingsRouter } = createSettingsRouter(home23Root);
      this.app.use('/home23/api/settings', settingsRouter);
    } catch (err) {
      console.warn('[Settings API] Failed to mount:', err.message);
    }

    // ── OAuth refresh poller (STEP 18) ──
    // cosmo23 handles PKCE refresh internally. Every 30 min, check the current
    // decrypted token. If it differs from what's in secrets.yaml, sync it in
    // and restart the engine + harness so the new env flows through.
    // Skip the restart if a COSMO research run is active (would kill it).
    try {
      const home23RootForPoll = this.getHome23Root();
      const fsSync = require('fs');
      const yaml = require('js-yaml');
      const cosmoPort = parseInt(process.env.COSMO23_PORT || '43210', 10);
      const cosmoBase = `http://localhost:${cosmoPort}`;
      const secretsPath = path.join(home23RootForPoll, 'config', 'secrets.yaml');

      const pollInterval = 30 * 60 * 1000; // 30 min
      setInterval(async () => {
        try {
          // Skip if a research run is in flight
          let researchActive = false;
          try {
            const sres = await fetch(`${cosmoBase}/api/status`, { signal: AbortSignal.timeout(3000) });
            if (sres.ok) {
              const data = await sres.json();
              researchActive = !!data.running;
            }
          } catch { /* cosmo unreachable — skip silently */ }
          if (researchActive) {
            return;
          }

          for (const provider of ['anthropic', 'openai-codex']) {
            try {
              const r = await fetch(`${cosmoBase}/api/oauth/${provider}/raw-token`, {
                signal: AbortSignal.timeout(5000),
              });
              if (!r.ok) continue;
              const data = await r.json();
              const newToken = data?.token;
              if (!newToken) continue;

              if (!fsSync.existsSync(secretsPath)) continue;
              const secrets = yaml.load(fsSync.readFileSync(secretsPath, 'utf8')) || {};
              const current = secrets.providers?.[provider]?.apiKey;
              if (current === newToken) continue; // no rotation

              // Rotate: write new token, regenerate ecosystem, restart
              if (!secrets.providers) secrets.providers = {};
              if (!secrets.providers[provider]) secrets.providers[provider] = {};
              secrets.providers[provider].apiKey = newToken;
              secrets.providers[provider].oauthManaged = true;
              fsSync.writeFileSync(secretsPath, yaml.dump(secrets, { lineWidth: 120 }));

              try {
                const { execSync } = require('child_process');
                execSync(`node --input-type=module -e "
                  import { generateEcosystem } from './cli/lib/generate-ecosystem.js';
                  generateEcosystem('.');
                "`, { cwd: home23RootForPoll, stdio: 'pipe', timeout: 10_000 });
              } catch { /* fallback: restart anyway, ecosystem regen is optional */ }

              // Find primary agent and restart
              try {
                const homeCfg = yaml.load(fsSync.readFileSync(path.join(home23RootForPoll, 'config', 'home.yaml'), 'utf8')) || {};
                const agentName = homeCfg.home?.primaryAgent;
                if (agentName) {
                  const { execSync } = require('child_process');
                  execSync(
                    `pm2 restart home23-${agentName} home23-${agentName}-harness --update-env`,
                    { stdio: 'pipe', timeout: 30_000 }
                  );
                  console.log(`[OAuth refresh] rotated ${provider} token, restarted home23-${agentName}`);
                }
              } catch (err) {
                console.warn(`[OAuth refresh] ${provider} token written but restart failed:`, err.message);
              }
            } catch { /* per-provider error, continue with next */ }
          }
        } catch (err) {
          console.warn('[OAuth refresh] poller error:', err.message);
        }
      }, pollInterval);
    } catch (err) {
      console.warn('[OAuth refresh] setup failed:', err.message);
    }

    // ── COSMO 2.3 health watchdog ──
    // After a machine crash/restart, PM2 may restore the dashboard but not cosmo23
    // (if it wasn't in the saved list). Check every 2 minutes; if cosmo23 is
    // unreachable, start it via the ecosystem config.
    try {
      const home23RootForWatchdog = this.getHome23Root();
      const cosmoWatchdogPort = parseInt(process.env.COSMO23_PORT || '43210', 10);
      const cosmoWatchdogUrl = `http://localhost:${cosmoWatchdogPort}`;

      // Initial check after 15s (give processes time to settle on boot)
      setTimeout(() => {
        checkAndStartCosmo23();
        // Then check every 2 minutes
        setInterval(checkAndStartCosmo23, 2 * 60 * 1000);
      }, 15_000);

      async function checkAndStartCosmo23() {
        try {
          const res = await fetch(`${cosmoWatchdogUrl}/api/status`, { signal: AbortSignal.timeout(5000) });
          if (res.ok) return; // healthy
        } catch { /* unreachable — try to start */ }

        // Check PM2 state before starting (avoid double-start race)
        try {
          const { execSync } = require('child_process');
          const jlist = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8', timeout: 5000 }));
          const proc = jlist.find(p => p.name === 'home23-cosmo23');
          if (proc && proc.pm2_env?.status === 'online') return; // PM2 says online, just slow to respond

          console.log('[COSMO watchdog] cosmo23 not responding — starting...');
          const ecosystemPath = path.join(home23RootForWatchdog, 'ecosystem.config.cjs');
          execSync(`pm2 start ${ecosystemPath} --only home23-cosmo23`, {
            cwd: home23RootForWatchdog, stdio: 'pipe', timeout: 15_000
          });
          console.log('[COSMO watchdog] cosmo23 started');
        } catch (err) {
          console.warn('[COSMO watchdog] failed to start cosmo23:', err.message);
        }
      }
    } catch (err) {
      console.warn('[COSMO watchdog] setup failed:', err.message);
    }

    // ── Home23 update check ──
    // Poll GitHub for new version tags. Initial check after 30s, then every 6 hours.
    try {
      const home23RootForUpdate = this.getHome23Root();
      let _updateStatus = { updateAvailable: false, currentVersion: '', latestVersion: '', checkedAt: null };

      const checkForUpdate = () => {
        try {
          const fsSync = require('fs');
          const pkgPath = path.join(home23RootForUpdate, 'package.json');
          if (!fsSync.existsSync(pkgPath)) return;
          const pkg = JSON.parse(fsSync.readFileSync(pkgPath, 'utf8'));
          const currentVersion = pkg.version || '0.0.0';

          const { execSync } = require('child_process');
          try {
            execSync('git fetch origin --tags --quiet', {
              cwd: home23RootForUpdate, stdio: 'pipe', timeout: 30_000,
            });
          } catch { /* fetch failed — compare with local tags only */ }

          let latestTag = '';
          try {
            latestTag = execSync('git tag -l "v*" --sort=-version:refname', {
              cwd: home23RootForUpdate, encoding: 'utf8', stdio: 'pipe', timeout: 5_000,
            }).trim().split('\n')[0] || '';
          } catch { /* no tags */ }

          const latestVersion = latestTag.replace(/^v/, '');
          if (!latestVersion) {
            _updateStatus = { updateAvailable: false, currentVersion, latestVersion: currentVersion, checkedAt: new Date().toISOString() };
            return;
          }

          const cParts = currentVersion.split('.').map(Number);
          const lParts = latestVersion.split('.').map(Number);
          let updateAvailable = false;
          for (let i = 0; i < Math.max(cParts.length, lParts.length); i++) {
            const c = cParts[i] || 0;
            const l = lParts[i] || 0;
            if (l > c) { updateAvailable = true; break; }
            if (l < c) break;
          }

          _updateStatus = { updateAvailable, currentVersion, latestVersion, checkedAt: new Date().toISOString() };
          if (updateAvailable) {
            console.log(`[Update check] v${latestVersion} available (current: v${currentVersion})`);
          }
        } catch (err) {
          console.warn('[Update check] error:', err.message);
        }
      };

      setTimeout(() => {
        checkForUpdate();
        setInterval(checkForUpdate, 6 * 60 * 60 * 1000); // every 6 hours
      }, 30_000);

      this.app.get('/home23/api/settings/update-status', (req, res) => {
        res.json(_updateStatus);
      });
    } catch (err) {
      console.warn('[Update check] setup failed:', err.message);
    }

    // Chat History API
    // Helper: parse JSONL conversation file into messages
    const parseConversationFile = (filePath, limit) => {
      const fsSync = require('fs');
      if (!fsSync.existsSync(filePath)) return [];
      try {
        const raw = fsSync.readFileSync(filePath, 'utf8').trim();
        if (!raw) return [];
        const messages = [];
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            // Handle both direct StoredMessage format and wrapped {type,message} format
            const msg = record.message || record;
            if (msg.role) {
              let text = '';
              if (typeof msg.content === 'string') {
                text = msg.content;
              } else if (Array.isArray(msg.content)) {
                text = msg.content
                  .filter(b => b.type === 'text')
                  .map(b => b.text)
                  .join('');
              }
              messages.push({
                role: msg.role,
                content: text,
                timestamp: record.timestamp || msg.ts || null,
              });
            }
          } catch { /* skip bad lines */ }
        }
        return limit ? messages.slice(-limit) : messages;
      } catch { return []; }
    };

    // List all conversations for an agent
    this.app.get('/home23/api/chat/conversations/:agent', (req, res) => {
      const fsSync = require('fs');
      const agentName = req.params.agent;
      const home23Root = this.getHome23Root();

      // Conversations are stored in two places:
      // 1. conversations/<namespace>__<chatId>.jsonl (harness writes here)
      // 2. conversations/sessions/<uuid>.jsonl (thread-bound Telegram sessions)
      const convDir = path.join(home23Root, 'instances', agentName, 'conversations');
      const sessionsDir = path.join(convDir, 'sessions');

      if (!fsSync.existsSync(convDir)) return res.json({ conversations: [] });

      try {
        // Collect from both locations
        const files = [];

        // Root conversations (namespace__chatId.jsonl)
        for (const f of fsSync.readdirSync(convDir)) {
          if (f.endsWith('.jsonl') && !f.startsWith('.')) {
            files.push({ file: f, dir: convDir });
          }
        }

        // Session conversations (uuid.jsonl)
        if (fsSync.existsSync(sessionsDir)) {
          for (const f of fsSync.readdirSync(sessionsDir)) {
            if (f.endsWith('.jsonl') && f !== 'delivery-receipts.jsonl') {
              files.push({ file: f, dir: sessionsDir });
            }
          }
        }

        const conversations = files.map(({ file: f, dir }) => {
          const id = f.replace('.jsonl', '');
          const filePath = path.join(dir, f);
          const stat = fsSync.statSync(filePath);
          const messages = parseConversationFile(filePath, 1);
          const firstMsg = parseConversationFile(filePath, null)?.[0];

          // Extract a preview from the first user message
          const allMsgs = parseConversationFile(filePath, null);
          const firstUserMsg = allMsgs.find(m => m.role === 'user');
          let preview = firstUserMsg?.content?.slice(0, 80) || 'New conversation';
          // Strip channel prefixes like "[telegram J R] "
          preview = preview.replace(/^\[(?:telegram|discord)\s+[^\]]*\]\s*/i, '');

          // Determine source from filename or content
          const cleanId = id.replace(/^[^_]+__/, ''); // strip namespace prefix like "agent__"
          const source = cleanId.startsWith('dashboard') ? 'dashboard'
            : cleanId.startsWith('evobrew') ? 'evobrew'
            : cleanId.startsWith('cron-') ? 'cron'
            : (firstUserMsg?.content || '').includes('[telegram') ? 'telegram'
            : 'chat';

          return {
            id,
            preview,
            source,
            messageCount: allMsgs.length,
            lastActivity: stat.mtime.toISOString(),
            created: stat.birthtime?.toISOString() || stat.mtime.toISOString(),
          };
        });

        // Sort by last activity, newest first
        conversations.sort((a, b) => new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime());
        res.json({ conversations });
      } catch (err) {
        res.json({ conversations: [], error: err.message });
      }
    });

    // Get messages for a specific conversation
    this.app.get('/home23/api/chat/history/:agent', (req, res) => {
      const fsSync = require('fs');
      const agentName = req.params.agent;
      const convId = req.query.conversation || `dashboard-${agentName}`;
      const limit = parseInt(req.query.limit) || 50;
      const home23Root = this.getHome23Root();
      const convDir = path.join(home23Root, 'instances', agentName, 'conversations');
      const sessionsDir = path.join(convDir, 'sessions');

      // Try both locations: conversations/<id>.jsonl and conversations/sessions/<id>.jsonl
      let chatFile = path.join(convDir, `${convId}.jsonl`);
      if (!fsSync.existsSync(chatFile)) {
        chatFile = path.join(sessionsDir, `${convId}.jsonl`);
      }

      res.json({ messages: parseConversationFile(chatFile, limit), conversation: convId });
    });

    // Chat Config API
    this.app.get('/home23/api/chat/config/:agent', (req, res) => {
      const fsSync = require('fs');
      const yaml = require('js-yaml');
      const agentName = req.params.agent;
      const home23Root = this.getHome23Root();

      const configPath = path.join(home23Root, 'instances', agentName, 'config.yaml');
      if (!fsSync.existsSync(configPath)) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      const config = yaml.load(fsSync.readFileSync(configPath, 'utf8'));
      res.json({
        bridgePort: config.ports?.bridge || 5004,
        agentName,
        displayName: config.agent?.displayName || agentName,
      });
    });

    // Chat standalone page
    this.app.get('/home23/chat', (req, res) => {
      res.sendFile(path.join(__dirname, 'home23-chat.html'));
    });

    this.app.get('/home23/vibe-gallery', (req, res) => {
      res.sendFile(path.join(__dirname, 'home23-vibe', 'gallery.html'));
    });

    this.app.get('/home23/api/vibe/current', async (req, res) => {
      try {
        res.json(await this.home23Vibe.getCurrent());
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.post('/home23/api/vibe/generate', async (req, res) => {
      try {
        const item = await this.home23Vibe.requestGeneration();
        res.json({ ok: true, item });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    this.app.get('/home23/api/vibe/gallery', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit || '60', 10);
        res.json(await this.home23Vibe.listGallery(limit));
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Media serving for dashboard chat (images from agent tools)
    this.app.get('/home23/api/media', (req, res) => {
      const fsSync = require('fs');
      const filePath = req.query.path;
      if (!filePath || typeof filePath !== 'string') {
        return res.status(400).json({ error: 'path required' });
      }
      // Security: only serve from temp dirs or workspace
      const home23Root = this.getHome23Root();
      const resolved = path.resolve(filePath);
      if (!resolved.startsWith(home23Root) && !resolved.startsWith('/tmp/')) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (!fsSync.existsSync(resolved)) {
        return res.status(404).json({ error: 'File not found' });
      }
      res.sendFile(resolved);
    });

    // Brain graph data for 3D visualization
    this.app.get('/home23/api/brain/graph', async (req, res) => {
      try {
        const state = await this.loadState();
        const memory = state.memory || {};
        const nodes = (memory.nodes || []).map(n => ({
          id: String(n.id),
          concept: n.concept || '',
          tag: n.tag || 'general',
          weight: n.weight || 0,
          activation: n.activation || 0,
          cluster: n.cluster,
          created: n.created,
          accessed: n.accessed,
          accessCount: n.accessCount || 0
        }));
        const edges = (memory.edges || []).map(e => ({
          source: String(e.source),
          target: String(e.target),
          weight: e.weight || 0,
          type: e.type || 'associative'
        }));
        res.json({
          success: true,
          nodes,
          edges,
          clusters: memory.clusters || [],
          meta: {
            nodeCount: nodes.length,
            edgeCount: edges.length,
            clusterCount: (memory.clusters || []).length || memory.nextClusterId || 0,
            cycleCount: state.cycleCount || 0
          }
        });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // NEW: Serve curated insights reports (from coordinator directory)
    this.app.use('/reports', express.static(path.join(this.logsDir, 'coordinator')));

    // Health check / ready endpoint
    this.app.get('/api/ready', (req, res) => {
      res.json({ ready: true, timestamp: Date.now() });
    });

    // Per-instance session token — used by family members to identify their COSMO instance
    // Returns a fresh UUID token + INSTANCE_ID env var + ISO timestamp
    this.app.get('/cosmo-session', (req, res) => {
      res.json({
        token: crypto.randomUUID(),
        instanceId: process.env.INSTANCE_ID || null,
        timestamp: new Date().toISOString()
      });
    });

    // Intelligence-focused home (NEW)
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'home.html'));
    });

    // Intelligence view for runs (NEW)
    this.app.get('/intelligence', (req, res) => {
      res.sendFile(path.join(__dirname, 'intelligence.html'));
    });
    
    // Documentation IDE (Monaco editor for compiled docs)
    this.app.get('/docs-ide', (req, res) => {
      res.sendFile(path.join(__dirname, 'docs-ide.html'));
    });
    
    // ===== V2 IDE INTEGRATION =====
    
    // V2 IDE: Serve new IDE (parallel deployment)
    this.app.get('/docs-ide-v2', (req, res) => {
      res.sendFile(path.join(__dirname, 'docs-ide-v2.html'));
    });
    
    // V2 IDE: Lazy component initializer (avoids startup issues)
    const getV2Components = () => {
      if (!this._v2Components) {
        const OpenAI = require('openai');
        const AnthropicClient = require('../core/anthropic-client');
        const { handleFunctionCalling } = require('../ide/ai-handler');
        const CodebaseIndexer = require('../ide/codebase-indexer');

        // Anthropic: use the OAuth-aware AnthropicClient from cosmo_2.3
        const anthropicClient = new AnthropicClient({
          useExtendedThinking: false,
          defaultMaxTokens: 4096,
          temperature: 0.7,
        });

        // Also create raw Anthropic SDK for V2 IDE function calling (needs raw SDK)
        const Anthropic = require('@anthropic-ai/sdk');
        // Clean env before SDK init — empty ANTHROPIC_API_KEY causes auth resolution failure
        if (process.env.ANTHROPIC_API_KEY === '' || process.env.ANTHROPIC_API_KEY === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        }
        const rawAnthropicOpts = {};
        if (process.env.ANTHROPIC_AUTH_TOKEN) {
          rawAnthropicOpts.authToken = process.env.ANTHROPIC_AUTH_TOKEN;
        } else if (process.env.ANTHROPIC_API_KEY) {
          rawAnthropicOpts.apiKey = process.env.ANTHROPIC_API_KEY;
        }

        this._v2Components = {
          openai: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
          anthropic: new Anthropic(rawAnthropicOpts),  // Raw SDK for V2 IDE
          anthropicClient: anthropicClient,             // OAuth-aware wrapper for simple chat
          xai: new OpenAI({ 
            apiKey: process.env.XAI_API_KEY,
            baseURL: 'https://api.x.ai/v1'
          }),
          codebaseIndexer: null, // Lazy-init on first use
          handleFunctionCalling
        };
        console.log('[V2 IDE] Components initialized');
      }
      return this._v2Components;
    };
    
    // V2 IDE: AI Chat with function calling
    this.app.post('/api/chat', async (req, res) => {
      try {
        const params = req.body;
        const { message, stream } = params;
        
        if (!message) {
          return res.status(400).json({ error: 'Message required' });
        }
        
        const components = getV2Components.call(this);
        
        if (stream) {
          // SSE streaming
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          
          const eventEmitter = (event) => {
            try {
              const jsonString = JSON.stringify(event, (key, value) => {
                if (typeof value === 'string') {
                  return value.replace(/\n/g, '\\n').replace(/\r/g, '\\r');
                }
                return value;
              });
              res.write(`data: ${jsonString}\n\n`);
            } catch (err) {
              console.error('[V2 Chat] SSE error:', err);
            }
          };
          
          try {
            const result = await components.handleFunctionCalling(
              components.openai,
              components.anthropic,
              components.xai,
              components.codebaseIndexer,
              params,
              eventEmitter
            );
            
            if (!result.success) {
              res.write(`data: ${JSON.stringify({ type: 'error', error: result.error })}\n\n`);
              res.end();
              return;
            }
            
            res.write(`data: ${JSON.stringify({ 
              type: 'complete',
              fullResponse: result.response,
              tokensUsed: result.tokensUsed,
              iterations: result.iterations,
              pendingEdits: result.pendingEdits || []
            })}\n\n`);
            res.end();
            
          } catch (error) {
            console.error('[V2 Chat] Error:', error);
            res.write(`data: ${JSON.stringify({ type: 'error', error: error.message })}\n\n`);
            res.end();
          }
        } else {
          // Non-streaming
          const result = await components.handleFunctionCalling(
            components.openai,
            components.anthropic,
            components.xai,
            components.codebaseIndexer,
            params
          );
          
          res.json(result.success ? result : { success: false, error: result.error });
        }
      } catch (error) {
        console.error('[V2 Chat] Fatal error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: error.message });
        }
      }
    });
    
    // Simple chat — no function calling, no IDE features
    // Used by the Home Bridge for conversational Telegram/Discord chat
    this.app.post('/api/chat/simple', async (req, res) => {
      try {
        const { system, messages, model, provider, maxTokens, temperature } = req.body;
        if (!messages || !Array.isArray(messages)) {
          return res.status(400).json({ error: 'messages array required' });
        }

        const components = getV2Components.call(this);
        const chosenProvider = provider || 'openai';
        const chosenModel = model || 'gpt-4o';
        const finalMaxTokens = maxTokens || 2000;
        const finalTemperature = temperature ?? 0.7;

        let answer = '';
        let usage = {};

        if (chosenProvider === 'anthropic') {
          // Use the OAuth-aware AnthropicClient (handles token refresh, stealth headers)
          const result = await components.anthropicClient.generate({
            instructions: system || '',
            messages: messages,
            maxTokens: finalMaxTokens,
            temperature: finalTemperature,
            model: chosenModel,
          });
          answer = result.content || '';
          usage = result.usage || {};
        } else if (chosenProvider === 'xai') {
          const apiMessages = [];
          if (system) apiMessages.push({ role: 'system', content: system });
          apiMessages.push(...messages);

          const response = await components.xai.chat.completions.create({
            model: chosenModel,
            messages: apiMessages,
            max_tokens: finalMaxTokens,
            temperature: finalTemperature,
          });
          answer = response.choices?.[0]?.message?.content || '';
          usage = response.usage || {};
        } else {
          // OpenAI (default)
          const apiMessages = [];
          if (system) apiMessages.push({ role: 'system', content: system });
          apiMessages.push(...messages);

          // GPT-5+ models require max_completion_tokens instead of max_tokens
          const isNewModel = chosenModel.startsWith('gpt-5') || chosenModel.startsWith('o');
          const tokenParam = isNewModel
            ? { max_completion_tokens: finalMaxTokens }
            : { max_tokens: finalMaxTokens };

          const response = await components.openai.chat.completions.create({
            model: chosenModel,
            messages: apiMessages,
            ...tokenParam,
            temperature: finalTemperature,
          });
          answer = response.choices?.[0]?.message?.content || '';
          usage = response.usage || {};
        }

        res.json({ answer, model: chosenModel, provider: chosenProvider, usage });
      } catch (error) {
        console.error('[Simple Chat] Error:', error.message);
        if (!res.headersSent) {
          res.status(500).json({ error: error.message });
        }
      }
    });

    // V2 IDE: Index folder for semantic search
    this.app.post('/api/index-folder', async (req, res) => {
      try {
        const { folderPath, files } = req.body;
        
        if (!folderPath || !files) {
          return res.status(400).json({ error: 'folderPath and files required' });
        }
        
        const components = getV2Components.call(this);
        
        // Lazy-init codebase indexer
        if (!components.codebaseIndexer) {
          const CodebaseIndexer = require('../ide/codebase-indexer');
          components.codebaseIndexer = new CodebaseIndexer(components.openai);
        }
        
        await components.codebaseIndexer.indexFolder(folderPath, files);
        
        res.json({ success: true, message: `Indexed ${files.length} files` });
      } catch (error) {
        console.error('[V2 Index] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // V2 IDE: Semantic codebase search
    this.app.post('/api/codebase-search', async (req, res) => {
      try {
        const { folderPath, query, limit = 10 } = req.body;
        
        if (!folderPath || !query) {
          return res.status(400).json({ error: 'folderPath and query required' });
        }
        
        const components = getV2Components.call(this);
        
        // Lazy-init codebase indexer
        if (!components.codebaseIndexer) {
          const CodebaseIndexer = require('../ide/codebase-indexer');
          components.codebaseIndexer = new CodebaseIndexer(components.openai);
        }
        
        const results = await components.codebaseIndexer.searchCode(folderPath, query, limit);
        
        res.json({ success: true, ...results });
      } catch (error) {
        console.error('[V2 Search] Error:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // V2 IDE: File deletion (missing from current COSMO)
    this.app.delete('/api/folder/delete', async (req, res) => {
      try {
        const { path: targetPath } = req.body;
        
        if (!targetPath) {
          return res.status(400).json({ error: 'Path required' });
        }
        
        // Security check
        if (!this.isFilesystemPathSafe(targetPath)) {
          return res.status(403).json({ error: 'Access denied' });
        }
        
        const stats = await fs.stat(targetPath);
        
        if (stats.isDirectory()) {
          await fs.rm(targetPath, { recursive: true });
        } else {
          await fs.unlink(targetPath);
        }
        
        res.json({ success: true });
      } catch (error) {
        console.error('[V2 Delete] Error:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // ===== END V2 IDE INTEGRATION =====

    // Legacy data dashboard (preserved)
    this.app.get('/legacy', (req, res) => {
      res.sendFile(path.join(__dirname, 'legacy-dashboard.html'));
    });

    // Run details view (data-focused, with markdown viewer)
    this.app.get('/run', (req, res) => {
      res.sendFile(path.join(__dirname, 'run-details.html'));
    });

    // Research Lab (Original Runs List - for "View All")
    this.app.get('/runs', (req, res) => {
      res.sendFile(path.join(__dirname, 'runs.html'));
    });

    // ===== RUN MANAGEMENT API ENDPOINTS (NEW) =====
    
    // API: Get current run info
    this.app.get('/api/runs/current', async (req, res) => {
      try {
        res.json({
          name: this.currentRun,
          metadata: this.currentRunMetadata,
          logsDir: this.logsDir
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: List all available runs
    this.app.get('/api/runs', async (req, res) => {
      try {
        const runs = await this.listAvailableRuns();
        const runtimeMetadata = await this.getCurrentRuntimeMetadata();
        
        res.json({
          current: {
            name: 'runtime',
            metadata: runtimeMetadata,
            path: this.defaultRunDir
          },
          runs: runs
        });
      } catch (error) {
        console.error('Failed to list runs:', error);
        res.status(500).json({ error: error.message, runs: [] });
      }
    });

    // API: Switch to a different run
    this.app.post('/api/runs/switch', async (req, res) => {
      try {
        const { runName } = req.body;
        
        if (!runName) {
          return res.status(400).json({ error: 'runName is required' });
        }
        
        const result = await this.switchToRun(runName);
        
        res.json({
          success: true,
          run: result.run,
          metadata: result.metadata
        });
      } catch (error) {
        console.error('Failed to switch run:', error);
        res.status(400).json({ error: error.message });
      }
    });

    // API: Get run statistics (coordinator reviews, agents, etc.)
    this.app.get('/api/runs/:runName/stats', async (req, res) => {
      try {
        const { runName } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        const stats = await this.getRunStats(runDir);
        res.json(stats);
      } catch (error) {
        console.error('Failed to get run stats:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get memory network data specifically (optimized)
    this.app.get('/api/runs/:runName/memory', async (req, res) => {
      try {
        const { runName } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        // Load metadata to check for cluster mode
        const metadataPath = path.join(runDir, 'run-metadata.json');
        let metadata = null;
        try {
          const metadataContent = await fs.readFile(metadataPath, 'utf-8');
          metadata = JSON.parse(metadataContent);
        } catch (error) {
          // Metadata missing, assume single-instance
        }

        // CLUSTER MODE: Aggregate from hive dashboard
        if (metadata?.clusterEnabled && metadata.clusterSize > 1) {
          const proxy = new ClusterDataProxy(metadata, runDir, console);
          const aggregatedMemory = await proxy.getAggregatedMemory();
          
          if (aggregatedMemory) {
            return res.json(aggregatedMemory);
          }
          
          // Fallback warning
          console.warn(`[Dashboard] Cluster run but hive unavailable for ${runName}, falling back to local state`);
        }

        // SINGLE-INSTANCE MODE: Read from state.json.gz
        const fsSync = require('fs');
        const statePath = path.join(runDir, 'state.json.gz');
        
        if (!fsSync.existsSync(statePath)) {
          return res.status(404).json({ error: 'State file not found for this run' });
        }

        // For large states, use pre-generated dashboard cache (no embeddings, ~20MB vs ~500MB)
        const memoryCachePath = path.join(runDir, 'dashboard-cache.json');
        const stateStats = fsSync.statSync(statePath);
        if (stateStats.size > 100 * 1024 * 1024 && fsSync.existsSync(memoryCachePath)) {
          try {
            const cache = JSON.parse(fsSync.readFileSync(memoryCachePath, 'utf8'));
            return res.json({ nodes: cache.nodes || [], edges: cache.edges || [] });
          } catch (e) { /* fall through */ }
        }
        
        const compressed = await fs.readFile(statePath);
        const decompressed = await gunzip(compressed);
        const state = JSON.parse(decompressed.toString());
        
        if (!state.memory) {
          return res.json({ nodes: [], edges: [] });
        }
        
        // Strip embeddings to reduce payload (~90% smaller)
        const strippedNodes = (state.memory.nodes || []).map(n => {
          const { embedding, ...rest } = n;
          return rest;
        });
        res.json({ nodes: strippedNodes, edges: state.memory.edges || [] });
      } catch (error) {
        console.error('Failed to get memory data:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get run state (full)
    this.app.get('/api/runs/:runName/state', async (req, res) => {
      try {
        const { runName } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        // Load metadata to check for cluster mode
        const fsSync = require('fs');
        const metadataPath = path.join(runDir, 'run-metadata.json');
        let metadata = null;
        
        if (fsSync.existsSync(metadataPath)) {
          try {
            const metadataContent = await fs.readFile(metadataPath, 'utf-8');
            metadata = JSON.parse(metadataContent);
          } catch (error) {
            // Metadata parsing error, assume single-instance
          }
        }

        // CLUSTER MODE: Get aggregated state from hive dashboard
        if (metadata?.clusterEnabled && metadata.clusterSize > 1) {
          const proxy = new ClusterDataProxy(metadata, runDir, console);
          const aggregatedState = await proxy.getAggregatedState();
          
          if (aggregatedState) {
            return res.json(aggregatedState);
          }
          
          // Fallback warning
          console.warn(`[Dashboard] Cluster run but hive unavailable for ${runName}, falling back to local state`);
        }

        // SINGLE-INSTANCE MODE: Read from state.json.gz
        const statePath = path.join(runDir, 'state.json.gz');
        
        if (!fsSync.existsSync(statePath)) {
          return res.status(404).json({ error: 'State file not found for this run' });
        }

        // For large states, use dashboard cache to avoid OOM
        const stateCachePath = path.join(runDir, 'dashboard-cache.json');
        const stateFileStats = fsSync.statSync(statePath);
        if (stateFileStats.size > 100 * 1024 * 1024 && fsSync.existsSync(stateCachePath)) {
          try {
            const cache = JSON.parse(fsSync.readFileSync(stateCachePath, 'utf8'));
            return res.json({
              cycleCount: cache.cycleCount || 0,
              memory: { nodes: cache.nodes || [], edges: cache.edges || [] },
              goals: { active: [], all: [] }
            });
          } catch (e) { /* fall through */ }
        }
        
        const compressed = await fs.readFile(statePath);
        const decompressed = await gunzip(compressed);
        const state = JSON.parse(decompressed.toString());
        
        res.json(state);
      } catch (error) {
        console.error('Failed to get run state:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get run metadata/setup
    this.app.get('/api/runs/:runName/metadata', async (req, res) => {
      try {
        const { runName } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        const fsSync = require('fs');
        const metadataPath = path.join(runDir, 'run-metadata.json');
        
        if (!fsSync.existsSync(metadataPath)) {
          return res.json({ domain: 'N/A', context: 'N/A' });
        }
        
        const content = await fs.readFile(metadataPath, 'utf-8');
        const metadata = this.safeParseMetadata(content, metadataPath);
        
        if (!metadata) {
          res.status(400).json({
            error: 'invalid_metadata',
            message: 'Run metadata could not be parsed'
          });
          return;
        }
        
        res.json(metadata);
      } catch (error) {
        console.error('Failed to get run metadata:', error);
        // Return safe defaults instead of 500 error to prevent dashboard from choking
        res.json({ 
          domain: 'N/A (metadata corrupted)', 
          context: 'N/A',
          explorationMode: 'unknown',
          error: error.message 
        });
      }
    });

    // API: Get thoughts for a specific run
    this.app.get('/api/runs/:runName/thoughts', async (req, res) => {
      try {
        const { runName } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        const limit = parseInt(req.query.limit) || 100;
        
        // Load metadata to check for cluster mode
        const metadataPath = path.join(runDir, 'run-metadata.json');
        let metadata = null;
        const fsSync = require('fs');
        
        if (fsSync.existsSync(metadataPath)) {
          try {
            const metadataContent = await fs.readFile(metadataPath, 'utf-8');
            metadata = JSON.parse(metadataContent);
          } catch (error) {
            // Metadata parsing error, assume single-instance
          }
        }

        // CLUSTER MODE: Aggregate from hive dashboard
        if (metadata?.clusterEnabled && metadata.clusterSize > 1) {
          const proxy = new ClusterDataProxy(metadata, runDir, console);
          const aggregatedThoughts = await proxy.getAggregatedThoughts(limit);
          
          if (aggregatedThoughts) {
            return res.json(aggregatedThoughts);
          }
          
          // Fallback warning
          console.warn(`[Dashboard] Cluster run but hive unavailable for ${runName}, falling back to local thoughts`);
        }

        // SINGLE-INSTANCE MODE: Read from thoughts.jsonl
        const thoughtsPath = path.join(runDir, 'thoughts.jsonl');
        
        if (!fsSync.existsSync(thoughtsPath)) {
          return res.json([]);
        }
        
        const content = await fs.readFile(thoughtsPath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l);
        const thoughts = lines.slice(-limit).map(line => JSON.parse(line)).reverse();
        
        res.json(thoughts);
      } catch (error) {
        console.error('Failed to get thoughts:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // API: List coordinator reviews for a run
    this.app.get('/api/runs/:runName/coordinator/reviews', async (req, res) => {
      try {
        const { runName } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        const coordinatorDir = path.join(runDir, 'coordinator');
        
        const fsSync = require('fs');
        if (!fsSync.existsSync(coordinatorDir)) {
          return res.json([]);
        }
        
        const files = await fs.readdir(coordinatorDir);
        const reviews = files.filter(f => f.startsWith('review_') && f.endsWith('.md'));
        
        // Parse each review to extract metadata
        const reviewsData = await Promise.all(reviews.map(async (filename) => {
          try {
            const content = await fs.readFile(path.join(coordinatorDir, filename), 'utf-8');
            const metadata = this.parseReviewMetadata(content, filename);
            return metadata;
          } catch (error) {
            console.error(`Error parsing review ${filename}:`, error);
            return null;
          }
        }));
        
        // Filter out nulls and sort by cycle descending
        const validReviews = reviewsData.filter(r => r !== null);
        validReviews.sort((a, b) => b.cycle - a.cycle);
        
        res.json(validReviews);
      } catch (error) {
        console.error('Failed to list coordinator reviews:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get specific coordinator review
    this.app.get('/api/runs/:runName/coordinator/review/:filename', async (req, res) => {
      try {
        const { runName, filename } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        const filePath = path.join(runDir, 'coordinator', filename);
        
        const fsSync = require('fs');
        if (!fsSync.existsSync(filePath)) {
          return res.status(404).json({ error: 'Review not found' });
        }
        
        const content = await fs.readFile(filePath, 'utf-8');
        const metadata = this.parseReviewMetadata(content, filename);
        
        res.json({
          markdown: content,
          metadata: metadata,
          sections: this.parseReviewSections(content)
        });
      } catch (error) {
        console.error('Failed to get coordinator review:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: List curated insights for a run
    this.app.get('/api/runs/:runName/coordinator/insights', async (req, res) => {
      try {
        const { runName } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        const coordinatorDir = path.join(runDir, 'coordinator');
        
        const fsSync = require('fs');
        if (!fsSync.existsSync(coordinatorDir)) {
          return res.json([]);
        }
        
        const files = await fs.readdir(coordinatorDir);
        const insights = files.filter(f => f.startsWith('insights_curated_') && f.endsWith('.md'));
        
        // Parse each insight file to extract metadata
        const insightsData = await Promise.all(insights.map(async (filename) => {
          try {
            const content = await fs.readFile(path.join(coordinatorDir, filename), 'utf-8');
            const metadata = this.parseInsightMetadata(content, filename);
            return metadata;
          } catch (error) {
            console.error(`Error parsing insight ${filename}:`, error);
            return null;
          }
        }));
        
        // Filter out nulls and sort by cycle descending
        const validInsights = insightsData.filter(i => i !== null);
        validInsights.sort((a, b) => (b.cycle || 0) - (a.cycle || 0));
        
        res.json(validInsights);
      } catch (error) {
        console.error('Failed to list curated insights:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // API: Get strategic goals tracking status (runtime only for now)
    this.app.get('/api/strategic-goals', async (req, res) => {
      try {
        if (!this.orchestrator?.coordinator?.strategicTracker) {
          return res.json({
            available: false,
            message: 'Strategic goals tracker not available (orchestrator not running)'
          });
        }
        
        const stats = this.orchestrator.coordinator.strategicTracker.getStats();
        res.json({
          available: true,
          stats,
          currentCycle: this.orchestrator.cycleCount
        });
      } catch (error) {
        console.error('Failed to get strategic goals:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get executive function stats (middle ring)
    // Supports both current run (via orchestrator) and historical runs (via state file)
    this.app.get('/api/executive-stats', async (req, res) => {
      try {
        const runName = req.query.run || 'runtime';
        
        // 1. Try current orchestrator if targeting runtime
        if (runName === 'runtime' && this.orchestrator?.executiveRing) {
          const stats = this.orchestrator.executiveRing.getStats();
          return res.json({
            available: true,
            stats,
            currentCycle: this.orchestrator.cycleCount
          });
        }
        
        // 2. Fallback: Read from state file
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        const statePath = path.join(runDir, 'state.json.gz');
        
        const fsSync = require('fs');
        if (fsSync.existsSync(statePath)) {
          const compressed = await fs.readFile(statePath);
          const decompressed = await gunzip(compressed);
          const state = JSON.parse(decompressed.toString());
          
          if (state.executiveRing) {
            return res.json({
              available: true,
              stats: state.executiveRing,
              currentCycle: state.cycleCount || 0,
              source: 'state_file'
            });
          }
        }
        
        res.json({
          available: false,
          message: runName === 'runtime' ? 'Executive ring not initialized' : 'Executive ring data not found in state'
        });
      } catch (error) {
        console.error('Failed to get executive stats:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get specific curated insight
    this.app.get('/api/runs/:runName/coordinator/insight/:filename', async (req, res) => {
      try {
        const { runName, filename } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        const filePath = path.join(runDir, 'coordinator', filename);
        
        const fsSync = require('fs');
        if (!fsSync.existsSync(filePath)) {
          return res.status(404).json({ error: 'Insight not found' });
        }
        
        const content = await fs.readFile(filePath, 'utf-8');
        const metadata = this.parseInsightMetadata(content, filename);
        
        res.json({
          markdown: content,
          metadata: metadata
        });
      } catch (error) {
        console.error('Failed to get curated insight:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get agent analytics for a run
    this.app.get('/api/runs/:runName/agents/analytics', async (req, res) => {
      try {
        const { runName } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        const resultsPath = path.join(runDir, 'coordinator', 'results_queue.jsonl');
        
        const fsSync = require('fs');
        if (!fsSync.existsSync(resultsPath)) {
          return res.json({ summary: {}, agents: [], timeline: [] });
        }
        
        const content = await fs.readFile(resultsPath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l);
        const agents = lines.map(line => JSON.parse(line));
        
        // Calculate summary by type
        const byType = {};
        let totalCompleted = 0;
        let totalFailed = 0;
        let totalTimeout = 0;
        
        for (const agent of agents) {
          const type = agent.agentType || 'Unknown';
          if (!byType[type]) {
            byType[type] = {
              total: 0,
              completed: 0,
              failed: 0,
              timeout: 0,
              durations: [],
              findings: 0
            };
          }
          
          byType[type].total++;
          if (agent.status === 'completed') {
            byType[type].completed++;
            totalCompleted++;
          } else if (agent.status === 'failed') {
            byType[type].failed++;
            totalFailed++;
          } else if (agent.status === 'timeout') {
            byType[type].timeout++;
            totalTimeout++;
          }
          
          if (agent.duration) {
            byType[type].durations.push(agent.duration);
          }
          
          if (agent.results) {
            byType[type].findings += agent.results.length;
          }
        }
        
        // Calculate averages
        for (const type in byType) {
          const typeData = byType[type];
          if (typeData.durations.length > 0) {
            typeData.avgDuration = Math.round(
              typeData.durations.reduce((a, b) => a + b, 0) / typeData.durations.length
            );
          } else {
            typeData.avgDuration = 0;
          }
          delete typeData.durations; // Don't send raw durations
        }
        
        // Sort agents by time (most recent first)
        const timeline = agents.sort((a, b) => {
          const timeA = new Date(a.startTime || 0).getTime();
          const timeB = new Date(b.startTime || 0).getTime();
          return timeB - timeA;
        });
        
        res.json({
          summary: {
            total: agents.length,
            completed: totalCompleted,
            failed: totalFailed,
            timeout: totalTimeout,
            byType: byType
          },
          agents: timeline,
          timeline: timeline
        });
      } catch (error) {
        console.error('Failed to get agent analytics:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get specific agent details
    this.app.get('/api/runs/:runName/agents/:agentId', async (req, res) => {
      try {
        const { runName, agentId } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        const resultsPath = path.join(runDir, 'coordinator', 'results_queue.jsonl');
        
        const fsSync = require('fs');
        if (!fsSync.existsSync(resultsPath)) {
          return res.status(404).json({ error: 'Agent not found' });
        }
        
        const content = await fs.readFile(resultsPath, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l);
        const agent = lines
          .map(line => JSON.parse(line))
          .find(a => a.agentId === agentId);
        
        if (!agent) {
          return res.status(404).json({ error: 'Agent not found' });
        }
        
        res.json(agent);
      } catch (error) {
        console.error('Failed to get agent details:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // ===== INTELLIGENCE API ENDPOINTS =====

    // API: Get complete intelligence summary for a run
    this.app.get('/api/runs/:runName/intelligence', async (req, res) => {
      try {
        const { runName } = req.params;
        const intelligence = await this.intelligenceBuilder.buildIntelligenceSummary(runName);
        res.json(intelligence);
      } catch (error) {
        console.error('Failed to build intelligence summary:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get top discoveries for a run
    this.app.get('/api/runs/:runName/discoveries', async (req, res) => {
      try {
        const { runName } = req.params;
        const count = parseInt(req.query.count) || 5;
        const discoveries = await this.intelligenceBuilder.extractTopDiscoveries(runName, count);
        res.json(discoveries);
      } catch (error) {
        console.error('Failed to extract discoveries:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get research trajectory for a run
    this.app.get('/api/runs/:runName/trajectory', async (req, res) => {
      try {
        const { runName } = req.params;
        const trajectory = await this.intelligenceBuilder.buildResearchTrajectory(runName);
        res.json(trajectory);
      } catch (error) {
        console.error('Failed to build trajectory:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get breakthrough timeline for a run
    this.app.get('/api/runs/:runName/breakthroughs', async (req, res) => {
      try {
        const { runName } = req.params;
        const breakthroughs = await this.intelligenceBuilder.buildBreakthroughTimeline(runName);
        res.json(breakthroughs);
      } catch (error) {
        console.error('Failed to build breakthrough timeline:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get agent impact analysis for a run
    this.app.get('/api/runs/:runName/impact', async (req, res) => {
      try {
        const { runName } = req.params;
        const impact = await this.intelligenceBuilder.buildAgentImpactAnalysis(runName);
        res.json(impact);
      } catch (error) {
        console.error('Failed to build impact analysis:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // ===== END INTELLIGENCE API =====

    // API: Export query result to run directory
    this.app.post('/api/query/export', async (req, res) => {
      try {
        const { runName, query, result, model, mode, timestamp, format } = req.body;
        
        if (!runName || !result || !format || format === 'none') {
          return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        // Determine target run directory
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);

        // Create run-specific QueryEngine instance with config (for local LLM support)
        const QueryEngine = require('./query-engine').QueryEngine || require('./query-engine');
        const runConfig = await this.loadRunConfig(runDir);
        const runQueryEngine = new QueryEngine(runDir, process.env.OPENAI_API_KEY, runConfig);

        // Build metadata from request
        const metadata = {
          runName,
          model,
          mode,
          timestamp,
          tokenUsage: result.tokenUsage,
          evidence: result.evidence,
          evidenceQuality: result.metadata?.evidenceQuality
        };
        
        // Use QueryEngine's export method (handles all formats consistently)
        const filepath = await runQueryEngine.exportResult(
          query,
          result.answer || result,
          format,
          metadata
        );

        res.json({
          success: true,
          filepath: path.relative(runDir, filepath),
          fullPath: filepath
        });
      } catch (error) {
        console.error('Export failed:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // ===== END RUN MANAGEMENT =====

    // ===== OPERATIONS API (Mission Control) =====

    // API: Get system health and process status
    this.app.get('/api/operations/status', async (req, res) => {
      try {
        const status = {
          orchestrator: { running: false, pid: null, uptime: null },
          dashboard: { running: true, port: this.port },
          mcp: { running: false, ports: [] },
          cluster: { enabled: false, instances: 0, healthy: 0 }
        };

        // Check if orchestrator is running (look for process)
        const { execSync } = require('child_process');
        try {
          // Try multiple patterns to find orchestrator
          let pgrep = null;
          try {
            pgrep = execSync('pgrep -f "node.*index.js"').toString().trim();
          } catch (e) {
            // Try alternative pattern
            try {
              pgrep = execSync('pgrep -f "COSMO"').toString().trim();
            } catch (e2) {
              // Not found
            }
          }
          
          if (pgrep) {
            const pid = parseInt(pgrep.split('\n')[0]);
            status.orchestrator.running = true;
            status.orchestrator.pid = pid;
            
            // Get process uptime
            const psOutput = execSync(`ps -p ${pid} -o etime=`).toString().trim();
            status.orchestrator.uptime = psOutput;
            
            // Get last cycle time to determine if actively cycling
            const thoughtsPath = path.join(this.logsDir, 'thoughts.jsonl');
            const fsSync = require('fs');
            if (fsSync.existsSync(thoughtsPath)) {
              const stats = fsSync.statSync(thoughtsPath);
              const lastModified = stats.mtimeMs;
              const ageSeconds = (Date.now() - lastModified) / 1000;
              
              if (ageSeconds < 120) {
                status.orchestrator.status = 'active';
                status.orchestrator.lastActivity = `${Math.round(ageSeconds)}s ago`;
              } else if (ageSeconds < 300) {
                status.orchestrator.status = 'idle';
                status.orchestrator.lastActivity = `${Math.round(ageSeconds)}s ago`;
              } else {
                status.orchestrator.status = 'paused';
                status.orchestrator.lastActivity = `${Math.round(ageSeconds / 60)}m ago`;
              }
            }
          }
        } catch (e) {
          // No orchestrator running
        }

        // Check MCP servers
        try {
          const mcpPorts = [];
          const lsofOutput = execSync('lsof -iTCP -sTCP:LISTEN -n -P').toString();
          if (lsofOutput.includes(':3346')) mcpPorts.push(3346);
          if (lsofOutput.includes(':3347')) mcpPorts.push(3347);
          status.mcp.running = mcpPorts.length > 0;
          status.mcp.ports = mcpPorts;
        } catch (e) {
          // MCP not running
        }

        // Check cluster status from config
        const configPath = path.join(__dirname, '..', 'config.yaml');
        const fsSync = require('fs');
        if (fsSync.existsSync(configPath)) {
          const yaml = require('js-yaml');
          const configContent = fsSync.readFileSync(configPath, 'utf8');
          const config = yaml.load(configContent);
          if (config.cluster?.enabled) {
            status.cluster.enabled = true;
            status.cluster.instances = config.cluster.instanceCount || 1;
            // Count running cluster instances
            try {
              const clusterProcs = execSync('pgrep -f "INSTANCE_ID=cosmo-"').toString().trim();
              status.cluster.healthy = clusterProcs.split('\n').filter(Boolean).length;
            } catch (e) {
              status.cluster.healthy = 0;
            }
          }
        }

        res.json(status);
      } catch (error) {
        console.error('Failed to get operations status:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get current cycle and execution state for specific run
    this.app.get('/api/operations/cycle-status', async (req, res) => {
      try {
        const runName = req.query.runName || 'runtime';
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        // Load state from specific run
        const statePath = path.join(runDir, 'state.json.gz');
        const fsSync = require('fs');
        let state = { cycleCount: 0, temporal: {}, cognitiveState: {} };
        
        if (fsSync.existsSync(statePath)) {
          const compressed = await fs.readFile(statePath);
          const decompressed = await gunzip(compressed);
          state = JSON.parse(decompressed.toString());
        }
        
        // Load metadata from specific run
        const metadataPath = path.join(runDir, 'run-metadata.json');
        let metadata = {};
        if (fsSync.existsSync(metadataPath)) {
          const metadataContent = await fs.readFile(metadataPath, 'utf-8');
          metadata = JSON.parse(metadataContent);
        }

        const cycleStatus = {
          currentCycle: state.cycleCount || 0,
          maxCycles: metadata?.maxCycles || null,
          mode: metadata?.explorationMode || 'unknown',
          domain: metadata?.domain || null,
          sleepState: state.temporal?.state || 'unknown',
          energy: state.cognitiveState?.energy || 0,
          fatigue: state.temporal?.fatigue || 0,
          nextCoordinatorReview: null
        };

        // Calculate next coordinator review
        if (metadata?.reviewPeriod) {
          const reviewPeriod = metadata.reviewPeriod;
          const nextReview = Math.ceil(cycleStatus.currentCycle / reviewPeriod) * reviewPeriod;
          cycleStatus.nextCoordinatorReview = nextReview - cycleStatus.currentCycle;
        }

        res.json(cycleStatus);
      } catch (error) {
        console.error('Failed to get cycle status:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get active workload (agents, queue, recent completions) for specific run
    this.app.get('/api/operations/workload', async (req, res) => {
      try {
        const runName = req.query.runName || 'runtime';
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        const resultsPath = path.join(runDir, 'coordinator', 'results_queue.jsonl');
        const workload = {
          activeAgents: [],
          queuedMissions: 0,
          recentCompletions: [],
          concurrency: { current: 0, max: 0 }
        };

        // Read agent results
        const fsSync = require('fs');
        if (fsSync.existsSync(resultsPath)) {
          const results = await this.readAgentResults(resultsPath);
          const now = Date.now();

          // Find active agents (status: running or queued)
          const active = results.filter(r => r.status === 'running');
          workload.activeAgents = active.map(a => ({
            type: a.agentType,
            elapsed: now - new Date(a.startTime).getTime(),
            startTime: a.startTime,
            mission: a.mission?.substring(0, 100) + '...' || 'Unknown'
          }));

          workload.concurrency.current = active.length;

          // Count queued missions (if tracked separately)
          const queued = results.filter(r => r.status === 'queued');
          workload.queuedMissions = queued.length;

          // Recent completions (last 10)
          const completed = results.filter(r => r.status === 'completed' || r.status === 'failed')
            .sort((a, b) => new Date(b.endTime) - new Date(a.endTime))
            .slice(0, 10);
          
          workload.recentCompletions = completed.map(a => ({
            type: a.agentType,
            duration: a.duration,
            status: a.status,
            endTime: a.endTime
          }));
        }

        // Get max concurrency from run-specific metadata
        const metadataPath = path.join(runDir, 'run-metadata.json');
        if (fsSync.existsSync(metadataPath)) {
          const metadataContent = await fs.readFile(metadataPath, 'utf-8');
          const metadata = JSON.parse(metadataContent);
          workload.concurrency.max = metadata?.maxConcurrent || 4;
        } else {
          workload.concurrency.max = 4;
        }

        res.json(workload);
      } catch (error) {
        console.error('Failed to get workload:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get resource metrics (tokens, memory, disk) for specific run
    this.app.get('/api/operations/resources', async (req, res) => {
      try {
        const runName = req.query.runName || 'runtime';
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        // Load state from specific run (handle fresh runs without state file)
        const statePath = path.join(runDir, 'state.json.gz');
        const fsSync = require('fs');
        let state = { memory: { nodes: [], edges: [] } };
        
        if (fsSync.existsSync(statePath)) {
          const compressed = await fs.readFile(statePath);
          const decompressed = await gunzip(compressed);
          state = JSON.parse(decompressed.toString());
        } else {
          // Fresh run - no state file yet, will use journals only
          console.log('[/api/operations/resources] No state file yet, using journals for node count');
        }
        
        // NEW: Include live journal nodes for accurate counts
        let liveJournalCount = 0;
        try {
          const agentsDir = path.join(runDir, 'agents');
          const agentDirs = await fs.readdir(agentsDir);
          const baselineNodeIds = new Set((state.memory?.nodes || []).map(n => n.id));
          
          for (const agentId of agentDirs) {
            if (!agentId.startsWith('agent_')) continue;
            
            for (const journalType of ['findings.jsonl', 'insights.jsonl']) {
              try {
                const journalPath = path.join(agentsDir, agentId, journalType);
                const content = await fs.readFile(journalPath, 'utf8');
                const lines = content.split('\n').filter(Boolean);
                
                for (const line of lines) {
                  try {
                    const entry = JSON.parse(line);
                    if (entry.nodeId && !baselineNodeIds.has(entry.nodeId)) {
                      liveJournalCount++;
                      baselineNodeIds.add(entry.nodeId); // Dedupe
                    }
                  } catch { /* skip corrupted line */ }
                }
              } catch { /* no journal file */ }
            }
          }
        } catch { /* agents dir doesn't exist */ }
        
        const resources = {
          tokens: { hourly: 0, daily: 0, limit: 1000000 },
          apiCalls: { perMinute: 0 },
          memory: {
            nodes: (state.memory?.nodes?.length || 0) + liveJournalCount,
            baselineNodes: state.memory?.nodes?.length || 0,
            liveNodes: liveJournalCount,
            edges: state.memory?.edges?.length || 0,
            density: 0
          },
          diskUsage: { bytes: 0, formatted: '0 MB' }
        };

        // Calculate memory density
        if (resources.memory.nodes > 0) {
          resources.memory.density = (resources.memory.edges / resources.memory.nodes).toFixed(1);
        }

        // Get disk usage for specific run (follow symlinks with -L)
        const { execSync } = require('child_process');
        try {
          const duOutput = execSync(`du -shL ${runDir}`).toString().trim();
          const sizeStr = duOutput.split('\t')[0];
          resources.diskUsage.formatted = sizeStr;
          
          // Parse to bytes (use -k for kilobytes as -b is GNU only)
          const duKBytes = execSync(`du -skL ${runDir}`).toString().trim();
          resources.diskUsage.bytes = parseInt(duKBytes.split('\t')[0]) * 1024;
        } catch (e) {
          // Fallback if du fails
        }

        // Token usage from run-specific metrics
        const metricsPath = path.join(runDir, 'evaluation-metrics.json');
        if (fsSync.existsSync(metricsPath)) {
          const metrics = JSON.parse(fsSync.readFileSync(metricsPath, 'utf8'));
          if (metrics.tokenUsage) {
            resources.tokens = metrics.tokenUsage;
          }
        }

        res.json(resources);
      } catch (error) {
        console.error('Failed to get resources:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Pause orchestrator (graceful - completes current cycle)
    this.app.post('/api/operations/pause', async (req, res) => {
      try {
        // Create sentinel file that orchestrator checks each cycle
        const pauseFile = path.join(this.defaultRunDir, '.pause_requested');
        await fs.writeFile(pauseFile, new Date().toISOString());
        
        res.json({ 
          success: true, 
          message: 'Pause requested - will pause after current cycle completes'
        });
      } catch (error) {
        console.error('Failed to pause:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Resume orchestrator
    this.app.post('/api/operations/resume', async (req, res) => {
      try {
        // Remove sentinel file
        const pauseFile = path.join(this.defaultRunDir, '.pause_requested');
        const fsSync = require('fs');
        if (fsSync.existsSync(pauseFile)) {
          await fs.unlink(pauseFile);
        }
        
        res.json({ 
          success: true, 
          message: 'Orchestrator resumed'
        });
      } catch (error) {
        console.error('Failed to resume:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get all deliverables (agent outputs) with metadata
    this.app.get('/api/deliverables', async (req, res) => {
      try {
        const runName = req.query.runName || 'runtime';
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        const outputsDir = path.join(runDir, 'outputs');
        
        const deliverables = [];
        
        // Check if outputs directory exists
        const fsSync = require('fs');
        if (!fsSync.existsSync(outputsDir)) {
          return res.json({ deliverables: [], runName });
        }
        
        // Scan all agent type directories (code-creation, code-execution, etc)
        const agentTypes = await fs.readdir(outputsDir);
        
        for (const agentType of agentTypes) {
          const agentTypeDir = path.join(outputsDir, agentType);
          const stat = await fs.stat(agentTypeDir);
          
          if (!stat.isDirectory()) continue;
          
          // Scan agent output directories
          const agentDirs = await fs.readdir(agentTypeDir);
          
          for (const agentDir of agentDirs) {
            if (!agentDir.startsWith('agent_')) continue;
            
            const agentOutputDir = path.join(agentTypeDir, agentDir);
            const agentStat = await fs.stat(agentOutputDir);
            
            if (!agentStat.isDirectory()) continue;
            
            try {
              // Check for completion marker
              const completeMarkerPath = path.join(agentOutputDir, '.complete');
              let isComplete = false;
              let completionData = null;
              
              try {
                const markerContent = await fs.readFile(completeMarkerPath, 'utf8');
                completionData = JSON.parse(markerContent);
                isComplete = true;
              } catch (e) {
                isComplete = false;
              }
              
              // Read deliverables manifest
              const manifestPath = path.join(agentOutputDir, 'deliverables-manifest.json');
              let manifest = null;
              
              try {
                const manifestContent = await fs.readFile(manifestPath, 'utf8');
                manifest = JSON.parse(manifestContent);
              } catch (e) {
                // No manifest - try regular manifest.json
                const altManifestPath = path.join(agentOutputDir, 'manifest.json');
                try {
                  const altContent = await fs.readFile(altManifestPath, 'utf8');
                  manifest = JSON.parse(altContent);
                } catch (e2) {
                  // No manifest at all - just count files
                }
              }
              
              // Count files in directory
              const allFiles = await fs.readdir(agentOutputDir, { withFileTypes: true, recursive: true });
              const dataFiles = allFiles.filter(f => 
                f.isFile() && 
                !f.name.startsWith('.') && 
                !f.name.startsWith('_debug') &&
                !f.name.endsWith('.tmp')
              );
              
              // Calculate total size
              let totalSize = 0;
              for (const file of dataFiles) {
                try {
                  const filePath = path.join(agentOutputDir, file.name);
                  const fileStat = await fs.stat(filePath);
                  totalSize += fileStat.size;
                } catch (e) {
                  // Skip files we can't stat
                }
              }
              
              deliverables.push({
                agentId: agentDir,
                agentType: agentType,
                path: agentOutputDir,
                relativePath: path.join('runtime', 'outputs', agentType, agentDir),
                isComplete,
                completionData,
                manifest: manifest ? {
                  projectName: manifest.projectName || manifest.agentId,
                  language: manifest.language,
                  type: manifest.type,
                  generatedAt: manifest.generatedAt,
                  totalFiles: manifest.totalFiles || dataFiles.length
                } : null,
                fileCount: dataFiles.length,
                totalSize,
                createdAt: agentStat.birthtime,
                modifiedAt: agentStat.mtime
              });
            } catch (error) {
              console.error(`Failed to process agent output ${agentDir}:`, error.message);
              // Continue with other deliverables
            }
          }
        }
        
        // Sort by creation time (newest first)
        deliverables.sort((a, b) => b.createdAt - a.createdAt);
        
        res.json({
          deliverables,
          runName,
          total: deliverables.length,
          complete: deliverables.filter(d => d.isComplete).length,
          incomplete: deliverables.filter(d => !d.isComplete).length
        });
      } catch (error) {
        console.error('Failed to get deliverables:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get deliverable file tree
    this.app.get('/api/deliverables/:agentId/tree', async (req, res) => {
      try {
        const { agentId } = req.params;
        const runName = req.query.runName || 'runtime';
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        // Find agent output directory
        const outputsDir = path.join(runDir, 'outputs');
        const agentTypes = await fs.readdir(outputsDir);
        
        let agentOutputDir = null;
        for (const agentType of agentTypes) {
          const candidatePath = path.join(outputsDir, agentType, agentId);
          const fsSync = require('fs');
          if (fsSync.existsSync(candidatePath)) {
            agentOutputDir = candidatePath;
            break;
          }
        }
        
        if (!agentOutputDir) {
          return res.status(404).json({ error: 'Agent output not found' });
        }
        
        // Build file tree
        const buildTree = async (dir, basePath = '') => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const tree = [];
          
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.join(basePath, entry.name);
            
            if (entry.isDirectory()) {
              // Skip debug directories
              if (entry.name.startsWith('_debug') || entry.name.startsWith('.')) {
                continue;
              }
              
              tree.push({
                name: entry.name,
                type: 'directory',
                path: relativePath,
                children: await buildTree(fullPath, relativePath)
              });
            } else {
              // Skip temp and hidden files
              if (entry.name.startsWith('.') || entry.name.endsWith('.tmp')) {
                continue;
              }
              
              const stats = await fs.stat(fullPath);
              tree.push({
                name: entry.name,
                type: 'file',
                path: relativePath,
                size: stats.size,
                modified: stats.mtime
              });
            }
          }
          
          return tree;
        };
        
        const tree = await buildTree(agentOutputDir);
        
        res.json({
          agentId,
          outputDir: agentOutputDir,
          tree
        });
      } catch (error) {
        console.error('Failed to get file tree:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Download deliverable file
    // Using query parameter instead of wildcard path to avoid Express routing issues
    this.app.get('/api/deliverables/:agentId/download', async (req, res) => {
      try {
        const { agentId } = req.params;
        const filePath = req.query.file; // Pass as ?file=path/to/file.js
        const runName = req.query.runName || 'runtime';
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        if (!filePath) {
          return res.status(400).json({ error: 'File path required (?file=path/to/file)' });
        }
        
        // Find agent output directory
        const outputsDir = path.join(runDir, 'outputs');
        const agentTypes = await fs.readdir(outputsDir);
        
        let agentOutputDir = null;
        for (const agentType of agentTypes) {
          const candidatePath = path.join(outputsDir, agentType, agentId);
          const fsSync = require('fs');
          if (fsSync.existsSync(candidatePath)) {
            agentOutputDir = candidatePath;
            break;
          }
        }
        
        if (!agentOutputDir) {
          return res.status(404).json({ error: 'Agent output not found' });
        }
        
        // Security: Ensure file path is within agent output directory
        const fullFilePath = path.join(agentOutputDir, filePath);
        const normalizedPath = path.normalize(fullFilePath);
        
        if (!normalizedPath.startsWith(agentOutputDir)) {
          return res.status(403).json({ error: 'Access denied' });
        }
        
        // Check file exists
        const fsSync = require('fs');
        if (!fsSync.existsSync(fullFilePath)) {
          return res.status(404).json({ error: 'File not found' });
        }
        
        // Send file
        res.download(fullFilePath, path.basename(filePath));
      } catch (error) {
        console.error('Failed to download file:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Open directory in Finder/Explorer
    this.app.post('/api/operations/open-finder', async (req, res) => {
      try {
        const { path: dirPath } = req.body;
        
        if (!dirPath) {
          return res.status(400).json({ error: 'Path required' });
        }
        
        const { exec } = require('child_process');
        const fsSync = require('fs');
        
        // Verify path exists
        if (!fsSync.existsSync(dirPath)) {
          return res.status(404).json({ error: 'Path not found', path: dirPath });
        }
        
        // Detect OS and use appropriate command
        const platform = process.platform;
        let command;
        
        if (platform === 'darwin') {
          command = `open "${dirPath}"`;
        } else if (platform === 'win32') {
          command = `explorer "${dirPath}"`;
        } else {
          // Linux
          command = `xdg-open "${dirPath}" || nautilus "${dirPath}" || dolphin "${dirPath}"`;
        }
        
        exec(command, (error) => {
          if (error) {
            console.error('Failed to open in file manager:', error);
          }
        });
        
        res.json({ 
          success: true, 
          message: 'Opening in file manager...',
          path: dirPath
        });
      } catch (error) {
        console.error('Failed to open finder:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // ===== MISSION TRACING API ENDPOINTS (NEW) =====
    
    // API: Trace missions in a specific run
    this.app.get('/api/trace/:runName', async (req, res) => {
      try {
        const { runName } = req.params;
        const { agentType, minSources, format } = req.query;
        
        const tracer = new MissionTracer({
          agentType: agentType || null,
          minSources: parseInt(minSources) || 0,
          format: format || 'json',
          full: req.query.full === 'true'
        });
        
        const missions = await tracer.traceRun(runName);
        
        // For JSON format, return structured data
        if (!format || format === 'json') {
          res.json({
            run: runName,
            tracedAt: new Date().toISOString(),
            missionsCount: missions.length,
            missions: missions.map(m => tracer.extractMissionData(m))
          });
        } else {
          // For markdown/summary, generate and return as text
          const report = tracer.generateReport(runName, missions);
          res.type('text/plain').send(report);
        }
      } catch (error) {
        console.error('Trace failed:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // API: Cross-domain comparison
    this.app.get('/api/trace/compare', async (req, res) => {
      try {
        const domains = req.query.domains 
          ? req.query.domains.split(',')
          : ['Biology', 'Chemistry', 'Physics', 'Psychology', 'Philosophy', 
             'Mathematics', 'Art_and_Music', 'History', 'Medicine'];
        
        const comparison = [];
        
        for (const runName of domains) {
          try {
            const tracer = new MissionTracer({ agentType: 'research' });
            const missions = await tracer.traceRun(runName);
            
            const researchAgents = missions.filter(m => 
              m.agentSpecificData?.sourcesFound > 0
            );
            
            if (researchAgents.length === 0) continue;
            
            const totalSources = researchAgents.reduce((sum, m) => 
              sum + (m.agentSpecificData.sourcesFound || 0), 0
            );
            
            const avgSources = (totalSources / researchAgents.length).toFixed(1);
            const maxSources = Math.max(...researchAgents.map(m => m.agentSpecificData.sourcesFound));
            
            comparison.push({
              domain: runName,
              researchAgents: researchAgents.length,
              totalSources,
              avgSources: parseFloat(avgSources),
              maxSources,
              bestAgent: researchAgents.find(m => m.agentSpecificData.sourcesFound === maxSources)?.agentId
            });
          } catch (error) {
            console.error(`Failed to trace ${runName}:`, error.message);
          }
        }
        
        // Sort by total sources
        comparison.sort((a, b) => b.totalSources - a.totalSources);
        
        res.json({
          comparedAt: new Date().toISOString(),
          domains: comparison.length,
          totalMissions: comparison.reduce((sum, c) => sum + c.researchAgents, 0),
          totalSources: comparison.reduce((sum, c) => sum + c.totalSources, 0),
          comparison
        });
      } catch (error) {
        console.error('Comparison failed:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // API: Export sources as BibTeX
    this.app.post('/api/trace/export/bibtex', async (req, res) => {
      try {
        const { runName, agentId, sources } = req.body;
        
        if (!sources || !Array.isArray(sources)) {
          return res.status(400).json({ error: 'Sources array required' });
        }
        
        const bibtex = this.generateBibTeX(sources, { runName, agentId });
        
        // Set headers for file download
        res.setHeader('Content-Type', 'application/x-bibtex');
        res.setHeader('Content-Disposition', `attachment; filename="${runName || 'cosmo'}_sources.bib"`);
        res.send(bibtex);
      } catch (error) {
        console.error('BibTeX export failed:', error);
        res.status(500).json({ error: error.message });
      }
    });
    
    // API: Get provenance chain for a mission
    this.app.get('/api/trace/:runName/provenance/:agentId', async (req, res) => {
      try {
        const { runName, agentId } = req.params;
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        // Get mission data
        const resultsQueuePath = path.join(runDir, 'coordinator', 'results_queue.jsonl');
        const content = await fs.readFile(resultsQueuePath, 'utf8');
        const missions = content.trim().split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line))
          .filter(entry => entry.agentId);
        
        const mission = missions.find(m => m.agentId === agentId);
        if (!mission) {
          return res.status(404).json({ error: 'Mission not found' });
        }
        
        const chain = {
          agentId: mission.agentId,
          agentType: mission.agentType,
          links: []
        };
        
        // Link 1: Goal (if exists)
        if (mission.mission?.goalId) {
          const goalData = await this.findGoalData(runDir, mission.mission.goalId);
          if (goalData) {
            chain.links.push({
              type: 'goal',
              id: mission.mission.goalId,
              description: goalData.description,
              created: goalData.created,
              priority: goalData.priority,
              source: goalData.source
            });
          }
        }
        
        // Link 2: Coordinator Review (if spawn cycle known)
        if (mission.mission?.spawnCycle !== undefined) {
          const reviewData = await this.findCoordinatorReview(runDir, mission.mission.spawnCycle);
          if (reviewData) {
            chain.links.push({
              type: 'coordinator_review',
              cycle: mission.mission.spawnCycle,
              file: reviewData.file,
              summary: reviewData.summary,
              goalsEvaluated: reviewData.goalsEvaluated,
              agentsCompleted: reviewData.agentsCompleted
            });
          }
        }
        
        // Link 3: Spawning source
        if (mission.mission?.createdBy) {
          chain.links.push({
            type: 'spawned_by',
            source: mission.mission.createdBy,
            reason: mission.mission?.spawningReason,
            trigger: mission.mission?.triggerSource
          });
        }
        
        // Link 4: Downstream impact (what used these findings?)
        if (mission.results && mission.results.length > 0) {
          const nodeIds = mission.results
            .filter(r => r.nodeId)
            .map(r => r.nodeId);
          
          if (nodeIds.length > 0) {
            const downstream = await this.findDownstreamUsage(missions, nodeIds);
            if (downstream.length > 0) {
              chain.links.push({
                type: 'downstream_usage',
                usedBy: downstream
              });
            }
          }
        }
        
        res.json(chain);
      } catch (error) {
        console.error('Provenance chain failed:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Force wake from sleep mode
    this.app.post('/api/operations/force-wake', async (req, res) => {
      try {
        const { StateCompression } = require('../core/state-compression');
        const statePath = path.join(this.defaultRunDir, 'state.json');

        // Load current state
        const state = await StateCompression.loadCompressed(statePath);
        
        // Check if actually sleeping
        const isSleeping = state.cognitiveState?.mode === 'sleeping' || state.temporal?.state === 'sleeping';
        
        if (!isSleeping) {
          return res.json({ 
            success: false, 
            message: 'System is not currently sleeping',
            currentEnergy: state.cognitiveState?.energy,
            cognitiveMode: state.cognitiveState?.mode,
            temporalState: state.temporal?.state
          });
        }
        
        // Force wake by restoring energy and setting both systems to awake
        if (state.cognitiveState) {
          state.cognitiveState.energy = 0.9;  // Restore energy above wake threshold (0.8)
          state.cognitiveState.mode = 'active';
          state.cognitiveState.lastModeChange = new Date().toISOString();
        }
        
        if (state.temporal) {
          state.temporal.state = 'awake';
          state.temporal.lastWakeTime = new Date().toISOString();
        }
        
        // Save modified state
        await StateCompression.saveCompressed(statePath, state, {
          compress: true,
          pretty: false
        });
        
        res.json({ 
          success: true, 
          message: 'Force wake applied - system will resume on next cycle',
          restoredEnergy: state.cognitiveState?.energy,
          newMode: state.cognitiveState?.mode
        });
      } catch (error) {
        console.error('Failed to force wake:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Stop orchestrator (graceful shutdown)
    this.app.post('/api/operations/stop', async (req, res) => {
      try {
        const { execSync } = require('child_process');
        
        // Find orchestrator PID
        let pid = null;
        try {
          const pgrep = execSync('pgrep -f "node.*index.js"').toString().trim();
          if (pgrep) {
            pid = parseInt(pgrep.split('\n')[0]);
          }
        } catch (e) {
          return res.status(404).json({ error: 'Orchestrator not running' });
        }

        if (!pid) {
          return res.status(404).json({ error: 'Orchestrator not running' });
        }

        // Send SIGTERM for graceful shutdown
        res.json({ 
          success: true, 
          message: 'Graceful shutdown initiated - orchestrator will complete current cycle and save state'
        });

        // Send signal after response
        setTimeout(() => {
          try {
            process.kill(pid, 'SIGTERM');
          } catch (e) {
            console.error('Failed to send SIGTERM:', e);
          }
        }, 100);

      } catch (error) {
        console.error('Failed to stop:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Shutdown all services (orchestrator + dashboards)
    this.app.post('/api/operations/shutdown-all', async (req, res) => {
      try {
        const { execSync } = require('child_process');
        
        res.json({ 
          success: true, 
          message: 'Shutting down all COSMO services...'
        });

        // Execute shutdown script after response sent
        setTimeout(() => {
          const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'STOP_ALL.sh');
          execSync(scriptPath, { stdio: 'inherit' });
        }, 500);

      } catch (error) {
        console.error('Failed to shutdown all:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get current research activity (latest thought, goal, mission)
    this.app.get('/api/operations/current-activity', async (req, res) => {
      try {
        const runName = req.query.runName || 'runtime';
        const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        const activity = {
          latestThought: null,
          currentGoal: null,
          missionStrategy: null
        };

        // Get latest thought
        const thoughtsPath = path.join(runDir, 'thoughts.jsonl');
        const fsSync = require('fs');
        if (fsSync.existsSync(thoughtsPath)) {
          const fileContent = await fs.readFile(thoughtsPath, 'utf-8');
          const lines = fileContent.trim().split('\n').filter(l => l.trim());
          if (lines.length > 0) {
            try {
              const latestThought = JSON.parse(lines[lines.length - 1]);
              activity.latestThought = {
                cycle: latestThought.cycle,
                role: latestThought.role,
                thought: latestThought.thought,
                goal: latestThought.goal,
                surprise: latestThought.surprise,
                timestamp: latestThought.timestamp
              };
            } catch (e) {
              // Skip if malformed
            }
          }
        }

        // Get current goal from state
        const statePath = path.join(runDir, 'state.json.gz');
        if (fsSync.existsSync(statePath)) {
          const compressed = await fs.readFile(statePath);
          const decompressed = await gunzip(compressed);
          const state = JSON.parse(decompressed.toString());
          
          // Get mission plan for guided mode
          if (state.guidedMissionPlan) {
            activity.missionStrategy = state.guidedMissionPlan.strategy;
          }
          
          // Find most recently pursued goal
          if (state.goals && state.goals.active) {
            const activeGoals = Object.values(state.goals.active);
            const sorted = activeGoals.sort((a, b) => (b.lastPursued || 0) - (a.lastPursued || 0));
            if (sorted.length > 0 && sorted[0].lastPursued) {
              activity.currentGoal = {
                description: sorted[0].description,
                progress: sorted[0].progress,
                pursuitCount: sorted[0].pursuitCount
              };
            }
          }
        }

        res.json(activity);
      } catch (error) {
        console.error('Failed to get current activity:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // ===== END OPERATIONS API =====

    // Dedicated insights explorer page
    this.app.get('/insights', (req, res) => {
      res.sendFile(path.join(__dirname, 'insights.html'));
    });

    // Dedicated dreams explorer page
    this.app.get('/dreams', (req, res) => {
      res.sendFile(path.join(__dirname, 'dreams.html'));
    });

    // Evaluation metrics dashboard
    this.app.get('/evaluation', (req, res) => {
      res.sendFile(path.join(__dirname, 'evaluation-view.html'));
    });

    // API: Get tasks
    this.app.get('/api/tasks', async (req, res) => {
      try {
        // Read directly from filesystem
        const tasksDir = path.join(this.defaultRunDir, 'tasks');
        const tasks = [];
        
        // Read from all task state directories
        const taskStates = ['pending', 'assigned', 'blocked', 'complete', 'failed'];
        
        for (const state of taskStates) {
          const stateDir = path.join(tasksDir, state);
          try {
            const entries = await fs.readdir(stateDir);
            for (const filename of entries) {
              if (filename.endsWith('.json')) {
                try {
                  const taskPath = path.join(stateDir, filename);
                  const taskContent = await fs.readFile(taskPath, 'utf-8');
                  const task = JSON.parse(taskContent);
                  tasks.push(task);
                } catch (error) {
                  // Skip invalid task file
                }
              }
            }
          } catch (error) {
            // Directory doesn't exist or can't read
          }
        }
        
        // Also check assigned subdirectories
        const assignedDir = path.join(tasksDir, 'assigned');
        try {
          const instances = await fs.readdir(assignedDir);
          for (const instanceId of instances) {
            const instanceDir = path.join(assignedDir, instanceId);
            const stat = await fs.stat(instanceDir);
            if (stat.isDirectory()) {
              const entries = await fs.readdir(instanceDir);
              for (const filename of entries) {
                if (filename.endsWith('.json')) {
                  try {
                    const taskPath = path.join(instanceDir, filename);
                    const taskContent = await fs.readFile(taskPath, 'utf-8');
                    const task = JSON.parse(taskContent);
                    tasks.push(task);
                  } catch (error) {
                    // Skip invalid task
                  }
                }
              }
            }
          }
        } catch (error) {
          // No assigned directory or can't read
        }
        
        // Group by state
        const grouped = {
          pending: tasks.filter(t => t.state === 'PENDING'),
          claimed: tasks.filter(t => t.state === 'CLAIMED'),
          inProgress: tasks.filter(t => t.state === 'IN_PROGRESS'),
          blocked: tasks.filter(t => t.state === 'BLOCKED'),
          done: tasks.filter(t => t.state === 'DONE'),
          failed: tasks.filter(t => t.state === 'FAILED')
        };
        
        res.json({
          tasks: grouped,
          total: tasks.length
        });
      } catch (error) {
        this.logger.error('Failed to get tasks', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get active plan with milestones
    this.app.get('/api/plan', async (req, res) => {
      try {
        // Read directly from filesystem (dashboard server doesn't have orchestrator access)
        const plansDir = path.join(this.defaultRunDir, 'plans');
        const milestonesDir = path.join(this.defaultRunDir, 'milestones');
        const planPath = path.join(plansDir, 'plan:main.json');
        
        // Check if plan file exists
        let plan = null;
        try {
          const planContent = await fs.readFile(planPath, 'utf-8');
          plan = JSON.parse(planContent);
        } catch (error) {
          // No plan file - not in guided mode or plan not created yet
          return res.json({ plan: null, milestones: [], source: 'none' });
        }
        
        // Load milestones
        const milestones = [];
        for (const milestoneId of plan.milestones || []) {
          try {
            const milestonePath = path.join(milestonesDir, `${milestoneId}.json`);
            const milestoneContent = await fs.readFile(milestonePath, 'utf-8');
            milestones.push(JSON.parse(milestoneContent));
          } catch (error) {
            this.logger.warn('Failed to load milestone', { milestoneId, error: error.message });
          }
        }
        
        // Load guided-plan.md for full details
        const planMarkdownPath = path.join(this.defaultRunDir, 'guided-plan.md');
        let planMarkdown = null;
        try {
          planMarkdown = await fs.readFile(planMarkdownPath, 'utf-8');
        } catch (error) {
          // Markdown not available
        }
        
        // Load tasks to build complete plan view
        const tasksDir = path.join(this.defaultRunDir, 'tasks');
        const allTasks = [];
        const taskStates = ['pending', 'assigned', 'blocked', 'complete', 'failed'];
        
        for (const state of taskStates) {
          const stateDir = path.join(tasksDir, state);
          try {
            const entries = await fs.readdir(stateDir);
            for (const filename of entries) {
              if (filename.endsWith('.json') && filename.startsWith('task:phase')) {
                const taskPath = path.join(stateDir, filename);
                const taskContent = await fs.readFile(taskPath, 'utf-8');
                allTasks.push(JSON.parse(taskContent));
              }
            }
          } catch (error) {
            // Directory doesn't exist
          }
        }
        
        // Check assigned subdirectories
        const assignedDir = path.join(tasksDir, 'assigned');
        try {
          const instances = await fs.readdir(assignedDir);
          for (const instanceId of instances) {
            const instanceDir = path.join(assignedDir, instanceId);
            const entries = await fs.readdir(instanceDir);
            for (const filename of entries) {
              if (filename.endsWith('.json') && filename.startsWith('task:phase')) {
                const taskPath = path.join(instanceDir, filename);
                const taskContent = await fs.readFile(taskPath, 'utf-8');
                allTasks.push(JSON.parse(taskContent));
              }
            }
          }
        } catch (error) {
          // No assigned tasks
        }
        
        // Build enhanced markdown with full details
        const enhancedMarkdown = this.buildEnhancedPlanMarkdown(plan, milestones, allTasks, planMarkdown);
        plan.markdown = enhancedMarkdown;
        plan.tasks = allTasks; // Include tasks for reference
        
        res.json({
          plan,
          milestones,
          activeMilestone: milestones.find(m => m.id === plan.activeMilestone),
          source: 'filesystem'
        });
      } catch (error) {
        this.logger.error('Failed to get plan', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get pending plan actions from queue
    this.app.get('/api/plan/queue', async (req, res) => {
      try {
        const actionsQueuePath = path.join(this.defaultRunDir, 'actions-queue.json');
        
        let actionsData = { actions: [] };
        try {
          const content = await fs.readFile(actionsQueuePath, 'utf-8');
          actionsData = JSON.parse(content);
        } catch (error) {
          // No queue file yet
        }
        
        // Filter to plan-related actions
        const planActions = (actionsData.actions || []).filter(a => 
          a.type === 'inject_plan' || a.type === 'complete_plan'
        );
        
        res.json({
          pending: planActions.filter(a => a.status === 'pending'),
          processing: planActions.filter(a => a.status === 'processing'),
          completed: planActions.filter(a => a.status === 'completed').slice(-5), // Last 5 completed
          total: planActions.length
        });
      } catch (error) {
        this.logger.error('Failed to get plan queue', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get archived plans
    this.app.get('/api/plan/archived', async (req, res) => {
      try {
        const plansDir = path.join(this.defaultRunDir, 'plans');
        
        let archivedPlans = [];
        try {
          const files = await fs.readdir(plansDir);
          const archivedFiles = files.filter(f => f.includes('_archived_') && f.endsWith('.json'));
          
          for (const file of archivedFiles.slice(-10)) { // Last 10 archived
            try {
              const content = await fs.readFile(path.join(plansDir, file), 'utf-8');
              const plan = JSON.parse(content);
              archivedPlans.push({
                ...plan,
                filename: file
              });
            } catch (error) {
              // Skip invalid files
            }
          }
          
          // Sort by archived time descending
          archivedPlans.sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
        } catch (error) {
          // No plans directory
        }
        
        res.json({ archived: archivedPlans });
      } catch (error) {
        this.logger.error('Failed to get archived plans', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // API: Manually complete a task (queue-based like MCP spawn_agent)
    this.app.post('/api/tasks/:taskId/complete', async (req, res) => {
      try {
        const { taskId } = req.params;
        const { reason, skipValidation } = req.body;
        
        // Write to actions queue (same pattern as MCP spawn_agent)
        const actionsQueuePath = path.join(this.logsDir, 'actions-queue.json');
        
        let actionsData = { actions: [] };
        try {
          const content = await fs.readFile(actionsQueuePath, 'utf-8');
          actionsData = JSON.parse(content);
        } catch (error) {
          // File doesn't exist yet, start with empty array
        }
        
        actionsData.actions = actionsData.actions || [];
        
        // Create action for orchestrator to process
        const newAction = {
          actionId: `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          type: skipValidation ? 'complete_task' : 'validate_task',
          taskId,
          reason: reason || (skipValidation ? 'Manual completion from dashboard' : 'Manual validation from dashboard'),
          requestedAt: new Date().toISOString(),
          source: 'dashboard_plan_tab',
          status: 'pending',
          metadata: {
            skipValidation,
            requestedBy: 'user_dashboard'
          }
        };
        
        actionsData.actions.push(newAction);
        await fs.writeFile(actionsQueuePath, JSON.stringify(actionsData, null, 2), 'utf-8');
        
        console.log(`✓ Task ${skipValidation ? 'completion' : 'validation'} queued`, {
          actionId: newAction.actionId,
          taskId
        });
        
        return res.json({
          success: true,
          message: skipValidation 
            ? 'Task completion queued. Orchestrator will process on next cycle and check milestone progression.'
            : 'Task validation queued. Orchestrator will spawn QA agent on next cycle.',
          method: 'actions_queue',
          actionId: newAction.actionId,
          taskId
        });
        
      } catch (error) {
        console.error('Failed to queue task action', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get detailed task status (comprehensive diagnostics)
    this.app.get('/api/tasks/:taskId/status', async (req, res) => {
      try {
        const { taskId } = req.params;
        const tasksDir = path.join(this.logsDir, 'tasks');
        
        // Find the task
        let task = null;
        let taskLocation = null;
        
        for (const state of ['assigned', 'pending', 'blocked', 'complete', 'failed']) {
          const stateDir = path.join(tasksDir, state);
          try {
            if (state === 'assigned') {
              const instances = await fs.readdir(stateDir);
              for (const instanceId of instances) {
                const taskPath = path.join(stateDir, instanceId, `${taskId}.json`);
                try {
                  const content = await fs.readFile(taskPath, 'utf-8');
                  task = JSON.parse(content);
                  taskLocation = state;
                  break;
                } catch (e) {}
              }
            } else {
              const taskPath = path.join(stateDir, `${taskId}.json`);
              try {
                const content = await fs.readFile(taskPath, 'utf-8');
                task = JSON.parse(content);
                taskLocation = state;
                break;
              } catch (e) {}
            }
            if (task) break;
          } catch (e) {}
        }
        
        if (!task) {
          return res.status(404).json({ error: 'Task not found' });
        }
        
        // Gather comprehensive status
        const status = {
          task: {
            id: task.id,
            title: task.title,
            state: task.state,
            location: taskLocation,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            startCycle: task.startCycle,
            assignedAgentId: task.assignedAgentId,
            claimedBy: task.claimedBy,
            goalId: task.metadata?.goalId
          },
          agent: null,
          outputs: null,
          validation: null,
          timing: null
        };
        
        // Check if agent exists and get details
        if (task.assignedAgentId) {
          const agentDir = path.join(this.logsDir, 'agents', task.assignedAgentId);
          
          try {
            // Check agent directory
            const agentDirExists = await fs.access(agentDir).then(() => true).catch(() => false);
            
            if (agentDirExists) {
              const agentFiles = await fs.readdir(agentDir);
              
              // Read findings if exist
              let findingsCount = 0;
              if (agentFiles.includes('findings.jsonl')) {
                const findingsContent = await fs.readFile(path.join(agentDir, 'findings.jsonl'), 'utf-8');
                findingsCount = findingsContent.trim().split('\n').filter(l => l.trim()).length;
              }
              
              // Read insights if exist
              let insightsCount = 0;
              if (agentFiles.includes('insights.jsonl')) {
                const insightsContent = await fs.readFile(path.join(agentDir, 'insights.jsonl'), 'utf-8');
                insightsCount = insightsContent.trim().split('\n').filter(l => l.trim()).length;
              }
              
              status.agent = {
                id: task.assignedAgentId,
                type: task.metadata?.agentType,
                directoryExists: true,
                files: agentFiles,
                findingsCount,
                insightsCount
              };
            }
          } catch (e) {}
          
          // Check for agent outputs
          if (task.metadata?.agentType) {
            // Convert agent type to directory name (underscore → hyphen)
            const agentTypeDirName = task.metadata.agentType.replace(/_/g, '-');
            const outputDir = path.join(this.logsDir, 'outputs', agentTypeDirName, task.assignedAgentId);
            
            try {
              const outputDirExists = await fs.access(outputDir).then(() => true).catch(() => false);
              
              if (outputDirExists) {
                const outputFiles = await fs.readdir(outputDir);
                
                // Count file types
                const fileTypes = {
                  python: outputFiles.filter(f => f.endsWith('.py')).length,
                  javascript: outputFiles.filter(f => f.endsWith('.js')).length,
                  markdown: outputFiles.filter(f => f.endsWith('.md')).length,
                  json: outputFiles.filter(f => f.endsWith('.json')).length,
                  other: outputFiles.filter(f => !f.match(/\.(py|js|md|json)$/)).length
                };
                
                // Check for deliverables manifest
                let deliverables = null;
                if (outputFiles.includes('deliverables-manifest.json')) {
                  try {
                    const manifestContent = await fs.readFile(
                      path.join(outputDir, 'deliverables-manifest.json'), 
                      'utf-8'
                    );
                    deliverables = JSON.parse(manifestContent);
                  } catch (e) {}
                }
                
                // Get directory size
                let totalSize = 0;
                for (const file of outputFiles) {
                  try {
                    const stats = await fs.stat(path.join(outputDir, file));
                    if (stats.isFile()) {
                      totalSize += stats.size;
                    }
                  } catch (e) {}
                }
                
                status.outputs = {
                  directory: outputDir,
                  exists: true,
                  fileCount: outputFiles.length,
                  fileTypes,
                  totalSizeBytes: totalSize,
                  totalSizeMB: (totalSize / 1024 / 1024).toFixed(2),
                  files: outputFiles.slice(0, 20), // First 20 files
                  deliverables: deliverables?.files || null
                };
              } else {
                status.outputs = {
                  exists: false,
                  note: 'Agent has not created outputs yet'
                };
              }
            } catch (e) {
              status.outputs = { error: e.message };
            }
          }
        }
        
        // Validation status
        if (task.metadata?.validationAttempted) {
          status.validation = {
            attempted: true,
            cycle: task.metadata.validationCycle,
            attempts: task.metadata.validationAttempts || 1,
            lastFailure: task.metadata.lastValidationFailure,
            note: 'Validation was attempted - use Retry button to retry'
          };
        } else {
          status.validation = {
            attempted: false,
            note: 'Validation not yet attempted'
          };
        }
        
        // Timing analysis
        const now = Date.now();
        const timeSinceCreated = now - task.createdAt;
        const timeSinceUpdated = now - task.updatedAt;
        
        status.timing = {
          ageSeconds: Math.floor(timeSinceCreated / 1000),
          ageMinutes: Math.floor(timeSinceCreated / 1000 / 60),
          ageHours: (timeSinceCreated / 1000 / 3600).toFixed(1),
          lastUpdateSeconds: Math.floor(timeSinceUpdated / 1000),
          lastUpdateMinutes: Math.floor(timeSinceUpdated / 1000 / 60),
          isStale: timeSinceUpdated > 600000, // 10 minutes
          isVeryStale: timeSinceUpdated > 3600000 // 1 hour
        };
        
        // Determine recommended action
        let recommendedAction = 'wait';
        let actionReason = 'Task in progress';
        
        if (task.state === 'DONE') {
          recommendedAction = 'none';
          actionReason = 'Task already complete';
        } else if (status.outputs?.exists && status.outputs.fileCount > 0) {
          if (status.validation.attempted) {
            recommendedAction = 'retry';
            actionReason = 'Validation attempted but task not complete - retry validation';
          } else {
            recommendedAction = 'validate_or_complete';
            actionReason = `Agent created ${status.outputs.fileCount} files - ready to validate or mark complete`;
          }
        } else if (status.timing.isVeryStale) {
          recommendedAction = 'investigate';
          actionReason = 'Task very stale (>1 hour since update) - may be stuck';
        } else if (status.timing.isStale) {
          recommendedAction = 'wait_or_check';
          actionReason = 'Task somewhat stale (>10 min) - wait a bit more or check outputs';
        }
        
        status.recommendation = {
          action: recommendedAction,
          reason: actionReason
        };
        
        res.json(status);
        
      } catch (error) {
        console.error('Failed to get task status', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // API: Retry task validation (queue-based)
    this.app.post('/api/tasks/:taskId/retry-validation', async (req, res) => {
      try {
        const { taskId } = req.params;
        
        // Write to actions queue
        const actionsQueuePath = path.join(this.logsDir, 'actions-queue.json');
        
        let actionsData = { actions: [] };
        try {
          const content = await fs.readFile(actionsQueuePath, 'utf-8');
          actionsData = JSON.parse(content);
        } catch (error) {
          // File doesn't exist yet
        }
        
        actionsData.actions = actionsData.actions || [];
        
        const newAction = {
          actionId: `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
          type: 'retry_task_validation',
          taskId,
          requestedAt: new Date().toISOString(),
          source: 'dashboard_plan_tab',
          status: 'pending',
          metadata: {
            requestedBy: 'user_dashboard'
          }
        };
        
        actionsData.actions.push(newAction);
        await fs.writeFile(actionsQueuePath, JSON.stringify(actionsData, null, 2), 'utf-8');
        
        console.log('🔄 Task validation retry queued', { actionId: newAction.actionId, taskId });
        
        return res.json({
          success: true,
          message: 'Validation retry queued. Orchestrator will reset validation flags on next cycle.',
          actionId: newAction.actionId
        });
        
      } catch (error) {
        console.error('Failed to queue validation retry', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // API: Mark plan as complete
    // This queues an action for the orchestrator to properly trigger handlePlanCompletion()
    this.app.post('/api/plan/complete', async (req, res) => {
      try {
        // Read plan directly from filesystem to get current state
        const planPath = path.join(this.defaultRunDir, 'plans', 'plan:main.json');
        
        this.logger.info('Attempting to mark plan complete', { planPath });
        
        let plan = null;
        try {
          const planContent = await fs.readFile(planPath, 'utf-8');
          plan = JSON.parse(planContent);
        } catch (error) {
          this.logger.warn('Plan file not found', { planPath, error: error.message });
          return res.status(404).json({ error: 'No active plan found', path: planPath });
        }
        
        // No gating - user can mark complete at any time, even if just started
        // Queue action for orchestrator to process (triggers proper handlePlanCompletion flow)
        const actionsQueuePath = path.join(this.defaultRunDir, 'actions-queue.json');
        
        let actionsData = { actions: [] };
        try {
          const content = await fs.readFile(actionsQueuePath, 'utf-8');
          actionsData = JSON.parse(content);
        } catch (error) {
          // Queue doesn't exist yet - will create it
        }
        
        const actionId = `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const completeAction = {
          actionId,
          type: 'complete_plan',
          planId: plan.id,
          requestedAt: new Date().toISOString(),
          source: 'dashboard_plan_tab',
          status: 'pending',
          metadata: {
            requestedBy: 'user_dashboard',
            planTitle: plan.title
          }
        };
        
        actionsData.actions = actionsData.actions || [];
        actionsData.actions.push(completeAction);
        
        await fs.writeFile(actionsQueuePath, JSON.stringify(actionsData, null, 2), 'utf-8');
        
        this.logger.info('📋 Plan completion queued for orchestrator', { 
          actionId,
          planId: plan.id, 
          title: plan.title 
        });
        
        res.json({ 
          success: true, 
          actionId,
          plan,
          note: 'Plan completion queued - orchestrator will process and trigger proper completion events'
        });
      } catch (error) {
        const errorMsg = error?.message || String(error);
        const errorStack = error?.stack || 'No stack trace';
        this.logger.error('Failed to queue plan completion', { 
          error: errorMsg,
          stack: errorStack 
        });
        res.status(500).json({ error: errorMsg });
      }
    });

    // API: Inject new plan manually
    this.app.post('/api/plan/inject', async (req, res) => {
      try {
        const { domain, context, executionMode } = req.body;
        
        if (!domain) {
          return res.status(400).json({ error: 'Domain is required' });
        }
        
        this.logger.info('📋 New plan injection requested via dashboard', { 
          domain, 
          executionMode: executionMode || 'mixed' 
        });
        
        // Use actions-queue.json mechanism for cross-process communication
        const actionsQueuePath = path.join(this.defaultRunDir, 'actions-queue.json');
        
        // Read existing queue
        let actionsData = { actions: [] };
        try {
          const content = await fs.readFile(actionsQueuePath, 'utf-8');
          actionsData = JSON.parse(content);
        } catch (error) {
          // Queue doesn't exist yet - will create it
        }
        
        // Create inject plan action
        const actionId = `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const injectAction = {
          actionId,
          type: 'inject_plan',
          domain,
          context: context || '',
          executionMode: executionMode || 'mixed',
          requestedAt: new Date().toISOString(),
          source: 'dashboard_plan_tab',
          status: 'pending',
          metadata: {
            archiveCurrentPlan: true,
            requestedBy: 'user_dashboard'
          }
        };
        
        actionsData.actions = actionsData.actions || [];
        actionsData.actions.push(injectAction);
        
        // Write queue
        await fs.writeFile(actionsQueuePath, JSON.stringify(actionsData, null, 2), 'utf-8');
        
        this.logger.info('📋 Plan injection queued', { 
          actionId, 
          domain,
          queueLength: actionsData.actions.length
        });
        
        res.json({ 
          success: true, 
          actionId,
          plan: {
            title: domain,
            executionMode: executionMode || 'mixed',
            note: 'Plan generation queued - will be processed by orchestrator in 2-4 cycles'
          }
        });
      } catch (error) {
        this.logger.error('Failed to inject plan', { error: error.message, stack: error.stack });
        res.status(500).json({ error: error.message });
      }
    });

    // API: Generate next plan from completed work
    this.app.post('/api/plan/auto-next', async (req, res) => {
      try {
        // Read current plan from filesystem
        const planPath = path.join(this.defaultRunDir, 'plans', 'plan:main.json');
        let currentPlan = null;
        try {
          const planContent = await fs.readFile(planPath, 'utf-8');
          currentPlan = JSON.parse(planContent);
        } catch (error) {
          return res.status(404).json({ error: 'No plan found to build upon' });
        }
        
        this.logger.info('🎯 Auto-next plan generation requested', { 
          currentPlan: currentPlan?.title || 'Unknown',
          status: currentPlan?.status || 'Unknown'
        });
        
        // Load state from filesystem
        const state = await this.loadState();
        
        // Gather context for next plan generation
        const memory = state.memory || { nodes: [], edges: [] };
        const goals = state.goals || { active: [], completed: [] };
        const completionTracker = state.completionTracker;
        
        // Build deep analysis context from filesystem data (with safe fallbacks)
        let memoryNodes = [];
        if (memory && memory.nodes) {
          if (Array.isArray(memory.nodes)) {
            memoryNodes = memory.nodes;
          } else if (memory.nodes.size) {
            memoryNodes = Array.from(memory.nodes.values());
          }
        }
        
        let activeGoals = [];
        if (goals) {
          if (Array.isArray(goals.active)) {
            activeGoals = goals.active;
          } else if (Array.isArray(goals.goals)) {
            activeGoals = goals.goals.filter(g => g && g.status === 'active');
          }
        }
        
        const analysisContext = {
          // Current plan info
          completedPlan: {
            title: currentPlan.title,
            status: currentPlan.status,
            completedAt: currentPlan.completedAt
          },
          
          // Completion status
          completion: completionTracker ? {
            criteria: completionTracker.criteria || [],
            completedCount: this.getCompletedCount(completionTracker.progress),
            totalCount: completionTracker.criteria?.length || 0
          } : { criteria: [], completedCount: 0, totalCount: 0 },
          
          // Memory insights
          memory: {
            nodeCount: memoryNodes.length,
            recentNodes: memoryNodes
              .filter(n => n && n.concept)
              .sort((a, b) => (b.created || 0) - (a.created || 0))
              .slice(0, 10)
              .map(n => ({ concept: (n.concept || '').substring(0, 200), tag: n.tag || 'general' }))
          },
          
          // Active goals
          goals: {
            activeCount: activeGoals.length,
            topGoals: activeGoals
              .filter(g => g && g.description)
              .sort((a, b) => (b.priority || 0) - (a.priority || 0))
              .slice(0, 5)
              .map(g => ({ description: g.description || 'N/A', priority: g.priority || 0 }))
          },
          
          // System stats
          system: {
            cycle: state.cycleCount || 0,
            agentsCompleted: state.agentExecutor?.completedAgents?.length || 0
          }
        };
        
        // Use GPT-5.2 to analyze and generate next plan
        const { getOpenAIClient } = require('../core/openai-client');
        const client = getOpenAIClient();
        
        if (!client) {
          return res.status(500).json({ error: 'OpenAI client not available. Check API key configuration.' });
        }
        
        const prompt = `You are analyzing a completed COSMO research run to determine the best next steps.

COMPLETED PLAN:
${currentPlan ? `Title: ${currentPlan.title}\nStatus: ${currentPlan.status}` : 'No formal plan (autonomous run)'}

COMPLETION STATUS:
${analysisContext.completion ? `${analysisContext.completion.completedCount}/${analysisContext.completion.totalCount} success criteria met` : 'N/A'}

MEMORY INSIGHTS (Recent discoveries):
${(analysisContext.memory.recentNodes || []).map(n => `- ${n.concept || 'N/A'} [${n.tag || 'general'}]`).join('\n') || 'No recent memory nodes'}

ACTIVE GOALS (Self-discovered):
${(analysisContext.goals.topGoals || []).map(g => `- ${g.description || 'N/A'} (priority: ${g.priority || 0})`).join('\n') || 'No active goals'}

SYSTEM STATUS:
- Cycle: ${analysisContext.system.cycle}
- Agents completed: ${analysisContext.system.agentsCompleted}
- Memory nodes: ${analysisContext.memory.nodeCount}

YOUR TASK:
Analyze what was accomplished and determine the BEST NEXT guided task that:
1. Builds on completed work (extends, deepens, or applies findings)
2. Addresses any gaps or incomplete areas
3. Pursues the most novel and high-value direction
4. Maintains coherence with the original research thread

OUTPUT FORMAT (JSON):
{
  "reasoning": "2-3 sentence analysis of what was accomplished and why this next step is optimal",
  "domain": "Concise task title (50 chars max)",
  "context": "Detailed context explaining the task, requirements, and how it builds on previous work (200-400 words)",
  "executionMode": "strict|mixed|advisory",
  "rationale": "Why this execution mode is appropriate"
}

Be specific, actionable, and maintain research continuity.`;

        const response = await client.chat.completions.create({
          model: 'gpt-5-mini',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          // NOTE: GPT-5 models don't support custom temperature, uses default (1.0)
          max_completion_tokens: 2000
        });
        
        const rawContent = response?.choices?.[0]?.message?.content;
        if (!rawContent) {
          return res.status(500).json({ error: 'Empty response from OpenAI' });
        }
        
        let nextPlanSpec;
        try {
          nextPlanSpec = JSON.parse(rawContent);
        } catch (parseError) {
          this.logger.error('Failed to parse OpenAI response', { rawContent: rawContent.substring(0, 500) });
          return res.status(500).json({ error: 'Invalid JSON response from OpenAI', details: rawContent.substring(0, 200) });
        }
        
        this.logger.info('🎯 Next plan spec generated', { 
          domain: nextPlanSpec?.domain || 'Unknown',
          reasoning: nextPlanSpec?.reasoning || 'N/A'
        });
        
        // Automatically queue inject_plan action so GuidedModePlanner generates real plan
        const actionsQueuePath = path.join(this.defaultRunDir, 'actions-queue.json');
        
        let actionsData = { actions: [] };
        try {
          const content = await fs.readFile(actionsQueuePath, 'utf-8');
          actionsData = JSON.parse(content);
        } catch (error) {
          // Queue doesn't exist yet
        }
        
        const actionId = `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const injectAction = {
          actionId,
          type: 'inject_plan',
          domain: nextPlanSpec.domain,
          context: nextPlanSpec.context,
          executionMode: nextPlanSpec.executionMode || 'mixed',
          requestedAt: new Date().toISOString(),
          source: 'dashboard_auto_next',
          status: 'pending',
          metadata: {
            archiveCurrentPlan: true,
            requestedBy: 'dashboard_auto_generate',
            reasoning: nextPlanSpec.reasoning,
            rationale: nextPlanSpec.rationale
          }
        };
        
        actionsData.actions = actionsData.actions || [];
        actionsData.actions.push(injectAction);
        
        await fs.writeFile(actionsQueuePath, JSON.stringify(actionsData, null, 2), 'utf-8');
        
        this.logger.info('📋 Plan generation queued for orchestrator', { 
          actionId,
          domain: nextPlanSpec.domain
        });
        
        res.json({
          success: true,
          actionId,
          planSpec: nextPlanSpec,
          note: 'Plan generation queued - orchestrator will use GuidedModePlanner to create full plan with phases, milestones, tasks, and acceptance criteria'
        });
        
      } catch (error) {
        const errorMsg = error?.message || String(error);
        const errorStack = error?.stack || 'No stack trace';
        this.logger.error('Failed to generate next plan', { error: errorMsg, stack: errorStack });
        res.status(500).json({ error: errorMsg });
      }
    });

    // SSE endpoint for real-time updates
    this.app.get('/events', (req, res) => {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      this.clients.add(res);

      req.on('close', () => {
        this.clients.delete(res);
      });
    });

    // API: Get current state
    this.app.get('/api/home/summary', async (req, res) => {
      try {
        const summary = await this.getHomeSummary();
        res.json(summary);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // /api/state — lightweight projection. The full state file is ~185MB
    // compressed / ~400MB uncompressed; we never want to serialize that over
    // HTTP. Callers (dashboard, chat tools, harness) need cycle count, mode,
    // memory/goal counts, and recent thought — not the full graph. Pass
    // ?full=1 to get the full state for debugging (still gated by cache).
    this.app.get('/api/state', async (req, res) => {
      try {
        const state = await this.loadState();
        const wantsFull = req.query.full === '1' || req.query.full === 'true';
        if (wantsFull) {
          return res.json(state);
        }
        // Cheap projection: counts instead of arrays, latest thought summary
        const memory = state.memory || {};
        const goals = state.goals || {};
        const projection = {
          cycleCount: state.cycleCount || 0,
          oscillatorMode: state.oscillatorMode || state.currentMode || 'focus',
          cognitiveState: state.cognitiveState || {},
          memory: {
            nodes: Array.isArray(memory.nodes) ? memory.nodes.length : 0,
            edges: Array.isArray(memory.edges) ? memory.edges.length : 0,
            clusters: Array.isArray(memory.clusters) ? memory.clusters.length : 0,
          },
          goals: {
            active: Array.isArray(goals.active) ? goals.active.length : 0,
            completed: Array.isArray(goals.completed) ? goals.completed.length : 0,
            archived: Array.isArray(goals.archived) ? goals.archived.length : 0,
          },
          temporal: state.temporal || null,
          lastUpdated: state.lastUpdated || null,
          projection: true,
        };
        res.json(projection);
      } catch (error) {
        // Fallback: derive state from thoughts if state.json doesn't exist
        const thoughts = await this.getRecentThoughts(1);
        if (thoughts.length > 0) {
          const latest = thoughts[0];
          res.json({
            cycleCount: latest.cycle || 0,
            oscillatorMode: latest.oscillatorMode,
            cognitiveState: latest.cognitiveState,
            fromThoughts: true
          });
        } else {
          res.json({ error: error.message });
        }
      }
    });

    // ── Sensor Registry API ──
    // Live snapshot of every published sensor (stock + tile-backed + plugins).
    // The registry is an in-memory module so this is a cheap read.
    this.app.get('/api/sensors', (req, res) => {
      try {
        const registry = require('../sensors/registry');
        const category = req.query.category;
        const list = registry.list(category ? { category } : {});
        res.json({
          count: list.length,
          stats: registry.stats(),
          sensors: list,
        });
      } catch (err) {
        res.json({ count: 0, sensors: [], error: err.message });
      }
    });

    // ── Pulse Remarks API (Jerry's voice tile) ──
    // The pulse-remarks engine loop writes structured entries to
    // brain/pulse-remarks.jsonl. Dashboard exposes latest + history + stats.
    const pulseFile = () => require('path').join(this.logsDir || '', 'pulse-remarks.jsonl');
    const loadPulseRemarks = (limit = 30) => {
      try {
        const fs = require('fs');
        const file = pulseFile();
        if (!fs.existsSync(file)) return [];
        const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-limit);
        const out = [];
        for (const line of lines) {
          try { out.push(JSON.parse(line)); } catch { /* skip */ }
        }
        return out.reverse(); // newest first
      } catch { return []; }
    };

    this.app.get('/api/pulse/latest', (req, res) => {
      const remarks = loadPulseRemarks(1);
      if (!remarks.length) return res.json({ remark: null });
      const latest = remarks[0];
      res.json({
        remark: {
          id: latest.id,
          ts: latest.ts,
          cycle: latest.cycle,
          text: latest.text,
          model: latest.model,
          stats: latest.brief?.stats || [],
          notable: latest.brief?.notable || [],
          sensorSummary: latest.brief?.sensorSummary || [],
        },
      });
    });

    this.app.get('/api/pulse/stats', (req, res) => {
      // Returns the latest stats cards for tile rotation between remarks.
      const remarks = loadPulseRemarks(1);
      const latest = remarks[0];
      res.json({
        cycle: latest?.cycle || null,
        ts: latest?.ts || null,
        stats: latest?.brief?.stats || [],
        sensorSummary: latest?.brief?.sensorSummary || [],
      });
    });

    this.app.get('/api/pulse/history', (req, res) => {
      const limit = Math.min(parseInt(req.query.limit || '30', 10) || 30, 200);
      const remarks = loadPulseRemarks(limit);
      res.json({
        count: remarks.length,
        remarks: remarks.map(r => ({
          id: r.id,
          ts: r.ts,
          cycle: r.cycle,
          text: r.text,
          model: r.model,
          // Include the brief structure for the detail overlay
          brief: r.brief || null,
        })),
      });
    });

    // ── Notifications API (thought-action queue) ──
    // Cognitive cycles can emit NOTIFY:<message> which appends to
    // notifications.jsonl. Dashboard shows pending count + list; acknowledging
    // sets acknowledged=true in a separate mutations file so the original
    // append-only log stays intact.
    const notifFile = () => require('path').join(this.logsDir || '', 'notifications.jsonl');
    const ackFile = () => require('path').join(this.logsDir || '', 'notifications-ack.json');
    const loadNotifs = () => {
      try {
        const fs = require('fs');
        const path = notifFile();
        if (!fs.existsSync(path)) return [];
        return fs.readFileSync(path, 'utf-8')
          .split('\n').filter(Boolean).map(l => JSON.parse(l));
      } catch { return []; }
    };
    const loadAcks = () => {
      try {
        const fs = require('fs');
        const path = ackFile();
        if (!fs.existsSync(path)) return {};
        return JSON.parse(fs.readFileSync(path, 'utf-8'));
      } catch { return {}; }
    };
    const saveAcks = (acks) => {
      const fs = require('fs');
      fs.writeFileSync(ackFile(), JSON.stringify(acks, null, 2));
    };

    this.app.get('/api/notifications', (req, res) => {
      const notifs = loadNotifs();
      const acks = loadAcks();
      const enriched = notifs.map(n => ({ ...n, acknowledged: !!acks[n.id] }));
      const pending = enriched.filter(n => !n.acknowledged);
      res.json({
        total: enriched.length,
        pending: pending.length,
        items: enriched.slice(-100).reverse(), // most recent first, cap at 100
      });
    });

    this.app.post('/api/notifications/:id/ack', (req, res) => {
      const id = req.params.id;
      const acks = loadAcks();
      acks[id] = { acknowledged_at: new Date().toISOString() };
      saveAcks(acks);
      res.json({ ok: true, id });
    });

    this.app.post('/api/notifications/ack-all', (req, res) => {
      const notifs = loadNotifs();
      const acks = loadAcks();
      const now = new Date().toISOString();
      for (const n of notifs) {
        if (!acks[n.id]) acks[n.id] = { acknowledged_at: now };
      }
      saveAcks(acks);
      res.json({ ok: true, count: Object.keys(acks).length });
    });

    // API: Get recent thoughts
    this.app.get('/api/thoughts', async (req, res) => {
      const limit = parseInt(req.query.limit) || 20;
      try {
        const thoughts = await this.getRecentThoughts(limit);
        res.json(thoughts);
      } catch (error) {
        res.json({ error: error.message, thoughts: [] });
      }
    });

    // API: Get goals
    this.app.get('/api/goals', async (req, res) => {
      try {
        const state = await this.loadState();
        res.json(state.goals || { active: [], completed: [] });
      } catch (error) {
        // Fallback: extract goals from thoughts
        const thoughts = await this.getRecentThoughts(100);
        const capturedGoals = [];
        let goalId = 1;
        
        thoughts.forEach(t => {
          if (t.goal) {
            capturedGoals.push({
              id: `goal_${goalId++}`,
              description: t.goal,
              priority: 0.5,
              progress: 0,
              source: 'thought_log'
            });
          }
        });
        
        res.json({ 
          active: capturedGoals.slice(0, 10).map(g => [g.id, g]),
          completed: [],
          fromThoughts: true
        });
      }
    });

    // API: Get trajectory forks
    this.app.get('/api/forks', async (req, res) => {
      try {
        const state = await this.loadState();
        const forks = state.forkSystem || { 
          activeForks: [], 
          completedForks: [], 
          stats: {
            activeForks: 0,
            completedForks: 0,
            totalSpawned: 0
          }
        };
        res.json(forks);
      } catch (error) {
        res.json({ 
          activeForks: [], 
          completedForks: [], 
          stats: {},
          error: error.message 
        });
      }
    });

    // API: Get topic queue
    this.app.get('/api/topics', async (req, res) => {
      try {
        const state = await this.loadState();
        const topics = state.topicQueue || { 
          pending: [], 
          active: [], 
          completed: [],
          topicsInjected: 0,
          topicsCompleted: 0
        };
        res.json(topics);
      } catch (error) {
        res.json({ 
          pending: [], 
          active: [], 
          completed: [],
          error: error.message 
        });
      }
    });

    // API: Get specialist agents
    this.app.get('/api/agents', async (req, res) => {
      try {
        const state = await this.loadState();
        const agents = state.agentExecutor || {
          activeAgents: [],
          recentActivity: [],
          stats: {
            total: 0,
            active: 0,
            completed: 0,
            failed: 0
          }
        };
        res.json(agents);
      } catch (error) {
        res.json({
          activeAgents: [],
          recentActivity: [],
          stats: { total: 0, active: 0, completed: 0, failed: 0 },
          error: error.message
        });
      }
    });

    // API: Get real-time agent results from queue (not just from state)
    this.app.get('/api/agents/results', async (req, res) => {
      try {
        const resultsPath = path.join(this.logsDir, 'coordinator', 'results_queue.jsonl');
        const results = await this.readAgentResults(resultsPath);
        res.json({
          results: results.slice(-10), // Last 10 agent results
          total: results.length
        });
      } catch (error) {
        res.json({
          results: [],
          total: 0,
          error: error.message
        });
      }
    });

    // API: Get comprehensive agent history and statistics
    this.app.get('/api/agents/history', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 50;
        const resultsPath = path.join(this.logsDir, 'coordinator', 'results_queue.jsonl');
        
        // Get all agent results
        const allResults = await this.readAgentResultsFull(resultsPath);
        
        // Get current state for active agents
        const state = await this.loadState();
        const activeAgents = state.agentExecutor?.activeAgents || [];
        
        // Categorize agents
        const completed = allResults.filter(a => a.status === 'completed');
        const failed = allResults.filter(a => a.status === 'failed');
        const timeout = allResults.filter(a => a.status === 'timeout');
        
        // Agent type statistics
        const typeStats = {};
        allResults.forEach(a => {
          const type = a.agentType || 'Unknown';
          if (!typeStats[type]) {
            typeStats[type] = { total: 0, completed: 0, failed: 0, timeout: 0 };
          }
          typeStats[type].total++;
          if (a.status === 'completed') typeStats[type].completed++;
          if (a.status === 'failed') typeStats[type].failed++;
          if (a.status === 'timeout') typeStats[type].timeout++;
        });
        
        res.json({
          active: activeAgents,
          completed: completed.slice(-limit),
          failed: failed.slice(-limit),
          timeout: timeout.slice(-limit),
          stats: {
            total: allResults.length,
            active: activeAgents.length,
            completed: completed.length,
            failed: failed.length,
            timeout: timeout.length,
            byType: typeStats
          },
          recent: allResults.slice(-limit)
        });
      } catch (error) {
        console.error('Failed to get agent history:', error);
        res.json({
          active: [],
          completed: [],
          failed: [],
          timeout: [],
          recent: [],
          stats: {},
          error: error.message
        });
      }
    });

    // API: Get detailed agent result by ID
    this.app.get('/api/agents/details/:agentId', async (req, res) => {
      try {
        // Check results queue first (completed agents)
        const resultsPath = path.join(this.logsDir, 'coordinator', 'results_queue.jsonl');
        const allResults = await this.readAgentResultsFull(resultsPath);
        let agentResult = allResults.find(r => r.agentId === req.params.agentId);
        
        // If not in results queue, check active agents in state
        if (!agentResult) {
          const state = await this.loadState();
          const activeAgent = state.agentExecutor?.activeAgents?.find(a => a.agentId === req.params.agentId);
          
          if (activeAgent) {
            // Get goal description
            const goalData = state.goals?.active?.find(([id, g]) => id === activeAgent.goal);
            const goalDescription = goalData ? goalData[1].description : 'Running...';
            
            // Return partial data for running agent
            agentResult = {
              agentId: activeAgent.agentId,
              agentType: activeAgent.type,
              mission: {
                goalId: activeAgent.goal,
                description: goalDescription
              },
              status: 'running',
              startTime: activeAgent.startTime,
              progressReports: [],
              results: [],
              note: 'Agent is currently running - results will be available when complete'
            };
          }
        }
        
        if (agentResult) {
          res.json(agentResult);
        } else {
          res.status(404).json({ error: 'Agent not found in active or completed agents' });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get memory network (includes live journals)
    this.app.get('/api/memory', async (req, res) => {
      try {
        let state = { memory: { nodes: [], edges: [] } };
        try {
          state = await this.loadState();
        } catch (stateError) {
          // Fresh run without state.json.gz yet - use empty baseline
          console.log('[/api/memory] No state file yet, using journals only');
        }
        
        const baselineNodes = state.memory?.nodes || [];
        const baselineEdges = state.memory?.edges || [];
        
        // NEW: Load and merge live journals (works even on fresh runs)
        const liveJournals = await this.loadLiveJournalsForRun(this.logsDir);
        const mergedNodes = this.mergeNodesWithJournals(baselineNodes, liveJournals);
        
        res.json({
          nodes: mergedNodes,
          edges: baselineEdges,
          _liveJournalCount: mergedNodes.filter(n => n._liveJournal).length
        });
      } catch (error) {
        res.json({ error: error.message, nodes: [], edges: [] });
      }
    });

    // Semantic search over memory nodes via embedding cosine similarity
    const handleMemorySearch = async (req, res) => {
      try {
        const { query, topK = 10, minSimilarity = 0.4, noiseFloor = 0.55, tag = null } = req.body;
        if (!query || typeof query !== 'string') {
          return res.status(400).json({ error: 'query string is required' });
        }

        // Load state
        let state = { memory: { nodes: [] } };
        try {
          state = await this.loadState();
        } catch {
          return res.json({ query, results: [], stats: { totalSearched: 0, totalMatched: 0 } });
        }

        // Get nodes (handle both array and object/map format)
        let nodes = state.memory?.nodes || [];
        if (!Array.isArray(nodes)) {
          nodes = Object.values(nodes);
        }

        // Filter to nodes with embeddings
        let searchable = nodes.filter(n => n.embedding && Array.isArray(n.embedding) && n.embedding.length > 0);
        if (tag) {
          searchable = searchable.filter(n => n.tag === tag);
        }

        if (searchable.length === 0) {
          return res.json({ query, results: [], stats: { totalSearched: 0, totalMatched: 0, note: 'No nodes with embeddings found' } });
        }

        // Embed the query using the same client/model as the engine
        const { getEmbeddingClient } = require('../core/openai-client');
        const client = getEmbeddingClient();

        const embeddingModel = process.env.EMBEDDING_MODEL || 'nomic-embed-text';
        const isOllama = (process.env.EMBEDDING_BASE_URL || '').includes('11434');

        // Truncate query for embedding (same safety limits as NetworkMemory)
        let queryText = query;
        if (queryText.length > 2000) {
          queryText = queryText.substring(0, 2000);
        }

        const createParams = { model: embeddingModel, input: queryText };
        if (!isOllama) {
          createParams.encoding_format = 'float';
        }

        const embResponse = await client.embeddings.create(createParams);
        const queryEmbedding = embResponse?.data?.[0]?.embedding;

        if (!queryEmbedding || !Array.isArray(queryEmbedding)) {
          return res.status(500).json({ error: 'Failed to generate query embedding' });
        }

        // Cosine similarity (inlined from NetworkMemory)
        function cosineSimilarity(a, b) {
          if (!a || !b || a.length !== b.length) return 0;
          let dot = 0, nA = 0, nB = 0;
          for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            nA += a[i] * a[i];
            nB += b[i] * b[i];
          }
          if (nA === 0 || nB === 0) return 0;
          return dot / (Math.sqrt(nA) * Math.sqrt(nB));
        }

        // Score ALL searchable nodes and compute population statistics
        let popSum = 0;
        const allScores = [];
        const scored = [];

        for (const node of searchable) {
          const similarity = cosineSimilarity(queryEmbedding, node.embedding);
          popSum += similarity;
          allScores.push(similarity);
          if (similarity >= minSimilarity) {
            scored.push({
              id: node.id,
              concept: node.concept,
              tag: node.tag,
              similarity: Math.round(similarity * 10000) / 10000,
              weight: node.weight,
              activation: node.activation,
              cluster: node.cluster,
              created: node.created,
              accessed: node.accessed,
              accessCount: node.accessCount,
            });
          }
        }

        scored.sort((a, b) => b.similarity - a.similarity);

        const topScore = scored.length > 0 ? scored[0].similarity : 0;
        const popMean = searchable.length > 0 ? popSum / searchable.length : 0;

        // Population standard deviation for z-score
        let popVariance = 0;
        for (const s of allScores) {
          popVariance += (s - popMean) * (s - popMean);
        }
        const popStdDev = allScores.length > 0 ? Math.sqrt(popVariance / allScores.length) : 0;

        // Z-score: how many standard deviations is the top result above the mean?
        // Real semantic matches: z > 2.5 (top result is a clear outlier)
        // Noise/generic matches: z < 2.0 (top result is within the normal distribution)
        const zScore = popStdDev > 0 ? (topScore - popMean) / popStdDev : 0;

        // Adaptive threshold: stricter for large brains (noise), lenient for small ones
        // Also accept results above absolute similarity threshold (0.45) regardless of z-score
        const minZScore = searchable.length < 50 ? 1.0 : searchable.length < 500 ? 2.0 : 3.0;
        const minAbsSimilarity = 0.45;

        const candidateResults = scored.slice(0, topK);
        const hasSignal = candidateResults.length > 0 && (zScore >= minZScore || topScore >= minAbsSimilarity);
        const results = hasSignal ? candidateResults : [];

        res.json({
          query,
          results,
          stats: {
            totalSearched: searchable.length,
            totalMatched: hasSignal ? scored.length : 0,
            topSimilarity: Math.round(topScore * 10000) / 10000,
            populationMean: Math.round(popMean * 10000) / 10000,
            populationStdDev: Math.round(popStdDev * 10000) / 10000,
            zScore: Math.round(zScore * 100) / 100,
            noiseFiltered: !hasSignal,
          }
        });
      } catch (error) {
        console.error('[/api/memory/search] Error:', error.message);
        res.status(500).json({ error: error.message });
      }
    };
    this.app.post('/api/memory/search', handleMemorySearch);
    this.app.get('/api/memory/search', (req, res) => {
      req.body = {
        query: req.query.query || req.query.search || req.query.q,
        topK: parseInt(req.query.limit || req.query.topK || '10', 10),
        minSimilarity: parseFloat(req.query.minSimilarity || '0.1'),
        tag: req.query.tag || null,
      };
      handleMemorySearch(req, res);
    });

    // ── Synthesis Agent API ──

    // GET /api/synthesis/state — serve brain-state.json
    this.app.get('/api/synthesis/state', async (req, res) => {
      try {
        const fsSync = require('fs');
        const statePath = path.join(this.logsDir, 'brain-state.json');
        if (fsSync.existsSync(statePath)) {
          const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
          res.json(state);
        } else {
          res.json({ generatedAt: null, message: 'No synthesis has run yet.' });
        }
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // POST /api/synthesis/run — trigger synthesis agent
    this.app.post('/api/synthesis/run', async (req, res) => {
      try {
        if (!this._synthesisAgent) {
          return res.status(503).json({ error: 'Synthesis agent not initialized' });
        }
        if (this._synthesisAgent.running) {
          return res.json({ started: false, message: 'Synthesis already running' });
        }
        // Fire and forget — don't await
        this._synthesisAgent.run('manual').catch(err => {
          console.error('[synthesis] Manual run failed:', err.message);
        });
        res.json({ started: true });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // NEW: Embedding statistics
    this.app.get('/api/embedding-stats', async (req, res) => {
      try {
        const state = await this.loadState();
        const nodes = state.memory?.nodes || [];
        const nodesWithEmbeddings = nodes.filter(n => n.embedding && Array.isArray(n.embedding));
        
        // Calculate statistics
        const stats = {
          totalNodes: nodes.length,
          nodesWithEmbeddings: nodesWithEmbeddings.length,
          coverage: nodes.length > 0 
            ? ((nodesWithEmbeddings.length / nodes.length) * 100).toFixed(1) + '%'
            : 'N/A',
          
          dimensionSize: nodesWithEmbeddings[0]?.embedding?.length || 0,
          
          // By tag
          byTag: {},
          
          // Age distribution
          ageDistribution: {
            recent: 0,    // < 1 hour
            hourly: 0,    // 1-24 hours  
            daily: 0,     // 1-7 days
            weekly: 0,    // > 7 days
          },
          
          // Storage estimate
          storageBytes: nodesWithEmbeddings.length * 
            (nodesWithEmbeddings[0]?.embedding?.length || 0) * 4, // 4 bytes per float32
          storageMB: (nodesWithEmbeddings.length * 
            (nodesWithEmbeddings[0]?.embedding?.length || 0) * 4 / 1024 / 1024).toFixed(2)
        };
        
        // Tag distribution
        nodes.forEach(node => {
          const tag = node.tag || 'untagged';
          if (!stats.byTag[tag]) {
            stats.byTag[tag] = { total: 0, withEmbedding: 0 };
          }
          stats.byTag[tag].total++;
          if (node.embedding) stats.byTag[tag].withEmbedding++;
        });
        
        // Age distribution
        const now = Date.now();
        nodesWithEmbeddings.forEach(node => {
          const age = (now - new Date(node.created).getTime()) / 1000 / 60 / 60; // hours
          if (age < 1) stats.ageDistribution.recent++;
          else if (age < 24) stats.ageDistribution.hourly++;
          else if (age < 168) stats.ageDistribution.daily++;
          else stats.ageDistribution.weekly++;
        });
        
        res.json(stats);
      } catch (error) {
        console.error('Error generating embedding stats:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get system stats
    this.app.get('/api/stats', async (req, res) => {
      try {
        const state = await this.loadState();
        const thoughts = await this.getRecentThoughts(50);
        
        const stats = {
          cycleCount: state.cycleCount || 0,
          timestamp: state.timestamp,
          oscillator: state.oscillator,
          subsystems: this.extractSubsystemStats(state),
          recentActivity: this.analyzeRecentActivity(thoughts),
          clusterSync: state.clusterSync || null,
          goalCount: Array.isArray(state.goals?.active) ? state.goals.active.length : 0,
          memoryNodeCount: state.memory?.nodes?.length || 0,
          memoryEdgeCount: state.memory?.edges?.length || 0,
          webSearchCount: state.gpt5Stats?.webSearchCount || 0,
          goalAllocator: state.goalAllocator || null,
          coordinator: state.coordinator || null
        };
        
        res.json(stats);
      } catch (error) {
        // Fallback: derive from thoughts
        const thoughts = await this.getRecentThoughts(50);
        const latest = thoughts[thoughts.length - 1];
        
        res.json({
          cycleCount: latest?.cycle || 0,
          timestamp: latest?.timestamp || new Date(),
          oscillator: {
            currentMode: latest?.oscillatorMode || 'focus',
            cycleCount: Math.floor((latest?.cycle || 0) / 6)
          },
          subsystems: {
            memory: { nodes: 0, edges: 0, clusters: 0 },
            goals: { active: 0, completed: 0 },
            roles: { total: 3, avgSuccess: 0.5 }
          },
          recentActivity: this.analyzeRecentActivity(thoughts),
          fromThoughts: true,
          clusterSync: null,
          goalCount: 0,
          memoryNodeCount: 0,
          memoryEdgeCount: 0,
          webSearchCount: 0,
          goalAllocator: null,
          coordinator: null
        });
      }
    });

    // API: Analyze logs for interesting insights
    this.app.get('/api/insights/analyze', async (req, res) => {
      try {
        const options = {
          limit: parseInt(req.query.limit) || 20,
          minSurprise: parseFloat(req.query.minSurprise) || 0.5,
          minActivation: parseFloat(req.query.minActivation) || 0.7,
          includeThoughts: req.query.includeThoughts !== 'false',
          includeAgents: req.query.includeAgents !== 'false',
          includeCoordinator: req.query.includeCoordinator !== 'false',
          includeMemory: req.query.includeMemory !== 'false'
        };

        console.log('Starting insight analysis with options:', options);
        const insights = await this.insightAnalyzer.analyze(options);
        
        res.json(insights);
      } catch (error) {
        console.error('Insight analysis failed:', error);
        res.status(500).json({
          error: error.message,
          stats: { totalInsights: 0 }
        });
      }
    });

    // API: Get dreams from memory and thoughts
    this.app.get('/api/dreams', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 20;
        const runName = req.query.run || 'runtime';
        const lite = req.query.lite === '1' || req.query.lite === 'true';
        
        // Load dreams for the specified run
        const dreams = await this.getDreamsForRun(runName, limit, { lite });
        res.json(dreams);
      } catch (error) {
        console.error('Failed to get dreams:', error);
        res.json({ 
          dreams: [],
          stats: { total: 0 },
          error: error.message 
        });
      }
    });

    // API: Validate insights for novelty (NEW)
    this.app.get('/api/insights/validate-novelty', async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 10;
        
        console.log('Starting novelty validation...');
        
        // First, get insights to validate
        const insights = await this.insightAnalyzer.analyze({
          limit: limit * 2, // Get more to filter down
          minSurprise: 0.6,
          includeThoughts: true,
          includeAgents: true,
          includeCoordinator: true,
          includeMemory: true
        });
        
        // Flatten insights - PRIORITIZE agent insights (they have proper metadata)
        const allInsights = [
          // Agent breakthroughs - BEST for novelty validation (have agentId, verifiable provenance)
          ...insights.agentBreakthroughs.flatMap(ab => 
            ab.insights.map(ins => ({
              id: ab.agentId,
              agentId: ab.agentId,
              content: ins.content,
              agentType: ab.agentType,
              category: 'Agent Insight',
              timestamp: ins.timestamp || ab.timestamp,
              fromAgent: true
            }))
          ),
          
          // High surprise thoughts WITHOUT web search (potentially novel)
          ...insights.highSurpriseThoughts
            .filter(t => !t.category?.includes('Web'))
            .map(t => ({ ...t, fromAgent: false })),
          
          // Strategic insights (from coordinator - high value)
          ...insights.strategicInsights.flatMap(si => 
            si.keyInsights.map(ki => ({
              id: `strategic_${si.cycle}`,
              content: ki,
              category: 'Strategic Insight',
              cycle: si.cycle,
              fromAgent: false
            }))
          ),
          
          // Deep reasoning (no web search - potentially novel)
          ...insights.reasoningTraces
            .filter(t => !t.category?.includes('Web'))
            .map(t => ({ ...t, fromAgent: false }))
        ];
        
        // Validate batch
        const validated = await this.noveltyValidator.validateBatch(
          allInsights.slice(0, limit)
        );
        
        // Rank by novelty
        const ranked = this.noveltyValidator.rankByNovelty(validated);
        
        res.json({
          validated,
          ranked,
          stats: ranked.stats,
          config: this.noveltyValidator.getConfig(),
          timestamp: new Date()
        });
        
        console.log('Novelty validation complete', ranked.stats);
      } catch (error) {
        console.error('Novelty validation failed:', error);
        res.status(500).json({
          error: error.message,
          stats: { total: 0 }
        });
      }
    });

    // API: Update novelty thresholds (NEW)
    this.app.post('/api/insights/novelty-config', express.json(), async (req, res) => {
      try {
        this.noveltyValidator.updateThresholds(req.body);
        res.json({
          success: true,
          config: this.noveltyValidator.getConfig()
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ===== QUERY INTERFACE API ENDPOINTS (NEW) =====
    
    // Page: Query Interface
    this.app.get('/query', (req, res) => {
      res.sendFile(path.join(__dirname, 'query.html'));
    });

    // API: IDE Chat - Lightweight LLM endpoint for Documentation IDE
    this.app.post('/api/ide/chat', async (req, res) => {
      try {
        const { 
          message,           // User's message/request
          documentContent,   // Current document content (for context)
          selectedText,      // Selected text (if editing selection)
          fileName,          // Current file name
          language,          // File language (markdown, json, etc.)
          fileTreeContext,   // Project file structure (for awareness)
          currentFolder,     // Current working directory (for file creation)
          model = 'gpt-5.2', // User can select model (gpt-5.2 or claude)
          conversationHistory // Previous messages (optional)
        } = req.body;
        
        if (!message) {
          return res.status(400).json({ error: 'Message is required' });
        }
        
        console.log(`[IDE CHAT] Message: "${message.substring(0, 60)}..."`);
        console.log(`[IDE CHAT] File: ${fileName || 'untitled'} (${language || 'unknown'})`);
        console.log(`[IDE CHAT] Has document context: ${!!documentContent}`);
        console.log(`[IDE CHAT] Has selection: ${!!selectedText}`);
        
        // Use COSMO's existing OpenAI client
        const { getOpenAIClient } = require('../core/openai-client');
        const openai = getOpenAIClient();
        
        // Determine if this is an edit request
        const isEditRequest = message.toLowerCase().match(/improve|fix|rewrite|change|update|edit|modify|enhance/);
        const hasSelection = !!selectedText;
        
        // Build system prompt - autonomous coding agent with "measure twice, cut once" philosophy
        // CRITICAL: Command formats (READ_FILE:, EDIT_FILE:, FILE_CREATE:) must remain unchanged - frontend parsing depends on exact format
        const systemPrompt = `You are an AI coding assistant integrated into a Documentation IDE. You are an AGENT - act autonomously, explore thoroughly, and resolve requests completely.

## Core Philosophy: Explore → Understand → Act

**NEVER assume you know a codebase. ALWAYS explore first.**

1. **Explore** - Read docs, list directories, search patterns
2. **Understand** - Process what you found
3. **Ask** - Clarify scope and intent if needed
4. **Act** - Respond or implement with full context

Thorough preparation leads to better results.

## Current Context

File: ${fileName || 'untitled'}
Language: ${language || 'text'}
Current Folder: ${currentFolder || process.cwd()}
${selectedText ? `Selection: ${selectedText.length} chars selected` : 'No selection'}
${documentContent ? `Document: ${documentContent.length} chars` : 'Empty file'}

## Project Structure (Limited - Use LIST_DIR: for more)
${fileTreeContext || 'Not available - use LIST_DIR:. to explore'}

## Your Exploration Tools (Use These First!)

### 1. READ_FILE:/path/to/file
Read any file in the project.

**When to use:**
- User asks about project architecture → Read README.md, docs/
- User asks about a specific file → Read that file
- Need to understand dependencies → Read package.json, requirements.txt, etc.

**Examples:**
\`\`\`
READ_FILE:README.md
READ_FILE:package.json
READ_FILE:docs/ARCHITECTURE.md
\`\`\`

### 2. LIST_DIR:/path/to/directory
List directory contents to understand structure.

**When to use:**
- User asks "what's in this project?" → LIST_DIR:.
- User asks about a folder → List that folder
- Need to understand organization → List key directories

**Examples:**
\`\`\`
LIST_DIR:.
LIST_DIR:src/
LIST_DIR:docs/
\`\`\`

### 3. GREP:pattern:path
Search for text patterns across the codebase.

**When to use:**
- User asks "where is X defined?" → Search for class/function name
- User asks "how is Y used?" → Search for import statements
- Need to find all occurrences → Search for pattern

**Examples:**
\`\`\`
GREP:class.*Orchestrator:src/
GREP:import React:src/
GREP:TODO:./
\`\`\`

### 4. EDIT_FILE:/path
Edit files (opens in review queue).
\`\`\`
EDIT_FILE:src/components/Button.tsx
---
[new content]
---
\`\`\`

### 5. FILE_CREATE:/path
Create files or folders.
- IMPORTANT: Use RELATIVE paths from Current Folder
- Do NOT use absolute paths like /Users/...
\`\`\`
FILE_CREATE:src/utils/helper.ts
[complete file content]
\`\`\`

## Behavioral Rules

### Rule 1: Explore Before Responding

When asked about project structure, dependencies, or "how does X work":

❌ **DON'T:** Assume or guess
✅ **DO:** Explore first

**Example:**
\`\`\`
User: "How is this project structured?"

Good Response:
READ_FILE:README.md
LIST_DIR:.
READ_FILE:package.json

Then explain what you actually found.
\`\`\`

### Rule 2: Discover Project Type

Check for common files:
\`\`\`
READ_FILE:package.json     → Node.js/TypeScript
READ_FILE:requirements.txt → Python
READ_FILE:go.mod           → Go
READ_FILE:Cargo.toml       → Rust
\`\`\`

### Rule 3: Search Before Creating

Before creating utilities or components:
\`\`\`
LIST_DIR:src/
LIST_DIR:src/utils/
READ_FILE:src/utils/index.ts  (check existing patterns)

Then create following existing conventions.
\`\`\`

### Rule 4: Show Your Work

Always mention what you explored:
\`\`\`
"I explored the project:
- README.md describes it as...
- package.json shows dependencies: ...
- src/ contains: ..."
\`\`\`

## Operating Modes

${isEditRequest && hasSelection ? `
### EDIT MODE (Selection-based)
The user selected text and wants you to improve it.

**Before editing:**
- Read surrounding context if needed
- Understand what the code does
- Plan minimal, surgical changes

**Return format:**
- Return only the improved text
- No explanations, markdown blocks, or preamble
- Preserve indentation and formatting exactly
- Be surgical - change only what needs changing
` : message.toLowerCase().includes('create') && message.toLowerCase().includes('file') ? `
### FILE CREATION MODE  
The user wants to create a new file.

**Before creating:**
1. Explore existing structure:
   LIST_DIR:src/
   LIST_DIR:${currentFolder || '.'}
2. Check existing patterns:
   READ_FILE:package.json (or similar)
3. Look for similar files to match style

**Path rules:**
- Current folder: ${currentFolder || process.cwd()}
- Use RELATIVE paths (e.g., "file.txt" or "src/utils/helper.ts")
- Do NOT use absolute paths (/Users/...) - they will fail

**Return format:**
\`\`\`
FILE_CREATE:relative/path/to/file.ext
[complete file content with all imports]
\`\`\`
` : `
### GENERAL MODE
When asked about the project:

**Step 1: Explore**
\`\`\`
READ_FILE:README.md
LIST_DIR:.
READ_FILE:package.json (or requirements.txt, go.mod, etc.)
\`\`\`

**Step 2: Understand**
Process what you found, identify project type

**Step 3: Respond**
Short, precise responses with evidence
"I checked package.json and see React 18.2.0..."

**For implementation requests:**
1. Explore existing structure first
2. Match existing conventions
3. Generate complete, runnable code
`}

## Quality Standards

**All code must:**
- Match the project's existing style (discover via exploration)
- Include necessary imports (check existing files for patterns)
- Be runnable immediately
- Handle errors gracefully
- For Python: Use compatible type hints (check Python version)
- For TypeScript: Match tsconfig.json settings

**For web applications:**
- Beautiful, modern UI with best UX practices
- Responsive design
- Accessible (ARIA labels, semantic HTML)

## Key Insight

**You have tools to explore ANY codebase. USE THEM.**

Don't rely on assumptions about how projects "usually" work.
Instead, explore THIS project to see how IT actually works.

This is what makes you a true IDE assistant, not just a chatbot.

## Style Guidelines

- **Explorer First**: Always use tools to understand before acting
- **Evidence-Based**: Show what you discovered
- **Thorough**: Read multiple files, search patterns, list directories
- **Professional**: IDE assistant demeanor
- **Autonomous**: Act decisively once you understand
- **Direct**: Results over words, but grounded in exploration

You are empowered to explore and understand. The user trusts you to discover the truth about their codebase before acting.`;

        // Build user message with context
        let userMessage = message;
        
        if (selectedText) {
          userMessage = `I've selected this text:\n\n---\n${selectedText}\n---\n\nRequest: ${message}`;
        } else if (documentContent && documentContent.length < 10000) {
          // Include full document if it's not too large
          userMessage = `Current document:\n\n---\n${documentContent}\n---\n\nRequest: ${message}`;
        }
        
        // Build messages array (include conversation history if provided)
        const messages = [
          { role: 'system', content: systemPrompt }
        ];
        
        // Add conversation history if provided
        if (conversationHistory && Array.isArray(conversationHistory)) {
          messages.push(...conversationHistory);
        }
        
        // Add current message
        messages.push({ role: 'user', content: userMessage });
        
        // Call LLM based on selected model
        let aiResponse, tokensUsed;
        
        // Check if streaming is requested
        const useStreaming = req.body.stream === true;
        
        if (useStreaming) {
          // Set up Server-Sent Events (SSE) for streaming
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          
          let fullResponse = '';
          let tokens = 0;
          
          try {
            if (model.startsWith('claude')) {
              // Anthropic Claude Streaming
              const Anthropic = require('@anthropic-ai/sdk');
              const anthropic = new Anthropic({
                apiKey: process.env.ANTHROPIC_API_KEY
              });
              
              const systemMsg = messages.find(m => m.role === 'system');
              const userMessages = messages.filter(m => m.role !== 'system');
              
              // Determine correct Claude model (December 2025)
              const claudeModel = model === 'claude-opus-4-5' 
                ? 'claude-3-opus-20240229'  // Claude 3 Opus
                : 'claude-sonnet-4-5-20250929';  // Claude Sonnet 4.5
              
              const stream = await anthropic.messages.create({
                model: claudeModel,
                max_tokens: 16000,
                temperature: 0.1,
                system: systemMsg ? systemMsg.content : undefined,
                messages: userMessages,
                stream: true
              });
              
              for await (const event of stream) {
                if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                  const chunk = event.delta.text;
                  fullResponse += chunk;
                  res.write(`data: ${JSON.stringify({ chunk, done: false })}\n\n`);
                }
                if (event.type === 'message_stop') {
                  tokens = event.message?.usage?.input_tokens + event.message?.usage?.output_tokens || 0;
                }
              }
              
            } else {
              // OpenAI GPT Streaming
              const stream = await openai.chat.completions.create({
                model: 'gpt-5.2',
                messages: messages,
                temperature: 0.1,
                max_completion_tokens: 16000,
                stream: true
              });
              
              for await (const chunk of stream) {
                const content = chunk.choices[0]?.delta?.content;
                if (content) {
                  fullResponse += content;
                  res.write(`data: ${JSON.stringify({ chunk: content, done: false })}\n\n`);
                }
                if (chunk.usage) {
                  tokens = chunk.usage.total_tokens || 0;
                }
              }
            }
            
            // Send final event
            res.write(`data: ${JSON.stringify({ chunk: '', done: true, fullResponse, tokensUsed: tokens })}\n\n`);
            res.end();
            
            console.log(`[IDE CHAT] Streamed ${fullResponse.length} chars, ${tokens} tokens`);
            
          } catch (error) {
            console.error('[IDE CHAT] Streaming error:', error);
            res.write(`data: ${JSON.stringify({ error: error.message, done: true })}\n\n`);
            res.end();
          }
          
        } else {
          // Non-streaming (original behavior)
          if (model.startsWith('claude')) {
            // Use Anthropic Claude
            const Anthropic = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic({
              apiKey: process.env.ANTHROPIC_API_KEY
            });
            
            // Extract system message
            const systemMsg = messages.find(m => m.role === 'system');
            const userMessages = messages.filter(m => m.role !== 'system');
            
            // Determine correct Claude model (December 2025)
            const claudeModel = model === 'claude-opus-4-5' 
              ? 'claude-3-opus-20240229'  // Claude 3 Opus
              : 'claude-sonnet-4-5-20250929';  // Claude Sonnet 4.5
            
            const response = await anthropic.messages.create({
              model: claudeModel,
              max_tokens: 16000,
              temperature: 0.1,
              system: systemMsg ? systemMsg.content : undefined,
              messages: userMessages
            });
            
            // Filter for text blocks only to avoid undefined values from non-text blocks
            aiResponse = response.content
              .filter(block => block.type === 'text')
              .map(block => block.text)
              .join('\n');
            tokensUsed = (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0);
            
          } else {
            // Use OpenAI GPT-5.2 (default)
            const response = await openai.chat.completions.create({
              model: 'gpt-5.2',
              messages: messages,
              temperature: 0.1,
              max_completion_tokens: 16000  // Increased from 4000
            });
            
            aiResponse = response.choices[0].message.content;
            tokensUsed = response.usage?.total_tokens || 0;
          }
          
          console.log(`[IDE CHAT] Response length: ${aiResponse.length} chars`);
          console.log(`[IDE CHAT] Tokens used: ${tokensUsed}`);
          
          res.json({
            success: true,
            response: aiResponse,
            tokensUsed: tokensUsed,
            model: model
          });
        }
        
      } catch (error) {
        console.error('[IDE CHAT] Error:', error);
        res.status(500).json({ 
          success: false,
          error: error.message 
        });
      }
    });

    // ============================================================================
    // API: IDE Grep - Search codebase (for AI exploration)
    // ============================================================================
    this.app.post('/api/ide/grep', async (req, res) => {
      try {
        const { pattern, path: searchPath, currentFolder } = req.body;
        
        if (!pattern) {
          return res.status(400).json({ error: 'Pattern is required' });
        }
        
        const { execSync } = require('child_process');
        const path = require('path');
        
        // Resolve search path
        let resolvedPath;
        if (searchPath === '.' || !searchPath) {
          resolvedPath = currentFolder || this.defaultRunDir;
        } else if (path.isAbsolute(searchPath)) {
          resolvedPath = searchPath;
        } else {
          resolvedPath = path.join(currentFolder || this.defaultRunDir, searchPath);
        }
        
        console.log(`[IDE GREP] Pattern: "${pattern}" in ${resolvedPath}`);
        
        try {
          // Use ripgrep with limits for safety
          const escapedPattern = pattern.replace(/"/g, '\\"');
          const cmd = `rg "${escapedPattern}" "${resolvedPath}" --max-count 50 --max-columns 200 --max-filesize 1M`;
          
          const output = execSync(cmd, { 
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            timeout: 10000 // 10 second timeout
          });
          
          console.log(`[IDE GREP] Found matches (${output.length} chars)`);
          res.json({ success: true, matches: output });
          
        } catch (err) {
          // rg returns exit code 1 if no matches found (not an error)
          if (err.status === 1) {
            console.log(`[IDE GREP] No matches found`);
            res.json({ success: true, matches: '' });
          } else {
            throw err;
          }
        }
      } catch (error) {
        console.error('[IDE GREP] Error:', error);
        res.status(500).json({ 
          success: false, 
          error: error.message || 'Search failed'
        });
      }
    });

    // API: Submit query
    this.app.post('/api/query', async (req, res) => {
      try {
        const {
          query,
          model,
          mode,
          exportFormat,
          runName,  // CRITICAL: Run name for scoping
          // ENHANCED: File access and action flags
          includeFiles,
          allowActions,
          // Existing enhancement options
          includeEvidenceMetrics,
          enableSynthesis,
          followUpContext,
          includeCoordinatorInsights,
          // NEW: For executive mode compression
          baseAnswer,
          baseMetadata,
          // NEW: For follow-up query context
          priorContext,
          // NEW: LLM backend override (null = use run's default, 'openai' = force OpenAI, 'local' = force local)
          backendOverride
        } = req.body;

        if (!query) {
          return res.status(400).json({ error: 'Query is required' });
        }

        // CRITICAL: Determine target run directory
        const targetRunName = runName || 'runtime';
        const targetRunDir = targetRunName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, targetRunName);

        console.log(`\n[QUERY API] ========================================`);
        console.log(`[QUERY API] Query: "${query.substring(0, 60)}..."`);
        console.log(`[QUERY API] Target Run: ${targetRunName}`);
        console.log(`[QUERY API] Directory: ${targetRunDir}`);
        console.log(`[QUERY API] Model: ${model || 'gpt-5.2'} | Mode: ${mode || 'normal'}`);
        console.log(`[QUERY API] Include Files: ${includeFiles !== false} | Allow Actions: ${allowActions || false}`);
        const effectiveBackendOverride = backendOverride || 'openai';
        console.log(`[QUERY API] Backend Override: ${effectiveBackendOverride} ${backendOverride ? '(explicit)' : '(defaulted to remote)'}`);

        // Create run-specific QueryEngine instance with config.
        // For serious query/PGS work, default to remote unless explicitly forced local.
        // backendOverride: 'openai' = force remote, 'local' = force local, null/undefined = default remote
        const runConfig = await this.loadRunConfig(targetRunDir, effectiveBackendOverride);
        const runQueryEngine = new QueryEngine(targetRunDir, process.env.OPENAI_API_KEY, runConfig);
        
        // CRITICAL: Set orchestrator reference if actions are allowed
        if (allowActions && this.orchestrator) {
          runQueryEngine.setOrchestrator(this.orchestrator);
        }
        
        const enhancements = [];
        if (includeEvidenceMetrics) enhancements.push('evidence');
        if (enableSynthesis) enhancements.push('synthesis');
        if (followUpContext) enhancements.push('follow-up');
        if (priorContext) enhancements.push('prior-context');
        if (includeCoordinatorInsights) enhancements.push('coordinator');
        if (includeFiles !== false) enhancements.push('files');
        if (allowActions) enhancements.push('ACTIONS');
        
        const enhancementStr = enhancements.length > 0 ? ` [+${enhancements.join(', ')}]` : '';
        console.log(`[QUERY API] Enhancements:${enhancementStr}`);
        if (priorContext) {
          console.log(`[QUERY API] Prior Context: "${priorContext.query?.substring(0, 50)}..."`);
        }
        console.log(`[QUERY API] ========================================\n`);
        
        // Execute enhanced query
        const result = await runQueryEngine.executeEnhancedQuery(query, {
          model: model || 'gpt-5.2',
          mode: mode || 'normal',
          exportFormat: exportFormat,
          includeFiles: includeFiles !== false, // Default true
          allowActions: allowActions || false, // Default false (safety)
          includeEvidenceMetrics: includeEvidenceMetrics || false,
          enableSynthesis: enableSynthesis || false,
          followUpContext: followUpContext || null,
          includeCoordinatorInsights: includeCoordinatorInsights !== false,
          baseAnswer: baseAnswer || null, // For executive mode compression
          baseMetadata: baseMetadata || null,
          priorContext: priorContext || null // For follow-up queries
        });
        
        // VERIFICATION: Add run name to result metadata
        result.metadata = result.metadata || {};
        result.metadata.queriedRun = targetRunName;
        result.metadata.queriedDir = targetRunDir;
        
        // If export requested, do it now
        if (exportFormat && exportFormat !== 'none') {
          try {
            const filepath = await this.queryEngine.exportResult(
              query,
              result.answer,
              exportFormat,
              result.metadata
            );
            result.metadata.exported = filepath;
          } catch (error) {
            console.error('Export failed:', error);
          }
        }
        
        // AUTOMATIC QUERY LOGGING: Save all queries to queries.jsonl
        try {
          const queryLog = {
            timestamp: new Date().toISOString(),
            runName: targetRunName,
            query,
            model: model || 'gpt-5.2',
            mode: mode || 'normal',
            answer: result.answer,
            evidence: result.evidence ? result.evidence.length : 0,
            tokenUsage: result.tokenUsage,
            filesAccessed: result.metadata?.filesAccessed,
            actionExecuted: result.actionExecuted,
            actionResult: result.actionResult,
            metadata: {
              queriedRun: result.metadata?.queriedRun,
              queriedDir: result.metadata?.queriedDir,
              evidenceQuality: result.metadata?.evidenceQuality,
              exported: result.metadata?.exported
            }
          };
          
          const queryLogPath = path.join(targetRunDir, 'queries.jsonl');
          await fs.appendFile(queryLogPath, JSON.stringify(queryLog) + '\n');
          
          console.log(`[QUERY LOG] Saved to ${queryLogPath}`);
        } catch (logError) {
          console.error('Failed to log query:', logError);
          // Don't fail the request if logging fails
        }
        
        res.json(result);
      } catch (error) {
        console.error('Query failed:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // ── POST /api/pgs — Progressive Graph Search ──
    // Four-phase coverage-optimized query: partition → route → sweep → synthesize.
    // Pulls the full memory graph, feeds it to PGSEngine (from cosmo23/pgs-engine),
    // returns synthesized findings + absences + cross-domain connections.
    this.app.post('/api/pgs', async (req, res) => {
      try {
        const {
          query,
          mode = 'full',
          maxPartitions,
          // Dual model control — sweeps can use a cheaper/faster model
          // (many parallel calls) while synthesis uses a stronger model
          // for the single cross-partition reasoning pass.
          sweepModel,
          synthesisModel,
          // Optional provider override — routes to a specific adapter
          // (minimax / anthropic / openai / openai-codex / xai / ollama-cloud).
          // Usually UnifiedClient picks the right one from the model name.
          sweepProvider,
          synthesisProvider,
          // Optional per-call max_tokens override
          sweepMaxTokens,
          synthesisMaxTokens,
        } = req.body || {};
        if (!query) return res.status(400).json({ error: 'query is required' });

        // Lazy-load PGS engine + UnifiedClient shim (avoids startup cost when PGS unused)
        let PGSEngine;
        try {
          PGSEngine = require('../../../cosmo23/pgs-engine/src/index').PGSEngine;
        } catch (err) {
          return res.status(500).json({
            error: 'PGS engine not found',
            detail: err.message,
            hint: 'cosmo23/pgs-engine/src/index.js must exist relative to engine/',
          });
        }

        // Build provider shim over UnifiedClient. Caller can pass any model
        // from any configured provider — we resolve the provider from the
        // model name via home.yaml lookup, then route directly to the
        // correct generate*() method. This bypasses getModelAssignment()
        // so PGS works with any model regardless of engine config state.
        const { UnifiedClient } = require('../core/unified-client');

        // The dashboard process doesn't have a direct config object (it only
        // receives logsDir at construction). Load the engine config fresh so
        // UnifiedClient can initialize all providers. COSMO_CONFIG_PATH points
        // to base-engine.yaml; we merge home.yaml providers/secrets underneath
        // using the same loader the engine itself uses.
        let unifiedConfig = {};
        try {
          const yaml = require('js-yaml');
          const fsSync = require('fs');
          const cfgPath = process.env.COSMO_CONFIG_PATH;
          if (cfgPath && fsSync.existsSync(cfgPath)) {
            unifiedConfig = yaml.load(fsSync.readFileSync(cfgPath, 'utf8')) || {};
          }
          // Merge home.yaml providers + secrets.yaml keys into the config so
          // UnifiedClient's provider init (which looks at config.providers.*)
          // finds credentials.
          const engineRoot = path.resolve(__dirname, '..', '..');
          const homeRoot = path.join(engineRoot, '..', 'config');
          const homePath = path.join(homeRoot, 'home.yaml');
          const secretsPath = path.join(homeRoot, 'secrets.yaml');
          if (fsSync.existsSync(homePath)) {
            const home = yaml.load(fsSync.readFileSync(homePath, 'utf8')) || {};
            unifiedConfig.providers = { ...(unifiedConfig.providers || {}), ...(home.providers || {}) };
          }
          if (fsSync.existsSync(secretsPath)) {
            const secrets = yaml.load(fsSync.readFileSync(secretsPath, 'utf8')) || {};
            const provSecrets = secrets.providers || {};
            for (const [name, sec] of Object.entries(provSecrets)) {
              unifiedConfig.providers[name] = {
                ...(unifiedConfig.providers[name] || {}),
                ...sec,
                enabled: true,
              };
            }
          }
        } catch (e) {
          console.warn('[PGS] Could not load engine config, provider routing may be limited:', e.message);
        }

        const unified = new UnifiedClient(unifiedConfig, this.logger);

        // Load provider → defaultModels map from home.yaml once
        const resolveProviderForModel = (() => {
          let cache = null;
          return (modelName) => {
            if (!modelName) return null;
            if (!cache) {
              try {
                const yaml = require('js-yaml');
                const fsSync = require('fs');
                const engineRoot = path.resolve(__dirname, '..', '..');
                const homePath = path.join(engineRoot, '..', 'config', 'home.yaml');
                const home = fsSync.existsSync(homePath)
                  ? yaml.load(fsSync.readFileSync(homePath, 'utf8'))
                  : {};
                cache = home.providers || {};
              } catch { cache = {}; }
            }
            const modelLower = modelName.toLowerCase();
            for (const [name, prov] of Object.entries(cache)) {
              const defaultModels = (prov.defaultModels || []).map(m => String(m));
              if (defaultModels.includes(modelName)) return name;
              if (defaultModels.map(m => m.toLowerCase()).includes(modelLower)) return name;
            }
            return null;
          };
        })();

        // Defaults: use engine's quantumReasoner model assignment (MiniMax-M2.7
        // in the current config) for sweeps, and the same for synthesis unless
        // the user passed a stronger model. Works out of the box.
        const cfgAssignments = this.config?.models?.modelAssignments || {};
        const defaultFast = cfgAssignments['quantumReasoner.branches']?.model
          || this.config?.models?.defaultModel
          || 'MiniMax-M2.7';
        const defaultStrong = cfgAssignments['synthesis']?.model
          || this.config?.models?.strategicModel
          || defaultFast;

        const effectiveSweepModel = sweepModel || defaultFast;
        const effectiveSynthesisModel = synthesisModel || defaultStrong;

        // Resolve provider from model name if caller didn't pin one explicitly
        const effectiveSweepProvider = sweepProvider || resolveProviderForModel(effectiveSweepModel) || 'openai';
        const effectiveSynthesisProvider = synthesisProvider || resolveProviderForModel(effectiveSynthesisModel) || 'openai';

        const buildProvider = (kind, modelName, providerName, maxTokensOverride) => ({
          async generate({ instructions, input, maxTokens, reasoningEffort }) {
            const finalMaxTokens = maxTokensOverride || maxTokens || (kind === 'synthesis' ? 8000 : 4000);
            const finalReasoning = reasoningEffort || (kind === 'synthesis' ? 'high' : 'medium');
            const callOpts = {
              component: 'pgsEngine',
              purpose: kind,
              model: modelName,
              instructions: instructions || '',
              messages: [{ role: 'user', content: input || '' }],
              max_completion_tokens: finalMaxTokens,
              reasoningEffort: finalReasoning,
            };
            // Route to the explicit provider method — bypasses getModelAssignment()
            // which returns null when config has no pgsEngine.* assignment.
            const assignment = { provider: providerName, model: modelName };
            let response;
            try {
              if (providerName === 'anthropic') {
                response = await unified.generateAnthropic(assignment, callOpts);
              } else if (providerName === 'minimax') {
                response = await unified.generateMiniMax(assignment, callOpts);
              } else if (providerName === 'xai') {
                response = await unified.generateXAI(assignment, callOpts);
              } else if (providerName === 'ollama-cloud') {
                response = await unified.generateWithChatClient(unified.ollamaCloudClient, 'ollama-cloud', assignment, callOpts);
              } else if (providerName === 'groq') {
                response = await unified.generateWithChatClient(unified.groqClient, 'groq', assignment, callOpts);
              } else if (providerName === 'huggingface') {
                response = await unified.generateWithChatClient(unified.hfClient, 'huggingface', assignment, callOpts);
              } else if (providerName === 'local') {
                response = await unified.generateLocal(assignment, callOpts);
              } else {
                // OpenAI / OpenAI-Codex / unknown → parent GPT5Client via generate()
                response = await unified.generate(callOpts);
              }
            } catch (err) {
              return { content: `[PGS ${kind} error: ${err.message}]` };
            }
            return { content: response.content || '' };
          },
        });

        const sweepProviderShim = buildProvider('sweep', effectiveSweepModel, effectiveSweepProvider, sweepMaxTokens);
        const synthesisProviderShim = buildProvider('synthesis', effectiveSynthesisModel, effectiveSynthesisProvider, synthesisMaxTokens);

        console.log(`[PGS] Models: sweep=${effectiveSweepModel} (${effectiveSweepProvider}), synthesis=${effectiveSynthesisModel} (${effectiveSynthesisProvider})`);

        // Embedding provider — uses engine's network-memory embed helper when available
        let embeddingProvider = null;
        if (this.orchestrator?.memory?.embed) {
          const memRef = this.orchestrator.memory;
          embeddingProvider = {
            embed: (text) => memRef.embed(text),
          };
        }

        // Pull the full memory graph
        const state = await this.loadState();
        const nodes = state?.memory?.nodes || [];
        const edges = state?.memory?.edges || [];
        if (nodes.length === 0) {
          return res.status(503).json({ error: 'Brain graph empty — no nodes loaded' });
        }

        const pgs = new PGSEngine({
          sweepProvider: sweepProviderShim,
          synthesisProvider: synthesisProviderShim,
          embeddingProvider,
          config: maxPartitions ? { maxSweepPartitions: Number(maxPartitions) } : {},
          onEvent: (e) => console.log(`[PGS] ${e.type}: ${JSON.stringify(e).slice(0, 200)}`),
        });

        const result = await pgs.execute(query, { nodes, edges }, { mode });

        // Extract structured fields PGSEngine may return
        const payload = {
          answer: result.answer || null,
          synthesis: result.synthesis || result.answer || null,
          partitions: result.partitions || result.metadata?.partitions || [],
          sweeps: result.sweeps || result.metadata?.sweeps || [],
          absences: result.absences || [],
          crossDomain: result.crossDomain || result.metadata?.crossDomain || [],
          metadata: {
            ...(result.metadata || {}),
            models: {
              sweep: effectiveSweepModel,
              sweepProvider: effectiveSweepProvider,
              synthesis: effectiveSynthesisModel,
              synthesisProvider: effectiveSynthesisProvider,
            },
          },
        };

        // Log the PGS query alongside other queries
        try {
          const queryLogPath = path.join(this.logsDir, 'queries.jsonl');
          await fs.appendFile(queryLogPath, JSON.stringify({
            timestamp: new Date().toISOString(),
            kind: 'pgs',
            query,
            mode,
            answerLength: (payload.answer || '').length,
            partitionCount: payload.partitions.length,
          }) + '\n');
        } catch { /* non-fatal */ }

        res.json(payload);
      } catch (error) {
        console.error('[/api/pgs] Failed:', error);
        res.status(500).json({ error: error.message, stack: error.stack?.split('\n').slice(0, 5).join('\n') });
      }
    });

    /**
     * API: Derive executive view for an existing query answer
     * IMPORTANT:
     * - Does NOT re-run the core query pipeline
     * - Only rephrases/compresses the already produced answer + metadata
     * - Logs the executive view alongside other queries for the run
     */
    this.app.post('/api/query/executive-view', async (req, res) => {
      try {
        const {
          query,
          answer,
          metadata,
          runName
        } = req.body;

        if (!answer || !query) {
          return res.status(400).json({ error: 'Both query and answer are required' });
        }

        // Determine target run directory (same logic as /api/query)
        const targetRunName = runName || 'runtime';
        const targetRunDir = targetRunName === 'runtime'
          ? this.defaultRunDir
          : path.join(this.runsDir, targetRunName);

        console.log('\n[EXEC VIEW API] ========================================');
        console.log(`[EXEC VIEW API] Query: "${query.substring(0, 60)}..."`);
        console.log(`[EXEC VIEW API] Target Run: ${targetRunName}`);
        console.log(`[EXEC VIEW API] Directory: ${targetRunDir}`);
        console.log('[EXEC VIEW API] Generating executive view from existing answer');
        console.log('[EXEC VIEW API] ========================================\n');

        // Create run-specific QueryEngine instance with config (for local LLM support)
        const runConfig = await this.loadRunConfig(targetRunDir);
        const runQueryEngine = new QueryEngine(targetRunDir, process.env.OPENAI_API_KEY, runConfig);

        // Generate executive view (does NOT touch COSMO brain state)
        const executiveView = await runQueryEngine.generateExecutiveView(
          query,
          answer,
          metadata || {}
        );

        // Log executive view to queries.jsonl as an additive entry
        try {
          const execLog = {
            timestamp: new Date().toISOString(),
            runName: targetRunName,
            kind: 'executive_view',
            base: {
              query,
              model: metadata?.model || 'gpt-5.2',
              mode: metadata?.mode || 'normal',
              timestamp: metadata?.timestamp || null
            },
            executiveView
          };

          const queryLogPath = path.join(targetRunDir, 'queries.jsonl');
          await fs.appendFile(queryLogPath, JSON.stringify(execLog) + '\n');

          console.log(`[EXEC VIEW LOG] Saved to ${queryLogPath}`);
        } catch (logError) {
          console.error('Failed to log executive view:', logError);
          // Do not fail the request if logging fails
        }

        res.json({ executiveView });
      } catch (error) {
        console.error('Executive view generation failed:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Export query result
    this.app.post('/api/query/export', async (req, res) => {
      try {
        const { query, answer, format, metadata } = req.body;
        
        if (!query || !answer || !format) {
          return res.status(400).json({ error: 'Missing required fields' });
        }
        
        const filepath = await this.queryEngine.exportResult(query, answer, format, metadata);
        
        res.json({ 
          success: true,
          filepath: filepath,
          filename: path.basename(filepath)
        });
      } catch (error) {
        console.error('Export failed:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: MCP Proxy - Forward requests to MCP HTTP server
    // This enables intelligence view to work regardless of MCP port
    this.app.post('/api/mcp', async (req, res) => {
      try {
        const http = require('http');
        const mcpUrl = `http://localhost:${this.mcpPort}/mcp`;
        
        // Forward the request to actual MCP server using http module
        const postData = JSON.stringify(req.body);
        
        const options = {
          hostname: 'localhost',
          port: this.mcpPort,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': req.headers.accept || 'application/json, text/event-stream',
            'Content-Length': Buffer.byteLength(postData)
          }
        };
        
        const mcpReq = http.request(options, (mcpRes) => {
          let data = '';
          
          // Forward response headers (especially content-type for SSE)
          res.status(mcpRes.statusCode);
          Object.keys(mcpRes.headers).forEach(key => {
            res.setHeader(key, mcpRes.headers[key]);
          });
          
          mcpRes.on('data', (chunk) => {
            data += chunk;
          });
          
          mcpRes.on('end', () => {
            try {
              // Check if it's SSE or JSON based on content-type
              const contentType = mcpRes.headers['content-type'] || '';
              if (contentType.includes('text/event-stream')) {
                // Forward SSE as-is
                res.send(data);
              } else {
                // Parse and return JSON
                const mcpData = JSON.parse(data);
                res.json(mcpData);
              }
            } catch (parseError) {
              console.error('[MCP Proxy] Failed to parse MCP response:', parseError);
              res.status(500).json({ error: 'Invalid MCP response', details: parseError.message });
            }
          });
        });
        
        mcpReq.on('error', (error) => {
          console.error('[MCP Proxy] Request failed:', error);
          res.status(500).json({ 
            error: 'MCP proxy failed', 
            details: error.message,
            mcpPort: this.mcpPort
          });
        });
        
        mcpReq.write(postData);
        mcpReq.end();
        
      } catch (error) {
        console.error('[MCP Proxy] Failed to forward request:', error);
        res.status(500).json({ 
          error: 'MCP proxy failed', 
          details: error.message,
          mcpPort: this.mcpPort
        });
      }
    });

    // API: Load query history from queries.jsonl
    this.app.get('/api/query/history', async (req, res) => {
      try {
        const { runName = 'runtime', limit = 50 } = req.query;
        const targetRunDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        const queryLogPath = path.join(targetRunDir, 'queries.jsonl');
        
        // Check if file exists
        try {
          await fs.access(queryLogPath);
        } catch (err) {
          // No queries yet for this run
          return res.json({ queries: [] });
        }
        
        // Read queries.jsonl and parse each line
        const content = await fs.readFile(queryLogPath, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        
        // Parse each line and reverse so newest first
        const queries = lines
          .map(line => {
            try {
              return JSON.parse(line);
            } catch (err) {
              console.error('Failed to parse query line:', err);
              return null;
            }
          })
          .filter(Boolean)
          .reverse() // Newest first
          .slice(0, parseInt(limit)); // Limit results
        
        res.json({ queries });
      } catch (error) {
        console.error('Failed to load query history:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get recent console logs
    this.app.get('/api/logs/recent', async (req, res) => {
      try {
        const { runName = 'runtime', lines = 100 } = req.query;
        const targetRunDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        // Read console log file (create simple logging mechanism)
        // For now, return empty array - actual logs will come from orchestrator integration
        res.json({ logs: [] });
      } catch (error) {
        console.error('Failed to get recent logs:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Stream console logs (Server-Sent Events)
    this.app.get('/api/logs/stream', (req, res) => {
      const { runName = 'runtime' } = req.query;
      
      // Set headers for SSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Add this client to the set
      this.logStreamClients.add(res);

      // Send initial connection message
      res.write(`data: ${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: `🌐 Connected to live console stream for ${runName}`,
        meta: { clients: this.logStreamClients.size }
      })}\n\n`);

      // Send heartbeat every 30 seconds to keep connection alive
      const heartbeatInterval = setInterval(() => {
        try {
          res.write(`:heartbeat\n\n`);
        } catch (error) {
          clearInterval(heartbeatInterval);
          this.logStreamClients.delete(res);
        }
      }, 30000);

      // Clean up on client disconnect
      req.on('close', () => {
        clearInterval(heartbeatInterval);
        this.logStreamClients.delete(res);
        console.log(`[Dashboard] Console stream client disconnected (${this.logStreamClients.size} remaining)`);
      });
    });

    // API: Get query suggestions
    this.app.get('/api/query/suggestions', async (req, res) => {
      try {
        const result = await this.queryEngine.getQuerySuggestions();
        res.json(result);
      } catch (error) {
        console.error('Failed to get suggestions:', error);
        res.status(500).json({ 
          error: error.message,
          suggestions: []
        });
      }
    });

    // API: Create follow-up query
    this.app.post('/api/query/followup', async (req, res) => {
      try {
        const { sessionId, query, model, mode } = req.body;
        
        if (!sessionId || !query) {
          return res.status(400).json({ error: 'sessionId and query are required' });
        }

        // Get session context
        const sessionContext = this.queryEngine.contextTracker.getSessionContext(sessionId);
        if (!sessionContext) {
          return res.status(404).json({ error: 'Session not found or expired' });
        }

        // Execute query with follow-up context
        const result = await this.queryEngine.executeQuery(query, {
          model: model || 'gpt-5.2',
          mode: mode || 'normal',
          followUpContext: {
            sessionId,
            previousQuery: sessionContext.previousQueries[sessionContext.previousQueries.length - 1],
            context: sessionContext.context
          },
          includeCoordinatorInsights: true
        });

        res.json(result);
      } catch (error) {
        console.error('Follow-up query failed:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get available models
    this.app.get('/api/query/models', (req, res) => {
      res.json({
        models: [
          { id: 'gpt-5.2', name: 'GPT-5.2', description: 'Best general-purpose model (default)' },
          { id: 'gpt-5-mini', name: 'GPT-5 Mini', description: 'Fast & economical' },
          { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', description: 'Specialized for coding' }
        ],
        modes: [
          { id: 'fast', name: 'Fast', description: 'Low reasoning (8K tokens), quick answers' },
          { id: 'normal', name: 'Normal', description: 'Medium reasoning (15K tokens), balanced (default)' },
          { id: 'deep', name: 'Deep', description: 'High reasoning (25K tokens), maximum depth' },
          { id: 'report', name: 'Report', description: 'High reasoning (32K tokens), comprehensive multi-section analysis' }
        ],
        exportFormats: [
          { id: 'markdown', name: 'Markdown', extension: '.md' },
          { id: 'html', name: 'HTML', extension: '.html' },
          { id: 'json', name: 'JSON', extension: '.json' }
        ]
      });
    });

    // API: Get run's LLM backend info (for UI indicator)
    this.app.get('/api/query/backend-info', async (req, res) => {
      try {
        const { runName } = req.query;
        const targetRunName = runName || 'runtime';
        const targetRunDir = targetRunName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, targetRunName);

        const backendInfo = await this.getRunBackendInfo(targetRunDir);

        // Also check if local LLM is available (Ollama running)
        let localAvailable = false;
        try {
          const http = require('http');
          const baseUrl = backendInfo.localConfig?.baseUrl || process.env.LOCAL_LLM_BASE_URL || 'http://localhost:11434/v1';
          const url = new URL(baseUrl);
          await new Promise((resolve, reject) => {
            const req = http.get({
              hostname: url.hostname,
              port: url.port || 11434,
              path: '/api/tags',
              timeout: 2000
            }, (res) => {
              localAvailable = res.statusCode === 200;
              resolve();
            });
            req.on('error', () => resolve());
            req.on('timeout', () => { req.destroy(); resolve(); });
          });
        } catch (e) {
          // Ollama not available
        }

        res.json({
          ...backendInfo,
          localAvailable,
          openaiAvailable: !!process.env.OPENAI_API_KEY
        });
      } catch (error) {
        console.error('Backend info failed:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // ===== END QUERY INTERFACE =====

    // ============================================================================
    // DOCUMENT COMPILER API - System Bundle Creation from Query Series
    // ============================================================================
    
    /**
     * API: Compile system bundle from selected query series
     * 
     * User flow:
     * 1. User explores topic via multiple queries (logged to queries.jsonl)
     * 2. User selects related queries in dashboard
     * 3. User declares "this is a system" with systemId
     * 4. This endpoint creates bundle and spawns DocumentCompilerAgent
     */
    this.app.post('/api/system/compile-from-queries', async (req, res) => {
      try {
        const {
          systemId,
          runName,
          description = '',
          queryTimestamps = []  // Array of ISO timestamps from queries.jsonl
        } = req.body;
        
        // Validation
        if (!systemId) {
          return res.status(400).json({ 
            success: false, 
            error: 'systemId is required' 
          });
        }
        
        if (!/^[a-zA-Z0-9_-]+$/.test(systemId)) {
          return res.status(400).json({ 
            success: false, 
            error: 'systemId must be alphanumeric (dashes/underscores allowed)' 
          });
        }
        
        if (!Array.isArray(queryTimestamps) || queryTimestamps.length === 0) {
          return res.status(400).json({ 
            success: false, 
            error: 'At least one query must be selected (queryTimestamps array)' 
          });
        }
        
        console.log(`📦 System compilation requested:`, {
          systemId,
          runName: runName || 'runtime',
          queriesSelected: queryTimestamps.length
        });
        
        // Determine run directory
        const targetRunName = runName || 'runtime';
        const runDir = targetRunName === 'runtime' 
          ? this.defaultRunDir 
          : path.join(this.runsDir, targetRunName);
        
        // Verify run directory exists
        try {
          await fs.access(runDir);
        } catch {
          return res.status(404).json({ 
            success: false, 
            error: `Run directory not found: ${targetRunName}` 
          });
        }
        
        // Load queries.jsonl from target run
        const queriesPath = path.join(runDir, 'queries.jsonl');
        let allQueries = [];
        
        try {
          const queriesContent = await fs.readFile(queriesPath, 'utf-8');
          allQueries = queriesContent.trim().split('\n')
            .filter(Boolean)
            .map(line => {
              try {
                return JSON.parse(line);
              } catch (parseErr) {
                console.warn(`Skipped malformed query line: ${parseErr.message}`);
                return null;
              }
            })
            .filter(Boolean);
        } catch (readErr) {
          return res.status(404).json({
            success: false,
            error: `No queries found for run: ${targetRunName}`
          });
        }
        
        // Filter to selected timestamps
        const selectedQueries = allQueries.filter(q => 
          queryTimestamps.includes(q.timestamp)
        );
        
        if (selectedQueries.length === 0) {
          return res.status(404).json({ 
            success: false, 
            error: 'No matching queries found for selected timestamps' 
          });
        }
        
        console.log(`Selected queries:`, {
          count: selectedQueries.length,
          queries: selectedQueries.map(q => ({
            timestamp: q.timestamp,
            query: q.query.substring(0, 60) + '...'
          }))
        });
        
        // Load SystemBundleBuilder
        const { SystemBundleBuilder } = require('../system/system-bundle-builder');
        
        // Create builder instance
        const builder = new SystemBundleBuilder(
          { logsDir: runDir },
          console
        );
        
        // Determine artifact time range from query timestamps
        const timestamps = selectedQueries.map(q => new Date(q.timestamp).getTime());
        const timeRange = {
          start: new Date(Math.min(...timestamps)),
          end: new Date(Math.max(...timestamps))
        };
        
        // Build query context for bundle (so builder can write final bundle once)
        const queryContext = {
          queries: selectedQueries.map(q => ({
            timestamp: q.timestamp,
            query: q.query,
            answer: q.answer,
            model: q.model,
            mode: q.mode,
            answerLength: q.answer.length,
            filesAccessed: q.filesAccessed
          })),
          timeRange: {
            start: timeRange.start.toISOString(),
            end: timeRange.end.toISOString()
          },
          totalAnswerLength: selectedQueries.reduce((sum, q) => sum + q.answer.length, 0)
        };
        
        // Build system bundle with explicit scope
        const { bundlePath, bundle } = await builder.build(systemId, {
          runDir: runDir,
          name: systemId,
          description: description || `System synthesized from ${selectedQueries.length} queries`,
          agentTypes: [
            'code-creation',
            'code-execution',
            'document-creation',
            'document-analysis',
            'synthesis', 
            'analysis'
          ],
          includeMemory: false,
          selectedQueries,
          notes: `Compiled from query series (${selectedQueries.length} queries):\n` +
                 selectedQueries.map(q => 
                   `- ${q.timestamp}: ${q.query.substring(0, 80)}`
                 ).join('\n'),
          queryContext
        });
        
        console.log(`✅ System bundle created:`, {
          bundlePath: path.relative(runDir, bundlePath),
          artifacts: bundle.metadata.totalArtifacts,
          queriesIncluded: selectedQueries.length
        });
        
        // Queue DocumentCompilerAgent spawn via actions queue (cross-process compatible)
        const actionsQueuePath = path.join(runDir, 'actions-queue.json');
        
        // Read existing queue
        let actionsData = { actions: [] };
        try {
          const content = await fs.readFile(actionsQueuePath, 'utf-8');
          actionsData = JSON.parse(content);
        } catch (error) {
          // File doesn't exist yet - will create it
        }
        
        // Create spawn action
        const actionId = `action_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const spawnAction = {
          actionId,
          type: 'spawn_agent',
          agentType: 'document_compiler',
          mission: JSON.stringify({
            goalId: `system_docs_${systemId}_${Date.now()}`,
            agentType: 'document_compiler',
            systemId,
            runDir,
            description: `Compile documentation suite for system: ${systemId} (from ${selectedQueries.length} queries)`,
            successCriteria: [
              'Load system bundle and source queries',
              'Load artifact contents from bundle references',
              'Generate 3 professional documents using dual-substrate strategy',
              'Write complete suite to compiled-docs directory'
            ],
            maxDuration: 600000,  // 10 minutes
            createdBy: 'query_series_compilation',
            triggerSource: 'dashboard_query_history',
            metadata: {
              systemId,
              queryCount: selectedQueries.length,
              artifactCount: bundle.metadata.totalArtifacts
            }
          }),
          priority: 0.9,  // High priority for user-requested compilation
          requestedAt: new Date().toISOString(),
          source: 'dashboard',
          status: 'pending'
        };
        
        // Add to queue
        actionsData.actions = actionsData.actions || [];
        actionsData.actions.push(spawnAction);
        
        // Write queue
        await fs.writeFile(actionsQueuePath, JSON.stringify(actionsData, null, 2), 'utf-8');
        
        console.log(`📋 DocumentCompilerAgent queued via actions queue:`, {
          actionId,
          systemId,
          outputDir: `compiled-docs/${systemId}`,
          queueLength: actionsData.actions.length
        });
        
        res.json({
          success: true,
          bundlePath: path.relative(runDir, bundlePath),
          queriesIncluded: selectedQueries.length,
          artifactsFound: bundle.metadata.totalArtifacts,
          actionId,  // Return action ID instead of agent ID
          systemId,
          outputDir: `compiled-docs/${systemId}`,
          estimatedCompletionTime: '5-10 minutes',
          message: 'Bundle created and compilation queued. The orchestrator will process it automatically.'
        });
        
      } catch (error) {
        console.error('System compilation failed:', error);
        res.status(500).json({ 
          success: false, 
          error: error.message 
        });
      }
    });
    
    // ===== END DOCUMENT COMPILER API =====
    
    /**
     * API: Compile system standalone (for historical runs or immediate compilation)
     * 
     * Unlike /api/system/compile-from-queries which queues to orchestrator,
     * this spawns the compilation as a detached child process.
     * 
     * Use cases:
     * - Historical run compilation (no active orchestrator for that run)
     * - Immediate compilation (faster - no queue delay)
     * - Batch compilation
     */
    this.app.post('/api/system/compile-standalone', async (req, res) => {
      try {
        const {
          runDir,
          systemId,
          description = '',
          queryTimestamps = []
        } = req.body;
        
        // Validation
        if (!runDir) {
          return res.status(400).json({ 
            success: false, 
            error: 'runDir is required' 
          });
        }
        
        if (!systemId) {
          return res.status(400).json({ 
            success: false, 
            error: 'systemId is required' 
          });
        }
        
        if (!/^[a-zA-Z0-9_-]+$/.test(systemId)) {
          return res.status(400).json({ 
            success: false, 
            error: 'systemId must be alphanumeric (dashes/underscores allowed)' 
          });
        }
        
        // Resolve run directory
        const resolvedRunDir = runDir === 'runtime' 
          ? this.defaultRunDir 
          : path.join(this.runsDir, runDir.replace(/^runs\//, ''));
        
        // Verify run directory exists
        try {
          await fs.access(resolvedRunDir);
        } catch {
          return res.status(404).json({ 
            success: false, 
            error: `Run directory not found: ${runDir}` 
          });
        }
        
        console.log(`🔧 Standalone compilation requested:`, {
          runDir,
          systemId,
          queryTimestamps: queryTimestamps.length
        });
        
        // Spawn standalone compiler as detached child process
        const { spawn } = require('child_process');
        
        const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'compile-system-standalone.js');
        const args = [resolvedRunDir, systemId, ...queryTimestamps];
        
        const proc = spawn('node', [scriptPath, ...args], {
          cwd: path.join(__dirname, '..', '..'),
          detached: true,
          stdio: 'ignore'  // Don't block on I/O
        });
        
        proc.unref();  // Allow parent to exit independently
        
        const outputDir = `${runDir}/compiled-docs/${systemId}`;
        
        console.log(`✅ Standalone compilation started:`, {
          pid: proc.pid,
          outputDir,
          mode: 'detached'
        });
        
        res.json({
          success: true,
          mode: 'standalone',
          systemId,
          runDir,
          outputDir,
          message: 'Compilation started in background (detached process)',
          estimatedCompletionTime: '5-10 minutes',
          note: 'Check output directory for results. No tracking in Operations tab (standalone mode).'
        });
        
      } catch (error) {
        console.error('Standalone compilation failed:', error);
        res.status(500).json({ 
          success: false, 
          error: error.message 
        });
      }
    });

    // API: AI Query Review - Generate strategic analysis for selected queries
    this.app.post('/api/query/ai-review', async (req, res) => {
      try {
        const { 
          runDir, 
          queryTimestamps = [], 
          model = 'claude-sonnet-4-5',
          reviewType = 'enterprise',
          customPrompt = null
        } = req.body;
        
        // Validation
        if (!runDir) {
          return res.status(400).json({ 
            success: false, 
            error: 'runDir is required' 
          });
        }
        
        if (queryTimestamps.length === 0) {
          return res.status(400).json({ 
            success: false, 
            error: 'At least one query timestamp required' 
          });
        }
        
        // Resolve run directory
        const resolvedRunDir = runDir === 'runtime' 
          ? this.defaultRunDir 
          : path.join(this.runsDir, runDir.replace(/^runs\//, ''));
        
        // Verify run directory exists
        try {
          await fs.access(resolvedRunDir);
        } catch {
          return res.status(404).json({ 
            success: false, 
            error: `Run directory not found: ${runDir}` 
          });
        }
        
        console.log(`🤖 AI review requested:`, {
          runDir,
          queries: queryTimestamps.length,
          model,
          reviewType
        });
        
        // Spawn AI review script as detached child process
        const { spawn } = require('child_process');
        
        const scriptPath = path.join(__dirname, '..', '..', 'scripts', 'ai-review-queries-flexible.js');
        
        // Pass configuration as JSON string
        const config = JSON.stringify({
          model,
          reviewType,
          customPrompt,
          timestamps: queryTimestamps
        });
        
        const proc = spawn('node', [
          scriptPath,
          resolvedRunDir,
          runDir, // Pass original run name for output naming
          config
        ], {
          cwd: path.join(__dirname, '..', '..'),
          env: process.env,  // Pass environment variables (API keys)
          detached: true,
          stdio: 'ignore'  // Don't block on I/O
        });
        
        proc.unref();  // Allow parent to exit independently
        
        const timeEstimate = queryTimestamps.length * 
          (model === 'claude-opus-4-5' ? 25 : model === 'claude-sonnet-4-5' ? 15 : 20);
        
        res.json({
          success: true,
          message: `AI review started for ${queryTimestamps.length} queries`,
          configuration: { model, reviewType },
          estimatedTime: `~${Math.ceil(timeEstimate / 60)} minutes`,
          outputDir: `${runDir}/ai-reviews/`,
          script: 'ai-review-queries-flexible.js'
        });
        
      } catch (error) {
        console.error('AI review endpoint error:', error);
        res.status(500).json({ 
          success: false, 
          error: error.message 
        });
      }
    });

    // API: Check AI Review Status - List completed reviews (run-specific)
    this.app.get('/api/query/ai-review-status/:runName', async (req, res) => {
      try {
        const { runName } = req.params;
        
        // Resolve run directory (run-specific, not global archive)
        const resolvedRunDir = runName === 'runtime' 
          ? this.defaultRunDir 
          : path.join(this.runsDir, runName.replace(/^runs\//, ''));
        
        const reviewsDir = path.join(resolvedRunDir, 'ai-reviews');
        
        // Check if directory exists
        const fsSync = require('fs');
        if (!fsSync.existsSync(reviewsDir)) {
          return res.json({
            success: true,
            reviews: []
          });
        }
        
        // List all review files (new format: query-{N}-{reviewType}-{model}.md)
        const files = await fs.readdir(reviewsDir);
        const reviewFiles = files.filter(f => f.startsWith('query-') && f.endsWith('.md'));
        
        // Get file stats
        const reviews = await Promise.all(reviewFiles.map(async (file) => {
          const filePath = path.join(reviewsDir, file);
          const stats = await fs.stat(filePath);
          return {
            name: file,
            path: filePath,
            size: stats.size,
            modified: stats.mtime
          };
        }));
        
        res.json({
          success: true,
          reviews: reviews.sort((a, b) => b.modified - a.modified) // Most recent first
        });
        
      } catch (error) {
        console.error('AI review status error:', error);
        res.status(500).json({
          success: false,
          error: error.message
        });
      }
    });

    // API: Open File - Open file in system default app
    this.app.post('/api/open-file', async (req, res) => {
      try {
        const { filePath } = req.body;
        
        if (!filePath) {
          return res.status(400).json({ error: 'filePath required' });
        }
        
        // Security: Only allow opening files in workspace
        const resolvedPath = path.resolve(filePath);
        const workspaceRoot = path.resolve(path.join(__dirname, '..', '..'));
        
        if (!resolvedPath.startsWith(workspaceRoot)) {
          return res.status(403).json({ error: 'Access denied: file outside workspace' });
        }
        
        // Open file using system default app
        const { exec } = require('child_process');
        const command = process.platform === 'darwin' ? 'open' : 
                       process.platform === 'win32' ? 'start' : 'xdg-open';
        
        exec(`${command} "${resolvedPath}"`, (error) => {
          if (error) {
            console.error('Failed to open file:', error);
          }
        });
        
        res.json({ success: true });
        
      } catch (error) {
        res.status(500).json({ 
          success: false, 
          error: error.message 
        });
      }
    });

    // API: Read File - Read file content for inline viewing
    this.app.post('/api/read-file', async (req, res) => {
      try {
        const { filePath } = req.body;
        
        if (!filePath) {
          return res.status(400).json({ error: 'filePath required' });
        }
        
        // Security: Only allow reading files in workspace
        const resolvedPath = path.resolve(filePath);
        const workspaceRoot = path.resolve(path.join(__dirname, '..', '..'));
        
        if (!resolvedPath.startsWith(workspaceRoot)) {
          return res.status(403).json({ error: 'Access denied: file outside workspace' });
        }
        
        // Read file
        const fsSync = require('fs');
        if (!fsSync.existsSync(resolvedPath)) {
          return res.status(404).json({ error: 'File not found' });
        }
        
        const content = fsSync.readFileSync(resolvedPath, 'utf-8');
        
        res.json({ 
          success: true,
          content: content,
          path: resolvedPath
        });
        
      } catch (error) {
        res.status(500).json({ 
          success: false, 
          error: error.message 
        });
      }
    });

    // API: Open Folder - Open folder in Finder/Explorer
    this.app.post('/api/open-folder', async (req, res) => {
      try {
        const { folderPath } = req.body;
        
        if (!folderPath) {
          return res.status(400).json({ error: 'folderPath required' });
        }
        
        // Resolve relative to workspace
        const workspaceRoot = path.join(__dirname, '..', '..');
        const resolvedPath = path.resolve(workspaceRoot, folderPath);
        
        // Security: Only allow opening folders in workspace
        if (!resolvedPath.startsWith(path.resolve(workspaceRoot))) {
          return res.status(403).json({ error: 'Access denied: folder outside workspace' });
        }
        
        // Check if folder exists
        const fsSync = require('fs');
        if (!fsSync.existsSync(resolvedPath)) {
          return res.status(404).json({ error: 'Folder not found' });
        }
        
        // Open folder using system command
        const { exec } = require('child_process');
        const command = process.platform === 'darwin' ? 'open' : 
                       process.platform === 'win32' ? 'explorer' : 'xdg-open';
        
        exec(`${command} "${resolvedPath}"`, (error) => {
          if (error) {
            console.error('Failed to open folder:', error);
          }
        });
        
        console.log(`📁 Opening folder: ${resolvedPath}`);
        res.json({ success: true });
        
      } catch (error) {
        res.status(500).json({ 
          success: false, 
          error: error.message 
        });
      }
    });
    
    // ===== END STANDALONE COMPILER API =====
    
    /**
     * API: Check compilation progress
     * Returns progress from .compilation-progress.json file
     */
    this.app.get('/api/system/compilation-progress/:runName/:systemId', async (req, res) => {
      try {
        const { runName, systemId } = req.params;
        
        const runDir = runName === 'runtime' 
          ? this.defaultRunDir 
          : path.join(this.runsDir, runName);
        
        const progressFile = path.join(runDir, 'compiled-docs', systemId, '.compilation-progress.json');
        
        try {
          const content = await fs.readFile(progressFile, 'utf-8');
          const progress = JSON.parse(content);
          res.json({ success: true, progress });
        } catch (error) {
          if (error.code === 'ENOENT') {
            res.json({ success: false, message: 'Compilation not started or progress file not found' });
          } else {
            throw error;
          }
        }
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // ============================================================================
    // FOLDER BROWSER API - General Filesystem Access for IDE
    // ============================================================================
    
    /**
     * API: Browse folder - returns file/folder tree
     */
    this.app.get('/api/folder/browse', async (req, res) => {
      try {
        const { path: folderPath, recursive } = req.query;
        
        if (!folderPath) {
          return res.status(400).json({ success: false, error: 'path required' });
        }
        
        const stats = await fs.stat(folderPath);
        if (!stats.isDirectory()) {
          return res.status(400).json({ success: false, error: 'Not a directory' });
        }
        
        if (recursive === 'true') {
          // V2 IDE mode: Return FLAT list of all files recursively
          const flattenDirectory = async (dirPath, depth = 0, maxDepth = 10) => {
            if (depth > maxDepth) return [];
            
            try {
              const entries = await fs.readdir(dirPath, { withFileTypes: true });
              const items = [];
              
              for (const entry of entries) {
                // Skip hidden files and node_modules
                if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
                
                const fullPath = path.join(dirPath, entry.name);
                
                items.push({
                  name: entry.name,
                  path: fullPath,
                  isDirectory: entry.isDirectory(),
                  type: entry.isDirectory() ? 'directory' :
                        entry.name.endsWith('.md') ? 'markdown' : 
                        entry.name.endsWith('.json') ? 'json' : 'text'
                });
                
                // Recursively process subdirectories
                if (entry.isDirectory()) {
                  try {
                    const children = await flattenDirectory(fullPath, depth + 1, maxDepth);
                    items.push(...children);
                  } catch (err) {
                    // Permission denied or other error - skip this folder
                  }
                }
              }
              
              return items;
            } catch (error) {
              return [];
            }
          };
          
          const files = await flattenDirectory(folderPath);
          res.json({ success: true, files });
        } else {
          // Old IDE mode: Return NESTED tree structure with children
          const readDirTree = async (dirPath) => {
            try {
              const entries = await fs.readdir(dirPath, { withFileTypes: true });
              const items = [];
              
              for (const entry of entries) {
                // Skip hidden files
                if (entry.name.startsWith('.')) continue;
                
                const fullPath = path.join(dirPath, entry.name);
                
                if (entry.isDirectory()) {
                  items.push({
                    name: entry.name,
                    path: fullPath,
                    isDirectory: true,
                    type: 'directory'
                  });
                } else {
                  items.push({
                    name: entry.name,
                    path: fullPath,
                    isDirectory: false,
                    type: entry.name.endsWith('.md') ? 'markdown' : 
                          entry.name.endsWith('.json') ? 'json' : 'text'
                  });
                }
              }
              
              // Sort: directories first, then alphabetically
              return items.sort((a, b) => {
                if (a.type === 'directory' && b.type !== 'directory') return -1;
                if (a.type !== 'directory' && b.type === 'directory') return 1;
                return a.name.localeCompare(b.name);
              });
            } catch (error) {
              return [];
            }
          };
          
          const files = await readDirTree(folderPath);
          res.json({ success: true, files });
        }
        
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    /**
     * API: Read file from filesystem
     */
    this.app.get('/api/folder/read', async (req, res) => {
      try {
        const { path: filePath } = req.query;
        
        if (!filePath) {
          return res.status(400).json({ success: false, error: 'path required' });
        }
        
        const content = await fs.readFile(filePath, 'utf-8');
        const stats = await fs.stat(filePath);
        
        res.json({ success: true, content, size: stats.size });
        
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    /**
     * API: Write file to filesystem
     */
    this.app.put('/api/folder/write', async (req, res) => {
      try {
        const { path: filePath, content } = req.body;
        
        if (!filePath || !this.isFilesystemPathSafe(filePath)) {
          return res.status(403).json({ success: false, error: 'Access denied' });
        }
        
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        
        res.json({ success: true });
        
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    /**
     * API: Create new file (AI can trigger this)
     */
    this.app.post('/api/folder/create', async (req, res) => {
      try {
        const { path: filePath, content = '' } = req.body;
        
        if (!filePath || !this.isFilesystemPathSafe(filePath)) {
          return res.status(403).json({ success: false, error: 'Access denied' });
        }
        
        const fsSync = require('fs');
        if (fsSync.existsSync(filePath)) {
          return res.status(400).json({ success: false, error: 'File already exists' });
        }
        
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        
        res.json({ success: true, path: filePath });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    /**
     * API: Reveal file in Finder/Explorer
     * Opens the native file browser to show the file
     */
    this.app.post('/api/reveal-in-finder', async (req, res) => {
      try {
        const { path: filePath } = req.body;
        
        if (!filePath || !this.isFilesystemPathSafe(filePath)) {
          return res.status(403).json({ success: false, error: 'Access denied' });
        }
        
        const { exec } = require('child_process');
        const platform = process.platform;
        
        let command;
        if (platform === 'darwin') {
          // macOS - open in Finder
          command = `open -R "${filePath}"`;
        } else if (platform === 'win32') {
          // Windows - open in Explorer
          command = `explorer /select,"${filePath}"`;
        } else {
          // Linux - open containing folder
          const dir = path.dirname(filePath);
          command = `xdg-open "${dir}"`;
        }
        
        exec(command, (error) => {
          if (error) {
            console.error('Failed to reveal file:', error);
            return res.status(500).json({ success: false, error: error.message });
          }
          res.json({ success: true });
        });
        
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    /**
     * API: Serve file for browser viewing
     * Returns file content with appropriate MIME type
     */
    this.app.get('/api/serve-file', async (req, res) => {
      try {
        const filePath = req.query.path;
        
        if (!filePath || !this.isFilesystemPathSafe(filePath)) {
          return res.status(403).send('Access denied');
        }
        
        // Check if file exists
        try {
          await fs.access(filePath);
        } catch {
          return res.status(404).send('File not found');
        }
        
        // Determine content type
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html',
          '.htm': 'text/html',
          '.css': 'text/css',
          '.js': 'application/javascript',
          '.json': 'application/json',
          '.md': 'text/markdown',
          '.txt': 'text/plain',
          '.csv': 'text/csv',
          '.xml': 'application/xml',
          '.pdf': 'application/pdf',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml'
        };
        
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        
        // Read and serve file
        const content = await fs.readFile(filePath);
        res.setHeader('Content-Type', contentType);
        res.send(content);
        
      } catch (error) {
        res.status(500).send(error.message);
      }
    });

    // ============================================================================
    // MONACO IDE API - Compiled Documentation Editing
    // ============================================================================
    
    /**
     * API: List compiled documentation files
     * Returns file tree for a compiled system
     */
    this.app.get('/api/compiled-docs/:runName/:systemId/files', async (req, res) => {
      try {
        const { runName, systemId } = req.params;
        
        const runDir = runName === 'runtime' 
          ? this.defaultRunDir 
          : path.join(this.runsDir, runName);
        
        const docsDir = path.join(runDir, 'compiled-docs', systemId);
        
        // Verify directory exists
        try {
          await fs.access(docsDir);
        } catch {
          return res.status(404).json({ 
            success: false, 
            error: 'Compiled docs not found for this system' 
          });
        }
        
        // Recursively read directory tree
        const readDirTree = async (dirPath, relativePath = '') => {
          const entries = await fs.readdir(dirPath, { withFileTypes: true });
          const items = [];
          
          for (const entry of entries) {
            // Skip hidden files and compilation progress
            if (entry.name.startsWith('.')) continue;
            
            const itemPath = path.join(dirPath, entry.name);
            const itemRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
            
            if (entry.isDirectory()) {
              // Recursively read subdirectory
              const children = await readDirTree(itemPath, itemRelativePath);
              items.push({
            name: entry.name,
                path: itemRelativePath,
                type: 'directory',
                children: children
              });
            } else {
              // Add file
              items.push({
                name: entry.name,
                path: itemRelativePath,
            type: entry.name.endsWith('.md') ? 'markdown' : 
                  entry.name.endsWith('.json') ? 'json' : 'text'
              });
            }
          }
          
          // Sort: directories first, then files, both alphabetically
          return items.sort((a, b) => {
            if (a.type === 'directory' && b.type !== 'directory') return -1;
            if (a.type !== 'directory' && b.type === 'directory') return 1;
            return a.name.localeCompare(b.name);
          });
        };
        
        const tree = await readDirTree(docsDir);
        
        res.json({ success: true, files: tree });
        
      } catch (error) {
        console.error('Failed to list compiled docs:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    /**
     * API: Get compiled documentation file content
     * Returns file content for Monaco editor
     * Note: filepath parameter should be URL-encoded (slashes become %2F)
     */
    this.app.get('/api/compiled-docs/:runName/:systemId/file/:filepath', async (req, res) => {
      try {
        const { runName, systemId, filepath } = req.params;
        const filename = filepath;
        
        if (!filename) {
          return res.status(400).json({ 
            success: false, 
            error: 'Filename is required' 
          });
        }
        
        // Decode filename (may contain URL-encoded slashes)
        const decodedFilename = decodeURIComponent(filename);
        
        // Security: Validate path (no traversal with ..)
        if (decodedFilename.includes('..')) {
          return res.status(400).json({ 
            success: false, 
            error: 'Invalid file path: path traversal not allowed' 
          });
        }
        
        const runDir = runName === 'runtime' 
          ? this.defaultRunDir 
          : path.join(this.runsDir, runName);
        
        const baseDir = path.join(runDir, 'compiled-docs', systemId);
        const filePath = path.join(baseDir, decodedFilename);
          
          // Security: Verify resolved path is within compiled-docs
          const resolvedPath = path.resolve(filePath);
        const resolvedBaseDir = path.resolve(baseDir);
          
        if (!resolvedPath.startsWith(resolvedBaseDir)) {
            return res.status(403).json({ 
              success: false, 
            error: 'Access denied: file outside of system directory' 
            });
          }
        
        // Verify file exists
        try {
          await fs.access(filePath);
        } catch {
          return res.status(404).json({ 
            success: false, 
            error: `File not found: ${decodedFilename}` 
          });
        }
        
        // Read file content
        const content = await fs.readFile(filePath, 'utf-8');
        const stat = await fs.stat(filePath);
        
        res.json({ 
          success: true, 
          content,
          filename: decodedFilename,
          size: stat.size,
          modified: stat.mtime.toISOString()
        });
        
      } catch (error) {
        console.error('Failed to get file:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    /**
     * API: Save compiled documentation file
     * Allows editing compiled docs via Monaco
     * Note: filepath parameter should be URL-encoded (slashes become %2F)
     */
    this.app.put('/api/compiled-docs/:runName/:systemId/file/:filepath', async (req, res) => {
      try {
        const { runName, systemId, filepath } = req.params;
        const filename = filepath;
        const { content } = req.body;
        
        if (!filename) {
          return res.status(400).json({ 
            success: false, 
            error: 'Filename is required' 
          });
        }
        
        if (!content && content !== '') {
          return res.status(400).json({ 
            success: false, 
            error: 'Content is required' 
          });
        }
        
        // Decode filename (may contain URL-encoded slashes)
        const decodedFilename = decodeURIComponent(filename);
        
        // Security: Validate path (no traversal with ..)
        if (decodedFilename.includes('..')) {
          return res.status(400).json({ 
            success: false, 
            error: 'Invalid file path: path traversal not allowed' 
          });
        }
        
        const runDir = runName === 'runtime' 
          ? this.defaultRunDir 
          : path.join(this.runsDir, runName);
        
        const baseDir = path.join(runDir, 'compiled-docs', systemId);
        const filePath = path.join(baseDir, decodedFilename);
        
        // Security: Verify resolved path is within compiled-docs
        const resolvedPath = path.resolve(filePath);
        const resolvedBaseDir = path.resolve(baseDir);
        
        if (!resolvedPath.startsWith(resolvedBaseDir)) {
          return res.status(403).json({ 
            success: false, 
            error: 'Access denied: file outside of system directory' 
          });
        }
        
        // Write file
        await fs.writeFile(filePath, content, 'utf-8');
        
        console.log(`📝 Saved compiled doc: ${runName}/compiled-docs/${systemId}/${decodedFilename}`);
        
        res.json({ 
          success: true,
          message: 'File saved successfully',
          filename: decodedFilename
        });
        
      } catch (error) {
        console.error('Failed to save file:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });
    
    // ===== END MONACO IDE API =====
    
    /**
     * API: List all compiled systems across all runs
     * Scans runtime/ and runs/* for compiled-docs directories
     */
    this.app.get('/api/compiled-docs/all', async (req, res) => {
      try {
        const systems = [];
        
        // Helper to scan a run directory
        const scanRun = async (runPath, runName) => {
          const compiledDocsDir = path.join(runPath, 'compiled-docs');
          
          try {
            await fs.access(compiledDocsDir);
            
            const systemDirs = await fs.readdir(compiledDocsDir, { withFileTypes: true });
            
            for (const entry of systemDirs) {
              if (entry.isDirectory()) {
                const systemId = entry.name;
                const systemPath = path.join(compiledDocsDir, systemId);
                
                // Check for INDEX.md or COMPILATION_MANIFEST.json
                const hasIndex = await fs.access(path.join(systemPath, 'INDEX.md')).then(() => true).catch(() => false);
                const hasManifest = await fs.access(path.join(systemPath, 'COMPILATION_MANIFEST.json')).then(() => true).catch(() => false);
                
                if (hasIndex || hasManifest) {
                  // Count files
                  const files = await fs.readdir(systemPath);
                  const mdFiles = files.filter(f => f.endsWith('.md')).length;
                  
                  // Get manifest if exists
                  let compiledAt = null;
                  let queryCount = null;
                  
                  if (hasManifest) {
                    try {
                      const manifestContent = await fs.readFile(
                        path.join(systemPath, 'COMPILATION_MANIFEST.json'),
                        'utf-8'
                      );
                      const manifest = JSON.parse(manifestContent);
                      compiledAt = manifest.compiledAt;
                      queryCount = manifest.sources?.queries?.count || null;
                    } catch {}
                  }
                  
                  systems.push({
                    runName,
                    systemId,
                    path: `${runName}/compiled-docs/${systemId}`,
                    fileCount: files.length,
                    mdFiles,
                    compiledAt,
                    queryCount,
                    ideUrl: `/docs-ide?run=${runName}&system=${systemId}`
                  });
                }
              }
            }
          } catch {
            // No compiled-docs in this run
          }
        };
        
        // Scan runtime/
        await scanRun(this.defaultRunDir, 'runtime');
        
        // Scan all runs/
        try {
          const runs = await fs.readdir(this.runsDir, { withFileTypes: true });
          
          for (const run of runs) {
            if (run.isDirectory()) {
              await scanRun(path.join(this.runsDir, run.name), run.name);
            }
          }
        } catch {
          // No runs directory
        }
        
        // Sort by compilation date (newest first)
        systems.sort((a, b) => {
          if (!a.compiledAt) return 1;
          if (!b.compiledAt) return -1;
          return new Date(b.compiledAt) - new Date(a.compiledAt);
        });
        
        res.json({ success: true, systems, count: systems.length });
        
      } catch (error) {
        console.error('Failed to list compiled systems:', error);
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Page: Novelty Explorer (NEW)
    this.app.get('/novelty', (req, res) => {
      res.sendFile(path.join(__dirname, 'novelty-explorer.html'));
    });

    // API: Get agent network data with full provenance
    this.app.get('/api/agent-network', async (req, res) => {
      try {
        const resultsPath = path.join(this.logsDir, 'coordinator', 'results_queue.jsonl');
        const allResults = await this.readAgentResultsFull(resultsPath);
        const state = await this.loadState();
        
        // Build agents with provenance data
        // Note: missions in results_queue.jsonl don't have missionId field yet
        // Use goal-based mission IDs for now
        const agents = allResults.map(result => {
          const goalId = result.mission?.goalId || 'unknown_goal';
          const missionId = `mission_${goalId}`;
          
          return {
            id: result.agentId,
            type: result.agentType,
            status: result.status || 'completed',
            goalId: goalId,
            missionId: missionId,
            spawnedBy: result.mission?.createdBy || 'meta_coordinator',
            parentAgentId: null, // Not captured in current results yet
            parentMissionId: null, // Not captured in current results yet
            spawningReason: 'goal_execution',
            provenanceChain: [],
            spawnTimestamp: result.startTime || new Date().toISOString(),
            triggerSource: 'orchestrator',
            results: result.results?.map(r => r.type) || [],
            executionTime: result.duration,
            description: result.mission?.description || 'No description'
          };
        });

        // Add active agents
        const activeAgents = (state.agentExecutor?.activeAgents || []).map(agent => {
          const goalId = agent.goal || 'unknown_goal';
          return {
            id: agent.agentId,
            type: agent.type,
            status: 'active',
            goalId: goalId,
            missionId: `mission_${goalId}`,
            spawnedBy: 'meta_coordinator',
            parentAgentId: null,
            parentMissionId: null,
            spawningReason: 'goal_execution',
            provenanceChain: [],
            spawnTimestamp: agent.startTime,
            triggerSource: 'orchestrator',
            results: [],
            executionTime: Date.now() - new Date(agent.startTime).getTime(),
            description: 'Running...'
          };
        });

        // Build missions - collect all unique mission IDs from agents + goals
        const allGoals = [
          ...(Array.isArray(state.goals?.active) ? state.goals.active : []),
          ...(state.goals?.completed || [])
        ];

        const missionsMap = new Map();

        // Add missions from agent results - group by goal
        allResults.forEach(result => {
          const goalId = result.mission?.goalId || 'unknown_goal';
          const missionId = `mission_${goalId}`;
          
          if (!missionsMap.has(missionId)) {
            missionsMap.set(missionId, {
              id: missionId,
              goalId: goalId,
              description: result.mission?.description || 'Unknown mission',
              priority: 1,
              createdBy: result.mission?.createdBy || 'meta_coordinator',
              spawnCycle: result.mission?.spawnCycle || 0,
              createdAt: result.startTime || new Date().toISOString(),
              agentType: result.agentType
            });
          }
        });

        // Add missions for active agents - also group by goal
        activeAgents.forEach(agent => {
          const missionId = `mission_${agent.goalId}`;
          if (!missionsMap.has(missionId)) {
            missionsMap.set(missionId, {
              id: missionId,
              goalId: agent.goalId,
              description: agent.description,
              priority: 1,
              createdBy: 'meta_coordinator',
              spawnCycle: 0,
              createdAt: agent.spawnTimestamp,
              agentType: agent.type
            });
          }
        });

        const missions = Array.from(missionsMap.values());

        // Build goals
        const goals = allGoals.map(goalEntry => {
          const goal = Array.isArray(goalEntry) ? goalEntry[1] : goalEntry;
          const goalId = Array.isArray(goalEntry) ? goalEntry[0] : goal.id;
          return {
            id: goalId,
            description: goal.description,
            priority: goal.priority,
            createdAt: goal.created || new Date().toISOString(),
            status: goal.completedAt ? 'completed' : 'active'
          };
        });

        res.json({
          agents: [...agents, ...activeAgents],
          missions,
          goals
        });
      } catch (error) {
        console.error('Failed to build agent network:', error);
        res.status(500).json({ 
          error: error.message,
          agents: [],
          missions: [],
          goals: []
        });
      }
    });

    // API: Get provenance trails
    this.app.get('/api/provenance', async (req, res) => {
      try {
        const resultsPath = path.join(this.logsDir, 'coordinator', 'results_queue.jsonl');
        const allResults = await this.readAgentResultsFull(resultsPath);
        const state = await this.loadState();

        // Build trails by grouping agents by their provenance chains
        const trailsMap = new Map();

        allResults.forEach(result => {
          const goalId = result.mission?.goalId || 'unknown_goal';
          
          if (!trailsMap.has(goalId)) {
            trailsMap.set(goalId, {
              id: `trail_${goalId}`,
              name: result.mission?.description || 'Unknown Trail',
              description: `Work trail for ${result.mission?.description || 'goal'}`,
              startTime: result.startTime,
              endTime: result.endTime,
              status: result.status,
              nodes: []
            });
          }

          const trail = trailsMap.get(goalId);
          
          // Update trail end time
          if (result.endTime && (!trail.endTime || new Date(result.endTime) > new Date(trail.endTime))) {
            trail.endTime = result.endTime;
          }

          // Add goal node if not exists
          if (!trail.nodes.some(n => n.type === 'goal' && n.id === goalId)) {
            trail.nodes.push({
              id: goalId,
              type: 'goal',
              description: result.mission?.description || 'Unknown goal',
              timestamp: trail.startTime,
              status: result.status === 'completed' ? 'completed' : 'active',
              priority: 1
            });
          }

          // Add mission node
          const missionId = result.mission?.missionId || `mission_${result.agentId}`;
          if (!trail.nodes.some(n => n.id === missionId)) {
            trail.nodes.push({
              id: missionId,
              type: 'mission',
              description: result.mission?.description || 'Execute task',
              timestamp: result.startTime,
              status: result.status,
              goalId: goalId,
              agentType: result.agentType,
              priority: 1,
              parentMissionId: result.parentMissionId,
              spawningReason: result.spawningReason
            });
          }

          // Add agent node
          trail.nodes.push({
            id: result.agentId,
            type: 'agent',
            description: result.mission?.description || `${result.agentType} execution`,
            timestamp: result.startTime,
            status: result.status,
            missionId: missionId,
            goalId: goalId,
            parentAgentId: result.parentAgentId,
            executionTime: result.duration,
            results: result.results?.map(r => `result_${result.agentId}_${r.type}`) || []
          });

          // Add result nodes
          if (result.results && result.results.length > 0) {
            result.results.forEach((resultItem, idx) => {
              trail.nodes.push({
                id: `result_${result.agentId}_${idx}`,
                type: 'result',
                description: resultItem.content?.substring(0, 100) || `${resultItem.type} result`,
                timestamp: resultItem.timestamp || result.endTime,
                agentId: result.agentId,
                content: resultItem.content,
                impact: 'medium' // Could be calculated based on activation, etc.
              });
            });
          }
        });

        // Convert to array and sort by start time
        const trails = Array.from(trailsMap.values())
          .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

        res.json({ trails });
      } catch (error) {
        console.error('Failed to build provenance trails:', error);
        res.status(500).json({ 
          error: error.message,
          trails: []
        });
      }
    });
  }

  async loadState() {
    // state.json.gz is ~180MB compressed on a big brain — decompressing +
    // parsing it on every request blocks the event loop for 1-3 seconds.
    // Cache the parsed state in memory with a short TTL and invalidate when
    // the file mtime changes (engine writes it every cycle).
    const statePath = path.join(this.logsDir, 'state.json');
    try {
      const gzPath = statePath + '.gz';
      let mtime = 0;
      try {
        const fsSync = require('fs');
        const target = fsSync.existsSync(gzPath) ? gzPath : statePath;
        if (fsSync.existsSync(target)) {
          mtime = fsSync.statSync(target).mtimeMs;
        }
      } catch { /* file may not exist yet */ }

      const now = Date.now();
      const cache = this._stateCache;
      if (cache && cache.mtime === mtime && (now - cache.loadedAt) < 30000) {
        return cache.data;
      }

      const data = await StateCompression.loadCompressed(statePath);
      this._stateCache = { data, mtime, loadedAt: now };
      return data;
    } catch (error) {
      // Return empty state object if file doesn't exist or is corrupted
      this.logger?.warn?.('Could not load state.json', { path: statePath, error: error.message });
      return {};
    }
  }

  async getHomeSummary(maxAgeMs = 5000) {
    if (this.homeSummaryCache.data && this.homeSummaryCache.expiresAt > Date.now()) {
      return this.homeSummaryCache.data;
    }

    const summary = await this.buildHomeSummary();
    this.homeSummaryCache = {
      data: summary,
      expiresAt: Date.now() + maxAgeMs
    };
    return summary;
  }

  async buildHomeSummary() {
    const [thoughtSummary, memoryNodes] = await Promise.all([
      this.getThoughtsSummary(),
      this.getFastMemoryNodeCount()
    ]);

    const lastThought = thoughtSummary.lastThought;
    const lastThoughtRole = lastThought?.role || null;

    return {
      cycleCount: lastThought?.cycle || 0,
      thoughtCount: thoughtSummary.count,
      memoryNodes: Number.isFinite(memoryNodes) ? memoryNodes : null,
      lastThoughtAt: lastThought?.timestamp || null,
      lastThoughtRole,
      lastThoughtText: lastThought?.thought || lastThought?.content || lastThought?.text || null,
      temporalState: lastThoughtRole === 'sleep' ? 'sleeping' : 'awake',
      generatedAt: new Date().toISOString()
    };
  }

  async getThoughtsSummary() {
    const thoughtsPath = path.join(this.logsDir, 'thoughts.jsonl');
    let count = 0;
    let lastThought = null;

    try {
      const fileStream = createReadStream(thoughtsPath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (!line.trim()) continue;
        count += 1;
        try {
          lastThought = JSON.parse(line);
        } catch {
          // Ignore malformed lines and keep the last valid thought.
        }
      }
    } catch {
      return { count: 0, lastThought: null };
    }

    return { count, lastThought };
  }

  async getFastMemoryNodeCount() {
    const cachePath = path.join(this.logsDir, 'dashboard-cache.json');
    try {
      const cache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
      if (Number.isFinite(cache?.nodeCount)) {
        return cache.nodeCount;
      }
    } catch {
      // Fall through to evaluation metrics.
    }

    const metricsPath = path.join(this.logsDir, 'evaluation-metrics.json');
    try {
      const metrics = JSON.parse(await fs.readFile(metricsPath, 'utf8'));
      const totalNodes = metrics?.metrics?.memory?.totalNodes;
      if (Number.isFinite(totalNodes)) {
        return totalNodes;
      }
    } catch {
      // Fall through to state only if it's small enough.
    }

    const statePathGz = path.join(this.logsDir, 'state.json.gz');
    try {
      const stats = await fs.stat(statePathGz);
      const maxInlineSummarySize = 30 * 1024 * 1024;
      if (stats.size <= maxInlineSummarySize) {
        const state = await this.loadState();
        const nodeCount = state?.memory?.nodes?.length;
        if (Number.isFinite(nodeCount)) {
          return nodeCount;
        }
      }
    } catch {
      // No lightweight node source available.
    }

    return null;
  }

  /**
   * Safely count completed items from progress tracker
   * Handles both Map and plain object formats (JSON serialization converts Maps to objects)
   */
  getCompletedCount(progress) {
    if (!progress) return 0;
    
    try {
      // Handle Map format (in-memory)
      if (progress instanceof Map || typeof progress.values === 'function') {
        return Array.from(progress.values()).filter(p => p && p.status === 'completed').length;
      }
      
      // Handle plain object format (from JSON)
      if (typeof progress === 'object') {
        return Object.values(progress).filter(p => p && p.status === 'completed').length;
      }
      
      return 0;
    } catch (error) {
      this.logger?.warn?.('Error counting completed items', { error: error.message });
      return 0;
    }
  }

  buildEnhancedPlanMarkdown(plan, milestones, tasks, originalMarkdown) {
    const lines = [];
    
    lines.push('# Guided Execution Plan');
    lines.push('');
    lines.push(`**Plan ID:** ${plan.id}`);
    lines.push(`**Title:** ${plan.title}`);
    lines.push(`**Status:** ${plan.status}`);
    lines.push(`**Created:** ${new Date(plan.createdAt).toLocaleString()}`);
    if (plan.completedAt) {
      lines.push(`**Completed:** ${new Date(plan.completedAt).toLocaleString()}`);
    }
    lines.push('');
    
    // Milestones and Tasks
    lines.push('## Phases & Tasks');
    lines.push('');
    
    milestones.forEach((milestone, idx) => {
      const milestoneTasks = tasks.filter(t => t.milestoneId === milestone.id);
      const statusIcon = milestone.status === 'COMPLETED' ? '✅' : 
                        milestone.status === 'ACTIVE' ? '⏳' : '⏸️';
      
      lines.push(`### ${statusIcon} Phase ${idx + 1}: ${milestone.title}`);
      lines.push('');
      lines.push(`**Status:** ${milestone.status}`);
      lines.push(`**Tasks:** ${milestoneTasks.length}`);
      lines.push('');
      
      milestoneTasks.forEach(task => {
        const taskIcon = task.state === 'DONE' ? '✅' : 
                        task.state === 'IN_PROGRESS' ? '⏳' : 
                        task.state === 'FAILED' ? '❌' : '⏸️';
        lines.push(`#### ${taskIcon} ${task.title}`);
        lines.push('');
        lines.push(task.description);
        lines.push('');
        
        if (task.acceptanceCriteria && task.acceptanceCriteria.length > 0) {
          lines.push('**Acceptance Criteria:**');
          task.acceptanceCriteria.forEach(criterion => {
            lines.push(`- ${criterion.rubric || criterion.pattern || 'Validation required'}`);
          });
          lines.push('');
        }
        
        if (task.state !== 'PENDING') {
          lines.push(`**State:** ${task.state}`);
          if (task.claimedBy) {
            lines.push(`**Assigned to:** ${task.claimedBy}`);
          }
          lines.push('');
        }
      });
    });
    
    lines.push('---');
    lines.push('');
    lines.push('*Plan data loaded from filesystem state store*');
    
    return lines.join('\n');
  }

  getOrchestratorInstance() {
    // This assumes the orchestrator instance is available globally or via a singleton
    // In practice, the orchestrator would need to register itself with the dashboard
    // For now, return null if not available
    return global.cosmOrchestrator || null;
  }

  async getRecentThoughts(limit = 20) {
    const thoughtsPath = path.join(this.logsDir, 'thoughts.jsonl');
    const thoughts = [];

    try {
      const fileStream = createReadStream(thoughtsPath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (line.trim()) {
          thoughts.push(JSON.parse(line));
        }
      }

      return thoughts.slice(-limit);
    } catch (error) {
      return [];
    }
  }

  async readAgentResults(resultsPath) {
    const full = await this.readAgentResultsFull(resultsPath);
    
    // Return summary view
    return full.map(entry => ({
      agentId: entry.agentId,
      agentType: entry.agentType,
      goal: entry.mission?.goalId,
      description: entry.mission?.description,
      status: entry.status,
      findings: entry.results?.filter(r => r.type === 'finding').length || 0,
      insights: entry.results?.filter(r => r.type === 'insight').length || 0,
      duration: entry.durationFormatted || entry.duration,
      progress: entry.progressReports?.length > 0 ? entry.progressReports[entry.progressReports.length - 1] : null,
      startTime: entry.startTime,
      endTime: entry.endTime
    }));
  }

  async readAgentResultsFull(resultsPath) {
    const results = [];

    try {
      const fileStream = createReadStream(resultsPath);
      const rl = createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      for await (const line of rl) {
        if (line.trim()) {
          try {
            const entry = JSON.parse(line);
            // Skip integration markers, only get actual results
            if (entry.type !== 'integration_marker' && entry.agentId && entry.agentType) {
              results.push(entry); // Full data with all findings
            }
          } catch (e) {
            // Skip malformed lines
          }
        }
      }

      return results;
    } catch (error) {
      return [];
    }
  }

  extractSubsystemStats(state) {
    return {
      memory: {
        nodes: state.memory?.nodes?.length || 0,
        edges: state.memory?.edges?.length || 0,
        clusters: state.memory?.clusters?.length || 0
      },
      goals: {
        active: Array.isArray(state.goals?.active) ? state.goals.active.length : 0,
        completed: state.goals?.completed?.length || 0
      },
      roles: {
        total: state.roles?.length || 0,
        avgSuccess: this.avgSuccessRate(state.roles)
      }
    };
  }

  avgSuccessRate(roles) {
    if (!roles || roles.length === 0) return 0;
    const sum = roles.reduce((acc, r) => acc + (r.successRate || 0), 0);
    return sum / roles.length;
  }

  analyzeRecentActivity(thoughts) {
    if (thoughts.length === 0) return {};

    const modeCounts = { focus: 0, explore: 0 };
    const goalsCaptured = thoughts.reduce((sum, t) => sum + (t.goalsAutoCaptured || 0), 0);
    const perturbations = thoughts.filter(t => t.perturbation).length;
    const tunnels = thoughts.filter(t => t.tunnel).length;

    thoughts.forEach(t => {
      if (t.oscillatorMode) {
        modeCounts[t.oscillatorMode] = (modeCounts[t.oscillatorMode] || 0) + 1;
      }
    });

    return {
      modeCounts,
      goalsCaptured,
      perturbations,
      tunnels,
      avgSurprise: thoughts.reduce((sum, t) => sum + (t.surprise || 0), 0) / thoughts.length
    };
  }

  /**
   * Get dreams for a specific run
   * FIX (2025-12-11): Now properly scoped to run parameter
   */
  async getDreamsForRun(runName, limit = 100, options = {}) {
    const dreams = [];
    const { lite = false } = options;
    
    // Resolve run directory
    const runDir = (runName === 'runtime' || runName === 'current') ? this.defaultRunDir : path.join(this.runsDir, runName);
    
    try {
      // First, load full dreams from dedicated dreams.jsonl file
      const dreamsFile = path.join(runDir, 'dreams.jsonl');
      const fsSync = require('fs');
      
      if (fsSync.existsSync(dreamsFile)) {
        const fileStream = createReadStream(dreamsFile);
        const rl = createInterface({
          input: fileStream,
          crlfDelay: Infinity
        });

        for await (const line of rl) {
          if (line.trim()) {
            try {
              const dream = JSON.parse(line);
              dreams.push({
                id: `dream_${dream.cycle}_${dream.dreamNumber}`,
                cycle: dream.cycle,
                timestamp: dream.timestamp,
                content: dream.content,
                reasoning: dream.reasoning,
                model: dream.model,
                cognitiveState: dream.cognitiveState,
                source: 'dreams_file',
                type: 'narrative' // Full narrative dreams
              });
            } catch (e) {
              // Skip invalid lines
            }
          }
        }
      }

      if (lite) {
        dreams.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        const limitedDreams = dreams.slice(0, limit);
        return {
          dreams: limitedDreams,
          stats: {
            total: dreams.length,
            narratives: dreams.filter(d => d.source === 'dreams_file').length,
            fromGoals: 0,
            fromMemory: 0,
            completed: 0
          }
        };
      }
      
      // Load state from the correct run directory
      // Note: StateCompression.loadCompressed handles .gz extension automatically
      const stateFile = path.join(runDir, 'state.json');
      let state = null;
      try {
        state = await StateCompression.loadCompressed(stateFile);
      } catch (error) {
        console.warn(`[getDreamsForRun] Could not load state for run ${runName}:`, error.message);
        // Continue without state - might still have dreams.jsonl
      }
      
      // Dreams are stored as goals with source='dream_gpt5' or 'dream'
      if (state && state.goals) {
        const allGoals = [
          ...(Array.isArray(state.goals.active) ? state.goals.active : []),
          ...(state.goals.completed || []),
          ...(state.goals.archived || [])
        ];
        
        allGoals.forEach(goalEntry => {
          const goal = Array.isArray(goalEntry) ? goalEntry[1] : goalEntry;
          if (!goal) return;
          
          // Check if this is a dream goal
          if (goal.source === 'dream_gpt5' || goal.source === 'dream') {
            dreams.push({
              id: goal.id,
              cycle: null, // Goals don't have cycle numbers
              timestamp: goal.created || goal.lastPursued || new Date(),
              content: goal.description,
              reason: goal.reason || '',
              uncertainty: goal.uncertainty,
              priority: goal.priority,
              progress: goal.progress || 0,
              pursuitCount: goal.pursuitCount || 0,
              completed: !!goal.completedAt,
              completedAt: goal.completedAt,
              source: 'goals',
              model: goal.source === 'dream_gpt5' ? 'gpt-5.2' : 'gpt-5.2'
            });
          }
        });
      }

      // Also get dreams from memory nodes (tagged as 'dream')
      if (state && state.memory && state.memory.nodes) {
        state.memory.nodes.forEach(node => {
          if (node.tag === 'dream' || (node.tags && node.tags.includes('dream'))) {
            dreams.push({
              id: `dream_mem_${node.id}`,
              cycle: node.cycle || null,
              timestamp: node.created || node.accessed,
              content: node.concept,
              activation: node.activation,
              accessCount: node.accessCount,
              tags: node.tag ? [node.tag] : (node.tags || []),
              source: 'memory',
              model: null
            });
          }
        });
      }

      // Sort by timestamp (newest first)
      dreams.sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return timeB - timeA;
      });

      // Limit results
      const limitedDreams = dreams.slice(0, limit);

      return {
        dreams: limitedDreams,
        stats: {
          total: dreams.length,
          narratives: dreams.filter(d => d.source === 'dreams_file').length,
          fromGoals: dreams.filter(d => d.source === 'goals').length,
          fromMemory: dreams.filter(d => d.source === 'memory').length,
          completed: dreams.filter(d => d.completed).length
        }
      };
    } catch (error) {
      console.error(`Error fetching dreams for run ${runName}:`, error);
      return {
        dreams: [],
        stats: { total: 0, fromGoals: 0, fromMemory: 0, completed: 0 },
        error: error.message
      };
    }
  }
  
  /**
   * Legacy method - redirects to getDreamsForRun for backward compatibility
   */
  async getDreams(limit = 100) {
    return await this.getDreamsForRun('runtime', limit);
  }

  /**
   * Set orchestrator reference for agent spawning
   * Called from index.js after orchestrator initialization
   * Enables document compilation features in dashboard
   */
  setOrchestrator(orchestrator) {
    this.orchestrator = orchestrator;
    console.log('✅ Orchestrator linked to dashboard server (system compilation enabled)');
  }

  broadcast(event, data) {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    this.clients.forEach(client => {
      try {
        client.write(message);
      } catch (error) {
        this.clients.delete(client);
      }
    });
  }

  // POST /api/ingest — remote ingest for Axiom→Terrapin feeder
  // Uses a sidecar NDJSON file (axiom-nodes.ndjson) to avoid rewriting the 156MB state.json.gz
  setupIngestRoute() {
    const zlib = require('zlib');
    const crypto = require('crypto');
    const fsSync = require('fs');
    const pathLib = require('path');

    // Sidecar file lives next to state.json.gz
    const runDir = pathLib.join(this.runsDir, 'terrapin');
    const sidecarPath = pathLib.join(runDir, 'axiom-nodes.ndjson');

    // Load existing sidecar manifest (filePath → [nodeIds])
    const loadSidecar = () => {
      if (!fsSync.existsSync(sidecarPath)) return { index: {}, nodes: [] };
      const lines = fsSync.readFileSync(sidecarPath, 'utf8').trim().split('\n').filter(Boolean);
      const nodes = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const index = {};
      for (const n of nodes) { const k = n.sourcePath || n.filePath; if (k) (index[k] = index[k] || []).push(n.id); }
      return { index, nodes };
    };

    this.app.post('/api/ingest', (req, res) => {
      try {
        const token = process.env.INGEST_TOKEN;
        if (token && req.get('X-Ingest-Token') !== token) {
          return res.status(401).json({ error: 'Unauthorized' });
        }
        const items = Array.isArray(req.body?.items) ? req.body.items : null;
        if (!items) return res.status(400).json({ error: 'items required' });

        const { index, nodes } = loadSidecar();
        let upserted = 0;

        for (const item of items) {
          if (!item?.filePath) continue;
          upserted += 1;
          // Remove old nodes for this file
          const oldIds = new Set(index[item.filePath] || []);
          const kept = nodes.filter(n => !oldIds.has(n.id));
          nodes.length = 0; nodes.push(...kept);
          index[item.filePath] = [];

          const chunks = Array.isArray(item.chunks) ? item.chunks : [{ text: item.content || '', embedding: null }];
          for (const chunk of chunks) {
            const n = { id: crypto.randomUUID(), label: item.label || 'axiom-ingest',
              sourcePath: item.filePath, content: chunk?.text || item.content || '',
              embedding: chunk?.embedding ?? null, ingestedAt: item.ingestedAt || new Date().toISOString(), hash: item.hash || null };
            nodes.push(n);
            index[item.filePath].push(n.id);
          }
        }

        // Rewrite sidecar
        fsSync.mkdirSync(runDir, { recursive: true });
        fsSync.writeFileSync(sidecarPath, nodes.map(n => JSON.stringify(n)).join('\n') + '\n', 'utf8');
        res.json({ ok: true, upserted, sidecarNodes: nodes.length });
      } catch (err) {
        console.error('[/api/ingest] error:', err.message);
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/ingest/status — count sidecar nodes
    this.app.get('/api/ingest/status', (req, res) => {
      try {
        if (!fsSync.existsSync(sidecarPath)) return res.json({ sidecarNodes: 0, sidecarPath });
        const lines = fsSync.readFileSync(sidecarPath, 'utf8').trim().split('\n').filter(Boolean);
        res.json({ sidecarNodes: lines.length, sidecarPath });
      } catch (err) { res.status(500).json({ error: err.message }); }
    });

    console.log('✅ /api/ingest route registered (Axiom→Terrapin feeder, sidecar: axiom-nodes.ndjson)');

    // API: Read agent workspace files (SOUL.md, MISSION.md, MEMORY.md, STATUS.md)
    this.app.get('/api/agent-file', async (req, res) => {
      try {
        const { agent, file } = req.query;
        if (!agent || !file) return res.status(400).json({ error: 'agent and file params required' });
        const safeAgent = agent.replace(/[^a-zA-Z0-9_-]/g, '');
        const safeFile = file.replace(/[^a-zA-Z0-9_.\-]/g, '');
        const agentsDir = path.join(__dirname, '..', '..', '..', 'workspace', 'agents');
        const filePath = path.join(agentsDir, safeAgent, safeFile);
        if (!filePath.startsWith(agentsDir)) return res.status(403).json({ error: 'forbidden' });
        const fs = require('fs');
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'file not found', path: filePath });
        const content = fs.readFileSync(filePath, 'utf8');
        res.type('text/plain').send(content);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }

  start() {
    this.setupIngestRoute();

    // Initialize synthesis agent (Home23 Intelligence tab)
    try {
      const { SynthesisAgent } = require('../synthesis/synthesis-agent');
      const workspacePath = process.env.COSMO_WORKSPACE_PATH || path.join(this.logsDir, '..', 'workspace');
      this._synthesisAgent = new SynthesisAgent({
        brainDir: this.logsDir,
        workspacePath,
        dashboardPort: this.port,
        config: { intervalHours: 4 },
        logger: console,
      });
      this._synthesisAgent.startSchedule();
      console.log('[DashboardServer] Synthesis agent initialized');
    } catch (err) {
      console.warn('[DashboardServer] Synthesis agent not available:', err.message);
      this._synthesisAgent = null;
    }

    // Boot the sensor registry + stock sensors. Tile fetches publish into
    // the same registry from home23-tiles.js. Pulse remarks (running in the
    // engine process) reads via /api/sensors so this is the single source
    // of truth for "what does the host know."
    try {
      const sensorsModule = require('../sensors');
      sensorsModule.startStock({
        info: (...a) => console.log('[sensors]', ...a),
        warn: (...a) => console.warn('[sensors]', ...a),
      });
    } catch (e) {
      console.warn('[DashboardServer] sensors boot failed (non-fatal):', e.message);
    }

    this.app.listen(this.port, () => {
      console.log(`\n╔══════════════════════════════════════════════════╗`);
      console.log(`║   Phase 2B Dashboard Server Running             ║`);
      console.log(`╚══════════════════════════════════════════════════╝`);
      console.log(`\n  Dashboard: http://localhost:${this.port}`);
      console.log(`  MCP Proxy: http://localhost:${this.port}/api/mcp → localhost:${this.mcpPort}`);
      console.log(`  Logs: ${this.logsDir}\n`);
      console.log(`  Enhanced Views:`);
      console.log(`    • Main Dashboard:     http://localhost:${this.port}/`);
      console.log(`    • Intelligence:       http://localhost:${this.port}/intelligence        🎮 Operations Tab`);
      console.log(`    • Query Interface:    http://localhost:${this.port}/query`);
      console.log(`    • Insights Explorer:  http://localhost:${this.port}/insights`);
      console.log(`    • Dreams Explorer:    http://localhost:${this.port}/dreams`);
      console.log(`    • Evaluation Metrics: http://localhost:${this.port}/evaluation`);
      console.log(`    • Novelty Explorer:   http://localhost:${this.port}/novelty-explorer.html`);
      console.log(`    • Agent Network:      http://localhost:${this.port}/agent-network.html`);
      console.log(`    • Provenance Trails:  http://localhost:${this.port}/provenance-explorer.html\n`);
    });

    // Watch for log file changes and broadcast
    this.watchLogs();
  }

  async watchLogs() {
    const thoughtsPath = path.join(this.logsDir, 'thoughts.jsonl');
    let lastSize = 0;

    setInterval(async () => {
      try {
        const stats = await fs.stat(thoughtsPath);
        if (stats.size > lastSize) {
          lastSize = stats.size;
          
          const thoughts = await this.getRecentThoughts(1);
          if (thoughts.length > 0) {
            this.broadcast('thought', thoughts[0]);
          }

          // Skip full state parse for large state files (>50MB gz) to prevent V8 crash
          const stateGzPath = path.join(this.logsDir, 'state.json.gz');
          let stateGzSize = 0;
          try { stateGzSize = (await fs.stat(stateGzPath)).size; } catch (e) {}
          if (stateGzSize > 50 * 1024 * 1024) {
            // Use metrics file for lightweight broadcast instead
            try {
              const metricsPath = path.join(this.logsDir, 'metrics.json');
              const metricsRaw = await fs.readFile(metricsPath, 'utf-8');
              const metrics = JSON.parse(metricsRaw);
              this.broadcast('stats', { cycleCount: metrics.cycleCount || metrics.totalCycles || 0, oscillator: null });
            } catch (e) { /* metrics not available */ }
          } else {
            const state = await this.loadState();
            this.broadcast('stats', {
              cycleCount: state.cycleCount,
              oscillator: state.oscillator
            });
          }
        }
      } catch (error) {
        // File might not exist yet
      }
    }, 2000);
  }

  /**
   * Set evaluation framework reference (called by orchestrator)
   */
  setEvaluationFramework(framework) {
    this.evaluationFramework = framework;
    
    // Add API endpoint for evaluation metrics
    this.app.get('/api/evaluation/metrics', async (req, res) => {
      try {
        if (!this.evaluationFramework) {
          res.status(503).json({ error: 'Evaluation framework not initialized' });
          return;
        }
        
        const metrics = this.evaluationFramework.getMetrics();
        const agentRanking = this.evaluationFramework.getAgentEffectivenessRanking();
        
        // Generate insights and recommendations on the fly
        const report = await this.evaluationFramework.generateReport(
          this.evaluationFramework.metrics.system.cyclesRun
        );
        
        res.json({
          metrics,
          agentRanking,
          insights: report.insights,
          recommendations: report.recommendations,
          trends: report.trends,
          lastUpdated: Date.now()
        });
      } catch (error) {
        console.error('Failed to get evaluation metrics:', error);
        res.status(500).json({ error: error.message });
      }
    });
  }

  /**
   * Load live journals from agent directories
   * Reuses same logic as query-engine.js for consistency
   */
  async loadLiveJournalsForRun(runDir) {
    const agentsDir = path.join(runDir, 'agents');
    const findings = [];
    
    try {
      const agentDirs = await fs.readdir(agentsDir);
      
      for (const agentId of agentDirs) {
        if (!agentId.startsWith('agent_')) continue;
        
        for (const journalType of ['findings.jsonl', 'insights.jsonl']) {
          try {
            const journalPath = path.join(agentsDir, agentId, journalType);
            const content = await fs.readFile(journalPath, 'utf8');
            const lines = content.split('\n').filter(Boolean);
            
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);
                findings.push({ ...entry, agentId });
              } catch { /* skip corrupted line */ }
            }
          } catch { /* no journal file */ }
        }
      }
    } catch { /* agents dir doesn't exist */ }
    
    return findings;
  }

  /**
   * Merge baseline nodes with live journals
   * Reuses same logic as query-engine.js
   */
  mergeNodesWithJournals(baselineNodes, liveJournals) {
    const nodeMap = new Map();
    
    for (const node of baselineNodes) {
      if (node && node.id) {
        nodeMap.set(node.id, node);
      }
    }
    
    for (const finding of liveJournals) {
      if (!finding || !finding.nodeId) continue;
      
      if (!nodeMap.has(finding.nodeId)) {
        const prefix = finding.type === 'insight' ? '[AGENT INSIGHT: ' : '[AGENT: ';
        const concept = finding.content.startsWith(prefix) 
          ? finding.content 
          : `${prefix}${finding.agentId}] ${finding.content}`;
        
        nodeMap.set(finding.nodeId, {
          id: finding.nodeId,
          concept,
          tag: finding.tag,
          created: finding.timestamp,
          accessed: finding.timestamp,
          activation: 0.9,
          weight: 1.0,
          embedding: null,
          _liveJournal: true,
          _agentId: finding.agentId
        });
      }
    }
    
    return Array.from(nodeMap.values());
  }

  /**
   * Generate BibTeX citations from source URLs
   * Basic implementation - converts URLs to BibTeX entries
   */
  generateBibTeX(sources, metadata = {}) {
    const { runName, agentId } = metadata;
    let bibtex = `% Generated by COSMO Mission Tracer\n`;
    bibtex += `% Run: ${runName || 'unknown'}\n`;
    bibtex += `% Agent: ${agentId || 'unknown'}\n`;
    bibtex += `% Generated: ${new Date().toISOString()}\n`;
    bibtex += `% Total Sources: ${sources.length}\n\n`;
    
    sources.forEach((url, i) => {
      const citationKey = this.generateCitationKey(url, i);
      const entry = this.urlToBibTeX(url, citationKey);
      bibtex += entry + '\n\n';
    });
    
    return bibtex;
  }

  /**
   * Generate citation key from URL
   */
  generateCitationKey(url, index) {
    try {
      const urlObj = new URL(url);
      const domain = urlObj.hostname.replace(/^www\./, '').replace(/\./g, '_');
      
      // Extract identifier from path
      let identifier = '';
      
      if (url.includes('arxiv.org')) {
        const match = url.match(/(\d+\.\d+)/);
        identifier = match ? `arxiv_${match[1].replace('.', '_')}` : `arxiv_${index}`;
      } else if (url.includes('doi.org')) {
        const match = url.match(/10\.\d+\/([^?]+)/);
        identifier = match ? match[1].replace(/[\/\.]/g, '_') : `doi_${index}`;
      } else if (url.includes('pubmed')) {
        const match = url.match(/(\d+)/);
        identifier = match ? `pubmed_${match[1]}` : `pubmed_${index}`;
      } else {
        identifier = `${domain}_${index}`;
      }
      
      return identifier;
    } catch (error) {
      return `source_${index}`;
    }
  }

  /**
   * Find goal data from goals or state files
   */
  async findGoalData(runDir, goalId) {
    try {
      // Try state.json first
      const statePath = path.join(runDir, 'state.json');
      const stateData = await StateCompression.loadCompressed(statePath);
      
      if (stateData.goals) {
        const goal = Array.from(stateData.goals.values()).find(g => g.id === goalId);
        if (goal) {
          return {
            id: goal.id,
            description: goal.description,
            created: goal.created,
            priority: goal.priority,
            source: goal.source || 'intrinsic',
            status: goal.status,
            progress: goal.progress
          };
        }
      }
      
      return null;
    } catch (error) {
      console.error('Could not load goal data:', error.message);
      return null;
    }
  }

  /**
   * Find coordinator review from cycle
   */
  async findCoordinatorReview(runDir, cycle) {
    try {
      // Calculate which review cycle (reviews happen every N cycles)
      const reviewCycle = Math.floor(cycle / 20) * 20; // Assuming 20-cycle reviews
      const reviewPath = path.join(runDir, 'coordinator', `review_${reviewCycle}.md`);
      
      const fsSync = require('fs');
      if (!fsSync.existsSync(reviewPath)) {
        return null;
      }
      
      const content = await fs.readFile(reviewPath, 'utf8');
      
      // Extract summary from review
      const summaryMatch = content.match(/## Summary\s+([\s\S]*?)---/);
      const goalsMatch = content.match(/Goals Evaluated: (\d+)/);
      const agentsMatch = content.match(/Agents Completed: (\d+)/);
      
      return {
        file: `review_${reviewCycle}.md`,
        cycle: reviewCycle,
        summary: summaryMatch ? summaryMatch[1].trim() : null,
        goalsEvaluated: goalsMatch ? parseInt(goalsMatch[1]) : null,
        agentsCompleted: agentsMatch ? parseInt(agentsMatch[1]) : null
      };
    } catch (error) {
      console.error('Could not load coordinator review:', error.message);
      return null;
    }
  }

  /**
   * Find downstream agents that used findings from this mission
   */
  async findDownstreamUsage(missions, nodeIds) {
    const downstream = [];
    
    // Look for synthesis or analysis agents that might have used these nodes
    const laterMissions = missions.filter(m => 
      (m.agentType === 'SynthesisAgent' || m.agentType === 'AnalysisAgent') &&
      m.agentSpecificData?.sourcesConsulted > 0
    );
    
    // For each later mission, check if it might have used our nodes
    laterMissions.forEach(m => {
      downstream.push({
        agentId: m.agentId,
        agentType: m.agentType,
        duration: m.durationFormatted,
        sourcesUsed: m.agentSpecificData.sourcesConsulted
      });
    });
    
    return downstream.slice(0, 5); // Top 5 downstream
  }

  /**
   * Convert URL to BibTeX entry
   * Basic implementation - can be enhanced with metadata fetching
   */
  urlToBibTeX(url, citationKey) {
    try {
      const urlObj = new URL(url);
      const hostname = urlObj.hostname;
      
      // Detect source type and generate appropriate entry
      if (url.includes('arxiv.org')) {
        const match = url.match(/abs\/(\d+\.\d+)/);
        const arxivId = match ? match[1] : 'unknown';
        return `@misc{${citationKey},
  title = {arXiv Preprint ${arxivId}},
  author = {Various},
  year = {2024},
  eprint = {${arxivId}},
  archivePrefix = {arXiv},
  url = {${url}}
}`;
      } else if (url.includes('pubmed') || url.includes('pmc.ncbi')) {
        const match = url.match(/(\d+)/);
        const pmid = match ? match[1] : 'unknown';
        return `@article{${citationKey},
  title = {PubMed Article ${pmid}},
  author = {Various},
  journal = {PubMed},
  year = {2024},
  note = {PMID: ${pmid}},
  url = {${url}}
}`;
      } else if (url.includes('doi.org')) {
        const match = url.match(/10\.\d+\/([^?]+)/);
        const doi = match ? match[0] : 'unknown';
        return `@article{${citationKey},
  title = {DOI Reference},
  author = {Various},
  year = {2024},
  doi = {${doi}},
  url = {${url}}
}`;
      } else if (url.includes('wikipedia.org')) {
        const match = url.match(/\/wiki\/([^?#]+)/);
        const article = match ? decodeURIComponent(match[1]).replace(/_/g, ' ') : 'Article';
        return `@misc{${citationKey},
  title = {${article}},
  author = {Wikipedia},
  year = {2024},
  howpublished = {\\url{${url}}},
  note = {Online; accessed ${new Date().toISOString().split('T')[0]}}
}`;
      } else if (url.includes('academic.oup.com') || url.includes('cambridge.org')) {
        return `@book{${citationKey},
  title = {Academic Publication},
  author = {Various},
  publisher = {${hostname.includes('oup') ? 'Oxford University Press' : 'Cambridge University Press'}},
  year = {2024},
  url = {${url}}
}`;
      } else {
        // Generic web source
        return `@misc{${citationKey},
  title = {Web Resource},
  author = {${hostname}},
  year = {2024},
  howpublished = {\\url{${url}}},
  note = {Accessed ${new Date().toISOString().split('T')[0]}}
}`;
      }
    } catch (error) {
      return `@misc{${citationKey},
  title = {Source Reference},
  url = {${url}},
  note = {Accessed ${new Date().toISOString().split('T')[0]}}
}`;
    }
  }
}

// Run if called directly
if (require.main === module) {
  // Read port from environment or default to 3344
  const port = parseInt(process.env.COSMO_DASHBOARD_PORT || process.env.DASHBOARD_PORT || 3344);
  
  console.log('');
  console.log('[Dashboard Server] Environment:');
  console.log('  COSMO_DASHBOARD_PORT:', process.env.COSMO_DASHBOARD_PORT);
  console.log('  DASHBOARD_PORT:      ', process.env.DASHBOARD_PORT);
  console.log('  Resolved port:       ', port);
  console.log('  MCP_HTTP_PORT:       ', process.env.MCP_HTTP_PORT);
  console.log('');
  
  const server = new DashboardServer(port);
  server.start();
}

module.exports = { DashboardServer };
