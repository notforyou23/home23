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
const SUPPORT_DIRS = new Set(["_archived", ".telemetry"]);
const SCRIPT_EXTS = new Set([".js", ".mjs", ".sh", ".py"]);
const SIDE_EFFECT_ACTIONS = new Set(["post", "reply", "delete", "publish", "send", "write", "mutate"]);

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

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeHooks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const hooks = {};
  for (const [key, hookPath] of Object.entries(value)) {
    if (typeof hookPath === "string" && hookPath.trim()) {
      hooks[key] = hookPath.trim();
    }
  }
  return hooks;
}

function getSkillDirs() {
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith(".") && !SUPPORT_DIRS.has(name))
    .sort();
}

function normalizeActions(manifest, skillMdMeta, scriptsDir) {
  const manifestActions = normalizeStringArray(manifest?.actions);
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

  const hooks = normalizeHooks(manifest?.hooks || skillMd?.meta?.hooks);
  const actions = normalizeActions(manifest, skillMd?.meta, scriptsDir);
  const meta = {
    id: manifest?.id || skillMd?.meta?.id || name,
    name: manifest?.name || skillMd?.meta?.name || name,
    version: manifest?.version || skillMd?.meta?.version || "0.0.0",
    description: manifest?.description || skillMd?.meta?.description || "",
    author: manifest?.author || skillMd?.meta?.author || "",
    entry: manifest?.entry || "index.js",
    layer: manifest?.layer || skillMd?.meta?.layer || "skill",
    runtime: manifest?.runtime || skillMd?.meta?.runtime || (fs.existsSync(entryPath) ? "nodejs" : "docs"),
    category: manifest?.category || skillMd?.meta?.category || "general",
    keywords: normalizeStringArray(manifest?.keywords || skillMd?.meta?.keywords),
    triggers: normalizeStringArray(manifest?.triggers || skillMd?.meta?.triggers),
    requiresTools: normalizeStringArray(manifest?.requiresTools || skillMd?.meta?.requiresTools || skillMd?.meta?.requires_tools),
    dependsOn: normalizeStringArray(manifest?.dependsOn || skillMd?.meta?.dependsOn || skillMd?.meta?.depends_on),
    composes: normalizeStringArray(manifest?.composes || skillMd?.meta?.composes),
    hooks,
    actions,
    sideEffects: Boolean(manifest?.sideEffects || skillMd?.meta?.sideEffects || actions.some((action) => SIDE_EFFECT_ACTIONS.has(action))),
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
    category: skill.meta.category,
    keywords: skill.meta.keywords,
    triggers: skill.meta.triggers,
    requiresTools: skill.meta.requiresTools,
    dependsOn: skill.meta.dependsOn,
    composes: skill.meta.composes,
    hookNames: Object.keys(skill.meta.hooks),
    sideEffects: skill.meta.sideEffects,
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
    category: skill.meta.category,
    entry: skill.meta.entry,
    actions: skill.meta.actions,
    keywords: skill.meta.keywords,
    triggers: skill.meta.triggers,
    requiresTools: skill.meta.requiresTools,
    dependsOn: skill.meta.dependsOn,
    composes: skill.meta.composes,
    hooks: skill.meta.hooks,
    sideEffects: skill.meta.sideEffects,
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

function telemetryDir() {
  return path.join(SKILLS_DIR, ".telemetry");
}

function readTelemetryEvents(telemetryDays = 30) {
  const dir = telemetryDir();
  if (!fs.existsSync(dir)) return [];
  const cutoff = Date.now() - (telemetryDays * 24 * 60 * 60 * 1000);
  const events = [];

  for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith(".jsonl")).sort()) {
    const filePath = path.join(dir, file);
    const raw = fs.readFileSync(filePath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const ts = new Date(event.ts || 0).getTime();
        if (!Number.isNaN(ts) && ts >= cutoff) {
          events.push(event);
        }
      } catch {
        // ignore malformed telemetry
      }
    }
  }

  return events;
}

function resolveHookPath(skill, hookRef) {
  return path.resolve(skill.path, hookRef);
}

async function runHookModule(hookPath, hookName, payload) {
  const ext = path.extname(hookPath);

  if (ext === ".js" || ext === ".mjs") {
    const mod = await import(pathToFileURL(hookPath).href);
    const fn = mod[hookName] || mod.run || mod.default;
    if (typeof fn !== "function") {
      throw new Error(`Hook '${hookName}' in ${hookPath} must export a function`);
    }
    return await fn(payload);
  }

  if (ext === ".sh" || ext === ".py") {
    const env = {
      ...process.env,
      HOME23_SKILL_HOOK: hookName,
      HOME23_SKILL_HOOK_PAYLOAD: JSON.stringify(payload),
    };
    const command = ext === ".sh" ? "bash" : "python3";
    const result = spawnSync(command, [hookPath], { cwd: path.dirname(hookPath), env, encoding: "utf8" });
    if (result.status !== 0) {
      throw new Error(result.stderr?.trim() || result.stdout?.trim() || `Hook failed with code ${result.status}`);
    }
    const stdout = result.stdout?.trim() || "";
    if (!stdout) return null;
    try {
      return JSON.parse(stdout);
    } catch {
      return { notes: [stdout] };
    }
  }

  throw new Error(`Unsupported hook extension '${ext}'`);
}

async function runHook(skill, hookName, payload) {
  const hookRef = skill.meta.hooks[hookName];
  if (!hookRef) return null;
  return runHookModule(resolveHookPath(skill, hookRef), hookName, payload);
}

function mergeNotesIntoResult(result, notes) {
  if (!notes || notes.length === 0) return result;

  if (typeof result === "string") {
    return `${result}\n\n[skill notes]\n- ${notes.join("\n- ")}`;
  }

  if (result && typeof result === "object" && !Array.isArray(result)) {
    const existing = Array.isArray(result._skillNotes) ? result._skillNotes : [];
    return { ...result, _skillNotes: [...existing, ...notes] };
  }

  return { result, _skillNotes: notes };
}

async function executeEntryModule(skill, action, params, context) {
  // Cache-bust entry modules by mtime so live skill edits take effect without
  // restarting the Home23 process. Static import caching otherwise preserves
  // stale behavior for the lifetime of the skill runner.
  const mtimeMs = fs.statSync(skill.entryPath).mtimeMs;
  const mod = await import(`${pathToFileURL(skill.entryPath).href}?mtime=${mtimeMs}`);

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

  const hookPayload = {
    skill: getSkillInfo(skillName),
    action,
    params,
    context: sanitizeContextForScripts(context),
  };

  const before = await runHook(skill, "beforeRun", hookPayload);
  if (before?.cancel) {
    throw new Error(before.reason || `Execution cancelled by ${skillName} beforeRun hook`);
  }

  const effectiveParams = before?.params && typeof before.params === "object"
    ? before.params
    : params;
  const notes = Array.isArray(before?.notes) ? [...before.notes] : [];

  try {
    let result;
    if (skill.hasEntry) {
      result = await executeEntryModule(skill, action, effectiveParams, context);
    } else {
      const actionScript = findScriptForAction(skill, action);
      if (actionScript) {
        result = runScript(path.join(skill.scriptsDir, actionScript), skill.path, action, effectiveParams, context);
      } else {
        result = {
          skill: skillName,
          runtime: skill.meta.runtime,
          description: skill.meta.description,
          availableActions: skill.meta.actions,
          details: skill.skillMd?.body?.slice(0, 1600) || null,
        };
      }
    }

    const after = await runHook(skill, "afterRun", {
      ...hookPayload,
      params: effectiveParams,
      result,
    });
    const finalResult = after && Object.prototype.hasOwnProperty.call(after, "result")
      ? after.result
      : result;
    const finalNotes = [
      ...notes,
      ...(Array.isArray(after?.notes) ? after.notes : []),
    ];
    return mergeNotesIntoResult(finalResult, finalNotes);
  } catch (err) {
    const onError = await runHook(skill, "onError", {
      ...hookPayload,
      params: effectiveParams,
      error: err instanceof Error ? err.message : String(err),
    });
    if (onError?.swallow && Object.prototype.hasOwnProperty.call(onError, "result")) {
      return mergeNotesIntoResult(onError.result, onError.notes || []);
    }
    if (onError?.error) {
      throw new Error(onError.error);
    }
    throw err;
  }
}

function scoreSkillForTask(skill, task) {
  const text = String(task || "").toLowerCase();
  const words = new Set(text.match(/[a-z0-9_-]+/g) || []);
  let score = 0;
  const reasons = [];

  for (const trigger of skill.meta.triggers) {
    const normalized = trigger.toLowerCase();
    if (normalized && text.includes(normalized)) {
      score += 12;
      reasons.push(`trigger: ${trigger}`);
    }
  }

  for (const keyword of skill.meta.keywords) {
    const normalized = keyword.toLowerCase();
    if (!normalized) continue;
    const keyWords = normalized.split(/\s+/).filter(Boolean);
    if (keyWords.every((word) => words.has(word) || text.includes(word))) {
      score += keyWords.length > 1 ? 5 : 3;
      reasons.push(`keyword: ${keyword}`);
    }
  }

  for (const action of skill.meta.actions) {
    const normalized = action.toLowerCase();
    if (words.has(normalized) || text.includes(normalized.replace(/-/g, " "))) {
      score += 2;
      reasons.push(`action: ${action}`);
    }
  }

  const categoryWords = skill.meta.category.toLowerCase().split(/\s+/).filter(Boolean);
  if (categoryWords.some((word) => words.has(word))) {
    score += 2;
    reasons.push(`category: ${skill.meta.category}`);
  }

  const descriptionWords = String(skill.meta.description || "").toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
  const sharedDescriptionTerms = descriptionWords.filter((word) => word.length > 4 && words.has(word));
  if (sharedDescriptionTerms.length > 0) {
    score += Math.min(sharedDescriptionTerms.length, 3);
    reasons.push(`description terms: ${sharedDescriptionTerms.join(", ")}`);
  }

  return {
    id: skill.id,
    name: skill.meta.name,
    category: skill.meta.category,
    runtime: skill.meta.runtime,
    description: skill.meta.description,
    actions: skill.meta.actions,
    score,
    reasons: [...new Set(reasons)],
  };
}

function suggestSkills(task, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 5), 20));
  const suggestions = Object.values(loadSkills())
    .map((skill) => scoreSkillForTask(skill, task))
    .filter((skill) => skill.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);

  return suggestions;
}

function checkSection(body, heading) {
  return new RegExp(`^##\\s+${heading}\\b`, "im").test(body);
}

function buildUsageSummary(skillId, telemetryEvents) {
  const matching = telemetryEvents.filter((event) => event.skillId === skillId);
  const suggestCount = matching.filter((event) => event.event === "skills_suggest").length;
  const runEvents = matching.filter((event) => event.event === "skills_run");
  const runCount = runEvents.filter((event) => event.success !== false).length;
  const failureCount = runEvents.filter((event) => event.success === false).length;
  const lastUsedAt = runEvents.length > 0 ? runEvents[runEvents.length - 1].ts : null;

  return {
    suggestCount,
    runCount,
    failureCount,
    lastUsedAt,
  };
}

function buildSkillAudit(skill, telemetryEvents) {
  const body = skill.skillMd?.body || "";
  const checks = {
    hasCategory: Boolean(skill.meta.category && skill.meta.category !== "general"),
    hasTriggers: skill.meta.triggers.length >= 3,
    hasKeywords: skill.meta.keywords.length >= 4,
    hasWhenToUse: checkSection(body, "When to use"),
    hasActionsOrWorkflow: checkSection(body, "Actions") || checkSection(body, "Workflow"),
    hasGotchas: checkSection(body, "Gotchas"),
    hasExamples: /```/.test(body) || checkSection(body, "Examples"),
    hasCompositionHints: skill.meta.requiresTools.length > 0 || skill.meta.dependsOn.length > 0 || skill.meta.composes.length > 0,
    hooksForSideEffects: !skill.meta.sideEffects || Object.keys(skill.meta.hooks).length > 0,
  };
  const usage = buildUsageSummary(skill.id, telemetryEvents);
  let score = 100;
  const issues = [];
  const recommendations = [];

  function addIssue(message, penalty, recommendation) {
    score -= penalty;
    issues.push(message);
    if (recommendation) recommendations.push(recommendation);
  }

  if (skill.meta.description.length < 50) {
    addIssue("Description is too short to serve as strong trigger text.", 8, "Rewrite the description as a clear use-when trigger.");
  }
  if (!checks.hasCategory) {
    addIssue("Missing category metadata.", 8, "Add a concrete category like research, coding, automation, browser, or social.");
  }
  if (!checks.hasTriggers) {
    addIssue("Trigger phrases are too weak or missing.", 14, "Add at least 3 trigger phrases that match real user asks.");
  }
  if (!checks.hasKeywords) {
    addIssue("Keyword coverage is thin.", 8, "Add keywords for nouns and verbs users will actually say.");
  }
  if (!checks.hasWhenToUse) {
    addIssue("SKILL.md is missing a 'When to use' section.", 10, "Add a concise routing section so the model knows when to reach for the skill.");
  }
  if (!checks.hasActionsOrWorkflow) {
    addIssue("SKILL.md is missing an actions or workflow section.", 12, "Describe the available actions or the execution workflow.");
  }
  if (!checks.hasGotchas) {
    addIssue("SKILL.md is missing gotchas.", 12, "Add the specific failure modes or edge cases the model is likely to miss.");
  }
  if (!checks.hasExamples) {
    addIssue("SKILL.md lacks examples or concrete input blocks.", 10, "Add a JSON input example or a small usage example.");
  }
  if (!checks.hasCompositionHints) {
    addIssue("Manifest has no composition hints.", 6, "Add requiresTools, dependsOn, or composes metadata.");
  }
  if (!checks.hooksForSideEffects) {
    addIssue("Side-effecting skill has no safety hook.", 15, "Add a beforeRun hook that blocks unsafe writes unless explicitly confirmed.");
  }

  let undertriggerRisk = "low";
  if (usage.runCount === 0 && (!checks.hasTriggers || !checks.hasKeywords)) {
    undertriggerRisk = "high";
    recommendations.push("This skill may be hard for the agent to find. Improve trigger phrases and keywords.");
  } else if (usage.runCount === 0) {
    undertriggerRisk = "medium";
    recommendations.push("Telemetry shows no successful runs yet. Validate whether routing text is strong enough.");
  }

  const status = score >= 90 ? "strong" : score >= 75 ? "good" : score >= 60 ? "needs-work" : "weak";

  return {
    id: skill.id,
    score: Math.max(0, score),
    status,
    undertriggerRisk,
    usage,
    checks,
    issues: [...new Set(issues)],
    recommendations: [...new Set(recommendations)],
  };
}

function auditSkills(options = {}) {
  const telemetryDays = Math.max(1, Math.min(Number(options.telemetryDays || 30), 365));
  const requestedSkillId = typeof options.skillId === "string" ? options.skillId : "";
  const allSkills = loadSkills();
  const selected = requestedSkillId
    ? Object.values(allSkills).filter((skill) => skill.id === requestedSkillId)
    : Object.values(allSkills);
  const telemetryEvents = readTelemetryEvents(telemetryDays);
  const audits = selected
    .map((skill) => buildSkillAudit(skill, telemetryEvents))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));

  return {
    generatedAt: new Date().toISOString(),
    telemetryDays,
    summary: {
      skillCount: audits.length,
      strongCount: audits.filter((audit) => audit.status === "strong").length,
      needsWorkCount: audits.filter((audit) => audit.status === "needs-work" || audit.status === "weak").length,
      highUndertriggerCount: audits.filter((audit) => audit.undertriggerRisk === "high").length,
    },
    skills: audits,
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
    lines.push(`- **Category:** ${skill.category}`);
    lines.push(`- **Operational:** ${skill.hasEntry ? "yes" : "no"}`);
    lines.push(`- **Has SKILL.md:** ${skill.hasSkillMd ? "yes" : "no"}`);
    lines.push(`- **Has manifest:** ${skill.hasManifest ? "yes" : "no"}`);
    lines.push(`- **Has scripts:** ${skill.hasScripts ? "yes" : "no"}`);
    lines.push(`- **Hooks:** ${skill.hookNames.length > 0 ? skill.hookNames.join(", ") : "none"}`);
    lines.push(`- **Description:** ${skill.description || "No description"}`);
    lines.push(`- **Actions:** ${skill.actions.length > 0 ? skill.actions.join(", ") : "N/A"}`);
    lines.push(`- **Triggers:** ${skill.triggers.length > 0 ? skill.triggers.join(" | ") : "N/A"}`);
    lines.push(`- **Requires tools:** ${skill.requiresTools.length > 0 ? skill.requiresTools.join(", ") : "none"}`);
    lines.push(`- **Composes:** ${skill.composes.length > 0 ? skill.composes.join(", ") : "none"}`);
    lines.push(`- **Depends on:** ${skill.dependsOn.length > 0 ? skill.dependsOn.join(", ") : "none"}`);
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
  suggestSkills,
  auditSkills,
  executeSkill,
  renderRegistry,
  syncRegistry,
};
