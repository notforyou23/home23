/**
 * Home23 Skills System - Main Entry Point
 * Shared interface for first-class skills under workspace/skills/
 */

import {
  loadSkills,
  listSkills,
  getSkillInfo,
  getSkillDetails,
  suggestSkills,
  auditSkills,
  executeSkill,
  syncRegistry,
} from "./skill-loader.js";

export {
  loadSkills,
  listSkills,
  getSkillInfo,
  getSkillDetails,
  suggestSkills,
  auditSkills,
  executeSkill,
  syncRegistry,
};

const isMain = import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  const args = process.argv.slice(2);
  const command = args[0] ?? "list";

  if (command === "list") {
    const skills = listSkills();
    console.log("Available Skills:\n");
    for (const skill of skills) {
      const badge = skill.runtime === "nodejs" && skill.hasEntry ? "[exec]" : "[docs]";
      console.log(`${badge} ${skill.name}`);
      console.log(`   ${skill.description || "No description"}`);
      console.log(`   Actions: ${skill.actions.length > 0 ? skill.actions.join(", ") : "N/A"}\n`);
    }
    console.log(`Total: ${skills.length} skills`);
    process.exit(0);
  }

  if (command === "info" && args[1]) {
    console.log(JSON.stringify(getSkillDetails(args[1]), null, 2));
    process.exit(0);
  }

  if (command === "run" && args[1] && args[2]) {
    const skillId = args[1];
    const action = args[2];
    const params = args[3] ? JSON.parse(args[3]) : {};

    try {
      const result = await executeSkill(skillId, action, params);
      if (typeof result === "string") {
        console.log(result);
      } else {
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (err) {
      console.error("Error:", err.message);
      process.exit(1);
    }
    process.exit(0);
  }

  if ((command === "suggest" || command === "match") && args[1]) {
    const task = args.slice(1).join(" ");
    console.log(JSON.stringify(suggestSkills(task), null, 2));
    process.exit(0);
  }

  if (command === "audit" || command === "qc") {
    const skillId = args[1] || undefined;
    console.log(JSON.stringify(auditSkills({ skillId }), null, 2));
    process.exit(0);
  }

  if (command === "registry") {
    const result = syncRegistry();
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.log(`Usage:
  node workspace/skills/index.js list
  node workspace/skills/index.js info <skill>
  node workspace/skills/index.js suggest <task>
  node workspace/skills/index.js audit [skill]
  node workspace/skills/index.js run <skill> <action> [jsonParams]
  node workspace/skills/index.js registry`);
  process.exit(1);
}
