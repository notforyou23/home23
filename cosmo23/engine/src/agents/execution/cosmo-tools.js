/**
 * COSMO Tool Schema v1.0
 * 
 * Production-grade tool definitions for GPT-5.2 function calling
 * Enables local OS autonomy with safety boundaries
 */

const COSMO_TOOLS = [
  // -------------------------------------------------------
  // 1. Mouse Control
  // -------------------------------------------------------
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
        required: ['x', 'y']
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
        required: ['button']
      }
    }
  },
  
  // -------------------------------------------------------
  // 2. Keyboard Control
  // -------------------------------------------------------
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
        required: ['text']
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
        required: ['keys']
      }
    }
  },
  
  // -------------------------------------------------------
  // 3. Screenshots
  // -------------------------------------------------------
  {
    type: 'function',
    function: {
      name: 'screenshot',
      description: 'Capture a screenshot of the entire screen.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  
  // -------------------------------------------------------
  // 4. Bash Execution
  // -------------------------------------------------------
  {
    type: 'function',
    function: {
      name: 'bash_execute',
      description: 'Execute a bash command on the host system.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run (allowed commands only).'
          },
          cwd: {
            type: 'string',
            description: 'Working directory override (must pass safety validation).'
          }
        },
        required: ['command']
      }
    }
  },
  
  // -------------------------------------------------------
  // 5. File System
  // -------------------------------------------------------
  {
    type: 'function',
    function: {
      name: 'file_read',
      description: 'Read the contents of a file within the allowed directories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'file_write',
      description: 'Write content to a file (overwrite, append, or prepend).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file' },
          content: { type: 'string', description: 'Content to write' },
          mode: {
            type: 'string',
            enum: ['overwrite', 'append', 'prepend'],
            description: 'Write mode'
          }
        },
        required: ['path', 'content']
      }
    }
  },
  
  // -------------------------------------------------------
  // 6. macOS Native Executor
  // -------------------------------------------------------
  {
    type: 'function',
    function: {
      name: 'macos_open_app',
      description: 'Open a macOS application (macOS only).',
      parameters: {
        type: 'object',
        properties: {
          app: {
            type: 'string',
            description: 'Name of app to open (e.g., "Terminal", "Safari", "Visual Studio Code").'
          }
        },
        required: ['app']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'macos_focus_app',
      description: 'Bring an app to the foreground.',
      parameters: {
        type: 'object',
        properties: {
          app: {
            type: 'string',
            description: 'Application name'
          }
        },
        required: ['app']
      }
    }
  }
];

module.exports = { COSMO_TOOLS };

