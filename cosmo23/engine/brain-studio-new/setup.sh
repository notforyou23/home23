#!/bin/bash

# COSMO Brain Platform Setup Script
# Professional standalone deployment tool

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║              🧠 COSMO BRAIN PLATFORM SETUP                   ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# 1. Check Node.js
if ! command -v node &> /dev/null; then
    echo "❌ Error: Node.js is not installed. Please install Node.js 18+."
    exit 1
fi

echo "✅ Node.js detected: $(node -v)"

# 2. Install dependencies
echo "📦 Installing dependencies..."
npm install

# 3. Setup environment
if [ ! -f .env ]; then
    echo "⚙️  Creating .env from template..."
    cp .env.example .env
    echo "⚠️  Action Required: Please edit .env and add your API keys."
else
    echo "✅ .env already exists."
fi

# 4. Create brains directory
if [ ! -d brains ]; then
    echo "📁 Creating 'brains' directory..."
    mkdir brains
else
    echo "✅ 'brains' directory exists."
fi

echo ""
echo "🎉 Setup complete!"
echo "----------------------------------------------------------------"
echo "🚀 To start the platform:"
echo "   npm start"
echo ""
echo "🌐 Browser will be available at: http://localhost:3398"
echo "----------------------------------------------------------------"

