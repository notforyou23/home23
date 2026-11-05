#!/bin/bash
set -o pipefail

# Nightly community detection for every agent brain.
# Dry-run first; if nothing would move, skip silently (a loop that ticked is
# not an event). Apply only when the plan moves nodes. The engine takes its
# own sidecar backup before every apply.
HOME23_ROOT="${HOME23_ROOT_OVERRIDE:-$(cd "$(dirname "$0")/.." && pwd)}"
RC=0
AGENTS_SEEN=0

json_field() {
  # $1 = JSON string, $2 = field — prints value or empty
  printf '%s' "$1" | node -e '
    let s = "";
    process.stdin.on("data", (d) => { s += d; });
    process.stdin.on("end", () => {
      try {
        const parsed = JSON.parse(s);
        const value = parsed[process.argv[1]];
        process.stdout.write(value === undefined ? "" : String(value));
      } catch { process.stdout.write(""); }
    });
  ' "$2"
}

shopt -s nullglob
for CONFIG_PATH in "$HOME23_ROOT"/instances/*/config.yaml; do
  AGENT="$(basename "$(dirname "$CONFIG_PATH")")"
  AGENTS_SEEN=$((AGENTS_SEEN + 1))
  PORT="$(awk '/^ports:/{inports=1; next} inports && /^[^[:space:]]/{inports=0} inports && $1=="engine:"{print $2; exit}' "$CONFIG_PATH")"
  if [ -z "$PORT" ]; then
    echo "[communities] $AGENT SKIP no ports.engine in config"
    continue
  fi

  DRY="$(curl -sf --max-time 300 "http://127.0.0.1:$PORT/admin/memory/cleanup/communities" 2>/dev/null)"
  if [ -z "$DRY" ]; then
    echo "[communities] $AGENT SKIP engine unreachable or busy on port $PORT"
    continue
  fi

  MOVED="$(json_field "$DRY" movedNodes)"
  UNCHANGED="$(json_field "$DRY" unchanged)"
  # Fail CLOSED: a dry-run we can't parse must never fall through to apply.
  case "$MOVED" in
    ''|*[!0-9]*)
      echo "[communities] $AGENT SKIP unparseable dry-run (movedNodes='$MOVED') — refusing to apply"
      RC=1
      continue
      ;;
  esac
  if [ "$UNCHANGED" = "true" ] || [ "$MOVED" = "0" ]; then
    echo "[communities] $AGENT unchanged (0 moves) — skipped"
    continue
  fi

  APPLY="$(curl -sf --max-time 600 -X POST -H 'Content-Type: application/json' \
    -d '{"mode":"apply"}' \
    "http://127.0.0.1:$PORT/admin/memory/cleanup/communities" 2>/dev/null)"
  if [ -z "$APPLY" ]; then
    echo "[communities] $AGENT APPLY FAILED (engine error or timeout)"
    RC=1
    continue
  fi
  echo "[communities] $AGENT applied: moved=$(json_field "$APPLY" movedNodes) communities=$(json_field "$APPLY" communityCount) converged=$(json_field "$APPLY" converged) degenerate=$(json_field "$APPLY" degenerate)"
done
shopt -u nullglob

# A nightly job that silently finds nothing to do is the ANN-index disease:
# it reads as success while covering nobody. Fail loud instead.
if [ "$AGENTS_SEEN" -eq 0 ]; then
  echo "[communities] FAILED code=communities_no_configured_agents (no instances/*/config.yaml under $HOME23_ROOT)" >&2
  exit 1
fi
exit $RC
