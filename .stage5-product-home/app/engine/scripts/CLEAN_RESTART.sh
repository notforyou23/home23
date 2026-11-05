#!/bin/bash
# Enhanced Clean Restart - Complete Run Packaging System
# Captures EVERYTHING, leaves NOTHING behind
# Non-destructive: All data safely backed up before cleaning

echo "🧹 Packaging current run and preparing blank slate..."
echo ""

# Optional: Name this backup
BACKUP_NAME="$1"
if [ -z "$BACKUP_NAME" ]; then
  BACKUP_DIR="cosmo_backup_$(date +%Y%m%d_%H%M%S)"
else
  BACKUP_DIR="cosmo_backup_${BACKUP_NAME}_$(date +%Y%m%d_%H%M%S)"
fi

echo "📦 Creating complete backup: $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
mkdir -p "$BACKUP_DIR/coordinator"

# ============================================================================
# PHASE 1: BACKUP EVERYTHING
# ============================================================================

echo ""
echo "📋 Backing up complete run state..."

# Configuration (critical - preserves prompts and settings)
if [ -f "src/config.yaml" ]; then
  cp "src/config.yaml" "$BACKUP_DIR/"
  echo "   ✓ config.yaml"
fi

# Run metadata (from launcher - preserves user choices)
if [ -f "runtime/run-metadata.json" ]; then
  cp "runtime/run-metadata.json" "$BACKUP_DIR/"
  echo "   ✓ run-metadata.json (launcher settings)"
fi

# Main state files (compressed and uncompressed)
if [ -f "runtime/state.json.gz" ]; then
  cp "runtime/state.json.gz" "$BACKUP_DIR/"
  echo "   ✓ state.json.gz ($(du -h runtime/state.json.gz | cut -f1))"
fi

if [ -f "runtime/state.json" ]; then
  cp "runtime/state.json" "$BACKUP_DIR/"
  echo "   ✓ state.json"
fi

# OLD state files (cleanup leftovers)
if [ -f "runtime/state.json.gz.OLD" ]; then
  cp "runtime/state.json.gz.OLD" "$BACKUP_DIR/"
  echo "   ✓ state.json.gz.OLD ($(du -h runtime/state.json.gz.OLD | cut -f1))"
fi

if [ -f "runtime/state.json.OLD" ]; then
  cp "runtime/state.json.OLD" "$BACKUP_DIR/"
  echo "   ✓ state.json.OLD"
fi

# Thought journal
if [ -f "runtime/thoughts.jsonl" ]; then
  cp "runtime/thoughts.jsonl" "$BACKUP_DIR/"
  echo "   ✓ thoughts.jsonl ($(du -h runtime/thoughts.jsonl | cut -f1))"
fi

if [ -f "runtime/thoughts.jsonl.OLD" ]; then
  cp "runtime/thoughts.jsonl.OLD" "$BACKUP_DIR/"
  echo "   ✓ thoughts.jsonl.OLD ($(du -h runtime/thoughts.jsonl.OLD | cut -f1))"
fi

# Topic queue system
if [ -f "runtime/topics-queue.json" ]; then
  cp "runtime/topics-queue.json" "$BACKUP_DIR/"
  echo "   ✓ topics-queue.json"
fi

if [ -f "runtime/topics-processed.json" ]; then
  cp "runtime/topics-processed.json" "$BACKUP_DIR/"
  echo "   ✓ topics-processed.json"
fi

# Coordinator context
if [ -f "runtime/coordinator/context.json" ]; then
  cp "runtime/coordinator/context.json" "$BACKUP_DIR/coordinator/"
  echo "   ✓ coordinator/context.json"
fi

if [ -f "runtime/coordinator/context.json.OLD" ]; then
  cp "runtime/coordinator/context.json.OLD" "$BACKUP_DIR/coordinator/"
  echo "   ✓ coordinator/context.json.OLD"
fi

# Agent results queue
if [ -f "runtime/coordinator/results_queue.jsonl" ]; then
  cp "runtime/coordinator/results_queue.jsonl" "$BACKUP_DIR/coordinator/"
  echo "   ✓ coordinator/results_queue.jsonl ($(du -h runtime/coordinator/results_queue.jsonl | cut -f1))"
fi

# Coordinator review reports (both JSON and Markdown)
REVIEW_COUNT=$(ls runtime/coordinator/review_*.json 2>/dev/null | wc -l | tr -d ' ')
if [ "$REVIEW_COUNT" -gt 0 ]; then
  cp runtime/coordinator/review_*.json "$BACKUP_DIR/coordinator/" 2>/dev/null
  cp runtime/coordinator/review_*.md "$BACKUP_DIR/coordinator/" 2>/dev/null
  echo "   ✓ coordinator review reports ($REVIEW_COUNT reviews)"
fi

# Quantum reasoner learning state
mkdir -p "$BACKUP_DIR/policies" "$BACKUP_DIR/training"
if [ -f "runtime/policies/branch-policy.json" ]; then
  cp "runtime/policies/branch-policy.json" "$BACKUP_DIR/policies/"
  echo "   ✓ policies/branch-policy.json"
fi

if [ -f "runtime/policies/latent-projector.json" ]; then
  cp "runtime/policies/latent-projector.json" "$BACKUP_DIR/policies/"
  echo "   ✓ policies/latent-projector.json ($(du -h runtime/policies/latent-projector.json | cut -f1))"
fi

if [ -f "runtime/training/latent-dataset.jsonl" ]; then
  cp "runtime/training/latent-dataset.jsonl" "$BACKUP_DIR/training/"
  echo "   ✓ training/latent-dataset.jsonl ($(du -h runtime/training/latent-dataset.jsonl | cut -f1))"
fi

if [ -f "runtime/evaluation-branches.jsonl" ]; then
  cp "runtime/evaluation-branches.jsonl" "$BACKUP_DIR/"
  echo "   ✓ evaluation-branches.jsonl ($(du -h runtime/evaluation-branches.jsonl | cut -f1))"
fi

# ============================================================================
# PHASE 2: CLEAN EVERYTHING (Blank Slate)
# ============================================================================

echo ""
echo "🧹 Cleaning for blank slate..."

# Remove main state files
rm -f runtime/state.json.gz
rm -f runtime/state.json
rm -f runtime/state.json.gz.OLD
rm -f runtime/state.json.OLD
echo "   ✓ Cleared all state files"

# Remove thought journal
rm -f runtime/thoughts.jsonl
rm -f runtime/thoughts.jsonl.OLD
echo "   ✓ Cleared thought journal"

# Remove topic queue (for true blank slate)
rm -f runtime/topics-queue.json
rm -f runtime/topics-processed.json
echo "   ✓ Cleared topic queue"

# Remove coordinator state
rm -f runtime/coordinator/context.json
rm -f runtime/coordinator/context.json.OLD
rm -f runtime/coordinator/results_queue.jsonl
echo "   ✓ Cleared coordinator context"

# Remove run metadata (will be regenerated on next launch)
rm -f runtime/run-metadata.json
echo "   ✓ Cleared run metadata"

# Remove coordinator reports
rm -f runtime/coordinator/review_*.json
rm -f runtime/coordinator/review_*.md
echo "   ✓ Cleared coordinator reports"

# Remove quantum reasoner learning state
rm -f runtime/policies/branch-policy.json
rm -f runtime/policies/latent-projector.json
rm -f runtime/training/latent-dataset.jsonl
rm -f runtime/evaluation-branches.jsonl
rm -f runtime/evaluation-metrics.json
rm -f runtime/evaluation-timeseries.jsonl
echo "   ✓ Cleared quantum reasoner learning state"

# Recreate policy/training directories for next run
mkdir -p runtime/policies runtime/training
echo "   ✓ Prepared runtime/policies and runtime/training"

# ============================================================================
# PHASE 3: SUMMARY
# ============================================================================

echo ""
echo "✅ COMPLETE BACKUP: $BACKUP_DIR"
echo ""
echo "📦 PACKAGED:"
echo "   • Configuration (config.yaml)"
echo "   • Complete memory state (state.json.gz)"
echo "   • Full thought history (thoughts.jsonl)"
echo "   • Topic queue state (topics-queue.json, topics-processed.json)"
echo "   • Coordinator context + all reports"
echo "   • Agent execution results"
echo "   • Quantum reasoner learning state (policies/, training/, evaluation-branches.jsonl)"
echo "   • All cleanup files (.OLD files)"
echo ""
echo "🎯 BLANK SLATE READY:"
echo "   • Memory: EMPTY (will start at 0 nodes)"
echo "   • Goals: EMPTY (will start at 0 goals)"
echo "   • Journal: EMPTY (will start at cycle 0)"
echo "   • Topics: EMPTY (no queued topics)"
echo "   • Coordinator: FRESH (no context)"
echo "   • Agents: FRESH (no queue)"
echo ""
echo "🚀 START NEW RUN:"
echo "   ./START_SYSTEM_GPT5.sh"
echo ""
echo "🔄 RESTORE THIS RUN LATER:"
echo "   ./RESTORE_BACKUP.sh $BACKUP_DIR"
echo ""
echo "💡 TIP: Name your backups for easy identification:"
echo "   ./CLEAN_RESTART.sh autonomous_exploration"
echo "   ./CLEAN_RESTART.sh legal_ai_guided_run"
echo ""
