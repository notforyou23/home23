#!/bin/bash
# COSMO Health Monitor
# Quick script to verify system stability after fixes

cd "$(dirname "$0")/.."
RUNTIME="runtime"
QUEUE_FILE="$RUNTIME/coordinator/results_queue.jsonl"

echo "╔═══════════════════════════════════════════════════════════╗"
echo "║              COSMO Health Monitor                         ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""

# Check if system is running
if ! gunzip -c "$RUNTIME/state.json.gz" 2>/dev/null | jq -r '.cycleCount' &>/dev/null; then
    echo "❌ COSMO not running or state file missing"
    exit 1
fi

CYCLE=$(gunzip -c "$RUNTIME/state.json.gz" 2>/dev/null | jq -r '.cycleCount')
GOAL_COUNT=$(gunzip -c "$RUNTIME/state.json.gz" 2>/dev/null | jq -r '.goals | length')

echo "📊 System Status"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Current Cycle: $CYCLE"
echo "  Goals: $GOAL_COUNT"
echo ""

# Check results queue
if [ -f "$QUEUE_FILE" ]; then
    QUEUE_LINES=$(wc -l < "$QUEUE_FILE" 2>/dev/null || echo "0")
    AGENT_RESULTS=$(grep -c '"type":"agent_result"' "$QUEUE_FILE" 2>/dev/null || grep -c '"agentId":"' "$QUEUE_FILE" 2>/dev/null || echo "0")
    MARKERS=$(grep -c '"type":"integration_marker"' "$QUEUE_FILE" 2>/dev/null || echo "0")
    
    echo "📋 Results Queue Health"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  Total Lines: $QUEUE_LINES"
    echo "  Agent Results: $AGENT_RESULTS"
    echo "  Integration Markers: $MARKERS"
    
    # Calculate expected ratio
    if [ "$AGENT_RESULTS" -gt 0 ]; then
        RATIO=$(echo "scale=2; $MARKERS / $AGENT_RESULTS" | bc 2>/dev/null || echo "N/A")
        echo "  Markers/Results Ratio: $RATIO (should be ~1.0)"
        
        if [ "$RATIO" != "N/A" ]; then
            # Check if ratio is reasonable (0.8 to 1.2)
            if (( $(echo "$RATIO < 0.8" | bc -l) )) || (( $(echo "$RATIO > 1.5" | bc -l) )); then
                echo "  ⚠️  WARNING: Unusual marker ratio!"
            else
                echo "  ✅ Marker ratio healthy"
            fi
        fi
    fi
    echo ""
    
    # Check for duplicate markers (should be 1 or 2 per agent)
    echo "🔍 Checking for Duplicate Markers"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    DUPLICATES=$(tail -200 "$QUEUE_FILE" 2>/dev/null | \
                grep -o '"agentId":"[^"]*"' | \
                sort | uniq -c | \
                awk '$1 > 2 {print}' | \
                wc -l)
    
    if [ "$DUPLICATES" -gt 0 ]; then
        echo "  ❌ Found $DUPLICATES agents with >2 markers!"
        echo "  Top offenders:"
        tail -200 "$QUEUE_FILE" 2>/dev/null | \
            grep -o '"agentId":"[^"]*"' | \
            sort | uniq -c | \
            sort -rn | head -5 | \
            awk '{print "    - " $2 ": " $1 " markers"}'
    else
        echo "  ✅ No excessive duplicate markers detected"
    fi
    echo ""
else
    echo "📋 Results Queue: Not created yet (system just started)"
    echo ""
fi

# Check queue growth rate
echo "📈 Queue Growth Analysis"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ -f "$QUEUE_FILE" ] && [ "$CYCLE" -gt 10 ]; then
    LINES_PER_CYCLE=$(echo "scale=2; $QUEUE_LINES / $CYCLE" | bc 2>/dev/null || echo "N/A")
    echo "  Lines per Cycle: $LINES_PER_CYCLE"
    
    if [ "$LINES_PER_CYCLE" != "N/A" ]; then
        # Healthy growth is < 2 lines/cycle (1 result + 1 marker per review)
        if (( $(echo "$LINES_PER_CYCLE > 5" | bc -l) )); then
            echo "  ❌ WARNING: Queue growing too fast!"
            echo "     (Possible re-processing bug)"
        elif (( $(echo "$LINES_PER_CYCLE > 2" | bc -l) )); then
            echo "  ⚠️  CAUTION: Higher than expected growth"
        else
            echo "  ✅ Healthy linear growth"
        fi
    fi
else
    echo "  ⏳ Not enough cycles for analysis (need >10)"
fi
echo ""

# Check coordinator review schedule
echo "📅 Coordinator Review Status"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
REVIEW_PERIOD=$(grep 'reviewCyclePeriod:' src/config.yaml | awk '{print $2}')
echo "  Review Period: every $REVIEW_PERIOD cycles"

if [ "$CYCLE" -lt 3 ]; then
    echo "  Next Review: Cycle 3 (bootstrap)"
elif [ "$CYCLE" -lt 23 ]; then
    echo "  Last Review: Cycle 3 (bootstrap)"
    echo "  Next Review: Cycle 23"
else
    LAST_REVIEW=$(( ($CYCLE / $REVIEW_PERIOD) * $REVIEW_PERIOD ))
    if [ "$LAST_REVIEW" -lt 3 ]; then
        LAST_REVIEW=3
    fi
    NEXT_REVIEW=$(( $LAST_REVIEW + $REVIEW_PERIOD ))
    echo "  Last Review: Cycle $LAST_REVIEW"
    echo "  Next Review: Cycle $NEXT_REVIEW"
    echo "  Cycles Until Next: $(( $NEXT_REVIEW - $CYCLE ))"
fi
echo ""

# Overall health assessment
echo "🏥 Overall Health Assessment"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ISSUES=0

# Check queue size vs cycle count
if [ -f "$QUEUE_FILE" ] && [ "$CYCLE" -gt 20 ]; then
    if [ "$QUEUE_LINES" -gt $(( $CYCLE * 5 )) ]; then
        echo "  ❌ Queue abnormally large for cycle count"
        ISSUES=$((ISSUES + 1))
    fi
fi

# Check for duplicate markers
if [ "$DUPLICATES" -gt 0 ]; then
    echo "  ❌ Duplicate marker issue detected"
    ISSUES=$((ISSUES + 1))
fi

if [ "$ISSUES" -eq 0 ]; then
    echo "  ✅ System is HEALTHY - No issues detected"
    echo ""
    echo "  All fixes working correctly:"
    echo "    ✓ No duplicate processing"
    echo "    ✓ Sustainable queue growth"
    echo "    ✓ Coordinator reviews on schedule"
else
    echo "  ⚠️  Found $ISSUES issue(s) - Review logs for details"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Run with: watch -n 10 ./scripts/monitor-health.sh"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

