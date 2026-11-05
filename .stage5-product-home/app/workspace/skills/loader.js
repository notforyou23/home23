/**
 * Compatibility re-export.
 * Use ./skill-loader.js as the canonical implementation.
 */

export {
  loadSkills,
  listSkills,
  getSkillInfo,
  getSkillDetails,
  suggestSkills,
  auditSkills,
  executeSkill,
  syncRegistry,
} from "./skill-loader.js";
