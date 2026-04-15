#!/bin/bash
# Logs Apple Health data from jtrpi to ~/.health_log.jsonl
# Fetches the health dashboard export and appends latest daily values per metric
# Runs via cron every 15 minutes

LOG_PATH="$HOME/.health_log.jsonl"
PI_HOST="jtrpi.local"
API_URL="http://${PI_HOST}:8765/api/health/dashboard"

DATA=$(curl -s --max-time 15 "$API_URL" 2>/dev/null)

if [ -z "$DATA" ]; then
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
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] health API error response" >> /tmp/health_err.log
  exit 1
fi

export HEALTH_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

ENTRY=$(echo "$DATA" | python3 -c "
import sys,json,os

data = json.load(sys.stdin)
ts = os.environ.get('HEALTH_TS', '')

export_info = data.get('export_info', {})
metrics = data.get('metrics', {})

latest = {}
for key, values in metrics.items():
    if isinstance(values, list) and len(values) > 0:
        latest[key] = values[-1]

entry = {
    'ts': ts,
    'export_info': export_info,
    'metrics': latest
}
print(json.dumps(entry))
" 2>/dev/null)

if [ -z "$ENTRY" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] health parse failed" >> /tmp/health_err.log
  exit 1
fi

echo "$ENTRY" >> "$LOG_PATH"
