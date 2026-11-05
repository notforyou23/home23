# Incremental follow-up transfer for Grok Bot

Do not `git push`. Do not pull GitHub. Do not modify
`/home/box/home23-owned-embedder-test/home` (the installed Host home).
Do not overlay source files onto that home. Do not re-run `package.mjs`,
create, interrupt, ingest, or the first semantic retrieve.

The installed artifact revision remains
`be6254879fc8c22a6265e6010ac0284f70f4329b`.
This bundle only updates the isolated **source checkout**.

## What this is

Incremental git bundle based on Grok Bot’s existing `be625487` checkout.

| Item | Value |
|---|---|
| Prerequisite | `be6254879fc8c22a6265e6010ac0284f70f4329b` already in `$H23_ROOT/source` |
| Follow-up HEAD | `1905b5798b6d1a49252f715d9a5cd55c6697b054` |
| Included commits | `309f565f` (outage keyword fallback + owned-empty-URL fail-closed), `1905b579` (names that commit) |
| Bundle | `home23-owned-embedder-be625487-to-1905b579.bundle` |
| Bundle SHA-256 | `88c4d114f1424b5cdb9f6c0d4ac77a3ecd6c5a983a5fdd0ec2fd14a01dac3a71` |
| Named ref in bundle | `owned-embedder-outage-followup` |

The 1905b579 handoff still mentions an optional file overlay. **Ignore that
paragraph.** This transfer supersedes it.

Preserve Scout `/home/box/home23-test`, Keep/GrokBot, and host Ollama `:11434`.
Do not export `HOME=$HOME_ROOT`.

## 1. Checksum (basename only)

`cd` into the directory that contains this file and the bundle:

```bash
sha256sum -c home23-owned-embedder-be625487-to-1905b579.bundle.sha256
# expect 88c4d114f1424b5cdb9f6c0d4ac77a3ecd6c5a983a5fdd0ec2fd14a01dac3a71
```

The `.sha256` file names only the bundle basename so the check works after copy.

## 2. Fetch into the existing source checkout

```bash
H23_ROOT=/home/box/home23-owned-embedder-test
PREREQ=be6254879fc8c22a6265e6010ac0284f70f4329b
FOLLOWUP=1905b5798b6d1a49252f715d9a5cd55c6697b054
BUNDLE="$PWD/home23-owned-embedder-be625487-to-1905b579.bundle"

test "$(git -C "$H23_ROOT/source" rev-parse HEAD)" = "$PREREQ"
test -z "$(git -C "$H23_ROOT/source" status --porcelain --untracked-files=no)"

git -C "$H23_ROOT/source" bundle verify "$BUNDLE"
# expect: requires be625487… ; contains owned-embedder-outage-followup = 1905b579…

git -C "$H23_ROOT/source" fetch "$BUNDLE" owned-embedder-outage-followup
git -C "$H23_ROOT/source" switch --detach FETCH_HEAD

test "$(git -C "$H23_ROOT/source" rev-parse HEAD)" = "$FOLLOWUP"
git -C "$H23_ROOT/source" merge-base --is-ancestor "$PREREQ" HEAD
git -C "$H23_ROOT/source" log --oneline "$PREREQ"..HEAD
# expect only:
# 1905b579 Name the context-search outage follow-up commit.
# 309f565f Restore context-search keyword fallback when the owned encoder is down.
```

Fail if `bundle verify` says the prerequisite is missing. Do not `git clone`
this bundle into a new tree as a standalone repository.

## 3. Focused tests — candidate Node 22 only

Use the private toolchain from the original trial. Do not change `/usr/bin/node`.

```bash
H23_ROOT=/home/box/home23-owned-embedder-test
NODE22="$H23_ROOT/toolchain/node-v22.19.0-linux-x64/bin/node"
test "$("$NODE22" -p process.version)" = "v22.19.0"
test "$(/usr/bin/node -p process.version)" != "v22.19.0"

cd "$H23_ROOT/source"
# Source may have no node_modules. Reuse the existing payload install if present.
# Do not write into $H23_ROOT/home.
if [ ! -d node_modules ] && [ -d "$H23_ROOT/payload/app/node_modules" ]; then
  export NODE_PATH="$H23_ROOT/payload/app/node_modules"
fi

"$NODE22" --test --test-concurrency=1 tests/engine/dashboard/memory-search.test.js
"$NODE22" --test --test-concurrency=1 tests/engine/core/openai-client-embedding-url.test.cjs
"$NODE22" --test --test-concurrency=1 tests/cli/owned-embedding-ecosystem.test.js
```

If `js-yaml` cannot be resolved and payload `node_modules` is absent, run
`"$H23_ROOT/toolchain/node-v22.19.0-linux-x64/bin/npm" install --ignore-scripts`
**in `$H23_ROOT/source` only**. Never npm-install into the installed home.

Leave `$H23_ROOT/home` stopped and untouched. Installed `packageId` / payload
commit stay `be625487`.

## 4. Outage-scan deadline (do not expand)

The two-document Linux fixture does **not** prove the new context-mode
keyword scan stays inside the turn enrichment deadline on a larger brain.

Report unit-test results only. Do not build a large-brain benchmark. Do not
start Stage 6. Keep measured attention calibration unfinished.
