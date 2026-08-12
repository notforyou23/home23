#!/bin/bash
# Dead-man switch on the sentinel (2026-08-11): the observatory watches every
# organ; this watches the observatory. Cron every 5min. If the terrarium
# doesn't answer: one scoped pm2 restart; if it STILL doesn't answer, notify
# jtr directly through the bridge (token from the harness env at call time —
# read-at-use, never frozen here).
cd /Users/jtr/_JTR23_/release/home23 || exit 1
if curl -sf -m 6 localhost:5050/api/terrarium >/dev/null 2>&1; then exit 0; fi
echo "$(date -Iseconds) [deadman] observatory not answering — restarting"
pm2 restart home23-seed-observatory >/dev/null 2>&1
sleep 12
if curl -sf -m 6 localhost:5050/api/terrarium >/dev/null 2>&1; then
  echo "$(date -Iseconds) [deadman] observatory recovered after restart"
  exit 0
fi
TOKEN=$(pm2 env 6 2>/dev/null | grep -E "^(HOME23_)?BRIDGE_TOKEN" | head -1 | awk '{print $2}')
curl -sf -m 6 -X POST localhost:5004/api/notify \
  -H "Content-Type: application/json" \
  ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
  -d '{"text":"🚨 [deadman] the observatory (organ sentinel) is DOWN and did not recover from a restart — the house is unwatched","severity":"alert","source":"organ-sentinel","requiresAction":true,"isFailure":true}' >/dev/null 2>&1
echo "$(date -Iseconds) [deadman] observatory STILL down — jtr notified"
