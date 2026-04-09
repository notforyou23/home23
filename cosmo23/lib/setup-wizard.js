/**
 * Evobrew Setup Wizard
 * 
 * A polished first-run experience that guides users through:
 * 1. AI Provider configuration (OpenAI, Anthropic, xAI)
 * 2. OpenClaw integration (auto-detection)
 * 3. Server configuration (ports)
 * 4. Service installation (launchd/systemd)
 * 5. Verification
 * 
 * Design goal: Match OpenClaw's quality and experience.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const https = require('https');
const http = require('http');
const { spawn, execSync } = require('child_process');

const {
  getAuthorizationUrl,
  exchangeCodeForTokens,
  storeToken,
  getOAuthStatus
} = require('../server/services/anthropic-oauth');
const {
  loginWithCodexOAuth,
  saveCredentials: saveCodexCredentials
} = require('./oauth-codex.cjs');

const configManager = require('./config-manager');
const daemonManager = require('./daemon-manager');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  gray: '\x1b[90m'
};

// Unicode characters
const chars = {
  check: '✅',
  cross: '❌',
  warning: '⚠️',
  flask: '🧪',
  key: '🔑',
  plug: '🔌',
  server: '🖥️',
  service: '⚙️',
  rocket: '🚀',
  sparkles: '✨',
  arrow: '→',
  bullet: '•',
  radioOff: '○',
  radioOn: '●',
  checkboxOff: '☐',
  checkboxOn: '☑',
  line: '─',
  doubleLine: '═'
};

// Box drawing
const box = {
  topLeft: '╔',
  topRight: '╗',
  bottomLeft: '╚',
  bottomRight: '╝',
  horizontal: '═',
  vertical: '║',
  thinHorizontal: '─'
};

let rl = null;

/**
 * Initialize readline interface
 */
function initReadline() {
  if (rl) return rl;
  
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  // Handle Ctrl+C gracefully
  rl.on('SIGINT', () => {
    console.log('\n\n' + colors.yellow + 'Setup cancelled.' + colors.reset);
    process.exit(0);
  });
  
  return rl;
}

/**
 * Close readline interface
 */
function closeReadline() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/**
 * Prompt for input
 */
function question(prompt, defaultValue = '') {
  return new Promise((resolve) => {
    const displayPrompt = defaultValue 
      ? `${prompt} ${colors.dim}(${defaultValue})${colors.reset}: `
      : `${prompt}: `;
    
    // Ensure stdin is in the right state for readline
    // (raw mode operations may have paused it)
    if (process.stdin.isPaused && process.stdin.isPaused()) {
      process.stdin.resume();
    }
    
    // Close and recreate readline to ensure clean state after raw mode ops
    closeReadline();
    
    initReadline().question(displayPrompt, (answer) => {
      resolve(answer.trim() || defaultValue);
    });
  });
}

/**
 * Prompt for password (hidden input)
 */
function questionSecret(prompt) {
  return new Promise((resolve) => {
    // Close any existing readline to avoid conflicts
    closeReadline();
    
    // Use raw mode to hide input
    process.stdout.write(`${prompt}: `);
    
    let secret = '';
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    
    const onData = (char) => {
      if (char === '\n' || char === '\r') {
        stdin.setRawMode(wasRaw || false);
        stdin.removeListener('data', onData);
        // Don't pause stdin - leave it flowing for next readline
        console.log('');
        resolve(secret);
      } else if (char === '\x03') { // Ctrl+C
        stdin.setRawMode(wasRaw || false);
        stdin.removeListener('data', onData);
        console.log('\n\n' + colors.yellow + 'Setup cancelled.' + colors.reset);
        process.exit(0);
      } else if (char === '\x7f' || char === '\b') { // Backspace
        if (secret.length > 0) {
          secret = secret.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        secret += char;
        process.stdout.write('•');
      }
    };
    
    stdin.on('data', onData);
  });
}

/**
 * Yes/No confirmation
 */
async function confirm(prompt, defaultYes = true) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  const answer = await question(`${prompt} (${hint})`);
  
  if (!answer) return defaultYes;
  return answer.toLowerCase().startsWith('y');
}

/**
 * Multi-select prompt (checkbox style)
 */
async function multiSelect(prompt, options) {
  // Close any existing readline to avoid conflicts
  closeReadline();
  
  console.log(`\n${prompt}`);
  console.log(colors.dim + '(Space to toggle, Enter to confirm)' + colors.reset + '\n');
  
  const selected = new Set();
  let cursor = 0;
  
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    
    function render() {
      // Move cursor up to redraw
      if (cursor > 0 || options.some((_, i) => i > 0)) {
        process.stdout.write(`\x1b[${options.length}A`);
      }
      
      options.forEach((opt, i) => {
        const isSelected = selected.has(opt.value);
        const isCursor = i === cursor;
        const checkbox = isSelected ? colors.green + chars.checkboxOn + colors.reset : chars.checkboxOff;
        const label = isCursor 
          ? colors.cyan + colors.bold + opt.label + colors.reset
          : opt.label;
        const hint = opt.hint ? colors.dim + ` (${opt.hint})` + colors.reset : '';
        
        process.stdout.write(`\x1b[2K  ${checkbox} ${label}${hint}\n`);
      });
    }
    
    // Initial render
    options.forEach((opt, i) => {
      const checkbox = chars.checkboxOff;
      const label = i === cursor 
        ? colors.cyan + colors.bold + opt.label + colors.reset
        : opt.label;
      const hint = opt.hint ? colors.dim + ` (${opt.hint})` + colors.reset : '';
      console.log(`  ${checkbox} ${label}${hint}`);
    });
    
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    
    const onKey = (key) => {
      if (key === '\x03') { // Ctrl+C
        stdin.setRawMode(wasRaw || false);
        stdin.removeListener('data', onKey);
        console.log('\n\n' + colors.yellow + 'Setup cancelled.' + colors.reset);
        process.exit(0);
      } else if (key === '\r' || key === '\n') { // Enter
        stdin.setRawMode(wasRaw || false);
        stdin.removeListener('data', onKey);
        // Don't pause stdin - leave it flowing for next prompt
        console.log('');
        resolve(Array.from(selected));
      } else if (key === ' ') { // Space - toggle
        const opt = options[cursor];
        if (selected.has(opt.value)) {
          selected.delete(opt.value);
        } else {
          selected.add(opt.value);
        }
        render();
      } else if (key === '\x1b[A' || key === 'k') { // Up
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (key === '\x1b[B' || key === 'j') { // Down
        cursor = Math.min(options.length - 1, cursor + 1);
        render();
      }
    };
    
    stdin.on('data', onKey);
  });
}

/**
 * Single select prompt (radio style)
 */
async function select(prompt, options) {
  // Close any existing readline to avoid conflicts
  closeReadline();
  
  console.log(`\n${prompt}\n`);
  
  let cursor = 0;
  
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    
    function render() {
      process.stdout.write(`\x1b[${options.length}A`);
      
      options.forEach((opt, i) => {
        const isCursor = i === cursor;
        const radio = isCursor ? colors.green + chars.radioOn + colors.reset : chars.radioOff;
        const label = isCursor 
          ? colors.cyan + colors.bold + opt.label + colors.reset
          : opt.label;
        const hint = opt.hint ? colors.dim + ` (${opt.hint})` + colors.reset : '';
        
        process.stdout.write(`\x1b[2K  ${radio} ${label}${hint}\n`);
      });
    }
    
    // Initial render
    options.forEach((opt, i) => {
      const radio = i === cursor ? colors.green + chars.radioOn + colors.reset : chars.radioOff;
      const label = i === cursor 
        ? colors.cyan + colors.bold + opt.label + colors.reset
        : opt.label;
      const hint = opt.hint ? colors.dim + ` (${opt.hint})` + colors.reset : '';
      console.log(`  ${radio} ${label}${hint}`);
    });
    
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    
    const onKey = (key) => {
      if (key === '\x03') { // Ctrl+C
        stdin.setRawMode(wasRaw || false);
        stdin.removeListener('data', onKey);
        console.log('\n\n' + colors.yellow + 'Setup cancelled.' + colors.reset);
        process.exit(0);
      } else if (key === '\r' || key === '\n') { // Enter
        stdin.setRawMode(wasRaw || false);
        stdin.removeListener('data', onKey);
        // Don't pause stdin - leave it flowing for next prompt
        console.log('');
        resolve(options[cursor].value);
      } else if (key === '\x1b[A' || key === 'k') { // Up
        cursor = Math.max(0, cursor - 1);
        render();
      } else if (key === '\x1b[B' || key === 'j') { // Down
        cursor = Math.min(options.length - 1, cursor + 1);
        render();
      }
    };
    
    stdin.on('data', onKey);
  });
}

/**
 * Print header
 */
function printHeader() {
  const width = 64;
  const title = `${chars.flask} Evobrew Setup`;
  
  console.log('\n' + colors.bold);
  console.log(box.topLeft + box.horizontal.repeat(width) + box.topRight);
  console.log(box.vertical + ' '.repeat(Math.floor((width - title.length) / 2)) + title + ' '.repeat(Math.ceil((width - title.length) / 2)) + box.vertical);
  console.log(box.bottomLeft + box.horizontal.repeat(width) + box.bottomRight);
  console.log(colors.reset);
  
  console.log('Evobrew is a model-agnostic AI workspace for working with files.\n');
}

/**
 * Print step header
 */
function printStep(step, total, title) {
  console.log(`\n${colors.bold}Step ${step}/${total}: ${title}${colors.reset}`);
  console.log(box.thinHorizontal.repeat(60));
}

/**
 * Print success message
 */
function success(message) {
  console.log(`${chars.check} ${colors.green}${message}${colors.reset}`);
}

/**
 * Print warning message
 */
function warning(message) {
  console.log(`${chars.warning} ${colors.yellow}${message}${colors.reset}`);
}

/**
 * Print error message
 */
function error(message) {
  console.log(`${chars.cross} ${colors.red}${message}${colors.reset}`);
}

/**
 * Print info message
 */
function info(message) {
  console.log(`${colors.dim}${message}${colors.reset}`);
}

/**
 * Spinner for async operations
 */
function spinner(message) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let interval;
  
  return {
    start: () => {
      process.stdout.write(`${frames[0]} ${message}`);
      interval = setInterval(() => {
        i = (i + 1) % frames.length;
        process.stdout.write(`\r${frames[i]} ${message}`);
      }, 80);
    },
    stop: (status = 'done') => {
      clearInterval(interval);
      process.stdout.write('\r\x1b[2K'); // Clear line
      if (status === 'success') {
        success(message);
      } else if (status === 'error') {
        error(message);
      } else if (status === 'warning') {
        warning(message);
      }
    }
  };
}

/**
 * Test OpenAI API key
 */
async function testOpenAI(apiKey) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'Say "ok"' }],
      max_tokens: 5
    });
    
    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ valid: true });
        } else {
          try {
            const err = JSON.parse(data);
            resolve({ valid: false, error: err.error?.message || 'Invalid API key' });
          } catch {
            resolve({ valid: false, error: `HTTP ${res.statusCode}` });
          }
        }
      });
    });
    
    req.on('error', (e) => {
      resolve({ valid: false, error: e.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, error: 'Request timeout' });
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * Test Anthropic API key
 */
async function testAnthropic(apiKey) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say "ok"' }]
    });
    
    const options = {
      hostname: 'api.anthropic.com',
      port: 443,
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ valid: true });
        } else {
          try {
            const err = JSON.parse(data);
            resolve({ valid: false, error: err.error?.message || 'Invalid API key' });
          } catch {
            resolve({ valid: false, error: `HTTP ${res.statusCode}` });
          }
        }
      });
    });
    
    req.on('error', (e) => {
      resolve({ valid: false, error: e.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, error: 'Request timeout' });
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * Test xAI API key
 */
async function testXAI(apiKey) {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      model: 'grok-code-fast-1',
      messages: [{ role: 'user', content: 'Say "ok"' }],
      max_tokens: 5
    });
    
    const options = {
      hostname: 'api.x.ai',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 10000
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ valid: true });
        } else {
          try {
            const err = JSON.parse(data);
            resolve({ valid: false, error: err.error?.message || 'Invalid API key' });
          } catch {
            resolve({ valid: false, error: `HTTP ${res.statusCode}` });
          }
        }
      });
    });
    
    req.on('error', (e) => {
      resolve({ valid: false, error: e.message });
    });
    
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false, error: 'Request timeout' });
    });
    
    req.write(postData);
    req.end();
  });
}

/**
 * Check if Ollama is running at the given URL
 */
async function detectOllama(baseUrl = 'http://localhost:11434') {
  return new Promise((resolve) => {
    try {
      const url = new URL('/api/tags', baseUrl);
      const client = url.protocol === 'https:' ? https : http;
      
      const req = client.get(url.href, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              const models = json.models || [];
              resolve({ 
                running: true, 
                models: models.map(m => m.name),
                modelCount: models.length
              });
            } catch {
              resolve({ running: true, models: [], modelCount: 0 });
            }
          } else {
            resolve({ running: false, models: [], modelCount: 0 });
          }
        });
      });
      
      req.on('error', () => {
        resolve({ running: false, models: [], modelCount: 0 });
      });
      
      req.setTimeout(2000, () => {
        req.destroy();
        resolve({ running: false, models: [], modelCount: 0 });
      });
    } catch (e) {
      // Invalid URL
      resolve({ running: false, models: [], modelCount: 0, error: e.message });
    }
  });
}

/**
 * Check if LMStudio is running at the given URL
 */
async function detectLMStudio(baseUrl = 'http://localhost:1234/v1') {
  return new Promise((resolve) => {
    try {
      const url = new URL('/models', baseUrl);
      const client = url.protocol === 'https:' ? https : http;
      
      const req = client.get(url.href, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const json = JSON.parse(data);
              const models = json.data || [];
              resolve({ 
                running: true, 
                models: models.map(m => m.id),
                modelCount: models.length
              });
            } catch {
              resolve({ running: true, models: [], modelCount: 0 });
            }
          } else {
            resolve({ running: false, models: [], modelCount: 0 });
          }
        });
      });
      
      req.on('error', () => {
        resolve({ running: false, models: [], modelCount: 0 });
      });
      
      req.setTimeout(2000, () => {
        req.destroy();
        resolve({ running: false, models: [], modelCount: 0 });
      });
    } catch (e) {
      // Invalid URL
      resolve({ running: false, models: [], modelCount: 0, error: e.message });
    }
  });
}

/**
 * Check if OpenClaw is installed and gateway is running
 */
async function detectOpenClaw() {
  // Check if openclaw CLI is installed
  let installed = false;
  try {
    execSync('which openclaw', { stdio: 'pipe' });
    installed = true;
  } catch {
    return { installed: false, running: false };
  }
  
  // Check if gateway is running on default port
  return new Promise((resolve) => {
    const req = http.get('http://localhost:18789/health', (res) => {
      resolve({ installed: true, running: res.statusCode === 200, url: 'ws://localhost:18789' });
    });
    
    req.on('error', () => {
      resolve({ installed: true, running: false });
    });
    
    req.setTimeout(2000, () => {
      req.destroy();
      resolve({ installed: true, running: false });
    });
  });
}

/**
 * Test OpenClaw gateway connection
 */
async function testOpenClawConnection(url, token, password) {
  return new Promise((resolve) => {
    // Convert ws:// URL to http:// for health check
    const httpUrl = url.replace('ws://', 'http://').replace('wss://', 'https://');
    
    const req = http.get(`${httpUrl}/health`, (res) => {
      if (res.statusCode === 200) {
        resolve({ connected: true });
      } else {
        resolve({ connected: false, error: `HTTP ${res.statusCode}` });
      }
    });
    
    req.on('error', (e) => {
      resolve({ connected: false, error: e.message });
    });
    
    req.setTimeout(5000, () => {
      req.destroy();
      resolve({ connected: false, error: 'Connection timeout' });
    });
  });
}

/**
 * Check if a port is available
 */
async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = require('net').createServer();
    
    server.once('error', () => {
      resolve(false);
    });
    
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    
    server.listen(port, '127.0.0.1');
  });
}

/**
 * Open URL in user's default browser
 */
async function openInBrowser(url) {
  return new Promise((resolve) => {
    try {
      let command;
      let args;

      if (process.platform === 'darwin') {
        command = 'open';
        args = [url];
      } else if (process.platform === 'win32') {
        command = 'cmd';
        args = ['/c', 'start', '""', `"${url}"`];
      } else {
        command = 'xdg-open';
        args = [url];
      }

      const child = spawn(command, args, { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => resolve(true));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/**
 * Parse Anthropic callback input from full URL or code#state
 */
function parseAnthropicOAuthCallback(input) {
  const text = (input || '').trim();
  if (!text) {
    throw new Error('No input received');
  }

  if (text.startsWith('http')) {
    const parsed = new URL(text);
    const code = parsed.searchParams.get('code');
    const state = parsed.hash ? parsed.hash.replace(/^#/, '') : null;

    if (code && state) {
      return { code: decodeURIComponent(code), state: decodeURIComponent(state) };
    }

    if (code && parsed.searchParams.get('state')) {
      return { code: decodeURIComponent(code), state: decodeURIComponent(parsed.searchParams.get('state')) };
    }
  }

  if (text.includes('#')) {
    const [code, state] = text.split('#');
    if (code && state) {
      return {
        code: decodeURIComponent(code.trim()),
        state: decodeURIComponent(state.trim())
      };
    }
  }

  const codeMatch = text.match(/code=([^&]+)/);
  const stateMatch = text.match(/state=([^&]+)/);

  if (codeMatch && stateMatch) {
    return {
      code: decodeURIComponent(codeMatch[1]),
      state: decodeURIComponent(stateMatch[1])
    };
  }

  throw new Error('Could not extract code and state from pasted value');
}

/**
 * Run Anthropic OAuth setup flow
 */
async function runAnthropicOAuthFlow(config) {
  if (config?.security?.encryption_key) {
    process.env.ENCRYPTION_KEY = config.security.encryption_key;
  }

  const { authUrl, verifier } = getAuthorizationUrl();

  info('Opening Anthropic OAuth in browser...');
  const opened = await openInBrowser(authUrl);
  if (!opened) {
    error('Unable to auto-open browser. Paste this URL manually:');
    console.log(authUrl);
  }

  console.log('\n' + colors.green + 'Paste the full redirect URL here after authorization.' + colors.reset);
  console.log(colors.dim + 'Example: https://console.anthropic.com/oauth/code/callback?code=...#...' + colors.reset + '\n');

  const pasted = await questionSecret('? Redirect URL from Anthropic');

  const { code, state } = parseAnthropicOAuthCallback(pasted);
  const result = await exchangeCodeForTokens(code, state, verifier);
  await storeToken(result.accessToken, result.expiresAt, result.refreshToken);

  const status = await getOAuthStatus();
  if (!status.configured) {
    throw new Error('OAuth token was not persisted after exchange.');
  }

  return {
    success: true,
    status
  };
}

/**
 * Step 1: AI Providers
 */
async function stepProviders(config, projectRoot, providerFilter = null) {
  printStep(1, 5, 'AI Providers');
  console.log('You need at least ONE AI provider configured.\n');
  
  const providerOptions = [
    { value: 'openai', label: 'OpenAI', hint: 'GPT-5, GPT-4o' },
    { value: 'anthropic', label: 'Anthropic', hint: 'Claude Opus, Sonnet' },
    { value: 'xai', label: 'xAI', hint: 'Grok' },
    { value: 'local', label: 'Local Models', hint: 'Ollama, LMStudio' }
  ];

  let providers = [];

  if (providerFilter && providerFilter.size > 0) {
    providers = providerOptions
      .filter((opt) => providerFilter.has(opt.value))
      .map((opt) => opt.value);
  } else {
    providers = await multiSelect('Select providers to configure:', providerOptions);
  }
  
  if (providers.length === 0) {
    warning('No providers selected. You can configure them later with: evobrew config');
    return config;
  }
  
  // Ensure providers object exists
  if (!config.providers) config.providers = {};
  
  // Configure each selected provider
  for (const provider of providers) {
    console.log('');
    
    if (provider === 'openai') {
      const authMethod = await select('? OpenAI - Use OAuth or API Key?', [
        { value: 'oauth', label: 'ChatGPT OAuth', hint: 'Use ChatGPT Plus/Pro subscription for Codex models' },
        { value: 'apikey', label: 'API Key', hint: 'Traditional OpenAI API key' }
      ]);

      if (authMethod === 'oauth') {
        info('OAuth will authenticate using your ChatGPT Plus/Pro subscription.');
        info('This gives access to Codex models (gpt-5.2, gpt-5.3-codex, gpt-5.3-codex-spark).');
        console.log('');

        const spin = spinner('Opening browser for OpenAI authentication...');
        try {
          spin.start();

          const creds = await loginWithCodexOAuth();
          saveCodexCredentials(creds);

          spin.stop('success');
          config.providers['openai-codex'] = { enabled: true, oauth: true };
          success('OpenAI Codex OAuth configured');
        } catch (err) {
          spin.stop('error');
          error(`OAuth failed: ${err.message}`);
        }
      } else {
        const key = await questionSecret(`? OpenAI API Key`);

        if (key) {
          const spin = spinner('Testing OpenAI connection...');
          spin.start();

          const result = await testOpenAI(key);

          if (result.valid) {
            spin.stop('success');
            config.providers.openai = { enabled: true, api_key: key };
            success('OpenAI configured');
          } else {
            spin.stop('error');
            error(`OpenAI test failed: ${result.error}`);

            if (await confirm('Save anyway?', false)) {
              config.providers.openai = { enabled: true, api_key: key };
              warning('OpenAI saved (unverified)');
            }
          }
        }
      }
    }
    
    if (provider === 'anthropic') {
      const authMethod = await select('? Anthropic - Use OAuth or API Key?', [
        { value: 'oauth', label: 'OAuth', hint: 'recommended - higher rate limits' },
        { value: 'apikey', label: 'API Key', hint: 'traditional method' }
      ]);
      
      if (authMethod === 'oauth') {
        info('OAuth uses your Claude subscription for higher rate limits.');
        try {
          const result = await runAnthropicOAuthFlow(config);

          if (result.success) {
            config.providers.anthropic = { enabled: true, oauth: true, api_key: '' };
            success('Anthropic OAuth configured');
          }
        } catch (err) {
          error(`Anthropic OAuth failed: ${err.message}`);

          if (await confirm('Save as API key fallback?', false)) {
            const fallbackKey = await questionSecret('? Anthropic API Key (fallback)');
            if (fallbackKey) {
              config.providers.anthropic = { enabled: true, oauth: false, api_key: fallbackKey };
              warning('Anthropic saved with API key fallback.');
            } else {
              warning('Anthropic OAuth not configured. You can run setup again later.');
            }
          }
        }
      } else {
        const key = await questionSecret(`? Anthropic API Key`);
        
        if (key) {
          const spin = spinner('Testing Anthropic connection...');
          spin.start();
          
          const result = await testAnthropic(key);
          
          if (result.valid) {
            spin.stop('success');
            config.providers.anthropic = { enabled: true, oauth: false, api_key: key };
            success('Anthropic configured');
          } else {
            spin.stop('error');
            error(`Anthropic test failed: ${result.error}`);
            
            if (await confirm('Save anyway?', false)) {
              config.providers.anthropic = { enabled: true, oauth: false, api_key: key };
              warning('Anthropic saved (unverified)');
            }
          }
        }
      }
    }
    
    if (provider === 'xai') {
      const key = await questionSecret(`? xAI API Key`);
      
      if (key) {
        const spin = spinner('Testing xAI connection...');
        spin.start();
        
        const result = await testXAI(key);
        
        if (result.valid) {
          spin.stop('success');
          config.providers.xai = { enabled: true, api_key: key };
          success('xAI configured');
        } else {
          spin.stop('error');
          error(`xAI test failed: ${result.error}`);
          
          if (await confirm('Save anyway?', false)) {
            config.providers.xai = { enabled: true, api_key: key };
            warning('xAI saved (unverified)');
          }
        }
      }
    }
    
    if (provider === 'local') {
      console.log('');
      info('Checking for local model servers...');
      
      // Check Ollama
      const ollamaDefault = 'http://localhost:11434';
      let ollamaUrl = ollamaDefault;
      let ollamaDetection = await detectOllama(ollamaUrl);
      
      if (ollamaDetection.running) {
        success(`Ollama detected with ${ollamaDetection.modelCount} model${ollamaDetection.modelCount !== 1 ? 's' : ''}`);
        if (ollamaDetection.modelCount > 0 && ollamaDetection.modelCount <= 5) {
          info(`  Models: ${ollamaDetection.models.join(', ')}`);
        } else if (ollamaDetection.modelCount > 5) {
          info(`  Models: ${ollamaDetection.models.slice(0, 5).join(', ')}...`);
        }
        
        config.providers.ollama = {
          enabled: true,
          base_url: ollamaUrl,
          auto_detect: true
        };
      } else {
        info('Ollama not detected at default address.');
        
        const customOllama = await confirm('? Configure custom Ollama URL?', false);
        if (customOllama) {
          ollamaUrl = await question('? Ollama URL', ollamaDefault);
          ollamaDetection = await detectOllama(ollamaUrl);
          
          if (ollamaDetection.running) {
            success(`Ollama detected at ${ollamaUrl} with ${ollamaDetection.modelCount} models`);
            config.providers.ollama = {
              enabled: true,
              base_url: ollamaUrl,
              auto_detect: false  // Custom URL - don't auto-detect
            };
          } else {
            warning('Ollama not responding at that URL.');
            if (await confirm('Save anyway?', false)) {
              config.providers.ollama = {
                enabled: true,
                base_url: ollamaUrl,
                auto_detect: false
              };
              warning('Ollama saved (unverified)');
            }
          }
        } else {
          // Keep auto-detect enabled so it will try on startup
          config.providers.ollama = {
            enabled: true,
            base_url: ollamaDefault,
            auto_detect: true
          };
          info('Ollama auto-detection enabled (will check on startup)');
        }
      }
      
      // Check LMStudio
      console.log('');
      const lmstudioDefault = 'http://localhost:1234/v1';
      let lmstudioUrl = lmstudioDefault;
      let lmstudioDetection = await detectLMStudio(lmstudioUrl);
      
      if (lmstudioDetection.running) {
        success(`LMStudio detected with ${lmstudioDetection.modelCount} model${lmstudioDetection.modelCount !== 1 ? 's' : ''}`);
        if (lmstudioDetection.modelCount > 0 && lmstudioDetection.modelCount <= 5) {
          info(`  Models: ${lmstudioDetection.models.join(', ')}`);
        }
        
        config.providers.lmstudio = {
          enabled: true,
          base_url: lmstudioUrl
        };
      } else {
        const configureLMStudio = await confirm('? Configure LMStudio?', false);
        if (configureLMStudio) {
          lmstudioUrl = await question('? LMStudio URL', lmstudioDefault);
          lmstudioDetection = await detectLMStudio(lmstudioUrl);
          
          if (lmstudioDetection.running) {
            success(`LMStudio detected at ${lmstudioUrl}`);
            config.providers.lmstudio = {
              enabled: true,
              base_url: lmstudioUrl
            };
          } else {
            warning('LMStudio not responding at that URL.');
            if (await confirm('Save anyway?', false)) {
              config.providers.lmstudio = {
                enabled: true,
                base_url: lmstudioUrl
              };
              warning('LMStudio saved (unverified)');
            }
          }
        } else {
          config.providers.lmstudio = {
            enabled: false,
            base_url: lmstudioDefault
          };
        }
      }
      
      console.log('');
      success('Local models configuration saved');
    }
  }
  
  return config;
}

/**
 * Step 2: OpenClaw Integration
 */
async function stepOpenClaw(config) {
  printStep(2, 5, 'OpenClaw Integration');
  console.log('OpenClaw provides persistent memory and agent capabilities.\n');
  
  // Ensure openclaw object exists
  if (!config.openclaw) config.openclaw = {};
  
  const detection = await detectOpenClaw();
  
  if (detection.running) {
    success(`OpenClaw Gateway detected at ${detection.url}`);
    
    if (await confirm('Connect to OpenClaw?', true)) {
      const token = await questionSecret('? Gateway token');
      const password = await questionSecret('? Gateway password (optional)');
      
      const spin = spinner('Testing connection...');
      spin.start();
      
      const result = await testOpenClawConnection(detection.url, token, password);
      
      if (result.connected) {
        spin.stop('success');
        config.openclaw = {
          enabled: true,
          gateway_url: detection.url,
          token: token || '',
          password: password || ''
        };
        success('Connected to OpenClaw');
      } else {
        spin.stop('warning');
        warning(`Connection test failed: ${result.error}`);
        
        if (await confirm('Save configuration anyway?', false)) {
          config.openclaw = {
            enabled: true,
            gateway_url: detection.url,
            token: token || '',
            password: password || ''
          };
        }
      }
    }
  } else if (detection.installed) {
    info('OpenClaw is installed but gateway is not running.');
    info('Start it with: openclaw gateway start');
    
    if (await confirm('Configure OpenClaw anyway?', false)) {
      const url = await question('? Gateway URL', 'ws://localhost:18789');
      const token = await questionSecret('? Gateway token');
      const password = await questionSecret('? Gateway password (optional)');
      
      config.openclaw = {
        enabled: true,
        gateway_url: url,
        token: token || '',
        password: password || ''
      };
      success('OpenClaw configuration saved');
    }
  } else {
    info('OpenClaw not detected. Install it for persistent memory features.');
    info('Learn more: https://openclaw.ai');
    
    if (await confirm('Configure OpenClaw manually?', false)) {
      const url = await question('? Gateway URL', 'ws://localhost:18789');
      const token = await questionSecret('? Gateway token');
      
      config.openclaw = {
        enabled: true,
        gateway_url: url,
        token: token || ''
      };
      success('OpenClaw configuration saved');
    }
  }
  
  return config;
}

/**
 * Step 3: Brain Configuration
 */
async function stepBrains(config) {
  printStep(3, 6, 'Brain Configuration');
  console.log('Brains are research knowledge bases that can be queried.\n');
  
  // Ensure features.brains object exists
  if (!config.features) config.features = {};
  if (!config.features.brains) config.features.brains = { enabled: false, directories: [] };
  if (!config.embeddings) config.embeddings = { provider: 'openai', api_key: '', model: 'text-embedding-3-small', dimensions: 512 };
  
  const enableBrains = await confirm('? Enable Brains (research knowledge bases)?', config.features.brains.enabled || false);
  
  if (enableBrains) {
    config.features.brains.enabled = true;
    
    // Default brain directories
    const defaultDirs = [
      '/Volumes/Bertha - Data/_ALL_COZ/cosmoRuns/',
      path.join(os.homedir(), 'cosmo-brains')
    ];
    
    const currentDirs = config.features.brains.directories || [];
    const dirsDisplay = currentDirs.length > 0 ? currentDirs.join(', ') : '(none configured)';
    
    console.log(`\n  Current directories: ${colors.dim}${dirsDisplay}${colors.reset}`);
    
    if (await confirm('? Configure brain directories?', currentDirs.length === 0)) {
      console.log(`\n  Enter paths to directories containing brains (comma-separated).`);
      console.log(`  ${colors.dim}Default: ${defaultDirs[0]}${colors.reset}\n`);
      
      const dirsInput = await question('? Brain directories', currentDirs.join(', ') || defaultDirs[0]);
      const dirs = dirsInput.split(',').map(d => d.trim()).filter(Boolean);
      config.features.brains.directories = dirs;
      
      // Check which directories exist
      for (const dir of dirs) {
        try {
          await fs.promises.access(dir);
          success(`  Directory exists: ${dir}`);
        } catch {
          warning(`  Directory not found: ${dir}`);
        }
      }
    }
    
    // Embeddings API key for semantic search
    console.log(`\n  ${colors.cyan}Semantic Search${colors.reset}`);
    console.log(`  Brains use OpenAI embeddings for semantic queries.`);
    console.log(`  Without an API key, keyword search is still available.\n`);
    
    const hasKey = config.embeddings.api_key && config.embeddings.api_key.length > 10;
    if (hasKey) {
      success(`Embeddings API key configured (${config.embeddings.api_key.substring(0, 7)}...)`);
      if (await confirm('? Update embeddings API key?', false)) {
        const apiKey = await questionSecret('? OpenAI API key for embeddings');
        if (apiKey) {
          config.embeddings.api_key = apiKey;
          success('Embeddings API key saved');
        }
      }
    } else {
      const wantKey = await confirm('? Configure OpenAI API key for semantic search?', true);
      if (wantKey) {
        const apiKey = await questionSecret('? OpenAI API key');
        if (apiKey) {
          config.embeddings.api_key = apiKey;
          success('Embeddings API key saved');
        }
      } else {
        info('Skipping embeddings - keyword search will be used');
      }
    }
    
    success('Brain configuration saved');
  } else {
    config.features.brains.enabled = false;
    info('Brains disabled');
  }
  
  return config;
}

/**
 * Step 4: Server Configuration
 */
async function stepServer(config) {
  printStep(4, 6, 'Server Configuration');
  
  // Ensure server object exists
  if (!config.server) config.server = {};
  
  // HTTP Port
  let httpPort = config.server.http_port || 3405;
  const httpAvailable = await isPortAvailable(httpPort);
  
  if (!httpAvailable) {
    warning(`Port ${httpPort} is already in use.`);
  }
  
  const newHttpPort = await question('? HTTP Port', String(httpPort));
  config.server.http_port = parseInt(newHttpPort, 10);
  
  // HTTPS
  const enableHttps = await confirm('? Enable HTTPS?', false);
  
  // Ensure features object exists
  if (!config.features) config.features = {};
  config.features.https = enableHttps;
  
  if (enableHttps) {
    let httpsPort = config.server.https_port || 3406;
    const newHttpsPort = await question('? HTTPS Port', String(httpsPort));
    config.server.https_port = parseInt(newHttpsPort, 10);
  }
  
  success('Server configuration saved');
  
  return config;
}

/**
 * Step 5: Service Installation
 */
async function stepService(config) {
  printStep(5, 6, 'Install as Service');
  console.log('Evobrew can run as a background service (recommended).\n');
  
  const platform = daemonManager.detectPlatform();
  
  if (!platform.supported) {
    warning(platform.message || 'Platform not supported for service installation.');
    info('You can start manually with: evobrew start');
    return config;
  }
  
  info(`Detected: ${platform.platform} (${platform.serviceManager})`);

  // Runner selection (public-release robustness)
  const pm2Available = daemonManager.hasPm2 && daemonManager.hasPm2();
  const runnerDefault = (platform.platform === 'linux' && pm2Available) ? 'pm2' : platform.serviceManager;
  const runnerChoices = [];
  if (pm2Available) runnerChoices.push({ value: 'pm2', label: 'PM2', hint: 'Recommended if you already use PM2 (great for Pi/headless)' });
  runnerChoices.push({ value: platform.serviceManager, label: platform.serviceManager, hint: 'System service manager' });
  runnerChoices.push({ value: 'skip', label: 'Skip', hint: 'Run manually (foreground)' });

  console.log('Choose how Evobrew should run in the background:\n');
  const runnerPick = await question(`Runner`, runnerDefault);
  const runner = (runnerPick || runnerDefault).toLowerCase();

  const status = daemonManager.getDaemonStatus();
  
  if (runner === 'skip') {
    info('Skipped background runner installation.');
    info('Start manually with: evobrew start');
    return config;
  }

  const installLabel = runner === 'pm2' ? 'PM2' : platform.serviceManager;

  if (status.installed && status.runner === runner) {
    info(`${installLabel} runner appears to be installed.`);

    if (await confirm(`Reinstall ${installLabel}?`, false)) {
      const spin = spinner(`Reinstalling (${installLabel})...`);
      spin.start();

      try {
        const result = await daemonManager.installDaemon({ runner: runner === platform.serviceManager ? null : runner });

        if (result.success) {
          spin.stop('success');
          success(`${installLabel} installed and started`);
        } else {
          spin.stop('error');
          error('Installation failed');
        }
      } catch (err) {
        spin.stop('error');
        error(`Installation failed: ${err.message}`);
      }
    }
  } else {
    if (await confirm(`? Install/run under ${installLabel}?`, true)) {
      const spin = spinner(`Installing (${installLabel})...`);
      spin.start();

      try {
        const result = await daemonManager.installDaemon({ runner: runner === platform.serviceManager ? null : runner });

        if (result.success) {
          spin.stop('success');
          success(`${installLabel} installed and started`);
        } else {
          spin.stop('error');
          error('Installation failed');
        }
      } catch (err) {
        spin.stop('error');
        error(`Installation failed: ${err.message}`);
        info(`You can install manually later: evobrew daemon install${runner === 'pm2' ? ' --pm2' : ''}`);
      }
    } else {
      info('Skipped runner installation.');
      info('Start manually with: evobrew start');
    }
  }
  
  return config;
}

/**
 * Check if the server is responding on the configured port
 */
async function checkServerHealth(port = 3405) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/health`, (res) => {
      resolve({ healthy: res.statusCode === 200, statusCode: res.statusCode });
    });
    
    req.on('error', () => {
      resolve({ healthy: false, error: 'Connection refused' });
    });
    
    req.setTimeout(3000, () => {
      req.destroy();
      resolve({ healthy: false, error: 'Timeout' });
    });
  });
}

/**
 * Step 6: Verification
 */
async function stepVerification(config) {
  printStep(6, 6, 'Verification');
  console.log('Testing configuration...\n');
  
  const results = [];
  
  // Test server
  const httpPort = config.server?.http_port || 3405;
  const serverHealth = await checkServerHealth(httpPort);
  
  if (serverHealth.healthy) {
    success(`Server responding on http://localhost:${httpPort}`);
    results.push({ name: 'Server', success: true });
  } else {
    warning(`Server not responding on http://localhost:${httpPort}`);
    info('This is normal if service installation was skipped.');
    results.push({ name: 'Server', success: false });
  }
  
  // Test providers
  const providers = config.providers || {};
  
  if (providers.openai?.enabled && providers.openai?.api_key) {
    const result = await testOpenAI(providers.openai.api_key);
    if (result.valid) {
      success('OpenAI connection working');
      results.push({ name: 'OpenAI', success: true });
    } else {
      warning(`OpenAI connection failed: ${result.error}`);
      results.push({ name: 'OpenAI', success: false });
    }
  }

  if (providers['openai-codex']?.enabled) {
    success('OpenAI Codex OAuth configured');
    results.push({ name: 'OpenAI Codex OAuth', success: true });
  }
  
  if (providers.anthropic?.enabled) {
    if (providers.anthropic?.oauth) {
      success('Anthropic OAuth configured');
      results.push({ name: 'Anthropic OAuth', success: true });
    } else if (providers.anthropic?.api_key) {
      const result = await testAnthropic(providers.anthropic.api_key);
      if (result.valid) {
        success('Anthropic connection working');
        results.push({ name: 'Anthropic', success: true });
      } else {
        warning(`Anthropic connection failed: ${result.error}`);
        results.push({ name: 'Anthropic', success: false });
      }
    }
  }
  
  if (providers.xai?.enabled && providers.xai?.api_key) {
    const result = await testXAI(providers.xai.api_key);
    if (result.valid) {
      success('xAI connection working');
      results.push({ name: 'xAI', success: true });
    } else {
      warning(`xAI connection failed: ${result.error}`);
      results.push({ name: 'xAI', success: false });
    }
  }
  
  // Test OpenClaw
  if (config.openclaw?.enabled && config.openclaw?.gateway_url) {
    const result = await testOpenClawConnection(
      config.openclaw.gateway_url,
      config.openclaw.token,
      config.openclaw.password
    );
    
    if (result.connected) {
      success('OpenClaw connected');
      results.push({ name: 'OpenClaw', success: true });
    } else {
      warning(`OpenClaw connection failed: ${result.error}`);
      results.push({ name: 'OpenClaw', success: false });
    }
  }
  
  return results;
}

/**
 * Normalize and expand provider selection keys
 */
function normalizeProviderSelection(selection = []) {
  const normalized = new Set();

  if (!selection || !Array.isArray(selection)) {
    return normalized;
  }

  for (const item of selection) {
    const value = String(item || '').toLowerCase().trim();
    if (!value) continue;

    if (value === 'openai-codex' || value === 'openai') {
      normalized.add('openai');
      continue;
    }

    if (value === 'anthropic') {
      normalized.add('anthropic');
      continue;
    }

    if (value === 'xai') {
      normalized.add('xai');
      continue;
    }

    if (value === 'ollama') {
      normalized.add('local');
      continue;
    }

    if (value === 'openclaw') {
      normalized.add('openclaw');
      continue;
    }

    if (value === 'local') {
      normalized.add('local');
      continue;
    }

    if (value === 'brains' || value === 'brain') {
      normalized.add('brains');
      continue;
    }
  }

  return normalized;
}

/**
 * Get current provider configuration status
 */
async function getConfigStatus(config = null) {
  if (!config) {
    config = await configManager.loadConfigSafe();
  }

  if (!config) {
    config = configManager.getDefaultConfig();
  }

  const providers = config.providers || {};
  const openclawConfig = config.openclaw || {};

  // Anthropic status
  const anthropicConfigured = !!(providers.anthropic?.enabled && (providers.anthropic?.oauth || providers.anthropic?.api_key));
  const anthropicStatus = anthropicConfigured
    ? (providers.anthropic?.oauth ? 'OAuth configured' : 'API key configured')
    : 'Not configured';

  // OpenAI Codex status
  const openaiCodexConfigured = !!(providers['openai-codex']?.enabled || providers.openai?.enabled);
  const openaiCodexStatus = providers['openai-codex']?.enabled
    ? 'OAuth configured'
    : openaiCodexConfigured
      ? 'API key configured'
      : 'Not configured';

  // xAI status
  const xaiConfigured = !!(providers.xai?.enabled && providers.xai?.api_key);
  const xaiStatus = xaiConfigured ? 'Configured' : 'Not configured';

  // Ollama status
  const ollamaConfigured = !!providers.ollama?.enabled;
  let ollamaStatus = 'Not configured';
  if (ollamaConfigured) {
    const ollamaUrl = providers.ollama?.base_url || 'http://localhost:11434';
    const detection = await detectOllama(ollamaUrl);
    ollamaStatus = detection.running && providers.ollama?.auto_detect
      ? 'Auto-detected'
      : 'Configured';
  }

  const openclawConfigured = !!openclawConfig.enabled;
  const openclawStatus = openclawConfigured ? 'Configured' : 'Not configured';

  // Brains status
  const brainsConfig = config.features?.brains || {};
  const brainsEnabled = !!brainsConfig.enabled;
  const brainsDirs = brainsConfig.directories?.length || 0;
  const embeddingsKey = config.embeddings?.api_key;
  let brainsStatus = 'Disabled';
  if (brainsEnabled) {
    if (embeddingsKey) {
      brainsStatus = `Enabled (${brainsDirs} dir${brainsDirs !== 1 ? 's' : ''}, semantic search)`;
    } else {
      brainsStatus = `Enabled (${brainsDirs} dir${brainsDirs !== 1 ? 's' : ''}, keyword only)`;
    }
  }

  return {
    anthropic: {
      configured: anthropicConfigured,
      status: anthropicStatus,
      label: 'Anthropic'
    },
    openaiCodex: {
      configured: openaiCodexConfigured,
      status: openaiCodexStatus,
      label: 'OpenAI Codex'
    },
    xai: {
      configured: xaiConfigured,
      status: xaiStatus,
      label: 'xAI'
    },
    ollama: {
      configured: ollamaConfigured,
      status: ollamaStatus,
      label: 'Ollama'
    },
    openclaw: {
      configured: openclawConfigured,
      status: openclawStatus,
      label: 'OpenClaw'
    },
    brains: {
      configured: brainsEnabled,
      status: brainsStatus,
      label: 'Brains'
    }
  };
}

/**
 * Print current configuration status summary
 */
function printConfigStatus(status) {
  console.log('📋 Current Configuration:');
  const lines = [
    'anthropic',
    'openaiCodex',
    'xai',
    'ollama',
    'openclaw'
  ];

  for (const key of lines) {
    const item = status[key];
    const icon = item.configured ? '✓' : '✗';
    const paddedLabel = item.label.padEnd(12);
    console.log(`  ${icon} ${paddedLabel} [${item.status}]`);
  }
}

/**
 * Print completion message
 */
function printCompletion(config) {
  const httpPort = config.server?.http_port || 3405;
  const width = 64;
  
  console.log('\n' + colors.bold + colors.green);
  console.log(box.topLeft + box.horizontal.repeat(width) + box.topRight);
  console.log(box.vertical + ' '.repeat(Math.floor((width - 17) / 2)) + `${chars.check} Setup Complete!` + ' '.repeat(Math.ceil((width - 17) / 2)) + box.vertical);
  console.log(box.bottomLeft + box.horizontal.repeat(width) + box.bottomRight);
  console.log(colors.reset);
  
  console.log(`Evobrew is running at: ${colors.cyan}http://localhost:${httpPort}${colors.reset}\n`);
  
  console.log(colors.bold + 'Commands:' + colors.reset);
  console.log(`  evobrew daemon status   Check server status`);
  console.log(`  evobrew daemon logs     View logs`);
  console.log(`  evobrew config          Edit configuration`);
  
  console.log(`\n${colors.bold}Documentation:${colors.reset} https://evobrew.ai/docs\n`);
}

/**
 * Generate a new encryption key
 */
function generateEncryptionKey() {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Main setup wizard entry point
 */
async function setupWizard(projectRoot, options = {}) {
  printHeader();
  
  // Initialize config directory
  await configManager.initConfigDir();
  
  // Load existing config or start fresh
  let config = await configManager.loadConfigSafe();
  if (!config) {
    config = configManager.getDefaultConfig();
  }
  
  // Generate encryption key if not present
  if (!config.security) {
    config.security = {};
  }
  if (!config.security.encryption_key) {
    config.security.encryption_key = generateEncryptionKey();
    info('Generated new encryption key');
  }

  const configStatus = await getConfigStatus(config);

  // CLI-only status view
  if (options.showStatus) {
    printConfigStatus(configStatus);
    closeReadline();
    return true;
  }

  let setupPlan = null;
  let fullSetup = false;

  if (Array.isArray(options.only) && options.only.length > 0) {
    const filtered = normalizeProviderSelection(options.only);
    setupPlan = Array.from(filtered);
  } else if (Array.isArray(options.skip) && options.skip.length > 0) {
    const skipped = normalizeProviderSelection(options.skip);
    const defaultPlan = new Set(['openai', 'anthropic', 'xai', 'local', 'openclaw', 'brains']);
    skipped.forEach((item) => {
      defaultPlan.delete(item);
    });
    setupPlan = Array.from(defaultPlan);
  } else {
    printConfigStatus(configStatus);
    console.log('\nWhat would you like to do?');
    console.log('  [1] Configure missing providers only');
    console.log('  [2] Reconfigure specific provider');
    console.log('  [3] Full setup (all providers)');
    console.log('  [4] Exit');

    const chosen = await question('Enter a number', '3');

    if (chosen === '1') {
      const missing = [];

      if (!configStatus.anthropic.configured) missing.push('anthropic');
      if (!configStatus.openaiCodex.configured) missing.push('openai');
      if (!configStatus.xai.configured) missing.push('xai');
      if (!configStatus.ollama.configured) missing.push('local');
      if (!configStatus.openclaw.configured) missing.push('openclaw');
      if (!configStatus.brains.configured) missing.push('brains');

      setupPlan = missing;

      if (setupPlan.length === 0) {
        info('No missing providers detected. Run full setup if you want to review all settings.');
        return true;
      }
    } else if (chosen === '2') {
      const reconfigure = await multiSelect('Select providers to reconfigure:', [
        { value: 'anthropic', label: 'Anthropic', hint: 'OAuth or API key' },
        { value: 'openai', label: 'OpenAI Codex', hint: 'OAuth or API key' },
        { value: 'xai', label: 'xAI', hint: 'API key' },
        { value: 'ollama', label: 'Ollama', hint: 'Local models' },
        { value: 'openclaw', label: 'OpenClaw', hint: 'Gateway integration' },
        { value: 'brains', label: 'Brains', hint: 'Research knowledge bases' }
      ]);

      setupPlan = normalizeProviderSelection(reconfigure);

      if (setupPlan.length === 0) {
        info('No provider selected. Exiting setup.');
        closeReadline();
        return true;
      }
    } else if (chosen === '3') {
      fullSetup = true;
    } else {
      info('Setup cancelled.');
      closeReadline();
      return true;
    }
  }

  const providerStepTargets = new Set(setupPlan || []);
  const needsProviderStep = providerStepTargets.has('openai')
    || providerStepTargets.has('anthropic')
    || providerStepTargets.has('xai')
    || providerStepTargets.has('local');
  const needsOpenClawStep = providerStepTargets.has('openclaw');
  const needsBrainsStep = providerStepTargets.has('brains');

  // Track which step we're on for better error messages
  let currentStep = 0;
  const stepNames = ['Initialization', 'AI Providers', 'OpenClaw Integration', 'Brain Configuration', 'Server Configuration', 'Service Installation', 'Verification'];

  try {
    if (fullSetup) {
      // Preserve the existing full setup flow exactly.
      currentStep = 1;
      config = await stepProviders(config, projectRoot);
      await configManager.saveConfig(config);

      currentStep = 2;
      config = await stepOpenClaw(config);
      await configManager.saveConfig(config);

      currentStep = 3;
      config = await stepBrains(config);
      await configManager.saveConfig(config);

      currentStep = 4;
      config = await stepServer(config);
      await configManager.saveConfig(config);

      currentStep = 5;
      config = await stepService(config);
      await configManager.saveConfig(config);

      currentStep = 6;
      await stepVerification(config);

      printCompletion(config);
    } else {
      if (needsProviderStep) {
        currentStep = 1;
        config = await stepProviders(config, projectRoot, providerStepTargets);
        await configManager.saveConfig(config);
      }

      if (needsOpenClawStep) {
        currentStep = 2;
        config = await stepOpenClaw(config);
        await configManager.saveConfig(config);
      }

      if (needsBrainsStep) {
        currentStep = 3;
        config = await stepBrains(config);
        await configManager.saveConfig(config);
      }

      if (needsProviderStep || needsOpenClawStep || needsBrainsStep) {
        currentStep = 6;
        await stepVerification(config);
        printCompletion(config);
      } else {
        info('No setup sections selected.');
      }
    }
  } catch (err) {
    console.log(''); // Ensure we're on a new line
    const stepName = stepNames[currentStep] || 'setup flow';
    error(`Setup failed at Step ${currentStep} (${stepName}): ${err.message}`);
    
    // Print stack trace for debugging
    if (process.env.DEBUG || process.env.EVOBREW_DEBUG) {
      console.log('\n' + colors.dim + 'Stack trace:' + colors.reset);
      console.log(colors.dim + err.stack + colors.reset);
    } else {
      info('Run with DEBUG=1 for stack trace');
    }
    
    // Save whatever config we have
    try {
      await configManager.saveConfig(config);
      info('Partial configuration saved. Run "evobrew setup" to continue.');
    } catch (saveErr) {
      warning(`Could not save partial config: ${saveErr.message}`);
    }
    
  } finally {
    closeReadline();
    
    // Ensure stdin is in a good state on exit
    try {
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }
    } catch (e) {
      // Ignore
    }
  }
  
  return true;
}

/**
 * Check if setup is needed
 */
async function needsSetup() {
  // No config directory = needs setup
  if (!configManager.configDirExists()) {
    return true;
  }
  
  // Try loading config and check if providers are configured
  const config = await configManager.loadConfigSafe();
  if (!config) {
    return true;
  }
  
  // Check if any provider is configured
  const hasProvider = config.providers && (
    (config.providers.openai?.enabled && config.providers.openai?.api_key) ||
    (config.providers.anthropic?.enabled && (config.providers.anthropic?.api_key || config.providers.anthropic?.oauth)) ||
    (config.providers.xai?.enabled && config.providers.xai?.api_key) ||
    (config.providers.ollama?.enabled) ||
    (config.providers.lmstudio?.enabled)
  );
  
  return !hasProvider;
}

module.exports = {
  setupWizard,
  needsSetup,
  getConfigStatus,
  
  // Exported for testing
  testOpenAI,
  testAnthropic,
  testXAI,
  detectOpenClaw,
  testOpenClawConnection,
  detectOllama,
  detectLMStudio
};
