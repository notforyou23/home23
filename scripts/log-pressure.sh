#!/bin/bash
# Logs barometric pressure from a configured sensor to ~/.pressure_log.jsonl
# Runs via cron every 5 minutes

LOG_PATH="$HOME/.pressure_log.jsonl"
PI="${PI_SSH_TARGET:-}"
SENSOR_FILE="${PI_SENSOR_FILE:-/home/pi/.openclaw/workspace/state/sensor-latest.json}"
API_URL="${PI_PRESSURE_API_URL:-}"
PI_SSH_KEY_PATH="${PI_SSH_KEY_PATH:-$HOME/.ssh/id_ed25519_pi}"
TRANSPORT=""

DATA=""
if [ -n "$API_URL" ]; then
  DATA=$(curl -s --max-time 10 "$API_URL" 2>/dev/null | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    latest=d.get('latest') or d
    if latest.get('pressure_hpa') and not latest.get('pressure_pa'):
        latest['pressure_pa'] = float(latest['pressure_hpa']) * 100
    print(json.dumps(latest))
except Exception:
    pass
" 2>/dev/null)
fi

if [ -n "$DATA" ]; then
  TRANSPORT="http"
fi

if [ -z "$DATA" ] && [ -n "$PI" ]; then
  SSH_OPTS=(-o ConnectTimeout=5 -o BatchMode=yes)
  if [ -f "$PI_SSH_KEY_PATH" ]; then
    SSH_OPTS+=(-i "$PI_SSH_KEY_PATH" -o IdentitiesOnly=yes)
    TRANSPORT="ssh_key_file"
  else
    TRANSPORT="ssh_agent"
  fi
  DATA=$(ssh "${SSH_OPTS[@]}" "$PI" "cat $SENSOR_FILE" 2>/dev/null)
fi

if [ -z "$DATA" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] pressure read failed; set PI_PRESSURE_API_URL or PI_SSH_TARGET" >> /tmp/pressure_err.log
  exit 1
fi

TS=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('ts',''))" 2>/dev/null)
PA=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('pressure_pa',''))" 2>/dev/null)
INHG=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('pressure_inhg') or '')" 2>/dev/null)
TEMP_C=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('temp_c',''))" 2>/dev/null)
TEMP_F=$(echo "$DATA" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('temp_f',''))" 2>/dev/null)

if [ -z "$TS" ] || [ -z "$PA" ]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] pressure parse failed" >> /tmp/pressure_err.log
  exit 1
fi

ENTRY=$(TS="$TS" PA="$PA" INHG="$INHG" TEMP_C="$TEMP_C" TEMP_F="$TEMP_F" TRANSPORT="$TRANSPORT" python3 -c "
import json, os
def num(v):
    try:
        return float(v)
    except Exception:
        return None
entry = {
    'ts': os.environ.get('TS', ''),
    'pressure_pa': num(os.environ.get('PA', '')),
    'pressure_inhg': num(os.environ.get('INHG', '')),
    'temp_c': num(os.environ.get('TEMP_C', '')),
    'temp_f': num(os.environ.get('TEMP_F', '')),
    'source_transport': os.environ.get('TRANSPORT', 'unknown'),
}
print(json.dumps({k: v for k, v in entry.items() if v is not None}))
" 2>/dev/null)

if [ -n "$ENTRY" ]; then
  echo "$ENTRY" >> "$LOG_PATH"
fi
