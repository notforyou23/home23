# Owned embedder — consolidated candidate status

Date: 2026-09-11  
This board identifies revisions and evidence. The current lead is Codex, which
has taken over local correction and consolidation at the owner’s request.
Publication, installation and live transitions remain separate actions; this
record does not grant or narrow the owner’s authorization.

## September 12 integrated Mac candidate

The owner requested one integrated, installable Mac candidate. Codex owns this
milestone through package verification and return to maintained source.

- Backend `0b5fb604f37f02b33b8bfa7ff2d2e1761b2a1244` merges candidate
  `7223d855` into current local main, preserving the later chat/attachment work.
- Apple `f9adcbfba6115c149bf3caa098ccf7d48a7e67c7` merges Host `9cc694df`
  into current local main, preserving the current native chat work.
- Both are integrated into local main and the maintained development checkouts.
- Runtime package `7f07d020b35e150bf478a7c40d6a15e07f477341c47fadb904f3c1bf6be59075`
  was built from that backend SHA with official Node 22.23.2, darwin/arm64.
- The full Host bundle contains that exact payload. Native Host command checks,
  copied-payload integrity and local ad-hoc signing passed. The matching native
  Mac client Release build passed and is development-signed as build 151.
- Combined backend checks: 322 passed, one optional PM2 fixture skipped.
  Contracts: 71 passed, two skipped. The first source test run lacked compiled
  `dist`; after providing the exact packaged build, the affected Host suite
  passed (29 passed, one skipped). The other source suites were not rerun.

The first exact-artifact native trial installed successfully, created its own
resident and Seed, downloaded verified artifacts from an empty cache, and warmed
preparation. Its first Start failed: the encoder's cold launch became warm after
about 32 seconds, beyond the backend's 30-second wait. The trial was stopped and
its private supervisor terminated; its state and failure receipt are retained.
This is not passing installed acceptance.

Backend `a12ffcb3` raises the bounded encoder wait to 90 seconds. Apple
`cf33bec7` allows 300 seconds for native Start, covering payload verification,
encoder startup and resident readiness. Neither timeout is an I/O preemption
guarantee. The corrected package and its installed acceptance supersede the
first artifact only when their own receipts pass.

Private package, signing, test and installation receipts belong in the development
verification area under `integrated-mac-candidate-20260912`. Native installed-home
verification is tracked there separately from compilation. These are developer
artifacts, not a notarized public release. Measured attention remains null-cal;
existing homes retain their embedding provider. Nothing has been pushed or
activated in the owner's live installation by this milestone.

The following sections preserve the earlier evidence at its original revisions.
Their old Mac trial and Linux home are not silently upgraded by this candidate.

## Earlier revisions

| Layer | Repository | SHA | Role |
|---|---|---|---|
| Backend branch | home23 `home23-agent/owned-embedder-stage5-verify` | see rows below | Local only; not on GitHub |
| Linux **installed** artifact | same | `be6254879fc8c22a6265e6010ac0284f70f4329b` | Grok Bot Host payload / home. Do not replace. |
| Source follow-up (outage shape) | same | `1905b5798b6d1a49252f715d9a5cd55c6697b054` | Includes `309f565f`. Grok Bot Node 22 reported pass. Not installed. |
| Source follow-up (scan budget) | same | `5e567a8f0bd0cceaf1e40f5edae81c69f844aef1` | Bounded context-outage scan. Grok Bot 65/2. Not installed. |
| Source follow-up (cancel + wording) | same | `2ce5bda5b87f17d73bb9f1a5129fa143e363bc32` | Historical unsafe forced-close implementation; corrected in the current candidate. Per-call signal forwarding retained. Not installed. |
| Descriptor ownership correction | same | `baa7e393` | Retains per-call cancellation; removes forced/double closure. 158 local Node 22 tests pass; not installed. |
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

Follow-up `2ce5bda5` forwarded the per-call signal but introduced forced
numeric-fd closure alongside FileHandle closure. Independent review reproduced
a descriptor reuse bug: the later FileHandle close could close an unrelated file.
Its claim that closing an fd interrupts Linux kernel I/O was also incorrect.

The September 11 local correction keeps per-call signal composition and returns
to the existing single-owner FileHandle pattern. Abort destroys the streams;
cleanup waits for outstanding reads, then closes owned handles exactly once.
Borrowed pins stay open for their caller. There is no `/dev/fd` reopening,
forced `closeSync`, suppressed double-close, or abandoned scan.

**Effective guarantee:** cancellation stops consumption and propagates its
reason; resource cleanup waits for I/O to quiesce. Neither a caller deadline
nor the 1500 ms cooperative scan check is a hard kernel-I/O completion limit.
An OS read or current inflate work may outlast it. That limitation is retained
explicitly rather than traded for unsafe descriptor reuse.

Regression tests deterministically cover an outstanding read during abort and
an unrelated descriptor taking the old number. Both failed with `EBADF` against
`c738ddc5` and pass after correction. Existing per-call cancellation and borrowed
pin tests remain part of the verification.

## Current local verification and ownership

Codex completed the descriptor correction in `baa7e393` and owns consolidation.
The correction returns to the existing non-closing stream adapter; FileHandles
close only after stream cleanup. Current source has no forced `/dev/fd` reopen.

On macOS with Node **22.19.0** and matching native dependencies:

| Coverage | Result |
|---|---|
| Memory-source contracts, reader, JSONL and pin suites | **86 pass / 0 fail** |
| Memory-search, embedding URL and owned ecosystem suites | **72 pass / 0 fail** |
| Newly added pending-read and descriptor-reuse regressions | Failed on the prior implementation, pass after correction |
| Documented shell blocks | Syntax checked; Linux rebuild instructions not executed on this Mac |

The initial local reader run picked up a Node 25 SQLite binary from parent
source dependencies. The original quota-publication assertion then failed before
validating source contents. With matching Node 22 SQLite, the **unchanged** quota
assertion and complete reader suite pass. No product or test weakening was kept.
The local native ANN-worker cases also pass; this is not a Linux rebuild receipt.
Private logs are retained in the development verification area under
`owned-embedder-review-20260911`.

The candidate follow-up consists only of the correction and these documentation
updates; integration preserves the prior unrelated dirty work. The maintained
product branch, installed Linux `be625487` and Mac test payload are not advanced by
this source correction. Existing archives retain their original identities.

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
- The earlier Mac TEST is **not** an exact artifact of `be625487` or later
  follow-ups. Overlay is not an acceptable trial. The September 12 owner request
  authorizes the integrated candidate build and its isolated verification;
  that milestone is recorded above. It does not authorize overwriting the
  earlier home or an existing-home migration.

**Other.** Stage 6 / default flip NO-GO. Source `init` still defaults to
Ollama. Chat OAuth out of Linux scope. `4000` / cooperative `1500ms` are a
responsiveness policy, not a measured large-home calibration.

## Consolidation and next verification

The lead owns local correction, evidence reconciliation and return to the
candidate branch. Do not ask the owner to relay each intermediate fix. Linux
reports above remain reports at their exact revisions, not proof of the current
source or a new installation. The source-only addon procedure now pins PATH as
well as the executable and checks the installed version against the lockfile.
See `2026-09-11-owned-embedder-source-node22-hnswlib.md`.

After local checks and integration, retain one final candidate identity for the
next independent review or exact-artifact trial. Do not rerun installation merely
to obtain a newer receipt, and do not treat local Mac native tests as a Linux
addon-rebuild receipt.
