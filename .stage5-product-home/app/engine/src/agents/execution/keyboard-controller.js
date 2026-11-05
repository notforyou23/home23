/**
 * KeyboardController - Hybrid keyboard control
 * Primary: @nut-tree-fork/nut-js
 * Fallback: robotjs (if nut.js unavailable)
 */
class KeyboardController {
  constructor(logger) {
    this.logger = logger;
    this.backend = null;
    this.keyboard = null;
    this.Key = null;
    this.robotjs = null;
  }
  
  async initialize() {
    // Try nut.js first (fork version)
    try {
      const nutjs = require('@nut-tree-fork/nut-js');
      this.keyboard = nutjs.keyboard;
      this.Key = nutjs.Key;
      this.backend = 'nut.js';
      this.logger.info('✅ Keyboard: @nut-tree-fork/nut-js');
      return;
    } catch (error) {
      this.logger.warn('nut.js not available', { error: error.message });
    }
    
    // Fallback to robotjs
    try {
      this.robotjs = require('robotjs');
      this.backend = 'robotjs';
      this.logger.info('✅ Keyboard: robotjs (fallback)');
      return;
    } catch (error) {
      this.logger.warn('robotjs not available', { error: error.message });
    }
    
    throw new Error('No keyboard control library available');
  }
  
  async type(text) {
    if (this.keyboard) {
      await this.keyboard.type(text);
    } else if (this.robotjs) {
      this.robotjs.typeString(text);
    }
  }
  
  async pressKey(keys) {
    // Handle key combinations like "command+v", "control+c", etc.
    if (typeof keys === 'string' && keys.includes('+')) {
      const parts = keys.split('+').map(k => k.trim());
      
      if (this.keyboard && this.Key) {
        // nut.js: press modifiers, press main key, release all
        const keyMappings = {
          'command': this.Key.LeftCmd,
          'cmd': this.Key.LeftCmd,
          'control': this.Key.LeftControl,
          'ctrl': this.Key.LeftControl,
          'alt': this.Key.LeftAlt,
          'option': this.Key.LeftAlt,
          'shift': this.Key.LeftShift,
          'enter': this.Key.Enter,
          'return': this.Key.Enter,
          'space': this.Key.Space,
          'tab': this.Key.Tab,
          'escape': this.Key.Escape,
          'esc': this.Key.Escape,
          'backspace': this.Key.Backspace,
          'delete': this.Key.Delete
        };
        
        const nutjsKeys = parts.map(p => {
          const lower = p.toLowerCase();
          if (keyMappings[lower]) {
            return keyMappings[lower];
          }
          // Single character - use Key[uppercase]
          if (p.length === 1) {
            const upper = p.toUpperCase();
            return this.Key[upper] || p;
          }
          return p;
        });
        
        // Press all keys
        for (const key of nutjsKeys) {
          await this.keyboard.pressKey(key);
        }
        
        // Release in reverse order
        for (const key of nutjsKeys.reverse()) {
          await this.keyboard.releaseKey(key);
        }
      } else if (this.robotjs) {
        // robotjs: keyTap(mainKey, [modifiers])
        const modifiers = parts.slice(0, -1).map(m => m.toLowerCase());
        const mainKey = parts[parts.length - 1].toLowerCase();
        this.robotjs.keyTap(mainKey, modifiers);
      }
    } else {
      // Single key press
      if (this.keyboard && this.Key) {
        const keyMappings = {
          'enter': this.Key.Enter,
          'return': this.Key.Enter,
          'space': this.Key.Space,
          'tab': this.Key.Tab,
          'escape': this.Key.Escape,
          'esc': this.Key.Escape,
          'backspace': this.Key.Backspace,
          'delete': this.Key.Delete
        };
        
        const key = keyMappings[keys.toLowerCase()] || 
                    (keys.length === 1 ? this.Key[keys.toUpperCase()] : keys);
        
        await this.keyboard.type(key);
      } else if (this.robotjs) {
        this.robotjs.keyTap(keys.toLowerCase());
      }
    }
  }
  
  getBackend() {
    return this.backend;
  }
}

module.exports = { KeyboardController };

