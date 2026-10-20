/** Strip stash tokens and house-key material from strings that may be logged. */
export function redactStashSecrets(value: string): string {
  return value
    .replace(/([?&])token=[^&#\s]*/gi, "$1token=[redacted]")
    .replace(/\bau1\.[A-Za-z0-9._-]+/g, "au1.[redacted]")
    .replace(/X-House-Service-Key\s*[:=]\s*\S+/gi, "X-House-Service-Key: [redacted]");
}
