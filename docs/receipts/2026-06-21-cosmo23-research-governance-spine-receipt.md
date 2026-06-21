# COSMO23 Research Governance Spine Receipt

Date: 2026-06-21

Run evidence reviewed:

- `/Users/jtr/_JTR23_/release/home23/cosmo23/runs/jerrysideshows`
- `/Users/jtr/_JTR23_/release/home23/cosmo23/runs/jerrysideshows/exports`

## Diagnosis

`jerrysideshows` was not only an output-format failure. The deeper failure was
that source research requirements were carried as prose instead of as executable
run obligations.

Beginning:

- Planner tasks could mention web/source expectations through `sourceScope`,
  `webPolicy`, tools, prompts, or expected-output text without creating one
  authoritative source contract.
- Topic-only launches could therefore start research work without a durable
  machine-readable definition of required search/source evidence.

Middle:

- Execution progress was activity-based. A tool call with a failed command,
  HTTP 404/0, timeout, blocked command, or `{error}` result could reset stuck
  detection.
- Data acquisition could count command/log/file activity as accomplishment even
  when the actual source acquisition contract was unmet.
- Research and acquisition agents did not share the same authoritative source
  requirement language.

End:

- Expected files and generic manifests could satisfy task validation even when a
  source-required task had no source contact.
- Exhausted failed phases emitted blocked events but did not mark the persisted
  guided plan as `BLOCKED`.
- The commitment governor did not treat PlanExecutor `COMPLETED` status or
  blocked guided plans as first-class stop states.

## Fix

Added Patch 28, the contract-first research governance spine.

- `cosmo23/engine/src/core/research-contract.js` derives a machine-readable
  source contract from mission/task text, tools, source scope, acceptance
  criteria, and explicit metadata.
- `GuidedModePlanner` stores research contracts on generated missions and
  persisted tasks.
- `PlanExecutor` derives contracts for old/resumed tasks, injects them into
  spawned missions, validates source evidence before completion, and marks
  exhausted failed phases plus their plans as `BLOCKED`.
- `ResearchAgent` treats explicit `researchContract.required` metadata as
  source-required.
- `DataAcquisitionAgent` requires successful source contact/acquisition for
  source-required work instead of accepting command/file/log activity.
- `ExecutionBaseAgent` only resets no-progress detection on successful progress
  results.
- `RunCommitmentGovernor` recognizes blocked guided plans and `COMPLETED` plans
  as stop-governance states.

After review, this was not enough. Patch 29 repairs the underlying search/write
substrate that Patch 28 had exposed:

- exact `web_search for '...'` directives now bypass LLM query regeneration;
- nested quote/contraction searches such as `"I'll Take a Melody"` are preserved
  intact;
- local/Ollama research now defaults to the running Home23 SearXNG service at
  `http://localhost:8888`;
- source-required local/Ollama research disables DuckDuckGo HTML as an
  authoritative fallback;
- search results are scored and only relevant URLs count as source proof;
- source URLs are fetched and verification/captcha interstitials are rejected;
- failed source validation triggers repaired query forms before blocking;
- full raw backend evidence is still retained for audit;
- requested `@outputs/...` raw search evidence files are written directly; and
- `BaseAgent.writeFileAtomic()` now uses promise-based `fs` correctly, fixing a
  direct file-write primitive failure.

## Behavioral Contract

For source-required research, COSMO23 now distinguishes:

- `done`: expected outputs exist and source evidence satisfies the contract.
- `null finding`: source contact/search happened, but returned no useful
  findings.
- `blocked`: the run could not acquire/search sources after retries, so it must
  stop or repair instead of synthesizing absence prose.

Generic command activity, log files, and manifests no longer prove source
research by themselves.

Search itself must also prove that it ran through an authoritative backend and
returned relevant URLs. Low-quality search results are not accepted as source
proof.

## Verification

Targeted regression command:

```bash
npx mocha \
  cosmo23/engine/tests/unit/research-contract.test.js \
  cosmo23/engine/tests/unit/execution-base-agent.test.js \
  cosmo23/engine/tests/unit/data-acquisition-agent.test.js \
  cosmo23/engine/tests/unit/research-agent-handoff.test.js \
  cosmo23/engine/tests/unit/plan-executor-execution-types.test.js \
  cosmo23/engine/tests/unit/run-commitment-governor.test.js \
  cosmo23/engine/tests/unit/guided-mode-planner.test.js \
  --timeout 20000
```

Result before final restart: `185 passing`.

After Patch 29, focused regression command:

```bash
npx mocha \
  cosmo23/engine/tests/unit/web-search-free.test.js \
  cosmo23/engine/tests/unit/research-contract.test.js \
  cosmo23/engine/tests/unit/execution-base-agent.test.js \
  cosmo23/engine/tests/unit/data-acquisition-agent.test.js \
  cosmo23/engine/tests/unit/research-agent-handoff.test.js \
  cosmo23/engine/tests/unit/plan-executor-execution-types.test.js \
  cosmo23/engine/tests/unit/run-commitment-governor.test.js \
  cosmo23/engine/tests/unit/guided-mode-planner.test.js \
  --timeout 30000
```

Result before final restart: `193 passing`.

COSMO23 query/artifact/PGS/provider regression command:

```bash
node --test --test-concurrency=1 \
  tests/cosmo23/artifact-loop.test.cjs \
  tests/cosmo23/query-engine-context.test.cjs \
  tests/cosmo23/query-engine-runtime.test.cjs \
  tests/cosmo23/pgs-engine.test.cjs \
  tests/cosmo23/anthropic-client-request.test.cjs
```

Result before final restart: `53 passing`.

Syntax checks:

```bash
node -c cosmo23/engine/src/core/research-contract.js
node -c cosmo23/engine/src/core/guided-mode-planner.js
node -c cosmo23/engine/src/core/plan-executor.js
node -c cosmo23/engine/src/core/run-commitment-governor.js
node -c cosmo23/engine/src/agents/research-agent.js
node -c cosmo23/engine/src/agents/data-acquisition-agent.js
node -c cosmo23/engine/src/agents/execution-base-agent.js
```

Result before final restart: all syntax checks passed.

Live substrate checks:

- `http://localhost:8888/search?q=test&format=json` returned SearXNG JSON.
- The original `jerrysideshows` mission text now extracts all five exact
  `web_search` queries intact.
- A stubbed ResearchAgent local-search call reached SearXNG, rejected Reddit's
  verification interstitial, repaired the query, fetched a Lost Live Dead source
  successfully, and recorded only that fetchable URL in `sourcesFound` while
  retaining the full raw evidence list.

## Patch 30 Follow-Up: Source Backbone Modernization

After the substrate repair, review of `jerrysideshows` exports and provider
routes showed the remaining blocker: COSMO23 still treated provider-native web
search, local search, direct URLs, and MCP search as separate paths. A strong
model could search natively, but that could stop SearXNG/Brave from running;
MCP could still miss strict mode; and confirmation had no stable route/crossing
receipt files to inspect.

Implemented:

- direct source URLs in a query are fetch-validated before search;
- provider-native web-search sources/citations/text URLs are normalized into
  `searchEvidence` and validated for source-required work;
- provider-native search is supplemented by local SearXNG/Brave search by
  default;
- source-required gating is per query, not run-global;
- MCP `web_search` receives and honors source-required strict policy;
- `FreeWebSearch` aggregates Brave plus SearXNG results before DuckDuckGo
  fallback;
- research export always writes `source_attempts.jsonl`,
  `source_crossing.jsonl`, `extraction_receipts.jsonl`,
  `planned_vs_executed.json`, and `source_backbone_status.json`.

Focused verification:

```bash
npx mocha \
  cosmo23/engine/tests/unit/research-agent-handoff.test.js \
  cosmo23/engine/tests/unit/web-search-free.test.js \
  --timeout 30000
```

Result: `17 passing`.

Broader verification after Patch 30:

```bash
npx mocha \
  cosmo23/engine/tests/unit/web-search-free.test.js \
  cosmo23/engine/tests/unit/research-contract.test.js \
  cosmo23/engine/tests/unit/execution-base-agent.test.js \
  cosmo23/engine/tests/unit/data-acquisition-agent.test.js \
  cosmo23/engine/tests/unit/research-agent-handoff.test.js \
  cosmo23/engine/tests/unit/plan-executor-execution-types.test.js \
  cosmo23/engine/tests/unit/run-commitment-governor.test.js \
  cosmo23/engine/tests/unit/guided-mode-planner.test.js \
  --timeout 30000
```

Result: `200 passing`.

COSMO23 query/artifact/PGS/provider regression result: `53 passing`.

Syntax checks passed for `research-agent.js`, `web-search-free.js`,
`http-server.js`, `research-contract.js`, and `base-agent.js`.

Live source probe:

- local SearXNG returned 21 results for a Legion of Mary / Lost Live Dead query;
- ResearchAgent filtered noisy search output down to
  `http://lostlivedead.blogspot.com/2009/10/december-31-1974-keystone-berkeley.html`;
- URL validation fetched the page successfully with HTTP 200, 134,948 bytes,
  and a content hash; and
- `sourcesFound` contained only that fetchable source URL.

## Patch 31 Follow-Up: Typed Source Provider Registry

The next failure class was source breadth. Search is not enough for serious
research: the engine needs typed acquisition routes to canonical databases,
archive metadata, historical captures, scholarly registries, feeds, and
sitemaps.

Implemented:

- `SourceProviderRegistry` with first-class providers for:
  `web.search`, `archive.advancedsearch`, `archive.metadata`,
  `archive.reviews`, `archive.files`, `wayback.availability`, `wayback.cdx`,
  `commoncrawl.cdx`, `wikidata.entity_search`, `wikidata.sparql`,
  `openalex.works`, `crossref.works`,
  `semantic_scholar.paper_search`, `arxiv.query`,
  `pubmed.esearch_summary`, `rss.feed`, and `feed.sitemap`;
- normalized provider candidates with route, source type, URL, snippet, and
  metadata;
- provider attempt receipts in ResearchAgent search evidence, including route,
  status, counts, duration, and provider errors;
- metadata-only archive file validation using file size/hash from Archive
  metadata instead of downloading large files;
- contract-level `sourceProviderHints` for archive, historical web, knowledge
  graph, scholarly, preprint, biomedical, feed, media, forum, and social source
  obligations; and
- ResearchAgent honoring explicit contract provider hints even when the query
  text itself has no provider cue.

Subagent source review also identified the next source families to add to the
same registry: YouTube/video/transcript, podcast transcript enrichment, Reddit
and forum adapters, social/X adapters, rendered-browser capture, OCR, and audio
metadata. Those are intentionally not auto-executed in this patch because they
need separate credential, rate-limit, rendering, and transcript receipt rules.

Focused verification:

```bash
npx mocha cosmo23/engine/tests/unit/source-provider-registry.test.js --timeout 30000
npx mocha cosmo23/engine/tests/unit/research-contract.test.js --timeout 30000
npx mocha cosmo23/engine/tests/unit/research-agent-handoff.test.js --grep "researchContract source provider hints" --timeout 30000
npx mocha cosmo23/engine/tests/unit/research-agent-handoff.test.js --grep "metadata-only|typed source providers" --timeout 30000
```

Final verification:

- source-provider registry: `6 passing`
- research contract: `8 passing`
- ResearchAgent contract-hint path: `1 passing`
- ResearchAgent typed-provider focused path: `3 passing`
- focused governance/source regression suite:
  `212 passing`
- COSMO23 query/artifact/PGS/provider regression suite:
  `53 passing`
- syntax checks passed for `source-provider-registry.js`,
  `research-contract.js`, `research-agent.js`, `web-search-free.js`, and
  `http-server.js`

Live-safe provider probe:

- `archive.advancedsearch` accepted a Jerry Garcia / Keystone query and returned
  `https://archive.org/details/jg75-05-21.087526.DTS.menke-falanga-tobin.MOTB-0054.flac24`
- `wikidata.entity_search` accepted `Jerry Garcia` and returned
  `http://www.wikidata.org/entity/Q312870`
- `wayback.availability` accepted `https://example.com/` and returned a
  Wayback snapshot URL
- `openalex.works` accepted `knowledge graph research` and returned a DOI URL
