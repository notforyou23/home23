/**
 * role-schemas — output contract for each cognitive phase role.
 *
 * Phase 0 defines structure + soft-mode validation (everything passes).
 * Phase 6 flips to strict and wires enforcement into thinking-machine
 * phase boundaries; outputs failing the schema are logged to
 * role-integrity-violations.jsonl and re-prompted.
 *
 * See docs/design/STEP24-OS-ENGINE-REDESIGN.md §The Role Integrity Contract.
 */

'use strict';

export const ROLE_SCHEMAS = Object.freeze({
  critic:    { required: ['claim', 'evidence_for', 'evidence_against', 'verdict', 'supporting_observations'] },
  discovery: { required: ['candidate', 'signal_type', 'supporting_observations', 'novelty_score'] },
  deep_dive: { required: ['candidate', 'lineage', 'observations_consulted', 'proposed_edges', 'open_questions'] },
  connect:   { required: ['source_node', 'target_node', 'weight', 'supporting_observations'] },
  curator:   { required: ['surface', 'proposed_text', 'source_observations', 'confidence'] },
});

const CRITIC_VERDICTS = new Set(['keep', 'revise', 'discard']);

export function validateRoleOutput(role, output, { strict = false } = {}) {
  const schema = ROLE_SCHEMAS[role];
  if (!schema) return { valid: false, reason: `unknown role: ${role}` };
  if (!strict) return { valid: true, reason: 'soft-mode: always pass' };
  if (!output || typeof output !== 'object') return { valid: false, reason: 'output must be object' };
  const missing = schema.required.filter((k) => !(k in output));
  if (missing.length) return { valid: false, reason: `missing fields: ${missing.join(', ')}` };

  if (role === 'critic') {
    if (!CRITIC_VERDICTS.has(output.verdict)) {
      return { valid: false, reason: 'critic verdict must be keep|revise|discard' };
    }
    if (!Array.isArray(output.supporting_observations)) {
      return { valid: false, reason: 'critic supporting_observations must be an array' };
    }
  }

  if (role === 'curator') {
    if (!Array.isArray(output.source_observations) || output.source_observations.length === 0) {
      return { valid: false, reason: 'curator must cite at least one source_observation' };
    }
  }

  return { valid: true };
}
