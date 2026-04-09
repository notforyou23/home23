# Step 10: Ingestion Compiler — Knowledge Synthesis Before Brain Entry

**Date:** 2026-04-08
**Status:** Approved

## Summary

Add a compilation stage to the ingestion pipeline. Every document — short or long, simple or dense — gets read by an LLM that understands what the brain already knows (via a persistent index) and produces a structured synthesis. That synthesis is what enters the brain, not raw chunks. The brain receives understanding, not text.

Three input streams feed the compiler through the same pipeline: workspace files (dropped documents, notes, identity files), conversation transcripts (session history compiled at session end), and COSMO research outputs (distilled findings from completed runs).

Inspired by Karpathy's "LLM Wiki" pattern but taken further — the brain is a living knowledge graph with embeddings, edges, and cognitive loops, not a static markdown directory. The compiler is the piece that was missing: the understanding layer between raw input and memory.

## 1. The Compiler Module

New file: `engine/src/ingestion/document-compiler.js`

Sits in the existing ingestion pipeline between document conversion and chunking. For every document:

1. **Reads `BRAIN_INDEX.md`** from the agent's workspace — understands what the brain already knows
2. **Reads the full document** — text files raw, binary formats after conversion (MarkItDown for PDF/docx/xlsx only)
3. **Sends both to a fast LLM** with a synthesis prompt
4. **LLM returns a structured synthesis** — key findings, decisions, entities, claims, contradictions with existing knowledge, connections to what's already known
5. **Updates `BRAIN_INDEX.md`** — adds entries for the new knowledge
6. **Synthesis passes to chunking → embedding → brain nodes**

No documents are skipped. A 3-line decision note is as important as a 50-page research export — short documents often carry the most intentional, distilled knowledge. The compiler treats everything with the same seriousness.

### Synthesis Prompt

The compiler's prompt to the LLM (configurable, but default):

```
You are a knowledge compiler. You read documents and extract what matters.

Here is what the brain already knows (the index):
---
{BRAIN_INDEX.md contents}
---

Here is a new document ({filename}, {format}):
---
{document contents}
---

Produce a structured synthesis:
1. What is this document? (one line)
2. Key findings, decisions, claims, or entities (bulleted)
3. What's new — not already in the index
4. What contradicts or updates existing knowledge
5. What connections exist to topics already in the index
6. Index update — new entries to add (category: one-line summary)

Be concise. Extract meaning, not text. What would a sharp person remember after reading this?
```

### What the Compiler Does NOT Do

- Does not build a knowledge graph — the engine's cognitive loops do that
- Does not create edges — embedding similarity and spreading activation handle that
- Does not replace the brain — the brain is the storage layer, the compiler is the input layer
- Does not require the most powerful model — a fast cheap model is correct (this runs on every file)

## 2. The Brain Index

`BRAIN_INDEX.md` lives in the agent's workspace at `instances/<agent>/workspace/BRAIN_INDEX.md`.

A structured, LLM-maintained catalog of what the brain knows. The compiler reads it before every synthesis and updates it after. The agent can also read it directly (it's a workspace file).

### Format

Categories emerge organically — the compiler creates sections as needed. Example:

```markdown
# Brain Index

Last updated: 2026-04-08T03:51:00Z
Documents compiled: 47

## Decisions
- [2026-04-07] Architecture: Home23 uses PM2, 6 processes per agent start
- [2026-04-07] Identity: test-agent running COZ personality
- [2026-04-08] Dashboard: COSMO embedded via iframe, not separate tab

## Entities
- Jerry Garcia — musician, concert data 1990s (32 documents)
- COZ — agent identity, sharp/direct, jtr's sidekick
- Home23 — AI operating system, 4 integrated systems

## Technical Knowledge
- Brain embeddings: nomic-embed-text 768d via Ollama
- Search: cosine similarity with z-score noise filtering (z >= 3.0)
- Ingestion: feeder watches workspace, compiler synthesizes, engine stores

## Research
- (populated when COSMO research outputs are compiled)

## Conversations
- [2026-04-07 session] Built evobrew + COSMO integration, 40+ commits
- [2026-04-08 session] Fixed brain search, added noise filtering, designed compiler

## Contradictions & Open Questions
- brain_query tool fails with GPT-5.2 — OpenAI key expired
- Feeder vs engine ingestion — two parallel systems, may need consolidation
```

### Index Rules

- Updated by the compiler after every synthesis, never by the user
- Read by the compiler before every synthesis (provides existing knowledge context)
- Read by the agent as a workspace file (optional — configurable in identityFiles)
- Grows organically — no predefined schema, compiler creates categories as needed
- Entries are one-liners with date and source — dense, scannable
- The index IS the compiler's memory of what it has compiled

## 3. Conversation Continuity

The #1 input stream. Currently conversations are JSONL files the brain never sees — once the harness's history window scrolls, knowledge is lost.

### Flow

1. The harness detects a session gap (`sessionGapMs` — default 30 minutes of silence)
2. Assembles the session's conversation transcript (from the JSONL)
3. Writes it as a file to a known location (e.g., `instances/<agent>/conversations/sessions/session-<timestamp>.md`)
4. The feeder picks it up
5. The compiler reads the index + the transcript
6. Produces a synthesis: what was discussed, what was decided, what the user cares about, what commitments were made, what changed
7. Updates the index under Conversations
8. Synthesis enters the brain

The raw JSONL stays as the archive. The compiled synthesis is what the brain remembers — like remembering the takeaways from a meeting, not the verbatim transcript.

## 4. COSMO Research Integration

When a COSMO research run completes, the compiler can distill its findings into the agent's brain.

### Flow

1. Agent's `research` tool gets a new action: `compile`
2. Reads the completed run's key outputs — coordinator reviews, final synthesis, top findings (not all 3,000 raw nodes)
3. Writes a summary document to the workspace
4. Feeder picks it up → compiler processes it like any other document
5. Index updated under Research
6. Agent's brain gets the compiled knowledge

The full COSMO brain stays separate and queryable in evobrew — nothing lost. The agent's brain gets the distilled understanding.

Triggerable manually (`research({ action: "compile", runId: "..." })`) or automatically when a run completes (configurable).

## 5. Pipeline Integration

Three input paths, one compiler, one brain:

```
Workspace file dropped      → feeder watches → compiler → chunk → embed → brain
Conversation session ends   → harness writes transcript → feeder → compiler → brain
COSMO run completes         → research tool writes summary → feeder → compiler → brain
```

### Where in the Existing Code

The compiler plugs into `engine/src/ingestion/document-feeder.js` in the `_processFile` method, after conversion but before chunking:

```
Current:  Convert → Chunk → Validate → Classify → Embed → Brain
New:      Convert (if binary) → COMPILE → Chunk → Embed → Brain
```

The validator and classifier may become redundant — the compiler's synthesis is already validated (LLM-produced) and classified (the index tracks categories). But they can stay as safety checks initially.

### Dependencies

- `document-feeder.js` — calls the compiler in `_processFile`
- `document-converter.js` — still needed for binary formats only
- `BRAIN_INDEX.md` — read/written by compiler, lives in workspace
- LLM client — uses the engine's existing OpenAI-compatible client
- Config — compiler model configurable in engine config (`models.compiler`)

## 6. Model Configuration

The compiler gets its own model role in the engine config:

```yaml
models:
  thought: nemotron-3-nano:30b
  consolidation: nemotron-3-nano:30b
  dreaming: nemotron-3-nano:30b
  query: nemotron-3-nano:30b
  compiler: minimax-m2.7          # fast, cheap, good at synthesis
```

Configurable per-agent in `instances/<agent>/config.yaml` under `engine.compiler`. Defaults to `minimax-m2.7`. Should be a fast model — this runs on every ingestion.

## 7. What Needs Building

1. `engine/src/ingestion/document-compiler.js` — the compiler module
2. `BRAIN_INDEX.md` — initial empty template in workspace
3. Modify `document-feeder.js` — call compiler between convert and chunk
4. Conversation session writer in harness (`src/home.ts`) — detect session gap, write transcript
5. Research compile action in `src/agent/tools/research.ts`
6. Config additions — `models.compiler` in base-engine.yaml and agent configs
7. Add `BRAIN_INDEX.md` to agent identity files (optional, configurable)

## 8. Design Principles

- The brain receives understanding, not text — like a human mind
- Every document gets compiled, no exceptions — short notes carry the most signal
- The index is the compiler's memory — enables knowledge to compound, not just accumulate
- Conversation continuity is sacred — sessions must persist beyond the chat window
- The compiler is fast and cheap — it runs on every file, can't be a bottleneck
- Raw sources are preserved — JSONL archives, COSMO brains, original files all stay
- The engine's cognitive loops do the deep work — the compiler provides better food

## 9. The Analogy

```
Raw input        → eyes (sensory input)
Converter        → retina (signal transduction, binary → text)
Compiler + Index → thalamus (pre-processing, context-aware filtering)
Brain nodes      → cortex (storage, association, retrieval)
Cognitive loops  → sleep (consolidation, dreaming, edge-building)
```

The compiler is the thalamus — the relay station that processes raw input into something the cortex can use, informed by what the brain already knows.
