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
  operatingContract: {
    autonomousDomains: [
      'inbox_triage_and_noise_discard',
      'pursuit_triage_and_attention_governance',
      'memory_truth_and_claim_decay',
      'private_scratch_notes',
      'local_receipts_and_state_snapshots',
      'low_risk_cron_binding_and_review',
      'worker_delegation_with_receipts',
      'dashboard_contract_drafts',
    ],
    approvalDomains: [
      'public_publication_or_external_posting',
      'destructive_operations',
      'spending_money',
      'broad_production_changes',
      'sensitive_personal_or_health_decisions',
      'irreversible_state_changes',
      'credentials_or_private_account_access',
    ],
    acceptableAutonomousChanges: [
      'create_update_close_watch_or_pursuit_records',
      'record_claims_memory_candidates_and_private_scratch',
      'discard_or_demote_noisy_inputs_with_receipts',
      'propose_or_apply_reversible_l0_l2_state_deltas',
      'bind_or_review_recurring_crons_against_pursuits',
      'delegate_worker_tasks_with_stop_conditions',
      'update_dashboard_or_prompt_contract_state',
    ],
    hardRiskBoundaries: [
      'no_l4_action_without_explicit_human_approval',
      'no_public_posting_without_approval',
      'no_destructive_filesystem_or_git_action_without_approval',
      'no_spending_or_external_purchase_without_approval',
      'no_sensitive_health_or_personal_decision_without_approval',
      'no_broad_production_change_without_receipt_and_approval',
    ],
    decisionThresholds: {
      actAutonomously: 'reversible_low_risk_l0_l2_with_receipts',
      ask: 'value_depends_on_jtr_taste_judgment_or_private_context',
      escalate: 'public_irreversible_destructive_spend_or_l4',
      defer: 'unclear_low_value_or_attention_budget_exhausted',
      discard: 'noisy_stale_or_no_declared_consequence',
    },
    goodPursuit: {
      requiredFields: [
        'why_it_matters',
        'current_theory',
        'latest_evidence',
        'next_move',
        'owner',
        'authority_level',
        'stop_condition',
        'attention_budget',
        'what_would_change_my_mind',
      ],
      qualityBar: [
        'declares_changed_future',
        'has_receipt_or_source_evidence',
        'has_bounded_next_move',
        'has_explicit_stop_condition',
        'can_be_closed_or_demoted',
      ],
    },
    interruptJtrWhen: [
      'authority_level_l3_or_l4_is_needed',
      'operator_taste_or_private_context_controls_value',
      'unresolved_high_authority_truth_contradiction_blocks_action',
      'low_risk_path_is_not_reversible',
      'resident_loop_hits_repeated_blocker',
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
  organs: {
    step24: {
      kind: 'observation_bus',
      canSense: ['system telemetry', 'domain observations', 'live channel events'],
      canChange: ['agency inbox candidates', 'observation receipts'],
      reports: ['observations', 'source references', 'confidence'],
      mustNeverDoAlone: ['treat telemetry as personal diagnosis', 'execute actions'],
      failureSurface: 'agency inbox receipts and engine logs',
      commandSurface: 'engine channel configuration',
    },
    crons: {
      kind: 'scheduler',
      canSense: ['cron reports', 'scheduler outcomes', 'recurring job failures'],
      canChange: ['bounded schedules', 'scheduler receipts', 'job enablement state'],
      reports: ['cron decisions', 'run logs', 'agency world-stream packets'],
      mustNeverDoAlone: ['create recurring work without pursuit binding', 'publish externally', 'perform destructive action'],
      failureSurface: 'cron run receipts and agency consequences',
      commandSurface: 'cron tools and scheduler APIs',
    },
    workers: {
      kind: 'delegated_hands',
      canSense: ['worker receipts', 'artifacts', 'verifier output'],
      canChange: ['bounded local artifacts', 'memory candidates', 'pursuit evidence'],
      reports: ['worker receipts', 'artifact references', 'verifier status'],
      mustNeverDoAlone: ['perform L4 actions', 'claim completion without receipt', 'bypass authority policy'],
      failureSurface: 'worker receipts and agency consequences',
      commandSurface: 'worker connector and agency tools',
    },
    research: {
      kind: 'extended_cognition',
      canSense: ['COSMO research outputs', 'queries', 'compiled briefs'],
      canChange: ['watch items', 'claims', 'research pursuits'],
      reports: ['research packets', 'artifacts', 'contradictions'],
      mustNeverDoAlone: ['become the agency center', 'replace current verified state'],
      failureSurface: 'research receipts and truth contradictions',
      commandSurface: 'research tools through chat authority bridge',
    },
    brain: {
      kind: 'memory',
      canSense: ['current state snapshots', 'claims', 'pursuit evidence'],
      canChange: ['durable claims', 'state snapshots', 'memory candidates'],
      reports: ['retrieval results', 'truth hierarchy status'],
      mustNeverDoAlone: ['override newer verified state', 'hide unresolved contradictions'],
      failureSurface: 'truth receipts and retrieval diagnostics',
      commandSurface: 'memory and claim APIs',
    },
    chat: {
      kind: 'mouth_and_authority_bridge',
      canSense: ['jtr messages', 'links', 'corrections', 'commands'],
      canChange: ['pursuits through tools', 'claims through corrections', 'authority requests'],
      reports: ['operator replies', 'tool receipts'],
      mustNeverDoAlone: ['be the source of truth over engine state', 'punt low-risk reversible decisions by default'],
      failureSurface: 'conversation receipts and agency inbox',
      commandSurface: 'agency tools and operator conversation',
    },
    dashboard: {
      kind: 'operator_surface',
      canSense: ['agency state', 'receipts', 'consequences', 'pursuits'],
      canChange: ['operator inspection focus'],
      reports: ['evidence chains', 'attention caps', 'authority posture'],
      mustNeverDoAlone: ['be ornamental', 'mask missing receipts'],
      failureSurface: 'dashboard route checks and agency events',
      commandSurface: 'local dashboard APIs',
    },
  },
  editor: {
    repeatedNewsletterSkeleton: ['feedback loop', 'becoming', 'control loop'],
    dashboardAgencyClarityKinds: [
      'dashboard_panel',
      'dashboard_expansion',
      'dashboard_contract',
    ],
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
    operatingContract: merged.operatingContract && typeof merged.operatingContract === 'object'
      ? merged.operatingContract
      : DEFAULT_CHARTER.operatingContract,
    sourceTruthHierarchy: Array.isArray(merged.sourceTruthHierarchy)
      ? merged.sourceTruthHierarchy
      : DEFAULT_CHARTER.sourceTruthHierarchy,
    organs: merged.organs && typeof merged.organs === 'object'
      ? merged.organs
      : DEFAULT_CHARTER.organs,
  };
}

export { DEFAULT_CHARTER };
