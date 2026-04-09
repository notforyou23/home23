#!/bin/bash
# COSMO Launcher - Command Center Edition
# Every setting visible and editable before launch
# Bash 3.2+ compatible (works on macOS)

set -e

# Get to COSMO root
cd "$(dirname "$0")/.."
COSMO_ROOT="$(pwd)"
RUNS_DIR="$COSMO_ROOT/runs"

clear
echo "╔════════════════════════════════════════════════════════════╗"
echo "║                  🧠 COSMO LAUNCHER                         ║"
echo "║            The Autonomous AI Research System               ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Ensure runs directory exists
mkdir -p "$RUNS_DIR"

# Constants
DEFAULT_FILE_ACCESS_PATHS="runtime/outputs/, runtime/exports/"
CODEBASE_EXPLORATION_PATHS="src/, docs/, scripts/, tests/, lib/, mcp/, runtime/outputs/, runtime/exports/"
ENABLE_CODEBASE_EXPLORATION=true

# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

prompt_yes_no() {
    local prompt="$1"
    local default="$2"
    
    while true; do
        read -p "$prompt (y/n) [$default]: " yn
        yn=${yn:-$default}
        case $yn in
            [Yy]* ) return 0;;
            [Nn]* ) return 1;;
            * ) echo "Please answer y or n.";;
        esac
    done
}

ensure_port_clear() {
    local port="$1"
    local label="$2"
    local pids
    pids=$(lsof -ti TCP:"$port" 2>/dev/null | tr '\n' ' ')
    if [ -n "$pids" ]; then
        echo "⚠️  $label already on port $port - clearing..."
        for pid in $pids; do
            kill -TERM "$pid" 2>/dev/null || true
        done
        sleep 1
    fi
}

# =============================================================================
# STEP 1: RUN SELECTION
# =============================================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "STEP 1: Select Run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Count existing runs
run_count=$(ls -1 "$RUNS_DIR" 2>/dev/null | wc -l | tr -d ' ')

if [ "$run_count" -gt 0 ]; then
    echo "Existing runs (sorted by most recent):"
    count=1
    run_names=()
    
    for run_dir in $(ls -td "$RUNS_DIR"/* 2>/dev/null); do
        if [ -d "$run_dir" ]; then
            run_name=$(basename "$run_dir")
            run_names+=("$run_name")
            
            cycles="?"
            if [ -f "$run_dir/state.json.gz" ]; then
                cycles=$(gunzip -c "$run_dir/state.json.gz" 2>/dev/null | grep -o '"cycleCount":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "?")
            fi
            
            size=$(du -sh "$run_dir" 2>/dev/null | cut -f1)
            
            if [ $count -eq 1 ]; then
                echo "  $count) $run_name (Cycle: $cycles, Size: $size) ← LATEST"
            else
                echo "  $count) $run_name (Cycle: $cycles, Size: $size)"
            fi
            count=$((count + 1))
        fi
    done
    echo ""
    echo "Options:"
    echo "  n) New run (fresh start)"
    echo "  f) Fork existing run (copy brain, new directive)"
    echo "  m) Modify directive (change focus, keep everything)"
    echo "  g) Merge runs (combine multiple brains)"
    echo "  d) Dashboard only (browse without running)"
    echo "  1-$run_count) Resume specific run"
    echo ""
    read -p "Choice [1]: " run_choice
    run_choice=${run_choice:-1}
else
    echo "No existing runs found."
    echo ""
    read -p "Create new run? (y/n) [y]: " create_new
    if [[ "$create_new" =~ ^[Nn]$ ]]; then
        echo "Cancelled"
        exit 0
    fi
    run_choice="n"
fi

# Process run selection
operation=""
source_run=""
selected_run=""
clean_start=false

case "$run_choice" in
    n|N)
        operation="new"
        echo ""
        read -p "Name this run (or Enter for auto-name): " user_run_name
        if [ -n "$user_run_name" ]; then
            run_name=$(echo "$user_run_name" | tr ' ' '_' | tr -cd '[:alnum:]_-' | cut -c1-50)
            if [ -d "$RUNS_DIR/$run_name" ]; then
                run_name="${run_name}_$(date +%H%M%S)"
                echo "⚠️  Name exists, using: $run_name"
            fi
        else
            run_name="run_$(date +%Y%m%d_%H%M%S)"
        fi
        selected_run="$run_name"
        clean_start=true
        ;;
        
    f|F)
        operation="fork"
        echo ""
        read -p "Which run to fork (1-$run_count): " fork_num
        if [ "$fork_num" -ge 1 ] && [ "$fork_num" -le "$run_count" ] 2>/dev/null; then
            source_run="${run_names[$((fork_num-1))]}"
            echo "Forking from: $source_run"
            echo ""
            read -p "Name for fork (or Enter for auto-name): " fork_name
            if [ -n "$fork_name" ]; then
                fork_name=$(echo "$fork_name" | tr ' ' '_' | tr -cd '[:alnum:]_-' | cut -c1-50)
                if [ -d "$RUNS_DIR/$fork_name" ]; then
                    fork_name="${fork_name}_$(date +%H%M%S)"
                fi
            else
                fork_name="${source_run}_fork_$(date +%H%M%S)"
            fi
            echo "✓ Fork name: $fork_name"
            echo ""
            echo "Forking brain state..."
            
            # Use RunManager for consistent fork behavior (marks inherited nodes as consolidated)
            if node "$COSMO_ROOT/scripts/fork-run-cli.js" "$source_run" "$fork_name"; then
                echo "✓ Fork complete (inherited memories marked as consolidated)"
            else
                echo "✗ Fork failed, falling back to copy..."
                cp -r "$RUNS_DIR/$source_run" "$RUNS_DIR/$fork_name"
                
                # Fallback: Reset state for fresh start (without consolidation marking)
                if [ -f "$RUNS_DIR/$fork_name/state.json.gz" ]; then
                    cd "$RUNS_DIR/$fork_name"
                    cp state.json.gz state.json.gz.prefork 2>/dev/null
                    if gunzip state.json.gz 2>/dev/null; then
                        if jq '.temporal.state = "awake" | .cognitiveState.mode = "active" | .temporal.fatigue = 0 | .cognitiveState.energy = 1.0' state.json > state.json.tmp 2>/dev/null; then
                            mv state.json.tmp state.json
                            gzip state.json
                            echo "✓ State reset (fallback)"
                        fi
                    fi
                    cd "$COSMO_ROOT"
                fi
            fi
            
            selected_run="$fork_name"
            clean_start=false
        else
            echo "Invalid selection"
            exit 1
        fi
        ;;
        
    m|M)
        operation="modify"
        echo ""
        read -p "Which run to modify (1-$run_count) [1]: " modify_num
        modify_num=${modify_num:-1}
        if [ "$modify_num" -ge 1 ] && [ "$modify_num" -le "$run_count" ] 2>/dev/null; then
            selected_run="${run_names[$((modify_num-1))]}"
            echo "Modifying: $selected_run"
            
            # Reset operational state for fresh start with new directive
            if [ -f "$RUNS_DIR/$selected_run/state.json.gz" ]; then
                echo "Resetting operational state..."
                cd "$RUNS_DIR/$selected_run"
                cp state.json.gz state.json.gz.premodify 2>/dev/null
                if gunzip state.json.gz 2>/dev/null; then
                    if jq '.temporal.state = "awake" | .cognitiveState.mode = "active" | .temporal.fatigue = 0 | .cognitiveState.energy = 1.0 | .temporal.lastSleepCycle = 0 | .temporal.sleepCycles = 0' state.json > state.json.tmp 2>/dev/null; then
                        mv state.json.tmp state.json
                        gzip state.json
                        cd "$COSMO_ROOT"
                        echo "✓ State reset (will start awake)"
                    else
                        mv state.json.gz.premodify state.json.gz 2>/dev/null
                        cd "$COSMO_ROOT"
                        echo "⚠️  Could not reset state"
                    fi
                fi
            fi
            clean_start=false
        else
            echo "Invalid selection"
            exit 1
        fi
        ;;
        
    g|G)
        operation="merge"
        echo ""
        echo "Launching merge tool..."
        node scripts/merge_runs.js
        echo ""
        echo "Merge complete. Run launcher again to use merged run."
        exit 0
        ;;
        
    d|D)
        operation="dashboard"
        echo ""
        echo "Launching dashboard only..."
        exec "$COSMO_ROOT/scripts/START_DASHBOARD_ONLY.sh"
        ;;
        
    [1-9]*)
        if [ "$run_choice" -ge 1 ] && [ "$run_choice" -le "$run_count" ] 2>/dev/null; then
            operation="resume"
            selected_run="${run_names[$((run_choice-1))]}"
            echo "Resuming: $selected_run"
            clean_start=false
        else
            echo "Invalid choice"
            exit 1
        fi
        ;;
        
    *)
        echo "Invalid choice"
        exit 1
        ;;
esac

# Set up runtime link
RUN_PATH="$RUNS_DIR/$selected_run"
mkdir -p "$RUN_PATH"
mkdir -p "$RUN_PATH/policies" "$RUN_PATH/training" "$RUN_PATH/coordinator" "$RUN_PATH/agents"

rm -rf "$COSMO_ROOT/runtime"
ln -sf "$RUN_PATH" "$COSMO_ROOT/runtime"

echo ""
echo "✓ Run: $selected_run"
echo "✓ Runtime linked"
echo ""

# =============================================================================
# STEP 2: LOAD SETTINGS (from metadata or defaults)
# =============================================================================

# Load from metadata if exists
if [ -f "$RUN_PATH/run-metadata.json" ]; then
    echo "Loading previous settings..."
    
    # Use Python to safely extract all settings
    settings_eval=$(python3 - "$RUN_PATH/run-metadata.json" <<'PY'
import json, sys, shlex

path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as fh:
    data = json.load(fh)

def emit(name, value, default=None):
    target = value if value is not None else default
    if isinstance(target, bool):
        print(f"{name}={'true' if target else 'false'}")
    elif target is None or target == 'null':
        print(f"{name}=null")
    else:
        print(f"{name}={shlex.quote(str(target))}")

# Core settings
emit('s_mode', data.get('explorationMode'), 'guided')
emit('s_domain', data.get('domain'), '')
emit('s_context', data.get('context'), '')
emit('s_exec_mode', data.get('executionMode'), 'mixed')
emit('s_max_cycles', data.get('maxCycles'), 'null')
emit('s_silent_plan', data.get('silentPlanning'), False)

# Capabilities
emit('s_web_search', data.get('enableWebSearch'), False)
emit('s_sleep', data.get('enableSleep'), False)
emit('s_coding_agents', data.get('enableCodingAgents'), True)
emit('s_github_mcp', data.get('githubMcpEnabled'), False)
emit('s_stabilization', data.get('enableStabilization'), False)

# Agent settings
emit('s_review_period', data.get('reviewPeriod'), 20)
emit('s_max_concurrent', data.get('maxConcurrent'), 4)

# File access
emit('s_file_access', data.get('fileAccessPaths'), 'runtime/outputs/, runtime/exports/')

# Cluster
emit('s_cluster_enabled', data.get('clusterEnabled'), False)
emit('s_cluster_backend', data.get('clusterBackend'), 'none')
emit('s_cluster_size', data.get('clusterSize'), 1)
emit('s_cluster_spec_enabled', data.get('clusterSpecializationEnabled'), False)
emit('s_spec_profiles', data.get('clusterSpecializationProfiles'), '')
emit('s_spec_agent_types', data.get('clusterSpecializationAgentTypes'), '')
emit('s_spec_keywords', data.get('clusterSpecializationKeywords'), '')
emit('s_spec_tags', data.get('clusterSpecializationTags'), '')
emit('s_spec_avoid_keywords', data.get('clusterSpecializationAvoidKeywords'), '')
emit('s_spec_avoid_tags', data.get('clusterSpecializationAvoidTags'), '')

# Local LLM
emit('s_local_llm', data.get('enableLocalLlm'), False)
emit('s_local_llm_url', data.get('localLlmBaseUrl'), 'http://localhost:11434/v1')
emit('s_local_llm_model', data.get('localLlmDefaultModel'), 'qwen2.5:14b')
emit('s_local_llm_fast', data.get('localLlmFastModel'), 'qwen2.5:14b')
emit('s_searxng_url', data.get('searxngUrl'), '')
PY
)
    
    eval "$settings_eval"
    
    # Normalize values
    exploration_mode=${s_mode}
    domain=${s_domain}
    context=${s_context}
    execution_mode=${s_exec_mode}
    max_cycles=${s_max_cycles}
    silent_planning=${s_silent_plan}
    enable_web_search=${s_web_search}
    enable_sleep=${s_sleep}
    enable_coding_agents=${s_coding_agents}
    enable_github_mcp=${s_github_mcp}
    enable_stabilization=${s_stabilization}
    review_period=${s_review_period}
    max_concurrent=${s_max_concurrent}
    file_access_paths=${s_file_access}
    cluster_enabled=${s_cluster_enabled}
    cluster_backend=${s_cluster_backend}
    cluster_size=${s_cluster_size}
    specialization_enabled=${s_cluster_spec_enabled}

    # Local LLM
    enable_local_llm=${s_local_llm}
    local_llm_base_url=${s_local_llm_url}
    local_llm_default_model=${s_local_llm_model}
    local_llm_fast_model=${s_local_llm_fast}
    searxng_url=${s_searxng_url}

    # Load specialization arrays
    specialization_profile_names=()
    specialization_agent_types=()
    specialization_keywords=()
    specialization_tags=()
    specialization_avoid_keywords=()
    specialization_avoid_tags=()
    
    if [ "$specialization_enabled" = "true" ]; then
        if [ -n "$s_spec_profiles" ] && [ "$s_spec_profiles" != "null" ]; then
            IFS='|' read -ra profile_pairs <<< "$s_spec_profiles"
            for pair in "${profile_pairs[@]}"; do
                specialization_profile_names+=("${pair#*=}")
            done
        fi
        if [ -n "$s_spec_agent_types" ] && [ "$s_spec_agent_types" != "null" ]; then
            IFS='|' read -ra agent_pairs <<< "$s_spec_agent_types"
            for pair in "${agent_pairs[@]}"; do
                specialization_agent_types+=("${pair#*=}")
            done
        fi
        if [ -n "$s_spec_keywords" ] && [ "$s_spec_keywords" != "null" ]; then
            IFS='|' read -ra keyword_pairs <<< "$s_spec_keywords"
            for pair in "${keyword_pairs[@]}"; do
                specialization_keywords+=("${pair#*=}")
            done
        fi
        if [ -n "$s_spec_tags" ] && [ "$s_spec_tags" != "null" ]; then
            IFS='|' read -ra tag_pairs <<< "$s_spec_tags"
            for pair in "${tag_pairs[@]}"; do
                specialization_tags+=("${pair#*=}")
            done
        fi
        if [ -n "$s_spec_avoid_keywords" ] && [ "$s_spec_avoid_keywords" != "null" ]; then
            IFS='|' read -ra avoid_keyword_pairs <<< "$s_spec_avoid_keywords"
            for pair in "${avoid_keyword_pairs[@]}"; do
                specialization_avoid_keywords+=("${pair#*=}")
            done
        fi
        if [ -n "$s_spec_avoid_tags" ] && [ "$s_spec_avoid_tags" != "null" ]; then
            IFS='|' read -ra avoid_tag_pairs <<< "$s_spec_avoid_tags"
            for pair in "${avoid_tag_pairs[@]}"; do
                specialization_avoid_tags+=("${pair#*=}")
            done
        fi
    fi
    
    # Handle nulls
    [ "$domain" = "null" ] && domain=""
    [ "$context" = "null" ] && context=""
    [ "$max_cycles" = "null" ] && max_cycles="unlimited"
    
    echo "✓ Settings loaded from previous run"
else
    echo "Setting defaults for new run..."
    
    # Defaults
    exploration_mode="guided"
    domain=""
    context=""
    execution_mode="mixed"
    max_cycles="100"
    silent_planning="false"
    enable_web_search="false"
    enable_sleep="false"
    enable_coding_agents="true"
    enable_github_mcp="false"
    enable_stabilization="false"
    review_period="20"
    max_concurrent="4"
    file_access_paths="$DEFAULT_FILE_ACCESS_PATHS"
    cluster_enabled="false"
    cluster_backend="none"
    cluster_size="1"
    specialization_enabled="false"
    
    # Initialize specialization arrays
    specialization_profile_names=()
    specialization_agent_types=()
    specialization_keywords=()
    specialization_tags=()
    specialization_avoid_keywords=()
    specialization_avoid_tags=()

    # Local LLM defaults
    enable_local_llm="false"
    local_llm_base_url="http://localhost:11434/v1"
    local_llm_default_model="qwen2.5:14b"
    local_llm_fast_model="qwen2.5:14b"
    searxng_url=""

    echo "✓ Defaults set"
fi

# Special handling for modify operation
if [ "$operation" = "modify" ]; then
    current_cycle=$(gunzip -c "$RUN_PATH/state.json.gz" 2>/dev/null | jq -r '.cycleCount' || echo "0")
    echo ""
    echo "Current directive: $domain"
    echo "Current cycle: $current_cycle"
    echo ""
    echo "You'll be able to change the directive in the command center below."
    echo ""
fi

echo ""

# =============================================================================
# STEP 3: COMMAND CENTER - Review & Edit ALL Settings
# =============================================================================

while true; do
    clear
    echo "╔════════════════════════════════════════════════════════════╗"
    echo "║              🎛️  COSMO COMMAND CENTER                     ║"
    echo "║          Review & Edit All Settings Before Launch          ║"
    echo "╚════════════════════════════════════════════════════════════╝"
    echo ""
    echo "Run: $selected_run"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "CURRENT SETTINGS"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "🧠 THINKING"
    echo "  1) Mode: $exploration_mode"
    if [ "$exploration_mode" = "guided" ]; then
        echo "     Focus: ${domain:-not set}"
        [ -n "$context" ] && echo "     Context: $context"
        echo "     Execution: $execution_mode"
    fi
    echo ""
    echo "⚙️  EXECUTION"
    echo "  2) Max Cycles: $max_cycles"
    echo "  3) Review Period: Every $review_period cycles"
    echo "  4) Max Concurrent: $max_concurrent agents"
    echo ""
    echo "🔧 CAPABILITIES"
    echo "  5) Web Search: $([ "$enable_web_search" = "true" ] && echo "ON" || echo "OFF")"
    echo "  6) Coding Agents: $([ "$enable_coding_agents" = "true" ] && echo "ON" || echo "OFF")"
    echo "  7) Sleep/Dreams: $([ "$enable_sleep" = "true" ] && echo "ON" || echo "OFF")"
    echo "  8) GitHub MCP: $([ "$enable_github_mcp" = "true" ] && echo "ON" || echo "OFF")"
    echo ""
    echo "📁 FILE ACCESS"
    echo "  9) Paths: $file_access_paths"
    echo ""
    echo "🌐 CLUSTER (Advanced)"
    echo " 10) Cluster Mode: $([ "$cluster_enabled" = "true" ] && echo "ON ($cluster_backend, $cluster_size instances)" || echo "OFF")"
    echo ""
    echo "🔒 STABILIZATION"
    echo " 11) Stabilization Mode: $([ "$enable_stabilization" = "true" ] && echo "ON (merged brain first 20-50 cycles)" || echo "OFF")"
    echo ""
    echo "🧪 EXPERIMENTAL"
    echo " 12) Experimental Mode: $([ "$enable_experimental" = "true" ] && echo "ON (local OS autonomy)" || echo "OFF")"
    echo ""
    echo "🏠 LOCAL LLM (Air-Gapped)"
    echo " 13) Local LLM: $([ "$enable_local_llm" = "true" ] && echo "ON ($local_llm_default_model)" || echo "OFF (using OpenAI)")"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "ACTIONS"
    echo "  1-13) Edit a setting"
    echo "  L)    Launch with these settings"
    echo "  Q)    Quit"
    echo ""
    read -p "Choice: " cmd_choice
    
    case "$cmd_choice" in
        1)
            # Change thinking mode
            clear
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "THINKING MODE"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "Current: $exploration_mode"
            echo ""
            echo "  1) Guided - Focus on specific task/domain"
            echo "  2) Autonomous - Free exploration"
            echo "  3) Pure - Minimal prompting (experimental)"
            echo ""
            read -p "Choice [Enter to keep current]: " mode_choice
            
            case "$mode_choice" in
                1)
                    exploration_mode="guided"
                    echo ""
                    read -p "What should COSMO focus on? [$domain]: " new_domain
                    [ -n "$new_domain" ] && domain="$new_domain"
                    echo ""
                    read -p "Additional context (optional) [$context]: " new_context
                    [ -n "$new_context" ] && context="$new_context"
                    echo ""
                    echo "Execution mode:"
                    echo "  1) Strict - 100% task focus"
                    echo "  2) Mixed - 85% task, 15% exploration (recommended)"
                    echo "  3) Advisory - 65% task, 35% exploration"
                    echo ""
                    read -p "Choice [current: $execution_mode]: " exec_choice
                    case "$exec_choice" in
                        1) execution_mode="strict" ;;
                        3) execution_mode="advisory" ;;
                        2|"") execution_mode="mixed" ;;
                    esac
                    ;;
                2)
                    exploration_mode="autonomous"
                    domain=""
                    context=""
                    execution_mode="mixed"
                    ;;
                3)
                    exploration_mode="pure"
                    domain=""
                    context=""
                    execution_mode="mixed"
                    ;;
            esac
            ;;
            
        2)
            # Max cycles
            echo ""
            read -p "Max cycles (or 'unlimited') [$max_cycles]: " cycles_input
            if [ -n "$cycles_input" ]; then
                max_cycles="$cycles_input"
            fi
            ;;
            
        3)
            # Review period
            echo ""
            read -p "Coordinator review period (cycles) [$review_period]: " period_input
            if [ -n "$period_input" ]; then
                review_period="$period_input"
            fi
            ;;
            
        4)
            # Max concurrent
            echo ""
            read -p "Max concurrent agents [$max_concurrent]: " concurrent_input
            if [ -n "$concurrent_input" ]; then
                max_concurrent="$concurrent_input"
            fi
            ;;
            
        5)
            # Toggle web search
            if [ "$enable_web_search" = "true" ]; then
                enable_web_search="false"
                echo "✓ Web search disabled"
            else
                enable_web_search="true"
                echo "✓ Web search enabled"
            fi
            sleep 1
            ;;
            
        6)
            # Toggle coding agents
            if [ "$enable_coding_agents" = "true" ]; then
                enable_coding_agents="false"
                echo "✓ Coding agents disabled"
            else
                enable_coding_agents="true"
                echo "✓ Coding agents enabled"
            fi
            sleep 1
            ;;
            
        7)
            # Toggle sleep
            if [ "$enable_sleep" = "true" ]; then
                enable_sleep="false"
                echo "✓ Sleep/dreams disabled"
            else
                enable_sleep="true"
                echo "✓ Sleep/dreams enabled"
            fi
            sleep 1
            ;;
            
        8)
            # Toggle GitHub MCP
            if [ "$enable_github_mcp" = "true" ]; then
                enable_github_mcp="false"
                echo "✓ GitHub MCP disabled"
            else
                echo ""
                echo "GitHub requires a Personal Access Token"
                echo "Get one at: https://github.com/settings/tokens"
                echo ""
                read -sp "GitHub token (or Enter to skip): " github_token
                echo ""
                if [ -n "$github_token" ]; then
                    export GITHUB_PERSONAL_ACCESS_TOKEN="$github_token"
                    enable_github_mcp="true"
                    echo "✓ GitHub MCP enabled"
                else
                    echo "⚠️  Skipped"
                fi
            fi
            sleep 1
            ;;
            
        9)
            # File access
            clear
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "FILE ACCESS"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "Current: $file_access_paths"
            echo ""
            echo "  1) Outputs only (runtime/outputs/, runtime/exports/)"
            echo "  2) Codebase exploration (src/, docs/, scripts/, etc.)"
            echo "  3) Full access (all directories)"
            echo "  4) External folders (absolute paths outside COSMO)"
            echo "  5) Custom (specify paths)"
            echo "  6) Injection-only (ONLY injected documents, no other files)"
            echo ""
            read -p "Choice: " access_choice
            
            case "$access_choice" in
                1)
                    file_access_paths="$DEFAULT_FILE_ACCESS_PATHS"
                    ;;
                2)
                    file_access_paths="$CODEBASE_EXPLORATION_PATHS"
                    ;;
                3)
                    file_access_paths="FULL_ACCESS"
                    ;;
                4)
                    echo ""
                    echo "⚠️  EXTERNAL FOLDER ACCESS"
                    echo "You are granting COSMO read access to folders outside its directory."
                    echo "This allows AI agents to read files in these locations."
                    echo ""
                    read -p "Enter absolute paths (comma-separated, e.g., /Users/you/Documents, /Users/you/Research): " external_paths
                    if [ -n "$external_paths" ]; then
                        file_access_paths="$external_paths, runtime/outputs/, runtime/exports/"
                    fi
                    ;;
                5)
                    echo ""
                    read -p "Enter paths (comma-separated): " custom_paths
                    if [ -n "$custom_paths" ]; then
                        file_access_paths="$custom_paths, runtime/outputs/, runtime/exports/"
                    fi
                    ;;
                6)
                    file_access_paths="runtime/outputs/injected/"
                    echo ""
                    echo "✓ Injection-only mode enabled"
                    echo "Agents will ONLY be able to read documents you inject via the dashboard."
                    echo "All other files in runtime/outputs/ will be inaccessible to agents."
                    ;;
            esac
            echo "✓ File access updated"
            sleep 1
            ;;
            
        10)
            # Cluster settings
            clear
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "CLUSTER MODE"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "Current: $([ "$cluster_enabled" = "true" ] && echo "Enabled ($cluster_backend, $cluster_size instances)" || echo "Disabled")"
            echo ""
            if prompt_yes_no "Enable cluster mode (hive mind)?" $([ "$cluster_enabled" = "true" ] && echo "y" || echo "n"); then
                cluster_enabled="true"
                echo ""
                echo "Backend:"
                echo "  1) Redis (high-performance)"
                echo "  2) Filesystem (zero infrastructure)"
                echo ""
                read -p "Choice [current: $cluster_backend]: " backend_choice
                case "$backend_choice" in
                    2) cluster_backend="filesystem" ;;
                    1|"") cluster_backend="redis" ;;
                esac
                echo ""
                read -p "Number of instances (3/5/9) [current: $cluster_size]: " size_choice
                case "$size_choice" in
                    5) cluster_size="5" ;;
                    9) cluster_size="9" ;;
                    3|"") cluster_size="3" ;;
                    *) 
                        if [ -n "$size_choice" ]; then
                            cluster_size="$size_choice"
                        fi
                        ;;
                esac
                
                # Specialization
                echo ""
                if prompt_yes_no "Enable specialization (assign roles to instances)?" $([ "$specialization_enabled" = "true" ] && echo "y" || echo "n"); then
                    specialization_enabled="true"
                    specialization_profile_names=()
                    specialization_agent_types=()
                    specialization_keywords=()
                    specialization_tags=()
                    specialization_avoid_keywords=()
                    specialization_avoid_tags=()
                    
                    default_roles=("analysis" "research" "synthesis" "experimental" "qa")
                    
                    echo ""
                    echo "Assign roles (analysis/research/synthesis/experimental/qa):"
                    echo ""
                    
                    for i in $(seq 1 $cluster_size); do
                        instance_label="cosmo-$i"
                        default_role=${default_roles[$(( (i-1) % ${#default_roles[@]} ))]}
                        read -p "Role for $instance_label [$default_role]: " role_choice
                        role_choice=${role_choice:-$default_role}
                        role_key=$(echo "$role_choice" | tr '[:upper:]' '[:lower:]')
                        
                        case "$role_key" in
                            analysis|analyst)
                                specialization_profile_names+=("analysis-node")
                                specialization_agent_types+=("['analysis']")
                                specialization_keywords+=("['analysis','audit','assessment','insight']")
                                specialization_tags+=("['analysis','governance','compliance']")
                                specialization_avoid_keywords+=("[]")
                                specialization_avoid_tags+=("[]")
                                ;;
                            research|researcher|exploration|explorer)
                                specialization_profile_names+=("research-node")
                                specialization_agent_types+=("['research','exploration']")
                                specialization_keywords+=("['research','discover','explore','review']")
                                specialization_tags+=("['research','exploration','discovery']")
                                specialization_avoid_keywords+=("[]")
                                specialization_avoid_tags+=("[]")
                                ;;
                            synthesis|integrator|integration)
                                specialization_profile_names+=("synthesis-node")
                                specialization_agent_types+=("['synthesis','integration']")
                                specialization_keywords+=("['synthesize','integration','report','summary']")
                                specialization_tags+=("['synthesis','integration','summary']")
                                specialization_avoid_keywords+=("[]")
                                specialization_avoid_tags+=("[]")
                                ;;
                            experimental|experiment|builder|implementation|engineer)
                                specialization_profile_names+=("experimental-node")
                                specialization_agent_types+=("['code_execution','analysis']")
                                specialization_keywords+=("['prototype','experiment','implement','test']")
                                specialization_tags+=("['experiment','implementation','prototype']")
                                specialization_avoid_keywords+=("['summarize']")
                                specialization_avoid_tags+=("[]")
                                ;;
                            qa|quality|validator|validation|review)
                                specialization_profile_names+=("qa-node")
                                specialization_agent_types+=("['quality_assurance','analysis']")
                                specialization_keywords+=("['validate','review','verify','check']")
                                specialization_tags+=("['qa','validation','review']")
                                specialization_avoid_keywords+=("['draft','brainstorm']")
                                specialization_avoid_tags+=("[]")
                                ;;
                            *)
                                echo "   ⚠️  Unknown role, defaulting to analysis"
                                specialization_profile_names+=("analysis-node")
                                specialization_agent_types+=("['analysis']")
                                specialization_keywords+=("['analysis','audit','assessment','insight']")
                                specialization_tags+=("['analysis','governance','compliance']")
                                specialization_avoid_keywords+=("[]")
                                specialization_avoid_tags+=("[]")
                                ;;
                        esac
                    done
                else
                    specialization_enabled="false"
                fi
            else
                cluster_enabled="false"
                cluster_backend="none"
                cluster_size="1"
                specialization_enabled="false"
            fi
            echo "✓ Cluster settings updated"
            sleep 1
            ;;
            
        11)
            # Toggle stabilization mode
            clear
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "🔒 STABILIZATION MODE"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "Current: $([ "$enable_stabilization" = "true" ] && echo "ENABLED" || echo "DISABLED")"
            echo ""
            echo "Stabilization mode is for the first 20-50 cycles after merging brains."
            echo ""
            echo "When ENABLED, this will:"
            echo "  • Disable curiosity-driven exploration"
            echo "  • Reduce quantum branches (5 → 3)"
            echo "  • Disable quantum tunneling"
            echo "  • Disable chaotic creativity & mutations"
            echo "  • Disable mood system"
            echo "  • Disable thermodynamic surprise"
            echo "  • Increase review frequency (20 → 5 cycles)"
            echo "  • Reduce concurrency (4 → 2 agents)"
            echo "  • Disable exploration agents"
            echo ""
            if prompt_yes_no "Enable stabilization mode?" $([ "$enable_stabilization" = "true" ] && echo "y" || echo "n"); then
                enable_stabilization="true"
                echo "✓ Stabilization mode ENABLED"
            else
                enable_stabilization="false"
                echo "✓ Stabilization mode DISABLED"
            fi
            sleep 2
            ;;
            
        12)
            # Toggle experimental mode
            clear
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "🧪 EXPERIMENTAL MODE"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "Current: $([ "$enable_experimental" = "true" ] && echo "ENABLED" || echo "DISABLED")"
            echo ""
            echo "Experimental mode enables LOCAL OS AUTONOMY:"
            echo ""
            echo "COSMO will be able to:"
            echo "  • Control mouse and keyboard"
            echo "  • Execute bash commands"
            echo "  • Read and write files (in sandbox)"
            echo "  • Take screenshots"
            echo "  • Launch and control applications (macOS)"
            echo ""
            echo "⚠️  SAFETY FEATURES:"
            echo "  • Manual approval required per session"
            echo "  • 10 minute time limit (hard maximum: 15 min)"
            echo "  • 50 action limit (hard maximum: 200)"
            echo "  • Sandboxed to runtime/outputs directory"
            echo "  • Full audit logging"
            echo ""
            echo "REQUIREMENTS:"
            echo "  • npm packages: @nut-tree-fork/nut-js, screenshot-desktop"
            echo "  • macOS Accessibility permissions (will prompt on first use)"
            echo ""
            if prompt_yes_no "Enable experimental mode?" $([ "$enable_experimental" = "true" ] && echo "y" || echo "n"); then
                enable_experimental="true"
                echo "✓ Experimental mode ENABLED"
                echo ""
                echo "⚠️  You will be asked to approve each experimental session."
                echo "   To approve: touch .pending_experiments/<request_id>.approved"
            else
                enable_experimental="false"
                echo "✓ Experimental mode DISABLED"
            fi
            sleep 3
            ;;

        13)
            # Toggle local LLM
            clear
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "🏠 LOCAL LLM MODE (Air-Gapped)"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "Current: $([ "$enable_local_llm" = "true" ] && echo "ENABLED" || echo "DISABLED")"
            echo ""
            echo "Local LLM mode allows COSMO to run entirely offline using:"
            echo "  • Ollama (http://localhost:11434/v1)"
            echo "  • vLLM (http://localhost:8000/v1)"
            echo "  • llama.cpp server"
            echo "  • LocalAI or any OpenAI-compatible server"
            echo ""
            echo "BENEFITS:"
            echo "  ✓ Zero API costs"
            echo "  ✓ Complete privacy (no data leaves your network)"
            echo "  ✓ Air-gapped deployment capable"
            echo "  ✓ Web search available (free via DuckDuckGo)"
            echo ""
            echo "LIMITATIONS:"
            echo "  ✗ Extended reasoning not available"
            echo "  ✗ Code interpreter containers not available"
            echo ""
            if prompt_yes_no "Enable local LLM mode?" $([ "$enable_local_llm" = "true" ] && echo "y" || echo "n"); then
                enable_local_llm="true"
                enable_web_search="true"  # Web search works with local LLM via DuckDuckGo

                echo ""
                echo "Server URL (common options):"
                echo "  • Ollama:    http://localhost:11434/v1 (default)"
                echo "  • vLLM:      http://localhost:8000/v1"
                echo "  • llama.cpp: http://localhost:8080/v1"
                echo ""
                read -p "Server URL [$local_llm_base_url]: " url_input
                [ -n "$url_input" ] && local_llm_base_url="$url_input"

                echo ""
                echo "Primary model (for complex tasks):"
                read -p "Model name [$local_llm_default_model]: " model_input
                [ -n "$model_input" ] && local_llm_default_model="$model_input"

                echo ""
                echo "Fast model (for quick operations):"
                read -p "Model name [$local_llm_fast_model]: " fast_model_input
                [ -n "$fast_model_input" ] && local_llm_fast_model="$fast_model_input"

                echo ""
                echo "SearXNG URL (optional - for reliable web search):"
                echo "  Leave blank to use DuckDuckGo, or enter your SearXNG server URL"
                read -p "SearXNG URL [$searxng_url]: " searxng_input
                [ -n "$searxng_input" ] && searxng_url="$searxng_input"

                echo ""
                echo "✓ Local LLM mode ENABLED"
                echo "  Server: $local_llm_base_url"
                echo "  Primary: $local_llm_default_model"
                echo "  Fast: $local_llm_fast_model"
                [ -n "$searxng_url" ] && echo "  SearXNG: $searxng_url"
            else
                enable_local_llm="false"
                echo "✓ Local LLM mode DISABLED (using OpenAI API)"
            fi
            sleep 2
            ;;

        l|L)
            # Launch!
            break
            ;;
            
        q|Q)
            echo ""
            echo "Cancelled"
            exit 0
            ;;
            
        *)
            echo "Invalid choice"
            sleep 1
            ;;
    esac
done

# =============================================================================
# STEP 4: GENERATE CONFIGURATION & LAUNCH
# =============================================================================

clear
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "FINAL REVIEW"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Run:            $selected_run"
echo "Mode:           $exploration_mode"
[ "$exploration_mode" = "guided" ] && echo "Focus:          $domain"
echo "Max Cycles:     $max_cycles"
echo "Stabilization:  $([ "$enable_stabilization" = "true" ] && echo "ON (merged brain mode)" || echo "OFF")"
echo "Web Search:     $([ "$enable_web_search" = "true" ] && echo "ON" || echo "OFF")"
echo "Coding Agents:  $([ "$enable_coding_agents" = "true" ] && echo "ON" || echo "OFF")"
echo "Sleep/Dreams:   $([ "$enable_sleep" = "true" ] && echo "ON" || echo "OFF")"
echo "File Access:    $file_access_paths"
echo "Cluster:        $([ "$cluster_enabled" = "true" ] && echo "ON ($cluster_backend, $cluster_size)" || echo "OFF")"
echo "Local LLM:      $([ "$enable_local_llm" = "true" ] && echo "ON ($local_llm_default_model @ $local_llm_base_url)" || echo "OFF (OpenAI API)")"
[ "$enable_local_llm" = "true" ] && [ -n "$searxng_url" ] && echo "SearXNG:        $searxng_url"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if ! prompt_yes_no "Launch COSMO now?" "y"; then
    echo ""
    echo "Returning to command center..."
    sleep 1
    # Loop back to command center
    exec "$0" "$@"
fi

echo ""
echo "⚙️  Generating configuration..."

# Escape for YAML
context_escaped=$(echo "$context" | sed 's/|/ /g' | sed "s/'/\\'/g")
domain_escaped=$(echo "$domain" | sed 's/|/ /g' | sed "s/'/\\'/g")

# Convert unlimited to null
[ "$max_cycles" = "unlimited" ] && max_cycles="null"

# Calculate agent weights
if [ "$enable_coding_agents" = "true" ]; then
    code_creation_weight="25"
    code_execution_weight="10"
else
    code_creation_weight="0"
    code_execution_weight="0"
fi

# Research agents can do file analysis via MCP even without web search
# They have defensive checks to handle web search being disabled
research_weight="20"

# STABILIZATION MODE OVERRIDES
# Apply stabilization settings if enabled
if [ "$enable_stabilization" = "true" ]; then
    # Cognitive controls
    curiosity_allowed="false"
    curiosity_enabled="false"
    mood_enabled="false"
    
    # Quantum reasoning
    parallel_branches="2"
    entanglement_enabled="false"
    tunneling_prob="0"
    
    # Creativity
    chaos_enabled="false"
    mutations_enabled="false"
    mutation_rate="0"
    hybridization_rate="0"
    
    # Thermodynamic
    surprise_enabled="false"
    
    # Goals
    intrinsic_goals_enabled="false"
    max_goals="25"
    
    # Temporal
    oscillations_enabled="false"
    
    # Agent controls
    exploration_weight="0"
    actual_review_period="15"
    actual_max_concurrent="2"
else
    # Normal mode (no stabilization)
    curiosity_allowed="true"
    curiosity_enabled="true"
    mood_enabled="true"
    
    parallel_branches="5"
    entanglement_enabled="true"
    tunneling_prob="0.02"
    
    chaos_enabled="true"
    mutations_enabled="true"
    mutation_rate="0.1"
    hybridization_rate="0.05"
    
    surprise_enabled="true"
    
    intrinsic_goals_enabled="true"
    max_goals="150"
    oscillations_enabled="true"
    
    exploration_weight="10"
    actual_review_period="$review_period"
    actual_max_concurrent="$max_concurrent"
fi

# Prepare specialization metadata
if [ "$specialization_enabled" = "true" ] && [ ${#specialization_profile_names[@]} -gt 0 ]; then
    profiles_meta_entries=()
    agent_types_meta_entries=()
    keywords_meta_entries=()
    tags_meta_entries=()
    avoid_keywords_meta_entries=()
    avoid_tags_meta_entries=()
    
    for i in $(seq 1 $cluster_size); do
        idx=$((i-1))
        instance_label="cosmo-$i"
        profile_value=${specialization_profile_names[$idx]:-generalist}
        agent_types_value=${specialization_agent_types[$idx]:-"[]"}
        keywords_value=${specialization_keywords[$idx]:-"[]"}
        tags_value=${specialization_tags[$idx]:-"[]"}
        avoid_keywords_value=${specialization_avoid_keywords[$idx]:-"[]"}
        avoid_tags_value=${specialization_avoid_tags[$idx]:-"[]"}
        
        profiles_meta_entries+=("${instance_label}=${profile_value}")
        agent_types_meta_entries+=("${instance_label}=${agent_types_value}")
        keywords_meta_entries+=("${instance_label}=${keywords_value}")
        tags_meta_entries+=("${instance_label}=${tags_value}")
        avoid_keywords_meta_entries+=("${instance_label}=${avoid_keywords_value}")
        avoid_tags_meta_entries+=("${instance_label}=${avoid_tags_value}")
    done
    
    specialization_profiles_meta=$(IFS='|'; echo "${profiles_meta_entries[*]}")
    specialization_agent_types_meta=$(IFS='|'; echo "${agent_types_meta_entries[*]}")
    specialization_keywords_meta=$(IFS='|'; echo "${keywords_meta_entries[*]}")
    specialization_tags_meta=$(IFS='|'; echo "${tags_meta_entries[*]}")
    specialization_avoid_keywords_meta=$(IFS='|'; echo "${avoid_keywords_meta_entries[*]}")
    specialization_avoid_tags_meta=$(IFS='|'; echo "${avoid_tags_meta_entries[*]}")
else
    specialization_profiles_meta=""
    specialization_agent_types_meta=""
    specialization_keywords_meta=""
    specialization_tags_meta=""
    specialization_avoid_keywords_meta=""
    specialization_avoid_tags_meta=""
fi

# Escape for JSON
specialization_profiles_meta_json=$(printf "%s" "$specialization_profiles_meta" | sed 's/"/\\"/g')
specialization_agent_types_meta_json=$(printf "%s" "$specialization_agent_types_meta" | sed 's/"/\\"/g')
specialization_keywords_meta_json=$(printf "%s" "$specialization_keywords_meta" | sed 's/"/\\"/g')
specialization_tags_meta_json=$(printf "%s" "$specialization_tags_meta" | sed 's/"/\\"/g')
specialization_avoid_keywords_meta_json=$(printf "%s" "$specialization_avoid_keywords_meta" | sed 's/"/\\"/g')
specialization_avoid_tags_meta_json=$(printf "%s" "$specialization_avoid_tags_meta" | sed 's/"/\\"/g')

# Save metadata
cat > "$RUN_PATH/run-metadata.json" << METADATA
{
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "cleanStart": ${clean_start:-false},
  "explorationMode": "$exploration_mode",
  "domain": "$domain",
  "context": "$context",
  "executionMode": "$execution_mode",
  "maxCycles": "$max_cycles",
  "silentPlanning": ${silent_planning:-false},
  "enableWebSearch": ${enable_web_search:-false},
  "enableSleep": ${enable_sleep:-false},
  "enableCodingAgents": ${enable_coding_agents:-true},
  "enableStabilization": ${enable_stabilization:-false},
  "enableExperimental": ${enable_experimental:-false},
  "githubMcpEnabled": ${enable_github_mcp:-false},
  "reviewPeriod": ${review_period:-20},
  "maxConcurrent": ${max_concurrent:-4},
  "fileAccessEnabled": true,
  "fileAccessPaths": "$file_access_paths",
  "clusterEnabled": ${cluster_enabled:-false},
  "clusterBackend": "${cluster_backend:-none}",
  "clusterSize": ${cluster_size:-1},
  "clusterDashboardPort": 3360,
  "clusterFilesystemRoot": "$RUN_PATH/cluster",
  "clusterSpecializationEnabled": ${specialization_enabled:-false},
  "clusterSpecializationProfiles": "$specialization_profiles_meta_json",
  "clusterSpecializationAgentTypes": "$specialization_agent_types_meta_json",
  "clusterSpecializationKeywords": "$specialization_keywords_meta_json",
  "clusterSpecializationTags": "$specialization_tags_meta_json",
  "clusterSpecializationAvoidKeywords": "$specialization_avoid_keywords_meta_json",
  "clusterSpecializationAvoidTags": "$specialization_avoid_tags_meta_json",
  "enableLocalLlm": ${enable_local_llm:-false},
  "localLlmBaseUrl": "$local_llm_base_url",
  "localLlmDefaultModel": "$local_llm_default_model",
  "localLlmFastModel": "$local_llm_fast_model",
  "searxngUrl": "$searxng_url",
  "launcherVersion": "2.0"
}
METADATA

echo "✓ Metadata saved"

# Generate config.yaml
cat > src/config.yaml << 'CONFIGEOF'
# COSMO Configuration
# Generated by COSMO Launcher v2

architecture:
  roleSystem:
    type: dynamic
    explorationMode: EXPLORATION_MODE_PLACEHOLDER
    
    guidedFocus:
      domain: "DOMAIN_PLACEHOLDER"
      executionMode: EXEC_MODE_PLACEHOLDER
      taskPriority: 1.0
      autonomousPriority: 0.3
      silentPlanning: SILENT_PLAN_PLACEHOLDER
      context: |
        CONTEXT_PLACEHOLDER
      depth: "deep"
      intrinsicBias: 0.8
      curiosityAllowed: CURIOSITY_ALLOWED_PLACEHOLDER
    
    initialRoles:
      - id: curiosity
        prompt: "Generate ONE novel question (2-4 sentences)."
        promptGuided: "Generate ONE question about {domain}. {context}"
        temperature: 1.0
        max_completion_tokens: 500
        successThreshold: 0.6
        enableMCPTools: true
      - id: analyst
        prompt: "Examine ONE topic (3-5 sentences)."
        promptGuided: "Examine ONE aspect of {domain}. {context}"
        temperature: 1.0
        max_completion_tokens: 500
        successThreshold: 0.7
        enableMCPTools: true
      - id: critic
        prompt: "Critically evaluate ONE assumption (3-5 sentences)."
        promptGuided: "Evaluate ONE assumption about {domain}. {context}"
        temperature: 1.0
        max_completion_tokens: 500
        successThreshold: 0.7
        enableMCPTools: true
    evolutionEnabled: false
    maxRoles: 15
  
  codeCreation:
    planMode: true
    maxOutputTokensPerCall: 4000
    perFileRetryLimit: 2
    planRetryLimit: 1
    planMaxOutputTokens: 2000
    reasoningEffort: low

  memory:
    type: graph
    topology: small-world
    embedding:
      model: text-embedding-3-small
      dimensions: 512
    decay:
      function: exponential
      baseFactor: 0.995
      minimumWeight: 0.1
      decayInterval: 3600
      exemptTags:
        - agent_insight
        - agent_finding
        - mission_plan
        - cross_agent_pattern
    spreading:
      enabled: true
      maxDepth: 3
      activationThreshold: 0.1
      decayFactor: 0.7
    hebbian:
      enabled: true
      reinforcementStrength: 0.1
      weakenFactor: 0.05
    smallWorld:
      clusteringCoefficient: 0.6
      averagePathLength: 3.0
      bridgeProbability: 0.05
      rewireInterval: 600
    contextDiversity:
      enabled: true
      noContextProbability: 0.15
      maxContextNodes: 3
      peripheralSamplingRate: 0.20
      minSimilarityThreshold: 0.3
  
  reasoning:
    mode: quantum
    parallelBranches: PARALLEL_BRANCHES_PLACEHOLDER
    collapseStrategy: weighted
    entanglementEnabled: ENTANGLEMENT_ENABLED_PLACEHOLDER
    tunnelingProbability: TUNNELING_PROB_PLACEHOLDER
    features:
      branchPolicy:
        enabled: true
      latentProjector:
        enabled: true
      consistencyReview:
        enabled: true
        divergenceThreshold: 0.85
        maxBranchesAnalyzed: 3
        minCyclesBetweenReviews: 3
    latentProjector:
      maxMemoryNodes: 5
      maxGoalCount: 3
      hintMaxLength: 140
      vectorSize: 128
      autoTrain: true
      autoTrainThreshold: 100
      autoTrainInterval: 50
  
  creativity:
    chaosEnabled: CHAOS_ENABLED_PLACEHOLDER
    chaoticRNN:
      size: 100
      spectralRadius: 0.95
      updateSteps: 10
      perturbationInterval: 300
    mutations:
      enabled: MUTATIONS_ENABLED_PLACEHOLDER
      mutationRate: MUTATION_RATE_PLACEHOLDER
      hybridizationRate: HYBRIDIZATION_RATE_PLACEHOLDER
  
  goals:
    intrinsicEnabled: INTRINSIC_GOALS_ENABLED_PLACEHOLDER
    discoveryMethod: reflection
    maxGoals: MAX_GOALS_PLACEHOLDER
    prioritization: uncertainty
    rotation:
      enabled: true
      maxPursuitsPerGoal: 10
      satisfactionThreshold: 0.6
      staleArchiveAfterDays: 3
      dominanceThreshold: 0.20
      checkInterval: 5
    curator:
      enabled: true
      curationInterval: 20
      minGoalsForCampaign: 3
      campaignDuration: 30
      synthesisThreshold: 3
  
  thermodynamic:
    surpriseEnabled: SURPRISE_ENABLED_PLACEHOLDER
    freeEnergyTarget: 0.5
  
  environment:
    sensorsEnabled: true
    sensors:
      - name: system_time
        type: internal
        pollInterval: 60
        enabled: true
  
  temporal:
    sleepEnabled: SLEEP_PLACEHOLDER
    oscillations:
      enabled: OSCILLATIONS_ENABLED_PLACEHOLDER
      fastPhaseDuration: 300
      slowPhaseDuration: 120
  
  cognitiveState:
    curiosityEnabled: CURIOSITY_ENABLED_PLACEHOLDER
    moodEnabled: MOOD_ENABLED_PLACEHOLDER
    energyEnabled: true
    adaptationRate: 1.0
    initialCuriosity: 0.5
    initialMood: 0.5
    initialEnergy: 1.0
  
  reflection:
    enabled: true

models:
  # Core models - GPT-5.2 (best general-purpose model)
  primary: gpt-5.2
  fast: gpt-5-mini
  nano: gpt-5-mini
  embeddings: text-embedding-3-small
  enableWebSearch: ENABLE_WEB_SEARCH_PLACEHOLDER
  
  # Component-specific models
  strategicModel: gpt-5.2            # Synthesis, planning, integration, QA agents
  coordinatorStrategic: gpt-5.2      # Meta-coordinator strategic decisions
  coordinatorStandard: gpt-5-mini    # Meta-coordinator reviews
  plannerModel: gpt-5-mini           # Guided mode planner
  curatorModel: gpt-5-mini           # Goal curator operations
  curatorStrategic: gpt-5.2          # Goal curator deep analysis
  
  defaultReasoningEffort: low
  defaultMaxTokens: 6000
  enableWebSearch: WEB_SEARCH_PLACEHOLDER
  enableExtendedReasoning: true

providers:
  openai:
    enabled: OPENAI_ENABLED_PLACEHOLDER
LOCAL_LLM_PROVIDER_PLACEHOLDER
coordinator:
  enabled: true
  reviewCyclePeriod: REVIEW_PERIOD_PLACEHOLDER
  model: gpt-5-mini
  reasoningEffort: low
  maxTokens: 3000
  maxConcurrent: MAX_CONCURRENT_PLACEHOLDER
  enableCodingAgents: CODING_AGENTS_PLACEHOLDER
  
  useTemplateReports: true
  useMemorySummaries: true
  extractiveSummarization: true
  
  qualityAssurance:
    enabled: QA_ENABLED_PLACEHOLDER
    mode: 'balanced'
    minConfidence: 0.7
    autoRejectThreshold: 0.3
    checkNovelty: false
    checkConsistency: true
    checkFactuality: false
  
  agentTypeWeights:
    planning: 25
    integration: 25
    code_creation: CODE_CREATION_WEIGHT_PLACEHOLDER
    research: RESEARCH_WEIGHT_PLACEHOLDER
    analysis: 20
    synthesis: 20
    codebase_exploration: 15
    document_creation: 15
    code_execution: CODE_EXECUTION_WEIGHT_PLACEHOLDER
    exploration: EXPLORATION_WEIGHT_PLACEHOLDER
    document_analysis: 10
    specialized_binary: 10
    completion: 5
    quality_assurance: 5
    consistency: 5
  
  codeExecution:
    enabled: CODING_AGENTS_PLACEHOLDER
    containerTimeout: 600000
    maxContainersPerReview: 1
    autoCleanup: true

execution:
  # Execution timing and cycle configuration
  baseInterval: 60
  maxCycles: MAX_CYCLES_PLACEHOLDER
  adaptiveTimingEnabled: true
  # Code execution backend configuration (container vs local)
  backend: EXECUTION_BACKEND_PLACEHOLDER
  local:
    pythonPath: python3
    useVirtualEnv: false
    virtualEnvPath: null
    timeout: 30000
    maxMemory: 512MB
    allowedPackages: [numpy, pandas, matplotlib, scipy]
    autoInstallPackages: true
    workingDir: runtime/outputs/execution
  container:
    timeout: 600000
    maxFiles: 50

timeouts:
  cycleTimeoutMs: 180000
  operationTimeoutMs: 120000

resources:
  memoryLimitMB: 1024
  memoryWarningThreshold: 0.8
  cpuWarningThreshold: 0.9

cluster:
  enabled: CLUSTER_ENABLED_PLACEHOLDER
  backend: CLUSTER_BACKEND_PLACEHOLDER
  instanceCount: CLUSTER_SIZE_PLACEHOLDER
  mode: active-active
  stateStore:
    compression: true
    compressionRatio: 0.25
  coordinator:
    enabled: true
    quorumRatio: 0.67
    minQuorum: 2
    timeoutMs: 60000
    skipOnTimeout: true
    pollIntervalMs: 500
    barrierTtlMs: 600000
    gating:
      enabled: false
  redis:
    url: "redis://localhost:6379"
    tls: false
    acl: false
    keyPrefix: "cosmo:cluster:"
  filesystem:
    root: "$RUN_PATH/cluster"
    leaseMs: 5000
    graceMs: 2000
SPECIALIZATION_PLACEHOLDER

acceptance:
  enabled: true
  defaultThreshold: 0.7
  qaEnabled: true
  toolValidation: true
  literalValidation: true
  minConfidence: 0.7
  autoRejectThreshold: 0.3

# Executive Ring - COSMO's executive function layer (middle ring)
# Implements dorsolateral PFC function (continuous reality checking)
executiveRing:
  enabled: true
  useLLM: true
  coherenceThreshold: 0.5
  alignmentCheckInterval: 5
  stuckLoopThreshold: 5
  toolBuildingThreshold: 6
  
  # Basal ganglia: Action selection with commitment
  maxActiveGoals: 3              # Hard limit on concurrent goal pursuits
  maxConcurrentAgents: 2         # Hard limit on parallel agents
  commitmentCycles: 10           # Cycles to commit before re-evaluating

# Capabilities - Direct tool access (Embodied Cognition)
# Motor cortex layer for autonomous action
capabilities:
  enabled: true
  executiveGating: true
  useFrontierGate: true
  defaultMode: observe

logging:
  level: info
  thoughtJournal: true
  cycleMetrics: true

dashboard:
  enabled: true
  port: 3344

mcp:
  server:
    enabled: true
    port: 3347
  
  client:
    enabled: true
    servers:
      - label: "filesystem"
        type: "http"
        url: "http://localhost:3347/mcp"
        auth: null
        allowedTools: ["read_file", "read_binary_file", "list_directory"]
        requireApproval: "never"
        enabled: true
FILE_ACCESS_PATHS_PLACEHOLDER
CONFIGEOF

# Replace placeholders with actual values
sed -i.bak "s/EXPLORATION_MODE_PLACEHOLDER/$exploration_mode/" src/config.yaml
sed -i.bak "s/DOMAIN_PLACEHOLDER/$domain_escaped/" src/config.yaml
sed -i.bak "s/EXEC_MODE_PLACEHOLDER/$execution_mode/" src/config.yaml
sed -i.bak "s/SILENT_PLAN_PLACEHOLDER/$silent_planning/" src/config.yaml
sed -i.bak "s/CONTEXT_PLACEHOLDER/$context_escaped/" src/config.yaml
sed -i.bak "s/WEB_SEARCH_PLACEHOLDER/$enable_web_search/" src/config.yaml
sed -i.bak "s/ENABLE_WEB_SEARCH_PLACEHOLDER/$enable_web_search/" src/config.yaml
sed -i.bak "s/SLEEP_PLACEHOLDER/$enable_sleep/" src/config.yaml
sed -i.bak "s/REVIEW_PERIOD_PLACEHOLDER/$actual_review_period/" src/config.yaml
sed -i.bak "s/MAX_CONCURRENT_PLACEHOLDER/$actual_max_concurrent/" src/config.yaml
sed -i.bak "s/CODING_AGENTS_PLACEHOLDER/$enable_coding_agents/g" src/config.yaml
sed -i.bak "s/CODE_CREATION_WEIGHT_PLACEHOLDER/$code_creation_weight/" src/config.yaml
sed -i.bak "s/CODE_EXECUTION_WEIGHT_PLACEHOLDER/$code_execution_weight/" src/config.yaml
sed -i.bak "s/RESEARCH_WEIGHT_PLACEHOLDER/$research_weight/" src/config.yaml
sed -i.bak "s/MAX_CYCLES_PLACEHOLDER/$max_cycles/" src/config.yaml
sed -i.bak "s/CLUSTER_ENABLED_PLACEHOLDER/$cluster_enabled/" src/config.yaml
sed -i.bak "s/CLUSTER_BACKEND_PLACEHOLDER/$cluster_backend/" src/config.yaml
sed -i.bak "s/CLUSTER_SIZE_PLACEHOLDER/$cluster_size/" src/config.yaml

# Execution backend (default to local for testing, can change back to container if issues)
execution_backend=${execution_backend:-local}
sed -i.bak "s/EXECUTION_BACKEND_PLACEHOLDER/$execution_backend/" src/config.yaml

# Stabilization mode replacements
sed -i.bak "s/CURIOSITY_ALLOWED_PLACEHOLDER/$curiosity_allowed/" src/config.yaml
sed -i.bak "s/CURIOSITY_ENABLED_PLACEHOLDER/$curiosity_enabled/" src/config.yaml
sed -i.bak "s/MOOD_ENABLED_PLACEHOLDER/$mood_enabled/" src/config.yaml
sed -i.bak "s/PARALLEL_BRANCHES_PLACEHOLDER/$parallel_branches/" src/config.yaml
sed -i.bak "s/ENTANGLEMENT_ENABLED_PLACEHOLDER/$entanglement_enabled/" src/config.yaml
sed -i.bak "s/TUNNELING_PROB_PLACEHOLDER/$tunneling_prob/" src/config.yaml
sed -i.bak "s/CHAOS_ENABLED_PLACEHOLDER/$chaos_enabled/" src/config.yaml
sed -i.bak "s/MUTATIONS_ENABLED_PLACEHOLDER/$mutations_enabled/" src/config.yaml
sed -i.bak "s/MUTATION_RATE_PLACEHOLDER/$mutation_rate/" src/config.yaml
sed -i.bak "s/HYBRIDIZATION_RATE_PLACEHOLDER/$hybridization_rate/" src/config.yaml
sed -i.bak "s/SURPRISE_ENABLED_PLACEHOLDER/$surprise_enabled/" src/config.yaml
sed -i.bak "s/INTRINSIC_GOALS_ENABLED_PLACEHOLDER/$intrinsic_goals_enabled/" src/config.yaml
sed -i.bak "s/MAX_GOALS_PLACEHOLDER/$max_goals/" src/config.yaml
sed -i.bak "s/OSCILLATIONS_ENABLED_PLACEHOLDER/$oscillations_enabled/" src/config.yaml
sed -i.bak "s/EXPLORATION_WEIGHT_PLACEHOLDER/$exploration_weight/" src/config.yaml

# QA enabled for autonomous, disabled for guided
qa_enabled="false"
[ "$exploration_mode" != "guided" ] && qa_enabled="true"
sed -i.bak "s/QA_ENABLED_PLACEHOLDER/$qa_enabled/" src/config.yaml

# Local LLM configuration
if [ "$enable_local_llm" = "true" ]; then
    sed -i.bak "s/OPENAI_ENABLED_PLACEHOLDER/false/" src/config.yaml
    # Build local provider config (using single quotes for YAML)
    # Build searxng config line if set
    searxng_config=""
    if [ -n "$searxng_url" ]; then
        searxng_config="    searxngUrl: '$searxng_url'"
    else
        searxng_config="    # searxngUrl: 'http://localhost:8888'  # Optional: SearXNG for reliable web search"
    fi

    local_llm_config="
  local:
    enabled: true
    baseURL: '$local_llm_base_url'
    defaultModel: '$local_llm_default_model'
    modelMapping:
      gpt-5.2: '$local_llm_default_model'
      gpt-5: '$local_llm_default_model'
      gpt-5-mini: '$local_llm_fast_model'
      gpt-5-nano: '$local_llm_fast_model'
    supportsTools: true
    supportsStreaming: true
$searxng_config

modelAssignments:
  default:
    provider: local
    model: '$local_llm_default_model'
  quantumReasoner.branches:
    provider: local
    model: '$local_llm_fast_model'
  coordinator:
    provider: local
    model: '$local_llm_fast_model'
"
    # Use perl for multiline replacement
    perl -i.bak -pe "s|LOCAL_LLM_PROVIDER_PLACEHOLDER|$local_llm_config|" src/config.yaml

    # Disable extended reasoning when using local LLM (web search works via free DuckDuckGo)
    sed -i.bak "s/enableExtendedReasoning: true/enableExtendedReasoning: false/" src/config.yaml
else
    sed -i.bak "s/OPENAI_ENABLED_PLACEHOLDER/true/" src/config.yaml
    sed -i.bak "s/LOCAL_LLM_PROVIDER_PLACEHOLDER//" src/config.yaml
fi

# Specialization config
if [ "$specialization_enabled" = "true" ] && [ ${#specialization_profile_names[@]} -gt 0 ]; then
    domain_yaml="[]"
    if [ "$exploration_mode" = "guided" ] && [ -n "$domain" ]; then
        domain_escaped_single=$(printf "%s" "$domain" | sed "s/'/''/g")
        domain_yaml="['$domain_escaped_single']"
    fi
    
    spec_config="  specialization:\n    enabled: true\n    defaults:\n      boost: 2\n      penalty: 0.5\n      unmatchedPenalty: 0.9\n      minMultiplier: 0.3\n      maxMultiplier: 3\n      nonPreferredPenalty: 0.1\n    profiles:"
    
    for i in $(seq 1 $cluster_size); do
        idx=$((i-1))
        instance_label="cosmo-$i"
        profile_name=${specialization_profile_names[$idx]}
        agent_types=${specialization_agent_types[$idx]}
        keywords=${specialization_keywords[$idx]}
        tags=${specialization_tags[$idx]}
        avoid_keywords=${specialization_avoid_keywords[$idx]}
        avoid_tags=${specialization_avoid_tags[$idx]}
        
        spec_config="$spec_config\n      $instance_label:\n        name: $profile_name\n        agentTypes: $agent_types\n        keywords: $keywords\n        tags: $tags\n        avoidKeywords: $avoid_keywords\n        avoidTags: $avoid_tags\n        domains: $domain_yaml"
    done
    
    perl -i.bak -pe "s|SPECIALIZATION_PLACEHOLDER|$spec_config|" src/config.yaml
else
    sed -i.bak "s/SPECIALIZATION_PLACEHOLDER/  specialization:\n    enabled: false/" src/config.yaml
fi

# File access paths
if [ "$file_access_paths" = "FULL_ACCESS" ]; then
    sed -i.bak "s/FILE_ACCESS_PATHS_PLACEHOLDER/        # Full access/" src/config.yaml
else
    file_paths_yaml="        allowedPaths:"
    IFS=',' read -ra PATH_ARRAY <<< "$file_access_paths"
    for path in "${PATH_ARRAY[@]}"; do
        path=$(echo "$path" | xargs)
        file_paths_yaml="$file_paths_yaml\n          - \"$path\""
    done
    # Use perl for multiline replacement (works on macOS)
    perl -i.bak -pe "s|FILE_ACCESS_PATHS_PLACEHOLDER|$file_paths_yaml|" src/config.yaml
fi

# Add GitHub MCP server if enabled
if [ "$enable_github_mcp" = "true" ]; then
    cat >> src/config.yaml << 'GITHUB_MCP'
      
      - label: "github"
        type: "external_process"
        command: "npx"
        args: ["-y", "@modelcontextprotocol/server-github"]
        env:
          GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}"
        requireApproval: "never"
        enabled: true
GITHUB_MCP
fi

# Clean up backup files
rm -f src/config.yaml.bak

echo "✓ Configuration generated"
echo ""

# =============================================================================
# LAUNCH LOGIC: Single Instance or Cluster
# =============================================================================

mkdir -p logs

# Calculate ports with optional offset for multi-instance support
PORT_OFFSET=${COSMO_PORT_OFFSET:-0}
LAUNCHER_PORT=$((3340 + PORT_OFFSET))
DASHBOARD_PORT=$((3344 + PORT_OFFSET))
MCP_DASHBOARD_PORT=$((3346 + PORT_OFFSET))
MCP_HTTP_PORT=$((3347 + PORT_OFFSET))

if [ "$PORT_OFFSET" -ne 0 ]; then
    echo "🔧 Port offset enabled: +$PORT_OFFSET"
    echo "   Launcher:       $LAUNCHER_PORT (default: 3340)"
    echo "   Dashboard:      $DASHBOARD_PORT (default: 3344)"
    echo "   MCP Dashboard:  $MCP_DASHBOARD_PORT (default: 3346)"
    echo "   MCP HTTP:       $MCP_HTTP_PORT (default: 3347)"
    echo ""
fi

# Start MCP services (always needed)
ensure_port_clear $MCP_HTTP_PORT "MCP HTTP"
node mcp/http-server.js $MCP_HTTP_PORT > logs/mcp-http.log 2>&1 &
sleep 1

ensure_port_clear $MCP_DASHBOARD_PORT "MCP Dashboard"
COSMO_MCP_HTTP_PORT=$MCP_DASHBOARD_PORT node mcp/dashboard-server.js > logs/mcp-dashboard.log 2>&1 &
sleep 1

if [ "$cluster_enabled" = "true" ] && [ "$cluster_size" -gt 1 ] 2>/dev/null; then
    # =============================================================================
    # CLUSTER MODE LAUNCH
    # =============================================================================
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🧬 LAUNCHING HIVE MIND CLUSTER"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Instances: $cluster_size"
    echo "Backend:   $cluster_backend"
    echo ""
    
    # Start Redis if needed
    if [ "$cluster_backend" = "redis" ]; then
        echo "🔴 Checking Redis..."
        if redis-cli ping > /dev/null 2>&1; then
            echo "  ✓ Redis running"
        else
            echo "  🚀 Starting Redis..."
            if command -v redis-server > /dev/null 2>&1; then
                redis-server --daemonize yes --port 6379
                sleep 2
                if redis-cli ping > /dev/null 2>&1; then
                    echo "  ✓ Redis started"
                else
                    echo "  ❌ Redis failed to start"
                    echo "  Install: brew install redis"
                    exit 1
                fi
            else
                echo "  ❌ redis-server not found"
                echo "  Install: brew install redis"
                exit 1
            fi
        fi
        echo ""
    fi
    
    # Launch cluster instances
    BASE_DASHBOARD_PORT=3343
    BASE_MCP_PORT=3344
    
    rm -f .cosmo_cluster_pids .cosmo_cluster_dashboard_pids
    
    for i in $(seq 1 $cluster_size); do
        DASHBOARD_PORT=$((BASE_DASHBOARD_PORT + i - 1))
        ensure_port_clear "$DASHBOARD_PORT" "cluster dashboard cosmo-$i"
    done
    
    for i in $(seq 1 $cluster_size); do
        INSTANCE_ID="cosmo-$i"
        DASHBOARD_PORT=$((BASE_DASHBOARD_PORT + i - 1))
        MCP_PORT=$((BASE_MCP_PORT + i - 1))
        
        echo "🚀 Starting $INSTANCE_ID (Dashboard: $DASHBOARD_PORT)"
        
        # Start dashboard
        COSMO_DASHBOARD_PORT="$DASHBOARD_PORT" \
        node src/dashboard/server.js > "logs/cluster-$INSTANCE_ID-dashboard.log" 2>&1 &
        echo "$!" >> .cosmo_cluster_dashboard_pids
        sleep 1
        
        # Start instance (with local LLM env vars if enabled)
        if [ "$enable_local_llm" = "true" ]; then
            INSTANCE_ID="$INSTANCE_ID" \
            DASHBOARD_PORT="$DASHBOARD_PORT" \
            MCP_PORT="$MCP_PORT" \
            LLM_BACKEND=local \
            LOCAL_LLM_BASE_URL="$local_llm_base_url" \
            node --expose-gc src/index.js > "logs/cluster-$INSTANCE_ID.log" 2>&1 &
        else
            INSTANCE_ID="$INSTANCE_ID" \
            DASHBOARD_PORT="$DASHBOARD_PORT" \
            MCP_PORT="$MCP_PORT" \
            node --expose-gc src/index.js > "logs/cluster-$INSTANCE_ID.log" 2>&1 &
        fi
        echo "$!" >> .cosmo_cluster_pids
        
        [ $i -lt $cluster_size ] && sleep 2
    done
    
    echo ""
    echo "⏳ Cluster initializing..."
    sleep 5
    
    # Start unified observatory
    CLUSTER_DASHBOARD_PORT=3360
    ensure_port_clear 3360 "Hive Observatory"
    CLUSTER_DASHBOARD_PORT=3360 \
    INSTANCE_COUNT=$cluster_size \
    BASE_DASHBOARD_PORT=$BASE_DASHBOARD_PORT \
    node src/dashboard/cluster-server.js > logs/cluster-dashboard.log 2>&1 &
    echo "$!" > .cluster_dashboard_pid
    sleep 2
    
    echo ""
    echo "✅ HIVE MIND LAUNCHED"
    echo ""
    echo "🧬 Hive Observatory:  http://localhost:3360"
    for i in $(seq 1 $cluster_size); do
        echo "   Instance $i:         http://localhost:$((BASE_DASHBOARD_PORT + i - 1))"
    done
    echo ""
    echo "Stop: ./scripts/stop-cluster.sh"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Streaming collective intelligence..."
    echo "Press Ctrl+C to stop the hive"
    echo ""
    
    # Cleanup trap
    cleanup_cluster() {
        echo ""
        echo "🛑 Stopping hive mind..."
        ./scripts/stop-cluster.sh
        exit 0
    }
    trap cleanup_cluster SIGINT SIGTERM
    
    sleep 3
    tail -f logs/cluster-cosmo-*.log 2>/dev/null
    wait
    
else
    # =============================================================================
    # SINGLE INSTANCE LAUNCH
    # =============================================================================
    ensure_port_clear $DASHBOARD_PORT "Main Dashboard"
    COSMO_DASHBOARD_PORT=$DASHBOARD_PORT MCP_HTTP_PORT=$MCP_HTTP_PORT node src/dashboard/server.js > logs/dashboard.log 2>&1 &
    sleep 1
    
    echo "✓ Services started"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🚀 LAUNCHING COSMO"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Dashboard: http://localhost:$DASHBOARD_PORT"
    echo "Runtime:   runs/$selected_run"
    echo ""
    
    export COSMO_TUI=false
    export COSMO_TUI_SPLIT=false
    export DASHBOARD_PORT=$DASHBOARD_PORT
    export MCP_PORT=$MCP_HTTP_PORT

    # Local LLM environment variables
    if [ "$enable_local_llm" = "true" ]; then
        export LLM_BACKEND=local
        export LOCAL_LLM_BASE_URL="$local_llm_base_url"
        echo "🏠 Local LLM mode: $local_llm_default_model @ $local_llm_base_url"
    fi

    cd src
    exec node --expose-gc index.js
fi

