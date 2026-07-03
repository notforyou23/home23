# Home23 1.0 Onboarding

Use this when installing Home23 on a fresh machine or handing the repo to the next operator.

## 1. Prerequisites

- macOS or Linux host with Node.js 20+
- PM2 installed globally: `npm install -g pm2`
- Python 3 for document ingestion conversion
- Optional but recommended: Ollama with local embeddings

```bash
node --version
pm2 --version
python3 --version
ollama --version
ollama pull nomic-embed-text
```

Home23 can start without Ollama if you configure cloud embeddings later, but local embeddings are the lowest-friction default.

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
- live launch

Starter folders are added to the agent's Document Feeder watch paths so supported files flow into the agent's brain as they change.

Conversation memory is part of the default setup. Each agent writes session transcripts into `instances/<name>/workspace/sessions/`, the feeder watches that folder, the chat loop searches brain memory by default, and the seeded `conversation-backfill-daily` scheduler job converts any accumulated JSONL chat history into feeder-ready markdown once a day. Compaction and memory extraction use the agent's configured default provider/model rather than a separate hard-coded model.

Manual operator flow:

```bash
node cli/home23.js init
node cli/home23.js agent create <name>
```

For the older terminal-guided first-run path, use:

```bash
node cli/home23.js setup --cli
```

`init` installs root, engine, Evobrew, COSMO23, and COSMO23 engine dependencies; generates Home23/COSMO config plumbing; creates the COSMO OAuth database; builds TypeScript; and prepares the MarkItDown Python environment.

Provider credentials are configured in the dashboard, not during `init`.

`agent create` writes the first local `instances/<name>/` runtime directory, records its purpose, configures starter ingestion folders, and regenerates the PM2 ecosystem. `instances/` is intentionally local state and is not committed.

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
- TypeScript build failure: run `npx tsc --noEmit` for exact errors
- COSMO OAuth DB missing: `cd cosmo23 && DATABASE_URL="file:./prisma/dev.db" npx prisma db push`
- PDF/DOCX ingestion unavailable: recreate `engine/.venv-markitdown` and install `markitdown[pdf] openai`
- Local embeddings unavailable: start Ollama and run `ollama pull nomic-embed-text`

## 7. Release Evidence

The 1.0 release receipt is in `docs/handoff/session_2026-07-02_1.0-release.md`. It records the validation commands and the live-state caveats from the release checkout.
