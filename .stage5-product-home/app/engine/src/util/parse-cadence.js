/**
 * parseCadenceCycles — parse "50cycles" / "1 cycle" cadence strings.
 * Default 50 on malformed input.
 */

'use strict';

export function parseCadenceCycles(s) {
  if (s == null) return 50;
  const m = /^(\d+)\s*cycles?$/i.exec(String(s).trim());
  return m ? parseInt(m[1], 10) : 50;
}
