#!/bin/bash
# Evobrew - Git History Cleanup Script
# Removes sensitive files from git history before public launch
# 
# ⚠️ WARNING: This rewrites git history. Run BEFORE pushing to GitHub.

set -e

SENSITIVE_PATHS=(
  "ssl/key.pem"
  "ssl/cert.pem"
  "prisma/studio.db"
  "docs/plans/PHASE1_CREDENTIAL_ROTATION.md"
  "cursor_revisiting_implementation_approa.md"
)

echo "🔍 Evobrew Git History Cleanup"
echo "================================="
echo ""

# Check if BFG is installed
if command -v bfg &> /dev/null; then
    echo "✅ BFG Repo-Cleaner found"
    CLEANUP_METHOD="bfg"
elif command -v git-filter-repo &> /dev/null; then
    echo "✅ git-filter-repo found"
    CLEANUP_METHOD="filter-repo"
else
    echo "❌ ERROR: Neither BFG nor git-filter-repo found"
    echo ""
    echo "Install one of:"
    echo "  brew install bfg           (recommended - faster)"
    echo "  brew install git-filter-repo"
    exit 1
fi

echo ""
echo "📋 Files to remove from history:"
for file in "${SENSITIVE_PATHS[@]}"; do
    echo "  - $file"
done
echo ""

# Verify we're in the right directory
if [[ ! -f "package.json" ]] || [[ ! -d ".git" ]]; then
    echo "❌ ERROR: Not in Evobrew root directory"
    exit 1
fi

# Create backup
echo "📦 Creating backup..."
BACKUP_DIR="../evobrew_backup_$(date +%Y%m%d_%H%M%S)"
cp -r . "$BACKUP_DIR"
echo "✅ Backup created at: $BACKUP_DIR"
echo ""

# Confirm before proceeding
read -p "⚠️  This will REWRITE git history. Continue? (yes/no): " confirm
if [[ "$confirm" != "yes" ]]; then
    echo "❌ Cancelled"
    exit 0
fi

echo ""
echo "🧹 Cleaning git history..."

if [[ "$CLEANUP_METHOD" == "bfg" ]]; then
    # BFG method (faster)
    for sensitive_path in "${SENSITIVE_PATHS[@]}"; do
        bfg --delete-files "$(basename "$sensitive_path")"
    done
    git reflog expire --expire=now --all
    git gc --prune=now --aggressive
else
    # git-filter-repo method (more thorough)
    for sensitive_path in "${SENSITIVE_PATHS[@]}"; do
        git filter-repo --path "$sensitive_path" --invert-paths --force
    done
fi

echo ""
echo "✅ Git history cleaned!"
echo ""

# Verification
echo "🔍 Verification:"
echo ""

REMAINING=0
for sensitive_path in "${SENSITIVE_PATHS[@]}"; do
    CHECK=$(git log --all --oneline -- "$sensitive_path" | wc -l)
    if [[ $CHECK -eq 0 ]]; then
        echo "✅ $sensitive_path: REMOVED (0 commits found)"
    else
        echo "⚠️  $sensitive_path: Found in $CHECK commits"
        REMAINING=1
    fi
done

if [[ $REMAINING -eq 0 ]]; then
    echo ""
    echo "🎉 SUCCESS! Repository is now clean."
    echo ""
    echo "📋 Next steps:"
    echo "  1. Regenerate SSL certificates: ./regenerate-ssl-certs.sh"
    echo "  2. Verify .gitignore is working: git status ssl/"
    echo "  3. Run security scan again to confirm"
    echo "  4. Safe to push to GitHub: git push origin main"
else
    echo "⚠️  WARNING: Some files still found in history:"
    echo ""
    echo "Consider using the nuclear option (fresh git init)"
fi
