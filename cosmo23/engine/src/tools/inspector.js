#!/usr/bin/env node
/**
 * Phase 2B System Inspector
 * Developer tool for inspecting system state
 * From Phase2B: "Inspection & Organization Tools"
 */

const fs = require('fs').promises;
const path = require('path');

class SystemInspector {
  constructor(logsDir) {
    this.logsDir = logsDir || path.join(__dirname, '..', '..', 'runtime');
  }

  /**
   * Load current state
   */
  async loadState() {
    try {
      const statePath = path.join(this.logsDir, 'state.json');
      const data = await fs.readFile(statePath, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      console.error('Failed to load state:', error.message);
      return null;
    }
  }

  /**
   * Display system overview
   */
  async displayOverview() {
    const state = await this.loadState();
    if (!state) return;

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║       Phase 2B System Inspector - Overview      ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log('📊 SYSTEM METRICS:');
    console.log(`  Cycle Count: ${state.cycleCount}`);
    console.log(`  Last Updated: ${new Date(state.timestamp).toLocaleString()}`);
    console.log(`  Journal Entries: ${state.journal?.length || 0}`);
    console.log('');

    if (state.oscillator) {
      console.log('🔄 OSCILLATOR STATE:');
      console.log(`  Current Mode: ${state.oscillator.currentMode.toUpperCase()}`);
      console.log(`  Time Remaining: ${state.oscillator.timeRemaining}s`);
      console.log(`  Cycle Count: ${state.oscillator.cycleCount}`);
      console.log(`  Exploration Productivity: ${state.oscillator.explorationProductivity}`);
      console.log('');
    }

    if (state.memory) {
      console.log('🧠 MEMORY NETWORK:');
      console.log(`  Nodes: ${state.memory.nodes?.length || 0}`);
      console.log(`  Edges: ${state.memory.edges?.length || 0}`);
      console.log(`  Clusters: ${state.memory.clusters?.length || 0}`);
      console.log('');
    }

    if (state.goals) {
      console.log('🎯 GOALS:');
      console.log(`  Active: ${state.goals.active?.length || 0}`);
      console.log(`  Completed: ${state.goals.completed?.length || 0}`);
      console.log('');
    }

    if (state.roles) {
      console.log('👥 ROLES:');
      console.log(`  Total: ${state.roles?.length || 0}`);
      const avgSuccess = state.roles?.reduce((sum, r) => sum + (r.successRate || 0), 0) / (state.roles?.length || 1);
      console.log(`  Average Success Rate: ${(avgSuccess * 100).toFixed(1)}%`);
      console.log('');
    }
  }

  /**
   * Display active goals
   */
  async displayGoals() {
    const state = await this.loadState();
    if (!state || !state.goals) return;

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║            Active Goals Backlog                  ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const goals = state.goals.active?.map(([id, goal]) => goal) || [];
    
    if (goals.length === 0) {
      console.log('  No active goals.\n');
      return;
    }

    goals.sort((a, b) => b.priority - a.priority);

    for (const goal of goals.slice(0, 15)) {
      const priorityBar = '█'.repeat(Math.floor(goal.priority * 10));
      const progressBar = '▓'.repeat(Math.floor(goal.progress * 10));
      
      console.log(`\n  ${goal.id} [${goal.source}]`);
      console.log(`  "${goal.description.substring(0, 70)}..."`);
      console.log(`  Priority: ${priorityBar} ${(goal.priority * 100).toFixed(0)}%`);
      console.log(`  Progress: ${progressBar} ${(goal.progress * 100).toFixed(0)}%`);
      console.log(`  Pursued: ${goal.pursuitCount} times`);
    }

    console.log('');
  }

  /**
   * Display memory network statistics
   */
  async displayMemoryStats() {
    const state = await this.loadState();
    if (!state || !state.memory) return;

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║         Memory Network Statistics                ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const nodes = state.memory.nodes || [];
    const edges = state.memory.edges || [];

    console.log('📈 NETWORK TOPOLOGY:');
    console.log(`  Total Nodes: ${nodes.length}`);
    console.log(`  Total Edges: ${edges.length}`);
    console.log(`  Average Degree: ${(edges.length * 2 / nodes.length).toFixed(2)}`);
    console.log('');

    // Count by type
    const typeCounts = {};
    for (const node of nodes) {
      const type = node.tag || 'unknown';
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }

    console.log('📦 NODE TYPES:');
    for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type}: ${count}`);
    }
    console.log('');

    // Recent additions
    const recent = nodes
      .sort((a, b) => new Date(b.created) - new Date(a.created))
      .slice(0, 5);

    console.log('🆕 RECENT MEMORIES:');
    for (const node of recent) {
      console.log(`  [${node.tag}] ${node.concept.substring(0, 60)}...`);
    }
    console.log('');
  }

  /**
   * Display recent thoughts
   */
  async displayRecentThoughts(count = 10) {
    const state = await this.loadState();
    if (!state || !state.journal) return;

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║           Recent Thought Stream                  ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const recent = state.journal.slice(-count);

    for (const entry of recent) {
      const modeIcon = entry.oscillatorMode === 'explore' ? '🔍' : '🎯';
      const date = new Date(entry.timestamp).toLocaleTimeString();
      
      console.log(`\n${modeIcon} Cycle ${entry.cycle} [${entry.role}] @ ${date}`);
      console.log(`  Mode: ${entry.oscillatorMode}`);
      console.log(`  Surprise: ${(entry.surprise * 100).toFixed(0)}%`);
      console.log(`  "${entry.thought.substring(0, 100)}..."`);
      
      if (entry.goal) {
        console.log(`  Goal: ${entry.goal.substring(0, 50)}`);
      }
      
      if (entry.goalsAutoCaptured > 0) {
        console.log(`  ✨ Captured ${entry.goalsAutoCaptured} new goal(s)`);
      }
    }

    console.log('');
  }

  /**
   * Display role performance
   */
  async displayRoles() {
    const state = await this.loadState();
    if (!state || !state.roles) return;

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║            Role Performance                      ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const roles = state.roles.sort((a, b) => b.successRate - a.successRate);

    for (const role of roles) {
      const successBar = '█'.repeat(Math.floor(role.successRate * 20));
      
      console.log(`\n  ${role.id}`);
      console.log(`  Success: ${successBar} ${(role.successRate * 100).toFixed(1)}%`);
      console.log(`  Used: ${role.useCount} times`);
      console.log(`  Created: ${new Date(role.created).toLocaleDateString()}`);
      console.log(`  Prompt: "${role.prompt.substring(0, 70)}..."`);
    }

    console.log('');
  }

  /**
   * Display reflection insights
   */
  async displayReflection() {
    const state = await this.loadState();
    if (!state || !state.reflection) return;

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║         Reflection & Meta-Cognition             ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const refl = state.reflection;

    if (refl.patterns?.length > 0) {
      console.log('🔍 DETECTED PATTERNS:');
      for (const [pattern, data] of refl.patterns.slice(0, 5)) {
        console.log(`  • ${pattern}: ${data.occurrences} times`);
      }
      console.log('');
    }

    if (refl.strategies?.length > 0) {
      console.log('🎓 LEARNED STRATEGIES:');
      for (const [strategy, data] of refl.strategies.slice(0, 5)) {
        console.log(`  • ${strategy}`);
        console.log(`    Effectiveness: ${(data.effectiveness * 100).toFixed(0)}%`);
      }
      console.log('');
    }

    if (refl.improvements?.length > 0) {
      const pending = refl.improvements.filter(i => !i.applied);
      if (pending.length > 0) {
        console.log('💡 PENDING IMPROVEMENTS:');
        for (const imp of pending.slice(0, 5)) {
          console.log(`  • ${imp.area}: ${imp.suggestion}`);
        }
        console.log('');
      }
    }
  }

  /**
   * Interactive menu
   */
  async showMenu() {
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const showOptions = () => {
      console.log('\n╔══════════════════════════════════════════════════╗');
      console.log('║          System Inspector - Options              ║');
      console.log('╚══════════════════════════════════════════════════╝');
      console.log('\n  1. System Overview');
      console.log('  2. Active Goals');
      console.log('  3. Memory Network');
      console.log('  4. Recent Thoughts');
      console.log('  5. Role Performance');
      console.log('  6. Reflection Insights');
      console.log('  7. All Reports');
      console.log('  q. Quit\n');
    };

    const handleChoice = async (choice) => {
      switch (choice.trim()) {
        case '1':
          await this.displayOverview();
          break;
        case '2':
          await this.displayGoals();
          break;
        case '3':
          await this.displayMemoryStats();
          break;
        case '4':
          await this.displayRecentThoughts();
          break;
        case '5':
          await this.displayRoles();
          break;
        case '6':
          await this.displayReflection();
          break;
        case '7':
          await this.displayOverview();
          await this.displayGoals();
          await this.displayMemoryStats();
          await this.displayRecentThoughts();
          await this.displayRoles();
          await this.displayReflection();
          break;
        case 'q':
        case 'quit':
          console.log('\nExiting inspector.\n');
          readline.close();
          process.exit(0);
          return;
        default:
          console.log('\nInvalid choice. Please try again.');
      }
      
      showOptions();
      readline.question('Select option: ', handleChoice);
    };

    showOptions();
    readline.question('Select option: ', handleChoice);
  }
}

// Run if called directly
if (require.main === module) {
  const inspector = new SystemInspector();
  
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === 'menu') {
    inspector.showMenu();
  } else {
    switch (args[0]) {
      case 'overview':
        inspector.displayOverview().then(() => process.exit(0));
        break;
      case 'goals':
        inspector.displayGoals().then(() => process.exit(0));
        break;
      case 'memory':
        inspector.displayMemoryStats().then(() => process.exit(0));
        break;
      case 'thoughts':
        const count = parseInt(args[1]) || 10;
        inspector.displayRecentThoughts(count).then(() => process.exit(0));
        break;
      case 'roles':
        inspector.displayRoles().then(() => process.exit(0));
        break;
      case 'reflection':
        inspector.displayReflection().then(() => process.exit(0));
        break;
      case 'all':
        (async () => {
          await inspector.displayOverview();
          await inspector.displayGoals();
          await inspector.displayMemoryStats();
          await inspector.displayRecentThoughts();
          await inspector.displayRoles();
          await inspector.displayReflection();
          process.exit(0);
        })();
        break;
      default:
        console.log('Usage: node inspector.js [menu|overview|goals|memory|thoughts|roles|reflection|all]');
        process.exit(1);
    }
  }
}

module.exports = { SystemInspector };

