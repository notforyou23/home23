# Evobrew Installation Guide

This guide reflects the current CLI-first setup flow and the in-app Settings experience.

## Requirements

- `Node.js` `18+`
- `Git`
- At least one configured provider: `OpenAI`, `Anthropic`, `xAI`, `Ollama Cloud`, or local `Ollama`

If you are running from a source checkout, install the project dependencies first using your preferred Node package manager.

## Install From Source

```bash
git clone https://github.com/notforyou23/evobrew.git
cd evobrew

# Install dependencies for the source checkout

./bin/evobrew setup
./bin/evobrew start
```

If the CLI is installed globally, use `evobrew ...` instead of `./bin/evobrew ...`.

Open:

- `http://localhost:3405`
- `https://localhost:3406`

## First-Run Setup

`evobrew setup` is the main onboarding flow.

It can configure:

- `OpenAI API`
- `Anthropic API Key`
- `Anthropic OAuth` fallback flow
- `xAI`
- `Ollama Cloud`
- local `Ollama`
- `OpenClaw`
- brain configuration

Useful setup commands:

```bash
evobrew setup
evobrew setup --status
evobrew setup --only openai,ollama-cloud
evobrew setup --skip openclaw,brains
```

Notes:

- `evobrew setup --status` is safe to run while the app is already live
- a full `evobrew setup` flow may stop and restart the app depending on what changes
- if no provider is configured yet, startup will direct you back into setup

## In-App Settings

Once the app is running, open Settings to review the current status and manage providers inline.

The live Settings UI currently supports test/save/disable for:

- `OpenAI API`
- `Anthropic API Key`
- `xAI`
- `Ollama Cloud`
- local `Ollama`

These changes are applied immediately and persisted to `~/.evobrew/config.json`.

Two flows still stay terminal-driven:

- `Anthropic OAuth`
- `OpenAI Codex OAuth`

## Provider Notes

### OpenAI

- Standard API-key flow
- Good default for hosted models and embeddings

### Anthropic

- Supports API-key mode in live Settings
- OAuth remains a CLI-assisted flow

### xAI

- API-key setup is available in Settings and the CLI

### Ollama Cloud

- Uses an OpenAI-compatible hosted API flow
- API key can be tested and saved directly in live Settings or through setup

### Local Ollama

- Detects the local daemon and available models
- Best for local/offline workflows when Ollama is installed and running

## Configuration

- Main config: `~/.evobrew/config.json`
- Default HTTP port: `3405`
- Default HTTPS port: `3406`
- `.env` still works as a local fallback, but the preferred path is setup plus Settings

## Common Commands

```bash
evobrew start
evobrew doctor
evobrew config show
evobrew config edit
evobrew daemon install
evobrew daemon start
evobrew daemon stop
evobrew update
evobrew version
```

From a source checkout, use `./bin/evobrew` if needed.

## Troubleshooting

### The app says setup is required

Run:

```bash
evobrew setup
```

You need at least one enabled provider before normal startup.

### The server is already running

Check setup state without interrupting it:

```bash
evobrew setup --status
```

### Provider works in setup but not in chat

- Re-open Settings and confirm the provider shows as configured
- Confirm the selected model belongs to the provider you configured
- If using `.brain` tools, make sure a brain is actually loaded into the session

### Local Ollama is not detected

- Make sure the Ollama daemon is running
- Re-test from Settings or run setup again
- Raspberry Pi deployments may intentionally disable local Ollama and rely on cloud providers instead

## For Contributors

- The CLI is the canonical operator flow for startup and setup
- Raw script entrypoints still exist for development, but the public docs should prefer `evobrew`
- `README.md` is the short overview; this file is the practical install/setup guide
