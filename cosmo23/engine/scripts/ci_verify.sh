#!/usr/bin/env bash
#
# CI Verification Script
# 
# Purpose:
# - Runs manifest builder
# - Runs validator
# - Checks validation status
# - Fails if validation fails
#
# Usage:
#   ./scripts/ci_verify.sh [runtime_path]
#
# Exit codes:
#   0 - Validation passed
#   1 - Validation failed
#   2 - Script error

set -euo pipefail

RUN_ROOT="${1:-runtime}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

# Set deterministic environment
export LANG=C
export TZ=UTC
export PYTHONHASHSEED=0
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-1704067200}"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "           CI VERIFICATION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Run root: $RUN_ROOT"
echo "Python:   $PYTHON_BIN"
echo "Date:     $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo ""

# Step 1: Build manifest
echo "[1/2] Building manifest..."
if ! $PYTHON_BIN tools/manifest_builder.py "$RUN_ROOT"; then
    echo "ERROR: Manifest builder failed"
    exit 2
fi
echo "✓ Manifest built"
echo ""

# Step 2: Validate
echo "[2/2] Validating..."
if ! $PYTHON_BIN tools/validate.py "$RUN_ROOT"; then
    echo "ERROR: Validation failed"
    exit 1
fi
echo "✓ Validation passed"
echo ""

# Check validation report
REPORT="$RUN_ROOT/outputs/reports/validation_report.json"
if [ -f "$REPORT" ]; then
    STATUS=$(grep -o '"status":"[^"]*"' "$REPORT" | cut -d'"' -f4)
    echo "Validation status: $STATUS"
    
    if [ "$STATUS" != "pass" ]; then
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "VALIDATION FAILED"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        cat "$REPORT"
        exit 1
    fi
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "         VERIFICATION COMPLETE ✓"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
exit 0

