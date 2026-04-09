const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { createReadStream } = require('fs');
const { createInterface } = require('readline');
const zlib = require('zlib');
const { promisify } = require('util');
const gunzip = promisify(zlib.gunzip);
const { StateCompression } = require('../core/state-compression');
const { InsightAnalyzer } = require('./insight-analyzer');
const { NoveltyValidator } = require('./novelty-validator');
const { QueryEngine } = require('./query-engine');
const { IntelligenceBuilder } = require('./intelligence-builder');
const { ClusterDataProxy } = require('../cluster/cluster-data-proxy');

/**
 * Phase 2B Dashboard Server
 * Real-time visualization of all Phase 2B features
 */
class DashboardServer {
  constructor(port = 3344, logsDir) {
    this.port = port;
    this.mcpPort = parseInt(process.env.MCP_HTTP_PORT || process.env.MCP_PORT || 3347);
    this.runsDir = path.join(__dirname, '..', '..', 'runs');
    this.defaultRunDir = path.join(__dirname, '..', '..', 'runtime');
    
    // Default to GPT-5.2 logs, fallback to regular logs
    this.logsDir = logsDir || this.detectLogsDirectory();
    this.currentRun = 'runtime'; // Track current run name
    this.currentRunMetadata = null;
    
    this.app = express();
    this.app.use(express.json()); // Enable JSON body parsing
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
    const gpt5Dir = path.join(__dirname, '..', '..', 'runtime');
    const regularDir = path.join(__dirname, '..', '..', 'runtime');
    
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
        const maxSize = 100 * 1024 * 1024; // 100MB limit
        
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

  setupRoutes() {
    this.app.use(express.static(path.join(__dirname)));

    // NEW: Serve curated insights reports (from coordinator directory)
    this.app.use('/reports', express.static(path.join(this.logsDir, 'coordinator')));

    // Health check / ready endpoint
    this.app.get('/api/ready', (req, res) => {
      res.json({ ready: true, timestamp: Date.now() });
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        
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
        
        const compressed = await fs.readFile(statePath);
        const decompressed = await gunzip(compressed);
        const state = JSON.parse(decompressed.toString());
        
        if (!state.memory) {
          return res.json({ nodes: [], edges: [] });
        }
        
        res.json(state.memory);
      } catch (error) {
        console.error('Failed to get memory data:', error);
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get run state (full)
    this.app.get('/api/runs/:runName/state', async (req, res) => {
      try {
        const { runName } = req.params;
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
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

    // API: Get specific curated insight
    this.app.get('/api/runs/:runName/coordinator/insight/:filename', async (req, res) => {
      try {
        const { runName, filename } = req.params;
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        
        // Create run-specific QueryEngine instance
        const QueryEngine = require('./query-engine').QueryEngine || require('./query-engine');
        const runQueryEngine = new QueryEngine(runDir, process.env.OPENAI_API_KEY);
        
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        
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

    // API: Force wake from sleep mode
    this.app.post('/api/operations/force-wake', async (req, res) => {
      try {
        const StateCompression = require('../core/state-compression');
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
        const runDir = runName === 'runtime' ? this.defaultRunDir : path.join(this.runsDir, runName);
        
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
        const orchestrator = this.getOrchestratorInstance();
        const stateStore = orchestrator?.clusterStateStore;
        
        if (!stateStore) {
          return res.json({ tasks: [] });
        }
        
        const activePlan = await stateStore.getPlan('plan:main') || 
                           await stateStore.getPlan('plan:backlog');
        
        if (!activePlan) {
          return res.json({ tasks: [] });
        }
        
        const tasks = await stateStore.listTasks(activePlan.id);
        
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
          plan: activePlan,
          tasks: grouped,
          total: tasks.length
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // API: Get active plan with milestones
    this.app.get('/api/plan', async (req, res) => {
      try {
        const orchestrator = this.getOrchestratorInstance();
        const stateStore = orchestrator?.clusterStateStore;
        
        if (!stateStore) {
          return res.json({ plan: null });
        }
        
        const plan = await stateStore.getPlan('plan:main');
        if (!plan) {
          return res.json({ plan: null });
        }
        
        const milestones = await Promise.all(
          plan.milestones.map(id => stateStore.getMilestone(id))
        );
        
        res.json({
          plan,
          milestones,
          activeMilestone: milestones.find(m => m.id === plan.activeMilestone)
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
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
    this.app.get('/api/state', async (req, res) => {
      try {
        const state = await this.loadState();
        res.json(state);
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
        const dreams = await this.getDreams(limit);
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
        
        // Build system prompt for documentation editing
        const systemPrompt = `You are an AI assistant integrated into the COSMO Documentation IDE.

Your role is to help users write, edit, and improve documentation.

Current context:
- File: ${fileName || 'untitled'}
- Format: ${language || 'text'}
- Document length: ${documentContent ? documentContent.length + ' characters' : 'empty'}

IMPORTANT - Response Format:
${isEditRequest && hasSelection ? `
The user is requesting an EDIT to selected text. Respond with ONLY the improved version of the text.
- Do NOT include explanations before or after
- Do NOT use markdown code blocks
- Return ONLY the replacement text
- Preserve the general structure and formatting
- Focus on the specific improvement requested
` : `
For general questions or analysis:
- Provide helpful, concise responses
- Use markdown formatting for clarity
- Be specific and actionable
- Reference the document context when relevant
`}

Remember: You're helping with documentation, not code (unless it's code examples IN docs).`;

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
        
        // Call OpenAI
        const response = await openai.chat.completions.create({
          model: 'gpt-4o',  // Fast and capable
          messages: messages,
          temperature: 0.3,  // Lower temp for more consistent editing
          max_tokens: 4000
        });
        
        const aiResponse = response.choices[0].message.content;
        const tokensUsed = response.usage?.total_tokens || 0;
        
        console.log(`[IDE CHAT] Response length: ${aiResponse.length} chars`);
        console.log(`[IDE CHAT] Tokens used: ${tokensUsed}`);
        
        res.json({
          success: true,
          response: aiResponse,
          tokensUsed: tokensUsed,
          model: 'gpt-4o'
        });
        
      } catch (error) {
        console.error('[IDE CHAT] Error:', error);
        res.status(500).json({ 
          success: false,
          error: error.message 
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
          priorContext
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
        
        // Create run-specific QueryEngine instance
        const runQueryEngine = new QueryEngine(targetRunDir, process.env.OPENAI_API_KEY);
        
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

        // Create run-specific QueryEngine instance (for GPT-5.2 client + config)
        const runQueryEngine = new QueryEngine(targetRunDir, process.env.OPENAI_API_KEY);

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
          notes: `Compiled from query series (${selectedQueries.length} queries):\n` +
                 selectedQueries.map(q => 
                   `- ${q.timestamp}: ${q.query.substring(0, 80)}`
                 ).join('\n')
        });
        
        // Augment bundle with query context
        bundle.queryContext = {
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
        
        // Re-write bundle with query context
        const bundleJsonPath = path.join(runDir, 'systems', systemId, 'system_bundle.json');
        await fs.writeFile(bundleJsonPath, JSON.stringify(bundle, null, 2), 'utf-8');
        
        // Write full query records to source_queries.jsonl
        const queriesFilePath = path.join(runDir, 'systems', systemId, 'source_queries.jsonl');
        await fs.writeFile(
          queriesFilePath,
          selectedQueries.map(q => JSON.stringify(q)).join('\n') + '\n',
          'utf-8'
        );
        
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
    const statePath = path.join(this.logsDir, 'state.json');
    // Use StateCompression to handle both .gz and uncompressed files
    return await StateCompression.loadCompressed(statePath);
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

  async getDreams(limit = 100) {
    const dreams = [];
    
    try {
      // First, load full dreams from dedicated dreams.jsonl file
      const dreamsFile = path.join(this.logsDir, 'dreams.jsonl');
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
      
      const state = await this.loadState();
      
      // Dreams are stored as goals with source='dream_gpt5' or 'dream'
      if (state.goals) {
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
      if (state.memory && state.memory.nodes) {
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
      console.error('Error fetching dreams:', error);
      return {
        dreams: [],
        stats: { total: 0, fromGoals: 0, fromMemory: 0, completed: 0 },
        error: error.message
      };
    }
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

  start() {
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

          const state = await this.loadState();
          this.broadcast('stats', {
            cycleCount: state.cycleCount,
            oscillator: state.oscillator
          });
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
