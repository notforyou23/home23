# Brain/Vault Decontamination — Design

**Date:** 2026-07-15
**Status:** **Design approved by jtr** — all open design decisions closed (§7). Blocked on the
tracing work in §7.6–7.15 before implementation. Retrieval is a separate follow-on spec (§8).
**Scope:** **Vault + Brain.** Home23 engine (ingestion, memory, cognition, agency, good-life), jerry +
forrest instances, and the consolidation of jtr's corpus from four locations into one vault (§4.0).
**Out of scope:** live connectors (calendar, email, home/tesla devices) — per jtr, *"that's not the
important stuff for a persistent Brain, which is the overall goal."* See §1.15.
**First deliverable:** the Claude atomizer (§4.1e-1) — proves the design against real material.

> **The goal is a persistent Brain.** Not a connected agent — an enduring one. The Brain is the part
> that makes an agent persistent rather than merely in contact with things.

---

## 1. The Problem, Measured

Every number below was measured against the live system on 2026-07-15. They are stated first
because they are what make the design obvious, and because they are how a wrong design gets caught.

### 1.1 The cortex is mostly the machine's diary

Sampled 3,123 live brain nodes from jerry's current memory delta:

| Category | Share |
|---|---|
| Self-referential (machine narrating itself) | **~70%** |
| Records of non-events ("0 documents", "empty session", `NO_ACTION`) | ~25% |
| Knowledge about jtr's actual world | **~4%** |

Jerry's brain is **143,479 nodes / 471,118 edges** (live engine, 2026-07-15T14:56). Roughly **5,700**
of those nodes are about jtr's life.

**It has more than doubled since May 7** (65,100 nodes), growing **~1,135 nodes/day** — of which
**~45/day are about jtr and ~1,090/day are about itself.**

Verbatim node contents from the sample:

```
[STATE_SNAPSHOT] RECENT.md as of cycle 41633. # Recent Activity — covers last 48h
[AGENT INSIGHT: agent_1783691902660] Total content analyzed: 0 words across 0 documents
[AGENT: agent_1783710665719] {"documentCount":0,"documents":[]}
NO_ACTION  One clear insight: this is a procedural/meta request, so no operational action is needed.
"An empty session boundary capture for cron-agent-0a4082a3 — zero dialogue, no tool calls"
```

`RECENT.md` — the curator-generated surface that *summarizes the brain* — is ingested back into the
brain as permanent nodes. Six copies appeared in a 3,123-node sample. The summary of the cortex
becomes the cortex; the next summary then summarizes that.

### 1.2 The signature of the garbage

Every garbage node is **a durable record that nothing happened**. Not "it is about Home23" —
conversations about Home23 are real events with real residue. The garbage is specifically the
documentation of non-events: a loop ticked, so a record was written.

This is the distinction the whole design rests on:

> **Something happened** (a conversation, a run, an MRI, a memory extraction, a document) → artifact, worth keeping, any volume.
> **A loop ticked** (cycle elapsed, pursuit selected, gate declined, 0 documents analyzed) → not an event, no record.

### 1.3 Every removal mechanism is disabled or neutered

The brain grew to 143,479 nodes because **each independent safeguard against exactly this was turned
off**, each for a locally reasonable reason:

1. **The feeder points at the agents' own exhaust.** 6 of jerry's 7 watch paths are his own output
   (`workspace/sessions`, `workspace/memory`, `workspace/reports`, `workspace/cron`, ...). One is jtr's
   world. 5 of forrest's 6 are his own output. **The 70% self-narration is exactly what those watch
   paths predict.**
2. **Decay explicitly exempts the garbage.** `configs/base-engine.yaml`:
   ```yaml
   decay:
     exemptTags: [agent_insight, agent_finding, mission_plan, cross_agent_pattern]
   ```
   `[AGENT INSIGHT] Total content analyzed: 0 words` is tagged `agent_insight` and is therefore
   **immune to decay by configuration**. jtr's real notes decay. "I analyzed zero documents" is protected.
3. **The pruner does not prune.** `engine/src/cognition/actions/prune-stale-cluster.js`:
   > *"Marks low-activation nodes in a cluster as stale. Does NOT delete. A subsequent memory audit
   > pass can review the stale-flagged nodes and purge them if the user confirms."*

   Asked to remove content, it emits a flag — pending a confirmation that has never occurred.
4. **The garbage collector is disabled — by the system's own quality control.**
   `engine/src/memory/summarizer.js`:
   ```js
   // Disabled by default after repeated brain_node_count_stable regressions:
   // this routine deletes durable knowledge based on weak access heuristics...
   if (!this.config?.memory?.enableGarbageCollection) return 0;
   ```
   `brain_node_count_stable` is a **live-problem verifier** — the deterministic fault-detection
   subsystem. It encodes the assumption that a falling node count is a fault. The GC did its job, the
   count fell, the verifier fired, and the fix was to fire the janitor. **The system is graded on the
   size of its own record and successfully defended that number against its own cleanup.**
5. **Dreams add prose to memory on a coin flip.** `engine/src/core/orchestrator.js:4266`:
   ```js
   if (Math.random() < 0.2) {
     await this.memory.addNode(`[DREAM] ${dreamThought.hypothesis}`, 'dream');
   }
   ```
   A 1-in-5 dice roll decides whether a dream becomes permanent knowledge — with no relationship to
   whether the dream produced a goal, rewired anything, or did any work at all.

**The disabled GC was correctly disabled.** Its heuristics are `weight < 0.1 && not accessed in 7
days`, or `age > 30 days && accessCount === 0`. jtr's MRI report node — never accessed, months old,
`accessCount: 0` — would be deleted, while freshly-written receipts survive. It deletes by *access
frequency*, which is backwards: the most important memories are the ones rarely touched. Its own
comment states the precondition for re-enabling: *"Re-enable only ... after a safer archival/
compaction policy exists."* This design supplies that policy.

### 1.4 Every safeguard against the theatre became a theatre

`good-life-restraint-receipts.jsonl` — **12.3 MB, 14,448 records, 144 in the last 24 hours**:

```json
{"status":"throttled", "reason":"equivalent_policy_recently_routed",
 "summary":"help - strained continuity drift",
 "doctrine":"Restraint needs receipts when an autonomous gate prevents work."}
```

The system writes a durable record every time it decides **not** to act. It is doctrine. Since
2026-05-11, every five minutes, jerry has recorded: *"something is wrong with my continuity, I have
decided not to act on it, and I have written that down."*

The pattern generalizes. Loops made too much work → a throttle was added → the throttle needed
accountability → accountability was implemented as a durable record → **the throttle now produces
work**. The editor's veto gets a receipt. The kill review gets a receipt and a consequence record.
`good-life-operator.js` is 2,796 lines auditing whether the system's projections of its own goals are
consistent with its own state, and it emits warnings, which are records.

**There is no bottom.** Every floor built to stand above the theatre is made of the same material.

Governance mass:

| | lines |
|---|---|
| Agency spine (`engine/src/agency/`) | 4,087 |
| Good Life + operator | 4,782 |
| **Total** | **8,869** |
| `editor.js` — the only component that can say *no* | **59** |

The one component that can refuse is 0.7% of the governance layer, is implemented as a keyword
blocklist (including a hardcoded veto for the literal phrase *"home23 ... becomes ... feedback
loop"* — someone already caught it narrating its own loops and blocklisted that sentence), and its
final line is `return { verdict: 'allow' }`. **Allow-by-default.** A blocklist cannot enumerate the
shapes of generated prose.

`orchestrator.recordGoodLifeAgendaAction()` closes the ring explicitly — an agenda item's terminal
executor writes a receipt with `status: 'recorded'`, `verifier: 'next domain.good-life evaluation'`,
and returns `directAction: true`. The verifier is a **string naming the loop that authored the work**.

### 1.5 Corroborating evidence: the theatre is a function of the code, not the world

```
jerry/brain/good-life-restraint-receipts.jsonl     12,296,819 bytes
forrest/brain/good-life-restraint-receipts.jsonl   12,321,836 bytes
```

**0.2% apart.** Two agents with different roles, domains, and workspaces produced statistically
identical volumes. If this output were a function of the world, they would diverge. They do not.
It is a function of the machinery, and they run the same machinery.

*(This number was initially and wrongly read as evidence that forrest is redundant. It is not.
Forrest is jtr's health agent — HRV, sleep, VO2, barometric sensitivity, herniated discs. The
governance files match because the governance code is shared; forrest's real work lives elsewhere.
See §4.6.)*

### 1.6 Ingestion: what is and isn't working

**Working.** Real-world sources ingest cleanly:

```
jtr_life + jtr_voice + garcia_jerry:  5,342 entries → 7,735 nodes, only 26 produced zero
parseStatus across manifest: ok 20,922 | suspect_truncation 1,140 | conversion_failed 3
```

**Broken — `node_modules` was ingested.** The `projects` label points at
`/Users/jtr/_JTR23_/cosmo-home_2.3/projects/`, and `**/node_modules/**` did not apply:

```
projects: 5,057 entries → 141 nodes
  travel/node_modules/wrappy/package.json  → 1 node
  travel/node_modules/vary/index.js        → 2 nodes
```

~141 nodes of npm package metadata are in jerry's cortex.

**Broken — non-events cost LLM calls and become nodes.** 4,964 manifest entries (22%) produced zero
nodes; 313 are quarantined. The compiler spent LLM calls synthesizing documents it correctly
identified as empty, then stored those syntheses as permanent nodes:

> *"A session-boundary stub from a Codex harness smoke-test chat — a single entry with zero dialogue,
> no substantive content"*

### 1.7 Provenance: 82% of the brain has no source

```
manifest entries        : 22,067
entries with nodeIds    : 17,103   (4,964 empty, 313 quarantined)
distinct nodeIds claimed: 26,454
brain nodes             : 143,479   (live engine, authoritative)
→ orphans (no source doc): 117,025   (82%)
```

Every sampled orphan carries a literal machine-emitted prefix: `[STATE_SNAPSHOT]`, `[AGENT:`,
`[AGENT INSIGHT:`, `NO_ACTION`, `[CONSOLIDATED]`, `[DREAM]`. The garbage announces itself in a fixed
vocabulary from known code paths.

**This is why the brain feels precious and why deleting it feels dangerous.** 117,025 nodes exist
nowhere else on earth. They are not a projection of anything. That fear is a symptom of the
pollution, not a property of brains.

### 1.8 The doors — the feeder is one of ~23

**This invalidated the first draft of this spec.** 117,025 nodes have no manifest entry, which means
they never came through the feeder. Fixing watch paths does nothing to them. `memory.addNode()` call
sites outside `network-memory.js`:

| Site | What it writes |
|---|---|
| `ingestion/ingestion-manifest.js` | **the feeder** — the only door the first draft closed |
| `agents/base-agent.js` ×2 | `[AGENT: id] finding` / `[AGENT INSIGHT: id] insight` ← **source of "0 words across 0 documents"** |
| `core/orchestrator.js` ×10 | incl. `state_snapshot` (§1.8.1), `addNode(content, 'consolidated')`, dreams |
| `artifacts/artifact-{ingestor,lifecycle,registry}.js` ×3 | artifact deliverables |
| `circulatory/composter.js` | `addNode(summary, 'compost_receipt')` ← **the janitor writes receipts into what it cleans** |
| `cognition/trajectory-fork.js` ×2 | forked trajectories |
| `cognition/actions/promote-to-memory.js` | `agent_promoted` |
| `memory/pin-canonical-nodes.js` | pinned canonical nodes |
| `goals/goal-curator.js` | goal resolutions |

**Tag census** (3,123 nodes sampled from jerry's recent delta — this maps nodes to doors):

| Tag | Count | Share | Door |
|---|---|---|---|
| `conversation_sessions` | 1,837 | **58.8%** | feeder — **KEEP** |
| `state_snapshot` | 944 | **30.2%** | orchestrator direct — RECENT.md |
| `consolidated` | 91 | 2.9% | orchestrator |
| `curator` | 47 | 1.5% | curator-cycle |
| `agent_insight` | 20 | 0.6% | base-agent |
| `synthesis_report`, `document_*`, `analyst`, `critic`, `introspection`, `proposal`, `curiosity`, `dream`, ... | ~180 | ~5% | various |
| **`jtr_life`** | **2** | **0.1%** | feeder |

Recent brain growth is **89% two sources** (conversations + RECENT.md re-ingestion). jtr's actual
life is **0.1%**.

#### 1.8.1 `state_snapshot` — 30% of growth, and the first draft's fix was aimed at the wrong door

`orchestrator.js:7505` reads `RECENT.md` **directly off disk — not via the feeder**:

```js
content = await fs.readFile(path.join(workspacePath, 'RECENT.md'), 'utf8');
const hash = crypto.createHash('sha256').update(trimmed).digest('hex');
if (hash === this.lastStateSnapshotHash) return;      // dedup gate
await this.memory.addNode({
  concept: `[STATE_SNAPSHOT] RECENT.md as of cycle ${this.cycleCount}.\n\n${body}`,
  tag: 'state_snapshot',
  confidence_decay: 1,        // never decays
  status: 'current',
});
```

1. Removing `workspace/memory` from watch paths **does nothing** — this is a direct read.
2. **The dedup gate is defeated by RECENT.md's own timestamp.** The curator stamps every
   regeneration (`_Generated: 2026-07-09T07:15:17.722Z_`) → new hash → gate always passes → new node
   every regeneration. The dedup was designed correctly; the content guarantees it can never fire.
3. `confidence_decay: 1` — never decays, on top of the `exemptTags` immunity.

### 1.9 Retrieval works because the garbage is hidden at read time

`engine/src/memory/provenance-salience.js` is a **retrieval-time salience filter**:

```js
const AUTONOMOUS_TAGS = new Set(['reasoning','curator','critic','analyst','curiosity',
  'proposal','novel_hypothesis','synthesis','synthesis_report','deep_thought',
  'introspection','agent_insight','analysis_insight']);
const IDENTITY_TAGS  = new Set(['jtr_life','garcia_jerry','legacy_jtrbrain_feed','daily-notes']);
const TELEMETRY_TAGS = new Set(['jerry_cron_docs','cron','telemetry','metrics']);
return Math.pow(0.5, ageDays / halfLifeDays);   // telemetry decays at retrieval time
```

**This is why retrieval is not experienced as a problem.** The system's response to "the brain is
full of garbage" was to **hide the garbage from retrieval rather than stop making it**. The symptom
was suppressed at the read side while the disease grew underneath — which is how it reached 143,479
nodes without anyone noticing.

**Consequence for this design (the good news):** the classifier this spec needs **already exists,
already ships, and is already trusted in production**. It knows `jtr_life` / `garcia_jerry` are jtr
and `curator` / `introspection` / `agent_insight` are the machine. We do not invent a classifier —
we move this one from read-time to **write-time and GC-time**.

### 1.10 The vault is not what it appears, and its richest sources report false success

```
/Users/jtr/life/                             771 MB, 4,392 files
  areas/chat.html                            471 MB   "<title>ChatGPT Data Export</title>"
  areas/checkpoint-15880.json                185 MB   engine state dump + critic journal
  areas/jerry_garcia                          55 MB   research + agent outputs + 649 .complete markers
  areas/jtr_antrhopic_archive                 47 MB
  areas/projects                             3.9 MB
  feed/                                      7.9 MB   11 md, 9 txt, 4 csv, 2 pdf (MRI Report.pdf)
  areas/{infrastructure,runs,people,entities,companies,methodologies}   ~800 KB total
  areas/memory-extraction/                   ~16 files, dated md, ~1.5 KB each  ← real, ideal vault material
```

**656 MB (85%) of the "vault" is two files.** Measured fate — *not* what a `maxFileBytes: 5242880`
reading would predict:

```
chat.html               471.3 MB   label=jtr_life   parse=ok              nodes=1   quarantined=False
checkpoint-15880.json   185.0 MB   label=jtr_life   parse=un_normalizable nodes=0   quarantined=True
```

- **`chat.html` (471 MB) is jtr's complete ChatGPT export, and it produced ONE node, marked `ok`.**
  It did not trip the size limit. It is recorded as a success. **This is worse than being skipped** — a
  skip leaves a log line; a false success leaves a green tick nobody will ever question. The single
  richest record of jtr's own thinking is one node deep, and the manifest says it worked. See §4.1c.
- **`checkpoint-15880.json` (185 MB)** is an engine state checkpoint whose payload is a journal of
  machine thoughts (`{"cycle":15695,"role":"critic","thought":"Insight: Many assume..."}`). Correctly
  quarantined as `un_normalizable`. jtr flagged checkpoints as partly valuable; this one is largely
  the diary. **Judgment call — see §7.**
- **`MRI Report.pdf`** — `conversion_failed`, quarantined, 0 nodes. The markitdown venv python call
  errored. Jerry cannot read it; forrest does not watch the folder. **Nobody has jtr's MRI.**

The real, human-scale vault is closer to **~15 MB** (`feed/`, `memory-extraction/`, `people`,
`entities`, `companies`, `infrastructure`, `runs`, `methodologies`) plus `jerry_garcia` and
`jtr_antrhopic_archive`. The "45% JSON" alarm resolves benignly: the JSON is concentrated in two
oversized machine dumps the feeder already skips.

### 1.11 Forrest, measured

The first draft made claims about forrest from jerry's data. Measured directly:

```
FORREST manifest: 5,450 entries
  workspace              4,716 → 6,564 nodes   (83% of his claimed brain — his own identity/output files)
  conversation_sessions    449 →   843
  trail_running            248 →   468
  research_runs             23 →    30
  reports                   13 →    21
  memory_snapshots           1 →     1
  total claimed: 7,927     parseStatus: ok 5,445 | suspect_truncation 5
```

**Forrest has zero `jtr_life` nodes, zero `jtr_voice`, zero health-log nodes.** His entire
world-facing knowledge is 468 trail-running nodes and 843 conversation nodes. **83% of his brain is
his own workspace.** The health agent's cortex contains no health data.

### 1.12 The feedback path — why the agent cannot stop narrating

1. Loops write prose (receipts, snapshots, remarks, `NO_ACTION`)
2. The feeder watches `workspace/` and ingests it
3. Prose becomes brain nodes
4. `src/agent/context-assembly.ts` queries the brain **before every turn**
5. The query returns the diary — because the diary is 70% of the brain
6. The diary **is** the agent's situational awareness
7. It thinks about it, produces prose; the curator writes `RECENT.md` → **goto 2**

The agent is not choosing to narrate itself. It is **fed its own diary as its picture of the world,
every turn, by design**. When it asks "what is going on?", 70% of the answer is "you were talking
about yourself."

### 1.13 Two lenses on one brain — why jtr never saw it

**jtr and the agent read the same brain through different retrieval systems, and only one is broken.**

| Path | Mechanism | Used by |
|---|---|---|
| **PGS** (`src/agent/tools/brain.ts`, `/home23/api/query/run`) | 82 partitions, each with `centroidEmbedding`, `summary`, `keywords`, `adjacentPartitions`; modes fresh/continue/targeted, levels skim/sample/deep/full | **jtr's dashboard Query tab**, and the agent's *deliberate* brain tool |
| **Single-seed** (`network-memory.js:1911 query()`) | one best-cosine seed → 3-hop spread | **`context-assembly.ts` — the agent's automatic pre-turn context, every turn** |

`network-memory.query()`, verbatim:

```js
let bestMatch = null; let bestSimilarity = 0;
for (const [id, node] of this.nodes) {                 // linear scan of all 143,479
  const similarity = this.cosineSimilarity(queryEmbedding, node.embedding);
  if (similarity > bestSimilarity) { bestSimilarity = similarity; bestMatch = id; }
}
const activated = await this.spreadActivation(bestMatch, null, {...});   // ← from ONE node
```

**The entire pre-turn context is one node's neighbourhood.** With `maxDepth: 3`,
`decayFactor: 0.7`, `activationThreshold: 0.1`, the reachable set is a few hundred nodes out of
143,479. The rest are not ranked low — **they are unreachable for that query.**

Three compounding defects:

1. **Single seed.** If the best cosine match lands in the diary — and the diary is 70% of the brain —
   the walk stays in the diary. **This is the mechanism of §1.12, exactly.**
2. **`state_snapshot` nodes are force-injected.** `findRelevantStateSnapshots()` pushes RECENT.md
   snapshots into results **even when spreading activation never reached them** — bypassing the graph
   entirely. The ouroboros is not merely 30% of the brain; it is *privileged at retrieval*. Note this
   fights §1.9's `provenance-salience` filter, which then downranks the very nodes just injected.
3. **The 461 MB ANN index is not used by this path.** `query()` does a full linear cosine scan over
   143,479 × 768-dim vectors. The index (plus a 139 MB meta file) is built and maintained but the
   pre-turn path ignores it.

**This is why jtr reports retrieval as healthy — it is.** He has been using PGS the whole time. The
broken lens is the one the agent cannot choose, and it is pointed at the diary.

**Scope:** the *fix* (context-assembly on PGS, grounding/citation chain, partition quality — the
largest partition holds 32,965 nodes, 24% of the brain in one blob, which is what pollution does to
clustering) belongs to a **separate retrieval spec, to follow this one** (§8). Decontamination first:
PGS partitions are rebuilt during reingest anyway, so retrieval tuned against a 70%-diary corpus would
need re-tuning after. **Fix what it sees, then fix how it sees.**

---

### 1.14 THE REAL FINDING — the brain has 5% of jtr's corpus

**Everything above diagnoses the garbage. This is what was missed: the absence.**

Discovery sweep across every location holding jtr's material (human-readable docs only —
`.md`/`.txt`/`.pdf`, excluding `node_modules`/`.git`/`dist`):

```
                    docs     ingested    unread
cosmo-home        28,962       1,531    27,431      2.4 GB
cosmo-home_2.3     7,808         364     7,444      1.6 GB
.openclaw         12,061           0    12,061      3.6 GB  (agents/: claude, codex, main — 410 MB)
/Users/jtr/life/     796         794         2      ← 99.7% ingested
────────────────────────────────────────────────
TOTAL             49,627       2,689    46,938      → 5% ingested
```

*(Including `.json`/`.jsonl`: 106,295 files, 5,021 ingested, **101,274 never read**.)*

**jtr has 49,627 documents. The brain has read 2,689 of them.**

Set against §1.7 and the tracing results:

> **The brain holds ~49,488 nodes of npm package metadata — more than jtr has documents in total —
> and has never opened 46,938 of his files.**

**The vault mechanism is not broken.** `/Users/jtr/life/` is **99.7% ingested**. The feeder, manifest,
chunker, and compiler work. **The vault is simply 3% of jtr's corpus.** Every fix in §4 — atomizer,
yield check, catalog rule, event gate — is correct and was aimed at a folder holding a twentieth of
jtr's life.

**This inverts the project's centre of gravity.** §4.1's keep/drop table optimises which *slice of the
exhaust* to stop ingesting. The real work is that **jtr's material is scattered across four locations
and 95% of it has never been seen.** Consolidation is not cleanup preparation — **it is the project.**

**jtr's directive (2026-07-15):** *"I don't care about sticking to whatever ingestion paths/folders
were set. If we need to reorganize to make it better we do that. Those old cosmo-home data files are
all legit and good files — I need to bring them into home23. I aim to archive all other home and cosmo
instances so we save space and clean things up. I also had files scattered across other places like
.openclaw. If I need to pull into one location for ease of everything then we do that."*

**Consequences for this spec:**

- **§4.1's keep/drop table is superseded in spirit.** The signed-off *drops* stand (they are exhaust).
  The *keeps* are no longer a list of legacy paths to preserve — they are inputs to a consolidation.
  The `jtr_voice`/`garcia_jerry`/`legacy_cosmo23_memory` "trap" (§7.7) dissolves: those files **move
  into the vault** rather than being re-added as watch paths to a dying install.
- **§4.5's rebuild scope (9,939 files → 77,425 chunks → 14–29h) is for the wrong corpus.** The real
  corpus is ~49,627 documents. The rebuild is **substantially larger — and worth it**, because it is
  the difference between a brain holding 5% of jtr's life and one holding all of it.
- **The 26 instances under `/Users/jtr/_JTR23_/` are archivable** once consolidated: `cosmo-home`
  (2.4 G) + `cosmo-home_2.3` (1.6 G) + `cosmo_2.3` (1.1 G) + `.openclaw` (3.6 G) ≈ **8.7 GB reclaimed**,
  and — more importantly — **one location instead of four.**
- **`workspace/jtr` (4,131 files, 2,194 dated session summaries, zero ingested)** is part of this: real
  write-once artifacts that belong in the vault (§7 correction 6).

**This is the answer to "we kept doubling down."** Every remedy in this document's history addressed
the *presence* of garbage. **None addressed the absence of jtr.** The brain is not merely polluted —
**it was never given the material it exists to hold.**

### 1.15 Vault, Brain, Live State — three things, currently merged

**This distinction was implicit for this entire investigation and is the thing the design was missing.**

| | What it is | Lives | Lifetime | Precious? |
|---|---|---|---|---|
| **Vault** | the files — notes, conversations, MRI, voice, research. jtr's record. | disk, human-readable, portable | **forever, until jtr deletes** | **YES — it is the asset** |
| **Brain** | the derived index over the vault: embeddings, 471,118 weighted edges, clusters, spreading activation, decay | nodes + edges | **disposable — rebuildable in an afternoon** | **NO — it is regenerable** |
| **Live state** | sauna temp, HRV, barometric pressure, PM2, calendar, devices | **queried at the source** | **now** | **N/A — never stored** |

**Home23 has no vault, and the brain is doing both jobs.** 63,109 nodes exist *only* in the brain — no
file, nowhere else. **That is why the brain became precious by accident**, why the V8 incident was
terrifying, why deleting it feels unthinkable. Separate the two and the fear evaporates: the vault is
the asset, the brain is a rebuild, and cleaning is `rm` + reingest.

**Live state must never become brain nodes — and today it does.** This is the same disease wearing a
sensor:

```
2026-07-07  workspace/metrics/process-memory.jsonl        → 10 brain nodes
2026-07-07  workspace/metrics/process-cpu-io-summary.json →  5 brain nodes
            imac-node-pulses.jsonl  2,206 entries | pi-node-pulses.jsonl
```

**Jerry memorised his own CPU usage.** A reading from July 7th was true for a second and is now noise —
yet it is a permanent node, immune to decay, forever. A stream is not memory. Ask "how's the sauna?"
→ hit the sensor. **The brain's copy is always stale and always accumulating.**

**But state *transitions* are events, and events are vault-worthy.** 29.72 inHg every five minutes is
noise. *"Pressure dropped 8 mb overnight; jtr reported a headache"* is a fact about jtr's life and
earns a file. **The stream is not memory; the notable change is.** That is §3's event rule applied to
sensors instead of loops — and it is how the barometer becomes genuinely useful to forrest rather than
2,415,493 bytes of pulses.

**How the three answer a real question:**

- *"What did I say about persistent agents?"* → **brain** retrieves → **vault** file → jtr opens it
- *"How's the sauna?"* → **live**, at the sensor. Not memory.
- *"Does pressure affect how I feel?"* → **brain**, over vault entries that recorded *notable* pressure
  events alongside jtr's health notes — **the analysis is only possible because the notable ones became
  files**

**SCOPE (jtr, 2026-07-15):** *"We won't be able to address them all now. But yes — calendar, email,
home devices, tesla devices, etc. But that's not the important stuff for a persistent 'Brain', which
is the overall goal."*

**Live connectors are OUT OF SCOPE for this spec.** They are contact with the world; they are not the
Brain. **The Brain is the enduring part — the thing that makes an agent persistent rather than merely
connected.** This spec covers Vault + Brain. Live state gets a later project, and §1.15's rule —
*query it, never store it; store only the notable change* — is what that project must obey.

## 2. Diagnosis

The architectural error is not "internal signals became stimuli," and it is not a governance failure.

**The brain is treated as the asset, and there is no vault.**

In Obsidian, the vault is the asset and the index is disposable — you can delete the index without a
second thought, because it contains nothing that isn't in the vault. Home23 inverted this: the brain
is the only copy, so every cleanup is surgery.

**Home23 has no vault/machinery boundary.** The feeder watches the machinery's output directory and
files it as knowledge. There is no rule against it because nobody imagined wanting it.

Corollary: **governance cannot fix this.** Every gate produces a receipt; the receipt is work; the
work is prose; the prose is ingested. Adding a verifier gate is what the restraint receipts already
are. The disease cannot be used to treat the disease.

---

## 3. The Rule

> ### Permanence requires an event and a file.
> Something happened, **and** there is a file you can open that says so.

Both halves of the problem fall out of this one rule:

**The engine stops making garbage** — not via a gate, charter, or verifier (those become receipt
factories; we have 14,448 proofs). The engine simply has nowhere to put a non-event. Would a restraint
receipt survive as a vault note? *"2026-05-11: I considered acting and decided not to"* × 14,448
files. The absurdity does the work that 8,869 lines of governance could not.

**The brain becomes a derived index** over a vault of files. Every node traces to a file, so the brain
is **regenerable** — and the 117k-delete problem does not get solved, it evaporates. There is no
surgery; there is a rebuild.

### What is explicitly preserved

We are **not** replacing the brain with Obsidian. Home23's index is richer than Obsidian's and all of
it survives untouched: **471,118 weighted associative edges, Hebbian reinforcement, semantic embeddings,
spreading activation, small-world dream bridges, clustering, decay, consolidation/summarization,
dream rewiring.** None of that is what broke. We are giving the brain the one thing Obsidian has and
it lacks: **a source of truth it is derived from.**

Volume and breadth are welcome. Conversations, memory-extraction, checkpoints, 100k real nodes — all
fine. They happened, and they tie back to files.

---

## 4. Design

### 4.1 Close the door — watch paths

**CAUTION — `workspace/` is not a single decision.** `workspace/sessions` (label
`conversation_sessions`) is **kept**; the other `workspace/*` paths are **dropped**. Do not treat
"remove workspace" as one action. The table below is authoritative; the path column is what changes,
the label column is what the manifest calls it.

| Watch path | Manifest label | Nodes | Action | Why |
|---|---|---|---|---|
| `/Users/jtr/life/` | `jtr_life` | 3,786 | **KEEP** | jtr's world: areas, feed, people, entities, bibliographies, MRI |
| `workspace/sessions` | `conversation_sessions` | 4,314 | **KEEP** | Real conversations = real events. Volume is fine. |
| *(various)* | `jtr_voice` | 670 | **KEEP** | jtr's voice notes |
| *(various)* | `garcia_jerry` | 860 | **KEEP** | jtr's interest area (Jerry Garcia) |
| *(various)* | `legacy_cosmo23_memory` | 271 | **KEEP** | memory-extraction work product |
| `cosmo23/runs/trail-running` | `trail_running` | — | **KEEP** (forrest) | real research |
| `workspace/memory` | `*_memory_snapshots` | 9 | **DROP** | source of the `[STATE_SNAPSHOT] RECENT.md` ouroboros |
| workspace root (`SOUL.md`, `MISSION.md`, `HEARTBEAT.md`, ...) | `workspace` | 6,883 | **DROP** | identity files already loaded into the system prompt; ingesting them duplicates config as knowledge |
| `workspace/reports` | `*_reports` | 62 | **DROP** | machine output |
| `workspace/cron` | `*_cron_docs` | 1 | **DROP** | machine output |
| `cosmo-home_2.3/projects/` | `projects` | 141 | **DROP / FIX** | ingested `node_modules`; 4,916 of 5,057 entries produced nothing |

**Unresolved before execution:** the `workspace` label (6,883 nodes) does not correspond to an
`additionalWatchPaths` entry in `config.yaml` — it appears to enter via the feeder's `ingestDir`
scan (`document-feeder.js:139`, `_scanDirectory(ingestDir, null)`). **Trace the actual mechanism
before changing it**; do not assume it is a watch-path removal. Same for `jtr_voice` and
`garcia_jerry`, whose labels do not appear in the current `config.yaml` either — they may be legacy
manifest entries from paths no longer watched.

The keep/drop list requires jtr's confirmation before execution.

### 4.0 THE VAULT — consolidation is the project (DECIDED)

**Per §1.14, this is the centre of gravity, not a preliminary.** jtr's material is scattered across four
locations and 95% has never been read.

**Where it lives today:** `/Users/jtr/life/` — and it is a **scaffold, not a vault**:

```
/Users/jtr/life/          771 MB, 4,392 files, 99.7% ingested
  areas/entities/           0 B      ← empty, beside an EXAMPLE_ENTITY_STRUCTURE.md
  areas/companies/         52 K
  areas/people/           108 K
  areas/methodologies/    104 K
  areas/jerry_garcia/      55 M
  areas/jtr_antrhopic_archive/ 47 M
  areas/chat.html         471 M      ← one file = 61% of the "vault"
  areas/checkpoint-15880.json 185 M  ← one file
  feed/                   7.9 M
```

Someone designed a PARA taxonomy — companies, entities, people, methodologies — and it is essentially
empty. **`entities/` is zero bytes.** 656 MB of 771 MB is two files. **The taxonomy was aspirational
and nobody ever filed anything into it.**

#### 4.0a Folders vs tags — jtr: *"I don't need organized if we 'tag' the docs in some way, right?"*

**Correct in principle — and the tagging he assumes exists does not.** Measured:

```js
// ingestion-manifest.js:64
tag: label,          // the node's tag IS the watch-path label. That is the entire mechanism.
```

**No frontmatter support anywhere in the pipeline.** One folder = one tag for every file in it, forever.
Jerry has 9 watch paths, so **his entire tag vocabulary is 9 words** — the MRI, the bibliographies, the
Jerry Garcia research and jtr's notes all carry the identical tag `jtr_life`. This is also *why* the
taxonomy folders exist: folders were the only way to get more than 9 tags. Then nobody maintained them.

**The resolving distinction: provenance is a fact; meaning is a judgment.**

- **Folders fail at meaning** — that is the 0-byte `entities/`. Taxonomy needs a human forever, so it decays.
- **Folders are free at provenance** — a voice note is always a voice note. Derivable *mechanically at
  consolidation* from the source path we are already reading. **jtr files nothing; the move does it.**

**Design:**

- **Type/origin → shallow folders**, derived mechanically. Never maintained by hand, never a decision.
- **Meaning → frontmatter tags.** Unlimited, re-taggable. **Requires building frontmatter parsing into
  the ingestion pipeline — small, real, and new work this spec must cost.**
- **Free first pass at meaning:** the compiler *already* extracts key concepts. Let it propose tags
  during the rebuild — it is already running, so this is free. **Only pay for a dedicated tagging pass
  over 49,627 documents if the free one proves insufficient.**
- Fully flat is rejected: 49,627 files in one directory is a real filesystem problem, and it discards
  provenance the source path hands us for nothing.

#### 4.0b Proposed shape

```
vault/
  voice/          ~2,668 voice notes      ← cosmo-home/runs/jtr/inputs/voice + cosmo-home/voice
  sessions/       ~2,194 session summaries ← workspace/jtr  (4,131 files, currently 0 ingested)
  conversations/    250 Claude + N ChatGPT ← atomized (§4.1e)
  research/       jerry_garcia, trail-running, cosmo research outputs
  health/         MRI, health log, driver's license
  reading/        bibliographies, feed/ docs, articles
  notes/          memory-extraction, people, companies, methodologies, infrastructure
  _archive/       checkpoint-15880.json and the other giants — cataloged (§4.1d), never compiled
```

Eight directories, every one derived from where a file came from, **none requiring a decision from jtr.**
Meaning rides on top as frontmatter.

**Location:** `/Users/jtr/life/` is the recommendation — already 99.7% ingested, already the `jtr_life`
label, already outside the repo. Requires moving the two giants to `_archive/` and deleting the empty
scaffold. **jtr is agnostic on location (2026-07-15); this is a default, not a constraint.**

#### 4.0c Consolidation inputs, and what gets archived

```
cosmo-home        28,962 docs |  27,431 unread  | 2.4 GB
cosmo-home_2.3     7,808 docs |   7,444 unread  | 1.6 GB
.openclaw         12,061 docs |  12,061 unread  | 3.6 GB   (agents/: claude, codex, main)
workspace/jtr      4,131 files|   4,131 unread  ← watched, never ingested (§7 correction 6)
/Users/jtr/life/     796 docs |       2 unread  ← already home
```

**This dissolves §7.7's "confirmed trap."** `jtr_voice` (1,340 nodes), `garcia_jerry` (943), and
`legacy_cosmo23_memory` (313) do **not** need their dead `cosmo-home` paths re-added to config — **the
files move into the vault.** The trap only existed because we were preserving pointers into installs
that are about to be archived.

**After consolidation:** archive `cosmo-home`, `cosmo-home_2.3`, `cosmo_2.3`, `.openclaw` — **~8.7 GB
reclaimed, and one location instead of four.** Deduplication is required (e.g. `cosmo-home/voice` and
`cosmo-home_2.3/voice` are both 613 files, 4.0 MB — almost certainly the same notes).

### 4.1a Close the OTHER doors — the feeder is 1 of ~23

**The watch-path fix (§4.1) only governs feeder-sourced nodes (26,454 of 143,479).** The other
**117,025** enter via direct `addNode()` calls and are untouched by it. Each door in §1.8 must be
addressed on its own:

| Door | Change |
|---|---|
| `orchestrator.js` `state_snapshot` writer (§1.8.1) | **Remove.** RECENT.md is a derived surface; re-ingesting it into the brain it summarizes is the ouroboros. It is already loaded into the system prompt as a surface — it does not need to be a node. *(If retained at all: strip the generated timestamp so the hash gate can actually fire, and remove `confidence_decay: 1`.)* |
| `agents/base-agent.js` ×2 | Gate on the event rule — no finding, no node. `documentCount: 0` writes nothing. |
| `circulatory/composter.js` | Remove `addNode(summary, 'compost_receipt')`. The janitor does not file into what it cleans. |
| `orchestrator.js` dream node | **§4.3a (DECIDED).** Remove *both* dice rolls: `Math.random() < 0.3` (whether the goal exists) and `Math.random() < 0.2` (whether the prose is remembered). A dream that produced a goal earns a vault note; one that produced nothing leaves no trace. Rewiring is phase-level and untouched. |
| `cognition/actions/promote-to-memory.js` | **Keep.** jtr-initiated promotion is an event by definition. |
| `memory/pin-canonical-nodes.js` | **Keep.** Explicit, bounded, curated. |
| `goals/goal-curator.js`, `artifacts/*`, `trajectory-fork.js` | **Audit against the event rule.** Not yet traced; each needs the same question — does it record an event, or a tick? |

**Unmeasured — must be traced before implementation:** the `orchestrator.js` `addNode` sites at
lines 2851, 2933, 4082, 4423, 5011, 8067, 8095 were not individually read. Do not assume.

### 4.1b Principle: direct-to-node is a privileged path

**jtr's directive: anything that writes directly to a node needs scrutiny.**

The feeder earns node-writing because it is provenance-bearing: a file exists, it is hashed, it is
manifested, and deleting the file removes the nodes. **Every direct `addNode()` call bypasses all of
that** — no source, no hash, no manifest entry, no removal path. That is precisely how 117,025
unremovable orphans came to exist.

**Rule:** a direct `addNode()` call site must justify itself against three questions, and the answers
belong in a comment at the call site:

1. **What event does this record?** (Not "what does it summarize" — what *happened*?)
2. **What file backs it?** If none, it is unremovable by design. Why is that acceptable here?
3. **How does it get deleted?** If the answer is "it doesn't," it must not be a node.

Sites that pass today: `promote-to-memory.js` (jtr-initiated = an event by definition),
`pin-canonical-nodes.js` (explicit, bounded, curated).
Sites that fail today: `state_snapshot`, `base-agent` ×2, `composter`, the dream dice roll.
Sites not yet traced: 7 in `orchestrator.js`, `artifacts/*` ×3, `goal-curator`, `trajectory-fork` ×2.

**Preferred remedy for a failing site is not a gate — it is a file.** If the output is worth keeping,
write it to the vault and let the feeder ingest it with full provenance. If it is not worth a file, it
is not worth a node. This is §3 applied to the write path.

### 4.1c Nothing sits unread — the silent-drop problem

**jtr's directive: nothing should be sitting because of size or other limits. That should never be.**

Measured, the failure mode is worse than skipping. **It is false success.**

```
471.3 MB → 1 node    ~/life/areas/chat.html                parse=ok  ← entire ChatGPT export
  3.9 MB → 1 node    ~/life/areas/.../jerry_records.json   parse=ok
  1.5 MB → 2 nodes   ~/life/areas/projects/shows_catalog.json  parse=ok
  1.3 MB → 0 nodes   ~/life/feed/cursor_testing_new_database_structures2.md  parse=ok
```

**Every one is marked `ok`.** There is no yield check anywhere in the pipeline — bytes-in is never
compared to nodes-out — so total extraction failure is indistinguishable from success. Nothing would
ever surface these. A skip at least writes a log line; a false success writes nothing and reports done.

**Every drop point is invisible** (`document-feeder.js:336–370`):

| Drop | Behaviour | Record left |
|---|---|---|
| `stat.size > maxFileBytes` (5 MB) | `logger.info(...)` then `return` | **log line only — no manifest entry** |
| `catch { return; }` (unreadable) | bare catch | **nothing at all** |
| `basename.startsWith('.')` | `return` | **nothing** |
| `_shouldIgnorePath()` | `return` | **nothing** |
| compile queue full (200) | `reject` → falls back to **raw text** | warn log; silent quality loss |
| compiler circuit open (5 fails / 60s) | `reject` → falls back to **raw text** | silent quality loss |

**The manifest records only what succeeded.** There is no way to ask "what did you refuse?" — the
system that wrote 14,448 receipts about declining to act has never once recorded that it could not
read a file.

**Required changes:**

1. **Every file seen gets a manifest entry, including refusals**, with `outcome` and `reason`
   (`skipped_too_large`, `unreadable`, `dotfile`, `excluded`, `compiled_raw_fallback`). "What is
   sitting unread" becomes a query, not archaeology.
2. **Yield check (§4.1c-2).** A file whose extracted text or nodes-out is ~0 relative to bytes-in is a
   **failure**, not a success. Flag it; never mark it `ok`. `chat.html` at 471 MB → 1,324 chars → 1
   node must scream. **Below the yield floor the input must not reach the compiler at all** — emit a
   catalog node (§4.1d) and quarantine for extraction, because a compiler handed near-empty input does
   not fail, **it fabricates** (§4.1c-1).
3. **`maxFileBytes` must route, not drop.** Oversized files go to a splitter/extractor queue.
   A 5 MB ceiling is a *processing strategy*, never a *reason to never read something*.
4. **Dotfiles: explicit-allow, not blanket-deny.** `~/.health_log.jsonl` is a dotfile — **the current
   §4.6 "add the health log to watch paths" cannot work**; it would be silently dropped at
   `basename.startsWith('.')`.
5. **Quarantine must be surfaced to jtr, not just recorded.** `MRI Report.pdf` is
   `conversion_failed` + quarantined. Jerry cannot read it (conversion failed); Forrest cannot read it
   (does not watch the folder). **Nobody has jtr's MRI.** A quarantined file in a real-world label is a
   **live problem with an executable verifier** — that is exactly what the live-problems system is for
   and it is the correct use of it.
6. **Raw-text fallback must be visible.** Queue-full and circuit-open silently degrade compiled
   synthesis to raw text. That is a quality cliff recorded nowhere; some existing low-quality nodes are
   plausibly this. Record the fallback in the manifest and re-compile later.

### 4.1d The catalog rule — a file's existence is knowledge, even when its content isn't

**jtr's directive: even when a file can't be read, identify it and record what and where it is, so we
know where to look.**

This is correct and the current design misses it. **Existence and content are separate facts.** A file
that exists is an event; it has a name, a path, a size, a type, a date. That is real, provenance-bearing
knowledge that satisfies §3 completely — and it is exactly what is missing today:

```
MRI Report.pdf  →  conversion_failed, quarantined, 0 nodes, invisible
```

Asked *"do I have jtr's MRI?"*, Jerry currently has no answer. He should answer: **"Yes —
`/Users/jtr/life/feed/MRI Report.pdf`, PDF, 2 pages, added 2026-02-XX. I could not read it: markitdown
conversion failed. Here is where it lives."** That is a useful, honest, actionable memory.

**Rule:** every file the feeder sees gets a **catalog node** — path, name, type, size, mtime, label,
and ingestion outcome — regardless of whether its content could be extracted. Content nodes are
additional, not a precondition. The catalog node is:

- **provenance-bearing** — it *is* the file, so §4.1b is satisfied trivially
- **self-deleting** — delete the file, the manifest removes the catalog node like any other
- **honest** — it states what is known and what is not, instead of nothing or a fabrication
- **the answer to "where do I look?"** — the point of a vault index

**This subsumes the quarantine-visibility requirement in §4.1c(5)**: a quarantined file still gets a
catalog node saying so. And it is strictly better than the current failure mode, which is not silence —
it is invention (§4.1c-1).

### 4.1c-1 The false-success mechanism, traced end to end — and it fabricates

**`chat.html` (471 MB, `parse=ok`, `nodeIds: [47620]`) — the full manifest entry:**

```
structuralSignature: {"nBlocks": 1, "typeCounts": {"compiled_synthesis": 1}, "avgTextLen": 1324}
compiled: true    nodeCount: 1    totalChunks: 1    ingestedAt: 2026-04-17
```

**471,000,000 bytes → 1,324 characters → 1 chunk → 1 node.**

Mechanism, and **every stage behaved correctly**: a ChatGPT export is a shell page whose conversations
live inside `<script>var jsonData = [...]</script>`, injected into `#root` by JS at render time. The
HTML→text converter did what a text extractor should — **it ignored the script block** — and extracted
the visible text: a `<title>`, CSS, an empty div. 1,324 chars. One chunk. One compiler call.
`parse=ok`. Nobody was wrong. Nothing flagged it.

**And then the compiler fabricated the node. Node 47620, verbatim:**

```
1. **What is this document?**
A Home23 dashboard HTML fragment showing Sauna, Quotes, Clock, and Weather tiles
in a non-functional/empty state.
2. **Key findings:**
- Sauna tile present with temperature "--°F" (no data) and status "Off"
- Clock frozen at "00:00:00 AM" — time sync failure
- Location set to "Florence, Italy" — unexpected/geographical mismatch
4. **What contradicts:**
- Sauna "--°F" contradicts prior ~182°F readings — suggests this is a different
  dashboard instance, test environment, or disconnected tile
5. **Connections:**
- Sauna tile → jtr-pi infrastructure (get_sauna.sh, sauna_temps.txt)
- Dashboard → Home23 Dashboard at port 8090
```

**None of this exists in a ChatGPT export.** There is no sauna tile, no clock, no Florence. Given
1,324 chars of generic HTML shell, the compiler **invented a Home23 dashboard**, then:

1. **reasoned about the contradiction it had invented** ("--°F contradicts prior ~182°F readings"),
   constructing an explanation for a discrepancy in a document that does not exist;
2. **linked the fabrication to real infrastructure** — `get_sauna.sh`, `sauna_temps.txt`, `jtr-pi`,
   port 8090. **The hallucination now carries graph edges to real sauna nodes.**
3. produced it in confident, structured, plausible form. `parse=ok`.

**Why it hallucinated Home23 specifically — a compiler-level feedback loop not previously identified:**
the compiler's context is saturated with Home23. Hand it an ambiguous scrap and its prior is dashboards
and sauna sensors, so that is what it produces. **A polluted brain yields a polluted prior, which
fabricates nodes, which pollute the brain.** §1.12's feedback path has a twin at the compile step.

**Consequences for this design:**

- **Node content is untrustworthy even where provenance is clean.** §4.5's claim that `[CONSOLIDATED]`
  nodes are "correct conclusions from a poisoned premise" is **too generous** — some are *fabricated
  conclusions from no premise*. This strengthens rebuild-over-clean: cleaning cannot detect invention.
- **A rebuild reproduces this exactly** unless the yield check (§4.1c-2) lands first. Same converter,
  same 1,324 chars, same compiler, same fabrication — in 29 hours, marked `ok`.
- **Low-yield input must never reach the compiler.** Below a yield floor, emit a **catalog node**
  (§4.1d) and quarantine for extraction. A compiler handed near-empty input does not fail — **it
  invents**, and that is worse than silence.

### 4.1e The atomizer — the missing stage, and the real Obsidian lesson

**The pipeline has no concept of a collection.** A file containing N items is treated as *one
document*, chunked as one blob, and emitted as ~one synthesis. Measured across the vault:

```
jtr_antrhopic_archive/conversations.json   46.7 MB  →  0 nodes   suspect_truncation
areas/chat.html                           471.3 MB  →  1 node    parse=ok (a fabrication, §4.1c-1)
jtr_antrhopic_archive/projects.json        0.23 MB  →  1 node    parse=ok
areas/.../jerry_records.json                3.9 MB  →  1 node    parse=ok
areas/projects/shows_catalog.json           1.5 MB  →  2 nodes   parse=ok
```

**Every collection in jtr's vault collapses to a point.** Both of his complete AI conversation
archives — ChatGPT and Claude — are effectively absent from the brain.

**What is actually inside `conversations.json`:**

```
250 conversations, 4,722 messages
per-item keys: uuid, name, summary, created_at, updated_at, account, chat_messages
  - "Turtles All the Way Down"
  - "Clarifying AI Consciousness Discussions"
  - "Philosophical Quotes on Infinite Recursion"
  - "Maintaining Ethical AI Principles"
```

**Every item is already a perfect vault note** — title, a pre-written summary, a date, a stable UUID,
and a body. It is structured for precisely this. It produced **zero nodes**, while the brain retained
14,448 records of declining to act (immune to decay by configuration) and 944 copies of `RECENT.md`.

**The Obsidian lesson is not the index — it is the atoms.** An Obsidian vault works because it holds
one note per conversation, per idea, per person. Nobody drops a 46 MB JSON array into a vault and
expects search to work: **a human runs a splitter first, and that explosion step is what makes the
vault a vault.** Home23 copied the index and skipped the explosion, so N conversations enter as one
document and leave as one hallucination.

Note also what Obsidian does with an unreadable file: it lists it and **indexes nothing**. It never
claims to have read it, and — having no compiler — it *cannot* fabricate. Its worst failure is "not
found." **Where extraction fails, fall back to Obsidian behaviour: catalog only (§4.1d), never
synthesis.**

**Required: an atomizer stage, before chunking and before the compiler.**

- A collection (JSON array, HTML export, mbox, CSV, JSONL) is **exploded into one document per item**,
  each with its own path, hash, manifest entry, and provenance. Each item is then an ordinary document
  and every downstream rule applies unchanged.
- Atomized items land as **real files in the vault** (per §3 — permanence requires a file), not as
  in-memory splits. Delete the note, the manifest removes the nodes. This is the Obsidian property.
- **Known atomizers needed:** Claude export (`conversations.json` — trivial, already structured),
  ChatGPT export (`chat.html` — payload is in a `<script>` block injected into `#root`; the JSON must
  be pulled from the script, which is exactly what the text converter correctly refuses to do),
  `jerry_records.json`, `shows_catalog.json`, `projects.json`.
- **Absent an atomizer for a given collection, it must catalog-and-quarantine (§4.1d), never
  compile.** §4.1c-1 proves a compiler handed a flattened collection does not fail — it invents.

**This resizes the rebuild.** §4.5's "9,939 files → 77,425 chunks" counts collections as single
documents. Atomized, `conversations.json` alone becomes 250 documents; `chat.html` plausibly 10× that.
**The real rebuild is larger, slower, more expensive — and produces a brain that finally contains
jtr's intellectual history instead of a fabricated sauna tile.** Re-scope §4.5 after the atomizer
inventory is known.

### 4.1e-1 First deliverable: the Claude atomizer (DECIDED)

**jtr agreed: the Claude archive goes first.** It is the smallest real collection, the highest-value
content in the vault, and it **proves the atomizer design against real material before a ~29h rebuild
depends on it**.

```
/Users/jtr/life/areas/jtr_antrhopic_archive/conversations.json
  46.7 MB → 0 nodes today (suspect_truncation)
  250 conversations / 4,722 messages
  per item: uuid, name, summary, created_at, updated_at, chat_messages
```

Every item is already a vault note — title, pre-written summary, date, stable ID, body. The atomizer
emits **250 markdown files**, one per conversation, into a watched vault folder: `name` → title,
`summary` + `created_at` + `uuid` → frontmatter, `chat_messages` → body. The `uuid` gives a stable
filename so re-running is idempotent, and the hash gate makes it resumable.

**Acceptance:** 250 files → 250 manifest entries → each with a nonzero yield (§4.1c-2) → the archive is
queryable by conversation. Success here validates the atomizer for `chat.html`, `jerry_records.json`,
`shows_catalog.json`, and `projects.json`. **Failure here is cheap and tells us the design is wrong
before we spend 29 hours.**

### 4.2 The event gate at ingestion

A document with no substantive content produces **no node and no compiler call**. Kills the
empty-session nodes at the door and stops paying an LLM to write paragraphs about nothing.

### 4.3 Stop the emitters

| Emitter | Change |
|---|---|
| `NO_ACTION` branch (`thought-action-parser.js`) | creates no node |
| `document_analysis_agent` with `documentCount: 0` | creates no node |
| `good-life-restraint-receipts.jsonl` | stop writing; a gate needs no receipt |
| `resident_tick` scratch + receipt (`resident-kernel.js:2467`) | write **only** when an action actually occurred or pursuit state changed |
| `recordGoodLifeAgendaAction()` | remove — a receipt whose verifier is the loop that authored it is not an action |
| `pulse-remarks.jsonl` | keep real-world content (weather, sauna); drop the self-report |
| Dream node creation | **§4.3a (DECIDED).** Remove *both* dice rolls: `Math.random() < 0.3` (whether the goal exists) and `Math.random() < 0.2` (whether the prose is remembered). A dream that produced a goal earns a vault note; one that produced nothing leaves no trace. Rewiring is phase-level and untouched. |

`NOTIFY` becomes owner-facing only.

### 4.3a Dreams — keep the productive ones (DECIDED)

**jtr: "dreams are useful consolidation tools, not just theatre... make sure the work done by dreaming
is for a purpose and kept if so."**

Measured, dreaming has **two independent dice rolls**, and the first one randomizes *productivity
itself*:

```js
// orchestrator.js ~4227 — whether the dream's captured goal EXISTS
const dreamGoals = await this.goalCapture.captureGoalsFromOutput(dreamThought.hypothesis, {...});
if (Math.random() < 0.3) {
  const newGoal = this.goals.addGoal({...});
}

// orchestrator.js:4266 — whether the dream's prose is REMEMBERED
if (Math.random() < 0.2) {
  await this.memory.addNode(`[DREAM] ${dreamThought.hypothesis}`, 'dream');
}
```

**A dream that captured a real goal has a 70% chance of that goal being discarded by a coin flip.**
Independently, its prose is retained 20% of the time. The two dice are unrelated, so the remembered
dreams are not the productive ones — "keep productive dreams" is currently *unimplementable*.

Also measured: `memory.rewire(rewiringP)` (`orchestrator.js:4285`) is a **phase-level** operation that
runs once per dream phase regardless of any individual dream. **The only per-dream product is a goal.**

**Design:**

- **Remove `Math.random() < 0.3`.** A captured goal becomes a goal on merit, not by lottery.
- **Replace `Math.random() < 0.2` with `if (goalWasCreated)`.** A dream that produced a goal is
  productive; it earns a note. A dream that produced nothing leaves no trace. This is §3's event rule
  applied unchanged — the dream *is* the event, the goal is the evidence.
- **The dream note is a vault file** (§4.3b), not a bare `addNode` — so it is readable by jtr,
  deletable, and regenerable. Its provenance is the goal it created.
- **Keep the dreaming, the goal capture, and the Watts-Strogatz rewiring untouched.** That is the
  consolidation and it is real work.

### 4.3b Synthesis write-back — a separate vault folder (DECIDED), and the trap in it

**jtr: "yes — separate folder."** Machine-authored syntheses persist as files, in their own folder,
not intermixed with jtr's own notes.

**⚠ The trap: "syntheses become vault files" + "the vault is watched" is exactly how the ouroboros was
built.** RECENT.md is a machine-authored file in a watched location. That is §1.8.1. Writing syntheses
to a watched folder without a further rule **rebuilds the disease with better manners**:

> synthesis → vault file → feeder ingests → node → consolidation → synthesis → vault file → …

**The rule that defuses it — and it is the sharpest line in this spec:**

> ### Write-once is an artifact. Regenerated-on-a-schedule is a loop.
> The vault may contain machine-authored files. **Nothing in the vault may be machine-*rewritten* on a
> cadence.**

That single distinction separates every good case from every bad one measured today:

| File | Written | Verdict |
|---|---|---|
| A synthesis note (this consolidation, once, never revised) | **once, as an event** | artifact ✅ |
| A productive dream note (§4.3a) | **once, as an event** | artifact ✅ |
| `RECENT.md` snapshot | **every cycle, new timestamp → new hash → new node** | loop ❌ |
| A restraint receipt | every gate tick | loop ❌ |
| `pulse-remarks` | every cycle | loop ❌ |

RECENT.md was never bad because it was machine-authored. **It was bad because it regenerates.** Its
own dedup gate proves the intent was right and the cadence defeated it (§1.8.1).

**Design:**

- Syntheses and productive dream notes are written **once**, to a dedicated vault folder
  (e.g. `/Users/jtr/life/synthesis/`), dated and titled, **never rewritten or regenerated**.
- The folder is watched, so syntheses are retrievable, provenance-bearing, and **deletable by jtr —
  delete the note, the manifest removes the nodes.** That is the whole point.
- **Enforcement, not convention:** the feeder must **reject any watched file whose content is
  regenerated by the machine on a cadence.** Detection is mechanical — a path whose hash changes on a
  schedule with no external cause. If we rely on discipline here, this loop returns; §1.3 is five
  proofs that every "we'll be careful" control was eventually switched off.
- **Open (small, my call unless jtr objects): may a synthesis be a consolidation *source*?**
  Synthesis-of-synthesis is how abstraction forms — and also how `[CONSOLIDATED]` drifted into prose
  about prose (§4.1c-1). **Recommendation: no.** Syntheses are ingestible and retrievable but excluded
  as consolidation inputs, until there is evidence the drift is controllable.

### 4.4 Un-sabotage the janitors

- **Decay:** drop `agent_insight` and `agent_finding` from `decay.exemptTags`. jtr's world should
  outlive the machine's, not the reverse.
- **GC:** rewrite `garbageCollect` to key on **provenance, not access-age** — *does this node trace to
  a file?* Keep forever regardless of age or access; no file → not knowledge. This is the "safer
  archival/compaction policy" its own comment demands, and it cannot eat the MRI because the MRI is a
  file. **Ships with a dry-run that prints what it would remove.** Then re-enable.
- **Reuse the existing classifier — do not write a new one.** `provenance-salience.js` (§1.9) already
  enumerates `IDENTITY_TAGS` (jtr's world), `AUTONOMOUS_TAGS` (machine output), and `TELEMETRY_TAGS`,
  and is already trusted in production at retrieval time. **Promote it from a read-time filter to the
  shared write-time/GC-time authority.** This removes the single largest risk in the first draft — a
  hand-written classifier nobody has validated — and replaces it with one already running against this
  exact brain. Any disagreement between the retrieval filter and the GC becomes a visible bug rather
  than two divergent opinions.
- **`prune_stale_cluster`:** make it delete, or delete it. A pruner that emits flags is worse than no
  pruner because it looks like one.
- **Retire `brain_node_count_stable`.** The count was never the metric. The metric is **every node
  traces to a file** — which is checkable. Under this design a falling node count is the janitor
  working.

### 4.5 Rebuild, not clean

Deletion is insufficient. Even with every garbage node gone:

- **The graph stays poisoned.** 471,118 edges with Hebbian weights learned over 8 months where 70% of the
  material was diary. Clusters formed *around* `STATE_SNAPSHOT`s. Dream bridges route real memories
  *through* restraint receipts. Deleting nodes leaves topology worn by material that no longer
  exists — paths connecting real things for reasons that were never real. That cannot be cleaned,
  only regrown.
- **`[CONSOLIDATED]` nodes are unsound at best and fabricated at worst.** The summarizer worked
  perfectly on garbage inputs, so at best they are correct conclusions from a poisoned premise. But
  §4.1c-1 shows the compiler **invents** when given thin input, so some are *fabricated conclusions
  from no premise* — and the fabrications carry graph edges to real nodes. **Cleaning cannot detect
  invention; only regeneration from real material can prevent it.**
- **Cleanup yields a brain we *hope* is clean**, verified by a hand-written classifier, on an
  unauditable graph. **Rebuild yields a brain that is clean by construction** — every node traces to a
  file because a file is the only thing that made it. Not verified. Guaranteed.

**The rebuild is also the test of the architecture.** If the brain can be rebuilt from the vault, the
design is real. If it cannot, we learn that now rather than after betting on it.

**The mechanism already exists — no new code:**

```js
// ingestion-manifest.js
if (!entry) return true;              // no manifest entry → ingest
return entry.hash !== contentHash;    // hash-gated → idempotent, resumable

// document-feeder.js — on startup:
await this._scanDirectory(watchPath, label);
```

Delete the manifest, restart the engine, everything re-ingests. This is what a fresh install already
does on every boot.

**Job size — corrected. The first draft was wrong by ~19×.**

```
files to reingest     : 9,939
chunks/blocks         : 77,425
nodes produced before : 15,919
previously-bad parses : 21
```

`document-compiler.js:151` — `async compile(text, metadata)` is **one LLM call per chunk**.
`document-feeder.js:41` — `_compileMaxConcurrent = 3` is a **concurrency limiter, not a batcher**.
The `flush.batchSize: 20` cited in the first draft is the *manifest flush* batch and has nothing to
do with compiler calls.

```
→ ~77,425 LLM calls at 3 concurrent
→ at ~4s/call: ~29 hours.  At ~2s/call: ~14 hours.
```

**This is a 1–2 day operation, not "hours, not days."** Embeddings are local (`nomic-embed-text` via
ollama) and free. Hash-gated → resumable if interrupted. `_compileMaxConcurrent` is configurable and
`_compileCircuitFailures: 5` will trip the circuit on provider errors — both need review before a run
of this size.

**Unmeasured:** actual per-call latency and token cost against the configured compiler model
(`MiniMax-M3`). **Benchmark 100 chunks before committing to the full run.**

**These numbers are now known to be an undercount.** They treat collections as single documents
(§4.1e). Atomized, `conversations.json` alone becomes 250 documents and `chat.html` plausibly ~10× that;
`jerry_records.json`, `shows_catalog.json`, and `projects.json` likewise explode. **The real rebuild is
larger and slower than 77,425 chunks / 14–29h — and is worth it, because that is the difference between
a brain containing jtr's 250 Claude conversations and a brain containing one fabricated sauna tile.**
Re-scope after the atomizer inventory (§7.14).

**Accepted loss, chosen explicitly:** the ~117,025 orphans — dreams, raw thoughts, agent insights,
consolidations — have no source file and **cannot be regenerated**. They remain in the archive,
read-only and intact, retrievable by hand if ever wanted. They are not in the new brain.

### 4.6 Forrest gets his data

Forrest is jtr's health agent. His own `DATA_MAP.md` names the canonical sources:

```
Health API (port 8091)        — HRV, resting HR, VO2, sleep stages, O2 sat, steps
~/.health_log.jsonl           — 260 rolling snapshots
```

**Neither is on his watch paths.** Measured (§1.11): **83% of forrest's claimed brain is his own
`workspace`; he has zero `jtr_life`, zero `jtr_voice`, and zero health-log nodes.** His entire
world-facing knowledge is 468 trail-running nodes and 843 conversation nodes. He has been reasoning
about jtr's health from his own reports about jtr's health.

`MRI Report.pdf` sits in `/Users/jtr/life/feed/`. **Jerry watches that folder. Forrest does not.**

Add `~/.health_log.jsonl`, the health API, and the health-relevant parts of `/Users/jtr/life/` to
forrest's watch paths. This is the only change in this design that makes an agent **better** rather
than quieter.

**This is not a watch-path line — three separate blockers, all measured:**

1. **`~/.health_log.jsonl` is a dotfile.** `document-feeder.js:345` — `if
   (basename.startsWith('.')) return;`. Adding it to forrest's watch paths **silently does nothing**.
   Requires the explicit-allow rule from §4.1c(4).
2. **It is a rolling append-only log.** The feeder is document-oriented and hash-gated — every append
   rehashes the whole file and re-ingests it entirely. That is a **new pollution source of exactly the
   kind this spec exists to prevent**. Needs a tail/delta reader, not a document reader.
3. **The health API is an HTTP endpoint**, and the feeder has no HTTP source concept at all.

**`MRI Report.pdf` is `conversion_failed` and quarantined** (markitdown venv python call errored).
Jerry cannot read it; forrest does not watch the folder. **Nobody has jtr's MRI.** Fixing the
converter is a prerequisite for forrest being useful, and per §4.1c(5) this should be a live problem
with an executable verifier — not a silent manifest field.

### 4.6a jtr's ChatGPT export — the largest unrealized source

**Corrected — it was not skipped. It reports success.**

```
~/life/areas/chat.html   471.3 MB   label=jtr_life   parse=ok   nodes=1   quarantined=False
```

jtr's complete ChatGPT history — plausibly the single richest record of his own thinking in this
system — **produced one node and is marked `ok`**. It did not trip `maxFileBytes`. Nothing flagged it.
The manifest reports the file as successfully ingested.

This is the canonical case for the yield check (§4.1c(2)): **471 MB → 1 node must be a screaming
failure, not a green tick.**

It requires a **splitter** — ChatGPT exports are structured HTML with per-conversation blocks — that
emits per-conversation files into a watched directory, at which point each conversation is a real
event with a real file and full provenance. Same for `jtr_antrhopic_archive` (47 MB), and
`jerry_records.json` (3.9 MB → 1 node) and `shows_catalog.json` (1.5 MB → 2 nodes), which are
structured JSON collections flattened into nothing by the same defect.

**This is not part of the decontamination and must not block it** — but it is the strongest available
evidence for the thesis: the brain wrote 14,448 receipts about declining to act, while 471 MB of jtr's
actual thinking sat one node deep in the folder next to it, marked `ok`.

*(Note: the Pi barometric-pressure sensing in the `empire` subsystem is a **real** health signal —
jtr is barometrically sensitive and tracks it because it correlates with how he feels. It is not
theatre. The `empire-thoughts`/`empire-traces` prose layer on top of it is.)*

### 4.7 Governance demolition — last, on evidence

Once the vault boundary holds, the 8,869 lines of governance write to files nobody ingests and nobody
reads. They are **inert**. Delete them at leisure, on evidence, with no risk — rather than doing
surgery on a live system now. `live-problems` keeps working throughout: its output was never prose,
its verifiers are executable and dry-run before promotion, and it is the one subsystem that closes
its own work on real evidence.

---

## 5. Sequence

**The order is the design.** In April 2026 someone found an empty brain and "fixed" it by pointing the
feeder at `workspace/`. The node count went up. It was logged as a repair. That is the day the
ouroboros was installed.

0. **Trace the unknowns** — §7 items 6–13. Especially: the `workspace` label mechanism, the
   `jtr_voice`/`garcia_jerry` provenance (**1,530 of ~5,700 real nodes — if their sources are gone,
   the rebuild silently loses them**), the 7 untraced `orchestrator.js` `addNode` sites, and the
   sidecar/ANN rebuild fate. **A rebuild launched on untraced assumptions is how a 4% brain becomes a
   0% brain.**
1. **Fix the doors** — §4.1 (watch paths), **§4.1a (the other ~22 `addNode` sites)**, §4.2 (event
   gate), §4.3 (emitters), §4.4 (decay exemptions, GC, existing classifier). **Non-negotiable and
   first.** Rebuilding before the doors are shut rebuilds the disease, faster, and it will look like
   it worked for a week. **§4.1a is not optional: watch paths alone leave 82% of the inflow open.**
2. **Archive** — old brain, manifest, all sidecars. Read-only. Untouched forever.
3. **Benchmark** — 100 chunks through the compiler for real latency/cost before committing to ~77,425.
4. **Rebuild** — delete manifest, restart, let it run (14–29h, resumable).
5. **Verify** — every node traces to a file. Node count is *derived*, not a target. Re-verify
   retrieval health, which is currently jtr-confirmed and partly a product of the read-time filter.
6. **Demolish** — remove the provably-inert governance machinery.

Nothing is irreversible before step 4, and step 4 is reversible because of step 2.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Orphans (117,025) are permanently lost from the live brain | Archive is read-only and intact forever; retrievable by hand. Loss is explicit and chosen. |
| Re-enabling the GC deletes real knowledge (it was disabled for a real reason) | Provenance-keyed, not access-keyed — cannot eat an unaccessed MRI. Ships with a dry-run that prints its removal list first. |
| Rebuild fails or produces a worse brain | Old brain archived; revert is a config change. **A failed rebuild disproves the architecture — which is information worth having now.** |
| Door fix breaks something that depended on ingesting `workspace/` | Config-level; revertible in one minute. |
| Reingest cost/duration | **~77,425 LLM calls at 3 concurrent ≈ 14–29h** (§4.5), not 4,000. Benchmark 100 chunks first. Hash-gated → resumable. Embeddings local/free. |
| Keep/drop label list is wrong | Requires jtr's confirmation before execution; printed for review. |
| Brain persistence incident during rebuild | Standard rule applies: **standalone load test before any engine restart**; verify node counts after. |
| **Closing only the feeder door leaves ~1,090 diary nodes/DAY flowing** | §4.1a. The feeder is 1 of ~23 `addNode` sites. `state_snapshot` (30% of growth) is a **direct orchestrator read** and is immune to any watch-path change. This defect killed the first draft. |
| **Untraced `addNode` sites** | 7 orchestrator sites + artifacts/goal-curator/trajectory-fork not individually read. **Trace before implementing**, do not assume. |
| **Health-log ingestion creates new pollution** | §4.6. Three blockers: it is a **dotfile** (silently dropped), a **rolling log** (rehashes per append → full re-ingest each time), and the API is **HTTP** (no feeder concept). Not a watch-path line. |
| **False success hides total extraction failure** | §4.1c. `chat.html` 471 MB → 1 node, `parse=ok`. No yield check exists anywhere. **A rebuild would faithfully reproduce every one of these**, because they are recorded as successes and the reingest is hash-gated on the same code path. **Fix the yield check before step 4 or the rebuild re-bakes the losses.** |
| **Low-yield input makes the compiler FABRICATE** | §4.1c-1. Node 47620 (from `chat.html`) is an invented Home23 dashboard — sauna tile, frozen clock, "Florence, Italy" — none of which exists in a ChatGPT export, cross-linked to real `jtr-pi`/`get_sauna.sh` nodes and marked `ok`. **Node content is untrustworthy even where provenance is clean.** Cleaning cannot detect invention; only rebuild-with-a-yield-floor can prevent it. |
| **The compiler's prior is polluted by the brain it feeds** | §4.1c-1. Saturated with Home23 context, the compiler hallucinates Home23 from ambiguous input. A second feedback loop, at the compile step, distinct from §1.12. Decontamination is a prerequisite for trustworthy compilation — which is another reason the door (§4.1) must precede the rebuild. |
| **False negatives from silenced tooling** | Discovered during this investigation: `timeout` does not exist on this Mac; commands using it failed with "command not found" while stderr was suppressed, returning empty output that read as findings ("node not found", "brain file decompresses to zero bytes" — both false; `gzip -t` confirms **GZ OK**). **During implementation, never suppress stderr on a verification command, and never treat an empty result as a negative without proving the command ran.** This is the same defect class as §4.1c, in our own tooling. |
| **jtr's MRI is quarantined and nobody knows** | §4.1c(5). `conversion_failed`. The failure is a manifest field nobody reads. Route real-label quarantines to live-problems, which has executable verifiers and is the honest subsystem. |
| **`jtr_voice` source is the old cosmo-home install** | §7.7. **Confirmed, not hypothetical.** 670 nodes would silently vanish on rebuild. Re-add the path or relocate the files into the vault before step 4. |
| Removing `state_snapshot` degrades situational awareness | RECENT.md remains loaded as a **system-prompt surface** (its designed role, per STEP20/STEP23). Only the brain-node copy goes. Verify context-assembly still loads the surface after the change. |
| Retrieval regresses once garbage is gone | `provenance-salience.js` currently downranks garbage at read time. Removing the garbage makes those code paths inert, not wrong. **Retrieval is jtr-confirmed healthy today; re-verify after rebuild before demolishing the filter.** |

---

## 7. Open Questions

### DECIDED by jtr, 2026-07-15 — all five closed

1. **Keep/drop list — AGREED.** The §4.1 table is signed off. Notably: the workspace identity files
   (`SOUL.md`, `MISSION.md`, `HEARTBEAT.md`, ... — 6,883 nodes) leave the brain. They are already
   loaded into the system prompt as the identity layer every turn; ingesting them **turns config into
   knowledge**, so the agent retrieves its own instructions as though they were facts about the world.
2. **Dreams — keep productive dreams.** See §4.3a.
3. **Synthesis write-back — YES, separate folder.** See §4.3b. **This carries a feedback-loop trap and
   the rule that defuses it.**
4. **`checkpoint-15880.json` — ARCHIVE.** No atomizer, no extraction, no ingestion. It stays on disk,
   read-only, and comes off the ingest path. *(`memory-extraction/` is unaffected and stays: ~16 dated
   markdown files, ~1.5 KB each, real.)*
5. **AI conversation archives — AGREED, Claude atomizer first.** See §4.1e-1. It is the first
   deliverable and proves the atomizer design against real material before a ~29h rebuild depends on it.
6. **Retrieval — separate spec, after** (§8).

### TRACING COMPLETE — 2026-07-15. Results below; several correct the spec above.

**Corrections to this document's own numbers (measured, authoritative):**

1. **Orphans are 63,109 (44%), not 117,025 (82%).** §1.7 counted only the `nodeIds` field. Manifest
   entries written before ~April carry **`nodeCount` but no `nodeIds`** — 4,651 entries claiming
   **53,913 nodes** that were wrongly counted as orphans.
   ```
   entries with nodeIds        : 17,105  →  26,457 distinct ids
   entries with nodeCount ONLY :  4,651  →  53,913 nodes (pre-April, ids never tracked)
   entries claiming nothing    :    313  (the quarantined)
   TOTAL CLAIMED               : 80,370 / 143,479  → orphans 63,109 (44%)
   ```
   **New consequence:** those 53,913 nodes have provenance that is **countable but not traceable** —
   we know a file produced 2,611 nodes but not *which* ones. So no targeted removal and **no
   drill-down** for a third of the brain. **The rebuild is the only thing that makes them traceable.**
2. **The "70% self-referential" figure holds, but §1.1's method was wrong.** It used a regex matching
   `brain|home23|engine|thought`, which also matches *real conversations about Home23* — which jtr
   explicitly keeps. Full-brain tag census (140,086 nodes, authoritative) puts it at **~71% machine,
   ~9–13% real** — same conclusion, sound method:
   ```
   workspace              29,298  20.9%   ← largest tag in the brain (identity files)
   consolidated           19,033  13.6%
   reasoning               8,524   6.1%
   conversation_sessions   6,213   4.4%   ← REAL
   curator/analysis_insight/agent_insight/novel_implication/critic/curiosity/
     analyst/synthesis_report/proposal/speculative_hypothesis/document_*  ≈ 36%
   jtr_life                5,167   3.7%   ← jtr's actual life
   ```
   **"~4% real" (§1.1) was too pessimistic — it is ~9–13%.**
3. **`state_snapshot` is not in the top 22 brain-wide.** It is **30% of recent *growth*, not 30% of the
   brain** — a newer, accelerating problem, consistent with the doubling since May.
4. **§7.6 RESOLVED — the `workspace` fallback is already OFF.** `orchestrator.js:747` gates it on
   `shouldAddWorkspaceFeederFallback()` = "only if `additionalWatchPaths` is empty"; both agents have
   watch paths. The live feeder confirms the workspace root is **not** watched. The 29,298 workspace
   nodes are **historical** (jerry's last workspace ingest: 2026-07-07 — worker-runs, insights,
   briefings, and `metrics/process-memory.jsonl` → 10 nodes; **it was ingesting its own CPU/memory
   metrics as knowledge**). **Only a rebuild removes them.**
5. **§4.1's keep/drop table was INCOMPLETE — jerry has 9 watch paths, not 7.** An earlier `grep -A14`
   truncated the block. Missing: `/Users/jtr/jtrbrain-feed` (`legacy_jtrbrain_feed`, 1 near-empty file)
   and `/Users/jtr/Desktop/jerryg-fork-jtr-import-import alias` (`jerrybrain`, a 1.2 KB macOS **alias
   file**, not a directory — 0 entries). **Neither is load-bearing; the signed-off decisions stand.**

**NEW FINDINGS — both material:**

6. **`workspace/jtr` — 4,131 files, watched, ZERO ingested. The largest "sitting unread" case found.**
   Configured as `jerry_jtr_notes`; **not one manifest entry exists.** Contents: **2,194 dated markdown
   session summaries** of jtr's real conversations (`2026-03-23-0331-persistent-agent-team-built.md` —
   *"jtr articulated the persistent agent model: 'mini-Altheas'…"*), plus 1,555 json, 120 jsonl, 93 bib.
   Dated, write-once, one per session — **artifacts by §4.3b's own rule.** Nothing written since
   2026-04-14. **Cause unknown — trace before rebuild** (candidate: chokidar `ignoreInitial` plus no new
   files since April, so neither the watcher nor the startup scan ever fired).
7. **`projects` = ~49,488 nodes — 35% of the brain is npm packages and old cosmo project files.**
   §1.6's "5,057 entries → 141 nodes" was the same `nodeIds` artifact. The path
   (`cosmo-home_2.3/projects/`, incl. `node_modules`) **is not in the current config** — so it will not
   regenerate. **The rebuild deletes 35% of the brain for free, correctly, with no classifier.**

**§7.7 CONFIRMED and larger than stated — legacy labels that will NOT regenerate:**
```
projects              5,057 entries  ~49,488 nodes   ← node_modules; GOOD riddance
workspace             6,905 entries  ~12,092 nodes   ← identity files; jtr agreed to drop
jtr_voice               672 entries  ~ 1,340 nodes   ← REAL — /Users/jtr/_JTR23_/cosmo-home/runs/…/voice/
garcia_jerry            860 entries  ~   943 nodes   ← REAL — /Users/jtr/_JTR23_/cosmo-home/runs/
legacy_cosmo23_memory   271 entries  ~   313 nodes   ← REAL — cosmo-home_2.3/workspace
```
**All source files verified present on disk** (voice: 1,442 files, all manifested — an earlier "770
unread" alarm was a label-vs-directory miscount). **~2,596 real nodes are at risk; re-add the three
paths before step 4 or they vanish silently.**

**Also resolved:**

8. **§7.13 — no other live brains.** `agent`, `local`, `test-agent`, `workers`, `conversations`,
   `cosmo23` have zero brain files. Only jerry and forrest.
9. **§7.15 — `.last_extraction` is not written by Home23.** No reference anywhere in `engine/`, `src/`,
   `cli/`, or `scripts/`. External or historical; not a competing writer. **Closed.**
10. **Manifest removal has an offline gap.** 283 `jtr_life` entries point at deleted files and **494
    nodes are still claimed by them**. Removal only fires when the feeder is watching at delete time;
    **offline deletes leave orphans.** This weakens §4.5's "delete the file → the nodes go" — true only
    while running. **The rebuild is the reconciliation.**
11. **`AUTO DRIVER LICENSE.pdf` (4.15 MB) is also `conversion_failed`.** The PDF converter has failed on
    **both** of jtr's identity/medical documents. §4.1c(5) applies to both.
12. **FALSE ALARM, retracted:** "1.28 MB markdown → 0 nodes, `parse=ok`." Those files produced **2,611
    and 385 nodes**; they are pre-April entries with `nodeCount` and no `nodeIds`. **The markdown path
    works fine.** (Same defect as correction 1.)

**§7.14 — the yield scan works.** 22 low-yield files found mechanically, no judgment. **But it must key
on `nodeCount ?? len(nodeIds)`**, or it reports every pre-April entry as a total loss (which is how
correction 12 happened).

### Still to trace before implementation (do not assume)

6. ~~The `workspace` label mechanism~~ — **RESOLVED**, see correction 4. Original text: (6,883 nodes, jerry; 6,564, forrest — 83% of his brain). It does
   **not** correspond to an `additionalWatchPaths` entry; it appears to enter via the feeder's
   `ingestDir` scan (`document-feeder.js:139`, `_scanDirectory(ingestDir, null)`). **Unconfirmed.**
7. **`jtr_voice` provenance — CONFIRMED TRAP.** Measured: its source is
   `/Users/jtr/_JTR23_/cosmo-home/runs/jtr/inputs/voice/` — **the OLD cosmo install**, not
   `/Users/jtr/life/`, not in `config.yaml`, not watched. **Its 670 nodes would silently fail to
   regenerate on rebuild.** The path must be re-added (or the files relocated into the vault) before
   step 4. `garcia_jerry` appears to resolve to `/Users/jtr/life/areas/jerry_garcia/` and is likely
   safe — **still verify**, since it carries 860 nodes and shares the `/Users/jtr/life/` root with the
   `jtr_life` label for reasons not yet understood.
8. **The 7 untraced `orchestrator.js` `addNode` sites** (2851, 2933, 4082, 4423, 5011, 8067, 8095), plus
   `artifacts/*` ×3, `goal-curator.js`, `trajectory-fork.js` ×2.
9. **Health-log and health-API ingestion mechanism** (§4.6) — a rolling log and an HTTP endpoint do not
   fit the document-oriented, hash-gated feeder.
10. **Rebuild fate of the Step 20 sidecars** — `memory-objects.json` (13.8 MB), `event-ledger.jsonl`
    (19 MB), `trigger-index.json`, `problem-threads.json`. They are not brain nodes and do not
    regenerate from the manifest. Are they archived, migrated, or orphaned? **Unaddressed.**
11. **ANN index rebuild** — `memory-ann.*.index` (461 MB) + `.meta.json` (139 MB). Assumed to rebuild
    automatically from nodes. **Unverified.**
12. **Compiler benchmark** — 100 chunks against `MiniMax-M3` for real latency and token cost before
    committing to ~77,425 calls.
13. ~~Other instances~~ — **RESOLVED**: no other live brains. Original text: — `instances/` also contains `agent`, `local`, `test-agent`, `cosmo23`,
    `conversations`, `workers`. Whether any hold live brains subject to this design is unexamined.
14. **Atomizer inventory (§4.1e).** Which vault files are collections, and what does each explode to?
    Known: `conversations.json` (250 items — confirmed), `chat.html`, `jerry_records.json`,
    `shows_catalog.json`, `projects.json`. **Unknown: the rest of the 9,939.** A yield-ratio scan
    (bytes-in vs nodes-out) across the manifest identifies candidates mechanically — every collection
    in the vault has the same signature: large file, ~1 node, `parse=ok`. **This scan is cheap and
    should run before step 4; it re-scopes the whole rebuild.**
15. ~~`.last_extraction`~~ — **RESOLVED**: not written by Home23. Original text: — `/Users/jtr/life/areas/.last_extraction` contains `2026-03-16T00:00:00+0000`.
    Something already performs an "extraction" pass over the vault. Unidentified. Trace it — it may
    already be a partial atomizer, or a competing writer.

---

## 8. Scope Boundary — the retrieval spec that follows this one

jtr's goal: *"query the brain and have it pull from everything — general or specific, with confidence,
nothing missed, and if I want to dig in more I can."*

**That needs four things. This spec delivers two of them.**

| Requirement | Status |
|---|---|
| **1. A coverage mechanism** | ✅ **Already exists.** PGS: 82 partitions with centroids, summaries, keywords, adjacency. Match query → centroids → search relevant partitions → synthesize. Coverage by construction. Not luck. |
| **2. A complete, trustworthy corpus** | ❌ **This spec.** PGS can only cover what is in the brain. Today the brain lacks jtr's 250 Claude conversations (0 nodes), his ChatGPT history (1 *fabricated* node), his MRI (quarantined), his health log (dotfile, never seen), his records/catalogs (flattened to 1–2 nodes each). **No retrieval improvement can fix this.** And §4.1c-1 means the corpus can *invent* — there is no confidence in an answer citing a hallucinated sauna tile. |
| **3. A grounding chain you can drill into** | ❌ **Retrieval spec.** answer → node → manifest entry → **the file on disk**. §4.1b makes this possible (117,025 orphans have no file to drill into); §4.1d (catalog) makes "nothing missed" *checkable* — *"three conversations, two research runs, and an MRI I could not read, at this path."* **The known-unknown is stated rather than silently absent.** That is the only honest version of "nothing missed." |
| **4. The agent on the same path as jtr** | ❌ **Retrieval spec.** §1.13 — `context-assembly.ts` must use PGS like `brain.ts` and like the dashboard. Also: use the 461 MB ANN index; remove the `state_snapshot` force-injection; fix partition skew (one partition = 24% of the brain). |

**Ordering rationale (jtr's call, 2026-07-15):** decontamination first. PGS partitions are regenerated
during reingest, so retrieval tuned against a 70%-diary corpus would need re-tuning afterward. **Fix
what it sees, then fix how it sees.** Accepted cost: the agent keeps narrating until spec 2 lands.

## 9. What This Does Not Do

- Does not rewrite `engine/` wholesale. Root-cause fixes only.
- Does not add a governance layer, charter, registry, or verifier gate. Those become receipt factories.
- Does not touch the engine's real inventions: edges, Hebbian, embeddings, spreading activation,
  clustering, dream rewiring, consolidation, decay.
- Does not silence `live-problems`. It is the honest subsystem — executable verifiers, dry-run before
  promotion, closes on real evidence. It only loses `brain_node_count_stable`.
- Does not sleep or remove forrest. He is jtr's health agent and this design is the first thing that
  gives him his actual data.
