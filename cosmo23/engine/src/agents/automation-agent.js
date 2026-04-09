/**
 * AutomationAgent — General-purpose OS automation agent
 *
 * Extends ExecutionBaseAgent with macOS-native automation capabilities:
 *  - osascript / AppleScript
 *  - File management (rsync, tar, zip, find, rename, exiftool, imagemagick)
 *  - Process management (screen, tmux, supervisord, launchd, cron)
 *  - GUI automation (mouse, keyboard, screenshot) on macOS
 *
 * Safety: graduated approval model — non-destructive ops auto-approve,
 * workspace-scoped writes pass, system-wide/destructive ops require approval.
 *
 * Spiritual successor to ExperimentalAgent with better safety boundaries.
 */

const { ExecutionBaseAgent } = require('./execution-base-agent');
const path = require('path');
const fs = require('fs').promises;

// ═══════════════════════════════════════════════════════════════════════════
// Safety: Command classification for graduated approval
// ═══════════════════════════════════════════════════════════════════════════

const SAFE_READ_COMMANDS = new Set([
  'echo', 'ls', 'cat', 'find', 'file', 'stat', 'which', 'whoami',
  'date', 'pwd', 'env', 'printenv', 'head', 'tail', 'wc', 'du',
  'df', 'uname', 'hostname', 'uptime', 'id', 'groups', 'type',
  'basename', 'dirname', 'realpath', 'readlink', 'md5', 'shasum',
  'diff', 'sort', 'uniq', 'grep', 'awk', 'sed', 'tr', 'cut',
  'tee', 'xargs', 'test', 'true', 'false'
]);

const DANGEROUS_COMMANDS = new Set([
  'kill', 'killall', 'pkill', 'launchctl', 'systemctl',
  'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'port',
  'shutdown', 'reboot', 'halt', 'poweroff',
  'diskutil', 'hdiutil', 'fdisk', 'mount', 'umount',
  'chown', 'chgrp', 'passwd', 'useradd', 'userdel',
  'iptables', 'pfctl', 'networksetup',
  'defaults', 'scutil', 'dscl',
  'csrutil', 'spctl', 'codesign'
]);

class AutomationAgent extends ExecutionBaseAgent {
  constructor(mission, config, logger, eventEmitter = null) {
    super(mission, config, logger, eventEmitter);

    // GUI controllers — lazily initialized in onStart() on macOS only
    this._mouseController = null;
    this._keyboardController = null;
    this._screenshotService = null;
    this._guiAvailable = false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Abstract method implementations
  // ═══════════════════════════════════════════════════════════════════════

  getAgentType() {
    return 'automation';
  }

  getDomainKnowledge() {
    return `## Role: Automation Specialist

You automate file operations, process management, and OS tasks.
Your FIRST tool call should be an action, not a plan.

## Operating Procedure
1. UNDERSTAND the automation goal — what files, processes, or operations
2. CHECK current state — existing files, running processes, permissions
3. EXECUTE operations — file moves, renames, conversions, batch processing
4. VERIFY results — confirm files exist, processes running, outputs correct
5. LOG operations to operations.jsonl for audit trail

## Safety: Non-destructive ops are free. Destructive ops require confirmation.
## Tools: find, rsync, tar, cron, launchd, osascript (macOS)
## Output: artifacts/, operations.jsonl, manifest.json`;
  }

  /**
   * Returns relevant sections of domain reference material based on mission keywords.
   * Called by runAgenticLoop when building the context message — NOT part of system prompt.
   */
  _getDomainReferenceForMission() {
    const mission = (this.mission?.description || '').toLowerCase();
    const platform = process.platform;
    const isMac = platform === 'darwin';
    const sections = [];

    // File management
    if (mission.includes('file') || mission.includes('move') || mission.includes('rename') || mission.includes('copy') ||
        mission.includes('organize') || mission.includes('sort') || mission.includes('clean')) {
      sections.push(`### File Management
- rsync: \`rsync -av --dry-run source/ dest/\` first, then remove --dry-run
- tar: \`tar czf archive.tar.gz dir/\`, \`tar xzf archive.tar.gz\`
- find: \`find . -name "*.log" -mtime +30 -type f\`, \`find . -empty -type d\`
- exiftool: \`exiftool -DateTimeOriginal image.jpg\` — read/write file metadata
- imagemagick: \`convert input.png -resize 50% output.png\`
- Idempotent: \`[ -f target ] || cp source target\`
- Dry-run first for destructive ops, backup before modifying`);
    }

    // macOS automation
    if (isMac && (mission.includes('macos') || mission.includes('applescript') || mission.includes('app') ||
                  mission.includes('finder') || mission.includes('gui') || mission.includes('screenshot'))) {
      sections.push(`### macOS Automation
- osascript: \`osascript -e 'tell application "Finder" to get name of every file in folder "Desktop" of home'\`
- open: \`open -a "Safari" https://example.com\`, \`open .\` (open in Finder)
- pbcopy/pbpaste: clipboard read/write
- automator: run Automator workflows
${this._guiAvailable ? '- GUI: mouse, keyboard, and screenshot capabilities available' : ''}`);
    }

    // Process management
    if (mission.includes('process') || mission.includes('cron') || mission.includes('schedule') ||
        mission.includes('daemon') || mission.includes('service') || mission.includes('launchd') || mission.includes('tmux')) {
      sections.push(`### Process Management
- tmux: \`tmux new-session -d -s name "command"\`, \`tmux list-sessions\`
- screen: terminal multiplexer alternative
- launchd (macOS): \`launchctl list\` (safe), load/unload (requires approval)
- cron: \`crontab -l\` (safe), \`crontab -e\` (requires approval)
- Progressive disclosure: read-only recon first, then plan, then execute`);
    }

    // Image / media processing
    if (mission.includes('image') || mission.includes('photo') || mission.includes('video') ||
        mission.includes('resize') || mission.includes('convert') || mission.includes('batch')) {
      sections.push(`### Image/Media Processing
- imagemagick: \`convert input.png -resize 50% output.png\`, \`identify image.jpg\`
- mogrify: batch processing — \`mogrify -resize 800x600 *.jpg\`
- exiftool: \`exiftool -DateTimeOriginal image.jpg\`, batch metadata ops
- ffmpeg: video/audio conversion if available`);
    }

    // Archive / backup
    if (mission.includes('archive') || mission.includes('backup') || mission.includes('zip') || mission.includes('compress')) {
      sections.push(`### Archive / Backup
- tar: \`tar czf archive.tar.gz directory/\` (create), \`tar xzf archive.tar.gz\` (extract)
- zip/unzip: \`zip -r archive.zip directory/\`, \`unzip archive.zip\`
- rsync: \`rsync -av --progress source/ dest/\` for incremental backup
- Always create backup before reorganizing: \`tar czf backup.tar.gz directory/\``);
    }

    return sections.length > 0 ? sections.join('\n\n') : null;
  }

  getToolSchema() {
    const tools = [...this.getBaseToolSchema()];

    // macOS-specific tools
    tools.push(
      {
        type: 'function',
        function: {
          name: 'macos_open_app',
          description: 'Open a macOS application by name (e.g., "Safari", "Finder", "Terminal")',
          parameters: {
            type: 'object',
            properties: {
              app: { type: 'string', description: 'Application name to open' }
            },
            required: ['app'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'macos_run_applescript',
          description: 'Run an AppleScript snippet via osascript. Returns stdout output.',
          parameters: {
            type: 'object',
            properties: {
              script: { type: 'string', description: 'AppleScript code to execute' }
            },
            required: ['script'],
            additionalProperties: false
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'take_screenshot',
          description: 'Capture a screenshot of the current screen. Returns the file path.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false
          }
        }
      }
    );

    // GUI tools (only if controllers are available)
    if (this._guiAvailable) {
      tools.push(
        {
          type: 'function',
          function: {
            name: 'mouse_move',
            description: 'Move the mouse cursor to a screen coordinate.',
            parameters: {
              type: 'object',
              properties: {
                x: { type: 'number', description: 'X coordinate in pixels' },
                y: { type: 'number', description: 'Y coordinate in pixels' }
              },
              required: ['x', 'y'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'mouse_click',
            description: 'Click a mouse button at the current cursor position.',
            parameters: {
              type: 'object',
              properties: {
                button: {
                  type: 'string',
                  enum: ['left', 'right', 'middle'],
                  description: 'Which mouse button to click'
                },
                double: {
                  type: 'boolean',
                  description: 'Whether to double-click instead of single click'
                }
              },
              required: ['button'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'keyboard_type',
            description: 'Type text using the keyboard.',
            parameters: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'Text to type' }
              },
              required: ['text'],
              additionalProperties: false
            }
          }
        },
        {
          type: 'function',
          function: {
            name: 'keyboard_press',
            description: 'Press a key or key combination (e.g., "enter", "command+v").',
            parameters: {
              type: 'object',
              properties: {
                keys: { type: 'string', description: 'Key or combo to press (use + as separator)' }
              },
              required: ['keys'],
              additionalProperties: false
            }
          }
        }
      );
    }

    return tools;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  async onStart() {
    await super.onStart();

    // Initialize GUI controllers on macOS only
    if (process.platform === 'darwin') {
      try {
        const { MouseController } = require('./execution/mouse-controller');
        const { KeyboardController } = require('./execution/keyboard-controller');
        const { ScreenshotService } = require('./execution/screenshot-service');

        this._mouseController = new MouseController(this.logger);
        this._keyboardController = new KeyboardController(this.logger);
        this._screenshotService = new ScreenshotService(this.logger, this.config);

        await this._mouseController.initialize();
        await this._keyboardController.initialize();
        await this._screenshotService.initialize();

        this._guiAvailable = true;
        this.logger.info('AutomationAgent GUI controllers initialized', {
          mouse: this._mouseController.getBackend(),
          keyboard: this._keyboardController.getBackend()
        });
      } catch (err) {
        this.logger.warn('GUI controllers unavailable — running without GUI automation', {
          error: err.message
        });
        this._guiAvailable = false;
      }
    }

    // Create output structure
    const artifactsDir = path.join(this._outputDir, 'artifacts');
    await fs.mkdir(artifactsDir, { recursive: true });

    this.logger.info('AutomationAgent started', {
      agentId: this.agentId,
      outputDir: this._outputDir,
      guiAvailable: this._guiAvailable,
      platform: process.platform
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Execute
  // ═══════════════════════════════════════════════════════════════════════

  async execute() {
    this.logger.info('AutomationAgent executing mission', {
      agentId: this.agentId,
      mission: this.mission.description
    });

    await this.reportProgress(5, 'Initializing automation agent');

    // ── Build system prompt (Layer 1 + Layer 2) ────────────────────────────
    const systemPrompt = this._buildSystemPrompt();

    // ── Execute agentic loop (Layer 3 context auto-gathered by runAgenticLoop) ──
    // Pass null for initialContext so runAgenticLoop auto-gathers pre-flight context
    // via gatherPreFlightContext() + buildContextMessage() + _getDomainReferenceForMission()
    const result = await this.runAgenticLoop(systemPrompt, null);

    // Write manifest
    await this._writeManifest(result);

    return result;
  }

  _buildSystemPrompt() {
    // Three-layer architecture: COSMO identity + agent behavioral prompt
    // Domain knowledge is NOT here — it goes in the user message via _getDomainReferenceForMission()
    const behavioralPrompt = this.getDomainKnowledge() + `

## Output Directory: ${this._outputDir}
- artifacts/        — files produced or organized
- operations.jsonl  — audit trail
- manifest.json     — summary of what was done`;

    return this.buildCOSMOSystemPrompt(behavioralPrompt);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Graduated Safety Model
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Graduated approval model:
   *  - Non-destructive reads (echo, ls, cat, find, etc.): auto-approve
   *  - Workspace-scoped writes (outputs/ or /tmp): auto-approve
   *  - Destructive or system-wide operations: require approval
   *
   * @param {string} command — shell command to evaluate
   * @returns {boolean} true if command requires approval
   */
  requiresApproval(command) {
    if (!command || typeof command !== 'string') return true;

    const trimmed = command.trim();
    if (!trimmed) return true;

    // Extract the base command (first word, ignoring env vars and leading paths)
    const baseCommand = this._extractBaseCommand(trimmed);

    // Non-destructive commands are always safe
    if (SAFE_READ_COMMANDS.has(baseCommand)) {
      return false;
    }

    // Workspace-scoped writes are safe
    if (this._isWorkspaceScoped(trimmed)) {
      return false;
    }

    // Known dangerous commands require approval
    if (DANGEROUS_COMMANDS.has(baseCommand)) {
      return true;
    }

    // sudo always requires approval
    if (trimmed.startsWith('sudo ') || trimmed.includes(' sudo ')) {
      return true;
    }

    // Pipe to shell requires approval
    if (/\|\s*(ba)?sh/.test(trimmed)) {
      return true;
    }

    // Default: require approval for unknown commands
    return true;
  }

  /**
   * Extract the base command name from a shell command string.
   */
  _extractBaseCommand(command) {
    // Strip leading env var assignments (FOO=bar cmd)
    let cleaned = command.replace(/^(\w+=\S+\s+)+/, '');
    // Get first token (the command itself)
    const firstToken = cleaned.split(/\s+/)[0];
    // If the command is an absolute path (e.g., /usr/bin/stat), extract basename
    const baseName = firstToken.includes('/') ? firstToken.split('/').pop() : firstToken;
    return baseName || '';
  }

  /**
   * Check if a command only writes within workspace-scoped paths.
   */
  _isWorkspaceScoped(command) {
    // If the command only references outputs/ or /tmp paths, it's workspace-scoped
    const outputDir = this._outputDir || '';

    // Check for common write patterns directed at safe locations
    const safePathPatterns = [
      />\s*(?:\/tmp\/|outputs\/)/,           // redirect to /tmp or outputs/
      /\btee\s+(?:\/tmp\/|outputs\/)/,        // tee to safe paths
      /\bcp\b.*\s(?:\/tmp\/|outputs\/)/,      // cp to safe paths
      /\bmv\b.*\s(?:\/tmp\/|outputs\/)/,      // mv to safe paths
      /\bmkdir\b.*(?:\/tmp\/|outputs\/)/,     // mkdir in safe paths
      /\btouch\b.*(?:\/tmp\/|outputs\/)/,     // touch in safe paths
    ];

    if (outputDir) {
      const escapedDir = outputDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      safePathPatterns.push(new RegExp(`>\\s*${escapedDir}`));
      safePathPatterns.push(new RegExp(`\\bcp\\b.*\\s${escapedDir}`));
      safePathPatterns.push(new RegExp(`\\bmv\\b.*\\s${escapedDir}`));
    }

    return safePathPatterns.some(p => p.test(command));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Graduated Safety — wire requiresApproval into executeBash
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Override executeBash to enforce the graduated approval model.
   * Commands that requiresApproval() flags as dangerous are blocked
   * unless pre-approved via _checkApproval().
   */
  async executeBash(command, options = {}) {
    if (this.requiresApproval(command)) {
      const approved = await this._checkApproval(command);
      if (!approved) {
        return {
          stdout: '',
          stderr: 'Operation requires approval — command blocked by graduated safety model',
          exitCode: 1,
          blocked: true,
          requiresApproval: true
        };
      }
    }
    return super.executeBash(command, options);
  }

  /**
   * Check if a command has been pre-approved.
   * In the current implementation, approval is granted via mission metadata
   * (e.g., mission.metadata.approvedCommands) or config flags.
   *
   * @param {string} command — the command to check
   * @returns {Promise<boolean>} true if approved
   */
  async _checkApproval(command) {
    // Check mission-level approval list
    const approvedPatterns = this.mission?.metadata?.approvedCommands || [];
    if (approvedPatterns.length > 0) {
      for (const pattern of approvedPatterns) {
        if (typeof pattern === 'string' && command.includes(pattern)) {
          return true;
        }
        if (pattern instanceof RegExp && pattern.test(command)) {
          return true;
        }
      }
    }

    // Check config-level auto-approve flag
    if (this.config?.execution?.autoApproveAll) {
      return true;
    }

    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Tool Dispatch — extends parent with automation-specific tools
  // ═══════════════════════════════════════════════════════════════════════

  async dispatchToolCall(name, args) {
    switch (name) {
      case 'macos_open_app': {
        if (process.platform !== 'darwin') {
          return { error: 'macos_open_app is only available on macOS' };
        }
        const result = await this.executeBash(`open -a "${args.app}"`);
        return {
          success: result.exitCode === 0,
          app: args.app,
          error: result.exitCode !== 0 ? result.stderr : undefined
        };
      }

      case 'macos_run_applescript': {
        if (process.platform !== 'darwin') {
          return { error: 'macos_run_applescript is only available on macOS' };
        }
        // Write script to temp file to avoid shell escaping issues
        const tmpScript = path.join(
          require('os').tmpdir(),
          `cosmo-applescript-${Date.now()}.scpt`
        );
        await fs.writeFile(tmpScript, args.script, 'utf8');
        const result = await this.executeBash(`osascript "${tmpScript}"`, { timeout: 30000 });
        await fs.unlink(tmpScript).catch(() => {});
        return {
          success: result.exitCode === 0,
          output: result.stdout,
          error: result.exitCode !== 0 ? result.stderr : undefined
        };
      }

      case 'take_screenshot': {
        // Try GUI screenshot service first, fall back to screencapture
        if (this._screenshotService) {
          try {
            const screenshot = await this._screenshotService.capture();
            return {
              success: true,
              path: screenshot.path,
              note: 'Screenshot saved to file'
            };
          } catch (err) {
            this.logger.warn('Screenshot service failed, trying screencapture', { error: err.message });
          }
        }

        // Fallback: macOS screencapture command
        if (process.platform === 'darwin') {
          const screenshotPath = path.join(
            this._outputDir,
            'artifacts',
            `screenshot-${Date.now()}.png`
          );
          const result = await this.executeBash(`screencapture -x "${screenshotPath}"`);
          return {
            success: result.exitCode === 0,
            path: screenshotPath,
            error: result.exitCode !== 0 ? result.stderr : undefined
          };
        }

        return { error: 'Screenshot not available on this platform' };
      }

      // GUI automation tools
      case 'mouse_move': {
        if (!this._guiAvailable || !this._mouseController) {
          return { error: 'GUI automation not available' };
        }
        await this._mouseController.move(args.x, args.y);
        return { success: true, x: args.x, y: args.y };
      }

      case 'mouse_click': {
        if (!this._guiAvailable || !this._mouseController) {
          return { error: 'GUI automation not available' };
        }
        if (args.double) {
          await this._mouseController.doubleClick();
        } else {
          await this._mouseController.click(args.button);
        }
        return { success: true, button: args.button, double: args.double || false };
      }

      case 'keyboard_type': {
        if (!this._guiAvailable || !this._keyboardController) {
          return { error: 'GUI automation not available' };
        }
        await this._keyboardController.type(args.text);
        return { success: true, length: args.text.length };
      }

      case 'keyboard_press': {
        if (!this._guiAvailable || !this._keyboardController) {
          return { error: 'GUI automation not available' };
        }
        await this._keyboardController.pressKey(args.keys);
        return { success: true, keys: args.keys };
      }

      // Delegate to parent for base execution primitives
      default:
        return super.dispatchToolCall(name, args);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Progress tracking — extend with automation-specific ops
  // ═══════════════════════════════════════════════════════════════════════

  _isProgressOperation(toolName) {
    const automationProgressOps = new Set([
      'macos_open_app',
      'macos_run_applescript',
      'take_screenshot',
      'mouse_move',
      'mouse_click',
      'keyboard_type',
      'keyboard_press'
    ]);

    return automationProgressOps.has(toolName) || super._isProgressOperation(toolName);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Accomplishment Assessment
  // ═══════════════════════════════════════════════════════════════════════

  assessAccomplishment(executeResult, results) {
    const baseAssessment = super.assessAccomplishment(executeResult, results);

    // Automation agents can also accomplish via:
    //  - Files organized/moved/renamed
    //  - Processes managed (started/stopped/configured)
    //  - Scripts created for future automation
    //  - System configuration applied
    const metadata = executeResult?.metadata || {};
    const commandsRun = metadata.commandsRun || 0;
    const filesCreated = metadata.filesCreated || 0;

    // If we ran commands but the base assessment says unproductive,
    // check if automation-specific work was done
    if (!baseAssessment.accomplished && commandsRun > 0) {
      return {
        accomplished: true,
        reason: null,
        metrics: {
          ...baseAssessment.metrics,
          commandsRun,
          filesCreated,
          note: 'Automation completed via command execution'
        }
      };
    }

    return baseAssessment;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Handoff
  // ═══════════════════════════════════════════════════════════════════════

  generateHandoffSpec() {
    // Determine best handoff target based on what was produced
    const auditSummary = this._summarizeAudit();

    if (!auditSummary.hasWork) {
      return null;
    }

    // If we produced data files, hand off to datapipeline for processing
    if (auditSummary.producedDataFiles) {
      return {
        targetAgentType: 'datapipeline',
        reason: 'Automation produced data files that need processing',
        artifactRefs: [this._outputDir],
        context: {
          sourceAgent: this.agentId,
          sourceType: 'automation',
          filesProduced: auditSummary.filesCreated,
          outputDir: this._outputDir
        }
      };
    }

    // If we ran analysis commands, hand off to analysis
    if (auditSummary.ranAnalysis) {
      return {
        targetAgentType: 'analysis',
        reason: 'Automation gathered data that needs analysis',
        artifactRefs: [this._outputDir],
        context: {
          sourceAgent: this.agentId,
          sourceType: 'automation',
          commandsRun: auditSummary.commandsRun,
          outputDir: this._outputDir
        }
      };
    }

    // Default: hand off to research for deeper investigation
    return {
      targetAgentType: 'research',
      reason: 'Automation completed — results may warrant further research',
      artifactRefs: [this._outputDir],
      context: {
        sourceAgent: this.agentId,
        sourceType: 'automation',
        outputDir: this._outputDir
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Internal Helpers
  // ═══════════════════════════════════════════════════════════════════════

  _summarizeAudit() {
    const log = this.getAuditLog();

    const summary = {
      hasWork: log.length > 0,
      commandsRun: 0,
      filesCreated: 0,
      producedDataFiles: false,
      ranAnalysis: false
    };

    for (const entry of log) {
      if (entry.operation === 'executeBash') {
        summary.commandsRun++;
        const cmd = entry.args?.command || '';
        // Heuristic: data-producing commands
        if (/\b(curl|wget|sqlite3|python3?|node)\b/.test(cmd)) {
          summary.producedDataFiles = true;
        }
        // Heuristic: analysis commands
        if (/\b(find|grep|awk|wc|du|stat|file|exiftool|identify)\b/.test(cmd)) {
          summary.ranAnalysis = true;
        }
      }
      if (entry.operation === 'writeFile') {
        summary.filesCreated++;
        summary.producedDataFiles = true;
      }
    }

    return summary;
  }

  async _writeManifest(result) {
    if (!this._outputDir) return;

    const manifest = {
      agentId: this.agentId,
      agentType: 'automation',
      mission: this.mission.description,
      goalId: this.mission.goalId,
      completedAt: new Date().toISOString(),
      result: {
        success: result.success,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        conclusion: result.conclusion
      },
      metrics: result.metadata || {},
      guiAvailable: this._guiAvailable,
      platform: process.platform
    };

    const manifestPath = path.join(this._outputDir, 'manifest.json');
    try {
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      this.logger.debug('Manifest written', { path: manifestPath });
    } catch (err) {
      this.logger.warn('Failed to write manifest', { error: err.message });
    }

    // Write operations log (alias for audit trail)
    const operationsPath = path.join(this._outputDir, 'operations.jsonl');
    const auditLog = this.getAuditLog();
    if (auditLog.length > 0) {
      try {
        const lines = auditLog.map(e => JSON.stringify(e)).join('\n') + '\n';
        await fs.writeFile(operationsPath, lines, 'utf8');
        this.logger.debug('Operations log written', { path: operationsPath, entries: auditLog.length });
      } catch (err) {
        this.logger.warn('Failed to write operations log', { error: err.message });
      }
    }
  }
}

module.exports = { AutomationAgent };
