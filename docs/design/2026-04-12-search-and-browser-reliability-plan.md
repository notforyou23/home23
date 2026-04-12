# Search and Browser Reliability Plan

Date: 2026-04-12  
Author: jerry  
Scope: Home23 search stack, browser-backed web/X access, fallback architecture, startup resilience

---

## Executive Summary

Home23's search and browse failures are not one bug. They are a stack reliability problem caused by multiple independent weak points:

1. **Searxng is reachable but degraded** — the service responds on port `8888`, but several upstream engines are rate-limited, CAPTCHA-blocked, or access-denied.
2. **Brave fallback exists in code but is not wired into runtime** — the current tool path expects `BRAVE_SEARCH_API_KEY` in process env, but that is not configured through the active Home23 config path.
3. **Browser-backed browsing is down because Chrome CDP is not running on `9222`** — `web_browse` depends on a live Chrome remote debugging endpoint and currently has none.
4. **Failure detection is too naive** — current logic mostly treats only thrown request failures as failure. It does not correctly classify degraded-but-200 responses.
5. **Provider-native web/X search is fragmented** — xAI and some Anthropic paths support native search, but Home23 does not currently expose a unified search broker that can route intelligently between local tools, browser, and provider-native capabilities.

The result is a house that can appear "up" while delivering weak or no web results, and which loses browser-backed retrieval after machine restarts.

This document lays out the observed failure modes, current architecture, root causes, and a phased plan to make the search stack robust.

---

## What Was Verified

### 1. Searxng service status

Observed facts:

- A service is listening on `localhost:8888`.
- The Searxng container is running and mapped as `0.0.0.0:8888->8080`.
- Direct JSON search requests return `200 OK`.
- However, returned payloads and logs show degraded upstream engine state.

Examples observed:

- `brave`: suspended with "too many requests"
- `duckduckgo`: CAPTCHA
- `google`: suspended / access denied / 403
- `startpage`: CAPTCHA

Interpretation:

Searxng is not dead. It is **operationally degraded**. This matters because current tooling mostly reasons in binary: alive vs dead. For a metasearch engine, that is not enough.

### 2. Browser / CDP status

Observed facts:

- Nothing is listening on `localhost:9222`.
- Agent config contains browser support configuration.
- `web_browse` depends on the Chrome DevTools Protocol endpoint being reachable.

Interpretation:

The browser subsystem is configured but not actually available. This is a false-positive configuration state: the feature appears enabled but has no live backend.

### 3. Current search tool behavior

The main search behavior lives in:

- `src/agent/tools/web.ts`

Observed behavior:

- `web_search` tries Searxng first.
- It falls back to Brave only when the Searxng call hard-fails, not when Searxng returns low-quality or degraded responses.
- Brave fallback depends on `process.env.BRAVE_SEARCH_API_KEY`.
- If that env var is missing, the failure messaging is misleading and implies Searxng is down even when it is merely degraded.

Interpretation:

The system currently lacks a proper degradation model and a robust fallback trigger.

### 4. Runtime config state

Observed facts:

- `config/secrets.yaml` contains API keys for several providers.
- There is no evidence that Brave is configured as a first-class search provider in merged runtime config.
- Existing code path checks `process.env.BRAVE_SEARCH_API_KEY`, not merged YAML config.

Interpretation:

A Brave key may exist in principle, but Home23 is not using it through its current runtime configuration path.

### 5. Provider-native search capabilities

Observed facts:

- xAI paths expose server-side tools such as `web_search` and `x_search` in the agent loop.
- Anthropic support exists in Evobrew for native web search tooling in some paths.
- These capabilities are provider-specific and not currently abstracted behind one unified Home23 search broker.

Interpretation:

Search capability exists in pieces, but not in a consistent house-wide reliability strategy.

---

## Root Cause Analysis

### Root Cause 1 — Binary health model for a non-binary system

Current logic mostly answers:

- Is Searxng reachable?
- Did the request throw?

That is insufficient.

A metasearch engine can be:

- reachable but degraded
- reachable but heavily filtered
- reachable but mostly CAPTCHA-blocked
- reachable but returning only infoboxs / weak results

The system needs a **quality-aware health model**, not a simple reachability check.

### Root Cause 2 — Fallback only on hard failure

The fallback chain is too shallow.

Current practical behavior:

1. Try Searxng.
2. If it throws, maybe try Brave.
3. If Brave env var is absent, fail.

What is missing:

- fallback on degraded response
- fallback on zero usable results
- fallback on blocked major engines
- backend selection based on health, not just exceptions

### Root Cause 3 — Brave fallback is not first-class configuration

The Brave path is implemented in a way that depends on environment variables but is not integrated into Home23's normal provider/secret configuration flow.

That makes it brittle and invisible.

### Root Cause 4 — Browser lifecycle is unmanaged

`web_browse` depends on a sidecar browser service. That service is currently not lifecycle-managed in a resilient way.

After restart, the browser path can silently disappear.

This breaks:

- page extraction
- live web inspection
- likely any X/Twitter page access via the browser tool

### Root Cause 5 — Search capabilities are fragmented by provider

There is no central broker deciding:

- when to use local metasearch
- when to use API-backed search
- when to use provider-native search
- when to use browser-backed retrieval
- when to surface degraded status vs hard failure

This leads to inconsistent behavior and weak recovery.

---

## Current State: Capability Map

### A. Local metasearch

Backend:
- Searxng on `localhost:8888`

Strengths:
- local
- flexible
- no single-vendor dependency

Weaknesses:
- upstream engines block aggressively
- quality varies depending on engine health
- current Home23 logic does not inspect engine degradation deeply enough

### B. Brave API fallback

Backend:
- Brave Search API

Strengths:
- API-backed and less brittle than scraped engines
- good fallback for generic web search

Weaknesses:
- not wired into current runtime path
- depends on env var rather than first-class config

### C. Browser-backed retrieval

Backend:
- Chrome remote debugging on `localhost:9222`

Strengths:
- useful for live page extraction and sites that require a browser context
- required for some browse/X workflows

Weaknesses:
- currently down
- not restart-resilient
- not actively health-checked in a visible way

### D. Provider-native search

Backends:
- xAI native web/X search tools
- Anthropic native web search in specific integration paths

Strengths:
- potentially high quality
- no local scraping dependence

Weaknesses:
- provider-specific
- not universally available
- not unified behind a common broker

### E. Manual shell/curl fallback

Strengths:
- useful for agent-side recovery and direct verification

Weaknesses:
- not a first-class search experience
- should remain a last-resort path, not the primary design

---

## Why This Matters

Home23 is supposed to preserve working continuity, reduce repetition, and avoid dead ends. Right now the search stack violates that standard in a few ways:

- It can silently degrade without truthful status.
- It can fail after restart because browser infrastructure is not recovered.
- It can possess alternative search capabilities without routing to them.
- It can report misleading errors that slow down diagnosis.

This is not just a tooling annoyance. It is a continuity and trust problem.

---

## Plan of Action

# Phase 1 — Truthful Health and Diagnostics

Goal: make the system report reality, not vibes.

## 1.1 Add search subsystem health classification

Implement a health layer that evaluates:

- Searxng reachable?
- Searxng useful?
  - result count
  - blocked/unresponsive engines
  - known CAPTCHA / access-denied states
- Brave configured?
- Browser CDP reachable?
- Provider-native search available for current provider/model?

Recommended health states:

- `healthy`
- `degraded`
- `unavailable`

This should exist as a reusable internal utility, not ad hoc checks inside tool handlers.

## 1.2 Add browser health checks

At startup and/or first use:

- check `http://localhost:9222/json/version`
- classify browser as healthy or unavailable
- log explicit status

## 1.3 Fix user-facing errors

Current error copy is misleading when Searxng is reachable but degraded.

Replace with more precise messaging, e.g.:

- `Searxng reachable but degraded: brave rate-limited, duckduckgo CAPTCHA, google denied. Brave fallback unavailable because key is not configured.`
- `Browser configured but unavailable: no CDP listener on localhost:9222.`

Outcome of Phase 1:

- operators can see what is actually broken
- debugging time drops immediately
- the system stops claiming the wrong thing

---

# Phase 2 — Proper Search Fallback Chain

Goal: one search request should have a resilient path through multiple backends.

## 2.1 Define generic web search routing order

Recommended order:

1. **Searxng**, if healthy enough
2. **Brave API**, if Searxng is degraded or unavailable
3. **Provider-native search**, if current provider supports it and routing path allows it
4. **Browser-backed retrieval**, when live page extraction is needed and browser is healthy
5. **Manual shell/HTTP fallback**, as last-resort internal recovery

## 2.2 Treat degraded responses as fallback-worthy

Searxng should trigger fallback not only when requests throw, but also when responses are low-confidence.

Suggested degradation triggers:

- zero results
- only one low-value result
- major engines suspended or blocked
- response dominated by infoboxs with no useful result list
- known CAPTCHA or access-denied indicators in metadata

## 2.3 Normalize outputs across backends

Search results from different backends should be normalized into one internal shape:

- title
- url
- snippet
- source backend
- confidence/health context if useful

Outcome of Phase 2:

- search becomes resilient rather than brittle
- fallback becomes intentional, not accidental
- the house stops depending on one shaky upstream path

---

# Phase 3 — Brave as a First-Class Search Backend

Goal: make Brave fallback real and maintainable.

## 3.1 Configuration options

Two implementation options:

### Option A — Keep env-based approach

Use existing code path and ensure startup exports:

- `BRAVE_SEARCH_API_KEY`

Pros:
- small code change
- fast

Cons:
- inconsistent with other provider configuration
- weaker discoverability

### Option B — Promote Brave into merged Home23 config

Add a first-class config path such as:

- `providers.brave.apiKey`
or
- `search.brave.apiKey`

Update tool code to read config first, env second.

Pros:
- consistent with house architecture
- better secret management and visibility

Cons:
- small refactor needed

Recommendation:

**Option B** is the correct house-level fix.

## 3.2 Preserve env compatibility

Even if Brave becomes first-class config, retain env fallback for compatibility and local overrides.

Outcome of Phase 3:

- Brave becomes a real backend instead of a dormant code path

---

# Phase 4 — Browser / X Resilience Across Reboot

Goal: stop losing browsing and X/page inspection after machine restarts.

## 4.1 Decide browser process ownership

Choose one lifecycle owner:

- PM2-managed Chrome debug process
- launchd-managed Chrome debug process
- Home23-managed lazy-launch on demand

Recommendation:

Use a managed launcher rather than relying on manual startup.

## 4.2 Add startup verification

At Home23 startup:

- test browser CDP reachability
- if unavailable, either:
  - attempt to launch browser automatically, or
  - emit a clear actionable startup warning

## 4.3 Add first-use recovery

On `web_browse` invocation:

- if CDP is absent, try recovery before immediate failure
- if recovery is not permitted or fails, return precise status

## 4.4 Separate capabilities in status reporting

Distinguish:

- `browser configured`
- `browser healthy`
- `xAI native x_search available`

These are not the same capability.

Outcome of Phase 4:

- browser-backed retrieval survives reboot better
- X-related failures become diagnosable instead of mysterious

---

# Phase 5 — Central Search Broker

Goal: remove scattered backend-specific decision logic.

## 5.1 Introduce a broker abstraction

Suggested interfaces:

- `searchWeb(query, context)`
- `searchX(query, context)`
- `browseUrl(url, context)`

The broker decides which backend to use based on:

- health
- availability
- current provider
- request type
- configured preferences

## 5.2 Keep backend decisions in one place

Do not spread backend routing rules across:

- tool handlers
- provider overlays
- ad hoc runtime checks

A broker makes future changes easier:

- adding Tavily or Exa later
- changing search preference order
- collecting unified metrics

## 5.3 Do not make house search dependent on one provider

Provider-native search should be treated as a supported backend, not as the universal foundation.

Outcome of Phase 5:

- cleaner architecture
- easier maintenance
- fewer regressions when providers or local services change

---

# Phase 6 — Operator Observability and Control

Goal: make search reliability visible and operable.

## 6.1 Add subsystem status surface

Expose a concise status block showing:

- Searxng health
- blocked/degraded engines
- Brave configured yes/no
- browser CDP healthy yes/no
- provider-native search capability for active provider/model

Potential surfaces:

- startup logs
- dashboard status tile
- `/status` output

## 6.2 Log backend decisions

For each search request, record:

- backend selected
- failover reason
- result count
- latency
- degradation notes

## 6.3 Track reliability counters

Suggested metrics:

- Searxng healthy calls
- Searxng degraded calls
- Brave fallback count
- browser unavailable count
- provider-native search usage count

Outcome of Phase 6:

- future breakage becomes visible early
- search reliability can be measured instead of guessed

---

## Recommended Implementation Order

### Stage 1 — Immediate clarity

1. Add truthful health classification for Searxng and browser
2. Improve error messages
3. Log why backends were skipped or chosen

### Stage 2 — Make fallback real

4. Wire Brave configuration cleanly
5. Trigger fallback on degraded responses, not just thrown errors

### Stage 3 — Fix reboot brittleness

6. Add browser CDP startup/recovery logic
7. Make browser health visible on boot and status surfaces

### Stage 4 — Structural cleanup

8. Introduce search broker abstraction
9. Integrate provider-native search cleanly behind broker
10. Add dashboard/status subsystem visibility

---

## Proposed Deliverables

### Deliverable A — Search reliability patch

Likely files:

- `src/agent/tools/web.ts`
- new helper such as `src/search/health.ts`
- new helper such as `src/search/broker.ts`

Includes:

- degraded Searxng detection
- correct Brave fallback behavior
- honest error messages
- backend selection logging

### Deliverable B — Browser resilience patch

Likely files:

- `src/home.ts`
- `src/browser/cdp.ts`
- optional launcher/check helper

Includes:

- CDP health check
- startup status logging
- optional auto-launch or clearer recovery path

### Deliverable C — Config cleanup

Likely files:

- `src/config.ts`
- `config/home.yaml`
- `config/secrets.yaml`

Includes:

- first-class Brave config
- env compatibility fallback

### Deliverable D — Status surface

Potentially dashboard and/or startup status output showing:

- search backend health
- browser health
- provider-native search availability

---

## Risks and Constraints

### 1. Searxng will never be perfectly stable as a sole dependency

Because it depends on public/search-scraped engines, it will continue to face CAPTCHA and rate-limit issues.

Implication:

Do not treat Searxng as a durable sole primary backend.

### 2. Browser access is not the same as search availability

Even with a healthy browser, some sites can still block or limit access.

Implication:

Keep browser as one retrieval backend, not as the whole answer.

### 3. Provider-native search differs by vendor

xAI, Anthropic, Brave, and Searxng do not produce identical behavior or result quality.

Implication:

Broker needs result normalization and clear backend accounting.

### 4. Secret handling should stay disciplined

Avoid scattering Brave keys across ad hoc scripts if first-class config can solve it cleanly.

---

## Recommendation

The right house fix is:

1. **Make status honest**
2. **Wire Brave as real fallback**
3. **Treat degraded Searxng as failure-worthy**
4. **Restore browser health across reboot**
5. **Centralize search routing**

That yields a search stack that is observable, restart-resilient, and capable of surviving when one backend turns to shit.

---

## Appendix: Verified Surfaces Relevant to This Plan

Representative files inspected during investigation:

- `src/agent/tools/web.ts`
- `src/browser/cdp.ts`
- `src/agent/loop.ts`
- `src/agents/provider-overlays.ts`
- `src/config.ts`
- `config/home.yaml`
- `config/secrets.yaml`
- `instances/jerry/config.yaml`
- `docs/handoff/session_2026-04-08_handoff.md`
- `evobrew/lib/anthropic-client.js`

Representative runtime observations:

- Searxng listening on `8888`
- Searxng JSON endpoint returning `200`
- major upstream engines degraded or blocked
- no listener on browser CDP port `9222`

---

## Next Step Options

1. Turn this document into an implementation spec with exact function-level changes.
2. Patch the search reliability layer first.
3. Wire Brave config and browser startup path first.
4. Add status/health reporting before code changes so the system starts telling the truth immediately.
