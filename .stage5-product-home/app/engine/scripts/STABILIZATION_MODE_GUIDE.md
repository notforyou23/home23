# COSMO Stabilization Mode - Complete Guide

**Date:** December 4, 2025  
**Status:** ✅ Implemented in Both Launchers  

---

## What is Stabilization Mode?

Stabilization mode is a **special configuration profile** for the first 20-50 cycles after:
- Merging multiple brains
- Major knowledge imports
- Significant architecture changes

It **disables exploration/creativity** and focuses on **consolidation and integration**.

---

## How to Enable

### Web Launcher (Recommended)
1. Open launcher: http://localhost:3340
2. Select your run
3. ✅ **Check "🔒 Stabilization Mode"** in Capabilities section
4. See orange warning box with overrides
5. Click "📄 Preview Config" to verify
6. Launch

### Terminal Launcher
1. Run: `./cosmo` or `./start`
2. Select your run
3. In Command Center, select option **11**
4. Answer `y` to enable stabilization mode
5. Review final settings
6. Launch

---

## What It Does

### When ENABLED (Stabilization):

**Cognitive Systems:**
- ❌ curiosityAllowed: `false`
- ❌ curiosityEnabled: `false`
- ❌ moodEnabled: `false`

**Quantum Reasoning:**
- ⬇️ parallelBranches: `3` (normally 5)
- ❌ tunnelingProbability: `0` (normally 0.02)

**Creativity & Chaos:**
- ❌ chaosEnabled: `false`
- ❌ mutations.enabled: `false`
- ❌ mutationRate: `0`
- ❌ hybridizationRate: `0`

**Thermodynamic:**
- ❌ surpriseEnabled: `false`

**Agent Controls:**
- ⬇️ maxConcurrent: `2` (normally 4)
- ⬇️ reviewCyclePeriod: `5` (normally 20)
- ❌ exploration weight: `0` (normally 10)

### When DISABLED (Normal Mode):

All systems active at normal levels:
- ✅ Curiosity-driven exploration
- ✅ Full quantum branching (5 parallel)
- ✅ Chaotic creativity & mutations
- ✅ Thermodynamic surprise
- ✅ Normal concurrency (4 agents)
- ✅ Standard review frequency (20 cycles)

---

## When to Use

### ✅ USE Stabilization For:

1. **After merging brains** (BigBrain v0, multi-domain merges)
   - Lets merged knowledge settle
   - Prevents conflicting patterns from emerging
   - Focuses on consolidation

2. **After major imports** (large document sets, knowledge bases)
   - Integrates new knowledge systematically
   - Prevents chaos before consolidation

3. **Recovery from instability** (excessive branching, goal explosion)
   - Calms the system down
   - Reduces computational load
   - Focuses on existing knowledge

### ❌ DON'T Use Stabilization For:

1. **Normal exploration runs** - Defeats the purpose
2. **Creative tasks** - Needs chaos and mutations
3. **Research missions** - Needs curiosity and exploration
4. **Long-term runs** - Too restrictive for extended operation

---

## Typical Workflow

### Phase 1: Stabilization (20-50 cycles)
```bash
# Enable stabilization mode
./cosmo
# Select BigBrain_v0
# Option 11 → Enable stabilization
# Launch

# Monitor for 20-50 cycles
# Watch for:
#   - Goal consolidation
#   - Memory network settling
#   - No excessive agent spawning
```

### Phase 2: Normal Operation
```bash
# Disable stabilization mode
./cosmo
# Select BigBrain_v0  
# Option 11 → Disable stabilization
# Launch

# Full capabilities restored:
#   - Curiosity active
#   - Chaos & mutations on
#   - Full quantum branching
#   - Exploration agents enabled
```

---

## Configuration Details

### Files Modified

**Terminal Launcher:**
- `scripts/LAUNCH_COSMO.sh` - Added stabilization prompt + conditional logic

**Web Launcher:**
- `src/launcher/index.html` - Added stabilization checkbox + UI feedback
- `src/launcher/config-generator.js` - Added stabilization conditionals

**Both launchers now support stabilization mode!**

---

## Verification

### Check if Stabilization is Active:

```bash
# Look at config.yaml
grep -A1 "curiosityAllowed" src/config.yaml
# Should show: curiosityAllowed: false (if stabilization ON)

grep -A1 "parallelBranches" src/config.yaml  
# Should show: parallelBranches: 3 (if stabilization ON)

grep -A1 "chaosEnabled" src/config.yaml
# Should show: chaosEnabled: false (if stabilization ON)
```

### Check Metadata:

```bash
# Web launcher saves to run-metadata.json
cat runtime/run-metadata.json | grep enableStabilization
# Should show: "enableStabilization": true or false

# Terminal launcher also saves to run-metadata.json
cat runtime/run-metadata.json | grep enableStabilization
```

---

## Expected Behavior in Logs

### With Stabilization ON:
```
✓ Quantum reasoning: 3 parallel branches
✓ Reviews every 5 cycles
✓ Max concurrent agents: 2
✓ Chaotic creativity engine initialized (disabled)
✓ Cognitive state modulator initialized (curiosity OFF, mood OFF)
```

### With Stabilization OFF:
```
✓ Quantum reasoning: 5 parallel branches
✓ Reviews every 20 cycles
✓ Max concurrent agents: 4
✓ Chaotic creativity engine initialized
✓ Cognitive state modulator initialized
```

---

## Troubleshooting

### "Stabilization setting not taking effect"

**Cause:** Running instance already loaded old config  
**Fix:** Stop COSMO completely, then relaunch
```bash
./scripts/STOP_ALL.sh
./cosmo  # or web launcher
```

### "Config shows wrong values after launch"

**Cause:** Cached metadata from previous run  
**Fix:** Verify actual config.yaml (not just metadata display)
```bash
cat src/config.yaml | grep -A1 "curiosityAllowed\|parallelBranches\|chaosEnabled"
```

### "Want to change mid-run"

**Not supported** - Config is loaded at startup  
**Workaround:** Stop, change setting, relaunch

---

## Advanced: Manual Config Override

If you need to manually edit config.yaml:

```yaml
# Find these lines and set to false for stabilization:
curiosityAllowed: false
curiosityEnabled: false
moodEnabled: false
chaosEnabled: false
surpriseEnabled: false

mutations:
  enabled: false
  mutationRate: 0
  hybridizationRate: 0

# And adjust these numbers:
parallelBranches: 3
tunnelingProbability: 0
reviewCyclePeriod: 5
maxConcurrent: 2

# In agentTypeWeights:
exploration: 0
```

---

## For BigBrain v0

### Recommended Launch Sequence:

1. **Merge all domains** (if not done):
   ```bash
   node scripts/scan_runs.js  # Review first
   node scripts/merge_runs.js <all-domains> --output BigBrain_v0
   ```

2. **Link runtime:**
   ```bash
   cd runs && ln -sfn BigBrain_v0 ../runtime
   ```

3. **Launch with stabilization:**
   ```bash
   ./cosmo
   # Select BigBrain_v0
   # Option 11 → Enable stabilization → y
   # Launch
   ```

4. **Monitor for 30-50 cycles:**
   - Watch dashboard
   - Check consolidation happening
   - Verify no excessive agent spawning

5. **Switch to normal mode:**
   ```bash
   # Stop COSMO
   ./scripts/STOP_ALL.sh
   
   # Relaunch without stabilization
   ./cosmo
   # Option 11 → Disable stabilization → n
   # Launch
   ```

6. **Full exploration begins!**

---

## Implementation Status

✅ **Terminal Launcher** - Fully implemented  
✅ **Web Launcher** - Fully implemented  
✅ **Both tested** - Syntax valid  
✅ **Backward compatible** - Default OFF  
✅ **Documented** - This guide  

**Ready for BigBrain v0 production use!** 🚀

