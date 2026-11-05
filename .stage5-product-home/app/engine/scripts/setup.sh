#!/bin/bash
# COSMO Initial Setup & Deployment Verification Script
# Run this on a fresh deployment before launching COSMO

set -e  # Exit on any error

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║           🔧 COSMO SETUP & DEPLOYMENT CHECK                ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Get to COSMO root
cd "$(dirname "$0")/.."
COSMO_ROOT="$(pwd)"

# Track errors
ERRORS=0
WARNINGS=0

# ============================================================
# 1. Check Node.js
# ============================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1️⃣  Checking Node.js..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js not found${NC}"
    echo "   Install from: https://nodejs.org/ (v18.0.0 or higher required)"
    ERRORS=$((ERRORS + 1))
else
    NODE_VERSION=$(node --version | sed 's/v//')
    NODE_MAJOR=$(echo $NODE_VERSION | cut -d. -f1)
    
    if [ "$NODE_MAJOR" -ge 18 ]; then
        echo -e "${GREEN}✅ Node.js v$NODE_VERSION${NC}"
    else
        echo -e "${RED}❌ Node.js v$NODE_VERSION (v18+ required)${NC}"
        ERRORS=$((ERRORS + 1))
    fi
fi

# ============================================================
# 2. Install Dependencies
# ============================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "2️⃣  Installing Dependencies..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ! -d "node_modules" ]; then
    echo "Installing npm packages..."
    npm install
    echo -e "${GREEN}✅ Dependencies installed${NC}"
else
    echo -e "${BLUE}ℹ️  node_modules exists, verifying...${NC}"
    
    # Check for critical packages
    CRITICAL_PACKAGES=("js-yaml" "dotenv" "express" "openai")
    MISSING=0
    
    for pkg in "${CRITICAL_PACKAGES[@]}"; do
        if [ ! -d "node_modules/$pkg" ]; then
            echo -e "${YELLOW}⚠️  Missing package: $pkg${NC}"
            MISSING=$((MISSING + 1))
        fi
    done
    
    if [ $MISSING -gt 0 ]; then
        echo "Running npm install to fix missing packages..."
        npm install
        echo -e "${GREEN}✅ Dependencies updated${NC}"
    else
        echo -e "${GREEN}✅ All critical packages present${NC}"
    fi
fi

# ============================================================
# 3. Create Required Directories
# ============================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "3️⃣  Creating Required Directories..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

DIRS=(
    "logs"
    "runs"
    "backups"
)

# Note: runtime/ is NOT created here - it's a symlink managed by LAUNCH_COSMO.sh

for dir in "${DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
        mkdir -p "$dir"
        echo -e "${GREEN}✅ Created: $dir/${NC}"
    else
        echo -e "${BLUE}ℹ️  Exists: $dir/${NC}"
    fi
done

# ============================================================
# 4. Environment Variables Setup
# ============================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "4️⃣  Checking Environment Variables..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo -e "${YELLOW}⚠️  .env not found, creating from .env.example${NC}"
        cp .env.example .env
        echo -e "${GREEN}✅ Created .env file${NC}"
        echo -e "${YELLOW}⚠️  YOU MUST ADD YOUR API KEYS TO .env BEFORE LAUNCHING!${NC}"
        WARNINGS=$((WARNINGS + 1))
    else
        echo -e "${RED}❌ .env.example not found${NC}"
        ERRORS=$((ERRORS + 1))
    fi
else
    echo -e "${GREEN}✅ .env exists${NC}"
    
    # Check for required keys
    REQUIRED_KEYS=("OPENAI_API_KEY")
    OPTIONAL_KEYS=("XAI_API_KEY" "ANTHROPIC_API_KEY")
    
    for key in "${REQUIRED_KEYS[@]}"; do
        if grep -q "^${key}=" .env; then
            value=$(grep "^${key}=" .env | cut -d'=' -f2)
            if [ -z "$value" ] || [ "$value" = "your-api-key-here" ]; then
                echo -e "${RED}❌ $key is empty or placeholder${NC}"
                ERRORS=$((ERRORS + 1))
            else
                # Don't show the actual key, just verify it exists
                echo -e "${GREEN}✅ $key is set${NC}"
            fi
        else
            echo -e "${RED}❌ $key not found in .env${NC}"
            ERRORS=$((ERRORS + 1))
        fi
    done
    
    # Check optional keys
    for key in "${OPTIONAL_KEYS[@]}"; do
        if grep -q "^${key}=" .env; then
            value=$(grep "^${key}=" .env | cut -d'=' -f2)
            if [ -n "$value" ] && [ "$value" != "your-api-key-here" ]; then
                echo -e "${BLUE}ℹ️  $key is configured${NC}"
            fi
        fi
    done
fi

# Check for system environment variables that will override .env
echo ""
if [ -n "$OPENAI_API_KEY" ]; then
    echo -e "${RED}❌ OPENAI_API_KEY is set in your system environment${NC}"
    echo "   This will override your .env file!"
    echo "   Run: unset OPENAI_API_KEY"
    echo "   Then remove it from ~/.zshrc or ~/.bashrc"
    ERRORS=$((ERRORS + 1))
fi

# ============================================================
# 5. Verify API Key (Optional but Recommended)
# ============================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "5️⃣  API Key Validation (Optional)..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

read -p "Test OpenAI API key? (y/N): " test_api
if [[ "$test_api" =~ ^[Yy]$ ]]; then
    if [ -f ".env" ]; then
        source .env
        if [ -n "$OPENAI_API_KEY" ]; then
            echo "Testing API key..."
            # Simple curl test
            response=$(curl -s -o /dev/null -w "%{http_code}" \
                -H "Authorization: Bearer $OPENAI_API_KEY" \
                -H "Content-Type: application/json" \
                -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"test"}],"max_tokens":5}' \
                https://api.openai.com/v1/chat/completions 2>/dev/null || echo "000")
            
            if [ "$response" = "200" ]; then
                echo -e "${GREEN}✅ OpenAI API key is valid${NC}"
            elif [ "$response" = "401" ]; then
                echo -e "${RED}❌ OpenAI API key is invalid or revoked${NC}"
                ERRORS=$((ERRORS + 1))
            elif [ "$response" = "000" ]; then
                echo -e "${YELLOW}⚠️  Could not test API key (network error)${NC}"
                WARNINGS=$((WARNINGS + 1))
            else
                echo -e "${YELLOW}⚠️  API returned code: $response${NC}"
                WARNINGS=$((WARNINGS + 1))
            fi
        fi
    fi
else
    echo -e "${BLUE}ℹ️  Skipping API key test${NC}"
fi

# ============================================================
# 6. Check for Common Issues
# ============================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "6️⃣  Checking for Common Issues..."
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Check for .env copy or similar backup files
if ls .env* 2>/dev/null | grep -v "^.env$" | grep -v ".env.example" > /dev/null; then
    echo -e "${YELLOW}⚠️  Found .env backup files:${NC}"
    ls .env* | grep -v "^.env$" | grep -v ".env.example" | while read file; do
        echo "   - $file (should be deleted or added to .gitignore)"
    done
    WARNINGS=$((WARNINGS + 1))
fi

# Check for parent directory .env that could interfere
if [ -f "../.env" ]; then
    echo -e "${YELLOW}⚠️  Found .env in parent directory (../.env)${NC}"
    echo "   This could interfere with COSMO's configuration."
    echo "   COSMO now only uses the local .env file."
    WARNINGS=$((WARNINGS + 1))
fi

# Check if logs/ is properly in .gitignore
if [ -f ".gitignore" ]; then
    if grep -q "^logs/" .gitignore; then
        echo -e "${GREEN}✅ logs/ is gitignored${NC}"
    else
        echo -e "${YELLOW}⚠️  logs/ not in .gitignore${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
fi

# Check for port conflicts
PORTS=(3344 3346 3347)
for port in "${PORTS[@]}"; do
    if lsof -i :$port > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  Port $port is already in use${NC}"
        WARNINGS=$((WARNINGS + 1))
    fi
done

# ============================================================
# SUMMARY
# ============================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Setup Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
    echo -e "${GREEN}✅ ALL CHECKS PASSED!${NC}"
    echo ""
    echo "You're ready to launch COSMO:"
    echo "  ./scripts/LAUNCH_COSMO.sh"
    echo ""
    exit 0
elif [ $ERRORS -eq 0 ]; then
    echo -e "${YELLOW}⚠️  Setup complete with $WARNINGS warning(s)${NC}"
    echo ""
    echo "Review warnings above, then launch with:"
    echo "  ./scripts/LAUNCH_COSMO.sh"
    echo ""
    exit 0
else
    echo -e "${RED}❌ Found $ERRORS error(s) and $WARNINGS warning(s)${NC}"
    echo ""
    echo "Please fix the errors above before launching COSMO."
    echo ""
    exit 1
fi
