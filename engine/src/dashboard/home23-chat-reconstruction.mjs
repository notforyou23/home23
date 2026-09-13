/**
 * Replace the newest rendered assistant fragment for a completed turn with the
 * durable canonical content. Returns the reconciled element, or null when the
 * caller must create the first assistant element for that turn.
 */
export function reconcileCanonicalAssistantElements(elements, turnId, canonicalContent, render) {
  if (!turnId || typeof canonicalContent !== 'string') return null;
  const matching = Array.from(elements || []).filter(element => element?.dataset?.turnId === turnId);
  const alreadyCanonical = matching.find(element => (element.dataset.sourceText ?? element.textContent) === canonicalContent);
  if (alreadyCanonical) return alreadyCanonical;

  const target = matching[matching.length - 1] || null;
  if (target) {
    const body = target.querySelector?.('.h23-chat-msg-text') || target;
    body.innerHTML = render(canonicalContent);
    target.dataset.sourceText = canonicalContent;
  }
  return target;
}
