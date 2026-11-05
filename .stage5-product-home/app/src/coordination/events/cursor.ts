import type { EventEnvelope } from "./types.js";
import { validateEventEnvelope } from "./validation.js";

export type EventCursorDecision =
  | { action: "apply" | "duplicate"; sequence: number }
  | { action: "reset"; expectedSequence: number; receivedSequence: number };

export class EventSequenceCursor {
  private sequence: number;

  constructor(throughSequence: number) {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 0) {
      throw new TypeError("event cursor must be a nonnegative safe integer");
    }
    this.sequence = throughSequence;
  }

  get throughSequence(): number {
    return this.sequence;
  }

  accept(event: EventEnvelope): EventCursorDecision {
    const envelope = validateEventEnvelope(event);
    if (envelope.sequence <= this.sequence) {
      return Object.freeze({ action: "duplicate" as const, sequence: envelope.sequence });
    }
    const expectedSequence = this.sequence + 1;
    if (envelope.sequence !== expectedSequence) {
      return Object.freeze({
        action: "reset" as const,
        expectedSequence,
        receivedSequence: envelope.sequence,
      });
    }
    this.sequence = envelope.sequence;
    return Object.freeze({ action: "apply" as const, sequence: envelope.sequence });
  }
}
