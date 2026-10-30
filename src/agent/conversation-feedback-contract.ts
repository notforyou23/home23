/** Conservative attribution checks, not a claim that prose meaning is proven. */
import { CONDUCT_AXES, type ConductAxis, type ConversationSituation } from './conversation-judgment.js';

export interface ConversationFeedbackInterpretation {
  decisionId: string;
  axis: ConductAxis;
  value: string;
  situation: ConversationSituation;
  quote: string;
  direction: 'attenuate' | 'reinforce';
  standing: boolean;
  conditions: string[];
  supersedes: string[];
}

const SUBJECTS: Record<ConductAxis, Record<string, RegExp>> = {
  engagement: {
    acknowledge: /\b(?:acknowledg\w*|generic|flat|surface|shallow|brush\w*|dismiss\w*)\b/i,
    explore: /\b(?:explor\w*|curious|curiosity|interest\w*|meaning|connection|dig\w*|wonder\w*)\b/i,
    analyze: /\b(?:analy\w*|explain\w*|lecture\w*|diagnos\w*|dissect\w*|reason\w*|intellectualiz\w*)\b/i,
  },
  initiative: {
    stay_with: /\b(?:stay\w*|stuck|present|sit\w*|listen\w*|stopp?\w* there|left it there)\b/i,
    ask_followup: /\b(?:question\w*|ask\w*|follow[ -]?up|interrogat\w*)\b/i,
    offer_next_step: /\b(?:advice|advis\w*|solutions?|solv\w*|suggest\w*|next steps?|fix\w*|plan\w*|recommend\w*)\b/i,
  },
  continuity: {
    present_only: /\b(?:forgot\w*|forget\w*|remember\w*|context|history|start\w* (?:over|from scratch)|connect\w*|earlier|previous\w*)\b/i,
    grounded_connection: /\b(?:remember\w*|context|history|connect\w*|earlier|previous\w*|bring\w* (?:up|back))\b/i,
  },
  depth: {
    brief: /\b(?:brief|short|terse|thin|shallow|depth|detail\w*|develop\w*|expand\w*|deeper|more to (?:it|say))\b/i,
    developed: /\b(?:long|length\w*|wordy|verbose|detail\w*|depth|develop\w*|thorough\w*|overwhelm\w*|wall of text|essay)\b/i,
  },
};
const NEGATIVE = /\b(?:stop|don't|do not|didn't|did not|wasn't|isn't|aren't|weren't|doesn't|can't|cannot|won't|wouldn't|shouldn't|not|no|never|less|too (?:much|many|little|brief|short|long)|unnecessary|unhelpful|missed|flat|generic|shallow|dismiss\w*|rather (?:you|than)|instead|avoid|wish you|wanted you|need you)\b/i;
const POSITIVE = /\b(?:liked|like how|love(?:d)? how|appreciat\w*|helpful|useful|worked|helped|keep|always|more|good|better)\b/i;
const OWNER_ADDRESS = /\b(?:you|your|that (?:was|is|felt)|this (?:was|is|felt)|the (?:reply|response|question)|please|stop|keep|avoid|less|more)\b/i;
const SIMPLE_REDUCTION = /\b(?:stop|avoid|less|fewer|too (?:much|many|little|brief|short|long)|unnecessary|unhelpful|missed|flat|generic|shallow|dismiss\w*)\b/i;
const NEGATED_POSITIVE = /\b(?:not|wasn't|isn't|aren't|weren't|was not|is not|are not|were not)\s+(?:(?:very|really)\s+)?(?:helpful|useful|good|better)\b/i;
const DIRECT_PROHIBITION = /^(?:please\s+)?(?:don't|do not|never)\s+(?:keep\s+)?(?:ask\w*|giv\w*|offer\w*|analy[sz]\w*|explain\w*|lectur\w*|bring\w*|reply\w*|respond\w*)\b/i;
const SITUATION_CONDITIONS: Record<ConversationSituation, readonly string[]> = {
  sharing: ['when i share something', 'when i share something with you', "when i'm sharing", 'when i am sharing',
    "when i'm sharing something personal", 'when i tell you about my day'],
  reflection: ["when i'm thinking out loud", 'when i am thinking out loud', "when we're reflecting", 'when we are reflecting',
    "when we're talking things through", 'when we are talking things through'],
  deliberation: ["when i'm weighing a choice", 'when i am weighing a choice', "when i'm considering my options",
    'when i am considering my options', "when we're deciding", 'when we are deciding'],
};
const normalize = (value: string) => value.replace(/[‘’]/g, "'").toLowerCase().trim().replace(/\s+/g, ' ');
function withoutReplyQuotes(value: string, priorReply?: string): string | null {
  let valid = true;
  const result = value.replace(/“([^”]*)”|"([^"\n]*)"|`([^`\n]*)`|‘([^’]*)’|(?<!\w)'([^'\n]*)'(?!\w)/g,
    (whole, curly: string, straight: string, code: string, curlySingle: string, single: string) => {
    const quoted = curly ?? straight ?? code ?? curlySingle ?? single;
    if (!quoted?.trim() || !priorReply?.includes(quoted)) valid = false;
    // Preserve a quoted sentence boundary, never its evaluative words.
    return /[.!?]\s*$/.test(quoted) ? ' '.repeat(whole.length - 1) + '.' : ' '.repeat(whole.length);
  });
  return valid && !/[“”«»`"]/.test(result) ? result : null;
}

/** A model cannot downgrade an unambiguous ongoing owner directive by omitting
 * its annotation. Descriptive praise containing "keep" is not a directive. */
export function isExplicitStandingConversationInstruction(quote: string, conditions: readonly string[] = [], priorReply?: string): boolean {
  const unquoted = withoutReplyQuotes(quote, priorReply);
  if (unquoted === null) return false;
  let directive = normalize(unquoted);
  for (const condition of conditions) {
    const prefix = normalize(condition);
    if (directive.startsWith(prefix)) directive = directive.slice(prefix.length).replace(/^[,;\s]+/, '');
  }
  return /^(?:(?:please|going forward|from now on)[,\s]+)*(?:i (?:want|need) you to\s+)?(?:stop|don't|do not|never|always|avoid|keep)\b/.test(directive);
}

export function isConversationVerificationText(text: string): boolean {
  return /\b(?:codex|operator|verification|controlled (?:test|proof|exchange)|live proof|test (?:the|your) (?:learning|seed)|seed (?:lesson|learning)|counterfactual|candidate (?:reply|response)|benchmark)\b/i.test(text);
}

/** Reject ambiguity rather than broadening a scoped or reported statement.
 * The exact source and the model's interpretation are retained separately. */
export function validateConversationFeedbackClaim(
  ownerText: string, item: ConversationFeedbackInterpretation, priorReply?: string,
): string | null {
  if (!ownerText || ownerText.length > 2000 || ownerText.includes('\0') || !item.quote
    || item.quote.length > 1000 || !ownerText.includes(item.quote)) return 'owner_quote_mismatch';
  if (isConversationVerificationText(ownerText)) return 'verification_is_not_conduct_teaching';
  const unquotedOwner = withoutReplyQuotes(ownerText, priorReply);
  const unquotedClaim = withoutReplyQuotes(item.quote, priorReply);
  if (unquotedOwner === null || unquotedClaim === null
    || /\b(?:he|she|they|someone|somebody|my (?:friend|wife|husband|partner|child))\s+(?:said|says|told|asked|wants?|thinks?)\b/i.test(unquotedOwner)
    || /\b(?:hypothetical(?:ly)?|imagine|suppose|for example|what if)\b/i.test(ownerText)) return 'reported_or_hypothetical_feedback';
  if (!Object.hasOwn(CONDUCT_AXES, item.axis)
    || !(CONDUCT_AXES[item.axis] as readonly string[]).includes(item.value)
    || !['sharing', 'reflection', 'deliberation'].includes(item.situation)) return 'unknown_conduct_dimension';
  // Only complete condition spans naming the existing situation are admitted.
  // Extra qualifiers and unknown exceptions must not silently disappear.
  let conditionFree = unquotedOwner;
  for (const condition of item.conditions) {
    const at = conditionFree.indexOf(condition);
    if (at < 0 || !SITUATION_CONDITIONS[item.situation].includes(normalize(condition))
      || !/^\s*(?:[,.;!?]|$)/.test(conditionFree.slice(at + condition.length))) return 'conditional_feedback_requires_supported_scope';
    conditionFree = conditionFree.slice(0, at) + ' '.repeat(condition.length) + conditionFree.slice(at + condition.length);
  }
  if (/\b(?:unless|except|if|when|while)\b/i.test(conditionFree)) return 'conditional_feedback_requires_supported_scope';
  const claim = normalize(unquotedClaim);
  const trimClause = (value: string) => normalize(value).replace(/[.!?;]+$/, '').trim();
  const clauses = unquotedOwner.split(/[.!?;\n]+|\b(?:and|but)\b/i).map(trimClause).filter(Boolean);
  if (!clauses.includes(trimClause(unquotedClaim))) return 'feedback_quote_omits_governing_clause';
  if (/\b(?:said|says|wrote|told|thinks?|thought|wants?|suggested)\b/i.test(claim)
    && !/^i (?:think|thought|want)\b/.test(claim)) return 'reported_or_hypothetical_feedback';
  if (/\b(?:don't|do not|never|not|no)\s+(?:want(?:\s+you)?(?:\s+to)?\s+)?(?:stop|avoid|reduce|lessen|quit|limit|end)\b/i.test(claim)
    || /\bnot\s+(?:too|unnecessary|unhelpful|bad|wrong|generic|flat|shallow)\b/i.test(claim)
    || /\b(?:not|never|don't|doesn't|didn't|isn't|aren't|wasn't|weren't|can't|cannot|won't|wouldn't|shouldn't)\b(?:\s+[\w']+){0,8}\s+(?:stop|avoid|reduce|quit|less|fewer|too|unhelpful|unnecessary|bad|wrong|generic|flat|shallow)\b/i.test(claim)
    || /\b(?:stop|avoid|quit)\b(?:\s+[\w']+){0,6}\s+(?:not|never|avoiding|fewer|less)\b/i.test(claim)) return 'feedback_direction_ambiguous';
  if (!OWNER_ADDRESS.test(claim) || !SUBJECTS[item.axis][item.value]?.test(claim)) return 'conduct_attribution_ambiguous';
  if (item.axis === 'initiative' && Object.entries(SUBJECTS[item.axis]).some(([value, pattern]) => value !== item.value && pattern.test(claim))) {
    return 'multiple_conduct_choices_in_one_clause';
  }
  const positiveRemainder = claim.replace(/\b(?:not|wasn't|isn't|aren't|weren't|was not|is not|are not|were not)\s+(?:(?:very|really)\s+)?(?:helpful|useful|good|better)\b/g, 'negative');
  // Mere negation is not negative feedback. Only a supported simple reduction,
  // prohibition or negated positive evaluation can propose attenuation.
  if (item.direction === 'attenuate'
    ? !(SIMPLE_REDUCTION.test(claim) || NEGATED_POSITIVE.test(claim) || DIRECT_PROHIBITION.test(claim))
    : !POSITIVE.test(claim) || NEGATIVE.test(claim)) {
    return 'feedback_direction_ambiguous';
  }
  if (item.direction === 'attenuate' && POSITIVE.test(positiveRemainder)) return 'mixed_feedback_direction';
  if (item.standing && !isExplicitStandingConversationInstruction(item.quote, item.conditions, priorReply)) return 'standing_instruction_not_explicit';
  if (!item.standing && isExplicitStandingConversationInstruction(item.quote, item.conditions, priorReply)) {
    return 'standing_instruction_annotation_missing';
  }
  if (item.supersedes.length && !/\b(?:changed my mind|change my mind|instead of what I said|revise|replace|no longer|forget (?:my|that|the) (?:earlier|previous|old))\b/i.test(ownerText)) {
    return 'revision_not_explicit';
  }
  return null;
}
