'use strict';

/**
 * Conversation provenance and a deliberately narrow content policy. A memory
 * test can quote a real fact without providing another owner's observation.
 * Recaps and references remain evidence, but retrieval can rank them lower.
 */
function classifyOwnerConversation(input = {}) {
  const reasons = [];
  const metadata = [input, input.metadata, input.provenance].filter(value => value && typeof value === 'object');
  const ids = [input.chatId, input.sessionId,
    ...(Array.isArray(input.sessionRefs) ? input.sessionRefs : []),
    ...(Array.isArray(input.sourceRefs) ? input.sourceRefs : []),
    ...metadata.flatMap(value => [value.chatId, value.chat_id, value.sessionId, value.session_id,
      ...(Array.isArray(value.session_refs) ? value.session_refs : []),
      ...(Array.isArray(value.sessionRefs) ? value.sessionRefs : [])])];
  if (ids.some(value => typeof value === 'string' && /verify|verification|retrieval-test/i.test(value))) {
    reasons.push('verification_chat_id');
  }
  let declaredKind;
  for (const value of metadata) {
    if (value.verification === true || value.nonOwner === true || value.non_owner === true
      || value.owner === false || value.ownerSource === false || value.owner_source === false) {
      reasons.push(value.verification === true ? 'verification_flag' : 'non_owner_source');
    }
    if (value.owner_evidence === false || value.ownerEvidence === false) reasons.push('non_owner_source');
    const source = value.sourceClass ?? value.source_class ?? value.source;
    if (typeof source === 'string' && /^(?:verification|verify|meta|retrieval[_-]test|non[_-]owner|test)$/i.test(source)) {
      reasons.push('non_owner_source');
    }
    const kind = value.conversationKind ?? value.conversation_kind ?? value.classification;
    if (kind === 'verification' || kind === 'meta') reasons.push('verification_classification');
    else if (kind === 'recap' || kind === 'mention') declaredKind = kind;
  }
  const text = typeof input.text === 'string' ? input.text.normalize('NFKC').toLowerCase() : '';
  // Testing an unrelated object and mentioning a memory elsewhere is ordinary
  // conversation. Require a direct resident recall/retrieval test instead.
  const residentMemoryTest = /\b(?:test|testing|verify|verifying)\s+(?:(?:your|the|my|our)\s+)?(?:retrieval|recall)\b/.test(text)
    || /\b(?:test|testing|verify|verifying)\s+(?:your|the (?:resident|agent|assistant)['’]s)\s+memor(?:y|ies)\b/.test(text)
    || /\b(?:test|testing|verify|verifying)\s+(?:whether|if|that|how well)\s+you\s+(?:(?:can|still|really|actually)\s+)*(?:remember|recall|retrieve)\b/.test(text);
  const postFixRetrievalTrial = /\bpost[ -]fix (?:check|test)\b[^.!?\n]{0,80}\b(?:try|test|exercise)\b[^.!?\n]{0,60}\b(?:resident|agent|assistant)['’]s\s+(?:retrieval|recall|memory)\b/.test(text);
  // Ordinary recall and maintenance requests are owner conversation. Require
  // explicit test content or verification provenance, including retest summaries.
  if (/\bretrieval[ _-](?:re[ _-]?)?test\b/.test(text) || residentMemoryTest || postFixRetrievalTrial) {
    reasons.push('retrieval_meta_content');
  }
  if (reasons.length) return { kind: 'verification', verification: true, ownerEvidence: false, reasons: [...new Set(reasons)] };
  if (declaredKind) return { kind: declaredKind, verification: false, ownerEvidence: true, reasons: ['declared_' + declaredKind] };
  if (/^\s*(?:recap|summary)\s*[:—-]/.test(text)
    || /^\s*(?:here(?:['’]s| is) (?:a |the )?)?(?:recap|summary|summari[sz]ing) (?:of |from )?(?:our |the |an? )?(?:earlier |previous |prior |original )?(?:conversation|discussion|chat|memory|ticket conversation)\b/.test(text)) {
    return { kind: 'recap', verification: false, ownerEvidence: true, reasons: ['conversation_recap'] };
  }
  // The first line is the quoted evidence when callers append an inferred
  // statement. That statement cannot turn a topic mention into a new event.
  const substantiveAction = /\b[a-z][a-z'’-]*\s+(?:(?:have|had|already|just)\s+)*(?:bought|purchased|booked|reserved|paid|ordered|stayed|chose|decided|will stay|need|want)\b|\b(?:receipt|confirmation)\s+(?:confirms|shows|lists)\b/.test(text.split('\n', 1)[0]);
  if (!substantiveAction && /^\s*(?:we (?:previously |earlier |already )?(?:discussed|talked about|mentioned)|(?:this|it|the (?:entry|memory|conversation|chat)) (?:merely |only |just )?(?:mentions|references|refers to)|(?:a |another )?(?:mention|reference) (?:of|to))\b/.test(text)) {
    return { kind: 'mention', verification: false, ownerEvidence: true, reasons: ['topic_reference'] };
  }
  return { kind: 'substantive', verification: false, ownerEvidence: true, reasons: [] };
}

module.exports = { classifyOwnerConversation };

/** Future event dates alone do not request newer evidence about that event. */
function hasConversationTimeIntent(query) {
  if (typeof query !== 'string') return false;
  return /\b(?:current|currently|now|recent|recently|latest|today|yesterday|tonight|as of|this (?:morning|afternoon|evening|week|month|year)|last (?:night|week|month|year)|past (?:week|month|year)|in the last \d+ (?:hours?|days?|weeks?|months?))\b/i.test(query)
    || /\b\d{4}-\d{2}-\d{2}\b/.test(query)
    || /\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i.test(query)
    || /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\b/i.test(query);
}
module.exports.hasConversationTimeIntent = hasConversationTimeIntent;
