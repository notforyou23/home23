/**
 * Compatibility CommonJS wrapper.
 * Delegates to the canonical ESM loader at ./skill-loader.js.
 */

const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function loadModule() {
  return import(pathToFileURL(path.join(__dirname, "skill-loader.js")).href);
}

module.exports = {
  async loadSkills() {
    const mod = await loadModule();
    return mod.loadSkills();
  },
  async listSkills() {
    const mod = await loadModule();
    return mod.listSkills();
  },
  async getSkillInfo(skillId) {
    const mod = await loadModule();
    return mod.getSkillInfo(skillId);
  },
  async getSkillDetails(skillId) {
    const mod = await loadModule();
    return mod.getSkillDetails(skillId);
  },
  async suggestSkills(task, options) {
    const mod = await loadModule();
    return mod.suggestSkills(task, options);
  },
  async auditSkills(options) {
    const mod = await loadModule();
    return mod.auditSkills(options);
  },
  async executeSkill(skillId, action, params) {
    const mod = await loadModule();
    return mod.executeSkill(skillId, action, params);
  },
  async syncRegistry() {
    const mod = await loadModule();
    return mod.syncRegistry();
  },
};
