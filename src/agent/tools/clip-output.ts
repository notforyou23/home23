/**
 * Shared tool-output clipping so file/identity tools stay under the model
 * display cap and teach a real next call instead of dying at the loop cutter.
 */

export const TOOL_OUTPUT_CHAR_LIMIT = 3800;

export function clipToolOutput(text: string, recovery: string): string {
  if (text.length <= TOOL_OUTPUT_CHAR_LIMIT) return text;
  const suffixFor = (end: number): string =>
    `\n\n[OUTPUT TRUNCATED: chars 0-${end} of ${text.length}. ${recovery} `
    + 'This page is incomplete — do not treat it as the full result.]';
  const budget = TOOL_OUTPUT_CHAR_LIMIT - suffixFor(text.length).length;
  if (budget < 64) return suffixFor(0).slice(0, TOOL_OUTPUT_CHAR_LIMIT);
  let prefix = text.slice(0, budget);
  if (/[\uD800-\uDBFF]$/.test(prefix)) prefix = prefix.slice(0, -1);
  return `${prefix}${suffixFor(prefix.length)}`;
}
