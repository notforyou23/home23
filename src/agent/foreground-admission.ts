/**
 * Resident Presence — conversation admission and speaking-turn policy.
 *
 * A user Message is always durably accepted. Background Work never owns the
 * conversational foreground. At most one orderly speaking turn may run on a
 * conversation; a second Message is held until that speaking turn ends.
 */

export const BUSY_REPLY_TEXT = "I'm still working on something. Send /stop to interrupt me.";

export type ForegroundAdmissionAction = 'start_speaking' | 'hold_for_speaking';

export interface ForegroundAdmissionInput {
  /** True only for an in-flight conversational speaking turn on this chat. */
  speakingActive: boolean;
  /** True when durable Work is active for this resident/conversation. */
  workActive?: boolean;
}

export interface ForegroundAdmissionDecision {
  accepted: true;
  action: ForegroundAdmissionAction;
  startSpeaking: boolean;
  busyReply: null;
}

export class ForegroundTurnHeld extends Error {
  readonly code = 'foreground_turn_held';

  constructor() {
    super('foreground speaking turn already in flight');
    this.name = 'ForegroundTurnHeld';
  }
}

export function isForegroundTurnHeld(error: unknown): error is ForegroundTurnHeld {
  return error instanceof ForegroundTurnHeld
    || (error instanceof Error && (error as Error & { code?: string }).code === 'foreground_turn_held');
}

/**
 * Conversation lock is speaking-only. Coordination / Work turns use a
 * synthetic chat or a coordination origin and must not occupy it.
 */
export function isSpeakingConversationRun(input: {
  chatId?: string;
  coordinationOrigin?: { kind?: string } | null;
}): boolean {
  if (input.coordinationOrigin) return false;
  const chatId = input.chatId ?? '';
  if (!chatId) return false;
  if (chatId.startsWith('coordination:')) return false;
  return true;
}

export function isForegroundConversation(input: {
  chatId?: string;
  coordinationOrigin?: { kind?: string } | null;
}): boolean {
  if (!isSpeakingConversationRun(input)) return false;
  const chatId = input.chatId ?? '';
  if (chatId.startsWith('subagent:')) return false;
  if (chatId.startsWith('cron-')) return false;
  if (chatId.startsWith('diagnose:')) return false;
  if (chatId.startsWith('proposer:')) return false;
  if (chatId.startsWith('worker:')) return false;
  return true;
}

/**
 * Admit a user Message against current speaking / Work state.
 * Work being active never blocks a new speaking turn. A live speaking turn
 * holds the next assembled completion without a busy-gate reply.
 */
export function admitForegroundTurn(input: ForegroundAdmissionInput): ForegroundAdmissionDecision {
  void input.workActive;
  if (input.speakingActive) {
    return {
      accepted: true,
      action: 'hold_for_speaking',
      startSpeaking: false,
      busyReply: null,
    };
  }
  return {
    accepted: true,
    action: 'start_speaking',
    startSpeaking: true,
    busyReply: null,
  };
}

export function assertCanStartSpeaking(input: ForegroundAdmissionInput): void {
  const decision = admitForegroundTurn(input);
  if (!decision.startSpeaking) throw new ForegroundTurnHeld();
}
