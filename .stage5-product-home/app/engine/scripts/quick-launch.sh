#!/bin/bash

# Quick Launch Script for COSMO Brain Platform
# Opens Brain Browser with common brains pre-loaded

echo "🧠 COSMO Brain Platform - Quick Launch"
echo "======================================="
echo ""

# Start Brain Browser
echo "Starting Brain Browser on port 3398..."
node scripts/brain-browser.js &
BROWSER_PID=$!

sleep 2

# Open in default browser
if command -v open &> /dev/null; then
  echo "Opening in browser..."
  open http://localhost:3398
elif command -v xdg-open &> /dev/null; then
  xdg-open http://localhost:3398
else
  echo "Please open: http://localhost:3398"
fi

echo ""
echo "✅ Brain Browser running (PID: $BROWSER_PID)"
echo ""
echo "📚 Available brains will be shown in the browser"
echo "   Click 'Explore' to launch Brain Studio for any brain"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Wait for browser process
wait $BROWSER_PID

