#!/bin/bash
# COSMO Full Memory Network Integration Test
# Tests NEW PlanningAgent, IntegrationAgent, and full memory capabilities

set -e

echo "🧠 COSMO Full Memory Network Integration Test"
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
./CLEAN_RESTART.sh full_memory_test_$(date +%Y%m%d_%H%M%S)

echo "📝 Creating test config..."
cat > config_full_memory_test.yaml << 'EOF'
# COSMO Full Memory Network Integration Test Config
# Tests: PlanningAgent, IntegrationAgent, full memory capabilities

architecture:
  roleSystem:
    type: dynamic
    explorationMode: guided
    
    guidedFocus:
      domain: "COSMO Architecture & Memory Network Integration Test"
      context: |
        TEST DATE: October 12, 2025
        LOCATION: COSMO Repository (dynamic)
        
        MISSION: Test NEW memory integration and agents through comprehensive COSMO self-analysis
        
        ═══════════════════════════════════════════════════════════
        PHASE 1 - STRATEGIC PLANNING (PlanningAgent - NEW!)
        ═══════════════════════════════════════════════════════════
        
        COORDINATOR: Spawn PlanningAgent with mission:
        "Decompose COSMO analysis into optimal execution plan"
        
        PlanningAgent will:
        1. Use getKnowledgeDomain() to understand existing context
        2. Check hotTopics() to align with priorities
        3. Break goal into 4-6 sub-goals with dependencies
        4. Generate execution sequence
        5. Store plan in memory with tag 'mission_plan'
        
        Expected sub-goals:
        - Discover COSMO file structure (Research)
        - Read implementation code (Research)  
        - Analyze code quality metrics (Analysis + CodeExecution)
        - Synthesize findings (Synthesis)
        - Find cross-cutting patterns (Integration - NEW!)
        
        ═══════════════════════════════════════════════════════════
        PHASE 2 - FILE DISCOVERY (ResearchAgent with NEW memory)
        ═══════════════════════════════════════════════════════════
        
        Research Agent uses MCP to discover files:
        1. list_directory on: ., phase2/, phase2/agents/, phase2/core/
        2. Build inventory JSON with ALL .md and .js files
        3. Store in memory: await this.addFinding(JSON.stringify(inventory), 'file_inventory')
        4. Use exploreMemoryConnections() to find related concepts
        5. Check hotTopics() to see current focus areas
        
        NEW MEMORY FEATURES TESTED:
        - await this.exploreMemoryConnections(mission, 2) → spreading activation
        - await this.getHotTopics(5) → frequency tracking
        
        ═══════════════════════════════════════════════════════════
        PHASE 3 - CODE READING (ResearchAgent with graph traversal)
        ═══════════════════════════════════════════════════════════
        
        Research Agent reads implementation files:
        1. Read key files: base-agent.js, all *-agent.js files
        2. Store each with structural metadata
        3. Use traverseKnowledgeGraph() to explore connections
        4. Tag appropriately: 'source_code_file', 'agent_implementation'
        
        NEW MEMORY FEATURES TESTED:
        - await this.traverseKnowledgeGraph(concept, null, 2) → deep graph walk
        
        ═══════════════════════════════════════════════════════════
        PHASE 4 - DEEP ANALYSIS (AnalysisAgent with clusters)
        ═══════════════════════════════════════════════════════════
        
        Analysis Agent performs code review:
        1. Query memory for code files: queryMemoryForData(['code'], ['source_code_file'])
        2. Use getKnowledgeDomain() to understand code structure
        3. Use getKnowledgeClusters() to see knowledge landscape
        4. Analyze patterns, quality, architecture
        5. Store insights in memory
        
        NEW MEMORY FEATURES TESTED:
        - await this.getKnowledgeDomain(topic) → cluster discovery
        - await this.getKnowledgeClusters() → full landscape
        
        ═══════════════════════════════════════════════════════════
        PHASE 5 - QUANTITATIVE METRICS (CodeExecutionAgent)
        ═══════════════════════════════════════════════════════════
        
        Code Execution Agent uses memory data:
        1. Retrieve code analysis from memory (NOT filesystem!)
        2. Run Python metrics on memory data
        3. Count agents, lines, complexity
        4. Use getRecentInsights() to check recent work
        5. Store results in memory
        
        NEW MEMORY FEATURES TESTED:
        - await this.getRecentInsights(7200000) → temporal tracking
        
        ═══════════════════════════════════════════════════════════
        PHASE 6 - PATTERN DISCOVERY (IntegrationAgent - NEW!)
        ═══════════════════════════════════════════════════════════
        
        COORDINATOR: Spawn IntegrationAgent with mission:
        "Find patterns across all agent findings"
        
        IntegrationAgent will:
        1. Use getKnowledgeClusters() to map landscape
        2. Use aggregateAgentInsights() to get all agent work
        3. Find cross-cutting patterns across findings
        4. Detect contradictions
        5. Generate meta-insights about system state
        6. Store patterns, contradictions, meta-insights
        
        NEW MEMORY FEATURES TESTED:
        - await this.getKnowledgeClusters() → knowledge domains
        - await this.aggregateAgentInsights(['research', 'analysis', 'code_execution'])
        - Cross-agent pattern discovery using clusters
        
        ═══════════════════════════════════════════════════════════
        PHASE 7 - COMPREHENSIVE REPORT (SynthesisAgent)
        ═══════════════════════════════════════════════════════════
        
        Synthesis Agent creates final report:
        1. Use getKnowledgeClusters() to understand domains
        2. Use getHotTopics() to prioritize
        3. Use aggregateAgentInsights() to get recent work
        4. Query memory for all findings
        5. Generate 15-20 page report with:
           - Executive summary
           - Memory integration test results
           - Agent capabilities demonstrated
           - Patterns discovered by IntegrationAgent
           - Recommendations
        
        NEW MEMORY FEATURES TESTED:
        - Full cluster analysis for synthesis structure
        - Hot topic tracking for emphasis
        - Cross-agent aggregation for completeness
        
        ═══════════════════════════════════════════════════════════
        SUCCESS CRITERIA
        ═══════════════════════════════════════════════════════════
        
        1. PlanningAgent generates execution plan (3-6 sub-goals)
        2. All agents use NEW memory features (logs show activation, clusters, etc.)
        3. IntegrationAgent finds ≥3 patterns across agent work
        4. Final synthesis report references all phases
        5. Memory network shows 100% feature utilization
        
        EXPECTED OUTPUT: Comprehensive report + integration patterns + execution plan
        
      depth: "deep"
      intrinsicBias: 0.8
      curiosityAllowed: true
    
    initialRoles:
      - id: curiosity
        prompt: "Generate ONE novel question. Keep focused (2-4 sentences)."
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
    sleepEnabled: false  # Disable for test
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
  defaultReasoningEffort: low
  defaultMaxTokens: 6000
  enableWebSearch: false  # Disable for local test
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
  reviewCyclePeriod: 8  # Review at cycle 8, 16, 24
  model: gpt-5
  reasoningEffort: medium
  maxTokens: 6000
  maxConcurrent: 4  # Allow 4 concurrent agents
  
  qualityAssurance:
    enabled: true
    mode: 'balanced'
    minConfidence: 0.7
    autoRejectThreshold: 0.3
    checkNovelty: false  # Disable for test speed
    checkConsistency: true
    checkFactuality: false
  
  insightCuration:
    enabled: true
  
  # Agent weights - FAVOR new agents for testing
  agentTypeWeights:
    planning: 30        # NEW - Test planning agent
    integration: 30     # NEW - Test integration agent
    research: 20        # File reading + discovery
    analysis: 15        # Code review
    synthesis: 15       # Final report
    code_execution: 10  # Metrics
    exploration: 0      # Not needed for this test
    quality_assurance: 5  # Light validation
  
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
  maxCycles: 25  # 25 cycles for comprehensive test with planning + integration
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

echo "✅ Test config created: config_full_memory_test.yaml"

echo "📝 Installing test config..."
cp config_full_memory_test.yaml src/config.yaml
echo "✅ Config installed"

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "🚀 STARTING COSMO - FULL MEMORY NETWORK INTEGRATION TEST"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "TEST PARAMETERS:"
echo "  📊 Cycles: 25 (enough for Planning → Execute → Integration)"
echo "  👥 Max Concurrent: 4 agents"
echo "  🎯 Coordinator Reviews: Cycle 8, 16, 24"
echo "  🧠 Memory Features: 100% (spreading activation, clusters, temporal, graph)"
echo ""
echo "AGENT ROSTER (8 total):"
echo "  ✨ PlanningAgent (NEW) - Weight: 30 (HIGH)"
echo "  ✨ IntegrationAgent (NEW) - Weight: 30 (HIGH)"
echo "  📚 ResearchAgent (enhanced) - Weight: 20"
echo "  🔬 AnalysisAgent (enhanced) - Weight: 15"
echo "  📝 SynthesisAgent (enhanced) - Weight: 15"
echo "  💻 CodeExecutionAgent (enhanced) - Weight: 10"
echo "  🔍 QualityAssuranceAgent - Weight: 5"
echo "  🌀 ExplorationAgent (enhanced) - Weight: 0 (disabled for test)"
echo ""
echo "EXPECTED WORKFLOW:"
echo "  Phase 1 (Cycles 1-8): Planning + File Discovery"
echo "    → Coordinator spawns PlanningAgent"
echo "    → Planning creates execution plan with sub-goals"
echo "    → Research scans filesystem, stores inventory"
echo "    → Memory features: spreading activation, hot topics"
echo ""
echo "  Phase 2 (Cycles 9-16): Execution + Analysis"
echo "    → Research reads code files"
echo "    → Analysis reviews code quality"
echo "    → CodeExecution runs metrics"
echo "    → Memory features: clusters, graph traversal, temporal"
echo ""
echo "  Phase 3 (Cycles 17-25): Integration + Synthesis"
echo "    → IntegrationAgent finds patterns across findings"
echo "    → IntegrationAgent detects contradictions"
echo "    → Synthesis creates comprehensive report"
echo "    → Memory features: cross-agent aggregation, cluster analysis"
echo ""
echo "EXPECTED OUTPUTS:"
echo "  📄 Execution plan (from PlanningAgent)"
echo "  📊 Code quality analysis"
echo "  🔗 Cross-agent patterns (≥3 from IntegrationAgent)"
echo "  📚 Final synthesis report (15-20 pages)"
echo "  🗺️  Knowledge landscape map"
echo ""
echo "LOGS TO WATCH:"
echo "  phase2_logs/agents/planning-*.json       ← PlanningAgent execution"
echo "  phase2_logs/agents/integration-*.json    ← IntegrationAgent patterns"
echo "  phase2_logs/agents/synthesis-*.json      ← Final report"
echo "  phase2_logs/coordinator/review_cycle_*.json ← Agent dispatch decisions"
echo ""
echo "MEMORY FEATURES YOU'LL SEE IN LOGS:"
echo "  🔗 \"Spreading activation discovered X concepts\""
echo "  🗺️  \"Knowledge clusters: X clusters\""
echo "  🔥 \"Hot topics in memory: [concepts]\""
echo "  🕸️  \"Knowledge graph traversed: X nodes\""
echo "  ⏱️  \"Recent activity: X nodes\""
echo "  🤝 \"Recent agent insights: research=X, analysis=Y\""
echo ""
echo "DASHBOARD: http://localhost:3334"
echo "MCP Server: http://localhost:3335 (brain access)"
echo "MCP Filesystem: http://localhost:3337 (file access)"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "                      STARTING IN 3 SECONDS..."
echo "═══════════════════════════════════════════════════════════════"
echo ""
sleep 3

cd src
node --expose-gc index.js

echo ""
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "                       TEST COMPLETE ✅"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "CHECK RESULTS:"
echo "  cd src_logs/agents"
echo "  ls -lt planning-*.json       # PlanningAgent output"
echo "  ls -lt integration-*.json    # IntegrationAgent patterns"
echo "  ls -lt synthesis-*.json      # Final report"
echo ""
echo "VERIFY MEMORY FEATURES:"
echo "  grep -r \"spreading activation\" phase2_logs/"
echo "  grep -r \"Knowledge clusters\" phase2_logs/"
echo "  grep -r \"Hot topics\" phase2_logs/"
echo "  grep -r \"graph traversed\" phase2_logs/"
echo ""
echo "VIEW REPORTS:"
echo "  # Latest synthesis report with full analysis"
echo "  find phase2_logs -name '*synthesis*' -type f | tail -1 | xargs cat"
echo ""
echo "═══════════════════════════════════════════════════════════════"


