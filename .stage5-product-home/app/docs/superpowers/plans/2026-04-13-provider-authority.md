# Provider Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Home23 the single authority for all provider configuration — fix broken wiring, gut duplicate provider UIs from evobrew/cosmo23, restructure onboarding as a guided wizard.

**Architecture:** Init creates encryption key + Prisma DB silently, no API key prompts. Settings UI is the only place to configure providers. Cosmo23 remains the OAuth executor but never shows provider config. Evobrew already has Home23-managed mode — verify and clean up. Onboarding wizard guides: welcome → providers → agent create → start.

**Tech Stack:** Node.js, js-yaml, Prisma/SQLite, vanilla JS dashboard, PM2 ecosystem config generation

**Spec:** `docs/design/STEP21-PROVIDER-AUTHORITY-DESIGN.md`

---

### Task 1: Fix init.js — Remove Key Prompts, Add Plumbing

**Files:**
- Modify: `cli/lib/init.js:80-274`

- [ ] **Step 1: Remove API key prompts and fixed template writer**

Replace the entire `runInit` function body from the API key prompt section through the secrets.yaml writer. Remove the `askSecret` and `askWithDefault` imports for key prompting (keep `closeRL` if still needed for other prompts, otherwise remove all readline imports).

```js
// In cli/lib/init.js — replace lines 100-158 (everything from "const secretsPath" 
// through "console.log('  done')" after writeFileSync)

// OLD: prompted for 4 API keys, wrote fixed template
// NEW: generate encryption key, merge into secrets.yaml

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export async function runInit(home23Root) {
  console.log('');
  console.log('Home23 — Setup');
  console.log('──────────────');
  console.log('');

  // Prerequisite check (unchanged)
  const prereqs = checkPrerequisites();
  if (prereqs.issues.length > 0) {
    console.log('❌ Prerequisites missing:');
    for (const issue of prereqs.issues) console.log(`   • ${issue}`);
    console.log('');
    console.log('Fix these before continuing.');
    process.exit(1);
  }
  if (prereqs.warnings.length > 0) {
    console.log('⚠️  Warnings:');
    for (const warn of prereqs.warnings) console.log(`   • ${warn}`);
    console.log('');
  }

  // ── Encryption key + secrets.yaml (merge, never clobber) ──
  console.log('Preparing secrets...');
  const secretsPath = join(home23Root, 'config', 'secrets.yaml');
  let secrets = {};
  if (existsSync(secretsPath)) {
    try {
      const yaml = (await import('js-yaml')).default;
      secrets = yaml.load(readFileSync(secretsPath, 'utf8')) || {};
    } catch { secrets = {}; }
  }

  // Generate encryption key if not present
  if (!secrets.cosmo23?.encryptionKey) {
    if (!secrets.cosmo23) secrets.cosmo23 = {};
    secrets.cosmo23.encryptionKey = randomBytes(32).toString('hex');
    console.log('  Generated encryption key');
  } else {
    console.log('  Encryption key exists');
  }

  // Write merged secrets.yaml
  const yaml = (await import('js-yaml')).default;
  const header = '# Home23 secrets — API keys and tokens\n# This file is gitignored. Never commit it.\n\n';
  writeFileSync(secretsPath, header + yaml.dump(secrets, { lineWidth: 120 }), 'utf8');
  console.log('  secrets.yaml ready');

  // ── Install dependencies (unchanged section) ──
  console.log('');
  console.log('Installing dependencies...');

  const dirs = [
    { name: 'engine', path: join(home23Root, 'engine') },
    { name: 'harness', path: home23Root },
    { name: 'evobrew', path: join(home23Root, 'evobrew') },
  ];

  for (const dir of dirs) {
    if (existsSync(join(dir.path, 'package.json'))) {
      process.stdout.write(`  ${dir.name}: npm install...`);
      try {
        execSync('npm install', { cwd: dir.path, stdio: 'pipe', timeout: 120000 });
        console.log(' done');
      } catch (err) {
        console.log(' FAILED');
        console.error(`    ${err.message?.split('\n')[0]}`);
      }
    }
  }

  // COSMO 2.3 dependencies + Prisma
  const cosmo23Dir = join(home23Root, 'cosmo23');
  const cosmo23EngineDir = join(cosmo23Dir, 'engine');
  if (existsSync(join(cosmo23Dir, 'package.json'))) {
    console.log('Installing COSMO 2.3 dependencies...');
    execSync('npm install', { cwd: cosmo23Dir, stdio: 'inherit' });
    if (existsSync(join(cosmo23EngineDir, 'package.json'))) {
      console.log('Installing COSMO 2.3 engine dependencies...');
      execSync('npm install', { cwd: cosmo23EngineDir, stdio: 'inherit' });
    }
    execSync('npx prisma generate', { cwd: cosmo23Dir, stdio: 'inherit' });

    // Create the Prisma SQLite database (required for OAuth token storage)
    console.log('Creating COSMO 2.3 database...');
    const dbPath = join(cosmo23Dir, 'prisma', 'dev.db');
    try {
      if (!existsSync(dbPath)) {
        execSync(`DATABASE_URL="file:${dbPath}" npx prisma db push`, {
          cwd: cosmo23Dir, stdio: 'pipe', timeout: 30000,
        });
      }
      // Verify it exists
      if (existsSync(dbPath)) {
        console.log('  done');
      } else {
        throw new Error('Database file not created');
      }
    } catch (err) {
      console.log('  FAILED (OAuth sign-in will not work until this is fixed)');
      console.error(`  Fix manually: cd cosmo23 && DATABASE_URL="file:./prisma/dev.db" npx prisma db push`);
    }

    // Create config directory for cosmo23
    const cosmo23ConfigDir = join(cosmo23Dir, '.cosmo23-config');
    if (!existsSync(cosmo23ConfigDir)) {
      mkdirSync(cosmo23ConfigDir, { recursive: true });
    }
  }

  // ── Seed cosmo23 config ──
  console.log('');
  console.log('Seeding COSMO 2.3 config...');
  try {
    const { seedCosmo23Config } = await import('./cosmo23-config.js');
    seedCosmo23Config(home23Root);
  } catch (err) {
    console.warn(`  Warning: ${err.message}`);
  }

  // ── Generate ecosystem (if agents exist) ──
  try {
    const { generateEcosystem } = await import('./generate-ecosystem.js');
    generateEcosystem(home23Root);
  } catch {
    // No agents yet — ecosystem generated on first agent create
  }

  // ── Build TypeScript ──
  console.log('');
  process.stdout.write('Building TypeScript...');
  try {
    execSync('npx tsc', { cwd: home23Root, stdio: 'pipe', timeout: 60000 });
    console.log(' done');
  } catch (err) {
    console.log(' FAILED');
    console.error('  Check build errors with: npx tsc --noEmit');
  }

  // ── Python venv for document ingestion (unchanged) ──
  console.log('');
  process.stdout.write('Setting up document ingestion venv (MarkItDown + PDF)...');
  try {
    const venvDir = join(home23Root, 'engine', '.venv-markitdown');
    const venvPython = join(venvDir, 'bin', 'python3');
    if (!existsSync(venvPython)) {
      execSync(`python3 -m venv "${venvDir}"`, { stdio: 'pipe', timeout: 60000 });
    }
    execSync(`"${venvPython}" -m pip install --quiet --upgrade pip "markitdown[pdf]" openai`, {
      stdio: 'pipe',
      timeout: 300000,
    });
    console.log(' done');
  } catch (err) {
    console.log(' FAILED');
    console.error(`  ${err.message?.split('\n')[0] || 'unknown error'}`);
    console.error('  Binary document ingestion (PDF/DOCX/etc.) will be unavailable until this is fixed.');
    console.error('  You can re-run this step manually:');
    console.error('    python3 -m venv engine/.venv-markitdown');
    console.error('    engine/.venv-markitdown/bin/pip install "markitdown[pdf]" openai');
  }

  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  Home23 is ready!');
  console.log('═══════════════════════════════════════════════════');
  console.log('');
  console.log('  Next step — start the system:');
  console.log('');
  console.log('    node cli/home23.js start');
  console.log('');
  console.log('  Then open your browser:');
  console.log('');
  console.log('    http://localhost:5002/home23');
  console.log('');
  console.log('  The web dashboard will walk you through setting');
  console.log('  up providers and creating your first agent.');
  console.log('');
}
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cli/lib/init.js`
Expected: No output (clean)

- [ ] **Step 3: Test init creates encryption key in fresh secrets.yaml**

Run: `mv config/secrets.yaml config/secrets.yaml.bak && node cli/home23.js init 2>&1 | head -20`
Expected: "Generated encryption key", "secrets.yaml ready", no API key prompts

- [ ] **Step 4: Verify secrets.yaml has cosmo23.encryptionKey**

Run: `grep -A1 cosmo23 config/secrets.yaml`
Expected: `cosmo23:` followed by `encryptionKey: "<64 hex chars>"`

- [ ] **Step 5: Restore original secrets and re-run init (merge test)**

Run: `cp config/secrets.yaml.bak config/secrets.yaml && node cli/home23.js init 2>&1 | grep -E "key|secret"`
Verify the existing providers section is preserved alongside the new cosmo23 section.

- [ ] **Step 6: Commit**

```bash
git add cli/lib/init.js
git commit -m "feat: init removes API key prompts, generates encryption key, merges secrets.yaml

Home23 init now does silent plumbing only — encryption key generation,
Prisma DB creation, cosmo23 config seeding, ecosystem generation.
Provider setup happens in the web dashboard onboarding."
```

---

### Task 2: Fix cosmo23-config.js — Read Key From secrets.yaml

**Files:**
- Modify: `cli/lib/cosmo23-config.js:78-81`

- [ ] **Step 1: Replace self-generated encryption key with secrets.yaml read**

```js
// In cli/lib/cosmo23-config.js — replace lines 78-81

// OLD:
//   if (!config.security.encryption_key) {
//     config.security.encryption_key = randomBytes(32).toString('hex');
//   }

// NEW: Read from secrets.yaml (the single source of truth)
const secretsEncKey = secrets.cosmo23?.encryptionKey;
if (secretsEncKey) {
  config.security.encryption_key = secretsEncKey;
} else if (!config.security.encryption_key) {
  // Fallback: generate and persist to secrets.yaml so the ecosystem can read it
  const newKey = randomBytes(32).toString('hex');
  config.security.encryption_key = newKey;
  if (!secrets.cosmo23) secrets.cosmo23 = {};
  secrets.cosmo23.encryptionKey = newKey;
  try {
    writeFileSync(join(home23Root, 'config', 'secrets.yaml'),
      '# Home23 secrets\n\n' + yaml.dump(secrets, { lineWidth: 120 }), 'utf8');
  } catch { /* non-fatal — ecosystem will generate on next run */ }
}
```

Note: We need `yaml` available in this function. Add the import at the top of the function body since the module already imports from `js-yaml`.

- [ ] **Step 2: Add yaml import to the function if not present**

Check line 11: `import yaml from 'js-yaml';` — this already exists in the file's imports. No change needed.

- [ ] **Step 3: Verify syntax**

Run: `node --check cli/lib/cosmo23-config.js`
Expected: No output (clean)

- [ ] **Step 4: Test that seeding uses secrets.yaml key**

Run: `node -e "import('./cli/lib/cosmo23-config.js').then(m => m.seedCosmo23Config('.'))"`
Check: `grep encryption_key cosmo23/.cosmo23-config/config.json` should show the same key as `grep encryptionKey config/secrets.yaml`

- [ ] **Step 5: Commit**

```bash
git add cli/lib/cosmo23-config.js
git commit -m "fix: cosmo23 config reads encryption key from secrets.yaml instead of generating own"
```

---

### Task 3: Fix generate-ecosystem.js — Add HOME23_MANAGED, Clean Up Key Generation

**Files:**
- Modify: `cli/lib/generate-ecosystem.js:62-73` (key generation block)
- Modify: `cli/lib/generate-ecosystem.js:161-168` (evobrew env block)
- Modify: `cli/lib/generate-ecosystem.js:181-193` (cosmo23 env block)

- [ ] **Step 1: Remove redundant encryption key generation, read-only from secrets**

Replace lines 62-73 (the key generation + secrets.yaml persistence block):

```js
// OLD: generates key and writes to secrets.yaml
// NEW: read-only — init.js owns key generation

lines.push(`// Cosmo23 OAuth encryption key — read from secrets.yaml (generated by init)`);
lines.push(`const cosmo23EncryptionKey = secrets.cosmo23?.encryptionKey || '';`);
lines.push(`if (!cosmo23EncryptionKey) {`);
lines.push(`  console.warn('[ecosystem] Warning: cosmo23 encryption key not found in secrets.yaml. Run "home23 init" to generate.');`);
lines.push(`}`);
```

- [ ] **Step 2: Add HOME23_MANAGED to evobrew env block**

In the evobrew env section (around line 161-168), add `HOME23_MANAGED` inside the env object:

```js
// Add after the EVOBREW_CONFIG_DIR line:
lines.push(`        HOME23_MANAGED: 'true',`);
```

- [ ] **Step 3: Add HOME23_MANAGED to cosmo23 env block**

In the cosmo23 env section (around line 181-193), add `HOME23_MANAGED`:

```js
// Add after the NODE_ENV line in the cosmo23 env block:
lines.push(`        HOME23_MANAGED: 'true',`);
```

- [ ] **Step 4: Verify syntax**

Run: `node --check cli/lib/generate-ecosystem.js`
Expected: No output (clean)

- [ ] **Step 5: Regenerate ecosystem and verify**

Run:
```bash
node -e "import('./cli/lib/generate-ecosystem.js').then(m => m.generateEcosystem('.'))"
grep -E "HOME23_MANAGED|ENCRYPTION_KEY|DATABASE_URL" ecosystem.config.cjs
```
Expected: All three env vars present in both evobrew and cosmo23 blocks.

- [ ] **Step 6: Commit**

```bash
git add cli/lib/generate-ecosystem.js
git commit -m "fix: ecosystem adds HOME23_MANAGED to evobrew+cosmo23, removes redundant key generation"
```

---

### Task 4: Fix cosmo23 /api/setup/status — HOME23_MANAGED Gate

**Files:**
- Modify: `cosmo23/server/index.js:734-740`

- [ ] **Step 1: Add HOME23_MANAGED override to setup status**

Replace the `/api/setup/status` handler (lines 734-740):

```js
// In cosmo23/server/index.js — replace the /api/setup/status handler

app.get('/api/setup/status', async (_req, res) => {
  // When managed by Home23, report all env-var-configured providers as ready
  if (process.env.HOME23_MANAGED === 'true') {
    const providers = {};
    if (process.env.ANTHROPIC_AUTH_TOKEN) providers.anthropic = { configured: true, status: 'configured', auth_mode: 'oauth' };
    if (process.env.OPENAI_API_KEY) providers.openai = { configured: true, status: 'configured' };
    if (process.env.XAI_API_KEY) providers.xai = { configured: true, status: 'configured' };
    if (process.env.OLLAMA_CLOUD_API_KEY) providers['ollama-cloud'] = { configured: true, status: 'configured' };
    return res.json({
      configured: true,
      managed_by_home23: true,
      providers,
      setup_complete: true,
    });
  }
  const config = await readSetupConfig();
  res.json(summarizeSetup(config));
});
```

- [ ] **Step 2: Verify syntax**

Run: `node --check cosmo23/server/index.js`
Expected: No output (clean)

- [ ] **Step 3: Restart cosmo23 and test endpoint**

Run:
```bash
pm2 restart home23-cosmo23 --update-env
sleep 2
curl -s http://localhost:43210/api/setup/status | python3 -m json.tool | head -10
```
Expected: `managed_by_home23: true`, providers listed as configured.

- [ ] **Step 4: Commit**

```bash
git add cosmo23/server/index.js
git commit -m "fix: cosmo23 setup status reports HOME23_MANAGED providers as configured"
```

---

### Task 5: Verify Evobrew Home23-Managed Mode

**Files:**
- Verify: `evobrew/public/js/ui-live-settings.js:232-236` (existing gate)
- Verify: `evobrew/server/server.js:4514` (existing PUT/DELETE gate)
- Modify: `evobrew/server/server.js:4457` (ensure HOME23_MANAGED env also triggers managed mode)

Evobrew already has Home23-managed mode via the `_home23` flag in config.json. But the current detection relies on config.json having `_home23: true` — which is set by `cli/lib/evobrew-config.js`. Verify this works end-to-end and add `HOME23_MANAGED` env var as an additional signal.

- [ ] **Step 1: Add HOME23_MANAGED env var detection alongside _home23 config flag**

In `evobrew/server/server.js`, find where `home23Config` is checked (around line 4457). The `managed_by_home23` flag should also check the env var:

```js
// Find the line:
//   managed_by_home23: Boolean(home23Config?._home23),
// Replace with:
//   managed_by_home23: Boolean(home23Config?._home23 || process.env.HOME23_MANAGED === 'true'),
```

And update the PUT/DELETE gate (around line 4514) similarly:

```js
// Find the line:
//   if (home23Config?._home23 && (req.method === 'PUT' || req.method === 'DELETE')) {
// Replace with:
//   if ((home23Config?._home23 || process.env.HOME23_MANAGED === 'true') && (req.method === 'PUT' || req.method === 'DELETE')) {
```

- [ ] **Step 2: Verify syntax**

Run: `node --check evobrew/server/server.js`
Expected: No output (clean)

- [ ] **Step 3: Restart evobrew and verify managed mode**

Run:
```bash
pm2 restart home23-evobrew --update-env
sleep 2
curl -s http://localhost:3415/api/setup/status | python3 -m json.tool | grep managed
```
Expected: `"managed_by_home23": true`

- [ ] **Step 4: Verify PUT returns 403**

Run: `curl -s -X PUT http://localhost:3415/api/setup/providers/openai -H 'Content-Type: application/json' -d '{"api_key":"test"}' -w "\n%{http_code}"`
Expected: 403

- [ ] **Step 5: Commit**

```bash
git add evobrew/server/server.js
git commit -m "fix: evobrew also checks HOME23_MANAGED env var for managed mode detection"
```

---

### Task 6: Settings Page — Onboarding Wizard Restructure

**Files:**
- Modify: `engine/src/dashboard/home23-settings.html:36-98` (provider panel)
- Modify: `engine/src/dashboard/home23-settings.js:342-418` (wizard logic)
- Modify: `engine/src/dashboard/home23-welcome.html:91` (Get Started link)

This task restructures the Settings page so first-run users see a guided flow: Providers → Agent Create → Start. Returning users see the normal tabbed Settings.

- [ ] **Step 1: Add onboarding detection to settings.js**

At the top of the settings initialization (in `home23-settings.js`), add a check: if no agents exist AND no providers configured, show onboarding mode instead of normal settings.

```js
// Add near the top of the DOMContentLoaded handler or init function:

async function checkOnboardingNeeded() {
  try {
    const [provRes, agentRes] = await Promise.all([
      fetch('/home23/api/settings/providers'),
      fetch('/home23/api/settings/agents'),
    ]);
    const provData = await provRes.json();
    const agentData = await agentRes.json();
    
    const hasProviders = Object.values(provData.providers || {}).some(p => p.configured);
    const hasAgents = (agentData.agents || []).length > 0;
    
    return !hasProviders || !hasAgents;
  } catch {
    return true; // default to onboarding on error
  }
}
```

- [ ] **Step 2: Add onboarding wizard HTML to settings page**

In `home23-settings.html`, add an onboarding overlay div that shows when onboarding is needed. This sits above the normal settings tabs and guides through: providers → agent create → start.

```html
<!-- Add before the existing settings content, after opening body/container tags -->
<div id="onboarding-wizard" class="h23s-onboarding" style="display:none;">
  <div class="h23s-onboarding-header">
    <div class="h23s-onboarding-logo">🧠</div>
    <h1>Welcome to Home23</h1>
    <p class="h23s-onboarding-subtitle">Let's get your AI operating system running.</p>
  </div>
  
  <div class="h23s-onboarding-steps">
    <div class="h23s-onboarding-step active" data-step="1">
      <span class="h23s-onboarding-step-num">1</span> Providers
    </div>
    <div class="h23s-onboarding-step" data-step="2">
      <span class="h23s-onboarding-step-num">2</span> Create Agent
    </div>
    <div class="h23s-onboarding-step" data-step="3">
      <span class="h23s-onboarding-step-num">3</span> Launch
    </div>
  </div>

  <div class="h23s-onboarding-content">
    <!-- Step 1: Providers (reuses existing OAuth cards + API key inputs) -->
    <div id="onboarding-step-1" class="h23s-onboarding-page active">
      <h2>Connect a Provider</h2>
      <p>Sign in with OAuth (recommended) or enter an API key. You need at least one provider to continue.</p>
      <div id="onboarding-providers">
        <!-- Populated from existing provider panel content -->
      </div>
      <div class="h23s-onboarding-nav">
        <button id="onboarding-next-1" class="h23s-btn h23s-btn-primary" disabled>Next →</button>
      </div>
    </div>
    
    <!-- Step 2: Agent Create (reuses existing wizard) -->
    <div id="onboarding-step-2" class="h23s-onboarding-page">
      <h2>Create Your Agent</h2>
      <div id="onboarding-agent-wizard">
        <!-- Populated from existing agent wizard content -->
      </div>
    </div>
    
    <!-- Step 3: Launch -->
    <div id="onboarding-step-3" class="h23s-onboarding-page">
      <h2>Ready to Launch</h2>
      <p id="onboarding-agent-summary"></p>
      <button id="onboarding-launch" class="h23s-btn h23s-btn-primary">Start Agent →</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add onboarding wizard JS logic**

In `home23-settings.js`, add the onboarding flow logic that:
- Shows onboarding overlay when needed
- Populates step 1 with existing provider panel content (clone/move nodes)
- Gates "Next" button on at least one provider being configured (poll `/providers` endpoint)
- Populates step 2 with agent create wizard
- Step 3 starts the agent via existing `/agents/:name/start` endpoint
- On completion, hides onboarding and redirects to `/home23` dashboard

```js
// Add to home23-settings.js:

let onboardingStep = 1;

async function initOnboarding() {
  const needed = await checkOnboardingNeeded();
  if (!needed) return; // show normal settings

  document.getElementById('onboarding-wizard').style.display = 'block';
  // Hide normal settings tabs
  const normalSettings = document.querySelector('.h23s-tabs');
  if (normalSettings) normalSettings.style.display = 'none';
  const normalPanels = document.querySelector('.h23s-panels');
  if (normalPanels) normalPanels.style.display = 'none';

  // Clone provider panel content into onboarding step 1
  const provPanel = document.getElementById('panel-providers');
  const onbProviders = document.getElementById('onboarding-providers');
  if (provPanel && onbProviders) {
    onbProviders.innerHTML = provPanel.innerHTML;
    // Re-wire OAuth buttons in the cloned content
    rewireOAuthButtons(onbProviders);
  }

  // Poll for provider configuration to enable Next button
  const pollProviders = setInterval(async () => {
    try {
      const res = await fetch('/home23/api/settings/providers');
      const data = await res.json();
      const hasProvider = Object.values(data.providers || {}).some(p => p.configured);
      const btn = document.getElementById('onboarding-next-1');
      if (btn) btn.disabled = !hasProvider;
    } catch {}
  }, 3000);

  document.getElementById('onboarding-next-1')?.addEventListener('click', () => {
    clearInterval(pollProviders);
    onboardingStep = 2;
    updateOnboardingStep();
    // Trigger agent create wizard in step 2
    initOnboardingAgentCreate();
  });

  document.getElementById('onboarding-launch')?.addEventListener('click', launchOnboardingAgent);
}

function updateOnboardingStep() {
  document.querySelectorAll('.h23s-onboarding-step').forEach(s => {
    const step = parseInt(s.dataset.step);
    s.classList.remove('active', 'done');
    if (step === onboardingStep) s.classList.add('active');
    if (step < onboardingStep) s.classList.add('done');
  });
  document.querySelectorAll('.h23s-onboarding-page').forEach(p => p.classList.remove('active'));
  const page = document.getElementById(`onboarding-step-${onboardingStep}`);
  if (page) page.classList.add('active');
}

function rewireOAuthButtons(container) {
  // Re-attach event listeners for OAuth start/complete/import buttons
  // within the cloned container — delegates to existing handler functions
  // (anthropicOAuthStart, anthropicOAuthComplete, codexOAuthStart, etc.)
}

async function initOnboardingAgentCreate() {
  // Load agent create form into step 2
  // Reuse existing wizard HTML and logic, constrained to configured providers
}

async function launchOnboardingAgent() {
  // Call /agents/:name/start, wait for success, redirect to /home23
}
```

- [ ] **Step 4: Add onboarding CSS**

Add styles for the onboarding overlay in the settings CSS (either inline in the HTML or in a style block):

```css
.h23s-onboarding {
  max-width: 640px;
  margin: 0 auto;
  padding: 40px 24px;
}
.h23s-onboarding-header {
  text-align: center;
  margin-bottom: 32px;
}
.h23s-onboarding-logo { font-size: 48px; margin-bottom: 12px; }
.h23s-onboarding-header h1 { font-size: 24px; color: #e2e8f0; margin: 0 0 8px; }
.h23s-onboarding-subtitle { color: #94a3b8; font-size: 14px; }
.h23s-onboarding-steps {
  display: flex;
  justify-content: center;
  gap: 32px;
  margin-bottom: 32px;
}
.h23s-onboarding-step {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #64748b;
  font-size: 14px;
}
.h23s-onboarding-step.active { color: #e2e8f0; font-weight: 600; }
.h23s-onboarding-step.done { color: #22c55e; }
.h23s-onboarding-step-num {
  width: 24px; height: 24px;
  border-radius: 50%;
  background: rgba(255,255,255,0.1);
  display: flex; align-items: center; justify-content: center;
  font-size: 12px;
}
.h23s-onboarding-step.active .h23s-onboarding-step-num { background: rgba(99,102,241,0.3); }
.h23s-onboarding-step.done .h23s-onboarding-step-num { background: rgba(34,197,94,0.3); }
.h23s-onboarding-page { display: none; }
.h23s-onboarding-page.active { display: block; }
.h23s-onboarding-page h2 { font-size: 18px; color: #e2e8f0; margin: 0 0 8px; }
.h23s-onboarding-page > p { color: #94a3b8; font-size: 13px; margin-bottom: 20px; }
.h23s-onboarding-nav { margin-top: 24px; text-align: right; }
```

- [ ] **Step 5: Verify — restart dashboard and check onboarding flow**

Run:
```bash
pm2 restart home23-jerry-dash
```
Open `http://localhost:5002/home23/settings` in browser. If providers and agents exist, should show normal settings. Test onboarding by temporarily checking the detection logic.

- [ ] **Step 6: Commit**

```bash
git add engine/src/dashboard/home23-settings.html engine/src/dashboard/home23-settings.js
git commit -m "feat: guided onboarding wizard — providers → agent create → launch"
```

---

### Task 7: Update Documentation

**Files:**
- Modify: `docs/design/COSMO23-VENDORED-PATCHES.md`
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add Patch 5 to COSMO23-VENDORED-PATCHES.md**

Append to the patches list:

```markdown
### Patch 5: HOME23_MANAGED Provider Suppression (2026-04-13)

**File:** `server/index.js`
**Location:** `/api/setup/status` endpoint (~line 734)

When `HOME23_MANAGED=true` env var is set, the setup status endpoint reports
all env-var-configured providers as ready. This prevents cosmo23's own setup
UI from showing provider configuration when running under Home23.

**Verification after update:**
```bash
curl -s http://localhost:43210/api/setup/status | python3 -m json.tool | grep managed
# Expected: "managed_by_home23": true
```
```

- [ ] **Step 2: Update README.md install flow**

Update the Install and Setup sections to reflect no-key init + web onboarding. The `home23 init` description should say it installs dependencies and sets up plumbing (no mention of API key prompts). The Setup section already describes the web flow correctly.

- [ ] **Step 3: Update CLAUDE.md config section**

Add to the Config table:
- `HOME23_MANAGED` env var description
- Note that `ENCRYPTION_KEY` and `DATABASE_URL` flow to cosmo23 via PM2

Update the Design Principles section to include:
- "Home23 is the single authority for all provider configuration. Cosmo23 and evobrew are consumers."

Add Step 21 to the Key Documents table.

- [ ] **Step 4: Commit**

```bash
git add docs/design/COSMO23-VENDORED-PATCHES.md README.md CLAUDE.md
git commit -m "docs: update for Step 21 provider authority — patches, README, CLAUDE.md"
```

---

### Task 8: End-to-End Verification

- [ ] **Step 1: Regenerate ecosystem and restart all Home23 processes**

```bash
node -e "import('./cli/lib/generate-ecosystem.js').then(m => m.generateEcosystem('.'))"
pm2 restart home23-jerry home23-jerry-dash home23-jerry-harness home23-evobrew home23-cosmo23 --update-env
```

- [ ] **Step 2: Verify ENCRYPTION_KEY reaches cosmo23**

```bash
pm2 env 56 2>/dev/null | grep ENCRYPTION_KEY
# (use actual cosmo23 process ID)
# Expected: ENCRYPTION_KEY=<64 hex chars matching secrets.yaml>
```

Alternative:
```bash
pm2 logs home23-cosmo23 --lines 10 --nostream 2>&1 | grep -i "encryption"
# Expected: NO "ENCRYPTION_KEY environment variable not set" errors
```

- [ ] **Step 3: Verify DATABASE_URL reaches cosmo23**

```bash
pm2 env 56 2>/dev/null | grep DATABASE_URL
# Expected: DATABASE_URL=file:/Users/.../cosmo23/prisma/dev.db
```

- [ ] **Step 4: Verify HOME23_MANAGED reaches both evobrew and cosmo23**

```bash
curl -s http://localhost:3415/api/setup/status | python3 -m json.tool | grep managed
curl -s http://localhost:43210/api/setup/status | python3 -m json.tool | grep managed
# Expected: Both return "managed_by_home23": true
```

- [ ] **Step 5: Verify OAuth flow works end-to-end**

Open `http://localhost:5002/home23/settings` → Providers tab → check that OAuth cards show status (connected/disconnected). If a provider is already connected via OAuth, verify the status shows correctly with no ENCRYPTION_KEY errors in cosmo23 logs.

- [ ] **Step 6: Verify evobrew settings show managed mode**

Open `http://localhost:3415` → Settings → should see "Managed by Home23" with provider status grid, not API key input fields.

- [ ] **Step 7: Final commit with verification note**

```bash
git add -A
git status  # review — only commit relevant files
git commit -m "verified: Step 21 provider authority end-to-end — encryption key, DB, managed mode all working"
```
