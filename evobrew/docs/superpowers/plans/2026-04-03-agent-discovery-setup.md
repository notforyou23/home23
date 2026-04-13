# Agent Discovery & Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-discover local agents via port scanning, verify identity, and provide setup flows in both CLI wizard and frontend Settings panel.

**Architecture:** Scanner endpoint probes localhost ports for `/health` responses, verifies bridge availability, and returns discovered agents. Save/test/remove endpoints manage config with hot-reload. Frontend adds a "Local Agents" section to the Settings panel. CLI wizard gets a scan-and-select flow.

**Tech Stack:** Express endpoints, native `fetch` for scanning, existing config-manager for persistence, existing Settings panel HTML/JS patterns.

---

### Task 1: Enhance cosmohome health endpoint

**Files:**
- Modify: `/Users/jtr/_JTR23_/cosmo-home_2.3/src/routes/evobrew-bridge.ts`

- [ ] **Step 1: Update createHealthHandler to include type and endpoint**

In `/Users/jtr/_JTR23_/cosmo-home_2.3/src/routes/evobrew-bridge.ts`, replace the `createHealthHandler` function:

```typescript
export function createHealthHandler(config: { agentName: string }) {
  return (_req: Request, res: Response): void => {
    res.json({
      status: 'ok',
      agent: config.agentName,
      type: 'cosmohome',
      endpoint: '/api/chat'
    });
  };
}
```

- [ ] **Step 2: Build and commit**

```bash
cd /Users/jtr/_JTR23_/cosmo-home_2.3 && npx tsc
git add src/routes/evobrew-bridge.ts && git commit -m "feat: include type and endpoint in health response"
```

---

### Task 2: Add scanner and CRUD endpoints to server.js

**Files:**
- Modify: `server/server.js:4847` (after the last `/api/setup/providers/ollama` route, before brains routes)

- [ ] **Step 1: Add the scan-agents endpoint**

Insert after line 4847 in `server/server.js`:

```js
// ── Local Agent Discovery & Setup ──

app.get('/api/setup/scan-agents', async (req, res) => {
  try {
    const host = req.query.host || 'localhost';
    const portMin = parseInt(req.query.portMin) || 4600;
    const portMax = parseInt(req.query.portMax) || 4660;

    const discovered = [];

    const scanPort = async (port) => {
      try {
        const healthResp = await fetch(`http://${host}:${port}/health`, {
          signal: AbortSignal.timeout(1500)
        });
        if (!healthResp.ok) return null;
        const health = await healthResp.json();
        if (!health.status || !health.agent) return null;

        // Check if bridge endpoint exists
        let bridgeAvailable = false;
        const endpoint = health.endpoint || '/api/chat';
        try {
          const bridgeResp = await fetch(`http://${host}:${port}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: [] }),
            signal: AbortSignal.timeout(1500)
          });
          bridgeAvailable = bridgeResp.status === 400 || bridgeResp.status === 401;
        } catch (_) {}

        return {
          agent: health.agent,
          type: health.type || 'unknown',
          url: `http://${host}:${port}`,
          port,
          endpoint,
          bridgeAvailable
        };
      } catch (_) {
        return null;
      }
    };

    // Scan in parallel batches of 10
    const ports = [];
    for (let p = portMin; p <= portMax; p++) ports.push(p);
    const BATCH = 10;
    for (let i = 0; i < ports.length; i += BATCH) {
      const batch = ports.slice(i, i + BATCH);
      const results = await Promise.all(batch.map(scanPort));
      results.forEach(r => { if (r) discovered.push(r); });
    }

    // Load configured agents and verify their current identity
    const config = await loadMutableServerConfig();
    const configuredAgents = config.providers?.local_agents || [];
    const configured = [];
    for (const agent of configuredAgents) {
      let verifiedAgent = null;
      try {
        const resp = await fetch(`${agent.url}/health`, { signal: AbortSignal.timeout(1500) });
        if (resp.ok) {
          const health = await resp.json();
          verifiedAgent = health.agent || null;
        }
      } catch (_) {}
      configured.push({
        name: agent.name,
        id: agent.id,
        url: agent.url,
        enabled: agent.enabled !== false,
        verifiedAgent
      });
    }

    res.json({ success: true, discovered, configured });
  } catch (error) {
    console.error('[SETUP] Agent scan failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});
```

- [ ] **Step 2: Add the save endpoint**

```js
app.post('/api/setup/local-agent/save', async (req, res) => {
  try {
    const { url, endpoint, api_key } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'url is required' });

    const ep = endpoint || '/api/chat';

    // Verify agent identity
    let agentName, agentType;
    try {
      const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) throw new Error(`Health check returned ${resp.status}`);
      const health = await resp.json();
      if (!health.agent) throw new Error('Health response missing agent field');
      agentName = health.agent;
      agentType = health.type || 'unknown';
    } catch (err) {
      return res.status(400).json({ success: false, error: `Cannot reach agent at ${url}: ${err.message}` });
    }

    const agentId = agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const { saveConfig } = require('../lib/config-manager');
    const config = await loadMutableServerConfig();
    if (!config.providers) config.providers = {};
    if (!config.providers.local_agents) config.providers.local_agents = [];

    // Update existing or add new
    const existingIdx = config.providers.local_agents.findIndex(a => a.id === agentId);
    const agentConfig = {
      name: agentName.charAt(0).toUpperCase() + agentName.slice(1),
      id: agentId,
      url,
      endpoint: ep,
      enabled: true,
      ...(api_key ? { api_key } : {})
    };

    if (existingIdx >= 0) {
      config.providers.local_agents[existingIdx] = agentConfig;
    } else {
      config.providers.local_agents.push(agentConfig);
    }

    await saveConfig(config);
    await applyUpdatedServerConfig(config);

    res.json({
      success: true,
      agent: { name: agentConfig.name, id: agentId, url, type: agentType, verified: true },
      message: `${agentConfig.name} connected and verified`
    });
  } catch (error) {
    console.error('[SETUP] Local agent save failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});
```

- [ ] **Step 3: Add the test endpoint**

```js
app.post('/api/setup/local-agent/test', async (req, res) => {
  try {
    const { url, endpoint, api_key } = req.body || {};
    if (!url) return res.status(400).json({ success: false, error: 'url is required' });

    const ep = endpoint || '/api/chat';
    const startMs = Date.now();

    // Health check
    let agentName, agentType;
    try {
      const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const health = await resp.json();
      agentName = health.agent || 'unknown';
      agentType = health.type || 'unknown';
    } catch (err) {
      return res.json({ success: true, reachable: false, error: `Health check failed: ${err.message}`, latencyMs: Date.now() - startMs });
    }

    // Bridge check
    let bridgeOk = false;
    const headers = { 'Content-Type': 'application/json' };
    if (api_key) headers['Authorization'] = `Bearer ${api_key}`;
    try {
      const resp = await fetch(`${url}${ep}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], tools: [] }),
        signal: AbortSignal.timeout(5000)
      });
      bridgeOk = resp.status !== 404;
    } catch (_) {}

    res.json({
      success: true,
      reachable: true,
      agent: agentName,
      type: agentType,
      bridgeOk,
      latencyMs: Date.now() - startMs
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

- [ ] **Step 4: Add the remove endpoint**

```js
app.post('/api/setup/local-agent/remove', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: 'id is required' });

    const { saveConfig } = require('../lib/config-manager');
    const config = await loadMutableServerConfig();
    if (!config.providers?.local_agents) {
      return res.json({ success: true, message: 'No agents configured' });
    }

    config.providers.local_agents = config.providers.local_agents.filter(a => a.id !== id);
    await saveConfig(config);
    await applyUpdatedServerConfig(config);

    res.json({ success: true, removed: id, message: `Agent ${id} removed` });
  } catch (error) {
    console.error('[SETUP] Local agent remove failed:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});
```

- [ ] **Step 5: Syntax check and commit**

```bash
node --check server/server.js
git add server/server.js && git commit -m "feat: add agent scan, save, test, remove endpoints"
```

---

### Task 3: Add Local Agents section to frontend Settings panel

**Files:**
- Modify: `public/index.html:5369-5373` (before the "Reset to Defaults" button in the settings panel)

- [ ] **Step 1: Add the Local Agents HTML section**

Insert before `<div style="margin-top: 24px;">` (line 5370) in the settings panel:

```html
            <div class="setting-group" id="local-agents-settings">
                <div class="setting-group-title" style="display: flex; justify-content: space-between; align-items: center;">
                    <span>Local Agents</span>
                    <button class="btn" id="scan-agents-btn" onclick="scanForAgents()" style="font-size: 11px; padding: 4px 10px;">Scan</button>
                </div>
                <div id="local-agents-list" style="margin-bottom: 8px;">
                    <div style="color: var(--text-secondary); font-size: 12px; padding: 4px 0;">No agents configured</div>
                </div>
                <div id="scan-results" style="display: none; margin-bottom: 8px;"></div>
                <div style="display: flex; gap: 6px; align-items: center;">
                    <input type="text" class="setting-input" id="manual-agent-url" placeholder="http://localhost:4611" style="flex: 1; font-size: 12px;" />
                    <button class="btn" onclick="addManualAgent()" style="font-size: 11px; padding: 4px 10px;">Add</button>
                </div>
            </div>
```

- [ ] **Step 2: Add the JavaScript functions**

Add before the closing `</script>` tag of the main inline script block (find a good insertion point near other settings functions like `toggleSettings`):

```js
        // ── Local Agent Settings ──
        async function scanForAgents() {
            const btn = document.getElementById('scan-agents-btn');
            const resultsDiv = document.getElementById('scan-results');
            btn.textContent = 'Scanning...';
            btn.disabled = true;
            resultsDiv.style.display = 'block';
            resultsDiv.innerHTML = '<div style="color: var(--text-secondary); font-size: 12px;">Scanning ports 4600-4660...</div>';

            try {
                const resp = await fetch('/api/setup/scan-agents');
                const data = await resp.json();
                if (!data.success) throw new Error(data.error);

                // Update configured list
                renderConfiguredAgents(data.configured);

                // Show discovered (not already configured)
                const configuredUrls = new Set((data.configured || []).map(a => a.url));
                const newAgents = (data.discovered || []).filter(a => !configuredUrls.has(a.url));

                if (newAgents.length === 0) {
                    resultsDiv.innerHTML = '<div style="color: var(--text-secondary); font-size: 12px;">No new agents found</div>';
                } else {
                    resultsDiv.innerHTML = newAgents.map(a => `
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; background: var(--bg-primary); border-radius: 6px; margin-bottom: 4px;">
                            <div>
                                <span style="font-weight: 600; font-size: 13px; color: var(--text-primary);">${a.agent}</span>
                                <span style="font-size: 11px; color: var(--text-secondary); margin-left: 6px;">${a.type} · port ${a.port}</span>
                                ${!a.bridgeAvailable ? '<span style="font-size: 10px; color: #e74c3c; margin-left: 6px;">no bridge</span>' : ''}
                            </div>
                            <button class="btn" onclick="connectDiscoveredAgent('${a.url}', '${a.endpoint}')" style="font-size: 11px; padding: 3px 8px;" ${!a.bridgeAvailable ? 'disabled title="Bridge not installed"' : ''}>Connect</button>
                        </div>
                    `).join('');
                }
            } catch (err) {
                resultsDiv.innerHTML = `<div style="color: #e74c3c; font-size: 12px;">Scan failed: ${err.message}</div>`;
            }
            btn.textContent = 'Scan';
            btn.disabled = false;
        }

        function renderConfiguredAgents(agents) {
            const listDiv = document.getElementById('local-agents-list');
            if (!agents || agents.length === 0) {
                listDiv.innerHTML = '<div style="color: var(--text-secondary); font-size: 12px; padding: 4px 0;">No agents configured</div>';
                return;
            }
            listDiv.innerHTML = agents.map(a => {
                const mismatch = a.verifiedAgent && a.verifiedAgent !== a.id && a.verifiedAgent !== a.name.toLowerCase();
                const statusDot = a.verifiedAgent
                    ? '<span style="color: #2ecc71;">●</span>'
                    : '<span style="color: #e74c3c;">●</span>';
                return `
                    <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; background: var(--bg-primary); border-radius: 6px; margin-bottom: 4px;">
                        <div>
                            ${statusDot}
                            <span style="font-weight: 600; font-size: 13px; color: var(--text-primary); margin-left: 4px;">${a.name}</span>
                            <span style="font-size: 11px; color: var(--text-secondary); margin-left: 6px;">${a.url}</span>
                            ${mismatch ? `<span style="font-size: 10px; color: #f39c12; margin-left: 6px;">⚠ responds as "${a.verifiedAgent}"</span>` : ''}
                        </div>
                        <button class="btn" onclick="removeLocalAgent('${a.id}')" style="font-size: 11px; padding: 3px 8px; color: #e74c3c;">Remove</button>
                    </div>
                `;
            }).join('');
        }

        async function connectDiscoveredAgent(url, endpoint) {
            const token = prompt('Webhook token (leave blank if none):');
            try {
                const resp = await fetch('/api/setup/local-agent/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, endpoint, api_key: token || undefined })
                });
                const data = await resp.json();
                if (!data.success) throw new Error(data.error);
                showToast(`Connected: ${data.agent.name}`);
                scanForAgents(); // Refresh
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        }

        async function addManualAgent() {
            const urlInput = document.getElementById('manual-agent-url');
            const url = urlInput.value.trim();
            if (!url) return showToast('Enter agent URL', 'error');

            try {
                // Test first
                const testResp = await fetch('/api/setup/local-agent/test', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url })
                });
                const testData = await testResp.json();
                if (!testData.reachable) throw new Error(`Agent not reachable at ${url}`);

                const token = prompt(`Found: ${testData.agent} (${testData.type}). Webhook token (leave blank if none):`);
                const saveResp = await fetch('/api/setup/local-agent/save', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, api_key: token || undefined })
                });
                const saveData = await saveResp.json();
                if (!saveData.success) throw new Error(saveData.error);

                showToast(`Connected: ${saveData.agent.name}`);
                urlInput.value = '';
                scanForAgents(); // Refresh
            } catch (err) {
                showToast('Failed: ' + err.message, 'error');
            }
        }

        async function removeLocalAgent(id) {
            if (!confirm(`Remove agent "${id}"?`)) return;
            try {
                const resp = await fetch('/api/setup/local-agent/remove', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id })
                });
                const data = await resp.json();
                if (!data.success) throw new Error(data.error);
                showToast(`Removed: ${id}`);
                scanForAgents(); // Refresh
            } catch (err) {
                showToast('Remove failed: ' + err.message, 'error');
            }
        }

        // Load configured agents when settings open
        document.addEventListener('evobrew:settings-opened', () => {
            fetch('/api/setup/scan-agents?portMin=0&portMax=0').then(r => r.json()).then(data => {
                if (data.configured) renderConfiguredAgents(data.configured);
            }).catch(() => {});
        });
```

- [ ] **Step 3: Commit**

```bash
git add public/index.html && git commit -m "feat: add Local Agents section to Settings panel"
```

---

### Task 4: Update CLI wizard with scan-and-select flow

**Files:**
- Modify: `lib/setup-wizard.js` (the `local-agents` handler in `stepProviders()`)

- [ ] **Step 1: Replace the local-agents handler**

Find the existing `if (provider === 'local-agents')` block in `stepProviders()` and replace it entirely with:

```js
    if (provider === 'local-agents') {
      console.log('\n📡 Local Agent Setup');
      console.log('Scanning for agents on localhost:4600-4660...\n');

      if (!config.providers) config.providers = {};
      if (!config.providers.local_agents) config.providers.local_agents = [];

      // Scan ports
      const discovered = [];
      for (let port = 4600; port <= 4660; port++) {
        try {
          const resp = await fetch(`http://localhost:${port}/health`, {
            signal: AbortSignal.timeout(1500)
          });
          if (!resp.ok) continue;
          const health = await resp.json();
          if (!health.status || !health.agent) continue;

          let bridgeOk = false;
          const ep = health.endpoint || '/api/chat';
          try {
            const br = await fetch(`http://localhost:${port}${ep}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ messages: [] }),
              signal: AbortSignal.timeout(1500)
            });
            bridgeOk = br.status === 400 || br.status === 401;
          } catch (_) {}

          discovered.push({
            agent: health.agent,
            type: health.type || 'unknown',
            port,
            endpoint: ep,
            bridgeOk
          });
        } catch (_) {}
      }

      if (discovered.length === 0) {
        console.log('No agents found on localhost.\n');
      } else {
        console.log(`Found ${discovered.length} agent(s):`);
        discovered.forEach((a, i) => {
          const bridge = a.bridgeOk ? '✅' : '⚠️  no bridge';
          console.log(`  ${i + 1}. ${bridge} ${a.agent} (${a.type}) — localhost:${a.port}`);
        });
        console.log('');

        const selection = await question('Select agents to connect (comma-separated numbers, or "all"): ');
        const indices = selection.trim().toLowerCase() === 'all'
          ? discovered.map((_, i) => i)
          : selection.split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < discovered.length);

        for (const idx of indices) {
          const agent = discovered[idx];
          if (!agent) continue;
          console.log(`\nConnecting ${agent.agent} (localhost:${agent.port})...`);
          const token = await question('  Webhook token [paste or Enter to skip]: ');
          const agentId = agent.agent.toLowerCase().replace(/[^a-z0-9-]/g, '-');

          const existingIdx = config.providers.local_agents.findIndex(a => a.id === agentId);
          const agentConfig = {
            name: agent.agent.charAt(0).toUpperCase() + agent.agent.slice(1),
            id: agentId,
            url: `http://localhost:${agent.port}`,
            endpoint: agent.endpoint,
            enabled: true,
            ...(token ? { api_key: token } : {})
          };

          if (existingIdx >= 0) {
            config.providers.local_agents[existingIdx] = agentConfig;
          } else {
            config.providers.local_agents.push(agentConfig);
          }
          console.log(`  ✅ ${agentConfig.name} connected`);
        }
      }

      // Manual add
      const manual = await question('Add an agent manually? (y/n) [n]: ');
      if (manual.toLowerCase() === 'y') {
        let addMore = true;
        while (addMore) {
          const url = await question('Agent URL (e.g., http://localhost:4611): ');
          if (!url) break;

          let agentName = 'unknown';
          try {
            const resp = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
            if (resp.ok) {
              const health = await resp.json();
              agentName = health.agent || 'unknown';
              console.log(`  Found: ${agentName}`);
            } else {
              console.log('  ⚠️  Agent not reachable (saving anyway)');
            }
          } catch (_) {
            console.log('  ⚠️  Agent not reachable (saving anyway)');
          }

          const token = await question('  Webhook token [paste or Enter to skip]: ');
          const agentId = agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
          config.providers.local_agents.push({
            name: agentName.charAt(0).toUpperCase() + agentName.slice(1),
            id: agentId,
            url,
            endpoint: '/api/chat',
            enabled: true,
            ...(token ? { api_key: token } : {})
          });
          console.log(`  ✅ Saved: ${agentName} (local:${agentId})`);

          const more = await question('Add another? (y/n) [n]: ');
          addMore = more.toLowerCase() === 'y';
        }
      }

      if (config.providers.local_agents.length > 0) {
        await configManager.saveConfig(config);
        console.log(`\n✅ Saved ${config.providers.local_agents.length} local agent(s)`);
      }
      continue;
    }
```

- [ ] **Step 2: Syntax check and commit**

```bash
node --check lib/setup-wizard.js
git add lib/setup-wizard.js && git commit -m "feat: CLI wizard scan-and-select for local agents"
```

---

### Task 5: Test end-to-end

- [ ] **Step 1: Restart cosmohome with updated health endpoint**

```bash
kill $(lsof -iTCP:4620 -sTCP:LISTEN -P -t 2>/dev/null) 2>/dev/null
pm2 restart cosmo23-home
sleep 5
curl -s http://localhost:4620/health
```

Expected: `{"status":"ok","agent":"edison","type":"cosmohome","endpoint":"/api/chat"}`

- [ ] **Step 2: Test scanner endpoint**

```bash
curl -s http://localhost:3405/api/setup/scan-agents | node -e "
const d=require('fs').readFileSync('/dev/stdin','utf8');
const j=JSON.parse(d);
console.log('Discovered:', j.discovered?.length);
j.discovered?.forEach(a => console.log('  ', a.agent, a.type, a.port, a.bridgeAvailable ? 'bridge:ok' : 'no bridge'));
console.log('Configured:', j.configured?.length);
j.configured?.forEach(a => console.log('  ', a.name, a.url, 'verified:', a.verifiedAgent));
"
```

- [ ] **Step 3: Test save endpoint**

```bash
curl -s -X POST http://localhost:3405/api/setup/local-agent/save \
  -H "Content-Type: application/json" \
  -d '{"url":"http://localhost:4620","api_key":"9c88442a11784bfe77ba10c500d0cebbc5a3b841ded39a4b"}' | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'))"
```

Expected: `{ success: true, agent: { name: 'Edison', id: 'edison', ... } }`

- [ ] **Step 4: Verify in model picker**

```bash
curl -s http://localhost:3405/api/providers/models | node -e "
const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
j.models.filter(m => m.provider?.startsWith('local:')).forEach(m => console.log(m.id, m.label, m.provider));
"
```

Expected: `local:edison Edison local:edison`

- [ ] **Step 5: Test from evobrew UI**

1. Open browser, go to Settings
2. See "Local Agents" section with configured agents and status dots
3. Click "Scan" — see discovered agents
4. Select a different model via model picker — see agent name
5. Send a message — agent responds with its identity

- [ ] **Step 6: Commit any fixes**

```bash
git add -A && git commit -m "feat: agent discovery and setup — tested end-to-end"
```
