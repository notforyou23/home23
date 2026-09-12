import { MessagingError, type MessagingActorContext } from "../channels/index.js";
import type { MessageProjection, MessageTurnSelection } from "../messages/index.js";
import type { createMessageService } from "../messages/service.js";
import type { createCanonicalMessageRecorder, DirectMessageContextPort } from "./direct-message.js";
import type { LiveVoiceAccess } from "./live-voice.js";
import type { SpecialistCompletionResidentTarget } from "./specialist-completion.js";

export type LiveVoiceTranscriptTarget = Pick<
  Awaited<ReturnType<DirectMessageContextPort["resolveTarget"]>>,
  "channelId" | "conversationId" | "targetPrincipalId" | "residentBinding"
>;

export interface LiveVoiceTranscriptPort {
  append(input: {
    access: LiveVoiceAccess;
    target: LiveVoiceTranscriptTarget;
    speaker: "You" | "Voice";
    messageId: string;
    idempotencyKey: string;
    text: string;
    replyToMessageId: string | null;
    turnSelection: MessageTurnSelection;
  }): Promise<MessageProjection>;
}

/** Persist trusted sideband speech in the existing conversation without starting Work. */
export function createLiveVoiceTranscriptPort(options: {
  messages: Pick<ReturnType<typeof createMessageService>, "sendMessage">;
  targets: Pick<DirectMessageContextPort, "resolveTarget">;
  resolveResident(binding: string): Pick<SpecialistCompletionResidentTarget, "context"> | undefined;
  recordMessage: ReturnType<typeof createCanonicalMessageRecorder>;
  assertAuthority(): void;
}): LiveVoiceTranscriptPort {
  return {
    async append(input) {
      options.assertAuthority();
      const ownerContext = input.access.context;
      if (ownerContext.identity.kind !== "owner" || ownerContext.principalId !== "user_owner" ||
          ownerContext.identity.auth.principalId !== ownerContext.principalId) {
        throw new MessagingError("identity_context_mismatch");
      }
      if (!ownerContext.identity.auth.scopes.includes("message:send") ||
          !ownerContext.identity.auth.scopes.includes("product:read")) {
        throw new MessagingError("scope_denied");
      }
      // The caller cannot choose an author or redirect the resident into another conversation.
      // Re-resolve the owner DM to reject a membership/binding change since session admission.
      const target = await options.targets.resolveTarget({
        context: ownerContext, channelId: input.access.channelId,
      });
      if (input.access.channelId !== input.target.channelId || target.channelId !== input.target.channelId ||
          target.conversationId !== input.target.conversationId ||
          target.targetPrincipalId !== input.target.targetPrincipalId ||
          target.residentBinding !== input.target.residentBinding) {
        throw new MessagingError("identity_context_mismatch");
      }
      const identity = { requestId: ownerContext.requestId, correlationId: ownerContext.correlationId };
      let context: MessagingActorContext = ownerContext;
      if (input.speaker === "Voice") {
        if (target.residentBinding.startsWith("bot-")) {
          // Processless Bots use the same canonical actor as their ordinary replies.
          // sendMessage revalidates its active mailbox and processless identity.
          context = { principalId: target.targetPrincipalId, ...identity,
            identity: { kind: "on_demand_bot", bot: {
              botId: target.targetPrincipalId, residentBinding: target.residentBinding,
            } } };
        } else {
          const resident = options.resolveResident(target.residentBinding);
          if (!resident) throw new MessagingError("authority_unavailable");
          context = resident.context({ principalId: target.targetPrincipalId, ...identity });
        }
      }
      const result = await options.messages.sendMessage({
        context, channelId: target.channelId, messageId: input.messageId,
        authorPrincipalId: input.speaker === "You" ? ownerContext.principalId : target.targetPrincipalId,
        idempotencyKey: input.idempotencyKey, kind: input.speaker === "You" ? "text" : "result",
        text: input.text, mentions: [], clientMessageId: input.messageId,
        replyToMessageId: input.replyToMessageId, tombstonesMessageId: null,
        provenance: { roundId: null, workId: null },
        // An admitted owner utterance can later enter ordinary Message submission with this
        // same identity/body/selection, reusing the durable row as the origin of its Work.
        ...(input.speaker === "You" ? { turnSelection: input.turnSelection } : {}),
      });
      // Reconcile on replay as well: a prior attempt may have committed the Message before
      // its evidence write. The canonical recorder's stable event ID prevents duplicates.
      options.assertAuthority();
      await options.recordMessage({
        message: result.message,
        kind: input.speaker === "You" ? "user_message_committed" : "assistant_message_committed",
        ...identity,
        ...(input.speaker === "You" ? { turnSelection: input.turnSelection } : {}),
      });
      return result.message;
    },
  };
}
