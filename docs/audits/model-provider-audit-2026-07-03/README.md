# Home23 Model and Provider Audit

Date: 2026-07-03
Scope: onboarding, Settings, agent config, engine cognition, chat runtime, Feeder, Query, COSMO23, Evobrew, docs, and tests.
Mode: no data deletes, no PM2 restarts, no agent creation, no launch actions.

## Executive Summary

The user-facing problem is real: Home23 has valid separate model purposes, but the install flow and several runtime surfaces do not expose those purposes as a coherent plan. A new user sees providers and models before they know which model is for chat, which model is for file ingestion, which model is for Query/research, and which model is internal engine routing.

The right product direction is not "one model everywhere." The right direction is a simple Model Plan:

- Chat: direct conversation with the personal agent.
- Memory: compaction and memory extraction, normally inherited from chat.
- Documents: Feeder compiler and vision converter.
- Query: normal Query and PGS sweep/synthesis.
- Research: COSMO launch roles.
- Engine: cognition, critique, pulse voice, promoter, and other internal slots.
- Embeddings: brain search vectors.
- Media: image, voice, and optional creative tools.

First-run setup should only ask the user to connect providers and pick the Chat model profile. Everything else should use recommended defaults and be visible later as advanced model routing.

For a user with only one paid LLM subscription, the release story must be explicit:

- Claude Max OAuth or ChatGPT/Codex OAuth can cover chat, but not embeddings.
- OpenAI API can cover chat and embeddings.
- Ollama Cloud can cover chat and hosted embeddings when configured as the embedding provider.
- Any paid chat LLM can pair with free local Ollama `nomic-embed-text` for embeddings.

So the practical v1 minimum is one chat LLM provider for launch. The recommended baseline is paid/free chat provider + local Ollama embeddings, with Memory Lite available when embeddings are not configured yet.

## Evidence Captured

Screenshots are stored in `docs/audits/model-provider-audit-2026-07-03/screenshots/`:

- `01-setup-provider.png`: first-run provider step.
- `02-create-agent-context.png`: first-run agent context and project import step.
- `03-agent-model-choice.png`: pre-fix model step, where raw provider/model choice appeared as a general default.
- `04-settings-models.png`: Settings Models tab showing chat default plus advanced routing.
- `05-settings-providers.png`: redacted Providers screen, showing OAuth plus API key structure.
- `06-settings-feeder.png`: Feeder settings surface.
- `07-settings-query.png`: Query settings surface.
- `08-settings-system.png`: System settings with embeddings and chat numeric defaults.
- `09-setup-chat-model-after-fix.png`: post-fix setup step, now labeled Chat Provider / Chat Model.

Three read-only code explorers also audited the system in parallel:

- CLI/setup/config/docs and generated agent config.
- Runtime call sites in `src/` and `engine/src/`.
- Dashboard/provider UI/API plus COSMO23 and Evobrew integrations.

## Current Model Call Map

| Purpose | Main surface | Current shape |
| --- | --- | --- |
| Chat default | `instances/<agent>/config.yaml`, Settings Models, `src/home.ts`, `src/agent/loop.ts` | Provider plus model, mostly explicit. |
| Runtime chat override | Chat turn routes and command handler | Aliases and raw model names can infer provider. |
| Compaction and memory extraction | `src/agent/compaction.ts`, `src/agent/memory.ts`, `src/agent/text-generation.ts` | Mostly inherits current chat provider/model, but helper has duplicated provider inference. |
| Engine cognition | `configs/base-engine.yaml`, `engine/src/core/unified-client.js`, `modelAssignments` | Many internal slots, currently advanced and mixed-scope. |
| Pulse voice | Settings Models, `engine/src/pulse/pulse-remarks.js` | Agent-specific optional override. |
| Feeder compiler | `configs/base-engine.yaml`, Feeder settings, `engine/src/ingestion/document-compiler.js` | Separate compiler model. |
| Feeder converter vision | Feeder settings API and base-engine config | Drift exists between docs/API defaults and current base config. |
| Query default and PGS | Settings Query, `engine/src/dashboard/home23-query-api.js`, COSMO query bridge | Multiple defaults, some provider identity gaps. |
| COSMO research roles | COSMO launch roles and vendored patches | Purpose separation is better here; reuse this pattern. |
| Evobrew | Generated Home23-managed config | Uses Home23 catalogs, but still exposes native provider setup in managed mode. |
| Embeddings | System settings and config | Separate vector model path, correctly not a chat model. |
| Media | Vibe/image generation and optional media tools | Separate provider/model path. |

## Findings

1. First-run model setup was too generic. The wizard said "Default Provider/Default Model" and could default to the first provider catalog entry rather than the configured chat default. This made one chat choice look like it controlled every model call. Fixed in this audit.

2. The provider gate only proves that some provider is configured. It does not yet ensure that the selected chat provider is reachable. A user could connect Anthropic or Codex and still pick an unconfigured API-key provider if they manually change the dropdown.

3. There is no shared model-slot contract. Chat, memory, cognition, Feeder, Query, COSMO, Evobrew, embeddings, and media each have their own resolver or defaults.

4. Agent config generation is duplicated. CLI agent creation and web agent creation both write provider/model fields, but they do not use one shared builder and they diverge on engine defaults.

5. Query model selection drops provider identity in places. Model IDs such as `gpt-5.5` are ambiguous when both OpenAI API and OpenAI Codex exist.

6. Bare `gpt*` inference still tends to route to `openai`, not `openai-codex`, unless provider is explicitly preserved. That is risky for OAuth-first installs.

7. Feeder converter defaults drift. Current base config, Settings API fallback, and older design docs do not all describe the same default vision model.

8. Evobrew managed mode still exposes too much provider setup. Home23-managed Evobrew should point users back to Home23 Providers instead of offering writable provider setup paths.

9. "Active" often means "has key" rather than "provider tested and usable." Onboarding should distinguish configured, reachable, expired, rate-limited, and pending restart.

10. Documentation is close but not fully aligned. Some examples still reference older model names or omit OAuth-managed provider slots such as `openai-codex`.

## Safe Fixes Completed

1. Reworded the agent wizard model step from a generic model choice to Chat Provider / Chat Model.
   - `engine/src/dashboard/home23-settings.html`

2. Added explicit first-run copy explaining that file ingestion, Query, and cognition keep recommended defaults until advanced routing is tuned.
   - `engine/src/dashboard/home23-settings.html`

3. Changed the wizard defaulting behavior to use the effective chat default from `/home23/api/settings/models` when entering the model step.
   - `engine/src/dashboard/home23-settings.js`

4. Removed the incorrect `MiniMax-M3` fallback from the Ollama Cloud wizard model fallback list.
   - `engine/src/dashboard/home23-settings.js`

5. Updated the OpenAI Codex missing-credentials error to point users to Home23 Setup or Settings > Providers instead of `evobrew login`.
   - `src/agent/loop.ts`

6. Wired generated PM2 env to the configured embedding provider instead of hardcoding local Ollama.
   - `cli/lib/generate-ecosystem.js`

7. Updated memory embedding request parameters to honor `EMBEDDING_MODEL` and `EMBEDDING_DIMENSIONS`.
   - `engine/src/memory/network-memory.js`

8. Updated onboarding docs to state that one paid chat subscription still needs an embedding lane.
   - `README.md`
   - `docs/ONBOARDING.md`

9. Added Memory Lite behavior so missing embeddings no longer prevent text memory storage or keyword retrieval.
   - `engine/src/memory/network-memory.js`
   - `engine/src/dashboard/server.js`
   - `src/chat/agent.ts`

10. Added setup readiness status for Chat Provider, Memory Lite, Semantic Brain, and Backfill Needed.
    - `engine/src/dashboard/home23-settings-api.js`
    - `engine/src/dashboard/home23-settings.html`
    - `engine/src/dashboard/home23-settings.js`

11. Added a safe embedding backfill action. Live current-agent engines run the existing background regeneration immediately; otherwise the request is recorded as ignored runtime state for the next engine load path.
    - `engine/src/dashboard/home23-settings-api.js`
    - `engine/src/core/orchestrator.js`

12. Enforced that web agent creation cannot select an unconfigured chat provider.
    - `engine/src/dashboard/home23-settings-api.js`
    - `engine/src/dashboard/home23-settings.js`

13. Added a simple Models "Model Plan" surface above advanced routing.
    - `engine/src/dashboard/home23-settings.html`
    - `engine/src/dashboard/home23-settings.js`

14. Shared the initial agent config builder between CLI and web setup so chat defaults and internal engine defaults cannot drift.
    - `cli/lib/agent-config-builder.cjs`
    - `cli/lib/agent-create.js`
    - `engine/src/dashboard/home23-settings-api.js`

No existing agent configs, provider credentials, or runtime data were modified.

## Recommended Architecture

### Phase 1: First-Run Model Plan

Create a first-run "Model Plan" card after provider connection:

- Recommended: use the connected chat provider for Chat.
- Background: keep Documents, Query, Engine, and Embeddings on recommended defaults.
- Advanced: expandable table showing each purpose and the provider/model it will use.
- Validation: the selected Chat provider must be configured and reachable before Create Agent.

### Phase 2: Model Slot Contract

Define a shared contract:

```yaml
modelSlots:
  chat.default:
    provider: openai-codex
    model: gpt-5.5
  memory.compaction:
    inherits: chat.default
  memory.extraction:
    inherits: chat.default
  feeder.compiler:
    provider: minimax
    model: MiniMax-M3
  feeder.converterVision:
    provider: minimax
    model: MiniMax-M3
  query.default:
    provider: anthropic
    model: claude-opus-4-8
  query.pgsSweep:
    provider: minimax
    model: MiniMax-M3
  query.pgsSynthesis:
    provider: anthropic
    model: claude-opus-4-8
  engine.fast:
    provider: ollama-cloud
    model: nemotron-3-nano-chat-4b
  engine.strong:
    provider: openai-codex
    model: gpt-5.5
  pulse.voice:
    inherits: engine.fast
  embeddings.primary:
    provider: ollama-local
    model: nomic-embed-text
```

Then build one resolver:

```ts
resolveModelSlot(slot, { agent, override }) -> {
  provider,
  model,
  clientKind,
  authSource,
  baseURL,
  available,
  sourceLayer
}
```

This resolver should be used by chat, memory helpers, engine `UnifiedClient`, Feeder compiler/converter, Query routes, COSMO bridges, Evobrew generated config, and media helpers.

### Phase 3: Typed Provider Catalog

Replace flat `defaultModels` arrays with typed entries:

```yaml
providers:
  openai-codex:
    auth: oauth
    models:
      - id: gpt-5.5
        label: GPT-5.5
        capabilities: [chat, reasoning, vision]
        recommendedFor: [chat.default, engine.strong]
        costTier: high
        latencyTier: medium
```

The UI should filter by purpose, not by raw provider arrays.

### Phase 4: Settings Simplification

Settings Models should become:

- Main card: Chat model for the selected agent.
- Model Plan card: Documents, Query, Engine, Embeddings, Media with status chips.
- Advanced editor: current cognitive routing table, but provider-qualified and slot-based.
- Runtime receipt: last provider/model used per slot, with source layer and error if unavailable.

### Phase 4b: Memory Lite Onboarding

Expose the memory state plainly in setup and Settings:

- `Chat ready`: at least one chat provider is configured.
- `Memory Lite`: embeddings are missing; Home23 stores text and uses keyword retrieval.
- `Semantic Brain`: embeddings are configured and current.
- `Backfill needed`: text nodes exist without embeddings and should be vectorized in the background.

### Phase 5: Tests

Add contract tests:

- Fresh install resolves every visible slot to an enabled provider or a clearly optional disabled state.
- Setup chat provider dropdown defaults to the configured chat provider/model.
- Provider gate rejects a selected chat provider that is not configured.
- Query saves and sends provider-qualified model choices, including PGS synthesis.
- Bare `gpt*` model strings do not silently switch from `openai-codex` to `openai`.
- CLI and web agent creation produce equivalent model-slot config.
- Feeder compiler/converter defaults match config, API fallback, docs, and UI.
- Home23-managed Evobrew provider mutation routes are read-only or blocked.

## Verification

Commands run:

```bash
node --check engine/src/dashboard/home23-settings.js
npm run build
```

Browser verification:

- Loaded `/home23/setup`.
- Advanced through provider, identity, and optional channels steps using throwaway form values.
- Verified the final step labels are Chat Provider / Chat Model.
- Verified the selected value defaults to the effective chat default in the live install.
- Did not click Create Agent or Launch.

## Remaining Risk

The small fix makes onboarding less misleading, but it does not solve the underlying architecture. The next durable work is the shared model-slot resolver and typed provider catalog. Until then, Home23 can still drift because background model calls are configured through multiple files and APIs.
