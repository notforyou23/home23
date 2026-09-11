# Owned embedder — Linux handoff for Grok Bot

Date: 2026-09-11  
Tester: Grok Bot (independent). This document does **not** claim Linux results.

Use this as the candidate procedure. Map each check onto
`/workspace/home23-owned-embedder-prep/BASELINE-AND-RETEST.md`.
Do **not** pull a GitHub tip. Do **not** patch the product on the box.
Do **not** reuse `/home/box/home23-test`, Scout, Keep, or host Ollama.

Mac Host UI is outside Linux acceptance. The supported Linux lifecycle is
**build a Linux Host payload on the box, then `host.mjs` install / create /
semantic-prepare / start / stop** in an isolated root.

## 1. Exact candidate

| Item | Value |
|---|---|
| Repository | home23 |
| Branch name (local only) | `home23-agent/owned-embedder-stage5-verify` |
| Candidate commit | **see the transfer receipt that accompanies the bundle** (`candidateSha`) |
| How to get it | versioned `git bundle` + SHA-256 (not GitHub, not `main`) |
| Required after checkout | `git rev-parse HEAD` equals `candidateSha`; working tree clean |

Required components in that commit:

- `scripts/product/package.mjs` (Linux official-Node + `ldd` check)
- `scripts/product/host.mjs`, `cli/lib/product-host.js`, `cli/lib/product-embedder.js`
- `scripts/embedder/**`, `scripts/embedder/schema/recipes.json`
- `shared/semantic-encoder-contract.cjs`
- `scripts/embedder/fixtures/public-corpus/`

Apple Host (`home23-apple` `9cc694df`) is **not** part of this Linux gate.

## 2. Debian 13 x86_64 installation (isolated)

### Preserve

Leave these running and untouched:

- `/home/box/home23-test` (Scout)
- Keep / GrokBot
- host Ollama at `127.0.0.1:11434` (`nomic-embed-text`)

Do **not** change `/usr/bin/node` (currently 20.19). Do **not** `nvm use`,
`apt install nodejs`, or replace Scout's runtime. The candidate downloads its
**own** official Node 22 into the isolated root.

### Isolated layout (empty until this lands)

```text
/home/box/home23-owned-embedder-test/
  source/          # git checkout of candidateSha only
  toolchain/       # official Node 22.19.0 linux-x64 only
  payload/         # output of package.mjs (do not pre-create)
  home/            # Host install + one new home
  import/          # two public corpus files
  receipts/        # redacted JSON + command transcripts
  package-cache/   # npm/node-gyp cache for the payload build
```

Do not put any of this under `/home/box/home23-test`.

### Prerequisites already on the box

`build-essential`, `python3-venv`, `curl`, `xz-utils`, `git`. Keep them.
Add nothing that mutates Scout.

### Official Node 22 — candidate toolchain only

```bash
ROOT=/home/box/home23-owned-embedder-test
mkdir -p "$ROOT/toolchain" "$ROOT/import" "$ROOT/receipts" "$ROOT/package-cache"
cd "$ROOT/toolchain"
curl -fsSLo node-v22.19.0-linux-x64.tar.xz \
  https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz
echo 'c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2  node-v22.19.0-linux-x64.tar.xz' \
  | sha256sum -c -
tar -xJf node-v22.19.0-linux-x64.tar.xz
test -f "$ROOT/toolchain/node-v22.19.0-linux-x64/LICENSE"
"$ROOT/toolchain/node-v22.19.0-linux-x64/bin/node" -p 'process.version + " " + process.platform + " " + process.arch'
# expect: v22.19.0 linux x64
/usr/bin/node -p process.version
# still  v20.19.x  — fail the gate if this changed
```

### Materialize the exact source

```bash
# After the bundle is on the box (see Transfer):
git clone /path/to/home23-owned-embedder-<candidateSha>.bundle \
  /home/box/home23-owned-embedder-test/source
cd /home/box/home23-owned-embedder-test/source
git switch --detach <candidateSha>
test "$(git rev-parse HEAD)" = "<candidateSha>"
test -z "$(git status --porcelain --untracked-files=no)"
```

### Build the Linux Host payload

`package.mjs` now accepts Linux when `--node` is official Node 22 matching
`linux`/`x64` and `ldd` shows only system libraries. Run the **script** with
the box Node 20 if you want; the **payload binary** must be the toolchain Node 22.

```bash
ROOT=/home/box/home23-owned-embedder-test
NODE22="$ROOT/toolchain/node-v22.19.0-linux-x64"
# payload directory must not exist yet
cd /tmp
env -u PM2_HOME -u PM2_DAEMON_RPC_PORT -u PM2_DAEMON_PUB_PORT \
  /usr/bin/node "$ROOT/source/scripts/product/package.mjs" \
  --source "$ROOT/source" \
  --commit "$(git -C "$ROOT/source" rev-parse HEAD)" \
  --output "$ROOT/payload" \
  --node "$NODE22/bin/node" \
  --npm "$NODE22/lib/node_modules/npm/bin/npm-cli.js" \
  --cache "$ROOT/package-cache"
```

Expect JSON `status: "packaged"`, `platform: "linux"`, `arch: "x64"`,
`nodeVersion: "v22.19.0"`, `sourceCommit` = candidateSha.
Native load-check includes `onnxruntime-node` and `@huggingface/transformers`.
If this throws, that is a Linux packaging finding — stop and report it.
Do not fall back to `node cli/home23.js init` in the Scout tree.

### Install / create / prepare / start (only this home)

All Host commands from `/tmp` with PM2 vars unset. Never `pm2 stop all`.
Never use Scout's `~/.pm2`.

```bash
ROOT=/home/box/home23-owned-embedder-test
HOME_ROOT="$ROOT/home"
HOST="$HOME_ROOT/bin/node $HOME_ROOT/app/scripts/product/host.mjs"
# after install, host.mjs lives in the home; first install uses the payload copy:
PAY_HOST="$ROOT/payload/bin/node $ROOT/payload/app/scripts/product/host.mjs"

cd /tmp
env -u PM2_HOME -u PM2_DAEMON_RPC_PORT -u PM2_DAEMON_PUB_PORT \
  $PAY_HOST install --home "$HOME_ROOT" --payload "$ROOT/payload"

cp "$ROOT/source/scripts/embedder/fixtures/public-corpus/"*.txt "$ROOT/import/"

# Chat OAuth is out of scope. ollama-local here is ONLY the Host create
# placeholder so no API key is required. Point it at a dead port so leftover
# chat/Evobrew probes cannot use Keep's :11434. Embeddings are overwritten
# to home23-owned by create. Do not ollama pull. Do not use nomic-embed-text
# as a chat model.
printf '%s\n' '{
  "profile": {
    "name": "ownedembed",
    "ownerName": "GrokBot",
    "homeName": "Owned Embedder Linux Test",
    "purpose": "Isolated owned-encoder proof. Not Scout.",
    "provider": "ollama-local",
    "model": "llama3.2",
    "ingestPaths": [
      {"path": "/home/box/home23-owned-embedder-test/import", "label": "owned-import"}
    ]
  },
  "credential": {
    "provider": "ollama-local",
    "baseUrl": "http://127.0.0.1:1"
  }
}' | env -u PM2_HOME -u PM2_DAEMON_RPC_PORT -u PM2_DAEMON_PUB_PORT \
  $PAY_HOST create --home "$HOME_ROOT"
```

After create, confirm **before** start:

```bash
python3 - <<'PY'
import json, pathlib, yaml
root = pathlib.Path("/home/box/home23-owned-embedder-test/home")
state = json.loads((root/".home23-host.json").read_text())
home = yaml.safe_load((root/"app/config/home.yaml").read_text())
assert state["schema"] == "home23.host.v2"
assert state["encoderRequired"] is True
assert home["embedder"]["owned"] is True
emb = home["embeddings"]["providers"]
assert len(emb) == 1 and emb[0]["provider"] == "home23-owned"
assert "11434" not in emb[0]["endpoint"]
assert home["substrate"]["embedding"]["recipeId"].startswith("12e9f736")
assert home["providers"]["ollama-local"]["baseUrl"].rstrip("/") == "http://127.0.0.1:1"
print("create isolation ok", state["ports"])
PY
```

Do **not** run `semantic-prepare` to completion on the first try. Use §5.

## 3. Owned encoder contract

| Field | Value |
|---|---|
| Profile | `owned-nomic-v1.5-onnx-fp32-mean-noprefix` |
| Recipe id | `12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9` |
| Dimension | 768 |
| Source | `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5` |
| Cache | `$HOME_ROOT/runtime/embedder-cache/nomic-ai/nomic-embed-text-v1.5/` |
| ONNX bytes | 547310275 |
| Attention | `matchFloor: null`, `canSemanticGate: false` — **do not use 0.60** |

Artifact sha256:

| File | sha256 |
|---|---|
| `onnx/model.onnx` | `147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965` |
| `config.json` | `9ab00bd92cee80a569f708140b7b6c1661a65891ff3765b1519e181ba2f2c92b` |
| `tokenizer.json` | `d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66` |
| `tokenizer_config.json` | `d7e0000bcc80134debd2222220427e6bf5fa20a669f40a0d0d1409cc18e0a9bc` |

`GET /ready` (Host header required) after warm:

```json
{
  "warm": true,
  "recipeId": "12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9",
  "profileId": "owned-nomic-v1.5-onnx-fp32-mean-noprefix",
  "dimension": 768,
  "artifactDigests": { "onnx/model.onnx": "147d5aa8…" }
}
```

`/api/tags` is **not** ready. `nomic-embed-text` is **rejected** by the owned
server (`recipe_mismatch`). Official ONNX nomic is **not** Ollama nomic.

## 4. Isolation from host Ollama

Positive evidence required (all of these):

1. `home.embeddings.providers` is only `home23-owned` at `127.0.0.1:<embedder>`.
2. Packaged `ecosystem.config.cjs` `EMBEDDING_BASE_URL` / `SEED_EMBED_ENDPOINT`
   contain that embedder port and do **not** contain `11434`.
3. `GET /ready` on the embedder port is warm with the owned recipe id.
4. Import nodes carry `embedding_recipe_id` = `12e9f736…` and
   `embedding_encoder` = `owned-nomic-v1.5-onnx-fp32-mean-noprefix`.
5. `ss -tpn` / `/proc/<engine-pid>/net` shows the engine talking to the
   embedder port for embeddings. Candidate PIDs must not open `127.0.0.1:11434`
   for `/api/embeddings`.

Controlled owned-service outage (negative control):

```bash
# After ingest+retrieve have already passed once:
EPORT=$(python3 -c 'import json; print(json.load(open("/home/box/home23-owned-embedder-test/home/.home23-host.json"))["ports"]["embedder"])')
PID=$(curl -fsS -H "Host: 127.0.0.1:${EPORT}" "http://127.0.0.1:${EPORT}/ready" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
kill -TERM "$PID"
# /ready must fail; then POST /api/memory/search mode=context
# expect Memory Lite / keyword / missing embedding_recipe_id on NEW writes
```

Memory Lite on that outage is the **documented degraded behavior**.
It is **not** a pass for the gate. Restore with `host.mjs start` and
re-prove owned retrieve.

Chat OAuth is out of scope. Optional chat only if **you** are given an
explicit provider+key in a later note. Do not use Keep Ollama chat models.
Do not pull llama/qwen.

## 5. Interrupt / resume and encoder identity

Do this on the Host path (`semantic-prepare`), not a loose `ensureArtifacts`.

```bash
ROOT=/home/box/home23-owned-embedder-test
HOME_ROOT="$ROOT/home"
HOST="$HOME_ROOT/bin/node $HOME_ROOT/app/scripts/product/host.mjs"
CACHE="$HOME_ROOT/runtime/embedder-cache/nomic-ai/nomic-embed-text-v1.5"
mkdir -p "$CACHE/onnx"
dd if=/dev/zero of="$CACHE/onnx/model.onnx.part" bs=1048576 count=32
# start prepare (returns immediately; worker is detached)
cd /tmp
env -u PM2_HOME -u PM2_DAEMON_RPC_PORT -u PM2_DAEMON_PUB_PORT \
  $HOST semantic-prepare --home "$HOME_ROOT"
# wait until .part is larger than 32MiB
# then SIGTERM workerPid from $HOME_ROOT/runtime/semantic-prep.json
```

Pass observables:

- `host.mjs status` → `semantic.phase` = `interrupted`
- `semantic.error.code` = `host_semantic_interrupted`
- `model.onnx` absent; `.part` kept (not deleted)
- second `semantic-prepare` resumes (`Range` if the server sends 206)
- phase `ready`; ONNX sha `147d5aa8…`; 547310275 bytes
- `host.mjs start` → `status` ready; `/ready` warm; recipe id + dim 768

Fail: `.part` deleted on abort; resume starts at 0 with no Range; `/ready`
reports `nomic-embed-text` or dim ≠ 768.

## 6. Minimal ingest + paraphrased retrieve (Linux entry points)

Supported Linux entry points are Host + dashboard/engine HTTP.
There is no Mac Host UI. Do **not** use `node cli/home23.js` against Scout.

After `host.mjs start` and `/ready` warm, wait until
`$HOME_ROOT/app/instances/ownedembed/brain/state.json.gz` exists.

```bash
DASH=$(python3 -c 'import json; print(json.load(open("/home/box/home23-owned-embedder-test/home/.home23-host.json"))["ports"]["dashboard"])')
EPORT=$(python3 -c 'import json; print(json.load(open("/home/box/home23-owned-embedder-test/home/.home23-host.json"))["ports"]["embedder"])')

# feeder / ingest
curl -fsS "http://127.0.0.1:${DASH}/home23/feeder-status"
# expect the two public-corpus files, pendingCount 0, nodeCount >= 2

# product retrieve — mode=context is required
curl -fsS -H 'content-type: application/json' \
  -d '{"query":"How does sunshine lift moisture that later falls as weather and replenishes hidden reservoirs?","topK":5,"mode":"context"}' \
  "http://127.0.0.1:${DASH}/api/memory/search"
```

Pass:

- hydrologic document ranks above granite (Mac TEST was **0.7111** vs **0.5555**;
  Linux scores may differ; rank order must hold)
- `retrievalMode` is semantic (not Memory Lite keyword-only)
- both import nodes stamped with owned `embedding_recipe_id`
- lexical overlap of the paraphrase vs hydrologic is only weak function words

Fail: keyword tie, `logical-keyword-scan` / Memory Lite as the only result,
missing recipe stamps, or retrieve hitting `:11434`.

Bare `POST /api/memory/search` **without** `mode: "context"` is not this gate.

Optional Seed contact: Host `runtime/host-session.json` refresh + coordination
`POST /api/v1/channels/:id/messages`. Stamp field `semantic_recipe_id` =
`12e9f736…`. Skip if session/channel setup is blocked; report that as a
limitation, not a hidden pass.

## 7. Pass / fail and evidence

Write `$ROOT/receipts/linux-receipt.json`. No conversation text, no owner
names from other homes, no API keys, no Scout paths.

```json
{
  "schema": "home23.embedder-linux-receipt.v1",
  "tester": "grok-bot",
  "sourceSha": "",
  "bundleSha256": "",
  "uname": { "sysname": "Linux", "machine": "x86_64" },
  "debian": "13",
  "boxNode": { "path": "/usr/bin/node", "version": "v20.19.x", "unchanged": true },
  "toolchainNode": { "version": "v22.19.0", "sha256": "c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2" },
  "package": { "ok": false, "packageId": "", "platform": "linux", "arch": "x64" },
  "homeRoot": "/home/box/home23-owned-embedder-test/home",
  "scoutUntouched": null,
  "ports": {},
  "createIsolation": { "encoderRequired": false, "embeddingsOwnedOnly": false, "ollamaChatDeadPort": false },
  "interruptResume": { "attempted": false, "partKept": false, "errorCode": "", "readyAfterResume": false },
  "ready": { "warm": false, "recipeId": "", "dimension": 0, "onnxSha256": "" },
  "ingest": { "files": 0, "nodes": 0, "stampedOwned": 0 },
  "retrieve": { "mode": "", "hydroBeatsGranite": false, "hydroSimilarity": null, "graniteSimilarity": null, "liteOnly": null },
  "ollamaIsolation": { "embeddingUrlHas11434": null, "candidatePidOn11434": null, "ownedOutageDegraded": null, "ownedRecovered": null },
  "stop": { "scopedHostStop": false, "readyAfterStop": null, "scoutStillUp": null },
  "chat": { "attempted": false, "reason": "out of scope unless an explicit provider was supplied" },
  "errors": []
}
```

| Check | Pass | Fail |
|---|---|---|
| Exact SHA | `HEAD` = transfer `candidateSha` | GitHub tip / patched tree |
| Box Node 20.19 | unchanged | apt/nvm replaced Scout runtime |
| Scout / Keep | still up, same Seed | any stop/edit of `/home/box/home23-test` |
| Linux payload | `package.mjs` packaged linux/x64 | used Mac payload or source `init` |
| Isolation | owned endpoint + dead `:1` chat URL | embeddings still 11434 |
| Interrupt | `.part` kept + `host_semantic_interrupted` + resume ready | deleted `.part` / no Range |
| `/ready` | warm, `12e9f736…`, 768 | Ollama tags / Memory Lite as ready |
| Ingest | 2 files, owned stamps | unstamped / Lite-only store |
| Retrieve | context-mode hydro > granite | keyword-only / Lite |
| Outage | Lite **observed**, then owned retrieve restored | Lite treated as success |
| Stop | `host.mjs stop` this home only | `pm2 stop all` / Scout down |

## 8. Stop / restart — this candidate only

```bash
ROOT=/home/box/home23-owned-embedder-test
HOME_ROOT="$ROOT/home"
HOST="$HOME_ROOT/bin/node $HOME_ROOT/app/scripts/product/host.mjs"
cd /tmp
env -u PM2_HOME -u PM2_DAEMON_RPC_PORT -u PM2_DAEMON_PUB_PORT \
  $HOST stop --home "$HOME_ROOT"
# /ready connection refused; Scout still online
env -u PM2_HOME -u PM2_DAEMON_RPC_PORT -u PM2_DAEMON_PUB_PORT \
  $HOST start --home "$HOME_ROOT"
# /ready warm again; recipe id unchanged
```

When idle, leave **this** home stopped. Leave Scout as you found it.

## Known limitations (do not paper over)

- Linux Host packaging is newly opened in this candidate (`ldd` + LICENSE +
  ABI load-check). This Mac session did **not** run `package.mjs` on Debian.
  Grok Bot is the first independent Linux packaging run.
- Native Host UI / Retry-Resume buttons are Mac-only. Linux uses `host.mjs`
  JSON `error.code` (`host_semantic_interrupted` → run `semantic-prepare` again).
- Chat OAuth / Cosmo Setup OAuth are out of scope.
- Owned attention stays null-cal. Do not borrow Ollama 0.60.
- Source `node cli/home23.js init` still defaults to Ollama. It is **not**
  this candidate's lifecycle.
- Existing-home Stage 6 / product default flip remain NO-GO.

## Transfer

This branch is **not on GitHub**. The concrete transfer is a git bundle plus
SHA-256 next to this file's sibling receipt (untracked
`.stage5-handoff/` on the authoring machine). Clone the bundle; detach to
`candidateSha`; do not `git pull`.
