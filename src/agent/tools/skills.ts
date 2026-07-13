import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';
import {
  auditSharedSkills,
  executeSharedSkill,
  getSharedSkillDetails,
  listSharedSkills,
  suggestSharedSkills,
} from '../../skills/runtime.js';

function stringifyResult(value: unknown, maxChars = 12000): string {
  if (typeof value === 'string') return value.slice(0, maxChars);
  const json = JSON.stringify(value, null, 2);
  return json.length > maxChars ? `${json.slice(0, maxChars)}\n\n(truncated)` : json;
}

export const skillsListTool: ToolDefinition = {
  name: 'skills_list',
  description: 'List shared skills available under home23/workspace/skills. Includes category and trigger metadata so you can discover the right canonical skill before reading or running it.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional case-insensitive substring filter on skill ID, name, or description' },
      runtime: { type: 'string', description: 'Optional runtime filter: docs or nodejs' },
      limit: { type: 'number', description: 'Max results to return (default 20)' },
    },
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const allSkills = await listSharedSkills(ctx.projectRoot, ctx);
    const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
    const runtime = typeof input.runtime === 'string' ? input.runtime.toLowerCase() : '';
    const limit = Math.max(1, Math.min(Number(input.limit || 20), 50));

    const filtered = allSkills
      .filter((raw) => typeof raw === 'object' && raw !== null)
      .map((raw) => raw as Record<string, unknown>)
      .filter((skill) => {
        const haystack = [
          String(skill.id ?? ''),
          String(skill.displayName ?? ''),
          String(skill.description ?? ''),
        ].join(' ').toLowerCase();
        const skillRuntime = String(skill.runtime ?? '').toLowerCase();
        if (query && !haystack.includes(query)) return false;
        if (runtime && skillRuntime !== runtime) return false;
        return true;
      })
      .slice(0, limit);

    if (filtered.length === 0) {
      return { content: 'No shared skills matched.' };
    }

    const lines = filtered.map((skill) => {
      const actions = Array.isArray(skill.actions) ? skill.actions.join(', ') : 'N/A';
      const category = String(skill.category ?? 'general');
      const triggers = Array.isArray(skill.triggers) ? skill.triggers.length : 0;
      return `- ${skill.id} [${category}] [${skill.runtime}]${skill.hasEntry ? ' executable' : ' docs'}: ${skill.description}\n  actions: ${actions}\n  triggers: ${triggers}`;
    });

    return { content: `Shared skills (${filtered.length}):\n${lines.join('\n')}` };
  },
};

export const skillsGetTool: ToolDefinition = {
  name: 'skills_get',
  description: 'Inspect one shared skill: manifest fields, available actions, and an excerpt from SKILL.md.',
  input_schema: {
    type: 'object',
    properties: {
      skillId: { type: 'string', description: 'Shared skill ID (for example: x, browser-automation)' },
      max_chars: { type: 'number', description: 'Max chars from SKILL.md body to include (default 2500)' },
    },
    required: ['skillId'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const skillId = String(input.skillId || '');
    const maxChars = Math.max(500, Math.min(Number(input.max_chars || 2500), 12000));
    const details = await getSharedSkillDetails(ctx.projectRoot, skillId, ctx);

    if (!details || typeof details !== 'object') {
      return { content: `Skill not found: ${skillId}`, is_error: true };
    }

    const record = details as Record<string, unknown>;
    const body = typeof record.body === 'string' ? record.body.slice(0, maxChars) : null;
    const payload = {
      ...record,
      body,
    };

    return { content: stringifyResult(payload) };
  },
};

export const skillsSuggestTool: ToolDefinition = {
  name: 'skills_suggest',
  description: 'Suggest the best shared skills for a task description using trigger phrases, keywords, categories, and actions.',
  input_schema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Task or intent to match against the shared skills library' },
      limit: { type: 'number', description: 'Max suggestions to return (default 5)' },
    },
    required: ['task'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = String(input.task || '');
    const limit = Math.max(1, Math.min(Number(input.limit || 5), 20));
    const suggestions = await suggestSharedSkills(ctx.projectRoot, task, ctx);
    const list = suggestions
      .filter((raw) => typeof raw === 'object' && raw !== null)
      .map((raw) => raw as Record<string, unknown>)
      .slice(0, limit);

    if (list.length === 0) {
      return { content: 'No strong shared skill matches found.' };
    }

    const lines = list.map((item, index) => {
      const reasons = Array.isArray(item.reasons) ? item.reasons.join('; ') : 'no reasons captured';
      return `${index + 1}. ${item.id} score=${item.score} [${item.category}] - ${item.description}\n   reasons: ${reasons}`;
    });

    return { content: `Skill suggestions for "${task}":\n${lines.join('\n')}` };
  },
};

export const skillsAuditTool: ToolDefinition = {
  name: 'skills_audit',
  description: 'Audit the shared skills library for metadata quality, section coverage, hook safety, composition hints, and undertrigger risk from telemetry.',
  input_schema: {
    type: 'object',
    properties: {
      skillId: { type: 'string', description: 'Optional single skill ID to audit' },
      telemetryDays: { type: 'number', description: 'Lookback window for telemetry-based checks (default 30)' },
    },
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const result = await auditSharedSkills(ctx.projectRoot, {
      skillId: input.skillId,
      telemetryDays: input.telemetryDays,
    }, ctx);

    if (!result || typeof result !== 'object') {
      return { content: 'Shared skills audit is unavailable.', is_error: true };
    }

    const payload = result as Record<string, unknown>;
    const audits = Array.isArray(payload.skills) ? payload.skills as Array<Record<string, unknown>> : [];
    const lines = audits.slice(0, 20).map((audit) => {
      const issues = Array.isArray(audit.issues) ? audit.issues.slice(0, 3).join(' | ') : 'none';
      return `- ${audit.id}: score=${audit.score}, status=${audit.status}, undertrigger=${audit.undertriggerRisk}\n  issues: ${issues}`;
    });

    const summary = payload.summary && typeof payload.summary === 'object'
      ? stringifyResult(payload.summary, 1600)
      : 'No summary';

    return { content: `Skills audit summary:\n${summary}\n\n${lines.join('\n')}` };
  },
};

export const skillsRunTool: ToolDefinition = {
  name: 'skills_run',
  description: 'Run an action from a shared skill. Use skills_get first if you need the action contract or the skill is docs-only.',
  input_schema: {
    type: 'object',
    properties: {
      skillId: { type: 'string', description: 'Shared skill ID' },
      action: { type: 'string', description: 'Action to run' },
      input: {
        type: 'object', additionalProperties: true,
        description: 'JSON object passed to the skill action',
      },
    },
    required: ['skillId', 'action'],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const skillId = String(input.skillId || '');
    const action = String(input.action || '');
    const payload = typeof input.input === 'object' && input.input !== null
      ? input.input as Record<string, unknown>
      : {};

    try {
      const result = await executeSharedSkill(ctx.projectRoot, skillId, action, payload, ctx);
      return { content: stringifyResult(result) };
    } catch (err) {
      return {
        content: `Skill run failed (${skillId}.${action}): ${err instanceof Error ? err.message : String(err)}`,
        is_error: true,
      };
    }
  },
};
