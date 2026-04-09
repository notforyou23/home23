/**
 * MouseController - Hybrid mouse control
 * Primary: @nut-tree-fork/nut-js
 * Fallback: robotjs (if nut.js unavailable)
 */
class MouseController {
  constructor(logger) {
    this.logger = logger;
    this.backend = null;
    this.mouse = null;
    this.Point = null;
    this.Button = null;
    this.robotjs = null;
  }
  
  async initialize() {
    // Try nut.js first (fork version)
    try {
      const nutjs = require('@nut-tree-fork/nut-js');
      this.mouse = nutjs.mouse;
      this.Point = nutjs.Point;
      this.Button = nutjs.Button;
      this.backend = 'nut.js';
      this.logger.info('✅ Mouse: @nut-tree-fork/nut-js');
      return;
    } catch (error) {
      this.logger.warn('nut.js not available', { error: error.message });
    }
    
    // Fallback to robotjs
    try {
      this.robotjs = require('robotjs');
      this.backend = 'robotjs';
      this.logger.info('✅ Mouse: robotjs (fallback)');
      return;
    } catch (error) {
      this.logger.warn('robotjs not available', { error: error.message });
    }
    
    throw new Error('No mouse control library available');
  }
  
  async move(x, y) {
    if (this.mouse && this.Point) {
      // nut.js API: setPosition takes a Point object
      await this.mouse.setPosition(new this.Point(x, y));
    } else if (this.robotjs) {
      this.robotjs.moveMouse(x, y);
    }
  }
  
  async click(button = 'left') {
    if (this.mouse && this.Button) {
      // nut.js has dedicated click methods
      if (button === 'left') {
        await this.mouse.click(this.Button.LEFT);
      } else if (button === 'right') {
        await this.mouse.click(this.Button.RIGHT);
      } else if (button === 'middle') {
        await this.mouse.click(this.Button.MIDDLE);
      }
    } else if (this.robotjs) {
      this.robotjs.mouseClick(button);
    }
  }
  
  async doubleClick() {
    if (this.mouse && this.Button) {
      await this.mouse.doubleClick(this.Button.LEFT);
    } else if (this.robotjs) {
      this.robotjs.mouseClick('left', true);
    }
  }
  
  async drag(x, y) {
    if (this.mouse && this.Point) {
      // nut.js drag: from current position to new position
      const currentPos = await this.mouse.getPosition();
      await this.mouse.drag(currentPos, new this.Point(x, y));
    } else if (this.robotjs) {
      this.robotjs.mouseToggle('down');
      this.robotjs.dragMouse(x, y);
      this.robotjs.mouseToggle('up');
    }
  }
  
  async getPosition() {
    if (this.mouse) {
      const pos = await this.mouse.getPosition();
      return { x: pos.x, y: pos.y };
    } else if (this.robotjs) {
      const pos = this.robotjs.getMousePos();
      return { x: pos.x, y: pos.y };
    }
  }
  
  getBackend() {
    return this.backend;
  }
}

module.exports = { MouseController };

