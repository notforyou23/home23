# Legacy Feeder Coverage Audit

Date: 2026-04-17
Scope: compare legacy `cosmo23-jtr-feeder` inputs against current Home23 feeder coverage

## Goal

Determine whether the old 2.3 feeder can be frozen without losing:

- incoming documents
- session summaries
- daily memory files
- any still-useful drop inputs

## Sources Checked

- Legacy feeder config:
  `/Users/jtr/_JTR23_/cosmo-home_2.3/feeder/feeder.yaml`
- Home23 feeder config:
  `/Users/jtr/_JTR23_/release/home23/configs/base-engine.yaml`
- Legacy feeder manifests:
  - `/Users/jtr/_JTR23_/cosmo-home_2.3/feeder/manifest.json`
  - `/Users/jtr/_JTR23_/cosmo-home_2.3/feeder/manifest-jtr.json`

## Legacy vs Home23 Coverage Matrix

| Legacy path | Legacy glob | Exists | Activity observed | Covered by Home23 now? | Recommendation |
|---|---|---:|---|---|---|
| `/Users/jtr/jtrbrain-feed` | `**/*` | yes | directory exists but currently `0` files | No | Optional add. Not urgent now because it is empty, but add if you want to preserve this drop path as a future habit. |
| `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory/sessions` | `*.md` | yes | `180` markdown files; latest legacy session file dated `2026-04-11` | No | Do not freeze old feeder until these are either ingested once into Home23 or intentionally archived. |
| `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory` daily files | `202*-*-*.md` | yes | `77` matching files; latest file `2026-04-17.md` | No | This is an active gap. Home23 should explicitly cover this path if you still want that memory stream feeding Jerry. |
| `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory` reflections | `reflection-*.md` | yes | `3` reflection files | No | Cover alongside the daily files, same root. |

## Key Findings

### 1. The feeder gap is larger than originally thought

The original concern was mostly `jtrbrain-feed` and legacy session summaries.
The bigger issue is that the old 2.3 memory root is still live and still changing:

- `2026-04-17.md`
- `2026-04-16.md`
- `2026-04-15.md`
- `2026-04-14.md`
- `2026-04-13.md`

Home23 is **not** currently watching that path.

### 2. `jtrbrain-feed` is empty right now

This means it is not an immediate data-loss source today.
It is still a path-design question:

- preserve it as a future dropbox, or
- retire it intentionally

Because it currently has zero files, it is not the blocking issue.

### 3. Legacy sessions are separate from Jerry's current sessions

Comparison results:

- legacy 2.3 session markdown files: `180`
- current Jerry workspace session files: `84`
- shared filenames: `0`

That means the old sessions are not just duplicates of the current Home23 session stream.

### 4. Overlapping daily filenames are not duplicates

The two memory streams share filenames for:

- `2026-04-12.md`
- `2026-04-13.md`
- `2026-04-14.md`
- `2026-04-15.md`
- `2026-04-16.md`
- `2026-04-17.md`

But file hashes and sizes differ.
These are distinct documents, not mirrored copies.

So freezing the old feeder now would cut off a separate active memory stream.

## Current Home23 Feeder Coverage

Home23 currently watches:

- `/Users/jtr/_JTR23_/cosmo-home_2.3/projects`
- `/Users/jtr/life/`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/sessions`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/projects`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/reports`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/jtr`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/memory`
- `/Users/jtr/_JTR23_/release/home23/instances/jerry/workspace/cron`

Important:
- `/Users/jtr/life/` is broad, but it does **not** replace the old 2.3 workspace memory path.
- The old 2.3 workspace memory path is a separate, uncovered feed.

## Recommendation

### Minimum additions before considering a freeze

Add these to Home23 feeder coverage:

1. `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory`
   label: `legacy_cosmo23_memory`

2. `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory/sessions`
   label: `legacy_cosmo23_sessions`

### Optional addition

3. `/Users/jtr/jtrbrain-feed`
   label: `legacy_jtrbrain_feed`

This third one is optional because it is empty today.

## Suggested Config Block

This is the exact shape to add under `feeder.additionalWatchPaths` in
`configs/base-engine.yaml`:

```yaml
    - path: /Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory
      label: legacy_cosmo23_memory
    - path: /Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory/sessions
      label: legacy_cosmo23_sessions
    - path: /Users/jtr/jtrbrain-feed
      label: legacy_jtrbrain_feed
```

## Verification Method

Do this before freezing `cosmo23-jtr-feeder`:

1. Add the new Home23 feeder watch paths.
2. Restart only the specific Home23 engine process if required.
3. Drop one test markdown file into each of these:
   - `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory/`
   - `/Users/jtr/_JTR23_/cosmo-home_2.3/workspace/memory/sessions/`
   - `/Users/jtr/jtrbrain-feed/` if you decide to preserve it
4. Confirm the Home23 feeder sees and processes all test files.
5. Only then is `cosmo23-jtr-feeder` a real freeze candidate.

## Bottom Line

`cosmo23-jtr-feeder` is **not** freeze-ready.

Blockers:
- active legacy daily memory stream not covered
- legacy session corpus not covered
- optional legacy drop path undecided

The shortest safe path forward is:

1. extend Home23 feeder coverage
2. prove ingestion on the new paths
3. then revisit freezing the old feeder
