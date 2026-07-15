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
  if BUILDER_OUTPUT="$(node --max-old-space-size=4096 "$BUILDER" "$BRAIN_DIR" 2>&1)"; then
    RECEIPT_LINE="$(printf '%s\n' "$BUILDER_OUTPUT" | tail -1)"
    if [ "${#BUILDER_OUTPUT}" -gt 65536 ]; then
      echo "[rebuild-ann] $AGENT FAILED code=ann_receipt_oversized"
      RC=1
      continue
    fi
    if NORMALIZED_RECEIPT="$(ANN_AGENT="$AGENT" ANN_RECEIPT="$RECEIPT_LINE" node -e '
      const receipt = JSON.parse(process.env.ANN_RECEIPT || "null");
      const statuses = new Set(["fresh", "overlay-covered"]);
      if (!receipt || receipt.event !== "ann_rebuild_receipt" || !statuses.has(receipt.status)
          || !Number.isSafeInteger(receipt.builtRevision)
          || !Number.isSafeInteger(receipt.currentRevision)
          || !Number.isSafeInteger(receipt.bridgeableGap) || receipt.bridgeableGap < 0
          || receipt.currentRevision - receipt.builtRevision !== receipt.bridgeableGap
          || !receipt.stageDurations || typeof receipt.stageDurations !== "object"
          || !receipt.semanticCoverage || typeof receipt.semanticCoverage !== "object") process.exit(2);
      process.stdout.write(JSON.stringify({ agent: process.env.ANN_AGENT, ...receipt }));
    ' 2>/dev/null)"; then
      echo "$NORMALIZED_RECEIPT"
      HEALTH_PATH="$HOME23_ROOT/instances/$AGENT/runtime/ann-index-health.json"
      if ! ANN_RECEIPT="$RECEIPT_LINE" ANN_HEALTH_PATH="$HEALTH_PATH" \
        ANN_GAP_THRESHOLD="${ANN_SUSTAINED_GAP_THRESHOLD:-3}" \
        ANN_MAX_GAP="${ANN_MAX_OVERLAY_GAP_RECORDS:-50000}" node -e '
          const fs = require("node:fs");
          const path = require("node:path");
          const receipt = JSON.parse(process.env.ANN_RECEIPT);
          const threshold = Number(process.env.ANN_GAP_THRESHOLD);
          const maxGap = Number(process.env.ANN_MAX_GAP);
          if (!Number.isSafeInteger(threshold) || threshold < 1
              || !Number.isSafeInteger(maxGap) || maxGap < 0) process.exit(2);
          let previous = {};
          try { previous = JSON.parse(fs.readFileSync(process.env.ANN_HEALTH_PATH, "utf8")); } catch {}
          const excessive = receipt.bridgeableGap > maxGap;
          const consecutiveExcessiveGaps = excessive
            ? Number(previous.consecutiveExcessiveGaps || 0) + 1
            : 0;
          const state = {
            status: excessive ? "lagging" : "healthy",
            consecutiveExcessiveGaps,
            builtRevision: receipt.builtRevision,
            currentRevision: receipt.currentRevision,
            bridgeableGap: receipt.bridgeableGap,
            updatedAt: new Date().toISOString(),
          };
          fs.mkdirSync(path.dirname(process.env.ANN_HEALTH_PATH), { recursive: true, mode: 0o700 });
          const temp = `${process.env.ANN_HEALTH_PATH}.${process.pid}.tmp`;
          fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
          fs.renameSync(temp, process.env.ANN_HEALTH_PATH);
          if (consecutiveExcessiveGaps >= threshold) process.exit(3);
        '; then
        echo "[rebuild-ann] $AGENT FAILED code=ann_sustained_gap" >&2
        RC=1
      fi
    else
      printf '%s\n' "$BUILDER_OUTPUT" | tail -3
      echo "[rebuild-ann] $AGENT FAILED code=ann_receipt_invalid"
      RC=1
    fi
  else
    printf '%s\n' "$BUILDER_OUTPUT" | tail -3
    echo "[rebuild-ann] $AGENT FAILED"
    RC=1
  fi
done

exit $RC
