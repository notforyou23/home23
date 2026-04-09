/**
 * ethics-kernel.js - Phase 2 ethics decision kernel
 *
 * First real Phase 2 slice for COSMO 2.0.
 * Consumes Phase 1 signals and produces an auditable ethics decision
 * object that can be attached immediately after core scoring / decay passes.
 *
 * Attachment point:
 * - after Phase 1 confidence / legitimacy / contested / institutional signals
 *   are available for a node
 * - before higher-level orchestration decides to act autonomously
 *
 * @module core/ethics-kernel
 */

const { isNode } = require('./node-v2.js');
const { computeScore: computeStructuralImportance } = require('./structural-importance.js');
const {
  computeDecayPhase,
  getActivationThreshold,
  getResetThreshold,
} = require('./deinstitutionalization.js');

const ESCALATION_REASONS = Object.freeze({
  LOW_CONFIDENCE: 'low_confidence',
  CONTESTED: 'contested',
  INSTITUTIONAL_RESET: 'institutional_reset',
  HIGH_STAKES: 'high_stakes',
  LEGITIMACY_GAP: 'legitimacy_gap',
});

const STAKES = Object.freeze({
  LOW: 'low',
  MODERATE: 'moderate',
  HIGH: 'high',
  CRITICAL: 'critical',
});

const DEFAULT_THRESHOLDS = Object.freeze({
  salience: {
    high: 0.7,
    moderate: 0.45,
  },
  confidence: {
    low: 0.55,
    medium: 0.7,
  },
  legitimacy: {
    minimum: 0.45,
  },
  importance: {
    elevated: 0.45,
  },
});

const ETHICAL_KEYWORDS = Object.freeze({
  critical: [
    'suicide', 'self-harm', 'overdose', 'weapon', 'violence', 'abuse',
    'child', 'children', 'medical emergency', 'life support', 'murder',
    'kill', 'assault', 'trafficking'
  ],
  high: [
    'medical', 'diagnosis', 'treatment', 'prescription', 'finance',
    'fraud', 'legal', 'court', 'crime', 'police', 'privacy', 'surveillance',
    'biometric', 'employment', 'housing', 'discrimination', 'eviction',
    'immigration', 'safety'
  ],
  moderate: [
    'health', 'therapy', 'insurance', 'debt', 'identity', 'consent',
    'security', 'moderation', 'policy', 'ethics', 'trust', 'harm', 'risk'
  ],
});

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

function hasKeyword(text, keywords) {
  return keywords.some(keyword => text.includes(keyword));
}

function normalizeSignalNumber(value, fallback = 0) {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }

  return clamp(value);
}

function normalizeNode(node) {
  if (!node || typeof node !== 'object') {
    throw new TypeError('node must be an object');
  }

  if (isNode(node)) {
    return node;
  }

  const { id, type, label, metadata = {}, weight = 1 } = node;
  if (typeof id !== 'string' || !id) {
    throw new TypeError('node.id must be a non-empty string');
  }

  if (typeof type !== 'string' || !type) {
    throw new TypeError('node.type must be a non-empty string');
  }

  if (typeof label !== 'string' || !label) {
    throw new TypeError('node.label must be a non-empty string');
  }

  if (typeof metadata !== 'object' || metadata === null) {
    throw new TypeError('node.metadata must be an object');
  }

  if (typeof weight !== 'number' || Number.isNaN(weight)) {
    throw new TypeError('node.weight must be a number');
  }

  return node;
}

function extractPhase1Signals(node, signals = {}) {
  if (!signals || typeof signals !== 'object') {
    throw new TypeError('signals must be an object');
  }

  const legitimacyMeta = node.metadata?.legitimacy || {};
  const contestedMeta = node.metadata?.contested || {};

  const legitimacyScore = normalizeSignalNumber(
    signals.legitimacyScore ??
      legitimacyMeta.score ??
      legitimacyMeta.confidence_in_type ??
      legitimacyMeta.confidence ??
      0.5,
    0.5,
  );

  const confidence = normalizeSignalNumber(
    signals.confidence ?? signals.confidenceScore ?? legitimacyMeta.confidence_in_type ?? 0.5,
    0.5,
  );

  const institutionalStrength = normalizeSignalNumber(
    signals.institutionalStrength ??
      signals.currentStrength ??
      legitimacyMeta.deinstitutionalization_score ??
      node.weight ??
      0.5,
    node.weight ?? 0.5,
  );

  const contested = Boolean(
    signals.contested ??
    signals.isContested ??
    contestedMeta.is_contested ??
    contestedMeta.contested,
  );

  const dissentCount = Array.isArray(contestedMeta.dissenting_systems)
    ? contestedMeta.dissenting_systems.length
    : 0;

  const importanceResult = signals.importanceResult || {
    importance: computeStructuralImportance({
      inboundCount: signals.inboundCount ?? 0,
      outboundCount: signals.outboundCount ?? 0,
      centrality: signals.centrality ?? 0,
      pillarType: signals.pillarType ?? 'foundation',
      maxDegree: signals.maxDegree ?? 100,
    }),
  };

  return {
    legitimacyScore,
    confidence,
    institutionalStrength,
    contested,
    dissentCount,
    importance: normalizeSignalNumber(importanceResult.importance ?? importanceResult, 0),
    importanceResult,
    phase: computeDecayPhase(institutionalStrength),
    thresholds: {
      activation: getActivationThreshold(),
      reset: getResetThreshold(),
    },
  };
}

function computeEthicalSalience(node, phase1Signals) {
  const searchable = [
    node.label,
    node.type,
    JSON.stringify(node.metadata || {}),
  ].join(' ').toLowerCase();

  let keywordScore = 0;
  if (hasKeyword(searchable, ETHICAL_KEYWORDS.critical)) {
    keywordScore = 1.0;
  } else if (hasKeyword(searchable, ETHICAL_KEYWORDS.high)) {
    keywordScore = 0.8;
  } else if (hasKeyword(searchable, ETHICAL_KEYWORDS.moderate)) {
    keywordScore = 0.55;
  }

  const contestedBoost = phase1Signals.contested ? 0.15 : 0;
  const lowConfidenceBoost = phase1Signals.confidence < DEFAULT_THRESHOLDS.confidence.low ? 0.1 : 0;
  const institutionalRiskBoost = phase1Signals.phase === 'reset' ? 0.15 : 0;
  const structuralBoost = phase1Signals.importance >= DEFAULT_THRESHOLDS.importance.elevated ? 0.1 : 0;
  const baseWeight = clamp(node.weight ?? 0.5) * 0.2;

  const score = clamp(
    keywordScore * 0.55 +
    phase1Signals.importance * 0.15 +
    (1 - phase1Signals.confidence) * 0.08 +
    (1 - phase1Signals.legitimacyScore) * 0.07 +
    baseWeight +
    contestedBoost +
    lowConfidenceBoost +
    institutionalRiskBoost +
    structuralBoost,
  );

  const level = score >= DEFAULT_THRESHOLDS.salience.high
    ? 'high'
    : score >= DEFAULT_THRESHOLDS.salience.moderate
      ? 'moderate'
      : 'low';

  return {
    score,
    level,
    drivers: {
      keywordScore,
      structuralImportance: phase1Signals.importance,
      confidencePenalty: 1 - phase1Signals.confidence,
      legitimacyPenalty: 1 - phase1Signals.legitimacyScore,
      contested: phase1Signals.contested,
      institutionalPhase: phase1Signals.phase,
    },
  };
}

function classifyStakes(node, phase1Signals, salience) {
  const searchable = [node.label, JSON.stringify(node.metadata || {})].join(' ').toLowerCase();

  if (hasKeyword(searchable, ETHICAL_KEYWORDS.critical)) {
    return STAKES.CRITICAL;
  }

  if (
    hasKeyword(searchable, ETHICAL_KEYWORDS.high) ||
    salience.level === 'high' ||
    (phase1Signals.phase === 'reset' && phase1Signals.importance >= DEFAULT_THRESHOLDS.importance.elevated)
  ) {
    return STAKES.HIGH;
  }

  if (
    hasKeyword(searchable, ETHICAL_KEYWORDS.moderate) ||
    salience.level === 'moderate' ||
    phase1Signals.contested
  ) {
    return STAKES.MODERATE;
  }

  return STAKES.LOW;
}

function buildEscalationDecision(node, phase1Signals, salience, stakes) {
  const reasons = [];

  if (phase1Signals.confidence < DEFAULT_THRESHOLDS.confidence.low) {
    reasons.push(ESCALATION_REASONS.LOW_CONFIDENCE);
  }

  if (phase1Signals.contested || phase1Signals.dissentCount > 0) {
    reasons.push(ESCALATION_REASONS.CONTESTED);
  }

  if (phase1Signals.phase === 'reset') {
    reasons.push(ESCALATION_REASONS.INSTITUTIONAL_RESET);
  }

  if (stakes === STAKES.HIGH || stakes === STAKES.CRITICAL) {
    reasons.push(ESCALATION_REASONS.HIGH_STAKES);
  }

  if (phase1Signals.legitimacyScore < DEFAULT_THRESHOLDS.legitimacy.minimum) {
    reasons.push(ESCALATION_REASONS.LEGITIMACY_GAP);
  }

  const escalate = reasons.length > 0 && (
    stakes !== STAKES.LOW ||
    salience.level !== 'low' ||
    phase1Signals.contested ||
    phase1Signals.confidence < DEFAULT_THRESHOLDS.confidence.medium
  );

  const route = escalate ? routeEscalation({ node, phase1Signals, salience, stakes, reasons }) : null;

  return {
    escalate,
    reasons,
    route,
  };
}

function routeEscalation(context) {
  const { node, phase1Signals, stakes, reasons } = context;

  if (stakes === STAKES.CRITICAL) {
    return {
      queue: 'human-override',
      priority: 'immediate',
      owner: 'ethics-review',
      rationale: 'Critical ethical stakes require direct human review',
      nodeId: node.id,
      reasons,
    };
  }

  if (phase1Signals.contested || reasons.includes(ESCALATION_REASONS.LOW_CONFIDENCE)) {
    return {
      queue: 'constitutional-review',
      priority: 'high',
      owner: 'ethics-kernel',
      rationale: 'Contested or low-confidence nodes must be reviewed before autonomous action',
      nodeId: node.id,
      reasons,
    };
  }

  return {
    queue: 'risk-monitor',
    priority: stakes === STAKES.HIGH ? 'high' : 'normal',
    owner: 'ethics-kernel',
    rationale: 'Institutional or legitimacy risk requires supervised follow-up',
    nodeId: node.id,
    reasons,
  };
}

/**
 * EthicsKernel - evaluates whether a node can be acted on safely.
 *
 * @class EthicsKernel
 */
class EthicsKernel {
  constructor() {
    this.thresholds = DEFAULT_THRESHOLDS;
    Object.freeze(this);
  }

  /**
   * Evaluate a node using Phase 1 signals.
   *
   * @param {Object} node - Node instance or node-shaped object
   * @param {Object} [signals={}] - Phase 1 signal bundle
   * @returns {Object} Auditable ethics decision
   */
  evaluateNode(node, signals = {}) {
    const normalizedNode = normalizeNode(node);
    const phase1Signals = extractPhase1Signals(normalizedNode, signals);
    const salience = computeEthicalSalience(normalizedNode, phase1Signals);
    const stakes = classifyStakes(normalizedNode, phase1Signals, salience);
    const escalation = buildEscalationDecision(normalizedNode, phase1Signals, salience, stakes);

    return {
      nodeId: normalizedNode.id,
      nodeType: normalizedNode.type,
      attachmentPoint: 'post-phase1-signal-evaluation',
      salience,
      stakes,
      phase1Signals: {
        legitimacyScore: phase1Signals.legitimacyScore,
        confidence: phase1Signals.confidence,
        contested: phase1Signals.contested,
        dissentCount: phase1Signals.dissentCount,
        importance: phase1Signals.importance,
        institutionalStrength: phase1Signals.institutionalStrength,
        institutionalPhase: phase1Signals.phase,
        thresholds: phase1Signals.thresholds,
      },
      decision: escalation.escalate ? 'escalate' : 'proceed_with_caution',
      escalation,
      audit: {
        kernel: 'phase2-first-slice',
        generatedAt: Date.now(),
        summary: [
          `salience:${salience.level}`,
          `stakes:${stakes}`,
          `confidence:${phase1Signals.confidence.toFixed(2)}`,
          `institutional:${phase1Signals.phase}`,
        ],
      },
    };
  }
}

function createEthicsKernel() {
  return new EthicsKernel();
}

function evaluateNode(node, signals = {}) {
  return createEthicsKernel().evaluateNode(node, signals);
}

module.exports = {
  EthicsKernel,
  createEthicsKernel,
  evaluateNode,
  computeEthicalSalience,
  classifyStakes,
  routeEscalation,
  extractPhase1Signals,
  ESCALATION_REASONS,
  STAKES,
  DEFAULT_THRESHOLDS,
};
