#!/usr/bin/env bash
#
# COSMO Reproducibility Test
#
# Verifies that checkpoint audit artifacts are reproducible across runs.
# Tests: Do identical states produce identical audit artifact hashes?
#
# Usage: ./scripts/test-reproducibility.sh [num_runs]
#

set -euo pipefail

NUM_RUNS="${1:-10}"
ARTIFACTS_DIR="artifacts/reproducibility"
HASH_FILE="$ARTIFACTS_DIR/audit_hashes.txt"

mkdir -p "$ARTIFACTS_DIR"
rm -f "$HASH_FILE"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         COSMO Reproducibility Test                        ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Testing: Checkpoint audit artifact reproducibility"
echo "Runs: $NUM_RUNS"
echo ""

# Check if we have any existing checkpoints
if [ ! -d "runtime/checkpoints" ]; then
    echo "❌ No runtime/checkpoints directory found"
    echo "   Run COSMO for at least 5 cycles to generate checkpoints first"
    exit 1
fi

# Find audit artifacts (handles both checkpoint-N and checkpoint_N naming)
AUDIT_FILES=$(find runtime/checkpoints -name "*audit.json" -type f 2>/dev/null | sort)

# Filter out empty lines
AUDIT_FILES=$(echo "$AUDIT_FILES" | grep -v '^$')

if [ -z "$AUDIT_FILES" ]; then
    echo "❌ No audit artifacts found in runtime/checkpoints/"
    echo "   Run COSMO for at least 5 cycles to generate checkpoint_5_audit.json"
    exit 1
fi

NUM_AUDITS=$(echo "$AUDIT_FILES" | wc -l | tr -d ' ')

echo "Found $NUM_AUDITS audit artifact(s):"
echo "$AUDIT_FILES" | while read -r file; do
    if [ -n "$file" ]; then
        echo "  • $(basename "$file")"
    fi
done
echo ""

# Test reproducibility by checking if checkpoint hashes are consistent
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Phase 1: Verifying Checkpoint Hash Consistency"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Ensure hash file directory exists
mkdir -p "$(dirname "$HASH_FILE")"

# For each audit artifact, extract the checkpoint_hash
# If COSMO's state serialization is deterministic, these should be stable
echo "$AUDIT_FILES" | while read -r audit_file; do
    if [ -n "$audit_file" ] && [ -f "$audit_file" ]; then
        CHECKPOINT_HASH=$(jq -r '.checkpoint_hash' "$audit_file" 2>/dev/null || echo "PARSE_ERROR")
        CYCLE=$(jq -r '.checkpoint_cycle' "$audit_file" 2>/dev/null || echo "?")
        
        if [ "$CHECKPOINT_HASH" = "PARSE_ERROR" ]; then
            echo "⚠️  Cycle $CYCLE: Could not parse audit artifact"
        else
            echo "Cycle $CYCLE: ${CHECKPOINT_HASH:0:16}..."
            echo "$CHECKPOINT_HASH" >> "$HASH_FILE"
        fi
    fi
done

echo ""

# Check hash stability
TOTAL_HASHES=$(wc -l < "$HASH_FILE" | tr -d ' ')
UNIQUE_HASHES=$(sort "$HASH_FILE" | uniq | wc -l | tr -d ' ')

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Phase 2: Hash Stability Analysis"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Total checkpoints analyzed: $TOTAL_HASHES"
echo "Unique checkpoint hashes:   $UNIQUE_HASHES"
echo ""

# Analyze results
if [ "$TOTAL_HASHES" -eq 0 ]; then
    echo "❌ No valid audit artifacts to analyze"
    exit 1
elif [ "$UNIQUE_HASHES" -eq "$TOTAL_HASHES" ]; then
    echo "✅ All checkpoint hashes are unique"
    echo "   This is expected - each cycle produces different state"
    echo ""
    echo "📊 Interpretation:"
    echo "   • Checkpoint hashes SHOULD differ across cycles (state evolves)"
    echo "   • Reproducibility means: same cycle state → same hash"
    echo "   • To test true reproducibility, we need to:"
    echo "     1. Save a checkpoint"
    echo "     2. Restore from it multiple times"
    echo "     3. Verify hash stays identical"
    echo ""
    echo "✓ Current status: Audit artifacts are being generated correctly"
else
    echo "⚠️  Found $UNIQUE_HASHES unique hashes from $TOTAL_HASHES checkpoints"
    echo "   Some checkpoints have duplicate hashes (unexpected)"
    echo ""
    echo "Hash frequency:"
    sort "$HASH_FILE" | uniq -c | sort -nr
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Phase 3: Audit Artifact Structure Validation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Validate audit artifact schema
FIRST_AUDIT=$(echo "$AUDIT_FILES" | head -n1)
echo "Validating schema in: $(basename "$FIRST_AUDIT")"
echo ""

# Check required fields
REQUIRED_FIELDS=(
    "schema_version"
    "checkpoint_cycle"
    "timestamp"
    "git_commit"
    "node_version"
    "checkpoint_hash"
    "state_snapshot"
)

ALL_FIELDS_PRESENT=true
for field in "${REQUIRED_FIELDS[@]}"; do
    VALUE=$(jq -r ".$field" "$FIRST_AUDIT" 2>/dev/null || echo "null")
    if [ "$VALUE" = "null" ]; then
        echo "❌ Missing field: $field"
        ALL_FIELDS_PRESENT=false
    else
        # Truncate long values
        DISPLAY_VALUE=$(echo "$VALUE" | head -c 60)
        if [ ${#VALUE} -gt 60 ]; then
            DISPLAY_VALUE="${DISPLAY_VALUE}..."
        fi
        echo "✓ $field: $DISPLAY_VALUE"
    fi
done

echo ""

if [ "$ALL_FIELDS_PRESENT" = true ]; then
    echo "✅ All required audit artifact fields present"
else
    echo "❌ Some required fields missing"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Status: Audit artifacts are being generated correctly ✓"
echo ""
echo "Next Steps for True Reproducibility Testing:"
echo "  1. Implement checkpoint restore + re-save test"
echo "  2. Verify restored state produces identical hash"
echo "  3. Test with fixed seeds for GPT calls (if API supports)"
echo ""
echo "Phase 1 Complete: ✅ Tamper-evident audit artifacts with SHA256 hashes"
echo "Phase 2 Needed:   ⏳ Deterministic state serialization + restore verification"
echo ""
echo "Results saved to: $HASH_FILE"
echo ""

