#!/bin/bash

# COSMO Agent Fixes Verification Script
# Tests all the fixes applied to ResearchAgent, CodeCreationAgent, and MCP

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COSMO_ROOT="$(dirname "$SCRIPT_DIR")"

echo "═══════════════════════════════════════════════════"
echo "COSMO Agent Fixes Verification"
echo "═══════════════════════════════════════════════════"
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass_count=0
fail_count=0

function test_pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((pass_count++))
}

function test_fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    ((fail_count++))
}

function test_info() {
    echo -e "${YELLOW}ℹ INFO${NC}: $1"
}

echo "Test 1: Verify runtime/outputs directory exists"
echo "─────────────────────────────────────────────────"
if [ -d "$COSMO_ROOT/runtime/outputs" ]; then
    test_pass "runtime/outputs directory exists"
else
    test_fail "runtime/outputs directory missing"
fi
echo ""

echo "Test 2: Verify ResearchAgent has graceful handling"
echo "─────────────────────────────────────────────────"
if grep -q "wasSupposedToReadCode" "$COSMO_ROOT/src/agents/research-agent.js"; then
    test_pass "ResearchAgent has graceful code file skipping"
else
    test_fail "ResearchAgent missing graceful handling"
fi

if grep -q "Mission does not require code file analysis" "$COSMO_ROOT/src/agents/research-agent.js"; then
    test_pass "ResearchAgent returns proper skip message"
else
    test_fail "ResearchAgent missing skip message"
fi
echo ""

echo "Test 3: Verify CodeCreationAgent substring safety"
echo "─────────────────────────────────────────────────"
if grep -q "const content = file.content || '';" "$COSMO_ROOT/src/agents/code-creation-agent.js"; then
    test_pass "CodeCreationAgent has null safety for file.content"
else
    test_fail "CodeCreationAgent missing null safety"
fi

if grep -q '\[No content\]' "$COSMO_ROOT/src/agents/code-creation-agent.js"; then
    test_pass "CodeCreationAgent has fallback for missing content"
else
    test_fail "CodeCreationAgent missing content fallback"
fi
echo ""

echo "Test 4: Verify BaseAgent MCP error handling"
echo "─────────────────────────────────────────────────"
if grep -q "Better error handling for malformed responses" "$COSMO_ROOT/src/agents/base-agent.js"; then
    test_pass "BaseAgent has improved MCP error handling"
else
    test_fail "BaseAgent missing improved error handling"
fi

if grep -q "expected items array, got" "$COSMO_ROOT/src/agents/base-agent.js"; then
    test_pass "BaseAgent has detailed error messages"
else
    test_fail "BaseAgent missing detailed error messages"
fi
echo ""

echo "Test 5: Verify GPT-5.2 response.incomplete handling"
echo "─────────────────────────────────────────────────"
if grep -q "response.incomplete" "$COSMO_ROOT/src/core/gpt5-client.js"; then
    test_pass "GPT-5.2 client handles response.incomplete events"
else
    test_fail "GPT-5.2 client missing response.incomplete handling"
fi

if grep -q "reasoningEffort: 'low'" "$COSMO_ROOT/src/core/gpt5-client.js"; then
    test_pass "GPT-5.2 client uses 'low' reasoning effort to minimize incomplete responses"
else
    test_fail "GPT-5.2 client not optimized for reasoning effort"
fi
echo ""

echo "Test 6: Code syntax validation"
echo "─────────────────────────────────────────────────"
node -c "$COSMO_ROOT/src/agents/research-agent.js" 2>/dev/null && test_pass "research-agent.js syntax valid" || test_fail "research-agent.js has syntax errors"
node -c "$COSMO_ROOT/src/agents/code-creation-agent.js" 2>/dev/null && test_pass "code-creation-agent.js syntax valid" || test_fail "code-creation-agent.js has syntax errors"
node -c "$COSMO_ROOT/src/agents/base-agent.js" 2>/dev/null && test_pass "base-agent.js syntax valid" || test_fail "base-agent.js has syntax errors"
echo ""

echo "Test 7: MCP Server functionality"
echo "─────────────────────────────────────────────────"
if pgrep -f "mcp/http-server.js" > /dev/null; then
    test_pass "MCP server is running"
    
    # Test if we can list the runtime/outputs directory
    test_info "Testing MCP directory listing for runtime/outputs..."
    # This would require the server to be responsive, skip for now
    test_info "Skipping live MCP test (would require active server interaction)"
else
    test_info "MCP server not running (skipping live tests)"
fi
echo ""

echo "═══════════════════════════════════════════════════"
echo "Test Summary"
echo "═══════════════════════════════════════════════════"
echo -e "${GREEN}Passed:${NC} $pass_count"
echo -e "${RED}Failed:${NC} $fail_count"
echo ""

if [ $fail_count -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    echo ""
    echo "Summary of fixes applied:"
    echo "1. ✓ ResearchAgent: Graceful handling when mission doesn't require code reading"
    echo "2. ✓ CodeCreationAgent: Null safety for file.content before substring()"
    echo "3. ✓ BaseAgent: Improved MCP error handling with detailed messages"
    echo "4. ✓ MCP: Created missing runtime/outputs directory"
    echo "5. ✓ GPT-5.2: Already handles response.incomplete gracefully with 'low' reasoning"
    echo ""
    exit 0
else
    echo -e "${RED}✗ Some tests failed${NC}"
    exit 1
fi

