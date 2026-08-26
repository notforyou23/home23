#!/usr/bin/env node
import { runCoordinationProcess } from "../../dist/coordination/index.js";

const state = await runCoordinationProcess();
if (state === "disabled") {
  console.log("[home23-coordination] disabled by configuration");
}
