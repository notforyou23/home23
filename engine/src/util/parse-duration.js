/**
 * parseDuration — convert "30s", "15m", "48h", "30d" to milliseconds.
 * Returns 0 on invalid input so callers can fall back to a default.
 */

'use strict';

const MULT = { s: 1000, m: 60_000, h: 3600_000, d: 86400_000 };

export function parseDuration(s) {
  if (s == null) return 0;
  const m = /^(\d+)\s*(s|m|h|d)$/i.exec(String(s).trim());
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return n * MULT[m[2].toLowerCase()];
}
