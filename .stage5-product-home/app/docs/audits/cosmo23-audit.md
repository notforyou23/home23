# Audit: cosmo23/ Component

**Date:** 2026-04-09
**Auditor:** Claude Opus 4.6 (automated)
**Source:** `/Users/jtr/_JTR23_/Home23/cosmo23/`
**Purpose:** Public release readiness — personal data, artifacts, functionality

---

## Source Directories

All verified as actual source code (JS, HTML, CSS, YAML):

| Directory | Size | File Count (approx) | Status |
|---|---|---|---|
| `engine/src/` | 7.9MB | ~300 | Source code (JS, HTML, CSS, YAML, CLAUDE.md files) |
| `lib/` | 608K | ~10 | Source code (query engine, PGS, brain search, config) |
| `server/` | 396K | ~15 | Source code (Express app, providers, services) |
| `launcher/` | 96K | ~4 | Source code (config generator, process/run manager) |
| `public/` | 352K | ~10 | Frontend (HTML, JS, CSS — vanilla, no build step) |
| `ide/` | 96K | ~2 | Source code |
| `pgs-engine/` | 1.9MB | ~50 | Source code (semantic search engine) |

**Total source files:** ~395 across all directories.

Additional engine subdirectories with source:
- `engine/scripts/` — 1.4MB (utility scripts, batch cleaners)
- `engine/tests/` — 888K (unit + integration tests)
- `engine/mcp/` — 296K (MCP server, filesystem server)
- `engine/docs/` — 240K (product spec, design docs)
- `engine/brain-studio/` — 1.0MB (brain visualization UI)
- `engine/brain-studio-new/` — 1.7MB (updated brain visualization)

---

## Artifact Directories (must NOT ship)

| Directory | Size | What | .gitignore Coverage |
|---|---|---|---|
| `runs/` | 1.4GB | Research run outputs | COVERED (`runs/*` + `!runs/.gitkeep`) |
| `runtime` | 198MB (symlink) | Symlink to `runs/jerryg-fork-jtr-import-import` | COVERED |
| `node_modules/` | 342MB | Root dependencies | COVERED |
| `engine/node_modules/` | 247MB | Engine dependencies | COVERED (via `node_modules/`) |
| `.cosmo23-config/` | 16K | Runtime config with **LIVE API KEYS** | **NOT COVERED** |
| `.cosmo23-config/database.db` | — | SQLite database (OAuth tokens) | NOT COVERED (*.db covered in engine .gitignore only) |
| `exports/` | 36MB | Brain export artifacts with personal paths | **NOT COVERED** |
| `exports/*/outputs/` | — | Research output artifacts | NOT COVERED |
| `.playwright-mcp/` | 2.5MB | Playwright MCP state | COVERED |
| `.superpowers/` | 76K | Superpowers plans/state | COVERED |
| `.worktrees/` | 31MB | Git worktrees | COVERED |
| `engine/.backups/` | 516K | Backup files | COVERED |
| `engine/logs/` | exists | Process logs | COVERED (engine .gitignore) |
| `engine/outputs/` | exists | Agent output artifacts | **NOT COVERED in root .gitignore** |
| `engine/test-results/` | exists | Test output | COVERED |
| `engine/archived/` | 0B (empty) | Empty | N/A |
| `engine/backups/` | 0B (empty) | Empty | COVERED (engine .gitignore) |
| `engine/generated-code/` | 0B (empty) | Empty | N/A |
| `engine/queries-archive/` | exists | Historical query data | COVERED (engine .gitignore) |
| `engine/test-frontier/` | exists | Test data | COVERED (engine .gitignore) |
| `prisma/dev.db` | not present | SQLite DB (not currently generated) | COVERED (`*.db`) |
| `docs/superpowers/` | exists | Superpowers plans with personal paths | Partially covered |

---

## Personal Data Findings

### CRITICAL: Live API Keys in `.cosmo23-config/config.json`

```
.cosmo23-config/config.json:
  - OpenAI API key: sk-proj-REDACTED
  - xAI API key: xai-REDACTED
  - Encryption key: REDACTED
```

**Action required:** This file must NEVER be committed. Add `.cosmo23-config/` to .gitignore.

### Hardcoded Paths (`/Users/jtr/`)

**Source files (must fix before release):**

| File | Lines | Issue |
|---|---|---|
| `engine/src/dashboard/docs-ide.html` | 1715, 1889, 2059, 4502, 4512, 4681, 4744, 4770, 4858, 4902, 4966, 5835, 6022, 6052, 6073, 6142, 6199 | **17 hardcoded paths** — fallback paths like `'/Users/jtr/_JTR23_/COSMO'` and `'/Users/jtr'` |
| `engine/src/dashboard/docs-ide-v2.html` | 2207 | `const cosmoRoot = '/Users/jtr/_JTR23_/COSMO'` |
| `engine/src/agents/document-analysis-agent.js` | 1230 | `'jtr'` in deprecated directory list (deprecated function, but still present) |
| `engine/mcp/filesystem-server.js` | 168 | Comment reference `/Users/jtr/Documents/` (comment only) |
| `engine/mcp/claude_desktop_config_example.json` | 6 | Hardcoded path `/Users/jtr/_JTR23_/new_Coz/mcp-server/cosmo-mcp.js` |
| `engine/tests/unit/execution-base-agent.test.js` | 882 | Test string `'rm -rf /Users/jtr/cosmo/runs/agent/temp'` |

**Documentation files (must fix or exclude):**

| File | Issue |
|---|---|
| `README.md` | 6 hardcoded paths to `/Users/jtr/_JTR23_/cosmo_2.3/` |
| `AGENTS.md` | 12 hardcoded paths to `/Users/jtr/_JTR23_/cosmo_2.3/` + reference to `/Users/jtr/xCode_Builds/Cosmo` |
| `docs/USAGE.md` | 8 hardcoded paths to `/Users/jtr/_JTR23_/cosmo_2.3/` |
| `engine/docs/COSMO_PRODUCT_SPEC.md` | 12+ hardcoded paths to various `/Users/jtr/` locations |
| `engine/scripts/batch-clean-brains.js` | 2 example paths in comments |
| `engine/scripts/patch-memory-paths.js` | 1 example path in comment |
| `engine/scripts/refocus-run.js` | 1 example path in comment |
| `docs/superpowers/plans/2026-04-03-ingestion-tab.md` | 2 hardcoded paths |

**Export artifacts (should not ship at all):**

| File | Issue |
|---|---|
| `exports/predicts.brain/outputs/*/manifest.json` | Multiple files with `/Users/jtr/websites/cosmos.evobrew.com/` paths |
| `exports/predicts.brain/outputs/*/audit-log.json` | Multiple files with `/Users/jtr/websites/` paths |
| `exports/predicts.brain/outputs/*/summary.json` | Paths to jtr's website data |
| `exports/merged-jgscrapes.brain/` | Scraped web content (Jerry Garcia site) |

### Username References

- `engine/src/agents/document-analysis-agent.js:1230` — `'jtr'` in deprecated directory list
- `runtime` symlink target: `runs/jerryg-fork-jtr-import-import` — contains `jtr` in run name
- No `notforyou23` references found in source files
- `jerry` references only in `exports/` (Jerry Garcia website scrape data — artifact, not source)

### No Hardcoded API Keys in Source

No `sk-` prefixed keys or hardcoded `apiKey=` values found in source code. The only API keys are in `.cosmo23-config/config.json` (runtime-generated, must not ship).

---

## Root-Level Files

### Should Ship

| File | Size | Notes |
|---|---|---|
| `package.json` | 1.4K | Dependencies, scripts |
| `package-lock.json` | 215K | Lock file |
| `.env.example` | 934B | Template for env vars |
| `.gitignore` | comprehensive | Needs additions (see gaps) |
| `prisma/schema.prisma` | 730B | Database schema |

### Should Ship (with fixes)

| File | Notes |
|---|---|
| `README.md` | Must remove hardcoded `/Users/jtr/` paths |
| `AGENTS.md` | Must remove hardcoded paths |
| `CLAUDE.md` | 12K — review for personal references |

### Must NOT Ship

| File/Dir | Why |
|---|---|
| `.cosmo23-config/` | Contains live API keys |
| `exports/` | Personal research data with hardcoded paths |
| `runs/` | 1.4GB of research run data |
| `runtime` | Symlink to personal run |
| `docs/superpowers/` | Development plans with personal paths |

### Engine Root — Must NOT Ship

| File | Why |
|---|---|
| `engine/.DS_Store` | OS artifact |
| `engine/.cursor/` | Editor config |
| `engine/.vscode/` | Editor config |
| `engine/filesystem-mcp.log` | Runtime log |
| `engine/showcase-data.json` | Personal data |
| `engine/import-oauth-*.js` | Personal OAuth import scripts |
| `engine/test-*.js` (root level) | Dev test files |
| `engine/ask` | 110K executable |

---

## .gitignore Gaps

The root `.gitignore` is well-structured but missing these entries:

| Missing Entry | Risk | Size |
|---|---|---|
| `.cosmo23-config/` | **CRITICAL** — contains live API keys | 16K |
| `exports/` | Personal research data with paths/content | 36MB |
| `engine/outputs/` | Agent output artifacts | varies |

The engine's own `.gitignore` covers many engine-internal artifacts (logs, node_modules, *.db, etc.) but the root `.gitignore` should also cover:
- `.cosmo23-config/` (currently only `.claude/` is listed, not `.cosmo23-config/`)
- `exports/` or `exports/*/outputs/` (brain exports are gitignored by `*.brain/` in engine .gitignore, but not in root)

**Note:** The root .gitignore has `*.brain/` entries but only in the engine .gitignore. The root .gitignore does NOT have this pattern.

---

## Engine Directory Summary

**Total on disk:** ~325MB (247MB is node_modules)
**Source code:** ~14MB (src/ 7.9MB + scripts 1.4MB + brain-studio 2.7MB + tests 888K + mcp 296K + docs 240K)
**Must ship:** `engine/src/`, `engine/package.json`, `engine/package-lock.json`, `engine/.env.example`, `engine/.gitignore`, `engine/Dockerfile`, `engine/docker-compose.yml`, `engine/lib/` (if exists), `engine/mcp/` (with path fixes), `engine/tests/`, `engine/scripts/` (with comment fixes)
**Must NOT ship:** `engine/node_modules/`, `engine/.DS_Store`, `engine/.cursor/`, `engine/.vscode/`, `engine/logs/`, `engine/outputs/`, `engine/test-results/`, `engine/.backups/`, `engine/queries-archive/`, `engine/test-frontier/`, `engine/import-oauth-*.js`, `engine/showcase-data.json`, `engine/filesystem-mcp.log`

---

## Required Fixes (Priority Order)

### P0 — Security

1. **Add `.cosmo23-config/` to .gitignore** — contains live OpenAI + xAI API keys
2. **Add `exports/` to .gitignore** — contains paths to personal website data
3. **Rotate exposed API keys** — the keys in `.cosmo23-config/config.json` should be considered compromised if this directory was ever committed

### P1 — Personal Data in Source

4. **`engine/src/dashboard/docs-ide.html`** — 17 instances of `/Users/jtr/_JTR23_/COSMO` used as fallback path. Replace with dynamic resolution (e.g., `process.cwd()` or config-driven)
5. **`engine/src/dashboard/docs-ide-v2.html`** — 1 instance of hardcoded cosmoRoot
6. **`engine/src/agents/document-analysis-agent.js`** — remove `'jtr'` from deprecated directory list (line 1230)
7. **`engine/mcp/claude_desktop_config_example.json`** — replace hardcoded path with placeholder
8. **`engine/tests/unit/execution-base-agent.test.js`** — replace path in test string

### P2 — Documentation

9. **`README.md`** — rewrite path references to use relative paths
10. **`AGENTS.md`** — rewrite path references to use relative paths
11. **`docs/USAGE.md`** — rewrite path references
12. **`engine/docs/COSMO_PRODUCT_SPEC.md`** — rewrite or exclude
13. **Script comments** — update example paths in `engine/scripts/batch-clean-brains.js`, `patch-memory-paths.js`, `refocus-run.js`

### P3 — Cleanup

14. **Remove `engine/import-oauth-*.js`** — personal OAuth import scripts
15. **Remove or gitignore root-level test files** in engine/ (`test-*.js`)
16. **Remove `engine/showcase-data.json`** — may contain personal data
17. **Remove `engine/.DS_Store`** files (multiple found)
18. **Exclude `docs/superpowers/`** — development plans with personal paths

---

## Functionality Assessment

The source code appears to work standalone:
- `package.json` at root and `engine/package.json` define all dependencies
- `prisma/schema.prisma` defines the database schema
- `.env.example` files document required environment variables
- No hardcoded API keys in source (all via config/env)
- The hardcoded paths in `docs-ide.html` are **fallback defaults** — they would fail gracefully on other machines but should still be fixed

**One concern:** The `engine/` directory has its own `package.json` with separate dependencies. Both `npm install` at root and `cd engine && npm install` are needed. This is documented in COSMO's own docs.
