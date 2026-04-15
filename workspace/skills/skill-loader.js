/**
 * Unified Skill Loader
 * Canonical loader for first-class skills under workspace/skills/
 */

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = __dirname;
const SUPPORT_DIRS = new Set(["_archived"]);
const SCRIPT_EXTS = new Set([".js", ".mjs", ".sh", ".py"]);

function parseSkillMd(content) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (frontmatterMatch) {
    const meta = yaml.load(frontmatterMatch[1]) || {};
    return { meta, body: frontmatterMatch[2] };
  }

  const metadataBlockMatch = content.match(/\nmetadata:\n([\s\S]*?)\n---/);
  if (metadataBlockMatch) {
    const meta = yaml.load(metadataBlockMatch[1]) || {};
    return { meta, body: content };
  }

  return { meta: {}, body: content };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function getSkillDirs() {
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !SUPPORT_DIRS.has(name))
    .sort();
}

function normalizeActions(manifest, skillMdMeta, scriptsDir) {
  const manifestActions = Array.isArray(manifest?.actions) ? manifest.actions : [];
  const mdCapabilities = Array.isArray(skillMdMeta?.capabilities)
    ? skillMdMeta.capabilities
        .map((capability) => typeof capability === "string" ? capability : Object.keys(capability || {})[0])
        .filter(Boolean)
    : [];
  const scriptActions = fs.existsSync(scriptsDir)
    ? fs.readdirSync(scriptsDir)
        .filter((filename) => SCRIPT_EXTS.has(path.extname(filename)))
        .map((filename) => path.basename(filename, path.extname(filename)))
    : [];

  return [...new Set([...manifestActions, ...mdCapabilities, ...scriptActions])];
}

function buildSkillRecord(name) {
  const skillPath = path.join(SKILLS_DIR, name);
  const manifestPath = path.join(skillPath, "manifest.json");
  const skillMdPath = path.join(skillPath, "SKILL.md");
  const entryPath = path.join(skillPath, "index.js");
  const scriptsDir = path.join(skillPath, "scripts");
  const referencesDir = path.join(skillPath, "references");
  const assetsDir = path.join(skillPath, "assets");
  const readmePath = path.join(skillPath, "README.md");

  const manifest = readJsonIfExists(manifestPath);
  const skillMd = fs.existsSync(skillMdPath)
    ? parseSkillMd(fs.readFileSync(skillMdPath, "utf8"))
    : null;

  if (!manifest && !skillMd) return null;

  const meta = {
    id: manifest?.id || skillMd?.meta?.id || name,
    name: manifest?.name || skillMd?.meta?.name || name,
    version: manifest?.version || skillMd?.meta?.version || "0.0.0",
    description: manifest?.description || skillMd?.meta?.description || "",
    author: manifest?.author || skillMd?.meta?.author || "",
    entry: manifest?.entry || "index.js",
    layer: manifest?.layer || skillMd?.meta?.layer || "skill",
    runtime: manifest?.runtime || skillMd?.meta?.runtime || (fs.existsSync(entryPath) ? "nodejs" : "docs"),
    actions: normalizeActions(manifest, skillMd?.meta, scriptsDir),
  };

  return {
    id: name,
    type: skillMd ? "rich" : "manifest",
    path: skillPath,
    manifest,
    skillMd,
    meta,
    hasEntry: fs.existsSync(entryPath),
    entryPath: fs.existsSync(entryPath) ? entryPath : null,
    scriptsDir: fs.existsSync(scriptsDir) ? scriptsDir : null,
    referencesDir: fs.existsSync(referencesDir) ? referencesDir : null,
    assetsDir: fs.existsSync(assetsDir) ? assetsDir : null,
    hasReadme: fs.existsSync(readmePath),
    hasManifest: !!manifest,
    hasSkillMd: !!skillMd,
    hasScripts: fs.existsSync(scriptsDir),
  };
}

function loadSkills() {
  const skills = {};
  for (const name of getSkillDirs()) {
    const record = buildSkillRecord(name);
    if (record) skills[name] = record;
  }
  return skills;
}

function listSkills() {
  return Object.values(loadSkills()).map((skill) => ({
    id: skill.id,
    name: skill.id,
    displayName: skill.meta.name,
    type: skill.type,
    description: skill.meta.description,
    version: skill.meta.version,
    runtime: skill.meta.runtime,
    actions: skill.meta.actions,
    hasEntry: skill.hasEntry,
    hasManifest: skill.hasManifest,
    hasSkillMd: skill.hasSkillMd,
    hasScripts: !!skill.scriptsDir,
    hasReferences: !!skill.referencesDir,
    hasAssets: !!skill.assetsDir,
    hasReadme: skill.hasReadme,
  }));
}

function getSkillInfo(skillName) {
  const skill = loadSkills()[skillName];
  if (!skill) return null;
  return {
    id: skill.id,
    name: skill.meta.name,
    version: skill.meta.version,
    description: skill.meta.description,
    author: skill.meta.author,
    runtime: skill.meta.runtime,
    entry: skill.meta.entry,
    actions: skill.meta.actions,
    type: skill.type,
    hasEntry: skill.hasEntry,
    files: {
      path: skill.path,
      scriptsDir: skill.scriptsDir,
      referencesDir: skill.referencesDir,
      assetsDir: skill.assetsDir,
      hasReadme: skill.hasReadme,
      hasManifest: skill.hasManifest,
      hasSkillMd: skill.hasSkillMd,
    },
  };
}

function getSkillDetails(skillName) {
  const skill = loadSkills()[skillName];
  if (!skill) return null;
  return {
    ...getSkillInfo(skillName),
    body: skill.skillMd?.body || null,
  };
}

function sanitizeContextForScripts(context = {}) {
  return {
    projectRoot: context.projectRoot || "",
    workspacePath: context.workspacePath || "",
    tempDir: context.tempDir || "",
    enginePort: context.enginePort || "",
    chatId: context.chatId || "",
  };
}

async function executeEntryModule(skill, action, params, context) {
  const mod = await import(pathToFileURL(skill.entryPath).href);

  if (typeof mod.execute === "function") {
    return mod.execute(action, params, context);
  }

  if (mod.actions && typeof mod.actions[action] === "function") {
    return mod.actions[action](params, context);
  }

  if (typeof mod[action] === "function") {
    return mod[action](params, context);
  }

  if (mod.default && typeof mod.default[action] === "function") {
    return mod.default[action](params, context);
  }

  if (typeof mod.default === "function") {
    return mod.default({ action, params, context });
  }

  throw new Error(`Action '${action}' not found in skill '${skill.id}'`);
}

function findScriptForAction(skill, action) {
  if (!skill.scriptsDir) return null;
  const candidates = fs.readdirSync(skill.scriptsDir)
    .filter((filename) => SCRIPT_EXTS.has(path.extname(filename)));

  return candidates.find((filename) => path.basename(filename, path.extname(filename)) === action)
    || candidates.find((filename) => filename.includes(action))
    || null;
}

function runScript(scriptPath, skillPath, action, params, context) {
  const ext = path.extname(scriptPath);
  const env = {
    ...process.env,
    HOME23_SKILL_ACTION: action,
    HOME23_SKILL_PARAMS: JSON.stringify(params ?? {}),
    HOME23_SKILL_CONTEXT: JSON.stringify(sanitizeContextForScripts(context)),
  };

  let command;
  let args = [];

  if (ext === ".sh") {
    command = "bash";
    args = [scriptPath];
  } else if (ext === ".py") {
    command = "python3";
    args = [scriptPath];
  } else if (ext === ".js" || ext === ".mjs") {
    command = process.execPath;
    args = [scriptPath];
  } else {
    throw new Error(`Unsupported script extension '${ext}'`);
  }

  const result = spawnSync(command, args, {
    cwd: skillPath,
    env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || `Script failed with code ${result.status}`);
  }

  const stdout = result.stdout?.trim() || "";
  if (!stdout) {
    return { success: true };
  }

  try {
    return JSON.parse(stdout);
  } catch {
    return { success: true, output: stdout };
  }
}

async function executeSkill(skillName, action, params = {}, context = {}) {
  const skill = loadSkills()[skillName];
  if (!skill) {
    throw new Error(`Skill not found: ${skillName}`);
  }

  if (skill.hasEntry) {
    return executeEntryModule(skill, action, params, context);
  }

  const actionScript = findScriptForAction(skill, action);
  if (actionScript) {
    return runScript(path.join(skill.scriptsDir, actionScript), skill.path, action, params, context);
  }

  return {
    skill: skillName,
    runtime: skill.meta.runtime,
    description: skill.meta.description,
    availableActions: skill.meta.actions,
    details: skill.skillMd?.body?.slice(0, 1600) || null,
  };
}

function renderRegistry() {
  const skills = listSkills();
  const lines = [];
  lines.push("# Skills Registry");
  lines.push("");
  lines.push(`Generated from live skill discovery. Total: ${skills.length} skills.`);
  lines.push("");
  for (const skill of skills) {
    lines.push(`## ${skill.name}`);
    lines.push("");
    lines.push(`- **ID:** \`${skill.id}\``);
    lines.push(`- **Type:** ${skill.type}`);
    lines.push(`- **Runtime:** ${skill.runtime}`);
    lines.push(`- **Operational:** ${skill.hasEntry ? "yes" : "no"}`);
    lines.push(`- **Has SKILL.md:** ${skill.hasSkillMd ? "yes" : "no"}`);
    lines.push(`- **Has manifest:** ${skill.hasManifest ? "yes" : "no"}`);
    lines.push(`- **Has scripts:** ${skill.hasScripts ? "yes" : "no"}`);
    lines.push(`- **Description:** ${skill.description || "No description"}`);
    lines.push(`- **Actions:** ${skill.actions.length > 0 ? skill.actions.join(", ") : "N/A"}`);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function syncRegistry(outPath = path.join(SKILLS_DIR, "REGISTRY.md")) {
  const content = renderRegistry();
  fs.writeFileSync(outPath, content, "utf8");
  return {
    success: true,
    path: outPath,
    skillCount: listSkills().length,
  };
}

export {
  loadSkills,
  listSkills,
  getSkillInfo,
  getSkillDetails,
  executeSkill,
  renderRegistry,
  syncRegistry,
};
