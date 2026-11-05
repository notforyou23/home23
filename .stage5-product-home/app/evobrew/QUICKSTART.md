# Evobrew Quick Start

## One-Time Setup (5 minutes)

Install the source-checkout dependencies with your preferred Node package manager before continuing.

```bash
# 1. Clone
git clone https://github.com/notforyou23/evobrew.git
cd evobrew

# 2. Run setup
./bin/evobrew setup

# 3. Start
./bin/evobrew start
```

## What to Add in `.env`

**Required:**
- `ENCRYPTION_KEY` - Run: `openssl rand -hex 32`
- At least one API key (OpenAI, Anthropic, or xAI)

**Optional:**
- OpenClaw Gateway settings (for persistent memory)
- Custom ports

## First Launch

Open http://localhost:3405 (or your custom port)

## Commands

```bash
./bin/evobrew start         # Start server
./bin/evobrew setup         # Run onboarding/setup
./bin/evobrew setup --status
./bin/evobrew config show   # Show current config
```

## Anthropic Setup

**Option A: API Key (simpler)**
```bash
# In .env:
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_OAUTH_ONLY=false
```

**Option B: OAuth (better rate limits)**
```bash
./bin/evobrew setup
# Choose the Anthropic OAuth path in setup
```

See [docs/ANTHROPIC_OAUTH_SETUP.md](./docs/ANTHROPIC_OAUTH_SETUP.md) for details.

## Troubleshooting

**Port already in use:**
- Change `HTTP_PORT` in `.env` to a different port (e.g., 3410)

**Database errors:**
- Make sure dependencies are installed for this checkout, then rerun `./bin/evobrew setup`

**API key errors:**
- Check `.env` has valid keys
- For Anthropic: Either use OAuth OR set `ANTHROPIC_OAUTH_ONLY=false`

## Full Documentation

- [Installation Guide](./INSTALL.md)
- [OpenClaw Integration](./OPENCLAW-INTEGRATION.md)
- [Configuration](./README.md#configuration)
