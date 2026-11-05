// decay.exemptTags in configs/base-engine.yaml makes any node whose `tag`
// is in the list immune to decay (engine/src/memory/network-memory.js
// applyDecay(): `if (exemptTags.includes(node.tag)) continue;`).
//
// `agent_insight` and `agent_finding` were in that list. Both tags are
// used by the machine's own auto-generated prose -- including degenerate
// output like "[AGENT INSIGHT] Total content analyzed: 0 words across 0
// documents". That content was permanently immune to decay purely because
// of its tag, while jtr's real notes (no exempt tag) decayed normally.
//
// This test asserts those two tags are gone from exemptTags. It
// deliberately does NOT touch `mission_plan` or `cross_agent_pattern` --
// those are unmeasured and out of scope for this fix; four times this
// project has mistaken jtr's real material for garbage, so the blast
// radius stays exactly as narrow as the evidence supports.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CONFIG_PATH = path.join(__dirname, '../../../configs/base-engine.yaml');

function loadExemptTags() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  const config = yaml.load(raw);
  return config?.architecture?.memory?.decay?.exemptTags;
}

test('base-engine.yaml decay.exemptTags does not exempt the machine\'s own auto-generated prose', () => {
  const exemptTags = loadExemptTags();
  assert.ok(Array.isArray(exemptTags), 'expected decay.exemptTags to be an array');

  assert.ok(
    !exemptTags.includes('agent_insight'),
    '"agent_insight" must not be decay-exempt -- it includes degenerate machine output like ' +
    '"[AGENT INSIGHT] Total content analyzed: 0 words across 0 documents"'
  );
  assert.ok(
    !exemptTags.includes('agent_finding'),
    '"agent_finding" must not be decay-exempt for the same reason'
  );
});

test('base-engine.yaml decay.exemptTags still protects mission_plan and cross_agent_pattern -- out of scope, left untouched', () => {
  const exemptTags = loadExemptTags();
  assert.ok(exemptTags.includes('mission_plan'), 'mission_plan exemption is out of scope for this fix and must remain');
  assert.ok(exemptTags.includes('cross_agent_pattern'), 'cross_agent_pattern exemption is out of scope for this fix and must remain');
});
