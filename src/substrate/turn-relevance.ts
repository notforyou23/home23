import { semanticMatchScore } from './semantic-match.js';
import { activeAttentionRecipeId, admitsPairScore, resolveAttentionPolicy } from './encoder-attention-policy.js';

const FOLLOW_UP = /^(?:ok(?:ay)?(?:\s+continue)?|continue|go on|do it|yes|yeah|and(?:\s+then)?|what about that)[.!?\s]*$/i;
const COMMON = new Set('a an the i me my you your yours we our us it its is are am was were be been being to of for from on in at with and or but that this these those what how why when where who would could should can will do did does have has had about just still now then today yesterday really feel feels doing going think thought considered predicted expect expecting jtr'.split(' '));

/** Only a genuine short follow-up inherits its earlier owner subject. The
 * resident's own operational prose must not recruit more operational context. */
export function currentTurnSubject(turnText: string, recentTurns: Array<{ role: string; content: string }> = []): string {
  if (!FOLLOW_UP.test(turnText.trim())) return turnText;
  const prior = recentTurns.filter(turn => turn.role === 'user' && turn.content.trim()).at(-1)?.content;
  return prior ? `${prior}\n${turnText}` : turnText;
}

export function relevantToTurn(content: string, subject: string, embed?: (text: string) => number[] | null): boolean {
  if (!subject.trim()) return false;
  const recipeId = activeAttentionRecipeId();
  // Bootstrap has no precomputed semantic candidates. Do not synchronously
  // call a live embedder once per retained claim; use the injected/cache-owning
  // matcher when supplied, otherwise a conservative lexical preview. Full
  // deliberate recall remains available through its existing tools.
  const score = semanticMatchScore(subject, content, embed ?? (() => null), { recipeId });
  if (score !== null) return admitsPairScore(score, resolveAttentionPolicy(recipeId));
  const tokens = (text: string) => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(token => token.length >= 3 && !COMMON.has(token)));
  const query = tokens(subject);
  const candidate = tokens(content);
  return [...query].some(token => candidate.has(token));
}

export const OPERATIONAL_CONTEXT = 'Operational work: system server runtime services memory CPU disk worker receipts agency pursuits deployment infrastructure tasks planning queue';
