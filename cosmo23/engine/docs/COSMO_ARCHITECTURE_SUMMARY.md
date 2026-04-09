# COSMO Architecture Summary
**One-Page Executive Overview**
_Updated for V3 - Recursive Cognitive Engine_

---

## System Overview

**COSMO** (Cognitive Orchestration System for Multi-modal Operations) is an autonomous AI research system that combines bio-inspired cognitive architecture with multi-agent coordination and distributed processing. Think of it as an "AI brain" that can autonomously explore domains, form hypotheses, execute code, and synthesize knowledge.

**Key Statistics:**
- 9-layer architecture stack (V3: added cognitive substrate layer)
- 14 specialist agent types
- ~52,500 lines of Node.js code + Python verification tools
- Scales from 1 to 10+ instances
- ~$3/day operational cost (V3: infrastructure optimized, 40% cost reduction)

---

## 8-Layer Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Layer 8: DOMAIN BRAINS                                  │
│ • 14 specialist agents (research, analysis, coding...)  │
│ • GPT-5.2 powered with web search                       │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Layer 7: AUDIT & PROVENANCE                             │
│ • Dream → Goal → Research causality tracking            │
│ • Contract-driven output validation                     │
│ • Complete telemetry and event logging                  │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Layer 6: QUERY & CONSOLIDATION                          │
│ • Natural language query engine                         │
│ • Memory summarization and compression                  │
│ • Goal campaigns and synthesis                          │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Layer 5: GOVERNANCE                                     │
│ • Meta-Coordinator (strategic reviews every 20 cycles)  │
│ • Quality Assurance (validation gates)                  │
│ • Cross-agent consistency checking                      │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Layer 4: CYCLE ENGINE                                   │
│ • Orchestrator (perception → cognition → action)        │
│ • Agent executor (concurrent agent swarm)               │
│ • Sleep/wake cycles with dream consolidation           │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Layer 3: MEMORY GRAPH                                   │
│ • Network memory (concepts + associations)              │
│ • Spreading activation (context retrieval)              │
│ • Hebbian learning (strengthen co-activated links)      │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Layer 2: COGNITIVE SUBSTRATE                            │
│ • Quantum reasoner (5 parallel branches)                │
│ • Dynamic roles (self-spawning perspectives)            │
│ • Intrinsic goals (self-discovered objectives)          │
│ • Chaotic creativity (edge-of-chaos RNN)                │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│ Layer 1: OS & INFRASTRUCTURE                            │
│ • Cluster coordinator (distributed instances)           │
│ • State store (CRDT for multi-writer consistency)       │
│ • MCP bridge (AI agent introspection protocol)          │
│ • Resource monitoring and crash recovery                │
└─────────────────────────────────────────────────────────┘
```

---

## Core Data Flow

### Autonomous Cycle (60 seconds)
1. **Perception:** Gather inputs from environment, topic queue, MCP tools
2. **Cognition:** 3 roles generate thoughts → 5 quantum branches explore → Best hypothesis selected
3. **Action:** Meta-Coordinator reviews → Spawn specialist agents for high-priority goals
4. **Reflection:** Update memory graph, adjust cognitive state, save checkpoint

### Agent Execution
1. Coordinator creates mission with success criteria
2. AgentExecutor spawns specialist (research, code, synthesis, etc.)
3. Agent uses GPT-5.2 + web search + MCP tools to complete mission
4. Findings added to memory graph
5. Results validated by QA agent (optional)

### V3 Substrate Layer (Every 3 Cycles)
1. **Introspection:** Scan runtime/outputs/ using Node.js fs (zero tokens, <10ms)
2. **Memory Integration:** Create nodes tagged 'introspection' with file previews
3. **Reality Snapshot:** Load validation/drift reports, generate system alerts
4. **Semantic Routing:** Score outputs by importance, categorize for follow-ups
5. **Agent Router:** (Optional) Auto-spawn critic/synthesis/research agents
6. **Memory Governance:** (Every 20) Track activations, identify cold nodes (advisory)
7. **Recursive Planning:** (Every 30) Evaluate progress, add new goals, detect convergence

### Cluster Synchronization (every 20 cycles)
1. All instances reach review barrier
2. Each submits memory/goal diffs to Redis
3. Leader merges with CRDT (conflict-free)
4. Broadcast merged state to all instances
5. Resume autonomous operation

---

## Technology Stack

**Core:**
- Node.js 18+ (ES2022)
- OpenAI GPT-5.2, GPT-5 Mini, GPT-5.1 Codex Max (Responses API)
- text-embedding-3-small (512D vectors)

**Storage:**
- Filesystem (primary, gzipped JSON)
- Redis 7 (cluster coordination, optional)

**Containerization:**
- Docker (code execution sandboxing)
- Kubernetes (production deployment)

**Protocols:**
- MCP (Model Context Protocol) - AI agent introspection
- HTTP/JSON-RPC - API and dashboard
- WebSocket/SSE - Real-time updates

---

## Key Features

### 1. Autonomous Operation
- No human-in-the-loop required
- Self-discovers goals based on uncertainty
- Adapts behavior based on mood, curiosity, energy
- Sleep cycles with dream-based consolidation

### 2. Multi-Agent Swarm
- 14 specialist agent types
- Concurrent execution (5 agents default)
- Inter-agent messaging
- Automatic timeout and resource management

### 3. Distributed Clustering
- Active-active CRDT synchronization
- Specialization profiles (research, coding, synthesis)
- Quorum-based coordination
- Linear scalability (tested up to 10 instances)

### 4. Complete Provenance
- Dream → Goal → Research causality tracking
- Contract-driven output validation
- Agent-level audit trails
- Cross-instance attribution

### 5. Memory Network
- Graph structure with spreading activation
- Hebbian learning (co-activation strengthening)
- Small-world topology (clusters + bridges)
- Automatic summarization and pruning

### 6. Recursive Cognitive Architecture (V3)
- **Self-Awareness:** Introspects own outputs every 3 cycles, integrates into memory
- **Reality Grounding:** Thoughts based on actual evidence (validation/drift reports, file content)
- **Semantic Routing:** Scores outputs by importance, auto-spawns follow-up agents
- **Meta-Cognitive Planning:** Evaluates progress every 30 cycles, adds recursive goals
- **Intelligent Convergence:** Detects completion via goal exhaustion and stagnation
- **Deterministic Verification:** Manifests with Merkle roots, hash validation, arc reports
- **Infrastructure Optimization:** Zero LLM overhead for file operations (200x faster)

---

## Security Controls

| Control | Implementation |
|---------|----------------|
| **File Access** | Path-based allow lists, read-only mounts |
| **Code Execution** | Docker isolation, no network, resource limits |
| **API Keys** | Environment variables, secrets manager |
| **Audit Logging** | All operations logged to JSONL |
| **PII Detection** | Automatic scanning and redaction |
| **Cluster Auth** | Redis ACL, TLS, instance authentication |

---

## Deployment Options

### Single-Instance Development
- **Use Case:** Local testing, small research tasks
- **Hardware:** 4+ cores, 16 GB RAM, 50 GB SSD
- **Startup:** `./start` (interactive launcher)

### Multi-Instance Cluster (Docker Compose)
- **Use Case:** Production research, specialized workloads
- **Instances:** 3-10 (Redis coordination)
- **Specialization:** Research | Coding | Synthesis
- **Scaling:** Linear with instances

### Kubernetes Production
- **Use Case:** Enterprise, auto-scaling, HA
- **Components:** StatefulSet, Redis Sentinel, LoadBalancer
- **Monitoring:** Prometheus + Grafana
- **Backup:** Hourly state snapshots, weekly full

---

## Performance Metrics

| Metric | Single Instance (V3) | 3-Instance Cluster | V3 Improvement |
|--------|---------------------|-------------------|----------------|
| Cycles/day | ~800 | ~2,000 | - |
| Agents spawned/hour | 10-15 | 30-45 | - |
| Memory usage | 2 GB peak | 6 GB total | - |
| API calls/hour | ~200 GPT-5.2 | ~600 GPT-5.2 | - |
| Cost/day | ~$3 | ~$10 | 40% reduction (infrastructure optimized) |
| Coordinator review | <50ms | <50ms | 160x faster (MCP→fs) |
| Introspection overhead | <10ms | <10ms | Zero tokens (pure fs) |

---

## Use Cases

1. **Autonomous Research:** Explore scientific domains, find patterns, synthesize papers
2. **Evaluation Harness:** Test AI models with baselines and metrics
3. **Code Analysis:** Review codebases, detect issues, suggest improvements
4. **Document Synthesis:** Combine sources into coherent reports
5. **Hypothesis Generation:** Dream-state consolidation produces novel ideas

---

## What Makes COSMO Unique

✅ **Bio-Inspired:** Quantum reasoning, Hebbian learning, sleep/wake cycles  
✅ **Self-Directed:** Discovers own goals, no prompt engineering  
✅ **Provably Creative:** Dream → research causality tracking with influence scoring  
✅ **Production-Grade:** Crash recovery, monitoring, audit trails, clustering  
✅ **Contract-Driven:** Validates outputs against machine-readable contracts  
✅ **Recursive & Self-Aware (V3):** Introspects outputs, plans recursively, converges intelligently, verifies deterministically  

---

## Getting Started

### Prerequisites
```bash
# Required
- Node.js 18+
- OpenAI API key (GPT-5.2 access)
- 16 GB RAM minimum

# Optional (cluster mode)
- Redis 7+
- Docker (for code execution agents)
```

### Quick Start
```bash
# 1. Clone repository
git clone https://github.com/yourorg/COSMO.git
cd COSMO

# 2. Install dependencies
npm install

# 3. Configure API key
echo "OPENAI_API_KEY=sk-..." > .env

# 4. Launch interactive setup
./start

# 5. Access dashboard
open http://localhost:3344
```

### First Mission (Guided Mode)
```yaml
# src/config.yaml
architecture:
  roleSystem:
    explorationMode: guided
    guidedFocus:
      domain: "quantum computing applications"
      context: "Focus on practical use cases"
      depth: "deep"
```

---

## Next Steps

### For CTO:
- Review deployment architectures (Section 6)
- Evaluate scalability metrics (Section 7)
- Assess operational requirements (Section 8)

### For CISO:
- Review security controls (Section 5)
- Audit file access mechanisms
- Evaluate containerization security
- Review audit trail capabilities

### For Technical Architects:
- Read full technical specification (`COSMO_TECHNICAL_ARCHITECTURE.md`)
- Review component descriptions (Section 2)
- Study data flow diagrams (Section 3)
- Evaluate integration points (Section 4)

---

## Support & Documentation

- **Full Technical Spec:** `COSMO_TECHNICAL_ARCHITECTURE.md`
- **Quick Start Guide:** `docs/CONTRACT_SYSTEM_QUICKSTART.md`
- **Dream Audit System:** `docs/DREAM_AUDIT_SYSTEM.md`
- **File Access Guide:** `docs/FILE_ACCESS_GUIDE.md`
- **Implementation Details:** `IMPLEMENTATION_SUMMARY.md`

---

**Document Version:** 3.0  
**Date:** December 5, 2025  
**Maintained by:** COSMO Development Team

