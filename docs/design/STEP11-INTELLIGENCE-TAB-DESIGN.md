# Step 11: Intelligence Tab — Living Brain View

**Date:** 2026-04-08
**Status:** Approved

## Summary

The dashboard's Intelligence tab becomes a living window into the agent's brain. A synthesis agent periodically queries the brain and produces `brain-state.json` — structured, curated content that the Intelligence tab renders. Everything comes from real brain data: actual nodes, actual search results, the actual BRAIN_INDEX.md. No stubs, no placeholders, no simulated content.

Focused on the primary agent. Works with any brain. Built and tested against what we have now.

## 1. The Intelligence Tab

The dashboard's existing empty Intelligence tab becomes the brain-view. When clicked, it shows:

- **Brain Vitals** — node count, edge count, cycle count, documents compiled, last synthesis timestamp
- **Self-Understanding** — what the brain knows about itself (synthesized from identity files + meta brain nodes). Current obsessions. How it sees its relationship to the user.
- **Compiled Knowledge** — the BRAIN_INDEX.md content rendered as structured categories. This is the compiler's output — what the brain actually knows, organized by topic.
- **Consolidated Insights** — the synthesis agent's curated highlights. The strongest, most recent, most connected findings from the brain. Each with title, excerpt, source reference, and themes.
- **Recent Activity** — latest compiled documents, recent conversation sessions, recent cognitive cycles.

All data comes from `brain-state.json` served via API. The tab reads it, renders it. Same ReginaCosmo dark theme as the Home tab — cards, accents, typography all match. Not a separate design system.

If the brain is fresh (few nodes, no synthesis yet), the tab shows real state: "3 nodes, 0 documents compiled, no synthesis yet." Never fake content to fill space.

## 2. The Synthesis Agent

New module: `engine/src/synthesis/synthesis-agent.js`. Runs in-process inside the engine (not a separate PM2 process).

### Two trigger paths:

**Scheduled:** Runs every N hours (configurable, default 4 hours). Uses a simple `setInterval` in the dashboard server process (not the engine process — the dashboard is always running and has access to the brain directory and APIs).

**On-demand:** Dashboard exposes `POST /api/synthesis/run`. The Intelligence tab has a "Run Synthesis" button. Returns immediately ("synthesis started"), writes `brain-state.json` when done.

### What it does:

1. **Reads `BRAIN_INDEX.md`** from the agent's workspace — the compiler's catalog of what the brain knows
2. **Queries `/api/memory/search`** with key themes extracted from the index categories — gets the strongest, most relevant nodes for each topic
3. **Queries `/api/state`** for brain vitals — cycle count, node count, edge count
4. **Reads identity files** (SOUL.md, MISSION.md) for self-understanding context
5. **Sends everything to the LLM** (same compiler model, minimax-m2.7 via Ollama Cloud) with a synthesis prompt: "Given this brain's index, identity, and representative nodes, produce: self-understanding summary, top consolidated insights, current themes, recent activity highlights"
6. **Writes `brain-state.json`** to the agent's brain directory

Uses the same LLM client pattern as the ingestion compiler — Ollama Cloud, fast model, simple chat completion. The synthesis prompt asks for structured JSON output so parsing is deterministic.

### Synthesis prompt (default):

```
You are a brain synthesis agent. You read a brain's index, identity, and sample nodes, and produce a structured overview of what this brain knows and what matters.

Brain identity:
---
{SOUL.md content}
{MISSION.md content}
---

Brain index (what has been compiled):
---
{BRAIN_INDEX.md content}
---

Sample nodes from key topics (from semantic search):
---
{Top nodes per index category}
---

Brain stats: {nodes} nodes, {edges} edges, {cycles} cycles, {documentsCompiled} documents compiled.

Produce a JSON object with these fields:
- selfUnderstanding: { summary (2-3 sentences), currentObsessions (array of strings), relationship (one sentence about relationship to user) }
- consolidatedInsights: array of { title, excerpt (2-3 sentences), source (which topic/category), themes (array) } — the 5 most important things this brain knows
- recentActivity: array of strings — what's happened recently (latest compilations, sessions, cycles)

Be grounded in the actual content. Do not invent or speculate. If the brain is sparse, say so honestly.
```

## 3. brain-state.json

Lives at `instances/<agent>/brain/brain-state.json`. Written by the synthesis agent, read by the dashboard.

```json
{
  "generatedAt": "2026-04-08T15:00:00Z",
  "trigger": "scheduled",
  "model": "minimax-m2.7",
  "brainStats": {
    "nodes": 6420,
    "edges": 22468,
    "cycles": 170,
    "documentsCompiled": 12
  },
  "selfUnderstanding": {
    "summary": "...",
    "currentObsessions": ["...", "..."],
    "relationship": "..."
  },
  "consolidatedInsights": [
    {
      "title": "...",
      "excerpt": "...",
      "source": "...",
      "themes": ["...", "..."]
    }
  ],
  "knowledgeIndex": "...(raw BRAIN_INDEX.md content)...",
  "recentActivity": ["...", "..."]
}
```

All fields from real brain data. Empty brain = empty arrays and honest messages.

## 4. Dashboard Integration

### New endpoints on dashboard server (`engine/src/dashboard/server.js`):

- `GET /api/synthesis/state` — serves `brain-state.json` from the brain directory. Returns `{}` if no synthesis has run yet.
- `POST /api/synthesis/run` — triggers the synthesis agent asynchronously. Returns `{ started: true }` immediately. Writes brain-state.json when done.

### Intelligence tab in dashboard JS:

- On tab click: fetch `GET /api/synthesis/state`, render all sections as styled cards
- "Run Synthesis" button: calls `POST /api/synthesis/run`, shows loading indicator, polls for updated state
- Auto-refresh: same 30s pattern as other tabs when Intelligence is active
- Uses existing dashboard dark theme, card components, typography

### Intelligence tab HTML structure:

```html
<div class="h23-panel h23-intel-panel" id="intel-panel">
  <!-- Brain Vitals -->
  <div class="h23-intel-vitals" id="intel-vitals"></div>
  
  <!-- Self Understanding -->
  <div class="h23-intel-self" id="intel-self"></div>
  
  <!-- Compiled Knowledge (from BRAIN_INDEX.md) -->
  <div class="h23-intel-index" id="intel-index"></div>
  
  <!-- Consolidated Insights -->
  <div class="h23-intel-insights" id="intel-insights"></div>
  
  <!-- Recent Activity -->
  <div class="h23-intel-activity" id="intel-activity"></div>
  
  <!-- Run Synthesis button -->
  <button class="h23-intel-synth-btn" id="intel-synth-btn">Run Synthesis</button>
</div>
```

## 5. Connection to Ingestion Compiler

The synthesis agent and compiler are complementary:

- **Compiler** runs on every document IN → produces BRAIN_INDEX.md (what we know)
- **Synthesis agent** runs periodically → reads index + brain → produces brain-state.json (what it all means)

The richer the index, the better the synthesis. They compound each other. No wiring needed between them — they share the filesystem (BRAIN_INDEX.md) and the brain API.

## 6. What Needs Building

1. `engine/src/synthesis/synthesis-agent.js` — the synthesis agent module
2. Dashboard server endpoints — `GET /api/synthesis/state` + `POST /api/synthesis/run`
3. Intelligence tab HTML — replace empty placeholder with real panel structure
4. Intelligence tab CSS — styling for vitals, self-understanding, insights, activity cards
5. Intelligence tab JS — fetch state, render sections, run synthesis button, auto-refresh
6. Scheduled trigger — wire synthesis agent into engine's timer/interval system
7. Config — synthesis interval, model settings in base-engine.yaml

## 7. Design Principles

- Everything from the real brain. No stubs, no placeholders, no simulated content.
- Focused on primary agent, works with any brain.
- Same dark theme as the rest of the dashboard.
- The synthesis agent is the curator — it reads the brain and decides what to surface.
- The BRAIN_INDEX.md is the bridge between the compiler and the synthesis agent.
- Scheduled + manual trigger. Always fresh, always available.
