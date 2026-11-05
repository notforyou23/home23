import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface PackageManifest {
  scripts?: Record<string, string>;
}

test("the root release suite includes coordination and resident-adapter tests", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  ) as PackageManifest;

  assert.equal(
    manifest.scripts?.["test:coordination"],
    "node scripts/run-coordination-tests.mjs",
  );
  assert.match(manifest.scripts?.posttest ?? "", /(?:^|&&\s*)npm run test:coordination(?:\s*&&|$)/);
});
