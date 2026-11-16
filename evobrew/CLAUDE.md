# Evobrew

Model-agnostic AI workspace: Node.js and Express server, vanilla JavaScript frontend, multi-provider chat with function calling, `.brain` knowledge packages, terminal sessions. Some older text calls it "COSMO IDE" or "Brain Studio"; it is one product. Do not add more names.

Default ports: HTTP 3405, HTTPS 3406. Local settings: `~/.evobrew/config.json`.

The full code reference that used to be in this file is in `docs/CODE-REFERENCE.md`. Read the section you need; do not load all of it.

## Commands

```bash
./bin/evobrew start        # preferred entry point; checks the port first
node server/server.js      # direct start for debugging; no port check
node --check <file>        # run on every file you change
node scripts/security-smoke.js
./node_modules/.bin/prisma migrate dev
./node_modules/.bin/prisma generate
```

Other CLI commands: `setup`, `daemon install|start|stop`, `doctor`, `config show|edit|reset`, `version`. There is no linter and no test suite. For a source checkout, update with `git pull` and a restart.

## Rules

- Never commit `.env`. It holds the encryption key and API keys.
- Never hardcode an absolute path such as `/Users/<name>/`. The app must be portable.
- Do not restructure `server/server.js`. Make surgical edits.
- Do not change `openai-codex` routing. It bypasses the provider registry on purpose, because ChatGPT OAuth tokens lack Platform API scopes.
- Do not edit `~/.evobrew/config.json` directly. Use the wizard or `config-manager.js`.
- Keep the `getAvailableModels()` and `listModels()` contract. The model dropdown depends on both.
- When you add a provider, add its setup-wizard step in `lib/setup-wizard.js`.
- When you add an environment variable, update `.env.example`.
- Do not stop the `evobrew` PM2 process without asking.

## Where to look

| Area | Start in |
|---|---|
| Boot and daemon modes | `bin/evobrew`, `server/server.js`, `lib/daemon-manager.js` |
| Configuration and setup wizard | `lib/config-manager.js`, `lib/setup-wizard.js` |
| Providers and model routing | `server/providers/index.js`, `server/providers/registry.js`, `server/providers/adapters/` |
| Agentic loop and tools | `server/ai-handler.js`, `server/tools.js` |
| Brains, semantic search, PGS | `lib/query-engine.js`, `lib/pgs-engine.js` |
| Security profiles | `lib/security-profile.js` |
| Local agents | `server/providers/adapters/local-agent.js` |

## Pitfalls that cost time

- A provider is missing from the dropdown: confirm `initializeProvider()` runs in `server/providers/index.js` and `getAvailableModels()` returns a non-empty list. The registry decides once at first call; call `resetDefaultRegistry()` to re-evaluate.
- A model routes to the wrong provider: check `parseProviderId()` in `server/providers/registry.js`. A model id with a colon defaults to Ollama; a `local:` prefix must match before that rule.
- An OpenAI-compatible model answers like a generic chatbot: check that inline `system` messages survive in `server/providers/adapters/openai.js`.
- Codex tools break: `buildOpenAIResponsesToolsFromChatTools()` in `ai-handler.js` normalizes JSON Schema more strictly than the adapter does. Check the handler first.
- A tool call from an Ollama Cloud model fails with nearly correct arguments: check the alias normalization in `server/tools.js`.
- `create_file` writes to disk without the edit-approval step that other edit tools use.
- Pending edits are held in memory and are lost on a page refresh.
- The codebase index uses 1536-dimension vectors and brains use 512. They are different vector spaces.
- A brain does not load: its path must be in the configured brain directories.
