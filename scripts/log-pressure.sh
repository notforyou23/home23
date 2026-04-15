#!/bin/bash
# Logs barometric pressure from jtrpi sensor to ~/.pressure_log.jsonl
# Runs via cron every 5 minutes

LOG_PATH="$HOME/.pressure_log.jsonl"
PI="jtr@jtrpi"
SENSOR_FILE="/home/jtr/.openclaw/workspace/state/sensor-latest.json"

DATA=$(ssh -o ConnectTimeout=5 -o BatchMode=yes "$PI" "cat $SENSOR_FILE" 2>/dev/null)

if [ -z "$DATA" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] pressure SSH read failed" >> /tmp/pressure_err.log
  exit 1
fi

TS=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ts',''))" 2>/dev/null)
PA=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('pressure_pa',''))" 2>/dev/null)
INHG=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('pressure_inhg',''))" 2>/dev/null)
TEMP_C=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('temp_c',''))" 2>/dev/null)
TEMP_F=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('temp_f',''))" 2>/dev/null)

if [ -z "$TS" ] || [ -z "$PA" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] pressure parse failed" >> /tmp/pressure_err.log
  exit 1
fi

ENTRY=$(python3 -c "
import sys,json
print(json.dumps({'ts':'$TS','pressure_pa':$PA,'pressure_inhg':$INHG,'temp_c':$TEMP_C,'temp_f':$TEMP_F}))
" 2>/dev/null)

if [ -n "$ENTRY" ]; then
  echo "$ENTRY" >> "$LOG_PATH"
fi
