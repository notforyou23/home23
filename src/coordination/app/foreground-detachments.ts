import type { CoordinationTurnOrigin } from '../../agent/types.js';
import { parseForegroundDetachmentRequest, type ForegroundDetachmentAck } from '../../coordination-adapter/foreground-detachment-contract.js';
import { generateCoordinationId } from '../ids/index.js';
import { canonicalJson, sha256 } from '../work/canonical.js';
import { WorkError } from '../work/errors.js';
import { createWorkService } from '../work/service.js';
import type { M11Database } from '../work/types.js';
import { createResidentAssignments } from './resident-assignments.js';

export interface DetachmentCredential { residentSlug: string; instanceId: string; keyVersion: number; role?: string }

/** Product labels have tighter bounds than the immutable execution assignment. */
function presentationText(value: string, limit: number, singleLine = false): string {
  const text = singleLine ? value.replace(/[\r\n]+/gu, ' ') : value;
  if (text.length <= limit) return text;
  let prefix = '';
  for (const point of text) {
    if (prefix.length + point.length > limit - 1) break;
    prefix += point;
  }
  return `${prefix}…`;
}

/** Authenticated transport supplies credential; all product authority comes from the canonical parent. */
export function createForegroundDetachmentConsumer(options: {
  database: M11Database;
  work: ReturnType<typeof createWorkService>;
  schedule: (workId: string) => void;
  now?: () => Date;
  resolveResident: (slug: string) => { clientInstanceId: string; serverInstanceId: string; keyVersion: number } | null | undefined;
}) {
  const now = options.now ?? (() => new Date());
  const assignments = createResidentAssignments(options.database);
  function verifyCredential(credential: DetachmentCredential) {
    const resident = options.resolveResident(credential.residentSlug);
    if (!resident || resident.clientInstanceId !== credential.instanceId || resident.keyVersion !== credential.keyVersion)
      throw new WorkError('ineligible', 'resident credential is not the configured harness');
    return resident;
  }
  function verify(credential: DetachmentCredential, origin: CoordinationTurnOrigin, readOnly = false) {
    const resident = verifyCredential(credential);
    const row = options.database.readOne<{ id: string; principalId: string; targetPrincipalId: string; channelId: string; originMessageId: string | null; roundId: string | null; kind: string; contextManifestId: string }>(
      `SELECT w.id, w.principal_id AS principalId, w.target_principal_id AS targetPrincipalId,
       w.channel_id AS channelId, w.origin_message_id AS originMessageId, w.round_id AS roundId,
       w.kind, w.context_manifest_id AS contextManifestId
       FROM works w JOIN attempts a ON a.id = w.current_attempt_id
       JOIN leases l ON l.attempt_id = a.id JOIN bots b ON b.principal_id = w.target_principal_id
       WHERE w.id = ? AND a.id = ? AND l.id = ? AND a.fencing_token = ? AND l.fencing_token = ?
       AND a.holder_principal_id = ? AND l.holder_principal_id = a.holder_principal_id
       AND a.holder_instance_id = ? AND l.holder_instance_id = a.holder_instance_id
       AND a.authority_reference = ? AND w.target_principal_id = a.holder_principal_id
       AND ((w.state = 'running' AND a.state = 'running' AND l.state = 'active')
         OR (? = 1 AND w.state='leased' AND a.state IN ('offered','accepted') AND l.state IN ('offered','active')))
       AND l.expires_at > ?
       AND b.lifecycle = 'active' AND b.resident_binding = ? AND b.active_instance_id = ? AND b.active_key_version = ?`,
      origin.workId, origin.attemptId, origin.leaseId, origin.fencingToken, origin.fencingToken,
      origin.holderPrincipalId, origin.holderInstanceId, origin.authorityReference, readOnly ? 1 : 0, now().toISOString(),
      credential.residentSlug, resident.serverInstanceId, credential.keyVersion);
    if (!row || origin.holderInstanceId !== resident.serverInstanceId || origin.authorityReference !== `resident:${credential.residentSlug}` ||
      row.channelId !== origin.channelId || row.originMessageId !== origin.originMessageId || row.roundId !== origin.roundId) {
      throw new WorkError('ineligible', 'detachment requires the current authenticated resident fence');
    }
    return row;
  }
  function assertCurrentDirection(workId: string) {
    const current = assignments.direction(workId);
    if (current.ownerMessageSequence > current.acknowledgedSequence) throw new WorkError('ineligible', 'Owner direction changed. Read work_list, reconcile the new messages, and record the appropriate work_report_outcome with owner_message_sequence before another launch. A pause does not authorize recovery.');
  }
  return {
    authorize: verify,
    authorizeRead: (credential: DetachmentCredential, origin: CoordinationTurnOrigin) => verify(credential, origin, true),
    assertCurrentDirection,
    admit(input: { credential: DetachmentCredential; request: unknown }): ForegroundDetachmentAck {
      const request = parseForegroundDetachmentRequest(input.request);
      const resident = verifyCredential(input.credential);
      if (request.residentSlug !== input.credential.residentSlug) throw new WorkError('ineligible', 'resident identity mismatch');
      // Idempotent lost-response retry may arrive after the speaking turn finishes.
      // Validate the immutable original authority and exact request before returning its receipt.
      const prior = options.database.readOne<{ workId: string; assignmentJson: string; instanceId: string; keyVersion: number }>(
        `SELECT p.work_id AS workId, p.assignment_json AS assignmentJson, b.active_instance_id AS instanceId,
          b.active_key_version AS keyVersion FROM work_planned_invocations p
          JOIN works w ON w.id = p.work_id JOIN bots b ON b.principal_id = w.target_principal_id
          WHERE p.parent_work_id = ? AND p.parent_attempt_id = ? AND p.parent_fencing_token = ?
            AND p.resident_slug = ? AND p.invocation_id = ?`,
        request.parentOrigin.workId, request.parentOrigin.attemptId, request.parentOrigin.fencingToken,
        request.residentSlug, request.invocationId);
      if (prior) {
        if (canonicalJson(request) !== prior.assignmentJson) throw new WorkError('idempotency_conflict', 'planned invocation replay changed');
        if (prior.instanceId !== resident.serverInstanceId || prior.keyVersion !== input.credential.keyVersion || request.parentOrigin.holderInstanceId !== resident.serverInstanceId)
          throw new WorkError('ineligible', 'resident replay authority changed');
        options.schedule(prior.workId);
        return { accepted: true, workId: prior.workId, invocationId: request.invocationId };
      }
      const parent = verify(input.credential, request.parentOrigin);
      if (!['resident_turn', 'channel.bot_turn', 'bot_turn'].includes(parent.kind) || parent.originMessageId === null)
        throw new WorkError('ineligible', 'only speaking Work can detach');
      const manifest = options.database.readOne<{ messageIds: string; artifactIds: string; messageCount: number; artifactCount: number; channelWatermark: number; eventWatermark: number; contextDigest: string; sourceDigest: string }>(
        `SELECT message_refs_json AS messageIds, artifact_refs_json AS artifactIds, message_count AS messageCount,
         artifact_count AS artifactCount, channel_watermark AS channelWatermark, event_watermark AS eventWatermark,
         context_digest AS contextDigest, source_digest AS sourceDigest FROM context_manifests WHERE id = ?`, parent.contextManifestId);
      if (!manifest) throw new WorkError('invalid_manifest', 'parent manifest unavailable');
      assignments.assertOpen(parent.id);
      assertCurrentDirection(parent.id);
      const created = options.work.create({
        principalId: parent.principalId, targetPrincipalId: parent.targetPrincipalId, channelId: parent.channelId,
        originMessageId: parent.originMessageId, roundId: parent.roundId, kind: 'resident_work_thread',
        idempotencyKey: `foreground-detach:${sha256(canonicalJson({ resident: request.residentSlug, parent: request.parentOrigin.workId, attempt: request.parentOrigin.attemptId, fence: request.parentOrigin.fencingToken, invocation: request.invocationId }))}`,
        maxAutomaticOffers: 1, requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation'),
        presentation: { title: presentationText(request.title, 88, true), summary: presentationText(request.summary, 280) }, plannedInvocation: request,
        turnSelection: options.work.getTurnSelection(parent.id),
        manifest: { privacy: 'channel_only', channelId: parent.channelId,
          messageIds: JSON.parse(manifest.messageIds), artifactIds: JSON.parse(manifest.artifactIds),
          counts: { messages: manifest.messageCount, artifacts: manifest.artifactCount },
          watermarks: { channelSequence: manifest.channelWatermark, eventSequence: manifest.eventWatermark },
          digests: { context: manifest.contextDigest, source: manifest.sourceDigest } },
      });
      options.schedule(created.work.id);
      return { accepted: true, workId: created.work.id, invocationId: request.invocationId };
    },
    start(input: { credential: DetachmentCredential; origin: CoordinationTurnOrigin; invocationId: string }): { started: boolean } {
      verify(input.credential, input.origin);
      const planned = options.work.getPlannedInvocation(input.origin.workId);
      if (planned && planned.recoveryPolicy !== 'safe_before_start' && planned.invocationId === input.invocationId && options.work.getInvocationExecution(input.origin.workId))
        return { started: true };
      if (!options.work.getInvocationExecution(input.origin.workId)) {
        assignments.assertOpen(input.origin.workId);
        assertCurrentDirection(input.origin.workId);
      }
      return options.work.markInvocationStarted({ origin: input.origin, invocationId: input.invocationId,
        requestId: generateCoordinationId('request'), correlationId: generateCoordinationId('correlation') });
    },
  };
}
