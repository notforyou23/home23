# Agent Discovery & Setup — Design Spec

**Date:** 2026-04-03
**Scope:** Auto-discovery of local agents, identity verification, CLI wizard, frontend Settings UI

## Summary

Local agents work end-to-end (bridge, adapter, model picker) but setup is manual and error-prone — users must know ports, edit config.json by hand, and there's no identity verification. This spec adds a scanner that finds agents on the network, verifies their identity, and provides setup flows in both the CLI wizard and frontend Settings panel.

## Discovery Protocol

Any agent process that wants to be discoverable exposes:

```
GET /health
→ { "status": "ok", "agent": "<name>", "type": "<framework>", "endpoint": "/api/chat" }
```

Fields:
- `agent` — the agent's self-identified name (e.g., "coz", "edison", "tick")
- `type` — framework identifier (e.g., "cosmohome", "hermes", "custom"). Optional, defaults to "unknown".
- `endpoint` — the chat bridge endpoint path. Optional, defaults to "/api/chat".

The scanner also probes `POST {url}{endpoint}` with an empty body to confirm the bridge is installed (expects 400, not 404).

## Backend Changes

### Scanner endpoint: `GET /api/setup/scan-agents`

In `server/server.js`, alongside existing `/api/setup/*` routes.

**Parameters:**
- `portMin` (query, default: 4600)
- `portMax` (query, default: 4660)
- `host` (query, default: "localhost")

**Logic:**
1. For each port in range, `GET http://{host}:{port}/health` with 1.5s timeout
2. If response is valid JSON with `status: "ok"` and `agent` field, record as discovered
3. For each discovered agent, probe `POST http://{host}:{port}{endpoint}` with `{ messages: [] }` and 1.5s timeout. If response status is 400 (not 404), mark bridge as available.
4. Return discovered agents alongside currently configured agents from config.

**Response:**
```json
{
  "success": true,
  "discovered": [
    {
      "agent": "coz",
      "type": "cosmohome",
      "url": "http://localhost:4611",
      "port": 4611,
      "endpoint": "/api/chat",
      "bridgeAvailable": true
    }
  ],
  "configured": [
    {
      "name": "Althea",
      "id": "althea",
      "url": "http://localhost:4620",
      "enabled": true,
      "verifiedAgent": "edison"
    }
  ]
}
```

The `configured` list includes `verifiedAgent` — the actual agent name from a live `/health` check. If the configured name doesn't match the verified name, the UI can flag the mismatch.

### Save endpoint: `POST /api/setup/local-agent/save`

**Request body:**
```json
{
  "name": "COZ",
  "id": "coz",
  "url": "http://localhost:4611",
  "endpoint": "/api/chat",
  "api_key": "9c88442a..."
}
```

**Logic:**
1. Hit `/health` on the URL to verify the agent is reachable and get its identity
2. Use the agent's self-reported name as the canonical name (override the user-provided name if it differs, or warn)
3. Save to `config.providers.local_agents[]` (encrypted api_key)
4. Hot-reload: `resetDefaultRegistry()` + `getDefaultRegistry()` to pick up the new agent without restart

**Response:**
```json
{
  "success": true,
  "agent": { "name": "COZ", "id": "coz", "url": "http://localhost:4611", "verified": true }
}
```

### Test endpoint: `POST /api/setup/local-agent/test`

**Request body:** `{ "url": "http://localhost:4611", "endpoint": "/api/chat", "api_key": "..." }`

**Logic:**
1. Hit `/health` — verify reachable, get identity
2. Hit `POST {url}{endpoint}` with auth header and `{ messages: [{ role: "user", content: "ping" }], tools: [] }` — verify bridge responds
3. Return result with agent identity and latency

### Remove endpoint: `POST /api/setup/local-agent/remove`

**Request body:** `{ "id": "coz" }`

**Logic:**
1. Remove from `config.providers.local_agents[]`
2. Save config
3. Hot-reload registry

## Frontend: Settings Panel Section

Add a "Local Agents" section to the existing Settings panel in `public/index.html`, following the pattern of existing provider sections (OpenAI, Anthropic, xAI, etc.).

### Section layout:

**Header:** "Local Agents" with a "Scan" button

**Scan results area** (hidden until scan is triggered):
- Shows discovered agents as cards
- Each card: agent name, type badge, port, status (connected/available/bridge missing)
- "Connect" button on available agents → prompts for API key (webhook token), then saves
- Already-connected agents show as "Connected" with no action needed

**Connected agents list:**
- Each agent: name, URL, status dot (green = reachable, red = unreachable), verified identity
- Identity mismatch warning if config name ≠ verified name (e.g., "Configured as 'Althea' but agent identifies as 'Edison'")
- "Disconnect" button → calls remove endpoint
- "Test" button → calls test endpoint, shows result

**Manual add:**
- URL input field with placeholder "http://localhost:4611"
- "Add Agent" button → hits `/health` to verify, prompts for token, saves

### Implementation location:

The existing Settings panel has provider sections rendered in `public/index.html` (inline) with save/test flows hitting `/api/setup/*` routes. The local agents section follows the same pattern — HTML section with JS handlers calling the new endpoints.

## CLI Wizard Step

In `lib/setup-wizard.js`, update the `local-agents` handler in `stepProviders()`:

### Flow:

```
📡 Local Agent Setup
Scanning for agents on localhost:4600-4660...

Found 3 agents:
  1. ✅ COZ (cosmohome) — localhost:4611
  2. ✅ Edison (cosmohome) — localhost:4612
  3. ✅ Tick (cosmohome) — localhost:4613

Select agents to connect (comma-separated, or 'all'): 1,2

Connecting COZ (localhost:4611)...
  Webhook token [paste or Enter to skip]: ****
  ✅ COZ connected and verified

Connecting Edison (localhost:4612)...
  Webhook token [paste or Enter to skip]: ****
  ✅ Edison connected and verified

Add an agent manually? (y/n) [n]: n

✅ Saved 2 local agents
```

### Logic:
1. Run the same port scan as the API endpoint
2. Display discovered agents with index numbers
3. Multi-select via comma-separated input or "all"
4. For each selected: prompt for webhook token (secret input with `*` echo)
5. Verify via `/health` and bridge probe
6. Save to config
7. Offer manual add for agents not in scan results

## Cosmohome Health Endpoint Enhancement

In `src/routes/evobrew-bridge.ts`, update `createHealthHandler` to include `type` and `endpoint`:

```typescript
export function createHealthHandler(config: { agentName: string }) {
  return (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      agent: config.agentName,
      type: 'cosmohome',
      endpoint: '/api/chat'
    });
  };
}
```

## What this does NOT include

- **Remote agent discovery** — scan is localhost only. Remote agents (Tailscale, etc.) use manual add.
- **Agent management beyond connect/disconnect** — no editing agent config, no model override per agent.
- **Auto-reconnect** — if an agent goes down, the status dot goes red but no auto-retry.
- **Token auto-detection** — user must paste the webhook token. No reading cosmohome's secrets.yaml.
- **OpenClaw migration** — OpenClaw stays as-is. Could be migrated to this pattern later.
