# Owned embedder — consolidated candidate status

Date: 2026-09-11  
This board identifies revisions and evidence. It does not authorize push,
install, deploy, Stage 6, or measured attention calibration.

## Revisions

| Layer | Repository | SHA | Role |
|---|---|---|---|
| Backend branch | home23 `home23-agent/owned-embedder-stage5-verify` | see rows below | Local only; not on GitHub |
| Linux **installed** artifact | same | `be6254879fc8c22a6265e6010ac0284f70f4329b` | Grok Bot Host payload / home. Do not replace. |
| Source follow-up (outage shape) | same | `1905b5798b6d1a49252f715d9a5cd55c6697b054` | Includes `309f565f`. Independent source tests. Not installed. |
| Source follow-up (scan budget) | same | `5e567a8f0bd0cceaf1e40f5edae81c69f844aef1` | Bounded context-outage scan. Not installed. |
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

Local Mac source tests at that follow-up: memory-search, embedding-URL, and
owned-ecosystem suites green. This worktree has **no Grok Bot Linux Node 22
receipt** for `1905b579`. That checkout is the assigned independent
verification revision for those tests, not a new installed home.

## New source evidence — `5e567a8f`

Transfer: `home23-owned-embedder-1905b579-to-5e567a8f.bundle`
(`7406edc363f7c657e520758c6d9e6c84221935bb54f16341d6dde13e7cbcc71b`).
Prerequisite: source at `1905b579`. Installed home stays `be625487`.
The upload archive SHA lives beside
`home23-owned-embedder-5e567a8f-followup.tar.gz`, not inside this record.

Context-outage keyword scan is visit- and deadline-bounded (4000 visits /
1500 ms). Budget exhaustion returns hits already found plus
`completeness=incomplete`, `completeCoverage=false`, `sourceHealth=degraded`,
and `fallback.scan`. Abort still throws. Default search and context-fast
ANN-miss unchanged.

Local evidence: on-disk 301-node fixtures (not the two-document Linux home);
full `tests/engine/dashboard/memory-search.test.js` **67 pass**.
See `2026-09-11-owned-embedder-context-outage-scan-budget.md`.

Grok Bot repeats that suite on private Node 22 after fetching this bundle.

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
- Do not create another Mac TEST home.

**Other.** Stage 6 / default flip NO-GO. Source `init` still defaults to
Ollama. Chat OAuth out of Linux scope. `4000` / `1500ms` are a
responsiveness policy, not a measured large-home calibration.
