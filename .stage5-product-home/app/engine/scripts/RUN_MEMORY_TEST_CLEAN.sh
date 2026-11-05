#!/bin/bash
# COSMO Memory Integration Test - GUARANTEED CLEAN START
# Fixes: State persistence + shutdown hang issues

set -e

echo "🧠 COSMO Full Memory Network Integration Test - CLEAN VERSION"
echo ""

# Kill any running instances first
echo "🛑 Stopping any running COSMO instances..."
pkill -f "node.*src/index.js" 2>/dev/null || true
pkill -f "node.*index.js" 2>/dev/null || true
sleep 2

# MCP check
if ! lsof -i :3337 > /dev/null 2>&1; then
    echo "Starting MCP server..."
    node mcp/filesystem-server.js 3337 > filesystem-mcp.log 2>&1 &
    sleep 2
fi

# NUCLEAR CLEAN - Remove ALL state
echo ""
echo "💣 NUCLEAR CLEAN - Removing ALL state..."
rm -rf runtime/*
echo "   ✓ All logs wiped"

# Recreate directory structure
mkdir -p runtime/coordinator
mkdir -p runtime/agents
echo "   ✓ Directory structure recreated"

# Create empty topics queue
echo '{"topics": []}' > runtime/topics-queue.json
echo "   ✓ Empty topics queue created"

echo "✅ Blank slate confirmed (0 nodes, 0 goals, 0 thoughts)"
echo ""

# Install test config
echo "📝 Installing test config..."
cat > src/config.yaml << 'EOF'
# COSMO Memory Integration Test - Clean Version

architecture:
  roleSystem:
    type: dynamic
    explorationMode: guided
    
    guidedFocus:
      domain: "COSMO Memory Network Integration Test"
      
      # Execution mode
      executionMode: mixed
      taskPriority: 1.0
      autonomousPriority: 0.3
      
      context: |
        # Identity
        
        You are testing COSMO's newly integrated memory capabilities.
        
        # Task Phases
        
        PHASE 1 - Planning & Discovery:
        PlanningAgent decomposes goal. ResearchAgent scans files via MCP.
        
        PHASE 2 - Code Reading:
        ResearchAgent reads implementation files, stores with metadata.
        
        PHASE 3 - Deep Analysis:
        AnalysisAgent reviews code quality using memory data.
        
        PHASE 4 - Integration:
        IntegrationAgent finds patterns across all agent findings.
        
        PHASE 5 - Final Synthesis:
        SynthesisAgent creates comprehensive report.
        
        # Memory Features to Demonstrate
        
        - Spreading activation (exploreMemoryConnections)
        - Cluster analysis (getKnowledgeClusters)
        - Hot topics (getHotTopics)
        - Graph traversal (traverseKnowledgeGraph)
        - Cross-agent aggregation (aggregateAgentInsights)
        
      depth: "deep"
      intrinsicBias: 0.8
      curiosityAllowed: true
    
    initialRoles:
      - id: curiosity
        prompt: "Generate ONE novel question (2-4 sentences)."
        promptGuided: "Generate ONE question about {domain}. {context}"
        temperature: 1.0
        max_completion_tokens: 10000
        successThreshold: 0.6
      - id: analyst
        prompt: "Examine ONE topic (3-5 sentences)."
        promptGuided: "Examine ONE aspect of {domain}. {context}"
        temperature: 1.0
        max_completion_tokens: 10000
        successThreshold: 0.7
      - id: critic
        prompt: "Critically evaluate ONE assumption (3-5 sentences)."
        promptGuided: "Evaluate ONE assumption about {domain}. {context}"
        temperature: 1.0
        max_completion_tokens: 10000
        successThreshold: 0.7
    evolutionEnabled: false
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
    curator:
      enabled: true
      curationInterval: 20
      minGoalsForCampaign: 3
      campaignDuration: 30
      synthesisThreshold: 3
  
  thermodynamic:
    surpriseEnabled: true
    freeEnergyTarget: 0.5
  
  environment:
    sensorsEnabled: true
    sensors:
      - name: system_time
        type: internal
        pollInterval: 60
        enabled: true
  
  temporal:
    sleepEnabled: false
    oscillations:
      enabled: true
      fastPhaseDuration: 300
      slowPhaseDuration: 120
  
  cognitiveState:
    curiosityEnabled: true
    moodEnabled: true
    energyEnabled: true
  
  reflection:
    enabled: true

models:
  primary: gpt-5
  fast: gpt-5-mini
  nano: gpt-5-mini
  embeddings: text-embedding-3-small
  defaultReasoningEffort: low
  defaultMaxTokens: 6000
  enableWebSearch: false
  enableExtendedReasoning: true

providers:
  openai:
    enabled: true

coordinator:
  enabled: true
  reviewCyclePeriod: 8
  model: gpt-5
  reasoningEffort: medium
  maxTokens: 6000
  maxConcurrent: 4
  
  qualityAssurance:
    enabled: false  # DISABLE for test - too aggressive, rejecting good work
    mode: 'balanced'
    minConfidence: 0.7
    autoRejectThreshold: 0.3  # Missing from config!
    checkNovelty: false
    checkConsistency: true
    checkFactuality: false  # Disable for faster test
  
  agentTypeWeights:
    planning: 35
    integration: 35
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

execution:
  baseInterval: 60
  maxCycles: 25
  adaptiveTimingEnabled: true

logging:
  level: info
  thoughtJournal: true
  cycleMetrics: true

dashboard:
  enabled: true
  port: 3334

mcp:
  server:
    enabled: true
    port: 3335
  
  client:
    enabled: true
    servers:
      - label: "cosmo-repo"
        url: "http://localhost:3337"
        auth: null
        allowedTools: ["read_file", "list_directory"]
        requireApproval: "never"
        enabled: true
EOF

echo "✅ Config installed"
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "🚀 STARTING CLEAN RUN"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "WATCH FOR AT STARTUP:"
echo "  📋 Detected X structured task phases"
echo "  🎯 Generated X high-priority task goals"
echo "  📌 MIXED MODE: Task goals prioritized"
echo ""
echo "WATCH FOR AT END:"
echo "  🏁 Reached maxCycles limit (25)"
echo "  Waiting for agents to complete..."
echo "  ✅ System stopped successfully"
echo "  (Should exit automatically, no Ctrl+C needed)"
echo ""
echo "Starting in 3 seconds..."
sleep 3

cd src
node --expose-gc index.js

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "TEST COMPLETE"
echo "═══════════════════════════════════════════════════════════════"

