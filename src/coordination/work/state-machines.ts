import {
  STATE_MACHINE_REGISTRY,
  isLegalTransition,
} from "../schema/contract-registry.js";

export const M11_MACHINE_NAMES = Object.freeze([
  "round",
  "work",
  "attempt",
  "lease",
  "outbox",
  "delivery",
] as const);

export type M11MachineName = (typeof M11_MACHINE_NAMES)[number];

function assertMachineName(machine: string): asserts machine is M11MachineName {
  if (!(M11_MACHINE_NAMES as readonly string[]).includes(machine)) {
    throw new Error(`unknown M11 state machine: ${machine}`);
  }
}

export function canM11Transition(machine: string, from: string, to: string): boolean {
  assertMachineName(machine);
  return isLegalTransition(machine, from, to);
}

export function assertM11Transition(machine: string, from: string, to: string): void {
  assertMachineName(machine);
  if (!isLegalTransition(machine, from, to)) {
    throw new Error(`illegal ${machine} transition ${from} -> ${to}`);
  }
}

export function isM11Terminal(machine: string, state: string): boolean {
  assertMachineName(machine);
  return STATE_MACHINE_REGISTRY[machine]!.terminal.includes(state);
}
