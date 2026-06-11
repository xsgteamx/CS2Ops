export function maskSecretInText(text, secret = process.env.LOG_HTTP_SECRET) {
  if (!secret) return String(text ?? '');
  return String(text ?? '').split(secret).join('********');
}

export function maskUrlSecret(url, secret = process.env.LOG_HTTP_SECRET) {
  return maskSecretInText(url, secret);
}

export function boolFromEnv(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function normalizeRemoteAddress(value) {
  return String(value || '')
    .replace(/^::ffff:/, '')
    .trim();
}
