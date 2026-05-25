export class InboxRouter {
  normalize(input = {}) {
    const summary = String(input.summary || input.title || input.text || input.content || '').trim();
    const candidate = {
      schema: 'home23.agency.candidate.v1',
      candidateId: input.candidateId || `cand_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`,
      dedupeKey: input.dedupeKey || null,
      source: input.source || input.channelId || 'manual',
      kind: input.kind || input.type || 'candidate',
      title: input.title || null,
      summary,
      seen: Array.isArray(input.seen) ? input.seen : [],
      discarded: Array.isArray(input.discarded) ? input.discarded : [],
      explicitNoChange: input.explicitNoChange === true,
      pursuitId: input.pursuitId || input.closesPursuitId || input.targetPursuitId || null,
      consequenceStatus: input.consequenceStatus || input.receiptStatus || null,
      changedFuture: input.changedFuture || input.changedState || null,
      connectsTo: Array.isArray(input.connectsTo) ? input.connectsTo : [],
      nextMove: input.nextMove || input.next || null,
      whyItMatters: input.whyItMatters || input.relevance || null,
      currentTheory: input.currentTheory || input.theory || null,
      evidenceStandard: input.evidenceStandard || null,
      attentionBudget: input.attentionBudget || input.budget || null,
      whatWouldChangeMyMind: input.whatWouldChangeMyMind || null,
      evidence: Array.isArray(input.evidence) ? input.evidence : [],
      authorityLevel: input.authorityLevel || inferAuthorityLevel(input),
      desiredChangedFuture: input.desiredChangedFuture || input.expectedOutcome || null,
      stopCondition: input.stopCondition || null,
      verifier: input.verifier || null,
      artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
      tags: Array.isArray(input.tags) ? input.tags : inferTags(input),
      policyMode: input.policyMode || input.policy?.mode || input.payload?.policy?.mode || null,
      payload: input.payload || null,
      receivedAt: new Date().toISOString(),
    };
    return candidate;
  }
}

function inferTags(input) {
  const tags = [];
  const text = `${input.source || ''} ${input.kind || ''} ${input.summary || ''}`.toLowerCase();
  if (text.includes('good-life') || text.includes('good life')) tags.push('good-life');
  if (text.includes('worker')) tags.push('worker');
  if (text.includes('cron') || text.includes('timeline') || text.includes('field report')) tags.push('cron-report');
  if (text.includes('cosmo') || text.includes('research')) tags.push('research');
  if (text.includes('dashboard')) tags.push('dashboard');
  return tags;
}

function inferAuthorityLevel(input) {
  const text = `${input.summary || ''} ${input.action || ''}`.toLowerCase();
  if (/pm2|restart|git|push|publish public|post to|delete|destructive/.test(text)) return 'L4';
  if (/launch research|schedule|good life|cron/.test(text)) return 'L3';
  if (/worker|refresh|goal|surface|verifier/.test(text)) return 'L2';
  if (/write|memory|note|receipt/.test(text)) return 'L1';
  return 'L0';
}
