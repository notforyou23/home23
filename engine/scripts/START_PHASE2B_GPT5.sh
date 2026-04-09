#!/bin/bash
# Start Cosmo - The Autonomous Brain

echo "╔══════════════════════════════════════════════════╗"
echo "║   COSMO - Starting the Autonomous Brain...      ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

cd "$(dirname "$0")/.."

# Check dependencies
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    echo ""
fi

# Check .env
if [ ! -f ".env" ]; then
    echo "Creating .env file from template..."
    cp .env.example .env
    echo ""
    echo "⚠️  Please edit .env file and add your OPENAI_API_KEY"
    echo "   OPENAI_API_KEY=your_openai_api_key_here"
    echo ""
fi

echo "Cosmo Capabilities:"
echo "  🧠 Autonomous thought generation"
echo "  ⭐ GPT-5.2 Extended Reasoning"
echo "  🌐 Web Search (autonomous research)"
echo "  ⚡ Multi-model optimization"
echo "  🤖 Specialist Agent Swarm:"
echo "     • Research Agent (web search)"
echo "     • Analysis Agent (deep reasoning)"
echo "     • Synthesis Agent (report writing)"
echo "     • Exploration Agent (creative thinking)"
echo "     • Code Execution Agent (computational validation)"
echo ""
echo "🚀 Launching Cosmo..."
echo "   Dashboard will be available at: http://localhost:3343"
echo "   (Make sure MCP server is running: ./START_MCP_3347.sh)"
echo ""

node --expose-gc src/index.js

