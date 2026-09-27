# Household Vibe

Home23 owns the household Vibe as a scheduled resident turn. The Family website
and Apple Family dashboard read the same published result through the existing
Family service endpoints. That service supplies household context and edits the
existing family notes and preferences; it does not independently generate text
when Home23 ownership is configured.

## Resident publication

An install-local `config/home-vibe.json` enables the feature for one resident.
It contains `enabled`, `authorAgent`, `authorName`, the local HTTP `contextURL`,
and `generationIntervalMs`. The Family service's preview response supplies
`systemPrompt`, `userPrompt`, and an optional `sourceUpdatedAt`. This editorial
brief is passed to the normal resident AgentLoop, retaining resident identity,
memory, Seed, and current world context. It does not replace the system prompt.

The existing cron scheduler owns `home-vibe-jerry`. It uses an isolated fresh
turn, no chat delivery, and no completion push. Successful publication writes
`instances/<resident>/workspace/home-vibe/feed.json` atomically, verifies its
contents, and records an execution outcome. The feed carries author, turn,
run, publication time, and a bounded history. Publishing verifies that the
resident's completed text reached the feed; it does not verify every statement
in the text. Failure retains the previous successful text and timestamp and
marks the feed stale with the failed attempt.

An install-local `refreshToken` authorizes `POST /api/home-vibe/refresh` on the
resident bridge. This runs the same job and waits for publication; it is not a
second generator. Keep the token private. Existing disabled/custom job state
survives restart. The feature is inactive in homes without enabled config.

## Family service integration

The Family service opts in with `HOME23_VIBE_FEED_PATH`,
`HOME23_VIBE_CONFIG_PATH`, and `HOME23_VIBE_AUTHOR_NAME`. Its config reader also
uses the optional local `refreshURL` from `home-vibe.json`. The existing
`COSMO_VIBE_DATA_PATH` can point to Home-owned `config/home-vibe-context.json`,
preserving family profiles, authored notes, personality preferences, and old
history byte-for-byte during migration. Both Home Vibe configuration files are
private home state: product updates preserve them and distributable packages
must exclude them. Old Cosmo entries retain their author.

`/api/dashboard/state` and `/api/cosmo/insight/latest` retain their compatibility
paths while serving the same Home23 feed. Manual Generate forwards to the
resident refresh route. The Family service still refreshes weather, calendar,
and other household context on its existing cadence. It no longer schedules
model generation in managed mode. Provider selection belongs to the resident.

Clients use `data.authorName` for authorship and successful publication time
for age. Retained text is explicitly stale when a refresh fails or its scheduled
interval passes. Absence of a new publication never advances its timestamp.
Standalone Cosmo23 is independent and is not modified by this integration.
