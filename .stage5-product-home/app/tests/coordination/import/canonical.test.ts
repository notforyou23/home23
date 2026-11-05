import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../../../src/coordination/import/index.js";

test("canonical JSON rejects sparse arrays instead of colliding with empty arrays", () => {
  const sparse = new Array(1);
  assert.throws(() => canonicalJson(sparse), /sparse array/);
  assert.equal(canonicalJson([]), "[]");
});

test("canonical JSON rejects cycles, non-JSON prototypes, and accessors", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle), /circular object/);
  assert.throws(() => canonicalJson(new Date("2026-08-25T12:00:00.000Z")), /non-JSON object/);

  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "secret", {
    enumerable: true,
    get: () => {
      getterCalls += 1;
      return "private";
    },
  });
  assert.throws(() => canonicalJson(accessor), /accessor property/);
  assert.equal(getterCalls, 0);
});

test("canonical object ordering is code-unit deterministic rather than locale dependent", () => {
  assert.equal(canonicalJson({ "ä": 2, z: 1, a: 0 }), '{"a":0,"z":1,"ä":2}');
});
