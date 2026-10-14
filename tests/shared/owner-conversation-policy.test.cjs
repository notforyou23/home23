'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyOwnerConversation, hasConversationTimeIntent } = require('../../shared/owner-conversation-policy.cjs');

test('verification chat identifiers cannot become owner evidence', () => {
  for (const chatId of ['home-verify-tickets', 'memory-verify-48', 'retrieval-verification',
    'retrieval-test-tickets', 'coordination:home-verify-48', 'VERIFY-ticket']) {
    const result = classifyOwnerConversation({ chatId, text: 'I bought Trey and Billy tickets.' });
    assert.equal(result.kind, 'verification', chatId);
    assert.equal(result.ownerEvidence, false, chatId);
  }
  assert.equal(classifyOwnerConversation({ sessionRefs: ['coordination:home-verify-tickets'] }).verification, true);
});

test('explicit verification and non-owner source metadata cannot become owner evidence', () => {
  for (const metadata of [{ verification: true }, { nonOwner: true }, { owner: false },
    { source: 'non-owner' }, { source_class: 'verification' }, { conversation_kind: 'meta' }]) {
    assert.equal(classifyOwnerConversation({ text: 'I bought tickets.', metadata }).ownerEvidence, false);
  }
  assert.equal(classifyOwnerConversation({ provenance: { verification: true } }).verification, true);
  assert.equal(classifyOwnerConversation({ metadata: { verification: false, source: 'owner' } }).ownerEvidence, true);
});

test('nested metadata identifiers and explicit non-owner evidence flags are recognized', () => {
  for (const metadata of [{ chatId: 'home-verify-tickets' }, { chat_id: 'retrieval-test-48' },
    { session_refs: ['verification-memory'] }, { owner_evidence: false }]) {
    assert.equal(classifyOwnerConversation({ text: 'Tickets at Ticketmaster.', metadata }).ownerEvidence, false);
  }
});

test('memory and retrieval testing conversations are classified conservatively', () => {
  for (const text of ['Test your recall of the Trey/Billy tickets.', 'Run a retrieval test for my tickets.',
    'Let us test whether you remember our ticket discussion.',
    'Verify your recall of the tickets.', 'Test if you can still remember our conversation.']) {
    assert.equal(classifyOwnerConversation({ text }).verification, true, text);
  }
  for (const text of ['Can you find Trey tickets on Ticketmaster?', 'I need to test my ticket barcode.',
    'Billy played Check the Brain at the show.', 'Check the brain scan with the surgeon.',
    'I bought Trey/Billy tickets on Ticketmaster. Melissa and I need Friday lodging in Worcester.',
    'My mother has memory loss. We will check her brain scan tomorrow.',
    'The doctor scheduled a memory test for my mother.', 'Can you find information about memory loss?',
    'Can you find how much memory my computer has?']) {
    assert.equal(classifyOwnerConversation({ text }).kind, 'substantive', text);
  }
});

test('retrieval retests and their summaries cannot become new owner evidence', () => {
  for (const text of [
    "Retrieval retest conversation repeated Trey Billy ticket memories alongside owner's reports of further brain fixes",
    'Retrieval-test conversation about Trey and Billy tickets.',
    'We ran a retrieval retest for the ticket memories.',
    "For this post-fix check, try the resident's retrieval and memory in practice.",
  ]) {
    assert.equal(classifyOwnerConversation({ text }).ownerEvidence, false, text);
  }
});

test('normal owner recall requests and brain maintenance remain owner conversation', () => {
  for (const text of [
    'Check the brain.', 'Please check your brain after the fixes this morning.',
    'Can you find the original conversation about Trey and Billy tickets?',
    'Can you find this in your memory?', 'Can you find our earlier chat about the tickets?',
    'Can you find the tickets using your retrieval?', 'Use brain_search to find our ticket conversation.',
    'The brain_search calls were degraded this morning. We discussed the fixes.',
    'More fixes in. Hopefully your retrieval and brain are better.',
    'After the fixes, check the brain. We talked about dinner.',
    'Check your retrieval this morning after the repairs.',
    'Checking our recall path after the fixes.',
  ]) {
    assert.equal(classifyOwnerConversation({ text }).ownerEvidence, true, text);
    assert.equal(classifyOwnerConversation({ text, chatId: 'home-verify-49' }).ownerEvidence, false, text);
  }
});

test('unrelated testing and recall words do not turn substantive conversation into verification', () => {
  for (const text of [
    'I need to test my ticket barcode. I remember that Melissa and I bought Trey and Billy tickets.',
    'We should test the computer memory before the concert.',
    'I verify Ticketmaster sent the receipt. Remember to book Friday lodging.',
    'Can you find Trey tickets on Ticketmaster? I remember Melissa and I bought seats already.',
  ]) {
    assert.equal(classifyOwnerConversation({ text }).kind, 'substantive', text);
    assert.equal(classifyOwnerConversation({ text }).ownerEvidence, true, text);
  }
});

test('recaps and topic references carry distinct demotion classifications', () => {
  assert.equal(classifyOwnerConversation({ text: 'Recap of our earlier ticket conversation: Trey and Billy in Worcester.' }).kind, 'recap');
  assert.equal(classifyOwnerConversation({ text: 'Recap: Trey and Billy tickets in Worcester.' }).kind, 'recap');
  assert.equal(classifyOwnerConversation({ text: 'We previously discussed Trey/Billy tickets.' }).kind, 'mention');
  assert.equal(classifyOwnerConversation({ text: 'This mentions the conversation about Trey/Billy tickets.' }).kind, 'mention');
  assert.equal(classifyOwnerConversation({ metadata: { conversation_kind: 'recap' }, text: 'Tickets in Worcester.' }).kind, 'recap');
  assert.equal(classifyOwnerConversation({ text: 'I bought tickets after we previously discussed Friday lodging.' }).kind, 'substantive');
  assert.equal(classifyOwnerConversation({ text: 'The Ticketmaster receipt confirms seats for Melissa and me.' }).kind, 'substantive');
  assert.equal(classifyOwnerConversation({ text: 'We previously discussed tickets. Alicia bought seats on Ticketmaster.' }).kind, 'substantive');
});

test('recency intent requires an explicit evidence time request', () => {
  for (const query of ['this morning', 'latest tickets update', 'today', 'yesterday evening', 'last night',
    'as of October 14', '2026-10-14 conversation', 'October 14 2026 morning', 'recent ticket discussion']) {
    assert.equal(hasConversationTimeIntent(query), true, query);
  }
  for (const query of ['Trey/Billy tickets', 'Friday lodging in Worcester', 'Divided Sky concert',
    'Can you find my tickets?', 'memory of Melissa and Ticketmaster']) {
    assert.equal(hasConversationTimeIntent(query), false, query);
  }
});
