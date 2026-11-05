import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  classifyMemoryProvenance,
  scoreMemorySalience,
} = require('../../../engine/src/memory/provenance-salience.js');

test('classifyMemoryProvenance boosts direct user conversation over cron conversation logs', () => {
  const direct = classifyMemoryProvenance({
    tag: 'conversation_sessions',
    concept: 'Channel: dashboard-jerry\n**User:** Fix the brain cleanup scope.\n**Agent:** Working from live state.',
  });
  const cron = classifyMemoryProvenance({
    tag: 'conversation_sessions',
    concept: 'Channel: cron-agent-1775704909558\n**User:** Run the EVENING-RESEARCH session for Ticker Home23.',
  });

  assert.equal(direct.sourceClass, 'conversation');
  assert.ok(direct.salienceWeight > 1);
  assert.equal(cron.sourceClass, 'telemetry');
  assert.ok(cron.salienceWeight < 1);
});

test('classifyMemoryProvenance treats jtr and Garcia material as identity but autonomous thought as machine chatter', () => {
  const identity = classifyMemoryProvenance({ tag: 'garcia_jerry', concept: 'Jerry Garcia art workflow analysis.' });
  const chatter = classifyMemoryProvenance({ tag: 'curator', concept: 'Let me ground myself in current system state first.' });
  const jtrChatter = classifyMemoryProvenance({ tag: 'curator', concept: "I'll query the brain and surface to ground this in jtr's actual context before responding." });

  assert.equal(identity.sourceClass, 'identity');
  assert.ok(identity.salienceWeight > 1);
  assert.equal(chatter.sourceClass, 'autonomous');
  assert.ok(chatter.salienceWeight < 1);
  assert.equal(jtrChatter.sourceClass, 'autonomous');
  assert.ok(jtrChatter.salienceWeight < 1);
});

test('classifyMemoryProvenance demotes consolidated prompt-handling summaries', () => {
  const consolidated = classifyMemoryProvenance({
    tag: 'consolidated',
    concept: '[CONSOLIDATED] I do not have access to an external brain or database to query before responding.',
  });

  assert.equal(consolidated.sourceClass, 'autonomous');
  assert.ok(consolidated.salienceWeight < 1);
});

test('scoreMemorySalience gives old cron telemetry a short half-life', () => {
  const now = Date.parse('2026-05-30T12:00:00.000Z');
  const recentCron = {
    tag: 'jerry_cron_docs',
    concept: 'Cron job catalog snapshot.',
    created: '2026-05-30T00:00:00.000Z',
  };
  const oldCron = {
    tag: 'jerry_cron_docs',
    concept: 'Cron job catalog snapshot.',
    created: '2026-05-20T00:00:00.000Z',
  };
  const conversation = {
    tag: 'conversation_sessions',
    concept: 'Channel: dashboard-jerry\n**User:** This is the actual task.',
    created: '2026-05-20T00:00:00.000Z',
  };

  assert.ok(scoreMemorySalience(conversation, 0.5, { nowMs: now }) > 0.5);
  assert.ok(scoreMemorySalience(oldCron, 0.5, { nowMs: now }) < scoreMemorySalience(recentCron, 0.5, { nowMs: now }));
  assert.ok(scoreMemorySalience(oldCron, 0.5, { nowMs: now }) < 0.1);
});
