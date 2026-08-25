import assert from "node:assert/strict";
import test from "node:test";

const EXPECTED = {
  round: {
    states: ["open", "coordinating", "waiting", "completed", "failed", "cancelled"],
    transitions: [
      ["open", "coordinating"], ["open", "cancelled"],
      ["coordinating", "waiting"], ["coordinating", "completed"],
      ["coordinating", "failed"], ["coordinating", "cancelled"],
      ["waiting", "coordinating"], ["waiting", "failed"],
      ["waiting", "cancelled"],
    ],
    terminal: ["completed", "failed", "cancelled"],
  },
  work: {
    states: ["queued", "leased", "running", "cancelling", "succeeded", "failed", "cancelled"],
    transitions: [
      ["queued", "leased"], ["queued", "cancelled"],
      ["leased", "running"], ["leased", "queued"],
      ["running", "succeeded"], ["running", "failed"],
      ["running", "cancelling"], ["cancelling", "cancelled"],
    ],
    terminal: ["succeeded", "failed", "cancelled"],
  },
  attempt: {
    states: ["created", "offered", "accepted", "running", "cancel_requested", "succeeded", "failed", "cancelled", "expired", "rejected", "abandoned"],
    transitions: [
      ["created", "offered"], ["created", "abandoned"],
      ["offered", "accepted"], ["offered", "rejected"],
      ["accepted", "running"], ["accepted", "expired"],
      ["running", "succeeded"], ["running", "failed"],
      ["running", "cancel_requested"], ["cancel_requested", "cancelled"],
    ],
    terminal: ["succeeded", "failed", "cancelled", "expired", "rejected", "abandoned"],
  },
  lease: {
    states: ["offered", "active", "released", "expired", "revoked"],
    transitions: [
      ["offered", "active"], ["active", "released"],
      ["active", "expired"], ["active", "revoked"],
    ],
    terminal: ["released", "expired", "revoked"],
  },
  outbox: {
    states: ["pending", "claimed", "retry", "delivered", "dead_letter"],
    transitions: [
      ["pending", "claimed"], ["claimed", "delivered"],
      ["claimed", "retry"], ["claimed", "dead_letter"],
      ["retry", "claimed"], ["retry", "dead_letter"],
    ],
    terminal: ["delivered", "dead_letter"],
  },
  delivery: {
    states: ["pending", "sending", "delivered", "retry_wait", "permanent_failure", "cancelled"],
    transitions: [
      ["pending", "sending"], ["pending", "cancelled"],
      ["sending", "delivered"], ["sending", "retry_wait"],
      ["sending", "permanent_failure"], ["sending", "cancelled"],
      ["retry_wait", "sending"], ["retry_wait", "permanent_failure"],
      ["retry_wait", "cancelled"],
    ],
    terminal: ["delivered", "permanent_failure", "cancelled"],
  },
} as const;

test("M11 accepts every exact M02 transition and rejects every other pair", async () => {
  const { canM11Transition, assertM11Transition, isM11Terminal } = await import(
    "../../../src/coordination/work/index.js"
  ).catch((error: unknown) => assert.fail(`M11 state machines are unavailable: ${String(error)}`));

  for (const [machine, rule] of Object.entries(EXPECTED)) {
    const legal = new Set(rule.transitions.map(([from, to]) => `${from}:${to}`));
    const terminal = new Set<string>(rule.terminal);
    for (const from of rule.states) {
      assert.equal(isM11Terminal(machine, from), terminal.has(from), `${machine}:${from} terminal`);
      for (const to of rule.states) {
        const expected = legal.has(`${from}:${to}`);
        assert.equal(canM11Transition(machine, from, to), expected, `${machine}:${from}->${to}`);
        if (expected) {
          assert.doesNotThrow(() => assertM11Transition(machine, from, to));
        } else {
          assert.throws(
            () => assertM11Transition(machine, from, to),
            /illegal .* transition/,
            `${machine}:${from}->${to}`,
          );
        }
      }
    }
  }
});
