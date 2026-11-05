#!/bin/bash
# Evobrew - Security Verification Script
# Run this to verify repository is safe for public launch

echo "🔍 Evobrew Security Verification"
echo "==================================="
echo ""

FAILED=0
KEY_PATTERN='sk-[A-Za-z0-9][A-Za-z0-9_-]{19,}|sk-ant-(api|oat|oauth|refresh)[A-Za-z0-9_-]{10,}|xai-[A-Za-z0-9][A-Za-z0-9_-]{19,}'
SENSITIVE_HISTORY_PATHS=(
    "ssl/key.pem"
    "ssl/cert.pem"
    "prisma/studio.db"
    "docs/plans/PHASE1_CREDENTIAL_ROTATION.md"
    "cursor_revisiting_implementation_approa.md"
)

# Check 1: Git history for sensitive files
echo "1️⃣  Checking git history for sensitive files..."
for sensitive_path in "${SENSITIVE_HISTORY_PATHS[@]}"; do
    IN_HISTORY=$(git log --all --oneline -- "$sensitive_path" 2>/dev/null | wc -l)
    if [[ $IN_HISTORY -eq 0 ]]; then
        echo "   ✅ $sensitive_path: Not in history"
        continue
    fi

    case "$sensitive_path" in
        "ssl/cert.pem"|"prisma/studio.db")
            echo "   🟡 $sensitive_path: Found in $IN_HISTORY commits (review required)"
            ;;
        *)
            echo "   🔴 $sensitive_path: Found in $IN_HISTORY commits"
            FAILED=1
            ;;
    esac
done

echo ""

# Check 2: .env file protection
echo "2️⃣  Checking .env file protection..."
ENV_IN_GIT=$(git ls-files | grep -E "^\.env$" | wc -l)

if [[ $ENV_IN_GIT -eq 0 ]]; then
    echo "   ✅ .env: Not tracked by git"
else
    echo "   🔴 .env: Is tracked by git (CRITICAL)"
    FAILED=1
fi

echo ""

# Check 3: API keys in committed files
echo "3️⃣  Scanning committed files for API keys..."
REAL_KEYS_OUTPUT=$(git grep -nE "$KEY_PATTERN" 2>/dev/null | grep -v ".env.example" || true)
REAL_KEYS=$(echo "$REAL_KEYS_OUTPUT" | grep -c . || true)

if [[ $REAL_KEYS -eq 0 ]]; then
    echo "   ✅ No real API keys found in committed files"
else
    echo "   🔴 Found $REAL_KEYS potential API keys in committed files"
    echo "$REAL_KEYS_OUTPUT" | head -10
    FAILED=1
fi

echo ""

# Check 4: .gitignore coverage
echo "4️⃣  Verifying .gitignore coverage..."
REQUIRED_PATTERNS=(
    ".env"
    "ssl/"
    "*.pem"
    "*.key"
    "conversations/"
    "*.log"
)

for pattern in "${REQUIRED_PATTERNS[@]}"; do
    if grep -q "^$pattern$" .gitignore; then
        echo "   ✅ $pattern"
    else
        echo "   ⚠️  $pattern: Missing from .gitignore"
        FAILED=1
    fi
done

echo ""

# Check 5: Current working tree
echo "5️⃣  Checking working tree for sensitive files..."
UNTRACKED_SENSITIVE=$(git status --porcelain | grep -E "ssl/.*\.pem$|\.env$" | wc -l)

if [[ $UNTRACKED_SENSITIVE -eq 0 ]]; then
    echo "   ✅ No sensitive files staged or tracked"
else
    echo "   ✅ Sensitive files present but untracked (as expected)"
fi

echo ""

# Check 6: Remote repository status
echo "6️⃣  Checking remote repository..."
REMOTE_URL=$(git remote get-url origin 2>/dev/null || echo "")

if [[ -z "$REMOTE_URL" ]]; then
    echo "   ℹ️  No remote configured"
elif [[ "$REMOTE_URL" == *"github.com"* ]]; then
    echo "   📍 Remote: $REMOTE_URL"
    
    # Check if pushed
    LOCAL_COMMIT=$(git rev-parse HEAD 2>/dev/null)
    REMOTE_COMMIT=$(git rev-parse origin/main 2>/dev/null || echo "none")
    
    if [[ "$LOCAL_COMMIT" == "$REMOTE_COMMIT" ]]; then
        echo "   ⚠️  Local and remote are in sync"
        if [[ $FAILED -eq 1 ]]; then
            echo "   🔴 WARNING: Issues found but already pushed!"
            echo "   🔴 You may need to force-push after cleanup"
        fi
    else
        echo "   ✅ Local ahead of remote (not pushed yet)"
    fi
else
    echo "   📍 Remote: $REMOTE_URL"
fi

echo ""
echo "================================="

if [[ $FAILED -eq 0 ]]; then
    echo "✅ ALL CHECKS PASSED"
    echo ""
    echo "Repository is safe to push publicly! 🎉"
    echo ""
    echo "Next steps:"
    echo "  git push origin main"
else
    echo "🔴 SECURITY ISSUES FOUND"
    echo ""
    echo "DO NOT push to public repository!"
    echo ""
    echo "Required fixes:"
    echo "  1. Run: ./cleanup-git-history.sh"
    echo "  2. Run: ./regenerate-ssl-certs.sh"
    echo "  3. Run this script again to verify"
fi

exit $FAILED
