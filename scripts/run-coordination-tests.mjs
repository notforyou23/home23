import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const testRoots = ["coordination", "coordination-adapter"]
  .map((directory) => join(process.cwd(), "tests", directory));

function coordinationTests(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return coordinationTests(path);
      return entry.isFile() && entry.name.endsWith(".test.ts") ? [path] : [];
    });
}

const tests = testRoots.flatMap(coordinationTests).sort();
if (tests.length === 0) {
  console.error("No coordination tests found");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...tests],
  { stdio: "inherit" },
);

if (result.error) throw result.error;
process.exit(result.status ?? 1);
