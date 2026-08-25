import type { M11Database } from "../work/types.js";

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
