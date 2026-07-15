#!/bin/bash
set -o pipefail

# Nightly rebuild of the HNSW ANN search indexes for all real agent brains.
# Dashboards auto-reload the index when memory-ann.meta.json mtime changes,
# so no dashboard restart is needed after a rebuild.
HOME23_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILDER="$HOME23_ROOT/engine/src/merge/build-ann-index.js"
HEALTH_WRITER="$HOME23_ROOT/scripts/lib/ann-index-health.cjs"
MAX_EXPLICIT_AGENTS=64
AGENTS=()
RC=0

record_health() {
  local agent="$1"
  local outcome="$2"
  local receipt="${3:-}"
  ANN_HOME23_ROOT="$HOME23_ROOT" ANN_AGENT="$agent" ANN_OUTCOME="$outcome" \
    ANN_RECEIPT="$receipt" \
    ANN_GAP_THRESHOLD="${ANN_SUSTAINED_GAP_THRESHOLD:-3}" \
    ANN_MAX_GAP="${ANN_MAX_OVERLAY_GAP_RECORDS:-50000}" \
    node "$HEALTH_WRITER"
}

record_hard_failure() {
  if ! record_health "$1" "$2" ""; then
    echo "[rebuild-ann] $1 FAILED code=ann_health_write_failed" >&2
  fi
}

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
  if [ ! -d "$BRAIN_DIR" ] || [ -L "$BRAIN_DIR" ] \
      || [ ! -f "$BRAIN_DIR/memory-manifest.json" ] \
      || [ -L "$BRAIN_DIR/memory-manifest.json" ]; then
    echo "[rebuild-ann] $AGENT FAILED code=ann_manifest_missing"
    record_hard_failure "$AGENT" "manifest_missing"
    RC=1
    continue
  fi
  echo "[rebuild-ann] building $AGENT..."
  if BUILDER_OUTPUT="$(node --max-old-space-size=4096 "$BUILDER" "$BRAIN_DIR" 2>&1)"; then
    RECEIPT_LINE="$(printf '%s\n' "$BUILDER_OUTPUT" | tail -1)"
    if [ "${#BUILDER_OUTPUT}" -gt 65536 ]; then
      echo "[rebuild-ann] $AGENT FAILED code=ann_receipt_oversized"
      record_hard_failure "$AGENT" "receipt_invalid"
      RC=1
      continue
    fi
    if NORMALIZED_RECEIPT="$(ANN_AGENT="$AGENT" ANN_RECEIPT="$RECEIPT_LINE" \
      ANN_REQUIRED_VECTOR_COVERAGE_BPS="${ANN_MIN_VECTOR_COVERAGE_BPS:-5000}" node -e '
      const receipt = JSON.parse(process.env.ANN_RECEIPT || "null");
      const requiredVectorCoverageBps = Number(process.env.ANN_REQUIRED_VECTOR_COVERAGE_BPS);
      const statuses = new Set(["fresh", "overlay-covered", "rebuilt-overlay-covered"]);
      const durationKeys = ["sourceOpenMs", "sourceScanMs", "indexWriteMs", "metadataWriteMs", "publishMs", "reuseValidationMs", "cleanupMs", "totalMs"];
      const stageKeys = ["sourceOpen", "sourceScan", "indexWrite", "metadataWrite", "publish", "reuseValidation", "cleanup", "total"];
      const stageVocabulary = new Set(["completed", "skipped", "reused"]);
      const reusedStatuses = { sourceOpen: "completed", sourceScan: "skipped", indexWrite: "skipped", metadataWrite: "skipped", publish: "skipped", reuseValidation: "reused", cleanup: "completed", total: "completed" };
      const builtStatuses = { sourceOpen: "completed", sourceScan: "completed", indexWrite: "completed", metadataWrite: "completed", publish: "completed", reuseValidation: "skipped", cleanup: "completed", total: "completed" };
      if (!Number.isSafeInteger(requiredVectorCoverageBps)
          || requiredVectorCoverageBps < 1 || requiredVectorCoverageBps > 10000
          || !receipt || receipt.event !== "ann_rebuild_receipt" || !statuses.has(receipt.status)
          || !Number.isSafeInteger(receipt.builtRevision) || receipt.builtRevision < 0
          || !Number.isSafeInteger(receipt.currentRevision) || receipt.currentRevision < 0
          || !Number.isSafeInteger(receipt.bridgeableGap) || receipt.bridgeableGap < 0
          || receipt.currentRevision - receipt.builtRevision !== receipt.bridgeableGap
          || (receipt.status === "fresh") !== (receipt.bridgeableGap === 0)
          || (receipt.status === "rebuilt-overlay-covered" && receipt.reused)
          || typeof receipt.reused !== "boolean"
          || !receipt.stageDurations || typeof receipt.stageDurations !== "object"
          || Object.keys(receipt.stageDurations).sort().join(",") !== durationKeys.slice().sort().join(",")
          || durationKeys.some((key) => !Number.isSafeInteger(receipt.stageDurations[key]) || receipt.stageDurations[key] < 0)
          || !receipt.stageStatuses || typeof receipt.stageStatuses !== "object"
          || Object.keys(receipt.stageStatuses).sort().join(",") !== stageKeys.slice().sort().join(",")
          || stageKeys.some((key) => !stageVocabulary.has(receipt.stageStatuses[key]))
          || receipt.stageStatuses.total !== "completed"
          || stageKeys.some((key) => receipt.stageStatuses[key] !== (receipt.reused ? reusedStatuses : builtStatuses)[key])
          || (receipt.reused && ["sourceScanMs", "indexWriteMs", "metadataWriteMs", "publishMs"].some((key) => receipt.stageDurations[key] !== 0))
          || (!receipt.reused && receipt.stageDurations.reuseValidationMs !== 0)
          || durationKeys.slice(0, -1).some((key) => receipt.stageDurations.totalMs < receipt.stageDurations[key])
          || durationKeys.slice(0, -1).reduce((sum, key) => sum + receipt.stageDurations[key], 0)
            > receipt.stageDurations.totalMs + Math.ceil((durationKeys.length - 1) / 2)
          || !receipt.semanticCoverage || typeof receipt.semanticCoverage !== "object"
          || receipt.semanticCoverage.status !== "complete"
          || !Number.isSafeInteger(receipt.semanticCoverage.sourceNodes) || receipt.semanticCoverage.sourceNodes < 0
          || !Number.isSafeInteger(receipt.semanticCoverage.indexed) || receipt.semanticCoverage.indexed < 0
          || !Number.isSafeInteger(receipt.semanticCoverage.skipped) || receipt.semanticCoverage.skipped < 0
          || receipt.semanticCoverage.indexed + receipt.semanticCoverage.skipped !== receipt.semanticCoverage.sourceNodes
          || receipt.semanticCoverage.usable !== true
          || !Number.isSafeInteger(receipt.semanticCoverage.vectorCoverageBps)
          || receipt.semanticCoverage.vectorCoverageBps < 0 || receipt.semanticCoverage.vectorCoverageBps > 10000
          || !Number.isSafeInteger(receipt.semanticCoverage.minimumVectorCoverageBps)
          || receipt.semanticCoverage.minimumVectorCoverageBps < 1
          || receipt.semanticCoverage.minimumVectorCoverageBps > 10000
          || receipt.semanticCoverage.minimumVectorCoverageBps < requiredVectorCoverageBps
          || receipt.semanticCoverage.vectorCoverageBps < receipt.semanticCoverage.minimumVectorCoverageBps
          || receipt.semanticCoverage.vectorCoverageBps !== (receipt.semanticCoverage.sourceNodes === 0
            ? 10000 : Math.floor((receipt.semanticCoverage.indexed * 10000) / receipt.semanticCoverage.sourceNodes))
          || (receipt.semanticCoverage.sourceNodes > 0 && receipt.semanticCoverage.indexed === 0)
          || receipt.indexCount !== receipt.semanticCoverage.indexed) process.exit(2);
      process.stdout.write(JSON.stringify({ agent: process.env.ANN_AGENT, ...receipt }));
    ' 2>/dev/null)"; then
      echo "$NORMALIZED_RECEIPT"
      record_health "$AGENT" "success" "$RECEIPT_LINE"
      HEALTH_RC=$?
      if [ "$HEALTH_RC" -eq 3 ]; then
        echo "[rebuild-ann] $AGENT FAILED code=ann_sustained_gap" >&2
        RC=1
      elif [ "$HEALTH_RC" -ne 0 ]; then
        echo "[rebuild-ann] $AGENT FAILED code=ann_health_write_failed" >&2
        RC=1
      fi
    else
      printf '%s\n' "$BUILDER_OUTPUT" | tail -3
      echo "[rebuild-ann] $AGENT FAILED code=ann_receipt_invalid"
      record_hard_failure "$AGENT" "receipt_invalid"
      RC=1
    fi
  else
    printf '%s\n' "$BUILDER_OUTPUT" | tail -3
    echo "[rebuild-ann] $AGENT FAILED"
    record_hard_failure "$AGENT" "builder_failed"
    RC=1
  fi
done

exit $RC
