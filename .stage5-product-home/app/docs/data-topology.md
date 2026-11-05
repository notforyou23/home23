# Home Data Topology — jtr

> **Purpose**: Single source of truth for where all personal data lives, how it flows, and what depends on it.

---

## Data Sources

### 1. Barometric Pressure — Pi (jtrpi / Axiom)
**Location**: `jtr@jtrpi` at `192.168.7.136:8765` (also `100.72.171.59`)
**Hardware**: BME280 sensor on Pi
**Data files**:
- `/home/jtr/.openclaw/workspace/state/sensor-latest.json` — current reading (updated ~5s)
- `/home/jtr/sensor/log/env_full-YYYY-MM-DD.csv` — daily logs, every ~6s
- `/home/jtr/.openclaw/workspace/state/kalman-pressure.json` — Kalman-filtered value
- `/home/jtr/.openclaw/workspace/state/cusum-pressure.json` — CUSUM anomaly detection state
- `/home/jtr/.openclaw/workspace/state/health-pressure-correlation.json` — health correlation analysis

**CSV columns**: timestamp, pressure_hpa, temp_c, temp_f, sauna_temp_c, sauna_temp_f, sauna_door, sauna_status_code, weather_temp_f, weather_humidity, weather_pressure_inhg

**Service**: `python3 /home/jtr/.openclaw/workspace/projects/pi-bp-dashboard/app.py` (always on)
**API**: `GET /api/latest` returns `{pressure_hpa, temp_c, temp_f, ts}`
**Retention**: CSV daily files, oldest seen is 2026-04-06. 33m altitude set in sensor config.

### 1b. Barometric Pressure — Mac (Home23)
**Script**: `/Users/jtr/_JTR23_/release/home23/scripts/log-pressure.sh`
**Cron**: every 5 min via `pressure-to-mac` cron job
**Log**: `~/.pressure_log.jsonl` — appended on each poll
```json
{"ts":"2026-04-13T21:39:18-0400","pressure_pa":100925,"pressure_inhg":29.8,"temp_c":19.4,"temp_f":66.9}
```
**Engine integration**: `engine/src/core/integrations/pi-sensor.js` — `fetchPiSensor()` and `fetchPiExternal()` available for on-demand queries
**Started**: 2026-04-14

### 1c. Apple Health — Mac (Home23)
**Source**: `http://jtrpi.local:8765/api/health/dashboard` (Pi dashboard, local network only)
**Script**: `/Users/jtr/_JTR23_/release/home23/scripts/log-health.sh`
**Cron**: every 15 min via `health-to-mac` cron job
**Log**: `~/.health_log.jsonl` — appended on each poll; one entry with latest value per metric per run
**Metrics**: restingHeartRate, HRV, sleepTime, stepCount, activeCalories, basalCalories, exerciseMinutes, flightsClimbed, vo2Max, walkingDistance, walkingHeartRate, oxygenSaturation, respiratoryRate, weight, BMI, bodyFat, leanBodyMass, wristTemperature
**Export history**: Apple Health → iOS Shortcut → Pi `/api/health` → `health-export-full.json` (back to 2009-02-03)
**Dashboard endpoint**: returns 30-day window with latest daily values per metric
**Latest snapshot** (2026-04-11): Resting HR 59 bpm, HRV 29.7 ms, Sleep 375.9 min, Steps 201, Active Cal 31.7 kcal, Weight 75.02 kg (2025-08-13), SpO2 95.9%, VO2Max 29.21
**Started**: 2026-04-14
**Note**: iOS Shortcut last sent data 2026-04-13 but all metric arrays were empty — daily ingest may need to be re-triggered from phone.

---

### 2. Sauna — Huum Cloud API
**Polled by**: Home23 dashboard (`home23-tiles.js`, `fetchHuumStatus()`)
**Interval**: 15s (dashboard tile refresh)
**Connection**: `jtr-huum` connection in Home23, credentials in env

**Local log**: `~/.sauna_usage_log.jsonl`
```json
{"event":"start","ts":"2026-04-14T01:05:55.025Z","temp":106,"targetTemp":190,"status":"Heating"}
{"event":"stop","ts":"2026-04-14T01:06:53.832Z","temp":106,"targetTemp":190,"status":"Off"}
```
**Trigger**: State transition (off→heating/locked = start, heating/locked→off = stop)
**Started**: 2026-04-14

**Pi also tracks sauna** in the CSV (`sauna_temp_c`, `sauna_door`, `sauna_status_code`) but that's independent.

---

### 3. Weather — Ecowitt (via Home23)
**Polled by**: Home23 `sensors.js` or direct API call every 60s via tile refresh
**Source**: Ecowitt weather station
**Connection**: `jtr-ecowitt` in Home23

**Local cache**: `/Users/jtr/_JTR23_/release/home23/engine/data/sensor-cache.json`
```json
{
  "weather": { "outdoor": {"temperature":"61.2","humidity":"45"}, "pressure":{"relative":"29.68"}, ... },
  "sauna": { ... },
  "updatedAt": "2026-03-21T19:05:04.359Z"
}
```
**Note**: cache has old `updatedAt` from March 21 — verify polling is active.

**Tile**: weather tile on Home23 dashboard, refresh every 60s

---

### 4. Health — Apple Health Export (on Pi)
**Location**: `http://192.168.7.136:8765/api/health/dashboard?days=N`
**Source**: Apple Health export, imported to Pi
**Historical range**: 2009-02-03 to 2026-03-05 (export date)

**Metrics available** (18 data types):
- activeCalories, basalCalories, bmi, bodyFat
- exerciseMinutes, flightsClimbed
- heartRateVariability (HRV), restingHeartRate (RHR)
- leanBodyMass, oxygenSaturation (SpO2), respiratoryRate
- sleepTime (total), sleep stages (deep, REM)
- stepCount, vo2Max, walkingDistance, walkingHeartRate
- weight, wristTemperature

**Daily resolution** for most metrics. Some (BMI, bodyFat, weight) are sporadic.

**Pi also runs** `/api/health/correlations` — lag analysis across pressure vs health metrics (HRV, RHR, sleep, SpO2). Correlations weak so far (n=40 days overlap).

---

### 5. Pi System / Dashboard
**URL**: `http://192.168.7.136:8765`
**Sections**: Dashboard (pressure/temp), Real Estate, Studies, Memories, Family, Axiom, Health, Reports
**API routes**: `/api/latest`, `/api/history`, `/api/system`, `/api/external`, `/api/sauna_history`, `/api/realestate/*`, `/api/studies`, `/api/memories`, `/api/family`

---

## Local Mac Storage (Home23 / jerry)

| Path | What's there |
|---|---|
| `~/.sauna_usage_log.jsonl` | sauna start/stop events (from 2026-04-14) |
| `~/.pressure_log.jsonl` | barometric pressure readings from Pi (from 2026-04-14) |
| `~/.health_log.jsonl` | Apple Health latest values per metric, updated every 15 min (from 2026-04-14) |
| `/Users/jtr/_JTR23_/release/home23/engine/data/sensor-cache.json` | weather + sauna cache (Ecowitt + Huum) |
| `/Users/jtr/_JTR23_/release/home23/engine/src/core/integrations/pi-sensor.js` | Pi API integration (fetchPiSensor, fetchPiExternal) |
| `/Users/jtr/_JTR23_/release/home23/engine/src/core/sensors.js` | sensor poller — weather, sauna, pressure |
| `/Users/jtr/_JTR23_/release/home23/instances/jerry/brain/` | jerry's brain (nodes + edges) |
| `/Users/jtr/life/feed/` | ingested documents, PDFs |
| `/Users/jtr/_JTR23_/release/home23/scripts/log-pressure.sh` | pressure SSH + log script |
| `/Users/jtr/_JTR23_/release/home23/docs/data-topology.md` | this document |

---

## Pi Storage

| Path | What's there |
|---|---|
| `/home/jtr/.openclaw/workspace/state/sensor-latest.json` | current pressure/temp |
| `/home/jtr/sensor/log/env_full-YYYY-MM-DD.csv` | daily sensor log (pressure, temp, sauna, weather) |
| `/home/jtr/.openclaw/workspace/state/kalman-pressure.json` | filtered pressure |
| `/home/jtr/.openclaw/workspace/state/cusum-pressure.json` | anomaly detection state |
| `/home/jtr/.openclaw/workspace/state/health-pressure-correlation.json` | health correlation output |
| `/home/jtr/.openclaw/workspace/projects/pi-bp-dashboard/` | Flask app source (1850 lines) |

---

## Data Flow Summary

```
Pi (jtrpi)
├── BME280 sensor ──────────────────► app.py (Flask) ──► :8765 dashboard
│                                       ├── /api/latest ──► sensor-latest.json
│                                       └── CSV writer ──► /home/jtr/sensor/log/env_full-YYYY-MM-DD.csv
│
├── Huum sauna ──────────────────────► CSV (sauna_temp, door, status)
│                                       └── /api/external → dashboard
│
├── Ecowitt weather ────────────────► CSV (weather_temp, humidity, pressure)
│                                       └── /api/external → dashboard
│
└── Apple Health (iOS Shortcut) ───► /api/health ──► health-export-full.json (2009→)
                                        └── /api/health/dashboard ──► :8765

Mac (Home23)
├── Huum API (direct) ──────────────► home23-tiles.js ──► ~/.sauna_usage_log.jsonl (15s)
├── Ecowitt API (direct) ────────────► home23-tiles.js ──► sensor-cache.json (60s)
├── Pi sensor API (cron, 5min) ─────► log-pressure.sh ──► ~/.pressure_log.jsonl
├── Pi health dashboard (cron, 15min) ► log-health.sh ──► ~/.health_log.jsonl
├── Pi API (on-demand) ─────────────► engine/src/core/integrations/pi-sensor.js
└── Sauna dashboard tile ────────────► :5002/home23 (15s refresh)
```

---

## Next Steps / Open Questions

- [x] Pull pressure from Pi to Mac — ~/.pressure_log.jsonl via cron every 5min
- [x] Pull health from Pi to Mac — ~/.health_log.jsonl via cron every 15min
- [x] Pi as engine integration — pi-sensor.js with fetchPiSensor() + fetchPiExternal()
- [x] Unified live dashboard — Home23 Dashboard at port 8090 (Tailscale: `http://100.72.171.58:8090`), replaces Pi as the unified view
- [ ] iOS Health Shortcut data gap — last sent 2026-04-13 but all arrays empty; re-trigger from phone to populate today's health metrics
- [ ] Health + pressure + sauna correlation analysis — all three now on Mac; next step is building the actual correlation view
- [ ] Verify Ecowitt polling is actually running (sensor-cache.json last updated March 21)
- [ ] Pi homeauto.service not running — /tmp/weather.json not being written (doesn't matter since Home23 reads Ecowitt directly)

---

*Last updated: 2026-04-14*