'use strict';

// Match NetworkMemory's exact-ID precedence and canonical numeric aliases.
// Keep the graph's stored ID type so subsequent Map lookups remain valid.
function resolveGraphNodeId(memory, value) {
  const nodes = memory?.nodes;
  if (!nodes) return undefined;
  if (nodes.has(value)) return value;
  if (typeof value !== 'string' && !Number.isSafeInteger(value)) return undefined;
  const text = String(value);
  if (nodes.has(text)) return text;
  if (/^-?(?:0|[1-9]\d*)$/.test(text)) {
    const numeric = Number(text);
    if (Number.isSafeInteger(numeric) && String(numeric) === text && nodes.has(numeric)) return numeric;
  }
  return undefined;
}

function graphEdgeEndpoints(memory, key, edge) {
  let source = edge?.source ?? edge?.from;
  let target = edge?.target ?? edge?.to;
  if (source === undefined || target === undefined) {
    if (typeof key !== 'string') return null;
    const parts = key.split('->');
    if (parts.length !== 2) return null;
    source ??= parts[0];
    target ??= parts[1];
  }
  source = resolveGraphNodeId(memory, source);
  target = resolveGraphNodeId(memory, target);
  if (source === undefined || target === undefined || source === target) return null;
  return [source, target];
}

module.exports = { resolveGraphNodeId, graphEdgeEndpoints };
