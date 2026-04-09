#!/bin/bash
# Start MCP Filesystem Server
# This provides read_file and list_directory tools to COSMO agents

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "🗂️  Starting MCP Filesystem Server..."
echo ""
echo "  Root: $PROJECT_ROOT"
echo "  Port: 3337"
echo "  Tools: read_file, list_directory"
echo ""
echo "This server allows COSMO agents to read repository files."
echo "Keep this running while COSMO is active."
echo ""
echo "Press Ctrl+C to stop"
echo ""

node mcp/filesystem-server.js 3337
