#!/bin/bash
# Quick test script for COSMO Experimental Mode
# Creates a simple test goal that triggers experimental execution

cd "$(dirname "$0")/.."

echo "🧪 COSMO Experimental Mode - Quick Test"
echo ""
echo "This will inject a goal that triggers experimental execution."
echo "COSMO will request approval to take a screenshot."
echo ""

read -p "Continue? (y/n): " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Cancelled"
    exit 0
fi

# Create test goal
cat > runtime/.inject_goal << 'EOF'
{
  "description": "Test experimental mode by taking a screenshot of the desktop and saving it to outputs",
  "priority": 0.95,
  "metadata": {
    "experimental": true
  }
}
EOF

echo ""
echo "✅ Test goal injected"
echo ""
echo "Next steps:"
echo "  1. Wait for Meta-Coordinator review (every 20 cycles)"
echo "  2. Watch for approval request:"
echo "     tail -f runtime/events.log | grep 'approval requested'"
echo ""
echo "  3. When request appears:"
echo "     ls .pending_experiments/"
echo ""
echo "  4. Approve it:"
echo "     touch .pending_experiments/exp_*.approved"
echo ""
echo "  5. Watch execution:"
echo "     tail -f runtime/events.log | grep 'Executing\|screenshot'"
echo ""
echo "  6. Check screenshot:"
echo "     ls runtime/outputs/screenshots/"
echo ""
echo "Monitoring approval requests..."
echo "(Press Ctrl+C to stop)"
echo ""

# Monitor for approval request
while true; do
    if [ -d .pending_experiments ] && [ "$(ls -A .pending_experiments 2>/dev/null)" ]; then
        echo ""
        echo "🎯 APPROVAL REQUEST DETECTED!"
        echo ""
        ls -la .pending_experiments/
        echo ""
        echo "To approve, run:"
        echo "  touch .pending_experiments/exp_*.approved"
        echo ""
        break
    fi
    sleep 2
done

