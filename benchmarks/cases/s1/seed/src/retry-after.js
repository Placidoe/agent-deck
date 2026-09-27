/**
 * Parse an HTTP Retry-After value into a non-negative delay in milliseconds.
 * @param {unknown} value
 * @param {number} nowMs
 * @returns {number | null}
 */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (!value) return null;
  const seconds = Number.parseInt(String(value), 10);
  if (Number.isFinite(seconds)) return seconds * 1000;
  return Date.parse(String(value)) - nowMs;
}
