#!/bin/bash
# x-timeline-fetch.sh — Fetch raw X timeline for processing
# Run from cron: output goes to stdout for the agent to process

set -euo pipefail

COUNT="${1:-50}"
OUTPUT_DIR="${HOME}/.openclaw/workspace/reports/x-timeline"
mkdir -p "$OUTPUT_DIR"

TIMESTAMP=$(date +%Y-%m-%d-%H%M%S)
TMP_FILE="${OUTPUT_DIR}/.raw-timeline-${TIMESTAMP}.json"

# Fetch Following timeline (chronological) + For You
# Redirect stderr separately — bird emits cookie warnings to stderr, not stdout
/opt/homebrew/bin/bird home --following --count "$COUNT" --json > "$TMP_FILE" 2>/dev/null
/opt/homebrew/bin/bird home --count "$COUNT" --json >> "$TMP_FILE" 2>/dev/null

echo "RAW_TL_FILE=${TMP_FILE}"
echo "TIMESTAMP=${TIMESTAMP}"