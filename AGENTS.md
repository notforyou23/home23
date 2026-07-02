# Home23 Agent Instructions

## What This Is

Home23 is an installable AI operating system. The public repo must stay portable: source, examples, docs, tests, and templates belong in Git; local runtime state does not.

If you are working inside an existing live installation and `AGENTS.local.md` exists, read it after this file. `AGENTS.local.md` is intentionally ignored by Git and may contain machine-specific operator context.

## Before You Edit

1. Check repository state:
   ```bash
   git status --short --branch
   ```
2. Read the docs for the area you are touching:
   - `README.md` and `docs/ONBOARDING.md` for install/start behavior.
   - `docs/design/COSMO23-VENDORED-PATCHES.md` before changing anything under `cosmo23/`.
   - The matching `docs/design/*` file for feature areas with design docs.
3. Protect local state. Do not delete or overwrite runtime data unless the operator explicitly asks.

## Public vs Local State

Keep these local and untracked:

- `instances/`
- `config/home.yaml`
- `config/targets.yaml`
- `config/cron-jobs.json`
- `config/agents.json`
- `config/secrets.yaml`
- `ecosystem.config.cjs`
- generated logs, caches, reports, SSL certs, and temporary files

Public defaults belong in:

- `config/home.yaml.example`
- `config/targets.yaml.example`
- `config/cron-jobs.json.example`
- `config/secrets.yaml.example`
- `cli/templates/`
- docs and tests

When separating local files from Git, use cached removal such as `git rm --cached <path>` so the user's local files remain on disk.

## Fresh Install Contract

A new user should be able to run:

```bash
node cli/home23.js init
node cli/home23.js agent create <name>
node cli/home23.js start <name>
```

`init` seeds local config from `config/*.example`. `agent create` writes `instances/<name>/` and regenerates `ecosystem.config.cjs`.

## Hard Rules

- Do not run broad destructive PM2 commands such as `pm2 stop all` or `pm2 delete all`.
- Do not use destructive Git cleanup commands unless explicitly requested.
- Do not commit local runtime files, secrets, keys, private certs, chat logs, or machine-specific operator handoffs.
- Keep fixes scoped. Avoid feature work unless the user asks for it.
- After code changes, run the smallest meaningful verification first, then broaden when release or onboarding behavior changed.

## Verification

For release/onboarding work, prefer:

```bash
npm run build
npm test
npm run test:contracts
```

For fresh-install separation, also verify tracked files:

```bash
git ls-files -ci --exclude-standard
git archive HEAD | tar -tf - | rg '^(instances/|config/(home|targets|cron-jobs)\.yaml|ecosystem\.config\.cjs)'
```
