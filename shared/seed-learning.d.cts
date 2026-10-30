export interface LearningDecision {
  schema: 'home23.learning-decision.v1'; decisionId: string; scope: string; tags: string[];
  sourceRefs: string[]; cellId?: string; criterion: 'owner-value' | 'execution' | 'prediction'; observedAt?: string;
}
export interface LearningFeedback {
  schema: 'home23.learning-feedback.v1'; decisionId?: string; scope: string; direction: 'attenuate' | 'reinforce';
  tags: string[]; excludes: string[]; evidenceRefs: string[]; basis: 'owner-feedback' | 'verified-outcome' | 'outcome-assessment'; supersedes: string[]; corroborates: string[]; standing?: true; cellId?: string;
}
export interface LearningLesson {
  lessonId: string; scope: string; tags: string[]; excludes: string[]; sourceRefs: string[]; value: number;
  basis: string; authority: 'owner' | 'provisional'; criterion: string; decisionId?: string; eligibility?: LearningDecision;
  createdAt: string; corroborations: number; active: boolean;
  context?: number[]; readoutDelta?: number[];
  retentionCredits?: number; replacesLessonId?: string;
}
export interface LearningState { version: 1; decisions: LearningDecision[]; lessons: LearningLesson[]; seenFeedbackIds: string[]; watermarks: Record<string, number>; lastConsolidatedAt?: string; pendingFeedback: Array<{ feedback: LearningFeedback; authority: { feedbackId: string; observedAt: string; ownerAuthenticated?: boolean; stream?: string; sequence?: number } }> }
export interface LearningSnapshot { version: 1; available?: boolean; decisions: LearningDecision[]; lessons: LearningLesson[]; watermarks?: Record<string, number>; seq?: number | null; }
export function normalizeLearningDecision(raw: unknown): LearningDecision | null;
export function normalizeLearningFeedback(raw: unknown): LearningFeedback | null;
export function emptyLearningState(): LearningState;
export function normalizeLearningState(raw: unknown): LearningState;
export function recordLearningDecision(state: unknown, decision: unknown): { applied: boolean; state: LearningState; reason: string };
export function applyLearningFeedback(state: unknown, feedback: unknown, authority: { feedbackId: string; observedAt: string; ownerAuthenticated?: boolean; stream?: string; sequence?: number; verification?: { criterion: string; evidenceRefs: string[] }; assessment?: { criterion: string; evidenceRefs: string[] } }): { applied: boolean; state: LearningState; reason: string; lesson?: LearningLesson };
export function consolidateLearning(state: unknown, asOf?: string): LearningState;
export function learningSnapshot(development: Record<string, unknown>): LearningSnapshot;
export function evaluateLearnedDecision(snapshot: unknown, candidate: { scope: string; tags?: string[]; requiredTags?: string[]; cellId?: string; baseScore?: number }): { adjustment: number; score: number; suppress: boolean; lessonIds: string[]; sourceRefs: string[]; available: boolean };
export function readSeedLearning(stateDir: string): LearningSnapshot;
export const readSeedLearningSync: typeof readSeedLearning;
export function learningLessonId(feedbackId: string, scope: string): string;
export function executionTargetTag(target: unknown): string | null;
export function learningStateWithinBudget(state: unknown): boolean;
