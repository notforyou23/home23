# Step 3 Design: Unified Provider System

> Approved 2026-04-07. Approach: env vars as bridge, start script as integration point.

**Goal:** Make `config/home.yaml` the single source of truth for provider definitions (URLs, capabilities) and `config/secrets.yaml` the single source of truth for API keys. Both engine and harness draw from these via env vars set by the start script. Eliminate duplicate provider config in `configs/base-engine.yaml`.

**Scope:** Config consolidation + start script improvement. No engine JS code changes. No harness TS code changes (it already reads from the merged config).

---

## What Changes

### configs/base-engine.yaml

Strip hardcoded provider URLs. The engine's `providers:` section keeps structural config (enabled, supportsTools, modelMapping) but URLs and API keys come from env vars.

Before:
```yaml
providers:
  ollama-cloud:
    enabled: true
    baseURL: "https://ollama.com/v1"
    # apiKey provided via env var OLLAMA_CLOUD_API_KEY
    defaultModel: "nemotron-3-nano:30b"
    supportsTools: true
    supportsStreaming: true
```

After:
```yaml
providers:
  ollama-cloud:
    enabled: true
    # baseURL and apiKey provided via env vars from config/home.yaml + secrets.yaml
    defaultModel: "nemotron-3-nano:30b"
    supportsTools: true
    supportsStreaming: true
```

The engine code already reads `OLLAMA_CLOUD_API_KEY` from env. If the engine also reads a `baseURL` env var, we set it. If not, the engine falls back to its internal default — which is fine since we're not changing engine code.

### scripts/start-agent.sh

Currently does naive grep for API keys from secrets.yaml. Extend to also read provider URLs from home.yaml. Pass all provider info as env vars to all 4 processes.

**Env vars set by start script:**

| Env var | Source file | Source path | Used by |
|---|---|---|---|
| `OLLAMA_CLOUD_API_KEY` | secrets.yaml | providers.ollama-cloud.apiKey | Engine |
| `ANTHROPIC_AUTH_TOKEN` | secrets.yaml | providers.anthropic.apiKey | Harness |
| `OPENAI_API_KEY` | secrets.yaml | providers.openai.apiKey | Engine, Harness |
| `XAI_API_KEY` | secrets.yaml | providers.xai.apiKey | Harness |
| `EMBEDDING_BASE_URL` | home.yaml | embeddings.providers[0].endpoint | Engine |

Provider URLs for Ollama Cloud and xAI are already correct in the engine config and harness config respectively. The start script exports them as env vars so any process can use them, but the primary consumer of each is clear.

### config/home.yaml

No changes — already the authoritative source for provider URLs.

### config/secrets.yaml

No changes — already the authoritative source for API keys.

### Harness (src/)

No changes — already reads providers from the merged config object in memory.

---

## What Stays the Same

- Engine's `modelAssignments` in base-engine.yaml (engine-internal routing, 50+ lines)
- Harness's `models.aliases` in home.yaml (chat convenience aliases)
- Engine JS code (no modifications)
- Harness TS code (no modifications)
- The 4-process architecture from Step 2

---

## Verification

Step 3 is done when:

1. `config/home.yaml` is the only place provider URLs are defined
2. `config/secrets.yaml` is the only place API keys live
3. `configs/base-engine.yaml` has no hardcoded provider URLs or embedded API keys
4. Start script reads from home.yaml + secrets.yaml and passes env vars to all processes
5. All 4 processes start and work (engine cycles, dashboard responds, harness chats on Telegram)
6. Changing a provider URL in home.yaml is reflected by all processes on next restart

---

## What's Next

Step 4: Process manager + system service — replace start/stop shell scripts with a proper process manager (launchd on Mac, systemd on Linux) so agents run as system services that survive reboots.
