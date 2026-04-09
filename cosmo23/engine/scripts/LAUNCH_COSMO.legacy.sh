#!/bin/bash
# COSMO Interactive Launcher with Run Management
# Integrates run management with working configuration system

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

# Track if we're resuming an existing run (skip interactive questions)
resume_existing=false
cluster_config_loaded=false
skip_questions=false

DEFAULT_FILE_ACCESS_PATHS="runtime/outputs/, runtime/exports/"

# Codebase exploration paths (for testing/development)
# NOTE: queries-archive/ and runs/ are NEVER exposed to prevent cross-run contamination
CODEBASE_EXPLORATION_PATHS="src/, docs/, scripts/, tests/, lib/, mcp/, runtime/outputs/, runtime/exports/"

# Feature flag for codebase exploration option
ENABLE_CODEBASE_EXPLORATION=true  # Set to false to hide option in production

# ============================================================
# STEP 0: Run Selection (NEW)
# ============================================================
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📂 STEP 0: Select Brain/Run"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Count existing runs
run_count=$(ls -1 "$RUNS_DIR" 2>/dev/null | wc -l | tr -d ' ')

if [ "$run_count" -gt 0 ]; then
    echo "Existing runs found (sorted by most recent):"
    count=1
    run_names=()
    
    # Sort runs by modification time (most recent first)
    for run_dir in $(ls -td "$RUNS_DIR"/* 2>/dev/null); do
        if [ -d "$run_dir" ]; then
            run_name=$(basename "$run_dir")
            run_names+=("$run_name")
            
            # Get cycle count if available
            cycles="?"
            if [ -f "$run_dir/state.json.gz" ]; then
                cycles=$(gunzip -c "$run_dir/state.json.gz" 2>/dev/null | grep -o '"cycleCount":[0-9]*' | head -1 | grep -o '[0-9]*' || echo "?")
            fi
            
            size=$(du -sh "$run_dir" 2>/dev/null | cut -f1)
            
            # Mark the most recent run
            if [ $count -eq 1 ]; then
                echo "  $count) $run_name (Cycles: $cycles, Size: $size) ← LATEST"
            else
                echo "  $count) $run_name (Cycles: $cycles, Size: $size)"
            fi
            count=$((count + 1))
        fi
    done
    echo ""
    echo "Options:"
    echo "  n) New run (fresh start - all existing runs preserved)"
    echo "  f) Fork existing run (copy brain, modify goals)"
    echo "  m) Modify directive and continue (change focus without forking)"
    echo "  g) Merge runs (combine multiple runs into unified brain)"
    echo "  d) Dashboard only (query existing research without running cycles)"
    echo "  1-$run_count) Resume specific run"
    echo ""
    echo "Note: All runs are preserved in runs/ directory."
    echo "      Starting new or switching doesn't delete anything."
    echo ""
    read -p "Choice [1]: " run_choice
    run_choice=${run_choice:-1}
    
    if [ "$run_choice" = "n" ]; then
        # New run
        selected_run="new"
    elif [ "$run_choice" = "f" ]; then
        # Fork
        echo ""
        read -p "Which run to fork (1-$run_count): " fork_source_num
        if [ "$fork_source_num" -ge 1 ] && [ "$fork_source_num" -le "$run_count" ]; then
            fork_source="${run_names[$((fork_source_num-1))]}"
            echo "Forking from: $fork_source"
            
            # Enhanced: Interactive naming for fork with sanitization
            echo ""
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo "📝 Name Your Forked Run"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            echo "Give this fork a descriptive name (or press Enter for auto-name)"
            echo "Examples: 'experiment-v2', 'test-new-focus', 'variant-study'"
            echo ""
            read -p "Fork name: " user_fork_name
            echo ""
            
            if [ -n "$user_fork_name" ]; then
                # Sanitize: alphanumeric, dash, underscore only; max 50 chars
                new_run_name=$(echo "$user_fork_name" | tr ' ' '_' | tr -cd '[:alnum:]_-' | cut -c1-50)
                
                # Check for duplicate
                if [ -d "$RUNS_DIR/$new_run_name" ]; then
                    echo "⚠️  Run '$new_run_name' already exists! Appending timestamp..."
                    new_run_name="${new_run_name}_$(date +%H%M%S)"
                fi
                
                echo "✅ Fork will be named: $new_run_name"
            else
                # Fallback to auto-name (existing behavior)
                new_run_name="${fork_source}_fork_$(date +%H%M%S)"
                echo "ℹ️  Using auto-name: $new_run_name"
            fi
            
            echo ""
            echo "Copying brain state..."
            cp -r "$RUNS_DIR/$fork_source" "$RUNS_DIR/$new_run_name"
            
            selected_run="$new_run_name"
            clean_start=false
            echo "✓ Forked to: $new_run_name"
            echo "  (You can now configure new goals/mode below)"
            
            # Reset maxCycles in forked config (prevents inheriting old cycle limit)
            # Fork will go through configuration below, this ensures old limit doesn't interfere
            if [ -f "$RUNS_DIR/$new_run_name/config.yaml" ]; then
                sed -i.bak "s/maxCycles:.*/maxCycles: null/" "$RUNS_DIR/$new_run_name/config.yaml"
                rm -f "$RUNS_DIR/$new_run_name/config.yaml.bak"
            fi
            
            # Reset operational state for fresh start (keep knowledge, reset sleep/cognitive)
            # This ensures fork starts awake and active, not continuing parent's sleep state
            if [ -f "$RUNS_DIR/$new_run_name/state.json.gz" ]; then
                echo "Resetting operational state (sleep → awake)..."
                cd "$RUNS_DIR/$new_run_name"
                
                # Create backup before modifying
                cp state.json.gz state.json.gz.prefork 2>/dev/null
                
                # Decompress, reset state, recompress
                if gunzip state.json.gz 2>/dev/null; then
                    if jq '.temporal.state = "awake" | .cognitiveState.mode = "active" | .temporal.fatigue = 0 | .cognitiveState.energy = 1.0' state.json > state.json.tmp 2>/dev/null; then
                        mv state.json.tmp state.json
                        gzip state.json
                        cd "$COSMO_ROOT"
                        echo "✓ Operational state reset (will start awake and active)"
                    else
                        # jq failed - restore backup and continue
                        mv state.json.gz.prefork state.json.gz 2>/dev/null
                        cd "$COSMO_ROOT"
                        echo "⚠️  Could not reset state (jq not available), fork will inherit parent's state"
                    fi
                else
                    cd "$COSMO_ROOT"
                    echo "⚠️  Could not decompress state, fork will inherit parent's state"
                fi
            fi
        else
            echo "Invalid selection"
            exit 1
        fi
    elif [ "$run_choice" = "m" ]; then
        # Modify directive and continue
        echo ""
        read -p "Which run to modify (1-$run_count) [1]: " modify_run_num
        modify_run_num=${modify_run_num:-1}
        
        if [ "$modify_run_num" -ge 1 ] && [ "$modify_run_num" -le "$run_count" ]; then
            selected_run="${run_names[$((modify_run_num-1))]}"
            echo "Modifying directive for: $selected_run"
            
            # Link runtime to this run
            rm -f "$COSMO_ROOT/runtime"
            ln -sf "$RUNS_DIR/$selected_run" "$COSMO_ROOT/runtime"
            
            # Get current directive from run metadata if available
            current_directive=""
            if [ -f "$RUNS_DIR/$selected_run/run-metadata.json" ]; then
                current_directive=$(grep '"domain"' "$RUNS_DIR/$selected_run/run-metadata.json" | cut -d'"' -f4)
            fi
            
            # If no metadata, try to extract from config.yaml in the run
            if [ -z "$current_directive" ] && [ -f "$RUNS_DIR/$selected_run/config.yaml" ]; then
                current_directive=$(grep 'domain:' "$RUNS_DIR/$selected_run/config.yaml" | head -1 | sed 's/.*domain: "\(.*\)".*/\1/')
            fi
            
            echo ""
            if [ -n "$current_directive" ]; then
                echo "Current directive: $current_directive"
            fi
            echo ""
            echo "Enter new directive/focus for this run:"
            echo "Examples:"
            echo "  - Deep code analysis of my codebase"
            echo "  - Research quantum computing applications"
            echo "  - Analyze competitor strategies"
            echo ""
            read -p "New directive: " new_directive
            
            if [ -z "$new_directive" ]; then
                echo "❌ Directive required"
                exit 1
            fi
            
            # Store the new directive to be applied
            modify_directive=true
            domain="$new_directive"
            exploration_mode="guided"
            
            # Get current cycle count
            current_cycle=$(gunzip -c runtime/state.json.gz 2>/dev/null | jq -r '.cycleCount' || echo "0")
            
            echo ""
            echo "✓ Will continue run with new directive: $new_directive"
            echo "✓ Current progress: cycle $current_cycle"
            echo ""
            
            # Reset operational state when modifying directive (fresh start with new focus)
            # This ensures modified run starts awake and energized for new directive
            if [ -f "$RUNS_DIR/$selected_run/state.json.gz" ]; then
                echo "Resetting operational state for fresh start on new directive..."
                cd "$RUNS_DIR/$selected_run"
                
                # Create backup before modifying
                cp state.json.gz state.json.gz.premodify 2>/dev/null
                
                # Decompress, reset state, recompress
                if gunzip state.json.gz 2>/dev/null; then
                    if jq '.temporal.state = "awake" | .cognitiveState.mode = "active" | .temporal.fatigue = 0 | .cognitiveState.energy = 1.0 | .temporal.lastSleepCycle = 0 | .temporal.sleepCycles = 0' state.json > state.json.tmp 2>/dev/null; then
                        mv state.json.tmp state.json
                        gzip state.json
                        cd "$COSMO_ROOT"
                        echo "✓ Operational state reset (will start awake and active)"
                    else
                        # jq failed - restore backup and continue
                        mv state.json.gz.premodify state.json.gz 2>/dev/null
                        cd "$COSMO_ROOT"
                        echo "⚠️  Could not reset state (jq not available), will inherit previous state"
                    fi
                else
                    cd "$COSMO_ROOT"
                    echo "⚠️  Could not decompress state, will inherit previous state"
                fi
            fi
            echo ""
            
            # Ask how many additional cycles to run
            echo "How many additional cycles should this run continue?"
            read -p "Additional cycles [unlimited]: " additional_cycles
            additional_cycles=${additional_cycles:-unlimited}
            
            if [ "$additional_cycles" = "unlimited" ] || [ -z "$additional_cycles" ]; then
                max_cycles="null"
                echo "✓ Will run unlimited additional cycles"
            else
                # Calculate absolute maxCycles as current + additional
                max_cycles=$((current_cycle + additional_cycles))
                echo "✓ Will run to cycle $max_cycles (current: $current_cycle + $additional_cycles more)"
            fi
            
            # Skip most configuration prompts, but allow customization
            skip_questions=false
            clean_start=false
        else
            echo "Invalid selection"
            exit 1
        fi
    elif [ "$run_choice" = "g" ]; then
        # Merge runs
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🔀 Merge Runs"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "Launching merge tool..."
        echo ""
        
        # Call merge script in interactive mode
        node scripts/merge_runs.js
        
        # Exit after merge (user can restart launcher to use merged run)
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "✓ Merge complete!"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "To use the merged run:"
        echo "  1. Run ./LAUNCH_COSMO.sh again"
        echo "  2. Select the merged run from the list"
        echo ""
        exit 0
    elif [ "$run_choice" = "d" ]; then
        # Dashboard only - just launch the dashboard script and exit
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "📊 Launching Dashboard Only"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        
        # Launch dashboard script and exit (it handles everything)
        exec "$COSMO_ROOT/scripts/START_DASHBOARD_ONLY.sh"
    elif [[ "$run_choice" =~ ^[0-9]+$ ]] && [ "$run_choice" -ge 1 ] && [ "$run_choice" -le "$run_count" ]; then
        # Resume existing
        selected_run="${run_names[$((run_choice-1))]}"
        echo "Resuming: $selected_run"
        resume_existing=true
        skip_questions=true
        clean_start=false
        
        # Link runtime to this run
        rm -f "$COSMO_ROOT/runtime"
        ln -sf "$RUNS_DIR/$selected_run" "$COSMO_ROOT/runtime"
        
        echo "✓ Runtime linked to $selected_run"
        
        # Reset maxCycles to unlimited for resumed run (prevents old limit from stopping continuation)
        if [ -f "src/config.yaml" ]; then
            current_cycle=$(gunzip -c runtime/state.json.gz 2>/dev/null | jq -r '.cycleCount' || echo "0")
            sed -i.bak "s/maxCycles:.*/maxCycles: null/" src/config.yaml
            rm -f src/config.yaml.bak
            echo "✓ Cycle limit reset to unlimited (currently at cycle $current_cycle)"
        fi
        echo ""
        echo "🔁 Preparing cooperative launcher for seamless resume..."
    else
        echo "Invalid choice"
        exit 1
    fi
else
    selected_run="new"
fi

# If new or forked, continue with configuration prompts
if [ "$selected_run" = "new" ]; then
    # Enhanced: Interactive naming for new run with sanitization
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📝 Name Your Run"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Give this run a descriptive name (or press Enter for auto-name)"
    echo "Examples: 'quantum-research', 'test-clustering', 'esi-analysis'"
    echo ""
    read -p "Run name: " user_run_name
    echo ""
    
    if [ -n "$user_run_name" ]; then
        # Sanitize: alphanumeric, dash, underscore only; max 50 chars
        run_name=$(echo "$user_run_name" | tr ' ' '_' | tr -cd '[:alnum:]_-' | cut -c1-50)
        
        # Check for duplicate
        if [ -d "$RUNS_DIR/$run_name" ]; then
            echo "⚠️  Run '$run_name' already exists! Appending timestamp..."
            run_name="${run_name}_$(date +%H%M%S)"
        fi
        
        echo "✅ Run will be named: $run_name"
    else
        # Fallback to auto-name (existing behavior)
        run_name="run_$(date +%Y%m%d_%H%M%S)"
        echo "ℹ️  Using auto-name: $run_name"
    fi
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "Creating new run: $run_name"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    selected_run="$run_name"
fi

echo ""

# Function to prompt with default
prompt_with_default() {
    local prompt="$1"
    local default="$2"
    local var_name="$3"
    
    read -p "$prompt [$default]: " input
    eval $var_name="${input:-$default}"
}

# Function to prompt yes/no
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

    # Capture any listeners on the provided port
    local pids
    pids=$(lsof -ti TCP:"$port" 2>/dev/null | tr '\n' ' ')

    if [ -n "$pids" ]; then
        echo "⚠️  $label already listening on port $port (PID(s): $pids) — clearing stale process..."

        for pid in $pids; do
            kill -TERM "$pid" 2>/dev/null || true
        done
        sleep 1
        for pid in $pids; do
            if ps -p "$pid" > /dev/null 2>&1; then
                kill -9 "$pid" 2>/dev/null || true
            fi
        done

        echo "✅ Port $port reclaimed for $label"
    fi
}

# Load previous run metadata (used for resumes and directive modifications)
load_run_metadata_settings() {
    local metadata_file="$RUN_PATH/run-metadata.json"
    if [ ! -f "$metadata_file" ]; then
        return
    fi

    local metadata_eval
    metadata_eval=$(python3 - "$metadata_file" <<'PY'
import json, sys, shlex

path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as fh:
    data = json.load(fh)

def emit(name, value, default=None):
    target = value if value is not None else default
    if isinstance(target, bool):
        print(f"{name}={'true' if target else 'false'}")
    elif target is None:
        print(f"{name}=null")
    else:
        print(f"{name}={shlex.quote(str(target))}")

emit('meta_exploration_mode', data.get('explorationMode'), 'autonomous')
emit('meta_domain', data.get('domain'), '')
emit('meta_context', data.get('context'), '')
emit('meta_max_cycles', data.get('maxCycles'), 'null')
emit('meta_enable_web_search', data.get('enableWebSearch'), True)
emit('meta_enable_sleep', data.get('enableSleep'), False)
emit('meta_review_period', data.get('reviewPeriod'), 50)
emit('meta_max_concurrent', data.get('maxConcurrent'), 2)
emit('meta_execution_mode', data.get('executionMode'), 'mixed')
emit('meta_file_access_enabled', data.get('fileAccessEnabled'), False)
emit('meta_file_access_paths', data.get('fileAccessPaths'), '')
emit('meta_cluster_enabled', data.get('clusterEnabled'), False)
emit('meta_cluster_backend', data.get('clusterBackend'), 'none')
emit('meta_cluster_size', data.get('clusterSize'), 1)
emit('meta_cluster_specialization_enabled', data.get('clusterSpecializationEnabled'), False)
emit('meta_cluster_specialization_profiles', data.get('clusterSpecializationProfiles'), '')
emit('meta_cluster_specialization_agent_types', data.get('clusterSpecializationAgentTypes'), '')
emit('meta_cluster_specialization_keywords', data.get('clusterSpecializationKeywords'), '')
emit('meta_cluster_specialization_tags', data.get('clusterSpecializationTags'), '')
emit('meta_cluster_specialization_avoid_keywords', data.get('clusterSpecializationAvoidKeywords'), '')
emit('meta_cluster_specialization_avoid_tags', data.get('clusterSpecializationAvoidTags'), '')
emit('meta_github_mcp_enabled', data.get('githubMcpEnabled'), False)
PY
)

    # Apply settings to shell variables
    eval "$metadata_eval"

    exploration_mode=${meta_exploration_mode:-autonomous}
    domain=${meta_domain:-""}
    context=${meta_context:-""}

    if [ "$domain" = "null" ]; then
        domain=""
    fi
    if [ "$context" = "null" ]; then
        context=""
    fi

    max_cycles=${meta_max_cycles:-"null"}
    enable_web_search=${meta_enable_web_search:-true}
    enable_sleep=${meta_enable_sleep:-false}
    review_period=${meta_review_period:-50}
    max_concurrent=${meta_max_concurrent:-2}
    execution_mode=${meta_execution_mode:-mixed}
    file_access_enabled=${meta_file_access_enabled:-true}
    file_access_paths=${meta_file_access_paths:-"$DEFAULT_FILE_ACCESS_PATHS"}

    cluster_enabled=${meta_cluster_enabled:-false}
    cluster_backend=${meta_cluster_backend:-none}
    cluster_size=${meta_cluster_size:-1}

    if [ -z "$cluster_size" ] || [ "$cluster_size" = "null" ]; then
        cluster_size=1
    fi

    # External MCP settings
    enable_github_mcp=${meta_github_mcp_enabled:-false}

    specialization_enabled=${meta_cluster_specialization_enabled:-false}
    specialization_profile_names=()
    specialization_agent_types=()
    specialization_keywords=()
    specialization_tags=()
    specialization_avoid_keywords=()
    specialization_avoid_tags=()

    if [ "$specialization_enabled" = "true" ]; then
        profiles_meta=$meta_cluster_specialization_profiles
        agent_types_meta=$meta_cluster_specialization_agent_types
        keywords_meta=$meta_cluster_specialization_keywords
        tags_meta=$meta_cluster_specialization_tags
        avoid_keywords_meta=$meta_cluster_specialization_avoid_keywords
        avoid_tags_meta=$meta_cluster_specialization_avoid_tags

        if [ -n "$profiles_meta" ] && [ "$profiles_meta" != "null" ]; then
            IFS='|' read -ra profile_pairs <<< "$profiles_meta"
            for pair in "${profile_pairs[@]}"; do
                specialization_profile_names+=("${pair#*=}")
            done
        fi

        if [ -n "$agent_types_meta" ] && [ "$agent_types_meta" != "null" ]; then
            IFS='|' read -ra agent_pairs <<< "$agent_types_meta"
            for pair in "${agent_pairs[@]}"; do
                specialization_agent_types+=("${pair#*=}")
            done
        fi

        if [ -n "$keywords_meta" ] && [ "$keywords_meta" != "null" ]; then
            IFS='|' read -ra keyword_pairs <<< "$keywords_meta"
            for pair in "${keyword_pairs[@]}"; do
                specialization_keywords+=("${pair#*=}")
            done
        fi

        if [ -n "$tags_meta" ] && [ "$tags_meta" != "null" ]; then
            IFS='|' read -ra tag_pairs <<< "$tags_meta"
            for pair in "${tag_pairs[@]}"; do
                specialization_tags+=("${pair#*=}")
            done
        fi

        if [ -n "$avoid_keywords_meta" ] && [ "$avoid_keywords_meta" != "null" ]; then
            IFS='|' read -ra avoid_keyword_pairs <<< "$avoid_keywords_meta"
            for pair in "${avoid_keyword_pairs[@]}"; do
                specialization_avoid_keywords+=("${pair#*=}")
            done
        fi

        if [ -n "$avoid_tags_meta" ] && [ "$avoid_tags_meta" != "null" ]; then
            IFS='|' read -ra avoid_tag_pairs <<< "$avoid_tags_meta"
            for pair in "${avoid_tag_pairs[@]}"; do
                specialization_avoid_tags+=("${pair#*=}")
            done
        fi
    fi

    if [ "$cluster_enabled" = "true" ] && [ "$cluster_size" -gt 1 ] 2>/dev/null; then
        cluster_config_loaded=true
    fi
}

# ============================================================
# STEP 1: Configure Run (for new/forked runs only)
# ============================================================

# Set up runtime link for selected run
RUN_PATH="$RUNS_DIR/$selected_run"
mkdir -p "$RUN_PATH"

# Initialize specialization structures (used by cluster + mission routing)
specialization_enabled=false
declare -a specialization_profile_names
declare -a specialization_agent_types
declare -a specialization_keywords
declare -a specialization_tags
declare -a specialization_avoid_keywords
declare -a specialization_avoid_tags

# Get current runtime target before changing (for info message)
current_runtime_target=""
if [ -L "$COSMO_ROOT/runtime" ]; then
    current_runtime_target=$(readlink "$COSMO_ROOT/runtime" | xargs basename 2>/dev/null || echo "")
fi

# Update symlink (handle directory, symlink, or file)
if [ -e "$COSMO_ROOT/runtime" ] || [ -L "$COSMO_ROOT/runtime" ]; then
    # Remove existing runtime (whether directory, symlink, or file)
    rm -rf "$COSMO_ROOT/runtime"
fi
ln -sf "$RUN_PATH" "$COSMO_ROOT/runtime"

# Ensure required subdirectories exist in the selected run
# (Create directly in run directory to avoid issues with broken symlinks)
mkdir -p "$RUN_PATH/policies" "$RUN_PATH/training"

if [ -n "$current_runtime_target" ] && [ "$current_runtime_target" != "$selected_run" ]; then
    echo "✓ Switched from: $current_runtime_target"
    echo "✓ Now using: $selected_run"
    echo "  (Previous run preserved in runs/ directory)"
else
    echo "✓ Runtime directory: runtime -> runs/$selected_run"
fi
echo ""

# Load saved run configuration when resuming or modifying directive
if [ "$resume_existing" = "true" ] || [ "$modify_directive" = "true" ]; then
    load_run_metadata_settings
fi

# Determine if this is a fresh start
if [ ! -f "$RUN_PATH/state.json.gz" ]; then
    clean_start=true
    backup_name="$selected_run"
else
    # Check if we should use existing config
    if [ -f "$RUN_PATH/run-metadata.json" ]; then
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "📦 STEP 1: Configuration"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "✅ Found previous run metadata"
        
        # Extract values
        prev_mode=$(grep '"explorationMode"' "$RUN_PATH/run-metadata.json" | cut -d'"' -f4)
        prev_domain=$(grep '"domain"' "$RUN_PATH/run-metadata.json" | cut -d'"' -f4)
        prev_cycles=$(grep '"maxCycles"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,"')
        
        echo "   Previous mode: $prev_mode"
        [ -n "$prev_domain" ] && echo "   Previous domain: $prev_domain"
        echo ""

        if [ "$resume_existing" = "true" ] && [ "$modify_directive" != "true" ]; then
            skip_questions=true
            clean_start=false
            echo "✅ Resuming with saved configuration"
        elif [ "$modify_directive" = "true" ]; then
            # Check if metadata exists
            if [ -f "$RUN_PATH/run-metadata.json" ]; then
                # Load from metadata (but NOT maxCycles - that's now set in modify flow)
                enable_web_search=$(grep '"enableWebSearch"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,' || echo "false")
                enable_sleep=$(grep '"enableSleep"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,' || echo "false")
                review_period=$(grep '"reviewPeriod"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,' || echo "20")
                max_concurrent=$(grep '"maxConcurrent"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,' || echo "2")
                
                # Ensure no empty values (fallback for corrupted metadata)
                enable_web_search=${enable_web_search:-false}
                enable_sleep=${enable_sleep:-false}
                review_period=${review_period:-20}
                max_concurrent=${max_concurrent:-2}
                execution_mode=$(grep '"executionMode"' "$RUN_PATH/run-metadata.json" | cut -d'"' -f4 || echo "mixed")
                
                # Load file access settings (check if field exists, otherwise default)
                if grep -q '"fileAccessEnabled"' "$RUN_PATH/run-metadata.json"; then
                    file_access_enabled=$(grep '"fileAccessEnabled"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,')
                    file_access_paths=$(grep '"fileAccessPaths"' "$RUN_PATH/run-metadata.json" | sed 's/.*"fileAccessPaths": "\([^"]*\)".*/\1/')
                else
                    # Fallback for old runs without this field in metadata
                    file_access_enabled=true
                    file_access_paths="$DEFAULT_FILE_ACCESS_PATHS"
                fi
                
                # Load context if available
                context=$(grep '"context"' "$RUN_PATH/run-metadata.json" | sed 's/.*"context": "\([^"]*\)".*/\1/' || echo "")

                # Load cluster metadata
                if grep -q '"clusterEnabled"' "$RUN_PATH/run-metadata.json"; then
                    cluster_enabled=$(grep '"clusterEnabled"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,')
                    cluster_backend=$(grep '"clusterBackend"' "$RUN_PATH/run-metadata.json" | cut -d'"' -f4)
                    cluster_size=$(grep '"clusterSize"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,')
                else
                    cluster_enabled=false
                    cluster_backend="none"
                    cluster_size=1
                fi

                # Load specialization metadata (if present)
                if grep -q '"clusterSpecializationEnabled"' "$RUN_PATH/run-metadata.json"; then
                    spec_flag=$(grep '"clusterSpecializationEnabled"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,')
                    if [ "$spec_flag" = "true" ]; then
                        specialization_enabled=true

                        profiles_meta=$(grep '"clusterSpecializationProfiles"' "$RUN_PATH/run-metadata.json" | sed 's/.*"clusterSpecializationProfiles": "\([^"]*\)".*/\1/' || echo "")
                        agent_types_meta=$(grep '"clusterSpecializationAgentTypes"' "$RUN_PATH/run-metadata.json" | sed 's/.*"clusterSpecializationAgentTypes": "\([^"]*\)".*/\1/' || echo "")
                        keywords_meta=$(grep '"clusterSpecializationKeywords"' "$RUN_PATH/run-metadata.json" | sed 's/.*"clusterSpecializationKeywords": "\([^"]*\)".*/\1/' || echo "")
                        tags_meta=$(grep '"clusterSpecializationTags"' "$RUN_PATH/run-metadata.json" | sed 's/.*"clusterSpecializationTags": "\([^"]*\)".*/\1/' || echo "")
                        avoid_keywords_meta=$(grep '"clusterSpecializationAvoidKeywords"' "$RUN_PATH/run-metadata.json" | sed 's/.*"clusterSpecializationAvoidKeywords": "\([^"]*\)".*/\1/' || echo "")
                        avoid_tags_meta=$(grep '"clusterSpecializationAvoidTags"' "$RUN_PATH/run-metadata.json" | sed 's/.*"clusterSpecializationAvoidTags": "\([^"]*\)".*/\1/' || echo "")

                        specialization_profile_names=()
                        specialization_agent_types=()
                        specialization_keywords=()
                        specialization_tags=()
                        specialization_avoid_keywords=()
                        specialization_avoid_tags=()

                        if [ -n "$profiles_meta" ]; then
                            IFS='|' read -ra profile_pairs <<< "$profiles_meta"
                            for pair in "${profile_pairs[@]}"; do
                                specialization_profile_names+=("${pair#*=}")
                            done
                        fi

                        if [ -n "$agent_types_meta" ]; then
                            IFS='|' read -ra agent_pairs <<< "$agent_types_meta"
                            for pair in "${agent_pairs[@]}"; do
                                specialization_agent_types+=("${pair#*=}")
                            done
                        fi

                        if [ -n "$keywords_meta" ]; then
                            IFS='|' read -ra keyword_pairs <<< "$keywords_meta"
                            for pair in "${keyword_pairs[@]}"; do
                                specialization_keywords+=("${pair#*=}")
                            done
                        fi

                        if [ -n "$tags_meta" ]; then
                            IFS='|' read -ra tag_pairs <<< "$tags_meta"
                            for pair in "${tag_pairs[@]}"; do
                                specialization_tags+=("${pair#*=}")
                            done
                        fi

                        if [ -n "$avoid_keywords_meta" ]; then
                            IFS='|' read -ra avoid_keyword_pairs <<< "$avoid_keywords_meta"
                            for pair in "${avoid_keyword_pairs[@]}"; do
                                specialization_avoid_keywords+=("${pair#*=}")
                            done
                        fi

                        if [ -n "$avoid_tags_meta" ]; then
                            IFS='|' read -ra avoid_tag_pairs <<< "$avoid_tags_meta"
                            for pair in "${avoid_tag_pairs[@]}"; do
                                specialization_avoid_tags+=("${pair#*=}")
                            done
                        fi
                    else
                        specialization_enabled=false
                        specialization_profile_names=()
                        specialization_agent_types=()
                        specialization_keywords=()
                        specialization_tags=()
                        specialization_avoid_keywords=()
                        specialization_avoid_tags=()
                    fi
                else
                    specialization_enabled=false
                    specialization_profile_names=()
                    specialization_agent_types=()
                    specialization_keywords=()
                    specialization_tags=()
                    specialization_avoid_keywords=()
                    specialization_avoid_tags=()
                fi
            else
    # No metadata file - extract from config.yaml
                echo "⚠️  No metadata file found, extracting settings from config.yaml"
                
                if [ -f "$RUN_PATH/config.yaml" ]; then
                    # Extract settings from existing config (but NOT maxCycles - that's set in modify flow)
                    enable_web_search=$(grep 'enableWebSearch:' "$RUN_PATH/config.yaml" | head -1 | awk '{print $2}')
                    enable_sleep=$(grep 'sleepEnabled:' "$RUN_PATH/config.yaml" | head -1 | awk '{print $2}')
                    review_period=$(grep 'reviewCyclePeriod:' "$RUN_PATH/config.yaml" | head -1 | awk '{print $2}')
                    max_concurrent=$(grep 'maxConcurrent:' "$RUN_PATH/config.yaml" | head -1 | awk '{print $2}')
                    execution_mode=$(grep 'executionMode:' "$RUN_PATH/config.yaml" | head -1 | awk '{print $2}' || echo "mixed")
                    
                    # Extract file access paths from MCP config
                    # Look for allowedPaths in MCP config - grab the first path after the dash
                    file_access_paths=$(grep -A 1 'allowedPaths:' "$RUN_PATH/config.yaml" | grep '^ *-' | head -1 | sed 's/.*- "\(.*\)".*/\1/')
                    
                    # If not present, default to runtime outputs (essential)
                    if [ -z "$file_access_paths" ]; then
                        file_access_enabled=true
                        file_access_paths="runtime/outputs/, runtime/exports/"
                    else
                        file_access_enabled=true
                    fi
                    
                    context=$(grep -A 5 'context:' "$RUN_PATH/config.yaml" | tail -n +2 | head -1 | sed 's/^ *//')
                else
                    # Ultimate fallback - use defaults (but NOT maxCycles - that's set in modify flow)
                    enable_web_search=false
                    enable_sleep=false
                    review_period=5
                    max_concurrent=4
                    # Always enable MCP for runtime outputs (essential)
                    file_access_enabled=true
                    file_access_paths="runtime/outputs/, runtime/exports/"
                    context=""
                fi
            fi
            
            echo "✅ Loaded previous configuration settings (directive updated)"
            echo "   File access: $([ "$file_access_enabled" = "true" ] && echo "enabled ($file_access_paths)" || echo "disabled")"
        elif prompt_yes_no "Use previous configuration?" "y"; then
            # Load all previous settings
            exploration_mode="$prev_mode"
            domain="$prev_domain"
            max_cycles="$prev_cycles"
            
            # Parse other settings from metadata
            enable_web_search=$(grep '"enableWebSearch"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,' || echo "false")
            enable_sleep=$(grep '"enableSleep"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,' || echo "false")
            review_period=$(grep '"reviewPeriod"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,' || echo "20")
            max_concurrent=$(grep '"maxConcurrent"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,' || echo "2")
            
            # Ensure no empty values (fallback for corrupted metadata)
            enable_web_search=${enable_web_search:-false}
            enable_sleep=${enable_sleep:-false}
            review_period=${review_period:-20}
            max_concurrent=${max_concurrent:-2}
            execution_mode=$(grep '"executionMode"' "$RUN_PATH/run-metadata.json" | cut -d'"' -f4 || echo "mixed")
            
            # Load file access settings (check if field exists, otherwise default)
            if grep -q '"fileAccessEnabled"' "$RUN_PATH/run-metadata.json"; then
                file_access_enabled=$(grep '"fileAccessEnabled"' "$RUN_PATH/run-metadata.json" | cut -d':' -f2 | tr -d ' ,')
                file_access_paths=$(grep '"fileAccessPaths"' "$RUN_PATH/run-metadata.json" | sed 's/.*"fileAccessPaths": "\([^"]*\)".*/\1/')
                
                # If file access was disabled, enable it with minimal runtime outputs access
                if [ "$file_access_enabled" = "false" ]; then
                    file_access_enabled=true
                    file_access_paths="runtime/outputs/, runtime/exports/"
                fi
            else
                # Fallback for old runs without this field - enable minimal access
                file_access_enabled=true
                file_access_paths="runtime/outputs/, runtime/exports/"
            fi
            
            # Load context if available
            context=$(grep '"context"' "$RUN_PATH/run-metadata.json" | sed 's/.*"context": "\([^"]*\)".*/\1/' || echo "")
            
            echo "✅ Loaded previous configuration"
            skip_questions=true
        else
            skip_questions=false
            clean_start=false
        fi
    else
        skip_questions=false
        clean_start=true
        backup_name="$selected_run"
    fi
fi

# ============================================================
# STEP 1.5: Deployment Mode (NEW - Hive Mind Configuration)
# ============================================================
if [ "$skip_questions" != "true" ] && [ "$modify_directive" != "true" ]; then
    echo ""
    echo "╔══════════════════════════════════════════════════════════════╗"
    echo "║          🧠 DEPLOYMENT MODE: Choose Your Path               ║"
    echo "╚══════════════════════════════════════════════════════════════╝"
    echo ""
    echo "COSMO can run as:"
    echo ""
    echo "  1️⃣  SINGLE MIND (Independent)"
    echo "      One COSMO instance, autonomous exploration"
    echo "      Best for: Testing, learning, specialized tasks"
    echo ""
    echo "  2️⃣  HIVE MIND (Collective Intelligence) ✨ NEW"
    echo "      Multiple COSMO instances working as ONE unified intelligence"
    echo "      Each mind explores different angles in parallel"
    echo "      Collective knowledge emerges beyond any individual"
    echo "      Best for: Complex research, emergent insights, breakthrough discoveries"
    echo ""
    read -p "Choice [1]: " deployment_mode_choice
    deployment_mode_choice=${deployment_mode_choice:-1}
    
    if [ "$deployment_mode_choice" = "2" ]; then
        cluster_enabled=true
        
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🔧 Hive Mind Backend Selection"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "How should the hive mind coordinate?"
        echo ""
        echo "  1) Redis Backend (High-Performance)"
        echo "     Active/active CRDT merging, mathematically proven convergence"
        echo "     Best for: Maximum throughput, real-time synchronization"
        echo ""
        echo "  2) Filesystem Backend (Zero Infrastructure)"
        echo "     POSIX-atomic operations, NFS-compatible, no external services"
        echo "     Best for: Air-gapped environments, simplicity"
        echo ""
        read -p "Choice [1]: " backend_choice
        backend_choice=${backend_choice:-1}
        
        if [ "$backend_choice" = "2" ]; then
            cluster_backend="filesystem"
            echo ""
            echo "✓ Filesystem backend selected (NFS-compatible, atomic writes)"
        else
            cluster_backend="redis"
            echo ""
            echo "✓ Redis backend selected (CRDT merging, high-performance)"
        fi
        
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "👥 Hive Size: How many minds in the collective?"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "  1) 3 minds (balanced exploration, standard hive)"
        echo "  2) 5 minds (more parallel exploration)"
        echo "  3) 9 minds (maximum collective intelligence)"
        echo ""
        read -p "Choice [1]: " cluster_size_choice
        cluster_size_choice=${cluster_size_choice:-1}
        
        case $cluster_size_choice in
            2) cluster_size=5 ;;
            3) cluster_size=9 ;;
            *) cluster_size=3 ;;
        esac
        
        echo ""
        echo "✓ Creating hive mind with $cluster_size instances ($cluster_backend backend)"
        echo ""

        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🧩 Specialization Heuristics"
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo ""
        echo "Enable cooperative specialization profiles so each instance leans into a role?"
        echo "  y) Yes – assign roles (analysis / research / synthesis / experimental / qa)"
        echo "  n) No  – every instance remains general purpose"
        echo ""
        read -p "Enable specialization? [n]: " specialization_choice
        specialization_choice=${specialization_choice:-n}

        if [[ "$specialization_choice" =~ ^[Yy]$ ]]; then
            specialization_enabled=true
            specialization_profile_names=()
            specialization_agent_types=()
            specialization_keywords=()
            specialization_tags=()
            specialization_avoid_keywords=()
            specialization_avoid_tags=()

            default_roles=("analysis" "research" "synthesis" "experimental" "qa")

            echo ""
            echo "Assign a role to each instance (press Enter for suggested role)."
            echo "Roles: analysis, research, synthesis, experimental, qa"
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
                        echo "   ⚠️  Unknown role \"$role_choice\" – defaulting to analysis"
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
            specialization_enabled=false
        fi

        if [ "$specialization_enabled" = "true" ]; then
            echo ""
            echo "✓ Specialization enabled"
            for i in $(seq 1 $cluster_size); do
                instance_label="cosmo-$i"
                profile_name=${specialization_profile_names[$((i-1))]}
                echo "   • $instance_label → $profile_name"
            done
            echo ""
        fi

    else
        cluster_enabled=false
        cluster_backend="none"
        cluster_size=1
        echo ""
        echo "✓ Single-instance mode selected (Phase A hardening)"
        echo ""
    fi
else
    # For resumed/modified runs, use existing settings
    if [ "$cluster_config_loaded" != "true" ]; then
        cluster_enabled=false
        cluster_backend="none"
        cluster_size=1
    fi
fi

# If cluster disabled ensure specialization is cleared
if [ "$cluster_enabled" != true ]; then
    specialization_enabled=false
    specialization_profile_names=()
    specialization_agent_types=()
    specialization_keywords=()
    specialization_tags=()
    specialization_avoid_keywords=()
    specialization_avoid_tags=()
fi

# ============================================================
# STEP 2: Exploration Mode
# ============================================================
if [ "$skip_questions" != "true" ] && [ "$modify_directive" != "true" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🎯 STEP 2: Thinking Mode"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "How should COSMO think?"
    echo ""
    echo "  1) Autonomous - Open-ended exploration with structured prompts"
    echo "     └─ Uses role-based thinking (curiosity, analyst, critic)"
    echo ""
    echo "  2) Guided - Focused on specific domain/task"
    echo "     └─ Directed exploration with domain context"
    echo ""
    echo "  3) Pure - Minimal prompting, maximum autonomy (EXPERIMENTAL)"
    echo "     └─ No instructions on HOW to think, just context"
    echo "     └─ Most autonomous, emergent behavior"
    echo ""
    read -p "Choice [2]: " mode_choice
    mode_choice=${mode_choice:-2}
else
    # Map existing mode to choice number
    if [ "$exploration_mode" = "autonomous" ]; then
        mode_choice=1
    elif [ "$exploration_mode" = "pure" ]; then
        mode_choice=3
    else
        mode_choice=2
    fi
fi

if [ "$mode_choice" = "1" ]; then
    exploration_mode="autonomous"
    domain=""              # No specific domain in autonomous mode
    context=""             # No specific context
    echo ""
    echo "🌌 Autonomous mode selected - COSMO will explore freely"
    
    # Autonomous mode should not force defaults; settings chosen via prompts/metadata
    # enable_web_search=true
    # enable_sleep=true
    # max_cycles="null"
    # review_period=50
    # max_concurrent=2
elif [ "$mode_choice" = "3" ]; then
    exploration_mode="pure"
    domain=""
    context=""
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "⚠️  PURE MODE: Minimal Prompting"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "This mode uses minimal instructions to let COSMO think freely."
    echo "Behavior will be more emergent and less predictable."
    echo ""
    echo "Recommended for:"
    echo "  • Exploring true autonomous cognition"
    echo "  • Research into emergent AI behavior"
    echo "  • Discovering novel thinking patterns"
    echo ""
    echo "Not recommended for:"
    echo "  • Production tasks with specific deliverables"
    echo "  • Time-sensitive research"
    echo ""
    read -p "Continue with Pure mode? (y/n) [y]: " pure_confirm
    pure_confirm=${pure_confirm:-y}
    
    if [[ ! "$pure_confirm" =~ ^[Yy]$ ]]; then
        echo "Switching to Autonomous mode..."
        exploration_mode="autonomous"
        mode_choice=1
        domain=""
        context=""
    fi
    
    # Pure mode settings (same as autonomous)
    enable_web_search=true
    enable_sleep=true
    max_cycles="null"
    review_period=50
    max_concurrent=2
    
    echo ""
    echo "✨ Pure mode selected - COSMO will think with minimal constraints"
else
    exploration_mode="guided"
    
    # Skip domain prompt if modifying directive (already set)
    if [ "$modify_directive" != "true" ] && [ "$skip_questions" != "true" ]; then
        echo ""
        echo "🎯 Guided mode selected"
        echo ""
        
        # Get domain/task
        echo "What should COSMO focus on?"
        echo "Examples:"
        echo "  - Deep code analysis of my codebase"
        echo "  - Research quantum computing applications"
        echo "  - Analyze competitor strategies"
        echo "  - Self-improvement analysis"
        echo ""
        read -p "Domain/Task: " domain
        
        if [ -z "$domain" ]; then
            domain="Open-ended exploration"
            echo "✓ Defaulting domain to: $domain"
        fi
    elif [ "$modify_directive" = "true" ]; then
        echo ""
        echo "🎯 Continuing in guided mode with updated directive"
    else
        echo ""
        echo "🎯 Resuming guided mode with saved directive"
    fi
    
    # Only ask for context and settings if not modifying directive (those are loaded)
    if [ "$modify_directive" != "true" ] && [ "$skip_questions" != "true" ]; then
        echo ""
        echo "Additional context (optional, press Enter to skip):"
        echo "Examples:"
        echo "  - Focus on security vulnerabilities"
        echo "  - Compare with industry best practices"
        echo "  - Identify improvement opportunities"
        echo ""
        read -p "Context: " context
        
        # NEW: Ask about execution mode
        echo ""
        echo "Execution mode controls task vs autonomous balance:"
        echo "  1) Strict - 100% task focus, no autonomous exploration"
        echo "  2) Mixed - 85% task, 15% autonomous exploration (default)"
        echo "  3) Advisory - 65% task, 35% autonomous with task awareness"
        echo ""
        read -p "Choice [2]: " execution_mode_choice
        execution_mode_choice=${execution_mode_choice:-2}
        
        case $execution_mode_choice in
            1)
                execution_mode="strict"
                echo "✓ Strict mode - Complete task focus"
                ;;
            3)
                execution_mode="advisory"
                echo "✓ Advisory mode - Autonomous with task awareness"
                ;;
            *)
                execution_mode="mixed"
                echo "✓ Mixed mode - Balanced task and exploration"
                ;;
        esac
        
        # NEW: Ask about plan display
        echo ""
        if prompt_yes_no "Show execution plan before starting?" "y"; then
            silent_planning=false
        else
            silent_planning=true
        fi
        
        # Guided settings
        enable_web_search=false
        enable_sleep=false
        prompt_with_default "Max cycles (or 'unlimited')" "100" max_cycles_input
        
        if [ "$max_cycles_input" = "unlimited" ]; then
            max_cycles="null"
        else
            max_cycles=$max_cycles_input
        fi
        
        review_period=20
        max_concurrent=4
    elif [ "$modify_directive" = "true" ]; then
        # Modifying directive - keep silent planning setting from original run
        silent_planning=false  # Default to showing plan when modifying
        execution_mode="mixed"  # Default execution mode when modifying
    else
        # Resuming guided run - preserve existing settings from metadata
        if [ -z "$execution_mode" ] || [ "$execution_mode" = "null" ]; then
            execution_mode="mixed"
        fi
        if [ -z "$silent_planning" ]; then
            silent_planning=false
        fi
        if [ -z "$max_cycles" ]; then
            max_cycles="null"
        fi
        if [ -z "$review_period" ] || [ "$review_period" = "null" ]; then
            review_period=20
        fi
        if [ -z "$max_concurrent" ] || [ "$max_concurrent" = "null" ]; then
            max_concurrent=4
        fi
    fi
fi

# ============================================================
# STEP 3: Advanced Settings (Optional)
# ============================================================
if [ "$skip_questions" != "true" ] && [ "$modify_directive" != "true" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "⚙️  STEP 3: Advanced Settings (Optional)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
fi

if [ "$skip_questions" != "true" ] && [ "$modify_directive" != "true" ] && prompt_yes_no "Customize advanced settings?" "n"; then
    echo ""
    
    if prompt_yes_no "Enable web search? (allows COSMO to research online)" $([ "$enable_web_search" = true ] && echo "y" || echo "n"); then
        enable_web_search=true
    else
        enable_web_search=false
    fi
    
    if prompt_yes_no "Enable sleep cycles? (for long runs, COSMO rests and dreams)" $([ "$enable_sleep" = true ] && echo "y" || echo "n"); then
        enable_sleep=true
    else
        enable_sleep=false
    fi
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📁 File Access Settings"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "COSMO agents can read files via MCP for analysis."
    echo "Choose what directories they can access:"
    echo ""
    echo "Options:"
    echo "  1) Agent outputs only - Isolated mode (recommended for most guided runs)"
    echo "  2) Custom user directories - Add specific project folders"
    if [ "$ENABLE_CODEBASE_EXPLORATION" = "true" ]; then
        echo "  3) Codebase exploration - Full COSMO source + analysis archives 🧬"
        echo "  4) Full repository - All files (WARNING: includes all directories)"
    else
        echo "  3) Full repository - All files (WARNING: includes all directories)"
    fi
    echo ""
    echo "Note: runtime/outputs/ is ALWAYS accessible (required for agent coordination)"
    echo "Note: node_modules/ and .git/ are always excluded"
    echo ""
    read -p "Choice [1]: " file_access_choice
    file_access_choice=${file_access_choice:-1}
    
    case $file_access_choice in
        1)
            # Outputs only (clean, isolated)
            file_access_enabled=true
            file_access_paths="$DEFAULT_FILE_ACCESS_PATHS"
            echo "✓ File access: agent outputs only (runtime/outputs/, runtime/exports/)"
            ;;
        2)
            # Custom directories
            file_access_enabled=true
            echo ""
            echo "Available directories in COSMO root:"
            echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
            echo ""
            
            # Dynamically discover directories (excluding system folders)
            discovered_dirs=$(find "$COSMO_ROOT" -maxdepth 1 -type d ! -name "." ! -name ".git" ! -name "node_modules" ! -name "runs" ! -name "backups" ! -name "runtime" -exec basename {} \; | sort)
            
            echo "  Common Directories:"
            for dir in $discovered_dirs; do
                # Categorize and display with description
                case $dir in
                    docs) echo "    • docs/      - Documentation and guides" ;;
                    personal) echo "    • personal/       - Personal workspace" ;;
                    research) echo "    • research/  - Research materials" ;;
                    business) echo "    • business/  - Business documents" ;;
                    src) echo "    • src/       - COSMO source code (for analysis)" ;;
                esac
            done
            echo ""
            echo "Enter comma-separated directories (e.g., 'docs/, personal/, research/')"
            echo "Leave blank to use outputs only:"
            read -p "Directories: " custom_dirs
            
            if [ -z "$custom_dirs" ]; then
                echo "⚠️  No directories specified - using outputs only"
                file_access_paths="$DEFAULT_FILE_ACCESS_PATHS"
            else
                # Always include runtime outputs
                file_access_paths="$custom_dirs, runtime/outputs/, runtime/exports/"
                echo "✓ File access granted to: $file_access_paths"
            fi
            ;;
        3)
            # Codebase exploration (if enabled) OR Full access (if disabled)
            if [ "$ENABLE_CODEBASE_EXPLORATION" = "true" ]; then
                # Codebase exploration mode
                file_access_enabled=true
                file_access_paths="$CODEBASE_EXPLORATION_PATHS"
                echo ""
                echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                echo "🧬 CODEBASE EXPLORATION MODE"
                echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                echo ""
                echo "Agents will have access to:"
                echo "  • src/             - Full source code"
                echo "  • docs/            - Documentation"
                echo "  • scripts/         - Build/deployment scripts"
                echo "  • tests/           - Test suite"
                echo "  • lib/             - Shared libraries"
                echo "  • mcp/             - MCP servers"
                echo "  • queries-archive/ - Prior AI analysis results"
                echo "  • runtime/outputs/ - Agent outputs"
                echo "  • runtime/exports/ - Exports"
                echo ""
                echo "Always excluded: node_modules/, .git/"
                echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                echo ""
            else
                # Full access (no allowedPaths array will be written)
                file_access_enabled=true
                file_access_paths="FULL_ACCESS"
                echo "✓ Full file access granted (node_modules/ and .git/ excluded)"
            fi
            ;;
        4)
            # Full access OR Custom (depends on exploration flag)
            if [ "$ENABLE_CODEBASE_EXPLORATION" = "true" ]; then
                # This is full access when exploration is enabled
                file_access_enabled=true
                file_access_paths="FULL_ACCESS"
                echo "✓ Full file access granted (node_modules/ and .git/ excluded)"
            else
                # This is custom when exploration is disabled (duplicate the custom code)
                file_access_enabled=true
                echo ""
                echo "Available directories in COSMO root:"
                echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                echo ""
                
                # Dynamically discover directories (excluding system folders)
                discovered_dirs=$(find "$COSMO_ROOT" -maxdepth 1 -type d ! -name "." ! -name ".git" ! -name "node_modules" ! -name "runs" ! -name "backups" ! -name "runtime" -exec basename {} \; | sort)
                
                echo "  System Directories:"
                for dir in $discovered_dirs; do
                    # Categorize and display with description
                    case $dir in
                        src)       echo "    • src/          - Application source code" ;;
                        docs)      echo "    • docs/         - Documentation" ;;
                        mcp)       echo "    • mcp/          - MCP servers" ;;
                        scripts)   echo "    • scripts/      - Shell scripts" ;;
                        queries-archive) echo "    • queries-archive/ - AI analysis results" ;;
                        research)  echo "    • research/     - Research outputs" ;;
                        business)  echo "    • business/     - Business documents" ;;
                        lib)       echo "    • lib/          - Shared libraries" ;;
                        tests)     echo "    • tests/        - Test suite" ;;
                        logs)      echo "    • logs/         - Log files" ;;
                        *)         echo "    • $dir/" ;;
                    esac
                done
                echo ""
                echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                echo ""
                echo "Enter directories (comma-separated, relative to COSMO root):"
                echo "Examples:"
                echo "  • docs/,research/          - Docs and research only"
                echo "  • src/agents/,src/core/    - Core source code only"
                echo "  • docs/,src/,queries-archive/ - Docs, source, and analysis"
                echo ""
                read -p "Directories: " custom_dirs
                
                if [ -z "$custom_dirs" ]; then
                    echo "⚠️  No directories specified - defaulting to docs/"
                    file_access_paths="$DEFAULT_FILE_ACCESS_PATHS"
                else
                    # Validate and normalize paths
                    validated_paths=""
                    IFS=',' read -ra DIR_ARRAY <<< "$custom_dirs"
                    
                    for dir in "${DIR_ARRAY[@]}"; do
                        # Trim whitespace
                        dir=$(echo "$dir" | xargs)
                        
                        # Remove leading/trailing slashes for consistency
                        dir=${dir#/}
                        dir=${dir%/}
                        
                        # Add trailing slash back
                        dir="$dir/"
                        
                        # Check if directory exists
                        if [ -d "$COSMO_ROOT/$dir" ]; then
                            if [ -z "$validated_paths" ]; then
                                validated_paths="$dir"
                            else
                                validated_paths="$validated_paths, $dir"
                            fi
                            echo "  ✓ $dir (exists)"
                        else
                            echo "  ⚠️  $dir (not found - will skip)"
                        fi
                    done
                    
                    if [ -z "$validated_paths" ]; then
                        echo ""
                        echo "❌ No valid directories found - defaulting to docs/"
                        file_access_paths="$DEFAULT_FILE_ACCESS_PATHS"
                    else
                        file_access_paths="$validated_paths"
                        echo ""
                        echo "✓ File access granted to: $validated_paths"
                    fi
                fi
            fi
            ;;
        5)
            # Custom directories (only when exploration is enabled)
            if [ "$ENABLE_CODEBASE_EXPLORATION" = "true" ]; then
                file_access_enabled=true
                echo ""
                echo "Available directories in COSMO root:"
                echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                echo ""
                
                # Dynamically discover directories (excluding system folders)
                discovered_dirs=$(find "$COSMO_ROOT" -maxdepth 1 -type d ! -name "." ! -name ".git" ! -name "node_modules" ! -name "runs" ! -name "backups" ! -name "runtime" -exec basename {} \; | sort)
                
                echo "  System Directories:"
                for dir in $discovered_dirs; do
                    # Categorize and display with description
                    case $dir in
                        src)       echo "    • src/          - Application source code" ;;
                        docs)      echo "    • docs/         - Documentation" ;;
                        mcp)       echo "    • mcp/          - MCP servers" ;;
                        scripts)   echo "    • scripts/      - Shell scripts" ;;
                        queries-archive) echo "    • queries-archive/ - AI analysis results" ;;
                        research)  echo "    • research/     - Research outputs" ;;
                        business)  echo "    • business/     - Business documents" ;;
                        lib)       echo "    • lib/          - Shared libraries" ;;
                        tests)     echo "    • tests/        - Test suite" ;;
                        logs)      echo "    • logs/         - Log files" ;;
                        *)         echo "    • $dir/" ;;
                    esac
                done
                echo ""
                echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
                echo ""
                echo "Enter directories (comma-separated, relative to COSMO root):"
                echo "Examples:"
                echo "  • docs/,research/          - Docs and research only"
                echo "  • src/agents/,src/core/    - Core source code only"
                echo "  • docs/,src/,queries-archive/ - Docs, source, and analysis"
                echo ""
                read -p "Directories: " custom_dirs
                
                if [ -z "$custom_dirs" ]; then
                    echo "⚠️  No directories specified - defaulting to docs/"
                    file_access_paths="$DEFAULT_FILE_ACCESS_PATHS"
                else
                    # Validate and normalize paths
                    validated_paths=""
                    IFS=',' read -ra DIR_ARRAY <<< "$custom_dirs"
                    
                    for dir in "${DIR_ARRAY[@]}"; do
                        # Trim whitespace
                        dir=$(echo "$dir" | xargs)
                        
                        # Remove leading/trailing slashes for consistency
                        dir=${dir#/}
                        dir=${dir%/}
                        
                        # Add trailing slash back
                        dir="$dir/"
                        
                        # Check if directory exists
                        if [ -d "$COSMO_ROOT/$dir" ]; then
                            if [ -z "$validated_paths" ]; then
                                validated_paths="$dir"
                            else
                                validated_paths="$validated_paths, $dir"
                            fi
                            echo "  ✓ $dir (exists)"
                        else
                            echo "  ⚠️  $dir (not found - will skip)"
                        fi
                    done
                    
                    if [ -z "$validated_paths" ]; then
                        echo ""
                        echo "❌ No valid directories found - defaulting to docs/"
                        file_access_paths="$DEFAULT_FILE_ACCESS_PATHS"
                    else
                        file_access_paths="$validated_paths"
                        echo ""
                        echo "✓ File access granted to: $validated_paths"
                    fi
                fi
            else
                # Invalid option when exploration is disabled
                echo "⚠️  Invalid option - defaulting to docs/"
                file_access_enabled=true
                file_access_paths="$DEFAULT_FILE_ACCESS_PATHS"
            fi
            ;;
        *)
            # Default to docs only
            file_access_enabled=true
            file_access_paths="$DEFAULT_FILE_ACCESS_PATHS"
            echo "✓ Defaulting to docs/ only"
            ;;
    esac
    
    prompt_with_default "Coordinator review period (cycles between reviews)" "$review_period" review_period
    prompt_with_default "Max concurrent agents" "$max_concurrent" max_concurrent
elif [ "$modify_directive" != "true" ]; then
    # Defaults if not customizing (but not when modifying - settings already loaded)
    # Always enable MCP for runtime outputs (essential for CodeExecutionAgent)
    file_access_enabled=true
    file_access_paths="runtime/outputs/, runtime/exports/"
fi

# ============================================================
# STEP 3.5: External MCP Servers (Optional, Advanced)
# ============================================================
if [ "$skip_questions" != "true" ] && [ "$modify_directive" != "true" ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🌐 External MCP Servers (Optional)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Enable GitHub MCP for repository access?"
    echo ""
    echo "GitHub MCP allows agents to:"
    echo "  • Search and access millions of open-source repositories"
    echo "  • Read code files without local cloning"
    echo "  • Research implementation patterns and best practices"
    echo ""
    
    if prompt_yes_no "Enable GitHub MCP?" "n"; then
        enable_github_mcp=true
        echo ""
        echo "GitHub requires a Personal Access Token (PAT)"
        echo "Get one at: https://github.com/settings/tokens"
        echo "Permissions needed: public_repo (read-only)"
        echo ""
        read -sp "GitHub token (or Enter to skip): " github_token
        echo ""
        
        if [ -n "$github_token" ]; then
            export GITHUB_PERSONAL_ACCESS_TOKEN="$github_token"
            echo "✓ GitHub MCP will be enabled"
        else
            enable_github_mcp=false
            echo "⚠️  Skipped (no token provided)"
        fi
    else
        enable_github_mcp=false
    fi
else
    # Defaults when not prompting or modifying directive
    enable_github_mcp=${enable_github_mcp:-false}
fi

# ============================================================
# STEP 4: Summary & Confirmation
# ============================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📋 STEP 4: Review & Confirm"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Run:               $selected_run"
if [ "$modify_directive" = "true" ]; then
    echo "Starting Point:    Continue with MODIFIED directive (at cycle $current_cycle)"
    echo "Previous Domain:   $current_directive"
else
    echo "Starting Point:    $([ "$clean_start" = true ] && echo "Fresh start" || echo "Continue existing")"
fi
echo "Exploration Mode:  $exploration_mode"
if [ "$exploration_mode" = "guided" ]; then
    if [ "$modify_directive" = "true" ]; then
        echo "New Domain:        $domain ← UPDATED"
    else
        echo "Domain:            $domain"
    fi
    [ -n "$context" ] && echo "Context:           $context"
    echo "Execution Mode:    ${execution_mode:-mixed}"
fi
if [ "$modify_directive" = "true" ] && [ "$max_cycles" != "null" ]; then
    # Show both current and target for modified runs
    additional=$((max_cycles - current_cycle))
    echo "Max Cycles:        $max_cycles (current: $current_cycle + $additional more)"
else
    echo "Max Cycles:        $([ "$max_cycles" = "null" ] && echo "Unlimited" || echo "$max_cycles")"
fi
echo "Web Search:        $([ "$enable_web_search" = true ] && echo "Enabled" || echo "Disabled")"
echo "Sleep/Dreams:      $([ "$enable_sleep" = true ] && echo "Enabled" || echo "Disabled")"
echo "File Access:       $([ "$file_access_enabled" = true ] && ([ -n "$file_access_paths" ] && echo "Restricted ($file_access_paths)" || echo "Full access") || echo "Disabled")"
[ "$enable_github_mcp" = true ] && echo "GitHub MCP:        Enabled"
echo "Review Period:     Every $review_period cycles"
echo "Max Agents:        $max_concurrent concurrent"
if [ "$cluster_enabled" = true ]; then
    echo "Cluster Mode:      $cluster_backend ($cluster_size instance(s))"
    if [ "$specialization_enabled" = true ] && [ ${#specialization_profile_names[@]} -gt 0 ]; then
        echo "Specialization:    Enabled"
        for i in $(seq 1 ${#specialization_profile_names[@]}); do
            instance_label="cosmo-$i"
            profile_name=${specialization_profile_names[$((i-1))]}
            echo "                   - $instance_label → $profile_name"
        done
    else
        echo "Specialization:    Disabled"
    fi
fi
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if ! prompt_yes_no "Start COSMO with this configuration?" "y"; then
    echo ""
    echo "❌ Launch cancelled. Run ./LAUNCH_COSMO.sh again to try different settings."
    exit 0
fi

# ============================================================
# STEP 5: Generate Configuration & Save Run Metadata
# ============================================================
echo ""
echo "⚙️  Generating configuration..."

# Ensure logs directory exists
mkdir -p runtime
mkdir -p runtime/coordinator

# Set defaults for empty values
context="${context:-No additional context provided}"
domain="${domain:-Open-ended exploration}"

if [ "$specialization_enabled" = true ] && [ ${#specialization_profile_names[@]} -eq 0 ]; then
    specialization_enabled=false
fi

if [ "$specialization_enabled" = true ]; then
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

specialization_profiles_meta_json=$(printf "%s" "$specialization_profiles_meta" | sed 's/"/\\"/g')
specialization_agent_types_meta_json=$(printf "%s" "$specialization_agent_types_meta" | sed 's/"/\\"/g')
specialization_keywords_meta_json=$(printf "%s" "$specialization_keywords_meta" | sed 's/"/\\"/g')
specialization_tags_meta_json=$(printf "%s" "$specialization_tags_meta" | sed 's/"/\\"/g')
specialization_avoid_keywords_meta_json=$(printf "%s" "$specialization_avoid_keywords_meta" | sed 's/"/\\"/g')
specialization_avoid_tags_meta_json=$(printf "%s" "$specialization_avoid_tags_meta" | sed 's/"/\\"/g')

# Save run metadata (for backup/restore/continue) in the run directory
cat > "$RUN_PATH/run-metadata.json" << METADATA
{
  "created": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "backupName": "$backup_name",
  "cleanStart": ${clean_start:-false},
  "explorationMode": "$exploration_mode",
  "domain": "$domain",
  "context": "$context",
  "executionMode": "${execution_mode:-mixed}",
  "maxCycles": "$max_cycles",
  "enableWebSearch": ${enable_web_search:-false},
  "enableSleep": ${enable_sleep:-false},
  "reviewPeriod": ${review_period:-20},
  "maxConcurrent": ${max_concurrent:-2},
  "fileAccessEnabled": ${file_access_enabled:-false},
  "fileAccessPaths": "$file_access_paths",
  "launcherVersion": "1.0",
  "embeddingDimensions": 512,
  "clusterEnabled": ${cluster_enabled:-false},
  "clusterBackend": "${cluster_backend:-none}",
  "clusterSize": ${cluster_size:-1},
  "clusterSpecializationEnabled": ${specialization_enabled:-false},
  "clusterSpecializationProfiles": "$specialization_profiles_meta_json",
  "clusterSpecializationAgentTypes": "$specialization_agent_types_meta_json",
  "clusterSpecializationKeywords": "$specialization_keywords_meta_json",
  "clusterSpecializationTags": "$specialization_tags_meta_json",
  "clusterSpecializationAvoidKeywords": "$specialization_avoid_keywords_meta_json",
  "clusterSpecializationAvoidTags": "$specialization_avoid_tags_meta_json",
  "githubMcpEnabled": ${enable_github_mcp:-false}
}
METADATA

echo "✅ Run metadata saved: runtime/run-metadata.json"

# Escape context for YAML (replace pipes with spaces, escape quotes)
context_escaped=$(echo "$context" | sed 's/|/ /g' | sed "s/'/\\'/g")
domain_escaped=$(echo "$domain" | sed 's/|/ /g' | sed "s/'/\\'/g")

# Generate config file
cat > src/config.yaml << EOF
# COSMO Configuration
# Generated by LAUNCH_COSMO.sh on $(date)
# Run metadata saved in: runtime/run-metadata.json
# To restore this exact run: ./RESTORE_BACKUP.sh [backup_name]

architecture:
  roleSystem:
    type: dynamic
    # Exploration modes:
    #   autonomous - Open-ended exploration with structured prompts
    #   guided     - Focused on specific domain/task with context injection
    #   pure       - Minimal prompting for maximum autonomy (EXPERIMENTAL)
    explorationMode: $exploration_mode
    
    guidedFocus:
      domain: "$domain_escaped"
      executionMode: ${execution_mode:-mixed}
      taskPriority: 1.0
      autonomousPriority: 0.3
      silentPlanning: ${silent_planning:-false}
      context: |
        $context_escaped
      depth: "deep"
      intrinsicBias: 0.8
      curiosityAllowed: true
    
    # Initial roles with multi-mode prompts:
    #   prompt           - Used in autonomous mode (structured exploration)
    #   promptGuided     - Used in guided mode (domain-focused, {domain} and {context} replaced)
    #   promptPure       - Used in pure mode (directional minimal instructions)
    #   systemPromptPure - System message for pure mode (optional, defaults to "You are thinking.")
    initialRoles:
      - id: curiosity
        prompt: "Generate ONE novel question (2-4 sentences)."
        promptGuided: "Generate ONE question about {domain}. {context}"
        promptPure: "Think of something completely new and different."
        systemPromptPure: "You are thinking."
        temperature: 1.0
        max_completion_tokens: 500
        successThreshold: 0.6
        enableMCPTools: true
      - id: analyst
        prompt: "Examine ONE topic (3-5 sentences)."
        promptGuided: "Examine ONE aspect of {domain}. {context}"
        promptPure: "Analyze something from a fresh perspective."
        systemPromptPure: "You are analyzing."
        temperature: 1.0
        max_completion_tokens: 500
        successThreshold: 0.7
        enableMCPTools: true
      - id: critic
        prompt: "Critically evaluate ONE assumption (3-5 sentences)."
        promptGuided: "Evaluate ONE assumption about {domain}. {context}"
        promptPure: "Challenge one conventional idea."
        systemPromptPure: "You are observing."
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
    parallelBranches: 5
    collapseStrategy: weighted
    entanglementEnabled: true
    tunnelingProbability: 0.02
    features:
      branchPolicy:
        enabled: true
      latentProjector:
        enabled: true
      consistencyReview:
        enabled: true
        divergenceThreshold: 0.85  # Raised from 0.70 - creative reasoning naturally diverges
        maxBranchesAnalyzed: 3
        minCyclesBetweenReviews: 3  # Prevent every-cycle spam while staying responsive
    latentProjector:
      maxMemoryNodes: 5
      maxGoalCount: 3
      hintMaxLength: 140
      vectorSize: 128
      autoTrain: true
      autoTrainThreshold: 100
      autoTrainInterval: 50
  
  creativity:
    chaosEnabled: true
    chaoticRNN:
      size: 100
      spectralRadius: 0.95
      updateSteps: 10
      perturbationInterval: 300
    mutations:
      enabled: true
      mutationRate: 0.1
      hybridizationRate: 0.05
  
  goals:
    intrinsicEnabled: true
    discoveryMethod: reflection
    maxGoals: 150
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
    surpriseEnabled: true
    freeEnergyTarget: 0.5
  
  environment:
    sensorsEnabled: true
    sensors:
      - name: system_time
        type: internal
        pollInterval: 60
        enabled: true
  
  temporal:
    sleepEnabled: $enable_sleep
    oscillations:
      enabled: true
      fastPhaseDuration: 300
      slowPhaseDuration: 120
  
  cognitiveState:
    curiosityEnabled: true
    moodEnabled: true
    energyEnabled: true
    adaptationRate: 1.0
    initialCuriosity: 0.5
    initialMood: 0.5
    initialEnergy: 1.0
  
  reflection:
    enabled: true

models:
  primary: gpt-5
  fast: gpt-5-mini
  nano: gpt-5-mini
  embeddings: text-embedding-3-small
  defaultReasoningEffort: low
  defaultMaxTokens: 6000
  enableWebSearch: $enable_web_search
  enableExtendedReasoning: true

providers:
  openai:
    enabled: true

coordinator:
  enabled: true
  reviewCyclePeriod: $review_period
  model: gpt-5-mini
  reasoningEffort: low
  maxTokens: 3000
  maxConcurrent: $max_concurrent
  
  # Token optimization
  useTemplateReports: true
  useMemorySummaries: true
  extractiveSummarization: true
  
  qualityAssurance:
    enabled: $([ "$exploration_mode" = "guided" ] && echo "false" || echo "true")
    mode: 'balanced'
    minConfidence: 0.7
    autoRejectThreshold: 0.3
    checkNovelty: false
    checkConsistency: true
    checkFactuality: false
  
  agentTypeWeights:
    planning: 25
    integration: 25
    code_creation: 25        # Code file generation - critical for implementation
    research: 20
    analysis: 20
    synthesis: 20
    document_creation: 15    # Document generation and reports
    code_execution: 10
    exploration: 10
    document_analysis: 10    # Document comparison and analysis
    specialized_binary: 10   # Binary file processing (PDF, DOCX, XLSX)
    completion: 5            # Oversight and validation
    quality_assurance: 5
    consistency: 5           # Auto-spawned for divergence checks
  
  codeExecution:
    enabled: true
    containerTimeout: 600000
    maxContainersPerReview: 1
    autoCleanup: true

execution:
  baseInterval: 60
  maxCycles: $max_cycles
  adaptiveTimingEnabled: true

timeouts:
  cycleTimeoutMs: 180000      # 3 minutes - coordinator reviews are strategic deep-thinking
  operationTimeoutMs: 120000  # 2 minutes - agent operations can be heavy

resources:
  memoryLimitMB: 1024
  memoryWarningThreshold: 0.8
  cpuWarningThreshold: 0.9

cluster:
  enabled: $cluster_enabled
  backend: $cluster_backend
  instanceCount: $cluster_size
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
      enabled: false  # Disable milestone gate for parallel task execution
  redis:
    url: "redis://localhost:6379"
    tls: false
    acl: false
    keyPrefix: "cosmo:cluster:"
  filesystem:
    root: "/tmp/cosmo_cluster"
    leaseMs: 5000
    graceMs: 2000
EOF

if [ "$specialization_enabled" = "true" ]; then
    domain_yaml="[]"
    if [ "$exploration_mode" = "guided" ] && [ -n "$domain" ]; then
        domain_escaped=$(printf "%s" "$domain" | sed "s/'/''/g")
        domain_yaml="['$domain_escaped']"
    fi

    cat <<EOF >> src/config.yaml
  specialization:
    enabled: true
    defaults:
      boost: 2
      penalty: 0.5
      unmatchedPenalty: 0.9
      minMultiplier: 0.3
      maxMultiplier: 3
      nonPreferredPenalty: 0.1
    profiles:
EOF

    for i in $(seq 1 $cluster_size); do
        idx=$((i-1))
        instance_label="cosmo-$i"
        profile_name=${specialization_profile_names[$idx]}
        agent_types=${specialization_agent_types[$idx]}
        keywords=${specialization_keywords[$idx]}
        tags=${specialization_tags[$idx]}
        avoid_keywords=${specialization_avoid_keywords[$idx]}
        avoid_tags=${specialization_avoid_tags[$idx]}

        cat <<EOF >> src/config.yaml
      $instance_label:
        name: $profile_name
        agentTypes: $agent_types
        keywords: $keywords
        tags: $tags
        avoidKeywords: $avoid_keywords
        avoidTags: $avoid_tags
        domains: $domain_yaml
EOF
    done
else
    cat <<EOF >> src/config.yaml
  specialization:
    enabled: false
EOF
fi

cat <<EOF >> src/config.yaml

acceptance:
  enabled: true
  defaultThreshold: 0.7
  qaEnabled: true
  toolValidation: true
  literalValidation: true
  minConfidence: 0.7
  autoRejectThreshold: 0.3

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
    enabled: $file_access_enabled
    servers:
      - label: "filesystem"
        type: "http"
        url: "http://localhost:3347/mcp"
        auth: null
        allowedTools: ["read_file", "read_binary_file", "list_directory"]
        requireApproval: "never"
        enabled: $file_access_enabled
EOF

# Add allowedPaths array for cosmo-repo server
if [ "$file_access_enabled" = "true" ]; then
    # Special case: FULL_ACCESS means no allowedPaths restriction
    # (node_modules/ and .git/ still excluded at MCP server level)
    if [ "$file_access_paths" = "FULL_ACCESS" ]; then
        echo "        # Full repository access (node_modules/ and .git/ excluded at server level)" >> src/config.yaml
    else
        # If no paths specified, use outputs only (safe default)
        if [ -z "$file_access_paths" ]; then
            file_access_paths="runtime/outputs/, runtime/exports/"
        fi
        
        echo "        allowedPaths:" >> src/config.yaml
        # Split comma-separated paths and add each as array element
        IFS=',' read -ra PATH_ARRAY <<< "$file_access_paths"
        for path in "${PATH_ARRAY[@]}"; do
            # Trim whitespace
            path=$(echo "$path" | xargs)
            echo "          - \"$path\"" >> src/config.yaml
        done
    fi
fi

# Add GitHub MCP server if enabled
if [ "$enable_github_mcp" = "true" ]; then
    # Use non-quoted heredoc to expand the GITHUB_PERSONAL_ACCESS_TOKEN variable
    cat >> src/config.yaml << MCP_GITHUB
      
      - label: "github"
        type: "external_process"
        command: "npx"
        args: ["-y", "@modelcontextprotocol/server-github"]
        env:
          GITHUB_PERSONAL_ACCESS_TOKEN: "${GITHUB_PERSONAL_ACCESS_TOKEN}"
        requireApproval: "never"
        enabled: true
MCP_GITHUB
fi

echo "✅ Configuration generated: src/config.yaml"

# ============================================================
# STEP 5: Initialize Run Directory
# ============================================================
echo ""
echo "⚙️  Initializing run directory..."

# Ensure run directory structure
mkdir -p "$RUN_PATH/coordinator"
mkdir -p "$RUN_PATH/agents"
mkdir -p "$RUN_PATH/policies"
mkdir -p "$RUN_PATH/training"

# If clean start, ensure state files don't exist
if [ "$clean_start" = true ]; then
    rm -f "$RUN_PATH/state.json"*
    rm -f "$RUN_PATH/thoughts.jsonl"
    rm -f "$RUN_PATH/topics-queue.json"
    echo "✅ Clean state initialized"
else
    echo "✅ Continuing from existing state"
fi

# ALWAYS clear topics queue (even on resume) to prevent old example topics from being injected
# User can add new topics manually if needed
rm -f "$RUN_PATH/topics-queue.json"
echo "✅ Topics queue cleared (add topics manually if needed)"

# ============================================================
# STEP 6: Check MCP Server
# ============================================================
echo ""
echo "🔍 Checking MCP filesystem server..."
if lsof -i :3337 > /dev/null 2>&1; then
    echo "✅ MCP server running on port 3337"
else
    if [ -f "mcp/filesystem-server.js" ]; then
        echo "🚀 Starting MCP server..."
        node mcp/filesystem-server.js 3337 > filesystem-mcp.log 2>&1 &
        sleep 2
        if lsof -i :3337 > /dev/null 2>&1; then
            echo "✅ MCP server started"
        else
            echo "⚠️  MCP server failed to start (optional)"
        fi
    else
        echo "⚠️  MCP server not found (optional)"
    fi
fi

# ============================================================
# STEP 7: Launch Full Stack!
# ============================================================
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🚀 LAUNCHING COSMO - FULL STACK"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Preparing directories..."
# Create required directories
mkdir -p logs
# Note: runtime is a symlink (created earlier), not a directory
mkdir -p "$RUN_PATH/coordinator"
mkdir -p "$RUN_PATH/agents"

echo "Starting all services..."
echo ""

# Note: Previously delegated to START_ALL.sh for resume, but that caused infinite loop
# since START_ALL.sh just calls LAUNCH_COSMO.sh again. Now we continue normally.

# Start MCP HTTP server in background (includes filesystem + brain tools)
ensure_port_clear 3347 "Filesystem MCP server"
echo "🔧 Starting MCP HTTP Server (port 3347)..."
node mcp/http-server.js 3347 > logs/mcp-http.log 2>&1 &
sleep 2

# Start MCP dashboard in background
ensure_port_clear 3346 "MCP dashboard"
echo "🔧 Starting MCP Dashboard (port 3346)..."
node mcp/dashboard-server.js > logs/mcp-dashboard.log 2>&1 &
sleep 2

if [ "$cluster_enabled" = true ] && [ "$cluster_size" -gt 1 ]; then
    echo "ℹ️  Skipping single-instance dashboard bootstrap (cluster mode will launch per-instance dashboards)."
    # Clear any lingering cluster PID files to avoid stale references
    rm -f .cosmo_cluster_dashboard_pids .cluster_dashboard_pid
else
    # Start main dashboard in background
    ensure_port_clear 3344 "Main Dashboard"
    echo "🔧 Starting Main Dashboard (port 3344)..."
    node src/dashboard/server.js > logs/dashboard.log 2>&1 &
    sleep 2
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ All Support Services Started!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🌐 Access URLs:"
if [ "$cluster_enabled" = true ] && [ "$cluster_size" -gt 1 ]; then
    end_port=$((3343 + cluster_size - 1))
    echo "  • Cluster Dashboards:  http://localhost:3343 → http://localhost:$end_port"
else
    echo "  • Main Dashboard:      http://localhost:3344"
fi
echo "  • MCP Dashboard:       http://localhost:3346"
echo "  • MCP HTTP Server:     http://localhost:3347"
echo ""
echo "📋 Logs:"
if [ "$cluster_enabled" = true ] && [ "$cluster_size" -gt 1 ]; then
    echo "  • Cluster Dashboards:  tail -f logs/cluster-cosmo-*-dashboard.log"
    echo "  • Hive Observatory:    tail -f logs/cluster-dashboard.log"
else
    echo "  • Main Dashboard:      tail -f logs/dashboard.log"
fi
echo "  • MCP Dashboard:       tail -f logs/mcp-dashboard.log"
echo "  • MCP HTTP:            tail -f logs/mcp-http.log"
echo ""
echo "🛑 Stop: Press Ctrl+C - will stop orchestrator; use 'pkill node' to stop all"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "🧠 Starting COSMO Core Orchestrator..."
echo ""

# TUI disabled by default for testing
export COSMO_TUI=false
export COSMO_TUI_SPLIT=false

# ============================================================
# LAUNCH MODE: Single Instance vs Hive Mind Cluster
# ============================================================

if [ "$cluster_enabled" = true ]; then
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🧬 LAUNCHING HIVE MIND CLUSTER"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Configuration:"
    echo "  Instances:  $cluster_size"
    echo "  Backend:    $cluster_backend"
    echo "  Config:     $CONFIG_FILE"
    echo ""
    
    # Start Redis if using Redis backend
    if [ "$cluster_backend" = "redis" ]; then
        echo "🔴 Checking Redis..."
        
        # Check if Redis is already running
        if redis-cli ping > /dev/null 2>&1; then
            echo "  ✓ Redis already running"
        else
            echo "  🚀 Starting Redis server..."
            
            # Check if redis-server is available
            if command -v redis-server > /dev/null 2>&1; then
                redis-server --daemonize yes --port 6379
                sleep 2
                
                if redis-cli ping > /dev/null 2>&1; then
                    echo "  ✓ Redis started successfully"
                else
                    echo "  ❌ Redis failed to start"
                    echo "  Please install Redis: brew install redis"
                    exit 1
                fi
            else
                echo "  ❌ redis-server not found"
                echo "  Install Redis: brew install redis"
                exit 1
            fi
        fi
        echo ""
    fi
    
    echo "Starting cluster..."
    echo ""
    
    # Use launch-cluster.sh for multi-instance deployment
    BASE_DASHBOARD_PORT=3343
    BASE_MCP_PORT=3344

    # Reclaim dashboard ports in case a previous run left listeners behind
    CLUSTER_OBSERVATORY_PORT=3360
    ensure_port_clear "$CLUSTER_OBSERVATORY_PORT" "Hive Mind Observatory"
    rm -f .cluster_dashboard_pid

    rm -f .cosmo_cluster_dashboard_pids
    rm -f .cosmo_cluster_pids
    for i in $(seq 1 $cluster_size); do
        DASHBOARD_PORT=$((BASE_DASHBOARD_PORT + i - 1))
        ensure_port_clear "$DASHBOARD_PORT" "cluster dashboard for cosmo-$i"
    done
    
    # Launch all instances
    for i in $(seq 1 $cluster_size); do
        INSTANCE_ID="cosmo-$i"
        DASHBOARD_PORT=$((BASE_DASHBOARD_PORT + i - 1))
        MCP_PORT=$((BASE_MCP_PORT + i - 1))
        LOG_FILE="logs/cluster-$INSTANCE_ID.log"
        
        echo "🚀 Starting $INSTANCE_ID (Dashboard: $DASHBOARD_PORT, MCP: $MCP_PORT)"
        
        # Start dashboard for this instance
        COSMO_DASHBOARD_PORT="$DASHBOARD_PORT" \
        node src/dashboard/server.js > "logs/cluster-$INSTANCE_ID-dashboard.log" 2>&1 &
        DASHBOARD_PID=$!
        
        sleep 1
        
        # Start instance
        INSTANCE_ID="$INSTANCE_ID" \
        DASHBOARD_PORT="$DASHBOARD_PORT" \
        MCP_PORT="$MCP_PORT" \
        node --expose-gc src/index.js --config "$CONFIG_FILE" > "$LOG_FILE" 2>&1 &
        
        INSTANCE_PID=$!
        echo "$INSTANCE_PID" >> .cosmo_cluster_pids
        echo "$DASHBOARD_PID" >> .cosmo_cluster_dashboard_pids
        
        echo "  ✓ Instance PID: $INSTANCE_PID, Dashboard PID: $DASHBOARD_PID"
        
        # Stagger startup
        if [ $i -lt $cluster_size ]; then
            sleep 3
        fi
    done
    
    echo ""
    echo "⏳ Waiting for cluster to initialize..."
    sleep 10
    
    # Start unified Hive Mind dashboard (use port 3360 to avoid conflicts)
    echo ""
    echo "🌐 Starting Unified Hive Mind Observatory..."
    CLUSTER_DASHBOARD_PORT=3360 \
    INSTANCE_COUNT=$cluster_size \
    BASE_DASHBOARD_PORT=$BASE_DASHBOARD_PORT \
    node src/dashboard/cluster-server.js > logs/cluster-dashboard.log 2>&1 &
    
    CLUSTER_DASH_PID=$!
    echo "$CLUSTER_DASH_PID" > .cluster_dashboard_pid
    
    sleep 2
    
    if ps -p $CLUSTER_DASH_PID > /dev/null 2>&1; then
        echo "  ✓ Hive Mind Observatory started on port 3360"
    else
        echo "  ⚠️  Hive Mind Observatory failed (check logs/cluster-dashboard.log)"
    fi
    
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "✅ HIVE MIND CLUSTER LAUNCHED"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "🌐 Dashboards:"
    echo "  • 🧬 Hive Mind Observatory:  http://localhost:3360"
    for i in $(seq 1 $cluster_size); do
        echo "  • Instance $i Dashboard:      http://localhost:$((BASE_DASHBOARD_PORT + i - 1))"
    done
    echo ""
    echo "📋 Management:"
    echo "  • Health Check:  ./scripts/cluster-health-check.sh"
    echo "  • Stop Cluster:  ./scripts/stop-cluster.sh"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🧬 HIVE MIND COGNITIVE ACTIVITY (Live Stream)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "Showing aggregated output from all $cluster_size minds..."
    echo "Press Ctrl+C to stop the entire hive"
    echo ""
    
    # Setup cleanup trap for Ctrl+C
    cleanup_cluster() {
        echo ""
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        echo "🛑 Stopping Hive Mind Cluster..."
        echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        ./scripts/stop-cluster.sh
        exit 0
    }
    
    trap cleanup_cluster SIGINT SIGTERM
    
    # Wait a moment for instances to start producing output
    sleep 5
    
    # Tail all instance logs showing which mind is thinking
    tail -f logs/cluster-cosmo-*.log 2>/dev/null
    
    # If tail exits, wait for processes
    wait
    
else
    # Single instance mode (original behavior)
    echo "ℹ️  Running in plain text mode (TUI disabled - text is selectable)"
    echo ""
    
    cd src
    node --expose-gc index.js
fi
