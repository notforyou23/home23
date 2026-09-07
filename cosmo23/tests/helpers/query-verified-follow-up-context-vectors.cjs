'use strict';

const MAX_VERIFIED_CONTEXT_UTF16 = 20_000;
const IMMEDIATE_ANSWER_OMISSION_MARKER = '\n\n[... middle of immediate parent answer omitted by Home23 verified follow-up context budget ...]\n\n';

const simple = Object.freeze({
  exchanges: Object.freeze([
    Object.freeze({ query: 'First question', answer: 'First answer' }),
    Object.freeze({ query: 'Second question', answer: 'Second answer' }),
  ]),
  rendered: 'Question:\nFirst question\n\nAnswer:\nFirst answer\n\n---\n\nQuestion:\nSecond question\n\nAnswer:\nSecond answer',
  utf16: 101,
});

const exactBoundaryAnswer = 'a'.repeat(19_979);
const exactBoundary = Object.freeze({
  exchanges: Object.freeze([
    Object.freeze({ query: 'Q', answer: exactBoundaryAnswer }),
  ]),
  rendered: `Question:\nQ\n\nAnswer:\n${exactBoundaryAnswer}`,
  utf16: MAX_VERIFIED_CONTEXT_UTF16,
});

const emoji = Object.freeze({
  exchanges: Object.freeze([
    Object.freeze({ query: 'Status 🧠?', answer: 'Ready 🚀.' }),
  ]),
  rendered: 'Question:\nStatus 🧠?\n\nAnswer:\nReady 🚀.',
  utf16: 39,
});

const oversizedEmojiAnswer = `${'a'.repeat(9_939)}😀${'m'.repeat(10_000)}🚀${'z'.repeat(9_939)}`;
const oversizedEmojiProjectedAnswer = `${'a'.repeat(9_939)}${IMMEDIATE_ANSWER_OMISSION_MARKER}${'z'.repeat(9_939)}`;
const oversizedImmediate = Object.freeze({
  query: 'Q',
  answer: oversizedEmojiAnswer,
  projectedAnswer: oversizedEmojiProjectedAnswer,
  rendered: `Question:\nQ\n\nAnswer:\n${oversizedEmojiProjectedAnswer}`,
  utf16: 19_998,
});

module.exports = Object.freeze({
  MAX_VERIFIED_CONTEXT_UTF16,
  IMMEDIATE_ANSWER_OMISSION_MARKER,
  vectors: Object.freeze({ simple, exactBoundary, emoji, oversizedImmediate }),
});
