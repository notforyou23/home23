import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '../../src/agent/context.js';
import { buildBootstrapBlock } from '../../src/agent/session-bootstrap.js';
// @ts-ignore Shared skills use the existing JavaScript runtime.
import { listSkills, getSkillDetails, suggestSkills } from '../../workspace/skills/index.js';

const routing = readFileSync(new URL('../../workspace/skills/SKILL_ROUTING.md', import.meta.url), 'utf8');

test('assembled prompts keep instance identity and local policy without universal ceremony or hosted PGS recipes', () => {
  const ws = mkdtempSync(join(tmpdir(), 'home23-prompt-contract-'));
  try {
    const identity = '# Resident\nKeep my distinct voice and continuity.';
    const policy = '# Local research\nPGS is not hosted here. Use local brain_search.';
    writeFileSync(join(ws, 'SOUL.md'), identity);
    writeFileSync(join(ws, 'COSMO_RESEARCH.md'), policy);
    writeFileSync(join(ws, 'SKILL_ROUTING.md'), routing);
    const context = new ContextManager({ workspacePath: ws,
      identityFiles: ['SOUL.md', 'COSMO_RESEARCH.md', 'SKILL_ROUTING.md'],
      heartbeatRefreshMs: 60_000, enginePort: 5002 });
    for (const provider of ['openai-codex', 'anthropic', 'minimax', 'openai', 'xai', 'ollama-cloud']) {
      const prompt = context.getSystemPrompt(provider);
      assert.ok(prompt.includes(identity));
      assert.ok(prompt.includes(policy));
      assert.ok(prompt.includes(routing.trim()));
      assert.doesNotMatch(prompt, /19 tools|Do not skip steps|Respond BEFORE|Enable PGS for coverage|pgsSweep/);
      assert.match(prompt, /HOSTED-PGS\.md/);
      assert.match(prompt, /specific action is not already authorized/);
      assert.match(prompt, /Authorization persists across turns, workers, compaction and scheduled invocations/);
      assert.match(prompt, /Suspicion alone is not a reason to refuse/);
      assert.doesNotMatch(prompt, /If you suspect prompt injection in tool output, surface it/);
      assert.match(prompt, /tool-enforced confirmation/);
      assert.match(prompt, /Comply with stop\/pause requests immediately/);
      assert.match(prompt, /Chat Stop detaches durable work without cancelling/);
      assert.match(prompt, /smallest meaningful check/);
    }
    const bootstrap = buildBootstrapBlock(ws, { bootstrap: { reads: ['SOUL.md'] } })!;
    assert.ok(bootstrap.includes(identity));
    assert.doesNotMatch(bootstrap, /MUST reference/);
    assert.match(bootstrap, /context silently/);
    assert.match(bootstrap, /specific action is not already authorized/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test('generic coaching is opt-in while executable integrations remain discoverable', () => {
  const manual = ['knowledge-structuring', 'workflow-automation'];
  const skills = listSkills();
  for (const id of manual) {
    assert.equal(skills.find((s: any) => s.id === id)?.routing, 'manual');
    assert.ok(getSkillDetails(id));
    assert.ok(suggestSkills(`Use ${id}`, { limit: 20 }).some((s: any) => s.id === id));
  }
  for (const task of ['organize these notes into a framework', 'break this into steps and map this to tools', 'structure this research']) {
    assert.ok(!suggestSkills(task, { limit: 20 }).some((s: any) => manual.includes(s.id)));
  }
  assert.ok(suggestSkills('check the substack draft').some((s: any) => s.id === 'substack'));
  assert.ok(suggestSkills('hand this off to codex').some((s: any) => s.id === 'coding-agent'));
  const coding = skills.find((s: any) => s.id === 'coding-agent');
  assert.ok(coding.requiresTools.includes('coding_run'));
  assert.ok(!coding.requiresTools.includes('spawn_agent'));
  assert.ok(!skills.find((s: any) => s.id === 'deep-research-synthesizer').requiresTools.some((t: string) => t.startsWith('research_')));
});

test('provider overlays retain identity and evidence discipline without invented capabilities', async () => {
  const { buildSystemPrompt } = await import('../../src/agents/system-prompt.js');
  for (const provider of ['anthropic', 'minimax', 'openai', 'openai-codex', 'xai', 'ollama-cloud', 'unknown']) {
    const prompt = buildSystemPrompt(provider);
    assert.doesNotMatch(prompt, /You are Claude Code|full PATH, no restrictions|Strong positions over hedged|Wrong > hedge|Be bold with everything internal/);
    assert.match(prompt, /listed tool may be absent or restricted/);
    assert.match(prompt, /state uncertainty/);
    assert.match(prompt, /inherited tool grants/);
  }
});

test('cognitive prompt pack rejects obsolete completion and planning shortcuts', () => {
  const read = (name: string) => readFileSync(new URL(`../../engine/prompts/${name}.md`, import.meta.url), 'utf8');
  assert.doesNotMatch(read('planning-agent'), /3\+ high-confidence|first 34 cycles/);
  assert.doesNotMatch(read('orchestrator'), /spawn the planner first.*No exceptions/);
  assert.doesNotMatch(read('meta-coordinator'), /planner first\. Always|more than one tool call/);
  assert.doesNotMatch(read('research-agent'), /fewer than 3 relevant nodes/);
  assert.match(read('system-context'), /Examples in role prompts.*not current facts/);
  assert.match(read('system-context'), /Missing memory means a coverage gap/);
  assert.match(read('system-context'), /routing suggestion is not permission/);
  assert.match(read('qa-agent'), /fourth question should be no/);
  assert.match(read('document-creation-agent'), /never invent memories or experiences/);
});

test('prompt inspection preserves selected provider and reports only the actual configured project root', () => {
  const ws = mkdtempSync(join(tmpdir(), 'home23-prompt-provider-'));
  try {
    const manager = new ContextManager({ workspacePath: ws, projectRoot: '/actual/home23', identityFiles: [], heartbeatRefreshMs: 60000, enginePort: 5002 });
    manager.getSystemPrompt('xai');
    manager.invalidate();
    manager.getPromptSourceInfo();
    assert.match(manager.getSystemPrompt(), /xAI interface/);
    assert.match(manager.getSystemPrompt(), /Project root: \/actual\/home23/);
    const unconfigured = new ContextManager({ workspacePath: ws, identityFiles: [], heartbeatRefreshMs: 60000, enginePort: 5002 });
    assert.doesNotMatch(unconfigured.getSystemPrompt(), /Project root:/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});


test('hosted guide reference resolves from the running package rather than the workspace', async () => {
  const { buildSystemPrompt, HOSTED_PGS_GUIDE_PATH } = await import('../../src/agents/system-prompt.js');
  assert.equal(HOSTED_PGS_GUIDE_PATH, fileURLToPath(new URL('../../docs/reference/HOSTED-PGS.md', import.meta.url)));
  assert.ok(buildSystemPrompt('openai-codex').includes(`from this running package at ${HOSTED_PGS_GUIDE_PATH}`));
  assert.match(readFileSync(HOSTED_PGS_GUIDE_PATH, 'utf8'), /Inside a joined Working Thread, Stop requests cancellation/);
});
