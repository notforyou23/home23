'use strict';

/**
 * Fatal provider auth — a dead token is not a model-turn failure.
 * The research Launch loop must stop. Do not retry across turns.
 */

const AUTH_REVOKED_WATCH_MESSAGE = 'Anthropic OAuth revoked. Re-auth in Cosmo Setup.';
const REVOKED_PHRASE = 'oauth access token has been revoked';

function collectAuthText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'object') return '';
  const parts = [
    value.message,
    value.errorType,
    value.type,
    value.code,
    typeof value.error === 'string' ? value.error : null,
    value.error?.message,
    value.error?.type,
    value.error?.code,
    value.content
  ];
  return parts.filter(Boolean).join(' ');
}

function statusOf(value) {
  if (value == null || typeof value !== 'object') return null;
  return value.status ?? value.statusCode ?? value.error?.status ?? value.error?.statusCode ?? null;
}

function typeOf(value) {
  if (value == null || typeof value !== 'object') return null;
  return value.errorType || value.type || value.error?.type || value.error?.code || null;
}

function isFatalAuthError(value) {
  if (value == null) return false;
  if (value === 401 || value === '401') return true;

  if (typeof value === 'object') {
    const status = statusOf(value);
    if (status === 401 || status === '401') return true;
    const type = typeOf(value);
    if (type === 'authentication_error' || type === 'invalid_api_key') return true;
  }

  const text = collectAuthText(value).toLowerCase();
  if (!text) return false;
  if (text.includes(REVOKED_PHRASE)) return true;
  if (text.includes('authentication_error')) return true;
  if (/\[error:/.test(text) && (text.includes('revoked') || text.includes('unauthorized'))) {
    return true;
  }
  return false;
}

module.exports = {
  AUTH_REVOKED_WATCH_MESSAGE,
  isFatalAuthError
};
