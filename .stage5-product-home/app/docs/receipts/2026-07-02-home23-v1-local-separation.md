# Home23 v1.0 Local Separation Receipt

Date: 2026-07-02
Separation commit: `b4d70f52450749a19e574051e01062ba152ca48b`
Tag at verification time: `v1.0.0`

## Objective

Make the public Home23 1.0 release safe for a fresh install by keeping jtr's live runtime, local configs, generated caches, private certs, and local operator context out of the main Git tree.

## Separation Applied

- Untracked generated local config: `config/home.yaml`, `config/targets.yaml`, `config/cron-jobs.json`.
- Added public seed files: `config/home.yaml.example`, `config/targets.yaml.example`, `config/cron-jobs.json.example`.
- Untracked generated PM2 state: `ecosystem.config.cjs`.
- Untracked local runtime and operator state under `instances/`, local logs, temp files, generated reports, X tool outputs/caches, sensor cache, and COSMO SSL certs.
- Preserved local live copies on disk with cached removals only.
- Split local agent instructions into ignored `AGENTS.local.md` and `CLAUDE.local.md`; tracked `AGENTS.md` and `CLAUDE.md` are now portable repo instructions.
- Updated `init` and start-time system health checks to seed local config from `config/*.example`.
- Updated onboarding docs to use `init -> agent create <name> -> start <name>`.
- Replaced stale `scripts/start-agent.sh` implementation with the maintained CLI/PM2 start path.
- Removed personal fallback defaults from active runtime source paths and sensor scripts.

## Verification

Passed:

```bash
bash -n scripts/start-agent.sh scripts/log-pressure.sh scripts/log-health.sh scripts/log-workouts.sh
python3 -m py_compile scripts/backfill-ecowitt-pressure.py scripts/log-health-from-forrest.py
node --check scripts/refresh-synthesis.cjs
node --check scripts/olddeadshows-issue-arc.cjs
node --check engine/src/evidence/from-the-inside-publish.js
git diff --check
npm run build
npm test
npm run test:contracts
git ls-files -ci --exclude-standard
```

Clean archive checks passed:

```bash
git archive HEAD | tar -tf - | rg '^(instances/|config/(home|targets)\.yaml$|config/cron-jobs\.json$|ecosystem\.config\.cjs$|brainandjerrylogs\.md$|evolve\.md$|tmp/|reports/pm2-recovery/|workspace/reports/|workspace/skills/.*/(outputs|reports)/|workspace/skills/x-research/data/(cache/|watchlist\.json$)|cosmo23/engine/brain-studio-new/ssl/)'
```

Result: no matches.

Extracted-archive smoke passed:

```bash
git archive HEAD | tar -x -C "$tmp"
test ! -e config/home.yaml
test ! -e config/targets.yaml
test ! -e config/cron-jobs.json
test ! -e ecosystem.config.cjs
test ! -e instances
test -e config/home.yaml.example
test -e config/targets.yaml.example
test -e config/cron-jobs.json.example
node cli/home23.js help
```

Local preservation check passed after cached removal:

```bash
test -f config/home.yaml
test -f config/targets.yaml
test -f config/cron-jobs.json
test -f ecosystem.config.cjs
test -f AGENTS.local.md
test -f CLAUDE.local.md
test -f instances/jerry/workspace/DOCTRINE.md
git ls-files config/home.yaml config/targets.yaml config/cron-jobs.json ecosystem.config.cjs AGENTS.local.md CLAUDE.local.md instances/jerry/workspace/DOCTRINE.md
```

Result: local files exist; tracked-file query prints no paths.

## Notes

Historical design notes and receipts may still mention earlier local paths as evidence context. Active runtime source, public onboarding docs, tracked config examples, and release archive checks no longer ship live local runtime state.
