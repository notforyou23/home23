# Home23 Agent Instructions

## Shared development workflow

Read [the shared development working agreement](docs/reference/DEVELOPMENT-WORKFLOW.md) before cross-tool or release work. Repository-specific instructions below still apply. Preserve concurrent work and check the actual branch; current product development may be ahead of GitHub main.

## What This Is

Home23 is an installable AI operating system. The public repo must stay portable: source, examples, docs, tests, and templates belong in Git; local runtime state does not.

If you are working inside an existing live installation and `AGENTS.local.md` exists, read it after this file. `AGENTS.local.md` is intentionally ignored by Git and may contain machine-specific operator context.

## Working Autonomy

Carry implementation requests through the source changes, necessary cleanup and integration, verification, and local Git checkpoints needed for the requested outcome. Review and commit only the task's changes; preserve unrelated work. Do not turn an audit or explanation into implementation. Respect explicit task limits, including requests not to commit.

Use judgment for routine choices. Ask only for a consequential decision outside the task's authorization; authorization already given remains valid. Production activation, service restarts, destructive data changes, pushes and publishing require authorization covering that action. Implementation alone does not authorize them.

The lead owns the return to maintained source. A "do not commit" limit assigned to workers leaves committing and integration with the lead; it does not create an owner approval requirement. Follow the shared agreement's task record, dependency reconciliation and verification rules before declaring completion.

## Before You Edit

If `instances/.house/source-authority.json` exists, run `npm run source:status` and use its maintained development source. An installation checkout or an old task worktree is not automatically the source for new changes. Read `docs/reference/SOURCE-AUTHORITY.md`.

1. Check repository state:
   ```bash
   git status --short --branch
   ```
2. Read the documentation relevant to the area and operation. Reuse material already read during the task; refresh it when the source, scope, or relevant facts change. Do not read every design document as a ritual:
   - `README.md` and `docs/ONBOARDING.md` for install/start behavior.
   - `docs/reference/COSMO-SEPARATION.md` for the standalone Cosmo boundary; former vendoring notes are historical.
   - The matching `docs/design/*` file for feature areas with design docs.
3. Protect local state. Do not delete or overwrite runtime data unless the operator explicitly asks.
4. If `instances/.house/coordination/active-release.json` exists, read `docs/reference/MANAGED-RELEASES.md` before build, update, launcher or deployment work. Verify the selected package and actual process paths; prepare and build changes in isolation. A working checkout is not necessarily the deployed source baseline.

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

For consumer product/distribution work, read
[Product delivery](docs/design/PRODUCT-DELIVERY.md). The agreed entry point is
the public website and apps, with a private browser dashboard for each home.
Keep planned downloads, Windows browser access and hosted homes distinct from
verified release availability. The source/operator fallback below remains supported.

A source installer should be able to run:

```bash
node cli/home23.js setup
```

`setup` seeds local config from `config/*.example`, starts the web-guided first-run page, and walks the user through provider setup, first-agent creation, owner/user facts, purpose, starter project/import folders, model choice, and launch. The shared first-home operation prepares an independent Seed, canonical home/conversation, and resident credentials; the resident is marked as `home.primaryAgent`, and `ecosystem.config.cjs` is regenerated. Preparation is resumable and is distinct from startup. See [HOME-BIRTH.md](docs/design/HOME-BIRTH.md).

The terminal-guided fallback is:

```bash
node cli/home23.js setup --cli
```

For scripted/manual setup, the equivalent lower-level flow is:

```bash
node cli/home23.js init
node cli/home23.js home create /path/to/profile.json
node cli/home23.js start <name>
```

The generated `instances/`, local `config/*.yaml`/`*.json`, and `ecosystem.config.cjs` files are installation state. They must remain ignored by Git.

## Hard Rules

- Do not run broad destructive PM2 commands such as `pm2 stop all` or `pm2 delete all`.
- Do not use destructive Git cleanup commands unless explicitly requested.
- Do not commit local runtime files, secrets, keys, private certs, chat logs, or machine-specific operator handoffs.
- Include cleanup, consolidation and supporting changes needed for the requested outcome. Explain material scope changes; ask before pursuing unrelated product direction.
- After code changes, run the smallest meaningful verification first, then broaden when release or onboarding behavior changed.

## Verification

Follow the shared agreement's verification scope. For release/onboarding work, prefer:

```bash
npm run build
npm test
npm run test:contracts
```

The full backend suite's cross-product pretest requires `COSMO23_SOURCE_ROOT` to point to the standalone Cosmo checkout, as documented in `docs/reference/COSMO-SEPARATION.md`. Check that prerequisite before running it. A failed pretest prevents the main test command from running; report the stages separately.

For fresh-install separation, also verify tracked files:

```bash
git ls-files -ci --exclude-standard
if git archive HEAD | tar -tf - | rg '^(instances/|config/(home|targets|secrets)\.yaml$|config/(cron-jobs|agents)\.json$|ecosystem\.config\.cjs$)'; then
  echo 'Refusing release: archive contains local installation state' >&2
  exit 1
fi
```
