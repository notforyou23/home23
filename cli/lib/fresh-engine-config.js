/** Instance-owned cognitive configuration for a newly created home. */
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';

const ENGINE_PROVIDERS = new Map([
  ['anthropic', 'anthropic'], ['openai', 'openai'], ['openai-codex', 'openai-codex'],
  ['minimax', 'minimax'], ['xai', 'xai'], ['ollama-cloud', 'ollama-cloud'], ['ollama-local', 'local'],
]);

export function buildFreshEngineConfig(profile) {
  const provider = ENGINE_PROVIDERS.get(profile.provider);
  if (!provider) throw new Error(`Unsupported new-home engine provider: ${profile.provider}`);
  for (const field of ['model', 'ownerName', 'purpose']) {
    if (typeof profile[field] !== 'string' || !profile[field].trim() || profile[field].includes('\0')) {
      throw new Error(`New-home engine requires ${field}`);
    }
  }
  const model = profile.model;
  // Keep the maintained engine architecture, while defining the new home's
  // identity and model routing explicitly. Never copy installation config.
  const config = yaml.load(readFileSync(new URL('../../configs/base-engine.yaml', import.meta.url), 'utf8'));
  for (const key of Object.keys(config.models)) {
    if (typeof config.models[key] === 'string') config.models[key] = model;
  }
  config.providers = {
    [provider]: {
      ...(config.providers[provider] || {}), enabled: true,
      defaultModel: model, defaultModels: [model], modelMapping: {},
    },
  };
  for (const key of Object.keys(config.modelAssignments)) {
    config.modelAssignments[key] = { provider, model };
  }
  config.coordinator.model = model;
  config.feeder.compiler.model = model;

  const owner = profile.ownerName;
  const focus = config.architecture.roleSystem.guidedFocus;
  focus.domain = `${owner}'s world`;
  focus.context = `This is ${owner}'s independent Home23. Purpose: ${profile.purpose}\n`
    + 'Learn from the owner, their conversations, documents and projects. Keep acquired context and commitments grounded in this home.\n'
    + 'Use available tools to act on authorized work, follow through on results, and surface useful connections.';
  const prompts = {
    curiosity: `Generate one useful question about ${owner}'s projects, interests, decisions or world. Ground it in available context. End with INVESTIGATE, NOTIFY, TRIGGER, OBSERVE, or NO_ACTION, followed by a specific next action when warranted.`,
    analyst: `Examine one concrete topic relevant to ${owner} and this home's purpose: ${profile.purpose} Distinguish evidence from assumptions. End with INVESTIGATE, NOTIFY, TRIGGER, OBSERVE, or NO_ACTION.`,
    critic: `Evaluate one claim, active goal, recent thought or observed behavior relevant to ${owner}. Give a short reasoned verdict. End with VERDICT: keep|revise|discard and the reason, or a concrete INVESTIGATE, NOTIFY, TRIGGER, OBSERVE, or NO_ACTION tag.`,
    curator: `Curate durable context for ${owner}. Review recent insights and memory; preserve what changed, what matters and what should guide future work. Update the relevant TOPOLOGY, PROJECTS, PERSONAL, DOCTRINE or RECENT surface when warranted.`,
    proposal: `Propose one concrete action that advances ${owner}'s work and this purpose: ${profile.purpose} Use the tools and actions actually available in this home. Prefer carrying authorized work through completion. End with ACT: followed by the supported action JSON, or a specific INVESTIGATE, NOTIFY, TRIGGER, OBSERVE, or NO_ACTION tag.`,
  };
  for (const role of config.architecture.roleSystem.initialRoles) {
    if (prompts[role.id]) role.prompt = role.promptGuided = prompts[role.id];
  }
  return config;
}

/** Called only inside createHome's durable fresh-home claim and lock.
 * Publish complete YAML atomically and leave an existing file untouched on a
 * retry, including changes the owner has already made to that file. */
export function prepareFreshEngineConfig(root, profile) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(profile.name || '')) throw new Error('Invalid new-home resident name');
  const instanceDir = join(resolve(root), 'instances', profile.name);
  const absolutePath = join(instanceDir, 'engine.yaml');
  const receipt = { engineConfigPath: 'engine.yaml', absolutePath, created: false };
  if (existsSync(absolutePath)) {
    if (!lstatSync(absolutePath).isFile() || lstatSync(absolutePath).isSymbolicLink()) throw new Error('New-home engine configuration must be a regular file');
    return receipt;
  }
  const config = buildFreshEngineConfig(profile);
  mkdirSync(instanceDir, { recursive: true });
  const stagedPath = join(instanceDir, `.engine-${randomUUID()}.tmp`);
  writeFileSync(stagedPath, yaml.dump(config, { lineWidth: 120 }), { flag: 'wx', mode: 0o600 });
  try {
    // link is exclusive; a concurrent publisher cannot be overwritten.
    linkSync(stagedPath, absolutePath);
    return { ...receipt, created: true };
  } catch (error) {
    if (error.code === 'EEXIST' && lstatSync(absolutePath).isFile() && !lstatSync(absolutePath).isSymbolicLink()) return receipt;
    throw error;
  } finally {
    unlinkSync(stagedPath);
  }
}
