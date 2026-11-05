#!/bin/bash
# Verify OpenAI Agents SDK Integration

echo "╔══════════════════════════════════════════════════╗"
echo "║   Verifying Integration Status                  ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check files exist
echo "📋 Checking created files..."
echo ""

files_created=(
  "phase2/schemas/structured-outputs.js"
  "phase2/evaluation/evaluation-framework.js"
  "phase2/dashboard/evaluation-view.html"
  "OPENAI_AGENTS_SDK_INTEGRATION.md"
  "INTEGRATION_COMPLETE.md"
)

all_exist=true
for file in "${files_created[@]}"; do
  if [ -f "$file" ]; then
    echo -e "${GREEN}✅${NC} $file"
  else
    echo -e "${RED}❌${NC} $file (MISSING)"
    all_exist=false
  fi
done

echo ""

# Check modified files contain key changes
echo "🔧 Checking modified files..."
echo ""

check_string() {
  local file=$1
  local search=$2
  local desc=$3
  
  if grep -q "$search" "$file" 2>/dev/null; then
    echo -e "${GREEN}✅${NC} $desc"
  else
    echo -e "${RED}❌${NC} $desc (NOT FOUND in $file)"
  fi
}

check_string "src/core/orchestrator.js" "EvaluationFramework" "Orchestrator imports EvaluationFramework"
check_string "src/core/orchestrator.js" "this.evaluation = new EvaluationFramework" "Orchestrator initializes evaluation"
check_string "src/core/orchestrator.js" "trackGoalCreated" "Orchestrator tracks goals"
check_string "src/core/orchestrator.js" "trackCycleComplete" "Orchestrator tracks cycles"

check_string "phase2/agents/agent-executor.js" "setEvaluationFramework" "Agent executor has evaluation method"
check_string "phase2/agents/agent-executor.js" "trackAgentSpawned" "Agent executor tracks spawning"
check_string "phase2/agents/agent-executor.js" "trackAgentCompleted" "Agent executor tracks completion"

check_string "phase2/goals/goal-curator.js" "CampaignDecisionSchema" "Goal curator imports schemas"
check_string "phase2/goals/goal-curator.js" "trackCampaignCreated" "Goal curator tracks campaigns"

check_string "phase2/dashboard/server.js" "setEvaluationFramework" "Dashboard has evaluation method"
check_string "phase2/dashboard/server.js" "/evaluation" "Dashboard has evaluation route"
check_string "phase2/dashboard/server.js" "/api/evaluation/metrics" "Dashboard has metrics endpoint"

check_string "src/index.js" "setEvaluationFramework" "Entry point wires dashboard"

echo ""

# Check Node.js syntax
echo "🔍 Checking JavaScript syntax..."
echo ""

syntax_ok=true
for file in "${files_created[@]}"; do
  if [[ $file == *.js ]]; then
    if node -c "$file" 2>/dev/null; then
      echo -e "${GREEN}✅${NC} $file syntax OK"
    else
      echo -e "${RED}❌${NC} $file has syntax errors"
      syntax_ok=false
    fi
  fi
done

echo ""

# Summary
echo "╔══════════════════════════════════════════════════╗"
echo "║   Integration Verification Summary               ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

if $all_exist && $syntax_ok; then
  echo -e "${GREEN}✨ All checks passed!${NC}"
  echo ""
  echo "Integration is complete and ready to use."
  echo ""
  echo "Next steps:"
  echo "  1. Start Cosmo: ./START_SYSTEM_GPT5.sh"
  echo "  2. Visit: http://localhost:3334/evaluation"
  echo "  3. Watch metrics accumulate!"
  echo ""
  echo "Documentation:"
  echo "  • OPENAI_AGENTS_SDK_INTEGRATION.md - Complete guide"
  echo "  • INTEGRATION_COMPLETE.md - Testing checklist"
  echo ""
else
  echo -e "${RED}❌ Some checks failed${NC}"
  echo ""
  echo "Please review the errors above."
fi

echo ""

