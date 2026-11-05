#!/bin/bash
# Smoke Test for Quantum Reasoner Enhancements
# Tests: branchPolicy, latentProjector, and telemetry features
# Safe: Creates test run, verifies outputs, restores previous state

set -e

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🧪 QUANTUM REASONER ENHANCEMENT SMOKE TEST"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Get to COSMO root
cd "$(dirname "$0")/.."
COSMO_ROOT="$(pwd)"

# Test configuration
TEST_RUN="test_quantum_$(date +%Y%m%d_%H%M%S)"
RUNS_DIR="$COSMO_ROOT/runs"
TEST_RUN_PATH="$RUNS_DIR/$TEST_RUN"

# Track previous runtime for restoration
PREV_RUNTIME_TARGET=""
if [ -L "$COSMO_ROOT/runtime" ]; then
    PREV_RUNTIME_TARGET=$(readlink "$COSMO_ROOT/runtime")
fi

echo "📋 Test Configuration:"
echo "   Test run:        $TEST_RUN"
echo "   Previous state:  $([ -n "$PREV_RUNTIME_TARGET" ] && echo "$PREV_RUNTIME_TARGET" || echo "none")"
echo "   Max cycles:      5"
echo "   Features:        branchPolicy, latentProjector"
echo ""

# Cleanup function
cleanup() {
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🧹 Cleanup"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Restore previous runtime
    if [ -n "$PREV_RUNTIME_TARGET" ]; then
        rm -f "$COSMO_ROOT/runtime"
        ln -sf "$PREV_RUNTIME_TARGET" "$COSMO_ROOT/runtime"
        echo "✓ Restored previous runtime: $(basename "$PREV_RUNTIME_TARGET")"
    fi
    
    # Restore production config if backup exists
    if [ -f "$COSMO_ROOT/src/config.yaml.backup" ]; then
        mv "$COSMO_ROOT/src/config.yaml.backup" "$COSMO_ROOT/src/config.yaml"
        echo "✓ Restored production config"
    fi
    
    echo ""
    echo "Test run preserved at: $TEST_RUN_PATH"
    echo "To inspect: cd $TEST_RUN_PATH"
    echo ""
}

# Register cleanup on exit
trap cleanup EXIT

# ============================================================
# STEP 1: Setup Test Run
# ============================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📁 Step 1: Setting Up Test Run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Create test run directory
mkdir -p "$TEST_RUN_PATH"
mkdir -p "$TEST_RUN_PATH/policies"
mkdir -p "$TEST_RUN_PATH/training"
mkdir -p "$TEST_RUN_PATH/coordinator"

# Link runtime to test run
rm -f "$COSMO_ROOT/runtime"
ln -sf "$TEST_RUN_PATH" "$COSMO_ROOT/runtime"
echo "✓ Created test run: $TEST_RUN"
echo "✓ Linked runtime -> runs/$TEST_RUN"

# Backup current config and use test config
if [ -f "$COSMO_ROOT/src/config.yaml" ]; then
    cp "$COSMO_ROOT/src/config.yaml" "$COSMO_ROOT/src/config.yaml.backup"
    echo "✓ Backed up production config"
fi

cp "$COSMO_ROOT/src/config.test-quantum.yaml" "$COSMO_ROOT/src/config.yaml"
echo "✓ Installed test configuration"
echo ""

# ============================================================
# STEP 2: Run COSMO Test Session
# ============================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 Step 2: Running COSMO (5 cycles)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Starting quantum-enhanced session..."
echo "(This will take 2-3 minutes)"
echo ""

# Run COSMO with test config (TUI disabled for clean output)
export COSMO_TUI=false
cd "$COSMO_ROOT/src"

# Capture output to log
COSMO_LOG="$TEST_RUN_PATH/test-run.log"
if node --expose-gc index.js > "$COSMO_LOG" 2>&1; then
    echo -e "${GREEN}✓ COSMO test session completed${NC}"
else
    echo -e "${RED}✗ COSMO test session failed${NC}"
    echo "  See log: $COSMO_LOG"
    exit 1
fi

cd "$COSMO_ROOT"
echo ""

# ============================================================
# STEP 3: Verify Outputs
# ============================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 Step 3: Verifying Outputs"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

PASS_COUNT=0
FAIL_COUNT=0

# Helper function for checks
check_file() {
    local file=$1
    local name=$2
    local min_lines=${3:-1}
    
    if [ -f "$file" ]; then
        local lines=$(wc -l < "$file" | tr -d ' ')
        if [ "$lines" -ge "$min_lines" ]; then
            echo -e "${GREEN}✓${NC} $name exists (${lines} lines)"
            PASS_COUNT=$((PASS_COUNT + 1))
            return 0
        else
            echo -e "${YELLOW}⚠${NC} $name exists but insufficient data (${lines} lines, expected ${min_lines}+)"
            FAIL_COUNT=$((FAIL_COUNT + 1))
            return 1
        fi
    else
        echo -e "${RED}✗${NC} $name not found"
        FAIL_COUNT=$((FAIL_COUNT + 1))
        return 1
    fi
}

# Check 1: Branch telemetry
echo "Checking branch telemetry..."
if check_file "$TEST_RUN_PATH/evaluation-branches.jsonl" "evaluation-branches.jsonl" 3; then
    # Show sample
    echo "  Sample entry:"
    head -n 1 "$TEST_RUN_PATH/evaluation-branches.jsonl" | jq '.branches[0] | {branchId, reasoningEffort, usedWebSearch, durationMs}' 2>/dev/null || echo "  (parse failed)"
fi
echo ""

# Check 2: Branch policy state
echo "Checking branch policy..."
if check_file "$TEST_RUN_PATH/policies/branch-policy.json" "branch-policy.json"; then
    # Verify structure
    if jq -e '.version == 1 and .totalSamples > 0' "$TEST_RUN_PATH/policies/branch-policy.json" > /dev/null 2>&1; then
        samples=$(jq -r '.totalSamples' "$TEST_RUN_PATH/policies/branch-policy.json")
        echo -e "${GREEN}  ✓${NC} Policy state valid (${samples} samples)"
        
        # Show effort statistics
        echo "  Effort statistics:"
        jq '.efforts' "$TEST_RUN_PATH/policies/branch-policy.json" | grep -E 'low|medium|high' || true
    else
        echo -e "${YELLOW}  ⚠${NC} Policy state malformed or no samples"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
fi
echo ""

# Check 3: Latent training dataset
echo "Checking latent projector dataset..."
if check_file "$TEST_RUN_PATH/training/latent-dataset.jsonl" "latent-dataset.jsonl" 3; then
    # Show sample
    echo "  Sample entry:"
    head -n 1 "$TEST_RUN_PATH/training/latent-dataset.jsonl" | jq '{cycle, reward, vectorSize: (.vector | length), hint}' 2>/dev/null || echo "  (parse failed)"
fi
echo ""

# Check 4: Verify branch policy decisions appeared in logs
echo "Checking for policy decisions in logs..."
if grep -q "policy" "$COSMO_LOG"; then
    echo -e "${GREEN}✓${NC} Policy decisions found in logs"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo -e "${YELLOW}⚠${NC} No policy mentions in logs"
fi
echo ""

# Check 5: Verify latent hints in logs
echo "Checking for latent hints in logs..."
if grep -q -i "latent" "$COSMO_LOG"; then
    echo -e "${GREEN}✓${NC} Latent projector activity found in logs"
    PASS_COUNT=$((PASS_COUNT + 1))
else
    echo -e "${YELLOW}⚠${NC} No latent projector mentions in logs"
fi
echo ""

# Check 6: Verify consistency reviews (optional - only if triggered)
echo "Checking for consistency reviews..."
if grep -q -i "consistency\|divergence" "$COSMO_LOG"; then
    echo -e "${GREEN}✓${NC} Consistency review activity found in logs"
    PASS_COUNT=$((PASS_COUNT + 1))
    
    # Check if consistency agent actually ran
    if grep -q "consistency_review" "$COSMO_LOG"; then
        echo -e "${GREEN}  ✓${NC} Consistency agent executed"
    else
        echo -e "${BLUE}  ℹ${NC} Divergence tracked (agent not triggered - threshold not exceeded)"
    fi
else
    echo -e "${YELLOW}⚠${NC} No consistency tracking in logs"
fi
echo ""

# ============================================================
# STEP 4: Test Training Script
# ============================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🧮 Step 4: Testing Latent Projector Training"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -f "$TEST_RUN_PATH/training/latent-dataset.jsonl" ]; then
    echo "Running training script..."
    if node "$COSMO_ROOT/scripts/train-latent-projector.js" > "$TEST_RUN_PATH/training.log" 2>&1; then
        echo -e "${GREEN}✓${NC} Training script completed"
        PASS_COUNT=$((PASS_COUNT + 1))
        
        # Verify weights were created
        if [ -f "$TEST_RUN_PATH/policies/latent-projector.json" ]; then
            vector_size=$(jq -r '.vectorSize' "$TEST_RUN_PATH/policies/latent-projector.json")
            matrix_rows=$(jq -r '.projectionMatrix | length' "$TEST_RUN_PATH/policies/latent-projector.json")
            echo -e "${GREEN}  ✓${NC} Weights generated (${matrix_rows}x${vector_size})"
            PASS_COUNT=$((PASS_COUNT + 1))
        else
            echo -e "${RED}  ✗${NC} Weights file not created"
            FAIL_COUNT=$((FAIL_COUNT + 1))
        fi
    else
        echo -e "${RED}✗${NC} Training script failed"
        echo "  See: $TEST_RUN_PATH/training.log"
        FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
else
    echo -e "${YELLOW}⚠${NC} No training data available, skipping"
fi
echo ""

# ============================================================
# Summary
# ============================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Test Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Passed: $PASS_COUNT"
echo "Failed: $FAIL_COUNT"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}✅ ALL TESTS PASSED${NC}"
    echo ""
    echo "Next steps:"
    echo "  1. Review test outputs in: $TEST_RUN_PATH"
    echo "  2. Enable features in production config if desired"
    echo "  3. Monitor runtime/policies/ files during production runs"
    exit 0
else
    echo -e "${YELLOW}⚠️  SOME TESTS FAILED ($FAIL_COUNT)${NC}"
    echo ""
    echo "Troubleshooting:"
    echo "  • Check logs: $COSMO_LOG"
    echo "  • Review test run: $TEST_RUN_PATH"
    echo "  • Verify config: src/config.test-quantum.yaml"
    exit 1
fi

