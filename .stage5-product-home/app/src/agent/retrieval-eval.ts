/**
 * Retrieval-eval isolation: disable or disclose automatic continuity
 * enrichment so a search test cannot be contaminated by hidden prompt context.
 */

export function isRetrievalEvalTurn(text: string): boolean {
  const q = text.toLowerCase();
  return (
    /\bretrieval[- ]eval\b/.test(q)
    || /\bfresh retrieval\b/.test(q)
    || /\bisolated retrieval\b/.test(q)
    || /\bdo not use (continuity|enrichment|hidden context)\b/.test(q)
    || /\b(test|prove|verify)\b.{0,80}\b(retriev|brain_search|relationship_recall)\b/.test(q)
    || /\b(brain_search|relationship_recall)\b.{0,80}\b(test|prove|verify|isolated|fresh)\b/.test(q)
  );
}

export function retrievalEvalDisclosure(): string {
  return [
    '[RETRIEVAL EVAL]',
    'Automatic continuity enrichment is disabled this turn.',
    'Pre-turn brain cues and relationship-ledger injection were not applied.',
    'Treat only explicit tool results as retrieval evidence.',
    'If a tool reports completeness=incomplete, do not conclude absence.',
    '[/RETRIEVAL EVAL]',
  ].join('\n');
}

export function continuityEnrichmentDisclosure(opts: {
  brainCueCount: number;
  relationshipCount: number;
}): string {
  return [
    '[CONTINUITY ENRICHMENT]',
    `Pre-turn injection ran: brainCues=${opts.brainCueCount} relationshipEntries=${opts.relationshipCount}.`,
    'Do not treat phrases in this prompt block as evidence that brain_search or relationship_recall found them.',
    'A retrieval test that used these phrases is contaminated.',
    'If completeness=incomplete or this block is present, do not close the experiment as a retrieval proof.',
    '[/CONTINUITY ENRICHMENT]',
  ].join('\n');
}
