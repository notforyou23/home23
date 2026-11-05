#!/bin/bash
# Logs Apple Health data from a configured bridge to ~/.health_log.jsonl
# Fetches the health dashboard export and appends latest daily values per metric
# Runs via cron every 15 minutes

LOG_PATH="$HOME/.health_log.jsonl"
STATUS_PATH="$HOME/.health_log.status.json"
PI_HOST="${HEALTH_PI_HOST:-}"
API_URL="${HEALTH_API_URL:-}"
if [ -z "$API_URL" ] && [ -n "$PI_HOST" ]; then
  API_URL="http://${PI_HOST}:8765/api/health/dashboard"
fi
MAX_DATA_AGE_DAYS="${HEALTH_MAX_DATA_AGE_DAYS:-3}"

write_status() {
  local ok="$1"
  local reason="$2"
  local checked_at
  checked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  CHECKED_AT="$checked_at" STATUS_OK="$ok" STATUS_REASON="$reason" STATUS_API_URL="$API_URL" python3 -c "
import json, os
status = {
  'checkedAt': os.environ.get('CHECKED_AT'),
  'ok': os.environ.get('STATUS_OK') == 'true',
  'stale': os.environ.get('STATUS_OK') != 'true',
  'apiUrl': os.environ.get('STATUS_API_URL', ''),
  'reason': os.environ.get('STATUS_REASON', ''),
}
print(json.dumps(status))
" > "$STATUS_PATH"
}

if [ -z "$API_URL" ]; then
  write_status false "set HEALTH_API_URL or HEALTH_PI_HOST"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] health API not configured" >> /tmp/health_err.log
  exit 1
fi

DATA=$(curl -s --max-time 15 "$API_URL" 2>/dev/null)

if [ -z "$DATA" ]; then
  write_status false "health API fetch failed"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] health API fetch failed" >> /tmp/health_err.log
  exit 1
fi

# Check for error key in response
HAS_ERROR=$(echo "$DATA" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('yes' if 'error' in d else 'no')
" 2>/dev/null)

if [ "$HAS_ERROR" = "yes" ]; then
  write_status false "health API error response"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] health API error response" >> /tmp/health_err.log
  exit 1
fi

export HEALTH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export API_URL
export MAX_DATA_AGE_DAYS

PARSED=$(echo "$DATA" | python3 -c "
import sys,json,os
from datetime import datetime, timezone

data = json.load(sys.stdin)
ts = os.environ.get('HEALTH_TS', '')
max_age_days = int(os.environ.get('MAX_DATA_AGE_DAYS', '3'))

export_info = data.get('export_info', {})
metrics = data.get('metrics', {})

latest = {}
metric_dates = {}
for key, values in metrics.items():
    if isinstance(values, list) and len(values) > 0:
        latest[key] = values[-1]
        if isinstance(values[-1], dict) and values[-1].get('date'):
            metric_dates[key] = values[-1].get('date')

def parse_day(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value)[:10]).date()
    except Exception:
        return None

date_candidates = [parse_day(export_info.get('endDate'))]
date_candidates.extend(parse_day(v) for v in metric_dates.values())
date_candidates = [d for d in date_candidates if d is not None]
newest_day = max(date_candidates) if date_candidates else None
today = datetime.now(timezone.utc).date()
data_age_days = (today - newest_day).days if newest_day else None
stale = data_age_days is None or data_age_days > max_age_days

entry = {
    'ts': ts,
    'export_info': export_info,
    'metrics': latest,
    'metric_dates': metric_dates,
    'health_data_end_date': newest_day.isoformat() if newest_day else None,
    'health_data_age_days': data_age_days,
    'semantic_stale': stale,
}

status = {
    'checkedAt': ts,
    'ok': not stale,
    'stale': stale,
    'apiUrl': os.environ.get('API_URL', ''),
    'exportEndDate': export_info.get('endDate'),
    'newestMetricDate': newest_day.isoformat() if newest_day else None,
    'dataAgeDays': data_age_days,
    'maxDataAgeDays': max_age_days,
    'metricCount': len(latest),
    'reason': 'fresh health data' if not stale else 'health payload is semantically stale',
}

print(json.dumps({'entry': entry, 'status': status}))
" 2>/dev/null)

if [ -z "$PARSED" ]; then
  write_status false "health parse failed"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] health parse failed" >> /tmp/health_err.log
  exit 1
fi

STATUS=$(echo "$PARSED" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['status']))" 2>/dev/null)
ENTRY=$(echo "$PARSED" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)['entry']))" 2>/dev/null)
IS_STALE=$(echo "$PARSED" | python3 -c "import sys,json; print('yes' if json.load(sys.stdin)['status'].get('stale') else 'no')" 2>/dev/null)

if [ -n "$STATUS" ]; then
  echo "$STATUS" > "$STATUS_PATH"
fi

if [ "$IS_STALE" = "yes" ]; then
  NEWEST=$(echo "$STATUS" | python3 -c "import sys,json; print(json.load(sys.stdin).get('newestMetricDate') or 'unknown')" 2>/dev/null)
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] health payload stale; newest metric date ${NEWEST}" >> /tmp/health_err.log
  exit 2
fi

echo "$ENTRY" >> "$LOG_PATH"
