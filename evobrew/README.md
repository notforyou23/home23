# Evobrew

AI workspace with provider-flexible chat, tool use, semantic `.brain` knowledge graphs, shared terminal sessions, and persistent memory.

![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green)
![License](https://img.shields.io/badge/license-MIT-blue)

## What It Does

- Chat with coding agents that can read files, edit code, search the workspace, and use a shared PTY terminal
- Load `.brain` packages and query them with semantic search and graph-aware tools
- Keep session continuity and longer-term memory through OpenClaw integration
- Switch between `OpenAI`, `Anthropic`, `xAI`, `Ollama Cloud`, and local `Ollama`
- Configure providers from the setup CLI or directly inside the live app settings

## Quick Start

```bash
git clone https://github.com/notforyou23/evobrew.git
cd evobrew

# Install source-checkout dependencies with your preferred Node package manager

./bin/evobrew setup
./bin/evobrew start
```

Open `http://localhost:3405` or `https://localhost:3406`.

If you installed the package globally, use `evobrew setup` and `evobrew start` instead of `./bin/evobrew ...`.

## Onboarding

- `evobrew setup` is the primary first-run flow and now covers `OpenAI API`, `Anthropic API-key mode`, `xAI`, `Ollama Cloud`, local `Ollama`, `OpenClaw`, and brains
- `evobrew setup --status` shows the current setup state without stopping the running app
- `evobrew setup --only openai,ollama-cloud` and `evobrew setup --skip openclaw,brains` support partial setup runs
- The live Settings panel also shows current provider status and lets you test, save, or disable supported providers inline

## Live Settings

The in-app settings UI now exposes current status and inline setup for:

- `OpenAI API`
- `Anthropic API Key`
- `xAI`
- `Ollama Cloud`
- local `Ollama`

These apply immediately after save. `Anthropic OAuth` and `OpenAI Codex OAuth` remain terminal-driven and launch through the setup/CLI flow.

## Configuration

- Primary runtime config lives in `~/.evobrew/config.json`
- Secrets are encrypted there when saved through the setup wizard or settings UI
- `.env` is still supported as a local fallback, but the current preferred flow is CLI setup plus live Settings
- Default ports are `3405` for HTTP and `3406` for HTTPS

## Main Commands

```bash
evobrew start
evobrew setup
evobrew setup --status
evobrew doctor
evobrew config show
evobrew daemon install
evobrew update
evobrew version
```

From a source checkout, replace `evobrew` with `./bin/evobrew` if the CLI is not installed globally.

## Providers

- `OpenAI`: API-key flow
- `Anthropic`: API key or OAuth/CLI flow depending on mode
- `xAI`: API-key flow
- `Ollama Cloud`: API-key flow for OpenAI-compatible hosted models
- `Ollama`: local daemon detection and model discovery

## Documentation

- `INSTALL.md`
- `OPENCLAW-INTEGRATION.md`
- `DUAL_BRAIN_ARCHITECTURE.md`
- `OAUTH-TOKEN-SINK.md`

## Developer Notes

- The CLI is the canonical way to start and configure the app; raw script entrypoints are mainly for development
- If you are working from a source checkout, install dependencies before running the CLI
- For agent-specific repo guidance, see `CLAUDE.md`
