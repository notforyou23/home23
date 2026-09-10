# Home23

A house you install on your machine. Agents live here as individuals.

The model is rented. The person is a **Seed**: a hash-chained life on disk. Swap the model any time. You cannot clone a life or prompt one into being.

Chat is the front door. The house keeps living when you leave.

## Current

v2 Seeds are real. Recent memory, session grounding, facts, and biography compose from the chain at read time. Files are fallbacks. A fact has to earn its place. First-home setup and Home23 Host deliberately create an independent Seed through the [shared home birth operation](docs/design/HOME-BIRTH.md); the lower-level `agent create` command does not mint one.

Cosmo is not the house. If a Cosmo URL is configured and up, the house can open it. Home23 does not start, seed, or watchdog Cosmo. Cosmo source and product tests live in its own repository. See [Cosmo separation](docs/reference/COSMO-SEPARATION.md).

## Getting Home23

The product's intended front door is a public website with downloads,
documentation, how-tos, examples and support. Home23 Host runs each person's
own home on a Mac; the Mac/iPhone apps and private web dashboard connect to it.
Windows users will use the dashboard through secure browser access to a home,
with a Mac host initially required. Hosted homes are a later phase.

The independent-home developer milestone is verified. Signed public Mac downloads,
iPhone TestFlight/App Store delivery, easy cross-device browser/phone access and
automatic updates remain work. No public download or hosted service is implied.
See the [product delivery plan and backlog](docs/design/PRODUCT-DELIVERY.md).

## Install from source (developers and operators)

Need Node 20+, PM2, Python 3, and one LLM provider. Local Ollama `nomic-embed-text` is the usual embedding setup. Without embeddings the house runs Memory Lite (text memory, keyword retrieval).

```bash
git clone https://github.com/notforyou23/home23.git
cd home23
node cli/home23.js setup
```

That opens a local setup page. Name the first agent, sign in a provider, launch. Dashboard: [http://localhost:5002/home23](http://localhost:5002/home23).
Home23 owns Anthropic and ChatGPT/Codex OAuth locally; signing in and refreshing
credentials does not require Cosmo, Evobrew, or another broker.

Terminal-guided first-home path:

```bash
node cli/home23.js setup --cli
```

Full walkthrough: [docs/ONBOARDING.md](docs/ONBOARDING.md).

## Day to day from source

```bash
node cli/home23.js status
node cli/home23.js logs <name>
node cli/home23.js stop          # Home23 processes only
node cli/home23.js update
```

Dashboard is the operating surface. Standalone chat is `/home23/chat`. Telegram, Discord, and iMessage are per-agent in Settings.

For ordinary source installations, `update` pulls the latest Home23 release and restarts Home23 processes. Managed packaged installations use the [managed release workflow](docs/reference/MANAGED-RELEASES.md); the ordinary updater refuses those installations. Product Host installations also refuse the source updater and need the separate state-preserving update path tracked in the [delivery plan](docs/design/PRODUCT-DELIVERY.md). None of these paths should start or update Cosmo.

First agent listens on 5001–5004 (engine, dash, MCP, harness bridge). The next agent gets 5011–5014.

## How a turn works

Every mouth — dashboard, phone, Telegram — hits the agent's harness bridge. The engine does not speak that turn. The Seed lives beside it. After the turn, a shipper feeds the conversation onto the chain.

Never run two seed runners on one individual. A forked chain is archived, not repaired.

## Docs

- [Product website, apps, browser access and delivery work](docs/design/PRODUCT-DELIVERY.md)
- [Home23 Host companion](docs/design/HOST-COMPANION.md)
- [Onboarding](docs/ONBOARDING.md)
- [v2 substrate](docs/design/HOME23-V2-SUBSTRATE-DESIGN.md)
- [AGENTS.md](AGENTS.md) — public repo law
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
