import { ChannelCoordinatorError } from "./errors.js";
import type { ChannelTurnTrigger } from "./types.js";
import { MAX_CHANNEL_TURNS_PER_BOT, MAX_CHANNEL_TURNS_PER_ROUND } from "./types.js";

interface EligibleBotRow { id: string }

export function selectChannelRecipients(
  input: ChannelTurnTrigger,
  eligibleRows: readonly EligibleBotRow[],
): readonly string[] {
  const eligible = new Set(eligibleRows.map(({ id }) => id));
  const visible = new Set(input.visibleParticipantIds);
  const allowed = new Set(input.standing.allowedParticipantIds);
  const requested = input.selection === "broadcast"
    ? [...visible]
    : [...input.mentionedBotIds];

  if (input.selection === "broadcast" && !input.standing.broadcastAllowed) {
    throw new ChannelCoordinatorError("outside_scope", "broadcast is outside standing scope");
  }
  const recipients = [...new Set(requested)]
    .filter((id) => eligible.has(id) && visible.has(id) && allowed.has(id))
    .sort();
  if (recipients.length === 0) {
    throw new ChannelCoordinatorError("ineligible", "no visible, allowed persistent Bot recipient");
  }
  return Object.freeze(recipients);
}

export function assertChannelTurnCapacity(input: {
  roundTurns: number;
  botTurns: number;
  additions?: number;
}): void {
  const additions = input.additions ?? 1;
  if (![input.roundTurns, input.botTurns, additions].every(Number.isSafeInteger) ||
      input.roundTurns < 0 || input.botTurns < 0 || additions < 1) {
    throw new ChannelCoordinatorError("invalid_request", "turn counters must be nonnegative integers");
  }
  if (input.roundTurns + additions > MAX_CHANNEL_TURNS_PER_ROUND) {
    throw new ChannelCoordinatorError("round_limit", "Round turn limit reached");
  }
  if (input.botTurns + additions > MAX_CHANNEL_TURNS_PER_BOT) {
    throw new ChannelCoordinatorError("turn_limit", "Bot turn limit reached");
  }
}
