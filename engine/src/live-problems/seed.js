/**
 * Seed invariants — problems we know are worth tracking for any Home23 agent.
 *
 * Called once on engine start. Upsert is idempotent: existing problems keep
 * their runtime state (lastResult, stepIndex, etc.) — only the spec is refreshed
 * so plans/thresholds can evolve without resetting progress.
 *
 * Per-agent seeds (e.g. the dashboard URL) are parameterized by agentName +
 * dashboardPort so every agent gets a correct invariant without duplication.
 */

function defaultSeeds({ agentName, dashboardPort, bridgePort }) {
  const agent = agentName || process.env.HOME23_AGENT || 'agent';
  const dashPort = dashboardPort || process.env.DASHBOARD_PORT || process.env.COSMO_DASHBOARD_PORT || '5002';
  const harnessPort = bridgePort || process.env.BRIDGE_PORT || '5004';
  const harnessProc = `home23-${agent}-harness`;
  const dashProc = `home23-${agent}-dash`;
  const instanceRoot = process.cwd().replace(/\/engine$/, '') + `/instances/${agent}`;
  const brainStatePath = `${instanceRoot}/brain/brain-state.json`;
  const thoughtsPath = `${instanceRoot}/brain/thoughts.jsonl`;

  return [
    {
      id: 'health_log_fresh',
      claim: 'iOS Health Shortcut writing ~/.health_log.jsonl within last 6h',
      verifier: {
        type: 'file_mtime',
        args: { path: '~/.health_log.jsonl', maxAgeMin: 360 },
      },
      remediation: [
        // Step 1: try to re-trigger the iOS Shortcut autonomously (if bridge configured).
        { type: 'run_shortcut', args: { target: 'Health' }, cooldownMin: 30 },
        // Step 2: hand to Jerry with full tools — shell probes, cron checks,
        // sibling-bridge pattern cloning. 12h budget.
        { type: 'dispatch_to_agent', args: { budgetHours: 12 }, cooldownMin: 15 },
        // Step 3: last resort, ping jtr.
        {
          type: 'notify_jtr',
          args: {
            severity: 'normal',
            text: "Health log's been silent >6h. Shortcut didn't wake it up. Agent tried for 12h and couldn't fix it. Needs your eyes.",
          },
          cooldownMin: 360,
        },
      ],
      seedOrigin: 'system',
    },
    {
      id: 'disk_free_ok',
      claim: 'Main data volume has at least 10 GiB free',
      verifier: {
        type: 'disk_free',
        args: { mount: '/System/Volumes/Data', minGiB: 10 },
      },
      remediation: [
        { type: 'exec_command', args: { name: 'clean_pm2_logs' }, cooldownMin: 60 },
        { type: 'dispatch_to_agent', args: { budgetHours: 6 }, cooldownMin: 15 },
        {
          type: 'notify_jtr',
          args: {
            severity: 'normal',
            text: "Disk under 10 GiB. Agent cleaned logs and looked for space but couldn't get it back above threshold. Needs a real cleanup pass.",
          },
          cooldownMin: 720,
        },
      ],
      seedOrigin: 'system',
    },
    {
      id: `${agent}_harness_online`,
      claim: `Harness process ${harnessProc} is running`,
      verifier: {
        type: 'pm2_status',
        args: { name: harnessProc },
      },
      // Harness-down edge case: dispatch_to_agent REQUIRES the harness to be
      // up (the agent *is* the harness). Leaving it out of this plan — if
      // pm2 restart can't bring it back, jtr has to look.
      remediation: [
        { type: 'pm2_restart', args: { name: harnessProc }, cooldownMin: 5 },
        {
          type: 'notify_jtr',
          args: {
            severity: 'alert',
            text: `${harnessProc} wouldn't come back after a pm2 restart. Channels are down. Needs hands.`,
          },
          cooldownMin: 60,
        },
      ],
      seedOrigin: 'system',
    },
    {
      id: `${agent}_dashboard_ping`,
      claim: `Dashboard HTTP responding on :${dashPort}`,
      verifier: {
        type: 'http_ping',
        args: { url: `http://127.0.0.1:${dashPort}/home23/agents.json`, timeoutMs: 4000 },
      },
      remediation: [
        { type: 'pm2_restart', args: { name: dashProc }, cooldownMin: 5 },
        { type: 'dispatch_to_agent', args: { budgetHours: 2 }, cooldownMin: 15 },
        {
          type: 'notify_jtr',
          args: {
            severity: 'alert',
            text: `Dashboard ${dashProc} unreachable. pm2 restart and agent diagnosis both failed.`,
          },
          cooldownMin: 60,
        },
      ],
      seedOrigin: 'system',
    },
    {
      id: 'brain_graph_populated',
      claim: 'Brain graph has at least 100 nodes in memory',
      verifier: {
        type: 'graph_not_empty',
        args: { minNodes: 100 },
      },
      // Give agent a 4h budget to investigate the persistence path before
      // escalating. Brain graph problems are often recoverable (stale cache,
      // pending write, etc.) but sometimes need fresh eyes.
      remediation: [
        { type: 'dispatch_to_agent', args: { budgetHours: 4 }, cooldownMin: 15 },
        {
          type: 'notify_jtr',
          args: {
            severity: 'alert',
            text: 'Brain graph near-empty and the agent couldn\'t recover it. Persistence or load path is broken — please look.',
          },
          cooldownMin: 360,
        },
      ],
      seedOrigin: 'system',
    },
    {
      id: 'brain_node_count_stable',
      claim: 'Brain node count has not regressed >10% below all-time high-water mark',
      verifier: {
        type: 'node_count_stable',
        args: { dropThreshold: 0.1, minBaseline: 100 },
      },
      // Drops to this trigger are usually in-process (pruning bug, bad
      // cluster sync, truncated save) — agent can investigate with shell
      // + brain tools and often restore from backups/.
      remediation: [
        { type: 'dispatch_to_agent', args: { budgetHours: 4 }, cooldownMin: 15 },
        {
          type: 'notify_jtr',
          args: {
            severity: 'alert',
            text: 'Brain node count dropped >10% from high-water mark. Agent investigated but could not restore. Possible data loss — check backups/.',
          },
          cooldownMin: 360,
        },
      ],
      seedOrigin: 'system',
    },
    // ── New invariants using compositional primitives ──
    {
      id: 'synthesis_fresh',
      claim: 'Synthesis agent output is fresh (brain-state.json modified within 6h)',
      verifier: {
        type: 'file_mtime',
        args: { path: brainStatePath, maxAgeMin: 360 },
      },
      // Stale synthesis = pulse brief's "BACKDROP" and consolidatedInsights
      // are feeding Jerry from old context. The brain keeps running but its
      // narrative layer goes stale.
      remediation: [
        { type: 'dispatch_to_agent', args: { budgetHours: 2 }, cooldownMin: 30 },
        {
          type: 'notify_jtr',
          args: {
            severity: 'normal',
            text: "Synthesis hasn't run in 6h+ — insights are going stale. Intelligence tab should be kicking this every 4h. Check the scheduler.",
          },
          cooldownMin: 720,
        },
      ],
      seedOrigin: 'system',
    },
    {
      id: 'thoughts_flowing',
      claim: 'Cognitive loop producing thoughts (thoughts.jsonl has an entry within 20 min)',
      verifier: {
        type: 'jsonl_recent_match',
        args: { path: thoughtsPath, tsField: 'timestamp', windowMinutes: 20, minCount: 1 },
      },
      // If thoughts.jsonl stops growing, the cognitive loop is stalled —
      // either the engine deadlocked, the loop errored out of the catch, or
      // a model provider is failing and no branches are landing. Immediate
      // pm2 restart is the right first move; otherwise the whole brain
      // appears alive (process up) but isn't actually thinking.
      remediation: [
        { type: 'pm2_restart', args: { name: `home23-${agent}` }, cooldownMin: 15 },
        { type: 'dispatch_to_agent', args: { budgetHours: 2 }, cooldownMin: 15 },
        {
          type: 'notify_jtr',
          args: {
            severity: 'alert',
            text: "Cognitive loop stalled — no new thoughts in 20+ min. Restarted the engine once, no recovery. Model provider or deeper stall.",
          },
          cooldownMin: 60,
        },
      ],
      seedOrigin: 'system',
    },
    {
      id: 'chrome_cdp_reachable',
      claim: 'Headless Chrome CDP responding on :9222 (required for web_browse tool)',
      verifier: {
        type: 'http_ping',
        args: { url: 'http://127.0.0.1:9222/json/version', timeoutMs: 3000 },
      },
      // The agent's web_browse tool needs this. pm2_restart of the wrapper
      // process brings it back cleanly.
      remediation: [
        { type: 'pm2_restart', args: { name: 'home23-chrome-cdp' }, cooldownMin: 5 },
        { type: 'dispatch_to_agent', args: { budgetHours: 1 }, cooldownMin: 15 },
        {
          type: 'notify_jtr',
          args: {
            severity: 'normal',
            text: "Chrome CDP is down and won't come back via pm2 restart. web_browse tool is unusable until this is fixed.",
          },
          cooldownMin: 720,
        },
      ],
      seedOrigin: 'system',
    },
    {
      id: 'sauna_sensor_fresh',
      claim: 'Sauna tile sensor refreshing within last 10 min',
      verifier: {
        type: 'jsonpath_http',
        args: {
          url: `http://127.0.0.1:${dashPort}/api/sensors`,
          path: 'sensors[id=tile.sauna-control].ts',
          op: '>',
          value: '{{iso:now-10min}}',
          timeoutMs: 4000,
        },
      },
      // Tile-backed sensors refresh on their own cadence; if stale, the
      // tile handler itself may be wedged. Agent can probe it.
      remediation: [
        { type: 'dispatch_to_agent', args: { budgetHours: 1 }, cooldownMin: 15 },
        {
          type: 'notify_jtr',
          args: {
            severity: 'normal',
            text: "Sauna sensor hasn't refreshed in 10+ min — the Huum tile integration might be wedged. Low priority unless you're actively using it.",
          },
          cooldownMin: 720,
        },
      ],
      seedOrigin: 'system',
    },
    {
      id: 'weather_sensor_fresh',
      claim: 'Weather tile sensor refreshing within last 15 min',
      verifier: {
        type: 'jsonpath_http',
        args: {
          url: `http://127.0.0.1:${dashPort}/api/sensors`,
          path: 'sensors[id=tile.outside-weather].ts',
          op: '>',
          value: '{{iso:now-15min}}',
          timeoutMs: 4000,
        },
      },
      remediation: [
        { type: 'dispatch_to_agent', args: { budgetHours: 1 }, cooldownMin: 15 },
        {
          type: 'notify_jtr',
          args: {
            severity: 'normal',
            text: "Weather sensor hasn't refreshed in 15+ min — Ecowitt tile integration might be wedged.",
          },
          cooldownMin: 720,
        },
      ],
      seedOrigin: 'system',
    },
  ];
}

function seedAll(store, opts) {
  const seeds = defaultSeeds(opts || {});
  for (const s of seeds) store.upsert(s);
  return seeds;
}

module.exports = { seedAll, defaultSeeds };
