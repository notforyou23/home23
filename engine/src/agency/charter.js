import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

const DEFAULT_CHARTER = Object.freeze({
  schema: 'home23.agency.charter.v1',
  agent: 'jerry',
  mode: 'bootcamp',
  attention: {
    maxActivePursuits: 5,
    maxWatchItems: 20,
    maxDeferredItems: 200,
    staleAfterHours: 168,
    residentTickMs: 60_000,
  },
  bootcamp: {
    enabled: true,
    noOrnamentalNewsletter: true,
    noTimelineDeliveryWithoutAssimilation: true,
    noCurriculumWithoutBehaviorDelta: true,
    noDashboardExpansionWithoutAgencyClarity: true,
    noNewCronWithoutPursuit: true,
    weeklyKillReview: true,
  },
  authority: {
    autonomous: [
      'memory_watch_pursuit_updates',
      'reversible_local_notes',
      'low_risk_scheduling_adjustments',
      'worker_delegation',
      'noisy_input_discard_or_demotion',
      'draft_higher_risk_changes',
    ],
    requiresApproval: [
      'destructive_operations',
      'public_publication_or_posting',
      'spending_money',
      'broad_production_changes',
      'sensitive_personal_or_health_decisions',
      'irreversible_state_changes',
    ],
  },
  sourceTruthHierarchy: [
    'current_verified_state',
    'jtr_correction',
    'verifier_receipt',
    'worker_receipt',
    'source_artifact',
    'generated_doctrine',
    'narrative',
  ],
  editor: {
    repeatedNewsletterSkeleton: ['feedback loop', 'becoming', 'control loop'],
    requireConsequenceFor: [
      'newsletter_draft',
      'timeline_report',
      'research_summary',
      'cron_report',
      'curriculum_digestion',
    ],
  },
});

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) out[key] = [...value];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(base?.[key] && typeof base[key] === 'object' ? base[key] : {}, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function loadAgencyCharter({ charterPath = null, config = {}, agentName = 'jerry' } = {}) {
  let fileConfig = {};
  if (charterPath && existsSync(charterPath)) {
    fileConfig = yaml.load(readFileSync(charterPath, 'utf8')) || {};
  }
  const merged = deepMerge(deepMerge(DEFAULT_CHARTER, fileConfig), config.charter || {});
  return {
    ...merged,
    agent: merged.agent || agentName,
    attention: {
      ...DEFAULT_CHARTER.attention,
      ...(merged.attention || {}),
    },
    bootcamp: {
      ...DEFAULT_CHARTER.bootcamp,
      ...(merged.bootcamp || {}),
    },
    sourceTruthHierarchy: Array.isArray(merged.sourceTruthHierarchy)
      ? merged.sourceTruthHierarchy
      : DEFAULT_CHARTER.sourceTruthHierarchy,
  };
}

export { DEFAULT_CHARTER };
