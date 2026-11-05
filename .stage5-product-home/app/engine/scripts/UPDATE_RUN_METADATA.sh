#!/bin/bash
# Update run metadata to include missing file access fields
# This script adds fileAccessEnabled and fileAccessPaths to older runs

set -e

cd "$(dirname "$0")/.."
COSMO_ROOT="$(pwd)"
RUNS_DIR="$COSMO_ROOT/runs"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║         Update Run Metadata - Add File Access Fields      ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

if [ ! -d "$RUNS_DIR" ]; then
    echo "❌ No runs directory found"
    exit 1
fi

# Count runs
run_count=$(ls -1 "$RUNS_DIR" 2>/dev/null | wc -l | tr -d ' ')

if [ "$run_count" -eq 0 ]; then
    echo "No runs found in $RUNS_DIR"
    exit 0
fi

echo "Found $run_count run(s)"
echo ""

updated_count=0
skipped_count=0
error_count=0

for run_dir in "$RUNS_DIR"/*; do
    if [ -d "$run_dir" ]; then
        run_name=$(basename "$run_dir")
        metadata_file="$run_dir/run-metadata.json"
        
        if [ ! -f "$metadata_file" ]; then
            echo "⚠️  $run_name: No metadata file, skipping"
            ((skipped_count++))
            continue
        fi
        
        # Check if already has file access fields
        if grep -q '"fileAccessEnabled"' "$metadata_file"; then
            echo "✓  $run_name: Already has file access fields"
            ((skipped_count++))
            continue
        fi
        
        echo "📝 Updating $run_name..."
        
        # Determine default file access based on domain/directive
        domain=$(grep '"domain"' "$metadata_file" | sed 's/.*"domain": "\([^"]*\)".*/\1/' || echo "")
        
        # Smart defaults based on domain
        if echo "$domain" | grep -qi "personal"; then
            default_paths="personal/"
        elif echo "$domain" | grep -qi "business"; then
            default_paths="business/"
        elif echo "$domain" | grep -qi "src\|code"; then
            default_paths="src/"
        else
            default_paths="docs/"
        fi
        
        # Update metadata using jq
        if command -v jq &> /dev/null; then
            cat "$metadata_file" | jq ". + {fileAccessEnabled: true, fileAccessPaths: \"$default_paths\"}" > "$metadata_file.tmp"
            if [ $? -eq 0 ]; then
                mv "$metadata_file.tmp" "$metadata_file"
                echo "   ✅ Updated with fileAccessPaths: $default_paths"
                ((updated_count++))
            else
                echo "   ❌ jq failed"
                rm -f "$metadata_file.tmp"
                ((error_count++))
            fi
        else
            echo "   ❌ jq not found - cannot update"
            ((error_count++))
        fi
    fi
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Summary:"
echo "  Updated:  $updated_count"
echo "  Skipped:  $skipped_count"
echo "  Errors:   $error_count"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ $updated_count -gt 0 ]; then
    echo "✅ Run metadata updated successfully"
    echo ""
    echo "Note: File access paths were set based on domain/directive."
    echo "      You can manually edit run-metadata.json files if needed."
fi

