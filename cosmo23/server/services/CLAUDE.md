# CLAUDE.md — Security & Provider Setup (server/services/, server/providers/, server/config/)

This file provides guidance to Claude Code (claude.ai/code) when working on authentication, encryption, provider configuration, and security in COSMO 2.3.

---

## Security Stack Overview

Three credential layers:

| Layer | Location | Contents |
|---|---|---|
| Config file | `~/.cosmo2.3/config.json` | Provider API keys (encrypted at rest) for OpenAI/xAI/Ollama Cloud, ports, security flags |
| SQLite database | `~/.cosmo2.3/database.db` | Anthropic OAuth tokens (AES-256-GCM encrypted) — Anthropic is OAuth-only, no API keys |
| Environment variables | `process.env` | Runtime copies of config values (populated at startup) |

---

## Two Separate Encryption Systems

### `lib/encryption.js` — Config-File Encryption

Used by `lib/config-manager.js` for secrets in `config.json`.

- **Algorithm:** AES-256-GCM
- **Format:** `encrypted:IV_hex:authTag_hex:ciphertext_hex` (the `encrypted:` prefix is the sentinel)
- **Key priority:** `ENCRYPTION_KEY` env var → `config.security.encryption_key` → machine-derived PBKDF2 from `hostname:username:cosmo-2-3-config-salt`
- **Auto-encrypted fields:** Any string value whose key contains `api_key`, `token`, `password`, or `secret`
- Machine-derived key provides obscurity only — anyone knowing hostname + username can decrypt

### `server/services/encryption.js` — Database Encryption

Used exclusively by `anthropic-oauth.js` for OAuth token storage.

- **Algorithm:** AES-256-GCM
- **Format:** `IV_hex:authTag_hex:ciphertext_hex` (NO prefix — differs from lib/encryption.js)
- **Key source:** `ENCRYPTION_KEY` env var only (64 hex chars required). Throws if not set.
- Also provides `validateKeyFormat(apiKey, provider)` and `testApiKey(apiKey, provider)` for live key validation.

---

## Anthropic OAuth Flow (PKCE) — OAuth-Only, No API Keys

**File:** `server/services/anthropic-oauth.js`

### Constants
- Client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Authorize: `https://claude.ai/oauth/authorize`
- Token: `https://console.anthropic.com/v1/oauth/token`
- Redirect: `https://console.anthropic.com/oauth/code/callback`
- Scopes: `org:create_api_key user:profile user:inference`
- Claude Code version impersonated: `2.1.32`

### Flow
1. **Start:** `getAuthorizationUrl()` → PKCE verifier + SHA-256 challenge → auth URL. Verifier stored in `state` param and in-memory `oauthPkceStateStore` (10-min expiry).
2. **User authorizes** at claude.ai.
3. **Exchange:** `exchangeCodeForTokens(code, state, verifier)` → POST to token endpoint → access + refresh tokens. Expiry has 5-minute buffer.
4. **Store:** `storeToken()` → AES-256-GCM encrypt → Prisma/SQLite upsert at key `anthropic_oauth`.
5. **Retrieve:** `getAnthropicApiKey()` → cache → DB → auto-refresh if expired → error (no API key fallback).
6. **Import alternative:** `importFromClaudeCLI()` reads `~/.claude/auth.json`.

**Engine mirror:** `engine/src/services/anthropic-oauth-engine.js` — must stay in sync with server version.

### Stealth Mode Headers
OAuth tokens require impersonating Claude Code CLI:
```
user-agent: claude-cli/2.1.32 (external, cli)
x-app: cli
anthropic-dangerous-direct-browser-access: true
anthropic-beta: claude-code-20250219,oauth-2025-04-20,...
```

Version `2.1.32` exists in TWO places that must stay in sync: `anthropic-oauth.js:55` and `anthropic.js:36`.

### System Prompt Injection
OAuth mode prepends: `"You are Claude Code, Anthropic's official CLI for Claude."` with `cache_control: { type: 'ephemeral' }`.

### OAuth-Only Mode (Always Active)
`ANTHROPIC_OAUTH_ONLY=true` is always set at startup. Anthropic API keys are never accepted, stored, or used as fallback. All Anthropic auth goes through OAuth (PKCE or CLI import).

---

## OpenAI Codex OAuth Flow

**File:** `server/services/codex-oauth.js`

### Constants
- Authorize: `https://auth.openai.com/authorize`
- Token: `https://auth.openai.com/oauth/token`
- Redirect: `https://chatgpt.com/backend-api/oauth/callback`
- Token format: JWT (not a standard `sk-` API key)

### Flow
1. **Start:** `getAuthorizationUrl()` → PKCE verifier + SHA-256 challenge → Codex auth URL. Verifier stored in `state` param and in-memory store (10-min expiry).
2. **User authorizes** at auth.openai.com.
3. **Exchange:** `exchangeCodeForTokens(code, state, verifier)` → POST to token endpoint → JWT access + refresh tokens. Expiry has 5-minute buffer.
4. **Store:** `storeToken()` → AES-256-GCM encrypt → Prisma/SQLite upsert at key `openai_codex_oauth`.
5. **Retrieve:** `getCodexToken()` → cache → DB → auto-refresh if expired.
6. **Import alternative:** `importFromEvobrew(credentials)` — imports credentials from evobrew format as a second credential path alongside PKCE.

### Token Refresh
Auto-refresh via POST to `https://auth.openai.com/oauth/token` with `grant_type: refresh_token`.

### DB Key
SQLite key: `openai_codex_oauth` (distinct from `anthropic_oauth`).

---

## Provider Adapter Architecture

### Abstract Base (`server/providers/adapters/base.js`)
Subclasses implement: `id`, `name`, `capabilities`, `getAvailableModels()`, `_initClient()`, `createMessage()`, `streamMessage()`, `convertTools()`, `parseToolCalls()`, `normalizeResponse()`.

### Anthropic Adapter (OAuth-Only)
- Always OAuth: SDK initialized with `authToken` + stealth headers + mandatory system prompt
- No API key path — `createAnthropicAdapter(apiKey)` factory removed, only `createAnthropicAdapterWithOAuth()` exists
- Extended thinking budget: low=2000, medium=8000, high=32000 tokens

### OpenAI Adapter
- Dual API routing: `gpt-5*` and `o3*/o4*` → Responses API; others → Chat Completions
- Responses API carries stateful `_previousResponseId`
- **xAI reuse:** same class with `baseUrl: 'https://api.x.ai/v1'`, `id: 'xai'`
- **LMStudio reuse:** same class with `baseUrl: 'http://localhost:1234/v1'`, `apiKey: 'not-needed'`

### Ollama Adapter
- No auth, URL-based only
- Native REST for embeddings (`/api/embeddings`), OpenAI-compatible `/v1` for chat
- XML tool call fallback: parses `<tool_call>...</tool_call>` blocks
- `reducedParallelism: true`

### Registry (`server/providers/registry.js`)
Model lookup: explicit map → provider prefix → heuristic name matching → provider scan. Singleton via `getDefaultRegistry()`, reset after credential/model changes.

---

## API Key Management

### Storage
In `config.providers.<name>.api_key`, encrypted at rest by `encryptConfigSecrets()`. `mergeSecret()` never overwrites existing secrets with empty strings. **Anthropic has no `api_key` field** — OAuth-only via SQLite.

### Validation
`validateKeyFormat(apiKey, provider)`: OpenAI must start with `sk-` (≥40 chars), xAI ≥30, default ≥20.
`testApiKey(apiKey, provider)`: Live API call — OpenAI `models.list()`, xAI `models.list()`.

---

## Prisma / SQLite

**Schema:** Single `SystemConfig` table — `{ key (PK), value (encrypted), expiresAt?, createdAt, updatedAt }`.

Current keys: `anthropic_oauth`, `openai_codex_oauth`.

DB location: `~/.cosmo2.3/database.db` if global config dir exists, else `./prisma/cosmo2.3.db`. Table created by Prisma migrations or by `ensureSystemConfigTable()` raw SQL fallback.

---

## Platform Detection (`server/config/platform.js`)

- Raspberry Pi: checks `/proc/device-tree/model`, `/proc/cpuinfo`, hostname patterns
- `supportsLocalModels`: macOS=true, Pi=false, Linux with ≥16GB=true
- Gates whether Ollama initialization is attempted (remote Ollama URLs bypass this)

---

## Model Catalog (`server/config/model-catalog.js`)

Storage: `~/.cosmo2.3/model-catalog.json`. Built-in fallback in `BUILTIN_MODEL_CATALOG`.

Defaults: queryModel=`gpt-5.2`, pgsSweepModel=`claude-sonnet-4-6`, embeddings=`text-embedding-3-small` at 512 dims.

`inferProviderFromModel(modelId)`: catalog lookup → prefix heuristics (`claude*`→anthropic, `grok*`→xai, `gpt*`→openai, `qwen*`/`llama*`→ollama).

---

## Environment Variables

### Ports
`COSMO23_PORT` (43110), `COSMO23_WS_PORT` (43140), `COSMO23_DASHBOARD_PORT` (43144), `COSMO23_MCP_HTTP_PORT` (43147)

### Provider Keys
`OPENAI_API_KEY`, `XAI_API_KEY` (Anthropic uses OAuth only — no `ANTHROPIC_API_KEY`)

### Local LLM
`OLLAMA_BASE_URL` (localhost:11434), `LOCAL_LLM_BASE_URL`, `LOCAL_LLM_MODEL`, `LOCAL_LLM_FAST_MODEL`

### Security
`ENCRYPTION_KEY` (64 hex), `SECURITY_PROFILE` (local/internet), `ANTHROPIC_OAUTH_ONLY`

---

## Security Boundaries

- Config file: mode `0o600`, atomic writes (temp+rename), directory mode `0o700`
- CORS: `cors()` with NO origin restriction — safe for local, risky if exposed
- Security profiles: `local` (default, no restrictions) vs `internet` (requires proxy secret, workspace root, Collabora secret, allowlist)
- Token cache: process memory only
- Machine-derived key: hostname+username — obscurity only, not real security
