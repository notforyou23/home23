const fs = require('fs');
const os = require('os');
const path = require('path');

function getDefaultBrainRuntimeStatePath() {
  const configDir = process.env.EVOBREW_CONFIG_DIR || path.join(os.homedir(), '.evobrew');
  return path.join(configDir, 'runtime-state.json');
}

function readState(statePath = getDefaultBrainRuntimeStatePath()) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tempPath = `${statePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, statePath);
}

function rememberLastBrain(statePath, brainPath) {
  const resolvedPath = path.resolve(brainPath);
  const state = {
    ...readState(statePath),
    lastBrainPath: resolvedPath,
    lastBrainLoadedAt: new Date().toISOString()
  };
  writeState(statePath, state);
}

function clearLastBrain(statePath = getDefaultBrainRuntimeStatePath()) {
  const state = {
    ...readState(statePath),
    lastBrainPath: null,
    lastBrainClearedAt: new Date().toISOString()
  };
  writeState(statePath, state);
}

function isPathInside(candidatePath, rootPath) {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function getRestorableBrainPath(statePath = getDefaultBrainRuntimeStatePath(), allowedRoots = []) {
  const state = readState(statePath);
  const rememberedPath = typeof state.lastBrainPath === 'string' ? state.lastBrainPath.trim() : '';
  if (!rememberedPath) return null;

  const resolvedPath = path.resolve(rememberedPath);
  const allowed = Array.isArray(allowedRoots)
    && allowedRoots.some((rootPath) => rootPath && isPathInside(resolvedPath, rootPath));
  if (!allowed) return null;

  const stateJsonPath = path.join(resolvedPath, 'state.json.gz');
  if (!fs.existsSync(stateJsonPath)) return null;

  return resolvedPath;
}

module.exports = {
  clearLastBrain,
  getDefaultBrainRuntimeStatePath,
  getRestorableBrainPath,
  rememberLastBrain
};
