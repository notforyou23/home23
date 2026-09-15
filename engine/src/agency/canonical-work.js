import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Reconcile shared observations through this resident's existing agency store.
 * Nothing here launches work, changes Seed law, or invents an owner promise. */
export function reconcileCanonicalWork(kernel, sourcePath, resident) {
  if (!existsSync(sourcePath)) return { available: false, changed: 0 };
  const snapshot = JSON.parse(readFileSync(sourcePath, 'utf8'));
  if (snapshot.schema !== 'home23.resident.work.v1' || snapshot.resident !== resident || !Array.isArray(snapshot.assignments)) throw new Error('Invalid canonical resident work snapshot');
  let changed = 0;
  for (const assignment of snapshot.assignments) {
    if (typeof assignment.id !== 'string' || !assignment.id.startsWith('wrk_') || typeof assignment.title !== 'string'
        || !['active','needs_review','blocked','complete','failed','returned','cancelled'].includes(assignment.assignmentState)) throw new Error('Invalid canonical assignment');
    const id = `coordination:${assignment.id}`;
    const digest = createHash('sha256').update(JSON.stringify(assignment)).digest('hex');
    const existing = kernel.store.getTask(id);
    const authorityLevel = assignment.authorityLevel || 'unknown';
    if (existing?.handoff?.canonicalDigest === digest && existing.authorityLevel === authorityLevel) continue;
    const closed = ['complete','cancelled'].includes(assignment.assignmentState);
    const evidence = [{ type: 'reference', ref: id }, ...(assignment.conclusion?.evidence ?? []).map(ref => ({ type: 'reference', ref }))];
    const handoff = { source: 'coordination', canonicalDigest: digest, workId: assignment.id,
      channelId: assignment.channelId, originMessageId: assignment.originMessageId,
      originalRequest: assignment.originalRequest, executionState: assignment.state,
      assignmentState: assignment.assignmentState, conclusion: assignment.conclusion };
    if (!existing) kernel.recordTask({ id, summary: assignment.title, status: closed ? 'closed' : 'open', authorityLevel,
      actionKind: 'canonical_assignment', handoff, evidence, at: assignment.createdAt,
      reason: 'canonical_assignment_observed', stopCondition: 'resident assessment records completion or cancellation; execution termination alone is insufficient' });
    else kernel.store.updateTask(id, { status: closed ? 'closed' : 'open', summary: assignment.title,
      authorityLevel, handoff, evidence, closureSummary: closed ? assignment.conclusion?.summary ?? null : null,
      closureEvidence: closed ? evidence : [], closedAt: closed ? assignment.conclusion?.recordedAt ?? null : null },
      { type: 'canonical_assignment_observed', detail: { workId: assignment.id, state: assignment.assignmentState } });
    changed++;
  }
  if (changed) kernel.ensureState();
  return { available: true, changed };
}
