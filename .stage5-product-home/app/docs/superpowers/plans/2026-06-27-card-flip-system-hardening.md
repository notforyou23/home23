# Card Flip System Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the card-flip scanner/oracle/dashboard from a useful prototype into a truthful, restart-tolerant, synced operating surface.

**Architecture:** Keep the Pi as the canonical scanner runtime and the Mac Mini as the dashboard/API/bot runtime. Add one explicit sync path from Pi to Mini, align API/dashboard contracts, and harden scanner/oracle behavior with tests before changing production scanning.

**Tech Stack:** Python 3 stdlib, shell, Home23 cron JSON, pm2, Chrome DevTools Protocol on `:9222`, vanilla HTML/CSS/JS, Node test runner for repository tests, Python `unittest` for card-script pure functions.

---

## Current Evidence Reviewed

- Handoff: `instances/jerry/scripts/cards/HANDOFF.md` (484 lines).
- Mini scripts: `card-price.py`, `card-scanner.py`, `marketplaces.py`, `card-bot.py`, `empire-server.py`, `card-flip-dashboard.html`.
- Mini state: `brain/empire/cards/pi-card-scanner-latest.json`, `scripts/cards/card-deals-history.json`, `scripts/cards/card-pricing-cache.json`, `scripts/cards/state/*`.
- Pi files: `/home/jtr/.jerry-node/cards/run-scan.sh`, `card-watchlist.smoke.json`, `state/scanner-latest.json`, `card-deals-history.json`, `state/scanner-events.jsonl`, `state/scan.log`.
- Process state: `pm2 status --no-color` shows `empire-dashboard`, `card-flip-bot`, and `home23-chrome-cdp` online.
- Browser state: Mini Chrome CDP and Pi headless Chrome both respond on `:9222`.
- Scheduler state: `instances/jerry/conversations/cron-jobs.json` has enabled `pi-card-flip-scanner`, but the latest decision inspected was `defer`, with `lastSemanticStatus: withheld`.
- Data drift found: Pi `state/scanner-latest.json` was newer (`2026-06-27T01:48:26Z`) than Mini dashboard copy (`2026-06-27T00:11:52Z`). Pi history had 153 entries; Mini history was `[]`.

## Owner Goals

**Codex coordinator goal:** Own integration, final review, test orchestration, and live proof. Do not edit secret values. Do not restart unrelated pm2 processes. Close only after local tests, Pi smoke scan, Mini API readback, and dashboard data freshness all agree.

**Subagent A, Runtime Sync goal:** Own Pi-to-Mini state sync and cron/manual scan truth. Write scope: `instances/jerry/scripts/cards/sync-pi-card-state.py`, `instances/jerry/scripts/cards/run-scan.sh` on Mini if mirrored, Pi `/home/jtr/.jerry-node/cards/run-scan.sh`, `instances/jerry/conversations/cron-jobs.json`, and related tests/docs. Do not touch scanner parsing logic or dashboard rendering.

**Subagent B, API/Dashboard goal:** Own backend/dashboard contract truth. Write scope: `instances/jerry/scripts/empire-server.py`, `instances/jerry/scripts/card-flip-dashboard.html`, API contract tests/docs. Do not touch Pi runtime scripts or marketplace filters.

**Subagent C, Scanner/Oracle goal:** Own scanner/oracle correctness and resilience. Write scope: `instances/jerry/scripts/cards/card-price.py`, `instances/jerry/scripts/cards/card-scanner.py`, `instances/jerry/scripts/cards/marketplaces.py`, `instances/jerry/scripts/cards/card-watchlist.json` only if a config key is required, and pure-function tests. Do not touch `empire-server.py` or cron JSON.

**Human/JTR goal:** Decide whether to run sudo-required pm2 startup setup and whether to add the son's Telegram chat ID. No agent should perform sudo startup or account/chat allowlist changes without action-time confirmation.

---

## Task 1: Baseline Tests And Fixtures

**Owner:** Codex coordinator

**Files:**
- Create: `tests/scripts/test_card_scanner_filters.py`
- Create: `tests/scripts/card_flip_contract.test.cjs`
- Modify later as needed: `package.json` only if a dedicated script is wanted

- [ ] **Step 1: Add Python pure-function filter tests**

Create `tests/scripts/test_card_scanner_filters.py` with isolated imports of `card-scanner.py`. Cover at minimum:

```python
def test_rejects_read_description_damaged_and_loose_sealed_titles():
    listings = [
        {"title": "Sword and Shield Evolving Skies Booster Box FACTORY SEALED READ DESCRIPTION", "price": 1320.24, "url": ""},
        {"title": "Giratina V Alt Full Art Holo Ultra Rare 186/196 Lost Origin EN DMG", "price": 350.0, "url": ""},
        {"title": "Pokemon Evolving Skies LOOSE Factory Sealed 36 packs Booster Box Equivalent", "price": 1799.99, "url": ""},
    ]
    assert scanner.filter_active(listings, "Evolving Skies booster box sealed") == []
```

Also cover a known-good sealed listing and a known-good graded title so the filter does not become all-blocking.

- [ ] **Step 2: Add backend contract tests**

Create `tests/scripts/card_flip_contract.test.cjs` that reads files as text and verifies static contract consistency:

```js
test('dashboard scan-now route is implemented by empire server', () => {
  const html = readFileSync('instances/jerry/scripts/card-flip-dashboard.html', 'utf8');
  const server = readFileSync('instances/jerry/scripts/empire-server.py', 'utf8');
  assert.match(html, /apiPost\('\/api\/card-scanner\/scan'/);
  assert.match(server, /self\.path == '\/api\/card-scanner\/scan'/);
});
```

Add similar assertions for `/api/card-oracle` GET/POST behavior and the history endpoint.

- [ ] **Step 3: Run the failing tests first**

Run:

```bash
python3 -m unittest tests/scripts/test_card_scanner_filters.py
node --test tests/scripts/card_flip_contract.test.cjs
```

Expected before implementation: failures for missing stricter filters and route mismatches.

---

## Task 2: Runtime Sync And Truthful Scan Execution

**Owner:** Subagent A

**Files:**
- Create: `instances/jerry/scripts/cards/sync-pi-card-state.py`
- Modify: Pi `/home/jtr/.jerry-node/cards/run-scan.sh`
- Optionally mirror: `instances/jerry/scripts/cards/run-scan.sh`
- Modify: `instances/jerry/conversations/cron-jobs.json`
- Modify docs after implementation: `instances/jerry/scripts/cards/HANDOFF.md`

- [ ] **Step 1: Make `run-scan.sh` pass arguments to the scanner**

Change the final scan command on Pi from:

```bash
timeout 280 python3 card-scanner.py >> "$HOME/.jerry-node/cards/state/scan.log" 2>&1
```

to:

```bash
timeout 280 python3 card-scanner.py "$@" >> "$HOME/.jerry-node/cards/state/scan.log" 2>&1
rc=$?
echo "[$(date -u +%FT%TZ)] scan exit=$rc" >> "$HOME/.jerry-node/cards/state/scan.log"
exit "$rc"
```

This preserves manual full scans while allowing cron/manual scan-now to use `--batch-size 12`.

- [ ] **Step 2: Create explicit scan-and-sync script**

Implement `instances/jerry/scripts/cards/sync-pi-card-state.py` with stdlib `argparse`, `subprocess`, `json`, `tempfile`, and `os.replace`. It must support:

```bash
python3 instances/jerry/scripts/cards/sync-pi-card-state.py --dry-run
python3 instances/jerry/scripts/cards/sync-pi-card-state.py --scan --batch-size 12 --trigger cron
python3 instances/jerry/scripts/cards/sync-pi-card-state.py --scan --batch-size 12 --trigger manual
python3 instances/jerry/scripts/cards/sync-pi-card-state.py --trigger sync-only
```

Defaults:

```python
REMOTE = "jtr@jtrpi.local:/home/jtr/.jerry-node/cards"
COPIES = [
    ("state/scanner-latest.json", "instances/jerry/brain/empire/cards/pi-card-scanner-latest.json"),
    ("state/scanner-latest.json", "instances/jerry/scripts/cards/state/scanner-latest.json"),
    ("card-deals-history.json", "instances/jerry/scripts/cards/card-deals-history.json"),
    ("state/scanner-events.jsonl", "instances/jerry/scripts/cards/state/scanner-events.jsonl"),
    ("state/scanner-seen.json", "instances/jerry/scripts/cards/state/scanner-seen.json"),
]
STATUS_FILE = "instances/jerry/brain/empire/cards/pi-card-scanner-sync-status.json"
```

Requirements:

- If `--scan` is passed, run `ssh jtr@jtrpi.local 'cd /home/jtr/.jerry-node/cards && ./run-scan.sh --batch-size N'` first.
- Copy each remote file to a local temp file, validate JSON files with `json.load`, validate JSONL by parsing every non-empty line, then atomically `os.replace` into the destination.
- Write `STATUS_FILE` with `trigger`, `status`, `started_at`, `finished_at`, `phase`, `scanner_ts_before`, `scanner_ts_after`, `history_count`, `events_count`, copied paths, and error text if any.
- On any failed scan/copy/validation, leave the previous destination files untouched and exit non-zero.
- Add `--remote`, `--root`, and `--status-file` flags so tests can run without touching live Pi/Mini state.

- [ ] **Step 3: Update Home23 cron command**

In `instances/jerry/conversations/cron-jobs.json`, change `pi-card-flip-scanner.payload.command` to:

```bash
python3 instances/jerry/scripts/cards/sync-pi-card-state.py --scan --batch-size 12 --trigger cron
```

Keep `timeoutSeconds: 600`. Do not change unrelated cron jobs.

- [ ] **Step 4: Verify sync manually without mutating first**

Run:

```bash
python3 instances/jerry/scripts/cards/sync-pi-card-state.py --dry-run
```

Expected: prints the five planned copy operations and exits 0.

- [ ] **Step 5: Verify live sync**

Run:

```bash
python3 instances/jerry/scripts/cards/sync-pi-card-state.py --trigger verify
jq '.ts' instances/jerry/brain/empire/cards/pi-card-scanner-latest.json
jq 'length' instances/jerry/scripts/cards/card-deals-history.json
jq . instances/jerry/brain/empire/cards/pi-card-scanner-sync-status.json
```

Expected: Mini latest timestamp matches Pi latest timestamp; Mini history length is greater than 0.

---

## Task 3: API And Dashboard Contract Repair

**Owner:** Subagent B

**Files:**
- Modify: `instances/jerry/scripts/empire-server.py`
- Modify: `instances/jerry/scripts/card-flip-dashboard.html`
- Modify: `tests/scripts/card_flip_contract.test.cjs`

- [ ] **Step 1: Align scan-now route**

Keep the existing `/api/card-scan` route as a compatibility alias, but make `/api/card-scanner/scan` the canonical endpoint. Dashboard should call:

```js
const r = await apiPost('/api/card-scanner/scan', {});
```

Server should accept both paths and execute:

```bash
ssh jtr@jtrpi.local 'cd /home/jtr/.jerry-node/cards && ./run-scan.sh --batch-size 12'
python3 instances/jerry/scripts/cards/sync-pi-card-state.py
```

Use a background worker only if the API response clearly says the scan is queued and the dashboard does not claim fresh results until the sync timestamp changes.

- [ ] **Step 2: Add observable scan job status**

If Scan Now remains asynchronous, write a Mini-side receipt such as `instances/jerry/scripts/cards/state/manual-scan-job.json` with:

```json
{
  "job_id": "<timestamp-or-uuid>",
  "status": "queued|running|ok|error",
  "started_at": "<utc iso>",
  "finished_at": null,
  "command": "pi run-scan plus sync",
  "scanner_ts_before": "<prior api ts>",
  "scanner_ts_after": null,
  "error": null
}
```

Add `GET /api/card-scanner/scan` or include `scan_job` in `/api/card-scanner` so the dashboard can say queued/running/finished instead of pretending old data is fresh.

- [ ] **Step 3: Align oracle fields**

`card-price.py` returns `price_range` and `comps_used`. The dashboard currently reads `clean_range` and `comps`. Normalize in the server response:

```python
result.setdefault('clean_range', result.get('price_range', []))
result.setdefault('comps', result.get('comps_used', 0))
```

Also update dashboard code to gracefully read either field.

- [ ] **Step 4: Support handoff-described GET oracle use**

Add `GET /api/card-oracle?card=...&margin=0.25` while preserving existing POST. Reject empty card names with 400.

- [ ] **Step 5: Align watchlist delete/settings behavior**

Either update the handoff to match actual JSON-body behavior, or support both:

```text
DELETE /api/card-watchlist?card=...
DELETE /api/card-watchlist  {"index": 3}
POST /api/card-watchlist/settings
POST /api/card-watchlist  {"action": "batch_size", "batch_size": 12}
```

Preferred: support both so old dashboard/client assumptions do not break.

- [ ] **Step 6: Tighten trusted-source and CORS rules**

Replace `ip.startswith('100.')` with `ipaddress.ip_address(ip) in ipaddress.ip_network('100.64.0.0/10')` plus localhost checks. For mutating methods, only allow absent same-origin requests from trusted network clients or an explicit local/Tailscale origin. Keep GET readable from trusted network clients; return 403 for external POST/DELETE.

- [ ] **Step 7: Render cached pricing and history source honestly**

`/api/card-pricing` is fetched but not displayed. Either render cached pricing in the All Cards or Watchlist tab, or remove the fetch. Normalize history rows so missing `source` becomes `"unknown"` until Task 4 writes source into new history entries.

- [ ] **Step 8: Verify live API**

Run after restarting only `empire-dashboard`:

```bash
pm2 restart empire-dashboard
curl -s http://127.0.0.1:5013/api/card-scanner | jq '{ts, age_seconds, stale, cards_scanned, new_deals}'
curl -s 'http://127.0.0.1:5013/api/card-oracle?card=Charizard%20VMAX%20Champions%20Path%20PSA%2010&margin=0.25' | jq '{ok, result: .result | {card, market_price, max_buy_price, clean_range, comps}}'
curl -s -X POST http://127.0.0.1:5013/api/card-scanner/scan -H 'Content-Type: application/json' -d '{}' | jq '{ok, scan_started, job_id, status}'
node --test tests/scripts/card_flip_contract.test.cjs
```

Expected: API route fields are populated; no route mismatch failures.

---

## Task 4: Scanner/Oracle Correctness And Resilience

**Owner:** Subagent C

**Files:**
- Modify: `instances/jerry/scripts/cards/card-price.py`
- Modify: `instances/jerry/scripts/cards/card-scanner.py`
- Modify: `instances/jerry/scripts/cards/marketplaces.py`
- Modify: `tests/scripts/test_card_scanner_filters.py`

- [ ] **Step 1: Fix scanner/oracle field mapping**

In `scan_card`, replace:

```python
"clean_range": mkt.get("clean_range", []),
"comps": mkt.get("comps", 0),
```

with:

```python
"clean_range": mkt.get("price_range", []),
"comps": mkt.get("comps_used", 0),
```

- [ ] **Step 2: Add smoke-safe CLI options**

Add scanner args:

```python
ap.add_argument("--watchlist", type=str, default=str(WATCHLIST),
                help="watchlist JSON path; default is card-watchlist.json")
ap.add_argument("--no-alerts", action="store_true",
                help="scan and write receipts without Telegram sends")
```

Load the config from `args.watchlist` instead of the hard-coded `WATCHLIST`, and skip `send_alert()` when `args.no_alerts` is true. This makes Pi `card-watchlist.smoke.json` usable without file swapping or accidental sends.

- [ ] **Step 3: Record deal source in history**

When appending `deals_history`, include:

```python
"source": d.get("source", "ebay_bin"),
```

This makes the dashboard history source filter meaningful.

- [ ] **Step 4: Align alert token env fallback**

Scanner currently defaults to `CARD_BOT_TOKEN`, while the env file uses `TOKEN`. Change token loading to:

```python
token_env = cfg.get("alert_token_env", "CARD_BOT_TOKEN")
token = os.environ.get(token_env) or os.environ.get("CARD_BOT_TOKEN") or os.environ.get("TOKEN", "")
```

Do not print token values.

- [ ] **Step 5: Harden false-positive filters**

Extend the reject patterns to catch observed bad deal titles:

```python
r"\bread\s+description\b"
r"\bDMG\b"
r"\bloose\b"
r"\bequivalent\b"
r"\bacrylic\b"
r"\badd[- ]?on\b"
```

Keep a positive test for real sealed product and real PSA title so this does not overfilter.

- [ ] **Step 6: Add GG collector identity locks**

Add query/title helpers for Crown Zenith Galarian Gallery style numbers:

```python
GGNUM_PAT = re.compile(r"\bGG\s*0?(\d{1,3})\b", re.I)
```

If a query contains `GG69`, `GG70`, or `GG44`, require the listing title to contain the same normalized `GG` number. Add tests proving `Giratina VSTAR GG69 Crown Zenith PSA 10` does not accept `Arceus VSTAR GG70` or `Mewtwo VSTAR GG44` titles.

- [ ] **Step 7: Add retry/backoff around page fetches**

Add a small helper in `card-scanner.py`:

```python
def fetch_with_retry(fn, *args, attempts=3, base_sleep=2.0, **kwargs):
    last = None
    for i in range(attempts):
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            last = e
            time.sleep(base_sleep * (2 ** i))
    raise last
```

Use it for sold-comp fetches and active marketplace fetches, with printed stderr context but no token/env output.

- [ ] **Step 8: Make marketplace defaults honest**

`PriceCharting` is a comp/reference source, not an active deal marketplace. Update `marketplaces.py` so default deal scanning does not include PriceCharting. Preferred default until TCGplayer is calibrated:

```python
DEFAULT_SCAN_MARKETS = ["ebay"]
EXPERIMENTAL_SCAN_MARKETS = ["tcgplayer"]
REFERENCE_MARKETS = ["pricecharting"]
```

Then let `card-watchlist.json` opt into TCGplayer with `scan_markets` only after calibration.

- [ ] **Step 9: Add bounded pricing cache behavior**

If cache is intended for runtime reuse, implement `max_age_seconds` and `max_entries` in scanner-side cache entries keyed by `card|margin|fee_rate`. If cache is only dashboard telemetry, update `HANDOFF.md` to stop claiming TTL-based oracle caching. The preferred implementation is real TTL reuse with default TTL 3600 seconds and max 500 entries. Add tests for stale-entry rejection and oldest-entry eviction.

- [ ] **Step 10: Verify scanner tests and smoke scan**

Run:

```bash
python3 -m unittest tests/scripts/test_card_scanner_filters.py
python3 -m py_compile instances/jerry/scripts/cards/card-price.py instances/jerry/scripts/cards/card-scanner.py instances/jerry/scripts/cards/marketplaces.py
python3 instances/jerry/scripts/cards/card-scanner.py --watchlist instances/jerry/scripts/cards/card-watchlist.smoke.json --no-alerts
scp instances/jerry/scripts/cards/card-price.py instances/jerry/scripts/cards/card-scanner.py instances/jerry/scripts/cards/marketplaces.py jtr@jtrpi.local:/home/jtr/.jerry-node/cards/
ssh jtr@jtrpi.local 'cd /home/jtr/.jerry-node/cards && ./run-scan.sh --watchlist card-watchlist.smoke.json --no-alerts'
ssh jtr@jtrpi.local 'cd /home/jtr/.jerry-node/cards && python3 -m json.tool state/scanner-latest.json >/dev/null'
```

Expected: tests pass; py_compile passes; Pi smoke scan exits 0 and writes a fresh `state/scanner-latest.json`.

---

## Task 5: Operational Closeout And Documentation

**Owner:** Codex coordinator

**Files:**
- Modify: `instances/jerry/scripts/cards/HANDOFF.md`
- Optional create: `instances/jerry/scripts/cards/state/verification-latest.json`

- [ ] **Step 1: Refresh handoff after code truth changes**

Update `HANDOFF.md` only after implementation. Required corrections:

- Canonical scan-now endpoint is `/api/card-scanner/scan` with `/api/card-scan` as legacy alias.
- `run-scan.sh` accepts scanner args and is used by cron/manual scan-now.
- Mini history is actively synced from Pi.
- Pricing cache behavior is either true TTL+max-size reuse or explicitly dashboard-only telemetry.
- PriceCharting is reference-only, not a default deal source.
- pm2 diagnostics should use `pm2 status --no-color`; avoid `pm2 jlist` in handoff because it exposes environment blocks.

- [ ] **Step 2: Produce one verification receipt**

Create or update `instances/jerry/scripts/cards/state/verification-latest.json` with:

```json
{
  "ts": "<utc iso>",
  "mini_scanner_ts": "<from /api/card-scanner>",
  "pi_scanner_ts": "<from Pi state/scanner-latest.json>",
  "mini_history_count": 0,
  "pi_history_count": 0,
  "pm2": {
    "empire-dashboard": "online",
    "card-flip-bot": "online",
    "home23-chrome-cdp": "online"
  },
  "checks": {
    "python_unittest": "pass",
    "node_contract": "pass",
    "py_compile": "pass",
    "mini_api": "pass",
    "pi_chrome_cdp": "pass"
  }
}
```

Fill real counts/statuses from commands, not memory.

- [ ] **Step 3: Final live proof**

Run:

```bash
pm2 status --no-color
curl -s http://127.0.0.1:5013/api/card-scanner | jq '{ts, age_seconds, stale, cards_scanned, new_deals}'
curl -s http://127.0.0.1:5013/api/card-deals | jq '{ok,total, sample:(.deals[-3:] // [])}'
ssh jtr@jtrpi.local 'curl -s --max-time 5 http://localhost:9222/json/version' | jq '{Browser}'
python3 -m unittest tests/scripts/test_card_scanner_filters.py
node --test tests/scripts/card_flip_contract.test.cjs
```

Expected:

- `empire-dashboard`, `card-flip-bot`, and `home23-chrome-cdp` online.
- `/api/card-scanner` timestamp matches the latest synced Pi receipt.
- `/api/card-deals.total` is greater than 0 after history sync.
- Pi Chrome CDP responds.
- Tests pass.

---

## Subagent Dispatch Prompts

**Subagent A prompt:**

```text
Own Runtime Sync for /Users/jtr/_JTR23_/release/home23. You are not alone in the codebase; do not revert unrelated edits and accommodate concurrent changes. Read docs/superpowers/plans/2026-06-27-card-flip-system-hardening.md Task 2. Implement only the sync/runtime pieces: sync-pi-card-state.py, Pi run-scan.sh arg pass-through, cron command update, and verification notes. Do not edit dashboard/API rendering or scanner filters. Return changed files, commands run, and live timestamp/count proof. Do not print secrets.
```

**Subagent B prompt:**

```text
Own API/Dashboard Contract for /Users/jtr/_JTR23_/release/home23. You are not alone in the codebase; do not revert unrelated edits and accommodate concurrent changes. Read docs/superpowers/plans/2026-06-27-card-flip-system-hardening.md Task 3. Implement only empire-server.py, card-flip-dashboard.html, and contract tests. Preserve compatibility aliases. Do not edit Pi scripts or marketplace filters. Return changed files, commands run, and curl/API proof. Do not print secrets.
```

**Subagent C prompt:**

```text
Own Scanner/Oracle Correctness for /Users/jtr/_JTR23_/release/home23. You are not alone in the codebase; do not revert unrelated edits and accommodate concurrent changes. Read docs/superpowers/plans/2026-06-27-card-flip-system-hardening.md Task 4. Implement only card-price.py, card-scanner.py, marketplaces.py, and pure-function tests. Do not edit empire-server.py, dashboard HTML, or cron JSON. Return changed files, tests run, and Pi smoke-scan result. Do not print secrets.
```

**Coordinator prompt to self:**

```text
Integrate subagent results, resolve conflicts, run all verification commands, update HANDOFF.md and verification-latest.json, then report exact live proof. Do not perform sudo pm2 startup or Telegram allowlist changes without explicit action-time confirmation.
```

---

## Hard Stops

- Do not run sudo `pm2 startup` without explicit confirmation.
- Do not add or expose Telegram token/chat IDs beyond already documented non-secret IDs.
- Do not kill or restart unrelated pm2 processes.
- Do not make purchase, sale, account, marketplace, or Telegram-send decisions from scanner output without explicit confirmation.
- Do not claim dashboard freshness from cron `lastStatus: ok`; use synced file timestamps and API readback.
