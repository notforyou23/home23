#!/bin/bash
# Logs workouts data from a configured bridge to ~/.workouts_log.jsonl
# Runs via cron every 15 minutes

LOG_PATH="$HOME/.workouts_log.jsonl"
PI_HOST="${WORKOUTS_PI_HOST:-}"
API_URL="${WORKOUTS_API_URL:-}"
if [ -z "$API_URL" ] && [ -n "$PI_HOST" ]; then
  API_URL="http://${PI_HOST}:8765/api/workouts/dashboard"
fi

if [ -z "$API_URL" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] workouts API not configured; set WORKOUTS_API_URL or WORKOUTS_PI_HOST" >> /tmp/workouts_err.log
  exit 1
fi

DATA=$(curl -s --max-time 15 "$API_URL" 2>/dev/null)

if [ -z "$DATA" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] workouts API fetch failed" >> /tmp/workouts_err.log
  exit 1
fi

HAS_ERROR=$(echo "$DATA" | python3 -c "
import sys,json
d=json.load(sys.stdin)
print('yes' if 'error' in d else 'no')
" 2>/dev/null)

if [ "$HAS_ERROR" = "yes" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] workouts API error response" >> /tmp/workouts_err.log
  exit 1
fi

export WORKOUTS_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

ENTRY=$(echo "$DATA" | python3 -c "
import sys,json,os

data = json.load(sys.stdin)
ts = os.environ.get('WORKOUTS_TS', '')

entry = {
    'ts': ts,
    'total_count': data.get('total_count', 0),
    'recent_count': data.get('recent_count', 0),
    'recent_duration_hours': data.get('recent_duration_hours', 0),
    'top_activity_types': data.get('top_activity_types', []),
    'workouts': data.get('workouts', []),
}
print(json.dumps(entry))
" 2>/dev/null)

if [ -z "$ENTRY" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] workouts parse failed" >> /tmp/workouts_err.log
  exit 1
fi

echo "$ENTRY" >> "$LOG_PATH"
