#!/bin/bash
# Install git hooks to prevent committing sensitive files

echo "🔧 Installing Git Security Hooks"
echo "================================"
echo ""

# Create pre-commit hook
cat > .git/hooks/pre-commit << 'EOF'
#!/bin/bash
# Pre-commit hook to prevent committing sensitive files

echo "🔍 Checking for sensitive files..."

# Check for sensitive files being committed
SENSITIVE_FILES=$(git diff --cached --name-only | grep -E "\.env$|ssl/.*\.pem$|.*\.key$|.*\.db$")

if [[ -n "$SENSITIVE_FILES" ]]; then
    echo ""
    echo "❌ ERROR: Attempting to commit sensitive files:"
    echo ""
    echo "$SENSITIVE_FILES" | while read file; do
        echo "   🔴 $file"
    done
    echo ""
    echo "These files should be in .gitignore:"
    echo "   .env, ssl/*.pem, *.key, *.db"
    echo ""
    echo "To bypass (NOT RECOMMENDED):"
    echo "   git commit --no-verify"
    echo ""
    exit 1
fi

# Check for real API keys in staged files
API_KEY_PATTERNS="sk-ant-api[0-9]|sk-proj-[A-Za-z0-9]{20,}|xai-[A-Za-z0-9]{30,}"
STAGED_WITH_KEYS=$(git diff --cached | grep -E "$API_KEY_PATTERNS" | grep -v "your_" | grep -v "example")

if [[ -n "$STAGED_WITH_KEYS" ]]; then
    echo ""
    echo "⚠️  WARNING: Potential API keys found in staged changes:"
    echo ""
    echo "$STAGED_WITH_KEYS" | head -3
    echo ""
    read -p "Continue anyway? (yes/no): " confirm
    if [[ "$confirm" != "yes" ]]; then
        echo "❌ Commit cancelled"
        exit 1
    fi
fi

echo "✅ No sensitive files detected"
EOF

# Make hook executable
chmod +x .git/hooks/pre-commit

echo "✅ Pre-commit hook installed!"
echo ""
echo "This hook will prevent commits of:"
echo "  - .env files"
echo "  - SSL certificates/keys"
echo "  - Database files"
echo "  - Files with real API keys"
echo ""
echo "Test it:"
echo "  echo 'test' >> .env"
echo "  git add .env"
echo "  git commit -m 'test'  # Should be blocked"
echo ""
echo "To bypass (emergency only):"
echo "  git commit --no-verify"
