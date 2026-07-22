# COSMO23 Parity Phase 2 — Live Proof Receipt (2026-07-22)

**Program:** docs/superpowers/specs/2026-07-21-cosmo23-parity-program-design.md, Phase 2
**Plan:** docs/superpowers/plans/2026-07-22-cosmo23-parity-phase2.md, Task 9
**Commits under proof:** ab22e846 → cd23e6e4 (16 Phase 2 commits on main)

## What was proven, live, on the real engine + server

### 1. All three signal systems live in production
Run `phase2-self-awareness-live-proof-…` (first drill run, gpt-5.2 stack):
- `.heartbeat` ticking (ts 4–14s fresh via interval stamps; `lastCycleEndTs` advancing per cycle; phase `cycle_end`).
- `/api/status`: `lastHeartbeat` set (permanently-null since Patch 9 → real), `heartbeat.cycleProgressAgeMs` resetting on each cycle end (89s → 18s at cycle 2), `wedged: false`, `sentinel` present.
- `events.jsonl`: GENESIS-rooted hash chain, seq advancing, prevHash linking.
- Observation: ledger `cycle_complete` events are sparser than heartbeat end-stamps (guided-mode planning cycles early-return; the heartbeat `finally` covers them) — which is exactly why wedge detection keys on the heartbeat.

### 2. Drill #1 (SIGSTOP wedge): detect → kill → ladder → HONEST ESCALATION,
### and it caught a real integration bug
Engine child frozen 13:19:59. Sentinel (drill config: 15s ticks, 120s threshold):
- Detected `wedged_no_cycle_progress` at progressAge ~129s; attempt persisted BEFORE acting.
- stopAll killed the frozen child (SIGKILL path).
- **Both relaunch attempts failed: `"Brain not found"`** → escalated honestly after
  maxAttempts (2): `wedged: true`, `escalated: true`, loud, bounded, no thrash.
- **Root cause:** the relaunch resolved brains through the CATALOG
  (`resolveCatalogBrainBySelector`, gated on completed lifecycle per Patch 69) — which
  cannot contain young, mid-run, just-killed brains: the sentinel's primary clientele.
  The unit suite had faked the relauncher; only a live drill could catch this.
- **User-stop finality proven live in the same incident:** `POST /api/stop` on the
  escalated dead run → `not_running` branch → sentinel force-clear → `wedged: false`,
  `.sentinel.json` archived to `.sentinel.json.last` (evidence preserved). The a445f270
  stop-is-final contract, working in production.

### 3. Fix: cd23e6e4 — relaunch via direct run path
`createContinuationRelauncher` builds the continuation directly from the tracked
`runPath` + `metadata.json` through `launchPreparedResearch` — no catalog dependency.
6 new tests (failing-first, incl. a reproduction of the drill failure), 34/34 suite,
Patch 71 entry updated.

### 4. Drill #2 (re-drill after fix): THE COMPLETE LADDER
Run `phase2-re-drill-approximate-nearest-neighbor-recall-tradeoffs`:
- First cycle completed → engine child 91637 frozen (SIGSTOP).
- 17:44:09Z sentinel detected (progressAge 129,466ms) — attempt recorded, `ok: true,
  error: null` — **the direct-path relaunch succeeded**.
- stopAll's bounded course removed the frozen child (~17:47:09); **new engine child
  61502** spawned; heartbeat resumed: cycle completing at 17:47:40 — ~3.5 minutes
  frozen-to-recovered, 1 of 2 attempts used, `wedged: false` throughout, no escalation.
- Honest nuance: the relaunched run restarted from cycle 1 — the frozen run was killed
  before its first save (short guided runs save at shutdown), so nothing durable existed
  to resume. Runs with committed manifests hydrate fully (proven in Phase 1's kill -9
  drill and its continuations).

### 5. Clean finish artifacts (re-drill run)
- `brain-snapshot.json`: **5 nodes / 6 edges — real embedded nodes** (the embedding-routing
  fix ebd20d2b holding in production; Phase 1's proof runs were 0-node for this reason).
- `verifyLedgerChain`: `ok: true`, 9 records seq 1–9, GENESIS-rooted, zero breaks —
  **the hash chain survived a SIGKILL and continued across the process boundary**
  (seq resume from the tail worked on the relaunched process).
- Backup `backup-2026-07-22T17-53-48-252Z` landed 34ms after the final save (the
  e6b5ce73 bounded shutdown-await working).
- `.clean_shutdown` written only after the confirmed final save; run-end cleanup removed
  the sentinel state; API back to `idle`, `wedged: false`.

## Drill configuration honesty
Drill used temporary sentinel values (15s ticks / 120s wedge threshold / 60s grace) in
`cosmo23/.cosmo23-config/config.json`, loaded via two scoped `pm2 restart home23-cosmo23`
(only that process; engine idle at both restarts; standalone load tests green beforehand
per the sacred rule). The block was REMOVED after the drill and the server restarted on
defaults (60s/15min/5min) — verified live afterward.

## Gates passed before the live proof (Task 8)
Full `npm test` exit 0 · standalone load tests (manifest brain 300/300 hydrated, legacy
299 intact) · mutation battery 4/4 killed (breaker trip, sentinel ladder bound, ledger
hash chain, backpressure critical gate) with verified-clean reverts.

## Phase 2 commit ledger
ab22e846+ac3b52d8 (polish: budget-bounded shutdown ≤177s, TOCTOU, guard memoization,
journal atomicity, config hardening) · 280f3ae6 (heartbeat) · 857fe00e+02d768da (event
ledger + bounded close; retention-sort spec bug found & fixed) · d9ae2a58+eb2ef7bf
(backpressure; heap leg re-based to heap_size_limit) · 41d2b80b (watchdog: contained
abandonment, persisted breaker, restart escalation; cycle-aware heartbeat stamps;
critical-stall trip) · d7b76f86+a445f270+cd23e6e4 (sentinel + stop-is-final + direct-path
relaunch; Patch 71) · b408c048+7f44a608 (sweep, polish, doc truth).
