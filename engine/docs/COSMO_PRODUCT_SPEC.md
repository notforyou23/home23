# COSMO Product Specification v2.0

**Document Purpose:** Complete technical specification for transforming COSMO from a research system into a consumer-grade autonomous AI product comparable to Manus.

**Last Updated:** December 30, 2024
**Status:** AUTHORITATIVE SPEC - Use this document for all implementation decisions

**Implementation Status:** Phases 1-5 and 8 COMPLETE. Unified Platform with native Explore mode and embedded IDE operational.

---

## Executive Summary

COSMO is a **complete cognitive architecture** for autonomous AI research. Unlike typical AI agents that execute tasks and forget, COSMO builds persistent knowledge that compounds over time. It has 19 implemented cognitive subsystems including sleep/dream cycles, Hebbian learning, spreading activation, and multi-agent coordination.

**The Gap:** COSMO's engine is sophisticated. What's missing is the **consumer packaging**:
- Real-time "watch it work" interface
- One-click launch experience
- Cloud hosting
- The viral demo

**The Goal:** Create a Manus-like product experience that showcases COSMO's unique capabilities.

**The Insight:** COSMO2 (engine) + Brain Studio (interface) = complete product.

---

## 1.5 Strategic Product Vision

### The Job To Be Done

> "I want to understand {complex topic} deeply, have an expert to discuss it with, and tools to act on that knowledge."

**Current alternatives fail because:**
- ChatGPT: No persistent memory, forgets context, can't do deep research
- Perplexity: Surface-level, no compound learning, no action capability
- Manus: Good at tasks, but no knowledge accumulation
- Human researchers: Expensive, slow, don't scale

### The COSMO Value Proposition

> "COSMO researches for hours, then gives you an AI expert you can actually work with."

**The flow:**
1. **Launch** - "Research cold water immersion protocols"
2. **Watch** - See COSMO think, explore, synthesize (the "holy shit" moment)
3. **Studio** - Query the brain, explore the graph, create documents with Agent IDE

### What You're Really Buying

| Tier | What You Get | Price |
|------|--------------|-------|
| **Free** | 1 brain, 30 cycles, basic queries | $0 |
| **Pro** | Unlimited brains, 300 cycles, all Query modes, Agent IDE | $29/mo |
| **Team** | Shared brains, collaboration, API access | $99/mo |

### The Defensible Moat

1. **Cognitive architecture** - 19 subsystems (sleep, dreams, Hebbian learning, spreading activation) that competitors would need years to replicate
2. **Compound brains** - Knowledge that grows over time, merges, and compounds
3. **Brain Studio** - Query + Explore + Agent IDE - three products in one
4. **The experience** - Watching COSMO think is captivating in a way RAG pipelines aren't

### The Two Halves of the Product

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│   COSMO2 (Engine)              Brain Studio (Interface)         │
│   ─────────────────            ───────────────────────          │
│                                                                 │
│   • Autonomous research        • Query Tab (9 modes)            │
│   • 14+ specialized agents     • Explore Tab (D3 graph)         │
│   • Sleep/dream cycles         • Agent IDE (17+ tools)          │
│   • Hebbian learning           • Editor with diff viewer        │
│   • Memory consolidation       • Document generation            │
│   • Knowledge graphs                                            │
│                                                                 │
│              │                           │                      │
│              └───────────┬───────────────┘                      │
│                          │                                      │
│                          ▼                                      │
│                                                                 │
│              ┌─────────────────────┐                            │
│              │   Unified Platform  │                            │
│              │   ─────────────────  │                            │
│              │   Launch → Watch    │                            │
│              │        ↓            │                            │
│              │      Studio         │                            │
│              └─────────────────────┘                            │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Why This Wins

1. **The Watch Panel creates viral moments** - People share "look what my AI is thinking"
2. **Brain Studio creates stickiness** - Once you have a brain, you keep using it
3. **Compound value over time** - Second project benefits from first
4. **Multiple revenue streams** - Subscriptions + API + enterprise

### Critical Path to Launch

1. ✅ **Event streaming** - Real-time visibility into COSMO
2. ✅ **Watch Panel** - The "holy shit" experience
3. ✅ **Unified wrapper** - Single app combining both systems (COSMO_Unified)
4. ✅ **Brain handoff** - Seamless transition to Explore (prompt on completion)
5. ✅ **Native Explore mode** - Graph, query, chat without iframes/new windows
6. ⬜ **Research brief** - Tangible output from research
7. ✅ **Workspace mode** - Embedded IDE within unified shell (iframe approach)
8. ⬜ **Cloud deployment** - Accessible without self-hosting
9. ⬜ **Auth + payments** - Monetizable

**Current State (Dec 30, 2024):**
- Unified Platform fully operational at `http://localhost:3000`
- Single `npm start` launches everything
- **Four integrated modes:** Launch → Watch → Explore → IDE
- **Native Explore mode with:**
  - D3.js knowledge graph visualization
  - Query interface with 9 reasoning modes
  - Chat panel for conversational interaction
  - Output file browser
  - Brain data API (reads state.json.gz directly)
- **Embedded IDE mode with:**
  - Brain Studio Agent IDE in iframe
  - Light theme matching unified platform
  - Single "Agent IDE" tab (redundant tabs hidden)
  - Full file tree and Monaco editor
  - 17+ AI tools available
- Full configuration parity with existing launcher
- Clean start mechanism prevents run cross-contamination
- Consistent light theme throughout all modes

---

## Table of Contents

1. [What COSMO Actually Is](#1-what-cosmo-actually-is)
1.5. [Strategic Product Vision](#15-strategic-product-vision) ⭐ NEW
2. [Existing Cognitive Architecture](#2-existing-cognitive-architecture)
3. [The Watch Panel Specification](#3-the-watch-panel-specification)
4. [Unified App Architecture](#4-unified-app-architecture) ⭐ UPDATED
5. [Implementation Phases](#5-implementation-phases) ⭐ UPDATED
6. [Technical Requirements](#6-technical-requirements)
7. [File Inventory](#7-file-inventory) ⭐ UPDATED
8. [Success Criteria](#8-success-criteria)

---

## 1. What COSMO Actually Is

### 1.1 Core Identity

COSMO is an **Autonomous AI Research System** that:
- Runs continuous research cycles (hours/days/weeks)
- Spawns 14+ specialized agents (research, analysis, synthesis, code, documents)
- Builds persistent knowledge graphs ("brains") that compound over time
- Self-coordinates via an executive meta-cognitive layer
- Sleeps, dreams, and consolidates memories
- Tracks provenance of all knowledge
- Can merge multiple brains into unified knowledge bases

### 1.2 What Makes COSMO Different from Manus

| Aspect | Manus | COSMO |
|--------|-------|-------|
| **Model** | Task executor | Knowledge accumulator |
| **Memory** | Session-based, forgets | Persistent brains, compounds |
| **Output** | Deliverable (done) | Brain + deliverable (continues) |
| **Learning** | None | Hebbian, consolidation, dreaming |
| **Coordination** | Single agent loop | 14+ specialized agents + meta-coordinator |
| **Provenance** | None | Full audit trail, lineage tracking |
| **Composability** | None | Merge, fork, share brains |

### 1.3 The Unique Value Proposition

> "Autonomous AI research that remembers everything and gets smarter over time."

COSMO doesn't just complete tasks - it builds institutional memory. Your second research project benefits from the first. Teams can merge brains. Knowledge compounds.

---

## 2. Existing Cognitive Architecture

### 2.1 Complete Feature Inventory

All features below are **IMPLEMENTED AND FUNCTIONAL** in the current codebase.

#### Core Cognitive Loop

| Feature | File(s) | Description |
|---------|---------|-------------|
| **Orchestrator** | `src/core/orchestrator.js` | Main cognitive cycle - polls queues, updates rhythms, processes results, spawns agents, integrates memory |
| **Oscillator** | `src/temporal/oscillator.js` | Focus/Explore/Execute mode switching with adaptive timing |
| **State Modulator** | `src/cognition/state-modulator.js` | Curiosity, mood, energy, cognitive mode management |
| **Thermodynamic** | `src/cognition/thermodynamic.js` | Free-energy principle, entropy tracking, system temperature |

#### Memory System

| Feature | File(s) | Description |
|---------|---------|-------------|
| **Network Memory** | `src/memory/network-memory.js` | Node-edge graph with embeddings, spreading activation, small-world topology |
| **Hebbian Learning** | `src/memory/network-memory.js` | "Fire together, wire together" - edge weight reinforcement |
| **Spreading Activation** | `src/memory/network-memory.js` | BFS activation propagation with decay and thresholds |
| **Memory Consolidation** | `src/cluster/memory-merger.js` | CRDT-based merging, differential sync |
| **Summarizer** | `src/memory/summarizer.js` | Memory compression and summarization |

#### Sleep & Dreams

| Feature | File(s) | Description |
|---------|---------|-------------|
| **Temporal Rhythms** | `src/temporal/rhythms.js` | Sleep triggers (cycle-based, energy, fatigue), wake management |
| **Dream Rewiring** | `src/memory/network-memory.js` | Watts-Strogatz small-world rewiring during dreams |
| **Fatigue System** | `src/temporal/rhythms.js` | Activity-based fatigue accumulation, recovery during sleep |

#### Reasoning & Creativity

| Feature | File(s) | Description |
|---------|---------|-------------|
| **Quantum Reasoner** | `src/cognition/quantum-reasoner.js` | Parallel hypothesis branches with independent web search |
| **Branch Policy** | `src/cognition/branch-policy.js` | Intelligent allocation of reasoning effort across branches |
| **Trajectory Forking** | `src/cognition/trajectory-fork.js` | Decision tree reasoning with backtracking |
| **Chaotic Creativity** | `src/creativity/chaotic-engine.js` | RNN at edge of chaos for novelty generation |
| **Latent Projector** | `src/cognition/latent-projector.js` | Auto-trained context compression, hint generation |

#### Agents & Coordination

| Feature | File(s) | Description |
|---------|---------|-------------|
| **Agent Executor** | `src/agents/agent-executor.js` | Spawning, lifecycle, concurrency management |
| **Meta-Coordinator** | `src/coordinator/meta-coordinator.js` | Strategic oversight, mission planning, periodic reviews |
| **Strategic Goals** | `src/coordinator/strategic-goals-tracker.js` | Goal progress monitoring, execution loop closure |
| **Dynamic Roles** | `src/cognition/dynamic-roles.js` | Context-aware role system with GPT-5.2 integration |
| **14+ Agent Types** | `src/agents/*.js` | Research, Analysis, Synthesis, Code Creation, Code Execution, Document Creation, Document Compilation, Exploration, Planning, QA, Integration, Completion, Experimental |

#### Governance & Provenance

| Feature | File(s) | Description |
|---------|---------|-------------|
| **Frontier Gate** | `src/frontier/frontier-gate.js` | 3-mode governance (observe/soft/hard), artifact classification |
| **Provenance** | `src/merge/provenance.js` | Full audit trail, merge history, lineage depth |
| **Novelty Validator** | `src/dashboard/novelty-validator.js` | 4-test framework for insight validation |

#### Self-Awareness

| Feature | File(s) | Description |
|---------|---------|-------------|
| **Introspection** | `src/system/introspection.js` | Scans own outputs, creates memory nodes |
| **Introspection Router** | `src/system/introspection-router.js` | Routes discoveries to appropriate handlers |
| **Reflection Analyzer** | `src/reflection/analyzer.js` | GPT-5.2 meta-analysis of thought journals |

#### Knowledge Synthesis

| Feature | File(s) | Description |
|---------|---------|-------------|
| **Goal Curator** | `src/curation/goal-curator.js` | Campaign creation, goal health analysis |
| **Insight Synthesizer** | `src/dashboard/insight-synthesizer.js` | Evidence-based insight generation |
| **Evidence Analyzer** | `src/dashboard/evidence-analyzer.js` | Source verification, claim support |

### 2.2 Existing Infrastructure

| Component | Location | Status |
|-----------|----------|--------|
| **Launcher (Web)** | `src/launcher/` | Working - port 3340 |
| **Dashboard** | `src/dashboard/` | Working - port 3344 |
| **MCP Servers** | `mcp/` | Working - HTTP, stdio, filesystem |
| **Brain Studio** | `/path/to/COSMO_BrainStudio/` | Working - port 3398 |
| **Merge System** | `src/merge/`, `scripts/merge_runs.js` | Working - V2 with domain awareness |

### 2.3 Current Event Flow (What to Hook Into)

The orchestrator emits implicit events through its cycle. These are the hook points for real-time streaming:

```
orchestrator.executeCycle()
├── Poll topic/action queues
├── Update temporal rhythms     ← HOOK: rhythm_updated
├── Check sleep triggers        ← HOOK: sleep_triggered / wake_triggered
├── Process agent results       ← HOOK: agent_completed
├── Executive ring evaluation   ← HOOK: executive_review
├── Coordinator strategic review ← HOOK: coordinator_review
├── Spawn new agents            ← HOOK: agent_spawned
├── Generate thought            ← HOOK: thought_generated
├── Integrate to memory         ← HOOK: node_created, edge_created
├── Goal evaluation             ← HOOK: goal_updated
└── Cycle complete              ← HOOK: cycle_complete
```

---

## 3. The Watch Panel Specification

### 3.1 Purpose

The Watch Panel is the **"holy shit" moment** - the feature that makes COSMO feel alive. It shows COSMO thinking in real-time, exactly like Manus's "Computer Window" shows the AI working.

### 3.2 Design Requirements

#### Visual Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  COSMO's Mind                                               [Minimize] │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─ Current State ─────────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Cycle 47 of 100  •  explore mode  •  awake                     │   │
│  │                                                                  │   │
│  │  ┌──────────────────────────────────────────────────────────┐   │   │
│  │  │ "The hormetic response to cold exposure may share        │   │   │
│  │  │  mechanisms with sauna heat stress, suggesting that      │   │   │
│  │  │  deliberate cycling between extremes could optimize      │   │   │
│  │  │  the adaptive response..."                               │   │   │
│  │  └──────────────────────────────────────────────────────────┘   │   │
│  │                                                                  │   │
│  │  Role: curiosity  •  Model: claude-sonnet  •  Surprise: 0.31   │   │
│  │                                                                  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─ Cognitive State ───────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │  Energy     ████████████░░░░░░░░  62%                           │   │
│  │  Curiosity  ████████████████████  100%                          │   │
│  │  Mood       ██████████████░░░░░░  72%                           │   │
│  │  Surprise   ██████░░░░░░░░░░░░░░  31%  ← triggers exploration   │   │
│  │                                                                  │   │
│  │  Oscillator: [Focus] [■ Explore] [Execute]                      │   │
│  │  State: [■ Active] [Wandering] [Reflecting] [Sleeping]          │   │
│  │                                                                  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
│  ┌─ Knowledge Growth ──────────────────────────────────────────────┐   │
│  │                                                                  │   │
│  │       ○───○                   Nodes: 847 (+12)                  │   │
│  │      /│\  │\                  Edges: 2,341 (+47)                │   │
│  │     ○ ○ ○─○ ○                 Clusters: 23                      │   │
│  │       \│/│ /                                                    │   │
│  │        ○─○                    Last node: "cold shock proteins"  │   │
│  │                                                                  │   │
│  │  [Animated force-directed graph - nodes appear, edges connect]  │   │
│  │                                                                  │   │
│  └──────────────────────────────────────────────────────────────────┘   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  Activity Stream                                                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  12:34:56  ▸ Research Agent spawned                                    │
│            Topic: "cold water immersion protocols"                      │
│                                                                         │
│  12:35:12  ▸ Web search: 23 results found                              │
│            Sources: Huberman Lab, PubMed, Examine.com                   │
│                                                                         │
│  12:35:47  ▸ Research Agent completed                                  │
│            Created: research_summary.md, findings.json                  │
│            New nodes: 12  New edges: 34                                 │
│                                                                         │
│  12:36:02  ▸ Thought generated (critic role)                           │
│            "The assumption that cold exposure duration matters          │
│             more than temperature may be oversimplified..."            │
│                                                                         │
│  12:36:15  ▸ Synthesis Agent spawned                                   │
│            Goal: Connect cold exposure to heat shock research           │
│                                                                         │
│  12:36:23  ▸ New insight detected (novelty score: 0.84)                │
│            "Cold-heat cycling may optimize hormetic response"           │
│                                                                         │
│  ─────────────────────────────────────────────────────────────────────  │
│  [Auto-scroll] [Filter: All ▾]                     Showing 24 events   │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.3 Event Types to Stream

Each event type has a specific visual treatment:

| Event | Icon | Color | Content |
|-------|------|-------|---------|
| `cycle_start` | 🔄 | Blue | Cycle number, mode |
| `cycle_complete` | ✓ | Green | Duration, summary |
| `thought_generated` | 💭 | Purple | Thought text, role, surprise |
| `agent_spawned` | ▸ | Yellow | Agent type, topic/goal |
| `agent_completed` | ✓ | Green | Artifacts created, stats |
| `agent_failed` | ✗ | Red | Error message |
| `node_created` | ○ | Cyan | Concept text (truncated) |
| `edge_created` | ─ | Gray | Source → target |
| `insight_detected` | ✨ | Gold | Insight text, novelty score |
| `goal_created` | 🎯 | Blue | Goal description |
| `goal_completed` | ✓ | Green | Goal, outcome |
| `sleep_triggered` | 😴 | Purple | Reason (cycles/energy/fatigue) |
| `dream_rewiring` | 🌙 | Purple | Bridges created |
| `wake_triggered` | ☀️ | Yellow | Duration slept |
| `coordinator_review` | 📋 | Blue | Summary, directives |
| `cognitive_state_changed` | ⚡ | Variable | Which metric, old→new |
| `oscillator_mode_changed` | 🔀 | Variable | Old mode → new mode |
| `web_search` | 🔍 | Blue | Query, result count |
| `memory_consolidated` | 🧠 | Purple | Nodes processed |

### 3.4 Technical Implementation

#### 3.4.1 Server-Side: Event Emitter

**New file: `src/realtime/event-emitter.js`**

```javascript
// EventEmitter singleton that all COSMO components can emit to
const EventEmitter = require('events');

class COSMOEventEmitter extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100); // Support many WebSocket connections
  }

  // Typed emit methods for IDE autocomplete and validation
  emitCycleStart(data) {
    this.emit('cycle_start', { type: 'cycle_start', timestamp: Date.now(), ...data });
  }

  emitThought(data) {
    this.emit('thought_generated', { type: 'thought_generated', timestamp: Date.now(), ...data });
  }

  emitAgentSpawned(data) {
    this.emit('agent_spawned', { type: 'agent_spawned', timestamp: Date.now(), ...data });
  }

  emitAgentCompleted(data) {
    this.emit('agent_completed', { type: 'agent_completed', timestamp: Date.now(), ...data });
  }

  emitNodeCreated(data) {
    this.emit('node_created', { type: 'node_created', timestamp: Date.now(), ...data });
  }

  emitEdgeCreated(data) {
    this.emit('edge_created', { type: 'edge_created', timestamp: Date.now(), ...data });
  }

  emitInsight(data) {
    this.emit('insight_detected', { type: 'insight_detected', timestamp: Date.now(), ...data });
  }

  emitCognitiveStateChanged(data) {
    this.emit('cognitive_state_changed', { type: 'cognitive_state_changed', timestamp: Date.now(), ...data });
  }

  emitSleepTriggered(data) {
    this.emit('sleep_triggered', { type: 'sleep_triggered', timestamp: Date.now(), ...data });
  }

  emitWakeTriggered(data) {
    this.emit('wake_triggered', { type: 'wake_triggered', timestamp: Date.now(), ...data });
  }

  // Generic emit for custom events
  emitEvent(type, data) {
    this.emit(type, { type, timestamp: Date.now(), ...data });
  }
}

// Singleton
const cosmoEvents = new COSMOEventEmitter();
module.exports = { cosmoEvents };
```

#### 3.4.2 Server-Side: WebSocket Server

**New file: `src/realtime/websocket-server.js`**

```javascript
const WebSocket = require('ws');
const { cosmoEvents } = require('./event-emitter');

class RealtimeServer {
  constructor(options = {}) {
    this.port = options.port || 3345;
    this.wss = null;
    this.clients = new Set();
    this.eventBuffer = []; // Buffer last 100 events for new connections
    this.maxBuffer = 100;
  }

  start() {
    this.wss = new WebSocket.Server({ port: this.port });

    this.wss.on('connection', (ws) => {
      this.clients.add(ws);

      // Send buffered events to new client
      ws.send(JSON.stringify({
        type: 'connection_established',
        bufferedEvents: this.eventBuffer
      }));

      ws.on('close', () => {
        this.clients.delete(ws);
      });

      ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        this.clients.delete(ws);
      });
    });

    // Subscribe to all COSMO events
    const eventTypes = [
      'cycle_start', 'cycle_complete', 'thought_generated',
      'agent_spawned', 'agent_completed', 'agent_failed',
      'node_created', 'edge_created', 'insight_detected',
      'goal_created', 'goal_completed', 'sleep_triggered',
      'dream_rewiring', 'wake_triggered', 'coordinator_review',
      'cognitive_state_changed', 'oscillator_mode_changed',
      'web_search', 'memory_consolidated'
    ];

    eventTypes.forEach(eventType => {
      cosmoEvents.on(eventType, (data) => {
        this.broadcast(data);
      });
    });

    console.log(`COSMO Realtime WebSocket server running on port ${this.port}`);
  }

  broadcast(event) {
    // Add to buffer
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > this.maxBuffer) {
      this.eventBuffer.shift();
    }

    // Send to all connected clients
    const message = JSON.stringify(event);
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }

  stop() {
    if (this.wss) {
      this.wss.close();
    }
  }
}

module.exports = { RealtimeServer };
```

#### 3.4.3 Integration Points

Files to modify to emit events:

**`src/core/orchestrator.js`**
```javascript
// Add at top
const { cosmoEvents } = require('../realtime/event-emitter');

// In executeCycle():
async executeCycle() {
  cosmoEvents.emitCycleStart({
    cycle: this.state.cycleCount,
    mode: this.state.oscillator?.mode,
    cognitiveState: this.state.cognitiveState
  });

  // ... existing code ...

  // After thought generation:
  cosmoEvents.emitThought({
    cycle: this.state.cycleCount,
    thought: thought.thought,
    role: thought.role,
    surprise: thought.surprise,
    model: thought.model
  });

  // At end:
  cosmoEvents.emitEvent('cycle_complete', {
    cycle: this.state.cycleCount,
    duration: Date.now() - cycleStart,
    nodesCreated: newNodes,
    edgesCreated: newEdges
  });
}
```

**`src/agents/agent-executor.js`**
```javascript
const { cosmoEvents } = require('../realtime/event-emitter');

// In spawnAgent():
cosmoEvents.emitAgentSpawned({
  agentId: agent.id,
  type: agent.type,
  topic: agent.topic || agent.goal,
  cycle: this.currentCycle
});

// In handleAgentComplete():
cosmoEvents.emitAgentCompleted({
  agentId: agent.id,
  type: agent.type,
  artifacts: agent.artifacts,
  nodesCreated: agent.nodesCreated,
  edgesCreated: agent.edgesCreated,
  duration: agent.duration
});
```

**`src/memory/network-memory.js`**
```javascript
const { cosmoEvents } = require('../realtime/event-emitter');

// In addNode():
cosmoEvents.emitNodeCreated({
  nodeId: node.id,
  concept: node.concept.substring(0, 100),
  tag: node.tag,
  cluster: node.cluster
});

// In addEdge():
cosmoEvents.emitEdgeCreated({
  source: edge.source,
  target: edge.target,
  weight: edge.weight
});
```

**`src/temporal/rhythms.js`**
```javascript
const { cosmoEvents } = require('../realtime/event-emitter');

// In checkSleepTrigger():
if (shouldSleep) {
  cosmoEvents.emitSleepTriggered({
    reason: sleepReason, // 'cycles' | 'energy' | 'fatigue'
    energy: this.state.energy,
    fatigue: this.state.fatigue,
    cyclesSinceLastSleep: this.cyclesSinceLastSleep
  });
}

// In wake():
cosmoEvents.emitWakeTriggered({
  sleepDuration: this.sleepDuration,
  consolidatedNodes: this.consolidatedCount
});
```

**`src/cognition/state-modulator.js`**
```javascript
const { cosmoEvents } = require('../realtime/event-emitter');

// When state changes:
cosmoEvents.emitCognitiveStateChanged({
  metric: 'curiosity', // or 'mood', 'energy', 'mode'
  oldValue: oldCuriosity,
  newValue: newCuriosity,
  trigger: triggerReason
});
```

#### 3.4.4 Client-Side: Watch Panel Component

**New file: `public/js/watch-panel.js`**

```javascript
class WatchPanel {
  constructor(containerId, wsUrl) {
    this.container = document.getElementById(containerId);
    this.wsUrl = wsUrl || 'ws://localhost:3345';
    this.ws = null;
    this.state = {
      cycle: 0,
      mode: 'focus',
      cognitiveState: { curiosity: 0, mood: 0, energy: 0 },
      nodes: 0,
      edges: 0,
      currentThought: '',
      events: []
    };
    this.maxEvents = 100;
    this.graphVisualization = null;

    this.init();
  }

  init() {
    this.render();
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(this.wsUrl);

    this.ws.onopen = () => {
      console.log('Connected to COSMO realtime stream');
      this.updateConnectionStatus('connected');
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);

      if (data.type === 'connection_established') {
        // Process buffered events
        data.bufferedEvents.forEach(e => this.handleEvent(e));
      } else {
        this.handleEvent(data);
      }
    };

    this.ws.onclose = () => {
      this.updateConnectionStatus('disconnected');
      // Reconnect after 2 seconds
      setTimeout(() => this.connect(), 2000);
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  handleEvent(event) {
    // Add to events list
    this.state.events.unshift(event);
    if (this.state.events.length > this.maxEvents) {
      this.state.events.pop();
    }

    // Update state based on event type
    switch (event.type) {
      case 'cycle_start':
        this.state.cycle = event.cycle;
        this.state.mode = event.mode;
        if (event.cognitiveState) {
          this.state.cognitiveState = event.cognitiveState;
        }
        break;

      case 'thought_generated':
        this.state.currentThought = event.thought;
        this.state.currentRole = event.role;
        this.state.currentSurprise = event.surprise;
        break;

      case 'node_created':
        this.state.nodes++;
        this.state.lastNode = event.concept;
        if (this.graphVisualization) {
          this.graphVisualization.addNode(event);
        }
        break;

      case 'edge_created':
        this.state.edges++;
        if (this.graphVisualization) {
          this.graphVisualization.addEdge(event);
        }
        break;

      case 'cognitive_state_changed':
        this.state.cognitiveState[event.metric] = event.newValue;
        break;

      case 'sleep_triggered':
        this.state.isSleeping = true;
        break;

      case 'wake_triggered':
        this.state.isSleeping = false;
        break;
    }

    this.updateDisplay();
  }

  render() {
    this.container.innerHTML = `
      <div class="watch-panel">
        <div class="watch-header">
          <h2>COSMO's Mind</h2>
          <span class="connection-status" id="connection-status">Connecting...</span>
        </div>

        <div class="current-state" id="current-state">
          <div class="cycle-info">
            <span class="cycle-number">Cycle <span id="cycle-num">0</span></span>
            <span class="mode-badge" id="mode-badge">focus</span>
            <span class="state-badge" id="state-badge">awake</span>
          </div>

          <div class="thought-container">
            <div class="thought-text" id="thought-text">Waiting for thoughts...</div>
            <div class="thought-meta">
              <span>Role: <span id="thought-role">-</span></span>
              <span>Surprise: <span id="thought-surprise">-</span></span>
            </div>
          </div>
        </div>

        <div class="cognitive-state" id="cognitive-state">
          <div class="metric">
            <label>Energy</label>
            <div class="progress-bar"><div class="progress" id="energy-bar"></div></div>
            <span class="value" id="energy-value">0%</span>
          </div>
          <div class="metric">
            <label>Curiosity</label>
            <div class="progress-bar"><div class="progress" id="curiosity-bar"></div></div>
            <span class="value" id="curiosity-value">0%</span>
          </div>
          <div class="metric">
            <label>Mood</label>
            <div class="progress-bar"><div class="progress" id="mood-bar"></div></div>
            <span class="value" id="mood-value">0%</span>
          </div>
          <div class="metric">
            <label>Surprise</label>
            <div class="progress-bar"><div class="progress surprise" id="surprise-bar"></div></div>
            <span class="value" id="surprise-value">0%</span>
          </div>
        </div>

        <div class="knowledge-growth" id="knowledge-growth">
          <div class="graph-container" id="graph-container"></div>
          <div class="stats">
            <span>Nodes: <span id="node-count">0</span></span>
            <span>Edges: <span id="edge-count">0</span></span>
            <span>Last: <span id="last-node">-</span></span>
          </div>
        </div>

        <div class="activity-stream" id="activity-stream">
          <div class="stream-header">Activity Stream</div>
          <div class="events-list" id="events-list"></div>
        </div>
      </div>
    `;

    // Initialize graph visualization
    this.initGraph();
  }

  initGraph() {
    // D3.js force-directed graph initialization
    // This will be populated as nodes/edges are created
    const container = document.getElementById('graph-container');
    const width = container.clientWidth;
    const height = 200;

    this.graphVisualization = new KnowledgeGraphViz('graph-container', width, height);
  }

  updateDisplay() {
    // Update cycle info
    document.getElementById('cycle-num').textContent = this.state.cycle;
    document.getElementById('mode-badge').textContent = this.state.mode;
    document.getElementById('mode-badge').className = `mode-badge mode-${this.state.mode}`;
    document.getElementById('state-badge').textContent = this.state.isSleeping ? 'sleeping' : 'awake';

    // Update thought
    document.getElementById('thought-text').textContent = this.state.currentThought || 'Waiting for thoughts...';
    document.getElementById('thought-role').textContent = this.state.currentRole || '-';
    document.getElementById('thought-surprise').textContent =
      this.state.currentSurprise !== undefined ? (this.state.currentSurprise * 100).toFixed(0) + '%' : '-';

    // Update cognitive state bars
    this.updateBar('energy', this.state.cognitiveState.energy);
    this.updateBar('curiosity', this.state.cognitiveState.curiosity);
    this.updateBar('mood', this.state.cognitiveState.mood);
    this.updateBar('surprise', this.state.currentSurprise || 0);

    // Update stats
    document.getElementById('node-count').textContent = this.state.nodes;
    document.getElementById('edge-count').textContent = this.state.edges;
    document.getElementById('last-node').textContent =
      this.state.lastNode ? this.state.lastNode.substring(0, 30) + '...' : '-';

    // Update events list
    this.renderEvents();
  }

  updateBar(metric, value) {
    const pct = Math.round((value || 0) * 100);
    document.getElementById(`${metric}-bar`).style.width = `${pct}%`;
    document.getElementById(`${metric}-value`).textContent = `${pct}%`;
  }

  renderEvents() {
    const container = document.getElementById('events-list');
    const html = this.state.events.slice(0, 50).map(event => {
      const time = new Date(event.timestamp).toLocaleTimeString();
      const icon = this.getEventIcon(event.type);
      const color = this.getEventColor(event.type);
      const content = this.getEventContent(event);

      return `
        <div class="event-item event-${event.type}" style="border-left-color: ${color}">
          <span class="event-time">${time}</span>
          <span class="event-icon">${icon}</span>
          <span class="event-content">${content}</span>
        </div>
      `;
    }).join('');

    container.innerHTML = html;
  }

  getEventIcon(type) {
    const icons = {
      'cycle_start': '🔄',
      'cycle_complete': '✓',
      'thought_generated': '💭',
      'agent_spawned': '▸',
      'agent_completed': '✓',
      'agent_failed': '✗',
      'node_created': '○',
      'edge_created': '─',
      'insight_detected': '✨',
      'goal_created': '🎯',
      'goal_completed': '✓',
      'sleep_triggered': '😴',
      'dream_rewiring': '🌙',
      'wake_triggered': '☀️',
      'coordinator_review': '📋',
      'cognitive_state_changed': '⚡',
      'oscillator_mode_changed': '🔀',
      'web_search': '🔍',
      'memory_consolidated': '🧠'
    };
    return icons[type] || '•';
  }

  getEventColor(type) {
    const colors = {
      'cycle_start': '#3b82f6',
      'cycle_complete': '#10b981',
      'thought_generated': '#8b5cf6',
      'agent_spawned': '#f59e0b',
      'agent_completed': '#10b981',
      'agent_failed': '#ef4444',
      'node_created': '#06b6d4',
      'insight_detected': '#fbbf24',
      'sleep_triggered': '#8b5cf6',
      'wake_triggered': '#fbbf24'
    };
    return colors[type] || '#6b7280';
  }

  getEventContent(event) {
    switch (event.type) {
      case 'cycle_start':
        return `Cycle ${event.cycle} started (${event.mode} mode)`;
      case 'thought_generated':
        return `"${event.thought.substring(0, 80)}..."`;
      case 'agent_spawned':
        return `${event.type} Agent: ${event.topic || event.goal}`;
      case 'agent_completed':
        return `${event.type} completed (+${event.nodesCreated || 0} nodes)`;
      case 'node_created':
        return `Node: "${event.concept}"`;
      case 'insight_detected':
        return `Insight (${(event.noveltyScore * 100).toFixed(0)}%): "${event.insight}"`;
      case 'sleep_triggered':
        return `Sleeping (${event.reason})`;
      case 'wake_triggered':
        return `Woke up after ${event.sleepDuration}`;
      default:
        return JSON.stringify(event).substring(0, 60) + '...';
    }
  }

  updateConnectionStatus(status) {
    const el = document.getElementById('connection-status');
    el.textContent = status === 'connected' ? '● Connected' : '○ Disconnected';
    el.className = `connection-status ${status}`;
  }
}

// Mini D3 graph visualization
class KnowledgeGraphViz {
  constructor(containerId, width, height) {
    this.container = document.getElementById(containerId);
    this.width = width;
    this.height = height;
    this.nodes = [];
    this.edges = [];
    this.maxNodes = 50; // Only show last 50 for performance

    this.init();
  }

  init() {
    this.svg = d3.select(this.container)
      .append('svg')
      .attr('width', this.width)
      .attr('height', this.height);

    this.simulation = d3.forceSimulation()
      .force('link', d3.forceLink().id(d => d.id).distance(30))
      .force('charge', d3.forceManyBody().strength(-50))
      .force('center', d3.forceCenter(this.width / 2, this.height / 2));

    this.linkGroup = this.svg.append('g').attr('class', 'links');
    this.nodeGroup = this.svg.append('g').attr('class', 'nodes');
  }

  addNode(event) {
    this.nodes.push({
      id: event.nodeId,
      concept: event.concept
    });

    // Keep only last N nodes
    if (this.nodes.length > this.maxNodes) {
      this.nodes.shift();
    }

    this.update();
  }

  addEdge(event) {
    // Only add if both nodes exist in current view
    const sourceExists = this.nodes.find(n => n.id === event.source);
    const targetExists = this.nodes.find(n => n.id === event.target);

    if (sourceExists && targetExists) {
      this.edges.push({
        source: event.source,
        target: event.target,
        weight: event.weight
      });
      this.update();
    }
  }

  update() {
    // Update links
    const link = this.linkGroup.selectAll('line')
      .data(this.edges)
      .join('line')
      .attr('stroke', '#4a5568')
      .attr('stroke-opacity', 0.6);

    // Update nodes
    const node = this.nodeGroup.selectAll('circle')
      .data(this.nodes)
      .join('circle')
      .attr('r', 5)
      .attr('fill', '#06b6d4');

    // Update simulation
    this.simulation.nodes(this.nodes);
    this.simulation.force('link').links(this.edges);
    this.simulation.alpha(0.3).restart();

    this.simulation.on('tick', () => {
      link
        .attr('x1', d => d.source.x)
        .attr('y1', d => d.source.y)
        .attr('x2', d => d.target.x)
        .attr('y2', d => d.target.y);

      node
        .attr('cx', d => d.x)
        .attr('cy', d => d.y);
    });
  }
}
```

### 3.5 Watch Panel CSS

**New file: `public/css/watch-panel.css`**

```css
.watch-panel {
  background: #1a1a1a;
  color: #e5e5e5;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.watch-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid #333;
  background: #252525;
}

.watch-header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.connection-status {
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
}

.connection-status.connected {
  color: #10b981;
}

.connection-status.disconnected {
  color: #ef4444;
}

.current-state {
  padding: 16px;
  border-bottom: 1px solid #333;
}

.cycle-info {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 12px;
}

.cycle-number {
  font-size: 16px;
  font-weight: 600;
}

.mode-badge, .state-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: uppercase;
  font-weight: 500;
}

.mode-badge.mode-focus { background: #3b82f6; }
.mode-badge.mode-explore { background: #8b5cf6; }
.mode-badge.mode-execute { background: #f59e0b; }

.state-badge { background: #333; }

.thought-container {
  background: #252525;
  border-radius: 8px;
  padding: 12px;
  margin-top: 8px;
}

.thought-text {
  font-size: 14px;
  line-height: 1.5;
  color: #e5e5e5;
  font-style: italic;
}

.thought-meta {
  display: flex;
  gap: 16px;
  margin-top: 8px;
  font-size: 12px;
  color: #888;
}

.cognitive-state {
  padding: 16px;
  border-bottom: 1px solid #333;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.metric {
  display: flex;
  align-items: center;
  gap: 8px;
}

.metric label {
  font-size: 11px;
  color: #888;
  width: 60px;
}

.progress-bar {
  flex: 1;
  height: 6px;
  background: #333;
  border-radius: 3px;
  overflow: hidden;
}

.progress {
  height: 100%;
  background: #3b82f6;
  border-radius: 3px;
  transition: width 0.3s ease;
}

.progress.surprise {
  background: #f59e0b;
}

.metric .value {
  font-size: 11px;
  color: #888;
  width: 35px;
  text-align: right;
}

.knowledge-growth {
  padding: 16px;
  border-bottom: 1px solid #333;
}

.graph-container {
  background: #0a0a0a;
  border-radius: 8px;
  height: 150px;
  margin-bottom: 8px;
}

.knowledge-growth .stats {
  display: flex;
  gap: 16px;
  font-size: 12px;
  color: #888;
}

.activity-stream {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.stream-header {
  padding: 12px 16px;
  font-size: 12px;
  font-weight: 600;
  color: #888;
  border-bottom: 1px solid #333;
}

.events-list {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.event-item {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-left: 3px solid #333;
  margin-bottom: 4px;
  font-size: 12px;
  background: #1a1a1a;
  border-radius: 0 4px 4px 0;
}

.event-time {
  color: #666;
  font-family: monospace;
  font-size: 10px;
}

.event-icon {
  width: 16px;
  text-align: center;
}

.event-content {
  flex: 1;
  color: #ccc;
}
```

---

## 4. Unified App Architecture

### 4.0 The Marriage: COSMO + Brain Studio

**The insight**: COSMO and Brain Studio are two halves of a complete product.

| System | Role | What It Does |
|--------|------|--------------|
| **COSMO2** | The Engine | Creates brains through autonomous multi-agent research |
| **Brain Studio** | The Interface | Consumes brains via Query, Explore, and Agent IDE |

**The unified experience:**
```
User enters topic → COSMO researches (Watch mode) → Brain Studio explores (Studio mode)
```

**Existing Brain Studio Components** (already built in `/path/to/COSMO_BrainStudio/`):

| Component | Port | Function |
|-----------|------|----------|
| **Browser** | 3398 | Landing page listing brains and research runs |
| **Studio** | 3407 | Full brain interface (Query Tab, Explore Tab, Agent IDE) |

**Brain Studio Features Already Implemented:**

1. **Query Tab** - 9 reasoning modes:
   - Fast, Normal, Deep, Grounded, Raw
   - Report, Innovation, Consulting, Executive Summary
   - Multiple models (GPT-5.1, GPT-5, GPT-5 Mini)
   - Evidence metrics, synthesis, coordinator insights

2. **Explore Tab** - D3.js knowledge graph:
   - Force-directed visualization
   - Filter by node type (analyst, curiosity, critic, agent_finding)
   - Controls for node size, edge opacity, labels, clusters

3. **Agent IDE** - 17+ tools:
   - File: read_file, list_directory, create_file, delete_file
   - Search: grep_search, codebase_search
   - Edit: edit_file, edit_file_range, search_replace, insert_lines, delete_lines
   - Terminal: run_terminal
   - Images: read_image, create_image, edit_image
   - Documents: create_docx, create_xlsx

4. **Editor** - Full code editor with diff viewer, syntax highlighting

**The connection point**: Both systems share the filesystem:
- COSMO writes to `runs/` directory
- Brain Studio reads via `COSMO_RUNS_PATH` environment variable
- Brain Studio can "publish" runs to `brains/` as stable artifacts

### 4.1 Architecture Options

**Option A: Proxy Wrapper** (recommended for v1)
```
┌────────────────────────────────────────────────────────────────┐
│  Unified Wrapper (port 3000)                                   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  /                 → Launch mode (start research)              │
│  /watch            → Watch Panel (WebSocket → :3400)           │
│  /studio/*         → HTTP proxy → Brain Studio :3398           │
│  /api/launch       → Start COSMO engine                        │
│  /api/status       → Current run status                        │
│  /api/brains       → List available brains                     │
│                                                                │
└────────────────────────────────────────────────────────────────┘
        │                    │                    │
        ▼                    ▼                    ▼
   ┌─────────┐        ┌───────────┐        ┌─────────────┐
   │ COSMO2  │        │ WebSocket │        │ Brain Studio│
   │ Engine  │───────▶│   :3400   │        │   :3398     │
   │ (child) │        └───────────┘        └─────────────┘
   └─────────┘
```

**Why Option A:**
- Lowest integration effort
- Each component proven stable
- Can deploy together or separately
- Clean separation of concerns

**Option B: Deep Integration** (future consideration)
- Merge Brain Studio routes into unified server
- Single process, single port
- Better for cloud deployment (one container)

### 4.2 Directory Structure

```
COSMO_Unified/
├── package.json
├── .env                          # Shared config
├── server/
│   ├── index.js                  # Unified Express server
│   ├── cosmo-runner.js           # COSMO child process management
│   └── routes/
│       ├── launch.js             # POST /api/launch, GET /api/status
│       └── brains.js             # GET /api/brains, brain management
│
├── public/
│   ├── index.html                # SPA shell with navigation
│   ├── css/
│   │   └── unified.css           # Shared styles
│   └── js/
│       ├── app.js                # Router, state management
│       ├── launch-mode.js        # Launch UI
│       └── watch-mode.js         # Watch Panel (embeds intelligence.html)
│
├── engine/                       # Symlink → /path/to/Cosmo2/COSMO2
│
├── studio/                       # Symlink → /path/to/COSMO_BrainStudio
│
└── brains/                       # Shared brain storage
    └── {brain-name}.brain/
```

### 4.3 Unified Server Implementation

```javascript
// server/index.js
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
app.use(express.json());

// State
let cosmoProcess = null;
let currentRunId = null;

// Static files for wrapper UI
app.use(express.static('public'));

// API: Launch COSMO research
app.post('/api/launch', async (req, res) => {
  const { topic, depth = 'standard', cycles } = req.body;

  if (cosmoProcess) {
    return res.status(400).json({ error: 'Research already running' });
  }

  currentRunId = `run_${Date.now()}`;
  const cycleCount = cycles || { quick: 30, standard: 100, deep: 300 }[depth];

  cosmoProcess = spawn('node', [
    path.join(__dirname, '../engine/src/index.js'),
    '--domain', topic,
    '--cycles', cycleCount.toString(),
    '--run-id', currentRunId
  ], {
    cwd: path.join(__dirname, '../engine'),
    env: { ...process.env }
  });

  cosmoProcess.on('exit', () => {
    cosmoProcess = null;
  });

  res.json({
    status: 'started',
    runId: currentRunId,
    wsUrl: 'ws://localhost:3400'
  });
});

// API: Get current status
app.get('/api/status', (req, res) => {
  res.json({
    running: !!cosmoProcess,
    runId: currentRunId
  });
});

// API: Stop research
app.post('/api/stop', (req, res) => {
  if (cosmoProcess) {
    cosmoProcess.kill('SIGTERM');
    cosmoProcess = null;
    res.json({ status: 'stopped' });
  } else {
    res.json({ status: 'not_running' });
  }
});

// Proxy to Brain Studio
app.use('/studio', createProxyMiddleware({
  target: 'http://localhost:3398',
  changeOrigin: true,
  pathRewrite: { '^/studio': '' }
}));

// WebSocket proxy for Watch mode
app.use('/ws', createProxyMiddleware({
  target: 'ws://localhost:3400',
  ws: true,
  changeOrigin: true
}));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║              🧠 COSMO UNIFIED PLATFORM                       ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  🌐 App:     http://localhost:${PORT}                           ║
║  👁️  Watch:   http://localhost:${PORT}/watch                    ║
║  🎨 Studio:  http://localhost:${PORT}/studio                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
```

### 4.4 App Modes

The unified app has four modes, accessible via top navigation:

| Mode | Purpose | Components | URL |
|------|---------|------------|-----|
| **Launch** | Start new research | Topic input, depth selector, advanced options | `/` |
| **Watch** | Real-time COSMO view | Watch Panel (WebSocket stream) | `/watch` |
| **Explore** | Query & visualize brains | Native D3 graph, query, chat panels | `/explore` |
| **IDE** | Work with brain outputs | Embedded Brain Studio Agent IDE | `/ide` |

### 4.5 Mode Transitions

```
┌─────────────────────────────────────────────────────────────────┐
│  [Launch]  [Watch]  [Studio]                    [Current Brain] │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                                                             ││
│  │                    LAUNCH MODE                              ││
│  │                                                             ││
│  │   What would you like to research?                          ││
│  │   ┌─────────────────────────────────────────────────────┐   ││
│  │   │ Cold water immersion benefits and protocols         │   ││
│  │   └─────────────────────────────────────────────────────┘   ││
│  │                                                             ││
│  │   Research Depth:                                           ││
│  │   [Quick (30 cycles)] [Standard (100)] [Deep (300)]        ││
│  │                                                             ││
│  │              [ 🚀 Start Research ]                          ││
│  │                                                             ││
│  │   ────────────────────────────────────────────────────────  ││
│  │   Recent Brains:                                            ││
│  │   • Protein Synthesis (847 nodes) - 3 days ago              ││
│  │   • Sleep Optimization (1,203 nodes) - 1 week ago           ││
│  │                                                             ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

                              │
                    [Click "Start Research"]
                              │
                              ▼

┌─────────────────────────────────────────────────────────────────┐
│  [Launch]  [■ Watch]  [Studio]              Cycle 47 • explore  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│            (Watch Panel - real-time COSMO activity)             │
│                                                                 │
│  • Cognitive state gauges                                       │
│  • Current thought streaming                                    │
│  • Activity stream                                              │
│  • Knowledge graph growing                                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

                              │
                    [Research completes OR user clicks Studio]
                              │
                              ▼

┌─────────────────────────────────────────────────────────────────┐
│  [Launch]  [Watch]  [■ Studio]           cold-water-immersion   │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [Query] [Explore] [Agent IDE] [Editor]                         │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                                                             ││
│  │  (Brain Studio Query Tab)                                   ││
│  │                                                             ││
│  │  Ask anything about the research...                         ││
│  │  ┌─────────────────────────────────────────────────────┐   ││
│  │  │ What's the optimal cold exposure duration?          │   ││
│  │  └─────────────────────────────────────────────────────┘   ││
│  │                                                             ││
│  │  Mode: [Deep] [Grounded] [Report] ...                      ││
│  │                                                             ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 4.6 Brain Handoff Mechanism

When COSMO completes research:

1. **Event emitted**: `research_complete { runId, summary, nodeCount, edgeCount }`
2. **State saved**: Brain written to `runs/{runId}/`
3. **UI notification**: "Research complete! Open in Studio?"
4. **Auto-transition**: Navigate to `/studio` with brain pre-loaded
5. **Brain available**: Brain Studio scans `runs/` via `COSMO_RUNS_PATH`

The shared filesystem is the integration point:
```
COSMO writes → runs/{run-id}/state.json.gz
                            /outputs/
                            /coordinator/

Brain Studio reads ← COSMO_RUNS_PATH env variable
```

### 4.7 Runtime Symlink Mechanism (CRITICAL)

**The Problem:** COSMO reads/writes all state to `runtime/` directory. If multiple runs share the same runtime, state bleeds between them causing cross-contamination.

**The Solution:** `runtime/` is a symlink that points to the current run's directory. When starting a new run, the symlink is updated to point to the new location.

```
Before launch:
  runtime/ → runs/OldRun/    (contains old state.json.gz)

After launch:
  runtime/ → runs/NewRun/    (empty, clean start)
```

**Implementation in `server/index.js`:**
```javascript
async function linkRuntime(runName) {
  const runPath = path.join(RUNS_PATH, runName);

  // Remove old symlink
  fs.rmSync(RUNTIME_PATH, { recursive: true, force: true });

  // Create new symlink
  fs.symlinkSync(runPath, RUNTIME_PATH);
}
```

**Launch Sequence:**
1. Create run directory: `runs/{runName}/`
2. Create subdirectories: `coordinator/`, `agents/`, `outputs/`, etc.
3. Write `run-metadata.json` with configuration
4. **Update symlink:** `runtime/` → `runs/{runName}/`
5. Start MCP server
6. Start Dashboard
7. Start COSMO core

This ensures:
- Each run is completely isolated
- No state from previous runs bleeds through
- "Clean Start" actually means clean
- Cross-contamination is impossible

### 4.8 Research Brief Generation

When research completes, auto-generate a downloadable brief:

**Template:**
```markdown
# Research Brief: {topic}
*Generated by COSMO on {date}*

## Executive Summary
{coordinator final assessment}

## Key Findings
{top 5 insights by novelty score}

## Evidence & Sources
{sources with citations}

## Knowledge Graph Stats
- Nodes: {count}
- Edges: {count}
- Clusters: {count}
- Research cycles: {count}

## Next Steps
{suggested follow-up questions}

---
*Open this brain in COSMO Studio to explore further.*
```

**Export formats:**
- Markdown (.md)
- PDF (via puppeteer)
- JSON (full brain data)

---

## 5. Implementation Phases

### Phase 1: Event System & WebSocket ✅ COMPLETE

**Goal:** Get real-time events streaming from COSMO to browser.

**Completed:**
- [x] Created `src/realtime/event-emitter.js` - Singleton event emitter
- [x] Created `src/realtime/websocket-server.js` - WebSocket server on port 3400
- [x] Added emit hooks to orchestrator (cycle, thought, sleep, dream phases)
- [x] Added emit hooks to agent-executor (spawn, complete, failed)
- [x] Added emit hooks to coordinator (reviews, phases, decisions)
- [x] Added emit hooks to intrinsic-goals (goal created, completed)
- [x] Added emit hooks to research-agent (web_search)
- [x] Added emit hooks to execution-backend (code_generation)
- [x] Added emit hooks to code-execution-agent (insights_extracted)
- [x] WebSocket server starts alongside COSMO engine

**Deliverable:** ✅ Events streaming to browser via WebSocket.

### Phase 2: Watch Panel UI ~80% COMPLETE

**Goal:** Beautiful real-time visualization.

**Completed:**
- [x] Created `src/dashboard/intelligence.html` - Full Watch Panel
- [x] Activity stream with 20+ event types, icons, colors
- [x] Cognitive state gauges (energy, curiosity, mood, fatigue)
- [x] Event filtering by category
- [x] Auto-reconnect on WebSocket disconnect
- [x] Server stats display (cycles, nodes, edges, agents)

**Remaining:**
- [ ] Prominent thought display (larger, animated)
- [ ] Animated knowledge graph growing (D3.js mini-graph)
- [ ] Surprise gauge (separate from other cognitive metrics)
- [ ] Oscillator mode buttons (Focus/Explore/Execute indicators)

**Deliverable:** Working Watch Panel showing live COSMO activity.

### Phase 3: Unified Wrapper ✅ COMPLETE

**Goal:** Single entry point marrying COSMO + Brain Studio.

**Completed Tasks:**
1. ✅ Created `COSMO_Unified/` project at `/path/to/COSMO_Unified/`
2. ✅ Created symlinks: `engine/` → COSMO2, `studio/` → Brain Studio
3. ✅ Implemented `server/index.js` with:
   - Static file serving for Launch/Watch modes
   - `POST /api/launch` - Start COSMO with FULL configuration parity
   - `GET /api/status` - Current run status with all details
   - `POST /api/stop` - Graceful stop with process cleanup
   - `GET /api/brains` - List all brains with full metadata
   - `GET /api/config/defaults` - All configuration options
   - Proxy to Brain Studio (`/studio/*` → `:3398`)
   - Auto-spawn Brain Studio on startup
   - **CRITICAL:** Runtime symlink management for clean starts
4. ✅ Created `public/index.html` - SPA shell with navigation tabs
5. ✅ Created `public/js/app.js` - Router, state management, WebSocket
6. ✅ Created `public/css/unified.css` - Full dark theme styling
7. ✅ Implemented Advanced Options panel with all configuration toggles
8. ✅ Tested full flow: Launch → Watch → Studio

**Key Implementation Details:**
- Uses `ConfigGenerator` from COSMO launcher for config.yaml generation
- Uses `ProcessManager` for proper service orchestration
- Uses `RunManager` for brain listing and metadata
- Runtime symlink (`runtime/` → `runs/{runName}`) prevents cross-contamination
- Brain handoff via shared filesystem (COSMO_RUNS_PATH)

**Files Created:**
- `/path/to/COSMO_Unified/package.json`
- `/path/to/COSMO_Unified/server/index.js`
- `/path/to/COSMO_Unified/public/index.html`
- `/path/to/COSMO_Unified/public/js/app.js`
- `/path/to/COSMO_Unified/public/css/unified.css`
- `/path/to/COSMO_Unified/.env`
- `/path/to/COSMO_Unified/README.md`

**Deliverable:** ✅ Single URL (localhost:3000), three modes, seamless transitions.

### Phase 4: Brain Handoff & Completion ✅ COMPLETE

**Goal:** Smooth transition from research to exploration.

**Completed Tasks:**
1. ✅ `research_complete` event already exists in orchestrator
2. ✅ Event includes: runId, nodeCount, edgeCount, duration
3. ✅ Watch Panel shows completion notification via toast
4. ✅ User prompted with confirm dialog: "Would you like to explore the brain?"
5. ✅ Clicking "OK" navigates to `/explore` with brain pre-selected

**Deliverable:** ✅ Research ends → Prompt → One click → Start exploring.

### Phase 5: Native Explore Mode ✅ COMPLETE

**Goal:** Replace iframe/new-window pattern with native exploration.

**Completed Tasks:**
1. ✅ **Native Brain Browser** - Sidebar with all brains (no iframe)
2. ✅ **Knowledge Graph Visualization** - D3.js force-directed graph
3. ✅ **Query Interface** - 9 reasoning modes (proxies to Brain Studio API)
4. ✅ **Chat Panel** - Conversational interface with brain
5. ✅ **Outputs Browser** - View generated files
6. ✅ **Brain Data API** - Direct reading of state.json.gz:
   - `GET /api/brain/:name/nodes` - Paginated nodes
   - `GET /api/brain/:name/edges` - Paginated edges
   - `GET /api/brain/:name/outputs` - File listing
   - `POST /api/brain/:name/query` - Query proxy
7. ✅ **Consistent light theme** throughout Launch/Watch/Explore

**Files Created/Modified:**
- `public/index.html` - New Explore mode HTML structure
- `public/js/app.js` - Graph rendering, brain selection, query/chat
- `public/css/unified.css` - Explore mode styling
- `server/index.js` - Brain data API routes

**Deliverable:** ✅ Click brain → See graph → Query/chat → All in same window.

### Phase 6: Research Brief Generation

**Goal:** Tangible deliverable when research completes.

**Tasks:**
1. Create `src/reports/brief-generator.js`
2. Template: Executive summary, key findings, sources, stats
3. Hook into `research_complete` event
4. Auto-generate Markdown brief
5. Option to generate PDF (via puppeteer)
6. Download buttons in Watch Panel and Explore

**Deliverable:** Research complete → Download report.

### Phase 7: Watch Panel Polish

**Goal:** Complete the "holy shit moment" experience.

**Tasks:**
1. **Prominent thought display**:
   - Large text area at top
   - Typewriter animation effect
   - Role badge, surprise indicator
2. **Mini knowledge graph**:
   - D3.js force-directed in sidebar
   - Nodes appear with animation
   - Edges animate connections
   - Last 50 nodes for performance
3. **Consistent light theme** - Match Launch/Explore
4. **Oscillator mode indicators**:
   - [Focus] [Explore] [Execute] buttons
   - Current mode highlighted
   - Mode change animations

**Deliverable:** Polished, captivating Watch Panel with consistent theme.

### Phase 8: Workspace Mode (IDE Unification) ✅ COMPLETE

**Goal:** Bring full IDE capabilities into unified shell without new windows.

**Implementation:** Option B (Styled Iframe) was chosen for quick integration.

**Completed Tasks:**
1. ✅ Added "IDE" as 4th navigation tab
2. ✅ URL routing for `/ide` path
3. ✅ Brain Studio loads in iframe within unified shell
4. ✅ Light theme CSS added to Brain Studio (inline styles)
5. ✅ URL parameter `?theme=light` activates light mode
6. ✅ URL parameter `?embedded=true` hides redundant tabs
7. ✅ Only "Agent IDE" tab visible in embedded mode
8. ✅ Sidebar with file tree preserved
9. ✅ Monaco editor respects theme setting
10. ✅ Refresh and popout buttons for power users

**Architecture (Implemented):**
```
┌─────────────────────────────────────────────────────────────────┐
│  [Launch] [Watch] [Explore] [IDE]                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  IDE Mode (Embedded Brain Studio):                              │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  ┌──────────┬────────────────────────┬───────────────────┐ ││
│  │  │          │                        │                   │ ││
│  │  │  File    │    Monaco Editor       │   AI Chat         │ ││
│  │  │  Tree    │    (tabs)              │   Panel           │ ││
│  │  │          │                        │                   │ ││
│  │  │          │                        │   - 17+ tools     │ ││
│  │  │          │                        │   - Streaming     │ ││
│  │  └──────────┴────────────────────────┴───────────────────┘ ││
│  │          iframe src=localhost:3407?theme=light&embedded=true ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Files Modified:**
- `COSMO_Unified/public/index.html` - IDE tab and panel
- `COSMO_Unified/public/js/app.js` - IDE mode logic, loadIDE(), refreshIDE()
- `COSMO_Unified/public/css/unified.css` - IDE styling
- `COSMO_BrainStudio/public/index.html` - Light theme, embedded mode CSS
- `COSMO_BrainStudio/public/js/editor.js` - Dynamic Monaco theme

**Deliverable:** ✅ Full IDE in same window, no context switch, light theme.

### Phase 9: Cloud Deployment

**Goal:** Users can access without self-hosting.

**Tasks:**
1. Create `Dockerfile` for unified app
2. Configure for Fly.io or Railway
3. Set up persistent volume for brains
4. Environment variable management
5. Set up domain + SSL (cosmo.evobrew.com)
6. Health checks for all services
7. Deploy and test

**Architecture considerations:**
- Single container with all services
- Or: Separate containers communicating via internal network
- Persistent volume at `/brains`

**Deliverable:** Live at https://cosmo.evobrew.com

### Phase 10: Auth & Payments

**Goal:** Multi-user, monetizable.

**Tasks:**
1. Integrate Clerk for authentication
2. User-specific brain storage (`/brains/{userId}/`)
3. Integrate Stripe for payments
4. Implement tier limits:
   - **Free**: 1 brain, 30 cycles, basic Query modes
   - **Pro ($29/mo)**: Unlimited brains, 300 cycles, all modes, Agent IDE
   - **Team ($99/mo)**: Shared brains, collaboration
5. Usage tracking and metering
6. Billing portal

**Deliverable:** Sign up → Subscribe → Use.

### Phase 11: Polish & Launch

**Goal:** Launch-ready product.

**Tasks:**
1. Landing page (cosmo.evobrew.com)
2. Demo video (2-3 min showing full flow)
3. Documentation
4. Error handling & edge cases
5. Performance optimization
6. Beta waitlist
7. Launch to waitlist
8. Product Hunt launch

**Deliverable:** Product launch.

---

## 6. Technical Requirements

### 6.1 Dependencies to Add

```json
{
  "dependencies": {
    "ws": "^8.14.0",           // WebSocket server
    "d3": "^7.8.0",            // Graph visualization (client-side)
    "@clerk/clerk-sdk-node": "^4.0.0",  // Authentication
    "stripe": "^14.0.0"        // Payments
  }
}
```

### 6.2 Environment Variables

```env
# Existing
OPENAI_API_KEY=...
ANTHROPIC_API_KEY=...

# New
COSMO_REALTIME_PORT=3345
CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
```

### 6.3 Port Allocation

| Service | Port | Purpose |
|---------|------|---------|
| Web App | 3000 | Main application |
| COSMO Engine | 3344 | Dashboard (existing) |
| WebSocket | 3345 | Real-time events |
| Brain Studio | 3398 | Explore mode |

### 6.4 Browser Requirements

- Modern browser (Chrome 90+, Firefox 88+, Safari 14+)
- WebSocket support
- ES2020+ JavaScript

---

## 7. File Inventory

### 7.1 Completed Files (Phase 1-2)

| File | Purpose | Status |
|------|---------|--------|
| `src/realtime/event-emitter.js` | Singleton event emitter | ✅ Complete |
| `src/realtime/websocket-server.js` | WebSocket server on port 3400 | ✅ Complete |
| `src/dashboard/intelligence.html` | Watch Panel UI | ✅ Complete |
| `src/core/orchestrator.js` | Event emits for cycles, thoughts, sleep, dreams | ✅ Modified |
| `src/agents/agent-executor.js` | Event emits for agent lifecycle | ✅ Modified |
| `src/coordinator/meta-coordinator.js` | Event emits for reviews, phases | ✅ Modified |
| `src/goals/intrinsic-goals.js` | Event emits for goals | ✅ Modified |
| `src/agents/research-agent.js` | Event emits for web searches | ✅ Modified |
| `src/agents/execution/execution-backend.js` | Event emits for code generation | ✅ Modified |
| `src/agents/code-execution-agent.js` | Event emits for insights | ✅ Modified |

### 7.2 Files Created (Unified Wrapper - Phase 3) ✅ COMPLETE

| File | Purpose | Status |
|------|---------|--------|
| `COSMO_Unified/package.json` | Unified app dependencies | ✅ Created |
| `COSMO_Unified/server/index.js` | Express server with full launcher integration | ✅ Created |
| `COSMO_Unified/public/index.html` | SPA shell with navigation + Advanced Options | ✅ Created |
| `COSMO_Unified/public/js/app.js` | Router, state, WebSocket, config gathering | ✅ Created |
| `COSMO_Unified/public/css/unified.css` | Light theme with all form elements | ✅ Created |
| `COSMO_Unified/.env` | Environment configuration | ✅ Created |
| `COSMO_Unified/README.md` | Comprehensive documentation | ✅ Created |
| `COSMO_Unified/engine` | Symlink → COSMO2 | ✅ Created |
| `COSMO_Unified/studio` | Symlink → Brain Studio | ✅ Created |

### 7.3 Files Updated (Native Explore Mode - Phase 5) ✅ COMPLETE

| File | Changes | Status |
|------|---------|--------|
| `COSMO_Unified/public/index.html` | Added Explore mode HTML with graph, query, chat panels | ✅ Updated |
| `COSMO_Unified/public/js/app.js` | Added D3.js graph rendering, brain selection, query/chat handlers | ✅ Updated |
| `COSMO_Unified/public/css/unified.css` | Added Explore mode styling (500+ lines) | ✅ Updated |
| `COSMO_Unified/server/index.js` | Added Brain Data API routes for nodes/edges/query/outputs | ✅ Updated |
| `COSMO_Unified/README.md` | Updated documentation with Explore mode details | ✅ Updated |

**New API Routes Added:**
- `GET /api/brain/:name/nodes` - Paginated node data from state.json.gz
- `GET /api/brain/:name/edges` - Paginated edge data from state.json.gz
- `POST /api/brain/:name/query` - Proxy to Brain Studio query API
- `GET /api/brain/:name/outputs` - List output files
- `GET /api/output` - Serve output file content

**Note:** `launch-mode.js` and `watch-mode.js` were consolidated into `app.js` for simpler architecture.

### 7.3a Files Updated (IDE Integration - Phase 8) ✅ COMPLETE

| File | Changes | Status |
|------|---------|--------|
| `COSMO_Unified/public/index.html` | Added IDE nav tab and mode panel with iframe | ✅ Updated |
| `COSMO_Unified/public/js/app.js` | Added initIDE(), loadIDE(), refreshIDE(), popoutIDE() | ✅ Updated |
| `COSMO_Unified/public/css/unified.css` | Added IDE mode styling (.ide-container, .ide-frame) | ✅ Updated |
| `COSMO_Unified/server/index.js` | Studio auto-launch for IDE mode | ✅ Updated |
| `COSMO_BrainStudio/public/index.html` | Added light theme CSS, embedded mode CSS, theme detection | ✅ Updated |
| `COSMO_BrainStudio/public/js/editor.js` | Dynamic Monaco theme via window.IDE_THEME | ✅ Updated |

**Key Implementation Details:**
- IDE mode uses iframe with `src=localhost:3407?theme=light&embedded=true`
- Light theme activated via early script adding `.light-theme` class to body
- Embedded mode hides Docs/Research/Explore tabs, shows only Agent IDE
- Files tab auto-activated in embedded mode via `switchBrainTab('files')`

### 7.4 Files to Create (Polish - Phase 7)

| File | Purpose | Priority |
|------|---------|----------|
| `src/dashboard/js/graph-viz.js` | D3.js mini knowledge graph | P1 |
| `src/dashboard/js/thought-display.js` | Prominent animated thought | P1 |
| `src/reports/brief-generator.js` | Research report generation | P1 |

### 7.5 Files to Create (Deployment - Phase 9+)

| File | Purpose | Priority |
|------|---------|----------|
| `COSMO_Unified/Dockerfile` | Container build | P2 |
| `COSMO_Unified/fly.toml` | Fly.io deployment config | P2 |
| `COSMO_Unified/server/auth.js` | Clerk authentication | P2 |
| `COSMO_Unified/server/payments.js` | Stripe integration | P2 |

### 7.6 Existing Assets to Integrate

| Asset | Location | Integration |
|-------|----------|-------------|
| **Brain Studio** | `/path/to/COSMO_BrainStudio/` | Proxy via `/studio/*` |
| **COSMO2 Engine** | `/path/to/Cosmo2/COSMO2/` | Symlink as `engine/` |
| **Watch Panel** | `src/dashboard/intelligence.html` | Embed in `/watch` mode |
| **Existing Runs** | `COSMO2/runs/` | Shared via `COSMO_RUNS_PATH` |

### 7.7 Brain Studio Key Files (Reference)

| File | Purpose |
|------|---------|
| `server/browser.js` | Landing page, brain scanner, launch API |
| `server/server.js` | Full Studio server (Query, Explore, Agent) |
| `server/tools.js` | 17+ Agent IDE tools |
| `public/js/query-tab.js` | Query interface, 9 reasoning modes |
| `public/js/explore-tab.js` | D3.js knowledge graph |
| `public/js/ai-chat.js` | Agent IDE chat interface |

---

## 8. Success Criteria

### 8.1 MVP Success (Week 6) - ACHIEVED Dec 30, 2024

- [x] User can enter topic, click Start
- [x] Watch Panel shows real-time thoughts, agents, nodes
- [x] Cognitive state gauges animate
- [x] Activity stream with 20+ event types
- [x] Knowledge graph visualization (D3.js in Explore mode)
- [ ] Research completes with downloadable report (pending)
- [x] User can explore brain natively (no iframes, no new windows)

**Additional Achievements:**
- [x] Full configuration parity with existing launcher
- [x] Advanced Options panel with all toggles
- [x] Runtime symlink for clean starts
- [x] Brain handoff with user prompt
- [x] Native Explore mode with:
  - D3.js knowledge graph
  - Query with 9 reasoning modes
  - Chat panel
  - Output file browser
  - Brain data API reading state.json.gz directly
- [x] IDE mode with embedded Brain Studio
  - Light theme matching unified platform
  - Single Agent IDE tab (no redundant tabs)
  - Full file tree and Monaco editor
  - 17+ AI tools available
- [x] Consistent light theme throughout all 4 modes
- [x] Comprehensive README documentation

### 8.2 Launch Success (Week 10)

- [ ] Hosted and accessible via URL
- [ ] User authentication working
- [ ] Free tier functional
- [ ] Payment processing working
- [ ] Demo video created
- [ ] 100+ waitlist signups

### 8.3 Product-Market Fit Indicators

- [ ] Users complete multiple research runs
- [ ] Users return after first session
- [ ] Users share/talk about COSMO
- [ ] Conversion from free to paid > 5%
- [ ] Organic word-of-mouth growth

---

## Appendix A: Event Schema Reference

```typescript
interface COSMOEvent {
  type: string;
  timestamp: number;
  [key: string]: any;
}

interface CycleStartEvent extends COSMOEvent {
  type: 'cycle_start';
  cycle: number;
  mode: 'focus' | 'explore' | 'execute';
  cognitiveState: CognitiveState;
}

interface ThoughtGeneratedEvent extends COSMOEvent {
  type: 'thought_generated';
  cycle: number;
  thought: string;
  role: string;
  surprise: number;
  model: string;
}

interface AgentSpawnedEvent extends COSMOEvent {
  type: 'agent_spawned';
  agentId: string;
  agentType: string;
  topic?: string;
  goal?: string;
}

interface AgentCompletedEvent extends COSMOEvent {
  type: 'agent_completed';
  agentId: string;
  agentType: string;
  artifacts: string[];
  nodesCreated: number;
  edgesCreated: number;
  duration: number;
}

interface NodeCreatedEvent extends COSMOEvent {
  type: 'node_created';
  nodeId: number;
  concept: string;
  tag: string;
  cluster?: number;
}

interface EdgeCreatedEvent extends COSMOEvent {
  type: 'edge_created';
  source: number;
  target: number;
  weight: number;
}

interface CognitiveStateChangedEvent extends COSMOEvent {
  type: 'cognitive_state_changed';
  metric: 'curiosity' | 'mood' | 'energy' | 'mode';
  oldValue: number | string;
  newValue: number | string;
  trigger?: string;
}

interface SleepTriggeredEvent extends COSMOEvent {
  type: 'sleep_triggered';
  reason: 'cycles' | 'energy' | 'fatigue';
  energy: number;
  fatigue: number;
}

interface WakeTriggeredEvent extends COSMOEvent {
  type: 'wake_triggered';
  sleepDuration: number;
  consolidatedNodes: number;
}

interface InsightDetectedEvent extends COSMOEvent {
  type: 'insight_detected';
  insight: string;
  noveltyScore: number;
  source: string;
}
```

---

## Appendix B: Quick Start for New Agents

If you're a new agent picking up this spec:

1. **Read this entire document first**
2. **Verify against codebase** - don't assume, check files exist
3. **Start with Phase 1** - event system is foundation
4. **Test incrementally** - each phase should work before next
5. **Ask if unclear** - this spec is detailed but not exhaustive

Key files to understand first:
- `src/core/orchestrator.js` - The main loop
- `src/index.js` - Application entry point
- `src/dashboard/server.js` - Existing web server patterns

The user (JTR) knows this codebase intimately. When in doubt, ask.

---

*End of Specification*
