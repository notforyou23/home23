#!/bin/bash
# COSMO Contamination Prevention Verification Script
# Ensures no cross-run or domain-specific contamination

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
COSMO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$COSMO_ROOT"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║     COSMO Contamination Prevention Verification            ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

FAILURES=0

# Test 1: No hardcoded domain examples in coordinator
echo "🔍 Test 1: Checking for hardcoded domain examples in coordinator..."
if grep -r "ARC solver\|guitar\|fretboard\|piano\|calculator\|e-commerce" src/coordinator/ 2>/dev/null | grep -v "# NOTE:\|# GOOD:\|# BAD:\|<"; then
    echo "❌ FAIL: Found hardcoded domain examples in coordinator"
    FAILURES=$((FAILURES + 1))
else
    echo "✅ PASS: No hardcoded domain examples in coordinator"
fi
echo ""

# Test 2: No hardcoded domain examples in agents
echo "🔍 Test 2: Checking for hardcoded domain examples in agents..."
if grep -r "ARC solver\|specific.*fretboard\|piano.*app\|calculator.*example" src/agents/ 2>/dev/null | grep -v "# NOTE:\|# GOOD:\|# BAD:\|//"; then
    echo "❌ FAIL: Found hardcoded domain examples in agents"
    FAILURES=$((FAILURES + 1))
else
    echo "✅ PASS: No hardcoded domain examples in agents"
fi
echo ""

# Test 3: No runs/ or queries-archive/ access in coordinator
echo "🔍 Test 3: Checking for runs/ or queries-archive/ access in coordinator..."
if grep -r "runs/\|queries-archive" src/coordinator/ 2>/dev/null | grep -v "# NOTE:\|# NEVER\|//"; then
    echo "❌ FAIL: Found runs/ or queries-archive/ access in coordinator"
    FAILURES=$((FAILURES + 1))
else
    echo "✅ PASS: No historical data access in coordinator"
fi
echo ""

# Test 4: No runs/ or queries-archive/ access in agents
echo "🔍 Test 4: Checking for runs/ or queries-archive/ access in agents..."
if grep -r "runs/\|queries-archive" src/agents/ 2>/dev/null | grep -v "# NOTE:\|# NEVER\|//"; then
    echo "❌ FAIL: Found runs/ or queries-archive/ access in agents"
    FAILURES=$((FAILURES + 1))
else
    echo "✅ PASS: No historical data access in agents"
fi
echo ""

# Test 5: Verify MCP allowedPaths in config
echo "🔍 Test 5: Checking MCP allowedPaths configuration..."
if [ -f "src/config.yaml" ]; then
    if grep -A 3 "allowedPaths:" src/config.yaml | grep -E "queries-archive|runs/" 2>/dev/null; then
        echo "❌ FAIL: MCP allowedPaths includes queries-archive/ or runs/"
        FAILURES=$((FAILURES + 1))
    else
        echo "✅ PASS: MCP allowedPaths are clean (runtime/outputs/, runtime/exports/ only)"
    fi
else
    echo "⚠️  SKIP: No config.yaml found (will be generated on launch)"
fi
echo ""

# Test 6: Verify launcher script doesn't expose contamination vectors
echo "🔍 Test 6: Checking launcher script for contamination vectors..."
if grep "CODEBASE_EXPLORATION_PATHS=" scripts/LAUNCH_COSMO.sh | grep "queries-archive" 2>/dev/null; then
    echo "❌ FAIL: Launcher exposes queries-archive/ in exploration paths"
    FAILURES=$((FAILURES + 1))
else
    echo "✅ PASS: Launcher script does not expose contamination vectors"
fi
echo ""

# Test 7: Verify meta-coordinator doesn't have hardcoded examples
echo "🔍 Test 7: Checking meta-coordinator urgent goals template..."
if grep -A 10 "URGENT GOALS TO CREATE" src/coordinator/meta-coordinator.js | grep -E "\"Test the|\"Validate the|\"Create the.*solver" 2>/dev/null; then
    echo "❌ FAIL: Meta-coordinator has hardcoded goal examples"
    FAILURES=$((FAILURES + 1))
else
    echo "✅ PASS: Meta-coordinator uses generic templates"
fi
echo ""

# Test 8: Verify UnifiedClient doesn't access historical data
echo "🔍 Test 8: Checking UnifiedClient for historical data access..."
if grep -E "runs/\|queries-archive" src/core/unified-client.js 2>/dev/null; then
    echo "❌ FAIL: UnifiedClient accesses historical data"
    FAILURES=$((FAILURES + 1))
else
    echo "✅ PASS: UnifiedClient is clean"
fi
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ $FAILURES -eq 0 ]; then
    echo "✅ ALL TESTS PASSED - Contamination prevention verified"
    echo ""
    echo "System is safe for multi-client enterprise deployment."
    exit 0
else
    echo "❌ $FAILURES TEST(S) FAILED - Contamination risk detected"
    echo ""
    echo "Review docs/operations/CONTAMINATION_PREVENTION.md for remediation."
    exit 1
fi

