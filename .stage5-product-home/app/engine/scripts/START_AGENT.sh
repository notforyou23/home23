#!/bin/bash
# Quick start script for the self-propelled AI agent

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║   Starting Phase 1 Self-Propelled AI Agent      ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
echo "The agent will think autonomously..."
echo "Press Ctrl+C to stop gracefully"
echo ""
echo "Logs will be saved to: self-agent-logs/"
echo ""

node self-agent/index.js
