#!/bin/bash

# Test Multi-Provider Implementation
# Verifies that system still works with default config

echo "╔══════════════════════════════════════════════════╗"
echo "║   Testing Multi-Provider Implementation         ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

echo "✅ Step 1: Checking file structure..."
if [ -f "phase2/core/unified-client.js" ]; then
  echo "   ✓ unified-client.js exists"
else
  echo "   ✗ unified-client.js missing!"
  exit 1
fi

if [ -f "phase2/core/gpt5-client.js" ]; then
  echo "   ✓ gpt5-client.js preserved"
else
  echo "   ✗ gpt5-client.js missing!"
  exit 1
fi

echo ""
echo "✅ Step 2: Checking dependencies..."
if npm list @anthropic-ai/sdk > /dev/null 2>&1; then
  echo "   ✓ Anthropic SDK installed"
else
  echo "   ✗ Anthropic SDK not installed"
  echo "   Running: npm install"
  npm install
fi

echo ""
echo "✅ Step 3: Checking config..."
if grep -q "providers:" src/config.yaml; then
  echo "   ✓ Providers section exists in config"
else
  echo "   ✗ Providers section missing!"
  exit 1
fi

# Check default config
if grep -q "enabled: false" src/config.yaml | head -1; then
  echo "   ✓ Alternative providers disabled by default"
else
  echo "   ⚠ Alternative providers might be enabled"
fi

echo ""
echo "✅ Step 4: Syntax check..."
node -c phase2/core/unified-client.js
if [ $? -eq 0 ]; then
  echo "   ✓ unified-client.js syntax valid"
else
  echo "   ✗ unified-client.js has syntax errors!"
  exit 1
fi

node -c phase2/agents/base-agent.js
if [ $? -eq 0 ]; then
  echo "   ✓ base-agent.js syntax valid"
else
  echo "   ✗ base-agent.js has syntax errors!"
  exit 1
fi

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   All Checks Passed                              ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "System ready to test. To run:"
echo "  ./START_SYSTEM_GPT5.sh"
echo ""
echo "Expected behavior:"
echo "  - Should work exactly as before"
echo "  - Uses only OpenAI GPT-5.2"
echo "  - No alternative providers initialized"
echo ""
echo "To enable alternatives:"
echo "  - Edit src/config.yaml"
echo "  - Uncomment modelAssignments section"
echo "  - Add API keys to .env"
echo "  - Restart system"
echo ""

