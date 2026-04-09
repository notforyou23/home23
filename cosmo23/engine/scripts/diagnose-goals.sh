#!/bin/bash
# Diagnose Goal System State
cd "$(dirname "$0")/.."

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║              COSMO Goals Diagnostic                       ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# Current task from config
CURRENT_TASK=$(grep 'domain:' src/config.yaml | head -1 | sed 's/.*domain: "\(.*\)".*/\1/')
CURRENT_CONTEXT=$(grep -A 1 'context:' src/config.yaml | tail -1 | sed 's/^ *//')

echo "📋 Current Task Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Domain: $CURRENT_TASK"
echo "  Context: $CURRENT_CONTEXT"
echo ""

# Task from saved plan
if [ -f runtime/guided-plan.md ]; then
    PLAN_TASK=$(grep '^**Task:**' runtime/guided-plan.md | sed 's/**Task:** //')
    echo "📋 Loaded Plan"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Task: $PLAN_TASK"
    echo ""
    
    if [ "$CURRENT_TASK" != "$PLAN_TASK" ]; then
        echo "⚠️  WARNING: Task Mismatch!"
        echo "  Config task ≠ Loaded plan task"
        echo "  System may have stale goals from old task"
        echo ""
    fi
fi

# Goal counts from state
if gunzip -c runtime/state.json.gz &>/dev/null; then
    ACTIVE=$(gunzip -c runtime/state.json.gz 2>/dev/null | jq -r '.goals.active | length')
    COMPLETED=$(gunzip -c runtime/state.json.gz 2>/dev/null | jq -r '.goals.completed | length')
    ARCHIVED=$(gunzip -c runtime/state.json.gz 2>/dev/null | jq -r '.goals.archived | length')
    CYCLE=$(gunzip -c runtime/state.json.gz 2>/dev/null | jq -r '.cycleCount')
    
    echo "📊 Goal Status (Cycle $CYCLE)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Active: $ACTIVE"
    echo "  Completed: $COMPLETED"
    echo "  Archived: $ARCHIVED"
    echo ""
    
    if [ "$ACTIVE" -eq 0 ]; then
        echo "❌ PROBLEM: No active goals!"
        echo ""
        echo "Possible causes:"
        echo "  1. Resumed old run with different task"
        echo "  2. Goals archived due to staleness"
        echo "  3. Guided planner skipped (found existing plan)"
        echo ""
        
        # Check archived goals
        echo "🗃️  Archived Goals (showing first 3):"
        gunzip -c runtime/state.json.gz 2>/dev/null | \
            jq -r '.goals.archived[0:3][] | "  - \(.description[0:80])... (reason: \(.archiveReason))"' 2>/dev/null
        echo ""
    else
        echo "✅ Active goals found"
        echo ""
        gunzip -c runtime/state.json.gz 2>/dev/null | \
            jq -r '.goals.active[] | "  - \(.description[0:80])... (priority: \(.priority))"' 2>/dev/null
        echo ""
    fi
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💡 Recommendations"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$ACTIVE" -eq 0 ]; then
    echo "To fix the no-goals issue:"
    echo ""
    echo "Option 1: Start fresh run for new task (RECOMMENDED)"
    echo "  ./scripts/LAUNCH_COSMO.sh"
    echo "  → Select: n) New run"
    echo ""
    echo "Option 2: Modify directive (keeps memory, changes task)"
    echo "  ./scripts/LAUNCH_COSMO.sh"
    echo "  → Select: m) Modify directive and continue"
    echo ""
    echo "Option 3: Force fresh start"
    echo "  rm runtime/state.json.gz runtime/guided-plan.md"
    echo "  ./scripts/LAUNCH_COSMO.sh"
    echo ""
else
    echo "System appears healthy. If coordinator review hasn't"
    echo "happened yet, wait for cycle 3 (bootstrap review)."
fi

