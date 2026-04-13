# Cosmohome Evobrew Bridge Route — Design Spec

**Date:** 2026-04-03
**Scope:** Add `POST /api/chat` to cosmohome2.3 agents for evobrew integration
**Codebase:** `/Users/jtr/_JTR23_/cosmo-home_2.3/`

## Summary

A thin bridge route that lets evobrew dispatch to cosmohome agents as local providers. The bridge accepts evobrew's request format (messages, tools, systemPrompt), calls the Anthropic SDK with streaming, and translates the stream into UnifiedChunk SSE format. It does NOT execute tools — evobrew handles tool execution and sends follow-up requests.

## Request Format (evobrew -> bridge)

```
POST /api/chat
Authorization: Bearer {config.token}
Content-Type: application/json

{
  "messages": [
    { "role": "user", "content": "Read the file at /src/index.js" },
    { "role": "assistant", "content": [{ "type": "tool_use", "id": "t1", "name": "file_read", "input": {...} }] },
    { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": "..." }] }
  ],
  "tools": [
    { "name": "file_read", "description": "...", "input_schema": { "type": "object", ... } }
  ],
  "model": "local:coz",
  "maxTokens": 64000,
  "temperature": 0.1,
  "systemPrompt": "You are an AI assistant in the Evobrew IDE..."
}
```

Messages use Anthropic SDK format (role: user/assistant, content blocks with tool_use/tool_result).

## Response Format (bridge -> evobrew)

SSE stream with `data:` prefixed JSON lines matching `UnifiedChunk`:

```
data: {"type":"text","text":"Let me read that file."}
data: {"type":"tool_use_start","toolId":"toolu_abc","toolName":"file_read"}
data: {"type":"tool_use_delta","toolId":"toolu_abc","argumentsDelta":"{\"file_path\":\"...\"}" }
data: {"type":"tool_use_end","toolId":"toolu_abc"}
data: {"type":"done","stopReason":"tool_use"}
```

## Implementation

### New file: `src/routes/evobrew-bridge.ts`

Single exported function: `createEvobrewBridge(config)` that returns an Express route handler.

**Config needed:**
- `contextManager` — to load agent identity (SOUL.md, MISSION.md, etc.)
- `client` — Anthropic SDK client (or credentials to create one)
- `defaultModel` — agent's default model (e.g., `claude-sonnet-4-6`)
- `token` — Bearer token for auth

**Handler logic:**
1. Validate Bearer token
2. Parse request body (messages, tools, systemPrompt, model, maxTokens, temperature)
3. Build merged system prompt: `evobrew systemPrompt + "\n\n---\n\n" + agent identity from contextManager`
4. Call `client.messages.stream()` with:
   - `model`: from request or `defaultModel`
   - `system`: merged system prompt
   - `messages`: from request (already in Anthropic format)
   - `tools`: from request (already in JSON Schema / Anthropic format)
   - `max_tokens`: from request or 64000
   - `temperature`: from request or 0.7
5. Set response headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
6. Translate Anthropic stream events to UnifiedChunk SSE:
   - `content_block_start` with `type: "text"` → (no emit, wait for deltas)
   - `content_block_delta` with `type: "text_delta"` → emit `{"type":"text","text":"..."}`
   - `content_block_start` with `type: "tool_use"` → emit `{"type":"tool_use_start","toolId":"...","toolName":"..."}`
   - `content_block_delta` with `type: "input_json_delta"` → emit `{"type":"tool_use_delta","toolId":"...","argumentsDelta":"..."}`
   - `content_block_stop` (after tool_use) → emit `{"type":"tool_use_end","toolId":"..."}`
   - `message_stop` → emit `{"type":"done","stopReason":"end_turn"|"tool_use"}`
7. End response

**Error handling:**
- Auth failure: 401 JSON
- Missing/invalid body: 400 JSON
- LLM error: emit `{"type":"done","stopReason":"error","error":"..."}` then end stream
- Connection close: abort the SDK stream

### Modify: `src/channels/webhooks.ts`

In `WebhookServer.start()`, after the session API routes (around line 114), register:

```typescript
app.post('/api/chat', createEvobrewBridge({
  contextManager: this.contextManager,
  client: this.agent.getClient(),
  defaultModel: this.agent.model,
  token: config.token
}));
```

### Health endpoint

Add `GET /health` returning `{ status: "ok", agent: config.name }` for the evobrew setup wizard connectivity test.

## What this does NOT include

- **Tool execution** — evobrew handles all tool execution
- **Conversation persistence** — evobrew manages chat history
- **Agent loop integration** — bypass entirely, direct SDK call
- **Non-Anthropic providers** — bridge only supports Claude models via the Anthropic SDK. If the agent's default model is non-Anthropic, the bridge should still work if evobrew passes a Claude model override. Future work could add OpenAI-compatible dispatch.
- **Streaming for non-Claude models** — out of scope for v1

## Build & Deploy

After adding the route, rebuild the TypeScript:
```bash
cd /Users/jtr/_JTR23_/cosmo-home_2.3
npx tsc
pm2 restart cosmo23-coz cosmo23-edison cosmo23-tick
```

Then configure evobrew:
```json
{
  "providers": {
    "local_agents": [
      { "name": "COZ", "id": "coz", "url": "http://localhost:4611", "endpoint": "/api/chat", "enabled": true }
    ]
  }
}
```
