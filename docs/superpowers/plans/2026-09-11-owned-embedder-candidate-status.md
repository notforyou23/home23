# Owned embedder — consolidated candidate status

Date: 2026-09-11  
This board identifies revisions and evidence. It does not authorize push,
install, deploy, Stage 6, or measured attention calibration.

## Revisions

| Layer | Repository | SHA | Role |
|---|---|---|---|
| Backend branch | home23 `home23-agent/owned-embedder-stage5-verify` | see rows below | Local only; not on GitHub |
| Linux **installed** artifact | same | `be6254879fc8c22a6265e6010ac0284f70f4329b` | Grok Bot Host payload / home. Do not replace. |
| Source follow-up (outage shape) | same | `1905b5798b6d1a49252f715d9a5cd55c6697b054` | Includes `309f565f`. Grok Bot Node 22 reported pass. Not installed. |
| Source follow-up (scan budget) | same | `5e567a8f0bd0cceaf1e40f5edae81c69f844aef1` | Bounded context-outage scan. Grok Bot 65/2. Not installed. |
| Source follow-up (cancel + wording) | same | `2ce5bda5b87f17d73bb9f1a5129fa143e363bc32` | Per-call abort closes a dup’d read fd. Not installed. |
| Implementation inside `be625487` | same | `112a06e050b0d5561c8bcd35fa00345befeb9f75` | Linux package path, structured Host errors, fixtures |
| Download resume | same | `7066b9ad` | Keep `.part` on abort |
| Stop names | same | `71ee0ff1` | Source only on Mac TEST packaged copies |
| Apple Host | home23-apple `home23-apple-agent/owned-embedder-host-stage4` | `9cc694dfd08ef0f8344374dd99b24b7eb3526af6` | Retry vs Resume; **outside** the Linux gate |

Live Jerry (`/Users/jtr/_JTR23_/release/home23`) still embeds with Ollama
`nomic-embed-text` on `:11434`. Mac TEST `.stage5-product-home` is stopped
when idle (owned ONNX `:32591` when started). Scout `/home/box/home23-test`
is untouched.

## Installed evidence — `be625487`

Grok Bot isolated Linux gate: **PASS**, no product patches.

| Item | Value |
|---|---|
| Archive | `236dae381a0f290a190ee7a8f6a7ae040870d315f974797aa473baba20ba7e46` |
| Install bundle | `1ac7adf9972e99fe83b0ea251dd60909935fb6b41e281f62ffa0543c3f23923d` |
| Root | `/home/box/home23-owned-embedder-test` |
| Seed | `seed_mtx5jbb6_f4ff5c72` (held across stop/restart) |
| Retrieve | context-mode hydro **0.7111** > granite **0.5555**, `semantic-ann` |
| Receipts | `receipts/linux-receipt.json`, `FINDINGS.md` |

Unpatched findings at that revision: context outage returned `results=[]`;
generated `ecosystem.config.cjs` still contains the `11434` source literal
while live embed env was the owned port (`:21495`, 0 ss hits on `:11434`).

Do not repeat package / create / interrupt / ingest / first retrieve.

## Independent source verification — `1905b579`

Transfer: `home23-owned-embedder-be625487-to-1905b579.bundle`
(`88c4d114f1424b5cdb9f6c0d4ac77a3ecd6c5a983a5fdd0ec2fd14a01dac3a71`).
Prerequisite: existing `be625487` source checkout.

`309f565f` restores context-mode keyword fallback on encoder outage and
fail-closes owned-empty `EMBEDDING_BASE_URL` so it does not inherit
`:11434`. Classic Ollama homes keep the 11434 default.

**Independent verification (Grok Bot, private Node 22):** `62 + 2 + 3`
passed — `memory-search.test.js`, `openai-client-embedding-url.test.cjs`,
`owned-embedding-ecosystem.test.js`. That report is the independent
source check. It is not a new installed home. Installed artifact stays
`be625487`.

**Receipt location:**
`/home/box/home23-owned-embedder-test/receipts/followup-1905b579/summary.json`
on the Linux box. This worktree does **not** yet contain a copy of that
receipt. Absence here is not a reason to rerun those checks.

Local Mac suites at the same revision were also green. They are author
evidence, not the independent verification.

## Source evidence — `5e567a8f`

Transfer: `home23-owned-embedder-1905b579-to-5e567a8f.bundle`
(`7406edc363f7c657e520758c6d9e6c84221935bb54f16341d6dde13e7cbcc71b`).
Upload archive SHA lives beside
`home23-owned-embedder-5e567a8f-followup.tar.gz`, not inside this record.
Fetched onto prerequisite `1905b579`. Source `node_modules` kept (not
reset). Installed home still **`be625487`**, stopped. Scout/Ollama
untouched. No product patches.

Context-outage keyword scan is visit-bounded (4000) and has a
**cooperative** 1500 ms check after each yielded node. That check is not a
hard mid-await ceiling. A slow gzip/jsonl chunk can overrun before the next
sample. Budget exhaustion returns hits already found plus
`completeness=incomplete`, `completeCoverage=false`, `sourceHealth=degraded`,
and `fallback.scan`. Abort still throws. Default search and context-fast
ANN-miss unchanged.

**Independent verification (Grok Bot, private Node 22.19.0):**
`memory-search.test.js` **65 pass / 2 fail**.

- Budget/outage cases passed (early incomplete hit, default full walk,
  deadline exhaust, cancel-still-aborts).
- Failures 57–58 (isolated ANN worker): missing `hnswlib-node` native
  `addon.node` from the earlier `npm install --ignore-scripts`. Env gap, not
  the budget commit. **Not passing verification.** Do not rebuild natives
  into the installed home or payload.
- Bounded-fallback inspection agreed: deadline does not include wait for the
  next read; exhaustion closes the iterator; partial-result evidence is
  accurate; caller abort still throws.

**Receipt location:**
`/home/box/home23-owned-embedder-test/receipts/followup-5e567a8f/`
on the Linux box. This worktree does **not** yet contain a copy. Do not
rerun the 65/2 suite merely because that copy is absent.

Local author evidence at this revision: on-disk 301-node fixtures;
`memory-search.test.js` **67 pass** where `hnswlib-node` already loaded.
See `2026-09-11-owned-embedder-context-outage-scan-budget.md`.

Live outage on a newly packaged install: **not** verified. Large-brain
wall-clock: still **unproven**.

## Caller cancellation (after `5e567a8f`)

At `5e567a8f`, `iterateNodes({ signal })` ignored the per-call signal.
`readJsonl` already destroyed streams on abort, but `ReadStream.destroy()`
waits for an in-flight positioned read, and the FileHandle fd was shared
with borrowed pins.

Follow-up `2ce5bda5` on this branch:

- Forwards the per-call signal (composed with any open-time signal).
- Dups the FileHandle fd for the stream. Abort closes that dup, then
  destroys the streams, then the same generator `finally` releases owned
  handles. Borrowed pin handles stay with their owner.
- Does **not** `Promise.race` a second waiter that would abandon the scan.

**Effective guarantee:** caller abort unblocks a pending positioned disk
read and then releases stream/owned-handle resources. It does not preempt
CPU already spent inflating the current gzip chunk. The 1500 ms outage
deadline still does not abort the signal; it only stops after the next
yield.

## Remaining gaps

**Measured attention.** Null-cal policy only (`matchFloor` / `matchMargin`
null). Do not borrow Ollama 0.60/0.12. Unfinished. Not a Linux embed/retrieve
blocker. See `2026-09-11-owned-embedder-owned-attention-calibration.md`.

**Native Mac acceptance.**

- Retry vs Resume UI is at Apple `9cc694df` (HostCommandTests passed there).
  Not a Linux gate.
- Latest Stop (`71ee0ff1`) is **not** on the packaged Mac TEST copies (D08 /
  no second home).
- Host-path interrupt/resume on Mac used an overlay; restored payload
  Start/Stop of `d8f45ba3` copies worked after revert.
- Existing Mac TEST is **not** an exact artifact of `be625487` or later
  follow-ups. Overlay is not an acceptable trial. Do not create another Mac
  TEST home until authorized. Proposed exact-artifact trial: package the
  chosen backend SHA for darwin/arm64 with Host `package.mjs`, then install
  only onto a home that can take that `packageId` (D08 or a later-authorized
  isolated home). Not authorized now. Do not build or install yet.

**Other.** Stage 6 / default flip NO-GO. Source `init` still defaults to
Ollama. Chat OAuth out of Linux scope. `4000` / cooperative `1500ms` are a
responsiveness policy, not a measured large-home calibration.

## Grok Bot next (source only)

Rebuild `hnswlib-node` in `$H23_ROOT/source` with private Node 22 and the
candidate lockfile, then repeat only the two isolated ANN-worker tests.
Procedure: `2026-09-11-owned-embedder-source-node22-hnswlib.md`.
Do not launch another installation or a broad performance campaign.
