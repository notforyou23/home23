/** Read-only projection of accepted Seed learning receipts. No Seed constructor,
 * restore, replay, provider call or state mutation occurs on the foreground path. */
export { readSeedLearning, readSeedLearningSync, evaluateLearnedDecision, learningSnapshot } from '../../shared/seed-learning.cjs';
