#!/bin/bash
set -euo pipefail

echo "🔐 Evobrew security release gate"
echo ""

echo "1) Running repository secret/history checks..."
./verify-security.sh
echo ""

echo "2) Running dependency audit gate (prod dependencies)..."
node scripts/audit-release-gate.js
echo ""

echo "3) Validating internet profile env contract..."
node scripts/validate-internet-config.js
echo ""

echo "4) Running security smoke checks..."
node scripts/security-smoke.js
echo ""

echo "✅ security:release passed"
