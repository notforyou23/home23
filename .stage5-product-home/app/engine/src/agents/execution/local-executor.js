const { MouseController } = require('./mouse-controller');
const { KeyboardController } = require('./keyboard-controller');
const { ScreenshotService } = require('./screenshot-service');
const { BashExecutor } = require('./bash-executor');
const { FileSystemAgent } = require('./filesystem-agent');
const { MacOSNative } = require('./macos-native');

/**
 * LocalExecutor - Main orchestrator for local OS execution
 * 
 * Coordinates all execution capabilities:
 * - Mouse control
 * - Keyboard control
 * - Screenshots
 * - Bash commands
 * - File operations
 * - macOS automation
 */
class LocalExecutor {
  constructor(config, logger, frontierGate = null) {
    this.config = config;
    this.logger = logger;
    this.frontierGate = frontierGate; // FrontierGate for governance (optional)
    
    // Initialize controllers
    this.mouse = new MouseController(logger);
    this.keyboard = new KeyboardController(logger);
    this.screenshot = new ScreenshotService(logger);
    this.bash = new BashExecutor(null, logger);
    this.filesystem = new FileSystemAgent(null, logger);
    this.macos = new MacOSNative(logger);
    
    // Execution stats
    this.actionCount = 0;
    this.startTime = null;
    
    // Hard limits
    const exp = config.experimental || {};
    this.maxActions = Math.min(exp.limits?.actions || 50, 200);
    this.maxTime = Math.min(exp.limits?.time_sec || 600, 900);
  }
  
  async initialize() {
    this.logger.info('🔧 Initializing Local Execution Engine...');
    
    await this.mouse.initialize();
    await this.keyboard.initialize();
    await this.screenshot.initialize();
    
    this.startTime = Date.now();
    this.actionCount = 0;
    
    this.logger.info('✅ Local Execution Engine ready', {
      mouse: this.mouse.getBackend(),
      keyboard: this.keyboard.getBackend(),
      screenshot: this.screenshot.getBackend(),
      maxActions: this.maxActions,
      maxTime: this.maxTime,
      platform: process.platform
    });
  }
  
  /**
   * Execute a function call from GPT-5
   * @param {Object} functionCall - { name, arguments }
   * @returns {Object} Execution result
   */
  async execute(functionCall) {
    // Check limits
    this.checkLimits();
    this.actionCount++;
    
    const { name, arguments: args } = functionCall;
    
    // FrontierGate: Check if action is allowed (fail-safe)
    if (this.frontierGate) {
      try {
        const gateCheck = await this.frontierGate.checkAction(name, args);
        
        if (!gateCheck.allowed) {
          // Action blocked by FrontierGate
          const error = new Error(gateCheck.message || `Action '${name}' blocked by FrontierGate`);
          error.code = 'FRONTIER_GATE_BLOCKED';
          error.classification = gateCheck.classification;
          throw error;
        }
        
        // Action allowed, log classification
        if (gateCheck.classification) {
          this.logger.debug('FrontierGate classification', {
            action: name,
            risk: gateCheck.classification.riskLevel,
            context: gateCheck.classification.context
          });
        }
      } catch (error) {
        // If error is frontier gate block, re-throw
        if (error.code === 'FRONTIER_GATE_BLOCKED') {
          throw error;
        }
        // Otherwise, fail-safe: log and continue
        this.logger.error('FrontierGate check failed (allowing action)', error);
      }
    }
    
    this.logger.info('⚡ Executing action', {
      action: this.actionCount,
      function: name
    });
    
    try {
      let result;
      
      switch (name) {
        case 'mouse_move':
          await this.mouse.move(args.x, args.y);
          result = { success: true, x: args.x, y: args.y };
          break;
          
        case 'mouse_click':
          if (args.double) {
            await this.mouse.doubleClick();
          } else {
            await this.mouse.click(args.button);
          }
          result = { success: true, button: args.button, double: args.double || false };
          break;
          
        case 'keyboard_type':
          await this.keyboard.type(args.text);
          result = { success: true, length: args.text.length };
          break;
          
        case 'keyboard_press':
          await this.keyboard.pressKey(args.keys);
          result = { success: true, keys: args.keys };
          break;
          
        case 'screenshot':
          const screenshot = await this.screenshot.capture();
          result = { 
            success: true, 
            path: screenshot.path,
            // Don't include full base64 in result to avoid bloat
            note: 'Screenshot saved to file'
          };
          break;
          
        case 'bash_execute':
          const bashResult = await this.bash.execute(args.command, args.cwd);
          result = bashResult;
          break;
          
        case 'file_read':
          const content = await this.filesystem.readFile(args.path);
          result = { 
            success: true, 
            content: content.length > 1000 ? content.substring(0, 1000) + '...(truncated)' : content,
            fullLength: content.length,
            path: args.path 
          };
          break;
          
        case 'file_write':
          const writeResult = await this.filesystem.writeFile(
            args.path, 
            args.content, 
            args.mode || 'overwrite'
          );
          result = writeResult;
          
          // FrontierGate: Record file creation (fail-safe)
          if (this.frontierGate && result.success) {
            try {
              const size = args.content ? args.content.length : 0;
              await this.frontierGate.recordFileCreation(
                args.path,
                'local_executor',  // agentId placeholder
                size
              );
            } catch (error) {
              this.logger.error('FrontierGate file tracking failed', error);
            }
          }
          break;
          
        case 'macos_open_app':
          await this.macos.openApp(args.app);
          result = { success: true, app: args.app };
          break;
          
        case 'macos_focus_app':
          await this.macos.focusApp(args.app);
          result = { success: true, app: args.app };
          break;
          
        default:
          throw new Error(`Unknown function: ${name}`);
      }
      
      return result;
      
    } catch (error) {
      this.logger.error('Action failed', { 
        action: this.actionCount,
        function: name,
        error: error.message 
      });
      
      return { 
        error: error.message,
        success: false
      };
    }
  }
  
  /**
   * Check if execution limits have been exceeded
   */
  checkLimits() {
    if (this.actionCount >= this.maxActions) {
      throw new Error(`Action limit reached (${this.maxActions})`);
    }
    
    const elapsed = (Date.now() - this.startTime) / 1000;
    if (elapsed >= this.maxTime) {
      throw new Error(`Time limit reached (${this.maxTime}s)`);
    }
  }
  
  /**
   * Get current execution stats
   */
  getStats() {
    const elapsed = (Date.now() - this.startTime) / 1000;
    return {
      actionCount: this.actionCount,
      maxActions: this.maxActions,
      elapsedTime: elapsed,
      maxTime: this.maxTime,
      actionsRemaining: this.maxActions - this.actionCount,
      timeRemaining: this.maxTime - elapsed
    };
  }
  
  /**
   * Cleanup resources
   */
  async cleanup() {
    this.logger.info('🧹 Cleaning up Local Execution Engine');
    await this.bash.killAll();
  }
}

module.exports = { LocalExecutor };
