#!/bin/bash

# Start Filesystem MCP Server for Personal Knowledge Base
# 
# Usage:
#   ./START_PERSONAL_KNOWLEDGE_MCP.sh /path/to/your/files
#
# This serves a directory of your files via MCP so COSMO can read them.
# COSMO agents can then ingest these files into memory as foundational knowledge.

# Configuration
PORT=3350  # Different port to avoid conflicts
KNOWLEDGE_DIR="${1:-$HOME/Documents}"  # Default to Documents, or use provided path

echo "🗂️  Starting Personal Knowledge MCP Server"
echo ""
echo "  Port: $PORT"
echo "  Directory: $KNOWLEDGE_DIR"
echo ""

# Verify directory exists
if [ ! -d "$KNOWLEDGE_DIR" ]; then
    echo "❌ Error: Directory does not exist: $KNOWLEDGE_DIR"
    echo ""
    echo "Usage: $0 /path/to/your/knowledge/directory"
    exit 1
fi

# Check if port is already in use
if lsof -Pi :$PORT -sTCP:LISTEN -t >/dev/null 2>&1 ; then
    echo "⚠️  Port $PORT already in use. Stopping existing server..."
    kill $(lsof -t -i:$PORT) 2>/dev/null
    sleep 1
fi

echo "✅ Starting MCP server..."
echo "   Serving: $KNOWLEDGE_DIR"
echo "   Access: http://localhost:$PORT"
echo ""
echo "Add to config.yaml:"
echo "  personal_knowledge:"
echo "    enabled: true"
echo "    type: rest"
echo "    baseURL: \"http://localhost:$PORT\""
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Start the server
cd "$(dirname "$0")/../mcp"
node filesystem-server.js $PORT "$KNOWLEDGE_DIR"

