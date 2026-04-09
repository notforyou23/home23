/**
 * InfrastructureAgent — Container management, service setup, environment provisioning
 *
 * Extends ExecutionBaseAgent with infrastructure capabilities:
 *  - Container tools: docker, docker-compose, podman
 *  - Environment tools: venv, nvm, conda, homebrew
 *  - Service tools: nginx, redis, postgres, mysql
 *  - Port management: check before binding, conflict resolution
 *  - Health checks: verify services are responding after startup
 *  - Dependency resolution: install and configure prerequisites
 *  - Clean teardown: always provide scripts to undo provisioning
 *
 * Tracks all provisioning in a structured manifest:
 *  - services started, ports allocated, health check results
 *  - environments provisioned, dependencies installed
 *  - generated configs, docker-compose files, teardown scripts
 *
 * Output contract:
 *   outputs/infrastructure/<agentId>/
 *     manifest.json          — Full infrastructure manifest
 *     config/                — Generated configuration files
 *     docker-compose.yml     — If containers were composed
 *     teardown.sh            — Cleanup script
 *
 * Handoff targets: dataacquisition, datapipeline, automation (with connection info)
 */

const { ExecutionBaseAgent } = require('./execution-base-agent');
const path = require('path');
const fs = require('fs').promises;

// ═══════════════════════════════════════════════════════════════════════════
// Safety: Command classification for graduated approval
// ═══════════════════════════════════════════════════════════════════════════

const SAFE_INFRA_COMMANDS = new Set([
  'echo', 'ls', 'cat', 'find', 'file', 'stat', 'which', 'whoami',
  'date', 'pwd', 'env', 'printenv', 'head', 'tail', 'wc', 'du',
  'df', 'uname', 'hostname', 'uptime', 'id', 'groups', 'type',
  'basename', 'dirname', 'realpath', 'readlink', 'md5', 'shasum',
  'diff', 'sort', 'uniq', 'grep', 'awk', 'sed', 'tr', 'cut',
  'tee', 'xargs', 'test', 'true', 'false',
  // Read-only infrastructure inspection
  'lsof', 'netstat', 'ss', 'curl', 'wget',
  'node', 'python3', 'python', 'npx',
  'pg_isready', 'redis-cli', 'mysql'
]);

// Commands that need subcommand-level safety checking
const SUBCOMMAND_CHECKED_COMMANDS = new Set([
  'docker', 'podman', 'brew', 'npm', 'pip', 'pip3', 'nvm', 'conda',
  'nginx', 'systemctl'
]);

// Safe subcommands per tool — read-only or informational operations
const SAFE_SUBCOMMANDS = {
  brew: /\b(list|info|search|config|doctor|home|leaves|outdated|deps|desc|cat|services\s+list)\b/,
  npm: /\b(ls|list|view|info|search|outdated|audit|config\s+(get|list)|pack|explain|why|fund|prefix|root|bin|help|version|test|run\b(?!\s+(?:preinstall|postinstall)))\b/,
  pip: /\b(list|show|freeze|check|config|cache\s+(list|info|dir)|inspect|index|debug|help)\b/,
  pip3: /\b(list|show|freeze|check|config|cache\s+(list|info|dir)|inspect|index|debug|help)\b/,
  nvm: /\b(ls|list|current|version|which|alias|run|exec)\b/,
  conda: /\b(list|info|search|config|env\s+list)\b/,
  nginx: /\b(-t|-T|-v|-V|status)\b/,
  systemctl: /\b(status|is-active|is-enabled|is-failed|list-units|list-unit-files|show|cat)\b/
};

// Destructive subcommands that always require approval
const DESTRUCTIVE_SUBCOMMANDS = {
  brew: /\b(uninstall|remove|cleanup|untap|autoremove)\b/,
  npm: /\b(uninstall|prune|cache\s+clean|deprecate)\b/,
  pip: /\b(uninstall)\b/,
  pip3: /\b(uninstall)\b/,
  conda: /\b(env\s+remove|remove|clean)\b/
};

const DANGEROUS_INFRA_COMMANDS = new Set([
  'kill', 'killall', 'pkill',
  'shutdown', 'reboot', 'halt', 'poweroff',
  'diskutil', 'hdiutil', 'fdisk', 'mount', 'umount',
  'chown', 'chgrp', 'passwd', 'useradd', 'userdel',
  'iptables', 'pfctl', 'networksetup',
  'csrutil', 'spctl', 'codesign'
]);

// ═══════════════════════════════════════════════════════════════════════════
// Default well-known ports to avoid
// ═══════════════════════════════════════════════════════════════════════════

const WELL_KNOWN_PORTS = new Map([
  [22, 'ssh'],
  [80, 'http'],
  [443, 'https'],
  [3000, 'dev-server'],
  [3306, 'mysql'],
  [5432, 'postgres'],
  [6379, 'redis'],
  [8080, 'http-alt'],
  [8443, 'https-alt'],
  [9090, 'prometheus'],
  [27017, 'mongodb']
]);

class InfrastructureAgent extends ExecutionBaseAgent {
  constructor(mission, config, logger, eventEmitter = null) {
    super(mission, config, logger, eventEmitter);

    // ── Infrastructure manifest ────────────────────────────────────────────
    this.infraManifest = {
      services: [],          // { name, type, port, status, connectionInfo }
      environments: [],      // { name, type, path }
      dependencies: [],      // What was installed
      teardownScript: null,  // Path to cleanup script
      healthChecks: [],      // { service, status, timestamp }
      startedAt: null,
      completedAt: null
    };

    // ── Port allocation tracking ───────────────────────────────────────────
    this._allocatedPorts = new Map(); // port -> service name

    // ── Infrastructure log (JSONL entries) ─────────────────────────────────
    this._infraLog = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Abstract method implementations
  // ═══════════════════════════════════════════════════════════════════════════

  getAgentType() {
    return 'infrastructure';
  }

  getDomainKnowledge() {
    return `## Role: Infrastructure Specialist

You provision environments, containers, and services.
Your FIRST tool call should be an action, not a plan.

## Operating Procedure
1. ASSESS what infrastructure is needed for the mission
2. CHECK existing state — running containers, installed packages, available ports
3. PROVISION — create containers, install dependencies, configure services
4. VERIFY — health checks, connectivity tests, port availability
5. DOCUMENT — write config files, compose files, teardown scripts
6. HAND OFF — report what's running and how to connect

## Tools: docker, compose, podman, venv, nvm, npm, pip, nginx, redis
## Output: config/, docker-compose.yml, teardown.sh, manifest.json`;
  }

  /**
   * Returns relevant sections of domain reference material based on mission keywords.
   * Called by runAgenticLoop when building the context message — NOT part of system prompt.
   */
  _getDomainReferenceForMission() {
    const mission = (this.mission?.description || '').toLowerCase();
    const sections = [];

    // Docker / container
    if (mission.includes('docker') || mission.includes('container') || mission.includes('compose') || mission.includes('podman')) {
      sections.push(`### Container Operations
- Docker: \`docker run -d --name svc -p HOST:CONTAINER image\`, \`docker ps\`, \`docker logs svc\`
- Compose: \`docker compose up -d\`, \`docker compose down\`, \`docker compose logs -f\`
- Podman: drop-in Docker replacement, rootless by default
- Build: \`docker build -t myimage:latest .\`
- Network: \`docker network create mynet\`
- Always health-check after starting containers
- Generate teardown.sh: \`docker stop svc && docker rm svc\``);
    }

    // Database services
    if (mission.includes('postgres') || mission.includes('mysql') || mission.includes('redis') || mission.includes('database') || mission.includes('db')) {
      sections.push(`### Database Services
- PostgreSQL: \`docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=pass postgres\`, check: \`pg_isready\`
- MySQL: \`docker run -d -p 3306:3306 -e MYSQL_ROOT_PASSWORD=pass mysql\`, check: \`mysqladmin status\`
- Redis: \`docker run -d -p 6379:6379 redis\`, check: \`redis-cli ping\` (expect PONG)
- Always check port availability first with check_port tool
- Prefer containers over bare-metal for isolation`);
    }

    // Python / Node environments
    if (mission.includes('venv') || mission.includes('python') || mission.includes('node') || mission.includes('nvm') || mission.includes('environment') || mission.includes('conda')) {
      sections.push(`### Environment Provisioning
- Python venv: \`python3 -m venv /path/to/venv\`, \`source /path/to/venv/bin/activate\`
- Conda: \`conda create -n myenv python=3.11\`, \`conda env export > environment.yml\`
- nvm: \`nvm install 20\`, \`nvm use 20\`, \`nvm alias default 20\`
- pip: \`pip install -r requirements.txt\`, \`pip freeze > requirements.txt\`
- npm: \`npm install\` (prefer local, not global)
- Always record versions: \`tool --version\` after install`);
    }

    // Nginx / web server / proxy
    if (mission.includes('nginx') || mission.includes('proxy') || mission.includes('web server') || mission.includes('reverse proxy') || mission.includes('load balance')) {
      sections.push(`### Nginx / Web Server
- Config test: \`nginx -t\`
- Start: \`nginx\` or \`brew services start nginx\`
- Reload: \`nginx -s reload\`
- Default config: /usr/local/etc/nginx/nginx.conf (macOS), /etc/nginx/nginx.conf (Linux)
- Write configs to config/ output directory — never modify system configs
- Validate configs before applying`);
    }

    // Port management (always relevant for infra)
    if (mission.includes('port') || mission.includes('service') || mission.includes('start') || mission.includes('provision')) {
      sections.push(`### Port Management
- Always check_port before binding — port conflicts are the #1 infra failure
- \`lsof -i :PORT\` — check what's using a port
- Use non-privileged ports (>1024) to avoid needing sudo
- Track allocated ports in manifest — never double-allocate
- If port in use, try PORT + 1000 or another high port`);
    }

    // Homebrew
    if (mission.includes('brew') || mission.includes('install') || mission.includes('package')) {
      sections.push(`### Package Management
- Homebrew (macOS): \`brew install pkg\`, \`brew services start/stop svc\`, \`brew services list\`
- Check before installing: \`which tool\`, \`command -v tool\`
- Prefer user-local installs: \`pip install --user\`, \`npm install\` (not global)
- Track every installation in manifest with register_dependency`);
    }

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  getToolSchema() {
    const tools = [...this.getBaseToolSchema()];

    // ── Infrastructure-specific tools ────────────────────────────────────────
    tools.push(
      {
        type: 'function',
        function: {
          name: 'check_port',
          description: 'Check if a port is available (not in use). Returns whether the port is free and what process is using it if occupied.',
          parameters: {
            type: 'object',
            properties: {
              port: {
                type: 'number',
                description: 'Port number to check (1-65535)'
              },
              host: {
                type: 'string',
                description: 'Host to check (default: localhost)'
              }
            },
            required: ['port'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'health_check',
          description: 'Check if a service is responding. Performs a health check and records the result in the infrastructure manifest.',
          parameters: {
            type: 'object',
            properties: {
              service: {
                type: 'string',
                description: 'Service name (e.g., "redis", "postgres", "nginx", "my-api")'
              },
              type: {
                type: 'string',
                enum: ['http', 'tcp', 'redis', 'postgres', 'mysql', 'command'],
                description: 'Type of health check to perform'
              },
              host: {
                type: 'string',
                description: 'Host to check (default: localhost)'
              },
              port: {
                type: 'number',
                description: 'Port to check'
              },
              path: {
                type: 'string',
                description: 'HTTP path for health check (default: /health)'
              },
              command: {
                type: 'string',
                description: 'Custom command to run for health check (type=command only)'
              },
              timeout: {
                type: 'number',
                description: 'Timeout in seconds (default: 5)'
              }
            },
            required: ['service', 'type'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'save_infra_manifest',
          description: 'Write the current infrastructure manifest to disk. Call this periodically and at the end of provisioning to persist progress.',
          parameters: {
            type: 'object',
            properties: {
              summary: {
                type: 'string',
                description: 'Optional summary text to include in the manifest'
              }
            },
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'register_service',
          description: 'Track a started service in the infrastructure manifest. Records its name, type, port, status, and connection info.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Service name (e.g., "redis-cache", "postgres-main")'
              },
              type: {
                type: 'string',
                description: 'Service type (e.g., "redis", "postgres", "nginx", "docker", "custom")'
              },
              port: {
                type: 'number',
                description: 'Port the service is listening on'
              },
              status: {
                type: 'string',
                enum: ['running', 'starting', 'stopped', 'failed', 'unknown'],
                description: 'Current service status'
              },
              connection_info: {
                type: 'object',
                description: 'Connection details for downstream agents (host, port, credentials, URL, etc.)',
                additionalProperties: true
              },
              container_id: {
                type: 'string',
                description: 'Docker/Podman container ID if applicable'
              },
              pid: {
                type: 'number',
                description: 'Process ID if applicable'
              }
            },
            required: ['name', 'type', 'status'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'register_environment',
          description: 'Track a provisioned environment (venv, conda env, nvm setup, etc.) in the manifest.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Environment name (e.g., "data-processing-venv")'
              },
              type: {
                type: 'string',
                enum: ['venv', 'conda', 'nvm', 'docker', 'other'],
                description: 'Environment type'
              },
              path: {
                type: 'string',
                description: 'Path to the environment'
              },
              packages: {
                type: 'array',
                items: { type: 'string' },
                description: 'Packages installed in the environment'
              }
            },
            required: ['name', 'type'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'register_dependency',
          description: 'Track an installed dependency in the manifest.',
          parameters: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Package/tool name'
              },
              version: {
                type: 'string',
                description: 'Installed version'
              },
              method: {
                type: 'string',
                description: 'Installation method (brew, apt, pip, npm, docker pull, etc.)'
              }
            },
            required: ['name', 'method'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'save_teardown_script',
          description: 'Generate and save a teardown script that undoes all provisioning. The script is saved to teardown.sh in the output directory.',
          parameters: {
            type: 'object',
            properties: {
              script_content: {
                type: 'string',
                description: 'Shell script content for teardown (should undo everything started)'
              }
            },
            required: ['script_content'],
            additionalProperties: false
          }
        }
      }
    );

    return tools;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  async onStart() {
    await super.onStart();

    // Create output directory structure
    const configDir = path.join(this._outputDir, 'config');
    await fs.mkdir(configDir, { recursive: true });

    // Initialize manifest timestamp
    this.infraManifest.startedAt = new Date().toISOString();

    this.logger.info('InfrastructureAgent started', {
      agentId: this.agentId,
      outputDir: this._outputDir,
      platform: process.platform,
      mission: (this.mission.description || '').substring(0, 120)
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Execute — main intelligence
  // ═══════════════════════════════════════════════════════════════════════════

  async execute() {
    this.logger.info('InfrastructureAgent executing mission', {
      agentId: this.agentId,
      mission: this.mission.description
    });

    await this.reportProgress(5, 'Initializing infrastructure agent');

    // ── Build system prompt (Layer 1 + Layer 2) ────────────────────────────
    const systemPrompt = this._buildSystemPrompt();

    // ── Execute agentic loop (Layer 3 context auto-gathered by runAgenticLoop) ──
    // Pass null for initialContext so runAgenticLoop auto-gathers pre-flight context
    // via gatherPreFlightContext() + buildContextMessage() + _getDomainReferenceForMission()
    const result = await this.runAgenticLoop(systemPrompt, null);

    // ── Finalize manifest ────────────────────────────────────────────────────
    this.infraManifest.completedAt = new Date().toISOString();
    await this._writeManifest();
    await this._writeInfraLog();

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // System Prompt Construction
  // ═══════════════════════════════════════════════════════════════════════════

  _buildSystemPrompt() {
    // Three-layer architecture: COSMO identity + agent behavioral prompt
    // Domain knowledge is NOT here — it goes in the user message via _getDomainReferenceForMission()
    const behavioralPrompt = this.getDomainKnowledge() + `

## Output Directory: ${this._outputDir}
- config/             — generated configuration files
- docker-compose.yml  — container orchestration (if used)
- teardown.sh         — cleanup script
- manifest.json       — infrastructure summary`;

    return this.buildCOSMOSystemPrompt(behavioralPrompt);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Graduated Safety Model
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Graduated approval model for infrastructure commands:
   *  - Read-only inspection (docker ps, lsof, which, etc.): auto-approve
   *  - Workspace-scoped writes (outputs/ or /tmp): auto-approve
   *  - Service start/stop within containers: mostly safe
   *  - System-wide changes: require approval
   *
   * @param {string} command — shell command to evaluate
   * @returns {boolean} true if command requires approval
   */
  requiresApproval(command) {
    if (!command || typeof command !== 'string') return true;

    const trimmed = command.trim();
    if (!trimmed) return true;

    // sudo always requires approval — check first
    if (trimmed.startsWith('sudo ') || trimmed.includes(' sudo ')) {
      return true;
    }

    // Pipe to shell requires approval — check before safe command classification
    if (/\|\s*(ba)?sh/.test(trimmed)) {
      return true;
    }

    const baseCommand = this._extractBaseCommand(trimmed);

    // Known dangerous commands require approval
    if (DANGEROUS_INFRA_COMMANDS.has(baseCommand)) {
      return true;
    }

    // Non-destructive commands are safe
    if (SAFE_INFRA_COMMANDS.has(baseCommand)) {
      return false;
    }

    // Commands that need subcommand-level checking
    if (SUBCOMMAND_CHECKED_COMMANDS.has(baseCommand)) {
      // Docker/podman have their own dedicated checker
      if (baseCommand === 'docker' || baseCommand === 'podman') {
        return this._requiresDockerApproval(trimmed);
      }
      return this._requiresSubcommandApproval(baseCommand, trimmed);
    }

    // Workspace-scoped writes are safe
    if (this._isWorkspaceScoped(trimmed)) {
      return false;
    }

    // Default: require approval for unknown commands
    return true;
  }

  /**
   * Check if a docker/podman command needs approval.
   * Read-only subcommands (ps, images, inspect, logs) are safe.
   * Write subcommands (run, build, rm, rmi) need more thought but are
   * generally safe in containerized contexts.
   */
  _requiresDockerApproval(command) {
    const safeSubcommands = /\b(ps|images|inspect|logs|info|version|network\s+ls|volume\s+ls|compose\s+ps|compose\s+logs|compose\s+config)\b/;
    if (safeSubcommands.test(command)) {
      return false;
    }

    // Container lifecycle commands are acceptable for infrastructure agent
    const infraSubcommands = /\b(run|start|stop|rm|build|pull|compose\s+up|compose\s+down|compose\s+build|network\s+create|volume\s+create)\b/;
    if (infraSubcommands.test(command)) {
      return false;
    }

    // System prune and other potentially destructive ops need approval
    return true;
  }

  /**
   * Check if a subcommand-checked tool (brew, npm, pip, etc.) needs approval.
   * Safe subcommands (list, info, search, etc.) are auto-approved.
   * Destructive subcommands (uninstall, prune, etc.) always require approval.
   * Other subcommands (install, update, etc.) are allowed for infrastructure agent.
   *
   * @param {string} baseCommand — the tool name (e.g. 'brew', 'npm')
   * @param {string} fullCommand — the full command string
   * @returns {boolean} true if command requires approval
   */
  _requiresSubcommandApproval(baseCommand, fullCommand) {
    // Destructive subcommands always require approval
    const destructive = DESTRUCTIVE_SUBCOMMANDS[baseCommand];
    if (destructive && destructive.test(fullCommand)) {
      return true;
    }

    // Safe (read-only) subcommands are auto-approved
    const safe = SAFE_SUBCOMMANDS[baseCommand];
    if (safe && safe.test(fullCommand)) {
      return false;
    }

    // Other subcommands (install, update, upgrade, etc.) are allowed
    // for infrastructure agent as part of its provisioning role
    return false;
  }

  /**
   * Extract the base command name from a shell command string.
   */
  _extractBaseCommand(command) {
    let cleaned = command.replace(/^(\w+=\S+\s+)+/, '');
    const firstToken = cleaned.split(/\s+/)[0];
    const baseName = firstToken.includes('/') ? firstToken.split('/').pop() : firstToken;
    return baseName || '';
  }

  /**
   * Check if a command only writes within workspace-scoped paths.
   */
  _isWorkspaceScoped(command) {
    const outputDir = this._outputDir || '';

    const safePathPatterns = [
      />\s*(?:\/tmp\/|outputs\/)/,
      /\btee\s+(?:\/tmp\/|outputs\/)/,
      /\bcp\b.*\s(?:\/tmp\/|outputs\/)/,
      /\bmv\b.*\s(?:\/tmp\/|outputs\/)/,
      /\bmkdir\b.*(?:\/tmp\/|outputs\/)/,
      /\btouch\b.*(?:\/tmp\/|outputs\/)/,
    ];

    if (outputDir) {
      const escapedDir = outputDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      safePathPatterns.push(new RegExp(`>\\s*${escapedDir}`));
      safePathPatterns.push(new RegExp(`\\bcp\\b.*\\s${escapedDir}`));
      safePathPatterns.push(new RegExp(`\\bmv\\b.*\\s${escapedDir}`));
    }

    return safePathPatterns.some(p => p.test(command));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool Dispatch — extends parent with infrastructure-specific tools
  // ═══════════════════════════════════════════════════════════════════════════

  async dispatchToolCall(name, args) {
    switch (name) {
      case 'check_port':
        return this._checkPort(args);

      case 'health_check':
        return this._healthCheck(args);

      case 'save_infra_manifest':
        return this._saveInfraManifest(args);

      case 'register_service':
        return this._registerService(args);

      case 'register_environment':
        return this._registerEnvironment(args);

      case 'register_dependency':
        return this._registerDependency(args);

      case 'save_teardown_script':
        return this._saveTeardownScript(args);

      // Delegate to parent for base execution primitives
      default:
        return super.dispatchToolCall(name, args);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool Implementations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a port is available (not in use).
   */
  async _checkPort(args) {
    const { port, host } = args;
    const targetHost = host || 'localhost';

    if (!port || port < 1 || port > 65535) {
      return { error: `Invalid port number: ${port}. Must be between 1 and 65535.` };
    }

    try {
      // Use lsof to check if port is in use
      const result = await this.executeBash(
        `lsof -i :${port} -P -n 2>/dev/null || true`,
        { timeout: 5000 }
      );

      const isInUse = result.stdout.trim().length > 0 &&
                      result.stdout.includes('LISTEN');

      let processInfo = null;
      if (isInUse) {
        // Parse lsof output for process info
        const lines = result.stdout.trim().split('\n');
        if (lines.length > 1) {
          const parts = lines[1].split(/\s+/);
          processInfo = {
            command: parts[0] || 'unknown',
            pid: parts[1] || 'unknown',
            user: parts[2] || 'unknown'
          };
        }
      }

      const wellKnown = WELL_KNOWN_PORTS.get(port);

      this._logInfraEntry('check_port', {
        port,
        host: targetHost,
        available: !isInUse,
        wellKnown: wellKnown || null
      });

      return {
        port,
        host: targetHost,
        available: !isInUse,
        inUse: isInUse,
        processInfo,
        wellKnownService: wellKnown || null,
        suggestion: isInUse
          ? `Port ${port} is in use. Try port ${port + 1000} or another available port.`
          : `Port ${port} is available.`
      };

    } catch (err) {
      return {
        port,
        host: targetHost,
        available: true, // Assume available on error
        error: `Port check failed: ${err.message}`,
        note: 'Assuming port is available since check failed'
      };
    }
  }

  /**
   * Perform a health check on a service.
   */
  async _healthCheck(args) {
    const { service, type, host, port, path: httpPath, command, timeout } = args;
    const targetHost = host || 'localhost';
    const timeoutSec = timeout || 5;

    let checkResult;

    try {
      switch (type) {
        case 'http': {
          const url = `http://${targetHost}:${port || 80}${httpPath || '/health'}`;
          const result = await this.executeBash(
            `curl -s -o /dev/null -w "%{http_code}" --max-time ${timeoutSec} "${url}"`,
            { timeout: (timeoutSec + 2) * 1000 }
          );
          const statusCode = parseInt(result.stdout.trim(), 10);
          checkResult = {
            healthy: statusCode >= 200 && statusCode < 400,
            statusCode,
            url
          };
          break;
        }

        case 'tcp': {
          const result = await this.executeBash(
            `nc -z -w ${timeoutSec} ${targetHost} ${port || 80} 2>&1 && echo "OK" || echo "FAIL"`,
            { timeout: (timeoutSec + 2) * 1000 }
          );
          checkResult = {
            healthy: result.stdout.includes('OK') || result.exitCode === 0,
            port: port || 80
          };
          break;
        }

        case 'redis': {
          const portArg = port ? `-p ${port}` : '';
          const hostArg = targetHost !== 'localhost' ? `-h ${targetHost}` : '';
          const result = await this.executeBash(
            `redis-cli ${hostArg} ${portArg} ping 2>&1`,
            { timeout: (timeoutSec + 2) * 1000 }
          );
          checkResult = {
            healthy: result.stdout.trim() === 'PONG',
            response: result.stdout.trim(),
            port: port || 6379
          };
          break;
        }

        case 'postgres': {
          const portArg = port ? `-p ${port}` : '';
          const hostArg = `-h ${targetHost}`;
          const result = await this.executeBash(
            `pg_isready ${hostArg} ${portArg} 2>&1`,
            { timeout: (timeoutSec + 2) * 1000 }
          );
          checkResult = {
            healthy: result.exitCode === 0,
            response: result.stdout.trim(),
            port: port || 5432
          };
          break;
        }

        case 'mysql': {
          const portArg = port ? `-P ${port}` : '';
          const hostArg = `-h ${targetHost}`;
          const result = await this.executeBash(
            `mysqladmin ${hostArg} ${portArg} status 2>&1`,
            { timeout: (timeoutSec + 2) * 1000 }
          );
          checkResult = {
            healthy: result.exitCode === 0,
            response: result.stdout.trim().substring(0, 200),
            port: port || 3306
          };
          break;
        }

        case 'command': {
          if (!command) {
            return { error: 'Custom health check requires a "command" parameter' };
          }
          const result = await this.executeBash(command, {
            timeout: (timeoutSec + 2) * 1000
          });
          checkResult = {
            healthy: result.exitCode === 0,
            stdout: result.stdout.trim().substring(0, 500),
            stderr: result.stderr.trim().substring(0, 200),
            exitCode: result.exitCode
          };
          break;
        }

        default:
          return { error: `Unknown health check type: ${type}` };
      }

      // Record in manifest
      const healthEntry = {
        service,
        type,
        status: checkResult.healthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        details: checkResult
      };
      this.infraManifest.healthChecks.push(healthEntry);

      // Update service status if registered
      const existingService = this.infraManifest.services.find(s => s.name === service);
      if (existingService) {
        existingService.status = checkResult.healthy ? 'running' : 'unhealthy';
        existingService.lastHealthCheck = healthEntry.timestamp;
      }

      this._logInfraEntry('health_check', {
        service,
        type,
        healthy: checkResult.healthy
      });

      return {
        success: true,
        service,
        ...checkResult
      };

    } catch (err) {
      const failEntry = {
        service,
        type,
        status: 'error',
        timestamp: new Date().toISOString(),
        error: err.message
      };
      this.infraManifest.healthChecks.push(failEntry);

      this._logInfraEntry('health_check', {
        service,
        type,
        healthy: false,
        error: err.message
      });

      return {
        success: false,
        service,
        healthy: false,
        error: err.message
      };
    }
  }

  /**
   * Write the infrastructure manifest to disk.
   */
  async _saveInfraManifest(args) {
    const summary = args?.summary || null;

    try {
      await this._writeManifest(summary);
      return {
        success: true,
        path: path.join(this._outputDir, 'manifest.json'),
        stats: {
          services: this.infraManifest.services.length,
          environments: this.infraManifest.environments.length,
          dependencies: this.infraManifest.dependencies.length,
          healthChecks: this.infraManifest.healthChecks.length,
          hasTeardown: this.infraManifest.teardownScript !== null
        }
      };
    } catch (err) {
      return { error: `Failed to save manifest: ${err.message}` };
    }
  }

  /**
   * Register a service in the manifest.
   */
  _registerService(args) {
    const entry = {
      name: args.name,
      type: args.type,
      port: args.port || null,
      status: args.status,
      connectionInfo: args.connection_info || {},
      containerId: args.container_id || null,
      pid: args.pid || null,
      registeredAt: new Date().toISOString()
    };

    // Check for duplicate service names
    const existingIndex = this.infraManifest.services.findIndex(s => s.name === args.name);
    if (existingIndex >= 0) {
      // Update existing service
      this.infraManifest.services[existingIndex] = entry;
    } else {
      this.infraManifest.services.push(entry);
    }

    // Track port allocation
    if (args.port) {
      this._allocatedPorts.set(args.port, args.name);
    }

    this._logInfraEntry('register_service', {
      name: args.name,
      type: args.type,
      port: args.port,
      status: args.status
    });

    return {
      success: true,
      service: entry,
      totalServices: this.infraManifest.services.length,
      allocatedPorts: Array.from(this._allocatedPorts.entries()).map(([p, s]) => ({ port: p, service: s }))
    };
  }

  /**
   * Register a provisioned environment in the manifest.
   */
  _registerEnvironment(args) {
    const entry = {
      name: args.name,
      type: args.type,
      path: args.path || null,
      packages: args.packages || [],
      registeredAt: new Date().toISOString()
    };

    this.infraManifest.environments.push(entry);

    this._logInfraEntry('register_environment', {
      name: args.name,
      type: args.type,
      packages: (args.packages || []).length
    });

    return {
      success: true,
      environment: entry,
      totalEnvironments: this.infraManifest.environments.length
    };
  }

  /**
   * Register an installed dependency in the manifest.
   */
  _registerDependency(args) {
    const entry = {
      name: args.name,
      version: args.version || null,
      method: args.method,
      installedAt: new Date().toISOString()
    };

    this.infraManifest.dependencies.push(entry);

    this._logInfraEntry('register_dependency', {
      name: args.name,
      version: args.version,
      method: args.method
    });

    return {
      success: true,
      dependency: entry,
      totalDependencies: this.infraManifest.dependencies.length
    };
  }

  /**
   * Generate and save a teardown script.
   */
  async _saveTeardownScript(args) {
    if (!args.script_content || typeof args.script_content !== 'string') {
      return { error: 'script_content is required and must be a string' };
    }

    const teardownPath = path.join(this._outputDir, 'teardown.sh');

    try {
      // Ensure script starts with shebang
      let content = args.script_content;
      if (!content.startsWith('#!')) {
        content = '#!/bin/bash\nset -e\n\n' + content;
      }

      await this.writeFile(teardownPath, content);

      // Make executable
      await this.executeBash(`chmod +x "${teardownPath}"`, { timeout: 5000 });

      // Record in manifest
      this.infraManifest.teardownScript = teardownPath;

      this._logInfraEntry('save_teardown_script', {
        path: teardownPath,
        size: Buffer.byteLength(content, 'utf8')
      });

      return {
        success: true,
        path: teardownPath,
        note: 'Run this script to tear down all provisioned infrastructure'
      };

    } catch (err) {
      return { error: `Failed to save teardown script: ${err.message}` };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Progress Tracking — extend with infrastructure-specific ops
  // ═══════════════════════════════════════════════════════════════════════════

  _isProgressOperation(toolName) {
    const infraProgressOps = new Set([
      'check_port',
      'health_check',
      'save_infra_manifest',
      'register_service',
      'register_environment',
      'register_dependency',
      'save_teardown_script'
    ]);

    return infraProgressOps.has(toolName) || super._isProgressOperation(toolName);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Accomplishment Assessment
  // ═══════════════════════════════════════════════════════════════════════════

  assessAccomplishment(executeResult, results) {
    const manifest = this.infraManifest;

    // Infrastructure succeeds if services were started OR environments provisioned
    const servicesStarted = manifest.services.filter(s => s.status === 'running').length;
    const environmentsProvisioned = manifest.environments.length;
    const dependenciesInstalled = manifest.dependencies.length;
    const healthChecksPassed = manifest.healthChecks.filter(h => h.status === 'healthy').length;
    const hasTeardown = manifest.teardownScript !== null;

    // Also check base metrics (files written, commands run)
    const baseAssessment = super.assessAccomplishment(executeResult, results);

    const hasInfraWork = servicesStarted > 0 ||
                         environmentsProvisioned > 0 ||
                         dependenciesInstalled > 0;

    const accomplished = hasInfraWork || baseAssessment.accomplished;

    return {
      accomplished,
      reason: accomplished ? null : 'No infrastructure provisioned (0 services, 0 environments, 0 dependencies)',
      metrics: {
        servicesStarted,
        totalServices: manifest.services.length,
        environmentsProvisioned,
        dependenciesInstalled,
        healthChecksPassed,
        healthChecksTotal: manifest.healthChecks.length,
        hasTeardown,
        ...baseAssessment.metrics
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Handoff
  // ═══════════════════════════════════════════════════════════════════════════

  generateHandoffSpec() {
    const manifest = this.infraManifest;

    // No handoff if nothing was provisioned
    const hasInfra = manifest.services.length > 0 ||
                     manifest.environments.length > 0;

    if (!hasInfra) {
      return null;
    }

    // Build connection info summary for downstream agents
    const connectionSummary = {};
    for (const service of manifest.services) {
      if (service.status === 'running' || service.status === 'starting') {
        connectionSummary[service.name] = {
          type: service.type,
          port: service.port,
          ...service.connectionInfo
        };
      }
    }

    // Build top findings
    const topFindings = [];
    const runningServices = manifest.services.filter(s => s.status === 'running');
    if (runningServices.length > 0) {
      topFindings.push(`Started ${runningServices.length} service(s): ${runningServices.map(s => s.name).join(', ')}`);
    }
    if (manifest.environments.length > 0) {
      topFindings.push(`Provisioned ${manifest.environments.length} environment(s): ${manifest.environments.map(e => e.name).join(', ')}`);
    }
    if (manifest.dependencies.length > 0) {
      topFindings.push(`Installed ${manifest.dependencies.length} dependency/ies`);
    }
    const passedChecks = manifest.healthChecks.filter(h => h.status === 'healthy');
    const failedChecks = manifest.healthChecks.filter(h => h.status !== 'healthy');
    if (passedChecks.length > 0) {
      topFindings.push(`${passedChecks.length} health check(s) passed`);
    }
    if (failedChecks.length > 0) {
      topFindings.push(`${failedChecks.length} health check(s) failed or errored`);
    }
    if (manifest.teardownScript) {
      topFindings.push(`Teardown script: ${manifest.teardownScript}`);
    }

    // Determine best handoff target based on what services were started
    let targetAgentType = 'automation'; // default
    const serviceTypes = manifest.services.map(s => s.type.toLowerCase());

    // If we set up databases, hand off to data pipeline
    if (serviceTypes.some(t => ['postgres', 'mysql', 'sqlite', 'mongodb', 'redis'].includes(t))) {
      targetAgentType = 'datapipeline';
    }
    // If we set up web/API services, data acquisition may want them
    if (serviceTypes.some(t => ['nginx', 'http', 'api', 'web'].includes(t))) {
      targetAgentType = 'dataacquisition';
    }

    // Allow mission metadata to override target
    if (this.mission.metadata?.handoffTarget) {
      targetAgentType = this.mission.metadata.handoffTarget;
    }

    return {
      targetAgentType,
      reason: 'Infrastructure provisioned — services and environments ready for use',
      artifactRefs: [this._outputDir],
      context: {
        sourceAgent: this.agentId,
        sourceType: 'infrastructure',
        outputDir: this._outputDir,
        connectionSummary,
        topFindings,
        teardownScript: manifest.teardownScript,
        manifest: {
          services: manifest.services.length,
          runningServices: runningServices.length,
          environments: manifest.environments.length,
          dependencies: manifest.dependencies.length,
          healthChecksPassed: passedChecks.length,
          healthChecksFailed: failedChecks.length
        }
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Internal Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Log an infrastructure entry (appended to infra-log.jsonl on disk at finalization).
   */
  _logInfraEntry(operation, details) {
    this._infraLog.push({
      timestamp: new Date().toISOString(),
      operation,
      ...details
    });
  }

  /**
   * Write the manifest.json file.
   */
  async _writeManifest(summary = null) {
    if (!this._outputDir) return;

    const manifest = {
      agentId: this.agentId,
      agentType: 'infrastructure',
      mission: this.mission.description,
      goalId: this.mission.goalId,
      ...this.infraManifest,
      allocatedPorts: Array.from(this._allocatedPorts.entries()).map(([p, s]) => ({ port: p, service: s })),
      summary: summary || null
    };

    const manifestPath = path.join(this._outputDir, 'manifest.json');
    try {
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      this.logger.debug('Infrastructure manifest written', { path: manifestPath });
    } catch (err) {
      this.logger.warn('Failed to write infrastructure manifest', { error: err.message });
    }
  }

  /**
   * Write the infra-log.jsonl file.
   */
  async _writeInfraLog() {
    if (!this._outputDir) return;
    if (this._infraLog.length === 0) return;

    const logPath = path.join(this._outputDir, 'infra-log.jsonl');
    try {
      const lines = this._infraLog.map(e => JSON.stringify(e)).join('\n') + '\n';
      await fs.writeFile(logPath, lines, 'utf8');
      this.logger.debug('Infrastructure log written', {
        path: logPath,
        entries: this._infraLog.length
      });
    } catch (err) {
      this.logger.warn('Failed to write infrastructure log', { error: err.message });
    }
  }
}

module.exports = { InfrastructureAgent };
