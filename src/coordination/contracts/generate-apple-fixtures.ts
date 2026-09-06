import { readFileSync, writeFileSync } from "node:fs";

import { renderAppleCanonicalFixtures } from "./contract-pack.js";

const [mode, outputPath] = process.argv.slice(2);

if ((mode !== "--write" && mode !== "--check") || !outputPath) {
  throw new Error("usage: generate-apple-fixtures.ts --write|--check <output.swift>");
}

const rendered = renderAppleCanonicalFixtures();

if (mode === "--write") {
  writeFileSync(outputPath, rendered, "utf8");
} else {
  const existing = readFileSync(outputPath, "utf8");
  if (existing !== rendered) {
    throw new Error("Apple canonical fixtures differ from the reviewed Core pack");
  }
}
