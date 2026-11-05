# Security Audit — Pre-Public Repository

**Date:** 2026-04-07
**Scope:** All files tracked by git in Home23 repository
**Method:** Automated pattern scanning + manual review of all flagged files

---

## CRITICAL Issues

### 1. Alpaca API Credentials in Committed File
**File:** `cosmo23/exports/predicts.brain/outputs/benchmark_harness/.env.example`
**Detail:** Contains what appear to be real Alpaca paper-trading API credentials:
- `ALPACA_API_KEY=PK6CS2NY34RN7VXHLNVQTIMTV2`
- `ALPACA_API_SECRET=Evy2ZnNMGXSubJr98vhJtfCCPAY8DDPfyZpXt3zDVyQ8`
- Also contains a hardcoded `postgresql://user:password@...` connection string

**Fix applied:** Removed from git tracking (`git rm --cached`), added pattern to `.gitignore`.

**Remaining action (HUMAN REQUIRED):** These credentials exist in git history (commit `d7133b9`). If these are real credentials:
1. **Rotate the Alpaca API key immediately** at https://app.alpaca.markets
2. To purge from history: `git filter-branch` or `git-filter-repo` (rewrites all commit SHAs)
3. If the repo was ever pushed publicly, consider the keys compromised regardless

---

## HIGH Issues

### 2. SSL Private Keys Committed (4 files)
**Files:**
- `engine/brain-studio-new/ssl/key.pem`
- `engine/brain-studio-new/ssl/cert.pem`
- `cosmo23/engine/brain-studio-new/ssl/key.pem`
- `cosmo23/engine/brain-studio-new/ssl/cert.pem`

**Detail:** Self-signed development certificates (CN=192.168.7.131, O=COSMO IDE, OU=Dev). 4096-bit RSA. While these are dev-only and self-signed, committing private keys is bad practice and triggers security scanners.

**Fix applied:** Removed from git tracking, added `*.pem` and ssl directory patterns to `.gitignore`.

**Remaining action:** These exist in git history. Low risk since they are self-signed dev certs bound to a local IP, but `git filter-repo` would remove them from history.

### 3. Hardcoded User Paths in Source Code
**Files with functional (non-doc) hardcoded paths:**

| File | Issue | Fix Applied |
|------|-------|-------------|
| `cli/lib/cosmo23-update.js:18` | Fallback to `/path/to/cosmo_2.3` | Yes - removed fallback, requires config |
| `cli/lib/generate-ecosystem.js:173` | Fallback to `/path/to/cosmo_2.3/runs` | Yes - changed fallback to empty string |
| `config/home.yaml:12` | Hardcoded cosmo23 source path | Yes - commented out with placeholder |
| `cosmo23/.env.example:13` | Hardcoded reference run paths | Yes - cleared value |

**Files with hardcoded paths in docs/comments only (no fix needed for functionality, but reveals local paths):**
- `cosmo23/engine/mcp/claude_desktop_config_example.json` — example config
- `cosmo23/engine/scripts/batch-clean-brains.js` — usage comments
- `cosmo23/engine/scripts/patch-memory-paths.js` — usage comments
- `cosmo23/engine/scripts/refocus-run.js` — usage comments
- `cosmo23/engine/src/dashboard/docs-ide.html` — ~20 hardcoded fallback paths
- `cosmo23/engine/src/dashboard/docs-ide-v2.html` — hardcoded path
- `cosmo23/engine/tests/unit/execution-base-agent.test.js` — test fixture
- `cosmo23/exports/*/outputs/*/audit.jsonl` — logged command history with local paths

**Remaining action:** The `cosmo23/engine/` files are copies from the upstream COSMO repo and per project rules should not be rewritten. The hardcoded paths in those files are cosmetic (docs, comments, fallback defaults) and will not cause functional issues. The `audit.jsonl` files in exports reveal the local filesystem layout but contain no secrets.

---

## MEDIUM Issues

### 4. Telegram User ID Exposed
**Files:** `instances/test-agent/config.yaml`, `instances/cosmo/config.yaml`
**Detail:** Both contained `telegramId: "REDACTED"`. While not a secret (Telegram user IDs are not credentials), it is PII that identifies the developer.

**Fix applied:** Replaced with empty string + comment placeholder in both files.

### 5. Agent Workspace Files Committed with Personal Content
**Files committed:**
- `instances/test-agent/workspace/SOUL.md` — personalized agent identity ("the agent, owner's AI sidekick")
- `instances/test-agent/workspace/MISSION.md` — personalized mission
- `instances/test-agent/workspace/MEMORY.md` — session logs with system details
- `instances/test-agent/workspace/HEARTBEAT.md` — status file
- `instances/test-agent/workspace/LEARNINGS.md` — learning log
- `instances/test-agent/workspace/test-note.md` — test file
- `instances/cosmo/workspace/*.md` — generic template content (OK)

**No fix applied.** These serve as examples of what workspace files look like. The personalized content is the developer's agent identity, not credentials. However, consider:
- Resetting `instances/test-agent/workspace/*.md` to template defaults before publishing
- Or adding `instances/*/workspace/` to `.gitignore` (but this removes useful examples)

### 6. Large Export Dataset Committed (1561 files)
**Path:** `cosmo23/exports/` (merged-jgscrapes.brain, predicts.brain)
**Detail:** Research brain exports with audit logs containing local filesystem paths, web scraping URLs, and command histories. No credentials found, but adds significant repo bloat and reveals development history.

**No fix applied.** Decision needed: should `cosmo23/exports/` be gitignored or kept as example data?

---

## LOW Issues

### 7. Test Keys in Test Scripts (Not Real)
**Files:** `evobrew/scripts/test-config-system.js`
**Detail:** Contains `sk-ant-api01-test-key-12345` and `sk-ant-api01-secretkey-12345` — clearly fake test values. No action needed.

### 8. Documentation References to Key Formats
**Files:** Multiple files in evobrew/, cosmo23/engine/ reference key format patterns like `sk-ant-*`, `sk-proj-*` in comments, docs, and format validators. These are pattern descriptions, not actual keys. No action needed.

---

## Verification: What Was Confirmed Safe

| Check | Result |
|-------|--------|
| `config/secrets.yaml` committed? | No (gitignored) |
| `.env` files committed? | No (only `.env.example` files) |
| `*.db` files committed? | No (gitignored) |
| `evobrew/config.json` committed? | No (gitignored) |
| `evobrew/.evobrew-config.json` committed? | No (gitignored) |
| `cosmo23/.cosmo23-config/` committed? | No (gitignored) |
| Actual API keys in code? | None found (grep for sk-ant, sk-proj, xai- patterns) |
| Actual bot tokens in code? | None found |
| JWT tokens in code? | None (only format descriptions) |
| AWS keys? | None found |
| OAuth tokens in committed files? | None found |
| Database files with tokens? | None committed |
| `node_modules/` committed? | No (gitignored) |
| Instance brain/ dirs committed? | No (gitignored) |
| Instance logs/ dirs committed? | No (gitignored) |
| Instance conversations/ committed? | No (only a `.gitkeep`) |

---

## Gitignore Additions Made

```
# SSL/TLS keys (even self-signed dev certs)
*.pem
**/*.pem

# COSMO 2.3 additions
cosmo23/exports/*/outputs/benchmark_harness/.env*

# Engine SSL
engine/brain-studio-new/ssl/
cosmo23/engine/brain-studio-new/ssl/
```

---

## Remaining Actions (Human Decision Required)

1. **URGENT: Rotate Alpaca API key** if `PK6CS2NY34RN7VXHLNVQTIMTV2` is a real credential
2. **Consider `git filter-repo`** to purge the Alpaca key and SSL keys from git history before making the repo public
3. **Decide on `cosmo23/exports/`** — keep as example data or gitignore (1561 files, adds repo bloat)
4. **Decide on `instances/test-agent/workspace/*.md`** — reset to templates or keep as examples
5. **Review hardcoded paths in `cosmo23/engine/`** — these are copies from upstream and reveal local filesystem layout, but contain no secrets
