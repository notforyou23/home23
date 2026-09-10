# Home23 source/operator onboarding

Use this when installing Home23 from source on a fresh machine or handing the repo to the next operator. These developer/operator commands are not the intended consumer download experience.

The instructions below cover installation from source. The separate native Mac
[Home23 Host companion](design/HOST-COMPANION.md) uses a bundled runtime and the
same home creation operation, without requiring terminal setup. Its developer
artifact and verification are distinct from a signed public distribution.

For the agreed public website, Host/Mac downloads, iPhone TestFlight-to-App-Store
path, private web dashboard and Windows browser access, see
[Product delivery](design/PRODUCT-DELIVERY.md). That document tracks what still
needs implementation and release acceptance. Ordinary users should arrive
through the website and apps; the instructions below remain the source fallback.
The private dashboard is served by their home, separately from the public site.
Host-managed homes allocate their own ports, so fixed source-install addresses
below must not be used as consumer connection instructions.

## 1. Prerequisites

- macOS or Linux host with Node.js 20+
- PM2 installed globally: `npm install -g pm2`
- Python 3 for document ingestion conversion
- Optional but recommended: Ollama with local embeddings

Source installation compiles native Node modules. Install the platform toolchain
before running setup:

- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Debian/Ubuntu Linux: `sudo apt install build-essential python3-venv`
- Other Linux distributions: a C/C++ compiler, `make`, and Python's `venv` module

```bash
node --version
pm2 --version
python3 --version
ollama --version
ollama pull nomic-embed-text
```

Home23 can start without Ollama. If no embedding provider is available, it runs in Memory Lite mode: text memory is stored and keyword retrieval works, while semantic memory waits for local Ollama, OpenAI API, or Ollama Cloud embeddings. A Claude Max or ChatGPT/Codex OAuth login covers chat, but not Home23's embeddings lane. Local Ollama is the lowest-friction companion for users who only have one paid chat subscription.

## 2. Install

```bash
git clone https://github.com/notforyou23/home23.git
cd home23
node cli/home23.js setup
```

`setup` is the easiest first-run path. It installs Home23, starts a temporary local setup server, and opens the browser to the web-guided first-run page. Keep that terminal open until the page has launched the agent.

The setup page walks through:

- provider setup through Anthropic OAuth, OpenAI Codex OAuth, or API keys for OpenAI, Ollama Cloud, MiniMax, xAI, and fallback Anthropic access
- first personal agent name and owner name
- up-front user facts the agent should know
- agent purpose
- starter project/import folders, including Claude/Codex exports, notes, reports, or fresh project directories
- default provider/model choice
- setup readiness status for Chat Provider, Memory Lite, Semantic Brain, and Backfill Needed
- live launch

Before large file ingestion, verify the embedding lane if the user wants semantic retrieval immediately. Without it, ingestion still stores text memory and can be backfilled later.

Starter folders are added to the agent's Document Feeder watch paths so supported files flow into the agent's brain as they change.

First-home setup prepares the current app's canonical home and direct conversation, private resident credentials, and a separate Seed genesis/checkpoint. It records a resumable receipt at `instances/.house/creation.json`. If interrupted, return to setup and select **Resume setup**, or rerun `setup --cli`. Starting is blocked until preparation completes. See [the home birth contract](design/HOME-BIRTH.md).

Scripted preparation after `init` uses the same operation:

```bash
node cli/home23.js home create /path/to/profile.json
```

The JSON profile requires `name`, `ownerName`, `provider`, and `model`; optional fields include `displayName`, `purpose`, `personalFacts`, `timezone`, and `ingestPaths`. Keep this profile private. The command prepares state and prints a receipt; its `next.command` starts the home. App pairing uses Core on port 7346 locally. Remote devices require trusted transport setup.


Conversation memory is part of the default setup. Each agent writes session transcripts into `instances/<name>/workspace/sessions/`, the feeder watches that folder, the chat loop searches brain memory by default, and the seeded `conversation-backfill-daily` scheduler job converts any accumulated JSONL chat history into feeder-ready markdown once a day. Compaction and memory extraction use the agent's configured default provider/model rather than a separate hard-coded model.

Manual operator flow:

```bash
node cli/home23.js init
node cli/home23.js setup --cli
```

For terminal-guided first-run setup, use:

```bash
node cli/home23.js setup --cli
```

`init` installs root, engine and Evobrew dependencies, seeds local configuration,
builds TypeScript and contract assets, and prepares the optional MarkItDown Python
environment. COSMO23 is an independently installed service; Home23 does not
install, start, or update its source or database.

Provider credentials are configured in the dashboard, not during `init`.

`agent create` is the lower-level path for adding an agent to an existing installation. It writes a local `instances/<name>/` runtime directory, records its purpose, configures starter ingestion folders, and regenerates the PM2 ecosystem. `instances/` is intentionally local state and is not committed.

## 3. Web Setup and Start

The browser should open automatically to `/home23/setup` on a temporary local setup server, usually:

```text
http://localhost:50523/home23/setup
```

If that port is busy, the setup command prints the next available setup URL.

After the setup page launches the agent, open:

- Dashboard: `http://localhost:5002/home23`
- Settings: `http://localhost:5002/home23/settings`
- Chat: `http://localhost:5002/home23/chat`
- Evobrew: `http://localhost:3415`
- COSMO23: `http://localhost:43210`

Use Settings later to adjust providers, the agent's model and purpose, owner context, and ingestion folders through the Feeder tab.

## 4. Validate

Before declaring a fresh install ready:

```bash
npm run build
npm test
npm run test:contracts
npm run test:contracts:live
node cli/home23.js status
```

Expected:

- `npm run build` exits 0
- `npm test` exits 0
- `npm run test:contracts` exits 0
- `npm run test:contracts:live` checks read-only live routes and skips action probes unless explicitly enabled
- `node cli/home23.js status` shows only Home23 processes and their PM2 state

### Concurrent starts and shared services

`home23 start` serializes startup of the shared Evobrew and ScreenLogic services, plus Core when enabled. Multiple concurrent start commands re-check PM2 state inside one cross-process lock, so each missing shared service is started once. Explicit shared-service restarts use the same lock. Local evidence is appended to `logs/shared-service-startup.jsonl`.

If PM2 reports duplicate records or a service port is owned by an untracked process, stop and inspect the exact service. Use only exact-name PM2 commands; never use global stop/delete commands.

For action-writing live contract probes, run only when you are ready for bounded local state changes:

```bash
HOME23_LIVE_CONTRACTS_ACTIONS=1 npm run test:contracts:live
```

## 5. Do Not Lose Data

- Do not run `pm2 stop all`, `pm2 delete all`, `git reset --hard`, or broad checkout/reset commands.
- Stop Home23 through `node cli/home23.js stop` or by specific process name.
- The `instances/` tree is runtime data. Brains, conversations, uploads, and local schedules live there.
- `config/secrets.yaml`, COSMO OAuth storage, and generated runtime config are local secrets/state and should not be committed.
- `config/home.yaml`, `config/targets.yaml`, `config/cron-jobs.json`, `config/agents.json`, and `ecosystem.config.cjs` are local generated files. Public defaults live in `config/*.example`.
- If you are working in jtr's live checkout, inspect local changes before editing and preserve uncommitted work.

## 6. Common First-Run Fixes

- PM2 missing: `npm install -g pm2`
- Native dependency build failure on Debian/Ubuntu: `sudo apt install build-essential python3-venv`, then rerun setup
- TypeScript build failure: run `npx tsc --noEmit` for exact errors
- Cosmo OAuth unavailable: check the independently installed Cosmo service at `cosmo23.baseUrl`; its database and provider setup belong to that installation.
- PDF/DOCX ingestion unavailable: recreate `engine/.venv-markitdown` and install `markitdown[pdf] openai`
- Local embeddings unavailable: start Ollama and run `ollama pull nomic-embed-text`

## 7. Release Evidence

The 1.0 release receipt is in `docs/handoff/session_2026-07-02_1.0-release.md`. It records the validation commands and the live-state caveats from the release checkout.
