#!/bin/bash
# Nightly rebuild of the HNSW ANN search indexes for all real agent brains.
# Dashboards auto-reload the index when memory-ann.meta.json mtime changes,
# so no dashboard restart is needed after a rebuild.
HOME23_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$HOME23_ROOT/engine/src/merge/build-ann-index.js"
AGENTS=("jerry" "forrest")
RC=0

for AGENT in "${AGENTS[@]}"; do
  BRAIN_DIR="$HOME23_ROOT/instances/$AGENT/brain"
  if [ ! -f "$BRAIN_DIR/memory-nodes.jsonl.gz" ]; then
    echo "[rebuild-ann] skip $AGENT: no sidecar"
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
