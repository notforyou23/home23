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
| Candidate commit | bundle HEAD — verify `git rev-parse HEAD` equals the transfer receipt `candidateSha` |
| Implementation commit inside it | `112a06e050b0d5561c8bcd35fa00345befeb9f75` |
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

Use these names. Do **not** assign the product home to the shell's `HOME`.
`host.mjs` already sets process `HOME` to `<HOME_ROOT>/runtime/user`.

```bash
H23_ROOT=/home/box/home23-owned-embedder-test
HOME_ROOT="$H23_ROOT/home"    # Host install root — never export HOME=$HOME_ROOT
```

```text
$H23_ROOT/
  source/          # git checkout of candidateSha only
  toolchain/       # official Node 22.19.0 linux-x64 only
  payload/         # output of package.mjs (do not pre-create)
  home/            # HOME_ROOT
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
H23_ROOT=/home/box/home23-owned-embedder-test
HOME_ROOT="$H23_ROOT/home"
mkdir -p "$H23_ROOT/toolchain" "$H23_ROOT/import" "$H23_ROOT/receipts" "$H23_ROOT/package-cache"
cd "$H23_ROOT/toolchain"
curl -fsSLo node-v22.19.0-linux-x64.tar.xz \
  https://nodejs.org/dist/v22.19.0/node-v22.19.0-linux-x64.tar.xz
echo 'c0649af18e6a24f6fe5535a3e86b341dd49a8e71117c8b68bde973ef834f16f2  node-v22.19.0-linux-x64.tar.xz' \
  | sha256sum -c -
tar -xJf node-v22.19.0-linux-x64.tar.xz
test -f "$H23_ROOT/toolchain/node-v22.19.0-linux-x64/LICENSE"
"$H23_ROOT/toolchain/node-v22.19.0-linux-x64/bin/node" -p 'process.version + " " + process.platform + " " + process.arch'
# expect: v22.19.0 linux x64
/usr/bin/node -p process.version
# still  v20.19.x  — fail the gate if this changed
```

### Materialize the exact source

```bash
H23_ROOT=/home/box/home23-owned-embedder-test
# After the transfer archive is unpacked (bundle sits beside TRANSFER.md):
git clone /path/to/unpacked/home23-owned-embedder-<candidateSha>.bundle \
  "$H23_ROOT/source"
git -C "$H23_ROOT/source" switch --detach <candidateSha>
test "$(git -C "$H23_ROOT/source" rev-parse HEAD)" = "<candidateSha>"
test -z "$(git -C "$H23_ROOT/source" status --porcelain --untracked-files=no)"
```

### Build the Linux Host payload

`package.mjs` now accepts Linux when `--node` is official Node 22 matching
`linux`/`x64` and `ldd` shows only system libraries. Run the **script** with
the box Node 20 if you want; the **payload binary** must be the toolchain Node 22.

```bash
H23_ROOT=/home/box/home23-owned-embedder-test
HOME_ROOT="$H23_ROOT/home"
NODE22="$H23_ROOT/toolchain/node-v22.19.0-linux-x64"
# payload directory must not exist yet
cd /tmp
env -u PM2_HOME -u PM2_DAEMON_RPC_PORT -u PM2_DAEMON_PUB_PORT \
  /usr/bin/node "$H23_ROOT/source/scripts/product/package.mjs" \
  --source "$H23_ROOT/source" \
  --commit "$(git -C "$H23_ROOT/source" rev-parse HEAD)" \
  --output "$H23_ROOT/payload" \
  --node "$NODE22/bin/node" \
  --npm "$NODE22/lib/node_modules/npm/bin/npm-cli.js" \
  --cache "$H23_ROOT/package-cache"
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
H23_ROOT=/home/box/home23-owned-embedder-test
HOME_ROOT="$H23_ROOT/home"
HOST="$HOME_ROOT/bin/node $HOME_ROOT/app/scripts/product/host.mjs"
# after install, host.mjs lives in HOME_ROOT; first install uses the payload copy:
PAY_HOST="$H23_ROOT/payload/bin/node $H23_ROOT/payload/app/scripts/product/host.mjs"

cd /tmp
env -u PM2_HOME -u PM2_DAEMON_RPC_PORT -u PM2_DAEMON_PUB_PORT \
  $PAY_HOST install --home "$HOME_ROOT" --payload "$H23_ROOT/payload"

cp "$H23_ROOT/source/scripts/embedder/fixtures/public-corpus/"*.txt "$H23_ROOT/import/"

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
      {"path": "'"$H23_ROOT"'/import", "label": "owned-import"}
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
HOME_ROOT="$H23_ROOT/home" python3 - <<'PY'
import json, os, pathlib, yaml
root = pathlib.Path(os.environ['HOME_ROOT'])
state = json.loads((root/'.home23-host.json').read_text())
home = yaml.safe_load((root/'app/config/home.yaml').read_text())
assert state['schema'] == 'home23.host.v2'
assert state['encoderRequired'] is True
assert home['embedder']['owned'] is True
emb = home['embeddings']['providers']
assert len(emb) == 1 and emb[0]['provider'] == 'home23-owned'
assert '11434' not in emb[0]['endpoint']
assert home['substrate']['embedding']['recipeId'].startswith('12e9f736')
assert home['providers']['ollama-local']['baseUrl'].rstrip('/') == 'http://127.0.0.1:1'
print('create isolation ok', state['ports'])
PY
```

Do **not** run `semantic-prepare` to completion on the first try. Use §5
**before the cache is fully populated.**

## 3. Owned encoder contract

| Field | Value |
|---|---|
| Profile | `owned-nomic-v1.5-onnx-fp32-mean-noprefix` |
| Recipe id | `12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9` |
| Dimension | 768 |
| Source | `https://huggingface.co/nomic-ai/nomic-embed-text-v1.5` |
| Cache | `$HOME_ROOT/runtime/embedder-cache/nomic-ai/nomic-embed-text-v1.5/` |
| ONNX bytes | 547310275 |
| Attention | **Null-cal policy only** (`matchFloor: null`, `canSemanticGate: false`). Measured calibration is unfinished and is **not** this Linux gate. Do not use 0.60. |

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
EPORT=$(HOME_ROOT="$HOME_ROOT" python3 -c 'import json,os; print(json.load(open(os.environ["HOME_ROOT"]+"/.home23-host.json"))["ports"]["embedder"])')
PID=$(curl -fsS -H "Host: 127.0.0.1:${EPORT}" "http://127.0.0.1:${EPORT}/ready" | python3 -c 'import json,sys; print(json.load(sys.stdin)["pid"])')
kill -TERM "$PID"
# /ready must fail; then POST /api/memory/search mode=context
```

Use a query that **appears in the ingested USGS hydrologic file**
(`hydrologic cycle`). The sunshine paraphrase is the **semantic** retrieve
query; it is a weak lexical probe.

On the `be625487` install (Grok Bot PASS, no product patches) this returned
HTTP success with `results=[]`. That was a **missing context-mode keyword
scan**, not intended Memory Lite. Clients that only read `results` cannot
tell outage from a genuine miss; `evidence.fallback.reason` was already
`embedding_unavailable` and `evidence.sourceHealth` was `degraded`.

After the outage-shape follow-up commit, the same lexical query must return
keyword hits **and** `evidence.fallback.reason === "embedding_unavailable"`.
A non-matching query (`obsidian xenolith`) may still be `results=[]` but
must keep that same fallback reason. Memory Lite here is still **degraded**,
not a gate pass. Restore with `host.mjs start` and re-prove owned retrieve.

Chat OAuth is out of scope. Optional chat only if **you** are given an
explicit provider+key in a later note. Do not use Keep Ollama chat models.
Do not pull llama/qwen.

## 5. Interrupt / resume and encoder identity

Do this on the Host path (`semantic-prepare`), **after create and before start**,
while the candidate cache is still empty. Do **not** seed `model.onnx.part`
with zeros or copy a finished ONNX. That is not a download interruption.

Resume vs discard:

- **Resume** (this test): abort / SIGTERM / network leave a **genuine** `.part`
  of bytes the worker actually fetched. A later `semantic-prepare` sends
  `Range: bytes=<existing>-`. Pass if the part grows from that size (206) or
  the server ignores Range and the worker replaces the part from byte 0
  *after* you recorded a non-zero genuine partial. The final published
  `model.onnx` must match sha `147d5aa8…`.
- **Discard / restart** (not this test): a finished file or `.part` whose
  digest is wrong is `bad_artifact`. Host **deletes** that `.part` and starts
  over. Do not treat a deleted corrupt part as resume evidence.

```bash
H23_ROOT=/home/box/home23-owned-embedder-test
HOME_ROOT="$H23_ROOT/home"
HOST="$HOME_ROOT/bin/node $HOME_ROOT/app/scripts/product/host.mjs"
CACHE="$HOME_ROOT/runtime/embedder-cache/nomic-ai/nomic-embed-text-v1.5"
PART="$CACHE/onnx/model.onnx.part"
ONNX="$CACHE/onnx/model.onnx"
PREP="$HOME_ROOT/runtime/semantic-prep.json"
export PART ONNX PREP

# Empty cache — fail if a previous run already published the model.
test ! -e "$ONNX"
test ! -e "$PART"
# tokenizer/config may appear as the worker starts; ONNX must still be absent.

cd /tmp
env -u PM2_HOME -u PM2_DAEMON_RPC_PORT -u PM2_DAEMON_PUB_PORT \
  $HOST semantic-prepare --home "$HOME_ROOT"

# Observe real downloaded bytes (Host bytesReceived and/or $PART size).
# Wait until $PART exists and is larger than 8MiB, then interrupt.
# Do not wait until 547310275 or until phase=ready.
while true; do
  if [ -f "$PART" ]; then
    SIZE=$(wc -c < "$PART")
    if [ "$SIZE" -gt 8388608 ]; then break; fi
  fi
  sleep 1
done
SIZE_BEFORE=$(wc -c < "$PART")
# Genuine partial: not an all-zero seed. Sample must contain a non-zero byte.
python3 -c 'import os,sys; p=os.environ["PART"]; d=open(p,"rb").read(65536); sys.exit(0 if any(d) else 1)' 
WORKER=$(python3 -c 'import json,os; print(json.load(open(os.environ["PREP"]))["workerPid"])')
kill -TERM "$WORKER"

env -u PM2_HOME -u PM2_DAEMON_RPC_PORT -u PM2_DAEMON_PUB_PORT \
  $HOST status --home "$HOME_ROOT"
# expect semantic.phase=interrupted, error.code=host_semantic_interrupted
test -f "$PART"
test ! -e "$ONNX"
SIZE_AFTER=$(wc -c < "$PART")
# .part kept (size >= size at interrupt). Record SIZE_BEFORE, SIZE_AFTER.

# Resume the same genuine partial — do not rm $PART.
env -u PM2_HOME -u PM2_DAEMON_RPC_PORT -u PM2_DAEMON_PUB_PORT \
  $HOST semantic-prepare --home "$HOME_ROOT"
# wait until phase=ready (status poll). Then:
test -f "$ONNX"
test ! -e "$PART"
python3 -c 'import hashlib,os; p=os.environ["ONNX"]; h=hashlib.sha256(open(p,"rb").read()).hexdigest(); assert h=="147d5aa88c2101237358e17796cf3a227cead1ec304ec34b465bb08e9d952965", h; print(h, os.path.getsize(p))'
```

Export `PART`, `PREP`, and `ONNX` for those python snippets (`export PART PREP ONNX`).

Pass observables:

- first prepare started from an empty ONNX cache
- `.part` grew with downloaded bytes **before** interrupt
- interrupt → `host_semantic_interrupted`; genuine `.part` kept; `model.onnx` absent
- second prepare reaches `ready`; ONNX sha `147d5aa8…`; 547310275 bytes
- `host.mjs start` → ready; `/ready` warm; recipe id + dim 768

Fail: zero-filled seed; interrupt after the cache is already complete;
`.part` deleted on abort (unless you first proved `bad_artifact` separately);
final digest mismatch; `/ready` reports `nomic-embed-text` or dim ≠ 768.

## 6. Minimal ingest + paraphrased retrieve (Linux entry points)

Supported Linux entry points are Host + dashboard/engine HTTP.
There is no Mac Host UI. Do **not** use `node cli/home23.js` against Scout.

After `host.mjs start` and `/ready` warm, wait until
`$HOME_ROOT/app/instances/ownedembed/brain/state.json.gz` exists.

```bash
DASH=$(HOME_ROOT="$HOME_ROOT" python3 -c 'import json,os; print(json.load(open(os.environ["HOME_ROOT"]+"/.home23-host.json"))["ports"]["dashboard"])')
EPORT=$(HOME_ROOT="$HOME_ROOT" python3 -c 'import json,os; print(json.load(open(os.environ["HOME_ROOT"]+"/.home23-host.json"))["ports"]["embedder"])')

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

Write `$H23_ROOT/receipts/linux-receipt.json`. No conversation text, no owner
names from other homes, no API keys, no Scout paths. Use `HOME_ROOT` in the
receipt, not the shell `HOME`.

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
  "homeRoot": "$HOME_ROOT",
  "scoutUntouched": null,
  "ports": {},
  "createIsolation": { "encoderRequired": false, "embeddingsOwnedOnly": false, "ollamaChatDeadPort": false },
  "interruptResume": {
    "attempted": false,
    "emptyCacheAtStart": false,
    "observedPartBytes": 0,
    "genuinePartial": false,
    "partKept": false,
    "errorCode": "",
    "resumedNotBadArtifactDiscard": false,
    "readyAfterResume": false
  },
  "attention": { "policy": "null-cal", "measuredCalibration": false, "notALinuxGate": true },
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
| Interrupt | empty cache → genuine `.part` grew → interrupt → kept → resume ready + digest | zero seed / already-complete cache / `bad_artifact` discard treated as resume |
| `/ready` | warm, `12e9f736…`, 768 | Ollama tags / Memory Lite as ready |
| Ingest | 2 files, owned stamps | unstamped / Lite-only store |
| Retrieve | context-mode hydro > granite | keyword-only / Lite |
| Outage | `/ready` down; lexical `hydrologic cycle` returns keyword hits + `evidence.fallback.reason=embedding_unavailable` + `sourceHealth=degraded`; then owned retrieve restored | `results=[]` on a lexical hit, or Lite treated as a success gate |
| Stop | `host.mjs stop` this home only | `pm2 stop all` / Scout down |

## 8. Stop / restart — this candidate only

```bash
H23_ROOT=/home/box/home23-owned-embedder-test
HOME_ROOT="$H23_ROOT/home"
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
- Owned attention is a **null-cal policy**, not a measured calibration.
  Measured owned match-floor work remains unfinished and does **not** block
  this Linux embedding/retrieval gate. Do not borrow Ollama 0.60.
- Source `node cli/home23.js init` still defaults to Ollama. It is **not**
  this candidate's lifecycle.
- Existing-home Stage 6 / product default flip remain NO-GO.

## Follow-up for Grok Bot (do not repeat the install)

Grok Bot already **PASSED** the isolated Linux gate at
`be6254879fc8c22a6265e6010ac0284f70f4329b`
(archive `236dae38…`, bundle `1ac7adf9…`). Preserve those receipts.
Do **not** re-run `package.mjs`, create, interrupt/resume, ingest, or the
first semantic retrieve unless a later note says the existing home was
destroyed.

Repeat only:

1. **Source unit tests** on the follow-up SHA (not `be625487`):

   ```bash
   node --test --test-concurrency=1 \
     tests/engine/dashboard/memory-search.test.js \
     tests/engine/core/openai-client-embedding-url.test.cjs \
     tests/cli/owned-embedding-ecosystem.test.js
   ```

2. **Optional live outage retest** on the existing stopped home, only if
   `host.mjs start` still accepts the packaged tree after copying
   `engine/src/dashboard/memory-search.js` onto
   `$HOME_ROOT/app/engine/src/dashboard/memory-search.js`.
   Do not create another home. If Start refuses an overlay, stop and
   report that; the unit tests remain the required check.

   Lexical outage query: `hydrologic cycle`  
   Non-match outage query: `obsidian xenolith`  
   Semantic retrieve (encoder back up): the sunshine paraphrase.

   Expect: outage + lexical hit → keyword rows +
   `evidence.fallback.reason=embedding_unavailable` +
   `evidence.sourceHealth=degraded`.  
   Outage + non-match → `results=[]` + the same fallback reason.  
   Encoder up + non-match → `results=[]` and fallback reason is **not**
   `embedding_unavailable`. Then `host.mjs start` if needed and confirm
   hydro still beats granite.

3. **Ollama literal:** the generated file may still contain
   `|| 'http://127.0.0.1:11434'` for `ollamaLocalUrl` (chat / classic
   homes). Live owned `EMBEDDING_BASE_URL` / `SEED_EMBED_ENDPOINT` must
   stay on the owned port. Do not expect the generator source string to
   disappear. Do not stop Scout or host Ollama `:11434`.

Keep measured attention calibration unfinished. Do not start Stage 6.

## Transfer

This branch is **not on GitHub**. The concrete transfer is one archive whose
payload includes the git bundle and a `.sha256` file that names **only the
bundle basename** so `sha256sum -c` works after copy. Clone the bundle;
detach to `candidateSha`; do not `git pull`.
