#!/bin/bash
# Quick verification script - Run after Git history cleanup
# This should output NOTHING if cleanup was successful

set -e

echo "🔍 Security Verification Script"
echo "================================"
echo ""

cd /Users/jtr/_JTR23_/cosmo_ide_v2_dev

echo "1️⃣ Checking for API keys/tokens in Git history..."
SECRETS=$(git log --all -p | grep -E "sk-ant-|sk-proj-|xai-" | grep -v "your_" | grep -v "example" | grep -v "placeholder" | grep -v "documentation" || true)
if [ -z "$SECRETS" ]; then
    echo "   ✅ No secrets found"
else
    echo "   ❌ SECRETS FOUND:"
    echo "$SECRETS"
    exit 1
fi

echo ""
echo "2️⃣ Checking for database files in Git history..."
DB_FILES=$(git log --all --name-only | grep "\.db$" || true)
if [ -z "$DB_FILES" ]; then
    echo "   ✅ No database files found"
else
    echo "   ❌ DATABASE FILES FOUND:"
    echo "$DB_FILES"
    exit 1
fi

echo ""
echo "3️⃣ Checking for SSL files in Git history..."
SSL_FILES=$(git log --all --name-only | grep "ssl/" || true)
if [ -z "$SSL_FILES" ]; then
    echo "   ✅ No SSL files found"
else
    echo "   ❌ SSL FILES FOUND:"
    echo "$SSL_FILES"
    exit 1
fi

echo ""
echo "4️⃣ Checking for conversation files in Git history..."
CONV_FILES=$(git log --all --name-only | grep "conversations/" || true)
if [ -z "$CONV_FILES" ]; then
    echo "   ✅ No conversation files found"
else
    echo "   ❌ CONVERSATION FILES FOUND:"
    echo "$CONV_FILES"
    exit 1
fi

echo ""
echo "5️⃣ Checking .gitignore coverage..."
MISSING_RULES=()
if ! grep -q "^\.env$" .gitignore; then
    MISSING_RULES+=(".env")
fi
if ! grep -q "^ssl/" .gitignore; then
    MISSING_RULES+=("ssl/")
fi
if ! grep -q "^conversations/" .gitignore; then
    MISSING_RULES+=("conversations/")
fi
if ! grep -q "^\*\.db$" .gitignore && ! grep -q "^\.db$" .gitignore; then
    MISSING_RULES+=("*.db")
fi

if [ ${#MISSING_RULES[@]} -eq 0 ]; then
    echo "   ✅ All critical patterns in .gitignore"
else
    echo "   ⚠️  Missing .gitignore rules: ${MISSING_RULES[*]}"
fi

echo ""
echo "6️⃣ Checking if SSL certificates exist on disk..."
if [ -f "ssl/key.pem" ] && [ -f "ssl/cert.pem" ]; then
    echo "   ✅ SSL certificates present"
    # Check if they're new (not the compromised ones)
    CERT_DATE=$(openssl x509 -in ssl/cert.pem -text -noout | grep "Not Before" | head -1)
    echo "   📅 Certificate date: $CERT_DATE"
else
    echo "   ⚠️  SSL certificates missing - run regeneration step"
fi

echo ""
echo "7️⃣ Checking for .env file (should NOT be in Git)..."
ENV_IN_GIT=$(git ls-files | grep "^\.env$" || true)
if [ -z "$ENV_IN_GIT" ]; then
    echo "   ✅ .env not in Git"
else
    echo "   ❌ .env IS IN GIT - should be removed!"
    exit 1
fi

echo ""
echo "================================"
echo "✅ All checks passed!"
echo ""
echo "Next steps:"
echo "  1. Push to PRIVATE test repo"
echo "  2. Manually review on GitHub"
echo "  3. Only then make public"
echo ""
