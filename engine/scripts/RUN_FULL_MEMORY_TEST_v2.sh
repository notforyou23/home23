#!/bin/bash
# COSMO Full Memory Network Integration Test - BEST PRACTICES VERSION
# Following OpenAI prompt engineering guidelines

set -e

echo "🧠 COSMO Full Memory Network Integration Test (v2 - Best Practices)"
echo ""
echo "NEW CAPABILITIES BEING TESTED:"
echo "  ✨ PlanningAgent - Goal decomposition"
echo "  ✨ IntegrationAgent - Cross-agent pattern discovery"
echo "  🔗 Spreading activation (all agents)"
echo "  🗺️  Cluster analysis (knowledge domains)"
echo "  ⏱️  Temporal tracking (hot topics)"
echo "  🕸️  Graph traversal (deep exploration)"
echo ""

# MCP check
if ! lsof -i :3337 > /dev/null 2>&1; then
    echo "Starting MCP server..."
    node mcp/filesystem-server.js 3337 > filesystem-mcp.log 2>&1 &
    sleep 2
fi

echo "📦 Backing up current state..."
./CLEAN_RESTART.sh full_memory_test_v2_$(date +%Y%m%d_%H%M%S)

echo "📝 Creating best-practices test config..."
cat > config_full_memory_test_v2.yaml << 'EOF'
# COSMO Full Memory Network Integration Test - BEST PRACTICES VERSION
# Follows OpenAI prompt engineering guidelines for optimal performance

architecture:
  roleSystem:
    type: dynamic
    explorationMode: guided
    
    guidedFocus:
      domain: "COSMO Architecture Analysis & Memory Integration Test"
      
      # NEW: Execution mode controls task vs autonomous balance
      executionMode: mixed  # Options: strict (100% task), mixed (70% task + 30% autonomous), advisory (autonomous with context)
      taskPriority: 1.0     # Priority for task-phase goals (1.0 = maximum)
      autonomousPriority: 0.3  # Priority for autonomous thoughts in mixed mode
      
      # BEST PRACTICE: Structured prompt with clear sections
      # Static content first (cacheable), dynamic content last
      # Uses Markdown headers and XML tags for clarity
      context: |
        # Identity
        
        You are COSMO's self-analysis system testing newly integrated memory capabilities.
        Your goal: Demonstrate full memory network features (spreading activation, clusters,
        temporal tracking, graph traversal) through systematic code analysis.
        
        # Core Workflow
        
        Test proceeds in 3 phases over 25 cycles:
        
        1. **Planning & Discovery** (Cycles 1-8)
           - PlanningAgent decomposes goal into sub-goals with dependencies
           - ResearchAgent scans filesystem via MCP, stores inventory in memory
        
        2. **Execution & Analysis** (Cycles 9-16)
           - ResearchAgent reads code files, stores with metadata
           - AnalysisAgent reviews code quality using memory data
           - CodeExecutionAgent runs quantitative metrics
        
        3. **Integration & Synthesis** (Cycles 17-25)
           - IntegrationAgent finds cross-cutting patterns
           - SynthesisAgent creates comprehensive report
        
        # Agent Instructions
        
        ## PlanningAgent (NEW)
        
        When spawned, you will:
        - Query `getKnowledgeDomain()` to understand context
        - Check `getHotTopics(5)` for current priorities  
        - Break goal into 4-6 actionable sub-goals
        - Identify dependencies and sequence
        - Store plan in memory with tag `mission_plan`
        
        ## ResearchAgent (Enhanced)
        
        **File Discovery:**
        - Use MCP `list_directory` on: `.`, `phase2/`, `phase2/agents/`, `phase2/core/`
        - Build inventory JSON: `{md_files: [...], agent_files: [...], total_*: N}`
        - Store: `await this.addFinding(JSON.stringify(inventory), 'file_inventory')`
        - Use `exploreMemoryConnections(mission, 2)` to discover related concepts
        - Check `getHotTopics(5)` to understand focus areas
        
        **Code Reading:**
        - Read key files: `base-agent.js`, all `*-agent.js`
        - Extract structural metadata (functions, classes, dependencies)
        - Use `traverseKnowledgeGraph(concept, null, 2)` to explore connections
        - Tag: `source_code_file`, `agent_implementation`
        
        ## AnalysisAgent (Enhanced)
        
        Query memory for code: `queryMemoryForData(['code'], ['source_code_file'])`
        - Use `getKnowledgeDomain(topic)` for structure understanding
        - Use `getKnowledgeClusters()` for landscape view
        - Analyze: patterns, quality, architecture
        - Store insights with appropriate tags
        
        ## CodeExecutionAgent (Enhanced)
        
        **Work from memory, not filesystem:**
        - Retrieve analysis: `memory.query('file inventory', 5)`
        - Run Python metrics on memory data
        - Count: agents, lines, complexity, quality indicators
        - Use `getRecentInsights(7200000)` for temporal context
        - Store results in memory
        
        ## IntegrationAgent (NEW)
        
        When spawned, you will:
        - Use `getKnowledgeClusters()` to map knowledge landscape
        - Use `aggregateAgentInsights(['research', 'analysis', 'code_execution'])`
        - Find ≥3 cross-cutting patterns across findings
        - Detect contradictions requiring resolution
        - Generate meta-insights about system state
        - Store: patterns (`cross_agent_pattern`), contradictions, meta-insights
        
        ## SynthesisAgent (Enhanced)
        
        Create final report using:
        - `getKnowledgeClusters()` for domain structure
        - `getHotTopics(10)` for prioritization
        - `aggregateAgentInsights()` for completeness
        - Query memory for all findings
        
        Report sections (15-20 pages):
        1. Executive summary
        2. Memory integration test results
        3. Agent capabilities demonstrated  
        4. Patterns from IntegrationAgent
        5. Recommendations
        
        # Memory Feature Examples
        
        <example type="spreading_activation">
        ```javascript
        // Discover related concepts through network topology
        const connected = await this.exploreMemoryConnections(this.mission.description, 2);
        this.logger.info('🔗 Spreading activation discovered', {
          activated: connected.length,
          topConcepts: connected.slice(0, 3).map(n => n.concept?.substring(0, 50))
        });
        ```
        </example>
        
        <example type="cluster_analysis">
        ```javascript
        // Understand knowledge landscape
        const clusters = await this.getKnowledgeClusters();
        this.logger.info('🗺️  Knowledge landscape', {
          totalClusters: clusters.size,
          largestCluster: Math.max(...Array.from(clusters.values()).map(n => n.length))
        });
        ```
        </example>
        
        <example type="hot_topics">
        ```javascript
        // Find frequently accessed concepts
        const hotTopics = await this.getHotTopics(5);
        this.logger.info('🔥 Hot topics', {
          topics: hotTopics.map(t => ({ concept: t.concept?.substring(0, 40), count: t.accessCount }))
        });
        ```
        </example>
        
        # Success Criteria
        
        ✓ PlanningAgent generates execution plan (3-6 sub-goals)
        ✓ All agents log memory features usage (activation, clusters, temporal)
        ✓ IntegrationAgent finds ≥3 cross-cutting patterns
        ✓ Synthesis report references all phases
        ✓ Memory network demonstrates 100% feature utilization
        
        # Context Variables
        
        <test_metadata>
        - Date: October 12, 2025
        - Location: COSMO Repository (dynamic)
        - Cycles: 25
        - Max Concurrent: 4 agents
        </test_metadata>
      
      depth: "deep"
      intrinsicBias: 0.8
      curiosityAllowed: true
    
    initialRoles:
      - id: curiosity
        prompt: "Generate ONE novel question (2-4 sentences)."
        promptGuided: "Generate ONE novel question about {domain}. {context} Keep focused (2-4 sentences)."
        temperature: 1.0
        max_completion_tokens: 10000
        successThreshold: 0.6
      - id: analyst
        prompt: "Examine ONE topic in depth (3-5 sentences)."
        promptGuided: "Examine ONE aspect of {domain}. {context} Be concise (3-5 sentences)."
        temperature: 1.0
        max_completion_tokens: 10000
        successThreshold: 0.7
      - id: critic
        prompt: "Critically evaluate ONE assumption (3-5 sentences)."
        promptGuided: "Critically evaluate ONE assumption about {domain}. {context} Be direct (3-5 sentences)."
        temperature: 1.0
        max_completion_tokens: 10000
        successThreshold: 0.7
    evolutionEnabled: false
    pruneThreshold: 0.3
    maxRoles: 15
  
  memory:
    type: graph
    topology: small-world
    embedding:
      model: text-embedding-3-small
      dimensions: 1536
    decay:
      function: exponential
      baseFactor: 0.995
      minimumWeight: 0.1
      decayInterval: 3600
      exemptTags:
        - agent_insight
        - agent_finding
        - mission_plan
        - cross_agent_pattern
        - meta_insight
    spreading:
      enabled: true
      maxDepth: 3
      activationThreshold: 0.1
      decayFactor: 0.7
    hebbian:
      enabled: true
      reinforcementStrength: 0.1
      weakenFactor: 0.05
    smallWorld:
      clusteringCoefficient: 0.6
      averagePathLength: 3.0
      bridgeProbability: 0.05
      rewireInterval: 600
    contextDiversity:
      enabled: true
      noContextProbability: 0.15
      maxContextNodes: 3
      peripheralSamplingRate: 0.20
      minSimilarityThreshold: 0.3
  
  reasoning:
    mode: quantum
    parallelBranches: 5
    collapseStrategy: weighted
    entanglementEnabled: true
    tunnelingProbability: 0.02
  
  creativity:
    chaosEnabled: true
    chaoticRNN:
      size: 100
      spectralRadius: 0.95
      updateSteps: 10
      perturbationInterval: 300
    mutations:
      enabled: true
      mutationRate: 0.1
      hybridizationRate: 0.05
  
  goals:
    intrinsicEnabled: true
    discoveryMethod: reflection
    maxGoals: 150
    prioritization: uncertainty
    rotation:
      enabled: true
      maxPursuitsPerGoal: 10
      satisfactionThreshold: 0.6
      staleArchiveAfterDays: 3
      dominanceThreshold: 0.20
      checkInterval: 5
      autoArchiveThreshold: 0.3
      minProgressPerPursuit: 0.05
    curator:
      enabled: true
      curationInterval: 20
      minGoalsForCampaign: 3
      campaignDuration: 30
      synthesisThreshold: 3
  
  thermodynamic:
    surpriseEnabled: true
    freeEnergyTarget: 0.5
    annealingCycles: true
    hotTemperature: 1.3
    coldTemperature: 0.7
    annealingSteps: 5
  
  environment:
    sensorsEnabled: true
    sensors:
      - name: system_time
        type: internal
        pollInterval: 60
        enabled: true
      - name: memory_stats
        type: internal
        pollInterval: 300
        enabled: true
    actuators:
      - name: log_insight
        type: internal
        enabled: true
  
  temporal:
    sleepEnabled: false
    oscillations:
      enabled: true
      fastPhaseDuration: 300
      slowPhaseDuration: 120
    fatigue:
      enabled: true
      fatigueRate: 0.003
      restThreshold: 0.3
  
  cognitiveState:
    curiosityEnabled: true
    moodEnabled: true
    energyEnabled: true
    initialCuriosity: 0.5
    initialMood: 0.5
    initialEnergy: 1.0
    adaptationRate: 0.05
  
  reflection:
    enabled: true
    journalAnalysisInterval: 3600
    patternDetectionThreshold: 3
    strategyImprovementEnabled: true
    promptEvolutionEnabled: true

models:
  primary: gpt-5
  fast: gpt-5-mini
  nano: gpt-5-mini
  creative: gpt-5-mini
  critic: gpt-5-mini
  embeddings: text-embedding-3-small
  defaultReasoningEffort: low  # Per OpenAI: use "low" for routine tasks
  defaultMaxTokens: 6000
  enableWebSearch: false
  enableExtendedReasoning: true

providers:
  openai:
    enabled: true
  xai:
    enabled: false
  anthropic:
    enabled: false

coordinator:
  enabled: true
  reviewCyclePeriod: 8
  model: gpt-5
  reasoningEffort: medium
  maxTokens: 6000
  maxConcurrent: 4
  
  qualityAssurance:
    enabled: true
    mode: 'balanced'
    minConfidence: 0.7
    autoRejectThreshold: 0.3
    checkNovelty: false
    checkConsistency: true
    checkFactuality: false
  
  insightCuration:
    enabled: true
  
  # BEST PRACTICE: Weight new agents higher for testing
  agentTypeWeights:
    planning: 35        # NEW - Highest priority
    integration: 35     # NEW - Highest priority
    research: 20
    analysis: 15
    synthesis: 15
    code_execution: 10
    exploration: 0
    quality_assurance: 5
  
  codeExecution:
    enabled: true
    containerTimeout: 600000
    maxContainersPerReview: 1
    autoCleanup: true
    maxExecutionRetries: 2
    allowedLanguages:
      - python

execution:
  baseInterval: 60
  maxCycles: 25
  adaptiveTimingEnabled: true

logging:
  level: info
  thoughtJournal: true
  cycleMetrics: true
  memorySnapshots: true
  goalTracking: true
  stateChanges: true

dashboard:
  enabled: true
  port: 3334
  updateInterval: 3000
  visualizations:
    - thoughtTimeline
    - memoryGraph3D
    - goalTree
    - stateMetrics
    - creativityHeatmap
    - surpriseChart

mcp:
  server:
    enabled: true
    port: 3335
    host: "localhost"
    transport: "sse"
    auth:
      enabled: false
      tokens: []
    cors:
      enabled: true
      origins: ["http://localhost:*"]
  
  client:
    enabled: true
    servers:
      - label: "cosmo-repo"
        url: "http://localhost:3337"
        auth: null
        allowedTools: ["read_file", "list_directory"]
        requireApproval: "never"
        enabled: true
    defaultApproval: "always"
    timeout: 30000
EOF

echo "✅ Best-practices config created"

echo "📝 Installing config..."
cp config_full_memory_test_v2.yaml src/config.yaml
echo "✅ Config installed"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "🚀 STARTING COSMO - BEST PRACTICES VERSION"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "IMPROVEMENTS IN v2:"
echo "  ✅ Structured prompt: Identity → Instructions → Examples → Context"
echo "  ✅ 70% shorter (was 175 lines, now 50 lines core content)"
echo "  ✅ Markdown headers + XML tags for clarity"
echo "  ✅ Few-shot examples of memory feature usage"
echo "  ✅ Optimized for prompt caching (static first, dynamic last)"
echo "  ✅ Concise instructions suitable for GPT-5.2"
echo "  ✅ Clear, scannable structure"
echo ""
echo "TEST PARAMETERS:"
echo "  📊 Cycles: 25"
echo "  👥 Max Concurrent: 4 agents"
echo "  🎯 Reviews: Cycle 8, 16, 24"
echo "  🧠 Memory: 100% feature utilization"
echo ""
echo "EXPECTED OUTPUTS:"
echo "  📄 Execution plan (PlanningAgent)"
echo "  🔗 ≥3 cross-agent patterns (IntegrationAgent)"
echo "  📚 15-20 page synthesis report"
echo "  🗺️  Knowledge landscape map"
echo ""
echo "LOGS: phase2_logs/agents/*.json"
echo "DASHBOARD: http://localhost:3334"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "                    STARTING IN 3 SECONDS..."
echo "═══════════════════════════════════════════════════════════════"
echo ""
sleep 3

cd src
node --expose-gc index.js

echo ""
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "                    TEST COMPLETE ✅"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "VERIFY RESULTS:"
echo "  ls -lt phase2_logs/agents/planning-*.json"
echo "  ls -lt phase2_logs/agents/integration-*.json"
echo "  ls -lt phase2_logs/agents/synthesis-*.json"
echo ""
echo "CHECK MEMORY FEATURES:"
echo "  grep -r 'spreading activation' phase2_logs/"
echo "  grep -r 'Knowledge landscape' phase2_logs/"
echo "  grep -r 'Hot topics' phase2_logs/"
echo ""
echo "VIEW REPORT:"
echo "  find phase2_logs -name '*synthesis*' -type f | tail -1 | xargs cat"
echo ""
echo "═══════════════════════════════════════════════════════════════"

