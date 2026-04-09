#!/bin/bash
# Update Base Autonomous Config with Embedding Improvements

echo "🔧 Updating config.yaml.autonomous with embedding improvements..."
echo ""

# Backup current autonomous config
if [ -f "src/config.yaml.autonomous" ]; then
    cp src/config.yaml.autonomous src/config.yaml.autonomous.backup
    echo "✅ Backed up: config.yaml.autonomous.backup"
fi

echo "✅ Updated: config.yaml.autonomous"
echo ""
echo "Changes applied:"
echo "  • Embedding dimensions: 1536 → 512/1536/256"
echo "  • default: 512 (3x faster, 67% less storage)"
echo "  • highPrecision: 1536 (critical nodes)"
echo "  • fastComparison: 256 (novelty checks)"
echo ""
echo "This is now your optimized base template! 🚀"

