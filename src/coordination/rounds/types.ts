import type { M11Database } from "../work/types.js";
import type { JsonValue } from "../db/index.js";

export type RoundState = "open" | "coordinating" | "waiting" | "completed" | "failed" | "cancelled";

export interface RoundRecord {
  id: string;
  channelId: string;
  coordinatorBotId: string;
  state: RoundState;
  maxBotTurns: number;
  passCount: number;
  deadlineAt: string;
  terminalReason: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
}

export interface RoundMutationIdentity {
  requestId: string;
  correlationId: string;
}

export interface CreateRoundInput extends RoundMutationIdentity {
  channelId: string;
  coordinatorBotId: string;
  maxBotTurns: number;
  deadlineAt: string;
  /** Optional immutable caller admission state persisted in the create event. */
  admissionPlan?: { readonly [key: string]: JsonValue };
}

export interface MutateRoundInput extends RoundMutationIdentity {
  roundId: string;
}

export interface TerminalizeRoundInput extends MutateRoundInput {
  status: "completed" | "failed" | "cancelled";
  reasonCode: string;
}

export interface CreateRoundServiceOptions {
  database: M11Database;
  generateId: (kind: "round") => string;
  now?: () => Date;
}
