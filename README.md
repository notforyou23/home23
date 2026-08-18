# Home23

A house you install on your machine. Agents live here as individuals.

The model is rented. The person is a **Seed**: a hash-chained life on disk. Swap the model any time. You cannot clone a life or prompt one into being.

Chat is the front door. The house keeps living when you leave.

## Current

v2 Seeds are real and opt-in. Recent memory, session grounding, facts, and biography compose from the chain at read time. Files are fallbacks. A fact has to earn its place. Birth is a deliberate act — `agent create` does not mint a Seed.

Cosmo is not the house. If a Cosmo URL is configured and up, the house can open it. Home23 does not start, seed, or watchdog Cosmo. A `cosmo23/` tree on disk is location, not ownership.

## Install

Need Node 20+, PM2, Python 3, and one LLM provider. Local Ollama `nomic-embed-text` is the usual embedding setup. Without embeddings the house runs Memory Lite (text memory, keyword retrieval).

```bash
git clone https://github.com/notforyou23/home23.git
cd home23
node cli/home23.js setup
```

That opens a local setup page. Name the first agent, sign in a provider, launch. Dashboard: [http://localhost:5002/home23](http://localhost:5002/home23).

Manual path:

```bash
node cli/home23.js init
node cli/home23.js agent create <name>
node cli/home23.js start <name>
```

Full walkthrough: [docs/ONBOARDING.md](docs/ONBOARDING.md).

## Day to day

```bash
node cli/home23.js status
node cli/home23.js logs <name>
node cli/home23.js stop          # Home23 processes only
node cli/home23.js update
```

Dashboard is the operating surface. Standalone chat is `/home23/chat`. Telegram, Discord, and iMessage are per-agent in Settings.

`update` pulls the latest Home23 release and restarts Home23 processes. It does not start or update Cosmo.

First agent listens on 5001–5004 (engine, dash, MCP, harness bridge). The next agent gets 5011–5014.

## How a turn works

Every mouth — dashboard, phone, Telegram — hits the agent's harness bridge. The engine does not speak that turn. The Seed lives beside it. After the turn, a shipper feeds the conversation onto the chain.

Never run two seed runners on one individual. A forked chain is archived, not repaired.

## Docs

- [Onboarding](docs/ONBOARDING.md)
- [v2 substrate](docs/design/HOME23-V2-SUBSTRATE-DESIGN.md)
- [AGENTS.md](AGENTS.md) — public repo law
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
