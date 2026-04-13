#!/bin/bash
# COSMO IDE - SSL Certificate Regeneration Script
# Generates new self-signed SSL certificates after git history cleanup
#
# Run this AFTER cleaning git history to ensure old private key is invalidated

set -e

echo "🔐 COSMO IDE SSL Certificate Regeneration"
echo "=========================================="
echo ""

# Verify we're in the right directory
if [[ ! -f "package.json" ]]; then
    echo "❌ ERROR: Not in COSMO IDE root directory"
    exit 1
fi

# Create ssl directory if it doesn't exist
mkdir -p ssl

# Backup existing certs (if any)
if [[ -f "ssl/key.pem" ]] || [[ -f "ssl/cert.pem" ]]; then
    echo "📦 Backing up existing certificates..."
    mkdir -p ssl/backup
    [[ -f "ssl/key.pem" ]] && mv ssl/key.pem ssl/backup/key.pem.old
    [[ -f "ssl/cert.pem" ]] && mv ssl/cert.pem ssl/backup/cert.pem.old
    echo "✅ Old certificates backed up to ssl/backup/"
    echo ""
fi

# Get Pi IP (or use default)
PI_IP="192.168.7.136"  # Updated Pi IP from TOOLS.md
read -p "Pi IP address (default: $PI_IP): " input_ip
[[ -n "$input_ip" ]] && PI_IP="$input_ip"

echo ""
echo "🔑 Generating new SSL certificates..."
echo "   IP: $PI_IP"
echo "   Validity: 365 days"
echo ""

# Generate new self-signed certificate
openssl req -x509 -newkey rsa:4096 \
    -keyout ssl/key.pem \
    -out ssl/cert.pem \
    -days 365 \
    -nodes \
    -subj "/C=US/ST=Local/L=Local/O=COSMO IDE/OU=Dev/CN=$PI_IP"

echo "✅ New certificates generated!"
echo ""

# Verify gitignore is working
echo "🔍 Verification:"
GIT_STATUS=$(git status --porcelain ssl/ | wc -l)

if [[ $GIT_STATUS -eq 0 ]]; then
    echo "✅ .gitignore is working (ssl/ files not tracked)"
else
    echo "⚠️  WARNING: Git is tracking files in ssl/"
    git status ssl/
    echo ""
    echo "Check .gitignore contains:"
    echo "  ssl/"
    echo "  *.pem"
    echo "  *.key"
fi

echo ""
echo "📋 Certificate info:"
openssl x509 -in ssl/cert.pem -noout -subject -dates

echo ""
echo "✅ DONE! New certificates ready for use."
echo ""
echo "Next steps:"
echo "  1. Restart COSMO IDE: pm2 restart cosmo-ide"
echo "  2. Test HTTPS: https://jtrpi.local:4443/"
echo "  3. Accept new certificate warning in browser"
