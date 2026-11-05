#!/bin/bash
# organize_repository.sh
# Organizes COSMO repository documentation

set -e  # Exit on error

COSMO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))"
cd "$COSMO_ROOT"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🗂️  COSMO Repository Organization"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Current MD files in root: $(ls -1 *.md 2>/dev/null | wc -l | xargs)"
echo ""

# Create directory structure
echo "📁 Creating directory structure..."
mkdir -p docs/features/file-access
mkdir -p docs/features/query-interface
mkdir -p docs/features/gpt5-migration
mkdir -p docs/features/tui-dashboard
mkdir -p docs/sessions/october-2025
mkdir -p docs/sessions/archive/coordinator-fixes
mkdir -p docs/sessions/archive/array-validation
mkdir -p docs/sessions/archive/maxcycles-bugs
mkdir -p docs/sessions/archive/orchestrator-fixes
mkdir -p docs/sessions/archive/phase-completions
mkdir -p docs/sessions/archive/run-merge
echo "✓ Directories created"
echo ""

# Move file access docs
echo "📄 Moving file access documentation..."
[ -f "FILE_ACCESS_DEEP_ANALYSIS.md" ] && mv FILE_ACCESS_DEEP_ANALYSIS.md docs/features/file-access/deep-analysis.md && echo "  ✓ deep-analysis.md"
[ -f "AGENT_FILE_ACCESS_ANALYSIS.md" ] && mv AGENT_FILE_ACCESS_ANALYSIS.md docs/features/file-access/agent-analysis.md && echo "  ✓ agent-analysis.md"
[ -f "FILE_ACCESS_CRITICAL_FIXES.md" ] && mv FILE_ACCESS_CRITICAL_FIXES.md docs/features/file-access/critical-fixes.md && echo "  ✓ critical-fixes.md"
[ -f "FILE_ACCESS_FIXES_APPLIED.md" ] && mv FILE_ACCESS_FIXES_APPLIED.md docs/features/file-access/fixes-applied.md && echo "  ✓ fixes-applied.md"
[ -f "FILE_ACCESS_QUICK_START.md" ] && mv FILE_ACCESS_QUICK_START.md docs/features/file-access/quick-start.md && echo "  ✓ quick-start.md"
[ -f "FILE_ACCESS_AUDIT_SUMMARY.md" ] && mv FILE_ACCESS_AUDIT_SUMMARY.md docs/features/file-access/audit-summary.md && echo "  ✓ audit-summary.md"
[ -f "FILE_ACCESS_COMPLETE_SUMMARY.md" ] && mv FILE_ACCESS_COMPLETE_SUMMARY.md docs/features/file-access/complete-summary.md && echo "  ✓ complete-summary.md"
echo ""

# Move query interface docs
echo "🔍 Moving query interface documentation..."
[ -f "QUERY_INTERFACE_READY.md" ] && mv QUERY_INTERFACE_READY.md docs/features/query-interface/interface-ready.md && echo "  ✓ interface-ready.md"
[ -f "QUERY_DASHBOARD_GPT5_FIX.md" ] && mv QUERY_DASHBOARD_GPT5_FIX.md docs/features/query-interface/dashboard-gpt5-fix.md && echo "  ✓ dashboard-gpt5-fix.md"
[ -f "QUERY_DASHBOARD_FIX_INSTRUCTIONS.md" ] && mv QUERY_DASHBOARD_FIX_INSTRUCTIONS.md docs/features/query-interface/fix-instructions.md && echo "  ✓ fix-instructions.md"
[ -f "QUERY_CONTEXT_FIX.md" ] && mv QUERY_CONTEXT_FIX.md docs/features/query-interface/context-fix.md && echo "  ✓ context-fix.md"
[ -f "ASK_COMMANDS_REFERENCE.md" ] && mv ASK_COMMANDS_REFERENCE.md docs/features/query-interface/commands-reference.md && echo "  ✓ commands-reference.md"
[ -f "ASK_CONVERSATIONAL_UPDATE.md" ] && mv ASK_CONVERSATIONAL_UPDATE.md docs/features/query-interface/conversational-update.md && echo "  ✓ conversational-update.md"
[ -f "ASK_ENHANCEMENTS.md" ] && mv ASK_ENHANCEMENTS.md docs/features/query-interface/enhancements.md && echo "  ✓ enhancements.md"
[ -f "ASK_FIXES_COMPLETE.md" ] && mv ASK_FIXES_COMPLETE.md docs/features/query-interface/fixes-complete.md && echo "  ✓ fixes-complete.md"
[ -f "ROBUST_ASK_INTERFACE_SUMMARY.md" ] && mv ROBUST_ASK_INTERFACE_SUMMARY.md docs/features/query-interface/robust-summary.md && echo "  ✓ robust-summary.md"
echo ""

# Move GPT-5.2 docs
echo "🤖 Moving GPT-5.2 migration documentation..."
[ -f "GPT5_IMPLEMENTATION_PLAN.md" ] && mv GPT5_IMPLEMENTATION_PLAN.md docs/features/gpt5-migration/implementation-plan.md && echo "  ✓ implementation-plan.md"
[ -f "GPT5_CHANGES_APPLIED.md" ] && mv GPT5_CHANGES_APPLIED.md docs/features/gpt5-migration/changes-applied.md && echo "  ✓ changes-applied.md"
[ -f "GPT5_QUICK_IMPLEMENTATION.md" ] && mv GPT5_QUICK_IMPLEMENTATION.md docs/features/gpt5-migration/quick-implementation.md && echo "  ✓ quick-implementation.md"
[ -f "GPT5_READY_TO_RUN.md" ] && mv GPT5_READY_TO_RUN.md docs/features/gpt5-migration/ready-to-run.md && echo "  ✓ ready-to-run.md"
[ -f "GPT5_REASONING_AUDIT.md" ] && mv GPT5_REASONING_AUDIT.md docs/features/gpt5-migration/reasoning-audit.md && echo "  ✓ reasoning-audit.md"
[ -f "GPT5_PROMPTS_DEEP_DIVE.md" ] && mv GPT5_PROMPTS_DEEP_DIVE.md docs/features/gpt5-migration/prompts-deep-dive.md && echo "  ✓ prompts-deep-dive.md"
[ -f "GPT5_IMPLEMENTATION_CHECKLIST.md" ] && mv GPT5_IMPLEMENTATION_CHECKLIST.md docs/features/gpt5-migration/implementation-checklist.md && echo "  ✓ implementation-checklist.md"
echo ""

# Move TUI docs
echo "🖥️  Moving TUI dashboard documentation..."
[ -f "TUI_PROPOSAL.md" ] && mv TUI_PROPOSAL.md docs/features/tui-dashboard/proposal.md && echo "  ✓ proposal.md"
[ -f "TUI_IMPLEMENTATION_COMPLETE.md" ] && mv TUI_IMPLEMENTATION_COMPLETE.md docs/features/tui-dashboard/implementation.md && echo "  ✓ implementation.md"
[ -f "TUI_COMPLETE.md" ] && mv TUI_COMPLETE.md docs/features/tui-dashboard/complete.md && echo "  ✓ complete.md"
[ -f "TUI_FINAL_SUMMARY.md" ] && mv TUI_FINAL_SUMMARY.md docs/features/tui-dashboard/final-summary.md && echo "  ✓ final-summary.md"
[ -f "TUI_CLEAN_COMPLETE.md" ] && mv TUI_CLEAN_COMPLETE.md docs/features/tui-dashboard/clean-complete.md && echo "  ✓ clean-complete.md"
[ -f "TUI_FIXES_V2.md" ] && mv TUI_FIXES_V2.md docs/features/tui-dashboard/fixes-v2.md && echo "  ✓ fixes-v2.md"
[ -f "TUI_UX_FIXES.md" ] && mv TUI_UX_FIXES.md docs/features/tui-dashboard/ux-fixes.md && echo "  ✓ ux-fixes.md"
[ -f "TUI_USAGE_GUIDE.md" ] && mv TUI_USAGE_GUIDE.md docs/features/tui-dashboard/usage-guide.md && echo "  ✓ usage-guide.md"
[ -f "CLEAN_TUI_FINAL.md" ] && mv CLEAN_TUI_FINAL.md docs/features/tui-dashboard/clean-final.md && echo "  ✓ clean-final.md"
[ -f "COSMO_TUI_COMPLETE.md" ] && mv COSMO_TUI_COMPLETE.md docs/features/tui-dashboard/cosmo-complete.md && echo "  ✓ cosmo-complete.md"
[ -f "LAUNCH_WITH_TUI.md" ] && mv LAUNCH_WITH_TUI.md docs/features/tui-dashboard/launch-guide.md && echo "  ✓ launch-guide.md"
echo ""

# Archive old status docs
echo "📦 Archiving status documents..."
[ -f "COORDINATOR_GOAL_ALIGNED_REFACTOR_COMPLETE.md" ] && mv COORDINATOR_GOAL_ALIGNED_REFACTOR_COMPLETE.md docs/sessions/archive/coordinator-fixes/ && echo "  ✓ coordinator goal-aligned refactor"
[ -f "COORDINATOR_STATE_LOADING_FIX.md" ] && mv COORDINATOR_STATE_LOADING_FIX.md docs/sessions/archive/coordinator-fixes/ && echo "  ✓ coordinator state loading"
[ -f "ARRAY_VALIDATION_FIX.md" ] && mv ARRAY_VALIDATION_FIX.md docs/sessions/archive/array-validation/ && echo "  ✓ array validation"
[ -f "COMPLETE_STATE_SAFETY_FIX.md" ] && mv COMPLETE_STATE_SAFETY_FIX.md docs/sessions/archive/ && echo "  ✓ state safety"
[ -f "MAXCYCLES_BUG_FIXED.md" ] && mv MAXCYCLES_BUG_FIXED.md docs/sessions/archive/maxcycles-bugs/ && echo "  ✓ maxcycles bug"
[ -f "MAXCYCLES_FIX_COMPLETE.md" ] && mv MAXCYCLES_FIX_COMPLETE.md docs/sessions/archive/maxcycles-bugs/ && echo "  ✓ maxcycles fix"
[ -f "ORCHESTRATOR_PROGRESS_REPORTS_FIX.md" ] && mv ORCHESTRATOR_PROGRESS_REPORTS_FIX.md docs/sessions/archive/orchestrator-fixes/ && echo "  ✓ orchestrator progress"
[ -f "PHASE1_CLI_ENHANCEMENTS_COMPLETE.md" ] && mv PHASE1_CLI_ENHANCEMENTS_COMPLETE.md docs/sessions/archive/phase-completions/ && echo "  ✓ phase 1 CLI"
[ -f "PHASE2_WEB_INTERFACE_COMPLETE.md" ] && mv PHASE2_WEB_INTERFACE_COMPLETE.md docs/sessions/archive/phase-completions/ && echo "  ✓ phase 2 web"
[ -f "RUN_MERGE_EDGE_FIX.md" ] && mv RUN_MERGE_EDGE_FIX.md docs/sessions/archive/run-merge/ && echo "  ✓ run merge edge"
[ -f "RUN_MERGE_IMPLEMENTATION_COMPLETE.md" ] && mv RUN_MERGE_IMPLEMENTATION_COMPLETE.md docs/sessions/archive/run-merge/ && echo "  ✓ run merge implementation"
[ -f "DEPLOYMENT_FIXES.md" ] && mv DEPLOYMENT_FIXES.md docs/sessions/archive/ && echo "  ✓ deployment fixes"
echo ""

# Move today's work
echo "📅 Moving today's session documents..."
[ -f "TODAYS_WORK_REVIEW.md" ] && mv TODAYS_WORK_REVIEW.md docs/sessions/october-2025/oct-14-file-access-review.md && echo "  ✓ today's work review"
[ -f "REPOSITORY_ORGANIZATION_PLAN.md" ] && mv REPOSITORY_ORGANIZATION_PLAN.md docs/sessions/october-2025/repository-organization.md && echo "  ✓ organization plan"
echo ""

# Move dashboard guide
echo "📊 Moving dashboard documentation..."
[ -f "DASHBOARD_CONTROL_GUIDE.md" ] && mv DASHBOARD_CONTROL_GUIDE.md docs/guides/dashboard-control-guide.md && echo "  ✓ dashboard control guide"
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Repository Organization Complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Root directory now has: $(ls -1 *.md 2>/dev/null | wc -l | xargs) MD files"
echo ""
echo "Documentation organized in:"
echo "  ✓ docs/features/file-access/ (7 files)"
echo "  ✓ docs/features/query-interface/ (9 files)"
echo "  ✓ docs/features/gpt5-migration/ (7 files)"
echo "  ✓ docs/features/tui-dashboard/ (11 files)"
echo "  ✓ docs/sessions/october-2025/ (2 files)"
echo "  ✓ docs/sessions/archive/ (12 files)"
echo ""
echo "Next steps:"
echo "  1. Review moved files"
echo "  2. Update README.md"
echo "  3. Update CHANGELOG.md"
echo ""

