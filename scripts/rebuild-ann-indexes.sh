#!/bin/bash
set -o pipefail

# Nightly rebuild of the HNSW ANN search indexes for all real agent brains.
# Dashboards auto-reload the index when memory-ann.meta.json mtime changes,
# so no dashboard restart is needed after a rebuild.
HOME23_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$HOME23_ROOT/engine/src/merge/build-ann-index.js"
MAX_EXPLICIT_AGENTS=64
AGENTS=()
RC=0

add_agent() {
  local candidate="$1"
  if [[ ! "$candidate" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]]; then
    echo "[rebuild-ann] $candidate FAILED code=ann_agent_selector_invalid" >&2
    return 1
  fi
  local existing
  for existing in "${AGENTS[@]}"; do
    if [ "$existing" = "$candidate" ]; then
      return 0
    fi
  done
  AGENTS+=("$candidate")
}

if [ "$#" -gt 0 ]; then
  if [ "$#" -gt "$MAX_EXPLICIT_AGENTS" ]; then
    echo "[rebuild-ann] FAILED code=ann_agent_selector_limit max=$MAX_EXPLICIT_AGENTS" >&2
    exit 2
  fi
  for AGENT in "$@"; do
    add_agent "$AGENT" || exit 2
  done
else
  shopt -s nullglob
  for CONFIG_PATH in "$HOME23_ROOT"/instances/*/config.yaml; do
    add_agent "$(basename "$(dirname "$CONFIG_PATH")")" || exit 2
  done
  shopt -u nullglob
fi

if [ "${#AGENTS[@]}" -eq 0 ]; then
  echo "[rebuild-ann] FAILED code=ann_no_configured_agents" >&2
  exit 1
fi

for AGENT in "${AGENTS[@]}"; do
  BRAIN_DIR="$HOME23_ROOT/instances/$AGENT/brain"
  if [ ! -f "$BRAIN_DIR/memory-manifest.json" ]; then
    echo "[rebuild-ann] $AGENT FAILED code=ann_manifest_missing"
    RC=1
    continue
  fi
  echo "[rebuild-ann] building $AGENT..."
  if node --max-old-space-size=4096 "$BUILDER" "$BRAIN_DIR" 2>&1 | tail -3; then
    echo "[rebuild-ann] $AGENT OK"
  else
    echo "[rebuild-ann] $AGENT FAILED"
    RC=1
  fi
done

exit $RC
