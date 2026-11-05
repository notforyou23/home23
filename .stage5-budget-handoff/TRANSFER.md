# Incremental scan-budget transfer for Grok Bot

Do not `git push`. Do not pull GitHub. Do not modify
`/home/box/home23-owned-embedder-test/home`.
Do not overlay source onto that home. Do not re-run `package.mjs`,
create, interrupt, ingest, or the first semantic retrieve.

Installed artifact revision remains
`be6254879fc8c22a6265e6010ac0284f70f4329b`.
This bundle only updates the isolated **source checkout**.

Do not edit the earlier transfers
(`be625487` install bundle, `be625487`→`1905b579` follow-up).

## What this is

| Item | Value |
|---|---|
| Prerequisite | `1905b5798b6d1a49252f715d9a5cd55c6697b054` already in `$H23_ROOT/source` |
| Exact HEAD | `5e567a8f0bd0cceaf1e40f5edae81c69f844aef1` |
| Included commit | `5e567a8f` Bound context-outage keyword scans so turn enrichment can stay honest. |
| Bundle | `home23-owned-embedder-1905b579-to-5e567a8f.bundle` |
| Bundle SHA-256 | `7406edc363f7c657e520758c6d9e6c84221935bb54f16341d6dde13e7cbcc71b` |
| Named ref | `owned-embedder-scan-budget` |

If `$H23_ROOT/source` is still `be625487`, apply the previous incremental
(`be625487`→`1905b579`) first. This bundle will not verify against
`be625487` alone.

Preserve Scout `/home/box/home23-test`, Keep/GrokBot, and host Ollama `:11434`.
Do not export `HOME=$HOME_ROOT`.

Evidence in this folder:
`2026-09-11-owned-embedder-context-outage-scan-budget.md`
`CANDIDATE-RECORD.md`

## 1. Checksum (basename only)

`cd` into the directory that contains this file and the bundle:

```bash
sha256sum -c home23-owned-embedder-1905b579-to-5e567a8f.bundle.sha256
# expect 7406edc363f7c657e520758c6d9e6c84221935bb54f16341d6dde13e7cbcc71b
```

## 2. Fetch into the existing source checkout

```bash
H23_ROOT=/home/box/home23-owned-embedder-test
PREREQ=1905b5798b6d1a49252f715d9a5cd55c6697b054
FOLLOWUP=5e567a8f0bd0cceaf1e40f5edae81c69f844aef1
BUNDLE="$PWD/home23-owned-embedder-1905b579-to-5e567a8f.bundle"

test "$(git -C "$H23_ROOT/source" rev-parse HEAD)" = "$PREREQ"
test -z "$(git -C "$H23_ROOT/source" status --porcelain --untracked-files=no)"

git -C "$H23_ROOT/source" bundle verify "$BUNDLE"
# expect: requires 1905b579… ; contains owned-embedder-scan-budget = 5e567a8f…

git -C "$H23_ROOT/source" fetch "$BUNDLE" owned-embedder-scan-budget
git -C "$H23_ROOT/source" switch --detach FETCH_HEAD

test "$(git -C "$H23_ROOT/source" rev-parse HEAD)" = "$FOLLOWUP"
git -C "$H23_ROOT/source" merge-base --is-ancestor "$PREREQ" HEAD
git -C "$H23_ROOT/source" log --oneline "$PREREQ"..HEAD
# expect only:
# 5e567a8f Bound context-outage keyword scans so turn enrichment can stay honest.
```

Fail if `bundle verify` says the prerequisite is missing. Do not `git clone`
this bundle as a standalone repository.

## 3. Focused tests — candidate Node 22 only

Use the private toolchain. Do not change `/usr/bin/node`.

```bash
H23_ROOT=/home/box/home23-owned-embedder-test
NODE22="$H23_ROOT/toolchain/node-v22.19.0-linux-x64/bin/node"
test "$("$NODE22" -p process.version)" = "v22.19.0"
test "$(/usr/bin/node -p process.version)" != "v22.19.0"

cd "$H23_ROOT/source"
if [ ! -d node_modules ] && [ -d "$H23_ROOT/payload/app/node_modules" ]; then
  export NODE_PATH="$H23_ROOT/payload/app/node_modules"
fi

"$NODE22" --test --test-concurrency=1 tests/engine/dashboard/memory-search.test.js
"$NODE22" --test --test-concurrency=1 \
  --test-name-pattern 'context outage|context mode uses keyword scan when the encoder is unavailable|context mode skips the full-brain scan|default search still walks|search cancellation is never converted' \
  tests/engine/dashboard/memory-search.test.js
```

The first command is the required suite (includes the on-disk 301-node
budget tests). The second is the focused subset if you need a shorter
transcript. If `js-yaml` cannot be resolved and payload `node_modules` is
absent, run
`"$H23_ROOT/toolchain/node-v22.19.0-linux-x64/bin/npm" install --ignore-scripts`
in `$H23_ROOT/source` only.

Leave `$H23_ROOT/home` stopped. Installed payload stays `be625487`.

Do not start Stage 6. Keep measured attention calibration unfinished.
