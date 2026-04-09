# COSMO 2.3

COSMO 2.3 is the standalone carve-out of COSMO Unified.

It keeps the COSMO engine, local Launch + Watch + Query, filesystem brains, EVOBREW-style local provider setup, Anthropic OAuth, and the upgraded Research/PGS query surface.

Unified and Big COSMO stay untouched and can be scanned as read-only references while you build against this standalone.

## What is in scope

- Launch new research runs locally
- Watch the active run through the local dashboard
- Query local or reference brains through the standalone Research tab
- Manage OpenAI, Anthropic, xAI, Ollama, and LM Studio from a local-only setup flow
- Add and remove chat models through the local model catalog

## What is out of scope

- Multi-tenant auth
- billing, payments, tiers
- hosted SaaS plumbing
- BrainHub and IDE as product surfaces

## Quick start

```bash
npm install
npm run db:generate
npm start
```

Open [http://localhost:43110](http://localhost:43110).

## Default ports

- App: `43110`
- WebSocket: `43140`
- Watch dashboard: `43144`
- MCP HTTP: `43147`

Overrides use the `COSMO23_*` namespaced env vars:

- `COSMO23_PORT`
- `COSMO23_WS_PORT`
- `COSMO23_DASHBOARD_PORT`
- `COSMO23_MCP_HTTP_PORT`

## Local storage

- Global config: `~/.cosmo2.3/config.json`
- Local model catalog: `~/.cosmo2.3/model-catalog.json`
- OAuth/token DB: `~/.cosmo2.3/database.db`
- Local runs: `runs/`
- Active runtime link: `runtime/`

## Reference brains

By default COSMO 2.3 scans these sibling run directories when present:

- `../runs` (sibling directories if present)

Override with `COSMO_REFERENCE_RUNS_PATHS`.

Reference brains are read-only. Continuing one imports it into local `runs/` first, then launches the local copy.

## Provider setup

The left side of the Launch screen is the local setup panel.

- OpenAI: API key entry
- Anthropic: API key or OAuth
- xAI: API key
- Ollama: local or remote base URL
- LM Studio: OpenAI-compatible base URL

The setup panel writes into `~/.cosmo2.3/config.json`. You do not need to keep secrets in project `.env` once local setup is saved.

## Model management

The Model Catalog section manages chat model choices for:

- OpenAI
- Anthropic
- xAI
- local defaults for thinking and fast/coding roles

Launch uses three model roles:

- `Primary`: default agent work
- `Fast`: coordinator, planner, quick turns
- `Strategic`: synthesis, integration, QA, higher-value reasoning

Query uses its own default query model and PGS sweep model from the same catalog.

## Embeddings

Core COSMO embeddings are intentionally not a user picker in v1.

- Brain memory embeddings stay on the internal OpenAI embedding path
- Current default is `text-embedding-3-small` at `512` dimensions
- The launcher config, engine runtime memory config, semantic query embedding, and coordinator indexing now all read the same internal default

This preserves compatibility with existing brains and the current standalone query stack.

Important:

- If you want full brain-memory embeddings and semantic query, keep OpenAI configured
- Chat can still run on Anthropic, xAI, or local models while embeddings remain on OpenAI
- The local Ollama embedding model is still tracked internally for provider capability purposes, but it is not the core COSMO brain embedding path in v1

## Launch / Watch / Query flow

1. Configure providers in the setup panel.
2. Adjust the model catalog if you want different chat model versions.
3. Launch a run with topic, context, mode, and model-role selections.
4. Use Watch to follow the active run and open the dashboard.
5. Use Query to work against finished local brains or imported reference brains.

The Query tab includes the EVOBREW-style Research surface with:

- normal query and streaming query
- PGS controls
- output and evidence toggles
- suggestions
- history
- export actions

## API surface

Key local routes:

- `POST /api/launch`
- `POST /api/stop`
- `GET /api/status`
- `GET /api/brains`
- `POST /api/continue/:brainId`
- `POST /api/brain/:name/query`
- `POST /api/brain/:name/query/stream`
- `GET /api/brain/:name/suggestions`
- `POST /api/brain/:name/export-query`
- `GET /api/providers/models`
- `GET /api/providers/status`
- `GET /api/providers/capabilities`
- `GET /api/oauth/anthropic/status`
- `GET /api/oauth/anthropic/start`
- `GET /api/oauth/anthropic/callback`
- `POST /api/oauth/anthropic/logout`

## Verification notes

The standalone has been smoke-tested with:

- OpenAI query
- Anthropic query
- Anthropic launch
- local-only launch on alternate COSMO23 ports
- Research tab rendering and streaming
- model catalog driven launch config generation

## More docs

- Detailed usage: [docs/USAGE.md](engine/docs/COSMO_PRODUCT_SPEC.md)
- Environment example: [.env.example](.env.example)
