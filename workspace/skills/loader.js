/**
 * Compatibility re-export.
 * Use ./skill-loader.js as the canonical implementation.
 */

export {
  loadSkills,
  listSkills,
  getSkillInfo,
  getSkillDetails,
  executeSkill,
  syncRegistry,
} from "./skill-loader.js";
