'use strict';

const MAX_VERIFIED_CONTEXT_UTF16 = 20_000;
const EXCHANGE_KEYS = Object.freeze(['query', 'answer']);
const CONTEXT_KEYS = Object.freeze(['version', 'exchanges']);
const SEPARATOR = '\n\n---\n\n';

function fail() {
  const error = new Error('verified_conversation_context_invalid');
  error.code = 'verified_conversation_context_invalid';
  throw error;
}

function assertExactKeys(value, expected) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail();
  const keys = Reflect.ownKeys(value);
  const allowed = new Set(expected);
  if (keys.length !== expected.length
      || keys.some((key) => typeof key !== 'string' || !allowed.has(key))) fail();
  return value;
}

function normalizeExchange(value) {
  assertExactKeys(value, EXCHANGE_KEYS);
  if (typeof value.query !== 'string' || value.query.length === 0
      || typeof value.answer !== 'string' || value.answer.length === 0) fail();
  return { query: value.query, answer: value.answer };
}

function renderVerifiedConversation(exchanges) {
  if (!Array.isArray(exchanges) || exchanges.length === 0) fail();
  return exchanges.map((exchange) => {
    const normalized = normalizeExchange(exchange);
    return `Question:\n${normalized.query}\n\nAnswer:\n${normalized.answer}`;
  }).join(SEPARATOR);
}

function validateVerifiedConversationContext(
  value,
  options = { maxUtf16: MAX_VERIFIED_CONTEXT_UTF16 },
) {
  assertExactKeys(value, CONTEXT_KEYS);
  if (value.version !== 1 || !Array.isArray(value.exchanges) || value.exchanges.length === 0) fail();
  assertExactKeys(options, ['maxUtf16']);
  const maxUtf16 = options.maxUtf16;
  if (!Number.isSafeInteger(maxUtf16) || maxUtf16 < 1
      || maxUtf16 > MAX_VERIFIED_CONTEXT_UTF16) fail();
  const exchanges = value.exchanges.map(normalizeExchange);
  if (renderVerifiedConversation(exchanges).length > maxUtf16) fail();
  return { version: 1, exchanges };
}

function assertSliceInput(value, limit) {
  if (typeof value !== 'string' || !Number.isSafeInteger(limit) || limit < 0) fail();
}

function takeLeadingUtf16(value, limit) {
  assertSliceInput(value, limit);
  if (limit >= value.length) return value;
  let end = limit;
  if (end > 0
      && value.charCodeAt(end - 1) >= 0xD800 && value.charCodeAt(end - 1) <= 0xDBFF
      && value.charCodeAt(end) >= 0xDC00 && value.charCodeAt(end) <= 0xDFFF) {
    end -= 1;
  }
  return value.slice(0, end);
}

function takeTrailingUtf16(value, limit) {
  assertSliceInput(value, limit);
  if (limit >= value.length) return value;
  let start = value.length - limit;
  if (start > 0
      && value.charCodeAt(start) >= 0xDC00 && value.charCodeAt(start) <= 0xDFFF
      && value.charCodeAt(start - 1) >= 0xD800 && value.charCodeAt(start - 1) <= 0xDBFF) {
    start += 1;
  }
  return value.slice(start);
}

module.exports = Object.freeze({
  renderVerifiedConversation,
  validateVerifiedConversationContext,
  takeLeadingUtf16,
  takeTrailingUtf16,
});
