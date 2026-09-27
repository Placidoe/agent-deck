const SECRET_KEYS = new Set(["token", "password", "apikey", "authorization"]);

export function redactSecrets(value) {
  if (!value || typeof value !== "object") return value;
  for (const key of Object.keys(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) value[key] = "[REDACTED]";
  }
  return value;
}
