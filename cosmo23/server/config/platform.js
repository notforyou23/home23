/**
 * Platform Detection for COSMO IDE
 * 
 * Detects whether running on:
 * - Mac (full capabilities, local models supported)
 * - Raspberry Pi (cloud providers only, no local models)
 * - Other Linux systems
 */

const os = require('os');
const fs = require('fs');

/**
 * Detected platform information
 * @typedef {Object} PlatformInfo
 * @property {'mac'|'pi'|'linux'|'other'} platform - Platform type
 * @property {string} hostname - Machine hostname
 * @property {string} arch - CPU architecture (arm64, x64, etc.)
 * @property {boolean} isRaspberryPi - True if running on Raspberry Pi
 * @property {boolean} isMac - True if running on macOS
 * @property {boolean} supportsLocalModels - True if local AI models (Ollama) are practical
 * @property {string} cpuModel - CPU model string
 * @property {number} totalMemoryGB - Total system memory in GB
 */

/**
 * Detect if running on Raspberry Pi
 * @returns {boolean}
 */
function detectRaspberryPi() {
  // Check /proc/device-tree/model (Linux)
  try {
    if (fs.existsSync('/proc/device-tree/model')) {
      const model = fs.readFileSync('/proc/device-tree/model', 'utf8');
      if (model.toLowerCase().includes('raspberry')) {
        return true;
      }
    }
  } catch {
    // Not on Linux or can't read file
  }

  // Check /proc/cpuinfo for Raspberry Pi identifiers
  try {
    if (fs.existsSync('/proc/cpuinfo')) {
      const cpuinfo = fs.readFileSync('/proc/cpuinfo', 'utf8');
      if (cpuinfo.includes('BCM') || cpuinfo.toLowerCase().includes('raspberry')) {
        return true;
      }
    }
  } catch {
    // Can't read cpuinfo
  }

  // Check hostname patterns
  const hostname = os.hostname().toLowerCase();
  if (hostname.includes('pi') || hostname.includes('raspberry') || hostname === 'jtrpi') {
    return true;
  }

  return false;
}

/**
 * Get platform information
 * @returns {PlatformInfo}
 */
function getPlatformInfo() {
  const hostname = os.hostname();
  const arch = os.arch();
  const platform = os.platform();
  const cpus = os.cpus();
  const cpuModel = cpus[0]?.model || 'Unknown';
  const totalMemoryGB = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;

  const isMac = platform === 'darwin';
  const isRaspberryPi = detectRaspberryPi();
  const isLinux = platform === 'linux';

  // Determine if local models are practical
  // Raspberry Pi: No (too slow, limited memory)
  // Mac with Apple Silicon: Yes
  // Linux with decent specs: Maybe (check memory)
  let supportsLocalModels = false;
  if (isMac) {
    supportsLocalModels = true; // Apple Silicon Macs run Ollama well
  } else if (isRaspberryPi) {
    supportsLocalModels = false; // Pi can't run Ollama effectively
  } else if (isLinux && totalMemoryGB >= 16) {
    supportsLocalModels = true; // Linux with enough RAM might work
  }

  // Determine platform type
  let platformType = 'other';
  if (isMac) platformType = 'mac';
  else if (isRaspberryPi) platformType = 'pi';
  else if (isLinux) platformType = 'linux';

  return {
    platform: platformType,
    hostname,
    arch,
    isRaspberryPi,
    isMac,
    supportsLocalModels,
    cpuModel,
    totalMemoryGB
  };
}

/**
 * Get default provider configuration based on platform
 * @returns {Object} Model assignments configuration
 */
function getDefaultModelAssignments() {
  const info = getPlatformInfo();

  if (info.isRaspberryPi || !info.supportsLocalModels) {
    // Pi/cloud-only: Use remote providers
    return {
      default: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5'
      },
      fast: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5'  // No local fast model on Pi
      },
      reasoning: {
        provider: 'anthropic',
        model: 'claude-opus-4-6'
      }
    };
  }

  // Mac/full: Hybrid local + cloud
  return {
    default: {
      provider: 'anthropic',
      model: 'claude-sonnet-4-5'
    },
    fast: {
      provider: 'ollama',
      model: 'qwen2.5-coder:7b',
      fallback: 'anthropic/claude-sonnet-4-5'
    },
    reasoning: {
      provider: 'anthropic',
      model: 'claude-opus-4-6'
    }
  };
}

// Cache platform info (doesn't change at runtime)
let cachedPlatformInfo = null;

/**
 * Get cached platform info
 * @returns {PlatformInfo}
 */
function getPlatform() {
  if (!cachedPlatformInfo) {
    cachedPlatformInfo = getPlatformInfo();
    console.log(`[Platform] Detected: ${cachedPlatformInfo.platform} (${cachedPlatformInfo.hostname})`);
    console.log(`[Platform] Local models supported: ${cachedPlatformInfo.supportsLocalModels}`);
    console.log(`[Platform] Memory: ${cachedPlatformInfo.totalMemoryGB}GB, CPU: ${cachedPlatformInfo.cpuModel}`);
  }
  return cachedPlatformInfo;
}

module.exports = {
  getPlatform,
  getPlatformInfo,
  detectRaspberryPi,
  getDefaultModelAssignments
};
