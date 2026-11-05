# Home23 Public Release — Design Spec

**Date:** 2026-04-09
**Status:** Draft
**License:** MIT

## What This Is

Package Home23 as a public monorepo that anyone can clone and run. One repo, everything included — engine, harness, evobrew, cosmo23, feeder, CLI, dashboard. No optional pieces, no separate installs.

## Target User

Technical AI enthusiasts. Comfortable with Node.js, terminal, API keys. They want to run their own living AI system — cognitive loops, growing brain, research engine, AI IDE — not a SaaS product.

## Positioning

Home23 is an AI operating system. Four integrated systems:

1. **Agent** — always-on personal AI with a living brain that grows through conversation, ingestion, and autonomous thought
2. **COSMO 2.3** — autonomous research engine, spawns agent swarms, builds knowledge brains
3. **Evobrew** — AI IDE for querying brains, writing code, talking to agents
4. **Dashboard** — OS home screen with chat, settings, intelligence, and access to all systems

"AI that thinks for you" — not just tools and chat, but a system that dreams, synthesizes, and builds understanding over time.

## Approach: Template Manifest

A manifest defines every file and directory that belongs in the public repo. Each component is audited against the manifest before copying. Nothing ships that isn't explicitly listed. Nothing personal can slip through because it was never copied.

The manifest becomes the source of truth for "what is Home23."

## Constraints

- **Do NOT modify the running Home23 at `/path/to/Home23/`.** The public repo is a separate clean copy.
- **Everything ships together.** No optional components, no separate install steps for evobrew or cosmo23.
- **Must work from day one.** Clone, init, run. No paid API keys required for basic operation.

## Public Repo Structure

```
home23/
  engine/              # JS cognitive engine (loops, dreaming, brain, dashboard)
  feeder/              # Ingestion pipeline (file watcher, chunker, embedder, compiler)
  src/                 # TS agent harness (agent loop, tools, channels, scheduler)
  cli/                 # CLI management (init, agent create, start/stop/status/logs)
  config/              # Home-level config templates
    home.yaml          # Clean defaults, no personal references
    secrets.yaml.example  # Placeholder API keys
  configs/             # Engine config templates
    base-engine.yaml   # Cognitive loop config (shared by all agents)
  evobrew/             # AI IDE (cleaned source)
  cosmo23/             # Research engine (cleaned source)
  docs/                # Design docs, vision docs
  scripts/             # Dev/start scripts
  package.json         # Root dependencies
  tsconfig.json        # TS config
  ecosystem.config.cjs # PM2 config (auto-generated template)
  .gitignore           # Comprehensive
  .env.example         # Example env vars
  README.md            # Real install + usage instructions
  LICENSE              # MIT
```

## What Does NOT Ship

- `instances/` — runtime/personal data, created by `home23 init`
- `node_modules/` — any level
- `config/secrets.yaml` — API keys (only `.example` ships)
- Brain data, conversations, logs, run outputs, PID files
- `dist/` — compiled output (users run `npm run build`)
- `saved/` — personal backups
- `runtime/` — runtime state
- Loose dev files — screenshots, temp scripts, logs
- Old unrelated tracked files — `exports/`, `server/`, `lib/`, `pgs-engine/`, `prisma/`, `public/`, `ide/`, `launcher/`
- evobrew artifacts — config.json, workspaces, conversations, snapshots, prisma db
- cosmo23 artifacts — runs/, runtime/, .cosmo23-config/, prisma db, export outputs

## Day-One Experience

### Prerequisites
- Node.js 20+
- PM2 (`npm install -g pm2`)
- Ollama (local install or Ollama Cloud free account) — for embeddings

### Install Flow
```bash
git clone <repo-url> home23
cd home23
node cli/home23.js init    # Walks through provider setup
node cli/home23.js start   # Full system running
```

### Provider Setup (during init)

No gates — configure what you have:

1. **Embeddings (required, at least one):**
   - Ollama local — free, recommended if you have it running
   - Ollama Cloud — free account, no local GPU needed
   - OpenAI embeddings — if already paying
   - **Critical guidance:** Pick one embedding model and stick with it. Your brain's vector space is built on your embedding choice. Changing it later means re-embedding your entire brain. Ollama `nomic-embed-text` is recommended — free and works well for a continuously running system.

2. **LLM providers (at least one):**
   - Ollama Cloud — cheapest/free path for basic LLM
   - Anthropic, OpenAI, xAI — for frontier models
   - Local Ollama — if you have the hardware
   - Configure what you have, swap anytime (unlike embeddings)

3. **Agent creation:**
   - Name, identity basics
   - Optional Telegram bot token (dashboard chat works without it)

### Minimum Viable Setup
- Free Ollama Cloud account → embeddings + basic LLM
- Full system running at zero cost

### Power Users
- Multiple providers, frontier models, local Ollama for embeddings + cloud for LLM
- All configurable through Settings UI or config files directly

## Embedding Architecture (verified)

The engine already defaults to Ollama for embeddings. No OpenAI key required.

- `getEmbeddingClient()` in `engine/src/core/openai-client.js` defaults to `http://127.0.0.1:11434/v1` with dummy key `'ollama'`
- Uses OpenAI SDK pointed at Ollama's compatible endpoint
- Model: `nomic-embed-text` at 768 dimensions (configured in `configs/base-engine.yaml`)
- Embedding client is completely separate from chat/LLM client
- Feeder also uses Ollama for embeddings by default
- Configurable via env vars (`EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`) and YAML

No new engineering work needed for embedding provider support.

## Component Audits

Before copying anything, each component is audited for:
1. **Personal data** — hardcoded paths, names, API keys, bot tokens
2. **Artifacts** — runtime-generated files that inflate size
3. **Functionality** — does it work standalone from the public repo?

### Audit Order by Risk

| Component | Risk | Notes |
|---|---|---|
| cosmo23/ | High | 2.1GB on disk, unknown artifact/source ratio, never been public, likely hardcoded paths |
| evobrew/ | High | Has a public repo but bundled copy may have diverged, needs diff |
| engine/ | Medium | Battle-tested, dashboard files need review |
| src/ | Low | Clean TS, written for Home23, never committed — review for hardcoded values |
| cli/ | Low | Small, templates need default value review |
| feeder/ | Low | Small, likely clean |
| config/ | Low | home.yaml needs clean defaults, secrets → .example |
| docs/ | Low | Design docs fine, check superpowers/ plans for personal details |

### cosmo23/ Audit Scope
- Inventory all directories — separate source from run artifacts
- `runs/`, `runtime/`, `.cosmo23-config/`, `prisma/dev.db`, `exports/*/outputs/` are artifacts — do not ship
- Check source files for hardcoded paths (`/home/user/`, personal references)
- Measure clean source size (should be dramatically smaller than 2.1GB)
- Verify its own setup/onboarding handles provider config independently

### evobrew/ Audit Scope
- Diff bundled copy against public repo at `github.com/notforyou23/evobrew`
- Identify Home23-specific changes (bridge endpoint integration, agent routing)
- `node_modules/`, `config.json`, `.evobrew-workspaces/`, `conversations/`, `snapshots/`, `prisma/dev.db` are artifacts — do not ship
- Check for personal data in source
- Measure clean source size

## Work Items

### Audits (must do first)
1. cosmo23/ full audit — inventory, personal data, hardcoded paths, clean source size
2. evobrew/ full audit — diff against public repo, find divergence, same cleanup

### Engineering (in the new repo only)
3. Onboarding config for embedding provider — detect local Ollama vs guide to Ollama Cloud URL
4. Clean config defaults — home.yaml with no personal references, secrets.yaml.example, sensible model aliases
5. Comprehensive .gitignore — covers all runtime artifacts across all four systems

### Documentation
6. README.md — what Home23 is, prerequisites, install, first run, architecture overview
7. Embedding guidance — pick one, stick with it, why, recommendations (in README or dedicated doc)
8. LICENSE — MIT

### Assembly
9. Build the manifest — explicit file/directory inclusion list per component
10. Copy into new repo directory, fresh git init
11. Test from zero — fresh clone simulation, full onboarding, verify everything works

### Not Needed
- ~~Embedding provider abstraction~~ — already works with Ollama out of the box
- ~~Agent templates~~ — onboarding flow handles fresh starts
- ~~npx scaffolder~~ — later release; clone + init is fine for v1

## Git Strategy

- New repo, fresh `git init`, one clean initial commit
- No history from the dev repo
- Standalone evobrew and cosmo23 repos continue to exist as upstream sources
- `home23 evobrew update` and `home23 cosmo23 update` CLI commands sync from upstream when needed

## Development Workflow (Post-Release)

The public repo becomes the maintainer's primary development environment. The old dev repo is retired.

**How it works:**
- `$TARGET` is THE Home23 repo — the maintainer's running agent AND the public repo in one directory
- Personal data (instances/<agent>/, config/secrets.yaml, brain data, conversations) lives in gitignored directories — never pushed to GitHub
- Development: make changes → commit → push. That's it. No syncing between repos.
- Community: fork → PR → the maintainer reviews and merges
- evobrew/cosmo23 standalone repos are upstream sources, not daily workspaces. Pull changes in with update commands when they happen.

**Migration:** After the clean repo is built and verified, the existing agent's instance data (brain, config, conversations, identity) is copied in, PM2 processes are restarted from the new location, and the old repo is archived.

## Current Repo State (for reference)

The existing dev repo at `/path/to/Home23/` has issues:
- 2,286 tracked files, mostly old evobrew-era code (`exports/` 1561 files, `server/`, `lib/`, etc.)
- The entire Home23 harness layer (`cli/`, `src/`, `config/`, `configs/`) is untracked
- evobrew/ and cosmo23/ are untracked
- This repo is retired after migration to the public repo.
